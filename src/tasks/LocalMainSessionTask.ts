/**
 * LocalMainSessionTask - Handles backgrounding the main session query.
 *
 * When user presses Ctrl+B twice during a query, the session is "backgrounded":
 * - The query continues running in the background
 * - The UI clears to a fresh prompt
 * - A notification is sent when the query completes
 *
 * This reuses the LocalAgentTask state structure since the behavior is similar.
 */

import type { UUID } from 'crypto'
import { randomInt } from 'crypto'
import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TOOL_USE_ID_TAG,
} from '../constants/xml.js'
import { type QueryParams, query } from '../query.js'
import { roughTokenCountEstimation } from '../services/tokenEstimation.js'
import type { SetAppState } from '../Task.js'
import { createTaskStateBase } from '../Task.js'
import type {
  AgentDefinition,
  CustomAgentDefinition,
} from '../tools/AgentTool/loadAgentsDir.js'
import { asAgentId } from '../types/ids.js'
import type { Message } from '../types/message.js'
import { createAbortController } from '../utils/abortController.js'
import {
  runWithAgentContext,
  type SubagentContext,
} from '../utils/agentContext.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { logForDebugging } from '../utils/debug.js'
import { logError } from '../utils/log.js'
import { enqueuePendingNotification } from '../utils/messageQueueManager.js'
import { emitTaskTerminatedSdk } from '../utils/sdkEventQueue.js'
import {
  getAgentTranscriptPath,
  recordSidechainTranscript,
} from '../utils/sessionStorage.js'
import {
  evictTaskOutput,
  getTaskOutputPath,
  initTaskOutputAsSymlink,
} from '../utils/task/diskOutput.js'
import {
  PANEL_GRACE_MS,
  registerTask,
  updateTaskState,
} from '../utils/task/framework.js'
import type { LocalAgentTaskState } from './LocalAgentTask/LocalAgentTask.js'

// Main session tasks use LocalAgentTaskState with agentType='main-session'
export type LocalMainSessionTaskState = LocalAgentTaskState & {
  agentType: 'main-session'
}

/**
 * Default agent definition for main session tasks when no agent is specified.
 */
const DEFAULT_MAIN_SESSION_AGENT: CustomAgentDefinition = {
  agentType: 'main-session',
  whenToUse: 'Main session query',
  source: 'userSettings',
  getSystemPrompt: () => '',
}

/**
 * Generate a unique task ID for main session tasks.
 * Uses 's' prefix to distinguish from agent tasks ('a' prefix).
 */
const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

function generateMainSessionTaskId(): string {
  let id = 's'
  for (let i = 0; i < 8; i++) {
    id += TASK_ID_ALPHABET[randomInt(TASK_ID_ALPHABET.length)]!
  }
  return id
}

/**
 * Register a backgrounded main session task.
 * Called when the user backgrounds the current session query.
 *
 * @param description - Description of the task
 * @param setAppState - State setter function
 * @param mainThreadAgentDefinition - Optional agent definition if running with --agent
 * @param existingAbortController - Optional abort controller to reuse (for backgrounding an active query)
 * @returns Object with task ID and the controller that owns background cancellation
 */
export function registerMainSessionTask(
  description: string,
  setAppState: SetAppState,
  mainThreadAgentDefinition?: AgentDefinition,
  existingAbortController?: AbortController,
  existingTaskId?: string,
): { taskId: string; abortController: AbortController } {
  const taskId = existingTaskId ?? generateMainSessionTaskId()

  // Link output to an isolated per-task transcript file (same layout as
  // sub-agents). Do NOT use getTranscriptPath() — that's the main session's
  // file, and writing there from a background query after /clear would corrupt
  // the post-clear conversation. The isolated path lets this task survive
  // /clear: the symlink re-link in clearConversation handles session ID changes.
  void initTaskOutputAsSymlink(
    taskId,
    getAgentTranscriptPath(asAgentId(taskId)),
  )

  // Use the existing abort controller if provided (important for backgrounding an active query)
  // This ensures that aborting the task will abort the actual query
  const abortController = existingAbortController ?? createAbortController()

  const unregisterCleanup = registerCleanup(async () => {
    // Clean up on process exit
    setAppState(prev => {
      const { [taskId]: removed, ...rest } = prev.tasks
      return { ...prev, tasks: rest }
    })
  })

  // Use provided agent definition or default
  const selectedAgent = mainThreadAgentDefinition ?? DEFAULT_MAIN_SESSION_AGENT

  // Create task state - already backgrounded since this is called when user backgrounds
  const taskState: LocalMainSessionTaskState = {
    ...createTaskStateBase(taskId, 'local_agent', description),
    type: 'local_agent',
    status: 'running',
    agentId: taskId,
    prompt: description,
    selectedAgent,
    agentType: 'main-session',
    abortController,
    unregisterCleanup,
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true, // Already backgrounded
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
  }

  logForDebugging(
    `[LocalMainSessionTask] Registering task ${taskId} with description: ${description}`,
  )
  registerTask(taskState, setAppState)

  // Verify task was registered by checking state
  setAppState(prev => {
    const hasTask = taskId in prev.tasks
    logForDebugging(
      `[LocalMainSessionTask] After registration, task ${taskId} exists in state: ${hasTask}`,
    )
    return prev
  })

  return { taskId, abortController }
}

