/**
 * duo — pure debate engine.
 *
 * Two debaters (A and B) answer the same user message in parallel, then
 * exchange replies for N internal rounds. With the consensus protocol on,
 * every reply must end with a verdict line (`VERDICT: CONSENSUS` or
 * `VERDICT: SUITE`); the debate stops early once both sides' latest verdicts
 * are CONSENSUS ("double consensus"). SUITE revokes any standing agreement.
 *
 * The engine is deliberately I/O-free: model calls are injected via `ask`,
 * which makes the whole flow unit-testable.
 */

import type { DuoEntry, DuoResult, DuoSide, DuoVerdict, DuoStats } from './types.js'

/** Matches a verdict line anywhere in a reply (global: matchAll needs /g). */
const VERDICT_RE = /\bVERDICT:\s*(CONSENSUS|SUITE)\b/gi

/**
 * Extract the verdict of a reply, or null when none is present.
 * Only the LAST verdict mention counts — a reply may quote its peer's
 * verdict line while disagreeing with it.
 */
export function parseVerdict(text: string): DuoVerdict | null {
  const matches = [...text.matchAll(VERDICT_RE)]
  const last = matches[matches.length - 1]
  const value = last?.[1]
  if (!value) return null
  return value.toUpperCase() as DuoVerdict
}

/** True when both replies carry a CONSENSUS verdict. */
export function isDoubleConsensus(replyA: string, replyB: string): boolean {
  return (
    parseVerdict(replyA) === 'CONSENSUS' && parseVerdict(replyB) === 'CONSENSUS'
  )
}

/** Tools a debater may use when grounded mode is on: inspection only. */
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'] as const

/** How many API round-trips a debater gets when read tools are available. */
export const READ_TOOLS_MAX_TURNS = 6

/**
 * System prompt for one debater side.
 *
 * - `protocol` toggles the verdict rules. `requireVerdict` is separate and
 *   deliberately narrower: a verdict on the OPENING turn asks a model to
 *   agree or disagree with a position that does not exist yet — real clients
 *   refuse to emit one there, rightly. Verdicts are only meaningful once each
 *   side has seen the other, so the opening asks for none.
 * - `tools` = 'read' lets the debater inspect the project (read-only) so a
 *   debate can rest on facts instead of recollection; 'none' keeps turns
 *   single-shot and text-only.
 * - `stance` = 'adversarial' asks for the peer's strongest counter-argument
 *   before updating, which surfaces real disagreement; 'neutral' keeps the
 *   plain exchange.
 */
export function duoSystemPrompt(
  side: DuoSide,
  protocol: boolean,
  tools: 'read' | 'none' = 'none',
  stance: 'adversarial' | 'neutral' = 'neutral',
  requireVerdict: boolean = protocol,
): readonly string[] {
  const protocolRules = protocol
    ? requireVerdict
      ? [
          '- End EVERY reply with a final line exactly in this form:',
          '    VERDICT: CONSENSUS   (you agree with your peer’s latest position)',
          '    VERDICT: SUITE       (you disagree or found an error — the debate continues)',
          '  SUITE revokes any previous agreement. The debate stops early once',
          '  both debaters’ latest verdicts are CONSENSUS.',
        ]
      : [
          '- Do NOT emit a verdict on this turn: there is no peer position to',
          '  agree or disagree with yet. Later turns will ask for one.',
        ]
    : ['- Do not emit any VERDICT lines (the consensus protocol is off).']

  const toolRules =
    tools === 'read'
      ? [
          `- You may inspect the project with ${READ_ONLY_TOOLS.join(', ')} — nothing else.`,
          '- Never edit files, run commands, or write anything: this is a debate,',
          '  not an implementation. Ground every claim in what you actually read.',
        ]
      : [
          '- You have NO tools: you cannot read files, run commands, or look anything',
          '  up. Say plainly when a question needs facts you do not have.',
        ]

  const stanceRules =
    stance === 'adversarial'
      ? [
          '- Before updating your position, state the single strongest counter-argument',
          '  to your peer’s latest reply, then say whether it holds up. Do not soften a',
          '  real disagreement into a vague agreement.',
        ]
      : []

  return [
    `You are debater ${side} in "duo", a structured debate between two AI assistants that receive the same user message.`,
    'Rules:',
    '- Answer the incoming message directly and concisely, in plain text.',
    ...toolRules,
    '- First you answer the user’s question; afterwards you see your peer debater’s replies and respond to them.',
    ...stanceRules,
    '- Keep the same language as the incoming message.',
    ...protocolRules,
  ]
}

/** A model call from one debater: returns its reply to `incoming`. */
export type DuoAsk = (
  side: DuoSide,
  incoming: string,
  phase: 'opening' | 'debate',
) => Promise<string>

/**
 * Check if any budget has been exceeded.
 *
 * Returns the stop reason if a budget is exceeded, null otherwise.
 */
