import { feature } from 'bun:bundle'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { sanitizeToolNameForAnalytics } from 'src/services/analytics/metadata.js'
import type { ToolUseConfirm } from '../../components/permissions/PermissionRequest.js'
import type {
  ToolPermissionContext,
  Tool as ToolType,
  ToolUseContext,
} from '../../Tool.js'
import { awaitClassifierAutoApproval } from '../../tools/BashTool/bashPermissions.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import type { AssistantMessage } from '../../types/message.js'
import type {
  PendingClassifierCheck,
  PermissionAllowDecision,
  PermissionDecisionReason,
  PermissionDenyDecision,
} from '../../types/permissions.js'
import { setClassifierApproval } from '../../utils/classifierApprovals.js'
import { logForDebugging } from '../../utils/debug.js'
import { requestAbort } from '../../utils/interruptionTrace.js'
import { executePermissionRequestHooks } from '../../utils/hooks.js'
import {
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
  SUBAGENT_REJECT_MESSAGE,
  SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX,
  withMemoryCorrectionHint,
} from '../../utils/messages.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import {
  checkPlanModePermissions,
  checkRuleBasedPermissions,
  revalidatePlanModePermissionAllowWithRaceGuard,
  samePermissionAskConstraint,
} from '../../utils/permissions/permissions.js'
import {
  applyPermissionUpdate,
  filterPermissionRequestHookUpdates,
  persistPermissionUpdates,
  supportsPersistence,
} from '../../utils/permissions/PermissionUpdate.js'
import {
  applyPermissionUpdateToLiveContext,
  applyPermissionUpdatesToLiveContext,
  getPermissionModeChangeRequestDecision,
} from '../../utils/permissions/permissionSetup.js'
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js'
import {
  logPermissionDecision,
  type PermissionDecisionArgs,
} from './permissionLogging.js'
import {
  buildInactivePermissionSessionDecision,
  isPermissionSessionActive,
} from './permissionSessionOwnership.js'

type PermissionApprovalSource =
  | { type: 'hook'; permanent?: boolean }
  | { type: 'user'; permanent: boolean }
  | { type: 'classifier' }

type PermissionRejectionSource =
  | { type: 'hook' }
  | { type: 'user_abort' }
  | { type: 'user_reject'; hasFeedback: boolean }

// Generic interface for permission queue operations, decoupled from React.
// In the REPL, these are backed by React state.
type PermissionQueueOps = {
  push(item: ToolUseConfirm): void
  remove(
    toolUseID: string,
    permissionSessionId: ToolUseConfirm['permissionSessionId'],
    agentId: ToolUseContext['agentId'],
  ): void
  update(
    toolUseID: string,
    permissionSessionId: ToolUseConfirm['permissionSessionId'],
    agentId: ToolUseContext['agentId'],
    patch: Partial<ToolUseConfirm>,
  ): void
}

function isSamePermissionQueueEntry(
  item: Pick<
    ToolUseConfirm,
    'toolUseID' | 'permissionSessionId' | 'toolUseContext'
  >,
  toolUseID: string,
  permissionSessionId: ToolUseConfirm['permissionSessionId'],
  agentId: ToolUseContext['agentId'],
): boolean {
  return (
    item.toolUseID === toolUseID &&
    item.permissionSessionId === permissionSessionId &&
    item.toolUseContext.agentId === agentId
  )
}

type ResolveOnce<T> = {
  resolve(value: T): void
  isResolved(): boolean
  /**
   * Atomically check-and-mark as resolved. Returns true if this caller
   * won the race (nobody else has resolved yet), false otherwise.
   * Use this in async callbacks BEFORE awaiting, to close the window
   * between the `isResolved()` check and the actual `resolve()` call.
   */
  claim(): boolean
}

function createResolveOnce<T>(resolve: (value: T) => void): ResolveOnce<T> {
  let claimed = false
  let delivered = false
  return {
    resolve(value: T) {
      if (delivered) return
      delivered = true
      claimed = true
      resolve(value)
    },
    isResolved() {
      return claimed
    },
    claim() {
      if (claimed) return false
      claimed = true
      return true
    },
  }
}

