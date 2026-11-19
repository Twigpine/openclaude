// This file represents useful wrappers over node:child_process
// These wrappers ease error handling and cross-platform compatibility.
// By using cross-spawn, Windows gets .cmd/.bat compatibility without falling
// back to a generic shell command string.

import { spawn } from 'cross-spawn'
import path from 'node:path'
import { getCwd } from '../utils/cwd.js'
import { logError } from './log.js'

export { execSyncWithDefaults_DEPRECATED } from './execFileNoThrowPortable.js'

const MS_IN_SECOND = 1000
const SECONDS_IN_MINUTE = 60
const DEFAULT_MAX_BUFFER = 1_000_000
// How long an aborted child that traps its signal gets to close on its
// own before it is force-stopped with SIGKILL (awaitCloseOnAbort only):
// above the 200 ms cooperative close the `wait` inspector tests use, so
// a child that exits on SIGTERM is never killed, and below the waiter's
// 500 ms cleanup grace, so the close lands before the waiter stops
// waiting (CodeRabbit #2497 review 5961433156).
const ABORT_SIGKILL_GRACE_MS = 350
// Last-resort bound for a SIGKILLed child that still has not emitted
// 'close' (uninterruptible sleep): settle with the timeout error rather
// than leaving the result pending forever.
const ABORT_KILL_SETTLE_MS = 1000

type ExecFileOptions = {
  abortSignal?: AbortSignal
  timeout?: number
  preserveOutputOnError?: boolean
  // Setting useCwd=false avoids circular dependencies during initialization
  // getCwd() -> PersistentShell -> logEvent() -> execFileNoThrow
  useCwd?: boolean
  env?: NodeJS.ProcessEnv
  stdin?: 'ignore' | 'inherit' | 'pipe'
  input?: string
}

type ExecFileWithCwdOptions = {
  abortSignal?: AbortSignal
  timeout?: number
  preserveOutputOnError?: boolean
  maxBuffer?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
  stdin?: 'ignore' | 'inherit' | 'pipe'
  input?: string
  // When true, an abort-triggered 'error' does not settle the result
  // until the child emits 'close': the error can fire while a child
  // that traps the signal is still alive, so settling on it reports
  // the command done while its process is still running.
  awaitCloseOnAbort?: boolean
}

type ProcessResultWithError = {
  signal?: string
}

const CONTROL_CHAR_PATTERN = /[\0\r\n]/
const SAFE_BARE_EXECUTABLE_PATTERN = /^[A-Za-z0-9_.-]+$/

function hasPathSyntax(value: string): boolean {
  return (
    value.includes(path.sep) ||
    value.includes('/') ||
    path.isAbsolute(value)
  )
}

function validateExecutable(file: string): string | null {
  const normalized = file.trim()
  if (!normalized) {
    return 'Unsafe executable: empty command'
  }
  if (CONTROL_CHAR_PATTERN.test(normalized)) {
    return 'Unsafe executable: control characters are not allowed'
  }
  if (
    !hasPathSyntax(normalized) &&
    !SAFE_BARE_EXECUTABLE_PATTERN.test(normalized)
  ) {
    return 'Unsafe executable: bare command names may only contain letters, numbers, ".", "_" and "-"'
  }
  return null
}

function validateArgs(args: string[]): string | null {
  for (const arg of args) {
    if (CONTROL_CHAR_PATTERN.test(arg)) {
      return 'Unsafe argument: control characters are not allowed'
    }
  }
  return null
}

function validateWorkingDirectory(cwd: string | undefined): string | null {
  if (!cwd) {
    return null
  }
  if (CONTROL_CHAR_PATTERN.test(cwd)) {
    return 'Unsafe working directory: control characters are not allowed'
  }
  return null
}

function sanitizeEnvironment(
  env: NodeJS.ProcessEnv | undefined,
): { value?: NodeJS.ProcessEnv; error?: string } {
  if (!env) {
    return {}
  }

  for (const [key, value] of Object.entries(env)) {
    if (CONTROL_CHAR_PATTERN.test(key)) {
      return {
        error: 'Unsafe environment: control characters are not allowed in keys',
      }
    }
    if (typeof value === 'string' && CONTROL_CHAR_PATTERN.test(value)) {
      return {
        error:
          'Unsafe environment: control characters are not allowed in values',
      }
    }
  }

  return { value: env }
}

