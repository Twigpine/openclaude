import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as interruptionTraceModule from './interruptionTrace.js'
import {
  __getInterruptionTraceSnapshotForTests,
  __INTERRUPTION_TRACE_CAPACITY_FOR_TESTS,
  __resetInterruptionTraceForTests,
  __waitForInterruptionTraceFlushForTests,
  flushInterruptionTrace,
  getInterruptionSignalAbortEventId,
  registerInterruptionController,
  requestAbort,
  traceInterruptionEvent,
} from './interruptionTrace.js'
import { createCombinedAbortSignal } from './combinedAbortSignal.js'
import { createChildAbortController } from './abortController.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import {
  getFsImplementation,
  setFsImplementation,
  type FsOperations,
} from './fsOperations.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

const originalEnabled = process.env.OPENCLAUDE_INTERRUPT_TRACE
const originalFile = process.env.OPENCLAUDE_INTERRUPT_TRACE_FILE
const originalDiagnosticsFile = process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
let tempDirectory: string | undefined
let originalFs: FsOperations
const testLinuxTraceFile = process.platform === 'linux' ? test : test.skip
const testPosixSymlink = process.platform === 'win32' ? test.skip : test

beforeEach(async () => {
  await acquireSharedMutationLock('utils/interruptionTrace.test.ts')
  originalFs = getFsImplementation()
  await __waitForInterruptionTraceFlushForTests()
  __resetInterruptionTraceForTests()
  delete process.env.OPENCLAUDE_INTERRUPT_TRACE
  delete process.env.OPENCLAUDE_INTERRUPT_TRACE_FILE
  delete process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
})

afterEach(async () => {
  await __waitForInterruptionTraceFlushForTests()
  __resetInterruptionTraceForTests()
  setFsImplementation(originalFs)
  if (originalEnabled === undefined) delete process.env.OPENCLAUDE_INTERRUPT_TRACE
  else process.env.OPENCLAUDE_INTERRUPT_TRACE = originalEnabled
  if (originalFile === undefined) delete process.env.OPENCLAUDE_INTERRUPT_TRACE_FILE
  else process.env.OPENCLAUDE_INTERRUPT_TRACE_FILE = originalFile
  if (originalDiagnosticsFile === undefined) {
    delete process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
  } else {
    process.env.CLAUDE_CODE_DIAGNOSTICS_FILE = originalDiagnosticsFile
  }
  if (tempDirectory) {
    await rm(tempDirectory, { recursive: true, force: true })
    tempDirectory = undefined
  }
  releaseSharedMutationLock()
})

