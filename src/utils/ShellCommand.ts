import type { ChildProcess } from 'child_process'
import { stat } from 'fs/promises'
import type { Readable } from 'stream'
import treeKill from 'tree-kill'
import { generateTaskId } from '../Task.js'
import {
  getShellAbortMessage,
  isQueryLevelAbort,
  normalizeAbortReason,
  type AbortReason,
} from './abortReasons.js'
import { formatDuration } from './format.js'
import {
  MAX_TASK_OUTPUT_BYTES,
  MAX_TASK_OUTPUT_BYTES_DISPLAY,
} from './task/diskOutput.js'
import { TaskOutput } from './task/TaskOutput.js'

export type ExecResult = {
  stdout: string
  stderr: string
  code: number
  interrupted: boolean
  backgroundTaskId?: string
  backgroundedByUser?: boolean
  /** Set when assistant-mode auto-backgrounded a long-running blocking command. */
  assistantAutoBackgrounded?: boolean
  /** Set when stdout was too large to fit inline — points to the output file on disk. */
  outputFilePath?: string
  /** Total size of the output file in bytes (set when outputFilePath is set). */
  outputFileSize?: number
  /** The task ID for the output file (set when outputFilePath is set). */
  outputTaskId?: string
  /** Error message when the command failed before spawning (e.g., deleted cwd). */
  preSpawnError?: string
  /** Exit signal reported by the child process or the internal kill path. */
  signal?: NodeJS.Signals | null
  /** Execution duration measured by the shell command wrapper. */
  durationMs?: number
  /** True when the command's AbortSignal was aborted before the result resolved. */
  signalAborted?: boolean
  /** True when the command was cancelled through the abort path, not by shell exit. */
  isAbort?: boolean
  /** Normalized abort or timeout reason, when known. */
  abortReason?: AbortReason
  /** Safe user-facing abort explanation. */
  abortMessage?: string
  stdoutLength?: number
  stderrLength?: number
}

export type ShellCommand = {
  background: (backgroundTaskId: string) => boolean
  result: Promise<ExecResult>
  kill: () => void
  status: 'running' | 'backgrounded' | 'completed' | 'killed'
  /**
   * Cleans up stream resources (event listeners).
   * Should be called after the command completes or is killed to prevent memory leaks.
   */
  cleanup: () => void
  onTimeout?: (
    callback: (backgroundFn: (taskId: string) => boolean) => void,
  ) => void
  /** The TaskOutput instance that owns all stdout/stderr data and progress. */
  taskOutput: TaskOutput
}

type ShellCommandOptions = {
  keepAliveOnInterrupt?: boolean
}

const SIGKILL = 137
const SIGTERM = 143

// Background tasks write stdout/stderr directly to a file fd (no JS involvement),
// so a stuck append loop can fill the disk. Poll file size and kill when exceeded.
const SIZE_WATCHDOG_INTERVAL_MS = 5_000

function prependStderr(prefix: string, stderr: string): string {
  return stderr ? `${prefix} ${stderr}` : prefix
}

/**
 * Thin pipe from a child process stream into TaskOutput.
 * Used in pipe mode (hooks) for stdout and stderr.
 * In file mode (bash commands), both fds go to the output file —
 * the child process streams are null and no wrappers are created.
 */
class StreamWrapper {
  #stream: Readable | null
  #isCleanedUp = false
  #taskOutput: TaskOutput | null
  #isStderr: boolean
  #onData = this.#dataHandler.bind(this)

  constructor(stream: Readable, taskOutput: TaskOutput, isStderr: boolean) {
    this.#stream = stream
    this.#taskOutput = taskOutput
    this.#isStderr = isStderr
    // Emit strings instead of Buffers - avoids repeated .toString() calls
    stream.setEncoding('utf-8')
    stream.on('data', this.#onData)
  }

  #dataHandler(data: Buffer | string): void {
    const str = typeof data === 'string' ? data : data.toString()

    if (this.#isStderr) {
      this.#taskOutput!.writeStderr(str)
    } else {
      this.#taskOutput!.writeStdout(str)
    }
  }

  cleanup(): void {
    if (this.#isCleanedUp) {
      return
    }
    this.#isCleanedUp = true
    this.#stream!.removeListener('data', this.#onData)
    // Release references so the stream, its StringDecoder, and
    // the TaskOutput can be GC'd independently of this wrapper.
    this.#stream = null
    this.#taskOutput = null
    this.#onData = () => {}
  }
}

