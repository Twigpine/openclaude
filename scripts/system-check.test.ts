import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  buildMemoryGuardChecks,
  buildSandboxRuntimeCheck,
  checkWebSearchEnv,
  checkOpenAIEnv,
  checkNodeVersion,
  formatReachabilityFailureDetail,
  isCliSandboxRuntimeStubbed,
  readNodeExecutableVersion,
  serializeSafeEnvSummary,
} from './system-check.ts'
import { DEFAULT_MAX_ACTIVE_MESSAGES_HARD_CAP } from '../src/utils/maxActiveMessages.ts'
import { resetSettingsCache } from '../src/utils/settings/settingsCache.ts'

const ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID',
  'CLAUDE_CODE_PROVIDER_ROUTE_ID',
  'CLAUDE_CODE_DEFAULT_STARTUP_PROVIDER',
  'CLAUDE_CODE_SIMPLE',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_MODEL',
  'GEMINI_BASE_URL',
  'GEMINI_AUTH_MODE',
  'GEMINI_ACCESS_TOKEN',
  'MISTRAL_API_KEY',
  'MISTRAL_MODEL',
  'MISTRAL_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_API_FORMAT',
  'OPENAI_AUTH_HEADER',
  'OPENAI_AUTH_SCHEME',
  'OPENAI_AUTH_HEADER_VALUE',
  'OPENAI_API_KEYS',
  'OPENAI_API_KEY',
  'OPENGATEWAY_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_COPILOT_KEY',
  'GITHUB_ENTERPRISE_URL',
  'CODEX_API_KEY',
  'CODEX_CREDENTIAL_SOURCE',
  'CODEX_AUTH_JSON_PATH',
  'CODEX_HOME',
  'CHATGPT_ACCOUNT_ID',
  'CODEX_ACCOUNT_ID',
  'NVIDIA_NIM',
  'NVIDIA_API_KEY',
  'NVIDIA_MODEL',
  'MINIMAX_API_KEY',
  'MINIMAX_BASE_URL',
  'MINIMAX_MODEL',
  'BANKR_BASE_URL',
  'BNKR_API_KEY',
  'BANKR_MODEL',
  'XAI_API_KEY',
  'XAI_CREDENTIAL_SOURCE',
  'AIMLAPI_API_KEY',
  'VENICE_API_KEY',
  'MIMO_API_KEY',
  'ATLAS_CLOUD_API_KEY',
  'GMI_API_KEY',
  'APISMART_API_KEY',
  'APISMART_MODEL',
  'NEARAI_API_KEY',
  'FIREWORKS_API_KEY',
  'CLINE_API_KEY',
  'OPENCODE_API_KEY',
  'DISABLE_COMPACT',
  'DISABLE_AUTO_COMPACT',
  'OPENCLAUDE_MAX_ACTIVE_MESSAGES',
  'OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP',
  'OPENCLAUDE_MAX_MEMORY_MB',
  'OPENCLAUDE_CONFIG_DIR',
  'WEB_SEARCH_PROVIDER',
  'WEB_SEARCH_TIMEOUT_SEC',
  'WEB_SEARCH_API',
  'WEB_PROVIDER',
  'WEB_URL_TEMPLATE',
  'WEB_KEY',
  'GOOGLE_CSE_ID',
  'FIRECRAWL_API_KEY',
  'FIRECRAWL_API_URL',
  'OLLAMA_API_KEY',
  'OLLAMA_BASE_URL',
  'TAVILY_API_KEY',
  'EXA_API_KEY',
  'YOU_API_KEY',
  'JINA_API_KEY',
  'BRAVE_API_KEY',
  'BING_API_KEY',
  'MOJEEK_API_KEY',
  'LINKUP_API_KEY',
] as const

const originalEnv: Record<string, string | undefined> = {}
let tempConfigDir: string | undefined

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key]
    delete process.env[key]
  }
  tempConfigDir = mkdtempSync(join(tmpdir(), 'openclaude-system-check-'))
  process.env.OPENCLAUDE_CONFIG_DIR = tempConfigDir
  resetSettingsCache()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = originalEnv[key]
    }
  }
  resetSettingsCache()
  if (tempConfigDir) {
    rmSync(tempConfigDir, { recursive: true, force: true })
    tempConfigDir = undefined
  }
})

