import type { ModelName } from './model.js'
import type { LegacyAPIProvider } from './providers.js'

// Transitional compatibility table keyed by the legacy provider categories
// returned from getAPIProvider(). Descriptor-native callers should prefer
// route/model metadata directly; this table exists for older provider-keyed
// consumers that have not been retired yet.
//
// Note: the `codex` keys are inert legacy compatibility entries. modelStrings.ts
// routes codex to the `openai` key, and the only real reader is
// getHardcodedTeammateModelFallback() (via CLAUDE_OPUS_4_8_CONFIG). We keep
// them in sync with the Codex runtime default (gpt-5.6-sol) for consistency.
export type LegacyProviderModelConfig = Record<LegacyAPIProvider, ModelName>

// Backward-compatible alias for existing imports.
export type ModelConfig = LegacyProviderModelConfig

// ---------------------------------------------------------------------------
// OpenAI-compatible model mappings
// Maps Claude model tiers to sensible defaults for popular providers.
// Override with OPENAI_MODEL, ANTHROPIC_MODEL, or settings.model
// ---------------------------------------------------------------------------
export const OPENAI_MODEL_DEFAULTS = {
  opus: 'gpt-4o',           // best reasoning
  sonnet: 'gpt-4o-mini',    // balanced
  haiku: 'gpt-4o-mini',     // fast & cheap
} as const

// ---------------------------------------------------------------------------
// Gemini model mappings
// Maps Claude model tiers to Google Gemini equivalents.
// Override with GEMINI_MODEL env var.
// ---------------------------------------------------------------------------
export const GEMINI_MODEL_DEFAULTS = {
  opus: 'gemini-2.5-pro',   // most capable
  sonnet: 'gemini-2.0-flash',              // balanced
  haiku: 'gemini-2.0-flash-lite',          // fast & cheap
} as const

// @[MODEL LAUNCH]: Add a new CLAUDE_*_CONFIG constant here. Double check the correct model strings
// here since the pattern may change.

export const CLAUDE_3_7_SONNET_CONFIG = {
  firstParty: 'claude-3-7-sonnet-20250219',
  bedrock: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
  vertex: 'claude-3-7-sonnet@20250219',
  foundry: 'claude-3-7-sonnet',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.0-flash',
  mistral: 'mistral-medium-latest',
  github: 'github:copilot',
  codex: 'gpt-5.6-sol',
  'nvidia-nim': 'nvidia/llama-3.1-nemotron-70b-instruct',
  minimax: 'MiniMax-M2.5',
  'xiaomi-mimo': 'mimo-v2.5-pro',
  xai: 'grok-4.6',
} as const satisfies LegacyProviderModelConfig

export const CLAUDE_3_5_V2_SONNET_CONFIG = {
  firstParty: 'claude-3-5-sonnet-20241022',
  bedrock: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  vertex: 'claude-3-5-sonnet-v2@20241022',
  foundry: 'claude-3-5-sonnet',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.0-flash',
  mistral: 'mistral-medium-latest',
  github: 'github:copilot',
  codex: 'gpt-5.6-sol',
  'nvidia-nim': 'nvidia/llama-3.1-nemotron-70b-instruct',
  minimax: 'MiniMax-M2.5',
  'xiaomi-mimo': 'mimo-v2.5-pro',
  xai: 'grok-4.6',
} as const satisfies LegacyProviderModelConfig

export const CLAUDE_3_5_HAIKU_CONFIG = {
  firstParty: 'claude-3-5-haiku-20241022',
  bedrock: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
  vertex: 'claude-3-5-haiku@20241022',
  foundry: 'claude-3-5-haiku',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.0-flash-lite',
  mistral: 'ministral-3b-latest',
  github: 'github:copilot',
  codex: 'gpt-5.6-sol',
  'nvidia-nim': 'nvidia/llama-3.1-nemotron-70b-instruct',
  minimax: 'MiniMax-M2.5',
  'xiaomi-mimo': 'mimo-v2.5-pro',
  xai: 'grok-4.6',
} as const satisfies LegacyProviderModelConfig

export const CLAUDE_HAIKU_4_5_CONFIG = {
  firstParty: 'claude-haiku-4-5-20251001',
  bedrock: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  vertex: 'claude-haiku-4-5@20251001',
  foundry: 'claude-haiku-4-5',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.0-flash-lite',
  mistral: 'ministral-3b-latest',
  github: 'github:copilot',
  codex: 'gpt-5.6-sol',
  'nvidia-nim': 'nvidia/llama-3.1-nemotron-70b-instruct',
  minimax: 'MiniMax-M2.5',
  'xiaomi-mimo': 'mimo-v2.5-pro',
  xai: 'grok-4.6',
} as const satisfies LegacyProviderModelConfig

