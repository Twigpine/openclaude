/**
 * duo — pure parsing for the CLI-backed debaters.
 *
 * Side A runs `opencode run --format json` (NDJSON), side B runs
 * `cline --json`. Both emit one JSON object per line; this module turns raw
 * stdout into a reply text plus diagnostics. Kept free of I/O so it is fully
 * unit-testable (see cliAgent.ts for the process spawning).
 */

export type CliUsage = {
  input: number
  output: number
  cost: number
}

export type CliRunResult = {
  text: string
  session?: string | null
  model?: string | null
  error?: string | null
  usage?: CliUsage | null
  /** 'length' when the provider cut the reply off at its output limit. */
  finishReason?: string | null
}

/** One reconstructed Cline turn (session resume is unavailable with --json). */
export type DuoTranscriptTurn = {
  message: string
  reply: string
}

/** Character budget for the reconstructed Cline transcript. */
const TRANSCRIPT_BUDGET = 6000

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null
}

function safeParse(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    return asRecord(JSON.parse(trimmed))
  } catch {
    return null
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Parse `opencode run --format json` stdout. */
export function parseOpenCodeOutput(stdout: string): CliRunResult {
  const parts: string[] = []
  let session: string | null = null
  let error: string | null = null
  let usage: CliUsage | null = null
  let finishReason: string | null = null

  for (const line of stdout.split('\n')) {
    const obj = safeParse(line)
    if (!obj) continue

    session = asString(obj.sessionID) ?? session

    if (obj.type === 'text') {
      const part = asRecord(obj.part)
      const text = asString(part?.text)
      if (text) parts.push(text)
    } else if (obj.type === 'error') {
      const err = asRecord(obj.error)
      const detail = [
        asString(err?.type),
        err?.status != null ? String(err.status) : null,
        asString(err?.message),
      ]
        .filter(Boolean)
        .join(' ')
      error = detail.trim() || 'unknown error'
    } else if (obj.type === 'step_finish') {
      // Token counts and truncation. Without them a truncated reply looks
      // complete, and every usage dashboard reads zero.
      const step = parseStepFinish(obj)
      if (step.usage) usage = step.usage
      if (step.finishReason) finishReason = step.finishReason
    } else if (obj.type === undefined && obj.error !== undefined) {
      // opencode also emits {"error": {...}} with no top-level type.
      error = asString(asRecord(obj.error)?.message) ?? 'unknown opencode error'
    }
  }

  return {
    text: parts.join('\n\n').trim(),
    session,
    error,
    usage,
    finishReason: finishReason ?? undefined,
  }
}

/** Read tokens and finish reason out of an opencode `step_finish` event. */
export function parseStepFinish(obj: Record<string, unknown>): {
  usage?: CliUsage
  finishReason?: string
} {
  const part = asRecord(obj.part)
  const tokens = part ? asRecord(part.tokens) : null
  if (!tokens) return {}
  const input = asNumber(tokens.input) ?? 0
  const output = asNumber(tokens.output) ?? 0
  const cache = asRecord(tokens.cache)
  const cacheRead = asNumber(cache?.read) ?? 0
  if (!input && !output) return {}
  return {
    usage: {
      input: input + cacheRead,
      output,
      cost: asNumber(tokens.cost) ?? 0,
    },
    finishReason: asString(part?.reason) ?? undefined,
  }
}

/** Parse `cline --json` stdout. */
export function parseClineOutput(stdout: string): CliRunResult {
  let text = ''
  const fallback: string[] = []
  let model: string | null = null
  let error: string | null = null
  let usage: CliUsage | null = null

  for (const line of stdout.split('\n')) {
    const obj = safeParse(line)
    if (!obj) continue

    if (obj.type === 'run_result') {
      const resultText = asString(obj.text)
      if (resultText) text = resultText
      const modelObj = asRecord(obj.model)
      model = asString(modelObj?.id) ?? model
      const usageObj = asRecord(obj.usage)
      if (usageObj) {
        usage = {
          input: asNumber(usageObj.inputTokens) ?? 0,
          output: asNumber(usageObj.outputTokens) ?? 0,
          cost: asNumber(usageObj.totalCost) ?? 0,
        }
      }
      const finishReason = obj.finishReason
      if (finishReason != null && finishReason !== 'completed') {
        error = `finishReason=${String(finishReason)}`
      }
    } else if (obj.type === 'agent_event') {
      const event = asRecord(obj.event)
      if (
        event?.type === 'content_end' &&
        event.contentType === 'text' &&
        typeof event.text === 'string' &&
        event.text.length > 0
      ) {
        // De-duplicate: the same text can be emitted more than once.
        if (fallback[fallback.length - 1] !== event.text) {
          fallback.push(event.text)
        }
      }
    }
  }

  if (!text) text = fallback.join('\n\n').trim()
  return { text, model, error, usage, session: null }
}

/**
 * Reconstruct Cline's context as text.
 *
 * Cline's `--id` requires a TTY and is incompatible with `--json`, so history
 * is replayed as a transcript under a ~6 Ko budget (oldest turns dropped).
 */
export function wrapClineTranscript(
  message: string,
  transcript: readonly DuoTranscriptTurn[],
): string {
  if (transcript.length === 0) return message

  const turns: DuoTranscriptTurn[] = []
  let used = 0
  for (let i = transcript.length - 1; i >= 0; i--) {
    const turn = transcript[i]!
    const size = turn.message.length + turn.reply.length + 60
    if (used + size > TRANSCRIPT_BUDGET && turns.length > 0) break
    turns.push(turn)
    used += size
  }

  const parts = [
    '[Reconstructed context — session resume is unavailable with --json; earlier exchanges:]',
  ]
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!
    parts.push(`[Previous message]\n${turn.message}\n\n[Your reply]\n${turn.reply}`)
  }
  parts.push(`[Current message]\n${message}`)
  return parts.join('\n\n')
}

