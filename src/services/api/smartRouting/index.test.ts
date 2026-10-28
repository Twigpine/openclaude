import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import {
  clearSmartRoutingSessionDisable,
  decideTurnModel,
  deriveUserTurnNumber,
  extractLatestUserText,
  formatRoutingSummary,
  getRoutingSummaryForDisplay,
  getRoutingTally,
  isRetryableRoutedModelError,
  isSmartRoutingDisabledForSession,
  latestUserMessageHasNonTextContent,
  recordRoutingDecision,
  recordRoutingEscalation,
  resetRoutingTally,
  shouldDropPinForProviderSwap,
  type TurnRoutingDecision,
} from './index.js'
import * as modelAllowlistModule from '../../../utils/model/modelAllowlist.js'
import type { SettingsJson } from '../../../utils/settings/types.js'

// Control isModelAllowed directly rather than the global settings singleton it
// reads. This keeps these tests deterministic even when another test file leaks
// a mock.module of modelAllowlist (e.g. agent.test.ts), and the afterEach
// restore guarantees we never leak our own spy if an assertion throws first.
let activeAllowlistSpy: ReturnType<typeof spyOn> | undefined
afterEach(() => {
  activeAllowlistSpy?.mockRestore()
  activeAllowlistSpy = undefined
})

/** Force isModelAllowed to allow only the given models (exact membership). */
function mockGlobalAllowlist(availableModels: string[] | undefined) {
  activeAllowlistSpy = spyOn(modelAllowlistModule, 'isModelAllowed').mockImplementation(
    (model: string) => (availableModels ? availableModels.includes(model) : true),
  )
  return activeAllowlistSpy
}

const PARENT = 'gpt-5'

function settings(overrides: Record<string, unknown>): SettingsJson {
  return overrides as unknown as SettingsJson
}

// Two model-only agentModels keys + an opt-in smartRouting block. No availableModels
// allowlist, so isModelAllowed returns true for everything.
function enabledSettings(extra: Record<string, unknown> = {}): SettingsJson {
  return settings({
    agentModels: { mini: { model: 'gpt-5-mini' }, main: { model: 'gpt-5' } },
    smartRouting: { enabled: true, simpleModel: 'mini', strongModel: 'main' },
    ...extra,
  })
}

const userMsg = (text: string, isMeta = false) => ({
  type: 'user',
  isMeta,
  message: { role: 'user', content: text },
})
const toolResultMsg = () => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
})
const imageMsg = () => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }],
  },
})
const assistantMsg = () => ({ type: 'assistant', message: { role: 'assistant', content: 'hi' } })

describe('deriveUserTurnNumber', () => {
  test('counts only real user messages (not isMeta, not tool-results)', () => {
    const msgs = [
      userMsg('first real turn'),
      assistantMsg(),
      toolResultMsg(),
      userMsg('continue', true), // isMeta nudge
      userMsg('second real turn'),
    ]
    expect(deriveUserTurnNumber(msgs)).toBe(2)
  })

  test('empty conversation is zero', () => {
    expect(deriveUserTurnNumber([])).toBe(0)
  })
})

describe('extractLatestUserText', () => {
  test('returns the most recent real user message text', () => {
    const msgs = [userMsg('old'), assistantMsg(), userMsg('newest')]
    expect(extractLatestUserText(msgs)).toBe('newest')
  })

  test('skips isMeta and tool-result messages', () => {
    const msgs = [userMsg('the real one'), assistantMsg(), toolResultMsg(), userMsg('nudge', true)]
    expect(extractLatestUserText(msgs)).toBe('the real one')
  })

  test('joins text blocks of array content', () => {
    const msgs = [{ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }]
    expect(extractLatestUserText(msgs)).toBe('a\nb')
  })
})

