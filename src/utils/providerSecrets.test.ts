import { describe, expect, test } from 'bun:test'

import {
  ANTHROPIC_PROXY_DESCRIPTORS,
  GATEWAY_DESCRIPTORS,
  PROVIDER_PRESET_MANIFEST,
  VENDOR_DESCRIPTORS,
} from '../integrations/generated/integrationArtifacts.generated.js'
import type { AnthropicProxyDescriptor, ProviderPresetManifestEntry } from '../integrations/descriptors.js'

import {
  getKnownProviderSecretEnvKeys,
  maskSecretForDisplay,
  redactSecretValueForDisplay,
  redactSecretSubstringsForDisplay,
  sanitizeApiKey,
  sanitizeProviderConfigValue,
} from './providerSecrets.js'

const FAKE_OPENAI_KEY = 'sk-fake-openai-1234567890abcdef'
const FAKE_GEMINI_KEY = 'AIzaSyFAKEGEMINIkey1234567890abcdefghijklmnopqr'
const FAKE_GITHUB_PAT = 'ghp_FAKEgithubPat0123456789abcdefghij'
const FAKE_GITHUB_USER_TOKEN = 'ghu_1234567890abcdef1234567890abcdef1234'
const FAKE_LONG_OPAQUE = 'live-pr-1234567890abcdefABCDEF1234567890abcdef'
const FAKE_JWT_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'

