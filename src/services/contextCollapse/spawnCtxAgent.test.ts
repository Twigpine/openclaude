import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Message } from '../../types/message.js'

// Capture the real modules up front. mock.module() is global and mock.restore()
// does NOT undo it (see effort.codex.test.ts), so the beforeEach stubs below
// would otherwise bleed into later test files (e.g. the tokens stub makes
// autoCompact see every conversation as over-threshold). We re-mock each back
// to its real implementation in afterEach.
//
// `import * as` yields a LIVE namespace that bun's mock.module mutates in
// place, so we must snapshot the real exports into a plain object now (before
// any mock runs) rather than hold the namespace. The autoCompact.js stub
// (getEffectiveContextWindowSize) in particular leaks into compressToolHistory,
// which imports that function and uses it to size truncation. Restoring by
// specifier is safe: autoCompact.test.ts re-imports autoCompact fresh via a
// cache-busting nonce (a different specifier), so it is unaffected.

const nonce = `${Date.now()}-${Math.random()}`
const realSpanSelection = {
  ...await import(`./spanSelection.js?real=${nonce}`),
} as typeof import('./spanSelection.js')
const realForkedAgent = {
  ...await import(`../../utils/forkedAgent.js?real=${nonce}`),
} as typeof import('../../utils/forkedAgent.js')
const realTokens = {
  ...await import(`../../utils/tokens.js?real=${nonce}`),
} as typeof import('../../utils/tokens.js')
const realAutoCompact = {
  ...await import(`../compact/autoCompact.js?real=${nonce}`),
} as typeof import('../compact/autoCompact.js')
const realAnalytics = {
  ...await import(`../../services/analytics/index.js?real=${nonce}`),
} as typeof import('../../services/analytics/index.js')
const realLog = {
  ...await import(`../../utils/log.js?real=${nonce}`),
} as typeof import('../../utils/log.js')
const realMessages = {
  ...await import(`../../utils/messages.js?real=${nonce}`),
} as typeof import('../../utils/messages.js')

// Build a transcript big enough to yield a collapsible span.
function bigTranscript(): Message[] {
  const out: Message[] = []
  for (let i = 0; i < 200; i++) {
    const isUser = i % 2 === 0
    out.push({
      type: isUser ? 'user' : 'assistant',
      uuid: `m${i}`,
      timestamp: '',
      message: { role: isUser ? 'user' : 'assistant', content: 'x'.repeat(500) },
    } as unknown as Message)
  }
  return out
}

let forkReturn: { messages: Message[]; totalUsage: Record<string, number> } | Error = {
  messages: [
    { type: 'assistant', uuid: 'sum', timestamp: '', message: { role: 'assistant', content: [{ type: 'text', text: 'A concise summary.' }] } } as unknown as Message,
  ],
  totalUsage: {},
}

