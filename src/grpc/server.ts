import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import path from 'path'
import { randomUUID } from 'crypto'
import { QueryEngine } from '../QueryEngine.js'
import { getTools } from '../tools.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { AppState } from '../state/AppState.js'
import { FileStateCache, READ_FILE_STATE_CACHE_SIZE } from '../utils/fileStateCache.js'
import { getBuiltInAgents } from '../tools/AgentTool/builtInAgents.js'
import type { Message } from '../types/message.js'

const PROTO_PATH = path.resolve(import.meta.dirname, '../proto/openclaude.proto')

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
})

// proto-loader returns a deeply-nested untyped shape; we only need the AgentService
// definition from the OpenClaude v1 package, so narrow to that. The implementation
// map declares the method names; ServiceDefinition<T> requires T to be a record
// keyed by method name.
const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as unknown as {
  openclaude: {
    v1: {
      AgentService: { service: grpc.ServiceDefinition<{ Chat: never }> }
    }
  }
}
const openclaudeProto = protoDescriptor.openclaude.v1

// Shape of a single client message on the duplex Chat stream. Matches the
// `oneof` payload in openclaude.proto (ChatRequest | ToolInput | CancelRequest).
type ClientMessage = {
  request?: {
    session_id?: unknown
    message?: unknown
    working_directory?: unknown
    model?: unknown
  } | null
  input?: { prompt_id?: unknown; reply?: unknown } | null
  cancel?: unknown
}

const MAX_SESSIONS = 1000

type TextDeltaEvent = {
  type: 'content_block_delta'
  delta: {
    type: 'text_delta'
    text: string
  }
}

type TextContentBlock = {
  type: 'text'
  text: string
}

type ToolResultContentBlock = TextContentBlock | Record<string, unknown>

type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content?: string | ToolResultContentBlock[]
  is_error?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function isTextDeltaEvent(event: Record<string, unknown>): event is TextDeltaEvent {
  if (event.type !== 'content_block_delta' || !isRecord(event.delta)) {
    return false
  }

  return event.delta.type === 'text_delta' && typeof event.delta.text === 'string'
}

function isToolResultBlock(block: unknown): block is ToolResultBlock {
  return (
    isRecord(block) &&
    block.type === 'tool_result' &&
    typeof block.tool_use_id === 'string'
  )
}

function isTextContentBlock(block: unknown): block is TextContentBlock {
  return isRecord(block) && block.type === 'text' && typeof block.text === 'string'
}

function toolResultContentToString(content: ToolResultBlock['content']): string {
  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content.map(block => (isTextContentBlock(block) ? block.text : '')).join('\n')
  }

  return ''
}

export class GrpcServer {
  private server: grpc.Server
  private sessions: Map<string, Message[]> = new Map()

  constructor() {
    this.server = new grpc.Server()
    this.server.addService(openclaudeProto.AgentService.service, {
      Chat: this.handleChat.bind(this),
    })
  }

  start(port: number = 50051, host: string = 'localhost') {
    this.server.bindAsync(
      `${host}:${port}`,
      grpc.ServerCredentials.createInsecure(),
      (error, boundPort) => {
        if (error) {
          console.error('Failed to start gRPC server')
          return
        }
        console.log(`gRPC Server running at ${host}:${boundPort}`)
      }
    )
  }

  private handleChat(call: grpc.ServerDuplexStream<ClientMessage, unknown>) {
    let engine: QueryEngine | null = null
    let appState: AppState = getDefaultAppState()
    const fileCache: FileStateCache = new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024)

    // To handle ActionRequired (ask user for permission)
    const pendingRequests = new Map<string, (reply: string) => void>()

    // Accumulated messages from previous turns for multi-turn context
    let previousMessages: Message[] = []
    let sessionId = ''
    let interrupted = false

