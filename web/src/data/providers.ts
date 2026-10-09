// Mirrors the provider preset manifest in
// src/integrations/generated/integrationManifest.generated.ts (v0.26.0)
// plus the OAuth/special entries injected by the /provider picker.

export type ProviderGroup =
  | 'subscriptions'
  | 'gateways'
  | 'vendors'
  | 'local'
  | 'custom'

export interface Provider {
  id: string
  name: string
  group: ProviderGroup
  setup: string
  envVars?: string[]
  notes: string
  badge?: 'recommended' | 'sponsor'
}

export const providerGroups: { id: ProviderGroup; label: string; blurb: string }[] = [
  {
    id: 'subscriptions',
    label: 'sign-in & subscription plans',
    blurb: 'oauth sign-ins and coding-plan subscriptions — no raw api key handling.',
  },
  {
    id: 'gateways',
    label: 'gateways',
    blurb: 'one key, many models — smart routing and aggregation endpoints.',
  },
  {
    id: 'vendors',
    label: 'direct vendor apis',
    blurb: 'first-party api endpoints, each with its own key.',
  },
  {
    id: 'local',
    label: 'local inference',
    blurb: 'no api key, no network — your machine, your models.',
  },
  {
    id: 'custom',
    label: 'cloud routes & custom endpoints',
    blurb: 'enterprise cloud routes and bring-your-own-endpoint escapes.',
  },
]

