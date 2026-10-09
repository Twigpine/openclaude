import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { afterEach, beforeEach } from 'node:test'

import { acquireEnvMutex, releaseEnvMutex } from '../entrypoints/sdk/shared.js'
import {
  resolveActiveRouteIdFromEnv,
  resolveRouteCredentialValue,
} from '../integrations/routeMetadata.js'
import { DEFAULT_CODEX_BASE_URL } from '../services/api/providerConfig.js'
import { getProviderValidationError } from './providerValidation.js'
import {
  applySavedProfileToCurrentSession,
  applyStartupEnvFromProfile,
  buildStartupEnvFromProfile,
  buildAtomicChatProfileEnv,
  buildApismartProfileEnv,
  buildCompatibilityProcessEnv,
  buildConcentrateProfileEnv,
  buildCodexProfileEnv,
  buildGeminiProfileEnv,
  buildLaunchEnv,
  buildOllamaProfileEnv,
  buildOpenAIProfileEnv,
  clearPersistedCodexOAuthProfile,
  createProfileFile,
  DEFAULT_STARTUP_PROVIDER_ENV_VAR,
  deleteProfileFile,
  getDefaultProfileFilePath,
  isDefaultStartupProviderEnv,
  isPersistedCodexOAuthProfile,
  maskSecretForDisplay,
  loadProfileFile,
  PROFILE_FILE_NAME,
  redactSecretValueForDisplay,
  saveProfileFile,
  sanitizeProviderConfigValue,
  hasInvalidOpenAICredentialPool,
  selectAutoProfile,
  type ProfileFile,
} from './providerProfile.js'

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }))
    .toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

function profile(profile: ProfileFile['profile'], env: ProfileFile['env']): ProfileFile {
  return {
    profile,
    env,
    createdAt: '2026-04-01T00:00:00.000Z',
  }
}

async function importFreshProviderProfileModule() {
  const nonce = `${Date.now()}-${Math.random()}`
  return import(`./providerProfile.js?ts=${nonce}`)
}

const missingCodexAuthPath = join(tmpdir(), 'openclaude-missing-codex-auth.json')

beforeEach(async () => {
  await acquireEnvMutex()
})

afterEach(() => {
  releaseEnvMutex()
})

test('matching persisted ollama env is reused for ollama launch', async () => {
  const env = await buildLaunchEnv({
    profile: 'ollama',
    persisted: profile('ollama', {
      OPENAI_BASE_URL: 'http://127.0.0.1:11435/v1',
      OPENAI_MODEL: 'mistral:7b-instruct',
    }),
    goal: 'balanced',
    processEnv: {},
    getOllamaChatBaseUrl: () => 'http://localhost:11434/v1',
    resolveOllamaDefaultModel: async () => 'llama3.1:8b',
  })

  assert.equal(env.OPENAI_BASE_URL, 'http://127.0.0.1:11435/v1')
  assert.equal(env.OPENAI_MODEL, 'mistral:7b-instruct')
  assert.equal(env.CLAUDE_CODE_PROVIDER_ROUTE_ID, 'ollama')
})

test('ollama launch ignores mismatched persisted openai env and shell model fallback', async () => {
  const env = await buildLaunchEnv({
    profile: 'ollama',
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_API_KEY: 'sk-persisted',
    }),
    goal: 'coding',
    processEnv: {
      OPENAI_BASE_URL: 'https://api.deepseek.com/v1',
      OPENAI_MODEL: 'gpt-4o-mini',
      OPENAI_API_KEY: 'sk-live',
      CODEX_API_KEY: 'codex-live',
      CHATGPT_ACCOUNT_ID: 'acct_live',
    },
    getOllamaChatBaseUrl: () => 'http://localhost:11434/v1',
    resolveOllamaDefaultModel: async () => 'qwen2.5-coder:7b',
  })

  assert.equal(env.OPENAI_BASE_URL, 'http://localhost:11434/v1')
  assert.equal(env.OPENAI_MODEL, 'qwen2.5-coder:7b')
  assert.equal(env.CLAUDE_CODE_PROVIDER_ROUTE_ID, 'ollama')
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.CODEX_API_KEY, undefined)
  assert.equal(env.CHATGPT_ACCOUNT_ID, undefined)
})

test('openai launch ignores mismatched persisted ollama env', async () => {
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('ollama', {
      OPENAI_BASE_URL: 'http://localhost:11434/v1',
      OPENAI_MODEL: 'llama3.1:8b',
    }),
    goal: 'latency',
    processEnv: {
      OPENAI_API_KEY: 'sk-live',
      CODEX_API_KEY: 'codex-live',
      CHATGPT_ACCOUNT_ID: 'acct_live',
    },
    getOllamaChatBaseUrl: () => 'http://localhost:11434/v1',
    resolveOllamaDefaultModel: async () => 'llama3.1:8b',
  })

  assert.equal(env.OPENAI_BASE_URL, 'https://api.openai.com/v1')
  assert.equal(env.OPENAI_MODEL, 'gpt-4o-mini')
  assert.equal(env.OPENAI_API_KEY, 'sk-live')
  assert.equal(env.CODEX_API_KEY, undefined)
  assert.equal(env.CHATGPT_ACCOUNT_ID, undefined)
})

test('openai profile switch clears stale plural credential pool before applying saved key', () => {
  const env = buildCompatibilityProcessEnv({
    compatibilityMode: 'openai',
    profileEnv: {
      OPENAI_API_KEY: 'profile-key',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_MODEL: 'gpt-5.4',
    },
    processEnv: {
      OPENAI_API_KEYS: 'stale-a,stale-b',
      OPENAI_API_KEY: 'shell-key',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_MODEL: 'gpt-4o',
    },
  })

  assert.equal(env.OPENAI_API_KEYS, undefined)
  assert.equal(env.OPENAI_API_KEY, 'profile-key')
  assert.equal(
    resolveRouteCredentialValue({
      routeId: 'openai',
      processEnv: env,
    }),
    'profile-key',
  )
})

test('anthropic launch preserves unmanaged process env values', async () => {
  const env = await buildLaunchEnv({
    profile: 'anthropic',
    persisted: profile('anthropic', {
      ANTHROPIC_MODEL: 'claude-sonnet-4-6',
      ANTHROPIC_API_KEY: 'sk-ant-persisted',
    }),
    goal: 'balanced',
    processEnv: {
      PATH: '/usr/local/bin:/usr/bin',
      HOME: '/Users/example',
      OPENAI_MODEL: 'gpt-4o',
    },
  })

  assert.equal(env.PATH, '/usr/local/bin:/usr/bin')
  assert.equal(env.HOME, '/Users/example')
  assert.equal(env.ANTHROPIC_MODEL, 'claude-sonnet-4-6')
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-persisted')
  assert.equal(env.OPENAI_MODEL, undefined)
})

test('openai launch omits api key when no key is resolved', async () => {
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_MODEL: 'gpt-4o',
    }),
    goal: 'balanced',
    processEnv: {
      OPENAI_API_KEY: undefined as any,
    },
  })

  assert.equal(env.OPENAI_BASE_URL, 'https://api.openai.com/v1')
  assert.equal(env.OPENAI_MODEL, 'gpt-4o')
  assert.equal(Object.hasOwn(env, 'OPENAI_API_KEY'), false)
})

test('github-enterprise launch does not derive Enterprise URL from public Copilot default', async () => {
  const env = await buildLaunchEnv({
    profile: 'github-enterprise',
    persisted: profile('github-enterprise', {
      OPENAI_BASE_URL: 'https://api.githubcopilot.com',
      OPENAI_MODEL: 'github:copilot:gpt-5.3-codex',
    }),
    goal: 'coding',
    processEnv: {},
  })

  assert.equal(env.CLAUDE_CODE_USE_GITHUB, '1')
  assert.equal(env.OPENAI_BASE_URL, 'https://api.githubcopilot.com')
  assert.equal(env.GITHUB_ENTERPRISE_URL, undefined)
})

test('github-enterprise launch preserves persisted direct Copilot key', async () => {
  const env = await buildLaunchEnv({
    profile: 'github-enterprise',
    persisted: profile('github-enterprise', {
      OPENAI_BASE_URL: 'https://github.mycompany.com/api/copilot',
      OPENAI_MODEL: 'github:copilot:gpt-5.3-codex',
      GITHUB_COPILOT_KEY: 'enterprise-profile-key',
    }),
    goal: 'coding',
    processEnv: {},
  })

  assert.equal(env.CLAUDE_CODE_USE_GITHUB, '1')
  assert.equal(env.GITHUB_ENTERPRISE_URL, 'https://github.mycompany.com')
  assert.equal(env.GITHUB_COPILOT_KEY, 'enterprise-profile-key')
})

test('openai launch preserves persisted dedicated vendor credentials across restart', async () => {
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://api.atlascloud.ai/v1',
      OPENAI_MODEL: 'deepseek-ai/deepseek-v4-pro',
      OPENAI_API_KEY: 'atlas-secret-key',
      ATLAS_CLOUD_API_KEY: 'atlas-secret-key',
    }),
    goal: 'coding',
    processEnv: {},
  })

  assert.equal(env.OPENAI_BASE_URL, 'https://api.atlascloud.ai/v1')
  assert.equal(env.OPENAI_MODEL, 'deepseek-ai/deepseek-v4-pro')
  assert.equal(env.OPENAI_API_KEY, 'atlas-secret-key')
  assert.equal(env.ATLAS_CLOUD_API_KEY, 'atlas-secret-key')
})

test('openai launch preserves persisted ApiSmart dedicated credentials across restart', async () => {
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://gw.apismart.ai/v1',
      OPENAI_MODEL: 'DEEPSEEK_V4_FLASH',
      OPENAI_API_KEY: 'apismart-secret-key',
      APISMART_API_KEY: 'apismart-secret-key',
    }),
    goal: 'coding',
    processEnv: {},
  })

  assert.equal(env.OPENAI_BASE_URL, 'https://gw.apismart.ai/v1')
  assert.equal(env.OPENAI_MODEL, 'DEEPSEEK_V4_FLASH')
  assert.equal(env.OPENAI_API_KEY, 'apismart-secret-key')
  assert.equal(env.APISMART_API_KEY, 'apismart-secret-key')
  assert.equal(env.CLAUDE_CODE_PROVIDER_ROUTE_ID, 'apismart')
})

test('openai launch prefers dedicated ApiSmart credentials over a legacy generic mirror', async () => {
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://gw.apismart.ai/v1',
      OPENAI_MODEL: 'DEEPSEEK_V4_FLASH',
      OPENAI_API_KEY: 'legacy-generic-key',
      APISMART_API_KEY: 'dedicated-key',
    }),
    goal: 'balanced',
    processEnv: {},
  })

  assert.equal(env.APISMART_API_KEY, 'dedicated-key')
})

test('openai launch backfills APISMART_API_KEY from a legacy OpenAI-shaped ApiSmart profile', async () => {
  // Pre-dedicated-key persisted envs only stored OPENAI_API_KEY. ApiSmart is
  // dedicatedCredentialsOnly, so relaunch must recover APISMART_API_KEY from
  // that mirrored value or the shim authenticates with nothing.
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://gw.apismart.ai/v1',
      OPENAI_MODEL: 'DEEPSEEK_V4_FLASH',
      OPENAI_API_KEY: 'apismart-secret-key',
    }),
    goal: 'coding',
    processEnv: {},
  })

  assert.equal(env.CLAUDE_CODE_PROVIDER_ROUTE_ID, 'apismart')
  assert.equal(env.OPENAI_API_KEY, 'apismart-secret-key')
  assert.equal(env.APISMART_API_KEY, 'apismart-secret-key')
  assert.equal(
    resolveRouteCredentialValue({
      routeId: 'apismart',
      processEnv: env,
      baseUrl: env.OPENAI_BASE_URL,
    }),
    'apismart-secret-key',
  )
})

test('openai launch never promotes an ambient generic key to an ApiSmart credential', async () => {
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://gw.apismart.ai/v1',
      OPENAI_MODEL: 'DEEPSEEK_V4_FLASH',
      CLAUDE_CODE_PROVIDER_ROUTE_ID: 'apismart',
    }),
    goal: 'coding',
    processEnv: {
      OPENAI_API_KEY: 'generic-openai-key',
    },
  })

  assert.equal(env.APISMART_API_KEY, undefined)
  assert.equal(
    resolveRouteCredentialValue({
      routeId: 'apismart',
      processEnv: env,
      baseUrl: env.OPENAI_BASE_URL,
    }),
    undefined,
  )
})

test('buildApismartProfileEnv prefers APISMART_MODEL over OPENAI_MODEL', () => {
  const env = buildApismartProfileEnv({
    apiKey: 'apismart-secret-key',
    processEnv: {
      APISMART_MODEL: 'KIMI_K3',
      OPENAI_MODEL: 'GLM_5.2',
    },
  })

  assert.ok(env)
  assert.equal(env?.OPENAI_MODEL, 'KIMI_K3')
  assert.equal(env?.CLAUDE_CODE_PROVIDER_ROUTE_ID, 'apismart')
})

test('buildApismartProfileEnv refuses to copy the dedicated credential to a custom endpoint', () => {
  const env = buildApismartProfileEnv({
    apiKey: 'apismart-secret-key',
    baseUrl: 'https://proxy.example/v1',
  })

  assert.equal(env, null)
})

test('buildApismartProfileEnv refuses non-canonical ApiSmart paths', () => {
  assert.equal(
    buildApismartProfileEnv({
      apiKey: 'apismart-secret-key',
      baseUrl: 'https://gw.apismart.ai/staging/v1',
    }),
    null,
  )
  assert.equal(
    buildApismartProfileEnv({
      apiKey: 'apismart-secret-key',
      baseUrl: 'https://gw.apismart.ai',
    }),
    null,
  )
})

test('openai launch withholds ambient ApiSmart credentials from a keyless proxy profile on restart', async () => {
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      CLAUDE_CODE_PROVIDER_ROUTE_ID: 'apismart',
      OPENAI_BASE_URL: 'https://proxy.example.com/v1',
      OPENAI_MODEL: 'DEEPSEEK_V4_FLASH',
    }),
    goal: 'coding',
    processEnv: {
      OPENAI_BASE_URL: 'https://proxy.example.com/v1',
      OPENAI_API_KEY: 'ambient-apismart-key',
      APISMART_API_KEY: 'ambient-apismart-key',
    },
  })

  assert.equal(env.CLAUDE_CODE_PROVIDER_ROUTE_ID, 'apismart')
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.APISMART_API_KEY, undefined)

  const canonical = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      CLAUDE_CODE_PROVIDER_ROUTE_ID: 'apismart',
      OPENAI_BASE_URL: 'https://gw.apismart.ai/v1',
      OPENAI_MODEL: 'DEEPSEEK_V4_FLASH',
    }),
    goal: 'coding',
    processEnv: {
      OPENAI_BASE_URL: 'https://gw.apismart.ai/v1',
      OPENAI_API_KEY: 'ambient-apismart-key',
      APISMART_API_KEY: 'ambient-apismart-key',
    },
  })
  assert.equal(canonical.OPENAI_API_KEY, 'ambient-apismart-key')
  assert.equal(canonical.APISMART_API_KEY, 'ambient-apismart-key')
})

test('openai launch carries APISMART_API_KEY only when the route resolves to apismart', async () => {
  const offRoute = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-openai',
      APISMART_API_KEY: 'apismart-persisted',
    }),
    goal: 'coding',
    processEnv: {
      APISMART_API_KEY: 'apismart-ambient',
    },
  })

  assert.equal(offRoute.APISMART_API_KEY, undefined)

  const onRoute = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://gw.apismart.ai/v1',
      OPENAI_MODEL: 'DEEPSEEK_V4_FLASH',
      OPENAI_API_KEY: 'apismart-key',
      APISMART_API_KEY: 'apismart-key',
    }),
    goal: 'coding',
    processEnv: {},
  })

  assert.equal(onRoute.APISMART_API_KEY, 'apismart-key')
})

test('openai launch prefers a live dedicated vendor key over the persisted one', async () => {
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://api.atlascloud.ai/v1',
      OPENAI_MODEL: 'deepseek-ai/deepseek-v4-pro',
      OPENAI_API_KEY: 'atlas-old-key',
      ATLAS_CLOUD_API_KEY: 'atlas-old-key',
    }),
    goal: 'coding',
    processEnv: {
      ATLAS_CLOUD_API_KEY: 'atlas-rotated-key',
    },
  })

  assert.equal(env.ATLAS_CLOUD_API_KEY, 'atlas-rotated-key')
})

