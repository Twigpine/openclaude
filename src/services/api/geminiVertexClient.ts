import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError, type ClientOptions } from '@anthropic-ai/sdk'
import type { MessageCreateParamsBase } from '@anthropic-ai/sdk/resources/messages/messages'
import { raceAbort, throwIfAborted } from '../../utils/boundedAsync.js'
import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import { getGeminiVertexEndpointError } from '../../utils/geminiAuth.js'

type AccessTokenProvider = () => Promise<string>

type GeminiVertexClientOptions = {
  project: string
  location: string
  model: string
  getAccessToken: AccessTokenProvider
  fetch?: NonNullable<ClientOptions['fetch']>
}

type GeminiVertexFunctionCallPart = {
  functionCall: { name: string; args?: Record<string, unknown> }
  // Gemini thinking models (gemini-3.x, 2.5-pro) attach an opaque
  // thoughtSignature to each functionCall part. It MUST be echoed back when the
  // call is replayed in history, or Vertex rejects the request with 400.
  thoughtSignature?: string
}
type GeminiVertexFunctionResponsePart = {
  functionResponse: { name: string; response: Record<string, unknown> }
}
type GeminiVertexPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | GeminiVertexFunctionCallPart
  | GeminiVertexFunctionResponsePart
type GeminiVertexContent = { role: 'user' | 'model'; parts: GeminiVertexPart[] }
type GeminiVertexSystemInstruction = { parts: Array<{ text: string }> }

// Vertex AI uses an OpenAPI-style schema with UPPERCASE type names and a
// restricted feature set. We translate Anthropic's lowercase JSON Schema and
// drop fields Vertex doesn't accept ($schema, $ref, additionalProperties).
type GeminiVertexSchema = Record<string, unknown>

type GeminiVertexFunctionDeclaration = {
  name: string
  description?: string
  parameters?: GeminiVertexSchema
}
type GeminiVertexTool = {
  functionDeclarations: GeminiVertexFunctionDeclaration[]
}
type GeminiVertexFunctionCallingMode = 'AUTO' | 'ANY' | 'NONE'
type GeminiVertexToolConfig = {
  functionCallingConfig: {
    mode: GeminiVertexFunctionCallingMode
    allowedFunctionNames?: string[]
  }
}

type GeminiVertexSafetyRating = {
  category?: string
  probability?: string
  blocked?: boolean
}

type GeminiVertexResponsePart = {
  text?: string
  functionCall?: { name?: string; args?: Record<string, unknown> }
  thoughtSignature?: string
}

type GeminiVertexResponse = {
  candidates?: Array<{
    content?: {
      role?: string
      parts?: GeminiVertexResponsePart[]
    }
    finishReason?: string
    safetyRatings?: GeminiVertexSafetyRating[]
  }>
  promptFeedback?: {
    blockReason?: string
    blockReasonMessage?: string
    safetyRatings?: GeminiVertexSafetyRating[]
  }
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
    thoughtsTokenCount?: number
  }
}

function summarizeBlockedSafetyRatings(
  ratings: GeminiVertexSafetyRating[] | undefined,
): string {
  if (!ratings?.length) return ''
  const blocked = ratings
    .filter(r => r.blocked || r.probability === 'HIGH' || r.probability === 'MEDIUM')
    .map(r => `${r.category ?? '?'}=${r.probability ?? '?'}`)
  return blocked.length ? ` (${blocked.join(', ')})` : ''
}

// Compact, non-sensitive snapshot of a response that produced no usable
// content. Surfaced in the empty-response error so a single real test reveals
// the exact shape (parts present? thought-only? token split?) instead of us
// guessing across round-trips. Reports part *keys* and text lengths, never the
// text itself, so it can't leak prompt content.
function diagnoseEmptyResponse(json: GeminiVertexResponse): string {
  const candidate = json.candidates?.[0]
  const parts = candidate?.content?.parts
  let partsSummary: string
  if (Array.isArray(parts)) {
    partsSummary = parts.length === 0
      ? 'parts=[]'
      : parts
          .map((p, i) => {
            const rec = p as Record<string, unknown>
            const keys = Object.keys(rec)
            const textLen =
              typeof rec.text === 'string' ? (rec.text as string).length : 0
            return `#${i}{${keys.join(',') || 'empty'}${textLen ? ` textLen=${textLen}` : ''}}`
          })
          .join(' ')
  } else {
    partsSummary = parts === undefined ? 'parts=undefined' : 'parts=null'
  }
  const u = json.usageMetadata ?? {}
  const usage = `prompt=${u.promptTokenCount ?? 0} candidates=${u.candidatesTokenCount ?? 0} thoughts=${u.thoughtsTokenCount ?? 0} total=${u.totalTokenCount ?? 0}`
  const contentPresent = candidate?.content ? 'content:yes' : 'content:no'
  const promptBlock = json.promptFeedback?.blockReason
    ? `promptBlock=${json.promptFeedback.blockReason}`
    : 'promptBlock:none'
  return `[diag candidates=${json.candidates?.length ?? 0} ${contentPresent} ${partsSummary} | usage ${usage} | ${promptBlock}]`
}

