import { feature } from 'bun:bundle'
import type Anthropic from '@anthropic-ai/sdk'
import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk'
import type { QuerySource } from 'src/constants/querySource.js'
import type { SystemAPIErrorMessage } from 'src/types/message.js'
import {
  isExpectedSideTaskAbortReason,
  normalizeAbortReason,
} from 'src/utils/abortReasons.js'
import { isAwsCredentialsProviderError } from 'src/utils/aws.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logError } from 'src/utils/log.js'
import { createSystemAPIErrorMessage } from 'src/utils/messages.js'
import { getAPIProvider, getAPIProviderForStatsig } from 'src/utils/model/providers.js'
import {
  clearApiKeyHelperCache,
  clearAwsCredentialsCache,
  clearGcpCredentialsCache,
  getClaudeAIOAuthTokens,
  handleOAuth401Error,
  isClaudeAISubscriber,
  isEnterpriseSubscriber,
} from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { validateBoundedIntEnvVar } from '../../utils/envValidation.js'
import { errorMessage } from '../../utils/errors.js'
import {
  type CooldownReason,
  handleFastModeOverageRejection,
  handleFastModeRejectedByAPI,
  isFastModeCooldown,
  isFastModeEnabled,
  triggerFastModeCooldown,
} from '../../utils/fastMode.js'
import { isNonCustomOpusModel } from '../../utils/model/model.js'
import { disableKeepAlive } from '../../utils/proxy.js'
import { sleep } from '../../utils/sleep.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  checkMockRateLimitError,
  isMockRateLimitError,
} from '../rateLimitMocking.js'
import { REPEATED_529_ERROR_MESSAGE, isOpenCodeGoQuotaError } from './errors.js'
import { extractConnectionErrorDetails } from './errorUtils.js'
import {
  extractOpenAICategoryMarker,
  isOpenAIRequestNonReplayable,
  isRetryableOpenAICompatibilityFailureCategory,
} from './openaiErrorClassification.js'

const abortError = () => new APIUserAbortError()

const DEFAULT_MAX_RETRIES = 10
const MAX_CONFIGURABLE_RETRIES = 100
const FLOOR_OUTPUT_TOKENS = 3000
const MAX_529_RETRIES = 3
export const DEFAULT_RETRY_DELAY_MS = 500
export const BASE_DELAY_MS = DEFAULT_RETRY_DELAY_MS
const MAX_RETRY_DELAY_BASE_MS = 60_000

// Foreground query sources where the user IS blocking on the result — these
// retry on 529. Everything else (summaries, titles, suggestions, classifiers)
// bails immediately: during a capacity cascade each retry is 3-10× gateway
// amplification, and the user never sees those fail anyway. New sources
// default to no-retry — add here only if the user is waiting on the result.
const FOREGROUND_529_RETRY_SOURCES = new Set<QuerySource>([
  'repl_main_thread',
  'repl_main_thread:outputStyle:custom',
  'repl_main_thread:outputStyle:Explanatory',
  'repl_main_thread:outputStyle:Learning',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
  'compact',
  'hook_agent',
  'hook_prompt',
  'verification_agent',
  'side_question',
  // Security classifiers — must complete for auto-mode correctness.
  // yoloClassifier.ts uses 'auto_mode' (not 'yolo_classifier' — that's
  // type-only). bash_classifier is internal-only; feature-gate so the string
  // tree-shakes out of external builds (excluded-strings.txt).
  'auto_mode',
  ...(feature('BASH_CLASSIFIER') ? (['bash_classifier'] as const) : []),
])

function shouldRetry529(querySource: QuerySource | undefined): boolean {
  // undefined → retry (conservative for untagged call paths)
  return (
    querySource === undefined || FOREGROUND_529_RETRY_SOURCES.has(querySource)
  )
}

// CLAUDE_CODE_UNATTENDED_RETRY: for unattended sessions (internal-only). Retries 429/529
// indefinitely with higher backoff and periodic keep-alive yields so the host
// environment does not mark the session idle mid-wait.
// TODO(ANT-344): the keep-alive via SystemAPIErrorMessage yields is a stopgap
// until there's a dedicated keep-alive channel.
const PERSISTENT_MAX_BACKOFF_MS = 5 * 60 * 1000
const PERSISTENT_RESET_CAP_MS = 6 * 60 * 60 * 1000
const HEARTBEAT_INTERVAL_MS = 30_000
const PERSISTENT_MAX_ATTEMPTS = 100
// Exposed for unit-test assertion only. The persistent retry cap itself is
// driven by isPersistentRetryEnabled() — there is no runtime override seam
// (tests must enable UNATTENDED_RETRY via `bun test --feature=UNATTENDED_RETRY`
// and set CLAUDE_CODE_UNATTENDED_RETRY to exercise this path).
export { PERSISTENT_MAX_ATTEMPTS as _PERSISTENT_MAX_ATTEMPTS_FOR_TEST, isPersistentRetryEnabled }