describe('interruptionTrace', () => {
  test('is a true no-op while disabled and preserves native abort behavior', () => {
    const controller = new AbortController()
    registerInterruptionController(controller, { controllerRole: 'root' })
    traceInterruptionEvent('query.started', { queryId: 'query-1' })
    requestAbort(controller, 'query-timeout', {
      source: 'query_guard',
      controllerRole: 'root',
    })

    expect(controller.signal.reason).toBe('query-timeout')
    expect(__getInterruptionTraceSnapshotForTests()).toEqual([])
  })

  test('correlates controllers and records first-wins plus repeated requests', () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    const controller = new AbortController()
    const controllerId = registerInterruptionController(controller, {
      controllerRole: 'query-root',
      queryId: 'query-1',
    })

    requestAbort(controller, 'query-timeout', {
      source: 'query_guard',
      queryId: 'query-1',
    })
    requestAbort(controller, 'user-cancel', {
      source: 'cancel_keybinding',
      queryId: 'query-1',
    })

    const entries = __getInterruptionTraceSnapshotForTests()
    const requested = entries.find(entry => entry.event === 'abort.requested')
    const observed = entries.find(entry => entry.event === 'signal.observed')
    const repeated = entries.find(entry => entry.event === 'abort.repeated')
    expect(controller.signal.reason).toBe('query-timeout')
    expect(requested?.controllerId).toBe(controllerId)
    expect(requested?.normalizedReason).toBe('query-timeout')
    expect(requested?.abortStackFingerprint).toMatch(/^[a-f0-9]{16}$/)
    expect(requested).not.toHaveProperty('abortCallSites')
    expect(typeof requested?.eventId).toBe('string')
    expect(typeof observed?.firstAbortEventId).toBe('string')
    expect(typeof repeated?.firstAbortEventId).toBe('string')
    expect(observed!.firstAbortEventId).toBe(requested!.eventId)
    expect(repeated!.firstAbortEventId).toBe(requested!.eventId)
    expect(repeated?.existingNormalizedReason).toBe('query-timeout')
    expect(repeated?.attemptedNormalizedReason).toBe('user-abort')
    expect(repeated?.outcome).toBe('ignored_first_abort_wins')
    expect(repeated?.repeatedCount).toBe(1)
  })

  test('links a combined signal abort to the winning parent request', () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    const parent = new AbortController()
    registerInterruptionController(parent, {
      controllerRole: 'query-root',
    })
    const combined = createCombinedAbortSignal(parent.signal, {
      trace: {
        subsystem: 'trace-test',
        controllerRole: 'combined',
      },
    })

    requestAbort(parent, 'query-timeout', {
      source: 'query_guard',
      subsystem: 'trace-test',
      controllerRole: 'query-root',
    })

    const requested = __getInterruptionTraceSnapshotForTests().filter(
      entry => entry.event === 'abort.requested',
    )
    expect(combined.signal.reason).toBe('query-timeout')
    expect(requested).toHaveLength(2)
    expect(requested[1]?.causalEventId).toBe(requested[0]?.eventId)
    expect(requested[1]?.winningParentControllerId).toBe(
      requested[0]?.controllerId,
    )
    combined.cleanup()
  })

  test('assigns a causal event id when a registered signal aborts natively', () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    const controller = new AbortController()
    registerInterruptionController(controller, { controllerRole: 'external' })

    controller.abort('external-abort')

    const observed = __getInterruptionTraceSnapshotForTests().find(
      entry => entry.event === 'signal.observed',
    )
    expect(observed).toBeDefined()
    expect(typeof observed?.eventId).toBe('string')
    expect(getInterruptionSignalAbortEventId(controller.signal)).toBe(
      observed!.eventId,
    )

    requestAbort(controller, 'second-abort', {
      source: 'native-abort-test',
      controllerRole: 'external',
    })
    const repeated = __getInterruptionTraceSnapshotForTests().find(
      entry => entry.event === 'abort.repeated',
    )
    expect(repeated).toBeDefined()
    expect(typeof repeated?.firstAbortEventId).toBe('string')
    expect(repeated!.firstAbortEventId).toBe(observed!.eventId)
  })

  test('links a native AbortSignal.any result to its winning parent', () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    const caller = new AbortController()
    const deadline = new AbortController()
    const combined = AbortSignal.any([caller.signal, deadline.signal])
    interruptionTraceModule.traceCombinedAbortSignal(
      combined,
      [caller.signal, deadline.signal], {
      subsystem: 'native-any-test',
      controllerRole: 'request-combined',
      },
    )

    caller.abort('user-cancel')

    const entries = __getInterruptionTraceSnapshotForTests()
    const parentObserved = entries.find(
      entry =>
        entry.event === 'signal.observed' &&
        entry.controllerRole === 'combined-parent',
    )
    const combinedObserved = entries.find(
      entry =>
        entry.event === 'signal.observed' &&
        entry.controllerRole === 'request-combined',
    )
    expect(parentObserved).toBeDefined()
    expect(combinedObserved).toMatchObject({
      subsystem: 'native-any-test',
      causalEventId: parentObserved!.eventId,
      winningParentControllerId: parentObserved!.controllerId,
    })
  })

  test('records permission abort resolution with the input causal edge', () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    const inputEventId = traceInterruptionEvent('input.ctrl_c')

    interruptionTraceModule.tracePermissionAbortResolution(
      'ctrl_c',
      inputEventId,
      'remote-permission',
    )

    expect(__getInterruptionTraceSnapshotForTests().at(-1)).toMatchObject({
      event: 'permission.abort_resolved',
      source: 'ctrl_c',
      subsystem: 'remote-permission',
      causalEventId: inputEventId,
      outcome: 'denied',
    })
  })

  testLinuxTraceFile('observes and flushes a query-root controller already aborted when registered', async () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    process.env.OPENCLAUDE_INTERRUPT_TRACE_FILE = '/trace.jsonl'
    let writes = 0
    setFsImplementation({
      ...originalFs,
      appendRegularFile: async () => {
        writes++
      },
    })
    const controller = new AbortController()
    controller.abort('external-abort')

    registerInterruptionController(controller, { controllerRole: 'query-root' })
    await __waitForInterruptionTraceFlushForTests()

    const observed = __getInterruptionTraceSnapshotForTests().find(
      entry => entry.event === 'signal.observed',
    )
    expect(observed?.controllerRole).toBe('query-root')
    expect(getInterruptionSignalAbortEventId(controller.signal)).toBe(
      observed?.eventId,
    )
    expect(writes).toBe(1)
  })

  testLinuxTraceFile('preserves an established query-root role when creating a child', async () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    process.env.OPENCLAUDE_INTERRUPT_TRACE_FILE = '/trace.jsonl'
    let writes = 0
    setFsImplementation({
      ...originalFs,
      appendRegularFile: async () => {
        writes++
      },
    })
    const parent = new AbortController()
    registerInterruptionController(parent, {
      controllerRole: 'query-root',
      queryId: 'query-root-1',
      queryGeneration: 3,
    })
    createChildAbortController(parent)

    requestAbort(parent, 'user-cancel', {
      source: 'cancel_keybinding',
      controllerRole: 'tool',
    })
    await __waitForInterruptionTraceFlushForTests()

    const observed = __getInterruptionTraceSnapshotForTests().find(
      entry =>
        entry.event === 'signal.observed' &&
        entry.normalizedReason === 'user-abort',
    )
    const requested = __getInterruptionTraceSnapshotForTests().find(
      entry => entry.event === 'abort.requested',
    )
    expect(requested).toMatchObject({
      source: 'cancel_keybinding',
      controllerRole: 'query-root',
      queryId: 'query-root-1',
      queryGeneration: 3,
    })
    expect(observed?.controllerRole).toBe('query-root')
    expect(writes).toBe(1)
  })

  test('replaces provisional parent and child roles with concrete lifecycle roles', () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    const parent = new AbortController()
    const child = createChildAbortController(parent)

    requestAbort(child, 'sibling_error', {
      source: 'sibling_error',
      subsystem: 'streaming_tool_executor',
      controllerRole: 'sibling-tools',
    })
    requestAbort(parent, 'task_stop', {
      source: 'task_stop',
      subsystem: 'local_agent_task',
      controllerRole: 'background-agent',
      subagentId: 'agent-1',
    })

    const requested = __getInterruptionTraceSnapshotForTests().filter(
      entry => entry.event === 'abort.requested',
    )
    expect(requested).toHaveLength(2)
    expect(requested[0]).toMatchObject({
      source: 'sibling_error',
      controllerRole: 'sibling-tools',
    })
    expect(requested[1]).toMatchObject({
      source: 'task_stop',
      controllerRole: 'background-agent',
      subagentId: 'agent-1',
    })
    const observed = __getInterruptionTraceSnapshotForTests().filter(
      entry => entry.event === 'signal.observed',
    )
    expect(observed).toHaveLength(2)
    expect(observed[0]?.controllerRole).toBe('sibling-tools')
    expect(observed[1]).toMatchObject({
      controllerRole: 'background-agent',
      subagentId: 'agent-1',
    })
  })

  test('retains a child owner when the parent aborts before a later request', () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    const parent = new AbortController()
    const child = createChildAbortController(parent, undefined, {
      subsystem: 'in_process_teammate',
      controllerRole: 'subagent-lifecycle',
      subagentId: 'agent-1',
    })

    requestAbort(parent, undefined, {
      source: 'cancel_keybinding',
      subsystem: 'query_engine',
      controllerRole: 'query-root',
    })

    const childObserved = __getInterruptionTraceSnapshotForTests().find(
      entry =>
        entry.event === 'signal.observed' &&
        entry.controllerRole === 'subagent-lifecycle',
    )
    expect(child.signal.aborted).toBe(true)
    expect(childObserved).toMatchObject({
      subsystem: 'in_process_teammate',
      controllerRole: 'subagent-lifecycle',
      subagentId: 'agent-1',
    })
  })

  test('throwing abort-reason accessors cannot block native or combined aborts', () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    const reason = new Proxy(
      {},
      {
        get() {
          throw new Error('reason getter must stay isolated')
        },
      },
    )
    const direct = new AbortController()
    expect(() =>
      requestAbort(direct, reason, {
        source: 'throwing-reason-test',
        controllerRole: 'query-root',
      }),
    ).not.toThrow()
    expect(direct.signal.aborted).toBe(true)
    expect(direct.signal.reason).toBe(reason)

    const parent = new AbortController()
    const combined = createCombinedAbortSignal(parent.signal)
    expect(() => parent.abort(reason)).not.toThrow()
    expect(combined.signal.aborted).toBe(true)
    expect(combined.signal.reason).toBe(reason)
    combined.cleanup()
  })

  test('does not persist arbitrary custom error names', () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    const reason = new Error('private reason message')
    reason.name = 'private customer prompt'

    traceInterruptionEvent('custom.error', { reason, error: reason })

    const serialized = JSON.stringify(__getInterruptionTraceSnapshotForTests())
    expect(serialized).not.toContain('private customer prompt')
    expect(serialized).not.toContain('private reason message')
    const entry = __getInterruptionTraceSnapshotForTests().at(-1)
    expect(entry?.rawReasonType).toBe('Error:Error')
    expect(entry?.safeErrorIdentity).toBe('Error')
  })

  test('preserves only standardized DOMException names', () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    const standard = new DOMException('private message', 'AbortError')
    const custom = new DOMException('private message', 'private customer prompt')

    traceInterruptionEvent('standard.dom.error', {
      reason: standard,
      error: standard,
    })
    traceInterruptionEvent('custom.dom.error', {
      reason: custom,
      error: custom,
    })

    const entries = __getInterruptionTraceSnapshotForTests()
    expect(entries.at(-2)?.rawReasonType).toBe('DOMException:AbortError')
    expect(entries.at(-2)?.safeErrorIdentity).toBe('DOMException:AbortError')
    expect(entries.at(-1)?.rawReasonType).toBe('DOMException')
    expect(entries.at(-1)?.safeErrorIdentity).toBe('DOMException')
    expect(JSON.stringify(entries)).not.toContain('private customer prompt')
    expect(JSON.stringify(entries)).not.toContain('private message')
  })

  test('keeps only the newest allowlisted records up to capacity', () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = 'true'
    const emitted = __INTERRUPTION_TRACE_CAPACITY_FOR_TESTS + 88
    for (let index = 0; index < emitted; index++) {
      traceInterruptionEvent('stream.progress', {
        rawByteCount: index,
        // Runtime extras are deliberately ignored by the allowlist boundary.
        ...({ prompt: 'must-not-appear' } as Record<string, unknown>),
      })
    }

    const entries = __getInterruptionTraceSnapshotForTests()
    expect(entries).toHaveLength(__INTERRUPTION_TRACE_CAPACITY_FOR_TESTS)
    expect(entries[0]?.sequence).toBe(emitted - __INTERRUPTION_TRACE_CAPACITY_FOR_TESTS + 1)
    expect(entries.at(-1)?.sequence).toBe(emitted)
    expect(JSON.stringify(entries)).not.toContain('must-not-appear')
    expect(JSON.stringify(entries)).not.toContain('prompt')
  })

  testLinuxTraceFile('flushes valid JSONL once to an explicit absolute path', async () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    tempDirectory = await mkdtemp(join(tmpdir(), 'openclaude-interrupt-trace-'))
    const traceFile = join(tempDirectory, 'trace.jsonl')
    process.env.OPENCLAUDE_INTERRUPT_TRACE_FILE = traceFile

    traceInterruptionEvent('query.started', {
      queryId: 'query-1',
      model: 'gpt-test',
    })
    flushInterruptionTrace('test')
    flushInterruptionTrace('test-repeat')
    await __waitForInterruptionTraceFlushForTests()

    const lines = (await readFile(traceFile, 'utf8')).trim().split('\n')
    const entries = lines.map(line => JSON.parse(line) as { event: string })
    expect(entries.map(entry => entry.event)).toEqual([
      'query.started',
      'trace.flush',
    ])
  })

  testLinuxTraceFile('flushes every pending record when the ring is at capacity', async () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    tempDirectory = await mkdtemp(join(tmpdir(), 'openclaude-interrupt-trace-'))
    const traceFile = join(tempDirectory, 'trace.jsonl')
    process.env.OPENCLAUDE_INTERRUPT_TRACE_FILE = traceFile
    for (let index = 0; index < __INTERRUPTION_TRACE_CAPACITY_FOR_TESTS; index++) {
      traceInterruptionEvent('stream.progress', { rawByteCount: index })
    }

    flushInterruptionTrace('capacity')
    await __waitForInterruptionTraceFlushForTests()

    const entries = (await readFile(traceFile, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { sequence: number; event: string })
    expect(entries).toHaveLength(__INTERRUPTION_TRACE_CAPACITY_FOR_TESTS + 1)
    expect(entries[0]?.sequence).toBe(1)
    expect(entries.at(-1)?.event).toBe('trace.flush')
  })

  testLinuxTraceFile('retains pending records after a failed write and retries them', async () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    process.env.OPENCLAUDE_INTERRUPT_TRACE_FILE = '/trace.jsonl'
    let failWrites = true
    let writeAttempts = 0
    const successfulWrites: string[] = []
    setFsImplementation({
      ...originalFs,
      mkdirSync: () => {},
      appendRegularFile: async (_path, data) => {
        writeAttempts++
        if (failWrites) throw new Error('synthetic write failure')
        successfulWrites.push(data)
      },
    })

    traceInterruptionEvent('first')
    flushInterruptionTrace('failed')
    await __waitForInterruptionTraceFlushForTests()
    expect(writeAttempts).toBe(1)
    failWrites = false
    traceInterruptionEvent('second')
    flushInterruptionTrace('retry')
    await __waitForInterruptionTraceFlushForTests()

    expect(writeAttempts).toBe(3)
    expect(successfulWrites).toHaveLength(2)
    const events = successfulWrites.flatMap(write =>
      write
        .trim()
        .split('\n')
        .map(line => (JSON.parse(line) as { event: string }).event),
    )
    expect(events).toEqual(['first', 'trace.flush', 'second', 'trace.flush'])
  })

  testLinuxTraceFile('captures the enabled output target before a detached flush starts', async () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    process.env.OPENCLAUDE_INTERRUPT_TRACE_FILE = '/captured/trace.jsonl'
    const writes: Array<{ path: string; data: string }> = []
    setFsImplementation({
      ...originalFs,
      appendRegularFile: async (path, data) => {
        writes.push({ path, data })
      },
    })

    traceInterruptionEvent('before_restore')
    flushInterruptionTrace('captured-target')
    delete process.env.OPENCLAUDE_INTERRUPT_TRACE
    delete process.env.OPENCLAUDE_INTERRUPT_TRACE_FILE
    await __waitForInterruptionTraceFlushForTests()

    expect(writes).toHaveLength(1)
    expect(writes[0]?.path).toBe('/captured/trace.jsonl')
    expect(writes[0]?.data).toContain('"event":"before_restore"')
    expect(writes[0]?.data).toContain('"event":"trace.flush"')
  })

  testLinuxTraceFile('keeps a retry batch bound to its original output target', async () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    process.env.OPENCLAUDE_INTERRUPT_TRACE_FILE = '/first/trace.jsonl'
    const writes: Array<{ path: string; data: string }> = []
    setFsImplementation({
      ...originalFs,
      appendRegularFile: async (path, data) => {
        writes.push({ path, data })
        if (writes.length === 1) throw new Error('synthetic retryable failure')
      },
    })

    traceInterruptionEvent('first_target')
    flushInterruptionTrace('first')
    await __waitForInterruptionTraceFlushForTests()
    process.env.OPENCLAUDE_INTERRUPT_TRACE_FILE = '/second/trace.jsonl'
    traceInterruptionEvent('second_target')
    flushInterruptionTrace('second')
    await __waitForInterruptionTraceFlushForTests()

    expect(writes.map(write => write.path)).toEqual([
      '/first/trace.jsonl',
      '/first/trace.jsonl',
      '/second/trace.jsonl',
    ])
    expect(writes[1]?.data).toContain('"event":"first_target"')
    expect(writes[2]?.data).toContain('"event":"second_target"')
    expect(writes[2]?.data).not.toContain('"event":"first_target"')
  })

  testLinuxTraceFile('retains an in-flight failed batch outside the bounded ring', async () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    process.env.OPENCLAUDE_INTERRUPT_TRACE_FILE = '/trace.jsonl'
    let rejectFirstWrite!: (error: Error) => void
    let markFirstWriteStarted!: () => void
    const firstWriteStarted = new Promise<void>(resolve => {
      markFirstWriteStarted = resolve
    })
    const firstWriteBlocked = new Promise<void>((_resolve, reject) => {
      rejectFirstWrite = reject
    })
    const writes: string[] = []
    setFsImplementation({
      ...originalFs,
      appendRegularFile: async (_path, data) => {
        if (writes.length === 0) {
          writes.push('failed')
          markFirstWriteStarted()
          await firstWriteBlocked
          return
        }
        writes.push(data)
      },
    })

    traceInterruptionEvent('must_survive')
    flushInterruptionTrace('blocked')
    await firstWriteStarted
    for (let index = 0; index < __INTERRUPTION_TRACE_CAPACITY_FOR_TESTS + 32; index++) {
      traceInterruptionEvent('newer', { rawByteCount: index })
    }
    rejectFirstWrite(new Error('synthetic write failure'))
    await __waitForInterruptionTraceFlushForTests()
    flushInterruptionTrace('retry')
    await __waitForInterruptionTraceFlushForTests()

    expect(writes).toHaveLength(3)
    expect(writes[1]).toContain('"event":"must_survive"')
  })

  testLinuxTraceFile('does not replay a batch after an uncertain append failure', async () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    process.env.OPENCLAUDE_INTERRUPT_TRACE_FILE = '/trace.jsonl'
    const writes: string[] = []
    setFsImplementation({
      ...originalFs,
      appendRegularFile: async (_path, data) => {
        writes.push(data)
        if (writes.length === 1) {
          throw Object.assign(new Error('partial append'), {
            code: 'ERR_DIAGNOSTIC_APPEND_UNCERTAIN',
          })
        }
      },
    })

    traceInterruptionEvent('first')
    flushInterruptionTrace('uncertain')
    await __waitForInterruptionTraceFlushForTests()
    traceInterruptionEvent('second')
    flushInterruptionTrace('later')
    await __waitForInterruptionTraceFlushForTests()

    expect(writes).toHaveLength(2)
    expect(writes[0]).toContain('"event":"first"')
    expect(writes[1]).not.toContain('"event":"first"')
    expect(writes[1]).toContain('"event":"second"')
  })

  testLinuxTraceFile('rejects an existing non-regular trace target', async () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    tempDirectory = await mkdtemp(join(tmpdir(), 'openclaude-interrupt-trace-'))
    process.env.OPENCLAUDE_INTERRUPT_TRACE_FILE = tempDirectory
    traceInterruptionEvent('pending')

    flushInterruptionTrace('non-regular')
    await __waitForInterruptionTraceFlushForTests()

    expect(
      __getInterruptionTraceSnapshotForTests().some(
        entry => entry.event === 'trace.flush',
      ),
    ).toBe(false)
  })

  testLinuxTraceFile('rejects symlink targets and creates private files and directories', async () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    tempDirectory = await mkdtemp(join(tmpdir(), 'openclaude-interrupt-trace-'))
    const target = join(tempDirectory, 'target.jsonl')
    const link = join(tempDirectory, 'trace-link.jsonl')
    await writeFile(target, '')
    await symlink(target, link)
    process.env.OPENCLAUDE_INTERRUPT_TRACE_FILE = link
    traceInterruptionEvent('symlink-pending')
    flushInterruptionTrace('symlink')
    await __waitForInterruptionTraceFlushForTests()
    expect(await readFile(target, 'utf8')).toBe('')

    // The rejected batch remains bound to its original target for retry.
    // Reset before exercising independent creation and permission behavior.
    __resetInterruptionTraceForTests()
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'

    const privateDirectory = join(tempDirectory, 'private')
    const privateTrace = join(privateDirectory, 'trace.jsonl')
    process.env.OPENCLAUDE_INTERRUPT_TRACE_FILE = privateTrace
    traceInterruptionEvent('private-target-pending')
    flushInterruptionTrace('private-target')
    await __waitForInterruptionTraceFlushForTests()
    expect((await stat(privateDirectory)).mode & 0o777).toBe(0o700)
    expect((await stat(privateTrace)).mode & 0o777).toBe(0o600)

    const existingTrace = join(tempDirectory, 'existing.jsonl')
    await writeFile(existingTrace, '', { mode: 0o644 })
    process.env.OPENCLAUDE_INTERRUPT_TRACE_FILE = existingTrace
    traceInterruptionEvent('existing-private-target')
    flushInterruptionTrace('existing-private-target')
    await __waitForInterruptionTraceFlushForTests()
    expect((await stat(existingTrace)).mode & 0o777).toBe(0o600)
  })

  testLinuxTraceFile('rejects a trace target beneath a symlinked parent directory', async () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    tempDirectory = await mkdtemp(join(tmpdir(), 'openclaude-interrupt-trace-'))
    const realDirectory = join(tempDirectory, 'real-parent')
    const linkedDirectory = join(tempDirectory, 'linked-parent')
    const realTrace = join(realDirectory, 'trace.jsonl')
    await mkdir(realDirectory)
    await symlink(realDirectory, linkedDirectory, 'dir')
    process.env.OPENCLAUDE_INTERRUPT_TRACE_FILE = join(
      linkedDirectory,
      'trace.jsonl',
    )

    traceInterruptionEvent('symlinked-parent-pending')
    flushInterruptionTrace('symlinked-parent')
    await __waitForInterruptionTraceFlushForTests()

    const result = await readFile(realTrace, 'utf8').catch(
      error => (error as NodeJS.ErrnoException).code,
    )
    expect(result).toBe('ENOENT')
  })

  testPosixSymlink('preserves legacy diagnostics append-through-symlink behavior', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'openclaude-diagnostics-'))
    const target = join(tempDirectory, 'target.jsonl')
    const link = join(tempDirectory, 'diagnostics-link.jsonl')
    await writeFile(target, '')
    await symlink(target, link)
    process.env.CLAUDE_CODE_DIAGNOSTICS_FILE = link

    logForDiagnosticsNoPII('info', 'symlink-test')

    expect(await readFile(target, 'utf8')).toContain('symlink-test')
    delete process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
  })

  test('does not block native abort while a trace append is pending', async () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    process.env.OPENCLAUDE_INTERRUPT_TRACE_FILE = '/trace.jsonl'
    let releaseWrite!: () => void
    const writeBlocked = new Promise<void>(resolve => {
      releaseWrite = resolve
    })
    setFsImplementation({
      ...originalFs,
      appendRegularFile: async () => writeBlocked,
    })
    const controller = new AbortController()

    try {
      requestAbort(controller, 'user-cancel', {
        source: 'cancel_keybinding',
        controllerRole: 'query-root',
      })

      expect(controller.signal.aborted).toBe(true)
    } finally {
      releaseWrite()
      await __waitForInterruptionTraceFlushForTests()
    }
  })

  testLinuxTraceFile('keeps sequence IDs unique and drains later events during an async flush', async () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    process.env.OPENCLAUDE_INTERRUPT_TRACE_FILE = '/trace.jsonl'
    let releaseFirstWrite!: () => void
    let markFirstWriteStarted!: () => void
    const firstWriteStarted = new Promise<void>(resolve => {
      markFirstWriteStarted = resolve
    })
    const firstWriteBlocked = new Promise<void>(resolve => {
      releaseFirstWrite = resolve
    })
    const writes: string[] = []
    setFsImplementation({
      ...originalFs,
      appendRegularFile: async (_path, data) => {
        writes.push(data)
        if (writes.length === 1) {
          markFirstWriteStarted()
          await firstWriteBlocked
        }
      },
    })

    traceInterruptionEvent('before')
    flushInterruptionTrace('first')
    try {
      await firstWriteStarted
      traceInterruptionEvent('during_one')
      traceInterruptionEvent('during_two')
    } finally {
      releaseFirstWrite()
      await __waitForInterruptionTraceFlushForTests()
    }
    const persistedEvents = writes.flatMap(write =>
      write
        .trim()
        .split('\n')
        .map(line => (JSON.parse(line) as { event: string }).event),
    )
    expect(persistedEvents.filter(event => event === 'before')).toHaveLength(1)
    expect(persistedEvents.filter(event => event === 'during_one')).toHaveLength(1)
    expect(persistedEvents.filter(event => event === 'during_two')).toHaveLength(1)
    const snapshot = __getInterruptionTraceSnapshotForTests()
    expect(new Set(snapshot.map(entry => entry.eventId)).size).toBe(snapshot.length)
    expect(snapshot.map(entry => entry.sequence)).toEqual(
      [...snapshot.map(entry => entry.sequence)].sort((left, right) => left - right),
    )
  })

  test('never persists dynamic function names from abort stacks', () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    const controller = new AbortController()
    const customerSpecificHandlerName = () => {
      requestAbort(controller, 'user-cancel', { source: 'test' })
    }

    customerSpecificHandlerName()

    const serialized = JSON.stringify(__getInterruptionTraceSnapshotForTests())
    expect(serialized).not.toContain('customerSpecificHandlerName')
    expect(serialized).not.toContain('abortCallSites')
  })

  test('does not write for relative paths and isolates write failures', async () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    traceInterruptionEvent('query.started')

    process.env.OPENCLAUDE_INTERRUPT_TRACE_FILE = 'relative-trace.jsonl'
    expect(() => flushInterruptionTrace('relative')).not.toThrow()
    process.env.OPENCLAUDE_INTERRUPT_TRACE_FILE = '/proc/openclaude/trace.jsonl'
    expect(() => flushInterruptionTrace('unwritable')).not.toThrow()
    await __waitForInterruptionTraceFlushForTests()
  })

  test('discards trace-file batches without retrying on unsupported platforms', async () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    process.env.OPENCLAUDE_INTERRUPT_TRACE_FILE = '/trace.jsonl'
    const writtenData: string[] = []
    setFsImplementation({
      ...originalFs,
      appendRegularFile: async (_path, data) => {
        writtenData.push(data)
      },
    })
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
    })
    try {
      traceInterruptionEvent('pending')
      flushInterruptionTrace('posix-platform')
      await __waitForInterruptionTraceFlushForTests()
      traceInterruptionEvent('later')
      flushInterruptionTrace('posix-platform-later')
      await __waitForInterruptionTraceFlushForTests()
      expect(writtenData).toEqual([])
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, 'platform', platformDescriptor)
      }
    }
    if (process.platform === 'linux') {
      traceInterruptionEvent('after_restore')
      flushInterruptionTrace('restored-platform')
      await __waitForInterruptionTraceFlushForTests()
      expect(writtenData).toHaveLength(1)
      const restoredWrite = writtenData[0] ?? ''
      expect(restoredWrite).toContain('"event":"after_restore"')
      expect(restoredWrite).not.toContain('"event":"pending"')
      expect(restoredWrite).not.toContain('"event":"later"')
    }
  })

  test('redacts secret-shaped values and absolute local paths', () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    traceInterruptionEvent('provider.failed', {
      model: 'AKIA1234567890ABCDEF',
      providerRoute: 'github_pat_1234567890abcdef',
      attemptId: '\\\\server\\share\\private',
      queryId: 'prefix(/srv/private/project)',
      error: new Error('message content is never serialized'),
    })

    const serialized = JSON.stringify(__getInterruptionTraceSnapshotForTests())
    expect(serialized).toContain('[redacted]')
    expect(serialized).toContain('Error')
    expect(serialized).not.toContain('AKIA1234567890ABCDEF')
    expect(serialized).not.toContain('github_pat_1234567890abcdef')
    expect(serialized).not.toContain('server')
    expect(serialized).not.toContain('/srv/private/project')
    expect(serialized).not.toContain('message content')
  })

  test('never serializes secret-shaped or path-shaped abort reasons', () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    const secretReason = 'github_pat_1234567890abcdef'
    const pathReason = '/srv/private/project/abort-reason'

    traceInterruptionEvent('abort.requested', { reason: secretReason })
    traceInterruptionEvent('abort.repeated', {
      existingReason: pathReason,
      attemptedReason: secretReason,
    })

    const snapshot = __getInterruptionTraceSnapshotForTests()
    const serialized = JSON.stringify(snapshot)
    expect(snapshot).toHaveLength(2)
    expect(snapshot[0]?.normalizedReason).toBe('unknown-abort')
    expect(snapshot[1]?.existingNormalizedReason).toBe('unknown-abort')
    expect(snapshot[1]?.attemptedNormalizedReason).toBe('unknown-abort')
    expect(serialized).not.toContain(secretReason)
    expect(serialized).not.toContain(pathReason)
  })
})
