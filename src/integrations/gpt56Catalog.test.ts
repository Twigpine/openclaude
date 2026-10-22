import { describe, expect, test } from 'bun:test'

import {
  getCatalogEntriesForRoute,
  getModel,
  getRouteDefaultBaseUrl,
  getRouteDefaultModel,
  getVendor,
  resolveRouteIdFromBaseUrl,
} from './index.js'

const GPT56_IDS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] as const

describe('OpenAI GPT-5.6 catalog', () => {
  test('links descriptors while keeping route-specific limits and reasoning', () => {
    const baseUrl = 'https://api.openai.com/v1'
    expect(resolveRouteIdFromBaseUrl(baseUrl)).toBe('openai')
    expect(getRouteDefaultBaseUrl('openai')).toBe(baseUrl)
    expect(getRouteDefaultModel('openai')).toBe('gpt-5.4')
    expect(getVendor('openai')?.setup.credentialEnvVars).toEqual([
      'OPENAI_API_KEYS',
      'OPENAI_API_KEY',
    ])

    for (const id of GPT56_IDS) {
      const descriptor = getModel(id)
      // Catalog-less routes (including Codex) use the 272k descriptor fallback;
      // direct OpenAI requests use the catalog's 1.05M context window.
      expect(descriptor).toMatchObject({
        id,
        defaultModel: id,
        contextWindow: 272_000,
        maxOutputTokens: 128_000,
      })
      const entry = getCatalogEntriesForRoute('openai').find(model => model.id === id)
      expect(entry).toMatchObject({
        apiName: id,
        modelDescriptorId: descriptor?.id,
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
      })
      expect(entry?.reasoning?.wireFormat).toBe('reasoning_effort')
      expect(entry?.reasoning?.levels).toContain('xhigh')
    }
  })
})
