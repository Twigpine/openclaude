import {
  BackgroundSessionWaitError,
  isTerminalBackgroundSession,
  readPinnedBackgroundSessionForWait,
  resolveBackgroundSessionForWait,
  verifyBackgroundSessionProcessIdentityAsync,
  type BackgroundSession,
} from './bgRegistry.js'
import { ndjsonSafeStringify } from './ndjsonSafeStringify.js'
import { getProcessCommandAsync } from '../utils/genericProcessUtils.js'

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
// How long an unsignalled timeout waits for its rendered result to
// leave a back-pressured stdout before returning anyway: the timeout
// outcome's JSON line is the waiter's one mandatory output object, so
// it gets a longer bound than the one poll interval other paths use.
// A client signal arriving during the flush caps the remaining wait at
// one poll interval instead (see the finally below), and a failed write
// settles at once, so a consumer that never drains still cannot stall
// the waiter indefinitely. The longer bound (rather than unbounded) is
// the mechanism chosen for this tradeoff; the choice itself is a
// maintainer decision (CodeRabbit #2497 review 5957376769).
export const TIMEOUT_FLUSH_BOUND_MS = 10 * WAIT_POLL_INTERVAL_MS
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
  2    Invalid arguments, unknown or ambiguous selector, unsupported build,
       or an internal wait error.
  3    Process state was still unreadable when the timeout boundary was
       classified (after the grace poll).
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
    | 'internal_error'
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
  // The optional callback reports write completion: a real stream's
  // write() return value describes buffer capacity, not completion, so
  // the handler awaits the callback (CodeRabbit #2497 review 5950772048).
  // Synchronous capture outputs (tests) take no callback and resolve at
  // once; see writeWaitOutput.
  write(chunk: string, callback?: () => void): unknown
  // Present on real streams (process.stdout/stderr): lets the handler wait
  // for a back-pressured write to drain before a forced exit discards it.
  once?(event: 'drain' | 'error' | 'close', listener: () => void): unknown
  off?(event: 'drain' | 'error' | 'close', listener: () => void): unknown
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

/**
 * Parses `wait` command arguments into a selector, an optional timeout,
 * and output flags. Throws on a missing, empty, or duplicate selector, an
 * unknown flag, or a malformed `--timeout` duration.
 */
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
    if (value === '') {
      // An empty variable must not resolve: '' is a prefix of every session
      // id, so with one session present it would pin that unrelated
      // session instead of failing (CodeRabbit #2497).
      throw invalidArguments('Selector must not be empty')
    }
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

/**
 * Races a registry read against the waiting-client abort signal: a SIGINT
 * or SIGTERM must interrupt the waiter even when the read never settles
 * (CodeRabbit #2497). Rejects with the signal's reason when the signal
 * fires first; the callers' existing signal checks turn that rejection
 * into the interrupted result.
 */
function raceWithClientSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    // The caller never awaits the supplied promise in this branch, so
    // handle it here: a later rejection (e.g. metadata going missing
    // mid-read) must not surface as an unhandled rejection and kill the
    // client with exit 1 instead of the signal's 130/143 (CodeRabbit
    // #2497).
    void promise.catch(() => {})
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

// Settles a pending registry read when --timeout elapses. A stalled
// readFile on pinned metadata (e.g. a FIFO) never settles on its own, so
// the deadline check after the observation runs cannot bound it. This is
// a separate outcome from the client-signal path: a deadline expiry is a
// timeout (124), not an interruption (130/143) (CodeRabbit #2497).
//
// The deadline is a signal, not a shared promise: racing one long-lived
// promise per poll would retain a reaction per poll for the whole wait
// (maintainer review 5948202472 on #2497). Each call attaches exactly one
// abort listener and removes it when the awaited promise settles, so
// completed polls release their bookkeeping.
//
// Exported for the regression test that counts the deadline signal's
// listeners after settled races.
export const DEADLINE_EXPIRED = Symbol('deadline-expired')

