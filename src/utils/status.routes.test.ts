import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

const ORIGINAL_ENV = { ...process.env }

// Provider env vars influence route resolution. Clear by prefix before every
// test so assertions stay deterministic regardless of the developer shell.
const PROVIDER_ENV_PREFIXES = [
  'ANTHROPIC_',
  'ATLAS_',
  'AWS_',
  'BEDROCK_',
  'BNKR_',
  'CLAUDE_CODE_PROVIDER_PROFILE_',
  'CLAUDE_CODE_USE_',
  'DASHSCOPE_',
  'DEEPSEEK_',
  'FIREWORKS_',
  'GEMINI_',
  'GITHUB_',
  'GOOGLE_',
  'GROQ_',
  'LONGCAT_',
  'MINIMAX_',
  'MIMO_',
  'MISTRAL_',
  'MOONSHOT_',
  'NEARAI_',
  'NVIDIA_',
  'OLLAMA_',
  'OPENAI_',
  'OPENGATEWAY_',
  'OPENROUTER_',
  'VENICE_',
  'VERTEX_',
  'XAI_',
  'XIAOMI_MIMO_',
  'ZAI_',
]

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key]
    }
  }

  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

function clearProviderEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (PROVIDER_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) {
      delete process.env[key]
    }
  }
}

async function restoreProviderModule(): Promise<void> {
  mock.restore()
  const nonce = `${Date.now()}-${Math.random()}`
  const actualProviders = await import(`./model/providers.js?restore=${nonce}`)
  mock.module('./model/providers.js', () => ({
    ...actualProviders,
  }))
}

async function buildPropertiesWithProvider(
  _provider: string,
): Promise<Array<{ label?: string; value: unknown }>> {
  return buildPropertiesWithRealProvider()
}

async function buildPropertiesWithRealProvider(): Promise<
  Array<{ label?: string; value: unknown }>
> {
  await restoreProviderModule()
  const nonce = `${Date.now()}-${Math.random()}`
  const { buildAPIProviderProperties } = await import(`./status.js?ts=${nonce}`)
  return buildAPIProviderProperties()
}

function findValue(
  properties: Array<{ label?: string; value: unknown }>,
  label: string,
): unknown {
  return properties.find(property => property.label === label)?.value
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/status.routes.test.ts')
  await restoreProviderModule()
  clearProviderEnv()
})

afterEach(async () => {
  try {
    await restoreProviderModule()
    restoreEnv()
  } finally {
    releaseSharedMutationLock()
  }
})

test('OpenAI route resolves to the OpenAI route label', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_MODEL = 'gpt-4o'
  process.env.OPENAI_API_KEY = 'sk-test-openai-key'

  const properties = await buildPropertiesWithProvider('openai')
  expect(findValue(properties, 'Provider route')).toBe('OpenAI')
  expect(findValue(properties, 'Transport')).toBe('OpenAI-compatible API')
  expect(findValue(properties, 'Model')).toBe('gpt-4o')
  const credential = findValue(properties, 'Credential') as
    | string
    | undefined
  expect(credential).toContain('OPENAI_API_KEY')
  expect(credential).not.toContain('sk-test-openai-key')
})

test('Ollama route shows local route details', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  process.env.OPENAI_MODEL = 'llama3.2'

  const properties = await buildPropertiesWithProvider('openai')
  expect(findValue(properties, 'Provider route')).toBe('Ollama')
  expect(findValue(properties, 'Transport')).toBe('OpenAI-compatible API')
  expect(findValue(properties, 'Model')).toBe('llama3.2')
})

test('OpenRouter route shows its route label instead of OpenAI-compatible', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'
  process.env.OPENAI_MODEL = 'anthropic/claude-sonnet-4.5'
  process.env.OPENROUTER_API_KEY = 'sk-or-test-key'

  const properties = await buildPropertiesWithProvider('openai')
  expect(findValue(properties, 'Provider route')).toBe('OpenRouter')
  expect(findValue(properties, 'API provider')).toBeUndefined()
  const credential = findValue(properties, 'Credential') as
    | string
    | undefined
  expect(credential).toContain('OPENROUTER_API_KEY')
  expect(credential).not.toContain('sk-or-test-key')
})

