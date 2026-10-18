import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import {
  parseProviderFlag,
  parseModelFlag,
  applyProviderFlag,
  applyProviderFlagFromArgs,
  reapplyRememberedProviderFlag,
  clearRememberedProviderFlagForTests,
  applyModelFlagFromArgs,
  VALID_PROVIDERS,
} from './providerFlag.js'
import { resolveActiveRouteIdFromEnv } from '../integrations/routeMetadata.js'

const ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'OPENAI_API_FORMAT',
  'OPENAI_AZURE_STYLE',
  'OPENAI_AUTH_HEADER',
  'OPENAI_AUTH_SCHEME',
  'OPENAI_AUTH_HEADER_VALUE',
  'LLMTR_API_KEY',
  'CMD_API_KEY',
  'COMMANDCODE_API_KEY',
  'COMMAND_CODE_API_KEY',
  'GEMINI_MODEL',
  'NVIDIA_API_KEY',
  'NVIDIA_NIM',
  'BNKR_API_KEY',
  'XAI_API_KEY',
  'MINIMAX_API_KEY',
  'VENICE_API_KEY',
  'MIMO_API_KEY',
  'ATLAS_CLOUD_API_KEY',
  'GMI_API_KEY',
  'GMI_MODEL',
  'APISMART_API_KEY',
  'APISMART_MODEL',
  'API_ROUTE_API_KEY',
  'API_ROUTE_MODEL',
  'CONCENTRATE_API_KEY',
  'CONCENTRATE_BASE_URL',
  'CONCENTRATE_MODEL',
  'LONGCAT_API_KEY',
  'OPENGATEWAY_API_KEY',
  'OPENGATEWAY_BASE_URL',
  'CLOUDFLARE_API_TOKEN',
  'MISTRAL_MODEL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'USER_TYPE',
]

const originalEnv: Record<string, string | undefined> = {}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/providerFlag.test.ts')
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key]
    delete process.env[key]
  }
})

const RESET_KEYS = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'OPENAI_API_FORMAT',
  'OPENAI_AZURE_STYLE',
  'OPENAI_AUTH_HEADER',
  'OPENAI_AUTH_SCHEME',
  'OPENAI_AUTH_HEADER_VALUE',
  'GEMINI_MODEL',
  'NVIDIA_API_KEY',
  'NVIDIA_NIM',
  'BNKR_API_KEY',
  'XAI_API_KEY',
  'MINIMAX_API_KEY',
  'VENICE_API_KEY',
  'MIMO_API_KEY',
  'ATLAS_CLOUD_API_KEY',
  'GMI_API_KEY',
  'GMI_MODEL',
  'APISMART_API_KEY',
  'APISMART_MODEL',
  'API_ROUTE_API_KEY',
  'API_ROUTE_MODEL',
  'CONCENTRATE_API_KEY',
  'CONCENTRATE_BASE_URL',
  'CONCENTRATE_MODEL',
  'LONGCAT_API_KEY',
  'OPENGATEWAY_API_KEY',
  'OPENGATEWAY_BASE_URL',
  'CLOUDFLARE_API_TOKEN',
  'MISTRAL_MODEL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'USER_TYPE',
] as const

beforeEach(() => {
  clearRememberedProviderFlagForTests()
  for (const key of RESET_KEYS) {
    delete process.env[key]
  }
})

afterEach(() => {
  try {
    clearRememberedProviderFlagForTests()
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = originalEnv[key]
      }
    }
  } finally {
    releaseSharedMutationLock()
  }
})

// --- parseProviderFlag ---

describe('parseProviderFlag', () => {
  test('returns provider name when --provider flag present', () => {
    expect(parseProviderFlag(['--provider', 'openai'])).toBe('openai')
  })

  test('returns provider name when --provider uses inline syntax', () => {
    expect(parseProviderFlag(['--provider=anthropic'])).toBe('anthropic')
  })

  test('uses the final provider occurrence across spaced and inline syntax', () => {
    expect(
      parseProviderFlag(['--provider', 'anthropic', '--provider=openai']),
    ).toBe('openai')
    expect(
      parseProviderFlag(['--provider=commandcode', '--provider', 'anthropic']),
    ).toBe('anthropic')
  })

  test('returns provider name with --model alongside', () => {
    expect(parseProviderFlag(['--provider', 'gemini', '--model', 'gemini-2.0-flash'])).toBe('gemini')
  })

  test('returns null when --provider flag absent', () => {
    expect(parseProviderFlag(['--model', 'gpt-4o'])).toBeNull()
  })

  test('returns null for empty args', () => {
    expect(parseProviderFlag([])).toBeNull()
  })

  test('returns null when --provider has no value', () => {
    expect(parseProviderFlag(['--provider'])).toBeNull()
  })

  test('returns null when inline --provider has no value', () => {
    expect(parseProviderFlag(['--provider='])).toBeNull()
  })

  test('ignores provider-looking values consumed by another root option', () => {
    expect(
      parseProviderFlag(['--system-prompt', '--provider=commandcode']),
    ).toBeNull()
  })

  test('ignores provider-looking prompt text after the option delimiter', () => {
    expect(parseProviderFlag(['--', '--provider=commandcode'])).toBeNull()
  })

  test('returns null when --provider value starts with --', () => {
    expect(parseProviderFlag(['--provider', '--model'])).toBeNull()
  })
})

// --- applyProviderFlag ---

describe('applyProviderFlag - anthropic', () => {
  test('sets no env vars for anthropic (default)', () => {
    const result = applyProviderFlag('anthropic', [])
    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_GEMINI).toBeUndefined()
  })

  test('clears a previously selected custom Anthropic endpoint', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example/v1'
    process.env.ANTHROPIC_MODEL = 'proxy-model'
    process.env.ANTHROPIC_API_KEY = 'proxy-api-key'
    process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-token'
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'x-tenant: example'

    const result = applyProviderFlag('anthropic', [])

    expect(result.error).toBeUndefined()
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(process.env.ANTHROPIC_MODEL).toBeUndefined()
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined()
  })

  test('preserves a first-party Anthropic API key', () => {
    process.env.ANTHROPIC_API_KEY = 'first-party-key'

    const result = applyProviderFlag('anthropic', [])

    expect(result.error).toBeUndefined()
    expect(process.env.ANTHROPIC_API_KEY).toBe('first-party-key')
  })

  test('does not leave ApiSmart env-only selection active', () => {
    process.env.APISMART_API_KEY = 'apismart-key'
    process.env.APISMART_MODEL = 'KIMI_K3'

    applyProviderFlag('anthropic', [])

    expect(process.env.APISMART_API_KEY).toBeUndefined()
    expect(process.env.APISMART_MODEL).toBeUndefined()
  })

  test('does not leave Concentrate env-only selection active', () => {
    process.env.CONCENTRATE_API_KEY = 'concentrate-key'
    process.env.CONCENTRATE_BASE_URL = 'https://api.concentrate.ai/v1'
    process.env.CONCENTRATE_MODEL = 'claude-sonnet-5'
    applyProviderFlag('anthropic', [])
    expect(process.env.CONCENTRATE_API_KEY).toBeUndefined()
    expect(process.env.CONCENTRATE_BASE_URL).toBeUndefined()
    expect(process.env.CONCENTRATE_MODEL).toBeUndefined()
  })
})

describe('applyProviderFlag - custom Anthropic-compatible', () => {
  test('requires a custom endpoint instead of sending its credential to Anthropic', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-token'

    const result = applyProviderFlag('custom-anthropic', [])

    expect(result.error).toContain('ANTHROPIC_BASE_URL')
  })

  test('rejects the first-party Anthropic endpoint instead of forwarding a custom credential', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
    process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-token'

    const result = applyProviderFlag('custom-anthropic', [])

    expect(result.error).toContain('non-Anthropic ANTHROPIC_BASE_URL')
  })

  test('rejects the internal first-party Anthropic staging endpoint', () => {
    process.env.USER_TYPE = 'ant'
    process.env.ANTHROPIC_BASE_URL = 'https://api-staging.anthropic.com'
    process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-token'

    const result = applyProviderFlag('custom-anthropic', [])

    expect(result.error).toContain('non-Anthropic ANTHROPIC_BASE_URL')
  })

  test('keeps native Anthropic routing and applies --model', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example/v1'
    process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-token'
    process.env.ANTHROPIC_API_KEY = 'stale-anthropic-key'
    process.env.CLAUDE_CODE_USE_FOUNDRY = '1'
    process.env.OPENAI_BASE_URL = 'https://stale.example/v1'
    process.env.OPENAI_API_BASE = 'https://stale.example/v1'
    process.env.OPENAI_API_FORMAT = 'responses'
    process.env.OPENAI_AUTH_HEADER = 'Authorization'
    process.env.OPENAI_AUTH_SCHEME = 'bearer'
    process.env.OPENAI_AUTH_HEADER_VALUE = 'stale-token'

    const result = applyProviderFlag('custom-anthropic', ['--model', 'proxy-model'])

    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_FOUNDRY).toBeUndefined()
    expect(process.env.OPENAI_MODEL).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBeUndefined()
    expect(process.env.OPENAI_API_BASE).toBeUndefined()
    expect(process.env.OPENAI_API_FORMAT).toBeUndefined()
    expect(process.env.OPENAI_AUTH_HEADER).toBeUndefined()
    expect(process.env.OPENAI_AUTH_SCHEME).toBeUndefined()
    expect(process.env.OPENAI_AUTH_HEADER_VALUE).toBeUndefined()
    expect(process.env.ANTHROPIC_BASE_URL).toBe('https://proxy.example/v1')
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('proxy-token')
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(process.env.ANTHROPIC_MODEL).toBe('proxy-model')
  })

  test('does not leave Concentrate env-only selection active', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example/v1'
    process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-token'
    process.env.CONCENTRATE_API_KEY = 'concentrate-key'
    process.env.CONCENTRATE_BASE_URL = 'https://api.concentrate.ai/v1'
    process.env.CONCENTRATE_MODEL = 'claude-sonnet-5'

    const result = applyProviderFlag('custom-anthropic', [])

    expect(result.error).toBeUndefined()
    expect(process.env.CONCENTRATE_API_KEY).toBeUndefined()
    expect(process.env.CONCENTRATE_BASE_URL).toBeUndefined()
    expect(process.env.CONCENTRATE_MODEL).toBeUndefined()
  })

  test('accepts native x-api-key authentication', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example/v1'
    process.env.ANTHROPIC_API_KEY = 'stale-first-party-key'

    const result = applyProviderFlag('custom-anthropic', [])

    expect(result.error).toBeUndefined()
    expect(process.env.ANTHROPIC_API_KEY).toBe('stale-first-party-key')
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })
})

