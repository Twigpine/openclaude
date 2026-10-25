import { defineGateway } from '../define.js'
import { ZAI_GLM_OPENAI_SHIM } from '../transport/zaiGlmShim.js'
import type { ReasoningControlMode, ReasoningEffortLevel, ReasoningWireFormat, OpenAIShimTransportConfig } from '../descriptors.js'

type OpenCodeCatalogSpec = {
  id: string
  label: string
  endpointPath?: string
  zaiGlm?: boolean
}

function catalogEntry(spec: OpenCodeCatalogSpec) {
  const openaiShim: Partial<OpenAIShimTransportConfig> = {
    ...(spec.zaiGlm ? ZAI_GLM_OPENAI_SHIM : {}),
    ...(spec.endpointPath ? { endpointPath: spec.endpointPath } : {}),
  }
  return {
    id: spec.id,
    apiName: spec.id,
    label: spec.label,
    modelDescriptorId: `opencode-${spec.id}`,
    ...(spec.zaiGlm
      ? {
          capabilities: {
            supportsFunctionCalling: true,
            supportsJsonMode: true,
            supportsReasoning: true,
          },
          reasoning: {
            mode: 'levels' as ReasoningControlMode,
            levels: ['high', 'xhigh'] as ReasoningEffortLevel[],
            wireFormat: 'zai_compatible' as ReasoningWireFormat,
          },
        }
      : {}),
    ...(Object.keys(openaiShim).length > 0
      ? { transportOverrides: { openaiShim } }
      : {}),
  }
}

const zenModels: OpenCodeCatalogSpec[] = [
  { id: 'claude-fable-5', label: 'Claude Fable 5', endpointPath: '/messages' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', endpointPath: '/messages' },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', endpointPath: '/messages' },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', endpointPath: '/messages' },
  { id: 'claude-opus-4-5', label: 'Claude Opus 4.5', endpointPath: '/messages' },
  { id: 'claude-opus-4-1', label: 'Claude Opus 4.1', endpointPath: '/messages' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', endpointPath: '/messages' },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', endpointPath: '/messages' },
  { id: 'claude-sonnet-4', label: 'Claude Sonnet 4', endpointPath: '/messages' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', endpointPath: '/messages' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', endpointPath: '/models/gemini-3.5-flash' },
  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', endpointPath: '/models/gemini-3.1-pro' },
  { id: 'gemini-3-flash', label: 'Gemini 3 Flash', endpointPath: '/models/gemini-3-flash' },
  { id: 'gpt-5.5', label: 'GPT 5.5', endpointPath: '/responses' },
  { id: 'gpt-5.5-pro', label: 'GPT 5.5 Pro', endpointPath: '/responses' },
  { id: 'gpt-5.4', label: 'GPT 5.4', endpointPath: '/responses' },
  { id: 'gpt-5.4-pro', label: 'GPT 5.4 Pro', endpointPath: '/responses' },
  { id: 'gpt-5.4-mini', label: 'GPT 5.4 Mini', endpointPath: '/responses' },
  { id: 'gpt-5.4-nano', label: 'GPT 5.4 Nano', endpointPath: '/responses' },
  { id: 'gpt-5.3-codex-spark', label: 'GPT 5.3 Codex Spark', endpointPath: '/responses' },
  { id: 'gpt-5.3-codex', label: 'GPT 5.3 Codex', endpointPath: '/responses' },
  { id: 'gpt-5.2', label: 'GPT 5.2', endpointPath: '/responses' },
  { id: 'gpt-5.2-codex', label: 'GPT 5.2 Codex', endpointPath: '/responses' },
  { id: 'gpt-5.1', label: 'GPT 5.1', endpointPath: '/responses' },
  { id: 'gpt-5.1-codex-max', label: 'GPT 5.1 Codex Max', endpointPath: '/responses' },
  { id: 'gpt-5.1-codex', label: 'GPT 5.1 Codex', endpointPath: '/responses' },
  { id: 'gpt-5.1-codex-mini', label: 'GPT 5.1 Codex Mini', endpointPath: '/responses' },
  { id: 'gpt-5', label: 'GPT 5', endpointPath: '/responses' },
  { id: 'gpt-5-codex', label: 'GPT 5 Codex', endpointPath: '/responses' },
  { id: 'gpt-5-nano', label: 'GPT 5 Nano', endpointPath: '/responses' },
  { id: 'grok-build-0.1', label: 'Grok Build 0.1' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  { id: 'glm-5.1', label: 'GLM 5.1', zaiGlm: true },
  { id: 'glm-5', label: 'GLM 5', zaiGlm: true },
  // Retain historical identity for saved selections; suggestion policy hides it.
  { id: 'minimax-m3.1-flash-free', label: 'MiniMax M3.1 Flash Free' },
  { id: 'minimax-m3', label: 'MiniMax M3' },
  { id: 'minimax-m2.7', label: 'MiniMax M2.7' },
  { id: 'minimax-m2.5', label: 'MiniMax M2.5' },
  { id: 'kimi-k2.6', label: 'Kimi K2.6' },
  { id: 'kimi-k2.5', label: 'Kimi K2.5' },
  { id: 'qwen3.6-plus', label: 'Qwen3.6 Plus', endpointPath: '/messages' },
  { id: 'qwen3.5-plus', label: 'Qwen3.5 Plus', endpointPath: '/messages' },
  { id: 'big-pickle', label: 'Big Pickle' },
  { id: 'deepseek-v4-flash-free', label: 'DeepSeek V4 Flash Free' },
  { id: 'mimo-v2.5-free', label: 'MiMo V2.5 Free' },
  { id: 'qwen3.6-plus-free', label: 'Qwen3.6 Plus Free', endpointPath: '/messages' },
  { id: 'minimax-m3-free', label: 'MiniMax M3 Free' },
  { id: 'nemotron-3-ultra-free', label: 'Nemotron 3 Ultra Free' },
  { id: 'north-mini-code-free', label: 'North Mini Code Free' },
]

export default defineGateway({
  id: 'opencode',
  label: 'OpenCode Zen',
  category: 'aggregating',
  defaultBaseUrl: 'https://opencode.ai/zen/v1',
  defaultModel: 'gpt-5.4',
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: ['OPENCODE_API_KEY'],
  },
  transportConfig: {
    kind: 'openai-compatible',
    openaiShim: {
      supportsAuthHeaders: true,
    },
  },
  preset: {
    id: 'opencode',
    vendorId: 'openai',
    description: 'OpenCode Zen - pay-as-you-go AI gateway',
    apiKeyEnvVars: ['OPENCODE_API_KEY'],
    modelEnvVars: ['OPENAI_MODEL'],
  },
  validation: {
    kind: 'credential-env',
    routing: {
      matchDefaultBaseUrl: true,
    },
    credentialEnvVars: ['OPENCODE_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    missingCredentialMessage:
      'OPENCODE_API_KEY or OPENAI_API_KEYS / OPENAI_API_KEY is required. Get your API key from https://opencode.ai',
  },
  catalog: {
    source: 'static',
    models: zenModels.map(catalogEntry),
  },
  usage: { supported: false },
})
