/**
 * Shared types, helpers, and mutex for the SDK modules.
 *
 * This module has no sibling imports — it is the foundation for
 * sessions.ts, permissions.ts, query.ts, and v2.ts.
 */

import type { UUID } from 'crypto'
import type {
  SDKMessage as GeneratedSDKMessage,
  SDKUserMessage as GeneratedSDKUserMessage,
} from './coreTypes.generated.js'
import { validateUuid } from '../../utils/sessionStoragePortable.js'

// ============================================================================
// Session ID validation
// ============================================================================

/**
 * Validate sessionId is a proper UUID to prevent path traversal.
 * Throws if invalid.
 */
export function assertValidSessionId(sessionId: string): void {
  if (!validateUuid(sessionId)) {
    throw new Error(`Invalid session ID: ${sessionId}`)
  }
}

// ============================================================================
// Environment mutation mutex for parallel query safety
// ============================================================================

/**
 * Global mutex for process.env mutations.
 * Prevents race conditions when multiple queries run in parallel.
 *
 * **Note:** The SDK itself does not directly mutate process.env. This mutex
 * is provided as a utility for SDK hosts who need to modify environment
 * variables during parallel query execution (e.g., setting API keys per-query).
 * Hosts must opt-in to using this mutex — there is no enforcement mechanism.
 *
 * Example usage:
 * ```typescript
 * const result = await acquireEnvMutex({ timeoutMs: 1000 })
 * if (result.acquired) {
 *   try {
 *     process.env.MY_API_KEY = 'key-for-this-query'
 *     // ... perform query ...
 *   } finally {
 *     releaseEnvMutex()
 *   }
 * }
 * ```
 */
export interface MutexAcquireOptions {
  /** Maximum time to wait for mutex in milliseconds. Default: no timeout (wait forever). */
  timeoutMs?: number
  /**
   * Abort waiting for the mutex when this signal aborts. A cancelled waiter
   * is removed from the queue, so it never acquires the mutex later and a
   * later caller is not stuck behind it.
   */
  signal?: AbortSignal
}

export interface MutexAcquireResult {
  /** Whether the mutex was acquired successfully. */
  acquired: boolean
  /** Reason for failure if not acquired. */
  reason?: 'timeout' | 'aborted'
}

function createEnvMutexState() {
  const queue: Array<() => void> = []
  let locked = false

  async function acquire(
    options?: MutexAcquireOptions,
  ): Promise<MutexAcquireResult> {
    if (!locked) {
      locked = true
      return { acquired: true }
    }

    if (options?.signal?.aborted) {
      return { acquired: false, reason: 'aborted' }
    }

    if (options?.timeoutMs === undefined && options?.signal === undefined) {
      // No timeout - wait forever (original behavior for backward compatibility)
      return new Promise(resolve => {
        queue.push(() => resolve({ acquired: true }))
      })
    }

    // With timeout and/or abort signal - race between queue, timeout and abort
    return new Promise(resolve => {
      let resolved = false
      let callback: () => void

      const cleanup = () => {
        if (timeoutId !== undefined) clearTimeout(timeoutId)
        options?.signal?.removeEventListener('abort', onAbort)
      }
      const settle = (result: MutexAcquireResult) => {
        if (resolved) return
        resolved = true
        cleanup()
        // Remove ourselves from the queue so a later release does not wake
        // a waiter that already left.
        const index = queue.indexOf(callback)
        if (index !== -1) {
          queue.splice(index, 1)
        }
        resolve(result)
      }

      let timeoutId: ReturnType<typeof setTimeout> | undefined
      if (options?.timeoutMs !== undefined) {
        timeoutId = setTimeout(
          () => settle({ acquired: false, reason: 'timeout' }),
          options.timeoutMs,
        )
      }

      const onAbort = () => settle({ acquired: false, reason: 'aborted' })
      options?.signal?.addEventListener('abort', onAbort, { once: true })

      callback = () => {
        if (!resolved) {
          resolved = true
          cleanup()
          resolve({ acquired: true })
        }
      }

      queue.push(callback)
    })
  }

  function release(): void {
    if (queue.length > 0) {
      const next = queue.shift()
      if (next) {
        try {
          next()
        } catch {
          // If callback throws, ensure mutex is unlocked so next caller can acquire
          // The error is intentionally not propagated - callback errors should not
          // block the mutex system. Callers should handle their own errors.
          locked = false
        }
      }
    } else {
      locked = false
    }
  }

  function reset(): void {
    queue.length = 0
    locked = false
  }

  return { acquire, release, reset }
}