function isPersistentRetryEnabled(): boolean {
  return feature('UNATTENDED_RETRY')
    ? isEnvTruthy(process.env.CLAUDE_CODE_UNATTENDED_RETRY)
    : false
}

function isQuotaExhausted(error: unknown): boolean {
  const errObj = error as { message?: unknown; status?: unknown } | null | undefined
  const msg = String(errObj?.message ?? '').toLowerCase()
  const status = errObj?.status

  // OpenRouter (and other gateways) return 402 with instructions to adjust max_tokens.
  // If the 402 is retryable via token adjustment, do not treat it as exhausted.
  if (status === 402 && error instanceof APIError && parseOpenRouterAffordableMaxTokensError(error) !== undefined) {
    return false
  }

  return (
    status === 402 ||
    msg.includes('quota_exhausted') ||
    ((status === 429 || status === 403 || status === 400) &&
      (msg.includes('limit: 0') ||
        msg.includes('exceeded your current quota') ||
        msg.includes('credit') ||
        msg.includes('billing') ||
        msg.includes('payment required') ||
        msg.includes('usage limit') ||
        msg.includes('allotment') ||
        msg.includes('quota')))
  )
}

function isTransientCapacityError(error: unknown): boolean {
  return (
    is529Error(error) || (error instanceof APIError && error.status === 429)
  )
}

function isStaleConnectionError(error: unknown): boolean {
  if (!(error instanceof APIConnectionError)) {
    return false
  }
  const details = extractConnectionErrorDetails(error)
  return details?.code === 'ECONNRESET' || details?.code === 'EPIPE'
}

export interface RetryContext {
  maxTokensOverride?: number
  model: string
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
}

interface RetryOptions {
  maxRetries?: number
  model: string
  fallbackModel?: string
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
  signal?: AbortSignal
  querySource?: QuerySource
  /**
   * Pre-seed the consecutive 529 counter. Used when this retry loop is a
   * non-streaming fallback after a streaming 529 — the streaming 529 should
   * count toward MAX_529_RETRIES so total 529s-before-fallback is consistent
   * regardless of which request mode hit the overload.
   */
  initialConsecutive529Errors?: number
}

export class CannotRetryError extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly retryContext: RetryContext,
  ) {
    const message = errorMessage(originalError)
    super(message)
    this.name = 'RetryError'

    // Preserve the original stack trace if available
    if (originalError instanceof Error && originalError.stack) {
      this.stack = originalError.stack
    }
  }
}

export class FallbackTriggeredError extends Error {
  constructor(
    public readonly originalModel: string,
    public readonly fallbackModel: string,
  ) {
    super(`Model fallback triggered: ${originalModel} -> ${fallbackModel}`)
    this.name = 'FallbackTriggeredError'
  }
}

