import { APIError } from '@anthropic-ai/sdk'
import { logForDebugging } from '../../../utils/debug.js'
import {
  redactSecretValueForDisplay,
  type SecretValueSource,
} from '../../../utils/providerProfile.js'
import {
  redactEncodedSecretSubstringsForDisplay,
  redactSecretSubstringsForDisplay,
} from '../../../utils/providerSecrets.js'
import { redactUrlForDisplay } from '../../../utils/redaction.js'
import {
  getInterruptionSignalAbortEventId,
  getInterruptionSignalId,
  registerInterruptionController,
  registerInterruptionSignal,
  requestAbort,
  traceCombinedAbortSignal,
  traceCombinedSignal,
  traceInterruptionEvent,
} from '../../../utils/interruptionTrace.js'
import {
  buildOpenAICompatibilityErrorMessage,
  classifyOpenAINetworkFailure,
  markOpenAIRequestNonReplayable,
} from '../openaiErrorClassification.js'
import {
  fetchWithProxyRetry,
  type ProxyRetryFetcher,
} from '../fetchWithProxyRetry.js'

const DEFAULT_API_TIMEOUT_MS = 600_000
const MAX_API_TIMEOUT_MS = 2_147_483_647
const MAX_URL_SECRET_DECODING_LAYERS = 4

export class ResponseHeadersTimeoutError extends Error {
  constructor(timeoutMs: number, url: string) {
    super(
      `OpenAI-compatible request received no response headers within ${timeoutMs}ms (API_TIMEOUT_MS) from ${url}`,
    )
    this.name = 'ResponseHeadersTimeoutError'
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== 'undefined' &&
      error instanceof DOMException &&
      error.name === 'AbortError') ||
    (typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      error.name === 'AbortError')
  )
}

export function preserveCallerAbortError(
  error: unknown,
  callerSignal: AbortSignal,
): unknown {
  return error instanceof ResponseHeadersTimeoutError || isAbortError(error)
    ? callerSignal.reason ?? error
    : error
}

export function getApiTimeoutMs(
  processEnv: NodeJS.ProcessEnv = process.env,
  fallbackMs: number = DEFAULT_API_TIMEOUT_MS,
): number {
  const raw = processEnv.API_TIMEOUT_MS?.trim()
  if (!raw || !/^\d+$/.test(raw)) return fallbackMs
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, MAX_API_TIMEOUT_MS)
    : fallbackMs
}

function combineRequestSignals(
  callerSignal: AbortSignal | undefined,
  deadlineSignal: AbortSignal,
): {
  signal: AbortSignal
  cleanupAfterHeaders: () => void
  cleanup: () => void
  cleanupAfterBody?: () => void
} {
  if (!callerSignal) {
    return {
      signal: deadlineSignal,
      cleanupAfterHeaders: () => {},
      cleanup: () => {},
    }
  }

  if (typeof AbortSignal.any === 'function') {
    const signal = AbortSignal.any([callerSignal, deadlineSignal])
    traceCombinedAbortSignal(signal, [callerSignal, deadlineSignal], {
      subsystem: 'openai_shim_transport',
      controllerRole: 'request-combined',
    })
    return {
      signal,
      cleanupAfterHeaders: () => {},
      cleanup: () => {},
    }
  }

  const combined = new AbortController()
  const callerId = registerInterruptionSignal(callerSignal, {
    subsystem: 'openai_shim_transport',
    controllerRole: 'request-caller',
  })
  const deadlineId = registerInterruptionSignal(deadlineSignal, {
    subsystem: 'openai_shim_transport',
    controllerRole: 'headers-deadline',
  })
  const parentControllerIds = [callerId, deadlineId].filter(
    (id): id is string => id !== undefined,
  )
  traceCombinedSignal(combined, [callerSignal, deadlineSignal], {
    subsystem: 'openai_shim_transport',
    controllerRole: 'request-combined',
  })
  const abortFromCaller = () => {
    deadlineSignal.removeEventListener('abort', abortFromDeadline)
    requestAbort(combined, callerSignal.reason, {
      source: 'request_caller',
      subsystem: 'openai_shim_transport',
      controllerRole: 'request-combined',
      parentControllerIds,
      winningParentControllerId: getInterruptionSignalId(callerSignal),
      causalEventId: getInterruptionSignalAbortEventId(callerSignal),
    })
  }
  const abortFromDeadline = () => {
    callerSignal.removeEventListener('abort', abortFromCaller)
    requestAbort(combined, deadlineSignal.reason, {
      source: 'headers_deadline',
      subsystem: 'openai_shim_transport',
      controllerRole: 'request-combined',
      parentControllerIds,
      winningParentControllerId: getInterruptionSignalId(deadlineSignal),
      causalEventId: getInterruptionSignalAbortEventId(deadlineSignal),
    })
  }
  const cleanupAfterHeaders = () => {
    deadlineSignal.removeEventListener('abort', abortFromDeadline)
  }
  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    callerSignal.removeEventListener('abort', abortFromCaller)
    cleanupAfterHeaders()
    traceInterruptionEvent('combined_signal.cleanup', {
      subsystem: 'openai_shim_transport',
      controllerRole: 'request-combined',
    })
  }

  callerSignal.addEventListener('abort', abortFromCaller, { once: true })
  deadlineSignal.addEventListener('abort', abortFromDeadline, { once: true })
  if (callerSignal.aborted) abortFromCaller()
  else if (deadlineSignal.aborted) abortFromDeadline()

  return {
    signal: combined.signal,
    cleanupAfterHeaders,
    cleanup,
    cleanupAfterBody: cleanup,
  }
}

