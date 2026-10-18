import { afterEach, beforeEach, expect, test } from 'bun:test'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../../test/sharedMutationLock.js'

import {
  getAdditionalModelOptionsCacheScope,
  getLocalProviderRetryBaseUrls,
  isAzureStyleBaseUrl,
  isLocalProviderUrl,
  modelRequiresResponsesApi,
  resolveProviderRequest,
  shouldAttemptLocalToollessRetry,
} from './providerConfig.js'

const originalEnv = {
  CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_KEYS: process.env.OPENAI_API_KEYS,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_AUTH_HEADER: process.env.OPENAI_AUTH_HEADER,
  OPENAI_AUTH_SCHEME: process.env.OPENAI_AUTH_SCHEME,
  OPENAI_AUTH_HEADER_VALUE: process.env.OPENAI_AUTH_HEADER_VALUE,
  ANTHROPIC_CUSTOM_HEADERS: process.env.ANTHROPIC_CUSTOM_HEADERS,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENAI_API_FORMAT: process.env.OPENAI_API_FORMAT,
  OPENAI_AZURE_STYLE: process.env.OPENAI_AZURE_STYLE,
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

beforeEach(async () => {
  await acquireSharedMutationLock('providerConfig.local.test.ts')
})

afterEach(() => {
  try {
    restoreEnv('CLAUDE_CODE_USE_OPENAI', originalEnv.CLAUDE_CODE_USE_OPENAI)
    restoreEnv('OPENAI_BASE_URL', originalEnv.OPENAI_BASE_URL)
    restoreEnv('OPENAI_API_KEYS', originalEnv.OPENAI_API_KEYS)
    restoreEnv('OPENAI_API_KEY', originalEnv.OPENAI_API_KEY)
    restoreEnv('OPENAI_AUTH_HEADER', originalEnv.OPENAI_AUTH_HEADER)
    restoreEnv('OPENAI_AUTH_SCHEME', originalEnv.OPENAI_AUTH_SCHEME)
    restoreEnv('OPENAI_AUTH_HEADER_VALUE', originalEnv.OPENAI_AUTH_HEADER_VALUE)
    restoreEnv('ANTHROPIC_CUSTOM_HEADERS', originalEnv.ANTHROPIC_CUSTOM_HEADERS)
    restoreEnv('OPENAI_MODEL', originalEnv.OPENAI_MODEL)
    restoreEnv('OPENAI_API_FORMAT', originalEnv.OPENAI_API_FORMAT)
    restoreEnv('OPENAI_AZURE_STYLE', originalEnv.OPENAI_AZURE_STYLE)
  } finally {
    releaseSharedMutationLock()
  }
})

test('treats localhost endpoints as local', () => {
  expect(isLocalProviderUrl('http://localhost:11434/v1')).toBe(true)
  expect(isLocalProviderUrl('http://127.0.0.1:11434/v1')).toBe(true)
  // Full 127.0.0.0/8 loopback range should be treated as local
  expect(isLocalProviderUrl('http://127.0.0.2:11434/v1')).toBe(true)
  expect(isLocalProviderUrl('http://127.1.2.3:11434/v1')).toBe(true)
  expect(isLocalProviderUrl('http://127.255.255.255:11434/v1')).toBe(true)
})

test('does not treat wildcard bind addresses as local endpoints', () => {
  expect(isLocalProviderUrl('http://0.0.0.0:11434/v1')).toBe(false)
})

test('treats private IPv4 endpoints as local', () => {
  expect(isLocalProviderUrl('http://10.0.0.1:11434/v1')).toBe(true)
  expect(isLocalProviderUrl('http://172.16.0.1:11434/v1')).toBe(true)
  expect(isLocalProviderUrl('http://192.168.0.1:11434/v1')).toBe(true)
})

test('treats .local hostnames as local', () => {
  expect(isLocalProviderUrl('http://ollama.local:11434/v1')).toBe(true)
})

test('treats private IPv6 endpoints as local', () => {
  expect(isLocalProviderUrl('http://[fd00::1]:11434/v1')).toBe(true)
  expect(isLocalProviderUrl('http://[fe80::1]:11434/v1')).toBe(true)
  expect(isLocalProviderUrl('http://[::1]:11434/v1')).toBe(true)
})

test('treats public hosts as remote', () => {
  expect(isLocalProviderUrl('http://203.0.113.1:11434/v1')).toBe(false)
  expect(isLocalProviderUrl('https://example.com/v1')).toBe(false)
  expect(isLocalProviderUrl('http://[2001:4860:4860::8888]:11434/v1')).toBe(false)
})

test('creates a cache scope for local openai-compatible providers', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://localhost:1234/v1'
  process.env.OPENAI_MODEL = 'llama-3.2-3b-instruct'

  expect(getAdditionalModelOptionsCacheScope()?.startsWith(
    'openai:http://localhost:1234/v1:',
  )).toBe(true)
})

