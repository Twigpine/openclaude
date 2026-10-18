import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import { basename } from 'node:path'
import treeKill from 'tree-kill'
import {
  argsBeforeDelimiter,
  parseModelFlagValue,
} from '../utils/cliArgs.js'
import {
  argsBeforeModelOwningSubcommand,
  hasPrintFlag,
  parseRootOptionValue,
} from '../utils/printFlag.js'
import { isProcessRunning } from '../utils/genericProcessUtils.js'
import {
  assertBackgroundSessionNameAvailable,
  backgroundSessionLogExists,
  createBackgroundSession,
  ensureBackgroundSessionDirs,
  getBackgroundSessionLogPaths,
  listBackgroundSessions,
  markBackgroundSessionKilled,
  refreshBackgroundSessionStatuses,
  resolveBackgroundSession,
  getBackgroundSessionProcessLiveness,
  isTerminalBackgroundSession,
  verifyBackgroundSessionProcessIdentity,
  type BackgroundSession,
  type BackgroundSessionProcessIdentity,
  type BackgroundSessionProcessIdentityOptions,
} from './bgRegistry.js'
import {
  backgroundProcessMarkerToken,
  BACKGROUND_SESSION_ID_ENV,
  BACKGROUND_SESSION_LAUNCHER_PID_ENV,
  generateBackgroundProcessMarker,
  stripBackgroundProcessMarkerArgs,
} from './bgRouting.js'

export type ParsedBackgroundInvocation = {
  name?: string
  prompt?: string
  childArgs: string[]
}

export type ParsedLogsInvocation = {
  target?: string
  follow: boolean
  stream: 'stdout' | 'stderr'
}

export type BackgroundChildProcessConfig = {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

export type BuildBackgroundChildProcessConfigInput = {
  execPath: string
  execArgv: string[]
  entrypoint: string
  childArgs: string[]
  processEnv: NodeJS.ProcessEnv
  sessionName?: string
  stdoutLogPath: string
  backgroundSessionId: string
  processMarker: string
  launcherPid?: number
}

type PrResumeSelector = true | string

export type BuildBackgroundSessionLaunchDeps = {
  resolvePrResumeSessionId?: (
    selector: PrResumeSelector,
  ) => Promise<string | null | undefined>
}

const HEAP_RELAUNCHED_ENV = 'OPENCLAUDE_HEAP_RELAUNCHED'
const HEAP_SIZE_ENV = 'OPENCLAUDE_NODE_MAX_OLD_SPACE_SIZE_MB'
const DEFAULT_HEAP_SIZE_MB = 8192
const DEFAULT_TERM_GRACE_MS = 2_000
const DEFAULT_KILL_GRACE_MS = 2_000
const DEFAULT_KILL_POLL_INTERVAL_MS = 100
// Each background-log read buffer is capped at 64 KiB to avoid whole-log allocations.
export const LOG_STREAM_CHUNK_SIZE = 64 * 1024
const LOG_FOLLOW_POLL_INTERVAL_MS = 500

type LogOutput = {
  destroyed?: boolean
  writableDestroyed?: boolean
  write(chunk: Uint8Array): boolean
  once(event: string, listener: (...args: unknown[]) => void): unknown
  off(event: string, listener: (...args: unknown[]) => void): unknown
}

type LogFileHandle = {
  close(): Promise<void>
  stat(): Promise<{ size: number }>
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>
}

type LogFollowTimer = ReturnType<typeof setInterval> | number

type StreamLogOptions = {
  output?: LogOutput
  chunkSize?: number
  createBuffer?: (size: number) => Buffer
  signal?: AbortSignal
  openFile?: (path: string, flags: 'r') => Promise<LogFileHandle>
  continueOnFileError?: boolean
}

type FollowLogOptions = StreamLogOptions & {
  pollIntervalMs?: number
  setInterval?: (callback: () => void, ms: number) => LogFollowTimer
  clearInterval?: (timer: LogFollowTimer) => void
}

type StreamLogResult = {
  position: number
  outputOpen: boolean
}

// This must stay in sync with value-consuming CLI flags in main.tsx and related
// handlers. If the CLI flag definitions become centralized, move this parser
// metadata there instead of maintaining a second hand-written list.
const REQUIRED_OPTION_VALUE_FLAGS = new Set([
  '--add-dir',
  '--agent',
  '--agents',
  '--allowed-tools',
  '--allowedTools',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--betas',
  '--debug-file',
  '--disallowed-tools',
  '--disallowedTools',
  '--effort',
  '--fallback-model',
  '--file',
  '--input-format',
  '--json-schema',
  '--max-budget-usd',
  '--max-turns',
  '--mcp-config',
  '--model',
  '--name',
  '--output-format',
  '--permission-mode',
  '--permission-prompt-tool',
  '--plugin-dir',
  '--prefill',
  '--provider',
  '--provider-env-file',
  '--resume-session-at',
  '--rewind-files',
  '--session-id',
  '--setting-sources',
  '--settings',
  '--system-prompt',
  '--system-prompt-file',
  '--task-budget',
  '--tools',
  '--workload',
  '-n',
])

const INLINE_OPTIONAL_VALUE_FLAGS = new Set([
  '--debug',
  '-d',
])

const SPACE_OPTIONAL_VALUE_FLAGS = new Set([
  '--from-pr',
  '--resume',
  '-r',
])

function isNodeExecutable(execPath: string): boolean {
  return /^node(?:\.exe)?$/i.test(basename(execPath))
}

function hasNodeFlag(args: string[], flag: string): boolean {
  return args.some(arg => arg === flag || arg.startsWith(`${flag}=`))
}

function hasHeapLimitFlag(args: string[]): boolean {
  return (
    hasNodeFlag(args, '--max-old-space-size') ||
    hasNodeFlag(args, '--max-old-space-size-percentage')
  )
}

function keepBackgroundNodeExecArg(arg: string): boolean {
  return (
    arg === '--expose-gc' ||
    arg.startsWith('--max-old-space-size') ||
    arg.startsWith('--heapsnapshot-near-heap-limit')
  )
}

function isValueTakingHeapExecArg(arg: string): boolean {
  return (
    arg === '--max-old-space-size' ||
    arg === '--max-old-space-size-percentage' ||
    arg === '--heapsnapshot-near-heap-limit'
  )
}

function safeNodeExecArgvForBackground(
  execPath: string,
  execArgv: string[],
  processEnv: NodeJS.ProcessEnv,
): string[] {
  const safeArgs: string[] = []
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i]
    if (!keepBackgroundNodeExecArg(arg)) continue
    safeArgs.push(arg)
    const next = execArgv[i + 1]
    if (isValueTakingHeapExecArg(arg) && next && !next.startsWith('-')) {
      i += 1
      safeArgs.push(next)
    }
  }
  if (!isNodeExecutable(execPath)) return safeArgs

  const nodeOptions = (processEnv.NODE_OPTIONS ?? '')
    .split(/\s+/)
    .filter(Boolean)
  const effectiveArgs = [...safeArgs, ...nodeOptions]
  if (!hasHeapLimitFlag(effectiveArgs)) {
    const configuredHeap = Number.parseInt(processEnv[HEAP_SIZE_ENV] ?? '', 10)
    const heapSize =
      Number.isSafeInteger(configuredHeap) && configuredHeap > 0
        ? configuredHeap
        : DEFAULT_HEAP_SIZE_MB
    safeArgs.push(`--max-old-space-size=${heapSize}`)
  }
  if (!hasNodeFlag(effectiveArgs, '--expose-gc')) {
    safeArgs.push('--expose-gc')
  }
  return safeArgs
}

