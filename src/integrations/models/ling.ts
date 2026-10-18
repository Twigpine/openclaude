import { defineModel } from '../define.js'

export default [
  defineModel({
    id: 'inclusionai/ling-3.0-flash',
    label: 'Ling 3.0 Flash',
    brandId: 'ling',
    vendorId: 'openai',
    classification: ['chat', 'reasoning', 'coding'],
    defaultModel: 'inclusionai/ling-3.0-flash',
    capabilities: {
      supportsVision: false,
      supportsStreaming: true,
      supportsFunctionCalling: true,
      supportsJsonMode: false,
      supportsReasoning: true,
      supportsPreciseTokenCount: false,
    },
    contextWindow: 262_144,
    maxOutputTokens: 32_768,
  }),
  defineModel({
    id: 'inclusionai/ling-3.0-tiny:free',
    label: 'Ling 3.0 Tiny (free)',
    brandId: 'ling',
    vendorId: 'openai',
    classification: ['chat', 'reasoning', 'coding'],
    defaultModel: 'inclusionai/ling-3.0-tiny:free',
    capabilities: {
      supportsVision: false,
      supportsStreaming: true,
      supportsFunctionCalling: true,
      supportsJsonMode: false,
      supportsReasoning: true,
      supportsPreciseTokenCount: false,
    },
    contextWindow: 262_144,
    maxOutputTokens: 32_768,
  }),
]
