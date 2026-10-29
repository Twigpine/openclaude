import React, { useRef } from 'react';
import { stripVTControlCharacters as stripAnsi } from 'node:util';
import { Messages } from '../components/Messages.js';
import { KeybindingProvider } from '../keybindings/KeybindingContext.js';
import { loadKeybindingsSyncWithWarnings } from '../keybindings/loadUserBindings.js';
import type { KeybindingContextName } from '../keybindings/types.js';
import { AppStateProvider } from '../state/AppState.js';
import type { Tools } from '../Tool.js';
import type { Message } from '../types/message.js';
import {
  BASH_INPUT_TAG,
  BASH_STDERR_TAG,
  BASH_STDOUT_TAG,
  CHANNEL_MESSAGE_TAG,
  COMMAND_ARGS_TAG,
  COMMAND_MESSAGE_TAG,
  COMMAND_NAME_TAG,
  CROSS_SESSION_MESSAGE_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
  TASK_NOTIFICATION_TAG,
  TEAMMATE_MESSAGE_TAG,
  TICK_TAG,
} from '../constants/xml.js';
import type { ExportFormat } from './exportFormats.js';
import { renderToAnsiString } from './staticRender.js';
import { unescapeXml } from './xml.js';

/**
 * Minimal keybinding provider for static/headless renders.
 * Provides keybinding context without the ChordInterceptor (which uses useInput
 * and would hang in headless renders with no stdin).
 */
function StaticKeybindingProvider({
  children
}: {
  children: React.ReactNode;
}): React.ReactNode {
  const {
    bindings
  } = loadKeybindingsSyncWithWarnings();
  const pendingChordRef = useRef(null);
  const handlerRegistryRef = useRef(new Map());
  const activeContexts = useRef(new Set<KeybindingContextName>()).current;
  return <KeybindingProvider bindings={bindings} pendingChordRef={pendingChordRef} pendingChord={null} setPendingChord={() => {}} activeContexts={activeContexts} registerActiveContext={() => {}} unregisterActiveContext={() => {}} handlerRegistryRef={handlerRegistryRef}>
      {children}
    </KeybindingProvider>;
}

// Upper-bound how many NormalizedMessages a Message can produce.
// normalizeMessages splits one Message with N content blocks into N
// NormalizedMessages — 1:1 with block count. String content = 1 block.
// AttachmentMessage etc. have no .message and normalize to ≤1.
function normalizedUpperBound(m: Message): number {
  if (!('message' in m)) return 1;
  const c = m.message.content;
  return Array.isArray(c) ? c.length : 1;
}

/**
 * Streams rendered messages in chunks, ANSI codes preserved. Each chunk is a
 * fresh renderToAnsiString — yoga layout tree + Ink's screen buffer are sized
 * to the tallest CHUNK instead of the full session. Measured (Mar 2026,
 * 538-msg session): −55% plateau RSS vs a single full render. The sink owns
 * the output — write to stdout for `[` dump-to-scrollback, appendFile for `v`.
 *
 * Messages.renderRange slices AFTER normalize→group→collapse, so tool-call
 * grouping stays correct across chunk seams; buildMessageLookups runs on
 * the full normalized array so tool_use↔tool_result resolves regardless of
 * which chunk each landed in.
 */
export async function streamRenderedMessages(messages: Message[], tools: Tools, sink: (ansiChunk: string) => void | Promise<void>, {
  columns,
  verbose = false,
  chunkSize = 40,
  onProgress
}: {
  columns?: number;
  verbose?: boolean;
  chunkSize?: number;
  onProgress?: (rendered: number) => void;
} = {}): Promise<void> {
  const renderChunk = (range: readonly [number, number]) => renderToAnsiString(<AppStateProvider>
        <StaticKeybindingProvider>
          <Messages messages={messages} tools={tools} commands={[]} verbose={verbose} toolJSX={null} toolUseConfirmQueue={[]} inProgressToolUseIDs={new Set()} isMessageSelectorVisible={false} conversationId="export" screen="prompt" streamingToolUses={[]} showAllInTranscript={true} isLoading={false} renderRange={range} />
        </StaticKeybindingProvider>
      </AppStateProvider>, columns);

  // renderRange indexes into the post-collapse array whose length we can't
  // see from here — normalize splits each Message into one NormalizedMessage
  // per content block (unbounded per message), collapse merges some back.
  // Ceiling is the exact normalize output count + chunkSize so the loop
  // always reaches the empty slice where break fires (collapse only shrinks).
  let ceiling = chunkSize;
  for (const m of messages) ceiling += normalizedUpperBound(m);
  for (let offset = 0; offset < ceiling; offset += chunkSize) {
    const ansi = await renderChunk([offset, offset + chunkSize]);
    if (stripAnsi(ansi).trim() === '') break;
    await sink(ansi);
    onProgress?.(offset + chunkSize);
  }
}

