import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  applyAgentProviderOverrideToEnv,
  isProviderOverride,
  resolveAgentModelProvider,
  resolveAgentProvider,
  resolveAgentRunModelRouting,
  resolveOutOfProcessTeammateModelOnly,
  resolveOutOfProcessTeammateProvider,
  resolveOutOfProcessTeammateProviderFromCliArgs,
  shouldEnforceModelAllowlist,
} from './agentRouting.js'
import { getAgentModel } from '../../utils/model/agent.js'
import * as agentModelModule from '../../utils/model/agent.js'
import type { SettingsJson } from '../../utils/settings/types.js'

const baseSettings = {
  agentModels: {
    'deepseek-chat': { base_url: 'https://api.deepseek.com/v1', api_key: 'sk-ds' },
    'gpt-4o': { base_url: 'https://api.openai.com/v1', api_key: 'sk-oai' },
  },
  agentRouting: {
    Explore: 'deepseek-chat',
    'general-purpose': 'gpt-4o',
    'frontend-dev': 'deepseek-chat',
    default: 'gpt-4o',
  },
} as unknown as SettingsJson

describe('resolveAgentProvider', () => {
  let errorSpy: ReturnType<typeof spyOn>
  beforeEach(() => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    errorSpy.mockRestore()
  })

  // ── Priority chain ──────────────────────────────────────────

  test('name takes priority over subagentType', () => {
    const result = resolveAgentProvider('frontend-dev', 'Explore', baseSettings)
    expect(result).toEqual({
      model: 'deepseek-chat',
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'sk-ds',
    })
  })

  test('subagentType used when name has no match', () => {
    const result = resolveAgentProvider('unknown-name', 'Explore', baseSettings)
    expect(result).toEqual({
      model: 'deepseek-chat',
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'sk-ds',
    })
  })

  test('falls back to "default" when neither name nor subagentType match', () => {
    const result = resolveAgentProvider('nobody', 'unknown-type', baseSettings)
    expect(result).toEqual({
      model: 'gpt-4o',
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-oai',
    })
  })

  test('returns null when no routing match and no default', () => {
    const settings = {
      agentModels: baseSettings.agentModels,
      agentRouting: { Explore: 'deepseek-chat' },
    } as unknown as SettingsJson
    const result = resolveAgentProvider('nobody', 'unknown-type', settings)
    expect(result).toBeNull()
  })

  test('returns null when name and subagentType are both undefined', () => {
    const settings = {
      agentModels: baseSettings.agentModels,
      agentRouting: { Explore: 'deepseek-chat' },
    } as unknown as SettingsJson
    const result = resolveAgentProvider(undefined, undefined, settings)
    expect(result).toBeNull()
  })

  // ── normalize() matching ────────────────────────────────────

  test('matching is case-insensitive', () => {
    const result = resolveAgentProvider(undefined, 'explore', baseSettings)
    expect(result?.model).toBe('deepseek-chat')
  })

  test('matching is case-insensitive (UPPER)', () => {
    const result = resolveAgentProvider(undefined, 'EXPLORE', baseSettings)
    expect(result?.model).toBe('deepseek-chat')
  })

  test('hyphen and underscore are equivalent', () => {
    const result = resolveAgentProvider(undefined, 'general_purpose', baseSettings)
    expect(result?.model).toBe('gpt-4o')
  })

  test('underscore in config matches hyphen in input', () => {
    const settings = {
      agentModels: baseSettings.agentModels,
      agentRouting: { general_purpose: 'deepseek-chat' },
    } as unknown as SettingsJson
    const result = resolveAgentProvider(undefined, 'general-purpose', settings)
    expect(result?.model).toBe('deepseek-chat')
  })

  // ── Edge cases ──────────────────────────────────────────────

  test('returns null when settings is null', () => {
    expect(resolveAgentProvider('Explore', 'Explore', null)).toBeNull()
  })

  test('returns null when agentRouting is missing', () => {
    const settings = { agentModels: baseSettings.agentModels } as unknown as SettingsJson
    expect(resolveAgentProvider(undefined, 'Explore', settings)).toBeNull()
  })

  test('returns null when agentModels is missing', () => {
    const settings = { agentRouting: baseSettings.agentRouting } as unknown as SettingsJson
    expect(resolveAgentProvider(undefined, 'Explore', settings)).toBeNull()
  })

  test('returns null when routing references non-existent model', () => {
    const settings = {
      agentModels: {},
      agentRouting: { Explore: 'non-existent-model' },
    } as unknown as SettingsJson
    expect(resolveAgentProvider(undefined, 'Explore', settings)).toBeNull()
  })

  test('subagentType only (no name)', () => {
    const result = resolveAgentProvider(undefined, 'Explore', baseSettings)
    expect(result?.model).toBe('deepseek-chat')
  })

  test('name only (no subagentType)', () => {
    const result = resolveAgentProvider('frontend-dev', undefined, baseSettings)
    expect(result?.model).toBe('deepseek-chat')
  })

  test('configured model key can alias a different API model name', () => {
    const settings = {
      agentModels: {
        zai: {
          model: 'glm-5.1',
          base_url: 'https://api.z.ai/api/coding/paas/v4',
          api_key: 'sk-zai',
        },
      },
      agentRouting: { default: 'zai' },
    } as unknown as SettingsJson

    const result = resolveAgentProvider(undefined, undefined, settings)

    expect(result).toEqual({
      model: 'glm-5.1',
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
      apiKey: 'sk-zai',
    })
  })

  test('blank API keys do not create provider overrides', () => {
    const settings = {
      agentModels: {
        zai: {
          model: 'glm-5.1',
          base_url: 'https://api.z.ai/api/coding/paas/v4',
          api_key: '',
        },
      },
      agentRouting: { default: 'zai' },
    } as unknown as SettingsJson

    expect(resolveAgentProvider(undefined, undefined, settings)).toBeNull()
    expect(errorSpy).toHaveBeenCalledWith(
      '[agentRouting] Warning: agentModels entry "zai" has only one of base_url/api_key; both are required for cross-provider routing. Skipping this route.',
    )
  })

})