function wrapResponseBodyWithCleanup(
  response: Response,
  cleanup: () => void,
): Response {
  if (!response.body) {
    cleanup()
    return response
  }

  const reader = response.body.getReader()
  let cleanedUp = false
  const cleanupOnce = () => {
    if (cleanedUp) return
    cleanedUp = true
    cleanup()
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read()
        if (result.done) {
          cleanupOnce()
          controller.close()
        } else {
          controller.enqueue(result.value)
        }
      } catch (error) {
        cleanupOnce()
        controller.error(error)
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        cleanupOnce()
      }
    },
  })
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
  for (const property of ['url', 'type', 'redirected'] as const) {
    try {
      Object.defineProperty(wrapped, property, {
        value: response[property],
        configurable: true,
      })
    } catch {
      // Standard response metadata remains available when this is unsupported.
    }
  }
  return wrapped
}

export async function fetchWithHeadersDeadline(
  url: string,
  init: RequestInit,
  options: {
    callerSignal?: AbortSignal
    timeoutMs: number
  },
): Promise<Response> {
  const redactedUrl = redactUrlForDiagnostics(url)
  const fetchWithAttemptDeadline: ProxyRetryFetcher = async (input, attemptInit) => {
    const deadlineController = new AbortController()
    registerInterruptionController(deadlineController, {
      subsystem: 'openai_shim_transport',
      controllerRole: 'headers-deadline',
    })
    const timeoutReason = new ResponseHeadersTimeoutError(
      options.timeoutMs,
      redactedUrl,
    )
    const {
      signal,
      cleanupAfterHeaders,
      cleanup,
      cleanupAfterBody,
    } = combineRequestSignals(options.callerSignal, deadlineController.signal)
    const timer = setTimeout(
      () =>
        requestAbort(deadlineController, timeoutReason, {
          source: 'headers_deadline_timer',
          subsystem: 'openai_shim_transport',
          controllerRole: 'headers-deadline',
        }),
      options.timeoutMs,
    )
    timer.unref?.()

    let headersReceived = false
    try {
      const response = await fetch(input, { ...attemptInit, signal })
      if (signal.aborted) {
        void response.body?.cancel().catch(() => {})
        throw (
          signal.reason ??
          new DOMException('The operation was aborted.', 'AbortError')
        )
      }
      headersReceived = true
      return cleanupAfterBody
        ? wrapResponseBodyWithCleanup(response, cleanupAfterBody)
        : response
    } catch (error) {
      if (options.callerSignal?.aborted) {
        throw preserveCallerAbortError(error, options.callerSignal)
      }
      if (
        deadlineController.signal.aborted &&
        deadlineController.signal.reason === timeoutReason
      ) {
        throw timeoutReason
      }
      throw error
    } finally {
      clearTimeout(timer)
      if (headersReceived) cleanupAfterHeaders()
      else cleanup()
    }
  }

  return fetchWithProxyRetry(
    url,
    { ...init, signal: options.callerSignal },
    { fetcher: fetchWithAttemptDeadline },
  )
}

