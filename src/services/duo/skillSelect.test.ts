import { describe, expect, test } from 'bun:test'
import {
  buildSelectionPrompt,
  MAX_AUTO_SKILLS,
  parseSkillSelection,
  keywordRoute,
  selectSkills,
  SKILL_ROUTER_SYSTEM,
} from './skillSelect.js'
import type { DuoSkillInfo } from './skills.js'

const skills: DuoSkillInfo[] = [
  { name: 'tdd', description: 'Test-driven development.', file: '/a/tdd/SKILL.md' },
  { name: 'code-review', description: 'Review a diff.', file: '/a/cr/SKILL.md' },
  { name: 'grilling', description: 'Interview the user.', file: '/a/gm/SKILL.md' },
]

const names = skills.map(s => s.name)

describe('parseSkillSelection — the router must be able to abstain', () => {
  test('a bare catalogue name is accepted', () => {
    expect(parseSkillSelection('tdd', names)).toEqual(['tdd'])
    expect(parseSkillSelection('tdd, code-review', names)).toEqual([
      'tdd',
      'code-review',
    ])
  })

  test('prose is not a selection', () => {
    // Measured failure (eval_router.py --live, 2026-10-10): the router answered
    // "I think tdd is the best fit here, and to-tickets could also help" and
    // scanning for known names anywhere in the text selected both. A debate
    // injects the selected text into *both* debaters, so the second pick costs
    // double. Rejecting the answer is now cheap: selectSkills falls back to
    // keyword routing and the header says so.
    expect(parseSkillSelection('tdd is the best fit here', names)).toEqual([])
    expect(
      parseSkillSelection(
        'I think tdd is the best fit here, and code-review could also help.',
        names,
      ),
    ).toEqual([])
    // Later lines are commentary after the answer, not more selection.
    expect(parseSkillSelection('tdd\nAlso consider code-review.', names)).toEqual([
      'tdd',
    ])
  })

  test('NONE abstains', () => {
    expect(parseSkillSelection('NONE', names)).toEqual([])
    expect(parseSkillSelection('none | low', names)).toEqual([])
  })

  test('a confidence marker makes the answer prose, so it abstains', () => {
    // The zero-recall lesson was about *demanding* a rigid marker in the
    // prompt, which made free models abstain on everything. Tolerating one on
    // the way back in is a different axis — but it is the same tell that the
    // answer was not a clean selection.
    expect(parseSkillSelection('tdd | low', names)).toEqual([])
  })

  test('hedging abstains', () => {
    expect(parseSkillSelection('tdd maybe', names)).toEqual([])
    expect(parseSkillSelection('not sure, perhaps code-review', names)).toEqual([])
  })

  test('an answer naming no catalogue skill abstains', () => {
    expect(parseSkillSelection('I have no idea what to use', names)).toEqual([])
  })

  test('unknown names abstain', () => {
    expect(parseSkillSelection('grok | high', names)).toEqual([])
  })

  test('caps at two skills and de-duplicates', () => {
    expect(parseSkillSelection('tdd, tdd, grilling | high', names)).toEqual([
      'tdd',
      'grilling',
    ])
  })

  test('empty answer abstains', () => {
    expect(parseSkillSelection('   ', names)).toEqual([])
  })
})

describe('SKILL_ROUTER_SYSTEM', () => {
  test('demands one line and an explicit NONE', () => {
    const text = SKILL_ROUTER_SYSTEM.join('\n')
    expect(text).toContain('NONE')
    expect(text).toContain('skill-name')
    expect(text).toContain('clearly applies to this exact task')
  })
})

