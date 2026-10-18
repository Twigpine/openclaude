import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getAnthropicApiKey,
  getApiKeyFromApiKeyHelper,
  getClaudeAIOAuthTokens,
  isClaudeAISubscriber,
  refreshAndGetAwsCredentials,
  refreshGcpCredentialsIfNeeded,
} from 'src/utils/auth.js'
import {
  convertEffortValueToLevel,
  type EffortValue,
  resolveAppliedEffort,
  resolveModelReasoningControl,
  modelSupportsShimReasoningEffort,
  modelSupportsWireEffort,
  standardEffortToOpenAI,
  type OpenAIShimEffortLevel,
} from 'src/utils/effort.js'
import { getUserAgent } from 'src/utils/http.js'
import { getSmallFastModel } from 'src/utils/model/model.js'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
  isGithubNativeAnthropicMode,
} from 'src/utils/model/providers.js'
import { getProxyFetchOptions } from 'src/utils/proxy.js'
import {
  getIsNonInteractiveSession,
  getSessionId,
} from '../../bootstrap/state.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { isDebugToStdErr, logForDebugging } from '../../utils/debug.js'
import {
  getAWSRegion,
  getVertexRegionForModel,
  isEnvTruthy,
} from '../../utils/envUtils.js'
import {
  getFireworksBaseUrlOverride,
  getLongcatBaseUrlOverride,
  getMiniMaxBaseUrlOverride,
  getMiniMaxBaseUrlValidationError,
  isMiniMaxBaseUrl,
  getNearaiBaseUrlOverride,
  isCanonicalApiRouteInferenceBaseUrl,
  isCanonicalApismartInferenceBaseUrl,
  isCanonicalConcentrateInferenceBaseUrl,
  getRouteDefaultBaseUrl,
  getRouteDefaultModel,
  getXaiBaseUrlOverride,
  getXiaomiMimoBaseUrlOverride,
  resolveEnvOnlyProviderRouteId,
} from '../../integrations/routeMetadata.js'
import { resolveOpenAIShimRuntimeContext } from '../../integrations/runtimeMetadata.js'
import {
  shouldUseCustomAnthropicBearerAuth,
  shouldUseFirstPartyAnthropicAuthForProvider,
  type ProviderOverride,
} from './authRouting.js'
import { hasUsableOpenAICredential } from './credentialPool.js'
import { getApiTimeoutMs } from './openaiShim/transport.js'
import { AnthropicVertex } from './vertexClient.js'
import { importOptionalRuntimeModule } from '../../utils/optionalRuntimeModule.js'

type OptionalRuntimeImporter = typeof importOptionalRuntimeModule

let importOptionalRuntimeModuleForClient: OptionalRuntimeImporter =
  importOptionalRuntimeModule

export function _setOptionalRuntimeModuleImporterForTesting(
  importer?: OptionalRuntimeImporter,
): void {
  importOptionalRuntimeModuleForClient = importer ?? importOptionalRuntimeModule
}

/**
 * Environment variables for different client types:
 *
 * Direct API:
 * - ANTHROPIC_API_KEY: Required for direct API access
 *
 * AWS Bedrock:
 * - AWS credentials configured via aws-sdk defaults
 * - AWS_REGION or AWS_DEFAULT_REGION: Sets the AWS region for all models (default: us-east-1)
 * - ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION: Optional. Override AWS region specifically for the small fast model (Haiku)
 *
 * Foundry (Azure):
 * - ANTHROPIC_FOUNDRY_RESOURCE: Your Azure resource name (e.g., 'my-resource')
 *   For the full endpoint: https://{resource}.services.ai.azure.com/anthropic/v1/messages
 * - ANTHROPIC_FOUNDRY_BASE_URL: Optional. Alternative to resource - provide full base URL directly
 *   (e.g., 'https://my-resource.services.ai.azure.com')
 *
 * Authentication (one of the following):
 * - ANTHROPIC_FOUNDRY_API_KEY: Your Microsoft Foundry API key (if using API key auth)
 * - Azure AD authentication: If no API key is provided, uses DefaultAzureCredential
 *   which supports multiple auth methods (environment variables, managed identity,
 *   Azure CLI, etc.). See: https://docs.microsoft.com/en-us/javascript/api/@azure/identity
 *
 * Vertex AI:
 * - Model-specific region variables (highest priority):
 *   - VERTEX_REGION_CLAUDE_3_5_HAIKU: Region for Claude 3.5 Haiku model
 *   - VERTEX_REGION_CLAUDE_HAIKU_4_5: Region for Claude Haiku 4.5 model
 *   - VERTEX_REGION_CLAUDE_3_5_SONNET: Region for Claude 3.5 Sonnet model
 *   - VERTEX_REGION_CLAUDE_3_7_SONNET: Region for Claude 3.7 Sonnet model
 * - CLOUD_ML_REGION: Optional. The default GCP region to use for all models
 *   If specific model region not specified above
 * - ANTHROPIC_VERTEX_PROJECT_ID: Required. Your GCP project ID
 * - Standard GCP credentials configured via google-auth-library
 *
 * Priority for determining region:
 * 1. Hardcoded model-specific environment variables
 * 2. Global CLOUD_ML_REGION variable
 * 3. Default region from config
 * 4. Fallback region (us-east5)
 */

function createStderrLogger(): ClientOptions['logger'] {
  return {
    error: (msg, ...args) =>
      // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
      console.error('[Anthropic SDK ERROR]', msg, ...args),
    // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
    warn: (msg, ...args) => console.error('[Anthropic SDK WARN]', msg, ...args),
    // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
    info: (msg, ...args) => console.error('[Anthropic SDK INFO]', msg, ...args),
    debug: (msg, ...args) =>
      // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
      console.error('[Anthropic SDK DEBUG]', msg, ...args),
  }
}

