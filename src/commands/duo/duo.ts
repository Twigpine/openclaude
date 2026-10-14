/**
 * /duo — structured debate between two models.
 *
 * Both debaters answer the user's message in parallel, then exchange replies
 * for N internal rounds. With the consensus protocol on, every reply ends
 * with `VERDICT: CONSENSUS` or `VERDICT: SUITE` and the debate stops early
 * on double consensus.
 *
 * Model calls reuse runForkedAgent with a per-side `mainLoopModel` override —
 * the same routing mechanism AgentTool uses for teammate models. Tools are
 * denied and maxTurns is capped at 1: debaters can only produce text.
 *
 * Two backends:
 * - `builtin` (default): in-process forked queries on the session provider.
 * - `cli`: side A drives the `opencode` CLI, side B the `cline` CLI, so the
 *   free models of both platforms can be debated with each other.
 */

import type { LocalJSXCommandContext, LocalCommandCall, LocalCommandResult } from '../../types/command.js'
import type { Message, SystemAPIErrorMessage } from '../../types/message.js'
import type { Tool } from '../../Tool.js'
import { formatAPIError } from '../../services/api/errorUtils.js'
import { runClineDebater, runOpenCodeDebater } from '../../services/duo/cliAgent.js'
import {
  DuoAbortError,
  duoSystemPrompt,
  parseVerdict,
  READ_ONLY_TOOLS,
  READ_TOOLS_MAX_TURNS,
  runDebate,
} from '../../services/duo/debate.js'
import {
  CLINE_FREE_MODELS,
  CLINE_RETIREMENT_WARNING,
  KNOWN_BAD_MODELS,
  OC_FREE_MODELS,
  PROBE_DATE,
  RATE_LIMITED_MODELS,
  PROBE_STALE_AFTER,
} from '../../services/duo/freeModels.js'
import {
  composeSelectedSkillsQuestion,
  selectSkills,
  SKILL_ROUTER_SYSTEM,
} from '../../services/duo/skillSelect.js'
import { composeSkillQuestion, type DuoSkillInfo, listDuoSkills, readDuoSkill } from '../../services/duo/skills.js'
import {
  capHistory,
  createDuoState,
  createDuoStats,
  DUO_MAX_ROUNDS,
  effectiveModel,
  formatDuoStats,
  MAX_TRANSCRIPT_TURNS,
  recordTurn,
  type DuoBackend,
  type DuoResult,
  type DuoState,
  type DuoStats,
  type DuoSide,
} from '../../services/duo/types.js'
import { deleteSession, listSessions, loadSession, saveSession } from '../../services/duo/persistence.js'
import { runForkedAgent, type SubagentContextOverrides } from '../../utils/forkedAgent.js'
import { createAssistantMessage, createUserMessage, extractTextContent } from '../../utils/messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'

/**
 * Verdict rules injected into CLI-backend prompts: those CLIs run their own
 * system prompts, so the protocol instruction has to travel with the message.
 */
