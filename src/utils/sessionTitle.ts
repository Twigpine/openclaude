/**
 * Session title generation via Haiku.
 *
 * Standalone module with minimal dependencies so it can be imported from
 * print.ts (SDK control request handler) without pulling in the React/chalk/
 * git dependency chain that teleport.tsx carries.
 *
 * This is the single source of truth for AI-generated session titles across
 * all surfaces. Previously there were separate Haiku title generators:
 * - teleport.tsx generateTitleAndBranch (6-word title + branch for CCR)
 * - rename/generateSessionName.ts (kebab-case name for /rename)
 * Each remains for backwards compat; new callers should use this module.
 */

import { z } from 'zod/v4'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { logEvent } from '../services/analytics/index.js'
import { queryHaiku } from '../services/api/claude.js'
import type { Message } from '../types/message.js'
import { modelSupportsStructuredOutputs } from './betas.js'
import { createCombinedAbortSignal } from './combinedAbortSignal.js'
import { logForDebugging } from './debug.js'
import { safeParseJSON } from './json.js'
import { lazySchema } from './lazySchema.js'
import { extractTextContent } from './messages.js'
import { getSmallFastModel } from './model/model.js'
import { getAPIProvider } from './model/providers.js'
import { asSystemPrompt } from './systemPromptType.js'

const MAX_CONVERSATION_TEXT = 1000
const SESSION_TITLE_MAX_OUTPUT_TOKENS = 64
const SESSION_TITLE_TIMEOUT_MS = 12_000
const MAX_TITLE_RESPONSE_TEXT = 4096
const MAX_TITLE_CHARS = 60
const MAX_TITLE_WORDS = 10
const MAX_CANDIDATE_CHARS = 200
const MAX_CANDIDATE_WORDS = 20
const FALLBACK_SESSION_TITLE = 'OpenClaude'
const TERMINAL_CONTROL_SEQUENCE_PATTERN =
  /\x1B(?:\][\s\S]*?(?:\x07|\x1B\\)|[PX^_][\s\S]*?\x1B\\|\[[0-?]*[ -/]*[@-~]|[@-_])|\x9B[0-?]*[ -/]*[@-~]/g
const CONTROL_CHARACTER_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g
const ESCAPED_CONTROL_CHARACTER_PATTERN =
  /\\(?:x(?:0[0-8BCEFbcef]|1[0-9A-Fa-f]|7[Ff]|[89][0-9A-Fa-f])|u00(?:0[0-8BCEFbcef]|1[0-9A-Fa-f]|7[Ff]|[89][0-9A-Fa-f]))/

/**
 * Flatten a message array into a single text string for Haiku title input.
 * Skips meta/non-human messages. Tail-slices to the last 1000 chars so
 * recent context wins when the conversation is long.
 */
export function extractConversationText(messages: Message[]): string {
  const parts: string[] = []
  for (const msg of messages) {
    if (msg.type !== 'user' && msg.type !== 'assistant') continue
    if ('isMeta' in msg && msg.isMeta) continue
    if ('origin' in msg && msg.origin && msg.origin.kind !== 'human') continue
    const content = msg.message.content
    if (typeof content === 'string') {
      parts.push(content)
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if ('type' in block && block.type === 'text' && 'text' in block) {
          parts.push(block.text as string)
        }
      }
    }
  }
  const text = parts.join('\n')
  return text.length > MAX_CONVERSATION_TEXT
    ? text.slice(-MAX_CONVERSATION_TEXT)
    : text
}

const SESSION_TITLE_PROMPT = `Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of this coding session. The title should be clear enough that the user recognizes the session in a list. Use sentence case: capitalize only the first word and proper nouns.

Return JSON with a single "title" field.

Good examples:
{"title": "Fix login button on mobile"}
{"title": "Add OAuth authentication"}
{"title": "Debug failing CI tests"}
{"title": "Refactor API client error handling"}

Bad (too vague): {"title": "Code changes"}
Bad (too long): {"title": "Investigate and fix the issue where the login button does not respond on mobile devices"}
Bad (wrong case): {"title": "Fix Login Button On Mobile"}`

const titleSchema = lazySchema(() => z.object({ title: z.string() }))

const SESSION_TITLE_OUTPUT_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
    },
    required: ['title'],
    additionalProperties: false,
  },
} as const

type SessionTitleFallback =
  | 'strict_json'
  | 'embedded_json'
  | 'quoted_string'
  | 'short_line'
  | 'default'

type SessionTitleParseFailure =
  | 'none'
  | 'empty_response'
  | 'strict_json_parse_failed'
  | 'unusable_response'
  | 'query_error'

type SessionTitleParseResult = {
  title: string
  success: boolean
  fallback: SessionTitleFallback
  parseFailure: SessionTitleParseFailure
}

