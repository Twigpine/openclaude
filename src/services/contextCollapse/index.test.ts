import type { ToolUseContext } from '../../Tool.js'
import type { AppState } from '../../state/AppStateStore.js'
import { randomUUID } from 'crypto'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { UUID } from 'crypto'
import type { Message } from '../../types/message.js'
import type { ContextCollapseCommitEntry, ContextCollapseSnapshotEntry } from '../../types/logs.js'

beforeEach(() => {
  process.env.CLAUDE_CONTEXT_COLLAPSE = '1'
})
afterEach(() => {
  delete process.env.CLAUDE_CONTEXT_COLLAPSE
})

function uid(s: string): UUID {
  return `00000000-0000-4000-8000-${s.padStart(12, '0')}` as UUID
}

function makeUserMsg(id: string, content = 'hello'): Message {
  return {
    type: 'user',
    uuid: uid(id),
    timestamp: new Date().toISOString(),
    message: { content, role: 'user' as const },
  } as unknown as Message
}

function makeAssistantMsg(id: string, content = 'response'): Message {
  return {
    type: 'assistant',
    uuid: uid(id),
    timestamp: new Date().toISOString(),
    message: {
      id: randomUUID(),
      model: 'claude-sonnet-4',
      role: 'assistant',
      stop_reason: 'end_turn',
      stop_sequence: '',
      type: 'message',
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: 'text' as const, text: content }],
      context_management: null,
    },
  } as unknown as Message
}

function makeFakeToolUseContext() {
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'claude-sonnet-4',
      tools: [],
      verbose: false,
      thinkingConfig: {},
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { maxTurns: 10 },
    },
    abortController: new AbortController(),
    readFileState: {},
    getAppState: () => ({}),
    setAppState: (_f: (state: AppState) => AppState) => {},
    messages: [],
  } as unknown as ToolUseContext
}

// Module state is shared across ALL test files. We clean between groups.
async function cleanState() {
  const idx = await import('./index.js')
  idx.resetContextCollapse()
}

describe('init and enable', () => {
  test('initContextCollapse enables when CLAUDE_CONTEXT_COLLAPSE=1', async () => {
    await cleanState()
    process.env.CLAUDE_CONTEXT_COLLAPSE = '1'
    const idx = await import('./index.js')
    idx.initContextCollapse()
    expect(idx.isContextCollapseEnabled()).toBe(true)
  })

  test('initContextCollapse defaults to OFF without the env opt-in', async () => {
    await cleanState()
    delete process.env.CLAUDE_CONTEXT_COLLAPSE
    const idx = await import('./index.js')
    idx.initContextCollapse()
    expect(idx.isContextCollapseEnabled()).toBe(false)
    // restore for subsequent tests (beforeEach also sets it, but be explicit)
    process.env.CLAUDE_CONTEXT_COLLAPSE = '1'
  })

  test('resetContextCollapse re-arms an enabled session', async () => {
    await cleanState()
    process.env.CLAUDE_CONTEXT_COLLAPSE = '1'
    const idx = await import('./index.js')
    idx.initContextCollapse()
    expect(idx.getContextCollapseState()!.armed).toBe(true)
    // Compaction cleanup / rewind call reset; the session stays opted-in and
    // must remain able to spawn again, not silently disable for the session.
    idx.resetContextCollapse()
    expect(idx.getContextCollapseState()!.armed).toBe(true)
  })

  test('resetContextCollapse leaves a disabled session disarmed', async () => {
    await cleanState()
    delete process.env.CLAUDE_CONTEXT_COLLAPSE
    const idx = await import('./index.js')
    idx.initContextCollapse()
    idx.resetContextCollapse()
    expect(idx.getContextCollapseState()).toBeNull()
    process.env.CLAUDE_CONTEXT_COLLAPSE = '1'
  })

  test('getContextCollapseState returns valid shape when enabled', async () => {
    await cleanState()
    const idx = await import('./index.js')
    idx.initContextCollapse()
    const state = idx.getContextCollapseState()!
    expect(state).not.toBeNull()
    expect(typeof state.committedSpans).toBe('number')
    expect(typeof state.stagedSpans).toBe('number')
    expect(typeof state.armed).toBe('boolean')
  })

  test('getContextCollapseState returns null when not enabled', async () => {
    // Deterministic disabled state: clear the opt-in env and re-init so
    // enabled=false, then assert the null contract directly.
    await cleanState()
    delete process.env.CLAUDE_CONTEXT_COLLAPSE
    const idx = await import('./index.js')
    idx.initContextCollapse()
    expect(idx.getContextCollapseState()).toBeNull()
    // Restore the opt-in for subsequent tests (beforeEach also sets it).
    process.env.CLAUDE_CONTEXT_COLLAPSE = '1'
  })
})