export function buildBackgroundChildProcessConfig(
  input: BuildBackgroundChildProcessConfigInput,
): BackgroundChildProcessConfig {
  const env: NodeJS.ProcessEnv = {
    ...input.processEnv,
    CLAUDE_CODE_ENTRYPOINT: 'bg',
    CLAUDE_CODE_SESSION_KIND: 'bg',
    CLAUDE_CODE_SESSION_LOG: input.stdoutLogPath,
    ...(input.sessionName
      ? { CLAUDE_CODE_SESSION_NAME: input.sessionName }
      : {}),
    [BACKGROUND_SESSION_ID_ENV]: input.backgroundSessionId,
    [BACKGROUND_SESSION_LAUNCHER_PID_ENV]: String(
      input.launcherPid ?? process.pid,
    ),
  }
  // Keep the registered detached PID stable under every runtime. The installed
  // launcher otherwise relaunches itself before finalizer ownership is checked.
  // Node-only heap flags are still supplied by safeNodeExecArgvForBackground.
  env[HEAP_RELAUNCHED_ENV] = '1'
  const childArgs = stripBackgroundProcessMarkerArgs(input.childArgs)

  return {
    command: input.execPath,
    args: [
      ...safeNodeExecArgvForBackground(
        input.execPath,
        input.execArgv,
        input.processEnv,
      ),
      input.entrypoint,
      backgroundProcessMarkerToken(input.processMarker),
      ...childArgs,
    ],
    env,
  }
}