export async function* withRetry<T>(
  getClient: () => Promise<Anthropic>,
  operation: (
    client: Anthropic,
    attempt: number,
    context: RetryContext,
  ) => Promise<T>,
  options: RetryOptions,
): AsyncGenerator<SystemAPIErrorMessage, T> {
  const maxRetries = getMaxRetries(options)
  const persistentRetryEnabled = isPersistentRetryEnabled()
  const retryContext: RetryContext = {
    model: options.model,
    thinkingConfig: options.thinkingConfig,
    ...(isFastModeEnabled() && { fastMode: options.fastMode }),
  }
  let client: Anthropic | null = null
  let consecutive529Errors = options.initialConsecutive529Errors ?? 0
  let lastError: unknown
  let persistentAttempt = 0
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (options.signal?.aborted) {
      throw new APIUserAbortError()
    }

    // Capture whether fast mode is active before this attempt
    // (fallback may change the state mid-loop)
    const wasFastModeActive = isFastModeEnabled()
      ? retryContext.fastMode && !isFastModeCooldown()
      : false

    try {
      // Check for mock rate limits (used by /mock-limits command for Ant employees)
      if (process.env.USER_TYPE === 'ant') {
        const mockError = checkMockRateLimitError(
          retryContext.model,
          wasFastModeActive,
        )
        if (mockError) {
          throw mockError
        }
      }

      // Get a fresh client instance on first attempt or after authentication errors
      // - 401 for first-party API authentication failures
      // - 403 "OAuth token has been revoked" (another process refreshed the token)
      // - Bedrock-specific auth errors (403 or CredentialsProviderError)
      // - Vertex-specific auth errors (credential refresh failures, 401)
      // - ECONNRESET/EPIPE: stale keep-alive socket; disable pooling and reconnect
      const isStaleConnection = isStaleConnectionError(lastError)
      if (
        isStaleConnection &&
        getFeatureValue_CACHED_MAY_BE_STALE(
          'tengu_disable_keepalive_on_econnreset',
          false,
        )
      ) {
        logForDebugging(
          'Stale connection (ECONNRESET/EPIPE) — disabling keep-alive for retry',
        )
        disableKeepAlive()
      }

      if (
        client === null ||
        (lastError instanceof APIError && lastError.status === 401) ||
        isOAuthTokenRevokedError(lastError) ||
        isBedrockAuthError(lastError) ||
        isVertexAuthError(lastError) ||
        isStaleConnection
      ) {
        // On 401 "token expired" or 403 "token revoked", force a token refresh
        if (
          (lastError instanceof APIError && lastError.status === 401) ||
          isOAuthTokenRevokedError(lastError)
        ) {
          const failedAccessToken = getClaudeAIOAuthTokens()?.accessToken
          if (failedAccessToken) {
            await handleOAuth401Error(failedAccessToken)
          }
        }
        client = await getClient()
      }

      return await operation(client, attempt, retryContext)
    } catch (error) {
      lastError = error
      if (
        error instanceof APIUserAbortError &&
        options.signal?.aborted &&
        isExpectedSideTaskAbortReason(options.signal.reason)
      ) {
        logForDebugging(
          `Expected side-task API abort (${normalizeAbortReason(options.signal.reason)}): ${errorMessage(error)}`,
        )
        throw new CannotRetryError(error, retryContext)
      }
      logForDebugging(
        `API error (attempt ${attempt}/${maxRetries + 1}): ${error instanceof APIError ? `${error.status} ${error.message}` : errorMessage(error)}`,
        { level: 'error' },
      )
      // OpenCode Go quota exhaustion is terminal and carries a specific,
      // actionable assistant message (subscribe / reset timing). Throw here -
      // before the fast-mode 429 fallback below - so fast mode can't retry or
      // cooldown a quota-exhausted subscription. Wrapping the original
      // APIError preserves the OpenCode Go message via
      // getAssistantMessageFromError instead of the generic guidance.
      if (isOpenCodeGoQuotaError(error)) {
        throw new CannotRetryError(error, retryContext)
      }
      if (
        error instanceof APIError &&
        extractOpenAICategoryMarker(error.message) === 'quota_exhausted'
      ) {
        throw new CannotRetryError(error, retryContext)
      }
      if (isQuotaExhausted(error)) {
        throw new CannotRetryError(
          new Error(
            'API quota exhausted or not enabled.\n' +
            'Fix:\n' +
            '- Enable billing for your provider\n' +
            '- Or switch provider via /provider',
          ),
          retryContext,
        )
      }
      // Fast mode fallback: on 429/529, either wait and retry (short delays)
      // or fall back to standard speed (long delays) to avoid cache thrashing.
      // Skip in persistent mode: the short-retry path below loops with fast
      // mode still active, so its `continue` never reaches the attempt clamp
      // and the for-loop terminates. Persistent sessions want the chunked
      // keep-alive path instead of fast-mode cache-preservation anyway.
      if (
        wasFastModeActive &&
        !persistentRetryEnabled &&
        error instanceof APIError &&
        (error.status === 429 || is529Error(error))
      ) {
        // If the 429 is specifically because extra usage (overage) is not
        // available, permanently disable fast mode with a specific message.
        const overageReason = error.headers?.get(
          'anthropic-ratelimit-unified-overage-disabled-reason',
        )
        if (overageReason !== null && overageReason !== undefined) {
          handleFastModeOverageRejection(overageReason)
          retryContext.fastMode = false
          continue
        }

        const retryAfterMs = getRetryAfterMs(error)
        if (retryAfterMs !== null && retryAfterMs < SHORT_RETRY_THRESHOLD_MS) {
          // Short retry-after: wait and retry with fast mode still active
          // to preserve prompt cache (same model name on retry).
          await sleep(retryAfterMs, options.signal, { abortError })
          continue
        }
        // Long or unknown retry-after: enter cooldown (switches to standard
        // speed model), with a minimum floor to avoid flip-flopping.
        const cooldownMs = Math.max(
          retryAfterMs ?? DEFAULT_FAST_MODE_FALLBACK_HOLD_MS,
          MIN_COOLDOWN_MS,
        )
        const cooldownReason: CooldownReason = is529Error(error)
          ? 'overloaded'
          : 'rate_limit'
        triggerFastModeCooldown(Date.now() + cooldownMs, cooldownReason)
        if (isFastModeEnabled()) {
          retryContext.fastMode = false
        }
        continue
      }

      // Fast mode fallback: if the API rejects the fast mode parameter
      // (e.g., org doesn't have fast mode enabled), permanently disable fast
      // mode and retry at standard speed.
      if (wasFastModeActive && isFastModeNotEnabledError(error)) {
        handleFastModeRejectedByAPI()
        retryContext.fastMode = false
        continue
      }

      // Non-foreground sources bail immediately on 529 — no retry amplification
      // during capacity cascades. User never sees these fail.
      if (is529Error(error) && !shouldRetry529(options.querySource)) {
        logEvent('tengu_api_529_background_dropped', {
          query_source:
            options.querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw new CannotRetryError(error, retryContext)
      }

      // Track consecutive 529 errors
      if (
        is529Error(error) &&
        // If FALLBACK_FOR_ALL_PRIMARY_MODELS is not set, fall through only if the primary model is a non-custom Opus model.
        // TODO: Revisit if the isNonCustomOpusModel check should still exist, or if isNonCustomOpusModel is a stale artifact of when Claude Code was hardcoded on Opus.
        (process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS ||
          (!isClaudeAISubscriber() && isNonCustomOpusModel(options.model)))
      ) {
        consecutive529Errors++
        if (consecutive529Errors >= MAX_529_RETRIES) {
          // Check if fallback model is specified
          if (options.fallbackModel) {
            logEvent('tengu_api_opus_fallback_triggered', {
              original_model:
                options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              fallback_model:
                options.fallbackModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              provider: getAPIProviderForStatsig(),
            })

            // Throw special error to indicate fallback was triggered
            throw new FallbackTriggeredError(
              options.model,
              options.fallbackModel,
            )
          }

          if (
            process.env.USER_TYPE === 'external' &&
            !process.env.IS_SANDBOX &&
            !persistentRetryEnabled
          ) {
            logEvent('tengu_api_custom_529_overloaded_error', {})
            throw new CannotRetryError(
              new Error(REPEATED_529_ERROR_MESSAGE),
              retryContext,
            )
          }
        }
      }

      // Only retry if the error indicates we should
      const persistent =
        persistentRetryEnabled && isTransientCapacityError(error)
      if (attempt > maxRetries && !persistent) {
        throw new CannotRetryError(error, retryContext)
      }
      // Cap persistent retries to prevent unbounded loops (100 attempts * ~5min max backoff = 8 hours).
      // NOTE: the "~8 hours" estimate applies only to the exponential-backoff path. The
      // reset-delay path can wait up to PERSISTENT_RESET_CAP_MS (6 hours) per attempt, so
      // exhausting 100 attempts can take far longer.
      if (persistent && persistentAttempt >= PERSISTENT_MAX_ATTEMPTS) {
        logEvent('tengu_api_persistent_retry_cap_reached', {
          error: (error as APIError).message as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          status: (error as APIError).status,
          model: retryContext.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          persistentAttempt,
          PERSISTENT_MAX_BACKOFF_MS,
          PERSISTENT_MAX_ATTEMPTS,
          provider: getAPIProviderForStatsig(),
        })
        throw new CannotRetryError(error, retryContext)
      }

      // AWS/GCP errors aren't always APIError, but can be retried
      const handledCloudAuthError =
        handleAwsCredentialError(error) || handleGcpCredentialError(error)
      if (
        !handledCloudAuthError &&
        (!(error instanceof APIError) ||
          !shouldRetry(error, persistentRetryEnabled))
      ) {
        throw new CannotRetryError(error, retryContext)
      }

      // OpenRouter / OpenAI-compatible quota gateways: HTTP 402 with the
      // affordable max_tokens in the message. Retry once at the affordable
      // cap instead of failing on a credits-vs-max_tokens mismatch the user
      // can't see in their shell (#1125). One adjustment per chain — if 402
      // recurs after this, fail instead of spending the normal retry budget.
      if (error instanceof APIError) {
        const affordData = parseOpenRouterAffordableMaxTokensError(error)
        if (affordData && retryContext.maxTokensOverride === undefined) {
          retryContext.maxTokensOverride = affordData.affordableMaxTokens
          logEvent('tengu_openrouter_402_max_tokens_adjustment', {
            requestedMaxTokens: affordData.requestedMaxTokens,
            affordableMaxTokens: affordData.affordableMaxTokens,
            attempt,
          })
          // Surface the credit pressure so the user understands why output
          // shrank. Single line; the provider already explained the why.
          console.error(
            `Provider returned 402 — retrying with max_tokens=${affordData.affordableMaxTokens} (was ${affordData.requestedMaxTokens}). Top up credits to restore the full budget.`,
          )
          continue
        }
        if (affordData) {
          throw new CannotRetryError(error, retryContext)
        }
      }

      // Handle max tokens context overflow errors by adjusting max_tokens for the next attempt
      // NOTE: With extended-context-window beta, this 400 error should not occur.
      // The API now returns 'model_context_window_exceeded' stop_reason instead.
      // Keeping for backward compatibility.
      if (error instanceof APIError) {
        const overflowData = parseMaxTokensContextOverflowError(error)
        if (overflowData) {
          const { inputTokens, contextLimit } = overflowData

          const safetyBuffer = 1000
          const availableContext = Math.max(
            0,
            contextLimit - inputTokens - safetyBuffer,
          )
          if (availableContext < FLOOR_OUTPUT_TOKENS) {
            logError(
              new Error(
                `availableContext ${availableContext} is less than FLOOR_OUTPUT_TOKENS ${FLOOR_OUTPUT_TOKENS}`,
              ),
            )
            throw error
          }
          // Ensure we have enough tokens for thinking + at least 1 output token
          const minRequired =
            (retryContext.thinkingConfig.type === 'enabled'
              ? retryContext.thinkingConfig.budgetTokens
              : 0) + 1
          const adjustedMaxTokens = Math.max(
            FLOOR_OUTPUT_TOKENS,
            availableContext,
            minRequired,
          )
          retryContext.maxTokensOverride = adjustedMaxTokens

          logEvent('tengu_max_tokens_context_overflow_adjustment', {
            inputTokens,
            contextLimit,
            adjustedMaxTokens,
            attempt,
          })

          continue
        }
      }

      // For other errors, proceed with normal retry logic
      // Get retry-after header if available
      const retryAfter = getRetryAfter(error)
      let delayMs: number
      if (persistent && error instanceof APIError && error.status === 429) {
        persistentAttempt++
        // Window-based limits (e.g. 5hr Max/Pro) include a reset timestamp.
        // Wait until reset rather than polling every 5 min uselessly.
        const resetDelay = getRateLimitResetDelayMs(error)
        delayMs =
          resetDelay ??
          Math.min(
            getRetryDelay(
              persistentAttempt,
              retryAfter,
              PERSISTENT_MAX_BACKOFF_MS,
            ),
            PERSISTENT_RESET_CAP_MS,
          )
      } else if (persistent) {
        persistentAttempt++
        // Retry-After is a server directive and bypasses maxDelayMs inside
        // getRetryDelay (intentional — honoring it is correct). Cap at the
        // 6hr reset-cap here so a pathological header can't wait unbounded.
        delayMs = Math.min(
          getRetryDelay(
            persistentAttempt,
            retryAfter,
            PERSISTENT_MAX_BACKOFF_MS,
          ),
          PERSISTENT_RESET_CAP_MS,
        )
      } else {
        delayMs = getRetryDelay(attempt, retryAfter)
      }

      // In persistent mode the for-loop `attempt` is clamped at maxRetries+1;
      // use persistentAttempt for telemetry/yields so they show the true count.
      const reportedAttempt = persistent ? persistentAttempt : attempt
      logEvent('tengu_api_retry', {
        attempt: reportedAttempt,
        delayMs: delayMs,
        error: (error as APIError)
          .message as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        status: (error as APIError).status,
        provider: getAPIProviderForStatsig(),
      })

      if (persistent) {
        if (delayMs > 60_000) {
          logEvent('tengu_api_persistent_retry_wait', {
            status: (error as APIError).status,
            delayMs,
            attempt: reportedAttempt,
            provider: getAPIProviderForStatsig(),
          })
        }
        // Chunk long sleeps so the host sees periodic stdout activity and
        // does not mark the session idle. Each yield surfaces as
        // {type:'system', subtype:'api_retry'} on stdout via QueryEngine.
        let remaining = delayMs
        while (remaining > 0) {
          if (options.signal?.aborted) throw new APIUserAbortError()
          if (error instanceof APIError) {
            yield createSystemAPIErrorMessage(
              error,
              remaining,
              reportedAttempt,
              maxRetries,
            )
          }
          const chunk = Math.min(remaining, HEARTBEAT_INTERVAL_MS)
          await sleep(chunk, options.signal, { abortError })
          remaining -= chunk
        }
        // Clamp so the for-loop never terminates. Backoff uses the separate
        // persistentAttempt counter which keeps growing to the 5-min cap.
        if (attempt >= maxRetries) attempt = maxRetries
      } else {
        if (error instanceof APIError) {
          yield createSystemAPIErrorMessage(error, delayMs, attempt, maxRetries)
        }
        await sleep(delayMs, options.signal, { abortError })
      }
    }
  }

  throw new CannotRetryError(lastError, retryContext)
}

function getRetryAfter(error: unknown): string | null {
  return (
    ((error as { headers?: { 'retry-after'?: string } }).headers?.[
      'retry-after'
    ] ||
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      ((error as APIError).headers as Headers)?.get?.('retry-after')) ??
    null
  )
}

export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs = 32000,
): number {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10)
    if (!isNaN(seconds)) {
      return seconds * 1000
    }
  }

  const baseDelayMs = getDefaultRetryDelayMs()
  const baseDelay = Math.min(
    baseDelayMs * Math.pow(2, attempt - 1),
    maxDelayMs,
  )
  const jitter = Math.random() * 0.25 * baseDelay
  return baseDelay + jitter
}