test('keeps codex alias models on chat completions for local openai-compatible providers', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:8080/v1'
  process.env.OPENAI_MODEL = 'gpt-5.4'

  expect(resolveProviderRequest()).toMatchObject({
    transport: 'chat_completions',
    requestedModel: 'gpt-5.4',
    resolvedModel: 'gpt-5.4',
    baseUrl: 'http://127.0.0.1:8080/v1',
  })
  expect(getAdditionalModelOptionsCacheScope()?.startsWith(
    'openai:http://127.0.0.1:8080/v1:',
  )).toBe(true)
})

test('normalizes legacy Twigpine Opengateway provider-prefixed base URLs to the smart route', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://opengateway.gitlawb.com/v1/xiaomi-mimo'
  process.env.OPENAI_MODEL = 'zai-org/GLM-5.1-FP8'

  expect(resolveProviderRequest()).toMatchObject({
    transport: 'chat_completions',
    requestedModel: 'zai-org/GLM-5.1-FP8',
    resolvedModel: 'zai-org/GLM-5.1-FP8',
    baseUrl: 'https://opengateway.gitlawb.com/v1',
  })
})

test('partitions local openai-compatible model cache scope by credentials and headers', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://localhost:1234/v1'
  process.env.OPENAI_MODEL = 'llama-3.2-3b-instruct'
  process.env.OPENAI_API_KEY = 'first-key'
  process.env.ANTHROPIC_CUSTOM_HEADERS = 'X-Route: first'

  const firstScope = getAdditionalModelOptionsCacheScope()

  process.env.OPENAI_API_KEY = 'second-key'
  const secondScope = getAdditionalModelOptionsCacheScope()

  process.env.OPENAI_API_KEY = 'first-key'
  process.env.ANTHROPIC_CUSTOM_HEADERS = 'X-Route: second'
  const thirdScope = getAdditionalModelOptionsCacheScope()

  delete process.env.OPENAI_API_KEY
  process.env.ANTHROPIC_CUSTOM_HEADERS = 'X-Route: first'
  process.env.OPENAI_API_KEYS = 'first-a,first-b'
  const pooledScope = getAdditionalModelOptionsCacheScope()

  process.env.OPENAI_API_KEYS = 'second-a,second-b'
  const secondPooledScope = getAdditionalModelOptionsCacheScope()

  expect(firstScope).not.toBe(secondScope)
  expect(firstScope).not.toBe(thirdScope)
  expect(pooledScope).not.toBe(secondPooledScope)
  expect(firstScope?.startsWith('openai:http://localhost:1234/v1:')).toBe(true)
  expect(pooledScope?.startsWith('openai:http://localhost:1234/v1:')).toBe(true)
})

test('uses responses transport when OpenAI-compatible API format requests responses', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_MODEL = 'gpt-5.4'
  process.env.OPENAI_API_FORMAT = 'responses'

  expect(resolveProviderRequest()).toMatchObject({
    transport: 'responses',
    requestedModel: 'gpt-5.4',
    resolvedModel: 'gpt-5.4',
    baseUrl: 'https://api.openai.com/v1',
  })
})

test('uses responses transport for Hicap gpt-5.5 models when requested', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.hicap.ai/v1'
  process.env.OPENAI_MODEL = 'gpt-5.5'
  process.env.OPENAI_API_FORMAT = 'responses'

  expect(resolveProviderRequest()).toMatchObject({
    transport: 'responses',
    requestedModel: 'gpt-5.5',
    resolvedModel: 'gpt-5.5',
    baseUrl: 'https://api.hicap.ai/v1',
  })
})