/**
 * Implementation of ShellCommand that wraps a child process.
 *
 * For bash commands: both stdout and stderr go to a file fd via
 * stdio[1] and stdio[2] — no JS involvement. Progress is extracted
 * by polling the file tail.
 * For hooks: pipe mode with StreamWrappers for real-time detection.
 */
class ShellCommandImpl implements ShellCommand {
  #status: 'running' | 'backgrounded' | 'completed' | 'killed' = 'running'
  #backgroundTaskId: string | undefined
  #stdoutWrapper: StreamWrapper | null
  #stderrWrapper: StreamWrapper | null
  #childProcess: ChildProcess
  #timeoutId: NodeJS.Timeout | null = null
  #sizeWatchdog: NodeJS.Timeout | null = null
  #killedForSize = false
  #maxOutputBytes: number
  #abortSignal: AbortSignal
  #onTimeoutCallback:
    | ((backgroundFn: (taskId: string) => boolean) => void)
    | undefined
  #timeout: number
  #shouldAutoBackground: boolean
  #keepAliveOnInterrupt: boolean
  #resultResolver: ((result: ExecResult) => void) | null = null
  #exitCodeResolver: ((code: number) => void) | null = null
  #boundAbortHandler: (() => void) | null = null
  #startedAt = Date.now()
  #exitSignal: NodeJS.Signals | null = null
  #killedByAbort = false
  #timedOut = false
  readonly taskOutput: TaskOutput