    call.on('data', async (clientMessage) => {
      try {
        if (clientMessage.request) {
          if (engine) {
            call.write({
              error: {
                message: 'A request is already in progress on this stream',
                code: 'ALREADY_EXISTS'
              }
            })
            return
          }
          interrupted = false
          const req = clientMessage.request
          sessionId = req.session_id || ''
          previousMessages = []

          // Load previous messages from session store (cross-stream persistence)
          if (sessionId && this.sessions.has(sessionId)) {
            previousMessages = [...this.sessions.get(sessionId)!]
          }

          const toolNameById = new Map<string, string>()

          engine = new QueryEngine({
            cwd: req.working_directory || process.cwd(),
            tools: getTools(appState.toolPermissionContext), // Gets all available tools
            commands: [], // Slash commands
            mcpClients: [],
            // Register OpenClaude's built-in agents (general-purpose,
            // statusline-setup, optional code-guide). Without this the Agent
            // tool throws "Agent type 'general-purpose' not found" the moment
            // the model tries to spawn a subagent for investigation.
            agents: getBuiltInAgents(),
            ...(previousMessages.length > 0 ? { initialMessages: previousMessages } : {}),
            includePartialMessages: true,
            canUseTool: async (tool, input, context, assistantMsg, toolUseID) => {
              if (toolUseID) {
                toolNameById.set(toolUseID, tool.name)
              }
              // Notify client of the tool call first
              call.write({
                tool_start: {
                  tool_name: tool.name,
                  arguments_json: JSON.stringify(input),
                  tool_use_id: toolUseID
                }
              })

              // Ask user for permission
              const promptId = randomUUID()
              const question = `Approve ${tool.name}?`
              call.write({
                action_required: {
                  prompt_id: promptId,
                  question,
                  type: 'CONFIRM_COMMAND'
                }
              })

              return new Promise((resolve) => {
                pendingRequests.set(promptId, (reply) => {
                  if (reply.toLowerCase() === 'yes' || reply.toLowerCase() === 'y') {
                    resolve({ behavior: 'allow' })
                  } else {
                    resolve({
                      behavior: 'deny',
                      message: 'User denied via gRPC',
                      decisionReason: {
                        type: 'other',
                        reason: 'User denied via gRPC',
                      },
                    })
                  }
                })
              })
            },
            getAppState: () => appState,
            setAppState: (updater) => { appState = updater(appState) },
            readFileCache: fileCache,
            userSpecifiedModel: req.model,
            fallbackModel: req.model,
          })

          // Track accumulated response data for FinalResponse
          let fullText = ''
          let promptTokens = 0
          let completionTokens = 0

          const generator = engine.submitMessage(req.message)

          for await (const msg of generator) {
            if (msg.type === 'stream_event') {
              if (isTextDeltaEvent(msg.event)) {
                call.write({
                  text_chunk: {
                    text: msg.event.delta.text
                  }
                })
                fullText += msg.event.delta.text
              }
            } else if (msg.type === 'user') {
              // Extract tool results
              const content = msg.message.content
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (isToolResultBlock(block)) {
                    const outputStr = toolResultContentToString(block.content)
                    call.write({
                      tool_result: {
                        tool_name: toolNameById.get(block.tool_use_id) ?? block.tool_use_id,
                        tool_use_id: block.tool_use_id,
                        output: outputStr,
                        is_error: block.is_error || false
                      }
                    })
                  }
                }
              }
            } else if (msg.type === 'result') {
              // Extract real token counts and final text from the result
              if (msg.subtype === 'success') {
                if (msg.result) {
                  fullText = msg.result
                }
                promptTokens = msg.usage?.input_tokens ?? 0
                completionTokens = msg.usage?.output_tokens ?? 0
              }
            }
          }

          if (!interrupted) {
            // Save messages for multi-turn context in subsequent requests
            previousMessages = [...engine.getMessages()]

            // Persist to session store for cross-stream resumption
            if (sessionId) {
              if (!this.sessions.has(sessionId) && this.sessions.size >= MAX_SESSIONS) {
                // Evict oldest session (Map preserves insertion order)
                const oldestSessionId = this.sessions.keys().next().value
                if (oldestSessionId !== undefined) {
                  this.sessions.delete(oldestSessionId)
                }
              }
              this.sessions.set(sessionId, previousMessages)
            }

            call.write({
              done: {
                full_text: fullText,
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens
              }
            })
          }

          engine = null

        } else if (clientMessage.input) {
          const promptId = clientMessage.input.prompt_id
          const reply = clientMessage.input.reply
          if (pendingRequests.has(promptId)) {
            pendingRequests.get(promptId)!(reply)
            pendingRequests.delete(promptId)
          }
        } else if (clientMessage.cancel) {
          interrupted = true
          if (engine) {
            engine.interrupt('grpc_cancel')
          }
          call.end()
        }
      } catch (err) {
        console.error('Error processing stream')
        call.write({
          error: {
            message: err instanceof Error ? err.message : "Internal server error",
            code: "INTERNAL"
          }
        })
        call.end()
      }
    })

    call.on('end', () => {
      interrupted = true
      // Unblock any pending permission prompts so canUseTool can return
      for (const resolve of pendingRequests.values()) {
        resolve('no')
      }
      if (engine) {
        engine.interrupt('grpc_stream_end')
      }
      engine = null
      pendingRequests.clear()
    })
  }
}
