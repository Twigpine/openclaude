import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { getInMemoryErrors, logError } from './log.js'
import * as providerProfilesModule from './providerProfiles.js'

// Regression for the privacy gate in logError(): a Gemini Vertex session must
// get no-error-reporting treatment whenever isGeminiVertexEffectiveProvider()
// reports Vertex routing (env flag OR a saved active profile), so a
// saved-profile-only Vertex session does not leak errors to the in-memory/
// reporting sink.
//
// The gate is stubbed at isGeminiVertexEffectiveProvider() rather than by
// mutating the shared global config: another test file in the same process can
// leave a leaked mock.module('./config.js') installed (bun's mock.restore() does
// NOT revert mock.module()), which silently turns a saveGlobalConfig()-based
// setup into a no-op and makes these assertions order-dependent. The
// profile -> effective-provider derivation itself is covered directly in
// providerProfiles.test.ts.
describe('logError error-reporting gate — Gemini Vertex effective provider', () => {
  // Every other env input the logError() gate reads (provider-selection flags
  // plus DISABLE_ERROR_REPORTING and the essential-traffic switches), so the
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
  let gateSpy: ReturnType<typeof spyOn> | undefined

  beforeEach(() => {
    for (const key of GATING_ENV) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    gateSpy?.mockRestore()
    gateSpy = undefined
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
    gateSpy = spyOn(
      providerProfilesModule,
      'isGeminiVertexEffectiveProvider',
    ).mockReturnValue(false)
    const marker = `gate-control-${Date.now()}`
    logError(new Error(marker))
    expect(recorded(marker)).toBe(true)
  })

  test('suppresses errors for a saved-profile-only Gemini Vertex session', () => {
    // isGeminiVertexEffectiveProvider() reports Vertex routing derived from the
    // saved active profile (no env flag); logError must then suppress reporting.
    gateSpy = spyOn(
      providerProfilesModule,
      'isGeminiVertexEffectiveProvider',
    ).mockReturnValue(true)
    const marker = `gate-vertex-${Date.now()}`
    logError(new Error(marker))
    expect(recorded(marker)).toBe(false)
  })
})
