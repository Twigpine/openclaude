import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, expect, mock, setSystemTime, test } from 'bun:test'
import React from 'react'

import { getAdditionalModelOptionsCacheScope } from '../../services/api/providerConfig.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import {
  resetSettingsCache,
  setSessionSettingsCache,
} from '../../utils/settings/settingsCache.js'
import { encodeSwitchProfileValue } from '../../utils/model/modelOptions.js'
import type { ModelOption } from '../../utils/model/modelOptions.js'
import type { ModelSetting } from '../../utils/model/model.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import type { ModelCatalogEntry } from '../../integrations/descriptors.js'
import {
  filterAvailableCatalogEntries,
  getRouteDescriptor,
} from '../../integrations/index.js'
import { mergeRouteCatalogEntries } from '../../utils/model/routeCatalogOptions.js'
import * as actualFastModeForModelTest from '../../utils/fastMode.js'
import * as actualExtraUsageForModelTest from '../../utils/extraUsage.js'

// Snapshot the real fast-mode module up front so the cross-profile switch test
// can mock it with a full surface and restore the real one afterwards.
const REAL_FAST_MODE_FOR_MODEL_TEST = { ...actualFastModeForModelTest }
// Same for extraUsage, so the cross-profile confirmation test can force the
// `Billed as extra usage` branch and restore the real surface afterwards.
const REAL_EXTRA_USAGE_FOR_MODEL_TEST = { ...actualExtraUsageForModelTest }

type SettingsModule = typeof import('../../utils/settings/settings.js')

const originalEnv = {
  CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
  CLAUDE_CODE_USE_GEMINI: process.env.CLAUDE_CODE_USE_GEMINI,
  CLAUDE_CODE_USE_GITHUB: process.env.CLAUDE_CODE_USE_GITHUB,
  CLAUDE_CODE_USE_MISTRAL: process.env.CLAUDE_CODE_USE_MISTRAL,
  CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK,
  CLAUDE_CODE_USE_VERTEX: process.env.CLAUDE_CODE_USE_VERTEX,
  CLAUDE_CODE_USE_FOUNDRY: process.env.CLAUDE_CODE_USE_FOUNDRY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_BASE: process.env.OPENAI_API_BASE,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_API_KEYS: process.env.OPENAI_API_KEYS,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  CMD_API_KEY: process.env.CMD_API_KEY,
  COMMANDCODE_API_KEY: process.env.COMMANDCODE_API_KEY,
  COMMAND_CODE_API_KEY: process.env.COMMAND_CODE_API_KEY,
  ANTHROPIC_CUSTOM_HEADERS: process.env.ANTHROPIC_CUSTOM_HEADERS,
  CLAUDE_CODE_EFFORT_LEVEL: process.env.CLAUDE_CODE_EFFORT_LEVEL,
  CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED:
    process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED,
  CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID:
    process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
}

async function importFreshModelModule(
  suffix: string,
): Promise<typeof import('./model.js')> {
  return import(`./model.js?${suffix}`) as Promise<
    typeof import('./model.js')
  >
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

async function expectModelCommandDoesNotWaitForRefresh(
  commandPromise: Promise<unknown>,
): Promise<unknown> {
  const result = await Promise.race([
    commandPromise,
    new Promise(resolve =>
      setTimeout(() => resolve(Symbol.for('openclaude.test.timeout')), 1_000),
    ),
  ])

  expect(result).not.toBe(Symbol.for('openclaude.test.timeout'))
  return result
}

type ProviderProfileModelPickerModeForTest = 'auto' | 'profile' | 'provider'
let actualSettingsModule: SettingsModule | undefined
let settingsForTest: SettingsJson & {
  providerProfileModelPickerMode?: ProviderProfileModelPickerModeForTest
} = {}
let scopedLocalOpenAIModelCacheState:
  | {
      additionalModelOptionsCache?: ModelOption[]
      additionalModelOptionsCacheScope?: string
    }
  | undefined

function useSettings(
  settings: SettingsJson & {
    providerProfileModelPickerMode?: ProviderProfileModelPickerModeForTest
  },
): void {
  settingsForTest = settings
  setSessionSettingsCache({ settings, errors: [] })
}

async function mockSettingsForTest(): Promise<void> {
  actualSettingsModule ??= await import(
    `../../utils/settings/settings.ts?modelCommandSettingsActual=${Date.now()}-${Math.random()}`
  )
  mock.module('../../utils/settings/settings.js', () => ({
    ...actualSettingsModule!,
    getInitialSettings: () => settingsForTest,
    getSettings_DEPRECATED: () => settingsForTest,
  }))
  mock.module('../../utils/model/modelAllowlist.js', () => ({
    isModelAllowed: isModelAllowedForTest,
  }))
}

function isModelAllowedForTest(model: string): boolean {
  const { availableModels } = settingsForTest
  if (!availableModels) {
    return true
  }
  if (availableModels.length === 0) {
    return false
  }

  const normalizedModel = model.trim().toLowerCase()
  return availableModels.some(
    allowed => allowed.trim().toLowerCase() === normalizedModel,
  )
}

function getConfiguredProfileModelOptionsForTest(profile: {
  model: string
  name: string
}) {
  return profile.model
    .split(/[;,]/)
    .map(model => model.trim())
    .filter(Boolean)
    .map(model => ({
      value: model,
      label: model,
      description: `Provider: ${profile.name}`,
    }))
}

function mockProviderProfiles(
  overrides: Partial<typeof import('../../utils/providerProfiles.js')> = {},
): void {
  const providerProfilesMock = {
    addProviderProfile: () => null,
    applyActiveProviderProfileFromConfig: () => undefined,
    clearActiveOpenAIModelOptionsCache: () => {},
    deleteProviderProfile: () => ({ removed: false }),
    getActiveOpenAIModelOptionsCache: () => [],
    getActiveOpenAIRouteModelOptionsCache: () => {
      const activeScope = getAdditionalModelOptionsCacheScope()
      return activeScope?.startsWith('openai:') &&
        scopedLocalOpenAIModelCacheState?.additionalModelOptionsCacheScope ===
          activeScope
        ? (scopedLocalOpenAIModelCacheState.additionalModelOptionsCache ?? [])
        : []
    },
    getActiveProviderProfile: () => undefined,
    getConfiguredProfileModelOptions: getConfiguredProfileModelOptionsForTest,
    getProfileModelOptions: () => [],
    getProviderPresetDefaults: () => ({
      provider: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
      requiresApiKey: true,
    }),
    getProviderProfiles: () => [],
    setActiveOpenAIRouteModelOptionsCache: (options: ModelOption[]) => {
      const activeScope = getAdditionalModelOptionsCacheScope()
      if (!activeScope?.startsWith('openai:')) {
        return
      }
      scopedLocalOpenAIModelCacheState = {
        ...(scopedLocalOpenAIModelCacheState ?? {}),
        additionalModelOptionsCache: options,
        additionalModelOptionsCacheScope: activeScope,
      }
    },
    setActiveOpenAIModelOptionsCache: () => {},
    setActiveProviderProfile: () => null,
    updateProviderProfile: () => null,
  } satisfies Partial<typeof import('../../utils/providerProfiles.js')>

  mock.module('../../utils/providerProfiles.js', () => ({
    ...providerProfilesMock,
    ...overrides,
  }))
}

beforeEach(async () => {
  await acquireSharedMutationLock('commands/model/model.test.tsx')
  mock.restore()
  settingsForTest = {}
  await mockSettingsForTest()
  scopedLocalOpenAIModelCacheState = undefined
  useSettings({} as SettingsJson)
})

afterEach(() => {
  try {
    mock.restore()
    resetSettingsCache()
    settingsForTest = {}
    restoreEnv('CLAUDE_CODE_USE_OPENAI', originalEnv.CLAUDE_CODE_USE_OPENAI)
    restoreEnv('CLAUDE_CODE_USE_GEMINI', originalEnv.CLAUDE_CODE_USE_GEMINI)
    restoreEnv('CLAUDE_CODE_USE_GITHUB', originalEnv.CLAUDE_CODE_USE_GITHUB)
    restoreEnv('CLAUDE_CODE_USE_MISTRAL', originalEnv.CLAUDE_CODE_USE_MISTRAL)
    restoreEnv('CLAUDE_CODE_USE_BEDROCK', originalEnv.CLAUDE_CODE_USE_BEDROCK)
    restoreEnv('CLAUDE_CODE_USE_VERTEX', originalEnv.CLAUDE_CODE_USE_VERTEX)
    restoreEnv('CLAUDE_CODE_USE_FOUNDRY', originalEnv.CLAUDE_CODE_USE_FOUNDRY)
    restoreEnv('OPENAI_BASE_URL', originalEnv.OPENAI_BASE_URL)
    restoreEnv('OPENAI_API_BASE', originalEnv.OPENAI_API_BASE)
    restoreEnv('OPENAI_API_KEY', originalEnv.OPENAI_API_KEY)
    restoreEnv('OPENAI_API_KEYS', originalEnv.OPENAI_API_KEYS)
    restoreEnv('OPENROUTER_API_KEY', originalEnv.OPENROUTER_API_KEY)
    restoreEnv('OPENAI_MODEL', originalEnv.OPENAI_MODEL)
    restoreEnv('CMD_API_KEY', originalEnv.CMD_API_KEY)
    restoreEnv('COMMANDCODE_API_KEY', originalEnv.COMMANDCODE_API_KEY)
    restoreEnv('COMMAND_CODE_API_KEY', originalEnv.COMMAND_CODE_API_KEY)
    restoreEnv('ANTHROPIC_CUSTOM_HEADERS', originalEnv.ANTHROPIC_CUSTOM_HEADERS)
    restoreEnv('CLAUDE_CODE_EFFORT_LEVEL', originalEnv.CLAUDE_CODE_EFFORT_LEVEL)
    restoreEnv(
      'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED',
      originalEnv.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED,
    )
    restoreEnv(
      'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID',
      originalEnv.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID,
    )
    restoreEnv(
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      originalEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
    )
  } finally {
    releaseSharedMutationLock()
  }
})

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return
    }
    await Bun.sleep(10)
  }

  throw new Error('Timed out waiting for condition')
}

type CapturedModelPickerPropsForTest = {
  discoveryState?: { message?: string; tone?: string }
  onRefresh?: () => void
  optionsOverride?: unknown
}

type DiscoveryModelForTest = {
  apiName: string
  default?: boolean
  id: string
  label?: string
}

function mockDescriptorDiscovery(options: {
  cachedModels: DiscoveryModelForTest[]
  discoveredModels?: DiscoveryModelForTest[]
  routeId?: string
}): void {
  mock.module('../../integrations/discoveryCache.js', () => ({
    clearDiscoveryCache: mock(async () => {}),
    getCachedModels: mock(async () => ({
      models: options.cachedModels,
      updatedAt: Date.now(),
      error: null,
    })),
    isCacheStale: mock(async () => false),
    parseDurationString: (value: number | string) =>
      typeof value === 'number' ? value : 86_400_000,
  }))
  mock.module('../../integrations/discoveryService.js', () => ({
    getDiscoveryCacheKey: (
      routeId: string,
      requestOptions?: {
        apiKey?: string
        baseUrl?: string
        headers?: Record<string, string>
      },
    ) => `${routeId}|${requestOptions?.baseUrl ?? ''}|${requestOptions?.apiKey ?? ''}|${JSON.stringify(requestOptions?.headers ?? {})}`,
    discoverModelsForRoute: mock(async () => {
      const routeId = options.routeId ?? 'openrouter'
      const rawStatic = getRouteDescriptor(routeId)?.catalog?.models ?? []
      const discovered = (options.discoveredModels ?? options.cachedModels) as ModelCatalogEntry[]
      const merged = filterAvailableCatalogEntries(
        mergeRouteCatalogEntries(rawStatic, discovered),
      )
      return {
        routeId,
        models: merged,
        stale: false,
        error: null,
        source: 'network',
      }
    }),
    probeRouteReadiness: mock(async () => null),
  }))
}

async function mockScopedLocalOpenAIModelCache(
  initialOptions: ModelOption[],
): Promise<{
  getState: () => {
    additionalModelOptionsCache?: ModelOption[]
    additionalModelOptionsCacheScope?: string
  }
}> {
  const actualConfig = await import('../../utils/config.js')
  const activeScope = getAdditionalModelOptionsCacheScope()
  scopedLocalOpenAIModelCacheState = {
    additionalModelOptionsCache: initialOptions,
    additionalModelOptionsCacheScope: activeScope ?? undefined,
  }
  let state = {
    ...actualConfig.getGlobalConfig(),
    additionalModelOptionsCache: initialOptions,
    additionalModelOptionsCacheScope: activeScope ?? undefined,
  }

  mock.module('../../utils/config.js', () => ({
    ...actualConfig,
    getGlobalConfig: () => state,
    saveGlobalConfig: (
      updater: (current: typeof state) => typeof state,
    ) => {
      state = updater(state)
    },
  }))

  return {
    getState: () => scopedLocalOpenAIModelCacheState ?? state,
  }
}

async function renderModelCommandWithCapturedPicker(
  suffix: string,
  options?: {
    initialState?: unknown
    onDone?: (message?: string, options?: { display?: string }) => void
  },
): Promise<{
  getCapturedProps: () => CapturedModelPickerPropsForTest
  instance: Awaited<ReturnType<typeof import('../../ink.js')['render']>>
  stdout: PassThrough
}> {
  let capturedProps: CapturedModelPickerPropsForTest | undefined
  mock.module('../../components/ModelPicker.js', () => ({
    ModelPicker: function MockModelPicker(
      props: CapturedModelPickerPropsForTest,
    ): React.ReactNode {
      capturedProps = props
      return null
    },
  }))

  const { call } = await importFreshModelModule(suffix)
  const element = await call(options?.onDone ?? (() => {}), {} as never, '')
  const { AppStateProvider } = await import('../../state/AppState.js')
  const { render } = await import('../../ink.js')
  const stdout = new PassThrough()
  ;(stdout as unknown as { columns: number }).columns = 120
  const instance = await render(
    <AppStateProvider initialState={options?.initialState as never}>
      {element}
    </AppStateProvider>,
    stdout as unknown as NodeJS.WriteStream,
  )

  await waitForCondition(() => capturedProps !== undefined)

  return {
    getCapturedProps: () => {
      if (!capturedProps) {
        throw new Error('ModelPicker props were not captured')
      }
      return capturedProps
    },
    instance,
    stdout,
  }
}

