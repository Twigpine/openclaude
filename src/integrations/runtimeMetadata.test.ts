import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, expect, spyOn } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock'
import {
  resolveModelRuntimeLimits,
  resolveOpenAIShimRuntimeContext,
} from '../integrations/runtimeMetadata'
import { clearDiscoveryCache, setCachedModels } from './discoveryCache'
import {
  getClaudeConfigHomeDirOverrideForTesting,
  setClaudeConfigHomeDirForTesting,
} from '../utils/envUtils.js'
import {
  getDiscoveryCacheKey,
  getRouteDiscoveryHeaders,
} from './discoveryService'
import { resolveActiveRouteIdFromEnv } from './routeMetadata.js'
import glmBrand from './brands/glm.js'
import glmModels from './models/glm.js'
import zaiVendor from './vendors/zai.js'

describe('Z.AI GLM-5.3 descriptor contract', () => {
  it('wires the verified GLM-5.3-Flash descriptor and direct catalog contract', () => {
    const model = glmModels.find(candidate => candidate.id === 'glm-5.3-flash')
    expect(model).toMatchObject({
      id: 'glm-5.3-flash',
      label: 'GLM 5.3 Flash',
      vendorId: 'zai',
      brandId: 'glm',
      classification: ['chat', 'reasoning', 'vision', 'coding'],
      defaultModel: 'glm-5.3-flash',
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      runtimeMetadataScope: 'catalog',
      capabilities: {
        supportsVision: true,
        supportsStreaming: true,
        supportsFunctionCalling: true,
        supportsJsonMode: true,
        supportsReasoning: true,
        supportsPreciseTokenCount: false,
      },
    })

    expect(glmBrand.modelIds?.[0]).toBe('glm-5.3-flash')
    expect(glmBrand.modelIds?.[1]).toBe('glm-5.3')

    const catalogEntries = zaiVendor.catalog?.models ?? []
    const flashEntries = catalogEntries.filter(entry => entry.id === 'glm-5.3-flash')
    expect(flashEntries).toHaveLength(1)
    expect(catalogEntries[0]).toMatchObject({
      id: 'glm-5.3-flash',
      apiName: 'glm-5.3-flash',
      label: 'GLM-5.3-Flash',
      modelDescriptorId: 'glm-5.3-flash',
      reasoning: {
        mode: 'levels',
        levels: ['low', 'high', 'xhigh'],
        wireFormat: 'zai_compatible',
      },
      transportOverrides: {
        openaiShim: { enableToolStreaming: true },
      },
    })
    expect(catalogEntries[1]?.id).toBe('glm-5.3')
    expect(zaiVendor.catalog?.source).toBe('static')
    expect(zaiVendor.defaultModel).toBe('glm-5.2')
  })

  it('wires the verified shared model, brand, and direct catalog entry without changing the default', () => {
    const model = glmModels.find(candidate => candidate.id === 'glm-5.3')
    expect(model).toMatchObject({
      id: 'glm-5.3',
      label: 'GLM 5.3',
      vendorId: 'zai',
      brandId: 'glm',
      classification: ['chat', 'reasoning', 'coding'],
      defaultModel: 'glm-5.3',
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      runtimeMetadataScope: 'catalog',
      capabilities: {
        supportsVision: false,
        supportsStreaming: true,
        supportsFunctionCalling: true,
        supportsJsonMode: true,
        supportsReasoning: true,
        supportsPreciseTokenCount: false,
      },
    })
    expect(glmBrand.modelIds).toContain('glm-5.3')

    const catalogEntry = zaiVendor.catalog?.models?.find(entry => entry.id === 'glm-5.3')
    expect(catalogEntry).toMatchObject({
      id: 'glm-5.3',
      apiName: 'glm-5.3',
      label: 'GLM-5.3',
      modelDescriptorId: 'glm-5.3',
      reasoning: {
        mode: 'levels',
        levels: ['low', 'high', 'xhigh'],
        wireFormat: 'zai_compatible',
      },
      transportOverrides: {
        openaiShim: { enableToolStreaming: true },
      },
    })
    expect(zaiVendor.defaultModel).toBe('glm-5.2')
  })
})

// The discovery cache resolves its path through getClaudeConfigHomeDir(), which
// deliberately ignores CLAUDE_CONFIG_DIR (OpenClaude config is independent of
// Claude Code config). Use the explicit test override so these fixtures land in
// the temp dir instead of the developer's real ~/.openclaude.
async function withTempConfigDir<T>(fn: () => Promise<T>): Promise<T> {
  await acquireSharedMutationLock('integrations/runtimeMetadata.test.ts')
  const previousOverride = getClaudeConfigHomeDirOverrideForTesting()
  let tempDir: string | null = null
  try {
    tempDir = mkdtempSync(join(tmpdir(), 'openclaude-runtime-metadata-test-'))
    setClaudeConfigHomeDirForTesting(tempDir)
    return await fn()
  } finally {
    try {
      // Drops the module-level sync snapshot so a later suite cannot read this
      // suite's fixture back out of memory after the temp dir is gone.
      await clearDiscoveryCache()
      setClaudeConfigHomeDirForTesting(previousOverride)
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true })
      }
    } finally {
      releaseSharedMutationLock()
    }
  }
}

