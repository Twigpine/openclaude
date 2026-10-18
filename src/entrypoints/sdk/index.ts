/**
 * SDK entry point — session management functions and query().
 *
 * This file is the barrel module for the SDK. It re-exports everything from
 * the sub-modules and runs stub leak detection at module load time.
 *
 * The SDK is bundled as `dist/sdk.mjs` separately from the CLI.
 * It must NOT import React, Ink, or any CLI/TUI code.
 */

import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { QueryEngine } from '../../QueryEngine.js'
import { getTools } from '../../tools.js'
import { init } from '../init.js'
import {
  checkCriticalImportsForStubs,
  safelyAccess,
  type CriticalImport,
} from './stubLeakDetection.js'

// ============================================================================
// Stub leak detection
// ============================================================================

/**
 * One-time check that detects TUI/CLI component stubs leaking into the SDK
 * runtime. The esbuild sdk-missing-stub plugin marks every stub with
 * `__stub: true`. We check core SDK modules that should NEVER be stubs.
 * If any resolved to a stub, it means a TUI dependency leaked through.
 *
 * Each access is wrapped in a TDZ-safe getter so a circular import that
 * leaves one binding uninitialized at the moment we run cannot crash the
 * whole detector (#1287 — `npm run dev:grpc` tripped the check at
 * `QueryEngine` via a TDZ ReferenceError from the script's import order).
 * TDZ is a separate bug class than stub-leak: an uninitialized binding
 * can't carry `__stub: true`, so the access failure is treated as "nothing
 * to check here". Real stub leaks still throw the explicit SDK init error.
 *
 * The detection primitives live in ./stubLeakDetection so the real path can
 * be unit-tested directly (see tests/sdk/stub-leak-detect.test.ts).
 */
function detectStubLeaks(): void {
  const criticalImports: CriticalImport[] = [
    // QueryEngine is the core SDK engine — must never be a stub
    {
      name: 'QueryEngine',
      get: () =>
        safelyAccess(() => QueryEngine as unknown as Record<string, unknown>),
    },
    // These are imported by this file and must be real modules, not stubs
    {
      name: 'getTools',
      get: () =>
        safelyAccess(() => getTools as unknown as Record<string, unknown>),
    },
    {
      name: 'init',
      get: () => safelyAccess(() => init as unknown as Record<string, unknown>),
    },
  ]

  checkCriticalImportsForStubs(criticalImports)
}

// Run leak detection on the next microtask so every same-tick module init
// (including circular-dep neighbors like scripts/start-grpc.ts → SDK index
// → QueryEngine → ... → SDK index) completes before we read the bindings.
// Module-load-time invocation would race the binding initialization order
// and surface as a TDZ ReferenceError (#1287). The safelyAccess wrapper
// inside detectStubLeaks belt-and-braces this for any remaining cycles.
queueMicrotask(detectStubLeaks)

// ============================================================================
// Re-exports from shared types
// ============================================================================

export type {
  SDKMessage,
  SDKUserMessage,
  SDKSessionInfo,
  ListSessionsOptions,
  GetSessionInfoOptions,
  GetSessionMessagesOptions,
  SessionMutationOptions,
  ForkSessionOptions,
  ForkSessionResult,
  SessionMessage,
  SDKPermissionRequestMessage,
  SDKPermissionTimeoutMessage,
  SDKAgentLoadFailureMessage,
  QueryPermissionMode,
} from './shared.js'
export type {
  AccountInfo,
  AgentInfo,
  FastModeState,
  ModelInfo,
  SlashCommand,
} from './coreTypes.js'
export type { SDKControlInitializeResponse } from './controlTypes.js'

// ============================================================================
// Re-exports from permissions
// ============================================================================

export type { PermissionResolveDecision } from './permissions.js'

// ============================================================================
// Re-exports from sessions
// ============================================================================

