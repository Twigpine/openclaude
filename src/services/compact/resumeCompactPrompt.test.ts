import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const realTokens = {
  ...await import(`../../utils/tokens.js?real=${Date.now()}-${Math.random()}`),
}
const realAutoCompact = {
  ...await import(`./autoCompact.js?real=${Date.now()}-${Math.random()}`),
}

async function importResumeCompactPrompt() {
  mock.restore()
  const nonce = `${Date.now()}-${Math.random()}`
  return import(`./resumeCompactPrompt.ts?test=${nonce}`)
}

describe('shouldPromptCompactOnResume', () => {
  const fakeModel = 'claude-sonnet-4-20250514'

  beforeEach(() => {
    mock.restore()
  })

  afterEach(() => {
    mock.restore()
    mock.module('../../utils/tokens.js', () => realTokens)
    mock.module('./autoCompact.js', () => realAutoCompact)
  })

  test('returns false for empty messages', async () => {
    const { shouldPromptCompactOnResume } = await importResumeCompactPrompt()
    expect(shouldPromptCompactOnResume([], fakeModel, false)).toBe(false)
  })

  test('returns false for non-interactive sessions', async () => {
    const { shouldPromptCompactOnResume } = await importResumeCompactPrompt()
    const messages = Array.from({ length: 20 }, (_, i) => ({ id: i }))
    expect(shouldPromptCompactOnResume(messages, fakeModel, true)).toBe(false)
  })

  test('returns false when token count is below 70% threshold', async () => {
    // Mock: 5 messages * 100 tokens = 500
    // Threshold: 1000 * 0.7 = 700
    mock.module('../../utils/tokens.js', () => ({
      tokenCountWithEstimation: (msgs: unknown[]) => msgs.length * 100,
    }))
    mock.module('./autoCompact.js', () => ({
      getAutoCompactThreshold: () => 1000,
    }))

    const { shouldPromptCompactOnResume } = await importResumeCompactPrompt()
    const messages = Array.from({ length: 5 }, (_, i) => ({ id: i }))
    expect(shouldPromptCompactOnResume(messages, fakeModel, false)).toBe(false)
  })

  test('returns true when token count exceeds 70% threshold', async () => {
    mock.module('../../utils/tokens.js', () => ({
      tokenCountWithEstimation: (msgs: unknown[]) => msgs.length * 100,
    }))
    mock.module('./autoCompact.js', () => ({
      getAutoCompactThreshold: () => 1000,
    }))

    const { shouldPromptCompactOnResume } = await importResumeCompactPrompt()
    // 8 * 100 = 800 > 700
    const messages = Array.from({ length: 8 }, (_, i) => ({ id: i }))
    expect(shouldPromptCompactOnResume(messages, fakeModel, false)).toBe(true)
  })

  test('returns true when token count exactly equals threshold', async () => {
    mock.module('../../utils/tokens.js', () => ({
      tokenCountWithEstimation: (msgs: unknown[]) => msgs.length * 100,
    }))
    mock.module('./autoCompact.js', () => ({
      getAutoCompactThreshold: () => 1000,
    }))

    const { shouldPromptCompactOnResume } = await importResumeCompactPrompt()
    // 7 * 100 = 700 == 700
    const messages = Array.from({ length: 7 }, (_, i) => ({ id: i }))
    expect(shouldPromptCompactOnResume(messages, fakeModel, false)).toBe(true)
  })
})
