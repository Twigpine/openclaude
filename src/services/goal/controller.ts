import { getSessionId } from '../../bootstrap/state.js'
import type { QuerySource } from '../../constants/querySource.js'
import { getTotalCost as getTotalCostDefault } from '../../cost-tracker.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import {
  getInterruptionSignalAbortEventId,
  traceInterruptionEvent,
} from '../../utils/interruptionTrace.js'
import { createSystemMessage, createUserMessage } from '../../utils/messages.js'
import { evaluateGoal as evaluateGoalDefault } from './evaluator.js'
import { buildGoalContinuationInstruction } from './instructions.js'
import { saveGoalState as saveGoalStateDefault } from './persistence.js'
import {
  achieveGoal,
  markGoalEvaluated,
  nowIso,
  pauseGoal,
  pauseGoalAtMaxTurns,
  shouldEvaluateGoal,
} from './state.js'
import type { GoalState } from './types.js'

const GOAL_EVALUATION_MESSAGE_LIMIT = 24
const GOAL_PERSISTENCE_ERROR_MESSAGE_LIMIT = 500

type GoalPersistenceFailureLogger = (
  goal: GoalState | null,
  error: unknown,
) => void

export type GoalEvaluationDeps = {
  evaluateGoal?: typeof evaluateGoalDefault
  getTotalCost?: typeof getTotalCostDefault
  logGoalPersistenceFailure?: GoalPersistenceFailureLogger
  saveGoalState?: typeof saveGoalStateDefault
}

export function isMainThreadGoalSource(
  querySource: QuerySource,
  toolUseContext: ToolUseContext,
): boolean {
  if (toolUseContext.agentId) return false
  if (typeof querySource !== 'string') return false
  return querySource === 'sdk' || querySource.startsWith('repl_main_thread')
}

function hasPendingInteractiveDialog(toolUseContext: ToolUseContext): boolean {
  const state = toolUseContext.getAppState()
  return Boolean(
    state.elicitation?.queue?.length ||
      state.pendingWorkerRequest ||
      state.pendingSandboxRequest ||
      state.activeOverlays?.size,
  )
}

function terminalAssistantUuid(assistantMessages: Message[]): string | undefined {
  return assistantMessages.at(-1)?.uuid
}

function getRecentGoalEvaluationMessages(
  messagesForQuery: Message[],
  assistantMessages: Message[],
): Message[] {
  return [
    ...messagesForQuery.slice(-GOAL_EVALUATION_MESSAGE_LIMIT),
    ...assistantMessages.slice(-GOAL_EVALUATION_MESSAGE_LIMIT),
  ].slice(-GOAL_EVALUATION_MESSAGE_LIMIT)
}

async function persistGoal(
  saveGoalState: typeof saveGoalStateDefault,
  goal: GoalState | null,
  logGoalPersistenceFailure: GoalPersistenceFailureLogger,
): Promise<void> {
  try {
    await saveGoalState(goal)
  } catch (error) {
    // Goal persistence is important for resume, but should not crash a turn.
    logGoalPersistenceFailure(goal, error)
  }
}

function describeGoalPersistenceError(error: unknown): {
  name: string
  message: string
} {
  if (error instanceof Error) {
    return { name: error.name, message: error.message }
  }
  return { name: typeof error, message: String(error) }
}

function formatGoalPersistenceErrorMessage(message: string): string {
  return message
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, GOAL_PERSISTENCE_ERROR_MESSAGE_LIMIT)
}

function logGoalPersistenceFailureDefault(
  goal: GoalState | null,
  error: unknown,
): void {
  const sessionId = getSessionId()
  const { name, message } = describeGoalPersistenceError(error)
  const goalId = goal?.id ?? null
  const goalStatus = goal?.status ?? null

  logForDiagnosticsNoPII('warn', 'goal_persistence_failed', {
    session_id: sessionId,
    goal_id: goalId,
    goal_status: goalStatus,
    error_name: name,
  })
  logForDebugging(
    [
      'Goal persistence failed',
      `session_id=${sessionId}`,
      `goal_id=${goalId ?? 'none'}`,
      `goal_status=${goalStatus ?? 'none'}`,
      `error_name=${name}`,
      `error_message=${formatGoalPersistenceErrorMessage(message)}`,
    ].join(' '),
    { level: 'warn' },
  )
}

