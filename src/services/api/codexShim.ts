import { APIError } from '@anthropic-ai/sdk'
import { buildAnthropicUsageFromRawUsage } from './cacheMetrics.js'
import { fetchWithProxyRetry } from './fetchWithProxyRetry.js'
import { stableStringifyJson } from '../../utils/stableStringify.js'
import type {
  ResolvedCodexCredentials,
  ResolvedProviderRequest,
} from './providerConfig.js'
import { sanitizeSchemaForOpenAICompat } from './openaiSchemaSanitizer.js'
import {
  createThinkTagFilter,
  stripThinkTags,
} from './thinkTagSanitizer.js'
import {
  createReaderCanceller,
  createStreamAbortError,
  readWithIdleTimeout,
  throwIfStreamAborted,
} from './openaiShim/streamControl.js'
import {
  flushInterruptionTrace,
  getInterruptionSignalAbortEventId,
  setInterruptionErrorCausalEventId,
  traceInterruptionEvent,
} from '../../utils/interruptionTrace.js'

export interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

export interface AnthropicStreamEvent {
  type: string
  message?: Record<string, unknown>
  index?: number
  content_block?: Record<string, unknown>
  delta?: Record<string, unknown>
  usage?: Partial<AnthropicUsage>
}

export interface ShimCreateParams {
  model: string
  messages: Array<Record<string, unknown>>
  system?: unknown
  tools?: Array<Record<string, unknown>>
  max_tokens: number
  stream?: boolean
  temperature?: number
  top_p?: number
  tool_choice?: unknown
  metadata?: unknown
  [key: string]: unknown
}

type ResponsesInputPart =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'text'; text: string }
  | { type: 'input_image'; image_url: string }

type ResponsesInputItem =
  | {
      type: 'message'
      role: 'user' | 'assistant'
      content: ResponsesInputPart[]
    }
  | {
      type: 'function_call'
      id: string
      call_id: string
      name: string
      arguments: string
    }
  | {
      type: 'function_call_output'
      call_id: string
      output: string
    }

type ResponsesTool = {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
  strict?: boolean
}

type CodexSseEvent = {
  event: string
  data: Record<string, any>
}

function makeUsage(usage?: Record<string, unknown>): AnthropicUsage {
  // Single source of truth for raw → Anthropic shape. Lives in
  // cacheMetrics.ts alongside the raw-shape extractor so any new
  // provider quirk requires a one-file change and the integration test
  // can call the exact same function instead of re-implementing it.
  return buildAnthropicUsageFromRawUsage(usage)
}

function makeMessageId(): string {
  return `msg_${crypto.randomUUID().replace(/-/g, '')}`
}

function normalizeToolUseId(toolUseId: string | undefined): {
  id: string
  callId: string
} {
  const value = (toolUseId || '').trim()
  if (!value) {
    return {
      id: 'fc_unknown',
      callId: 'call_unknown',
    }
  }
  if (value.startsWith('call_')) {
    return {
      id: `fc_${value.slice('call_'.length)}`,
      callId: value,
    }
  }
  if (value.startsWith('fc_')) {
    return {
      id: value,
      callId: `call_${value.slice('fc_'.length)}`,
    }
  }
  return {
    id: `fc_${value}`,
    callId: value,
  }
}

export function convertSystemPrompt(system: unknown): string {
  if (!system) return ''
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system
      .map((block: { type?: string; text?: string }) =>
        block.type === 'text' ? (block.text ?? '') : '',
      )
      // Drop the Anthropic billing/attribution block — Codex's Responses API
      // doesn't parse it and the per-build fingerprint just churns the
      // upstream prompt cache.
      .filter(text => !text.startsWith('x-anthropic-billing-header'))
      .join('\n\n')
  }
  return String(system)
}

function convertToolResultToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content ?? '')

  const chunks: string[] = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      chunks.push(block.text)
      continue
    }

    // ToolSearch results are tool_reference blocks with no text payload. On
    // the Anthropic wire the API expands them server-side; here we render
    // them as text — the full schema arrives in the next request's tools
    // array (see the discovered-tools filter in claude.ts).
    if (block?.type === 'tool_reference' && typeof block.tool_name === 'string') {
      chunks.push(`Tool "${block.tool_name}" is now loaded and available to call.`)
      continue
    }

    if (block?.type === 'image') {
      const src = block.source
      if (src?.type === 'url' && src.url) {
        chunks.push(`[Image](${src.url})`)
      }
      continue
    }

    if (typeof block?.text === 'string') {
      chunks.push(block.text)
    }
  }

  return chunks.join('\n')
}

