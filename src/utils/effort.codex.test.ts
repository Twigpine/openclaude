import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
// Import the real auth.js and providerConfig.js up front so we can spread
// their export surfaces into mock factories. `mock.module()` is process-global
// in bun:test and `mock.restore()` does not undo it (see user.test.ts), so
// any module we mock here needs to keep the full original export shape — or
// downstream tests that load it via openaiShim/client/codexShim crash with
// "Export named 'X' not found in module".
import * as actualAuth from './auth.js'
import * as actualThinking from './thinking.js'
import * as actualGrowthbook from 'src/services/analytics/growthbook.js'
import * as actualModelSupportOverrides from './model/modelSupportOverrides.js'
import type { APIProvider } from './model/providers.js'

type MockedThirdPartyCapability = 'effort' | 'max_effort' | 'xhigh_effort'

const originalEnv = { ...process.env }
const routingEnvKeys = [
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_VERTEX',
  'GEMINI_API_KEY',
  'MIMO_API_KEY',
  'MINIMAX_API_KEY',
  'NVIDIA_API_KEY',
  'NVIDIA_NIM',
  'OPENAI_API_BASE',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'XAI_API_KEY',
  'ZAI_API_KEY',
  'USER_TYPE',
] as const

function restoreMockedModulesToActual(): void {
  mock.module('./model/modelSupportOverrides.js', () => actualModelSupportOverrides)
  mock.module('./auth.js', () => actualAuth)
  mock.module('./thinking.js', () => actualThinking)
  mock.module('src/services/analytics/growthbook.js', () => actualGrowthbook)
}

function restoreProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!Object.hasOwn(originalEnv, key)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/effort.codex.test.ts')
  for (const key of routingEnvKeys) {
    delete process.env[key]
  }
})

afterEach(() => {
  try {
    mock.restore()
    restoreMockedModulesToActual()
    restoreProcessEnv()
  } finally {
    releaseSharedMutationLock()
  }
})

async function importFreshEffortModule(options: {
  provider: APIProvider
  supportsCodexReasoningEffort: boolean
  routeId?: string
  catalogEntries?: any[]
  modelDescriptors?: Record<string, any>
  openaiShimConfig?: any
  thirdPartyCapabilityOverrides?: {
    apiProvider: APIProvider
    capabilities: Partial<Record<MockedThirdPartyCapability, boolean>>
  }
  useRuntimeFallback?: boolean
}) {
  mock.module('./model/modelSupportOverrides.js', () => ({
    ...actualModelSupportOverrides,
    get3PModelCapabilityOverride: (
      _model: string,
      capability: MockedThirdPartyCapability,
      apiProvider?: APIProvider,
    ) => {
      const override = options.thirdPartyCapabilityOverrides
      if (!override || apiProvider !== override.apiProvider) return undefined
      return override.capabilities[capability]
    },
  }))
  mock.module('./auth.js', () => ({
    ...actualAuth,
    isProSubscriber: () => false,
    isMaxSubscriber: () => false,
    isTeamSubscriber: () => false,
  }))
  mock.module('./thinking.js', () => ({
    ...actualThinking,
    isUltrathinkEnabled: () => false,
  }))
  mock.module('src/services/analytics/growthbook.js', () => ({
    ...actualGrowthbook,
    getFeatureValue_CACHED_MAY_BE_STALE: (_key: string, fallback: unknown) =>
      fallback,
  }))

  const effort = await import(`./effort.js?ts=${Date.now()}-${Math.random()}`)
  const reasoningContext = (
    options.provider !== undefined ||
    options.supportsCodexReasoningEffort !== undefined ||
    options.routeId !== undefined ||
    options.catalogEntries !== undefined ||
    options.modelDescriptors !== undefined ||
    options.openaiShimConfig !== undefined ||
    options.useRuntimeFallback !== undefined
  )
    ? {
        apiProvider: options.provider,
        supportsCodexReasoningEffort: options.supportsCodexReasoningEffort,
        routeId: options.routeId,
        catalogEntries: options.catalogEntries,
        modelDescriptors: options.modelDescriptors,
        openaiShimConfig: options.openaiShimConfig,
        useRuntimeFallback: options.useRuntimeFallback,
      }
    : undefined

  return {
    ...effort,
    resolveModelReasoningControl: (model: string) =>
      effort.resolveModelReasoningControl(model, reasoningContext),
    resolveModelReasoningControlWithCompatibility: (
      model: string,
      compatibilityOverrides: {
        thinkingRequestFormat?: 'none' | 'deepseek-compatible' | 'zai-compatible'
        removeBodyFields?: string[]
      },
    ) => effort.resolveModelReasoningControl(
      model,
      reasoningContext,
      compatibilityOverrides,
    ),
    modelSupportsEffort: (model: string) =>
      effort.modelSupportsEffort(model, reasoningContext),
    modelSupportsWireEffort: (model: string) =>
      effort.modelSupportsWireEffort(model, reasoningContext),
    modelSupportsXHighEffort: (model: string) =>
      effort.modelSupportsXHighEffort(model, reasoningContext),
    getAvailableEffortLevels: (model: string) =>
      effort.getAvailableEffortLevels(model, reasoningContext),
    modelUsesOpenAIEffort: (model: string) =>
      effort.modelUsesOpenAIEffort(model, reasoningContext),
    getDefaultEffortForModel: (model: string) =>
      effort.getDefaultEffortForModel(model, reasoningContext),
    resolveAppliedEffort: (model: string, appStateEffortValue: unknown) =>
      effort.resolveAppliedEffort(model, appStateEffortValue, reasoningContext),
    clampUltracodeEffort: (appStateEffortValue: unknown, model: string) =>
      effort.clampUltracodeEffort(appStateEffortValue, model, reasoningContext),
    modelSupportsShimReasoningEffort: (
      model: string,
      thinkingRequestFormat?: unknown,
      removeBodyFields?: string[],
      context?: unknown,
    ) =>
      effort.modelSupportsShimReasoningEffort(
        model,
        thinkingRequestFormat,
        removeBodyFields,
        context ?? reasoningContext,
      ),
  }
}

test('gpt-5.4 on the ChatGPT Codex backend supports effort selection', async () => {
  const { getAvailableEffortLevels, modelSupportsEffort } =
    await importFreshEffortModule({
      provider: 'codex',
      supportsCodexReasoningEffort: true,
    })

  expect(modelSupportsEffort('gpt-5.4')).toBe(true)
  expect(getAvailableEffortLevels('gpt-5.4')).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
  ])
})

test('gpt-5.4 on the OpenAI provider still supports effort selection', async () => {
  const { getAvailableEffortLevels, modelSupportsEffort } =
    await importFreshEffortModule({
      provider: 'openai',
      supportsCodexReasoningEffort: true,
    })

  expect(modelSupportsEffort('gpt-5.4')).toBe(true)
  expect(getAvailableEffortLevels('gpt-5.4')).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
  ])
})

