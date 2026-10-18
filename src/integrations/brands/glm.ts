import { defineBrand } from '../define.js'

export default defineBrand({
  id: 'glm',
  label: 'GLM',
  canonicalVendorId: 'zai',
  defaultCapabilities: {
    supportsVision: false,
    supportsStreaming: true,
    supportsFunctionCalling: true,
    supportsJsonMode: true,
    supportsReasoning: true,
    supportsPreciseTokenCount: false,
  },
  modelIds: [
    'glm-5.3-flash',
    'glm-5.3',
    'glm-5.2',
    'GLM-5.1',
    'GLM-5-Turbo',
    'GLM-5',
    'GLM-4.7',
    'GLM-4.5-Air',
    'glm-5.1',
    'glm-5-turbo',
    'glm-5',
    'glm-4.7',
    'glm-4.5-air',
  ],
})
