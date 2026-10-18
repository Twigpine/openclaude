// Type declarations for @twigpine/openclaude SDK
// Manually maintained — keep in sync with src/entrypoints/sdk/index.ts
// Drift is caught by validate-externals.ts (runs in CI)

// ============================================================================
// Error
// ============================================================================

export class AbortError extends Error {
  override readonly name: 'AbortError'
}

export class ClaudeError extends Error {
  constructor(message: string)
}

export class SDKError extends ClaudeError {
  constructor(message: string)
}

export class SDKAuthenticationError extends SDKError {
  constructor(message?: string)
}

export class SDKBillingError extends SDKError {
  constructor(message?: string)
}

export class SDKRateLimitError extends SDKError {
  readonly resetsAt?: number
  readonly rateLimitType?: string
  constructor(message?: string, resetsAt?: number, rateLimitType?: string)
}

export class SDKInvalidRequestError extends SDKError {
  constructor(message?: string)
}

export class SDKServerError extends SDKError {
  constructor(message?: string)
}

export class SDKMaxOutputTokensError extends SDKError {
  constructor(message?: string)
}

export type SDKAssistantMessageError =
  | 'authentication_failed'
  | 'billing_error'
  | 'rate_limit'
  | 'invalid_request'
  | 'server_error'
  | 'unknown'
  | 'max_output_tokens'

export function sdkErrorFromType(
  errorType: SDKAssistantMessageError,
  message?: string,
): SDKError | ClaudeError

// ============================================================================
// Types
// ============================================================================

export type ApiKeySource = 'user' | 'project' | 'org' | 'temporary' | 'oauth' | 'none'

export type RewindFilesResult = {
  canRewind: boolean
  error?: string
  filesChanged?: string[]
  insertions?: number
  deletions?: number
}

export type McpServerStatus = {
  name: string
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  serverInfo?: { name: string; version: string }
  error?: string
  scope?: string
  tools?: {
    name: string
    description?: string
    annotations?: {
      readOnly?: boolean
      destructive?: boolean
      openWorld?: boolean
    }
  }[]
}

export type PermissionResult = ({
  behavior: 'allow'
  updatedInput?: Record<string, unknown>
  updatedPermissions?: ({
    type: 'addRules'
    rules: { toolName: string; ruleContent?: string }[]
    behavior: 'allow' | 'deny' | 'ask'
    destination: 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg'
  }) | ({
    type: 'replaceRules'
    rules: { toolName: string; ruleContent?: string }[]
    behavior: 'allow' | 'deny' | 'ask'
    destination: 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg'
  }) | ({
    type: 'removeRules'
    rules: { toolName: string; ruleContent?: string }[]
    behavior: 'allow' | 'deny' | 'ask'
    destination: 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg'
  }) | ({
    type: 'setMode'
    mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'fullAccess' | 'plan' | 'dontAsk'
    destination: 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg'
  }) | ({
    type: 'addDirectories'
    directories: string[]
    destination: 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg'
  }) | ({
    type: 'removeDirectories'
    directories: string[]
    destination: 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg'
  })[]
  toolUseID?: string
  decisionClassification?: 'user_temporary' | 'user_permanent' | 'user_reject'
}) | ({
  behavior: 'deny'
  message: string
  interrupt?: boolean
  toolUseID?: string
  decisionClassification?: 'user_temporary' | 'user_permanent' | 'user_reject'
})

export type SDKSessionInfo = {
  sessionId: string
  summary: string
  lastModified: number
  fileSize?: number
  customTitle?: string
  firstPrompt?: string
  gitBranch?: string
  cwd?: string
  tag?: string
  createdAt?: number
}

export type ListSessionsOptions = {
  dir?: string
  limit?: number
  offset?: number
  includeWorktrees?: boolean
}

export type GetSessionInfoOptions = {
  dir?: string
}

export type GetSessionMessagesOptions = {
  dir?: string
  limit?: number
  offset?: number
  includeSystemMessages?: boolean
}

export type SessionMutationOptions = {
  dir?: string
}

export type ForkSessionOptions = {
  dir?: string
  upToMessageId?: string
  title?: string
}

export type ForkSessionResult = {
  sessionId: string
}