describe('resolveModelRuntimeLimits', () => {
  it('uses discovered custom route context windows from the discovery cache', async () => {
    await withTempConfigDir(async () => {
      const baseUrl = 'http://localhost:4000/v1'
      await setCachedModels(
        getDiscoveryCacheKey('custom', {
          baseUrl,
        }),
        {
          models: [
            {
              id: 'litellm-proxy',
              apiName: 'litellm-proxy',
              label: 'litellm-proxy',
              contextWindow: 1_000_000,
            },
          ],
        },
      )

      expect(
        resolveModelRuntimeLimits({
          model: 'litellm-proxy',
          processEnv: {
            CLAUDE_CODE_USE_OPENAI: '1',
            OPENAI_BASE_URL: baseUrl,
          },
        }).contextWindow,
      ).toBe(1_000_000)
    })
  })

  it('uses the stable xAI OAuth cache identity for discovered runtime limits', async () => {
    await withTempConfigDir(async () => {
      const xaiCredentials = await import('../utils/xaiCredentials.js')
      const readSpy = spyOn(xaiCredentials, 'getCachedXaiCredentials').mockReturnValue({
        accessToken: 'rotating-access-token',
        refreshToken: 'stable-account-identity',
        tokenEndpoint: 'https://auth.x.ai/oauth/token',
      })
      try {
        const baseUrl = 'https://api.x.ai/v1'
        await setCachedModels(
          getDiscoveryCacheKey('xai', {
            baseUrl,
            apiKey: 'rotating-access-token',
            cacheKey: 'stable-account-identity',
          }),
          {
            models: [
              {
                id: 'grok-4.7',
                apiName: 'grok-4.7',
                label: 'grok-4.7',
                contextWindow: 500_000,
              },
            ],
          },
        )

        expect(
          resolveModelRuntimeLimits({
            model: 'grok-4.7',
            processEnv: {
              CLAUDE_CODE_USE_OPENAI: '1',
              OPENAI_BASE_URL: baseUrl,
              XAI_CREDENTIAL_SOURCE: 'oauth',
            },
          }).contextWindow,
        ).toBe(500_000)
      } finally {
        readSpy.mockRestore()
      }
    })
  })
  it.each([
    'glm-5.3-flash',
    'glm-5.3-flash?reasoning=low',
    'glm-5.3-flash?reasoning=high',
    'glm-5.3-flash?reasoning=xhigh',
    'glm-5.3-flash?thinking=disabled',
  ])('uses verified Z.AI GLM-5.3-Flash runtime limits for %s', model => {
    const limits = resolveModelRuntimeLimits({
      model,
      processEnv: {
        CLAUDE_CODE_USE_OPENAI: '1',
        OPENAI_BASE_URL: 'https://api.z.ai/api/coding/paas/v4',
      },
    })

    expect(limits.contextWindow).toBe(1_000_000)
    expect(limits.maxOutputTokens).toBe(131_072)
  })

  it('does not apply Coding Plan Flash limits on the same-host general Z.AI endpoint', () => {
    const processEnv = {
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_BASE_URL: 'https://api.z.ai/api/paas/v4',
    }

    expect(resolveActiveRouteIdFromEnv(processEnv)).toBe('custom')
    expect(resolveModelRuntimeLimits({
      model: 'glm-5.3-flash',
      activeProfileProvider: 'zai',
      processEnv,
    })).toEqual({
      contextWindow: undefined,
      maxOutputTokens: undefined,
    })
  })

  it.each([' ', 'undefined', 'null'])(
    'falls back from invalid OPENAI_BASE_URL %j to OPENAI_API_BASE for route limits',
    invalidPrimary => {
      const processEnv = {
        CLAUDE_CODE_USE_OPENAI: '1',
        OPENAI_BASE_URL: invalidPrimary,
        OPENAI_API_BASE: 'https://api.z.ai/api/coding/paas/v4',
      }

      expect(resolveActiveRouteIdFromEnv(processEnv, {
        activeProfileProvider: 'zai',
        activeProfileBaseUrl: 'https://api.z.ai/api/coding/paas/v4',
      })).toBe('zai')
      expect(resolveModelRuntimeLimits({
        model: 'glm-5.3-flash',
        activeProfileProvider: 'zai',
        processEnv,
      })).toEqual({
        contextWindow: 1_000_000,
        maxOutputTokens: 131_072,
      })
    },
  )

  it.each([
    'glm-5.3',
    'glm-5.3?reasoning=low',
    'glm-5.3?reasoning=xhigh',
    'glm-5.3?thinking=disabled',
  ])('uses verified Z.AI GLM-5.3 runtime limits for %s', model => {
    const limits = resolveModelRuntimeLimits({
      model,
      processEnv: {
        CLAUDE_CODE_USE_OPENAI: '1',
        OPENAI_BASE_URL: 'https://api.z.ai/api/coding/paas/v4',
      },
    })

    expect(limits.contextWindow).toBe(1_000_000)
    expect(limits.maxOutputTokens).toBe(131_072)
  })

  it('keeps the built-in Z.AI GLM-5.2 runtime limits', () => {
    const limits = resolveModelRuntimeLimits({
      model: 'glm-5.2',
      processEnv: {
        OPENAI_BASE_URL: 'https://api.z.ai/api/coding/paas/v4',
      },
    })

    expect(limits.contextWindow).toBe(1_000_000)
    expect(limits.maxOutputTokens).toBe(131_072)
  })

  it.each([
    ['NVIDIA NIM', 'https://integrate.api.nvidia.com/v1', { CLAUDE_CODE_USE_OPENAI: '1', NVIDIA_NIM: '1' }, 'nvidia-nim'],
    ['OpenRouter', 'https://openrouter.ai/api/v1', { CLAUDE_CODE_USE_OPENAI: '1' }, 'openrouter'],
    ['custom endpoint', 'https://proxy.example.test/v1', { CLAUDE_CODE_USE_OPENAI: '1' }, 'custom'],
  ] as const)('does not leak direct Z.AI GLM-5.3-Flash limits onto %s', (_name, baseUrl, routeEnv, expectedRoute) => {
    const processEnv = {
      ...routeEnv,
      OPENAI_BASE_URL: baseUrl,
    }
    expect(resolveActiveRouteIdFromEnv(processEnv)).toBe(expectedRoute)
    expect(resolveModelRuntimeLimits({
      model: 'glm-5.3-flash',
      processEnv,
    })).toEqual({
      contextWindow: undefined,
      maxOutputTokens: undefined,
    })
  })

  it.each([
    ['NVIDIA NIM', 'https://integrate.api.nvidia.com/v1', { CLAUDE_CODE_USE_OPENAI: '1', NVIDIA_NIM: '1' }, 'nvidia-nim'],
    ['OpenRouter', 'https://openrouter.ai/api/v1', { CLAUDE_CODE_USE_OPENAI: '1' }, 'openrouter'],
    ['custom endpoint', 'https://proxy.example.test/v1', { CLAUDE_CODE_USE_OPENAI: '1' }, 'custom'],
  ] as const)('does not leak direct Z.AI GLM-5.3 limits onto %s', (_name, baseUrl, routeEnv, expectedRoute) => {
    const processEnv = {
      ...routeEnv,
      OPENAI_BASE_URL: baseUrl,
    }
    expect(resolveActiveRouteIdFromEnv(processEnv)).toBe(expectedRoute)
    expect(resolveModelRuntimeLimits({
      model: 'glm-5.3',
      processEnv,
    })).toEqual({
      contextWindow: undefined,
      maxOutputTokens: undefined,
    })
  })
  it('uses generic limits when an explicit custom URL overrides the applied profile route', () => {
    expect(
      resolveModelRuntimeLimits({
        model: 'kimi-k2.6',
        activeProfileProvider: 'opencode',
        processEnv: {
          CLAUDE_CODE_USE_OPENAI: '1',
          CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED: '1',
          OPENAI_BASE_URL: 'https://proxy.example.test/v1',
        },
      }),
    ).toEqual({ contextWindow: 262_144, maxOutputTokens: 32_768 })
  })

  it('preserves composite provider paths before generic last-segment fallbacks', () => {
    for (const model of [
      'openrouter/accounts/fireworks/models/deepseek-v4-pro',
      'openrouter/fireworks/models/deepseek-v4-pro',
    ]) {
      expect(
        resolveModelRuntimeLimits({
          model,
          processEnv: {
            CLAUDE_CODE_USE_OPENAI: '1',
            OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
          },
        }).maxOutputTokens,
      ).toBe(32_768)
    }

    for (const model of [
      'openrouter/accounts/fireworks/models/llama-v3p1-70b-instruct',
      'openrouter/fireworks/models/llama-v3p1-70b-instruct',
    ]) {
      expect(
        resolveModelRuntimeLimits({
          model,
          processEnv: {
            CLAUDE_CODE_USE_OPENAI: '1',
            OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
          },
        }).contextWindow,
      ).toBe(131_072)
    }
  })


  it('uses pooled OpenAI fallback credentials when reading discovered runtime limits', async () => {
    await withTempConfigDir(async () => {
      const baseUrl = 'http://localhost:4000/v1'
      await setCachedModels(
        getDiscoveryCacheKey('custom', {
          baseUrl,
          apiKey: 'key-a',
        }),
        {
          models: [
            {
              id: 'pooled-litellm-proxy',
              apiName: 'pooled-litellm-proxy',
              label: 'pooled-litellm-proxy',
              contextWindow: 2_000_000,
            },
          ],
        },
      )

      expect(
        resolveModelRuntimeLimits({
          model: 'pooled-litellm-proxy',
          processEnv: {
            CLAUDE_CODE_USE_OPENAI: '1',
            OPENAI_BASE_URL: baseUrl,
            OPENAI_API_KEYS: 'key-a,key-b',
          },
        }).contextWindow,
      ).toBe(2_000_000)
    })
  })

  it.each([128_000, 200_000])(
    'keeps a gateway-advertised %i window for a globally larger known model',
    async advertised => {
      // User-reported path: OmniRoute + GPT-5.6 Sol ("gpt sol"), whose gateway
      // advertised a smaller window than the known descriptor. An advertised
      // `context_length` is indistinguishable from a real per-deployment cap, so
      // discovery stays authoritative — budgeting past the endpoint's real limit
      // would trade an early compact for a mid-session API failure. 128k is
      // covered explicitly because it is the value gateways most often report as
      // a flat default.
      await withTempConfigDir(async () => {
        const baseUrl = 'http://localhost:20128/v1'
        await setCachedModels(
          getDiscoveryCacheKey('custom', {
            baseUrl,
          }),
          {
            models: [
              {
                id: 'gpt-5.6-sol',
                apiName: 'gpt-5.6-sol',
                label: 'gpt-5.6-sol',
                contextWindow: advertised,
              },
            ],
          },
        )

        expect(
          resolveModelRuntimeLimits({
            model: 'gpt-5.6-sol',
            processEnv: {
              CLAUDE_CODE_USE_OPENAI: '1',
              OPENAI_BASE_URL: baseUrl,
            },
          }).contextWindow,
        ).toBe(advertised)
      })
    },
  )

  it('lets an exact env override beat a wrong discovery-cache context window', async () => {
    await withTempConfigDir(async () => {
      const baseUrl = 'http://localhost:20128/v1'
      await setCachedModels(
        getDiscoveryCacheKey('custom', {
          baseUrl,
        }),
        {
          models: [
            {
              id: 'my-codex-combo',
              apiName: 'my-codex-combo',
              label: 'my-codex-combo',
              contextWindow: 128_000,
            },
          ],
        },
      )

      expect(
        resolveModelRuntimeLimits({
          model: 'my-codex-combo',
          processEnv: {
            CLAUDE_CODE_USE_OPENAI: '1',
            OPENAI_BASE_URL: baseUrl,
            CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS: JSON.stringify({
              'my-codex-combo': 1_000_000,
            }),
          },
        }).contextWindow,
      ).toBe(1_000_000)
    })
  })

  it('lets env prefix overrides beat discovery for both context and max-output limits', async () => {
    // CodeRabbit on #2082: exact-key and settings.modelLimits vs discovery are
    // covered, but not CLAUDE_CODE_OPENAI_* prefix keys. A prefix pin is the
    // documented way to cover a family of gateway model ids without listing
    // each one, and must sit above the discovery cache for both limits.
    await withTempConfigDir(async () => {
      const baseUrl = 'http://localhost:20128/v1'
      await setCachedModels(
        getDiscoveryCacheKey('custom', {
          baseUrl,
        }),
        {
          models: [
            {
              id: 'my-codex-combo-v2',
              apiName: 'my-codex-combo-v2',
              label: 'my-codex-combo-v2',
              contextWindow: 128_000,
              maxOutputTokens: 8_192,
            },
          ],
        },
      )

      expect(
        resolveModelRuntimeLimits({
          model: 'my-codex-combo-v2',
          processEnv: {
            CLAUDE_CODE_USE_OPENAI: '1',
            OPENAI_BASE_URL: baseUrl,
            CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS: JSON.stringify({
              'my-codex-combo': 1_000_000,
            }),
            CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS: JSON.stringify({
              'my-codex-combo': 32_768,
            }),
          },
        }),
      ).toEqual({ contextWindow: 1_000_000, maxOutputTokens: 32_768 })
    })
  })
})