function convertContentBlocksToResponsesParts(
  content: unknown,
  role: 'user' | 'assistant',
  forceTextChunks: boolean,
): ResponsesInputPart[] {
  const textType = !forceTextChunks ? (role === 'assistant' ? 'output_text' : 'input_text') : 'text'
  if (typeof content === 'string') {
    return [{ type: textType, text: content }]
  }
  if (!Array.isArray(content)) {
    return [{ type: textType, text: String(content ?? '') }]
  }

  const parts: ResponsesInputPart[] = []
  for (const block of content) {
    switch (block?.type) {
      case 'text':
        parts.push({ type: textType, text: block.text ?? '' })
        break
      case 'image': {
        if (role === 'assistant') break
        const source = block.source
        if (source?.type === 'base64') {
          parts.push({
            type: 'input_image',
            image_url: `data:${source.media_type};base64,${source.data}`,
          })
        } else if (source?.type === 'url' && source.url) {
          parts.push({
            type: 'input_image',
            image_url: source.url,
          })
        }
        break
      }
      case 'thinking':
        if (block.thinking) {
          parts.push({
            type: textType,
            text: `<thinking>${block.thinking}</thinking>`,
          })
        }
        break
      case 'tool_use':
      case 'tool_result':
        break
      default:
        if (typeof block?.text === 'string') {
          parts.push({ type: textType, text: block.text })
        }
    }
  }

  return parts
}

export function convertAnthropicMessagesToResponsesInput(
  compressedMessages: Array<{
    role?: string
    message?: { role?: string; content?: unknown }
    content?: unknown
  }>,
  forceTextChunks = false,
): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = []

  for (const item of compressedMessages) {
    const rawRole = item.message?.role ?? item.role
    const role =
      rawRole === 'assistant' || rawRole === 'model' ? 'assistant' : 'user'

    const contentRaw = item.message?.content ?? item.content
    const content = Array.isArray(contentRaw)
      ? contentRaw
      : [{ type: 'text', text: String(contentRaw ?? '') }]

    if (role === 'user') {
      const toolResults = content.filter(
        (block: { type?: string }) => block.type === 'tool_result',
      )

      if (toolResults.length > 0) {
        const otherContent = content.filter(
          (block: { type?: string }) => block.type !== 'tool_result',
        )

        for (const toolResult of toolResults) {
          const { callId } = normalizeToolUseId(toolResult.tool_use_id)
          items.push({
            type: 'function_call_output',
            call_id: callId,
            output: (() => {
              const out = convertToolResultToText(toolResult.content)
              return toolResult.is_error ? `Error: ${out}` : out
            })(),
          })
        }

        const parts = convertContentBlocksToResponsesParts(otherContent, 'user', forceTextChunks)
        if (parts.length > 0) {
          items.push({
            type: 'message',
            role: 'user',
            content: parts,
          })
        }
        continue
      }

      items.push({
        type: 'message',
        role: 'user',
        content: convertContentBlocksToResponsesParts(content, 'user', forceTextChunks),
      })
      continue
    }

    if (role === 'assistant') {
      const textBlocks = Array.isArray(content)
        ? content.filter((block: { type?: string }) =>
            block.type !== 'tool_use' && block.type !== 'thinking')
        : content
      const parts = convertContentBlocksToResponsesParts(textBlocks, 'assistant', forceTextChunks)
      if (parts.length > 0) {
        items.push({
          type: 'message',
          role: 'assistant',
          content: parts,
        })
      }

      if (Array.isArray(content)) {
        for (const toolUse of content.filter(
          (block: { type?: string }) => block.type === 'tool_use',
        )) {
          const normalized = normalizeToolUseId(toolUse.id)
          items.push({
            type: 'function_call',
            id: normalized.id,
            call_id: normalized.callId,
            name: toolUse.name ?? 'tool',
            arguments:
              typeof toolUse.input === 'string'
                ? toolUse.input
                : JSON.stringify(toolUse.input ?? {}),
          })
        }
      }
    }
  }

  return items.filter(item =>
    item.type !== 'message' || item.content.length > 0,
  )
}

/**
 * Codex Responses strict mode requires every schema node to declare a `type`.
 * MCP tools sometimes register properties with no `type` (e.g. a generic
 * `value` parameter intended to accept any JSON), which triggers a 400 from
 * the Responses API: `schema must have a 'type' key`. Infer one from sibling
 * keys, fall back to `string` for fully empty nodes, and leave combinator-only
 * schemas alone (their branches carry the real type info).
 */