export const CLAUDE_SONNET_4_CONFIG = {
  firstParty: 'claude-sonnet-4-20250514',
  bedrock: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
  vertex: 'claude-sonnet-4@20250514',
  foundry: 'claude-sonnet-4',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.0-flash',
  mistral: 'mistral-medium-latest',
  github: 'github:copilot',
  codex: 'gpt-5.6-sol',
  'nvidia-nim': 'nvidia/llama-3.1-nemotron-70b-instruct',
  minimax: 'MiniMax-M2.5',
  'xiaomi-mimo': 'mimo-v2.5-pro',
  xai: 'grok-4.6',
} as const satisfies LegacyProviderModelConfig

export const CLAUDE_SONNET_4_5_CONFIG = {
  firstParty: 'claude-sonnet-4-5-20250929',
  bedrock: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  vertex: 'claude-sonnet-4-5@20250929',
  foundry: 'claude-sonnet-4-5',
  openai: 'gpt-4o',
  gemini: 'gemini-2.0-flash',
  mistral: 'mistral-medium-latest',
  github: 'github:copilot',
  codex: 'gpt-5.6-sol',
  'nvidia-nim': 'nvidia/llama-3.1-nemotron-70b-instruct',
  minimax: 'MiniMax-M2.5',
  'xiaomi-mimo': 'mimo-v2.5-pro',
  xai: 'grok-4.6',
} as const satisfies LegacyProviderModelConfig

export const CLAUDE_OPUS_4_CONFIG = {
  firstParty: 'claude-opus-4-20250514',
  bedrock: 'us.anthropic.claude-opus-4-20250514-v1:0',
  vertex: 'claude-opus-4@20250514',
  foundry: 'claude-opus-4',
  openai: 'gpt-4o',
  gemini: 'gemini-2.5-pro',
  mistral: 'devstral-latest',
  github: 'github:copilot',
  codex: 'gpt-5.6-sol',
  'nvidia-nim': 'nvidia/llama-3.1-nemotron-70b-instruct',
  minimax: 'MiniMax-M2.5',
  'xiaomi-mimo': 'mimo-v2.5-pro',
  xai: 'grok-4.6',
} as const satisfies LegacyProviderModelConfig

export const CLAUDE_OPUS_4_1_CONFIG = {
  firstParty: 'claude-opus-4-1-20250805',
  bedrock: 'us.anthropic.claude-opus-4-1-20250805-v1:0',
  vertex: 'claude-opus-4-1@20250805',
  foundry: 'claude-opus-4-1',
  openai: 'gpt-4o',
  gemini: 'gemini-2.5-pro',
  mistral: 'devstral-latest',
  github: 'github:copilot',
  codex: 'gpt-5.6-sol',
  'nvidia-nim': 'nvidia/llama-3.1-nemotron-70b-instruct',
  minimax: 'MiniMax-M2.5',
  'xiaomi-mimo': 'mimo-v2.5-pro',
  xai: 'grok-4.6',
} as const satisfies LegacyProviderModelConfig

export const CLAUDE_OPUS_4_5_CONFIG = {
  firstParty: 'claude-opus-4-5-20251101',
  bedrock: 'us.anthropic.claude-opus-4-5-20251101-v1:0',
  vertex: 'claude-opus-4-5@20251101',
  foundry: 'claude-opus-4-5',
  openai: 'gpt-4o',
  gemini: 'gemini-2.5-pro',
  mistral: 'devstral-latest',
  github: 'github:copilot',
  codex: 'gpt-5.6-sol',
  'nvidia-nim': 'nvidia/llama-3.1-nemotron-70b-instruct',
  minimax: 'MiniMax-M2.5',
  'xiaomi-mimo': 'mimo-v2.5-pro',
  xai: 'grok-4.6',
} as const satisfies LegacyProviderModelConfig

export const CLAUDE_OPUS_4_6_CONFIG = {
  firstParty: 'claude-opus-4-6',
  bedrock: 'us.anthropic.claude-opus-4-6-v1',
  vertex: 'claude-opus-4-6',
  foundry: 'claude-opus-4-6',
  openai: 'gpt-4o',
  gemini: 'gemini-2.5-pro',
  mistral: 'devstral-latest',
  github: 'github:copilot',
  codex: 'gpt-5.6-sol',
  'nvidia-nim': 'nvidia/llama-3.1-nemotron-70b-instruct',
  minimax: 'MiniMax-M2.5',
  'xiaomi-mimo': 'mimo-v2.5-pro',
  xai: 'grok-4.6',
} as const satisfies LegacyProviderModelConfig