  static #handleTimeout(self: ShellCommandImpl): void {
    if (self.#shouldAutoBackground && self.#onTimeoutCallback) {
      self.#onTimeoutCallback(self.background.bind(self))
    } else {
      self.#timedOut = true
      self.#doKill(SIGTERM)
    }
  }

  readonly result: Promise<ExecResult>
  readonly onTimeout?: (
    callback: (backgroundFn: (taskId: string) => boolean) => void,
  ) => void

  constructor(
    childProcess: ChildProcess,
    abortSignal: AbortSignal,
    timeout: number,
    taskOutput: TaskOutput,
    shouldAutoBackground = false,
    maxOutputBytes = MAX_TASK_OUTPUT_BYTES,
    options?: ShellCommandOptions,
  ) {
    this.#childProcess = childProcess
    this.#abortSignal = abortSignal
    this.#timeout = timeout
    this.#shouldAutoBackground = shouldAutoBackground
    this.#maxOutputBytes = maxOutputBytes
    this.#keepAliveOnInterrupt = options?.keepAliveOnInterrupt === true
    this.taskOutput = taskOutput

    // In file mode (bash commands), both stdout and stderr go to the
    // output file fd — childProcess.stdout/.stderr are both null.
    // In pipe mode (hooks), wrap streams to funnel data into TaskOutput.
    this.#stderrWrapper = childProcess.stderr
      ? new StreamWrapper(childProcess.stderr, taskOutput, true)
      : null
    this.#stdoutWrapper = childProcess.stdout
      ? new StreamWrapper(childProcess.stdout, taskOutput, false)
      : null

    if (shouldAutoBackground) {
      this.onTimeout = (callback): void => {
        this.#onTimeoutCallback = callback
      }
    }

    this.result = this.#createResultPromise()
  }

  get status(): 'running' | 'backgrounded' | 'completed' | 'killed' {
    return this.#status
  }

  #abortHandler(): void {
    // On 'interrupt' (user submitted a new message), keep explicit survivors
    // alive: already-backgrounded commands and asyncRewake hook processes
    // that must finish in-memory to emit or enqueue their response.
    if (
      this.#abortSignal.reason === 'interrupt' &&
      (this.#status === 'backgrounded' || this.#keepAliveOnInterrupt)
    ) {
      return
    }
    this.#killedByAbort = true
    this.kill()
  }

  #exitHandler(code: number | null, signal: NodeJS.Signals | null): void {
    this.#exitSignal = signal
    const exitCode =
      code !== null && code !== undefined
        ? code
        : signal === 'SIGTERM'
          ? 144
          : 1
    this.#resolveExitCode(exitCode)
  }

  #errorHandler(): void {
    this.#resolveExitCode(1)
  }

  #resolveExitCode(code: number): void {
    if (this.#exitCodeResolver) {
      this.#exitCodeResolver(code)
      this.#exitCodeResolver = null
    }
  }

  // Note: exit/error listeners are NOT removed here — they're needed for
  // the result promise to resolve. They clean up when the child process exits.
  #cleanupListeners(): void {
    this.#clearSizeWatchdog()
    const timeoutId = this.#timeoutId
    if (timeoutId) {
      clearTimeout(timeoutId)
      this.#timeoutId = null
    }
    const boundAbortHandler = this.#boundAbortHandler
    if (boundAbortHandler) {
      this.#abortSignal.removeEventListener('abort', boundAbortHandler)
      this.#boundAbortHandler = null
    }
  }

  #clearSizeWatchdog(): void {
    if (this.#sizeWatchdog) {
      clearInterval(this.#sizeWatchdog)
      this.#sizeWatchdog = null
    }
  }

  #startSizeWatchdog(): void {
    this.#sizeWatchdog = setInterval(() => {
      void stat(this.taskOutput.path).then(
        s => {
          // Bail if the watchdog was cleared while this stat was in flight
          // (process exited on its own) — otherwise we'd mislabel stderr.
          if (
            s.size > this.#maxOutputBytes &&
            this.#status === 'backgrounded' &&
            this.#sizeWatchdog !== null
          ) {
            this.#killedForSize = true
            this.#clearSizeWatchdog()
            this.#doKill(SIGKILL)
          }
        },
        () => {
          // ENOENT before first write, or unlinked mid-run — skip this tick
        },
      )
    }, SIZE_WATCHDOG_INTERVAL_MS)
    this.#sizeWatchdog.unref()
  }

  #createResultPromise(): Promise<ExecResult> {
    this.#boundAbortHandler = this.#abortHandler.bind(this)
    this.#abortSignal.addEventListener('abort', this.#boundAbortHandler, {
      once: true,
    })
    if (this.#abortSignal.aborted) {
      this.#boundAbortHandler()
    }

    // Use 'exit' not 'close': 'close' waits for stdio to close, which includes
    // grandchild processes that inherit file descriptors (e.g. `sleep 30 &`).
    // 'exit' fires when the shell itself exits, returning control immediately.
    this.#childProcess.once('exit', this.#exitHandler.bind(this))
    this.#childProcess.once('error', this.#errorHandler.bind(this))

    this.#timeoutId = setTimeout(
      ShellCommandImpl.#handleTimeout,
      this.#timeout,
      this,
    ) as NodeJS.Timeout

    const exitPromise = new Promise<number>(resolve => {
      this.#exitCodeResolver = resolve
    })

    return new Promise<ExecResult>(resolve => {
      this.#resultResolver = resolve
      void exitPromise.then(this.#handleExit.bind(this))
    })
  }

  async #handleExit(code: number): Promise<void> {
    this.#cleanupListeners()
    if (this.#status === 'running' || this.#status === 'backgrounded') {
      this.#status = 'completed'
    }

    const stdout = await this.taskOutput.getStdout()
    const signalAborted = this.#abortSignal.aborted
    const normalizedAbortReason = this.#timedOut
      ? 'tool-timeout'
      : signalAborted || this.#killedByAbort
        ? normalizeAbortReason(this.#abortSignal.reason)
        : undefined
    const isAbort =
      normalizedAbortReason !== undefined &&
      isQueryLevelAbort(normalizedAbortReason) &&
      this.#killedByAbort
    const result: ExecResult = {
      code,
      stdout,
      stderr: this.taskOutput.getStderr(),
      interrupted: code === SIGKILL || isAbort,
      backgroundTaskId: this.#backgroundTaskId,
      signal: this.#exitSignal,
      durationMs: Date.now() - this.#startedAt,
      signalAborted,
      isAbort,
      abortReason: normalizedAbortReason,
      abortMessage:
        normalizedAbortReason && isAbort
          ? getShellAbortMessage(normalizedAbortReason)
          : undefined,
    }

    if (this.taskOutput.stdoutToFile && !this.#backgroundTaskId) {
      if (this.taskOutput.outputFileRedundant) {
        // Small file — full content is in result.stdout, delete the file
        void this.taskOutput.deleteOutputFile()
      } else {
        // Large file — tell the caller where the full output lives
        result.outputFilePath = this.taskOutput.path
        result.outputFileSize = this.taskOutput.outputFileSize
        result.outputTaskId = this.taskOutput.taskId
      }
    }

    if (this.#killedForSize) {
      result.stderr = prependStderr(
        `Background command killed: output file exceeded ${MAX_TASK_OUTPUT_BYTES_DISPLAY}`,
        result.stderr,
      )
    } else if (code === SIGTERM) {
      result.stderr = prependStderr(
        `Command timed out after ${formatDuration(this.#timeout)}`,
        result.stderr,
      )
    }

    result.stdoutLength = result.stdout.length
    result.stderrLength = result.stderr.length

    const resultResolver = this.#resultResolver
    if (resultResolver) {
      this.#resultResolver = null
      resultResolver(result)
    }
  }

  #doKill(code?: number): void {
    this.#status = 'killed'
    this.#exitSignal = code === SIGTERM ? 'SIGTERM' : 'SIGKILL'
    if (this.#childProcess.pid) {
      treeKill(this.#childProcess.pid, 'SIGKILL')
    }
    this.#resolveExitCode(code ?? SIGKILL)
  }

  kill(): void {
    this.#doKill()
  }

  background(taskId: string): boolean {
    if (this.#status === 'running') {
      this.#backgroundTaskId = taskId
      this.#status = 'backgrounded'
      this.#cleanupListeners()
      if (this.taskOutput.stdoutToFile) {
        // File mode: child writes directly to the fd with no JS involvement.
        // The foreground timeout is gone, so watch file size to prevent
        // a stuck append loop from filling the disk (768GB incident).
        this.#startSizeWatchdog()
      } else {
        // Pipe mode: spill the in-memory buffer so readers can find it on disk.
        this.taskOutput.spillToDisk()
      }
      return true
    }
    return false
  }

  cleanup(): void {
    this.#stdoutWrapper?.cleanup()
    this.#stderrWrapper?.cleanup()
    this.taskOutput.clear()
    // Must run before nulling #abortSignal — #cleanupListeners() calls
    // removeEventListener on it. Without this, a kill()+cleanup() sequence
    // crashes: kill() queues #handleExit as a microtask, cleanup() nulls
    // #abortSignal, then #handleExit runs #cleanupListeners() on the null ref.
    this.#cleanupListeners()
    // Release references to allow GC of ChildProcess internals and AbortController chain
    this.#childProcess = null!
    this.#abortSignal = null!
    this.#onTimeoutCallback = undefined
  }
}

