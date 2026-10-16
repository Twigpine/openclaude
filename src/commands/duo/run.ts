/**
 * /duo — orchestration: debater callbacks, skill routing, command dispatch.
 */

import type { LocalJSXCommandContext, LocalCommandCall, LocalCommandResult } from '../../types/command.js'
import type { Message, SystemAPIErrorMessage } from '../../types/message.js'
import type { Tool } from '../../Tool.js'
import { formatAPIError } from '../../services/api/errorUtils.js'
import { runClineDebater, runOpenCodeDebater } from '../../services/duo/cliAgent.js'
import {
  DuoAbortError,
  duoSystemPrompt,
  READ_ONLY_TOOLS,
  READ_TOOLS_MAX_TURNS,
  runDebate,
} from '../../services/duo/debate.js'
import {
  composeSelectedSkillsQuestion,
  selectSkills,
  SKILL_ROUTER_SYSTEM,
} from '../../services/duo/skillSelect.js'
import {
  composeSkillQuestion,
  listDuoSkills,
  readDuoSkill,
  type DuoSkillInfo,
} from '../../services/duo/skills.js'
import {
  capHistory,
  createDuoState,
  createDuoStats,
  effectiveModel,
  MAX_TRANSCRIPT_TURNS,
  recordTurn,
  type DuoState,
  type DuoStats,
  type DuoSide,
} from '../../services/duo/types.js'
import { deleteSession, listSessions, loadSession, saveSession } from '../../services/duo/persistence.js'
import { runForkedAgent, type SubagentContextOverrides } from '../../utils/forkedAgent.js'
import { createAssistantMessage, createUserMessage, extractTextContent } from '../../utils/messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { parseDuoInput, resolveDuoModel } from './parse.js'
import {
  formatDuoResult,
  formatDuoStatus,
  formatFreeModels,
  formatSkillList,
  protocolInstruction,
} from './render.js'

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

function getDuoState(context: LocalJSXCommandContext): DuoState {
  return context.getAppState().duo ?? createDuoState()
}

function saveDuoState(context: LocalJSXCommandContext, st: DuoState): void {
  context.setAppState(prev => ({ ...prev, duo: st }))
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

/**
 * Build the `ask` callback for runDebate: one forked, tool-less, single-turn
 * model call per side per turn, with the side's conversation history.
 * Mutates `st.history[side]` as replies arrive.
 */
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
