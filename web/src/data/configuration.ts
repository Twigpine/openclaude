// Seeded from src/utils/envValidation.ts, src/utils/config.ts, and the README.

export interface SettingsFile {
  path: string
  scope: string
  notes: string
}

export const settingsFiles: SettingsFile[] = [
  {
    path: '~/.openclaude/settings.json',
    scope: 'user',
    notes: 'Default global settings path for every project on the machine; OPENCLAUDE_CONFIG_DIR moves this under the configured config home.',
  },
  {
    path: '.openclaude/settings.json',
    scope: 'project',
    notes: 'Shared project settings, committed to the repo.',
  },
  {
    path: '.openclaude/settings.local.json',
    scope: 'local',
    notes: 'Per-machine overrides for one project; typically gitignored.',
  },
  {
    path: '~/.openclaude/keybindings.json',
    scope: 'user',
    notes: 'Default keyboard shortcut overrides path; OPENCLAUDE_CONFIG_DIR moves this under the configured config home.',
  },
  {
    path: 'CLAUDE.md / .claude/CLAUDE.md',
    scope: 'project',
    notes: 'Project instructions loaded into context at session start.',
  },
]

export interface SettingOption {
  key: string
  description: string
}

export const settingOptions: SettingOption[] = [
  { key: 'model', description: "Default model (alias like 'sonnet' or a full model name)." },
  { key: 'effortLevel', description: 'Persisted effort level for supported models (low, medium, high, xhigh, max).' },
  { key: 'agent', description: 'Default agent for new sessions.' },
  { key: 'permissions', description: 'Allow/deny rules for tools, plus the default permission mode.' },
  { key: 'env', description: 'Environment variables applied to every session.' },
  { key: 'theme', description: 'Terminal color theme. Lives in the global config (~/.openclaude.json), not settings.json.' },
  { key: 'verbose', description: 'Verbose output by default. Lives in the global config (~/.openclaude.json), not settings.json.' },
  { key: 'autoUpdates', description: 'Enable or disable the auto-updater. Lives in the global config (~/.openclaude.json), not settings.json.' },
  { key: 'hooks', description: 'Shell hooks that run on tool events (PreToolUse, PostToolUse, …).' },
  { key: 'subscriptionType', description: "Override the active subscription type from user settings only. Allowed values: free, pro, max, team, enterprise. To prevent spoofing, this override ignores project, repository, local, flag, and policy settings. Setting this to 'free' is authoritative and takes precedence over OAuth or fallback authentication." },
  { key: 'smartRouting', description: 'Opt-in smart auto-routing: { enabled, simpleModel, strongModel } route simple turns to the configured simple model. Configure with /smartroute.' },
  { key: 'modelLimits', description: 'Per-model overrides for context window and max output tokens, for OpenAI-compatible models missing from the built-in catalog. Example: { "qwen3.6-plus": { "contextWindow": 1048576, "maxOutputTokens": 32768 } }' },
  { key: 'modelPricing', description: 'Exact, case-sensitive resolved-model USD pricing from user, local, --settings/SDK, or managed settings; shared project settings are ignored. Each entry requires inputTokens, outputTokens, promptCacheReadTokens, and promptCacheWriteTokens in USD per 1M tokens; webSearchRequests is USD per request, defaults to $0.01, and explicit zero is valid. Exact entries override built-in/fast pricing, then the existing unknown-model estimate applies. Limits: 256 entries, 512-character ids, $100,000/Mtok, and $1,000/web request. One exact key applies globally across routes/profiles. Example: { "modelPricing": { "nvidia/model": { "inputTokens": 0, "outputTokens": 0, "promptCacheReadTokens": 0, "promptCacheWriteTokens": 0, "webSearchRequests": 0 } } }.' },
  { key: 'providerFallbackChain', description: 'Ordered list of provider profile ids. On a rate-limit or quota error, OpenClaude advances to the next profile and retries the turn.' },
  { key: 'agentModels', description: 'Map of route key to provider connection info (base_url, api_key, model) for cross-provider agent routing.' },
  { key: 'agentRouting', description: 'Map of agent identifier to a model name from agentModels; use the "default" key as fallback.' },
  { key: 'advisorModel', description: 'Advisor model for the server-side advisor tool.' },
]