export {
  listSessions,
  getSessionInfo,
  getSessionMessages,
  renameSession,
  tagSession,
  deleteSession,
  forkSession,
} from './sessions.js'

// ============================================================================
// Re-exports from query
// ============================================================================

export type { QueryOptions } from './query.js'
export { query, queryAsync } from './query.js'
export type { Query } from './query.js'

// ============================================================================
// Re-exports from v2
// ============================================================================

export type {
  SDKSessionOptions,
  SDKResultMessage,
} from './v2.js'
export type { SDKSession } from './v2.js'
export type { SdkMcpToolDefinition } from './v2.js'
export {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  unstable_v2_prompt,
} from './v2.js'

// ============================================================================
// tool() — factory function for creating MCP tool definitions
// ============================================================================

/**
 * Create a tool definition that can be passed to `createSdkMcpServer()`.
 *
 * @param name - Tool name (must be unique within the server)
 * @param description - Human-readable description of what the tool does
 * @param inputSchema - Zod raw shape or JSON Schema describing the input
 * @param handler - Async function that handles tool invocations
 * @param extras - Optional annotations, search hint, and alwaysLoad flag
 *
 * @example
 * ```typescript
 * const myTool = tool(
 *   'read_file',
 *   'Read a file from disk',
 *   { path: z.string() },
 *   async (args) => ({
 *     content: [{ type: 'text', text: await fs.readFile(args.path, 'utf8') }],
 *   }),
 * )
 * ```
 */
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
): import('./v2.js').SdkMcpToolDefinition<Schema> {
  return {
    name,
    description,
    inputSchema,
    handler,
    annotations: extras?.annotations,
    searchHint: extras?.searchHint,
    alwaysLoad: extras?.alwaysLoad,
  }
}

// ============================================================================
// Public MCP config types — mirror sdk.d.ts declarations
// ============================================================================

export type SdkMcpStdioConfig = {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
}

export type SdkMcpSSEConfig = {
  type: 'sse'
  url: string
  headers?: Record<string, string>
}

export type SdkMcpHttpConfig = {
  type: 'http'
  url: string
  headers?: Record<string, string>
}

export type SdkMcpSdkConfig = {
  type: 'sdk'
  name: string
  /** In-process tool definitions created via the tool() helper. */
  tools?: import('./v2.js').SdkMcpToolDefinition[]
}

export type SdkMcpServerConfig = SdkMcpStdioConfig | SdkMcpSSEConfig | SdkMcpHttpConfig | SdkMcpSdkConfig

export type SdkScopedMcpServerConfig = SdkMcpServerConfig & {
  scope: 'session'
}

// ============================================================================
// createSdkMcpServer() — stub that returns a config object
// ============================================================================

/**
 * Wraps an MCP server configuration for use with the SDK.
 * Adds the 'session' scope marker so the SDK knows this server
 * should be connected per-session (not globally).
 *
 * The `config` parameter must be a valid MCP server config with a
 * transport type and its required fields:
 * - stdio: `{ type: 'stdio', command: '...', args: [...] }`
 * - sse:   `{ type: 'sse', url: '...' }`
 * - http:  `{ type: 'http', url: '...' }`
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
export function createSdkMcpServer(config: SdkMcpServerConfig): SdkScopedMcpServerConfig {
  return {
    ...config,
    scope: 'session' as const,
  }
}

// ============================================================================
// Re-exports — error classes and helpers
// ============================================================================

export {
  AbortError,
  ClaudeError,
  SDKError,
  SDKAuthenticationError,
  SDKBillingError,
  SDKRateLimitError,
  SDKInvalidRequestError,
  SDKServerError,
  SDKMaxOutputTokensError,
  sdkErrorFromType,
} from '../../utils/errors.js'

export type { SDKAssistantMessageError } from '../../utils/errors.js'

export type {
  RewindFilesResult,
  McpServerStatus,
  ApiKeySource,
  PermissionResult,
} from './coreTypes.generated.js'
