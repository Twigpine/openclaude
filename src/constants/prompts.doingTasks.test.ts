import { afterEach, beforeEach, expect, test } from 'bun:test'
import { withMockMacro } from 'src/test/mockMacro.js'
import { getSystemPrompt } from './prompts.js'

// getSystemPrompt returns a minimal prompt without the doing-tasks section
// when CLAUDE_CODE_SIMPLE is truthy — unset it so the test always exercises
// the full prompt path regardless of process-level state.
let originalSimple: string | undefined

beforeEach(() => {
  originalSimple = process.env.CLAUDE_CODE_SIMPLE
  delete process.env.CLAUDE_CODE_SIMPLE
})

afterEach(() => {
  if (originalSimple === undefined) {
    delete process.env.CLAUDE_CODE_SIMPLE
  } else {
    process.env.CLAUDE_CODE_SIMPLE = originalSimple
  }
})

test('coding system prompt includes the timing and wiring robustness guidance', async () => {
  const prompt = await withMockMacro(
    { ISSUES_EXPLAINER: 'report the issue at the tracker', VERSION: '0.0.0-test' },
    async () => (await getSystemPrompt([], 'test-model')).join('\n'),
  )

  // Focused assertions on the new "Doing tasks" guidance — not a full-prompt
  // snapshot, so unrelated prompt edits don't churn this test.
  expect(prompt).toContain(
    'derive timing-sensitive logic (animation, physics, timers) from actual elapsed time',
  )
  expect(prompt).toContain('Every element you introduce must be wired up')
})