function isMiniMaxModelName(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return Boolean(
    normalized &&
      (normalized.startsWith('minimax-') || normalized.startsWith('minimax/')),
  )
}

function hasMiniMaxModelIntent(model: string | undefined): boolean {
  return (
    isMiniMaxModelName(model) ||
    isMiniMaxModelName(process.env.OPENAI_MODEL) ||
    isMiniMaxModelName(process.env.ANTHROPIC_MODEL)
  )
}

function hasConflictingOpenAIBaseUrlForMiniMax(): boolean {
  const openAIBaseUrl =
    process.env.OPENAI_BASE_URL?.trim() || process.env.OPENAI_API_BASE?.trim()
  return Boolean(openAIBaseUrl && !isMiniMaxBaseUrl(openAIBaseUrl))
}

function shouldUseMiniMaxEnvOnlyProvider(
  model: string | undefined,
  envOnlyProviderRouteId: string | null,
): boolean {
  // An explicit OpenAI endpoint selects its wire protocol, even with a
  // dedicated MiniMax key. Native defaults must not rewrite that request.
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI) &&
    isMiniMaxBaseUrl(
      process.env.OPENAI_BASE_URL?.trim() || process.env.OPENAI_API_BASE?.trim(),
    )
  ) {
    return false
  }

  const hasMiniMaxCredential =
    process.env.MINIMAX_API_KEY?.trim() ||
    (getMiniMaxBaseUrlOverride() !== undefined &&
      process.env.ANTHROPIC_API_KEY?.trim())

  if (!hasMiniMaxCredential) {
    return false
  }

  if (envOnlyProviderRouteId === 'minimax') {
    return true
  }

  return (
    (hasMiniMaxModelIntent(model) || getMiniMaxBaseUrlOverride() !== undefined) &&
    !hasConflictingOpenAIBaseUrlForMiniMax()
  )
}

function isXaiModelName(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return Boolean(
    normalized &&
      (normalized.startsWith('grok-') || normalized.startsWith('xai/')),
  )
}

function applyMiniMaxEnvOnlyDefaults(model: string | undefined): void {
  const baseUrlOverride = getMiniMaxBaseUrlOverride()
  const validationError = getMiniMaxBaseUrlValidationError(baseUrlOverride)
  if (validationError) throw new Error(validationError)
  // ANTHROPIC_BASE_URL already describes the native endpoint. Legacy OpenAI
  // URL hints select the region, but still need the native /anthropic path.
  const baseUrl = isMiniMaxBaseUrl(process.env.ANTHROPIC_BASE_URL)
    ? process.env.ANTHROPIC_BASE_URL!.trim()
    : baseUrlOverride
      ? new URL('/anthropic', baseUrlOverride).toString()
      : getRouteDefaultBaseUrl('minimax')

  const modelOverride =
    (isMiniMaxModelName(model) ? model?.trim() : undefined) ??
    process.env.OPENAI_MODEL?.trim() ??
    process.env.ANTHROPIC_MODEL?.trim() ??
    undefined

  const apiKey =
    process.env.MINIMAX_API_KEY?.trim() ||
    process.env.ANTHROPIC_API_KEY?.trim()
  if (apiKey) {
    process.env.ANTHROPIC_API_KEY = apiKey
  }

  process.env.ANTHROPIC_BASE_URL = baseUrl
  process.env.ANTHROPIC_MODEL =
    (isMiniMaxModelName(modelOverride)
      ? modelOverride
      : undefined) ??
    getRouteDefaultModel('minimax')
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.OPENAI_API_FORMAT
  delete process.env.OPENAI_AZURE_STYLE
  delete process.env.OPENAI_AUTH_HEADER
  delete process.env.OPENAI_AUTH_SCHEME
  delete process.env.OPENAI_AUTH_HEADER_VALUE
}

function isXiaomiMimoModelName(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return Boolean(
    normalized &&
      (normalized.startsWith('mimo-') || normalized.startsWith('mimo/')),
  )
}

function applyXiaomiMimoEnvOnlyDefaults(): void {
  const baseUrlOverride = getXiaomiMimoBaseUrlOverride()
  const hasBaseOverride = baseUrlOverride !== undefined
  const modelOverride = process.env.OPENAI_MODEL?.trim() || undefined

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL =
    baseUrlOverride ?? getRouteDefaultBaseUrl('xiaomi-mimo')
  process.env.OPENAI_MODEL =
    (hasBaseOverride || isXiaomiMimoModelName(modelOverride)
      ? modelOverride
      : undefined) ??
    getRouteDefaultModel('xiaomi-mimo')
  process.env.OPENAI_API_KEY = process.env.MIMO_API_KEY
  delete process.env.OPENAI_API_FORMAT
  delete process.env.OPENAI_AZURE_STYLE
  delete process.env.OPENAI_AUTH_HEADER
  delete process.env.OPENAI_AUTH_SCHEME
  delete process.env.OPENAI_AUTH_HEADER_VALUE
}

function applyXaiEnvOnlyDefaults(): void {
  const baseUrlOverride = getXaiBaseUrlOverride()
  const hasXaiBaseOverride = baseUrlOverride !== undefined
  const modelOverride = process.env.OPENAI_MODEL?.trim() || undefined

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL =
    baseUrlOverride ?? getRouteDefaultBaseUrl('xai')
  process.env.OPENAI_MODEL =
    (hasXaiBaseOverride || isXaiModelName(modelOverride)
      ? modelOverride
      : undefined) ??
    getRouteDefaultModel('xai')
  process.env.OPENAI_API_KEY = process.env.XAI_API_KEY
  delete process.env.OPENAI_API_FORMAT
  delete process.env.OPENAI_AZURE_STYLE
  delete process.env.OPENAI_AUTH_HEADER
  delete process.env.OPENAI_AUTH_SCHEME
  delete process.env.OPENAI_AUTH_HEADER_VALUE
}