test('gpt-5.6 on an Azure custom-route base carries its default high effort from metadata', async () => {
  // Azure (and regional *.api.openai.com) bases resolve to route 'custom',
  // whose catalog is empty; the openai-catalog fallback must supply gpt-5.6's
  // advertised default 'high' instead of the legacy undefined. FAILS pre-fix
  // (getDefaultEffortForModel returns undefined on route 'custom').
  const snapshot = {
    CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_API_BASE: process.env.OPENAI_API_BASE,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_AZURE_STYLE: process.env.OPENAI_AZURE_STYLE,
  }
  delete process.env.OPENAI_API_BASE
  delete process.env.OPENAI_AZURE_STYLE
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://myres.openai.azure.com/openai/v1'
  process.env.OPENAI_API_KEY = 'test-key'

  try {
    const { getDefaultEffortForModel, getAvailableEffortLevels } =
      await importFreshEffortModule({
        provider: 'openai',
        supportsCodexReasoningEffort: true,
      })

    expect(getDefaultEffortForModel('gpt-5.6-sol')).toBe('high')
    expect(getAvailableEffortLevels('gpt-5.6-sol')).toContain('xhigh')
  } finally {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
})

test('gpt-5.6 on a regional OpenAI base carries its default high effort from metadata', async () => {
  // eu.api.openai.com is an OpenAI-controlled surface (endsWith '.api.openai.com')
  // that still resolves to route 'custom'; the gated fallback must fire.
  const snapshot = {
    CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_API_BASE: process.env.OPENAI_API_BASE,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_AZURE_STYLE: process.env.OPENAI_AZURE_STYLE,
  }
  delete process.env.OPENAI_API_BASE
  delete process.env.OPENAI_AZURE_STYLE
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://eu.api.openai.com/v1'
  process.env.OPENAI_API_KEY = 'test-key'

  try {
    const { getDefaultEffortForModel } = await importFreshEffortModule({
      provider: 'openai',
      supportsCodexReasoningEffort: true,
    })

    expect(getDefaultEffortForModel('gpt-5.6-sol')).toBe('high')
  } finally {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
})

test('gpt-5.6 on an arbitrary OpenAI-compatible gateway does NOT get an injected default effort', async () => {
  // A gateway base resolves to route 'custom' too, but is not a verified
  // OpenAI/Azure surface — the fallback must NOT fire, so gpt-5.6 stays on
  // legacy controls (no injected reasoning_effort default). FAILS pre-fix
  // (the ungated round-3 fallback returned 'high').
  const snapshot = {
    CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_API_BASE: process.env.OPENAI_API_BASE,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_AZURE_STYLE: process.env.OPENAI_AZURE_STYLE,
  }
  delete process.env.OPENAI_API_BASE
  delete process.env.OPENAI_AZURE_STYLE
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://gateway.example/v1'
  process.env.OPENAI_API_KEY = 'test-key'

  try {
    const { getDefaultEffortForModel } = await importFreshEffortModule({
      provider: 'openai',
      supportsCodexReasoningEffort: true,
    })

    expect(getDefaultEffortForModel('gpt-5.6-sol')).not.toBe('high')
    expect(getDefaultEffortForModel('gpt-5.6-sol')).toBeUndefined()
  } finally {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
})

test('gpt-5.3-codex-spark stays without effort controls', async () => {
  const { getAvailableEffortLevels, modelSupportsEffort } =
    await importFreshEffortModule({
      provider: 'codex',
      supportsCodexReasoningEffort: false,
    })

  expect(modelSupportsEffort('gpt-5.3-codex-spark')).toBe(false)
  expect(getAvailableEffortLevels('gpt-5.3-codex-spark')).toEqual([])
})

test('toPersistableEffort passes xhigh through as a first-class level', async () => {
  const { toPersistableEffort } = await importFreshEffortModule({
    provider: 'openai',
    supportsCodexReasoningEffort: true,
  })

  expect(toPersistableEffort('xhigh')).toBe('xhigh')
  expect(toPersistableEffort('max')).toBe('max')
  expect(toPersistableEffort('high')).toBe('high')
  expect(toPersistableEffort('medium')).toBe('medium')
  expect(toPersistableEffort('low')).toBe('low')
  expect(toPersistableEffort(undefined)).toBeUndefined()
})

test('standardEffortToOpenAI maps max to xhigh for shim payload', async () => {
  const { standardEffortToOpenAI, openAIEffortToStandard } =
    await importFreshEffortModule({
      provider: 'openai',
      supportsCodexReasoningEffort: true,
    })

  expect(standardEffortToOpenAI('max')).toBe('xhigh')
  expect(standardEffortToOpenAI('xhigh')).toBe('xhigh')
  expect(standardEffortToOpenAI('high')).toBe('high')
  expect(openAIEffortToStandard('xhigh')).toBe('xhigh')
  expect(openAIEffortToStandard('high')).toBe('high')
})

test('e2e: xhigh → persisted xhigh → resolveAppliedEffort → wire xhigh on OpenAI/Codex (no high clamp)', async () => {
  const {
    toPersistableEffort,
    resolveAppliedEffort,
    standardEffortToOpenAI,
  } = await importFreshEffortModule({
    provider: 'openai',
    supportsCodexReasoningEffort: true,
  })

  // Picker writes 'xhigh'; toPersistableEffort passes it through.
  const persisted = toPersistableEffort('xhigh')
  expect(persisted).toBe('xhigh')

  // App state holds 'xhigh'. The OpenAI-shaped 'xhigh' is sent to the API as-is.
  const applied = resolveAppliedEffort('gpt-5.4', persisted)
  expect(applied).toBe('xhigh')

  // Final wire value the client shim emits.
  expect(standardEffortToOpenAI(applied as 'xhigh')).toBe('xhigh')
})

test('e2e: max on non-Opus Anthropic model still clamps to high', async () => {
  const { resolveAppliedEffort } = await importFreshEffortModule({
    provider: 'firstParty',
    supportsCodexReasoningEffort: false,
  })

  expect(resolveAppliedEffort('claude-sonnet-4-6', 'max')).toBe('high')
})

test('modelSupportsXHighEffort: opus-4-7 and opus-4-8 are allowed; other Claude models are not', async () => {
  const { modelSupportsXHighEffort } = await importFreshEffortModule({
    provider: 'firstParty',
    supportsCodexReasoningEffort: false,
  })

  expect(modelSupportsXHighEffort('claude-opus-4-7')).toBe(true)
  expect(modelSupportsXHighEffort('claude-opus-4-8')).toBe(true)
  expect(modelSupportsXHighEffort('opencode-claude-opus-4-8')).toBe(true)
  expect(modelSupportsXHighEffort('claude-opus-4-6')).toBe(false)
  expect(modelSupportsXHighEffort('claude-sonnet-4-6')).toBe(false)
  expect(modelSupportsXHighEffort('claude-sonnet-4-5')).toBe(false)
  expect(modelSupportsXHighEffort('claude-haiku-4-5')).toBe(false)
  expect(modelSupportsXHighEffort('claude-3-5-haiku')).toBe(false)
})

test('xhigh does not appear in available levels for non-supporting models', async () => {
  const { getAvailableEffortLevels } = await importFreshEffortModule({
    provider: 'firstParty',
    supportsCodexReasoningEffort: false,
  })

  // No xhigh, no max
  expect(getAvailableEffortLevels('claude-sonnet-4-6')).toEqual([
    'low',
    'medium',
    'high',
  ])
  expect(getAvailableEffortLevels('claude-haiku-4-5')).toEqual([])

  // Has xhigh AND max AND ultracode (opus-4-8 on firstParty)
  const opusLevels = getAvailableEffortLevels('claude-opus-4-8')
  expect(opusLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
})

test('effort allowlist is narrowed to the shim isAdaptive||isOpus45 set', async () => {
  // The Anthropic /messages shim only serializes low/medium as
  // anthropicBody.effort for opus-4-5/4-6/4-7/4-8 and sonnet-4-6. For
  // older variants it only emits thinking for high/max — advertising
  // effort for them would silently drop low/medium on the wire.
  const { modelSupportsEffort, getAvailableEffortLevels } =
    await importFreshEffortModule({
      provider: 'firstParty',
      supportsCodexReasoningEffort: false,
    })

  // Inside the shim set → supported
  for (const model of [
    'claude-opus-4-5',
    'claude-opus-4-6',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-sonnet-4-6',
    'opencode-claude-opus-4-7',
  ]) {
    expect(modelSupportsEffort(model)).toBe(true)
  }

  // Outside the shim set → not supported (was previously true via the
  // broad `claude-opus-4*` / `claude-sonnet-4*` substring match)
  for (const model of [
    'claude-opus-4-1',
    'claude-opus-4-2',
    'claude-sonnet-4-5',
  ]) {
    expect(modelSupportsEffort(model)).toBe(false)
    expect(getAvailableEffortLevels(model)).toEqual([])
  }
})

test('xhigh clamps to high on non-supporting models so stale settings.json values do not produce API errors', async () => {
  const { resolveAppliedEffort } = await importFreshEffortModule({
    provider: 'firstParty',
    supportsCodexReasoningEffort: false,
  })

  // sonnet-4-6 supports effort but not xhigh — clamp
  expect(resolveAppliedEffort('claude-sonnet-4-6', 'xhigh')).toBe('high')
  // opus-4-8 supports xhigh — pass through
  expect(resolveAppliedEffort('claude-opus-4-8', 'xhigh')).toBe('xhigh')
})

test('clampUltracodeEffort: clamps to xhigh on non-firstParty xhigh-capable model', async () => {
  const { clampUltracodeEffort, resolveAppliedEffort } = await importFreshEffortModule({
    provider: 'openai',
    supportsCodexReasoningEffort: true,
    routeId: 'opencode',
    useRuntimeFallback: false,
    openaiShimConfig: { endpointPath: '/messages' },
  })

  // ultracode isn't selectable off firstParty, so it clamps — but to xhigh
  // (the model is xhigh-capable), matching resolveAppliedEffort's mapping
  // rather than the old hardcoded 'max'.
  expect(clampUltracodeEffort('ultracode', 'claude-opus-4-8')).toBe('xhigh')
  expect(clampUltracodeEffort('ultracode', 'claude-opus-4-8')).toBe(
    resolveAppliedEffort('claude-opus-4-8', 'ultracode'),
  )
  expect(clampUltracodeEffort('max', 'claude-opus-4-8')).toBe('max')
  expect(clampUltracodeEffort('high', 'claude-opus-4-8')).toBe('high')
  expect(clampUltracodeEffort(undefined, 'claude-opus-4-8')).toBeUndefined()
})

test('clampUltracodeEffort: clamps to high on firstParty non-xhigh model', async () => {
  const { clampUltracodeEffort, resolveAppliedEffort } = await importFreshEffortModule({
    provider: 'firstParty',
    supportsCodexReasoningEffort: false,
  })

  // Not xhigh-capable -> clamp to high, the same level the env/app-state path
  // (resolveAppliedEffort) sends for ultracode. Previously this returned 'max',
  // so the two paths disagreed on max-capable-but-not-xhigh models.
  expect(clampUltracodeEffort('ultracode', 'claude-sonnet-4-6')).toBe('high')
  expect(clampUltracodeEffort('ultracode', 'claude-sonnet-4-6')).toBe(
    resolveAppliedEffort('claude-sonnet-4-6', 'ultracode'),
  )
})

test('clampUltracodeEffort: preserves ultracode on firstParty + xhigh-capable model', async () => {
  const { clampUltracodeEffort } = await importFreshEffortModule({
    provider: 'firstParty' as unknown as 'openai',
    supportsCodexReasoningEffort: false,
  })

  expect(clampUltracodeEffort('ultracode', 'claude-opus-4-8')).toBe('ultracode')
})

test('parseFrontmatterEffortValue: rejects ultracode but passes other levels/integers through', async () => {
  const { parseFrontmatterEffortValue } = await importFreshEffortModule({
    provider: 'openai',
    supportsCodexReasoningEffort: true,
  })

  // ultracode is session-only; frontmatter cannot grant its permission, so reject it
  expect(parseFrontmatterEffortValue('ultracode')).toBeUndefined()
  expect(parseFrontmatterEffortValue('ULTRACODE')).toBeUndefined()
  // every other valid level still parses
  expect(parseFrontmatterEffortValue('low')).toBe('low')
  expect(parseFrontmatterEffortValue('medium')).toBe('medium')
  expect(parseFrontmatterEffortValue('high')).toBe('high')
  expect(parseFrontmatterEffortValue('xhigh')).toBe('xhigh')
  expect(parseFrontmatterEffortValue('max')).toBe('max')
  expect(parseFrontmatterEffortValue(42)).toBe(42)
  // genuinely invalid values still return undefined
  expect(parseFrontmatterEffortValue('nonsense')).toBeUndefined()
  expect(parseFrontmatterEffortValue(undefined)).toBeUndefined()
})

test('modelUsesOpenAIEffort: Claude/Gemini are excluded even on the openai provider (OpenCode native route)', async () => {
  const { modelUsesOpenAIEffort } = await importFreshEffortModule({
    provider: 'openai',
    supportsCodexReasoningEffort: true,
  })

  // Native Claude/Gemini on OpenCode use Anthropic/Google format, not OpenAI
  expect(modelUsesOpenAIEffort('claude-opus-4-8')).toBe(false)
  expect(modelUsesOpenAIEffort('claude-sonnet-4-6')).toBe(false)
  expect(modelUsesOpenAIEffort('gemini-3-flash')).toBe(false)
  // Real OpenAI-shaped models still classify as OpenAI
  expect(modelUsesOpenAIEffort('gpt-5.4')).toBe(true)
})

test('supportsReasoning-only catalog entries do not enable effort or wire mutation', async () => {
  const {
    getAvailableEffortLevels,
    modelSupportsEffort,
    modelSupportsWireEffort,
    resolveAppliedEffort,
    resolveModelReasoningControl,
  } = await importFreshEffortModule({
    provider: 'openai',
    supportsCodexReasoningEffort: false,
    routeId: 'atlas-cloud',
    catalogEntries: [
      {
        id: 'moonshotai/kimi-k2.5',
        apiName: 'moonshotai/kimi-k2.5',
        capabilities: { supportsReasoning: true },
      },
    ],
  })

  expect(resolveModelReasoningControl('moonshotai/kimi-k2.5')).toMatchObject({
    supportsReasoning: true,
    controllable: false,
    source: 'capability',
  })
  expect(modelSupportsEffort('moonshotai/kimi-k2.5')).toBe(false)
  expect(modelSupportsWireEffort('moonshotai/kimi-k2.5')).toBe(false)
  expect(getAvailableEffortLevels('moonshotai/kimi-k2.5')).toEqual([])
  expect(resolveAppliedEffort('moonshotai/kimi-k2.5', 'high')).toBeUndefined()
})

test('explicit reasoning metadata enables model-level effort without provider-wide inference', async () => {
  const {
    getAvailableEffortLevels,
    getDefaultEffortForModel,
    modelSupportsEffort,
    modelSupportsWireEffort,
    resolveAppliedEffort,
    resolveModelReasoningControl,
  } = await importFreshEffortModule({
    provider: 'openai',
    supportsCodexReasoningEffort: false,
    routeId: 'atlas-cloud',
    catalogEntries: [
      {
        id: 'moonshotai/kimi-k2.6',
        apiName: 'moonshotai/kimi-k2.6',
        capabilities: { supportsReasoning: true },
        reasoning: {
          mode: 'levels',
          levels: ['low', 'medium', 'high'],
          defaultLevel: 'medium',
          wireFormat: 'reasoning_effort',
        },
      },
      {
        id: 'xai/grok-build-0.1',
        apiName: 'xai/grok-build-0.1',
        capabilities: { supportsReasoning: false },
      },
    ],
  })

  expect(resolveModelReasoningControl('moonshotai/kimi-k2.6')).toMatchObject({
    supportsReasoning: true,
    controllable: true,
    source: 'metadata',
    levels: ['low', 'medium', 'high'],
    defaultLevel: 'medium',
    wireFormat: 'reasoning_effort',
  })
  expect(modelSupportsEffort('moonshotai/kimi-k2.6')).toBe(true)
  expect(modelSupportsWireEffort('moonshotai/kimi-k2.6')).toBe(true)
  expect(getAvailableEffortLevels('moonshotai/kimi-k2.6')).toEqual([
    'low',
    'medium',
    'high',
  ])
  expect(getDefaultEffortForModel('moonshotai/kimi-k2.6')).toBe('medium')
  expect(resolveAppliedEffort('moonshotai/kimi-k2.6', undefined)).toBe('medium')
  expect(resolveAppliedEffort('moonshotai/kimi-k2.6', 'xhigh')).toBe('high')

  expect(resolveModelReasoningControl('xai/grok-build-0.1')).toMatchObject({
    supportsReasoning: false,
    controllable: false,
    source: 'capability',
  })
  expect(modelSupportsEffort('xai/grok-build-0.1')).toBe(false)
  expect(modelSupportsWireEffort('xai/grok-build-0.1')).toBe(false)
  expect(resolveAppliedEffort('xai/grok-build-0.1', 'high')).toBeUndefined()
})

test('Moonshot direct and Kimi Code catalogs expose verified reasoning controls', async () => {
  const moonshotVendor = (await import('../integrations/vendors/moonshot.js')).default
  const kimiCodeGateway = (await import('../integrations/gateways/kimi-code.js')).default

  expect(moonshotVendor.catalog?.models?.map(model => model.id)).toEqual([
    'k3',
    'kimi-k2.7-code',
    'kimi-k2.6',
    'kimi-k2.5',
  ])

  for (const { routeId, model, entries } of [
    { routeId: 'moonshot', model: 'kimi-k2.6', entries: moonshotVendor.catalog?.models ?? [] },
    { routeId: 'kimi-code', model: 'kimi-for-coding', entries: kimiCodeGateway.catalog?.models ?? [] },
    { routeId: 'kimi-code', model: 'kimi-k2.7-code', entries: kimiCodeGateway.catalog?.models ?? [] },
    { routeId: 'kimi-code', model: 'moonshotai/kimi-k2.7-code', entries: kimiCodeGateway.catalog?.models ?? [] },
  ]) {
    const {
      getAvailableEffortLevels,
      getDefaultEffortForModel,
      modelSupportsEffort,
      modelSupportsWireEffort,
      resolveAppliedEffort,
      resolveModelReasoningControl,
    } = await importFreshEffortModule({
      provider: 'openai',
      supportsCodexReasoningEffort: false,
      routeId,
      catalogEntries: entries,
    })

    expect(resolveModelReasoningControl(model)).toMatchObject({
      supportsReasoning: true,
      controllable: true,
      source: 'metadata',
      levels: ['low', 'medium', 'high'],
      defaultLevel: 'medium',
      wireFormat: 'reasoning_effort',
    })
    expect(modelSupportsEffort(model)).toBe(true)
    expect(modelSupportsWireEffort(model)).toBe(true)
    expect(getAvailableEffortLevels(model)).toEqual(['low', 'medium', 'high'])
    expect(getDefaultEffortForModel(model)).toBe('medium')
    expect(resolveAppliedEffort(model, undefined)).toBe('medium')
    expect(resolveAppliedEffort(model, 'xhigh')).toBe('high')
    expect(resolveAppliedEffort(model, 'max')).toBe('high')
  }

  const {
    getAvailableEffortLevels,
    resolveAppliedEffort,
    resolveModelReasoningControl,
  } = await importFreshEffortModule({
    provider: 'openai',
    supportsCodexReasoningEffort: false,
    routeId: 'moonshot',
    catalogEntries: moonshotVendor.catalog?.models ?? [],
  })

  expect(resolveModelReasoningControl('k3')).toMatchObject({
    supportsReasoning: true,
    controllable: true,
    source: 'metadata',
    levels: ['low', 'high', 'max'],
    defaultLevel: 'max',
    wireFormat: 'reasoning_effort',
  })
  expect(getAvailableEffortLevels('k3')).toEqual(['low', 'high', 'max'])
  expect(resolveAppliedEffort('k3', undefined)).toBe('max')
  expect(resolveAppliedEffort('k3', 'low')).toBe('low')
  expect(resolveAppliedEffort('k3', 'xhigh')).toBe('max')

  const { resolveAppliedEffort: resolveHicapAppliedEffort } =
    await importFreshEffortModule({
      provider: 'openai',
      supportsCodexReasoningEffort: false,
      routeId: 'hicap',
      catalogEntries: [{
        id: 'hicap-claude-opus-4.8',
        apiName: 'claude-opus-4.8',
        capabilities: { supportsReasoning: true },
        reasoning: {
          mode: 'levels',
          levels: ['low', 'medium', 'high', 'xhigh', 'max'],
          wireFormat: 'reasoning_effort',
        },
      }],
    })
  expect(resolveHicapAppliedEffort('claude-opus-4.8', 'xhigh')).toBe('xhigh')

  expect(resolveModelReasoningControl('kimi-k2.7-code')).toMatchObject({
    supportsReasoning: true,
    controllable: true,
    source: 'metadata',
    levels: ['low', 'medium', 'high'],
    defaultLevel: 'medium',
    wireFormat: 'reasoning_effort',
  })
  expect(getAvailableEffortLevels('kimi-k2.7-code')).toEqual(['low', 'medium', 'high'])
  expect(resolveAppliedEffort('kimi-k2.7-code', 'xhigh')).toBe('high')
  expect(resolveAppliedEffort('kimi-k2.7-code', 'max')).toBe('high')
  expect(resolveModelReasoningControl('moonshotai/kimi-k2.7-code')).toMatchObject({
    supportsReasoning: true,
    controllable: true,
    source: 'metadata',
    levels: ['low', 'medium', 'high'],
    defaultLevel: 'medium',
    wireFormat: 'reasoning_effort',
  })
  expect(getAvailableEffortLevels('moonshotai/kimi-k2.7-code')).toEqual(['low', 'medium', 'high'])
  expect(resolveAppliedEffort('moonshotai/kimi-k2.7-code', 'xhigh')).toBe('high')
})
test('Atlas Cloud catalog exposes only verified reasoning controls for exact models', async () => {
  const atlasGateway = (await import('../integrations/gateways/atlas-cloud.js')).default
  const {
    getAvailableEffortLevels,
    modelSupportsEffort,
    modelSupportsWireEffort,
    resolveAppliedEffort,
    resolveModelReasoningControl,
  } = await importFreshEffortModule({
    provider: 'openai',
    supportsCodexReasoningEffort: false,
    routeId: 'atlas-cloud',
    catalogEntries: atlasGateway.catalog?.models ?? [],
  })

  expect(resolveModelReasoningControl('moonshotai/kimi-k2.5')).toMatchObject({
    supportsReasoning: true,
    controllable: true,
    source: 'metadata',
    levels: ['low', 'medium', 'high', 'xhigh'],
    defaultLevel: 'medium',
    wireFormat: 'reasoning_effort',
  })
  expect(getAvailableEffortLevels('moonshotai/kimi-k2.5')).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
  ])
  expect(resolveAppliedEffort('moonshotai/kimi-k2.5', 'max')).toBe('high')

  expect(resolveModelReasoningControl('moonshotai/kimi-k2.6')).toMatchObject({
    supportsReasoning: true,
    controllable: true,
    source: 'metadata',
    levels: ['low', 'medium', 'high', 'xhigh'],
    defaultLevel: 'medium',
    wireFormat: 'reasoning_effort',
  })
  expect(getAvailableEffortLevels('moonshotai/kimi-k2.6')).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
  ])
  expect(resolveAppliedEffort('moonshotai/kimi-k2.6', 'xhigh')).toBe('xhigh')
  expect(resolveAppliedEffort('moonshotai/kimi-k2.6', 'max')).toBe('high')

  expect(resolveModelReasoningControl('glm-5.2')).toMatchObject({
    supportsReasoning: true,
    controllable: true,
    source: 'metadata',
    levels: ['high', 'xhigh'],
    wireFormat: 'zai_compatible',
  })
  expect(getAvailableEffortLevels('glm-5.2')).toEqual(['high', 'xhigh'])
  expect(resolveAppliedEffort('glm-5.2', 'xhigh')).toBe('xhigh')

  const verifiedAtlasReasoningModels = [
    'deepseek-ai/deepseek-v4-pro',
    'deepseek-ai/deepseek-v4-flash',
    'deepseek-ai/deepseek-v3.2',
    'deepseek-ai/DeepSeek-V3.2-Exp',
    'anthropic/claude-opus-4.8',
    'anthropic/claude-sonnet-4.6',
    'anthropic/claude-sonnet-4.6-coding',
    'anthropic/claude-haiku-4.5-20251001',
    'anthropic/claude-haiku-4.5-20251001-coding',
    'openai/gpt-5.5',
    'openai/gpt-5.4',
    'google/gemini-3.5-flash',
    'google/gemini-3.1-pro-preview',
    'minimaxai/minimax-m3',
    'minimaxai/minimax-m2.7',
    'minimaxai/minimax-m2.5',
    'qwen/qwen3.7-max',
    'qwen/qwen3.7-plus',
    'qwen/qwen3.6-plus',
    'qwen/qwen3.6-35b-a3b',
    'qwen/qwen3.5-397b-a17b',
    'qwen/qwen3.5-122b-a10b',
    'qwen/qwen3.5-35b-a3b',
    'qwen/qwen3.5-27b',
    'qwen/qwen3-vl-30b-a3b-thinking',
    'Qwen/Qwen3-Next-80B-A3B-Thinking',
  ]
  for (const model of verifiedAtlasReasoningModels) {
    expect(resolveModelReasoningControl(model)).toMatchObject({
      supportsReasoning: true,
      controllable: true,
      source: 'metadata',
      levels: ['low', 'medium', 'high', 'xhigh'],
      wireFormat: 'reasoning_effort',
    })
    expect(getAvailableEffortLevels(model)).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(resolveAppliedEffort(model, 'xhigh')).toBe('xhigh')
    expect(resolveAppliedEffort(model, 'max')).toBe('high')
  }

  const verifiedAtlasZaiGlmModels = [
    'zai-org/glm-5.2',
    'zai-org/glm-5.1',
    'zai-org/glm-5',
    'zai-org/glm-5-turbo',
    'zai-org/glm-5v-turbo',
    'zai-org/glm-4.7',
    'zai-org/GLM-4.6',
  ]
  for (const model of verifiedAtlasZaiGlmModels) {
    expect(resolveModelReasoningControl(model)).toMatchObject({
      supportsReasoning: true,
      controllable: true,
      source: 'metadata',
      levels: ['high', 'xhigh'],
      wireFormat: 'zai_compatible',
    })
    expect(getAvailableEffortLevels(model)).toEqual(['high', 'xhigh'])
    expect(resolveAppliedEffort(model, 'xhigh')).toBe('xhigh')
    expect(resolveAppliedEffort(model, 'max')).toBe('high')
  }

  expect(resolveModelReasoningControl('xai/grok-4.6')).toMatchObject({
    supportsReasoning: true,
    controllable: true,
    source: 'metadata',
    levels: ['low', 'medium', 'high', 'xhigh'],
    defaultLevel: 'high',
    wireFormat: 'reasoning_effort',
  })
  expect(getAvailableEffortLevels('xai/grok-4.6')).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
  ])
  expect(resolveAppliedEffort('xai/grok-4.6', 'xhigh')).toBe('xhigh')
  expect(resolveAppliedEffort('xai/grok-4.6', 'max')).toBe('high')

  expect(resolveModelReasoningControl('xai/grok-4.5')).toMatchObject({
    supportsReasoning: true,
    controllable: true,
    source: 'metadata',
    levels: ['low', 'medium', 'high'],
    defaultLevel: 'high',
    wireFormat: 'reasoning_effort',
  })
  expect(getAvailableEffortLevels('xai/grok-4.5')).toEqual(['low', 'medium', 'high'])
  expect(resolveAppliedEffort('xai/grok-4.5', 'xhigh')).toBe('high')

  expect(resolveModelReasoningControl('xai/grok-4.3')).toMatchObject({
    supportsReasoning: true,
    controllable: true,
    source: 'metadata',
    levels: ['low', 'medium', 'high'],
    wireFormat: 'reasoning_effort',
  })
  expect(getAvailableEffortLevels('xai/grok-4.3')).toEqual(['low', 'medium', 'high'])
  expect(resolveAppliedEffort('xai/grok-4.3', 'xhigh')).toBe('high')
  expect(resolveAppliedEffort('xai/grok-4.3', 'max')).toBe('high')

  const verifiedAtlasHighOnlyReasoningModels = [
    'bytedance/doubao-seed-2.0-pro-260215',
    'bytedance/doubao-seed-2.0-code-preview-260215',
    'bytedance/doubao-seed-2.0-lite-260428',
    'bytedance/doubao-seed-2.0-mini-260428',
  ]
  for (const model of verifiedAtlasHighOnlyReasoningModels) {
    expect(resolveModelReasoningControl(model)).toMatchObject({
      supportsReasoning: true,
      controllable: true,
      source: 'metadata',
      levels: ['low', 'medium', 'high'],
      wireFormat: 'reasoning_effort',
    })
    expect(getAvailableEffortLevels(model)).toEqual(['low', 'medium', 'high'])
    expect(resolveAppliedEffort(model, 'xhigh')).toBe('high')
  }

  expect(resolveModelReasoningControl('owl')).toMatchObject({
    supportsReasoning: false,
    controllable: false,
  })

  expect(resolveModelReasoningControl('moonshotai/kimi-k2.7-code')).toMatchObject({
    supportsReasoning: true,
    controllable: true,
    source: 'metadata',
    levels: ['low', 'medium', 'high'],
    defaultLevel: 'medium',
    wireFormat: 'reasoning_effort',
  })
  expect(modelSupportsEffort('moonshotai/kimi-k2.7-code')).toBe(true)
  expect(modelSupportsWireEffort('moonshotai/kimi-k2.7-code')).toBe(true)
  expect(resolveAppliedEffort('moonshotai/kimi-k2.7-code', 'xhigh')).toBe('high')

  expect(resolveModelReasoningControl('xai/grok-build-0.1')).toMatchObject({
    supportsReasoning: false,
    controllable: false,
    source: 'capability',
  })
  expect(modelSupportsEffort('xai/grok-build-0.1')).toBe(false)
  expect(modelSupportsWireEffort('xai/grok-build-0.1')).toBe(false)
  expect(resolveAppliedEffort('xai/grok-build-0.1', 'high')).toBeUndefined()
})