export function raceWithDeadline<T>(
  promise: Promise<T>,
  deadlineSignal: AbortSignal | null,
): Promise<T | typeof DEADLINE_EXPIRED> {
  if (deadlineSignal === null) return promise
  if (deadlineSignal.aborted) return Promise.resolve(DEADLINE_EXPIRED)
  return new Promise<T | typeof DEADLINE_EXPIRED>((resolve, reject) => {
    const onAbort = () => resolve(DEADLINE_EXPIRED)
    deadlineSignal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        deadlineSignal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        deadlineSignal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
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
    // observePinnedSession rejects `exited` records without an exit code
    // before this point, so a missing code cannot reach here; the
    // fallback only guards the type's optional field.
    return {
      ...result,
      status: 'exited',
      exitCode: session.exitCode ?? 0,
      terminalReason: 'exit_code',
      finishedAt: session.finishedAt ?? null,
    }
  }
  if (session.status === 'failed') {
    // Preserve whatever outcome the record carries. A valid failed record
    // can hold exitCode without terminalReason (terminalReason is optional
    // on BackgroundSession), so gate each field on its own presence rather
    // than on the reason: dropping the code would make JSON lose the
    // outcome and human output invent exit code 1 (CodeRabbit #2497).
    return {
      ...result,
      status: 'failed',
      exitCode:
        session.terminalReason === 'exit_code' ||
        session.terminalReason === undefined
          ? (session.exitCode ?? null)
          : null,
      signal:
        session.terminalReason === 'signal' ||
        session.terminalReason === undefined
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

/**
 * Maps a wait outcome to its process exit code: 0 for a clean child exit,
 * 1 for any other terminal outcome, 124 on timeout, 130/143 when the
 * waiter is interrupted by SIGINT/SIGTERM, 3 for an unreadable process,
 * 4 for other observation errors, and 2 for internal failures.
 */
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
  if (result.waitResult === 'internal_error') {
    // Unexpected wait failures (e.g. a home-directory lookup failing
    // during selector resolution) are the waiter's own failure, not the
    // child's: exit 2, distinct from a child failure (1).
    return 2
  }
  return 2
}

function humanTerminalLine(result: WaitResult): string {
  const id = result.id
  if (result.status === 'exited') {
    // terminalWaitResult only builds an `exited` result from a record
    // carrying an exit code (records without one are rejected before a
    // terminal result is built), so this is the child's real code — an
    // `exited` record with a nonzero code must not read as code 0
    // (CodeRabbit #2497).
    return `Background session ${id} exited with code ${result.exitCode}.`
  }
  if (result.status === 'failed') {
    if (result.signal) {
      return `Background session ${id} failed after ${result.signal}.`
    }
    if (result.exitCode !== null) {
      return `Background session ${id} failed with exit code ${result.exitCode}.`
    }
    // No recorded outcome: report it as unknown rather than inventing an
    // exit code (CodeRabbit #2497).
    return `Background session ${id} failed with an unknown outcome.`
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
  if (result.waitResult === 'internal_error') {
    return 'Waiting for a background session failed with an internal error.'
  }
  return 'Usage: openclaude wait <id-or-name> [--timeout <duration>] [--json]'
}

function renderWaitResult(
  result: WaitResult,
  json: boolean,
  stdout: WaitOutput,
  stderr: WaitOutput,
  humanMessage?: string,
): Promise<void> {
  if (json) {
    return writeWaitOutput(stdout, `${ndjsonSafeStringify(result)}\n`)
  }
  if (result.waitResult === 'terminal') {
    return writeWaitOutput(stdout, `${humanTerminalLine(result)}\n`)
  }
  return writeWaitOutput(stderr, `${humanMessage ?? humanErrorLine(result)}\n`)
}

// Writes one rendered result line and waits until it has actually left
// the stream, so a forced exit (124/130/143) in the CLI fast path cannot
// discard the rendered line — with --json that line is the mandatory v1
// JSON object (maintainer review 5948202472 on #2497). The write's return
// value is NOT completion: in Node, write() can return true while the
// chunk is still pending, so a real stream resolves only after its write
// callback fires (or the drain event, for streams whose callback is tied
// to it), regardless of the boolean return value (CodeRabbit #2497 review
// 5950772048). Resolves at once for synchronous capture outputs (no
// `once`: the chunk is already in the buffer), and on error or close as
// well, so a dead consumer never hangs the waiter.
function writeWaitOutput(out: WaitOutput, chunk: string): Promise<void> {
  if (typeof out.once !== 'function') {
    out.write(chunk)
    return Promise.resolve()
  }
  // Bind the methods: calling a detached `once`/`off` would lose its
  // `this`.
  const once = out.once.bind(out)
  const off =
    typeof out.off === 'function' ? out.off.bind(out) : undefined
  return new Promise<void>(resolve => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      off?.('drain', done)
      off?.('error', done)
      off?.('close', done)
      resolve()
    }
    once('drain', done)
    once('error', done)
    once('close', done)
    try {
      // Complete the write from the callback only on success. On Node
      // a failed write invokes its callback before emitting 'error',
      // so completing here would remove the error listener installed
      // above and the later 'error' event would throw instead of
      // settling the waiter with its selected exit code (CodeRabbit
      // #2497 review 5952674466). On failure leave the listeners in
      // place and let the stream's error path settle the waiter.
      out.write(chunk, (error?: Error | null) => {
        if (!error) done()
      })
    } catch {
      // A synchronously throwing write (e.g. an ended stream) is a
      // dead consumer, not a reason to fail the waiter: resolve so the
      // handler still returns its exit code.
      done()
    }
  })
}

type WaitObservation =
  | { kind: 'terminal'; session: BackgroundSession }
  | { kind: 'running'; session: BackgroundSession }
  | { kind: 'unknown'; session: BackgroundSession }
  // The process lookup was cut short by an abort before it observed
  // anything: not evidence the process is unreadable, so the caller must
  // re-observe with a fresh lookup instead of classifying it (maintainer
  // review 5948202472 on #2497).
  | { kind: 'aborted'; session: BackgroundSession }
  | { kind: 'metadata_error'; error: BackgroundSessionWaitError }

/**
 * Classify a terminal session for the waiter. An `exited` record without
 * an exit code is not evidence of a successful child: the authoritative
 * natural terminal fact requires exitCode 0 for `exited`, and terminal
 * facts are only applied to non-terminal records, so no valid fact can
 * corroborate this claim. It is a metadata defect (exit 4), not a
 * success (exit 0) and not a transient unknown (exit 3): no amount of
 * re-polling can produce a code the record never carried.
 * (ChatGPT post-build review on #2497.)
 */
function terminalObservation(session: BackgroundSession): WaitObservation {
  if (session.status === 'exited' && session.exitCode === undefined) {
    return {
      kind: 'metadata_error',
      error: new BackgroundSessionWaitError(
        'metadata_malformed',
        `Background session ${session.id} metadata claims it exited without recording an exit code`,
      ),
    }
  }
  return { kind: 'terminal', session }
}

async function observePinnedSession(
  pinned: { id: string; pid: number },
  signal: AbortSignal,
  deps: WaitHandlerOptions,
  lookupSignal: AbortSignal,
): Promise<WaitObservation> {
  const readPinned = deps.readPinnedSession ?? readPinnedBackgroundSessionForWait
  let session: BackgroundSession
  try {
    session = await raceWithClientSignal(readPinned(pinned), signal)
  } catch (error) {
    if (error instanceof BackgroundSessionWaitError) {
      return { kind: 'metadata_error', error }
    }
    throw error
  }
  if (isTerminalBackgroundSession(session) && session.status !== 'stale') {
    return terminalObservation(session)
  }

  // The process lookup gets the combined client-or-deadline signal, so
  // a slow `ps` is aborted when the waiter is interrupted or the
  // deadline expires; the registry reads above and below keep the
  // client signal only, so a deadline expiry cannot turn them into an
  // interruption (maintainer review 5942761094 on #2497).
  const identity = await verifyBackgroundSessionProcessIdentityAsync(session, {
    isProcessAlive: deps.isProcessAlive,
    signalProcess: deps.signalProcess,
    getProcessCommandAsync: deps.getProcessCommandAsync,
    signal: lookupSignal,
  })

  // A natural or killed fact published during the lookup wins over derived
  // stale, unknown, or running state, so re-read before classifying.
  try {
    session = await raceWithClientSignal(readPinned(pinned), signal)
  } catch (error) {
    if (error instanceof BackgroundSessionWaitError) {
      return { kind: 'metadata_error', error }
    }
    throw error
  }
  if (isTerminalBackgroundSession(session) && session.status !== 'stale') {
    return terminalObservation(session)
  }
  if (identity.state === 'matches') return { kind: 'running', session }
  // An aborted lookup observed nothing: never report it as an unreadable
  // process (exit 3). The caller re-observes with a fresh lookup at the
  // timeout boundary, or reports the interruption when the client signal
  // fired.
  if (identity.state === 'aborted') return { kind: 'aborted', session }
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

/**
 * Runs `openclaude wait`: pins one background session, then polls its
 * registry state until it reaches a terminal outcome, the timeout elapses,
 * or the waiter is interrupted. Returns the process exit code for the
 * outcome and sets `process.exitCode` to match.
 */
export async function waitHandler(
  args: string[] | string | undefined,
  options: WaitHandlerOptions = {},
): Promise<number> {
  const argsArray = normalizeArgs(args)
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr

  // The flush of the last rendered result: the finally below awaits it,
  // so a forced 124/130/143 exit in the CLI fast path cannot discard a
  // line still queued in a back-pressured stdout pipe.
  let pendingFlush: Promise<void> | null = null
  // The result finish() rendered, if any: the finally below gives an
  // unsignalled timeout a longer flush bound than other outcomes.
  // Boxed in an object (not a plain `let`): a closure-assigned `let`
  // narrows to `never` under control-flow analysis at the finally
  // below, while a property read keeps its declared type.
  const finishedState: { result: WaitResult | null } = { result: null }

  const finishEarly = (
    result: WaitResult,
    json: boolean,
    humanMessage?: string,
  ): number => {
    finishedState.result = result
    pendingFlush = renderWaitResult(result, json, stdout, stderr, humanMessage)
    const code = waitExitCode(result)
    process.exitCode = code
    return code
  }

  // The one bounded flush wait for the last rendered result: every
  // --json return awaits it, including the pre-poll paths below that
  // never enter the poll loop's finally (maintainer review 5962625271
  // on #2497). `boundMs` is one production poll interval except for an
  // unsignalled timeout, which gets the longer TIMEOUT_FLUSH_BOUND_MS
  // (chosen by the caller from finishedState); `signal`, when given,
  // shortens a long flush to one poll interval if the client is
  // interrupted mid-flush. A failed write settles at once, so a
  // consumer that never drains still cannot stall the waiter. A
  // forced 124/130/143 exit in the CLI fast path cannot discard a
  // line still queued in a back-pressured stdout pipe.
  const awaitPendingFlush = async (
    boundMs: number,
    signal?: AbortSignal,
  ): Promise<void> => {
    if (pendingFlush === null) return
    let flushTimer: ReturnType<typeof setTimeout> | undefined
    let signalShortenTimer: ReturnType<typeof setTimeout> | undefined
    let onClientAbort: (() => void) | undefined
    try {
      const flushRacers: Array<Promise<void>> = [
        pendingFlush,
        new Promise<void>(resolve => {
          flushTimer = setTimeout(() => resolve(), boundMs)
        }),
      ]
      if (signal !== undefined) {
        flushRacers.push(
          new Promise<void>(resolve => {
            onClientAbort = () => {
              signalShortenTimer = setTimeout(
                () => resolve(),
                WAIT_POLL_INTERVAL_MS,
              )
            }
            if (signal.aborted) onClientAbort()
            else {
              signal.addEventListener('abort', onClientAbort, { once: true })
            }
          }),
        )
      }
      await Promise.race(flushRacers)
    } finally {
      if (flushTimer !== undefined) clearTimeout(flushTimer)
      if (signalShortenTimer !== undefined) {
        clearTimeout(signalShortenTimer)
      }
      if (onClientAbort !== undefined) {
        signal?.removeEventListener('abort', onClientAbort)
      }
    }
  }

  let parsed: ParsedWaitInvocation
  try {
    parsed = parseWaitInvocation(argsArray)
  } catch (error) {
    if (error instanceof BackgroundSessionWaitError) {
      const result = baseWaitResult(null, 'selector_error', error.code)
      const code = finishEarly(result, hasJsonFlag(argsArray), error.message)
      await awaitPendingFlush(WAIT_POLL_INTERVAL_MS)
      return code
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
    pendingFlush = renderWaitResult(result, json, stdout, stderr)
    process.exitCode = 2
    await awaitPendingFlush(WAIT_POLL_INTERVAL_MS)
    return 2
  }

  const now = options.now ?? (() => performance.now())
  const pollIntervalMs = options.pollIntervalMs ?? WAIT_POLL_INTERVAL_MS
  const sleep = options.sleep ?? abortableSleep
  // Track each in-flight process lookup so every cancellation path
  // can await the inspector children's settlement before the waiter
  // returns (maintainer review 5948202472 on #2497). Settlement is
  // recorded per lookup promise: a shared flag would let an earlier
  // lookup's settlement mask a later lookup that is still pending, so
  // the cleanup wait could skip while that inspector is still active
  // (CodeRabbit #2497 review 5966284444). The lookup promise is the
  // settlement signal: the production lookup waits for the inspector
  // child's close before settling on abort (getProcessCommandAsync
  // passes awaitCloseOnAbort), so settlement proves the child has
  // exited; the await below still bounds the wait by one poll interval
  // for a child that never closes (CodeRabbit #2497 review 5957376769).
  // Defined before selector resolution so the exact-name liveness
  // gate's lookups are tracked too — a deadline or signal during
  // resolution must not return while that inspector child is still
  // alive either.
  const pendingLookups = new Set<Promise<string | null>>()
  const trackedGetProcessCommandAsync = async (
    pid: number,
    lookupOptions: { signal?: AbortSignal },
  ): Promise<string | null> => {
    const baseLookup = options.getProcessCommandAsync ?? getProcessCommandAsync
    const promise = baseLookup(pid, lookupOptions)
    pendingLookups.add(promise)
    void promise.then(
      () => {
        pendingLookups.delete(promise)
      },
      () => {
        pendingLookups.delete(promise)
      },
    )
    return promise
  }
  const awaitPendingLookup = async (): Promise<void> => {
    if (pendingLookups.size === 0) return
    // Join every outstanding lookup within one shared cleanup budget:
    // a snapshot, so a lookup that starts during the wait cannot
    // extend it, and one budget for all of them, so the waiter still
    // returns promptly when several inspectors are outstanding.
    const pending = [...pendingLookups]
    await Promise.race([
      Promise.allSettled(pending).then(
        () => undefined,
        () => undefined,
      ),
      new Promise(resolve => setTimeout(resolve, pollIntervalMs)),
    ])
  }
  // Thread the waiter's liveness probes into selector resolution, so the
  // exact-name liveness gate in resolveBackgroundSessionForWait uses the
  // same probes as the poll loop (maintainer review 5948202472 on #2497).
  // The gate also gets the combined client-or-deadline lookup signal, so
  // a slow resolution probe is aborted when the waiter is interrupted or
  // the deadline expires instead of outliving the waiter (CodeRabbit
  // #2497 review 5950772048).
  const resolveSession =
    options.resolveSession ??
    ((target: string) =>
      resolveBackgroundSessionForWait(target, {
        isProcessAlive: options.isProcessAlive,
        signalProcess: options.signalProcess,
        getProcessCommandAsync: trackedGetProcessCommandAsync,
        signal: lookupSignal,
      }))

  // Install the waiting-client signal listeners immediately after argument
  // validation and before any selector or metadata I/O. The first signal
  // wins; neither signal is forwarded to the background session.
  let clientSignal: 'SIGINT' | 'SIGTERM' | null = null
  const abortController = new AbortController()
  // The deadline signal aborts only the in-flight process lookup (see
  // the grace branch below): the lookup's `ps` child is killed by the
  // abort, so no lookup child survives after the waiter returns, while
  // the registry reads keep the client signal only. Combined with the
  // client signal so an interruption still aborts a slow lookup, as
  // before (maintainer review 5942761094 on #2497).
  const deadlineAbortController = new AbortController()
  const lookupSignal = AbortSignal.any([
    abortController.signal,
    deadlineAbortController.signal,
  ])
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

  // Finishes a timeout outcome, then reclassifies it when a client
  // signal was recorded during the pending flush: a signal that lands
  // after the timeout result was selected but before its JSON leaves a
  // back-pressured stdout still interrupts the waiter (130/143) — it
  // does not merely shorten the flush (maintainer review 5964758980
  // on #2497). The timeout line was already submitted to stdout, so
  // the interrupted result is rendered after it, not in place of it:
  // the output carries both lines and the last line is the waiter's
  // outcome. That cutoff — the timeout outcome commits when its write
  // starts — is the direct consequence of the maintainer-required
  // reclassification; emitting strictly one JSON object would require
  // either dropping that reclassification or delaying every
  // unsignalled timeout until the signal window closes, so the
  // single-object contract needs maintainer agreement before it can
  // be tightened (CodeRabbit #2497 review 5966284444). The
  // reclassified render's flush is awaited below, bounded by one poll
  // interval, so a consumer that never drains still cannot stall the
  // waiter; the finally below flushes the timeout render it captured
  // when the poll loop returned. An unsignalled timeout keeps today's
  // longer flush bound and returns 124.
  const finishTimeout = async (
    result: WaitResult,
    humanMessage?: string,
  ): Promise<number> => {
    finish(result, humanMessage)
    await awaitPendingFlush(TIMEOUT_FLUSH_BOUND_MS, abortController.signal)
    if (clientSignal !== null) {
      // A `return finishTimeout(...)` in the poll loop runs the
      // handler's finally before this reclassification completes, so
      // the finally's flush wait captured the timeout render, not
      // this one: await the interrupted render's flush here, bounded
      // by one poll interval, or the CLI fast path could exit before
      // the selected result's line reaches the consumer (CodeRabbit
      // #2497 review 5966284444).
      const code = finish(interruptedWaitResult(result.id, clientSignal))
      await awaitPendingFlush(WAIT_POLL_INTERVAL_MS)
      return code
    }
    return waitExitCode(result)
  }

  const lookupDeps: WaitHandlerOptions = {
    ...options,
    getProcessCommandAsync: trackedGetProcessCommandAsync,
  }

  // One last re-read of the pinned session at the timeout boundary: a
  // terminal fact published while an observation was still settling
  // (a lookup whose inspector close lagged, or a stalled registry read)
  // must win over the timeout, or the waiter reports a false 124 for a
  // session that already finished. The read is bounded by one poll
  // interval, so a stalled read still settles as a timeout. A strict
  // metadata failure (missing, unreadable, malformed, or replaced) is
  // returned as an observation error, not swallowed: the boundary must
  // report exit 4 for it, like the main poll loop does (maintainer
  // review 5964758980 and CodeRabbit #2497 review 5963778469 on #2497).
  // An unexpected (non-wait) read failure still settles as a timeout,
  // as before. A read that never settles within one poll interval
  // returns null, distinct from an error, so callers can tell an
  // unsettled read from a failed one. Uses the caller's pinned reader
  // when one is injected, so tests can observe the same re-read the
  // production path makes.
  const readTerminalAtTimeoutBoundary = async (
    pinned: { id: string; pid: number },
    deps: WaitHandlerOptions,
  ): Promise<WaitObservation | null> => {
    const readPinned =
      deps.readPinnedSession ?? readPinnedBackgroundSessionForWait
    let readTimer: ReturnType<typeof setTimeout> | undefined
    try {
      const read = await Promise.race([
        readPinned(pinned).then(
          session => ({ kind: 'session' as const, session }),
          (error: unknown) =>
            error instanceof BackgroundSessionWaitError
              ? { kind: 'metadata_error' as const, error }
              : null,
        ),
        new Promise<null>(resolve => {
          readTimer = setTimeout(() => resolve(null), pollIntervalMs)
        }),
      ])
      if (read === null) return null
      if (read.kind === 'metadata_error') return read
      return isTerminalBackgroundSession(read.session) &&
        read.session.status !== 'stale'
        ? terminalObservation(read.session)
        : null
    } finally {
      if (readTimer !== undefined) clearTimeout(readTimer)
    }
  }

  // One final observation at the timeout boundary, with its own lookup
  // signal that the deadline abort has not fired on. Returns null when
  // the fresh lookup never settles within one poll interval (a stalled
  // read, reported as a timeout). The fresh lookup is aborted on grace
  // expiry so its `ps` child is killed; the tracked-lookup await in the
  // finally below reaps it before the waiter returns.
  const finalTimeoutObservation = async (
    pinned: { id: string; pid: number },
    deps: WaitHandlerOptions,
  ): Promise<WaitObservation | null> => {
    const finalLookupController = new AbortController()
    const finalLookupSignal = AbortSignal.any([
      abortController.signal,
      finalLookupController.signal,
    ])
    let finalTimer: ReturnType<typeof setTimeout> | undefined
    const finalExpired = new Promise<null>(resolve => {
      finalTimer = setTimeout(() => resolve(null), pollIntervalMs)
    })
    try {
      const settled = await Promise.race([
        observePinnedSession(
          pinned,
          abortController.signal,
          deps,
          finalLookupSignal,
        ),
        finalExpired,
      ])
      if (settled === null) {
        finalLookupController.abort()
        // A terminal fact or a strict metadata failure found by the
        // boundary re-read wins over the timeout; a read that never
        // settles returns null (CodeRabbit #2497 review 5963778469).
        const boundary = await readTerminalAtTimeoutBoundary(pinned, deps)
        if (boundary !== null) return boundary
        return null
      }
      return settled
    } finally {
      if (finalTimer !== undefined) clearTimeout(finalTimer)
    }
  }

  // The pinned id is hoisted so an unexpected failure after pinning can
  // still name the session in its structured error result; null when the
  // failure happened during selector resolution.
  let pinnedId: string | null = null
  // Set when the deadline fires during selector resolution: the
  // resolution lookup is aborted by the deadline signal (see the
  // DEADLINE_EXPIRED branch above), and the finally below still awaits
  // the inspector child's close as a safety net.
  let deadlineExpiredDuringResolution = false
  // The deadline timer is hoisted so the finally below can clear it on
  // every exit path.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined

  try {
    // The deadline starts from a monotonic clock after argument validation.
    const deadline =
      parsed.timeoutMs === undefined ? null : now() + parsed.timeoutMs

    // Arm the deadline timer when the wait begins, so a stalled registry
    // read settles as a timeout instead of blocking the waiter until a
    // signal arrives. The timer is cleared in the finally below. The
    // deadline is a signal (not a shared promise) so each poll's race
    // attaches exactly one listener and removes it on settle.
    const deadlineController =
      parsed.timeoutMs === undefined ? null : new AbortController()
    if (deadlineController !== null) {
      deadlineTimer = setTimeout(
        () => deadlineController.abort(),
        parsed.timeoutMs!,
      )
    }

    let session: BackgroundSession
    try {
      const resolved = await raceWithDeadline(
        raceWithClientSignal(
          resolveSession(parsed.selector!),
          abortController.signal,
        ),
        deadlineController?.signal ?? null,
      )
      if (resolved === DEADLINE_EXPIRED) {
        deadlineExpiredDuringResolution = true
        // Abort the in-flight resolution lookup as well: its `ps` child
        // is killed by the lookup signal, so the finally below reaps it
        // promptly instead of waiting out the poll-interval bound
        // (CodeRabbit #2497 review 5950772048).
        deadlineAbortController.abort()
        return finishTimeout(
          baseWaitResult(null, 'timeout', 'timeout'),
          'Timed out waiting for a background session.',
        )
      }
      session = resolved
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
    pinnedId = pinned.id

    // No signal check at the top of the loop: the pre-loop check above
    // covers entry, and each await in the body (observe, sleep) is
    // followed by a signal check before control reaches here again, so a
    // check here could never be true (CodeQL #2497).
    while (true) {
      let observation: WaitObservation
      try {
        const observationPromise = observePinnedSession(
          pinned,
          abortController.signal,
          lookupDeps,
          lookupSignal,
        )
        const raced = await raceWithDeadline(
          observationPromise,
          deadlineController?.signal ?? null,
        )
        if (raced === DEADLINE_EXPIRED) {
          // The deadline elapsed while this observation was in flight:
          // abort the in-flight process lookup first, so a slow `ps`
          // cannot outlive the waiter and its child is killed, then give
          // the observation one poll interval to settle and classify the
          // boundary from what it observed. A stalled registry read is
          // unaffected by the abort — the reads keep the client signal —
          // so it still settles as 124 via the grace timer below.
          // The grace timer is cleared in a finally, so it cannot leak
          // when the observation rejects or a signal lands mid-grace.
          deadlineAbortController.abort()
          let graceTimer: ReturnType<typeof setTimeout> | undefined
          const graceExpired = new Promise<null>(resolve => {
            graceTimer = setTimeout(() => resolve(null), pollIntervalMs)
          })
          let late: WaitObservation | null
          try {
            late = await Promise.race([observationPromise, graceExpired])
          } finally {
            if (graceTimer !== undefined) clearTimeout(graceTimer)
          }
          if (late === null) {
            // A client signal that arrived while the grace timer ran
            // takes precedence over the timeout: the waiter was
            // interrupted (130/143), not merely slow (124). The same
            // check guards the final-observation timeout below
            // (CodeRabbit #2497 review 5950772048).
            if (clientSignal) {
              return finish(interruptedWaitResult(pinned.id, clientSignal))
            }
            // The observation never settled, so a metadata-only
            // re-read cannot classify the boundary: run one final
            // complete observation instead. A terminal fact published
            // while it was pending wins, a pinned metadata failure
            // reports exit 4, and a genuinely unreadable process
            // reports exit 3 — the deadline table's outcomes — while
            // a fresh observation that never settles either is still
            // a timeout (124), as in the aborted branch below
            // (maintainer review 5964758980 on #2497). A client
            // signal received during that final observation takes
            // precedence over the timeout, as below.
            const finalObservation =
              await finalTimeoutObservation(pinned, lookupDeps)
            if (finalObservation === null) {
              if (clientSignal) {
                return finish(interruptedWaitResult(pinned.id, clientSignal))
              }
              return finishTimeout({
                ...baseWaitResult(pinned.id, 'timeout', 'timeout'),
                status: 'running',
              })
            }
            observation = finalObservation
          } else if (
            late.kind === 'aborted' ||
            late.kind === 'running' ||
            late.kind === 'unknown'
          ) {
            // An aborted in-flight lookup never observed the process,
            // so its classification is meaningless; a running result
            // settled from a pre-deadline lookup can likewise be
            // stale — the child may have exited in the meantime
            // without publishing a terminal fact. An unknown result
            // is no better: its null came from a pre-deadline lookup
            // that ran before the second metadata read finished, so
            // a transiently unreadable command can read as a
            // permanently unreadable process. Run one final
            // observation with a fresh lookup signal that is not
            // self-cancelled, bounded by one poll interval: terminal
            // wins, a genuinely unreadable process returns 3, and a
            // child that is still alive returns 124 (maintainer
            // review 5964758980 and CodeRabbit #2497 reviews
            // 5963778469 and 5966284444 on #2497).
            const finalObservation =
              await finalTimeoutObservation(pinned, lookupDeps)
            if (finalObservation === null) {
              // As above: a client signal received during the pending
              // final lookup takes precedence over the timeout (124).
              if (clientSignal) {
                return finish(interruptedWaitResult(pinned.id, clientSignal))
              }
              return finishTimeout({
                ...baseWaitResult(pinned.id, 'timeout', 'timeout'),
                status: 'running',
              })
            }
            observation = finalObservation
          } else {
            observation = late
          }
        } else {
          observation = raced
        }
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
      // observation classifies as a timeout (124) or unknown (3). An
      // 'aborted' observation reaching here was cut short without
      // observing the process, so it falls through to the timeout below
      // (124), never to the unreadable outcome (3).
      if (deadline !== null && now() >= deadline) {
        if (observation.kind === 'unknown') {
          return finish({
            ...baseWaitResult(pinned.id, 'observation_error', 'process_unreadable'),
            status: 'unknown',
          })
        }
        return finishTimeout({
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
    // Unexpected internal failures (e.g. a home-directory lookup failing
    // during selector resolution) are reported as a structured error
    // result, not as a bare stderr line: scripts must not mistake them
    // for a child failure (exit 1), and JSON consumers must still get a
    // parseable object. The human message keeps today's `Error: ...` line.
    const result = baseWaitResult(pinnedId, 'internal_error', 'internal_error')
    return finish(result, `Error: ${errorMessage(error)}`)
  } finally {
    // On a cancellation path (client signal, deadline abort, or
    // deadline expiry during selector resolution), do not return while
    // the inspector child may still be alive: await the in-flight
    // lookup's settlement within one poll interval first.
    if (
      clientSignal !== null ||
      deadlineAbortController.signal.aborted ||
      deadlineExpiredDuringResolution
    ) {
      await awaitPendingLookup()
    }
    // Do not return while the rendered result is still queued in a
    // back-pressured stdout pipe: the CLI fast path exits with 124/130/
    // 143 right after this handler resolves, which would discard it.
    // A client signal does not abandon this wait: with --json the
    // rendered line is the waiter's one mandatory JSON object, and
    // exiting before it is written would break that contract. An
    // unsignalled timeout gets the longer TIMEOUT_FLUSH_BOUND_MS so a
    // slow-but-live consumer still receives that one mandatory object;
    // a failed write settles at once, so the longer bound only waits
    // out a queued write. Every other path keeps the one-production-
    // poll-interval bound, and a client signal arriving during an
    // unsignalled-timeout flush caps the remaining wait at one poll
    // interval from the signal — so a consumer that never drains
    // cannot block the waiter indefinitely, and a signal during the
    // flush still delays the return by at most that (CodeRabbit #2497
    // reviews 5952674466 and 5957376769). The bounds use the
    // production poll interval, not the caller's pollIntervalMs: the
    // latter is a lookup-polling knob that tests accelerate to 10 ms,
    // far shorter than a back-pressured drain or a slow write
    // callback, and the flush bound must give a live consumer time to
    // drain. The rendered result keeps the exit code finish() already
    // set. The wait itself lives in awaitPendingFlush above, which the
    // pre-poll returns share (maintainer review 5962625271 on #2497).
    // A timeout result reclassified by finishTimeout already rendered
    // its interrupted replacement: this await only flushes that render,
    // bounded by one poll interval as for every other outcome.
    if (pendingFlush !== null) {
      const finished = finishedState.result
      const unsignalledTimeout =
        finished !== null &&
        finished.waitResult === 'timeout' &&
        clientSignal === null
      const flushBoundMs = unsignalledTimeout
        ? TIMEOUT_FLUSH_BOUND_MS
        : WAIT_POLL_INTERVAL_MS
      // A signal during the flush shortens the remaining wait to one
      // poll interval instead of abandoning the flush: the timeout
      // result (124) is already selected, and the waiter must still
      // return promptly on SIGINT/SIGTERM.
      await awaitPendingFlush(
        flushBoundMs,
        unsignalledTimeout ? abortController.signal : undefined,
      )
    }
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
  }
}