describe('stats and subscribe', () => {
  test('getStats returns zero stats on fresh state', async () => {
    await cleanState()
    const idx = await import('./index.js')
    idx.initContextCollapse()
    const stats = idx.getStats()
    expect(stats.collapsedSpans).toBe(0)
    expect(stats.collapsedMessages).toBe(0)
    expect(stats.stagedSpans).toBe(0)
  })

  test('subscribe returns unsubscribe function', async () => {
    await cleanState()
    const idx = await import('./index.js')
    const unsub = idx.subscribe(() => {})
    expect(typeof unsub).toBe('function')
    unsub()
  })

  test('subscribe listener fires on resetContextCollapse', async () => {
    await cleanState()
    const idx = await import('./index.js')
    idx.initContextCollapse()
    let called = false
    idx.subscribe(() => { called = true })
    idx.resetContextCollapse()
    expect(called).toBe(true)
  })
})

describe('hasActiveReduction', () => {
  // Gates autocompact/blocking suppression: enablement alone is not enough, or
  // a turn where collapse could not produce a span would suppress the fallback
  // and send an oversized transcript to the API.
  test('false when collapse is disabled', async () => {
    await cleanState()
    delete process.env.CLAUDE_CONTEXT_COLLAPSE
    const idx = await import('./index.js')
    idx.initContextCollapse()
    expect(idx.hasActiveReduction()).toBe(false)
    process.env.CLAUDE_CONTEXT_COLLAPSE = '1'
  })

  test('false when enabled but nothing committed or staged', async () => {
    await cleanState()
    process.env.CLAUDE_CONTEXT_COLLAPSE = '1'
    const idx = await import('./index.js')
    idx.initContextCollapse()
    expect(idx.isContextCollapseEnabled()).toBe(true)
    expect(idx.hasActiveReduction()).toBe(false)
  })

  test('true once a span is committed', async () => {
    await cleanState()
    process.env.CLAUDE_CONTEXT_COLLAPSE = '1'
    const idx = await import('./index.js')
    idx.initContextCollapse()
    idx.restoreContextCollapseState(
      [
        {
          type: 'marble-origami-commit' as const,
          sessionId: uid('s1'),
          collapseId: '0000000000000001',
          summaryUuid: uid('sum1'),
          summaryContent: '<collapsed id="0000000000000001">test summary</collapsed>',
          summary: 'test summary',
          firstArchivedUuid: uid('a'),
          lastArchivedUuid: uid('b'),
        },
      ],
      undefined,
    )
    expect(idx.hasActiveReduction()).toBe(true)
  })

  test('true when only staged (no committed spans)', async () => {
    // The pre-commit staged state is what decides whether autocompact and the
    // blocking preempt are suppressed; a regression here recreates the
    // fallback bug without any committed-state test failing.
    await cleanState()
    process.env.CLAUDE_CONTEXT_COLLAPSE = '1'
    const idx = await import('./index.js')
    idx.initContextCollapse()
    idx.restoreContextCollapseState([], {
      type: 'marble-origami-snapshot' as const,
      sessionId: uid('s1'),
      staged: [
        { startUuid: uid('a'), endUuid: uid('b'), summary: 'pending', risk: 0.7, stagedAt: Date.now() },
      ],
      armed: true,
      lastSpawnTokens: 1000,
    })
    expect(idx.getStats().collapsedSpans).toBe(0)
    expect(idx.getStats().stagedSpans).toBe(1)
    expect(idx.hasActiveReduction()).toBe(true)
  })
})

