import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'

const realMarketplaceManager = {
  ...await import(`./marketplaceManager.js?real=${Date.now()}-${Math.random()}`),
}
const realBinaryCheck = {
  ...await import(`../binaryCheck.js?real=${Date.now()}-${Math.random()}`),
}
const realInstalledPluginsManager = {
  ...await import(`./installedPluginsManager.js?real=${Date.now()}-${Math.random()}`),
}
const realConfig = {
  ...await import(`../config.js?real=${Date.now()}-${Math.random()}`),
}

type MarketplaceEntry = {
  name: string
  description?: string
  lspServers?: Record<
    string,
    {
      command: string
      args?: string[]
      extensionToLanguage: Record<string, string>
    }
  >
}

let marketplaces: Record<string, MarketplaceEntry[]> = {}
let installedPlugins = new Set<string>()
let installedBinaries = new Set<string>()
let config = {
  lspRecommendationDisabled: false,
  lspRecommendationNeverPlugins: [] as string[],
  lspRecommendationIgnoredCount: 0,
}
let addMarketplaceSourceFn = mock(() => {})

await acquireSharedMutationLock('utils/plugins/lspRecommendation.test.ts')

mock.module('./marketplaceManager.js', () => ({
  addMarketplaceSource: addMarketplaceSourceFn,
  getMarketplaceCacheOnly: async (name: string) => ({
    plugins: marketplaces[name] ?? [],
  }),
  getMarketplacesCacheDir: () => '/tmp/openclaude-marketplaces',
  loadKnownMarketplacesConfig: async () =>
    Object.fromEntries(
      Object.keys(marketplaces).map(name => [
        name,
        { installLocation: `/tmp/${name}` },
      ]),
    ),
  loadKnownMarketplacesConfigSafe: async () =>
    Object.fromEntries(
      Object.keys(marketplaces).map(name => [
        name,
        { installLocation: `/tmp/${name}` },
      ]),
    ),
  getMarketplace: async (name: string) => ({
    plugins: marketplaces[name] ?? [],
  }),
  getPluginById: async () => undefined,
  getPluginByIdCacheOnly: async () => undefined,
  saveKnownMarketplacesConfig: mock(async () => {}),
}))

mock.module('../binaryCheck.js', () => ({
  isBinaryInstalled: async (command: string) => installedBinaries.has(command),
}))

mock.module('./installedPluginsManager.js', () => ({
  addInstalledPlugin: mock(() => {}),
  addPluginInstallation: mock(() => {}),
  clearInstalledPluginsCache: mock(() => {}),
  getInMemoryInstalledPlugins: () => ({ installations: {}, schemaVersion: 2 }),
  getGitCommitSha: async () => undefined,
  getPendingUpdateCount: () => 0,
  getPendingUpdatesDetails: () => [],
  hasPendingUpdates: () => false,
  loadInstalledPluginsFromDisk: () => ({
    installations: {},
    schemaVersion: 2,
  }),
  removeAllPluginsForMarketplace: () => ({ removed: 0 }),
  removeInstalledPlugin: mock(() => {}),
  removePluginInstallation: mock(() => {}),
  resetInMemoryState: mock(() => {}),
  isPluginInstalled: (pluginId: string) => installedPlugins.has(pluginId),
  isPluginGloballyInstalled: (pluginId: string) => installedPlugins.has(pluginId),
  updateInstallationPathOnDisk: mock(() => {}),
}))

// Spread the real config module to preserve all exports. The marketplace
// module body transitively imports many of these; missing entries
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
  saveGlobalConfig: mock((updater: (current: typeof config) => typeof config) => {
    config = updater(config)
  }),
  saveCurrentProjectConfig: mock(() => {}),
}))

let getMatchingLspPlugins: typeof import('./lspRecommendation.js').getMatchingLspPlugins
let listLspPluginCandidates: typeof import('./lspRecommendation.js').listLspPluginCandidates

