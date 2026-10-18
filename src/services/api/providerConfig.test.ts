import { expect, test } from 'bun:test'

import { resolveProviderRequest } from './providerConfig.js'

test('resolveProviderRequest strips GLM model-query suffixes from API model value', () => {
  const request = resolveProviderRequest({
    model: 'glm-5.2?reasoning=high',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    processEnv: {},
  })

  expect(request.requestedModel).toBe('glm-5.2?reasoning=high')
  expect(request.resolvedModel).toBe('glm-5.2')
  expect(request.reasoning).toEqual({ effort: 'high' })
})

test('resolveProviderRequest exposes model-query thinking defaults', () => {
  const request = resolveProviderRequest({
    model: 'glm-5.2?thinking=disabled',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    processEnv: {},
  })

  expect(request.resolvedModel).toBe('glm-5.2')
  expect(request.thinking).toEqual({ type: 'disabled' })
})

test('resolveProviderRequest forces LongCat onto chat completions', () => {
  const request = resolveProviderRequest({
    processEnv: {
      CLAUDE_CODE_USE_OPENAI: '1',
      LONGCAT_API_KEY: 'longcat-key',
      OPENAI_BASE_URL: 'https://api.longcat.chat/openai/v1',
      OPENAI_MODEL: 'LongCat-2.0',
      OPENAI_API_FORMAT: 'responses',
    },
  })

  expect(request.transport).toBe('chat_completions')
})

test('resolveProviderRequest maps explicit route catalog aliases to API model ids', () => {
  const request = resolveProviderRequest({
    model: 'glm-5.2?reasoning=high',
    baseUrl: 'https://api.atlascloud.ai/v1',
    processEnv: {},
  })

  expect(request.requestedModel).toBe('glm-5.2?reasoning=high')
  expect(request.resolvedModel).toBe('zai-org/glm-5.2')
  expect(request.reasoning).toEqual({ effort: 'high' })
})

test('resolveProviderRequest maps K3 context catalog choices to the Kimi API model', () => {
  for (const model of ['k3', 'k3-256k']) {
    const request = resolveProviderRequest({
      model,
      baseUrl: 'https://api.kimi.com/coding/v1',
      processEnv: {},
    })
    expect(request.resolvedModel).toBe('k3')
  }
})

test('resolveProviderRequest maps K3 context choices against an explicit Kimi base URL', () => {
  const request = resolveProviderRequest({
    model: 'k3-256k',
    baseUrl: 'https://api.kimi.com/coding/v1',
    processEnv: {
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
    },
  })

  expect(request.resolvedModel).toBe('k3')
})

test('resolveProviderRequest preserves K3 max reasoning from its model query', () => {
  const request = resolveProviderRequest({
    model: 'k3?reasoning=max',
    baseUrl: 'https://api.kimi.com/coding/v1',
    processEnv: {},
  })

  expect(request.requestedModel).toBe('k3?reasoning=max')
  expect(request.resolvedModel).toBe('k3')
  expect(request.reasoning).toEqual({ effort: 'max' })
})

test('resolveProviderRequest canonicalizes K3 model-query reasoning aliases', () => {
  for (const [effort, expected] of [['low', 'low'], ['medium', 'high'], ['high', 'high'], ['xhigh', 'max'], ['max', 'max']] as const) {
    const request = resolveProviderRequest({
      model: `k3-256k?reasoning=${effort}`,
      baseUrl: 'https://api.kimi.com/coding/v1',
      processEnv: {},
    })

    expect(request.resolvedModel).toBe('k3')
    expect(request.reasoning).toEqual({ effort: expected })
  }
})

test('resolveProviderRequest maps direct Moonshot K3 reasoning aliases', () => {
  for (const [effort, expected] of [['low', 'low'], ['medium', 'high'], ['high', 'high'], ['xhigh', 'max'], ['max', 'max']] as const) {
    const request = resolveProviderRequest({
      model: `kimi-k3?reasoning=${effort}`,
      baseUrl: 'https://api.moonshot.ai/v1',
      processEnv: {},
    })
    expect(request.resolvedModel).toBe('kimi-k3')
    expect(request.reasoning).toEqual({ effort: expected })
  }
})