describe('LLMTR runtime attribution', () => {
  it('keeps query-bearing endpoints on the generic custom transport', () => {
    const result = resolveOpenAIShimRuntimeContext({
      activeProfileProvider: 'llmtr',
      baseUrl: 'https://llmtr.com/v1?tenant=proxy',
      model: 'proxy-model',
      processEnv: {
        CLAUDE_CODE_USE_OPENAI: '1',
        OPENAI_API_FORMAT: 'responses',
      },
    })

    expect(result.routeId).not.toBe('llmtr')
    expect(result.openaiShimConfig.requiredApiFormat).toBeUndefined()
    expect(result.openaiShimConfig.maxTokensField).toBeUndefined()
  })
})

describe('AIMLAPI runtime attribution', () => {
  it('sends the fixed partner id on the canonical endpoint only', () => {
    const previous = process.env.AIMLAPI_PARTNER_ID
    // The partner id is locked; an ambient env override must be ignored, never
    // forwarded to the backend.
    process.env.AIMLAPI_PARTNER_ID = 'part_runtime_override'
    try {
      const canonical = resolveOpenAIShimRuntimeContext({
        activeProfileProvider: 'aimlapi',
        baseUrl: 'https://api.aimlapi.com/v1',
        model: 'gpt-4o',
      })
      expect(canonical.openaiShimConfig.headers?.['X-AIMLAPI-Partner-ID']).toBe(
        'part_62yQoGYDq4Yqnrj2R1iGrDNJ',
      )
      // The mandatory source header rides on every canonical inference request.
      expect(canonical.openaiShimConfig.headers?.['X-AIMLAPI-Source']).toBe(
        'agent/openclaude',
      )

      const proxy = resolveOpenAIShimRuntimeContext({
        activeProfileProvider: 'aimlapi',
        baseUrl: 'https://proxy.example.test/v1',
        model: 'gpt-4o',
      })
      // Every catalog attribution header must be stripped on a proxy endpoint,
      // not just the partner id.
      expect(proxy.openaiShimConfig.headers?.['X-AIMLAPI-Source']).toBeUndefined()
      expect(proxy.openaiShimConfig.headers?.['X-AIMLAPI-Partner-ID']).toBeUndefined()
      expect(proxy.openaiShimConfig.headers?.['X-AIMLAPI-Integration-Repo']).toBeUndefined()
      expect(proxy.openaiShimConfig.headers?.['X-AIMLAPI-Integration-Version']).toBeUndefined()
      expect(proxy.openaiShimConfig.headers?.['HTTP-Referer']).toBeUndefined()
      expect(proxy.openaiShimConfig.headers?.['X-Title']).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.AIMLAPI_PARTNER_ID
      else process.env.AIMLAPI_PARTNER_ID = previous
    }
  })

  it('strips attribution from model discovery on a proxy endpoint', () => {
    // Startup discovery runs with the profile's own base URL while the route id
    // stays `aimlapi`, so the `/models` request must be filtered on the same
    // canonical predicate the inference shim uses — otherwise the proxy still
    // receives the partner identity.
    const proxy = getRouteDiscoveryHeaders('aimlapi', {
      baseUrl: 'https://proxy.example.test/v1',
    })
    for (const name of [
      'X-AIMLAPI-Source',
      'X-AIMLAPI-Partner-ID',
      'X-AIMLAPI-Integration-Repo',
      'X-AIMLAPI-Integration-Version',
      'HTTP-Referer',
      'X-Title',
    ]) {
      expect(proxy?.[name]).toBeUndefined()
    }

    // The partner id is locked to the built-in attribution id, so the canonical
    // assertions hold regardless of any ambient AIMLAPI_PARTNER_ID.
    const canonical = getRouteDiscoveryHeaders('aimlapi', {
      baseUrl: 'https://api.aimlapi.com/v1',
    })
    expect(canonical?.['X-AIMLAPI-Partner-ID']).toBe(
      'part_62yQoGYDq4Yqnrj2R1iGrDNJ',
    )
    expect(canonical?.['X-AIMLAPI-Source']).toBe('agent/openclaude')
    expect(canonical?.['HTTP-Referer']).toBe('OpenClaude')

    // A missing base URL falls back to the route default, which is canonical.
    expect(getRouteDiscoveryHeaders('aimlapi')?.['X-AIMLAPI-Partner-ID']).toBe(
      'part_62yQoGYDq4Yqnrj2R1iGrDNJ',
    )
  })

  it('does not forward caller headers during Command Code discovery', () => {
    expect(
      getRouteDiscoveryHeaders('commandcode', {
        baseUrl: 'https://api.commandcode.ai/provider/v1',
        headers: {
          'X-Proxy-Secret': 'must-not-leak',
        },
      }),
    ).toBeUndefined()
  })
})