export const providers: Provider[] = [
  // ── sign-in & subscription plans ─────────────────────────────────────
  {
    id: 'anthropic',
    name: 'Anthropic / Claude',
    group: 'subscriptions',
    setup: '/login or env vars',
    envVars: ['ANTHROPIC_API_KEY'],
    notes: 'Sign in with an Anthropic account or use an API key directly.',
  },
  {
    id: 'codex-oauth',
    name: 'Codex OAuth (ChatGPT)',
    group: 'subscriptions',
    setup: '/provider',
    notes: 'Opens ChatGPT sign-in in your browser and stores Codex credentials securely — including the GPT-5.6 family (Sol, Terra, Luna) via the Responses API. Manual callback paste supported for SSH sessions.',
    badge: 'recommended',
  },
  {
    id: 'xai-oauth',
    name: 'xAI OAuth (Grok)',
    group: 'subscriptions',
    setup: '/provider or `openclaude auth xai login`',
    notes: 'Sign in with your xAI account in the browser; device-code flow available for remote hosts with no localhost callback.',
  },
  {
    id: 'github-models',
    name: 'GitHub Models / Copilot',
    group: 'subscriptions',
    setup: '/onboard-github',
    envVars: ['GITHUB_TOKEN'],
    notes: 'Interactive onboarding with saved credentials; Copilot and Copilot Enterprise endpoints supported.',
  },
  {
    id: 'kimi-code',
    name: 'Moonshot Kimi Code',
    group: 'subscriptions',
    setup: '/provider or env vars',
    envVars: ['KIMI_API_KEY'],
    notes: 'Kimi Code subscription endpoint, including Kimi K3 in 1M and 256K context variants.',
  },
  {
    id: 'zai',
    name: 'Z.AI GLM Coding Plan',
    group: 'subscriptions',
    setup: '/provider or env vars',
    notes: 'GLM coding subscription endpoint; defaults to glm-5.2.',
  },
  {
    id: 'dashscope',
    name: 'Alibaba Coding Plan',
    group: 'subscriptions',
    setup: '/provider or env vars',
    envVars: ['DASHSCOPE_API_KEY'],
    notes: 'DashScope international and China endpoints; defaults to qwen3.6-plus.',
  },
  {
    id: 'xiaomi-mimo-token',
    name: 'Xiaomi MiMo Token Plan',
    group: 'subscriptions',
    setup: '/provider or env vars',
    envVars: ['MIMO_API_KEY'],
    notes: 'MiMo subscription endpoint; defaults to mimo-v2.5-pro.',
    badge: 'sponsor',
  },

  // ── gateways ─────────────────────────────────────────────────────────
  {
    id: 'opengateway',
    name: 'Twigpine Opengateway',
    group: 'gateways',
    setup: 'startup default, /provider, or env vars',
    envVars: ['OPENGATEWAY_API_KEY'],
    notes: 'Smart gateway at https://opengateway.gitlawb.com/v1 with auto smart-routing, MiMo, MiniMax, Qwen, GLM, Gemini — plus free models (Nemotron 3 Ultra, Ling 3.0 Flash, Tencent HY3). Keys at gitlawb.com/opengateway/keys.',
    badge: 'recommended',
  },
  {
    id: 'aimlapi',
    name: 'AI/ML API',
    group: 'gateways',
    setup: '/provider or `openclaude aimlapi topup`',
    envVars: ['AIMLAPI_API_KEY'],
    notes: '1,000+ models behind one OpenAI-compatible endpoint, with guided top-up and key provisioning from the CLI.',
    badge: 'recommended',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    group: 'gateways',
    setup: '/provider or env vars',
    envVars: ['OPENROUTER_API_KEY'],
    notes: 'OpenAI-compatible aggregation across hundreds of hosted models.',
  },
  {
    id: 'llmtr',
    name: 'LLMTR',
    group: 'gateways',
    setup: '/provider or OpenAI-compatible env vars',
    envVars: ['LLMTR_API_KEY', 'OPENAI_API_KEY'],
    notes: '/provider and --provider llmtr default to deepseek/deepseek-v4-flash; raw env setup must set OPENAI_BASE_URL=https://llmtr.com/v1 and OPENAI_MODEL. Uses public discovery of tool-capable chat models.',
  },
  {
    id: 'near-ai',
    name: 'NEAR AI',
    group: 'gateways',
    setup: '/provider or env vars',
    envVars: ['NEARAI_API_KEY'],
    notes: 'Unified gateway (Claude, GPT, Gemini, plus TEE open models) at https://cloud-api.near.ai/v1.',
  },
  {
    id: 'opencode',
    name: 'OpenCode Zen / Go',
    group: 'gateways',
    setup: '/provider or env vars',
    envVars: ['OPENCODE_API_KEY'],
    notes: 'Pay-as-you-go gateway (Zen, 48 models) and a $10/mo subscription for open models (Go); one key for both.',
  },
  {
    id: 'clinepass',
    name: 'ClinePass',
    group: 'gateways',
    setup: '/provider or env vars',
    envVars: ['CLINE_API_KEY'],
    notes: 'AI model gateway with usage limits and usage reporting.',
  },
  {
    id: 'bankr',
    name: 'Bankr',
    group: 'gateways',
    setup: '/provider or env vars',
    envVars: ['BNKR_API_KEY'],
    notes: 'Bankr LLM gateway (OpenAI-compatible) at https://llm.bankr.bot/v1.',
  },
  {
    id: 'hicap',
    name: 'Hicap',
    group: 'gateways',
    setup: '/provider or env vars',
    envVars: ['HICAP_API_KEY'],
    notes: 'Discovers models from the /models endpoint; supports Responses mode for gpt- models. Defaults to claude-opus-4.8.',
  },
  {
    id: 'atlas-cloud',
    name: 'Atlas Cloud',
    group: 'gateways',
    setup: '/provider or env vars',
    envVars: ['ATLAS_CLOUD_API_KEY'],
    notes: 'OpenAI-compatible hosted open models with reasoning support at https://api.atlascloud.ai/v1.',
  },
  {
    id: 'apismart',
    name: 'ApiSmart',
    group: 'gateways',
    setup: '/provider or env vars',
    envVars: ['APISMART_API_KEY', 'APISMART_MODEL'],
    notes: 'Unified OpenAI-compatible gateway at https://gw.apismart.ai/v1; defaults to DEEPSEEK_V4_FLASH with hybrid /v1/models discovery.',
  },
  {
    id: 'api-route',
    name: 'API Route',
    group: 'gateways',
    setup: '/provider or env vars',
    envVars: ['API_ROUTE_API_KEY', 'API_ROUTE_MODEL'],
    notes: 'OpenAI-compatible multi-model gateway at https://global.api-route.com/v1; defaults to claude-sonnet-4-6 with hybrid /v1/models discovery.',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    group: 'gateways',
    setup: '/provider or env vars',
    envVars: ['CLOUDFLARE_API_TOKEN'],
    notes: 'Workers AI OpenAI-compatible endpoint, scoped to your Cloudflare account id.',
  },
  {
    id: 'nvidia-nim',
    name: 'NVIDIA NIM',
    group: 'gateways',
    setup: '/provider or env vars',
    envVars: ['NVIDIA_API_KEY'],
    notes: 'NVIDIA-hosted inference microservices at https://integrate.api.nvidia.com/v1, with reasoning template support.',
  },

  // ── direct vendor apis ───────────────────────────────────────────────
  {
    id: 'openai',
    name: 'OpenAI',
    group: 'vendors',
    setup: '/provider or env vars',
    envVars: ['OPENAI_API_KEY'],
    notes: 'Direct OpenAI API; supports key pools via OPENAI_API_KEYS with rotation on failure.',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    group: 'vendors',
    setup: '/provider or env vars',
    envVars: ['GEMINI_API_KEY'],
    notes: 'Gemini OpenAI-compatible endpoint; API key, access token, and ADC auth modes.',
  },
  {
    id: 'xai',
    name: 'xAI (API key)',
    group: 'vendors',
    setup: '/provider or env vars',
    envVars: ['XAI_API_KEY'],
    notes: 'Grok models at https://api.x.ai/v1; defaults to grok-4.6.',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    group: 'vendors',
    setup: '/provider or env vars',
    envVars: ['DEEPSEEK_API_KEY'],
    notes: 'DeepSeek OpenAI-compatible endpoint; defaults to deepseek-v4-pro.',
  },
  {
    id: 'moonshot',
    name: 'Moonshot AI (API)',
    group: 'vendors',
    setup: '/provider or env vars',
    envVars: ['MOONSHOT_API_KEY'],
    notes: 'Direct Moonshot API, including Kimi K3.',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    group: 'vendors',
    setup: '/provider or env vars',
    envVars: ['MINIMAX_API_KEY'],
    notes: 'Anthropic-compatible MiniMax endpoint; defaults to MiniMax-M3.',
  },
  {
    id: 'longcat',
    name: 'LongCat',
    group: 'vendors',
    setup: '/provider or env vars',
    envVars: ['LONGCAT_API_KEY'],
    notes: "Meituan's LongCat OpenAI-compatible API; defaults to LongCat-2.0.",
  },
  {
    id: 'xiaomi-mimo',
    name: 'Xiaomi MiMo',
    group: 'vendors',
    setup: '/provider or env vars',
    envVars: ['MIMO_API_KEY'],
    notes: 'OpenAI-compatible API at https://api.xiaomimimo.com/v1; defaults to mimo-v2.5-pro.',
    badge: 'sponsor',
  },
  {
    id: 'groq',
    name: 'Groq',
    group: 'vendors',
    setup: '/provider or env vars',
    envVars: ['GROQ_API_KEY'],
    notes: 'Ultra-low-latency OpenAI-compatible endpoint.',
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    group: 'vendors',
    setup: '/provider or env vars',
    envVars: ['MISTRAL_API_KEY'],
    notes: 'Mistral OpenAI-compatible endpoint.',
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    group: 'vendors',
    setup: '/provider or env vars',
    envVars: ['FIREWORKS_API_KEY'],
    notes: 'Hosted open models, including GLM 5.2.',
  },
  {
    id: 'together',
    name: 'Together AI',
    group: 'vendors',
    setup: '/provider or env vars',
    envVars: ['TOGETHER_API_KEY'],
    notes: 'Together chat/completions endpoint.',
  },
  {
    id: 'venice',
    name: 'Venice',
    group: 'vendors',
    setup: '/provider or env vars',
    envVars: ['VENICE_API_KEY'],
    notes: 'Privacy-focused OpenAI-compatible endpoint.',
  },

  // ── local inference ──────────────────────────────────────────────────
  {
    id: 'ollama',
    name: 'Ollama',
    group: 'local',
    setup: '/provider or env vars',
    notes: 'Local inference with no API key required; native context-window handling.',
  },
  {
    id: 'lm-studio',
    name: 'LM Studio',
    group: 'local',
    setup: '/provider or env vars',
    envVars: ['OPENAI_MODEL'],
    notes: 'Local OpenAI-compatible server at http://localhost:1234/v1.',
  },
  {
    id: 'atomic-chat',
    name: 'Atomic Chat',
    group: 'local',
    setup: '/provider',
    notes: 'Local model provider at http://127.0.0.1:1337/v1 with auto-detection of loaded models.',
  },

  // ── cloud routes & custom endpoints ──────────────────────────────────
  {
    id: 'cloud-routes',
    name: 'Bedrock / Vertex / Foundry',
    group: 'custom',
    setup: 'env vars',
    notes: 'Anthropic-family cloud routes. Vertex is for Claude on Vertex AI, not arbitrary Model Garden models.',
  },
  {
    id: 'azure-openai',
    name: 'Azure OpenAI',
    group: 'custom',
    setup: '/provider or env vars',
    envVars: ['AZURE_OPENAI_API_KEY'],
    notes: 'Azure OpenAI endpoint where the model name is your deployment name.',
  },
  {
    id: 'openai-compatible',
    name: 'Custom (OpenAI-compatible)',
    group: 'custom',
    setup: '/provider or env vars',
    envVars: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'],
    notes: 'Any compatible /v1 server — LiteLLM, vLLM, llama.cpp, or your own proxy.',
  },
  {
    id: 'anthropic-compatible',
    name: 'Custom (Anthropic-compatible)',
    group: 'custom',
    setup: '/provider or env vars',
    envVars: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'],
    notes: 'Any Anthropic Messages API-compatible provider.',
  },
]

export function providersInGroup(group: ProviderGroup): Provider[] {
  return providers.filter(p => p.group === group)
}