describe('isMainThreadSource', () => {
  test('true for main-thread sources, false for subagent/fork sources', async () => {
    const idx = await import('./index.js')
    expect(idx.isMainThreadSource('repl_main_thread')).toBe(true)
    expect(idx.isMainThreadSource('repl_main_thread:resume')).toBe(true)
    expect(idx.isMainThreadSource('sdk')).toBe(true)
    expect(idx.isMainThreadSource(undefined)).toBe(true)
    expect(idx.isMainThreadSource('agent:explore')).toBe(false)
    expect(idx.isMainThreadSource('marble_origami')).toBe(false)
    expect(idx.isMainThreadSource('compact')).toBe(false)
    expect(idx.isMainThreadSource('session_memory')).toBe(false)
  })
})

describe('subagent sources do not touch the shared store', () => {
  // Regression for the fallback bug: an in-process subagent (agent:*) shares the
  // module-level collapse store but does not own the main transcript. It must
  // not apply/stage/commit (which would flip hasActiveReduction() globally and
  // suppress the main thread's autocompact/blocking fallback while projectView()
  // no-ops on main messages).
  function committedSpan() {
    return [
      {
        type: 'marble-origami-commit' as const,
        sessionId: uid('s1'),
        collapseId: '0000000000000001',
        summaryUuid: uid('sum'),
        summaryContent: '<collapsed id="0000000000000001">summary</collapsed>',
        summary: 'summary',
        firstArchivedUuid: uid('a1'),
        lastArchivedUuid: uid('a3'),
      },
    ]
  }
  const fullHistory: Message[] = [
    makeUserMsg('u0'),
    makeUserMsg('a1'),
    makeAssistantMsg('a2'),
    makeUserMsg('a3'),
    makeUserMsg('u4'),
  ]

  test('applyCollapsesIfNeeded does not project a committed collapse for an agent:* source', async () => {
    await cleanState()
    const idx = await import('./index.js')
    idx.initContextCollapse()
    idx.restoreContextCollapseState(committedSpan(), undefined)

    const { messages } = await idx.applyCollapsesIfNeeded(
      fullHistory,
      makeFakeToolUseContext(),
      'agent:explore',
    )
    // Untouched: the archived span is still present, no summary injected.
    expect(messages).toEqual(fullHistory)

    // Sanity: the same state DOES project on the main thread.
    const main = await idx.applyCollapsesIfNeeded(
      fullHistory,
      makeFakeToolUseContext(),
      'repl_main_thread',
    )
    expect(main.messages.map(m => m.uuid)).toContain(uid('sum'))
    expect(main.messages.map(m => m.uuid)).not.toContain(uid('a2'))
  })

  test('isWithheldPromptTooLong is false for an agent:* source even with staged spans', async () => {
    await cleanState()
    const idx = await import('./index.js')
    idx.initContextCollapse()
    idx.restoreContextCollapseState([], {
      type: 'marble-origami-snapshot' as const,
      sessionId: uid('s1'),
      staged: [
        { startUuid: uid('a'), endUuid: uid('b'), summary: 'pending', risk: 0.7, stagedAt: Date.now() },
      ],
      armed: true,
      lastSpawnTokens: 1000,
    })
    const msg = makeAssistantMsg('a', 'prompt too long')
    expect(idx.isWithheldPromptTooLong(msg, () => true, 'agent:explore')).toBe(false)
    // Main thread with the same staged span does withhold.
    expect(idx.isWithheldPromptTooLong(msg, () => true, 'repl_main_thread')).toBe(true)
  })

  test('recoverFromOverflow does not drain staged spans for an agent:* source', async () => {
    await cleanState()
    const idx = await import('./index.js')
    idx.initContextCollapse()
    idx.restoreContextCollapseState([], {
      type: 'marble-origami-snapshot' as const,
      sessionId: uid('s1'),
      staged: [
        { startUuid: uid('a1'), endUuid: uid('a3'), summary: 'pending', risk: 0.7, stagedAt: Date.now() },
      ],
      armed: true,
      lastSpawnTokens: 1000,
    })
    const result = idx.recoverFromOverflow(fullHistory, 'agent:explore')
    expect(result.committed).toBe(0)
    expect(result.messages).toEqual(fullHistory)
    expect(idx.getStats().stagedSpans).toBe(1)
  })
})