export type SessionMessage = {
  role: 'user' | 'assistant' | 'system'
  content: unknown
  timestamp?: string
  uuid?: string
  parentUuid?: string | null
  [key: string]: unknown
}

// Re-export precise SDK message types from generated types
// These use camelCase field names and discriminated unions for full IntelliSense
// Note: ToolAnnotations and CallToolResult shapes mirror the MCP SDK but are
// declared locally to keep the public SDK declarations free of the optional
// `@modelcontextprotocol/sdk` peer dependency. They are stable SDK shapes.
type ToolAnnotations = {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}
type CallToolResult = {
  content?: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | { type: 'resource'; resource: { uri: string; text?: string; mimeType?: string } }
    | { type: string; [key: string]: unknown }
  >
  isError?: boolean
  [key: string]: unknown
}
import type {
  AccountInfo,
  AgentInfo,
  FastModeState,
  ModelInfo,
  SlashCommand,
  SDKMessage,
  SDKUserMessage,
  SDKResultMessage,
} from './sdk/coreTypes.generated.js'

export type {
  AccountInfo,
  AgentInfo,
  FastModeState,
  ModelInfo,
  SlashCommand,
  SDKMessage,
  SDKUserMessage,
  SDKResultMessage,
} from './sdk/coreTypes.generated.js'

export type SDKControlInitializeResponse = {
  commands: SlashCommand[]
  agents: AgentInfo[]
  output_style: string
  available_output_styles: string[]
  models: ModelInfo[]
  account: AccountInfo
  /** @internal CLI process PID for tmux socket isolation. */
  pid?: number
  fast_mode_state?: FastModeState
}

// ============================================================================
// Query types
// ============================================================================

export type QueryPermissionMode =
  | 'default'
  | 'plan'
  | 'auto-accept'
  | 'bypass-permissions'
  | 'bypassPermissions'
  | 'full-access'
  | 'fullAccess'
  | 'acceptEdits'

export type QueryOptions = {
  cwd: string
  additionalDirectories?: string[]
  model?: string
  sessionId?: string
  /** Fork the session before resuming (requires sessionId). */
  fork?: boolean
  /** Alias for fork. When true, resumed session forks to a new session ID. */
  forkSession?: boolean
  /** Resume the most recent session for this cwd (no sessionId needed). */
  continue?: boolean
  resume?: string
  /** When resuming, resume messages up to and including this message UUID. */
  resumeSessionAt?: string
  permissionMode?: QueryPermissionMode
  abortController?: AbortController
  executable?: string
  allowDangerouslySkipPermissions?: boolean
  disallowedTools?: string[]
  hooks?: Record<string, unknown[]>
  mcpServers?: Record<string, unknown>
  settings?: {
    env?: Record<string, string>
    attribution?: { commit: string; pr: string }
  }
  /** Environment variables to apply during query execution. Overrides process.env. Takes precedence over settings.env. */
  env?: Record<string, string | undefined>
  /**
   * Callback invoked before each tool use. Return `{ behavior: 'allow' }` to
   * permit the call or `{ behavior: 'deny', message?: string }` to reject it.
   *
   * **Secure-by-default**: If neither `canUseTool` nor `onPermissionRequest`
   * is provided, ALL tool uses are denied. You MUST provide at least one of
   * these callbacks to allow tool execution.
   */
  canUseTool?: (
    name: string,
    input: unknown,
    options?: { toolUseID?: string },
  ) => Promise<{ behavior: 'allow' | 'deny'; message?: string; updatedInput?: unknown }>
  /**
   * Callback invoked when a tool needs permission approval. The host receives
   * the request immediately and can resolve it by calling
   * `query.respondToPermission(toolUseId, decision)` before the timeout.
   * If omitted, tools that require permission fall through to the default
   * permission logic immediately (no timeout).
   */
  onPermissionRequest?: (message: SDKPermissionRequestMessage) => void
  systemPrompt?:
    | string
    | { type: 'preset'; preset: string; append?: string }
    | { type: 'custom'; content: string }
  /** Agent definitions to register with the query engine. */
  agents?: Record<string, {
    description?: string
    prompt: string
    /**
     * Tool allowlist for this agent. If omitted or set to ['*'], the agent can use
     * all tools available to subagents after disallowedTools is applied.
     */
    tools?: string[]
    /** Tool denylist for this agent. Deny entries always override tools entries. */
    disallowedTools?: string[]
    model?: string
    maxTurns?: number
    maxSteps?: number
  }>
  settingSources?: string[]
  /** When true, yields stream_event messages for token-by-token streaming. */
  includePartialMessages?: boolean
  /** @internal Timeout in ms for permission request resolution. Default 30000. */
  _permissionTimeoutMs?: number
  stderr?: (data: string) => void
}

