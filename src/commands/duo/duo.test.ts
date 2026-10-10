import { describe, expect, test } from 'bun:test'
import {
  formatDuoResult,
  formatFreeModels,
  isValidModelId,
  parseDuoInput,
  resolveDuoModel,
  summarizeVerdicts,
  type DuoInput,
} from './duo.js'
import {
  KNOWN_BAD_MODELS,
  RATE_LIMITED_MODELS,
} from '../../services/duo/freeModels.js'
import { createDuoState } from '../../services/duo/types.js'

/** Narrow a parse result to its optional error field. */
function errOf(input: DuoInput): string | undefined {
  return 'error' in input ? input.error : undefined
}

describe('parseDuoInput', () => {
  test('empty → status', () => {
    expect(parseDuoInput('')).toEqual({ verb: 'status' })
    expect(parseDuoInput('   ')).toEqual({ verb: 'status' })
  })

  test('status / clear', () => {
    expect(parseDuoInput('status').verb).toBe('status')
    expect(parseDuoInput('clear').verb).toBe('clear')
  })

  test('a question starting with a verb is a question, not a subcommand', () => {
    expect(parseDuoInput('status of my auth flow?')).toEqual({
      verb: 'run',
      question: 'status of my auth flow?',
    })
    expect(parseDuoInput('models are stale again')).toEqual({
      verb: 'run',
      question: 'models are stale again',
    })
    expect(parseDuoInput('clear the cache please')).toEqual({
      verb: 'run',
      question: 'clear the cache please',
    })
  })

  test('model id validation rejects flag-shaped input', () => {
    expect(isValidModelId('opencode/space-bunny-free')).toBe(true)
    expect(isValidModelId('cline-free/muse-spark-1.3-contributor')).toBe(true)
    expect(isValidModelId('-rf')).toBe(false)
    expect(isValidModelId('--auto')).toBe(false)
    expect(isValidModelId('has space')).toBe(false)
    expect(errOf(parseDuoInput('model b --auto'))).toContain('invalid model id')
  })

  test('/duo model <side> without an id is a usage error', () => {
    expect(errOf(parseDuoInput('model a'))).toContain('usage: /duo model a')
    expect(errOf(parseDuoInput('model b'))).toContain('usage: /duo model b')
  })

  test('rounds valid', () => {
    expect(parseDuoInput('rounds 3')).toEqual({ verb: 'rounds', rounds: 3 })
    expect(parseDuoInput('rounds 0')).toEqual({ verb: 'rounds', rounds: 0 })
  })

  test('rounds invalid → error', () => {
    expect(errOf(parseDuoInput('rounds abc'))).toContain('rounds must be')
    expect(errOf(parseDuoInput('rounds 99'))).toContain('rounds must be')
    expect(errOf(parseDuoInput('rounds'))).toContain('rounds must be')
  })

  test('protocol on/off', () => {
    expect(parseDuoInput('protocol on')).toEqual({
      verb: 'protocol',
      on: true,
    })
    expect(parseDuoInput('protocol off')).toEqual({
      verb: 'protocol',
      on: false,
    })
    expect(errOf(parseDuoInput('protocol maybe'))).toContain('protocol on|off')
  })

  test('model with side', () => {
    expect(parseDuoInput('model a openai/gpt-4o')).toEqual({
      verb: 'model',
      side: 'A',
      model: 'openai/gpt-4o',
    })
    expect(parseDuoInput('model b some-model')).toEqual({
      verb: 'model',
      side: 'B',
      model: 'some-model',
    })
  })

  test('model without side → side B', () => {
    expect(parseDuoInput('model some-model')).toEqual({
      verb: 'model',
      side: 'B',
      model: 'some-model',
    })
  })

  test('auto on|off (automatic skill routing)', () => {
    expect(parseDuoInput('auto on')).toEqual({ verb: 'auto', on: true })
    expect(parseDuoInput('auto off')).toEqual({ verb: 'auto', on: false })
    expect(errOf(parseDuoInput('auto maybe'))).toContain('auto on|off')
  })

  test('tools on/off controls grounded inspection', () => {
    expect(parseDuoInput('tools on')).toEqual({ verb: 'grounded', on: true })
    expect(parseDuoInput('tools off')).toEqual({ verb: 'grounded', on: false })
    expect(errOf(parseDuoInput('tools maybe'))).toContain('tools on|off')
  })

  test('mode adversarial|neutral', () => {
    expect(parseDuoInput('mode adversarial')).toEqual({ verb: 'adversarial', on: true })
    expect(parseDuoInput('mode neutral')).toEqual({ verb: 'adversarial', on: false })
    expect(errOf(parseDuoInput('mode wild'))).toContain('adversarial|neutral')
  })

  test('backend builtin|cli', () => {
    expect(parseDuoInput('backend cli')).toEqual({
      verb: 'backend',
      backend: 'cli',
    })
    expect(parseDuoInput('backend builtin')).toEqual({
      verb: 'backend',
      backend: 'builtin',
    })
    expect(errOf(parseDuoInput('backend wat'))).toContain('builtin|cli')
  })

  test('approve on|off', () => {
    expect(parseDuoInput('approve on')).toEqual({ verb: 'approve', on: true })
    expect(parseDuoInput('approve off')).toEqual({ verb: 'approve', on: false })
    expect(errOf(parseDuoInput('approve maybe'))).toContain('approve on|off')
  })

  test('models lists the free catalogue', () => {
    expect(parseDuoInput('models')).toEqual({ verb: 'models' })
  })

  test('the models listing separates busy models from broken ones', () => {
    const out = formatFreeModels()
    // A 429 is the free tier working, so those ids stay in the usable list and
    // are only called out as rate-limited.
    for (const [model] of RATE_LIMITED_MODELS) {
      expect(out).toContain(`rate-limited at the last probe`)
      expect(out).toContain(model)
      const badSection = out.slice(out.indexOf('known-bad (probe failures)'))
      expect(badSection).not.toContain(model)
    }
    // A 404 means the id never existed upstream; retrying cannot fix it, so
    // those belong in known-bad and nowhere else.
    for (const [model] of KNOWN_BAD_MODELS) {
      expect(out.slice(out.indexOf('known-bad (probe failures)'))).toContain(model)
    }
  })

  test('skills lists installed skills', () => {
    expect(parseDuoInput('skills')).toEqual({ verb: 'skills' })
  })

  test('skill <name> <question> splits name from question', () => {
    expect(parseDuoInput('skill tdd design the parser tests')).toEqual({
      verb: 'skill',
      skill: 'tdd',
      question: 'design the parser tests',
    })
  })

  test('skill without name or question → usage error', () => {
    expect(errOf(parseDuoInput('skill'))).toContain('usage:')
    expect(errOf(parseDuoInput('skill tdd'))).toContain('usage: /duo skill tdd')
  })

  test('model missing id → usage error', () => {
    expect(errOf(parseDuoInput('model'))).toContain('usage:')
    expect(errOf(parseDuoInput('model a b c'))).toContain('usage:')
  })

  test('anything else is the debate question', () => {
    expect(parseDuoInput('is Rust better than Go?')).toEqual({
      verb: 'run',
      question: 'is Rust better than Go?',
    })
    // multi-word questions keep their full text
    expect(parseDuoInput('roundabout status of my server')).toEqual({
      verb: 'run',
      question: 'roundabout status of my server',
    })
  })
})

