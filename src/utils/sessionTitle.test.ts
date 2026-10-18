import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

type QueryHaikuArgs = {
  outputFormat?: unknown
  signal: AbortSignal
  options: {
    querySource: string
    agents: unknown[]
    mcpTools: unknown[]
    maxOutputTokensOverride?: number
    temperatureOverride?: number
    enablePromptCaching?: boolean
    skipCacheWrite?: boolean
  }
}

let queryHaikuCalls: QueryHaikuArgs[] = []
let queryHaikuText = ''
let queryHaikuImpl: (args: QueryHaikuArgs) => Promise<unknown>
let structuredOutputsSupported = true
let apiProvider = 'firstParty'
let smallFastModel = 'claude-haiku-4-5'
let analyticsEvents: Array<{ name: string; metadata: Record<string, unknown> }> =
  []
let debugMessages: Array<{ message: string; level?: string }> = []
let combinedAbortTimeouts: Array<number | undefined> = []
let forcedCombinedTimeoutMs: number | null = null
const COLD_MODULE_IMPORT_TEST_TIMEOUT_MS = 15_000

function assistantText(text: string): unknown {
  return {
    message: {
      content: [{ type: 'text', text }],
    },
  }
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    })
  })
}

async function importSubject() {
  // Force Bun to load fresh module instances so each test sees current mocks.
  const nonce = `${Date.now()}-${Math.random()}`
  const [
    actualAnalytics,
    actualBetas,
    actualCombinedAbortSignal,
    actualDebug,
    actualModel,
    actualProviders,
  ] = await Promise.all([
      import(`../services/analytics/index.ts?actual=${nonce}`),
      import(`./betas.ts?actual=${nonce}`),
      import(`./combinedAbortSignal.ts?actual=${nonce}`),
      import(`./debug.ts?actual=${nonce}`),
      import(`./model/model.ts?actual=${nonce}`),
      import(`./model/providers.ts?actual=${nonce}`),
    ])

  mock.module('../services/analytics/index.js', () => ({
    ...actualAnalytics,
    logEvent: (name: string, metadata: Record<string, unknown>) => {
      analyticsEvents.push({ name, metadata })
    },
  }))
  mock.module('../services/api/claude.js', () => ({
    queryHaiku: async (args: QueryHaikuArgs) => {
      queryHaikuCalls.push(args)
      return queryHaikuImpl(args)
    },
  }))
  mock.module('./betas.js', () => ({
    ...actualBetas,
    modelSupportsStructuredOutputs: () => structuredOutputsSupported,
  }))
  mock.module('./combinedAbortSignal.js', () => ({
    ...actualCombinedAbortSignal,
    createCombinedAbortSignal: (
      signal: AbortSignal | undefined,
      opts?: { signalB?: AbortSignal; timeoutMs?: number },
    ) => {
      combinedAbortTimeouts.push(opts?.timeoutMs)
      if (forcedCombinedTimeoutMs === null) {
        return actualCombinedAbortSignal.createCombinedAbortSignal(signal, opts)
      }

      const combined = new AbortController()
      if (signal?.aborted) {
        combined.abort(signal.reason)
        return { signal: combined.signal, cleanup: () => {} }
      }

      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', abortFromSignal)
      }
      const abortFromSignal = () => {
        cleanup()
        combined.abort(signal?.reason)
      }

      signal?.addEventListener('abort', abortFromSignal)
      timer = setTimeout(() => {
        cleanup()
        combined.abort(
          new DOMException('The operation timed out.', 'TimeoutError'),
        )
      }, forcedCombinedTimeoutMs)

      return { signal: combined.signal, cleanup }
    },
  }))
  mock.module('./debug.js', () => ({
    ...actualDebug,
    logForDebugging: (
      message: string,
      options?: { level?: string },
    ) => {
      debugMessages.push({ message, level: options?.level })
    },
  }))
  mock.module('./model/model.js', () => ({
    ...actualModel,
    getSmallFastModel: () => smallFastModel,
  }))
  mock.module('./model/providers.js', () => ({
    ...actualProviders,
    getAPIProvider: () => apiProvider,
  }))

  return import(`./sessionTitle.js?test=${nonce}`)
}

