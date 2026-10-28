import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { query, type QueryOptions } from '../../src/entrypoints/sdk/query.js'
import { clearRegisteredHooks, registerHookCallbacks, getRegisteredHooks, getSessionId } from '../../src/bootstrap/state.js'
import { executePreToolHooks, executeStopHooks, getMatchingHooks } from '../../src/utils/hooks.js'
import type { ToolUseContext } from '../../src/Tool.js'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import type { HookInput } from '../../src/entrypoints/agentSdkTypes.js'
import type { HookCallback } from '../../src/types/hooks.js'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../../src/test/sharedMutationLock.js'
import * as settings from '../../src/utils/settings/settings.js'
import * as hooksConfigSnapshot from '../../src/utils/hooks/hooksConfigSnapshot.js'
import { MockQueryEngine } from './helpers/mock-engine.js'
import { drainQuery } from './helpers/query-test-doubles.js'

const queries: ReturnType<typeof query>[] = []
const settingsSpies: Array<{ mockRestore(): void }> = []

let savedHooks: ReturnType<typeof getRegisteredHooks>
beforeEach(async () => {
  await acquireSharedMutationLock('sdk-query-hooks')
  // The executor merges persisted hooks with registered callbacks. Isolate both
  // fresh settings and an already captured snapshot without changing their caches.
  settingsSpies.push(
    spyOn(settings, 'getSettingsForSource').mockReturnValue(null),
    spyOn(settings, 'getSettings_DEPRECATED').mockReturnValue({}),
    spyOn(hooksConfigSnapshot, 'getHooksConfigFromSnapshot').mockReturnValue({}),
  )
  savedHooks = getRegisteredHooks()
  clearRegisteredHooks()
})
afterEach(() => {
  try {
    for (const q of queries.splice(0)) q.close()
    clearRegisteredHooks()
    if (savedHooks) registerHookCallbacks(savedHooks)
  } finally {
    for (const spy of settingsSpies.splice(0)) spy.mockRestore()
    releaseSharedMutationLock()
  }
})

// Simulate model work while retaining the real query lifecycle, async context,
// hook matching and callback executor. No process-global module mocks.
function createQuery(hooks: QueryOptions['hooks'], work: () => Promise<void>, sessionId?: string) {
  class HookEngine extends MockQueryEngine {
    override async *submitMessage() {
      await work()
      yield* super.submitMessage('hooks')
    }
  }
  const q = query({ prompt: 'hooks', options: { cwd: process.cwd(), hooks, sessionId } })
  queries.push(q)
  ;(q as unknown as { setEngine(engine: MockQueryEngine): void }).setEngine(new HookEngine())
  return q
}

async function stop() {
  for await (const _ of executeStopHooks()) { /* run the real callback executor */ }
}

test('concurrent queries run only their own Stop callbacks, including the same session', async () => {
  const observed: string[] = []
  let arrivals = 0
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  const work = async () => {
    if (++arrivals === 2) release()
    await ready
    await stop()
  }
  const a = createQuery({ Stop: [{ hooks: [async () => { observed.push('a'); return {} }] }] }, work)
  const b = createQuery({ Stop: [{ hooks: [async () => { observed.push('b'); return {} }] }] }, work)
  const shared = createQuery({ Stop: [{ hooks: [async () => { observed.push('shared'); return {} }] }] }, stop, a.sessionId)
  const globalBefore = getRegisteredHooks()
  await Promise.all([drainQuery(a), drainQuery(b), drainQuery(shared)])
  expect(observed.sort()).toEqual(['a', 'b', 'shared'])
  expect(getRegisteredHooks()).toBe(globalBefore)
  await stop()
  expect(observed).toHaveLength(3)
})

test('closing before iteration never registers callbacks in another query', async () => {
  let calls = 0
  const globalBefore = getRegisteredHooks()
  const a = createQuery({ Stop: [{ hooks: [async () => { calls++; return {} }] }] }, stop)
  a.close()
  await drainQuery(a)
  await drainQuery(createQuery(undefined, stop))
  await stop()
  expect(calls).toBe(0)
  expect(getRegisteredHooks()).toBe(globalBefore)
})

test('query callbacks keep tool matchers and denial output through the hook executor', async () => {
  const seen: HookInput[] = []
  const q = createQuery({
    UnknownEvent: [{ hooks: [() => { throw new Error('invalid event') }] }],
    PreToolUse: [null, { matcher: '^Edit$', hooks: [null, async (input: HookInput) => {
      seen.push(input)
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } }
    }] }],
  }, async () => {
    const input: HookInput = {
      session_id: getSessionId(), transcript_path: '', cwd: process.cwd(),
      hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {}, tool_use_id: 'edit-1',
    }
    expect(await getMatchingHooks(undefined, getSessionId(), 'PreToolUse', { ...input, tool_name: 'Read' })).toHaveLength(0)
    const matches = await getMatchingHooks(undefined, getSessionId(), 'PreToolUse', input)
    expect(matches).toHaveLength(1)
    const context = {
      getAppState: getDefaultAppState,
      options: { tools: [] },
      abortController: new AbortController(),
      updateAttributionState: () => {},
    } as unknown as ToolUseContext
    const results = []
    for await (const result of executePreToolHooks('Edit', 'edit-1', {}, context)) results.push(result)
    expect(results.some(result => result.permissionBehavior === 'deny')).toBe(true)
  })
  await drainQuery(q)
  expect(seen).toHaveLength(1)
  expect(seen[0]!.session_id).toBe(q.sessionId)
})

