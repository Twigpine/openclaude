import { createHash } from 'crypto'
import { statSync } from 'fs'
import { join, resolve } from 'path'
import { HOOK_EVENTS } from 'src/entrypoints/agentSdkTypes.js'
import { getOriginalCwd } from '../bootstrap/state.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { isPolicyAllowed } from '../services/policyLimits/index.js'
import { logForDebugging } from './debug.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { isEnvTruthy } from './envUtils.js'
import { getErrnoCode } from './errors.js'
import { readFileSync } from './fileRead.js'
import { safeParseJSON } from './json.js'
import { readTeamFileAsync } from './swarm/teamHelpers.js'
import { getAgentName, getTeamName, getTeammateColor } from './teammate.js'
import { writeToMailbox } from './teammateMailbox.js'
import { logOTelEvent } from './telemetry/events.js'
import { z } from 'zod/v4'

type HookEvent = (typeof HOOK_EVENTS)[number]

const HOOK_CHAINS_CONFIG_ENV_PATH = 'CLAUDE_CODE_HOOK_CHAINS_CONFIG_PATH'
const HOOK_CHAINS_ENABLED_ENV = 'CLAUDE_CODE_ENABLE_HOOK_CHAINS'
const DEFAULT_HOOK_CHAINS_RELATIVE_PATH = join('.openclaude', 'hook-chains.json')
const DEFAULT_MAX_CHAIN_DEPTH = 2
const DEFAULT_RULE_COOLDOWN_MS = 30_000
const DEFAULT_DEDUP_WINDOW_MS = 30_000
const MAX_GUARD_WINDOW_MS = 24 * 60 * 60 * 1000
const CONFIG_CACHE_MAX_AGE_MS = 5 * 60 * 1000
const MAX_RULE_COOLDOWN_ENTRIES = 5_000
const MAX_DEDUP_ENTRIES = 20_000

const HookChainOutcomeSchema = z.enum(['success', 'failed', 'timeout', 'unknown'])
const HookChainConditionSchema = z
  .object({
    toolNames: z.array(z.string().min(1)).optional(),
    taskStatuses: z.array(z.string().min(1)).optional(),
    errorIncludes: z.array(z.string().min(1)).optional(),
    eventFieldEquals: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional(),
  })
  .optional()

const HookChainActionBaseSchema = z.object({
  id: z.string().min(1).optional(),
  enabled: z.boolean().default(true).optional(),
  dedupWindowMs: z
    .number()
    .int()
    .min(0)
    .max(MAX_GUARD_WINDOW_MS)
    .optional(),
})

const SpawnFallbackAgentActionSchema = HookChainActionBaseSchema.extend({
  type: z.literal('spawn_fallback_agent'),
  description: z.string().min(1).optional(),
  promptTemplate: z.string().min(1).optional(),
  agentType: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
})

const NotifyTeamActionSchema = HookChainActionBaseSchema.extend({
  type: z.literal('notify_team'),
  teamName: z.string().min(1).optional(),
  recipients: z.array(z.string().min(1)).optional(),
  summary: z.string().min(1).optional(),
  messageTemplate: z.string().min(1).optional(),
})

const WarmRemoteCapacityActionSchema = HookChainActionBaseSchema.extend({
  type: z.literal('warm_remote_capacity'),
  createDefaultEnvironmentIfMissing: z.boolean().optional(),
})

const HookChainActionSchema = z.discriminatedUnion('type', [
  SpawnFallbackAgentActionSchema,
  NotifyTeamActionSchema,
  WarmRemoteCapacityActionSchema,
])

const HookChainRuleSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(true).optional(),
  trigger: z
    .object({
      event: z.enum(HOOK_EVENTS),
      outcome: HookChainOutcomeSchema.optional(),
      outcomes: z.array(HookChainOutcomeSchema).nonempty().optional(),
    })
    .superRefine((value, ctx) => {
      if (value.outcome && value.outcomes) {
        ctx.addIssue({
          code: 'custom',
          message: 'Use either trigger.outcome or trigger.outcomes, not both.',
          path: ['outcomes'],
        })
      }
    }),
  condition: HookChainConditionSchema,
  cooldownMs: z.number().int().min(0).max(MAX_GUARD_WINDOW_MS).optional(),
  dedupWindowMs: z.number().int().min(0).max(MAX_GUARD_WINDOW_MS).optional(),
  maxDepth: z.number().int().min(0).max(10).optional(),
  actions: z.array(HookChainActionSchema).min(1),
})

const HookChainsConfigSchema = z.object({
  version: z.literal(1).default(1),
  enabled: z.boolean().default(true),
  maxChainDepth: z.number().int().min(1).max(10).default(DEFAULT_MAX_CHAIN_DEPTH),
  defaultCooldownMs: z
    .number()
    .int()
    .min(0)
    .max(MAX_GUARD_WINDOW_MS)
    .default(DEFAULT_RULE_COOLDOWN_MS),
  defaultDedupWindowMs: z
    .number()
    .int()
    .min(0)
    .max(MAX_GUARD_WINDOW_MS)
    .default(DEFAULT_DEDUP_WINDOW_MS),
  rules: z.array(HookChainRuleSchema).default([]),
})