const modelOnlySettings = {
  agentModels: {
    mini: { model: 'gpt-5-mini' },
    bare: {},
    'half-entry': { base_url: 'https://api.example.com/v1' }, // missing api_key
  },
  agentRouting: {
    verification: 'mini',
    Explore: 'bare',
    Plan: 'half-entry',
  },
} as unknown as SettingsJson

describe('model-only routes', () => {
  let errorSpy: ReturnType<typeof spyOn>
  beforeEach(() => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    errorSpy.mockRestore()
  })

  test('resolveAgentProvider returns a model-only route (no credentials)', () => {
    const route = resolveAgentProvider(undefined, 'verification', modelOnlySettings)
    expect(route).toEqual({ model: 'gpt-5-mini' })
    expect(isProviderOverride(route!)).toBe(false)
  })

  test('bare entry defaults the model to the route key', () => {
    const route = resolveAgentProvider(undefined, 'Explore', modelOnlySettings)
    expect(route).toEqual({ model: 'bare' })
  })

  test('partial entry (only base_url) is skipped', () => {
    const route = resolveAgentProvider(undefined, 'Plan', modelOnlySettings)
    expect(route).toBeNull()
    expect(errorSpy).toHaveBeenCalledWith(
      '[agentRouting] Warning: agentModels entry "half-entry" has only one of base_url/api_key; both are required for cross-provider routing. Skipping this route.',
    )
  })

  test('resolveAgentRunModelRouting: model-only sets mainLoopModel, no providerOverride', () => {
    const result = resolveAgentRunModelRouting({
      resolvedAgentModel: 'parent-model',
      parentModel: 'parent-model',
      subagentType: 'verification',
      settings: modelOnlySettings,
    })
    expect(result).toEqual({ mainLoopModel: 'gpt-5-mini' })
    expect('providerOverride' in result).toBe(false)
  })

  test('resolveAgentRunModelRouting: no route falls back to resolvedAgentModel', () => {
    const result = resolveAgentRunModelRouting({
      resolvedAgentModel: 'parent-model',
      parentModel: 'parent-model',
      subagentType: 'unconfigured',
      settings: modelOnlySettings,
    })
    expect(result).toEqual({ mainLoopModel: 'parent-model' })
  })
})