function ensureSchemaType(record: Record<string, unknown>): void {
  const raw = record.type
  if (typeof raw === 'string') return
  if (Array.isArray(raw) && raw.length > 0) return

  if (record.properties && typeof record.properties === 'object') {
    record.type = 'object'
    return
  }
  if ('items' in record) {
    record.type = 'array'
    return
  }
  if (Array.isArray((record as Record<string, unknown>).anyOf) ||
      Array.isArray((record as Record<string, unknown>).oneOf) ||
      Array.isArray((record as Record<string, unknown>).allOf)) {
    // Combinator-only schemas keep their semantics; forcing a `type` here
    // would silently narrow the alternatives.
    return
  }
  if (Array.isArray(record.enum) && record.enum.length > 0) {
    const sample = typeof record.enum[0]
    if (sample === 'string' || sample === 'boolean') {
      record.type = sample
      return
    }
    if (sample === 'number') {
      record.type = record.enum.every(v => Number.isInteger(v)) ? 'integer' : 'number'
      return
    }
  }
  if ('const' in record) {
    const sample = typeof record.const
    if (sample === 'string' || sample === 'boolean') {
      record.type = sample
      return
    }
    if (sample === 'number') {
      record.type = Number.isInteger(record.const) ? 'integer' : 'number'
      return
    }
  }

  // Permissive default: strict mode demands a concrete type, and `string`
  // round-trips through JSON.stringify for callers that need to forward raw
  // values to the underlying tool.
  record.type = 'string'
}

/**
 * Recursively enforces Codex strict-mode constraints on a JSON schema:
 * - Every `object` type gets `additionalProperties: false`
 * - All property keys are listed in `required`
 * - Nested schemas (properties, items, anyOf/oneOf/allOf) are processed too
 */
function enforceStrictSchema(schema: unknown): Record<string, unknown> {
  const record = sanitizeSchemaForOpenAICompat(schema)

  ensureSchemaType(record)

  // Codex Responses rejects JSON Schema's standard `uri` string format.
  // Keep URL validation in the tool layer and send a plain string here.
  if (record.format === 'uri') {
    delete record.format
  }

  if (record.type === 'object') {
    // OpenAI structured outputs completely forbid dynamic additionalProperties.
    // They must be set to false unconditionally.
    record.additionalProperties = false

    if (
      record.properties &&
      typeof record.properties === 'object' &&
      !Array.isArray(record.properties)
    ) {
      const props = record.properties as Record<string, unknown>

      const enforcedProps: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(props)) {
        const strictValue = enforceStrictSchema(value)
        // If the resulting schema is an empty object (no properties), OpenAI structured outputs will likely
        // strip it silently and then complain about a 'required' mismatch if it remains in the required list.
        // E.g. z.record() objects (like AskUserQuestion.answers) lose their schema due to additionalProperties 
        // restrictions. We can safely drop these from the schema sent to the LLM.
        if (
          strictValue &&
          typeof strictValue === 'object' &&
          strictValue.type === 'object' &&
          strictValue.additionalProperties === false &&
          (!strictValue.properties || Object.keys(strictValue.properties).length === 0)
        ) {
          continue
        }
        enforcedProps[key] = strictValue
      }
      record.properties = enforcedProps
      record.required = Object.keys(enforcedProps)
    } else {
      // No properties — empty object schema with empty required array
      record.properties = {}
      record.required = []
    }
  }

  // Recurse into array items
  if ('items' in record) {
    if (Array.isArray(record.items)) {
      record.items = (record.items as unknown[]).map(item => enforceStrictSchema(item))
    } else {
      record.items = enforceStrictSchema(record.items)
    }
  }

  // Recurse into combinators
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (key in record && Array.isArray(record[key])) {
      record[key] = (record[key] as unknown[]).map(item => enforceStrictSchema(item))
    }
  }

  return record
}

export function convertToolsToResponsesTools(
  tools: Array<{ name?: string; description?: string; input_schema?: Record<string, unknown> }>,
): ResponsesTool[] {
  // Note: ToolSearch (the deferral discovery tool) must reach the wire as a
  // regular function — claude.ts already removes it when tool search is off.
  return tools
    .filter(tool => tool.name)
    .map(tool => {
      const rawParameters = tool.input_schema ?? { type: 'object', properties: {} }
      // Codex requires strict schemas: all properties must be required
      const parameters = enforceStrictSchema(rawParameters)

      return {
        type: 'function',
        name: tool.name ?? 'tool',
        description: tool.description ?? '',
        parameters,
        strict: true,
      }
    })
}

function isStrictResponsesSchema(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return true
  }

  const record = schema as Record<string, unknown>
  const type = record.type

  if (type === 'object') {
    const properties =
      record.properties && typeof record.properties === 'object' && !Array.isArray(record.properties)
        ? (record.properties as Record<string, unknown>)
        : {}

    const propertyKeys = Object.keys(properties)
    const required = Array.isArray(record.required)
      ? record.required.filter((value): value is string => typeof value === 'string')
      : null

    if (propertyKeys.length > 0) {
      if (!required) return false

      const requiredSet = new Set(required)
      for (const key of propertyKeys) {
        if (!requiredSet.has(key)) {
          return false
        }
      }
    }

    for (const child of Object.values(properties)) {
      if (!isStrictResponsesSchema(child)) {
        return false
      }
    }
  }

  const combinators = ['anyOf', 'oneOf', 'allOf'] as const
  for (const key of combinators) {
    if (key in record) {
      const value = record[key]
      if (!Array.isArray(value) || value.some(item => !isStrictResponsesSchema(item))) {
        return false
      }
    }
  }

  if ('items' in record) {
    const items = record.items
    if (Array.isArray(items)) {
      return items.every(item => isStrictResponsesSchema(item))
    }
    return isStrictResponsesSchema(items)
  }

  return true
}