describe('resolveOpenAIShimRuntimeContext - Z.A.I GLM-5.2', () => {
  it.each([
    'glm-5.2',
    'glm-5.2?reasoning=high',
    'glm-5.2?thinking=disabled',
  ])('uses Z.A.I GLM-5.2 shim settings for %s', model => {
    const result = resolveOpenAIShimRuntimeContext({
      model,
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      processEnv: {},
    })

    expect(result.routeId).toBe('zai')
    expect(result.catalogEntry?.id).toBe('glm-5.2')
    expect(result.openaiShimConfig.thinkingRequestFormat).toBe('zai-compatible')
    expect(result.openaiShimConfig.preserveReasoningContent).toBe(true)
    expect(result.openaiShimConfig.requireReasoningContentOnAssistantMessages).toBe(true)
    expect(result.openaiShimConfig.enableToolStreaming).toBe(true)
  })
})

describe('resolveOpenAIShimRuntimeContext - Z.A.I GLM-5.3', () => {
  it.each([
    'glm-5.3',
    'glm-5.3?reasoning=xhigh',
    'glm-5.3?thinking=disabled',
  ])('uses the explicit direct-route GLM-5.3 contract for %s', model => {
    const result = resolveOpenAIShimRuntimeContext({
      model,
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      processEnv: {},
    })

    expect(result.routeId).toBe('zai')
    expect(result.catalogEntry?.id).toBe('glm-5.3')
    expect(result.openaiShimConfig.thinkingRequestFormat).toBe('zai-compatible')
    expect(result.openaiShimConfig.preserveReasoningContent).toBe(true)
    expect(result.openaiShimConfig.requireReasoningContentOnAssistantMessages).toBe(true)
    expect(result.openaiShimConfig.maxTokensField).toBe('max_tokens')
    expect(result.openaiShimConfig.removeBodyFields).toContain('store')
    expect(result.openaiShimConfig.enableToolStreaming).toBe(true)
  })
})

describe('resolveOpenAIShimRuntimeContext - Z.A.I GLM-5.3-Flash', () => {
  it.each([
    'glm-5.3-flash',
    'glm-5.3-flash?reasoning=xhigh',
    'glm-5.3-flash?thinking=disabled',
  ])('uses the explicit direct-route GLM-5.3-Flash contract for %s', model => {
    const result = resolveOpenAIShimRuntimeContext({
      model,
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      processEnv: {},
    })

    expect(result.routeId).toBe('zai')
    expect(result.catalogEntry?.id).toBe('glm-5.3-flash')
    expect(result.openaiShimConfig.thinkingRequestFormat).toBe('zai-compatible')
    expect(result.openaiShimConfig.preserveReasoningContent).toBe(true)
    expect(result.openaiShimConfig.requireReasoningContentOnAssistantMessages).toBe(true)
    expect(result.openaiShimConfig.maxTokensField).toBe('max_tokens')
    expect(result.openaiShimConfig.removeBodyFields).toContain('store')
    expect(result.openaiShimConfig.enableToolStreaming).toBe(true)
  })

  it('does not apply the Coding Plan catalog entry on the same-host general endpoint', () => {
    const result = resolveOpenAIShimRuntimeContext({
      model: 'glm-5.3-flash',
      baseUrl: 'https://api.z.ai/api/paas/v4',
      activeProfileProvider: 'zai',
      processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
    })

    expect(result.routeId).toBe('custom')
    expect(result.catalogEntry).toBeNull()
    expect(result.openaiShimConfig.enableToolStreaming).toBe(false)
  })
})

describe('resolveOpenAIShimRuntimeContext - GLM on a non-Z.AI gateway (#1896)', () => {
  it('infers the GLM reasoning shim but not tool streaming for a third-party gateway', () => {
    const result = resolveOpenAIShimRuntimeContext({
      model: 'z-ai/glm-5.2',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      processEnv: {},
    })

    // No catalog entry for a custom OpenAI-compatible gateway, so the shim is
    // inferred from the model name.
    expect(result.catalogEntry).toBeNull()
    // Reasoning-shaping fields still apply — GLM needs them on any gateway.
    expect(result.openaiShimConfig.thinkingRequestFormat).toBe('zai-compatible')
    expect(result.openaiShimConfig.preserveReasoningContent).toBe(true)
    // tool_stream is Z.AI-proprietary and must NOT be inferred; NVIDIA NIM (and
    // other third-party gateways) reject it with 400 Unsupported parameter(s).
    expect(result.openaiShimConfig.enableToolStreaming).toBe(false)
  })
})

describe('resolveOpenAIShimRuntimeContext - NVIDIA NIM GLM-5.2 (regression #1950)', () => {
  // The user selected `z-ai/glm-5.2` from NVIDIA NIM's discovered (dynamic)
  // model catalog. Even when a GLM catalog entry exists on a non-Z.AI gateway,
  // `tool_stream` must stay off (Z.AI-proprietary); the reasoning-shaping shim
  // still applies because GLM needs it on any gateway.
  it('does not enable tool_stream for NVIDIA NIM GLM-5.2 and keeps the reasoning shim', () => {
    const result = resolveOpenAIShimRuntimeContext({
      model: 'z-ai/glm-5.2',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      processEnv: { NVIDIA_NIM: '1' },
    })

    expect(result.routeId).toBe('nvidia-nim')
    expect(result.openaiShimConfig.enableToolStreaming).toBe(false)
    expect(result.openaiShimConfig.thinkingRequestFormat).toBe('zai-compatible')
    expect(result.openaiShimConfig.preserveReasoningContent).toBe(true)
    expect(result.openaiShimConfig.requireReasoningContentOnAssistantMessages).toBe(true)
    expect(result.openaiShimConfig.maxTokensField).toBe('max_tokens')
    expect(result.openaiShimConfig.removeBodyFields).toContain('store')
  })
})