describe('formatReachabilityFailureDetail', () => {
  test('returns generic failure detail for non-codex transport', () => {
    const detail = formatReachabilityFailureDetail(
      'https://api.openai.com/v1/models',
      429,
      '{"error":"rate_limit"}',
      {
        transport: 'chat_completions',
        requestedModel: 'gpt-4o',
        resolvedModel: 'gpt-4o',
      },
    )

    expect(detail).toBe(
      'Unexpected status 429 from https://api.openai.com/v1/models. Body: {"error":"rate_limit"}',
    )
  })

  test('redacts credentials and sensitive query parameters in endpoint details', () => {
    const detail = formatReachabilityFailureDetail(
      'http://user:pass@localhost:11434/v1/models?token=abc123&mode=test',
      502,
      'bad gateway',
      {
        transport: 'chat_completions',
        requestedModel: 'llama3.1:8b',
        resolvedModel: 'llama3.1:8b',
      },
    )

    expect(detail).toBe(
      'Unexpected status 502 from http://redacted:redacted@localhost:11434/v1/models?token=redacted&mode=test. Body: bad gateway',
    )
  })

  test('redacts secret-shaped values embedded in response bodies', () => {
    const leakedKey = 'sk-liveLeakToken1234567890ABCdef'
    const detail = formatReachabilityFailureDetail(
      'https://api.openai.com/v1/models',
      401,
      `{"error":"Invalid API key: ${leakedKey}"}`,
      {
        transport: 'chat_completions',
        requestedModel: 'gpt-4o',
        resolvedModel: 'gpt-4o',
      },
    )

    expect(detail).toBe(
      'Unexpected status 401 from https://api.openai.com/v1/models. Body: {"error":"Invalid API key: sk-...def"}',
    )
    expect(detail).not.toContain(leakedKey)
  })

  test('adds alias/entitlement hint for codex model support 400s', () => {
    const detail = formatReachabilityFailureDetail(
      'https://chatgpt.com/backend-api/codex/responses',
      400,
      '{"detail":"The \\"gpt-5.3-codex-spark\\" model is not supported when using Codex with a ChatGPT account."}',
      {
        transport: 'codex_responses',
        requestedModel: 'codexspark',
        resolvedModel: 'gpt-5.3-codex-spark',
      },
    )

    expect(detail).toContain(
      'model alias "codexspark" resolved to "gpt-5.3-codex-spark"',
    )
    expect(detail).toContain(
      'Try "codexplan" or another entitled Codex model.',
    )
  })

  test('redacts descriptor-declared provider secret values in codex model hints', () => {
    const providerSecret = 'ogw-provider-secret'
    process.env.OPENGATEWAY_API_KEY = providerSecret

    const detail = formatReachabilityFailureDetail(
      'https://chatgpt.com/backend-api/codex/responses',
      400,
      '{"detail":"model is not supported with this chatgpt account"}',
      {
        transport: 'codex_responses',
        requestedModel: providerSecret,
        resolvedModel: providerSecret,
      },
    )

    expect(detail).toContain('model alias "ogw...ret" resolved to "ogw...ret"')
    expect(detail).not.toContain(providerSecret)
  })
})

describe('system-check provider diagnostics', () => {
  test('redacts descriptor-declared provider secret values in displayed model fields', () => {
    const providerSecret = 'ogw-provider-secret'
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'https://opengateway.gitlawb.com/v1'
    process.env.OPENAI_MODEL = providerSecret
    process.env.OPENGATEWAY_API_KEY = providerSecret

    const results = checkOpenAIEnv()
    const serialized = JSON.stringify(results)

    expect(serialized).toContain('ogw...ret')
    expect(serialized).not.toContain(providerSecret)
  })

  test('summarizes descriptor-declared provider credentials without exposing values', () => {
    const providerSecret = 'ogw-provider-secret'
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'https://opengateway.gitlawb.com/v1'
    process.env.OPENAI_MODEL = providerSecret
    process.env.OPENGATEWAY_API_KEY = providerSecret

    const summary = serializeSafeEnvSummary()

    expect(summary.OPENAI_MODEL).toBe('ogw...ret')
    expect(summary.PROVIDER_API_KEY_SET).toBe(true)
    expect(JSON.stringify(summary)).not.toContain(providerSecret)
  })

  test('does not use active GitHub credentials for a default OpenAI base URL', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
    process.env.GITHUB_TOKEN = 'ghp_FAKEgithubToken0123456789'
    delete process.env.OPENAI_API_KEY

    const results = checkOpenAIEnv()
    const summary = serializeSafeEnvSummary()
    const credentialResult = results.find(
      result => result.label === 'OPENAI_API_KEYS or OPENAI_API_KEY',
    )

    expect(credentialResult).toEqual({
      ok: false,
      label: 'OPENAI_API_KEYS or OPENAI_API_KEY',
      detail:
        'Missing key for non-local provider URL. Set OPENAI_API_KEYS or OPENAI_API_KEY.',
    })
    expect(summary.PROVIDER_API_KEY_SET).toBe(false)
  })

  test('falls back to OPENAI_API_KEY when OPENAI_API_KEYS is delimiter-only', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
    process.env.OPENAI_MODEL = 'gpt-4o'
    process.env.OPENAI_API_KEYS = ', ,'
    process.env.OPENAI_API_KEY = 'sk-openai-single'

    const results = checkOpenAIEnv()
    const summary = serializeSafeEnvSummary()
    const credentialResult = results.find(
      result => result.label === 'OPENAI_API_KEYS or OPENAI_API_KEY',
    )

    expect(credentialResult).toEqual({
      ok: true,
      label: 'OPENAI_API_KEYS or OPENAI_API_KEY',
      detail: 'Configured.',
    })
    expect(summary.PROVIDER_API_KEY_SET).toBe(true)
  })

  test('accepts valid OPENAI_API_KEYS before placeholder OPENAI_API_KEY fallback', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
    process.env.OPENAI_MODEL = 'gpt-4o'
    process.env.OPENAI_API_KEYS = 'sk-openai-a,sk-openai-b'
    process.env.OPENAI_API_KEY = 'SUA_CHAVE'

    const results = checkOpenAIEnv()
    const summary = serializeSafeEnvSummary()
    const credentialResult = results.find(
      result => result.label === 'OPENAI_API_KEYS or OPENAI_API_KEY',
    )

    expect(credentialResult).toEqual({
      ok: true,
      label: 'OPENAI_API_KEYS or OPENAI_API_KEY',
      detail: 'Configured.',
    })
    expect(summary.PROVIDER_API_KEY_SET).toBe(true)
  })

  test('rejects placeholder values inside OPENAI_API_KEYS pools', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
    process.env.OPENAI_MODEL = 'gpt-4o'
    process.env.OPENAI_API_KEYS = 'sk-openai-a,SUA_CHAVE'
    delete process.env.OPENAI_API_KEY

    const results = checkOpenAIEnv()
    const credentialResult = results.find(
      result => result.label === 'OPENAI_API_KEYS or OPENAI_API_KEY',
    )

    expect(credentialResult).toEqual({
      ok: false,
      label: 'OPENAI_API_KEYS or OPENAI_API_KEY',
      detail: 'Placeholder value detected: SUA_CHAVE.',
    })
  })
})

