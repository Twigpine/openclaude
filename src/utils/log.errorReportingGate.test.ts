import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getGlobalConfig, saveGlobalConfig } from './config.js'
import { getInMemoryErrors, logError } from './log.js'

// Regression for the privacy gate in logError(): a Gemini Vertex session must
// get no-error-reporting treatment whether it routes via the env flag OR a
// saved active profile (effective-provider check), so a saved-profile-only
// Vertex session does not leak errors to the in-memory/reporting sink.
describe('logError error-reporting gate — Gemini Vertex effective provider', () => {
  // Provider-selection flags plus every other env input the logError() gate
  // reads (DISABLE_ERROR_REPORTING and the essential-traffic switch), so the
  // control case is hermetic and does not depend on leaked CI state.
  const GATING_ENV = [
    'CLAUDE_CODE_USE_GEMINI_VERTEX',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_OPENAI',
    'CLAUDE_CODE_USE_GEMINI',
    'CLAUDE_CODE_USE_MISTRAL',
    'CLAUDE_CODE_USE_GITHUB',
    'DISABLE_ERROR_REPORTING',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'DISABLE_TELEMETRY',
  ]
  const savedEnv: Record<string, string | undefined> = {}
  let restoreConfig: ReturnType<typeof getGlobalConfig>

  beforeEach(() => {
    for (const key of GATING_ENV) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    restoreConfig = structuredClone(getGlobalConfig())
  })

  afterEach(() => {
    saveGlobalConfig(() => restoreConfig)
    for (const key of GATING_ENV) {
      if (savedEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = savedEnv[key]
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