function createPermissionContext(
  tool: ToolType,
  input: Record<string, unknown>,
  toolUseContext: ToolUseContext,
  assistantMessage: AssistantMessage,
  toolUseID: string,
  setToolPermissionContext: (context: ToolPermissionContext) => void,
  queueOps?: PermissionQueueOps,
) {
  const messageId = assistantMessage.message.id
  const ctx = {
    tool,
    input,
    toolUseContext,
    assistantMessage,
    messageId,
    toolUseID,
    logDecision(
      args: PermissionDecisionArgs,
      opts?: {
        input?: Record<string, unknown>
        permissionPromptStartTimeMs?: number
      },
    ) {
      logPermissionDecision(
        {
          tool,
          input: opts?.input ?? input,
          toolUseContext,
          messageId,
          toolUseID,
        },
        args,
        opts?.permissionPromptStartTimeMs,
      )
    },
    logCancelled() {
      logEvent('tengu_tool_use_cancelled', {
        messageID:
          messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        toolName: sanitizeToolNameForAnalytics(tool.name),
      })
    },
    async persistPermissions(
      updates: PermissionUpdate[],
      hookPlanModeWasActive?: boolean,
    ) {
      if (
        !isPermissionSessionActive(
          toolUseContext.options.permissionSessionId,
        )
      ) {
        return false
      }
      if (updates.length === 0) return false
      const validationRootState =
        toolUseContext.getRootAppState?.() ?? toolUseContext.getAppState()
      const validatedUpdates: PermissionUpdate[] = []
      let nextContextForValidation =
        validationRootState.toolPermissionContext
      for (const update of updates) {
        if (update.type === 'setMode') {
          const modeDecision = await getPermissionModeChangeRequestDecision({
            mode: update.mode,
            toolPermissionContext: nextContextForValidation,
            requireLocalConfirmation: false,
          })
          if (modeDecision.status === 'blocked') {
            logForDebugging(
              `Skipping permission mode update for ${update.mode}: ${modeDecision.error}`,
              { level: 'warn' },
            )
            continue
          }
        }
        validatedUpdates.push(update)
        // Validation/staging must stay pure: defer live transition side effects
        // until we actually commit the updates below.
        nextContextForValidation = applyPermissionUpdate(
          nextContextForValidation,
          update,
        )
      }
      if (validatedUpdates.length === 0) return false
      const latestAppState = toolUseContext.getAppState()
      const rootAppState =
        toolUseContext.getRootAppState?.() ?? latestAppState
      const updatesToApply =
        hookPlanModeWasActive === undefined
          ? validatedUpdates
          : filterPermissionRequestHookUpdates(
              validatedUpdates,
              hookPlanModeWasActive ||
                latestAppState.toolPermissionContext.mode === 'plan' ||
                rootAppState.toolPermissionContext.mode === 'plan',
            )
      if (updatesToApply.length === 0) return false
      if (
        !isPermissionSessionActive(
          toolUseContext.options.permissionSessionId,
        )
      ) {
        return false
      }
      const updatedContext = applyPermissionUpdatesToLiveContext(
        rootAppState.toolPermissionContext,
        updatesToApply,
      )
      persistPermissionUpdates(updatesToApply)
      setToolPermissionContext(updatedContext)
      return updatesToApply.some(update =>
        supportsPersistence(update.destination),
      )
    },
    resolveIfAborted(resolve: (decision: PermissionDecision) => void) {
      if (!toolUseContext.abortController.signal.aborted) return false
      this.logCancelled()
      resolve(this.cancelAndAbort(undefined, true))
      return true
    },
    cancelAndAbort(
      feedback?: string,
      isAbort?: boolean,
      contentBlocks?: ContentBlockParam[],
      abortTrace?: { source: string; causalEventId?: string },
    ): PermissionDecision {
      const sub = !!toolUseContext.agentId
      const baseMessage = feedback
        ? `${sub ? SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX : REJECT_MESSAGE_WITH_REASON_PREFIX}${feedback}`
        : sub
          ? SUBAGENT_REJECT_MESSAGE
          : REJECT_MESSAGE
      const message = sub ? baseMessage : withMemoryCorrectionHint(baseMessage)
      if (isAbort || (!feedback && !contentBlocks?.length && !sub)) {
        logForDebugging(
          `Aborting: tool=${tool.name} isAbort=${isAbort} hasFeedback=${!!feedback} isSubagent=${sub}`,
        )
        requestAbort(toolUseContext.abortController, 'interrupt', {
          source: abortTrace?.source ?? 'permission_abort',
          causalEventId: abortTrace?.causalEventId,
          subsystem: 'tool_permission',
          controllerRole: 'query-root',
        })
      }
      return { behavior: 'ask', message, contentBlocks }
    },
    ...(feature('BASH_CLASSIFIER')
      ? {
          async tryClassifier(
            pendingClassifierCheck: PendingClassifierCheck | undefined,
            updatedInput: Record<string, unknown> | undefined,
          ): Promise<PermissionDecision | null> {
            if (tool.name !== BASH_TOOL_NAME || !pendingClassifierCheck) {
              return null
            }
            const planModeWasActive =
              toolUseContext.getAppState().toolPermissionContext.mode ===
              'plan'
            const classifierDecision = await awaitClassifierAutoApproval(
              pendingClassifierCheck,
              toolUseContext.abortController.signal,
              toolUseContext.options.isNonInteractiveSession,
            )
            if (!classifierDecision) {
              return null
            }
            const finalInput = updatedInput ?? input
            const planModeDecision =
              await revalidatePlanModePermissionAllowWithRaceGuard(
                tool,
                input,
                finalInput,
                toolUseContext,
                planModeWasActive,
              )
            if (planModeDecision) {
              return planModeDecision
            }
            if (
              feature('TRANSCRIPT_CLASSIFIER') &&
              classifierDecision.type === 'classifier'
            ) {
              const matchedRule = classifierDecision.reason.match(
                /^Allowed by prompt rule: "(.+)"$/,
              )?.[1]
              if (matchedRule) {
                setClassifierApproval(toolUseID, matchedRule)
              }
            }
            logPermissionDecision(
              { tool, input, toolUseContext, messageId, toolUseID },
              { decision: 'accept', source: { type: 'classifier' } },
              undefined,
            )
            return {
              behavior: 'allow' as const,
              updatedInput: finalInput,
              userModified: false,
              decisionReason: classifierDecision,
            }
          },
        }
      : {}),
    async runHooks(
      permissionMode: string | undefined,
      suggestions: PermissionUpdate[] | undefined,
      updatedInput?: Record<string, unknown>,
      permissionPromptStartTimeMs?: number,
      ownerDecisionAuthorized = false,
    ): Promise<PermissionDecision | null> {
      const enforcePlanMode =
        toolUseContext.getAppState().toolPermissionContext.mode === 'plan'
      const candidateInput = updatedInput ?? input
      const candidateRuleDecision = enforcePlanMode
        ? await checkRuleBasedPermissions(
            tool,
            candidateInput,
            toolUseContext,
          )
        : null
      if (candidateRuleDecision?.behavior === 'deny') {
        return candidateRuleDecision
      }
      for await (const hookResult of executePermissionRequestHooks(
        tool.name,
        toolUseID,
        input,
        toolUseContext,
        permissionMode,
        suggestions,
        toolUseContext.abortController.signal,
      )) {
        if (hookResult.permissionRequestResult) {
          const decision = hookResult.permissionRequestResult
          if (decision.behavior === 'allow') {
            const finalInput = decision.updatedInput ?? updatedInput ?? input
            const finalPlanMode =
              enforcePlanMode ||
              toolUseContext.getAppState().toolPermissionContext.mode ===
                'plan'
            const finalRuleDecision = finalPlanMode
              ? await checkRuleBasedPermissions(
                  tool,
                  finalInput,
                  toolUseContext,
                )
              : null
            if (finalRuleDecision?.behavior === 'deny') {
              return finalRuleDecision
            }
            const planModeDecision = await checkPlanModePermissions(
              tool,
              finalInput,
              toolUseContext,
              enforcePlanMode,
            )
            if (planModeDecision) {
              return planModeDecision
            }
            if (
              finalRuleDecision?.behavior === 'ask' &&
              !samePermissionAskConstraint(
                candidateRuleDecision,
                finalRuleDecision,
              )
            ) {
              return finalRuleDecision
            }
            return await this.handleHookAllow(
              finalInput,
              filterPermissionRequestHookUpdates(
                decision.updatedPermissions ?? [],
                enforcePlanMode ||
                  toolUseContext.getAppState().toolPermissionContext.mode ===
                    'plan',
              ),
              permissionPromptStartTimeMs,
              enforcePlanMode,
              ownerDecisionAuthorized,
            )
          } else if (decision.behavior === 'deny') {
            this.logDecision(
              { decision: 'reject', source: { type: 'hook' } },
              { permissionPromptStartTimeMs },
            )
            if (decision.interrupt) {
              logForDebugging(
                `Hook interrupt: tool=${tool.name} hookMessage=${decision.message}`,
              )
              requestAbort(toolUseContext.abortController, 'interrupt', {
                source: 'permission_hook',
                subsystem: 'tool_permission',
                controllerRole: 'query-root',
              })
            }
            return this.buildDeny(
              decision.message || 'Permission denied by hook',
              {
                type: 'hook',
                hookName: 'PermissionRequest',
                reason: decision.message,
              },
            )
          }
        }
      }
      return null
    },
    buildAllow(
      updatedInput: Record<string, unknown>,
      opts?: {
        userModified?: boolean
        decisionReason?: PermissionDecisionReason
        acceptFeedback?: string
        contentBlocks?: ContentBlockParam[]
      },
    ): PermissionAllowDecision {
      return {
        behavior: 'allow' as const,
        updatedInput,
        userModified: opts?.userModified ?? false,
        ...(opts?.decisionReason && { decisionReason: opts.decisionReason }),
        ...(opts?.acceptFeedback && { acceptFeedback: opts.acceptFeedback }),
        ...(opts?.contentBlocks &&
          opts.contentBlocks.length > 0 && {
            contentBlocks: opts.contentBlocks,
          }),
      }
    },
    buildDeny(
      message: string,
      decisionReason: PermissionDecisionReason,
    ): PermissionDenyDecision {
      return { behavior: 'deny' as const, message, decisionReason }
    },
    async handleUserAllow(
      updatedInput: Record<string, unknown>,
      permissionUpdates: PermissionUpdate[],
      feedback?: string,
      permissionPromptStartTimeMs?: number,
      contentBlocks?: ContentBlockParam[],
      decisionReason?: PermissionDecisionReason,
      // Set only after an exact owner-scoped user/remote decision is claimed.
      // Persistence keeps its own active-session guard; this token prevents a
      // later UI switch from rewriting the already-authorized one-time result.
      ownerDecisionAuthorized = false,
    ): Promise<PermissionDecision> {
      if (
        !ownerDecisionAuthorized &&
        !isPermissionSessionActive(
          toolUseContext.options.permissionSessionId,
        )
      ) {
        return buildInactivePermissionSessionDecision()
      }
      const planModeWasActive =
        toolUseContext.getAppState().toolPermissionContext.mode === 'plan'
      const revalidation =
        await revalidatePlanModePermissionAllowWithRaceGuard(
          tool,
          input,
          updatedInput,
          toolUseContext,
          planModeWasActive,
        )
      if (revalidation) {
        return revalidation
      }
      const acceptedPermanentUpdates =
        await this.persistPermissions(permissionUpdates, planModeWasActive)
      const finalRevalidation =
        await revalidatePlanModePermissionAllowWithRaceGuard(
          tool,
          input,
          updatedInput,
          toolUseContext,
          planModeWasActive,
        )
      if (finalRevalidation) {
        return finalRevalidation
      }
      if (
        !ownerDecisionAuthorized &&
        !isPermissionSessionActive(
          toolUseContext.options.permissionSessionId,
        )
      ) {
        return buildInactivePermissionSessionDecision()
      }
      this.logDecision(
        {
          decision: 'accept',
          source: { type: 'user', permanent: acceptedPermanentUpdates },
        },
        { input: updatedInput, permissionPromptStartTimeMs },
      )
      const userModified = tool.inputsEquivalent
        ? !tool.inputsEquivalent(input, updatedInput)
        : false
      const trimmedFeedback = feedback?.trim()
      return this.buildAllow(updatedInput, {
        userModified,
        decisionReason,
        acceptFeedback: trimmedFeedback || undefined,
        contentBlocks,
      })
    },
    async handleHookAllow(
      finalInput: Record<string, unknown>,
      permissionUpdates: PermissionUpdate[],
      permissionPromptStartTimeMs?: number,
      planModeWasActive = false,
      ownerDecisionAuthorized = false,
    ): Promise<PermissionDecision> {
      if (
        !ownerDecisionAuthorized &&
        !isPermissionSessionActive(
          toolUseContext.options.permissionSessionId,
        )
      ) {
        return buildInactivePermissionSessionDecision()
      }
      const acceptedPermanentUpdates =
        await this.persistPermissions(permissionUpdates, planModeWasActive)
      const postUpdatePlanModeDecision =
        await revalidatePlanModePermissionAllowWithRaceGuard(
          tool,
          input,
          finalInput,
          toolUseContext,
          planModeWasActive ||
            toolUseContext.getAppState().toolPermissionContext.mode === 'plan',
        )
      if (postUpdatePlanModeDecision) {
        return postUpdatePlanModeDecision
      }
      if (
        !ownerDecisionAuthorized &&
        !isPermissionSessionActive(
          toolUseContext.options.permissionSessionId,
        )
      ) {
        return buildInactivePermissionSessionDecision()
      }
      this.logDecision(
        {
          decision: 'accept',
          source: { type: 'hook', permanent: acceptedPermanentUpdates },
        },
        { input: finalInput, permissionPromptStartTimeMs },
      )
      return this.buildAllow(finalInput, {
        decisionReason: { type: 'hook', hookName: 'PermissionRequest' },
      })
    },
    async handleClassifierAllow(
      finalInput: Record<string, unknown>,
      decisionReason: PermissionDecisionReason,
      permissionPromptStartTimeMs?: number,
      planModeWasActive = false,
    ): Promise<PermissionDecision> {
      if (
        !isPermissionSessionActive(
          toolUseContext.options.permissionSessionId,
        )
      ) {
        return buildInactivePermissionSessionDecision()
      }
      const planModeDecision =
        await revalidatePlanModePermissionAllowWithRaceGuard(
          tool,
          input,
          finalInput,
          toolUseContext,
          planModeWasActive,
        )
      if (planModeDecision) {
        return planModeDecision
      }
      if (
        !isPermissionSessionActive(
          toolUseContext.options.permissionSessionId,
        )
      ) {
        return buildInactivePermissionSessionDecision()
      }
      this.logDecision(
        { decision: 'accept', source: { type: 'classifier' } },
        { input: finalInput, permissionPromptStartTimeMs },
      )
      return this.buildAllow(finalInput, { decisionReason })
    },
    pushToQueue(item: ToolUseConfirm) {
      queueOps?.push(item)
    },
    removeFromQueue() {
      queueOps?.remove(
        toolUseID,
        toolUseContext.options.permissionSessionId,
        toolUseContext.agentId,
      )
    },
    updateQueueItem(patch: Partial<ToolUseConfirm>) {
      queueOps?.update(
        toolUseID,
        toolUseContext.options.permissionSessionId,
        toolUseContext.agentId,
        patch,
      )
    },
  }
  return Object.freeze(ctx)
}

