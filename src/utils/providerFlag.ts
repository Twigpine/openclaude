/**
 * --provider CLI flag support.
 *
 * Maps the user-friendly provider name to the environment variables
 * that the rest of the codebase uses for provider detection.
 *
 * Usage:
 *   openclaude --provider openai --model gpt-4o
 *   openclaude --provider gemini --model gemini-2.0-flash
 *   openclaude --provider mistral --model ministral-3b-latest
 *   openclaude --provider ollama --model llama3.2
 *   openclaude --provider anthropic   (default, no-op)
 */

import '../integrations/index.js'
import {
  ensureIntegrationsLoaded,
  getAnthropicProxy,
  getAllAnthropicProxies,
  getAllGateways,
  getAllVendors,
  getGateway,
  getVendor,
  isCloudflareBaseUrl,
  isLongcatBaseUrl,
  routeSupportsApiFormatSelection,
  routeSupportsAuthHeaders,
  resolveProfileRoute,
  resolveRouteIdFromBaseUrl,
} from '../integrations/index.js'
import { PRESET_VENDOR_MAP } from '../integrations/compatibility.js'
import { getCommandcodeChatCompletionsModelError } from '../integrations/gateways/commandcode.js'
import {
  isCanonicalApiRouteInferenceBaseUrl,
  isCanonicalApismartInferenceBaseUrl,
  isCanonicalConcentrateInferenceBaseUrl,
  isCanonicalLlmtrInferenceBaseUrl,
  isCanonicalCommandcodeInferenceBaseUrl,
  isGmiCloudBaseUrl,
  resolveActiveRouteIdFromEnv,
} from '../integrations/routeMetadata.js'
import { hasUsableOpenAICredential } from '../services/api/credentialPool.js'
import { isFirstPartyAnthropicBaseUrlForEnv } from './anthropicBaseUrl.js'
import { parseModelFlagValue } from './cliArgs.js'
import {
  argsBeforeModelOwningSubcommand,
  parseRootOptionValue,
} from './printFlag.js'

const PREFERRED_PROVIDER_ORDER = [
  'anthropic',
  'bankr',
  'zai',
  'xai',
  'xiaomi-mimo',
  'openai',
  'gemini',
  'mistral',
  'github',
  'bedrock',
  'vertex',
  'ollama',
  'nvidia-nim',
  'minimax',
  'venice',
  'atlas-cloud',
  'gmi-cloud',
  'nearai',
  'fireworks',
  'longcat',
] as const

function buildValidProviders(): string[] {
  ensureIntegrationsLoaded()

  const discovered = new Set<string>([
    ...PRESET_VENDOR_MAP.map(mapping => mapping.preset),
    ...getAllVendors().map(vendor => vendor.id),
    ...getAllGateways().map(gateway => gateway.id),
    ...getAllAnthropicProxies().map(proxy => proxy.id),
  ])

  const preferred = PREFERRED_PROVIDER_ORDER.filter(provider =>
    discovered.has(provider),
  )
  const remainder = Array.from(discovered)
    .filter(provider => !preferred.includes(provider as (typeof PREFERRED_PROVIDER_ORDER)[number]))
    .sort()

  return [...preferred, ...remainder]
}

export const VALID_PROVIDERS = buildValidProviders()

export type ProviderFlagName = string

let rememberedProviderFlag:
  | {
      provider: string
      model?: string
    }
  | null = null

/**
 * Extract the value of --provider from argv.
 * Returns null if the flag is absent or has no value.
 */
export function parseProviderFlag(args: string[]): string | null {
  return parseRootOptionValue(args, '--provider') ?? null
}

/**
 * Parse and apply --provider from argv in one step.
 * Returns undefined when the flag is absent.
 */
export function applyProviderFlagFromArgs(
  args: string[],
  options?: {
    rememberForSettingsEnv?: boolean
  },
): { error?: string } | undefined {
  const provider = parseProviderFlag(args)
  if (!provider) return undefined
  const result = applyProviderFlag(provider, args)
  if (!result.error && options?.rememberForSettingsEnv) {
    const model = parseProviderModelFlag(args)
    rememberedProviderFlag = model ? { provider, model } : { provider }
  }
  return result
}

export function reapplyRememberedProviderFlag():
  | { error?: string }
  | undefined {
  if (!rememberedProviderFlag) return undefined

  const args = ['--provider', rememberedProviderFlag.provider]
  if (rememberedProviderFlag.model) {
    args.push('--model', rememberedProviderFlag.model)
  }

  return applyProviderFlag(rememberedProviderFlag.provider, args)
}

export function clearRememberedProviderFlagForTests(): void {
  rememberedProviderFlag = null
}

/**
 * Extract the value of --model from argv.
 * Returns null if absent.
 */
export function parseModelFlag(args: string[]): string | null {
  return parseModelFlagValue(args) ?? null
}

function parseProviderModelFlag(args: string[]): string | null {
  return parseModelFlag(argsBeforeModelOwningSubcommand(args))
}