/**
 * Renders messages to a plain text string suitable for export.
 * Uses the same React rendering logic as the interactive UI.
 */
export async function renderMessagesToPlainText(messages: Message[], tools: Tools = [], columns?: number): Promise<string> {
  const parts: string[] = [];
  await streamRenderedMessages(messages, tools, chunk => void parts.push(stripAnsi(chunk)), {
    columns
  });
  return parts.join('');
}

/**
 * Message types that are internal UI state and should be excluded from exports.
 */
const SKIP_MESSAGE_TYPES = new Set(['progress', 'attachment'])

/**
 * System message subtypes that are internal metrics and should be excluded.
 */
const SKIP_SYSTEM_SUBTYPES = new Set(['api_metrics'])

const INTERNAL_TEXT_TAGS = [
  COMMAND_ARGS_TAG,
  COMMAND_MESSAGE_TAG,
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
  TASK_NOTIFICATION_TAG,
  TICK_TAG,
  TEAMMATE_MESSAGE_TAG,
  CHANNEL_MESSAGE_TAG,
  CROSS_SESSION_MESSAGE_TAG,
]
const INTERNAL_TEXT_TAG_REGEXES = INTERNAL_TEXT_TAGS.map(tag => internalTagRegex(tag))

const SYNTHETIC_TOOL_RESULT_PLACEHOLDER = '[Tool result missing due to internal error]'

/**
 * Render messages as human-readable Markdown.
 * Produces structured output directly from Message[] without relying on
 * the terminal UI renderer (which is optimized for ANSI display).
 */
export function renderMessagesToMarkdown(messages: Message[], _tools?: Tools, _columns?: number): string {
  const lines: string[] = []

  lines.push('# Conversation Export')
  lines.push('')
  lines.push(`Exported: ${new Date().toISOString()}`)
  lines.push('Format: Markdown')
  lines.push('')

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue

    const msgType = String(msg.type ?? 'unknown')

    if (!shouldExportStructuredMessage(msg, msgType)) continue

    const content = extractMessageContent(msg)

    // Build rendered content first, so we can skip the heading if empty
    const contentLines: string[] = []

    if (content == null) {
      // Some system/status messages carry no user-visible export content.
      continue
    }

    // Determine the display heading — tool_result blocks inside user messages
    // should show as "Tool Result" not "User"
    const terminalOutputs = getTerminalOutputs(content)
    const isToolResultMessage = (msgType === 'user' || msgType === 'tool') && isToolResultMessageContent(content)
    const heading = terminalOutputs
      ? terminalHeading(terminalOutputs)
      : isToolResultMessage ? 'Tool Result' : messageHeading(msgType)

    if (typeof content === 'string') {
      renderTextMarkdown(content, contentLines)
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') {
          renderUnknownContentMarkdown(block, contentLines)
          continue
        }
        renderContentBlockMarkdown(block as Record<string, unknown>, contentLines, isToolResultMessage)
      }
      if (contentLines.length > 0) contentLines.push('')
    } else {
      renderUnknownContentMarkdown(content, contentLines)
    }

    // Only emit heading + content if there's something meaningful
    if (contentLines.every(l => l === '')) continue

    lines.push(`## ${heading}`)
    lines.push('')
    lines.push(...contentLines)
  }

  return lines.join('\n')
}

function messageHeading(type: string): string {
  switch (type) {
    case 'user': return 'User'
    case 'assistant': return 'Assistant'
    case 'system': return 'System'
    case 'tool': return 'Tool Result'
    default: return type.charAt(0).toUpperCase() + type.slice(1)
  }
}