/**
 * Cline rejects single-word prompts ("Unknown command or unquoted prompt").
 * duo.py worked around it by appending a separator.
 */
export function normalizeClinePrompt(message: string): string {
  return message.includes(' ') ? message : `${message} .`
}

/**
 * argv for side A. The prompt is appended as the last positional argument —
 * the caller feeds it on stdin too, because argv caps at ~128 KiB and any
 * dash-leading prompt would otherwise be parsed as a flag by the CLI.
 */
export function buildOpenCodeArgs({
  message,
  model,
  session,
  approve,
}: {
  message: string
  model?: string | null
  session?: string | null
  approve?: boolean
}): string[] {
  const args = ['run', '--format', 'json']
  if (session) args.push('--session', session)
  if (model) args.push('-m', model)
  if (approve) args.push('--auto')
  args.push(message)
  return args
}

/** argv for a single-shot call that carries its own system prompt. */
export function buildOpenCodeSystemArgs({
  model,
  approve,
}: {
  model?: string | null
  approve?: boolean
} = {}): string[] {
  const args = ['run', '--format', 'json']
  if (model) args.push('-m', model)
  if (approve) args.push('--auto')
  return args
}

/**
 * One-turn request body for `opencode run`, read from stdin.
 *
 * The positional-message form has no way to express a system prompt, and the
 * skill router's whole contract lives in its system prompt ("answer with
 * EXACTLY one line", "NONE", "never explain"). Measured on the cli backend:
 * without it the router answers in prose, `parseSkillSelection` reads the
 * prose as a multi-skill selection, and every question ends up on the keyword
 * fallback. The message moves into the payload instead.
 *
 * Not used for debate turns: those need `--session` continuity, which this form
 * does not carry.
 */
export function buildSystemPayload(
  system: readonly string[],
  message: string,
): string {
  return JSON.stringify({
    system: [...system],
    messages: [{ role: 'user', content: message }],
  })
}

/** argv for side B. */
export function buildClineArgs({
  message,
  model,
  provider,
  approve,
}: {
  message: string
  model?: string | null
  provider?: string | null
  approve?: boolean
}): string[] {
  const args = [message, '--json', '--auto-approve', approve ? 'true' : 'false']
  if (provider) args.push('-P', provider)
  if (model) args.push('-m', model)
  return args
}