test('openai launch carries AIMLAPI_API_KEY only when the route resolves to aimlapi', async () => {
  // Ambient/persisted AIMLAPI_API_KEY must not leak into an unrelated OpenAI
  // route — AI/ML API authenticates via OPENAI_API_KEY there.
  const offRoute = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-openai',
      AIMLAPI_API_KEY: 'aimlapi-persisted',
    }),
    goal: 'coding',
    processEnv: {
      AIMLAPI_API_KEY: 'aimlapi-ambient',
    },
  })

  assert.equal(offRoute.AIMLAPI_API_KEY, undefined)

  // On the aimlapi route the dedicated key is carried like other providers.
  const onRoute = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://api.aimlapi.com/v1',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_API_KEY: 'aimlapi-key',
      AIMLAPI_API_KEY: 'aimlapi-key',
    }),
    goal: 'coding',
    processEnv: {},
  })

  assert.equal(onRoute.AIMLAPI_API_KEY, 'aimlapi-key')
})

test('openai launch carries LONGCAT_API_KEY only when the route resolves to LongCat', async () => {
  const offRoute = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-openai',
      LONGCAT_API_KEY: 'longcat-persisted',
    }),
    goal: 'coding',
    processEnv: { LONGCAT_API_KEY: 'longcat-ambient' },
  })

  assert.equal(offRoute.LONGCAT_API_KEY, undefined)

  const onRoute = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://api.longcat.chat/openai/v1',
      OPENAI_API_KEY: 'longcat-key',
      LONGCAT_API_KEY: 'longcat-key',
    }),
    goal: 'coding',
    processEnv: {},
  })

  assert.equal(onRoute.LONGCAT_API_KEY, 'longcat-key')
})

test('openai launch mirrors rotated OPENAI_API_KEY into AIMLAPI_API_KEY on aimlapi route', async () => {
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://api.aimlapi.com/v1',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_API_KEY: 'old-openai-key',
      AIMLAPI_API_KEY: 'old-aimlapi-key',
    }),
    goal: 'coding',
    processEnv: {
      OPENAI_API_KEY: 'rotated-openai-key',
    },
  })

  assert.equal(env.OPENAI_API_KEY, 'rotated-openai-key')
  assert.equal(env.AIMLAPI_API_KEY, 'rotated-openai-key')
})

test('openai launch lets live base URL override persisted AIMLAPI route marker', async () => {
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      CLAUDE_CODE_PROVIDER_ROUTE_ID: 'aimlapi',
      OPENAI_BASE_URL: 'https://proxy.example.com/v1',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_API_KEY: 'persisted-aimlapi-key',
      AIMLAPI_API_KEY: 'persisted-aimlapi-key',
    }),
    goal: 'coding',
    processEnv: {
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'live-openai-key',
      AIMLAPI_API_KEY: 'ambient-aimlapi-key',
    },
  })

  assert.equal(env.OPENAI_BASE_URL, 'https://api.openai.com/v1')
  assert.equal(env.OPENAI_API_KEY, 'live-openai-key')
  assert.equal(env.AIMLAPI_API_KEY, undefined)
  // The stale aimlapi route marker must be cleared entirely, not just
  // swapped to a different route value.
  assert.equal(env.CLAUDE_CODE_PROVIDER_ROUTE_ID, undefined)
})

test('openai launch withholds the ambient AIMLAPI key from a keyless proxy profile on restart', async () => {
  // A keyless saved aimlapi profile that points at a user-controlled proxy keeps
  // its route id after relaunch, but the canonical AIMLAPI credential must never
  // be copied into that proxy session.
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      CLAUDE_CODE_PROVIDER_ROUTE_ID: 'aimlapi',
      OPENAI_BASE_URL: 'https://proxy.example.com/v1',
      OPENAI_MODEL: 'gpt-4o',
    }),
    goal: 'coding',
    processEnv: {
      OPENAI_BASE_URL: 'https://proxy.example.com/v1',
      AIMLAPI_API_KEY: 'ambient-aimlapi-key',
    },
  })

  // Still recognized as the aimlapi route...
  assert.equal(env.CLAUDE_CODE_PROVIDER_ROUTE_ID, 'aimlapi')
  // ...but the ambient canonical credential is withheld from the proxy host.
  assert.equal(env.AIMLAPI_API_KEY, undefined)

  // The same profile on the canonical host DOES receive the ambient key.
  const canonical = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      CLAUDE_CODE_PROVIDER_ROUTE_ID: 'aimlapi',
      OPENAI_BASE_URL: 'https://api.aimlapi.com/v1',
      OPENAI_MODEL: 'gpt-4o',
    }),
    goal: 'coding',
    processEnv: {
      OPENAI_BASE_URL: 'https://api.aimlapi.com/v1',
      AIMLAPI_API_KEY: 'ambient-aimlapi-key',
    },
  })
  assert.equal(canonical.AIMLAPI_API_KEY, 'ambient-aimlapi-key')
})

test('openai launch withholds the ambient generic OpenAI credential from a keyless proxy aimlapi profile', async () => {
  // The generic OPENAI_API_KEY / OPENAI_API_KEYS alias is the same exfiltration
  // path: a keyless retained aimlapi profile on a proxy must not receive the
  // ambient canonical credential in either form.
  for (const ambient of [
    { OPENAI_API_KEY: 'ambient-openai-key' },
    { OPENAI_API_KEYS: 'ambient-key-a,ambient-key-b' },
  ]) {
    const env = await buildLaunchEnv({
      profile: 'openai',
      persisted: profile('openai', {
        CLAUDE_CODE_PROVIDER_ROUTE_ID: 'aimlapi',
        OPENAI_BASE_URL: 'https://proxy.example.com/v1',
        OPENAI_MODEL: 'gpt-4o',
      }),
      goal: 'coding',
      processEnv: {
        OPENAI_BASE_URL: 'https://proxy.example.com/v1',
        ...ambient,
      },
    })
    assert.equal(env.CLAUDE_CODE_PROVIDER_ROUTE_ID, 'aimlapi')
    assert.equal(env.OPENAI_API_KEY, undefined)
    assert.equal(env.OPENAI_API_KEYS, undefined)
  }

  // The same ambient credential IS applied on the canonical host.
  const canonical = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      CLAUDE_CODE_PROVIDER_ROUTE_ID: 'aimlapi',
      OPENAI_BASE_URL: 'https://api.aimlapi.com/v1',
      OPENAI_MODEL: 'gpt-4o',
    }),
    goal: 'coding',
    processEnv: {
      OPENAI_BASE_URL: 'https://api.aimlapi.com/v1',
      OPENAI_API_KEY: 'ambient-openai-key',
    },
  })
  assert.equal(canonical.OPENAI_API_KEY, 'ambient-openai-key')
})

test('openai launch keeps a keyed proxy aimlapi profile own OpenAI credential', async () => {
  // A proxy profile that carries its own key still authenticates with it; only
  // the ambient credential is dropped, not the user-configured one.
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      CLAUDE_CODE_PROVIDER_ROUTE_ID: 'aimlapi',
      OPENAI_BASE_URL: 'https://proxy.example.com/v1',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_API_KEY: 'profile-own-key',
    }),
    goal: 'coding',
    processEnv: {
      OPENAI_BASE_URL: 'https://proxy.example.com/v1',
      OPENAI_API_KEY: 'ambient-openai-key',
    },
  })
  assert.equal(env.OPENAI_API_KEY, 'profile-own-key')
})

test('openai launch keeps the proxy aimlapi guard across equivalent base URL spellings', async () => {
  // The saved route identity is retained on a normalized comparison, so a shell
  // base URL that differs only by a trailing slash (or host casing) still names
  // the same proxy. A literal comparison would drop the route id here and let
  // the ambient canonical credential through.
  for (const shellBaseUrl of [
    'https://proxy.example.com/v1/',
    'https://PROXY.example.com/v1',
  ]) {
    const env = await buildLaunchEnv({
      profile: 'openai',
      persisted: profile('openai', {
        CLAUDE_CODE_PROVIDER_ROUTE_ID: 'aimlapi',
        OPENAI_BASE_URL: 'https://proxy.example.com/v1',
        OPENAI_MODEL: 'gpt-4o',
      }),
      goal: 'coding',
      processEnv: {
        OPENAI_BASE_URL: shellBaseUrl,
        OPENAI_API_KEY: 'ambient-openai-key',
        AIMLAPI_API_KEY: 'ambient-aimlapi-key',
      },
    })

    assert.equal(env.CLAUDE_CODE_PROVIDER_ROUTE_ID, 'aimlapi')
    assert.equal(env.OPENAI_API_KEY, undefined)
    assert.equal(env.AIMLAPI_API_KEY, undefined)
  }
})

test('openai launch does not let a distinct proxy target inherit the saved aimlapi identity', async () => {
  // Path case and query parameters name a distinct target on the same host. The
  // saved identity must NOT carry over to it, because that identity is what
  // mirrors the profile's dedicated AIMLAPI_API_KEY — a key configured for the
  // original tenant, not this one.
  for (const [persistedBaseUrl, shellBaseUrl] of [
    ['https://proxy.example.com/tenantA/v1', 'https://proxy.example.com/tenanta/v1'],
    ['https://proxy.example.com/v1', 'https://proxy.example.com/v1?tenant=other'],
  ]) {
    const env = await buildLaunchEnv({
      profile: 'openai',
      persisted: profile('openai', {
        CLAUDE_CODE_PROVIDER_ROUTE_ID: 'aimlapi',
        OPENAI_BASE_URL: persistedBaseUrl,
        OPENAI_MODEL: 'gpt-4o',
        OPENAI_API_KEY: 'profile-own-tenant-key',
        AIMLAPI_API_KEY: 'profile-own-tenant-key',
        OPENAI_AUTH_HEADER: 'X-Profile-Auth',
        OPENAI_AUTH_HEADER_VALUE: 'profile-own-tenant-secret',
      }),
      goal: 'coding',
      processEnv: {
        OPENAI_BASE_URL: shellBaseUrl,
        OPENAI_API_KEY: 'user-supplied-key',
        OPENAI_AUTH_HEADER_VALUE: 'user-supplied-secret',
      },
    })

    assert.equal(env.CLAUDE_CODE_PROVIDER_ROUTE_ID, undefined)
    // The dedicated aimlapi credential rides on the route identity, so a target
    // that cannot inherit the identity never receives it.
    assert.equal(env.AIMLAPI_API_KEY, undefined)
    // Without that identity the launch falls back to the route-agnostic
    // precedence: the credential the user supplied for THIS endpoint wins. The
    // profile's own key must not be forced in over it — that would both hand a
    // key to an endpoint it was never configured for and discard the user's.
    assert.equal(env.OPENAI_API_KEY, 'user-supplied-key')
    assert.equal(env.OPENAI_AUTH_HEADER_VALUE, 'user-supplied-secret')
  }
})

test('openai launch withholds ambient custom headers from a keyless proxy aimlapi profile', async () => {
  // ANTHROPIC_CUSTOM_HEADERS reaches the proxy: client.ts merges it into the
  // defaultHeaders passed to the OpenAI shim client, and its filter only drops
  // the three standard auth header names — a custom-named secret rides through.
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      CLAUDE_CODE_PROVIDER_ROUTE_ID: 'aimlapi',
      OPENAI_BASE_URL: 'https://proxy.example.com/v1',
      OPENAI_MODEL: 'gpt-4o',
    }),
    goal: 'coding',
    processEnv: {
      OPENAI_BASE_URL: 'https://proxy.example.com/v1',
      ANTHROPIC_CUSTOM_HEADERS: 'X-Proxy-Auth: ambient-canonical-secret',
    },
  })

  assert.equal(env.CLAUDE_CODE_PROVIDER_ROUTE_ID, 'aimlapi')
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, undefined)

  // Headers the profile itself persisted are the user's own configuration for
  // that proxy, so they survive — and an ambient value cannot override them.
  const owned = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      CLAUDE_CODE_PROVIDER_ROUTE_ID: 'aimlapi',
      OPENAI_BASE_URL: 'https://proxy.example.com/v1',
      OPENAI_MODEL: 'gpt-4o',
      ANTHROPIC_CUSTOM_HEADERS: 'X-Proxy-Auth: profile-own-proxy-secret',
    }),
    goal: 'coding',
    processEnv: {
      OPENAI_BASE_URL: 'https://proxy.example.com/v1',
      ANTHROPIC_CUSTOM_HEADERS: 'X-Proxy-Auth: ambient-canonical-secret',
    },
  })
  assert.equal(
    owned.ANTHROPIC_CUSTOM_HEADERS,
    'X-Proxy-Auth: profile-own-proxy-secret',
  )

  // On the canonical endpoint the ambient value keeps its existing behaviour.
  const canonical = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      CLAUDE_CODE_PROVIDER_ROUTE_ID: 'aimlapi',
      OPENAI_BASE_URL: 'https://api.aimlapi.com/v1',
      OPENAI_MODEL: 'gpt-4o',
    }),
    goal: 'coding',
    processEnv: {
      OPENAI_BASE_URL: 'https://api.aimlapi.com/v1',
      ANTHROPIC_CUSTOM_HEADERS: 'X-Trace: ambient-value',
    },
  })
  assert.equal(canonical.ANTHROPIC_CUSTOM_HEADERS, 'X-Trace: ambient-value')
})

test('openai launch withholds ambient credentials from a look-alike canonical path', async () => {
  // `/V1` resolves to the aimlapi route by host, so the launch carries the
  // identity — but the strict canonical predicate rejects the path, so it is
  // treated as a proxy and the ambient canonical credential is withheld.
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      CLAUDE_CODE_PROVIDER_ROUTE_ID: 'aimlapi',
      OPENAI_BASE_URL: 'https://api.aimlapi.com/v1',
      OPENAI_MODEL: 'gpt-4o',
    }),
    goal: 'coding',
    processEnv: {
      OPENAI_BASE_URL: 'https://api.aimlapi.com/V1',
      OPENAI_API_KEY: 'ambient-openai-key',
      AIMLAPI_API_KEY: 'ambient-aimlapi-key',
    },
  })

  assert.equal(env.OPENAI_BASE_URL, 'https://api.aimlapi.com/V1')
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.AIMLAPI_API_KEY, undefined)
})

test('openai launch withholds ambient custom auth from a keyless proxy aimlapi profile', async () => {
  // Custom authentication is a second credential channel: the shim sends
  // OPENAI_AUTH_HEADER_VALUE as the request credential whenever
  // OPENAI_AUTH_HEADER names a header. An ambient pair must not ride along into
  // a proxy session that the profile never configured for it.
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      CLAUDE_CODE_PROVIDER_ROUTE_ID: 'aimlapi',
      OPENAI_BASE_URL: 'https://proxy.example.com/v1',
      OPENAI_MODEL: 'gpt-4o',
    }),
    goal: 'coding',
    processEnv: {
      OPENAI_BASE_URL: 'https://proxy.example.com/v1',
      OPENAI_AUTH_HEADER: 'X-Ambient-Auth',
      OPENAI_AUTH_SCHEME: 'raw',
      OPENAI_AUTH_HEADER_VALUE: 'ambient-canonical-secret',
    },
  })

  assert.equal(env.CLAUDE_CODE_PROVIDER_ROUTE_ID, 'aimlapi')
  assert.equal(env.OPENAI_AUTH_HEADER, undefined)
  assert.equal(env.OPENAI_AUTH_SCHEME, undefined)
  assert.equal(env.OPENAI_AUTH_HEADER_VALUE, undefined)

  // The profile's OWN custom auth is still applied — the user configured it for
  // that proxy — and an ambient value must not override it.
  const owned = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      CLAUDE_CODE_PROVIDER_ROUTE_ID: 'aimlapi',
      OPENAI_BASE_URL: 'https://proxy.example.com/v1',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_AUTH_HEADER: 'X-Proxy-Auth',
      OPENAI_AUTH_SCHEME: 'raw',
      OPENAI_AUTH_HEADER_VALUE: 'profile-own-proxy-secret',
    }),
    goal: 'coding',
    processEnv: {
      OPENAI_BASE_URL: 'https://proxy.example.com/v1',
      OPENAI_AUTH_HEADER: 'X-Ambient-Auth',
      OPENAI_AUTH_HEADER_VALUE: 'ambient-canonical-secret',
    },
  })
  assert.equal(owned.OPENAI_AUTH_HEADER, 'X-Proxy-Auth')
  assert.equal(owned.OPENAI_AUTH_HEADER_VALUE, 'profile-own-proxy-secret')

  // On the canonical endpoint ambient custom auth keeps its existing behaviour.
  const canonical = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      CLAUDE_CODE_PROVIDER_ROUTE_ID: 'aimlapi',
      OPENAI_BASE_URL: 'https://api.aimlapi.com/v1',
      OPENAI_MODEL: 'gpt-4o',
    }),
    goal: 'coding',
    processEnv: {
      OPENAI_BASE_URL: 'https://api.aimlapi.com/v1',
      OPENAI_AUTH_HEADER: 'X-Ambient-Auth',
      OPENAI_AUTH_HEADER_VALUE: 'ambient-canonical-secret',
    },
  })
  assert.equal(canonical.OPENAI_AUTH_HEADER_VALUE, 'ambient-canonical-secret')
})