// Role + part-kind sequence of the request we sent (no content, just shape).
// Surfaced alongside the response diagnostic so a structural cause — a trailing
// model turn, a missing functionResponse, an empty part — is visible directly.
function summarizeRequestContents(contents: GeminiVertexContent[]): string {
  const seq = contents
    .map(c => {
      const kinds = c.parts.map(p => {
        if ('functionCall' in p) return 'fc'
        if ('functionResponse' in p) return 'fr'
        if ('text' in p) return (p as { text: string }).text ? 'text' : 'text:empty'
        return '?'
      })
      return `${c.role}[${kinds.join(',')}]`
    })
    .join(' ')
  return `[req n=${contents.length} ${seq}]`
}

// Thinking-capable Vertex Gemini models spend a chunk of maxOutputTokens on
// internal reasoning (thoughtsTokenCount) before emitting any visible text.
// If openclaude passes a tight budget — common for the first turn of a chat —
// the model burns the entire allotment thinking and the response comes back
// with finishReason=MAX_TOKENS and no `parts`. Boost the floor for these
// families so a simple greeting actually produces a reply.
const THINKING_MODEL_PREFIXES = ['gemini-3.', 'gemini-2.5-pro']
const THINKING_MODEL_MIN_OUTPUT_TOKENS = 8192

function isThinkingModel(model: string): boolean {
  const lower = model.toLowerCase()
  return THINKING_MODEL_PREFIXES.some(prefix => lower.startsWith(prefix))
}

type GeminiVertexTextBlock = { type: 'text'; text: string }
type GeminiVertexToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}
type GeminiVertexContentBlock = GeminiVertexTextBlock | GeminiVertexToolUseBlock
type GeminiVertexStopReason = 'end_turn' | 'tool_use' | 'max_tokens'

type GeminiVertexMessage = {
  id: string
  type: 'message'
  role: 'assistant'
  model: string
  stop_reason: GeminiVertexStopReason
  stop_sequence: null
  usage: { input_tokens: number; output_tokens: number }
  content: GeminiVertexContentBlock[]
}

export type GeminiVertexStreamEvent =
  | { type: 'message_start'; message: GeminiVertexMessage }
  | {
      type: 'content_block_start'
      index: number
      content_block:
        | GeminiVertexTextBlock
        | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    }
  | { type: 'content_block_delta'; index: number; delta: { type: 'text_delta'; text: string } }
  | {
      type: 'content_block_delta'
      index: number
      delta: { type: 'input_json_delta'; partial_json: string }
    }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta'
      delta: { stop_reason: GeminiVertexStopReason; stop_sequence: null }
      usage: { output_tokens: number }
    }
  | { type: 'message_stop' }

type GeminiVertexWithResponseResult = {
  data: AsyncGenerator<GeminiVertexStreamEvent>
  response: Response
  request_id: string
}

type GeminiVertexPromise = Promise<GeminiVertexMessage> & {
  withResponse(): Promise<GeminiVertexWithResponseResult>
}

// JSON Schema → Vertex schema. Vertex's schema is an OpenAPI 3.0 subset: it
// requires UPPERCASE type names and rejects ANY field it doesn't recognize
// (e.g. propertyNames, exclusiveMinimum, const, $schema, additionalProperties).
// We therefore use an ALLOWLIST: only fields Vertex documents are forwarded,
// everything else is dropped. This is robust against future JSON Schema
// keywords that a drop-list could never anticipate.
//
// Supported scalar fields are copied as-is; structural fields (properties,
// items, anyOf, ...) are translated recursively.
const VERTEX_SCHEMA_SCALAR_KEYS = new Set([
  'format',
  'title',
  'description',
  'nullable',
  'default',
  'minItems',
  'maxItems',
  'enum',
  'required',
  'minProperties',
  'maxProperties',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'example',
  'propertyOrdering',
])

