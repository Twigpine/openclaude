import * as React from 'react'
import { stripVTControlCharacters } from 'node:util'
import { MessageResponse } from '../../components/MessageResponse.js'
import { ShellProgressMessage } from '../../components/shell/ShellProgressMessage.js'
import { Box, Text } from '../../ink.js'
import type { ProgressMessage } from '../../types/message.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { firstLineOf } from '../../utils/stringUtils.js'

const INLINE_RESULT_LIMIT = 120
const VERBOSE_SECTION_LIMIT = 8_000

type ReplOutputLike = {
  status?: 'completed' | 'error' | 'timeout' | 'aborted'
  code?: string
  result?: unknown
  error?: {
    name: string
    message: string
    stack?: string
  }
  stdout?: string
  stderr?: string
  durationMs?: number
  toolsUsed?: string[]
  residualInnerWork?: {
    active: boolean
    activeInvocationCount: number
    quiesceTimeoutMs: number
    warning: string
  }
  persistedOutputPath?: string
  persistedOutputSize?: number
  persistedOutputPreview?: string
  persistedOutputTruncated?: boolean
  persistedOutputTruncatedFields?: string[]
  persistedOutputError?: string
}

function lineCount(code: string): number {
  return code.length === 0 ? 0 : code.split('\n').length
}

function terminalText(text: string): string {
  return stripVTControlCharacters(text)
}

function compactValue(value: unknown): string {
  if (value === undefined) return ''
  const serialized = typeof value === 'string' ? value : jsonStringify(value)
  if (!serialized) return ''
  const firstLine = firstLineOf(terminalText(serialized))
  return firstLine.length > INLINE_RESULT_LIMIT
    ? `${firstLine.slice(0, INLINE_RESULT_LIMIT)}...`
    : firstLine
}

function boundedSection(text: string): string {
  text = terminalText(text)
  return text.length > VERBOSE_SECTION_LIMIT
    ? `${text.slice(0, VERBOSE_SECTION_LIMIT)}\n... [truncated ${text.length - VERBOSE_SECTION_LIMIT} chars]`
    : text
}

function formatVerboseValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  return boundedSection(jsonStringify(value, null, 2) ?? String(value))
}

export function renderToolUseMessage(input: { code?: string }): React.ReactNode {
  if (!input.code) return ''
  const lines = lineCount(input.code)
  return `${lines} ${lines === 1 ? 'line' : 'lines'}`
}


function progressData(message: ProgressMessage): Record<string, unknown> | undefined {
  return message.data as Record<string, unknown> | undefined
}

function progressIdentity(message: ProgressMessage): string {
  const data = progressData(message)
  return typeof data?.replInnerToolUseID === 'string'
    ? data.replInnerToolUseID
    : '__unlabeled_inner_progress__'
}

export function selectLatestReplProgressMessages(
  progressMessagesForMessage: ProgressMessage[],
): ProgressMessage[] {
  const latestByInnerTool = new Map<string, ProgressMessage>()
  for (const message of progressMessagesForMessage) {
    const key = progressIdentity(message)
    latestByInnerTool.delete(key)
    latestByInnerTool.set(key, message)
  }
  return [...latestByInnerTool.values()]
}

function replProgressLabel(message: ProgressMessage): string {
  const data = progressData(message)
  if (typeof data?.replInnerToolName === 'string') return data.replInnerToolName
  if (data?.type === 'bash_progress') return 'Bash'
  if (data?.type === 'powershell_progress') return 'PowerShell'
  if (data?.type === 'mcp_progress') return 'MCP tool'
  return 'Inner tool'
}

function renderSingleReplProgress(
  data: Record<string, unknown>,
  verbose: boolean,
): React.ReactNode {
  if (data.type === 'bash_progress' || data.type === 'powershell_progress') {
    return <ShellProgressMessage
      fullOutput={typeof data.fullOutput === 'string' ? data.fullOutput : ''}
      output={typeof data.output === 'string' ? data.output : ''}
      elapsedTimeSeconds={typeof data.elapsedTimeSeconds === 'number' ? data.elapsedTimeSeconds : undefined}
      totalLines={typeof data.totalLines === 'number' ? data.totalLines : undefined}
      totalBytes={typeof data.totalBytes === 'number' ? data.totalBytes : undefined}
      timeoutMs={typeof data.timeoutMs === 'number' ? data.timeoutMs : undefined}
      taskId={typeof data.taskId === 'string' ? data.taskId : undefined}
      verbose={verbose}
    />
  }
  if (data.type === 'mcp_progress') {
    const progressMessage = typeof data.progressMessage === 'string'
      ? stripVTControlCharacters(data.progressMessage)
      : undefined
    const progress = typeof data.progress === 'number' ? data.progress : undefined
    const total = typeof data.total === 'number' ? data.total : undefined
    const label = progressMessage ?? (progress !== undefined
      ? total !== undefined && total > 0
        ? `Processing... ${Math.round(Math.min(1, Math.max(0, progress / total)) * 100)}%`
        : `Processing... ${progress}`
      : 'Running...')
    return <MessageResponse height={1}><Text dimColor>{label}</Text></MessageResponse>
  }
  return <MessageResponse height={1}><Text dimColor>Inner tool running...</Text></MessageResponse>
}