test('xai launch uses descriptor defaults and persisted xAI key', async () => {
  const env = await buildLaunchEnv({
    profile: 'xai',
    persisted: profile('xai', {
      XAI_API_KEY: 'xai-persisted-key',
    }),
    goal: 'balanced',
    processEnv: {},
  })

  assert.equal(env.CLAUDE_CODE_USE_OPENAI, '1')
  assert.equal(env.OPENAI_BASE_URL, 'https://api.x.ai/v1')
  assert.equal(env.OPENAI_MODEL, 'grok-4.6')
  assert.equal(env.OPENAI_API_KEY, 'xai-persisted-key')
  assert.equal(env.XAI_API_KEY, 'xai-persisted-key')
})

test('xai launch lets shell xAI key override persisted xAI key', async () => {
  const env = await buildLaunchEnv({
    profile: 'xai',
    persisted: profile('xai', {
      XAI_API_KEY: 'xai-persisted-key',
      OPENAI_MODEL: 'grok-3',
    }),
    goal: 'balanced',
    processEnv: {
      XAI_API_KEY: 'xai-shell-key',
    },
  })

  assert.equal(env.CLAUDE_CODE_USE_OPENAI, '1')
  assert.equal(env.OPENAI_BASE_URL, 'https://api.x.ai/v1')
  assert.equal(env.OPENAI_MODEL, 'grok-3')
  assert.equal(env.OPENAI_API_KEY, 'xai-shell-key')
  assert.equal(env.XAI_API_KEY, 'xai-shell-key')
})

test('openai launch ignores codex shell transport hints', async () => {
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: null,
    goal: 'balanced',
    processEnv: {
      OPENAI_API_KEY: 'sk-live',
      OPENAI_BASE_URL: 'https://chatgpt.com/backend-api/codex',
      OPENAI_MODEL: 'codexplan',
    },
  })

  assert.equal(env.OPENAI_BASE_URL, 'https://api.openai.com/v1')
  assert.equal(env.OPENAI_MODEL, 'gpt-5.5')
  assert.equal(env.OPENAI_API_KEY, 'sk-live')
})

test('openai launch ignores codex persisted transport hints', async () => {
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://chatgpt.com/backend-api/codex',
      OPENAI_MODEL: 'codexplan',
      OPENAI_API_KEY: 'sk-persisted',
    }),
    goal: 'balanced',
    processEnv: {
      OPENAI_API_KEY: 'sk-live',
    },
  })

  assert.equal(env.OPENAI_BASE_URL, 'https://api.openai.com/v1')
  assert.equal(env.OPENAI_MODEL, 'gpt-5.5')
  assert.equal(env.OPENAI_API_KEY, 'sk-live')
})

test('buildStartupEnvFromProfile defaults fresh installs to Twigpine Opengateway', async () => {
  const env = await buildStartupEnvFromProfile({
    persisted: null,
    processEnv: {},
  })

  assert.equal(env.CLAUDE_CODE_USE_OPENAI, '1')
  assert.equal(env.OPENAI_BASE_URL, 'https://opengateway.gitlawb.com/v1')
  assert.equal(env.OPENAI_MODEL, 'mimo-v2.5-pro')
  assert.equal(isDefaultStartupProviderEnv(env), true)
})

test('buildStartupEnvFromProfile fresh-install OpenGateway env is invalid without an API key (issue #1651)', async () => {
  const env = await buildStartupEnvFromProfile({
    persisted: null,
    processEnv: {},
  })

  assert.equal(isDefaultStartupProviderEnv(env), true)
  const error = await getProviderValidationError(env)
  assert.notEqual(error, null)
  assert.ok(error!.includes('OPENGATEWAY_API_KEY'))
})

test('applyStartupEnvFromProfile ignores the invalid fresh-install default SILENTLY (issue #1651 + zero-warning install)', async () => {
  const processEnv: NodeJS.ProcessEnv = {}
  const warnings: string[] = []

  const error = await applyStartupEnvFromProfile({
    persisted: null,
    processEnv,
    onValidationError: message => warnings.push(message),
  })

  // Still ignored (not applied), but a brand-new machine must not see a
  // "saved provider profile" warning on every command — nothing was saved.
  assert.notEqual(error, null)
  assert.ok(error!.includes('OPENGATEWAY_API_KEY'))
  assert.deepEqual(warnings, [])
  assert.deepEqual(processEnv, {})
})

test('applyStartupEnvFromProfile still warns when a genuinely saved profile fails validation', async () => {
  const processEnv: NodeJS.ProcessEnv = {}
  const warnings: string[] = []

  const error = await applyStartupEnvFromProfile({
    persisted: {
      profile: 'openai',
      env: { OPENAI_BASE_URL: 'https://api.openai.com/v1' },
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    processEnv,
    onValidationError: message => warnings.push(message),
  })

  assert.notEqual(error, null)
  assert.deepEqual(warnings, [
    `Warning: ignoring saved provider profile. ${error}`,
  ])
  assert.deepEqual(processEnv, {})
})

test('applyStartupEnvFromProfile warns for a saved Opengateway-shaped profile even when the default-startup marker leaks in from a parent process', async () => {
  // Collision guard: a persisted profile's launch env spreads processEnv, so
  // a CLAUDE_CODE_DEFAULT_STARTUP_PROVIDER marker inherited from a parent CLI
  // process can make the saved profile's env indistinguishable from the
  // injected fresh-install default by marker-sniffing alone. Provenance
  // (persisted !== null) must win: this saved-but-invalid profile warns.
  const processEnv: NodeJS.ProcessEnv = {
    [DEFAULT_STARTUP_PROVIDER_ENV_VAR]: 'gitlawb-opengateway',
  }
  const warnings: string[] = []

  const error = await applyStartupEnvFromProfile({
    persisted: {
      profile: 'openai',
      env: { OPENAI_BASE_URL: 'https://opengateway.gitlawb.com/v1' },
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    processEnv,
    onValidationError: message => warnings.push(message),
  })

  assert.notEqual(error, null)
  assert.deepEqual(warnings, [
    `Warning: ignoring saved provider profile. ${error}`,
  ])
  // The invalid env is ignored: only the pre-existing marker remains.
  assert.deepEqual(processEnv, {
    [DEFAULT_STARTUP_PROVIDER_ENV_VAR]: 'gitlawb-opengateway',
  })
})

test('applyStartupEnvFromProfile applies valid startup env (issue #1651)', async () => {
  const processEnv: NodeJS.ProcessEnv = {
    OPENGATEWAY_API_KEY: 'test-key',
  }
  const warnings: string[] = []

  const error = await applyStartupEnvFromProfile({
    persisted: null,
    processEnv,
    onValidationError: message => warnings.push(message),
  })

  assert.equal(error, null)
  assert.deepEqual(warnings, [])
  assert.equal(processEnv.CLAUDE_CODE_USE_OPENAI, '1')
  assert.equal(processEnv.OPENAI_BASE_URL, 'https://opengateway.gitlawb.com/v1')
  assert.equal(processEnv.OPENAI_MODEL, 'mimo-v2.5-pro')
  assert.equal(processEnv.OPENGATEWAY_API_KEY, 'test-key')
})

test('applyStartupEnvFromProfile overlays a root model before validating a saved Command Code profile', async () => {
  const processEnv: NodeJS.ProcessEnv = {}

  const error = await applyStartupEnvFromProfile({
    persisted: {
      profile: 'openai',
      env: {
        CLAUDE_CODE_PROVIDER_ROUTE_ID: 'commandcode',
        OPENAI_BASE_URL: 'https://api.commandcode.ai/provider/v1',
        OPENAI_MODEL: 'anthropic/claude-sonnet-4-6',
        CMD_API_KEY: 'cmd-key',
      },
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    processEnv,
    modelOverride: 'deepseek/deepseek-v4-flash',
  })

  assert.equal(error, null)
  assert.equal(processEnv.CLAUDE_CODE_PROVIDER_ROUTE_ID, 'commandcode')
  assert.equal(processEnv.OPENAI_MODEL, 'deepseek/deepseek-v4-flash')
  assert.equal(processEnv.CMD_API_KEY, 'cmd-key')
})

test('applyStartupEnvFromProfile resolves the reserved default model for Command Code', async () => {
  const processEnv: NodeJS.ProcessEnv = {}

  const error = await applyStartupEnvFromProfile({
    persisted: {
      profile: 'openai',
      env: {
        CLAUDE_CODE_PROVIDER_ROUTE_ID: 'commandcode',
        OPENAI_BASE_URL: 'https://api.commandcode.ai/provider/v1',
        OPENAI_MODEL: 'anthropic/claude-sonnet-4-6',
        CMD_API_KEY: 'cmd-key',
      },
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    processEnv,
    modelOverride: 'default',
  })

  assert.equal(error, null)
  assert.equal(processEnv.OPENAI_MODEL, 'deepseek/deepseek-v4-flash')
})

test('buildStartupEnvFromProfile preserves explicit OpenAI-compatible env without a saved profile', async () => {
  const env = await buildStartupEnvFromProfile({
    persisted: null,
    processEnv: {
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_API_KEY: 'sk-live',
      OPENAI_BASE_URL: 'http://common.example.com/v1',
      OPENAI_MODEL: 'gemma-4-31B-it',
    },
  })

  assert.equal(env.CLAUDE_CODE_USE_OPENAI, '1')
  assert.equal(env.OPENAI_API_KEY, 'sk-live')
  assert.equal(env.OPENAI_BASE_URL, 'http://common.example.com/v1')
  assert.equal(env.OPENAI_MODEL, 'gemma-4-31B-it')
  assert.equal(resolveActiveRouteIdFromEnv(env), 'custom')
  assert.equal(isDefaultStartupProviderEnv(env), false)
})

test('buildStartupEnvFromProfile preserves concrete env-only NIM setup over stale profile', async () => {
  const processEnv: NodeJS.ProcessEnv = {
    OPENAI_BASE_URL: 'https://integrate.api.nvidia.com/v1',
    OPENAI_MODEL: 'qwen/qwen3.5-397b-a17b',
    NVIDIA_API_KEY: 'nvapi-live',
    NVIDIA_NIM: '1',
  }

  const env = await buildStartupEnvFromProfile({
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://integrate.api.nvidia.com/v1',
      OPENAI_MODEL: 'z-ai/glm-5.2',
      NVIDIA_API_KEY: 'nvapi-stale',
      NVIDIA_NIM: '1',
    }),
    processEnv,
  })

  assert.notEqual(env, processEnv)
  assert.equal(env.CLAUDE_CODE_USE_OPENAI, '1')
  assert.equal(env.CLAUDE_CODE_PROVIDER_ROUTE_ID, 'nvidia-nim')
  assert.equal(env.OPENAI_MODEL, 'qwen/qwen3.5-397b-a17b')
  assert.equal(env.OPENAI_BASE_URL, 'https://integrate.api.nvidia.com/v1')
  assert.equal(env.NVIDIA_API_KEY, 'nvapi-live')
  assert.equal(env.NVIDIA_NIM, '1')
  assert.equal(resolveActiveRouteIdFromEnv(env), 'nvidia-nim')
})

test('buildStartupEnvFromProfile preserves ApiSmart env-only setup over a saved profile', async () => {
  const processEnv: NodeJS.ProcessEnv = {
    APISMART_API_KEY: 'apismart-live',
  }

  const env = await buildStartupEnvFromProfile({
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_API_KEY: 'stale-openai-key',
    }),
    processEnv,
  })

  assert.equal(env.APISMART_API_KEY, 'apismart-live')
  assert.equal(resolveActiveRouteIdFromEnv(env), 'apismart')
  assert.equal(env.OPENAI_BASE_URL, undefined)
})

test('buildStartupEnvFromProfile does not activate non-NIM env-only OpenAI-compatible setup', async () => {
  const env = await buildStartupEnvFromProfile({
    persisted: null,
    processEnv: {
      OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENAI_MODEL: 'openrouter/zhipu/glm-5.2',
      OPENAI_API_KEY: 'sk-live',
    },
  })

  assert.equal(env.CLAUDE_CODE_USE_OPENAI, '1')
  assert.equal(env.CLAUDE_CODE_PROVIDER_ROUTE_ID, undefined)
  assert.equal(env.OPENAI_BASE_URL, 'https://opengateway.gitlawb.com/v1')
  assert.equal(env.OPENAI_MODEL, 'mimo-v2.5-pro')
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(resolveActiveRouteIdFromEnv(env), 'gitlawb-opengateway')
  assert.equal(isDefaultStartupProviderEnv(env), true)
})

test('buildStartupEnvFromProfile documents no-flag Gemini env does not beat concrete NIM setup', async () => {
  const processEnv = {
    GEMINI_API_KEY: 'gemini-live',
    GEMINI_MODEL: 'gemini-2.5-flash',
    OPENAI_BASE_URL: 'https://integrate.api.nvidia.com/v1',
    OPENAI_MODEL: 'qwen/qwen3.5-397b-a17b',
    NVIDIA_API_KEY: 'nvapi-live',
    NVIDIA_NIM: '1',
  }

  const env = await buildStartupEnvFromProfile({
    persisted: null,
    processEnv,
  })

  assert.notEqual(env, processEnv)
  assert.equal(env.CLAUDE_CODE_USE_OPENAI, '1')
  assert.equal(env.CLAUDE_CODE_USE_GEMINI, undefined)
  assert.equal(env.CLAUDE_CODE_PROVIDER_ROUTE_ID, 'nvidia-nim')
  assert.equal(env.GEMINI_API_KEY, undefined)
  assert.equal(env.OPENAI_MODEL, 'qwen/qwen3.5-397b-a17b')
  assert.equal(resolveActiveRouteIdFromEnv(env), 'nvidia-nim')
})

test('buildStartupEnvFromProfile preserves explicit OpenAI opt-out over concrete env-only NIM setup', async () => {
  const processEnv: NodeJS.ProcessEnv = {
    CLAUDE_CODE_USE_OPENAI: '0',
    OPENAI_BASE_URL: 'https://integrate.api.nvidia.com/v1',
    OPENAI_MODEL: 'qwen/qwen3.5-397b-a17b',
    NVIDIA_API_KEY: 'nvapi-live',
    NVIDIA_NIM: '1',
  }

  const env = await buildStartupEnvFromProfile({
    persisted: null,
    processEnv,
  })

  assert.equal(env, processEnv)
  assert.equal(env.CLAUDE_CODE_USE_OPENAI, '0')
  assert.equal(env.CLAUDE_CODE_PROVIDER_ROUTE_ID, undefined)
  assert.equal(isDefaultStartupProviderEnv(env), false)
})

test('buildStartupEnvFromProfile preserves explicit Gemini selection over concrete env-only NIM setup', async () => {
  const processEnv: NodeJS.ProcessEnv = {
    CLAUDE_CODE_USE_GEMINI: '1',
    GEMINI_API_KEY: 'gemini-live',
    GEMINI_MODEL: 'gemini-2.5-flash',
    OPENAI_BASE_URL: 'https://integrate.api.nvidia.com/v1',
    OPENAI_MODEL: 'qwen/qwen3.5-397b-a17b',
    NVIDIA_API_KEY: 'nvapi-live',
    NVIDIA_NIM: '1',
  }

  const env = await buildStartupEnvFromProfile({
    persisted: null,
    processEnv,
  })

  assert.equal(env, processEnv)
  assert.equal(env.CLAUDE_CODE_USE_GEMINI, '1')
  assert.equal(env.CLAUDE_CODE_USE_OPENAI, undefined)
  assert.equal(env.CLAUDE_CODE_PROVIDER_ROUTE_ID, undefined)
  assert.equal(resolveActiveRouteIdFromEnv(env), 'gemini')
  assert.equal(isDefaultStartupProviderEnv(env), false)
})

