// src/integrations/descriptors.ts
// Core descriptor types for the integration registry.
// This file contains only type definitions — no runtime logic.

export type AuthMode = 'api-key' | 'oauth' | 'adc' | 'token' | 'none'

export type TransportKind =
  | 'anthropic-native'
  | 'anthropic-proxy'
  | 'openai-compatible'
  | 'local'
  | 'gemini-native'
  | 'bedrock'
  | 'vertex'

export type OpenAIShimTokenField = 'max_tokens' | 'max_completion_tokens'
export type OpenAIShimAuthScheme = 'bearer' | 'raw'

export interface OpenAIShimAuthHeaderConfig {
  name: string
  scheme?: OpenAIShimAuthScheme
}

export interface OpenAIShimUiConfig {
  showAuthHeader?: boolean
  showAuthHeaderValue?: boolean
  showCustomHeaders?: boolean
}

export interface OpenAIShimTransportConfig {
  headers?: Record<string, string>
  supportsApiFormatSelection?: boolean
  defaultApiFormat?: 'chat_completions' | 'responses' | 'responses_compat'
  requiredApiFormat?: 'chat_completions' | 'responses' | 'responses_compat'
  supportsAuthHeaders?: boolean
  ui?: OpenAIShimUiConfig
  defaultAuthHeader?: OpenAIShimAuthHeaderConfig
  responsesApiModelPrefixes?: string[]
  preserveReasoningContent?: boolean
  requireReasoningContentOnAssistantMessages?: boolean
  reasoningContentFallback?: '' | 'omit'
  thinkingRequestFormat?: 'none' | 'deepseek-compatible' | 'zai-compatible'
  enableToolStreaming?: boolean
  maxTokensField?: OpenAIShimTokenField
  removeBodyFields?: string[]
  /** Whether the endpoint accepts image content parts. Defaults to true. */
  supportsImageInputs?: boolean
  /** Override the endpoint path for this model (e.g., '/responses', '/messages'). */
  endpointPath?: string
}

export interface CapabilityFlags {
  supportsVision?: boolean
  supportsStreaming?: boolean
  supportsFunctionCalling?: boolean
  supportsJsonMode?: boolean
  supportsReasoning?: boolean
  supportsPreciseTokenCount?: boolean
  supportsEmbeddings?: boolean
}

export type ReasoningControlMode = 'levels' | 'toggle' | 'always-on'
export type ReasoningEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
/**
 * reasoning_effort, deepseek_compatible, and zai_compatible are wired into
 * request serialization today. Other values are reserved until their serializer
 * paths are implemented.
 */
export type ReasoningWireFormat =
  | 'reasoning_effort'
  | 'reasoning_object'
  | 'thinking_type'
  | 'deepseek_compatible'
  | 'zai_compatible'
  | 'none'
export type ReasoningDisableFormat = 'thinking_type_disabled'

export interface ReasoningControlMetadata {
  mode: ReasoningControlMode
  levels?: ReasoningEffortLevel[]
  defaultLevel?: ReasoningEffortLevel
  wireFormat?: ReasoningWireFormat
  disableFormat?: ReasoningDisableFormat
}

export interface TransportConfig {
  kind: TransportKind
  headers?: Record<string, string>
  openaiShim?: OpenAIShimTransportConfig
  anthropicProxy?: {
    supportsCustomHeaders?: boolean
  }
}

export interface CatalogTransportOverrides {
  openaiShim?: Partial<OpenAIShimTransportConfig>
}

export interface CacheConfig {
  supported?: boolean
  maxCachedTokens?: number
  cachePrefix?: string
}

export type ModelCatalogSource = 'static' | 'dynamic' | 'hybrid'
export type DurationString = `${number}m` | `${number}h` | `${number}d`
export type DiscoveryRefreshMode = 'manual' | 'on-open' | 'background-if-stale' | 'startup'
export type ReadinessProbeKind = 'ollama-generation' | 'openai-compatible-models'

