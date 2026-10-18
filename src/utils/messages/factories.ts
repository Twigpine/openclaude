import type {
  BetaContentBlock,
  BetaUsage as Usage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type {
  ContentBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import { randomUUID, type UUID } from 'crypto'
import type { Progress } from '../../Tool.js'
import { NO_CONTENT_MESSAGE } from '../../constants/messages.js'
import {
  COMMAND_ARGS_TAG,
  COMMAND_MESSAGE_TAG,
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from '../../constants/xml.js'
import type { SDKAssistantMessageError } from '../../entrypoints/agentSdkTypes.js'
import type {
  AssistantMessage,
  Message,
  MessageOrigin,
  PartialCompactDirection,
  ProgressMessage,
  UserMessage,
} from '../../types/message.js'
import type { PermissionMode } from '../../types/permissions.js'
import { isDangerousPermissionMode } from '../permissions/PermissionMode.js'

export const INTERRUPT_MESSAGE = '[Request interrupted by user]'
export const INTERRUPT_MESSAGE_FOR_TOOL_USE =
  '[Request interrupted by user for tool use]'
export const CANCEL_MESSAGE =
  "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed."
export const REJECT_MESSAGE =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."
export const NO_RESPONSE_REQUESTED = 'No response requested.'

export const SYNTHETIC_MODEL = '<synthetic>'

export const SYNTHETIC_MESSAGES = new Set([
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  CANCEL_MESSAGE,
  REJECT_MESSAGE,
  NO_RESPONSE_REQUESTED,
])

export function isSyntheticMessage(message: Message): boolean {
  return (
    message.type !== 'progress' &&
    message.type !== 'attachment' &&
    message.type !== 'system' &&
    Array.isArray(message.message.content) &&
    message.message.content[0]?.type === 'text' &&
    SYNTHETIC_MESSAGES.has(message.message.content[0].text)
  )
}

export function isSyntheticApiErrorMessage(
  message: Message,
): message is AssistantMessage & { isApiErrorMessage: true } {
  return (
    message.type === 'assistant' &&
    message.isApiErrorMessage === true &&
    message.message.model === SYNTHETIC_MODEL
  )
}

export function getLastAssistantMessage(
  messages: Message[],
): AssistantMessage | undefined {
  // findLast exits early from the end — much faster than filter + last for
  // large message arrays (called on every REPL render via useFeedbackSurvey).
  return messages.findLast(
    (msg): msg is AssistantMessage => msg.type === 'assistant',
  )
}

export function hasToolCallsInLastAssistantTurn(messages: Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type !== 'assistant') continue
    if (!Array.isArray(message.message.content)) continue
    return message.message.content.some(block => block.type === 'tool_use')
  }
  return false
}

function baseCreateAssistantMessage({
  content,
  isApiErrorMessage = false,
  apiError,
  error,
  errorDetails,
  isVirtual,
  usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: null,
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    },
    inference_geo: null,
    iterations: null,
    speed: null,
  },
}: {
  content: BetaContentBlock[]
  isApiErrorMessage?: boolean
  apiError?: AssistantMessage['apiError']
  error?: SDKAssistantMessageError
  errorDetails?: string
  isVirtual?: true
  usage?: Usage
}): AssistantMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      id: randomUUID(),
      container: null,
      model: SYNTHETIC_MODEL,
      role: 'assistant',
      stop_reason: 'stop_sequence',
      stop_sequence: '',
      type: 'message',
      usage,
      content,
      context_management: null,
    },
    requestId: undefined,
    apiError,
    error,
    errorDetails,
    isApiErrorMessage,
    isVirtual,
  }
}

export function createAssistantMessage({
  content,
  usage,
  isVirtual,
}: {
  content: string | BetaContentBlock[]
  usage?: Usage
  isVirtual?: true
}): AssistantMessage {
  return baseCreateAssistantMessage({
    content:
      typeof content === 'string'
        ? [
            {
              type: 'text' as const,
              text: content === '' ? NO_CONTENT_MESSAGE : content,
            } as BetaContentBlock, // NOTE: citations field is not supported in Bedrock API
          ]
        : content,
    usage,
    isVirtual,
  })
}

export function createAssistantAPIErrorMessage({
  content,
  apiError,
  error,
  errorDetails,
}: {
  content: string
  apiError?: AssistantMessage['apiError']
  error?: SDKAssistantMessageError
  errorDetails?: string
}): AssistantMessage {
  return baseCreateAssistantMessage({
    content: [
      {
        type: 'text' as const,
        text: content === '' ? NO_CONTENT_MESSAGE : content,
      } as BetaContentBlock, // NOTE: citations field is not supported in Bedrock API
    ],
    isApiErrorMessage: true,
    apiError,
    error,
    errorDetails,
  })
}