/**
 * OpenRouter (and several other quota-billed gateways) reply with HTTP 402
 * when the caller has fewer credits than the requested max_tokens would
 * consume. The error message includes the affordable cap, so we can retry
 * once with the lower number instead of forcing the user to manually lower
 * their max_tokens (issue #1125).
 *
 * Example body:
 *   This request requires more credits, or fewer max_tokens. You requested
 *   up to 32000 tokens, but can only afford 27342. To increase, visit ...
 */
export function parseOpenRouterAffordableMaxTokensError(error: APIError):
  | { requestedMaxTokens: number; affordableMaxTokens: number }
  | undefined {
  if (error.status !== 402 || !error.message) {
    return undefined
  }
  const regex =
    /requested up to (\d+) tokens?, but can only afford (\d+)/i
  const match = error.message.match(regex)
  if (!match || match.length !== 3 || !match[1] || !match[2]) {
    return undefined
  }
  const requestedMaxTokens = parseInt(match[1], 10)
  const affordableMaxTokens = parseInt(match[2], 10)
  if (
    isNaN(requestedMaxTokens) ||
    isNaN(affordableMaxTokens) ||
    affordableMaxTokens <= 0
  ) {
    return undefined
  }
  return { requestedMaxTokens, affordableMaxTokens }
}

