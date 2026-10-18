import { afterEach, describe, expect, test } from 'bun:test'

import type { Command } from '../../types/command.js'
import {
  formatCommandsWithinBudget,
  getCharBudget,
  MAX_CHAR_BUDGET,
} from './prompt.js'

const originalBudgetOverride = process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET

afterEach(() => {
  if (originalBudgetOverride === undefined) {
    delete process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET
  } else {
    process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET = originalBudgetOverride
  }
})

function createSkill(name: string, description: string): Command {
  return {
    type: 'prompt',
    name,
    description,
    progressMessage: `${name} progress`,
    contentLength: 0,
    source: 'plugin',
    loadedFrom: 'plugin',
    async getPromptForCommand() {
      return []
    },
  }
}

describe('SkillTool listing budget', () => {
  test('caps provider-derived budget for very large context windows', () => {
    expect(getCharBudget(2_000_000)).toBe(MAX_CHAR_BUDGET)
  })

  test('keeps smaller context windows below the hard cap proportional', () => {
    expect(getCharBudget(50_000)).toBe(2_000)
  })

  test('preserves explicit budget override for local testing', () => {
    process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET = '12000'

    expect(getCharBudget(2_000_000)).toBe(12_000)
  })

  test('does not allow huge context windows to keep every long description', () => {
    const longDescription = 'x'.repeat(220)
    const skills = Array.from({ length: 60 }, (_, i) =>
      createSkill(`skill-${i}`, longDescription),
    )

    const content = formatCommandsWithinBudget(skills, 2_000_000)

    expect(content).toContain('- skill-0')
    expect(content).not.toContain(longDescription)
  })

  test('supports lower listing caps while preserving skill names', () => {
    const skills = Array.from({ length: 24 }, (_, i) =>
      createSkill(`worker-skill-${i}`, `worker details ${'x'.repeat(120)}`),
    )

    const defaultContent = formatCommandsWithinBudget(skills, 200_000)
    const compactContent = formatCommandsWithinBudget(skills, 200_000, {
      maxCharBudget: 1_000,
    })

    expect(compactContent.length).toBeLessThan(defaultContent.length)
    expect(compactContent).toContain('- worker-skill-0')
    expect(compactContent).toContain('- worker-skill-23')
  })
})

describe('SkillTool listing budget with sibling-home skills', () => {
  function createUserSkill(
    name: string,
    description: string,
    siblingSkillsHome?: 'agents' | 'claude-code',
  ): Command {
    return {
      type: 'prompt',
      name,
      description,
      progressMessage: `${name} progress`,
      contentLength: 0,
      source: 'userSettings',
      loadedFrom: 'skills',
      siblingSkillsHome,
      async getPromptForCommand() {
        return []
      },
    }
  }

  test('lists sibling skills by name only before trimming OpenClaude skills', () => {
    // Fits the OpenClaude skills in full plus the sibling names, nothing more.
    process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET = '2100'
    const ownDescription = `own skill details ${'o'.repeat(60)}`
    const own = Array.from({ length: 5 }, (_, i) =>
      createUserSkill(`own-${i}`, ownDescription),
    )
    const siblings = Array.from({ length: 120 }, (_, i) =>
      createUserSkill(`sibling-${i}`, `sibling details ${'s'.repeat(80)}`, 'agents'),
    )

    const content = formatCommandsWithinBudget([...own, ...siblings])

    for (let i = 0; i < own.length; i++) {
      expect(content).toContain(`- own-${i}: ${ownDescription}`)
    }
    expect(content).toContain('- sibling-0\n')
    expect(content).toContain('- sibling-119')
    expect(content).not.toContain('sibling details')
  })

  test('gives sibling skills only the description space OpenClaude skills leave', () => {
    process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET = '400'
    const own = [createUserSkill('own-skill', `own ${'o'.repeat(100)}`)]
    const siblings = [
      createUserSkill('sib-a', `sibling a ${'a'.repeat(200)}`, 'agents'),
      createUserSkill('sib-b', `sibling b ${'b'.repeat(200)}`, 'claude-code'),
    ]

    const content = formatCommandsWithinBudget([...own, ...siblings])

    expect(content).toContain(`- own-skill: own ${'o'.repeat(100)}`)
    expect(content).toMatch(/- sib-a: sibling a a+…/)
    expect(content).toMatch(/- sib-b: sibling b b+…/)
    expect(content.length).toBeLessThanOrEqual(400)
  })

  test('trims OpenClaude skills only after sibling skills are names-only', () => {
    process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET = '300'
    const own = Array.from({ length: 4 }, (_, i) =>
      createUserSkill(`own-${i}`, `own ${'o'.repeat(150)}`),
    )
    const siblings = [createUserSkill('sib', `sibling ${'s'.repeat(150)}`, 'agents')]

    const content = formatCommandsWithinBudget([...own, ...siblings])

    expect(content).toContain('- sib')
    expect(content).not.toContain('sibling s')
    expect(content).toMatch(/- own-0: own o+…/)
  })

  test('keeps the default layout when no sibling skills are present', () => {
    process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET = '300'
    const own = Array.from({ length: 4 }, (_, i) =>
      createUserSkill(`own-${i}`, `own ${'o'.repeat(150)}`),
    )
    const withSiblingField = own.map(skill => ({
      ...skill,
      siblingSkillsHome: undefined,
    })) as Command[]

    expect(formatCommandsWithinBudget(withSiblingField)).toBe(
      formatCommandsWithinBudget(own),
    )
  })
})