function decodeValidPercentRun(encoded: string): string {
  const escapes = encoded.match(/%[0-9A-Fa-f]{2}/g)
  if (!escapes) return encoded

  let decoded = ''
  let offset = 0
  while (offset < escapes.length) {
    const firstByte = Number.parseInt(escapes[offset].slice(1), 16)
    const sequenceLength =
      firstByte <= 0x7f
        ? 1
        : firstByte >= 0xc2 && firstByte <= 0xdf
          ? 2
          : firstByte >= 0xe0 && firstByte <= 0xef
            ? 3
            : firstByte >= 0xf0 && firstByte <= 0xf4
              ? 4
              : 1
    try {
      decoded += decodeURIComponent(
        escapes.slice(offset, offset + sequenceLength).join(''),
      )
      offset += sequenceLength
    } catch {
      decoded += escapes[offset]
      offset++
    }
  }
  return decoded
}

function decodeValidUrlEscapesOnce(value: string): string {
  return value.replace(/(?:%[0-9A-Fa-f]{2})+/g, decodeValidPercentRun)
}

function redactDecodedUrlComponentSecrets(value: string): string {
  let decoded = value
  let foundSecret = false
  for (let layer = 0; layer <= MAX_URL_SECRET_DECODING_LAYERS; layer++) {
    const redacted =
      redactSecretSubstringsForDisplay(
        decoded,
        process.env as SecretValueSource,
      ) ?? decoded
    if (redacted !== decoded) foundSecret = true
    if (layer === MAX_URL_SECRET_DECODING_LAYERS) {
      decoded = redacted
      break
    }
    const next = decodeValidUrlEscapesOnce(redacted)
    if (next === redacted) {
      decoded = redacted
      break
    }
    decoded = next
  }
  return foundSecret ? decoded : value
}

export function redactUrlForDiagnostics(url: string): string {
  let redacted = redactUrlForDisplay(url)
  try {
    const parsed = new URL(redacted)
    const redactedPathname = redactDecodedUrlComponentSecrets(parsed.pathname)
    const redactedSearch = redactDecodedUrlComponentSecrets(parsed.search)
    let componentRedacted = false
    if (redactedPathname !== parsed.pathname) {
      parsed.pathname = redactedPathname
      componentRedacted = true
    }
    if (redactedSearch !== parsed.search) {
      parsed.search = redactedSearch
      componentRedacted = true
    }
    if (componentRedacted) redacted = parsed.toString()
  } catch {
    // Keep the URL-level redaction when the URL cannot be parsed.
  }
  const redactedSubstrings =
    redactSecretSubstringsForDisplay(
      redacted,
      process.env as SecretValueSource,
    ) ?? redacted
  return (
    redactSecretValueForDisplay(
      redactedSubstrings,
      process.env as SecretValueSource,
    ) ?? redactedSubstrings
  )
}

export function redactUrlsInMessage(message: string): string {
  return message.replace(/https?:\/\/\S+/g, match => redactUrlForDiagnostics(match))
}

export function createClassifiedTransportError(
  error: unknown,
  requestUrl: string,
  model: string,
  preclassifiedFailure?: ReturnType<typeof classifyOpenAINetworkFailure>,
) {
  const failure =
    preclassifiedFailure ??
    classifyOpenAINetworkFailure(error, { url: requestUrl })
  const redactedUrl = redactUrlForDiagnostics(requestUrl)
  const encodedSecretRedactedMessage =
    redactEncodedSecretSubstringsForDisplay(
      redactUrlsInMessage(failure.message),
      process.env as SecretValueSource,
    ) ?? 'Request failed'
  const redactedMessage =
    redactSecretSubstringsForDisplay(
      encodedSecretRedactedMessage,
      process.env as SecretValueSource,
    ) ?? 'Request failed'
  const safeMessage =
    redactSecretValueForDisplay(
      redactedMessage,
      process.env as SecretValueSource,
    ) || 'Request failed'

  logForDebugging(
    `[OpenAIShim] transport failure category=${failure.category} retryable=${failure.retryable} code=${failure.code ?? 'unknown'} method=POST url=${redactedUrl} model=${model} message=${safeMessage}`,
    { level: 'warn' },
  )

  const apiError = APIError.generate(
    0,
    undefined,
    buildOpenAICompatibilityErrorMessage(
      `OpenAI API transport error: ${safeMessage}${failure.code ? ` (code=${failure.code})` : ''}`,
      failure,
    ),
    new Headers(),
  )
  return failure.retryable
    ? apiError
    : markOpenAIRequestNonReplayable(apiError)
}