describe('resolveAgentModelProvider', () => {
  test('returns null when settings is null', () => {
    expect(resolveAgentModelProvider('deepseek-chat', null)).toBeNull()
  })

  test('returns null when agentModels is missing', () => {
    const settings = { agentRouting: baseSettings.agentRouting } as unknown as SettingsJson
    expect(resolveAgentModelProvider('deepseek-chat', settings)).toBeNull()
  })

  test('exact match returns provider override', () => {
    const result = resolveAgentModelProvider('deepseek-chat', baseSettings)
    expect(result).toEqual({
      model: 'deepseek-chat',
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'sk-ds',
    })
  })

  test('trims whitespace around requested model', () => {
    const result = resolveAgentModelProvider('  deepseek-chat  ', baseSettings)
    expect(result?.model).toBe('deepseek-chat')
  })

  test('exact match can resolve to a different API model name', () => {
    const settings = {
      agentModels: {
        zai: {
          model: 'glm-5.1',
          base_url: 'https://api.z.ai/api/coding/paas/v4',
          api_key: 'sk-zai',
        },
      },
    } as unknown as SettingsJson

    expect(resolveAgentModelProvider('zai', settings)).toEqual({
      model: 'glm-5.1',
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
      apiKey: 'sk-zai',
    })
  })

  test('no fuzzy matching', () => {
    expect(resolveAgentModelProvider('deepseek_chat', baseSettings)).toBeNull()
    expect(resolveAgentModelProvider('DEEPSEEK-CHAT', baseSettings)).toBeNull()
  })
})