describe('core API (no staged spans)', () => {
  test('applyCollapsesIfNeeded: identity when nothing staged', async () => {
    await cleanState()
    const idx = await import('./index.js')
    idx.initContextCollapse()
    const msgs = [makeUserMsg('a'), makeAssistantMsg('b')]
    const result = await idx.applyCollapsesIfNeeded(msgs, makeFakeToolUseContext(), 'user_prompt')
    expect(result.messages).toEqual(msgs)
  })

  test('applyCollapsesIfNeeded: skips marble_origami source', async () => {
    await cleanState()
    const idx = await import('./index.js')
    idx.initContextCollapse()
    const msgs = [makeUserMsg('a'), makeAssistantMsg('b')]
    const result = await idx.applyCollapsesIfNeeded(msgs, makeFakeToolUseContext(), 'marble_origami')
    expect(result.messages).toEqual(msgs)
  })

  test('isWithheldPromptTooLong: false with no staged', async () => {
    await cleanState()
    const idx = await import('./index.js')
    idx.initContextCollapse()
    const msg = makeAssistantMsg('a', 'prompt too long')
    expect(idx.isWithheldPromptTooLong(msg, () => true, 'user_prompt')).toBe(false)
  })

  test('isWithheldPromptTooLong: false for non-assistant', async () => {
    await cleanState()
    const idx = await import('./index.js')
    idx.initContextCollapse()
    const user = makeUserMsg('a')
    expect(idx.isWithheldPromptTooLong(user, () => true, 'user_prompt')).toBe(false)
  })

  test('isWithheldPromptTooLong: false for undefined', async () => {
    await cleanState()
    const idx = await import('./index.js')
    idx.initContextCollapse()
    expect(idx.isWithheldPromptTooLong(undefined, () => true, 'user_prompt')).toBe(false)
  })

  test('recoverFromOverflow: zero committed on clean state', async () => {
    await cleanState()
    const idx = await import('./index.js')
    idx.initContextCollapse()
    const msgs = [makeUserMsg('a'), makeAssistantMsg('b')]
    const result = idx.recoverFromOverflow(msgs, 'user_prompt')
    expect(result.committed).toBe(0)
    expect(result.messages).toEqual(msgs)
  })
})