test('buildStartupEnvFromProfile respects an explicit CLAUDE_CODE_USE_OPENAI=0 opt-out (issue #1245)', async () => {
  const env = await buildStartupEnvFromProfile({
    persisted: null,
    processEnv: {
      CLAUDE_CODE_USE_OPENAI: '0',
    },
  })

  // The explicit opt-out must be preserved and the default Opengateway
  // profile must NOT be injected over it.
  assert.equal(env.CLAUDE_CODE_USE_OPENAI, '0')
  assert.equal(env.OPENAI_BASE_URL, undefined)
  assert.equal(env.OPENAI_MODEL, undefined)
  assert.equal(isDefaultStartupProviderEnv(env), false)

  // With OpenAI disabled and no provider configured, startup must not emit a
  // spurious "OPENAI_API_KEY is required" warning.
  assert.equal(await getProviderValidationError(env), null)
})

test('buildStartupEnvFromProfile preserves env-only Fireworks setup without a saved profile', async () => {
  const env = await buildStartupEnvFromProfile({
    persisted: null,
    processEnv: {
      FIREWORKS_API_KEY: 'fw-key',
    },
  })

  // Must NOT fall through to Twigpine Opengateway default
  assert.equal(env.FIREWORKS_API_KEY, 'fw-key')
  assert.equal(env.CLAUDE_CODE_USE_OPENAI, undefined)
  assert.equal(
    env.OPENAI_BASE_URL,
    undefined,
    'should not inject Twigpine Opengateway base URL',
  )
  assert.equal(isDefaultStartupProviderEnv(env), false)
})

test('buildStartupEnvFromProfile preserves env-only NEAR AI setup without a saved profile', async () => {
  const env = await buildStartupEnvFromProfile({
    persisted: null,
    processEnv: {
      NEARAI_API_KEY: 'nearai-key',
    },
  })

  assert.equal(env.NEARAI_API_KEY, 'nearai-key')
  assert.equal(
    env.OPENAI_BASE_URL,
    undefined,
    'should not inject Twigpine Opengateway base URL',
  )
  assert.equal(isDefaultStartupProviderEnv(env), false)
})

test('buildStartupEnvFromProfile preserves env-only LongCat setup without a saved profile', async () => {
  const env = await buildStartupEnvFromProfile({
    persisted: null,
    processEnv: {
      LONGCAT_API_KEY: 'longcat-key',
    },
  })

  assert.equal(env.LONGCAT_API_KEY, 'longcat-key')
  assert.equal(
    env.OPENAI_BASE_URL,
    undefined,
    'should not inject Twigpine Opengateway base URL',
  )
  assert.equal(isDefaultStartupProviderEnv(env), false)
})

test('openai launch does not apply persisted Azure mode to a shell-selected base', async () => {
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://persisted.example/v1',
      OPENAI_MODEL: 'persisted-model',
      OPENAI_API_FORMAT: 'chat_completions',
      OPENAI_AZURE_STYLE: '1',
      OPENAI_AUTH_HEADER: 'X-Persisted-Key',
      OPENAI_AUTH_SCHEME: 'raw',
      OPENAI_AUTH_HEADER_VALUE: 'persisted-secret',
      OPENAI_API_KEY: 'sk-persisted',
    }),
    goal: 'balanced',
    processEnv: {
      OPENAI_BASE_URL: 'https://shell.example/v1',
      OPENAI_MODEL: 'shell-model',
      OPENAI_API_FORMAT: 'responses',
      OPENAI_AUTH_HEADER: 'api-key',
      OPENAI_AUTH_SCHEME: 'raw',
      OPENAI_AUTH_HEADER_VALUE: 'shell-secret',
      OPENAI_API_KEY: 'sk-live',
    },
  })

  assert.equal(env.OPENAI_BASE_URL, 'https://shell.example/v1')
  assert.equal(env.OPENAI_MODEL, 'shell-model')
  assert.equal(env.OPENAI_API_FORMAT, 'responses')
  assert.equal(env.OPENAI_AZURE_STYLE, undefined)
  assert.equal(env.OPENAI_AUTH_HEADER, 'api-key')
  assert.equal(env.OPENAI_AUTH_SCHEME, 'raw')
  assert.equal(env.OPENAI_AUTH_HEADER_VALUE, 'shell-secret')
  assert.equal(env.OPENAI_API_KEY, 'sk-live')
})

test('matching persisted gemini env is reused for gemini launch', async () => {
  const env = await buildLaunchEnv({
    profile: 'gemini',
    persisted: profile('gemini', {
      GEMINI_MODEL: 'gemini-2.5-flash',
      GEMINI_API_KEY: 'gem-persisted',
      GEMINI_BASE_URL: 'https://example.test/v1beta/openai',
    }),
    goal: 'balanced',
    processEnv: {},
  })

  assert.equal(env.CLAUDE_CODE_USE_GEMINI, '1')
  assert.equal(env.CLAUDE_CODE_USE_OPENAI, undefined)
  assert.equal(env.GEMINI_MODEL, 'gemini-2.5-flash')
  assert.equal(env.GEMINI_API_KEY, 'gem-persisted')
  assert.equal(env.GEMINI_BASE_URL, 'https://example.test/v1beta/openai')
})

test('openai env variables take precedence over gemini', async () => {
  const env = await buildLaunchEnv({
    profile: 'gemini',
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_API_KEY: 'sk-persisted',
    }),
    goal: 'balanced',
    processEnv: {
      GEMINI_API_KEY: 'gem-live',
      GOOGLE_API_KEY: 'google-live',
      OPENAI_API_KEY: 'sk-live',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_MODEL: 'gpt-4o-mini',
      CODEX_API_KEY: 'codex-live',
      CHATGPT_ACCOUNT_ID: 'acct_live',
      CLAUDE_CODE_USE_OPENAI: '1',
    },
  })

  assert.equal(env.CLAUDE_CODE_USE_GEMINI, undefined) 
  assert.equal(env.CLAUDE_CODE_USE_OPENAI, '1')
  assert.equal(env.GEMINI_MODEL, undefined)
  assert.equal(env.GEMINI_API_KEY, undefined)
  assert.equal(
    env.GEMINI_BASE_URL,
    undefined,
  )
  assert.equal(env.GOOGLE_API_KEY, undefined)
  assert.equal(env.OPENAI_API_KEY, 'sk-live')
  assert.equal(env.CODEX_API_KEY, undefined)
  assert.equal(env.CHATGPT_ACCOUNT_ID, undefined)
})

test('matching persisted codex env is reused for codex launch', async () => {
  const env = await buildLaunchEnv({
    profile: 'codex',
    persisted: profile('codex', {
      OPENAI_BASE_URL: 'https://chatgpt.com/backend-api/codex',
      OPENAI_MODEL: 'codexspark',
      CODEX_API_KEY: 'codex-persisted',
      CHATGPT_ACCOUNT_ID: 'acct_persisted',
    }),
    goal: 'balanced',
    processEnv: {
      CODEX_AUTH_JSON_PATH: missingCodexAuthPath,
    },
  })

  assert.equal(env.OPENAI_BASE_URL, 'https://chatgpt.com/backend-api/codex')
  assert.equal(env.OPENAI_MODEL, 'codexspark')
  assert.equal(env.CODEX_API_KEY, 'codex-persisted')
  assert.equal(env.CHATGPT_ACCOUNT_ID, 'acct_persisted')
})

test('codex launch normalizes poisoned persisted base urls', async () => {
  const env = await buildLaunchEnv({
    profile: 'codex',
    persisted: profile('codex', {
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_MODEL: 'codexspark',
      CHATGPT_ACCOUNT_ID: 'acct_persisted',
    }),
    goal: 'balanced',
    processEnv: {
      CODEX_AUTH_JSON_PATH: missingCodexAuthPath,
    },
  })

  assert.equal(env.OPENAI_BASE_URL, 'https://chatgpt.com/backend-api/codex')
  assert.equal(env.OPENAI_MODEL, 'codexspark')
})

test('codex launch ignores mismatched persisted openai env', async () => {
  const env = await buildLaunchEnv({
    profile: 'codex',
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_API_KEY: 'sk-persisted',
    }),
    goal: 'balanced',
    processEnv: {
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_MODEL: 'gpt-4o-mini',
      OPENAI_API_KEY: 'sk-live',
      CODEX_API_KEY: 'codex-live',
      CHATGPT_ACCOUNT_ID: 'acct_live',
    },
  })

  assert.equal(env.OPENAI_BASE_URL, 'https://chatgpt.com/backend-api/codex')
  assert.equal(env.OPENAI_MODEL, 'codexplan')
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.CODEX_API_KEY, 'codex-live')
  assert.equal(env.CHATGPT_ACCOUNT_ID, 'acct_live')
})

test('codex launch ignores placeholder codex env keys', async () => {
  const env = await buildLaunchEnv({
    profile: 'codex',
    persisted: profile('codex', {
      OPENAI_BASE_URL: 'https://chatgpt.com/backend-api/codex',
      OPENAI_MODEL: 'codexspark',
      CODEX_API_KEY: 'codex-persisted',
      CHATGPT_ACCOUNT_ID: 'acct_persisted',
    }),
    goal: 'balanced',
    processEnv: {
      CODEX_API_KEY: 'SUA_CHAVE',
      CODEX_AUTH_JSON_PATH: missingCodexAuthPath,
    },
  })

  assert.equal(env.CODEX_API_KEY, 'codex-persisted')
  assert.equal(env.CHATGPT_ACCOUNT_ID, 'acct_persisted')
})

test('codex launch prefers auth account id over stale persisted value', async () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'openclaude-codex-'))
  try {
    writeFileSync(
      join(codexHome, 'auth.json'),
      JSON.stringify({
        access_token: 'codex-live',
        account_id: 'acct_auth',
      }),
      'utf8',
    )

    const env = await buildLaunchEnv({
      profile: 'codex',
      persisted: profile('codex', {
        OPENAI_BASE_URL: 'https://chatgpt.com/backend-api/codex',
        OPENAI_MODEL: 'codexspark',
        CHATGPT_ACCOUNT_ID: 'acct_persisted',
      }),
      goal: 'balanced',
      processEnv: {
        CODEX_HOME: codexHome,
      },
    })

    assert.equal(env.CHATGPT_ACCOUNT_ID, 'acct_auth')
  } finally {
    rmSync(codexHome, { recursive: true, force: true })
  }
})

test('ollama profiles never persist openai api keys', () => {
  const env = buildOllamaProfileEnv('llama3.1:8b', {
    getOllamaChatBaseUrl: () => 'http://localhost:11434/v1',
  })

  assert.deepEqual(env, {
    OPENAI_BASE_URL: 'http://localhost:11434/v1',
    OPENAI_MODEL: 'llama3.1:8b',
    CLAUDE_CODE_PROVIDER_ROUTE_ID: 'ollama',
  })
  assert.equal('OPENAI_API_KEY' in env, false)
})

test('codex profiles accept explicit codex credentials', () => {
  const env = buildCodexProfileEnv({
    model: 'codexspark',
    apiKey: 'codex-live',
    processEnv: {
      CHATGPT_ACCOUNT_ID: 'acct_123',
    },
  })

  assert.deepEqual(env, {
    OPENAI_BASE_URL: 'https://chatgpt.com/backend-api/codex',
    OPENAI_MODEL: 'codexspark',
    CODEX_CREDENTIAL_SOURCE: 'existing',
    CODEX_API_KEY: 'codex-live',
    CHATGPT_ACCOUNT_ID: 'acct_123',
  })
})

test('codex profiles require a chatgpt account id', () => {
  const env = buildCodexProfileEnv({
    model: 'codexspark',
    apiKey: 'codex-live',
    processEnv: {
      CODEX_AUTH_JSON_PATH: missingCodexAuthPath,
    },
  })

  assert.equal(env, null)
})

// Regression: a user with `OPENAI_API_KEY=sk-openai-…` in their shell
// who signs into xAI OAuth previously had that generic OpenAI key
// promoted into both OPENAI_API_KEY and XAI_API_KEY for the xAI
// profile, dropping XAI_CREDENTIAL_SOURCE. openaiShim then sent the
// OpenAI key as a Bearer to api.x.ai/v1 — wrong account, wrong key,
// 401 (and leaks the OpenAI key to xAI). Marker-tagged xAI OAuth
// profiles must ignore generic OpenAI credentials entirely.
test('xai OAuth profile ignores ambient OPENAI_API_KEY and preserves marker', async () => {
  const env = await buildLaunchEnv({
    profile: 'xai',
    persisted: profile('xai', {
      OPENAI_BASE_URL: 'https://api.x.ai/v1',
      OPENAI_MODEL: 'grok-4.3',
      XAI_CREDENTIAL_SOURCE: 'oauth',
    }),
    goal: 'balanced',
    processEnv: {
      OPENAI_API_KEYS: 'sk-openai-pool-a,SUA_CHAVE',
      OPENAI_API_KEY: 'sk-openai-shell-key',
    },
  })

  // Marker survives so startup validation accepts the profile.
  assert.equal(env.XAI_CREDENTIAL_SOURCE, 'oauth')
  // OpenAI key is NOT promoted into the xAI bearer surface.
  assert.equal(env.XAI_API_KEY, undefined)
  // openaiShim short-circuits on OPENAI_API_KEYS / OPENAI_API_KEY before
  // checking the stored OAuth token, so both must be cleared from the
  // resulting process env (clearManagedProfileEnv + no promotion in profileEnv).
  assert.equal(env.OPENAI_API_KEYS, undefined)
  assert.equal(env.OPENAI_API_KEY, undefined)
  // Base URL and model still come through.
  assert.equal(env.OPENAI_BASE_URL, 'https://api.x.ai/v1')
  assert.equal(env.OPENAI_MODEL, 'grok-4.3')
})

test('xai OAuth profile still honors an explicit XAI_API_KEY override', async () => {
  const env = await buildLaunchEnv({
    profile: 'xai',
    persisted: profile('xai', {
      OPENAI_BASE_URL: 'https://api.x.ai/v1',
      OPENAI_MODEL: 'grok-4.3',
      XAI_CREDENTIAL_SOURCE: 'oauth',
    }),
    goal: 'balanced',
    processEnv: {
      XAI_API_KEY: 'xai-explicit-override',
      OPENAI_API_KEY: 'sk-openai-shell-key',
    },
  })

  // Explicit XAI_API_KEY wins; the OAuth marker drops because we have
  // a concrete bearer to send.
  assert.equal(env.XAI_API_KEY, 'xai-explicit-override')
  assert.equal(env.OPENAI_API_KEY, 'xai-explicit-override')
  assert.equal(env.XAI_CREDENTIAL_SOURCE, undefined)
})

test('xai non-OAuth profile (legacy api-key flow) still accepts OPENAI_API_KEY fallback', async () => {
  // Backward-compat: an xAI profile saved before the OAuth flow existed
  // (no XAI_CREDENTIAL_SOURCE marker) used to inherit OPENAI_API_KEY
  // for one-off connections. Don't break that path.
  const env = await buildLaunchEnv({
    profile: 'xai',
    persisted: profile('xai', {
      OPENAI_BASE_URL: 'https://api.x.ai/v1',
      OPENAI_MODEL: 'grok-4.3',
    }),
    goal: 'balanced',
    processEnv: {
      OPENAI_API_KEY: 'xai-disguised-as-openai-key',
    },
  })

  assert.equal(env.XAI_API_KEY, 'xai-disguised-as-openai-key')
  assert.equal(env.OPENAI_API_KEY, 'xai-disguised-as-openai-key')
})

test('codex launch clears openai-compatible format and custom auth env', async () => {
  const env = await buildLaunchEnv({
    profile: 'codex',
    persisted: profile('codex', {
      OPENAI_BASE_URL: 'https://chatgpt.com/backend-api/codex',
      OPENAI_MODEL: 'codexspark',
      CHATGPT_ACCOUNT_ID: 'acct_persisted',
    }),
    goal: 'balanced',
    processEnv: {
      OPENAI_API_FORMAT: 'responses',
      OPENAI_AUTH_HEADER: 'api-key',
      OPENAI_AUTH_SCHEME: 'raw',
      OPENAI_AUTH_HEADER_VALUE: 'hicap-header-secret',
      CODEX_API_KEY: 'codex-live',
      CHATGPT_ACCOUNT_ID: 'acct_live',
    },
  })

  assert.equal(env.OPENAI_API_FORMAT, undefined)
  assert.equal(env.OPENAI_AUTH_HEADER, undefined)
  assert.equal(env.OPENAI_AUTH_SCHEME, undefined)
  assert.equal(env.OPENAI_AUTH_HEADER_VALUE, undefined)
  assert.equal(env.CODEX_API_KEY, 'codex-live')
})