const envMutex = createEnvMutexState()

export async function acquireEnvMutex(
  options?: MutexAcquireOptions,
): Promise<MutexAcquireResult> {
  return envMutex.acquire(options)
}

export function releaseEnvMutex(): void {
  envMutex.release()
}

/**
 * Reset mutex state for testing purposes only.
 * Do not use in production code.
 * @internal
 */
export function resetEnvMutexForTesting(): void {
  envMutex.reset()
}

/**
 * Create an isolated mutex instance for tests that need to exercise timeout
 * behavior without touching the process-global SDK env mutex.
 * @internal
 */
export function createEnvMutexForTesting(): {
  acquireEnvMutex: typeof acquireEnvMutex
  releaseEnvMutex: typeof releaseEnvMutex
  resetEnvMutex: () => void
} {
  const isolated = createEnvMutexState()
  return {
    acquireEnvMutex: isolated.acquire,
    releaseEnvMutex: isolated.release,
    resetEnvMutex: isolated.reset,
  }
}

// ============================================================================
// SDK Types — snake_case public interface (matches sdk.d.ts)
// ============================================================================

/**
 * Permission request message emitted when a tool needs permission approval.
 * Hosts can respond via respondToPermission() using the request_id.
 *
 * **ID Relationship:**
 * - `request_id`: UUID generated per permission request, used as correlation ID
 *   for respondToPermission(). Passed to onPermissionRequest callback for hosts
 *   to identify which request they're responding to.
 * - `tool_use_id`: Identifier for the specific tool use instance, passed from
 *   canUseTool(). Used internally for pending permission tracking and queue
 *   filtering. Multiple permission requests for the same tool use are rare but
 *   possible (e.g., retry after timeout).
 * - `session_id`: SDK session identifier. When 'no-session', indicates a
 *   standalone permission prompt outside an SDK session flow (e.g., direct
 *   createExternalCanUseTool usage without session context).
 * - `uuid`: Message UUID for stream correlation and transcript persistence.
 *
 * Hosts typically use `request_id` for responding; `tool_use_id` is useful
 * for tracking state or correlating with tool_use events in the message stream.
 * `session_id` enables correlation with SDK session lifecycle events.
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

/**
 * Message emitted when a permission request times out without a response.
 * Hosts can detect timeouts by checking `type === 'permission_timeout'`
 * in their `for await` loop. The `tool_use_id` matches the original
 * permission_request, allowing correlation.
 *
 * Note: `request_id` is not included in timeout messages since the request
 * is no longer pending — hosts cannot respond to timed-out requests.
 */
