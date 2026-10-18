import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import chalk from 'chalk'
import {
  extractCacheMetrics,
  resolveCacheProvider,
} from './services/api/cacheMetrics.js'
import {
  recordRequest as recordCacheRequest,
  resetSessionCacheStats,
} from './services/api/cacheStatsTracker.js'
import { getAPIProvider, isGithubNativeAnthropicMode } from './utils/model/providers.js'
import { getRoutingSummaryForDisplay, resetRoutingTally } from './services/api/smartRouting/index.js'
import { getSettings_DEPRECATED } from './utils/settings/settings.js'
import {
  addToTotalCostState,
  addToTotalLinesChanged,
  getModelUsage,
  getSdkBetas,
  getSessionId,
  getTotalAPIDuration,
  getTotalAPIDurationWithoutRetries,
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalCostUSD,
  getTotalDuration,
  getTotalInputTokens,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalOutputTokens,
  getTotalToolDuration,
  getTotalWebSearchRequests,
  getUsageForModel,
  hasUnknownModelCost,
  resetCostState as baseResetCostState,
  resetStateForTests,
  setCostStateForRestore,
  setHasUnknownModelCost,
} from './bootstrap/state.js'
import type { ModelUsage } from './entrypoints/agentSdkTypes.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from './services/analytics/index.js'
import { getAdvisorUsage } from './utils/advisor.js'
import {
  getCurrentProjectConfig,
  saveCurrentProjectConfig,
} from './utils/config.js'
import {
  getContextWindowForModel,
  getModelMaxOutputTokens,
} from './utils/context.js'
import { isFastModeEnabled } from './utils/fastMode.js'
import { formatDuration, formatNumber } from './utils/format.js'
import type { FpsMetrics } from './utils/fpsTracker.js'
import { getCanonicalName } from './utils/model/model.js'
import { calculateUSDCost } from './utils/modelCost.js'
export {
  getTotalCostUSD as getTotalCost,
  getTotalDuration,
  getTotalAPIDuration,
  getTotalAPIDurationWithoutRetries,
  addToTotalLinesChanged,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalInputTokens,
  getTotalOutputTokens,
  getTotalCacheReadInputTokens,
  getTotalCacheCreationInputTokens,
  getTotalWebSearchRequests,
  formatCost,
  hasUnknownModelCost,
  resetStateForTests,
  setHasUnknownModelCost,
  getModelUsage,
  getUsageForModel,
}

/**
 * Wraps bootstrap's resetCostState() so /clear, /compact and session
 * switches zero the cache-stats tracker alongside the cost counters.
 * Exported under the same name so existing callers pick up the cache
 * reset without any call-site changes.
 */
export function resetCostState(): void {
  baseResetCostState()
  resetSessionCacheStats()
  // Keep the routing summary scoped to the same session window as the cost
  // block it renders beside — otherwise /cost shows stale cross-session counts.
  resetRoutingTally()
}

type StoredCostState = {
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  lastDuration: number | undefined
  modelUsage: { [modelName: string]: ModelUsage } | undefined
}

/**
 * Gets stored cost state from project config for a specific session.
 * Returns the cost data if the session ID matches, or undefined otherwise.
 * Use this to read costs BEFORE overwriting the config with saveCurrentSessionCosts().
 */