function getRouteDefaults(provider: string): {
  defaultBaseUrl?: string
  defaultModel?: string
} {
  ensureIntegrationsLoaded()

  const route = resolveProfileRoute(provider)
  const vendor =
    getVendor(route.vendorId) ??
    (route.routeId !== route.vendorId ? getVendor(route.routeId) : undefined)
  const gateway =
    (route.gatewayId ? getGateway(route.gatewayId) : undefined) ??
    getGateway(route.routeId)
  const anthropicProxy = getAnthropicProxy(route.routeId)

  const defaultModel = gateway?.defaultModel ?? vendor?.defaultModel ?? anthropicProxy?.defaultModel

  return {
    defaultBaseUrl: gateway?.defaultBaseUrl ?? vendor?.defaultBaseUrl ?? anthropicProxy?.defaultBaseUrl,
    defaultModel,
  }
}

function normalizeBaseUrlEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) {
    return undefined
  }
  const normalized = trimmed.toLowerCase()
  // dotenv / shell sentinels are not usable endpoints. Treating them as
  // configured would preserve an invalid OPENAI_BASE_URL and block dedicated
  // provider defaults (for example ApiSmart key mirroring).
  return normalized === 'undefined' || normalized === 'null'
    ? undefined
    : trimmed
}

function getConfiguredOpenAIBaseUrl(): string | undefined {
  const baseUrl = normalizeBaseUrlEnv(process.env.OPENAI_BASE_URL)
  if (baseUrl) {
    return baseUrl
  }

  return normalizeBaseUrlEnv(process.env.OPENAI_API_BASE)
}

function shouldReplaceStaleKnownBaseUrl(provider: string): boolean {
  const currentRouteId = resolveRouteIdFromBaseUrl(
    getConfiguredOpenAIBaseUrl(),
  )
  if (!currentRouteId) {
    return false
  }

  const targetRouteId = resolveProfileRoute(provider).routeId
  return (
    targetRouteId !== 'custom' &&
    targetRouteId !== 'unknown-fallback' &&
    currentRouteId !== targetRouteId
  )
}

// Descriptor defaults can carry an unresolved `<...>` placeholder that the user
// must replace before the endpoint works — e.g. Cloudflare Workers AI's
// `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1`. Seeding it
// verbatim would leave the shortcut "configured" with an endpoint that cannot
// serve a single request.
function isPlaceholderBaseUrl(baseUrl: string): boolean {
  return /<[^>]+>/.test(baseUrl)
}

function applyOpenAIBaseUrlDefault(provider: string, baseUrl?: string): void {
  const normalizedBaseUrl = baseUrl?.trim()
  if (!normalizedBaseUrl) {
    return
  }

  // Never seed an unresolved placeholder endpoint. The user must supply a real
  // base URL (via `OPENAI_BASE_URL` or the `/provider` baseUrl edit) first; the
  // `/provider` wizard treats such defaults as requiring explicit setup, and
  // the CLI shortcut should not silently install a broken endpoint.
  if (isPlaceholderBaseUrl(normalizedBaseUrl)) {
    return
  }

  if (
    !getConfiguredOpenAIBaseUrl() ||
    shouldReplaceStaleKnownBaseUrl(provider)
  ) {
    process.env.OPENAI_BASE_URL = normalizedBaseUrl
  }
}

function clearUnsupportedOpenAIShimSettings(routeId: string): void {
  if (!routeSupportsApiFormatSelection(routeId)) {
    delete process.env.OPENAI_API_FORMAT
  }
  if (!routeSupportsAuthHeaders(routeId)) {
    delete process.env.OPENAI_AUTH_HEADER
    delete process.env.OPENAI_AUTH_SCHEME
    delete process.env.OPENAI_AUTH_HEADER_VALUE
  }
}

function clearConcentrateProviderState(): void {
  delete process.env.CONCENTRATE_API_KEY
  delete process.env.CONCENTRATE_BASE_URL
  delete process.env.CONCENTRATE_MODEL
}

function usableProviderModelEnvValue(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  const normalized = trimmed.toLowerCase()
  return normalized === 'undefined' || normalized === 'null'
    ? undefined
    : trimmed
}

/**
 * Apply --model (without --provider) to process.env for the current process only.
 *
 * Issue #808: `openclaude --model <name>` should work standalone so users can
 * override the session model without reconfiguring a profile or polluting the
 * shell with OPENAI_MODEL=... Must run before the startup banner so the
 * displayed model matches the flag, and before resolution paths that read the
 * provider-specific *_MODEL env var directly.
 *
 * Routes the value to the env var matching the already-active provider
 * (detected from CLAUDE_CODE_USE_* vars set by saved profile or env). Returns
 * undefined when --model is absent or --provider is present (that path is
 * handled by applyProviderFlagFromArgs).
 */
