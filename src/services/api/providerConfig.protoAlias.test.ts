import { describe, expect, test } from 'bun:test'
import {
  getReasoningEffortForModel,
  isCodexAlias,
  resolveProviderRequest,
  shouldUseCodexTransport,
  supportsCodexReasoningEffort,
} from './providerConfig.js'

// Regression: CODEX_ALIAS_MODELS is a plain object literal, and the alias
// lookups keyed it with a config/CLI-controlled model string. Names inherited
// from Object.prototype resolved through the prototype chain, so `key in map`
// and `map[key]` reported a match for strings that are NOT Codex aliases. That
// made `isCodexAlias('constructor')` return true and, with no explicit base
// URL, `shouldUseCodexTransport` misroute the request through the Codex
// transport. The lookups must only see own enumerable aliases.
//
// The lookups lower-case the model string first, so the reachable inherited
// keys are the ones that are already all-lowercase: `constructor` and
// `__proto__`. (`toString`/`valueOf`/etc. lower-case to non-keys and never
// matched, so they are not the regression surface.)
describe('providerConfig — Codex alias lookup is prototype-safe', () => {
  const protoNames = ['constructor', '__proto__']

  for (const name of protoNames) {
    test(`isCodexAlias('${name}') is false (inherited, not a real alias)`, () => {
      expect(isCodexAlias(name)).toBe(false)
    })

    test(`shouldUseCodexTransport('${name}', undefined) does not misroute`, () => {
      expect(shouldUseCodexTransport(name, undefined)).toBe(false)
    })
  }

  // Controls: real aliases still resolve.
  test('genuine aliases are still recognized', () => {
    expect(isCodexAlias('codexplan')).toBe(true)
    expect(isCodexAlias('gpt-5.5')).toBe(true)
    expect(shouldUseCodexTransport('codexplan', undefined)).toBe(true)
  })

  // Non-aliases (real model ids that aren't Codex) stay false.
  test('non-Codex model ids are not treated as aliases', () => {
    expect(isCodexAlias('claude-opus-4-8')).toBe(false)
    expect(shouldUseCodexTransport('claude-opus-4-8', undefined)).toBe(false)
  })

  // getReasoningEffortForModel indexes the same map (feeds supportsCodexReasoningEffort,
  // /effort, EffortPicker). It must be prototype-safe too. `constructor` /
  // `__proto__` carry no `.reasoningEffort`, so to prove the own-property guard
  // actually fires we plant a polluting alias on Object.prototype (cleaned up in
  // finally) and confirm it is NOT read as a Codex reasoning default.
  test('getReasoningEffortForModel ignores an inherited (polluted) alias', () => {
    const key = 'polluted-effort-alias'
    // eslint-disable-next-line no-extend-native
    ;(Object.prototype as Record<string, unknown>)[key] = {
      model: key,
      reasoningEffort: 'high',
    }
    try {
      expect(getReasoningEffortForModel(key)).toBeUndefined()
      expect(supportsCodexReasoningEffort(key)).toBe(false)
    } finally {
      delete (Object.prototype as Record<string, unknown>)[key]
    }
  })

  test('getReasoningEffortForModel still resolves genuine aliases', () => {
    expect(getReasoningEffortForModel('codexplan')).toBe('high')
    expect(getReasoningEffortForModel('gpt-5.5-mini')).toBe('medium')
    expect(getReasoningEffortForModel('gpt-5.3-codex-spark')).toBeUndefined()
  })

  // The descriptor parsing path (parseModelDescriptor, via resolveProviderRequest)
  // is guarded too — a proto-name model must resolve to itself, not to the
  // inherited Object constructor's (nonexistent) `.model`, which produced an
  // undefined resolvedModel before the guard.
  for (const name of protoNames) {
    test(`resolveProviderRequest keeps '${name}' as the resolved model`, () => {
      const { resolvedModel } = resolveProviderRequest({
        model: name,
        processEnv: {},
      })
      expect(resolvedModel).toBe(name)
    })
  }

  // The descriptor path reads CODEX_ALIAS_MODELS twice: the no-query branch
  // above, and the `baseModel?reasoning=...` query branch, which is a separate
  // guarded read. Removing the own-property guard from the query branch must
  // also red-green here. `constructor`/`__proto__` carry no `.model`, so to
  // exercise the query branch we plant an inherited alias whose `.model`
  // differs from the key, then confirm a `<key>?reasoning=...` request keeps
  // the literal base model instead of the inherited alias's `.model`.
  test('resolveProviderRequest query branch ignores an inherited (polluted) alias', () => {
    const key = 'polluted-descriptor-alias'
    // eslint-disable-next-line no-extend-native
    ;(Object.prototype as Record<string, unknown>)[key] = {
      model: 'gpt-5.5',
      reasoningEffort: 'high',
    }
    try {
      const { resolvedModel } = resolveProviderRequest({
        model: `${key}?reasoning=medium`,
        processEnv: {},
      })
      expect(resolvedModel).toBe(key)
    } finally {
      delete (Object.prototype as Record<string, unknown>)[key]
    }
  })

  test('resolveProviderRequest query branch still resolves a genuine Codex alias', () => {
    const request = resolveProviderRequest({
      model: 'codexplan?reasoning=medium',
      processEnv: {},
    })
    expect(request).toMatchObject({
      requestedModel: 'codexplan?reasoning=medium',
      resolvedModel: 'gpt-5.6-sol',
      transport: 'codex_responses',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      reasoning: { effort: 'medium' },
    })
  })

  test('resolveProviderRequest still resolves a genuine Codex alias', () => {
    const { resolvedModel } = resolveProviderRequest({
      model: 'codexplan',
      processEnv: {},
    })
    expect(resolvedModel).toBe('gpt-5.6-sol')
  })
})