test('gemini profiles accept google api key fallback', () => {
  const env = buildGeminiProfileEnv({
    processEnv: {
      GOOGLE_API_KEY: 'gem-live',
    },
  })

  assert.deepEqual(env, {
    GEMINI_AUTH_MODE: 'api-key',
    GEMINI_MODEL: 'gemini-3-flash-preview',
    GEMINI_API_KEY: 'gem-live',
  })
})

test('gemini profiles use the first model from a semicolon-separated list', () => {
  const env = buildGeminiProfileEnv({
    authMode: 'api-key',
    apiKey: 'gem-live',
    model: 'gemini-2.5-pro; gemini-2.5-flash',
    processEnv: {},
  })

  assert.deepEqual(env, {
    GEMINI_AUTH_MODE: 'api-key',
    GEMINI_MODEL: 'gemini-2.5-pro',
    GEMINI_API_KEY: 'gem-live',
  })
})

test('gemini profiles support access-token auth mode without persisting a key', () => {
  const env = buildGeminiProfileEnv({
    authMode: 'access-token',
    model: 'gemini-2.5-flash',
    processEnv: {},
  })

  assert.deepEqual(env, {
    GEMINI_AUTH_MODE: 'access-token',
    GEMINI_MODEL: 'gemini-2.5-flash',
  })
})

test('gemini profiles support adc auth mode without persisting a key', () => {
  const env = buildGeminiProfileEnv({
    authMode: 'adc',
    model: 'gemini-2.5-flash',
    processEnv: {},
  })

  assert.deepEqual(env, {
    GEMINI_AUTH_MODE: 'adc',
    GEMINI_MODEL: 'gemini-2.5-flash',
  })
})

test('gemini profiles require a key', () => {
  const env = buildGeminiProfileEnv({
    processEnv: {},
  })

  assert.equal(env, null)
})

test('saveProfileFile writes a profile that loadProfileFile can read back', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'openclaude-profile-file-'))

  try {
    const persisted = createProfileFile('openai', {
      OPENAI_API_KEY: 'sk-test',
      OPENAI_MODEL: 'gpt-4o',
    })

    const filePath = saveProfileFile(persisted, { cwd })

    assert.equal(filePath, join(cwd, PROFILE_FILE_NAME))
    assert.equal(
      JSON.parse(readFileSync(filePath, 'utf8')).profile,
      'openai',
    )
    assert.deepEqual(loadProfileFile({ cwd }), persisted)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('saveProfileFile restricts permissions when overwriting an existing profile', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'openclaude-profile-mode-'))

  try {
    const filePath = join(cwd, PROFILE_FILE_NAME)
    writeFileSync(filePath, '{}', { encoding: 'utf8', mode: 0o644 })
    chmodSync(filePath, 0o644)

    saveProfileFile(
      createProfileFile('anthropic', {
        ANTHROPIC_AUTH_TOKEN: 'custom-bearer-token',
      }),
      { cwd },
    )

    if (process.platform !== 'win32') {
      assert.equal(statSync(filePath).mode & 0o777, 0o600)
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('saveProfileFile defaults to user config instead of the working directory', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'openclaude-workspace-profile-'))
  const configRoot = mkdtempSync(join(tmpdir(), 'openclaude-config-profile-'))
  const configDir = join(configRoot, 'config')
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  const previousCwd = process.cwd()

  try {
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.chdir(cwd)

    const persisted = createProfileFile('openai', {
      OPENAI_API_KEY: 'sk-test',
      OPENAI_MODEL: 'gpt-4o',
    })

    const filePath = saveProfileFile(persisted, { configDir })

    assert.equal(filePath, join(configDir, PROFILE_FILE_NAME))
    assert.equal(getDefaultProfileFilePath(configDir), join(configDir, PROFILE_FILE_NAME))
    assert.equal(existsSync(join(cwd, PROFILE_FILE_NAME)), false)
    const configDirStat = statSync(configDir)
    assert.equal(configDirStat.isDirectory(), true)
    if (process.platform !== 'win32') {
      assert.equal(configDirStat.mode & 0o777, 0o700)
    }
    assert.deepEqual(loadProfileFile({ configDir, cwd }), persisted)
  } finally {
    process.chdir(previousCwd)
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    }
    rmSync(cwd, { recursive: true, force: true })
    rmSync(configRoot, { recursive: true, force: true })
  }
})

test('loadProfileFile keeps project-local files as a legacy fallback', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'openclaude-legacy-profile-'))
  const configDir = mkdtempSync(join(tmpdir(), 'openclaude-empty-config-profile-'))
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  const previousCwd = process.cwd()

  try {
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.chdir(cwd)

    const legacyProfile = createProfileFile('gemini', {
      GEMINI_API_KEY: 'gem-test',
      GEMINI_MODEL: 'gemini-2.5-flash',
    })
    writeFileSync(
      join(cwd, PROFILE_FILE_NAME),
      JSON.stringify(legacyProfile, null, 2),
      'utf8',
    )

    assert.deepEqual(loadProfileFile({ configDir, cwd }), legacyProfile)
  } finally {
    process.chdir(previousCwd)
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    }
    rmSync(cwd, { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('loadProfileFile does not fall back when user config profile is invalid', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'openclaude-invalid-profile-'))
  const configDir = mkdtempSync(join(tmpdir(), 'openclaude-invalid-config-profile-'))
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  const previousCwd = process.cwd()

  try {
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.chdir(cwd)

    const legacyProfile = createProfileFile('gemini', {
      GEMINI_API_KEY: 'gem-test',
      GEMINI_MODEL: 'gemini-2.5-flash',
    })
    writeFileSync(join(configDir, PROFILE_FILE_NAME), '{', 'utf8')
    writeFileSync(
      join(cwd, PROFILE_FILE_NAME),
      JSON.stringify(legacyProfile, null, 2),
      'utf8',
    )

    assert.equal(loadProfileFile({ configDir, cwd }), null)
  } finally {
    process.chdir(previousCwd)
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    }
    rmSync(cwd, { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('deleteProfileFile clears the default profile and legacy workspace fallback', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'openclaude-delete-profile-'))
  const configDir = mkdtempSync(join(tmpdir(), 'openclaude-delete-config-profile-'))
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  const previousCwd = process.cwd()

  try {
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.chdir(cwd)

    const configProfile = createProfileFile('openai', {
      OPENAI_API_KEY: 'sk-test',
    })
    const legacyProfile = createProfileFile('ollama', {
      OPENAI_BASE_URL: 'http://localhost:11434/v1',
      OPENAI_MODEL: 'llama3.1:8b',
    })

    saveProfileFile(configProfile)
    writeFileSync(
      join(cwd, PROFILE_FILE_NAME),
      JSON.stringify(legacyProfile, null, 2),
      'utf8',
    )

    deleteProfileFile()

    assert.equal(existsSync(join(configDir, PROFILE_FILE_NAME)), false)
    assert.equal(existsSync(join(cwd, PROFILE_FILE_NAME)), false)
    assert.equal(loadProfileFile(), null)
  } finally {
    process.chdir(previousCwd)
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    }
    rmSync(cwd, { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('deleteProfileFile with configDir and cwd clears both user config and legacy fallback', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'openclaude-delete-mixed-profile-'))
  const configDir = mkdtempSync(join(tmpdir(), 'openclaude-delete-mixed-config-profile-'))
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  const previousCwd = process.cwd()

  try {
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.chdir(cwd)

    const configProfile = createProfileFile('openai', {
      OPENAI_API_KEY: 'sk-test',
    })
    const legacyProfile = createProfileFile('ollama', {
      OPENAI_BASE_URL: 'http://localhost:11434/v1',
      OPENAI_MODEL: 'llama3.1:8b',
    })

    saveProfileFile(configProfile, { configDir, cwd })
    writeFileSync(
      join(cwd, PROFILE_FILE_NAME),
      JSON.stringify(legacyProfile, null, 2),
      'utf8',
    )

    deleteProfileFile({ configDir, cwd })

    assert.equal(existsSync(join(configDir, PROFILE_FILE_NAME)), false)
    assert.equal(existsSync(join(cwd, PROFILE_FILE_NAME)), false)
    assert.equal(loadProfileFile({ configDir, cwd }), null)
  } finally {
    process.chdir(previousCwd)
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    }
    rmSync(cwd, { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('buildCodexProfileEnv tags OAuth-saved profiles so logout can remove them safely', () => {
  const env = buildCodexProfileEnv({
    model: 'codexplan',
    apiKey: makeJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_oauth',
      },
    }),
    credentialSource: 'oauth',
    processEnv: {},
  })

  assert.deepEqual(env, {
    OPENAI_BASE_URL: DEFAULT_CODEX_BASE_URL,
    OPENAI_MODEL: 'codexplan',
    CODEX_CREDENTIAL_SOURCE: 'oauth',
    CODEX_API_KEY: makeJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_oauth',
      },
    }),
    CHATGPT_ACCOUNT_ID: 'acct_oauth',
  })
})

test('clearPersistedCodexOAuthProfile removes only persisted Codex OAuth profiles', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'openclaude-codex-oauth-profile-'))

  try {
    const providerProfileModule = await import(
      `./providerProfile.js?ts=${Date.now()}-${Math.random()}`
    )
    const {
      PROFILE_FILE_NAME,
      clearPersistedCodexOAuthProfile,
      createProfileFile,
      isPersistedCodexOAuthProfile,
      loadProfileFile,
      saveProfileFile,
    } = providerProfileModule
    const oauthProfile = createProfileFile('codex', {
      OPENAI_MODEL: 'codexplan',
      OPENAI_BASE_URL: DEFAULT_CODEX_BASE_URL,
      CHATGPT_ACCOUNT_ID: 'acct_oauth',
      CODEX_CREDENTIAL_SOURCE: 'oauth',
    })
    saveProfileFile(oauthProfile, { cwd })
    assert.equal(isPersistedCodexOAuthProfile(loadProfileFile({ cwd })), true)
    assert.equal(
      clearPersistedCodexOAuthProfile({ cwd }),
      join(cwd, PROFILE_FILE_NAME),
    )
    assert.equal(loadProfileFile({ cwd }), null)

    const existingCredentialProfile = createProfileFile('codex', {
      OPENAI_MODEL: 'codexplan',
      OPENAI_BASE_URL: DEFAULT_CODEX_BASE_URL,
      CHATGPT_ACCOUNT_ID: 'acct_existing',
      CODEX_CREDENTIAL_SOURCE: 'existing',
    })
    saveProfileFile(existingCredentialProfile, { cwd })

    assert.equal(isPersistedCodexOAuthProfile(loadProfileFile({ cwd })), false)
    assert.equal(clearPersistedCodexOAuthProfile({ cwd }), null)
    assert.deepEqual(loadProfileFile({ cwd }), existingCredentialProfile)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('clearPersistedCodexOAuthProfile clears both default and legacy OAuth profiles', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'openclaude-clear-oauth-profile-'))
  const configDir = mkdtempSync(join(tmpdir(), 'openclaude-clear-oauth-config-'))
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  const previousCwd = process.cwd()

  try {
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.chdir(cwd)

    const {
      PROFILE_FILE_NAME: freshProfileFileName,
      clearPersistedCodexOAuthProfile: clearPersistedCodexOAuthProfileFresh,
      createProfileFile: createProfileFileFresh,
      loadProfileFile: loadProfileFileFresh,
      saveProfileFile: saveProfileFileFresh,
    } = await importFreshProviderProfileModule()

    const oauthProfile = createProfileFileFresh('codex', {
      OPENAI_MODEL: 'codexplan',
      OPENAI_BASE_URL: DEFAULT_CODEX_BASE_URL,
      CHATGPT_ACCOUNT_ID: 'acct_oauth',
      CODEX_CREDENTIAL_SOURCE: 'oauth',
    })

    saveProfileFileFresh(oauthProfile, { configDir })
    assert.deepEqual(loadProfileFileFresh({ configDir, cwd }), oauthProfile)
    writeFileSync(
      join(cwd, freshProfileFileName),
      JSON.stringify(oauthProfile, null, 2),
      'utf8',
    )

    assert.equal(
      clearPersistedCodexOAuthProfileFresh({ configDir, cwd }),
      join(configDir, freshProfileFileName),
    )
    assert.equal(existsSync(join(configDir, freshProfileFileName)), false)
    assert.equal(existsSync(join(cwd, freshProfileFileName)), false)
    assert.equal(loadProfileFileFresh({ configDir, cwd }), null)
  } finally {
    process.chdir(previousCwd)
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    }
    rmSync(cwd, { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('buildStartupEnvFromProfile applies persisted gemini settings when no provider is explicitly selected', async () => {
  const env = await buildStartupEnvFromProfile({
    persisted: profile('gemini', {
      GEMINI_API_KEY: 'gem-test',
      GEMINI_MODEL: 'gemini-2.5-flash',
    }),
    processEnv: {},
  })

  assert.equal(env.CLAUDE_CODE_USE_GEMINI, '1')
  assert.equal(env.CLAUDE_CODE_USE_OPENAI, undefined)
  assert.equal(env.GEMINI_API_KEY, 'gem-test')
  assert.equal(env.GEMINI_MODEL, 'gemini-2.5-flash')
})

test('buildStartupEnvFromProfile restores a persisted custom Anthropic Bearer token', async () => {
  const env = await buildStartupEnvFromProfile({
    persisted: profile('anthropic', {
      ANTHROPIC_BASE_URL: 'https://anthropic-proxy.example/v1',
      ANTHROPIC_MODEL: 'claude-proxy-model',
      ANTHROPIC_AUTH_TOKEN: 'persisted-proxy-token',
      ANTHROPIC_CUSTOM_HEADERS: 'X-Tenant: example',
    }),
    processEnv: {},
  })

  assert.equal(env.ANTHROPIC_BASE_URL, 'https://anthropic-proxy.example/v1')
  assert.equal(env.ANTHROPIC_MODEL, 'claude-proxy-model')
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'persisted-proxy-token')
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, 'X-Tenant: example')
})

test('buildStartupEnvFromProfile does not leak a stray API key into a persisted custom Anthropic Bearer profile', async () => {
  const env = await buildStartupEnvFromProfile({
    persisted: profile('anthropic', {
      ANTHROPIC_BASE_URL: 'https://anthropic-proxy.example/v1',
      ANTHROPIC_MODEL: 'claude-proxy-model',
      ANTHROPIC_AUTH_TOKEN: 'persisted-proxy-token',
    }),
    processEnv: { ANTHROPIC_API_KEY: 'sk-ant-stray-shell-key' },
  })

  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'persisted-proxy-token')
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
})

test('buildStartupEnvFromProfile preserves explicit custom Anthropic environment setup', async () => {
  const processEnv: NodeJS.ProcessEnv = {
    ANTHROPIC_BASE_URL: 'https://anthropic-proxy.example/v1',
    ANTHROPIC_MODEL: 'claude-proxy-model',
    ANTHROPIC_AUTH_TOKEN: 'env-proxy-token',
  }
  const env = await buildStartupEnvFromProfile({ persisted: null, processEnv })

  assert.equal(env, processEnv)
  assert.equal(env.CLAUDE_CODE_USE_OPENAI, undefined)
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'env-proxy-token')
})

test('buildStartupEnvFromProfile preserves custom Anthropic x-api-key setup', async () => {
  const processEnv: NodeJS.ProcessEnv = {
    ANTHROPIC_BASE_URL: 'https://anthropic-proxy.example/v1',
    ANTHROPIC_MODEL: 'claude-proxy-model',
    ANTHROPIC_API_KEY: 'env-proxy-key',
  }
  const env = await buildStartupEnvFromProfile({ persisted: null, processEnv })

  assert.equal(env, processEnv)
  assert.equal(env.CLAUDE_CODE_USE_OPENAI, undefined)
  assert.equal(env.ANTHROPIC_API_KEY, 'env-proxy-key')
})

test('buildStartupEnvFromProfile rehydrates stored Gemini access token for access-token profile mode', async () => {
  const env = await buildStartupEnvFromProfile({
    persisted: profile('gemini', {
      GEMINI_AUTH_MODE: 'access-token',
      GEMINI_MODEL: 'gemini-2.5-flash',
    }),
    processEnv: {},
    readGeminiAccessToken: () => 'token-live',
  })

  assert.equal(env.CLAUDE_CODE_USE_GEMINI, '1')
  assert.equal(env.GEMINI_AUTH_MODE, 'access-token')
  assert.equal(env.GEMINI_ACCESS_TOKEN, 'token-live')
  assert.equal(env.GEMINI_API_KEY, undefined)
  assert.equal(env.GEMINI_MODEL, 'gemini-2.5-flash')
})

