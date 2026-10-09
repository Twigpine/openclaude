import { describe, expect, test } from 'bun:test'
import requesty, { mapRequestyModel } from './requesty.js'

describe('requesty gateway live model mapping', () => {
  test('uses hybrid discovery against the public models list', () => {
    expect(requesty.catalog?.source).toBe('hybrid')
    expect(requesty.catalog?.discovery).toEqual(
      expect.objectContaining({
        kind: 'openai-compatible',
        requiresAuth: false,
      }),
    )
    expect(requesty.catalog?.discovery?.mapModel).toBe(mapRequestyModel)
  })

  test('maps Requesty model fields into catalog entries', () => {
    expect(
      mapRequestyModel({
        id: 'anthropic/claude-sonnet-4-6',
        object: 'model',
        api: 'chat',
        context_window: 1000000,
        max_output_tokens: 64000,
        supports_tool_calling: true,
        supports_reasoning: true,
        supports_vision: true,
        input_price: 0.000003,
      }),
    ).toEqual({
      id: 'anthropic/claude-sonnet-4-6',
      apiName: 'anthropic/claude-sonnet-4-6',
      label: 'anthropic/claude-sonnet-4-6',
      contextWindow: 1000000,
      maxOutputTokens: 64000,
      capabilities: {
        supportsFunctionCalling: true,
        supportsReasoning: true,
      },
    })

    expect(
      mapRequestyModel({
        id: 'xai/grok-4.6',
        api: 'chat',
        context_window: 256000,
        max_output_tokens: 0,
        supports_tool_calling: false,
        supports_reasoning: false,
      }),
    ).toEqual({
      id: 'xai/grok-4.6',
      apiName: 'xai/grok-4.6',
      label: 'xai/grok-4.6',
      contextWindow: 256000,
    })
  })

  test('filters non-chat and non-coding models', () => {
    expect(
      mapRequestyModel({
        id: 'openai/text-embedding-3-small',
        api: 'embedding',
      }),
    ).toBeNull()

    expect(
      mapRequestyModel({
        id: 'vendor/some-model',
        api: 'image',
      }),
    ).toBeNull()

    expect(mapRequestyModel({ id: 'openai/text-embedding-3-large' })).toBeNull()
    expect(mapRequestyModel({})).toBeNull()
    expect(mapRequestyModel({ id: '   ' })).toBeNull()
    expect(mapRequestyModel(null)).toBeNull()
    expect(mapRequestyModel('openai/gpt-5-mini')).toBeNull()
  })

  test('drops model ids carrying control or ANSI escape characters', () => {
    expect(
      mapRequestyModel({ id: 'openai/gpt-5-mini\u001b[31m', api: 'chat' }),
    ).toBeNull()
    expect(
      mapRequestyModel({ id: 'openai/gpt\u0007-5-mini', api: 'chat' }),
    ).toBeNull()
    expect(
      mapRequestyModel({ id: 'openai/gpt-5-mini\u009b', api: 'chat' }),
    ).toBeNull()
  })
})