function stripTerminalControlSequences(value: string): string {
  return value
    .replace(TERMINAL_CONTROL_SEQUENCE_PATTERN, '')
    .replace(CONTROL_CHARACTER_PATTERN, '')
}

function hasStringTitleField(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { title?: unknown }).title === 'string'
  )
}

export function titleOrNullForPromptFallback(
  title: string | null,
): string | null {
  return title === FALLBACK_SESSION_TITLE ? null : title
}

function sanitizeTitleCandidate(candidate: unknown): string | null {
  if (typeof candidate !== 'string') return null
  if (ESCAPED_CONTROL_CHARACTER_PATTERN.test(candidate)) return null

  let title = stripTerminalControlSequences(candidate)
    .replace(/\r\n?/g, '\n')
    .replace(/^```[a-z0-9_-]*\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()

  const firstLine = title
    .split('\n')
    .map(line => line.trim())
    .find(Boolean)
  if (!firstLine) return null

  title = firstLine
    .replace(/^(?:[-*+\u2022]\s+|\d+[.)]\s+|#+\s+|>\s+)/, '')
    .replace(/^`+|`+$/g, '')
    .replace(/^\*\*(.+)\*\*$/, '$1')
    .replace(/^__(.+)__$/, '$1')
    .replace(/^_(.+)_$/, '$1')
    .replace(/^\*(.+)\*$/, '$1')
    .replace(/^["'\u201c\u201d\u2018\u2019]+|["'\u201c\u201d\u2018\u2019]+$/g, '')
    .replace(/^(?:title|session title)\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!title) return null
  if (/^[{}\[\],:"'\u201c\u201d\u2018\u2019\s]+$/.test(title)) return null
  if (/^\{.*\}$/.test(title) || /^\[.*\]$/.test(title)) return null
  if (/"title"\s*:/.test(title)) return null
  if (/^title$/i.test(title)) return null

  const assistantProse =
    /^(?:i['\u2019]?ll|i will|i can|i would|let me|here['\u2019]?s|here is|here are|sure[, ]|certainly[, ]|of course[, ]|the title (?:is|should be)|this (?:session|title)|based on|possible (?:session )?titles?|(?:title )?(?:ideas|options|suggestions))\b/i
  if (assistantProse.test(title)) return null

  const words = title.split(/\s+/).filter(Boolean)
  if (title.length > MAX_CANDIDATE_CHARS || words.length > MAX_CANDIDATE_WORDS) {
    return null
  }

  if (words.length > MAX_TITLE_WORDS) {
    title = words.slice(0, MAX_TITLE_WORDS).join(' ')
  }

  if (title.length > MAX_TITLE_CHARS) {
    const truncated = title.slice(0, MAX_TITLE_CHARS).trim()
    title = truncated.replace(/\s+\S*$/, '').trim() || truncated
  }

  title = title.replace(/[.?!]+$/g, '').trim()
  return title || null
}

function parseTitleFromJSON(value: unknown): string | null {
  const parsed = titleSchema().safeParse(value)
  if (!parsed.success) return null
  return sanitizeTitleCandidate(parsed.data.title)
}

function extractFirstJSONObject(text: string): string | null {
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]

    if (start === -1) {
      if (char === '{') {
        start = i
        depth = 1
      }
      continue
    }

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      depth++
      continue
    }
    if (char === '}') {
      depth--
      if (depth === 0) {
        return text.slice(start, i + 1)
      }
    }
  }

  return null
}

function extractQuotedTitle(text: string): string | null {
  const titled =
    /\btitle\b[^"'\u201c\u201d\u2018\u2019\n]{0,32}["'\u201c\u201d\u2018\u2019]([^"'\u201c\u201d\u2018\u2019\n]{1,160})["'\u201c\u201d\u2018\u2019]/i.exec(
      text,
    )
  const titledCandidate = sanitizeTitleCandidate(titled?.[1])
  if (titledCandidate) return titledCandidate

  const quoted =
    /["'\u201c\u201d\u2018\u2019]([^"'\u201c\u201d\u2018\u2019\n]{1,160})["'\u201c\u201d\u2018\u2019]/g
  for (const match of text.matchAll(quoted)) {
    const candidate = sanitizeTitleCandidate(match[1])
    if (candidate) return candidate
  }

  return null
}

function parseSessionTitleResponse(text: string): SessionTitleParseResult {
  const response = text.trim()
  if (!response) {
    return {
      title: FALLBACK_SESSION_TITLE,
      success: false,
      fallback: 'default',
      parseFailure: 'empty_response',
    }
  }

  const strictJSON = safeParseJSON(response, false)
  const strictTitle = parseTitleFromJSON(strictJSON)
  if (strictTitle) {
    return {
      title: strictTitle,
      success: true,
      fallback: 'strict_json',
      parseFailure: 'none',
    }
  }
  if (hasStringTitleField(strictJSON)) {
    return {
      title: FALLBACK_SESSION_TITLE,
      success: false,
      fallback: 'default',
      parseFailure: 'unusable_response',
    }
  }

  const inspectable = response.slice(0, MAX_TITLE_RESPONSE_TEXT)
  const embedded = extractFirstJSONObject(inspectable)
  if (embedded) {
    const embeddedTitle = parseTitleFromJSON(safeParseJSON(embedded, false))
    if (embeddedTitle) {
      return {
        title: embeddedTitle,
        success: true,
        fallback: 'embedded_json',
        parseFailure: 'strict_json_parse_failed',
      }
    }
  }

  const quotedTitle = extractQuotedTitle(inspectable)
  if (quotedTitle) {
    return {
      title: quotedTitle,
      success: true,
      fallback: 'quoted_string',
      parseFailure: 'strict_json_parse_failed',
    }
  }

  for (const line of inspectable.split('\n')) {
    const title = sanitizeTitleCandidate(line)
    if (title) {
      return {
        title,
        success: true,
        fallback: 'short_line',
        parseFailure: 'strict_json_parse_failed',
      }
    }
  }

  return {
    title: FALLBACK_SESSION_TITLE,
    success: false,
    fallback: 'default',
    parseFailure: 'unusable_response',
  }
}

function logSessionTitleDiagnostic({
  provider,
  model,
  responseLength,
  parseFailure,
  fallback,
  level,
  error,
}: {
  provider: string
  model: string
  responseLength: number
  parseFailure: SessionTitleParseFailure
  fallback: SessionTitleFallback
  level: 'debug' | 'warn'
  error?: unknown
}): void {
  const parts = [
    'generateSessionTitle',
    'task=generate_session_title',
    `provider=${provider}`,
    `model=${model}`,
    `response_length=${responseLength}`,
    `parse_failure=${parseFailure}`,
    `fallback=${fallback}`,
  ]

  if (error !== undefined) {
    parts.push(
      `error_name=${error instanceof Error ? error.name : typeof error}`,
    )
  }

  logForDebugging(parts.join(' '), { level })
}

/**
 * Generate a sentence-case session title from a description or first message.
 * Returns null for empty input and otherwise falls back to OpenClaude when
 * provider output cannot be turned into a safe short title.
 *
 * @param description - The user's first message or a description of the session
 * @param signal - Abort signal for cancellation
 */
export async function generateSessionTitle(
  description: string,
  signal: AbortSignal,
): Promise<string | null> {
  const trimmed = description.trim()
  if (!trimmed) return null

  const model = getSmallFastModel()
  const provider = getAPIProvider()
  const outputFormat = modelSupportsStructuredOutputs(model)
    ? SESSION_TITLE_OUTPUT_FORMAT
    : undefined
  const titleSignal = createCombinedAbortSignal(signal, {
    timeoutMs: SESSION_TITLE_TIMEOUT_MS,
  })

  try {
    const result = await queryHaiku({
      systemPrompt: asSystemPrompt([SESSION_TITLE_PROMPT]),
      userPrompt: trimmed,
      outputFormat,
      signal: titleSignal.signal,
      options: {
        querySource: 'generate_session_title',
        agents: [],
        // Reflect the actual session mode — this module is called from
        // both the SDK print path (non-interactive) and the CCR remote
        // session path via useRemoteSession (interactive).
        isNonInteractiveSession: getIsNonInteractiveSession(),
        hasAppendSystemPrompt: false,
        maxOutputTokensOverride: SESSION_TITLE_MAX_OUTPUT_TOKENS,
        temperatureOverride: 0,
        enablePromptCaching: false,
        skipCacheWrite: true,
        mcpTools: [],
      },
    })

    if (result.isApiErrorMessage) {
      throw new Error('Session title query returned an API error')
    }

    const text = extractTextContent(result.message.content)
    const parsed = parseSessionTitleResponse(text)

    if (parsed.fallback !== 'strict_json') {
      logSessionTitleDiagnostic({
        provider,
        model,
        responseLength: text.length,
        parseFailure: parsed.parseFailure,
        fallback: parsed.fallback,
        level: parsed.success ? 'debug' : 'warn',
      })
    }

    logEvent('tengu_session_title_generated', { success: parsed.success })

    return parsed.title
  } catch (error) {
    logSessionTitleDiagnostic({
      provider,
      model,
      responseLength: 0,
      parseFailure: 'query_error',
      fallback: 'default',
      level: 'warn',
      error,
    })
    logEvent('tengu_session_title_generated', { success: false })

    // Fallback: When using 3P providers without a compatible schema,
    // default to the application name.
    return FALLBACK_SESSION_TITLE
  } finally {
    titleSignal.cleanup()
  }
}
