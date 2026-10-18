/**
 * Permission handling for the SDK.
 *
 * Provides canUseTool wrappers, permission context building,
 * MCP server connection, and default permission-denying logic.
 *
 * @internal — these utilities are not part of the public SDK API.
 */

import { randomUUID } from 'crypto'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { PermissionDecision, PermissionMode } from '../../types/permissions.js'
import {
  hasPermissionsToUseTool,
  revalidatePlanModePermissionAllowWithRaceGuard,
} from '../../utils/permissions/permissions.js'
import {
  getEmptyToolPermissionContext,
  type ToolPermissionContext,
  type Tool,
} from '../../Tool.js'
import { MCPTool } from '../../tools/MCPTool/MCPTool.js'
import type { MCPServerConnection, ScopedMcpServerConfig } from '../../services/mcp/types.js'
import { connectToServer, fetchToolsForClient } from '../../services/mcp/client.js'
import type {
  QueryPermissionMode,
  CanUseToolCallback,
  SDKPermissionRequestMessage,
  SDKPermissionTimeoutMessage,
} from './shared.js'

// ============================================================================
// Constants
// ============================================================================

/** Default timeout for permission prompts (30 seconds). Reasonable for human response time. */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 30000

/**
 * Placeholder session_id for permission requests outside SDK session context.
 * Used when createExternalCanUseTool is called without a sessionId parameter,
 * indicating a standalone permission prompt (e.g., direct tool permission check
 * without an active SDK session). Hosts can identify such requests by checking
 * session_id === NO_SESSION_PLACEHOLDER.
 */
export const NO_SESSION_PLACEHOLDER = 'no-session'

// ============================================================================
// Logger interface for SDK surface
// ============================================================================

/**
 * Logger interface for SDK permission system.
 * Hosts can inject a custom logger to control warning output.
 * Defaults to console.warn if no logger is provided.
 */
export interface SDKLogger {
  warn(message: string): void
}

/** Default console-based logger used when no custom logger is provided. */
const defaultLogger: SDKLogger = {
  warn: (message: string) => console.warn(message),
}

// ============================================================================
// Once-only resolve wrapper
// ============================================================================

/**
 * Creates a resolve function that can only be called once.
 * Prevents promise twice-resolve race conditions when timeout
 * and host response happen simultaneously.
 */
export function createOnceOnlyResolve<T>(
  resolve: (value: T) => void,
): (value: T) => void {
  let resolved = false
  return (value: T) => {
    if (!resolved) {
      resolved = true
      resolve(value)
    }
  }
}

// ============================================================================
// Permission target factory (for race condition safety)
// ============================================================================

/**
 * Factory for creating a permissionTarget with proper race condition handling.
 * The once-only resolve wrapper is applied at registration time, ensuring
 * both timeout handler and host response use the same wrapped resolve.
 *
 * Usage:
 * ```typescript
 * const permissionTarget = createPermissionTarget()
 * const canUseTool = createExternalCanUseTool(
 *   undefined,
 *   fallback,
 *   permissionTarget,
 *   onPermissionRequest,
 *   onTimeout
 * )
 * ```
 */
// ============================================================================
// Permission resolve decision type
// ============================================================================

export type PermissionResolveDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string; decisionReason: { type: 'mode'; mode: string } }

// ============================================================================
// PermissionTarget interface
// ============================================================================

/**
 * Interface for objects that can register and resolve pending permission prompts.
 * Used by createExternalCanUseTool to interact with QueryImpl and SDKSessionImpl
 * without exposing internal pendingPermissionPrompts map.
 */
export interface PermissionTarget {
  registerPendingPermission(toolUseId: string): Promise<PermissionResolveDecision>
  deletePendingPermission(toolUseId: string): void
  denyPendingPermission(toolUseId: string, message: string): void
}