describe('VALID_PROVIDERS', () => {
  test('includes descriptor-backed preset and route ids', () => {
    expect(VALID_PROVIDERS).toContain('deepseek')
    expect(VALID_PROVIDERS).toContain('moonshotai')
    expect(VALID_PROVIDERS).toContain('openrouter')
    expect(VALID_PROVIDERS).toContain('atomic-chat')
    expect(VALID_PROVIDERS).toContain('zai')
    expect(VALID_PROVIDERS).toContain('venice')
    expect(VALID_PROVIDERS).toContain('xiaomi-mimo')
    expect(VALID_PROVIDERS).toContain('xiaomi-mimo-token')
    expect(VALID_PROVIDERS).toContain('longcat')
    expect(VALID_PROVIDERS).toContain('commandcode')
    expect(VALID_PROVIDERS).toContain('custom-anthropic')
  })
})

describe('applyProviderFlag - openai', () => {
  test('sets CLAUDE_CODE_USE_OPENAI=1', () => {
    const result = applyProviderFlag('openai', [])
    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
  })

  test('sets OPENAI_MODEL when --model is provided', () => {
    applyProviderFlag('openai', ['--model', 'gpt-4o'])
    expect(process.env.OPENAI_MODEL).toBe('gpt-4o')
  })

  test('does not leave ApiSmart env-only selection active', () => {
    process.env.APISMART_API_KEY = 'apismart-key'
    process.env.APISMART_MODEL = 'KIMI_K3'

    applyProviderFlag('openai', [])

    expect(process.env.APISMART_API_KEY).toBeUndefined()
    expect(process.env.APISMART_MODEL).toBeUndefined()
  })

  test('does not leave Concentrate env-only selection active', () => {
    process.env.CONCENTRATE_API_KEY = 'concentrate-key'
    process.env.CONCENTRATE_BASE_URL = 'https://api.concentrate.ai/v1'
    process.env.CONCENTRATE_MODEL = 'claude-sonnet-5'
    applyProviderFlag('openai', [])
    expect(process.env.CONCENTRATE_API_KEY).toBeUndefined()
    expect(process.env.CONCENTRATE_BASE_URL).toBeUndefined()
    expect(process.env.CONCENTRATE_MODEL).toBeUndefined()
  })
})

describe('applyProviderFlag - cloudflare', () => {
  test('does not seed the placeholder <ACCOUNT_ID> base URL', () => {
    process.env.CLOUDFLARE_API_TOKEN = 'cf-token'
    const result = applyProviderFlag('cloudflare', [])
    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    // The descriptor default contains an unresolved `<ACCOUNT_ID>` placeholder;
    // it must not be installed verbatim as a broken endpoint.
    expect(process.env.OPENAI_BASE_URL).toBeUndefined()
  })

  test('keeps a real account-scoped base URL the user already configured', () => {
    process.env.CLOUDFLARE_API_TOKEN = 'cf-token'
    process.env.OPENAI_BASE_URL =
      'https://api.cloudflare.com/client/v4/accounts/real123/ai/v1'
    applyProviderFlag('cloudflare', [])
    expect(process.env.OPENAI_BASE_URL).toBe(
      'https://api.cloudflare.com/client/v4/accounts/real123/ai/v1',
    )
  })

  test('mirrors CLOUDFLARE_API_TOKEN into OPENAI_API_KEY once a real Cloudflare endpoint is configured', () => {
    process.env.CLOUDFLARE_API_TOKEN = 'cf-token'
    process.env.OPENAI_BASE_URL =
      'https://api.cloudflare.com/client/v4/accounts/real123/ai/v1'
    delete process.env.OPENAI_API_KEY
    applyProviderFlag('cloudflare', [])
    // The Cloudflare transport authenticates via the generic OpenAI-compatible
    // header, so the dedicated token is copied into OPENAI_API_KEY — but only
    // once the configured base URL resolves to api.cloudflare.com.
    expect(String(process.env.OPENAI_API_KEY)).toBe('cf-token')
  })

  test('does NOT mirror the token while no Cloudflare endpoint is configured', () => {
    // The descriptor default is an unresolved `<ACCOUNT_ID>` placeholder that is
    // never seeded, so with OPENAI_BASE_URL unset the endpoint is unknown.
    // Mirroring here would leave the token attached to no real host.
    process.env.CLOUDFLARE_API_TOKEN = 'cf-token'
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_KEY
    applyProviderFlag('cloudflare', [])
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })

  test('does NOT leak the token onto a stale non-Cloudflare base URL', () => {
    // Regression: a previous OpenAI-compatible provider left OPENAI_BASE_URL
    // pointing elsewhere. The Cloudflare token must not be copied onto it.
    process.env.CLOUDFLARE_API_TOKEN = 'cf-token'
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
    delete process.env.OPENAI_API_KEY
    applyProviderFlag('cloudflare', [])
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })

  test('does NOT mirror the token onto the shared AI Gateway host', () => {
    // The AI Gateway host (gateway.ai.cloudflare.com) is not the Workers AI
    // endpoint isCloudflareBaseUrl keys on (api.cloudflare.com), so the token
    // must not be mirrored there either.
    process.env.CLOUDFLARE_API_TOKEN = 'cf-token'
    process.env.OPENAI_BASE_URL =
      'https://gateway.ai.cloudflare.com/v1/acc/gw/workers-ai/v1'
    delete process.env.OPENAI_API_KEY
    applyProviderFlag('cloudflare', [])
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })

  test('does NOT mirror the token onto a general Cloudflare REST path on the same host', () => {
    // api.cloudflare.com also serves the general Cloudflare REST API. A
    // non-Workers-AI path (e.g. token verification) must NOT inherit Workers-AI
    // credential mirroring just because it shares the host.
    process.env.CLOUDFLARE_API_TOKEN = 'cf-token'
    process.env.OPENAI_BASE_URL =
      'https://api.cloudflare.com/client/v4/user/tokens/verify'
    delete process.env.OPENAI_API_KEY
    applyProviderFlag('cloudflare', [])
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })

  test('clears a stale OPENAI_API_KEY when no CLOUDFLARE_API_TOKEN is set', () => {
    delete process.env.CLOUDFLARE_API_TOKEN
    delete process.env.OPENAI_BASE_URL
    process.env.OPENAI_API_KEY = 'leftover-from-another-provider'
    applyProviderFlag('cloudflare', [])
    // Without a Cloudflare token a lingering generic key must not be sent to
    // Cloudflare; validation should report the missing token instead.
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })

  test('does NOT mirror the token onto the literal <ACCOUNT_ID> placeholder URL', () => {
    // The placeholder shares the api.cloudflare.com host, so a host-only check
    // would mirror the token onto an endpoint that cannot serve a request until
    // the account id is filled in. Reject placeholder URLs before mirroring.
    process.env.CLOUDFLARE_API_TOKEN = 'cf-token'
    process.env.OPENAI_BASE_URL =
      'https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1'
    delete process.env.OPENAI_API_KEY
    applyProviderFlag('cloudflare', [])
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })

  test('preserves an existing OPENAI_API_KEY fallback on a real Cloudflare endpoint with no token', () => {
    // The descriptor lists OPENAI_API_KEY as a documented compatibility
    // fallback after CLOUDFLARE_API_TOKEN. A user who configured the generic
    // key against a real Workers AI URL must stay authenticated even without a
    // dedicated token.
    delete process.env.CLOUDFLARE_API_TOKEN
    process.env.OPENAI_BASE_URL =
      'https://api.cloudflare.com/client/v4/accounts/real123/ai/v1'
    process.env.OPENAI_API_KEY = 'compat-key'
    applyProviderFlag('cloudflare', [])
    expect(process.env.OPENAI_API_KEY).toBe('compat-key')
  })
})

describe('applyProviderFlag - gemini', () => {
  test('sets CLAUDE_CODE_USE_GEMINI=1', () => {
    const result = applyProviderFlag('gemini', [])
    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_GEMINI).toBe('1')
  })

  test('sets GEMINI_MODEL when --model is provided', () => {
    applyProviderFlag('gemini', ['--model', 'gemini-2.0-flash'])
    expect(process.env.GEMINI_MODEL).toBe('gemini-2.0-flash')
  })
})

describe('applyProviderFlag - github', () => {
  test('sets CLAUDE_CODE_USE_GITHUB=1', () => {
    const result = applyProviderFlag('github', [])
    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_GITHUB).toBe('1')
  })
})

describe('applyProviderFlag - bedrock', () => {
  test('sets CLAUDE_CODE_USE_BEDROCK=1', () => {
    const result = applyProviderFlag('bedrock', [])
    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_BEDROCK).toBe('1')
  })
})

describe('applyProviderFlag - vertex', () => {
  test('sets CLAUDE_CODE_USE_VERTEX=1', () => {
    const result = applyProviderFlag('vertex', [])
    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_VERTEX).toBe('1')
  })
})