function convertToolChoice(toolChoice: unknown): unknown {
  const choice = toolChoice as { type?: string; name?: string } | undefined
  if (!choice?.type) return undefined
  if (choice.type === 'auto') return 'auto'
  if (choice.type === 'any') return 'required'
  if (choice.type === 'none') return 'none'
  if (choice.type === 'tool' && choice.name) {
    return {
      type: 'function',
      name: choice.name,
    }
  }
  return undefined
}

export async function performCodexRequest(options: {
  request: ResolvedProviderRequest
  credentials: ResolvedCodexCredentials
  params: ShimCreateParams
  defaultHeaders: Record<string, string>
  signal?: AbortSignal
  fetcher?: typeof fetchWithProxyRetry
}): Promise<Response> {
  // No tool-history compression on the Codex transport: Codex talks to
  // OpenAI Responses backends, which do implicit prefix caching, and
  // compressToolHistory's end-relative window rewrites already-sent tool
  // results each turn — mutating the request prefix and forfeiting the
  // cache, which costs more than the compression saves. This mirrors the
  // prefix-caching skip in openaiShim/requestPreparation.ts; context
  // pressure is handled by the compaction machinery, as on the native
  // Anthropic transport.
  const rawMessages = options.params.messages as Array<{
    role?: string
    message?: { role?: string; content?: unknown }
    content?: unknown
  }>
  const input = convertAnthropicMessagesToResponsesInput(rawMessages)
  const body: Record<string, unknown> = {
    model: options.request.resolvedModel,
    input: input.length > 0
      ? input
      : [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '' }],
          },
        ],
    store: false,
    stream: true,
  }

  const instructions = convertSystemPrompt(options.params.system)
  if (instructions) {
    body.instructions = instructions
  }

  const toolChoice = convertToolChoice(options.params.tool_choice)
  if (toolChoice) {
    body.tool_choice = toolChoice
  }

  if (options.params.tools && options.params.tools.length > 0) {
    const convertedTools = convertToolsToResponsesTools(
      options.params.tools as Array<{
        name?: string
        description?: string
        input_schema?: Record<string, unknown>
      }>,
    )
    if (convertedTools.length > 0) {
      body.tools = convertedTools
      body.parallel_tool_calls = true
      body.tool_choice ??= 'auto'
    }
  }

  if (options.request.reasoning) {
    body.reasoning = options.request.reasoning
  }

  const isTargetModel =
    options.request.resolvedModel?.toLowerCase().includes('gpt') ||
    options.request.resolvedModel?.toLowerCase().includes('codex')

  // Only pass temperature and top_p if it's not a GPT/Codex model that rejects them
  if (!isTargetModel) {
    if (options.params.temperature !== undefined) {
      body.temperature = options.params.temperature
    }
    if (options.params.top_p !== undefined) {
      body.top_p = options.params.top_p
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.defaultHeaders,
    Authorization: `Bearer ${options.credentials.apiKey}`,
  }
  if (options.credentials.accountId) {
    headers['chatgpt-account-id'] = options.credentials.accountId
  }
  headers.originator ??= 'openclaude'

  const response = await (options.fetcher ?? fetchWithProxyRetry)(
    `${options.request.baseUrl}/responses`,
    {
      method: 'POST',
      headers,
      // WHY: byte-identity required for implicit prefix caching on
      // OpenAI Responses API. See src/utils/stableStringify.ts.
      body: stableStringifyJson(body),
      signal: options.signal,
    },
  )

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'unknown error')
    let errorResponse: object | undefined
    try { errorResponse = JSON.parse(errorBody) } catch { /* raw text */ }
    throw APIError.generate(
      response.status, errorResponse,
      `Codex API error ${response.status}: ${errorBody}`,
      response.headers as unknown as Headers,
    )
  }

  return response
}

type CodexStreamReadOptions = {
  /** Internal deterministic-test seam; production keeps the 120-second owner. */
  idleTimeoutMs?: number
  onCausalEventId?: (eventId: string) => void
}

const STREAM_IDLE_TIMEOUT_MS = 120_000