function resetTestState(): void {
  marketplaces = {
    'claude-plugins-official': [
      lspPlugin('typescript-lsp', 'typescript-language-server', [
        '.ts',
        '.tsx',
        '.js',
      ]),
      lspPlugin('pyright-lsp', 'pyright-langserver', ['.py', '.pyi']),
    ],
    community: [lspPlugin('rust-analyzer-lsp', 'rust-analyzer', ['.rs'])],
  }
  installedPlugins = new Set()
  installedBinaries = new Set(['typescript-language-server'])
  config = {
    lspRecommendationDisabled: false,
    lspRecommendationNeverPlugins: [],
    lspRecommendationIgnoredCount: 0,
  }
  addMarketplaceSourceFn.mockClear()
}

resetTestState()
const mod = await import('./lspRecommendation.js')
getMatchingLspPlugins = mod.getMatchingLspPlugins
listLspPluginCandidates = mod.listLspPluginCandidates

afterAll(() => {
  try {
    mock.restore()
    mock.module('./marketplaceManager.js', () => realMarketplaceManager)
    mock.module('../binaryCheck.js', () => realBinaryCheck)
    mock.module('./installedPluginsManager.js', () => realInstalledPluginsManager)
    mock.module('../config.js', () => realConfig)
  } finally {
    releaseSharedMutationLock()
  }
})

function lspPlugin(
  name: string,
  command: string,
  extensions: string[],
  description = `${name} description`,
): MarketplaceEntry {
  return {
    name,
    description,
    lspServers: {
      [name]: {
        command,
        extensionToLanguage: Object.fromEntries(
          extensions.map(ext => [ext, ext.slice(1)]),
        ),
      },
    },
  }
}

beforeEach(() => {
  resetTestState()
})

describe('listLspPluginCandidates', () => {
  test('lists matching marketplace LSP plugins including missing binaries', async () => {
    const candidates = await listLspPluginCandidates({
      extensions: ['ts', '.py'],
      includeInstalled: true,
      includeMissingBinaries: true,
    })

    expect(candidates.map(candidate => candidate.pluginId)).toEqual([
      'typescript-lsp@claude-plugins-official',
      'pyright-lsp@claude-plugins-official',
    ])
    expect(candidates[0]).toMatchObject({
      command: 'typescript-language-server',
      binaryInstalled: true,
      installed: false,
      isOfficial: true,
    })
    expect(candidates[1]).toMatchObject({
      command: 'pyright-langserver',
      binaryInstalled: false,
      installed: false,
    })
  })

  test('filters installed and missing-binary candidates unless requested', async () => {
    installedPlugins = new Set(['typescript-lsp@claude-plugins-official'])

    const candidates = await listLspPluginCandidates({
      extensions: ['.ts', '.py', '.rs'],
    })

    expect(candidates).toEqual([])
  })

  test('includes installed candidates when requested', async () => {
    installedPlugins = new Set(['typescript-lsp@claude-plugins-official'])

    const candidates = await listLspPluginCandidates({
      extensions: ['.ts'],
      includeInstalled: true,
    })

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      pluginId: 'typescript-lsp@claude-plugins-official',
      installed: true,
      binaryInstalled: true,
    })
  })
})

describe('getMatchingLspPlugins', () => {
  test('keeps passive recommendations limited to installable non-installed plugins', async () => {
    installedBinaries = new Set([
      'typescript-language-server',
      'rust-analyzer',
    ])
    installedPlugins = new Set(['typescript-lsp@claude-plugins-official'])

    const matches = await getMatchingLspPlugins('src/main.rs')

    expect(matches.map(match => match.pluginId)).toEqual([
      'rust-analyzer-lsp@community',
    ])
    expect(matches[0]?.command).toBe('rust-analyzer')
  })
})

describe('marketplace discovery side effects', () => {
  test('does not mutate marketplace config when none are configured', async () => {
    marketplaces = {}
    installedBinaries = new Set(['typescript-language-server'])

    const candidates = await listLspPluginCandidates({
      extensions: ['.ts'],
      includeInstalled: true,
      includeMissingBinaries: true,
    })

    expect(addMarketplaceSourceFn).not.toHaveBeenCalled()
    expect(candidates).toEqual([])
  })
})
