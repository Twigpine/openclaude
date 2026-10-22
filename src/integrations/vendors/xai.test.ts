import { describe, expect, test } from 'bun:test'
import type { ModelCatalogEntry } from '../descriptors.js'
import {
  getCatalogEntriesForRoute,
  getModel,
  getRouteDefaultBaseUrl,
  getRouteDefaultModel,
  getVendor,
  resolveRouteIdFromBaseUrl,
} from '../index.js'
import xai from './xai.js'

const mapModel = xai.catalog?.discovery?.mapModel

describe('xAI vendor hybrid catalog', () => {
  test('registers route defaults, credentials, and descriptor links', () => {
    expect(mapModel).toBeDefined()
    expect(xai.catalog?.source).toBe('hybrid')
    expect(xai.catalog?.discovery?.kind).toBe('openai-compatible')
    for (const { routeId, baseUrl, model } of [
      { routeId: 'xai', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.6' },
    ]) {
      expect(resolveRouteIdFromBaseUrl(baseUrl)).toBe(routeId)
      expect(getRouteDefaultBaseUrl(routeId)).toBe(baseUrl)
      expect(getRouteDefaultModel(routeId)).toBe(model)
      expect(getVendor(routeId)?.setup.credentialEnvVars).toEqual(['XAI_API_KEY'])
      const catalog = getCatalogEntriesForRoute(routeId)
      expect(catalog.some(entry => entry.apiName === model)).toBe(true)
      for (const entry of catalog) {
        const descriptor = getModel(entry.modelDescriptorId ?? '')
        expect(descriptor).toBeDefined()
        expect(descriptor?.defaultModel).toBe(entry.apiName)
      }
    }
    expect(getModel('grok-4.6')).toMatchObject({
      contextWindow: 500_000,
      capabilities: {
        supportsVision: true,
        supportsStreaming: true,
        supportsFunctionCalling: true,
        supportsJsonMode: true,
        supportsReasoning: true,
        supportsPreciseTokenCount: false,
      },
    })
  })

  test('maps chat discovery entries and rejects unsupported or invalid entries', () => {
    if (!mapModel) throw new Error('mapModel missing')
    const chat = (id: string): ModelCatalogEntry => ({ id, apiName: id, label: id })
    const cases: Array<{ raw: unknown, expected: ModelCatalogEntry | null }> = [
      { raw: { id: 'grok-4.6' }, expected: chat('grok-4.6') },
      { raw: { id: 'grok-4.7' }, expected: chat('grok-4.7') },
      { raw: { id: 'grok-build-0.1' }, expected: chat('grok-build-0.1') },
      { raw: { id: 'grok-4.20-0309-reasoning' }, expected: chat('grok-4.20-0309-reasoning') },
      { raw: { id: 'grok-imagine-image' }, expected: null },
      { raw: { id: 'grok-imagine-video-1.5' }, expected: null },
      { raw: { id: 'grok-voice-think-fast-1.0' }, expected: null },
      { raw: { id: 'grok-stt-1.0' }, expected: null },
      { raw: { id: 'grok-tts-1.0' }, expected: null },
      { raw: { id: 'grok-embed-1.0' }, expected: null },
      { raw: { id: 'grok-4.20-multi-agent-0309' }, expected: null },
      { raw: { id: 'latest' }, expected: null },
      { raw: { id: 'grok-4.6-latest' }, expected: null },
      { raw: { id: 'grok-build-latest' }, expected: null },
      { raw: { id: 'grok-code-fast-1' }, expected: null },
      { raw: { id: 'grok-4.6', active: false }, expected: null },
      { raw: null, expected: null },
      { raw: {}, expected: null },
      { raw: { id: 1 }, expected: null },
      { raw: { id: '' }, expected: null },
      { raw: { id: 'other-model' }, expected: null },
      { raw: { id: 'grok-4.7', context_length: 0 }, expected: chat('grok-4.7') },
      { raw: { id: 'grok-4.7', context_length: -1 }, expected: chat('grok-4.7') },
      { raw: { id: 'grok-4.7', context_length: Number.NaN }, expected: chat('grok-4.7') },
      {
        raw: { id: 'grok-4.6', context_length: 500_000 },
        expected: { ...chat('grok-4.6'), contextWindow: 500_000 },
      },
    ]
    for (const { raw, expected } of cases) {
      expect(mapModel(raw)).toEqual(expected)
    }
  })
})