async function* readSseEvents(
  response: Response,
  signal?: AbortSignal,
  options: CodexStreamReadOptions = {},
): AsyncGenerator<CodexSseEvent> {
  const reader = response.body?.getReader()
  if (!reader) return
  const readerCanceller = createReaderCanceller(reader, signal)

  const decoder = new TextDecoder()
  let buffer = ''
  const streamIdleTimeoutMs = options.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS
  let lastDataTime = performance.now()
  let lastParsedFrameTime = lastDataTime
  let transportComplete = false
  let protocolComplete = false
  let doneMarkerObserved = false
  let rawByteCount = 0
  let sawFirstRawByte = false
  let parsedFrameCount = 0
  let controlFrameCount = 0
  let ignoredFrameCount = 0
  let streamCausalEventId: string | undefined

  traceInterruptionEvent('codex_stream.read_started', {
    subsystem: 'codex_stream',
    transport: 'codex_responses',
  })

  /**
   * Read from the stream with an idle timeout. Respects the caller's
   * AbortSignal — clears the idle timer on abort so the AbortError
   * surfaces cleanly instead of a spurious idle timeout.
   */
  async function readWithTimeout() {
    return readWithIdleTimeout(reader!, streamIdleTimeoutMs, {
      signal,
      cancelReader: readerCanceller.cancel,
      createTimeoutError: () => {
        const elapsed = Math.round((performance.now() - lastDataTime) / 1000)
        return new Error(
          `Codex SSE stream idle for ${elapsed}s (limit: ${streamIdleTimeoutMs / 1000}s). Connection likely dropped.`,
        )
      },
      onTimeout: error => {
        const now = performance.now()
        streamCausalEventId = traceInterruptionEvent('codex_stream.idle_timeout', {
          subsystem: 'codex_stream',
          transport: 'codex_responses',
          sinceLastRawByteMs: now - lastDataTime,
          sinceLastParsedFrameMs: now - lastParsedFrameTime,
          rawByteCount,
          parsedFrameCount,
          controlFrameCount,
          ignoredFrameCount,
        })
        if (streamCausalEventId) {
          options.onCausalEventId?.(streamCausalEventId)
        }
        setInterruptionErrorCausalEventId(error, streamCausalEventId)
        flushInterruptionTrace('codex_stream_idle_timeout')
      },
    })
  }

  try {
    streamLoop: while (true) {
      const { done, value } = await readWithTimeout()
      if (done) {
        transportComplete = true
        traceInterruptionEvent('codex_stream.eof', {
          subsystem: 'codex_stream',
          transport: 'codex_responses',
          rawByteCount,
          parsedFrameCount,
          controlFrameCount,
          ignoredFrameCount,
        })
        break
      }

      throwIfStreamAborted(signal)
      if (value && value.byteLength > 0) {
        lastDataTime = performance.now()
        rawByteCount += value.byteLength
        if (!sawFirstRawByte) {
          sawFirstRawByte = true
          traceInterruptionEvent('codex_stream.first_raw_byte', {
            subsystem: 'codex_stream',
            transport: 'codex_responses',
            rawByteCount,
          })
        }
      }
      buffer += decoder.decode(value, { stream: true })
      const chunks = buffer.split('\n\n')
      buffer = chunks.pop() ?? ''

      for (const chunk of chunks) {
        throwIfStreamAborted(signal)
        const lines = chunk
          .split('\n')
          .map(line => line.trim())
          .filter(Boolean)
        if (lines.length === 0) continue

        if (lines.every(line => line.startsWith(':'))) {
          controlFrameCount++
          continue
        }

        const eventLine = lines.find(line => line.startsWith('event: '))
        const dataLines = lines.filter(line => line.startsWith('data: '))
        if (dataLines.length === 0) {
          controlFrameCount++
          continue
        }

        const rawData = dataLines.map(line => line.slice(6)).join('\n')
        if (rawData === '[DONE]') {
          doneMarkerObserved = true
          controlFrameCount++
          traceInterruptionEvent('codex_stream.control_frame', {
            subsystem: 'codex_stream',
            transport: 'codex_responses',
            phase: 'done_marker',
            rawByteCount,
            parsedFrameCount,
            controlFrameCount,
            ignoredFrameCount,
          })
          continue
        }

        let data: Record<string, any>
        try {
          const parsed = JSON.parse(rawData)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            ignoredFrameCount++
            continue
          }
          data = parsed as Record<string, any>
        } catch {
          ignoredFrameCount++
          continue
        }

        const event = eventLine?.slice(7).trim() ??
          (typeof data.type === 'string' ? data.type : undefined)
        if (!event) {
          controlFrameCount++
          continue
        }

        throwIfStreamAborted(signal)
        parsedFrameCount++
        lastParsedFrameTime = performance.now()
        if (parsedFrameCount === 1) {
          traceInterruptionEvent('codex_stream.first_parsed_frame', {
            subsystem: 'codex_stream',
            transport: 'codex_responses',
            rawByteCount,
            parsedFrameCount,
            controlFrameCount,
            ignoredFrameCount,
          })
        }
        const isTerminalEvent =
          event === 'response.completed' ||
          event === 'response.incomplete' ||
          event === 'response.failed'
        if (isTerminalEvent) {
          protocolComplete = true
          traceInterruptionEvent('codex_stream.protocol_terminal', {
            subsystem: 'codex_stream',
            transport: 'codex_responses',
            phase: event,
            rawByteCount,
            parsedFrameCount,
            controlFrameCount,
            ignoredFrameCount,
          })
        }
        yield { event, data }
        if (isTerminalEvent) break streamLoop
      }
      if (doneMarkerObserved) {
        protocolComplete = true
        break
      }
    }
  } catch (error) {
    traceInterruptionEvent('codex_stream.error', {
      subsystem: 'codex_stream',
      transport: 'codex_responses',
      outcome: signal?.aborted ? 'root_aborted' : 'external_error',
      reason: signal?.reason,
      causalEventId:
        (signal && getInterruptionSignalAbortEventId(signal)) ??
        streamCausalEventId,
      error,
      rawByteCount,
      parsedFrameCount,
      controlFrameCount,
      ignoredFrameCount,
    })
    flushInterruptionTrace('codex_stream_error')
    throw error
  } finally {
    const readerWasInterrupted =
      (!transportComplete && !protocolComplete) || signal?.aborted
    if (readerWasInterrupted) {
      const causalEventId =
        (signal && getInterruptionSignalAbortEventId(signal)) ??
        streamCausalEventId
      traceInterruptionEvent('codex_stream.cancelled', {
        subsystem: 'codex_stream',
        transport: 'codex_responses',
        reason: signal?.reason,
        causalEventId,
        rawByteCount,
        parsedFrameCount,
        controlFrameCount,
        ignoredFrameCount,
      })
    }
    if (!transportComplete) readerCanceller.cancel(createStreamAbortError())
    readerCanceller.cleanup()
    reader.releaseLock()
    if (readerWasInterrupted) {
      flushInterruptionTrace('codex_stream_reader_closed')
    }
  }
}

