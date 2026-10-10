import type { Message } from '../../types/message.js'
import type { DuoTranscriptTurn } from './cliParse.js'

/** Which model backend drives the debaters. */
export type DuoBackend =
  /** In-process forked queries against the session's configured provider. */
  | 'builtin'
  /** Side A = `opencode` CLI, side B = `cline` CLI (free models). */
  | 'cli'

/** A debater identity in the duo protocol. */
export type DuoSide = 'A' | 'B'

/** Verdict line required by the consensus protocol. */
export type DuoVerdict = 'CONSENSUS' | 'SUITE'

/** One entry of a debate transcript. */
export type DuoEntry = {
  kind: 'question' | 'answer' | 'debate'
  /** 0 = opening answers to the user question, 1..N = internal debate rounds. */
  round: number
  side: DuoSide
  text: string
}

/** Result of a single debate run. */
export type DuoResult = {
  entries: DuoEntry[]
  stopReason: 'answers-only' | 'rounds-exhausted' | 'double-consensus' | 'abandoned' | 'budget-tokens' | 'budget-usd' | 'budget-wall'
  doubleConsensus: boolean
  /** Why the debate was abandoned (only when stopReason is 'abandoned'). */
  abandonedReason?: string
}

/**
 * Session-scoped duo configuration and conversation state.
 * Kept in AppState (like goal) — not persisted across app restarts.
 */
export type DuoState = {
  /** Internal debate rounds after the opening answers (0 = answers only). */
  rounds: number
  /** VERDICT: CONSENSUS/SUITE protocol + early stop on double consensus. */
  protocol: boolean
  /** Model for side A (null = session model for builtin, CLI default for cli). */
  modelA: string | null
  /** Fallback models for side A (tried in order on 429). */
  modelAFallbacks: string[]
  /** Model for side B (null = same as A for builtin, CLI default for cli). */
  modelB: string | null
  /** Fallback models for side B (tried in order on 429). */
  modelBFallbacks: string[]
  /** Per-side conversation history (builtin backend only). */
  history: Record<DuoSide, Message[]>
  /** Which backend runs the model calls. */
  backend: DuoBackend
  /** Auto-approve tools for the CLI backend (default OFF). */
  approve: boolean
  /**
   * Debaters may inspect the project read-only (Read/Glob/Grep) so a debate
   * rests on facts instead of recollection (default ON). Still no writes,
   * no shell: `requireCanUseTool` holds.
   */
  grounded: boolean
  /**
   * Each debater must state the peer's strongest counter-argument before
   * updating its position (default ON). Surfaces real disagreement instead
   * of drifting into polite agreement.
   */
  adversarial: boolean
  /** Route every question to the best skill automatically (default ON). */
  autoSkill: boolean
  /** OpenCode session id for side A (cli backend, native --session). */
  ocSession: string | null
  /** Replayed transcript for side B (cli backend; Cline resume needs a TTY). */
  clTranscript: DuoTranscriptTurn[]
  /** Optional session name for persistence (when saved via /duo save). */
  sessionName: string | null
  /** Budget enforcement: total token ceiling (input+output across both sides). */
  budgetTokens: number | null
  /** Budget enforcement: estimated USD ceiling (uses provider pricing if available). */
  budgetUsd: number | null
  /** Budget enforcement: wall-clock timeout in milliseconds. */
  budgetWallMs: number | null
  /** Budget consumed so far (for resume). */
  budgetUsed: { tokens: number; usd: number }
}

export function createDuoState(): DuoState {
  const backendRaw = process.env.DUO_BACKEND?.trim().toLowerCase()
  return {
    rounds: envInt('DUO_ROUNDS', 1),
    protocol: envFlag('DUO_PROTOCOL', false),
    modelA: process.env.DUO_MODEL_A?.trim() || null,
    modelAFallbacks: (process.env.DUO_MODEL_A_FALLBACKS?.split(',').map(s => s.trim()).filter(Boolean) ?? []),
    modelB: process.env.DUO_MODEL_B?.trim() || null,
    modelBFallbacks: (process.env.DUO_MODEL_B_FALLBACKS?.split(',').map(s => s.trim()).filter(Boolean) ?? []),
    history: { A: [], B: [] },
    backend:
      backendRaw === 'cli' || backendRaw === 'builtin' ? backendRaw : 'builtin',
    approve: envFlag('DUO_APPROVE', false),
    grounded: envFlag('DUO_GROUNDED', true),
    adversarial: envFlag('DUO_ADVERSARIAL', true),
    autoSkill: envFlag('DUO_AUTO_SKILL', true),
    ocSession: null,
    clTranscript: [],
    sessionName: null,
    budgetTokens: envInt('DUO_BUDGET_TOKENS', 0) || null,
    budgetUsd: parseFloat(process.env.DUO_BUDGET_USD ?? '') || null,
    budgetWallMs: envInt('DUO_BUDGET_WALL_MS', 0) || null,
    budgetUsed: { tokens: 0, usd: 0 },
  }
}