export function getStoredSessionCosts(
  sessionId: string,
): StoredCostState | undefined {
  const projectConfig = getCurrentProjectConfig()

  // Only return costs if this is the same session that was last saved
  if (projectConfig.lastSessionId !== sessionId) {
    return undefined
  }

  // Build model usage with context windows
  let modelUsage: { [modelName: string]: ModelUsage } | undefined
  if (projectConfig.lastModelUsage) {
    modelUsage = Object.fromEntries(
      Object.entries(projectConfig.lastModelUsage).map(([model, usage]) => [
        model,
        {
          ...usage,
          contextWindow: getContextWindowForModel(model, getSdkBetas()),
          maxOutputTokens: getModelMaxOutputTokens(model).default,
        },
      ]),
    )
  }

  return {
    totalCostUSD: projectConfig.lastCost ?? 0,
    totalAPIDuration: projectConfig.lastAPIDuration ?? 0,
    totalAPIDurationWithoutRetries:
      projectConfig.lastAPIDurationWithoutRetries ?? 0,
    totalToolDuration: projectConfig.lastToolDuration ?? 0,
    totalLinesAdded: projectConfig.lastLinesAdded ?? 0,
    totalLinesRemoved: projectConfig.lastLinesRemoved ?? 0,
    lastDuration: projectConfig.lastDuration,
    modelUsage,
  }
}

/**
 * Restores cost state from project config when resuming a session.
 * Only restores if the session ID matches the last saved session.
 * @returns true if cost state was restored, false otherwise
 */
export function restoreCostStateForSession(sessionId: string): boolean {
  const data = getStoredSessionCosts(sessionId)
  if (!data) {
    return false
  }
  setCostStateForRestore(data)
  return true
}

/**
 * Saves the current session's costs to project config.
 * Call this before switching sessions to avoid losing accumulated costs.
 */
export function saveCurrentSessionCosts(fpsMetrics?: FpsMetrics): void {
  saveCurrentProjectConfig(current => ({
    ...current,
    lastCost: getTotalCostUSD(),
    lastAPIDuration: getTotalAPIDuration(),
    lastAPIDurationWithoutRetries: getTotalAPIDurationWithoutRetries(),
    lastToolDuration: getTotalToolDuration(),
    lastDuration: getTotalDuration(),
    lastLinesAdded: getTotalLinesAdded(),
    lastLinesRemoved: getTotalLinesRemoved(),
    lastTotalInputTokens: getTotalInputTokens(),
    lastTotalOutputTokens: getTotalOutputTokens(),
    lastTotalCacheCreationInputTokens: getTotalCacheCreationInputTokens(),
    lastTotalCacheReadInputTokens: getTotalCacheReadInputTokens(),
    lastTotalWebSearchRequests: getTotalWebSearchRequests(),
    lastFpsAverage: fpsMetrics?.averageFps,
    lastFpsLow1Pct: fpsMetrics?.low1PctFps,
    lastModelUsage: Object.fromEntries(
      Object.entries(getModelUsage()).map(([model, usage]) => [
        model,
        {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
          webSearchRequests: usage.webSearchRequests,
          costUSD: usage.costUSD,
        },
      ]),
    ),
    lastSessionId: getSessionId(),
  }))
}

function formatCost(cost: number, maxDecimalPlaces: number = 4): string {
  return `$${cost > 0.5 ? round(cost, 100).toFixed(2) : cost.toFixed(maxDecimalPlaces)}`
}