const HookChainsConfigFileSchema = z.union([
  z.object({ hookChains: HookChainsConfigSchema }),
  HookChainsConfigSchema,
])

export type HookChainOutcome = z.infer<typeof HookChainOutcomeSchema>
export type HookChainCondition = z.infer<
  NonNullable<typeof HookChainConditionSchema>
>
export type SpawnFallbackAgentAction = z.infer<
  typeof SpawnFallbackAgentActionSchema
>
export type NotifyTeamAction = z.infer<typeof NotifyTeamActionSchema>
export type WarmRemoteCapacityAction = z.infer<
  typeof WarmRemoteCapacityActionSchema
>
export type HookChainAction = z.infer<typeof HookChainActionSchema>
export type HookChainRule = z.infer<typeof HookChainRuleSchema>
export type HookChainsConfig = z.infer<typeof HookChainsConfigSchema>

export type HookChainEventContext = {
  eventName: HookEvent
  outcome: HookChainOutcome
  payload?: Record<string, unknown>
  occurredAt?: number
}

export type SpawnFallbackAgentRequest = {
  ruleId: string
  eventName: HookEvent
  outcome: HookChainOutcome
  description: string
  prompt: string
  agentType?: string
  model?: string
  runInBackground: true
  payload: Record<string, unknown>
  signal?: AbortSignal
}

export type SpawnFallbackAgentResponse = {
  launched: boolean
  agentId?: string
  reason?: string
}

export type HookChainRuntimeContext = {
  signal?: AbortSignal
  chainDepth?: number
  dedupScope?: string
  teamName?: string
  senderName?: string
  senderColor?: string
  onSpawnFallbackAgent?: (
    request: SpawnFallbackAgentRequest,
  ) => Promise<SpawnFallbackAgentResponse>
  onNotifyTeam?: (request: {
    ruleId: string
    eventName: HookEvent
    outcome: HookChainOutcome
    teamName: string
    recipients: string[]
    summary?: string
    message: string
    payload: Record<string, unknown>
    signal?: AbortSignal
  }) => Promise<{ sent: boolean; reason?: string; recipientCount?: number }>
  onWarmRemoteCapacity?: (request: {
    ruleId: string
    eventName: HookEvent
    outcome: HookChainOutcome
    payload: Record<string, unknown>
    signal?: AbortSignal
    createDefaultEnvironmentIfMissing?: boolean
  }) => Promise<{
    warmed: boolean
    environmentId?: string
    reason?: string
  }>
}

export type HookChainsConfigLoadResult = {
  config: HookChainsConfig
  path: string
  exists: boolean
  fromCache: boolean
  error?: string
}

export type HookChainRuleMatch = {
  rule: HookChainRule
}

export type HookChainActionDispatchResult = {
  ruleId: string
  actionType: HookChainAction['type']
  actionId?: string
  status: 'executed' | 'skipped' | 'failed'
  reason?: string
  detail?: string
}

export type HookChainsDispatchResult = {
  enabled: boolean
  configPath: string
  fromCache: boolean
  evaluatedRuleCount: number
  matchedRuleIds: string[]
  actionResults: HookChainActionDispatchResult[]
}

type HookChainActionExecutionResult = {
  status: 'executed' | 'skipped' | 'failed'
  reason?: string
  detail?: string
}

type ConfigCacheState = {
  path: string
  mtimeMs: number
  size: number
  loadedAtMs: number
  config: HookChainsConfig
}

let configCache: ConfigCacheState | null = null
const ruleCooldownUntil = new Map<string, number>()
const dedupKeyUntil = new Map<string, number>()

function asAnalyticsString(
  value: string,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return value as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

function cloneConfig(config: HookChainsConfig): HookChainsConfig {
  return structuredClone(config)
}

function makeDisabledConfig(): HookChainsConfig {
  return {
    version: 1,
    enabled: false,
    maxChainDepth: DEFAULT_MAX_CHAIN_DEPTH,
    defaultCooldownMs: DEFAULT_RULE_COOLDOWN_MS,
    defaultDedupWindowMs: DEFAULT_DEDUP_WINDOW_MS,
    rules: [],
  }
}

function isHookChainsEnabled(): boolean {
  const raw = process.env[HOOK_CHAINS_ENABLED_ENV]
  if (raw === undefined) {
    return false
  }
  return isEnvTruthy(raw)
}

function getConfigPath(pathOverride?: string): string {
  const configuredPath = pathOverride || process.env[HOOK_CHAINS_CONFIG_ENV_PATH]

  if (configuredPath) {
    return resolve(getSafeOriginalCwd(), configuredPath)
  }

  return join(getSafeOriginalCwd(), DEFAULT_HOOK_CHAINS_RELATIVE_PATH)
}

function getSafeOriginalCwd(): string {
  try {
    return getOriginalCwd()
  } catch {
    return process.cwd()
  }
}

function getRuleOutcomes(rule: HookChainRule): HookChainOutcome[] | undefined {
  if (rule.trigger.outcomes) {
    return rule.trigger.outcomes
  }
  if (rule.trigger.outcome) {
    return [rule.trigger.outcome]
  }
  return undefined
}

function normalizePayload(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return payload ?? {}
}

function readStringField(
  payload: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.length > 0) {
      return value
    }
  }
  return undefined
}

