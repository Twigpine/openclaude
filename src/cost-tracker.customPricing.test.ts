import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getAllowedSettingSources,
  getFlagSettingsInline,
  getFlagSettingsPath,
  setAllowedSettingSources,
  setFlagSettingsInline,
  setFlagSettingsPath,
} from './bootstrap/state.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from './test/sharedMutationLock.js'
import {
  addToTotalSessionCost,
  formatTotalCost,
  getModelUsage,
  getTotalCost,
  hasUnknownModelCost,
  resetCostState,
} from './cost-tracker.js'
import { resetSettingsCache } from './utils/settings/settingsCache.js'
import {
  calculateCostFromTokens,
  calculateUSDCost,
} from './utils/modelCost.js'

let tempDir: string
let originalSources: ReturnType<typeof getAllowedSettingSources>
let originalFlagPath: string | undefined
let originalFlagInline: Record<string, unknown> | null

beforeEach(async () => {
  await acquireSharedMutationLock('cost-tracker.customPricing.test.ts')
  tempDir = mkdtempSync(join(tmpdir(), 'openclaude-cost-pricing-'))
  originalSources = [...getAllowedSettingSources()]
  originalFlagPath = getFlagSettingsPath()
  originalFlagInline = getFlagSettingsInline()
  setAllowedSettingSources(['flagSettings'])
  setFlagSettingsInline(null)
  resetSettingsCache()
  resetCostState()
})

afterEach(() => {
  try {
    resetCostState()
    setAllowedSettingSources(originalSources)
    setFlagSettingsPath(originalFlagPath)
    setFlagSettingsInline(originalFlagInline)
    resetSettingsCache()
    rmSync(tempDir, { recursive: true, force: true })
  } finally {
    releaseSharedMutationLock()
  }
})

test('raw helper, per-model display, and session total share one custom price', () => {
  const model = 'provider/model:v1?profile=paid'
  const settingsPath = join(tempDir, 'settings.json')
  writeFileSync(
    settingsPath,
    `${JSON.stringify({
      modelPricing: {
        [model]: {
          inputTokens: 1,
          outputTokens: 2,
          promptCacheReadTokens: 3,
          promptCacheWriteTokens: 4,
          webSearchRequests: 5,
        },
      },
    })}\n`,
    'utf8',
  )
  setFlagSettingsPath(settingsPath)
  resetSettingsCache()

  const usage = {
    input_tokens: 1_000_000,
    output_tokens: 2_000_000,
    cache_read_input_tokens: 3_000_000,
    cache_creation_input_tokens: 4_000_000,
    server_tool_use: { web_search_requests: 2 },
  } as Parameters<typeof calculateUSDCost>[1]
  const cost = calculateUSDCost(model, usage)

  expect(cost).toBe(40)
  expect(
    calculateCostFromTokens(model, {
      inputTokens: 1_000_000,
      outputTokens: 2_000_000,
      cacheReadInputTokens: 3_000_000,
      cacheCreationInputTokens: 4_000_000,
    }),
  ).toBe(30)
  expect(addToTotalSessionCost(cost, usage, model)).toBe(40)
  expect(getTotalCost()).toBe(40)
  expect(getModelUsage()[model]).toMatchObject({
    inputTokens: 1_000_000,
    outputTokens: 2_000_000,
    cacheReadInputTokens: 3_000_000,
    cacheCreationInputTokens: 4_000_000,
    webSearchRequests: 2,
    costUSD: 40,
  })
  const display = formatTotalCost()
  expect(display).toContain('Total cost:            $40.00')
  expect(display).toContain('provider/model:v1?profile=paid:')
  expect(display).toContain('($40.00)')
  expect(hasUnknownModelCost()).toBe(false)
})

test('omitted web-search price uses the documented $0.01 request default', () => {
  const model = 'provider/model-with-default-web-price'
  const settingsPath = join(tempDir, 'settings.json')
  writeFileSync(
    settingsPath,
    `${JSON.stringify({
      modelPricing: {
        [model]: {
          inputTokens: 0,
          outputTokens: 0,
          promptCacheReadTokens: 0,
          promptCacheWriteTokens: 0,
        },
      },
    })}\n`,
    'utf8',
  )
  setFlagSettingsPath(settingsPath)
  resetSettingsCache()

  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    server_tool_use: { web_search_requests: 3 },
  } as Parameters<typeof calculateUSDCost>[1]
  expect(calculateUSDCost(model, usage)).toBeCloseTo(0.03)
})
