import { feature } from 'bun:bundle'
import chalk from 'chalk'
import figures from 'figures'
import { getEffectiveContextWindowSize, getAutoCompactThreshold, isAutoCompactEnabled } from '../../services/compact/autoCompact.js'
import { microcompactMessages } from '../../services/compact/microCompact.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Tools } from '../../Tool.js'
import type { AgentDefinitionsResult } from '../../tools/AgentTool/loadAgentsDir.js'
import type { CompactMetadata, Message } from '../../types/message.js'
import { analyzeContextUsage, type ContextData } from '../../utils/analyzeContext.js'
import { getGlobalConfig } from '../../utils/config.js'
import {
  CONTEXT_WINDOW_SOURCE_LABELS,
  type ContextWindowSource,
  getModelMaxOutputTokens,
  resolveContextWindowForModel,
} from '../../utils/context.js'
import { formatNumber, formatDuration } from '../../utils/format.js'
import {
  getMaxActiveMessagesHardCap,
  getMessageCountCompactionTrigger,
  resolveMessageCountCompactionLimit,
} from '../../utils/maxActiveMessages.js'
import { getMessagesAfterCompactBoundary, isCompactBoundaryMessage } from '../../utils/messages.js'
import { getCanonicalName } from '../../utils/model/model.js'
import {
  getSdkBetas,
  getModelUsage,
  getTotalInputTokens,
  getTotalOutputTokens,
  getTotalCacheReadInputTokens,
  getTotalCacheCreationInputTokens,
  getTotalCostUSD,
  getTotalAPIDuration,
  getTotalDuration,
  getTotalLinesAdded,
  getTotalLinesRemoved,
} from '../../bootstrap/state.js'

type CtxDataInput = {
  messages: Message[]
  getAppState: () => AppState
  options: {
    mainLoopModel: string
    tools: Tools
    agentDefinitions: AgentDefinitionsResult
    customSystemPrompt?: string
    appendSystemPrompt?: string
  }
}

function toApiView(messages: Message[]): Message[] {
  let view = getMessagesAfterCompactBoundary(messages)
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { projectView } = require('../../services/contextCollapse/operations.js') as typeof import('../../services/contextCollapse/operations.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    view = projectView(view)
  }
  return view
}

