import { defineModel } from '../define.js'

export default [
  defineModel({
    id: 'LongCat-2.0',
    label: 'LongCat-2.0',
    brandId: 'longcat',
    vendorId: 'longcat',
    classification: ['chat', 'reasoning', 'coding'],
    defaultModel: 'LongCat-2.0',
    capabilities: {
      supportsStreaming: true,
      supportsFunctionCalling: false,
      supportsJsonMode: false,
      supportsReasoning: true,
      supportsPreciseTokenCount: false,
    },
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
  }),
]
