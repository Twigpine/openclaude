import { afterEach, expect, test } from 'bun:test'

import { clearBundledSkills, getBundledSkills } from '../bundledSkills.js'
import { registerAutoModeSetupSkill } from './autoModeSetup.js'

afterEach(() => {
  clearBundledSkills()
})

test('auto-mode-setup prompt asks for confirmation before any settings write', async () => {
  registerAutoModeSetupSkill()

  const skill = getBundledSkills().find(
    command => command.name === 'auto-mode-setup',
  )
  expect(skill).toBeDefined()
  // getPromptForCommand only exists on the PromptCommand variant; narrow first.
  if (skill?.type !== 'prompt') {
    throw new Error(`expected prompt command, got ${skill?.type}`)
  }

  const blocks = await skill.getPromptForCommand('', {} as never)
  expect(blocks.length).toBeGreaterThan(0)
  expect(blocks[0]).toMatchObject({ type: 'text' })
  const prompt = (blocks[0] as { text: string }).text

  const confirmIndex = prompt.indexOf('wait for explicit confirmation')
  const writeIndex = prompt.indexOf('merge it into a local settings file')
  expect(confirmIndex).toBeGreaterThanOrEqual(0)
  expect(writeIndex).toBeGreaterThanOrEqual(0)
  // The confirmation instruction must precede the write step.
  expect(confirmIndex).toBeLessThan(writeIndex)

  // The guardrails against enabling auto mode or editing other settings stay.
  expect(prompt).toContain(
    'Do not enable auto mode, do not change defaultMode, do not touch allow/deny/ask rule lists.',
  )
  expect(prompt).toContain('Never write it to `.openclaude/settings.json`')
})