function determineStopReason(
  response: Record<string, any> | undefined,
  sawToolUse: boolean,
): 'end_turn' | 'tool_use' | 'max_tokens' {
  const output = Array.isArray(response?.output) ? response.output : []
  if (
    sawToolUse ||
    output.some((item: { type?: string }) => item?.type === 'function_call')
  ) {
    return 'tool_use'
  }

  const incompleteReason = response?.incomplete_details?.reason
  if (
    typeof incompleteReason === 'string' &&
    incompleteReason.includes('max_output_tokens')
  ) {
    return 'max_tokens'
  }

  return 'end_turn'
}

export async function collectCodexCompletedResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<Record<string, any>> {
  let completedResponse: Record<string, any> | undefined

  for await (const event of readSseEvents(response, signal)) {
    if (event.event === 'response.failed') {
      const msg = event.data?.response?.error?.message ??
        event.data?.error?.message ?? 'Codex response failed'
      throw APIError.generate(500, undefined, msg, new Headers())
    }

    if (
      event.event === 'response.completed' ||
      event.event === 'response.incomplete'
    ) {
      completedResponse = event.data?.response
      break
    }
  }

  if (!completedResponse) {
    throw APIError.generate(
      500, undefined, 'Codex response ended without a completed payload',
      new Headers(),
    )
  }

  return completedResponse
}

