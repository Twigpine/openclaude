import { describe, expect, test } from 'bun:test'

import {
  checkVisionCapabilityForFile,
  findModelDescriptorForApiName,
  findModelDescriptorForApiNameWithRoute,
  isVisionSupported,
  VISION_NOT_SUPPORTED_ERROR_CODE,
} from './visionUtils.js'

describe('VISION_NOT_SUPPORTED_ERROR_CODE', () => {
  test('is a non-conflicting positive integer distinct from other Read error codes', () => {
    expect(VISION_NOT_SUPPORTED_ERROR_CODE).toBe(10)
  })
})

describe('findModelDescriptorForApiName', () => {
  test('returns undefined for empty / whitespace input', () => {
    expect(findModelDescriptorForApiName(undefined)).toBeUndefined()
    expect(findModelDescriptorForApiName('')).toBeUndefined()
    expect(findModelDescriptorForApiName('   ')).toBeUndefined()
  })

  test('returns the registered descriptor for an exact id match', () => {
    const descriptor = findModelDescriptorForApiName('mimo-v2.5-pro')
    expect(descriptor).toBeDefined()
    expect(descriptor?.id).toBe('mimo-v2.5-pro')
    expect(descriptor?.capabilities?.supportsVision).toBeFalsy()
  })

  test('returns the registered descriptor for a case-insensitive match', () => {
    const descriptor = findModelDescriptorForApiName('MIMO-V2.5-PRO')
    expect(descriptor?.id).toBe('mimo-v2.5-pro')
  })

  test('returns the registered descriptor for a prefix match', () => {
    const descriptor = findModelDescriptorForApiName('claude-sonnet-4-6')
    expect(descriptor).toBeDefined()
    expect(descriptor?.id).toContain('claude')
  })

  test('uses catalog mappings before prefix fallback', () => {
    const descriptor = findModelDescriptorForApiName('mimo-v2.5-free')
    expect(descriptor?.id).toBe('opencode-mimo-v2.5-free')
    expect(descriptor?.capabilities?.supportsVision).toBe(false)
  })

  test('uses route-specific catalog mappings before global model ids', () => {
    const descriptor = findModelDescriptorForApiNameWithRoute(
      'mimo-v2.5',
      'opencode-go',
    )
    expect(descriptor?.id).toBe('opencode-go-mimo-v2.5')
    expect(descriptor?.capabilities?.supportsVision).toBe(false)
  })

  test('uses route-specific catalog aliases before global model ids', () => {
    const descriptor = findModelDescriptorForApiNameWithRoute(
      'grok-code-fast-1',
      'xai',
    )
    expect(descriptor?.id).toBe('xai/grok-build-0.1')
    expect(descriptor?.capabilities?.supportsVision).toBe(false)
  })

  test('resolves gateway Grok 4.6 names to the shared descriptor', () => {
    expect(findModelDescriptorForApiName('grok-4.6')?.id).toBe('grok-4.6')
    expect(findModelDescriptorForApiName('x-ai/grok-4.6')?.id).toBe('grok-4.6')
    expect(findModelDescriptorForApiName('xai/grok-4.6')?.id).toBe('grok-4.6')
    expect(findModelDescriptorForApiName('grok-4.5')?.id).toBe('grok-4.5')
    expect(isVisionSupported('grok-4.6')).toBe(true)
    expect(isVisionSupported('x-ai/grok-4.6')).toBe(true)
  })

  test('does not resolve catalog aliases without a known route', () => {
    expect(findModelDescriptorForApiName('grok-code-fast-1-0825')).toBeUndefined()
  })

  test('resolves GLM-5.3-Flash vision metadata only through the direct Z.AI catalog', () => {
    const descriptor = findModelDescriptorForApiNameWithRoute(
      'glm-5.3-flash',
      'zai',
    )
    expect(descriptor).toMatchObject({
      id: 'glm-5.3-flash',
      runtimeMetadataScope: 'catalog',
      classification: ['chat', 'reasoning', 'vision', 'coding'],
      capabilities: { supportsVision: true },
    })
    expect(findModelDescriptorForApiName('glm-5.3-flash')).toBeUndefined()
    expect(
      findModelDescriptorForApiNameWithRoute('glm-5.3-flash', 'nvidia-nim'),
    ).toBeUndefined()
    expect(
      findModelDescriptorForApiNameWithRoute('glm-5.3-flash', 'openrouter'),
    ).toBeUndefined()
  })

  test('returns undefined for unknown models so callers fail open', () => {
    expect(findModelDescriptorForApiName('definitely-not-a-real-model-xyz')).toBeUndefined()
  })
})