describe('resolveDuoModel', () => {
  const st = createDuoState()

  test('both null → session default for A, same as A for B', () => {
    expect(resolveDuoModel('A', st, 'session-model')).toBe('session-model')
    expect(resolveDuoModel('B', st, 'session-model')).toBe('session-model')
  })

  test('modelA set → B follows A unless modelB set', () => {
    const withA = { ...st, modelA: 'model-x' }
    expect(resolveDuoModel('A', withA, 'session-model')).toBe('model-x')
    expect(resolveDuoModel('B', withA, 'session-model')).toBe('model-x')
    const withBoth = { ...st, modelA: 'model-x', modelB: 'model-y' }
    expect(resolveDuoModel('A', withBoth, 'session-model')).toBe('model-x')
    expect(resolveDuoModel('B', withBoth, 'session-model')).toBe('model-y')
  })

  test('only modelB set → A stays session default', () => {
    const onlyB = { ...st, modelB: 'model-y' }
    expect(resolveDuoModel('A', onlyB, 'session-model')).toBe('session-model')
    expect(resolveDuoModel('B', onlyB, 'session-model')).toBe('model-y')
  })
})

describe('summarizeVerdicts', () => {
  /** Build a realistic alternating transcript: question, then A/B, A/B, … */
  const verdicts = (texts: string[]) => {
    const built = texts.map((text, i) => {
      const side = i % 2 === 1 ? 'A' : 'B'
      const round = i === 0 ? 0 : Math.floor(i / 2)
      const kind = i === 0 ? 'question' : round === 0 ? 'answer' : 'debate'
      return {
        kind: kind as 'question' | 'answer' | 'debate',
        round,
        side: side as 'A' | 'B',
        text,
      }
    })
    return {
      entries: built,
      stopReason: 'rounds-exhausted' as const,
      doubleConsensus: false,
    }
  }

  test('counts CI/CO per side and shows the raw sequence', () => {
    const result = verdicts([
      'the question',
      'ok\nVERDICT: CONSENSUS', // A
      'ok\nVERDICT: SUITE', // B
      'ok\nVERDICT: SUITE', // A
      'ok\nVERDICT: CONSENSUS', // B
      'ok\nVERDICT: CONSENSUS', // A
    ])
    const summary = summarizeVerdicts(result)
    expect(summary).toContain('A 2/3 CI')
    expect(summary).toContain('B 1/2 CI')
    expect(summary).toContain('CI CO CO CI CI')
  })

  test('no verdict at all → empty', () => {
    expect(summarizeVerdicts(verdicts(['question', 'plain answer']))).toBe('')
  })

  test('a refusal in round 1 stays visible as CO', () => {
    const result = verdicts([
      'question',
      'yes\nVERDICT: CONSENSUS', // A
      'no\nVERDICT: SUITE', // B
      'ok\nVERDICT: CONSENSUS', // A
      'ok\nVERDICT: CONSENSUS', // B
    ])
    const summary = summarizeVerdicts(result)
    expect(summary).toContain('B 1/2 CI')
    expect(summary).toContain('CO')
    expect(summary).toContain('CI CO CI CI')
  })
})