function renderContentBlockMarkdown(block: Record<string, unknown>, lines: string[], skipSubheading = false): void {
  const type = block.type as string | undefined

  if (type === 'text') {
    const text = typeof block.text === 'string' ? block.text : ''
    renderTextMarkdown(text, lines)
    return
  }

  if (type === 'tool_use') {
    const name = typeof block.name === 'string' ? block.name : 'unknown'
    lines.push(`### Tool Use: ${name}`)
    lines.push('')
    const input = block.input
    if (input != null) {
      const inputJson = safeStringify(input, 2)
      const marker = markdownFenceFor(inputJson)
      lines.push(`${marker}json`)
      lines.push(inputJson)
      lines.push(marker)
      lines.push('')
    }
    return
  }

  if (type === 'tool_result') {
    if (!skipSubheading) {
      lines.push('### Tool Result')
      lines.push('')
    }
    const resultContent = block.content
    if (resultContent != null) {
      const asString = typeof resultContent === 'string'
        ? stripSystemReminderBlocks(resultContent)
        : safeStringify(resultContent, 2)
      const fence = looksLikeJson(asString) ? 'json' : 'text'
      const marker = markdownFenceFor(asString)
      lines.push(`${marker}${fence}`)
      lines.push(asString)
      lines.push(marker)
      lines.push('')
    }
    if (block.isError || block.is_error) {
      lines.push('*(Error)*')
      lines.push('')
    }
    return
  }

  if (type === 'image') {
    lines.push('[Image attachment]')
    lines.push('')
    return
  }

  if (type === 'thinking') {
    return
  }

  if (type === 'redacted_thinking') {
    // Redacted thinking contains no readable content
    return
  }

  // Unknown block type — render what we can
  lines.push(`*[${type ?? 'unknown'} content block]*`)
  lines.push('')
  const serialized = safeStringify(block, 2)
  const marker = markdownFenceFor(serialized)
  lines.push(`${marker}json`)
  lines.push(serialized)
  lines.push(marker)
  lines.push('')
}

function extractMessageContent(msg: Record<string, unknown>): unknown {
  if ('message' in msg && msg.message && typeof msg.message === 'object') {
    return (msg.message as Record<string, unknown>).content
  }
  if ('content' in msg) {
    return msg.content
  }
  return null
}

function looksLikeJson(s: string): boolean {
  const trimmed = s.trim()
  return (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
}

function markdownFenceFor(content: string): string {
  let longest = 0
  for (const match of content.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length)
  }
  return '`'.repeat(Math.max(3, longest + 1))
}

function safeStringify(value: unknown, indent?: number): string {
  try {
    return JSON.stringify(safeJsonValue(value), null, indent)
  } catch {
    return String(value)
  }
}

/**
 * Render messages as versioned, pretty-printed JSON suitable for
 * programmatic consumption.
 */
export function renderMessagesToJSON(messages: Message[], _tools?: Tools): string {
  // Filter out internal UI message types
  const filtered = messages.flatMap((msg, sourceIndex) => {
    if (!msg || typeof msg !== 'object') return []
    const msgType = String((msg as Record<string, unknown>).type ?? '')
    return shouldExportStructuredMessage(msg as Record<string, unknown>, msgType)
      ? [{ msg, sourceIndex }]
      : []
  })

  const exportedMessages = filtered.map(({ msg, sourceIndex }, index) => {
    const msgType = String((msg as Record<string, unknown>).type ?? 'unknown')

    const content = extractMessageContent(msg as Record<string, unknown>)
    const terminalOutputs = getTerminalOutputs(content)
    const exportedType = toExportedMessageType(msgType, content)
    const role = toRoleForContent(msgType, content)

    const exportedContent = serializeContentBlocks(content)
    const timestamp = (msg as Record<string, unknown>).timestamp as string | undefined

    const result: Record<string, unknown> = {
      index,
      sourceIndex,
      type: exportedType,
      role,
      content: exportedContent,
    }
    if (exportedType === 'unknown' && msgType && msgType !== 'unknown') {
      result.rawType = msgType
    }
    const subtype = (msg as Record<string, unknown>).subtype
    if (terminalOutputs) {
      result.subtype = terminalOutputs.every(output => output.source === 'bash')
        ? terminalOutputs.every(output => output.stream === 'stdin') ? 'bash_input' : 'bash_output'
        : 'local_command'
      result.stream = terminalOutputs.every(output => output.stream === terminalOutputs[0]!.stream)
        ? terminalOutputs[0]!.stream
        : 'mixed'
    } else if (typeof subtype === 'string') {
      result.subtype = subtype
    }
    if (typeof timestamp === 'string') {
      result.timestamp = timestamp
    }
    return result
  })

  const output = {
    version: 1,
    format: 'json',
    exportedAt: new Date().toISOString(),
    messageCount: exportedMessages.length,
    messages: exportedMessages,
  }

  return safeStringify(output, 2)
}