test('opens the model picker without awaiting local model discovery refresh', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.OPENAI_API_BASE
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:8080/v1'
  process.env.OPENAI_MODEL = 'qwen2.5-coder-7b-instruct'

  const discoverOpenAICompatibleModelOptions = mock(
    async () => {
      await new Promise(resolve => setTimeout(resolve, 1_000))
      return []
    },
  )

  mock.module('../../utils/model/openaiModelDiscovery.js', () => ({
    discoverOpenAICompatibleModelOptions,
  }))

  expect(
    getAdditionalModelOptionsCacheScope()?.startsWith(
      'openai:http://127.0.0.1:8080/v1:',
    ),
  ).toBe(true)

  // Use a fresh module instance so per-test mocks stay local to this test.
  const { call } = await importFreshModelModule('local-discovery')
  await expectModelCommandDoesNotWaitForRefresh(call(() => {}, {} as never, ''))
})

test('/model current reports the effective effort when env overrides session ultracode', async () => {
  const { call } = await importFreshModelModule('current-effective-effort')
  const { AppStateProvider, getDefaultAppState } = await import('../../state/AppState.js')
  const { render } = await import('../../ink.js')
  const messages: string[] = []
  const stdout = new PassThrough()
  ;(stdout as unknown as { columns: number }).columns = 120

  process.env.CLAUDE_CODE_EFFORT_LEVEL = 'high'
  const element = await call(
    result => {
      if (result) messages.push(result)
    },
    {} as never,
    'current',
  )

  const instance = await render(
    <AppStateProvider
      initialState={{
        ...getDefaultAppState(),
        mainLoopModel: 'claude-opus-4-8',
        effortValue: 'ultracode',
      }}
    >
      {element}
    </AppStateProvider>,
    stdout as unknown as NodeJS.WriteStream,
  )

  await waitForCondition(() => messages.length > 0)
  instance.unmount()
  stdout.end()

  expect(messages[0]).toContain('(effort: high)')
  expect(messages[0]).not.toContain('(effort: ultracode)')
})

test('/model current resolves effort against the active session model', async () => {
  const { call } = await importFreshModelModule('current-session-model-effort')
  const { AppStateProvider, getDefaultAppState } = await import('../../state/AppState.js')
  const { render } = await import('../../ink.js')
  const messages: string[] = []
  const stdout = new PassThrough()
  ;(stdout as unknown as { columns: number }).columns = 120

  delete process.env.CLAUDE_CODE_EFFORT_LEVEL
  const element = await call(
    result => {
      if (result) messages.push(result)
    },
    {} as never,
    'current',
  )

  const instance = await render(
    <AppStateProvider
      initialState={{
        ...getDefaultAppState(),
        mainLoopModel: 'claude-opus-4-8',
        mainLoopModelForSession: 'claude-sonnet-4-6',
        effortValue: 'ultracode',
      }}
    >
      {element}
    </AppStateProvider>,
    stdout as unknown as NodeJS.WriteStream,
  )

  await waitForCondition(() => messages.length > 0)
  instance.unmount()
  stdout.end()

  expect(messages[0]).toContain('Current model:')
  expect(messages[0]).toContain('session override from plan mode')
  expect(messages[0]).toContain('Base model:')
  expect(messages[0]).toContain('(effort: high)')
  expect(messages[0]).not.toContain('(effort: xhigh)')
})

test.each(['sonnet', 'sonnet?reasoning=high'])(
  '/model rejects Claude alias %s on the active Command Code route',
  async rejectedModel => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'https://api.commandcode.ai/provider/v1'
    process.env.OPENAI_MODEL = 'deepseek/deepseek-v4-flash'
    process.env.CMD_API_KEY = 'cmd-key'
    delete process.env.COMMANDCODE_API_KEY
    delete process.env.CLAUDE_CODE_USE_GEMINI
    delete process.env.CLAUDE_CODE_USE_GITHUB
    delete process.env.CLAUDE_CODE_USE_MISTRAL
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY
    delete process.env.OPENAI_API_BASE

    const { call } = await importFreshModelModule(
      `commandcode-reject-${rejectedModel}`,
    )
    const { AppStateProvider, getDefaultAppState } = await import(
      '../../state/AppState.js'
    )
    const { render } = await import('../../ink.js')
    const messages: string[] = []
    const stdout = new PassThrough()
    ;(stdout as unknown as { columns: number }).columns = 120

    const element = await call(
      result => {
        if (result) messages.push(result)
      },
      {} as never,
      rejectedModel,
    )

    const instance = await render(
      <AppStateProvider
        initialState={{
          ...getDefaultAppState(),
          mainLoopModel: 'deepseek/deepseek-v4-flash',
        }}
      >
        {element}
      </AppStateProvider>,
      stdout as unknown as NodeJS.WriteStream,
    )

    try {
      await waitForCondition(() => messages.length > 0)
    } finally {
      instance.unmount()
      stdout.end()
    }

    expect(messages[0]).toContain('requires the Anthropic Messages protocol')
    expect(messages[0]).not.toContain('Set model to')
  },
)

test('/model still applies a Claude alias on a non-Command-Code OpenAI route', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:8080/v1'
  process.env.OPENAI_MODEL = 'qwen2.5-coder-7b-instruct'
  delete process.env.CMD_API_KEY
  delete process.env.COMMANDCODE_API_KEY
  delete process.env.OPENAI_API_BASE
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY

  const { call } = await importFreshModelModule('openai-compat-apply-sonnet-alias')
  const { AppStateProvider, getDefaultAppState } = await import(
    '../../state/AppState.js'
  )
  const { render } = await import('../../ink.js')
  const messages: string[] = []
  const stdout = new PassThrough()
  ;(stdout as unknown as { columns: number }).columns = 120

  const element = await call(
    result => {
      if (result) messages.push(result)
    },
    {} as never,
    'sonnet',
  )

  const instance = await render(
    <AppStateProvider
      initialState={{
        ...getDefaultAppState(),
        mainLoopModel: 'qwen2.5-coder-7b-instruct',
      }}
    >
      {element}
    </AppStateProvider>,
    stdout as unknown as NodeJS.WriteStream,
  )

  try {
    await waitForCondition(() => messages.length > 0)
  } finally {
    instance.unmount()
    stdout.end()
  }

  expect(messages[0]).toContain('Set model to')
  expect(messages[0]).not.toContain('requires the Anthropic Messages protocol')
})

test('opens the model picker without awaiting descriptor-backed route refresh', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'
  process.env.OPENAI_API_KEY = 'sk-openrouter'
  delete process.env.OPENROUTER_API_KEY
  process.env.OPENAI_MODEL = 'openai/gpt-5-mini'
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.OPENAI_API_BASE

  mock.module('../../integrations/discoveryCache.js', () => ({
    clearDiscoveryCache: mock(async () => {}),
    getCachedModels: mock(async () => ({
      models: [{ id: 'cached-qwen', apiName: 'qwen/qwen3-32b' }],
      updatedAt: Date.now() - 86_400_000,
      error: null,
    })),
    isCacheStale: mock(async () => true),
    parseDurationString: (value: number | string) =>
      typeof value === 'number' ? value : 86_400_000,
  }))

  mock.module('../../integrations/discoveryService.js', () => ({
    getDiscoveryCacheKey: (
      routeId: string,
      options?: { apiKey?: string; baseUrl?: string; headers?: Record<string, string> },
    ) => `${routeId}|${options?.baseUrl ?? ''}|${options?.apiKey ?? ''}|${JSON.stringify(options?.headers ?? {})}`,
    discoverModelsForRoute: mock(
      () =>
        new Promise(() => {
          // Intentionally unresolved; refresh should happen after the picker opens.
        }),
    ),
  }))

  mockProviderProfiles({
    getActiveOpenAIModelOptionsCache: () => [],
    getActiveProviderProfile: () => undefined,
    getProfileModelOptions: () => [],
    setActiveOpenAIModelOptionsCache: () => {},
  })

  const { call } = await importFreshModelModule('descriptor-refresh-open')
  await expectModelCommandDoesNotWaitForRefresh(call(() => {}, {} as never, ''))
})

test('shouldAutoRefreshRouteCatalog respects discovery refresh modes', async () => {
  const { shouldAutoRefreshRouteCatalog } =
    await importFreshModelModule('descriptor-refresh-modes')

  expect(
    shouldAutoRefreshRouteCatalog({
      catalog: {
        source: 'dynamic',
        discovery: { kind: 'openai-compatible' },
        discoveryRefreshMode: 'manual',
      },
      hasCachedModels: true,
      staticEntryCount: 0,
      stale: true,
    }),
  ).toBe(false)

  expect(
    shouldAutoRefreshRouteCatalog({
      catalog: {
        source: 'dynamic',
        discovery: { kind: 'openai-compatible' },
        discoveryRefreshMode: 'on-open',
      },
      hasCachedModels: true,
      staticEntryCount: 1,
      stale: false,
    }),
  ).toBe(true)

  expect(
    shouldAutoRefreshRouteCatalog({
      catalog: {
        source: 'dynamic',
        discovery: { kind: 'openai-compatible' },
        discoveryRefreshMode: 'startup',
      },
      hasCachedModels: true,
      staticEntryCount: 0,
      stale: true,
    }),
  ).toBe(false)
})

test('descriptor model options include active profile configured models', async () => {
  const activeProfile = {
    id: 'mistral-profile',
    name: 'Mistral AI',
    provider: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'devstral-latest, mistral-medium-latest',
    apiKey: 'sk-mistral',
  }
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID = activeProfile.id

  mockProviderProfiles({
    getActiveOpenAIModelOptionsCache: () => [],
    getActiveProviderProfile: () => activeProfile,
    getProfileModelOptions: () => [
      {
        value: 'devstral-latest',
        label: 'devstral-latest',
        description: 'Provider: Mistral AI',
      },
      {
        value: 'mistral-medium-latest',
        label: 'mistral-medium-latest',
        description: 'Provider: Mistral AI',
      },
    ],
    setActiveOpenAIModelOptionsCache: () => {},
  })

  const { mergeActiveProfileModelOptions } =
    await importFreshModelModule('descriptor-profile-model-merge')

  expect(
    mergeActiveProfileModelOptions(
      'mistral',
      [
        {
          value: 'devstral-latest',
          label: 'Devstral Latest',
          description: 'Recommended · Provider: Mistral AI',
        },
      ],
    ),
  ).toEqual([
    {
      value: 'devstral-latest',
      label: 'Devstral Latest',
      description: 'Recommended · Provider: Mistral AI',
    },
    {
      value: 'mistral-medium-latest',
      label: 'mistral-medium-latest',
      description: 'Provider: Mistral AI',
    },
  ])
})

test('descriptor model options omit route defaults outside active profile models', async () => {
  const activeProfile = {
    id: 'mistral-profile',
    name: 'Mistral AI',
    provider: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-medium-latest, mistral-small-latest',
    apiKey: 'sk-mistral',
  }
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID = activeProfile.id

  mockProviderProfiles({
    getActiveOpenAIModelOptionsCache: () => [],
    getActiveProviderProfile: () => activeProfile,
    getProfileModelOptions: () => [
      {
        value: 'mistral-medium-latest',
        label: 'mistral-medium-latest',
        description: 'Provider: Mistral AI',
      },
      {
        value: 'mistral-small-latest',
        label: 'mistral-small-latest',
        description: 'Provider: Mistral AI',
      },
    ],
    setActiveOpenAIModelOptionsCache: () => {},
  })

  const { mergeActiveProfileModelOptions } =
    await importFreshModelModule('descriptor-profile-model-filter')

  expect(
    mergeActiveProfileModelOptions(
      'mistral',
      [
        {
          value: 'devstral-latest',
          label: 'Devstral Latest',
          description: 'Recommended · Provider: Mistral AI',
        },
        {
          value: 'mistral-small-latest',
          label: 'Mistral Small Latest',
          description: 'Provider: Mistral AI',
        },
      ],
    ),
  ).toEqual([
    {
      value: 'mistral-medium-latest',
      label: 'mistral-medium-latest',
      description: 'Provider: Mistral AI',
    },
    {
      value: 'mistral-small-latest',
      label: 'Mistral Small Latest',
      description: 'Provider: Mistral AI',
    },
  ])
})

test('descriptor model options preserve discovered route models for discovery-backed active profiles', async () => {
  const activeProfile = {
    id: 'openrouter-profile',
    name: 'OpenRouter',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-oss-120b:free',
    apiKey: 'sk-openrouter',
  }
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID = activeProfile.id

  mockProviderProfiles({
    getActiveOpenAIModelOptionsCache: () => [],
    getActiveProviderProfile: () => activeProfile,
    getProfileModelOptions: () => [
      {
        value: 'openai/gpt-oss-120b:free',
        label: 'openai/gpt-oss-120b:free',
        description: 'Provider: OpenRouter',
      },
    ],
    setActiveOpenAIModelOptionsCache: () => {},
  })

  const { mergeActiveProfileModelOptions } =
    await importFreshModelModule('descriptor-profile-model-discovery-merge')

  expect(
    mergeActiveProfileModelOptions(
      'openrouter',
      [
        {
          value: 'openai/gpt-oss-120b:free',
          label: 'GPT OSS 120B Free',
          description: 'Provider: OpenRouter',
        },
        {
          value: 'openai/gpt-5',
          label: 'GPT-5',
          description: 'Provider: OpenRouter',
        },
        {
          value: 'anthropic/claude-sonnet-4',
          label: 'Claude Sonnet 4',
          description: 'Provider: OpenRouter',
        },
      ],
      { profileModelSurface: 'provider' },
    ),
  ).toEqual([
    {
      value: 'openai/gpt-oss-120b:free',
      label: 'GPT OSS 120B Free',
      description: 'Provider: OpenRouter',
    },
    {
      value: 'openai/gpt-5',
      label: 'GPT-5',
      description: 'Provider: OpenRouter',
    },
    {
      value: 'anthropic/claude-sonnet-4',
      label: 'Claude Sonnet 4',
      description: 'Provider: OpenRouter',
    },
  ])
})