export async function collectCtxData(context: CtxDataInput): Promise<{
  contextData: ContextData
  contextWindow: number
  contextWindowSource: ContextWindowSource
  effectiveContext: number
  autoCompactThreshold: number
  messageCountCompactAt: number
  messageCountHardCap: number
  lastCompaction: Pick<CompactMetadata, 'trigger' | 'autoCompactReason'> | null
  maxOutput: { default: number; upperLimit: number }
  canonicalName: string
  autoCompactEnabled: boolean
  sessionInput: number
  sessionOutput: number
  sessionCacheRead: number
  sessionCacheCreation: number
  sessionCost: number
  sessionApiDuration: number
  sessionWallDuration: number
  linesAdded: number
  linesRemoved: number
  modelUsageMap: ReturnType<typeof getModelUsage>
}> {
  const {
    messages,
    getAppState,
    options: { mainLoopModel, tools, agentDefinitions, customSystemPrompt, appendSystemPrompt },
  } = context

  const apiView = toApiView(messages)
  const { messages: compactedMessages } = await microcompactMessages(apiView)
  const appState = getAppState()

  const contextData = await analyzeContextUsage(
    compactedMessages,
    mainLoopModel,
    async () => appState.toolPermissionContext,
    tools,
    agentDefinitions,
    undefined,
    { options: { customSystemPrompt, appendSystemPrompt } } as Pick<ToolUseContext, 'options'>,
    undefined,
    apiView,
  )

  const model = mainLoopModel
  const contextWindow = resolveContextWindowForModel(model, getSdkBetas())
  const autoCompactEnabled = isAutoCompactEnabled()
  let lastBoundary: Extract<Message, { subtype: 'compact_boundary' }> | undefined
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    if (!isCompactBoundaryMessage(message)) continue
    lastBoundary = message
    // Partial "from" compaction puts its kept prefix after the new boundary,
    // including older boundaries. Resume restores that same segment order.
    // Skip the preserved prefix when identifying operations, without changing
    // the model-facing history. Fullscreen may also have these UUIDs earlier.
    const segment = message.compactMetadata.preservedSegment
    if (segment?.anchorUuid === message.uuid) {
      const tailIndex = messages.findIndex(
        (candidate, index) => index > i && candidate.uuid === segment.tailUuid,
      )
      if (tailIndex > i) i = tailIndex
    }
  }

  return {
    contextData,
    contextWindow: contextWindow.contextWindow,
    contextWindowSource: contextWindow.source,
    effectiveContext: getEffectiveContextWindowSize(model),
    autoCompactThreshold: getAutoCompactThreshold(model),
    // Same resolution the query loop uses to force message-count compaction.
    messageCountCompactAt: getMessageCountCompactionTrigger(
      resolveMessageCountCompactionLimit(
        getGlobalConfig().maxMessagesCompactionThreshold,
        process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES,
      ),
      autoCompactEnabled,
    ),
    messageCountHardCap: getMaxActiveMessagesHardCap(),
    lastCompaction: lastBoundary
      ? {
          trigger: lastBoundary.compactMetadata.trigger,
          autoCompactReason: lastBoundary.compactMetadata.autoCompactReason,
        }
      : null,
    maxOutput: getModelMaxOutputTokens(model),
    canonicalName: getCanonicalName(model),
    autoCompactEnabled,
    sessionInput: getTotalInputTokens(),
    sessionOutput: getTotalOutputTokens(),
    sessionCacheRead: getTotalCacheReadInputTokens(),
    sessionCacheCreation: getTotalCacheCreationInputTokens(),
    sessionCost: getTotalCostUSD(),
    sessionApiDuration: getTotalAPIDuration(),
    sessionWallDuration: getTotalDuration(),
    linesAdded: getTotalLinesAdded(),
    linesRemoved: getTotalLinesRemoved(),
    modelUsageMap: getModelUsage(),
  }
}

/** Shape returned by collectCtxData, accepted by renderCtxReport. */
export type RenderInput = Awaited<ReturnType<typeof collectCtxData>>

const AUTO_COMPACT_REASON_LABELS: Record<NonNullable<CompactMetadata['autoCompactReason']>, string> = {
  'token-threshold': 'token threshold',
  'message-count': 'message count',
  'memory-pressure': 'memory pressure',
  'context-overflow': 'context-overflow recovery',
}

function formatLastCompaction(last: RenderInput['lastCompaction']): string {
  if (!last) return 'none'
  if (last.trigger === 'manual') return 'manual'
  // Boundaries from older sessions carry no reason; do not guess one.
  const reason = last.autoCompactReason ? AUTO_COMPACT_REASON_LABELS[last.autoCompactReason] : undefined
  return `automatic (${reason ?? 'reason not recorded'})`
}

function themeColorToChalk(themeColor: string): (text: string) => string {
  if (themeColor === 'error') return chalk.red
  if (themeColor === 'warning') return chalk.yellow
  if (themeColor === 'success') return chalk.green
  if (themeColor === 'info' || themeColor === 'subtle') return chalk.cyan
  return chalk.blue
}

function bar(filled: number, total: number, width: number, c: string): string {
  const ratio = total > 0 ? Math.min(filled / total, 1) : 0
  const filledW = Math.round(ratio * width)
  const emptyW = width - filledW
  return themeColorToChalk(c)('█'.repeat(filledW)) + chalk.gray('░'.repeat(emptyW))
}