function fail(message: string): never {
  console.error(`Error: ${message}`)
  process.exit(1)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function resolveSessionOrExit(target: string) {
  try {
    return await resolveBackgroundSession(target)
  } catch (error) {
    fail(errorMessage(error))
  }
}

function stripBackgroundFlag(args: string[]): string[] {
  const delimiterIndex = args.indexOf('--')
  const head = delimiterIndex === -1 ? args : args.slice(0, delimiterIndex)
  const tail = delimiterIndex === -1 ? [] : args.slice(delimiterIndex)
  return [
    ...head.filter(arg => arg !== '--bg' && arg !== '--background'),
    ...tail,
  ]
}

function findPromptIndex(args: string[]): number {
  const dashDash = args.indexOf('--')
  if (dashDash !== -1) {
    return dashDash + 1 < args.length ? dashDash + 1 : -1
  }

  const consumedValues = new Set<number>()
  for (let i = 0; i < args.length - 1; i++) {
    const arg = args[i]
    if (REQUIRED_OPTION_VALUE_FLAGS.has(arg)) {
      consumedValues.add(i + 1)
      i++
      continue
    }
    if (SPACE_OPTIONAL_VALUE_FLAGS.has(arg)) {
      const next = args[i + 1]
      if (next && !next.startsWith('-')) {
        consumedValues.add(i + 1)
        i++
      }
      continue
    }
    if (INLINE_OPTIONAL_VALUE_FLAGS.has(arg)) {
      // Keep debug filters inline-only here so `--debug "prompt"` remains a
      // background prompt instead of being consumed as a logging filter.
      continue
    }
  }

  for (let i = args.length - 1; i >= 0; i--) {
    if (consumedValues.has(i)) continue
    const arg = args[i]
    if (arg === '--') continue
    if (!arg.startsWith('-')) return i
  }
  return -1
}

function findFlagValue(args: string[], flag: string): string | undefined {
  const inlinePrefix = `${flag}=`
  const searchable = argsBeforeDelimiter(args)
  for (let i = 0; i < searchable.length; i++) {
    const arg = searchable[i]
    if (arg.startsWith(inlinePrefix)) return arg.slice(inlinePrefix.length)
    if (
      arg === flag &&
      i + 1 < searchable.length &&
      !searchable[i + 1]?.startsWith('-')
    ) {
      return searchable[i + 1]
    }
  }
  return undefined
}

function findSessionName(args: string[]): string | undefined {
  return findFlagValue(args, '--name') ?? findFlagValue(args, '-n')
}

/**
 * Background session metadata must record the same root `--model` that CLI
 * startup applies. Nested `aimlapi topup` / `auto-mode critique` flags are not
 * the session model.
 */
export function resolveBackgroundSessionModel(
  childArgs: readonly string[],
): string | undefined {
  return parseModelFlagValue(argsBeforeModelOwningSubcommand(childArgs))
}

/** Keep registry metadata aligned with the provider selected by CLI startup. */
export function resolveBackgroundSessionProvider(
  childArgs: readonly string[],
): string | undefined {
  return parseRootOptionValue(childArgs, '--provider')
}

function hasPrintMode(args: string[]): boolean {
  return hasPrintFlag(args)
}

function insertBeforePrompt(args: string[], values: string[]): string[] {
  const next = [...args]
  const delimiterIndex = next.indexOf('--')
  const insertionIndex =
    delimiterIndex === -1
      ? findPromptIndex(next)
      : delimiterIndex
  next.splice(insertionIndex === -1 ? next.length : insertionIndex, 0, ...values)
  return next
}

function withGeneratedSessionId(args: string[], sessionId: string): string[] {
  if (findFlagValue(args, '--session-id')) return args
  return insertBeforePrompt(args, ['--session-id', sessionId])
}

function hasForkSession(args: string[]): boolean {
  return argsBeforeDelimiter(args).includes('--fork-session')
}

function findFromPrSelector(args: string[]): PrResumeSelector | undefined {
  const searchable = argsBeforeDelimiter(args)
  const inlinePrefix = '--from-pr='
  for (let i = 0; i < searchable.length; i++) {
    const arg = searchable[i]
    if (arg.startsWith(inlinePrefix)) {
      return arg.slice(inlinePrefix.length) || true
    }
    if (arg === '--from-pr') {
      const next = searchable[i + 1]
      return next && !next.startsWith('-') ? next : true
    }
  }
  return undefined
}

function hasResumeSource(args: string[]): boolean {
  return Boolean(
    findFlagValue(args, '--resume') ??
      findFlagValue(args, '-r') ??
      findFromPrSelector(args),
  )
}

async function resolvePrResumeSessionId(
  selector: PrResumeSelector,
  deps: BuildBackgroundSessionLaunchDeps,
): Promise<string | null | undefined> {
  if (deps.resolvePrResumeSessionId) {
    return deps.resolvePrResumeSessionId(selector)
  }
  const { findResumeSessionIdByPrSelector } = await import(
    '../utils/conversationRecovery.js'
  )
  return findResumeSessionIdByPrSelector(selector)
}

export async function buildBackgroundSessionLaunch(
  childArgs: string[],
  generatedSessionId: string,
  deps: BuildBackgroundSessionLaunchDeps = {},
): Promise<{ childArgs: string[]; sessionId: string }> {
  const explicitSessionId = findFlagValue(childArgs, '--session-id')
  if (explicitSessionId) {
    return { childArgs, sessionId: explicitSessionId }
  }

  const resumeSessionId =
    findFlagValue(childArgs, '--resume') ?? findFlagValue(childArgs, '-r')
  if (resumeSessionId && !hasForkSession(childArgs)) {
    return { childArgs, sessionId: resumeSessionId }
  }

  const fromPrSelector = findFromPrSelector(childArgs)
  if (fromPrSelector !== undefined && !hasForkSession(childArgs)) {
    const sessionId = await resolvePrResumeSessionId(fromPrSelector, deps)
    if (!sessionId) {
      const description =
        fromPrSelector === true ? 'any PR' : `PR selector: ${fromPrSelector}`
      throw new Error(`No conversation found linked to ${description}`)
    }
    return { childArgs, sessionId }
  }

  return {
    childArgs: withGeneratedSessionId(childArgs, generatedSessionId),
    sessionId: generatedSessionId,
  }
}

export function parseBackgroundInvocation(
  args: string[],
): ParsedBackgroundInvocation {
  let childArgs = stripBackgroundProcessMarkerArgs(stripBackgroundFlag(args))
  const name = findSessionName(childArgs)?.trim() || undefined
  const promptIndex = findPromptIndex(childArgs)
  const prompt = promptIndex === -1 ? undefined : childArgs[promptIndex]

  if (!hasPrintMode(childArgs)) {
    childArgs = insertBeforePrompt(childArgs, ['--print'])
  }

  return {
    ...(name ? { name } : {}),
    ...(prompt ? { prompt } : {}),
    childArgs,
  }
}

export function parseLogsInvocation(args: string[]): ParsedLogsInvocation {
  let follow = false
  let stream: ParsedLogsInvocation['stream'] = 'stdout'
  let target: string | undefined

  for (const arg of args) {
    if (arg === '-f' || arg === '--follow') {
      follow = true
      continue
    }
    if (arg === '--stderr') {
      stream = 'stderr'
      continue
    }
    if (arg === '--stdout') {
      stream = 'stdout'
      continue
    }
    target ??= arg
  }

  return { target, follow, stream }
}

function backgroundSessionId(): string {
  return `bg-${randomUUID().slice(0, 8)}`
}

function formatCommand(command: string[]): string {
  return command
    .map(part => (/\s/.test(part) ? JSON.stringify(part) : part))
    .join(' ')
}

export function buildBackgroundSessionDisplayCommand(
  command: string[],
  processMarker: string,
): string[] {
  const markerToken = backgroundProcessMarkerToken(processMarker)
  const delimiterIndex = command.indexOf('--')
  const optionEnd = delimiterIndex === -1 ? command.length : delimiterIndex
  const markerIndex = command.findIndex(
    (arg, index) => index < optionEnd && arg === markerToken,
  )
  return markerIndex === -1
    ? [...command]
    : [...command.slice(0, markerIndex), ...command.slice(markerIndex + 1)]
}

function printSessionTable(
  sessions: Awaited<ReturnType<typeof listBackgroundSessions>>,
): void {
  if (sessions.length === 0) {
    console.log('No background sessions.')
    return
  }

  const rows = [
    ['ID', 'STATUS', 'PID', 'NAME', 'STARTED', 'CWD'],
    ...sessions.map(session => [
      session.id,
      session.status,
      String(session.pid),
      session.name ?? '-',
      session.startedAt,
      session.cwd,
    ]),
  ]
  const widths = rows[0].map((_, col) =>
    Math.max(...rows.map(row => row[col].length)),
  )

  for (const row of rows) {
    console.log(row.map((cell, i) => cell.padEnd(widths[i])).join('  '))
  }
}

function isOutputClosed(output: LogOutput): boolean {
  return output.destroyed === true || output.writableDestroyed === true
}

function normalizeChunkSize(chunkSize: number | undefined): number {
  if (!Number.isFinite(chunkSize) || !chunkSize || chunkSize < 1) {
    return LOG_STREAM_CHUNK_SIZE
  }
  return Math.floor(chunkSize)
}

async function waitForDrain(
  output: LogOutput,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (signal?.aborted || isOutputClosed(output)) return false

  return await new Promise<boolean>(resolve => {
    let settled = false

    const cleanup = () => {
      output.off('drain', onDrain)
      output.off('error', onError)
      output.off('close', onClose)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (open: boolean) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(open)
    }

    const onDrain = () => finish(!isOutputClosed(output))
    const onError = () => finish(false)
    const onClose = () => finish(false)
    const onAbort = () => finish(false)

    output.once('drain', onDrain)
    output.once('error', onError)
    output.once('close', onClose)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function writeLogBuffer(
  output: LogOutput,
  buffer: Buffer,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (buffer.length === 0) return true
  if (signal?.aborted || isOutputClosed(output)) return false

  try {
    if (output.write(buffer)) return !isOutputClosed(output)
  } catch {
    return false
  }

  return await waitForDrain(output, signal)
}

async function streamLogRange(
  handle: LogFileHandle,
  start: number,
  endExclusive: number,
  options: StreamLogOptions,
): Promise<StreamLogResult> {
  const output = options.output ?? process.stdout
  const chunkSize = normalizeChunkSize(options.chunkSize)
  const createBuffer = options.createBuffer ?? Buffer.allocUnsafe
  let position = start

  while (position < endExclusive) {
    if (options.signal?.aborted) return { position, outputOpen: false }
    const bytesToRead = Math.min(chunkSize, endExclusive - position)
    const buffer = createBuffer(bytesToRead)
    if (buffer.length < bytesToRead) {
      throw new Error('Log stream buffer factory returned a short buffer')
    }

    let bytesRead: number
    try {
      const readResult = await handle.read(buffer, 0, bytesToRead, position)
      bytesRead = readResult.bytesRead
    } catch (error) {
      if (!options.continueOnFileError) throw error
      return { position, outputOpen: true }
    }
    if (bytesRead <= 0) break
    if (options.signal?.aborted) return { position, outputOpen: false }

    const chunk =
      bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead)
    if (!(await writeLogBuffer(output, chunk, options.signal))) {
      return { position, outputOpen: false }
    }
    position += bytesRead
  }

  return { position, outputOpen: true }
}

async function streamLogSnapshot(
  path: string,
  offset: number,
  options: StreamLogOptions,
): Promise<StreamLogResult> {
  let handle: LogFileHandle
  try {
    handle = await (options.openFile ?? open)(path, 'r')
  } catch (error) {
    if (!options.continueOnFileError) throw error
    // Keep following; the child may create or rotate the file later.
    return { position: offset, outputOpen: true }
  }

  let result: StreamLogResult = { position: offset, outputOpen: true }
  try {
    const { size } = await handle.stat()
    const start = size < offset ? 0 : offset
    result =
      size <= start
        ? { position: start, outputOpen: true }
        : await streamLogRange(handle, start, size, options)
    return result
  } catch (error) {
    if (!options.continueOnFileError) throw error
    return result
  } finally {
    if (options.continueOnFileError) {
      await handle.close().catch(() => undefined)
    } else {
      await handle.close()
    }
  }
}

export async function printExistingLog(
  path: string,
  options: StreamLogOptions = {},
): Promise<number> {
  const result = await streamLogSnapshot(path, 0, options)
  return result.position
}

export async function followLogFile(
  path: string,
  offset: number,
  options: FollowLogOptions = {},
): Promise<void> {
  const output = options.output ?? process.stdout
  const cleanupController = new AbortController()
  let position = offset
  let reading = false
  let stopped = false
  let timer: LogFollowTimer | undefined
  let activePoll: Promise<void> | undefined

  await new Promise<void>(resolve => {
    const cleanup = () => {
      if (stopped) return
      stopped = true
      if (timer) (options.clearInterval ?? clearInterval)(timer)
      cleanupController.abort()
      process.off('SIGINT', cleanup)
      process.off('SIGTERM', cleanup)
      options.signal?.removeEventListener('abort', cleanup)
      const pendingPoll = activePoll
      if (pendingPoll) {
        void pendingPoll.finally(resolve)
      } else {
        resolve()
      }
    }

    const poll = () => {
      if (stopped || reading) return
      reading = true
      const pollPromise = (async () => {
        try {
          const result = await streamLogSnapshot(path, position, {
            ...options,
            output,
            signal: cleanupController.signal,
            continueOnFileError: true,
          })
          position = result.position
          if (!result.outputOpen) cleanup()
        } finally {
          reading = false
        }
      })()
      activePoll = pollPromise
      void pollPromise.finally(() => {
        if (activePoll === pollPromise) activePoll = undefined
      })
    }

    process.once('SIGINT', cleanup)
    process.once('SIGTERM', cleanup)
    if (options.signal?.aborted) {
      cleanup()
      return
    }
    options.signal?.addEventListener('abort', cleanup, { once: true })
    timer = (options.setInterval ?? setInterval)(
      poll,
      options.pollIntervalMs ?? LOG_FOLLOW_POLL_INTERVAL_MS,
    )
  })
}

function normalizeArgs(args: string[] | string | undefined): string[] {
  if (Array.isArray(args)) return args
  return args ? [args] : []
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function treeKillAsync(pid: number, signal: string | number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    treeKill(pid, signal, error => {
      if (error && isProcessRunning(pid)) {
        reject(error)
        return
      }
      // The process may exit naturally after the liveness check but before
      // tree-kill reaches it; that race is already the requested outcome.
      resolve()
    })
  })
}

async function waitForProcessExit(
  pid: number,
  options: {
    isProcessAlive: (pid: number) => boolean
    sleep: (ms: number) => Promise<void>
    graceMs: number
    pollIntervalMs: number
  },
): Promise<boolean> {
  const attempts = Math.max(
    1,
    Math.ceil(options.graceMs / options.pollIntervalMs),
  )
  for (let i = 0; i < attempts; i++) {
    if (!options.isProcessAlive(pid)) return true
    await options.sleep(options.pollIntervalMs)
  }
  return !options.isProcessAlive(pid)
}

export async function terminateBackgroundProcessTree(
  pid: number,
  options?: {
    isProcessAlive?: (pid: number) => boolean
    killTree?: (pid: number, signal: string | number) => Promise<void>
    sleep?: (ms: number) => Promise<void>
    termGraceMs?: number
    killGraceMs?: number
    pollIntervalMs?: number
    verifyBeforeSignal?: (
      pid: number,
      signal: string | number,
    ) => Promise<'matches' | 'not-running'>
  },
): Promise<void> {
  const isProcessAlive = options?.isProcessAlive ?? isProcessRunning
  const killTree = options?.killTree ?? treeKillAsync
  const sleepFn = options?.sleep ?? sleep
  const pollIntervalMs =
    options?.pollIntervalMs ?? DEFAULT_KILL_POLL_INTERVAL_MS

  if (options?.verifyBeforeSignal) {
    if ((await options.verifyBeforeSignal(pid, 'SIGTERM')) === 'not-running') {
      return
    }
  } else if (!isProcessAlive(pid)) {
    return
  }
  await killTree(pid, 'SIGTERM')
  if (
    await waitForProcessExit(pid, {
      isProcessAlive,
      sleep: sleepFn,
      graceMs: options?.termGraceMs ?? DEFAULT_TERM_GRACE_MS,
      pollIntervalMs,
    })
  ) {
    return
  }

  if ((await options?.verifyBeforeSignal?.(pid, 'SIGKILL')) === 'not-running') {
    return
  }
  await killTree(pid, 'SIGKILL')
  if (
    await waitForProcessExit(pid, {
      isProcessAlive,
      sleep: sleepFn,
      graceMs: options?.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
      pollIntervalMs,
    })
  ) {
    return
  }

  throw new Error(`Process ${pid} did not exit after SIGKILL`)
}

type BackgroundSessionTerminationOptions = BackgroundSessionProcessIdentityOptions & {
  killTree?: (pid: number, signal: string | number) => Promise<void>
  sleep?: (ms: number) => Promise<void>
  termGraceMs?: number
  killGraceMs?: number
  pollIntervalMs?: number
  verifySessionIdentity?: (
    session: BackgroundSession,
  ) => BackgroundSessionProcessIdentity
}

function unverifiedProcessError(
  session: BackgroundSession,
  reason: string,
): Error {
  const action =
    session.processMarker === undefined
      ? `This older background session could not be verified safely. Restart it to use stronger process identity, or terminate PID ${session.pid} manually after confirming ownership.`
      : 'Re-run `openclaude ps` and retry after confirming the session identity.'
  return new Error(
    `OpenClaude refused to signal an unverified process for background session ${session.id} (PID ${session.pid}): ${reason}. ${action}`,
  )
}

export async function terminateBackgroundSessionProcessTree(
  session: BackgroundSession,
  options: BackgroundSessionTerminationOptions = {},
): Promise<void> {
  const getLiveness = (pid: number) =>
    getBackgroundSessionProcessLiveness(pid, options)

  await terminateBackgroundProcessTree(session.pid, {
    ...options,
    isProcessAlive: pid => getLiveness(pid) !== 'not-running',
    verifyBeforeSignal: async pid => {
      const identity = verifySelectedBackgroundSessionIdentity(session, options)
      if (pid !== session.pid) {
        throw unverifiedProcessError(
          session,
          'the identity check did not correspond to the selected session and PID',
        )
      }
      return authorizeBackgroundSessionSignal(session, identity)
    },
  })
}

function verifySelectedBackgroundSessionIdentity(
  session: BackgroundSession,
  options: BackgroundSessionTerminationOptions,
): BackgroundSessionProcessIdentity {
  let identity: BackgroundSessionProcessIdentity
  if (options.verifySessionIdentity) {
    try {
      identity = options.verifySessionIdentity(session)
    } catch {
      throw unverifiedProcessError(
        session,
        'the live process identity could not be read',
      )
    }
  } else {
    identity = verifyBackgroundSessionProcessIdentity(session, options)
  }
  if (
    identity.backgroundSessionId !== session.id ||
    identity.pid !== session.pid
  ) {
    throw unverifiedProcessError(
      session,
      'the identity check did not correspond to the selected session and PID',
    )
  }
  return identity
}

function authorizeBackgroundSessionSignal(
  session: BackgroundSession,
  identity: BackgroundSessionProcessIdentity,
): 'matches' | 'not-running' {
  if (identity.state === 'not-running') return 'not-running'
  if (identity.state === 'matches') return 'matches'
  throw unverifiedProcessError(
    session,
    identity.state === 'mismatch'
      ? 'the PID now belongs to a different process'
      : 'the live process identity could not be read',
  )
}

export async function killBackgroundSession(
  session: BackgroundSession,
  options: BackgroundSessionTerminationOptions & {
    markKilled?: (session: BackgroundSession) => Promise<BackgroundSession>
  } = {},
): Promise<BackgroundSession> {
  const markKilled =
    options.markKilled ??
    (async (selected: BackgroundSession) =>
      await markBackgroundSessionKilled(selected.id))

  if (session.status !== 'stale' && isTerminalBackgroundSession(session)) {
    return await markKilled(session)
  }

  const identity = verifySelectedBackgroundSessionIdentity(session, options)
  const authorization = authorizeBackgroundSessionSignal(session, identity)
  if (
    authorization === 'matches' &&
    session.status === 'stale' &&
    session.processMarker === undefined
  ) {
    throw unverifiedProcessError(
      session,
      'this older session was already stale, so its PID ownership cannot be re-established safely',
    )
  }
  if (authorization === 'matches') {
    await terminateBackgroundSessionProcessTree(session, options)
  }

  return await markKilled(session)
}

type ConfirmBackgroundSessionLaunchOptions = {
  isProcessAlive?: (pid: number) => boolean
  refreshStatuses?: () => Promise<BackgroundSession[]>
  resolveSession?: (id: string) => Promise<BackgroundSession>
}

export async function confirmBackgroundSessionLaunch(
  session: BackgroundSession,
  options: ConfirmBackgroundSessionLaunchOptions = {},
): Promise<BackgroundSession> {
  if ((options.isProcessAlive ?? isProcessRunning)(session.pid)) return session

  await (options.refreshStatuses ?? refreshBackgroundSessionStatuses)()
  const resolved = await (
    options.resolveSession ?? resolveBackgroundSession
  )(session.id)
  if (resolved.status === 'stale') {
    throw new Error(
      `Background session ${session.id} exited before finalization was installed. ` +
        `Logs were retained at ${session.stdoutLogPath} and ${session.stderrLogPath}.`,
    )
  }
  return resolved
}

export async function psHandler(_args: string[]): Promise<void> {
  const sessions = await refreshBackgroundSessionStatuses()
  printSessionTable(sessions)
}

export async function logsHandler(
  args: string[] | string | undefined,
): Promise<void> {
  const parsed = parseLogsInvocation(normalizeArgs(args))
  if (!parsed.target) fail('Usage: openclaude logs <id-or-name> [-f]')

  await refreshBackgroundSessionStatuses()
  const session = await resolveSessionOrExit(parsed.target)
  const logPath =
    parsed.stream === 'stderr' ? session.stderrLogPath : session.stdoutLogPath

  if (!(await backgroundSessionLogExists(logPath))) {
    fail(`Log file does not exist: ${logPath}`)
  }

  let offset: number
  try {
    offset = await printExistingLog(logPath, {
      continueOnFileError: parsed.follow,
    })
  } catch (error) {
    fail(`Failed to read log file: ${errorMessage(error)}`)
  }
  if (parsed.follow) {
    await followLogFile(logPath, offset)
  }
}

export async function attachHandler(
  args: string[] | string | undefined,
): Promise<void> {
  const target = normalizeArgs(args)[0]
  if (!target) fail('Usage: openclaude attach <id-or-name>')

  await refreshBackgroundSessionStatuses()
  const session = await resolveSessionOrExit(target)
  console.error(
    `Attach is not implemented for local background sessions yet. Use \`openclaude logs ${session.id} -f\` to follow output.`,
  )
  process.exitCode = 1
}

export async function killHandler(
  args: string[] | string | undefined,
  options: { retentionSettingsReady?: boolean } = {},
): Promise<void> {
  const target = normalizeArgs(args)[0]
  if (!target) fail('Usage: openclaude kill <id-or-name>')

  await refreshBackgroundSessionStatuses()
  const session = await resolveSessionOrExit(target)
  const killed = await killBackgroundSession(session).catch(error => {
    fail(
      `Failed to kill background session ${session.id}: ${errorMessage(error)}`,
    )
  })
  if (options.retentionSettingsReady !== false) {
    try {
      const { runBackgroundSessionRetention } = await import(
        '../utils/cleanup.js'
      )
      await runBackgroundSessionRetention({
        trigger: 'explicit-kill',
        sessionId: killed.id,
      })
    } catch {
      // A retention failure must not replace the successful kill outcome.
    }
  }
  console.log(`Killed background session ${killed.id}.`)
}

export async function handleBgFlag(args: string[]): Promise<void> {
  const parsed = parseBackgroundInvocation(args)
  if (!parsed.prompt && !hasResumeSource(parsed.childArgs)) {
    fail('Usage: openclaude --bg [--name <name>] "<prompt>"')
  }

  try {
    await assertBackgroundSessionNameAvailable(parsed.name)
  } catch (error) {
    fail(errorMessage(error))
  }

  const id = backgroundSessionId()
  const processMarker = generateBackgroundProcessMarker()
  const { childArgs, sessionId } = await buildBackgroundSessionLaunch(
    parsed.childArgs,
    randomUUID(),
  ).catch(error => {
    fail(errorMessage(error))
  })
  const logPaths = getBackgroundSessionLogPaths(id)
  await ensureBackgroundSessionDirs()
  const entrypoint = process.argv[1]
  if (!entrypoint) {
    fail('Cannot determine OpenClaude entrypoint for background session')
  }
  const childConfig = buildBackgroundChildProcessConfig({
    execPath: process.execPath,
    execArgv: process.execArgv,
    entrypoint,
    childArgs,
    processEnv: process.env,
    sessionName: parsed.name,
    stdoutLogPath: logPaths.stdoutLogPath,
    backgroundSessionId: id,
    processMarker,
    launcherPid: process.pid,
  })

  let stdoutFd: number | undefined
  let stderrFd: number | undefined
  let createdStdoutLog = false
  let createdStderrLog = false
  const cleanupCreatedLogs = async () => {
    if (createdStdoutLog) await unlink(logPaths.stdoutLogPath).catch(() => {})
    if (createdStderrLog) await unlink(logPaths.stderrLogPath).catch(() => {})
  }
  let child
  try {
    stdoutFd = openSync(logPaths.stdoutLogPath, 'wx')
    createdStdoutLog = true
    stderrFd = openSync(logPaths.stderrLogPath, 'wx')
    createdStderrLog = true
    child = spawn(childConfig.command, childConfig.args, {
      cwd: process.cwd(),
      detached: true,
      env: childConfig.env,
      stdio: ['ignore', stdoutFd, stderrFd],
    })
    child.unref()
  } catch (error) {
    if (stdoutFd !== undefined) {
      closeSync(stdoutFd)
      stdoutFd = undefined
    }
    if (stderrFd !== undefined) {
      closeSync(stderrFd)
      stderrFd = undefined
    }
    await cleanupCreatedLogs()
    fail(`Failed to start background session: ${errorMessage(error)}`)
  } finally {
    if (stdoutFd !== undefined) closeSync(stdoutFd)
    if (stderrFd !== undefined) closeSync(stderrFd)
  }

  if (!child.pid) {
    await cleanupCreatedLogs()
    fail('Failed to start background session')
  }

  const command = [childConfig.command, ...childConfig.args]
  let session = await createBackgroundSession({
    id,
    name: parsed.name,
    pid: child.pid,
    cwd: process.cwd(),
    command,
    provider: resolveBackgroundSessionProvider(childArgs),
    model: resolveBackgroundSessionModel(childArgs),
    sessionId,
    processMarker,
    stdoutLogPath: logPaths.stdoutLogPath,
    stderrLogPath: logPaths.stderrLogPath,
    logFilesPrecreated: true,
  }).catch(async error => {
    await terminateBackgroundProcessTree(child.pid!).catch(() => {})
    await cleanupCreatedLogs()
    fail(errorMessage(error))
  })

  session = await confirmBackgroundSessionLaunch(session).catch(error => {
    fail(errorMessage(error))
  })

  console.log(
    isTerminalBackgroundSession(session)
      ? `Background session ${session.id} finished with status ${session.status}.`
      : `Started background session ${session.id}.`,
  )
  if (session.name) console.log(`Name: ${session.name}`)
  console.log(`PID: ${session.pid}`)
  console.log(`Logs: ${session.stdoutLogPath}`)
  console.log(`Follow: openclaude logs ${session.id} -f`)
  console.log(
    `Command: ${formatCommand(
      buildBackgroundSessionDisplayCommand([
        basename(childConfig.command),
        ...childConfig.args,
      ], processMarker),
    )}`,
  )
}
