import { afterAll, describe, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import * as actualAnalytics from '../analytics/index.js'
import * as actualConfig from '../../utils/config.js'
import * as actualSettings from '../../utils/settings/settings.js'
import type { Tip } from './types.js'
import * as actualTipRegistry from './tipRegistry.js'

const settingsRef: {
  value: {
    sponsoredTipsEnabled?: boolean
    sponsoredTipsFrequency?: number
    spinnerTipsEnabled?: boolean
  }
} = { value: {} }
const configRef: {
  value: {
    numStartups: number
    tipsHistory?: Record<string, number>
    sponsoredTipsHistory?: { lastShownAt: number; totalShown: number }
    ads?: { enabled: boolean; earnCode?: string }
  }
} = { value: { numStartups: 100 } }

const relevantTipsRef: { value: Tip[] } = { value: [] }

await acquireSharedMutationLock('services/tips/tipScheduler.test.ts')

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

mock.module('./tipRegistry.js', () => ({
  getRelevantTips: async () => relevantTipsRef.value,
}))

mock.module('../analytics/index.js', () => ({
  logEvent: () => undefined,
}))

afterAll(() => {
  try {
    mock.restore()
    mock.module('../../utils/settings/settings.js', () => actualSettings)
    mock.module('../../utils/config.js', () => actualConfig)
    mock.module('./tipRegistry.js', () => actualTipRegistry)
    mock.module('../analytics/index.js', () => actualAnalytics)
  } finally {
    releaseSharedMutationLock()
  }
})

async function freshScheduler() {
  const stamp = `${Date.now()}-${Math.random()}`
  return import(`./tipScheduler.ts?ts=${stamp}`)
}

function makeTip(id: string, sponsored = false): Tip {
  return {
    id,
    content: async () => id,
    cooldownSessions: 0,
    isRelevant: async () => true,
    ...(sponsored
      ? { sponsor: { name: 'Atomic Chat', url: 'https://atomic.chat/' } }
      : {}),
  }
}

function setState(opts: {
  numStartups?: number
  lastSponsored?: number
  frequency?: number
  enabled?: boolean
  tips: Tip[]
}) {
  configRef.value = {
    numStartups: opts.numStartups ?? 100,
    ...(opts.lastSponsored !== undefined
      ? { sponsoredTipsHistory: { lastShownAt: opts.lastSponsored, totalShown: 1 } }
      : {}),
  }
  settingsRef.value = {
    sponsoredTipsFrequency: opts.frequency,
    sponsoredTipsEnabled: opts.enabled,
  }
  relevantTipsRef.value = opts.tips
}

describe('getTipToShowOnSpinner — sponsored partitioning', () => {
  test('picks sponsored when cap met and sponsored tips eligible', async () => {
    setState({
      numStartups: 100,
      lastSponsored: 80, // 20 sessions ago, frequency 10 → eligible
      frequency: 10,
      tips: [makeTip('regular-1'), makeTip('atomic-x', true)],
    })
    const { getTipToShowOnSpinner } = await freshScheduler()
    const pick = await getTipToShowOnSpinner()
    expect(pick?.id).toBe('atomic-x')
  })

  test('falls back to regular when cap not met', async () => {
    setState({
      numStartups: 100,
      lastSponsored: 95, // only 5 sessions ago, frequency 10 → blocked
      frequency: 10,
      tips: [makeTip('regular-1'), makeTip('atomic-x', true)],
    })
    const { getTipToShowOnSpinner } = await freshScheduler()
    const pick = await getTipToShowOnSpinner()
    expect(pick?.id).toBe('regular-1')
  })

  test('frequency=0 disables sponsored entirely', async () => {
    setState({
      numStartups: 100,
      lastSponsored: 1,
      frequency: 0,
      tips: [makeTip('regular-1'), makeTip('atomic-x', true)],
    })
    const { getTipToShowOnSpinner } = await freshScheduler()
    const pick = await getTipToShowOnSpinner()
    expect(pick?.id).toBe('regular-1')
  })

  test('first-ever sponsored slot is eligible (no history)', async () => {
    setState({
      numStartups: 100,
      // no lastSponsored → Infinity sessions
      frequency: 10,
      tips: [makeTip('regular-1'), makeTip('atomic-x', true)],
    })
    const { getTipToShowOnSpinner } = await freshScheduler()
    const pick = await getTipToShowOnSpinner()
    expect(pick?.id).toBe('atomic-x')
  })

  test('returns undefined when no tips at all', async () => {
    setState({ tips: [] })
    const { getTipToShowOnSpinner } = await freshScheduler()
    expect(await getTipToShowOnSpinner()).toBeUndefined()
  })

  test('spinnerTipsEnabled=false short-circuits everything', async () => {
    setState({
      numStartups: 100,
      lastSponsored: 50,
      frequency: 10,
      tips: [makeTip('atomic-x', true)],
    })
    settingsRef.value = { ...settingsRef.value, spinnerTipsEnabled: false }
    const { getTipToShowOnSpinner } = await freshScheduler()
    expect(await getTipToShowOnSpinner()).toBeUndefined()
  })
})

describe('getTipToShowOnSpinner — earning branch', () => {
  test('returns the Twigpine earning tip when earning is enabled', async () => {
    setState({
      numStartups: 100,
      lastSponsored: 80, // would otherwise be an eligible sponsored slot
      frequency: 10,
      tips: [makeTip('regular-1'), makeTip('atomic-x', true)],
    })
    // Opt-in earning (the mocked config provides ads.enabled + a code); every
    // slot earns so the cadence is deterministic.
    configRef.value = { ...configRef.value, ads: { enabled: true, earnCode: 'earn_x' } }
    const prevTipEvery = process.env.OPENCLAUDE_ADS_TIP_EVERY
    process.env.OPENCLAUDE_ADS_TIP_EVERY = '1'
    try {
      const { getTipToShowOnSpinner } = await freshScheduler()
      const pick = await getTipToShowOnSpinner()
      // Earning branch takes precedence over the sponsored/regular partitioning.
      expect(pick?.id).toBe('gitlawb-earn')
    } finally {
      if (prevTipEvery === undefined) delete process.env.OPENCLAUDE_ADS_TIP_EVERY
      else process.env.OPENCLAUDE_ADS_TIP_EVERY = prevTipEvery
    }
  })

  test('does not pre-empt the normal path when earning is disabled', async () => {
    setState({
      numStartups: 100,
      lastSponsored: 80,
      frequency: 10,
      tips: [makeTip('regular-1'), makeTip('atomic-x', true)],
    })
    // No ads config → adsEarningEnabled() is false → earning branch skipped.
    const { getTipToShowOnSpinner } = await freshScheduler()
    const pick = await getTipToShowOnSpinner()
    expect(pick?.id).toBe('atomic-x')
  })
})

describe('recordShownTip — sponsored side effects', () => {
  test('records sponsored history when tip has sponsor', async () => {
    setState({ numStartups: 100, tips: [] })
    const { recordShownTip } = await freshScheduler()
    recordShownTip(makeTip('atomic-x', true))
    expect(configRef.value.sponsoredTipsHistory).toEqual({
      lastShownAt: 100,
      totalShown: 1,
    })
  })

  test('does not record sponsored history for regular tips', async () => {
    setState({ numStartups: 100, tips: [] })
    const { recordShownTip } = await freshScheduler()
    recordShownTip(makeTip('regular-1'))
    expect(configRef.value.sponsoredTipsHistory).toBeUndefined()
  })
})