describe('formatDuoResult', () => {
  const result = {
    entries: [
      { kind: 'question' as const, round: 0, side: 'A' as const, text: 'Q?' },
      { kind: 'answer' as const, round: 0, side: 'A' as const, text: 'answer A' },
      { kind: 'answer' as const, round: 0, side: 'B' as const, text: 'answer B' },
      {
        kind: 'debate' as const,
        round: 1,
        side: 'B' as const,
        text: 'B replies',
      },
    ],
    stopReason: 'double-consensus' as const,
    doubleConsensus: true,
  }

  test('contains header, labels and stop reason', () => {
    const out = formatDuoResult(result, {
      rounds: 2,
      protocol: true,
      modelA: 'model-a',
      modelB: 'model-b',
    })
    expect(out).toContain('duo · A=model-a · B=model-b · rounds 2 · protocol on')
    expect(out).toContain('── question ──')
    expect(out).toContain('── answer A ──')
    expect(out).toContain('── answer B ──')
    expect(out).toContain('── B → A · round 1 ──')
    expect(out).toContain('✓ double CONSENSUS — both debaters converged (the debate stopped early)')
  })

  test('rounds-exhausted footer', () => {
    const out = formatDuoResult(
      { ...result, stopReason: 'rounds-exhausted', doubleConsensus: false },
      { rounds: 2, protocol: false, modelA: 'a', modelB: 'b' },
    )
    expect(out).toContain('2 debate round(s) completed')
  })
})
