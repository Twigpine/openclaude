import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'

const actualProviders = { ...await import('./providers.js') }

const originalSubagentModel = process.env.CLAUDE_CODE_SUBAGENT_MODEL
const originalOpenAIModel = process.env.OPENAI_MODEL
const originalDefaultModelEnv = {
  ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
  ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES:
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES,
  ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
  ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES:
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
  ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES:
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES,
}
const allowedModelsRef: { value?: string[] } = { value: undefined }

type MockProvider =
  | 'firstParty'
  | 'bedrock'
  | 'vertex'
  | 'foundry'
  | 'openai'
  | 'gemini'
  | 'mistral'
  | 'github'
  | 'nvidia-nim'
  | 'minimax'
  | 'codex'

/** Override provider identity for resolver tests while preserving other provider exports. */
function mockProvider(
  provider: MockProvider,
  isFirstPartyAnthropicBaseUrl = false,
): void {
  mock.module('./providers.js', () => ({
    ...actualProviders,
    getAPIProvider: () => provider,
    getAPIProviderForStatsig: () => provider,
    isFirstPartyAnthropicBaseUrl: () => isFirstPartyAnthropicBaseUrl,
    isGithubNativeAnthropicMode: () => false,
    usesAnthropicAccountFlow: () => provider === 'firstParty',
  }))
}

function setAvailableModelsForTest(availableModels?: string[]): void {
  allowedModelsRef.value = availableModels
}

// Keep resolver tests independent from process-global settings mocks in other
// test files; modelAllowlist itself owns the detailed allowlist semantics.
function mockModelAllowlist(): void {
  mock.module('./modelAllowlist.js', () => ({
    isModelAllowed: (model: string) => {
      const availableModels = allowedModelsRef.value
      if (availableModels === undefined) return true
      if (availableModels.length === 0) return false

      const normalizedModel = model.trim().toLowerCase()
      return availableModels.some(
        availableModel =>
          availableModel.trim().toLowerCase() === normalizedModel,
      )
    },
  }))
}

async function importAgentModule(): Promise<typeof import('./agent.js')> {
  const stamp = `${Date.now()}-${Math.random()}`
  return import(`./agent.ts?agent-test=${stamp}`)
}