test('defaults Hicap gpt-5.5 to responses transport', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.hicap.ai/v1'
  process.env.OPENAI_MODEL = 'gpt-5.5'

  expect(resolveProviderRequest()).toMatchObject({
    transport: 'responses',
    requestedModel: 'gpt-5.5',
    resolvedModel: 'gpt-5.5',
    baseUrl: 'https://api.hicap.ai/v1',
  })
})

test('defaults Hicap gpt-5.5 catalog id to responses transport', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.hicap.ai/v1'
  process.env.OPENAI_MODEL = 'hicap-gpt-5.5'

  expect(resolveProviderRequest()).toMatchObject({
    transport: 'responses',
    requestedModel: 'hicap-gpt-5.5',
    resolvedModel: 'gpt-5.5',
    baseUrl: 'https://api.hicap.ai/v1',
  })
})

test('forces Hicap gpt-5.5 to responses even when chat completions is configured', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.hicap.ai/v1'
  process.env.OPENAI_MODEL = 'gpt-5.5'
  process.env.OPENAI_API_FORMAT = 'chat_completions'

  expect(resolveProviderRequest()).toMatchObject({
    transport: 'responses',
    requestedModel: 'gpt-5.5',
    resolvedModel: 'gpt-5.5',
    baseUrl: 'https://api.hicap.ai/v1',
  })
})

test('preserves explicit responses_compat for Hicap gpt-5.5', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.hicap.ai/v1'
  process.env.OPENAI_MODEL = 'gpt-5.5'
  process.env.OPENAI_API_FORMAT = 'responses_compat'

  expect(resolveProviderRequest()).toMatchObject({
    transport: 'responses_compat',
    requestedModel: 'gpt-5.5',
    resolvedModel: 'gpt-5.5',
    baseUrl: 'https://api.hicap.ai/v1',
  })
})

test('uses responses transport for Hicap gpt-5.4 when requested', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.hicap.ai/v1'
  process.env.OPENAI_MODEL = 'gpt-5.4'
  process.env.OPENAI_API_FORMAT = 'responses'

  expect(resolveProviderRequest()).toMatchObject({
    transport: 'responses',
    requestedModel: 'gpt-5.4',
    resolvedModel: 'gpt-5.4',
    baseUrl: 'https://api.hicap.ai/v1',
  })
})

test('defaults Hicap gpt-5.4 to responses transport', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.hicap.ai/v1'
  process.env.OPENAI_MODEL = 'gpt-5.4'

  expect(resolveProviderRequest()).toMatchObject({
    transport: 'responses',
    requestedModel: 'gpt-5.4',
    resolvedModel: 'gpt-5.4',
    baseUrl: 'https://api.hicap.ai/v1',
  })
})

test('forces Hicap gpt-5.4 to responses even when chat completions is configured', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.hicap.ai/v1'
  process.env.OPENAI_MODEL = 'gpt-5.4'
  process.env.OPENAI_API_FORMAT = 'chat_completions'

  expect(resolveProviderRequest()).toMatchObject({
    transport: 'responses',
    requestedModel: 'gpt-5.4',
    resolvedModel: 'gpt-5.4',
    baseUrl: 'https://api.hicap.ai/v1',
  })
})

test('preserves explicit responses_compat for Hicap gpt-5.4', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.hicap.ai/v1'
  process.env.OPENAI_MODEL = 'gpt-5.4'
  process.env.OPENAI_API_FORMAT = 'responses_compat'

  expect(resolveProviderRequest()).toMatchObject({
    transport: 'responses_compat',
    requestedModel: 'gpt-5.4',
    resolvedModel: 'gpt-5.4',
    baseUrl: 'https://api.hicap.ai/v1',
  })
})

test('falls back to chat completions for non-gpt Hicap models when responses is requested', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.hicap.ai/v1'
  process.env.OPENAI_MODEL = 'claude-opus-4.8'
  process.env.OPENAI_API_FORMAT = 'responses'

  expect(resolveProviderRequest()).toMatchObject({
    transport: 'chat_completions',
    requestedModel: 'claude-opus-4.8',
    resolvedModel: 'claude-opus-4.8',
    baseUrl: 'https://api.hicap.ai/v1',
  })
})

test('keeps Codex backend on Codex responses transport even when API format is set', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://chatgpt.com/backend-api/codex'
  process.env.OPENAI_MODEL = 'codexplan'
  process.env.OPENAI_API_FORMAT = 'chat_completions'

  expect(resolveProviderRequest()).toMatchObject({
    transport: 'codex_responses',
    requestedModel: 'codexplan',
    resolvedModel: 'gpt-5.6-sol',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
  })
})

