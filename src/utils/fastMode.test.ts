import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as realAxios from 'axios'
import * as realOauthConstants from 'src/constants/oauth.js'
import * as realGrowthbook from 'src/services/analytics/growthbook.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import * as realModel from './model/model.js'
type ProvidersModule = typeof import('./model/providers.js')
type AxiosModule = typeof import('axios')

const nonce = `${Date.now()}-${Math.random()}`
const realAuth = {
  ...await import(`./auth.js?real=${nonce}`),
}

const originalEnv = { ...process.env }
let originalProvidersModule: ProvidersModule | undefined
let originalAxiosModule: AxiosModule | undefined

async function importFreshFastModeModule() {
  return import(`./fastMode.ts?ts=${Date.now()}-${Math.random()}`)
}

async function installCommonMocks(options?: {
  cachedEnabled?: boolean
  apiKey?: string | null
  oauthToken?: string | null
  hasProfileScope?: boolean
  axiosReject?: boolean
}) {
  originalProvidersModule ??= await importActualProviders()
  originalAxiosModule ??= await import('axios')

  mock.module('axios', () => ({
    default: {
      defaults: {},
      interceptors: {
        request: {
          use: () => 0,
          eject: () => {},
        },
      },
      get: options?.axiosReject
        ? async () => {
            throw new Error('network fail')
          }
        : async () => ({ data: { enabled: false, disabled_reason: 'preference' } }),
      isAxiosError: () => false,
    },
  }))

  mock.module('src/services/analytics/growthbook.js', () => ({
    onGrowthBookRefresh: () => () => {},
    hasGrowthBookEnvOverride: () => false,
    getAllGrowthBookFeatures: () => ({}),
    getGrowthBookConfigOverrides: () => ({}),
    setGrowthBookConfigOverride: () => {},
    clearGrowthBookConfigOverrides: () => {},
    getApiBaseUrlHost: () => undefined,
    initializeGrowthBook: async () => null,
    checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
    getFeatureValue_CACHED_MAY_BE_STALE: (
      name: string,
      defaultValue: unknown,
    ) => (name === 'tengu_penguins_off' ? false : defaultValue),
    getFeatureValue_CACHED_WITH_REFRESH: (
      name: string,
      defaultValue: unknown,
    ) => (name === 'tengu_penguins_off' ? false : defaultValue),
    getDynamicConfig_CACHED_MAY_BE_STALE: (
      _name: string,
      defaultValue: unknown,
    ) => defaultValue,
    checkGate_CACHED_OR_BLOCKING: async () => false,
    checkSecurityRestrictionGate: async () => false,
    getFeatureValue_DEPRECATED: async (
      _name: string,
      defaultValue: unknown,
    ) => defaultValue,
    refreshGrowthBookAfterAuthChange: () => {},
    resetGrowthBook: () => {},
    refreshGrowthBookFeatures: async () => {},
    setupPeriodicGrowthBookRefresh: () => {},
    stopPeriodicGrowthBookRefresh: () => {},
    getDynamicConfig_BLOCKS_ON_INIT: async (
      _name: string,
      defaultValue: unknown,
    ) => defaultValue,
  }))

  mock.module('src/constants/oauth.js', () => ({
    fileSuffixForOauthConfig: () => '',
    CLAUDE_AI_INFERENCE_SCOPE: 'user:inference',
    CLAUDE_AI_PROFILE_SCOPE: 'user:profile',
    OAUTH_BETA_HEADER: 'test-beta',
    CONSOLE_OAUTH_SCOPES: ['org:create_api_key', 'user:profile'],
    CLAUDE_AI_OAUTH_SCOPES: ['user:profile', 'user:inference'],
    ALL_OAUTH_SCOPES: ['org:create_api_key', 'user:profile', 'user:inference'],
    MCP_CLIENT_METADATA_URL: 'https://claude.ai/oauth/claude-code-client-metadata',
    getOauthConfig: () => ({
      BASE_API_URL: 'https://api.anthropic.com',
      CONSOLE_AUTHORIZE_URL: 'https://platform.claude.com/oauth/authorize',
      CLAUDE_AI_AUTHORIZE_URL: 'https://claude.com/cai/oauth/authorize',
      CLAUDE_AI_ORIGIN: 'https://claude.ai',
      TOKEN_URL: 'https://platform.claude.com/v1/oauth/token',
      API_KEY_URL: 'https://api.anthropic.com/api/oauth/claude_cli/create_api_key',
      ROLES_URL: 'https://api.anthropic.com/api/oauth/claude_cli/roles',
      CONSOLE_SUCCESS_URL: 'https://platform.claude.com/oauth/code/success',
      CLAUDEAI_SUCCESS_URL: 'https://platform.claude.com/oauth/code/success',
      MANUAL_REDIRECT_URL: 'https://platform.claude.com/oauth/code/callback',
      CLIENT_ID: 'test-client-id',
      OAUTH_FILE_SUFFIX: '',
      MCP_PROXY_URL: 'https://mcp-proxy.anthropic.com',
      MCP_PROXY_PATH: '/v1/mcp/{server_id}',
    }),
  }))

  mock.module('./auth.js', () => ({
    isAnthropicAuthEnabled: () => true,
    getAuthTokenSource: () => 'none',
    getAnthropicApiKey: () => options?.apiKey ?? null,
    hasAnthropicApiKeyAuth: () => Boolean(options?.apiKey),
    getAnthropicApiKeyWithSource: () => ({
      apiKey: options?.apiKey ?? null,
      source: options?.apiKey ? 'env' : null,
    }),
    getConfiguredApiKeyHelper: () => undefined,
    isAwsAuthRefreshFromProjectSettings: () => false,
    isAwsCredentialExportFromProjectSettings: () => false,
    calculateApiKeyHelperTTL: () => 0,
    getApiKeyHelperElapsedMs: () => 0,
    getApiKeyFromApiKeyHelper: async () => null,
    getApiKeyFromApiKeyHelperCached: () => null,
    clearApiKeyHelperCache: () => {},
    prefetchApiKeyFromApiKeyHelperIfSafe: () => {},
    refreshAwsAuth: async () => false,
    refreshAndGetAwsCredentials: async () => null,
    clearAwsCredentialsCache: () => {},
    isGcpAuthRefreshFromProjectSettings: () => false,
    checkGcpCredentialsValid: async () => false,
    refreshGcpAuth: async () => false,
    refreshGcpCredentialsIfNeeded: async () => false,
    clearGcpCredentialsCache: () => {},
    prefetchGcpCredentialsIfSafe: () => {},
    prefetchAwsCredentialsAndBedRockInfoIfSafe: () => {},
    getApiKeyFromConfigOrMacOSKeychain: () => null,
    saveApiKey: async () => {},
    isCustomApiKeyApproved: () => false,
    removeApiKey: async () => {},
    saveOAuthTokensIfNeeded: () => ({ didSave: false }),
    getClaudeAIOAuthTokens: () =>
      options?.oauthToken ? { accessToken: options.oauthToken } : null,
    clearOAuthTokenCache: () => {},
    handleOAuth401Error: async () => {},
    getClaudeAIOAuthTokensAsync: async () =>
      options?.oauthToken ? { accessToken: options.oauthToken } : null,
    checkAndRefreshOAuthTokenIfNeeded: async () => null,
    isClaudeAISubscriber: () => Boolean(options?.oauthToken),
    hasProfileScope: () => options?.hasProfileScope ?? false,
    is1PApiCustomer: () => Boolean(options?.apiKey),
    getOauthAccountInfo: () => undefined,
    isOverageProvisioningAllowed: () => false,
    hasOpusAccess: () => false,
    getSubscriptionType: () => null,
    isMaxSubscriber: () => false,
    isTeamSubscriber: () => false,
    isTeamPremiumSubscriber: () => false,
    isEnterpriseSubscriber: () => false,
    isProSubscriber: () => false,
    getRateLimitTier: () => null,
    getSubscriptionName: () => '',
    isUsing3PServices: () => false,
    isOtelHeadersHelperFromProjectOrLocalSettings: () => false,
    getOtelHeadersFromHelper: () => ({}),
    isConsumerSubscriber: () => false,
    getAccountInformation: () => undefined,
    validateForceLoginOrg: async () => ({ ok: true }),
  }))

  mock.module('./model/providers.js', () => ({
    ...originalProvidersModule!,
    getAPIProvider: () => 'firstParty',
    getAPIProviderForStatsig: () => 'firstParty',
    isFirstPartyAnthropicBaseUrl: () => true,
    isGithubNativeAnthropicMode: () => false,
    usesAnthropicAccountFlow: () => true,
  }))
}

