import { defineBrand } from '../define.js'

export default defineBrand({
  id: 'longcat',
  label: 'LongCat',
  canonicalVendorId: 'longcat',
  defaultCapabilities: {
    supportsStreaming: true,
    supportsFunctionCalling: false,
    supportsJsonMode: false,
    supportsReasoning: true,
    supportsPreciseTokenCount: false,
  },
  modelIds: ['LongCat-2.0'],
})