export function parseMaxTokensContextOverflowError(error: APIError):
  | {
      inputTokens: number
      maxTokens: number
      contextLimit: number
    }
  | undefined {
  if (error.status !== 400 || !error.message) {
    return undefined
  }

  if (
    !error.message.includes(
      'input length and `max_tokens` exceed context limit',
    )
  ) {
    return undefined
  }

  // Example format: "input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000"
  const regex =
    /input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)/
  const match = error.message.match(regex)

  if (!match || match.length !== 4) {
    return undefined
  }

  if (!match[1] || !match[2] || !match[3]) {
    logError(
      new Error(
        'Unable to parse max_tokens from max_tokens exceed context limit error message',
      ),
    )
    return undefined
  }
  const inputTokens = parseInt(match[1], 10)
  const maxTokens = parseInt(match[2], 10)
  const contextLimit = parseInt(match[3], 10)

  if (isNaN(inputTokens) || isNaN(maxTokens) || isNaN(contextLimit)) {
    return undefined
  }

  return { inputTokens, maxTokens, contextLimit }
}

// TODO: Replace with a response header check once the API adds a dedicated
// header for fast-mode rejection (e.g., x-fast-mode-rejected). String-matching
// the error message is fragile and will break if the API wording changes.
function isFastModeNotEnabledError(error: unknown): boolean {
  if (!(error instanceof APIError)) {
    return false
  }
  return (
    error.status === 400 &&
    (error.message?.includes('Fast mode is not enabled') ?? false)
  )
}

