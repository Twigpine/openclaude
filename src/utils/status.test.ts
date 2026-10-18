import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

import { DEFAULT_CODEX_BASE_URL } from '../services/api/providerConfig.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

const ORIGINAL_ENV = { ...process.env }

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

async function readPropertyValue(
  label: string,
  provider:
    | 'firstParty'
    | 'bedrock'
    | 'vertex'
    | 'foundry'
    | 'openai'
    | 'codex'
    | 'nvidia-nim'
    | 'minimax',
): Promise<unknown> {
  mock.restore()
  mock.module('./model/providers.js', () => ({
    getAPIProvider: () => provider,
    getAPIProviderForStatsig: () => provider,
    isFirstPartyAnthropicBaseUrl: () => true,
    isGithubNativeAnthropicMode: () => false,
  }))
  const nonce = `${Date.now()}-${Math.random()}`
  const { buildAPIProviderProperties } = await import(`./status.js?ts=${nonce}`)
  return buildAPIProviderProperties().find(property => property.label === label)
    ?.value
}

async function readAPIProviderProperties(
  provider:
    | 'firstParty'
    | 'bedrock'
    | 'vertex'
    | 'foundry'
    | 'openai'
    | 'gemini'
    | 'mistral',
) {
  mock.restore()
  mock.module('./model/providers.js', () => ({
    getAPIProvider: () => provider,
    getAPIProviderForStatsig: () => provider,
    isFirstPartyAnthropicBaseUrl: () => true,
    isGithubNativeAnthropicMode: () => false,
  }))
  mock.module('./mtls.js', () => ({
    getMTLSConfig: () => undefined,
  }))
  const nonce = `${Date.now()}-${Math.random()}`
  const { buildAPIProviderProperties } = await import(`./status.js?ts=${nonce}`)
  return buildAPIProviderProperties()
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/status.test.ts')
})

afterEach(() => {
  try {
    mock.restore()
    restoreEnv()
  } finally {
    releaseSharedMutationLock()
  }
})

test('buildAPIProviderProperties labels NVIDIA NIM sessions', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.NVIDIA_NIM = '1'
  process.env.OPENAI_BASE_URL = 'https://integrate.api.nvidia.com/v1'
  process.env.OPENAI_MODEL = 'nvidia/llama-3.1-nemotron-70b-instruct'

  expect(await readPropertyValue('API provider', 'nvidia-nim')).toBe('NVIDIA NIM')
  expect(await readPropertyValue('NVIDIA NIM base URL', 'nvidia-nim')).toBe(
    'https://integrate.api.nvidia.com/v1',
  )
  expect(await readPropertyValue('Model', 'nvidia-nim')).toBe(
    'nvidia/llama-3.1-nemotron-70b-instruct',
  )
})

test('buildAPIProviderProperties labels MiniMax sessions', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.MINIMAX_API_KEY = 'minimax-key'
  process.env.OPENAI_BASE_URL = 'https://api.minimax.chat/v1'
  process.env.OPENAI_MODEL = 'MiniMax-M2.5'

  expect(await readPropertyValue('API provider', 'minimax')).toBe('MiniMax')
  expect(await readPropertyValue('MiniMax base URL', 'minimax')).toBe(
    'https://api.minimax.chat/v1',
  )
  expect(await readPropertyValue('Model', 'minimax')).toBe('MiniMax-M2.5')
})

test('buildAPIProviderProperties keeps Codex-specific labels on the shared OpenAI-compatible path', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = DEFAULT_CODEX_BASE_URL
  process.env.OPENAI_MODEL = 'codexplan'
  process.env.CHATGPT_ACCOUNT_ID = 'acct_123'

  expect(await readPropertyValue('API provider', 'codex')).toBe('Codex')
  expect(await readPropertyValue('Codex base URL', 'codex')).toBe(
    DEFAULT_CODEX_BASE_URL,
  )
  expect(await readPropertyValue('Model', 'codex')).toBe(
    'gpt-5.6-sol (high)',
  )
})

test('buildAPIProviderProperties redacts credentials in OpenAI-compatible base URLs', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL =
    'https://user:pass@example.com/v1?api_key=sk-statusLeak1234567890ABCdef&model=qwen'

  expect(await readPropertyValue('OpenAI base URL', 'openai')).toBe(
    'https://redacted:redacted@example.com/v1?api_key=redacted&model=qwen',
  )
})

