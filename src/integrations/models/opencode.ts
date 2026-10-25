import { defineModel } from '../define.js'

const baseCapabilities = {
  supportsStreaming: true,
  supportsFunctionCalling: true,
  supportsJsonMode: true,
  supportsPreciseTokenCount: false,
}

type OpenCodeModelSpec = {
  id: string
  label: string
  defaultModel: string
  contextWindow?: number
  maxOutputTokens?: number
  reasoning?: boolean
  vision?: boolean
  coding?: boolean
}

function openCodeModel(spec: OpenCodeModelSpec) {
  return defineModel({
    id: spec.id,
    label: spec.label,
    vendorId: 'openai',
    classification: [
      'chat',
      ...(spec.reasoning ? ['reasoning' as const] : []),
      ...(spec.vision ? ['vision' as const] : []),
      ...(spec.coding ? ['coding' as const] : []),
    ],
    defaultModel: spec.defaultModel,
    providerModelMap: {
      [spec.id.startsWith('opencode-go-') ? 'opencode-go' : 'opencode']:
        spec.defaultModel,
    },
    capabilities: {
      ...baseCapabilities,
      supportsVision: spec.vision === true,
      supportsReasoning: spec.reasoning === true,
    },
    contextWindow: spec.contextWindow,
    maxOutputTokens: spec.maxOutputTokens,
  })
}