describe('applyProviderFlag - ollama', () => {
  test('sets CLAUDE_CODE_USE_OPENAI=1 with Ollama defaults when unset', () => {
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_KEY

    const result = applyProviderFlag('ollama', [])
    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL!).toBe('http://localhost:11434/v1')
    expect(process.env.OPENAI_API_KEY!).toBe('ollama')
  })

  test('sets OPENAI_MODEL when --model is provided', () => {
    applyProviderFlag('ollama', ['--model', 'llama3.2'])
    expect(process.env.OPENAI_MODEL).toBe('llama3.2')
  })

  test('clears Azure-only routing mode', () => {
    process.env.OPENAI_AZURE_STYLE = '1'

    applyProviderFlag('ollama', [])

    expect(process.env.OPENAI_AZURE_STYLE).toBeUndefined()
  })

  test('does not override existing OPENAI_BASE_URL when user set a custom one', () => {
    process.env.OPENAI_BASE_URL = 'http://my-ollama:11434/v1'
    applyProviderFlag('ollama', [])
    expect(process.env.OPENAI_BASE_URL).toBe('http://my-ollama:11434/v1')
  })

  test('preserves explicit OPENAI_BASE_URL and OPENAI_API_KEY overrides', () => {
    process.env.OPENAI_BASE_URL = 'http://remote-ollama.internal:11434/v1'
    process.env.OPENAI_API_KEY = 'secret-token'

    applyProviderFlag('ollama', [])

    expect(process.env.OPENAI_BASE_URL).toBe('http://remote-ollama.internal:11434/v1')
    expect(process.env.OPENAI_API_KEY).toBe('secret-token')
  })
})