test('buildAPIProviderProperties uses the resolved route label for AI/ML API sessions', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.aimlapi.com/v1'
  process.env.OPENAI_MODEL = 'gpt-4o'

  expect(await readPropertyValue('Provider route', 'openai')).toBe('aimlapi.com')
  expect(await readPropertyValue('OpenAI base URL', 'openai')).toBe(
    'https://api.aimlapi.com/v1',
  )
  expect(await readPropertyValue('Model', 'openai')).toBe('gpt-4o')
})

test('buildAPIProviderProperties redacts token-bearing OpenAI-compatible base URLs', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL =
    'https://api.example.test/v1?token=OPENAI_LEAK&mode=test#access_token=fragment-leak'

  const properties = await readAPIProviderProperties('openai')
  const value = properties.find(property => property.label === 'OpenAI base URL')
    ?.value

  expect(value).toBe('https://api.example.test/v1?token=redacted&mode=test')
  const serialized = JSON.stringify(properties)
  expect(serialized).not.toContain('OPENAI_LEAK')
  expect(serialized).not.toContain('fragment-leak')
})

test('buildAPIProviderProperties does not substring-redact short configured secrets', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1?credential=1'
  process.env.OPENAI_MODEL = 'gpt-4.1'
  process.env.OPENAI_API_KEY = '1'

  const properties = await readAPIProviderProperties('openai')

  expect(properties.find(property => property.label === 'OpenAI base URL')?.value).toBe(
    'https://api.openai.com/v1?credential=redacted',
  )
  expect(properties.find(property => property.label === 'Model')?.value).toBe(
    'gpt-4.1',
  )
})

test('buildAPIProviderProperties redacts double-encoded configured secrets outside URL query values', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL =
    'https://api.openai.com/abc%252FdefSecret987/v1'
  process.env.OPENAI_MODEL = 'gpt-4o abc%252FdefSecret987'
  process.env.OPENAI_API_KEY = 'abc/defSecret987'

  const properties = await readAPIProviderProperties('openai')

  expect(properties.find(property => property.label === 'OpenAI base URL')?.value).toBe(
    'https://api.openai.com/redacted/v1',
  )
  expect(properties.find(property => property.label === 'Model')?.value).toBe(
    'gpt-4o redacted',
  )
  const serialized = JSON.stringify(properties)
  expect(serialized).not.toContain('abc%252FdefSecret987')
})

test('buildAPIProviderProperties redacts percent-encoded configured secret punctuation outside URL query values', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL =
    'https://api.openai.com/abc%21defSecret987/v1'
  process.env.OPENAI_MODEL = 'gpt-4o abc%21defSecret987'
  process.env.OPENAI_API_KEY = 'abc!defSecret987'

  const properties = await readAPIProviderProperties('openai')

  expect(properties.find(property => property.label === 'OpenAI base URL')?.value).toBe(
    'https://api.openai.com/redacted/v1',
  )
  expect(properties.find(property => property.label === 'Model')?.value).toBe(
    'gpt-4o redacted',
  )
  const serialized = JSON.stringify(properties)
  expect(serialized).not.toContain('abc%21defSecret987')
})

test('buildAPIProviderProperties redacts token-bearing Gemini base URLs', async () => {
  process.env.CLAUDE_CODE_USE_GEMINI = '1'
  process.env.GEMINI_BASE_URL =
    'https://gemini.example.test/v1?api_key=GEMINI_LEAK&mode=test#secret=fragment-leak'

  const properties = await readAPIProviderProperties('gemini')
  const value = properties.find(property => property.label === 'Gemini base URL')
    ?.value

  expect(value).toBe('https://gemini.example.test/v1?api_key=redacted&mode=test')
  const serialized = JSON.stringify(properties)
  expect(serialized).not.toContain('GEMINI_LEAK')
  expect(serialized).not.toContain('fragment-leak')
})

test('buildAPIProviderProperties redacts token-bearing direct provider base URLs', async () => {
  const cases = [
    {
      provider: 'firstParty' as const,
      env: 'ANTHROPIC_BASE_URL',
      label: 'Anthropic base URL',
    },
    {
      provider: 'bedrock' as const,
      env: 'BEDROCK_BASE_URL',
      label: 'Bedrock base URL',
    },
    {
      provider: 'vertex' as const,
      env: 'VERTEX_BASE_URL',
      label: 'Vertex base URL',
    },
    {
      provider: 'foundry' as const,
      env: 'ANTHROPIC_FOUNDRY_BASE_URL',
      label: 'Microsoft Foundry base URL',
    },
    {
      provider: 'mistral' as const,
      env: 'MISTRAL_BASE_URL',
      label: 'Mistral base URL',
    },
  ]

  for (const { provider, env, label } of cases) {
    restoreEnv()
    const host = provider.toLowerCase()
    process.env[env] =
      `https://${host}.example.test/v1?authorization=${provider}-leak&mode=test#token=fragment-leak`

    const properties = await readAPIProviderProperties(provider)
    const value = properties.find(property => property.label === label)?.value

    expect(value).toBe(
      `https://${host}.example.test/v1?authorization=redacted&mode=test`,
    )
    const serialized = JSON.stringify(properties)
    expect(serialized).not.toContain(`${provider}-leak`)
    expect(serialized).not.toContain('fragment-leak')
  }
})