test('buildStartupEnvFromProfile does not inject stored access token for adc profile mode', async () => {
  const env = await buildStartupEnvFromProfile({
    persisted: profile('gemini', {
      GEMINI_AUTH_MODE: 'adc',
      GEMINI_MODEL: 'gemini-2.5-flash',
    }),
    processEnv: {},
    readGeminiAccessToken: () => 'token-live',
  })

  assert.equal(env.CLAUDE_CODE_USE_GEMINI, '1')
  assert.equal(env.GEMINI_AUTH_MODE, 'adc')
  assert.equal(env.GEMINI_ACCESS_TOKEN, undefined)
  assert.equal(env.GEMINI_API_KEY, undefined)
})

test('buildStartupEnvFromProfile leaves explicit provider selections untouched', async () => {
  const processEnv: NodeJS.ProcessEnv = {
    CLAUDE_CODE_USE_GEMINI: '1',
    GEMINI_API_KEY: 'gem-live',
    GEMINI_MODEL: 'gemini-2.0-flash',
  }

  const env = await buildStartupEnvFromProfile({
    persisted: profile('openai', {
      OPENAI_API_KEY: 'sk-persisted',
      OPENAI_MODEL: 'gpt-4o',
    }),
    processEnv,
  })

  assert.equal(env.CLAUDE_CODE_USE_GEMINI, '1')
  assert.equal(env.GEMINI_API_KEY, 'gem-live')
  assert.equal(env.GEMINI_MODEL, 'gemini-2.0-flash')
  assert.equal(env.GEMINI_BASE_URL, undefined)
  assert.equal(env.GEMINI_AUTH_MODE, undefined)
  assert.equal(env.OPENAI_API_KEY, undefined)
})

test('legacy openai saved profiles still deserialize and rebuild startup env', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))

  try {
    saveProfileFile(
      profile('openai', {
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
        OPENAI_MODEL: 'gpt-4o',
        OPENAI_API_KEY: 'sk-legacy-live',
      }),
      { cwd: tempDir },
    )

    const persisted = loadProfileFile({ cwd: tempDir })
    assert.notEqual(persisted, null)
    assert.equal(persisted?.profile, 'openai')

    const env = await buildStartupEnvFromProfile({
      persisted,
      processEnv: {},
    })

    assert.equal(env.CLAUDE_CODE_USE_OPENAI, '1')
    assert.equal(env.OPENAI_BASE_URL, 'https://api.openai.com/v1')
    assert.equal(env.OPENAI_MODEL, 'gpt-4o')
    assert.equal(env.OPENAI_API_KEY, 'sk-legacy-live')
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('legacy openai saved profiles preserve OPENAI_API_KEYS during startup rebuild', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))

  try {
    saveProfileFile(
      profile('openai', {
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
        OPENAI_MODEL: 'gpt-4o',
        OPENAI_API_KEYS: 'key-a,key-b',
      }),
      { cwd: tempDir },
    )

    const persisted = loadProfileFile({ cwd: tempDir })
    assert.notEqual(persisted, null)
    assert.equal(persisted?.profile, 'openai')

    const env = await buildStartupEnvFromProfile({
      persisted,
      processEnv: {},
    })

    assert.equal(env.CLAUDE_CODE_USE_OPENAI, '1')
    assert.equal(env.OPENAI_BASE_URL, 'https://api.openai.com/v1')
    assert.equal(env.OPENAI_MODEL, 'gpt-4o')
    assert.equal(env.OPENAI_API_KEYS, 'key-a,key-b')
    assert.equal(env.OPENAI_API_KEY, undefined)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('legacy openai saved profiles let live singular keys override saved pools during startup rebuild', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))

  try {
    saveProfileFile(
      profile('openai', {
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
        OPENAI_MODEL: 'gpt-4o',
        OPENAI_API_KEYS: 'saved-a,saved-b',
      }),
      { cwd: tempDir },
    )

    const persisted = loadProfileFile({ cwd: tempDir })
    assert.notEqual(persisted, null)

    const env = await buildStartupEnvFromProfile({
      persisted,
      processEnv: { OPENAI_API_KEY: 'shell-single' },
    })

    assert.equal(env.OPENAI_API_KEY, 'shell-single')
    assert.equal(env.OPENAI_API_KEYS, undefined)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})
test('legacy openai saved profiles ignore delimiter-only shell OPENAI_API_KEYS during startup rebuild', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))

  try {
    saveProfileFile(
      profile('openai', {
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
        OPENAI_MODEL: 'gpt-4o',
        OPENAI_API_KEYS: 'saved-a,saved-b',
      }),
      { cwd: tempDir },
    )

    const persisted = loadProfileFile({ cwd: tempDir })
    assert.notEqual(persisted, null)

    const env = await buildStartupEnvFromProfile({
      persisted,
      processEnv: { OPENAI_API_KEYS: ', ,' },
    })

    assert.equal(env.OPENAI_API_KEYS, 'saved-a,saved-b')
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})
test('legacy anthropic saved profiles still deserialize and rebuild startup env', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))

  try {
    saveProfileFile(
      profile('anthropic', {
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        ANTHROPIC_MODEL: 'claude-sonnet-4-6',
        ANTHROPIC_API_KEY: 'sk-ant-live',
      }),
      { cwd: tempDir },
    )

    const persisted = loadProfileFile({ cwd: tempDir })
    assert.notEqual(persisted, null)
    assert.equal(persisted?.profile, 'anthropic')

    const env = await buildStartupEnvFromProfile({
      persisted,
      processEnv: {},
    })

    assert.equal(env.CLAUDE_CODE_USE_OPENAI, undefined)
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com')
    assert.equal(env.ANTHROPIC_MODEL, 'claude-sonnet-4-6')
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-live')
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('bedrock persisted profiles load and rebuild the dedicated startup env', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))

  try {
    saveProfileFile(
      profile('bedrock', {
        ANTHROPIC_MODEL: 'claude-sonnet-4-6',
        ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock-proxy.example',
      }),
      { cwd: tempDir },
    )

    const persisted = loadProfileFile({ cwd: tempDir })
    assert.notEqual(persisted, null)
    assert.equal(persisted?.profile, 'bedrock')

    const env = await buildStartupEnvFromProfile({
      persisted,
      processEnv: {},
    })

    assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '1')
    assert.equal(env.ANTHROPIC_MODEL, 'claude-sonnet-4-6')
    assert.equal(
      env.ANTHROPIC_BEDROCK_BASE_URL,
      'https://bedrock-proxy.example',
    )
    assert.equal(env.CLAUDE_CODE_USE_OPENAI, undefined)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('buildStartupEnvFromProfile preserves explicit GitHub provider settings when the legacy file is stale', async () => {
  const processEnv: NodeJS.ProcessEnv = {
    CLAUDE_CODE_USE_GITHUB: '1',
    OPENAI_MODEL: 'github:copilot',
  }

  const env = await buildStartupEnvFromProfile({
    persisted: profile('openai', {
      OPENAI_API_KEY: 'sk-stale',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
    }),
    processEnv,
  })

  assert.equal(env, processEnv)
  assert.equal(env.CLAUDE_CODE_USE_GITHUB, '1')
  assert.equal(env.OPENAI_MODEL, 'github:copilot')
  assert.equal(env.CLAUDE_CODE_USE_OPENAI, undefined)
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.OPENAI_BASE_URL, undefined)
})

test('applySavedProfileToCurrentSession can switch away from GitHub provider env', async () => {
  const { applySavedProfileToCurrentSession } = await importFreshProviderProfileModule()
  const processEnv: NodeJS.ProcessEnv = {
    CLAUDE_CODE_USE_GITHUB: '1',
    OPENAI_MODEL: 'github:copilot',
  }

  const error = await applySavedProfileToCurrentSession({
    profileFile: profile('ollama', {
      OPENAI_BASE_URL: 'http://localhost:11434/v1',
      OPENAI_MODEL: 'llama3.1:8b',
    }),
    processEnv,
  })

  assert.equal(error, null)
  assert.equal(processEnv.CLAUDE_CODE_USE_GITHUB, undefined)
  assert.equal(processEnv.CLAUDE_CODE_USE_OPENAI, '1')
  assert.equal(processEnv.OPENAI_BASE_URL, 'http://localhost:11434/v1')
  assert.equal(processEnv.OPENAI_MODEL, 'llama3.1:8b')
  assert.equal(Object.hasOwn(processEnv, 'OPENAI_API_KEY'), false)
})

test('applySavedProfileToCurrentSession replaces empty active OpenAI key for Codex OAuth', async () => {
  const { applySavedProfileToCurrentSession } = await importFreshProviderProfileModule()
  const processEnv: NodeJS.ProcessEnv = {
    CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED: '1',
    CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID: 'provider_codex_oauth',
    CLAUDE_CODE_USE_OPENAI: '1',
    OPENAI_BASE_URL: DEFAULT_CODEX_BASE_URL,
    OPENAI_MODEL: 'codexplan',
    OPENAI_API_KEY: '',
  }

  const error = await applySavedProfileToCurrentSession({
    profileFile: profile('codex', {
      OPENAI_BASE_URL: DEFAULT_CODEX_BASE_URL,
      OPENAI_MODEL: 'codexplan',
      CHATGPT_ACCOUNT_ID: 'acct_oauth',
      CODEX_CREDENTIAL_SOURCE: 'oauth',
    }),
    processEnv,
  })

  assert.equal(error, null)
  assert.equal(processEnv.CLAUDE_CODE_USE_OPENAI, '1')
  assert.equal(processEnv.OPENAI_BASE_URL, DEFAULT_CODEX_BASE_URL)
  assert.equal(processEnv.OPENAI_MODEL, 'codexplan')
  assert.equal(Object.hasOwn(processEnv, 'OPENAI_API_KEY'), false)
  assert.equal(processEnv.CHATGPT_ACCOUNT_ID, 'acct_oauth')
  assert.equal(Object.hasOwn(processEnv, 'CODEX_API_KEY'), false)
})

test('buildStartupEnvFromProfile preserves plural-profile env when the legacy file is stale', async () => {
  // Regression: a user saves a provider via /provider (plural system).
  // addProviderProfile does NOT sync the legacy .openclaude-profile.json,
  // so the legacy file retains whatever it had from an earlier setup (e.g.
  // OpenAI defaults). At startup, applyActiveProviderProfileFromConfig()
  // correctly applies the active plural profile (Moonshot) first, marking
  // env with CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED=1. The legacy-file
  // load must NOT overwrite that env — it previously did, surfacing as
  // "banner shows the wrong provider / model".
  const processEnv = {
    CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED: '1',
    CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID: 'saved_moonshot',
    CLAUDE_CODE_USE_OPENAI: '1',
    OPENAI_BASE_URL: 'https://api.moonshot.ai/v1',
    OPENAI_MODEL: 'kimi-k2.6',
  }

  const env = await buildStartupEnvFromProfile({
    // Stale legacy file — points at SambaNova, but user's active plural
    // profile is Moonshot and was just applied.
    persisted: profile('openai', {
      OPENAI_API_KEY: 'sk-stale',
      OPENAI_MODEL: 'Meta-Llama-3.1-70B-Instruct',
      OPENAI_BASE_URL: 'https://api.sambanova.ai/v1',
    }),
    processEnv,
  })

  assert.equal(env, processEnv)
  assert.equal(env.OPENAI_BASE_URL, 'https://api.moonshot.ai/v1')
  assert.equal(env.OPENAI_MODEL, 'kimi-k2.6')
  // Plural markers are retained — downstream code uses them to verify the
  // env still belongs to the profile it was applied from.
  assert.equal(env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED, '1')
  assert.equal(env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID, 'saved_moonshot')
})

test('buildStartupEnvFromProfile ignores the legacy file when startup already has concrete env', async () => {
  const processEnv: NodeJS.ProcessEnv = {
    CLAUDE_CODE_USE_OPENAI: '1',
    OPENAI_BASE_URL: 'https://api.moonshot.ai/v1',
    OPENAI_MODEL: 'kimi-k2.6',
  }

  const env = await buildStartupEnvFromProfile({
    persisted: profile('openai', {
      OPENAI_API_KEY: 'sk-stale',
      OPENAI_MODEL: 'Meta-Llama-3.1-70B-Instruct',
      OPENAI_BASE_URL: 'https://api.sambanova.ai/v1',
    }),
    processEnv,
  })

  assert.equal(env, processEnv)
  assert.equal(env.OPENAI_BASE_URL, 'https://api.moonshot.ai/v1')
  assert.equal(env.OPENAI_MODEL, 'kimi-k2.6')
  assert.equal(env.OPENAI_API_KEY, undefined)
})

test('buildStartupEnvFromProfile falls back to legacy file when plural system has not applied', async () => {
  // Counter-example: first-run user with only the legacy file (no plural
  // active profile yet). The legacy file is the correct source, so the
  // load must proceed as before.
  const processEnv = {
    CLAUDE_CODE_USE_OPENAI: '1',
  }

  const env = await buildStartupEnvFromProfile({
    persisted: profile('openai', {
      OPENAI_API_KEY: 'sk-legacy',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
    }),
    processEnv,
  })

  assert.notEqual(env, processEnv)
  assert.equal(env.OPENAI_API_KEY, 'sk-legacy')
  assert.equal(env.OPENAI_BASE_URL, 'https://api.openai.com/v1')
  assert.equal(env.OPENAI_MODEL, 'gpt-4o')
})

test('buildStartupEnvFromProfile falls back to the legacy file when startup env is incomplete', async () => {
  const processEnv = {
    CLAUDE_CODE_USE_OPENAI: '1',
  }

  const env = await buildStartupEnvFromProfile({
    persisted: profile('openai', {
      OPENAI_API_KEY: 'sk-legacy',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
    }),
    processEnv,
  })

  assert.notEqual(env, processEnv)
  assert.equal(env.OPENAI_API_KEY, 'sk-legacy')
  assert.equal(env.OPENAI_BASE_URL, 'https://api.openai.com/v1')
  assert.equal(env.OPENAI_MODEL, 'gpt-4o')
})

test('buildStartupEnvFromProfile ignores falsey provider flags when deciding whether startup env is concrete', async () => {
  const processEnv = {
    CLAUDE_CODE_USE_OPENAI: '0',
    OPENAI_BASE_URL: 'https://api.stale.example/v1',
    OPENAI_MODEL: 'stale-model',
  }

  const env = await buildStartupEnvFromProfile({
    persisted: profile('openai', {
      OPENAI_API_KEY: 'sk-legacy',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
    }),
    processEnv,
  })

  assert.notEqual(env, processEnv)
  assert.equal(env.OPENAI_API_KEY, 'sk-legacy')
})

test('buildStartupEnvFromProfile treats explicit falsey provider flags as user intent', async () => {
  const processEnv = {
    CLAUDE_CODE_USE_OPENAI: '0',
  }

  const env = await buildStartupEnvFromProfile({
    persisted: profile('gemini', {
      GEMINI_API_KEY: 'gem-persisted',
      GEMINI_MODEL: 'gemini-2.5-flash',
    }),
    processEnv,
  })

  assert.equal(env.CLAUDE_CODE_USE_OPENAI, undefined)
  assert.equal(env.CLAUDE_CODE_USE_GEMINI, '1')
  assert.equal(env.GEMINI_API_KEY, 'gem-persisted')
  assert.equal(env.GEMINI_MODEL, 'gemini-2.5-flash')
  assert.equal(env.GEMINI_BASE_URL, 'https://generativelanguage.googleapis.com/v1beta/openai')
  assert.equal(env.GEMINI_AUTH_MODE, 'api-key')
})

test('maskSecretForDisplay preserves only a short prefix and suffix', () => {
  assert.equal(maskSecretForDisplay('sk-secret-12345678'), 'sk-...678')
  assert.equal(maskSecretForDisplay('AIzaSecret12345678'), 'AIz...678')
})