const NEARAI_MODEL_PREFIXES = [
  'anthropic/',
  'openai/',
  'google/',
  'zai-org/',
  'qwen/',
  'moonshotai/',
]

function isNearaiModelName(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return false
  return NEARAI_MODEL_PREFIXES.some(prefix => normalized.startsWith(prefix))
}

function applyNearaiEnvOnlyDefaults(): void {
  const baseUrlOverride = getNearaiBaseUrlOverride()
  const hasNearaiBaseOverride = baseUrlOverride !== undefined
  const modelOverride = process.env.OPENAI_MODEL?.trim() || undefined

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL =
    baseUrlOverride ?? getRouteDefaultBaseUrl('nearai')
  process.env.OPENAI_MODEL =
    (hasNearaiBaseOverride || isNearaiModelName(modelOverride)
      ? modelOverride
      : undefined) ??
    getRouteDefaultModel('nearai')
  process.env.OPENAI_API_KEY = process.env.NEARAI_API_KEY
  delete process.env.OPENAI_API_FORMAT
  delete process.env.OPENAI_AZURE_STYLE
  delete process.env.OPENAI_AUTH_HEADER
  delete process.env.OPENAI_AUTH_SCHEME
  delete process.env.OPENAI_AUTH_HEADER_VALUE
}

/**
 * Checks whether the given model ID follows the Fireworks AI model naming
 * convention (`accounts/fireworks/models/...`).
 */
function isFireworksModelName(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return Boolean(
    normalized && normalized.startsWith('accounts/fireworks/models/'),
  )
}

/**
 * Applies Fireworks AI environment defaults by setting the OpenAI shim env
 * vars (`CLAUDE_CODE_USE_OPENAI`, `OPENAI_BASE_URL`, `OPENAI_MODEL`,
 * `OPENAI_API_KEY`) and clearing stale OpenAI shim options.
 */
function applyFireworksEnvOnlyDefaults(): void {
  const baseUrlOverride = getFireworksBaseUrlOverride()
  const hasFireworksBaseOverride = baseUrlOverride !== undefined
  const modelOverride = process.env.OPENAI_MODEL?.trim() || undefined

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL =
    baseUrlOverride ?? getRouteDefaultBaseUrl('fireworks')
  process.env.OPENAI_MODEL =
    (hasFireworksBaseOverride || isFireworksModelName(modelOverride)
      ? modelOverride
      : undefined) ??
    getRouteDefaultModel('fireworks')
  process.env.OPENAI_API_KEY = process.env.FIREWORKS_API_KEY
  delete process.env.OPENAI_API_FORMAT
  delete process.env.OPENAI_AZURE_STYLE
  delete process.env.OPENAI_AUTH_HEADER
  delete process.env.OPENAI_AUTH_SCHEME
  delete process.env.OPENAI_AUTH_HEADER_VALUE
}

function isLongcatModelName(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return Boolean(normalized && normalized.startsWith('longcat'))
}

function applyLongcatEnvOnlyDefaults(): void {
  const baseUrlOverride = getLongcatBaseUrlOverride()
  const hasLongcatBaseOverride = baseUrlOverride !== undefined
  const modelOverride = process.env.OPENAI_MODEL?.trim() || undefined

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL =
    baseUrlOverride ?? getRouteDefaultBaseUrl('longcat')
  process.env.OPENAI_MODEL =
    (hasLongcatBaseOverride || isLongcatModelName(modelOverride)
      ? modelOverride
      : undefined) ??
    getRouteDefaultModel('longcat')
  process.env.OPENAI_API_KEY = process.env.LONGCAT_API_KEY
  delete process.env.OPENAI_API_FORMAT
  delete process.env.OPENAI_AZURE_STYLE
  delete process.env.OPENAI_AUTH_HEADER
  delete process.env.OPENAI_AUTH_SCHEME
  delete process.env.OPENAI_AUTH_HEADER_VALUE
}

function applyAimlapiEnvOnlyDefaults(): void {
  const baseUrlOverride =
    process.env.OPENAI_BASE_URL?.trim() ||
    process.env.OPENAI_API_BASE?.trim() ||
    undefined
  const modelOverride = process.env.OPENAI_MODEL?.trim() || undefined

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL =
    baseUrlOverride ?? getRouteDefaultBaseUrl('aimlapi')
  process.env.OPENAI_MODEL = modelOverride ?? getRouteDefaultModel('aimlapi')
  process.env.OPENAI_API_KEY = process.env.AIMLAPI_API_KEY
  delete process.env.OPENAI_API_FORMAT
  delete process.env.OPENAI_AZURE_STYLE
  delete process.env.OPENAI_AUTH_HEADER
  delete process.env.OPENAI_AUTH_SCHEME
  delete process.env.OPENAI_AUTH_HEADER_VALUE
}