export async function* evaluateGoalAfterTurn({
  messagesForQuery,
  assistantMessages,
  toolUseContext,
  querySource,
  deps = {},
}: {
  messagesForQuery: Message[]
  assistantMessages: Message[]
  toolUseContext: ToolUseContext
  querySource: QuerySource
  deps?: GoalEvaluationDeps
}): AsyncGenerator<Message, Message[]> {
  const evaluateGoal = deps.evaluateGoal ?? evaluateGoalDefault
  const getTotalCost = deps.getTotalCost ?? getTotalCostDefault
  const logGoalPersistenceFailure =
    deps.logGoalPersistenceFailure ?? logGoalPersistenceFailureDefault
  const saveGoalState = deps.saveGoalState ?? saveGoalStateDefault
  const terminalUuid = terminalAssistantUuid(assistantMessages)
  const appState = toolUseContext.getAppState()
  const goal = appState.goal ?? null

  if (!isMainThreadGoalSource(querySource, toolUseContext)) return []
  if (!goal || goal.status !== 'active') return []
  if (!terminalUuid) return []
  if (goal.lastEvaluatedMessageUuid === terminalUuid) return []
  if (toolUseContext.abortController.signal.aborted) return []
  if (hasPendingInteractiveDialog(toolUseContext)) return []

  if (goal.turnCount >= goal.maxTurns) {
    const paused = pauseGoalAtMaxTurns(goal, terminalUuid, nowIso())
    toolUseContext.setAppState(prev => ({ ...prev, goal: paused }))
    await persistGoal(saveGoalState, paused, logGoalPersistenceFailure)
    yield createSystemMessage(
      paused.lastReason ??
        'Goal paused: automatic continuation has been paused.',
      'warning',
    )
    return []
  }
  if (!shouldEvaluateGoal(goal, terminalUuid)) return []
  if (
    toolUseContext.options.maxBudgetUsd !== undefined &&
    getTotalCost() >= toolUseContext.options.maxBudgetUsd
  ) {
    return []
  }

  traceInterruptionEvent('goal.evaluation_started', {
    subsystem: 'goal',
    phase: 'evaluator',
    querySource,
    attemptId: goal.id,
  })
  const decision = await evaluateGoal({
    goal,
    messages: getRecentGoalEvaluationMessages(
      messagesForQuery,
      assistantMessages,
    ),
    signal: toolUseContext.abortController.signal,
    isNonInteractiveSession:
      toolUseContext.options.isNonInteractiveSession ?? false,
  })
  traceInterruptionEvent('goal.evaluation_completed', {
    subsystem: 'goal',
    phase: 'evaluator',
    querySource,
    attemptId: goal.id,
    outcome: decision.decision,
    reason: toolUseContext.abortController.signal.reason,
    causalEventId: getInterruptionSignalAbortEventId(
      toolUseContext.abortController.signal,
    ),
  })

  if (toolUseContext.abortController.signal.aborted) return []

  if (decision.complete) {
    const achieved = achieveGoal(goal, {
      evaluatedMessageUuid: terminalUuid,
      reason: decision.reason,
      nextInstruction: decision.nextInstruction,
    })
    toolUseContext.setAppState(prev => ({ ...prev, goal: achieved }))
    await persistGoal(saveGoalState, achieved, logGoalPersistenceFailure)
    yield createSystemMessage(`Goal achieved: ${decision.reason}`, 'info')
    return []
  }

  if (decision.decision === 'malformed' || decision.decision === 'error') {
    const now = nowIso()
    const paused = pauseGoal(
      markGoalEvaluated(goal, {
        evaluatedMessageUuid: terminalUuid,
        decision: decision.decision,
        reason: decision.reason,
        nextInstruction: null,
        now,
      }),
      now,
    )
    toolUseContext.setAppState(prev => ({ ...prev, goal: paused }))
    await persistGoal(saveGoalState, paused, logGoalPersistenceFailure)
    yield createSystemMessage(`Goal paused: ${decision.reason}`, 'warning')
    return []
  }

  const updatedGoal = markGoalEvaluated(goal, {
    evaluatedMessageUuid: terminalUuid,
    decision: decision.decision === 'complete' ? 'incomplete' : decision.decision,
    reason: decision.reason,
    nextInstruction: decision.nextInstruction,
  })

  if (updatedGoal.turnCount >= updatedGoal.maxTurns) {
    const paused = pauseGoalAtMaxTurns(
      updatedGoal,
      terminalUuid,
      nowIso(),
      decision.reason,
    )
    toolUseContext.setAppState(prev => ({ ...prev, goal: paused }))
    await persistGoal(saveGoalState, paused, logGoalPersistenceFailure)
    yield createSystemMessage(
      `Goal not complete: ${decision.reason} Goal paused after reaching the maximum of ${updatedGoal.maxTurns} turns.`,
      'warning',
    )
    return []
  }

  toolUseContext.setAppState(prev => ({ ...prev, goal: updatedGoal }))
  await persistGoal(saveGoalState, updatedGoal, logGoalPersistenceFailure)
  yield createSystemMessage(`Goal not complete: ${decision.reason}`, 'info')

  return [
    createUserMessage({
      content: buildGoalContinuationInstruction(updatedGoal, decision),
      isMeta: true,
    }),
  ]
}