function getValueByPath(obj: Record<string, unknown>, path: string): unknown {
  const segments = path.split('.').filter(Boolean)
  let cursor: unknown = obj
  for (const segment of segments) {
    if (typeof cursor !== 'object' || cursor === null) {
      return undefined
    }
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

function evaluateCondition(
  condition: HookChainCondition | undefined,
  event: HookChainEventContext,
): boolean {
  if (!condition) {
    return true
  }

  const payload = normalizePayload(event.payload)

  if (condition.toolNames && condition.toolNames.length > 0) {
    const toolName = readStringField(payload, ['tool_name', 'toolName'])
    if (!toolName || !condition.toolNames.includes(toolName)) {
      return false
    }
  }

  if (condition.taskStatuses && condition.taskStatuses.length > 0) {
    const taskStatus = readStringField(payload, [
      'task_status',
      'taskStatus',
      'status',
    ])
    if (!taskStatus || !condition.taskStatuses.includes(taskStatus)) {
      return false
    }
  }

  if (condition.errorIncludes && condition.errorIncludes.length > 0) {
    const errorText =
      readStringField(payload, ['error', 'reason', 'message']) ?? ''

    const found = condition.errorIncludes.some(fragment =>
      errorText.toLowerCase().includes(fragment.toLowerCase()),
    )

    if (!found) {
      return false
    }
  }

  if (condition.eventFieldEquals) {
    // Dot-path lookups allow rules to match nested event payload fields
    // without introducing a second, custom expression language.
    for (const [fieldPath, expected] of Object.entries(
      condition.eventFieldEquals,
    )) {
      const actual = getValueByPath(payload, fieldPath)
      if (actual !== expected) {
        return false
      }
    }
  }

  return true
}

export function evaluateHookChainRules(
  rules: HookChainRule[],
  event: HookChainEventContext,
): HookChainRuleMatch[] {
  const matches: HookChainRuleMatch[] = []

  for (const rule of rules) {
    if (rule.enabled === false) {
      continue
    }

    if (rule.trigger.event !== event.eventName) {
      continue
    }

    const outcomes = getRuleOutcomes(rule)
    if (outcomes && outcomes.length > 0 && !outcomes.includes(event.outcome)) {
      continue
    }

    if (!evaluateCondition(rule.condition, event)) {
      continue
    }

    matches.push({ rule })
  }

  return matches
}

export function loadHookChainsConfig(options?: {
  pathOverride?: string
  forceReload?: boolean
}): HookChainsConfigLoadResult {
  const path = getConfigPath(options?.pathOverride)

  if (!isHookChainsEnabled()) {
    return {
      config: makeDisabledConfig(),
      path,
      exists: false,
      fromCache: false,
    }
  }

  let stats: { mtimeMs: number; size: number } | undefined

  try {
    const stat = statSync(path)
    stats = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    }
  } catch (error) {
    const code = getErrnoCode(error)
    if (code !== 'ENOENT') {
      logForDebugging(
        `[hook-chains] Failed to stat config at ${path}: ${String(error)}`,
      )
    } else if (configCache?.path === path) {
      // Clear stale cache if config disappears.
      configCache = null
    }
    return {
      config: makeDisabledConfig(),
      path,
      exists: false,
      fromCache: false,
    }
  }

  if (
    !options?.forceReload &&
    configCache &&
    configCache.path === path &&
    configCache.mtimeMs === stats.mtimeMs &&
    configCache.size === stats.size &&
    Date.now() - configCache.loadedAtMs <= CONFIG_CACHE_MAX_AGE_MS
  ) {
    return {
      config: cloneConfig(configCache.config),
      path,
      exists: true,
      fromCache: true,
    }
  }

  let raw: string
  try {
    raw = readFileSync(path)
  } catch (error) {
    return {
      config: makeDisabledConfig(),
      path,
      exists: true,
      fromCache: false,
      error: `Failed to read hook chain config file: ${String(error)}`,
    }
  }

  const parsed = safeParseJSON(raw, false)

  if (!parsed) {
    const error = 'Invalid JSON in hook chain config file.'
    return {
      config: makeDisabledConfig(),
      path,
      exists: true,
      fromCache: false,
      error,
    }
  }

  const validation = HookChainsConfigFileSchema.safeParse(parsed)
  if (!validation.success) {
    const error = validation.error.issues
      .map(issue => issue.message)
      .join('; ')
    return {
      config: makeDisabledConfig(),
      path,
      exists: true,
      fromCache: false,
      error,
    }
  }

  const config =
    'hookChains' in validation.data
      ? validation.data.hookChains
      : validation.data

  configCache = {
    path,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    loadedAtMs: Date.now(),
    config,
  }

  return {
    config: cloneConfig(config),
    path,
    exists: true,
    fromCache: false,
  }
}

function stableNormalize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(item => stableNormalize(item, seen))
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]'
    }
    seen.add(value)

    const obj = value as Record<string, unknown>
    const normalized: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) {
      normalized[key] = stableNormalize(obj[key], seen)
    }

    return normalized
  }

  return String(value)
}

function stableFingerprint(value: unknown): string {
  try {
    return JSON.stringify(stableNormalize(value, new WeakSet<object>()))
  } catch {
    return '[unserializable]'
  }
}

