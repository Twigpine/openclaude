import type { PermissionMode } from '../../../utils/permissions/PermissionMode.js'
import type { SettingsJson } from '../../../utils/settings/types.js'
import { isModelAllowed } from '../../../utils/model/modelAllowlist.js'
import { getCanonicalName } from '../../../utils/model/model.js'
import { MODEL_COSTS } from '../../../utils/modelCost.js'
import { routeModel, type RoutingInput } from '../smartModelRouting.js'
import { readSmartRouting, type NormalizedSmartRouting } from './settings.js'
import { resolveSmartRoutingConfig } from './resolveConfig.js'

/**
 * Per-million input-token price for a model when it is in the first-party
 * pricing table, else `undefined` (third-party / gateway models have no known
 * price). Used for the "simple isn't cheaper" warning (U5) and to gate the
 * estimated-savings line (U6).
 */
export function getKnownInputCost(model: string): number | undefined {
  return MODEL_COSTS[getCanonicalName(model)]?.inputTokens
}

export { readSmartRouting, type NormalizedSmartRouting }
export { resolveSmartRoutingConfig } from './resolveConfig.js'

/** Resolve an agentModels key to its underlying model string, or return bare model ids unchanged. */
export function resolveSmartRoutingRoleModelString(
  key: string | undefined,
  settings: SettingsJson | null,
): string | undefined {
  if (!key) return undefined
  return settings?.agentModels?.[key]?.model ?? key
}

/**
 * Outcome of a per-turn routing decision.
 *
 * `routed: false` means the caller must use today's normal model resolution —
 * smart routing is disabled, misconfigured, disabled-for-session, or both roles
 * are outside the org allowlist. `justDisabledForSession` is set the first time
 * an allowlist conflict disables routing, so the caller emits one notice.
 */
export type TurnRoutingDecision =
  | { routed: false; justDisabledForSession?: boolean }
  | {
      routed: true
      model: string
      complexity: 'simple' | 'strong'
      reason: string
      /** The resolved strong model, for the routed-error fallback (U4). */
      strongModel: string
    }

/**
 * Whether a pinned route must be dropped because the active provider changed
 * since the route was pinned (a mid-turn provider-fallback swap). A model-only
 * route is keyed to the provider it resolved against, so replaying it at a new
 * endpoint would send an unknown model id (KTD6).
 */
export function shouldDropPinForProviderSwap(
  pinned: TurnRoutingDecision | undefined,
  pinnedProviderId: string | undefined,
  currentProviderId: string | undefined,
): boolean {
  return !!pinned && pinned.routed && currentProviderId !== pinnedProviderId
}

// Session-scoped disable set. Keyed by session id so a disable never leaks into
// an unrelated session in a long-lived host (gRPC/SDK) — a new session has a new
// id and is therefore never in the set. NOT a process-global boolean.
// Capped so a long-lived host with a persistent allowlist conflict can't grow it
// without bound; clearing is safe (a cleared session re-evaluates and re-disables).
const MAX_DISABLED_SESSIONS = 1024
const disabledSessions = new Set<string>()

function markSessionDisabled(sessionId: string): void {
  if (disabledSessions.size >= MAX_DISABLED_SESSIONS) disabledSessions.clear()
  disabledSessions.add(sessionId)
}

/** Clear the session-disable flag (e.g. on explicit `/smartroute enable`). */
export function clearSmartRoutingSessionDisable(sessionId: string | undefined): void {
  if (sessionId) disabledSessions.delete(sessionId)
}

/** Whether smart routing has been auto-disabled for this session (allowlist conflict). */
export function isSmartRoutingDisabledForSession(sessionId: string | undefined): boolean {
  return sessionId ? disabledSessions.has(sessionId) : false
}

export interface DecideTurnModelInput {
  settings: SettingsJson | null
  parentModel: string
  permissionMode?: PermissionMode
  input: RoutingInput
  sessionId?: string
  /** Set when the query loop belongs to a sub-agent rather than the main thread. */
  agentId?: string
}

/**
 * Decide the model for this user turn: resolve config, classify via `routeModel`,
 * then enforce the org allowlist by calling `isModelAllowed` directly and
 * unconditionally (NOT the change-gated `shouldEnforceModelAllowlist`, which
 * short-circuits when the routed model equals the session model). A disallowed
 * routed model is coerced to strong; if strong is also disallowed, routing is
 * disabled for the session and the caller falls back to today's resolution.
 *
 * Sub-agents are never routed. Their prompt is not a user turn: the parent
 * turn's decision already holds for its Agent tool call, and the sub-agent's
 * model comes from agentRouting or its definition. Pinning here would
 * overwrite that model with the classifier's pick.
 */
export function decideTurnModel({
  settings,
  parentModel,
  permissionMode,
  input,
  sessionId,
  agentId,
}: DecideTurnModelInput): TurnRoutingDecision {
  if (agentId) return { routed: false }
  if (isSmartRoutingDisabledForSession(sessionId)) return { routed: false }

  const config = resolveSmartRoutingConfig({ settings, parentModel, permissionMode })
  if (!config.enabled) return { routed: false }

  const decision = routeModel(input, config)

  let model = decision.model
  let complexity = decision.complexity
  if (!isModelAllowed(model)) {
    // Coerce a disallowed model to strong.
    model = config.strongModel
    complexity = 'strong'
    if (!isModelAllowed(model)) {
      // Both roles outside the allowlist — disable for the session and let the
      // caller use today's (allowlist-clean) resolution. Notice fires once per
      // session; with no sessionId we can't dedupe, so stay silent rather than
      // emit the notice on every turn.
      const first = sessionId ? !disabledSessions.has(sessionId) : false
      if (sessionId) markSessionDisabled(sessionId)
      return first ? { routed: false, justDisabledForSession: true } : { routed: false }
    }
  }

  return { routed: true, model, complexity, reason: decision.reason, strongModel: config.strongModel }
}