test('xAI catalog exposes live-verified reasoning controls for direct Grok models', async () => {
  const xaiVendor = (await import('../integrations/vendors/xai.js')).default
  const {
    getAvailableEffortLevels,
    modelSupportsEffort,
    modelSupportsWireEffort,
    resolveAppliedEffort,
    resolveModelReasoningControl,
  } = await importFreshEffortModule({
    provider: 'openai',
    supportsCodexReasoningEffort: false,
    routeId: 'xai',
    catalogEntries: xaiVendor.catalog?.models ?? [],
  })

  for (const model of ['grok-4.6', 'grok-4.6-latest']) {
    expect(resolveModelReasoningControl(model)).toMatchObject({
      supportsReasoning: true,
      controllable: true,
      source: 'metadata',
      levels: ['low', 'medium', 'high', 'xhigh'],
      defaultLevel: 'high',
      wireFormat: 'reasoning_effort',
    })
    expect(modelSupportsEffort(model)).toBe(true)
    expect(modelSupportsWireEffort(model)).toBe(true)
    expect(getAvailableEffortLevels(model)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ])
    expect(resolveAppliedEffort(model, 'xhigh')).toBe('xhigh')
    expect(resolveAppliedEffort(model, 'max')).toBe('high')
  }

  for (const model of ['grok-4.5', 'grok-4.5-latest', 'grok-build-latest']) {
    expect(resolveModelReasoningControl(model)).toMatchObject({
      supportsReasoning: true,
      controllable: true,
      source: 'metadata',
      levels: ['low', 'medium', 'high'],
      defaultLevel: 'high',
      wireFormat: 'reasoning_effort',
    })
    expect(getAvailableEffortLevels(model)).toEqual(['low', 'medium', 'high'])
    expect(resolveAppliedEffort(model, 'xhigh')).toBe('high')
  }

  for (const model of ['grok-4.3', 'grok-4.3-latest', 'grok-latest', 'grok-4', 'grok-3']) {
    expect(resolveModelReasoningControl(model)).toMatchObject({
      supportsReasoning: true,
      controllable: true,
      source: 'metadata',
      levels: ['low', 'medium', 'high'],
      wireFormat: 'reasoning_effort',
    })
    expect(modelSupportsEffort(model)).toBe(true)
    expect(modelSupportsWireEffort(model)).toBe(true)
    expect(getAvailableEffortLevels(model)).toEqual(['low', 'medium', 'high'])
    expect(resolveAppliedEffort(model, 'xhigh')).toBe('high')
    expect(resolveAppliedEffort(model, 'max')).toBe('high')
  }

  for (const model of ['grok-4.20-0309-reasoning', 'grok-4.20']) {
    expect(resolveModelReasoningControl(model)).toMatchObject({
      supportsReasoning: true,
      controllable: false,
      source: 'metadata',
      wireFormat: 'none',
    })
    expect(modelSupportsEffort(model)).toBe(false)
    expect(modelSupportsWireEffort(model)).toBe(false)
    expect(resolveAppliedEffort(model, 'xhigh')).toBeUndefined()
  }

  expect(resolveModelReasoningControl('grok-4.20-0309-non-reasoning')).toMatchObject({
    supportsReasoning: false,
    controllable: false,
    source: 'capability',
  })
  expect(modelSupportsEffort('grok-4.20-0309-non-reasoning')).toBe(false)
})