export function is529Error(error: unknown): boolean {
  if (!(error instanceof APIError)) {
    return false
  }

  // Check for 529 status code or overloaded error in message
  return (
    error.status === 529 ||
    // See below: the SDK sometimes fails to properly pass the 529 status code during streaming
    (error.message?.includes('"type":"overloaded_error"') ?? false)
  )
}

function isOAuthTokenRevokedError(error: unknown): boolean {
  return (
    error instanceof APIError &&
    error.status === 403 &&
    (error.message?.includes('OAuth token has been revoked') ?? false)
  )
}

function isBedrockAuthError(error: unknown): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) {
    // AWS libs reject without an API call if .aws holds a past Expiration value
    // otherwise, API calls that receive expired tokens give generic 403
    // "The security token included in the request is invalid"
    if (
      isAwsCredentialsProviderError(error) ||
      (error instanceof APIError && error.status === 403)
    ) {
      return true
    }
  }
  return false
}

/**
 * Clear AWS auth caches if appropriate.
 * @returns true if action was taken.
 */
function handleAwsCredentialError(error: unknown): boolean {
  if (isBedrockAuthError(error)) {
    clearAwsCredentialsCache()
    return true
  }
  return false
}

// google-auth-library throws plain Error (no typed name like AWS's
// CredentialsProviderError). Match common SDK-level credential-failure messages.
function isGoogleAuthLibraryCredentialError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message
  return (
    msg.includes('Could not load the default credentials') ||
    msg.includes('Could not refresh access token') ||
    msg.includes('invalid_grant')
  )
}