describe('restoreContextCollapseState', () => {
  test('rebuilds from commits and snapshot', async () => {
    await cleanState()
    const idx = await import('./index.js')
    idx.initContextCollapse()

    const commits: ContextCollapseCommitEntry[] = [
      {
        type: 'marble-origami-commit' as const,
        sessionId: uid('s1'),
        collapseId: '0000000000000007',
        summaryUuid: uid('s1'),
        summaryContent: '<collapsed id="0000000000000007">summary</collapsed>',
        summary: 'summary',
        firstArchivedUuid: uid('a'),
        lastArchivedUuid: uid('b'),
      },
    ]

    const snapshot: ContextCollapseSnapshotEntry = {
      type: 'marble-origami-snapshot' as const,
      sessionId: uid('s1'),
      staged: [
        { startUuid: uid('c'), endUuid: uid('d'), summary: 'pending', risk: 0.7, stagedAt: Date.now() },
      ],
      armed: true,
      lastSpawnTokens: 10000,
    }

    idx.restoreContextCollapseState(commits, snapshot)
    expect(idx.getStats().collapsedSpans).toBe(1)
    expect(idx.getStats().stagedSpans).toBe(1)
  })

  test('restored commit reports its archivedCount in collapsedMessages', async () => {
    // After a resume the archived messages are not held per-commit; getStats
    // must use the persisted count so /context, ctx_inspect, and the token
    // warning report the same figure as a live session, not "0 messages".
    await cleanState()
    const idx = await import('./index.js')
    idx.initContextCollapse()
    idx.restoreContextCollapseState(
      [
        {
          type: 'marble-origami-commit' as const,
          sessionId: uid('s1'),
          collapseId: '0000000000000007',
          summaryUuid: uid('sum'),
          summaryContent: '<collapsed id="0000000000000007">summary</collapsed>',
          summary: 'summary',
          firstArchivedUuid: uid('a'),
          lastArchivedUuid: uid('b'),
          archivedCount: 5,
        },
      ],
      undefined,
    )
    expect(idx.getStats().collapsedSpans).toBe(1)
    expect(idx.getStats().collapsedMessages).toBe(5)
  })

  test('pre-field commit (no archivedCount) restores as 0 messages', async () => {
    await cleanState()
    const idx = await import('./index.js')
    idx.initContextCollapse()
    idx.restoreContextCollapseState(
      [
        {
          type: 'marble-origami-commit' as const,
          sessionId: uid('s1'),
          collapseId: '0000000000000008',
          summaryUuid: uid('sum2'),
          summaryContent: '<collapsed id="0000000000000008">summary</collapsed>',
          summary: 'summary',
          firstArchivedUuid: uid('a'),
          lastArchivedUuid: uid('b'),
        },
      ],
      undefined,
    )
    expect(idx.getStats().collapsedSpans).toBe(1)
    expect(idx.getStats().collapsedMessages).toBe(0)
  })

  test('ID counter reseeded from max collapseId', async () => {
    await cleanState()
    const idx = await import('./index.js')
    idx.initContextCollapse()

    idx.restoreContextCollapseState([
      {
        type: 'marble-origami-commit' as const,
        sessionId: uid('s1'),
        collapseId: '0000000000000042',
        summaryUuid: uid('s1'),
        summaryContent: '<collapsed id="0000000000000042">x</collapsed>',
        summary: 'x',
        firstArchivedUuid: uid('a'),
        lastArchivedUuid: uid('b'),
      },
    ], undefined)

    expect(idx.getStats().collapsedSpans).toBe(1)
  })

  test('snapshot last-wins', async () => {
    await cleanState()
    const idx = await import('./index.js')
    idx.initContextCollapse()

    const s1: ContextCollapseSnapshotEntry = {
      type: 'marble-origami-snapshot' as const, sessionId: uid('s1'),
      staged: [{ startUuid: uid('a'), endUuid: uid('b'), summary: 'first', risk: 0.3, stagedAt: Date.now() }],
      armed: true, lastSpawnTokens: 1000,
    }
    idx.restoreContextCollapseState([], s1)
    expect(idx.getStats().stagedSpans).toBe(1)

    const s2: ContextCollapseSnapshotEntry = {
      type: 'marble-origami-snapshot' as const, sessionId: uid('s1'),
      staged: [
        { startUuid: uid('c'), endUuid: uid('d'), summary: 'second-a', risk: 0.9, stagedAt: Date.now() },
        { startUuid: uid('e'), endUuid: uid('f'), summary: 'second-b', risk: 0.5, stagedAt: Date.now() },
      ],
      armed: false, lastSpawnTokens: 2000,
    }
    idx.restoreContextCollapseState([], s2)
    expect(idx.getStats().stagedSpans).toBe(2)
  })
})