describe('resolveAgentRunModelRouting', () => {
  let errorSpy: ReturnType<typeof spyOn>
  beforeEach(() => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    errorSpy.mockRestore()
  })

  test('explicit configured model wins over agentRouting', () => {
    const result = resolveAgentRunModelRouting({
      resolvedAgentModel: 'parent-model',
      parentModel: 'parent-model',
      toolSpecifiedModel: 'deepseek-chat',
      agentName: 'frontend-dev',
      subagentType: 'Explore',
      settings: baseSettings,
    })

    expect(result).toEqual({
      mainLoopModel: 'deepseek-chat',
      providerOverride: {
        model: 'deepseek-chat',
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: 'sk-ds',
      },
    })
  })

  test('explicit non-configured model keeps resolved model behavior', () => {
    const result = resolveAgentRunModelRouting({
      resolvedAgentModel: 'haiku-model',
      parentModel: 'parent-model',
      toolSpecifiedModel: 'haiku',
      agentName: 'frontend-dev',
      subagentType: 'Explore',
      settings: baseSettings,
    })

    expect(result).toEqual({ mainLoopModel: 'haiku-model' })
  })

  test('explicit inherit keeps resolved parent model despite default routing', () => {
    const result = resolveAgentRunModelRouting({
      resolvedAgentModel: 'parent-runtime-model',
      parentModel: 'parent-model',
      toolSpecifiedModel: ' InHerit ',
      subagentType: 'unknown-type',
      settings: baseSettings,
    })

    expect(result).toEqual({ mainLoopModel: 'parent-runtime-model' })
  })

  test('agent definition model key is used after routing misses', () => {
    const result = resolveAgentRunModelRouting({
      resolvedAgentModel: 'default-model',
      parentModel: 'parent-model',
      subagentType: 'unknown-type',
      agentDefinitionModel: 'deepseek-chat',
      settings: {
        agentModels: baseSettings.agentModels,
        agentRouting: {},
      } as unknown as SettingsJson,
    })

    expect(result.mainLoopModel).toBe('deepseek-chat')
    expect(result.providerOverride?.apiKey).toBe('sk-ds')
  })

  test('falls back to resolved model when no provider override matches', () => {
    const result = resolveAgentRunModelRouting({
      resolvedAgentModel: 'default-model',
      parentModel: 'parent-model',
      toolSpecifiedModel: 'haiku',
      subagentType: 'unknown-type',
      agentDefinitionModel: 'sonnet',
      settings: {
        agentModels: baseSettings.agentModels,
        agentRouting: {},
      } as unknown as SettingsJson,
    })

    expect(result).toEqual({ mainLoopModel: 'default-model' })
  })

  test('falls back to resolved model when routed provider has a blank API key', () => {
    const result = resolveAgentRunModelRouting({
      resolvedAgentModel: 'parent-runtime-model',
      parentModel: 'parent-model',
      subagentType: 'Explore',
      settings: {
        agentModels: {
          zai: {
            model: 'glm-5.1',
            base_url: 'https://api.z.ai/api/coding/paas/v4',
            api_key: '   ',
          },
        },
        agentRouting: { Explore: 'zai' },
      } as unknown as SettingsJson,
    })

    expect(result).toEqual({ mainLoopModel: 'parent-runtime-model' })
    expect(errorSpy).toHaveBeenCalledWith(
      '[agentRouting] Warning: agentModels entry "zai" has only one of base_url/api_key; both are required for cross-provider routing. Skipping this route.',
    )
  })

  test('model-only built-in alias route resolves through getAgentModel, not literally', () => {
    // A picker route like { sonnet: { model: 'sonnet' } } must not send the
    // literal alias as mainLoopModel — it has to go through the same
    // provider-aware path as the agent model selector, so e.g. on a non-Claude
    // provider it inherits the parent instead of 404ing. We assert parity with
    // getAgentModel rather than a fixed string so the test holds across the
    // provider env the suite happens to run under.
    const settings = {
      agentModels: { sonnet: { model: 'sonnet' } },
      agentRouting: { verification: 'sonnet' },
    } as unknown as SettingsJson
    const result = resolveAgentRunModelRouting({
      resolvedAgentModel: 'should-not-be-used',
      parentModel: 'claude-sonnet-4-5',
      subagentType: 'verification',
      settings,
    })
    expect('providerOverride' in result).toBe(false)
    expect(result.mainLoopModel).toBe(
      getAgentModel('sonnet', 'claude-sonnet-4-5', undefined, undefined),
    )
    // And it is NOT the bare alias that the old code would have sent.
    expect(result.mainLoopModel).not.toBe('sonnet')
  })

  test('model-only real model id passes through unchanged', () => {
    const settings = {
      agentModels: { 'gpt-5-mini': { model: 'gpt-5-mini' } },
      agentRouting: { verification: 'gpt-5-mini' },
    } as unknown as SettingsJson
    const result = resolveAgentRunModelRouting({
      resolvedAgentModel: 'parent-model',
      parentModel: 'parent-model',
      subagentType: 'verification',
      settings,
    })
    expect(result).toEqual({ mainLoopModel: 'gpt-5-mini' })
  })

  test('permissionMode is threaded into alias resolution, not dropped', () => {
    // The plan-mode-sensitive paths in getAgentModel (inherit, opusplan, haiku)
    // all key off global model state, so a value comparison cannot prove the mode
    // reached getAgentModel. Spy on the resolver dependency and assert the exact
    // permissionMode is forwarded as the 4th arg, locking the contract threaded
    // through AgentTool/runAgent/resolveModelOnlyModel.
    const spy = spyOn(agentModelModule, 'getAgentModel').mockReturnValue(
      'effective-from-getAgentModel',
    )
    try {
      const settings = {
        agentModels: { sonnet: { model: 'sonnet' } },
        agentRouting: { verification: 'sonnet' },
      } as unknown as SettingsJson
      const result = resolveAgentRunModelRouting({
        resolvedAgentModel: 'should-not-be-used',
        parentModel: 'claude-sonnet-4-5',
        subagentType: 'verification',
        settings,
        permissionMode: 'plan',
      })
      expect(result.mainLoopModel).toBe('effective-from-getAgentModel')
      expect(spy).toHaveBeenCalledWith(
        'sonnet',
        'claude-sonnet-4-5',
        undefined,
        'plan',
      )
    } finally {
      spy.mockRestore()
    }
  })
})