export interface ModelCatalogEntry {
  id: string
  apiName: string
  aliases?: string[]
  label?: string
  default?: boolean
  hidden?: boolean
  /**
   * ISO-8601 instant after which the entry is dropped from catalog
   * resolution (model picker, gateway catalogs, runtime limits). For
   * time-boxed launches — e.g. a free window the gateway delists
   * server-side — so the picker never offers a model the gateway will
   * reject. An unparseable date fails open (the entry stays visible).
   */
  availableUntil?: string
  modelDescriptorId?: string
  capabilities?: CapabilityFlags
  reasoning?: ReasoningControlMetadata
  contextWindow?: number
  maxOutputTokens?: number
  transportOverrides?: CatalogTransportOverrides
  notes?: string
}

export interface ModelCatalogConfig {
  source: ModelCatalogSource
  discovery?: ModelDiscoveryConfig
  discoveryCacheTtl?: DurationString | number
  discoveryRefreshMode?: DiscoveryRefreshMode
  allowManualRefresh?: boolean
  models?: ModelCatalogEntry[]
}

export type ModelDiscoveryKind = 'openai-compatible' | 'ollama' | 'custom'

export interface ModelDiscoveryConfig {
  kind: ModelDiscoveryKind
  requiresAuth?: boolean
  path?: string
  parse?: 'openai-models-list' | 'ollama-tags' | 'custom'
  mapModel?: (raw: unknown) => ModelCatalogEntry | null
}

export interface SetupMetadata {
  requiresAuth: boolean
  authMode: AuthMode
  credentialEnvVars?: string[]
  /**
   * Restrict credential resolution to credentialEnvVars. Without this,
   * openai-compatible routes also accept OPENAI_API_KEY, which can send a
   * generic key belonging to another provider to this route's endpoint.
   */
  dedicatedCredentialsOnly?: boolean
  setupPrompt?: string
}

export interface StartupMetadata {
  autoDetectable?: boolean
  probeReadiness?: ReadinessProbeKind
  enablementEnvVar?: string
}

export interface UsageMetadata {
  supported: boolean
  delegateToVendorId?: string
  delegateToGatewayId?: string
  fetchModule?: string
  parseModule?: string
  ui?: {
    showResetCountdown?: boolean
    compactProgressBar?: boolean
    fallbackMessage?: string
  }
  silentlyIgnore?: boolean
}

export interface InvalidCredentialValue {
  envVar: string
  value: string
  message: string
}

export interface ValidationRoutingMetadata {
  enablementEnvVar?: string
  matchDefaultBaseUrl?: boolean
  matchBaseUrlHosts?: string[]
  fallbackWhenUseOpenAI?: boolean
  skipWhenUseOpenAI?: boolean
}

export interface PresetBadge {
  text: string
  color?: string
}

export interface ProviderPresetMetadata {
  id: string
  description: string
  label?: string
  name?: string
  vendorId?: string
  apiKeyEnvVars?: string[]
  baseUrlEnvVars?: string[]
  modelEnvVars?: string[]
  fallbackBaseUrl?: string
  fallbackModel?: string
  badge?: PresetBadge
}

export type ProviderPresetRouteKind =
  | 'vendor'
  | 'gateway'
  | 'anthropic-proxy'

export interface ProviderPresetManifestEntry {
  preset: string
  routeKind: ProviderPresetRouteKind
  routeId: string
  vendorId: string
  gatewayId?: string
  description: string
  label?: string
  name?: string
  apiKeyEnvVars?: readonly string[]
  baseUrlEnvVars?: readonly string[]
  modelEnvVars?: readonly string[]
  fallbackBaseUrl?: string
  fallbackModel?: string
  badge?: PresetBadge
}