function toVertexSchema(schema: unknown): GeminiVertexSchema {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return {} as GeminiVertexSchema
  }
  const out: GeminiVertexSchema = {}
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === 'type' && typeof value === 'string') {
      out.type = value.toUpperCase()
    } else if (key === 'properties' && value && typeof value === 'object') {
      const properties: Record<string, GeminiVertexSchema> = {}
      for (const [propName, propSchema] of Object.entries(
        value as Record<string, unknown>,
      )) {
        properties[propName] = toVertexSchema(propSchema)
      }
      out.properties = properties
    } else if (key === 'items') {
      out.items = toVertexSchema(value)
    } else if (key === 'anyOf' || key === 'oneOf') {
      if (Array.isArray(value)) {
        out.anyOf = value.map(s => toVertexSchema(s))
      }
    } else if (key === 'allOf') {
      // Vertex doesn't support allOf; collapse to anyOf as a best-effort.
      if (Array.isArray(value)) {
        out.anyOf = value.map(s => toVertexSchema(s))
      }
    } else if (key === 'const') {
      // Vertex rejects `const` but supports `enum`; translate to preserve the
      // single-value constraint.
      out.enum = [value]
    } else if (key === 'exclusiveMinimum' && typeof value === 'number') {
      // No exclusive bounds in the Vertex subset; approximate with `minimum`.
      out.minimum = value
    } else if (key === 'exclusiveMaximum' && typeof value === 'number') {
      out.maximum = value
    } else if (VERTEX_SCHEMA_SCALAR_KEYS.has(key)) {
      out[key] = value
    }
    // Any other key (propertyNames, additionalProperties, $schema, $ref, if,
    // patternProperties, ...) is silently dropped — Vertex would 400 on it.
  }
  return out
}

// Anthropic tool definitions → Vertex `tools: [{ functionDeclarations }]`.
// Drops tools without an input_schema (e.g. server-side connector tools the
// Anthropic SDK exposes that aren't function-calls) so they don't pollute the
// declaration list.
function toGeminiTools(
  tools: MessageCreateParamsBase['tools'],
): GeminiVertexTool[] | undefined {
  if (!tools?.length) return undefined
  const functionDeclarations: GeminiVertexFunctionDeclaration[] = []
  for (const tool of tools) {
    const t = tool as { name?: string; description?: string; input_schema?: unknown }
    if (!t.name || !t.input_schema) continue
    const declaration: GeminiVertexFunctionDeclaration = { name: t.name }
    if (t.description) declaration.description = t.description
    const parameters = toVertexSchema(t.input_schema)
    if (Object.keys(parameters).length > 0) declaration.parameters = parameters
    functionDeclarations.push(declaration)
  }
  if (!functionDeclarations.length) return undefined
  return [{ functionDeclarations }]
}

// Translate Anthropic tool_choice (auto / any / tool / none) into Vertex's
// toolConfig. Vertex defaults to AUTO when omitted, so we only emit the
// config when a non-default behaviour is requested.
function toGeminiToolConfig(
  toolChoice: MessageCreateParamsBase['tool_choice'],
  hasTools: boolean,
): GeminiVertexToolConfig | undefined {
  if (!hasTools) return undefined
  if (!toolChoice) return undefined
  const choice = toolChoice as { type?: string; name?: string }
  if (choice.type === 'auto') {
    return { functionCallingConfig: { mode: 'AUTO' } }
  }
  if (choice.type === 'none') {
    return { functionCallingConfig: { mode: 'NONE' } }
  }
  if (choice.type === 'any') {
    return { functionCallingConfig: { mode: 'ANY' } }
  }
  if (choice.type === 'tool' && choice.name) {
    return {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: [choice.name],
      },
    }
  }
  return undefined
}

function safeJsonParse(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      /* fall through */
    }
  }
  return {}
}

function toGeminiMediaPart(block: unknown): GeminiVertexPart | undefined {
  if (!block || typeof block !== 'object') return undefined
  const { type, source } = block as {
    type?: string
    source?: { type?: string; media_type?: string; data?: string }
  }
  if (type !== 'image' && type !== 'document') return undefined
  if (
    source?.type !== 'base64' || !source.data ||
    !(type === 'image' ? source.media_type?.startsWith('image/') : source.media_type === 'application/pdf')
  ) {
    // Never return a successful answer to an attachment the model did not see.
    // Do not fetch arbitrary URLs or include their potentially secret text.
    throw new Error('Gemini Vertex requires base64 images or PDF documents; attach the file as base64 instead of an unsupported media source.')
  }
  return { inlineData: { mimeType: source.media_type!, data: source.data } }
}