test('OpenRouter route displays OPENAI_API_BASE when it selected the route', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_API_BASE = 'https://openrouter.ai/api/v1'
  process.env.OPENAI_MODEL = 'anthropic/claude-sonnet-4.5'
  process.env.OPENROUTER_API_KEY = 'sk-or-test-key'

  const properties = await buildPropertiesWithRealProvider()
  expect(findValue(properties, 'Provider route')).toBe('OpenRouter')
  expect(findValue(properties, 'OpenAI base URL')).toBe(
    'https://openrouter.ai/api/v1',
  )
})

test('OPENAI_API_BASE query credentials are redacted from status display', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_API_BASE =
    'https://openrouter.ai/api/v1?api_key=sk-or-query-secret&timeout=30'
  process.env.OPENAI_MODEL = 'anthropic/claude-sonnet-4.5'
  process.env.OPENROUTER_API_KEY = 'sk-or-test-key'

  const properties = await buildPropertiesWithRealProvider()
  expect(findValue(properties, 'OpenAI base URL')).toBe(
    'https://openrouter.ai/api/v1?api_key=redacted&timeout=30',
  )
  expect(JSON.stringify(properties)).not.toContain('sk-or-query-secret')
})

test('OPENAI_API_BASE fragments are removed from status display', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_API_BASE =
    'https://openrouter.ai/api/v1?api_key=querysecret#access_token=fragsecret'
  process.env.OPENAI_MODEL = 'anthropic/claude-sonnet-4.5'
  process.env.OPENROUTER_API_KEY = 'sk-or-test-key'

  const properties = await buildPropertiesWithRealProvider()
  expect(findValue(properties, 'OpenAI base URL')).toBe(
    'https://openrouter.ai/api/v1?api_key=redacted',
  )
  expect(JSON.stringify(properties)).not.toContain('fragsecret')
})

test('configured route secrets inside base URL query values are redacted', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_API_BASE =
    'https://openrouter.ai/api/v1?credential=sk-or-query-secret&timeout=30'
  process.env.OPENAI_MODEL = 'anthropic/claude-sonnet-4.5'
  process.env.OPENROUTER_API_KEY = 'sk-or-query-secret'

  const properties = await buildPropertiesWithRealProvider()
  expect(findValue(properties, 'OpenAI base URL')).toBe(
    'https://openrouter.ai/api/v1?credential=redacted&timeout=30',
  )
  expect(JSON.stringify(properties)).not.toContain('sk-or-query-secret')
})

test('URL-encoded configured route secrets inside base URL query values are redacted', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_API_BASE =
    'https://openrouter.ai/api/v1?credential=abc%2Fdef%2Bghi%3D&timeout=30'
  process.env.OPENAI_MODEL = 'anthropic/claude-sonnet-4.5'
  process.env.OPENROUTER_API_KEY = 'abc/def+ghi='

  const properties = await buildPropertiesWithRealProvider()
  expect(findValue(properties, 'OpenAI base URL')).toBe(
    'https://openrouter.ai/api/v1?credential=redacted&timeout=30',
  )
  const serialized = JSON.stringify(properties)
  expect(serialized).not.toContain('abc/def+ghi=')
  expect(serialized).not.toContain('abc%2Fdef%2Bghi%3D')
})

test('form-encoded configured route secrets inside base URL query values are redacted', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_API_BASE =
    'https://openrouter.ai/api/v1?auth=Bearer+abc&credential=abc%27def&timeout=30'
  process.env.OPENAI_MODEL = 'anthropic/claude-sonnet-4.5'
  process.env.OPENAI_AUTH_HEADER_VALUE = 'Bearer abc'
  process.env.OPENROUTER_API_KEY = "abc'def"

  const properties = await buildPropertiesWithRealProvider()
  expect(findValue(properties, 'OpenAI base URL')).toBe(
    'https://openrouter.ai/api/v1?auth=redacted&credential=redacted&timeout=30',
  )
  const serialized = JSON.stringify(properties)
  expect(serialized).not.toContain('Bearer+abc')
  expect(serialized).not.toContain('abc%27def')
})