describe('getKnownProviderSecretEnvKeys', () => {
  test('returns a cached readonly array', () => {
    const a = getKnownProviderSecretEnvKeys()
    const b = getKnownProviderSecretEnvKeys()
    expect(a).toBe(b)
    expect(Object.isFrozen(a)).toBe(true)
  })

  test('derives apiKeyEnvVars from every PROVIDER_PRESET_MANIFEST entry', () => {
    const known = new Set(getKnownProviderSecretEnvKeys())
    const declared = new Set<string>()
    const presets: readonly ProviderPresetManifestEntry[] = PROVIDER_PRESET_MANIFEST
    for (const entry of presets) {
      for (const key of entry.apiKeyEnvVars ?? []) {
        declared.add(key)
      }
    }
    for (const key of declared) {
      expect(known.has(key), `apiKeyEnvVar ${key} from PROVIDER_PRESET_MANIFEST is not redacted`).toBe(true)
    }
  })

  test('derives setup.credentialEnvVars from every vendor descriptor', () => {
    const known = new Set(getKnownProviderSecretEnvKeys())
    const declared = new Set<string>()
    for (const vendor of VENDOR_DESCRIPTORS) {
      for (const key of vendor.setup?.credentialEnvVars ?? []) {
        declared.add(key)
      }
    }
    for (const key of declared) {
      expect(known.has(key), `credentialEnvVar ${key} from a vendor descriptor is not redacted`).toBe(true)
    }
  })

  test('derives setup.credentialEnvVars from every gateway descriptor', () => {
    const known = new Set(getKnownProviderSecretEnvKeys())
    const declared = new Set<string>()
    for (const gateway of GATEWAY_DESCRIPTORS) {
      for (const key of gateway.setup?.credentialEnvVars ?? []) {
        declared.add(key)
      }
    }
    for (const key of declared) {
      expect(known.has(key), `credentialEnvVar ${key} from a gateway descriptor is not redacted`).toBe(true)
    }
  })

  test('derives setup.credentialEnvVars from every anthropic proxy descriptor', () => {
    const known = new Set(getKnownProviderSecretEnvKeys())
    const declared = new Set<string>()
    const proxies: readonly AnthropicProxyDescriptor[] = ANTHROPIC_PROXY_DESCRIPTORS
    for (const proxy of proxies) {
      for (const key of proxy.setup?.credentialEnvVars ?? []) {
        declared.add(key)
      }
    }
    for (const key of declared) {
      expect(known.has(key), `credentialEnvVar ${key} from an anthropic proxy descriptor is not redacted`).toBe(true)
    }
  })

  test('derives validation.credentialEnvVars from every descriptor with validation metadata', () => {
    const known = new Set(getKnownProviderSecretEnvKeys())
    const declared = new Set<string>()
    for (const descriptor of [
      ...VENDOR_DESCRIPTORS,
      ...GATEWAY_DESCRIPTORS,
      ...ANTHROPIC_PROXY_DESCRIPTORS,
    ]) {
      const validation = (descriptor as { validation?: { credentialEnvVars?: readonly string[] } }).validation
      for (const key of validation?.credentialEnvVars ?? []) {
        declared.add(key)
      }
    }
    for (const key of declared) {
      expect(known.has(key), `validation credentialEnvVar ${key} is not redacted`).toBe(true)
    }
  })

  test('includes manually-curated fallback credential keys', () => {
    const known = new Set(getKnownProviderSecretEnvKeys())
    for (const key of [
      'OPENAI_API_KEY',
      'OPENAI_AUTH_HEADER_VALUE',
      'CODEX_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'GEMINI_ACCESS_TOKEN',
      'MISTRAL_API_KEY',
      'BNKR_API_KEY',
      'XAI_API_KEY',
    ]) {
      expect(known.has(key), `fallback key ${key} missing`).toBe(true)
    }
  })

  test('covers representative provider keys declared across the registry', () => {
    const known = new Set(getKnownProviderSecretEnvKeys())
    const representative = [
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'OPENGATEWAY_API_KEY',
      'OPENROUTER_API_KEY',
      'FIREWORKS_API_KEY',
      'GROQ_API_KEY',
      'MIMO_API_KEY',
      'OPENCODE_API_KEY',
      'NEARAI_API_KEY',
      'DEEPSEEK_API_KEY',
      'DASHSCOPE_API_KEY',
    ]
    const missing = representative.filter((key) => !known.has(key))
    expect(missing, `representative provider keys missing from redaction set: ${missing.join(', ')}`).toEqual([])
  })

  test('does not statically import the heavy descriptor artifacts at module load', async () => {
    // Regression guard: providerSecrets sits on the bootstrap startup path
    // (bootstrap -> providerConfig -> providerProfile -> providerSecrets), so a
    // static import of integrationArtifacts.generated would eagerly evaluate the
    // whole descriptor graph and undo the lazy-loading win. The descriptor
    // arrays must instead be pulled in via a lazy require inside the function.
    const source = await Bun.file(
      new URL('./providerSecrets.ts', import.meta.url),
    ).text()
    // Strip comments so a benign mention of the module in a comment can neither
    // satisfy nor trip these assertions, and match imports regardless of
    // indentation/aliasing rather than only at column 0.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    expect(code).not.toMatch(/\bimport\b[\s\S]*?\bfrom\b\s*['"][^'"]*integrationArtifacts\.generated/)
    expect(code).toMatch(/\brequire\(\s*['"][^'"]*integrationArtifacts\.generated/)
  })
})

describe('sanitizeApiKey', () => {
  test('drops empty and credential placeholders', () => {
    expect(sanitizeApiKey(undefined)).toBeUndefined()
    expect(sanitizeApiKey('')).toBeUndefined()
    expect(sanitizeApiKey('SUA_CHAVE')).toBeUndefined()
    expect(sanitizeApiKey('sua_chave')).toBeUndefined()
    expect(sanitizeApiKey('null')).toBeUndefined()
    expect(sanitizeApiKey('undefined')).toBeUndefined()
    expect(sanitizeApiKey(' NULL ')).toBeUndefined()
  })

  test('returns real keys unchanged', () => {
    expect(sanitizeApiKey(FAKE_OPENAI_KEY)).toBe(FAKE_OPENAI_KEY)
  })
})

describe('maskSecretForDisplay', () => {
  test('returns undefined for empty values', () => {
    expect(maskSecretForDisplay(undefined)).toBeUndefined()
    expect(maskSecretForDisplay('')).toBeUndefined()
  })

  test('masks short secrets as configured', () => {
    expect(maskSecretForDisplay('short')).toBe('configured')
  })

  test('masks long secrets with first/last three chars', () => {
    expect(maskSecretForDisplay(FAKE_OPENAI_KEY)).toBe('sk-...def')
  })
})

describe('redactSecretValueForDisplay', () => {
  test('masks values that equal a configured provider secret', () => {
    const sources = [{ OPENAI_API_KEY: FAKE_OPENAI_KEY }]
    expect(redactSecretValueForDisplay(FAKE_OPENAI_KEY, ...sources)).toBe('sk-...def')
  })

  test('masks secret-shaped values even when the env var is unknown', () => {
    expect(redactSecretValueForDisplay('sk-unknown-but-secret-shaped-1234567890')).toBe('sk-...890')
    expect(redactSecretValueForDisplay('sk-ant-fakeAnthropicToken-1234567890')).toBe('sk-...890')
    expect(redactSecretValueForDisplay('AIzaSyFAKEGEMINIkey1234567890abcdefghijklmnopqr')).toBe('AIz...pqr')
    expect(redactSecretValueForDisplay(FAKE_GITHUB_PAT)).toBe('ghp...hij')
    expect(redactSecretValueForDisplay(FAKE_GITHUB_USER_TOKEN)).toBe('ghu...234')
    expect(redactSecretValueForDisplay(FAKE_LONG_OPAQUE)).toBe('liv...def')
    expect(redactSecretValueForDisplay(FAKE_JWT_TOKEN)).toBe('eyJ...w5c')
  })

  test('keeps non-secret values visible', () => {
    expect(redactSecretValueForDisplay('gpt-4o', { OPENAI_API_KEY: FAKE_OPENAI_KEY })).toBe('gpt-4o')
    expect(redactSecretValueForDisplay('https://api.openai.com/v1')).toBe('https://api.openai.com/v1')
    expect(redactSecretValueForDisplay('claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
    expect(redactSecretValueForDisplay('claude-sonnet-4-6-preview')).toBe('claude-sonnet-4-6-preview')
    expect(redactSecretValueForDisplay('qwen3-coder-480b-a35b-instruct')).toBe('qwen3-coder-480b-a35b-instruct')
    expect(redactSecretValueForDisplay('Qwen3-Coder-480B-A35B-Instruct')).toBe('Qwen3-Coder-480B-A35B-Instruct')
  })

  test('returns undefined for empty input', () => {
    expect(redactSecretValueForDisplay(undefined)).toBeUndefined()
    expect(redactSecretValueForDisplay('')).toBeUndefined()
    expect(redactSecretValueForDisplay('   ')).toBe('   ')
  })

  test('redacts values supplied via any provider key, not just the original 8', () => {
    const sources = [
      {
        OPENGATEWAY_API_KEY: FAKE_OPENAI_KEY,
        OPENROUTER_API_KEY: FAKE_GITHUB_PAT,
        GROQ_API_KEY: FAKE_GEMINI_KEY,
      },
    ]
    expect(redactSecretValueForDisplay(FAKE_OPENAI_KEY, ...sources)).toBe('sk-...def')
    expect(redactSecretValueForDisplay(FAKE_GITHUB_PAT, ...sources)).toBe('ghp...hij')
    expect(redactSecretValueForDisplay(FAKE_GEMINI_KEY, ...sources)).toBe('AIz...pqr')
  })

  test('redacts accepted access-token credential values outside setup descriptors', () => {
    const token = 'gemini-access-token'
    expect(redactSecretValueForDisplay(token, { GEMINI_ACCESS_TOKEN: token })).toBe('gem...ken')
  })

  test('redacts individual members of pooled OpenAI credentials', () => {
    const pool = 'lowercasecredentialaaaaaaaaaaaa,lowercasecredentialbbbbbbbbbbbb'
    expect(
      redactSecretValueForDisplay('lowercasecredentialaaaaaaaaaaaa', {
        OPENAI_API_KEYS: pool,
      }),
    ).toBe('low...aaa')
    expect(
      sanitizeProviderConfigValue('lowercasecredentialbbbbbbbbbbbb', {
        OPENAI_API_KEYS: pool,
      }),
    ).toBeUndefined()
  })
  test('redacts configured provider secrets after trimming source env values', () => {
    const providerSecret = 'ogw-provider-secret'
    expect(
      redactSecretValueForDisplay(providerSecret, {
        OPENGATEWAY_API_KEY: ` ${providerSecret} `,
      }),
    ).toBe('ogw...ret')
  })
})

describe('redactSecretSubstringsForDisplay', () => {
  test('redacts configured provider secrets embedded in longer messages', () => {
    const message = `Provider rejected API key ${FAKE_OPENAI_KEY} for this request`

    const redacted = redactSecretSubstringsForDisplay(message, {
      OPENAI_API_KEY: FAKE_OPENAI_KEY,
    })

    expect(redacted).toBe('Provider rejected API key sk-...def for this request')
    expect(redacted).not.toContain(FAKE_OPENAI_KEY)
  })

  test('redacts secret-shaped values embedded in longer messages', () => {
    const leakedKey = 'sk-liveLeakToken1234567890ABCdef'

    const redacted = redactSecretSubstringsForDisplay(
      `Invalid API key: ${leakedKey}; GitHub token: ${FAKE_GITHUB_USER_TOKEN}`,
    )

    expect(redacted).toBe('Invalid API key: sk-...def; GitHub token: ghu...234')
    expect(redacted).not.toContain(leakedKey)
    expect(redacted).not.toContain(FAKE_GITHUB_USER_TOKEN)
  })

  test('redacts JWT-shaped values embedded in longer messages', () => {
    const redacted = redactSecretSubstringsForDisplay(
      `Authentication failed: ${FAKE_JWT_TOKEN} is invalid`,
    )

    expect(redacted).toBe('Authentication failed: eyJ...w5c is invalid')
    expect(redacted).not.toContain(FAKE_JWT_TOKEN)
  })
})

describe('sanitizeProviderConfigValue', () => {
  test('returns undefined for empty input', () => {
    expect(sanitizeProviderConfigValue(undefined)).toBeUndefined()
    expect(sanitizeProviderConfigValue('')).toBeUndefined()
  })

  test('returns undefined for known secret values', () => {
    expect(
      sanitizeProviderConfigValue(FAKE_OPENAI_KEY, { OPENAI_API_KEY: FAKE_OPENAI_KEY }),
    ).toBeUndefined()
  })

  test('returns undefined for known secret values after trimming source env values', () => {
    const providerSecret = 'ogw-provider-secret'
    expect(
      sanitizeProviderConfigValue(providerSecret, {
        OPENGATEWAY_API_KEY: ` ${providerSecret} `,
      }),
    ).toBeUndefined()
  })

  test('returns undefined for secret-shaped raw values', () => {
    expect(sanitizeProviderConfigValue('sk-looks-like-a-key-1234567890')).toBeUndefined()
    expect(sanitizeProviderConfigValue('sk-ant-looks-like-a-key-1234567890')).toBeUndefined()
    expect(sanitizeProviderConfigValue('AIzaSySomeGeminiKey1234567890abcdefghijklmnopqr')).toBeUndefined()
    expect(sanitizeProviderConfigValue(FAKE_GITHUB_PAT)).toBeUndefined()
    expect(sanitizeProviderConfigValue(FAKE_GITHUB_USER_TOKEN)).toBeUndefined()
    expect(sanitizeProviderConfigValue(FAKE_JWT_TOKEN)).toBeUndefined()
  })

  test('keeps non-secret config values visible', () => {
    expect(sanitizeProviderConfigValue('gpt-4o', { OPENAI_API_KEY: FAKE_OPENAI_KEY })).toBe('gpt-4o')
    expect(sanitizeProviderConfigValue('https://api.openai.com/v1')).toBe('https://api.openai.com/v1')
    expect(sanitizeProviderConfigValue('Qwen3-Coder-480B-A35B-Instruct')).toBe('Qwen3-Coder-480B-A35B-Instruct')
  })
})