export interface Query {
  readonly sessionId: string
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage>
  setModel(model: string): Promise<void>
  setPermissionMode(mode: QueryPermissionMode): Promise<void>
  close(): void
  interrupt(): void
  respondToPermission(toolUseId: string, decision: PermissionResult): void
  /** Check if file rewind is possible. */
  rewindFiles(): RewindFilesResult
  /** Actually perform the file rewind. Returns files changed and diff stats. */
  rewindFilesAsync(): Promise<RewindFilesResult>
  supportedCommands(): string[]
  supportedModels(): string[]
  supportedAgents(): string[]
  mcpServerStatus(): McpServerStatus[]
  accountInfo(): Promise<{ apiKeySource: ApiKeySource; [key: string]: unknown }>
  setMaxThinkingTokens(tokens: number): void
}

/**
 * Permission request message emitted when a tool needs permission approval.
 * Hosts can respond via respondToPermission() using the request_id.
 */
export type SDKPermissionRequestMessage = {
  type: 'permission_request'
  request_id: string
  tool_name: string
  tool_use_id: string
  input: Record<string, unknown>
  uuid: string
  session_id: string
}

export type SDKPermissionTimeoutMessage = {
  type: 'permission_timeout'
  tool_name: string
  tool_use_id: string
  timed_out_after_ms: number
  uuid: string
  session_id: string
}

/**
 * A message emitted when agent definitions fail to load.
 * This allows hosts to detect configuration issues that would otherwise
 * be silently logged to console.warn.
 *
 * Note: Agent load failures are non-fatal — the query continues without agents.
 */
export type SDKAgentLoadFailureMessage = {
  type: 'agent_load_failure'
  stage: 'definitions' | 'injection'
  error_message: string
}

// ============================================================================
// Permission resolve decision (SDK-specific)
// ============================================================================

/**
 * Decision returned by permission resolution.
 * Used by respondToPermission() and internal permission handling.
 */
export type PermissionResolveDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string; decisionReason: { type: 'mode'; mode: string } }

// ============================================================================
// V2 API types
// ============================================================================

export type SDKSessionOptions = {
  cwd: string
  model?: string
  permissionMode?: QueryPermissionMode
  allowDangerouslySkipPermissions?: boolean
  abortController?: AbortController
  /**
   * Callback invoked before each tool use. Return `{ behavior: 'allow' }` to
   * permit the call or `{ behavior: 'deny', message?: string }` to reject it.
   *
   * **Secure-by-default**: If neither `canUseTool` nor `onPermissionRequest`
   * is provided, ALL tool uses are denied. You MUST provide at least one of
   * these callbacks to allow tool execution.
   */
  canUseTool?: (
    name: string,
    input: unknown,
    options?: { toolUseID?: string },
  ) => Promise<{ behavior: 'allow' | 'deny'; message?: string; updatedInput?: unknown }>
  /** MCP server configurations for this session. */
  mcpServers?: Record<string, unknown>
  /**
   * Callback invoked when a tool needs permission approval. The host receives
   * the request immediately and can resolve it via respondToPermission().
   */
  onPermissionRequest?: (message: SDKPermissionRequestMessage) => void
  /** Tools to disallow (blanket deny by tool name). */
  disallowedTools?: string[]
  /** Agent definitions to register with the session engine. */
  agents?: Record<string, {
    description?: string
    prompt: string
    /**
     * Tool allowlist for this agent. If omitted or set to ['*'], the agent can use
     * all tools available to subagents after disallowedTools is applied.
     */
    tools?: string[]
    /** Tool denylist for this agent. Deny entries always override tools entries. */
    disallowedTools?: string[]
    model?: string
    maxTurns?: number
    maxSteps?: number
  }>
}