describe('getAgentModel provider-aware fallback', () => {
  beforeEach(async () => {
    await acquireSharedMutationLock('utils/model/agent.test.ts')
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
    delete process.env.OPENAI_MODEL
    for (const key of Object.keys(originalDefaultModelEnv)) {
      delete process.env[key]
    }
    setAvailableModelsForTest()
    mockModelAllowlist()
  })

  // Restore all mocks after each test
  afterEach(() => {
    try {
      mock.restore()
      setAvailableModelsForTest()
      if (originalSubagentModel === undefined) {
        delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
      } else {
        process.env.CLAUDE_CODE_SUBAGENT_MODEL = originalSubagentModel
      }
      if (originalOpenAIModel === undefined) {
        delete process.env.OPENAI_MODEL
      } else {
        process.env.OPENAI_MODEL = originalOpenAIModel
      }
      for (const [key, value] of Object.entries(originalDefaultModelEnv)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    } finally {
      releaseSharedMutationLock()
    }
  })

  describe('Claude-native providers', () => {
    test('haiku alias resolves to haiku model for official Anthropic API', async () => {
      // Mock providers to return firstParty with official URL
      mockProvider('firstParty', true)

      // Import after mock is set up
      const { getAgentModel } = await importAgentModule()
      const result = getAgentModel('haiku', 'claude-sonnet-4-6', undefined, 'default')

      // Should resolve haiku alias, not inherit parent
      expect(result).toContain('haiku')
      expect(result).not.toBe('claude-sonnet-4-6')
    })

    test('haiku alias resolves for Bedrock provider', async () => {
      mockProvider('bedrock')

      const { getAgentModel } = await importAgentModule()
      const result = getAgentModel('haiku', 'claude-sonnet-4-6', undefined, 'default')

      // Should resolve haiku alias for Bedrock
      expect(result).toContain('haiku')
    })

    test('haiku alias resolves for Vertex provider', async () => {
      mockProvider('vertex')

      const { getAgentModel } = await importAgentModule()
      const result = getAgentModel('haiku', 'claude-sonnet-4-6', undefined, 'default')

      // Should resolve haiku alias for Vertex
      expect(result).toContain('haiku')
    })

    test('haiku alias resolves for Foundry provider', async () => {
      mockProvider('foundry')

      const { getAgentModel } = await importAgentModule()
      const result = getAgentModel('haiku', 'claude-sonnet-4-6', undefined, 'default')

      // Should resolve haiku alias for Foundry
      expect(result).toContain('haiku')
    })
  })

  describe('Non-Claude-native providers', () => {
    test('haiku alias inherits parent model for OpenAI provider', async () => {
      mockProvider('openai')

      const { getAgentModel } = await importAgentModule()
      const result = getAgentModel('haiku', 'gpt-4o-mini', undefined, 'default')

      // Should inherit parent model for OpenAI (no haiku concept)
      expect(result).toBe('gpt-4o-mini')
    })

    test('haiku alias inherits parent model for Gemini provider', async () => {
      mockProvider('gemini')

      const { getAgentModel } = await importAgentModule()
      const result = getAgentModel('haiku', 'gemini-2.5-pro', undefined, 'default')

      // Should inherit parent model for Gemini
      expect(result).toBe('gemini-2.5-pro')
    })

    test('haiku alias inherits parent model for custom Anthropic-compatible URL', async () => {
      // firstParty provider but with custom URL (not official Anthropic)
      mockProvider('firstParty')

      const { getAgentModel } = await importAgentModule()
      const result = getAgentModel('haiku', 'claude-sonnet-4-6', undefined, 'default')

      // Should inherit parent for custom Anthropic-compatible URL
      expect(result).toBe('claude-sonnet-4-6')
    })

    test('sonnet alias inherits parent model for OpenAI provider', async () => {
      mockProvider('openai')

      const { getAgentModel } = await importAgentModule()
      const result = getAgentModel('sonnet', 'gpt-4o-mini', undefined, 'default')

      // Should inherit parent model for OpenAI
      expect(result).toBe('gpt-4o-mini')
    })

    test('haiku alias inherits parent model for Mistral provider', async () => {
      mockProvider('mistral')

      const { getAgentModel } = await importAgentModule()
      const result = getAgentModel('haiku', 'mistral-small-latest', undefined, 'default')

      // Should inherit parent model for Mistral (no haiku concept)
      expect(result).toBe('mistral-small-latest')
    })

    test('haiku alias inherits parent model for GitHub Copilot provider', async () => {
      mockProvider('github')

      const { getAgentModel } = await importAgentModule()
      const result = getAgentModel('haiku', 'gpt-4o-mini', undefined, 'default')

      // Should inherit parent model for GitHub Copilot
      expect(result).toBe('gpt-4o-mini')
    })

    test('haiku alias inherits parent model for NVIDIA NIM provider', async () => {
      mockProvider('nvidia-nim')

      const { getAgentModel } = await importAgentModule()
      const result = getAgentModel('haiku', 'meta/llama-3.1-8b-instruct', undefined, 'default')

      // Should inherit parent model for NVIDIA NIM (no haiku concept)
      expect(result).toBe('meta/llama-3.1-8b-instruct')
    })

    test('haiku alias inherits parent model for MiniMax provider', async () => {
      mockProvider('minimax')

      const { getAgentModel } = await importAgentModule()
      const result = getAgentModel('haiku', 'MiniMax-M2.5-highspeed', undefined, 'default')

      // Should inherit parent model for MiniMax (no haiku concept)
      expect(result).toBe('MiniMax-M2.5-highspeed')
    })

    test('haiku alias inherits parent model for Codex provider', async () => {
      mockProvider('codex')

      const { getAgentModel } = await importAgentModule()
      const result = getAgentModel('haiku', 'gpt-5.5-mini', undefined, 'default')

      // Should inherit parent model for Codex provider (no haiku concept)
      expect(result).toBe('gpt-5.5-mini')
    })
  })

  describe('inherit behavior unchanged', () => {
    test('inherit always returns parent model regardless of provider', async () => {
      mockProvider('openai')

      const { getAgentModel } = await importAgentModule()
      const result = getAgentModel('inherit', 'gpt-4o', undefined, 'default')

      expect(result).toBe('gpt-4o')
    })

    test('tool-specified inherit returns the runtime parent model', async () => {
      mockProvider('openai')

      const { getAgentModel } = await importAgentModule()
      const result = getAgentModel(undefined, 'gpt-4o', 'inherit', 'default')

      expect(result).toBe('gpt-4o')
    })

    test('tool-specified inherit is case-insensitive and trimmed', async () => {
      mockProvider('openai')

      const { getAgentModel } = await importAgentModule()
      const result = getAgentModel(undefined, 'gpt-4o', ' InHerit ', 'default')

      expect(result).toBe('gpt-4o')
    })
  })

  describe('tool-specified model override', () => {
    test('preserves custom provider model IDs unchanged', async () => {
      mockProvider('openai')

      const { getAgentModel } = await importAgentModule()
      const customModels = [
        'gpt-5.5',
        'mimo-v2.5-pro',
        'deepseek-v4-flash',
        'deepseek/deepseek-v4-flash:nitro',
        'qwen3-coder-next:cloud',
        'custom_model-v1.2:fast',
      ]

      for (const customModel of customModels) {
        expect(
          getAgentModel(undefined, 'claude-sonnet-4-6', customModel, 'default'),
        ).toBe(customModel)
      }
    })

    test('trims custom provider model IDs before resolving', async () => {
      mockProvider('openai')

      const { getAgentModel } = await importAgentModule()
      const result = getAgentModel(
        undefined,
        'claude-sonnet-4-6',
        '  qwen3-coder-next:cloud  ',
        'default',
      )

      expect(result).toBe('qwen3-coder-next:cloud')
    })

    test('preserves alias tier matching for tool-specified aliases', async () => {
      mockProvider('firstParty', true)

      const { getAgentModel } = await importAgentModule()

      expect(
        getAgentModel(undefined, 'claude-sonnet-4-6', 'sonnet', 'default'),
      ).toBe('claude-sonnet-4-6')
      expect(
        getAgentModel(undefined, 'claude-opus-4-6', 'opus', 'default'),
      ).toBe('claude-opus-4-6')
      expect(
        getAgentModel(
          undefined,
          'claude-3-5-haiku-20241022',
          'haiku',
          'default',
        ),
      ).toBe('claude-3-5-haiku-20241022')
    })

    test('keeps existing direct alias parsing for non-Claude providers', async () => {
      mockProvider('openai')
      delete process.env.OPENAI_MODEL

      const { getAgentModel } = await importAgentModule()
      const result = getAgentModel(undefined, 'gpt-4o', 'haiku', 'default')

      expect(result).toBe('gpt-4o-mini')
    })

    test('CLAUDE_CODE_SUBAGENT_MODEL overrides tool-specified custom model', async () => {
      mockProvider('openai')
      process.env.CLAUDE_CODE_SUBAGENT_MODEL =
        'deepseek/deepseek-v4-flash:nitro'

      const { getAgentModel } = await importAgentModule()
      const result = getAgentModel(
        'haiku',
        'claude-sonnet-4-6',
        'gpt-5.5',
        'default',
      )

      expect(result).toBe('deepseek/deepseek-v4-flash:nitro')
    })

    test('rejects tool-specified custom model IDs outside availableModels', async () => {
      mockProvider('openai')
      setAvailableModelsForTest(['gpt-4o'])

      const { getAgentModel } = await importAgentModule()

      expect(() =>
        getAgentModel(undefined, 'gpt-4o', 'gpt-5.5', 'default'),
      ).toThrow(
        "Model 'gpt-5.5' is not available. Your organization restricts model selection.",
      )
    })

    test('allows tool-specified custom model IDs inside availableModels', async () => {
      mockProvider('openai')
      setAvailableModelsForTest(['gpt-5.5'])

      const { getAgentModel } = await importAgentModule()
      const result = getAgentModel(undefined, 'gpt-4o', 'gpt-5.5', 'default')

      expect(result).toBe('gpt-5.5')
    })

    test('allows tool-specified aliases when the alias is in availableModels', async () => {
      mockProvider('openai')
      delete process.env.OPENAI_MODEL
      setAvailableModelsForTest(['haiku'])

      const { getAgentModel } = await importAgentModule()
      const result = getAgentModel(undefined, 'gpt-4o', 'haiku', 'default')

      expect(result).toBe('gpt-4o-mini')
    })

    test('does not let tier-matching aliases bypass availableModels', async () => {
      mockProvider('firstParty', true)
      setAvailableModelsForTest(['claude-3-5-haiku-20241022'])

      const { getAgentModel } = await importAgentModule()

      expect(() =>
        getAgentModel(
          undefined,
          'claude-sonnet-4-6',
          'sonnet',
          'default',
        ),
      ).toThrow(
        "Model 'sonnet' is not available. Your organization restricts model selection.",
      )
    })

    test('keeps tier-matching aliases when the effective parent model is allowed', async () => {
      mockProvider('firstParty', true)
      setAvailableModelsForTest(['claude-sonnet-4-6'])

      const { getAgentModel } = await importAgentModule()
      const result = getAgentModel(
        undefined,
        'claude-sonnet-4-6',
        'sonnet',
        'default',
      )

      expect(result).toBe('claude-sonnet-4-6')
    })

    test('keeps tool-specified inherit independent of availableModels', async () => {
      mockProvider('openai')
      setAvailableModelsForTest([])

      const { getAgentModel } = await importAgentModule()
      const result = getAgentModel(undefined, 'gpt-4o', 'inherit', 'default')

      expect(result).toBe('gpt-4o')
    })

    test('inherits Bedrock parent region prefix for non-prefixed Bedrock model IDs', async () => {
      mockProvider('bedrock')

      const { getAgentModel } = await importAgentModule()
      const result = getAgentModel(
        undefined,
        'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
        'anthropic.claude-3-5-sonnet-20241022-v2:0',
        'default',
      )

      expect(result).toBe('eu.anthropic.claude-3-5-sonnet-20241022-v2:0')
    })

    test('allows inherited Bedrock region prefixes when the requested model ID is allowed', async () => {
      mockProvider('bedrock')
      setAvailableModelsForTest(['anthropic.claude-3-5-sonnet-20241022-v2:0'])

      const { getAgentModel } = await importAgentModule()
      const result = getAgentModel(
        undefined,
        'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
        'anthropic.claude-3-5-sonnet-20241022-v2:0',
        'default',
      )

      expect(result).toBe('eu.anthropic.claude-3-5-sonnet-20241022-v2:0')
    })

    test('preserves explicit Bedrock region prefix on tool-specified model IDs', async () => {
      mockProvider('bedrock')

      const { getAgentModel } = await importAgentModule()
      const result = getAgentModel(
        undefined,
        'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
        'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
        'default',
      )

      expect(result).toBe('us.anthropic.claude-3-5-sonnet-20241022-v2:0')
    })

    test('does not apply Bedrock region prefixes to non-Bedrock custom IDs', async () => {
      mockProvider('bedrock')

      const { getAgentModel } = await importAgentModule()
      const result = getAgentModel(
        undefined,
        'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
        'deepseek/deepseek-v4-flash:nitro',
        'default',
      )

      expect(result).toBe('deepseek/deepseek-v4-flash:nitro')
    })
  })

  describe('checkIsClaudeNativeProvider helper', () => {
    test('returns true for official Anthropic API', async () => {
      mockProvider('firstParty', true)

      const { checkIsClaudeNativeProvider } = await importAgentModule()
      expect(checkIsClaudeNativeProvider()).toBe(true)
    })

    test('returns true for Bedrock provider', async () => {
      mockProvider('bedrock')

      const { checkIsClaudeNativeProvider } = await importAgentModule()
      expect(checkIsClaudeNativeProvider()).toBe(true)
    })

    test('returns true for Vertex provider', async () => {
      mockProvider('vertex')

      const { checkIsClaudeNativeProvider } = await importAgentModule()
      expect(checkIsClaudeNativeProvider()).toBe(true)
    })

    test('returns true for Foundry provider', async () => {
      mockProvider('foundry')

      const { checkIsClaudeNativeProvider } = await importAgentModule()
      expect(checkIsClaudeNativeProvider()).toBe(true)
    })

    test('returns false for OpenAI provider', async () => {
      mockProvider('openai')

      const { checkIsClaudeNativeProvider } = await importAgentModule()
      expect(checkIsClaudeNativeProvider()).toBe(false)
    })

    test('returns false for custom Anthropic URL', async () => {
      mockProvider('firstParty')

      const { checkIsClaudeNativeProvider } = await importAgentModule()
      expect(checkIsClaudeNativeProvider()).toBe(false)
    })
  })
})

describe('getAgentModelOptions', () => {
  beforeEach(async () => {
    await acquireSharedMutationLock('utils/model/agent.test.ts')
  })

  afterEach(() => {
    releaseSharedMutationLock()
  })

  test('returns default options when settings are missing', async () => {
    const { getAgentModelOptions } = await importAgentModule()
    const options = getAgentModelOptions(null)
    expect(options.length).toBe(4)
    expect(options.map(o => o.value)).toEqual(['sonnet', 'opus', 'haiku', 'inherit'])
  })

  test('appends configured models from settings', async () => {
    const { getAgentModelOptions } = await importAgentModule()
    const options = getAgentModelOptions({
      agentModels: {
        'deepseek-chat': { base_url: 'https://api.deepseek.com/v1', api_key: 'sk-ds' },
        'gpt-4o': { base_url: 'https://api.openai.com/v1', api_key: 'sk-oai' },
      },
    } as any)

    expect(options.length).toBe(6)
    expect(options[4]?.value).toBe('deepseek-chat')
    expect(options[5]?.value).toBe('gpt-4o')
    expect(options[4]?.label).toBe('deepseek-chat')
    expect(options[5]?.description).toBe('Configured agent model')
  })

  test('deduplicates keys if configured models match built-in aliases', async () => {
    const { getAgentModelOptions } = await importAgentModule()
    const options = getAgentModelOptions({
      agentModels: {
        'sonnet': { base_url: 'https://api.custom.com/v1', api_key: 'sk-123' },
        'deepseek-chat': { base_url: 'https://api.deepseek.com/v1', api_key: 'sk-ds' },
      },
    } as any)

    expect(options.length).toBe(5)
    // 'sonnet' should not be duplicated
    expect(options.filter(o => o.value === 'sonnet').length).toBe(1)
    expect(options[4]?.value).toBe('deepseek-chat')
  })

  test('does not expose configured provider credentials in labels', async () => {
    const { getAgentModelOptions } = await importAgentModule()
    const options = getAgentModelOptions({
      agentModels: {
        'deepseek-chat': {
          base_url: 'https://api.deepseek.com/v1',
          api_key: 'sk-secret-test-key',
        },
      },
    } as any)

    const displayText = options
      .map(option => `${option.label} ${option.description}`)
      .join('\n')

    expect(displayText).not.toContain('sk-secret-test-key')
    expect(displayText).not.toContain('https://api.deepseek.com/v1')
  })
})