describe('buildSelectionPrompt', () => {
  test('states the abstention rule next to the catalogue', () => {
    const prompt = buildSelectionPrompt('review my PR', skills)
    expect(prompt).toContain('- tdd: Test-driven development.')
    expect(prompt).toContain('Answer NONE unless a skill is clearly and specifically')
    expect(prompt).toContain('review my PR')
  })
})
describe('selectSkills', () => {
  const skill = (name: string, description = 'd') => ({
    name,
    description,
    file: `/x/${name}/SKILL.md`,
  })
  const skills = [skill('tdd'), skill('code-review'), skill('grilling')]
  const names = skills.map(s => s.name)

  test('returns the router pick', async () => {
    const routed = await selectSkills({
      question: 'review this diff',
      skills,
      ask: async () => 'code-review',
    })
    expect(routed.names).toEqual(['code-review'])
    expect(routed.error).toBeUndefined()
  })

  test('a chatty answer falls back to keywords instead of dead-ending', async () => {
    const routed = await selectSkills({
      question: 'review this diff',
      skills,
      ask: async () => 'I would use code-review here, it seems like a good fit.',
    })
    // Same outcome as a 429: routed, and labelled as the deterministic path so
    // it never reads as a model decision.
    expect(routed.names).toEqual(['code-review'])
    expect(routed.via).toBe('keywords')
    expect(routed.fallbackReason).toContain('router answered:')
    expect(routed.error).toBeUndefined()
  })

  test('a silent router is a failure, not an abstention', async () => {
    // Measured 2026-10-10: pointing the whole debate at a model that 404s made
    // every question abstain cleanly, with no warning anywhere. Silence and a
    // deliberate NONE are not the same event, and only one of them is a
    // decision the router actually made.
    const routed = await selectSkills({
      question: 'review this diff',
      skills,
      ask: async () => '',
    })
    expect(routed.fallbackReason).toContain('router returned nothing')
    // Keywords still cover it, so the debate keeps working and stays labelled.
    expect(routed.via).toBe('keywords')
    expect(routed.error).toBeUndefined()
  })

  test('an empty answer with no keyword match still reports the failure', async () => {
    const routed = await selectSkills({
      question: 'what time is it',
      skills,
      ask: async () => '   ',
    })
    expect(routed.names).toEqual([])
    expect(routed.error).toContain('router returned nothing')
  })

  test('a chatty answer with nothing to fall back on still reports why', async () => {
    const routed = await selectSkills({
      question: 'what time is it',
      skills,
      ask: async () => 'I am not sure what you mean by that.',
    })
    expect(routed.names).toEqual([])
    expect(routed.error).toContain('router answered:')
  })

  test('an explicit NONE is a decision, not an error', async () => {
    const routed = await selectSkills({
      question: 'say hello',
      skills,
      ask: async () => 'NONE',
    })
    expect(routed.names).toEqual([])
    expect(routed.error).toBeUndefined()
  })

  test('no skills installed → no routing call', async () => {
    let called = false
    const routed = await selectSkills({
      question: 'anything',
      skills: [],
      ask: async () => {
        called = true
        return 'tdd'
      },
    })
    expect(routed.names).toEqual([])
    expect(routed.error).toContain('no skill installed')
    expect(called).toBe(false)
  })

  test('a failing router reports why instead of looking like an abstention', async () => {
    const routed = await selectSkills({
      question: 'anything',
      skills,
      ask: async () => {
        throw new Error('Rate limit exceeded 429')
      },
    })
    expect(routed.names).toEqual([])
    // The measured failure: a rate-limited free provider made every route look
    // like a deliberate NONE while the feature was dead. The fallback ran and
    // the header says so.
    expect(routed.error).toBeUndefined()
    expect(routed.via).toBe('keywords')
    expect(routed.fallbackReason).toContain('Rate limit exceeded 429')
  })

  test('an answer naming nothing reports what it said', async () => {
    const routed = await selectSkills({
      question: 'anything',
      skills,
      ask: async () => 'I have no idea what to use',
    })
    expect(routed.names).toEqual([])
    expect(routed.error).toContain('router answered')
  })

  test('answers are trimmed before parsing', () => {
    expect(parseSkillSelection('  tdd  ', names)).toEqual(['tdd'])
  })
})

describe('keywordRoute — deterministic fallback, no model call', () => {
  const skill = (name: string, description: string) => ({
    name,
    description,
    file: `/x/${name}/SKILL.md`,
  })
  const skills = [
    skill('tdd', 'Test-driven development. Red-green-refactor for features and bugs.'),
    skill('code-review', 'Review a diff since a fixed point along two axes.'),
    skill('diagnosing-bugs', 'Diagnosis loop for hard bugs and performance regressions.'),
    skill('teach', 'Teach the user a new skill or concept over multiple sessions.'),
  ]

  test('routes a code question to the matching skill', () => {
    expect(keywordRoute('Our CI is flaky and slow; where should we start?', skills)).toEqual([
      'diagnosing-bugs',
    ])
    expect(keywordRoute('How should we slice this refactor into tests first?', skills)).toEqual([
      'tdd',
    ])
  })

  test('abstains on a question with no matching skill', () => {
    expect(keywordRoute('Say hello in one word.', skills)).toEqual([])
    expect(keywordRoute('What is 2+2?', skills)).toEqual([])
  })

  test('a workflow question does not recruit a code skill', () => {
    expect(keywordRoute('Teach me how to use git properly', skills)).toEqual(['teach'])
  })

  test('selectSkills falls back to keywords when the model router fails', async () => {
    const routed = await selectSkills({
      question: 'Our CI is flaky and slow; where should we start?',
      skills,
      ask: async () => {
        throw new Error('Rate limit exceeded 429')
      },
    })
    expect(routed.names).toEqual(['diagnosing-bugs'])
    expect(routed.via).toBe('keywords')
    expect(routed.fallbackReason).toContain('Rate limit exceeded 429')
  })

  test('an explicit NONE stays clean even when the model is down', async () => {
    const routed = await selectSkills({
      question: 'Say hello in one word.',
      skills,
      ask: async () => {
        throw new Error('Rate limit exceeded 429')
      },
    })
    expect(routed.names).toEqual([])
    expect(routed.error).toBeUndefined()
    // The header says which path was used, so a fallback never reads as a
    // model decision.
    expect(routed.via).toBe('keywords')
  })
})
