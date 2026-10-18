import { describe, expect, test } from 'bun:test'

import apismart from './apismart.js'

const mapModel = apismart.catalog?.discovery?.mapModel

describe('apismart gateway', () => {
  test('uses hybrid discovery with dedicated credentials', () => {
    expect(apismart.id).toBe('apismart')
    expect(apismart.catalog?.source).toBe('hybrid')
    expect(apismart.catalog?.discovery?.kind).toBe('openai-compatible')
    expect(apismart.catalog?.discovery?.requiresAuth).toBe(true)
    expect(apismart.setup.dedicatedCredentialsOnly).toBe(true)
    expect(apismart.setup.credentialEnvVars).toEqual(['APISMART_API_KEY'])
    expect(apismart.defaultBaseUrl).toBe('https://gw.apismart.ai/v1')
    expect(apismart.defaultModel).toBe('DEEPSEEK_V4_FLASH')
    expect(mapModel).toBeDefined()
  })

  test('curated catalog keeps ApiSmart case-sensitive model ids', () => {
    const models = apismart.catalog?.models ?? []
    expect(models.some(model => model.apiName === 'DEEPSEEK_V4_FLASH')).toBe(
      true,
    )
    expect(models.some(model => model.apiName === 'GLM_5.2')).toBe(true)
    expect(models.some(model => model.apiName === 'QWEN_3_7_MAX')).toBe(true)
  })

  test('mapModel keeps chat models and drops image/video ids', () => {
    if (!mapModel) throw new Error('mapModel missing')
    expect(mapModel({ id: 'DEEPSEEK_V4_FLASH', owned_by: 'DeepSeek' })).toEqual(
      {
        id: 'DEEPSEEK_V4_FLASH',
        apiName: 'DEEPSEEK_V4_FLASH',
        label: 'DEEPSEEK_V4_FLASH (DeepSeek)',
      },
    )
    expect(mapModel({ id: 'seedream-5.0' })).toBeNull()
    expect(mapModel({ id: 'seedance-2.0' })).toBeNull()
    expect(mapModel({ id: 'happyhorse-1.0' })).toBeNull()
    expect(mapModel({})).toBeNull()
    expect(mapModel(null)).toBeNull()
  })
})