export function renderToolUseProgressMessage(
  progressMessagesForMessage: ProgressMessage[],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  const latestByInnerTool = selectLatestReplProgressMessages(progressMessagesForMessage)
  const lastProgress = latestByInnerTool.at(-1)
  const data = lastProgress ? progressData(lastProgress) : undefined
  if (!data) {
    return <MessageResponse height={1}><Text dimColor>Running...</Text></MessageResponse>
  }
  if (latestByInnerTool.length === 1) {
    return renderSingleReplProgress(data, verbose)
  }

  const visible = latestByInnerTool.slice(-3)
  const hiddenCount = latestByInnerTool.length - visible.length
  return <Box flexDirection="column">
    {hiddenCount > 0 && <Text dimColor>{hiddenCount} other inner tools running...</Text>}
    {visible.map(message => {
      const messageData = progressData(message)
      if (!messageData) return null
      return <Box key={progressIdentity(message)} flexDirection="column">
        <Text dimColor>{replProgressLabel(message)}</Text>
        {renderSingleReplProgress(messageData, false)}
      </Box>
    })}
  </Box>
}

export function renderToolResultMessage(
  output: ReplOutputLike,
  _progressMessagesForMessage: ProgressMessage[],
  options: { verbose: boolean; input?: unknown },
): React.ReactNode {
  const input = typeof options.input === 'object' && options.input !== null
    ? options.input as { code?: unknown }
    : undefined
  const code = typeof input?.code === 'string'
    ? input.code
    : typeof output.code === 'string'
      ? output.code
      : undefined
  const status = output.status ?? 'completed'
  const toolsUsed = Array.isArray(output.toolsUsed) ? output.toolsUsed : []

  if (!options.verbose) {
    const parts: string[] = [status]
    if (typeof output.durationMs === 'number') {
      parts.push(`${Math.round(output.durationMs)}ms`)
    }
    if (toolsUsed.length > 0) {
      parts.push(`${toolsUsed.length} ${toolsUsed.length === 1 ? 'tool' : 'tools'}`)
    }
    const result = compactValue(output.result)
    if (result) parts.push(result)
    if (output.error) parts.push(`${terminalText(output.error.name)}: ${terminalText(output.error.message)}`)
    if (output.residualInnerWork?.active) parts.push('inner work may still be running')
    return <MessageResponse height={1}>
      <Text dimColor>{parts.join(' · ')}</Text>
    </MessageResponse>
  }

  return <Box flexDirection="column">
    {code !== undefined && <>
      <Text dimColor>code:</Text>
      <Text>{boundedSection(code)}</Text>
    </>}
    <Text dimColor>status: {status}{typeof output.durationMs === 'number' ? ` · ${Math.round(output.durationMs)}ms` : ''}</Text>
    <Text dimColor>tools used: {toolsUsed.length > 0 ? toolsUsed.map(terminalText).join(', ') : 'none'}</Text>
    {output.result !== undefined && <>
      <Text dimColor>result:</Text>
      <Text>{formatVerboseValue(output.result)}</Text>
    </>}
    {output.error && <>
      <Text dimColor>error:</Text>
      <Text>{terminalText(output.error.name)}: {terminalText(output.error.message)}</Text>
      {output.error.stack && <Text dimColor>{boundedSection(output.error.stack)}</Text>}
    </>}
    {output.residualInnerWork?.active && <>
      <Text dimColor>warning:</Text>
      <Text>{terminalText(output.residualInnerWork.warning)}</Text>
    </>}
    {output.persistedOutputPath && <>
      <Text dimColor>persisted output:</Text>
      <Text>{terminalText(output.persistedOutputPath)}{typeof output.persistedOutputSize === 'number' ? ` (${output.persistedOutputSize} bytes)` : ''}</Text>
    </>}
    {output.persistedOutputError && <>
      <Text dimColor>persisted output error:</Text>
      <Text>{terminalText(output.persistedOutputError)}</Text>
    </>}
    {output.stdout && <>
      <Text dimColor>stdout:</Text>
      <Text>{boundedSection(output.stdout)}</Text>
    </>}
    {output.stderr && <>
      <Text dimColor>stderr:</Text>
      <Text>{boundedSection(output.stderr)}</Text>
    </>}
  </Box>
}

export function isResultTruncated(output: ReplOutputLike): boolean {
  return Boolean(
    output.code?.includes('\n') ||
    output.persistedOutputPath !== undefined ||
    output.result !== undefined ||
    output.error ||
    output.residualInnerWork?.active ||
    output.stdout ||
    output.stderr,
  )
}