export function createPermissionTarget(): PermissionTarget & { pendingPermissionPrompts: Map<string, { resolve: (decision: PermissionResolveDecision) => void }> } {
  const pendingPermissionPrompts = new Map<string, { resolve: (decision: PermissionResolveDecision) => void }>()

  const registerPendingPermission = (toolUseId: string): Promise<PermissionResolveDecision> => {
    return new Promise(resolve => {
      // Apply onceOnlyResolve at registration time - this ensures both
      // timeout handler and host response use the same wrapped resolve,
      // preventing "promise already resolved" errors
      const wrappedResolve = createOnceOnlyResolve(resolve)
      pendingPermissionPrompts.set(toolUseId, { resolve: wrappedResolve })
    })
  }

  const deletePendingPermission = (toolUseId: string): void => {
    pendingPermissionPrompts.delete(toolUseId)
  }

  const denyPendingPermission = (toolUseId: string, message: string): void => {
    const pending = pendingPermissionPrompts.get(toolUseId)
    if (pending) {
      pending.resolve({
        behavior: 'deny',
        message,
        decisionReason: { type: 'mode', mode: 'default' },
      })
      pendingPermissionPrompts.delete(toolUseId)
    }
  }

  return {
    registerPendingPermission,
    deletePendingPermission,
    denyPendingPermission,
    pendingPermissionPrompts,
  }
}

// ============================================================================
// buildPermissionContext
// ============================================================================

export interface PermissionContextOptions {
  cwd: string
  permissionMode?: QueryPermissionMode
  additionalDirectories?: string[]
  allowDangerouslySkipPermissions?: boolean
  disallowedTools?: string[]
}

function isDangerousPermissionMode(
  mode: QueryPermissionMode | undefined,
): mode is
  | 'bypass-permissions'
  | 'bypassPermissions'
  | 'full-access'
  | 'fullAccess' {
  return (
    mode === 'bypass-permissions' ||
    mode === 'bypassPermissions' ||
    mode === 'full-access' ||
    mode === 'fullAccess'
  )
}

export function buildPermissionContext(options: PermissionContextOptions): ToolPermissionContext {
  const base: ToolPermissionContext = getEmptyToolPermissionContext()
  const mode = options.permissionMode ?? 'default'

  if (
    isDangerousPermissionMode(mode) &&
    options.allowDangerouslySkipPermissions !== true
  ) {
    throw new Error(
      `SDK permissionMode "${mode}" requires allowDangerouslySkipPermissions: true`,
    )
  }

  // Map SDK permission mode to internal PermissionMode
  let internalMode: string = 'default'
  switch (mode) {
    case 'plan':
      internalMode = 'plan'
      break
    case 'auto-accept': // Alias for acceptEdits
    case 'acceptEdits':
      internalMode = 'acceptEdits'
      break
    case 'bypass-permissions':
    case 'bypassPermissions':
      internalMode = 'bypassPermissions'
      break
    case 'full-access':
    case 'fullAccess':
      internalMode = 'fullAccess'
      break
    default:
      internalMode = 'default'
  }

  // Wire additionalDirectories into the permission context
  if (options.additionalDirectories && options.additionalDirectories.length > 0) {
    const dirsMap = base.additionalWorkingDirectories as Map<string, unknown>
    for (const dir of options.additionalDirectories) {
      dirsMap.set(dir, true)
    }
  }

  return {
    ...base,
    mode: internalMode as ToolPermissionContext['mode'],
    isBypassPermissionsModeAvailable:
      options.allowDangerouslySkipPermissions === true,
    alwaysDenyRules: {
      ...base.alwaysDenyRules,
      cliArg: options.disallowedTools ?? [],
    },
  }
}

// ============================================================================
// createExternalCanUseTool
// ============================================================================

/**
 * Creates a canUseTool function that supports external permission resolution
 * via respondToPermission().
 *
 * When a user-provided canUseTool callback exists, it takes priority.
 * Otherwise, a permission_request message is emitted to the SDK stream,
 * and the host can resolve it via respondToPermission() before the timeout.
 *
 * The flow:
 * 1. QueryEngine calls canUseTool(tool, input, ..., toolUseID, forceDecision)
 * 2. If forceDecision is set, honor it immediately, except Full Access ask prompts are allowed
 * 3. If user canUseTool callback exists, delegate to it
 * 4. Otherwise, emit permission_request message and await external resolution
 *
 * For async external resolution, hosts should listen for permission_request
 * SDKMessages and call respondToPermission(). The pending prompt is registered
 * via registerPendingPermission() and awaited here.
 */