describe('applyProviderFlag - descriptor-backed openai-compatible routes', () => {
  test('deepseek applies generic openai-compatible routing with descriptor defaults', () => {
    const result = applyProviderFlag('deepseek', [])

    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.deepseek.com/v1')
    expect(process.env.OPENAI_MODEL).toBe('deepseek-v4-pro')
  })

  test('openrouter applies gateway defaults from descriptors', () => {
    const result = applyProviderFlag('openrouter', [])

    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://openrouter.ai/api/v1')
  })

  test('descriptor-backed provider selection preserves custom OPENAI_BASE_URL', () => {
    process.env.OPENAI_BASE_URL = 'http://proxy.local:8080/v1'

    const result = applyProviderFlag('openrouter', [])

    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('http://proxy.local:8080/v1')
  })

  test('LLMTR clears stale custom auth only on its canonical endpoint', () => {
    process.env.LLMTR_API_KEY = 'llmtr-key'
    process.env.OPENAI_API_FORMAT = 'responses'
    process.env.OPENAI_AUTH_HEADER = 'X-Proxy-Key'
    process.env.OPENAI_AUTH_SCHEME = 'raw'
    process.env.OPENAI_AUTH_HEADER_VALUE = 'proxy-secret'
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'X-Tenant-Secret: tenant-secret'

    const result = applyProviderFlag('llmtr', [])

    expect(result.error).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBe('https://llmtr.com/v1')
    expect(process.env.OPENAI_API_FORMAT).toBeUndefined()
    expect(process.env.OPENAI_AUTH_HEADER).toBeUndefined()
    expect(process.env.OPENAI_AUTH_SCHEME).toBeUndefined()
    expect(process.env.OPENAI_AUTH_HEADER_VALUE).toBeUndefined()
    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined()
  })

  test('LLMTR preserves custom endpoint auth settings when the endpoint is explicit', () => {
    process.env.OPENAI_BASE_URL = 'https://proxy.example/v1'
    process.env.OPENAI_API_FORMAT = 'responses'
    process.env.OPENAI_AUTH_HEADER = 'X-Proxy-Key'
    process.env.OPENAI_AUTH_SCHEME = 'raw'
    process.env.OPENAI_AUTH_HEADER_VALUE = 'proxy-secret'
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'X-Tenant-Secret: tenant-secret'

    const result = applyProviderFlag('llmtr', [])

    expect(result.error).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBe('https://proxy.example/v1')
    expect(process.env.OPENAI_API_FORMAT).toBe('responses')
    expect(process.env.OPENAI_AUTH_HEADER).toBe('X-Proxy-Key')
    expect(process.env.OPENAI_AUTH_SCHEME).toBe('raw')
    expect(process.env.OPENAI_AUTH_HEADER_VALUE).toBe('proxy-secret')
    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBe(
      'X-Tenant-Secret: tenant-secret',
    )
  })

  test('clears an LLMTR key copied into OPENAI_API_KEY when switching routes', () => {
    process.env.LLMTR_API_KEY = 'llmtr-secret'
    process.env.OPENAI_API_KEY = 'llmtr-secret'
    process.env.OPENAI_BASE_URL = 'https://llmtr.com/v1'

    const result = applyProviderFlag('openrouter', [])

    expect(result.error).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBe('https://openrouter.ai/api/v1')
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.LLMTR_API_KEY).toBe('llmtr-secret')
  })

  test('preserves an independent generic OPENAI_API_KEY when switching from LLMTR', () => {
    process.env.LLMTR_API_KEY = 'llmtr-secret'
    process.env.OPENAI_API_KEY = 'generic-openai-secret'
    process.env.OPENAI_BASE_URL = 'https://llmtr.com/v1'

    const result = applyProviderFlag('openrouter', [])

    expect(result.error).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBe('https://openrouter.ai/api/v1')
    expect(process.env.OPENAI_API_KEY).toBe('generic-openai-secret')
  })

  test('Command Code clears stale custom auth only on its canonical endpoint', () => {
    process.env.CMD_API_KEY = 'cmd-key'
    process.env.OPENAI_API_FORMAT = 'responses'
    process.env.OPENAI_AUTH_HEADER = 'X-Proxy-Key'
    process.env.OPENAI_AUTH_SCHEME = 'raw'
    process.env.OPENAI_AUTH_HEADER_VALUE = 'proxy-secret'
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'X-Tenant-Secret: tenant-secret'

    const result = applyProviderFlag('commandcode', [])

    expect(result.error).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBe(
      'https://api.commandcode.ai/provider/v1',
    )
    expect(process.env.OPENAI_MODEL).toBe('deepseek/deepseek-v4-flash')
    expect(process.env.OPENAI_API_FORMAT).toBeUndefined()
    expect(process.env.OPENAI_AUTH_HEADER).toBeUndefined()
    expect(process.env.OPENAI_AUTH_SCHEME).toBeUndefined()
    expect(process.env.OPENAI_AUTH_HEADER_VALUE).toBeUndefined()
    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined()
  })

  test('clears a Command Code key copied into OPENAI_API_KEY when switching routes', () => {
    process.env.CMD_API_KEY = 'cmd-secret'
    process.env.OPENAI_API_KEY = 'cmd-secret'
    process.env.OPENAI_BASE_URL = 'https://api.commandcode.ai/provider/v1'

    const result = applyProviderFlag('openrouter', [])

    expect(result.error).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBe('https://openrouter.ai/api/v1')
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.CMD_API_KEY).toBe('cmd-secret')
  })

  test('Command Code dedicated key overrides a lingering OPENAI_API_KEY from another provider', () => {
    process.env.OPENAI_API_KEY = 'generic-openai-secret'
    process.env.CMD_API_KEY = 'cmd-key'

    const result = applyProviderFlag('commandcode', [])

    expect(result.error).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBe('cmd-key')
  })

  test('Command Code clears a distinct generic OPENAI_API_KEY when no dedicated key is set', () => {
    process.env.OPENAI_API_KEY = 'generic-openai-secret'

    const result = applyProviderFlag('commandcode', [])

    expect(result.error).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })

  test('Command Code keeps a copied dedicated key in OPENAI_API_KEY when selecting commandcode', () => {
    process.env.CMD_API_KEY = 'cmd-key'
    process.env.OPENAI_API_KEY = 'cmd-key'

    const result = applyProviderFlag('commandcode', [])

    expect(result.error).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBe('cmd-key')
  })

  test('Command Code uses COMMANDCODE_API_KEY when CMD_API_KEY is absent', () => {
    process.env.OPENAI_API_KEY = 'generic-openai-secret'
    process.env.COMMANDCODE_API_KEY = 'commandcode-key'

    const result = applyProviderFlag('commandcode', [])

    expect(result.error).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBe('commandcode-key')
  })

  test('Command Code uses the official client key when other aliases are absent', () => {
    process.env.OPENAI_API_KEY = 'generic-openai-secret'
    process.env.COMMAND_CODE_API_KEY = 'official-command-code-key'

    const result = applyProviderFlag('commandcode', [])

    expect(result.error).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBe('official-command-code-key')
  })

  test('Command Code rejects an incompatible stale model before changing provider state', () => {
    process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'
    process.env.OPENAI_MODEL = 'anthropic/claude-sonnet-4.6'

    const result = applyProviderFlag('commandcode', [])

    expect(result.error).toContain('requires the Anthropic Messages protocol')
    expect(process.env.OPENAI_BASE_URL).toBe('https://openrouter.ai/api/v1')
    expect(process.env.OPENAI_MODEL).toBe('anthropic/claude-sonnet-4.6')
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
  })

  test('Command Code rejects an explicit incompatible model', () => {
    const result = applyProviderFlag('commandcode', [
      '--model',
      'claude-sonnet-5',
    ])

    expect(result.error).toContain('requires the Anthropic Messages protocol')
    expect(process.env.OPENAI_BASE_URL).toBeUndefined()
  })

  test('Command Code resolves the reserved default model before applying it', () => {
    const result = applyProviderFlag('commandcode', [
      '--model',
      'default',
    ])

    expect(result.error).toBeUndefined()
    expect(process.env.OPENAI_MODEL).toBe('deepseek/deepseek-v4-flash')
  })

  test('Command Code ignores nested model-owning subcommand --model', () => {
    const result = applyProviderFlag('commandcode', [
      '--provider',
      'commandcode',
      '--model',
      'deepseek/deepseek-v4-flash',
      'aimlapi',
      'topup',
      '--model',
      'anthropic/claude-sonnet-4-6',
    ])

    expect(result.error).toBeUndefined()
    expect(process.env.OPENAI_MODEL).toBe('deepseek/deepseek-v4-flash')
  })

  test('Command Code ignores nested-only --model when selecting the provider', () => {
    const result = applyProviderFlag('commandcode', [
      '--provider',
      'commandcode',
      'auto-mode',
      'critique',
      '--model=anthropic/claude-sonnet-4-6',
    ])

    expect(result.error).toBeUndefined()
    expect(process.env.OPENAI_MODEL).toBe('deepseek/deepseek-v4-flash')
  })

  test('Command Code still rejects a root incompatible --model before a nested command', () => {
    const result = applyProviderFlag('commandcode', [
      '--provider',
      'commandcode',
      '--model',
      'anthropic/claude-sonnet-4-6',
      'aimlapi',
      'topup',
      '--model',
      'deepseek/deepseek-v4-flash',
    ])

    expect(result.error).toContain('requires the Anthropic Messages protocol')
    expect(process.env.OPENAI_BASE_URL).toBeUndefined()
  })

  test('descriptor-backed provider selection preserves custom OPENAI_API_BASE alias', () => {
    process.env.OPENAI_API_BASE = 'http://proxy.local:8080/v1'
    process.env.OPENGATEWAY_API_KEY = 'fake-ogw-key'

    const result = applyProviderFlag('gitlawb-opengateway', [])

    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBeUndefined()
    expect(process.env.OPENAI_API_BASE).toBe('http://proxy.local:8080/v1')
    expect(process.env.OPENAI_API_KEY).toBe('fake-ogw-key')
  })

  test('descriptor-backed provider selection ignores placeholder OPENAI_API_BASE alias values', () => {
    process.env.OPENAI_API_BASE = 'undefined'

    const result = applyProviderFlag('gitlawb-opengateway', [])

    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://opengateway.gitlawb.com/v1')
    expect(process.env.OPENAI_API_BASE).toBe('undefined')
  })

  test('gitlawb-opengateway explicit provider overrides stale generic base URL', () => {
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
    process.env.OPENAI_MODEL = 'gpt-5.5'
    process.env.OPENGATEWAY_API_KEY = 'fake-ogw-key'

    const result = applyProviderFlag('gitlawb-opengateway', [])

    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://opengateway.gitlawb.com/v1')
    expect(process.env.OPENGATEWAY_API_KEY).toBe('fake-ogw-key')
    expect(process.env.OPENAI_API_KEY).toBe('fake-ogw-key')
  })

  test('gitlawb-opengateway explicit provider respects OPENGATEWAY_BASE_URL override', () => {
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
    process.env.OPENGATEWAY_BASE_URL = 'http://localhost:8181/v1'

    const result = applyProviderFlag('gitlawb-opengateway', [])

    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('http://localhost:8181/v1')
  })

  test('gitlawb-opengateway explicit provider preserves custom OPENAI_BASE_URL when no OPENGATEWAY_BASE_URL is set', () => {
    process.env.OPENAI_BASE_URL = 'http://localhost:8181/v1'
    process.env.OPENGATEWAY_API_KEY = 'fake-ogw-key'

    const result = applyProviderFlag('gitlawb-opengateway', [])

    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('http://localhost:8181/v1')
    expect(process.env.OPENAI_API_KEY).toBe('fake-ogw-key')
  })

  test('gitlawb-opengateway explicit provider prefers OPENGATEWAY_API_KEY over generic OPENAI_API_KEY', () => {
    process.env.OPENGATEWAY_BASE_URL = 'http://localhost:8181/v1'
    process.env.OPENGATEWAY_API_KEY = 'fake-ogw-key'
    process.env.OPENAI_API_KEY = 'fake-generic-openai-key'

    const result = applyProviderFlag('gitlawb-opengateway', [])

    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('http://localhost:8181/v1')
    expect(process.env.OPENAI_API_KEY).toBe('fake-ogw-key')
  })

  test('gitlawb-opengateway explicit provider ignores blank OPENGATEWAY_API_KEY fallback', () => {
    process.env.OPENGATEWAY_BASE_URL = 'http://localhost:8181/v1'
    process.env.OPENGATEWAY_API_KEY = '   '
    process.env.OPENAI_API_KEY = 'fake-openai-fallback'

    const result = applyProviderFlag('gitlawb-opengateway', [])

    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('http://localhost:8181/v1')
    expect(process.env.OPENAI_API_KEY).toBe('fake-openai-fallback')
  })

  test('gitlawb-opengateway trims scoped API key and clears the copied key when switching routes', () => {
    process.env.OPENGATEWAY_API_KEY = ' fake-ogw-key '

    const opengatewayResult = applyProviderFlag('gitlawb-opengateway', [])
    expect(opengatewayResult.error).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBe('fake-ogw-key')

    const openrouterResult = applyProviderFlag('openrouter', [])

    expect(openrouterResult.error).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBe('https://openrouter.ai/api/v1')
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.OPENGATEWAY_API_KEY).toBe(' fake-ogw-key ')
  })

  test('clears OPENGATEWAY_API_KEY copied into OPENAI_API_KEY when switching routes', () => {
    process.env.OPENAI_API_KEY = 'fake-ogw-key'
    process.env.OPENGATEWAY_API_KEY = 'fake-ogw-key'

    const result = applyProviderFlag('openrouter', [])

    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://openrouter.ai/api/v1')
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.OPENGATEWAY_API_KEY).toBe('fake-ogw-key')
  })

  test('descriptor-backed provider selection does not keep stale OpenGateway route', () => {
    process.env.OPENAI_BASE_URL = 'https://opengateway.gitlawb.com/v1'
    process.env.OPENGATEWAY_API_KEY = 'fake-ogw-key'

    const result = applyProviderFlag('openrouter', [])

    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://openrouter.ai/api/v1')
    expect(process.env.OPENGATEWAY_API_KEY).toBe('fake-ogw-key')
  })

  test('clears stale NVIDIA_NIM marker when switching to another OpenAI-compatible route', () => {
    process.env.NVIDIA_NIM = '1'

    const result = applyProviderFlag('openrouter', [])

    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.NVIDIA_NIM).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBe('https://openrouter.ai/api/v1')
  })

  test('clears NVIDIA_API_KEY copied into OPENAI_API_KEY when switching routes', () => {
    process.env.NVIDIA_API_KEY = 'nvidia-live-key'

    const nvidiaResult = applyProviderFlag('nvidia-nim', [])
    expect(nvidiaResult.error).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBe('nvidia-live-key')

    process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'
    const openrouterResult = applyProviderFlag('openrouter', [])

    expect(openrouterResult.error).toBeUndefined()
    expect(process.env.NVIDIA_NIM).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBe('https://openrouter.ai/api/v1')
  })

  test('clears BNKR_API_KEY copied into OPENAI_API_KEY when switching routes', () => {
    process.env.BNKR_API_KEY = 'bankr-live-key'

    const bankrResult = applyProviderFlag('bankr', [])
    expect(bankrResult.error).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBe('bankr-live-key')

    process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'
    const openrouterResult = applyProviderFlag('openrouter', [])

    expect(openrouterResult.error).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBe('https://openrouter.ai/api/v1')
  })

  test('clears MIMO_API_KEY copied into OPENAI_API_KEY when switching routes', () => {
    process.env.MIMO_API_KEY = 'mimo-live-key'

    const mimoResult = applyProviderFlag('xiaomi-mimo', [])
    expect(mimoResult.error).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBe('mimo-live-key')

    process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'
    const openrouterResult = applyProviderFlag('openrouter', [])

    expect(openrouterResult.error).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBe('https://openrouter.ai/api/v1')
  })

  test('clears XAI_API_KEY copied into OPENAI_API_KEY when switching routes', () => {
    process.env.XAI_API_KEY = 'xai-live-key'

    const xaiResult = applyProviderFlag('xai', [])
    expect(xaiResult.error).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBe('xai-live-key')

    process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'
    const openrouterResult = applyProviderFlag('openrouter', [])

    expect(openrouterResult.error).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBe('https://openrouter.ai/api/v1')
  })

  test('clears MINIMAX_API_KEY copied into OPENAI_API_KEY when switching routes', () => {
    process.env.MINIMAX_API_KEY = 'minimax-live-key'
    process.env.OPENAI_API_KEY = 'minimax-live-key'
    process.env.XAI_API_KEY = 'xai-live-key'

    const xaiResult = applyProviderFlag('xai', [])

    expect(xaiResult.error).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBe('xai-live-key')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.x.ai/v1')
  })
})

describe('applyProviderFlag - minimax', () => {
  test('preserves MiniMax default base URL and model semantics', () => {
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
    process.env.OPENAI_MODEL = 'gpt-4o'
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-5'

    const result = applyProviderFlag('minimax', [])

    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
    expect(process.env.ANTHROPIC_BASE_URL).toBe('https://api.minimax.io/anthropic')
    expect(process.env.ANTHROPIC_MODEL).toBe('MiniMax-M3')
    expect(process.env.OPENAI_BASE_URL).toBeUndefined()
    expect(process.env.OPENAI_MODEL).toBeUndefined()
  })
})

describe('applyProviderFlag - nvidia-nim', () => {
  test('maps NVIDIA_API_KEY into the OPENAI-compatible auth env when present', () => {
    process.env.NVIDIA_API_KEY = 'nvidia-live-key'

    const result = applyProviderFlag('nvidia-nim', [])

    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.NVIDIA_NIM).toBe('1')
    expect(process.env.OPENAI_API_KEY).toBe('nvidia-live-key')
    expect(process.env.OPENAI_BASE_URL).toBe('https://integrate.api.nvidia.com/v1')
  })
})

