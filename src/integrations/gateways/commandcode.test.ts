import { expect, test } from 'bun:test'

import { routeForPreset } from '../compatibility.js'
import { getProviderPresetUiMetadata } from '../providerUiMetadata.js'
import {
  resolveActiveRouteIdFromEnv,
  resolveRouteCredentialValue,
  resolveRouteIdFromBaseUrl,
} from '../routeMetadata.js'
import gateway, {
  getCommandcodeChatCompletionsModelError,
  mapCommandcodeModel,
} from './commandcode.js'

test('Command Code uses a dedicated hybrid OpenAI-compatible gateway contract', () => {
  expect(gateway.defaultBaseUrl).toBe(
    'https://api.commandcode.ai/provider/v1',
  )
  expect(gateway.defaultModel).toBe('deepseek/deepseek-v4-flash')
  expect(gateway.setup.credentialEnvVars).toEqual([
    'CMD_API_KEY',
    'COMMANDCODE_API_KEY',
    'COMMAND_CODE_API_KEY',
  ])
  expect(gateway.setup.dedicatedCredentialsOnly).toBe(true)
  expect(gateway.preset?.apiKeyEnvVars).toEqual([
    'CMD_API_KEY',
    'COMMANDCODE_API_KEY',
    'COMMAND_CODE_API_KEY',
  ])
  expect(gateway.validation).toMatchObject({
    kind: 'credential-env',
    routing: { matchDefaultBaseUrl: true },
    credentialEnvVars: [
      'CMD_API_KEY',
      'COMMANDCODE_API_KEY',
      'COMMAND_CODE_API_KEY',
    ],
  })
  expect(gateway.transportConfig).toEqual({
    kind: 'openai-compatible',
    openaiShim: {
      requiredApiFormat: 'chat_completions',
      supportsAuthHeaders: false,
      maxTokensField: 'max_tokens',
    },
  })
  expect(gateway.catalog?.source).toBe('hybrid')
  expect(gateway.catalog?.discovery?.requiresAuth).toBe(false)
  expect(gateway.catalog?.models?.map(model => model.apiName)).toEqual([
    'deepseek/deepseek-v4-flash',
    'deepseek/deepseek-v4-pro',
    'gpt-5.6-sol',
    'moonshotai/Kimi-K2.5',
    'MiniMaxAI/MiniMax-M3',
    'z-ai/glm-5.3-flash',
  ])
})

test('Command Code preset uses the existing generic profile path', () => {
  expect(routeForPreset('commandcode')).toEqual({
    vendorId: 'openai',
    gatewayId: 'commandcode',
    routeId: 'commandcode',
  })
  expect(
    getProviderPresetUiMetadata('commandcode', {
      CMD_API_KEY: 'cmd-key',
      COMMANDCODE_API_KEY: 'fallback-key',
    }),
  ).toMatchObject({
    apiKey: 'cmd-key',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    model: 'deepseek/deepseek-v4-flash',
    provider: 'commandcode',
    routeId: 'commandcode',
  })

  expect(
    getProviderPresetUiMetadata('commandcode', {
      COMMANDCODE_API_KEY: 'fallback-key',
    }).apiKey,
  ).toBe('fallback-key')

  expect(
    getProviderPresetUiMetadata('commandcode', {
      COMMAND_CODE_API_KEY: 'official-key',
    }).apiKey,
  ).toBe('official-key')

  expect(
    getProviderPresetUiMetadata('commandcode', {
      CMD_API_KEY: 'SUA_CHAVE',
    }).apiKey,
  ).toBe('')
  expect(
    getProviderPresetUiMetadata('commandcode', {
      CMD_API_KEY: 'SUA_CHAVE',
      COMMANDCODE_API_KEY: 'fallback-key',
    }).apiKey,
  ).toBe('fallback-key')
  expect(
    getProviderPresetUiMetadata('commandcode', {
      OPENAI_API_KEY: 'generic-openai-key',
    }).apiKey,
  ).toBe('')
})

