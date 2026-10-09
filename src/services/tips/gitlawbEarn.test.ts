import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import {
  adsEarningEnabled,
  shouldShowEarningTip,
  resetEarningCadenceForTesting,
  buildEarningTip,
} from './gitlawbEarn.js'

function setAds(ads: { enabled: boolean; earnCode?: string } | undefined): void {
  saveGlobalConfig(c => ({ ...c, ads }))
}

const ORIGINAL_ADS_BASE_URL = process.env.ADS_BASE_URL
const ORIGINAL_TIP_EVERY = process.env.OPENCLAUDE_ADS_TIP_EVERY
const ORIGINAL_FETCH = globalThis.fetch
let originalAds = getGlobalConfig().ads

beforeEach(() => {
  originalAds = getGlobalConfig().ads
  resetEarningCadenceForTesting()
  // Unreachable host → fetchNextTip fails fast and content() degrades to the
  // static fallback, so these tests never hit the network.
  process.env.ADS_BASE_URL = 'http://127.0.0.1:0'
  delete process.env.OPENCLAUDE_ADS_TIP_EVERY
})

// Restore env + global ads config so nothing leaks into other suites in the run.
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  saveGlobalConfig(c => ({ ...c, ads: originalAds }))
  if (ORIGINAL_ADS_BASE_URL === undefined) delete process.env.ADS_BASE_URL
  else process.env.ADS_BASE_URL = ORIGINAL_ADS_BASE_URL
  if (ORIGINAL_TIP_EVERY === undefined) delete process.env.OPENCLAUDE_ADS_TIP_EVERY
  else process.env.OPENCLAUDE_ADS_TIP_EVERY = ORIGINAL_TIP_EVERY
})

describe('twigpine earning tips', () => {
  test('disabled by default (no ads config)', () => {
    setAds(undefined)
    expect(adsEarningEnabled()).toBe(false)
    expect(shouldShowEarningTip()).toBe(false)
  })

  test('enabled once /ads on set enabled + earnCode', () => {
    setAds({ enabled: true, earnCode: 'earn_abc' })
    expect(adsEarningEnabled()).toBe(true)
  })

  test('cadence: every 2nd eligible slot by default', () => {
    setAds({ enabled: true, earnCode: 'earn_abc' })
    resetEarningCadenceForTesting()
    expect(shouldShowEarningTip()).toBe(false) // turn 1
    expect(shouldShowEarningTip()).toBe(true) //  turn 2
    expect(shouldShowEarningTip()).toBe(false) // turn 3
    expect(shouldShowEarningTip()).toBe(true) //  turn 4
  })

  test('OPENCLAUDE_ADS_TIP_EVERY=1 shows every turn', () => {
    setAds({ enabled: true, earnCode: 'earn_abc' })
    process.env.OPENCLAUDE_ADS_TIP_EVERY = '1'
    resetEarningCadenceForTesting()
    expect(shouldShowEarningTip()).toBe(true)
    expect(shouldShowEarningTip()).toBe(true)
  })

  test('disabled → never shows and never increments the counter', () => {
    setAds(undefined)
    for (let i = 0; i < 5; i++) expect(shouldShowEarningTip()).toBe(false)
  })

  test('content falls back to a static line when the ads service is unreachable', async () => {
    setAds({ enabled: true, earnCode: 'earn_abc' })
    const text = await buildEarningTip().content({ theme: 'dark' })
    expect(text.toLowerCase()).toContain('twigpine.com')
  })

  test('content renders a fetched ad (advertiser + ad copy) on the success path', async () => {
    setAds({ enabled: true, earnCode: 'earn_abc' })
    globalThis.fetch = (async (_input: unknown, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          impression_id: 'imp1',
          token: 'tok',
          tip_text: 'Serverless Postgres that scales to zero',
          name: 'Neon',
          link: 'https://neon.tech',
          label: 'Sponsored by Neon',
          dwell_ms: 4000,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch

    const text = await buildEarningTip().content({ theme: 'dark' })
    expect(text).toContain('Serverless Postgres that scales to zero') // ad copy
    expect(text).toContain('Neon') // real advertiser, not the Twigpine fallback
    expect(text.toLowerCase()).not.toContain('twigpine.com')
  })

  test('content falls back when the ad has blank copy (no blank-ad credit)', async () => {
    setAds({ enabled: true, earnCode: 'earn_abc' })
    globalThis.fetch = (async (_input: unknown, _init?: RequestInit) =>
      new Response(
        JSON.stringify({ impression_id: 'imp1', token: 'tok', tip_text: '   ', name: 'X', dwell_ms: 4000 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch

    const text = await buildEarningTip().content({ theme: 'dark' })
    expect(text.toLowerCase()).toContain('twigpine.com') // degraded to static line
  })
})