/**
 * Complete the main session task and send notification.
 * Called when the backgrounded query finishes.
 */
export function completeMainSessionTask(
  taskId: string,
  success: boolean,
  setAppState: SetAppState,
): void {
  let wasBackgrounded = true
  let toolUseId: string | undefined

  updateTaskState<LocalMainSessionTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') {
      return task
    }

    // Track if task was backgrounded (for notification decision)
    wasBackgrounded = task.isBackgrounded ?? true
    toolUseId = task.toolUseId

    task.unregisterCleanup?.()

    return {
      ...task,
      status: success ? 'completed' : 'failed',
      endTime: Date.now(),
      messages: task.messages?.length ? [task.messages.at(-1)!] : undefined,
    }
  })

  void evictTaskOutput(taskId)

  // Only send notification if task is still backgrounded (not foregrounded)
  // If foregrounded, user is watching it directly - no notification needed
  if (wasBackgrounded) {
    enqueueMainSessionNotification(
      taskId,
      'Background session',
      success ? 'completed' : 'failed',
      setAppState,
      toolUseId,
    )
  } else {
    // Foregrounded: no XML notification (TUI user is watching), but SDK
    // consumers still need to see the task_started bookend close.
    // Set notified so evictTerminalTask/generateTaskAttachments eviction
    // guards pass; the backgrounded path sets this inside
    // enqueueMainSessionNotification's check-and-set.
    updateTaskState(taskId, setAppState, task => ({ ...task, notified: true }))
    emitTaskTerminatedSdk(taskId, success ? 'completed' : 'failed', {
      toolUseId,
      summary: 'Background session',
    })
  }
}

/**
 * Enqueue a notification about the backgrounded session completing.
 */