describe('latestUserMessageHasNonTextContent', () => {
  test('detects image/document-style blocks on the latest real user turn', () => {
    expect(latestUserMessageHasNonTextContent([userMsg('old'), imageMsg()])).toBe(true)
    expect(
      latestUserMessageHasNonTextContent([
        imageMsg(),
        { type: 'user', message: { content: [{ type: 'text', text: 'plain follow-up' }] } },
      ]),
    ).toBe(false)
  })

  test('skips meta and tool-result carriers', () => {
    const msgs = [userMsg('plain'), imageMsg(), toolResultMsg(), userMsg('nudge', true)]
    expect(latestUserMessageHasNonTextContent(msgs)).toBe(true)
  })
})

describe('decideTurnModel', () => {
  afterEach(() => {
    clearSmartRoutingSessionDisable('sess-1')
    clearSmartRoutingSessionDisable('sess-2')
  })

  test('disabled settings → routed:false', () => {
    const d = decideTurnModel({
      settings: settings({}),
      parentModel: PARENT,
      input: { userText: 'hi', turnNumber: 2 },
    })
    expect(d.routed).toBe(false)
  })

  test('short non-first turn routes simple', () => {
    mockGlobalAllowlist(undefined) // allow all; immune to a leaked cross-file allowlist mock
    const d = decideTurnModel({
      settings: enabledSettings(),
      parentModel: PARENT,
      input: { userText: 'ok thanks', turnNumber: 3 },
    })
    expect(d).toMatchObject({ routed: true, complexity: 'simple', model: 'gpt-5-mini', strongModel: 'gpt-5' })
  })

  test('first turn routes strong (routeModel turnNumber===1 guard)', () => {
    mockGlobalAllowlist(undefined)
    const d = decideTurnModel({
      settings: enabledSettings(),
      parentModel: PARENT,
      input: { userText: 'ok', turnNumber: 1 },
    })
    expect(d).toMatchObject({ routed: true, complexity: 'strong', model: 'gpt-5' })
  })

  test('strong-signal prompt routes strong', () => {
    mockGlobalAllowlist(undefined)
    const d = decideTurnModel({
      settings: enabledSettings(),
      parentModel: PARENT,
      input: { userText: 'refactor the auth module please', turnNumber: 4 },
    })
    expect(d).toMatchObject({ routed: true, complexity: 'strong', model: 'gpt-5' })
  })

  test('non-text user content routes strong even when the text extractor is empty', () => {
    mockGlobalAllowlist(undefined)
    const d = decideTurnModel({
      settings: enabledSettings(),
      parentModel: PARENT,
      input: { userText: '', hasNonTextContent: true, turnNumber: 4 },
    })
    expect(d).toMatchObject({ routed: true, complexity: 'strong', model: 'gpt-5' })
  })

  test('sub-agent loops are never routed, so an agentRouting model is not overwritten', () => {
    mockGlobalAllowlist(undefined)
    for (const userText of ['ok thanks', 'refactor the auth module please']) {
      const d = decideTurnModel({
        settings: enabledSettings(),
        parentModel: 'agent-routed-model',
        input: { userText, turnNumber: 3 },
        sessionId: 'sess-1',
        agentId: 'agent-1',
      })
      expect(d).toEqual({ routed: false })
    }
  })

  test('a sub-agent loop does not disable routing for the session', () => {
    const spy = mockGlobalAllowlist(['some-other-model'])
    decideTurnModel({
      settings: enabledSettings(),
      parentModel: PARENT,
      input: { userText: 'ok thanks', turnNumber: 3 },
      sessionId: 'sess-1',
      agentId: 'agent-1',
    })
    expect(isSmartRoutingDisabledForSession('sess-1')).toBe(false)
    spy.mockRestore()
  })

  test('disallowed simple model coerces to strong', () => {
    // Distinct, non-prefix-colliding model ids so the allowlist genuinely blocks
    // simple while permitting strong.
    const s = settings({
      agentModels: { mini: { model: 'alpha-mini' }, main: { model: 'beta-big' } },
      smartRouting: { enabled: true, simpleModel: 'mini', strongModel: 'main' },
    })
    const spy = mockGlobalAllowlist(['beta-big'])
    const d = decideTurnModel({
      settings: s,
      parentModel: PARENT,
      input: { userText: 'ok thanks', turnNumber: 3 },
    })
    expect(d).toMatchObject({ routed: true, model: 'beta-big', complexity: 'strong' })
    spy.mockRestore()
  })

  test('both models disallowed → routing disabled for session, fires once', () => {
    const spy = mockGlobalAllowlist(['some-other-model'])
    const cfg = {
      settings: enabledSettings(),
      parentModel: PARENT,
      input: { userText: 'ok thanks', turnNumber: 3 },
      sessionId: 'sess-1',
    }
    const first = decideTurnModel(cfg)
    expect(first).toEqual({ routed: false, justDisabledForSession: true })
    expect(isSmartRoutingDisabledForSession('sess-1')).toBe(true)

    // Second call: still disabled, but the one-time flag is not re-raised.
    const second = decideTurnModel(cfg)
    expect(second).toEqual({ routed: false })
    spy.mockRestore()
  })

  test('both disallowed with no sessionId stays silent (no per-turn notice storm)', () => {
    const spy = mockGlobalAllowlist(['some-other-model'])
    const d = decideTurnModel({
      settings: enabledSettings(),
      parentModel: PARENT,
      input: { userText: 'ok thanks', turnNumber: 3 },
      // no sessionId
    })
    expect(d).toEqual({ routed: false })
    spy.mockRestore()
  })

  test('a session disable does not leak into another session', () => {
    const spy = mockGlobalAllowlist(['x'])
    decideTurnModel({
      settings: enabledSettings(),
      parentModel: PARENT,
      input: { userText: 'ok', turnNumber: 3 },
      sessionId: 'sess-1',
    })
    expect(isSmartRoutingDisabledForSession('sess-1')).toBe(true)
    expect(isSmartRoutingDisabledForSession('sess-2')).toBe(false)
    spy.mockRestore()
  })

  test('clearSmartRoutingSessionDisable re-enables a disabled session (the /smartroute on path)', () => {
    const spy = mockGlobalAllowlist(['x'])
    decideTurnModel({
      settings: enabledSettings(),
      parentModel: PARENT,
      input: { userText: 'ok', turnNumber: 3 },
      sessionId: 'sess-1',
    })
    expect(isSmartRoutingDisabledForSession('sess-1')).toBe(true)
    clearSmartRoutingSessionDisable('sess-1')
    expect(isSmartRoutingDisabledForSession('sess-1')).toBe(false)
    spy.mockRestore()
  })
})

