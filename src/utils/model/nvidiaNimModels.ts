/**
 * NVIDIA NIM model list for the /model picker.
 * Filtered to chat/instruct models only - embedding, reward, safety, vision, etc. excluded.
 */

import type { ModelOption } from './modelOptions.js'
import { getAPIProvider } from './providers.js'
import { isEnvTruthy } from '../envUtils.js'
import { getCachedModels } from '../../integrations/discoveryCache.js'
import { getDiscoveryCacheKey } from '../../integrations/discoveryService.js'
import { resolveRouteCredentialValue } from '../../integrations/routeMetadata.js'
import { firstUsableCredential } from '../../services/api/credentialPool.js'
import { resolveProviderRequest } from '../../services/api/providerConfig.js'
import { parseCustomHeadersEnv } from '../providerCustomHeaders.js'

export function isNvidiaNimProvider(): boolean {
  // Check if explicitly set via NVIDIA_NIM or via provider flag
  if (isEnvTruthy(process.env.NVIDIA_NIM)) {
    return true
  }
  // Also check if using NVIDIA NIM endpoint
  const baseUrl = process.env.OPENAI_BASE_URL ?? ''
  if (baseUrl.includes('nvidia') || baseUrl.includes('integrate.api.nvidia')) {
    return true
  }
  return getAPIProvider() === 'nvidia-nim'
}