test('native vendor routes show the full catalog regardless of the profile model', async () => {
  const activeProfile = {
    id: 'minimax-profile',
    name: 'MiniMax',
    provider: 'minimax',
    baseUrl: 'https://api.minimax.io/anthropic',
    model: 'MiniMax-M2.7',
    apiKey: 'sk-minimax',
  }
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID = activeProfile.id

  mockProviderProfiles({
    getActiveProviderProfile: () => activeProfile,
    getProfileModelOptions: () =>
      getConfiguredProfileModelOptionsForTest(activeProfile),
  })

  const { mergeActiveProfileModelOptions } =
    await importFreshModelModule('native-vendor-full-catalog')

  const routeOptions = [
    { value: 'MiniMax-M2.7', label: 'MiniMax M2.7', description: '256K context' },
    { value: 'MiniMax-M3', label: 'MiniMax M3', description: '1M context' },
  ]

  const merged = mergeActiveProfileModelOptions('minimax', routeOptions)
  const values = merged.map(option => option.value)

  expect(values).toContain('MiniMax-M2.7')
  expect(values).toContain('MiniMax-M3')
})

test('auto profile model picker mode uses explicit multi-model profiles as the picker surface', async () => {
  const activeProfile = {
    id: 'mistral-profile',
    name: 'Mistral AI',
    provider: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-medium-latest, mistral-small-latest',
    apiKey: 'sk-mistral',
  }
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID = activeProfile.id

  mockProviderProfiles({
    getActiveProviderProfile: () => activeProfile,
    getProfileModelOptions: () => [
      ...getConfiguredProfileModelOptionsForTest(activeProfile),
      {
        value: 'devstral-latest',
        label: 'Devstral Latest',
        description: 'Cached discovery result that is not explicitly configured',
      },
    ],
  })

  const { mergeActiveProfileModelOptions } = await importFreshModelModule(
    'descriptor-profile-model-auto-profile',
  )

  expect(
    mergeActiveProfileModelOptions(
      'mistral',
      [
        {
          value: 'devstral-latest',
          label: 'Devstral Latest',
          description: 'Recommended · Provider: Mistral AI',
        },
        {
          value: 'mistral-small-latest',
          label: 'Mistral Small Latest',
          description: 'Provider: Mistral AI',
        },
      ],
      { profileModelSurface: 'profile' },
    ),
  ).toEqual([
    {
      value: 'mistral-medium-latest',
      label: 'mistral-medium-latest',
      description: 'Provider: Mistral AI',
    },
    {
      value: 'mistral-small-latest',
      label: 'Mistral Small Latest',
      description: 'Provider: Mistral AI',
    },
  ])
})

test('provider profile model picker surface keeps static route catalogs for single-default profiles', async () => {
  const activeProfile = {
    id: 'opengateway-profile',
    name: 'Twigpine Opengateway',
    provider: 'gitlawb-opengateway',
    baseUrl: 'https://opengateway.gitlawb.com/v1',
    model: 'mimo-v2.5-pro',
    apiKey: 'sk-opengateway',
  }
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID = activeProfile.id

  mockProviderProfiles({
    getActiveProviderProfile: () => activeProfile,
    getProfileModelOptions: () =>
      getConfiguredProfileModelOptionsForTest(activeProfile),
  })

  const { mergeActiveProfileModelOptions } = await importFreshModelModule(
    'descriptor-profile-model-provider-static',
  )

  expect(
    mergeActiveProfileModelOptions(
      'gitlawb-opengateway',
      [
        {
          value: 'mimo-v2.5-pro',
          label: 'MiMo v2.5 Pro',
          description: 'Recommended · Provider: Twigpine Opengateway',
        },
        {
          value: 'mimo-v2-pro',
          label: 'MiMo v2 Pro',
          description: 'Provider: Twigpine Opengateway',
        },
      ],
      { profileModelSurface: 'provider' },
    ),
  ).toEqual([
    {
      value: 'mimo-v2.5-pro',
      label: 'MiMo v2.5 Pro',
      description: 'Recommended · Provider: Twigpine Opengateway',
    },
    {
      value: 'mimo-v2-pro',
      label: 'MiMo v2 Pro',
      description: 'Provider: Twigpine Opengateway',
    },
  ])
})

test('provider profile model picker surface keeps discovered catalogs and appends profile-only custom models', async () => {
  const activeProfile = {
    id: 'openrouter-profile',
    name: 'OpenRouter',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'custom/private-model',
    apiKey: 'sk-openrouter',
  }
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID = activeProfile.id

  mockProviderProfiles({
    getActiveProviderProfile: () => activeProfile,
    getProfileModelOptions: () =>
      getConfiguredProfileModelOptionsForTest(activeProfile),
  })

  const { mergeActiveProfileModelOptions } = await importFreshModelModule(
    'descriptor-profile-model-provider-discovery',
  )

  expect(
    mergeActiveProfileModelOptions(
      'openrouter',
      [
        {
          value: 'openai/gpt-oss-120b:free',
          label: 'GPT OSS 120B Free',
          description: 'Provider: OpenRouter',
        },
        {
          value: 'openai/gpt-5',
          label: 'GPT-5',
          description: 'Provider: OpenRouter',
        },
      ],
      { profileModelSurface: 'provider' },
    ),
  ).toEqual([
    {
      value: 'openai/gpt-oss-120b:free',
      label: 'GPT OSS 120B Free',
      description: 'Provider: OpenRouter',
    },
    {
      value: 'openai/gpt-5',
      label: 'GPT-5',
      description: 'Provider: OpenRouter',
    },
    {
      value: 'custom/private-model',
      label: 'custom/private-model',
      description: 'Provider: OpenRouter',
    },
  ])
})

test('resolveProviderProfileModelSurface honors explicit settings and auto mode', async () => {
  const { resolveProviderProfileModelSurface } = await importFreshModelModule(
    'descriptor-profile-model-surface-resolution',
  )
  const singleModelProfile = {
    id: 'openrouter-profile',
    name: 'OpenRouter',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-oss-120b:free',
    apiKey: 'sk-openrouter',
  }
  const multiModelProfile = {
    ...singleModelProfile,
    model: 'mistral-medium-latest, mistral-small-latest',
  }

  expect(
    resolveProviderProfileModelSurface({
      activeProfile: singleModelProfile,
      settingsMode: 'auto',
    }),
  ).toBe('provider')
  expect(
    resolveProviderProfileModelSurface({
      activeProfile: multiModelProfile,
      settingsMode: 'auto',
    }),
  ).toBe('profile')
  expect(
    resolveProviderProfileModelSurface({
      activeProfile: multiModelProfile,
      routeId: 'minimax',
      settingsMode: 'auto',
    }),
  ).toBe('provider')
  expect(
    resolveProviderProfileModelSurface({
      activeProfile: singleModelProfile,
      settingsMode: 'profile',
    }),
  ).toBe('profile')
  expect(
    resolveProviderProfileModelSurface({
      activeProfile: multiModelProfile,
      settingsMode: 'provider',
    }),
  ).toBe('provider')
})

test('provider profile model picker mode override keeps catalog first for multi-model profiles', async () => {
  const activeProfile = {
    id: 'mistral-profile',
    name: 'Mistral AI',
    provider: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-medium-latest, mistral-small-latest',
    apiKey: 'sk-mistral',
  }
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID = activeProfile.id

  mockProviderProfiles({
    getActiveProviderProfile: () => activeProfile,
  })

  const {
    mergeActiveProfileModelOptions,
    resolveProviderProfileModelSurface,
  } = await importFreshModelModule('descriptor-profile-model-provider-override')
  const profileModelSurface = resolveProviderProfileModelSurface({
    activeProfile,
    settingsMode: 'provider',
  })

  expect(
    mergeActiveProfileModelOptions(
      'mistral',
      [
        {
          value: 'devstral-latest',
          label: 'Devstral Latest',
          description: 'Recommended · Provider: Mistral AI',
        },
        {
          value: 'mistral-small-latest',
          label: 'Mistral Small Latest',
          description: 'Provider: Mistral AI',
        },
      ],
      { profileModelSurface },
    ),
  ).toEqual([
    {
      value: 'devstral-latest',
      label: 'Devstral Latest',
      description: 'Recommended · Provider: Mistral AI',
    },
    {
      value: 'mistral-small-latest',
      label: 'Mistral Small Latest',
      description: 'Provider: Mistral AI',
    },
    {
      value: 'mistral-medium-latest',
      label: 'mistral-medium-latest',
      description: 'Provider: Mistral AI',
    },
  ])
})

test('/model applies providerProfileModelPickerMode profile override on descriptor picker load', async () => {
  useSettings({
    providerProfileModelPickerMode: 'profile',
  } as SettingsJson & {
    providerProfileModelPickerMode: ProviderProfileModelPickerModeForTest
  })
  const activeProfile = {
    id: 'openrouter-profile',
    name: 'OpenRouter',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-oss-120b:free',
    apiKey: 'sk-openrouter',
  }
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = activeProfile.baseUrl
  process.env.OPENAI_API_KEY = activeProfile.apiKey
  delete process.env.OPENROUTER_API_KEY
  process.env.OPENAI_MODEL = activeProfile.model
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID = activeProfile.id
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.OPENAI_API_BASE

  mock.module('../../integrations/discoveryCache.js', () => ({
    clearDiscoveryCache: mock(async () => {}),
    getCachedModels: mock(async () => ({
      models: [
        { id: 'profile-model', apiName: activeProfile.model },
        { id: 'other-model', apiName: 'openai/gpt-5' },
      ],
      updatedAt: Date.now(),
      error: null,
    })),
    isCacheStale: mock(async () => false),
    parseDurationString: (value: number | string) =>
      typeof value === 'number' ? value : 86_400_000,
  }))
  mock.module('../../integrations/discoveryService.js', () => ({
    getDiscoveryCacheKey: (
      routeId: string,
      options?: { apiKey?: string; baseUrl?: string; headers?: Record<string, string> },
    ) => `${routeId}|${options?.baseUrl ?? ''}|${options?.apiKey ?? ''}|${JSON.stringify(options?.headers ?? {})}`,
    discoverModelsForRoute: mock(async () => ({
      routeId: 'openrouter',
      models: [],
      stale: false,
      error: null,
      source: 'network',
    })),
    probeRouteReadiness: mock(async () => null),
  }))
  mockProviderProfiles({
    getActiveProviderProfile: () => activeProfile,
  })

  let capturedOptions: unknown
  mock.module('../../components/ModelPicker.js', () => ({
    ModelPicker: function MockModelPicker(props: {
      optionsOverride?: unknown
    }): React.ReactNode {
      capturedOptions = props.optionsOverride
      return null
    },
  }))

  const { call } = await importFreshModelModule(
    'descriptor-picker-settings-profile-mode',
  )
  const element = await call(() => {}, {} as never, '')
  const { AppStateProvider } = await import('../../state/AppState.js')
  const { render } = await import('../../ink.js')
  const stdout = new PassThrough()
  ;(stdout as unknown as { columns: number }).columns = 120
  const instance = await render(
    <AppStateProvider>{element}</AppStateProvider>,
    stdout as unknown as NodeJS.WriteStream,
  )

  try {
    await waitForCondition(() => capturedOptions !== undefined)
  } finally {
    instance.unmount()
    stdout.end()
  }

  expect(capturedOptions).toEqual([
    {
      value: activeProfile.model,
      label: activeProfile.model,
      description: 'Provider: OpenRouter',
      descriptionForModel: 'Provider: OpenRouter',
    },
  ])
})

test('/model applies auto profile surface for multi-model descriptor profiles', async () => {
  const activeProfile = {
    id: 'openrouter-profile',
    name: 'OpenRouter',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-oss-120b:free, custom/private-model',
    apiKey: 'sk-openrouter',
  }
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = activeProfile.baseUrl
  process.env.OPENAI_API_KEY = activeProfile.apiKey
  delete process.env.OPENROUTER_API_KEY
  process.env.OPENAI_MODEL = 'openai/gpt-oss-120b:free'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID = activeProfile.id
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.OPENAI_API_BASE

  mockDescriptorDiscovery({
    cachedModels: [
      { id: 'profile-model', apiName: 'openai/gpt-oss-120b:free' },
      { id: 'other-model', apiName: 'openai/gpt-5' },
    ],
  })
  mockProviderProfiles({
    getActiveProviderProfile: () => activeProfile,
  })

  const rendered = await renderModelCommandWithCapturedPicker(
    'descriptor-picker-auto-profile-mode',
  )
  try {
    expect(rendered.getCapturedProps().optionsOverride).toEqual([
      {
        value: 'openai/gpt-oss-120b:free',
        label: 'openai/gpt-oss-120b:free',
        description: 'Provider: OpenRouter',
        descriptionForModel: 'Provider: OpenRouter',
      },
      {
        value: 'custom/private-model',
        label: 'custom/private-model',
        description: 'Provider: OpenRouter',
      },
    ])
  } finally {
    rendered.instance.unmount()
    rendered.stdout.end()
  }
})

