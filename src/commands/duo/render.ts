/**
 * /duo — rendering: status, free-model list and result transcripts.
 */

import { parseVerdict, READ_ONLY_TOOLS } from '../../services/duo/debate.js'
import {
  CLINE_FREE_MODELS,
  CLINE_RETIREMENT_WARNING,
  KNOWN_BAD_MODELS,
  OC_FREE_MODELS,
  PROBE_DATE,
  RATE_LIMITED_MODELS,
  PROBE_STALE_AFTER,
} from '../../services/duo/freeModels.js'
import type { DuoSkillInfo } from '../../services/duo/skills.js'
import { formatDuoStats, type DuoResult, type DuoState, type DuoStats } from '../../services/duo/types.js'

/**
 * Verdict rules injected into CLI-backend prompts: those CLIs run their own
 * system prompts, so the protocol instruction has to travel with the message.
 */
export function protocolInstruction(protocol: boolean, adversarial: boolean): string {
  const verdictRule = protocol
    ? `\n\n[Protocol: end every reply with a final line exactly "VERDICT: CONSENSUS" if you agree with the peer's latest position, or "VERDICT: SUITE" if you disagree (the debate continues).]`
    : ''
  const stanceRule = adversarial
    ? `\n\n[Protocol: before updating your position, state the strongest counter-argument to your peer's reply, then whether it holds up. Do not soften a real disagreement into a vague agreement.]`
    : ''
  return verdictRule + stanceRule
}

export function formatDuoStatus(st: DuoState, sessionModel: string): string {
  const isCli = st.backend === 'cli'
  const modelA = st.modelA ?? (isCli ? '(opencode CLI default)' : `(session default: ${sessionModel})`)
  const modelB = st.modelB ?? (isCli ? '(cline CLI default)' : st.modelA ?? '(same as A)')
  const continuity = isCli
    ? `  continuity opencode: ${st.ocSession ? `session ${st.ocSession.slice(0, 12)}…` : 'new'} · cline transcript: ${st.clTranscript.length} turns`
    : `  history   A: ${st.history.A.length} msgs · B: ${st.history.B.length} msgs`
  const budgetLines: string[] = []
  if (st.budgetTokens != null) budgetLines.push(`  budget tokens  ${st.budgetTokens.toLocaleString()} (used ${st.budgetUsed.tokens.toLocaleString()})`)
  if (st.budgetUsd != null) budgetLines.push(`  budget USD     $${st.budgetUsd.toFixed(2)} (used $${st.budgetUsed.usd.toFixed(4)})`)
  if (st.budgetWallMs != null) budgetLines.push(`  budget wall    ${(st.budgetWallMs / 60000).toFixed(0)} min`)
  return [
    `duo status`,
    `  backend    ${st.backend}${isCli ? '  (A=opencode · B=cline)' : ''}`,
    `  rounds     ${st.rounds}`,
    `  protocol   ${st.protocol ? 'on' : 'off'}`,
    `  auto-skill ${st.autoSkill ? 'on' : 'off'}`,
    `  tools      ${st.grounded ? `read-only (${READ_ONLY_TOOLS.join('/')})` : 'none'}`,
    `  mode       ${st.adversarial ? 'adversarial' : 'neutral'}`,
    `  approve    ${st.approve ? 'on' : 'off'}`,
    `  model A    ${modelA}`,
    `  model B    ${modelB}`,
    ...(budgetLines.length ? ['', ...budgetLines] : []),
    continuity,
    ``,
    `usage: /duo <message> · /duo skill <name> <message> · /duo skills · /duo rounds N · /duo backend builtin|cli · /duo model a|b <id> · /duo protocol on|off · /duo models · /duo clear`,
  ].join('\n')
}

export function formatFreeModels(): string {
  const stale =
    Date.now() > Date.parse(`${PROBE_STALE_AFTER}T00:00:00Z`)
      ? [
          '',
          `⚠ probe is stale (last run ${PROBE_DATE}, refresh after ${PROBE_STALE_AFTER}):`,
          `  python3 ~/duo-stack/duo/probe_free.py`,
        ]
      : []
  return [
    `duo — free models verified ${PROBE_DATE}`,
    ``,
    `side A — opencode (${OC_FREE_MODELS.length} verified, cost 0):`,
    ...OC_FREE_MODELS.map(model => `  ${model}`),
    ``,
    `side B — cline (${CLINE_FREE_MODELS.length} verified, cost 0):`,
    ...CLINE_FREE_MODELS.map(model => `  ${model}`),
    ``,
    `use: /duo backend cli · /duo model a <id> · /duo model b <id>`,
    `warning: ${CLINE_RETIREMENT_WARNING}`,
    ``,
    `rate-limited at the last probe (usable, just busy):`,
    ...RATE_LIMITED_MODELS.map(([model, why]) => `  ${model} — ${why}`),
    ``,
    `known-bad (probe failures):`,
    ...KNOWN_BAD_MODELS.map(([model, why]) => `  ${model} — ${why}`),
    ...stale,
  ].join('\n')
}