describe('system-check WebSearch diagnostics', () => {
  const reliableBackendHint =
    'OLLAMA_BASE_URL, OLLAMA_API_KEY, FIRECRAWL_API_KEY, TAVILY_API_KEY, EXA_API_KEY, YOU_API_KEY, JINA_API_KEY, BRAVE_API_KEY, BING_API_KEY, MOJEEK_API_KEY, or LINKUP_API_KEY'

  function expectWebSearchBackend(
    ok: boolean,
    detail: string,
    timeoutSeconds: string | false = '15',
  ) {
    expect(checkWebSearchEnv()).toEqual([
      {
        ok,
        label: 'Web search backend',
        detail: timeoutSeconds === false
          ? detail
          : `${detail} Built-in provider timeout: ${timeoutSeconds}s.`,
      },
    ])
  }

  function useOpenAICompatibleProvider() {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_MODEL = 'gpt-4o'
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  }

  function useOpenAICompatibleProviderWithoutModel() {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  }

  test('reports auto mode using native first-party search before adapters', () => {
    expectWebSearchBackend(
      true,
      'WEB_SEARCH_PROVIDER=auto; firstParty native web search will be used before adapter providers.',
      false,
    )
  })

  test('reports configured API-backed providers when auto mode uses native search first', () => {
    process.env.BRAVE_API_KEY = 'brave-secret-value-123'

    expectWebSearchBackend(
      true,
      'WEB_SEARCH_PROVIDER=auto; firstParty native web search will be used before adapter providers. Configured API-backed providers: brave.',
      false,
    )
  })

  test('fails auto mode for unsupported Vertex native model instead of claiming DuckDuckGo fallback', () => {
    process.env.CLAUDE_CODE_USE_VERTEX = '1'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-3-7-sonnet@20250219'

    expectWebSearchBackend(
      false,
      `WEB_SEARCH_PROVIDER=auto selected, but vertex model claude-3-7-sonnet@20250219 does not support native web search and runtime will not use adapter providers in auto mode. Use a Claude 4 Vertex model or set an explicit WEB_SEARCH_PROVIDER adapter mode with ${reliableBackendHint}.`,
      false,
    )
  })

  test('fails auto mode for unsupported Vertex native model even when adapter keys are configured', () => {
    process.env.CLAUDE_CODE_USE_VERTEX = '1'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-3-7-sonnet@20250219'
    process.env.BRAVE_API_KEY = 'brave-secret-value-123'

    expectWebSearchBackend(
      false,
      `WEB_SEARCH_PROVIDER=auto selected, but vertex model claude-3-7-sonnet@20250219 does not support native web search and runtime will not use adapter providers in auto mode. Use a Claude 4 Vertex model or set an explicit WEB_SEARCH_PROVIDER adapter mode with ${reliableBackendHint}. Configured API-backed providers: brave.`,
      false,
    )
  })

  test('reports auto mode with only DuckDuckGo fallback available', () => {
    useOpenAICompatibleProvider()

    expectWebSearchBackend(
      true,
      `WEB_SEARCH_PROVIDER=auto; only DuckDuckGo fallback is available. DuckDuckGo scraping can be rate-limited from datacenter/VPN/repeated-request networks. Configure ${reliableBackendHint} for reliable search.`,
    )
  })

  test('uses the runtime OpenAI default model in auto mode when OPENAI_MODEL is unset', () => {
    useOpenAICompatibleProviderWithoutModel()

    expectWebSearchBackend(
      true,
      `WEB_SEARCH_PROVIDER=auto; only DuckDuckGo fallback is available. DuckDuckGo scraping can be rate-limited from datacenter/VPN/repeated-request networks. Configure ${reliableBackendHint} for reliable search.`,
    )
  })

  test('reports the configured built-in provider timeout', () => {
    useOpenAICompatibleProvider()
    process.env.WEB_SEARCH_TIMEOUT_SEC = '30'

    expectWebSearchBackend(
      true,
      `WEB_SEARCH_PROVIDER=auto; only DuckDuckGo fallback is available. DuckDuckGo scraping can be rate-limited from datacenter/VPN/repeated-request networks. Configure ${reliableBackendHint} for reliable search.`,
      '30',
    )
  })

  test('reports Firecrawl cloud URL without an API key in auto mode with DuckDuckGo fallback', () => {
    useOpenAICompatibleProvider()
    process.env.FIRECRAWL_API_URL = 'https://api.firecrawl.dev'

    expectWebSearchBackend(
      true,
      `WEB_SEARCH_PROVIDER=auto; only DuckDuckGo fallback is available. DuckDuckGo scraping can be rate-limited from datacenter/VPN/repeated-request networks. Configure ${reliableBackendHint} for reliable search. FIRECRAWL_API_URL points to the Firecrawl cloud API but FIRECRAWL_API_KEY is missing; runtime will try firecrawl first and then fall through to the next provider in auto mode.`,
    )
  })

  test('reports Firecrawl cloud URL without an API key in auto mode with a later API fallback', () => {
    useOpenAICompatibleProvider()
    process.env.FIRECRAWL_API_URL = 'https://api.firecrawl.dev'
    process.env.BRAVE_API_KEY = 'brave-secret-value-123'

    expectWebSearchBackend(
      true,
      'WEB_SEARCH_PROVIDER=auto; configured providers: brave; fallback includes duckduckgo. FIRECRAWL_API_URL points to the Firecrawl cloud API but FIRECRAWL_API_KEY is missing; runtime will try firecrawl first and then fall through to the next provider in auto mode.',
    )
  })

  test('reports configured API-backed providers in auto mode', () => {
    useOpenAICompatibleProvider()
    process.env.BRAVE_API_KEY = 'brave-secret-value-123'
    process.env.EXA_API_KEY = 'exa-secret-value-123'

    expectWebSearchBackend(
      true,
      'WEB_SEARCH_PROVIDER=auto; configured providers: exa, brave; fallback includes duckduckgo.',
    )
  })

  test('reports the active Ollama search adapter in auto mode', () => {
    useOpenAICompatibleProvider()
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'

    expectWebSearchBackend(
      true,
      'WEB_SEARCH_PROVIDER=auto; configured providers: ollama; fallback includes duckduckgo.',
    )
  })

  test('reports malformed Ollama local configuration in auto mode', () => {
    useOpenAICompatibleProvider()
    process.env.OLLAMA_BASE_URL = 'not a url'

    expectWebSearchBackend(
      true,
      `WEB_SEARCH_PROVIDER=auto; only DuckDuckGo fallback is available. DuckDuckGo scraping can be rate-limited from datacenter/VPN/repeated-request networks. Configure ${reliableBackendHint} for reliable search. OLLAMA_BASE_URL is invalid; runtime will skip ollama and fall through to the next provider in auto mode.`,
    )
  })

  test('reports hosted Ollama fallback when its local URL is malformed in auto mode', () => {
    useOpenAICompatibleProvider()
    process.env.OLLAMA_BASE_URL = 'not a url'
    process.env.OLLAMA_API_KEY = 'ollama-secret-value-123'

    expectWebSearchBackend(
      true,
      'WEB_SEARCH_PROVIDER=auto; configured providers: ollama; fallback includes duckduckgo. OLLAMA_BASE_URL is invalid; runtime will skip local Ollama search and use the hosted Ollama API.',
    )
  })

  test.each(['undefined', 'null', 'SUA_CHAVE', ' sua_chave '])(
    'does not report hosted fallback for an %s Ollama key placeholder in auto mode',
    placeholder => {
      useOpenAICompatibleProvider()
      process.env.OLLAMA_BASE_URL = 'not a url'
      process.env.OLLAMA_API_KEY = placeholder

      expectWebSearchBackend(
        true,
        `WEB_SEARCH_PROVIDER=auto; only DuckDuckGo fallback is available. DuckDuckGo scraping can be rate-limited from datacenter/VPN/repeated-request networks. Configure ${reliableBackendHint} for reliable search. OLLAMA_BASE_URL is invalid; runtime will skip ollama and fall through to the next provider in auto mode.`,
      )
    },
  )

  test('reports a malformed active Ollama endpoint in auto mode', () => {
    useOpenAICompatibleProvider()
    process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'ollama'
    process.env.OPENAI_BASE_URL = 'ftp://ollama.internal/v1'

    expectWebSearchBackend(
      true,
      `WEB_SEARCH_PROVIDER=auto; only DuckDuckGo fallback is available. DuckDuckGo scraping can be rate-limited from datacenter/VPN/repeated-request networks. Configure ${reliableBackendHint} for reliable search. Active Ollama provider endpoint is invalid; runtime will skip ollama and fall through to the next provider in auto mode.`,
    )
  })

  test('reports hosted fallback for a malformed active Ollama endpoint in auto mode', () => {
    useOpenAICompatibleProvider()
    process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'ollama'
    process.env.OPENAI_BASE_URL = 'ftp://ollama.internal/v1'
    process.env.OLLAMA_API_KEY = 'ollama-secret-value-123'

    expectWebSearchBackend(
      true,
      'WEB_SEARCH_PROVIDER=auto; configured providers: ollama; fallback includes duckduckgo. Active Ollama provider endpoint is invalid; runtime will skip local Ollama search and use the hosted Ollama API.',
    )
  })

  test('fails explicit provider mode when required credentials are missing', () => {
    process.env.WEB_SEARCH_PROVIDER = 'brave'

    expectWebSearchBackend(
      false,
      'WEB_SEARCH_PROVIDER=brave but BRAVE_API_KEY is missing.',
    )
  })

  test('passes explicit provider mode when required credentials are configured', () => {
    process.env.WEB_SEARCH_PROVIDER = 'brave'
    process.env.BRAVE_API_KEY = 'brave-secret-value-123'

    expectWebSearchBackend(
      true,
      'WEB_SEARCH_PROVIDER=brave; BRAVE_API_KEY configured.',
    )
  })

  test('passes explicit Ollama mode with the active local provider endpoint', () => {
    process.env.WEB_SEARCH_PROVIDER = 'ollama'
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'ollama'
    process.env.OPENAI_BASE_URL = 'https://models.example.com/v1'

    expectWebSearchBackend(
      true,
      'WEB_SEARCH_PROVIDER=ollama; active Ollama provider endpoint configured.',
    )
  })

  test.each(['undefined', 'null'])(
    'uses OPENAI_API_BASE when OPENAI_BASE_URL is the %s placeholder',
    placeholder => {
      process.env.WEB_SEARCH_PROVIDER = 'ollama'
      process.env.CLAUDE_CODE_USE_OPENAI = '1'
      process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'ollama'
      process.env.OPENAI_BASE_URL = placeholder
      process.env.OPENAI_API_BASE = 'http://localhost:11434/v1'

      expectWebSearchBackend(
        true,
        'WEB_SEARCH_PROVIDER=ollama; active Ollama provider endpoint configured.',
      )
    },
  )

  test('passes explicit Ollama mode with local and hosted fallback configuration', () => {
    process.env.WEB_SEARCH_PROVIDER = 'ollama'
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434'
    process.env.OLLAMA_API_KEY = 'ollama-secret-value-123'

    expectWebSearchBackend(
      true,
      'WEB_SEARCH_PROVIDER=ollama; OLLAMA_BASE_URL and OLLAMA_API_KEY configured.',
    )
  })

  test('fails explicit Ollama mode without a local endpoint or hosted credential', () => {
    process.env.WEB_SEARCH_PROVIDER = 'ollama'

    expectWebSearchBackend(
      false,
      'WEB_SEARCH_PROVIDER=ollama but an active Ollama provider, OLLAMA_BASE_URL, or OLLAMA_API_KEY is missing.',
    )
  })

  test('diagnoses malformed Ollama local configuration without throwing', () => {
    process.env.WEB_SEARCH_PROVIDER = 'ollama'
    process.env.OLLAMA_BASE_URL = 'not a url'

    expectWebSearchBackend(
      false,
      'WEB_SEARCH_PROVIDER=ollama but OLLAMA_BASE_URL is not a valid HTTP(S) URL.',
    )
  })

  test('reports hosted fallback when the Ollama local URL is malformed', () => {
    process.env.WEB_SEARCH_PROVIDER = 'ollama'
    process.env.OLLAMA_BASE_URL = 'not a url'
    process.env.OLLAMA_API_KEY = 'ollama-secret-value-123'

    expectWebSearchBackend(
      true,
      'WEB_SEARCH_PROVIDER=ollama; OLLAMA_API_KEY configured; OLLAMA_BASE_URL is invalid and local search will be skipped.',
    )
  })

  test('does not treat a whitespace-only Ollama key as hosted fallback', () => {
    process.env.WEB_SEARCH_PROVIDER = 'ollama'
    process.env.OLLAMA_BASE_URL = 'not a url'
    process.env.OLLAMA_API_KEY = '   '

    expectWebSearchBackend(
      false,
      'WEB_SEARCH_PROVIDER=ollama but OLLAMA_BASE_URL is not a valid HTTP(S) URL.',
    )
  })

  test.each(['undefined', 'null', 'SUA_CHAVE', ' sua_chave '])(
    'does not treat an %s Ollama key placeholder as hosted fallback',
    placeholder => {
      process.env.WEB_SEARCH_PROVIDER = 'ollama'
      process.env.OLLAMA_BASE_URL = 'not a url'
      process.env.OLLAMA_API_KEY = placeholder

      expectWebSearchBackend(
        false,
        'WEB_SEARCH_PROVIDER=ollama but OLLAMA_BASE_URL is not a valid HTTP(S) URL.',
      )
    },
  )

  test('does not report whitespace-only Ollama endpoints as configured', () => {
    process.env.WEB_SEARCH_PROVIDER = 'ollama'
    process.env.OLLAMA_BASE_URL = '   '
    process.env.OLLAMA_API_KEY = 'ollama-secret-value-123'
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'ollama'
    process.env.OPENAI_BASE_URL = '   '

    expectWebSearchBackend(
      true,
      'WEB_SEARCH_PROVIDER=ollama; OLLAMA_API_KEY configured.',
    )
  })

  test('diagnoses a malformed active Ollama endpoint without a hosted key', () => {
    process.env.WEB_SEARCH_PROVIDER = 'ollama'
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'ollama'
    process.env.OPENAI_BASE_URL = 'ftp://ollama.internal/v1'

    expectWebSearchBackend(
      false,
      'WEB_SEARCH_PROVIDER=ollama but active Ollama provider endpoint is not a valid HTTP(S) URL.',
    )
  })

  test('reports hosted fallback for a malformed active Ollama endpoint', () => {
    process.env.WEB_SEARCH_PROVIDER = 'ollama'
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'ollama'
    process.env.OPENAI_BASE_URL = 'ftp://ollama.internal/v1'
    process.env.OLLAMA_API_KEY = 'ollama-secret-value-123'

    expectWebSearchBackend(
      true,
      'WEB_SEARCH_PROVIDER=ollama; OLLAMA_API_KEY configured; active Ollama provider endpoint is invalid and local search will be skipped.',
    )
  })

  test('does not infer an active Ollama endpoint from a hostname substring', () => {
    process.env.WEB_SEARCH_PROVIDER = 'ollama'
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'https://my-ollama.internal/v1'
    process.env.OLLAMA_API_KEY = 'ollama-secret-value-123'

    expectWebSearchBackend(
      true,
      'WEB_SEARCH_PROVIDER=ollama; OLLAMA_API_KEY configured.',
    )
  })

  test('reports supported native mode without requiring API-backed provider credentials', () => {
    process.env.WEB_SEARCH_PROVIDER = 'native'

    expectWebSearchBackend(
      true,
      'WEB_SEARCH_PROVIDER=native selected; firstParty provider supports native web search.',
      false,
    )
  })

  test('reports configured API-backed providers when native mode is selected', () => {
    process.env.WEB_SEARCH_PROVIDER = 'native'
    process.env.BRAVE_API_KEY = 'brave-secret-value-123'

    expectWebSearchBackend(
      true,
      'WEB_SEARCH_PROVIDER=native selected; firstParty provider supports native web search. Configured API-backed providers: brave.',
      false,
    )
  })

  test('fails native mode when the active provider does not support native web search', () => {
    process.env.WEB_SEARCH_PROVIDER = 'native'
    useOpenAICompatibleProvider()

    expectWebSearchBackend(
      false,
      `WEB_SEARCH_PROVIDER=native selected, but openai provider does not support native web search. Configure ${reliableBackendHint}, or switch to an Anthropic, Vertex, Foundry, or Codex responses provider.`,
      false,
    )
  })

  test('uses the runtime OpenAI default model in native mode when OPENAI_MODEL is unset', () => {
    process.env.WEB_SEARCH_PROVIDER = 'native'
    useOpenAICompatibleProviderWithoutModel()

    expectWebSearchBackend(
      false,
      `WEB_SEARCH_PROVIDER=native selected, but openai provider does not support native web search. Configure ${reliableBackendHint}, or switch to an Anthropic, Vertex, Foundry, or Codex responses provider.`,
      false,
    )
  })

  test('fails native mode for Codex aliases when the runtime tool gate rejects that provider', () => {
    process.env.WEB_SEARCH_PROVIDER = 'native'
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_MODEL = 'codexspark'

    expectWebSearchBackend(
      false,
      `WEB_SEARCH_PROVIDER=native selected, but codex provider does not support native web search. Configure ${reliableBackendHint}, or switch to an Anthropic, Vertex, Foundry, or Codex responses provider.`,
      false,
    )
  })

  test('fails Firecrawl cloud mode when the API key is missing', () => {
    process.env.WEB_SEARCH_PROVIDER = 'firecrawl'
    process.env.FIRECRAWL_API_URL = 'https://api.firecrawl.dev'

    expectWebSearchBackend(
      false,
      'WEB_SEARCH_PROVIDER=firecrawl but FIRECRAWL_API_KEY is missing for the Firecrawl cloud API.',
    )
  })

  test('passes Firecrawl self-hosted mode without an API key', () => {
    process.env.WEB_SEARCH_PROVIDER = 'firecrawl'
    process.env.FIRECRAWL_API_URL = 'https://self-hosted.firecrawl.dev'

    expectWebSearchBackend(
      true,
      'WEB_SEARCH_PROVIDER=firecrawl; FIRECRAWL_API_URL configured.',
    )
  })

  test('does not classify Firecrawl proxy URLs as the cloud API', () => {
    process.env.WEB_SEARCH_PROVIDER = 'firecrawl'
    process.env.FIRECRAWL_API_URL = 'https://proxy.example.com/api.firecrawl.dev'

    expectWebSearchBackend(
      true,
      'WEB_SEARCH_PROVIDER=firecrawl; FIRECRAWL_API_URL configured.',
    )
  })

  test('fails custom Google preset when GOOGLE_CSE_ID is missing', () => {
    process.env.WEB_SEARCH_PROVIDER = 'custom'
    process.env.WEB_PROVIDER = 'google'
    process.env.WEB_KEY = 'google-secret-value-123'

    expectWebSearchBackend(
      false,
      'WEB_SEARCH_PROVIDER=custom with WEB_PROVIDER=google but GOOGLE_CSE_ID is missing.',
      false,
    )
  })

  test('fails custom Google preset when WEB_KEY is missing', () => {
    process.env.WEB_SEARCH_PROVIDER = 'custom'
    process.env.WEB_PROVIDER = 'google'
    process.env.GOOGLE_CSE_ID = 'cse-test-id'

    expectWebSearchBackend(
      false,
      'WEB_SEARCH_PROVIDER=custom with WEB_PROVIDER=google but WEB_KEY is missing.',
      false,
    )
  })

  test('passes custom Google preset when required preset credentials are configured', () => {
    process.env.WEB_SEARCH_PROVIDER = 'custom'
    process.env.WEB_PROVIDER = 'google'
    process.env.WEB_KEY = 'google-secret-value-123'
    process.env.GOOGLE_CSE_ID = 'cse-test-id'

    expectWebSearchBackend(
      true,
      'WEB_SEARCH_PROVIDER=custom; WEB_PROVIDER, WEB_KEY, and GOOGLE_CSE_ID configured.',
      false,
    )
  })

  test('fails custom preset when WEB_PROVIDER has surrounding whitespace', () => {
    process.env.WEB_SEARCH_PROVIDER = 'custom'
    process.env.WEB_PROVIDER = 'brave '
    process.env.WEB_KEY = 'brave-secret-value-123'

    expectWebSearchBackend(
      false,
      'WEB_SEARCH_PROVIDER=custom with WEB_PROVIDER=brave but the raw WEB_PROVIDER value has surrounding whitespace and does not match a runtime custom preset. Remove the whitespace or configure WEB_SEARCH_API or WEB_URL_TEMPLATE.',
      false,
    )
  })

  test('passes custom provider with surrounding whitespace when a custom endpoint is configured', () => {
    process.env.WEB_SEARCH_PROVIDER = 'custom'
    process.env.WEB_PROVIDER = 'brave '
    process.env.WEB_SEARCH_API = 'https://example.com/search'

    expectWebSearchBackend(
      true,
      'WEB_SEARCH_PROVIDER=custom; WEB_PROVIDER and WEB_SEARCH_API configured.',
      false,
    )
  })

  test('does not expose WebSearch secret values in diagnostics', () => {
    const secret = 'brave-secret-value-123'
    process.env.WEB_SEARCH_PROVIDER = 'brave'
    process.env.BRAVE_API_KEY = secret

    const results = checkWebSearchEnv()
    const serialized = JSON.stringify(results)

    expect(serialized).toContain('BRAVE_API_KEY configured')
    expect(serialized).not.toContain(secret)
  })
})