export interface SDKSession {
  sessionId: string
  sendMessage(content: string): AsyncIterable<SDKMessage>
  getMessages(): SDKMessage[]
  interrupt(): void
  /** Close the session and release resources (MCP connections, etc.). */
  close(): void
  /** Respond to a pending permission prompt. */
  respondToPermission(toolUseId: string, decision: PermissionResult): void
}

// ============================================================================
// MCP tool types
// ============================================================================

export interface SdkMcpToolDefinition<Schema = unknown> {
  name: string
  description: string
  inputSchema: Schema
  handler: (args: any, extra: unknown) => Promise<CallToolResult>
  annotations?: ToolAnnotations
  searchHint?: string
  alwaysLoad?: boolean
}

// ============================================================================
// Session functions
// ============================================================================

export function listSessions(
  options?: ListSessionsOptions,
): Promise<SDKSessionInfo[]>

export function getSessionInfo(
  sessionId: string,
  options?: GetSessionInfoOptions,
): Promise<SDKSessionInfo | undefined>

export function getSessionMessages(
  sessionId: string,
  options?: GetSessionMessagesOptions,
): Promise<SessionMessage[]>

export function renameSession(
  sessionId: string,
  title: string,
  options?: SessionMutationOptions,
): Promise<void>

export function tagSession(
  sessionId: string,
  tag: string | null,
  options?: SessionMutationOptions,
): Promise<void>

export function forkSession(
  sessionId: string,
  options?: ForkSessionOptions,
): Promise<ForkSessionResult>

export function deleteSession(
  sessionId: string,
  options?: SessionMutationOptions,
): Promise<void>

// ============================================================================
// Query functions
// ============================================================================

export function query(params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: QueryOptions
}): Query

export function queryAsync(params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: QueryOptions
}): Promise<Query>

// ============================================================================
// V2 API functions
// ============================================================================

export function unstable_v2_createSession(options: SDKSessionOptions): SDKSession

export function unstable_v2_resumeSession(
  sessionId: string,
  options: SDKSessionOptions,
): Promise<SDKSession>

export function unstable_v2_prompt(
  message: string,
  options: SDKSessionOptions,
): Promise<SDKResultMessage>

// ============================================================================
// MCP tool functions
// ============================================================================

export function tool<Schema = unknown>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: any, extra: unknown) => Promise<CallToolResult>,
  extras?: {
    annotations?: ToolAnnotations
    searchHint?: string
    alwaysLoad?: boolean
  },
): SdkMcpToolDefinition<Schema>

/**
 * MCP server transport configuration types.
 * Matches McpServerConfigForProcessTransport from coreTypes.generated.ts.
 */
export type SdkMcpStdioConfig = {
  type?: "stdio"
  command: string
  args?: string[]
  env?: Record<string, string>
}

export type SdkMcpSSEConfig = {
  type: "sse"
  url: string
  headers?: Record<string, string>
}

export type SdkMcpHttpConfig = {
  type: "http"
  url: string
  headers?: Record<string, string>
}

export type SdkMcpSdkConfig = {
  type: "sdk"
  name: string
  /** In-process tool definitions created via the tool() helper. */
  tools?: SdkMcpToolDefinition[]
}

export type SdkMcpServerConfig = SdkMcpStdioConfig | SdkMcpSSEConfig | SdkMcpHttpConfig | SdkMcpSdkConfig

/**
 * Scoped MCP server config with session scope.
 * Returned by createSdkMcpServer() for use with mcpServers option.
 */
export type SdkScopedMcpServerConfig = SdkMcpServerConfig & {
  scope: "session"
}

/**
 * Wraps an MCP server configuration for use with the SDK.
 * Adds the 'session' scope marker so the SDK knows this server
 * should be connected per-session (not globally).
 *
 * @param config - MCP server config (stdio, sse, http, or sdk type)
 * @returns Scoped config with scope: 'session' added
 *
 * @example
 * ```typescript
 * const server = createSdkMcpServer({
 *   type: 'stdio',
 *   command: 'npx',
 *   args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
 * })
 * const session = unstable_v2_createSession({
 *   cwd: '/my/project',
 *   mcpServers: { 'fs': server },
 * })
 * ```
 */
export function createSdkMcpServer(config: SdkMcpServerConfig): SdkScopedMcpServerConfig