test('redactSecretValueForDisplay masks poisoned display fields that equal configured secrets', () => {
  const apiKey = 'sk-secret-12345678'
  const authHeaderValue = 'hicap-header-secret'
  const routeApiKey = 'gsk-route-secret-value'

  assert.equal(
    redactSecretValueForDisplay(apiKey, { OPENAI_API_KEY: apiKey }),
    'sk-...678',
  )
  assert.equal(
    redactSecretValueForDisplay(authHeaderValue, {
      OPENAI_AUTH_HEADER_VALUE: authHeaderValue,
    }),
    'hic...ret',
  )
  assert.equal(
    redactSecretValueForDisplay(routeApiKey, { GROQ_API_KEY: routeApiKey }),
    'gsk...lue',
  )
  assert.equal(
    redactSecretValueForDisplay('gpt-4o', { OPENAI_API_KEY: apiKey }),
    'gpt-4o',
  )
  assert.equal(
    redactSecretValueForDisplay('gpt-4o', { OPENAI_MODEL: 'gpt-4o' }),
    'gpt-4o',
  )
})

test('redactSecretValueForDisplay collects common secret env suffixes', () => {
  const secretEnvCases = [
    ['ROUTE_API_KEY', 'route-api-secret-value'],
    ['ROUTE_AUTH_HEADER_VALUE', 'route-auth-header-secret'],
    ['SERVICE_PASSWORD', 'database-password-secret'],
    ['SERVICE_SECRET', 'service-secret-value'],
    ['AWS_SECRET_ACCESS_KEY', 'aws-secret-access-value'],
    ['OAUTH_SECRET_KEY', 'oauth-secret-key-value'],
    ['GITHUB_TOKEN', 'github-token-secret'],
  ] as const

  for (const [key, value] of secretEnvCases) {
    const source = { [key]: value }

    assert.equal(
      redactSecretValueForDisplay(value, source),
      maskSecretForDisplay(value),
    )
    assert.equal(sanitizeProviderConfigValue(value, source), undefined)
  }

  assert.equal(
    redactSecretValueForDisplay('gpt-4o', { OPENAI_MODEL: 'gpt-4o' }),
    'gpt-4o',
  )
  assert.equal(
    sanitizeProviderConfigValue('gpt-4o', { OPENAI_MODEL: 'gpt-4o' }),
    'gpt-4o',
  )
})

test('sanitizeProviderConfigValue drops secret-like poisoned values', () => {
  const apiKey = 'sk-secret-12345678'

  assert.equal(
    sanitizeProviderConfigValue(apiKey, { OPENAI_API_KEY: apiKey }),
    undefined,
  )
  assert.equal(
    sanitizeProviderConfigValue('gpt-4o', { OPENAI_API_KEY: apiKey }),
    'gpt-4o',
  )
})

test('openai profiles ignore codex shell transport hints', () => {
  const env = buildOpenAIProfileEnv({
    goal: 'balanced',
    apiKey: 'sk-live',
    processEnv: {
      OPENAI_BASE_URL: 'https://chatgpt.com/backend-api/codex',
      OPENAI_MODEL: 'codexplan',
      OPENAI_API_KEY: 'sk-live',
    },
  })

  assert.deepEqual(env, {
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
    OPENAI_MODEL: 'gpt-5.5',
    OPENAI_API_KEY: 'sk-live',
  })
})

test('openai profiles keep shell base and model when shell format is responses', () => {
  const env = buildOpenAIProfileEnv({
    goal: 'balanced',
    processEnv: {
      OPENAI_BASE_URL: 'https://shell.example/v1',
      OPENAI_MODEL: 'shell-model',
      OPENAI_API_FORMAT: 'responses',
      OPENAI_API_KEY: 'sk-live',
    },
  })

  assert.equal(env?.OPENAI_BASE_URL, 'https://shell.example/v1')
  assert.equal(env?.OPENAI_MODEL, 'shell-model')
  assert.equal(env?.OPENAI_API_KEY, 'sk-live')
})

test('openai profiles persist Azure-style routing from the shell environment', () => {
  const env = buildOpenAIProfileEnv({
    goal: 'balanced',
    processEnv: {
      OPENAI_BASE_URL: 'https://azure.example/openai/v1',
      OPENAI_API_KEY: 'azure-key',
      OPENAI_AZURE_STYLE: '1',
    },
  })

  assert.equal(env?.OPENAI_AZURE_STYLE, '1')
})

test('openai profiles use the first model from a semicolon-separated list', () => {
  const env = buildOpenAIProfileEnv({
    goal: 'balanced',
    apiKey: 'sk-live',
    model: 'gpt-5.4; gpt-5.4-mini',
    processEnv: {},
  })

  assert.deepEqual(env, {
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
    OPENAI_MODEL: 'gpt-5.4',
    OPENAI_API_KEY: 'sk-live',
  })
})

test('openai profiles ignore poisoned shell model and base url values', () => {
  const env = buildOpenAIProfileEnv({
    goal: 'balanced',
    apiKey: 'sk-live',
    processEnv: {
      OPENAI_BASE_URL: 'sk-live',
      OPENAI_MODEL: 'sk-live',
      OPENAI_API_KEY: 'sk-live',
    },
  })

  assert.deepEqual(env, {
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
    OPENAI_MODEL: 'gpt-5.5',
    OPENAI_API_KEY: 'sk-live',
  })
})

test('openai profiles accept OPENAI_API_KEYS without OPENAI_API_KEY', () => {
  const env = buildOpenAIProfileEnv({
    goal: 'balanced',
    model: 'gpt-5.4',
    processEnv: {
      OPENAI_API_KEYS: 'key-a, key-b',
    },
  })

  assert.equal(env?.OPENAI_MODEL, 'gpt-5.4')
  assert.equal(env?.OPENAI_API_KEYS, 'key-a,key-b')
  assert.equal(env?.OPENAI_API_KEY, undefined)
})

test('openai profiles let explicit credentials replace invalid shell pools', () => {
  const env = buildOpenAIProfileEnv({
    goal: 'balanced',
    model: 'gpt-5.4',
    apiKey: 'real-key',
    processEnv: {
      OPENAI_API_KEYS: 'SUA_CHAVE',
      OPENAI_API_KEY: 'SUA_CHAVE',
    },
  })

  assert.equal(env?.OPENAI_API_KEY, 'real-key')
  assert.equal(env?.OPENAI_API_KEYS, undefined)
})
test('openai profiles reject placeholder values inside pooled credentials', () => {
  const env = buildOpenAIProfileEnv({
    goal: 'balanced',
    model: 'gpt-5.4',
    apiKey: 'key-a,SUA_CHAVE',
    processEnv: {},
  })

  assert.equal(env, null)
})

test('openai profiles reject invalid OPENAI_API_KEYS instead of falling back', () => {
  const env = buildOpenAIProfileEnv({
    goal: 'balanced',
    model: 'gpt-5.4',
    processEnv: {
      OPENAI_API_KEYS: 'key-a,SUA_CHAVE',
      OPENAI_API_KEY: 'key-single',
    },
  })

  assert.equal(env, null)
})

test('openai profiles store comma-separated explicit keys as a pool', () => {
  const env = buildOpenAIProfileEnv({
    goal: 'balanced',
    model: 'gpt-5.4',
    apiKey: 'key-a, key-b',
    processEnv: {},
  })

  assert.equal(env?.OPENAI_API_KEYS, 'key-a,key-b')
  assert.equal(env?.OPENAI_API_KEY, undefined)
})

test('openai profiles normalize multi-model profile values to the primary model', () => {
  const env = buildOpenAIProfileEnv({
    goal: 'balanced',
    apiKey: 'sk-live',
    model: 'deepseek-v4-flash, deepseek-v4-pro, deepseek-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    processEnv: {},
  })

  assert.deepEqual(env, {
    OPENAI_BASE_URL: 'https://api.deepseek.com/v1',
    OPENAI_MODEL: 'deepseek-v4-flash',
    OPENAI_API_KEY: 'sk-live',
  })
})

test('openai launch preserves invalid live pooled credentials for launch validation', async () => {
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_API_KEYS: 'saved-a,saved-b',
    }),
    goal: 'balanced',
    processEnv: {
      OPENAI_API_KEYS: 'key-a,SUA_CHAVE',
      OPENAI_API_KEY: 'shell-single',
    },
  })

  assert.equal(env.OPENAI_API_KEYS, 'key-a,SUA_CHAVE')
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(hasInvalidOpenAICredentialPool(env.OPENAI_API_KEYS), true)
})
test('openai launch lets a live singular key override a saved pool', async () => {
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_API_KEYS: 'saved-a,saved-b',
    }),
    goal: 'balanced',
    processEnv: {
      OPENAI_API_KEY: 'shell-single',
    },
  })

  assert.equal(env.OPENAI_API_KEY, 'shell-single')
  assert.equal(env.OPENAI_API_KEYS, undefined)
})
test('startup env ignores poisoned persisted openai model and base url', async () => {
  const env = await buildStartupEnvFromProfile({
    persisted: profile('openai', {
      OPENAI_API_KEY: 'sk-live',
      OPENAI_MODEL: 'sk-live',
      OPENAI_BASE_URL: 'sk-live',
    }),
    processEnv: {},
  })

  assert.equal(env.CLAUDE_CODE_USE_OPENAI, '1')
  assert.equal(env.OPENAI_API_KEY, 'sk-live')
  assert.equal(env.OPENAI_MODEL, 'gpt-5.5')
  assert.equal(env.OPENAI_BASE_URL, 'https://api.openai.com/v1')
})

test('startup env normalizes a semicolon-separated persisted openai model list', async () => {
  const env = await buildStartupEnvFromProfile({
    persisted: profile('openai', {
      OPENAI_API_KEY: 'sk-live',
      OPENAI_MODEL: 'gpt-5.4; gpt-5.4-mini',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
    }),
    processEnv: {},
  })

  assert.equal(env.CLAUDE_CODE_USE_OPENAI, '1')
  assert.equal(env.OPENAI_API_KEY, 'sk-live')
  assert.equal(env.OPENAI_MODEL, 'gpt-5.4')
  assert.equal(env.OPENAI_BASE_URL, 'https://api.openai.com/v1')
})

test('startup env preserves persisted openai context-window override', async () => {
  const override = JSON.stringify({ 'gpt-4o': 1_000_000 })
  const env = await buildStartupEnvFromProfile({
    persisted: profile('openai', {
      OPENAI_API_KEY: 'sk-live',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS: override,
    }),
    processEnv: {},
  })

  assert.equal(env.CLAUDE_CODE_USE_OPENAI, '1')
  assert.equal(env.OPENAI_MODEL, 'gpt-4o')
  assert.equal(env.OPENAI_BASE_URL, 'https://api.openai.com/v1')
  assert.equal(env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS, override)
})

test('auto profile falls back to openai when no viable ollama model exists', () => {
  assert.equal(selectAutoProfile(null), 'openai')
  assert.equal(selectAutoProfile('qwen2.5-coder:7b'), 'ollama')
})

// ── Atomic Chat profile tests ────────────────────────────────────────────────

test('atomic-chat profiles never persist openai api keys', () => {
  const env = buildAtomicChatProfileEnv('some-local-model', {
    getAtomicChatChatBaseUrl: () => 'http://127.0.0.1:1337/v1',
  })

  assert.deepEqual(env, {
    OPENAI_BASE_URL: 'http://127.0.0.1:1337/v1',
    OPENAI_MODEL: 'some-local-model',
  })
  assert.equal('OPENAI_API_KEY' in env, false)
})

test('atomic-chat profiles respect custom base url', () => {
  const env = buildAtomicChatProfileEnv('my-model', {
    baseUrl: 'http://192.168.1.100:1337',
    getAtomicChatChatBaseUrl: (baseUrl?: string) =>
      baseUrl ? `${baseUrl}/v1` : 'http://127.0.0.1:1337/v1',
  })

  assert.equal(env.OPENAI_BASE_URL, 'http://192.168.1.100:1337/v1')
  assert.equal(env.OPENAI_MODEL, 'my-model')
})

test('matching persisted atomic-chat env is reused for atomic-chat launch', async () => {
  const env = await buildLaunchEnv({
    profile: 'atomic-chat',
    persisted: profile('atomic-chat', {
      OPENAI_BASE_URL: 'http://127.0.0.1:1337/v1',
      OPENAI_MODEL: 'llama-3.1-8b',
    }),
    goal: 'balanced',
    processEnv: {},
    getAtomicChatChatBaseUrl: () => 'http://127.0.0.1:1337/v1',
    resolveAtomicChatDefaultModel: async () => 'other-model',
  })

  assert.equal(env.OPENAI_BASE_URL, 'http://127.0.0.1:1337/v1')
  assert.equal(env.OPENAI_MODEL, 'llama-3.1-8b')
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.CODEX_API_KEY, undefined)
})

test('atomic-chat launch ignores mismatched persisted openai env', async () => {
  const env = await buildLaunchEnv({
    profile: 'atomic-chat',
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_API_KEY: 'sk-persisted',
    }),
    goal: 'balanced',
    processEnv: {
      OPENAI_API_KEY: 'sk-live',
      CODEX_API_KEY: 'codex-live',
      CHATGPT_ACCOUNT_ID: 'acct_live',
    },
    getAtomicChatChatBaseUrl: () => 'http://127.0.0.1:1337/v1',
    resolveAtomicChatDefaultModel: async () => 'local-model',
  })

  assert.equal(env.OPENAI_BASE_URL, 'http://127.0.0.1:1337/v1')
  assert.equal(env.OPENAI_MODEL, 'local-model')
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.CODEX_API_KEY, undefined)
  assert.equal(env.CHATGPT_ACCOUNT_ID, undefined)
})

test('openai launch preserves persisted Concentrate dedicated credentials across restart', async () => {
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://api.concentrate.ai/v1',
      OPENAI_MODEL: 'deepseek-v4-flash-0731',
      OPENAI_API_KEY: 'concentrate-secret-key',
      CONCENTRATE_API_KEY: 'concentrate-secret-key',
    }),
    goal: 'coding',
    processEnv: {},
  })

  assert.equal(env.OPENAI_BASE_URL, 'https://api.concentrate.ai/v1')
  assert.equal(env.OPENAI_MODEL, 'deepseek-v4-flash-0731')
  assert.equal(env.OPENAI_API_KEY, 'concentrate-secret-key')
  assert.equal(env.CONCENTRATE_API_KEY, 'concentrate-secret-key')
  assert.equal(env.CLAUDE_CODE_PROVIDER_ROUTE_ID, 'concentrate')
})

test('legacy generic OpenAI Concentrate profiles keep their credential generic', async () => {
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://api.concentrate.ai/v1',
      OPENAI_MODEL: 'deepseek-v4-flash-0731',
      OPENAI_API_KEY: 'concentrate-secret-key',
    }),
    goal: 'coding',
    processEnv: {},
  })

  assert.equal(env.CLAUDE_CODE_PROVIDER_ROUTE_ID, 'concentrate')
  assert.equal(env.OPENAI_API_KEY, 'concentrate-secret-key')
  assert.equal(env.CONCENTRATE_API_KEY, undefined)
  assert.equal(
    resolveRouteCredentialValue({
      routeId: 'concentrate',
      processEnv: env,
      baseUrl: env.OPENAI_BASE_URL,
    }),
    'concentrate-secret-key',
  )
})

test('openai launch keeps a generic Concentrate credential generic', async () => {
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://api.concentrate.ai/v1',
      OPENAI_MODEL: 'deepseek-v4-flash-0731',
      CLAUDE_CODE_PROVIDER_ROUTE_ID: 'concentrate',
    }),
    goal: 'coding',
    processEnv: {
      OPENAI_API_KEY: 'generic-openai-key',
    },
  })

  assert.equal(env.CONCENTRATE_API_KEY, undefined)
  assert.equal(
    resolveRouteCredentialValue({
      routeId: 'concentrate',
      processEnv: env,
      baseUrl: env.OPENAI_BASE_URL,
    }),
    'generic-openai-key',
  )
})

test('generic Concentrate profile lets a rotated OpenAI key override its saved key', async () => {
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://api.concentrate.ai/v1',
      OPENAI_MODEL: 'deepseek-v4-flash-0731',
      OPENAI_API_KEY: 'saved-generic-key',
    }),
    goal: 'coding',
    processEnv: {
      OPENAI_API_KEY: 'rotated-generic-key',
    },
  })

  assert.equal(env.OPENAI_API_KEY, 'rotated-generic-key')
  assert.equal(env.CONCENTRATE_API_KEY, undefined)
  assert.equal(
    resolveRouteCredentialValue({
      routeId: 'concentrate',
      processEnv: env,
      baseUrl: env.OPENAI_BASE_URL,
    }),
    'rotated-generic-key',
  )
})