beforeEach(() => {
  mock.restore()
  queryHaikuCalls = []
  queryHaikuText = '{"title":"Fix login button on mobile"}'
  queryHaikuImpl = async () => assistantText(queryHaikuText)
  structuredOutputsSupported = true
  apiProvider = 'firstParty'
  smallFastModel = 'claude-haiku-4-5'
  analyticsEvents = []
  debugMessages = []
  combinedAbortTimeouts = []
  forcedCombinedTimeoutMs = null
})

afterEach(() => {
  mock.restore()
})

describe('generateSessionTitle', () => {
  test('uses a bounded internal-task profile for title generation', async () => {
    const { generateSessionTitle } = await importSubject()
    const callerAbort = new AbortController()

    const title = await generateSessionTitle(
      'Please fix the mobile login button',
      callerAbort.signal,
    )

    expect(title).toBe('Fix login button on mobile')
    expect(queryHaikuCalls).toHaveLength(1)
    const call = queryHaikuCalls[0]!
    expect(call.outputFormat).toEqual(
      expect.objectContaining({ type: 'json_schema' }),
    )
    expect(call.signal).not.toBe(callerAbort.signal)
    expect(call.options.querySource).toBe('generate_session_title')
    expect(call.options.agents).toEqual([])
    expect(call.options.mcpTools).toEqual([])
    expect(call.options.maxOutputTokensOverride).toBe(64)
    expect(call.options.temperatureOverride).toBe(0)
    expect(call.options.enablePromptCaching).toBe(false)
    expect(call.options.skipCacheWrite).toBe(true)
    expect(analyticsEvents).toContainEqual({
      name: 'tengu_session_title_generated',
      metadata: { success: true },
    })
  }, COLD_MODULE_IMPORT_TEST_TIMEOUT_MS)

  test('falls back when title generation times out', async () => {
    forcedCombinedTimeoutMs = 1
    queryHaikuImpl = async ({ signal }) => rejectWhenAborted(signal)

    const { generateSessionTitle } = await importSubject()
    const title = await generateSessionTitle(
      'Name a slow provider response',
      new AbortController().signal,
    )

    expect(title).toBe('OpenClaude')
    expect(combinedAbortTimeouts).toEqual([12_000])
    expect(queryHaikuCalls).toHaveLength(1)
    expect(queryHaikuCalls[0]!.signal.aborted).toBe(true)
    expect((queryHaikuCalls[0]!.signal.reason as DOMException).name).toBe(
      'TimeoutError',
    )
    expect(debugMessages.at(-1)?.message).toContain(
      'parse_failure=query_error',
    )
    expect(debugMessages.at(-1)?.message).toContain('error_name=TimeoutError')
    expect(analyticsEvents).toContainEqual({
      name: 'tengu_session_title_generated',
      metadata: { success: false },
    })
  })

  test('falls back when the title query returns an API error message', async () => {
    queryHaikuImpl = async () => ({
      isApiErrorMessage: true,
      message: {
        content: [{ type: 'text', text: 'API Error: 400 provider error' }],
      },
    })

    const { generateSessionTitle } = await importSubject()
    const title = await generateSessionTitle(
      'Name a session with a failed title request',
      new AbortController().signal,
    )

    expect(title).toBe('OpenClaude')
    expect(debugMessages.at(-1)?.message).toContain(
      'parse_failure=query_error',
    )
    expect(analyticsEvents).toContainEqual({
      name: 'tengu_session_title_generated',
      metadata: { success: false },
    })
  })

  test('propagates caller aborts to the internal title signal', async () => {
    queryHaikuImpl = async ({ signal }) => rejectWhenAborted(signal)

    const { generateSessionTitle } = await importSubject()
    const callerAbort = new AbortController()
    const titlePromise = generateSessionTitle(
      'Name an aborted session',
      callerAbort.signal,
    )

    expect(queryHaikuCalls).toHaveLength(1)
    expect(queryHaikuCalls[0]!.signal).not.toBe(callerAbort.signal)

    const reason = new Error('caller cancelled')
    callerAbort.abort(reason)

    await expect(titlePromise).resolves.toBe('OpenClaude')
    expect(queryHaikuCalls[0]!.signal.aborted).toBe(true)
    expect(queryHaikuCalls[0]!.signal.reason).toBe(reason)
    expect(debugMessages.at(-1)?.message).toContain(
      'parse_failure=query_error',
    )
    expect(debugMessages.at(-1)?.message).toContain('error_name=Error')
    expect(analyticsEvents).toContainEqual({
      name: 'tengu_session_title_generated',
      metadata: { success: false },
    })
  })

  test('does not request schema mode for OpenAI-compatible routes without structured outputs', async () => {
    structuredOutputsSupported = false
    apiProvider = 'openai'
    smallFastModel = 'glm-5.1'
    queryHaikuText = ''

    const { generateSessionTitle } = await importSubject()
    const title = await generateSessionTitle(
      'Summarize this session',
      new AbortController().signal,
    )

    expect(title).toBe('OpenClaude')
    expect(queryHaikuCalls).toHaveLength(1)
    expect(queryHaikuCalls[0]!.outputFormat).toBeUndefined()
    expect(debugMessages).toContainEqual({
      message:
        'generateSessionTitle task=generate_session_title provider=openai model=glm-5.1 response_length=0 parse_failure=empty_response fallback=default',
      level: 'warn',
    })
    expect(analyticsEvents).toContainEqual({
      name: 'tengu_session_title_generated',
      metadata: { success: false },
    })
  })

  test('extracts an embedded JSON title from provider prose', async () => {
    structuredOutputsSupported = false
    queryHaikuText =
      'Here is the title:\n{"title":"Refactor API client errors"}\nDone.'

    const { generateSessionTitle } = await importSubject()
    const title = await generateSessionTitle(
      'Refactor the API error handling code',
      new AbortController().signal,
    )

    expect(title).toBe('Refactor API client errors')
    expect(analyticsEvents.at(-1)).toEqual({
      name: 'tengu_session_title_generated',
      metadata: { success: true },
    })
  })

  test('falls back from malformed JSON to a short clean line', async () => {
    structuredOutputsSupported = false
    queryHaikuText = 'Fix login button on mobile\n\nThis is the concise title.'

    const { generateSessionTitle } = await importSubject()
    const title = await generateSessionTitle(
      'The login button is broken on mobile',
      new AbortController().signal,
    )

    expect(title).toBe('Fix login button on mobile')
  })

  test('skips provider intro lines before short-line title candidates', async () => {
    structuredOutputsSupported = false
    queryHaikuText =
      'Here are some title ideas:\nFix login button on mobile\nPossible titles:'

    const { generateSessionTitle } = await importSubject()
    const title = await generateSessionTitle(
      'The login button is broken on mobile',
      new AbortController().signal,
    )

    expect(title).toBe('Fix login button on mobile')
  })

  test('cleans title labels from short-line fallback output', async () => {
    structuredOutputsSupported = false
    queryHaikuText = 'Title: Debug failing CI tests'

    const { generateSessionTitle } = await importSubject()
    const title = await generateSessionTitle(
      'CI has a failing provider test',
      new AbortController().signal,
    )

    expect(title).toBe('Debug failing CI tests')
  })

  test('extracts a quoted title-like string', async () => {
    structuredOutputsSupported = false
    queryHaikuText = 'The title should be "Debug failing CI tests".'

    const { generateSessionTitle } = await importSubject()
    const title = await generateSessionTitle(
      'CI has a failing provider test',
      new AbortController().signal,
    )

    expect(title).toBe('Debug failing CI tests')
  })

  test('strips terminal control sequences from structured titles', async () => {
    queryHaikuText = JSON.stringify({
      title: '\x1b]8;;https://example.invalid\x07Click\x1b]8;;\x07',
    })

    const { generateSessionTitle } = await importSubject()
    const title = await generateSessionTitle(
      'Open the linked issue',
      new AbortController().signal,
    )

    expect(title).toBe('Click')
  })

  test('strips ANSI escape sequences from short-line fallback output', async () => {
    structuredOutputsSupported = false
    queryHaikuText = '\x1b[31mDebug failing CI tests\x1b[0m'

    const { generateSessionTitle } = await importSubject()
    const title = await generateSessionTitle(
      'CI has a failing provider test',
      new AbortController().signal,
    )

    expect(title).toBe('Debug failing CI tests')
  })

  test('lets prompt-fallback callers ignore the generic default title', async () => {
    const { titleOrNullForPromptFallback } = await importSubject()

    expect(titleOrNullForPromptFallback('Refactor API client errors')).toBe(
      'Refactor API client errors',
    )
    expect(titleOrNullForPromptFallback('OpenClaude')).toBeNull()
    expect(titleOrNullForPromptFallback(null)).toBeNull()
  })

  test('preserves prompt-fallback signal for empty provider output', async () => {
    structuredOutputsSupported = false
    queryHaikuText = ''

    const { generateSessionTitle, titleOrNullForPromptFallback } =
      await importSubject()
    const title = await generateSessionTitle(
      'Investigate remote session startup failure',
      new AbortController().signal,
    )

    expect(title).toBe('OpenClaude')
    expect(titleOrNullForPromptFallback(title)).toBeNull()
  })

  test('lets persistence callers skip the generic default title', async () => {
    forcedCombinedTimeoutMs = 1
    queryHaikuImpl = async ({ signal }) => rejectWhenAborted(signal)

    const { generateSessionTitle, titleOrNullForPromptFallback } =
      await importSubject()
    const title = await generateSessionTitle(
      'Name a slow SDK title request',
      new AbortController().signal,
    )

    const persistedTitle = titleOrNullForPromptFallback(title)
    expect(title).toBe('OpenClaude')
    expect(persistedTitle).toBeNull()
  })

  test('falls back when terminal sequence stripping leaves no title text', async () => {
    queryHaikuText = JSON.stringify({
      title: '\x1b]8;;https://example.invalid\x07\x1b]8;;\x07',
    })

    const { generateSessionTitle } = await importSubject()
    const title = await generateSessionTitle(
      'Open the linked issue',
      new AbortController().signal,
    )

    expect(title).toBe('OpenClaude')
  })

  test('rejects huge unusable responses safely', async () => {
    structuredOutputsSupported = false
    queryHaikuText = 'word '.repeat(5_000)

    const { generateSessionTitle } = await importSubject()
    const title = await generateSessionTitle(
      'Name this session',
      new AbortController().signal,
    )

    expect(title).toBe('OpenClaude')
    expect(debugMessages.at(-1)?.message).toContain(
      'parse_failure=unusable_response',
    )
    expect(debugMessages.at(-1)?.message).not.toContain('word word word word')
  })

  test('rejects obvious assistant prose', async () => {
    structuredOutputsSupported = false
    queryHaikuText = "I'll start by looking through the codebase."

    const { generateSessionTitle } = await importSubject()
    const title = await generateSessionTitle(
      'Start the task',
      new AbortController().signal,
    )

    expect(title).toBe('OpenClaude')
  })

  test('logs actual provider and model metadata when the title query throws', async () => {
    apiProvider = 'openai'
    smallFastModel = 'glm-5.1'
    queryHaikuImpl = async () => {
      throw new Error('provider rejected schema')
    }

    const { generateSessionTitle } = await importSubject()
    const title = await generateSessionTitle(
      'Name this session',
      new AbortController().signal,
    )

    expect(title).toBe('OpenClaude')
    expect(debugMessages).toContainEqual({
      message:
        'generateSessionTitle task=generate_session_title provider=openai model=glm-5.1 response_length=0 parse_failure=query_error fallback=default error_name=Error',
      level: 'warn',
    })
    expect(analyticsEvents).toContainEqual({
      name: 'tengu_session_title_generated',
      metadata: { success: false },
    })
  })
})