test('explicit non-controllable metadata opts out even when the model matches legacy rules', async () => {
  const {
    getAvailableEffortLevels,
    modelSupportsEffort,
    modelSupportsWireEffort,
    resolveAppliedEffort,
    resolveModelReasoningControl,
  } = await importFreshEffortModule({
    provider: 'openai',
    supportsCodexReasoningEffort: true,
    routeId: 'custom-gateway',
    catalogEntries: [
      {
        id: 'gpt-5.4',
        apiName: 'gpt-5.4',
        capabilities: { supportsReasoning: true },
        reasoning: {
          mode: 'always-on',
          wireFormat: 'none',
        },
      },
    ],
  })

  expect(resolveModelReasoningControl('gpt-5.4')).toMatchObject({
    supportsReasoning: true,
    controllable: false,
    source: 'metadata',
    wireFormat: 'none',
  })
  expect(modelSupportsEffort('gpt-5.4')).toBe(false)
  expect(modelSupportsWireEffort('gpt-5.4')).toBe(false)
  expect(getAvailableEffortLevels('gpt-5.4')).toEqual([])
  expect(resolveAppliedEffort('gpt-5.4', 'high')).toBeUndefined()
})

test('force enable cannot override non-effort metadata or transport contracts', async () => {
  process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'
  const metadata = await importFreshEffortModule({
    provider: 'openai',
    supportsCodexReasoningEffort: true,
    routeId: 'custom-gateway',
    useRuntimeFallback: false,
    thirdPartyCapabilityOverrides: {
      apiProvider: 'openai',
      capabilities: { effort: true },
    },
    catalogEntries: [
      {
        id: 'metadata-no-effort',
        apiName: 'metadata-no-effort',
        capabilities: { supportsReasoning: true },
        reasoning: {
          mode: 'always-on',
          wireFormat: 'none',
        },
      },
    ],
  })

  expect(metadata.modelSupportsEffort('metadata-no-effort')).toBe(false)
  expect(metadata.modelSupportsShimReasoningEffort('metadata-no-effort')).toBe(false)
  expect(metadata.modelSupportsWireEffort('metadata-no-effort')).toBe(false)
  expect(metadata.resolveAppliedEffort('metadata-no-effort', 'high')).toBeUndefined()

  const transport = await importFreshEffortModule({
    provider: 'openai',
    supportsCodexReasoningEffort: true,
    routeId: 'custom',
    useRuntimeFallback: false,
    thirdPartyCapabilityOverrides: {
      apiProvider: 'openai',
      capabilities: { effort: true },
    },
    openaiShimConfig: { thinkingRequestFormat: 'none' },
  })

  expect(transport.modelSupportsEffort('transport-no-effort')).toBe(false)
  expect(transport.modelSupportsShimReasoningEffort('transport-no-effort')).toBe(false)
  expect(transport.modelSupportsWireEffort('transport-no-effort')).toBe(false)
  expect(transport.resolveAppliedEffort('transport-no-effort', 'high')).toBeUndefined()

  const metadataWithTransportVeto = await importFreshEffortModule({
    provider: 'openai',
    supportsCodexReasoningEffort: true,
    routeId: 'custom-gateway',
    useRuntimeFallback: false,
    thirdPartyCapabilityOverrides: {
      apiProvider: 'openai',
      capabilities: { effort: true },
    },
    openaiShimConfig: { thinkingRequestFormat: 'none' },
    catalogEntries: [
      {
        id: 'metadata-with-transport-veto',
        apiName: 'metadata-with-transport-veto',
        capabilities: { supportsReasoning: true },
        reasoning: {
          mode: 'levels',
          levels: ['low', 'medium', 'high'],
          wireFormat: 'reasoning_effort',
        },
      },
    ],
  })

  expect(
    metadataWithTransportVeto.modelSupportsEffort(
      'metadata-with-transport-veto',
    ),
  ).toBe(false)
  expect(
    metadataWithTransportVeto.modelSupportsShimReasoningEffort(
      'metadata-with-transport-veto',
    ),
  ).toBe(false)
  expect(
    metadataWithTransportVeto.modelSupportsWireEffort(
      'metadata-with-transport-veto',
    ),
  ).toBe(false)
})

