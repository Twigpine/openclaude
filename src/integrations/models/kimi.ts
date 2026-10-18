import { defineModel } from '../define.js'

const kimiCapabilities = {
  supportsVision: true,
  supportsStreaming: true,
  supportsFunctionCalling: true,
  supportsJsonMode: true,
  supportsReasoning: true,
  supportsPreciseTokenCount: false,
}

function kimiModel(
  id: string,
  label: string,
  contextWindow: number,
  maxOutputTokens: number,
) {
  return defineModel({
    id,
    label,
    brandId: 'kimi',
    vendorId: 'moonshot',
    classification: ['chat', 'reasoning', 'vision', 'coding'],
    defaultModel: id,
    capabilities: kimiCapabilities,
    contextWindow,
    maxOutputTokens,
  })
}

export default [
  kimiModel('k3', 'Kimi K3', 1_048_576, 32_768),
  kimiModel('kimi-for-coding', 'Kimi for Coding', 262_144, 32_768),
  kimiModel('kimi-k2.7-code', 'Kimi K2.7 Code', 262_144, 262_144),
  kimiModel('kimi-k2.6', 'Kimi K2.6', 262_144, 32_768),
  kimiModel('kimi-k2.5', 'Kimi K2.5', 262_144, 32_768),
  kimiModel('kimi-k2-thinking', 'Kimi K2 Thinking', 262_144, 32_768),
  kimiModel('kimi-k2-instruct', 'Kimi K2 Instruct', 131_072, 32_768),
  kimiModel('kimi-k2', 'Kimi K2', 131_072, 32_768),
  kimiModel('moonshot-v1-128k', 'Moonshot v1 128K', 131_072, 32_768),
  kimiModel('moonshot-v1-32k', 'Moonshot v1 32K', 32_768, 16_384),
  kimiModel('moonshot-v1-8k', 'Moonshot v1 8K', 8_192, 4_096),
]