test('double-encoded configured route secrets inside base URL query values are redacted', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_API_BASE =
    'https://openrouter.ai/api/v1?debug=abc%252FdefSecret987&header=Bearer%2520abc&form=Bearer%2Babc&plus=longplussecret%252Bvalue&timeout=30'
  process.env.OPENAI_MODEL = 'anthropic/claude-sonnet-4.5'
  process.env.OPENROUTER_API_KEY = 'abc/defSecret987'
  process.env.OPENAI_AUTH_HEADER_VALUE = 'Bearer abc'
  process.env.OPENAI_API_KEY = 'longplussecret+value'

  const properties = await buildPropertiesWithRealProvider()
  expect(findValue(properties, 'OpenAI base URL')).toBe(
    'https://openrouter.ai/api/v1?debug=redacted&header=redacted&form=redacted&plus=redacted&timeout=30',
  )
  const serialized = JSON.stringify(properties)
  expect(serialized).not.toContain('abc%252FdefSecret987')
  expect(serialized).not.toContain('Bearer%2520abc')
  expect(serialized).not.toContain('Bearer%2Babc')
  expect(serialized).not.toContain('longplussecret%252Bvalue')
})

test('blank OPENAI_BASE_URL falls back to OPENAI_API_BASE for route display', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = '   '
  process.env.OPENAI_API_BASE = ' https://openrouter.ai/api/v1 '
  process.env.OPENAI_MODEL = 'anthropic/claude-sonnet-4.5'
  process.env.OPENROUTER_API_KEY = 'sk-or-test-key'

  const properties = await buildPropertiesWithRealProvider()
  expect(findValue(properties, 'Provider route')).toBe('OpenRouter')
  expect(findValue(properties, 'OpenAI base URL')).toBe(
    'https://openrouter.ai/api/v1',
  )
})

test('Groq route shows its route label instead of OpenAI-compatible', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.groq.com/openai/v1'
  process.env.OPENAI_MODEL = 'llama-3.3-70b-versatile'
  process.env.GROQ_API_KEY = 'gsk_test-key'

  const properties = await buildPropertiesWithProvider('openai')
  expect(findValue(properties, 'Provider route')).toBe('Groq')
  expect(findValue(properties, 'API provider')).toBeUndefined()
  expect(
    (findValue(properties, 'Credential') as string | undefined)?.includes(
      'GROQ_API_KEY',
    ),
  ).toBe(true)
})

test('route-specific credential values are redacted from displayed fields', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.groq.com/openai/v1'
  process.env.OPENAI_MODEL = 'gsk-route-secret-value-123'
  process.env.GROQ_API_KEY = 'gsk-route-secret-value-123'

  const properties = await buildPropertiesWithRealProvider()
  const serialized = JSON.stringify(properties)
  expect(serialized).not.toContain('gsk-route-secret-value-123')
  expect(findValue(properties, 'Model')).toBe('gsk...123')
})

test('route-specific credential substrings are redacted from displayed model fields', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'
  process.env.OPENAI_MODEL = 'prefix-sk-or-SECRET-VALUE-123-suffix'
  process.env.OPENROUTER_API_KEY = 'sk-or-SECRET-VALUE-123'

  const properties = await buildPropertiesWithRealProvider()
  const serialized = JSON.stringify(properties)
  expect(serialized).not.toContain('sk-or-SECRET-VALUE-123')
  expect(findValue(properties, 'Model')).toBe('prefix-redacted-suffix')
})

test('env-only Fireworks route displays descriptor defaults', async () => {
  process.env.FIREWORKS_API_KEY = 'fw-test-key'

  const properties = await buildPropertiesWithRealProvider()
  expect(findValue(properties, 'Provider route')).toBe('Fireworks AI')
  expect(findValue(properties, 'OpenAI base URL')).toBe(
    'https://api.fireworks.ai/inference/v1',
  )
  expect(findValue(properties, 'Model')).toBe(
    'accounts/fireworks/models/llama-v3p1-70b-instruct',
  )
  expect(findValue(properties, 'Credential')).toBe(
    'FIREWORKS_API_KEY configured',
  )
})