test('resolver and shim effort predicate accept explicit transport vetoes', async () => {
  process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'
  const {
    modelSupportsShimReasoningEffort,
    resolveModelReasoningControlWithCompatibility,
  } = await importFreshEffortModule({
    provider: 'openai',
    supportsCodexReasoningEffort: false,
    routeId: 'custom',
    useRuntimeFallback: false,
  })

  expect(
    resolveModelReasoningControlWithCompatibility(
      'transport-no-effort',
      { thinkingRequestFormat: 'none' },
    ),
  ).toMatchObject({
    supportsReasoning: false,
    controllable: false,
    source: 'compat',
  })

  expect(
    modelSupportsShimReasoningEffort('transport-no-effort', 'none'),
  ).toBe(false)
  expect(
    modelSupportsShimReasoningEffort(
      'transport-no-effort',
      undefined,
      ['reasoning_effort'],
    ),
  ).toBe(false)
})

test('third-party false beats force enable for unresolved models', async () => {
  process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'
  const {
    modelSupportsEffort,
    modelSupportsShimReasoningEffort,
    modelSupportsWireEffort,
    resolveAppliedEffort,
  } = await importFreshEffortModule({
    provider: 'openai',
    supportsCodexReasoningEffort: false,
    routeId: 'custom',
    useRuntimeFallback: false,
    thirdPartyCapabilityOverrides: {
      apiProvider: 'openai',
      capabilities: { effort: false },
    },
  })

  expect(modelSupportsEffort('third-party-custom-model')).toBe(false)
  expect(modelSupportsShimReasoningEffort('third-party-custom-model')).toBe(false)
  expect(modelSupportsWireEffort('third-party-custom-model')).toBe(false)
  expect(resolveAppliedEffort('third-party-custom-model', 'high')).toBeUndefined()
})