function applyApismartEnvOnlyDefaults(): void {
  const baseUrlOverride =
    usableProviderConfigEnvValue(process.env.OPENAI_BASE_URL) ||
    usableProviderConfigEnvValue(process.env.OPENAI_API_BASE) ||
    undefined
  const modelOverride =
    usableProviderConfigEnvValue(process.env.APISMART_MODEL) ||
    usableProviderConfigEnvValue(process.env.OPENAI_MODEL) ||
    undefined
  const apiKey = process.env.APISMART_API_KEY

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL =
    baseUrlOverride ?? getRouteDefaultBaseUrl('apismart')
  process.env.OPENAI_MODEL = modelOverride ?? getRouteDefaultModel('apismart')
  // Mirror only a usable dedicated key. Template placeholders must not become
  // OPENAI_API_KEY side effects for later routes in this process. A same-host
  // URL alone is not enough: the dedicated key belongs only to ApiSmart's
  // documented /v1 inference endpoint.
  if (
    hasUsableOpenAICredential(apiKey) &&
    isCanonicalApismartInferenceBaseUrl(process.env.OPENAI_BASE_URL)
  ) {
    process.env.OPENAI_API_KEY = apiKey
  } else {
    delete process.env.OPENAI_API_KEY
  }
  delete process.env.OPENAI_API_FORMAT
  delete process.env.OPENAI_AZURE_STYLE
  delete process.env.OPENAI_AUTH_HEADER
  delete process.env.OPENAI_AUTH_SCHEME
  delete process.env.OPENAI_AUTH_HEADER_VALUE
  delete process.env.ANTHROPIC_CUSTOM_HEADERS
}

function applyConcentrateEnvOnlyDefaults(): void {
  const baseUrlOverride =
    usableProviderConfigEnvValue(process.env.CONCENTRATE_BASE_URL) ||
    usableProviderConfigEnvValue(process.env.OPENAI_BASE_URL) ||
    usableProviderConfigEnvValue(process.env.OPENAI_API_BASE) ||
    undefined
  const modelOverride =
    usableProviderConfigEnvValue(process.env.CONCENTRATE_MODEL) ||
    usableProviderConfigEnvValue(process.env.OPENAI_MODEL) ||
    undefined
  const apiKey = process.env.CONCENTRATE_API_KEY

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL =
    baseUrlOverride ?? getRouteDefaultBaseUrl('concentrate')
  process.env.OPENAI_MODEL = modelOverride ?? getRouteDefaultModel('concentrate')
  // A dedicated key explicitly selects Concentrate. Mirror it into
  // OPENAI_API_KEY for the shared transport and avoid forwarding a stale
  // generic credential. Generic OpenAI credentials remain supported when the
  // user explicitly configures the canonical Concentrate base URL without the
  // dedicated selection key.
  if (
    hasUsableOpenAICredential(apiKey) &&
    isCanonicalConcentrateInferenceBaseUrl(process.env.OPENAI_BASE_URL)
  ) {
    process.env.OPENAI_API_KEY = apiKey
  } else {
    delete process.env.OPENAI_API_KEY
  }
  delete process.env.OPENAI_API_FORMAT
  delete process.env.OPENAI_AZURE_STYLE
  delete process.env.OPENAI_AUTH_HEADER
  delete process.env.OPENAI_AUTH_SCHEME
  delete process.env.OPENAI_AUTH_HEADER_VALUE
  delete process.env.ANTHROPIC_CUSTOM_HEADERS
}

function applyApiRouteEnvOnlyDefaults(): void {
  const baseUrlOverride =
    usableProviderConfigEnvValue(process.env.OPENAI_BASE_URL) ||
    usableProviderConfigEnvValue(process.env.OPENAI_API_BASE) ||
    undefined
  const modelOverride =
    usableProviderConfigEnvValue(process.env.API_ROUTE_MODEL) ||
    usableProviderConfigEnvValue(process.env.OPENAI_MODEL) ||
    undefined
  const apiKey = process.env.API_ROUTE_API_KEY

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL =
    baseUrlOverride ?? getRouteDefaultBaseUrl('api-route')
  process.env.OPENAI_MODEL = modelOverride ?? getRouteDefaultModel('api-route')
  if (
    hasUsableOpenAICredential(apiKey) &&
    isCanonicalApiRouteInferenceBaseUrl(process.env.OPENAI_BASE_URL)
  ) {
    process.env.OPENAI_API_KEY = apiKey
    delete process.env.OPENAI_API_KEYS
  } else {
    delete process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEYS
  }
  delete process.env.OPENAI_API_FORMAT
  delete process.env.OPENAI_AZURE_STYLE
  delete process.env.OPENAI_AUTH_HEADER
  delete process.env.OPENAI_AUTH_SCHEME
  delete process.env.OPENAI_AUTH_HEADER_VALUE
  delete process.env.ANTHROPIC_CUSTOM_HEADERS
}

function usableProviderConfigEnvValue(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  const normalized = trimmed.toLowerCase()
  return normalized === 'undefined' || normalized === 'null'
    ? undefined
    : trimmed
}