describe('isRetryableRoutedModelError', () => {
  test('4xx client errors (bad request / auth / permission) are not retryable', () => {
    expect(isRetryableRoutedModelError({ status: 400 })).toBe(false)
    expect(isRetryableRoutedModelError({ status: 401 })).toBe(false)
    expect(isRetryableRoutedModelError({ statusCode: 403 })).toBe(false)
  })

  test('404 and 429 are retryable by design (the fallback switches to a different model)', () => {
    expect(isRetryableRoutedModelError({ status: 404 })).toBe(true)
    expect(isRetryableRoutedModelError({ status: 429 })).toBe(true)
  })

  test('5xx, network, and unclassified errors are retryable', () => {
    expect(isRetryableRoutedModelError({ status: 500 })).toBe(true)
    expect(isRetryableRoutedModelError({ status: 529 })).toBe(true)
    expect(isRetryableRoutedModelError(new Error('socket hang up'))).toBe(true)
    expect(isRetryableRoutedModelError(undefined)).toBe(true)
  })
})

describe('shouldDropPinForProviderSwap', () => {
  const routed: TurnRoutingDecision = {
    routed: true,
    model: 'mini',
    complexity: 'simple',
    reason: 'x',
    strongModel: 'main',
  }

  test('no pin -> never drop', () => {
    expect(shouldDropPinForProviderSwap(undefined, 'p1', 'p2')).toBe(false)
  })

  test('routed pin, same provider -> keep', () => {
    expect(shouldDropPinForProviderSwap(routed, 'p1', 'p1')).toBe(false)
  })

  test('routed pin, provider changed -> drop', () => {
    expect(shouldDropPinForProviderSwap(routed, 'p1', 'p2')).toBe(true)
  })

  test('no provider profiles (both undefined) -> keep', () => {
    expect(shouldDropPinForProviderSwap(routed, undefined, undefined)).toBe(false)
  })

  test('non-routed pin -> never drop', () => {
    expect(shouldDropPinForProviderSwap({ routed: false }, 'p1', 'p2')).toBe(false)
  })
})