test('resolveProviderRequest rejects max reasoning for models without K3 support', () => {
  const request = resolveProviderRequest({
    model: 'gpt-4o?reasoning=max',
    baseUrl: 'https://api.openai.com/v1',
    processEnv: {},
  })

  expect(request.reasoning).toBeUndefined()
})

test('resolveProviderRequest rejects K3 max reasoning outside a Kimi route', () => {
  const request = resolveProviderRequest({
    model: 'k3?reasoning=max',
    baseUrl: 'https://api.openai.com/v1',
    processEnv: {},
  })

  expect(request.reasoning).toBeUndefined()
})

test('resolveProviderRequest maps explicit Atlas coding aliases without ambiguity', () => {
  expect(resolveProviderRequest({
    model: 'claude-sonnet-4-6',
    baseUrl: 'https://api.atlascloud.ai/v1',
    processEnv: {},
  }).resolvedModel).toBe('anthropic/claude-sonnet-4.6')

  expect(resolveProviderRequest({
    model: 'claude-sonnet-4-6-coding',
    baseUrl: 'https://api.atlascloud.ai/v1',
    processEnv: {},
  }).resolvedModel).toBe('anthropic/claude-sonnet-4.6-coding')

  expect(resolveProviderRequest({
    model: 'deepseek-ai/deepseek-v3.2',
    baseUrl: 'https://api.atlascloud.ai/v1',
    processEnv: {},
  }).resolvedModel).toBe('deepseek-ai/deepseek-v3.2')
})

test('resolveProviderRequest leaves OpenRouter routing untouched without explicit aliases', () => {
  const request = resolveProviderRequest({
    model: 'gpt-5-mini',
    baseUrl: 'https://openrouter.ai/api/v1',
    processEnv: {},
  })

  expect(request.resolvedModel).toBe('gpt-5-mini')
  expect(request.baseUrl).toBe('https://openrouter.ai/api/v1')
})

test('resolveProviderRequest maps Hicap discovered GLM aliases to static model ids', () => {
  const request = resolveProviderRequest({
    model: 'zai-org/GLM-5.2',
    baseUrl: 'https://api.hicap.ai/v1',
    processEnv: {},
  })

  expect(request.requestedModel).toBe('zai-org/GLM-5.2')
  expect(request.resolvedModel).toBe('glm-5.2')
  expect(request.baseUrl).toBe('https://api.hicap.ai/v1')
})

test('resolveProviderRequest canonicalizes Hicap catalog model casing', () => {
  const request = resolveProviderRequest({
    model: 'GLM-5.2',
    baseUrl: 'https://api.hicap.ai/v1',
    processEnv: {},
  })

  expect(request.requestedModel).toBe('GLM-5.2')
  expect(request.resolvedModel).toBe('glm-5.2')
  expect(request.baseUrl).toBe('https://api.hicap.ai/v1')
})

test('resolveProviderRequest maps both Hicap Opus 4.7 names to the API model id', () => {
  for (const model of ['claude-opus-4-7', 'claude-opus-4.7']) {
    const request = resolveProviderRequest({
      model,
      baseUrl: 'https://api.hicap.ai/v1',
      processEnv: {},
    })

    expect(request.requestedModel).toBe(model)
    expect(request.resolvedModel).toBe('claude-opus-4.7')
    expect(request.baseUrl).toBe('https://api.hicap.ai/v1')
  }
})

test('resolveProviderRequest uses CLINE_API_MODEL when CLINE_API_KEY is present', () => {
  const request = resolveProviderRequest({
    processEnv: {
      CLINE_API_KEY: 'cp-key',
      CLINE_API_MODEL: 'cline-pass/qwen3.7-max',
    },
  })

  expect(request.requestedModel).toBe('cline-pass/qwen3.7-max')
  expect(request.baseUrl).toBe('https://api.cline.bot/api/v1')
})

test('resolveProviderRequest falls back to OPENAI_MODEL for ClinePass when CLINE_API_MODEL is unset', () => {
  const request = resolveProviderRequest({
    processEnv: {
      CLINE_API_KEY: 'cp-key',
      OPENAI_MODEL: 'cline-pass/deepseek-v4-flash',
    },
  })

  expect(request.requestedModel).toBe('cline-pass/deepseek-v4-flash')
  expect(request.baseUrl).toBe('https://api.cline.bot/api/v1')
})