function buildEventIdentity(event: HookChainEventContext): string {
  const payload = normalizePayload(event.payload)

  // Prefer stable IDs when present so dedup survives noisy payload fields.
  const coreIdentity = {
    eventName: event.eventName,
    outcome: event.outcome,
    taskId: readStringField(payload, ['task_id', 'taskId']),
    toolUseId: readStringField(payload, ['tool_use_id', 'toolUseId']),
    sessionId: readStringField(payload, ['session_id', 'sessionId']),
    error: readStringField(payload, ['error', 'reason']),
  }

  const digest = createHash('sha1')
    .update(stableFingerprint({ coreIdentity, payload }))
    .digest('hex')

  return digest
}

function pruneGuardState(nowMs: number): void {
  for (const [key, until] of dedupKeyUntil.entries()) {
    if (until <= nowMs) {
      dedupKeyUntil.delete(key)
    }
  }

  for (const [key, until] of ruleCooldownUntil.entries()) {
    if (until <= nowMs) {
      ruleCooldownUntil.delete(key)
    }
  }

  enforceGuardMapLimit(dedupKeyUntil, MAX_DEDUP_ENTRIES)
  enforceGuardMapLimit(ruleCooldownUntil, MAX_RULE_COOLDOWN_ENTRIES)
}

function enforceGuardMapLimit(
  map: Map<string, number>,
  maxEntries: number,
): void {
  if (map.size <= maxEntries) {
    return
  }

  const entriesByExpiry = [...map.entries()].sort((a, b) => a[1] - b[1])
  const deleteCount = map.size - maxEntries
  for (let i = 0; i < deleteCount; i++) {
    const entry = entriesByExpiry[i]
    if (!entry) break
    map.delete(entry[0])
  }
}

function resolveTemplate(
  template: string,
  replacements: Record<string, string>,
): string {
  return template.replace(/\$\{([A-Z0-9_]+)\}|\$([A-Z0-9_]+)/g, (_m, a, b) => {
    const key = (a || b) as string
    return replacements[key] ?? ''
  })
}

function buildFallbackPrompt(
  action: SpawnFallbackAgentAction,
  rule: HookChainRule,
  event: HookChainEventContext,
): string {
  const payload = normalizePayload(event.payload)
  const payloadJson = stableFingerprint(payload)

  const taskSubject = readStringField(payload, ['task_subject', 'taskSubject'])
  const taskDescription = readStringField(payload, [
    'task_description',
    'taskDescription',
  ])
  const error = readStringField(payload, ['error', 'reason'])

  const replacements: Record<string, string> = {
    EVENT_NAME: event.eventName,
    OUTCOME: event.outcome,
    RULE_ID: rule.id,
    TASK_SUBJECT: taskSubject ?? '',
    TASK_DESCRIPTION: taskDescription ?? '',
    ERROR: error ?? '',
    PAYLOAD_JSON: payloadJson,
  }

  if (action.promptTemplate) {
    return resolveTemplate(action.promptTemplate, replacements)
  }

  const parts: string[] = [
    'You are a fallback recovery agent triggered by a Self-Healing Hook Chain rule.',
    `Event: ${event.eventName}`,
    `Outcome: ${event.outcome}`,
    `Rule ID: ${rule.id}`,
  ]

  if (taskSubject) {
    parts.push(`Task subject: ${taskSubject}`)
  }

  if (taskDescription) {
    parts.push(`Task description: ${taskDescription}`)
  }

  if (error) {
    parts.push(`Failure details: ${error}`)
  }

  parts.push(
    'Goal: perform a minimal, safe recovery attempt and report what changed, what failed, and recommended next steps.',
  )
  parts.push(`Failure payload JSON: ${payloadJson}`)

  return parts.join('\n')
}

function buildNotifyTeamMessage(
  action: NotifyTeamAction,
  rule: HookChainRule,
  event: HookChainEventContext,
): { summary?: string; body: string } {
  const payload = normalizePayload(event.payload)
  const payloadJson = stableFingerprint(payload)

  const replacements: Record<string, string> = {
    EVENT_NAME: event.eventName,
    OUTCOME: event.outcome,
    RULE_ID: rule.id,
    PAYLOAD_JSON: payloadJson,
    ERROR: readStringField(payload, ['error', 'reason']) ?? '',
    TASK_SUBJECT: readStringField(payload, ['task_subject', 'taskSubject']) ?? '',
    TASK_ID: readStringField(payload, ['task_id', 'taskId']) ?? '',
  }

  const summary = action.summary
    ? resolveTemplate(action.summary, replacements)
    : `Hook chain ${rule.id} triggered (${event.eventName}/${event.outcome})`

  const body = action.messageTemplate
    ? resolveTemplate(action.messageTemplate, replacements)
    : [
        'Self-healing hook chain triggered.',
        `Rule: ${rule.id}`,
        `Event: ${event.eventName}`,
        `Outcome: ${event.outcome}`,
        `Error: ${replacements.ERROR || 'n/a'}`,
        `Task: ${replacements.TASK_SUBJECT || replacements.TASK_ID || 'n/a'}`,
        `Payload: ${payloadJson}`,
      ].join('\n')

  return { summary, body }
}