function checkBudgets(
  stats: DuoStats,
  budgets: { tokens?: number | null; usd?: number | null; wallMs?: number | null; startedAt: number },
): 'budget-tokens' | 'budget-usd' | 'budget-wall' | null {
  // Token budget
  if (budgets.tokens != null) {
    const totalTokens = stats.usage.A.input + stats.usage.A.output + stats.usage.B.input + stats.usage.B.output
    if (totalTokens >= budgets.tokens) return 'budget-tokens'
  }
  // USD budget
  if (budgets.usd != null) {
    const totalUsd = stats.usage.A.cost + stats.usage.B.cost
    if (totalUsd >= budgets.usd) return 'budget-usd'
  }
  // Wall-clock budget
  if (budgets.wallMs != null) {
    const elapsed = Date.now() - budgets.startedAt
    if (elapsed >= budgets.wallMs) return 'budget-wall'
  }
  return null
}

/** Thrown when the user interrupts a debate; no state must be persisted. */
export class DuoAbortError extends Error {
  constructor() {
    super('duo debate interrupted')
    this.name = 'DuoAbortError'
  }
}

/**
 * A turn that produced no usable answer. Both backends prefix failures their
 * own way, so the engine detects them without knowing which backend ran:
 * two in a row means a provider is down, and the remaining rounds would only
 * burn tokens.
 */
const FAILED_TURN_MARKERS = [
  '(no reply received)',
  '(API error:',
  '(CLI error:',
]

export function isFailedTurn(text: string): boolean {
  return FAILED_TURN_MARKERS.some(marker => text.startsWith(marker))
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DuoAbortError()
}

/**
 * Run one debate.
 *
 * `ask(side, incoming, phase)` must return side's reply to `incoming`.
 * Both sides are asked in parallel each turn; `phase` distinguishes the
 * opening answers to the user's question from peer replies.
 *
 * Budget parameters (all optional): tokens = total input+output ceiling,
 * usd = estimated cost ceiling, wallMs = wall-clock timeout in ms.
 * When a budget is exceeded the debate stops cleanly with the corresponding
 * stopReason. The caller passes the stats object which accumulates usage.
 */
export async function runDebate({
  question,
  rounds,
  protocol,
  ask,
  signal,
  budgetTokens = null,
  budgetUsd = null,
  budgetWallMs = null,
  stats,
}: {
  question: string
  rounds: number
  protocol: boolean
  ask: DuoAsk
  signal?: AbortSignal
  budgetTokens?: number | null
  budgetUsd?: number | null
  budgetWallMs?: number | null
  stats: DuoStats
}): Promise<DuoResult> {
  const entries: DuoEntry[] = [
    { kind: 'question', round: 0, side: 'A', text: question },
  ]
  const startedAt = Date.now()

  // Opening: both debaters answer the user's question in parallel.
  assertNotAborted(signal)
  const [openingA, openingB] = await Promise.all([
    ask('A', question, 'opening'),
    ask('B', question, 'opening'),
  ])
  assertNotAborted(signal)
  entries.push({ kind: 'answer', round: 0, side: 'A', text: openingA })
  entries.push({ kind: 'answer', round: 0, side: 'B', text: openingB })

  // Check budgets after opening answers
  const budgetCheck = checkBudgets(stats, { tokens: budgetTokens, usd: budgetUsd, wallMs: budgetWallMs, startedAt })
  if (budgetCheck) return { entries, stopReason: budgetCheck, doubleConsensus: false }

  if (rounds <= 0) {
    return { entries, stopReason: 'answers-only', doubleConsensus: false }
  }

  if (protocol && isDoubleConsensus(openingA, openingB)) {
    return { entries, stopReason: 'double-consensus', doubleConsensus: true }
  }

  // Internal debate: each side responds to the peer's LATEST reply.
  let lastA = openingA
  let lastB = openingB
  let failuresInARowA = isFailedTurn(openingA) ? 1 : 0
  let failuresInARowB = isFailedTurn(openingB) ? 1 : 0

  for (let round = 1; round <= rounds; round++) {
    assertNotAborted(signal)
    const [replyA, replyB] = await Promise.all([
      ask('A', lastB, 'debate'),
      ask('B', lastA, 'debate'),
    ])
    assertNotAborted(signal)

    failuresInARowA = isFailedTurn(replyA) ? failuresInARowA + 1 : 0
    failuresInARowB = isFailedTurn(replyB) ? failuresInARowB + 1 : 0
    entries.push({ kind: 'debate', round, side: 'A', text: replyA })
    entries.push({ kind: 'debate', round, side: 'B', text: replyB })
    lastA = replyA
    lastB = replyB

    // Check budgets after each debate round
    const budgetCheck = checkBudgets(stats, { tokens: budgetTokens, usd: budgetUsd, wallMs: budgetWallMs, startedAt })
    if (budgetCheck) return { entries, stopReason: budgetCheck, doubleConsensus: false }

    if (failuresInARowA >= 2 || failuresInARowB >= 2) {
      const side = failuresInARowA >= 2 ? 'A' : 'B'
      return {
        entries,
        stopReason: 'abandoned',
        doubleConsensus: false,
        abandonedReason: `debater ${side} failed twice in a row — the remaining rounds would only burn tokens`,
      }
    }

    if (protocol && isDoubleConsensus(replyA, replyB)) {
      return { entries, stopReason: 'double-consensus', doubleConsensus: true }
    }
  }

  return { entries, stopReason: 'rounds-exhausted', doubleConsensus: false }
}