function categoryLine(label: string, tokens: number, barMax: number, pctMax: number, width: number, c: string): string {
  const pct = pctMax > 0 ? ((tokens / pctMax) * 100).toFixed(1) : '0.0'
  const b = bar(tokens, barMax, width, c)
  return `  ${chalk.bold(formatNumber(tokens).padStart(12))}  ${pct.padStart(6)}%  ${b}  ${label}`
}

export async function call(
  _args: string,
  context: ToolUseContext,
): Promise<{ type: 'text'; value: string }> {
  const d = await collectCtxData(context)
  return { type: 'text' as const, value: renderCtxReport(d) }
}

/** Render the report from already-collected data (no module imports needed). */
export function renderCtxReport(d: RenderInput): string {
  const { contextData: data } = d

  const barWidth = 30
  const lines: string[] = []

  lines.push('')
  lines.push(chalk.bold.cyan(`  ${figures.bullet} Context Window: ${d.canonicalName}`))
  lines.push('')

  lines.push(chalk.bold('  Window Capacity'))
  lines.push(`    ${figures.bullet} Context window:    ${chalk.bold(formatNumber(d.contextWindow))} tokens`)
  lines.push(`    ${figures.bullet} Window source:      ${CONTEXT_WINDOW_SOURCE_LABELS[d.contextWindowSource]}`)
  if (d.contextWindowSource === 'fallback') {
    lines.push(chalk.dim('      Model limit unknown. Set it with /set-context-window, modelLimits in settings, or CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS.'))
  }
  lines.push(`    ${figures.bullet} Effective context:  ${chalk.bold(formatNumber(d.effectiveContext))} tokens`)
  lines.push(`    ${figures.bullet} Max output:         ${chalk.bold(formatNumber(d.maxOutput.default))} tokens${d.maxOutput.default !== d.maxOutput.upperLimit ? ` (up to ${formatNumber(d.maxOutput.upperLimit)})` : ''}`)
  if (d.autoCompactEnabled) {
    lines.push(`    ${figures.bullet} Auto-compact at:    ${chalk.bold(formatNumber(d.autoCompactThreshold))} tokens`)
  } else {
    lines.push(`    ${figures.bullet} Auto-compact at:    ${chalk.bold('off')}`)
  }
  if (d.messageCountCompactAt > 0) {
    const hardCapNote =
      d.messageCountHardCap > 0 && d.messageCountHardCap !== d.messageCountCompactAt
        ? ` (hard cap ${d.messageCountHardCap})`
        : d.messageCountHardCap === d.messageCountCompactAt
          ? ' (hard cap)'
          : ''
    lines.push(`    ${figures.bullet} Message-count at:   ${chalk.bold(String(d.messageCountCompactAt))} messages${hardCapNote}`)
  } else {
    lines.push(`    ${figures.bullet} Message-count at:   ${chalk.bold('off')}`)
  }
  lines.push(`    ${figures.bullet} Last compaction:    ${formatLastCompaction(d.lastCompaction)}`)
  lines.push('')

  lines.push(chalk.bold('  Current Context (what the model sees)'))
  lines.push(`    Total: ${chalk.bold(formatNumber(data.totalTokens))} / ${formatNumber(d.contextWindow)} tokens (${chalk.bold(`${data.percentage}%`)} used)`)
  lines.push('')

  // Bar scale: use the context window as the denominator so the bar
  // visually matches the percentage column (tokens / contextWindow).
  const barMax = d.contextWindow

  const CAPACITY_ROWS = new Set(['Free space', 'Autocompact buffer', 'Compact buffer'])
  for (const cat of data.categories) {
    if (cat.tokens > 0 && !CAPACITY_ROWS.has(cat.name) && !cat.isDeferred) {
      lines.push(categoryLine(cat.name, cat.tokens, barMax, barMax, barWidth, cat.color))
    }
  }
  lines.push('')

  if (data.apiUsage) {
    const u = data.apiUsage
    lines.push(chalk.bold('  Last API Response'))
    lines.push(`    ${figures.bullet} Input:       ${chalk.bold(formatNumber(u.input_tokens))} tokens`)
    lines.push(`    ${figures.bullet} Output:      ${chalk.bold(formatNumber(u.output_tokens))} tokens`)
    if (u.cache_read_input_tokens > 0) {
      lines.push(`    ${figures.bullet} Cache read:  ${chalk.bold(formatNumber(u.cache_read_input_tokens))} tokens`)
    }
    if (u.cache_creation_input_tokens > 0) {
      lines.push(`    ${figures.bullet} Cache write: ${chalk.bold(formatNumber(u.cache_creation_input_tokens))} tokens`)
    }
    lines.push('')
  }

  const sessionTotalTokens = d.sessionInput + d.sessionOutput + d.sessionCacheRead + d.sessionCacheCreation
  if (sessionTotalTokens > 0) {
    const sessionMax = Math.max(sessionTotalTokens, 1)
    lines.push(chalk.bold('  Session Token Usage'))
    lines.push(categoryLine('Input', d.sessionInput, sessionMax, sessionTotalTokens, barWidth, 'blue'))
    lines.push(categoryLine('Output', d.sessionOutput, sessionMax, sessionTotalTokens, barWidth, 'green'))
    if (d.sessionCacheRead > 0) {
      lines.push(categoryLine('Cache read', d.sessionCacheRead, sessionMax, sessionTotalTokens, barWidth, 'cyan'))
    }
    if (d.sessionCacheCreation > 0) {
      lines.push(categoryLine('Cache write', d.sessionCacheCreation, sessionMax, sessionTotalTokens, barWidth, 'yellow'))
    }
    lines.push(`  ${'Total:'.padStart(14)}  ${chalk.bold(formatNumber(sessionTotalTokens))} tokens`)
    lines.push('')
  }

  if (Object.keys(d.modelUsageMap).length > 0) {
    lines.push(chalk.bold('  Per-Model Session Totals'))
    for (const [modelName, usage] of Object.entries(d.modelUsageMap)) {
      const shortName = getCanonicalName(modelName)
      const parts = [`${formatNumber(usage.inputTokens)} in`, `${formatNumber(usage.outputTokens)} out`]
      if (usage.cacheReadInputTokens > 0) parts.push(`${formatNumber(usage.cacheReadInputTokens)} cache read`)
      if (usage.cacheCreationInputTokens > 0) parts.push(`${formatNumber(usage.cacheCreationInputTokens)} cache write`)
      if (usage.costUSD > 0) parts.push(chalk.yellow(`$${usage.costUSD.toFixed(4)}`))
      lines.push(`    ${chalk.bold(shortName)}: ${parts.join(', ')}`)
    }
    lines.push('')
  }

  if (d.sessionCost > 0 || d.sessionInput > 0 || d.linesAdded > 0 || d.linesRemoved > 0) {
    lines.push(chalk.bold('  Session Summary'))
    if (d.sessionCost > 0) {
      lines.push(`    ${figures.bullet} Cost:          ${chalk.bold(chalk.yellow(`$${d.sessionCost.toFixed(4)}`))}`)
    }
    if (d.sessionApiDuration > 0) {
      lines.push(`    ${figures.bullet} API duration:  ${chalk.bold(formatDuration(d.sessionApiDuration))}`)
    }
    if (d.sessionWallDuration > 0) {
      lines.push(`    ${figures.bullet} Wall duration: ${chalk.bold(formatDuration(d.sessionWallDuration))}`)
    }
    if (d.linesAdded > 0 || d.linesRemoved > 0) {
      lines.push(`    ${figures.bullet} Code changes:  ${chalk.green(`+${d.linesAdded}`)} / ${chalk.red(`-${d.linesRemoved}`)} lines`)
    }
    lines.push('')
  }

  lines.push(chalk.dim(`  ${figures.info} Run /context for detailed grid view, /cost for pricing, /stats for history`))
  lines.push('')

  return lines.join('\n')
}