export function applyModelFlagFromArgs(
  args: string[],
): { error?: string } | undefined {
  if (parseProviderFlag(args)) return
  const model = parseModelFlag(args)
  if (!model) return

  const activeRouteId = resolveActiveRouteIdFromEnv(process.env)
  const effectiveModel =
    activeRouteId === 'commandcode' && model === 'default'
      ? getRouteDefaults('commandcode').defaultModel ?? model
      : model

  if (activeRouteId === 'commandcode') {
    const error = getCommandcodeChatCompletionsModelError(effectiveModel)
    if (error) return { error }
  }

  const useGemini =
    process.env.CLAUDE_CODE_USE_GEMINI === '1' ||
    process.env.CLAUDE_CODE_USE_GEMINI === 'true'
  const useMistral =
    process.env.CLAUDE_CODE_USE_MISTRAL === '1' ||
    process.env.CLAUDE_CODE_USE_MISTRAL === 'true'
  const useOpenAI =
    process.env.CLAUDE_CODE_USE_OPENAI === '1' ||
    process.env.CLAUDE_CODE_USE_OPENAI === 'true'
  const useGithub =
    process.env.CLAUDE_CODE_USE_GITHUB === '1' ||
    process.env.CLAUDE_CODE_USE_GITHUB === 'true'

  if (useGemini) {
    process.env.GEMINI_MODEL = effectiveModel
  } else if (useMistral) {
    process.env.MISTRAL_MODEL = effectiveModel
  } else if (useOpenAI || useGithub) {
    process.env.OPENAI_MODEL = effectiveModel
  } else {
    process.env.ANTHROPIC_MODEL = effectiveModel
  }

  return {}
}

/**
 * Apply a provider name to process.env.
 * Sets the required CLAUDE_CODE_USE_* flag and any provider-specific
 * defaults (Ollama base URL, model routing). Preserves explicit custom
 * endpoint env vars for descriptor-backed defaults, while replacing stale
 * known provider endpoints when the user explicitly chooses a different
 * descriptor-backed provider.
 *
 * Returns { error } if the provider name is not recognized.
 */