test('/model applies auto provider surface for single-model descriptor profiles', async () => {
  const activeProfile = {
    id: 'openrouter-profile',
    name: 'OpenRouter',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-oss-120b:free',
    apiKey: 'sk-openrouter',
  }
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = activeProfile.baseUrl
  process.env.OPENAI_API_KEY = activeProfile.apiKey
  delete process.env.OPENROUTER_API_KEY
  process.env.OPENAI_MODEL = activeProfile.model
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID = activeProfile.id
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.OPENAI_API_BASE

  mockDescriptorDiscovery({
    cachedModels: [
      { id: 'profile-model', apiName: activeProfile.model },
      { id: 'other-model', apiName: 'openai/gpt-5' },
    ],
  })
  mockProviderProfiles({
    getActiveProviderProfile: () => activeProfile,
  })

  const rendered = await renderModelCommandWithCapturedPicker(
    'descriptor-picker-auto-provider-mode',
  )
  try {
    expect(rendered.getCapturedProps().optionsOverride).toEqual([
      {
        value: 'openai/gpt-5-mini',
        label: 'GPT-5 Mini (via OpenRouter)',
        description: 'Recommended · Provider: OpenRouter',
        descriptionForModel:
          'Recommended · Provider: OpenRouter (openai/gpt-5-mini)',
      },
      {
        value: 'x-ai/grok-4.6',
        label: 'Grok 4.6 (via OpenRouter)',
        description: 'Provider: OpenRouter',
        descriptionForModel: 'Provider: OpenRouter (x-ai/grok-4.6)',
      },
      {
        value: 'x-ai/grok-4.5',
        label: 'Grok 4.5 (via OpenRouter)',
        description: 'Provider: OpenRouter',
        descriptionForModel: 'Provider: OpenRouter (x-ai/grok-4.5)',
      },
      {
        value: activeProfile.model,
        label: activeProfile.model,
        description: 'Provider: OpenRouter',
        descriptionForModel: 'Provider: OpenRouter',
      },
      {
        value: 'openai/gpt-5',
        label: 'openai/gpt-5',
        description: 'Provider: OpenRouter',
        descriptionForModel: 'Provider: OpenRouter',
      },
    ])
  } finally {
    rendered.instance.unmount()
    rendered.stdout.end()
  }
})

test('/model discovery override still surfaces inactive-profile switch options (#1119)', async () => {
  // Regression for #1164 [P2]: descriptor/legacy discovery contexts pass an
  // optionsOverride built from the active profile's route models only. Because
  // the picker uses `optionsOverride ?? getModelOptions()`, the unified switcher
  // for other configured profiles must be re-appended to the override, or it
  // disappears entirely for provider-profile discovery paths.
  const activeProfile = {
    id: 'openrouter-profile',
    name: 'OpenRouter',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-oss-120b:free',
    apiKey: 'sk-openrouter',
  }
  const inactiveProfile = {
    id: 'kimi-profile',
    name: 'Kimi',
    provider: 'openai',
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'kimi-k2',
    apiKey: 'sk-kimi',
  }
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = activeProfile.baseUrl
  process.env.OPENAI_API_KEY = activeProfile.apiKey
  delete process.env.OPENROUTER_API_KEY
  process.env.OPENAI_MODEL = activeProfile.model
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID = activeProfile.id
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.OPENAI_API_BASE

  mockDescriptorDiscovery({
    cachedModels: [{ id: 'profile-model', apiName: activeProfile.model }],
  })
  mockProviderProfiles({
    getActiveProviderProfile: () => activeProfile,
    getProviderProfiles: () => [activeProfile, inactiveProfile],
    getProfileModelOptions: (profile: { model: string; name: string }) => [
      { value: profile.model, label: profile.model, description: profile.name },
    ],
  })

  const rendered = await renderModelCommandWithCapturedPicker(
    'descriptor-picker-inactive-switch-options',
  )
  try {
    const override = rendered.getCapturedProps()
      .optionsOverride as ModelOption[]
    const switchOptions = override.filter(
      opt => opt.switchToProfileId !== undefined,
    )
    expect(switchOptions.map(opt => opt.switchToProfileId)).toContain(
      'kimi-profile',
    )
    expect(
      switchOptions.some(
        opt => opt.value === encodeSwitchProfileValue('kimi-profile', 'kimi-k2'),
      ),
    ).toBe(true)
    // The active profile's own route model is still present as a normal option.
    expect(
      override.some(opt => opt.value === activeProfile.model),
    ).toBe(true)
  } finally {
    rendered.instance.unmount()
    rendered.stdout.end()
  }
})

test('/model applies auto provider surface for single-model static descriptor profiles', async () => {
  const activeProfile = {
    id: 'opengateway-profile',
    name: 'Twigpine Opengateway',
    provider: 'gitlawb-opengateway',
    baseUrl: 'https://opengateway.gitlawb.com/v1',
    model: 'mimo-v2.5-pro',
    apiKey: 'sk-opengateway',
  }
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = activeProfile.baseUrl
  process.env.OPENAI_API_KEY = activeProfile.apiKey
  process.env.OPENAI_MODEL = activeProfile.model
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID = activeProfile.id
  delete process.env.OPENROUTER_API_KEY
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.OPENAI_API_BASE

  mockProviderProfiles({
    getActiveProviderProfile: () => activeProfile,
  })
  mockDescriptorDiscovery({
    cachedModels: [],
    routeId: 'gitlawb-opengateway',
  })

  // Pin the clock inside the Ling Tiny availability window (its catalog
  // entry expires via availableUntil on 2026-08-13T10:00Z) so this expected
  // list stays deterministic after that date passes in real time.
  setSystemTime(new Date('2026-08-12T00:00:00Z'))
  try {
    const rendered = await renderModelCommandWithCapturedPicker(
      'descriptor-picker-auto-provider-static-mode',
    )
    try {
      expect(
        (rendered.getCapturedProps().optionsOverride as ModelOption[]).map(
          option => option.value,
        ),
      ).toEqual([
        'auto',
        'mimo-v2.5-pro',
        'mimo-v2.5',
        'mimo-v2-flash',
        'google/gemini-3.1-flash-lite',
        'minimax/minimax-m3',
        'qwen/qwen3.7-max',
        'z-ai/glm-5.2',
        'nvidia/nemotron-3-ultra-550b-a55b:free',
        'nvidia/nemotron-3-ultra-550b-a55b',
        'inclusionai/ling-3.0-flash',
        'inclusionai/ling-3.0-tiny:free',
        'mindai/macaron-v1-tall',
        'mindai/macaron-v1-venti',
        'tencent/hy3',
      ])
    } finally {
      rendered.instance.unmount()
      rendered.stdout.end()
    }
  } finally {
    setSystemTime()
  }
})

test('/model drops expired availableUntil entries from the static picker after the cutoff', async () => {
  const activeProfile = {
    id: 'opengateway-profile',
    name: 'Twigpine Opengateway',
    provider: 'gitlawb-opengateway',
    baseUrl: 'https://opengateway.gitlawb.com/v1',
    model: 'mimo-v2.5-pro',
    apiKey: 'sk-opengateway',
  }
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = activeProfile.baseUrl
  process.env.OPENAI_API_KEY = activeProfile.apiKey
  process.env.OPENAI_MODEL = activeProfile.model
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID = activeProfile.id
  delete process.env.OPENROUTER_API_KEY
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.OPENAI_API_BASE

  mockProviderProfiles({
    getActiveProviderProfile: () => activeProfile,
  })

  // Just past the Ling Tiny window (availableUntil 2026-08-13T10:00Z): the
  // picker must not offer the id the gateway now rejects with a 400.
  setSystemTime(new Date('2026-08-13T10:00:01Z'))
  try {
    const rendered = await renderModelCommandWithCapturedPicker(
      'descriptor-picker-expired-entry-hidden',
    )
    try {
      const values = (
        rendered.getCapturedProps().optionsOverride as ModelOption[]
      ).map(option => option.value)
      expect(values).not.toContain('inclusionai/ling-3.0-tiny:free')
      // The rest of the static catalog is untouched by the expiry.
      expect(values).toContain('inclusionai/ling-3.0-flash')
      expect(values).toContain('nvidia/nemotron-3-ultra-550b-a55b:free')
    } finally {
      rendered.instance.unmount()
      rendered.stdout.end()
    }
  } finally {
    setSystemTime()
  }
})

test('/model merges non-empty OpenGateway discovery cache with curated entries without duplicate MiMo rows', async () => {
  const activeProfile = {
    id: 'opengateway-profile',
    name: 'Twigpine Opengateway',
    provider: 'gitlawb-opengateway',
    baseUrl: 'https://opengateway.gitlawb.com/v1',
    model: 'mimo-v2.5-pro',
    apiKey: 'sk-opengateway',
  }
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = activeProfile.baseUrl
  process.env.OPENAI_API_KEY = activeProfile.apiKey
  process.env.OPENAI_MODEL = activeProfile.model
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID = activeProfile.id
  delete process.env.OPENROUTER_API_KEY
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.OPENAI_API_BASE

  mockProviderProfiles({
    getActiveProviderProfile: () => activeProfile,
  })
  mockDescriptorDiscovery({
    cachedModels: [
      { id: 'mimo-v2.5-pro', apiName: 'mimo-v2.5-pro', label: 'MiMo V2.5 Pro' },
      { id: 'xiaomi/mimo-v2.5-pro', apiName: 'mimo-v2.5-pro', label: 'MiMo V2.5 Pro Raw' },
      { id: 'moonshotai/kimi-k3', apiName: 'moonshotai/kimi-k3', label: 'Kimi K3 (via Opengateway)' },
    ],
    routeId: 'gitlawb-opengateway',
  })

  const rendered = await renderModelCommandWithCapturedPicker(
    'descriptor-picker-auto-provider-hybrid-mode',
  )
  try {
    const optionValues = (
      rendered.getCapturedProps().optionsOverride as ModelOption[]
    ).map(option => option.value)
    expect(optionValues).toEqual([
      'auto',
      'mimo-v2.5-pro',
      'mimo-v2.5',
      'mimo-v2-flash',
      'google/gemini-3.1-flash-lite',
      'minimax/minimax-m3',
      'qwen/qwen3.7-max',
      'z-ai/glm-5.2',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'nvidia/nemotron-3-ultra-550b-a55b',
      'inclusionai/ling-3.0-flash',
      'mindai/macaron-v1-tall',
      'mindai/macaron-v1-venti',
      'tencent/hy3',
      'moonshotai/kimi-k3',
    ])
    // Verify mimo-v2.5-pro appears exactly once (curated entry wins, duplicate is discarded)
    expect(optionValues.filter(val => val === 'mimo-v2.5-pro')).toHaveLength(1)
  } finally {
    rendered.instance.unmount()
    rendered.stdout.end()
  }
})

test('/model OpenGateway interactive refresh preserves availability filter and hides expired models', async () => {
  const activeProfile = {
    id: 'opengateway-profile',
    name: 'Twigpine Opengateway',
    provider: 'gitlawb-opengateway',
    baseUrl: 'https://opengateway.gitlawb.com/v1',
    model: 'auto',
    apiKey: '',
  }
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID = activeProfile.id
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = activeProfile.baseUrl
  process.env.OPENAI_MODEL = 'auto'
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENGATEWAY_API_KEY
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.OPENAI_API_BASE

  mockProviderProfiles({
    getActiveProviderProfile: () => activeProfile,
  })
  mockDescriptorDiscovery({
    cachedModels: [
      { id: 'mimo-v2.5-pro', apiName: 'mimo-v2.5-pro', label: 'MiMo V2.5 Pro' },
      { id: 'inclusionai/ling-3.0-tiny:free', apiName: 'inclusionai/ling-3.0-tiny:free', label: 'Ling 3.0 Tiny Live' },
      { id: 'moonshotai/kimi-k3', apiName: 'moonshotai/kimi-k3', label: 'Kimi K3' },
    ],
    discoveredModels: [
      { id: 'mimo-v2.5-pro', apiName: 'mimo-v2.5-pro', label: 'MiMo V2.5 Pro' },
      { id: 'inclusionai/ling-3.0-tiny:free', apiName: 'inclusionai/ling-3.0-tiny:free', label: 'Ling 3.0 Tiny Live' },
      { id: 'moonshotai/kimi-k3', apiName: 'moonshotai/kimi-k3', label: 'Kimi K3' },
      {
        id: 'refresh-only/live-model',
        apiName: 'refresh-only/live-model',
        label: 'Refresh Only Live Model',
      },
    ],
    routeId: 'gitlawb-opengateway',
  })

  const rendered = await renderModelCommandWithCapturedPicker(
    'opengateway-picker-refresh-availability',
  )
  try {
    const initialValues = (
      rendered.getCapturedProps().optionsOverride as ModelOption[]
    ).map(option => option.value)
    expect(initialValues).not.toContain('inclusionai/ling-3.0-tiny:free')
    expect(initialValues).toContain('moonshotai/kimi-k3')
    expect(initialValues).not.toContain('refresh-only/live-model')

    const onRefresh = rendered.getCapturedProps().onRefresh
    expect(onRefresh).toEqual(expect.any(Function))
    onRefresh!()
    await waitForCondition(() =>
      (
        rendered.getCapturedProps().optionsOverride as ModelOption[]
      ).some(option => option.value === 'refresh-only/live-model'),
    )

    const refreshedValues = (
      rendered.getCapturedProps().optionsOverride as ModelOption[]
    ).map(option => option.value)
    expect(refreshedValues).not.toContain('inclusionai/ling-3.0-tiny:free')
    expect(refreshedValues).toContain('moonshotai/kimi-k3')
    expect(refreshedValues).toContain('refresh-only/live-model')
  } finally {
    rendered.instance.unmount()
    rendered.stdout.end()
  }
})