export const CLAUDE_OPUS_4_7_CONFIG = {
  firstParty: 'claude-opus-4-7',
  bedrock: 'us.anthropic.claude-opus-4-7-v1',
  vertex: 'claude-opus-4-7',
  foundry: 'claude-opus-4-7',
  openai: 'gpt-4o',
  gemini: 'gemini-2.5-pro',
  mistral: 'devstral-latest',
  github: 'github:copilot',
  codex: 'gpt-5.6-sol',
  'nvidia-nim': 'nvidia/llama-3.1-nemotron-70b-instruct',
  minimax: 'MiniMax-M2.5',
  'xiaomi-mimo': 'mimo-v2.5-pro',
  xai: 'grok-4.6',
} as const satisfies LegacyProviderModelConfig

export const CLAUDE_OPUS_4_8_CONFIG = {
  firstParty: 'claude-opus-4-8',
  bedrock: 'us.anthropic.claude-opus-4-8-v1',
  vertex: 'claude-opus-4-8',
  foundry: 'claude-opus-4-8',
  openai: 'gpt-4o',
  gemini: 'gemini-2.5-pro',
  mistral: 'devstral-latest',
  github: 'github:copilot',
  codex: 'gpt-5.6-sol',
  'nvidia-nim': 'nvidia/llama-3.1-nemotron-70b-instruct',
  minimax: 'MiniMax-M2.5',
  'xiaomi-mimo': 'mimo-v2.5-pro',
  xai: 'grok-4.6',
} as const satisfies LegacyProviderModelConfig

export const CLAUDE_SONNET_4_6_CONFIG = {
  firstParty: 'claude-sonnet-4-6',
  bedrock: 'us.anthropic.claude-sonnet-4-6',
  vertex: 'claude-sonnet-4-6',
  foundry: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  gemini: 'gemini-2.0-flash',
  mistral: 'mistral-medium-latest',
  github: 'github:copilot',
  codex: 'gpt-5.6-sol',
  'nvidia-nim': 'nvidia/llama-3.1-nemotron-70b-instruct',
  minimax: 'MiniMax-M2.5',
  'xiaomi-mimo': 'mimo-v2.5-pro',
  xai: 'grok-4.6',
} as const satisfies LegacyProviderModelConfig

// @[MODEL LAUNCH]: Register the new config here.
export const LEGACY_PROVIDER_MODEL_CONFIGS = {
  haiku35: CLAUDE_3_5_HAIKU_CONFIG,
  haiku45: CLAUDE_HAIKU_4_5_CONFIG,
  sonnet35: CLAUDE_3_5_V2_SONNET_CONFIG,
  sonnet37: CLAUDE_3_7_SONNET_CONFIG,
  sonnet40: CLAUDE_SONNET_4_CONFIG,
  sonnet45: CLAUDE_SONNET_4_5_CONFIG,
  sonnet46: CLAUDE_SONNET_4_6_CONFIG,
  opus40: CLAUDE_OPUS_4_CONFIG,
  opus41: CLAUDE_OPUS_4_1_CONFIG,
  opus45: CLAUDE_OPUS_4_5_CONFIG,
  opus46: CLAUDE_OPUS_4_6_CONFIG,
  opus47: CLAUDE_OPUS_4_7_CONFIG,
  opus48: CLAUDE_OPUS_4_8_CONFIG,
} as const satisfies Record<string, LegacyProviderModelConfig>

// Backward-compatible alias for existing imports.
export const ALL_MODEL_CONFIGS = LEGACY_PROVIDER_MODEL_CONFIGS

export type ModelKey = keyof typeof LEGACY_PROVIDER_MODEL_CONFIGS

/** Union of all canonical first-party model IDs, e.g. 'claude-opus-4-6' | 'claude-sonnet-4-5-20250929' | … */
export type CanonicalModelId =
  (typeof LEGACY_PROVIDER_MODEL_CONFIGS)[ModelKey]['firstParty']

/** Runtime list of canonical model IDs — used by comprehensiveness tests. */
export const CANONICAL_MODEL_IDS = Object.values(LEGACY_PROVIDER_MODEL_CONFIGS).map(
  c => c.firstParty,
) as [CanonicalModelId, ...CanonicalModelId[]]

/** Map canonical ID → internal short key. Used to apply settings-based modelOverrides. */
export const CANONICAL_ID_TO_KEY: Record<CanonicalModelId, ModelKey> =
  Object.fromEntries(
    (
      Object.entries(LEGACY_PROVIDER_MODEL_CONFIGS) as [
        ModelKey,
        LegacyProviderModelConfig,
      ][]
    ).map(
      ([key, cfg]) => [cfg.firstParty, key],
    ),
  ) as Record<CanonicalModelId, ModelKey>
