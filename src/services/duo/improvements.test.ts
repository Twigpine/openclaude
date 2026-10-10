import { describe, expect, test } from 'bun:test'
import {
  isEngineeringSkill,
} from '../../commands/duo/duo.js'
import { isFailedTurn, READ_ONLY_TOOLS, READ_TOOLS_MAX_TURNS } from './debate.js'
import { createDuoStats, formatDuoStats, recordTurn } from './types.js'

describe('read-only tools', () => {
  test('the whitelist is inspection only', () => {
    expect(READ_ONLY_TOOLS).toEqual(['Read', 'Glob', 'Grep'])
    expect(READ_ONLY_TOOLS).not.toContain('Bash')
    expect(READ_ONLY_TOOLS).not.toContain('Write')
    expect(READ_TOOLS_MAX_TURNS).toBeGreaterThan(1)
  })
})

describe('isFailedTurn', () => {
  test('each backend failure marker counts', () => {
    expect(isFailedTurn('(no reply received)')).toBe(true)
    expect(isFailedTurn('(API error: 401 no key)')).toBe(true)
    expect(isFailedTurn('(CLI error: timeout 180000ms)')).toBe(true)
  })

  test('a real answer does not count as failure', () => {
    expect(isFailedTurn('Sure — here is the plan')).toBe(false)
  })
})

describe('engineering filter for the router', () => {
  const skill = (name: string) => ({ name, description: 'd', file: `/x/${name}/SKILL.md` })

  test('workflow-only skills are excluded from routing', () => {
    for (const name of ['teach', 'handoff', 'wait-what', 'to-questionnaire', 'grill-me', 'ask-matt']) {
      expect(isEngineeringSkill(skill(name))).toBe(false)
    }
  })

  test('engineering skills are included', () => {
    for (const name of ['tdd', 'code-review', 'diagnosing-bugs', 'to-spec', 'implement-spec', 'wizard', 'grill-with-docs']) {
      expect(isEngineeringSkill(skill(name))).toBe(true)
    }
  })
})

describe('usage and timing', () => {
  test('usage accumulates per side with the elapsed time', () => {
    const stats = createDuoStats()
    recordTurn(stats, 'A', 'opening', { input: 10, output: 2, cost: 0 }, 1500)
    recordTurn(stats, 'A', 'debate', { input: 12, output: 3, cost: 0 }, 2500)
    recordTurn(stats, 'B', 'opening', { input: 9, output: 1, cost: 0 }, 900)
    expect(stats.usage.A).toEqual({ input: 22, output: 5, cost: 0 })
    expect(stats.usage.B).toEqual({ input: 9, output: 1, cost: 0 })
    expect(formatDuoStats(stats)).toContain('A 22 in / 5 out')
    expect(formatDuoStats(stats)).toContain('B 9 in / 1 out')
    expect(formatDuoStats(stats)).toContain('5 s')
  })

  test('a side that reports nothing says so instead of claiming zero', () => {
    const stats = createDuoStats()
    recordTurn(stats, 'A', 'opening', { input: 0, output: 0, cost: 0 }, 100)
    expect(formatDuoStats(stats)).toContain('A usage unknown')
  })
})