/**
 * Whether a routed model-call error is worth retrying on the strong model.
 * 400/401/403 (bad request, auth, permission) are about the request itself and
 * a different model won't fix them, so they propagate. Everything else retries,
 * including 404 and 429 by design: the fallback switches to a *different* model
 * (strong), so a 404 ("simple model not found", e.g. a typo'd role) or a 429
 * (the simple model rate-limited) is recovered by completing the turn on strong
 * rather than failing it. Callers must check abort separately (an aborted turn
 * must not retry).
 */
export function isRetryableRoutedModelError(err: unknown): boolean {
  const status =
    (err as { status?: number })?.status ?? (err as { statusCode?: number })?.statusCode
  if (status === 400 || status === 401 || status === 403) return false
  return true
}

/** Session-level routing tally, rendered by the cost/status surfaces (U6). */
export interface RoutingTally {
  simple: number
  strong: number
  /** Simple-routed turns that fell back to strong on a routed-model error. */
  escalations: number
}

const tally: RoutingTally = { simple: 0, strong: 0, escalations: 0 }

/** Record a pinned routing decision (once per user turn). */
export function recordRoutingDecision(complexity: 'simple' | 'strong'): void {
  tally[complexity]++
}

/** Record a simple→strong fallback escalation (U4). */
export function recordRoutingEscalation(): void {
  tally.escalations++
}

export function getRoutingTally(): RoutingTally {
  return { ...tally }
}

export function resetRoutingTally(): void {
  tally.simple = 0
  tally.strong = 0
  tally.escalations = 0
}

/**
 * Format the session routing summary for `/cost`. Returns null when nothing has
 * been routed. The split and escalation count are always shown (the falsifiable
 * core); the estimated-savings line is gated on first-party pricing for both
 * roles and is annotated as unavailable when either price is unknown.
 */
export function formatRoutingSummary(
  t: RoutingTally,
  pricing?: { simpleInputCost?: number; strongInputCost?: number },
): string | null {
  if (t.simple + t.strong === 0) return null
  const head =
    `Smart routing: ${t.simple} simple, ${t.strong} strong` +
    (t.escalations ? `, ${t.escalations} escalated to strong` : '')
  const s = pricing?.simpleInputCost
  const st = pricing?.strongInputCost
  let savings: string
  if (s != null && st != null && st > 0) {
    savings =
      s < st
        ? `  Estimated (first-party reference pricing): simple turns use a model priced ~${Math.round((1 - s / st) * 100)}% lower per input token. Your provider/gateway/account may bill differently; actual savings depend on token mix and cache.`
        : '  Estimated (first-party reference pricing): simple model is not cheaper than strong, so no savings expected. Your provider may bill differently.'
  } else {
    savings = '  Estimated savings unavailable: one or both models have no first-party reference pricing.'
  }
  return `${head}\n${savings}`
}

/**
 * Build the `/cost` routing summary from the live tally and the configured
 * roles' first-party pricing.
 */
export function getRoutingSummaryForDisplay(settings: SettingsJson | null): string | null {
  const sr = readSmartRouting(settings)
  const simpleModelId = resolveSmartRoutingRoleModelString(sr.simpleModel, settings)
  const strongModelId = resolveSmartRoutingRoleModelString(sr.strongModel, settings)
  return formatRoutingSummary(getRoutingTally(), {
    simpleInputCost: simpleModelId ? getKnownInputCost(simpleModelId) : undefined,
    strongInputCost: strongModelId ? getKnownInputCost(strongModelId) : undefined,
  })
}

/** Minimal message shape for turn counting — avoids importing heavy message types. */
interface TurnCountMessage {
  type: string
  isMeta?: boolean
  message?: { content?: unknown }
}

function isToolResultCarrier(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      block =>
        typeof block === 'object' && block !== null && (block as { type?: string }).type === 'tool_result',
    )
  )
}

function isRealUserMessage(m: TurnCountMessage): boolean {
  return m.type === 'user' && !m.isMeta && !isToolResultCarrier(m.message?.content)
}

/**
 * Count real user turns in the conversation: user-role messages that are neither
 * `isMeta` (injected nudges/system reminders) nor tool-result carriers
 * (continuation passes). This is the session-level turn number for
 * `RoutingInput.turnNumber` — distinct from the loop's per-`query()` `turnCount`.
 */
export function deriveUserTurnNumber(messages: readonly TurnCountMessage[]): number {
  let count = 0
  for (const m of messages) {
    if (isRealUserMessage(m)) count++
  }
  return count
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(
        block => typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text',
      )
      .map(block => (block as { text?: string }).text ?? '')
      .join('\n')
  }
  return ''
}

/** Whether the most recent real user turn includes image/document or other non-text content. */
export function latestUserMessageHasNonTextContent(messages: readonly TurnCountMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!isRealUserMessage(m)) continue
    const content = m.message?.content
    return Array.isArray(content) && content.some(
      block => !(typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text'),
    )
  }
  return false
}

/** Text of the most recent real user message (for `RoutingInput.userText`). */
export function extractLatestUserText(messages: readonly TurnCountMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (isRealUserMessage(m)) return textOfContent(m.message?.content)
  }
  return ''
}
