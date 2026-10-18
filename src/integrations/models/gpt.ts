import { defineModel } from '../define.js'

const gptCapabilities = {
  supportsVision: true,
  supportsStreaming: true,
  supportsFunctionCalling: true,
  supportsJsonMode: true,
  supportsReasoning: false,
  supportsPreciseTokenCount: true,
}

function gptModel(
  id: string,
  label: string,
  contextWindow: number,
  maxOutputTokens: number,
) {
  return defineModel({
    id,
    label,
    brandId: 'gpt',
    vendorId: 'openai',
    classification: ['chat', 'vision', 'coding'],
    defaultModel: id,
    capabilities: gptCapabilities,
    contextWindow,
    maxOutputTokens,
  })
}

export default [
  // gpt-5.6 (sol/terra/luna) reject /v1/chat/completions when function tools
  // are combined with reasoning_effort — they must use /v1/responses. The
  // openai-vendor catalog carries their reasoning metadata; the responses
  // routing is handled by modelRequiresResponsesApi in providerConfig.
  // Context: same conservative Codex 272k input cap as gpt-5.5 below (see
  // that comment), despite the 1.05M API descriptor value.
  gptModel('gpt-5.6-sol', 'GPT-5.6 Sol', 272_000, 128_000),
  gptModel('gpt-5.6-terra', 'GPT-5.6 Terra', 272_000, 128_000),
  gptModel('gpt-5.6-luna', 'GPT-5.6 Luna', 272_000, 128_000),
  // gpt-5.5 via Codex transport caps at ~272k effective input tokens; the
  // 1.05M API descriptor value caused /context to under-report usage and
  // auto-compact to fire too late, yielding 500 "input exceeds the context
  // window" mid-turn (issue #1118). Use the conservative Codex limit so
  // compaction kicks in before the request fails.
  gptModel('gpt-5.5', 'GPT-5.5', 272_000, 128_000),
  gptModel('gpt-5.5-mini', 'GPT-5.5 Mini', 400_000, 128_000),
  gptModel('gpt-5.5-nano', 'GPT-5.5 Nano', 400_000, 128_000),
  gptModel('gpt-5.4', 'GPT-5.4', 1_050_000, 128_000),
  gptModel('gpt-5.4-mini', 'GPT-5.4 Mini', 400_000, 128_000),
  gptModel('gpt-5.4-nano', 'GPT-5.4 Nano', 400_000, 128_000),
  gptModel('gpt-5-mini', 'GPT-5 Mini', 400_000, 64_000),
  gptModel('gpt-4.1', 'GPT-4.1', 1_047_576, 32_768),
  gptModel('gpt-4.1-mini', 'GPT-4.1 Mini', 1_047_576, 32_768),
  gptModel('gpt-4.1-nano', 'GPT-4.1 Nano', 1_047_576, 32_768),
  gptModel('gpt-4o', 'GPT-4o', 128_000, 16_384),
  gptModel('gpt-4o-mini', 'GPT-4o Mini', 128_000, 16_384),
  gptModel('gpt-4-turbo', 'GPT-4 Turbo', 128_000, 4_096),
  gptModel('gpt-4', 'GPT-4', 8_192, 4_096),
  gptModel('o1-preview', 'o1 Preview', 128_000, 32_768),
  gptModel('o1-mini', 'o1 Mini', 128_000, 65_536),
  gptModel('o1-pro', 'o1 Pro', 200_000, 100_000),
  gptModel('o1', 'o1', 200_000, 100_000),
  gptModel('o3-mini', 'o3 Mini', 200_000, 100_000),
  gptModel('o3', 'o3', 200_000, 100_000),
  gptModel('o4-mini', 'o4 Mini', 200_000, 100_000),
]