export async function executeSpawnFallbackAgentAction(args: {
  action: SpawnFallbackAgentAction
  rule: HookChainRule
  event: HookChainEventContext
  runtime: HookChainRuntimeContext
}): Promise<HookChainActionExecutionResult> {
  const { action, rule, event, runtime } = args

  if (runtime.signal?.aborted) {
    return { status: 'skipped', reason: 'aborted' }
  }

  if (!runtime.onSpawnFallbackAgent) {
    return {
      status: 'failed',
      reason: 'No fallback agent launcher is registered in runtime context',
    }
  }

  const payload = normalizePayload(event.payload)
  const description =
    action.description ?? `Fallback recovery: ${event.eventName} (${event.outcome})`

  const request: SpawnFallbackAgentRequest = {
    ruleId: rule.id,
    eventName: event.eventName,
    outcome: event.outcome,
    description,
    prompt: buildFallbackPrompt(action, rule, event),
    agentType: action.agentType,
    model: action.model,
    runInBackground: true,
    payload,
    signal: runtime.signal,
  }

  try {
    const result = await runtime.onSpawnFallbackAgent(request)
    if (!result.launched) {
      return {
        status: 'failed',
        reason: result.reason ?? 'Fallback launcher declined to start an agent',
      }
    }

    return {
      status: 'executed',
      detail: result.agentId
        ? `Fallback agent launched: ${result.agentId}`
        : 'Fallback agent launched',
    }
  } catch (error) {
    return {
      status: 'failed',
      reason: `Fallback agent launch failed: ${String(error)}`,
    }
  }
}

function resolveTeamName(
  action: NotifyTeamAction,
  runtime: HookChainRuntimeContext,
  event: HookChainEventContext,
): string | undefined {
  if (action.teamName) {
    return action.teamName
  }

  if (runtime.teamName) {
    return runtime.teamName
  }

  const payload = normalizePayload(event.payload)
  const payloadTeam = readStringField(payload, ['team_name', 'teamName'])
  if (payloadTeam) {
    return payloadTeam
  }

  return getTeamName()
}

function resolveRecipients(
  recipientsFromRule: string[] | undefined,
  allTeamMembers: string[],
  senderName: string,
): string[] {
  if (recipientsFromRule && recipientsFromRule.length > 0) {
    if (recipientsFromRule.includes('*')) {
      return allTeamMembers.filter(name => name !== senderName)
    }

    const allowed = new Set(allTeamMembers)
    return recipientsFromRule.filter(name => allowed.has(name))
  }

  return allTeamMembers.filter(name => name !== senderName)
}

export async function executeNotifyTeamAction(args: {
  action: NotifyTeamAction
  rule: HookChainRule
  event: HookChainEventContext
  runtime: HookChainRuntimeContext
}): Promise<HookChainActionExecutionResult> {
  const { action, rule, event, runtime } = args

  if (runtime.signal?.aborted) {
    return { status: 'skipped', reason: 'aborted' }
  }

  const payload = normalizePayload(event.payload)
  const teamName = resolveTeamName(action, runtime, event)

  if (!teamName) {
    return {
      status: 'skipped',
      reason: 'No team context is available for notify_team action',
    }
  }

  const senderName = runtime.senderName ?? getAgentName() ?? 'self-healing-mesh'
  const senderColor = runtime.senderColor ?? getTeammateColor()
  const { summary, body } = buildNotifyTeamMessage(action, rule, event)

  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) {
    return {
      status: 'skipped',
      reason: `Team file not found for team ${teamName}`,
    }
  }

  const memberNames = teamFile.members.map(member => member.name)
  const recipients = resolveRecipients(action.recipients, memberNames, senderName)

  if (recipients.length === 0) {
    return {
      status: 'skipped',
      reason: 'No eligible recipients for notify_team action',
    }
  }

  if (runtime.onNotifyTeam) {
    try {
      const response = await runtime.onNotifyTeam({
        ruleId: rule.id,
        eventName: event.eventName,
        outcome: event.outcome,
        teamName,
        recipients,
        summary,
        message: body,
        payload,
        signal: runtime.signal,
      })

      if (!response.sent) {
        return {
          status: 'skipped',
          reason: response.reason ?? 'notify_team callback declined to send',
        }
      }

      return {
        status: 'executed',
        detail: `Team notification sent to ${response.recipientCount ?? recipients.length} recipient(s)`,
      }
    } catch (error) {
      return {
        status: 'failed',
        reason: `notify_team callback failed: ${String(error)}`,
      }
    }
  }

  for (const recipient of recipients) {
    await writeToMailbox(
      recipient,
      {
        from: senderName,
        text: body,
        summary,
        color: senderColor,
        timestamp: new Date().toISOString(),
      },
      teamName,
    )
  }

  return {
    status: 'executed',
    detail: `Team notification sent to ${recipients.length} recipient(s)`,
  }
}