function enqueueMainSessionNotification(
  taskId: string,
  description: string,
  status: 'completed' | 'failed',
  setAppState: SetAppState,
  toolUseId?: string,
): void {
  // Atomically check and set notified flag to prevent duplicate notifications.
  let shouldEnqueue = false
  updateTaskState(taskId, setAppState, task => {
    if (task.notified) {
      return task
    }
    shouldEnqueue = true
    return { ...task, notified: true }
  })

  if (!shouldEnqueue) {
    return
  }

  const summary =
    status === 'completed'
      ? `Background session "${description}" completed`
      : `Background session "${description}" failed`

  const toolUseIdLine = toolUseId
    ? `\n<${TOOL_USE_ID_TAG}>${toolUseId}</${TOOL_USE_ID_TAG}>`
    : ''

  const outputPath = getTaskOutputPath(taskId)
  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${summary}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`

  enqueuePendingNotification({ value: message, mode: 'task-notification' })
}

/**
 * Foreground a main session task - mark it as foregrounded so its output
 * appears in the main view. The background query keeps running.
 * Returns the task's accumulated messages, or undefined if task not found.
 */
export function foregroundMainSessionTask(
  taskId: string,
  setAppState: SetAppState,
): Message[] | undefined {
  let taskMessages: Message[] | undefined

  setAppState(prev => {
    const task = prev.tasks[taskId]
    if (!task || task.type !== 'local_agent') {
      return prev
    }

    taskMessages = (task as LocalMainSessionTaskState).messages

    // Restore previous foregrounded task to background if it exists
    const prevId = prev.foregroundedTaskId
    const prevTask = prevId ? prev.tasks[prevId] : undefined
    const restorePrev =
      prevId && prevId !== taskId && prevTask?.type === 'local_agent'

    return {
      ...prev,
      foregroundedTaskId: taskId,
      tasks: {
        ...prev.tasks,
        ...(restorePrev && { [prevId]: { ...prevTask, isBackgrounded: true } }),
        [taskId]: { ...task, isBackgrounded: false },
      },
    }
  })

  return taskMessages
}

/**
 * Check if a task is a main session task (vs a regular agent task).
 */
export function isMainSessionTask(
  task: unknown,
): task is LocalMainSessionTaskState {
  if (
    typeof task !== 'object' ||
    task === null ||
    !('type' in task) ||
    !('agentType' in task)
  ) {
    return false
  }
  return (
    task.type === 'local_agent' &&
    (task as LocalMainSessionTaskState).agentType === 'main-session'
  )
}

// Max recent activities to keep for display
const MAX_RECENT_ACTIVITIES = 5

type ToolActivity = {
  toolName: string
  input: Record<string, unknown>
}

export type BackgroundSessionHandle = {
  taskId: string
  abortController: AbortController
}

/**
 * Start a fresh background session with the given messages.
 *
 * Prepares the continuation first, then registers the background task and
 * starts an independent query() call. A foreground that settles without a
 * successor therefore never publishes a task.
 */
export function startBackgroundSession({
  prepare,
  description,
  setAppState,
  agentDefinition,
  queryImpl = query,
  onPreparationError,
  onContinuationCancelled,
  onRegistered,
  onSettled,
}: {
  prepare: (abortController: AbortController) => Promise<
    | {
      messages: Message[]
      restoreNotificationsIfUnsent?: () => void
      commitNotificationOwnership?: () => void
      queryParams: Omit<QueryParams, 'messages'>
    }
    | null
  >
  description: string
  setAppState: SetAppState
  agentDefinition?: AgentDefinition
  queryImpl?: typeof query
  onPreparationError?: (error: unknown) => void
  onContinuationCancelled?: () => void
  onRegistered?: (abortController: AbortController) => void
  onSettled?: (abortController: AbortController) => void
}): BackgroundSessionHandle {
  // Keep a controller while preparation waits for the foreground settlement,
  // but do not publish a task until a successor is actually required. A
  // settled foreground can complete normally after Ctrl+B is pressed.
  const taskId = generateMainSessionTaskId()
  const abortController = createAbortController()
  const abortSignal = abortController.signal
  let taskRegistered = false
  let providerRequestStarted = false
  let restoreNotificationsIfUnsent: (() => void) | undefined
  let commitNotificationOwnership: (() => void) | undefined

  const restorePreDispatchNotifications = (): void => {
    if (providerRequestStarted) return
    const restore = restoreNotificationsIfUnsent
    restoreNotificationsIfUnsent = undefined
    restore?.()
  }

  const finishAbortedTask = (): void => {
    restorePreDispatchNotifications()
    onContinuationCancelled?.()
    // chat:killAgents already marks the task notified and emits this event.
    // stopTask kills it without doing either for local-agent tasks, so close
    // the SDK lifecycle exactly once no matter which phase observed abort.
    let alreadyNotified = false
    let shouldEvictOutput = false
    updateTaskState<LocalMainSessionTaskState>(taskId, setAppState, task => {
      alreadyNotified = task.notified === true
      if (task.status === 'running') {
        shouldEvictOutput = true
        task.unregisterCleanup?.()
        const endTime = Date.now()
        return {
          ...task,
          status: 'killed',
          endTime,
          evictAfter: task.retain ? undefined : endTime + PANEL_GRACE_MS,
          abortController: undefined,
          unregisterCleanup: undefined,
          selectedAgent: undefined,
          notified: true,
        }
      }
      return alreadyNotified ? task : { ...task, notified: true }
    })
    if (shouldEvictOutput) void evictTaskOutput(taskId)
    if (!alreadyNotified) {
      emitTaskTerminatedSdk(taskId, 'stopped', {
        summary: description,
      })
    }
  }

  // Wrap in agent context so skill invocations scope to this task's agentId
  // (not null). This lets clearInvokedSkills(preservedAgentIds) selectively
  // preserve this task's skills across /clear. AsyncLocalStorage isolates
  // concurrent async chains — this wrapper doesn't affect the foreground.
  const agentContext: SubagentContext = {
    agentId: taskId,
    agentType: 'subagent',
    subagentName: 'main-session',
    isBuiltIn: true,
  }

  void runWithAgentContext(agentContext, async () => {
    try {
      // Wait for the foreground settlement before publishing a task. This
      // keeps a completion race from producing a phantom background task.
      const prepared = await prepare(abortController)
      if (prepared === null) {
        return
      }
      restoreNotificationsIfUnsent = prepared.restoreNotificationsIfUnsent
      commitNotificationOwnership = prepared.commitNotificationOwnership
      if (abortSignal.aborted) {
        restorePreDispatchNotifications()
        onContinuationCancelled?.()
        return
      }
      try {
        registerMainSessionTask(
          description,
          setAppState,
          agentDefinition,
          abortController,
          taskId,
        )
      } catch (error) {
        restorePreDispatchNotifications()
        if (abortSignal.aborted) {
          onContinuationCancelled?.()
          return
        }
        throw error
      }
      taskRegistered = true
      onRegistered?.(abortController)
      const { messages, queryParams } = prepared

      // Persist the pre-backgrounding conversation to the task's isolated
      // transcript so TaskOutput shows context immediately. Subsequent
      // messages are written incrementally below.
      void recordSidechainTranscript(messages, taskId).catch(err =>
        logForDebugging(`bg-session initial transcript write failed: ${err}`),
      )

      const bgMessages: Message[] = [...messages]
      const recentActivities: ToolActivity[] = []
      let toolCount = 0
      let tokenCount = 0
      let lastRecordedUuid: UUID | null = messages.at(-1)?.uuid ?? null

      for await (const event of queryImpl({
        messages: bgMessages,
        ...queryParams,
        onProviderDispatchAccepted: () => {
          providerRequestStarted = true
          commitNotificationOwnership?.()
        },
      })) {
        if (abortSignal.aborted) {
          finishAbortedTask()
          return
        }

        if (
          event.type !== 'user' &&
          event.type !== 'assistant' &&
          event.type !== 'system' &&
          !(
            event.type === 'attachment' &&
            event.attachment.type === 'max_turns_reached'
          )
        ) {
          continue
        }

        bgMessages.push(event)

        // Per-message write (matches runAgent.ts pattern) — gives live
        // TaskOutput progress and keeps the transcript file current even if
        // /clear re-links the symlink mid-run.
        void recordSidechainTranscript([event], taskId, lastRecordedUuid).catch(
          err => logForDebugging(`bg-session transcript write failed: ${err}`),
        )
        lastRecordedUuid = event.uuid

        if (event.type === 'assistant') {
          for (const block of event.message.content) {
            if (block.type === 'text') {
              tokenCount += roughTokenCountEstimation(block.text)
            } else if (block.type === 'tool_use') {
              toolCount++
              const activity: ToolActivity = {
                toolName: block.name,
                input: block.input as Record<string, unknown>,
              }
              recentActivities.push(activity)
              if (recentActivities.length > MAX_RECENT_ACTIVITIES) {
                recentActivities.shift()
              }
            }
          }
        }

        setAppState(prev => {
          const task = prev.tasks[taskId]
          if (!task || task.type !== 'local_agent') return prev
          const prevProgress = task.progress
          if (
            prevProgress?.tokenCount === tokenCount &&
            prevProgress.toolUseCount === toolCount &&
            task.messages === bgMessages
          ) {
            return prev
          }
          return {
            ...prev,
            tasks: {
              ...prev.tasks,
              [taskId]: {
                ...task,
                progress: {
                  tokenCount,
                  toolUseCount: toolCount,
                  recentActivities:
                    prevProgress?.toolUseCount === toolCount
                      ? prevProgress.recentActivities
                      : [...recentActivities],
                },
                messages: bgMessages,
              },
            },
          }
        })
      }

      if (abortSignal.aborted) {
        finishAbortedTask()
        return
      }
      if (providerRequestStarted) {
        commitNotificationOwnership?.()
      }
      completeMainSessionTask(taskId, true, setAppState)
    } catch (error) {
      if (abortSignal.aborted) {
        if (taskRegistered) {
          finishAbortedTask()
        } else {
          restorePreDispatchNotifications()
          onContinuationCancelled?.()
        }
        return
      }
      logError(error)
      if (taskRegistered) {
        if (providerRequestStarted) {
          commitNotificationOwnership?.()
        }
        completeMainSessionTask(taskId, false, setAppState)
      } else {
        restorePreDispatchNotifications()
        onPreparationError?.(error)
        onContinuationCancelled?.()
      }
    } finally {
      onSettled?.(abortController)
    }
  })

  return { taskId, abortController }
}