test('Command Code dedicated credentials require the canonical inference URL', () => {
  const processEnv = { CMD_API_KEY: 'cmd-key' }

  expect(
    resolveRouteIdFromBaseUrl('https://api.commandcode.ai/provider/v1'),
  ).toBe('commandcode')
  expect(
    resolveRouteIdFromBaseUrl('https://api.commandcode.ai/provider/v1?tenant=proxy'),
  ).toBeNull()
  expect(
    resolveRouteIdFromBaseUrl('https://api.commandcode.ai/provider/v1#proxy'),
  ).toBeNull()
  expect(
    resolveRouteCredentialValue({
      routeId: 'commandcode',
      baseUrl: 'https://api.commandcode.ai/provider/v1',
      processEnv,
    }),
  ).toBe('cmd-key')
  expect(
    resolveRouteCredentialValue({
      routeId: 'commandcode',
      baseUrl: 'https://api.commandcode.ai/provider/v1',
      processEnv: { COMMANDCODE_API_KEY: 'fallback-key' },
    }),
  ).toBe('fallback-key')
  expect(
    resolveRouteCredentialValue({
      routeId: 'commandcode',
      baseUrl: 'https://api.commandcode.ai/provider/v1',
      processEnv: { COMMAND_CODE_API_KEY: 'official-key' },
    }),
  ).toBe('official-key')
  expect(
    resolveRouteCredentialValue({
      routeId: 'custom',
      baseUrl: 'https://proxy.example/v1',
      processEnv,
    }),
  ).toBeUndefined()
  expect(
    resolveRouteCredentialValue({
      routeId: 'commandcode',
      baseUrl: 'https://proxy.example/v1',
      processEnv,
    }),
  ).toBeUndefined()
  expect(
    resolveActiveRouteIdFromEnv(processEnv),
  ).not.toBe('commandcode')
})

test('Command Code discovery keeps Chat Completions models and drops Claude ids', () => {
  expect(
    mapCommandcodeModel({
      id: 'deepseek/deepseek-v4-flash',
      name: 'DeepSeek V4 Flash (latest)',
      context_length: 1_000_000,
    }),
  ).toEqual({
    id: 'deepseek/deepseek-v4-flash',
    apiName: 'deepseek/deepseek-v4-flash',
    label: 'DeepSeek V4 Flash (latest)',
    contextWindow: 1_000_000,
  })
  expect(
    mapCommandcodeModel({
      id: 'claude-sonnet-5',
      name: 'Claude Sonnet 5',
      context_length: 1_000_000,
    }),
  ).toBeNull()
  expect(
    mapCommandcodeModel({
      id: 'anthropic/claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
    }),
  ).toBeNull()
  expect(mapCommandcodeModel({})).toBeNull()
  expect(mapCommandcodeModel(null)).toBeNull()
})

test('Command Code rejects models that require the Anthropic Messages protocol', () => {
  expect(
    getCommandcodeChatCompletionsModelError('anthropic/claude-sonnet-4-6'),
  ).toContain('requires the Anthropic Messages protocol')
  expect(getCommandcodeChatCompletionsModelError('Claude-Sonnet-5')).toContain(
    'requires the Anthropic Messages protocol',
  )
  expect(
    getCommandcodeChatCompletionsModelError('deepseek/deepseek-v4-flash'),
  ).toBeNull()
})

test('Command Code rejects every supported Claude model alias', () => {
  for (const model of [
    'sonnet',
    'opus',
    'haiku',
    'best',
    'sonnet[1m]',
    'opus[1m]',
    'opusplan',
  ]) {
    expect(getCommandcodeChatCompletionsModelError(model)).toContain(
      'requires the Anthropic Messages protocol',
    )
  }
})

test('Command Code classifies protocol identity before model modifiers', () => {
  for (const model of [
    'sonnet?reasoning=high',
    'opus?thinking=enabled',
    'haiku[1m]?reasoning=low',
    'anthropic/claude-sonnet-4-6?reasoning=xhigh',
    'claude-sonnet-5?thinking=disabled[1m]',
  ]) {
    expect(getCommandcodeChatCompletionsModelError(model)).toContain(
      'requires the Anthropic Messages protocol',
    )
  }

  expect(
    getCommandcodeChatCompletionsModelError(
      'deepseek/deepseek-v4-flash?reasoning=high',
    ),
  ).toBeNull()
})

test('Command Code protocol errors do not echo a rejected model value', () => {
  const secretShapedModel = 'anthropic/provider-secret-123456'
  const error = getCommandcodeChatCompletionsModelError(secretShapedModel)

  expect(error).toContain('requires the Anthropic Messages protocol')
  expect(error).not.toContain(secretShapedModel)
})

test('Command Code rejects a Claude member in a compound model list', () => {
  expect(
    getCommandcodeChatCompletionsModelError(
      'deepseek/deepseek-v4-flash, anthropic/claude-sonnet-4-6',
    ),
  ).toContain('requires the Anthropic Messages protocol')
  expect(
    getCommandcodeChatCompletionsModelError(
      'deepseek/deepseek-v4-flash; sonnet',
    ),
  ).toContain('requires the Anthropic Messages protocol')
  expect(
    getCommandcodeChatCompletionsModelError(
      'deepseek/deepseek-v4-flash, gpt-5.6-sol',
    ),
  ).toBeNull()
})