async function importActualProviders(): Promise<ProvidersModule> {
  return import(
    `./model/providers.ts?fastModeActual=${Date.now()}-${Math.random()}`
  )
}

async function prepareFastModeTestState(): Promise<void> {
  const { setIsInteractive } = await import('../bootstrap/state.js')
  setIsInteractive(true)
  const { DEFAULT_GLOBAL_CONFIG, _setGlobalConfigCacheForTesting } =
    await import('./config.js')
  _setGlobalConfigCacheForTesting({
    ...DEFAULT_GLOBAL_CONFIG,
    penguinModeOrgEnabled: false,
  })
}

function forceFirstPartyProviderEnv(): void {
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.NVIDIA_NIM
  delete process.env.MINIMAX_API_KEY
  delete process.env.XAI_API_KEY
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_API_BASE
  delete process.env.OPENAI_MODEL
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/fastMode.test.ts')
})

afterEach(async () => {
  try {
    mock.restore()
    if (originalProvidersModule) {
      mock.module('./model/providers.js', () => originalProvidersModule!)
    }
    mock.module('axios', () => originalAxiosModule ?? realAxios)
    mock.module('src/constants/oauth.js', () => realOauthConstants)
    mock.module('src/services/analytics/growthbook.js', () => realGrowthbook)
    mock.module('./auth.js', () => realAuth)
    mock.module('./model/model.js', () => realModel)
    process.env = { ...originalEnv }
    const { resetStateForTests } = await import('../bootstrap/state.js')
    resetStateForTests()
    const { _setGlobalConfigCacheForTesting } = await import('./config.js')
    _setGlobalConfigCacheForTesting(null)
  } finally {
    releaseSharedMutationLock()
  }
})

