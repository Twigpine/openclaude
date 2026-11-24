import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import type { PermissionDecision, ToolPermissionContext } from '../../types/permissions.js'
import type { AssistantMessage, AttachmentMessage, SystemMessage, UserMessage } from '../../types/message.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  getAskRuleForTool,
  getDenyRuleForTool,
  toolAlwaysAllowedRule,
} from '../../utils/permissions/permissions.js'
import { PRODUCT_DISPLAY_NAME } from '../../constants/product.js'
import { REPL_TOOL_NAME } from './constants.js'
import { ReplInnerToolRunner } from './innerToolRunner.js'
import { getReplToolDescription, getReplToolPrompt } from './prompt.js'
import { executeQuickJSScript, PromptWaitTracker } from './quickjsRuntime.js'
import { buildReplToolInventory } from './toolWrappers.js'

const REPL_TIMEOUT_MS = 10 * 60 * 1000
const MODEL_OUTPUT_TEXT_LIMIT = 8_000

const inputSchema = lazySchema(() =>
  z.strictObject({
    code: z.string().min(1).describe('JavaScript to execute in the isolated foreground REPL runtime'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    status: z.enum(['completed', 'error', 'timeout', 'aborted']),
    result: z.unknown().optional(),
    error: z.object({
      name: z.string(),
      message: z.string(),
      stack: z.string().optional(),
    }).optional(),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: z.number(),
    toolsUsed: z.array(z.string()),
    innerMessageCount: z.number(),
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

function outerToolUseId(parentMessage: Parameters<Parameters<typeof buildTool>[0]['call']>[3]): string {
  const content = parentMessage.message.content
  if (!Array.isArray(content)) return 'unknown'
  const toolUse = content.find(block =>
    typeof block === 'object' && block !== null &&
    (block as { type?: string }).type === 'tool_use' &&
    (block as { name?: string }).name === REPL_TOOL_NAME,
  ) as { id?: string } | undefined
  return toolUse?.id ?? 'unknown'
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
  async prompt() {
    return getReplToolPrompt()
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
    return input.code.slice(0, 8_000)
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const permissionContext = context.getAppState().toolPermissionContext
    const denyRule = getDenyRuleForTool(permissionContext, REPLTool)
    if (denyRule) {
      return {
        behavior: 'deny',
        message: 'REPL execution is denied by permission rules.',
        decisionReason: { type: 'rule', rule: denyRule },
      }
    }
    const allowRule = toolAlwaysAllowedRule(permissionContext, REPLTool)
    if (allowRule) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'rule', rule: allowRule },
      }
    }
    const askRule = getAskRuleForTool(permissionContext, REPLTool)
    return {
      behavior: 'ask',
      message: `${PRODUCT_DISPLAY_NAME} requested permissions to execute a JavaScript tool orchestration script with REPL. Inner tools will still use their normal permission checks.`,
      ...(askRule ? { decisionReason: { type: 'rule', rule: askRule } } : {}),
    }
  },
  async call(input: Input, context, canUseTool, parentMessage, onProgress) {
    const promptWaitTracker = new PromptWaitTracker()
    const virtualMessages: Array<UserMessage | AssistantMessage | AttachmentMessage | SystemMessage> = []
    const toolsUsed = new Set<string>()
    const permissionContext = context.getAppState().toolPermissionContext
    const inventory = buildReplToolInventory({
      sessionTools: context.options.tools,
      permissionContext: permissionContext as ToolPermissionContext,
    })
    const scriptController = new AbortController()
    const abortFromOuter = () => scriptController.abort(context.abortController.signal.reason)
    context.abortController.signal.addEventListener('abort', abortFromOuter, { once: true })
    const progressToolUseID = outerToolUseId(parentMessage)
    const runner = new ReplInnerToolRunner({
      inventory,
      toolUseContext: context,
      canUseTool,
      promptWaitTracker,
      abortSignal: scriptController.signal,
      onTerminalFailure: error => scriptController.abort(error),
      onVirtualMessage: message => {
        if (
          message.type === 'assistant' ||
          message.type === 'user' ||
          message.type === 'attachment' ||
          message.type === 'system'
        ) {
          virtualMessages.push(message)
        }
        if (message.type === 'assistant' && Array.isArray(message.message.content)) {
          for (const block of message.message.content) {
            if (
              typeof block === 'object' && block !== null &&
              (block as { type?: string }).type === 'tool_use' &&
              typeof (block as { name?: string }).name === 'string'
            ) {
              toolsUsed.add((block as { name: string }).name)
            }
          }
        }
      },
      onProgress: message => {
        onProgress?.({
          toolUseID: progressToolUseID,
          data: {
            type: 'repl_inner_progress',
            innerToolUseID: message.toolUseID,
            innerProgress: message.data,
          },
        })
      },
    })

    try {
      const execution = await executeQuickJSScript({
        code: input.code,
        hostFunctions: runner.createHostFunctions(),
        timeoutMs: REPL_TIMEOUT_MS,
        abortSignal: scriptController.signal,
        promptWaitTracker,
      })
      return {
        data: {
          ...execution,
          toolsUsed: [...toolsUsed].sort(),
          innerMessageCount: virtualMessages.length,
        },
        newMessages: virtualMessages,
      }
    } finally {
      context.abortController.signal.removeEventListener('abort', abortFromOuter)
      runner.dispose()
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const lines = [
      `REPL ${output.status} in ${Math.round(output.durationMs)}ms`,
      `tools used: ${output.toolsUsed.length ? output.toolsUsed.join(', ') : 'none'}`,
      `result: ${formatUnknownForModel(output.result)}`,
    ]
    if (output.error) lines.push(`error: ${output.error.name}: ${output.error.message}`)
    if (output.stdout) lines.push(`stdout:\n${truncateForModel(output.stdout, 2_000)}`)
    if (output.stderr) lines.push(`stderr:\n${truncateForModel(output.stderr, 2_000)}`)
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: lines.join('\n'),
    }
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage() {
    return null
  },
})

export default REPLTool