describe('resolveOutOfProcessTeammateProvider', () => {
  test('explicit configured teammate model wins over routing', () => {
    const result = resolveOutOfProcessTeammateProvider({
      cliModel: 'deepseek-chat',
      agentName: 'frontend-dev',
      agentType: 'general-purpose',
      settings: baseSettings,
    })

    expect(result).toEqual({
      model: 'deepseek-chat',
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'sk-ds',
    })
  })

  test('explicit non-configured teammate model does not fall through to routing', () => {
    const result = resolveOutOfProcessTeammateProvider({
      cliModel: 'custom-model-id',
      agentName: 'frontend-dev',
      agentType: 'Explore',
      settings: baseSettings,
    })

    expect(result).toBeNull()
  })

  test('uses teammate name, agent type, then default routing when no model flag was provided', () => {
    expect(
      resolveOutOfProcessTeammateProvider({
        agentName: 'frontend-dev',
        agentType: 'general-purpose',
        settings: baseSettings,
      })?.model,
    ).toBe('deepseek-chat')

    expect(
      resolveOutOfProcessTeammateProvider({
        agentName: 'unknown-name',
        agentType: 'general-purpose',
        settings: baseSettings,
      })?.model,
    ).toBe('gpt-4o')

    expect(
      resolveOutOfProcessTeammateProvider({
        agentName: 'unknown-name',
        agentType: 'unknown-type',
        settings: baseSettings,
      })?.model,
    ).toBe('gpt-4o')
  })

  test('falls back to agent definition model key after routing misses', () => {
    const result = resolveOutOfProcessTeammateProvider({
      agentName: 'unknown-name',
      agentType: 'unknown-type',
      agentDefinitionModel: 'deepseek-chat',
      settings: {
        agentModels: baseSettings.agentModels,
        agentRouting: {},
      } as unknown as SettingsJson,
    })

    expect(result?.model).toBe('deepseek-chat')
  })
})

describe('resolveOutOfProcessTeammateModelOnly', () => {
  const modelOnlySettings = {
    agentModels: {
      'gpt-5-mini': { model: 'gpt-5-mini' },
      'deepseek-chat': { base_url: 'https://api.deepseek.com/v1', api_key: 'sk-ds' },
    },
    agentRouting: {
      verification: 'gpt-5-mini',
      'frontend-dev': 'deepseek-chat',
    },
  } as unknown as SettingsJson

  test('returns the model-only route model for a routed teammate type', () => {
    expect(
      resolveOutOfProcessTeammateModelOnly({
        agentType: 'verification',
        parentModel: 'claude-sonnet-4-5',
        settings: modelOnlySettings,
      }),
    ).toBe('gpt-5-mini')
  })

  test('returns undefined when the route is cross-provider (handled by the provider resolver)', () => {
    expect(
      resolveOutOfProcessTeammateModelOnly({
        agentType: 'frontend-dev',
        parentModel: 'claude-sonnet-4-5',
        settings: modelOnlySettings,
      }),
    ).toBeUndefined()
  })

  test('returns undefined when there is no route', () => {
    expect(
      resolveOutOfProcessTeammateModelOnly({
        agentType: 'unrouted-type',
        parentModel: 'claude-sonnet-4-5',
        settings: modelOnlySettings,
      }),
    ).toBeUndefined()
  })

  test('built-in alias route resolves through getAgentModel, not literally', () => {
    const aliasSettings = {
      agentModels: { sonnet: { model: 'sonnet' } },
      agentRouting: { verification: 'sonnet' },
    } as unknown as SettingsJson
    const result = resolveOutOfProcessTeammateModelOnly({
      agentType: 'verification',
      parentModel: 'claude-sonnet-4-5',
      settings: aliasSettings,
    })
    expect(result).toBe(
      getAgentModel('sonnet', 'claude-sonnet-4-5', undefined, undefined),
    )
    expect(result).not.toBe('sonnet')
  })

  test('an explicit configured cli model takes precedence and is not treated as model-only when cross-provider', () => {
    expect(
      resolveOutOfProcessTeammateModelOnly({
        cliModel: 'deepseek-chat',
        agentType: 'verification',
        parentModel: 'claude-sonnet-4-5',
        settings: modelOnlySettings,
      }),
    ).toBeUndefined()
  })
})

