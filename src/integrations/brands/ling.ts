import { defineBrand } from '../define.js'

export default defineBrand({
  id: 'ling',
  label: 'Ling',
  canonicalVendorId: 'openai',
  defaultCapabilities: {
    supportsVision: false,
    supportsStreaming: true,
    supportsFunctionCalling: true,
    supportsJsonMode: false,
    supportsReasoning: true,
    supportsPreciseTokenCount: false,
  },
  modelIds: ['inclusionai/ling-3.0-flash', 'inclusionai/ling-3.0-tiny:free'],
})