async function* codexStreamToAnthropicWithReadOptions(
  response: Response,
  model: string,
  signal?: AbortSignal,
  readOptions: CodexStreamReadOptions = {},
): AsyncGenerator<AnthropicStreamEvent> {
  const messageId = makeMessageId()
  const toolBlocksByItemId = new Map<
    string,
    { index: number; toolUseId: string; emittedArgs: string }
  >()
  let activeTextBlockIndex: number | null = null
  const thinkFilter = createThinkTagFilter()
  let nextContentBlockIndex = 0
  let sawToolUse = false
  let finalResponse: Record<string, any> | undefined
  let streamComplete = false
  let providerTerminalObserved = false
  let converterFailed = false
  let streamCausalEventId: string | undefined
  let ignoredParsedFrameCount = 0
  const cancelResponseBody = () => {
    void response.body?.cancel(createStreamAbortError()).catch(() => {})
  }
  signal?.addEventListener('abort', cancelResponseBody, { once: true })

  const closeActiveTextBlock = async function* () {
    if (activeTextBlockIndex === null) return
    const tail = thinkFilter.flush()
    if (tail) {
      throwIfStreamAborted(signal)
      yield {
        type: 'content_block_delta',
        index: activeTextBlockIndex,
        delta: {
          type: 'text_delta',
          text: tail,
        },
      }
    }
    throwIfStreamAborted(signal)
    yield {
      type: 'content_block_stop',
      index: activeTextBlockIndex,
    }
    activeTextBlockIndex = null
  }

  const startTextBlockIfNeeded = async function* () {
    if (activeTextBlockIndex !== null) return
    activeTextBlockIndex = nextContentBlockIndex++
    throwIfStreamAborted(signal)
    yield {
      type: 'content_block_start',
      index: activeTextBlockIndex,
      content_block: { type: 'text', text: '' },
    }
  }

  try {
    throwIfStreamAborted(signal)

    yield {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: makeUsage(),
      },
    }

    for await (const event of readSseEvents(response, signal, {
      ...readOptions,
      onCausalEventId: eventId => {
        streamCausalEventId = eventId
        readOptions.onCausalEventId?.(eventId)
      },
    })) {
      throwIfStreamAborted(signal)
      const payload = event.data

      if (event.event === 'response.output_item.added') {
        const item = payload.item
        if (item?.type === 'function_call') {
          yield* closeActiveTextBlock()
          throwIfStreamAborted(signal)
          const blockIndex = nextContentBlockIndex++
          const toolUseId = item.call_id ?? item.id ?? `call_${blockIndex}`
          const initialArgs =
            typeof item.arguments === 'string' ? item.arguments : ''
          toolBlocksByItemId.set(String(item.id ?? toolUseId), {
            index: blockIndex,
            toolUseId,
            emittedArgs: initialArgs,
          })
          sawToolUse = true

          throwIfStreamAborted(signal)
          yield {
            type: 'content_block_start',
            index: blockIndex,
            content_block: {
              type: 'tool_use',
              id: toolUseId,
              name: item.name ?? 'tool',
              input: {},
            },
          }

          if (initialArgs) {
            throwIfStreamAborted(signal)
            yield {
              type: 'content_block_delta',
              index: blockIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: initialArgs,
              },
            }
          }
        }
        continue
      }

      if (event.event === 'response.content_part.added') {
        if (payload.part?.type === 'output_text') {
          yield* startTextBlockIfNeeded()
        }
        continue
      }

      if (event.event === 'response.output_text.delta') {
        yield* startTextBlockIfNeeded()
        if (activeTextBlockIndex !== null) {
          throwIfStreamAborted(signal)
          const visible = thinkFilter.feed(payload.delta ?? '')
          if (visible) {
            throwIfStreamAborted(signal)
            yield {
              type: 'content_block_delta',
              index: activeTextBlockIndex,
              delta: {
                type: 'text_delta',
                text: visible,
              },
            }
          }
        }
        continue
      }

      if (event.event === 'response.function_call_arguments.delta') {
        const toolBlock = toolBlocksByItemId.get(String(payload.item_id ?? ''))
        if (toolBlock) {
          const delta = typeof payload.delta === 'string' ? payload.delta : ''
          if (delta) {
            toolBlock.emittedArgs += delta
            throwIfStreamAborted(signal)
            yield {
              type: 'content_block_delta',
              index: toolBlock.index,
              delta: {
                type: 'input_json_delta',
                partial_json: delta,
              },
            }
          }
        }
        continue
      }

      // Some Codex Responses backends (codexspark / gpt-5.3-codex-spark) deliver
      // the *complete* function-call arguments only via the terminal
      // `response.function_call_arguments.done` event, with zero
      // `response.function_call_arguments.delta` events in between. Without
      // handling `done`, the tool block closed with `input: {}` and downstream
      // tool validation failed with "required parameter X is missing" (#1259).
      if (event.event === 'response.function_call_arguments.done') {
        const toolBlock = toolBlocksByItemId.get(String(payload.item_id ?? ''))
        if (toolBlock) {
          const fullArgs =
            typeof payload.arguments === 'string' ? payload.arguments : ''
          if (fullArgs && !toolBlock.emittedArgs) {
            toolBlock.emittedArgs = fullArgs
            throwIfStreamAborted(signal)
            yield {
              type: 'content_block_delta',
              index: toolBlock.index,
              delta: {
                type: 'input_json_delta',
                partial_json: fullArgs,
              },
            }
          }
        }
        continue
      }

      if (event.event === 'response.output_item.done') {
        const item = payload.item
        if (item?.type === 'function_call') {
          const toolBlock = toolBlocksByItemId.get(String(item.id ?? ''))
          if (toolBlock) {
            // Backstop for backends that skip the dedicated `function_call_arguments.done`
            // event entirely and only put the full arguments on `output_item.done`.
            // Same #1259 failure mode; trust whichever channel actually carried the data.
            const finalArgs =
              typeof item.arguments === 'string' ? item.arguments : ''
            if (finalArgs && !toolBlock.emittedArgs) {
              toolBlock.emittedArgs = finalArgs
              throwIfStreamAborted(signal)
              yield {
                type: 'content_block_delta',
                index: toolBlock.index,
                delta: {
                  type: 'input_json_delta',
                  partial_json: finalArgs,
                },
              }
            }
            throwIfStreamAborted(signal)
            yield {
              type: 'content_block_stop',
              index: toolBlock.index,
            }
            toolBlocksByItemId.delete(String(item.id))
          }
        } else if (item?.type === 'message') {
          yield* closeActiveTextBlock()
        }
        continue
      }

      if (
        event.event === 'response.completed' ||
        event.event === 'response.incomplete'
      ) {
        providerTerminalObserved = true
        finalResponse = payload.response
        break
      }

      if (event.event === 'response.failed') {
        providerTerminalObserved = true
        const msg = payload?.response?.error?.message ??
          payload?.error?.message ?? 'Codex response failed'
        throw APIError.generate(500, undefined, msg, new Headers())
      }

      ignoredParsedFrameCount++
      if (ignoredParsedFrameCount === 1) {
        traceInterruptionEvent('codex_stream.first_parsed_frame_ignored', {
          subsystem: 'codex_stream',
          transport: 'codex_responses',
          ignoredParsedFrameCount,
        })
      }
    }

    throwIfStreamAborted(signal)
    yield* closeActiveTextBlock()
    for (const toolBlock of toolBlocksByItemId.values()) {
      throwIfStreamAborted(signal)
      yield {
        type: 'content_block_stop',
        index: toolBlock.index,
      }
    }

    throwIfStreamAborted(signal)
    yield {
      type: 'message_delta',
      delta: {
        stop_reason: determineStopReason(finalResponse, sawToolUse),
        stop_sequence: null,
      },
      // Delegate to the shared normalizer so the streaming message_delta
      // path uses the same raw→Anthropic conversion as makeUsage() above
      // and the non-streaming response converter below. Previously this
      // block had its own inline subtraction that missed Kimi / DeepSeek
      // / Gemini raw shapes that the shared helper handles.
      usage: makeUsage(
        finalResponse?.usage as Record<string, unknown> | undefined,
      ),
    }
    throwIfStreamAborted(signal)
    streamComplete = true
    yield { type: 'message_stop' }
  } catch (error) {
    converterFailed = true
    throw error
  } finally {
    const terminalComplete = providerTerminalObserved && !converterFailed
    traceInterruptionEvent('codex_stream.converter_closed', {
      subsystem: 'codex_stream',
      transport: 'codex_responses',
      outcome: signal?.aborted
        ? 'root_aborted'
        : converterFailed
          ? 'failed'
          : streamComplete || terminalComplete
            ? 'complete'
            : 'incomplete',
      reason: signal?.reason,
      causalEventId:
        (signal && getInterruptionSignalAbortEventId(signal)) ??
        streamCausalEventId,
      ignoredParsedFrameCount,
    })
    if ((!streamComplete && !terminalComplete) || signal?.aborted) {
      cancelResponseBody()
      flushInterruptionTrace('codex_stream_converter_closed')
    }
    signal?.removeEventListener('abort', cancelResponseBody)
  }
}