function getNvidiaNimModels(): ModelOption[] {
  return [
    // AGENTIC REASONING MODELS
    { value: 'nvidia/cosmos-reason2-8b', label: 'Cosmos Reason 2 8B', description: 'Reasoning' },
    { value: 'microsoft/phi-4-mini-flash-reasoning', label: 'Phi 4 Mini Flash Reasoning', description: 'Reasoning' },
    { value: 'qwen/qwen3-next-80b-a3b-thinking', label: 'Qwen 3 Next 80B Thinking', description: 'Reasoning' },
    { value: 'deepseek-ai/deepseek-r1-distill-qwen-32b', label: 'DeepSeek R1 Qwen 32B', description: 'Reasoning' },
    { value: 'deepseek-ai/deepseek-r1-distill-qwen-14b', label: 'DeepSeek R1 Qwen 14B', description: 'Reasoning' },
    { value: 'deepseek-ai/deepseek-r1-distill-qwen-7b', label: 'DeepSeek R1 Qwen 7B', description: 'Reasoning' },
    { value: 'deepseek-ai/deepseek-r1-distill-llama-8b', label: 'DeepSeek R1 Llama 8B', description: 'Reasoning' },
    { value: 'qwen/qwq-32b', label: 'QwQ 32B Reasoning', description: 'Reasoning' },
    // CODE MODELS
    { value: 'meta/codellama-70b', label: 'CodeLlama 70B', description: 'Code' },
    { value: 'bigcode/starcoder2-15b', label: 'StarCoder2 15B', description: 'Code' },
    { value: 'bigcode/starcoder2-7b', label: 'StarCoder2 7B', description: 'Code' },
    { value: 'mistralai/codestral-22b-instruct-v0.1', label: 'Codestral 22B', description: 'Code' },
    { value: 'mistralai/mamba-codestral-7b-v0.1', label: 'Mamba Codestral 7B', description: 'Code' },
    { value: 'deepseek-ai/deepseek-coder-6.7b-instruct', label: 'DeepSeek Coder 6.7B', description: 'Code' },
    { value: 'google/codegemma-7b', label: 'CodeGemma 7B', description: 'Code' },
    { value: 'google/codegemma-1.1-7b', label: 'CodeGemma 1.1 7B', description: 'Code' },
    { value: 'qwen/qwen2.5-coder-32b-instruct', label: 'Qwen 2.5 Coder 32B', description: 'Code' },
    { value: 'qwen/qwen2.5-coder-7b-instruct', label: 'Qwen 2.5 Coder 7B', description: 'Code' },
    { value: 'qwen/qwen3-coder-480b-a35b-instruct', label: 'Qwen 3 Coder 480B', description: 'Code' },
    { value: 'ibm/granite-34b-code-instruct', label: 'Granite 34B Code', description: 'Code' },
    { value: 'ibm/granite-8b-code-instruct', label: 'Granite 8B Code', description: 'Code' },
    // NEMOTRON MODELS - NVIDIA Flagship
    { value: 'nvidia/llama-3.1-nemotron-70b-instruct', label: 'Nemotron 70B Instruct', description: 'NVIDIA Flagship' },
    { value: 'nvidia/llama-3.1-nemotron-51b-instruct', label: 'Nemotron 51B Instruct', description: 'NVIDIA Flagship' },
    { value: 'nvidia/llama-3.1-nemotron-ultra-253b-v1', label: 'Nemotron Ultra 253B', description: 'NVIDIA Flagship' },
    { value: 'nvidia/llama-3.3-nemotron-super-49b-v1', label: 'Nemotron Super 49B v1', description: 'NVIDIA Flagship' },
    { value: 'nvidia/llama-3.3-nemotron-super-49b-v1.5', label: 'Nemotron Super 49B v1.5', description: 'NVIDIA Flagship' },
    { value: 'nvidia/nemotron-4-340b-instruct', label: 'Nemotron 4 340B', description: 'NVIDIA Flagship' },
    { value: 'nvidia/nemotron-3-super-120b-a12b', label: 'Nemotron 3 Super 120B', description: 'NVIDIA Flagship' },
    { value: 'nvidia/nemotron-3-nano-30b-a3b', label: 'Nemotron 3 Nano 30B', description: 'NVIDIA Flagship' },
    { value: 'nvidia/nemotron-nano-3-30b-a3b', label: 'Nemotron Nano 3 30B', description: 'NVIDIA Flagship' },
    { value: 'nvidia/nvidia-nemotron-nano-9b-v2', label: 'Nemotron Nano 9B v2', description: 'NVIDIA Flagship' },
    { value: 'nvidia/nemotron-mini-4b-instruct', label: 'Nemotron Mini 4B', description: 'NVIDIA Flagship' },
    { value: 'nvidia/llama-3.1-nemotron-nano-8b-v1', label: 'Nemotron Nano 8B', description: 'NVIDIA Flagship' },
    { value: 'nvidia/llama-3.1-nemotron-nano-4b-v1.1', label: 'Nemotron Nano 4B v1.1', description: 'NVIDIA Flagship' },
    // CHATQA MODELS
    { value: 'nvidia/llama3-chatqa-1.5-70b', label: 'Llama3 ChatQA 1.5 70B', description: 'Chat' },
    { value: 'nvidia/llama3-chatqa-1.5-8b', label: 'Llama3 ChatQA 1.5 8B', description: 'Chat' },
    // META LLAMA MODELS
    { value: 'meta/llama-3.1-405b-instruct', label: 'Llama 3.1 405B', description: 'Meta Llama' },
    { value: 'meta/llama-3.1-70b-instruct', label: 'Llama 3.1 70B', description: 'Meta Llama' },
    { value: 'meta/llama-3.1-8b-instruct', label: 'Llama 3.1 8B', description: 'Meta Llama' },
    { value: 'meta/llama-3.2-90b-vision-instruct', label: 'Llama 3.2 90B Vision', description: 'Meta Llama' },
    { value: 'meta/llama-3.2-11b-vision-instruct', label: 'Llama 3.2 11B Vision', description: 'Meta Llama' },
    { value: 'meta/llama-3.2-3b-instruct', label: 'Llama 3.2 3B', description: 'Meta Llama' },
    { value: 'meta/llama-3.2-1b-instruct', label: 'Llama 3.2 1B', description: 'Meta Llama' },
    { value: 'meta/llama-3.3-70b-instruct', label: 'Llama 3.3 70B', description: 'Meta Llama' },
    { value: 'meta/llama-4-maverick-17b-128e-instruct', label: 'Llama 4 Maverick 17B', description: 'Meta Llama' },
    { value: 'meta/llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout 17B', description: 'Meta Llama' },
    // GOOGLE GEMMA MODELS (text only - no vision)
    { value: 'google/gemma-4-31b-it', label: 'Gemma 4 31B', description: 'Google Gemma' },
    { value: 'google/gemma-3-27b-it', label: 'Gemma 3 27B', description: 'Google Gemma' },
    { value: 'google/gemma-3-12b-it', label: 'Gemma 3 12B', description: 'Google Gemma' },
    { value: 'google/gemma-3-4b-it', label: 'Gemma 3 4B', description: 'Google Gemma' },
    { value: 'google/gemma-3-1b-it', label: 'Gemma 3 1B', description: 'Google Gemma' },
    { value: 'google/gemma-3n-e4b-it', label: 'Gemma 3N E4B', description: 'Google Gemma' },
    { value: 'google/gemma-3n-e2b-it', label: 'Gemma 3N E2B', description: 'Google Gemma' },
    { value: 'google/gemma-2-27b-it', label: 'Gemma 2 27B', description: 'Google Gemma' },
    { value: 'google/gemma-2-9b-it', label: 'Gemma 2 9B', description: 'Google Gemma' },
    { value: 'google/gemma-2-2b-it', label: 'Gemma 2 2B', description: 'Google Gemma' },
    // MISTRAL MODELS
    { value: 'mistralai/mistral-large-3-675b-instruct-2512', label: 'Mistral Large 3 675B', description: 'Mistral' },
    { value: 'mistralai/mistral-large-2-instruct', label: 'Mistral Large 2', description: 'Mistral' },
    { value: 'mistralai/mistral-large', label: 'Mistral Large', description: 'Mistral' },
    { value: 'mistralai/mistral-medium-3.5-128b', label: 'Mistral Medium 3.5 128B', description: 'Mistral' },
    { value: 'mistralai/mistral-medium-3-instruct', label: 'Mistral Medium 3', description: 'Mistral' },
    { value: 'mistralai/mistral-small-4-119b-2603', label: 'Mistral Small 4 119B', description: 'Mistral' },
    { value: 'mistralai/mistral-small-3.1-24b-instruct-2503', label: 'Mistral Small 3.1 24B', description: 'Mistral' },
    { value: 'mistralai/mistral-small-24b-instruct', label: 'Mistral Small 24B', description: 'Mistral' },
    { value: 'mistralai/mistral-7b-instruct-v0.3', label: 'Mistral 7B v0.3', description: 'Mistral' },
    { value: 'mistralai/mistral-7b-instruct-v0.2', label: 'Mistral 7B v0.2', description: 'Mistral' },
    { value: 'mistralai/mixtral-8x22b-instruct-v0.1', label: 'Mixtral 8x22B Instruct', description: 'Mistral' },
    { value: 'mistralai/mixtral-8x7b-instruct-v0.1', label: 'Mixtral 8x7B', description: 'Mistral' },
    { value: 'mistralai/mistral-nemotron', label: 'Mistral Nemotron', description: 'Mistral' },
    { value: 'mistralai/mathstral-7b-v0.1', label: 'Mathstral 7B', description: 'Math' },
    { value: 'mistralai/ministral-14b-instruct-2512', label: 'Ministral 14B', description: 'Mistral' },
    { value: 'mistralai/devstral-2-123b-instruct-2512', label: 'Devstral 2 123B', description: 'Code' },
    { value: 'mistralai/magistral-small-2506', label: 'Magistral Small', description: 'Mistral' },
    // MICROSOFT PHI MODELS (text only - no vision)
    { value: 'microsoft/phi-4-multimodal-instruct', label: 'Phi 4 Multimodal', description: 'Multimodal' },
    { value: 'microsoft/phi-4-mini-instruct', label: 'Phi 4 Mini', description: 'Phi' },
    { value: 'microsoft/phi-3.5-mini-instruct', label: 'Phi 3.5 Mini', description: 'Phi' },
    { value: 'microsoft/phi-3-small-128k-instruct', label: 'Phi 3 Small 128K', description: 'Phi' },
    { value: 'microsoft/phi-3-small-8k-instruct', label: 'Phi 3 Small 8K', description: 'Phi' },
    { value: 'microsoft/phi-3-medium-128k-instruct', label: 'Phi 3 Medium 128K', description: 'Phi' },
    { value: 'microsoft/phi-3-medium-4k-instruct', label: 'Phi 3 Medium 4K', description: 'Phi' },
    { value: 'microsoft/phi-3-mini-128k-instruct', label: 'Phi 3 Mini 128K', description: 'Phi' },
    { value: 'microsoft/phi-3-mini-4k-instruct', label: 'Phi 3 Mini 4K', description: 'Phi' },
    // QWEN MODELS
    { value: 'qwen/qwen3.5-397b-a17b', label: 'Qwen 3.5 397B', description: 'Qwen' },
    { value: 'qwen/qwen3.5-122b-a10b', label: 'Qwen 3.5 122B', description: 'Qwen' },
    { value: 'qwen/qwen3-next-80b-a3b-instruct', label: 'Qwen 3 Next 80B', description: 'Qwen' },
    { value: 'qwen/qwen2.5-7b-instruct', label: 'Qwen 2.5 7B', description: 'Qwen' },
    { value: 'qwen/qwen2-7b-instruct', label: 'Qwen 2 7B', description: 'Qwen' },
    { value: 'qwen/qwen3-32b', label: 'Qwen 3 32B', description: 'Qwen' },
    { value: 'qwen/qwen3-8b', label: 'Qwen 3 8B', description: 'Qwen' },
    // DEEPSEEK MODELS
    { value: 'deepseek-ai/deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'DeepSeek' },
    { value: 'deepseek-ai/deepseek-v4-flash', label: 'DeepSeek V4 Flash', description: 'DeepSeek' },
    { value: 'deepseek-ai/deepseek-r1', label: 'DeepSeek R1', description: 'DeepSeek' },
    { value: 'deepseek-ai/deepseek-v3', label: 'DeepSeek V3', description: 'DeepSeek' },
    { value: 'deepseek-ai/deepseek-v3.2', label: 'DeepSeek V3.2', description: 'DeepSeek' },
    { value: 'deepseek-ai/deepseek-v3.1-terminus', label: 'DeepSeek V3.1 Terminus', description: 'DeepSeek' },
    { value: 'deepseek-ai/deepseek-v3.1', label: 'DeepSeek V3.1', description: 'DeepSeek' },
    // IBM GRANITE MODELS
    { value: 'ibm/granite-3.3-8b-instruct', label: 'Granite 3.3 8B', description: 'IBM Granite' },
    { value: 'ibm/granite-3.0-8b-instruct', label: 'Granite 3.0 8B', description: 'IBM Granite' },
    { value: 'ibm/granite-3.0-3b-a800m-instruct', label: 'Granite 3.0 3B', description: 'IBM Granite' },
    // OTHER MODELS
    { value: 'bytedance/seed-oss-36b-instruct', label: 'Seed OSS 36B Instruct', description: 'Other' },
    { value: 'databricks/dbrx-instruct', label: 'DBRX Instruct', description: 'Other' },
    { value: '01-ai/yi-large', label: 'Yi Large', description: 'Other' },
    { value: 'ai21labs/jamba-1.5-large-instruct', label: 'Jamba 1.5 Large', description: 'Other' },
    { value: 'ai21labs/jamba-1.5-mini-instruct', label: 'Jamba 1.5 Mini', description: 'Other' },
    { value: 'writer/palmyra-creative-122b', label: 'Palmyra Creative 122B', description: 'Other' },
    { value: 'writer/palmyra-fin-70b-32k', label: 'Palmyra Fin 70B 32K', description: 'Other' },
    { value: 'writer/palmyra-med-70b', label: 'Palmyra Med 70B', description: 'Other' },
    { value: 'writer/palmyra-med-70b-32k', label: 'Palmyra Med 70B 32K', description: 'Other' },
    // Z-AI GLM MODELS
    { value: 'z-ai/glm-5.1', label: 'GLM-5.1', description: 'Z-AI' },
    { value: 'z-ai/glm5', label: 'GLM-5', description: 'Z-AI' },
    { value: 'z-ai/glm4.7', label: 'GLM-4.7', description: 'Z-AI' },
    // MINIMAX MODELS
    { value: 'minimaxai/minimax-m2.7', label: 'MiniMax M2.7', description: 'MiniMax' },
    { value: 'minimaxai/minimax-m2.5', label: 'MiniMax M2.5', description: 'MiniMax' },
    // MOONSHOT KIMI MODELS
    { value: 'moonshotai/kimi-k2.6', label: 'Kimi K2.6', description: 'Moonshot' },
    { value: 'moonshotai/kimi-k2.5', label: 'Kimi K2.5', description: 'Moonshot' },
    { value: 'moonshotai/kimi-k2-instruct', label: 'Kimi K2 Instruct', description: 'Moonshot' },
    { value: 'moonshotai/kimi-k2-thinking', label: 'Kimi K2 Thinking', description: 'Moonshot' },
    { value: 'moonshotai/kimi-k2.5-thinking', label: 'Kimi K2.5 Thinking', description: 'Moonshot' },
    { value: 'moonshotai/kimi-k2-instruct-0905', label: 'Kimi K2 Instruct 0905', description: 'Moonshot' },
  ]
}

let cachedNvidiaNimOptions: ModelOption[] | null = null

export function getCachedNvidiaNimModelOptions(): ModelOption[] {
  if (!cachedNvidiaNimOptions) {
    cachedNvidiaNimOptions = getNvidiaNimModels()
  }
  return cachedNvidiaNimOptions
}

/**
 * Returns the persisted discovery cache entries for the NVIDIA NIM route, if
 * any are present on disk. Used by validateModel so that inline `/model <id>`
 * accepts models surfaced by dynamic discovery — not only the static list.
 *
 * The cache key must be derived from the same `(routeId, baseUrl, apiKey,
 * headers)` shape that the descriptor picker / startup discovery uses, or the
 * inline validator looks in a different partition than the one the picker
 * actually wrote (see #1177 P2 review): the picker calls
 * `resolveRouteCredentialValue()` for the active route, whose credential list
 * for `nvidia-nim` includes both `NVIDIA_API_KEY` *and* `OPENAI_API_KEY` for
 * OpenAI-compatible setups. Hard-coding `process.env.NVIDIA_API_KEY` here
 * silently mis-partitioned the cache for users authenticating via
 * `OPENAI_API_KEY`.
 */
export function getNvidiaNimDiscoveryCacheKeyForEnv(
  processEnv: NodeJS.ProcessEnv = process.env,
): string {
  // Mirror the picker side (`getOpenAIDiscoveryRequestOptions` in
  // src/commands/model/model.tsx): pull baseUrl from the resolved provider
  // request and let `resolveRouteCredentialValue` walk the route's full
  // credential list. Falling back to undefined keeps the cache key shape
  // identical to the picker's even when the env var is missing; both sides
  // will hash the same `apiKeyHash: ''` partition in that case.
  const request = resolveProviderRequest({
    model: processEnv.OPENAI_MODEL,
    baseUrl: processEnv.OPENAI_BASE_URL,
    processEnv,
  })
  const routeCredential = resolveRouteCredentialValue({
    routeId: 'nvidia-nim',
    baseUrl: request.baseUrl,
    processEnv,
  })
  const apiKey = firstUsableCredential(routeCredential)

  // Include custom headers in the cache key so this read lands in the
  // same partition the picker (`getOpenAIDiscoveryRequestOptions` in
  // src/commands/model/model.tsx) writes to.
  return getDiscoveryCacheKey('nvidia-nim', {
    baseUrl: request.baseUrl,
    apiKey,
    headers: parseCustomHeadersEnv(processEnv.ANTHROPIC_CUSTOM_HEADERS),
  })
}

export async function getDiscoveredNvidiaNimModelIds(): Promise<string[]> {
  try {
    const cacheKey = getNvidiaNimDiscoveryCacheKeyForEnv(process.env)
    const cached = await getCachedModels(cacheKey, Number.MAX_SAFE_INTEGER, {
      includeStale: true,
    })
    return cached?.models.map(entry => entry.apiName) ?? []
  } catch {
    return []
  }
}