describe('system-check memory guard diagnostics', () => {
  test('reports explicit off without a legacy message-count override', () => {
    const results = buildMemoryGuardChecks({
      autoCompactEnabled: true,
      maxMessagesCompactionThreshold: 'off',
      env: {},
    })

    expect(results).toContainEqual({
      ok: true,
      label: 'Auto-compact guard',
      detail: `Enabled; message-count threshold off; hard cap ${DEFAULT_MAX_ACTIVE_MESSAGES_HARD_CAP}.`,
    })
  })

  test('reports the effective default auto-compact and hard-cap guards', () => {
    const results = buildMemoryGuardChecks({
      autoCompactEnabled: true,
      maxMessagesCompactionThreshold: undefined,
      env: {},
    })

    expect(results).toContainEqual({
      ok: true,
      label: 'Auto-compact guard',
      detail: `Enabled; message-count threshold 200; hard cap ${DEFAULT_MAX_ACTIVE_MESSAGES_HARD_CAP}.`,
    })
    expect(results).toContainEqual({
      ok: true,
      label: 'Active-message hard cap',
      detail: `Active at ${DEFAULT_MAX_ACTIVE_MESSAGES_HARD_CAP} messages (default; malformed overrides fall back to ${DEFAULT_MAX_ACTIVE_MESSAGES_HARD_CAP}).`,
    })
    expect(results.find(result => result.label === 'Memory pressure guard'))
      .toMatchObject({ ok: true })
  })

  test('reports the legacy message-count override when the setting is unset or off', () => {
    for (const maxMessagesCompactionThreshold of [undefined, 'off']) {
      const results = buildMemoryGuardChecks({
        autoCompactEnabled: true,
        maxMessagesCompactionThreshold,
        env: { OPENCLAUDE_MAX_ACTIVE_MESSAGES: '500' },
      })

      expect(results).toContainEqual({
        ok: true,
        label: 'Auto-compact guard',
        detail: `Enabled; message-count threshold 500; hard cap ${DEFAULT_MAX_ACTIVE_MESSAGES_HARD_CAP}.`,
      })
    }
  })

  test('reports an explicit message-count setting ahead of the legacy override', () => {
    const results = buildMemoryGuardChecks({
      autoCompactEnabled: true,
      maxMessagesCompactionThreshold: '100',
      env: { OPENCLAUDE_MAX_ACTIVE_MESSAGES: '500' },
    })

    expect(results).toContainEqual({
      ok: true,
      label: 'Auto-compact guard',
      detail: `Enabled; message-count threshold 100; hard cap ${DEFAULT_MAX_ACTIVE_MESSAGES_HARD_CAP}.`,
    })
  })

  test('falls back to the default hard cap when the override is malformed', () => {
    const results = buildMemoryGuardChecks({
      autoCompactEnabled: true,
      maxMessagesCompactionThreshold: undefined,
      env: {
        OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP: 'not-a-number',
      },
    })

    expect(results).toContainEqual({
      ok: true,
      label: 'Active-message hard cap',
      detail: `Active at ${DEFAULT_MAX_ACTIVE_MESSAGES_HARD_CAP} messages; malformed override fell back to ${DEFAULT_MAX_ACTIVE_MESSAGES_HARD_CAP}.`,
    })
  })

  test('reports valid custom hard-cap overrides without fallback wording', () => {
    const results = buildMemoryGuardChecks({
      autoCompactEnabled: true,
      maxMessagesCompactionThreshold: undefined,
      env: {
        OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP: '500',
      },
    })

    expect(results).toContainEqual({
      ok: true,
      label: 'Active-message hard cap',
      detail: 'Active at 500 messages.',
    })
  })

  test('fails when auto-compact is disabled by settings or env flags', () => {
    const results = buildMemoryGuardChecks({
      autoCompactEnabled: false,
      maxMessagesCompactionThreshold: '500',
      env: {
        DISABLE_COMPACT: '1',
        DISABLE_AUTO_COMPACT: 'true',
      },
    })

    expect(results[0]).toEqual({
      ok: false,
      label: 'Auto-compact guard',
      detail:
        'settings disabled; DISABLE_COMPACT is set; DISABLE_AUTO_COMPACT is set; message-count threshold 500 remains active.',
    })
  })

  test('reports an explicit message-count guard when token auto-compact is disabled', () => {
    const results = buildMemoryGuardChecks({
      autoCompactEnabled: true,
      maxMessagesCompactionThreshold: '100',
      env: { DISABLE_AUTO_COMPACT: '1' },
    })

    expect(results[0]).toEqual({
      ok: false,
      label: 'Auto-compact guard',
      detail: 'DISABLE_AUTO_COMPACT is set; message-count threshold 100 remains active.',
    })
  })

  test('does not report the unset default as active when auto-compact is disabled', () => {
    const results = buildMemoryGuardChecks({
      autoCompactEnabled: true,
      maxMessagesCompactionThreshold: undefined,
      env: { DISABLE_AUTO_COMPACT: '1' },
    })

    expect(results[0]).toEqual({
      ok: false,
      label: 'Auto-compact guard',
      detail: 'DISABLE_AUTO_COMPACT is set',
    })
  })

  test('fails when active-message hard cap is explicitly disabled', () => {
    const results = buildMemoryGuardChecks({
      autoCompactEnabled: true,
      maxMessagesCompactionThreshold: '100',
      env: {
        OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP: '0',
        OPENCLAUDE_MAX_MEMORY_MB: '4096',
      },
    })

    expect(results).toContainEqual({
      ok: false,
      label: 'Active-message hard cap',
      detail:
        'Disabled by OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP=0; long sessions can grow without the active-message safety cap.',
    })
    expect(results).toContainEqual({
      ok: true,
      label: 'Memory pressure guard',
      detail:
        'Per-session budget 4096MB; elevated/critical compaction thresholds are derived from this budget at runtime.',
    })
  })
})