export function createExternalCanUseTool(
  userFn: CanUseToolCallback | undefined,
  fallback: CanUseToolFn,
  permissionTarget: PermissionTarget,
  onPermissionRequest?: (message: SDKPermissionRequestMessage) => void,
  onTimeout?: (message: SDKPermissionTimeoutMessage) => void,
  // Default 30 second timeout for permission prompts - reasonable for human response time
  timeoutMs: number = DEFAULT_PERMISSION_TIMEOUT_MS,
  /** Session ID or getter for dynamic resolution (e.g. () => queryImpl.sessionId for fork/continue) */
  sessionId?: string | (() => string | undefined),
  logger?: SDKLogger,
): CanUseToolFn {
  const log = logger ?? defaultLogger
  /** Resolve sessionId - call getter if provided, otherwise return static value */
  const resolveSessionId = (): string => {
    const resolved = typeof sessionId === 'function' ? sessionId() : sessionId
    return resolved ?? NO_SESSION_PLACEHOLDER
  }
  return async (tool, input, toolUseContext, assistantMessage, toolUseID, forceDecision): Promise<PermissionDecision> => {
    // Cast input to ensure type compatibility with PermissionDecision
    const typedInput = input as Record<string, unknown>
    let effectiveInput = typedInput
    const revalidateExternalAllow = async (
      originalInput: Record<string, unknown>,
      finalInput: Record<string, unknown>,
    ): Promise<PermissionDecision | null> => {
      const planModeWasActive =
        typeof toolUseContext.getAppState === 'function' &&
        toolUseContext.getAppState().toolPermissionContext.mode === 'plan'
      return await revalidatePlanModePermissionAllowWithRaceGuard(
        tool,
        originalInput,
        finalInput,
        toolUseContext,
        planModeWasActive,
      )
    }
    const isFullAccessMode =
      typeof toolUseContext.getAppState === 'function' &&
      toolUseContext.getAppState().toolPermissionContext.mode === 'fullAccess'
    if (isFullAccessMode) {
      if (forceDecision?.behavior === 'ask') {
        effectiveInput = forceDecision.updatedInput ?? typedInput
      }
      const fullAccessDecision = await hasPermissionsToUseTool(
        tool,
        effectiveInput,
        toolUseContext,
        assistantMessage,
        toolUseID,
      )
      if (fullAccessDecision.behavior === 'deny') {
        return fullAccessDecision
      }
      effectiveInput = fullAccessDecision.updatedInput ?? effectiveInput
    }

    if (forceDecision) {
      if (!(forceDecision.behavior === 'ask' && isFullAccessMode)) {
        return forceDecision
      }
    }

    // If the user provided a synchronous canUseTool callback, use it
    if (userFn) {
      try {
        const result = await userFn(tool.name, effectiveInput, { toolUseID })
        if (result.behavior === 'allow') {
          const finalInput =
            (result.updatedInput as Record<string, unknown> | undefined) ??
            effectiveInput
          const revalidation = await revalidateExternalAllow(
            effectiveInput,
            finalInput,
          )
          if (revalidation) {
            return revalidation
          }
          return { behavior: 'allow' as const, updatedInput: finalInput }
        }
        return {
          behavior: 'deny' as const,
          message: result.message ?? `Tool ${tool.name} denied by canUseTool callback`,
          decisionReason: { type: 'mode' as const, mode: 'default' },
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown callback error'
        return {
          behavior: 'deny' as const,
          message: `Tool ${tool.name} denied (callback error: ${errorMessage})`,
          decisionReason: { type: 'mode' as const, mode: 'default' },
        }
      }
    }

    // No user callback — if host registered an onPermissionRequest callback,
    // call it directly and await external resolution with timeout.
    if (toolUseID && onPermissionRequest) {
      const requestId = randomUUID()
      const messageUuid = randomUUID()

      // Register pending permission BEFORE emitting the request so that
      // a host which responds synchronously from onPermissionRequest can
      // find the entry in pendingPermissionPrompts immediately.
      const pendingPromise = permissionTarget.registerPendingPermission(toolUseID)

      // Wrap onPermissionRequest in try-catch since it's SDK-host-provided code.
      // If it throws, clean up the pending entry and deny/fallback cleanly.
      try {
        onPermissionRequest({
          type: 'permission_request',
          request_id: requestId,
          tool_name: tool.name,
          tool_use_id: toolUseID,
          input: effectiveInput,
          uuid: messageUuid,
          session_id: resolveSessionId(),
        })
      } catch (err) {
        permissionTarget.deletePendingPermission(toolUseID)
        const errorMessage = err instanceof Error ? err.message : 'Unknown host callback error'
        return {
          behavior: 'deny' as const,
          message: `Tool ${tool.name} denied (onPermissionRequest callback error: ${errorMessage})`,
          decisionReason: { type: 'mode' as const, mode: 'default' },
        }
      }

      let timeoutId: ReturnType<typeof setTimeout> | undefined
      const timeoutPromise = new Promise<{ timedOut: true }>(resolve => {
        timeoutId = setTimeout(() => resolve({ timedOut: true }), timeoutMs)
      })

      const raceResult = await Promise.race([
        pendingPromise.then(result => ({ result, timedOut: false })),
        timeoutPromise,
      ])

      if (timeoutId !== undefined) {
        clearTimeout(timeoutId)
      }

      if (!raceResult.timedOut && raceResult.result) {
        permissionTarget.deletePendingPermission(toolUseID)
        // Convert PermissionResolveDecision to PermissionDecision
        const res = raceResult.result
        if (res.behavior === 'allow') {
          const finalInput = res.updatedInput ?? effectiveInput
          const revalidation = await revalidateExternalAllow(
            effectiveInput,
            finalInput,
          )
          if (revalidation) {
            return revalidation
          }
          return { behavior: 'allow' as const, updatedInput: finalInput }
        }
        return {
          behavior: 'deny' as const,
          message: res.message,
          decisionReason: { type: 'mode' as const, mode: res.decisionReason.mode as PermissionMode },
        }
      }

      // Timeout — emit event and clean up
      if (onTimeout) {
        onTimeout({
          type: 'permission_timeout',
          tool_name: tool.name,
          tool_use_id: toolUseID,
          timed_out_after_ms: timeoutMs,
          uuid: messageUuid,
          session_id: resolveSessionId(),
        })
      }
      log.warn(
        `[SDK] Permission request for tool "${tool.name}" timed out after ${timeoutMs}ms. ` +
        'Denying by default. Provide a canUseTool callback or respond to permission_request ' +
        'messages within the timeout window.',
      )
      const timeoutMessage = `SDK: Permission resolution timed out for tool "${tool.name}". Pass canUseTool in options to control tool permissions.`
      permissionTarget.denyPendingPermission(toolUseID, timeoutMessage)
      // Return the timeout decision rather than falling through. The deny above
      // resolves the promise registered by registerPendingPermission, but the
      // race has already settled with {timedOut: true}, so nothing is awaiting
      // it -- the decision would be discarded. The fallback is
      // createDefaultCanUseTool, whose contract is "the host provided no
      // permission callback at all": it reports that as the reason the tool was
      // denied even though onPermissionRequest was wired up, and it burns the
      // one-shot warning latch so a genuinely misconfigured later query in the
      // same process is never warned.
      return {
        behavior: 'deny' as const,
        message: timeoutMessage,
        decisionReason: { type: 'mode' as const, mode: 'default' },
      }
    }

    // No callback or no toolUseID — fall through to default permission logic
    return fallback(tool, effectiveInput, toolUseContext, assistantMessage, toolUseID, forceDecision)
  }
}

// ============================================================================
// MCP server connection for SDK
// ============================================================================

/**
 * Connects to MCP servers from SDK options.
 * Takes the mcpServers config and connects to each server,
 * returning connected clients and their tools.
 *
 * @param mcpServers - MCP server configurations from SDK options
 * @returns Connected clients and their tools
 */
export async function connectSdkMcpServers(
  mcpServers: Record<string, unknown> | undefined,
): Promise<{ clients: MCPServerConnection[]; tools: Tool[] }> {
  if (!mcpServers || Object.keys(mcpServers).length === 0) {
    return { clients: [], tools: [] }
  }

  const clients: MCPServerConnection[] = []
  const tools: Tool[] = []

  // Connect to each server in parallel
  const results = await Promise.allSettled(
    Object.entries(mcpServers).map(async ([name, config]) => {
      // Validate config is a non-null object before spreading (arrays are objects but invalid for config)
      if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        return {
          client: {
            type: 'failed' as const,
            name,
            config: { scope: 'session' } as unknown as ScopedMcpServerConfig,
            error: `Invalid MCP server config for '${name}': expected object, got ${config === null ? 'null' : Array.isArray(config) ? 'array' : typeof config}`,
          },
          tools: [],
        }
      }

      // Convert SDK config to internal format with session scope
      // Note: 'session' is SDK-specific, not part of internal ConfigScope
      const scopedConfig = {
        ...(config as Record<string, unknown>),
        scope: 'session',
      } as const

      // SDK-type MCP servers (type: 'sdk') carry in-process tool definitions
      // created via the tool() helper. Convert SdkMcpToolDefinition to Tool
      // using the MCPTool pattern (spread MCPTool base + override fields).
      if ((config as Record<string, unknown>).type === 'sdk') {
        type SdkToolDef = {
          name: string
          description?: string
          inputSchema?: Record<string, unknown>
          handler?: (args: unknown, extra: unknown) => Promise<{ content: unknown }>
          annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean }
          searchHint?: string
          alwaysLoad?: boolean
        }
        const sdkConfig = config as { type: 'sdk'; name: string; tools?: SdkToolDef[] }
        const sdkToolDefs = sdkConfig.tools ?? []
        const convertedTools: Tool[] = sdkToolDefs.map(toolDef => ({
          ...MCPTool,
          name: toolDef.name,
          isMcp: true,
          searchHint: toolDef.searchHint,
          alwaysLoad: toolDef.alwaysLoad,
          async description() {
            return toolDef.description ?? ''
          },
          async prompt() {
            return toolDef.description ?? ''
          },
          inputJSONSchema: toolDef.inputSchema as Tool['inputJSONSchema'],
          isConcurrencySafe() {
            return toolDef.annotations?.readOnlyHint ?? false
          },
          isReadOnly() {
            return toolDef.annotations?.readOnlyHint ?? false
          },
          isDestructive() {
            return toolDef.annotations?.destructiveHint ?? false
          },
          isOpenWorld() {
            return toolDef.annotations?.openWorldHint ?? false
          },
          async call(args: Record<string, unknown>, context, _canUseTool, parentMessage, onProgress) {
            if (!toolDef.handler) {
              return { data: { type: 'text', text: `SDK tool ${toolDef.name} has no handler` } }
            }
            const result = await toolDef.handler(args, { context, parentMessage, onProgress })
            return { data: result.content }
          },
        }))
        return {
          client: null as unknown as MCPServerConnection,
          tools: convertedTools,
        }
      }

      try {
        // Connect to the server
        // Note: SDK 'session' scope is not part of internal ConfigScope,
        // but connectToServer accepts any object with scope field
        const client = await connectToServer(name, scopedConfig as unknown as ScopedMcpServerConfig, {
          totalServers: Object.keys(mcpServers).length,
          stdioCount: 0,
          sseCount: 0,
          httpCount: 0,
          sseIdeCount: 0,
          wsIdeCount: 0,
        })

        // If connected, fetch tools
        if (client.type === 'connected') {
          const serverTools = await fetchToolsForClient(client)
          return { client, tools: serverTools }
        }

        // Return failed/pending client with no tools
        return { client, tools: [] }
      } catch (error) {
        // Connection failed, return failed client with error message
        const errorMessage = error instanceof Error
          ? error.message
          : 'Unknown error'
        return {
          client: {
            type: 'failed' as const,
            name,
            config: scopedConfig,
            error: errorMessage,
          },
          tools: [],
        }
      }
    }),
  )

  // Process results — skip SDK-type entries (returned as null client)
  for (const result of results) {
    if (result.status === 'fulfilled') {
      // SDK-type servers return null client — only push real clients
      if (result.value.client != null) {
        // Cast needed: failed client from invalid config has session-scoped config
        clients.push(result.value.client as MCPServerConnection)
      }
      tools.push(...result.value.tools)
    }
  }

  return { clients, tools }
}