export async function getAnthropicClient({
  apiKey,
  maxRetries,
  model,
  fetchOverride,
  source,
  providerOverride,
  effortValue,
}: {
  apiKey?: string
  maxRetries: number
  model?: string
  fetchOverride?: ClientOptions['fetch']
  source?: string
  providerOverride?: ProviderOverride
  effortValue?: EffortValue
}): Promise<Anthropic> {
  // Convert the runtime effort value to the OpenAI-shaped enum the shim
  // expects. Undefined → shim falls back to descriptor/alias defaults.
  const effortProcessEnv = providerOverride
    ? { ...process.env, OPENAI_AZURE_STYLE: undefined }
    : process.env
  const effortModel = providerOverride?.model ?? model
  const effortBaseUrl =
    providerOverride?.baseURL ??
    process.env.OPENAI_BASE_URL ??
    process.env.OPENAI_API_BASE
  const effortRuntimeContext = effortModel
    ? resolveOpenAIShimRuntimeContext({
      processEnv: effortProcessEnv,
      baseUrl: effortBaseUrl,
      model: effortModel,
      preferBaseUrlRoute:
        providerOverride !== undefined || isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI),
    })
    : undefined
  const effortShimConfig = effortRuntimeContext?.openaiShimConfig
  const effortContext = effortRuntimeContext
      ? {
        routeId: effortRuntimeContext.routeId ?? 'custom',
        useRuntimeFallback: false,
        openaiShimConfig: effortShimConfig,
        baseUrl: effortBaseUrl,
        processEnv: effortProcessEnv,
        // Per-agent overrides always use the OpenAI-compatible shim, regardless
        // of the parent session's provider.
        apiProvider: providerOverride ? 'openai' as const : getAPIProvider(),
      }
    : undefined
  const supportsShimReasoningEffort = effortModel
    ? effortShimConfig
      ? modelSupportsShimReasoningEffort(
        effortModel,
        effortShimConfig.thinkingRequestFormat,
        effortShimConfig.removeBodyFields,
        effortContext,
      )
      : modelSupportsWireEffort(effortModel, effortContext)
    : false
  const reasoningControl = effortModel
    ? resolveModelReasoningControl(effortModel, effortContext)
    : undefined
  const k3ReasoningControl =
    reasoningControl?.source === 'metadata' &&
    reasoningControl.wireFormat === 'reasoning_effort' &&
    reasoningControl.levels.length === 3 &&
    reasoningControl.levels.includes('low') &&
    reasoningControl.levels.includes('high') &&
    reasoningControl.levels.includes('max')
  const appliedEffort = effortModel && effortValue !== undefined
    ? resolveAppliedEffort(
      effortModel,
      effortValue,
      effortContext,
    )
    : undefined
  const appliedEffortLevel = appliedEffort === undefined
    ? undefined
    : convertEffortValueToLevel(appliedEffort)
  const shimReasoningEffort: OpenAIShimEffortLevel | undefined =
    appliedEffortLevel !== undefined && supportsShimReasoningEffort
      ? (reasoningControl?.source === 'metadata' &&
          reasoningControl.wireFormat === 'reasoning_effort' &&
          appliedEffortLevel === 'max' &&
          k3ReasoningControl
            ? 'max'
          : standardEffortToOpenAI(appliedEffortLevel))
      : undefined
  // Normalize env-only routes before snapshotting custom headers. Dedicated
  // routes such as Concentrate deliberately clear inherited proxy headers;
  // doing that after getCustomHeaders() would leave a copied secret in the
  // request defaults.
  const envOnlyProviderRouteId = resolveEnvOnlyProviderRouteId(process.env)
  const useMiniMaxEnvOnlyProvider = shouldUseMiniMaxEnvOnlyProvider(
    model,
    envOnlyProviderRouteId,
  )
  const useXiaomiMimoEnvOnlyProvider =
    envOnlyProviderRouteId === 'xiaomi-mimo' && !useMiniMaxEnvOnlyProvider
  const useXaiEnvOnlyProvider =
    envOnlyProviderRouteId === 'xai' && !useMiniMaxEnvOnlyProvider
  const useNearaiEnvOnlyProvider =
    envOnlyProviderRouteId === 'nearai' && !useMiniMaxEnvOnlyProvider
  const useFireworksEnvOnlyProvider =
    envOnlyProviderRouteId === 'fireworks' && !useMiniMaxEnvOnlyProvider
  const useLongcatEnvOnlyProvider =
    envOnlyProviderRouteId === 'longcat' && !useMiniMaxEnvOnlyProvider
  const useAimlapiEnvOnlyProvider =
    envOnlyProviderRouteId === 'aimlapi' && !useMiniMaxEnvOnlyProvider
  const useApismartEnvOnlyProvider =
    envOnlyProviderRouteId === 'apismart' && !useMiniMaxEnvOnlyProvider
  const useConcentrateEnvOnlyProvider =
    envOnlyProviderRouteId === 'concentrate' && !useMiniMaxEnvOnlyProvider
  const useApiRouteEnvOnlyProvider =
    envOnlyProviderRouteId === 'api-route' && !useMiniMaxEnvOnlyProvider
  if (useMiniMaxEnvOnlyProvider) applyMiniMaxEnvOnlyDefaults(model)
  if (useXiaomiMimoEnvOnlyProvider) applyXiaomiMimoEnvOnlyDefaults()
  if (useXaiEnvOnlyProvider) applyXaiEnvOnlyDefaults()
  if (useNearaiEnvOnlyProvider) applyNearaiEnvOnlyDefaults()
  if (useFireworksEnvOnlyProvider) applyFireworksEnvOnlyDefaults()
  if (useLongcatEnvOnlyProvider) applyLongcatEnvOnlyDefaults()
  if (useAimlapiEnvOnlyProvider) applyAimlapiEnvOnlyDefaults()
  if (useApismartEnvOnlyProvider) applyApismartEnvOnlyDefaults()
  if (useConcentrateEnvOnlyProvider) applyConcentrateEnvOnlyDefaults()
  if (useApiRouteEnvOnlyProvider) applyApiRouteEnvOnlyDefaults()

  const containerId = process.env.CLAUDE_CODE_CONTAINER_ID
  const remoteSessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
  const customHeaders = getCustomHeaders()
  const defaultHeaders: { [key: string]: string } = {
    'x-app': 'cli',
    'User-Agent': getUserAgent(),
    'X-Claude-Code-Session-Id': getSessionId(),
    ...customHeaders,
    ...(containerId ? { 'x-claude-remote-container-id': containerId } : {}),
    ...(remoteSessionId
      ? { 'x-claude-remote-session-id': remoteSessionId }
      : {}),
    // SDK consumers can identify their app/library for backend analytics
    ...(clientApp ? { 'x-client-app': clientApp } : {}),
  }

  // Log API client configuration for HFI debugging
  logForDebugging(
    `[API:request] Creating client, ANTHROPIC_CUSTOM_HEADERS present: ${!!process.env.ANTHROPIC_CUSTOM_HEADERS}, has Authorization header: ${!!customHeaders['Authorization']}`,
  )

  // Add additional protection header if enabled via env var
  const additionalProtectionEnabled = isEnvTruthy(
    process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION,
  )
  if (additionalProtectionEnabled) {
    defaultHeaders['x-anthropic-additional-protection'] = 'true'
  }

  const apiProvider = getAPIProvider()
  const isFirstPartyBaseUrl = isFirstPartyAnthropicBaseUrl()
  const shouldUseFirstPartyAuth = shouldUseFirstPartyAnthropicAuthForProvider({
    providerOverride,
    apiProvider,
    isFirstPartyBaseUrl,
  })
  const useMiniMaxNativeProvider =
    useMiniMaxEnvOnlyProvider ||
    (getAPIProvider() === 'minimax' &&
      !isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI))

  if (shouldUseFirstPartyAuth) {
    logForDebugging('[API:auth] OAuth token check starting')
    await checkAndRefreshOAuthTokenIfNeeded()
    logForDebugging('[API:auth] OAuth token check complete')
  }

  const isClaudeAiSubscriber =
    shouldUseFirstPartyAuth && isClaudeAISubscriber()
  const anthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN?.trim()
  const usesCustomAnthropicAuthToken = shouldUseCustomAnthropicBearerAuth({
    providerOverride,
    apiProvider,
    isFirstPartyBaseUrl,
    authToken: anthropicAuthToken,
  })

  if (
    (shouldUseFirstPartyAuth && !isClaudeAiSubscriber) ||
    usesCustomAnthropicAuthToken
  ) {
    await configureApiKeyHeaders(
      defaultHeaders,
      getIsNonInteractiveSession(),
      usesCustomAnthropicAuthToken ? anthropicAuthToken : undefined,
    )
  } else if (apiProvider === 'firstParty' && !isFirstPartyBaseUrl) {
    removeManagedAnthropicAuthHeaders(defaultHeaders)
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim()
    if (anthropicApiKey) {
      defaultHeaders['X-Api-Key'] = anthropicApiKey
    }
  }

  const resolvedFetch = buildFetch(fetchOverride, source)

  const ARGS = {
    defaultHeaders,
    maxRetries,
    timeout: getApiTimeoutMs(),
    dangerouslyAllowBrowser: true,
    fetchOptions: getProxyFetchOptions({
      forAnthropicAPI: true,
    }) as ClientOptions['fetchOptions'],
    ...(resolvedFetch && {
      fetch: resolvedFetch,
    }),
  }
  // Agent routing override: use per-agent provider when configured.
  // Strip auth-related headers to prevent leaking Anthropic credentials
  // to third-party endpoints (SSRF / credential forwarding mitigation).
  if (providerOverride) {
    const { createOpenAIShimClient } = await import('./openaiShim.js')
    const safeHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(defaultHeaders)) {
      const lower = k.toLowerCase()
      if (lower === 'authorization' || lower === 'x-api-key' || lower === 'api-key') continue
      safeHeaders[k] = v
    }
    return createOpenAIShimClient({
      defaultHeaders: safeHeaders,
      maxRetries,
      timeout: getApiTimeoutMs(),
      providerOverride,
      reasoningEffort: shimReasoningEffort,
    }) as unknown as Anthropic
  }
  // GitHub provider in native Anthropic API mode: send requests in Anthropic
  // format so cache_control blocks are honoured and prompt caching works.
  // Requires the GitHub endpoint (OPENAI_BASE_URL) to support Anthropic's
  // messages API — set CLAUDE_CODE_GITHUB_ANTHROPIC_API=1 to opt in.
  if (isGithubNativeAnthropicMode(model)) {
    const githubBaseUrl =
      process.env.OPENAI_BASE_URL?.replace(/\/$/, '') ??
      'https://api.githubcopilot.com'
    const githubToken =
      process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
    const nativeArgs: ConstructorParameters<typeof Anthropic>[0] = {
      ...ARGS,
      baseURL: githubBaseUrl,
      authToken: githubToken,
      // No apiKey — we authenticate via Bearer token (authToken)
      apiKey: null,
    }
    return new Anthropic(nativeArgs)
  }
  if (
    useXiaomiMimoEnvOnlyProvider ||
    useXaiEnvOnlyProvider ||
    useNearaiEnvOnlyProvider ||
    useFireworksEnvOnlyProvider ||
    useAimlapiEnvOnlyProvider ||
    useApismartEnvOnlyProvider ||
    useConcentrateEnvOnlyProvider ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_GITHUB) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_GEMINI) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_MISTRAL)
  ) {
    const { createOpenAIShimClient } = await import('./openaiShim.js')
    return createOpenAIShimClient({
      defaultHeaders,
      maxRetries,
      timeout: getApiTimeoutMs(),
      reasoningEffort: shimReasoningEffort,
    }) as unknown as Anthropic
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) {
    // Loaded via the runtime importer (not a static `import()`), so esbuild
    // stays blind to it and does NOT inline @anthropic-ai/bedrock-sdk — which
    // statically imports @aws-sdk/client-bedrock-runtime. Inlining would hoist
    // that AWS import into the CLI bundle and require it at startup for every
    // user. Keeping it lazy means only Bedrock users install the SDK (which
    // pulls @aws-sdk transitively).
    const { AnthropicBedrock } = await importOptionalRuntimeModuleForClient<
      typeof import('@anthropic-ai/bedrock-sdk')
    >('@anthropic-ai/bedrock-sdk', 'AWS Bedrock')
    // Use region override for small fast model if specified
    const awsRegion =
      model === getSmallFastModel() &&
      process.env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION
        ? process.env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION
        : getAWSRegion()

    // Typed as the SDK's ClientOptions (not ConstructorParameters) because
    // credentials are filled in conditionally below, which the constructor's
    // statically-discriminated credential overloads can't express.
    const bedrockArgs: import('@anthropic-ai/bedrock-sdk').ClientOptions = {
      ...ARGS,
      awsRegion,
      ...(isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH) && {
        skipAuth: true,
      }),
      ...(isDebugToStdErr() && { logger: createStderrLogger() }),
    }

    // Add API key authentication if available
    if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
      bedrockArgs.skipAuth = true
      // Add the Bearer token for Bedrock API key authentication
      bedrockArgs.defaultHeaders = {
        ...bedrockArgs.defaultHeaders,
        Authorization: `Bearer ${process.env.AWS_BEARER_TOKEN_BEDROCK}`,
      }
    } else if (!isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH)) {
      // Refresh auth and get credentials with cache clearing
      const cachedCredentials = await refreshAndGetAwsCredentials()
      if (cachedCredentials) {
        bedrockArgs.awsAccessKey = cachedCredentials.accessKeyId
        bedrockArgs.awsSecretKey = cachedCredentials.secretAccessKey
        bedrockArgs.awsSessionToken = cachedCredentials.sessionToken
      }
    }
    // we have always been lying about the return type - this doesn't support batching or models
    // Cast: the overloads demand a statically-known credential shape; ours is runtime-conditional.
    return new AnthropicBedrock(
      bedrockArgs as ConstructorParameters<typeof AnthropicBedrock>[0],
    ) as unknown as Anthropic
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)) {
    const { AnthropicFoundry } = await importOptionalRuntimeModuleForClient<
      typeof import('@anthropic-ai/foundry-sdk')
    >('@anthropic-ai/foundry-sdk', 'Azure Foundry')
    // Determine Azure AD token provider based on configuration
    // SDK reads ANTHROPIC_FOUNDRY_API_KEY by default
    let azureADTokenProvider: (() => Promise<string>) | undefined
    if (!process.env.ANTHROPIC_FOUNDRY_API_KEY) {
      if (isEnvTruthy(process.env.CLAUDE_CODE_SKIP_FOUNDRY_AUTH)) {
        // Mock token provider for testing/proxy scenarios (similar to Vertex mock GoogleAuth)
        azureADTokenProvider = () => Promise.resolve('')
      } else {
        // Use real Azure AD authentication with DefaultAzureCredential
        const {
          DefaultAzureCredential: AzureCredential,
          getBearerTokenProvider,
        } =
          await importOptionalRuntimeModuleForClient<
            typeof import('@azure/identity')
          >('@azure/identity', 'Azure Foundry authentication')
        azureADTokenProvider = getBearerTokenProvider(
          new AzureCredential(),
          'https://cognitiveservices.azure.com/.default',
        )
      }
    }

    const foundryArgs = {
      ...ARGS,
      ...(azureADTokenProvider && { azureADTokenProvider }),
      ...(isDebugToStdErr() && { logger: createStderrLogger() }),
    }
    // we have always been lying about the return type - this doesn't support batching or models
    return new AnthropicFoundry(foundryArgs) as unknown as Anthropic
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) {
    // Refresh GCP credentials if gcpAuthRefresh is configured and credentials are expired
    // This is similar to how we handle AWS credential refresh for Bedrock
    if (!isEnvTruthy(process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH)) {
      await refreshGcpCredentialsIfNeeded()
    }

    // TODO: Cache either GoogleAuth instance or AuthClient to improve performance
    // Currently we create a new GoogleAuth instance for every getAnthropicClient() call
    // This could cause repeated authentication flows and metadata server checks
    // However, caching needs careful handling of:
    // - Credential refresh/expiration
    // - Environment variable changes (GOOGLE_APPLICATION_CREDENTIALS, project vars)
    // - Cross-request auth state management
    // See: https://github.com/googleapis/google-auth-library-nodejs/issues/390 for caching challenges

    // Prevent metadata server timeout by providing projectId as fallback
    // google-auth-library checks project ID in this order:
    // 1. Environment variables (GCLOUD_PROJECT, GOOGLE_CLOUD_PROJECT, etc.)
    // 2. Credential files (service account JSON, ADC file)
    // 3. gcloud config
    // 4. GCE metadata server (causes 12s timeout outside GCP)
    //
    // We only set projectId if user hasn't configured other discovery methods
    // to avoid interfering with their existing auth setup

    // Check project environment variables in same order as google-auth-library
    // See: https://github.com/googleapis/google-auth-library-nodejs/blob/main/src/auth/googleauth.ts
    const hasProjectEnvVar =
      process.env['GCLOUD_PROJECT'] ||
      process.env['GOOGLE_CLOUD_PROJECT'] ||
      process.env['gcloud_project'] ||
      process.env['google_cloud_project']

    // Check for credential file paths (service account or ADC)
    // Note: We're checking both standard and lowercase variants to be safe,
    // though we should verify what google-auth-library actually checks
    const hasKeyFile =
      process.env['GOOGLE_APPLICATION_CREDENTIALS'] ||
      process.env['google_application_credentials']

    let googleAuth: {
      getClient: () => { getRequestHeaders: () => Record<string, string> }
    }
    if (isEnvTruthy(process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH)) {
      // Mock GoogleAuth for testing/proxy scenarios. This path intentionally
      // does NOT load google-auth-library — proxy/test runs must work even when
      // the optional package is absent (it is only needed for real auth below).
      googleAuth = {
        getClient: () => ({
          getRequestHeaders: () => ({}),
        }),
      }
    } else {
      const { GoogleAuth } = await importOptionalRuntimeModuleForClient<
        typeof import('google-auth-library')
      >('google-auth-library', 'Vertex AI (GCP) authentication')
      // The real GoogleAuth (async getClient) is wider than the minimal shape
      // declared above and shared with the mock; AnthropicVertex accepts it at
      // runtime, so narrow it back to the shared shape here.
      googleAuth = new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        // Only use ANTHROPIC_VERTEX_PROJECT_ID as last resort fallback
        // This prevents the 12-second metadata server timeout when:
        // - No project env vars are set AND
        // - No credential keyfile is specified AND
        // - ADC file exists but lacks project_id field
        //
        // Risk: If auth project != API target project, this could cause billing/audit issues
        // Mitigation: Users can set GOOGLE_CLOUD_PROJECT to override
        ...(hasProjectEnvVar || hasKeyFile
          ? {}
          : {
              projectId: process.env.ANTHROPIC_VERTEX_PROJECT_ID,
            }),
      }) as unknown as typeof googleAuth
    }

    const vertexArgs = {
      ...ARGS,
      region: getVertexRegionForModel(model),
      googleAuth,
      ...(isDebugToStdErr() && { logger: createStderrLogger() }),
    }
    // we have always been lying about the return type - this doesn't support batching or models
    return new AnthropicVertex(vertexArgs) as unknown as Anthropic
  }

  // Determine authentication method based on available tokens
  const clientConfig: ConstructorParameters<typeof Anthropic>[0] = {
    apiKey: isClaudeAiSubscriber || usesCustomAnthropicAuthToken
      ? null
      : useMiniMaxNativeProvider
        ? process.env.MINIMAX_API_KEY || process.env.ANTHROPIC_API_KEY
        : apiKey ||
          (!isFirstPartyBaseUrl
            ? process.env.ANTHROPIC_API_KEY?.trim()
            : getAnthropicApiKey()),
    // Pass an explicit null for non-Bearer routes so the SDK cannot fall back
    // to ANTHROPIC_AUTH_TOKEN from its own environment lookup.
    authToken: isClaudeAiSubscriber
      ? getClaudeAIOAuthTokens()?.accessToken
      : usesCustomAnthropicAuthToken
        ? anthropicAuthToken
        : null,
    // Set baseURL from OAuth config when using staging OAuth
    ...(shouldUseFirstPartyAuth &&
    process.env.USER_TYPE === 'ant' &&
    isEnvTruthy(process.env.USE_STAGING_OAUTH)
      ? { baseURL: getOauthConfig().BASE_API_URL }
      : process.env.ANTHROPIC_BASE_URL
        ? { baseURL: process.env.ANTHROPIC_BASE_URL.replace(/\/v1\/?$/i, '') }
        : {}),
    ...ARGS,
    ...(isDebugToStdErr() && { logger: createStderrLogger() }),
  }

  return new Anthropic(clientConfig)
}