describe('applyProviderFlag - zai', () => {
  test('preserves Z.AI default base URL and model semantics', () => {
    const result = applyProviderFlag('zai', [])

    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.z.ai/api/coding/paas/v4')
    expect(process.env.OPENAI_MODEL).toBe('glm-5.2')
  })
})

describe('applyProviderFlag - longcat', () => {
  test('sets LongCat OpenAI-compatible defaults and mirrors LONGCAT_API_KEY', () => {
    process.env.LONGCAT_API_KEY = 'longcat-secret-key'

    const result = applyProviderFlag('longcat', [])

    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.longcat.chat/openai/v1')
    expect(process.env.OPENAI_MODEL).toBe('LongCat-2.0')
    expect(process.env.OPENAI_API_KEY).toBe('longcat-secret-key')
  })

  test('sets LongCat OPENAI_MODEL when --model is provided', () => {
    applyProviderFlag('longcat', ['--model', 'LongCat-2.0'])

    expect(process.env.OPENAI_MODEL).toBe('LongCat-2.0')
  })

  test('clears incompatible OpenAI transport and auth overrides', () => {
    process.env.LONGCAT_API_KEY = 'longcat-secret-key'
    process.env.OPENAI_API_FORMAT = 'responses'
    process.env.OPENAI_AUTH_HEADER = 'api-key'
    process.env.OPENAI_AUTH_SCHEME = 'token'
    process.env.OPENAI_AUTH_HEADER_VALUE = 'stale-secret'

    const result = applyProviderFlag('longcat', [])

    expect(result.error).toBeUndefined()
    expect(process.env.OPENAI_API_FORMAT).toBeUndefined()
    expect(process.env.OPENAI_AUTH_HEADER).toBeUndefined()
    expect(process.env.OPENAI_AUTH_SCHEME).toBeUndefined()
    expect(process.env.OPENAI_AUTH_HEADER_VALUE).toBeUndefined()
  })

  test('does not mirror LONGCAT_API_KEY to a preserved custom base URL', () => {
    process.env.OPENAI_BASE_URL = 'https://untrusted.example/v1'
    process.env.LONGCAT_API_KEY = 'longcat-secret-key'

    const result = applyProviderFlag('longcat', [])

    expect(result.error).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBe('https://untrusted.example/v1')
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })

  test('clears LONGCAT_API_KEY copied into OPENAI_API_KEY when switching routes', () => {
    process.env.LONGCAT_API_KEY = 'longcat-live-key'

    const longcatResult = applyProviderFlag('longcat', [])
    expect(longcatResult.error).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBe('longcat-live-key')

    process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'
    const openrouterResult = applyProviderFlag('openrouter', [])

    expect(openrouterResult.error).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBe('https://openrouter.ai/api/v1')
  })
})

describe('applyProviderFlag - xiaomi-mimo', () => {
  test('sets Xiaomi MiMo OpenAI-compatible defaults and mirrors MIMO_API_KEY', () => {
    process.env.MIMO_API_KEY = 'mimo-secret-key'

    const result = applyProviderFlag('xiaomi-mimo', [])

    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.xiaomimimo.com/v1')
    expect(process.env.OPENAI_MODEL).toBe('mimo-v2.5-pro')
    expect(process.env.OPENAI_API_KEY).toBe('mimo-secret-key')
  })

  test('sets Xiaomi MiMo OPENAI_MODEL when --model is provided', () => {
    applyProviderFlag('xiaomi-mimo', ['--model', 'mimo-v2-flash'])

    expect(process.env.OPENAI_MODEL).toBe('mimo-v2-flash')
  })
})

describe('applyProviderFlag - xiaomi-mimo-token', () => {
  test('sets Xiaomi MiMo Token Plan OpenAI-compatible defaults and mirrors MIMO_API_KEY', () => {
    process.env.MIMO_API_KEY = 'tp-token-plan-key'

    const result = applyProviderFlag('xiaomi-mimo-token', [])

    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe(
      'https://token-plan-sgp.xiaomimimo.com/v1',
    )
    expect(process.env.OPENAI_MODEL).toBe('mimo-v2.5-pro')
    expect(process.env.OPENAI_API_KEY).toBe('tp-token-plan-key')
  })

  test('replaces stale known provider base URL with the token-plan default', () => {
    process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'

    const result = applyProviderFlag('xiaomi-mimo-token', [])

    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe(
      'https://token-plan-sgp.xiaomimimo.com/v1',
    )
  })

  test('sets Xiaomi MiMo Token Plan OPENAI_MODEL when --model is provided', () => {
    applyProviderFlag('xiaomi-mimo-token', ['--model', 'mimo-v2-flash'])

    expect(process.env.OPENAI_MODEL).toBe('mimo-v2-flash')
  })
})

describe('applyProviderFlag - venice', () => {
  test('sets Venice OpenAI-compatible defaults and mirrors VENICE_API_KEY', () => {
    process.env.VENICE_API_KEY = 'venice-secret-key'

    const result = applyProviderFlag('venice', [])

    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.venice.ai/api/v1')
    expect(process.env.OPENAI_MODEL).toBe('venice-uncensored')
    expect(process.env.OPENAI_API_KEY).toBe('venice-secret-key')
  })
})

describe('applyProviderFlag - atlas-cloud', () => {
  test('sets Atlas Cloud OpenAI-compatible defaults and mirrors ATLAS_CLOUD_API_KEY', () => {
    process.env.ATLAS_CLOUD_API_KEY = 'atlas-secret-key'

    const result = applyProviderFlag('atlas-cloud', [])

    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.atlascloud.ai/v1')
    expect(process.env.OPENAI_MODEL).toBe('deepseek-ai/deepseek-v4-pro')
    expect(process.env.OPENAI_API_KEY).toBe('atlas-secret-key')
  })

  test('dedicated key overrides a lingering OPENAI_API_KEY from another provider', () => {
    process.env.OPENAI_API_KEY = 'existing-openai-key'
    process.env.ATLAS_CLOUD_API_KEY = 'atlas-secret-key'

    applyProviderFlag('atlas-cloud', [])

    expect(process.env.OPENAI_API_KEY).toBe('atlas-secret-key')
  })

  test('clears a stale OPENAI_API_KEY when no Atlas Cloud key is set', () => {
    process.env.OPENAI_API_KEY = 'existing-openai-key'

    applyProviderFlag('atlas-cloud', [])

    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })

  test('keeps a copied Atlas key in OPENAI_API_KEY when selecting atlas-cloud', () => {
    process.env.ATLAS_CLOUD_API_KEY = 'atlas-secret-key'
    process.env.OPENAI_API_KEY = 'atlas-secret-key'

    applyProviderFlag('atlas-cloud', [])

    expect(process.env.OPENAI_API_KEY).toBe('atlas-secret-key')
  })

  test('clears a copied Atlas key from OPENAI_API_KEY when switching to another provider', () => {
    process.env.ATLAS_CLOUD_API_KEY = 'atlas-secret-key'
    process.env.OPENAI_API_KEY = 'atlas-secret-key'

    applyProviderFlag('openai', [])

    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })

  test('replaces a stale base URL belonging to another known provider', () => {
    process.env.OPENAI_BASE_URL = 'https://api.venice.ai/api/v1'
    process.env.ATLAS_CLOUD_API_KEY = 'atlas-secret-key'

    applyProviderFlag('atlas-cloud', [])

    expect(process.env.OPENAI_BASE_URL).toBe('https://api.atlascloud.ai/v1')
  })

  test('preserves a custom base URL that matches no known provider', () => {
    process.env.OPENAI_BASE_URL = 'https://llm-proxy.internal.example/v1'
    process.env.ATLAS_CLOUD_API_KEY = 'atlas-secret-key'

    applyProviderFlag('atlas-cloud', [])

    expect(process.env.OPENAI_BASE_URL).toBe('https://llm-proxy.internal.example/v1')
  })

  test('sets OPENAI_MODEL when --model is provided', () => {
    process.env.ATLAS_CLOUD_API_KEY = 'atlas-secret-key'

    applyProviderFlag('atlas-cloud', ['--model', 'zai-org/glm-5'])

    expect(process.env.OPENAI_MODEL).toBe('zai-org/glm-5')
  })
})