export function formatSkillList(skills: DuoSkillInfo[]): string {
  if (skills.length === 0) {
    return [
      `duo — no skill installed.`,
      ``,
      `install one with: openclaude skills install <path> --global`,
    ].join('\n')
  }
  return [
    `duo — ${skills.length} skill(s) usable in a debate:`,
    ``,
    ...skills.map(
      skill =>
        `  ${skill.name.padEnd(30)} ${skill.description.split('\n')[0]!.slice(0, 88)}`,
    ),
    ``,
    `use: /duo skill <name> <question>`,
  ].join('\n')
}

export function formatDuoResult(
  result: DuoResult,
  opts: {
    rounds: number
    protocol: boolean
    modelA: string
    modelB: string
    /** Model each side actually served, when a 429 rotation moved it. */
    usedA?: string | null
    usedB?: string | null
    skill?: string | null
    stats?: DuoStats
  },
): string {
  const skillLabel = opts.skill ? ` · skill=${opts.skill}` : ''
  // A rotated model changes what the reader is judging, so it is never hidden
  // behind the pinned id: `A=x → y` says the turn fell through to a fallback.
  const usedA = opts.usedA ? ` → ${opts.usedA}` : ''
  const usedB = opts.usedB ? ` → ${opts.usedB}` : ''
  const lines: string[] = [
    `duo${skillLabel} · A=${opts.modelA}${usedA} · B=${opts.modelB}${usedB} · rounds ${opts.rounds} · protocol ${opts.protocol ? 'on' : 'off'}`,
  ]
  for (const e of result.entries) {
    const label =
      e.kind === 'question'
        ? 'question'
        : e.kind === 'answer'
          ? `answer ${e.side}`
          : `${e.side} → ${e.side === 'A' ? 'B' : 'A'} · round ${e.round}`
    lines.push('', `── ${label} ──`, e.text)
  }

  // The verdict tally, not the agreement narrative, is the signal worth
  // reading: "A said CI, B said no" is a finding. Consensus is only the end
  // state of the tally, and it is never a guarantee of being right.
  const tally = summarizeVerdicts(result)
  if (tally) lines.push('', `verdicts: ${tally}`)

  lines.push(
    '',
    result.stopReason === 'double-consensus'
      ? '✓ double CONSENSUS — both debaters converged (the debate stopped early)'
      : result.stopReason === 'rounds-exhausted'
        ? opts.protocol
          ? `→ no consensus after ${opts.rounds} round(s) — the disagreement stands`
          : `(${opts.rounds} debate round(s) completed)`
        : result.stopReason === 'abandoned'
          ? `→ debate abandoned after ${result.abandonedReason ?? 'a debater kept failing'}`
          : result.stopReason === 'budget-tokens'
            ? `→ budget exhausted: token ceiling reached`
            : result.stopReason === 'budget-usd'
              ? `→ budget exhausted: USD ceiling reached`
              : result.stopReason === 'budget-wall'
                ? `→ budget exhausted: wall-clock timeout reached`
                : '(opening answers only — rounds 0)',
  )
  if (opts.stats) lines.push(formatDuoStats(opts.stats))
  return lines.join('\n')
}

/**
 * Disagreement-first verdict summary, e.g.
 *   `A CI · B SUITE · CI`   (A agrees, B refused, A agrees in turn)
 *   `A SUITE · B SUITE · CI · CI`
 * Empty when no reply carried a verdict.
 */
export function summarizeVerdicts(result: DuoResult): string {
  const marks: string[] = []
  for (const entry of result.entries) {
    if (entry.kind === 'question') continue
    const verdict = parseVerdict(entry.text)
    if (!verdict) continue
    marks.push(verdict === 'CONSENSUS' ? 'CI' : 'CO')
  }
  if (marks.length === 0) return ''
  const a = marks.filter((_, i) => i % 2 === 0) // answers/debates alternate A then B
  const b = marks.filter((_, i) => i % 2 === 1)
  const counts = [
    `A ${mark(a)}`,
    `B ${mark(b)}`,
  ]
  return `${counts.join(' · ')} · ${marks.join(' ')}`
}

function mark(verdicts: string[]): string {
  return verdicts.length > 0
    ? `${verdicts.filter(v => v === 'CI').length}/${verdicts.length} CI`
    : '—'
}