async function configureApiKeyHeaders(
  headers: Record<string, string>,
  isNonInteractiveSession: boolean,
  authToken?: string,
): Promise<void> {
  const token = authToken || (await getApiKeyFromApiKeyHelper(isNonInteractiveSession))
  if (token) {
    removeManagedAnthropicAuthHeaders(headers)
    headers['Authorization'] = `Bearer ${token}`
  }
}

function removeManagedAnthropicAuthHeaders(headers: Record<string, string>): void {
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase()
    if (lower === 'authorization' || lower === 'x-api-key' || lower === 'api-key') {
      delete headers[name]
    }
  }
  // The Anthropic SDK also reads ANTHROPIC_CUSTOM_HEADERS. Null sentinels clear
  // those env-parsed managed auth headers before the supported credential wins.
  headers.Authorization = null as unknown as string
  headers['X-Api-Key'] = null as unknown as string
  headers['api-key'] = null as unknown as string
}

function getCustomHeaders(): Record<string, string> {
  const customHeaders: Record<string, string> = {}
  const customHeadersEnv = process.env.ANTHROPIC_CUSTOM_HEADERS

  if (!customHeadersEnv) return customHeaders

  // Reject raw CR characters — these indicate a header value containing \r\n
  // that would be split into an injected header entry after splitting.
  if (customHeadersEnv.includes('\r')) return customHeaders

  // Split by newlines to support multiple headers (intentional \n delimiters)
  for (const headerString of customHeadersEnv.split('\n')) {
    if (!headerString.trim()) continue
    const colonIdx = headerString.indexOf(':')
    if (colonIdx === -1) continue
    const name = headerString.slice(0, colonIdx).trim()
    const value = headerString.slice(colonIdx + 1).trim()
    const lowerName = name.toLowerCase()
    if (
      name &&
      lowerName !== 'authorization' &&
      lowerName !== 'x-api-key' &&
      lowerName !== 'api-key'
    ) {
      customHeaders[name] = value
    }
  }

  return customHeaders
}