describe('applyProviderFlag - gmi-cloud', () => {
  test('sets GMI Cloud OpenAI-compatible defaults and mirrors GMI_API_KEY', () => {
    process.env.GMI_API_KEY = 'gmi-secret-key'

    const result = applyProviderFlag('gmi-cloud', [])

    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.gmi-serving.com/v1')
    expect(process.env.OPENAI_MODEL).toBe('Qwen/Qwen3.8-Max')
    expect(process.env.OPENAI_API_KEY).toBe('gmi-secret-key')
  })

  test('dedicated key overrides a lingering OPENAI_API_KEY from another provider', () => {
    process.env.OPENAI_API_KEY = 'existing-openai-key'
    process.env.GMI_API_KEY = 'gmi-secret-key'

    applyProviderFlag('gmi-cloud', [])

    expect(process.env.OPENAI_API_KEY).toBe('gmi-secret-key')
  })

  test('clears a stale OPENAI_API_KEY when no GMI Cloud key is set', () => {
    process.env.OPENAI_API_KEY = 'existing-openai-key'

    applyProviderFlag('gmi-cloud', [])

    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })

  test('clears a copied GMI key from OPENAI_API_KEY when switching to another provider', () => {
    process.env.GMI_API_KEY = 'gmi-secret-key'
    process.env.OPENAI_API_KEY = 'gmi-secret-key'

    applyProviderFlag('openai', [])

    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })

  test('replaces a stale base URL belonging to another known provider', () => {
    process.env.OPENAI_BASE_URL = 'https://api.venice.ai/api/v1'
    process.env.GMI_API_KEY = 'gmi-secret-key'

    applyProviderFlag('gmi-cloud', [])

    expect(process.env.OPENAI_BASE_URL).toBe('https://api.gmi-serving.com/v1')
  })

  test('preserves a custom base URL but never mirrors the GMI key to it', () => {
    process.env.OPENAI_BASE_URL = 'https://llm-proxy.internal.example/v1'
    process.env.OPENAI_API_KEY = 'existing-openai-key'
    process.env.GMI_API_KEY = 'gmi-secret-key'

    applyProviderFlag('gmi-cloud', [])

    expect(process.env.OPENAI_BASE_URL).toBe('https://llm-proxy.internal.example/v1')
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })

  test('drops an API format and custom auth header left by another provider', () => {
    process.env.GMI_API_KEY = 'gmi-secret-key'
    process.env.OPENAI_API_FORMAT = 'responses'
    process.env.OPENAI_AUTH_HEADER = 'api-key'
    process.env.OPENAI_AUTH_SCHEME = 'raw'
    process.env.OPENAI_AUTH_HEADER_VALUE = 'other-provider-secret'
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'x-other: secret'

    applyProviderFlag('gmi-cloud', [])

    expect(process.env.OPENAI_API_FORMAT).toBeUndefined()
    expect(process.env.OPENAI_AUTH_HEADER).toBeUndefined()
    expect(process.env.OPENAI_AUTH_SCHEME).toBeUndefined()
    expect(process.env.OPENAI_AUTH_HEADER_VALUE).toBeUndefined()
    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBe('gmi-secret-key')
  })

  test('GMI_MODEL selects the model over a lingering OPENAI_MODEL', () => {
    process.env.GMI_API_KEY = 'gmi-secret-key'
    process.env.OPENAI_MODEL = 'stale-openai-model'
    process.env.GMI_MODEL = 'moonshotai/kimi-k2.7-code'

    applyProviderFlag('gmi-cloud', [])

    expect(process.env.OPENAI_MODEL).toBe('moonshotai/kimi-k2.7-code')
  })

  test('a placeholder GMI_MODEL falls back to the default model', () => {
    process.env.GMI_API_KEY = 'gmi-secret-key'
    process.env.GMI_MODEL = 'undefined'

    applyProviderFlag('gmi-cloud', [])

    expect(process.env.OPENAI_MODEL).toBe('Qwen/Qwen3.8-Max')
  })

  test('--model wins over GMI_MODEL', () => {
    process.env.GMI_API_KEY = 'gmi-secret-key'
    process.env.GMI_MODEL = 'moonshotai/kimi-k2.7-code'

    applyProviderFlag('gmi-cloud', ['--model', 'deepseek-ai/DeepSeek-V4-Flash'])

    expect(process.env.OPENAI_MODEL).toBe('deepseek-ai/DeepSeek-V4-Flash')
  })
})

describe('applyProviderFlag - apismart', () => {
  test('sets ApiSmart OpenAI-compatible defaults and mirrors APISMART_API_KEY', () => {
    process.env.APISMART_API_KEY = 'apismart-secret-key'

    const result = applyProviderFlag('apismart', [])

    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://gw.apismart.ai/v1')
    expect(process.env.OPENAI_MODEL).toBe('DEEPSEEK_V4_FLASH')
    expect(process.env.OPENAI_API_KEY).toBe('apismart-secret-key')
  })

  test('does not forward the dedicated key to a preserved custom base URL', () => {
    process.env.APISMART_API_KEY = 'apismart-secret-key'
    process.env.OPENAI_BASE_URL = 'https://llm-proxy.internal.example/v1'

    applyProviderFlag('apismart', [])

    expect(process.env.OPENAI_BASE_URL).toBe('https://llm-proxy.internal.example/v1')
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })

  test.each(['null', 'undefined', ' NULL ', ' Undefined '])(
    'treats placeholder OPENAI_BASE_URL %s as unset and applies ApiSmart defaults',
    sentinel => {
      process.env.APISMART_API_KEY = 'apismart-secret-key'
      process.env.OPENAI_BASE_URL = sentinel

      applyProviderFlag('apismart', [])

      expect(process.env.OPENAI_BASE_URL).toBe('https://gw.apismart.ai/v1')
      expect(process.env.OPENAI_API_KEY).toBe('apismart-secret-key')
    },
  )

  test('clears unsupported OpenAI shim settings from a previous route', () => {
    process.env.APISMART_API_KEY = 'apismart-secret-key'
    process.env.OPENAI_API_FORMAT = 'responses'
    process.env.OPENAI_AUTH_HEADER = 'x-api-key'
    process.env.OPENAI_AUTH_SCHEME = 'raw'
    process.env.OPENAI_AUTH_HEADER_VALUE = 'stale-value'

    applyProviderFlag('apismart', [])

    expect(process.env.OPENAI_API_FORMAT).toBeUndefined()
    expect(process.env.OPENAI_AUTH_HEADER).toBeUndefined()
    expect(process.env.OPENAI_AUTH_SCHEME).toBeUndefined()
    expect(process.env.OPENAI_AUTH_HEADER_VALUE).toBeUndefined()
  })

  test('clears inherited Anthropic custom headers', () => {
    process.env.APISMART_API_KEY = 'apismart-secret-key'
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'X-Proxy-Auth: proxy-secret'

    applyProviderFlag('apismart', [])

    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined()
  })

  test('uses APISMART_MODEL from env when --model is not provided', () => {
    process.env.APISMART_API_KEY = 'apismart-secret-key'
    process.env.APISMART_MODEL = 'KIMI_K3'

    applyProviderFlag('apismart', [])

    expect(process.env.OPENAI_MODEL).toBe('KIMI_K3')
  })

  test('makes an explicit --model override APISMART_MODEL', () => {
    process.env.APISMART_API_KEY = 'apismart-secret-key'
    process.env.APISMART_MODEL = 'KIMI_K3'

    applyProviderFlag('apismart', ['--model', 'GLM_5.2'])

    expect(process.env.OPENAI_MODEL).toBe('GLM_5.2')
    expect(process.env.APISMART_MODEL).toBe('GLM_5.2')
  })

  test('dedicated key overrides a lingering OPENAI_API_KEY from another provider', () => {
    process.env.OPENAI_API_KEY = 'existing-openai-key'
    process.env.APISMART_API_KEY = 'apismart-secret-key'

    applyProviderFlag('apismart', [])

    expect(process.env.OPENAI_API_KEY).toBe('apismart-secret-key')
  })

  test('clears a stale OPENAI_API_KEY when no ApiSmart key is set', () => {
    process.env.OPENAI_API_KEY = 'existing-openai-key'

    applyProviderFlag('apismart', [])

    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })

  test.each(['SUA_CHAVE', 'sua_chave', 'null', 'undefined', ' NULL '])(
    'does not mirror placeholder ApiSmart credential %s',
    placeholder => {
      process.env.APISMART_API_KEY = placeholder

      applyProviderFlag('apismart', [])

      expect(process.env.OPENAI_API_KEY).toBeUndefined()
    },
  )

  test('clears a copied ApiSmart key from OPENAI_API_KEY when switching to another provider', () => {
    process.env.APISMART_API_KEY = 'apismart-secret-key'
    process.env.OPENAI_API_KEY = 'apismart-secret-key'

    applyProviderFlag('openai', [])

    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })
})

describe('applyProviderFlag - xai', () => {
  test('sets CLAUDE_CODE_USE_OPENAI=1 with xAI defaults when unset', () => {
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_KEY

    const result = applyProviderFlag('xai', [])
    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL as string | undefined).toBe('https://api.x.ai/v1')
    expect(process.env.OPENAI_MODEL).toBe('grok-4.6')
  })

  test('sets OPENAI_MODEL when --model is provided', () => {
    applyProviderFlag('xai', ['--model', 'grok-3'])
    expect(process.env.OPENAI_MODEL).toBe('grok-3')
  })

  test('propagates XAI_API_KEY to OPENAI_API_KEY when only XAI_API_KEY is set', () => {
    delete process.env.OPENAI_API_KEY
    process.env.XAI_API_KEY = 'xai-secret-key'

    applyProviderFlag('xai', [])

    expect(process.env.OPENAI_API_KEY as string | undefined).toBe('xai-secret-key')
  })

  test('does not override existing OPENAI_API_KEY when both keys are set', () => {
    process.env.OPENAI_API_KEY = 'existing-openai-key'
    process.env.XAI_API_KEY = 'xai-secret-key'

    applyProviderFlag('xai', [])

    expect(process.env.OPENAI_API_KEY).toBe('existing-openai-key')
  })
})

describe('applyProviderFlag - invalid provider', () => {
  test('returns error for unknown provider', () => {
    const result = applyProviderFlag('unknown-provider', [])
    expect(result.error).toContain('unknown-provider')
    expect(result.error).toContain(VALID_PROVIDERS.join(', '))
  })
})

