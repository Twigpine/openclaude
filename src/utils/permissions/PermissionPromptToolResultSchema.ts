import type { Tool, ToolUseContext } from 'src/Tool.js'
import z from 'zod/v4'
import { logForDebugging } from '../debug.js'
import { lazySchema } from '../lazySchema.js'
import { requestAbort } from '../interruptionTrace.js'
import type {
  PermissionDecision,
  PermissionDecisionReason,
} from './PermissionResult.js'
import {
  filterPermissionRequestHookUpdates,
  persistPermissionUpdates,
} from './PermissionUpdate.js'
import { permissionUpdateSchema } from './PermissionUpdateSchema.js'
import { applyPermissionUpdatesToLiveContext } from './permissionSetup.js'
import { revalidatePlanModePermissionAllowWithRaceGuard } from './permissions.js'

export const inputSchema = lazySchema(() =>
  z.object({
    tool_name: z
      .string()
      .describe('The name of the tool requesting permission'),
    input: z.record(z.string(), z.unknown()).describe('The input for the tool'),
    tool_use_id: z
      .string()
      .optional()
      .describe('The unique tool use request ID'),
  }),
)

export type Input = z.infer<ReturnType<typeof inputSchema>>

// Zod schema for permission results
// This schema is used to validate the MCP permission prompt tool
// so we maintain it as a subset of the real PermissionDecision type

// Matches PermissionDecisionClassificationSchema in entrypoints/sdk/coreSchemas.ts.
// Malformed values fall through to undefined (same pattern as updatedPermissions
// below) so a bad string from the SDK host doesn't reject the whole decision.
const decisionClassificationField = lazySchema(() =>
  z
    .enum(['user_temporary', 'user_permanent', 'user_reject'])
    .optional()
    .catch(undefined),
)

const PermissionAllowResultSchema = lazySchema(() =>
  z.object({
    behavior: z.literal('allow'),
    updatedInput: z.record(z.string(), z.unknown()),
    // SDK hosts may send malformed entries; fall back to undefined rather
    // than rejecting the entire allow decision (anthropics/claude-code#29440)
    updatedPermissions: z
      .array(permissionUpdateSchema())
      .optional()
      .catch(ctx => {
        logForDebugging(
          `Malformed updatedPermissions from SDK host ignored: ${ctx.error.issues[0]?.message ?? 'unknown'}`,
          { level: 'warn' },
        )
        return undefined
      }),
    toolUseID: z.string().optional(),
    decisionClassification: decisionClassificationField(),
  }),
)

const PermissionDenyResultSchema = lazySchema(() =>
  z.object({
    behavior: z.literal('deny'),
    message: z.string(),
    interrupt: z.boolean().optional(),
    toolUseID: z.string().optional(),
    decisionClassification: decisionClassificationField(),
  }),
)

export const outputSchema = lazySchema(() =>
  z.union([PermissionAllowResultSchema(), PermissionDenyResultSchema()]),
)

export type Output = z.infer<ReturnType<typeof outputSchema>>

/**
 * Normalizes the result of a permission prompt tool to a PermissionDecision.
 */
export async function permissionPromptToolResultToPermissionDecision(
  result: Output,
  tool: Tool,
  input: { [key: string]: unknown },
  toolUseContext: ToolUseContext,
): Promise<PermissionDecision> {
  const decisionReason: PermissionDecisionReason = {
    type: 'permissionPromptTool',
    permissionPromptToolName: tool.name,
    toolResult: result,
  }
  if (result.behavior === 'allow') {
    // Mobile clients responding from a push notification don't have the
    // original tool input, so they send `{}` to satisfy the schema. Treat an
    // empty object as "use original" so the tool doesn't run with no args.
    const updatedInput =
      Object.keys(result.updatedInput).length > 0 ? result.updatedInput : input
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
    const enforcePlanMode =
      planModeWasActive ||
      toolUseContext.getAppState().toolPermissionContext.mode === 'plan'
    if (revalidation) {
      return revalidation
    }

    const updatedPermissions = filterPermissionRequestHookUpdates(
      result.updatedPermissions ?? [],
      enforcePlanMode ||
        toolUseContext.getAppState().toolPermissionContext.mode === 'plan',
    )
    if (updatedPermissions.length > 0) {
      let updatedContext = toolUseContext.getAppState().toolPermissionContext
      toolUseContext.setAppState(prev => {
        updatedContext = applyPermissionUpdatesToLiveContext(
          prev.toolPermissionContext,
          updatedPermissions,
        )
        if (prev.toolPermissionContext === updatedContext) return prev
        return {
          ...prev,
          toolPermissionContext: updatedContext,
        }
      })
      persistPermissionUpdates(updatedPermissions)
    }
    const postUpdatePlanModeDecision =
      await revalidatePlanModePermissionAllowWithRaceGuard(
        tool,
        input,
        updatedInput,
        toolUseContext,
        enforcePlanMode ||
          toolUseContext.getAppState().toolPermissionContext.mode === 'plan',
      )
    if (postUpdatePlanModeDecision) {
      return postUpdatePlanModeDecision
    }
    const { updatedPermissions: _updatedPermissions, ...allowResult } = result
    return {
      ...allowResult,
      updatedInput,
      decisionReason,
    }
  } else if (result.behavior === 'deny' && result.interrupt) {
    logForDebugging(
      `SDK permission prompt deny+interrupt: tool=${tool.name} message=${result.message}`,
    )
    requestAbort(toolUseContext.abortController, 'interrupt', {
      source: 'sdk_permission_interrupt',
      subsystem: 'tool_permission',
      controllerRole: 'query-root',
    })
  }
  return {
    ...result,
    decisionReason,
  }
}