describe('checkNodeVersion', () => {
  test('reads the Node.js version from the node executable output', () => {
    const probe = readNodeExecutableVersion(() => ({
      status: 0,
      stdout: 'v22.0.0\n',
      stderr: '',
      error: undefined,
    }))

    expect(probe).toEqual({
      ok: true,
      version: 'v22.0.0',
    })
  })

  test('checks the probed node executable version', () => {
    expect(checkNodeVersion({ ok: true, version: 'v20.11.1' })).toEqual({
      ok: false,
      label: 'Node.js version',
      detail:
        'Detected 20.11.1. OpenClaude requires Node.js >=22.0.0. Install Node 22 LTS or newer, then reinstall/re-run OpenClaude.',
    })
  })

  test('reports a missing node executable as a Node.js version failure', () => {
    const probe = readNodeExecutableVersion(() => ({
      status: null,
      stdout: '',
      stderr: '',
      error: new Error('spawn node ENOENT'),
    }))

    expect(checkNodeVersion(probe)).toEqual({
      ok: false,
      label: 'Node.js version',
      detail:
        'Unable to run `node --version`: spawn node ENOENT. OpenClaude requires Node.js >=22.0.0 on PATH.',
    })
  })

  test('uses the shared Node.js minimum in doctor failures', () => {
    expect(checkNodeVersion('20.11.1')).toEqual({
      ok: false,
      label: 'Node.js version',
      detail:
        'Detected 20.11.1. OpenClaude requires Node.js >=22.0.0. Install Node 22 LTS or newer, then reinstall/re-run OpenClaude.',
    })
  })

  test('passes supported Node.js versions', () => {
    expect(checkNodeVersion('22.0.0')).toEqual({
      ok: true,
      label: 'Node.js version',
      detail: '22.0.0',
    })
  })
})