test('third-party effort overrides require the matching API provider', async () => {
  const matchingProvider = await importFreshEffortModule({
    provider: 'bedrock',
    supportsCodexReasoningEffort: false,
    routeId: 'bedrock',
    useRuntimeFallback: false,
    thirdPartyCapabilityOverrides: {
      apiProvider: 'bedrock',
      capabilities: {
        effort: true,
        max_effort: true,
        xhigh_effort: false,
      },
    },
  })

  expect(
    matchingProvider.modelSupportsEffort('provider-scoped-model'),
  ).toBe(true)
  expect(
    matchingProvider.getAvailableEffortLevels('provider-scoped-model'),
  ).toEqual(['low', 'medium', 'high', 'max'])

  const xhighProvider = await importFreshEffortModule({
    provider: 'foundry',
    supportsCodexReasoningEffort: false,
    routeId: 'foundry',
    useRuntimeFallback: false,
    thirdPartyCapabilityOverrides: {
      apiProvider: 'foundry',
      capabilities: {
        effort: true,
        max_effort: false,
        xhigh_effort: true,
      },
    },
  })

  expect(
    xhighProvider.getAvailableEffortLevels('provider-scoped-model'),
  ).toEqual(['low', 'medium', 'high', 'xhigh'])

  const differentProvider = await importFreshEffortModule({
    provider: 'vertex',
    supportsCodexReasoningEffort: false,
    routeId: 'vertex',
    useRuntimeFallback: false,
    thirdPartyCapabilityOverrides: {
      apiProvider: 'bedrock',
      capabilities: {
        effort: true,
        max_effort: true,
        xhigh_effort: false,
      },
    },
  })

  expect(
    differentProvider.modelSupportsEffort('provider-scoped-model'),
  ).toBe(false)
  expect(
    differentProvider.getAvailableEffortLevels('provider-scoped-model'),
  ).toEqual([])
})