function formatModelUsage(): string {
  const modelUsageMap = getModelUsage()
  if (Object.keys(modelUsageMap).length === 0) {
    return 'Usage:                 0 input, 0 output'
  }

  // Accumulate usage by short name. Null-prototype so an unrecognised custom
  // provider id that canonicalizes to `__proto__` / `constructor` becomes an
  // ordinary own key: on a plain object the truthiness check below would read an
  // inherited Object.prototype member, skip initialization, and mutate it (for
  // `__proto__`, polluting Object.prototype process-wide), while dropping the
  // model from the displayed breakdown.
  const usageByShortName: { [shortName: string]: ModelUsage } = Object.create(
    null,
  ) as { [shortName: string]: ModelUsage }
  for (const [model, usage] of Object.entries(modelUsageMap)) {
    const shortName = getCanonicalName(model)
    if (!Object.hasOwn(usageByShortName, shortName)) {
      usageByShortName[shortName] = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0,
        contextWindow: 0,
        maxOutputTokens: 0,
      }
    }
    const accumulated = usageByShortName[shortName]
    accumulated.inputTokens += usage.inputTokens
    accumulated.outputTokens += usage.outputTokens
    accumulated.cacheReadInputTokens += usage.cacheReadInputTokens
    accumulated.cacheCreationInputTokens += usage.cacheCreationInputTokens
    accumulated.webSearchRequests += usage.webSearchRequests
    accumulated.costUSD += usage.costUSD
  }

  let result = 'Usage by model:'
  for (const [shortName, usage] of Object.entries(usageByShortName)) {
    let usageString =
      `  ${formatNumber(usage.inputTokens)} input, ` +
      `${formatNumber(usage.outputTokens)} output`
    if (usage.cacheReadInputTokens > 0) {
      usageString += `, ${formatNumber(usage.cacheReadInputTokens)} cache read`
    }
    if (usage.cacheCreationInputTokens > 0) {
      usageString += `, ${formatNumber(usage.cacheCreationInputTokens)} cache write`
    }
    if (usage.webSearchRequests > 0) {
      usageString += `, ${formatNumber(usage.webSearchRequests)} web search`
    }
    usageString += ` (${formatCost(usage.costUSD)})`
    result += `\n` + `${shortName}:`.padStart(21) + usageString
  }
  return result
}

function formatTokenBar(label: string, tokens: number, maxTokens: number, colorFn: (text: string) => string): string {
  const barWidth = 20
  const ratio = maxTokens > 0 ? Math.min(tokens / maxTokens, 1) : 0
  const filled = Math.round(ratio * barWidth)
  const empty = barWidth - filled
  const bar = colorFn('█'.repeat(filled)) + chalk.gray('░'.repeat(empty))
  return `  ${label.padEnd(14)} ${bar} ${formatNumber(tokens)}`
}

export function formatTotalCost(): string {
  const costDisplay =
    formatCost(getTotalCostUSD()) +
    (hasUnknownModelCost()
      ? ' (costs may be inaccurate due to usage of unknown models)'
      : '')

  const modelUsageDisplay = formatModelUsage()
  const totalInput = getTotalInputTokens()
  const totalOutput = getTotalOutputTokens()
  const totalCacheRead = getTotalCacheReadInputTokens()
  const totalCacheCreation = getTotalCacheCreationInputTokens()
  const totalTokens = totalInput + totalOutput + totalCacheRead + totalCacheCreation
  const tokenSection = totalTokens > 0 ? (() => {
    const maxTokens = Math.max(totalInput, totalOutput, totalCacheRead, totalCacheCreation, 1)
    const tokenBars = [
      formatTokenBar('Input tokens', totalInput, maxTokens, chalk.blue),
      formatTokenBar('Output tokens', totalOutput, maxTokens, chalk.green),
      totalCacheRead > 0 ? formatTokenBar('Cache read', totalCacheRead, maxTokens, chalk.cyan) : null,
      totalCacheCreation > 0 ? formatTokenBar('Cache write', totalCacheCreation, maxTokens, chalk.yellow) : null,
    ].filter(Boolean).join('\n')
    return `\nToken usage:\n${tokenBars}`
  })() : ''

  const statsBlock = chalk.dim(
    `Total cost:            ${costDisplay}\n` +
      `Total duration (API):  ${formatDuration(getTotalAPIDuration())}
Total duration (wall): ${formatDuration(getTotalDuration())}
Total code changes:    ${getTotalLinesAdded()} ${getTotalLinesAdded() === 1 ? 'line' : 'lines'} added, ${getTotalLinesRemoved()} ${getTotalLinesRemoved() === 1 ? 'line' : 'lines'} removed`,
  )

  const routingSummary = getRoutingSummaryForDisplay(getSettings_DEPRECATED())
  const routingSection = routingSummary ? `\n\n${chalk.dim(routingSummary)}` : ''

  return `${statsBlock}${tokenSection}

${modelUsageDisplay}${routingSection}`
}

function round(number: number, precision: number): number {
  return Math.round(number * precision) / precision
}