describe('resolveOutOfProcessTeammateProviderFromCliArgs', () => {
  test('routes split-pane teammate args with a configured model flag', () => {
    const result = resolveOutOfProcessTeammateProviderFromCliArgs(
      [
        '--agent-name',
        'worker-a',
        '--team-name',
        'review-team',
        '--model',
        'deepseek-chat',
      ],
      baseSettings,
    )

    expect(result?.model).toBe('deepseek-chat')
    expect(result?.baseURL).toBe('https://api.deepseek.com/v1')
  })

  test('supports equals-form CLI flags and agent type routing', () => {
    const result = resolveOutOfProcessTeammateProviderFromCliArgs(
      [
        '--agent-name=worker-a',
        '--team-name=review-team',
        '--agent-type=general-purpose',
      ],
      baseSettings,
    )

    expect(result?.model).toBe('gpt-4o')
  })

  test.each([
    [
      ['--model', 'deepseek-chat', '--model', 'gpt-4o'],
      'gpt-4o',
    ],
    [
      ['--model=deepseek-chat', '--model', 'gpt-4o'],
      'gpt-4o',
    ],
    [
      ['--model', 'gpt-4o', '--', '--model', 'deepseek-chat'],
      'gpt-4o',
    ],
    [
      [
        '--model',
        'deepseek-chat',
        'aimlapi',
        'topup',
        '--model',
        'gpt-4o',
      ],
      'deepseek-chat',
    ],
  ])('routes the effective CLI model from %j', (modelArgs, expectedModel) => {
    const result = resolveOutOfProcessTeammateProviderFromCliArgs(
      [
        '--agent-name',
        'worker-a',
        '--team-name',
        'review-team',
        ...modelArgs,
      ],
      baseSettings,
    )

    expect(result?.model).toBe(expectedModel)
  })

  test('does not route non-teammate CLI processes', () => {
    expect(
      resolveOutOfProcessTeammateProviderFromCliArgs(
        ['--model', 'deepseek-chat'],
        baseSettings,
      ),
    ).toBeNull()
    expect(
      resolveOutOfProcessTeammateProviderFromCliArgs(
        ['--agent-name', 'worker-a', '--model', 'deepseek-chat'],
        baseSettings,
      ),
    ).toBeNull()
  })

  test('does not override explicit provider selection in either CLI flag form', () => {
    expect(
      resolveOutOfProcessTeammateProviderFromCliArgs(
        [
          '--provider',
          'openai',
          '--agent-name',
          'worker-a',
          '--team-name',
          'review-team',
          '--model',
          'deepseek-chat',
        ],
        baseSettings,
      ),
    ).toBeNull()

    expect(
      resolveOutOfProcessTeammateProviderFromCliArgs(
        [
          '--provider=openai',
          '--agent-name=worker-a',
          '--team-name=review-team',
          '--model=deepseek-chat',
        ],
        baseSettings,
      ),
    ).toBeNull()
  })
})