describe('resolveOpenAIShimRuntimeContext - Moonshot and Kimi Code catalog metadata', () => {
  it('uses Moonshot direct catalog order, limits, and reasoning controls', () => {
    expect(
      resolveModelRuntimeLimits({
        model: 'kimi-k3',
        baseUrl: 'https://api.moonshot.ai/v1',
        processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
      }),
    ).toEqual({ contextWindow: 1_048_576, maxOutputTokens: 32_768 })

    expect(
      resolveModelRuntimeLimits({
        model: 'kimi-k2.7-code',
        baseUrl: 'https://api.moonshot.ai/v1',
        processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
      }),
    ).toEqual({ contextWindow: 262_144, maxOutputTokens: 32_768 })

    expect(
      resolveModelRuntimeLimits({
        model: 'kimi-k2.6',
        baseUrl: 'https://api.moonshot.ai/v1',
        processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
      }),
    ).toEqual({ contextWindow: 262_144, maxOutputTokens: 262_144 })

    expect(
      resolveModelRuntimeLimits({
        model: 'kimi-k2.5',
        baseUrl: 'https://api.moonshot.ai/v1',
        processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
      }),
    ).toEqual({ contextWindow: 262_144, maxOutputTokens: 262_144 })

    const result = resolveOpenAIShimRuntimeContext({
      model: 'kimi-k2.7-code',
      baseUrl: 'https://api.moonshot.ai/v1',
      processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
    })

    expect(result.routeId).toBe('moonshot')
    expect(result.descriptor?.catalog?.models?.map(model => model.id)).toEqual([
      'k3',
      'kimi-k2.7-code',
      'kimi-k2.6',
      'kimi-k2.5',
    ])
    expect(result.catalogEntry?.id).toBe('kimi-k2.7-code')
    expect(result.catalogEntry?.aliases).toContain('moonshotai/kimi-k2.7-code')
    expect(result.catalogEntry?.reasoning?.levels).toEqual(['low', 'medium', 'high'])
    expect(result.catalogEntry?.reasoning?.defaultLevel).toBe('medium')
    expect(result.openaiShimConfig.maxTokensField).toBe('max_tokens')
    expect(result.openaiShimConfig.removeBodyFields).toContain('store')

    const qualified = resolveOpenAIShimRuntimeContext({
      model: 'moonshotai/kimi-k2.7-code',
      baseUrl: 'https://api.moonshot.ai/v1',
      processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
    })
    expect(qualified.routeId).toBe('moonshot')
    expect(qualified.catalogEntry?.id).toBe('kimi-k2.7-code')
    expect(qualified.catalogEntry?.reasoning?.levels).toEqual(['low', 'medium', 'high'])
  })

  it('uses Kimi Code gateway catalog limits and reasoning controls', () => {
    expect(
      resolveModelRuntimeLimits({
        model: 'kimi-for-coding',
        baseUrl: 'https://api.kimi.com/coding/v1',
        processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
      }),
    ).toEqual({ contextWindow: 262_144, maxOutputTokens: 32_768 })

    const result = resolveOpenAIShimRuntimeContext({
      model: 'kimi-for-coding',
      baseUrl: 'https://api.kimi.com/coding/v1',
      processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
    })

    expect(result.routeId).toBe('kimi-code')
    expect(result.descriptor?.catalog?.models?.map(model => model.id)).toEqual([
      'k3',
      'k3-256k',
      'kimi-k2.7-code',
      'kimi-for-coding',
      'kimi-for-coding-highspeed',
    ])
    const k3 = resolveOpenAIShimRuntimeContext({
      model: 'k3',
      baseUrl: 'https://api.kimi.com/coding/v1',
      processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
    })
    expect(k3.catalogEntry).toMatchObject({
      id: 'k3',
      contextWindow: 1_048_576,
      label: 'Kimi K3 (1M)',
    })
    expect(k3.catalogEntry?.reasoning?.levels).toEqual(['low', 'high', 'max'])
    expect(resolveModelRuntimeLimits({
      model: 'k3-256k',
      baseUrl: 'https://api.kimi.com/coding/v1',
      processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
    })).toEqual({ contextWindow: 262_144, maxOutputTokens: 32_768 })
    const highspeed = resolveOpenAIShimRuntimeContext({
      model: 'kimi-for-coding-highspeed',
      baseUrl: 'https://api.kimi.com/coding/v1',
      processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
    })
    expect(highspeed.catalogEntry).toMatchObject({
      id: 'kimi-for-coding-highspeed',
      apiName: 'kimi-for-coding-highspeed',
      contextWindow: 262_144,
      maxOutputTokens: 32_768,
    })
    expect(highspeed.catalogEntry?.reasoning?.levels).toEqual(['low', 'medium', 'high'])
    expect(result.catalogEntry?.id).toBe('kimi-for-coding')
    expect(result.catalogEntry?.reasoning?.levels).toEqual(['low', 'medium', 'high'])
    expect(result.catalogEntry?.reasoning?.defaultLevel).toBe('medium')
    expect(result.openaiShimConfig.maxTokensField).toBe('max_tokens')
    expect(result.openaiShimConfig.removeBodyFields).toContain('store')

    const k27 = resolveOpenAIShimRuntimeContext({
      model: 'kimi-k2.7-code',
      baseUrl: 'https://api.kimi.com/coding/v1',
      processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
    })
    expect(k27.routeId).toBe('kimi-code')
    expect(k27.catalogEntry?.id).toBe('kimi-k2.7-code')
    expect(k27.catalogEntry?.reasoning?.levels).toEqual(['low', 'medium', 'high'])

    const qualified = resolveOpenAIShimRuntimeContext({
      model: 'moonshotai/kimi-k2.7-code',
      baseUrl: 'https://api.kimi.com/coding/v1',
      processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
    })
    expect(qualified.routeId).toBe('kimi-code')
    expect(qualified.catalogEntry?.id).toBe('kimi-k2.7-code')
    expect(qualified.catalogEntry?.reasoning?.levels).toEqual(['low', 'medium', 'high'])
  })

  it('uses Atlas Cloud catalog limits for Moonshot Kimi K2.7 Code', () => {
    expect(
      resolveModelRuntimeLimits({
        model: 'moonshotai/kimi-k2.7-code',
        baseUrl: 'https://api.atlascloud.ai/v1',
        processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
      }),
    ).toEqual({ contextWindow: 262_144, maxOutputTokens: 32_768 })

    const result = resolveOpenAIShimRuntimeContext({
      model: 'moonshotai/kimi-k2.7-code',
      baseUrl: 'https://api.atlascloud.ai/v1',
      processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
    })

    expect(result.routeId).toBe('atlas-cloud')
    expect(result.catalogEntry?.id).toBe('moonshotai/kimi-k2.7-code')
    expect(result.catalogEntry?.reasoning?.levels).toEqual(['low', 'medium', 'high'])
    expect(result.catalogEntry?.reasoning?.defaultLevel).toBe('medium')
  })

  it('resolves the official Grok 4.5 grok-build-latest alias on Atlas Cloud', () => {
    const result = resolveOpenAIShimRuntimeContext({
      model: 'grok-build-latest',
      baseUrl: 'https://api.atlascloud.ai/v1',
      processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
    })
    expect(result.routeId).toBe('atlas-cloud')
    expect(result.catalogEntry?.id).toBe('xai/grok-4.5')
    expect(result.catalogEntry?.reasoning?.levels).toEqual(['low', 'medium', 'high'])
  })
})