export function createUserMessage({
  content,
  isMeta,
  isVisibleInTranscriptOnly,
  isVirtual,
  isCompactSummary,
  isCollapseSummary,
  summarizeMetadata,
  toolUseResult,
  imagePermissionToolUseIds,
  isAgentStepLimitToolResult,
  mcpMeta,
  uuid,
  timestamp,
  imagePasteIds,
  sourceToolAssistantUUID,
  permissionMode,
  origin,
}: {
  content: string | ContentBlockParam[]
  isMeta?: boolean
  isVisibleInTranscriptOnly?: boolean
  isVirtual?: boolean
  isCompactSummary?: boolean
  isCollapseSummary?: boolean
  toolUseResult?: unknown // Matches tool's `Output` type
  imagePermissionToolUseIds?: Array<string | null>
  isAgentStepLimitToolResult?: boolean
  /** MCP protocol metadata to pass through to SDK consumers (never sent to model) */
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
  uuid?: UUID | string
  timestamp?: string
  imagePasteIds?: number[]
  // For tool_result messages: the UUID of the assistant message containing the matching tool_use
  sourceToolAssistantUUID?: UUID
  // Permission mode when message was sent (for rewind restoration)
  permissionMode?: PermissionMode
  summarizeMetadata?: {
    messagesSummarized: number
    userContext?: string
    direction?: PartialCompactDirection
  }
  // Provenance of this message. undefined = human (keyboard).
  origin?: MessageOrigin
}): UserMessage {
  const rewindRestorablePermissionMode = isDangerousPermissionMode(
    permissionMode,
  )
    ? undefined
    : permissionMode
  const m: UserMessage = {
    type: 'user',
    message: {
      role: 'user',
      content: content || NO_CONTENT_MESSAGE, // Make sure we don't send empty messages
    },
    isMeta,
    isVisibleInTranscriptOnly,
    isVirtual,
    isCompactSummary,
    isCollapseSummary,
    summarizeMetadata,
    uuid: (uuid as UUID | undefined) || randomUUID(),
    timestamp: timestamp ?? new Date().toISOString(),
    toolUseResult,
    imagePermissionToolUseIds,
    isAgentStepLimitToolResult,
    mcpMeta,
    imagePasteIds,
    sourceToolAssistantUUID,
    permissionMode: rewindRestorablePermissionMode,
    origin,
  }
  return m
}

export function prepareUserContent({
  inputString,
  precedingInputBlocks,
}: {
  inputString: string
  precedingInputBlocks: ContentBlockParam[]
}): string | ContentBlockParam[] {
  if (precedingInputBlocks.length === 0) {
    return inputString
  }

  return [
    ...precedingInputBlocks,
    {
      text: inputString,
      type: 'text',
    },
  ]
}

export function createUserInterruptionMessage({
  toolUse = false,
}: {
  toolUse?: boolean
}): UserMessage {
  const content = toolUse ? INTERRUPT_MESSAGE_FOR_TOOL_USE : INTERRUPT_MESSAGE

  return createUserMessage({
    content: [
      {
        type: 'text',
        text: content,
      },
    ],
  })
}

/**
 * Creates a new synthetic user caveat message for local commands (eg. bash, slash).
 * We need to create a new message each time because messages must have unique uuids.
 */
export function createSyntheticUserCaveatMessage(): UserMessage {
  return createUserMessage({
    content: `<${LOCAL_COMMAND_CAVEAT_TAG}>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</${LOCAL_COMMAND_CAVEAT_TAG}>`,
    isMeta: true,
  })
}

/**
 * Formats the command-input breadcrumb the model sees when a slash command runs.
 */
export function formatCommandInputTags(
  commandName: string,
  args: string,
): string {
  return `<${COMMAND_NAME_TAG}>/${commandName}</${COMMAND_NAME_TAG}>
            <${COMMAND_MESSAGE_TAG}>${commandName}</${COMMAND_MESSAGE_TAG}>
            <${COMMAND_ARGS_TAG}>${args}</${COMMAND_ARGS_TAG}>`
}

/**
 * Builds the breadcrumb trail the SDK set_model control handler injects
 * so the model can see mid-conversation switches. Same shape the CLI's
 * /model command produces via processSlashCommand.
 */
export function createModelSwitchBreadcrumbs(
  modelArg: string,
  resolvedDisplay: string,
): UserMessage[] {
  return [
    createSyntheticUserCaveatMessage(),
    createUserMessage({ content: formatCommandInputTags('model', modelArg) }),
    createUserMessage({
      content: `<${LOCAL_COMMAND_STDOUT_TAG}>Set model to ${resolvedDisplay}</${LOCAL_COMMAND_STDOUT_TAG}>`,
    }),
  ]
}

export function createProgressMessage<P extends Progress>({
  toolUseID,
  parentToolUseID,
  data,
}: {
  toolUseID: string
  parentToolUseID: string
  data: P
}): ProgressMessage<P> {
  return {
    type: 'progress',
    data,
    toolUseID,
    parentToolUseID,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}

export function createToolResultStopMessage(
  toolUseID: string,
): ToolResultBlockParam {
  return {
    type: 'tool_result',
    content: CANCEL_MESSAGE,
    is_error: true,
    tool_use_id: toolUseID,
  }
}