export async function executeWarmRemoteCapacityAction(args: {
  action: WarmRemoteCapacityAction
  rule: HookChainRule
  event: HookChainEventContext
  runtime: HookChainRuntimeContext
}): Promise<HookChainActionExecutionResult> {
  const { action, rule, event, runtime } = args

  if (runtime.signal?.aborted) {
    return { status: 'skipped', reason: 'aborted' }
  }

  if (!isPolicyAllowed('allow_remote_sessions')) {
    return {
      status: 'skipped',
      reason: 'Remote sessions are blocked by policy',
    }
  }

  if (runtime.onWarmRemoteCapacity) {
    try {
      const response = await runtime.onWarmRemoteCapacity({
        ruleId: rule.id,
        eventName: event.eventName,
        outcome: event.outcome,
        payload: normalizePayload(event.payload),
        signal: runtime.signal,
        createDefaultEnvironmentIfMissing:
          action.createDefaultEnvironmentIfMissing,
      })

      if (!response.warmed) {
        return {
          status: 'skipped',
          reason: response.reason ?? 'Warm remote callback declined',
        }
      }

      return {
        status: 'executed',
        detail: response.environmentId
          ? `Remote capacity warmed for environment ${response.environmentId}`
          : 'Remote capacity warm-up completed',
      }
    } catch (error) {
      return {
        status: 'failed',
        reason: `warm_remote_capacity callback failed: ${String(error)}`,
      }
    }
  }

  // MVP safety guard: if the REPL bridge is not active, skip warm-up instead
  // of touching remote APIs. This keeps the action side-effect free when the
  // session is local-only.
  try {
    const { getReplBridgeHandle } = await import('../bridge/replBridgeHandle.js')
    if (!getReplBridgeHandle()) {
      return {
        status: 'skipped',
        reason: 'Bridge is not active; warm_remote_capacity is a safe no-op',
      }
    }
  } catch {
    return {
      status: 'skipped',
      reason: 'Bridge status unavailable; warm_remote_capacity skipped',
    }
  }

  // We keep warm_remote_capacity conservative in MVP:
  // 1) verify remote prerequisites,
  // 2) fetch selected environment metadata,
  // 3) issue a lightweight environments list call as a controlled pre-warm path.
  try {
    const [{ checkBackgroundRemoteSessionEligibility }, { getEnvironmentSelectionInfo }, envApi] =
      await Promise.all([
        import('./background/remote/remoteSession.js'),
        import('./teleport/environmentSelection.js'),
        import('./teleport/environments.js'),
      ])

    const preconditions = await checkBackgroundRemoteSessionEligibility({
      skipBundle: true,
    })

    if (preconditions.length > 0) {
      return {
        status: 'skipped',
        reason: `Remote warm-up preconditions failed: ${preconditions
          .map(item => item.type)
          .join(', ')}`,
      }
    }

    let selection = await getEnvironmentSelectionInfo()

    if (
      !selection.selectedEnvironment &&
      action.createDefaultEnvironmentIfMissing === true
    ) {
      const created = await envApi.createDefaultCloudEnvironment(
        'OpenClaude Self-Healing Warmup',
      )
      selection = {
        availableEnvironments: [created],
        selectedEnvironment: created,
        selectedEnvironmentSource: null,
      }
    }

    if (!selection.selectedEnvironment) {
      return {
        status: 'skipped',
        reason: 'No eligible remote environment available for warm-up',
      }
    }

    await envApi.fetchEnvironments()

    return {
      status: 'executed',
      detail: `Remote warm-up checked environment ${selection.selectedEnvironment.environment_id}`,
    }
  } catch (error) {
    return {
      status: 'failed',
      reason: `Remote warm-up failed: ${String(error)}`,
    }
  }
}

export function emitHookChainRuleMatched(data: {
  ruleId: string
  eventName: HookEvent
  outcome: HookChainOutcome
  chainDepth: number
}): void {
  logEvent('chain_rule_matched', {
    rule_id: asAnalyticsString(data.ruleId),
    hook_event_name: asAnalyticsString(data.eventName),
    outcome: asAnalyticsString(data.outcome),
    chain_depth: data.chainDepth,
  })

  void logOTelEvent('chain_rule_matched', {
    rule_id: data.ruleId,
    hook_event_name: data.eventName,
    outcome: data.outcome,
    chain_depth: String(data.chainDepth),
  })
}

export function emitHookChainActionExecuted(data: {
  ruleId: string
  actionType: HookChainAction['type']
  actionId?: string
  eventName: HookEvent
  outcome: HookChainOutcome
  detail?: string
}): void {
  logEvent('chain_action_executed', {
    rule_id: asAnalyticsString(data.ruleId),
    action_type: asAnalyticsString(data.actionType),
    action_id: data.actionId ? asAnalyticsString(data.actionId) : undefined,
    hook_event_name: asAnalyticsString(data.eventName),
    outcome: asAnalyticsString(data.outcome),
  })

  void logOTelEvent('chain_action_executed', {
    rule_id: data.ruleId,
    action_type: data.actionType,
    action_id: data.actionId,
    hook_event_name: data.eventName,
    outcome: data.outcome,
    detail: data.detail,
  })
}

