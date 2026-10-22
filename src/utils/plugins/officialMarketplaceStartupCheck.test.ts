import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'

const realGrowthbook = {
  ...await import(`../../services/analytics/growthbook.js?real=${Date.now()}-${Math.random()}`),
}
const realAnalytics = {
  ...await import(`../../services/analytics/index.js?real=${Date.now()}-${Math.random()}`),
}
const realConfig = {
  ...await import(`../config.js?real=${Date.now()}-${Math.random()}`),
}
const realDebug = {
  ...await import(`../debug.js?real=${Date.now()}-${Math.random()}`),
}
const realLog = {
  ...await import(`../log.js?real=${Date.now()}-${Math.random()}`),
}
const realGitAvailability = {
  ...await import(`./gitAvailability.js?real=${Date.now()}-${Math.random()}`),
}
const realMarketplaceHelpers = {
  ...await import(`./marketplaceHelpers.js?real=${Date.now()}-${Math.random()}`),
}
const realMarketplaceManager = {
  ...await import(`./marketplaceManager.js?real=${Date.now()}-${Math.random()}`),
}
const realOfficialMarketplaceGcs = {
  ...await import(`./officialMarketplaceGcs.js?real=${Date.now()}-${Math.random()}`),
}

type TestGlobalConfig = {
  officialMarketplaceAutoInstallAttempted?: boolean
  officialMarketplaceAutoInstalled?: boolean
  officialMarketplaceAutoInstallFailReason?:
    | 'policy_blocked'
    | 'git_unavailable'
    | 'gcs_unavailable'
    | 'unknown'
  officialMarketplaceAutoInstallRetryCount?: number
  officialMarketplaceAutoInstallLastAttemptTime?: number
  officialMarketplaceAutoInstallNextRetryTime?: number
}

let config: TestGlobalConfig = {}
let knownMarketplaces: Record<string, unknown> = {}
const saveGlobalConfig = mock(
  (updater: (current: TestGlobalConfig) => TestGlobalConfig) => {
    config = updater(config)
  },
)
const saveKnownMarketplacesConfig = mock(
  async (next: Record<string, unknown>) => {
    knownMarketplaces = next
  },
)
const fetchOfficialMarketplaceFromGcs = mock(async () => 'sha')
const addMarketplaceSource = mock(async () => ({
  name: 'claude-plugins-official',
  alreadyMaterialized: false,
  resolvedSource: {},
}))

await acquireSharedMutationLock('utils/plugins/officialMarketplaceStartupCheck.test.ts')

mock.module('../../services/analytics/growthbook.js', () => ({
  ...realGrowthbook,
  getFeatureValue_CACHED_MAY_BE_STALE: () => true,
}))

mock.module('../../services/analytics/index.js', () => ({
  logEvent: mock(() => {}),
}))

// Spread the real config module so all exports are present. The marketplace
// module body transitively imports many config.js exports; missing entries
// (e.g. `normalizeMaxMessagesCompactionThreshold` added in PR #1605) break
// any downstream test that re-imports the mocked path in the same Bun
// process. The `?real=...` cache-bust ensures the import bypasses this
// file's own mock.module() registration for the same path.
mock.module('../config.js', () => ({
  ...realConfig,
  checkHasTrustDialogAccepted: () => true,
  enableConfigs: mock(() => {}),
  getCurrentProjectConfig: () => ({}),
  getGlobalConfig: () => config,
  getGlobalConfigWriteCount: () => 0,
  getAutoUpdaterDisabledReason: () => null,
  formatAutoUpdaterDisabledReason: () => 'enabled',
  getManagedClaudeRulesDir: () => '/tmp/openclaude-managed-rules',
  getMemoryPath: () => '/tmp/openclaude-memory.md',
  getOrCreateUserID: () => 'test-user-id',
  getProjectPathForConfig: () => '/tmp/openclaude-project-config.json',
  getRemoteControlAtStartup: () => false,
  getUserClaudeRulesDir: () => '/tmp/openclaude-user-rules',
  isAutoUpdaterDisabled: () => false,
  recordFirstStartTime: mock(() => {}),
  getCustomApiKeyStatus: () => ({ hasCustomApiKey: false }),
  isGlobalConfigKey: () => false,
  isPathTrusted: () => true,
  isProjectConfigKey: () => false,
  resetTrustDialogAcceptedCacheForTesting: mock(() => {}),
  shouldSkipPluginAutoupdate: () => false,
  saveGlobalConfig,
  saveCurrentProjectConfig: mock(() => {}),
}))

