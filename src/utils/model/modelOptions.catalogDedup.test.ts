import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

import { resetModelStringsForTestingOnly } from '../../bootstrap/state.js'
import { acquireEnvMutex, releaseEnvMutex } from '../../entrypoints/sdk/shared.js'
import type { ModelCatalogEntry } from '../../integrations/descriptors.js'
import { saveGlobalConfig } from '../config.js'
import {
  resetSettingsCache,
  setSessionSettingsCache,
} from '../settings/settingsCache.js'
import * as actualIndex from '../../integrations/index.js'
import * as actualProviderConfig from '../../services/api/providerConfig.js'
import * as actualProviderProfiles from '../providerProfiles.js'
import * as actualProviders from './providers.js'
import * as actualModel from './model.js'
import type { ModelOption } from './modelOptions.js'

// Snapshot the real modules before any mock.module runs (same lesson as the
// 2026-04-30 mock-leak note in lessons_learned.md — bun live-repoints the
// `actual*` namespaces to the active mock, so these copies are the stable
// handle on the genuine implementations).
const realIndex = { ...actualIndex }
const realProviderConfig = { ...actualProviderConfig }
const realProviderProfiles = { ...actualProviderProfiles }
const realProviders = { ...actualProviders }
const realModel = { ...actualModel }

// bun's mock.module is process-wide and mock.restore() does NOT undo it, so
// each mock installed here is gated and falls through to the real
// implementation whenever its gate is null — a transparent passthrough for
// every other suite in the same `bun test` run.
let activeCatalogEntries: ModelCatalogEntry[] | null = null
let activeCacheScopeOverride: string | null = null
let activeProfileOverride: Partial<typeof actualProviderProfiles> | null = null
let activeOpenAIProvider = false
let activeModelOverride: typeof realModel | null = null
let modelMockRegistered = false
let catalogFetchCount = 0

mock.module('./providers.js', () => ({
  ...realProviders,
  getAPIProvider: () =>
    activeOpenAIProvider ? 'openai' : realProviders.getAPIProvider(),
  getAPIProviderForStatsig: () =>
    activeOpenAIProvider
      ? 'openai'
      : realProviders.getAPIProviderForStatsig(),
  isFirstPartyAnthropicBaseUrl: (...args: Parameters<typeof realProviders.isFirstPartyAnthropicBaseUrl>) =>
    activeOpenAIProvider
      ? false
      : realProviders.isFirstPartyAnthropicBaseUrl(...args),
  isFirstPartyAnthropicProvider: (...args: Parameters<typeof realProviders.isFirstPartyAnthropicProvider>) =>
    activeOpenAIProvider
      ? false
      : realProviders.isFirstPartyAnthropicProvider(...args),
  isCustomAnthropicProvider: (...args: Parameters<typeof realProviders.isCustomAnthropicProvider>) =>
    activeOpenAIProvider
      ? false
      : realProviders.isCustomAnthropicProvider(...args),
  isGithubNativeAnthropicMode: (...args: Parameters<typeof realProviders.isGithubNativeAnthropicMode>) =>
    activeOpenAIProvider
      ? false
      : realProviders.isGithubNativeAnthropicMode(...args),
  usesAnthropicAccountFlow: (...args: Parameters<typeof realProviders.usesAnthropicAccountFlow>) =>
    activeOpenAIProvider
      ? false
      : realProviders.usesAnthropicAccountFlow(...args),
}))

mock.module('../../integrations/index.js', () => ({
  ...realIndex,
  getCatalogEntriesForRoute: (...args: Parameters<typeof realIndex.getCatalogEntriesForRoute>) => {
    if (activeCatalogEntries !== null) {
      catalogFetchCount++
    }
    return activeCatalogEntries ?? realIndex.getCatalogEntriesForRoute(...args)
  },
}))

mock.module('../../services/api/providerConfig.js', () => ({
  ...realProviderConfig,
  getAdditionalModelOptionsCacheScope: () =>
    activeCacheScopeOverride ??
    realProviderConfig.getAdditionalModelOptionsCacheScope(),
}))

mock.module('../providerProfiles.js', () => ({
  ...realProviderProfiles,
  getActiveProviderProfile: (...args: Parameters<typeof realProviderProfiles.getActiveProviderProfile>) =>
    (activeProfileOverride?.getActiveProviderProfile ??
      realProviderProfiles.getActiveProviderProfile)(...args),
  getActiveOpenAIModelOptionsCache: () =>
    activeProfileOverride
      ? [{ value: 'cache-model', label: 'Cached', description: 'Cached' }]
      : realProviderProfiles.getActiveOpenAIModelOptionsCache(),
}))

async function importFreshModelOptionsModule() {
  const nonce = `${Date.now()}-${Math.random()}`
  const modelModule = await import(`./model.js?catalogDedup=${nonce}`)
  activeModelOverride = modelModule
  if (!modelMockRegistered) {
    mock.module('./model.js', () => activeModelOverride ?? realModel)
    modelMockRegistered = true
  }
  return import(`./modelOptions.js?ts=${nonce}`)
}