test('explicit effort metadata beats a third-party false override', async () => {
  process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'
  const {
    modelSupportsEffort,
    modelSupportsShimReasoningEffort,
    modelSupportsWireEffort,
    resolveAppliedEffort,
  } = await importFreshEffortModule({
    provider: 'openai',
    supportsCodexReasoningEffort: false,
    routeId: 'custom-gateway',
    useRuntimeFallback: false,
    thirdPartyCapabilityOverrides: {
      apiProvider: 'openai',
      capabilities: { effort: false },
    },
    catalogEntries: [
      {
        id: 'metadata-effort-model',
        apiName: 'metadata-effort-model',
        capabilities: { supportsReasoning: true },
        reasoning: {
          mode: 'levels',
          levels: ['low', 'medium', 'high'],
          wireFormat: 'reasoning_effort',
        },
      },
    ],
  })

  expect(modelSupportsEffort('metadata-effort-model')).toBe(true)
  expect(modelSupportsShimReasoningEffort('metadata-effort-model')).toBe(true)
  expect(modelSupportsWireEffort('metadata-effort-model')).toBe(true)
  expect(resolveAppliedEffort('metadata-effort-model', 'high')).toBe('high')
})

test('toggle reasoning metadata stays non-controllable until toggle serialization exists', async () => {
  const {
    getAvailableEffortLevels,
    modelSupportsEffort,
    modelSupportsWireEffort,
    resolveAppliedEffort,
    resolveModelReasoningControl,
  } = await importFreshEffortModule({
    provider: 'openai',
    supportsCodexReasoningEffort: false,
    routeId: 'custom-gateway',
    catalogEntries: [
      {
        id: 'toggle-model',
        apiName: 'toggle-model',
        capabilities: { supportsReasoning: true },
        reasoning: {
          mode: 'toggle',
          wireFormat: 'reasoning_effort',
        },
      },
    ],
  })

  expect(resolveModelReasoningControl('toggle-model')).toMatchObject({
    supportsReasoning: true,
    controllable: false,
    source: 'metadata',
    mode: 'toggle',
    wireFormat: 'reasoning_effort',
  })
  expect(modelSupportsEffort('toggle-model')).toBe(false)
  expect(modelSupportsWireEffort('toggle-model')).toBe(false)
  expect(getAvailableEffortLevels('toggle-model')).toEqual([])
  expect(resolveAppliedEffort('toggle-model', 'high')).toBeUndefined()
})

test('compat DeepSeek routes can use /effort without catalog reasoning metadata', async () => {
  const {
    getAvailableEffortLevels,
    modelSupportsEffort,
    modelSupportsWireEffort,
    resolveAppliedEffort,
    resolveModelReasoningControl,
  } = await importFreshEffortModule({
    provider: 'openai',
    supportsCodexReasoningEffort: false,
    routeId: 'atlas-cloud',
    catalogEntries: [
      {
        id: 'deepseek-ai/deepseek-v3.2',
        apiName: 'deepseek-ai/deepseek-v3.2',
        capabilities: { supportsReasoning: true },
      },
    ],
  })

  expect(resolveModelReasoningControl('deepseek-ai/deepseek-v3.2')).toMatchObject({
    supportsReasoning: true,
    controllable: true,
    source: 'compat',
    wireFormat: 'deepseek_compatible',
  })
  expect(modelSupportsEffort('deepseek-ai/deepseek-v3.2')).toBe(true)
  expect(modelSupportsWireEffort('deepseek-ai/deepseek-v3.2')).toBe(true)
  expect(getAvailableEffortLevels('deepseek-ai/deepseek-v3.2')).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
  ])
  expect(resolveAppliedEffort('deepseek-ai/deepseek-v3.2', 'xhigh')).toBe('xhigh')
})

test('compat DeepSeek routes stay non-controllable when the runtime shim strips reasoning_effort', async () => {
  const {
    getAvailableEffortLevels,
    modelSupportsEffort,
    modelSupportsWireEffort,
    resolveAppliedEffort,
    resolveModelReasoningControl,
  } = await importFreshEffortModule({
    provider: 'openai',
    supportsCodexReasoningEffort: false,
    routeId: 'groq',
    openaiShimConfig: {
      thinkingRequestFormat: 'deepseek-compatible',
      removeBodyFields: ['store', 'reasoning_effort'],
    },
  })

  expect(resolveModelReasoningControl('deepseek-r1-distill-llama-70b')).toMatchObject({
    supportsReasoning: false,
    controllable: false,
    source: 'compat',
    levels: [],
  })
  expect(modelSupportsEffort('deepseek-r1-distill-llama-70b')).toBe(false)
  expect(modelSupportsWireEffort('deepseek-r1-distill-llama-70b')).toBe(false)
  expect(getAvailableEffortLevels('deepseek-r1-distill-llama-70b')).toEqual([])
  expect(resolveAppliedEffort('deepseek-r1-distill-llama-70b', 'xhigh')).toBeUndefined()
})

test('compat Z.AI routes expose only verified levels and clamp stale values', async () => {
  const {
    getAvailableEffortLevels,
    modelSupportsEffort,
    modelSupportsWireEffort,
    resolveAppliedEffort,
    resolveModelReasoningControl,
  } = await importFreshEffortModule({
    provider: 'openai',
    supportsCodexReasoningEffort: false,
    routeId: 'zai',
  })

  expect(resolveModelReasoningControl('glm-5.2')).toMatchObject({
    controllable: true,
    source: 'compat',
    wireFormat: 'zai_compatible',
    levels: ['high', 'xhigh'],
  })
  expect(getAvailableEffortLevels('glm-5.2')).toEqual(['high', 'xhigh'])
  expect(resolveAppliedEffort('glm-5.2', 'low')).toBe('high')
  expect(resolveAppliedEffort('glm-5.2', 'xhigh')).toBe('xhigh')

  expect(resolveModelReasoningControl('GLM-5.1')).toMatchObject({
    controllable: true,
    source: 'compat',
    wireFormat: 'zai_compatible',
    levels: ['high'],
  })
  expect(modelSupportsEffort('GLM-5.1')).toBe(true)
  expect(modelSupportsWireEffort('GLM-5.1')).toBe(true)
  expect(resolveAppliedEffort('GLM-5.1', 'xhigh')).toBe('high')
})

test.each([
  'glm-5.3-flash',
  'glm-5.3',
] as const)('direct Z.AI %s resolves effort from explicit catalog metadata', async model => {
  const {
    getAvailableEffortLevels,
    resolveAppliedEffort,
    resolveModelReasoningControl,
  } = await importFreshEffortModule({
    provider: 'openai',
    supportsCodexReasoningEffort: false,
    routeId: 'zai',
  })

  expect(resolveModelReasoningControl(model)).toMatchObject({
    supportsReasoning: true,
    controllable: true,
    source: 'metadata',
    mode: 'levels',
    levels: ['low', 'high', 'xhigh'],
    defaultLevel: undefined,
    wireFormat: 'zai_compatible',
  })
  expect(getAvailableEffortLevels(model)).toEqual(['low', 'high', 'xhigh'])
  expect(resolveAppliedEffort(model, 'low')).toBe('low')
  expect(resolveAppliedEffort(model, 'xhigh')).toBe('xhigh')
})