function toRole(type: string): string {
  switch (type) {
    case 'user':
    case 'assistant':
    case 'system':
    case 'tool':
      return type
    default:
      return 'unknown'
  }
}

function toExportedMessageType(msgType: string, content: unknown): string {
  if (getTerminalOutputs(content)) return 'system'
  if (isToolResultMessageContent(content)) return 'tool'
  if (msgType === 'user' || msgType === 'assistant' || msgType === 'system' || msgType === 'tool') {
    return msgType
  }
  if (msgType !== 'unknown') return 'unknown'
  return msgType
}

function toRoleForContent(msgType: string, content: unknown): string {
  if (getTerminalOutputs(content)) {
    return 'system'
  }
  if (isToolResultMessageContent(content)) {
    return 'tool'
  }
  return toRole(msgType)
}

function isToolResultMessageContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  const hasToolResult = content.some(isToolResultBlock)
  if (!hasToolResult) return false
  return content.every(block => isToolResultBlock(block) || isInternalTextBlock(block))
}

function isToolResultBlock(block: unknown): boolean {
  return !!block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_result'
}

function isTextBlock(block: unknown): block is { type: 'text'; text: string } {
  return !!block &&
    typeof block === 'object' &&
    (block as Record<string, unknown>).type === 'text' &&
    typeof (block as Record<string, unknown>).text === 'string'
}

function isInternalTextBlock(block: unknown): boolean {
  return isTextBlock(block) && isInternalText(block.text)
}

function serializeContentBlocks(content: unknown): unknown[] {
  if (content == null) return []
  const terminalOutputs = getTerminalOutputs(content)
  if (terminalOutputs) return serializeTerminalOutputs(terminalOutputs)
  if (typeof content === 'string') return [{ type: 'text', text: stripTopLevelInternalText(content) }]

  if (!Array.isArray(content)) {
    return [{ type: 'unknown', value: safeJsonValue(content) }]
  }

  return content
    .filter(block => !(isTextBlock(block) && isInternalText(block.text)))
    .flatMap(serializeContentBlock)
}

function serializeContentBlock(block: unknown): unknown | unknown[] {
  if (!block || typeof block !== 'object') {
    return { type: 'unknown', value: safeJsonValue(block) }
  }

  const b = block as Record<string, unknown>
  const type = typeof b.type === 'string' ? b.type : 'unknown'

  switch (type) {
    case 'text':
      if (typeof b.text !== 'string') {
        return {
          type: 'text',
          text: '',
        }
      }
      {
        const withoutReminders = stripSystemReminderBlocks(b.text)
        const terminalOutputs = parseTerminalOutputs(withoutReminders)
        if (terminalOutputs) return serializeTerminalOutputs(terminalOutputs)
        const strippedText = stripTopLevelInternalText(b.text)
        return {
          type: 'text',
          text: strippedText,
        }
      }
    case 'tool_use':
      return {
        type: 'tool_use',
        ...(b.id != null ? { id: safeJsonValue(b.id) } : {}),
        ...(b.name != null ? { name: String(b.name) } : {}),
        ...(b.input != null ? { input: safeJsonValue(b.input) } : {}),
      }
    case 'tool_result':
      const toolUseId = b.tool_use_id ?? b.toolUseId
      const isError = b.is_error ?? b.isError
      return {
        type: 'tool_result',
        ...(toolUseId != null ? { toolUseId: String(toolUseId) } : {}),
        ...(b.content != null ? { content: safeJsonValue(b.content) } : {}),
        ...(isError != null ? { isError: !!isError } : {}),
      }
    case 'image':
      return { type: 'image', ...(b.source != null ? { source: safeJsonValue(b.source) } : {}) }
    case 'thinking':
    case 'redacted_thinking':
      return []
    default:
      return { type, value: safeJsonValue(b) }
  }
}

function safeJsonValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'string') return stripSystemReminderBlocks(value)
    return value
  }
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'symbol') return value.toString()
  if (typeof value === 'function') return '[Function]'

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
    }
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    try {
      return value.map(item => safeJsonValue(item, seen))
    } catch {
      return '[Unserializable]'
    } finally {
      seen.delete(value)
    }
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    try {
      const result: Record<string, unknown> = {}
      let keys: string[]
      try {
        keys = Object.keys(value as Record<string, unknown>)
      } catch {
        return '[Unserializable]'
      }
      for (const key of keys) {
        try {
          result[key] = safeJsonValue((value as Record<string, unknown>)[key], seen)
        } catch {
          result[key] = '[Unserializable]'
        }
      }
      return result
    } finally {
      seen.delete(value)
    }
  }

  return String(value)
}

function shouldExportStructuredMessage(msg: Record<string, unknown>, msgType: string): boolean {
  if (SKIP_MESSAGE_TYPES.has(msgType)) return false
  if (msgType === 'system' && SKIP_SYSTEM_SUBTYPES.has(String(msg.subtype ?? ''))) return false
  if (msg.isMeta === true || msg.isCompactSummary === true) return false

  const content = extractMessageContent(msg)
  if (isSyntheticContent(content)) return false

  return hasExportableStructuredContent(content) || !isKnownMessageType(msgType)
}

function isSyntheticContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  const first = content[0]
  const hasSyntheticToolResult = content.some(isSyntheticToolResultBlock)
  return (isTextBlock(first) &&
    (first.text === '[Request interrupted by user]' ||
      first.text === '[Request interrupted by user for tool use]' ||
      first.text === '[Request cancelled]' ||
      first.text === '[Tool use rejected]' ||
      first.text === '[No response requested]')) ||
    (hasSyntheticToolResult && content.every(block => isSyntheticToolResultBlock(block) || isInternalTextBlock(block)))
}

function isInternalText(text: string): boolean {
  return stripTopLevelInternalText(text).length === 0
}

function isSyntheticToolResultBlock(block: unknown): boolean {
  if (!isToolResultBlock(block)) return false
  const content = (block as Record<string, unknown>).content
  return content === SYNTHETIC_TOOL_RESULT_PLACEHOLDER ||
    (Array.isArray(content) && content.every(item => isTextBlock(item) && item.text === SYNTHETIC_TOOL_RESULT_PLACEHOLDER))
}

type TerminalOutput = {
  source: 'local_command' | 'bash'
  stream: 'stdin' | 'stdout' | 'stderr'
  text: string
}

function getTerminalOutputs(content: unknown): TerminalOutput[] | null {
  if (typeof content === 'string') return parseTerminalOutputs(content)
  if (!Array.isArray(content)) return null
  const visibleBlocks = content.filter(block => block != null && !(isTextBlock(block) && isInternalText(block.text)))
  if (visibleBlocks.length !== 1) return null
  const [block] = visibleBlocks
  return isTextBlock(block) ? parseTerminalOutputs(block.text) : null
}

function parseTerminalOutputs(text: string): TerminalOutput[] | null {
  let remaining = text.trim()
  if (!remaining) return null

  const outputs: TerminalOutput[] = []
  while (remaining) {
    const output = parseWrappedOutputPrefix(remaining)
    if (!output) return null
    outputs.push(output.output)
    remaining = output.rest.trimStart()
  }

  return outputs.length > 0 ? outputs : null
}

function parseWrappedOutputPrefix(text: string): { output: TerminalOutput; rest: string } | null {
  for (const { tag, source, stream } of TERMINAL_OUTPUT_DEFINITIONS) {
    const openTagPrefix = `<${tag}`
    const closeTag = `</${tag}>`
    if (!text.startsWith(openTagPrefix)) continue
    const afterTag = text[openTagPrefix.length]
    if (afterTag !== '>' && !/\s/.test(afterTag ?? '')) continue
    const openTagEnd = text.indexOf('>')
    if (openTagEnd === -1) return null
    const closeIndex = text.indexOf(closeTag, openTagEnd + 1)
    if (closeIndex === -1) return null
    const rawText = text.slice(openTagEnd + 1, closeIndex)
    const decodedText =
      tag === BASH_STDOUT_TAG || tag === BASH_STDERR_TAG
        ? unescapeXml(rawText)
        : rawText
    return {
      output: {
        source,
        stream,
        text: decodedText,
      },
      rest: text.slice(closeIndex + closeTag.length),
    }
  }
  return null
}