test('malformed matchers are skipped while omitted and empty matchers remain wildcards', async () => {
  const calls: string[] = []
  const callback = (label: string) => async (input: HookInput) => {
    if (input.hook_event_name === 'PreToolUse') calls.push(`${label}:${input.tool_name}`)
    return {}
  }
  const q = createQuery({ PreToolUse: [
    ...[42, null, false, {}, []].map(matcher => ({ matcher, hooks: [callback('invalid')] })),
    { hooks: [callback('omitted')] },
    { matcher: undefined, hooks: [callback('undefined')] },
    { matcher: '', hooks: [callback('empty')] },
    { matcher: '^Edit$', hooks: [callback('edit')] },
  ] }, async () => {
    const context = {
      getAppState: getDefaultAppState,
      options: { tools: [] },
      abortController: new AbortController(),
      updateAttributionState: () => {},
    } as unknown as ToolUseContext
    for (const name of ['Read', 'Edit']) {
      for await (const _ of executePreToolHooks(name, `${name}-1`, {}, context)) {}
    }
  })
  await drainQuery(q)
  expect(calls.sort()).toEqual(['edit:Edit', 'empty:Edit', 'empty:Read', 'omitted:Edit', 'omitted:Read', 'undefined:Edit', 'undefined:Read'])
})

test('SDK callbacks receive executor arguments and the live combined abort signal', async () => {
  const controller = new AbortController()
  const appState = getDefaultAppState()
  const getAppState = () => appState
  const updateAttributionState = () => {}
  let received: Parameters<HookCallback['callback']> | undefined
  let observedAbort: boolean | undefined
  const q = createQuery({ PreToolUse: [{ hooks: [async (...args: Parameters<HookCallback['callback']>) => {
    received = args
    controller.abort()
    observedAbort = args[2]?.aborted
    return {}
  }] }] }, async () => {
    const context = {
      getAppState, updateAttributionState,
      options: { tools: [] },
      abortController: controller,
    } as unknown as ToolUseContext
    for await (const _ of executePreToolHooks('Edit', 'correlated-tool-1', {}, context, 'default', controller.signal)) {}
  })
  await drainQuery(q)
  expect(received).toHaveLength(5)
  expect(received![0].session_id).toBe(q.sessionId)
  expect(received![1]).toBe('correlated-tool-1')
  expect(received![2]).toBeInstanceOf(AbortSignal)
  expect(observedAbort).toBe(true)
  expect(received![3]).toBe(0)
  expect(received![4]?.getAppState).toBe(getAppState)
  expect(received![4]?.getAppState()).toBe(appState)
  expect(received![4]?.updateAttributionState).toBe(updateAttributionState)
})

for (const ending of ['completed', 'failed', 'closed', 'returned'] as const) {
  test(`callbacks are cleared for detached async work after query ${ending}`, async () => {
    let calls = 0
    let release!: () => void
    const ready = new Promise<void>(resolve => { release = resolve })
    let detached!: Promise<void>
    const q = createQuery({ Stop: [{ hooks: [async () => { calls++; return {} }] }] }, async () => {
      // Promise continuations retain the query's AsyncLocalStorage context.
      detached = ready.then(stop)
      if (ending === 'closed') q.close()
      if (ending === 'failed') throw new Error('engine failed')
    })
    try {
      if (ending === 'failed') await expect(drainQuery(q)).rejects.toThrow('engine failed')
      else if (ending === 'returned') {
        const iterator = q[Symbol.asyncIterator]()
        await iterator.next()
        await iterator.return?.()
      } else await drainQuery(q)
    } finally {
      release()
      await detached
    }
    expect(calls).toBe(0)
  })
}

test('process hooks remain available and unchanged when query hooks are cleaned up', async () => {
  let globalCalls = 0
  let localCalls = 0
  registerHookCallbacks({ Stop: [{ hooks: [{ type: 'callback', callback: async () => { globalCalls++; return {} } }] }] })
  const original = getRegisteredHooks()
  const q = createQuery({ Stop: [{ hooks: [async () => { localCalls++; return {} }] }] }, stop)
  await drainQuery(q)
  q.close()
  await stop()
  expect(localCalls).toBe(1)
  expect(globalCalls).toBe(2)
  expect(getRegisteredHooks()).toBe(original)
})