test('Gemini route remains clear', async () => {
  process.env.CLAUDE_CODE_USE_GEMINI = '1'
  process.env.GEMINI_MODEL = 'gemini-2.0-flash'
  process.env.GEMINI_API_KEY = 'gem-test-key'

  const properties = await buildPropertiesWithProvider('gemini')
  expect(findValue(properties, 'API provider')).toBe('Google AI / Gemini')
  // Gemini has a native transport; route-aware block does not override it.
  expect(findValue(properties, 'Provider route')).toBeUndefined()
  expect(findValue(properties, 'Model')).toBe('gemini-2.0-flash')
})

test('GitHub route remains clear', async () => {
  process.env.CLAUDE_CODE_USE_GITHUB = '1'
  process.env.OPENAI_BASE_URL = 'https://models.inference.ai.azure.com'
  process.env.OPENAI_MODEL = 'gpt-4o'

  const properties = await buildPropertiesWithProvider('github')
  // GitHub has a dedicated bucket; route-aware block does not override it.
  expect(findValue(properties, 'API provider')).toBe('GitHub Models')
  expect(findValue(properties, 'Provider route')).toBeUndefined()
})

test('unknown custom route falls back gracefully', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://my-internal-proxy.example.com/v1'
  process.env.OPENAI_MODEL = 'internal-model'
  process.env.OPENAI_API_KEY = 'sk-internal-key'

  const properties = await buildPropertiesWithProvider('openai')
  // No known route -> legacy "OpenAI-compatible" bucket is preserved.
  expect(findValue(properties, 'API provider')).toBe('OpenAI-compatible')
  expect(findValue(properties, 'Provider route')).toBeUndefined()
  expect(findValue(properties, 'Model')).toBe('internal-model')
})

test('secrets are never leaked in status properties', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'
  process.env.OPENAI_MODEL = 'anthropic/claude-sonnet-4.5'
  process.env.OPENROUTER_API_KEY = 'sk-or-SECRET-VALUE-123'
  process.env.OPENAI_API_KEY = 'sk-SECRET-VALUE-456'

  const properties = await buildPropertiesWithProvider('openai')
  const serialized = JSON.stringify(properties)
  expect(serialized).not.toContain('sk-or-SECRET-VALUE-123')
  expect(serialized).not.toContain('sk-SECRET-VALUE-456')
})

test('end-to-end: real getAPIProvider resolves OpenRouter without mocking', async () => {
  // Do NOT mock getAPIProvider. Verify the full chain: env -> getAPIProvider
  // collapses to 'openai' -> route resolution surfaces 'OpenRouter'.
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'
  process.env.OPENAI_MODEL = 'anthropic/claude-sonnet-4.5'
  process.env.OPENROUTER_API_KEY = 'sk-or-test-key'

  const properties = await buildPropertiesWithRealProvider()
  expect(findValue(properties, 'Provider route')).toBe('OpenRouter')
  expect(findValue(properties, 'API provider')).toBeUndefined()
  expect(findValue(properties, 'Transport')).toBe('OpenAI-compatible API')
})

test('credential summary lists only configured env vars when multiple are known', async () => {
  // OpenRouter knows OPENROUTER_API_KEY and OPENAI_API_KEY. Configure only one.
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'
  process.env.OPENAI_MODEL = 'anthropic/claude-sonnet-4.5'
  process.env.OPENROUTER_API_KEY = 'sk-or-test-key'
  // OPENAI_API_KEY intentionally left unset.

  const properties = await buildPropertiesWithProvider('openai')
  const credential = findValue(properties, 'Credential') as
    | string
    | undefined
  expect(credential).toContain('OPENROUTER_API_KEY')
  expect(credential).not.toContain('OPENAI_API_KEY')
})

test('route-aware label is omitted when no credential env var is configured', async () => {
  // Ollama is a local route with no required credential env var.
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  process.env.OPENAI_MODEL = 'llama3.2'

  const properties = await buildPropertiesWithProvider('openai')
  expect(findValue(properties, 'Provider route')).toBe('Ollama')
  expect(findValue(properties, 'Credential')).toBeUndefined()
})