function protocolInstruction(protocol: boolean, adversarial: boolean): string {
  const verdictRule = protocol
    ? `\n\n[Protocol: end every reply with a final line exactly "VERDICT: CONSENSUS" if you agree with the peer's latest position, or "VERDICT: SUITE" if you disagree (the debate continues).]`
    : ''
  const stanceRule = adversarial
    ? `\n\n[Protocol: before updating your position, state the strongest counter-argument to your peer's reply, then whether it holds up. Do not soften a real disagreement into a vague agreement.]`
    : ''
  return verdictRule + stanceRule
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export type DuoInput =
  | { verb: 'status' }
  | { verb: 'clear' }
  | { verb: 'models' }
  | { verb: 'skills' }
  | { verb: 'skill'; skill: string; question: string; error?: string }
  | { verb: 'run'; question: string }
  | { verb: 'rounds'; rounds: number; error?: string }
  | { verb: 'protocol'; on: boolean; error?: string }
  | { verb: 'auto'; on: boolean; error?: string }
  | { verb: 'grounded'; on: boolean; error?: string }
  | { verb: 'adversarial'; on: boolean; error?: string }
  | { verb: 'backend'; backend: DuoBackend; error?: string }
  | { verb: 'approve'; on: boolean; error?: string }
  | { verb: 'model'; side: DuoSide; model: string; error?: string }
  | { verb: 'budget'; type: 'tokens' | 'usd' | 'wall' | 'off'; value?: number; error?: string }
  | { verb: 'save'; name: string; error?: string }
  | { verb: 'load'; name: string; error?: string }
  | { verb: 'sessions' }
  | { verb: 'delete'; name: string; error?: string }

const MAX_ROUNDS = DUO_MAX_ROUNDS

/** Parse the raw argument string of /duo into a command intent. */
export function parseDuoInput(raw: string): DuoInput {
  const trimmed = raw.trim()
  if (!trimmed) return { verb: 'status' }

  const first = trimmed.split(/\s+/, 1)[0]!.toLowerCase()
  const rest = trimmed.slice(trimmed.split(/\s+/, 1)[0]!.length).trim()

  switch (first) {
    case 'status':
    case 'models':
    case 'skills':
    case 'clear': {
      // `/duo status of my auth flow` is a question, not a subcommand.
      if (rest) return { verb: 'run', question: trimmed }
      return { verb: first as 'status' | 'models' | 'skills' | 'clear' }
    }
    case 'skill': {
      const parts = rest.split(/\s+/).filter(Boolean)
      if (parts.length === 0) {
        return { verb: 'skill', skill: '', question: '', error: 'usage: /duo skill <name> <question>' }
      }
      const skill = parts[0]!
      const question = parts.slice(1).join(' ')
      if (!question) {
        return {
          verb: 'skill',
          skill,
          question: '',
          error: `usage: /duo skill ${skill} <question>`,
        }
      }
      return { verb: 'skill', skill, question }
    }
    case 'backend': {
      const v = rest.toLowerCase()
      if (v === 'builtin') return { verb: 'backend', backend: 'builtin' }
      if (v === 'cli') return { verb: 'backend', backend: 'cli' }
      return { verb: 'backend', backend: 'builtin', error: 'usage: /duo backend builtin|cli' }
    }
    case 'approve': {
      const v = rest.toLowerCase()
      if (v === 'on') return { verb: 'approve', on: true }
      if (v === 'off') return { verb: 'approve', on: false }
      return { verb: 'approve', on: false, error: 'usage: /duo approve on|off' }
    }
    case 'auto': {
      const v = rest.toLowerCase()
      if (v === 'on') return { verb: 'auto', on: true }
      if (v === 'off') return { verb: 'auto', on: false }
      return { verb: 'auto', on: false, error: 'usage: /duo auto on|off' }
    }
    case 'tools': {
      const v = rest.toLowerCase()
      if (v === 'on') return { verb: 'grounded', on: true }
      if (v === 'off') return { verb: 'grounded', on: false }
      return { verb: 'grounded', on: false, error: 'usage: /duo tools on|off' }
    }
    case 'mode': {
      const v = rest.toLowerCase()
      if (v === 'adversarial') return { verb: 'adversarial', on: true }
      if (v === 'neutral') return { verb: 'adversarial', on: false }
      return { verb: 'adversarial', on: true, error: 'usage: /duo mode adversarial|neutral' }
    }
    case 'budget': {
      const parts = rest.split(/\s+/).filter(Boolean)
      if (parts.length === 0) {
        return { verb: 'budget', type: 'tokens', error: 'usage: /duo budget tokens|usd|wall <value>' }
      }
      const sub = parts[0]!.toLowerCase()
      if (sub === 'tokens') {
        const n = Number.parseInt(parts[1] ?? '', 10)
        if (!Number.isInteger(n) || n <= 0) {
          return { verb: 'budget', type: 'tokens', error: 'usage: /duo budget tokens <positive-integer>' }
        }
        return { verb: 'budget', type: 'tokens', value: n }
      }
      if (sub === 'usd') {
        const n = Number.parseFloat(parts[1] ?? '')
        if (!Number.isFinite(n) || n <= 0) {
          return { verb: 'budget', type: 'usd', error: 'usage: /duo budget usd <positive-number>' }
        }
        return { verb: 'budget', type: 'usd', value: n }
      }
      if (sub === 'wall') {
        const n = Number.parseInt(parts[1] ?? '', 10)
        if (!Number.isInteger(n) || n <= 0) {
          return { verb: 'budget', type: 'wall', error: 'usage: /duo budget wall <minutes>' }
        }
        return { verb: 'budget', type: 'wall', value: n * 60000 } // minutes to ms
      }
      if (sub === 'off') {
        return { verb: 'budget', type: 'off' }
      }
      return { verb: 'budget', type: 'tokens', error: 'usage: /duo budget tokens|usd|wall <value> | off' }
    }
    case 'save': {
      const name = rest.trim()
      if (!name) return { verb: 'save', name: '', error: 'usage: /duo save <name>' }
      return { verb: 'save', name }
    }
    case 'load': {
      const name = rest.trim()
      if (!name) return { verb: 'load', name: '', error: 'usage: /duo load <name>' }
      return { verb: 'load', name }
    }
    case 'sessions': {
      return { verb: 'sessions' }
    }
    case 'delete': {
      const name = rest.trim()
      if (!name) return { verb: 'delete', name: '', error: 'usage: /duo delete <name>' }
      return { verb: 'delete', name }
    }
    case 'rounds': {
      const n = Number.parseInt(rest, 10)
      if (!Number.isInteger(n) || `${n}` !== rest || n < 0 || n > MAX_ROUNDS) {
        return {
          verb: 'rounds',
          rounds: 0,
          error: `rounds must be an integer between 0 and ${MAX_ROUNDS} (got "${rest}")`,
        }
      }
      return { verb: 'rounds', rounds: n }
    }
    case 'protocol': {
      const v = rest.toLowerCase()
      if (v === 'on') return { verb: 'protocol', on: true }
      if (v === 'off') return { verb: 'protocol', on: false }
      return { verb: 'protocol', on: false, error: 'usage: /duo protocol on|off' }
    }
    case 'model': {
      const parts = rest.split(/\s+/).filter(Boolean)
      const lower = parts.map(part => part.toLowerCase())
      if (parts.length === 2 && (lower[0] === 'a' || lower[0] === 'b')) {
        const side: DuoSide = lower[0] === 'a' ? 'A' : 'B'
        const model = parts[1]!
        if (!isValidModelId(model)) {
          return { verb: 'model', side, model, error: `invalid model id "${model}"` }
        }
        return { verb: 'model', side, model }
      }
      if (parts.length === 1) {
        const model = parts[0]!
        // `/duo model a` is a side without a model, not a model named "a".
        if (lower[0] === 'a' || lower[0] === 'b') {
          return {
            verb: 'model',
            side: 'B',
            model: '',
            error: `usage: /duo model ${lower[0]} <model-id>`,
          }
        }
        if (!isValidModelId(model)) {
          return { verb: 'model', side: 'B', model, error: `invalid model id "${model}"` }
        }
        // Single id sets side B (the peer of the session default, side A).
        return { verb: 'model', side: 'B', model }
      }
      return {
        verb: 'model',
        side: 'B',
        model: '',
        error: 'usage: /duo model a|b <model-id> (or /duo model <id> for side B)',
      }
    }
    default:
      return { verb: 'run', question: trimmed }
  }
}

/** Resolve the model string for one side. Null config = session default. */
export function resolveDuoModel(
  side: DuoSide,
  st: DuoState,
  sessionModel: string,
): string {
  if (side === 'A') return st.modelA ?? sessionModel
  return st.modelB ?? st.modelA ?? sessionModel
}

/** Flatten assistant text across yielded messages (may be split per block). */
function extractReply(messages: Message[]): string {
  const assistantBlocks = messages.flatMap(m =>
    m.type === 'assistant' ? m.message.content : [],
  )
  const text = extractTextContent(assistantBlocks, '\n\n').trim()
  if (text) return text

  const apiErr = messages.find(
    (m): m is SystemAPIErrorMessage =>
      m.type === 'system' && 'subtype' in m && m.subtype === 'api_error',
  )
  if (apiErr) return `(API error: ${formatAPIError(apiErr.error)})`
  return '(no reply received)'
}

function formatDuoStatus(st: DuoState, sessionModel: string): string {
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

function formatSkillList(skills: DuoSkillInfo[]): string {
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

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function getDuoState(context: LocalJSXCommandContext): DuoState {
  return context.getAppState().duo ?? createDuoState()
}

function saveDuoState(context: LocalJSXCommandContext, st: DuoState): void {
  context.setAppState(prev => ({ ...prev, duo: st }))
}

// ---------------------------------------------------------------------------
// Model call adapter
// ---------------------------------------------------------------------------

/** Model ids are passed to CLIs as `-m <id>`; keep flag-shaped input out. */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/

export function isValidModelId(value: string): boolean {
  return MODEL_ID_RE.test(value)
}

/**
 * Per-side routing overrides for a forked debater.
 *
 * query() reads the model from appState, not from options, so BOTH
 * `mainLoopModel` and `mainLoopModelForSession` move — the same mechanism
 * AgentTool uses for teammate models (runAgent.ts). Setting only
 * `options.mainLoopModel` leaves the debater on the session model.
 *
 * `requireCanUseTool` keeps a PreToolUse/PermissionRequest hook answering
 * "allow" from bypassing the tool denial.
 */
export function buildDuoOverrides(
  context: LocalJSXCommandContext,
  model: string,
): SubagentContextOverrides {
  return {
    options: { ...context.options, mainLoopModel: model },
    getAppState: () => ({
      ...context.getAppState(),
      mainLoopModel: model,
      mainLoopModelForSession: model,
    }),
    requireCanUseTool: true,
  }
}

/**
 * Build the `ask` callback for runDebate: one forked, tool-less, single-turn
 * model call per side per turn, with the side's conversation history.
 * Mutates `st.history[side]` as replies arrive.
 */
/**
 * Map a forked-agent usage object to our shape.
 * `NonNullableUsage` is the Anthropic SDK's Usage with nulls made required, so
 * the field names are read defensively rather than assumed.
 */
function usageFromFork(usage: unknown): { input: number; output: number; cost: number } {
  const raw = (usage ?? {}) as Record<string, unknown>
  const num = (key: string): number =>
    typeof raw[key] === 'number' ? (raw[key] as number) : 0
  return { input: num('input_tokens'), output: num('output_tokens'), cost: num('cost_usd') }
}

function makeAsk(
  context: LocalJSXCommandContext,
  st: DuoState,
  stats: DuoStats,
) {
  const signal = context.abortController?.signal

  return async (
    side: DuoSide,
    incoming: string,
    phase: 'opening' | 'debate',
  ): Promise<string> => {
    const sessionModel = context.options.mainLoopModel
    const models = side === 'A'
      ? [st.modelA, ...st.modelAFallbacks].filter(Boolean) as string[]
      : [st.modelB, ...st.modelBFallbacks].filter(Boolean) as string[]
    const history = st.history[side]
    const content =
      phase === 'opening'
        ? incoming
        : `Your peer debater replied:\n\n${incoming}\n\nRespond to their reply.`
    const userMsg = createUserMessage({ content })

    const startedAt = Date.now()
    const result = await runForkedAgent({
      promptMessages: [userMsg],
      cacheSafeParams: {
        systemPrompt: asSystemPrompt(
          duoSystemPrompt(
            side,
            st.protocol,
            st.grounded ? 'read' : 'none',
            st.adversarial ? 'adversarial' : 'neutral',
            // No verdict on the opening turn: there is no peer position yet.
            phase !== 'opening',
          ),
        ),
        userContext: {},
        systemContext: {},
        toolUseContext: context,
        forkContextMessages: history,
      },
      canUseTool: async (tool: Tool) => {
        // Grounded debate: read-only inspection is allowed, everything else is
        // denied. `requireCanUseTool` (below) means an allow-style hook cannot
        // bypass this closure. Whitelisted by name rather than tool.isReadOnly()
        // so an MCP or plugin tool cannot self-declare as read-only to slip in.
        if (st.grounded && (READ_ONLY_TOOLS as readonly string[]).includes(tool.name)) {
          return {
            behavior: 'allow' as const,
            decisionReason: {
              type: 'other' as const,
              reason: 'duo_grounded_read',
            },
          }
        }
        return {
          behavior: 'deny' as const,
          message: st.grounded
            ? `duo debaters may only read (${READ_ONLY_TOOLS.join(', ')}). This turn cannot use "${tool}".`
            : 'duo debate turns cannot use tools',
          decisionReason: {
            type: 'other' as const,
            reason: st.grounded ? 'duo_grounded_readonly' : 'duo',
          },
        }
      },
      querySource: 'duo',
      forkLabel: `duo_${side}`,
      overrides: buildDuoOverrides(context, models[0]),
      maxTurns: st.grounded ? READ_TOOLS_MAX_TURNS : 1,
      skipCacheWrite: true,
      skipTranscript: true,
    })

    if (signal?.aborted) throw new DuoAbortError()

    const reply = extractReply(result.messages)
    st.history[side] = capHistory(history, [userMsg, createAssistantMessage({ content: reply })])
    recordTurn(stats, side, phase, usageFromFork(result.totalUsage), Date.now() - startedAt, models[0] ?? null)
    return reply
  }
}

/**
 * Build the `ask` callback for the CLI backend: side A drives `opencode run`
 * (session continuity via --session), side B drives `cline --json` with the
 * replayed transcript. Auto-approve stays off unless explicitly enabled.
 */
function makeCliAsk(
  context: LocalJSXCommandContext,
  st: DuoState,
  stats: DuoStats,
) {
  const cwd = process.cwd()
  const cancelSignal = context.abortController?.signal

  return async (
    side: DuoSide,
    incoming: string,
    phase: 'opening' | 'debate',
  ): Promise<string> => {
    const content =
      (phase === 'opening'
        ? incoming
        : `Your peer debater replied:\n\n${incoming}\n\nRespond to their reply.`) +
      // Same rule as the builtin backend: no verdict before a peer position.
      (st.protocol && phase !== 'opening'
        ? protocolInstruction(st.protocol, st.adversarial)
        : '')

    const startedAt = Date.now()
    const modelsA = [st.modelA, ...st.modelAFallbacks].filter(Boolean) as string[]
    const modelsB = [st.modelB, ...st.modelBFallbacks].filter(Boolean) as string[]
    const models = side === 'A' ? modelsA : modelsB

    const result =
      side === 'A'
        ? await runOpenCodeDebater({
            message: content,
            models: modelsA,
            session: st.ocSession,
            approve: st.approve,
            cwd,
            cancelSignal,
          })
        : await runClineDebater({
            message: content,
            models: modelsB,
            transcript: st.clTranscript,
            approve: st.approve,
            cwd,
            cancelSignal,
          })

    if (cancelSignal?.aborted) throw new DuoAbortError()
    if (side === 'A' && result.session) st.ocSession = result.session

    const reply = result.text
      ? result.text
      : result.error
        ? `(CLI error: ${result.error})`
        : '(no reply received)'

    if (side === 'B') {
      st.clTranscript.push({ message: content, reply })
      while (st.clTranscript.length > MAX_TRANSCRIPT_TURNS) st.clTranscript.shift()
    }
    recordTurn(
      stats,
      side,
      phase,
      result.usage ?? { input: 0, output: 0, cost: 0 },
      Date.now() - startedAt,
      // The CLI reports which model served the turn after a 429 rotation; fall
      // back to the candidate list so the header is never blank.
      result.model ?? models[0] ?? null,
    )
    return reply
  }
}

/**
 * One cheap routing call, backend-aware so automatic skill selection costs
 * nothing extra:
 * - cli backend: the opencode CLI on a free model
 * - builtin: a forked, tool-less, single-turn query on the session model
 */
function makeSkillSelector(context: LocalJSXCommandContext, st: DuoState) {
  return async (prompt: string): Promise<string> => {
    if (st.backend === 'cli') {
      const result = await runOpenCodeDebater({
        message: prompt,
        models: [st.modelA, ...st.modelAFallbacks].filter(Boolean) as string[],
        // The format contract is the system prompt. Without it the router
        // answers in prose and every question lands on the keyword fallback.
        system: SKILL_ROUTER_SYSTEM,
        approve: false,
        cwd: process.cwd(),
        cancelSignal: context.abortController?.signal,
      })
      return result.text || ''
    }

    const result = await runForkedAgent({
      promptMessages: [createUserMessage({ content: prompt })],
      cacheSafeParams: {
        systemPrompt: asSystemPrompt(SKILL_ROUTER_SYSTEM),
        userContext: {},
        systemContext: {},
        toolUseContext: context,
        forkContextMessages: [],
      },
      canUseTool: async () => ({
        behavior: 'deny' as const,
        message: 'skill routing cannot use tools',
        decisionReason: { type: 'other' as const, reason: 'duo_skill_router' },
      }),
      querySource: 'duo',
      forkLabel: 'duo_skill_router',
      overrides: buildDuoOverrides(
        context,
        resolveDuoModel('A', st, context.options.mainLoopModel),
      ),
      maxTurns: 1,
      skipCacheWrite: true,
      skipTranscript: true,
    })
    if (context.abortController?.signal.aborted) throw new DuoAbortError()
    return extractReply(result.messages)
  }
}

/**
 * Narrow the router's catalogue to the engineering skills of the repository
 * (its own README splits them into Engineering and Productivity).
 *
 * The full catalogue mixes code skills with personal-workflow ones (`teach`,
 * `handoff`, `wait-what`…), which add candidates without adding matches — a
 * router shown 31 candidates where 19 apply tends to recruit the wrong one.
 *
 * Explicit list rather than prefixes: `grill` would catch the productivity
 * skill `grill-me` while missing that only `grill-with-docs` is engineering.
 */
const ENGINEERING_SKILLS: ReadonlySet<string> = new Set([
  // no ask-matt on purpose: it is a router over the skills themselves, so
  // injecting it into a debate would ask the debaters to route, not to work.
  'grill-with-docs',
  'triage',
  'improve-codebase-architecture',
  'setup-matt-pocock-skills',
  'to-spec',
  'to-tickets',
  'implement',
  'implement-spec',
  'wayfinder',
  'retro',
  'prototype',
  'diagnosing-bugs',
  'research',
  'tdd',
  'domain-modeling',
  'codebase-design',
  'code-review',
  'pr',
  'wizard',
])

export function isEngineeringSkill(skill: DuoSkillInfo): boolean {
  return ENGINEERING_SKILLS.has(skill.name)
}

/**
 * Run one debate with the current state and return the formatted transcript.
 *
 * `skillLabel` names an explicitly requested skill (already composed into
 * `question` by the caller). When absent and auto-routing is on, one routing
 * pass picks the best skills and they are composed into the question.
 */
async function executeDebate(
  context: LocalJSXCommandContext,
  question: string,
  skillLabel?: string,
): Promise<string> {
  const existing = getDuoState(context)
  const sessionModel = context.options.mainLoopModel
  // Work on a copy: abort mid-run must not corrupt stored state.
  const st: DuoState = {
    ...existing,
    history: { A: [...existing.history.A], B: [...existing.history.B] },
    clTranscript: [...existing.clTranscript],
  }
  const isCli = st.backend === 'cli'
  const stats = createDuoStats()
  const modelA = isCli
    ? (st.modelA ?? 'opencode default')
    : resolveDuoModel('A', st, sessionModel)
  const modelB = isCli
    ? (st.modelB ?? 'cline default')
    : resolveDuoModel('B', st, sessionModel)

  let effectiveQuestion = question
  let skill = skillLabel ?? null
  let routeError: string | null = null

  if (!skillLabel && st.autoSkill) {
    const installed = await listDuoSkills(process.cwd())
    const routed = await selectSkills({
      question,
      // The full catalogue carries workflow skills (teach, handoff, wait-what)
      // that only add noise for a code question, so the router sees the
      // engineering set when it is non-empty.
      skills: installed.filter(isEngineeringSkill),
      ask: makeSkillSelector(context, st),
    })
    const texts: Array<{ name: string; text: string }> = []
    for (const name of routed.names) {
      const text = await readDuoSkill(name, process.cwd())
      if (text) texts.push({ name, text })
    }
    if (texts.length > 0) {
      effectiveQuestion = composeSelectedSkillsQuestion(texts, question)
      // Say which path routed: a keyword fallback must not read as a model
      // decision, and the user can see when the provider was down.
      skill =
        routed.via === 'keywords'
          ? `${texts.map(entry => entry.name).join('+')} (mots-clés)`
          : texts.map(entry => entry.name).join('+')
    } else if (routed.error) {
      // A failed router must never look like a deliberate abstention.
      skill = 'auto→échec'
      routeError = routed.error
    }
  }

  try {
    const result = await runDebate({
      question: effectiveQuestion,
      rounds: st.rounds,
      protocol: st.protocol,
      ask: isCli ? makeCliAsk(context, st, stats) : makeAsk(context, st, stats),
      signal: context.abortController?.signal,
      budgetTokens: st.budgetTokens ?? undefined,
      budgetUsd: st.budgetUsd ?? undefined,
      budgetWallMs: st.budgetWallMs ?? undefined,
      stats,
    })

    saveDuoState(context, st)
    const out = formatDuoResult(result, {
      rounds: st.rounds,
      protocol: st.protocol,
      modelA,
      modelB,
      usedA: effectiveModel(stats, 'A', st.modelA),
      usedB: effectiveModel(stats, 'B', st.modelB),
      skill,
      stats,
    })
    return routeError
      ? `${out}\n⚠ skill routing failed — no skill applied: ${routeError}`
      : out
  } catch (error) {
    if (error instanceof DuoAbortError) {
      // Auto-save partial session if it has a name and at least one turn
      if (st.sessionName && (st.history.A.length > 0 || st.history.B.length > 0 || st.clTranscript.length > 0)) {
        const { saveSession } = await import('../../services/duo/persistence.js')
        const result = await runDebate({
          question: '', // placeholder; we only need the session name saved
          rounds: 0,
          protocol: false,
          ask: async () => '',
          signal: context.abortController?.signal,
          stats: createDuoStats(),
        })
        await saveSession(st.sessionName, st, result, stats)
        return `duo debate interrupted — partial session saved as "${st.sessionName}" (load with /duo load ${st.sessionName})`
      }
      return 'duo debate interrupted — nothing was saved.'
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const call: LocalCommandCall = async (args, context): Promise<LocalCommandResult> => {
  const input = parseDuoInput(args)
  const sessionModel = context.options.mainLoopModel

  switch (input.verb) {
    case 'status':
      return { type: 'text', value: formatDuoStatus(getDuoState(context), sessionModel) }

    case 'clear':
      saveDuoState(context, createDuoState())
      return { type: 'text', value: 'duo state cleared (config + histories).' }

    case 'models':
      return { type: 'text', value: formatFreeModels() }

    case 'skills':
      return {
        type: 'text',
        value: formatSkillList(await listDuoSkills(process.cwd())),
      }

    case 'skill': {
      if (input.error) return { type: 'text', value: input.error }
      const text = await readDuoSkill(input.skill, process.cwd())
      if (!text) {
        return {
          type: 'text',
          value: `duo: skill "${input.skill}" not found — /duo skills lists installed skills`,
        }
      }
      return {
        type: 'text',
        value: await executeDebate(
          context,
          composeSkillQuestion(input.skill, text, input.question),
          input.skill,
        ),
      }
    }

    case 'backend': {
      if (input.error) return { type: 'text', value: input.error }
      const st = getDuoState(context)
      saveDuoState(context, { ...st, backend: input.backend })
      return {
        type: 'text',
        value: `duo backend = ${input.backend}${
          input.backend === 'cli' ? ' (A=opencode · B=cline — /duo models lists the free ones)' : ''
        }`,
      }
    }

    case 'approve': {
      if (input.error) return { type: 'text', value: input.error }
      const st = getDuoState(context)
      saveDuoState(context, { ...st, approve: input.on })
      return {
        type: 'text',
        value: `duo approve = ${input.on ? 'on' : 'off'}${
          input.on ? ' (the CLI debaters may run tools)' : ''
        }`,
      }
    }

    case 'auto': {
      if (input.error) return { type: 'text', value: input.error }
      const st = getDuoState(context)
      saveDuoState(context, { ...st, autoSkill: input.on })
      return {
        type: 'text',
        value: `duo auto-skill = ${input.on ? 'on' : 'off'}${
          input.on ? ' (each question is routed to the best installed skill)' : ''
        }`,
      }
    }

    case 'grounded': {
      if (input.error) return { type: 'text', value: input.error }
      const st = getDuoState(context)
      saveDuoState(context, { ...st, grounded: input.on })
      return {
        type: 'text',
        value: `duo tools = ${input.on ? 'on' : 'off'}${
          input.on
            ? ` (debaters may read with ${READ_ONLY_TOOLS.join('/')} — no writes, no shell)`
            : ''
        }`,
      }
    }

    case 'adversarial': {
      if (input.error) return { type: 'text', value: input.error }
      const st = getDuoState(context)
      saveDuoState(context, { ...st, adversarial: input.on })
      return {
        type: 'text',
        value: `duo mode = ${input.on ? 'adversarial' : 'neutral'}${
          input.on ? ' (each side must argue the other’s strongest case)' : ''
        }`,
      }
    }

    case 'rounds': {
      if (input.error) return { type: 'text', value: input.error }
      const st = getDuoState(context)
      const next = { ...st, rounds: input.rounds }
      saveDuoState(context, next)
      return { type: 'text', value: `duo rounds = ${input.rounds}` }
    }

    case 'protocol': {
      if (input.error) return { type: 'text', value: input.error }
      const st = getDuoState(context)
      saveDuoState(context, { ...st, protocol: input.on })
      return {
        type: 'text',
        value: `duo protocol = ${input.on ? 'on' : 'off'}${
          input.on ? ' (replies must end with VERDICT: CONSENSUS|SUITE)' : ''
        }`,
      }
    }

    case 'model': {
      if (input.error) return { type: 'text', value: input.error }
      const st = getDuoState(context)
      const next: DuoState = {
        ...st,
        ...(input.side === 'A' ? { modelA: input.model } : { modelB: input.model }),
      }
      saveDuoState(context, next)
      return { type: 'text', value: `duo model ${input.side} = ${input.model}` }
    }

    case 'budget': {
      if (input.error) return { type: 'text', value: input.error }
      const st = getDuoState(context)
      switch (input.type) {
        case 'off': {
          const next = { ...st, budgetTokens: null, budgetUsd: null, budgetWallMs: null }
          saveDuoState(context, next)
          return { type: 'text', value: 'duo budget = off (all budgets cleared)' }
        }
        case 'tokens': {
          const v = input.value ?? 0
          const next = { ...st, budgetTokens: v }
          saveDuoState(context, next)
          return { type: 'text', value: `duo budget tokens = ${v.toLocaleString()}` }
        }
        case 'usd': {
          const v = input.value ?? 0
          const next = { ...st, budgetUsd: v }
          saveDuoState(context, next)
          return { type: 'text', value: `duo budget usd = $${v.toFixed(2)}` }
        }
        case 'wall': {
          const v = input.value ?? 0
          const next = { ...st, budgetWallMs: v }
          saveDuoState(context, next)
          return { type: 'text', value: `duo budget wall = ${v / 60000} min` }
        }
      }
      return { type: 'text', value: input.error ?? 'unknown budget command' }
    }

    case 'save': {
      if (input.error) return { type: 'text', value: input.error }
      const st = getDuoState(context)
      st.sessionName = input.name
      await saveSession(input.name, st)
      return { type: 'text', value: `duo session saved as "${input.name}"` }
    }

    case 'load': {
      if (input.error) return { type: 'text', value: input.error }
      const session = await loadSession(input.name)
      if (!session) {
        return { type: 'text', value: `duo: session "${input.name}" not found` }
      }
      saveDuoState(context, session.state)
      return { type: 'text', value: `duo session "${input.name}" loaded (saved ${new Date(session.savedAt).toLocaleString()})` }
    }

    case 'sessions': {
      const sessions = await listSessions()
      if (sessions.length === 0) {
        return { type: 'text', value: 'duo: no saved sessions' }
      }
      const lines = ['duo sessions:']
      for (const s of sessions) {
        lines.push(`  ${s.name.padEnd(24)} ${new Date(s.savedAt).toLocaleString()}  ${s.rounds} rounds  "${s.question.slice(0, 50)}"`)
      }
      return { type: 'text', value: lines.join('\n') }
    }

    case 'delete': {
      if (input.error) return { type: 'text', value: input.error }
      const ok = await deleteSession(input.name)
      if (!ok) return { type: 'text', value: `duo: session "${input.name}" not found` }
      return { type: 'text', value: `duo session "${input.name}" deleted` }
    }

    case 'run': {
      const envSkill = process.env.DUO_SKILL?.trim()
      if (envSkill) {
        const text = await readDuoSkill(envSkill, process.cwd())
        if (!text) {
          return {
            type: 'text',
            value: `duo: skill "${envSkill}" not found — /duo skills lists installed skills`,
          }
        }
        return {
          type: 'text',
          value: await executeDebate(
            context,
            composeSkillQuestion(envSkill, text, input.question),
            envSkill,
          ),
        }
      }
      return { type: 'text', value: await executeDebate(context, input.question) }
    }
  }
}