test('skips local model cache scope for remote openai-compatible providers', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_MODEL = 'gpt-4o'

  expect(getAdditionalModelOptionsCacheScope()).toBeNull()
})

test('derives local retry base URLs with /v1 and loopback fallback candidates', () => {
  expect(getLocalProviderRetryBaseUrls('http://localhost:11434')).toEqual([
    'http://localhost:11434/v1',
    'http://127.0.0.1:11434',
    'http://127.0.0.1:11434/v1',
  ])
})

test('does not derive local retry base URLs for remote providers', () => {
  expect(getLocalProviderRetryBaseUrls('https://api.openai.com/v1')).toEqual([])
})

test('enables local toolless retry for likely Ollama endpoints with tools', () => {
  expect(
    shouldAttemptLocalToollessRetry({
      baseUrl: 'http://localhost:11434/v1',
      hasTools: true,
    }),
  ).toBe(true)
})

test('disables local toolless retry when no tools are present', () => {
  expect(
    shouldAttemptLocalToollessRetry({
      baseUrl: 'http://localhost:11434/v1',
      hasTools: false,
    }),
  ).toBe(false)
})

test('disables local toolless retry for non-Ollama local endpoints', () => {
  expect(
    shouldAttemptLocalToollessRetry({
      baseUrl: 'http://localhost:1234/v1',
      hasTools: true,
    }),
  ).toBe(false)
})

test('modelRequiresResponsesApi matches gpt-5.4/5.5/5.6 (excl. mini/nano) only', () => {
  for (const model of [
    'gpt-5.4',
    'gpt-5.5',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'GPT-5.6-SOL',
    // patch releases of a verified family stay routed
    'gpt-5.4.1',
  ]) {
    expect(modelRequiresResponsesApi(model)).toBe(true)
  }
  for (const model of [
    'gpt-4.1',
    'gpt-5',
    'gpt-5-mini',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'gpt-5.5-mini',
    'gpt-5.5-nano',
    'gpt-5.6-mini-high',
    'gpt-5.4-2026-01-01-mini',
    'gpt-5.6.1-nano',
    'gpt-5.10',
    'gpt-5.41',
    // unverified future minors are deliberately not auto-routed
    'gpt-5.7',
    'gpt-5.8-preview',
    'gpt-5.9',
    'o3',
    'claude-opus-4-8',
  ]) {
    expect(modelRequiresResponsesApi(model)).toBe(false)
  }
})

test('keeps gpt-5.4-mini on chat completions on the OpenAI base', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_MODEL = 'gpt-5.4-mini'
  delete process.env.OPENAI_API_FORMAT

  expect(resolveProviderRequest()).toMatchObject({
    transport: 'chat_completions',
    resolvedModel: 'gpt-5.4-mini',
  })
})

test('auto-routes gpt-5.6 to responses on the default OpenAI base', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_MODEL = 'gpt-5.6-sol'
  delete process.env.OPENAI_API_FORMAT

  expect(resolveProviderRequest()).toMatchObject({
    transport: 'responses',
    resolvedModel: 'gpt-5.6-sol',
    baseUrl: 'https://api.openai.com/v1',
  })
})

test('auto-routes gpt-5.6 to responses on regional OpenAI subdomains', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://eu.api.openai.com/v1'
  process.env.OPENAI_MODEL = 'gpt-5.6-sol'
  delete process.env.OPENAI_API_FORMAT

  expect(resolveProviderRequest()).toMatchObject({
    transport: 'responses',
    resolvedModel: 'gpt-5.6-sol',
    baseUrl: 'https://eu.api.openai.com/v1',
  })
})

test('explicit chat_completions overrides the gpt-5.6 responses auto-route', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_MODEL = 'gpt-5.6-sol'
  process.env.OPENAI_API_FORMAT = 'chat_completions'

  expect(resolveProviderRequest()).toMatchObject({
    transport: 'chat_completions',
    resolvedModel: 'gpt-5.6-sol',
  })
})

