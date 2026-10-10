import { describe, expect, test } from 'bun:test'
import {
  DuoAbortError,
  duoSystemPrompt,
  isDoubleConsensus,
  parseVerdict,
  READ_ONLY_TOOLS,
  READ_TOOLS_MAX_TURNS,
  runDebate,
} from './debate.js'
import { createDuoStats } from './types.js'

describe('duoSystemPrompt', () => {
  test('tools=none keeps turns single-shot and tool-less', () => {
    const text = duoSystemPrompt('A', false, 'none').join('\n')
    expect(text).toContain('You have NO tools')
    expect(text).not.toContain('You may inspect the project')
    expect(text).not.toContain('VERDICT:')
  })

  test('tools=read lists exactly the read-only tools', () => {
    const text = duoSystemPrompt('A', false, 'read').join('\n')
    expect(text).toContain(`You may inspect the project with ${READ_ONLY_TOOLS.join(', ')}`)
    expect(text).toContain('Never edit files, run commands')
    expect(READ_ONLY_TOOLS).toEqual(['Read', 'Glob', 'Grep'])
  })

  test('adversarial asks for the strongest counter-argument first', () => {
    const adversarial = duoSystemPrompt('B', false, 'none', 'adversarial').join('\n')
    expect(adversarial).toContain('strongest counter-argument')
    const neutral = duoSystemPrompt('B', false, 'none', 'neutral').join('\n')
    expect(neutral).not.toContain('strongest counter-argument')
  })

  test('read-only turns need more than one API round-trip', () => {
    expect(READ_TOOLS_MAX_TURNS).toBeGreaterThan(1)
  })
})

describe('parseVerdict', () => {
  test('finds CONSENSUS', () => {
    expect(parseVerdict('Agreed.\nVERDICT: CONSENSUS')).toBe('CONSENSUS')
  })

  test('finds SUITE', () => {
    expect(parseVerdict('Disagreed.\nVERDICT: SUITE')).toBe('SUITE')
  })

  test('is case-insensitive and tolerates spacing', () => {
    expect(parseVerdict('verdict:  consensus')).toBe('CONSENSUS')
  })

  test('returns null when absent', () => {
    expect(parseVerdict('no verdict line here')).toBeNull()
  })

  test('only the last verdict counts (quoting the peer)', () => {
    const text = 'You said VERDICT: CONSENSUS but I disagree.\nVERDICT: SUITE'
    expect(parseVerdict(text)).toBe('SUITE')
  })
})

describe('isDoubleConsensus', () => {
  test('both consensus → true', () => {
    expect(isDoubleConsensus('ok\nVERDICT: CONSENSUS', 'ok\nVERDICT: CONSENSUS')).toBe(
      true,
    )
  })

  test('mixed → false', () => {
    expect(isDoubleConsensus('ok\nVERDICT: CONSENSUS', 'no\nVERDICT: SUITE')).toBe(
      false,
    )
  })

  test('missing verdicts → false', () => {
    expect(isDoubleConsensus('ok', 'ok')).toBe(false)
  })
})

/** Deterministic ask stub: logs calls, replies by script. */
function stubAsk(script: Record<string, string>) {
  const calls: Array<{ side: string; incoming: string }> = []
  const ask = async (side: 'A' | 'B', incoming: string) => {
    calls.push({ side, incoming })
    const key = `${side}:${incoming}`
    return script[key] ?? `${side} reply to "${incoming}"`
  }
  return { calls, ask }
}

describe('abort handling', () => {
  test('a pre-aborted signal stops before any model call', async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    const ask = async () => {
      calls++
      return 'never'
    }
    await expect(
      runDebate({ question: 'Q', rounds: 2, protocol: false, ask, signal: controller.signal, stats: createDuoStats() }),
    ).rejects.toThrow(DuoAbortError)
    expect(calls).toBe(0)
  })

  test('aborting during the opening prevents the debate rounds', async () => {
    const controller = new AbortController()
    let calls = 0
    const ask = async () => {
      calls++
      // Side A aborts as soon as the opening turn is under way.
      if (calls === 1) controller.abort()
      return 'partial reply'
    }
    await expect(
      runDebate({ question: 'Q', rounds: 3, protocol: false, ask, signal: controller.signal, stats: createDuoStats() }),
    ).rejects.toThrow(DuoAbortError)
    expect(calls).toBe(2) // the parallel opening, nothing after it
  })

  test('aborting between rounds stops the loop', async () => {
    const controller = new AbortController()
    let calls = 0
    const ask = async () => {
      calls++
      if (calls === 2) controller.abort()
      return 'reply'
    }
    await expect(
      runDebate({ question: 'Q', rounds: 4, protocol: false, ask, signal: controller.signal, stats: createDuoStats() }),
    ).rejects.toThrow(DuoAbortError)
    expect(calls).toBe(2)
  })
})