/** Upper bound for internal debate rounds. */
export const DUO_MAX_ROUNDS = 5

/**
 * Env overrides for the initial state: DUO_BACKEND, DUO_ROUNDS, DUO_PROTOCOL,
 * DUO_APPROVE, DUO_AUTO_SKILL, DUO_MODEL_A, DUO_MODEL_B, DUO_GROUNDED,
 * DUO_ADVERSARIAL. Useful for headless runs (`-p`) where slash commands
 * cannot be chained in a single prompt. Invalid values fall back to the
 * defaults.
 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= DUO_MAX_ROUNDS
    ? parsed
    : fallback
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase()
  if (!raw) return fallback
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes'
}

/** Keep side B's replayed transcript bounded (Cline has no resume in --json). */
export const MAX_TRANSCRIPT_TURNS = 20

/**
 * Bound one side's stored conversation. The builtin backend replays this
 * history on every turn, so an unbounded array would grow cost quadratically
 * inside a debate and hit the prompt limit across a session.
 */
export const MAX_HISTORY_MESSAGES = 12

/** Pure: append messages to a side's history, keeping the newest N. */
export function capHistory<T>(history: readonly T[], additions: readonly T[]): T[] {
  const merged = [...history, ...additions]
  return merged.length > MAX_HISTORY_MESSAGES
    ? merged.slice(merged.length - MAX_HISTORY_MESSAGES)
    : merged
}

/** Token usage reported by one debater turn. */
export type DuoUsage = { input: number; output: number; cost: number }

/** One completed turn. */
export type DuoTurnStat = {
  side: DuoSide
  phase: 'opening' | 'debate'
  ms: number
  /** Model that actually answered, when the backend reports one. */
  model?: string | null
}

/**
 * Cost and time of a debate, accumulated across turns.
 * Every side reports nothing in practice unless the provider does, so zero
 * totals must be shown as "unknown" rather than "free".
 */
export type DuoStats = {
  turns: DuoTurnStat[]
  usage: Record<DuoSide, DuoUsage>
}

export function createDuoStats(): DuoStats {
  return {
    turns: [],
    usage: {
      A: { input: 0, output: 0, cost: 0 },
      B: { input: 0, output: 0, cost: 0 },
    },
  }
}

/** Add one debater turn: usage accumulates, timing is recorded. */
export function recordTurn(
  stats: DuoStats,
  side: DuoSide,
  phase: 'opening' | 'debate',
  usage: DuoUsage,
  ms: number,
  model?: string | null,
): void {
  stats.turns.push({ side, phase, ms, model: model ?? null })
  const current = stats.usage[side]
  stats.usage[side] = {
    input: current.input + usage.input,
    output: current.output + usage.output,
    cost: current.cost + usage.cost,
  }
}

/** `A 1234 in / 45 out · B 12 in / 3 out · 42 s` — or nothing when unknown. */
export function formatDuoStats(stats: DuoStats): string {
  const ms = stats.turns.reduce((sum, turn) => sum + turn.ms, 0)
  const known = (side: DuoSide) => stats.usage[side].input || stats.usage[side].output
  const parts: string[] = []
  for (const side of ['A', 'B'] as const) {
    const usage = stats.usage[side]
    parts.push(
      known(side)
        ? `${side} ${usage.input} in / ${usage.output} out`
        : `${side} usage unknown`,
    )
  }
  return `${parts.join(' · ')} · ${(ms / 1000).toFixed(0)} s`
}

/**
 * The model that actually served a side's turns, when it differs from the one
 * pinned — the 429 rotation means the pinned model is only the first candidate.
 *
 * Returns null when every turn ran on the pinned model (or the backend never
 * reported one), so the header can stay uncluttered in the common case.
 */
export function effectiveModel(
  stats: DuoStats,
  side: DuoSide,
  pinned: string | null,
): string | null {
  const used = new Set(
    stats.turns.filter(t => t.side === side && t.model).map(t => t.model as string),
  )
  if (used.size === 0) return null
  if (used.size === 1) {
    const only = [...used][0] as string
    return only === pinned ? null : only
  }
  // Mixed within one debate: more interesting than either endpoint.
  return [...used].sort().join(' → ')
}