// Env-gated verbose token usage log. Treated as a boolean regardless of
// value specifics — any truthy-ish string switches it on. `verbose` is the
// documented keyword but we accept `1`/`true` for ergonomic parity with
// other OPENCLAUDE_* flags.
function shouldLogTokenUsageVerbose(): boolean {
  const v = (process.env.OPENCLAUDE_LOG_TOKEN_USAGE ?? '').trim().toLowerCase()
  if (!v) return false
  return v !== '0' && v !== 'false' && v !== 'off'
}

function addToTotalModelUsage(
  cost: number,
  usage: Usage,
  model: string,
): ModelUsage {
  const modelUsage = getUsageForModel(model) ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow: 0,
    maxOutputTokens: 0,
  }

  modelUsage.inputTokens += usage.input_tokens
  modelUsage.outputTokens += usage.output_tokens
  modelUsage.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0
  modelUsage.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0
  modelUsage.webSearchRequests +=
    usage.server_tool_use?.web_search_requests ?? 0
  modelUsage.costUSD += cost
  modelUsage.contextWindow = getContextWindowForModel(model, getSdkBetas())
  modelUsage.maxOutputTokens = getModelMaxOutputTokens(model).default
  return modelUsage
}

export function addToTotalSessionCost(
  cost: number,
  usage: Usage,
  model: string,
): number {
  const modelUsage = addToTotalModelUsage(cost, usage, model)
  addToTotalCostState(cost, modelUsage, model)

  // Record normalized cache metrics for REPL display + /cache-stats.
  // Resolved from the current process provider — at this point `usage` has
  // already been Anthropic-shaped by the shim layer, so we feed the
  // corresponding bucket (anthropic / copilot-claude / openai-like) to the
  // extractor. For providers that genuinely don't report cache data
  // (vanilla Copilot, Ollama), resolveCacheProvider steers us to
  // supported:false so the UI shows "N/A" instead of lying with "0%".
  const cacheProvider = resolveCacheProvider(getAPIProvider(), {
    githubNativeAnthropic: isGithubNativeAnthropicMode(model),
    openAiBaseUrl: process.env.OPENAI_BASE_URL ?? process.env.OPENAI_API_BASE,
  })
  const cacheMetrics = extractCacheMetrics(
    usage as unknown as Record<string, unknown>,
    cacheProvider,
  )
  recordCacheRequest(cacheMetrics, model)

  // Opt-in structured per-request debug log on stderr. Power-user knob, not
  // shown in the REPL — complements CLAUDE_CODE_ENABLE_TOKEN_USAGE_ATTACHMENT
  // (which is model-facing). Any truthy value except "0"/"false" enables it.
  if (shouldLogTokenUsageVerbose()) {
    process.stderr.write(
      JSON.stringify({
        tag: 'openclaude.tokenUsage',
        model,
        provider: cacheProvider,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        cache_supported: cacheMetrics.supported,
        cache_hit_rate: cacheMetrics.hitRate,
        cost_usd: cost,
      }) + '\n',
    )
  }

  const attrs =
    isFastModeEnabled() && usage.speed === 'fast'
      ? { model, speed: 'fast' }
      : { model }

  let totalCost = cost
  for (const advisorUsage of getAdvisorUsage(usage)) {
    const advisorCost = calculateUSDCost(advisorUsage.model, advisorUsage)
    logEvent('tengu_advisor_tool_token_usage', {
      advisor_model:
        advisorUsage.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      input_tokens: advisorUsage.input_tokens,
      output_tokens: advisorUsage.output_tokens,
      cache_read_input_tokens: advisorUsage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens:
        advisorUsage.cache_creation_input_tokens ?? 0,
      cost_usd_micros: Math.round(advisorCost * 1_000_000),
    })
    totalCost += addToTotalSessionCost(
      advisorCost,
      advisorUsage,
      advisorUsage.model,
    )
  }
  return totalCost
}