test('openai launch withholds ambient Concentrate credentials from a keyless proxy profile on restart', async () => {
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      CLAUDE_CODE_PROVIDER_ROUTE_ID: 'concentrate',
      OPENAI_BASE_URL: 'https://proxy.example.com/v1',
      OPENAI_MODEL: 'deepseek-v4-flash-0731',
    }),
    goal: 'coding',
    processEnv: {
      OPENAI_BASE_URL: 'https://proxy.example.com/v1',
      OPENAI_API_KEY: 'ambient-concentrate-key',
      CONCENTRATE_API_KEY: 'ambient-concentrate-key',
    },
  })

  assert.equal(env.CLAUDE_CODE_PROVIDER_ROUTE_ID, 'concentrate')
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.CONCENTRATE_API_KEY, undefined)

  const canonical = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      CLAUDE_CODE_PROVIDER_ROUTE_ID: 'concentrate',
      OPENAI_BASE_URL: 'https://api.concentrate.ai/v1',
      OPENAI_MODEL: 'deepseek-v4-flash-0731',
    }),
    goal: 'coding',
    processEnv: {
      OPENAI_BASE_URL: 'https://api.concentrate.ai/v1',
      OPENAI_API_KEY: 'ambient-concentrate-key',
      CONCENTRATE_API_KEY: 'ambient-concentrate-key',
    },
  })
  assert.equal(canonical.OPENAI_API_KEY, 'ambient-concentrate-key')
  assert.equal(canonical.CONCENTRATE_API_KEY, 'ambient-concentrate-key')
})

test('openai launch withholds ambient LLMTR credentials from a keyless proxy profile on restart', async () => {
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      CLAUDE_CODE_PROVIDER_ROUTE_ID: 'llmtr',
      OPENAI_BASE_URL: 'https://proxy.example.com/v1',
      OPENAI_MODEL: 'proxy-model',
    }),
    goal: 'coding',
    processEnv: {
      OPENAI_BASE_URL: 'https://proxy.example.com/v1',
      OPENAI_API_KEY: 'ambient-llmtr-key',
      LLMTR_API_KEY: 'ambient-llmtr-key',
    },
  })

  assert.equal(env.CLAUDE_CODE_PROVIDER_ROUTE_ID, 'llmtr')
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.LLMTR_API_KEY, undefined)

  const canonical = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      CLAUDE_CODE_PROVIDER_ROUTE_ID: 'llmtr',
      OPENAI_BASE_URL: 'https://llmtr.com/v1',
      OPENAI_MODEL: 'deepseek/deepseek-v4-flash',
    }),
    goal: 'coding',
    processEnv: {
      OPENAI_BASE_URL: 'https://llmtr.com/v1',
      LLMTR_API_KEY: 'ambient-llmtr-key',
    },
  })

  assert.equal(canonical.OPENAI_API_KEY, undefined)
  assert.equal(canonical.LLMTR_API_KEY, 'ambient-llmtr-key')
})

test('openai launch withholds ambient Command Code credentials from a keyless proxy profile on restart', async () => {
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      CLAUDE_CODE_PROVIDER_ROUTE_ID: 'commandcode',
      OPENAI_BASE_URL: 'https://proxy.example.com/v1',
      OPENAI_MODEL: 'proxy-model',
    }),
    goal: 'coding',
    processEnv: {
      OPENAI_BASE_URL: 'https://proxy.example.com/v1',
      OPENAI_API_KEY: 'ambient-cmd-key',
      CMD_API_KEY: 'ambient-cmd-key',
    },
  })

  assert.equal(env.CLAUDE_CODE_PROVIDER_ROUTE_ID, 'commandcode')
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.CMD_API_KEY, undefined)

  const canonical = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      CLAUDE_CODE_PROVIDER_ROUTE_ID: 'commandcode',
      OPENAI_BASE_URL: 'https://api.commandcode.ai/provider/v1',
      OPENAI_MODEL: 'deepseek/deepseek-v4-flash',
    }),
    goal: 'coding',
    processEnv: {
      OPENAI_BASE_URL: 'https://api.commandcode.ai/provider/v1',
      CMD_API_KEY: 'ambient-cmd-key',
    },
  })

  assert.equal(canonical.OPENAI_API_KEY, undefined)
  assert.equal(canonical.CMD_API_KEY, 'ambient-cmd-key')
})

test('openai launch preserves a canonical Command Code route supplied through OPENAI_API_BASE', async () => {
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: null,
    goal: 'coding',
    processEnv: {
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_API_BASE: 'https://api.commandcode.ai/provider/v1',
      OPENAI_MODEL: 'deepseek/deepseek-v4-flash',
      CMD_API_KEY: 'live-commandcode-key',
    },
  })

  assert.equal(
    env.OPENAI_BASE_URL,
    'https://api.commandcode.ai/provider/v1',
  )
  assert.equal(env.CLAUDE_CODE_PROVIDER_ROUTE_ID, 'commandcode')
  assert.equal(env.CMD_API_KEY, 'live-commandcode-key')
})

test('openai launch preserves distinct persisted Command Code credentials', async () => {
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      CLAUDE_CODE_PROVIDER_ROUTE_ID: 'commandcode',
      OPENAI_BASE_URL: 'https://api.commandcode.ai/provider/v1',
      OPENAI_MODEL: 'deepseek/deepseek-v4-flash',
      CMD_API_KEY: 'primary-commandcode-key',
      COMMANDCODE_API_KEY: 'fallback-commandcode-key',
    }),
    goal: 'coding',
    processEnv: {},
  })

  assert.equal(env.CMD_API_KEY, 'primary-commandcode-key')
  assert.equal(env.COMMANDCODE_API_KEY, 'fallback-commandcode-key')
})

test('openai launch accepts the official Command Code credential variable', async () => {
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: null,
    goal: 'coding',
    processEnv: {
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_BASE_URL: 'https://api.commandcode.ai/provider/v1',
      OPENAI_MODEL: 'deepseek/deepseek-v4-flash',
      COMMAND_CODE_API_KEY: 'official-command-code-key',
    },
  })

  assert.equal(env.COMMAND_CODE_API_KEY, 'official-command-code-key')
})

test('openai launch does not migrate an unrelated persisted OpenAI key into Command Code', async () => {
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_API_KEY: 'persisted-openai-key',
    }),
    goal: 'coding',
    processEnv: {
      OPENAI_BASE_URL: 'https://api.commandcode.ai/provider/v1',
      OPENAI_MODEL: 'deepseek/deepseek-v4-flash',
      CMD_API_KEY: 'live-commandcode-key',
    },
  })

  assert.equal(env.CMD_API_KEY, 'live-commandcode-key')
})

test('openai launch still migrates a legacy canonical Command Code profile key', async () => {
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://api.commandcode.ai/provider/v1',
      OPENAI_MODEL: 'deepseek/deepseek-v4-flash',
      OPENAI_API_KEY: 'legacy-commandcode-key',
    }),
    goal: 'coding',
    processEnv: {
      OPENAI_BASE_URL: 'https://api.commandcode.ai/provider/v1',
    },
  })

  assert.equal(env.CMD_API_KEY, 'legacy-commandcode-key')
})

test('openai launch removes a legacy persisted Concentrate key from a noncanonical URL', async () => {
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      CLAUDE_CODE_PROVIDER_ROUTE_ID: 'concentrate',
      OPENAI_BASE_URL: 'https://api.concentrate.ai/staging/v1',
      OPENAI_MODEL: 'deepseek-v4-flash-0731',
      CONCENTRATE_API_KEY: 'legacy-concentrate-key',
    }),
    goal: 'coding',
    processEnv: {},
  })

  assert.equal(env.CLAUDE_CODE_PROVIDER_ROUTE_ID, 'concentrate')
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.CONCENTRATE_API_KEY, undefined)
})

test('openai launch removes legacy generic credentials from a noncanonical Concentrate URL', async () => {
  for (const [credentialEnvVar, credential] of [
    ['OPENAI_API_KEY', 'legacy-concentrate-key'],
    ['OPENAI_API_KEYS', 'legacy-concentrate-key-1,legacy-concentrate-key-2'],
  ] as const) {
    const env = await buildLaunchEnv({
      profile: 'openai',
      persisted: profile('openai', {
        CLAUDE_CODE_PROVIDER_ROUTE_ID: 'concentrate',
        OPENAI_BASE_URL: 'https://api.concentrate.ai/staging/v1',
        OPENAI_MODEL: 'deepseek-v4-flash-0731',
        [credentialEnvVar]: credential,
      }),
      goal: 'coding',
      processEnv: {},
    })

    assert.equal(env.OPENAI_API_KEY, undefined)
    assert.equal(env.OPENAI_API_KEYS, undefined)
    assert.equal(env.CONCENTRATE_API_KEY, undefined)
  }
})

test('API Route saved profile relaunch uses persisted generic key/model over ambient dedicated state', async () => {
  const env = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      CLAUDE_CODE_PROVIDER_ROUTE_ID: 'api-route',
      OPENAI_BASE_URL: 'https://global.api-route.com/v1',
      OPENAI_MODEL: 'saved-api-route-model',
      OPENAI_API_KEY: 'saved-api-route-key',
    }),
    goal: 'balanced',
    processEnv: {
      API_ROUTE_API_KEY: 'ambient-api-route-key',
      API_ROUTE_MODEL: 'ambient-api-route-model',
    },
  })

  assert.equal(env.API_ROUTE_API_KEY, undefined)
  assert.equal(env.API_ROUTE_MODEL, undefined)
  assert.equal(env.OPENAI_BASE_URL, 'https://global.api-route.com/v1')
  assert.equal(env.OPENAI_MODEL, 'saved-api-route-model')
  assert.equal(env.OPENAI_API_KEY, 'saved-api-route-key')
  assert.equal(
    resolveRouteCredentialValue({
      routeId: 'api-route',
      baseUrl: env.OPENAI_BASE_URL,
      processEnv: env,
    }),
    'saved-api-route-key',
  )
})

test('buildStartupEnvFromProfile preserves Concentrate env-only setup over a saved profile', async () => {
  const env = await buildStartupEnvFromProfile({
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_API_KEY: 'sk-persisted',
    }),
    goal: 'balanced',
    processEnv: {
      CONCENTRATE_API_KEY: 'concentrate-env-only-key',
      CONCENTRATE_BASE_URL: 'https://api.concentrate.ai/v1',
      CONCENTRATE_MODEL: 'claude-sonnet-5',
    },
  })

  assert.equal(env.CONCENTRATE_API_KEY, 'concentrate-env-only-key')
  assert.equal(env.CONCENTRATE_BASE_URL, 'https://api.concentrate.ai/v1')
  assert.equal(env.CONCENTRATE_MODEL, 'claude-sonnet-5')
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(resolveActiveRouteIdFromEnv(env), 'concentrate')
})

test('applyStartupEnvFromProfile preserves API Route env-only setup over a saved profile', async () => {
  const processEnv: NodeJS.ProcessEnv = {
    API_ROUTE_API_KEY: 'api-route-env-only-key',
    API_ROUTE_MODEL: 'api-route-env-only-model',
  }

  const error = await applyStartupEnvFromProfile({
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_API_KEY: 'sk-persisted',
    }),
    processEnv,
  })

  assert.equal(error, null)
  assert.equal(processEnv.API_ROUTE_API_KEY, 'api-route-env-only-key')
  assert.equal(processEnv.API_ROUTE_MODEL, 'api-route-env-only-model')
  assert.equal(processEnv.OPENAI_BASE_URL, undefined)
  assert.equal(processEnv.OPENAI_API_KEY, undefined)
  assert.equal(resolveActiveRouteIdFromEnv(processEnv), 'api-route')
})

test('applyStartupEnvFromProfile preserves API Route key-only descriptor-default intent', async () => {
  const processEnv: NodeJS.ProcessEnv = {
    API_ROUTE_API_KEY: 'api-route-env-only-key',
  }

  const error = await applyStartupEnvFromProfile({
    persisted: profile('openai', {
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_API_KEY: 'sk-persisted',
    }),
    processEnv,
  })

  assert.equal(error, null)
  assert.equal(processEnv.API_ROUTE_API_KEY, 'api-route-env-only-key')
  assert.equal(processEnv.OPENAI_MODEL, undefined)
  assert.equal(resolveActiveRouteIdFromEnv(processEnv), 'api-route')
  assert.equal(await getProviderValidationError(processEnv), null)
})

test('buildConcentrateProfileEnv prefers CONCENTRATE_MODEL over OPENAI_MODEL', () => {
  const env = buildConcentrateProfileEnv({
    apiKey: 'concentrate-secret-key',
    processEnv: {
      CONCENTRATE_MODEL: 'claude-sonnet-5',
      OPENAI_MODEL: 'gpt-4o',
    },
  })

  assert.ok(env)
  assert.equal(env?.OPENAI_MODEL, 'claude-sonnet-5')
  assert.equal(env?.CLAUDE_CODE_PROVIDER_ROUTE_ID, 'concentrate')
})

test('buildConcentrateProfileEnv reads CONCENTRATE_BASE_URL override', () => {
  const env = buildConcentrateProfileEnv({
    apiKey: 'concentrate-secret-key',
    processEnv: {
      CONCENTRATE_BASE_URL: 'https://api.concentrate.ai/v1',
    },
  })

  assert.ok(env)
  assert.equal(env?.OPENAI_BASE_URL, 'https://api.concentrate.ai/v1')
})

test('buildConcentrateProfileEnv refuses to serialize its credential for a noncanonical URL', () => {
  const env = buildConcentrateProfileEnv({
    apiKey: 'concentrate-secret-key',
    processEnv: {
      CONCENTRATE_BASE_URL: 'https://api.concentrate.ai/staging/v1',
    },
  })

  assert.equal(env, null)
})

test('buildOpenAIProfileEnv does not stamp a generic key as Concentrate credentials on a noncanonical URL', () => {
  const env = buildOpenAIProfileEnv({
    goal: 'coding',
    baseUrl: 'https://api.concentrate.ai/staging/v1',
    apiKey: 'generic-proxy-key',
    processEnv: {},
  })

  assert.ok(env)
  assert.equal(env?.OPENAI_API_KEY, 'generic-proxy-key')
  assert.equal(env?.CONCENTRATE_API_KEY, undefined)
})

test('openai launch withholds ambient API Route credentials from a keyless proxy profile on restart', async () => {
  for (const ambient of [
    { OPENAI_API_KEY: 'ambient-api-route-key' },
    { OPENAI_API_KEYS: 'ambient-key-a,ambient-key-b' },
  ]) {
    const env = await buildLaunchEnv({
      profile: 'openai',
      persisted: profile('openai', {
        CLAUDE_CODE_PROVIDER_ROUTE_ID: 'api-route',
        OPENAI_BASE_URL: 'https://proxy.example.com/v1',
        OPENAI_MODEL: 'claude-sonnet-4-6',
      }),
      goal: 'coding',
      processEnv: {
        OPENAI_BASE_URL: 'https://proxy.example.com/v1',
        ...ambient,
      },
    })

    assert.equal(env.CLAUDE_CODE_PROVIDER_ROUTE_ID, 'api-route')
    assert.equal(env.OPENAI_API_KEY, undefined)
    assert.equal(env.OPENAI_API_KEYS, undefined)
  }

  const canonical = await buildLaunchEnv({
    profile: 'openai',
    persisted: profile('openai', {
      CLAUDE_CODE_PROVIDER_ROUTE_ID: 'api-route',
      OPENAI_BASE_URL: 'https://global.api-route.com/v1',
      OPENAI_MODEL: 'claude-sonnet-4-6',
    }),
    goal: 'coding',
    processEnv: {
      OPENAI_BASE_URL: 'https://global.api-route.com/v1',
      OPENAI_API_KEY: 'ambient-api-route-key',
    },
  })
  assert.equal(canonical.OPENAI_API_KEY, 'ambient-api-route-key')
})

test('buildStartupEnvFromProfile applies saved API Route proxy profile even when ambient credentials are present', async () => {
  const processEnv: NodeJS.ProcessEnv = {
    OPENAI_API_KEY: 'ambient-key',
    OPENAI_API_KEYS: 'ambient-key-1,ambient-key-2',
  }

  const env = await buildStartupEnvFromProfile({
    persisted: profile('openai', {
      CLAUDE_CODE_PROVIDER_ROUTE_ID: 'api-route',
      OPENAI_BASE_URL: 'https://proxy.example.com/v1',
      OPENAI_MODEL: 'claude-sonnet-4-6',
    }),
    processEnv,
  })

  assert.equal(env.OPENAI_BASE_URL, 'https://proxy.example.com/v1')
  assert.equal(env.CLAUDE_CODE_PROVIDER_ROUTE_ID, 'api-route')
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.OPENAI_API_KEYS, undefined)
})