export function emitHookChainActionSkipped(data: {
  ruleId: string
  actionType: HookChainAction['type']
  actionId?: string
  eventName: HookEvent
  outcome: HookChainOutcome
  reason: string
}): void {
  const reasonCategory = categorizeReason(data.reason)
  logEvent('chain_action_skipped', {
    rule_id: asAnalyticsString(data.ruleId),
    action_type: asAnalyticsString(data.actionType),
    action_id: data.actionId ? asAnalyticsString(data.actionId) : undefined,
    hook_event_name: asAnalyticsString(data.eventName),
    outcome: asAnalyticsString(data.outcome),
    reason_category: asAnalyticsString(reasonCategory),
  })

  void logOTelEvent('chain_action_skipped', {
    rule_id: data.ruleId,
    action_type: data.actionType,
    action_id: data.actionId,
    hook_event_name: data.eventName,
    outcome: data.outcome,
    reason: data.reason,
  })
}

export function emitHookChainActionFailed(data: {
  ruleId: string
  actionType: HookChainAction['type']
  actionId?: string
  eventName: HookEvent
  outcome: HookChainOutcome
  reason: string
}): void {
  const reasonCategory = categorizeReason(data.reason)
  logEvent('chain_action_failed', {
    rule_id: asAnalyticsString(data.ruleId),
    action_type: asAnalyticsString(data.actionType),
    action_id: data.actionId ? asAnalyticsString(data.actionId) : undefined,
    hook_event_name: asAnalyticsString(data.eventName),
    outcome: asAnalyticsString(data.outcome),
    reason_category: asAnalyticsString(reasonCategory),
  })

  void logOTelEvent('chain_action_failed', {
    rule_id: data.ruleId,
    action_type: data.actionType,
    action_id: data.actionId,
    hook_event_name: data.eventName,
    outcome: data.outcome,
    reason: data.reason,
  })
}

async function executeHookChainAction(args: {
  action: HookChainAction
  rule: HookChainRule
  event: HookChainEventContext
  runtime: HookChainRuntimeContext
}): Promise<HookChainActionExecutionResult> {
  const { action } = args

  if (action.enabled === false) {
    return { status: 'skipped', reason: 'action disabled' }
  }

  switch (action.type) {
    case 'spawn_fallback_agent':
      return executeSpawnFallbackAgentAction({
        action,
        rule: args.rule,
        event: args.event,
        runtime: args.runtime,
      })
    case 'notify_team':
      return executeNotifyTeamAction({
        action,
        rule: args.rule,
        event: args.event,
        runtime: args.runtime,
      })
    case 'warm_remote_capacity':
      return executeWarmRemoteCapacityAction({
        action,
        rule: args.rule,
        event: args.event,
        runtime: args.runtime,
      })
  }
}

function getRuleCooldownMs(rule: HookChainRule, config: HookChainsConfig): number {
  return rule.cooldownMs ?? config.defaultCooldownMs
}

function getActionDedupWindowMs(
  action: HookChainAction,
  rule: HookChainRule,
  config: HookChainsConfig,
): number {
  return action.dedupWindowMs ?? rule.dedupWindowMs ?? config.defaultDedupWindowMs
}

function buildActionDedupKey(args: {
  rule: HookChainRule
  action: HookChainAction
  actionIndex: number
  event: HookChainEventContext
  runtime: HookChainRuntimeContext
}): string {
  const { rule, action, actionIndex, event, runtime } = args

  const identity = {
    ruleId: rule.id,
    actionId: action.id ?? `${action.type}:${actionIndex}`,
    eventIdentity: buildEventIdentity(event),
    scope: runtime.dedupScope ?? '',
  }

  return createHash('sha1').update(stableFingerprint(identity)).digest('hex')
}