test('/model applies providerProfileModelPickerMode provider override on descriptor picker load', async () => {
  useSettings({
    providerProfileModelPickerMode: 'provider',
  } as SettingsJson & {
    providerProfileModelPickerMode: ProviderProfileModelPickerModeForTest
  })
  const activeProfile = {
    id: 'openrouter-profile',
    name: 'OpenRouter',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'custom/private-model, openai/gpt-oss-120b:free',
    apiKey: 'sk-openrouter',
  }
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = activeProfile.baseUrl
  process.env.OPENAI_API_KEY = activeProfile.apiKey
  delete process.env.OPENROUTER_API_KEY
  process.env.OPENAI_MODEL = 'openai/gpt-oss-120b:free'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID = activeProfile.id
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.OPENAI_API_BASE

  mockDescriptorDiscovery({
    cachedModels: [
      { id: 'profile-model', apiName: 'openai/gpt-oss-120b:free' },
      { id: 'other-model', apiName: 'openai/gpt-5' },
    ],
  })
  mockProviderProfiles({
    getActiveProviderProfile: () => activeProfile,
  })

  const rendered = await renderModelCommandWithCapturedPicker(
    'descriptor-picker-settings-provider-mode',
  )
  try {
    expect(rendered.getCapturedProps().optionsOverride).toEqual([
      {
        value: 'openai/gpt-5-mini',
        label: 'GPT-5 Mini (via OpenRouter)',
        description: 'Recommended · Provider: OpenRouter',
        descriptionForModel:
          'Recommended · Provider: OpenRouter (openai/gpt-5-mini)',
      },
      {
        value: 'x-ai/grok-4.6',
        label: 'Grok 4.6 (via OpenRouter)',
        description: 'Provider: OpenRouter',
        descriptionForModel: 'Provider: OpenRouter (x-ai/grok-4.6)',
      },
      {
        value: 'x-ai/grok-4.5',
        label: 'Grok 4.5 (via OpenRouter)',
        description: 'Provider: OpenRouter',
        descriptionForModel: 'Provider: OpenRouter (x-ai/grok-4.5)',
      },
      {
        value: 'openai/gpt-oss-120b:free',
        label: 'openai/gpt-oss-120b:free',
        description: 'Provider: OpenRouter',
        descriptionForModel: 'Provider: OpenRouter',
      },
      {
        value: 'openai/gpt-5',
        label: 'openai/gpt-5',
        description: 'Provider: OpenRouter',
        descriptionForModel: 'Provider: OpenRouter',
      },
      {
        value: 'custom/private-model',
        label: 'custom/private-model',
        description: 'Provider: OpenRouter',
      },
    ])
  } finally {
    rendered.instance.unmount()
    rendered.stdout.end()
  }
})

test('/model applies profile surface to legacy local OpenAI-compatible profiles', async () => {
  useSettings({
    providerProfileModelPickerMode: 'profile',
  } as SettingsJson & {
    providerProfileModelPickerMode: ProviderProfileModelPickerModeForTest
  })
  const activeProfile = {
    id: 'custom-local-profile',
    name: 'Custom Local',
    provider: 'custom',
    baseUrl: 'http://localhost:7777/v1',
    model: 'local-model-a, local-model-b',
    apiKey: '',
  }
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = activeProfile.baseUrl
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENROUTER_API_KEY
  process.env.OPENAI_MODEL = 'local-model-a'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID = activeProfile.id
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.OPENAI_API_BASE

  expect(getAdditionalModelOptionsCacheScope()?.startsWith('openai:')).toBe(
    true,
  )
  await mockScopedLocalOpenAIModelCache([
    {
      value: 'local-model-a',
      label: 'Local Model A',
      description: 'Discovered from API',
    },
    {
      value: 'local-model-c',
      label: 'Local Model C',
      description: 'Discovered from API',
    },
  ])
  mockProviderProfiles({
    getActiveOpenAIModelOptionsCache: () => [
      {
        value: 'local-model-a',
        label: 'Local Model A',
        description: 'Discovered from API',
      },
      {
        value: 'local-model-c',
        label: 'Local Model C',
        description: 'Discovered from API',
      },
    ],
    getActiveProviderProfile: () => activeProfile,
  })

  const rendered = await renderModelCommandWithCapturedPicker(
    'legacy-openai-profile-mode',
  )
  try {
    expect(rendered.getCapturedProps().optionsOverride).toEqual([
      {
        value: 'local-model-a',
        label: 'Local Model A',
        description: 'Discovered from API',
      },
      {
        value: 'local-model-b',
        label: 'local-model-b',
        description: 'Provider: Custom Local',
      },
    ])
  } finally {
    rendered.instance.unmount()
    rendered.stdout.end()
  }
})

test('/model legacy local OpenAI route ignores inactive saved profile cache', async () => {
  const savedProfile = {
    id: 'saved-local-profile',
    name: 'Saved Local',
    provider: 'custom',
    baseUrl: 'http://localhost:7777/v1',
    model: 'saved-profile-model',
    apiKey: '',
  }
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://localhost:7777/v1'
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENROUTER_API_KEY
  process.env.OPENAI_MODEL = 'route-model'
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.OPENAI_API_BASE

  expect(getAdditionalModelOptionsCacheScope()?.startsWith('openai:')).toBe(
    true,
  )
  await mockScopedLocalOpenAIModelCache([
    {
      value: 'route-model',
      label: 'Route Model',
      description: 'Detected from route',
    },
  ])
  mockProviderProfiles({
    getActiveOpenAIModelOptionsCache: () => [
      {
        value: 'saved-profile-model',
        label: 'Saved Profile Model',
        description: 'Provider: Saved Local',
      },
    ],
    getActiveProviderProfile: () => savedProfile,
  })

  const rendered = await renderModelCommandWithCapturedPicker(
    'legacy-openai-inactive-profile-cache',
  )
  try {
    expect(rendered.getCapturedProps().optionsOverride).toEqual([
      expect.objectContaining({
        value: null,
        label: 'Default (recommended)',
      }),
      {
        value: 'route-model',
        label: 'Route Model',
        description: 'Detected from route',
      },
    ])
  } finally {
    rendered.instance.unmount()
    rendered.stdout.end()
  }
})

test('/model legacy local OpenAI route filters scoped cache by availableModels', async () => {
  useSettings({ availableModels: ['allowed-route'] } as SettingsJson)
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://localhost:7777/v1'
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENROUTER_API_KEY
  process.env.OPENAI_MODEL = 'allowed-route'
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.OPENAI_API_BASE

  await mockScopedLocalOpenAIModelCache([
    {
      value: 'allowed-route',
      label: 'Allowed Route',
      description: 'Detected from route',
    },
    {
      value: 'blocked-route',
      label: 'Blocked Route',
      description: 'Detected from route',
    },
  ])
  mockProviderProfiles()

  const rendered = await renderModelCommandWithCapturedPicker(
    'legacy-openai-allowlist-initial',
  )
  try {
    expect(rendered.getCapturedProps().optionsOverride).toEqual([
      expect.objectContaining({
        value: null,
        label: 'Default (recommended)',
      }),
      {
        value: 'allowed-route',
        label: 'Allowed Route',
        description: 'Detected from route',
      },
    ])
  } finally {
    rendered.instance.unmount()
    rendered.stdout.end()
  }
})

test('/model legacy local OpenAI refresh does not write inactive profile cache', async () => {
  const savedProfile = {
    id: 'saved-local-profile',
    name: 'Saved Local',
    provider: 'custom',
    baseUrl: 'http://localhost:7777/v1',
    model: 'saved-profile-model',
    apiKey: '',
  }
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://localhost:7777/v1'
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENROUTER_API_KEY
  process.env.OPENAI_MODEL = 'route-model'
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.OPENAI_API_BASE

  const scopedCache = await mockScopedLocalOpenAIModelCache([
    {
      value: 'route-model',
      label: 'Route Model',
      description: 'Detected from route',
    },
  ])
  const setActiveOpenAIModelOptionsCache = mock(() => {
    throw new Error('inactive profile cache must not be written')
  })
  mockProviderProfiles({
    getActiveOpenAIModelOptionsCache: () => [
      {
        value: 'saved-profile-model',
        label: 'Saved Profile Model',
        description: 'Provider: Saved Local',
      },
    ],
    getActiveProviderProfile: () => savedProfile,
    setActiveOpenAIModelOptionsCache,
  })
  mock.module('../../utils/model/openaiModelDiscovery.js', () => ({
    discoverOpenAICompatibleModelOptions: mock(async () => [
      {
        value: 'route-model',
        label: 'Route Model',
        description: 'Detected from route',
      },
      {
        value: 'route-model-b',
        label: 'Route Model B',
        description: 'Detected from route',
      },
    ]),
  }))

  const rendered = await renderModelCommandWithCapturedPicker(
    'legacy-openai-inactive-profile-refresh',
  )
  try {
    rendered.getCapturedProps().onRefresh?.()
    await waitForCondition(
      () =>
        rendered.getCapturedProps().discoveryState?.message ===
        'Updated Local OpenAI-compatible models.',
    )

    expect(setActiveOpenAIModelOptionsCache).not.toHaveBeenCalled()
    expect(scopedCache.getState().additionalModelOptionsCache).toEqual([
      {
        value: 'route-model',
        label: 'Route Model',
        description: 'Detected from route',
      },
      {
        value: 'route-model-b',
        label: 'Route Model B',
        description: 'Detected from route',
      },
    ])
    expect(rendered.getCapturedProps().optionsOverride).toEqual([
      expect.objectContaining({
        value: null,
        label: 'Default (recommended)',
      }),
      {
        value: 'route-model',
        label: 'Route Model',
        description: 'Detected from route',
      },
      {
        value: 'route-model-b',
        label: 'Route Model B',
        description: 'Detected from route',
      },
    ])
  } finally {
    rendered.instance.unmount()
    rendered.stdout.end()
  }
})

test('/model legacy local OpenAI refresh compares allowlist-filtered options', async () => {
  useSettings({ availableModels: ['allowed-route'] } as SettingsJson)
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://localhost:7777/v1'
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENROUTER_API_KEY
  process.env.OPENAI_MODEL = 'allowed-route'
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.OPENAI_API_BASE

  const scopedCache = await mockScopedLocalOpenAIModelCache([
    {
      value: 'allowed-route',
      label: 'Allowed Route',
      description: 'Detected from route',
    },
  ])
  mockProviderProfiles()
  mock.module('../../utils/model/openaiModelDiscovery.js', () => ({
    discoverOpenAICompatibleModelOptions: mock(async () => [
      {
        value: 'allowed-route',
        label: 'Allowed Route',
        description: 'Detected from route',
      },
      {
        value: 'blocked-route',
        label: 'Blocked Route',
        description: 'Detected from route',
      },
    ]),
  }))

  const rendered = await renderModelCommandWithCapturedPicker(
    'legacy-openai-allowlist-refresh',
  )
  try {
    rendered.getCapturedProps().onRefresh?.()
    await waitForCondition(
      () =>
        rendered.getCapturedProps().discoveryState?.message ===
        'No changes found for Local OpenAI-compatible.',
    )

    expect(scopedCache.getState().additionalModelOptionsCache).toEqual([
      {
        value: 'allowed-route',
        label: 'Allowed Route',
        description: 'Detected from route',
      },
      {
        value: 'blocked-route',
        label: 'Blocked Route',
        description: 'Detected from route',
      },
    ])
    expect(rendered.getCapturedProps().optionsOverride).toEqual([
      expect.objectContaining({
        value: null,
        label: 'Default (recommended)',
      }),
      {
        value: 'allowed-route',
        label: 'Allowed Route',
        description: 'Detected from route',
      },
    ])
  } finally {
    rendered.instance.unmount()
    rendered.stdout.end()
  }
})

test('/model legacy local OpenAI refresh preserves cached options when discovery finds no models', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://localhost:7777/v1'
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENROUTER_API_KEY
  process.env.OPENAI_MODEL = 'route-model'
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.OPENAI_API_BASE

  const cachedOptions = [
    {
      value: 'route-model',
      label: 'Route Model',
      description: 'Detected from route',
    },
    {
      value: 'route-model-b',
      label: 'Route Model B',
      description: 'Detected from route',
    },
  ]
  const scopedCache = await mockScopedLocalOpenAIModelCache(cachedOptions)
  mockProviderProfiles()
  mock.module('../../utils/model/openaiModelDiscovery.js', () => ({
    discoverOpenAICompatibleModelOptions: mock(async () => []),
  }))

  const rendered = await renderModelCommandWithCapturedPicker(
    'legacy-openai-empty-refresh',
  )
  try {
    const expectedPickerOptions = [
      expect.objectContaining({
        value: null,
        label: 'Default (recommended)',
      }),
      ...cachedOptions,
    ]
    expect(rendered.getCapturedProps().optionsOverride).toEqual(
      expectedPickerOptions,
    )

    rendered.getCapturedProps().onRefresh?.()
    await waitForCondition(() => {
      const message = rendered.getCapturedProps().discoveryState?.message
      return (
        message !== undefined &&
        message !== 'Refreshing Local OpenAI-compatible models…'
      )
    })

    expect(rendered.getCapturedProps().discoveryState).toEqual({
      message: 'Could not refresh Local OpenAI-compatible models.',
      tone: 'warning',
    })
    expect(scopedCache.getState().additionalModelOptionsCache).toEqual(
      cachedOptions,
    )
    expect(rendered.getCapturedProps().optionsOverride).toEqual(
      expectedPickerOptions,
    )
  } finally {
    rendered.instance.unmount()
    rendered.stdout.end()
  }
})

