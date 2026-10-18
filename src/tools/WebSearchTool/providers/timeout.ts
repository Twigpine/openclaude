import { createCombinedAbortSignal } from '../../../utils/combinedAbortSignal.js'

export const DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS = 15
const MAX_WEB_SEARCH_TIMEOUT_SECONDS = 300
const WEB_SEARCH_TIMEOUT_CODE = 'WEB_SEARCH_TIMEOUT'

interface WebSearchTimeoutOptions {
  providerName?: string
  timeoutMs?: number
}

export function getWebSearchTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.WEB_SEARCH_TIMEOUT_SEC
  const trimmed = raw?.trim()
  if (trimmed === undefined || trimmed === '') {
    return DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS * 1000
  }

  if (!/^\d+$/.test(trimmed)) {
    return DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS * 1000
  }

  const seconds = Number(trimmed)
  if (
    !Number.isFinite(seconds) ||
    !Number.isSafeInteger(seconds) ||
    seconds <= 0 ||
    seconds > MAX_WEB_SEARCH_TIMEOUT_SECONDS
  ) {
    return DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS * 1000
  }

  return seconds * 1000
}

export class WebSearchTimeoutError extends Error {
  readonly code = WEB_SEARCH_TIMEOUT_CODE
  readonly timeoutMs: number

  constructor(providerName: string, timeoutMs: number) {
    super(
      `${providerName} search timed out after ${formatTimeoutSeconds(timeoutMs)}s`,
    )
    this.name = 'WebSearchTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

export function isWebSearchTimeoutError(
  err: unknown,
): err is WebSearchTimeoutError {
  return (
    err instanceof WebSearchTimeoutError ||
    (err instanceof Error &&
      (err as { code?: unknown }).code === WEB_SEARCH_TIMEOUT_CODE)
  )
}

export function toAbortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason
  return new DOMException('Aborted', 'AbortError')
}

function waitForAbort(signal: AbortSignal): {
  promise: Promise<never>
  cleanup: () => void
} {
  let onAbort: (() => void) | undefined
  const promise = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(toAbortError(signal.reason))
      return
    }
    onAbort = () => reject(toAbortError(signal.reason))
    signal.addEventListener('abort', onAbort, { once: true })
  })

  return {
    promise,
    cleanup: () => {
      if (onAbort) signal.removeEventListener('abort', onAbort)
      onAbort = undefined
    },
  }
}

function formatTimeoutSeconds(timeoutMs: number): string {
  return String(timeoutMs / 1000)
}

export async function withWebSearchTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  options: WebSearchTimeoutOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? getWebSearchTimeoutMs()
  const providerName = options.providerName ?? 'Web search provider'
  const { signal: combined, cleanup } = createCombinedAbortSignal(signal, {
    timeoutMs,
  })

  try {
    if (combined.aborted) {
      throw toAbortError(combined.reason)
    }

    const abortWait = waitForAbort(combined)
    try {
      return await Promise.race([
        operation(combined),
        abortWait.promise,
      ])
    } finally {
      abortWait.cleanup()
    }
  } catch (err) {
    if (signal?.aborted) {
      throw toAbortError(signal.reason ?? err)
    }
    if (combined.aborted) {
      throw new WebSearchTimeoutError(providerName, timeoutMs)
    }
    throw err
  } finally {
    cleanup()
  }
}

export async function fetchJsonWithWebSearchTimeout(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  signal: AbortSignal | undefined,
  options: WebSearchTimeoutOptions = {},
): Promise<unknown> {
  const providerName = options.providerName ?? 'Web search provider'

  return withWebSearchTimeout(
    async combinedSignal => {
      const res = await fetch(input, {
        ...(init ?? {}),
        signal: combinedSignal,
      })

      if (!res.ok) {
        throw new Error(
          `${providerName} search error ${res.status}: ${await res.text().catch(() => '')}`,
        )
      }

      return await res.json()
    },
    signal,
    options,
  )
}
