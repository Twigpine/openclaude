import { describe, expect, test } from 'bun:test'

import './index.js'
import {
  getGateway,
  getModelsForGateway,
  getVendor,
  ORDERED_PROVIDER_PRESETS,
} from './index.js'
import {
  PRESET_VENDOR_MAP,
  gatewayIdForPreset,
  routeForPreset,
  vendorIdForPreset,
} from './compatibility.js'
import { resolveProfileRoute } from './profileResolver.js'
import type { ProviderPreset } from '../utils/providerProfiles.js'

const EXPECTED_PRESETS = [
  'anthropic',
  'atlas-cloud',
  'apismart',
  'aimlapi',
  'openai',
  'ollama',
  'kimi-code',
  'moonshotai',
  'deepseek',
  'gemini',
  'mistral',
  'together',
  'groq',
  'hicap',
  'azure-openai',
  'openrouter',
  'lmstudio',
  'dashscope-cn',
  'dashscope-intl',
  'custom',
  'custom-anthropic',
  'nvidia-nim',
  'minimax',
  'xai',
  'venice',
  'xiaomi-mimo',
  'xiaomi-mimo-token',
  'zai',
  'bankr',
  'atomic-chat',
  'cloudflare',
  'gitlawb-opengateway',
  'concentrate',
  'nearai',
  'fireworks',
  'longcat',
  'llmtr',
  'commandcode',
  'requesty',
  'opencode',
  'opencode-go',
  'clinepass',
  'api-route',
] as const satisfies readonly ProviderPreset[]

describe('compatibility mappings', () => {
  test('cover every current provider preset exactly once', () => {
    expect(PRESET_VENDOR_MAP.map(mapping => mapping.preset).sort()).toEqual(
      [...EXPECTED_PRESETS].sort(),
    )
    expect(new Set(PRESET_VENDOR_MAP.map(mapping => mapping.preset)).size).toBe(
      EXPECTED_PRESETS.length,
    )
  })

  test('every preset resolves to an existing vendor and optional gateway', () => {
    for (const preset of EXPECTED_PRESETS) {
      const vendorId = vendorIdForPreset(preset)
      const gatewayId = gatewayIdForPreset(preset)
      const route = routeForPreset(preset)

      expect(getVendor(vendorId)?.id).toBe(vendorId)
      if (gatewayId) {
        expect(getGateway(gatewayId)?.id).toBe(gatewayId)
      }

      expect(route.vendorId).toBe(vendorId)
      expect(route.gatewayId).toBe(gatewayId)
      expect(route.routeId).toBe(
        preset === 'custom-anthropic' ? 'custom-anthropic' : gatewayId ?? vendorId,
      )
    }
  })

  test('Atlas Cloud is modeled as a gateway while preserving the atlas-cloud preset', () => {
    expect(getVendor('atlas-cloud')).toBeUndefined()
    expect(getGateway('atlas-cloud')?.id).toBe('atlas-cloud')
    expect(routeForPreset('atlas-cloud')).toEqual({
      vendorId: 'openai',
      gatewayId: 'atlas-cloud',
      routeId: 'atlas-cloud',
    })
    expect(resolveProfileRoute('atlas-cloud')).toEqual({
      vendorId: 'openai',
      gatewayId: 'atlas-cloud',
      routeId: 'atlas-cloud',
    })
  })

  test('Custom Anthropic is modeled as an Anthropic proxy', () => {
    expect(routeForPreset('custom-anthropic')).toEqual({
      vendorId: 'anthropic',
      routeId: 'custom-anthropic',
    })
    expect(resolveProfileRoute('custom-anthropic')).toEqual({
      vendorId: 'anthropic',
      routeId: 'custom-anthropic',
    })
  })

  test('keeps custom provider presets at the bottom of the add-provider list', () => {
    expect(ORDERED_PROVIDER_PRESETS.slice(-2)).toEqual([
      'custom',
      'custom-anthropic',
    ])
  })

  test('Atlas Cloud gateway models do not resolve to NearAI-scoped descriptors', () => {
    const atlasModels = getModelsForGateway('atlas-cloud')
    expect(atlasModels.length).toBeGreaterThan(0)
    expect(
      atlasModels.filter(model => model.vendorId === 'nearai'),
    ).toEqual([])
  })
  test('native gateway profile routes use their descriptor vendor', () => {
    expect(resolveProfileRoute('bedrock')).toEqual({
      vendorId: 'anthropic',
      gatewayId: 'bedrock',
      routeId: 'bedrock',
    })
    expect(resolveProfileRoute('vertex')).toEqual({
      vendorId: 'anthropic',
      gatewayId: 'vertex',
      routeId: 'vertex',
    })
  })
})