test('/model legacy local OpenAI refresh preserves cached provider options for active profiles when discovery finds no models', async () => {
  useSettings({
    providerProfileModelPickerMode: 'provider',
  } as SettingsJson & {
    providerProfileModelPickerMode: ProviderProfileModelPickerModeForTest
  })
  const activeProfile = {
    id: 'custom-local-profile',
    name: 'Custom Local',
    provider: 'custom',
    baseUrl: 'http://localhost:7777/v1',
    model: 'profile-only-model, route-model',
    apiKey: '',
  }
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = activeProfile.baseUrl
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENROUTER_API_KEY
  process.env.OPENAI_MODEL = 'route-model'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID = activeProfile.id
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.OPENAI_API_BASE

  const cachedOptions = [
    {
      value: 'route-model',
      label: 'Route Model',
      description: 'Detected from route',
    },
    {
      value: 'route-model-b',
      label: 'Route Model B',
      description: 'Detected from route',
    },
  ]
  const scopedCache = await mockScopedLocalOpenAIModelCache(cachedOptions)
  mockProviderProfiles({
    getActiveOpenAIModelOptionsCache: () => [
      {
        value: 'profile-only-model',
        label: 'profile-only-model',
        description: 'Provider: Custom Local',
      },
      ...cachedOptions,
    ],
    getActiveProviderProfile: () => activeProfile,
  })
  const discoverOpenAICompatibleModelOptions = mock(async () => [])
  mock.module('../../utils/model/openaiModelDiscovery.js', () => ({
    discoverOpenAICompatibleModelOptions,
  }))

  const rendered = await renderModelCommandWithCapturedPicker(
    'legacy-openai-active-profile-empty-refresh',
  )
  try {
    const expectedPickerOptions = [
      ...cachedOptions,
      {
        value: 'profile-only-model',
        label: 'profile-only-model',
        description: 'Provider: Custom Local',
      },
    ]
    expect(rendered.getCapturedProps().optionsOverride).toEqual(
      expectedPickerOptions,
    )

    await waitForCondition(
      () =>
        discoverOpenAICompatibleModelOptions.mock.calls.length >= 1 &&
        rendered.getCapturedProps().discoveryState?.message ===
          'Could not refresh Local OpenAI-compatible models.',
    )
    expect(rendered.getCapturedProps().optionsOverride).toEqual(
      expectedPickerOptions,
    )

    rendered.getCapturedProps().onRefresh?.()
    await waitForCondition(
      () =>
        discoverOpenAICompatibleModelOptions.mock.calls.length >= 2 &&
        rendered.getCapturedProps().discoveryState?.message ===
          'Could not refresh Local OpenAI-compatible models.',
    )

    expect(rendered.getCapturedProps().discoveryState).toEqual({
      message: 'Could not refresh Local OpenAI-compatible models.',
      tone: 'warning',
    })
    expect(scopedCache.getState().additionalModelOptionsCache).toEqual(
      cachedOptions,
    )
    expect(rendered.getCapturedProps().optionsOverride).toEqual(
      expectedPickerOptions,
    )
  } finally {
    rendered.instance.unmount()
    rendered.stdout.end()
  }
})

test('/model legacy provider mode keeps raw local cache before profile-only models', async () => {
  useSettings({
    providerProfileModelPickerMode: 'provider',
  } as SettingsJson & {
    providerProfileModelPickerMode: ProviderProfileModelPickerModeForTest
  })
  const activeProfile = {
    id: 'custom-local-profile',
    name: 'Custom Local',
    provider: 'custom',
    baseUrl: 'http://localhost:7777/v1',
    model: 'profile-only-model, route-model',
    apiKey: '',
  }
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = activeProfile.baseUrl
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENROUTER_API_KEY
  process.env.OPENAI_MODEL = 'route-model'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID = activeProfile.id
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.OPENAI_API_BASE

  await mockScopedLocalOpenAIModelCache([
    {
      value: 'route-model',
      label: 'Route Model',
      description: 'Detected from route',
    },
    {
      value: 'route-model-b',
      label: 'Route Model B',
      description: 'Detected from route',
    },
  ])
  mockProviderProfiles({
    getActiveOpenAIModelOptionsCache: () => [
      {
        value: 'profile-only-model',
        label: 'profile-only-model',
        description: 'Provider: Custom Local',
      },
      {
        value: 'route-model',
        label: 'Route Model',
        description: 'Detected from route',
      },
      {
        value: 'route-model-b',
        label: 'Route Model B',
        description: 'Detected from route',
      },
    ],
    getActiveProviderProfile: () => activeProfile,
  })

  const rendered = await renderModelCommandWithCapturedPicker(
    'legacy-openai-provider-mode-raw-cache',
  )
  try {
    expect(rendered.getCapturedProps().optionsOverride).toEqual([
      {
        value: 'route-model',
        label: 'Route Model',
        description: 'Detected from route',
      },
      {
        value: 'route-model-b',
        label: 'Route Model B',
        description: 'Detected from route',
      },
      {
        value: 'profile-only-model',
        label: 'profile-only-model',
        description: 'Provider: Custom Local',
      },
    ])
  } finally {
    rendered.instance.unmount()
    rendered.stdout.end()
  }
})

test('descriptor model options filter route and profile-only entries by availableModels', async () => {
  useSettings({ availableModels: ['allowed-route'] } as SettingsJson)
  const activeProfile = {
    id: 'openrouter-profile',
    name: 'OpenRouter',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'blocked-profile-only',
    apiKey: 'sk-openrouter',
  }
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID = activeProfile.id

  mockProviderProfiles({
    getActiveProviderProfile: () => activeProfile,
    getProfileModelOptions: () =>
      getConfiguredProfileModelOptionsForTest(activeProfile),
  })

  const { mergeActiveProfileModelOptions } = await importFreshModelModule(
    'descriptor-profile-model-allowlist',
  )

  expect(
    mergeActiveProfileModelOptions(
      'openrouter',
      [
        {
          value: 'allowed-route',
          label: 'Allowed Route',
          description: 'Provider: OpenRouter',
        },
        {
          value: 'blocked-route',
          label: 'Blocked Route',
          description: 'Provider: OpenRouter',
        },
      ],
      { profileModelSurface: 'provider' },
    ),
  ).toEqual([
    {
      value: 'allowed-route',
      label: 'Allowed Route',
      description: 'Provider: OpenRouter',
    },
  ])
})

test('descriptor model options skip saved profile models for env-selected routes', async () => {
  const savedProfile = {
    id: 'mistral-profile',
    name: 'Mistral AI',
    provider: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'devstral-latest, mistral-medium-latest',
    apiKey: 'sk-mistral',
  }
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID

  mockProviderProfiles({
    getActiveOpenAIModelOptionsCache: () => [],
    getActiveProviderProfile: () => savedProfile,
    getProfileModelOptions: () => [
      {
        value: 'mistral-medium-latest',
        label: 'mistral-medium-latest',
        description: 'Provider: Mistral AI',
      },
    ],
    setActiveOpenAIModelOptionsCache: () => {},
  })

  const { mergeActiveProfileModelOptions } =
    await importFreshModelModule('descriptor-profile-model-env-skip')

  expect(
    mergeActiveProfileModelOptions(
      'openrouter',
      [
        {
          value: 'openai/gpt-5-mini',
          label: 'GPT-5 Mini',
          description: 'Provider: OpenRouter',
        },
      ],
    ),
  ).toEqual([
    {
      value: 'openai/gpt-5-mini',
      label: 'GPT-5 Mini',
      description: 'Provider: OpenRouter',
    },
  ])
})

test('descriptor model options ignore active profile when applied profile id does not match', async () => {
  const activeProfile = {
    id: 'mistral-profile',
    name: 'Mistral AI',
    provider: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-medium-latest',
    apiKey: 'sk-mistral',
  }
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID = 'other-profile'

  mockProviderProfiles({
    getActiveProviderProfile: () => activeProfile,
  })

  const { mergeActiveProfileModelOptions } = await importFreshModelModule(
    'descriptor-profile-model-id-mismatch',
  )

  expect(
    mergeActiveProfileModelOptions(
      'mistral',
      [
        {
          value: 'devstral-latest',
          label: 'Devstral Latest',
          description: 'Recommended · Provider: Mistral AI',
        },
      ],
    ),
  ).toEqual([
    {
      value: 'devstral-latest',
      label: 'Devstral Latest',
      description: 'Recommended · Provider: Mistral AI',
    },
  ])
})

test('descriptor model options ignore active profile when route does not match', async () => {
  const activeProfile = {
    id: 'mistral-profile',
    name: 'Mistral AI',
    provider: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-medium-latest',
    apiKey: 'sk-mistral',
  }
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID = activeProfile.id

  mockProviderProfiles({
    getActiveProviderProfile: () => activeProfile,
  })

  const { mergeActiveProfileModelOptions } = await importFreshModelModule(
    'descriptor-profile-model-route-mismatch',
  )

  expect(
    mergeActiveProfileModelOptions(
      'openrouter',
      [
        {
          value: 'openai/gpt-5-mini',
          label: 'GPT-5 Mini',
          description: 'Provider: OpenRouter',
        },
      ],
    ),
  ).toEqual([
    {
      value: 'openai/gpt-5-mini',
      label: 'GPT-5 Mini',
      description: 'Provider: OpenRouter',
    },
  ])
})

test('/model refresh passes first pooled OpenAI credential to descriptor discovery', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'
  process.env.OPENAI_API_KEYS = 'key-a,key-b'
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENROUTER_API_KEY
  process.env.OPENAI_MODEL = 'gpt-5.5'
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.OPENAI_API_BASE

  const discoverModelsForRoute = mock(async () => ({
    routeId: 'openrouter',
    models: [{ id: 'gpt-5.5', apiName: 'gpt-5.5' }],
    stale: false,
    error: null,
    source: 'network',
  }))

  mock.module('../../integrations/discoveryCache.js', () => ({
    clearDiscoveryCache: mock(async () => {}),
    getCachedModels: mock(async () => ({
      models: [{ id: 'cached-gpt', apiName: 'gpt-5.5' }],
      updatedAt: Date.now(),
      error: null,
    })),
    isCacheStale: mock(async () => false),
    parseDurationString: (value: number | string) =>
      typeof value === 'number' ? value : 86_400_000,
  }))

  mock.module('../../integrations/discoveryService.js', () => ({
    getDiscoveryCacheKey: (
      routeId: string,
      options?: { apiKey?: string; baseUrl?: string; headers?: Record<string, string> },
    ) => `${routeId}|${options?.baseUrl ?? ''}|${options?.apiKey ?? ''}|${JSON.stringify(options?.headers ?? {})}`,
    discoverModelsForRoute,
    probeRouteReadiness: mock(async () => null),
  }))

  mockProviderProfiles({
    getActiveOpenAIModelOptionsCache: () => [],
    getActiveProviderProfile: () => undefined,
    getProfileModelOptions: () => [],
    setActiveOpenAIModelOptionsCache: () => {},
  })

  const { call } = await importFreshModelModule(
    'descriptor-refresh-openai-pooled-key',
  )
  await call(() => {}, {} as never, 'refresh')

  expect(discoverModelsForRoute).toHaveBeenCalledWith('openrouter', {
    apiKey: 'key-a',
    baseUrl: 'https://openrouter.ai/api/v1',
    headers: undefined,
    forceRefresh: true,
  })
})

test('/model refresh uses OPENAI_API_BASE for Command Code discovery', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = '   '
  process.env.OPENAI_API_BASE = 'https://api.commandcode.ai/provider/v1'
  process.env.CMD_API_KEY = 'cmd-key'
  delete process.env.COMMANDCODE_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEYS
  process.env.OPENAI_MODEL = 'deepseek/deepseek-v4-flash'
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY

  const discoverModelsForRoute = mock(async () => ({
    routeId: 'commandcode',
    models: [
      {
        id: 'deepseek/deepseek-v4-flash',
        apiName: 'deepseek/deepseek-v4-flash',
      },
    ],
    stale: false,
    error: null,
    source: 'network',
  }))

  mock.module('../../integrations/discoveryCache.js', () => ({
    clearDiscoveryCache: mock(async () => {}),
    getCachedModels: mock(async () => ({
      models: [],
      updatedAt: Date.now(),
      error: null,
    })),
    isCacheStale: mock(async () => false),
    parseDurationString: (value: number | string) =>
      typeof value === 'number' ? value : 86_400_000,
  }))

  mock.module('../../integrations/discoveryService.js', () => ({
    getDiscoveryCacheKey: (
      routeId: string,
      options?: {
        apiKey?: string
        baseUrl?: string
        headers?: Record<string, string>
      },
    ) =>
      `${routeId}|${options?.baseUrl ?? ''}|${options?.apiKey ?? ''}|${JSON.stringify(options?.headers ?? {})}`,
    discoverModelsForRoute,
    probeRouteReadiness: mock(async () => null),
  }))

  mockProviderProfiles({
    getActiveOpenAIModelOptionsCache: () => [],
    getActiveProviderProfile: () => undefined,
    getProfileModelOptions: () => [],
    setActiveOpenAIModelOptionsCache: () => {},
  })

  const { call } = await importFreshModelModule(
    'commandcode-refresh-openai-api-base',
  )
  await call(() => {}, {} as never, 'refresh')

  expect(discoverModelsForRoute).toHaveBeenCalledWith('commandcode', {
    apiKey: 'cmd-key',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    headers: undefined,
    forceRefresh: true,
  })
})

