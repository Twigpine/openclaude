import {
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test'
import type {
  BetaMessage,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { Stream } from '@anthropic-ai/sdk/streaming.mjs'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { QueryLifecycleOperationTracker } from '../../utils/queryLifecycle.js'
import {
  __getInterruptionTraceSnapshotForTests,
  __resetInterruptionTraceForTests,
  __waitForInterruptionTraceFlushForTests,
  registerInterruptionController,
  requestAbort,
} from '../../utils/interruptionTrace.js'
import { EMPTY_USAGE } from './emptyUsage.js'
import type { Options } from './claude.js'

const actualClientModule = await import('./client.js')
const originalEnv = { ...process.env }
const hadSavedMacro = Object.hasOwn(globalThis, 'MACRO')
const savedMacro = (globalThis as Record<string, unknown>).MACRO
let fixturesRoot: string | undefined
const envKeys = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
  'CLAUDE_CODE_TEST_FIXTURES_ROOT',
  'CLAUDE_DISABLE_STREAM_WATCHDOG',
  'CLAUDE_ENABLE_STREAM_WATCHDOG',
  'CLAUDE_STREAM_IDLE_TIMEOUT_MS',
  'OPENCLAUDE_MAX_RETRIES',
  'OPENCLAUDE_INTERRUPT_TRACE',
  'OPENCLAUDE_INTERRUPT_TRACE_FILE',
  'VCR_RECORD',
] as const

type CreateArgs = [
  Record<string, unknown>,
  Record<string, unknown> | undefined,
]
type CreateHandler = (...args: CreateArgs) => unknown

let createHandler: CreateHandler | undefined
let importCounter = 0
let restoreClientSpy: (() => void) | undefined

function installClientSpy(): void {
  const clientSpy = spyOn(actualClientModule, 'getAnthropicClient').mockImplementation(
    async () => ({
      beta: {
        messages: {
          create: (...args: CreateArgs) => {
            if (!createHandler) {
              throw new Error('test client create handler not configured')
            }
            return createHandler(...args)
          },
        },
      },
    }) as never,
  )
  restoreClientSpy = () => clientSpy.mockRestore()
}

function makeBetaMessage(
  id: string,
  content: BetaMessage['content'] = [],
): BetaMessage {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model: 'claude-watchdog-test',
    content,
    container: null,
    context_management: null,
    stop_details: null,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      ...EMPTY_USAGE,
      input_tokens: 1,
      output_tokens: 1,
    },
  }
}

function makeMessageStartEvent(): BetaRawMessageStreamEvent {
  return {
    type: 'message_start',
    message: makeBetaMessage('msg-stream-start'),
  }
}

function makeCompleteStreamEvents(): BetaRawMessageStreamEvent[] {
  return [
    makeMessageStartEvent(),
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '', citations: null },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'stream ok' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      context_management: null,
      delta: {
        container: null,
        stop_details: null,
        stop_reason: 'end_turn',
        stop_sequence: null,
      },
      usage: {
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        input_tokens: null,
        iterations: null,
        output_tokens: 1,
        server_tool_use: null,
      },
    },
    { type: 'message_stop' },
  ]
}

function deferred<T>(): {
  promise: Promise<T>
  reject: (reason?: unknown) => void
  resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, reject, resolve }
}

function makeWedgedStream(): {
  abortSignal: AbortSignal
  nextStarted: Promise<void>
  rejectPendingNext: (error: Error) => void
  returnCalled: () => boolean
  stream: Stream<BetaRawMessageStreamEvent>
} {
  const controller = new AbortController()
  const pendingNext = deferred<IteratorResult<BetaRawMessageStreamEvent>>()
  const nextStarted = deferred<void>()
  let nextCount = 0
  let returned = false
  const iterator: AsyncIterator<BetaRawMessageStreamEvent> = {
    next() {
      nextCount++
      if (nextCount === 1) {
        return Promise.resolve({
          done: false,
          value: makeMessageStartEvent(),
        })
      }
      nextStarted.resolve()
      return pendingNext.promise
    },
    return() {
      returned = true
      return Promise.resolve({ done: true, value: undefined })
    },
  }

  return {
    abortSignal: controller.signal,
    nextStarted: nextStarted.promise,
    rejectPendingNext: error => pendingNext.reject(error),
    returnCalled: () => returned,
    stream: {
      controller,
      [Symbol.asyncIterator]: () => iterator,
    } as Stream<BetaRawMessageStreamEvent>,
  }
}