test('resolveProviderRequest treats blank CLINE_API_MODEL as unset for ClinePass', () => {
  const request = resolveProviderRequest({
    processEnv: {
      CLINE_API_KEY: 'cp-key',
      CLINE_API_MODEL: '   ',
      OPENAI_MODEL: 'cline-pass/qwen3.7-max',
    },
  })

  expect(request.requestedModel).toBe('cline-pass/qwen3.7-max')
  expect(request.baseUrl).toBe('https://api.cline.bot/api/v1')
})

test('resolveProviderRequest uses the ClinePass route default when no model env is set', () => {
  const request = resolveProviderRequest({
    processEnv: {
      CLINE_API_KEY: 'cp-key',
    },
  })

  expect(request.requestedModel).toBe('cline-pass/deepseek-v4-flash')
  expect(request.baseUrl).toBe('https://api.cline.bot/api/v1')
})

test('resolveProviderRequest ignores CLINE_API_MODEL without CLINE_API_KEY', () => {
  const request = resolveProviderRequest({
    processEnv: {
      CLINE_API_MODEL: 'cline-pass/qwen3.7-max',
      OPENAI_API_KEY: 'openai-key',
      OPENAI_MODEL: 'gpt-4o',
    },
  })

  expect(request.requestedModel).toBe('gpt-4o')
  expect(request.baseUrl).toBe('https://api.openai.com/v1')
})

test('resolveProviderRequest ignores ClinePass model when GitHub mode is active', () => {
  const request = resolveProviderRequest({
    processEnv: {
      CLAUDE_CODE_USE_GITHUB: '1',
      CLINE_API_KEY: 'cp-key',
      CLINE_API_MODEL: 'cline-pass/qwen3.7-max',
    },
  })

  expect(request.requestedModel).toBe('github:copilot')
  expect(request.baseUrl).not.toContain('cline.bot')
})

test('resolveProviderRequest ignores ClinePass model when explicit OPENAI_BASE_URL points elsewhere', () => {
  const request = resolveProviderRequest({
    processEnv: {
      CLINE_API_KEY: 'cp-key',
      CLINE_API_MODEL: 'cline-pass/qwen3.7-max',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_MODEL: 'gpt-4o',
    },
  })

  expect(request.requestedModel).toBe('gpt-4o')
  expect(request.baseUrl).toBe('https://api.openai.com/v1')
})

test('resolveProviderRequest ignores ClinePass model when explicit baseUrl option points elsewhere', () => {
  const request = resolveProviderRequest({
    baseUrl: 'https://openrouter.ai/api/v1',
    processEnv: {
      CLINE_API_KEY: 'cp-key',
      CLINE_API_MODEL: 'cline-pass/qwen3.7-max',
    },
  })

  expect(request.requestedModel).toBe('codexplan')
  expect(request.baseUrl).toBe('https://openrouter.ai/api/v1')
})

test('resolveProviderRequest uses ClinePass model when no explicit base URL is set', () => {
  const request = resolveProviderRequest({
    processEnv: {
      CLINE_API_KEY: 'cp-key',
      CLINE_API_MODEL: 'cline-pass/qwen3.7-max',
    },
  })

  expect(request.requestedModel).toBe('cline-pass/qwen3.7-max')
  expect(request.baseUrl).toBe('https://api.cline.bot/api/v1')
})

test('resolveProviderRequest honors an explicit ClinePass endpoint over an ambient ApiSmart key', () => {
  const request = resolveProviderRequest({
    processEnv: {
      APISMART_API_KEY: 'apismart-key',
      CLINE_API_KEY: 'cp-key',
      CLINE_API_MODEL: 'cline-pass/qwen3.7-max',
      OPENAI_BASE_URL: 'https://api.cline.bot/api/v1',
    },
  })

  expect(request.requestedModel).toBe('cline-pass/qwen3.7-max')
  expect(request.baseUrl).toBe('https://api.cline.bot/api/v1')
})