test('/model refresh clears descriptor cache and reports updates', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'
  delete process.env.OPENAI_API_KEY
  process.env.OPENROUTER_API_KEY = 'sk-openrouter-route'
  process.env.OPENAI_MODEL = 'openai/gpt-5-mini'
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.OPENAI_API_BASE

  const clearDiscoveryCache = mock(async () => {})
  const getCachedModels = mock(async () => ({
    models: [{ id: 'cached-gpt', apiName: 'openai/gpt-5-mini' }],
    updatedAt: Date.now(),
    error: null,
  }))
  const isCacheStale = mock(async () => false)

  mock.module('../../integrations/discoveryCache.js', () => ({
    clearDiscoveryCache,
    getCachedModels,
    isCacheStale,
    parseDurationString: (value: number | string) =>
      typeof value === 'number' ? value : 86_400_000,
  }))

  mock.module('../../integrations/discoveryService.js', () => ({
    getDiscoveryCacheKey: (
      routeId: string,
      options?: { apiKey?: string; baseUrl?: string; headers?: Record<string, string> },
    ) => `${routeId}|${options?.baseUrl ?? ''}|${options?.apiKey ?? ''}|${JSON.stringify(options?.headers ?? {})}`,
    discoverModelsForRoute: mock(async () => ({
      routeId: 'openrouter',
      models: [
        {
          id: 'openrouter-gpt-5-mini',
          apiName: 'openai/gpt-5-mini',
          default: true,
        },
        { id: 'openrouter-qwen', apiName: 'qwen/qwen3-32b' },
      ],
      stale: false,
      error: null,
      source: 'network',
    })),
    probeRouteReadiness: mock(async () => null),
  }))

  mockProviderProfiles({
    getActiveOpenAIModelOptionsCache: () => [],
    getActiveProviderProfile: () => undefined,
    getProfileModelOptions: () => [],
    setActiveOpenAIModelOptionsCache: () => {},
  })

  const messages: string[] = []
  const { call } = await importFreshModelModule(
    'descriptor-refresh-manual',
  )
  await call(
    (message?: string) => {
      if (message) {
        messages.push(message)
      }
    },
    {} as never,
    'refresh',
  )

  const expectedCacheKey =
    'openrouter|https://openrouter.ai/api/v1|sk-openrouter-route|{}'
  expect(getCachedModels).toHaveBeenCalledWith(expectedCacheKey, 86_400_000, {
    includeStale: true,
  })
  expect(isCacheStale).toHaveBeenCalledWith(expectedCacheKey, 86_400_000)
  expect(clearDiscoveryCache).toHaveBeenCalledWith(expectedCacheKey)
  expect(messages).toContain('Updated OpenRouter models.')
})

test('/model refresh reports discovered model changes for dynamic active profiles', async () => {
  const activeProfile = {
    id: 'lmstudio-profile',
    name: 'LM Studio',
    provider: 'lmstudio',
    baseUrl: 'http://localhost:1234/v1',
    model: 'local-model-a',
    apiKey: '',
  }
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = activeProfile.baseUrl
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENROUTER_API_KEY
  process.env.OPENAI_MODEL = activeProfile.model
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID = activeProfile.id
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.OPENAI_API_BASE

  mock.module('../../integrations/discoveryCache.js', () => ({
    clearDiscoveryCache: mock(async () => {}),
    getCachedModels: mock(async () => ({
      models: [{ id: 'profile-model', apiName: activeProfile.model }],
      updatedAt: Date.now(),
      error: null,
    })),
    isCacheStale: mock(async () => false),
    parseDurationString: (value: number | string) =>
      typeof value === 'number' ? value : 86_400_000,
  }))

  mock.module('../../integrations/discoveryService.js', () => ({
    getDiscoveryCacheKey: (
      routeId: string,
      options?: { apiKey?: string; baseUrl?: string; headers?: Record<string, string> },
    ) => `${routeId}|${options?.baseUrl ?? ''}|${options?.apiKey ?? ''}|${JSON.stringify(options?.headers ?? {})}`,
    discoverModelsForRoute: mock(async () => ({
      routeId: 'lmstudio',
      models: [
        { id: 'profile-model', apiName: activeProfile.model },
        { id: 'local-model-b', apiName: 'local-model-b' },
      ],
      stale: false,
      error: null,
      source: 'network',
    })),
    probeRouteReadiness: mock(async () => null),
  }))

  mockProviderProfiles({
    getActiveOpenAIModelOptionsCache: () => [],
    getActiveProviderProfile: () => activeProfile,
    getProfileModelOptions: () => [
      {
        value: activeProfile.model,
        label: activeProfile.model,
        description: 'Provider: LM Studio',
      },
    ],
    setActiveOpenAIModelOptionsCache: () => {},
  })

  const messages: string[] = []
  const { call } = await importFreshModelModule(
    'descriptor-profile-refresh-manual',
  )
  await call(
    (message?: string) => {
      if (message) {
        messages.push(message)
      }
    },
    {} as never,
    'refresh',
  )

  expect(messages).toContain('Updated LM Studio models.')
})

test('/model refresh on OpenGateway does not restore or mention expired models', async () => {
  const activeProfile = {
    id: 'opengateway-profile',
    name: 'Twigpine Opengateway',
    provider: 'gitlawb-opengateway',
    baseUrl: 'https://opengateway.gitlawb.com/v1',
    model: 'auto',
    apiKey: '',
  }
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = activeProfile.baseUrl
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENGATEWAY_API_KEY
  process.env.OPENAI_MODEL = activeProfile.model
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID = activeProfile.id
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.OPENAI_API_BASE

  mock.module('../../integrations/discoveryCache.js', () => ({
    clearDiscoveryCache: mock(async () => {}),
    getCachedModels: mock(async () => ({
      models: [{ id: 'mimo-v2.5-pro', apiName: 'mimo-v2.5-pro' }],
      updatedAt: Date.now(),
      error: null,
    })),
    isCacheStale: mock(async () => false),
    parseDurationString: (value: number | string) =>
      typeof value === 'number' ? value : 86_400_000,
  }))

  mock.module('../../integrations/discoveryService.js', () => ({
    getDiscoveryCacheKey: (
      routeId: string,
      options?: { apiKey?: string; baseUrl?: string; headers?: Record<string, string> },
    ) => `${routeId}|${options?.baseUrl ?? ''}|${options?.apiKey ?? ''}|${JSON.stringify(options?.headers ?? {})}`,
    discoverModelsForRoute: mock(async () => {
      const rawStatic = getRouteDescriptor('gitlawb-opengateway')?.catalog?.models ?? []
      const discovered = [
        { id: 'mimo-v2.5-pro', apiName: 'mimo-v2.5-pro' },
        { id: 'moonshotai/kimi-k3', apiName: 'moonshotai/kimi-k3' },
        { id: 'inclusionai/ling-3.0-tiny:free', apiName: 'inclusionai/ling-3.0-tiny:free' },
      ] as ModelCatalogEntry[]
      const merged = filterAvailableCatalogEntries(
        mergeRouteCatalogEntries(rawStatic, discovered),
      )
      return {
        routeId: 'gitlawb-opengateway',
        models: merged,
        stale: false,
        error: null,
        source: 'network',
      }
    }),
    probeRouteReadiness: mock(async () => null),
  }))

  mockProviderProfiles({
    getActiveOpenAIModelOptionsCache: () => [],
    getActiveProviderProfile: () => activeProfile,
  })

  const messages: string[] = []
  const { call } = await importFreshModelModule(
    'opengateway-refresh-summary-no-expired',
  )
  await call(
    (message?: string) => {
      if (message) {
        messages.push(message)
      }
    },
    {} as never,
    'refresh',
  )

  expect(messages).toContain('Updated Twigpine Opengateway models.')
  expect(messages.join(' ')).not.toContain('inclusionai/ling-3.0-tiny:free')
})

test('/model refresh compares already allowlist-filtered descriptor options', async () => {
  useSettings({ availableModels: ['local-model-a'] } as SettingsJson)
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://localhost:1234/v1'
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENROUTER_API_KEY
  process.env.OPENAI_MODEL = 'local-model-a'
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.OPENAI_API_BASE

  mock.module('../../integrations/discoveryCache.js', () => ({
    clearDiscoveryCache: mock(async () => {}),
    getCachedModels: mock(async () => ({
      models: [{ id: 'local-model-a', apiName: 'local-model-a' }],
      updatedAt: Date.now(),
      error: null,
    })),
    isCacheStale: mock(async () => false),
    parseDurationString: (value: number | string) =>
      typeof value === 'number' ? value : 86_400_000,
  }))

  mock.module('../../integrations/discoveryService.js', () => ({
    getDiscoveryCacheKey: (
      routeId: string,
      options?: { apiKey?: string; baseUrl?: string; headers?: Record<string, string> },
    ) => `${routeId}|${options?.baseUrl ?? ''}|${options?.apiKey ?? ''}|${JSON.stringify(options?.headers ?? {})}`,
    discoverModelsForRoute: mock(async () => ({
      routeId: 'lmstudio',
      models: [
        { id: 'local-model-a', apiName: 'local-model-a' },
        { id: 'blocked-model', apiName: 'blocked-model' },
      ],
      stale: false,
      error: null,
      source: 'network',
    })),
    probeRouteReadiness: mock(async () => null),
  }))

  mockProviderProfiles()

  const messages: string[] = []
  const { call } = await importFreshModelModule(
    'descriptor-refresh-allowlist-summary',
  )
  await call(
    (message?: string) => {
      if (message) {
        messages.push(message)
      }
    },
    {} as never,
    'refresh',
  )

  expect(messages).toContain('No changes found for LM Studio.')
})

test('/model refresh treats empty legacy OpenAI-compatible discovery as failed no-op', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://localhost:7777/v1'
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENROUTER_API_KEY
  process.env.OPENAI_MODEL = 'route-model'
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.OPENAI_API_BASE

  const cachedOptions = [
    {
      value: 'route-model',
      label: 'Route Model',
      description: 'Detected from route',
    },
  ]
  const scopedCache = await mockScopedLocalOpenAIModelCache(cachedOptions)
  mockProviderProfiles()
  mock.module('../../utils/model/openaiModelDiscovery.js', () => ({
    discoverOpenAICompatibleModelOptions: mock(async () => []),
  }))

  const messages: string[] = []
  const { call } = await importFreshModelModule(
    'legacy-openai-empty-refresh-summary',
  )
  await call(
    (message?: string) => {
      if (message) {
        messages.push(message)
      }
    },
    {} as never,
    'refresh',
  )

  expect(messages).toContain(
    'Could not refresh Local OpenAI-compatible models.',
  )
  expect(scopedCache.getState().additionalModelOptionsCache).toEqual(
    cachedOptions,
  )
})

test('interactive model picker refresh keeps descriptor options allowlist-filtered', async () => {
  useSettings({ availableModels: ['allowed-route'] } as SettingsJson)
  const activeProfile = {
    id: 'openrouter-profile',
    name: 'OpenRouter',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'blocked-profile-only',
    apiKey: 'sk-openrouter',
  }
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = activeProfile.baseUrl
  process.env.OPENAI_API_KEY = activeProfile.apiKey
  delete process.env.OPENROUTER_API_KEY
  process.env.OPENAI_MODEL = 'allowed-route'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID = activeProfile.id
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.OPENAI_API_BASE

  mockDescriptorDiscovery({
    cachedModels: [{ id: 'allowed', apiName: 'allowed-route' }],
    discoveredModels: [
      { id: 'allowed', apiName: 'allowed-route' },
      { id: 'blocked', apiName: 'blocked-route' },
    ],
  })
  mockProviderProfiles({
    getActiveProviderProfile: () => activeProfile,
  })

  const rendered = await renderModelCommandWithCapturedPicker(
    'descriptor-picker-refresh-allowlist',
  )
  try {
    expect(rendered.getCapturedProps().optionsOverride).toEqual([
      {
        value: 'allowed-route',
        label: 'allowed-route',
        description: 'Provider: OpenRouter',
        descriptionForModel: 'Provider: OpenRouter',
      },
    ])

    rendered.getCapturedProps().onRefresh?.()
    await waitForCondition(
      () =>
        rendered.getCapturedProps().discoveryState?.message ===
        'No changes found for OpenRouter.',
    )

    expect(rendered.getCapturedProps().optionsOverride).toEqual([
      {
        value: 'allowed-route',
        label: 'allowed-route',
        description: 'Provider: OpenRouter',
        descriptionForModel: 'Provider: OpenRouter',
      },
    ])
  } finally {
    rendered.instance.unmount()
    rendered.stdout.end()
  }
})

test('interactive model picker rejects models blocked by availableModels before updating state', async () => {
  useSettings({ availableModels: ['allowed-model'] } as SettingsJson)

  mockProviderProfiles()
  mock.module('../../components/ModelPicker.js', () => ({
    ModelPicker: function MockModelPicker(props: {
      onSelect: (model: string | null, effort: undefined) => void
    }): React.ReactNode {
      React.useEffect(() => {
        props.onSelect('blocked-model', undefined)
      }, [props])
      return null
    },
  }))

  const messages: Array<{
    message?: string
    options?: { display?: string }
  }> = []
  const { call } = await importFreshModelModule(
    'descriptor-interactive-allowlist-guard',
  )
  const element = await call(
    (message, options) => {
      messages.push({ message, options })
    },
    {} as never,
    '',
  )
  const { AppStateProvider, getDefaultAppState } = await import(
    '../../state/AppState.js'
  )
  const { render } = await import('../../ink.js')

  const stdout = new PassThrough()
  ;(stdout as unknown as { columns: number }).columns = 120
  const initialState = {
    ...getDefaultAppState(),
    mainLoopModel: 'allowed-model',
  }
  let latestMainLoopModel: ModelSetting = initialState.mainLoopModel
  const instance = await render(
    <AppStateProvider
      initialState={initialState}
      onChangeAppState={({ newState }) => {
        latestMainLoopModel = newState.mainLoopModel
      }}
    >
      {element}
    </AppStateProvider>,
    stdout as unknown as NodeJS.WriteStream,
  )

  try {
    await waitForCondition(() => messages.length > 0)
  } finally {
    instance.unmount()
    stdout.end()
  }

  expect(messages).toEqual([
    {
      message:
        "Model 'blocked-model' is not available. Your organization restricts model selection.",
      options: { display: 'system' },
    },
  ])
  expect(latestMainLoopModel).toBe('allowed-model')
})