describe('isVisionSupported', () => {
  test('returns false for a registered non-vision model (Xiaomi Mimo V2.5 Pro)', () => {
    expect(isVisionSupported('mimo-v2.5-pro')).toBe(false)
  })

  test('returns false for the Xiaomi Mimo V2 Flash variant', () => {
    expect(isVisionSupported('mimo-v2-flash')).toBe(false)
  })

  test('returns true for the registered vision variant (Xiaomi Mimo V2.5)', () => {
    expect(isVisionSupported('mimo-v2.5')).toBe(true)
  })

  test('does not let ambient OPENAI_BASE_URL change route-free checks', () => {
    const originalBaseUrl = process.env.OPENAI_BASE_URL
    process.env.OPENAI_BASE_URL = 'https://opencode.ai/zen/go/v1'
    try {
      expect(isVisionSupported('mimo-v2.5')).toBe(true)
    } finally {
      if (originalBaseUrl === undefined) {
        delete process.env.OPENAI_BASE_URL
      } else {
        process.env.OPENAI_BASE_URL = originalBaseUrl
      }
    }
  })

  test('returns false for non-vision catalog aliases that share a vision-model prefix', () => {
    expect(isVisionSupported('mimo-v2.5-free')).toBe(false)
  })

  test('returns false for route-specific catalog aliases that collide with global vision models', () => {
    expect(
      isVisionSupported('mimo-v2.5', {
        baseUrl: 'https://opencode.ai/zen/go/v1',
      }),
    ).toBe(false)
  })

  test('returns false for the text-only MiniMax M2.7 model on the MiniMax route', () => {
    expect(
      isVisionSupported('MiniMax-M2.7', {
        baseUrl: 'https://api.minimax.io/anthropic',
      }),
    ).toBe(false)
  })

  test('returns true for Claude models', () => {
    expect(isVisionSupported('claude-sonnet-4-6')).toBe(true)
  })

  test('returns true for Gemini models', () => {
    expect(isVisionSupported('gemini-2.5-pro')).toBe(true)
  })

  test('scopes GLM-5.3 text-only metadata to the direct Z.AI catalog', () => {
    expect(
      isVisionSupported('glm-5.3', {
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      }),
    ).toBe(false)
    expect(
      isVisionSupported('glm-5.3', {
        baseUrl: 'https://integrate.api.nvidia.com/v1',
      }),
    ).toBe(true)
    expect(
      isVisionSupported('glm-5.3', {
        baseUrl: 'https://proxy.example.test/v1',
      }),
    ).toBe(true)
  })

  test('allows GLM-5.3-Flash images on the direct Z.AI catalog route', () => {
    expect(
      isVisionSupported('glm-5.3-flash', {
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      }),
    ).toBe(true)
  })

  test('falls open for unknown models so custom / non-registered providers keep working', () => {
    expect(isVisionSupported('custom-vision-corp/secret-model-v1')).toBe(true)
    expect(isVisionSupported('not-a-real-model-xyz')).toBe(true)
  })
})

