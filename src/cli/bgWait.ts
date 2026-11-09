import {
  BackgroundSessionWaitError,
  isTerminalBackgroundSession,
  readPinnedBackgroundSessionForWait,
  resolveBackgroundSessionForWait,
  verifyBackgroundSessionProcessIdentityAsync,
  type BackgroundSession,
} from './bgRegistry.js'
import { ndjsonSafeStringify } from './ndjsonSafeStringify.js'

// Scriptable wait for one local background session (issue #2162, v1).
//
// `openclaude wait <id-or-name> [--timeout <duration>] [--json]`
//
// The command pins the exact session ID and PID once, then polls the pinned
// metadata and terminal facts every 500 ms with serialized abortable sleeps.
// It never writes to the registry, never inspects unrelated sessions while
// polling, and never forwards signals to the background session. Exit codes
// are command-owned (see WAIT_EXIT_CODES in the help text); the exact child
// result is exposed in human output and in the version-1 JSON object.

export const WAIT_POLL_INTERVAL_MS = 500
export const WAIT_MAX_TIMEOUT_MS = 2_147_483_647

export const WAIT_HELP_TEXT = `Usage: openclaude wait <id-or-name> [--timeout <duration>] [--json]

Wait for a local background session to reach a terminal state.

Arguments:
  <id-or-name>  Session ID, session name, or unambiguous ID prefix.

Options:
  --timeout <duration>  Maximum time to wait (e.g. 500ms, 30s, 5m, 1h).
                        Maximum 2147483647ms. Without it, wait indefinitely.
  --json                Print a single JSON object describing the result.
  -h, --help            Show this help.

Exit codes:
  0    Child exited with code 0.
  1    Child failed, was killed, or became stale.
  2    Invalid arguments, unknown or ambiguous selector, or unsupported build.
  3    Process state could not be observed at the timeout boundary.
  4    Session metadata is missing, unreadable, malformed, or replaced.
  124  Timeout while the session was still running.
  130  Waiting client received SIGINT.
  143  Waiting client received SIGTERM.

Use 'openclaude logs <id-or-name> -f' to follow session output.
`

export type WaitTerminalStatus =
  | 'exited'
  | 'failed'
  | 'killed'
  | 'stale'
  | 'running'
  | 'unknown'

export type WaitResult = {
  version: 1
  id: string | null
  status: WaitTerminalStatus | null
  exitCode: number | null
  signal: string | null
  terminalReason: 'exit_code' | 'signal' | 'explicit_kill' | null
  finishedAt: string | null
  waitResult:
    | 'terminal'
    | 'timeout'
    | 'observation_error'
    | 'selector_error'
    | 'interrupted'
  error: string | null
  waitSignal: 'SIGINT' | 'SIGTERM' | null
}

export type ParsedWaitInvocation = {
  selector?: string
  timeoutMs?: number
  json: boolean
  help: boolean
}

export type WaitOutput = {
  write(chunk: string): unknown
}

export type WaitHandlerOptions = {
  featureEnabled?: boolean
  now?: () => number
  pollIntervalMs?: number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  isProcessAlive?: (pid: number) => boolean
  signalProcess?: (pid: number, signal: 0) => unknown
  getProcessCommandAsync?: (
    pid: number,
    options: { signal?: AbortSignal },
  ) => Promise<string | null>
  resolveSession?: (target: string) => Promise<BackgroundSession>
  readPinnedSession?: (pinned: {
    id: string
    pid: number
  }) => Promise<BackgroundSession>
  stdout?: WaitOutput
  stderr?: WaitOutput
}

const DURATION_RE = /^(\d+)(ms|s|m|h)$/
const DURATION_MULTIPLIERS: Record<string, bigint> = {
  ms: 1n,
  s: 1_000n,
  m: 60_000n,
  h: 3_600_000n,
}

const WAIT_METADATA_ERROR_CODES = new Set([
  'metadata_missing',
  'metadata_unreadable',
  'metadata_malformed',
  'metadata_replaced',
])

function invalidArguments(message: string): BackgroundSessionWaitError {
  return new BackgroundSessionWaitError('invalid_arguments', message)
}

function parseTimeoutDuration(raw: string): number {
  const match = DURATION_RE.exec(raw)
  if (!match) {
    throw invalidArguments(`Invalid timeout duration: ${raw}`)
  }
  const milliseconds =
    BigInt(match[1]!) * DURATION_MULTIPLIERS[match[2]!]!
  if (milliseconds <= 0n || milliseconds > BigInt(WAIT_MAX_TIMEOUT_MS)) {
    throw invalidArguments(`Invalid timeout duration: ${raw}`)
  }
  return Number(milliseconds)
}