beforeEach(() => {
  // Mock spanSelection to return a deterministic span so we can test the fork path.
  mock.module('./spanSelection.js', () => ({
    isToolResultMessage: (msg: Message) => false,
    isTurnStart: (msg: Message) => msg.type === 'user',
    selectCollapseSpan: () => ({
      startUuid: 'm0',
      endUuid: 'm19',
      startIndex: 0,
      tokenEstimate: 5000,
    }),
    computeRisk: () => 0.5,
    COLLAPSE_TARGET_RATIO: 0.7,
    PROTECTED_TAIL_RATIO: 0.3,
    MIN_COLLAPSE_TOKENS: 2000,
  }))

  // Mock forkedAgent to control the fork path.
  mock.module('../../utils/forkedAgent.js', () => ({
    runForkedAgent: async () => {
      if (forkReturn instanceof Error) throw forkReturn
      return forkReturn
    },
    getLastCacheSafeParams: () => ({
      systemPrompt: {},
      userContext: {},
      systemContext: {},
      toolUseContext: {},
      forkContextMessages: [],
    }),
    saveCacheSafeParams: () => {},
    createCacheSafeParams: () => ({
      systemPrompt: {},
      userContext: {},
      systemContext: {},
      toolUseContext: {},
      forkContextMessages: [],
    }),
    createSubagentContext: () => ({}),
    createGetAppStateWithAllowedTools: () => () => ({}),
    prepareForkedCommandContext: async () => ({}),
    extractResultText: () => '',
    cloneFileStateCache: () => ({}),
    createChildAbortController: () => new AbortController(),
    cloneContentReplacementState: () => ({}),
    accumulateUsage: () => ({}),
    updateUsage: () => ({}),
    parseToolListFromCLI: () => ({}),
    createDenialTrackingState: () => ({}),
    recordSidechainTranscript: async () => {},
  }))

  // Mock tokens so the 95% threshold is easily hit.
  mock.module('../../utils/tokens.js', () => ({
    tokenCountWithEstimation: () => 100000,
    getTokenUsage: () => undefined,
    tokenCountFromLastAPIResponse: () => 0,
    getIncrementalTokenCounter: () => ({}),
    getTokenCountFromUsage: () => 0,
    roughTokenCountEstimation: () => 100,
    roughTokenCountEstimationForMessages: () => 500,
  }))

  // Mock autoCompact since maybeSpawnCtxAgent requires it.
  mock.module('../compact/autoCompact.js', () => ({
    getEffectiveContextWindowSize: () => 20000,
  }))

  // Silence analytics/log noise.
  mock.module('../../services/analytics/index.js', () => ({
    logEvent: () => {},
  }))
  mock.module('../../utils/log.js', () => ({
    logError: () => {},
  }))

  // Mock messages.js since spawnCtxAgent uses require() for it.
  mock.module('../../utils/messages.js', () => ({
    createUserMessage: ({ content }: { content: string }) => ({
      type: 'user',
      uuid: 'prompt-uuid',
      timestamp: '',
      message: { role: 'user', content },
    }),
    getLastAssistantMessage: (msgs: Message[]) =>
      msgs.findLast((m: Message) => m.type === 'assistant'),
    getAssistantMessageText: (msg: Message) => {
      if (msg.type !== 'assistant') return null
      if (typeof msg.message.content === 'string') return msg.message.content
      return null
    },
  }))
})

afterEach(async () => {
  mock.restore()
  // Restore module stubs to their real implementations (mock.restore() does
  // not undo mock.module) so they do not bleed into other test files.
  mock.module('./spanSelection.js', () => realSpanSelection)
  mock.module('../../utils/forkedAgent.js', () => realForkedAgent)
  mock.module('../../utils/tokens.js', () => realTokens)
  mock.module('../compact/autoCompact.js', () => realAutoCompact)
  mock.module('../../services/analytics/index.js', () => realAnalytics)
  mock.module('../../utils/log.js', () => realLog)
  mock.module('../../utils/messages.js', () => realMessages)
  delete process.env.CLAUDE_CONTEXT_COLLAPSE
  // Re-sync enablement to the now-unset env so enabled=true does not leak
  // into later test files.
  const idx = await import('./index.js')
  idx.resetContextCollapse()
  idx.initContextCollapse()
})

function ctx() {
  return { options: { mainLoopModel: 'claude-sonnet-4', tools: [] }, abortController: new AbortController() } as unknown as import('../../Tool.js').ToolUseContext
}

describe('spawnCtxAgent (via maybeSpawnCtxAgent)', () => {
  test('stages exactly one span when the fork returns summary text', async () => {
    forkReturn = {
      messages: [
        { type: 'assistant', uuid: 'sum', timestamp: '', message: { role: 'assistant', content: 'A concise summary.' } } as unknown as Message,
      ],
      totalUsage: {},
    }
    process.env.CLAUDE_CONTEXT_COLLAPSE = '1'
    const idx = await import('./index.js')
    idx.resetContextCollapse()
    idx.initContextCollapse()
    const before = idx.getStats()
    await idx.applyCollapsesIfNeeded(bigTranscript(), ctx(), 'repl_main_thread')
    const stats = idx.getStats()
    // At least one span was collapsed or staged — real work happened.
    expect(stats.collapsedSpans + stats.stagedSpans).toBeGreaterThan(before.collapsedSpans + before.stagedSpans)
    expect(stats.health.totalSpawns).toBeGreaterThan(0)
  })

  test('records an error when the fork throws', async () => {
    forkReturn = new Error('boom')
    process.env.CLAUDE_CONTEXT_COLLAPSE = '1'
    const idx = await import('./index.js')
    idx.resetContextCollapse()
    idx.initContextCollapse()
    await idx.applyCollapsesIfNeeded(bigTranscript(), ctx(), 'repl_main_thread')
    expect(idx.getStats().health.totalErrors).toBeGreaterThan(0)
  })
})
