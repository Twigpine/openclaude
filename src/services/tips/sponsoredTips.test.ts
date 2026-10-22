import { afterAll, describe, expect, mock, test } from 'bun:test'
import * as actualConfig from '../../utils/config.js'
import * as actualSettings from '../../utils/settings/settings.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'

type StubSettings = {
  sponsoredTipsEnabled?: boolean
  sponsoredTipsFrequency?: number
  spinnerTipsEnabled?: boolean
}

const settingsRef: { value: StubSettings } = { value: {} }
const configRef: {
  value: { numStartups: number; sponsoredTipsHistory?: { lastShownAt: number; totalShown: number } }
} = { value: { numStartups: 100 } }

// mock.module is process-global — install once, then mutate the refs per test.
await acquireSharedMutationLock('services/tips/sponsoredTips.test.ts')

// Bun repoints module namespaces when mocked; preserve the original exports.
const realSettings = { ...actualSettings }
const realConfig = { ...actualConfig }

mock.module('../../utils/settings/settings.js', () => ({
  getSettings_DEPRECATED: () => settingsRef.value,
  getInitialSettings: () => settingsRef.value,
  getSettingsForSource: () => undefined,
}))

mock.module('../../utils/config.js', () => ({
  getGlobalConfig: () => configRef.value,
  saveGlobalConfig: (mut: (c: typeof configRef.value) => typeof configRef.value) => {
    configRef.value = mut(configRef.value)
  },
}))

afterAll(() => {
  try {
    mock.restore()
    mock.module('../../utils/settings/settings.js', () => realSettings)
    mock.module('../../utils/config.js', () => realConfig)
    expect(actualSettings.getSettings_DEPRECATED).toBe(
      realSettings.getSettings_DEPRECATED,
    )
    expect(actualSettings.getInitialSettings).toBe(realSettings.getInitialSettings)
    expect(actualSettings.getSettingsForSource).toBe(realSettings.getSettingsForSource)
    expect(actualConfig.getGlobalConfig).toBe(realConfig.getGlobalConfig)
    expect(actualConfig.saveGlobalConfig).toBe(realConfig.saveGlobalConfig)
  } finally {
    releaseSharedMutationLock()
  }
})

async function freshImport() {
  const stamp = `${Date.now()}-${Math.random()}`
  return {
    sponsoredTips: await import(`./sponsoredTips.ts?ts=${stamp}`),
    tipHistory: await import(`./tipHistory.ts?ts=${stamp}`),
  }
}

function resetState(settings: StubSettings = {}, numStartups = 100) {
  settingsRef.value = settings
  configRef.value = { numStartups }
}

describe('sponsoredTipsEnabled', () => {
  test('defaults to true when no settings present', async () => {
    resetState()
    const { sponsoredTips } = await freshImport()
    expect(sponsoredTips.sponsoredTipsEnabled()).toBe(true)
  })

  test('returns false when explicitly disabled', async () => {
    resetState({ sponsoredTipsEnabled: false })
    const { sponsoredTips } = await freshImport()
    expect(sponsoredTips.sponsoredTipsEnabled()).toBe(false)
  })

  test('returns false when frequency is 0', async () => {
    resetState({ sponsoredTipsFrequency: 0 })
    const { sponsoredTips } = await freshImport()
    expect(sponsoredTips.sponsoredTipsEnabled()).toBe(false)
  })
})

describe('getSponsoredTipsFrequency', () => {
  test('defaults to 10', async () => {
    resetState()
    const { sponsoredTips } = await freshImport()
    expect(sponsoredTips.getSponsoredTipsFrequency()).toBe(10)
  })

  test('honors user-configured frequency', async () => {
    resetState({ sponsoredTipsFrequency: 25 })
    const { sponsoredTips } = await freshImport()
    expect(sponsoredTips.getSponsoredTipsFrequency()).toBe(25)
  })

  test('rejects negative values', async () => {
    resetState({ sponsoredTipsFrequency: -5 })
    const { sponsoredTips } = await freshImport()
    expect(sponsoredTips.getSponsoredTipsFrequency()).toBe(10)
  })
})

