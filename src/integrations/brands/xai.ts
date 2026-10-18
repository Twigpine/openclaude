import { defineBrand } from '../define.js'

export default defineBrand({
  id: 'xai',
  label: 'xAI',
  canonicalVendorId: 'xai',
  defaultCapabilities: {
    supportsVision: true,
    supportsStreaming: true,
    supportsFunctionCalling: true,
    supportsJsonMode: true,
    supportsReasoning: true,
    supportsPreciseTokenCount: false,
  },
  modelIds: [
    'grok-4.6',
    'grok-4.5',
    'grok-4.3',
    'xai/grok-build-0.1',
    'grok-4.20-0309-reasoning',
    'grok-4.20-0309-non-reasoning',
  ],
})