function makeCompleteStream(): Stream<BetaRawMessageStreamEvent> {
  const controller = new AbortController()
  const events = makeCompleteStreamEvents()
  const iterator: AsyncIterator<BetaRawMessageStreamEvent> = {
    next() {
      const value = events.shift()
      return Promise.resolve(
        value === undefined
          ? { done: true, value: undefined }
          : { done: false, value },
      )
    },
  }

  return {
    controller,
    [Symbol.asyncIterator]: () => iterator,
  } as Stream<BetaRawMessageStreamEvent>
}

function makeWithResponse(stream: Stream<BetaRawMessageStreamEvent>) {
  return {
    withResponse: async () => ({
      data: stream,
      request_id: 'req-stream-watchdog',
      response: new Response('', {
        headers: { 'request-id': 'req-stream-watchdog' },
      }),
    }),
  }
}

function makeOptions(onStreamingFallback?: () => void): Options {
  return {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    model: 'claude-watchdog-test',
    isNonInteractiveSession: false,
    querySource: 'sdk',
    agents: [],
    hasAppendSystemPrompt: false,
    mcpTools: [],
    onStreamingFallback,
    queryLifecycle: new QueryLifecycleOperationTracker(),
  }
}

function makeMessages(): Message[] {
  return [
    {
      type: 'user',
      uuid: '00000000-0000-0000-0000-000000000101',
      timestamp: '2026-06-30T00:00:00.000Z',
      message: { role: 'user', content: 'hello' },
    } as Message,
  ]
}

async function collectStreamingMessages(
  signal: AbortSignal,
  options: Options,
): Promise<unknown[]> {
  const { queryModelWithStreaming } = await import(
    `./claude.js?stream-watchdog-test-${importCounter++}`
  )
  const messages: unknown[] = []
  for await (const message of queryModelWithStreaming({
    messages: makeMessages(),
    systemPrompt: asSystemPrompt([]),
    thinkingConfig: { type: 'disabled' },
    tools: [],
    signal,
    options,
  })) {
    messages.push(message)
  }
  return messages
}

function delay(ms: number): Promise<'timeout'> {
  return new Promise(resolve => {
    setTimeout(() => resolve('timeout'), ms)
  })
}

async function settleForCleanup(promise: Promise<unknown>): Promise<void> {
  await Promise.race([promise.catch(() => undefined), delay(50)])
}

function setTestMacro(): void {
  ;(globalThis as Record<string, unknown>).MACRO = {
    VERSION: '0.0.0-test',
    DISPLAY_VERSION: '0.0.0-test',
    BUILD_TIME: 'test',
    ISSUES_EXPLAINER: 'test',
    PACKAGE_URL: 'test',
    NATIVE_PACKAGE_URL: undefined,
  }
}

beforeEach(async () => {
  await acquireSharedMutationLock('claude.streamWatchdog.test.ts')
  installClientSpy()
  setTestMacro()
  await __waitForInterruptionTraceFlushForTests()
  __resetInterruptionTraceForTests()
  for (const key of envKeys) {
    delete process.env[key]
  }
  fixturesRoot = mkdtempSync(join(tmpdir(), 'claude-watchdog-vcr-'))
  process.env.ANTHROPIC_API_KEY = 'sk-test-watchdog'
  process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = fixturesRoot
  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '25'
  process.env.OPENCLAUDE_MAX_RETRIES = '0'
  process.env.VCR_RECORD = '1'
})

afterEach(async () => {
  try {
    restoreClientSpy?.()
    restoreClientSpy = undefined
    createHandler = undefined
    await __waitForInterruptionTraceFlushForTests()
    __resetInterruptionTraceForTests()
    for (const key of envKeys) {
      const envKey: string = key
      if (
        envKey === '__proto__' ||
        envKey === 'constructor' ||
        envKey === 'prototype'
      ) {
        continue
      }

      if (originalEnv[envKey] === undefined) {
        delete process.env[envKey]
      } else {
        process.env[envKey] = originalEnv[envKey]
      }
    }
    if (hadSavedMacro) {
      ;(globalThis as Record<string, unknown>).MACRO = savedMacro
    } else {
      delete (globalThis as Record<string, unknown>).MACRO
    }
    if (fixturesRoot) {
      rmSync(fixturesRoot, { force: true, recursive: true })
      fixturesRoot = undefined
    }
  } finally {
    releaseSharedMutationLock()
  }
})

