import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import type { PermissionDecision } from '../../types/permissions.js'
import type { AssistantMessage, AttachmentMessage, SystemMessage, UserMessage } from '../../types/message.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { PRODUCT_DISPLAY_NAME } from '../../constants/product.js'
import { REPL_TOOL_NAME } from './constants.js'
import { ReplInnerToolRunner } from './innerToolRunner.js'
import { getReplToolDescription, getReplToolPrompt } from './prompt.js'
import { executeQuickJSScript, PromptWaitTracker } from './quickjsRuntime.js'
import { serializeBridgeError } from './serialization.js'
import { buildReplToolInventory } from './toolWrappers.js'
import { isResultTruncated, renderToolResultMessage, renderToolUseMessage, renderToolUseProgressMessage } from './UI.js'

const REPL_TIMEOUT_MS = 10 * 60 * 1000
const REPL_QUIESCE_TIMEOUT_MS = 2_000
const REPL_CODE_MAX_CHARS = 100_000
const MODEL_OUTPUT_TEXT_LIMIT = 8_000

let replTimeoutMsOverride: number | undefined
let replQuiesceTimeoutMsOverride: number | undefined

export const __test = {
  async withExecutionLimits<T>(
    limits: { timeoutMs?: number; quiesceTimeoutMs?: number },
    run: () => Promise<T>,
  ): Promise<T> {
    const previousTimeoutMs = replTimeoutMsOverride
    const previousQuiesceTimeoutMs = replQuiesceTimeoutMsOverride
    replTimeoutMsOverride = limits.timeoutMs
    replQuiesceTimeoutMsOverride = limits.quiesceTimeoutMs
    try {
      return await run()
    } finally {
      replTimeoutMsOverride = previousTimeoutMs
      replQuiesceTimeoutMsOverride = previousQuiesceTimeoutMs
    }
  },
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    code: z.string().min(1).max(REPL_CODE_MAX_CHARS).describe('JavaScript to execute in the isolated foreground REPL runtime'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    status: z.enum(['completed', 'error', 'timeout', 'aborted']).optional(),
    code: z.string().optional(),
    result: z.unknown().optional(),
    error: z.object({
      name: z.string(),
      message: z.string(),
      stack: z.string().optional(),
    }).optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    durationMs: z.number().optional(),
    toolsUsed: z.array(z.string()).optional(),
    residualInnerWork: z.object({
      active: z.boolean(),
      activeInvocationCount: z.number().int().nonnegative(),
      quiesceTimeoutMs: z.number().int().positive(),
      warning: z.string(),
    }).optional(),
    persistedOutputPath: z.string().optional(),
    persistedOutputSize: z.number().int().nonnegative().optional(),
    persistedOutputPreview: z.string().optional(),
    persistedOutputTruncated: z.boolean().optional(),
    persistedOutputTruncatedFields: z.array(z.string()).optional(),
    persistedOutputError: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type ReplToolOutput = z.infer<OutputSchema>

function truncateForModel(text: string, maxLength = MODEL_OUTPUT_TEXT_LIMIT): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}\n... [truncated ${text.length - maxLength} chars]`
}

function formatUnknownForModel(value: unknown): string {
  if (value === undefined) return 'undefined'
  const serialized = jsonStringify(value, null, 2)
  return truncateForModel(serialized ?? String(value), 4_000)
}

function residualInnerWorkWarning(activeInvocationCount: number): string {
  const noun = activeInvocationCount === 1 ? 'invocation' : 'invocations'
  return `${activeInvocationCount} inner tool ${noun} still running after REPL teardown. Side effects from this work may still complete. Do not retry or repeat potentially non-idempotent operations unless you first verify the current state.`
}

export const REPLTool = buildTool({
  name: REPL_TOOL_NAME,
  searchHint: 'javascript orchestration of session tools',
  maxResultSizeChars: 16_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async description() {
    return getReplToolDescription()
  },
  async prompt(options) {
    return getReplToolPrompt(options)
  },
  userFacingName() {
    return 'REPL'
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  interruptBehavior() {
    return 'cancel'
  },
  toAutoClassifierInput(input) {
    return input.code
  },
  async checkPermissions(_input, context): Promise<PermissionDecision> {
    if (context.getAppState().toolPermissionContext.mode === 'plan') {
      return { behavior: 'allow' }
    }
    return {
      behavior: 'ask',
      message: `${PRODUCT_DISPLAY_NAME} requested permissions to execute a JavaScript tool orchestration script with REPL. Inner tools will still use their normal permission checks.`,
    }
  },
  async call(input: Input, context, canUseTool, _parentMessage, onProgress) {
    const promptWaitTracker = new PromptWaitTracker()
    const virtualMessages: Array<UserMessage | AssistantMessage | AttachmentMessage | SystemMessage> = []
    const toolsUsed = new Set<string>()
    const permissionContext = context.getAppState().toolPermissionContext
    const inventory = buildReplToolInventory({
      sessionTools: context.options.tools,
      permissionContext,
      allowedPrimitiveNames: context.options.replPrimitiveToolNames,
    })
    const scriptController = new AbortController()
    const abortFromOuter = () => scriptController.abort(context.abortController.signal.reason)
    context.abortController.signal.addEventListener('abort', abortFromOuter, { once: true })
    const progressToolUseID = context.toolUseId ?? 'unknown'
    const runner = new ReplInnerToolRunner({
      inventory,
      toolUseContext: context,
      canUseTool,
      promptWaitTracker,
      abortSignal: scriptController.signal,
      onTerminalFailure: error => scriptController.abort(error),
      onInnerToolUse: toolName => {
        toolsUsed.add(toolName)
      },
      onVirtualMessage: message => {
        if (
          message.type === 'assistant' ||
          message.type === 'user' ||
          message.type === 'attachment' ||
          message.type === 'system'
        ) {
          virtualMessages.push(message)
        }
      },
      onProgress: message => {
        onProgress?.({
          toolUseID: progressToolUseID,
          data: {
            ...message.data,
            replInnerToolUseID: message.parentToolUseID,
            replInnerProgressEventID: message.toolUseID,
          },
        })
      },
    })

    let hasUnawaitedWorkAtCompletion = false
    try {
      const quiesceTimeoutMs = replQuiesceTimeoutMsOverride ?? REPL_QUIESCE_TIMEOUT_MS
      const execution = await executeQuickJSScript({
        code: input.code,
        hostFunctions: runner.createHostFunctions(),
        timeoutMs: replTimeoutMsOverride ?? REPL_TIMEOUT_MS,
        abortSignal: scriptController.signal,
        promptWaitTracker,
        onScriptCompletion: ({ pendingHostFunctionNames }) => {
          hasUnawaitedWorkAtCompletion = pendingHostFunctionNames.length > 0
        },
      })
      const hasUnawaitedWork = hasUnawaitedWorkAtCompletion
      if (hasUnawaitedWork || runner.hasActiveInvocations()) {
        runner.abort(new Error(hasUnawaitedWork
          ? 'REPL script completed without awaiting all inner tool calls'
          : 'REPL execution ended before inner tool calls completed'))
      }
      const quiesced = await runner.quiesce(quiesceTimeoutMs)
      const activeInvocationCount = runner.getActiveInvocationCount()
      const residualInnerWork = !quiesced && activeInvocationCount > 0
        ? {
            active: true,
            activeInvocationCount,
            quiesceTimeoutMs,
            warning: residualInnerWorkWarning(activeInvocationCount),
          }
        : undefined
      const finalExecution = (hasUnawaitedWork || residualInnerWork !== undefined) && execution.status === 'completed'
        ? {
            ...execution,
            status: 'error' as const,
            result: undefined,
            error: serializeBridgeError(new Error(hasUnawaitedWork
              ? 'REPL script completed without awaiting all inner tool calls'
              : 'REPL inner tool calls did not stop during teardown')),
          }
        : execution
      return {
        data: {
          ...finalExecution,
          code: input.code,
          toolsUsed: [...toolsUsed].sort(),
          ...(residualInnerWork ? { residualInnerWork } : {}),
        },
        newMessages: virtualMessages,
      }
    } finally {
      context.abortController.signal.removeEventListener('abort', abortFromOuter)
      runner.dispose()
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const status = output.status ?? 'unknown'
    const toolsUsed = output.toolsUsed ?? []
    const duration = typeof output.durationMs === 'number'
      ? ` in ${Math.round(output.durationMs)}ms`
      : ''
    const lines = [
      `REPL ${status}${duration}`,
      `tools used: ${toolsUsed.length ? toolsUsed.join(', ') : 'none'}`,
      `result: ${formatUnknownForModel(output.result)}`,
    ]
    if (output.error) lines.push(`error: ${output.error.name}: ${output.error.message}`)
    if (output.residualInnerWork?.active) {
      lines.push(`warning: ${output.residualInnerWork.warning}`)
    }
    if (output.stdout) lines.push(`stdout:\n${truncateForModel(output.stdout, 2_000)}`)
    if (output.stderr) lines.push(`stderr:\n${truncateForModel(output.stderr, 2_000)}`)
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: lines.join('\n'),
      ...(status !== 'completed' ? { is_error: true } : {}),
    }
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolResultMessage,
  isResultTruncated,
})

export default REPLTool