export function applyProviderFlag(
  provider: string,
  args: string[],
): { error?: string } {
  if (!VALID_PROVIDERS.includes(provider)) {
    return {
      error: `Unknown provider "${provider}". Valid providers: ${VALID_PROVIDERS.join(', ')}`,
    }
  }

  const model = parseProviderModelFlag(args)
  const { defaultBaseUrl, defaultModel } = getRouteDefaults(provider)
  const effectiveModel =
    provider === 'commandcode' && model === 'default'
      ? defaultModel ?? model
      : model
  if (provider === 'commandcode') {
    const currentBaseUrl = getConfiguredOpenAIBaseUrl()
    const willUseCommandcodeEndpoint =
      !currentBaseUrl ||
      shouldReplaceStaleKnownBaseUrl(provider) ||
      isCanonicalCommandcodeInferenceBaseUrl(currentBaseUrl)
    const error = willUseCommandcodeEndpoint
      ? getCommandcodeChatCompletionsModelError(
          effectiveModel ?? process.env.OPENAI_MODEL ?? defaultModel,
        )
      : null
    if (error) return { error }
  }

  const opengatewayApiKey = process.env.OPENGATEWAY_API_KEY?.trim()
  const copiedOpenAIKeyProvider =
    process.env.OPENAI_API_KEY !== undefined &&
    process.env.OPENAI_API_KEY === process.env.NVIDIA_API_KEY &&
    process.env.NVIDIA_NIM === '1'
      ? 'nvidia-nim'
      : process.env.OPENAI_API_KEY !== undefined &&
          process.env.OPENAI_API_KEY === process.env.BNKR_API_KEY
        ? 'bankr'
        : process.env.OPENAI_API_KEY !== undefined &&
            process.env.OPENAI_API_KEY === process.env.XAI_API_KEY
          ? 'xai'
          : process.env.OPENAI_API_KEY !== undefined &&
              process.env.OPENAI_API_KEY === process.env.MIMO_API_KEY
            ? 'xiaomi-mimo'
            : process.env.OPENAI_API_KEY !== undefined &&
                process.env.OPENAI_API_KEY === process.env.VENICE_API_KEY
              ? 'venice'
              : process.env.OPENAI_API_KEY !== undefined &&
                  process.env.OPENAI_API_KEY === process.env.MINIMAX_API_KEY
                ? 'minimax'
                  : process.env.OPENAI_API_KEY !== undefined &&
                      process.env.OPENAI_API_KEY === process.env.ATLAS_CLOUD_API_KEY
                    ? 'atlas-cloud'
                      : process.env.OPENAI_API_KEY !== undefined &&
                          process.env.OPENAI_API_KEY === process.env.GMI_API_KEY
                        ? 'gmi-cloud'
                      : process.env.OPENAI_API_KEY !== undefined &&
                          process.env.OPENAI_API_KEY === process.env.APISMART_API_KEY
                        ? 'apismart'
                        : process.env.OPENAI_API_KEY !== undefined &&
                          process.env.OPENAI_API_KEY === process.env.API_ROUTE_API_KEY
                        ? 'api-route'
                        : process.env.OPENAI_API_KEY !== undefined &&
                          process.env.OPENAI_API_KEY === process.env.CONCENTRATE_API_KEY
                        ? 'concentrate'
                        : process.env.OPENAI_API_KEY !== undefined &&
                          process.env.OPENAI_API_KEY === process.env.LLMTR_API_KEY
                        ? 'llmtr'
                        : process.env.OPENAI_API_KEY !== undefined &&
                          (process.env.OPENAI_API_KEY === process.env.CMD_API_KEY ||
                            process.env.OPENAI_API_KEY ===
                              process.env.COMMANDCODE_API_KEY ||
                            process.env.OPENAI_API_KEY ===
                              process.env.COMMAND_CODE_API_KEY)
                        ? 'commandcode'
                        : process.env.OPENAI_API_KEY !== undefined &&
                          process.env.OPENAI_API_KEY === process.env.NEARAI_API_KEY
                        ? 'nearai'
                        : process.env.OPENAI_API_KEY !== undefined &&
                          process.env.OPENAI_API_KEY === process.env.FIREWORKS_API_KEY
                        ? 'fireworks'
                        : process.env.OPENAI_API_KEY !== undefined &&
                          process.env.OPENAI_API_KEY === process.env.LONGCAT_API_KEY
                        ? 'longcat'
                      : process.env.OPENAI_API_KEY !== undefined &&
                      opengatewayApiKey !== undefined &&
                      opengatewayApiKey.length > 0 &&
                      process.env.OPENAI_API_KEY === opengatewayApiKey
                    ? 'gitlawb-opengateway'
                    : process.env.OPENAI_API_KEY !== undefined &&
                        process.env.OPENAI_API_KEY === process.env.CLOUDFLARE_API_TOKEN
                      ? 'cloudflare'
                      : null

  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.NVIDIA_NIM
  if (copiedOpenAIKeyProvider && provider !== copiedOpenAIKeyProvider) {
    delete process.env.OPENAI_API_KEY
  }

  // Azure-style routing changes both request paths and authentication. It is
  // only meaningful for an explicit OpenAI/Azure configuration, so never let
  // it follow a provider switch to another OpenAI-compatible endpoint.
  if (provider !== 'openai') {
    delete process.env.OPENAI_AZURE_STYLE
  }

  switch (provider) {
    case 'anthropic': {
      // Default — clear any custom native proxy contract so this explicit
      // provider flag cannot keep routing requests to a prior endpoint.
      // Preserve a first-party API key: it is the normal credential for this
      // provider and may have been supplied directly through the environment.
      const hadCustomAnthropicEndpoint =
        !isFirstPartyAnthropicBaseUrlForEnv(process.env)
      delete process.env.ANTHROPIC_BASE_URL
      delete process.env.ANTHROPIC_MODEL
      if (hadCustomAnthropicEndpoint) {
        delete process.env.ANTHROPIC_API_KEY
      }
      // `--provider anthropic` is an explicit selection even though the
      // default provider has no positive mode flag. Do not let a dedicated
      // OpenAI-compatible env-only route override it later in startup.
      delete process.env.APISMART_API_KEY
      delete process.env.APISMART_MODEL
      delete process.env.API_ROUTE_API_KEY
      delete process.env.API_ROUTE_MODEL
      delete process.env.ANTHROPIC_AUTH_TOKEN
      delete process.env.ANTHROPIC_CUSTOM_HEADERS
      break
    }

    case 'custom-anthropic':
      if (!process.env.ANTHROPIC_BASE_URL?.trim()) {
        return {
          error: 'Custom Anthropic-compatible provider requires ANTHROPIC_BASE_URL.',
        }
      }
      if (isFirstPartyAnthropicBaseUrlForEnv(process.env)) {
        return {
          error: 'Custom Anthropic-compatible provider requires a non-Anthropic ANTHROPIC_BASE_URL.',
        }
      }
      const hasAuthToken = Boolean(process.env.ANTHROPIC_AUTH_TOKEN?.trim())
      const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim())
      if (!hasAuthToken && !hasApiKey) {
        return {
          error: 'Custom Anthropic-compatible provider requires ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY.',
        }
      }
      if (hasAuthToken) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        delete process.env.ANTHROPIC_AUTH_TOKEN
      }
      delete process.env.OPENAI_BASE_URL
      delete process.env.OPENAI_API_BASE
      delete process.env.OPENAI_MODEL
      delete process.env.OPENAI_API_FORMAT
      delete process.env.OPENAI_AZURE_STYLE
      delete process.env.OPENAI_AUTH_HEADER
      delete process.env.OPENAI_AUTH_SCHEME
      delete process.env.OPENAI_AUTH_HEADER_VALUE
      process.env.ANTHROPIC_MODEL ??= defaultModel
      if (model) process.env.ANTHROPIC_MODEL = model
      break

    case 'openai':
      process.env.CLAUDE_CODE_USE_OPENAI = '1'
      // An explicit generic OpenAI selection must not be reclassified as a
      // dedicated env-only gateway during client startup. Replace a previous
      // known gateway endpoint, but preserve a user-supplied custom endpoint.
      delete process.env.APISMART_API_KEY
      delete process.env.APISMART_MODEL
      delete process.env.API_ROUTE_API_KEY
      delete process.env.API_ROUTE_MODEL
      applyOpenAIBaseUrlDefault(provider, defaultBaseUrl)
      if (effectiveModel) process.env.OPENAI_MODEL = effectiveModel
      break

    case 'gemini':
      process.env.CLAUDE_CODE_USE_GEMINI = '1'
      if (model) process.env.GEMINI_MODEL = model
      break

    case 'mistral':
      process.env.CLAUDE_CODE_USE_MISTRAL = '1'
      if (model) process.env.MISTRAL_MODEL = model
      break

    case 'github':
      process.env.CLAUDE_CODE_USE_GITHUB = '1'
      if (model) process.env.OPENAI_MODEL = model
      break

    case 'bedrock':
      process.env.CLAUDE_CODE_USE_BEDROCK = '1'
      break

    case 'vertex':
      process.env.CLAUDE_CODE_USE_VERTEX = '1'
      break

    case 'ollama':
      process.env.CLAUDE_CODE_USE_OPENAI = '1'
      applyOpenAIBaseUrlDefault(
        provider,
        defaultBaseUrl ?? 'http://localhost:11434/v1',
      )
      if (!process.env.OPENAI_API_KEY) {
        process.env.OPENAI_API_KEY = 'ollama'
      }
      if (model) process.env.OPENAI_MODEL = model
      break

    case 'nvidia-nim':
      process.env.CLAUDE_CODE_USE_OPENAI = '1'
      applyOpenAIBaseUrlDefault(
        provider,
        defaultBaseUrl ?? 'https://integrate.api.nvidia.com/v1',
      )
      process.env.NVIDIA_NIM = '1'
      if (process.env.NVIDIA_API_KEY && !process.env.OPENAI_API_KEY) {
        process.env.OPENAI_API_KEY = process.env.NVIDIA_API_KEY
      }
      process.env.OPENAI_MODEL ??= 'nvidia/llama-3.1-nemotron-70b-instruct'
      if (model) process.env.OPENAI_MODEL = model
      break

    case 'bankr':
      process.env.CLAUDE_CODE_USE_OPENAI = '1'
      applyOpenAIBaseUrlDefault(
        provider,
        defaultBaseUrl ?? 'https://llm.bankr.bot/v1',
      )
      process.env.OPENAI_MODEL ??= 'claude-opus-4.6'
      if (model) process.env.OPENAI_MODEL = model
      if (process.env.BNKR_API_KEY && !process.env.OPENAI_API_KEY) {
        process.env.OPENAI_API_KEY = process.env.BNKR_API_KEY
      }
      break

    case 'minimax':
      delete process.env.OPENAI_BASE_URL
      delete process.env.OPENAI_API_BASE
      delete process.env.OPENAI_MODEL
      delete process.env.OPENAI_API_FORMAT
      delete process.env.OPENAI_AZURE_STYLE
      delete process.env.OPENAI_AUTH_HEADER
      delete process.env.OPENAI_AUTH_SCHEME
      delete process.env.OPENAI_AUTH_HEADER_VALUE
      process.env.ANTHROPIC_BASE_URL = defaultBaseUrl ?? 'https://api.minimax.io/anthropic'
      process.env.ANTHROPIC_MODEL = defaultModel ?? 'MiniMax-M3'
      if (model) process.env.ANTHROPIC_MODEL = model
      if (process.env.MINIMAX_API_KEY && !process.env.ANTHROPIC_API_KEY) {
        process.env.ANTHROPIC_API_KEY = process.env.MINIMAX_API_KEY
      }
      if (copiedOpenAIKeyProvider === 'minimax') {
        delete process.env.OPENAI_API_KEY
      }
      break

    case 'gitlawb-opengateway':
      process.env.CLAUDE_CODE_USE_OPENAI = '1'
      if (process.env.OPENGATEWAY_BASE_URL?.trim()) {
        process.env.OPENAI_BASE_URL = process.env.OPENGATEWAY_BASE_URL.trim()
      } else {
        applyOpenAIBaseUrlDefault(
          provider,
          defaultBaseUrl ?? 'https://opengateway.gitlawb.com/v1',
        )
      }
      process.env.OPENAI_MODEL ??= defaultModel ?? 'mimo-v2.5-pro'
      if (model) process.env.OPENAI_MODEL = model
      if (opengatewayApiKey) {
        process.env.OPENAI_API_KEY = opengatewayApiKey
      }
      break

    case 'nearai':
      process.env.CLAUDE_CODE_USE_OPENAI = '1'
      applyOpenAIBaseUrlDefault(provider, defaultBaseUrl)
      if (defaultModel) {
        process.env.OPENAI_MODEL ??= defaultModel
      }
      if (model) process.env.OPENAI_MODEL = model
      if (process.env.NEARAI_API_KEY) {
        process.env.OPENAI_API_KEY = process.env.NEARAI_API_KEY
      } else {
        delete process.env.OPENAI_API_KEY
      }
      break

    case 'xai':
      process.env.CLAUDE_CODE_USE_OPENAI = '1'
      applyOpenAIBaseUrlDefault(provider, defaultBaseUrl ?? 'https://api.x.ai/v1')
      process.env.OPENAI_MODEL ??= defaultModel ?? 'grok-4.6'
      if (model) process.env.OPENAI_MODEL = model
      if (process.env.XAI_API_KEY && !process.env.OPENAI_API_KEY) {
        process.env.OPENAI_API_KEY = process.env.XAI_API_KEY
      }
      break

    case 'xiaomi-mimo':
      process.env.CLAUDE_CODE_USE_OPENAI = '1'
      applyOpenAIBaseUrlDefault(
        provider,
        defaultBaseUrl ?? 'https://api.xiaomimimo.com/v1',
      )
      process.env.OPENAI_MODEL ??= defaultModel ?? 'mimo-v2.5-pro'
      if (model) process.env.OPENAI_MODEL = model
      if (process.env.MIMO_API_KEY && !process.env.OPENAI_API_KEY) {
        process.env.OPENAI_API_KEY = process.env.MIMO_API_KEY
      }
      break

    case 'xiaomi-mimo-token':
      process.env.CLAUDE_CODE_USE_OPENAI = '1'
      applyOpenAIBaseUrlDefault(
        provider,
        defaultBaseUrl ?? 'https://token-plan-sgp.xiaomimimo.com/v1',
      )
      process.env.OPENAI_MODEL ??= defaultModel ?? 'mimo-v2.5-pro'
      if (model) process.env.OPENAI_MODEL = model
      if (process.env.MIMO_API_KEY && !process.env.OPENAI_API_KEY) {
        process.env.OPENAI_API_KEY = process.env.MIMO_API_KEY
      }
      break

    case 'venice':
      process.env.CLAUDE_CODE_USE_OPENAI = '1'
      applyOpenAIBaseUrlDefault(
        provider,
        defaultBaseUrl ?? 'https://api.venice.ai/api/v1',
      )
      process.env.OPENAI_MODEL ??= defaultModel ?? 'venice-uncensored'
      if (model) process.env.OPENAI_MODEL = model
      if (process.env.VENICE_API_KEY && !process.env.OPENAI_API_KEY) {
        process.env.OPENAI_API_KEY = process.env.VENICE_API_KEY
      }
      break

    case 'atlas-cloud':
      process.env.CLAUDE_CODE_USE_OPENAI = '1'
      applyOpenAIBaseUrlDefault(
        provider,
        defaultBaseUrl ?? 'https://api.atlascloud.ai/v1',
      )
      process.env.OPENAI_MODEL ??= defaultModel ?? 'deepseek-ai/deepseek-v4-pro'
      if (model) process.env.OPENAI_MODEL = model
      // The dedicated key always wins so a lingering OPENAI_API_KEY from
      // another provider is never sent to Atlas Cloud; without it the
      // generic key is cleared for the same reason and validation reports
      // the missing ATLAS_CLOUD_API_KEY instead.
      if (process.env.ATLAS_CLOUD_API_KEY) {
        process.env.OPENAI_API_KEY = process.env.ATLAS_CLOUD_API_KEY
      } else {
        delete process.env.OPENAI_API_KEY
      }
      break

    case 'gmi-cloud':
      process.env.CLAUDE_CODE_USE_OPENAI = '1'
      // GMI Cloud is Bearer-only chat completions: drop an API format or
      // custom auth header left over from another provider.
      clearUnsupportedOpenAIShimSettings('gmi-cloud')
      delete process.env.ANTHROPIC_CUSTOM_HEADERS
      applyOpenAIBaseUrlDefault(
        provider,
        defaultBaseUrl ?? 'https://api.gmi-serving.com/v1',
      )
      {
        const gmiModel = usableProviderModelEnvValue(process.env.GMI_MODEL)
        if (gmiModel) {
          process.env.OPENAI_MODEL = gmiModel
        } else {
          process.env.OPENAI_MODEL ??=
            defaultModel ?? 'Qwen/Qwen3.8-Max'
        }
      }
      if (model) process.env.OPENAI_MODEL = model
      // DedicatedCredentialsOnly: only GMI_API_KEY authenticates this route.
      // Mirror it into OPENAI_API_KEY for the shared shim transport, and clear
      // any stale generic key so another provider's credential is never
      // forwarded to GMI Cloud. A preserved custom base URL never receives
      // the GMI key.
      if (
        process.env.GMI_API_KEY &&
        isGmiCloudBaseUrl(getConfiguredOpenAIBaseUrl())
      ) {
        process.env.OPENAI_API_KEY = process.env.GMI_API_KEY
      } else {
        delete process.env.OPENAI_API_KEY
      }
      break

    case 'apismart':
      process.env.CLAUDE_CODE_USE_OPENAI = '1'
      // Keep provider-flag selection on the same descriptor-declared wire
      // contract as env-only setup and saved profiles. ApiSmart does not
      // support alternate API formats or custom auth headers.
      clearUnsupportedOpenAIShimSettings('apismart')
      delete process.env.ANTHROPIC_CUSTOM_HEADERS
      applyOpenAIBaseUrlDefault(
        provider,
        defaultBaseUrl ?? 'https://gw.apismart.ai/v1',
      )
      {
        const apismartModel = usableProviderModelEnvValue(
          process.env.APISMART_MODEL,
        )
        if (apismartModel) {
          process.env.OPENAI_MODEL = apismartModel
        } else {
          process.env.OPENAI_MODEL ??=
            usableProviderModelEnvValue(process.env.OPENAI_MODEL) ||
            defaultModel ||
            'DEEPSEEK_V4_FLASH'
        }
      }
      if (model) {
        process.env.OPENAI_MODEL = model
        process.env.APISMART_MODEL = model
      }
      // DedicatedCredentialsOnly: only APISMART_API_KEY authenticates this
      // route. Mirror it into OPENAI_API_KEY for the shared shim transport,
      // and clear any stale generic key so another provider's credential is
      // never forwarded to ApiSmart. Only the documented `/v1` inference URL
      // is eligible for mirroring (AIMLAPI canonical-host parity).
      if (
        hasUsableOpenAICredential(process.env.APISMART_API_KEY) &&
        isCanonicalApismartInferenceBaseUrl(getConfiguredOpenAIBaseUrl())
      ) {
        process.env.OPENAI_API_KEY = process.env.APISMART_API_KEY
      } else {
        delete process.env.OPENAI_API_KEY
      }
      break

    case 'concentrate':
      process.env.CLAUDE_CODE_USE_OPENAI = '1'
      // Concentrate uses the standard OpenAI-compatible wire contract with no
      // alternate API formats or custom auth headers.
      clearUnsupportedOpenAIShimSettings('concentrate')
      delete process.env.ANTHROPIC_CUSTOM_HEADERS
      {
        const baseUrlOverride = usableProviderModelEnvValue(
          process.env.CONCENTRATE_BASE_URL,
        )
        if (baseUrlOverride) {
          process.env.OPENAI_BASE_URL = baseUrlOverride
        } else {
          // An explicit Concentrate selection must not retain an unrelated
          // custom OpenAI endpoint from the preceding provider. Users can
          // deliberately select a different Concentrate endpoint through
          // CONCENTRATE_BASE_URL above.
          process.env.OPENAI_BASE_URL =
            defaultBaseUrl ?? 'https://api.concentrate.ai/v1'
        }
      }
      {
        const concentrateModel = usableProviderModelEnvValue(
          process.env.CONCENTRATE_MODEL,
        )
        if (concentrateModel) {
          process.env.OPENAI_MODEL = concentrateModel
        } else {
          process.env.OPENAI_MODEL ??=
            usableProviderModelEnvValue(process.env.OPENAI_MODEL) ||
            defaultModel ||
            'deepseek-v4-flash'
        }
      }
      if (model) {
        // Runtime model resolution gives CONCENTRATE_MODEL priority over the
        // shared shim setting. An explicit CLI selection must supersede that
        // ambient provider default all the way through client normalization.
        delete process.env.CONCENTRATE_MODEL
        process.env.OPENAI_MODEL = model
      }
      // This explicit dedicated selection mirrors CONCENTRATE_API_KEY into the
      // shared shim transport and clears a stale generic key. A generic
      // OpenAI-compatible Concentrate setup remains supported when selected
      // through OPENAI_BASE_URL instead. Do not mirror the dedicated key to a
      // same-host proxy or alternate path supplied through CONCENTRATE_BASE_URL.
      if (
        hasUsableOpenAICredential(process.env.CONCENTRATE_API_KEY) &&
        isCanonicalConcentrateInferenceBaseUrl(getConfiguredOpenAIBaseUrl())
      ) {
        process.env.OPENAI_API_KEY = process.env.CONCENTRATE_API_KEY
      } else {
        delete process.env.OPENAI_API_KEY
      }
      break

    case 'fireworks':
      process.env.CLAUDE_CODE_USE_OPENAI = '1'
      applyOpenAIBaseUrlDefault(provider, defaultBaseUrl)
      if (defaultModel) {
        process.env.OPENAI_MODEL ??= defaultModel
      }
      if (model) process.env.OPENAI_MODEL = model
      if (process.env.FIREWORKS_API_KEY) {
        process.env.OPENAI_API_KEY = process.env.FIREWORKS_API_KEY
      } else {
        delete process.env.OPENAI_API_KEY
      }
      break

    case 'longcat':
      process.env.CLAUDE_CODE_USE_OPENAI = '1'
      // LongCat only implements its documented chat-completions endpoint and
      // Bearer authentication. Do not let stale OpenAI-compatible settings
      // from a previously selected provider change that wire contract.
      delete process.env.OPENAI_API_FORMAT
      delete process.env.OPENAI_AUTH_HEADER
      delete process.env.OPENAI_AUTH_SCHEME
      delete process.env.OPENAI_AUTH_HEADER_VALUE
      applyOpenAIBaseUrlDefault(
        provider,
        defaultBaseUrl ?? 'https://api.longcat.chat/openai/v1',
      )
      process.env.OPENAI_MODEL ??= defaultModel ?? 'LongCat-2.0'
      if (model) process.env.OPENAI_MODEL = model
      // Do not copy a dedicated LongCat credential to a stale custom URL.
      // applyOpenAIBaseUrlDefault preserves an existing base URL, so only
      // expose this key when that URL is the documented HTTPS LongCat API.
      if (
        process.env.LONGCAT_API_KEY &&
        isLongcatBaseUrl(getConfiguredOpenAIBaseUrl())
      ) {
        process.env.OPENAI_API_KEY = process.env.LONGCAT_API_KEY
      } else {
        delete process.env.OPENAI_API_KEY
      }
      break

    case 'cloudflare':
      process.env.CLAUDE_CODE_USE_OPENAI = '1'
      // applyOpenAIBaseUrlDefault skips unresolved `<...>` placeholder
      // endpoints (the Cloudflare default carries `<ACCOUNT_ID>`), so the
      // user must export a real account-scoped base URL.
      applyOpenAIBaseUrlDefault(provider, defaultBaseUrl)
      if (defaultModel) {
        process.env.OPENAI_MODEL ??= defaultModel
      }
      if (model) process.env.OPENAI_MODEL = model
      // The Cloudflare transport reads the generic OpenAI-compatible auth
      // header, so mirror CLOUDFLARE_API_TOKEN into OPENAI_API_KEY the same way
      // nearai/fireworks mirror their dedicated keys. Gate it on the configured
      // base URL resolving to a *real* Cloudflare Workers AI endpoint: the host
      // must be api.cloudflare.com AND the URL must not still carry the
      // descriptor's unresolved `<ACCOUNT_ID>` placeholder (which shares that
      // host). Mirroring onto a placeholder or a stale OPENAI_BASE_URL from a
      // previous provider would leak the token to a host that cannot serve a
      // request.
      {
        const configuredBaseUrl = getConfiguredOpenAIBaseUrl()
        const isRealCloudflareEndpoint =
          !!configuredBaseUrl &&
          isCloudflareBaseUrl(configuredBaseUrl) &&
          !isPlaceholderBaseUrl(configuredBaseUrl)
        if (process.env.CLOUDFLARE_API_TOKEN && isRealCloudflareEndpoint) {
          process.env.OPENAI_API_KEY = process.env.CLOUDFLARE_API_TOKEN
        } else if (!isRealCloudflareEndpoint) {
          // Endpoint missing, an unresolved placeholder, or a stale/shared
          // host: clear any generic key so a stale token isn't leaked.
          delete process.env.OPENAI_API_KEY
        }
        // else: a real Cloudflare endpoint with no dedicated token — keep an
        // existing OPENAI_API_KEY, the documented compatibility fallback
        // (descriptor credentialEnvVars lists OPENAI_API_KEY after the token).
      }
      break

    default:
      process.env.CLAUDE_CODE_USE_OPENAI = '1'
      applyOpenAIBaseUrlDefault(provider, defaultBaseUrl)
      if (
        (provider === 'llmtr' &&
          isCanonicalLlmtrInferenceBaseUrl(getConfiguredOpenAIBaseUrl())) ||
        (provider === 'commandcode' &&
          isCanonicalCommandcodeInferenceBaseUrl(getConfiguredOpenAIBaseUrl())) ||
        (provider === 'api-route' &&
          isCanonicalApiRouteInferenceBaseUrl(getConfiguredOpenAIBaseUrl()))
      ) {
        clearUnsupportedOpenAIShimSettings(provider)
        delete process.env.ANTHROPIC_CUSTOM_HEADERS
      }
      // DedicatedCredentialsOnly: only Command Code-owned credential aliases
      // authenticate this route. Mirror the resolved dedicated key into
      // OPENAI_API_KEY for the shared shim, and clear any unrelated generic
      // key so another provider's credential is never left in-process
      // (spawn forwarding, copied-key switch-away, other OPENAI_API_KEY
      // readers). LLMTR stays on the default generic-fallback path.
      if (
        provider === 'commandcode' &&
        isCanonicalCommandcodeInferenceBaseUrl(getConfiguredOpenAIBaseUrl())
      ) {
        const dedicatedCommandcodeKey = hasUsableOpenAICredential(
          process.env.CMD_API_KEY,
        )
          ? process.env.CMD_API_KEY
          : hasUsableOpenAICredential(process.env.COMMANDCODE_API_KEY)
            ? process.env.COMMANDCODE_API_KEY
            : hasUsableOpenAICredential(process.env.COMMAND_CODE_API_KEY)
              ? process.env.COMMAND_CODE_API_KEY
              : undefined
        if (dedicatedCommandcodeKey) {
          process.env.OPENAI_API_KEY = dedicatedCommandcodeKey
        } else {
          delete process.env.OPENAI_API_KEY
        }
      }
      if (
        provider === 'api-route' &&
        isCanonicalApiRouteInferenceBaseUrl(getConfiguredOpenAIBaseUrl())
      ) {
        const dedicatedApiRouteKey = hasUsableOpenAICredential(
          process.env.API_ROUTE_API_KEY,
        )
          ? process.env.API_ROUTE_API_KEY
          : undefined
        if (dedicatedApiRouteKey) {
          process.env.OPENAI_API_KEY = dedicatedApiRouteKey
          delete process.env.OPENAI_API_KEYS
        } else {
          delete process.env.OPENAI_API_KEY
        }
      }
      if (provider === 'api-route') {
        const apiRouteModel = usableProviderModelEnvValue(
          process.env.API_ROUTE_MODEL,
        )
        if (apiRouteModel) {
          process.env.OPENAI_MODEL = apiRouteModel
        } else {
          process.env.OPENAI_MODEL ??=
            usableProviderModelEnvValue(process.env.OPENAI_MODEL) ||
            defaultModel ||
            'claude-sonnet-4-6'
        }
      }
      if (defaultModel) {
        process.env.OPENAI_MODEL ??= defaultModel
      }
      if (effectiveModel) process.env.OPENAI_MODEL = effectiveModel
      break
  }

  // A provider flag selects a complete route for this process. Dedicated
  // variables are another source of route identity, so leaving them
  // behind can re-select a provider after a later OpenAI-compatible provider
  // has applied its defaults. Keep their lifecycle at the selection boundary,
  // rather than relying on individual switch branches to remember cleanup.
  // This runs only after the selected branch succeeds, so an invalid
  // custom-anthropic request remains non-mutating.
  if (provider !== 'concentrate') {
    clearConcentrateProviderState()
  }
  if (provider !== 'api-route') {
    delete process.env.API_ROUTE_API_KEY
    delete process.env.API_ROUTE_MODEL
  }

  return {}
}