const zenModels: OpenCodeModelSpec[] = [
  // Zen publishes no token limits. Historical descriptors do not imply availability.
  { id: 'opencode-minimax-m3.1-flash-free', label: 'MiniMax M3.1 Flash Free', defaultModel: 'minimax-m3.1-flash-free', reasoning: true, coding: true },
  { id: 'opencode-minimax-m3', label: 'MiniMax M3', defaultModel: 'minimax-m3', reasoning: true, coding: true },
  { id: 'opencode-claude-fable-5', label: 'Claude Fable 5', defaultModel: 'claude-fable-5', contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true, vision: true },
  { id: 'opencode-claude-opus-4-8', label: 'Claude Opus 4.8', defaultModel: 'claude-opus-4-8', contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true, vision: true },
  { id: 'opencode-claude-opus-4-7', label: 'Claude Opus 4.7', defaultModel: 'claude-opus-4-7', contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true, vision: true },
  { id: 'opencode-claude-opus-4-6', label: 'Claude Opus 4.6', defaultModel: 'claude-opus-4-6', contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true, vision: true },
  { id: 'opencode-claude-opus-4-5', label: 'Claude Opus 4.5', defaultModel: 'claude-opus-4-5', contextWindow: 200_000, maxOutputTokens: 64_000, reasoning: true, vision: true },
  { id: 'opencode-claude-opus-4-1', label: 'Claude Opus 4.1', defaultModel: 'claude-opus-4-1', contextWindow: 200_000, maxOutputTokens: 32_000, reasoning: true, vision: true },
  { id: 'opencode-claude-sonnet-4-6', label: 'Claude Sonnet 4.6', defaultModel: 'claude-sonnet-4-6', contextWindow: 1_000_000, maxOutputTokens: 64_000, reasoning: true, vision: true },
  { id: 'opencode-claude-sonnet-4-5', label: 'Claude Sonnet 4.5', defaultModel: 'claude-sonnet-4-5', contextWindow: 1_000_000, maxOutputTokens: 64_000, reasoning: true, vision: true },
  { id: 'opencode-claude-sonnet-4', label: 'Claude Sonnet 4', defaultModel: 'claude-sonnet-4', contextWindow: 1_000_000, maxOutputTokens: 64_000, reasoning: true, vision: true },
  { id: 'opencode-claude-haiku-4-5', label: 'Claude Haiku 4.5', defaultModel: 'claude-haiku-4-5', contextWindow: 200_000, maxOutputTokens: 64_000, vision: true },
  { id: 'opencode-gemini-3.5-flash', label: 'Gemini 3.5 Flash', defaultModel: 'gemini-3.5-flash', contextWindow: 1_048_576, maxOutputTokens: 65_536, vision: true },
  { id: 'opencode-gemini-3.1-pro', label: 'Gemini 3.1 Pro', defaultModel: 'gemini-3.1-pro', contextWindow: 1_048_576, maxOutputTokens: 65_536, reasoning: true, vision: true },
  { id: 'opencode-gemini-3-flash', label: 'Gemini 3 Flash', defaultModel: 'gemini-3-flash', contextWindow: 1_048_576, maxOutputTokens: 65_536, vision: true },
  { id: 'opencode-gpt-5.5', label: 'GPT 5.5', defaultModel: 'gpt-5.5', contextWindow: 1_050_000, maxOutputTokens: 128_000, reasoning: true, vision: true },
  { id: 'opencode-gpt-5.5-pro', label: 'GPT 5.5 Pro', defaultModel: 'gpt-5.5-pro', contextWindow: 1_050_000, maxOutputTokens: 128_000, reasoning: true, vision: true },
  { id: 'opencode-gpt-5.4', label: 'GPT 5.4', defaultModel: 'gpt-5.4', contextWindow: 1_050_000, maxOutputTokens: 128_000, reasoning: true, vision: true },
  { id: 'opencode-gpt-5.4-pro', label: 'GPT 5.4 Pro', defaultModel: 'gpt-5.4-pro', contextWindow: 1_050_000, maxOutputTokens: 128_000, reasoning: true, vision: true },
  { id: 'opencode-gpt-5.4-mini', label: 'GPT 5.4 Mini', defaultModel: 'gpt-5.4-mini', contextWindow: 400_000, maxOutputTokens: 128_000, vision: true },
  { id: 'opencode-gpt-5.4-nano', label: 'GPT 5.4 Nano', defaultModel: 'gpt-5.4-nano', contextWindow: 400_000, maxOutputTokens: 128_000 },
  { id: 'opencode-gpt-5.3-codex-spark', label: 'GPT 5.3 Codex Spark', defaultModel: 'gpt-5.3-codex-spark', contextWindow: 128_000, maxOutputTokens: 128_000, coding: true },
  { id: 'opencode-gpt-5.3-codex', label: 'GPT 5.3 Codex', defaultModel: 'gpt-5.3-codex', contextWindow: 400_000, maxOutputTokens: 128_000, vision: true, coding: true },
  { id: 'opencode-gpt-5.2', label: 'GPT 5.2', defaultModel: 'gpt-5.2', contextWindow: 400_000, maxOutputTokens: 128_000, vision: true },
  { id: 'opencode-gpt-5.2-codex', label: 'GPT 5.2 Codex', defaultModel: 'gpt-5.2-codex', contextWindow: 400_000, maxOutputTokens: 128_000, coding: true },
  { id: 'opencode-gpt-5.1', label: 'GPT 5.1', defaultModel: 'gpt-5.1', contextWindow: 400_000, maxOutputTokens: 128_000, vision: true },
  { id: 'opencode-gpt-5.1-codex-max', label: 'GPT 5.1 Codex Max', defaultModel: 'gpt-5.1-codex-max', contextWindow: 400_000, maxOutputTokens: 128_000, coding: true },
  { id: 'opencode-gpt-5.1-codex', label: 'GPT 5.1 Codex', defaultModel: 'gpt-5.1-codex', contextWindow: 400_000, maxOutputTokens: 128_000, coding: true },
  { id: 'opencode-gpt-5.1-codex-mini', label: 'GPT 5.1 Codex Mini', defaultModel: 'gpt-5.1-codex-mini', contextWindow: 400_000, maxOutputTokens: 128_000, coding: true },
  { id: 'opencode-gpt-5', label: 'GPT 5', defaultModel: 'gpt-5', contextWindow: 400_000, maxOutputTokens: 128_000, vision: true },
  { id: 'opencode-gpt-5-codex', label: 'GPT 5 Codex', defaultModel: 'gpt-5-codex', contextWindow: 400_000, maxOutputTokens: 128_000, coding: true },
  { id: 'opencode-gpt-5-nano', label: 'GPT 5 Nano', defaultModel: 'gpt-5-nano', contextWindow: 400_000, maxOutputTokens: 128_000 },
  { id: 'opencode-grok-build-0.1', label: 'Grok Build 0.1', defaultModel: 'grok-build-0.1', contextWindow: 256_000, maxOutputTokens: 256_000, coding: true },
  { id: 'opencode-deepseek-v4-pro', label: 'DeepSeek V4 Pro', defaultModel: 'deepseek-v4-pro', contextWindow: 1_000_000, maxOutputTokens: 384_000, reasoning: true, coding: true },
  { id: 'opencode-deepseek-v4-flash', label: 'DeepSeek V4 Flash', defaultModel: 'deepseek-v4-flash', contextWindow: 1_000_000, maxOutputTokens: 384_000, coding: true },
  { id: 'opencode-glm-5.1', label: 'GLM 5.1', defaultModel: 'glm-5.1', contextWindow: 204_800, maxOutputTokens: 131_072, coding: true },
  { id: 'opencode-glm-5', label: 'GLM 5', defaultModel: 'glm-5', contextWindow: 204_800, maxOutputTokens: 131_072, coding: true },
  { id: 'opencode-minimax-m2.7', label: 'MiniMax M2.7', defaultModel: 'minimax-m2.7', contextWindow: 204_800, maxOutputTokens: 131_072, reasoning: true, vision: true, coding: true },
  { id: 'opencode-minimax-m2.5', label: 'MiniMax M2.5', defaultModel: 'minimax-m2.5', contextWindow: 204_800, maxOutputTokens: 131_072, reasoning: true, vision: true, coding: true },
  { id: 'opencode-kimi-k2.6', label: 'Kimi K2.6', defaultModel: 'kimi-k2.6', contextWindow: 262_144, maxOutputTokens: 65_536, reasoning: true, coding: true },
  { id: 'opencode-kimi-k2.5', label: 'Kimi K2.5', defaultModel: 'kimi-k2.5', contextWindow: 262_144, maxOutputTokens: 65_536, reasoning: true, coding: true },
  { id: 'opencode-qwen3.6-plus', label: 'Qwen3.6 Plus', defaultModel: 'qwen3.6-plus', contextWindow: 262_144, maxOutputTokens: 65_536, reasoning: true, coding: true },
  { id: 'opencode-qwen3.5-plus', label: 'Qwen3.5 Plus', defaultModel: 'qwen3.5-plus', contextWindow: 262_144, maxOutputTokens: 65_536, reasoning: true, coding: true },
  { id: 'opencode-big-pickle', label: 'Big Pickle', defaultModel: 'big-pickle', contextWindow: 200_000, maxOutputTokens: 32_000, coding: true },
  { id: 'opencode-deepseek-v4-flash-free', label: 'DeepSeek V4 Flash Free', defaultModel: 'deepseek-v4-flash-free', contextWindow: 200_000, maxOutputTokens: 128_000, coding: true },
  { id: 'opencode-mimo-v2.5-free', label: 'MiMo V2.5 Free', defaultModel: 'mimo-v2.5-free', contextWindow: 200_000, maxOutputTokens: 32_000, coding: true },
  { id: 'opencode-qwen3.6-plus-free', label: 'Qwen3.6 Plus Free', defaultModel: 'qwen3.6-plus-free', contextWindow: 262_144, maxOutputTokens: 65_536, reasoning: true, coding: true },
  { id: 'opencode-minimax-m3-free', label: 'MiniMax M3 Free', defaultModel: 'minimax-m3-free', contextWindow: 200_000, maxOutputTokens: 32_000, reasoning: true, coding: true },
  { id: 'opencode-nemotron-3-ultra-free', label: 'Nemotron 3 Ultra Free', defaultModel: 'nemotron-3-ultra-free', contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true, coding: true },
  { id: 'opencode-north-mini-code-free', label: 'North Mini Code Free', defaultModel: 'north-mini-code-free', contextWindow: 256_000, maxOutputTokens: 64_000, coding: true },
]