test('resolveProviderRequest uses APISMART_MODEL when APISMART_API_KEY is present', () => {
  const request = resolveProviderRequest({
    processEnv: {
      APISMART_API_KEY: 'apismart-key',
      APISMART_MODEL: 'KIMI_K3',
    },
  })

  expect(request.requestedModel).toBe('KIMI_K3')
  expect(request.baseUrl).toBe('https://gw.apismart.ai/v1')
})

test('resolveProviderRequest falls back to OPENAI_MODEL for ApiSmart when APISMART_MODEL is unset', () => {
  const request = resolveProviderRequest({
    processEnv: {
      APISMART_API_KEY: 'apismart-key',
      OPENAI_MODEL: 'GLM_5.2',
    },
  })

  expect(request.requestedModel).toBe('GLM_5.2')
  expect(request.baseUrl).toBe('https://gw.apismart.ai/v1')
})

test('resolveProviderRequest treats blank APISMART_MODEL as unset for ApiSmart', () => {
  const request = resolveProviderRequest({
    processEnv: {
      APISMART_API_KEY: 'apismart-key',
      APISMART_MODEL: '   ',
      OPENAI_MODEL: 'QWEN_3_7_MAX',
    },
  })

  expect(request.requestedModel).toBe('QWEN_3_7_MAX')
  expect(request.baseUrl).toBe('https://gw.apismart.ai/v1')
})

test.each(['null', 'undefined', ' NULL '])(
  'resolveProviderRequest treats placeholder APISMART_MODEL %s as unset',
  APISMART_MODEL => {
    const request = resolveProviderRequest({
      processEnv: { APISMART_API_KEY: 'apismart-key', APISMART_MODEL },
    })
    expect(request.requestedModel).toBe('DEEPSEEK_V4_FLASH')
  },
)

test('resolveProviderRequest uses the ApiSmart route default when no model env is set', () => {
  const request = resolveProviderRequest({
    processEnv: {
      APISMART_API_KEY: 'apismart-key',
    },
  })

  expect(request.requestedModel).toBe('DEEPSEEK_V4_FLASH')
  expect(request.baseUrl).toBe('https://gw.apismart.ai/v1')
})

test('resolveProviderRequest ignores APISMART_MODEL without APISMART_API_KEY', () => {
  const request = resolveProviderRequest({
    processEnv: {
      APISMART_MODEL: 'KIMI_K3',
      OPENAI_API_KEY: 'openai-key',
      OPENAI_MODEL: 'gpt-4o',
    },
  })

  expect(request.requestedModel).toBe('gpt-4o')
  expect(request.baseUrl).toBe('https://api.openai.com/v1')
})

test('resolveProviderRequest ignores placeholder ApiSmart credentials', () => {
  const request = resolveProviderRequest({
    processEnv: {
      APISMART_API_KEY: 'SUA_CHAVE',
      APISMART_MODEL: 'KIMI_K3',
      OPENAI_API_KEY: 'openai-key',
      OPENAI_MODEL: 'gpt-4o',
    },
  })

  expect(request.requestedModel).toBe('gpt-4o')
  expect(request.baseUrl).toBe('https://api.openai.com/v1')
})

test('resolveProviderRequest prefers ApiSmart over ClinePass when both dedicated keys are set', () => {
  const request = resolveProviderRequest({
    processEnv: {
      APISMART_API_KEY: 'apismart-key',
      APISMART_MODEL: 'KIMI_K3',
      CLINE_API_KEY: 'cline-key',
      CLINE_API_MODEL: 'cline-pass/qwen3.7-max',
    },
  })

  expect(request.requestedModel).toBe('KIMI_K3')
  expect(request.baseUrl).toBe('https://gw.apismart.ai/v1')
})

test('resolveProviderRequest ignores ApiSmart model when explicit OPENAI_BASE_URL points elsewhere', () => {
  const request = resolveProviderRequest({
    processEnv: {
      APISMART_API_KEY: 'apismart-key',
      APISMART_MODEL: 'KIMI_K3',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_MODEL: 'gpt-4o',
    },
  })

  expect(request.requestedModel).toBe('gpt-4o')
  expect(request.baseUrl).toBe('https://api.openai.com/v1')
})

