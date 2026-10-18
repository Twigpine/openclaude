import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'

const staleInstallLocation = '/stale/marketplaces/mymarketplace'
const liveInstallLocation = '/live/marketplaces/temp_keep'

const realMarketplaceManager = await import(
  `../../utils/plugins/marketplaceManager.js?spread=${Date.now()}`
)
const realInstallationHelpers = await import(
  `../../utils/plugins/pluginInstallationHelpers.js?spread=${Date.now()}`
)

let configLoadCount = 0
let capturedInstallLocation: string | undefined

mock.module('../../utils/plugins/marketplaceManager.js', () => ({
  ...realMarketplaceManager,
  getMarketplace: async () => ({
    name: 'MyMarketplace',
    owner: { name: 'test' },
    plugins: [{ name: 'demo-plugin', source: './' }],
  }),
  getPluginById: async () => null,
  loadKnownMarketplacesConfig: async () => {
    configLoadCount++
    const installLocation =
      configLoadCount === 1 ? staleInstallLocation : liveInstallLocation
    return {
      MyMarketplace: {
        source: { source: 'url', url: 'https://example.com/marketplace.json' },
        installLocation,
        lastUpdated: '2020-01-01T00:00:00.000Z',
      },
    }
  },
}))

mock.module('../../utils/plugins/pluginInstallationHelpers.js', () => ({
  ...realInstallationHelpers,
  installResolvedPlugin: async (opts: {
    marketplaceInstallLocation?: string
  }) => {
    capturedInstallLocation = opts.marketplaceInstallLocation
    return { ok: true, closure: [] as string[], depNote: '' }
  },
}))

afterAll(() => {
  mock.module(
    '../../utils/plugins/marketplaceManager.js',
    () => realMarketplaceManager,
  )
  mock.module(
    '../../utils/plugins/pluginInstallationHelpers.js',
    () => realInstallationHelpers,
  )
})

const { installPluginOp } = await import(
  `./pluginOperations.ts?bust=install-location-${Date.now()}`
)

describe('installPluginOp keep-temp installLocation (#2183)', () => {
  afterEach(() => {
    configLoadCount = 0
    capturedInstallLocation = undefined
  })

  test('install-by-name uses persisted installLocation after getMarketplace refetch', async () => {
    const result = await installPluginOp('demo-plugin', 'user')
    expect(result.success).toBe(true)
    expect(capturedInstallLocation).toBe(liveInstallLocation)
    expect(configLoadCount).toBeGreaterThanOrEqual(2)
  })
})