describe('resolveOpenAIShimRuntimeContext - GLM catalog-aware gating', () => {
  it('does NOT apply the Z.A.I GLM shim to a non-Z.A.I catalog route (NEAR AI)', () => {
    const result = resolveOpenAIShimRuntimeContext({
      model: 'zai-org/GLM-5.1-FP8',
      baseUrl: 'https://cloud-api.near.ai/v1',
      processEnv: {},
    })

    expect(result.routeId).toBe('nearai')
    expect(result.catalogEntry?.id).toBe('zai-org/GLM-5.1-FP8')
    expect(result.openaiShimConfig.preserveReasoningContent).toBeUndefined()
    expect(result.openaiShimConfig.thinkingRequestFormat).toBeUndefined()
    expect(result.openaiShimConfig.requireReasoningContentOnAssistantMessages).toBeUndefined()
    expect(result.openaiShimConfig.removeBodyFields).toBeUndefined()
  })

  it('applies the full Z.A.I GLM shim to opencode-go GLM via catalog overrides', () => {
    const result = resolveOpenAIShimRuntimeContext({
      model: 'glm-5.1',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      processEnv: {},
    })

    expect(result.routeId).toBe('opencode-go')
    expect(result.catalogEntry?.apiName).toBe('glm-5.1')
    expect(result.openaiShimConfig.preserveReasoningContent).toBe(true)
    expect(result.openaiShimConfig.requireReasoningContentOnAssistantMessages).toBe(true)
    expect(result.openaiShimConfig.thinkingRequestFormat).toBe('zai-compatible')
    expect(result.openaiShimConfig.maxTokensField).toBe('max_tokens')
    expect(result.openaiShimConfig.removeBodyFields).toEqual(['store'])
  })

  it('applies the full Z.A.I GLM shim to opencode (Zen) GLM via catalog overrides', () => {
    const result = resolveOpenAIShimRuntimeContext({
      model: 'glm-5.1',
      baseUrl: 'https://opencode.ai/zen/v1',
      processEnv: {},
    })

    expect(result.routeId).toBe('opencode')
    expect(result.catalogEntry?.apiName).toBe('glm-5.1')
    expect(result.openaiShimConfig.preserveReasoningContent).toBe(true)
    expect(result.openaiShimConfig.requireReasoningContentOnAssistantMessages).toBe(true)
    expect(result.openaiShimConfig.thinkingRequestFormat).toBe('zai-compatible')
    expect(result.openaiShimConfig.maxTokensField).toBe('max_tokens')
    expect(result.openaiShimConfig.removeBodyFields).toEqual(['store'])
  })

  it('applies the full Z.A.I GLM shim to Atlas Cloud GLM via catalog overrides', () => {
    const result = resolveOpenAIShimRuntimeContext({
      model: 'zai-org/glm-5.2',
      baseUrl: 'https://api.atlascloud.ai/v1',
      processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
    })

    expect(result.routeId).toBe('atlas-cloud')
    expect(result.catalogEntry?.id).toBe('zai-org/glm-5.2')
    expect(result.openaiShimConfig.preserveReasoningContent).toBe(true)
    expect(result.openaiShimConfig.requireReasoningContentOnAssistantMessages).toBe(true)
    expect(result.openaiShimConfig.thinkingRequestFormat).toBe('zai-compatible')
    expect(result.openaiShimConfig.maxTokensField).toBe('max_tokens')
    expect(result.openaiShimConfig.removeBodyFields).toEqual(['store'])
    expect(result.openaiShimConfig.enableToolStreaming).toBe(true)
  })

  it('applies the Z.A.I GLM shim to hicap GLM catalog entries', () => {
    const result = resolveOpenAIShimRuntimeContext({
      model: 'zai-org/GLM-5.2',
      baseUrl: 'https://api.hicap.ai/v1',
      processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
    })

    expect(result.routeId).toBe('hicap')
    expect(result.catalogEntry?.id).toBe('hicap-glm-5.2')
    expect(result.openaiShimConfig.thinkingRequestFormat).toBe('zai-compatible')
    expect(result.openaiShimConfig.maxTokensField).toBe('max_tokens')
    expect(result.openaiShimConfig.removeBodyFields).toContain('store')
    expect(result.openaiShimConfig.enableToolStreaming).toBe(true)
  })
})

describe('resolveOpenAIShimRuntimeContext - Hicap catalog metadata', () => {
  it('uses Hicap static model limits and per-model shim overrides', () => {
    expect(
      resolveModelRuntimeLimits({
        model: 'claude-opus-4.8',
        baseUrl: 'https://api.hicap.ai/v1',
        processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
      }),
    ).toEqual({ contextWindow: 1_000_000, maxOutputTokens: 128_000 })

    for (const model of ['claude-opus-4.7', 'claude-opus-4-7']) {
      expect(
        resolveModelRuntimeLimits({
          model,
          baseUrl: 'https://api.hicap.ai/v1',
          processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
        }),
      ).toEqual({ contextWindow: 1_000_000, maxOutputTokens: 128_000 })
    }

    expect(
      resolveModelRuntimeLimits({
        model: 'kimi-k2.7-code',
        baseUrl: 'https://api.hicap.ai/v1',
        processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
      }),
    ).toEqual({ contextWindow: 262_144, maxOutputTokens: 262_144 })

    expect(
      resolveModelRuntimeLimits({
        model: 'gpt-5.4',
        baseUrl: 'https://api.hicap.ai/v1',
        processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
      }),
    ).toEqual({ contextWindow: 1_050_000, maxOutputTokens: 128_000 })

    const glm = resolveOpenAIShimRuntimeContext({
      model: 'glm-5.2',
      baseUrl: 'https://api.hicap.ai/v1',
      processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
    })
    expect(glm.catalogEntry?.id).toBe('hicap-glm-5.2')
    expect(glm.catalogEntry?.reasoning?.levels).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(glm.openaiShimConfig.thinkingRequestFormat).toBe('zai-compatible')
    expect(glm.openaiShimConfig.maxTokensField).toBe('max_tokens')
    expect(glm.openaiShimConfig.removeBodyFields).toContain('store')
    expect(glm.openaiShimConfig.enableToolStreaming).toBe(true)

    for (const model of ['claude-opus-4.7', 'claude-opus-4-7']) {
      const opus47 = resolveOpenAIShimRuntimeContext({
        model,
        baseUrl: 'https://api.hicap.ai/v1',
        processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
      })
      expect(opus47.catalogEntry?.id).toBe('hicap-claude-opus-4.7')
      expect(opus47.catalogEntry?.apiName).toBe('claude-opus-4.7')
      expect(opus47.catalogEntry?.modelDescriptorId).toBe('claude-opus-4-7')
      expect(opus47.catalogEntry?.reasoning?.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    }

    const discoveredGlm = resolveOpenAIShimRuntimeContext({
      model: 'zai-org/GLM-5.2',
      baseUrl: 'https://api.hicap.ai/v1',
      processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
    })
    expect(discoveredGlm.catalogEntry?.id).toBe('hicap-glm-5.2')
    expect(discoveredGlm.openaiShimConfig.thinkingRequestFormat).toBe('zai-compatible')
    expect(discoveredGlm.openaiShimConfig.maxTokensField).toBe('max_tokens')

    const gpt54 = resolveOpenAIShimRuntimeContext({
      model: 'gpt-5.4',
      baseUrl: 'https://api.hicap.ai/v1',
      processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
    })
    expect(gpt54.routeId).toBe('hicap')
    expect(gpt54.catalogEntry?.id).toBe('hicap-gpt-5.4')
    expect(gpt54.catalogEntry?.reasoning?.levels).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ])
    expect(gpt54.openaiShimConfig.requiredApiFormat).toBe('responses')
    expect(gpt54.openaiShimConfig.maxTokensField).toBe('max_completion_tokens')

    const gpt55 = resolveOpenAIShimRuntimeContext({
      model: 'gpt-5.5',
      baseUrl: 'https://api.hicap.ai/v1',
      processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
    })
    expect(gpt55.routeId).toBe('hicap')
    expect(gpt55.catalogEntry?.id).toBe('hicap-gpt-5.5')
    expect(gpt55.catalogEntry?.reasoning?.levels).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ])
    expect(gpt55.openaiShimConfig.requiredApiFormat).toBe('responses')
    expect(gpt55.openaiShimConfig.maxTokensField).toBe('max_completion_tokens')

    const grok46 = resolveOpenAIShimRuntimeContext({
      model: 'grok-4.6',
      baseUrl: 'https://api.hicap.ai/v1',
      processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
    })
    expect(grok46.catalogEntry?.id).toBe('hicap-grok-4.6')
    expect(grok46.catalogEntry?.reasoning?.levels).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ])

    const grok46Latest = resolveOpenAIShimRuntimeContext({
      model: 'grok-4.6-latest',
      baseUrl: 'https://api.hicap.ai/v1',
      processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
    })
    expect(grok46Latest.catalogEntry?.id).toBe('hicap-grok-4.6')

    const grokBuildLatest = resolveOpenAIShimRuntimeContext({
      model: 'grok-build-latest',
      baseUrl: 'https://api.hicap.ai/v1',
      processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
    })
    expect(grokBuildLatest.catalogEntry?.id).toBe('hicap-grok-4.5')

    const grok = resolveOpenAIShimRuntimeContext({
      model: 'grok-4.3',
      baseUrl: 'https://api.hicap.ai/v1',
      processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
    })
    expect(grok.catalogEntry?.reasoning?.levels).toEqual([
      'low',
      'medium',
      'high',
    ])
  })
})