export interface EnvVar {
  name: string
  description: string
}

export const envVars: EnvVar[] = [
  { name: 'ANTHROPIC_API_KEY', description: 'Anthropic API key (also the strict auth path in --bare mode).' },
  { name: 'ANTHROPIC_AUTH_TOKEN', description: 'Bearer token alternative to an Anthropic API key.' },
  { name: 'ANTHROPIC_FIRST_PARTY_PROXY_HOSTS', description: 'Opt-in comma-separated list of loopback host:port entries that keep subscription (OAuth) auth when ANTHROPIC_BASE_URL points at a local transparent proxy.' },
  { name: 'OPENAI_API_KEY', description: 'Key for OpenAI-compatible providers and gateways (incl. Opengateway).' },
  { name: 'OPENAI_API_KEYS', description: 'Comma-separated key pool for OpenAI-compatible endpoints; rotates on failure and is checked before OPENAI_API_KEY.' },
  { name: 'OPENAI_BASE_URL', description: 'Base URL of an OpenAI-compatible /v1 endpoint (OpenRouter, LM Studio, LiteLLM, …).' },
  { name: 'OPENAI_MODEL', description: 'Model name to request from the OpenAI-compatible endpoint.' },
  { name: 'OPENGATEWAY_API_KEY', description: 'Twigpine Opengateway key (preferred over OPENAI_API_KEY for the gateway).' },
  { name: 'OPENGATEWAY_BASE_URL', description: 'Override the Opengateway base URL.' },
  { name: 'CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS', description: 'JSON map of model → context window; takes precedence over settings.modelLimits.' },
  { name: 'CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS', description: 'JSON map of model → max output tokens; takes precedence over settings.modelLimits.' },
  { name: 'GEMINI_API_KEY', description: 'Gemini API key (the preset reads this, not GOOGLE_API_KEY).' },
  { name: 'XAI_API_KEY', description: "xAI Grok key (or sign in with 'openclaude auth xai login')." },
  { name: 'AIMLAPI_API_KEY', description: 'AI/ML API key.' },
  { name: 'APISMART_API_KEY', description: 'ApiSmart gateway key; selects the ApiSmart route when no conflicting endpoint is configured.' },
  { name: 'APISMART_MODEL', description: 'Optional ApiSmart model override; defaults to DEEPSEEK_V4_FLASH.' },
  { name: 'CLOUDFLARE_API_TOKEN', description: 'Cloudflare Workers AI token.' },
  { name: 'NVIDIA_API_KEY', description: 'NVIDIA NIM key.' },
  { name: 'NEARAI_API_KEY', description: 'NEAR AI unified gateway key.' },
  { name: 'MIMO_API_KEY', description: 'Xiaomi MiMo API key.' },
  { name: 'OPENCODE_API_KEY', description: 'OpenCode Zen / Go gateway key.' },
  { name: 'GITHUB_TOKEN', description: 'GitHub token for GitHub Models and PR workflows.' },
  { name: 'OPENCLAUDE_CONFIG_DIR', description: 'Preferred config directory override. Defaults to ~/.openclaude when unset.' },
  { name: 'CLAUDE_CONFIG_DIR', description: 'Legacy config directory override. Used only when OPENCLAUDE_CONFIG_DIR is unset.' },
  { name: 'BASH_MAX_OUTPUT_LENGTH', description: 'Max characters of shell output shown inline before truncation (default 30000, cap 150000). Truncated runs save the captured output to a file the agent can read back (very large outputs may be capped).' },
  { name: 'HTTP_PROXY / HTTPS_PROXY', description: 'Route API traffic through a proxy.' },
  { name: 'NODE_EXTRA_CA_CERTS', description: 'Extra CA certificates for corporate TLS interception.' },
  { name: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', description: 'Disable non-essential network traffic.' },
  { name: 'OPENCLAUDE_SMART_ROUTING', description: 'Set to 1/true to enable smart auto-routing as a startup default (settings.smartRouting overrides it).' },
  { name: 'OPENCLAUDE_SMART_ROUTING_SIMPLE', description: 'agentModels key or model id used for turns classified "simple".' },
  { name: 'OPENCLAUDE_SMART_ROUTING_STRONG', description: 'agentModels key or model id used for "strong" turns and as the routed-error fallback.' },
]