function isVertexAuthError(error: unknown): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) {
    // SDK-level: google-auth-library fails in prepareOptions() before the HTTP call
    if (isGoogleAuthLibraryCredentialError(error)) {
      return true
    }
    // Server-side: Vertex returns 401 for expired/invalid tokens
    if (error instanceof APIError && error.status === 401) {
      return true
    }
  }
  return false
}

/**
 * Clear GCP auth caches if appropriate.
 * @returns true if action was taken.
 */
function handleGcpCredentialError(error: unknown): boolean {
  if (isVertexAuthError(error)) {
    clearGcpCredentialsCache()
    return true
  }
  return false
}

function shouldRetry(error: APIError, persistentRetryEnabled: boolean): boolean {
  // Never retry mock errors - they're from /mock-limits command for testing
  if (isMockRateLimitError(error)) {
    return false
  }

  if (isOpenAIRequestNonReplayable(error)) {
    return false
  }

  // OpenCode Go subscription quota exhaustion is terminal — retrying burns
  // the same 429 and confuses the user with repeated "mysterious stop"
  // failures. getAssistantMessageFromError surfaces the actionable message.
  if (isOpenCodeGoQuotaError(error)) {
    return false
  }

  // Persistent mode: 429/529 always retryable, bypass subscriber gates and
  // x-should-retry header.
  if (persistentRetryEnabled && isTransientCapacityError(error)) {
    return true
  }

  // Local max_tokens recovery paths need to run even when an
  // OpenAI-compatible shim classifies the underlying provider error as a
  // non-retryable context or quota failure.
  if (parseMaxTokensContextOverflowError(error)) {
    return true
  }

  if (parseOpenRouterAffordableMaxTokensError(error)) {
    return true
  }

  const openAICategory = extractOpenAICategoryMarker(error.message ?? '')
  if (
    openAICategory &&
    !isRetryableOpenAICompatibilityFailureCategory(openAICategory)
  ) {
    return false
  }

  // CCR mode: auth is via infrastructure-provided JWTs, so a 401/403 is a
  // transient blip (auth service flap, network hiccup) rather than bad
  // credentials. Bypass x-should-retry:false — the server assumes we'd retry
  // the same bad key, but our key is fine.
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
    (error.status === 401 || error.status === 403)
  ) {
    return true
  }

  // Check for overloaded errors first by examining the message content
  // The SDK sometimes fails to properly pass the 529 status code during streaming,
  // so we need to check the error message directly
  if (error.message?.includes('"type":"overloaded_error"')) {
    return true
  }

  // Note this is not a standard header.
  const shouldRetryHeader = error.headers?.get('x-should-retry')

  // If the server explicitly says whether or not to retry, obey.
  // For Max and Pro users, should-retry is true, but in several hours, so we shouldn't.
  // Enterprise users can retry because they typically use PAYG instead of rate limits.
  if (
    shouldRetryHeader === 'true' &&
    (!isClaudeAISubscriber() || isEnterpriseSubscriber())
  ) {
    return true
  }

  // Ants can ignore x-should-retry: false for 5xx server errors only.
  // For other status codes (401, 403, 400, 429, etc.), respect the header.
  if (shouldRetryHeader === 'false') {
    const is5xxError = error.status !== undefined && error.status >= 500
    if (!(process.env.USER_TYPE === 'ant' && is5xxError)) {
      return false
    }
  }

  if (error instanceof APIConnectionError) {
    return true
  }

  if (!error.status) return false

  // Retry on request timeouts.
  if (error.status === 408) return true

  // Retry on lock timeouts.
  if (error.status === 409) return true

  // Retry on rate limits, but not for ClaudeAI Subscription users
  // Enterprise users can retry because they typically use PAYG instead of rate limits
  if (error.status === 429) {
    if (isQuotaExhausted(error)) return false
    return !isClaudeAISubscriber() || isEnterpriseSubscriber()
  }

  // Clear API key cache on 401 and allow retry.
  // OAuth token handling is done in the main retry loop via handleOAuth401Error.
  if (error.status === 401) {
    clearApiKeyHelperCache()
    return true
  }

  // Retry on 403 "token revoked" (same refresh logic as 401, see above)
  if (isOAuthTokenRevokedError(error)) {
    return true
  }

  // Retry internal errors.
  if (error.status && error.status >= 500) return true

  return false
}

