import { defineModel } from '../define.js'

const qwenCapabilities = {
  supportsVision: true,
  supportsStreaming: true,
  supportsFunctionCalling: true,
  supportsJsonMode: true,
  supportsReasoning: true,
  supportsPreciseTokenCount: false,
}

function qwenModel(
  id: string,
  label: string,
  contextWindow: number,
  maxOutputTokens: number,
) {
  return defineModel({
    id,
    label,
    brandId: 'qwen',
    vendorId: 'openai',
    classification: ['chat', 'reasoning', 'vision', 'coding'],
    defaultModel: id,
    capabilities: qwenCapabilities,
    contextWindow,
    maxOutputTokens,
  })
}

function qwenTextModel(
  id: string,
  label: string,
  contextWindow: number,
  maxOutputTokens: number,
) {
  return defineModel({
    id,
    label,
    brandId: 'qwen',
    vendorId: 'openai',
    classification: ['chat', 'reasoning', 'coding'],
    defaultModel: id,
    capabilities: {
      ...qwenCapabilities,
      supportsVision: false,
    },
    contextWindow,
    maxOutputTokens,
  })
}

function qwenInstructModel(
  id: string,
  label: string,
  contextWindow: number,
  maxOutputTokens: number,
  supportsVision = true,
) {
  return defineModel({
    id,
    label,
    brandId: 'qwen',
    vendorId: 'openai',
    classification: supportsVision ? ['chat', 'vision', 'coding'] : ['chat', 'coding'],
    defaultModel: id,
    capabilities: {
      ...qwenCapabilities,
      supportsVision,
      supportsReasoning: false,
    },
    contextWindow,
    maxOutputTokens,
  })
}
export default [
  qwenTextModel('qwen3.7-plus', 'Qwen 3.7 Plus', 1_000_000, 67_072),
  qwenModel('qwen/qwen3.6-35b-a3b', 'Qwen 3.6 35B A3B', 262_144, 65_536),
  qwenModel('qwen/qwen3.5-397b-a17b', 'Qwen 3.5 397B A17B', 262_144, 65_536),
  qwenModel('qwen/qwen3.5-122b-a10b', 'Qwen 3.5 122B A10B', 262_144, 65_536),
  qwenModel('qwen/qwen3.5-35b-a3b', 'Qwen 3.5 35B A3B', 262_144, 65_536),
  qwenModel('qwen/qwen3.5-27b', 'Qwen 3.5 27B', 262_144, 65_536),
  qwenModel('qwen/qwen3-vl-30b-a3b-thinking', 'Qwen 3 VL 30B A3B Thinking', 128_000, 32_000),
  qwenInstructModel('qwen/qwen3-vl-30b-a3b-instruct', 'Qwen 3 VL 30B A3B Instruct', 128_000, 32_000),
  qwenInstructModel('qwen/qwen3-vl-8b-instruct', 'Qwen 3 VL 8B Instruct', 128_000, 32_000),
  qwenInstructModel('Qwen/Qwen3-VL-235B-A22B-Instruct', 'Qwen 3 VL 235B A22B Instruct', 131_072, 32_768),
  qwenTextModel('Qwen/Qwen3-Next-80B-A3B-Thinking', 'Qwen 3 Next 80B A3B Thinking', 262_144, 32_768),
  qwenInstructModel('Qwen/Qwen3-Next-80B-A3B-Instruct', 'Qwen 3 Next 80B A3B Instruct', 262_144, 131_072, false),
  qwenInstructModel('qwen3-30b-a3b-instruct-2507', 'Qwen 3 30B A3B Instruct 2507', 131_072, 131_072, false),
  qwenModel('qwen3.6-plus', 'Qwen 3.6 Plus', 1_000_000, 65_536),
  qwenModel('qwen3.5-plus', 'Qwen 3.5 Plus', 1_000_000, 65_536),
  qwenModel('qwen3-coder-plus', 'Qwen 3 Coder Plus', 1_000_000, 65_536),
  qwenModel('qwen3-coder-next', 'Qwen 3 Coder Next', 262_144, 65_536),
  qwenModel('qwen3-max', 'Qwen 3 Max', 262_144, 32_768),
  qwenModel('Qwen/Qwen3.5-9B', 'Qwen 3.5 9B', 128_000, 32_768),
  // Limits as served by GMI Cloud's /v1/models (context); output is a
  // conservative cap since GMI does not publish one.
  qwenTextModel('qwen3.8-max', 'Qwen 3.8 Max', 262_144, 65_536),
  qwenTextModel('qwen3.8-flash', 'Qwen 3.8 Flash', 1_048_575, 65_536),
  // Text-only (no vision per the OpenRouter catalog), so it skips the
  // qwenModel helper's vision defaults.
  defineModel({
    id: 'qwen3.7-max',
    label: 'Qwen 3.7 Max',
    brandId: 'qwen',
    vendorId: 'openai',
    classification: ['chat', 'reasoning', 'coding'],
    defaultModel: 'qwen3.7-max',
    capabilities: {
      ...qwenCapabilities,
      supportsVision: false,
    },
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
  }),
]