test('leaves gpt-4-class models on chat completions for the OpenAI base', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_MODEL = 'gpt-4o'
  delete process.env.OPENAI_API_FORMAT

  expect(resolveProviderRequest()).toMatchObject({
    transport: 'chat_completions',
    resolvedModel: 'gpt-4o',
  })
})

test('does not auto-route gpt-5.6 on an arbitrary non-OpenAI gateway base', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://gateway.example/v1'
  process.env.OPENAI_MODEL = 'gpt-5.6-sol'
  delete process.env.OPENAI_API_FORMAT

  expect(resolveProviderRequest()).toMatchObject({
    transport: 'chat_completions',
    baseUrl: 'https://gateway.example/v1',
  })
})

test('auto-routes gpt-5.6 to responses on an Azure OpenAI v1 base', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://myres.openai.azure.com/openai/v1'
  process.env.OPENAI_MODEL = 'gpt-5.6-terra'
  delete process.env.OPENAI_API_FORMAT

  expect(resolveProviderRequest()).toMatchObject({
    transport: 'responses',
    resolvedModel: 'gpt-5.6-terra',
  })
})

test('OPENAI_AZURE_STYLE extends the gpt-5.6 responses auto-route to non-azure.com hosts', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://apim.contoso.example/azure-openai'
  process.env.OPENAI_MODEL = 'gpt-5.6-sol'
  process.env.OPENAI_AZURE_STYLE = '1'
  delete process.env.OPENAI_API_FORMAT

  expect(resolveProviderRequest()).toMatchObject({
    transport: 'responses',
    resolvedModel: 'gpt-5.6-sol',
  })
})

test('without OPENAI_AZURE_STYLE the same non-azure.com host stays on chat completions', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://apim.contoso.example/azure-openai'
  process.env.OPENAI_MODEL = 'gpt-5.6-sol'
  delete process.env.OPENAI_AZURE_STYLE
  delete process.env.OPENAI_API_FORMAT

  expect(resolveProviderRequest()).toMatchObject({
    transport: 'chat_completions',
    resolvedModel: 'gpt-5.6-sol',
  })
})

test('does not auto-route an Azure-hosted custom gateway based on its resource name', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://openai-proxy.web.azure.com/v1'
  process.env.OPENAI_MODEL = 'gpt-5.6-sol'
  delete process.env.OPENAI_AZURE_STYLE
  delete process.env.OPENAI_API_FORMAT

  expect(resolveProviderRequest()).toMatchObject({
    transport: 'chat_completions',
    resolvedModel: 'gpt-5.6-sol',
  })
})

test('isAzureStyleBaseUrl honors the OPENAI_AZURE_STYLE override before hostname detection', () => {
  const overrideEnv = { OPENAI_AZURE_STYLE: '1' } as NodeJS.ProcessEnv
  const plainEnv = {} as NodeJS.ProcessEnv

  expect(isAzureStyleBaseUrl('https://apim.contoso.example/azure-openai', overrideEnv)).toBe(true)
  expect(isAzureStyleBaseUrl('https://apim.contoso.example/azure-openai', plainEnv)).toBe(false)
  // Override precedes URL parsing, so even a malformed base is Azure-style.
  expect(isAzureStyleBaseUrl('not a url', overrideEnv)).toBe(true)
  expect(isAzureStyleBaseUrl('not a url', plainEnv)).toBe(false)
})

test('isAzureStyleBaseUrl matches Azure OpenAI service hostnames only', () => {
  const plainEnv = {} as NodeJS.ProcessEnv

  expect(isAzureStyleBaseUrl('https://myres.openai.azure.com/openai/v1', plainEnv)).toBe(true)
  expect(isAzureStyleBaseUrl('https://myres.cognitiveservices.azure.com', plainEnv)).toBe(true)
  expect(isAzureStyleBaseUrl('https://myres.services.ai.azure.com/models', plainEnv)).toBe(true)
  expect(isAzureStyleBaseUrl('https://myres.inference.ml.azure.com', plainEnv)).toBe(true)
  // Azure-hosted custom gateways are not Azure OpenAI endpoints merely because
  // their resource name contains an Azure marker.
  expect(isAzureStyleBaseUrl('https://openai-proxy.web.azure.com/v1', plainEnv)).toBe(false)
  // .azure.com alone is not enough without a supported service suffix.
  expect(isAzureStyleBaseUrl('https://myapp.web.azure.com', plainEnv)).toBe(false)
})