// ============================================================================
// Default permission-denying canUseTool
// ============================================================================

/**
 * Module-level warning flag for default permissions.
 *
 * This warning fires ONCE PER PROCESS when the default fallback denial
 * actually executes (i.e., a tool is denied because no canUseTool or
 * onPermissionRequest callback was provided). The warning is deferred to
 * execution time so that callers who provide canUseTool/onPermissionRequest
 * never see it.
 *
 * If you create multiple queries/sessions in the same process, only the first
 * actual default denial will emit this warning. This behavior is acceptable because:
 * 1. The secure-by-default behavior applies to ALL instances
 * 2. Repeated warnings would be log noise without adding value
 * 3. The denial message per tool use already contains actionable guidance
 */
let warnedDefaultPermissions = false

/**
 * Default canUseTool that DENIES all tool uses when no explicit
 * canUseTool or onPermissionRequest callback is provided.
 *
 * This is the secure-by-default behavior: SDK consumers must explicitly
 * provide a permission callback to allow tool execution. Permission modes
 * like 'bypass-permissions' still work because tool filtering happens at
 * the tool-list level via getTools(permissionContext) before this function
 * is ever reached.
 *
 * The warning is emitted at execution time (on first actual denial) rather
 * than at construction time, so callers who provide canUseTool or
 * onPermissionRequest never see false warnings.
 */
