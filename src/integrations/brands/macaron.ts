import { defineBrand } from '../define.js'

export default defineBrand({
  id: 'macaron',
  label: 'Macaron',
  canonicalVendorId: 'openai',
  defaultCapabilities: {
    supportsVision: false,
    supportsStreaming: true,
    supportsFunctionCalling: true,
    supportsJsonMode: false,
    supportsReasoning: true,
    supportsPreciseTokenCount: false,
  },
  modelIds: ['mindai/macaron-v1-tall', 'mindai/macaron-v1-venti'],
})