type PermissionContext = ReturnType<typeof createPermissionContext>

/**
 * Create a PermissionQueueOps backed by a React state setter.
 * This is the bridge between React's `setToolUseConfirmQueue` and the
 * generic queue interface used by PermissionContext.
 */
function createPermissionQueueOps(
  setToolUseConfirmQueue: React.Dispatch<
    React.SetStateAction<ToolUseConfirm[]>
  >,
): PermissionQueueOps {
  return {
    push(item: ToolUseConfirm) {
      setToolUseConfirmQueue(queue => [...queue, item])
    },
    remove(
      toolUseID: string,
      permissionSessionId: ToolUseConfirm['permissionSessionId'],
      agentId: ToolUseContext['agentId'],
    ) {
      setToolUseConfirmQueue(queue =>
        queue.filter(
          item =>
            !isSamePermissionQueueEntry(
              item,
              toolUseID,
              permissionSessionId,
              agentId,
            ),
        ),
      )
    },
    update(
      toolUseID: string,
      permissionSessionId: ToolUseConfirm['permissionSessionId'],
      agentId: ToolUseContext['agentId'],
      patch: Partial<ToolUseConfirm>,
    ) {
      setToolUseConfirmQueue(queue =>
        queue.map(item =>
          isSamePermissionQueueEntry(
            item,
            toolUseID,
            permissionSessionId,
            agentId,
          )
            ? { ...item, ...patch }
            : item,
        ),
      )
    },
  }
}

export {
  createPermissionContext,
  createPermissionQueueOps,
  createResolveOnce,
  isSamePermissionQueueEntry,
}
export type {
  PermissionContext,
  PermissionApprovalSource,
  PermissionQueueOps,
  PermissionRejectionSource,
  ResolveOnce,
}