test('buildAPIProviderProperties redacts proxy credentials and mTLS paths', async () => {
  const home = '/home/openclaude-status-test'
  process.env.HOME = home
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.http_proxy
  delete process.env.https_proxy
  delete process.env.HTTP_PROXY
  process.env.HTTPS_PROXY = 'https://alice:secret@proxy.example.com:8080'
  process.env.NODE_EXTRA_CA_CERTS = `${home}/.config/ca-bundle.crt`
  process.env.CLAUDE_CODE_CLIENT_CERT = `${home}/.config/client.crt`
  process.env.CLAUDE_CODE_CLIENT_KEY = `${home}/.config/client.key`

  mock.restore()
  mock.module('./model/providers.js', () => ({
    getAPIProvider: () => 'openai',
    getAPIProviderForStatsig: () => 'openai',
    isFirstPartyAnthropicBaseUrl: () => true,
    isGithubNativeAnthropicMode: () => false,
  }))
  // getProxyUrl accepts env directly (not memoized), so no stub needed.
  mock.module('./mtls.js', () => ({
    getMTLSConfig: () => ({
      cert: 'loaded-cert',
      key: 'loaded-key',
    }),
  }))

  const nonce = `${Date.now()}-${Math.random()}`
  const { buildAPIProviderProperties } = await import(`./status.js?ts=${nonce}`)
  const properties = buildAPIProviderProperties()
  const byLabel = (label: string): unknown =>
    properties.find(property => property.label === label)?.value

  // Proxy URL is fully redacted: no username, no password.
  expect(byLabel('Proxy')).toBe(
    'https://redacted:redacted@proxy.example.com:8080/',
  )

  // CA cert path: home directory shortened to ~.
  expect(byLabel('Additional CA cert(s)')).toBe('~/.config/ca-bundle.crt')

  // mTLS cert path: home directory shortened to ~.
  expect(byLabel('mTLS client cert')).toBe('~/.config/client.crt')

  // mTLS client key: never reveal the private key path.
  expect(byLabel('mTLS client key')).toBe('configured')

  // No raw secrets leak into any property value. Cover every home-directory
  // source redactPathForStatus consults (HOME, USERPROFILE, os.homedir()).
  const serialized = JSON.stringify(properties)
  expect(serialized).not.toContain('alice')
  expect(serialized).not.toContain('secret')
  const homeCandidates = [
    process.env.HOME,
    process.env.USERPROFILE,
  ].filter((v): v is string => Boolean(v))
  for (const candidate of homeCandidates) {
    expect(serialized).not.toContain(candidate)
  }
})

test('buildAPIProviderProperties redacts proxy credentials from lowercase https_proxy', async () => {
  // getProxyUrl() prefers the lowercase variant. Confirm the redaction path
  // covers it — both env spellings flow through the same redactUrlForStatus.
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.http_proxy
  delete process.env.HTTPS_PROXY
  delete process.env.HTTP_PROXY
  process.env.https_proxy = 'https://bob:hunter2@proxy.example.com:9090'

  mock.restore()
  mock.module('./model/providers.js', () => ({
    getAPIProvider: () => 'openai',
    getAPIProviderForStatsig: () => 'openai',
    isFirstPartyAnthropicBaseUrl: () => true,
    isGithubNativeAnthropicMode: () => false,
  }))
  mock.module('./mtls.js', () => ({
    getMTLSConfig: () => undefined,
  }))

  const nonce = `${Date.now()}-${Math.random()}`
  const { buildAPIProviderProperties } = await import(`./status.js?ts=${nonce}`)
  const properties = buildAPIProviderProperties()
  const byLabel = (label: string): unknown =>
    properties.find(property => property.label === label)?.value

  expect(byLabel('Proxy')).toBe(
    'https://redacted:redacted@proxy.example.com:9090/',
  )

  const serialized = JSON.stringify(properties)
  expect(serialized).not.toContain('bob')
  expect(serialized).not.toContain('hunter2')
})