export function codexStreamToAnthropic(
  response: Response,
  model: string,
  signal?: AbortSignal,
): AsyncGenerator<AnthropicStreamEvent> {
  return codexStreamToAnthropicWithReadOptions(response, model, signal)
}

/** Deterministic reader-deadline seam for interruption regressions only. */
export function __codexStreamToAnthropicForTests(
  response: Response,
  model: string,
  signal: AbortSignal | undefined,
  readOptions: CodexStreamReadOptions,
): AsyncGenerator<AnthropicStreamEvent> {
  return codexStreamToAnthropicWithReadOptions(
    response,
    model,
    signal,
    readOptions,
  )
}

export function convertCodexResponseToAnthropicMessage(
  data: Record<string, any>,
  model: string,
): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = []
  const output = Array.isArray(data.output) ? data.output : []

  for (const item of output) {
    if (item?.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === 'output_text') {
          content.push({
            type: 'text',
            text: stripThinkTags(part.text ?? ''),
          })
        }
      }
      continue
    }

    if (item?.type === 'function_call') {
      let input: unknown
      try {
        input = JSON.parse(item.arguments ?? '{}')
      } catch {
        input = { raw: item.arguments ?? '' }
      }

      content.push({
        type: 'tool_use',
        id: item.call_id ?? item.id ?? makeMessageId(),
        name: item.name ?? 'tool',
        input,
      })
    }
  }

  return {
    id: data.id ?? makeMessageId(),
    type: 'message',
    role: 'assistant',
    content,
    model: data.model ?? model,
    stop_reason: determineStopReason(data, content.some(item => item.type === 'tool_use')),
    stop_sequence: null,
    usage: makeUsage(data.usage),
  }
}
