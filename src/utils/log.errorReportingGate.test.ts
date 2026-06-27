import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getGlobalConfig, saveGlobalConfig } from './config.js'
import { getInMemoryErrors, logError } from './log.js'

// Regression for the privacy gate in logError(): a Gemini Vertex session must
// get no-error-reporting treatment whether it routes via the env flag OR a
// saved active profile (effective-provider check), so a saved-profile-only
// Vertex session does not leak errors to the in-memory/reporting sink.
describe('logError error-reporting gate — Gemini Vertex effective provider', () => {
  const PROVIDER_FLAGS = [
    'CLAUDE_CODE_USE_GEMINI_VERTEX',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_OPENAI',
    'CLAUDE_CODE_USE_GEMINI',
    'CLAUDE_CODE_USE_MISTRAL',
    'CLAUDE_CODE_USE_GITHUB',
  ]
  const savedFlags: Record<string, string | undefined> = {}
  let restoreConfig: ReturnType<typeof getGlobalConfig>

  beforeEach(() => {
    for (const flag of PROVIDER_FLAGS) {
      savedFlags[flag] = process.env[flag]
      delete process.env[flag]
    }
    restoreConfig = getGlobalConfig()
  })

  afterEach(() => {
    saveGlobalConfig(() => restoreConfig)
    for (const flag of PROVIDER_FLAGS) {
      if (savedFlags[flag] === undefined) {
        delete process.env[flag]
      } else {
        process.env[flag] = savedFlags[flag]
      }
    }
  })

  function recorded(marker: string): boolean {
    return getInMemoryErrors().some(entry => entry.error.includes(marker))
  }

  test('records errors when not routing to a cloud provider (control)', () => {
    saveGlobalConfig(current => ({
      ...current,
      providerProfiles: [],
      activeProviderProfileId: undefined,
    }))
    const marker = `gate-control-${Date.now()}`
    logError(new Error(marker))
    expect(recorded(marker)).toBe(true)
  })

  test('suppresses errors for a saved-profile-only Gemini Vertex session', () => {
    // No CLAUDE_CODE_USE_GEMINI_VERTEX flag — routing comes purely from the
    // saved active profile, just like getAnthropicClient.
    saveGlobalConfig(current => ({
      ...current,
      providerProfiles: [
        {
          id: 'saved_vertex',
          name: 'Saved Vertex',
          provider: 'gemini-vertex',
          baseUrl: 'saved-proj',
          model: 'gemini-2.5-pro',
        },
      ],
      activeProviderProfileId: 'saved_vertex',
    }))
    const marker = `gate-vertex-${Date.now()}`
    logError(new Error(marker))
    expect(recorded(marker)).toBe(false)
  })
})