const TERMINAL_OUTPUT_DEFINITIONS: ReadonlyArray<{
  tag: string
  source: TerminalOutput['source']
  stream: TerminalOutput['stream']
}> = [
  { tag: BASH_INPUT_TAG, source: 'bash', stream: 'stdin' },
  { tag: LOCAL_COMMAND_STDOUT_TAG, source: 'local_command', stream: 'stdout' },
  { tag: LOCAL_COMMAND_STDERR_TAG, source: 'local_command', stream: 'stderr' },
  { tag: BASH_STDOUT_TAG, source: 'bash', stream: 'stdout' },
  { tag: BASH_STDERR_TAG, source: 'bash', stream: 'stderr' },
]

function terminalHeading(outputs: TerminalOutput[]): string {
  if (outputs.every(output => output.source === 'bash')) {
    return outputs.every(output => output.stream === 'stdin') ? 'Bash Input' : 'Bash Output'
  }
  return 'Local Command Output'
}

function renderTextMarkdown(text: string, lines: string[]): void {
  if (!text) return
  const withoutReminders = stripSystemReminderBlocks(text)
  const terminalOutputs = parseTerminalOutputs(withoutReminders)
  const strippedText = terminalOutputs ? withoutReminders : stripTopLevelInternalText(text)
  if (!strippedText) return
  if (!terminalOutputs) {
    lines.push(strippedText)
    lines.push('')
    return
  }
  for (const output of terminalOutputs) {
    if (terminalOutputs.length > 1) {
      lines.push(`### ${output.stream.toUpperCase()}`)
      lines.push('')
    }
    if (output.text.trim()) {
      lines.push(output.text)
      lines.push('')
    }
  }
}

function serializeTerminalOutputs(outputs: TerminalOutput[]): unknown[] {
  return outputs.map(output => ({
    type: 'text',
    text: output.text,
    ...(outputs.length > 1 ? { stream: output.stream } : {}),
  }))
}

function renderUnknownContentMarkdown(content: unknown, lines: string[]): void {
  lines.push('*[unknown content]*')
  lines.push('')
  const serialized = safeStringify(content, 2)
  const marker = markdownFenceFor(serialized)
  lines.push(`${marker}json`)
  lines.push(serialized)
  lines.push(marker)
  lines.push('')
}

function stripSystemReminderBlocks(text: string): string {
  return text.replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/g, '').trim()
}

function stripTopLevelInternalText(text: string): string {
  let stripped = stripSystemReminderBlocks(text)
  for (const regex of INTERNAL_TEXT_TAG_REGEXES) {
    stripped = stripped.replace(regex, '')
  }
  return stripped.trim()
}

function internalTagRegex(tag: string): RegExp {
  const escaped = escapeRegExp(tag)
  return new RegExp(`<${escaped}\\b[^>]*>[\\s\\S]*?<\\/${escaped}>`, 'g')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isKnownMessageType(type: string): boolean {
  return type === 'user' || type === 'assistant' || type === 'system' || type === 'tool'
}

function hasExportableStructuredContent(content: unknown): boolean {
  if (content == null) return false
  if (typeof content === 'string') {
    return content.trim().length > 0 && !isInternalText(content)
  }
  if (!Array.isArray(content)) return true

  return content.some(block => {
    if (isTextBlock(block)) {
      return block.text.trim().length > 0 && !isInternalText(block.text)
    }
    if (!block || typeof block !== 'object') return block != null
    const type = (block as Record<string, unknown>).type
    if (type === 'thinking' || type === 'redacted_thinking') return false
    return true
  })
}

/**
 * Render messages for export in the specified format.
 */
export async function renderMessagesForExport(
  messages: Message[],
  tools: Tools,
  { format, columns }: { format: ExportFormat; columns?: number },
): Promise<string> {
  switch (format) {
    case 'text':
      return renderMessagesToPlainText(messages, tools, columns)
    case 'markdown':
      return renderMessagesToMarkdown(messages, tools, columns)
    case 'json':
      return renderMessagesToJSON(messages, tools)
  }
}