/**
 * Wraps a child process to enable flexible handling of shell command execution.
 */
export function wrapSpawn(
  childProcess: ChildProcess,
  abortSignal: AbortSignal,
  timeout: number,
  taskOutput: TaskOutput,
  shouldAutoBackground = false,
  maxOutputBytes = MAX_TASK_OUTPUT_BYTES,
  options?: ShellCommandOptions,
): ShellCommand {
  return new ShellCommandImpl(
    childProcess,
    abortSignal,
    timeout,
    taskOutput,
    shouldAutoBackground,
    maxOutputBytes,
    options,
  )
}

/**
 * Static ShellCommand implementation for commands that were aborted before execution.
 */
class AbortedShellCommand implements ShellCommand {
  readonly status = 'killed' as const
  readonly result: Promise<ExecResult>
  readonly taskOutput: TaskOutput

  constructor(opts?: {
    backgroundTaskId?: string
    stderr?: string
    code?: number
    abortReason?: AbortReason
  }) {
    const abortReason = opts?.abortReason ?? 'unknown-abort'
    const stderr = opts?.stderr ?? getShellAbortMessage(abortReason)
    this.taskOutput = new TaskOutput(generateTaskId('local_bash'), null)
    this.result = Promise.resolve({
      code: opts?.code ?? 145,
      stdout: '',
      stderr,
      interrupted: true,
      backgroundTaskId: opts?.backgroundTaskId,
      signal: null,
      durationMs: 0,
      signalAborted: true,
      isAbort: true,
      abortReason,
      abortMessage: getShellAbortMessage(abortReason),
      stdoutLength: 0,
      stderrLength: stderr.length,
    })
  }

  background(): boolean {
    return false
  }

  kill(): void {}

  cleanup(): void {}
}

export function createAbortedCommand(
  backgroundTaskId?: string,
  opts?: { stderr?: string; code?: number; abortReason?: AbortReason },
): ShellCommand {
  return new AbortedShellCommand({
    backgroundTaskId,
    ...opts,
  })
}

export function createFailedCommand(
  preSpawnError: string,
  opts?: { code?: number },
): ShellCommand {
  const taskOutput = new TaskOutput(generateTaskId('local_bash'), null)
  return {
    status: 'completed' as const,
    result: Promise.resolve({
      code: opts?.code ?? 1,
      stdout: '',
      stderr: preSpawnError,
      interrupted: false,
      preSpawnError,
      signal: null,
      durationMs: 0,
      signalAborted: false,
      isAbort: false,
      stdoutLength: 0,
      stderrLength: preSpawnError.length,
    }),
    taskOutput,
    background(): boolean {
      return false
    },
    kill(): void {},
    cleanup(): void {},
  }
}