/**
 * Extracts a human-readable error message from a process result.
 *
 * Priority order:
 * 1. signal - the signal that killed the process (e.g., "SIGTERM")
 * 2. errorCode - fallback to just the numeric exit code
 */
function getErrorMessage(
  result: ProcessResultWithError,
  errorCode: number,
): string {
  if (typeof result.signal === 'string') {
    return result.signal
  }
  return String(errorCode)
}

export function execFileNoThrow(
  file: string,
  args: string[],
  options: ExecFileOptions = {
    timeout: 10 * SECONDS_IN_MINUTE * MS_IN_SECOND,
    preserveOutputOnError: true,
    useCwd: true,
  },
): Promise<{ stdout: string; stderr: string; code: number; error?: string }> {
  return execFileNoThrowWithCwd(file, args, {
    abortSignal: options.abortSignal,
    timeout: options.timeout,
    preserveOutputOnError: options.preserveOutputOnError,
    cwd: options.useCwd ? getCwd() : undefined,
    env: options.env,
    stdin: options.stdin,
    input: options.input,
  })
}

/**
 * execFile, but always resolves (never throws)
 */
export function execFileNoThrowWithCwd(
  file: string,
  args: string[],
  {
    abortSignal,
    timeout: finalTimeout = 10 * SECONDS_IN_MINUTE * MS_IN_SECOND,
    preserveOutputOnError: finalPreserveOutput = true,
    cwd: finalCwd,
    env: finalEnv,
    maxBuffer = DEFAULT_MAX_BUFFER,
    stdin: finalStdin,
    input: finalInput,
    awaitCloseOnAbort: finalAwaitCloseOnAbort = false,
  }: ExecFileWithCwdOptions = {
    timeout: 10 * SECONDS_IN_MINUTE * MS_IN_SECOND,
    preserveOutputOnError: true,
    maxBuffer: DEFAULT_MAX_BUFFER,
  },
): Promise<{ stdout: string; stderr: string; code: number; error?: string }> {
  const executableError = validateExecutable(file)
  if (executableError) {
    return Promise.resolve({
      stdout: '',
      stderr: '',
      code: 1,
      error: executableError,
    })
  }

  const argsError = validateArgs(args)
  if (argsError) {
    return Promise.resolve({
      stdout: '',
      stderr: '',
      code: 1,
      error: argsError,
    })
  }

  const cwdError = validateWorkingDirectory(finalCwd)
  if (cwdError) {
    return Promise.resolve({
      stdout: '',
      stderr: '',
      code: 1,
      error: cwdError,
    })
  }

  const sanitizedEnv = sanitizeEnvironment(finalEnv)
  if (sanitizedEnv.error) {
    return Promise.resolve({
      stdout: '',
      stderr: '',
      code: 1,
      error: sanitizedEnv.error,
    })
  }

  return new Promise(resolve => {
    const stdinMode = finalInput !== undefined ? 'pipe' : finalStdin ?? 'pipe'
    const child = spawn(file, args, {
      cwd: finalCwd,
      env: sanitizedEnv.value,
      shell: false,
      signal: abortSignal,
      stdio: [stdinMode, 'pipe', 'pipe'],
    })

    let settled = false
    let stdout = ''
    let stderr = ''
    let combinedBufferSize = 0
    let signal: string | undefined
    let timedOut = false
    // Set when the child emits 'close', and when an abort-triggered
    // 'error' arrives before it (see the 'error' handler below).
    let closed = false
    let abortError: Error | undefined
    // Set when the output buffer overflows while an aborted child is
    // still alive (awaitCloseOnAbort only): the overflow must not settle
    // the result before the child closes, so the error is recorded here
    // and reported by the 'close' handler (or the kill settle bound)
    // once the child has actually exited (CodeRabbit #2497 review
    // 5963778469).
    let overflowError: string | undefined
    // Escalation timers for a child that ignores its abort SIGTERM
    // (awaitCloseOnAbort only): the SIGKILL grace, and the last-resort
    // settle bound after a SIGKILL. Both are cleared on close/finish
    // so no timer outlives the result.
    let abortKillTimer: ReturnType<typeof setTimeout> | undefined
    let killSettleTimer: ReturnType<typeof setTimeout> | undefined
    const clearAbortTimers = (): void => {
      if (abortKillTimer !== undefined) {
        clearTimeout(abortKillTimer)
        abortKillTimer = undefined
      }
      if (killSettleTimer !== undefined) {
        clearTimeout(killSettleTimer)
        killSettleTimer = undefined
      }
    }

    const finish = (result: {
      stdout: string
      stderr: string
      code: number
      error?: string
    }) => {
      if (settled) {
        return
      }
      settled = true
      clearAbortTimers()
      void resolve(result)
    }

    // Starts the last-resort settle bound once a SIGKILL has been sent:
    // a SIGKILLed child in uninterruptible sleep — or one whose stdio
    // pipe a descendant keeps open — may never emit 'close', so the
    // result must still settle (CodeRabbit #2497 review 5963778469).
    // The first starter wins: the timeout callback below passes its own
    // error, while the abort escalation reports the overflow or abort
    // error that caused it. Never arms for a settled operation: output
    // that arrives after the result settled (a descendant still holding
    // the pipe) must not restart the escalation cycle (CodeRabbit #2497
    // review 5966284444).
    const startKillSettleTimer = (error?: string): void => {
      if (settled || killSettleTimer !== undefined) return
      killSettleTimer = setTimeout(() => {
        killSettleTimer = undefined
        finish({
          stdout: finalPreserveOutput ? stdout : '',
          stderr: finalPreserveOutput ? stderr : '',
          code: 1,
          error:
            error ??
            overflowError ??
            abortError?.message ??
            `Command timed out after ${finalTimeout}ms`,
        })
      }, ABORT_KILL_SETTLE_MS)
    }

    // Force-stops an aborted child that ignored its SIGTERM and starts
    // the last-resort settle bound, independently of the command
    // timeout: with timeout 0 there is no timeout callback to start it
    // (CodeRabbit #2497 review 5963778469).
    const escalateAbortedChild = (): void => {
      abortKillTimer = undefined
      if (!closed) {
        child.kill('SIGKILL')
        startKillSettleTimer()
      }
    }

    const scheduleAbortKill = (): void => {
      if (settled || abortKillTimer !== undefined) return
      abortKillTimer = setTimeout(escalateAbortedChild, ABORT_SIGKILL_GRACE_MS)
    }

    const appendOutput = (
      chunk: string | Buffer,
      target: 'stdout' | 'stderr',
    ) => {
      // Output that arrives after the result settled is ignored for
      // result and escalation purposes: a descendant can keep the stdio
      // pipe open (and writing) long after the caller was given the
      // result, and a late chunk must not restart the SIGKILL
      // escalation or re-arm its timers (CodeRabbit #2497 review
      // 5966284444).
      if (settled) return
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      combinedBufferSize += Buffer.byteLength(text, 'utf8')
      if (combinedBufferSize > maxBuffer) {
        child.kill()
        if (finalAwaitCloseOnAbort && abortSignal?.aborted && !closed) {
          // The child is still alive after its abort SIGTERM: settling
          // here would report the command finished while its process
          // is still running, and finishing would clear the pending
          // SIGKILL escalation. Record the overflow and keep the
          // escalation active; the 'close' handler (or the kill settle
          // bound) settles with it once the child has actually exited
          // (CodeRabbit #2497 review 5963778469).
          overflowError = 'maxBuffer exceeded'
          scheduleAbortKill()
          return
        }
        finish({
          stdout: finalPreserveOutput ? stdout : '',
          stderr: finalPreserveOutput ? stderr : '',
          code: 1,
          error: 'maxBuffer exceeded',
        })
        return
      }

      if (target === 'stdout') {
        stdout += text
      } else {
        stderr += text
      }
    }

    child.stdout?.on('data', chunk => appendOutput(chunk, 'stdout'))
    child.stderr?.on('data', chunk => appendOutput(chunk, 'stderr'))

    child.once('spawn', () => {
      if (stdinMode === 'pipe' && child.stdin) {
        if (finalInput !== undefined) {
          child.stdin.end(finalInput)
        } else {
          child.stdin.end()
        }
      }
    })

    child.once('error', error => {
      logError(error)
      if (finalAwaitCloseOnAbort && abortSignal?.aborted && !closed) {
        // The abort error fires as soon as the signal is delivered,
        // which can precede the child's 'close' by an arbitrary delay
        // when the child traps the signal: settling here would report
        // the command finished while its process is still alive, so a
        // caller that treats settlement as completion (notably the
        // `wait` inspector cleanup) would return too early (CodeRabbit
        // #2497 review 5957376769). Record the error and let the
        // 'close' handler below settle with it once the child has
        // actually exited. The timeout below still bounds the wait if
        // the child never closes.
        abortError = error
        // A child that ignores the abort SIGTERM never closes on its
        // own: force-stop it after a short grace so a caller waiting
        // for the close (notably `wait`, whose cleanup grace is one
        // poll interval) does not return while the child is still
        // alive. SIGKILL cannot be trapped, so the 'close' handler
        // below settles promptly after it (CodeRabbit #2497 review
        // 5961433156).
        scheduleAbortKill()
        return
      }
      finish({ stdout: '', stderr: '', code: 1, error: error.message })
    })

    const timeoutId =
      finalTimeout > 0
        ? setTimeout(() => {
            timedOut = true
            if (
              finalAwaitCloseOnAbort &&
              abortError !== undefined &&
              !closed
            ) {
              // The child already ignored its abort SIGTERM: a second
              // SIGTERM is equally useless, so escalate to SIGKILL and
              // let the 'close' handler settle once the child has
              // actually exited, instead of resolving while it is
              // still alive (CodeRabbit #2497 review 5961433156). The
              // settle bound below keeps the result from pending
              // forever if the close never arrives.
              if (abortKillTimer !== undefined) {
                clearTimeout(abortKillTimer)
                abortKillTimer = undefined
              }
              child.kill('SIGKILL')
              startKillSettleTimer(
                `Command timed out after ${finalTimeout}ms`,
              )
              return
            }
            child.kill?.()
            finish({
              stdout: finalPreserveOutput ? stdout : '',
              stderr: finalPreserveOutput ? stderr : '',
              code: 1,
              error: `Command timed out after ${finalTimeout}ms`,
            })
          }, finalTimeout)
        : undefined

    child.once('close', (code, closeSignal) => {
      closed = true
      clearAbortTimers()
      if (timeoutId) {
        clearTimeout(timeoutId)
      }

      signal = closeSignal ?? undefined
      const errorCode = code ?? 1

      if (overflowError !== undefined) {
        // The output buffer overflowed while the child was still alive:
        // the truncated output is the result, whatever else happened
        // afterward (CodeRabbit #2497 review 5963778469).
        finish({
          stdout: finalPreserveOutput ? stdout : '',
          stderr: finalPreserveOutput ? stderr : '',
          code: 1,
          error: overflowError,
        })
        return
      }

      if (abortError !== undefined) {
        // The abort error arrived before the child closed; settle with
        // it now that the process has actually exited, keeping whatever
        // output was collected.
        finish({
          stdout: finalPreserveOutput ? stdout : '',
          stderr: finalPreserveOutput ? stderr : '',
          code: 1,
          error: abortError.message,
        })
        return
      }

      if (timedOut) {
        finish({
          stdout: finalPreserveOutput ? stdout : '',
          stderr: finalPreserveOutput ? stderr : '',
          code: errorCode,
          error: `Command timed out after ${finalTimeout}ms`,
        })
        return
      }

      if (errorCode !== 0) {
        if (finalPreserveOutput) {
          finish({
            stdout,
            stderr,
            code: errorCode,
            error: getErrorMessage({ signal }, errorCode),
          })
        } else {
          finish({ stdout: '', stderr: '', code: errorCode })
        }
        return
      }

      finish({
        stdout,
        stderr,
        code: 0,
      })
    })
  })
}