export type SDKPermissionTimeoutMessage = {
  type: 'permission_timeout'
  tool_name: string
  tool_use_id: string
  timed_out_after_ms: number
  /** UUID of the original permission request message for correlation. */
  uuid: string
  /** Session ID where the timeout occurred, or NO_SESSION_PLACEHOLDER. */
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

/**
 * A message emitted by the query engine during a conversation.
 * Re-exports the full generated type from coreTypes.generated.ts.
 */
export type SDKMessage = GeneratedSDKMessage | SDKPermissionTimeoutMessage | SDKAgentLoadFailureMessage

/**
 * A user message fed into query() via AsyncIterable.
 * Re-exports the full generated type from coreTypes.generated.ts.
 */
export type SDKUserMessage = GeneratedSDKUserMessage

/**
 * Map an internal Message object to an SDKMessage.
 * Internal messages have a different shape from SDK types — this function
 * performs the conversion instead of relying on unsafe casts.
 *
 * Validates that the message is a non-null object and has a valid type field.
 * Returns a message with type='unknown' if type is missing or invalid.
 */
export function mapMessageToSDK(msg: Record<string, unknown>): SDKMessage {
  // Validate input is a non-null object
  if (msg === null || typeof msg !== 'object') {
    throw new TypeError('mapMessageToSDK: expected non-null object')
  }

  // Validate type field is a string (if present)
  const typeValue = msg.type
  if (typeValue !== undefined && typeof typeValue !== 'string') {
    throw new TypeError(`mapMessageToSDK: 'type' field must be string, got ${typeof typeValue}`)
  }

  // Internal messages from QueryEngine already use the SDK field naming
  // convention (snake_case: parent_tool_use_id, session_id, etc.).
  // We spread all fields through and let the discriminated-union type
  // narrow via the `type` field.
  return {
    ...msg,
    type: (typeValue as string) ?? 'unknown',
  } as SDKMessage
}

/**
 * Session metadata returned by listSessions and getSessionInfo.
 * Uses camelCase field names matching the public SDK contract (sdk.d.ts).
 */
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

/** Options for listSessions. */
export type ListSessionsOptions = {
  /** Project directory. When omitted, returns sessions across all projects. */
  dir?: string
  /** Maximum number of sessions to return. */
  limit?: number
  /** Number of sessions to skip (pagination). */
  offset?: number
  /** Include git worktree sessions (default true). */
  includeWorktrees?: boolean
}

/** Options for getSessionInfo. */
export type GetSessionInfoOptions = {
  /** Project directory. When omitted, searches all project directories. */
  dir?: string
}

/** Options for getSessionMessages. */
export type GetSessionMessagesOptions = {
  /** Project directory. When omitted, searches all project directories. */
  dir?: string
  /** Maximum number of messages to return. */
  limit?: number
  /** Number of messages to skip (pagination). */
  offset?: number
  /** Include system messages in the output. Default false. */
  includeSystemMessages?: boolean
}

/** Options for renameSession and tagSession. */
export type SessionMutationOptions = {
  /** Project directory. When omitted, searches all project directories. */
  dir?: string
}

/** Options for forkSession. */
export type ForkSessionOptions = {
  /** Project directory. When omitted, searches all project directories. */
  dir?: string
  /** Fork up to (and including) this message UUID. */
  upToMessageId?: string
  /** Title for the forked session. */
  title?: string
}

/** Result of forkSession. */
export type ForkSessionResult = {
  /** UUID of the newly created forked session. */
  sessionId: string
}

/**
 * A single message in a session conversation.
 * Returned by getSessionMessages.
 */
export type SessionMessage = {
  role: 'user' | 'assistant' | 'system'
  content: unknown
  timestamp?: string
  uuid?: string
  parentUuid?: string | null
  [key: string]: unknown
}

/**
 * Permission mode for the query.
 * Controls how tool permissions are handled.
 */
export type QueryPermissionMode =
  | 'default'
  | 'plan'
  | 'auto-accept'
  | 'bypass-permissions'
  | 'bypassPermissions'
  | 'full-access'
  | 'fullAccess'
  | 'acceptEdits'

/**
 * Callback type for canUseTool permission checks.
 * Shared between QueryOptions and SDKSessionOptions.
 */
export type CanUseToolCallback = (
  name: string,
  input: unknown,
  options?: { toolUseID?: string },
) => Promise<{ behavior: 'allow' | 'deny'; message?: string; updatedInput?: unknown }>

// ============================================================================
// Internal types shared across modules
// ============================================================================

/**
 * JSONL line types used by getSessionMessages and forkSession.
 * @internal
 */
export type JsonlEntry = {
  type: string
  uuid?: string
  parentUuid?: string | null
  sessionId?: string
  timestamp?: string
  message?: {
    role?: string
    content?: unknown
    [key: string]: unknown
  }
  isSidechain?: boolean
  [key: string]: unknown
}