describe('applyProviderFlagFromArgs', () => {
  test('applies ollama provider and model from argv in one step', () => {
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_KEY

    const result = applyProviderFlagFromArgs([
      '--provider',
      'ollama',
      '--model',
      'qwen2.5:3b',
    ])

    expect(result?.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL!).toBe('http://localhost:11434/v1')
    expect(process.env.OPENAI_API_KEY!).toBe('ollama')
    expect(process.env.OPENAI_MODEL).toBe('qwen2.5:3b')
  })

  test('returns undefined when --provider is absent', () => {
    expect(applyProviderFlagFromArgs(['--model', 'gpt-4o'])).toBeUndefined()
  })

  test('reapplies remembered gitlawb-opengateway after settings env restores stale OpenAI routing', () => {
    const args = ['--provider', 'gitlawb-opengateway']
    delete process.env.OPENGATEWAY_API_KEY
    delete process.env.OPENAI_API_KEY

    const earlyResult = applyProviderFlagFromArgs(args, {
      rememberForSettingsEnv: true,
    })
    expect(earlyResult?.error).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBe(
      'https://opengateway.gitlawb.com/v1',
    )
    expect(process.env.OPENAI_API_KEY).toBeUndefined()

    process.env.OPENGATEWAY_API_KEY = 'settings-ogw-key'
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'

    const lateResult = reapplyRememberedProviderFlag()

    expect(lateResult?.error).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBe(
      'https://opengateway.gitlawb.com/v1',
    )
    expect(process.env.OPENAI_API_KEY as string | undefined).toBe(
      'settings-ogw-key',
    )
  })

  test('remembered provider reapply preserves an explicit --model', () => {
    const result = applyProviderFlagFromArgs(
      [
        '--print',
        '--provider',
        'gitlawb-opengateway',
        '--model',
        'custom-ogw-model',
        'do not retain prompt text',
      ],
      { rememberForSettingsEnv: true },
    )

    expect(result?.error).toBeUndefined()
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
    process.env.OPENAI_MODEL = 'stale-openai-model'

    const lateResult = reapplyRememberedProviderFlag()

    expect(lateResult?.error).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBe(
      'https://opengateway.gitlawb.com/v1',
    )
    expect(process.env.OPENAI_MODEL).toBe('custom-ogw-model')
  })

  test('remembered Command Code --model ignores nested subcommand --model', () => {
    const result = applyProviderFlagFromArgs(
      [
        '--provider',
        'commandcode',
        '--model',
        'deepseek/deepseek-v4-pro',
        'aimlapi',
        'topup',
        '--model',
        'anthropic/claude-sonnet-4-6',
      ],
      { rememberForSettingsEnv: true },
    )

    expect(result?.error).toBeUndefined()
    expect(process.env.OPENAI_MODEL).toBe('deepseek/deepseek-v4-pro')

    process.env.OPENAI_MODEL = 'stale-openai-model'
    const lateResult = reapplyRememberedProviderFlag()

    expect(lateResult?.error).toBeUndefined()
    expect(process.env.OPENAI_MODEL).toBe('deepseek/deepseek-v4-pro')
  })
})

// --- parseModelFlag ---

describe('parseModelFlag', () => {
  test('returns model value when --model is present', () => {
    expect(parseModelFlag(['--model', 'gpt-4o-mini'])).toBe('gpt-4o-mini')
  })

  test('returns model value from equals-separated syntax', () => {
    expect(parseModelFlag(['--model=deepseek/deepseek-v4-flash'])).toBe(
      'deepseek/deepseek-v4-flash',
    )
  })

  test('ignores model-looking text consumed by another root option', () => {
    expect(
      parseModelFlag([
        '--system-prompt',
        '--model=anthropic/claude-sonnet-4-6',
      ]),
    ).toBeNull()
  })

  test('returns null for an empty equals-separated value', () => {
    expect(parseModelFlag(['--model='])).toBeNull()
  })

  test('ignores model-looking positional text after the option delimiter', () => {
    expect(
      parseModelFlag(['--', '--model=anthropic/claude-sonnet-4-6']),
    ).toBeNull()
  })

  test('uses the final model occurrence like Commander', () => {
    expect(
      parseModelFlag([
        '--model=anthropic/claude-sonnet-4-6',
        '--model',
        'deepseek/deepseek-v4-flash',
      ]),
    ).toBe('deepseek/deepseek-v4-flash')
    expect(
      parseModelFlag([
        '--model',
        'deepseek/deepseek-v4-flash',
        '--model=anthropic/claude-sonnet-4-6',
      ]),
    ).toBe('anthropic/claude-sonnet-4-6')
  })

  test('returns null when --model is absent', () => {
    expect(parseModelFlag(['--provider', 'openai'])).toBeNull()
  })

  test('returns null when --model has no value', () => {
    expect(parseModelFlag(['--model'])).toBeNull()
  })

  test('returns null when --model value looks like another flag', () => {
    expect(parseModelFlag(['--model', '--provider'])).toBeNull()
  })
})

// --- applyModelFlagFromArgs (#808) ---

describe('applyModelFlagFromArgs', () => {
  test('is a no-op when --model is absent', () => {
    applyModelFlagFromArgs(['--ide'])
    expect(process.env.OPENAI_MODEL).toBeUndefined()
    expect(process.env.GEMINI_MODEL).toBeUndefined()
    expect(process.env.ANTHROPIC_MODEL).toBeUndefined()
  })

  test('is a no-op when --provider is also present (handled by applyProviderFlagFromArgs)', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    applyModelFlagFromArgs(['--provider', 'openai', '--model', 'gpt-4o'])
    expect(process.env.OPENAI_MODEL).toBeUndefined()
  })

  test('is a no-op when inline --provider is present', () => {
    const result = applyModelFlagFromArgs([
      '--provider=anthropic',
      '--model=sonnet',
    ])
    expect(result).toBeUndefined()
    expect(process.env.ANTHROPIC_MODEL).toBeUndefined()
  })

  test('sets OPENAI_MODEL when CLAUDE_CODE_USE_OPENAI is active', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    applyModelFlagFromArgs(['--model', 'gpt-4o-mini'])
    expect(process.env.OPENAI_MODEL).toBe('gpt-4o-mini')
  })

  test('resolves default for an active Command Code route', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'commandcode'
    process.env.OPENAI_BASE_URL = 'https://api.commandcode.ai/provider/v1'

    const result = applyModelFlagFromArgs(['--model', 'default'])

    expect(result?.error).toBeUndefined()
    expect(process.env.OPENAI_MODEL).toBe('deepseek/deepseek-v4-flash')
  })

  test('rejects an incompatible model override on the active Command Code route', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'https://api.commandcode.ai/provider/v1'
    process.env.OPENAI_MODEL = 'deepseek/deepseek-v4-flash'

    const result = applyModelFlagFromArgs([
      '--model',
      'anthropic/claude-sonnet-4-6',
    ])

    expect(result?.error).toContain('requires the Anthropic Messages protocol')
    expect(process.env.OPENAI_MODEL).toBe('deepseek/deepseek-v4-flash')
  })

  test('rejects an incompatible equals-separated model on the active Command Code route', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'https://api.commandcode.ai/provider/v1'
    process.env.OPENAI_MODEL = 'deepseek/deepseek-v4-flash'

    const result = applyModelFlagFromArgs([
      '--model=anthropic/claude-sonnet-4-6',
    ])

    expect(result?.error).toContain('Anthropic Messages protocol')
    expect(process.env.OPENAI_MODEL).toBe('deepseek/deepseek-v4-flash')
  })

  test('sets GEMINI_MODEL when CLAUDE_CODE_USE_GEMINI is active', () => {
    process.env.CLAUDE_CODE_USE_GEMINI = '1'
    applyModelFlagFromArgs(['--model', 'gemini-2.0-flash'])
    expect(process.env.GEMINI_MODEL).toBe('gemini-2.0-flash')
  })

  test('sets MISTRAL_MODEL when CLAUDE_CODE_USE_MISTRAL is active', () => {
    process.env.CLAUDE_CODE_USE_MISTRAL = '1'
    applyModelFlagFromArgs(['--model', 'devstral-latest'])
    expect(process.env.MISTRAL_MODEL).toBe('devstral-latest')
  })

  test('sets OPENAI_MODEL when CLAUDE_CODE_USE_GITHUB is active', () => {
    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    applyModelFlagFromArgs(['--model', 'gpt-4.1'])
    expect(process.env.OPENAI_MODEL).toBe('gpt-4.1')
  })

  test('falls back to ANTHROPIC_MODEL when no provider flag is set', () => {
    applyModelFlagFromArgs(['--model', 'claude-sonnet-4-6'])
    expect(process.env.ANTHROPIC_MODEL).toBe('claude-sonnet-4-6')
  })

  test('overrides an existing *_MODEL value (saved profile override)', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_MODEL = 'gpt-4o'
    applyModelFlagFromArgs(['--model', 'gpt-4o-mini'])
    expect(process.env.OPENAI_MODEL).toBe('gpt-4o-mini')
  })

  test('accepts --model value containing colons (ollama tag syntax)', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    applyModelFlagFromArgs(['--model', 'qwen2.5-coder:14b'])
    expect(process.env.OPENAI_MODEL).toBe('qwen2.5-coder:14b')
  })
})