describe('Claude stream watchdog', () => {
  test('falls back when the top-level stream iterator never settles', async () => {
    const traceFile = join(fixturesRoot!, 'interruption-trace.jsonl')
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    process.env.OPENCLAUDE_INTERRUPT_TRACE_FILE = traceFile
    const wedged = makeWedgedStream()
    const streamModes: unknown[] = []
    createHandler = params => {
      streamModes.push(params.stream)
      if (params.stream === true) {
        return makeWithResponse(wedged.stream)
      }
      return Promise.resolve(
        makeBetaMessage('msg-fallback', [
          { type: 'text', text: 'fallback ok', citations: null },
        ]),
      )
    }

    const request = collectStreamingMessages(
      new AbortController().signal,
      makeOptions(),
    )
    await wedged.nextStarted

    try {
      const result = await Promise.race([request, delay(250)])
      expect(result).not.toBe('timeout')
      expect(streamModes).toEqual([true, undefined])
      expect(wedged.abortSignal.aborted).toBe(true)
      expect(wedged.returnCalled()).toBe(true)
      await __waitForInterruptionTraceFlushForTests()
      const trace = readFileSync(traceFile, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as {
          event: string
          eventId?: string
          causalEventId?: string
          source?: string
          outcome?: string
        })
      const events = trace.map(entry => entry.event)
      expect(events.indexOf('claude_stream.idle_timeout')).toBeGreaterThanOrEqual(0)
      expect(events.indexOf('claude_stream.loop_settled')).toBeGreaterThan(
        events.indexOf('claude_stream.idle_timeout'),
      )
      expect(events.indexOf('claude_stream.fallback_started')).toBeGreaterThan(
        events.indexOf('claude_stream.loop_settled'),
      )
      expect(trace).toContainEqual(
        expect.objectContaining({
          event: 'abort.requested',
          source: 'claude_stream_watchdog',
        }),
      )
      const idleTimeout = trace.find(
        entry => entry.event === 'claude_stream.idle_timeout',
      )
      const providerAbort = trace.find(
        entry =>
          entry.event === 'abort.requested' &&
          entry.source === 'claude_stream_watchdog',
      )
      const loopSettled = trace.find(
        entry => entry.event === 'claude_stream.loop_settled',
      )
      const fallbackStarted = trace.find(
        entry => entry.event === 'claude_stream.fallback_started',
      )
      const fallbackSettled = trace.find(
        entry => entry.event === 'claude_stream.fallback_settled',
      )
      expect(idleTimeout).toBeDefined()
      expect(providerAbort).toBeDefined()
      expect(loopSettled).toBeDefined()
      expect(fallbackStarted).toBeDefined()
      expect(fallbackSettled).toBeDefined()
      expect(typeof idleTimeout!.eventId).toBe('string')
      expect(typeof providerAbort!.causalEventId).toBe('string')
      expect(typeof loopSettled!.causalEventId).toBe('string')
      expect(typeof fallbackStarted!.causalEventId).toBe('string')
      expect(providerAbort!.causalEventId).toBe(idleTimeout!.eventId)
      expect(loopSettled!.causalEventId).toBe(idleTimeout!.eventId)
      expect(fallbackStarted!.causalEventId).toBe(idleTimeout!.eventId)
      expect(fallbackSettled).toMatchObject({
        causalEventId: fallbackStarted!.eventId,
        outcome: 'completed',
      })
      expect(
        (result as unknown[]).some(
          message =>
            typeof message === 'object' &&
            message !== null &&
            (message as { type?: unknown }).type === 'assistant',
        ),
      ).toBe(true)
    } finally {
      wedged.rejectPendingNext(new Error('test cleanup'))
      await settleForCleanup(request)
    }
  })

  test('does not attempt fallback when the parent signal aborts first', async () => {
    process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '250'
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    const wedged = makeWedgedStream()
    const controller = new AbortController()
    registerInterruptionController(controller, { controllerRole: 'query-root' })
    const streamModes: unknown[] = []
    createHandler = params => {
      streamModes.push(params.stream)
      if (params.stream === true) {
        return makeWithResponse(wedged.stream)
      }
      return Promise.resolve(
        makeBetaMessage('msg-unexpected-fallback', [
          { type: 'text', text: 'unexpected fallback', citations: null },
        ]),
      )
    }

    const request = collectStreamingMessages(controller.signal, makeOptions())
      .then(() => 'resolved')
      .catch(error =>
        error instanceof Error ? error.name : String(error),
      )
    await wedged.nextStarted
    requestAbort(controller, undefined, {
      source: 'cancel_keybinding',
      controllerRole: 'query-root',
    })

    try {
      const result = await Promise.race([request, delay(150)])
      expect(result).toBe('resolved')
      expect(streamModes).toEqual([true])
      expect(wedged.abortSignal.aborted).toBe(true)
      expect(wedged.returnCalled()).toBe(true)
      const trace = __getInterruptionTraceSnapshotForTests()
      const rootAbort = trace.find(
        entry =>
          entry.event === 'abort.requested' &&
          entry.controllerRole === 'query-root',
      )
      const parentAbort = trace.find(
        entry => entry.event === 'claude_stream.parent_abort',
      )
      const providerAbort = trace.find(
        entry =>
          entry.event === 'abort.requested' &&
          entry.source === 'claude_stream_parent',
      )
      expect(rootAbort).toBeDefined()
      expect(parentAbort).toBeDefined()
      expect(providerAbort).toBeDefined()
      expect(typeof rootAbort!.eventId).toBe('string')
      expect(typeof parentAbort!.eventId).toBe('string')
      expect(typeof parentAbort!.causalEventId).toBe('string')
      expect(typeof providerAbort!.causalEventId).toBe('string')
      expect(parentAbort!.causalEventId).toBe(rootAbort!.eventId)
      expect(providerAbort!.causalEventId).toBe(parentAbort!.eventId)
    } finally {
      wedged.rejectPendingNext(new Error('test cleanup'))
      await settleForCleanup(request)
    }
  })

  test('records a terminal failed outcome when non-streaming fallback rejects', async () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    const wedged = makeWedgedStream()
    createHandler = params => {
      if (params.stream === true) return makeWithResponse(wedged.stream)
      return Promise.reject(new Error('synthetic fallback failure'))
    }

    const request = collectStreamingMessages(
      new AbortController().signal,
      makeOptions(),
    )
    await wedged.nextStarted
    try {
      await Promise.race([request, delay(250)])
      const trace = __getInterruptionTraceSnapshotForTests()
      const started = trace.find(
        entry => entry.event === 'claude_stream.fallback_started',
      )
      const settled = trace.find(
        entry => entry.event === 'claude_stream.fallback_settled',
      )
      expect(started).toBeDefined()
      expect(settled).toMatchObject({
        outcome: 'failed',
        causalEventId: started!.eventId,
      })
    } finally {
      wedged.rejectPendingNext(new Error('test cleanup'))
      await settleForCleanup(request)
    }
  })

  test('records fallback failure when the returned message cannot be normalized', async () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    const wedged = makeWedgedStream()
    createHandler = params => {
      if (params.stream === true) return makeWithResponse(wedged.stream)
      return Promise.resolve(
        makeBetaMessage('msg-invalid-fallback', [null] as never),
      )
    }

    const request = collectStreamingMessages(
      new AbortController().signal,
      makeOptions(),
    )
    await wedged.nextStarted
    try {
      const result = await Promise.race([
        request.then(
          () => 'resolved',
          error => error,
        ),
        delay(250),
      ])
      expect(result).not.toBe('timeout')
      const settlements = __getInterruptionTraceSnapshotForTests().filter(
        entry => entry.event === 'claude_stream.fallback_settled',
      )
      expect(settlements).toHaveLength(1)
      expect(settlements[0]?.outcome).toBe('failed')
    } finally {
      wedged.rejectPendingNext(new Error('test cleanup'))
      await settleForCleanup(request)
    }
  })

  test('complete streams still produce the streamed assistant message', async () => {
    const streamModes: unknown[] = []
    let fallbackCount = 0
    createHandler = params => {
      streamModes.push(params.stream)
      if (params.stream === true) {
        return makeWithResponse(makeCompleteStream())
      }
      fallbackCount++
      return Promise.resolve(
        makeBetaMessage('msg-unexpected-fallback', [
          { type: 'text', text: 'unexpected fallback', citations: null },
        ]),
      )
    }

    const messages = await collectStreamingMessages(
      new AbortController().signal,
      makeOptions(),
    )

    expect(streamModes).toEqual([true])
    expect(fallbackCount).toBe(0)
    expect(
      messages.some(
        message =>
          typeof message === 'object' &&
          message !== null &&
          (message as { type?: unknown }).type === 'assistant' &&
          JSON.stringify(message).includes('stream ok'),
      ),
    ).toBe(true)
  })

  test('late rejection from an abandoned iterator read is observed', async () => {
    const wedged = makeWedgedStream()
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)
    createHandler = params => {
      if (params.stream === true) {
        return makeWithResponse(wedged.stream)
      }
      return Promise.resolve(
        makeBetaMessage('msg-fallback', [
          { type: 'text', text: 'fallback ok', citations: null },
        ]),
      )
    }

    const request = collectStreamingMessages(
      new AbortController().signal,
      makeOptions(),
    )
    await wedged.nextStarted

    try {
      const result = await Promise.race([request, delay(250)])
      expect(result).not.toBe('timeout')
      wedged.rejectPendingNext(new Error('late iterator failure'))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(unhandledRejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
      wedged.rejectPendingNext(new Error('test cleanup'))
      await settleForCleanup(request)
    }
  })
})
