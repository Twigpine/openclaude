import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSettingsJSONSchema } from './schemaOutput.js'
import { parseSettingsFile } from './settings.js'
import { SettingsSchema } from './types.js'

const completePrice = {
  inputTokens: 1,
  outputTokens: 2,
  promptCacheReadTokens: 0.1,
  promptCacheWriteTokens: 2.5,
}

test('modelPricing accepts explicit zero and defaults web-search pricing later', () => {
  const result = SettingsSchema().safeParse({
    modelPricing: {
      'nvidia/free-model': {
        inputTokens: 0,
        outputTokens: 0,
        promptCacheReadTokens: 0,
        promptCacheWriteTokens: 0,
        webSearchRequests: 0,
      },
      'provider/paid:model?variant=1': completePrice,
    },
  })

  expect(result.success).toBe(true)
  if (result.success) {
    expect(result.data.modelPricing).toEqual({
      'nvidia/free-model': {
        inputTokens: 0,
        outputTokens: 0,
        promptCacheReadTokens: 0,
        promptCacheWriteTokens: 0,
        webSearchRequests: 0,
      },
      'provider/paid:model?variant=1': completePrice,
    })
  }
})

test('invalid modelPricing is dropped without invalidating unrelated settings', () => {
  const tooManyEntries = Object.fromEntries(
    Array.from({ length: 257 }, (_, i) => [`model-${i}`, completePrice]),
  )
  const invalidValues: unknown[] = [
    'not-an-object',
    { model: 'not-an-entry-object' },
    { model: { ...completePrice, unknownField: 1 } },
    { model: { ...completePrice, inputTokens: -1 } },
    { model: { ...completePrice, outputTokens: Number.POSITIVE_INFINITY } },
    { model: { ...completePrice, outputTokens: Number.NaN } },
    { model: { ...completePrice, inputTokens: 100_001 } },
    { model: { ...completePrice, webSearchRequests: 1_001 } },
    { model: { inputTokens: 1, outputTokens: 2 } },
    { '': completePrice },
    { ['x'.repeat(513)]: completePrice },
    tooManyEntries,
  ]

  for (const modelPricing of invalidValues) {
    const result = SettingsSchema().safeParse({
      model: 'sonnet',
      modelPricing,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.model).toBe('sonnet')
      expect(result.data.modelPricing).toBeUndefined()
    }
  }
})

test('parseSettingsFile reports the raw modelPricing value that it drops', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'model-pricing-diagnostic-'))
  const settingsPath = join(fixtureDir, 'settings.json')
  const modelPricing = {
    model: { ...completePrice, inputTokens: -1 },
  }
  writeFileSync(
    settingsPath,
    JSON.stringify({ model: 'sonnet', modelPricing }),
    'utf8',
  )

  try {
    const result = parseSettingsFile(settingsPath)

    expect(result.settings?.model).toBe('sonnet')
    expect(result.settings?.modelPricing).toBeUndefined()
    expect(result.errors).toEqual([
      {
        file: settingsPath,
        path: 'modelPricing',
        message: 'Invalid modelPricing value was ignored',
        expected: undefined,
        invalidValue: modelPricing,
        suggestion: undefined,
        docLink: undefined,
      },
    ])
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true })
  }
})

test('generated settings schema preserves modelPricing constraints', () => {
  const schema = JSON.parse(generateSettingsJSONSchema()) as {
    properties: {
      modelPricing: {
        additionalProperties: {
          properties: Record<string, unknown>
          required: string[]
        }
        maxProperties: number
        propertyNames: { type: string; maxLength: number; minLength: number }
      }
    }
  }
  const pricing = schema.properties.modelPricing

  expect(pricing.maxProperties).toBe(256)
  expect(pricing.propertyNames).toEqual({
    type: 'string',
    minLength: 1,
    maxLength: 512,
  })
  expect(pricing.additionalProperties.required).toEqual([
    'inputTokens',
    'outputTokens',
    'promptCacheReadTokens',
    'promptCacheWriteTokens',
  ])
  expect(pricing.additionalProperties.properties).toHaveProperty(
    'webSearchRequests',
  )
})