export const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id'

function buildFetch(
  fetchOverride: ClientOptions['fetch'],
  source: string | undefined,
): ClientOptions['fetch'] {
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  const inner = fetchOverride ?? globalThis.fetch
  // Only send to the first-party API — Bedrock/Vertex/Foundry don't log it
  // and unknown headers risk rejection by strict proxies (inc-4029 class).
  const injectClientRequestId =
    getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()
  return (input, init) => {
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const headers = new Headers(init?.headers)
    // Generate a client-side request ID so timeouts (which return no server
    // request ID) can still be correlated with server logs by the API team.
    // Callers that want to track the ID themselves can pre-set the header.
    if (injectClientRequestId && !headers.has(CLIENT_REQUEST_ID_HEADER)) {
      headers.set(CLIENT_REQUEST_ID_HEADER, randomUUID())
    }
    try {
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const url = input instanceof Request ? input.url : String(input)
      const id = headers.get(CLIENT_REQUEST_ID_HEADER)
      logForDebugging(
        `[API REQUEST] ${new URL(url).pathname}${id ? ` ${CLIENT_REQUEST_ID_HEADER}=${id}` : ''} source=${source ?? 'unknown'}`,
      )
    } catch {
      // never let logging crash the fetch
    }
    return inner(input, { ...init, headers })
  }
}