export function createDefaultCanUseTool(
  _permissionContext: ToolPermissionContext,
  logger?: SDKLogger,
): CanUseToolFn {
  const log = logger ?? defaultLogger
  return async (tool, input, toolUseContext, _assistantMessage, _toolUseID, forceDecision) => {
    const isFullAccessMode =
      typeof toolUseContext.getAppState === 'function' &&
      toolUseContext.getAppState().toolPermissionContext.mode === 'fullAccess'
    if (forceDecision) {
      if (
        forceDecision.behavior === 'ask' &&
        isFullAccessMode
      ) {
        const fullAccessDecision = await hasPermissionsToUseTool(
          tool,
          forceDecision.updatedInput ?? input,
          toolUseContext,
          _assistantMessage,
          _toolUseID,
        )
        if (fullAccessDecision.behavior === 'deny') {
          return fullAccessDecision
        }
      } else {
        return forceDecision
      }
    }
    if (!warnedDefaultPermissions) {
      warnedDefaultPermissions = true
      log.warn(
        '[SDK] No canUseTool or onPermissionRequest callback provided. ' +
        'All tool uses will be DENIED by default. ' +
        'Provide canUseTool in query options, e.g.: ' +
        '{ canUseTool: async (name, input) => ({ behavior: "allow" }) }',
      )
    }
    return {
      behavior: 'deny' as const,
      message: `SDK: Tool "${tool.name}" denied — no canUseTool or onPermissionRequest callback provided. Pass canUseTool in options to control tool permissions.`,
      decisionReason: { type: 'mode' as const, mode: 'default' },
    }
  }
}