function hasJsonFlag(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === '--') break
    if (arg === '--json') return true
  }
  return false
}

export function parseWaitInvocation(args: string[]): ParsedWaitInvocation {
  const delimiterIndex = args.indexOf('--')
  const head = delimiterIndex === -1 ? args : args.slice(0, delimiterIndex)
  const tail = delimiterIndex === -1 ? [] : args.slice(delimiterIndex + 1)

  // Help wins over every other argument before the delimiter.
  if (head.includes('--help') || head.includes('-h')) {
    return { json: hasJsonFlag(args), help: true }
  }

  let selector: string | undefined
  let timeoutMs: number | undefined
  let timeoutSeen = false
  let json = false

  const takeSelector = (value: string) => {
    if (selector !== undefined) {
      throw invalidArguments('Usage: openclaude wait <id-or-name> [--timeout <duration>] [--json]')
    }
    selector = value
  }

  for (let i = 0; i < head.length; i++) {
    const arg = head[i]!
    if (arg === '--timeout') {
      if (timeoutSeen) {
        throw invalidArguments('Duplicate --timeout flag')
      }
      timeoutSeen = true
      const raw = head[i + 1]
      if (raw === undefined) {
        throw invalidArguments('Missing value for --timeout')
      }
      i += 1
      timeoutMs = parseTimeoutDuration(raw)
      continue
    }
    if (arg.startsWith('--timeout=')) {
      if (timeoutSeen) {
        throw invalidArguments('Duplicate --timeout flag')
      }
      timeoutSeen = true
      timeoutMs = parseTimeoutDuration(arg.slice('--timeout='.length))
      continue
    }
    if (arg === '--json') {
      if (json) throw invalidArguments('Duplicate --json flag')
      json = true
      continue
    }
    if (arg.startsWith('-')) {
      throw invalidArguments(`Unknown argument: ${arg}`)
    }
    takeSelector(arg)
  }

  for (const arg of tail) takeSelector(arg)

  if (selector === undefined) {
    throw invalidArguments(
      'Usage: openclaude wait <id-or-name> [--timeout <duration>] [--json]',
    )
  }

  return { selector, timeoutMs, json, help: false }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve()
  return new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function baseWaitResult(
  id: string | null,
  waitResult: WaitResult['waitResult'],
  error: string | null,
): WaitResult {
  return {
    version: 1,
    id,
    status: null,
    exitCode: null,
    signal: null,
    terminalReason: null,
    finishedAt: null,
    waitResult,
    error,
    waitSignal: null,
  }
}

function terminalWaitResult(session: BackgroundSession): WaitResult {
  const result = baseWaitResult(session.id, 'terminal', null)
  if (session.status === 'exited') {
    return {
      ...result,
      status: 'exited',
      exitCode: session.exitCode ?? 0,
      terminalReason: 'exit_code',
      finishedAt: session.finishedAt ?? null,
    }
  }
  if (session.status === 'failed') {
    return {
      ...result,
      status: 'failed',
      exitCode:
        session.terminalReason === 'exit_code'
          ? (session.exitCode ?? null)
          : null,
      signal:
        session.terminalReason === 'signal'
          ? (session.signal ?? null)
          : null,
      terminalReason: session.terminalReason ?? null,
      finishedAt: session.finishedAt ?? null,
    }
  }
  if (session.status === 'killed') {
    return {
      ...result,
      status: 'killed',
      terminalReason: 'explicit_kill',
      finishedAt: session.finishedAt ?? null,
    }
  }
  // Derived stale outcome.
  return { ...result, status: 'stale' }
}

function interruptedWaitResult(
  id: string | null,
  waitSignal: 'SIGINT' | 'SIGTERM',
): WaitResult {
  return {
    ...baseWaitResult(id, 'interrupted', 'interrupted'),
    waitSignal,
  }
}

export function waitExitCode(result: WaitResult): number {
  if (result.waitResult === 'terminal') {
    return result.status === 'exited' && result.exitCode === 0 ? 0 : 1
  }
  if (result.waitResult === 'timeout') return 124
  if (result.waitResult === 'interrupted') {
    return result.waitSignal === 'SIGTERM' ? 143 : 130
  }
  if (result.waitResult === 'observation_error') {
    return result.error === 'process_unreadable' ? 3 : 4
  }
  return 2
}

function humanTerminalLine(result: WaitResult): string {
  const id = result.id
  if (result.status === 'exited') {
    return `Background session ${id} exited with code 0.`
  }
  if (result.status === 'failed') {
    if (result.signal) {
      return `Background session ${id} failed after ${result.signal}.`
    }
    return `Background session ${id} failed with exit code ${result.exitCode ?? 1}.`
  }
  if (result.status === 'killed') {
    return `Background session ${id} was killed.`
  }
  if (result.status === 'stale') {
    return `Background session ${id} became stale without an observable child outcome.`
  }
  return `Background session ${id} finished with status ${result.status}.`
}

function humanErrorLine(result: WaitResult): string {
  if (result.waitResult === 'timeout') {
    return `Timed out waiting for background session ${result.id}.`
  }
  if (result.waitResult === 'interrupted') {
    return result.id
      ? `Waiting for background session ${result.id} was interrupted by ${result.waitSignal}.`
      : `Waiting for a background session was interrupted by ${result.waitSignal}.`
  }
  if (result.waitResult === 'observation_error') {
    if (result.error === 'process_unreadable') {
      return `Background session ${result.id} process state could not be observed.`
    }
    if (result.error === 'metadata_missing') {
      return `Background session ${result.id} metadata is missing.`
    }
    if (result.error === 'metadata_malformed') {
      return `Background session ${result.id} metadata is malformed.`
    }
    if (result.error === 'metadata_replaced') {
      return `Background session ${result.id} metadata was replaced.`
    }
    return `Background session ${result.id} metadata could not be read.`
  }
  if (result.error === 'unsupported') {
    return 'Background sessions are disabled in this build.'
  }
  return 'Usage: openclaude wait <id-or-name> [--timeout <duration>] [--json]'
}

function renderWaitResult(
  result: WaitResult,
  json: boolean,
  stdout: WaitOutput,
  stderr: WaitOutput,
  humanMessage?: string,
): void {
  if (json) {
    stdout.write(`${ndjsonSafeStringify(result)}\n`)
    return
  }
  if (result.waitResult === 'terminal') {
    stdout.write(`${humanTerminalLine(result)}\n`)
    return
  }
  stderr.write(`${humanMessage ?? humanErrorLine(result)}\n`)
}

type WaitObservation =
  | { kind: 'terminal'; session: BackgroundSession }
  | { kind: 'running'; session: BackgroundSession }
  | { kind: 'unknown'; session: BackgroundSession }
  | { kind: 'metadata_error'; error: BackgroundSessionWaitError }

async function observePinnedSession(
  pinned: { id: string; pid: number },
  signal: AbortSignal,
  deps: WaitHandlerOptions,
): Promise<WaitObservation> {
  const readPinned = deps.readPinnedSession ?? readPinnedBackgroundSessionForWait
  let session: BackgroundSession
  try {
    session = await readPinned(pinned)
  } catch (error) {
    if (error instanceof BackgroundSessionWaitError) {
      return { kind: 'metadata_error', error }
    }
    throw error
  }
  if (isTerminalBackgroundSession(session) && session.status !== 'stale') {
    return { kind: 'terminal', session }
  }

  const identity = await verifyBackgroundSessionProcessIdentityAsync(session, {
    isProcessAlive: deps.isProcessAlive,
    signalProcess: deps.signalProcess,
    getProcessCommandAsync: deps.getProcessCommandAsync,
    signal,
  })

  // A natural or killed fact published during the lookup wins over derived
  // stale, unknown, or running state, so re-read before classifying.
  try {
    session = await readPinned(pinned)
  } catch (error) {
    if (error instanceof BackgroundSessionWaitError) {
      return { kind: 'metadata_error', error }
    }
    throw error
  }
  if (isTerminalBackgroundSession(session) && session.status !== 'stale') {
    return { kind: 'terminal', session }
  }
  if (identity.state === 'matches') return { kind: 'running', session }
  if (identity.state === 'unreadable') return { kind: 'unknown', session }
  // PID absence or identity mismatch, with no terminal fact: stale.
  return {
    kind: 'terminal',
    session: { ...session, status: 'stale' },
  }
}

function normalizeArgs(args: string[] | string | undefined): string[] {
  if (Array.isArray(args)) return args
  return args ? [args] : []
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function waitHandler(
  args: string[] | string | undefined,
  options: WaitHandlerOptions = {},
): Promise<number> {
  const argsArray = normalizeArgs(args)
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr

  const finishEarly = (
    result: WaitResult,
    json: boolean,
    humanMessage?: string,
  ): number => {
    renderWaitResult(result, json, stdout, stderr, humanMessage)
    const code = waitExitCode(result)
    process.exitCode = code
    return code
  }

  let parsed: ParsedWaitInvocation
  try {
    parsed = parseWaitInvocation(argsArray)
  } catch (error) {
    if (error instanceof BackgroundSessionWaitError) {
      const result = baseWaitResult(null, 'selector_error', error.code)
      return finishEarly(result, hasJsonFlag(argsArray), error.message)
    }
    throw error
  }
  const json = parsed.json

  const finish = (result: WaitResult, humanMessage?: string): number =>
    finishEarly(result, json, humanMessage)

  if (parsed.help) {
    stdout.write(WAIT_HELP_TEXT)
    process.exitCode = 0
    return 0
  }

  if (options.featureEnabled === false) {
    const result = baseWaitResult(null, 'selector_error', 'unsupported')
    renderWaitResult(result, json, stdout, stderr)
    process.exitCode = 2
    return 2
  }

  const now = options.now ?? (() => performance.now())
  const pollIntervalMs = options.pollIntervalMs ?? WAIT_POLL_INTERVAL_MS
  const sleep = options.sleep ?? abortableSleep
  const resolveSession = options.resolveSession ?? resolveBackgroundSessionForWait

  // Install the waiting-client signal listeners immediately after argument
  // validation and before any selector or metadata I/O. The first signal
  // wins; neither signal is forwarded to the background session.
  let clientSignal: 'SIGINT' | 'SIGTERM' | null = null
  const abortController = new AbortController()
  const onSigint = () => {
    if (clientSignal) return
    clientSignal = 'SIGINT'
    abortController.abort()
  }
  const onSigterm = () => {
    if (clientSignal) return
    clientSignal = 'SIGTERM'
    abortController.abort()
  }
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)

  try {
    // The deadline starts from a monotonic clock after argument validation.
    const deadline =
      parsed.timeoutMs === undefined ? null : now() + parsed.timeoutMs

    let session: BackgroundSession
    try {
      session = await resolveSession(parsed.selector!)
    } catch (error) {
      if (clientSignal) {
        return finish(interruptedWaitResult(null, clientSignal))
      }
      if (error instanceof BackgroundSessionWaitError) {
        const waitResult = WAIT_METADATA_ERROR_CODES.has(error.code)
          ? 'observation_error'
          : 'selector_error'
        const result = {
          ...baseWaitResult(error.pinnedId, waitResult, error.code),
        }
        return finish(result, error.message)
      }
      throw error
    }
    if (clientSignal) {
      return finish(interruptedWaitResult(null, clientSignal))
    }
    const pinned = { id: session.id, pid: session.pid }

    while (true) {
      if (clientSignal) {
        return finish(interruptedWaitResult(pinned.id, clientSignal))
      }
      let observation: WaitObservation
      try {
        observation = await observePinnedSession(
          pinned,
          abortController.signal,
          options,
        )
      } catch (error) {
        if (clientSignal || abortController.signal.aborted) {
          return finish(
            interruptedWaitResult(pinned.id, clientSignal ?? 'SIGINT'),
          )
        }
        throw error
      }
      if (clientSignal) {
        return finish(interruptedWaitResult(pinned.id, clientSignal))
      }
      if (observation.kind === 'terminal') {
        return finish(terminalWaitResult(observation.session))
      }
      if (observation.kind === 'metadata_error') {
        const result = {
          ...baseWaitResult(pinned.id, 'observation_error', observation.error.code),
        }
        return finish(result, observation.error.message)
      }
      // Running or transiently unknown: only the final timeout-boundary
      // observation classifies as a timeout (124) or unknown (3).
      if (deadline !== null && now() >= deadline) {
        if (observation.kind === 'unknown') {
          return finish({
            ...baseWaitResult(pinned.id, 'observation_error', 'process_unreadable'),
            status: 'unknown',
          })
        }
        return finish({
          ...baseWaitResult(pinned.id, 'timeout', 'timeout'),
          status: 'running',
        })
      }
      const delay =
        deadline === null
          ? pollIntervalMs
          : Math.min(pollIntervalMs, Math.max(0, deadline - now()))
      await sleep(delay, abortController.signal)
      if (clientSignal) {
        return finish(interruptedWaitResult(pinned.id, clientSignal))
      }
    }
  } catch (error) {
    // Unexpected internal failures stay outside the JSON schema.
    stderr.write(`Error: ${errorMessage(error)}\n`)
    process.exitCode = 1
    return 1
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
  }
}