afterAll(() => {
  mock.module('./auth.js', () => realAuth)
})

describe('isFastModeSupportedByModel — Opus model gate (#1769)', () => {
  test('supports the current default Opus (now 4.8), matching the /fast UI', async () => {
    forceFirstPartyProviderEnv()
    await installCommonMocks({ cachedEnabled: true, oauthToken: 'tok' })
    const { isFastModeSupportedByModel } = await importFreshFastModeModule()
    await prepareFastModeTestState()

    // The 'opus' alias resolves to getDefaultOpusModel() = claude-opus-4-8 for
    // first-party. The predicate must recognize it, or the "/fast" UI ("Opus
    // 4.8 only") and runtime behavior disagree. (Pre-fix this returned false
    // because the predicate only matched opus-4-6.)
    expect(isFastModeSupportedByModel('opus')).toBe(true)
  })
})

describe('fastMode ant-only fallback cleanup', () => {
  test('resolveFastModeStatusFromCache does not force-enable from USER_TYPE=ant', async () => {
    process.env.USER_TYPE = 'ant'
    forceFirstPartyProviderEnv()
    await installCommonMocks({ cachedEnabled: false })

    const {
      resolveFastModeStatusFromCache,
      getFastModeUnavailableReason,
    } = await importFreshFastModeModule()
    await prepareFastModeTestState()

    resolveFastModeStatusFromCache()

    expect(getFastModeUnavailableReason()).toBe(
      'Fast mode is currently unavailable',
    )
  })

  test('prefetchFastModeStatus without auth does not force-enable from USER_TYPE=ant', async () => {
    process.env.USER_TYPE = 'ant'
    forceFirstPartyProviderEnv()
    await installCommonMocks({ cachedEnabled: false, apiKey: null, oauthToken: null })

    const {
      prefetchFastModeStatus,
      getFastModeUnavailableReason,
    } = await importFreshFastModeModule()
    await prepareFastModeTestState()

    await prefetchFastModeStatus()

    expect(getFastModeUnavailableReason()).toBe(
      'Fast mode has been disabled by your organization',
    )
  })

  test('prefetchFastModeStatus network failure does not force-enable from USER_TYPE=ant', async () => {
    process.env.USER_TYPE = 'ant'
    forceFirstPartyProviderEnv()
    await installCommonMocks({
      cachedEnabled: false,
      apiKey: 'test-key',
      axiosReject: true,
    })

    const {
      prefetchFastModeStatus,
      getFastModeUnavailableReason,
    } = await importFreshFastModeModule()
    await prepareFastModeTestState()

    await prefetchFastModeStatus()

    expect(getFastModeUnavailableReason()).toBe(
      'Fast mode unavailable due to network connectivity issues',
    )
  })
})
