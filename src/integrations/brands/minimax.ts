import { defineBrand } from '../define.js'

export default defineBrand({
  id: 'minimax',
  label: 'MiniMax',
  canonicalVendorId: 'minimax',
  defaultCapabilities: {
    supportsVision: true,
    supportsStreaming: true,
    supportsFunctionCalling: true,
    supportsJsonMode: true,
    supportsReasoning: true,
    supportsPreciseTokenCount: false,
  },
  modelIds: [
    'minimax-m3',
    'minimax-m2',
    'minimax-m2.1',
    'minimax-m2.1-highspeed',
    'minimax-m2.5',
    'minimax-m2.5-highspeed',
    'minimax-m2.7',
    'minimax-m2.7-highspeed',
    'minimax-text-01',
    'minimax-text-01-preview',
    'minimax-vision-01',
    'minimax-vision-01-fast',
  ],
})