async function getRouteCatalogModelOptions(
  entries: ModelCatalogEntry[],
  model: string,
): Promise<ModelOption[]> {
  activeCatalogEntries = entries
  activeOpenAIProvider = true
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'
  process.env.OPENAI_API_KEY = 'sk-test'
  process.env.OPENAI_MODEL = model
  const { getModelOptions } = await importFreshModelOptionsModule()
  return getModelOptions()
}

const originalEnv = {
  CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  ANTHROPIC_CUSTOM_MODEL_OPTION: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION,
  ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME,
  ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION,
}

function restoreEnvValue(key: keyof typeof originalEnv): void {
  const value = originalEnv[key]
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

function resetGlobalConfig(): void {
  saveGlobalConfig(current => ({
    ...current,
    additionalModelOptionsCache: [],
    additionalModelOptionsCacheScope: undefined,
    openaiAdditionalModelOptionsCache: [],
    openaiAdditionalModelOptionsCacheByProfile: {},
    providerProfiles: [],
    activeProviderProfileId: undefined,
  }))
}

beforeEach(async () => {
  await acquireEnvMutex()
  mock.restore()
  activeCatalogEntries = null
  activeCacheScopeOverride = null
  activeProfileOverride = null
  activeOpenAIProvider = false
  activeModelOverride = null
  catalogFetchCount = 0
  setSessionSettingsCache({ settings: {}, errors: [] })
  for (const key of Object.keys(originalEnv) as (keyof typeof originalEnv)[]) {
    delete process.env[key]
  }
  resetModelStringsForTestingOnly()
  resetGlobalConfig()
})

afterEach(() => {
  try {
    mock.restore()
    activeCatalogEntries = null
    activeCacheScopeOverride = null
    activeProfileOverride = null
    activeOpenAIProvider = false
    activeModelOverride = null
    catalogFetchCount = 0
    resetSettingsCache()
    for (const key of Object.keys(originalEnv) as (keyof typeof originalEnv)[]) {
      restoreEnvValue(key)
    }
    resetGlobalConfig()
    resetModelStringsForTestingOnly()
  } finally {
    releaseEnvMutex()
  }
})

test('unique apiNames stay literal: ordinary model ids keep their apiName value', async () => {
  const options = await getRouteCatalogModelOptions(
    [
      { id: 'a', apiName: 'foo/bar', label: 'Foo Bar' },
      { id: 'b', apiName: 'x/y' },
    ],
    'foo/bar',
  )

  expect(options.map(option => option.value)).toEqual([null, 'foo/bar', 'x/y'])
  expect(options.find(option => option.value === 'foo/bar')).toMatchObject({
    label: 'Foo Bar',
    description: 'foo/bar',
  })
})

test('duplicate apiNames resolve to catalog ids so both models stay selectable', async () => {
  const options = await getRouteCatalogModelOptions(
    [
      { id: 'a', apiName: 'dup/api' },
      { id: 'b', apiName: 'dup/api' },
    ],
    'a',
  )

  expect(options.map(option => option.value)).toEqual([null, 'a', 'b'])
})

test('case and whitespace variants of an apiName count as duplicates', async () => {
  const options = await getRouteCatalogModelOptions(
    [
      { id: 'a', apiName: 'Dup/Api ' },
      { id: 'b', apiName: ' dup/api' },
    ],
    'a',
  )

  expect(options.map(option => option.value)).toEqual([null, 'a', 'b'])
})

test('trailing whitespace alone makes an apiName duplicate', async () => {
  const options = await getRouteCatalogModelOptions(
    [
      { id: 'a', apiName: 'foo/bar' },
      { id: 'b', apiName: 'foo/bar ' },
    ],
    'a',
  )

  expect(options.map(option => option.value)).toEqual([null, 'a', 'b'])
})

test('custom model matching a catalog alias resolves to the canonical entry without duplication', async () => {
  const options = await getRouteCatalogModelOptions(
    [{ id: 'a', apiName: 'real/name', aliases: ['alias-name'] }],
    'alias-name',
  )

  expect(options.map(option => option.value)).toEqual([null, 'real/name'])
})

test('env custom model outside the catalog is appended with its env label', async () => {
  process.env.ANTHROPIC_CUSTOM_MODEL_OPTION = 'my-custom'
  process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = 'My Custom'
  process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION = 'A custom endpoint'

  const options = await getRouteCatalogModelOptions(
    [{ id: 'a', apiName: 'real/name' }],
    'real/name',
  )

  expect(options.find(option => option.value === 'my-custom')).toMatchObject({
    label: 'My Custom',
    description: 'A custom endpoint',
  })
})

test('env custom model matching a catalog alias is not duplicated', async () => {
  process.env.ANTHROPIC_CUSTOM_MODEL_OPTION = 'alias-name'

  const options = await getRouteCatalogModelOptions(
    [{ id: 'a', apiName: 'real/name', aliases: ['alias-name'] }],
    'real/name',
  )

  expect(options.map(option => option.value)).toEqual([null, 'real/name'])
})

test('scoped additional options are canonicalized against the catalog and deduplicated', async () => {
  activeCacheScopeOverride = 'openai:http://localhost:1234/v1:catalog-dedup'
  activeProfileOverride = {
    getActiveProviderProfile: () => ({
      id: 'profile_scoped',
      name: 'Scoped',
      provider: 'openai',
      baseUrl: 'http://localhost:1234/v1',
      model: 'cache-model',
      apiKey: 'sk-test',
    }),
  }
  saveGlobalConfig(current => ({
    ...current,
    additionalModelOptionsCacheScope: 'openai:http://localhost:1234/v1:catalog-dedup',
    additionalModelOptionsCache: [
      { value: 'dup/api', label: 'Scoped Dup', description: 'Scoped Dup' },
      { value: 'standalone', label: 'Standalone', description: 'Standalone' },
    ],
  }))
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_API_KEY = 'sk-test'

  const options = await getRouteCatalogModelOptions(
    [
      { id: 'a', apiName: 'dup/api' },
      { id: 'b', apiName: 'dup/api' },
    ],
    'a',
  )

  expect(options.map(option => option.value)).toEqual([
    null,
    'cache-model',
    'a',
    'b',
    'standalone',
  ])
  expect(options.find(option => option.value === 'standalone')?.label).toBe(
    'Standalone',
  )
})

test('scoped additional option aliased to a catalog entry canonicalizes to the entry without duplicating it', async () => {
  activeCacheScopeOverride = 'openai:http://localhost:1234/v1:catalog-dedup'
  activeProfileOverride = {
    getActiveProviderProfile: () => ({
      id: 'profile_scoped',
      name: 'Scoped',
      provider: 'openai',
      baseUrl: 'http://localhost:1234/v1',
      model: 'cache-model',
      apiKey: 'sk-test',
    }),
  }
  saveGlobalConfig(current => ({
    ...current,
    additionalModelOptionsCacheScope: 'openai:http://localhost:1234/v1:catalog-dedup',
    additionalModelOptionsCache: [
      { value: 'alias-name', label: 'Alias Cached', description: 'Alias Cached' },
    ],
  }))
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_API_KEY = 'sk-test'

  const options = await getRouteCatalogModelOptions(
    [{ id: 'a', apiName: 'real/name', aliases: ['alias-name'] }],
    'real/name',
  )

  expect(options.map(option => option.value)).toEqual([
    null,
    'cache-model',
    'real/name',
  ])
  expect(options.filter(option => option.value === 'real/name')).toHaveLength(1)
  expect(options.some(option => option.value === 'alias-name')).toBe(false)
})

test('large catalogs with mixed duplicates resolve to ids without dropping unique models', async () => {
  const entries: ModelCatalogEntry[] = []
  for (let i = 0; i < 400; i++) {
    entries.push({ id: `u-${i}`, apiName: `uniq/model-${i}` })
  }
  for (let i = 0; i < 50; i++) {
    const apiName = `dup/model-${i}`
    const variant =
      i % 3 === 0
        ? ` DUP/MODEL-${i}`
        : i % 3 === 1
          ? `dup/model-${i} `
          : apiName
    entries.push({ id: `d-${i}-1`, apiName })
    entries.push({ id: `d-${i}-2`, apiName: variant })
  }

  activeOpenAIProvider = true
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'
  process.env.OPENAI_API_KEY = 'sk-test'
  process.env.OPENAI_MODEL = 'uniq/model-0'
  const { getModelOptions } = await importFreshModelOptionsModule()
  // The shared RouteCatalogContext eliminates per-lookup rescans: the whole
  // build performs a small fixed number of catalog fetches (base options plus
  // a handful of metadata/alias lookups) that never scales with catalog size —
  // a per-option rescan of this 500-entry fixture would fetch 500+ times.
  // Snapshot + delta are computed synchronously around the build so unrelated
  // suites sharing this process can't inflate the bound.
  const fetchesBefore = catalogFetchCount
  activeCatalogEntries = entries
  const options = getModelOptions()
  expect(catalogFetchCount - fetchesBefore).toBeLessThanOrEqual(20)

  const values = options.map(option => option.value)
  expect(values.length).toBe(501)
  for (let i = 0; i < 50; i++) {
    expect(values).toContain(`d-${i}-1`)
    expect(values).toContain(`d-${i}-2`)
    expect(values).not.toContain(`dup/model-${i}`)
  }
  expect(values).toContain('uniq/model-399')
  expect(values).not.toContain('u-0')
})