describe('runDebate', () => {
  test('rounds=0 → opening answers only, both called in parallel', async () => {
    const { calls, ask } = stubAsk({})
    const result = await runDebate({
      question: 'Q',
      rounds: 0,
      protocol: false,
      ask,
      stats: createDuoStats(),
    })
    expect(result.stopReason).toBe('answers-only')
    expect(result.doubleConsensus).toBe(false)
    expect(result.entries.map(e => e.kind)).toEqual([
      'question',
      'answer',
      'answer',
    ])
    expect(calls).toEqual([
      { side: 'A', incoming: 'Q' },
      { side: 'B', incoming: 'Q' },
    ])
  })

  test('exchanges peer replies each round and exhausts rounds', async () => {
    const calls: Array<{ side: string; incoming: string }> = []
    const ask = async (side: 'A' | 'B', incoming: string) => {
      calls.push({ side, incoming })
      return `${side}<-${incoming}`
    }
    const result = await runDebate({
      question: 'Q',
      rounds: 2,
      protocol: false,
      ask,
      stats: createDuoStats(),
    })
    expect(result.stopReason).toBe('rounds-exhausted')
    // round 1: A sees B's opening, B sees A's opening
    expect(calls[2]).toEqual({ side: 'A', incoming: 'B<-Q' })
    expect(calls[3]).toEqual({ side: 'B', incoming: 'A<-Q' })
    // round 2: each side sees the peer's round-1 reply
    expect(calls[4]).toEqual({ side: 'A', incoming: 'B<-A<-Q' })
    expect(calls[5]).toEqual({ side: 'B', incoming: 'A<-B<-Q' })
    expect(result.entries).toHaveLength(1 + 2 + 4)
  })

  test('protocol off → no early stop even with consensus verdicts', async () => {
    const { ask } = stubAsk({
      'A:Q': 'a\nVERDICT: CONSENSUS',
      'B:Q': 'b\nVERDICT: CONSENSUS',
    })
    const result = await runDebate({
      question: 'Q',
      rounds: 1,
      protocol: false,
      ask,
      stats: createDuoStats(),
    })
    expect(result.stopReason).toBe('rounds-exhausted')
    expect(result.doubleConsensus).toBe(false)
  })

  test('protocol on → double consensus in the opening stops immediately', async () => {
    const { calls, ask } = stubAsk({
      'A:Q': 'a\nVERDICT: CONSENSUS',
      'B:Q': 'b\nVERDICT: CONSENSUS',
    })
    const result = await runDebate({
      question: 'Q',
      rounds: 3,
      protocol: true,
      ask,
      stats: createDuoStats(),
    })
    expect(result.stopReason).toBe('double-consensus')
    expect(result.doubleConsensus).toBe(true)
    expect(calls).toHaveLength(2) // no debate round happened
  })

  test('protocol on → SUITE keeps the debate going until consensus', async () => {
    let round = 0
    const ask = async (side: 'A' | 'B', incoming: string) => {
      if (incoming === 'Q') return `${side} opening`
      round++
      // round 1: disagree; round 2: both agree
      return `${side} r${round}\nVERDICT: ${round >= 2 ? 'CONSENSUS' : 'SUITE'}`
    }
    const result = await runDebate({
      question: 'Q',
      rounds: 5,
      protocol: true,
      ask,
      stats: createDuoStats(),
    })
    expect(result.stopReason).toBe('double-consensus')
    expect(result.doubleConsensus).toBe(true)
    // opening + exactly 2 debate rounds (4 ask calls) = 5 total, not 5 rounds
    expect(result.entries.filter(e => e.kind === 'debate')).toHaveLength(4)
  })
})