describe('routing tally', () => {
  afterEach(() => resetRoutingTally())

  test('records decisions and escalations', () => {
    resetRoutingTally()
    recordRoutingDecision('simple')
    recordRoutingDecision('simple')
    recordRoutingDecision('strong')
    recordRoutingEscalation()
    expect(getRoutingTally()).toEqual({ simple: 2, strong: 1, escalations: 1 })
  })

  test('reset clears the tally', () => {
    recordRoutingDecision('simple')
    resetRoutingTally()
    expect(getRoutingTally()).toEqual({ simple: 0, strong: 0, escalations: 0 })
  })
})

describe('formatRoutingSummary', () => {
  test('null when nothing routed', () => {
    expect(formatRoutingSummary({ simple: 0, strong: 0, escalations: 0 })).toBeNull()
  })

  test('shows split and escalations', () => {
    const out = formatRoutingSummary({ simple: 5, strong: 2, escalations: 1 })
    expect(out).toContain('5 simple, 2 strong')
    expect(out).toContain('1 escalated to strong')
  })

  test('estimated savings line when both models priced and simple cheaper', () => {
    const out = formatRoutingSummary({ simple: 3, strong: 1, escalations: 0 }, {
      simpleInputCost: 1,
      strongInputCost: 5,
    })
    expect(out).toContain('~80% lower')
    // The estimate must disclose it is first-party reference pricing, not the
    // active provider's billed rate (jatmn P2).
    expect(out).toContain('first-party reference pricing')
    expect(out).toContain('may bill differently')
  })

  test('savings unavailable when a price is unknown', () => {
    const out = formatRoutingSummary({ simple: 3, strong: 1, escalations: 0 }, { strongInputCost: 5 })
    expect(out).toContain('Estimated savings unavailable')
    // The unavailable line must name first-party reference pricing as the source.
    expect(out).toContain('no first-party reference pricing')
  })

  test('notes no savings when simple is not cheaper', () => {
    const out = formatRoutingSummary({ simple: 3, strong: 1, escalations: 0 }, {
      simpleInputCost: 5,
      strongInputCost: 5,
    })
    expect(out).toContain('not cheaper')
    // The not-cheaper branch must carry the same first-party reference hedge.
    expect(out).toContain('first-party reference pricing')
    expect(out).toContain('may bill differently')
  })
})

describe('getRoutingSummaryForDisplay', () => {
  afterEach(() => resetRoutingTally())

  test('uses env-backed smart-routing roles for pricing display', () => {
    const previous = {
      OPENCLAUDE_SMART_ROUTING: process.env.OPENCLAUDE_SMART_ROUTING,
      OPENCLAUDE_SMART_ROUTING_SIMPLE: process.env.OPENCLAUDE_SMART_ROUTING_SIMPLE,
      OPENCLAUDE_SMART_ROUTING_STRONG: process.env.OPENCLAUDE_SMART_ROUTING_STRONG,
    }
    try {
      process.env.OPENCLAUDE_SMART_ROUTING = '1'
      process.env.OPENCLAUDE_SMART_ROUTING_SIMPLE = 'mini'
      process.env.OPENCLAUDE_SMART_ROUTING_STRONG = 'main'
      recordRoutingDecision('simple')
      const out = getRoutingSummaryForDisplay(
        settings({
          agentModels: { mini: { model: 'claude-haiku-4-5' }, main: { model: 'claude-opus-4-5' } },
        }),
      )
      expect(out).toContain('Smart routing: 1 simple, 0 strong')
      expect(out).toContain('first-party reference pricing')
      expect(out).not.toContain('Estimated savings unavailable')
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value == null) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})
