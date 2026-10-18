import { describe, expect, test } from 'bun:test'
import openrouter, { mapOpenRouterModel } from './openrouter.js'

describe('openrouter gateway live model mapping', () => {
  test('uses hybrid discovery against the public models list', () => {
    expect(openrouter.catalog?.source).toBe('hybrid')
    expect(openrouter.catalog?.discovery).toEqual(
      expect.objectContaining({
        kind: 'openai-compatible',
        requiresAuth: false,
      }),
    )
    expect(openrouter.catalog?.discovery?.mapModel).toBe(mapOpenRouterModel)
  })

  test('maps coding models with context length and free labels', () => {
    expect(
      mapOpenRouterModel({
        id: 'anthropic/claude-sonnet-4.5',
        name: 'Anthropic: Claude Sonnet 4.5',
        description: 'A long marketing blurb.',
        context_length: 200000,
        architecture: {
          input_modalities: ['text', 'image'],
          output_modalities: ['text'],
        },
        supported_parameters: ['tools', 'reasoning', 'temperature'],
      }),
    ).toEqual({
      id: 'anthropic/claude-sonnet-4.5',
      apiName: 'anthropic/claude-sonnet-4.5',
      label: 'Anthropic: Claude Sonnet 4.5',
      contextWindow: 200000,
      capabilities: {
        supportsFunctionCalling: true,
        supportsReasoning: true,
      },
    })

    expect(
      mapOpenRouterModel({
        id: 'nvidia/nemotron-3-ultra:free',
        name: 'Nemotron 3 Ultra',
        context_length: 128000,
        supported_parameters: ['tools'],
        is_free: true,
      }),
    ).toEqual({
      id: 'nvidia/nemotron-3-ultra:free',
      apiName: 'nvidia/nemotron-3-ultra:free',
      label: 'Nemotron 3 Ultra (free)',
      contextWindow: 128000,
      notes: 'Free',
      capabilities: {
        supportsFunctionCalling: true,
      },
    })
  })

  test('filters non-coding and non-text routes', () => {
    expect(
      mapOpenRouterModel({
        id: 'openai/text-embedding-3-large',
        name: 'Embedding',
      }),
    ).toBeNull()

    expect(
      mapOpenRouterModel({
        id: 'vendor/image-only',
        name: 'Image Only',
        architecture: {
          input_modalities: ['text'],
          output_modalities: ['image'],
        },
      }),
    ).toBeNull()

    expect(mapOpenRouterModel({})).toBeNull()
    expect(mapOpenRouterModel({ id: '   ' })).toBeNull()
    expect(mapOpenRouterModel(null)).toBeNull()
  })

  test('keeps unfamiliar text models without declared parameters', () => {
    expect(
      mapOpenRouterModel({ id: 'vendor/brand-new-1', name: 'New' }),
    ).toEqual({
      id: 'vendor/brand-new-1',
      apiName: 'vendor/brand-new-1',
      label: 'New',
    })
  })

  test('detects reasoning from the reasoning object', () => {
    expect(
      mapOpenRouterModel({
        id: 'vendor/brand-new-1',
        name: 'New',
        reasoning: { supported_efforts: ['low', 'high'] },
      })?.capabilities,
    ).toEqual({ supportsReasoning: true })
  })

  test('keeps text models with deep-research in their ID', () => {
    expect(
      mapOpenRouterModel({
        id: 'perplexity/sonar-deep-research',
        name: 'Perplexity: Sonar Deep Research',
        context_length: 128000,
        architecture: {
          input_modalities: ['text'],
          output_modalities: ['text'],
        },
        supported_parameters: ['tools', 'reasoning'],
      }),
    ).toEqual({
      id: 'perplexity/sonar-deep-research',
      apiName: 'perplexity/sonar-deep-research',
      label: 'Perplexity: Sonar Deep Research',
      contextWindow: 128000,
      capabilities: {
        supportsFunctionCalling: true,
        supportsReasoning: true,
      },
    })
  })
})
