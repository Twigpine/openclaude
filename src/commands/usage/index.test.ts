import { describe, expect, test } from 'bun:test'

import {
  getUsageDescriptor,
  resolveActiveUsageId,
} from './index.js'
import type {
  GatewayDescriptor,
  VendorDescriptor,
} from '../../integrations/descriptors.js'

function createRegistry(options?: {
  vendors?: VendorDescriptor[]
  gateways?: GatewayDescriptor[]
}) {
  const vendors = new Map(
    (options?.vendors ?? []).map(vendor => [vendor.id, vendor] as const),
  )
  const gateways = new Map(
    (options?.gateways ?? []).map(gateway => [gateway.id, gateway] as const),
  )

  return {
    getVendor(id: string) {
      return vendors.get(id)
    },
    getGateway(id: string) {
      return gateways.get(id)
    },
  }
}

describe('getUsageDescriptor', () => {
  test('resolveActiveUsageId preserves first-party and codex compatibility ids', () => {
    expect(
      resolveActiveUsageId(
        {} as NodeJS.ProcessEnv,
        { providerCategory: 'firstParty' },
      ),
    ).toBe('firstParty')
    expect(
      resolveActiveUsageId(
        {} as NodeJS.ProcessEnv,
        { providerCategory: 'codex' },
      ),
    ).toBe('codex')
  })

  test('resolveActiveUsageId keeps the descriptor route for openai-compatible gateways', () => {
    expect(
      resolveActiveUsageId(
        {
          CLAUDE_CODE_USE_OPENAI: '1',
          OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
        } as NodeJS.ProcessEnv,
        { providerCategory: 'openai' },
      ),
    ).toBe('openrouter')
  })

  test('resolveActiveUsageId prefers explicit runtime URLs over a saved Z.AI profile URL', () => {
    const profile = {
      activeProfileProvider: 'zai',
      activeProfileBaseUrl: 'https://api.z.ai/api/coding/paas/v4',
      providerCategory: 'openai',
    }

    expect(
      resolveActiveUsageId(
        {
          CLAUDE_CODE_USE_OPENAI: '1',
          OPENAI_BASE_URL: 'https://api.z.ai/api/paas/v4',
        } as NodeJS.ProcessEnv,
        profile,
      ),
    ).toBe('custom')
    expect(
      resolveActiveUsageId(
        {
          CLAUDE_CODE_USE_OPENAI: '1',
          OPENAI_BASE_URL: 'https://proxy.example.test/v1',
        } as NodeJS.ProcessEnv,
        profile,
      ),
    ).toBe('custom')
    expect(
      resolveActiveUsageId(
        {
          CLAUDE_CODE_USE_OPENAI: '1',
          OPENAI_BASE_URL: profile.activeProfileBaseUrl,
        } as NodeJS.ProcessEnv,
        profile,
      ),
    ).toBe('zai')

    expect(
      resolveActiveUsageId(
        {
          CLAUDE_CODE_USE_OPENAI: '1',
          OPENAI_BASE_URL: 'https://proxy.example.test/v1',
        } as NodeJS.ProcessEnv,
        {
          activeProfileProvider: 'clinepass',
          activeProfileBaseUrl: 'https://api.cline.bot/api/v1',
          providerCategory: 'openai',
        },
      ),
    ).toBe('custom')
  })

  test('resolves first-party usage support through the Anthropic vendor descriptor', () => {
    const descriptor = getUsageDescriptor('firstParty')

    expect(descriptor.supported).toBe(true)
    expect(descriptor.activeLabel).toBe('Anthropic')
    expect(descriptor.resolvedId).toBe('anthropic')
    expect(descriptor.resolvedLabel).toBe('Anthropic')
  })

  test('returns neutral unsupported metadata for routes without usage support', () => {
    const descriptor = getUsageDescriptor('openrouter')

    expect(descriptor.supported).toBe(false)
    expect(descriptor.activeLabel).toBe('OpenRouter')
    expect(descriptor.resolvedId).toBe('openrouter')
    expect(descriptor.resolvedLabel).toBe('OpenRouter')
  })

  test('follows gateway usage delegation to the delegated vendor', () => {
    const anthropicVendor = {
      id: 'anthropic',
      label: 'Anthropic',
      classification: 'anthropic',
      defaultBaseUrl: 'https://api.anthropic.com',
      defaultModel: 'claude-sonnet-4-6',
      setup: {
        requiresAuth: true,
        authMode: 'api-key',
      },
      transportConfig: {
        kind: 'anthropic-native',
      },
      usage: { supported: true },
    } satisfies VendorDescriptor

    const gateway = {
      id: 'acme-gateway',
      label: 'Acme Gateway',
      setup: {
        requiresAuth: true,
        authMode: 'api-key',
      },
      transportConfig: {
        kind: 'openai-compatible',
      },
      usage: {
        supported: true,
        delegateToVendorId: 'anthropic',
      },
    } satisfies GatewayDescriptor

    const descriptor = getUsageDescriptor(
      'acme-gateway',
      createRegistry({
        vendors: [anthropicVendor],
        gateways: [gateway],
      }),
    )

    expect(descriptor.supported).toBe(true)
    expect(descriptor.activeLabel).toBe('Acme Gateway')
    expect(descriptor.resolvedId).toBe('anthropic')
    expect(descriptor.resolvedLabel).toBe('Anthropic')
  })
})