export function getDefaultMaxRetries(): number {
  const openClaudeMaxRetries = process.env.OPENCLAUDE_MAX_RETRIES
  if (openClaudeMaxRetries) {
    return validateRetryAttemptsEnvVar(
      'OPENCLAUDE_MAX_RETRIES',
      openClaudeMaxRetries,
    )
  }

  const legacyMaxRetries = process.env.CLAUDE_CODE_MAX_RETRIES
  if (legacyMaxRetries) {
    logForDebugging(
      'CLAUDE_CODE_MAX_RETRIES is deprecated; use OPENCLAUDE_MAX_RETRIES instead',
    )
    return validateRetryAttemptsEnvVar(
      'CLAUDE_CODE_MAX_RETRIES',
      legacyMaxRetries,
    )
  }

  return DEFAULT_MAX_RETRIES
}

export function getDefaultRetryDelayMs(): number {
  return validateBoundedIntEnvVar(
    'OPENCLAUDE_RETRY_DELAY_MS',
    process.env.OPENCLAUDE_RETRY_DELAY_MS,
    DEFAULT_RETRY_DELAY_MS,
    MAX_RETRY_DELAY_BASE_MS,
  ).effective
}
function getMaxRetries(options: RetryOptions): number {
  return options.maxRetries ?? getDefaultMaxRetries()
}

function validateRetryAttemptsEnvVar(
  envVarName: string,
  value: string | undefined,
): number {
  if (!value) {
    return DEFAULT_MAX_RETRIES
  }
  const normalized = value.trim()
  const isDecimalInteger = /^\d+$/.test(normalized)
  const parsed = isDecimalInteger ? Number(normalized) : Number.NaN
  if (!Number.isFinite(parsed)) {
    logForDebugging(
      `${envVarName} Invalid value "${value}" (using default: ${DEFAULT_MAX_RETRIES})`,
    )
    return DEFAULT_MAX_RETRIES
  }
  if (parsed > MAX_CONFIGURABLE_RETRIES) {
    logForDebugging(
      `${envVarName} Capped from ${parsed} to ${MAX_CONFIGURABLE_RETRIES}`,
    )
    return MAX_CONFIGURABLE_RETRIES
  }
  return parsed
}

const DEFAULT_FAST_MODE_FALLBACK_HOLD_MS = 30 * 60 * 1000 // 30 minutes
const SHORT_RETRY_THRESHOLD_MS = 20 * 1000 // 20 seconds
const MIN_COOLDOWN_MS = 10 * 60 * 1000 // 10 minutes

function getRetryAfterMs(error: APIError): number | null {
  const retryAfter = getRetryAfter(error)
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10)
    if (!isNaN(seconds)) {
      return seconds * 1000
    }
  }
  return null
}

/**
 * Parse OpenAI-style relative duration strings into milliseconds.
 * Formats: "1s", "6m0s", "1h30m0s", "500ms", "2m"
 * Returns null for unrecognized formats.
 */
export function parseOpenAIDuration(s: string): number | null {
  if (!s) return null
  // Try matching hours/minutes/seconds/milliseconds components
  const re = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+)s)?(?:(\d+)ms)?$/
  const m = re.exec(s)
  if (!m || m[0] === '') return null
  const h = parseInt(m[1] ?? '0', 10)
  const min = parseInt(m[2] ?? '0', 10)
  const sec = parseInt(m[3] ?? '0', 10)
  const ms = parseInt(m[4] ?? '0', 10)
  const total = h * 3_600_000 + min * 60_000 + sec * 1_000 + ms
  return total > 0 ? total : null
}

export function getRateLimitResetDelayMs(error: APIError): number | null {
  const provider = getAPIProvider()

  if (provider === 'firstParty') {
    const resetHeader = error.headers?.get?.('anthropic-ratelimit-unified-reset')
    if (!resetHeader) return null
    const resetUnixSec = Number(resetHeader)
    if (!Number.isFinite(resetUnixSec)) return null
    const delayMs = resetUnixSec * 1000 - Date.now()
    if (delayMs <= 0) return null
    return Math.min(delayMs, PERSISTENT_RESET_CAP_MS)
  }

  if (provider === 'openai' || provider === 'codex' || provider === 'github') {
    const reqHeader = error.headers?.get?.('x-ratelimit-reset-requests')
    const tokHeader = error.headers?.get?.('x-ratelimit-reset-tokens')
    const reqMs = reqHeader ? parseOpenAIDuration(reqHeader) : null
    const tokMs = tokHeader ? parseOpenAIDuration(tokHeader) : null
    if (reqMs === null && tokMs === null) return null
    // Use the larger delay so we don't retry before both limits reset
    const delayMs = Math.max(reqMs ?? 0, tokMs ?? 0)
    return Math.min(delayMs, PERSISTENT_RESET_CAP_MS)
  }

  // bedrock, vertex, foundry, gemini — no standard reset header
  return null
}

export { shouldRetry }