describe('sponsored tip catalog', () => {
  test('has Atomic Chat and Xiaomi MiMo tips', async () => {
    resetState()
    const { sponsoredTips } = await freshImport()
    const atomicTips = sponsoredTips.sponsoredTips.filter(
      (t: { sponsor?: { name: string; url?: string } }) =>
        t.sponsor?.name === 'Atomic Chat',
    )
    const xiaomiTips = sponsoredTips.sponsoredTips.filter(
      (t: { sponsor?: { name: string; url?: string } }) =>
        t.sponsor?.name === 'Xiaomi MiMo',
    )
    const atlasTips = sponsoredTips.sponsoredTips.filter(
      (t: { sponsor?: { name: string; url?: string } }) =>
        t.sponsor?.name === 'Atlas Cloud',
    )
    expect(atomicTips.length).toBe(4)
    expect(xiaomiTips.length).toBe(5)
    expect(atlasTips.length).toBe(1)
    expect(
      atomicTips.every(
        (t: { sponsor?: { url?: string } }) =>
          t.sponsor?.url === 'https://atomic.chat/',
      ),
    ).toBe(true)
    expect(
      xiaomiTips.every(
        (t: { sponsor?: { url?: string } }) =>
          t.sponsor?.url === 'https://api.xiaomimimo.com/v1',
      ),
    ).toBe(true)
    expect(
      atlasTips.every(
        (t: { sponsor?: { url?: string } }) =>
          t.sponsor?.url === 'https://www.atlascloud.ai/',
      ),
    ).toBe(true)
  })

  test('all tips have unique sponsor-prefixed ids', async () => {
    resetState()
    const { sponsoredTips } = await freshImport()
    const ids = sponsoredTips.sponsoredTips.map((t: { id: string }) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(
      ids.every(
        (id: string) =>
          id.startsWith('atomic-') ||
          id.startsWith('xiaomi-mimo-') ||
          id.startsWith('atlas-cloud-'),
      ),
    ).toBe(true)
  })

  test('rendered content embeds sponsor name, tip body, and URL', async () => {
    resetState()
    const { sponsoredTips } = await freshImport()
    const tip = sponsoredTips.sponsoredTips[0]
    const rendered: string = await tip.content({ theme: 'dark' })
    // ANSI codes wrap the strings — assert on plain substrings
    expect(rendered).toContain('Sponsored')
    expect(rendered).toContain('Atomic Chat')
    expect(rendered).toContain('Setup free local models')
    expect(rendered).toContain('https://atomic.chat/')
  })

  test('Xiaomi MiMo tips render through sponsored tip chrome', async () => {
    resetState()
    const { sponsoredTips } = await freshImport()
    const tip = sponsoredTips.sponsoredTips.find(
      (t: { id: string }) => t.id === 'xiaomi-mimo-context-window',
    )
    const rendered: string = await tip.content({ theme: 'dark' })
    expect(rendered).toContain('Sponsored')
    expect(rendered).toContain('Xiaomi MiMo')
    expect(rendered).toContain('Increase your context window')
    expect(rendered).toContain('https://api.xiaomimimo.com/v1')
  })

  test('isRelevant follows sponsoredTipsEnabled', async () => {
    resetState({ sponsoredTipsEnabled: false })
    const { sponsoredTips } = await freshImport()
    const results = await Promise.all(
      sponsoredTips.sponsoredTips.map((t: { isRelevant: () => Promise<boolean> }) =>
        t.isRelevant(),
      ),
    )
    expect(results.every((r: boolean) => r === false)).toBe(true)
  })
})

describe('sponsored history tracking', () => {
  test('records lastShownAt and increments totalShown', async () => {
    resetState({}, 50)
    const { tipHistory } = await freshImport()
    tipHistory.recordSponsoredTipShown()
    expect(configRef.value.sponsoredTipsHistory).toEqual({
      lastShownAt: 50,
      totalShown: 1,
    })
    tipHistory.recordSponsoredTipShown()
    expect(configRef.value.sponsoredTipsHistory).toEqual({
      lastShownAt: 50,
      totalShown: 2,
    })
  })

  test('getSessionsSinceLastSponsored returns Infinity when never shown', async () => {
    resetState({}, 100)
    const { tipHistory } = await freshImport()
    expect(tipHistory.getSessionsSinceLastSponsored()).toBe(Infinity)
  })

  test('getSessionsSinceLastSponsored returns delta from current startups', async () => {
    resetState({}, 100)
    configRef.value.sponsoredTipsHistory = { lastShownAt: 92, totalShown: 3 }
    const { tipHistory } = await freshImport()
    expect(tipHistory.getSessionsSinceLastSponsored()).toBe(8)
  })
})