describe('resolveOpenAIShimRuntimeContext - xAI catalog metadata', () => {
  it('uses live xAI model metadata and per-model shim overrides', () => {
    expect(
      resolveModelRuntimeLimits({
        model: 'grok-4.6',
        baseUrl: 'https://api.x.ai/v1',
        processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
      }),
    ).toEqual({ contextWindow: 500_000 })

    const grok46 = resolveOpenAIShimRuntimeContext({
      model: 'grok-4.6-latest',
      baseUrl: 'https://api.x.ai/v1',
      processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
    })
    expect(grok46.routeId).toBe('xai')
    expect(grok46.catalogEntry?.id).toBe('grok-4.6')
    expect(grok46.catalogEntry?.reasoning?.levels).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ])

    expect(
      resolveModelRuntimeLimits({
        model: 'grok-4.5',
        baseUrl: 'https://api.x.ai/v1',
        processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
      }),
    ).toEqual({ contextWindow: 500_000, maxOutputTokens: 32_768 })

    expect(
      resolveModelRuntimeLimits({
        model: 'grok-4.20-0309-reasoning',
        baseUrl: 'https://api.x.ai/v1',
        processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
      }),
    ).toEqual({ contextWindow: 1_000_000, maxOutputTokens: 32_768 })

    const grok420Reasoning = resolveOpenAIShimRuntimeContext({
      model: 'grok-4.20',
      baseUrl: 'https://api.x.ai/v1',
      processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
    })
    expect(grok420Reasoning.catalogEntry?.id).toBe('grok-4.20-0309-reasoning')
    expect(grok420Reasoning.openaiShimConfig.endpointPath).toBe('/responses')
    expect(grok420Reasoning.openaiShimConfig.removeBodyFields).toContain('reasoning_effort')

    expect(
      resolveModelRuntimeLimits({
        model: 'grok-build-0.1',
        baseUrl: 'https://api.x.ai/v1',
        processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
      }),
    ).toEqual({ contextWindow: 256_000, maxOutputTokens: 64_000 })

    const grok43 = resolveOpenAIShimRuntimeContext({
      model: 'grok-4',
      baseUrl: 'https://api.x.ai/v1',
      processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
    })
    expect(grok43.routeId).toBe('xai')
    expect(grok43.catalogEntry?.id).toBe('grok-4.3')
    expect(grok43.catalogEntry?.reasoning?.levels).toEqual([
      'low',
      'medium',
      'high',
    ])

    const build = resolveOpenAIShimRuntimeContext({
      model: 'grok-code-fast-1',
      baseUrl: 'https://api.x.ai/v1',
      processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
    })
    expect(build.routeId).toBe('xai')
    expect(build.catalogEntry?.id).toBe('grok-build-0.1')
    expect(build.catalogEntry?.capabilities?.supportsReasoning).toBe(false)
    expect(build.catalogEntry?.reasoning).toBeUndefined()
    expect(build.openaiShimConfig.endpointPath).toBe('/responses')
    expect(build.openaiShimConfig.removeBodyFields).toContain('reasoning_effort')
  })
})

describe('resolveOpenAIShimRuntimeContext - provider override route preference', () => {
  it('uses the resolved request route for provider-override runtime limits', () => {
    const processEnv = {
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_MODEL: 'claude-sonnet-4-6',
    }

    expect(resolveModelRuntimeLimits({
      model: 'glm-5.3-flash',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      resolvedRouteId: 'zai',
      processEnv,
    })).toEqual({
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
    })
    expect(resolveModelRuntimeLimits({
      model: 'glm-5.3-flash',
      baseUrl: 'https://custom.example.test/v1',
      resolvedRouteId: null,
      processEnv,
    })).toEqual({
      contextWindow: undefined,
      maxOutputTokens: undefined,
    })
  })

  it('does not inherit ambient route config when the preferred base URL is unrecognized', () => {
    const result = resolveOpenAIShimRuntimeContext({
      model: 'gpt-4o',
      baseUrl: 'https://custom.example.test/v1',
      preferBaseUrlRoute: true,
      processEnv: {
        CLAUDE_CODE_USE_OPENAI: '1',
        OPENAI_BASE_URL: 'https://api.groq.com/openai/v1',
      },
    })

    expect(result.routeId).toBeNull()
    expect(result.descriptor).toBeNull()
    expect(result.catalogEntry).toBeNull()
    expect(result.openaiShimConfig.removeBodyFields).toBeUndefined()
    expect(result.openaiShimConfig.thinkingRequestFormat).toBeUndefined()
  })

  it('applies the full Z.AI GLM shim to the direct zai vendor catalog route', () => {
    const result = resolveOpenAIShimRuntimeContext({
      model: 'glm-5.2',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      processEnv: {},
    })

    expect(result.routeId).toBe('zai')
    expect(result.catalogEntry?.id).toBe('glm-5.2')
    expect(result.openaiShimConfig.preserveReasoningContent).toBe(true)
    expect(result.openaiShimConfig.thinkingRequestFormat).toBe('zai-compatible')
    expect(result.openaiShimConfig.requireReasoningContentOnAssistantMessages).toBe(true)
  })
})

