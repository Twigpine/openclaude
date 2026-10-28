import { describe, expect, test } from 'bun:test'

import orcarouter from './orcarouter.js'

describe('orcarouter gateway', () => {
  test('uses hybrid discovery with dedicated credentials', () => {
    expect(orcarouter.id).toBe('orcarouter')
    expect(orcarouter.catalog?.source).toBe('hybrid')
    expect(orcarouter.catalog?.discovery?.kind).toBe('openai-compatible')
    expect(orcarouter.setup.dedicatedCredentialsOnly).toBe(true)
    expect(orcarouter.setup.credentialEnvVars).toEqual(['ORCAROUTER_API_KEY'])
    expect(orcarouter.defaultBaseUrl).toBe('https://api.orcarouter.ai/v1')
    expect(orcarouter.defaultModel).toBe('openai/gpt-5.5')
  })

  test('curated catalog exposes auto routing plus flagship models', () => {
    const models = orcarouter.catalog?.models ?? []
    expect(models.some(model => model.apiName === 'orcarouter/auto')).toBe(true)
    expect(models.some(model => model.apiName === 'openai/gpt-5.5')).toBe(true)
    expect(
      models.some(model => model.apiName === 'anthropic/claude-sonnet-4.6'),
    ).toBe(true)
    expect(
      models.some(model => model.apiName === 'google/gemini-3.5-flash'),
    ).toBe(true)
  })
})
