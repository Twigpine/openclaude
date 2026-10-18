import { createHash } from 'crypto'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { raceAbort, throwIfAborted } from '../../utils/boundedAsync.js'
import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import { logForDebugging } from '../../utils/debug.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getErrnoCode } from '../../utils/errors.js'
import * as lockfile from '../../utils/lockfile.js'
import { logMCPDebug } from '../../utils/log.js'
import { sleep } from '../../utils/sleep.js'

export const MCP_REFRESH_FRESHNESS_SECONDS = 300

const MAX_LOCK_RETRIES = 5
const LOCK_STALE_MS = 10_000
const LOCK_UPDATE_MS = LOCK_STALE_MS / 2
const LOCK_IO_TIMEOUT_MS = 5_000

export type McpRefreshLockResult<T> = {
  acquired: boolean
  value: T
}

export type McpRefreshLockContext = {
  acquired: boolean
  signal: AbortSignal
}

export class McpRefreshLockUnavailableError extends Error {
  constructor() {
    super('MCP credential refresh lock is unavailable')
    this.name = 'McpRefreshLockUnavailableError'
  }
}

function getMcpRefreshLockIdentity(serverKey: string): string {
  return createHash('sha256').update(serverKey).digest('hex').substring(0, 32)
}

function logRefreshWarning(lockIdentity: string, message: string): void {
  try {
    logForDebugging(`[mcp-refresh:${lockIdentity}] ${message}`, {
      level: 'warn',
    })
  } catch {
    // Refresh coordination and cleanup must not depend on diagnostics.
  }
}

async function runBoundedLockIo<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  const combined = createCombinedAbortSignal(signal, {
    timeoutMs: LOCK_IO_TIMEOUT_MS,
  })
  try {
    return await raceAbort(
      operation,
      combined.signal,
      'MCP refresh lock operation aborted',
    )
  } finally {
    combined.cleanup()
  }
}

async function releaseRefreshLock(
  release: () => Promise<void>,
): Promise<boolean> {
  try {
    // Never race release against a timeout or caller cancellation. A release
    // that continues after this helper returns could remove a successor's
    // lock directory and break the serialization boundary.
    await release()
    return true
  } catch {
    return false
  }
}

async function acquireRefreshLock(
  lockPath: string,
  options: Parameters<typeof lockfile.lock>[1],
  signal: AbortSignal | undefined,
): Promise<() => Promise<void>> {
  const combined = createCombinedAbortSignal(signal, {
    timeoutMs: LOCK_IO_TIMEOUT_MS,
  })
  const acquisition = lockfile.lock(lockPath, options).then(async release => {
    if (combined.signal.aborted) {
      // The caller has already regained control. Clean up a late acquisition
      // without inheriting the already-aborted request signal.
      await releaseRefreshLock(release)
      throw combined.signal.reason
    }
    return release
  })
  try {
    return await raceAbort(
      acquisition,
      combined.signal,
      'MCP refresh lock acquisition aborted',
    )
  } finally {
    combined.cleanup()
  }
}

export function getMcpRefreshLockPath(
  serverKey: string,
  configDir = getClaudeConfigHomeDir(),
): string {
  return join(
    configDir,
    `mcp-refresh-${getMcpRefreshLockIdentity(serverKey)}.lock`,
  )
}

/**
 * Runs one MCP credential refresh under the canonical server-scoped lock.
 *
 * After bounded acquisition failure, the operation gets one final
 * fresh-storage check but must not perform a network refresh. Callers use the
 * `acquired` flag to enforce that fail-closed policy consistently.
 *
 * This lock protects the provider's proactive normal OAuth refresh and silent
 * XAA exchange for one server. It is not a global secure-storage lock: login,
 * logout, manual token replacement, and other servers retain their existing
 * coordination boundaries.
 */
export async function withMcpRefreshLock<T>(
  serverName: string,
  serverKey: string,
  signal: AbortSignal | undefined,
  operation: (context: McpRefreshLockContext) => Promise<T>,
): Promise<McpRefreshLockResult<T>> {
  throwIfAborted(signal, 'MCP token refresh aborted')

  const configDir = getClaudeConfigHomeDir()
  const lockPath = getMcpRefreshLockPath(serverKey, configDir)
  const lockIdentity = getMcpRefreshLockIdentity(serverKey)
  let release: (() => Promise<void>) | undefined
  let acquisitionFailure: string | undefined
  let canAttemptLock = true
  const compromisedController = new AbortController()

  try {
    await runBoundedLockIo(mkdir(configDir, { recursive: true }), signal)
  } catch (error) {
    throwIfAborted(signal, 'MCP token refresh aborted')
    acquisitionFailure = getErrnoCode(error) ?? 'directory-setup-timeout'
    canAttemptLock = false
  }

  for (
    let retry = 0;
    canAttemptLock && retry < MAX_LOCK_RETRIES;
    retry++
  ) {
    throwIfAborted(signal, 'MCP token refresh aborted')
    try {
      logMCPDebug(serverName, `Acquiring refresh lock (attempt ${retry + 1})`)
      release = await acquireRefreshLock(
        lockPath,
        {
          realpath: false,
          retries: 0,
          stale: LOCK_STALE_MS,
          update: LOCK_UPDATE_MS,
          onCompromised: () => {
            // proper-lockfile invokes this callback from its update timer. Never
            // allow a diagnostic failure to escape that timer as an unhandled
            // exception; the active operation still owns its normal cleanup.
            try {
              logMCPDebug(serverName, 'Refresh lock was compromised')
              logRefreshWarning(lockIdentity, 'refresh lock was compromised')
            } catch {
              // Diagnostics are best-effort in a compromised-lock callback.
            }
            compromisedController.abort(
              new DOMException('MCP refresh lock compromised', 'AbortError'),
            )
          },
        },
        signal,
      )
      logMCPDebug(serverName, 'Acquired refresh lock')
      break
    } catch (error) {
      throwIfAborted(signal, 'MCP token refresh aborted')
      const code = getErrnoCode(error)
      acquisitionFailure = code ?? 'unknown'
      if (code !== 'ELOCKED') {
        break
      }
      logMCPDebug(
        serverName,
        `Refresh lock held by another process, waiting (attempt ${retry + 1}/${MAX_LOCK_RETRIES})`,
      )
      if (retry < MAX_LOCK_RETRIES - 1) {
        await sleep(1000 + Math.random() * 1000, signal)
        throwIfAborted(signal, 'MCP token refresh aborted')
      }
    }
  }

  const acquired = release !== undefined
  if (!acquired) {
    logMCPDebug(
      serverName,
      `Could not acquire refresh lock (${acquisitionFailure ?? 'exhausted'}); refresh blocked`,
    )
    logRefreshWarning(
      lockIdentity,
      `refresh blocked after bounded lock acquisition failure (${acquisitionFailure ?? 'exhausted'})`,
    )
  }

  const operationSignal = createCombinedAbortSignal(signal, {
    signalB: compromisedController.signal,
  })

  try {
    throwIfAborted(operationSignal.signal, 'MCP token refresh aborted')
    return {
      acquired,
      value: await operation({ acquired, signal: operationSignal.signal }),
    }
  } finally {
    if (release) {
      if (await releaseRefreshLock(release)) {
        logMCPDebug(serverName, 'Released refresh lock')
      } else {
        logMCPDebug(serverName, 'Failed to release refresh lock')
      }
    }
    operationSignal.cleanup()
  }
}