describe('resolveOpenAIShimRuntimeContext - segment-boundary heuristic', () => {
  describe('DeepSeek models', () => {
    it('should NOT infer preserveReasoningContent for custom aliases (false-positive case)', () => {
      // my-deepseek-rag is a custom alias, NOT a provider path
      // Should NOT trigger the DeepSeek detection
      const result = resolveOpenAIShimRuntimeContext({
        processEnv: {},
        model: 'my-deepseek-rag',
      })
      // Custom aliases should NOT get preserveReasoningContent
      expect(result.openaiShimConfig.preserveReasoningContent).toBeUndefined()
    })

    it('should infer preserveReasoningContent for openrouter/deepseek/... paths (true-positive case)', () => {
      // openrouter/deepseek/deepseek-chat is a provider path with segments
      // Should trigger the DeepSeek detection
      const result = resolveOpenAIShimRuntimeContext({
        processEnv: {},
        model: 'openrouter/deepseek/deepseek-chat',
      })
      expect(result.openaiShimConfig.preserveReasoningContent).toBe(true)
      expect(result.openaiShimConfig.reasoningContentFallback).toBe('')
    })

    it('should infer preserveReasoningContent for accounts/fireworks/... paths (true-positive case)', () => {
      // accounts/fireworks/models/deepseek-v3 is a provider path with multiple segments
      // Should trigger the DeepSeek detection
      const result = resolveOpenAIShimRuntimeContext({
        processEnv: {},
        model: 'accounts/fireworks/models/deepseek-v3',
      })
      expect(result.openaiShimConfig.preserveReasoningContent).toBe(true)
      expect(result.openaiShimConfig.reasoningContentFallback).toBe('')
    })

    it('should infer preserveReasoningContent for deepseek-chat directly (standard case)', () => {
      const result = resolveOpenAIShimRuntimeContext({
        processEnv: {},
        model: 'deepseek-chat',
      })
      expect(result.openaiShimConfig.preserveReasoningContent).toBe(true)
    })

    it('should infer preserveReasoningContent for deepseek-coder (model name)', () => {
      const result = resolveOpenAIShimRuntimeContext({
        processEnv: {},
        model: 'deepseek-coder',
      })
      expect(result.openaiShimConfig.preserveReasoningContent).toBe(true)
    })
  })

  describe('Kimi/Moonshot models', () => {
    it('should NOT infer preserveReasoningContent for custom kimi aliases', () => {
      // Custom alias should not trigger
      const result = resolveOpenAIShimRuntimeContext({
        processEnv: {},
        model: 'my-kimi-assistant',
      })
      expect(result.openaiShimConfig.preserveReasoningContent).toBeUndefined()
    })

    it('should infer preserveReasoningContent for moonshot AI paths', () => {
      const result = resolveOpenAIShimRuntimeContext({
        processEnv: {},
        model: 'openrouter/moonshotai/moonshot-v1-8k',
      })
      expect(result.openaiShimConfig.preserveReasoningContent).toBe(true)
    })

    it('should infer preserveReasoningContent for direct moonshot model names', () => {
      const result = resolveOpenAIShimRuntimeContext({
        processEnv: {},
        model: 'moonshot-v1-8k',
      })
      expect(result.openaiShimConfig.preserveReasoningContent).toBe(true)
    })
  })

  describe('GLM models', () => {
    it('should NOT infer Z.A.I overrides for custom glm aliases', () => {
      for (const model of ['my-glm-assistant', 'glm-assistant', 'glm-router']) {
        const result = resolveOpenAIShimRuntimeContext({
          processEnv: {},
          model,
        })
        expect(result.openaiShimConfig.preserveReasoningContent).toBeUndefined()
        expect(result.openaiShimConfig.thinkingRequestFormat).toBeUndefined()
        expect(result.openaiShimConfig.requireReasoningContentOnAssistantMessages).toBeUndefined()
        expect(result.openaiShimConfig.reasoningContentFallback).toBeUndefined()
        expect(result.openaiShimConfig.maxTokensField).toBeUndefined()
        expect(result.openaiShimConfig.removeBodyFields).toBeUndefined()
      }
    })

    it('should NOT infer Z.A.I overrides for Fireworks GLM catalog entries', () => {
      const result = resolveOpenAIShimRuntimeContext({
        processEnv: {},
        model: 'accounts/fireworks/models/glm-5p2',
      })
      expect(result.openaiShimConfig.preserveReasoningContent).toBeUndefined()
      expect(result.openaiShimConfig.thinkingRequestFormat).toBeUndefined()
      expect(result.openaiShimConfig.requireReasoningContentOnAssistantMessages).toBeUndefined()
      expect(result.openaiShimConfig.reasoningContentFallback).toBeUndefined()
      expect(result.openaiShimConfig.maxTokensField).toBeUndefined()
      expect(result.openaiShimConfig.removeBodyFields).toBeUndefined()
    })

    it('should infer full GLM config for GLM paths', () => {
      const result = resolveOpenAIShimRuntimeContext({
        processEnv: {},
        model: 'openrouter/zhipu/glm-5.2',
      })
      expect(result.openaiShimConfig.preserveReasoningContent).toBe(true)
      expect(result.openaiShimConfig.thinkingRequestFormat).toBe('zai-compatible')
      expect(result.openaiShimConfig.requireReasoningContentOnAssistantMessages).toBe(true)
      expect(result.openaiShimConfig.reasoningContentFallback).toBe('')
      expect(result.openaiShimConfig.maxTokensField).toBe('max_tokens')
      expect(result.openaiShimConfig.removeBodyFields).toEqual(['store'])
    })

    it('should infer full GLM config for direct glm model names', () => {
      const result = resolveOpenAIShimRuntimeContext({
        processEnv: {},
        model: 'glm-5.2',
      })
      expect(result.openaiShimConfig.preserveReasoningContent).toBe(true)
      expect(result.openaiShimConfig.thinkingRequestFormat).toBe('zai-compatible')
      expect(result.openaiShimConfig.requireReasoningContentOnAssistantMessages).toBe(true)
      expect(result.openaiShimConfig.reasoningContentFallback).toBe('')
      expect(result.openaiShimConfig.maxTokensField).toBe('max_tokens')
      expect(result.openaiShimConfig.removeBodyFields).toEqual(['store'])
    })
  })

  describe('Non-matching models', () => {
    it('should return undefined for gpt-4o (negative case)', () => {
      const result = resolveOpenAIShimRuntimeContext({
        processEnv: {},
        model: 'gpt-4o',
      })
      expect(result.openaiShimConfig.preserveReasoningContent).toBeUndefined()
    })

    it('should return undefined for claude models (negative case)', () => {
      const result = resolveOpenAIShimRuntimeContext({
        processEnv: {},
        model: 'claude-sonnet-4-20250514',
      })
      expect(result.openaiShimConfig.preserveReasoningContent).toBeUndefined()
    })
  })
  it('matches provider-prefixed model ids to built-in runtime limits', () => {
    expect(
      resolveModelRuntimeLimits({
        model: 'google/gemini-3.1-pro',
        activeProfileProvider: 'custom',
        processEnv: {
          CLAUDE_CODE_USE_OPENAI: '1',
          OPENAI_BASE_URL: 'https://example-gateway.test/v1',
        },
      }).contextWindow,
    ).toBe(1_048_576)

    expect(
      resolveModelRuntimeLimits({
        model: 'moonshotai/kimi-k2.6',
        activeProfileProvider: 'nvidia-nim',
        processEnv: {
          CLAUDE_CODE_USE_OPENAI: '1',
          OPENAI_BASE_URL: 'https://integrate.api.nvidia.com/v1',
        },
      }).contextWindow,
    ).toBe(262_144)
  })

  it('preserves OpenGateway maxTokensField wire contract for live-only inferred models', () => {
    for (const model of ['moonshotai/kimi-k3', 'deepseek/deepseek-r1', 'z-ai/glm-5.2']) {
      const result = resolveOpenAIShimRuntimeContext({
        baseUrl: 'https://opengateway.gitlawb.com/v1',
        model,
        processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
      })
      expect(result.routeId).toBe('gitlawb-opengateway')
      expect(result.openaiShimConfig.maxTokensField).toBe('max_completion_tokens')
      expect(result.openaiShimConfig.preserveReasoningContent).toBe(true)
    }
  })

  it('prefers explicit descriptor and catalog openaiShim overrides over inferred settings and merges removeBodyFields', () => {
    // Inferred GLM shim defaults maxTokensField to 'max_tokens' and removeBodyFields to ['store'].
    // OpenGateway route descriptor explicitly sets maxTokensField to 'max_completion_tokens'
    // and removeBodyFields to ['store', 'stream_options'].
    const opengatewayGlm = resolveOpenAIShimRuntimeContext({
      baseUrl: 'https://opengateway.gitlawb.com/v1',
      model: 'z-ai/glm-5.2',
      processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
    })
    expect(opengatewayGlm.openaiShimConfig.maxTokensField).toBe('max_completion_tokens')
    expect(opengatewayGlm.openaiShimConfig.removeBodyFields).toEqual([
      'store',
      'stream_options',
    ])
    expect(opengatewayGlm.openaiShimConfig.preserveReasoningContent).toBe(true)

    // Atlas Cloud grok-build-0.1 catalog entry explicitly sets removeBodyFields: ['reasoning_effort']
    // which merges with any route-level settings.
    const atlasGrok = resolveOpenAIShimRuntimeContext({
      baseUrl: 'https://api.atlascloud.ai/v1',
      model: 'xai/grok-build-0.1',
      processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
    })
    expect(atlasGrok.openaiShimConfig.removeBodyFields).toContain('reasoning_effort')
  })
})
