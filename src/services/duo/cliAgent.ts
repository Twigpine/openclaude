/**
 * duo — CLI-backed debaters.
 *
 * Side A drives the `opencode` CLI (native `--session` continuity), side B
 * drives the `cline` CLI (history replayed as a transcript because Cline's
 * `--id` requires a TTY and is incompatible with `--json`). Both are read-only
 * conversations: auto-approve stays off unless explicitly enabled.
 *
 * Parsing lives in cliParse.ts (pure, unit-tested); this module only spawns.
 */

import { execa } from 'execa'
import {
  buildClineArgs,
  buildOpenCodeArgs,
  buildOpenCodeSystemArgs,
  buildSystemPayload,
  type CliRunResult,
  type DuoTranscriptTurn,
  normalizeClinePrompt,
  parseClineOutput,
  parseOpenCodeOutput,
  wrapClineTranscript,
} from './cliParse.js'

/**
 * Per-call timeout for a CLI debater turn.
 *
 * 600s made a debate hang silently for ten minutes — a free model answers in
 * well under a minute — so the default is now generous but bounded, and
 * overridable with DUO_CLI_TIMEOUT_MS for slow providers.
 */
function cliTimeoutMs(): number {
  const raw = process.env.DUO_CLI_TIMEOUT_MS
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isInteger(parsed) && parsed >= 30_000 && parsed <= 3_600_000
    ? parsed
    : DEFAULT_CLI_TIMEOUT_MS
}

export const DEFAULT_CLI_TIMEOUT_MS = 180_000

function lastLine(stderr: string, limit = 300): string | null {
  const lines = (stderr ?? '').trim().split('\n').filter(Boolean)
  return lines.length ? (lines[lines.length - 1] ?? '').slice(0, limit) : null
}

/** Fill in a process-level error when the payload carried none. */
function withProcessError(
  parsed: CliRunResult,
  proc: {
    exitCode?: number
    timedOut: boolean
    isCanceled: boolean
    stderr: string
  },
  timeoutMs: number,
  command: string,
): CliRunResult {
  const error =
    parsed.error ??
    (proc.timedOut
      ? `timeout ${timeoutMs}ms`
      : proc.isCanceled
        ? 'canceled'
        : proc.exitCode !== undefined && proc.exitCode !== 0
          ? (lastLine(proc.stderr) ?? `${command} exited with code ${proc.exitCode}`)
          : null)
  return { ...parsed, error }
}

/**
 * Does this error mean "the free tier is saturated", i.e. try another model?
 *
 * Only these move on. A 404 (the id was never served), a 401 (needs
 * credentials) or a network failure will fail identically on every model in
 * the list, so rotating on them just multiplies the latency and buries the
 * real cause under a generic message.
 */
export function isRateLimitError(error?: string | null): boolean {
  if (!error) return false
  const lower = error.toLowerCase()
  return (
    /\b429\b/.test(lower) ||
    lower.includes('rate limit') ||
    lower.includes('rate_limit') ||
    lower.includes('too many requests') ||
    lower.includes('quota') ||
    lower.includes('overloaded')
  )
}

type Attempt = (model: string | null) => Promise<CliRunResult>

/**
 * Try each model in order until one answers.
 *
 * `models` is empty when nothing is pinned, which means "let the CLI pick its
 * default" — that is still one attempt, not zero. Treating an empty list as
 * exhaustion broke unpinned debates outright.
 *
 * The model actually used is reported back, preferring what the CLI said over
 * what we asked for: a provider that silently reroutes to a sibling model would
 * otherwise be invisible in the header.
 */