describe('sandbox runtime diagnostics', () => {
  test('fails when sandbox runtime inspection throws an Error', () => {
    const result = buildSandboxRuntimeCheck({
      inspectionError: new Error('EACCES: permission denied, open dist/cli.mjs'),
    })

    expect(result).toEqual({
      ok: false,
      label: 'Sandbox runtime',
      detail:
        'Unable to inspect CLI sandbox runtime: EACCES: permission denied, open dist/cli.mjs',
    })
  })

  test('fails when sandbox runtime inspection throws a non-Error value', () => {
    const result = buildSandboxRuntimeCheck({
      inspectionError: 'bundle read failed',
    })

    expect(result).toEqual({
      ok: false,
      label: 'Sandbox runtime',
      detail: 'Unable to inspect CLI sandbox runtime: bundle read failed',
    })
  })

  test('detects sandbox-runtime native stubs in the CLI bundle', () => {
    expect(
      isCliSandboxRuntimeStubbed(
        '// native-stub:@anthropic-ai/sandbox-runtime\nconst noop = () => null',
      ),
    ).toBe(true)
    expect(isCliSandboxRuntimeStubbed('bubblewrap (bwrap) not installed')).toBe(
      false,
    )
  })

  test('fails when the CLI bundle contains a sandbox runtime stub', () => {
    const result = buildSandboxRuntimeCheck({
      cliRuntimeStubbed: true,
      sandboxEnabled: true,
      failIfUnavailable: true,
      sandboxingEnabled: false,
      unavailableReason: 'sandbox.enabled is set but the runtime is stubbed',
    })

    expect(result.ok).toBe(false)
    expect(result.label).toBe('Sandbox runtime')
    expect(result.detail).toContain('CLI bundle: stubbed')
    expect(result.detail).toContain('effective behavior: fail-closed')
    expect(result.detail).toContain(
      'reason: sandbox.enabled is set but the runtime is stubbed',
    )
  })

  test('reports warning-only behavior when sandbox is enabled but unavailable', () => {
    const result = buildSandboxRuntimeCheck({
      cliRuntimeStubbed: false,
      sandboxEnabled: true,
      failIfUnavailable: false,
      sandboxingEnabled: false,
      unavailableReason: 'bubblewrap (bwrap) not installed',
    })

    expect(result.ok).toBe(true)
    expect(result.detail).toContain('CLI bundle: real runtime')
    expect(result.detail).toContain('effective behavior: warning-only')
    expect(result.detail).toContain('reason: bubblewrap (bwrap) not installed')
  })

  test('flags fail-closed behavior when sandbox is required but unavailable', () => {
    const result = buildSandboxRuntimeCheck({
      cliRuntimeStubbed: false,
      sandboxEnabled: true,
      failIfUnavailable: true,
      sandboxingEnabled: false,
      unavailableReason: 'bubblewrap (bwrap) not installed',
    })

    expect(result.ok).toBe(false)
    expect(result.detail).toContain('CLI bundle: real runtime')
    expect(result.detail).toContain('effective behavior: fail-closed')
    expect(result.detail).toContain('reason: bubblewrap (bwrap) not installed')
  })

  test('reports enforcing behavior when sandboxing is active', () => {
    const result = buildSandboxRuntimeCheck({
      cliRuntimeStubbed: false,
      sandboxEnabled: true,
      failIfUnavailable: true,
      sandboxingEnabled: true,
    })

    expect(result.ok).toBe(true)
    expect(result.detail).toBe(
      'CLI bundle: real runtime; sandbox.enabled: true; failIfUnavailable: true; effective behavior: enforcing',
    )
  })

  test('reports disabled behavior without failing when sandbox is not enabled', () => {
    const result = buildSandboxRuntimeCheck({
      cliRuntimeStubbed: false,
      sandboxEnabled: false,
      failIfUnavailable: false,
      sandboxingEnabled: false,
    })

    expect(result.ok).toBe(true)
    expect(result.detail).toBe(
      'CLI bundle: real runtime; sandbox.enabled: false; failIfUnavailable: false; effective behavior: disabled',
    )
  })

  test('reports disabled behavior without failing when sandbox is off and the CLI runtime is stubbed', () => {
    const result = buildSandboxRuntimeCheck({
      cliRuntimeStubbed: true,
      sandboxEnabled: false,
      failIfUnavailable: false,
      sandboxingEnabled: false,
    })

    expect(result.ok).toBe(true)
    expect(result.detail).toBe(
      'CLI bundle: stubbed; sandbox.enabled: false; failIfUnavailable: false; effective behavior: disabled',
    )
  })
})