describe('applyProviderFlag - concentrate', () => {
  test('sets Concentrate OpenAI-compatible defaults and mirrors CONCENTRATE_API_KEY', () => {
    process.env.CONCENTRATE_API_KEY = 'concentrate-secret-key'

    const result = applyProviderFlag('concentrate', [])

    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.concentrate.ai/v1')
    expect(process.env.OPENAI_MODEL).toBe('deepseek-v4-flash')
    expect(process.env.OPENAI_API_KEY).toBe('concentrate-secret-key')
  })

  test('uses CONCENTRATE_BASE_URL and CONCENTRATE_MODEL from env', () => {
    process.env.CONCENTRATE_API_KEY = 'concentrate-secret-key'
    process.env.CONCENTRATE_BASE_URL = 'https://api.concentrate.ai/v1'
    process.env.CONCENTRATE_MODEL = 'claude-sonnet-5'

    applyProviderFlag('concentrate', [])

    expect(process.env.OPENAI_BASE_URL).toBe('https://api.concentrate.ai/v1')
    expect(process.env.OPENAI_MODEL).toBe('claude-sonnet-5')
  })

  test('does not mirror the dedicated key to a noncanonical Concentrate URL', () => {
    process.env.CONCENTRATE_API_KEY = 'concentrate-secret-key'
    process.env.CONCENTRATE_BASE_URL = 'https://api.concentrate.ai/staging/v1'

    applyProviderFlag('concentrate', [])

    expect(process.env.OPENAI_BASE_URL).toBe('https://api.concentrate.ai/staging/v1')
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })

  test('explicit --model overrides CONCENTRATE_MODEL and OPENAI_MODEL', () => {
    process.env.CONCENTRATE_API_KEY = 'concentrate-secret-key'
    process.env.CONCENTRATE_MODEL = 'claude-sonnet-5'

    applyProviderFlag('concentrate', ['--model', 'deepseek-v4-pro-0731'])

    expect(process.env.OPENAI_MODEL).toBe('deepseek-v4-pro-0731')
    expect(process.env.CONCENTRATE_MODEL).toBeUndefined()
  })

  test('dedicated key overrides a lingering OPENAI_API_KEY from another provider', () => {
    process.env.OPENAI_API_KEY = 'existing-openai-key'
    process.env.CONCENTRATE_API_KEY = 'concentrate-secret-key'

    applyProviderFlag('concentrate', [])

    expect(process.env.OPENAI_API_KEY).toBe('concentrate-secret-key')
  })

  test('clears a stale OPENAI_API_KEY when no Concentrate key is set', () => {
    delete process.env.CONCENTRATE_API_KEY
    process.env.OPENAI_API_KEY = 'existing-openai-key'

    applyProviderFlag('concentrate', [])

    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })

  test.each(['SUA_CHAVE', 'sua_chave', 'null', 'undefined', ' NULL '])(
    'does not mirror placeholder Concentrate credential %s',
    placeholder => {
      process.env.CONCENTRATE_API_KEY = placeholder

      applyProviderFlag('concentrate', [])

      expect(process.env.OPENAI_API_KEY).toBeUndefined()
    },
  )

  test('clears a copied Concentrate key from OPENAI_API_KEY when switching to another provider', () => {
    process.env.CONCENTRATE_API_KEY = 'concentrate-secret-key'
    process.env.OPENAI_API_KEY = 'concentrate-secret-key'

    applyProviderFlag('openai', [])

    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })

  test('switching from Concentrate to Ollama replaces the route identity and credentials', () => {
    process.env.CONCENTRATE_API_KEY = 'concentrate-secret-key'

    applyProviderFlag('concentrate', [])
    applyProviderFlag('ollama', [])

    expect(process.env.CONCENTRATE_API_KEY).toBeUndefined()
    expect(process.env.CONCENTRATE_BASE_URL).toBeUndefined()
    expect(process.env.CONCENTRATE_MODEL).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBe('http://localhost:11434/v1')
    expect(process.env.OPENAI_API_KEY).toBe('ollama')
    expect(resolveActiveRouteIdFromEnv(process.env)).toBe('ollama')
  })

  test('switching from Concentrate to OpenAI replaces the known gateway endpoint', () => {
    process.env.CONCENTRATE_API_KEY = 'concentrate-secret-key'

    applyProviderFlag('concentrate', [])
    applyProviderFlag('openai', [])

    expect(process.env.CONCENTRATE_API_KEY).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.openai.com/v1')
    expect(resolveActiveRouteIdFromEnv(process.env)).toBe('openai')
  })

  test('clears unsupported OpenAI shim settings from a previous route', () => {
    process.env.CONCENTRATE_API_KEY = 'concentrate-secret-key'
    process.env.OPENAI_API_FORMAT = 'responses'
    process.env.OPENAI_AUTH_HEADER = 'x-api-key'
    process.env.OPENAI_AUTH_SCHEME = 'raw'
    process.env.OPENAI_AUTH_HEADER_VALUE = 'stale-value'
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'X-Proxy-Auth: proxy-secret'

    applyProviderFlag('concentrate', [])

    expect(process.env.OPENAI_API_FORMAT).toBeUndefined()
    expect(process.env.OPENAI_AUTH_HEADER).toBeUndefined()
    expect(process.env.OPENAI_AUTH_SCHEME).toBeUndefined()
    expect(process.env.OPENAI_AUTH_HEADER_VALUE).toBeUndefined()
    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined()
  })
})

describe('applyProviderFlag - api-route', () => {
  test('sets API Route OpenAI-compatible defaults and mirrors API_ROUTE_API_KEY', () => {
    process.env.API_ROUTE_API_KEY = 'api-route-secret-key'

    const result = applyProviderFlag('api-route', [])

    expect(result.error).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://global.api-route.com/v1')
    expect(process.env.OPENAI_API_KEY).toBe('api-route-secret-key')
    expect(process.env.OPENAI_MODEL).toBe('claude-sonnet-4-6')
  })

  test('uses API_ROUTE_MODEL from env when --model is not provided', () => {
    process.env.API_ROUTE_API_KEY = 'api-route-secret-key'
    process.env.API_ROUTE_MODEL = 'custom-api-route-model'

    applyProviderFlag('api-route', [])

    expect(process.env.OPENAI_MODEL).toBe('custom-api-route-model')
  })

  test('explicit --model overrides API_ROUTE_MODEL', () => {
    process.env.API_ROUTE_API_KEY = 'api-route-secret-key'
    process.env.API_ROUTE_MODEL = 'custom-api-route-model'

    applyProviderFlag('api-route', ['--model', 'flag-model'])

    expect(process.env.OPENAI_MODEL).toBe('flag-model')
  })

  test.each(['', '   ', 'null', 'undefined', ' NULL '])(
    'does not contaminate OPENAI_MODEL with unusable API_ROUTE_MODEL %j',
    placeholder => {
      process.env.API_ROUTE_API_KEY = 'api-route-secret-key'
      process.env.API_ROUTE_MODEL = placeholder

      applyProviderFlag('api-route', [])

      expect(process.env.OPENAI_MODEL).toBe('claude-sonnet-4-6')
    },
  )

  test('does not forward the dedicated key to a preserved custom base URL', () => {
    process.env.API_ROUTE_API_KEY = 'api-route-secret-key'
    process.env.OPENAI_BASE_URL = 'https://custom-proxy.example.com/v1'

    applyProviderFlag('api-route', [])

    expect(process.env.OPENAI_BASE_URL).toBe(
      'https://custom-proxy.example.com/v1',
    )
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })

  test('dedicated key overrides a lingering OPENAI_API_KEY from another provider', () => {
    process.env.OPENAI_API_KEY = 'existing-openai-key'
    process.env.API_ROUTE_API_KEY = 'api-route-secret-key'

    applyProviderFlag('api-route', [])

    expect(process.env.OPENAI_API_KEY).toBe('api-route-secret-key')
  })

  test('clears OPENAI_API_KEYS when dedicated API Route key is set on canonical endpoint', () => {
    process.env.API_ROUTE_API_KEY = 'api-route-secret-key'
    process.env.OPENAI_API_KEYS = 'stale-key-1,stale-key-2'

    applyProviderFlag('api-route', [])

    expect(process.env.OPENAI_API_KEY).toBe('api-route-secret-key')
    expect(process.env.OPENAI_API_KEYS).toBeUndefined()
  })

  test('clears a stale OPENAI_API_KEY when no API Route key is set', () => {
    delete process.env.API_ROUTE_API_KEY
    process.env.OPENAI_API_KEY = 'existing-openai-key'

    applyProviderFlag('api-route', [])

    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })

  test.each(['SUA_CHAVE', 'sua_chave', 'null', 'undefined', ' NULL '])(
    'does not mirror placeholder API Route credential %s',
    placeholder => {
      process.env.API_ROUTE_API_KEY = placeholder

      applyProviderFlag('api-route', [])

      expect(process.env.OPENAI_API_KEY).toBeUndefined()
    },
  )

  test('clears unsupported OpenAI shim settings from a previous route', () => {
    process.env.API_ROUTE_API_KEY = 'api-route-secret-key'
    process.env.OPENAI_API_FORMAT = 'responses'
    process.env.OPENAI_AUTH_HEADER = 'x-api-key'
    process.env.OPENAI_AUTH_SCHEME = 'raw'
    process.env.OPENAI_AUTH_HEADER_VALUE = 'stale-value'
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'X-Proxy-Auth: proxy-secret'

    applyProviderFlag('api-route', [])

    expect(process.env.OPENAI_API_FORMAT).toBeUndefined()
    expect(process.env.OPENAI_AUTH_HEADER).toBeUndefined()
    expect(process.env.OPENAI_AUTH_SCHEME).toBeUndefined()
    expect(process.env.OPENAI_AUTH_HEADER_VALUE).toBeUndefined()
    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined()
  })

  test('clears a copied API Route key from OPENAI_API_KEY when switching to another provider', () => {
    process.env.API_ROUTE_API_KEY = 'api-route-secret-key'
    process.env.OPENAI_API_KEY = 'api-route-secret-key'

    applyProviderFlag('openai', [])

    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })

  test('switching from API Route to Ollama replaces the route identity and credentials', () => {
    process.env.API_ROUTE_API_KEY = 'api-route-secret-key'

    applyProviderFlag('api-route', [])
    applyProviderFlag('ollama', [])

    expect(process.env.API_ROUTE_API_KEY).toBeUndefined()
    expect(process.env.API_ROUTE_MODEL).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBe('http://localhost:11434/v1')
    expect(process.env.OPENAI_API_KEY).toBe('ollama')
    expect(resolveActiveRouteIdFromEnv(process.env)).toBe('ollama')
  })

  test('switching from API Route to OpenAI replaces the known gateway endpoint', () => {
    process.env.API_ROUTE_API_KEY = 'api-route-secret-key'

    applyProviderFlag('api-route', [])
    applyProviderFlag('openai', [])

    expect(process.env.API_ROUTE_API_KEY).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.openai.com/v1')
    expect(resolveActiveRouteIdFromEnv(process.env)).toBe('openai')
  })
})