async function runWithModelFallback(
  models: readonly string[],
  attempt: Attempt,
  side: 'A' | 'B',
): Promise<CliRunResult> {
  const candidates: Array<string | null> =
    models.length > 0 ? [...models] : [null]
  let lastRateLimit: string | null = null

  for (const model of candidates) {
    let result: CliRunResult
    try {
      result = await attempt(model)
    } catch (error) {
      // execa is configured with reject:false, so this is a spawn-level
      // failure (binary missing, bad cwd). It is model-independent: rotating
      // would re-run the same broken spawn N times and then report saturation.
      const err = error as Error
      return {
        text: '',
        error: `side ${side}: ${err.name}: ${err.message}`,
      }
    }

    if (!result.error || !isRateLimitError(result.error)) {
      return result.model ? result : { ...result, model }
    }
    lastRateLimit = result.error
  }

  // Every pinned model was saturated: say which ones, so the operator can see
  // the rotation is exhausted rather than guessing which model to blame.
  const names = candidates.filter(Boolean).join(', ')
  return {
    text: '',
    error: lastRateLimit
      ? `side ${side}: all models rate-limited (${names}): ${lastRateLimit}`
      : `side ${side}: no model answered`,
  }
}

/**
 * Run one turn on side A: `opencode run --format json`.
 *
 * Pass `system` to send a system prompt; that switches the turn to the stdin
 * payload form and drops `--session`, because a positional message cannot carry
 * a system prompt and the two forms are mutually exclusive. Debate turns must
 * keep continuity, so they use the positional form with the protocol folded
 * into the user message instead.
 */
export async function runOpenCodeDebater({
  message,
  models,
  session,
  approve,
  system,
  cwd,
  timeoutMs = cliTimeoutMs(),
  cancelSignal,
}: {
  message: string
  /** Tried in order; empty means "use the opencode CLI default". */
  models: readonly string[]
  session?: string | null
  approve?: boolean
  /** System prompt; switches to the stdin form (no session continuity). */
  system?: readonly string[]
  cwd?: string
  timeoutMs?: number
  cancelSignal?: AbortSignal
}): Promise<CliRunResult> {
  return runWithModelFallback(
    models,
    async model => {
      // A system prompt cannot ride along with a positional message, so the
      // turn moves to stdin. Debates never set one: they need --session.
      const usesSystem = system !== undefined
      const args = usesSystem
        ? buildOpenCodeSystemArgs({ model, approve })
        : buildOpenCodeArgs({ message, model, session, approve })

      const proc = await execa('opencode', args, {
        cwd: cwd ?? process.cwd(),
        timeout: timeoutMs,
        cancelSignal,
        reject: false,
        stdin: usesSystem ? undefined : 'ignore',
        input: usesSystem ? buildSystemPayload(system, message) : undefined,
      })
      return withProcessError(
        parseOpenCodeOutput(proc.stdout ?? ''),
        proc,
        timeoutMs,
        'opencode',
      )
    },
    'A',
  )
}

/** Run one turn on side B: `cline --json` with replayed transcript. */
export async function runClineDebater({
  message,
  models,
  provider,
  transcript = [],
  approve,
  cwd,
  timeoutMs = cliTimeoutMs(),
  cancelSignal,
}: {
  message: string
  /** Tried in order; empty means "use the cline CLI default". */
  models: readonly string[]
  provider?: string | null
  transcript?: readonly DuoTranscriptTurn[]
  approve?: boolean
  cwd?: string
  timeoutMs?: number
  cancelSignal?: AbortSignal
}): Promise<CliRunResult> {
  const normalized = normalizeClinePrompt(message)
  const full = wrapClineTranscript(normalized, transcript)

  return runWithModelFallback(
    models,
    async model => {
      const args = buildClineArgs({ message: full, model, provider, approve })
      const proc = await execa('cline', args, {
        cwd: cwd ?? process.cwd(),
        timeout: timeoutMs,
        cancelSignal,
        reject: false,
        stdin: 'ignore',
      })
      return withProcessError(
        parseClineOutput(proc.stdout ?? ''),
        proc,
        timeoutMs,
        'cline',
      )
    },
    'B',
  )
}