import { describe, expect, test } from 'bun:test'
import xai from './xai.js'

const mapModel = xai.catalog?.discovery?.mapModel

function shape(id: string, extras: Record<string, unknown> = {}) {
  return { id, ...extras }
}

describe('xAI vendor hybrid catalog', () => {
  test('uses hybrid discovery with curated Grok 4.6 as the default', () => {
    expect(mapModel).toBeDefined()
    expect(xai.catalog?.source).toBe('hybrid')
    expect(xai.catalog?.discovery?.kind).toBe('openai-compatible')
    expect(xai.catalog?.discoveryCacheTtl).toBe('1d')
    expect(xai.catalog?.discoveryRefreshMode).toBe('background-if-stale')
    expect(xai.catalog?.allowManualRefresh).toBe(true)
    expect(xai.defaultModel).toBe('grok-4.6')
    expect(xai.catalog?.models?.map(model => model.apiName)).toEqual([
      'grok-4.6',
      'grok-4.5',
      'grok-4.3',
      'grok-build-0.1',
      'grok-4.20-0309-reasoning',
      'grok-4.20-0309-non-reasoning',
    ])
  })

  test('keeps chat Grok IDs including later uncataloged releases', () => {
    if (!mapModel) throw new Error('mapModel missing')
    const keep = [
      'grok-4.6',
      'grok-4.5',
      'grok-4.3',
      'grok-4.7',
      'grok-build-0.1',
      'grok-4.20-0309-reasoning',
    ]
    for (const id of keep) {
      expect(mapModel(shape(id))).toEqual({
        id,
        apiName: id,
        label: id,
      })
    }
  })

  test('drops Imagine, voice, STT/TTS, and embedding models', () => {
    if (!mapModel) throw new Error('mapModel missing')
    const drop = [
      'grok-imagine-image',
      'grok-imagine-image-quality',
      'grok-imagine-video-1.5',
      'grok-voice-think-fast-1.0',
      'grok-voice-think-fast-2.0',
      'grok-stt-1.0',
      'grok-tts-1.0',
      // This model requires xAI's Responses API and does not support the
      // generic OpenAI-compatible chat transport used by live discovery.
      'grok-4.20-multi-agent-0309',
    ]
    for (const id of drop) {
      expect(mapModel(shape(id))).toBeNull()
    }
  })

  test('drops curated aliases so hybrid merge does not duplicate them', () => {
    if (!mapModel) throw new Error('mapModel missing')
    const drop = [
      'latest',
      'grok-4.6-latest',
      'grok-4.5-latest',
      'grok-build-latest',
      'grok-latest',
      'grok-code-fast-1',
    ]
    for (const id of drop) {
      expect(mapModel(shape(id))).toBeNull()
    }
  })

  test('drops inactive entries, missing ids, and non-positive context limits', () => {
    if (!mapModel) throw new Error('mapModel missing')
    expect(mapModel(shape('grok-4.6', { active: false }))).toBeNull()
    expect(mapModel(null)).toBeNull()
    expect(mapModel({})).toBeNull()
    expect(mapModel({ id: 1 })).toBeNull()
    expect(mapModel({ id: '' })).toBeNull()
    expect(mapModel(shape('grok-4.7', { context_length: 0 }))).toEqual({
      id: 'grok-4.7',
      apiName: 'grok-4.7',
      label: 'grok-4.7',
    })
    expect(mapModel(shape('grok-4.7', { context_length: Number.NaN }))).toEqual({
      id: 'grok-4.7',
      apiName: 'grok-4.7',
      label: 'grok-4.7',
    })
  })

  test('forwards the /v1/models context_length when present', () => {
    if (!mapModel) throw new Error('mapModel missing')
    expect(mapModel(shape('grok-4.6', { context_length: 500000 }))).toEqual({
      id: 'grok-4.6',
      apiName: 'grok-4.6',
      label: 'grok-4.6',
      contextWindow: 500000,
    })
  })
})