describe('applyAgentProviderOverrideToEnv', () => {
  test('switches a spawned teammate process to OpenAI-compatible routing', () => {
    const env: Record<string, string | undefined> = {
      CLAUDE_CODE_USE_GEMINI: '1',
      CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED: '1',
      CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID: 'saved-gemini',
      GEMINI_MODEL: 'gemini-parent',
      GEMINI_API_KEY: 'gemini-key',
      ANTHROPIC_MODEL: 'claude-parent',
      ANTHROPIC_API_KEY: 'anthropic-key',
      OPENAI_API_BASE: 'https://old.example/v1',
      OPENAI_AZURE_STYLE: '1',
      OPENAI_AUTH_HEADER: 'X-Old-Key',
    }

    applyAgentProviderOverrideToEnv(
      {
        model: 'deepseek-chat',
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: 'sk-ds',
      },
      env,
    )

    expect(env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(env.OPENAI_MODEL).toBe('deepseek-chat')
    expect(env.OPENAI_BASE_URL).toBe('https://api.deepseek.com/v1')
    expect(env.OPENAI_API_KEY).toBe('sk-ds')
    expect(env.CLAUDE_CODE_USE_GEMINI).toBeUndefined()
    expect(env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED).toBeUndefined()
    expect(env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID).toBeUndefined()
    expect(env.GEMINI_MODEL).toBeUndefined()
    expect(env.ANTHROPIC_MODEL).toBeUndefined()
    expect(env.OPENAI_API_BASE).toBeUndefined()
    expect(env.OPENAI_AZURE_STYLE).toBeUndefined()
    expect(env.OPENAI_AUTH_HEADER).toBeUndefined()
    expect(env.GEMINI_API_KEY).toBe('gemini-key')
    expect(env.ANTHROPIC_API_KEY).toBe('anthropic-key')
  })

  test('materializes a Command Code override with its configured dedicated key', () => {
    const env: Record<string, string | undefined> = {
      CMD_API_KEY: 'stale-parent-key',
      COMMANDCODE_API_KEY: 'stale-fallback-key',
      COMMAND_CODE_API_KEY: 'stale-official-key',
    }

    applyAgentProviderOverrideToEnv(
      {
        model: 'deepseek/deepseek-v4-flash',
        baseURL: 'https://api.commandcode.ai/provider/v1',
        apiKey: 'configured-agent-key',
      },
      env,
    )

    expect(env.OPENAI_API_KEY).toBe('configured-agent-key')
    expect(env.CMD_API_KEY).toBe('configured-agent-key')
    expect(env.COMMANDCODE_API_KEY).toBeUndefined()
    expect(env.COMMAND_CODE_API_KEY).toBeUndefined()
  })

  test('clears inherited Command Code keys for unrelated overrides', () => {
    const env: Record<string, string | undefined> = {
      CMD_API_KEY: 'stale-parent-key',
      COMMANDCODE_API_KEY: 'stale-fallback-key',
      COMMAND_CODE_API_KEY: 'stale-official-key',
    }

    applyAgentProviderOverrideToEnv(
      {
        model: 'deepseek-chat',
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: 'configured-agent-key',
      },
      env,
    )

    expect(env.CMD_API_KEY).toBeUndefined()
    expect(env.COMMANDCODE_API_KEY).toBeUndefined()
    expect(env.COMMAND_CODE_API_KEY).toBeUndefined()
  })
})

describe('shouldEnforceModelAllowlist', () => {
  test('enforces when a provider override is present', () => {
    expect(shouldEnforceModelAllowlist('m', 'm', true)).toBe(true)
  })
  test('enforces when a model-only route changed the effective model', () => {
    expect(shouldEnforceModelAllowlist('parent', 'gpt-5-mini', false)).toBe(true)
  })
  test('does not enforce when the model is unchanged and no override', () => {
    expect(shouldEnforceModelAllowlist('m', 'm', false)).toBe(false)
  })
})

describe('resolveAgentRunModelRouting: in-process teammate route identity', () => {
  // In-process teammates run runAgent() with a synthetic agentDefinition whose
  // agentType is the teammate's display name. Routing must use the original
  // subagent_type instead, or the configured cross-provider route is missed and
  // the teammate runs on the parent provider.
  const settings = {
    agentModels: {
      'deepseek-chat': {
        base_url: 'https://api.deepseek.com/v1',
        api_key: 'sk-ds',
      },
    },
    agentRouting: {
      verification: 'deepseek-chat',
    },
  } as unknown as SettingsJson

  test('teammate display name misses the configured route', () => {
    const result = resolveAgentRunModelRouting({
      resolvedAgentModel: 'parent-model',
      parentModel: 'parent-model',
      agentName: 'worker-a',
      subagentType: 'worker-a',
      settings,
    })
    expect(result).toEqual({ mainLoopModel: 'parent-model' })
  })

  test('original subagent_type resolves the cross-provider override', () => {
    const result = resolveAgentRunModelRouting({
      resolvedAgentModel: 'parent-model',
      parentModel: 'parent-model',
      agentName: 'worker-a',
      subagentType: 'verification',
      settings,
    })
    expect(result).toEqual({
      mainLoopModel: 'deepseek-chat',
      providerOverride: {
        model: 'deepseek-chat',
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: 'sk-ds',
      },
    })
  })
})