describe('applyCollapsesIfNeeded projection', () => {
  test('re-applies a committed collapse to the next turn input, not just /context', async () => {
    await cleanState()
    const idx = await import('./index.js')
    idx.initContextCollapse()

    // A collapse committed on a prior turn (e.g. restored on resume).
    idx.restoreContextCollapseState(
      [
        {
          type: 'marble-origami-commit' as const,
          sessionId: uid('s1'),
          collapseId: '0000000000000001',
          summaryUuid: uid('sum'),
          summaryContent: '<collapsed id="0000000000000001">summary</collapsed>',
          summary: 'summary',
          firstArchivedUuid: uid('a1'),
          lastArchivedUuid: uid('a3'),
        },
      ],
      undefined,
    )

    // The REPL rebuilds messagesForQuery from the full history every turn, so
    // the archived span is present again on entry.
    const fullHistory: Message[] = [
      makeUserMsg('u0'),
      makeUserMsg('a1'),
      makeAssistantMsg('a2'),
      makeUserMsg('a3'),
      makeUserMsg('u4'),
    ]

    const { messages } = await idx.applyCollapsesIfNeeded(
      fullHistory,
      makeFakeToolUseContext(),
      'repl_main_thread',
    )

    const uuids = messages.map(m => m.uuid)
    expect(uuids).not.toContain(uid('a1'))
    expect(uuids).not.toContain(uid('a2'))
    expect(uuids).not.toContain(uid('a3'))
    expect(uuids).toContain(uid('sum'))
    expect(uuids).toContain(uid('u0'))
    expect(uuids).toContain(uid('u4'))
  })

  test('clears a staged span that is already committed (crash-window restore)', async () => {
    await cleanState()
    const idx = await import('./index.js')
    idx.initContextCollapse()

    // Restore where the same span is in BOTH the commit log and the staged
    // snapshot — possible if a crash landed the commit write but not the
    // snapshot that drops it from staged.
    idx.restoreContextCollapseState(
      [
        {
          type: 'marble-origami-commit' as const,
          sessionId: uid('s1'),
          collapseId: '0000000000000001',
          summaryUuid: uid('sum'),
          summaryContent: '<collapsed id="0000000000000001">summary</collapsed>',
          summary: 'summary',
          firstArchivedUuid: uid('a1'),
          lastArchivedUuid: uid('a3'),
        },
      ],
      {
        type: 'marble-origami-snapshot' as const,
        sessionId: uid('s1'),
        staged: [
          { startUuid: uid('a1'), endUuid: uid('a3'), summary: 'summary', risk: 0.8, stagedAt: Date.now() },
        ],
        armed: true,
        lastSpawnTokens: 0,
      },
    )
    expect(idx.getStats().stagedSpans).toBe(1)

    const fullHistory: Message[] = [
      makeUserMsg('u0'),
      makeUserMsg('a1'),
      makeAssistantMsg('a2'),
      makeUserMsg('a3'),
      makeUserMsg('u4'),
    ]

    const { messages } = await idx.applyCollapsesIfNeeded(
      fullHistory,
      makeFakeToolUseContext(),
      'repl_main_thread',
    )

    // Collapse applied, and the stale staged span is gone (not stuck forever).
    const uuids = messages.map(m => m.uuid)
    expect(uuids).toContain(uid('sum'))
    expect(uuids).not.toContain(uid('a2'))
    expect(idx.getStats().stagedSpans).toBe(0)
  })
})

describe('health', () => {
  test('health fields initialized correctly', async () => {
    await cleanState()
    const idx = await import('./index.js')
    idx.initContextCollapse()
    const s = idx.getStats()
    expect(s.health.totalSpawns).toBe(0)
    expect(s.health.totalErrors).toBe(0)
    expect(s.health.totalEmptySpawns).toBe(0)
    expect(s.health.lastError).toBeNull()
    expect(s.health.emptySpawnWarningEmitted).toBe(false)
  })
})