describe('checkVisionCapabilityForFile (issue #1421)', () => {
  test('refuses PNG read for a registered non-vision model with an actionable message', () => {
    const result = checkVisionCapabilityForFile(
      'C:\\temp\\openclaude\\tests\\fixtures\\screenshot.png',
      'mimo-v2.5-pro',
    )

    expect(result.result).toBe(false)
    if (result.result === false) {
      expect(result.message).toContain('mimo-v2.5-pro')
      expect(result.message).toContain('does not support image')
      expect(result.message).toContain('/model')
      expect(result.errorCode).toBe(VISION_NOT_SUPPORTED_ERROR_CODE)
    }
  })

  test('refuses JPG read for Xiaomi Mimo V2 Flash', () => {
    const result = checkVisionCapabilityForFile('C:\\foo\\bar.jpg', 'mimo-v2-flash')
    expect(result.result).toBe(false)
    if (result.result === false) {
      expect(result.errorCode).toBe(VISION_NOT_SUPPORTED_ERROR_CODE)
    }
  })

  test('refuses GIF / WebP reads for non-vision models', () => {
    expect(checkVisionCapabilityForFile('a.gif', 'mimo-v2.5-pro').result).toBe(false)
    expect(checkVisionCapabilityForFile('a.webp', 'mimo-v2.5-pro').result).toBe(false)
  })

  test('allows PNG read for a registered vision-capable model', () => {
    const result = checkVisionCapabilityForFile(
      'C:\\temp\\openclaude\\tests\\fixtures\\screenshot.png',
      'claude-sonnet-4-6',
    )
    expect(result.result).toBe(true)
  })

  test('refuses PNG read for a route-specific non-vision catalog model that collides with a global vision model', () => {
    const result = checkVisionCapabilityForFile(
      'C:\\foo\\bar.png',
      'mimo-v2.5',
      { baseUrl: 'https://opencode.ai/zen/go/v1' },
    )
    expect(result.result).toBe(false)
  })

  test('allows PNG read for unknown models (fail-open so non-registered providers keep working)', () => {
    const result = checkVisionCapabilityForFile(
      'C:\\foo\\bar.png',
      'my-custom-provider/vision-experimental',
    )
    expect(result.result).toBe(true)
  })

  test('only blocks GLM-5.3 image reads on the direct Z.AI route', () => {
    expect(
      checkVisionCapabilityForFile('x.png', 'glm-5.3', {
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      }).result,
    ).toBe(false)
    expect(
      checkVisionCapabilityForFile('x.png', 'glm-5.3', {
        baseUrl: 'https://integrate.api.nvidia.com/v1',
      }).result,
    ).toBe(true)
    expect(
      checkVisionCapabilityForFile('x.png', 'glm-5.3', {
        baseUrl: 'https://proxy.example.test/v1',
      }).result,
    ).toBe(true)
  })

  test('allows GLM-5.3-Flash PNG and JPEG reads on the direct Z.AI route', () => {
    for (const filePath of ['x.png', 'x.jpeg']) {
      expect(
        checkVisionCapabilityForFile(filePath, 'glm-5.3-flash', {
          baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        }).result,
      ).toBe(true)
    }
  })

  test('does not gate text-file reads on non-vision models', () => {
    const result = checkVisionCapabilityForFile('C:\\foo\\bar.txt', 'mimo-v2.5-pro')
    expect(result.result).toBe(true)
  })

  test('does not gate PDF reads (PDF has its own capability gate)', () => {
    const result = checkVisionCapabilityForFile('C:\\foo\\bar.pdf', 'mimo-v2.5-pro')
    expect(result.result).toBe(true)
  })

  test('handles uppercase image extensions', () => {
    expect(
      checkVisionCapabilityForFile('C:\\FOO\\BAR.PNG', 'mimo-v2.5-pro').result,
    ).toBe(false)
    expect(
      checkVisionCapabilityForFile('C:\\FOO\\BAR.PNG', 'claude-sonnet-4-6').result,
    ).toBe(true)
  })

  test('handles files without an extension', () => {
    expect(
      checkVisionCapabilityForFile('C:\\foo\\bar', 'mimo-v2.5-pro').result,
    ).toBe(true)
  })
})