export type ValidationMetadata =
  | {
      routing?: ValidationRoutingMetadata
      kind: 'credential-env'
      credentialEnvVars: string[]
      allowLocalBaseUrlWithoutCredential?: boolean
      missingCredentialMessage?: string
      invalidCredentialValues?: InvalidCredentialValue[]
    }
  | {
      routing?: ValidationRoutingMetadata
      kind: 'gemini-credential'
      missingCredentialMessage: string
    }
  | {
      routing?: ValidationRoutingMetadata
      kind: 'github-token'
      missingCredentialMessage: string
      expiredCredentialMessage: string
      invalidCredentialMessage: string
    }
  // xAI accepts either an API key (XAI_API_KEY) or stored OAuth
  // credentials (browser/device-code login). Validation passes when any of
  // the following hold:
  //   1. one of `credentialEnvVars` is non-empty in env
  //   2. one of `credentialSourceEnvMarkers` matches in env (e.g.
  //      XAI_CREDENTIAL_SOURCE=oauth, set by the OAuth profile)
  //   3. stored OAuth credentials exist (resolved async via the runtime)
  | {
      routing?: ValidationRoutingMetadata
      kind: 'xai-credential'
      credentialEnvVars: string[]
      credentialSourceEnvMarkers?: Record<string, string[]>
      missingCredentialMessage: string
    }

export interface VendorDescriptor {
  id: string
  label: string
  classification: 'anthropic' | 'openai-compatible' | 'native'
  defaultBaseUrl: string
  defaultModel: string
  requiredEnvVars?: string[]
  validate?: (env: NodeJS.ProcessEnv) => string | null
  setup: SetupMetadata
  startup?: StartupMetadata
  isFirstParty?: boolean
  transportConfig: TransportConfig
  catalog?: ModelCatalogConfig
  usage?: UsageMetadata
  validation?: ValidationMetadata
  preset?: ProviderPresetMetadata
}

export interface GatewayDescriptor {
  id: string
  label: string
  vendorId?: string
  category?: 'local' | 'hosted' | 'aggregating'
  defaultBaseUrl?: string
  defaultModel?: string
  supportsModelRouting?: boolean
  setup: SetupMetadata
  startup?: StartupMetadata
  transportConfig: TransportConfig
  catalog?: ModelCatalogConfig
  usage?: UsageMetadata
  validation?: ValidationMetadata
  preset?: ProviderPresetMetadata
}

export interface AnthropicProxyDescriptor {
  id: string
  label: string
  classification: 'anthropic-proxy'
  defaultBaseUrl: string
  defaultModel: string
  requiredEnvVars?: string[]
  validate?: (env: NodeJS.ProcessEnv) => string | null
  setup: SetupMetadata
  startup?: StartupMetadata
  envVarConfig: {
    authTokenEnvVar: string
    baseUrlEnvVar: string
    modelEnvVar?: string
  }
  capabilities: CapabilityFlags
  transportConfig: TransportConfig
  catalog?: ModelCatalogConfig
  usage?: UsageMetadata
  validation?: ValidationMetadata
  preset?: ProviderPresetMetadata
}

export interface BrandDescriptor {
  id: string
  label: string
  canonicalVendorId: string
  defaultContextWindow?: number
  defaultMaxOutputTokens?: number
  defaultCapabilities: CapabilityFlags
  modelIds?: string[]
}

export interface ModelDescriptor {
  id: string
  label: string
  brandId?: string
  vendorId: string
  gatewayId?: string
  classification: ('chat' | 'reasoning' | 'vision' | 'coding')[]
  defaultModel: string
  providerModelMap?: Partial<Record<string, string>>
  capabilities: CapabilityFlags
  reasoning?: ReasoningControlMetadata
  contextWindow?: number
  maxOutputTokens?: number
  /**
   * Restrict shared runtime metadata to catalog entries that explicitly
   * reference this descriptor. Omit for the legacy global model-name fallback.
   */
  runtimeMetadataScope?: 'global' | 'catalog'
  cacheConfig?: CacheConfig
}

export interface RegistryValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}