function stringifyToolResultContent(content: unknown, mediaParts: GeminiVertexPart[]): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(block => {
        const media = toGeminiMediaPart(block)
        if (media) {
          mediaParts.push(media)
          return ''
        }
        if (block && typeof block === 'object' && 'text' in block) {
          return String((block as { text?: unknown }).text ?? '')
        }
        // ToolSearch results are tool_reference blocks with no text payload —
        // render them so the model learns which deferred tools were loaded
        // (their schemas arrive in the next request's tools array).
        if (
          block &&
          typeof block === 'object' &&
          (block as { type?: unknown }).type === 'tool_reference' &&
          typeof (block as { tool_name?: unknown }).tool_name === 'string'
        ) {
          return `Tool "${(block as { tool_name: string }).tool_name}" is now loaded and available to call.`
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

// Translate Anthropic message history → Vertex `contents`. Handles:
//   - plain text on user/assistant turns
//   - assistant tool_use blocks → model functionCall parts (keeps a name map
//     so the subsequent tool_result can be wired back to the right function)
//   - user tool_result blocks → user functionResponse parts, looking up the
//     function name from the most recent tool_use with the same id
//   - direct and nested tool-result images/PDFs → inlineData parts
// Unsupported media sources fail before sending, rather than losing content.
function toGeminiContents(
  messages: MessageCreateParamsBase['messages'],
): GeminiVertexContent[] {
  const toolUseIdToName = new Map<string, string>()
  const out: GeminiVertexContent[] = []

  for (const message of messages) {
    const role: 'user' | 'model' = message.role === 'assistant' ? 'model' : 'user'
    // Gemini's function-calling protocol expects a turn carrying
    // functionResponse parts to be PURE (no text mixed in) and to immediately
    // follow the model's functionCall turn. openclaude, however, appends
    // system-reminder text blocks to the same user message as a tool_result —
    // which would emit `user[functionResponse, text]`. Vertex then silently
    // produces an empty response (finishReason STOP, 0 tokens). So we collect
    // functionResponse parts separately and emit them in their own clean turn,
    // pushing any accompanying text into a following user turn.
    const responseParts: GeminiVertexPart[] = []
    const otherParts: GeminiVertexPart[] = []

    if (typeof message.content === 'string') {
      if (message.content) otherParts.push({ text: message.content })
    } else {
      for (const block of message.content) {
        const media = toGeminiMediaPart(block)
        const b = block as {
          type?: string
          text?: string
          name?: string
          id?: string
          input?: unknown
          tool_use_id?: string
          content?: unknown
        }
        if (media) {
          otherParts.push(media)
        } else if (b.type === 'text' && typeof b.text === 'string' && b.text) {
          otherParts.push({ text: b.text })
        } else if (b.type === 'tool_use' && b.name && b.id) {
          toolUseIdToName.set(b.id, b.name)
          const { thoughtSignature } = decodeToolUseId(b.id)
          const functionCallPart: GeminiVertexFunctionCallPart = {
            functionCall: {
              name: b.name,
              args: safeJsonParse(b.input),
            },
          }
          // Replay the thinking model's thoughtSignature so Vertex accepts the
          // call in history (it 400s on functionCall parts missing it).
          if (thoughtSignature) functionCallPart.thoughtSignature = thoughtSignature
          otherParts.push(functionCallPart)
        } else if (b.type === 'tool_result' && b.tool_use_id) {
          const name = toolUseIdToName.get(b.tool_use_id) ?? 'tool'
          responseParts.push({
            functionResponse: {
              name,
              response: { result: stringifyToolResultContent(b.content, otherParts) },
            },
          })
        }
      }
    }

    // Emit the pure functionResponse turn first (immediately after the model's
    // functionCall), then any remaining text/other parts as a separate turn.
    if (responseParts.length > 0) out.push({ role, parts: responseParts })
    if (otherParts.length > 0) out.push({ role, parts: otherParts })
  }
  return out
}

// openclaude ships a large coding-agent system prompt as params.system. Vertex
// expects it in the top-level `systemInstruction` field — passing it inside
// `contents` would lose its role and confuse the model. Returns undefined if
// the caller didn't send one (so we don't emit an empty instruction object).
function toGeminiSystemInstruction(
  system: MessageCreateParamsBase['system'],
): GeminiVertexSystemInstruction | undefined {
  if (!system) {
    return undefined
  }
  const text = typeof system === 'string'
    ? system
    : system
        .map(block => ('text' in block && typeof block.text === 'string' ? block.text : ''))
        .filter(Boolean)
        .join('\n')
  if (!text.trim()) {
    return undefined
  }
  return { parts: [{ text }] }
}

// Pull every visible-text part out of a Vertex response and concatenate.
// Used both to detect empty-text outcomes and to build the final content
// blocks. Function-call parts are surfaced separately by extractContentBlocks.
function extractText(response: GeminiVertexResponse): string {
  return (
    response.candidates?.[0]?.content?.parts
      ?.map(part => part.text ?? '')
      .join('') ?? ''
  )
}

let toolUseCounter = 0
function nextToolUseId(): string {
  // Anthropic IDs look like `toolu_01XXXXXXXX...`. Vertex doesn't provide an
  // id with its functionCall, so we synthesise one stable per-call so the
  // assistant message and any follow-up tool_result can correlate.
  toolUseCounter = (toolUseCounter + 1) % Number.MAX_SAFE_INTEGER
  return `toolu_vertex_${Date.now().toString(36)}_${toolUseCounter}`
}

// Gemini thinking models require the functionCall's thoughtSignature to be
// replayed on the next turn. The Anthropic message shape has no field for it,
// so we smuggle it through the tool_use `id` (preserved verbatim by the agent
// loop, even across session save/restore). The `~~sig~~` delimiter can't appear
// in our synthesised ids nor in a base64 signature, so decoding is unambiguous.
const TOOL_USE_SIG_DELIM = '~~sig~~'

function encodeToolUseId(baseId: string, thoughtSignature: string | undefined): string {
  if (!thoughtSignature) return baseId
  return `${baseId}${TOOL_USE_SIG_DELIM}${thoughtSignature}`
}

function decodeToolUseId(id: string): { thoughtSignature?: string } {
  const idx = id.indexOf(TOOL_USE_SIG_DELIM)
  if (idx === -1) return {}
  const sig = id.slice(idx + TOOL_USE_SIG_DELIM.length)
  return sig ? { thoughtSignature: sig } : {}
}

// Build Anthropic-shaped content blocks (text + tool_use) from Vertex parts,
// preserving the original ordering. A response that mixes text and function
// calls is valid and is what the agent loop needs to actually call tools.
function extractContentBlocks(
  response: GeminiVertexResponse,
): GeminiVertexContentBlock[] {
  const parts = response.candidates?.[0]?.content?.parts ?? []
  const blocks: GeminiVertexContentBlock[] = []
  let textBuffer = ''
  const flushText = (): void => {
    if (textBuffer) {
      blocks.push({ type: 'text', text: textBuffer })
      textBuffer = ''
    }
  }
  for (const part of parts) {
    if (typeof part.text === 'string' && part.text) {
      textBuffer += part.text
    } else if (part.functionCall?.name) {
      flushText()
      blocks.push({
        type: 'tool_use',
        id: encodeToolUseId(nextToolUseId(), part.thoughtSignature),
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
      })
    }
  }
  flushText()
  return blocks
}

// Adapt the completed Vertex response to the Anthropic streaming event
// sequence the rest of openclaude consumes. Emits one content_block_start /
// delta / stop trio per block so the streaming accumulator builds the right
// shape for multi-block (text + tool_use) responses.
async function* toAnthropicStream(
  message: GeminiVertexMessage,
): AsyncGenerator<GeminiVertexStreamEvent> {
  yield { type: 'message_start', message }
  for (let index = 0; index < message.content.length; index++) {
    const block = message.content[index]!
    if (block.type === 'text') {
      yield {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      }
      if (block.text) {
        yield {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: block.text },
        }
      }
      yield { type: 'content_block_stop', index }
    } else {
      yield {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: {},
        },
      }
      yield {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(block.input ?? {}),
        },
      }
      yield { type: 'content_block_stop', index }
    }
  }
  yield {
    type: 'message_delta',
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: message.usage.output_tokens },
  }
  yield { type: 'message_stop' }
}