// Spread the real debug module to preserve all exports (isDebugToStdErr,
// logAntError, getDebugLogPath, etc.). The marketplace module body
// transitively imports many of these; missing entries break any
// downstream test that re-imports the mocked path in the same Bun
// process. Pre-imported here (not inline) because mock.module's factory
// is sync — see the growthbook pattern at line 41 above.
mock.module('../debug.js', () => ({
  ...realDebug,
  logForDebugging: mock(() => {}),
}))

// Spread the real log module to preserve all exports. The marketplace
// module body transitively imports many of these; missing entries break
// any downstream test that re-imports the mocked path.
mock.module('../log.js', () => ({
  ...realLog,
  logError: mock(() => {}),
}))

mock.module('./gitAvailability.js', () => ({
  checkGitAvailable: async () => true,
  markGitUnavailable: mock(() => {}),
}))

// Spread the real module so all exports (`isSourceInBlocklist`,
// `formatFailureDetails`, etc.) are present. The market manager module
// body transitively imports many of these, and missing entries break any
// downstream test that re-imports the mocked path in the same Bun
// process (e.g. marketplaceManager.test.ts running after this file).
// Using `?real=...` cache-bust ensures the import bypasses this file's
// own mock.module() registration for the same path.
mock.module('./marketplaceHelpers.js', () => ({
  ...realMarketplaceHelpers,
  isSourceAllowedByPolicy: () => true,
}))

mock.module('./marketplaceManager.js', () => ({
  addMarketplaceSource,
  getMarketplace: async () => ({ plugins: [] }),
  getMarketplaceCacheOnly: async () => ({ plugins: [] }),
  getMarketplacesCacheDir: () => '/tmp/openclaude-marketplaces',
  getPluginById: async () => undefined,
  getPluginByIdCacheOnly: async () => undefined,
  loadKnownMarketplacesConfig: async () => knownMarketplaces,
  loadKnownMarketplacesConfigSafe: async () => knownMarketplaces,
  saveKnownMarketplacesConfig,
}))

mock.module('./officialMarketplaceGcs.js', () => ({
  fetchOfficialMarketplaceFromGcs,
}))

let checkAndInstallOfficialMarketplace:
  typeof import('./officialMarketplaceStartupCheck.js').checkAndInstallOfficialMarketplace

const mod = await import('./officialMarketplaceStartupCheck.js')
checkAndInstallOfficialMarketplace = mod.checkAndInstallOfficialMarketplace

afterAll(() => {
  try {
    mock.restore()
    mock.module('../../services/analytics/growthbook.js', () => realGrowthbook)
    mock.module('../../services/analytics/index.js', () => realAnalytics)
    mock.module('../config.js', () => realConfig)
    mock.module('../debug.js', () => realDebug)
    mock.module('../log.js', () => realLog)
    mock.module('./gitAvailability.js', () => realGitAvailability)
    mock.module('./marketplaceHelpers.js', () => realMarketplaceHelpers)
    mock.module('./marketplaceManager.js', () => realMarketplaceManager)
    mock.module('./officialMarketplaceGcs.js', () => realOfficialMarketplaceGcs)
  } finally {
    releaseSharedMutationLock()
  }
})

beforeEach(() => {
  config = {}
  knownMarketplaces = {}
  saveGlobalConfig.mockClear()
  saveKnownMarketplacesConfig.mockClear()
  fetchOfficialMarketplaceFromGcs.mockClear()
  fetchOfficialMarketplaceFromGcs.mockImplementation(async () => 'sha')
  addMarketplaceSource.mockClear()
})

describe('checkAndInstallOfficialMarketplace', () => {
  test('repairs missing known marketplace even when global config says installed', async () => {
    config = {
      officialMarketplaceAutoInstallAttempted: true,
      officialMarketplaceAutoInstalled: true,
    }

    const result = await checkAndInstallOfficialMarketplace()

    expect(result).toEqual({ installed: true, skipped: false })
    expect(fetchOfficialMarketplaceFromGcs).toHaveBeenCalled()
    expect(saveKnownMarketplacesConfig).toHaveBeenCalled()
    expect(knownMarketplaces).toHaveProperty('claude-plugins-official')
    expect(config.officialMarketplaceAutoInstalled).toBe(true)
    expect(config.officialMarketplaceAutoInstallFailReason).toBeUndefined()
  })

  test('uses known marketplaces as the installed source of truth', async () => {
    knownMarketplaces = {
      'claude-plugins-official': {
        installLocation: '/tmp/openclaude-marketplaces/claude-plugins-official',
      },
    }

    const result = await checkAndInstallOfficialMarketplace()

    expect(result).toEqual({
      installed: false,
      skipped: true,
      reason: 'already_installed',
    })
    expect(fetchOfficialMarketplaceFromGcs).not.toHaveBeenCalled()
    expect(config.officialMarketplaceAutoInstallAttempted).toBe(true)
    expect(config.officialMarketplaceAutoInstalled).toBe(true)
  })
})
