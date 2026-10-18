import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaImageBlockParam,
  BetaJSONOutputFormat,
  BetaMessage,
  BetaMessageDeltaUsage,
  BetaMessageStreamParams,
  BetaOutputConfig,
  BetaRawMessageStreamEvent,
  BetaRequestDocumentBlock,
  BetaStopReason,
  BetaToolChoiceAuto,
  BetaToolChoiceTool,
  BetaToolResultBlockParam,
  BetaToolUnion,
  BetaUsage,
  BetaMessageParam as MessageParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { Stream } from '@anthropic-ai/sdk/streaming.mjs'
import { randomUUID } from 'crypto'
import {
  prepareImagesForAnthropicRequest,
  usesAnthropicImageLimits,
} from '../../utils/requestImageValidation.js'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
  isGithubNativeAnthropicMode,
} from 'src/utils/model/providers.js'
import {
  getAttributionHeader,
  getCLISyspromptPrefix,
  isAttributionHeaderEnabled,
} from '../../constants/system.js'
import {
  getEmptyToolPermissionContext,
  type QueryChainTracking,
  type Tool,
  type ToolPermissionContext,
  type Tools,
  toolMatchesName,
} from '../../Tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import {
  type ConnectorTextBlock,
  type ConnectorTextDelta,
  isConnectorTextBlock,
} from '../../types/connectorText.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  UserMessage,
} from '../../types/message.js'
import {
  type CacheScope,
  logAPIPrefix,
  splitSysPromptPrefix,
  toolToAPISchema,
} from '../../utils/api.js'
import { getOauthAccountInfo } from '../../utils/auth.js'
import {
  getStreamingAbortMessage,
  isExpectedSideTaskAbortReason,
  normalizeAbortReason,
  shouldCreateUserInterruptionMessage,
} from '../../utils/abortReasons.js'
import {
  getBedrockExtraBodyParamsBetas,
  getMergedBetas,
  getModelBetas,
} from '../../utils/betas.js'
import { getOrCreateUserID } from '../../utils/config.js'
import {
  CAPPED_DEFAULT_MAX_TOKENS,
  getModelMaxOutputTokens,
  getSonnet1mExpTreatmentEnabled,
  shouldUseIntegrationRuntimeLimits,
} from '../../utils/context.js'
import { resolveAppliedEffort } from '../../utils/effort.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { computeFingerprintFromMessages } from '../../utils/fingerprint.js'
import { captureAPIRequest, logError } from '../../utils/log.js'
import {
  createAssistantAPIErrorMessage,
  createUserMessage,
  ensureToolResultPairing,
  normalizeContentFromAPI,
  normalizeMessagesForAPI,
  stripAdvisorBlocks,
  stripCallerFieldFromAssistantMessage,
  stripToolReferenceBlocksFromUserMessage,
} from '../../utils/messages.js'
import {
  getDefaultOpusModel,
  getDefaultSonnetModel,
  getSmallFastModel,
  isNonCustomOpusModel,
} from '../../utils/model/model.js'
import {
  asSystemPrompt,
  type SystemPrompt,
} from '../../utils/systemPromptType.js'
import { tokenCountFromLastAPIResponse } from '../../utils/tokens.js'
import { getDynamicConfig_BLOCKS_ON_INIT } from '../analytics/growthbook.js'
import {
  currentLimits,
  extractQuotaStatusFromError,
  extractQuotaStatusFromHeaders,
} from '../claudeAiLimits.js'
import { getAPIContextManagement } from '../compact/apiMicrocompact.js'
import { getApiTimeoutMs, getStreamIdleTimeoutMs } from './openaiShim.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('../../utils/permissions/autoModeState.js') as typeof import('../../utils/permissions/autoModeState.js'))
  : null

import { feature } from 'bun:bundle'
import type { ClientOptions } from '@anthropic-ai/sdk'
import {
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk/error'
import {
  getAfkModeHeaderLatched,
  getCacheEditingHeaderLatched,
  getFastModeHeaderLatched,
  getLastApiCompletionTimestamp,
  getSdkBetas,
  getPromptCache1hAllowlist,
  getPromptCache1hEligible,
  getSessionId,
  getThinkingClearLatched,
  setAfkModeHeaderLatched,
  setCacheEditingHeaderLatched,
  setFastModeHeaderLatched,
  setLastMainRequestId,
  setPromptCache1hAllowlist,
  setPromptCache1hEligible,
  setThinkingClearLatched,
} from 'src/bootstrap/state.js'
import {
  AFK_MODE_BETA_HEADER,
  CONTEXT_1M_BETA_HEADER,
  CONTEXT_MANAGEMENT_BETA_HEADER,
  EFFORT_BETA_HEADER,
  FAST_MODE_BETA_HEADER,
  PROMPT_CACHING_SCOPE_BETA_HEADER,
  REDACT_THINKING_BETA_HEADER,
  STRUCTURED_OUTPUTS_BETA_HEADER,
  TASK_BUDGETS_BETA_HEADER,
} from 'src/constants/betas.js'
import type { QuerySource } from 'src/constants/querySource.js'
import type { Notification } from 'src/context/notifications.js'
import { addToTotalSessionCost } from 'src/cost-tracker.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import type { AgentId } from 'src/types/ids.js'
import {
  ADVISOR_TOOL_INSTRUCTIONS,
  getExperimentAdvisorModels,
  isAdvisorEnabled,
  isValidAdvisorModel,
  modelSupportsAdvisor,
} from 'src/utils/advisor.js'
import { getAgentContext } from 'src/utils/agentContext.js'
import { applyAnthropicAttributionPolicy } from 'src/utils/anthropicAttribution.js'
import { isClaudeAISubscriber } from 'src/utils/auth.js'
import {
  getToolSearchBetaHeader,
  modelSupportsStructuredOutputs,
  shouldIncludeFirstPartyOnlyBetas,
  shouldUseGlobalCacheScope,
} from 'src/utils/betas.js'
import { CLAUDE_IN_CHROME_MCP_SERVER_NAME } from 'src/utils/claudeInChrome/common.js'
import { CHROME_TOOL_SEARCH_INSTRUCTIONS } from 'src/utils/claudeInChrome/prompt.js'
import { COMPACT_MAX_OUTPUT_TOKENS, getContextWindowForModel, getMaxThinkingTokensForModel } from 'src/utils/context.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import {
  flushInterruptionTrace,
  getInterruptionErrorCausalEventId,
  getInterruptionSignalAbortEventId,
  requestAbort,
  traceInterruptionEvent,
} from 'src/utils/interruptionTrace.js'
import { type EffortValue, modelSupportsEffort } from 'src/utils/effort.js'
import type { QueryLifecycleOperationTracker } from 'src/utils/queryLifecycle.js'
import {
  isFastModeAvailable,
  isFastModeCooldown,
  isFastModeEnabled,
  isFastModeSupportedByModel,
} from 'src/utils/fastMode.js'
import { returnValue } from 'src/utils/generators.js'
import { headlessProfilerCheckpoint } from 'src/utils/headlessProfiler.js'
import { isMcpInstructionsDeltaEnabled } from 'src/utils/mcpInstructionsDelta.js'
import { calculateUSDCost } from 'src/utils/modelCost.js'
import { endQueryProfile, queryCheckpoint } from 'src/utils/queryProfiler.js'
import {
  modelSupportsAdaptiveThinking,
  shouldUseThinkingForModel,
  type ThinkingConfig,
} from 'src/utils/thinking.js'
import {
  extractDiscoveredToolNames,
  isDeferredToolsDeltaEnabled,
  isToolSearchEnabled,
} from 'src/utils/toolSearch.js'
import { API_MAX_MEDIA_PER_REQUEST } from '../../constants/apiLimits.js'
import { ADVISOR_BETA_HEADER } from '../../constants/betas.js'
import {
  formatDeferredToolLine,
  isDeferredTool,
  TOOL_SEARCH_TOOL_NAME,
} from '../../tools/ToolSearchTool/prompt.js'
import { count } from '../../utils/array.js'
import { insertBlockAfterToolResults } from '../../utils/contentArray.js'
import { validateBoundedIntEnvVar } from '../../utils/envValidation.js'
import { safeParseJSON } from '../../utils/json.js'
import { getInferenceProfileBackingModel } from '../../utils/model/bedrock.js'
import {
  normalizeModelStringForAPI,
  parseUserSpecifiedModel,
} from '../../utils/model/model.js'
import {
  startSessionActivity,
  stopSessionActivity,
} from '../../utils/sessionActivity.js'
import { jsonStringify } from '../../utils/slowOperations.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  consumePendingCacheEdits,
  getPinnedCacheEdits,
  markToolsSentToAPIState,
  pinCacheEdits,
} from '../compact/microCompact.js'
import { getInitializationStatus } from '../lsp/manager.js'
import { isToolFromMcpServer } from '../mcp/utils.js'
import { withStreamingVCR, withVCR } from '../vcr.js'
import { resolveCurrentAnthropicAttributionPolicy } from './authRouting.js'
import { CLIENT_REQUEST_ID_HEADER, getAnthropicClient } from './client.js'
import {
  API_ERROR_MESSAGE_PREFIX,
  CUSTOM_OFF_SWITCH_MESSAGE,
  getAssistantMessageFromError,
  getErrorMessageIfRefusal,
} from './errors.js'
import {
  EMPTY_USAGE,
  type GlobalCacheStrategy,
  logAPIError,
  logAPIQuery,
  logAPISuccessAndDuration,
  type NonNullableUsage,
} from './logging.js'
import {
  CACHE_TTL_1HOUR_MS,
  checkResponseForCacheBreak,
  recordPromptState,
} from './promptCacheBreakDetection.js'
import {
  CannotRetryError,
  FallbackTriggeredError,
  is529Error,
  type RetryContext,
  withRetry,
} from './withRetry.js'

// Define a type that represents valid JSON values
type JsonValue = string | number | boolean | null | JsonObject | JsonArray
type JsonObject = { [key: string]: JsonValue }
type JsonArray = JsonValue[]

class StreamIdleTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Stream idle timeout - no chunks received for ${timeoutMs / 1000}s`)
    this.name = 'StreamIdleTimeoutError'
  }
}

/**
 * Assemble the extra body parameters for the API request, based on the
 * CLAUDE_CODE_EXTRA_BODY environment variable if present and on any beta
 * headers (primarily for Bedrock requests).
 *
 * @param betaHeaders - An array of beta headers to include in the request.
 * @returns A JSON object representing the extra body parameters.
 */
export function getExtraBodyParams(betaHeaders?: string[]): JsonObject {
  // Parse user's extra body parameters first
  const extraBodyStr = process.env.CLAUDE_CODE_EXTRA_BODY
  let result: JsonObject = {}

  if (extraBodyStr) {
    try {
      // Parse as JSON, which can be null, boolean, number, string, array or object
      const parsed = safeParseJSON(extraBodyStr)
      // We expect an object with key-value pairs to spread into API parameters
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // Shallow clone — safeParseJSON is LRU-cached and returns the same
        // object reference for the same string. Mutating `result` below
        // would poison the cache, causing stale values to persist.
        result = { ...(parsed as JsonObject) }
      } else {
        logForDebugging(
          `CLAUDE_CODE_EXTRA_BODY env var must be a JSON object, but was given ${extraBodyStr}`,
          { level: 'error' },
        )
      }
    } catch (error) {
      logForDebugging(
        `Error parsing CLAUDE_CODE_EXTRA_BODY: ${errorMessage(error)}`,
        { level: 'error' },
      )
    }
  }

  // Anti-distillation: send fake_tools opt-in for 1P CLI only
  if (
    feature('ANTI_DISTILLATION_CC')
      ? process.env.CLAUDE_CODE_ENTRYPOINT === 'cli' &&
        shouldIncludeFirstPartyOnlyBetas() &&
        getFeatureValue_CACHED_MAY_BE_STALE(
          'tengu_anti_distill_fake_tool_injection',
          false,
        )
      : false
  ) {
    result.anti_distillation = ['fake_tools']
  }

  // Handle beta headers if provided
  if (betaHeaders && betaHeaders.length > 0) {
    if (result.anthropic_beta && Array.isArray(result.anthropic_beta)) {
      // Add to existing array, avoiding duplicates
      const existingHeaders = result.anthropic_beta as string[]
      const newHeaders = betaHeaders.filter(
        header => !existingHeaders.includes(header),
      )
      result.anthropic_beta = [...existingHeaders, ...newHeaders]
    } else {
      // Create new array with the beta headers
      result.anthropic_beta = betaHeaders
    }
  }

  return result
}

export function getPromptCachingEnabled(model: string): boolean {
  // Prompt caching is an Anthropic-specific feature. Third-party providers
  // do not understand cache_control blocks and strict backends (e.g. Azure
  // Foundry) reject or flag requests that contain them.
  //
  // Exception: when the GitHub provider is configured in native Anthropic API
  // mode (CLAUDE_CODE_GITHUB_ANTHROPIC_API=1), requests are sent in Anthropic
  // format, so cache_control blocks are supported.
  const provider = getAPIProvider()
  const isNativeGithub = isGithubNativeAnthropicMode(model)
  if (
    (provider !== 'firstParty' || !isFirstPartyAnthropicBaseUrl()) &&
    provider !== 'bedrock' &&
    provider !== 'vertex' &&
    !isNativeGithub
  ) {
    return false
  }

  // Global disable takes precedence
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING)) return false

  // Check if we should disable for small/fast model
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_HAIKU)) {
    const smallFastModel = getSmallFastModel()
    if (model === smallFastModel) return false
  }

  // Check if we should disable for default Sonnet
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_SONNET)) {
    const defaultSonnet = getDefaultSonnetModel()
    if (model === defaultSonnet) return false
  }

  // Check if we should disable for default Opus
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_OPUS)) {
    const defaultOpus = getDefaultOpusModel()
    if (model === defaultOpus) return false
  }

  return true
}

export function getCacheControl({
  scope,
  querySource,
}: {
  scope?: CacheScope
  querySource?: QuerySource
} = {}): {
  type: 'ephemeral'
  ttl?: '1h'
  scope?: CacheScope
} {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL(querySource) && { ttl: '1h' }),
    ...(scope === 'global' && { scope }),
  }
}

/**
 * Determines if 1h TTL should be used for prompt caching.
 *
 * Only applied when:
 * 1. User is eligible (ant or subscriber within rate limits)
 * 2. The query source matches a pattern in the GrowthBook allowlist
 *
 * GrowthBook config shape: { allowlist: string[] }
 * Patterns support trailing '*' for prefix matching.
 * Examples:
 * - { allowlist: ["repl_main_thread*", "sdk"] } — main thread + SDK only
 * - { allowlist: ["repl_main_thread*", "sdk", "agent:*"] } — also subagents
 * - { allowlist: ["*"] } — all sources
 *
 * The allowlist is cached in STATE for session stability — prevents mixed
 * TTLs when GrowthBook's disk cache updates mid-request.
 */
function should1hCacheTTL(querySource?: QuerySource): boolean {
  // 3P Bedrock users get 1h TTL when opted in via env var — they manage their own billing
  // No GrowthBook gating needed since 3P users don't have GrowthBook configured
  if (
    getAPIProvider() === 'bedrock' &&
    isEnvTruthy(process.env.ENABLE_PROMPT_CACHING_1H_BEDROCK)
  ) {
    return true
  }

  // Latch eligibility in bootstrap state for session stability — prevents
  // mid-session overage flips from changing the cache_control TTL, which
  // would bust the server-side prompt cache (~20K tokens per flip).
  let userEligible = getPromptCache1hEligible()
  if (userEligible === null) {
    userEligible =
      process.env.USER_TYPE === 'ant' ||
      (isClaudeAISubscriber() && !currentLimits.isUsingOverage)
    setPromptCache1hEligible(userEligible)
  }
  if (!userEligible) return false

  // Cache allowlist in bootstrap state for session stability — prevents mixed
  // TTLs when GrowthBook's disk cache updates mid-request
  let allowlist = getPromptCache1hAllowlist()
  if (allowlist === null) {
    const config = getFeatureValue_CACHED_MAY_BE_STALE<{
      allowlist?: string[]
    }>('tengu_prompt_cache_1h_config', {})
    allowlist = config.allowlist ?? []
    setPromptCache1hAllowlist(allowlist)
  }

  return (
    querySource !== undefined &&
    allowlist.some(pattern =>
      pattern.endsWith('*')
        ? querySource.startsWith(pattern.slice(0, -1))
        : querySource === pattern,
    )
  )
}

/**
 * Configure effort parameters for API request.
 *
 */
function configureEffortParams(
  effortValue: Exclude<EffortValue, 'ultracode'> | undefined,
  outputConfig: BetaOutputConfig,
  extraBodyParams: Record<string, unknown>,
  betas: string[],
  model: string,
): void {
  if (!modelSupportsEffort(model) || 'effort' in outputConfig) {
    return
  }

  if (effortValue === undefined) {
    betas.push(EFFORT_BETA_HEADER)
  } else if (typeof effortValue === 'string') {
    // Send string effort level as is
    outputConfig.effort = effortValue
    betas.push(EFFORT_BETA_HEADER)
  } else if (process.env.USER_TYPE === 'ant') {
    // Numeric effort override - internal-only (uses anthropic_internal)
    const existingInternal =
      (extraBodyParams.anthropic_internal as Record<string, unknown>) || {}
    extraBodyParams.anthropic_internal = {
      ...existingInternal,
      effort_override: effortValue,
    }
  }
}

// output_config.task_budget — API-side token budget awareness for the model.
// Stainless SDK types don't yet include task_budget on BetaOutputConfig, so we
// define the wire shape locally and cast. The API validates on receipt; see
// api/api/schemas/messages/request/output_config.py:12-39 in the monorepo.
// Beta: task-budgets-2026-03-13 (EAP, claude-strudel-eap only as of Mar 2026).
type TaskBudgetParam = {
  type: 'tokens'
  total: number
  remaining?: number
}

export function configureTaskBudgetParams(
  taskBudget: Options['taskBudget'],
  outputConfig: BetaOutputConfig & { task_budget?: TaskBudgetParam },
  betas: string[],
): void {
  if (
    !taskBudget ||
    'task_budget' in outputConfig ||
    !shouldIncludeFirstPartyOnlyBetas()
  ) {
    return
  }
  outputConfig.task_budget = {
    type: 'tokens',
    total: taskBudget.total,
    ...(taskBudget.remaining !== undefined && {
      remaining: taskBudget.remaining,
    }),
  }
  if (!betas.includes(TASK_BUDGETS_BETA_HEADER)) {
    betas.push(TASK_BUDGETS_BETA_HEADER)
  }
}

export function getAPIMetadata() {
  // https://docs.google.com/document/d/1dURO9ycXXQCBS0V4Vhl4poDBRgkelFc5t2BNPoEgH5Q/edit?tab=t.0#heading=h.5g7nec5b09w5
  let extra: JsonObject = {}
  const extraStr = process.env.CLAUDE_CODE_EXTRA_METADATA
  if (extraStr) {
    const parsed = safeParseJSON(extraStr, false)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      extra = parsed as JsonObject
    } else {
      logForDebugging(
        `CLAUDE_CODE_EXTRA_METADATA env var must be a JSON object, but was given ${extraStr}`,
        { level: 'error' },
      )
    }
  }

  return {
    user_id: jsonStringify({
      ...extra,
      device_id: getOrCreateUserID(),
      // Only include OAuth account UUID when actively using OAuth authentication
      account_uuid: getOauthAccountInfo()?.accountUuid ?? '',
      session_id: getSessionId(),
    }),
  }
}

export async function verifyApiKey(
  apiKey: string,
  isNonInteractiveSession: boolean,
): Promise<boolean> {
  // Skip API verification if running in print mode (isNonInteractiveSession)
  if (isNonInteractiveSession) {
    return true
  }

  try {
    // WARNING: if you change this to use a non-Haiku model, this request will fail in 1P unless it uses getCLISyspromptPrefix.
    const model = getSmallFastModel()
    const betas = getModelBetas(model)
    return await returnValue(
      withRetry(
        () =>
          getAnthropicClient({
            apiKey,
            maxRetries: 3,
            model,
            source: 'verify_api_key',
          }),
        async anthropic => {
          const messages: MessageParam[] = [{ role: 'user', content: 'test' }]
          // biome-ignore lint/plugin: API key verification is intentionally a minimal direct call
          await anthropic.beta.messages.create({
            model,
            max_tokens: 1,
            messages,
            temperature: 1,
            ...(betas.length > 0 && { betas }),
            metadata: getAPIMetadata(),
            ...getExtraBodyParams(),
          })
          return true
        },
        { maxRetries: 2, model, thinkingConfig: { type: 'disabled' } }, // Use fewer retries for API key verification
      ),
    )
  } catch (errorFromRetry) {
    let error = errorFromRetry
    if (errorFromRetry instanceof CannotRetryError) {
      error = errorFromRetry.originalError
    }
    logError(error)
    // Check for authentication error
    if (
      error instanceof Error &&
      error.message.includes(
        '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      )
    ) {
      return false
    }
    throw error
  }
}

export function userMessageToMessageParam(
  message: UserMessage,
  addCache = false,
  enablePromptCaching: boolean,
  querySource?: QuerySource,
): MessageParam {
  if (addCache) {
    if (typeof message.message.content === 'string') {
      return {
        role: 'user',
        content: [
          {
            type: 'text',
            text: message.message.content,
            ...(enablePromptCaching && {
              cache_control: getCacheControl({ querySource }),
            }),
          },
        ],
      }
    } else {
      return {
        role: 'user',
        content: message.message.content.map((_, i) => ({
          ..._,
          ...(i === message.message.content.length - 1
            ? enablePromptCaching
              ? { cache_control: getCacheControl({ querySource }) }
              : {}
            : {}),
        })),
      }
    }
  }
  // Clone array content to prevent in-place mutations (e.g., insertCacheEditsBlock's
  // splice) from contaminating the original message. Without cloning, multiple calls
  // to addCacheBreakpoints share the same array and each splices in duplicate cache_edits.
  return {
    role: 'user',
    content: Array.isArray(message.message.content)
      ? [...message.message.content]
      : message.message.content,
  }
}

export function assistantMessageToMessageParam(
  message: AssistantMessage,
  addCache = false,
  enablePromptCaching: boolean,
  querySource?: QuerySource,
): MessageParam {
  if (addCache) {
    if (typeof message.message.content === 'string') {
      return {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: message.message.content,
            ...(enablePromptCaching && {
              cache_control: getCacheControl({ querySource }),
            }),
          },
        ],
      }
    } else {
      return {
        role: 'assistant',
        content: message.message.content.map((_, i) => ({
          ..._,
          ...(i === message.message.content.length - 1 &&
          _.type !== 'thinking' &&
          _.type !== 'redacted_thinking' &&
          (feature('CONNECTOR_TEXT') ? !isConnectorTextBlock(_) : true)
            ? enablePromptCaching
              ? { cache_control: getCacheControl({ querySource }) }
              : {}
            : {}),
        })),
      }
    }
  }
  return {
    role: 'assistant',
    content: message.message.content,
  }
}

export type Options = {
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  model: string
  /** Original selection used only for provider-side alias routing. */
  requestModel?: string
  toolChoice?: BetaToolChoiceTool | BetaToolChoiceAuto | undefined
  isNonInteractiveSession: boolean
  extraToolSchemas?: BetaToolUnion[]
  maxOutputTokensOverride?: number
  fallbackModel?: string
  onStreamingFallback?: () => void
  querySource: QuerySource
  agents: AgentDefinition[]
  allowedAgentTypes?: string[]
  hasAppendSystemPrompt: boolean
  fetchOverride?: ClientOptions['fetch']
  enablePromptCaching?: boolean
  skipCacheWrite?: boolean
  temperatureOverride?: number
  effortValue?: EffortValue
  mcpTools: Tools
  hasPendingMcpServers?: boolean
  queryTracking?: QueryChainTracking
  agentId?: AgentId // Only set for subagents
  outputFormat?: BetaJSONOutputFormat
  fastMode?: boolean
  advisorModel?: string
  addNotification?: (notif: Notification) => void
  // API-side task budget (output_config.task_budget). Distinct from the
  // tokenBudget.ts +500k auto-continue feature — this one is sent to the API
  // so the model can pace itself. `remaining` is computed by the caller
  // (query.ts decrements across the agentic loop).
  taskBudget?: { total: number; remaining?: number }
  providerOverride?: { model: string; baseURL: string; apiKey: string }
  queryLifecycle?: QueryLifecycleOperationTracker
  messageNormalizationTools?: Tools
  /**
   * Synchronous ownership check invoked immediately before an outbound
   * provider request. Returning false skips the request without retrying.
   */
  onProviderRequestStart?: () => boolean
}

export async function queryModelWithoutStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): Promise<AssistantMessage> {
  // Store the assistant message but continue consuming the generator to ensure
  // logAPISuccessAndDuration gets called (which happens after all yields)
  let assistantMessage: AssistantMessage | undefined
  for await (const message of withStreamingVCR(messages, async function* () {
    yield* queryModel(
      messages,
      systemPrompt,
      thinkingConfig,
      tools,
      signal,
      options,
    )
  })) {
    if (message.type === 'assistant') {
      assistantMessage = message
    }
  }
  if (!assistantMessage) {
    // If the signal was aborted, throw APIUserAbortError instead of a generic error
    // This allows callers to handle abort scenarios gracefully
    if (signal.aborted) {
      throw new APIUserAbortError()
    }
    throw new Error('No assistant message found')
  }
  return assistantMessage
}

export async function* queryModelWithStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  return yield* withStreamingVCR(messages, async function* () {
    yield* queryModel(
      messages,
      systemPrompt,
      thinkingConfig,
      tools,
      signal,
      options,
    )
  })
}

export function getClaudeStreamingAbortLogMessage(
  signal: Pick<AbortSignal, 'reason'>,
  streamingError: unknown,
): string {
  return getStreamingAbortMessage(signal.reason, errorMessage(streamingError))
}

export function getClaudeExpectedSideTaskApiAbortLogMessage(
  signal: Pick<AbortSignal, 'aborted' | 'reason'>,
  errorFromRetry: unknown,
): string | null {
  if (!signal.aborted || !isExpectedSideTaskAbortReason(signal.reason)) {
    return null
  }
  const error =
    errorFromRetry instanceof CannotRetryError
      ? errorFromRetry.originalError
      : errorFromRetry
  if (!(error instanceof APIUserAbortError)) {
    return null
  }
  return `Expected side-task API abort (${normalizeAbortReason(signal.reason)}): ${errorMessage(error)}`
}

function handleClaudeExpectedSideTaskApiAbort(
  signal: Pick<AbortSignal, 'aborted' | 'reason'>,
  errorFromRetry: unknown,
  releaseStreamResources: () => void,
): boolean {
  const expectedSideTaskAbortLogMessage =
    getClaudeExpectedSideTaskApiAbortLogMessage(signal, errorFromRetry)
  if (!expectedSideTaskAbortLogMessage) return false
  if (!(errorFromRetry instanceof CannotRetryError)) {
    logForDebugging(expectedSideTaskAbortLogMessage)
  }
  releaseStreamResources()
  return true
}

/**
 * Determines if an LSP tool should be deferred (tool appears with defer_loading: true)
 * because LSP initialization is not yet complete.
 */
function shouldDeferLspTool(tool: Tool): boolean {
  if (!('isLsp' in tool) || !tool.isLsp) {
    return false
  }
  const status = getInitializationStatus()
  // Defer when pending or not started
  return status.status === 'pending' || status.status === 'not-started'
}

/**
 * Per-attempt timeout for non-streaming fallback requests, in milliseconds.
 * Reads API_TIMEOUT_MS when set so slow backends and the streaming path
 * share the same ceiling.
 *
 * Remote sessions default to 120s to stay under CCR's container idle-kill
 * (~5min) so a hung fallback to a wedged backend surfaces a clean
 * APIConnectionTimeoutError instead of stalling past SIGKILL.
 *
 * Otherwise defaults to 300s — long enough for slow backends without
 * approaching the API's 10-minute non-streaming boundary.
 */
export function getNonstreamingFallbackTimeoutMs(): number {
  // Validate and clamp API_TIMEOUT_MS through the shared parser so a malformed
  // or negative override cannot yield a NaN/negative timeout; fall back to the
  // context-specific default (shorter on remote to stay under CCR's idle-kill).
  return getApiTimeoutMs(
    process.env,
    isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) ? 120_000 : 300_000,
  )
}

/**
 * Helper generator for non-streaming API requests.
 * Encapsulates the common pattern of creating a withRetry generator,
 * iterating to yield system messages, and returning the final BetaMessage.
 */
export async function* executeNonStreamingRequest(
  clientOptions: {
    model: string
    fetchOverride?: Options['fetchOverride']
    source: string
    providerOverride?: Options['providerOverride']
    effortValue?: EffortValue
  },
  retryOptions: {
    model: string
    fallbackModel?: string
    thinkingConfig: ThinkingConfig
    fastMode?: boolean
    signal: AbortSignal
    initialConsecutive529Errors?: number
    querySource?: QuerySource
  },
  paramsFromContext: (context: RetryContext) => BetaMessageStreamParams,
  onAttempt: (attempt: number, start: number, maxOutputTokens: number) => void,
  captureRequest: (params: BetaMessageStreamParams) => void,
  /**
   * Request ID of the failed streaming attempt this fallback is recovering
   * from. Emitted in tengu_nonstreaming_fallback_error for funnel correlation.
   */
  originatingRequestId?: string | null,
  queryLifecycle?: QueryLifecycleOperationTracker,
  onProviderRequestStart?: () => boolean,
): AsyncGenerator<SystemAPIErrorMessage, BetaMessage | null> {
  const fallbackTimeoutMs = getNonstreamingFallbackTimeoutMs()
  const generator = withRetry(
    () =>
      getAnthropicClient({
        maxRetries: 0,
        model: clientOptions.model,
        fetchOverride: clientOptions.fetchOverride,
        source: clientOptions.source,
        providerOverride: clientOptions.providerOverride,
        effortValue: clientOptions.effortValue,
      }),
    async (anthropic, attempt, context) => {
      const start = Date.now()
      if (onProviderRequestStart?.() === false) return null
      const retryParams = paramsFromContext(context)
      captureRequest(retryParams)
      onAttempt(attempt, start, retryParams.max_tokens)

      const adjustedParams = adjustParamsForNonStreaming(
        retryParams,
        MAX_NON_STREAMING_TOKENS,
      )
      const activeApiCallKey =
        queryLifecycle?.startApiCall({
          model: context.model,
          querySource: retryOptions.querySource,
          startedAt: start,
        }) ?? null

      try {
        // biome-ignore lint/plugin: non-streaming API call
        return await anthropic.beta.messages.create(
          {
            ...adjustedParams,
            model: normalizeModelStringForAPI(adjustedParams.model),
          },
          {
            signal: retryOptions.signal,
            timeout: fallbackTimeoutMs,
          },
        )
      } catch (err) {
        // User aborts are not errors — re-throw immediately without logging
        if (err instanceof APIUserAbortError) throw err

        // Instrumentation: record when the non-streaming request errors (including
        // timeouts). Lets us distinguish "fallback hung past container kill"
        // (no event) from "fallback hit the bounded timeout" (this event).
        logForDiagnosticsNoPII('error', 'cli_nonstreaming_fallback_error')
        logEvent('tengu_nonstreaming_fallback_error', {
          model:
            clientOptions.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          error:
            err instanceof Error
              ? (err.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
              : ('unknown' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
          attempt,
          timeout_ms: fallbackTimeoutMs,
          request_id: (originatingRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw err
      } finally {
        if (activeApiCallKey) {
          queryLifecycle?.endApiCall(activeApiCallKey)
        }
      }
    },
    {
      model: retryOptions.model,
      fallbackModel: retryOptions.fallbackModel,
      thinkingConfig: retryOptions.thinkingConfig,
      ...(isFastModeEnabled() && { fastMode: retryOptions.fastMode }),
      signal: retryOptions.signal,
      initialConsecutive529Errors: retryOptions.initialConsecutive529Errors,
      querySource: retryOptions.querySource,
    },
  )

  let e
  do {
    e = await generator.next()
    if (!e.done && e.value.type === 'system') {
      yield e.value
    }
  } while (!e.done)

  return e.value as BetaMessage | null
}

/**
 * Extracts the request ID from the most recent assistant message in the
 * conversation. Used to link consecutive API requests in analytics so we can
 * join them for cache-hit-rate analysis and incremental token tracking.
 *
 * Deriving this from the message array (rather than global state) ensures each
 * query chain (main thread, subagent, teammate) tracks its own request chain
 * independently, and rollback/undo naturally updates the value.
 */
function getPreviousRequestIdFromMessages(
  messages: Message[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.type === 'assistant' && msg.requestId) {
      return msg.requestId
    }
  }
  return undefined
}

// Generic so it accepts both top-level content blocks and the narrower
// (beta or non-beta) unions nested inside tool_result content.
function isMedia<T extends { type: string }>(
  block: T,
): block is T & (BetaImageBlockParam | BetaRequestDocumentBlock) {
  return block.type === 'image' || block.type === 'document'
}

function isToolResult(
  block: BetaContentBlockParam,
): block is BetaToolResultBlockParam {
  return block.type === 'tool_result'
}

/**
 * Ensures messages contain at most `limit` media items (images + documents).
 * Strips oldest media first to preserve the most recent.
 */
export function stripExcessMediaItems(
  messages: (UserMessage | AssistantMessage)[],
  limit: number,
): (UserMessage | AssistantMessage)[] {
  let toRemove = 0
  for (const msg of messages) {
    if (!Array.isArray(msg.message.content)) continue
    for (const block of msg.message.content) {
      if (isMedia(block)) toRemove++
      if (isToolResult(block) && Array.isArray(block.content)) {
        for (const nested of block.content) {
          if (isMedia(nested as BetaContentBlockParam)) toRemove++
        }
      }
    }
  }
  toRemove -= limit
  if (toRemove <= 0) return messages

  return messages.map(msg => {
    if (toRemove <= 0) return msg
    const content = msg.message.content
    if (!Array.isArray(content)) return msg

    const before = toRemove
    const stripped = content
      .map(block => {
        if (
          toRemove <= 0 ||
          !isToolResult(block) ||
          !Array.isArray(block.content)
        )
          return block
        const filtered = block.content.filter(n => {
          if (toRemove > 0 && isMedia(n as BetaContentBlockParam)) {
            toRemove--
            return false
          }
          return true
        })
        return filtered.length === block.content.length
          ? block
          : { ...block, content: filtered }
      })
      .filter(block => {
        if (toRemove > 0 && isMedia(block)) {
          toRemove--
          return false
        }
        return true
      })

    return before === toRemove
      ? msg
      : {
          ...msg,
          message: { ...msg.message, content: stripped },
        }
  }) as (UserMessage | AssistantMessage)[]
}

/**
 * Tool-history compression routing for Anthropic-native transports (exported
 * for focused tests — queryModel itself needs a live client to exercise).
 * Native transports (first-party, Bedrock, Vertex, GitHub-native-Anthropic)
 * compress only while prompt caching is inactive: retroactive tier rewrites
 * diverge the cached request prefix and cost more than they save. Requests
 * carrying a per-agent providerOverride are shim-routed and compress at the
 * shim layer instead.
 */
export function shouldCompressNativeToolHistory(options: {
  apiProvider: string
  // firstParty alone is not enough: a custom ANTHROPIC_BASE_URL (proxy /
  // compatible endpoint) also reports firstParty, but getPromptCachingEnabled
  // already returns false there — treating it as native would compress every
  // request against an endpoint we make no assumptions about. Mirror the
  // same base-URL guard prompt caching itself uses.
  isFirstPartyBaseUrl: boolean
  isGithubNativeAnthropic: boolean
  hasProviderOverride: boolean
  promptCachingEnabled: boolean
}): boolean {
  const isNativeTransport =
    (options.apiProvider === 'firstParty' && options.isFirstPartyBaseUrl) ||
    options.apiProvider === 'bedrock' ||
    options.apiProvider === 'vertex' ||
    options.isGithubNativeAnthropic
  return (
    isNativeTransport &&
    !options.hasProviderOverride &&
    !options.promptCachingEnabled
  )
}

async function* queryModel(
  messages: Message[],
  systemPrompt: SystemPrompt,
  thinkingConfig: ThinkingConfig,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  const providerRequestModel = options.requestModel ?? options.model
  function traceFallbackSettlement(
    outcome: 'superseded' | 'aborted' | 'failed' | 'completed',
    causalEventId: string | undefined,
    error?: unknown,
  ): void {
    traceInterruptionEvent('claude_stream.fallback_settled', {
      subsystem: 'claude_stream',
      transport: 'anthropic_messages',
      model: options.model,
      outcome,
      causalEventId,
      ...(error === undefined ? {} : { error }),
    })
    flushInterruptionTrace('claude_stream_fallback_settled')
  }
  // Check cheap conditions first — the off-switch await blocks on GrowthBook
  // init (~10ms). For non-Opus models (haiku, sonnet) this skips the await
  // entirely. Subscribers don't hit this path at all.
  if (
    isFirstPartyAnthropicBaseUrl() &&
    !isClaudeAISubscriber() &&
    isNonCustomOpusModel(options.model) &&
    (
      await getDynamicConfig_BLOCKS_ON_INIT<{ activated: boolean }>(
        'tengu-off-switch',
        {
          activated: false,
        },
      )
    ).activated
  ) {
    logEvent('tengu_off_switch_query', {})
    yield getAssistantMessageFromError(
      new Error(CUSTOM_OFF_SWITCH_MESSAGE),
      options.model,
    )
    return
  }

  // Derive previous request ID from the last assistant message in this query chain.
  // This is scoped per message array (main thread, subagent, teammate each have their own),
  // so concurrent agents don't clobber each other's request chain tracking.
  // Also naturally handles rollback/undo since removed messages won't be in the array.
  const previousRequestId = getPreviousRequestIdFromMessages(messages)

  const resolvedModel =
    getAPIProvider() === 'bedrock' &&
    options.model.includes('application-inference-profile')
      ? ((await getInferenceProfileBackingModel(options.model)) ??
        options.model)
      : options.model

  queryCheckpoint('query_tool_schema_build_start')
  const isAgenticQuery =
    options.querySource.startsWith('repl_main_thread') ||
    options.querySource.startsWith('agent:') ||
    options.querySource === 'sdk' ||
    options.querySource === 'hook_agent' ||
    options.querySource === 'verification_agent'
  const betas = getMergedBetas(options.model, { isAgenticQuery })

  // Always send the advisor beta header when advisor is enabled, so
  // non-agentic queries (compact, side_question, extract_memories, etc.)
  // can parse advisor server_tool_use blocks already in the conversation history.
  if (isAdvisorEnabled()) {
    betas.push(ADVISOR_BETA_HEADER)
  }

  let advisorModel: string | undefined
  if (isAgenticQuery && isAdvisorEnabled()) {
    let advisorOption = options.advisorModel

    const advisorExperiment = getExperimentAdvisorModels()
    if (advisorExperiment !== undefined) {
      if (
        normalizeModelStringForAPI(advisorExperiment.baseModel) ===
        normalizeModelStringForAPI(options.model)
      ) {
        // Override the advisor model if the base model matches. We
        // should only have experiment models if the user cannot
        // configure it themselves.
        advisorOption = advisorExperiment.advisorModel
      }
    }

    if (advisorOption) {
      const normalizedAdvisorModel = normalizeModelStringForAPI(
        parseUserSpecifiedModel(advisorOption),
      )
      if (!modelSupportsAdvisor(options.model)) {
        logForDebugging(
          `[AdvisorTool] Skipping advisor - base model ${options.model} does not support advisor`,
        )
      } else if (!isValidAdvisorModel(normalizedAdvisorModel)) {
        logForDebugging(
          `[AdvisorTool] Skipping advisor - ${normalizedAdvisorModel} is not a valid advisor model`,
        )
      } else {
        advisorModel = normalizedAdvisorModel
        logForDebugging(
          `[AdvisorTool] Server-side tool enabled with ${advisorModel} as the advisor model`,
        )
      }
    }
  }

  // Check if tool search is enabled (checks mode, model support, and threshold for auto mode)
  // This is async because it may need to calculate MCP tool description sizes for TstAuto mode
  let useToolSearch = await isToolSearchEnabled(
    options.model,
    tools,
    options.getToolPermissionContext,
    options.agents,
    'query',
  )

  // Precompute once — isDeferredTool does 2 GrowthBook lookups per call
  const deferredToolNames = new Set<string>()
  if (useToolSearch) {
    for (const t of tools) {
      if (isDeferredTool(t)) deferredToolNames.add(t.name)
    }
  }

  // Even if tool search mode is enabled, skip if there are no deferred tools
  // AND no MCP servers are still connecting. When servers are pending, keep
  // ToolSearch available so the model can discover tools after they connect.
  if (
    useToolSearch &&
    deferredToolNames.size === 0 &&
    !options.hasPendingMcpServers
  ) {
    logForDebugging(
      'Tool search disabled: no deferred tools available to search',
    )
    useToolSearch = false
  }

  // Filter out ToolSearchTool if tool search is not enabled for this model
  // ToolSearchTool returns tool_reference blocks which unsupported models can't handle
  let filteredTools: Tools

  if (useToolSearch) {
    // Dynamic tool loading: Only include deferred tools that have been discovered
    // via tool_reference blocks in the message history. This eliminates the need
    // to predeclare all deferred tools upfront and removes limits on tool quantity.
    const discoveredToolNames = extractDiscoveredToolNames(messages)

    filteredTools = tools.filter(tool => {
      // Always include non-deferred tools
      if (!deferredToolNames.has(tool.name)) return true
      // Always include ToolSearchTool (so it can discover more tools)
      if (toolMatchesName(tool, TOOL_SEARCH_TOOL_NAME)) return true
      // Only include deferred tools that have been discovered
      return discoveredToolNames.has(tool.name)
    })
  } else {
    filteredTools = tools.filter(
      t => !toolMatchesName(t, TOOL_SEARCH_TOOL_NAME),
    )
  }

  // Add tool search beta header if enabled - required for defer_loading to be accepted
  // Header differs by provider: 1P/Foundry use advanced-tool-use, Vertex/Bedrock use tool-search-tool
  // For Bedrock, this header must go in extraBodyParams, not the betas array
  const toolSearchHeader = useToolSearch ? getToolSearchBetaHeader() : null
  if (toolSearchHeader && getAPIProvider() !== 'bedrock') {
    if (!betas.includes(toolSearchHeader)) {
      betas.push(toolSearchHeader)
    }
  }

  // Determine if cached microcompact is enabled for this model.
  // Computed once here (in async context) and captured by paramsFromContext.
  // The beta header is also captured here to avoid a top-level import of the
  // internal-only CACHE_EDITING_BETA_HEADER constant.
  let cachedMCEnabled = false
  let cacheEditingBetaHeader = ''
  if (feature('CACHED_MICROCOMPACT')) {
    const {
      isCachedMicrocompactEnabled,
      isModelSupportedForCacheEditing,
      getCachedMCConfig,
    } = await import('../compact/cachedMicrocompact.js')
    const betas = await import('src/constants/betas.js')
    cacheEditingBetaHeader = betas.CACHE_EDITING_BETA_HEADER
    const featureEnabled = isCachedMicrocompactEnabled()
    const modelSupported = isModelSupportedForCacheEditing(options.model)
    cachedMCEnabled = featureEnabled && modelSupported
    const config = getCachedMCConfig()
    logForDebugging(
      `Cached MC gate: enabled=${featureEnabled} modelSupported=${modelSupported} model=${options.model} supportedModels=${jsonStringify((config as Record<string, unknown> | null)?.supportedModels)}`,
    )
  }

  const useGlobalCacheFeature = shouldUseGlobalCacheScope()
  const willDefer = (t: Tool) =>
    useToolSearch && (deferredToolNames.has(t.name) || shouldDeferLspTool(t))
  // MCP tools are per-user → dynamic tool section → can't globally cache.
  // Only gate when an MCP tool will actually render (not defer_loading).
  const needsToolBasedCacheMarker =
    useGlobalCacheFeature &&
    filteredTools.some(t => t.isMcp === true && !willDefer(t))

  // Ensure prompt_caching_scope beta header is present when global cache is enabled.
  if (
    useGlobalCacheFeature &&
    !betas.includes(PROMPT_CACHING_SCOPE_BETA_HEADER)
  ) {
    betas.push(PROMPT_CACHING_SCOPE_BETA_HEADER)
  }

  // Determine global cache strategy for logging
  const globalCacheStrategy: GlobalCacheStrategy = useGlobalCacheFeature
    ? needsToolBasedCacheMarker
      ? 'none'
      : 'system_prompt'
    : 'none'

  // Build tool schemas, adding defer_loading for MCP tools when tool search is enabled
  // Note: We pass the full `tools` list (not filteredTools) to toolToAPISchema so that
  // ToolSearchTool's prompt can list ALL available MCP tools. The filtering only affects
  // which tools are actually sent to the API, not what the model sees in tool descriptions.
  const toolSchemas = await Promise.all(
    filteredTools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext: options.getToolPermissionContext,
        tools,
        agents: options.agents,
        allowedAgentTypes: options.allowedAgentTypes,
        model: options.model,
        deferLoading: willDefer(tool),
      }),
    ),
  )

  if (useToolSearch) {
    const includedDeferredTools = count(filteredTools, t =>
      deferredToolNames.has(t.name),
    )
    logForDebugging(
      `Dynamic tool loading: ${includedDeferredTools}/${deferredToolNames.size} deferred tools included`,
    )
  }

  queryCheckpoint('query_tool_schema_build_end')

  // Compress old tool outputs for Anthropic-native transports, but only when
  // prompt caching is inactive. Rewriting old messages as they cross tier
  // boundaries diverges the request prefix on every call, which breaks the
  // prompt cache and costs more than the compression saves — cached native
  // sessions rely on microCompact (cache-aware) instead. Shim-routed traffic
  // (OpenAI-compatible env providers, per-agent providerOverride, Codex)
  // compresses at its own layer, where the local fast-path opt-out applies.
  // compressToolHistory is generic over AnyMessage — cast to satisfy the type
  // checker since OpenClaude's Message union is a superset of what the
  // function actually inspects.
  const compressNativeToolHistory = shouldCompressNativeToolHistory({
    apiProvider: getAPIProvider(),
    isFirstPartyBaseUrl: isFirstPartyAnthropicBaseUrl(),
    isGithubNativeAnthropic: isGithubNativeAnthropicMode(options.model),
    hasProviderOverride: Boolean(options.providerOverride),
    promptCachingEnabled: getPromptCachingEnabled(options.model),
  })
  if (compressNativeToolHistory) {
    const { compressToolHistory } = await import('./compressToolHistory.js')
    messages = compressToolHistory(
      messages as unknown as Parameters<typeof compressToolHistory>[0],
      options.model,
      { effectiveContextWindowSize: getContextWindowForModel(options.model, getSdkBetas()) },
    ) as typeof messages
  }

  // Normalize messages before building system prompt (needed for fingerprinting)
  // Instrumentation: Track message count before normalization
  logEvent('tengu_api_before_normalize', {
    preNormalizedMessageCount: messages.length,
  })

  queryCheckpoint('query_message_normalization_start')
  let messagesForAPI = normalizeMessagesForAPI(
    messages,
    options.messageNormalizationTools ?? filteredTools,
  )
  queryCheckpoint('query_message_normalization_end')

  // Apply hybrid context strategy for optimal cache/fresh balance
  if (feature('HYBRID_CONTEXT_STRATEGY')) {
    const { applyHybridStrategy } = await import('../../utils/hybridContextStrategy.js')
    // Cap at 200k to avoid edge case with very large context windows
    const strategyResult = applyHybridStrategy(messagesForAPI, {
      cacheWeight: 0.4,
      freshWeight: 0.6,
      maxTotalTokens: Math.max(
        0,
        Math.min(
          getContextWindowForModel(options.model, getSdkBetas()) - COMPACT_MAX_OUTPUT_TOKENS,
          200000,
        ),
      ),
    })
    // applyHybridStrategy is typed over the full Message union but only ever
    // receives (and returns) the user/assistant subset passed in here.
    messagesForAPI = strategyResult.selectedMessages as typeof messagesForAPI
  }

  // Model-specific post-processing: strip tool-search-specific fields if the
  // selected model doesn't support tool search.
  //
  // Why is this needed in addition to normalizeMessagesForAPI?
  // - normalizeMessagesForAPI uses isToolSearchEnabledNoModelCheck() because it's
  //   called from ~20 places (analytics, feedback, sharing, etc.), many of which
  //   don't have model context. Adding model to its signature would be a large refactor.
  // - This post-processing uses the model-aware isToolSearchEnabled() check
  // - This handles mid-conversation model switching (e.g., Sonnet → Haiku) where
  //   stale tool-search fields from the previous model would cause 400 errors
  //
  // Note: For assistant messages, normalizeMessagesForAPI already normalized the
  // tool inputs, so stripCallerFieldFromAssistantMessage only needs to remove the
  // 'caller' field (not re-normalize inputs).
  if (!useToolSearch) {
    messagesForAPI = messagesForAPI.map(msg => {
      switch (msg.type) {
        case 'user':
          // Strip tool_reference blocks from tool_result content
          return stripToolReferenceBlocksFromUserMessage(msg)
        case 'assistant':
          // Strip 'caller' field from tool_use blocks
          return stripCallerFieldFromAssistantMessage(msg)
        default:
          return msg
      }
    })
  }

  // Repair tool_use/tool_result pairing mismatches that can occur when resuming
  // remote/teleport sessions. Inserts synthetic error tool_results for orphaned
  // tool_uses and strips orphaned tool_results referencing non-existent tool_uses.
  messagesForAPI = ensureToolResultPairing(messagesForAPI, {
    phase: 'api_before_repair',
    querySource: options.querySource,
    agentId: options.agentId,
    model: options.model,
    provider: getAPIProvider(),
  })

  // Strip advisor blocks — the API rejects them without the beta header.
  if (!betas.includes(ADVISOR_BETA_HEADER)) {
    messagesForAPI = stripAdvisorBlocks(messagesForAPI)
  }

  // Strip excess media items before making the API call.
  // The API rejects requests with >100 media items but returns a confusing error.
  // Rather than erroring (which is hard to recover from in Cowork/CCD), we
  // silently drop the oldest media items to stay within the limit.
  messagesForAPI = stripExcessMediaItems(
    messagesForAPI,
    API_MAX_MEDIA_PER_REQUEST,
  )

  // Instrumentation: Track message count after normalization
  logEvent('tengu_api_after_normalize', {
    postNormalizedMessageCount: messagesForAPI.length,
  })

  // Compute fingerprint from first user message for attribution.
  // Must run BEFORE injecting synthetic messages (e.g. deferred tool names)
  // so the fingerprint reflects the actual user input.
  const fingerprint = computeFingerprintFromMessages(messagesForAPI)

  // When the delta attachment is enabled, deferred tools are announced
  // via persisted deferred_tools_delta attachments instead of this
  // ephemeral prepend (which busts cache whenever the pool changes).
  if (useToolSearch && !isDeferredToolsDeltaEnabled()) {
    const deferredToolList = tools
      .filter(t => deferredToolNames.has(t.name))
      .map(formatDeferredToolLine)
      .sort()
      .join('\n')
    if (deferredToolList) {
      messagesForAPI = [
        createUserMessage({
          content: `<available-deferred-tools>\n${deferredToolList}\n</available-deferred-tools>`,
          isMeta: true,
        }),
        ...messagesForAPI,
      ]
    }
  }

  // Chrome tool-search instructions: when the delta attachment is enabled,
  // these are carried as a client-side block in mcp_instructions_delta
  // (attachments.ts) instead of here. This per-request sys-prompt append
  // busts the prompt cache when chrome connects late.
  const hasChromeTools = filteredTools.some(t =>
    isToolFromMcpServer(t.name, CLAUDE_IN_CHROME_MCP_SERVER_NAME),
  )
  const injectChromeHere =
    useToolSearch && hasChromeTools && !isMcpInstructionsDeltaEnabled()

  const attributionEnabled = isAttributionHeaderEnabled()

  // Build the stable prompt here, but delay attribution and request blocks
  // until client creation has normalized the effective provider route.
  systemPrompt = asSystemPrompt(
    [
      getCLISyspromptPrefix({
        isNonInteractive: options.isNonInteractiveSession,
        hasAppendSystemPrompt: options.hasAppendSystemPrompt,
      }),
      ...systemPrompt,
      ...(advisorModel ? [ADVISOR_TOOL_INSTRUCTIONS] : []),
      ...(injectChromeHere ? [CHROME_TOOL_SEARCH_INSTRUCTIONS] : []),
    ].filter(Boolean),
  )
  const useBetas = betas.length > 0

  const extraToolSchemas = [...(options.extraToolSchemas ?? [])]
  if (advisorModel) {
    // Server tools must be in the tools array by API contract. Appended after
    // toolSchemas (which carries the cache_control marker) so toggling /advisor
    // only churns the small suffix, not the cached prefix.
    extraToolSchemas.push({
      type: 'advisor_20260301',
      name: 'advisor',
      model: advisorModel,
    } as unknown as BetaToolUnion)
  }
  const allTools = [...toolSchemas, ...extraToolSchemas]

  const isFastMode =
    isFastModeEnabled() &&
    isFastModeAvailable() &&
    !isFastModeCooldown() &&
    isFastModeSupportedByModel(options.model) &&
    !!options.fastMode

  // Sticky-on latches for dynamic beta headers. Each header, once first
  // sent, keeps being sent for the rest of the session so mid-session
  // toggles don't change the server-side cache key and bust ~50-70K tokens.
  // Latches are cleared on /clear and /compact via clearBetaHeaderLatches().
  // Per-call gates (isAgenticQuery, querySource===repl_main_thread) stay
  // per-call so non-agentic queries keep their own stable header set.

  let afkHeaderLatched = getAfkModeHeaderLatched() === true
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    if (
      !afkHeaderLatched &&
      isAgenticQuery &&
      shouldIncludeFirstPartyOnlyBetas() &&
      (autoModeStateModule?.isAutoModeActive() ?? false)
    ) {
      afkHeaderLatched = true
      setAfkModeHeaderLatched(true)
    }
  }

  let fastModeHeaderLatched = getFastModeHeaderLatched() === true
  if (!fastModeHeaderLatched && isFastMode) {
    fastModeHeaderLatched = true
    setFastModeHeaderLatched(true)
  }

  let cacheEditingHeaderLatched = getCacheEditingHeaderLatched() === true
  if (feature('CACHED_MICROCOMPACT')) {
    if (
      !cacheEditingHeaderLatched &&
      cachedMCEnabled &&
      getAPIProvider() === 'firstParty' &&
      isFirstPartyAnthropicBaseUrl() &&
      options.querySource === 'repl_main_thread'
    ) {
      cacheEditingHeaderLatched = true
      setCacheEditingHeaderLatched(true)
    }
  }

  // Only latch from agentic queries so a classifier call doesn't flip the
  // main thread's context_management mid-turn.
  let thinkingClearLatched = getThinkingClearLatched() === true
  if (!thinkingClearLatched && isAgenticQuery) {
    const lastCompletion = getLastApiCompletionTimestamp()
    if (
      lastCompletion !== null &&
      Date.now() - lastCompletion > CACHE_TTL_1HOUR_MS
    ) {
      thinkingClearLatched = true
      setThinkingClearLatched(true)
    }
  }

  // Latch Sonnet 1M experiment at query start so mid-retry GB refreshes
  // don't flip the beta header and bust the cache key.
  const sonnet1mExpLatched = getSonnet1mExpTreatmentEnabled(options.model)

  const effort = resolveAppliedEffort(options.model, options.effortValue)

  const startIncludingRetries = Date.now()
  let start = Date.now()
  let attemptNumber = 0
  const attemptStartTimes: number[] = []
  let stream: Stream<BetaRawMessageStreamEvent> | undefined = undefined
  let streamRequestId: string | null | undefined = undefined
  let clientRequestId: string | undefined = undefined
  let activeApiCallKey: string | null = null
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins -- Response is available in supported Node runtimes and is used by the SDK
  let streamResponse: Response | undefined = undefined

  function endActiveApiCall(key = activeApiCallKey): void {
    if (!key) return
    options.queryLifecycle?.endApiCall(key)
    if (activeApiCallKey === key) {
      activeApiCallKey = null
    }
  }

  function startActiveApiCall(call: Parameters<QueryLifecycleOperationTracker['startApiCall']>[0]): string | null {
    endActiveApiCall()
    activeApiCallKey = options.queryLifecycle?.startApiCall(call) ?? null
    return activeApiCallKey
  }

  // Release all stream resources to prevent native memory leaks.
  // The Response object holds native TLS/socket buffers that live outside the
  // V8 heap (observed on the Node.js/npm path; see GH #32920), so we must
  // explicitly cancel and release it regardless of how the generator exits.
  function releaseStreamResources(): void {
    cleanupStream(stream)
    stream = undefined
    if (streamResponse) {
      streamResponse.body?.cancel().catch(() => {})
      streamResponse = undefined
    }
  }

  // Consume pending cache edits ONCE before paramsFromContext is defined.
  // paramsFromContext is called multiple times (logging, retries), so consuming
  // inside it would cause the first call to steal edits from subsequent calls.
  const consumedCacheEdits = cachedMCEnabled ? consumePendingCacheEdits() : null
  const consumedPinnedEdits = cachedMCEnabled ? getPinnedCacheEdits() : []

  // Capture the betas sent in the last API request, including the ones that
  // were dynamically added, so we can log and send it to telemetry.
  let lastRequestBetas: string[] | undefined
  let apiPrefixLogged = false
  let promptStateRecorded = false

  const paramsFromContext = (retryContext: RetryContext) => {
    const betasParams = [...betas]

    // Append 1M beta from the latched experiment state (computed once before
    // the closure to avoid mid-retry GB flips changing the cache key).
    if (!betasParams.includes(CONTEXT_1M_BETA_HEADER) && sonnet1mExpLatched) {
      betasParams.push(CONTEXT_1M_BETA_HEADER)
    }

    // For Bedrock, include both model-based betas and dynamically-added tool search header
    const bedrockBetas =
      getAPIProvider() === 'bedrock'
        ? [
            ...getBedrockExtraBodyParamsBetas(retryContext.model),
            ...(toolSearchHeader ? [toolSearchHeader] : []),
          ]
        : []
    const extraBodyParams = getExtraBodyParams(bedrockBetas)

    const outputConfig: BetaOutputConfig = {
      ...((extraBodyParams.output_config as BetaOutputConfig) ?? {}),
    }

    configureEffortParams(
      effort,
      outputConfig,
      extraBodyParams,
      betasParams,
      options.model,
    )

    configureTaskBudgetParams(
      options.taskBudget,
      outputConfig as BetaOutputConfig & { task_budget?: TaskBudgetParam },
      betasParams,
    )

    // Merge outputFormat into extraBodyParams.output_config alongside effort
    // Requires structured-outputs beta header per SDK (see parse() in messages.mjs)
    if (options.outputFormat && !('format' in outputConfig)) {
      outputConfig.format = options.outputFormat as BetaJSONOutputFormat
      // Add beta header if not already present and provider supports it
      if (
        modelSupportsStructuredOutputs(options.model) &&
        !betasParams.includes(STRUCTURED_OUTPUTS_BETA_HEADER)
      ) {
        betasParams.push(STRUCTURED_OUTPUTS_BETA_HEADER)
      }
    }

    // Retry context gets preference because it tries to course correct if we exceed the context window limit
    const maxOutputTokens =
      retryContext?.maxTokensOverride ||
      options.maxOutputTokensOverride ||
      getMaxOutputTokensForModel(options.model)

    const hasThinking = shouldUseThinkingForModel(retryContext.model, thinkingConfig)
    let thinking: BetaMessageStreamParams['thinking'] | undefined = undefined

    // IMPORTANT: Do not change the adaptive-vs-budget thinking selection below
    // without notifying the model launch DRI and research. This is a sensitive
    // setting that can greatly affect model quality and bashing.
    if (hasThinking) {
      if (
        !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING) &&
        modelSupportsAdaptiveThinking(retryContext.model)
      ) {
        // For models that support adaptive thinking, always use adaptive
        // thinking without a budget.
        thinking = {
          type: 'adaptive',
        } satisfies BetaMessageStreamParams['thinking']
      } else {
        // For models that do not support adaptive thinking, use the default
        // thinking budget unless explicitly specified.
        let thinkingBudget = getMaxThinkingTokensForModel(retryContext.model)
        if (
          thinkingConfig.type === 'enabled' &&
          thinkingConfig.budgetTokens !== undefined
        ) {
          thinkingBudget = thinkingConfig.budgetTokens
        }
        thinkingBudget = Math.min(maxOutputTokens - 1, thinkingBudget)
        thinking = {
          budget_tokens: thinkingBudget,
          type: 'enabled',
        } satisfies BetaMessageStreamParams['thinking']
      }
    }

    // Get API context management strategies if enabled
    const contextManagement = getAPIContextManagement({
      hasThinking,
      isRedactThinkingActive: betasParams.includes(REDACT_THINKING_BETA_HEADER),
      clearAllThinking: thinkingClearLatched,
    })

    const enablePromptCaching =
      options.enablePromptCaching ?? getPromptCachingEnabled(retryContext.model)
    const attributionPolicy = resolveCurrentAnthropicAttributionPolicy({
      attributionEnabled,
      providerOverride: options.providerOverride,
    })
    const requestSystemPrompt = asSystemPrompt(
      applyAnthropicAttributionPolicy(
        [
          getAttributionHeader(fingerprint, attributionPolicy),
          ...systemPrompt,
        ].filter(Boolean),
        attributionPolicy,
      ),
    )
    const system = buildSystemPromptBlocks(
      requestSystemPrompt,
      enablePromptCaching,
      {
        skipGlobalCacheForSystemPrompt: needsToolBasedCacheMarker,
        querySource: options.querySource,
      },
    )
    if (!apiPrefixLogged) {
      apiPrefixLogged = true
      logAPIPrefix(requestSystemPrompt)
    }
    if (feature('PROMPT_CACHE_BREAK_DETECTION') && !promptStateRecorded) {
      promptStateRecorded = true
      // Exclude defer_loading tools from the hash. The API strips them from
      // the prompt, so they never affect the actual cache key.
      const toolsForCacheDetection = allTools.filter(
        t => !('defer_loading' in t && t.defer_loading),
      )
      recordPromptState({
        system,
        toolSchemas: toolsForCacheDetection,
        querySource: options.querySource,
        model: options.model,
        agentId: options.agentId,
        fastMode: fastModeHeaderLatched,
        globalCacheStrategy,
        betas,
        autoModeActive: afkHeaderLatched,
        isUsingOverage: currentLimits.isUsingOverage ?? false,
        cachedMCEnabled: cacheEditingHeaderLatched,
        effortValue: effort,
        extraBodyParams: getExtraBodyParams(),
      })
    }

    // Fast mode: header is latched session-stable (cache-safe), but
    // `speed='fast'` stays dynamic so cooldown still suppresses the actual
    // fast-mode request without changing the cache key.
    let speed: BetaMessageStreamParams['speed']
    const isFastModeForRetry =
      isFastModeEnabled() &&
      isFastModeAvailable() &&
      !isFastModeCooldown() &&
      isFastModeSupportedByModel(options.model) &&
      !!retryContext.fastMode
    if (isFastModeForRetry) {
      speed = 'fast'
    }
    if (fastModeHeaderLatched && !betasParams.includes(FAST_MODE_BETA_HEADER)) {
      betasParams.push(FAST_MODE_BETA_HEADER)
    }

    // AFK mode beta: latched once auto mode is first activated. Still gated
    // by isAgenticQuery per-call so classifiers/compaction don't get it.
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      if (
        afkHeaderLatched &&
        shouldIncludeFirstPartyOnlyBetas() &&
        isAgenticQuery &&
        !betasParams.includes(AFK_MODE_BETA_HEADER)
      ) {
        betasParams.push(AFK_MODE_BETA_HEADER)
      }
    }

    // Cache editing beta: header is latched session-stable; useCachedMC
    // (controls cache_edits body behavior) stays live so edits stop when
    // the feature disables but the header doesn't flip.
    const useCachedMC =
      cachedMCEnabled &&
      getAPIProvider() === 'firstParty' &&
      isFirstPartyAnthropicBaseUrl() &&
      options.querySource === 'repl_main_thread'
    if (
      cacheEditingHeaderLatched &&
      getAPIProvider() === 'firstParty' &&
      isFirstPartyAnthropicBaseUrl() &&
      options.querySource === 'repl_main_thread' &&
      !betasParams.includes(cacheEditingBetaHeader)
    ) {
      betasParams.push(cacheEditingBetaHeader)
      logForDebugging(
        'Cache editing beta header enabled for cached microcompact',
      )
    }

    // Only send temperature when thinking is disabled — the API requires
    // temperature: 1 when thinking is enabled, which is already the default.
    const temperature = !hasThinking
      ? (options.temperatureOverride ?? 1)
      : undefined

    lastRequestBetas = betasParams

    return {
      model: normalizeModelStringForAPI(providerRequestModel),
      // IMPORTANT: `system` must appear before `messages` in the object literal.
      // JSON.stringify preserves insertion order. The native Bun attestation
      // (Attestation.zig) overwrites the FIRST `cch=00000` sentinel in the
      // serialized body. If `messages` is serialized first and conversation
      // history contains this literal string, the wrong occurrence is replaced,
      // producing a different system prompt on each request and breaking cache.
      system,
      messages: addCacheBreakpoints(
        messagesForAPI,
        enablePromptCaching,
        options.querySource,
        useCachedMC,
        // The stub's CacheEditsBlock/PinnedCacheEdits type edits as unknown[];
        // the local types pin the delete-edit shape. The stub only ever
        // yields null/[] today.
        consumedCacheEdits as CachedMCEditsBlock | null,
        consumedPinnedEdits as CachedMCPinnedEdits[],
        options.skipCacheWrite,
      ),
      tools: allTools,
      tool_choice: options.toolChoice,
      ...(useBetas && { betas: betasParams }),
      metadata: getAPIMetadata(),
      max_tokens: maxOutputTokens,
      thinking,
      ...(temperature !== undefined && { temperature }),
      ...(contextManagement &&
        useBetas &&
        betasParams.includes(CONTEXT_MANAGEMENT_BETA_HEADER) && {
          context_management: contextManagement,
        }),
      ...extraBodyParams,
      ...(Object.keys(outputConfig).length > 0 && {
        output_config: outputConfig,
      }),
      ...(speed !== undefined && { speed }),
    }
  }

  const newMessages: AssistantMessage[] = []
  let ttftMs = 0
  let partialMessage: BetaMessage | undefined = undefined
  const contentBlocks: (BetaContentBlock | ConnectorTextBlock)[] = []
  let usage: NonNullableUsage = EMPTY_USAGE
  let costUSD = 0
  let stopReason: BetaStopReason | null = null
  let didFallBackToNonStreaming = false
  let fallbackMessage: AssistantMessage | undefined
  let maxOutputTokens = 0
  let responseHeaders: globalThis.Headers | undefined = undefined
  let research: unknown = undefined
  let isFastModeRequest = isFastMode // Keep separate state as it may change if falling back
  let isAdvisorInProgress = false
  let apiQueryLogged = false

  try {
    const apiProvider = getAPIProvider()
    if (usesAnthropicImageLimits({
      apiProvider,
      isFirstPartyBaseUrl: isFirstPartyAnthropicBaseUrl(),
      isGithubNativeAnthropic: isGithubNativeAnthropicMode(options.model),
      hasProviderOverride: Boolean(options.providerOverride),
    })) {
      messagesForAPI = await prepareImagesForAnthropicRequest(messagesForAPI, {
        // These partners count document blocks toward the many-image threshold.
        countDocuments: apiProvider === 'bedrock' || apiProvider === 'vertex',
      })
    }
    queryCheckpoint('query_client_creation_start')
    const generator = withRetry<Stream<BetaRawMessageStreamEvent> | null>(
      () =>
        getAnthropicClient({
          maxRetries: 0, // Disabled auto-retry in favor of manual implementation
          model: providerRequestModel,
          fetchOverride: options.fetchOverride,
          source: options.querySource,
          providerOverride: options.providerOverride,
          effortValue: effort,
        }),
      async (anthropic, attempt, context) => {
        attemptNumber = attempt
        isFastModeRequest = context.fastMode ?? false
        start = Date.now()
        attemptStartTimes.push(start)
        // Client has been created by withRetry's getClient() call. This fires
        // once per attempt; on retries the client is usually cached (withRetry
        // only calls getClient() again after auth errors), so the delta from
        // client_creation_start is meaningful on attempt 1.
        queryCheckpoint('query_client_creation_end')

        // Keep this immediately adjacent to the SDK call below. query.ts uses
        // it to atomically reserve a shared foreground/background turn only
        // after every asynchronous provider-preparation step has completed.
        if (options.onProviderRequestStart?.() === false) {
          return null
        }

        // Everything below is synchronous until the SDK request is created,
        // so ownership cannot change between this request build and dispatch.
        const params = paramsFromContext(context)
        captureAPIRequest(params, options.querySource) // Capture for bug reports
        maxOutputTokens = params.max_tokens

        if (!apiQueryLogged) {
          apiQueryLogged = true
          // Capture primitives only: the fire-and-forget permission lookup
          // must not retain the full request-building closure.
          const logMessagesLength = params.messages.length
          const logBetas = useBetas ? (params.betas ?? []) : []
          const logThinkingType = params.thinking?.type ?? 'disabled'
          const logEffortValue = params.output_config?.effort
          void options.getToolPermissionContext().then(permissionContext => {
            logAPIQuery({
              model: options.model,
              messagesLength: logMessagesLength,
              temperature: options.temperatureOverride ?? 1,
              betas: logBetas,
              permissionMode: permissionContext.mode,
              querySource: options.querySource,
              queryTracking: options.queryTracking,
              thinkingType: logThinkingType,
              effortValue: logEffortValue,
              fastMode: isFastMode,
              previousRequestId,
            })
          })
        }

        // Fire immediately before the fetch is dispatched. .withResponse() below
        // awaits until response headers arrive, so this MUST be before the await
        // or the "Network TTFB" phase measurement is wrong.
        queryCheckpoint('query_api_request_sent')
        if (!options.agentId) {
          headlessProfilerCheckpoint('api_request_sent')
        }

        // Generate and track client request ID so timeouts (which return no
        // server request ID) can still be correlated with server logs.
        // First-party only — 3P providers don't log it (inc-4029 class).
        clientRequestId =
          getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()
            ? randomUUID()
            : undefined
        const attemptApiCallKey = startActiveApiCall({
          clientRequestId,
          model: options.model,
          querySource: options.querySource,
          startedAt: start,
        })

        // Use raw stream instead of BetaMessageStream to avoid O(n²) partial JSON parsing
        // BetaMessageStream calls partialParse() on every input_json_delta, which we don't need
        // since we handle tool input accumulation ourselves
        // biome-ignore lint/plugin: main conversation loop handles attribution separately
        try {
          const result = await anthropic.beta.messages
            .create(
              { ...params, stream: true },
              {
                signal,
                ...(clientRequestId && {
                  headers: { [CLIENT_REQUEST_ID_HEADER]: clientRequestId },
                }),
              },
            )
            .withResponse()
          queryCheckpoint('query_response_headers_received')
          streamRequestId = result.request_id
          if (attemptApiCallKey) {
            options.queryLifecycle?.updateApiCall(attemptApiCallKey, {
              requestId: streamRequestId,
            })
          }
          streamResponse = result.response
          return result.data
        } catch (err) {
          endActiveApiCall(attemptApiCallKey)
          throw err
        }
      },
      {
        model: options.model,
        fallbackModel: options.fallbackModel,
        thinkingConfig,
        ...(isFastModeEnabled() ? { fastMode: isFastMode } : false),
        signal,
        querySource: options.querySource,
      },
    )

    let e
    do {
      e = await generator.next()

      // yield API error messages (the stream has a 'controller' property, error messages don't)
      if (!e.done && !('controller' in e.value)) {
        yield e.value
      }
    } while (!e.done)
    if (e.value === null) return
    stream = e.value as Stream<BetaRawMessageStreamEvent>

    // reset state
    newMessages.length = 0
    ttftMs = 0
    partialMessage = undefined
    contentBlocks.length = 0
    usage = EMPTY_USAGE
    stopReason = null
    isAdvisorInProgress = false

    // Streaming idle timeout watchdog: abort the stream if no chunks arrive
    // for STREAM_IDLE_TIMEOUT_MS. Unlike the stall detection below (which only
    // fires when the *next* chunk arrives), this uses setTimeout to actively
    // kill hung streams. Without this, a silently dropped connection can hang
    // the session indefinitely since the SDK's request timeout only covers the
    // initial fetch(), not the streaming body.
    // Enabled by default, matching the always-on idle timeout already used by
    // the OpenAI/Codex shims. A silently dropped Anthropic
    // stream now aborts and falls back to a non-streaming retry within
    // STREAM_IDLE_TIMEOUT_MS, instead of hanging until QueryGuard's 5-minute
    // idle timeout. Opt out with CLAUDE_DISABLE_STREAM_WATCHDOG=1 (or by
    // explicitly setting CLAUDE_ENABLE_STREAM_WATCHDOG to a falsy value).
    const streamWatchdogEnabled =
      !isEnvTruthy(process.env.CLAUDE_DISABLE_STREAM_WATCHDOG) &&
      !isEnvDefinedFalsy(process.env.CLAUDE_ENABLE_STREAM_WATCHDOG)
    const STREAM_IDLE_TIMEOUT_MS = getStreamIdleTimeoutMs()
    const STREAM_IDLE_WARNING_MS = STREAM_IDLE_TIMEOUT_MS / 2
    let streamIdleAborted = false
    let streamSettlementCausalEventId: string | undefined
    // performance.now() snapshot when watchdog fires, for measuring abort propagation delay
    let streamWatchdogFiredAt: number | null = null
    let streamIdleWarningTimer: ReturnType<typeof setTimeout> | null = null
    let streamIdleTimer: ReturnType<typeof setTimeout> | null = null

    function clearStreamIdleTimers(): void {
      if (streamIdleWarningTimer !== null) {
        clearTimeout(streamIdleWarningTimer)
        streamIdleWarningTimer = null
      }
      if (streamIdleTimer !== null) {
        clearTimeout(streamIdleTimer)
        streamIdleTimer = null
      }
    }

    function logStreamIdleWarning(warnMs: number): void {
      logForDebugging(
        `Streaming idle warning: no chunks received for ${warnMs / 1000}s`,
        { level: 'warn' },
      )
      logForDiagnosticsNoPII('warn', 'cli_streaming_idle_warning')
      traceInterruptionEvent('claude_stream.idle_warning', {
        subsystem: 'claude_stream',
        transport: 'anthropic_messages',
        model: options.model,
        sinceLastYieldMs: warnMs,
      })
    }

    function closeStreamIterator(
      iterator: AsyncIterator<BetaRawMessageStreamEvent>,
      reason: Error,
      source: 'claude_stream_watchdog' | 'claude_stream_parent',
      causalEventId?: string,
    ): void {
      const activeStream = stream
      try {
        if (activeStream?.controller) {
          requestAbort(activeStream.controller, reason, {
            source,
            causalEventId,
            subsystem: 'claude_stream',
            transport: 'anthropic_messages',
            model: options.model,
            controllerRole: 'provider-stream',
          })
        }
      } catch {
        // Ignore - the stream may already be closed by the SDK.
      }
      releaseStreamResources()

      try {
        const returned = iterator.return?.()
        if (returned) {
          void Promise.resolve(returned).catch(() => {})
        }
      } catch {
        // Ignore - iterator.return() is best-effort cleanup.
      }
    }

    function abortTimedOutStream(
      iterator: AsyncIterator<BetaRawMessageStreamEvent>,
      timeoutError: StreamIdleTimeoutError,
    ): void {
      streamIdleAborted = true
      streamWatchdogFiredAt = performance.now()
      logForDebugging(
        `Streaming idle timeout: no chunks received for ${STREAM_IDLE_TIMEOUT_MS / 1000}s, aborting stream`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'cli_streaming_idle_timeout')
      const causalEventId = traceInterruptionEvent('claude_stream.idle_timeout', {
        subsystem: 'claude_stream',
        transport: 'anthropic_messages',
        model: options.model,
        sinceLastYieldMs: STREAM_IDLE_TIMEOUT_MS,
      })
      streamSettlementCausalEventId = causalEventId
      flushInterruptionTrace('claude_stream_idle_timeout')
      logEvent('tengu_streaming_idle_timeout', {
        model:
          options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        request_id: (streamRequestId ??
          'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        timeout_ms: STREAM_IDLE_TIMEOUT_MS,
      })

      closeStreamIterator(
        iterator,
        timeoutError,
        'claude_stream_watchdog',
        causalEventId,
      )
    }

    function readNextStreamPart(
      iterator: AsyncIterator<BetaRawMessageStreamEvent>,
    ): Promise<IteratorResult<BetaRawMessageStreamEvent>> {
      if (signal.aborted) {
        const abortError = new APIUserAbortError()
        streamSettlementCausalEventId =
          getInterruptionSignalAbortEventId(signal)
        closeStreamIterator(
          iterator,
          abortError,
          'claude_stream_parent',
          getInterruptionSignalAbortEventId(signal),
        )
        return Promise.reject(abortError)
      }

      return new Promise((resolve, reject) => {
        let settled = false
        const cleanup = () => {
          clearStreamIdleTimers()
          signal.removeEventListener('abort', onAbort)
        }
        const settleResolve = (
          result: IteratorResult<BetaRawMessageStreamEvent>,
        ) => {
          if (settled) return
          settled = true
          cleanup()
          resolve(result)
        }
        const settleReject = (error: unknown) => {
          if (settled) return
          settled = true
          cleanup()
          reject(error)
        }
        const onAbort = () => {
          const abortError = new APIUserAbortError()
          const parentCausalEventId = getInterruptionSignalAbortEventId(signal)
          const causalEventId = traceInterruptionEvent('claude_stream.parent_abort', {
            subsystem: 'claude_stream',
            transport: 'anthropic_messages',
            model: options.model,
            reason: signal.reason,
            causalEventId: parentCausalEventId,
          })
          streamSettlementCausalEventId =
            causalEventId ?? parentCausalEventId
          closeStreamIterator(
            iterator,
            abortError,
            'claude_stream_parent',
            causalEventId ?? parentCausalEventId,
          )
          settleReject(abortError)
        }

        signal.addEventListener('abort', onAbort, { once: true })

        clearStreamIdleTimers()
        if (streamWatchdogEnabled) {
          streamIdleWarningTimer = setTimeout(
            warnMs => {
              logStreamIdleWarning(warnMs)
            },
            STREAM_IDLE_WARNING_MS,
            STREAM_IDLE_WARNING_MS,
          )
          streamIdleTimer = setTimeout(() => {
            const timeoutError = new StreamIdleTimeoutError(
              STREAM_IDLE_TIMEOUT_MS,
            )
            abortTimedOutStream(iterator, timeoutError)
            settleReject(timeoutError)
          }, STREAM_IDLE_TIMEOUT_MS)
        }

        let nextPromise: Promise<IteratorResult<BetaRawMessageStreamEvent>>
        try {
          nextPromise = Promise.resolve(iterator.next())
        } catch (error) {
          settleReject(signal.aborted ? new APIUserAbortError() : error)
          return
        }

        nextPromise.then(
          result => settleResolve(result),
          error => settleReject(signal.aborted ? new APIUserAbortError() : error),
        )
      })
    }

    startSessionActivity('api_call')
    try {
      // stream in and accumulate state
      let isFirstChunk = true
      let lastEventTime: number | null = null // Set after first chunk to avoid measuring TTFB as a stall
      const STALL_THRESHOLD_MS = 30_000 // 30 seconds
      let totalStallTime = 0
      let stallCount = 0

      const streamIterator = stream[Symbol.asyncIterator]()
      while (true) {
        const streamResult = await readNextStreamPart(streamIterator)
        if (streamResult.done) {
          break
        }
        const part = streamResult.value
        const now = Date.now()

        // Detect and log streaming stalls (only after first event to avoid counting TTFB)
        if (lastEventTime !== null) {
          const timeSinceLastEvent = now - lastEventTime
          if (timeSinceLastEvent > STALL_THRESHOLD_MS) {
            stallCount++
            totalStallTime += timeSinceLastEvent
            logForDebugging(
              `Streaming stall detected: ${(timeSinceLastEvent / 1000).toFixed(1)}s gap between events (stall #${stallCount})`,
              { level: 'warn' },
            )
            logEvent('tengu_streaming_stall', {
              stall_duration_ms: timeSinceLastEvent,
              stall_count: stallCount,
              total_stall_time_ms: totalStallTime,
              event_type:
                part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              model:
                options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              request_id: (streamRequestId ??
                'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
          }
        }
        lastEventTime = now

        if (isFirstChunk) {
          logForDebugging('Stream started - received first chunk')
          queryCheckpoint('query_first_chunk_received')
          if (!options.agentId) {
            headlessProfilerCheckpoint('first_chunk')
          }
          endQueryProfile()
          isFirstChunk = false
        }

        switch (part.type) {
          case 'message_start': {
            partialMessage = part.message
            ttftMs = Date.now() - start
            usage = updateUsage(usage, part.message?.usage)
            // Capture research from message_start if available (internal only).
            // Always overwrite with the latest value.
            if (
              process.env.USER_TYPE === 'ant' &&
              'research' in (part.message as unknown as Record<string, unknown>)
            ) {
              research = (part.message as unknown as Record<string, unknown>)
                .research
            }
            break
          }
          case 'content_block_start':
            switch (part.content_block.type) {
              case 'tool_use':
                contentBlocks[part.index] = {
                  ...part.content_block,
                  input: '',
                }
                break
              case 'server_tool_use':
                contentBlocks[part.index] = {
                  ...part.content_block,
                  input: '' as unknown as { [key: string]: unknown },
                }
                if ((part.content_block.name as string) === 'advisor') {
                  isAdvisorInProgress = true
                  logForDebugging(`[AdvisorTool] Advisor tool called`)
                  logEvent('tengu_advisor_tool_call', {
                    model:
                      options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    advisor_model: (advisorModel ??
                      'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  })
                }
                break
              case 'text':
                contentBlocks[part.index] = {
                  ...part.content_block,
                  // awkwardly, the sdk sometimes returns text as part of a
                  // content_block_start message, then returns the same text
                  // again in a content_block_delta message. we ignore it here
                  // since there doesn't seem to be a way to detect when a
                  // content_block_delta message duplicates the text.
                  text: '',
                }
                break
              case 'thinking':
                contentBlocks[part.index] = {
                  ...part.content_block,
                  // also awkward
                  thinking: '',
                  // initialize signature to ensure field exists even if signature_delta never arrives
                  signature: '',
                }
                break
              default:
                // even more awkwardly, the sdk mutates the contents of text blocks
                // as it works. we want the blocks to be immutable, so that we can
                // accumulate state ourselves.
                contentBlocks[part.index] = { ...part.content_block }
                if (
                  (part.content_block.type as string) === 'advisor_tool_result'
                ) {
                  isAdvisorInProgress = false
                  logForDebugging(`[AdvisorTool] Advisor tool result received`)
                }
                break
            }
            break
          case 'content_block_delta': {
            const contentBlock = contentBlocks[part.index]
            const delta = part.delta as typeof part.delta | ConnectorTextDelta
            if (!contentBlock) {
              logEvent('tengu_streaming_error', {
                error_type:
                  'content_block_not_found_delta' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_type:
                  part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_index: part.index,
              })
              throw new RangeError('Content block not found')
            }
            if (
              feature('CONNECTOR_TEXT') &&
              delta.type === 'connector_text_delta'
            ) {
              if (contentBlock.type !== 'connector_text') {
                logEvent('tengu_streaming_error', {
                  error_type:
                    'content_block_type_mismatch_connector_text' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  expected_type:
                    'connector_text' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  actual_type:
                    contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                })
                throw new Error('Content block is not a connector_text block')
              }
              contentBlock.connector_text += delta.connector_text
            } else {
              switch (delta.type) {
                case 'citations_delta':
                  // TODO: handle citations
                  break
                case 'input_json_delta':
                  if (
                    contentBlock.type !== 'tool_use' &&
                    contentBlock.type !== 'server_tool_use'
                  ) {
                    logEvent('tengu_streaming_error', {
                      error_type:
                        'content_block_type_mismatch_input_json' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      expected_type:
                        'tool_use' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      actual_type:
                        contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block is not a input_json block')
                  }
                  if (typeof contentBlock.input !== 'string') {
                    logEvent('tengu_streaming_error', {
                      error_type:
                        'content_block_input_not_string' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      input_type:
                        typeof contentBlock.input as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block input is not a string')
                  }
                  contentBlock.input += delta.partial_json
                  break
                case 'text_delta':
                  if (contentBlock.type !== 'text') {
                    logEvent('tengu_streaming_error', {
                      error_type:
                        'content_block_type_mismatch_text' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      expected_type:
                        'text' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      actual_type:
                        contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block is not a text block')
                  }
                  contentBlock.text += delta.text
                  break
                case 'signature_delta':
                  if (
                    feature('CONNECTOR_TEXT') &&
                    contentBlock.type === 'connector_text'
                  ) {
                    contentBlock.signature = delta.signature
                    break
                  }
                  if (contentBlock.type !== 'thinking') {
                    logEvent('tengu_streaming_error', {
                      error_type:
                        'content_block_type_mismatch_thinking_signature' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      expected_type:
                        'thinking' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      actual_type:
                        contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block is not a thinking block')
                  }
                  contentBlock.signature = delta.signature
                  break
                case 'thinking_delta':
                  if (contentBlock.type !== 'thinking') {
                    logEvent('tengu_streaming_error', {
                      error_type:
                        'content_block_type_mismatch_thinking_delta' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      expected_type:
                        'thinking' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      actual_type:
                        contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block is not a thinking block')
                  }
                  contentBlock.thinking += delta.thinking
                  break
              }
            }
            // Capture research from content_block_delta if available (internal only).
            // Always overwrite with the latest value.
            if (process.env.USER_TYPE === 'ant' && 'research' in part) {
              research = (part as { research: unknown }).research
            }
            break
          }
          case 'content_block_stop': {
            const contentBlock = contentBlocks[part.index]
            if (!contentBlock) {
              logEvent('tengu_streaming_error', {
                error_type:
                  'content_block_not_found_stop' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_type:
                  part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_index: part.index,
              })
              throw new RangeError('Content block not found')
            }
            if (!partialMessage) {
              logEvent('tengu_streaming_error', {
                error_type:
                  'partial_message_not_found' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_type:
                  part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              })
              throw new Error('Message not found')
            }
            const m: AssistantMessage = {
              message: {
                ...partialMessage,
                content: normalizeContentFromAPI(
                  [contentBlock] as BetaContentBlock[],
                  tools,
                  options.agentId,
                ),
              },
              requestId: streamRequestId ?? undefined,
              type: 'assistant',
              uuid: randomUUID(),
              timestamp: new Date().toISOString(),
              ...(process.env.USER_TYPE === 'ant' &&
                research !== undefined && { research }),
              ...(advisorModel && { advisorModel }),
            }
            newMessages.push(m)
            yield m
            break
          }
          case 'message_delta': {
            usage = updateUsage(usage, part.usage)
            // Capture research from message_delta if available (internal only).
            // Always overwrite with the latest value. Also write back to
            // already-yielded messages since message_delta arrives after
            // content_block_stop.
            if (
              process.env.USER_TYPE === 'ant' &&
              'research' in (part as unknown as Record<string, unknown>)
            ) {
              research = (part as unknown as Record<string, unknown>).research
              for (const msg of newMessages) {
                msg.research = research
              }
            }

            // Write final usage and stop_reason back to the last yielded
            // message. Messages are created at content_block_stop from
            // partialMessage, which was set at message_start before any tokens
            // were generated (output_tokens: 0, stop_reason: null).
            // message_delta arrives after content_block_stop with the real
            // values.
            //
            // IMPORTANT: Use direct property mutation, not object replacement.
            // The transcript write queue holds a reference to message.message
            // and serializes it lazily (100ms flush interval). Object
            // replacement ({ ...lastMsg.message, usage }) would disconnect
            // the queued reference; direct mutation ensures the transcript
            // captures the final values.
            stopReason = part.delta.stop_reason

            const lastMsg = newMessages.at(-1)
            if (lastMsg) {
              lastMsg.message.usage = usage
              lastMsg.message.stop_reason = stopReason
            }

            // Update cost
            const costUSDForPart = calculateUSDCost(resolvedModel, usage)
            costUSD += addToTotalSessionCost(
              costUSDForPart,
              usage,
              options.model,
            )

            const refusalMessage = getErrorMessageIfRefusal(
              part.delta.stop_reason,
              options.model,
            )
            if (refusalMessage) {
              yield refusalMessage
            }

            if (stopReason === 'max_tokens') {
              logEvent('tengu_max_tokens_reached', {
                max_tokens: maxOutputTokens,
              })
              const is3pProvider = shouldUseIntegrationRuntimeLimits()
              const providerNoun = is3pProvider ? "Model's" : "OpenClaude's"
              yield createAssistantAPIErrorMessage({
                content: `${API_ERROR_MESSAGE_PREFIX}: ${providerNoun} response exceeded the ${
                  maxOutputTokens
                } output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.`,
                apiError: 'max_output_tokens',
                error: 'max_output_tokens',
              })
            }

            if (stopReason === 'model_context_window_exceeded') {
              logEvent('tengu_context_window_exceeded', {
                max_tokens: maxOutputTokens,
                output_tokens: usage.output_tokens,
              })
              yield createAssistantAPIErrorMessage({
                content: `${API_ERROR_MESSAGE_PREFIX}: The model has reached its context window limit.`,
                apiError: 'context_overflow',
                error: 'invalid_request',
              })
            }
            break
          }
          case 'message_stop':
            break
        }

        yield {
          type: 'stream_event',
          event: part,
          ...(part.type === 'message_start' ? { ttftMs } : undefined),
        }
      }
      // Clear the idle timeout watchdog now that the stream loop has exited
      clearStreamIdleTimers()

      // If the stream was aborted by our idle timeout watchdog, fall back to
      // non-streaming retry rather than treating it as a completed stream.
      if (streamIdleAborted) {
        // Instrumentation: proves the for-await exited after the watchdog fired
        // (vs. hung forever). exit_delay_ms measures abort propagation latency:
        // 0-10ms = abort worked; >>1000ms = something else woke the loop.
        const exitDelayMs =
          streamWatchdogFiredAt !== null
            ? Math.round(performance.now() - streamWatchdogFiredAt)
            : -1
        traceInterruptionEvent('claude_stream.loop_settled', {
          subsystem: 'claude_stream',
          transport: 'anthropic_messages',
          model: options.model,
          outcome: 'clean',
          causalEventId: streamSettlementCausalEventId,
          sinceLastYieldMs: exitDelayMs,
        })
        logForDiagnosticsNoPII(
          'info',
          'cli_stream_loop_exited_after_watchdog_clean',
        )
        logEvent('tengu_stream_loop_exited_after_watchdog', {
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          exit_delay_ms: exitDelayMs,
          exit_path:
            'clean' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        // Prevent double-emit: this throw lands in the catch block below,
        // whose exit_path='error' probe guards on streamWatchdogFiredAt.
        streamWatchdogFiredAt = null
        throw new Error('Stream idle timeout - no chunks received')
      }

      // Detect when the stream completed without producing any assistant messages.
      // This covers two proxy failure modes:
      // 1. No events at all (!partialMessage): proxy returned 200 with non-SSE body
      // 2. Partial events (partialMessage set but no content blocks completed AND
      //    no stop_reason received): proxy returned message_start but stream ended
      //    before content_block_stop and before message_delta with stop_reason
      // BetaMessageStream had the first check in _endRequest() but the raw Stream
      // does not - without it the generator silently returns no assistant messages,
      // causing "Execution error" in -p mode.
      // Note: We must check stopReason to avoid false positives. For example, with
      // structured output (--json-schema), the model calls a StructuredOutput tool
      // on turn 1, then on turn 2 responds with end_turn and no content blocks.
      // That's a legitimate empty response, not an incomplete stream.
      if (!partialMessage || (newMessages.length === 0 && !stopReason)) {
        logForDebugging(
          !partialMessage
            ? 'Stream completed without receiving message_start event - triggering non-streaming fallback'
            : 'Stream completed with message_start but no content blocks completed - triggering non-streaming fallback',
          { level: 'error' },
        )
        logEvent('tengu_stream_no_events', {
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw new Error('Stream ended without receiving any events')
      }

      // Log summary if any stalls occurred during streaming
      if (stallCount > 0) {
        logForDebugging(
          `Streaming completed with ${stallCount} stall(s), total stall time: ${(totalStallTime / 1000).toFixed(1)}s`,
          { level: 'warn' },
        )
        logEvent('tengu_streaming_stall_summary', {
          stall_count: stallCount,
          total_stall_time_ms: totalStallTime,
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
      }

      // Check if the cache actually broke based on response tokens
      if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
        void checkResponseForCacheBreak(
          options.querySource,
          usage.cache_read_input_tokens,
          usage.cache_creation_input_tokens,
          messages,
          options.agentId,
          streamRequestId,
        )
      }

      // Process fallback percentage header and quota status if available
      // streamResponse is set when the stream is created in the withRetry callback above
      // TypeScript's control flow analysis can't track that streamResponse is set in the callback
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const resp = streamResponse as unknown as Response | undefined
      if (resp) {
        extractQuotaStatusFromHeaders(resp.headers)
        // Store headers for gateway detection
        responseHeaders = resp.headers
      }
    } catch (streamingError) {
      // Clear the idle timeout watchdog on error path too
      clearStreamIdleTimers()
      streamSettlementCausalEventId =
        getInterruptionErrorCausalEventId(streamingError) ??
        streamSettlementCausalEventId
      traceInterruptionEvent('claude_stream.error', {
        subsystem: 'claude_stream',
        transport: 'anthropic_messages',
        model: options.model,
        outcome: signal.aborted ? 'root_aborted' : 'external_error',
        reason: signal.reason,
        causalEventId:
          getInterruptionSignalAbortEventId(signal) ??
          streamSettlementCausalEventId,
        error: streamingError,
      })

      // Instrumentation: if the watchdog had already fired and the for-await
      // threw (rather than exiting cleanly), record that the loop DID exit and
      // how long after the watchdog. Distinguishes true hangs from error exits.
      if (streamIdleAborted && streamWatchdogFiredAt !== null) {
        const exitDelayMs = Math.round(
          performance.now() - streamWatchdogFiredAt,
        )
        traceInterruptionEvent('claude_stream.loop_settled', {
          subsystem: 'claude_stream',
          transport: 'anthropic_messages',
          model: options.model,
          outcome: 'error',
          causalEventId: streamSettlementCausalEventId,
          error: streamingError,
          sinceLastYieldMs: exitDelayMs,
        })
        logForDiagnosticsNoPII(
          'info',
          'cli_stream_loop_exited_after_watchdog_error',
        )
        logEvent('tengu_stream_loop_exited_after_watchdog', {
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          exit_delay_ms: exitDelayMs,
          exit_path:
            'error' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          error_name:
            streamingError instanceof Error
              ? (streamingError.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
              : ('unknown' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
      }

      if (streamingError instanceof APIUserAbortError) {
        // If the signal is aborted, classify by the AbortSignal reason.
        // If not, it's likely a timeout from the SDK
        if (signal.aborted) {
          logForDebugging(
            getClaudeStreamingAbortLogMessage(signal, streamingError),
          )
          if (
            isAdvisorInProgress &&
            shouldCreateUserInterruptionMessage(signal.reason)
          ) {
            logEvent('tengu_advisor_tool_interrupted', {
              model:
                options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              advisor_model: (advisorModel ??
                'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
          }
          throw streamingError
        } else {
          // The SDK threw APIUserAbortError but our signal wasn't aborted
          // This means it's a timeout from the SDK's internal timeout
          logForDebugging(
            `Streaming timeout (SDK abort): ${streamingError.message}`,
            { level: 'error' },
          )
          // Treat provider/SDK stream timeouts like other streaming failures:
          // fall back below while the parent query signal is still live.
        }
      }

      if (signal.aborted) {
        logForDebugging(
          getClaudeStreamingAbortLogMessage(signal, streamingError),
        )
        throw new APIUserAbortError()
      }

      // When the flag is enabled, skip the non-streaming fallback and let the
      // error propagate to withRetry. The mid-stream fallback causes double tool
      // execution when streaming tool execution is active: the partial stream
      // starts a tool, then the non-streaming retry produces the same tool_use
      // and runs it again. See inc-4258.
      const disableFallback =
        isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK) ||
        getFeatureValue_CACHED_MAY_BE_STALE(
          'tengu_disable_streaming_to_non_streaming_fallback',
          false,
        )

      if (disableFallback) {
        logForDebugging(
          `Error streaming (non-streaming fallback disabled): ${errorMessage(streamingError)}`,
          { level: 'error' },
        )
        logEvent('tengu_streaming_fallback_to_non_streaming', {
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          error:
            streamingError instanceof Error
              ? (streamingError.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
              : (String(
                  streamingError,
                ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
          attemptNumber,
          maxOutputTokens,
          thinkingType:
            thinkingConfig.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          fallback_disabled: true,
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          fallback_cause: (streamIdleAborted
            ? 'watchdog'
            : 'other') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw streamingError
      }

      logForDebugging(
        `Error streaming, falling back to non-streaming mode: ${errorMessage(streamingError)}`,
        { level: 'error' },
      )
      didFallBackToNonStreaming = true
      if (options.onStreamingFallback) {
        options.onStreamingFallback()
      }

      logEvent('tengu_streaming_fallback_to_non_streaming', {
        model:
          options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        error:
          streamingError instanceof Error
            ? (streamingError.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
            : (String(
                streamingError,
              ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
        attemptNumber,
        maxOutputTokens,
        thinkingType:
          thinkingConfig.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback_disabled: false,
        request_id: (streamRequestId ??
          'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback_cause: (streamIdleAborted
          ? 'watchdog'
          : 'other') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      // Fall back to non-streaming mode with retries.
      // If the streaming failure was itself a 529, count it toward the
      // consecutive-529 budget so total 529s-before-model-fallback is the
      // same whether the overload was hit in streaming or non-streaming mode.
      // This is a speculative fix for https://github.com/anthropics/claude-code/issues/1513
      // Instrumentation: proves executeNonStreamingRequest was entered (vs. the
      // fallback event firing but the call itself hanging at dispatch).
      logForDiagnosticsNoPII('info', 'cli_nonstreaming_fallback_started')
      const fallbackStartedEventId = traceInterruptionEvent(
        'claude_stream.fallback_started', {
        subsystem: 'claude_stream',
        transport: 'anthropic_messages',
        model: options.model,
        trigger: streamIdleAborted ? 'watchdog' : 'other',
        causalEventId: streamSettlementCausalEventId,
        },
      )
      flushInterruptionTrace('claude_stream_fallback_started')
      logEvent('tengu_nonstreaming_fallback_started', {
        request_id: (streamRequestId ??
          'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        model:
          options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback_cause: (streamIdleAborted
          ? 'watchdog'
          : 'other') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      endActiveApiCall()
      let result: BetaMessage | null
      let fallbackResultMessage: AssistantMessage | undefined
      try {
        result = yield* executeNonStreamingRequest(
          { model: providerRequestModel, source: options.querySource, providerOverride: options.providerOverride, effortValue: effort },
          {
            model: providerRequestModel,
            fallbackModel: options.fallbackModel,
            thinkingConfig,
            ...(isFastModeEnabled() && { fastMode: isFastMode }),
            signal,
            initialConsecutive529Errors: is529Error(streamingError) ? 1 : 0,
            querySource: options.querySource,
          },
          paramsFromContext,
          (attempt, _startTime, tokens) => {
            attemptNumber = attempt
            maxOutputTokens = tokens
          },
          params => captureAPIRequest(params, options.querySource),
          streamRequestId,
          options.queryLifecycle,
          options.onProviderRequestStart,
        )

        if (result === null) {
          traceFallbackSettlement('superseded', fallbackStartedEventId)
          return
        }

        fallbackResultMessage = {
          message: {
            ...result,
            content: normalizeContentFromAPI(
              result.content,
              tools,
              options.agentId,
            ),
          },
          requestId: streamRequestId ?? undefined,
          type: 'assistant',
          uuid: randomUUID(),
          timestamp: new Date().toISOString(),
          ...(process.env.USER_TYPE === 'ant' &&
            research !== undefined && {
              research,
            }),
          ...(advisorModel && {
            advisorModel,
          }),
        }
        newMessages.push(fallbackResultMessage)
        fallbackMessage = fallbackResultMessage
      } catch (error) {
        traceFallbackSettlement(
          signal.aborted ? 'aborted' : 'failed',
          fallbackStartedEventId,
          error,
        )
        throw error
      }
      traceFallbackSettlement('completed', fallbackStartedEventId)
      yield fallbackResultMessage
    } finally {
      clearStreamIdleTimers()
    }
  } catch (errorFromRetry) {
    // FallbackTriggeredError must propagate to query.ts, which performs the
    // actual model switch. Swallowing it here would turn the fallback into a
    // no-op — the user would just see "Model fallback triggered: X -> Y" as
    // an error message with no actual retry on the fallback model.
    if (errorFromRetry instanceof FallbackTriggeredError) {
      throw errorFromRetry
    }

    if (
      handleClaudeExpectedSideTaskApiAbort(
        signal,
        errorFromRetry,
        releaseStreamResources,
      )
    ) {
      return
    }

    if (signal.aborted) {
      releaseStreamResources()
      return
    }

    // Check if this is a 404 error during stream creation that should trigger
    // non-streaming fallback. This handles gateways that return 404 for streaming
    // endpoints but work fine with non-streaming. Before v2.1.8, BetaMessageStream
    // threw 404s during iteration (caught by inner catch with fallback), but now
    // with raw streams, 404s are thrown during creation (caught here).
    const is404StreamCreationError =
      !didFallBackToNonStreaming &&
      errorFromRetry instanceof CannotRetryError &&
      errorFromRetry.originalError instanceof APIError &&
      errorFromRetry.originalError.status === 404

    if (is404StreamCreationError) {
      const streamCreationErrorEventId = traceInterruptionEvent(
        'claude_stream.error',
        {
          subsystem: 'claude_stream',
          phase: 'stream_creation',
          transport: 'anthropic_messages',
          model: options.model,
          error: errorFromRetry,
        },
      )
      // 404 is thrown at .withResponse() before streamRequestId is assigned,
      // and CannotRetryError means every retry failed — so grab the failed
      // request's ID from the error header instead.
      const failedRequestId =
        (errorFromRetry.originalError as APIError).requestID ?? 'unknown'
      logForDebugging(
        'Streaming endpoint returned 404, falling back to non-streaming mode',
        { level: 'warn' },
      )
      didFallBackToNonStreaming = true
      if (options.onStreamingFallback) {
        options.onStreamingFallback()
      }

      logEvent('tengu_streaming_fallback_to_non_streaming', {
        model:
          options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        error:
          '404_stream_creation' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        attemptNumber,
        maxOutputTokens,
        thinkingType:
          thinkingConfig.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        request_id:
          failedRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback_cause:
          '404_stream_creation' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      const fallbackStartedEventId = traceInterruptionEvent(
        'claude_stream.fallback_started',
        {
          subsystem: 'claude_stream',
          transport: 'anthropic_messages',
          model: options.model,
          trigger: '404_stream_creation',
          causalEventId: streamCreationErrorEventId,
        },
      )
      flushInterruptionTrace('claude_stream_fallback_started')

      try {
        // Fall back to non-streaming mode
        endActiveApiCall()
        const result = yield* executeNonStreamingRequest(
          {
            model: providerRequestModel,
            source: options.querySource,
            providerOverride: options.providerOverride,
            effortValue: effort,
          },
          {
            model: providerRequestModel,
            fallbackModel: options.fallbackModel,
            thinkingConfig,
            ...(isFastModeEnabled() && { fastMode: isFastMode }),
            signal,
            querySource: options.querySource,
          },
          paramsFromContext,
          (attempt, _startTime, tokens) => {
            attemptNumber = attempt
            maxOutputTokens = tokens
          },
          params => captureAPIRequest(params, options.querySource),
          failedRequestId,
          options.queryLifecycle,
          options.onProviderRequestStart,
        )

        if (result === null) {
          traceFallbackSettlement('superseded', fallbackStartedEventId)
          return
        }

        const m: AssistantMessage = {
          message: {
            ...result,
            content: normalizeContentFromAPI(
              result.content,
              tools,
              options.agentId,
            ),
          },
          requestId: streamRequestId ?? undefined,
          type: 'assistant',
          uuid: randomUUID(),
          timestamp: new Date().toISOString(),
          ...(process.env.USER_TYPE === 'ant' &&
            research !== undefined && { research }),
          ...(advisorModel && { advisorModel }),
        }
        newMessages.push(m)
        fallbackMessage = m
        traceFallbackSettlement('completed', fallbackStartedEventId)
        yield m

        // Continue to success logging below
      } catch (fallbackError) {
        traceFallbackSettlement(
          signal.aborted ? 'aborted' : 'failed',
          fallbackStartedEventId,
          fallbackError,
        )
        // Propagate model-fallback signal to query.ts (see comment above).
        if (fallbackError instanceof FallbackTriggeredError) {
          throw fallbackError
        }

        if (
          handleClaudeExpectedSideTaskApiAbort(
            signal,
            fallbackError,
            releaseStreamResources,
          )
        ) {
          return
        }

        // Fallback also failed, handle as normal error
        logForDebugging(
          `Non-streaming fallback also failed: ${errorMessage(fallbackError)}`,
          { level: 'error' },
        )

        let error = fallbackError
        let errorModel = options.model
        if (fallbackError instanceof CannotRetryError) {
          error = fallbackError.originalError
          errorModel = fallbackError.retryContext.model
        }

        if (error instanceof APIError) {
          extractQuotaStatusFromError(error)
        }

        const requestId =
          streamRequestId ||
          (error instanceof APIError ? error.requestID : undefined) ||
          (error instanceof APIError
            ? (error.error as { request_id?: string })?.request_id
            : undefined)

        logAPIError({
          error,
          model: errorModel,
          messageCount: messagesForAPI.length,
          messageTokens: tokenCountFromLastAPIResponse(messagesForAPI),
          durationMs: Date.now() - start,
          durationMsIncludingRetries: Date.now() - startIncludingRetries,
          attempt: attemptNumber,
          requestId,
          clientRequestId,
          didFallBackToNonStreaming,
          queryTracking: options.queryTracking,
          querySource: options.querySource,
          fastMode: isFastModeRequest,
          previousRequestId,
        })

        if (error instanceof APIUserAbortError) {
          releaseStreamResources()
          return
        }

        yield getAssistantMessageFromError(error, errorModel, {
          messages,
          messagesForAPI,
        })
        releaseStreamResources()
        return
      }
    } else {
      // Original error handling for non-404 errors
      logForDebugging(`Error in API request: ${errorMessage(errorFromRetry)}`, {
        level: 'error',
      })

      let error = errorFromRetry
      let errorModel = options.model
      if (errorFromRetry instanceof CannotRetryError) {
        error = errorFromRetry.originalError
        errorModel = errorFromRetry.retryContext.model
      }

      // Extract quota status from error headers if it's a rate limit error
      if (error instanceof APIError) {
        extractQuotaStatusFromError(error)
      }

      // Extract requestId from stream, error header, or error body
      const requestId =
        streamRequestId ||
        (error instanceof APIError ? error.requestID : undefined) ||
        (error instanceof APIError
          ? (error.error as { request_id?: string })?.request_id
          : undefined)

      logAPIError({
        error,
        model: errorModel,
        messageCount: messagesForAPI.length,
        messageTokens: tokenCountFromLastAPIResponse(messagesForAPI),
        durationMs: Date.now() - start,
        durationMsIncludingRetries: Date.now() - startIncludingRetries,
        attempt: attemptNumber,
        requestId,
        clientRequestId,
        didFallBackToNonStreaming,
        queryTracking: options.queryTracking,
        querySource: options.querySource,
        fastMode: isFastModeRequest,
        previousRequestId,
      })

      // Don't yield an assistant error message for user aborts
      // The interruption message is handled in query.ts
      if (error instanceof APIUserAbortError) {
        releaseStreamResources()
        return
      }

      yield getAssistantMessageFromError(error, errorModel, {
        messages,
        messagesForAPI,
      })
      releaseStreamResources()
      return
    }
  } finally {
    endActiveApiCall()
    stopSessionActivity('api_call')
    // Must be in the finally block: if the generator is terminated early
    // via .return() (e.g. consumer breaks out of for-await-of, or query.ts
    // encounters an abort), code after the try/finally never executes.
    // Without this, the Response object's native TLS/socket buffers leak
    // until the generator itself is GC'd (see GH #32920).
    releaseStreamResources()

    // Non-streaming fallback cost: the streaming path tracks cost in the
    // message_delta handler before any yield. Fallback pushes to newMessages
    // then yields, so tracking must be here to survive .return() at the yield.
    if (fallbackMessage) {
      const fallbackUsage = fallbackMessage.message.usage
      usage = updateUsage(EMPTY_USAGE, fallbackUsage)
      stopReason = fallbackMessage.message.stop_reason
      const fallbackCost = calculateUSDCost(resolvedModel, fallbackUsage)
      costUSD += addToTotalSessionCost(
        fallbackCost,
        fallbackUsage,
        options.model,
      )
    }
  }

  // Mark all registered tools as sent to API so they become eligible for deletion
  if (feature('CACHED_MICROCOMPACT') && cachedMCEnabled) {
    markToolsSentToAPIState()
  }

  // Track the last requestId for the main conversation chain so shutdown
  // can send a cache eviction hint to inference. Exclude backgrounded
  // sessions (Ctrl+B) which share the repl_main_thread querySource but
  // run inside an agent context — they are independent conversation chains
  // whose cache should not be evicted when the foreground session clears.
  if (
    streamRequestId &&
    !getAgentContext() &&
    (options.querySource.startsWith('repl_main_thread') ||
      options.querySource === 'sdk')
  ) {
    setLastMainRequestId(streamRequestId)
  }

  // Precompute scalars so the fire-and-forget .then() closure doesn't pin the
  // full messagesForAPI array (the entire conversation up to the context window
  // limit) until getToolPermissionContext() resolves.
  const logMessageCount = messagesForAPI.length
  const logMessageTokens = tokenCountFromLastAPIResponse(messagesForAPI)
  void options.getToolPermissionContext().then(permissionContext => {
    logAPISuccessAndDuration({
      model:
        newMessages[0]?.message.model ?? partialMessage?.model ?? options.model,
      preNormalizedModel: options.model,
      usage,
      start,
      startIncludingRetries,
      attempt: attemptNumber,
      messageCount: logMessageCount,
      messageTokens: logMessageTokens,
      requestId: streamRequestId ?? null,
      stopReason,
      ttftMs,
      didFallBackToNonStreaming,
      querySource: options.querySource,
      headers: responseHeaders,
      costUSD,
      queryTracking: options.queryTracking,
      permissionMode: permissionContext.mode,
      // Pass newMessages for content-length extraction in logging.ts
      newMessages,
      globalCacheStrategy,
      requestSetupMs: start - startIncludingRetries,
      attemptStartTimes,
      fastMode: isFastModeRequest,
      previousRequestId,
      betas: lastRequestBetas,
    })
  })

  // Defensive: also release on normal completion (no-op if finally already ran).
  releaseStreamResources()
}

/**
 * Cleans up stream resources to prevent memory leaks.
 * @internal Exported for testing
 */
export function cleanupStream(
  stream: Stream<BetaRawMessageStreamEvent> | undefined,
): void {
  if (!stream) {
    return
  }
  try {
    // Abort the stream via its controller if not already aborted
    if (!stream.controller.signal.aborted) {
      requestAbort(stream.controller, undefined, {
        source: 'claude_stream_cleanup',
        subsystem: 'claude_stream',
        controllerRole: 'provider-stream',
      })
    }
  } catch {
    // Ignore - stream may already be closed
  }
}

/**
 * Updates usage statistics with new values from streaming API events.
 * Note: Anthropic's streaming API provides cumulative usage totals, not incremental deltas.
 * Each event contains the complete usage up to that point in the stream.
 *
 * Input-related tokens (input_tokens, cache_creation_input_tokens, cache_read_input_tokens)
 * are typically set in message_start and remain constant. message_delta events may send
 * explicit 0 values for these fields, which should not overwrite the values from message_start.
 * We only update these fields if they have a non-null, non-zero value.
 */
export function updateUsage(
  usage: Readonly<NonNullableUsage>,
  partUsage: BetaMessageDeltaUsage | undefined,
): NonNullableUsage {
  if (!partUsage) {
    return { ...usage }
  }
  return {
    input_tokens:
      partUsage.input_tokens !== null && partUsage.input_tokens > 0
        ? partUsage.input_tokens
        : usage.input_tokens,
    cache_creation_input_tokens:
      partUsage.cache_creation_input_tokens !== null &&
      partUsage.cache_creation_input_tokens > 0
        ? partUsage.cache_creation_input_tokens
        : usage.cache_creation_input_tokens,
    cache_read_input_tokens:
      partUsage.cache_read_input_tokens !== null &&
      partUsage.cache_read_input_tokens > 0
        ? partUsage.cache_read_input_tokens
        : usage.cache_read_input_tokens,
    output_tokens: partUsage.output_tokens ?? usage.output_tokens,
    server_tool_use: {
      web_search_requests:
        partUsage.server_tool_use?.web_search_requests ??
        usage.server_tool_use.web_search_requests,
      web_fetch_requests:
        partUsage.server_tool_use?.web_fetch_requests ??
        usage.server_tool_use.web_fetch_requests,
    },
    service_tier: usage.service_tier,
    cache_creation: {
      // SDK type BetaMessageDeltaUsage is missing cache_creation, but it's real!
      ephemeral_1h_input_tokens:
        (partUsage as BetaUsage).cache_creation?.ephemeral_1h_input_tokens ??
        usage.cache_creation.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens:
        (partUsage as BetaUsage).cache_creation?.ephemeral_5m_input_tokens ??
        usage.cache_creation.ephemeral_5m_input_tokens,
    },
    // cache_deleted_input_tokens: returned by the API when cache editing
    // deletes KV cache content, but not in SDK types. Kept off NonNullableUsage
    // so the string is eliminated from external builds by dead code elimination.
    // Uses the same > 0 guard as other token fields to prevent message_delta
    // from overwriting the real value with 0.
    ...(feature('CACHED_MICROCOMPACT')
      ? {
          cache_deleted_input_tokens:
            (partUsage as unknown as { cache_deleted_input_tokens?: number })
              .cache_deleted_input_tokens != null &&
            (partUsage as unknown as { cache_deleted_input_tokens: number })
              .cache_deleted_input_tokens > 0
              ? (partUsage as unknown as { cache_deleted_input_tokens: number })
                  .cache_deleted_input_tokens
              : ((usage as unknown as { cache_deleted_input_tokens?: number })
                  .cache_deleted_input_tokens ?? 0),
        }
      : {}),
    inference_geo: usage.inference_geo,
    iterations: partUsage.iterations ?? usage.iterations,
    speed: (partUsage as BetaUsage).speed ?? usage.speed,
  }
}

/**
 * Accumulates usage from one message into a total usage object.
 * Used to track cumulative usage across multiple assistant turns.
 */
export function accumulateUsage(
  totalUsage: Readonly<NonNullableUsage>,
  messageUsage: Readonly<NonNullableUsage>,
): NonNullableUsage {
  return {
    input_tokens: totalUsage.input_tokens + messageUsage.input_tokens,
    cache_creation_input_tokens:
      totalUsage.cache_creation_input_tokens +
      messageUsage.cache_creation_input_tokens,
    cache_read_input_tokens:
      totalUsage.cache_read_input_tokens + messageUsage.cache_read_input_tokens,
    output_tokens: totalUsage.output_tokens + messageUsage.output_tokens,
    server_tool_use: {
      web_search_requests:
        totalUsage.server_tool_use.web_search_requests +
        messageUsage.server_tool_use.web_search_requests,
      web_fetch_requests:
        totalUsage.server_tool_use.web_fetch_requests +
        messageUsage.server_tool_use.web_fetch_requests,
    },
    service_tier: messageUsage.service_tier, // Use the most recent service tier
    cache_creation: {
      ephemeral_1h_input_tokens:
        totalUsage.cache_creation.ephemeral_1h_input_tokens +
        messageUsage.cache_creation.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens:
        totalUsage.cache_creation.ephemeral_5m_input_tokens +
        messageUsage.cache_creation.ephemeral_5m_input_tokens,
    },
    // See comment in updateUsage — field is not on NonNullableUsage to keep
    // the string out of external builds.
    ...(feature('CACHED_MICROCOMPACT')
      ? {
          cache_deleted_input_tokens:
            ((totalUsage as unknown as { cache_deleted_input_tokens?: number })
              .cache_deleted_input_tokens ?? 0) +
            ((
              messageUsage as unknown as { cache_deleted_input_tokens?: number }
            ).cache_deleted_input_tokens ?? 0),
        }
      : {}),
    inference_geo: messageUsage.inference_geo, // Use the most recent
    iterations: messageUsage.iterations, // Use the most recent
    speed: messageUsage.speed, // Use the most recent
  }
}

function isToolResultBlock(
  block: unknown,
): block is { type: 'tool_result'; tool_use_id: string } {
  return (
    block !== null &&
    typeof block === 'object' &&
    'type' in block &&
    (block as { type: string }).type === 'tool_result' &&
    'tool_use_id' in block
  )
}

type CachedMCEditsBlock = {
  type: 'cache_edits'
  edits: { type: 'delete'; cache_reference: string }[]
}

type CachedMCPinnedEdits = {
  userMessageIndex: number
  block: CachedMCEditsBlock
}

// Exported for testing cache_reference placement constraints
export function addCacheBreakpoints(
  messages: (UserMessage | AssistantMessage)[],
  enablePromptCaching: boolean,
  querySource?: QuerySource,
  useCachedMC = false,
  newCacheEdits?: CachedMCEditsBlock | null,
  pinnedEdits?: CachedMCPinnedEdits[],
  skipCacheWrite = false,
): MessageParam[] {
  logEvent('tengu_api_cache_breakpoints', {
    totalMessageCount: messages.length,
    cachingEnabled: enablePromptCaching,
    skipCacheWrite,
  })

  // Exactly one message-level cache_control marker per request. Mycro's
  // turn-to-turn eviction (page_manager/index.rs: Index::insert) frees
  // local-attention KV pages at any cached prefix position NOT in
  // cache_store_int_token_boundaries. With two markers the second-to-last
  // position is protected and its locals survive an extra turn even though
  // nothing will ever resume from there — with one marker they're freed
  // immediately. For fire-and-forget forks (skipCacheWrite) we shift the
  // marker to the second-to-last message: that's the last shared-prefix
  // point, so the write is a no-op merge on mycro (entry already exists)
  // and the fork doesn't leave its own tail in the KVCC. Dense pages are
  // refcounted and survive via the new hash either way.
  const markerIndex = skipCacheWrite ? messages.length - 2 : messages.length - 1
  const result = messages.map((msg, index) => {
    const addCache = index === markerIndex
    if (msg.type === 'user') {
      return userMessageToMessageParam(
        msg,
        addCache,
        enablePromptCaching,
        querySource,
      )
    }
    return assistantMessageToMessageParam(
      msg,
      addCache,
      enablePromptCaching,
      querySource,
    )
  })

  if (!useCachedMC) {
    return result
  }

  // Track all cache_references being deleted to prevent duplicates across blocks.
  const seenDeleteRefs = new Set<string>()

  // Helper to deduplicate a cache_edits block against already-seen deletions
  const deduplicateEdits = (block: CachedMCEditsBlock): CachedMCEditsBlock => {
    const uniqueEdits = block.edits.filter(edit => {
      if (seenDeleteRefs.has(edit.cache_reference)) {
        return false
      }
      seenDeleteRefs.add(edit.cache_reference)
      return true
    })
    return { ...block, edits: uniqueEdits }
  }

  // Re-insert all previously-pinned cache_edits at their original positions
  for (const pinned of pinnedEdits ?? []) {
    const msg = result[pinned.userMessageIndex]
    if (msg && msg.role === 'user') {
      if (!Array.isArray(msg.content)) {
        msg.content = [{ type: 'text', text: msg.content as string }]
      }
      const dedupedBlock = deduplicateEdits(pinned.block)
      if (dedupedBlock.edits.length > 0) {
        insertBlockAfterToolResults(msg.content, dedupedBlock)
      }
    }
  }

  // Insert new cache_edits into the last user message and pin them
  if (newCacheEdits && result.length > 0) {
    const dedupedNewEdits = deduplicateEdits(newCacheEdits)
    if (dedupedNewEdits.edits.length > 0) {
      for (let i = result.length - 1; i >= 0; i--) {
        const msg = result[i]
        if (msg && msg.role === 'user') {
          if (!Array.isArray(msg.content)) {
            msg.content = [{ type: 'text', text: msg.content as string }]
          }
          insertBlockAfterToolResults(msg.content, dedupedNewEdits)
          // Pin so this block is re-sent at the same position in future calls
          pinCacheEdits(i, newCacheEdits)

          logForDebugging(
            `Added cache_edits block with ${dedupedNewEdits.edits.length} deletion(s) to message[${i}]: ${dedupedNewEdits.edits.map(e => e.cache_reference).join(', ')}`,
          )
          break
        }
      }
    }
  }

  // Add cache_reference to tool_result blocks that are within the cached prefix.
  // Must be done AFTER cache_edits insertion since that modifies content arrays.
  if (enablePromptCaching) {
    // Find the last message containing a cache_control marker
    let lastCCMsg = -1
    for (let i = 0; i < result.length; i++) {
      const msg = result[i]!
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === 'object' && 'cache_control' in block) {
            lastCCMsg = i
          }
        }
      }
    }

    // Add cache_reference to tool_result blocks that are strictly before
    // the last cache_control marker. The API requires cache_reference to
    // appear "before or on" the last cache_control — we use strict "before"
    // to avoid edge cases where cache_edits splicing shifts block indices.
    //
    // Create new objects instead of mutating in-place to avoid contaminating
    // blocks reused by secondary queries that use models without cache_editing support.
    if (lastCCMsg >= 0) {
      for (let i = 0; i < lastCCMsg; i++) {
        const msg = result[i]!
        if (msg.role !== 'user' || !Array.isArray(msg.content)) {
          continue
        }
        let cloned = false
        for (let j = 0; j < msg.content.length; j++) {
          const block = msg.content[j]
          if (block && isToolResultBlock(block)) {
            if (!cloned) {
              msg.content = [...msg.content]
              cloned = true
            }
            msg.content[j] = Object.assign({}, block, {
              cache_reference: block.tool_use_id,
            })
          }
        }
      }
    }
  }

  return result
}

export function buildSystemPromptBlocks(
  systemPrompt: SystemPrompt,
  enablePromptCaching: boolean,
  options?: {
    skipGlobalCacheForSystemPrompt?: boolean
    querySource?: QuerySource
  },
): TextBlockParam[] {
  // IMPORTANT: Do not add any more blocks for caching or you will get a 400
  return splitSysPromptPrefix(systemPrompt, {
    skipGlobalCacheForSystemPrompt: options?.skipGlobalCacheForSystemPrompt,
  }).map(block => {
    return {
      type: 'text' as const,
      text: block.text,
      ...(enablePromptCaching &&
        block.cacheScope !== null && {
          cache_control: getCacheControl({
            scope: block.cacheScope,
            querySource: options?.querySource,
          }),
        }),
    }
  })
}

type HaikuOptions = Omit<Options, 'model' | 'getToolPermissionContext'>

export async function queryHaiku({
  systemPrompt = asSystemPrompt([]),
  userPrompt,
  outputFormat,
  signal,
  options,
}: {
  systemPrompt: SystemPrompt
  userPrompt: string
  outputFormat?: BetaJSONOutputFormat
  signal: AbortSignal
  options: HaikuOptions
}): Promise<AssistantMessage> {
  const result = await withVCR(
    [
      createUserMessage({
        content: systemPrompt.map(text => ({ type: 'text', text })),
      }),
      createUserMessage({
        content: userPrompt,
      }),
    ],
    async () => {
      const messages = [
        createUserMessage({
          content: userPrompt,
        }),
      ]

      const result = await queryModelWithoutStreaming({
        messages,
        systemPrompt,
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal,
        options: {
          ...options,
          model: getSmallFastModel(),
          enablePromptCaching: options.enablePromptCaching ?? false,
          outputFormat,
          async getToolPermissionContext() {
            return getEmptyToolPermissionContext()
          },
        },
      })
      return [result]
    },
  )
  // We don't use streaming for Haiku so this is safe
  return result[0]! as AssistantMessage
}

type QueryWithModelOptions = Omit<Options, 'getToolPermissionContext'>

/**
 * Query a specific model through the Claude Code infrastructure.
 * This goes through the full query pipeline including proper authentication,
 * betas, and headers - unlike direct API calls.
 */
export async function queryWithModel({
  systemPrompt = asSystemPrompt([]),
  userPrompt,
  outputFormat,
  signal,
  options,
}: {
  systemPrompt: SystemPrompt
  userPrompt: string
  outputFormat?: BetaJSONOutputFormat
  signal: AbortSignal
  options: QueryWithModelOptions
}): Promise<AssistantMessage> {
  const result = await withVCR(
    [
      createUserMessage({
        content: systemPrompt.map(text => ({ type: 'text', text })),
      }),
      createUserMessage({
        content: userPrompt,
      }),
    ],
    async () => {
      const messages = [
        createUserMessage({
          content: userPrompt,
        }),
      ]

      const result = await queryModelWithoutStreaming({
        messages,
        systemPrompt,
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal,
        options: {
          ...options,
          enablePromptCaching: options.enablePromptCaching ?? false,
          outputFormat,
          async getToolPermissionContext() {
            return getEmptyToolPermissionContext()
          },
        },
      })
      return [result]
    },
  )
  return result[0]! as AssistantMessage
}

// Non-streaming requests have a 10min max per the docs:
// https://platform.claude.com/docs/en/api/errors#long-requests
// The SDK's 21333-token cap is derived from 10min × 128k tokens/hour, but we
// bypass it by setting a client-level timeout, so we can cap higher.
export const MAX_NON_STREAMING_TOKENS = 64_000

/**
 * Adjusts thinking budget when max_tokens is capped for non-streaming fallback.
 * Ensures the API constraint: max_tokens > thinking.budget_tokens
 *
 * @param params - The parameters that will be sent to the API
 * @param maxTokensCap - The maximum allowed tokens (MAX_NON_STREAMING_TOKENS)
 * @returns Adjusted parameters with thinking budget capped if needed
 */
export function adjustParamsForNonStreaming<
  T extends {
    max_tokens: number
    thinking?: BetaMessageStreamParams['thinking']
  },
>(params: T, maxTokensCap: number): T {
  const cappedMaxTokens = Math.min(params.max_tokens, maxTokensCap)

  // Adjust thinking budget if it would exceed capped max_tokens
  // to maintain the constraint: max_tokens > thinking.budget_tokens
  const adjustedParams = { ...params }
  if (
    adjustedParams.thinking?.type === 'enabled' &&
    adjustedParams.thinking.budget_tokens
  ) {
    adjustedParams.thinking = {
      ...adjustedParams.thinking,
      budget_tokens: Math.min(
        adjustedParams.thinking.budget_tokens,
        cappedMaxTokens - 1, // Must be at least 1 less than max_tokens
      ),
    }
  }

  return {
    ...adjustedParams,
    max_tokens: cappedMaxTokens,
  }
}

function isMaxTokensCapEnabled(): boolean {
  // 3P default: false (not validated on Bedrock/Vertex)
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_otk_slot_v1', false)
}

export function getMaxOutputTokensForModel(model: string): number {
  const maxOutputTokens = getModelMaxOutputTokens(model)

  // Slot-reservation cap: drop default to 8k for all models. BQ p99 output
  // = 4,911 tokens; 32k/64k defaults over-reserve 8-16× slot capacity.
  // Requests hitting the cap get one clean retry at 64k (query.ts
  // max_output_tokens_escalate). Math.min keeps models with lower native
  // defaults (e.g. claude-3-opus at 4k) at their native value. Applied
  // before the env-var override so CLAUDE_CODE_MAX_OUTPUT_TOKENS still wins.
  const defaultTokens = isMaxTokensCapEnabled()
    ? Math.min(maxOutputTokens.default, CAPPED_DEFAULT_MAX_TOKENS)
    : maxOutputTokens.default

  const result = validateBoundedIntEnvVar(
    'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
    process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,
    defaultTokens,
    maxOutputTokens.upperLimit,
  )
  return result.effective
}