test('provider override support context ignores ambient catalog metadata', async () => {
  const { modelSupportsShimReasoningEffort } = await importFreshEffortModule({
    provider: 'openai',
    supportsCodexReasoningEffort: true,
    routeId: 'custom-gateway',
    catalogEntries: [
      {
        id: 'gpt-5.4',
        apiName: 'gpt-5.4',
        capabilities: { supportsReasoning: true },
        reasoning: {
          mode: 'always-on',
          wireFormat: 'none',
        },
      },
    ],
  })

  expect(modelSupportsShimReasoningEffort(
    'gpt-5.4',
    undefined,
    undefined,
    { routeId: 'openai', useRuntimeFallback: false },
  )).toBe(true)
})
test('OpenAI shim reasoning request plan centralizes DeepSeek and Z.AI serialization', async () => {
  const { resolveOpenAIShimReasoningRequestPlan } = await importFreshEffortModule({
    provider: 'openai',
    supportsCodexReasoningEffort: false,
  })

  expect(resolveOpenAIShimReasoningRequestPlan({
    model: 'deepseek-v4-pro',
    requestedEffort: 'xhigh',
    requestThinkingType: 'enabled',
    thinkingRequestFormat: 'deepseek-compatible',
  })).toEqual({
    thinkingType: 'enabled',
    reasoningEffort: 'max',
    wireFormat: 'deepseek_compatible',
    source: 'compat',
  })

  expect(resolveOpenAIShimReasoningRequestPlan({
    model: 'glm-5.2',
    requestedEffort: 'xhigh',
    thinkingRequestFormat: 'zai-compatible',
  })).toEqual({
    thinkingType: 'enabled',
    reasoningEffort: 'max',
    wireFormat: 'zai_compatible',
    source: 'compat',
  })

  expect(resolveOpenAIShimReasoningRequestPlan({
    model: 'GLM-5.1',
    requestedEffort: 'high',
    thinkingRequestFormat: 'zai-compatible',
  })).toEqual({
    thinkingType: 'enabled',
    reasoningEffort: undefined,
    wireFormat: 'zai_compatible',
    source: 'compat',
  })
})

test('explicit compat metadata wire formats are controllable and feed the request planner', async () => {
  const {
    modelSupportsEffort,
    modelSupportsWireEffort,
    resolveModelReasoningControl,
    resolveOpenAIShimReasoningRequestPlan,
  } = await importFreshEffortModule({
    provider: 'openai',
    supportsCodexReasoningEffort: false,
    routeId: 'custom-gateway',
    catalogEntries: [
      {
        id: 'custom-deepseek-model',
        apiName: 'custom-deepseek-model',
        capabilities: { supportsReasoning: true },
        reasoning: {
          mode: 'levels',
          levels: ['high', 'xhigh'],
          wireFormat: 'deepseek_compatible',
        },
      },
      {
        id: 'custom-deepseek-with-max',
        apiName: 'custom-deepseek-with-max',
        capabilities: { supportsReasoning: true },
        reasoning: {
          mode: 'levels',
          levels: ['high', 'max', 'xhigh'],
          wireFormat: 'deepseek_compatible',
        },
      },
      {
        id: 'custom-zai-high-only',
        apiName: 'custom-zai-high-only',
        capabilities: { supportsReasoning: true },
        reasoning: {
          mode: 'levels',
          levels: ['high'],
          wireFormat: 'zai_compatible',
        },
      },
      {
        id: 'custom-zai-low-only',
        apiName: 'custom-zai-low-only',
        capabilities: { supportsReasoning: true },
        reasoning: {
          mode: 'levels',
          levels: ['low'],
          wireFormat: 'zai_compatible',
        },
      },
      {
        id: 'custom-deepseek-low-only',
        apiName: 'custom-deepseek-low-only',
        capabilities: { supportsReasoning: true },
        reasoning: {
          mode: 'levels',
          levels: ['low'],
          wireFormat: 'deepseek_compatible',
        },
      },
    ],
  })

  const reasoningControl = resolveModelReasoningControl('custom-deepseek-model')
  expect(reasoningControl).toMatchObject({
    supportsReasoning: true,
    controllable: true,
    source: 'metadata',
    wireFormat: 'deepseek_compatible',
  })
  expect(modelSupportsEffort('custom-deepseek-model')).toBe(true)
  expect(modelSupportsWireEffort('custom-deepseek-model')).toBe(true)
  expect(resolveOpenAIShimReasoningRequestPlan({
    model: 'custom-deepseek-model',
    requestedEffort: 'xhigh',
    requestThinkingType: 'enabled',
    reasoningControl,
  })).toEqual({
    thinkingType: 'enabled',
    reasoningEffort: 'max',
    wireFormat: 'deepseek_compatible',
    source: 'metadata',
  })

  expect(resolveModelReasoningControl('custom-deepseek-with-max')).toMatchObject({
    supportsReasoning: true,
    controllable: true,
    source: 'metadata',
    wireFormat: 'deepseek_compatible',
    levels: ['high', 'xhigh'],
  })

  const zaiReasoningControl = resolveModelReasoningControl('custom-zai-high-only')
  expect(zaiReasoningControl).toMatchObject({
    supportsReasoning: true,
    controllable: true,
    source: 'metadata',
    wireFormat: 'zai_compatible',
    levels: ['high'],
  })
  expect(modelSupportsEffort('custom-zai-high-only')).toBe(true)
  expect(modelSupportsWireEffort('custom-zai-high-only')).toBe(true)
  expect(resolveOpenAIShimReasoningRequestPlan({
    model: 'custom-zai-high-only',
    requestedEffort: 'high',
    reasoningControl: zaiReasoningControl,
  })).toEqual({
    thinkingType: 'enabled',
    reasoningEffort: 'high',
    wireFormat: 'zai_compatible',
    source: 'metadata',
  })

  const zaiLowOnlyControl = resolveModelReasoningControl('custom-zai-low-only')
  expect(zaiLowOnlyControl).toMatchObject({
    supportsReasoning: true,
    controllable: true,
    source: 'metadata',
    wireFormat: 'zai_compatible',
    levels: ['low'],
  })
  expect(modelSupportsEffort('custom-zai-low-only')).toBe(true)
  expect(modelSupportsWireEffort('custom-zai-low-only')).toBe(true)
  expect(resolveOpenAIShimReasoningRequestPlan({
    model: 'custom-zai-low-only',
    requestedEffort: 'low',
    reasoningControl: zaiLowOnlyControl,
  })).toEqual({
    thinkingType: 'enabled',
    reasoningEffort: 'low',
    wireFormat: 'zai_compatible',
    source: 'metadata',
  })
  expect(resolveOpenAIShimReasoningRequestPlan({
    model: 'custom-zai-low-only',
    requestThinkingType: 'disabled',
    reasoningControl: zaiLowOnlyControl,
  })).toEqual({
    thinkingType: 'enabled',
    reasoningEffort: 'low',
    wireFormat: 'zai_compatible',
    source: 'metadata',
  })
  expect(resolveOpenAIShimReasoningRequestPlan({
    model: 'custom-zai-low-only',
    requestedEffort: 'high',
    requestThinkingType: 'disabled',
    reasoningControl: zaiLowOnlyControl,
  })).toEqual({
    thinkingType: 'enabled',
    reasoningEffort: 'high',
    wireFormat: 'zai_compatible',
    source: 'metadata',
  })
  expect(resolveModelReasoningControl('custom-deepseek-low-only')).toMatchObject({
    supportsReasoning: true,
    controllable: false,
    source: 'metadata',
    wireFormat: 'deepseek_compatible',
    levels: [],
  })
  expect(modelSupportsEffort('custom-deepseek-low-only')).toBe(false)
  expect(modelSupportsWireEffort('custom-deepseek-low-only')).toBe(false)
})
