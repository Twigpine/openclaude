import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getAllowedSettingSources,
  getFlagSettingsInline,
  getFlagSettingsPath,
  getOriginalCwd,
  setAllowedSettingSources,
  setFlagSettingsInline,
  setFlagSettingsPath,
  setOriginalCwd,
} from '../../bootstrap/state.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { resetSettingsCache } from './settingsCache.js'
import type { SettingsJson } from './types.js'

// Capture the actual module once so source-order tests can replace just the
// per-source reader without leaking a fake settings implementation.
// @ts-expect-error -- query suffix intentionally bypasses Bun's module cache.
import * as realSettings from './settings.js?modelPricingRealSettings'

const paid = (inputTokens: number) => ({
  inputTokens,
  outputTokens: 2,
  promptCacheReadTokens: 0.1,
  promptCacheWriteTokens: 2.5,
})

let tempDir: string
let originalCwd: string
let originalSources: ReturnType<typeof getAllowedSettingSources>
let originalFlagPath: string | undefined
let originalFlagInline: Record<string, unknown> | null
let settingsOverrideActive = false
let settingsBySource: Partial<Record<string, SettingsJson>> = {}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/settings/modelPricing.test.ts')
  mock.restore()
  tempDir = mkdtempSync(join(tmpdir(), 'openclaude-model-pricing-'))
  originalCwd = getOriginalCwd()
  originalSources = [...getAllowedSettingSources()]
  originalFlagPath = getFlagSettingsPath()
  originalFlagInline = getFlagSettingsInline()
  setOriginalCwd(tempDir)
  setFlagSettingsPath(undefined)
  setFlagSettingsInline(null)
  resetSettingsCache()
  settingsOverrideActive = false
  settingsBySource = {}
  mock.module('./settings.js', () => ({
    ...realSettings,
    getSettingsForSource: (source: Parameters<typeof realSettings.getSettingsForSource>[0]) =>
      settingsOverrideActive
        ? settingsBySource[source] ?? null
        : realSettings.getSettingsForSource(source),
  }))
})

afterEach(() => {
  try {
    mock.restore()
    setOriginalCwd(originalCwd)
    setAllowedSettingSources(originalSources)
    setFlagSettingsPath(originalFlagPath)
    setFlagSettingsInline(originalFlagInline)
    settingsOverrideActive = false
    settingsBySource = {}
    resetSettingsCache()
    rmSync(tempDir, { recursive: true, force: true })
  } finally {
    releaseSharedMutationLock()
  }
})

async function importFreshModelPricing() {
  return import(`./modelPricing.js?ts=${Date.now()}-${Math.random()}`)
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, `${JSON.stringify(data)}\n`, 'utf8')
}

test('shared project settings cannot influence personal pricing', async () => {
  const settingsDir = join(tempDir, '.openclaude')
  mkdirSync(settingsDir, { recursive: true })
  writeJson(join(settingsDir, 'settings.json'), {
    modelPricing: { 'repo-controlled-model': paid(999) },
  })
  setAllowedSettingSources(['projectSettings'])
  resetSettingsCache()

  const { getModelPricingOverride } = await importFreshModelPricing()
  expect(getModelPricingOverride('repo-controlled-model')).toBeUndefined()
})

test('canonical source order keeps managed pricing above CLI pricing', async () => {
  settingsBySource = {
    userSettings: { modelPricing: { model: paid(1) } },
    flagSettings: { modelPricing: { model: paid(2) } },
    policySettings: { modelPricing: { model: paid(3) } },
  }
  settingsOverrideActive = true
  // policySettings and flagSettings remain enabled by policy even when the
  // user restricts ordinary setting sources.
  setAllowedSettingSources(['userSettings'])

  const { getModelPricingOverride } = await importFreshModelPricing()
  expect(getModelPricingOverride('model')?.inputTokens).toBe(3)
})

test('settings cache reset reloads exact pricing without a bespoke watcher', async () => {
  const settingsPath = join(tempDir, 'flag-settings.json')
  setFlagSettingsPath(settingsPath)
  setAllowedSettingSources(['flagSettings'])
  writeJson(settingsPath, {
    modelPricing: { 'provider/model:v1?route=paid': paid(4) },
  })
  resetSettingsCache()

  const { getModelPricingOverride } = await importFreshModelPricing()
  const first = getModelPricingOverride('provider/model:v1?route=paid')
  const firstClone = getModelPricingOverride('provider/model:v1?route=paid')
  expect(first?.inputTokens).toBe(4)
  expect(first?.webSearchRequests).toBe(0.01)
  expect(Object.isFrozen(first)).toBe(true)
  expect(firstClone).not.toBe(first)
  expect(firstClone).toEqual(first)

  writeJson(settingsPath, {
    modelPricing: { 'provider/model:v1?route=paid': paid(8) },
  })
  expect(getModelPricingOverride('provider/model:v1?route=paid')?.inputTokens).toBe(4)

  resetSettingsCache()
  expect(getModelPricingOverride('provider/model:v1?route=paid')?.inputTokens).toBe(8)
})

test('prototype-like ids survive JSON parsing and require exact own-key lookup', async () => {
  const settingsPath = join(tempDir, 'flag-settings.json')
  const modelPricing = Object.create(null) as Record<string, unknown>
  for (const model of ['constructor', 'toString', '__proto__']) {
    modelPricing[model] = paid(6)
  }
  setFlagSettingsPath(settingsPath)
  setAllowedSettingSources(['flagSettings'])
  writeJson(settingsPath, { modelPricing })
  resetSettingsCache()

  const { getModelPricingOverride } = await importFreshModelPricing()
  for (const model of ['constructor', 'toString', '__proto__']) {
    expect(getModelPricingOverride(model)?.inputTokens).toBe(6)
  }
  expect(getModelPricingOverride('tostring')).toBeUndefined()
})

test('SDK flag settings replace complete entries without inheriting lower rates', async () => {
  const settingsPath = join(tempDir, 'flag-settings.json')
  const inlinePricing = Object.create(null) as Record<string, unknown>
  inlinePricing.model = paid(8)
  inlinePricing.__proto__ = paid(9)
  setFlagSettingsPath(settingsPath)
  setFlagSettingsInline({ modelPricing: inlinePricing })
  setAllowedSettingSources(['flagSettings'])
  writeJson(settingsPath, {
    modelPricing: {
      model: { ...paid(4), webSearchRequests: 7 },
      'file-only-model': paid(5),
    },
  })
  resetSettingsCache()

  const { getModelPricingOverride } = await importFreshModelPricing()
  expect(getModelPricingOverride('model')).toMatchObject({
    inputTokens: 8,
    webSearchRequests: 0.01,
  })
  expect(getModelPricingOverride('file-only-model')?.inputTokens).toBe(5)
  expect(getModelPricingOverride('__proto__')?.inputTokens).toBe(9)
})