export function createGeminiVertexClient(options: GeminiVertexClientOptions) {
  const endpointError = getGeminiVertexEndpointError(options)
  if (endpointError) throw new Error(endpointError)
  const fetchImpl = options.fetch ?? fetch

  const create = (
    params: MessageCreateParamsBase & { stream?: boolean },
    requestOptions: { signal?: AbortSignal | null; timeout?: number } = {},
  ): GeminiVertexPromise => {
    let capturedResponse: Response | undefined
    const { signal, cleanup } = createCombinedAbortSignal(requestOptions.signal ?? undefined, {
      timeoutMs: requestOptions.timeout,
      trace: { subsystem: 'gemini_vertex', controllerRole: 'request' },
    })
    const promise = raceAbort((async (): Promise<GeminiVertexMessage> => {
      throwIfAborted(signal)
      const model = options.model
      const token = await options.getAccessToken()
      throwIfAborted(signal)
      const host = options.location === 'global'
        ? 'aiplatform.googleapis.com'
        : `${options.location}-aiplatform.googleapis.com`
      const url = `https://${host}/v1/projects/${options.project}/locations/${options.location}/publishers/google/models/${model}:generateContent`

      const thinking = isThinkingModel(model)

      // For thinking models, raise the floor so the model has room to think
      // *and* still emit visible output. Honor the caller's value when it's
      // already large enough — only boost when the requested budget would
      // certainly be eaten by the thinking phase.
      const requestedMaxTokens = params.max_tokens
      const effectiveMaxTokens = thinking
        ? Math.max(requestedMaxTokens ?? 0, THINKING_MODEL_MIN_OUTPUT_TOKENS)
        : requestedMaxTokens

      // Gemini 3 thinking models misbehave below temperature 1.0: Google warns
      // it "may lead to unexpected behavior, such as looping or degraded
      // performance". In practice the model burns its budget thinking and then
      // emits ZERO text parts (finishReason STOP, empty response). openclaude,
      // like most coding agents, sends a low temperature for determinism — so
      // we clamp thinking models to the documented 1.0 floor. Non-thinking
      // models keep the caller's temperature untouched.
      const effectiveTemperature = thinking
        ? Math.max(params.temperature ?? 1, 1)
        : params.temperature

      const systemInstruction = toGeminiSystemInstruction(params.system)
      const tools = toGeminiTools(params.tools)
      const toolConfig = toGeminiToolConfig(params.tool_choice, Boolean(tools))
      const contents = toGeminiContents(params.messages)

      const response = await fetchImpl(url, {
        method: 'POST',
        signal,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'x-goog-user-project': options.project,
        },
        body: JSON.stringify({
          contents,
          ...(systemInstruction ? { systemInstruction } : {}),
          // Forward tool definitions so the model emits well-formed
          // functionCall parts instead of inventing syntax that Vertex
          // rejects with finishReason=MALFORMED_FUNCTION_CALL. Without
          // this, any agentic prompt (which always declares tools) returns
          // an empty, unusable response.
          ...(tools ? { tools } : {}),
          ...(toolConfig ? { toolConfig } : {}),
          generationConfig: {
            ...(effectiveMaxTokens !== undefined
              ? { maxOutputTokens: effectiveMaxTokens }
              : {}),
            ...(effectiveTemperature !== undefined
              ? { temperature: effectiveTemperature }
              : {}),
          },
        }),
      }).catch(error => {
        // Only transport failures become connection errors. Schema/content
        // errors below retain their existing fatal classification.
        throw new APIConnectionError({ cause: error instanceof Error ? error : undefined })
      })
      capturedResponse = response

      const body = await response.text().catch(error => {
        throw new APIConnectionError({ cause: error instanceof Error ? error : undefined })
      })
      if (!response.ok) {
        throw APIError.generate(
          response.status, undefined,
          `Gemini Vertex request failed: ${response.status} ${body}`,
          response.headers,
        )
      }

      const json = JSON.parse(body) as GeminiVertexResponse
      const contentBlocks = extractContentBlocks(json)
      const text = extractText(json)
      const candidate = json.candidates?.[0]
      const finishReason = candidate?.finishReason
      const thoughtsTokenCount = json.usageMetadata?.thoughtsTokenCount ?? 0
      const hasToolCall = contentBlocks.some(b => b.type === 'tool_use')

      // Surface every silent-empty-response path explicitly. We treat the
      // response as empty only when the candidate produced neither text nor
      // a function call — a function-call-only turn is a perfectly valid
      // agent response and must be passed through to the orchestrator.
      if (!text && !hasToolCall) {
        // 1. Prompt-level block: Vertex refuses to process the input before
        //    producing any candidate (safety filter at the prompt layer).
        const promptBlock = json.promptFeedback?.blockReason
        if (promptBlock) {
          const detail =
            json.promptFeedback?.blockReasonMessage ??
            summarizeBlockedSafetyRatings(json.promptFeedback?.safetyRatings)
          throw new Error(
            `Gemini Vertex blocked the prompt (${promptBlock})${detail ? `: ${detail}` : ''}. ` +
              `Try a less sensitive prompt or another Vertex model.`,
          )
        }

        // 2. Thinking model exhausted its output budget on internal reasoning.
        if (finishReason === 'MAX_TOKENS') {
          const usedForThinking = thoughtsTokenCount > 0
            ? ` (${thoughtsTokenCount} tokens consumed by internal thinking)`
            : ''
          throw new Error(
            `Gemini Vertex returned no visible text: hit MAX_TOKENS${usedForThinking}. ` +
              `Model "${model}" likely needs a larger maxOutputTokens budget. ` +
              `Try a non-thinking model (e.g. gemini-2.5-flash) or raise the budget.`,
          )
        }

        // 3. Candidate-level safety / recitation / blocklist refusal.
        if (
          finishReason === 'SAFETY' ||
          finishReason === 'RECITATION' ||
          finishReason === 'BLOCKLIST' ||
          finishReason === 'PROHIBITED_CONTENT' ||
          finishReason === 'SPII'
        ) {
          const detail = summarizeBlockedSafetyRatings(candidate?.safetyRatings)
          throw new Error(
            `Gemini Vertex refused to answer (${finishReason})${detail}. ` +
              `Try rephrasing or another Vertex model.`,
          )
        }

        // 4. Malformed function call: the model tried to emit a tool call
        //    Vertex couldn't parse. Almost always means tools weren't passed
        //    or the schema was unparseable. The toGeminiTools/toVertexSchema
        //    pipeline above should prevent this, but surface a clear error
        //    if it still happens (e.g. an unusual tool definition).
        if (finishReason === 'MALFORMED_FUNCTION_CALL') {
          throw new Error(
            `Gemini Vertex emitted a malformed function call from "${model}". ` +
              `This usually indicates a tool schema Vertex couldn't parse. ` +
              `Try another model or remove a recently-added custom tool.`,
          )
        }

        // 5. Catch-all: model finished normally (STOP / OTHER / undefined)
        //    but produced no text or function call. Surface it — with a compact
        //    diagnostic of the raw response — instead of silently dropping, so
        //    the true cause (thought-only output, empty parts, blocked content)
        //    is visible from one test rather than guessed at.
        throw new Error(
          `Gemini Vertex returned an empty response from "${model}"` +
            `${finishReason ? ` (finishReason: ${finishReason})` : ''}. ` +
            `This usually means the model couldn't generate output for this prompt — try another model or rephrase. ` +
            diagnoseEmptyResponse(json) +
            ' ' +
            summarizeRequestContents(contents),
        )
      }

      const finalBlocks: GeminiVertexContentBlock[] =
        contentBlocks.length > 0
          ? contentBlocks
          : [{ type: 'text', text }]

      return {
        id: `gemini-vertex-${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model,
        stop_reason: hasToolCall ? 'tool_use' : candidate?.finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: json.usageMetadata?.promptTokenCount ?? 0,
          output_tokens: (json.usageMetadata?.candidatesTokenCount ?? 0) +
            (json.usageMetadata?.thoughtsTokenCount ?? 0),
        },
        content: finalBlocks,
      }
    })(), signal).catch(error => {
      if (signal.aborted) {
        if (requestOptions.signal?.aborted && signal.reason === requestOptions.signal.reason) {
          throw new APIUserAbortError()
        }
        throw new APIConnectionTimeoutError()
      }
      throw error
    }).finally(cleanup)

    const typed = promise as GeminiVertexPromise
    typed.withResponse = async () => {
      const data = await promise
      const response = capturedResponse ?? new Response()
      return {
        data: toAnthropicStream(data),
        response,
        request_id: response.headers.get('x-request-id') ?? data.id,
      }
    }

    return typed
  }

  const messages = { create }

  return {
    messages,
    beta: { messages },
  }
}