export async function dispatchHookChainsForEvent(args: {
  event: HookChainEventContext
  runtime?: HookChainRuntimeContext
  configPathOverride?: string
  forceReloadConfig?: boolean
}): Promise<HookChainsDispatchResult> {
  const runtime = args.runtime ?? {}
  const loadResult = loadHookChainsConfig({
    pathOverride: args.configPathOverride,
    forceReload: args.forceReloadConfig,
  })

  const config = loadResult.config
  const event = {
    ...args.event,
    payload: normalizePayload(args.event.payload),
    occurredAt: args.event.occurredAt ?? Date.now(),
  }

  if (!config.enabled || config.rules.length === 0) {
    return {
      enabled: false,
      configPath: loadResult.path,
      fromCache: loadResult.fromCache,
      evaluatedRuleCount: 0,
      matchedRuleIds: [],
      actionResults: [],
    }
  }

  const chainDepth = runtime.chainDepth ?? 0
  if (chainDepth >= config.maxChainDepth) {
    return {
      enabled: true,
      configPath: loadResult.path,
      fromCache: loadResult.fromCache,
      evaluatedRuleCount: 0,
      matchedRuleIds: [],
      actionResults: [],
    }
  }

  const now = Date.now()
  pruneGuardState(now)

  const matches = evaluateHookChainRules(config.rules, event)
  const actionResults: HookChainActionDispatchResult[] = []

  for (const match of matches) {
    const { rule } = match

    if (runtime.signal?.aborted) {
      break
    }

    if (rule.maxDepth !== undefined && chainDepth >= rule.maxDepth) {
      for (const action of rule.actions) {
        const result: HookChainActionDispatchResult = {
          ruleId: rule.id,
          actionType: action.type,
          actionId: action.id,
          status: 'skipped',
          reason: `rule maxDepth reached (${chainDepth}/${rule.maxDepth})`,
        }
        actionResults.push(result)
        emitHookChainActionSkipped({
          ruleId: rule.id,
          actionType: action.type,
          actionId: action.id,
          eventName: event.eventName,
          outcome: event.outcome,
          reason: result.reason ?? 'rule depth guard',
        })
      }
      continue
    }

    const cooldownMs = getRuleCooldownMs(rule, config)
    const cooldownUntil = ruleCooldownUntil.get(rule.id)
    if (cooldownUntil && cooldownUntil > now) {
      for (const action of rule.actions) {
        const reason = `rule cooldown active for ${cooldownUntil - now}ms`
        const result: HookChainActionDispatchResult = {
          ruleId: rule.id,
          actionType: action.type,
          actionId: action.id,
          status: 'skipped',
          reason,
        }
        actionResults.push(result)
        emitHookChainActionSkipped({
          ruleId: rule.id,
          actionType: action.type,
          actionId: action.id,
          eventName: event.eventName,
          outcome: event.outcome,
          reason,
        })
      }
      continue
    }

    ruleCooldownUntil.set(rule.id, now + cooldownMs)

    emitHookChainRuleMatched({
      ruleId: rule.id,
      eventName: event.eventName,
      outcome: event.outcome,
      chainDepth,
    })

    for (let actionIndex = 0; actionIndex < rule.actions.length; actionIndex++) {
      const action = rule.actions[actionIndex]
      if (!action) continue

      if (runtime.signal?.aborted) {
        const result: HookChainActionDispatchResult = {
          ruleId: rule.id,
          actionType: action.type,
          actionId: action.id,
          status: 'skipped',
          reason: 'aborted',
        }
        actionResults.push(result)
        emitHookChainActionSkipped({
          ruleId: rule.id,
          actionType: action.type,
          actionId: action.id,
          eventName: event.eventName,
          outcome: event.outcome,
          reason: 'aborted',
        })
        continue
      }

      const dedupKey = buildActionDedupKey({
        rule,
        action,
        actionIndex,
        event,
        runtime,
      })
      const dedupWindowMs = getActionDedupWindowMs(action, rule, config)
      const dedupUntil = dedupKeyUntil.get(dedupKey)

      if (dedupUntil && dedupUntil > now) {
        const reason = `dedup window active for ${dedupUntil - now}ms`
        const result: HookChainActionDispatchResult = {
          ruleId: rule.id,
          actionType: action.type,
          actionId: action.id,
          status: 'skipped',
          reason,
        }
        actionResults.push(result)
        emitHookChainActionSkipped({
          ruleId: rule.id,
          actionType: action.type,
          actionId: action.id,
          eventName: event.eventName,
          outcome: event.outcome,
          reason,
        })
        continue
      }

      // Mark dedup before execution so concurrent failures do not trigger a
      // thundering herd of duplicate remediations.
      dedupKeyUntil.set(dedupKey, now + dedupWindowMs)

      const executed = await executeHookChainAction({
        action,
        rule,
        event,
        runtime,
      })

      const result: HookChainActionDispatchResult = {
        ruleId: rule.id,
        actionType: action.type,
        actionId: action.id,
        status: executed.status,
        reason: executed.reason,
        detail: executed.detail,
      }
      actionResults.push(result)

      if (executed.status === 'executed') {
        emitHookChainActionExecuted({
          ruleId: rule.id,
          actionType: action.type,
          actionId: action.id,
          eventName: event.eventName,
          outcome: event.outcome,
          detail: executed.detail,
        })
      } else if (executed.status === 'skipped') {
        emitHookChainActionSkipped({
          ruleId: rule.id,
          actionType: action.type,
          actionId: action.id,
          eventName: event.eventName,
          outcome: event.outcome,
          reason: executed.reason ?? 'skipped',
        })
      } else {
        emitHookChainActionFailed({
          ruleId: rule.id,
          actionType: action.type,
          actionId: action.id,
          eventName: event.eventName,
          outcome: event.outcome,
          reason: executed.reason ?? 'failed',
        })
      }
    }
  }

  logForDiagnosticsNoPII('info', 'hook_chains_dispatch', {
    event_name: event.eventName,
    outcome: event.outcome,
    matched_rules: matches.length,
    action_results: actionResults.length,
  })

  if (loadResult.error) {
    logForDebugging(
      `[hook-chains] Config validation error at ${loadResult.path}: ${loadResult.error}`,
    )
  }

  return {
    enabled: true,
    configPath: loadResult.path,
    fromCache: loadResult.fromCache,
    evaluatedRuleCount: config.rules.length,
    matchedRuleIds: matches.map(match => match.rule.id),
    actionResults,
  }
}

export function resetHookChainsRuntimeStateForTests(): void {
  configCache = null
  ruleCooldownUntil.clear()
  dedupKeyUntil.clear()
}

function categorizeReason(reason: string): string {
  const normalized = reason.toLowerCase()
  if (normalized.includes('aborted')) return 'aborted'
  if (normalized.includes('cooldown')) return 'cooldown'
  if (normalized.includes('dedup')) return 'dedup'
  if (normalized.includes('policy')) return 'policy'
  if (normalized.includes('context')) return 'context_missing'
  if (normalized.includes('precondition')) return 'precondition'
  if (normalized.includes('disabled')) return 'disabled'
  return 'other'
}