const goModels: OpenCodeModelSpec[] = [
  { id: 'opencode-go-glm-5.2', label: 'GLM 5.2', defaultModel: 'glm-5.2', contextWindow: 1_000_000, maxOutputTokens: 131_072, reasoning: true, coding: true },
  { id: 'opencode-go-qwen3.7-max', label: 'Qwen3.7 Max', defaultModel: 'qwen3.7-max', contextWindow: 1_000_000, maxOutputTokens: 65_536, reasoning: true, coding: true },
  { id: 'opencode-go-kimi-k2.7-code', label: 'Kimi K2.7 Code', defaultModel: 'kimi-k2.7-code', contextWindow: 262_144, maxOutputTokens: 262_144, reasoning: true, coding: true },
  { id: 'opencode-go-mimo-v2.5-pro', label: 'MiMo V2.5 Pro', defaultModel: 'mimo-v2.5-pro', contextWindow: 1_048_576, maxOutputTokens: 128_000, reasoning: true, coding: true },
  { id: 'opencode-go-deepseek-v4-pro', label: 'DeepSeek V4 Pro', defaultModel: 'deepseek-v4-pro', contextWindow: 1_000_000, maxOutputTokens: 384_000, reasoning: true, coding: true },
  { id: 'opencode-go-qwen3.7-plus', label: 'Qwen3.7 Plus', defaultModel: 'qwen3.7-plus', contextWindow: 1_000_000, maxOutputTokens: 65_536, reasoning: true, coding: true },
  { id: 'opencode-go-minimax-m3', label: 'MiniMax M3', defaultModel: 'minimax-m3', contextWindow: 512_000, maxOutputTokens: 131_072, reasoning: true, coding: true },
  { id: 'opencode-go-mimo-v2.5', label: 'MiMo V2.5', defaultModel: 'mimo-v2.5', contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true, coding: true },
  { id: 'opencode-go-deepseek-v4-flash', label: 'DeepSeek V4 Flash', defaultModel: 'deepseek-v4-flash', contextWindow: 1_000_000, maxOutputTokens: 384_000, coding: true },
  { id: 'opencode-go-glm-5.1', label: 'GLM 5.1', defaultModel: 'glm-5.1', contextWindow: 202_752, maxOutputTokens: 32_768, reasoning: true, coding: true },
  { id: 'opencode-go-kimi-k2.6', label: 'Kimi K2.6', defaultModel: 'kimi-k2.6', contextWindow: 262_144, maxOutputTokens: 65_536, reasoning: true, coding: true },
  { id: 'opencode-go-qwen3.6-plus', label: 'Qwen3.6 Plus', defaultModel: 'qwen3.6-plus', contextWindow: 1_000_000, maxOutputTokens: 65_536, reasoning: true, coding: true },
  { id: 'opencode-go-minimax-m2.7', label: 'MiniMax M2.7', defaultModel: 'minimax-m2.7', contextWindow: 204_800, maxOutputTokens: 131_072, reasoning: true, vision: true, coding: true },
]

export default [...zenModels, ...goModels].map(openCodeModel)
