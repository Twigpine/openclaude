import { defineBrand } from '../define.js'

export default defineBrand({
  id: 'nemotron',
  label: 'Nemotron',
  canonicalVendorId: 'openai',
  defaultCapabilities: {
    supportsVision: false,
    supportsStreaming: true,
    supportsFunctionCalling: true,
    supportsJsonMode: true,
    supportsReasoning: false,
    supportsPreciseTokenCount: false,
  },
  modelIds: [
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'nvidia/nemotron-3-ultra-550b-a55b',
    'nvidia/llama-3.1-nemotron-70b-instruct',
  ],
})