test('resolveProviderRequest resolves the GPT-5.6 family Codex aliases', () => {
  const sol = resolveProviderRequest({ model: 'gpt-5.6-sol', processEnv: {} })
  expect(sol.resolvedModel).toBe('gpt-5.6-sol')
  expect(sol.transport).toBe('codex_responses')
  expect(sol.reasoning).toEqual({ effort: 'high' })

  const terra = resolveProviderRequest({ model: 'gpt-5.6-terra', processEnv: {} })
  expect(terra.resolvedModel).toBe('gpt-5.6-terra')
  expect(terra.reasoning).toEqual({ effort: 'medium' })

  const luna = resolveProviderRequest({ model: 'gpt-5.6-luna', processEnv: {} })
  expect(luna.resolvedModel).toBe('gpt-5.6-luna')
  expect(luna.reasoning).toEqual({ effort: 'medium' })

  // Bare version resolves to the flagship tier, like the Codex CLI.
  const bare = resolveProviderRequest({ model: 'gpt-5.6', processEnv: {} })
  expect(bare.resolvedModel).toBe('gpt-5.6-sol')
  expect(bare.reasoning).toEqual({ effort: 'high' })
})

test('resolveProviderRequest keeps the implicit Codex fallback on Sol with high reasoning', () => {
  expect(resolveProviderRequest({ processEnv: {} })).toMatchObject({
    requestedModel: 'codexplan',
    resolvedModel: 'gpt-5.6-sol',
    transport: 'codex_responses',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    reasoning: { effort: 'high' },
  })
})

test('resolveProviderRequest honors reasoning query overrides on GPT-5.6 aliases', () => {
  const request = resolveProviderRequest({
    model: 'gpt-5.6-sol?reasoning=medium',
    processEnv: {},
  })
  expect(request.resolvedModel).toBe('gpt-5.6-sol')
  expect(request.reasoning).toEqual({ effort: 'medium' })
})

test('resolveProviderRequest scopes GPT-5.6 alias effort defaults to the Codex transport', () => {
  // On a custom OpenAI-compatible gateway (non-Codex transport) the alias
  // default must NOT leak (#1961's contract: gateways do not inherit
  // first-party effort metadata) — while an explicit ?reasoning= pick flows.
  const processEnv = {
    CLAUDE_CODE_USE_OPENAI: '1',
    OPENAI_BASE_URL: 'https://gateway.example/v1',
    OPENAI_API_KEY: 'test-key',
  }

  for (const model of ['gpt-5.6', 'gpt-5.6-sol']) {
    const plain = resolveProviderRequest({ model, processEnv })
    expect(plain.resolvedModel).toBe('gpt-5.6-sol')
    expect(plain.transport).not.toBe('codex_responses')
    expect(plain.reasoning).toBeUndefined()
  }

  const codexplan = resolveProviderRequest({ model: 'codexplan', processEnv })
  expect(codexplan.resolvedModel).toBe('gpt-5.6-sol')
  expect(codexplan.baseUrl).toBe('https://gateway.example/v1')
  expect(codexplan.transport).not.toBe('codex_responses')
  expect(codexplan.reasoning).toEqual({ effort: 'high' })

  const explicit = resolveProviderRequest({
    model: 'gpt-5.6-sol?reasoning=medium',
    processEnv,
  })
  expect(explicit.transport).not.toBe('codex_responses')
  expect(explicit.reasoning).toEqual({ effort: 'medium' })
})

test('resolveProviderRequest strips a trailing [1m] tag before alias mapping', () => {
  // The [1m] suffix is a client-side context opt-in, never a wire model id:
  // tagged forms must still resolve through the alias map (effort defaults
  // included) and never leak the bracket suffix into resolvedModel.
  const combined = resolveProviderRequest({
    model: 'gpt-5.6-sol?reasoning=medium[1m]',
    processEnv: {},
  })
  expect(combined.resolvedModel).toBe('gpt-5.6-sol')
  expect(combined.reasoning).toEqual({ effort: 'medium' })

  const tagged = resolveProviderRequest({ model: 'gpt-5.5[1m]', processEnv: {} })
  expect(tagged.resolvedModel).toBe('gpt-5.5')
  expect(tagged.reasoning).toEqual({ effort: 'high' })
})