test('/model does not auto-refresh descriptor models when nonessential traffic is disabled', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'
  process.env.OPENAI_API_KEY = 'sk-openrouter'
  delete process.env.OPENROUTER_API_KEY
  process.env.OPENAI_MODEL = 'openai/gpt-5-mini'
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.OPENAI_API_BASE

  mock.module('../../integrations/discoveryCache.js', () => ({
    clearDiscoveryCache: mock(async () => {}),
    getCachedModels: mock(async () => null),
    isCacheStale: mock(async () => true),
    parseDurationString: (value: number | string) =>
      typeof value === 'number' ? value : 86_400_000,
  }))

  const discoverModelsForRoute = mock(async () => {
    throw new Error('unexpected descriptor discovery')
  })

  mock.module('../../integrations/discoveryService.js', () => ({
    getDiscoveryCacheKey: (
      routeId: string,
      options?: { apiKey?: string; baseUrl?: string; headers?: Record<string, string> },
    ) => `${routeId}|${options?.baseUrl ?? ''}|${options?.apiKey ?? ''}|${JSON.stringify(options?.headers ?? {})}`,
    discoverModelsForRoute,
  }))

  mockProviderProfiles({
    getActiveOpenAIModelOptionsCache: () => [],
    getActiveProviderProfile: () => undefined,
    getProfileModelOptions: () => [],
    setActiveOpenAIModelOptionsCache: () => {},
  })

  const { call } = await importFreshModelModule('descriptor-privacy-open')
  const result = await call(() => {}, {} as never, '')

  expect(result).toBeTruthy()
  expect(discoverModelsForRoute).not.toHaveBeenCalled()
})

test('cross-profile /model switch drops latched fast mode before activating an unsupported target profile (#1119)', async () => {
  // Fast mode is enabled on the source provider; activating the target profile
  // flips isFastModeEnabled() to false (the new provider can't use fast mode).
  // This guards the ordering bug: reconcileFastModeForSwitch must evaluate
  // against the source provider (before activation), otherwise it short-circuits
  // to 'unchanged' once the new provider is active and leaves fastMode latched.
  let targetProfileActivated = false
  mock.module('../../utils/fastMode.js', () => ({
    ...REAL_FAST_MODE_FOR_MODEL_TEST,
    isFastModeEnabled: () => !targetProfileActivated,
    isFastModeSupportedByModel: (m: string | null) => m === 'claude-opus-4-7',
    isFastModeAvailable: () => true,
    clearFastModeCooldown: () => {},
  }))
  mockProviderProfiles({
    getProviderProfiles: () => [
      {
        id: 'profile_openai',
        name: 'OpenAI',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5-mini',
      },
    ],
    setActiveProviderProfile: (profileId: string) => {
      targetProfileActivated = true
      return {
        id: profileId,
        name: 'OpenAI',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5-mini',
      }
    },
  } as never)

  let capturedOnSelect:
    | ((model: string | null, effort: unknown, switchToProfileId?: string) => void)
    | undefined
  mock.module('../../components/ModelPicker.js', () => ({
    ModelPicker: function MockModelPicker(props: {
      onSelect?: (
        model: string | null,
        effort: unknown,
        switchToProfileId?: string,
      ) => void
    }): React.ReactNode {
      capturedOnSelect = props.onSelect
      return null
    },
  }))

  const { getDefaultAppState } = await import('../../state/AppState.js')
  const observedStates: Array<{ fastMode?: boolean }> = []
  const { call } = await importFreshModelModule('fast-cross-profile-order')
  const element = await call(() => {}, {} as never, '')
  const { AppStateProvider } = await import('../../state/AppState.js')
  const { render } = await import('../../ink.js')
  const stdout = new PassThrough()
  ;(stdout as unknown as { columns: number }).columns = 120
  const instance = await render(
    <AppStateProvider
      initialState={
        {
          ...getDefaultAppState(),
          fastMode: true,
          mainLoopModel: 'claude-opus-4-7',
        } as never
      }
      onChangeAppState={({
        newState,
      }: {
        newState: { fastMode?: boolean }
      }) => {
        observedStates.push(newState)
      }}
    >
      {element}
    </AppStateProvider>,
    stdout as unknown as NodeJS.WriteStream,
  )

  try {
    await waitForCondition(() => capturedOnSelect !== undefined)
    capturedOnSelect?.(
      encodeSwitchProfileValue('profile_openai', 'gpt-5-mini'),
      undefined,
      // The real ModelPicker threads the selected switch option's marker; the
      // mock picker mirrors that so handleSelect activates the profile.
      'profile_openai',
    )

    await waitForCondition(() =>
      observedStates.some(state => state.fastMode === false),
    )
    expect(observedStates.at(-1)?.fastMode).toBe(false)
  } finally {
    instance.unmount()
    // Restore the real fast-mode module for sibling tests in this file.
    mock.module('../../utils/fastMode.js', () => REAL_FAST_MODE_FOR_MODEL_TEST)
  }
})

test('cross-profile /model switch drops fast mode when the target provider cannot run it even though the model name passes source-side support (#1119)', async () => {
  // jatmn review edge case: the target model name passes isFastModeSupportedByModel
  // on the SOURCE provider, so the pre-activation reconcile returns 'on'. But the
  // target provider cannot run fast mode (isFastModeEnabled() flips false after
  // activation). The post-activation re-check must still force fastMode off rather
  // than leaving it latched and printing "Fast mode ON".
  let targetProfileActivated = false
  mock.module('../../utils/fastMode.js', () => ({
    ...REAL_FAST_MODE_FOR_MODEL_TEST,
    // Model name passes support on both sides; only the provider gating changes.
    isFastModeSupportedByModel: () => true,
    isFastModeAvailable: () => true,
    isFastModeEnabled: () => !targetProfileActivated,
    clearFastModeCooldown: () => {},
  }))
  mockProviderProfiles({
    getProviderProfiles: () => [
      {
        id: 'profile_shim',
        name: 'Custom Shim',
        provider: 'openai',
        baseUrl: 'https://shim.example/v1',
        model: 'claude-opus-4-6',
      },
    ],
    setActiveProviderProfile: (profileId: string) => {
      targetProfileActivated = true
      return {
        id: profileId,
        name: 'Custom Shim',
        provider: 'openai',
        baseUrl: 'https://shim.example/v1',
        model: 'claude-opus-4-6',
      }
    },
  } as never)

  let capturedOnSelect:
    | ((model: string | null, effort: unknown, switchToProfileId?: string) => void)
    | undefined
  mock.module('../../components/ModelPicker.js', () => ({
    ModelPicker: function MockModelPicker(props: {
      onSelect?: (
        model: string | null,
        effort: unknown,
        switchToProfileId?: string,
      ) => void
    }): React.ReactNode {
      capturedOnSelect = props.onSelect
      return null
    },
  }))

  const { getDefaultAppState } = await import('../../state/AppState.js')
  const observedStates: Array<{ fastMode?: boolean }> = []
  const { call } = await importFreshModelModule('fast-cross-profile-capability')
  const element = await call(() => {}, {} as never, '')
  const { AppStateProvider } = await import('../../state/AppState.js')
  const { render } = await import('../../ink.js')
  const stdout = new PassThrough()
  ;(stdout as unknown as { columns: number }).columns = 120
  const instance = await render(
    <AppStateProvider
      initialState={
        {
          ...getDefaultAppState(),
          fastMode: true,
          mainLoopModel: 'claude-opus-4-6',
        } as never
      }
      onChangeAppState={({
        newState,
      }: {
        newState: { fastMode?: boolean }
      }) => {
        observedStates.push(newState)
      }}
    >
      {element}
    </AppStateProvider>,
    stdout as unknown as NodeJS.WriteStream,
  )

  try {
    await waitForCondition(() => capturedOnSelect !== undefined)
    capturedOnSelect?.(
      encodeSwitchProfileValue('profile_shim', 'claude-opus-4-6'),
      undefined,
      // The real ModelPicker threads the selected switch option's marker; the
      // mock picker mirrors that so handleSelect activates the profile.
      'profile_shim',
    )

    await waitForCondition(() =>
      observedStates.some(state => state.fastMode === false),
    )
    expect(observedStates.at(-1)?.fastMode).toBe(false)
  } finally {
    instance.unmount()
    mock.module('../../utils/fastMode.js', () => REAL_FAST_MODE_FOR_MODEL_TEST)
  }
})

test('cross-profile /model switch surfaces the selected effort and extra-usage notice (#1119)', async () => {
  // jatmn review: the cross-profile branch built its own confirmation and
  // returned before the regular `/model` logic that appends the selected effort
  // and the cost-impacting `Billed as extra usage` notice. Selecting a target
  // through an inactive profile must show the same feedback the direct model
  // path does.
  mock.module('../../utils/extraUsage.js', () => ({
    ...REAL_EXTRA_USAGE_FOR_MODEL_TEST,
    isBilledAsExtraUsage: () => true,
  }))
  mockProviderProfiles({
    getProviderProfiles: () => [
      {
        id: 'profile_openai',
        name: 'OpenAI',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5-mini',
      },
    ],
    setActiveProviderProfile: (profileId: string) => ({
      id: profileId,
      name: 'OpenAI',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5-mini',
    }),
  } as never)

  let capturedOnSelect:
    | ((model: string | null, effort: unknown, switchToProfileId?: string) => void)
    | undefined
  mock.module('../../components/ModelPicker.js', () => ({
    ModelPicker: function MockModelPicker(props: {
      onSelect?: (
        model: string | null,
        effort: unknown,
        switchToProfileId?: string,
      ) => void
    }): React.ReactNode {
      capturedOnSelect = props.onSelect
      return null
    },
  }))

  const { getDefaultAppState } = await import('../../state/AppState.js')
  let doneMessage: string | undefined
  const { call } = await importFreshModelModule('cross-profile-confirmation')
  const element = await call(
    (message?: string) => {
      doneMessage = message
    },
    {} as never,
    '',
  )
  const { AppStateProvider } = await import('../../state/AppState.js')
  const { render } = await import('../../ink.js')
  const stdout = new PassThrough()
  ;(stdout as unknown as { columns: number }).columns = 120
  const instance = await render(
    <AppStateProvider
      initialState={
        {
          ...getDefaultAppState(),
          fastMode: false,
          mainLoopModel: 'claude-sonnet-4-6',
        } as never
      }
      onChangeAppState={() => {}}
    >
      {element}
    </AppStateProvider>,
    stdout as unknown as NodeJS.WriteStream,
  )

  try {
    await waitForCondition(() => capturedOnSelect !== undefined)
    capturedOnSelect?.(
      encodeSwitchProfileValue('profile_openai', 'gpt-5-mini'),
      'high',
      // The real ModelPicker threads the selected switch option's marker; the
      // mock picker mirrors that so handleSelect activates the profile.
      'profile_openai',
    )

    await waitForCondition(() => doneMessage !== undefined)
    expect(doneMessage).toContain('Switched to')
    expect(doneMessage).toContain('high effort')
    expect(doneMessage).toContain('Billed as extra usage')
  } finally {
    instance.unmount()
    mock.module('../../utils/extraUsage.js', () => REAL_EXTRA_USAGE_FOR_MODEL_TEST)
  }
})

test('cross-profile /model does NOT switch a literal prefixed model id lacking the switch marker (#1164)', async () => {
  // jatmn [P2]: a real custom model id such as
  // `__switch_profile__:profile_openai:gpt-5-mini` parses like a switch value
  // and `profile_openai` exists — but the selected option carried NO
  // switchToProfileId marker, so it must be applied as a literal model, never
  // activating the provider. The mock picker mirrors the real one by threading
  // an UNDEFINED marker for this non-switch option.
  let activatedProfileId: string | null = null
  mockProviderProfiles({
    getProviderProfiles: () => [
      {
        id: 'profile_openai',
        name: 'OpenAI',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5-mini',
      },
    ],
    setActiveProviderProfile: (profileId: string) => {
      activatedProfileId = profileId
      return {
        id: profileId,
        name: 'OpenAI',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5-mini',
      }
    },
  } as never)

  let capturedOnSelect:
    | ((model: string | null, effort: unknown, switchToProfileId?: string) => void)
    | undefined
  mock.module('../../components/ModelPicker.js', () => ({
    ModelPicker: function MockModelPicker(props: {
      onSelect?: (
        model: string | null,
        effort: unknown,
        switchToProfileId?: string,
      ) => void
    }): React.ReactNode {
      capturedOnSelect = props.onSelect
      return null
    },
  }))

  const { getDefaultAppState } = await import('../../state/AppState.js')
  let doneMessage: string | undefined
  const { call } = await importFreshModelModule('literal-prefixed-no-switch')
  const element = await call(
    (message?: string) => {
      doneMessage = message
    },
    {} as never,
    '',
  )
  const { AppStateProvider } = await import('../../state/AppState.js')
  const { render } = await import('../../ink.js')
  const stdout = new PassThrough()
  ;(stdout as unknown as { columns: number }).columns = 120
  const instance = await render(
    <AppStateProvider
      initialState={
        {
          ...getDefaultAppState(),
          fastMode: false,
          mainLoopModel: 'claude-sonnet-4-6',
        } as never
      }
      onChangeAppState={() => {}}
    >
      {element}
    </AppStateProvider>,
    stdout as unknown as NodeJS.WriteStream,
  )

  try {
    await waitForCondition(() => capturedOnSelect !== undefined)
    // Same encoded string, but NO marker threaded — this is a literal custom id.
    capturedOnSelect?.(
      encodeSwitchProfileValue('profile_openai', 'gpt-5-mini'),
      undefined,
      undefined,
    )

    await waitForCondition(() => doneMessage !== undefined)
    // Applied as a literal model, provider never activated.
    expect(activatedProfileId).toBeNull()
    expect(doneMessage).not.toContain('Switched to')
    expect(doneMessage).toContain(
      encodeSwitchProfileValue('profile_openai', 'gpt-5-mini'),
    )
  } finally {
    instance.unmount()
  }
})
