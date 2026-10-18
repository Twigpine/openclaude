import { dirname } from 'path'
import { getErrnoCode } from './errors.js'
import { getFsImplementation } from './fsOperations.js'
import { jsonStringify } from './slowOperations.js'

type DiagnosticLogLevel = 'debug' | 'info' | 'warn' | 'error'

type DiagnosticLogEntry = {
  timestamp: string
  level: DiagnosticLogLevel
  event: string
  data: Record<string, unknown>
}

export type DiagnosticAppendResult =
  | 'committed'
  | 'unsupported'
  | 'retryable_failure'
  | 'uncertain_failure'

/**
 * Append already-sanitized diagnostic records to an explicit file.
 *
 * This is the shared filesystem boundary for opt-in diagnostic streams. Callers
 * must rebuild records from an allowlist before using it; arbitrary runtime
 * objects, messages, prompts, and file paths are not safe inputs.
 */
export async function appendDiagnosticsNoPII(
  logFile: string,
  entries: readonly Record<string, unknown>[],
): Promise<DiagnosticAppendResult> {
  if (entries.length === 0) return 'committed'
  // Node exposes the descriptor-relative namespace required by the secure
  // append implementation through /proc/self/fd on Linux only.
  if (process.platform !== 'linux') return 'unsupported'

  try {
    const fs = getFsImplementation()
    const lines = entries.map(entry => jsonStringify(entry)).join('\n') + '\n'
    await fs.appendRegularFile(logFile, lines, { mode: 0o600 })
    return 'committed'
  } catch (error) {
    return getErrnoCode(error) === 'ERR_DIAGNOSTIC_APPEND_UNCERTAIN'
      ? 'uncertain_failure'
      : 'retryable_failure'
  }
}

/**
 * Logs diagnostic information to a logfile. This information is sent
 * via the environment manager to session-ingress to monitor issues from
 * within the container.
 *
 * *Important* - this function MUST NOT be called with any PII, including
 * file paths, project names, repo names, prompts, etc.
 *
 * @param level    Log level. Only used for information, not filtering
 * @param event    A specific event: "started", "mcp_connected", etc.
 * @param data     Optional additional data to log
 */
// sync IO: called from sync context
export function logForDiagnosticsNoPII(
  level: DiagnosticLogLevel,
  event: string,
  data?: Record<string, unknown>,
): void {
  const logFile = getDiagnosticLogFile()
  if (!logFile) {
    return
  }

  const entry: DiagnosticLogEntry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    data: data ?? {},
  }

  const fs = getFsImplementation()
  const line = jsonStringify(entry) + '\n'
  try {
    fs.appendFileSync(logFile, line)
  } catch {
    // Preserve the legacy diagnostic logger's append-through-symlink contract.
    try {
      fs.mkdirSync(dirname(logFile))
      fs.appendFileSync(logFile, line)
    } catch {
      // Silently fail if logging is not possible.
    }
  }
}

function getDiagnosticLogFile(): string | undefined {
  return process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
}

/**
 * Wraps an async function with diagnostic timing logs.
 * Logs `{event}_started` before execution and `{event}_completed` after with duration_ms.
 *
 * @param event   Event name prefix (e.g., "git_status" -> logs "git_status_started" and "git_status_completed")
 * @param fn      Async function to execute and time
 * @param getData Optional function to extract additional data from the result for the completion log
 * @returns       The result of the wrapped function
 */
export async function withDiagnosticsTiming<T>(
  event: string,
  fn: () => Promise<T>,
  getData?: (result: T) => Record<string, unknown>,
): Promise<T> {
  const startTime = Date.now()
  logForDiagnosticsNoPII('info', `${event}_started`)

  try {
    const result = await fn()
    const additionalData = getData ? getData(result) : {}
    logForDiagnosticsNoPII('info', `${event}_completed`, {
      duration_ms: Date.now() - startTime,
      ...additionalData,
    })
    return result
  } catch (error) {
    logForDiagnosticsNoPII('error', `${event}_failed`, {
      duration_ms: Date.now() - startTime,
    })
    throw error
  }
}
