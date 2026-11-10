import {
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  readdir,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
  type Stats,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import {
  getProcessCommand,
  getProcessCommandAsync,
  isProcessRunning,
} from '../utils/genericProcessUtils.js'
import * as lockfile from '../utils/lockfile.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import {
  backgroundProcessMarkerToken,
  isValidBackgroundProcessMarker,
} from './bgRouting.js'

export type BackgroundSessionStatus =
  | 'running'
  | 'unknown'
  | 'exited'
  | 'failed'
  | 'stale'
  | 'killed'

export type BackgroundSession = {
  id: string
  name?: string
  pid: number
  cwd: string
  status: BackgroundSessionStatus
  provider?: string
  model?: string
  sessionId: string
  processMarker?: string
  terminalFactGeneration?: string
  startedAt: string
  updatedAt: string
  command: string[]
  stdoutLogPath: string
  stderrLogPath: string
  finishedAt?: string
  exitCode?: number
  signal?: string
  terminalReason?: BackgroundSessionTerminalReason
}

export type BackgroundSessionTerminalReason =
  | 'exit_code'
  | 'signal'
  | 'explicit_kill'

type BackgroundSessionTerminalFact = {
  version: 1
  id: string
  pid: number
  generation?: string
  status: 'exited' | 'failed' | 'killed'
  finishedAt: string
  terminalReason: BackgroundSessionTerminalReason
  exitCode?: number
  signal?: string
}

export type BackgroundSessionNaturalTermination =
  | { exitCode: number; signal?: never }
  | { exitCode?: never; signal: string }

export type CreateBackgroundSessionInput = {
  id: string
  name?: string
  pid: number
  cwd: string
  command: string[]
  provider?: string
  model?: string
  sessionId: string
  processMarker?: string
  now?: Date
  stdoutLogPath?: string
  stderrLogPath?: string
  logFilesPrecreated?: boolean
}

type BackgroundSessionNameReservation = {
  name: string
  id: string
  creatorPid?: number
  createdAt?: string
}

export type BackgroundCleanupResult = {
  sessionsRemoved: number
  artifactsRemoved: number
  errors: number
}

const TERMINAL_STATUSES = new Set<BackgroundSessionStatus>([
  'exited',
  'failed',
  'stale',
  'killed',
])
const ALL_STATUSES = new Set<BackgroundSessionStatus>([
  'running',
  'unknown',
  ...TERMINAL_STATUSES,
])
const COMPLETED_STATUSES = new Set<BackgroundSessionStatus>([
  'exited',
  'failed',
  'killed',
])
const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/
// A publish writes its temp file and renames it within milliseconds, so a
// temp file older than this is almost never an in-flight publish. The grace
// period is only a cheap pre-filter: the per-ID lock is what protects an
// active publish, because a wall-clock jump can make a fresh temp file
// look older than the grace period (CodeRabbit #2497).
const ABANDONED_SESSION_TEMP_FILE_MIN_AGE_MS = 60 * 60 * 1000
// Temp files written by writeNewSession/replaceSessionFile are named
// `<id>.<pid>.<uuid>.tmp`; the id is everything before the numeric pid
// and the random UUID suffix, and the pid is the publishing process.
const SESSION_TEMP_FILE_RE =
  /^(.*)\.(\d+)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/

function sessionIdFromTempFileName(name: string): string | undefined {
  const match = SESSION_TEMP_FILE_RE.exec(name)
  if (!match) return undefined
  const id = match[1]
  return SAFE_ID_RE.test(id) ? id : undefined
}

function publisherPidFromTempFileName(name: string): number | undefined {
  const match = SESSION_TEMP_FILE_RE.exec(name)
  if (!match) return undefined
  const pid = Number(match[2])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

// Whether the process with this pid is alive. `process.kill(pid, 0)`
// performs no signal delivery; ESRCH means no such process, while EPERM
// means a process exists but cannot be signalled, which still proves it
// is alive. A pid reused by an unrelated process can only make cleanup
// keep a stale file for a later sweep, never remove a live one.
function isBackgroundSessionPublisherAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isErrno(error, 'EPERM')
  }
}
const SAFE_SIGNAL_RE = /^SIG[A-Z0-9]{1,24}$/
const BACKGROUND_RECOVERY_JOURNAL_ENTRY_LIMIT = 256
const BACKGROUND_RECOVERY_JOURNAL_RECORD_MAX_BYTES = 512
const BACKGROUND_RECOVERY_JOURNAL_VERSION = 1
const NAME_RESERVATION_LOCK_OPTIONS = {
  realpath: false,
  retries: {
    retries: 20,
    factor: 1,
    minTimeout: 5,
    maxTimeout: 25,
    randomize: true,
  },
} satisfies NonNullable<Parameters<typeof lockfile.lock>[1]>
const NAME_RESERVATION_SYNC_LOCK_OPTIONS = {
  realpath: false,
  retries: 0,
} satisfies NonNullable<Parameters<typeof lockfile.lockSync>[1]>
let backgroundSessionsRootForTesting: string | undefined

type BackgroundSessionRecoveryJournalIdentity = {
  dev: number
  ino: number
}

type BackgroundSessionRecoveryCursor = {
  version: typeof BACKGROUND_RECOVERY_JOURNAL_VERSION
  offset: number
} & BackgroundSessionRecoveryJournalIdentity

export type BackgroundSessionRecoveryTarget = {
  id: string
  generation?: string
}

export type BackgroundSessionRecoveryBatch = {
  sessionIds: string[]
  terminalFacts: BackgroundSessionRecoveryTarget[]
  commit: (
    retrySessionIds?: readonly string[],
    retryTerminalFacts?: readonly BackgroundSessionRecoveryTarget[],
  ) => Promise<void>
}

export type BackgroundSessionRecoverySnapshot = {
  retry: (targets: readonly BackgroundSessionRecoveryTarget[]) => Promise<void>
  commit: () => Promise<boolean>
}

export function _setBackgroundSessionsRootForTesting(
  root: string | undefined,
): void {
  backgroundSessionsRootForTesting = root?.normalize('NFC')
}

function getBackgroundSessionsRoot(): string {
  if (backgroundSessionsRootForTesting) {
    return backgroundSessionsRootForTesting
  }
  return join(getClaudeConfigHomeDir(), 'bg-sessions')
}

function getBackgroundSessionMetadataDir(): string {
  return join(getBackgroundSessionsRoot(), 'sessions')
}

function getBackgroundSessionLogsDir(): string {
  return join(getBackgroundSessionsRoot(), 'logs')
}

function getBackgroundSessionNamesDir(): string {
  return join(getBackgroundSessionsRoot(), 'names')
}

function getBackgroundSessionTerminalDir(): string {
  return join(getBackgroundSessionsRoot(), 'terminal')
}

function getBackgroundSessionRecoveryJournalPath(): string {
  return join(getBackgroundSessionsRoot(), '.recovery-journal')
}

function getBackgroundSessionRecoveryCursorPath(): string {
  return join(getBackgroundSessionsRoot(), '.recovery-cursor.json')
}

async function readDirectoryEntries(
  path: string,
  maxEntries?: number,
): Promise<Dirent<string>[]> {
  if (maxEntries === undefined) {
    return await readdir(path, { withFileTypes: true })
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) return []

  const entries: Dirent<string>[] = []
  const directory = await opendir(path)
  try {
    for await (const entry of directory) {
      entries.push(entry)
      if (entries.length >= maxEntries) break
    }
  } finally {
    try {
      await directory.close()
    } catch {
      // The async iterator closes the directory after exhaustion or break.
    }
  }
  return entries
}

async function withBackgroundRecoveryJournalLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(getBackgroundSessionsRoot(), { recursive: true, mode: 0o700 })
  const journalPath = getBackgroundSessionRecoveryJournalPath()
  const handle = await openVerifiedBackgroundRecoveryJournal('a')
  await handle.close()
  const release = await lockfile.lock(
    journalPath,
    NAME_RESERVATION_LOCK_OPTIONS,
  )
  try {
    return await operation()
  } finally {
    await release().catch(() => {})
  }
}

function withBackgroundRecoveryJournalLockSync<T>(operation: () => T): T {
  mkdirSync(getBackgroundSessionsRoot(), { recursive: true, mode: 0o700 })
  const journalPath = getBackgroundSessionRecoveryJournalPath()
  const journalFd = openVerifiedBackgroundRecoveryJournalSync('a')
  closeSync(journalFd)
  const release = lockfile.lockSync(
    journalPath,
    NAME_RESERVATION_SYNC_LOCK_OPTIONS,
  )
  try {
    return operation()
  } finally {
    try {
      release()
    } catch {}
  }
}

async function openVerifiedBackgroundRecoveryJournal(
  flags: 'a' | 'r' | 'r+',
): Promise<Awaited<ReturnType<typeof open>>> {
  const path = getBackgroundSessionRecoveryJournalPath()
  const handle = await open(path, flags, 0o600)
  try {
    const [pathIdentity, handleIdentity] = await Promise.all([
      lstat(path),
      handle.stat(),
    ])
    if (
      !pathIdentity.isFile() ||
      !handleIdentity.isFile() ||
      pathIdentity.dev !== handleIdentity.dev ||
      pathIdentity.ino !== handleIdentity.ino
    ) {
      throw new Error('Invalid background recovery journal')
    }
    return handle
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
}

function openVerifiedBackgroundRecoveryJournalSync(
  flags: 'a' | 'r' | 'r+',
): number {
  const path = getBackgroundSessionRecoveryJournalPath()
  const fd = openSync(path, flags, 0o600)
  try {
    const pathIdentity = lstatSync(path)
    const handleIdentity = fstatSync(fd)
    if (
      !pathIdentity.isFile() ||
      !handleIdentity.isFile() ||
      pathIdentity.dev !== handleIdentity.dev ||
      pathIdentity.ino !== handleIdentity.ino
    ) {
      throw new Error('Invalid background recovery journal')
    }
    return fd
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

function backgroundRecoveryJournalRecord(
  id: string,
  generation?: string,
): string | undefined {
  if (!SAFE_ID_RE.test(id)) return undefined
  if (
    generation !== undefined &&
    !isValidBackgroundProcessMarker(generation)
  ) {
    return undefined
  }
  const record = `${id}${generation === undefined ? '' : `~${generation}`}\n`
  return Buffer.byteLength(record) <=
    BACKGROUND_RECOVERY_JOURNAL_RECORD_MAX_BYTES
    ? record
    : undefined
}

async function enqueueBackgroundSessionRecovery(
  id: string,
  generation?: string,
): Promise<void> {
  await enqueueBackgroundSessionRecoveryTargets([{ id, generation }])
}

async function enqueueBackgroundSessionRecoveryTargets(
  targets: readonly BackgroundSessionRecoveryTarget[],
): Promise<void> {
  const records = [
    ...new Set(
      targets
        .map(target =>
          backgroundRecoveryJournalRecord(target.id, target.generation),
        )
        .filter((record): record is string => record !== undefined),
    ),
  ].join('')
  if (!records) return
  await withBackgroundRecoveryJournalLock(async () => {
    const handle = await openVerifiedBackgroundRecoveryJournal('a')
    try {
      await handle.writeFile(records)
      await handle.sync()
    } finally {
      await handle.close().catch(() => {})
    }
  })
}

function enqueueBackgroundSessionRecoverySync(
  id: string,
  generation?: string,
): void {
  const record = backgroundRecoveryJournalRecord(id, generation)
  if (!record) return
  withBackgroundRecoveryJournalLockSync(() => {
    const fd = openVerifiedBackgroundRecoveryJournalSync('a')
    try {
      writeFileSync(fd, record)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  })
}

function sameBackgroundRecoveryJournalIdentity(
  left: Partial<BackgroundSessionRecoveryJournalIdentity>,
  right: BackgroundSessionRecoveryJournalIdentity,
): boolean {
  return (
    typeof left.dev === 'number' &&
    typeof left.ino === 'number' &&
    left.dev === right.dev &&
    left.ino === right.ino
  )
}

async function readBackgroundSessionRecoveryCursor(
  identity: BackgroundSessionRecoveryJournalIdentity,
): Promise<number> {
  try {
    if (!(await lstat(getBackgroundSessionRecoveryCursorPath())).isFile()) {
      return 0
    }
    const parsed = jsonParse(
      await readFile(getBackgroundSessionRecoveryCursorPath(), 'utf8'),
    ) as Partial<BackgroundSessionRecoveryCursor>
    return parsed.version === BACKGROUND_RECOVERY_JOURNAL_VERSION &&
      sameBackgroundRecoveryJournalIdentity(parsed, identity) &&
      Number.isSafeInteger(parsed.offset) &&
      parsed.offset! >= 0
      ? parsed.offset!
      : 0
  } catch {
    return 0
  }
}

async function writeBackgroundSessionRecoveryCursor(
  offset: number,
  identity: BackgroundSessionRecoveryJournalIdentity,
): Promise<void> {
  const path = getBackgroundSessionRecoveryCursorPath()
  const tmp = join(
    getBackgroundSessionsRoot(),
    `.recovery-cursor.${process.pid}.${randomUUID()}.tmp`,
  )
  const handle = await open(tmp, 'wx', 0o600)
  try {
    await handle.writeFile(
      jsonStringify({
        version: BACKGROUND_RECOVERY_JOURNAL_VERSION,
        offset,
        ...identity,
      } satisfies BackgroundSessionRecoveryCursor),
    )
    await handle.sync()
    await handle.close()
    await rename(tmp, path)
  } finally {
    await handle.close().catch(() => {})
    await unlink(tmp).catch(() => {})
  }
}

async function rotateBackgroundSessionRecoveryJournal(
  startOffset: number,
  expectedIdentity: BackgroundSessionRecoveryJournalIdentity,
): Promise<boolean> {
  const journalPath = getBackgroundSessionRecoveryJournalPath()
  const source = await openVerifiedBackgroundRecoveryJournal('r')
  const sourceIdentity = await source.stat()
  if (
    !sameBackgroundRecoveryJournalIdentity(
      sourceIdentity,
      expectedIdentity,
    )
  ) {
    await source.close()
    return false
  }
  const tmp = join(
    getBackgroundSessionsRoot(),
    `.recovery-journal.${process.pid}.${randomUUID()}.tmp`,
  )
  let target: Awaited<ReturnType<typeof open>> | undefined
  try {
    target = await open(tmp, 'wx', 0o600)
    const buffer = Buffer.alloc(64 * 1024)
    let position = startOffset
    while (true) {
      const { bytesRead } = await source.read(
        buffer,
        0,
        buffer.byteLength,
        position,
      )
      if (bytesRead === 0) break
      await target.writeFile(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    await target.sync()
    await source.close()
    await target.close()
    target = undefined
    await rename(tmp, journalPath)
    await unlink(getBackgroundSessionRecoveryCursorPath()).catch(() => {})
    return true
  } finally {
    await source.close().catch(() => {})
    await target?.close().catch(() => {})
    await unlink(tmp).catch(() => {})
  }
}

export async function snapshotBackgroundSessionRecoveryJournal(): Promise<
  BackgroundSessionRecoverySnapshot
> {
  let snapshotSize = 0
  let snapshotIdentity: BackgroundSessionRecoveryJournalIdentity = {
    dev: 0,
    ino: 0,
  }
  await withBackgroundRecoveryJournalLock(async () => {
    const handle = await openVerifiedBackgroundRecoveryJournal('r')
    try {
      const identity = await handle.stat()
      snapshotSize = identity.size
      snapshotIdentity = { dev: identity.dev, ino: identity.ino }
    } finally {
      await handle.close().catch(() => {})
    }
  })
  return {
    retry: enqueueBackgroundSessionRecoveryTargets,
    commit: async () =>
      await withBackgroundRecoveryJournalLock(
        async () =>
          await rotateBackgroundSessionRecoveryJournal(
            snapshotSize,
            snapshotIdentity,
          ),
      ),
  }
}

export async function takeBackgroundSessionRecoveryBatch(
  maxEntries: number,
): Promise<BackgroundSessionRecoveryBatch> {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    return { sessionIds: [], terminalFacts: [], commit: async () => {} }
  }
  const boundedMaxEntries = Math.min(
    maxEntries,
    BACKGROUND_RECOVERY_JOURNAL_ENTRY_LIMIT,
  )

  let startOffset = 0
  let nextOffset = 0
  let snapshotSize = 0
  let snapshotIdentity: BackgroundSessionRecoveryJournalIdentity = {
    dev: 0,
    ino: 0,
  }
  let sessionIds: string[] = []
  const terminalFacts: BackgroundSessionRecoveryTarget[] = []
  await withBackgroundRecoveryJournalLock(async () => {
    const handle = await openVerifiedBackgroundRecoveryJournal('r')
    try {
      const identity = await handle.stat()
      snapshotSize = identity.size
      snapshotIdentity = { dev: identity.dev, ino: identity.ino }
      startOffset = await readBackgroundSessionRecoveryCursor(
        snapshotIdentity,
      )
      if (startOffset > snapshotSize) startOffset = 0
      nextOffset = startOffset
      const maxBytes =
        boundedMaxEntries * BACKGROUND_RECOVERY_JOURNAL_RECORD_MAX_BYTES
      const buffer = Buffer.alloc(maxBytes)
      const { bytesRead } = await handle.read(
        buffer,
        0,
        maxBytes,
        startOffset,
      )
      const contents = buffer.subarray(0, bytesRead)
      let lineStart = 0
      let linesRead = 0
      const ids = new Set<string>()
      while (linesRead < boundedMaxEntries) {
        const newline = contents.indexOf(0x0a, lineStart)
        if (newline < 0) break
        const record = contents
          .subarray(lineStart, newline)
          .toString('utf8')
        const [id, generation, extra] = record.split('~')
        if (
          id &&
          extra === undefined &&
          backgroundRecoveryJournalRecord(id, generation) !== undefined
        ) {
          ids.add(id)
          terminalFacts.push({ id, generation })
        }
        nextOffset = startOffset + newline + 1
        lineStart = newline + 1
        linesRead++
      }
      if (linesRead === 0 && bytesRead === maxBytes) {
        nextOffset = startOffset + bytesRead
      }
      sessionIds = [...ids]
    } finally {
      await handle.close().catch(() => {})
    }
  })

  return {
    sessionIds,
    terminalFacts,
    commit: async (retrySessionIds = [], retryTerminalFacts = []) => {
      if (nextOffset === startOffset) return
      await withBackgroundRecoveryJournalLock(async () => {
        const handle = await openVerifiedBackgroundRecoveryJournal('r')
        let identity: Stats
        try {
          identity = await handle.stat()
        } finally {
          await handle.close().catch(() => {})
        }
        const currentIdentity = { dev: identity.dev, ino: identity.ino }
        if (
          !sameBackgroundRecoveryJournalIdentity(
            currentIdentity,
            snapshotIdentity,
          )
        ) {
          return
        }
        const currentOffset = await readBackgroundSessionRecoveryCursor(
          currentIdentity,
        )
        if (currentOffset !== startOffset) return
        const retryIds = new Set(retrySessionIds)
        const retryRecords = [
          ...new Set(
            [
              ...terminalFacts.filter(target => retryIds.has(target.id)),
              ...retryTerminalFacts,
            ]
              .filter(target => sessionIds.includes(target.id))
              .map(target =>
                backgroundRecoveryJournalRecord(
                  target.id,
                  target.generation,
                ),
              )
              .filter((record): record is string => record !== undefined),
          ),
        ].join('')
        if (retryRecords) {
          const retryHandle =
            await openVerifiedBackgroundRecoveryJournal('a')
          try {
            if (
              !sameBackgroundRecoveryJournalIdentity(
                await retryHandle.stat(),
                currentIdentity,
              )
            ) {
              throw new Error(
                'Background recovery journal changed before retry',
              )
            }
            await retryHandle.writeFile(retryRecords)
            await retryHandle.sync()
          } finally {
            await retryHandle.close().catch(() => {})
          }
        }
        if (identity.size === snapshotSize && nextOffset >= snapshotSize) {
          await rotateBackgroundSessionRecoveryJournal(
            nextOffset,
            currentIdentity,
          )
          return
        }
        await writeBackgroundSessionRecoveryCursor(
          nextOffset,
          currentIdentity,
        )
      })
    },
  }
}

function metadataPathForId(id: string): string {
  assertSafeId(id)
  return join(getBackgroundSessionMetadataDir(), `${id}.json`)
}

async function withBackgroundSessionIdLock<T>(
  id: string,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await lockfile.lock(
    metadataPathForId(id),
    NAME_RESERVATION_LOCK_OPTIONS,
  )
  try {
    return await operation()
  } finally {
    await release().catch(() => {})
  }
}

function withBackgroundSessionIdLockSync<T>(
  id: string,
  operation: () => T,
): T {
  const release = lockfile.lockSync(
    metadataPathForId(id),
    NAME_RESERVATION_SYNC_LOCK_OPTIONS,
  )
  try {
    return operation()
  } finally {
    try {
      release()
    } catch {}
  }
}

function nameReservationPathForName(name: string): string {
  const digest = createHash('sha256').update(name).digest('hex')
  return join(getBackgroundSessionNamesDir(), `${digest}.json`)
}

function terminalFactPathForId(
  id: string,
  kind: 'natural' | 'killed',
  generation?: string,
): string {
  assertSafeId(id)
  if (
    generation !== undefined &&
    !isValidBackgroundProcessMarker(generation)
  ) {
    throw new Error('Invalid background terminal-fact generation')
  }
  const generationSuffix = generation ? `~${generation}` : ''
  return join(
    getBackgroundSessionTerminalDir(),
    `${id}${generationSuffix}.${kind}.json`,
  )
}

function assertSafeId(id: string): void {
  if (!SAFE_ID_RE.test(id)) {
    throw new Error(`Invalid background session id: ${id}`)
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === code
  )
}

type CleanupJsonRead<T> =
  | { state: 'missing' }
  | { state: 'valid'; value: T; identity?: CleanupFileIdentity }
  | { state: 'invalid' }
  | { state: 'error' }

type CleanupFileIdentity = { dev: number; ino: number }

type CleanupDirectorySnapshot =
  | { state: 'missing'; path: string }
  | { state: 'directory'; path: string; dev: number; ino: number }

type BackgroundCleanupFileSystem = {
  lstatFile: (path: string) => Promise<Stats>
  readTextFile: (path: string) => Promise<string>
  unlinkFile: (path: string) => Promise<void>
}

async function snapshotCleanupDirectory(
  path: string,
  lstatFile: BackgroundCleanupFileSystem['lstatFile'],
): Promise<CleanupJsonRead<CleanupDirectorySnapshot>> {
  try {
    const stats = await lstatFile(path)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return { state: 'invalid' }
    }
    return {
      state: 'valid',
      value: { state: 'directory', path, dev: stats.dev, ino: stats.ino },
    }
  } catch (error) {
    return isErrno(error, 'ENOENT')
      ? { state: 'valid', value: { state: 'missing', path } }
      : { state: 'error' }
  }
}

async function inspectCleanupDirectory(
  snapshot: CleanupDirectorySnapshot,
  lstatFile: BackgroundCleanupFileSystem['lstatFile'],
): Promise<'same' | 'missing' | 'changed' | 'error'> {
  try {
    const stats = await lstatFile(snapshot.path)
    if (snapshot.state === 'missing') return 'changed'
    return stats.isDirectory() &&
      !stats.isSymbolicLink() &&
      stats.dev === snapshot.dev &&
      stats.ino === snapshot.ino
      ? 'same'
      : 'changed'
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return 'missing'
    return 'error'
  }
}

async function readCleanupJson<T>(
  path: string,
  validate: (value: unknown) => value is T,
  directory: CleanupDirectorySnapshot,
  fileSystem: BackgroundCleanupFileSystem,
): Promise<CleanupJsonRead<T>> {
  const directoryState = await inspectCleanupDirectory(
    directory,
    fileSystem.lstatFile,
  )
  if (directoryState === 'missing') return { state: 'missing' }
  if (directoryState !== 'same') return { state: 'error' }

  let before: Stats
  try {
    before = await fileSystem.lstatFile(path)
    if (!before.isFile() || before.isSymbolicLink()) return { state: 'invalid' }
  } catch (error) {
    return isErrno(error, 'ENOENT') ? { state: 'missing' } : { state: 'error' }
  }

  let content: string
  try {
    content = await fileSystem.readTextFile(path)
  } catch (error) {
    return isErrno(error, 'ENOENT') ? { state: 'missing' } : { state: 'error' }
  }
  const latestDirectoryState = await inspectCleanupDirectory(
    directory,
    fileSystem.lstatFile,
  )
  if (latestDirectoryState !== 'same') return { state: 'error' }
  try {
    const after = await fileSystem.lstatFile(path)
    if (!after.isFile() || after.isSymbolicLink()) return { state: 'invalid' }
    if (after.dev !== before.dev || after.ino !== before.ino) {
      return { state: 'error' }
    }
  } catch (error) {
    return isErrno(error, 'ENOENT') ? { state: 'missing' } : { state: 'error' }
  }
  let parsed: unknown
  try {
    parsed = jsonParse(content)
  } catch {
    return { state: 'invalid' }
  }
  return validate(parsed)
    ? {
        state: 'valid',
        value: parsed,
        identity: { dev: before.dev, ino: before.ino },
      }
    : { state: 'invalid' }
}

function iso(now: Date | undefined): string {
  return (now ?? new Date()).toISOString()
}

function parseCanonicalCompletionTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return null
  return new Date(timestamp).toISOString() === value ? timestamp : null
}

export function getBackgroundSessionLogPaths(id: string): {
  stdoutLogPath: string
  stderrLogPath: string
} {
  assertSafeId(id)
  const logsDir = getBackgroundSessionLogsDir()
  return {
    stdoutLogPath: join(logsDir, `${id}.out.log`),
    stderrLogPath: join(logsDir, `${id}.err.log`),
  }
}

export async function ensureBackgroundSessionDirs(): Promise<void> {
  await mkdir(getBackgroundSessionMetadataDir(), {
    recursive: true,
    mode: 0o700,
  })
  await mkdir(getBackgroundSessionLogsDir(), { recursive: true, mode: 0o700 })
  await mkdir(getBackgroundSessionNamesDir(), { recursive: true, mode: 0o700 })
  await mkdir(getBackgroundSessionTerminalDir(), {
    recursive: true,
    mode: 0o700,
  })
}

function isSameBackgroundSessionGeneration(
  first: BackgroundSession,
  second: BackgroundSession,
): boolean {
  return (
    first.id === second.id &&
    first.pid === second.pid &&
    first.sessionId === second.sessionId &&
    first.startedAt === second.startedAt &&
    first.processMarker === second.processMarker &&
    first.terminalFactGeneration === second.terminalFactGeneration
  )
}

async function replaceSessionFile(
  session: BackgroundSession,
  target: string,
): Promise<void> {
  const tmp = join(
    getBackgroundSessionMetadataDir(),
    `${session.id}.${process.pid}.${randomUUID()}.tmp`,
  )
  try {
    await writeFile(tmp, jsonStringify(session), { flag: 'wx' })
    await rename(tmp, target)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

async function writeSession(
  session: BackgroundSession,
  expected: BackgroundSession,
  whileLocked?: () => void | Promise<void>,
): Promise<BackgroundSession | null> {
  await ensureBackgroundSessionDirs()
  const target = metadataPathForId(session.id)
  return await withBackgroundSessionIdLock(session.id, async () => {
    const current = await readSessionFile(target)
    if (!current || !isSameBackgroundSessionGeneration(current, expected)) {
      return current
    }
    await whileLocked?.()
    await replaceSessionFile(session, target)
    if (session.name && isTerminalBackgroundSession(session)) {
      await releaseNameReservation(session.name, session.id)
    }
    return session
  })
}

async function writeNewSession(session: BackgroundSession): Promise<void> {
  await ensureBackgroundSessionDirs()
  await withBackgroundSessionIdLock(session.id, async () => {
    for (const kind of ['natural', 'killed'] as const) {
      try {
        await lstat(
          terminalFactPathForId(
            session.id,
            kind,
            session.terminalFactGeneration,
          ),
        )
        throw new Error(`Background session id "${session.id}" already exists`)
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error
      }
    }
    // Publish atomically: write the document to a temp file in the same
    // directory and rename it into place, so a concurrent name/prefix scan
    // in resolveBackgroundSessionForWait never reads a partially-written
    // metadata document as malformed (CodeRabbit #2497). rename() is
    // atomic within a filesystem and, unlike link(), works on filesystems
    // that reject hard links. rename() would overwrite an existing target,
    // so the duplicate check is an lstat pre-check: every writer of this
    // id holds the per-ID lock (withBackgroundSessionIdLock), so no other
    // writer can publish the id between the check and the rename. Temp
    // files end in .tmp so the scan skips them.
    const target = metadataPathForId(session.id)
    const tmp = join(
      getBackgroundSessionMetadataDir(),
      `${session.id}.${process.pid}.${randomUUID()}.tmp`,
    )
    // Sync the completed temp file to storage before renaming it into
    // place, matching installTerminalFact: without a sync, a crash or
    // power loss after rename can leave a zero-length or partial session
    // metadata file on filesystems with delayed allocation
    // (CodeRabbit #2497).
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(tmp, 'wx')
      await handle.writeFile(jsonStringify(session))
      await handle.sync()
      await handle.close()
      handle = undefined
      try {
        await lstat(target)
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error
        await rename(tmp, target)
        return
      }
      throw new Error(`Background session id "${session.id}" already exists`)
    } finally {
      await handle?.close().catch(() => {})
      await unlink(tmp).catch(() => {})
    }
  })
}

async function readSessionFile(path: string): Promise<BackgroundSession | null> {
  try {
    const parsed = jsonParse(await readFile(path, 'utf8'))
    return isBackgroundSession(parsed, basename(path, '.json')) ? parsed : null
  } catch {
    return null
  }
}

function readSessionFileSync(path: string): BackgroundSession | null {
  try {
    const parsed = jsonParse(readFileSync(path, 'utf8'))
    return isBackgroundSession(parsed, basename(path, '.json')) ? parsed : null
  } catch {
    return null
  }
}

async function readNameReservation(
  path: string,
): Promise<BackgroundSessionNameReservation | null> {
  try {
    const parsed = jsonParse(await readFile(path, 'utf8'))
    if (isBackgroundSessionNameReservation(parsed)) return parsed
  } catch {
    // Malformed reservations are treated as recoverable orphans below.
  }
  return null
}

async function withNameReservationLock<T>(
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await lockfile.lock(
    nameReservationPathForName(name),
    NAME_RESERVATION_LOCK_OPTIONS,
  )
  let value: T
  try {
    value = await operation()
  } catch (error) {
    await release().catch(() => {})
    throw error
  }
  await release()
  return value
}

function withNameReservationLockSync<T>(name: string, operation: () => T): T {
  const release = lockfile.lockSync(
    nameReservationPathForName(name),
    NAME_RESERVATION_SYNC_LOCK_OPTIONS,
  )
  let value: T
  try {
    value = operation()
  } catch (error) {
    try {
      release()
    } catch {}
    throw error
  }
  release()
  return value
}

function isBackgroundSessionNameReservation(
  value: unknown,
): value is BackgroundSessionNameReservation {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<BackgroundSessionNameReservation>
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.id === 'string' &&
    SAFE_ID_RE.test(candidate.id) &&
    (candidate.creatorPid === undefined ||
      (typeof candidate.creatorPid === 'number' &&
        Number.isInteger(candidate.creatorPid) &&
        candidate.creatorPid > 1)) &&
    (candidate.createdAt === undefined ||
      typeof candidate.createdAt === 'string')
  )
}

async function releaseNameReservationUnlocked(
  name: string,
  id: string,
): Promise<boolean> {
  const path = nameReservationPathForName(name)
  let existing: BackgroundSessionNameReservation
  try {
    const parsed = jsonParse(await readFile(path, 'utf8'))
    if (!isBackgroundSessionNameReservation(parsed)) return true
    existing = parsed
  } catch (error) {
    return isErrno(error, 'ENOENT')
  }
  if (existing.name !== name || existing.id !== id) return true
  try {
    await unlink(path)
    return true
  } catch (error) {
    return isErrno(error, 'ENOENT')
  }
}

async function tryReleaseNameReservation(
  name: string,
  id: string,
): Promise<boolean> {
  try {
    return await withNameReservationLock(
      name,
      async () => await releaseNameReservationUnlocked(name, id),
    )
  } catch {
    return false
  }
}

async function releaseNameReservation(name: string, id: string): Promise<void> {
  await tryReleaseNameReservation(name, id)
}

function releaseNameReservationSyncUnlocked(
  name: string,
  id: string,
): void {
  const path = nameReservationPathForName(name)
  try {
    const parsed = jsonParse(readFileSync(path, 'utf8'))
    if (
      !isBackgroundSessionNameReservation(parsed) ||
      parsed.name !== name ||
      parsed.id !== id
    ) {
      return
    }
    unlinkSync(path)
  } catch {
    // Effective terminal-state reads recover stale reservations later.
  }
}

function releaseNameReservationSync(name: string, id: string): void {
  try {
    withNameReservationLockSync(name, () => {
      releaseNameReservationSyncUnlocked(name, id)
    })
  } catch {
    // A stale reservation is recoverable on the next name claim.
  }
}

async function unlinkStaleNameReservation(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
  }
}

async function releaseStaleNameReservationUnlocked(
  name: string,
  id: string,
): Promise<void> {
  const path = nameReservationPathForName(name)
  const existing = await readNameReservation(path)
  if (existing?.id !== id) return
  await unlinkStaleNameReservation(path)
}

async function isLiveNameReservation(
  name: string,
  reservation: BackgroundSessionNameReservation | null,
): Promise<boolean> {
  if (!reservation) return false
  if (reservation.name !== name) return false

  const owner = await readSessionFile(metadataPathForId(reservation.id))
  if (owner) {
    const effectiveOwner = await applyAuthoritativeTerminalFacts(owner)
    return (
      effectiveOwner.name === name &&
      !isTerminalBackgroundSession(effectiveOwner)
    )
  }

  return (
    typeof reservation.creatorPid === 'number' &&
    isProcessRunning(reservation.creatorPid)
  )
}

async function reserveBackgroundSessionName(
  name: string,
  id: string,
): Promise<() => Promise<void>> {
  return await withNameReservationLock(name, async () => {
    const path = nameReservationPathForName(name)
    const reservation = jsonStringify({
      name,
      id,
      creatorPid: process.pid,
      createdAt: iso(undefined),
    })

    while (true) {
      try {
        await writeFile(path, reservation, { flag: 'wx' })
        return () => releaseNameReservation(name, id)
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error

        const existing = await readNameReservation(path)
        if (!(await isLiveNameReservation(name, existing))) {
          if (existing) {
            await releaseStaleNameReservationUnlocked(name, existing.id)
          } else {
            await unlinkStaleNameReservation(path)
          }
          continue
        }

        const suffix =
          existing && existing.name === name ? ` (${existing.id})` : ''
        throw new Error(
          `Background session name "${name}" already exists${suffix}`,
        )
      }
    }
  })
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isSafeExitCode(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  )
}

function isSafeSignal(value: unknown): value is string {
  return typeof value === 'string' && SAFE_SIGNAL_RE.test(value)
}

function isTerminalReason(
  value: unknown,
): value is BackgroundSessionTerminalReason {
  return (
    value === 'exit_code' || value === 'signal' || value === 'explicit_kill'
  )
}

function isBackgroundSession(
  value: unknown,
  expectedId: string,
): value is BackgroundSession {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<BackgroundSession>

  return (
    typeof candidate.id === 'string' &&
    SAFE_ID_RE.test(candidate.id) &&
    candidate.id === expectedId &&
    typeof candidate.pid === 'number' &&
    Number.isInteger(candidate.pid) &&
    candidate.pid > 0 &&
    typeof candidate.cwd === 'string' &&
    typeof candidate.status === 'string' &&
    ALL_STATUSES.has(candidate.status as BackgroundSessionStatus) &&
    (candidate.name === undefined || typeof candidate.name === 'string') &&
    (candidate.provider === undefined ||
      typeof candidate.provider === 'string') &&
    (candidate.model === undefined || typeof candidate.model === 'string') &&
    typeof candidate.sessionId === 'string' &&
    (candidate.processMarker === undefined ||
      isValidBackgroundProcessMarker(candidate.processMarker)) &&
    (candidate.terminalFactGeneration === undefined ||
      (candidate.terminalFactGeneration === candidate.processMarker &&
        isValidBackgroundProcessMarker(
          candidate.terminalFactGeneration,
        ))) &&
    typeof candidate.startedAt === 'string' &&
    typeof candidate.updatedAt === 'string' &&
    isStringArray(candidate.command) &&
    typeof candidate.stdoutLogPath === 'string' &&
    typeof candidate.stderrLogPath === 'string' &&
    (candidate.finishedAt === undefined ||
      typeof candidate.finishedAt === 'string') &&
    (candidate.exitCode === undefined || isSafeExitCode(candidate.exitCode)) &&
    (candidate.signal === undefined || isSafeSignal(candidate.signal)) &&
    (candidate.terminalReason === undefined ||
      isTerminalReason(candidate.terminalReason))
  )
}

function isBackgroundSessionTerminalFact(
  value: unknown,
  expectedId: string,
  kind: 'natural' | 'killed',
): value is BackgroundSessionTerminalFact {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<BackgroundSessionTerminalFact>
  if (
    candidate.version !== 1 ||
    candidate.id !== expectedId ||
    !SAFE_ID_RE.test(candidate.id) ||
    typeof candidate.pid !== 'number' ||
    !Number.isInteger(candidate.pid) ||
    candidate.pid <= 0 ||
    (candidate.generation !== undefined &&
      !isValidBackgroundProcessMarker(candidate.generation)) ||
    typeof candidate.finishedAt !== 'string' ||
    !isTerminalReason(candidate.terminalReason) ||
    (candidate.exitCode !== undefined &&
      !isSafeExitCode(candidate.exitCode)) ||
    (candidate.signal !== undefined && !isSafeSignal(candidate.signal))
  ) {
    return false
  }

  if (kind === 'killed') {
    return (
      candidate.status === 'killed' &&
      candidate.terminalReason === 'explicit_kill' &&
      candidate.exitCode === undefined &&
      candidate.signal === undefined
    )
  }

  if (candidate.status === 'exited') {
    return (
      candidate.terminalReason === 'exit_code' &&
      candidate.exitCode === 0 &&
      candidate.signal === undefined
    )
  }
  if (candidate.status !== 'failed') return false
  if (candidate.terminalReason === 'exit_code') {
    return (
      candidate.exitCode !== undefined &&
      candidate.exitCode !== 0 &&
      candidate.signal === undefined
    )
  }
  return (
    candidate.terminalReason === 'signal' &&
    candidate.exitCode === undefined &&
    candidate.signal !== undefined
  )
}

type TerminalFactRead =
  | { status: 'missing' }
  | { status: 'unreadable' }
  | { status: 'found'; fact: BackgroundSessionTerminalFact }

/**
 * Reads one terminal fact, distinguishing a missing fact from a fact
 * that exists but cannot be read. A missing file — or valid JSON that is
 * not a fact for this session and generation — is `missing`: there is
 * nothing to retry. Any other read failure, or JSON that cannot be
 * parsed, is `unreadable`: termination is unestablished, not absent.
 */
async function readTerminalFactResult(
  id: string,
  kind: 'natural' | 'killed',
  generation?: string,
): Promise<TerminalFactRead> {
  let raw: string
  try {
    raw = await readFile(terminalFactPathForId(id, kind, generation), 'utf8')
  } catch (error) {
    return isErrno(error, 'ENOENT')
      ? { status: 'missing' }
      : { status: 'unreadable' }
  }
  let parsed: unknown
  try {
    parsed = jsonParse(raw)
  } catch {
    return { status: 'unreadable' }
  }
  return isBackgroundSessionTerminalFact(parsed, id, kind) &&
    parsed.generation === generation
    ? { status: 'found', fact: parsed }
    : { status: 'missing' }
}

async function readTerminalFact(
  id: string,
  kind: 'natural' | 'killed',
  generation?: string,
): Promise<BackgroundSessionTerminalFact | null> {
  const result = await readTerminalFactResult(id, kind, generation)
  return result.status === 'found' ? result.fact : null
}

function readTerminalFactSync(
  id: string,
  kind: 'natural' | 'killed',
  generation?: string,
): BackgroundSessionTerminalFact | null {
  try {
    const parsed = jsonParse(
      readFileSync(terminalFactPathForId(id, kind, generation), 'utf8'),
    )
    return isBackgroundSessionTerminalFact(parsed, id, kind) &&
      parsed.generation === generation
      ? parsed
      : null
  } catch {
    return null
  }
}

async function applyAuthoritativeTerminalFacts(
  session: BackgroundSession,
): Promise<BackgroundSession> {
  return (await applyAuthoritativeTerminalFactsDetailed(session)).session
}

/**
 * Applies the recorded terminal facts to a session, reporting whether
 * any fact read failed. Callers that only need the effective session use
 * {@link applyAuthoritativeTerminalFacts}; the targeted refresh needs the
 * flag to tell an unreadable fact (retry the metadata read) from a
 * missing one (the process being gone means stale).
 */
async function applyAuthoritativeTerminalFactsDetailed(
  session: BackgroundSession,
): Promise<{
  session: BackgroundSession
  terminalFactReadError: boolean
}> {
  const natural = await readTerminalFactResult(
    session.id,
    'natural',
    session.terminalFactGeneration,
  )
  const killed = await readTerminalFactResult(
    session.id,
    'killed',
    session.terminalFactGeneration,
  )
  return {
    session: applyTerminalFacts(
      session,
      natural.status === 'found' ? natural.fact : null,
      killed.status === 'found' ? killed.fact : null,
    ),
    terminalFactReadError:
      natural.status === 'unreadable' || killed.status === 'unreadable',
  }
}

function applyTerminalFacts(
  session: BackgroundSession,
  natural: BackgroundSessionTerminalFact | null,
  killed: BackgroundSessionTerminalFact | null,
): BackgroundSession {
  let effective = session

  if (
    natural?.pid === session.pid &&
    (session.status === 'running' ||
      session.status === 'unknown' ||
      session.status === 'stale')
  ) {
    effective = {
      ...session,
      status: natural.status,
      updatedAt: natural.finishedAt,
      finishedAt: natural.finishedAt,
      terminalReason: natural.terminalReason,
      ...(natural.exitCode !== undefined
        ? { exitCode: natural.exitCode }
        : {}),
      ...(natural.signal !== undefined ? { signal: natural.signal } : {}),
    }
  }

  if (killed?.pid === session.pid) {
    effective = {
      ...effective,
      status: 'killed',
      updatedAt: killed.finishedAt,
      finishedAt: effective.finishedAt ?? killed.finishedAt,
      terminalReason: 'explicit_kill',
    }
  }

  return effective
}

// How long a terminal-fact installer that loses the publish claim waits
// for the winning publish to appear before completing the winner's
// publish itself. The winner publishes within microseconds of claiming,
// so the budget is only spent when the winner died or stalled;
// completing the winner's publish is always safe, so the budget is
// short (CodeRabbit #2497).
const TERMINAL_FACT_PUBLISH_WAIT_MS = 250
// Maximum publish attempts (claim, adopt, retry) before giving up with
// the invalid-fact error.
const TERMINAL_FACT_PUBLISH_ATTEMPTS = 3

function terminalFactTempPath(id: string): string {
  return join(
    getBackgroundSessionTerminalDir(),
    `${id}.${process.pid}.${randomUUID()}.tmp`,
  )
}

// The publish claim for one terminal-fact target: a directory, so
// creating it with mkdir() is atomic and works on filesystems without
// hard-link support. The claim file inside names the temp file to
// publish.
function terminalFactClaimDir(target: string): string {
  return `${target}.claim`
}

function terminalFactClaimFile(target: string): string {
  return join(terminalFactClaimDir(target), 'tmp')
}

// Removes a publish claim: the claim file first, then the directory.
// rmdir() refuses a non-empty directory, so removing the directory
// alone would leave the claim behind.
async function removeTerminalFactClaim(target: string): Promise<void> {
  await unlink(terminalFactClaimFile(target)).catch(() => {})
  await rmdir(terminalFactClaimDir(target)).catch(() => {})
}

function removeTerminalFactClaimSync(target: string): void {
  try {
    unlinkSync(terminalFactClaimFile(target))
  } catch {}
  try {
    rmdirSync(terminalFactClaimDir(target))
  } catch {}
}

// Removes a publish claim only when this installer created it: the
// claim file names the winner's tmp, so a claim naming another tmp
// belongs to a newer publisher and must be left alone. A claim file
// that is already gone means the claim was adopted and removed, so
// there is nothing to do.
async function removeOwnTerminalFactClaim(
  target: string,
  tmp: string,
): Promise<void> {
  const claimed = await readFile(terminalFactClaimFile(target), 'utf8').catch(
    () => undefined,
  )
  if (claimed?.trim() !== tmp) return
  await removeTerminalFactClaim(target)
}

function removeOwnTerminalFactClaimSync(
  target: string,
  tmp: string,
): void {
  let claimed: string | undefined
  try {
    claimed = readFileSync(terminalFactClaimFile(target), 'utf8')
  } catch {
    return
  }
  if (claimed?.trim() !== tmp) return
  removeTerminalFactClaimSync(target)
}

// Test-only hook invoked by installTerminalFact after it has claimed a
// terminal-fact publish and before it renames the temp file into place,
// so a test can pause one installer while a second installer publishes
// (CodeRabbit #2497). Never set outside tests.
let terminalFactPublishHookForTesting: (() => Promise<void>) | undefined

export function _setTerminalFactPublishHookForTesting(
  hook: (() => Promise<void>) | undefined,
): void {
  terminalFactPublishHookForTesting = hook
}

async function waitForTerminalFact(
  id: string,
  kind: 'natural' | 'killed',
  generation?: string,
): Promise<BackgroundSessionTerminalFact | null> {
  const deadline = Date.now() + TERMINAL_FACT_PUBLISH_WAIT_MS
  for (;;) {
    const existing = await readTerminalFact(id, kind, generation)
    if (existing) return existing
    if (Date.now() >= deadline) return null
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

// Shared buffer for sleepSync: Atomics.wait is the only synchronous sleep
// available in Bun/Node, and it needs a shared-memory view. Same idiom as
// src/utils/transcriptFileLock.ts. The buffer is never written, so waits
// always time out after `ms` instead of waking early.
const terminalFactSyncWaitBuffer = new Int32Array(new SharedArrayBuffer(4))

/**
 * Blocks the current thread for `ms` milliseconds without yielding to the
 * event loop. Only for the synchronous terminal-fact wait loops below,
 * which cannot await: a plain loop would spin readFileSync at 100% CPU
 * until the deadline.
 */
function sleepSync(ms: number): void {
  Atomics.wait(terminalFactSyncWaitBuffer, 0, 0, ms)
}

/**
 * Polls for a published terminal fact, sleeping 10 ms between reads like
 * the async waitForTerminalFact, and returns null when the 250 ms deadline
 * passes without the fact appearing.
 */
function waitForTerminalFactSync(
  id: string,
  kind: 'natural' | 'killed',
  generation?: string,
): BackgroundSessionTerminalFact | null {
  const deadline = Date.now() + TERMINAL_FACT_PUBLISH_WAIT_MS
  for (;;) {
    const existing = readTerminalFactSync(id, kind, generation)
    if (existing) return existing
    if (Date.now() >= deadline) return null
    sleepSync(10)
  }
}

async function readTerminalFactClaim(
  target: string,
): Promise<string | undefined> {
  const claimFile = terminalFactClaimFile(target)
  const deadline = Date.now() + TERMINAL_FACT_PUBLISH_WAIT_MS
  for (;;) {
    try {
      const claimed = (await readFile(claimFile, 'utf8')).trim()
      const terminalDir = getBackgroundSessionTerminalDir()
      // The claim must name a temp file in this terminal directory;
      // anything else is a corrupt claim, never a path to rename.
      if (
        claimed &&
        join(terminalDir, basename(claimed)) === claimed &&
        SESSION_TEMP_FILE_RE.test(basename(claimed))
      ) {
        return claimed
      }
      return undefined
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) return undefined
      if (Date.now() >= deadline) return undefined
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
}

/**
 * Polls for the claim file naming the winning installer's temp file,
 * sleeping 10 ms between reads like the async readTerminalFactClaim, and
 * returns undefined when no valid claim appears before the 250 ms
 * deadline (or the claim names a path outside the terminal directory).
 */
function readTerminalFactClaimSync(target: string): string | undefined {
  const claimFile = terminalFactClaimFile(target)
  const deadline = Date.now() + TERMINAL_FACT_PUBLISH_WAIT_MS
  for (;;) {
    try {
      const claimed = readFileSync(claimFile, 'utf8').trim()
      const terminalDir = getBackgroundSessionTerminalDir()
      if (
        claimed &&
        join(terminalDir, basename(claimed)) === claimed &&
        SESSION_TEMP_FILE_RE.test(basename(claimed))
      ) {
        return claimed
      }
      return undefined
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) return undefined
      if (Date.now() >= deadline) return undefined
      sleepSync(10)
    }
  }
}

/**
 * Publishes one terminal fact with atomic no-overwrite semantics and
 * without hard links (CodeRabbit #2497). The target only ever appears
 * complete, via rename() of a synced temp file, so a concurrent `wait`
 * never reads a partially-written fact as malformed; and the first
 * publisher wins: an installer claims the target by creating
 * `<target>.claim` (mkdir is atomic) and recording its temp path in
 * `<target>.claim/tmp`, so a second installer that finds the claim —
 * including the synchronous ELOCKED exit fallback, which publishes
 * without the per-ID lock — completes the winner's publish instead of
 * racing it. A loser whose winner died after claiming removes the stale
 * claim and retries. This preserves the old link() EEXIST duplicate
 * semantics without link(), which fails on filesystems that reject hard
 * links (maintainer review 5830922741 on #2497).
 */
async function publishTerminalFact(
  fact: BackgroundSessionTerminalFact,
  kind: 'natural' | 'killed',
  target: string,
  tmp: string,
): Promise<BackgroundSessionTerminalFact> {
  const claimDir = terminalFactClaimDir(target)
  const claimFile = terminalFactClaimFile(target)
  for (let attempt = 0; attempt < TERMINAL_FACT_PUBLISH_ATTEMPTS; attempt++) {
    // A fact already published by an earlier installer wins. The target
    // only ever appears complete (via rename), so one read is enough.
    let targetExists = false
    try {
      await lstat(target)
      targetExists = true
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error
    }
    if (targetExists) {
      const existing = await readTerminalFact(fact.id, kind, fact.generation)
      if (!existing) {
        throw new Error(`Invalid background session ${kind} terminal fact`)
      }
      return existing
    }
    // Claim the publish: exactly one installer per target wins the
    // mkdir, and the claim file names the tmp to publish, so a loser
    // can complete the winner's publish instead of racing it.
    try {
      await mkdir(claimDir)
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error
      const adopted = await adoptTerminalFactPublish(fact, kind, target)
      if (adopted) return adopted
      continue
    }
    try {
      await writeFile(claimFile, tmp, { flag: 'wx' })
    } catch (error) {
      if (isErrno(error, 'ENOENT')) continue
      throw error
    }
    await terminalFactPublishHookForTesting?.()
    try {
      await rename(tmp, target)
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error
      // Another installer adopted this tmp and published it; the fact
      // now at the target is this publish, so return it.
      const existing = await waitForTerminalFact(
        fact.id,
        kind,
        fact.generation,
      )
      if (!existing) {
        throw new Error(`Invalid background session ${kind} terminal fact`)
      }
      return existing
    }
    return fact
  }
  throw new Error(`Invalid background session ${kind} terminal fact`)
}

async function adoptTerminalFactPublish(
  fact: BackgroundSessionTerminalFact,
  kind: 'natural' | 'killed',
  target: string,
): Promise<BackgroundSessionTerminalFact | null> {
  // The winner publishes within microseconds of claiming, so wait
  // briefly for its target to appear before adopting.
  const existing = await waitForTerminalFact(fact.id, kind, fact.generation)
  if (existing) return existing
  // The winner died or stalled after claiming: complete its publish by
  // renaming its tmp to the target. Its tmp is complete — the claim file
  // is written only after the tmp is synced — so the target only ever
  // appears complete, and the first publisher still wins.
  const claimedTmp = await readTerminalFactClaim(target)
  if (claimedTmp === undefined) {
    // No claim file: the winner died between mkdir and the claim-file
    // write, or stalled there. Remove the stale claim so the next
    // attempt can claim the publish.
    await removeTerminalFactClaim(target)
    return null
  }
  try {
    await rename(claimedTmp, target)
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
    // The winner published after all, or another adopter did: return
    // the fact at the target if it appeared, else retry the publish.
    return await waitForTerminalFact(fact.id, kind, fact.generation)
  }
  // This publish is complete, so the winner's claim is stale.
  await removeTerminalFactClaim(target)
  const adopted = await readTerminalFact(fact.id, kind, fact.generation)
  if (!adopted) {
    throw new Error(`Invalid background session ${kind} terminal fact`)
  }
  return adopted
}

function publishTerminalFactSync(
  fact: BackgroundSessionTerminalFact,
  kind: 'natural' | 'killed',
  target: string,
  tmp: string,
): BackgroundSessionTerminalFact {
  const claimDir = terminalFactClaimDir(target)
  const claimFile = terminalFactClaimFile(target)
  for (let attempt = 0; attempt < TERMINAL_FACT_PUBLISH_ATTEMPTS; attempt++) {
    // Same duplicate-guard as publishTerminalFact: a fact already
    // published by an earlier installer wins.
    let targetExists = false
    try {
      lstatSync(target)
      targetExists = true
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error
    }
    if (targetExists) {
      const existing = readTerminalFactSync(fact.id, kind, fact.generation)
      if (!existing) {
        throw new Error(`Invalid background session ${kind} terminal fact`)
      }
      return existing
    }
    try {
      mkdirSync(claimDir)
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error
      const adopted = adoptTerminalFactPublishSync(fact, kind, target)
      if (adopted) return adopted
      continue
    }
    try {
      writeFileSync(claimFile, tmp, { flag: 'wx' })
    } catch (error) {
      if (isErrno(error, 'ENOENT')) continue
      throw error
    }
    try {
      renameSync(tmp, target)
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error
      // Same adoption case as publishTerminalFact: another installer
      // adopted this tmp and published it.
      const existing = waitForTerminalFactSync(
        fact.id,
        kind,
        fact.generation,
      )
      if (!existing) {
        throw new Error(`Invalid background session ${kind} terminal fact`)
      }
      return existing
    }
    return fact
  }
  throw new Error(`Invalid background session ${kind} terminal fact`)
}

function adoptTerminalFactPublishSync(
  fact: BackgroundSessionTerminalFact,
  kind: 'natural' | 'killed',
  target: string,
): BackgroundSessionTerminalFact | null {
  const existing = waitForTerminalFactSync(fact.id, kind, fact.generation)
  if (existing) return existing
  const claimedTmp = readTerminalFactClaimSync(target)
  if (claimedTmp === undefined) {
    removeTerminalFactClaimSync(target)
    return null
  }
  try {
    renameSync(claimedTmp, target)
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
    return waitForTerminalFactSync(fact.id, kind, fact.generation)
  }
  removeTerminalFactClaimSync(target)
  const adopted = readTerminalFactSync(fact.id, kind, fact.generation)
  if (!adopted) {
    throw new Error(`Invalid background session ${kind} terminal fact`)
  }
  return adopted
}

async function installTerminalFact(
  fact: BackgroundSessionTerminalFact,
  kind: 'natural' | 'killed',
): Promise<BackgroundSessionTerminalFact> {
  await ensureBackgroundSessionDirs()
  const target = terminalFactPathForId(fact.id, kind, fact.generation)
  const tmp = terminalFactTempPath(fact.id)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let installed: BackgroundSessionTerminalFact
  try {
    handle = await open(tmp, 'wx', 0o600)
    await handle.writeFile(jsonStringify(fact))
    await handle.sync()
    await handle.close()
    handle = undefined
    installed = await publishTerminalFact(fact, kind, target, tmp)
  } finally {
    await handle?.close().catch(() => {})
    await unlink(tmp).catch(() => {})
    // The claim belongs to this publish attempt: remove it once the
    // publish is decided, whether this installer published, a loser
    // adopted its tmp, or the publish failed. Only a claim this
    // installer created is removed — a claim naming another tmp belongs
    // to a newer publisher. A loser that already read the claim still
    // holds the tmp path, so removing the directory cannot break its
    // adoption; a loser that has not read it yet retries its own publish.
    await removeOwnTerminalFactClaim(target, tmp)
  }
  await enqueueBackgroundSessionRecovery(installed.id, installed.generation).catch(() => {})
  return installed
}

function installTerminalFactSync(
  fact: BackgroundSessionTerminalFact,
  kind: 'natural' | 'killed',
): BackgroundSessionTerminalFact {
  mkdirSync(getBackgroundSessionTerminalDir(), {
    recursive: true,
    mode: 0o700,
  })
  const target = terminalFactPathForId(fact.id, kind, fact.generation)
  const tmp = terminalFactTempPath(fact.id)
  let fd: number | undefined
  let installed: BackgroundSessionTerminalFact
  try {
    fd = openSync(tmp, 'wx', 0o600)
    writeFileSync(fd, jsonStringify(fact))
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    installed = publishTerminalFactSync(fact, kind, target, tmp)
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {}
    }
    try {
      unlinkSync(tmp)
    } catch {}
    // Same claim cleanup as installTerminalFact.
    removeOwnTerminalFactClaimSync(target, tmp)
  }
  try {
    enqueueBackgroundSessionRecoverySync(installed.id, installed.generation)
  } catch {
    // The terminal fact remains the durable fallback for the daily sweep.
  }
  return installed
}

type BackgroundSessionRecord = {
  stored: BackgroundSession
  effective: BackgroundSession
}

async function listBackgroundSessionRecords(): Promise<
  BackgroundSessionRecord[]
> {
  let entries: string[]
  try {
    entries = await readdir(getBackgroundSessionMetadataDir())
  } catch {
    return []
  }

  const records: BackgroundSessionRecord[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const session = await readSessionFile(
      join(getBackgroundSessionMetadataDir(), entry),
    )
    if (session) {
      records.push({
        stored: session,
        effective: await applyAuthoritativeTerminalFacts(session),
      })
    }
  }

  return records.sort((a, b) =>
    a.stored.startedAt.localeCompare(b.stored.startedAt),
  )
}

export async function listBackgroundSessions(): Promise<BackgroundSession[]> {
  return (await listBackgroundSessionRecords()).map(record => record.effective)
}

async function readReconciliationTerminalFact(
  session: BackgroundSession,
  kind: 'natural' | 'killed',
  terminalDirectory: CleanupDirectorySnapshot,
  fileSystem: BackgroundCleanupFileSystem,
): Promise<CleanupJsonRead<BackgroundSessionTerminalFact>> {
  const generation = session.terminalFactGeneration
  return await readCleanupJson(
    terminalFactPathForId(session.id, kind, generation),
    (value): value is BackgroundSessionTerminalFact =>
      isBackgroundSessionTerminalFact(value, session.id, kind) &&
      value.generation === generation &&
      parseCanonicalCompletionTimestamp(value.finishedAt) !== null,
    terminalDirectory,
    fileSystem,
  )
}

function hasSamePersistedTerminalState(
  stored: BackgroundSession,
  effective: BackgroundSession,
): boolean {
  return (
    stored.status === effective.status &&
    stored.updatedAt === effective.updatedAt &&
    stored.finishedAt === effective.finishedAt &&
    stored.exitCode === effective.exitCode &&
    stored.signal === effective.signal &&
    stored.terminalReason === effective.terminalReason
  )
}

export async function reconcileBackgroundSessionTerminalFacts(
  options: {
    sessionIds?: readonly string[]
    onRetry?: (target?: BackgroundSessionRecoveryTarget) => void
    terminalScanLimit?: number
  } = {},
): Promise<{ sessionsUpdated: number; errors: number }> {
  const result = {
    sessionsUpdated: 0,
    errors: 0,
  }

  const fileSystem: BackgroundCleanupFileSystem = {
    lstatFile: lstat,
    readTextFile: async path => await readFile(path, 'utf8'),
    unlinkFile: unlink,
  }
  const [metadataRead, terminalRead] = await Promise.all([
    snapshotCleanupDirectory(
      getBackgroundSessionMetadataDir(),
      fileSystem.lstatFile,
    ),
    snapshotCleanupDirectory(
      getBackgroundSessionTerminalDir(),
      fileSystem.lstatFile,
    ),
  ])
  if (metadataRead.state !== 'valid' || terminalRead.state !== 'valid') {
    result.errors += Number(metadataRead.state !== 'valid')
    result.errors += Number(terminalRead.state !== 'valid')
    if (result.errors > 0) options.onRetry?.()
    return result
  }
  const metadataDirectory = metadataRead.value
  const terminalDirectory = terminalRead.value
  if (
    metadataDirectory.state === 'missing' ||
    terminalDirectory.state === 'missing'
  ) {
    if (result.errors > 0) options.onRetry?.()
    return result
  }

  let candidateIds: string[]
  if (options.sessionIds !== undefined) {
    candidateIds = [
      ...new Set(options.sessionIds.filter(id => SAFE_ID_RE.test(id))),
    ]
  } else {
    let entries: Dirent<string>[]
    try {
      const scanTerminalFacts = options.terminalScanLimit !== undefined
      entries = await readDirectoryEntries(
        scanTerminalFacts
          ? getBackgroundSessionTerminalDir()
          : getBackgroundSessionMetadataDir(),
        scanTerminalFacts ? options.terminalScanLimit : undefined,
      )
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) result.errors++
      if (result.errors > 0) options.onRetry?.()
      return result
    }
    const scannedDirectory =
      options.terminalScanLimit === undefined
        ? metadataDirectory
        : terminalDirectory
    if (
      (await inspectCleanupDirectory(
        scannedDirectory,
        fileSystem.lstatFile,
      )) !== 'same'
    ) {
      result.errors++
      if (result.errors > 0) options.onRetry?.()
      return result
    }
    candidateIds = [
      ...new Set(
        options.terminalScanLimit === undefined
          ? entries
              .filter(
                entry => entry.isFile() && entry.name.endsWith('.json'),
              )
              .map(entry => entry.name.slice(0, -'.json'.length))
              .filter(id => SAFE_ID_RE.test(id))
          : entries
              .map(terminalFactCandidateFromEntry)
              .filter(
                (candidate): candidate is NonNullable<typeof candidate> =>
                  candidate !== null,
              )
              .map(candidate => candidate.id),
      ),
    ]
  }

  for (const id of candidateIds) {
    const errorsBefore = result.errors
    let retryGeneration: string | undefined
    try {
      const metadataPath = metadataPathForId(id)
      const candidate = await readCleanupJson(
        metadataPath,
        (value): value is BackgroundSession =>
          isBackgroundSession(value, id),
        metadataDirectory,
        fileSystem,
      )
      if (candidate.state === 'error') {
        result.errors++
        continue
      }
      if (candidate.state !== 'valid' || !candidate.identity) continue
      retryGeneration = candidate.value.terminalFactGeneration

      try {
        await withBackgroundSessionIdLock(id, async () => {
          const natural = await readReconciliationTerminalFact(
            candidate.value,
            'natural',
            terminalDirectory,
            fileSystem,
          )
          const killed = await readReconciliationTerminalFact(
            candidate.value,
            'killed',
            terminalDirectory,
            fileSystem,
          )
          if (natural.state === 'error' || killed.state === 'error') {
            result.errors++
            return
          }

          const latest = await readCleanupJson(
            metadataPath,
            (value): value is BackgroundSession =>
              isBackgroundSession(value, id),
            metadataDirectory,
            fileSystem,
          )
          if (latest.state === 'error') {
            result.errors++
            return
          }
          if (
            latest.state !== 'valid' ||
            !latest.identity ||
            latest.identity.dev !== candidate.identity?.dev ||
            latest.identity.ino !== candidate.identity?.ino ||
            !isSameBackgroundSessionGeneration(
              latest.value,
              candidate.value,
            )
          ) {
            return
          }

          const effective = applyTerminalFacts(
            latest.value,
            natural.state === 'valid' ? natural.value : null,
            killed.state === 'valid' ? killed.value : null,
          )
          if (!COMPLETED_STATUSES.has(effective.status)) return

          if (!hasSamePersistedTerminalState(latest.value, effective)) {
            if (
              (await inspectCleanupDirectory(
                metadataDirectory,
                fileSystem.lstatFile,
              )) !== 'same'
            ) {
              result.errors++
              return
            }
            try {
              const beforeWrite = await fileSystem.lstatFile(metadataPath)
              if (
                !beforeWrite.isFile() ||
                beforeWrite.isSymbolicLink() ||
                beforeWrite.dev !== latest.identity.dev ||
                beforeWrite.ino !== latest.identity.ino
              ) {
                return
              }
            } catch (error) {
              if (!isErrno(error, 'ENOENT')) result.errors++
              return
            }
            await replaceSessionFile(effective, metadataPath)
            result.sessionsUpdated++
          }
          if (
            effective.name &&
            !(await tryReleaseNameReservation(effective.name, effective.id))
          ) {
            result.errors++
          }
        })
      } catch {
        result.errors++
      }
    } finally {
      if (result.errors > errorsBefore) {
        options.onRetry?.({ id: id, generation: retryGeneration })
      }
    }
  }

  return result
}

type CleanupArtifactRemoval = 'removed' | 'missing' | 'error'

async function removeCleanupArtifact(
  path: string,
  result: BackgroundCleanupResult,
  directory: CleanupDirectorySnapshot,
  fileSystem: BackgroundCleanupFileSystem,
  expectedIdentity?: CleanupFileIdentity,
): Promise<CleanupArtifactRemoval> {
  const directoryState = await inspectCleanupDirectory(
    directory,
    fileSystem.lstatFile,
  )
  if (directoryState === 'missing') return 'missing'
  if (directoryState !== 'same') {
    result.errors++
    return 'error'
  }
  if (expectedIdentity) {
    try {
      const stats = await fileSystem.lstatFile(path)
      if (
        !stats.isFile() ||
        stats.isSymbolicLink() ||
        stats.dev !== expectedIdentity.dev ||
        stats.ino !== expectedIdentity.ino
      ) {
        result.errors++
        return 'error'
      }
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return 'missing'
      result.errors++
      return 'error'
    }
  }
  try {
    await fileSystem.unlinkFile(path)
    result.artifactsRemoved++
    return 'removed'
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return 'missing'
    result.errors++
    return 'error'
  }
}

function cleanupReadBlocksRemoval<T>(
  read: CleanupJsonRead<T>,
  result: BackgroundCleanupResult,
): boolean {
  if (read.state === 'error') {
    result.errors++
    return true
  }
  return read.state === 'invalid'
}

function terminalFactCandidateFromEntry(
  entry: Dirent<string>,
): {
  id: string
  kind: 'natural' | 'killed'
  generation?: string
} | null {
  if (!entry.isFile()) return null
  const markedMatch =
    /^(.*)~([a-f0-9]{64})\.(natural|killed)\.json$/.exec(entry.name)
  const legacyMatch = /^(.*)\.(natural|killed)\.json$/.exec(entry.name)
  const match = markedMatch ?? legacyMatch
  if (!match) return null
  const id = match[1]
  const generation = markedMatch?.[2]
  const kind = markedMatch?.[3] ?? legacyMatch?.[2]
  if (!id || !kind || !SAFE_ID_RE.test(id)) return null
  if (
    generation !== undefined &&
    !isValidBackgroundProcessMarker(generation)
  ) {
    return null
  }
  return {
    id,
    kind: kind as 'natural' | 'killed',
    ...(generation ? { generation } : {}),
  }
}

async function cleanupOrphanedTerminalFacts(
  cutoffMs: number,
  metadataDirectory: CleanupDirectorySnapshot,
  terminalDirectory: CleanupDirectorySnapshot,
  metadataIds: ReadonlySet<string>,
  result: BackgroundCleanupResult,
  fileSystem: BackgroundCleanupFileSystem,
  maxDirectoryEntries?: number,
  targets?: readonly BackgroundSessionRecoveryTarget[],
  onRetry?: (target?: BackgroundSessionRecoveryTarget) => void,
): Promise<void> {
  const terminalDirectoryState = await inspectCleanupDirectory(
    terminalDirectory,
    fileSystem.lstatFile,
  )
  if (terminalDirectoryState === 'missing') return
  if (terminalDirectoryState !== 'same') {
    result.errors++
    onRetry?.()
    return
  }

  let candidates: NonNullable<
    ReturnType<typeof terminalFactCandidateFromEntry>
  >[]
  if (targets !== undefined) {
    candidates = targets
      .filter(
        target =>
          backgroundRecoveryJournalRecord(target.id, target.generation) !==
          undefined,
      )
      .flatMap(target => [
        { ...target, kind: 'natural' as const },
        { ...target, kind: 'killed' as const },
      ])
  } else {
    let entries: Dirent<string>[]
    try {
      entries = await readDirectoryEntries(
        getBackgroundSessionTerminalDir(),
        maxDirectoryEntries,
      )
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) {
        result.errors++
        onRetry?.()
      }
      return
    }
    const terminalDirectoryAfterRead = await inspectCleanupDirectory(
      terminalDirectory,
      fileSystem.lstatFile,
    )
    if (terminalDirectoryAfterRead !== 'same') {
      if (terminalDirectoryAfterRead !== 'missing') {
        result.errors++
        onRetry?.()
      }
      return
    }

    candidates = entries
      .map(terminalFactCandidateFromEntry)
      .filter(
        (candidate): candidate is NonNullable<typeof candidate> =>
          candidate !== null && !metadataIds.has(candidate.id),
      )
      .sort((a, b) => {
        const idOrder = a.id.localeCompare(b.id)
        if (idOrder !== 0) return idOrder
        const markerOrder = (a.generation ?? '').localeCompare(
          b.generation ?? '',
        )
        return markerOrder !== 0
          ? markerOrder
          : a.kind.localeCompare(b.kind)
      })
  }
  if (candidates.length === 0) return

  for (const candidate of candidates) {
    const errorsBefore = result.errors
    try {
      const factPath = terminalFactPathForId(
        candidate.id,
        candidate.kind,
        candidate.generation,
      )
      const fact = await readCleanupJson(
        factPath,
        (value): value is BackgroundSessionTerminalFact =>
          isBackgroundSessionTerminalFact(
            value,
            candidate.id,
            candidate.kind,
          ) &&
          value.generation === candidate.generation &&
          parseCanonicalCompletionTimestamp(value.finishedAt) !== null,
        terminalDirectory,
        fileSystem,
      )
      if (fact.state === 'error') {
        result.errors++
        continue
      }
      if (
        fact.state !== 'valid' ||
        Date.parse(fact.value.finishedAt) >= cutoffMs
      ) {
        continue
      }

      const metadata = await readCleanupJson(
        metadataPathForId(candidate.id),
        (value): value is BackgroundSession =>
          isBackgroundSession(value, candidate.id),
        metadataDirectory,
        fileSystem,
      )
      if (metadata.state === 'error') {
        result.errors++
        continue
      }
      if (metadata.state !== 'missing') continue

      await removeCleanupArtifact(
        factPath,
        result,
        terminalDirectory,
        fileSystem,
        fact.identity,
      )
    } finally {
      if (result.errors > errorsBefore) onRetry?.(candidate)
    }
  }
}

/**
 * Removes session metadata temp files left behind when a publish was
 * interrupted (for example, SIGKILL between writeFile and rename).
 * A temp file is removed only when it is older than both the retention
 * cutoff and the publish grace period, and — when its name carries the
 * publishing session id — only while that session's per-ID lock is free:
 * writeNewSession and replaceSessionFile hold the lock for the whole
 * write+rename, so a held lock means a publish is in flight even when a
 * wall-clock jump makes the file look older than the grace period. The
 * lock alone cannot prove that: a clock jump can also age the lock past
 * proper-lockfile's stale threshold, so when the lock is held, a temp
 * file whose publisher pid is still alive is never removed, whatever the
 * lock's mtime says. Temp files whose names do not carry a session id
 * keep the age-only behavior. Removed files count as artifacts in the
 * cleanup result.
 */
async function cleanupAbandonedSessionTempFilesInDirectory(
  cutoffMs: number,
  metadataDirectory: CleanupDirectorySnapshot,
  fileSystem: BackgroundCleanupFileSystem,
  result: BackgroundCleanupResult,
  maxDirectoryEntries?: number,
): Promise<void> {
  const directoryState = await inspectCleanupDirectory(
    metadataDirectory,
    fileSystem.lstatFile,
  )
  if (directoryState !== 'same') {
    if (directoryState !== 'missing') result.errors++
    return
  }
  let entries: Dirent<string>[]
  try {
    entries = await readDirectoryEntries(
      getBackgroundSessionMetadataDir(),
      maxDirectoryEntries,
    )
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) result.errors++
    return
  }
  // A temp file is abandoned only when it is older than the retention
  // cutoff and older than the publish grace period. The grace period
  // alone cannot prove a file is abandoned: a wall-clock jump forward
  // during a publish makes a fresh temp file look old, so the publisher
  // pid and the per-ID lock below are the checks that decide.
  const oldestActiveMs = Date.now() - ABANDONED_SESSION_TEMP_FILE_MIN_AGE_MS
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.tmp')) continue
    const path = join(getBackgroundSessionMetadataDir(), entry.name)
    let stats: Stats
    try {
      stats = await fileSystem.lstatFile(path)
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) result.errors++
      continue
    }
    if (!stats.isFile() || stats.isSymbolicLink()) continue
    if (stats.mtimeMs >= cutoffMs || stats.mtimeMs >= oldestActiveMs) {
      continue
    }
    // A publisher holds the per-ID lock for the whole write+rename, so
    // try to take it without waiting: if it is held, a publish for this
    // session is in flight and the temp file must stay, whatever its
    // mtime says. A lock that cannot be taken for any other reason also
    // leaves the file for a later sweep; the file is stale, not lost.
    const sessionId = sessionIdFromTempFileName(entry.name)
    // The pid embedded in the temp file name is the publisher, so when
    // the per-ID lock is actually held, a live pid means a publish for
    // this file may still be in flight even when the lock looks stale:
    // a wall-clock jump can age the lock past proper-lockfile's stale
    // threshold, and that threshold cannot be disabled (stale: 0/false
    // clamps to 2000ms), so the lock acquire below cannot prove a live
    // publisher is gone. With no lock held, no publish can be in flight
    // for this id — a publisher holds the lock for the whole write+rename
    // — so a leftover temp is abandoned whatever its pid says. A dead
    // pid means the publisher is gone; the lock acquire still guards a
    // live publisher for the same id that owns a different temp file.
    const publisherPid = publisherPidFromTempFileName(entry.name)
    if (
      sessionId !== undefined &&
      publisherPid !== undefined &&
      isBackgroundSessionPublisherAlive(publisherPid)
    ) {
      try {
        // proper-lockfile's lockfile path for a locked file is
        // `<file>.lock` (no custom lockfilePath is used here); existence
        // alone is the signal — the mtime is what a clock jump corrupts.
        if (
          (await lstat(`${metadataPathForId(sessionId)}.lock`)).isDirectory()
        ) {
          continue
        }
      } catch {
        // No lock held: fall through to the acquire below.
      }
    }
    let releasePublishLock: (() => Promise<void>) | undefined
    if (sessionId !== undefined) {
      try {
        releasePublishLock = await lockfile.lock(
          metadataPathForId(sessionId),
          {
            ...NAME_RESERVATION_LOCK_OPTIONS,
            retries: 0,
          },
        )
      } catch {
        continue
      }
    }
    try {
      await fileSystem.unlinkFile(path)
      result.artifactsRemoved++
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) result.errors++
    } finally {
      await releasePublishLock?.().catch(() => {})
    }
  }
}

/**
 * Removes abandoned session metadata temp files once, for a whole
 * retention sweep or recovery batch. Use this instead of running the
 * per-call temp cleanup inside every cleanupBackgroundSessionsBefore call
 * when a batch processes many session ids: one directory scan covers the
 * batch, rather than one scan per id (CodeRabbit #2497).
 */
export async function cleanupAbandonedSessionTempFiles(
  cutoff: Date,
  options: { maxDirectoryEntries?: number } = {},
): Promise<BackgroundCleanupResult> {
  const result: BackgroundCleanupResult = {
    sessionsRemoved: 0,
    artifactsRemoved: 0,
    errors: 0,
  }
  const cutoffMs = cutoff.getTime()
  if (!Number.isFinite(cutoffMs)) {
    result.errors++
    return result
  }
  const fileSystem: BackgroundCleanupFileSystem = {
    lstatFile: lstat,
    readTextFile: async path => await readFile(path, 'utf8'),
    unlinkFile: async path => await unlink(path),
  }
  const metadataRead = await snapshotCleanupDirectory(
    getBackgroundSessionMetadataDir(),
    fileSystem.lstatFile,
  )
  if (metadataRead.state !== 'valid') {
    result.errors++
    return result
  }
  await cleanupAbandonedSessionTempFilesInDirectory(
    cutoffMs,
    metadataRead.value,
    fileSystem,
    result,
    options.maxDirectoryEntries,
  )
  return result
}

export async function cleanupBackgroundSessionsBefore(
  cutoff: Date,
  options: {
    lstatFile?: BackgroundCleanupFileSystem['lstatFile']
    readTextFile?: BackgroundCleanupFileSystem['readTextFile']
    unlinkFile?: BackgroundCleanupFileSystem['unlinkFile']
    _beforeMetadataDirectoryReadForTesting?: () => Promise<void>
    _beforeArtifactRemovalForTesting?: (id: string) => Promise<void>
    _beforeReservationRemovalForTesting?: (path: string) => Promise<void>
    sessionIds?: readonly string[]
    // Skip the trailing abandoned-temp-file cleanup: a caller processing
    // a batch of ids runs cleanupAbandonedSessionTempFiles once for the
    // whole batch instead of once per id (CodeRabbit #2497).
    skipAbandonedTempFileCleanup?: boolean
    onRetry?: (target?: BackgroundSessionRecoveryTarget) => void
    orphanedTerminalFacts?: readonly BackgroundSessionRecoveryTarget[]
    maxDirectoryEntries?: number
  } = {},
): Promise<BackgroundCleanupResult> {
  const result: BackgroundCleanupResult = {
    sessionsRemoved: 0,
    artifactsRemoved: 0,
    errors: 0,
  }
  const cutoffMs = cutoff.getTime()
  if (!Number.isFinite(cutoffMs)) {
    result.errors++
    options.onRetry?.()
    return result
  }

  const fileSystem: BackgroundCleanupFileSystem = {
    lstatFile: options.lstatFile ?? lstat,
    readTextFile:
      options.readTextFile ?? (async path => await readFile(path, 'utf8')),
    unlinkFile: options.unlinkFile ?? (async path => await unlink(path)),
  }
  const directoryReads = await Promise.all(
    [
      getBackgroundSessionMetadataDir(),
      getBackgroundSessionLogsDir(),
      getBackgroundSessionNamesDir(),
      getBackgroundSessionTerminalDir(),
    ].map(
      async path =>
        await snapshotCleanupDirectory(path, fileSystem.lstatFile),
    ),
  )
  const [metadataRead, logsRead, namesRead, terminalRead] = directoryReads
  const requiredDirectoryReads = [metadataRead, logsRead, terminalRead]
  const requiredDirectoryErrors = requiredDirectoryReads.filter(
    read => read.state === 'error' || read.state === 'invalid',
  ).length
  if (requiredDirectoryErrors > 0) {
    result.errors += requiredDirectoryErrors
    options.onRetry?.()
    return result
  }
  const metadataDirectory =
    metadataRead.state === 'valid' ? metadataRead.value : undefined
  const logsDirectory =
    logsRead.state === 'valid' ? logsRead.value : undefined
  const namesDirectory =
    namesRead.state === 'valid' ? namesRead.value : undefined
  const terminalDirectory =
    terminalRead.state === 'valid' ? terminalRead.value : undefined
  if (!metadataDirectory || !logsDirectory || !terminalDirectory) {
    if (result.errors > 0) options.onRetry?.()
    return result
  }
  if (metadataDirectory.state === 'missing') {
    if (options.sessionIds !== undefined && !options.orphanedTerminalFacts)
      return result
    await cleanupOrphanedTerminalFacts(
      cutoffMs,
      metadataDirectory,
      terminalDirectory,
      new Set(),
      result,
      fileSystem,
      options.maxDirectoryEntries,
      options.orphanedTerminalFacts,
      options.onRetry,
    )
    return result
  }
  const metadataDirectoryState = await inspectCleanupDirectory(
    metadataDirectory,
    fileSystem.lstatFile,
  )
  if (metadataDirectoryState !== 'same') {
    if (metadataDirectoryState !== 'missing') result.errors++
    if (result.errors > 0) options.onRetry?.()
    return result
  }

  let candidateIds: string[]
  if (options.sessionIds !== undefined) {
    candidateIds = [
      ...new Set(options.sessionIds.filter(id => SAFE_ID_RE.test(id))),
    ]
  } else {
    let entries: Dirent<string>[]
    try {
      await options._beforeMetadataDirectoryReadForTesting?.()
      entries = await readDirectoryEntries(
        getBackgroundSessionMetadataDir(),
        options.maxDirectoryEntries,
      )
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) result.errors++
      if (result.errors > 0) options.onRetry?.()
      return result
    }
    const metadataDirectoryAfterRead = await inspectCleanupDirectory(
      metadataDirectory,
      fileSystem.lstatFile,
    )
    if (metadataDirectoryAfterRead !== 'same') {
      if (metadataDirectoryAfterRead !== 'missing') result.errors++
      if (result.errors > 0) options.onRetry?.()
      return result
    }
    candidateIds = entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => basename(entry.name, '.json'))
      .filter(id => SAFE_ID_RE.test(id))
  }

  const metadataIds = new Set(candidateIds)

  for (const expectedId of candidateIds) {
    const errorsBefore = result.errors
    let retryGeneration: string | undefined
    try {
      const metadataPath = metadataPathForId(expectedId)
      const metadata = await readCleanupJson(
        metadataPath,
        (value): value is BackgroundSession =>
          isBackgroundSession(value, expectedId) &&
          (value.finishedAt === undefined ||
            parseCanonicalCompletionTimestamp(value.finishedAt) !== null),
        metadataDirectory,
        fileSystem,
      )
      if (metadata.state === 'error') {
        result.errors++
        continue
      }
      if (metadata.state !== 'valid') continue

      const session = metadata.value
      retryGeneration = session.terminalFactGeneration
      const naturalPath = terminalFactPathForId(
        session.id,
        'natural',
        session.terminalFactGeneration,
      )
      const killedPath = terminalFactPathForId(
        session.id,
        'killed',
        session.terminalFactGeneration,
      )
      const natural = await readCleanupJson(
        naturalPath,
        (value): value is BackgroundSessionTerminalFact =>
          isBackgroundSessionTerminalFact(value, session.id, 'natural') &&
          value.generation === session.terminalFactGeneration &&
          parseCanonicalCompletionTimestamp(value.finishedAt) !== null,
        terminalDirectory,
        fileSystem,
      )
      const killed = await readCleanupJson(
        killedPath,
        (value): value is BackgroundSessionTerminalFact =>
          isBackgroundSessionTerminalFact(value, session.id, 'killed') &&
          value.generation === session.terminalFactGeneration &&
          parseCanonicalCompletionTimestamp(value.finishedAt) !== null,
        terminalDirectory,
        fileSystem,
      )
      const naturalBlocksRemoval = cleanupReadBlocksRemoval(natural, result)
      const killedBlocksRemoval = cleanupReadBlocksRemoval(killed, result)
      if (
        naturalBlocksRemoval ||
        killedBlocksRemoval ||
        (natural.state === 'valid' && natural.value.pid !== session.pid) ||
        (killed.state === 'valid' && killed.value.pid !== session.pid)
      ) {
        continue
      }

      const effective = applyTerminalFacts(
        session,
        natural.state === 'valid' ? natural.value : null,
        killed.state === 'valid' ? killed.value : null,
      )
      if (
        effective.status !== 'exited' &&
        effective.status !== 'failed' &&
        effective.status !== 'killed'
      ) {
        continue
      }
      if (effective.finishedAt === undefined) continue
      const finishedAtMs = Date.parse(effective.finishedAt)
      if (!Number.isFinite(finishedAtMs) || finishedAtMs >= cutoffMs)
        continue

      let reservation:
        | CleanupJsonRead<BackgroundSessionNameReservation>
        | undefined
      if (session.name) {
        if (!namesDirectory) {
          result.errors++
          continue
        }
        reservation = await readCleanupJson(
          nameReservationPathForName(session.name),
          isBackgroundSessionNameReservation,
          namesDirectory,
          fileSystem,
        )
        if (reservation.state === 'error') {
          result.errors++
          continue
        }
      }

      try {
        await options._beforeArtifactRemovalForTesting?.(session.id)
        await withBackgroundSessionIdLock(session.id, async () => {
          const latestMetadata = await readCleanupJson(
            metadataPath,
            (value): value is BackgroundSession =>
              isBackgroundSession(value, session.id) &&
              (value.finishedAt === undefined ||
                parseCanonicalCompletionTimestamp(value.finishedAt) !==
                  null),
            metadataDirectory,
            fileSystem,
          )
          if (latestMetadata.state === 'error') {
            result.errors++
            return
          }
          if (
            latestMetadata.state !== 'valid' ||
            !latestMetadata.identity ||
            !metadata.identity ||
            latestMetadata.identity.dev !== metadata.identity.dev ||
            latestMetadata.identity.ino !== metadata.identity.ino ||
            !isSameBackgroundSessionGeneration(
              latestMetadata.value,
              session,
            )
          ) {
            return
          }

          const logPaths = getBackgroundSessionLogPaths(session.id)
          const stdoutRemoval = await removeCleanupArtifact(
            logPaths.stdoutLogPath,
            result,
            logsDirectory,
            fileSystem,
          )
          const stderrRemoval = await removeCleanupArtifact(
            logPaths.stderrLogPath,
            result,
            logsDirectory,
            fileSystem,
          )
          let reservationRemoval: CleanupArtifactRemoval = 'missing'
          const sessionName = session.name
          if (
            sessionName &&
            reservation?.state === 'valid' &&
            namesDirectory
          ) {
            try {
              reservationRemoval = await withNameReservationLock(
                sessionName,
                async () => {
                  const latestReservation = await readCleanupJson(
                    nameReservationPathForName(sessionName),
                    isBackgroundSessionNameReservation,
                    namesDirectory,
                    fileSystem,
                  )
                  if (latestReservation.state === 'error') {
                    result.errors++
                    return 'error'
                  }
                  if (
                    latestReservation.state !== 'valid' ||
                    latestReservation.value.name !== sessionName ||
                    latestReservation.value.id !== session.id
                  ) {
                    return 'missing'
                  }
                  const reservationPath =
                    nameReservationPathForName(sessionName)
                  await options._beforeReservationRemovalForTesting?.(
                    reservationPath,
                  )
                  return await removeCleanupArtifact(
                    reservationPath,
                    result,
                    namesDirectory,
                    fileSystem,
                    latestReservation.identity,
                  )
                },
              )
            } catch {
              result.errors++
              reservationRemoval = 'error'
            }
          }
          if (
            stdoutRemoval === 'error' ||
            stderrRemoval === 'error' ||
            reservationRemoval === 'error'
          ) {
            return
          }

          const metadataRemoval = await removeCleanupArtifact(
            metadataPath,
            result,
            metadataDirectory,
            fileSystem,
            latestMetadata.identity,
          )
          if (metadataRemoval === 'error') return
          if (metadataRemoval === 'removed') result.sessionsRemoved++

          const errorsBeforeFacts = result.errors
          if (natural.state === 'valid') {
            await removeCleanupArtifact(
              naturalPath,
              result,
              terminalDirectory,
              fileSystem,
              natural.identity,
            )
          }
          if (killed.state === 'valid') {
            await removeCleanupArtifact(
              killedPath,
              result,
              terminalDirectory,
              fileSystem,
              killed.identity,
            )
          }
          if (result.errors > errorsBeforeFacts) {
            const target = {
              id: session.id,
              generation: session.terminalFactGeneration,
            }
            if (!options.onRetry) {
              await enqueueBackgroundSessionRecovery(
                target.id,
                target.generation,
              )
            }
          }
        })
      } catch {
        result.errors++
      }
    } finally {
      if (result.errors > errorsBefore) {
        options.onRetry?.({ id: expectedId, generation: retryGeneration })
      }
    }
  }

  if (
    options.sessionIds === undefined ||
    options.orphanedTerminalFacts !== undefined
  ) {
    await cleanupOrphanedTerminalFacts(
      cutoffMs,
      metadataDirectory,
      terminalDirectory,
      options.sessionIds === undefined ? metadataIds : new Set(),
      result,
      fileSystem,
      options.maxDirectoryEntries,
      options.orphanedTerminalFacts,
      options.onRetry,
    )
  }

  if (!options.skipAbandonedTempFileCleanup) {
    await cleanupAbandonedSessionTempFilesInDirectory(
      cutoffMs,
      metadataDirectory,
      fileSystem,
      result,
      options.maxDirectoryEntries,
    )
  }

  return result
}

export async function readBackgroundSessionForOwner(
  id: string,
): Promise<BackgroundSession | null> {
  assertSafeId(id)
  return await readSessionFile(metadataPathForId(id))
}

export async function assertBackgroundSessionNameAvailable(
  name: string | undefined,
): Promise<void> {
  if (!name) return
  const existing = (await listBackgroundSessions()).find(
    s => s.name === name && !isTerminalBackgroundSession(s),
  )
  if (existing) {
    throw new Error(
      `Background session name "${name}" already exists (${existing.id})`,
    )
  }
}

export async function createBackgroundSession(
  input: CreateBackgroundSessionInput,
): Promise<BackgroundSession> {
  if (!Number.isInteger(input.pid) || input.pid <= 0) {
    throw new Error(`Invalid background session pid: ${input.pid}`)
  }
  if (
    input.processMarker !== undefined &&
    !isValidBackgroundProcessMarker(input.processMarker)
  ) {
    throw new Error('Invalid background process marker')
  }
  await assertBackgroundSessionNameAvailable(input.name)
  const timestamp = iso(input.now)
  const logPaths = getBackgroundSessionLogPaths(input.id)
  const session: BackgroundSession = {
    id: input.id,
    ...(input.name ? { name: input.name } : {}),
    pid: input.pid,
    cwd: input.cwd,
    status: 'running',
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    sessionId: input.sessionId,
    ...(input.processMarker
      ? { processMarker: input.processMarker }
      : {}),
    ...(input.processMarker
      ? { terminalFactGeneration: input.processMarker }
      : {}),
    startedAt: timestamp,
    updatedAt: timestamp,
    command: input.command,
    stdoutLogPath: input.stdoutLogPath ?? logPaths.stdoutLogPath,
    stderrLogPath: input.stderrLogPath ?? logPaths.stderrLogPath,
  }

  await ensureBackgroundSessionDirs()
  let createdStdoutLog = false
  let createdStderrLog = false
  let releaseReservedName: (() => Promise<void>) | undefined
  try {
    releaseReservedName = input.name
      ? await reserveBackgroundSessionName(input.name, input.id)
      : undefined
    if (input.logFilesPrecreated) {
      if (!(await backgroundSessionLogExists(session.stdoutLogPath))) {
        throw new Error(
          `Background session log file does not exist: ${session.stdoutLogPath}`,
        )
      }
      if (!(await backgroundSessionLogExists(session.stderrLogPath))) {
        throw new Error(
          `Background session log file does not exist: ${session.stderrLogPath}`,
        )
      }
    } else {
      await writeFile(session.stdoutLogPath, '', { flag: 'wx' })
      createdStdoutLog = true
      await writeFile(session.stderrLogPath, '', { flag: 'wx' })
      createdStderrLog = true
    }
    await writeNewSession(session)
  } catch (error) {
    if (createdStdoutLog) await unlink(session.stdoutLogPath).catch(() => {})
    if (createdStderrLog) await unlink(session.stderrLogPath).catch(() => {})
    await releaseReservedName?.()
    if (isErrno(error, 'EEXIST')) {
      throw new Error(`Background session id "${session.id}" already exists`)
    }
    throw error
  }
  return session
}

async function resolveBackgroundSessionWithList(
  target: string,
  listSessions: () => Promise<BackgroundSession[]>,
): Promise<BackgroundSession> {
  if (SAFE_ID_RE.test(target)) {
    const exact = await readSessionFile(metadataPathForId(target))
    if (exact) return await applyAuthoritativeTerminalFacts(exact)
  }

  const sessions = await listSessions()
  const exactId = sessions.filter(s => s.id === target)
  if (exactId.length === 1) return exactId[0]

  const byName = sessions.filter(s => s.name === target)
  const liveByName = byName.filter(s => !isTerminalBackgroundSession(s))
  if (liveByName.length === 1) return liveByName[0]
  if (liveByName.length > 1) {
    throw new Error(`Background session name "${target}" is ambiguous`)
  }

  const idPrefix = sessions.filter(s => s.id.startsWith(target))
  if (idPrefix.length === 1) return idPrefix[0]
  if (idPrefix.length > 1) {
    throw new Error(`Background session id "${target}" is ambiguous`)
  }

  if (byName.length === 1) return byName[0]
  if (byName.length > 1) {
    throw new Error(`Background session name "${target}" is ambiguous`)
  }

  throw new Error(`No background session found for "${target}"`)
}

export async function resolveBackgroundSession(
  target: string,
): Promise<BackgroundSession> {
  return await resolveBackgroundSessionWithList(target, listBackgroundSessions)
}

export const __test = {
  resolveBackgroundSessionWithList,
}

// ---------------------------------------------------------------------------
// `wait`-only strict read path (issue #2162).
//
// The display commands (ps/logs/attach/kill) intentionally collapse missing,
// unreadable, malformed, and invalid registry documents to null. That
// tolerance cannot support `wait`'s exit-code contract, so `wait` reads the
// pinned session and its terminal facts strictly instead. Nothing below is
// used by the display commands; do not widen it into a shared reader.
// ---------------------------------------------------------------------------

export type BackgroundSessionWaitErrorCode =
  | 'metadata_missing'
  | 'metadata_unreadable'
  | 'metadata_malformed'
  | 'metadata_replaced'
  | 'invalid_arguments'
  | 'not_found'
  | 'ambiguous'
  | 'unsupported'

export class BackgroundSessionWaitError extends Error {
  readonly code: BackgroundSessionWaitErrorCode
  readonly pinnedId: string | null

  constructor(
    code: BackgroundSessionWaitErrorCode,
    message: string,
    pinnedId: string | null = null,
  ) {
    super(message)
    this.name = 'BackgroundSessionWaitError'
    this.code = code
    this.pinnedId = pinnedId
  }
}

type StrictSessionRead =
  | { state: 'missing' }
  | { state: 'valid'; value: BackgroundSession }
  | { state: 'unreadable' }
  | { state: 'malformed' }

async function readSessionFileStrict(
  path: string,
  id: string,
): Promise<StrictSessionRead> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    return isErrno(error, 'ENOENT')
      ? { state: 'missing' }
      : { state: 'unreadable' }
  }
  let parsed: unknown
  try {
    parsed = jsonParse(content)
  } catch {
    return { state: 'malformed' }
  }
  return isBackgroundSession(parsed, id)
    ? { state: 'valid', value: parsed }
    : { state: 'malformed' }
}

type StrictTerminalFactRead =
  | { state: 'missing' }
  | { state: 'valid'; value: BackgroundSessionTerminalFact }
  | { state: 'unreadable' }
  | { state: 'malformed' }

async function readTerminalFactStrict(
  id: string,
  kind: 'natural' | 'killed',
  generation?: string,
): Promise<StrictTerminalFactRead> {
  let content: string
  try {
    content = await readFile(
      terminalFactPathForId(id, kind, generation),
      'utf8',
    )
  } catch (error) {
    return isErrno(error, 'ENOENT')
      ? { state: 'missing' }
      : { state: 'unreadable' }
  }
  let parsed: unknown
  try {
    parsed = jsonParse(content)
  } catch {
    return { state: 'malformed' }
  }
  return isBackgroundSessionTerminalFact(parsed, id, kind) &&
    parsed.generation === generation
    ? { state: 'valid', value: parsed }
    : { state: 'malformed' }
}

function throwWaitMetadataError(
  state: 'unreadable' | 'malformed',
  what: string,
  pinnedId: string | null,
): never {
  if (state === 'unreadable') {
    throw new BackgroundSessionWaitError(
      'metadata_unreadable',
      `${what} could not be read`,
      pinnedId,
    )
  }
  throw new BackgroundSessionWaitError(
    'metadata_malformed',
    `${what} is malformed`,
    pinnedId,
  )
}

async function readEffectiveSessionStrict(
  session: BackgroundSession,
  pinnedId: string | null,
): Promise<BackgroundSession> {
  const natural = await readTerminalFactStrict(
    session.id,
    'natural',
    session.terminalFactGeneration,
  )
  if (natural.state === 'unreadable' || natural.state === 'malformed') {
    throwWaitMetadataError(
      natural.state,
      `Terminal fact for background session ${session.id}`,
      pinnedId,
    )
  }
  const killed = await readTerminalFactStrict(
    session.id,
    'killed',
    session.terminalFactGeneration,
  )
  if (killed.state === 'unreadable' || killed.state === 'malformed') {
    throwWaitMetadataError(
      killed.state,
      `Terminal fact for background session ${session.id}`,
      pinnedId,
    )
  }
  const naturalFact = natural.state === 'valid' ? natural.value : null
  const killedFact = killed.state === 'valid' ? killed.value : null
  // A fact published by another PID is not this session's outcome:
  // applyTerminalFacts ignores pid-mismatched facts, matching the
  // non-strict registry reader, so name resolution can still select the
  // session. Actual metadata replacement is reported by the separate
  // pinned-PID check in readPinnedBackgroundSessionForWait, which stays
  // (CodeRabbit #2497).
  return applyTerminalFacts(session, naturalFact, killedFact)
}

/**
 * Strict `wait`-only selector resolution. Preserves the display commands'
 * selection order (exact ID, one live session with the exact name, one
 * unambiguous ID prefix, one terminal session with the exact name) but
 * distinguishes the failure modes `wait` must report: a missing exact-ID
 * file still allows name or prefix matching, while an unreadable or
 * malformed entry that could change matching fails with exit code 4.
 */
export async function resolveBackgroundSessionForWait(
  target: string,
): Promise<BackgroundSession> {
  if (SAFE_ID_RE.test(target)) {
    const exact = await readSessionFileStrict(
      metadataPathForId(target),
      target,
    )
    if (exact.state === 'unreadable' || exact.state === 'malformed') {
      throwWaitMetadataError(
        exact.state,
        `Background session ${target} metadata`,
        null,
      )
    }
    if (exact.state === 'valid') {
      return await readEffectiveSessionStrict(exact.value, null)
    }
    // A missing exact-ID file can still allow name or prefix matching.
  }

  let entries: string[]
  try {
    entries = await readdir(getBackgroundSessionMetadataDir())
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      throw new BackgroundSessionWaitError(
        'not_found',
        `No background session found for "${target}"`,
      )
    }
    throw new BackgroundSessionWaitError(
      'metadata_unreadable',
      'Background session metadata could not be read',
    )
  }

  const candidates: BackgroundSession[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const id = entry.slice(0, -'.json'.length)
    if (!SAFE_ID_RE.test(id)) continue
    const read = await readSessionFileStrict(metadataPathForId(id), id)
    if (read.state === 'missing') continue
    if (read.state === 'unreadable' || read.state === 'malformed') {
      // The name lives inside the file, so any entry could be the named or
      // prefix-matched session; it cannot be skipped safely.
      throwWaitMetadataError(
        read.state,
        `Background session ${id} metadata`,
        null,
      )
    }
    candidates.push(read.value)
  }

  const exactId = candidates.filter(s => s.id === target)
  if (exactId.length === 1) {
    return await readEffectiveSessionStrict(exactId[0], null)
  }

  // Liveness is an effective-status property, so name candidates need their
  // terminal facts applied strictly before the live/terminal split.
  const byName = candidates.filter(s => s.name === target)
  const effectiveByName: BackgroundSession[] = []
  for (const session of byName) {
    effectiveByName.push(await readEffectiveSessionStrict(session, null))
  }
  const liveByName = effectiveByName.filter(
    s => !isTerminalBackgroundSession(s),
  )
  if (liveByName.length === 1) return liveByName[0]
  if (liveByName.length > 1) {
    throw new BackgroundSessionWaitError(
      'ambiguous',
      `Background session name "${target}" is ambiguous`,
    )
  }

  const idPrefix = candidates.filter(s => s.id.startsWith(target))
  if (idPrefix.length === 1) {
    return await readEffectiveSessionStrict(idPrefix[0], null)
  }
  if (idPrefix.length > 1) {
    throw new BackgroundSessionWaitError(
      'ambiguous',
      `Background session id "${target}" is ambiguous`,
    )
  }

  if (effectiveByName.length === 1) return effectiveByName[0]
  if (effectiveByName.length > 1) {
    throw new BackgroundSessionWaitError(
      'ambiguous',
      `Background session name "${target}" is ambiguous`,
    )
  }

  throw new BackgroundSessionWaitError(
    'not_found',
    `No background session found for "${target}"`,
  )
}

/**
 * Strict `wait`-only re-read of an already-pinned session. A missing file, a
 * changed PID, or an unreadable/malformed document fails with exit code 4
 * instead of being treated as absent, so a reused name or a replaced
 * metadata file can never retarget an active waiter.
 */
export async function readPinnedBackgroundSessionForWait(pinned: {
  id: string
  pid: number
}): Promise<BackgroundSession> {
  const read = await readSessionFileStrict(
    metadataPathForId(pinned.id),
    pinned.id,
  )
  if (read.state === 'missing') {
    throw new BackgroundSessionWaitError(
      'metadata_missing',
      `Background session ${pinned.id} metadata is missing`,
      pinned.id,
    )
  }
  if (read.state === 'unreadable' || read.state === 'malformed') {
    throwWaitMetadataError(
      read.state,
      `Background session ${pinned.id} metadata`,
      pinned.id,
    )
  }
  if (read.value.pid !== pinned.pid) {
    throw new BackgroundSessionWaitError(
      'metadata_replaced',
      `Background session ${pinned.id} metadata was replaced`,
      pinned.id,
    )
  }
  return await readEffectiveSessionStrict(read.value, pinned.id)
}

export async function refreshBackgroundSessionStatuses(options?: {
  isProcessAlive?: (pid: number) => boolean
  getProcessCommand?: (pid: number) => string | null
  now?: Date
  _beforeStatusWriteForTesting?: (
    session: BackgroundSession,
    nextStatus: BackgroundSessionStatus,
  ) => Promise<void>
  _whileStatusWriteLockedForTesting?: (
    session: BackgroundSession,
    nextStatus: BackgroundSessionStatus,
  ) => void | Promise<void>
}): Promise<BackgroundSession[]> {
  const timestamp = iso(options?.now)
  const sessions = await listBackgroundSessions()
  const refreshed: BackgroundSession[] = []

  for (const session of sessions) {
    if (session.status !== 'running' && session.status !== 'unknown') {
      refreshed.push(session)
      continue
    }

    const processState = verifyBackgroundSessionProcessIdentity(
      session,
      options,
    ).state
    const nextStatus: BackgroundSessionStatus =
      processState === 'matches'
        ? 'running'
        : processState === 'unreadable'
          ? 'unknown'
          : 'stale'

    if (session.status !== nextStatus) {
      const updated = {
        ...session,
        status: nextStatus,
        updatedAt: timestamp,
      }
      await options?._beforeStatusWriteForTesting?.(session, nextStatus)
      const persisted = await writeSession(updated, session, () =>
        options?._whileStatusWriteLockedForTesting?.(session, nextStatus),
      )
      if (persisted) {
        refreshed.push(await applyAuthoritativeTerminalFacts(persisted))
      }
      continue
    }

    refreshed.push(session)
  }

  return refreshed
}

export type BackgroundSessionProcessIdentityAsyncOptions =
  Omit<BackgroundSessionProcessIdentityOptions, 'getProcessCommand'> & {
    signal?: AbortSignal
    getProcessCommandAsync?: (
      pid: number,
      options: { signal?: AbortSignal },
    ) => Promise<string | null>
  }

export type RefreshBackgroundSessionStatusOptions =
  BackgroundSessionProcessIdentityAsyncOptions & {
    now?: Date
  }

/**
 * Awaits `promise` but stops waiting when `signal` fires, resolving null
 * instead: a stalled session or terminal-fact read cannot wedge a follower
 * that is already shutting down. The raced promise is left to settle on
 * its own; callers treat null as unknown state, never as terminal success.
 */
async function settleOnAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | null> {
  if (!signal) return await promise
  if (signal.aborted) return null
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<null>(resolve => {
        onAbort = () => resolve(null)
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Refreshes exactly one background session by exact id, sharing the bulk
 * refresh's terminal-fact precedence and PID identity rules. The pinned
 * session's recorded terminal facts win first; otherwise the live process
 * identity decides between running, unknown, and stale.
 *
 * This is a read-only view refresh for a follower that already pinned its
 * session: it never scans or rewrites other sessions, and it never writes
 * the pinned session's metadata back (persisting a stale transition stays
 * with the bulk refresh). A missing or unreadable session returns null,
 * which callers treat as unknown state rather than terminal success. When
 * the caller's signal fires, the registry reads stop being awaited and
 * null is returned instead of leaving the follower waiting on a stalled
 * probe. A terminal fact that exists but cannot be read is not a missing
 * fact: when the process is gone and no readable fact establishes
 * termination, the session is reported unknown so the follower keeps
 * retrying the metadata read instead of completing as stale.
 */
export async function refreshBackgroundSessionStatus(
  id: string,
  options: RefreshBackgroundSessionStatusOptions = {},
): Promise<BackgroundSession | null> {
  assertSafeId(id)
  const session = await settleOnAbort(
    readSessionFile(metadataPathForId(id)),
    options.signal,
  )
  if (!session) return null

  const factApplication = await settleOnAbort(
    applyAuthoritativeTerminalFactsDetailed(session),
    options.signal,
  )
  if (!factApplication) return null
  const effective = factApplication.session
  if (effective.status !== 'running' && effective.status !== 'unknown') {
    if (
      effective.status === 'stale' &&
      factApplication.terminalFactReadError
    ) {
      // A stored stale status can mean the bulk refresh found the process
      // gone while a terminal fact was unreadable: the bulk refresh stores
      // stale without the read-error flag, so the stored status alone does
      // not establish termination. If the fact is still unreadable now,
      // report unknown so the follower keeps retrying the fact read
      // instead of exiting after its final drain. A genuinely missing fact
      // takes the plain stale return below instead.
      return { ...effective, status: 'unknown', updatedAt: iso(options.now) }
    }
    return effective
  }

  const identity = await settleOnAbort(
    verifyBackgroundSessionProcessIdentityAsync(effective, options),
    options.signal,
  )
  if (!identity) return null
  const nextStatus: BackgroundSessionStatus =
    identity.state === 'matches'
      ? 'running'
      : identity.state === 'unreadable'
        ? 'unknown'
        : 'stale'
  if (
    nextStatus === 'stale' &&
    factApplication.terminalFactReadError
  ) {
    // The process is gone, but a terminal fact that cannot be read leaves
    // termination unestablished: the fact may become readable on a later
    // tick (for example a transient read failure), so report unknown and
    // let the follower retry the metadata read. A genuinely missing fact
    // still reports stale, and a live, matching process still reports
    // running — only the would-be stale outcome is held back.
    return effective.status === 'unknown'
      ? effective
      : { ...effective, status: 'unknown', updatedAt: iso(options.now) }
  }
  if (nextStatus === effective.status) return effective
  return { ...effective, status: nextStatus, updatedAt: iso(options.now) }
}

export type BackgroundSessionProcessIdentity = {
  state: 'not-running' | 'matches' | 'mismatch' | 'unreadable'
  backgroundSessionId: string
  pid: number
}

export type BackgroundSessionProcessLiveness =
  | 'alive'
  | 'not-running'
  | 'unreadable'

export type BackgroundSessionProcessIdentityOptions = {
  isProcessAlive?: (pid: number) => boolean
  signalProcess?: (pid: number, signal: 0) => unknown
  getProcessCommand?: (pid: number) => string | null
}

// A spaced path or prompt is a single argv entry, but the raw command line
// quotes it, so a whitespace split fuses a quote onto the edge tokens. Windows
// `Get-CimInstance ... CommandLine` returns exactly this form — e.g.
//   "C:\Program Files\nodejs\node.exe" ...\cli.mjs --from-pr 1642 --print "refactor auth"
// splits to `"C:\Program`, `Files\nodejs\node.exe"`, ..., `"refactor`, `auth"`.
// The stored argv holds those same values unquoted, so trim a single leading
// and/or trailing quote from each token before comparing. POSIX `ps` output is
// unquoted, making this a no-op there, and it never widens the token-boundary
// match below (a stripped token still has to equal the stored one). See #1770.
function tokenizeCommandLine(value: string): string[] {
  return value
    .split(/\s+/)
    .map(token => token.replace(/^["']|["']$/g, ''))
    .filter(token => token.length > 0)
}

function commandLineContainsArgs(commandLine: string, args: string[]): boolean {
  if (args.length === 0) return false
  // Match the stored args against whole whitespace-delimited tokens, in order,
  // rather than as a raw substring. Substring matching let a stored selector
  // like "1642" satisfy a lookup against an unrelated live token "16420" (e.g. a
  // reused PID whose command line merely contains those digits), so a dead
  // session stayed classified as running. See #1770.
  //
  // A stored arg can itself contain whitespace — a prompt like "refactor auth"
  // is a single argv entry but `ps` renders it as separate words — so expand
  // each arg into its own tokens and require the flattened sequence to appear as
  // one CONTIGUOUS run of whole command tokens. An ordered-subsequence match
  // (skipping unrelated tokens between matches) would let a reused PID whose
  // command line merely interleaves the stored tokens pass — e.g. stored
  // ["node", "openclaude", "1642"] satisfied by "node attacker openclaude extra
  // 1642 --serve" — reopening the same wrong-process `kill` risk for token
  // insertion collisions. The real launch invocation appears as an unbroken run
  // (only the interpreter path or trailing flags differ), so leading/trailing
  // tokens are fine but interspersed ones are not.
  const tokens = tokenizeCommandLine(commandLine)
  const argTokens = args.flatMap(tokenizeCommandLine)
  if (argTokens.length === 0) return false
  if (argTokens.length > tokens.length) return false
  for (let start = 0; start <= tokens.length - argTokens.length; start += 1) {
    let matched = true
    for (let offset = 0; offset < argTokens.length; offset += 1) {
      if (tokens[start + offset] !== argTokens[offset]) {
        matched = false
        break
      }
    }
    if (matched) return true
  }
  return false
}

function commandLineMatchesBackgroundSession(
  commandLine: string,
  session: BackgroundSession,
): boolean {
  // Match the session id as a whole token, not a raw substring: an id like
  // "sess-1" must not match an unrelated live command that merely contains
  // "sess-100" (the same reused-PID collision this guard fixes for #1770).
  if (commandLineContainsArgs(commandLine, [session.sessionId])) return true
  // PR resume launches write to the resumed transcript id without carrying
  // that id on argv, so use the stored launch invocation as the PID guard.
  return commandLineContainsArgs(commandLine, session.command)
}

function markedCommandLineIdentity(
  commandLine: string,
  session: BackgroundSession,
  processMarker: string,
): 'matches' | 'mismatch' | 'unreadable' {
  const markerToken = backgroundProcessMarkerToken(processMarker)
  const storedTokens = session.command.flatMap(tokenizeCommandLine)
  const expectedIndex = storedTokens.indexOf(markerToken)
  if (expectedIndex === -1) return 'unreadable'

  const liveTokens = tokenizeCommandLine(commandLine)
  const comparablePrefixLength = Math.min(expectedIndex, liveTokens.length)
  for (let index = 0; index < comparablePrefixLength; index += 1) {
    if (liveTokens[index] !== storedTokens[index]) return 'mismatch'
  }

  if (liveTokens.length <= expectedIndex) return 'unreadable'
  const candidate = liveTokens[expectedIndex]!
  if (candidate === markerToken) return 'matches'
  if (
    expectedIndex === liveTokens.length - 1 &&
    candidate.length > 0 &&
    markerToken.startsWith(candidate)
  ) {
    return 'unreadable'
  }
  return 'mismatch'
}

export function verifyBackgroundSessionProcessIdentity(
  session: BackgroundSession,
  options?: BackgroundSessionProcessIdentityOptions,
): BackgroundSessionProcessIdentity {
  const result = (
    state: BackgroundSessionProcessIdentity['state'],
  ): BackgroundSessionProcessIdentity => ({
    state,
    backgroundSessionId: session.id,
    pid: session.pid,
  })
  const getLiveness = () =>
    getBackgroundSessionProcessLiveness(session.pid, options)
  const liveness = getLiveness()
  if (liveness !== 'alive') return result(liveness)

  const readCommand = options?.getProcessCommand ?? getProcessCommand
  let command: string | null
  try {
    command = readCommand(session.pid)
  } catch {
    const latestLiveness = getLiveness()
    return result(
      latestLiveness === 'alive' ? 'unreadable' : latestLiveness,
    )
  }
  const latestLiveness = getLiveness()
  if (latestLiveness !== 'alive') return result(latestLiveness)
  if (command == null || command.trim() === '') {
    return result('unreadable')
  }
  if (session.processMarker !== undefined) {
    return result(
      markedCommandLineIdentity(command, session, session.processMarker),
    )
  }
  return result(
    commandLineMatchesBackgroundSession(command, session)
      ? 'matches'
      : 'mismatch',
  )
}

/**
 * Async form of {@link verifyBackgroundSessionProcessIdentity} for repeated
 * polling: the process-command lookup runs through the abortable async
 * wrapper instead of the synchronous `ps`/PowerShell call, so a slow lookup
 * cannot block signal handling. Liveness itself stays a synchronous
 * `kill(pid, 0)` probe, and the command-line matching rules are identical.
 * Injected lookups come only through `getProcessCommandAsync`: the
 * synchronous `getProcessCommand` override is excluded from the async
 * options, so a caller cannot supply an override this verifier would
 * silently ignore in favour of the real process.
 */
export async function verifyBackgroundSessionProcessIdentityAsync(
  session: BackgroundSession,
  options?: BackgroundSessionProcessIdentityAsyncOptions,
): Promise<BackgroundSessionProcessIdentity> {
  const result = (
    state: BackgroundSessionProcessIdentity['state'],
  ): BackgroundSessionProcessIdentity => ({
    state,
    backgroundSessionId: session.id,
    pid: session.pid,
  })
  const getLiveness = () =>
    getBackgroundSessionProcessLiveness(session.pid, options)
  const liveness = getLiveness()
  if (liveness !== 'alive') return result(liveness)

  const readCommand =
    options?.getProcessCommandAsync ?? getProcessCommandAsync
  let command: string | null
  try {
    command = await readCommand(session.pid, { signal: options?.signal })
  } catch {
    const latestLiveness = getLiveness()
    return result(latestLiveness === 'alive' ? 'unreadable' : latestLiveness)
  }
  const latestLiveness = getLiveness()
  if (latestLiveness !== 'alive') return result(latestLiveness)
  if (command == null || command.trim() === '') {
    return result('unreadable')
  }
  if (session.processMarker !== undefined) {
    return result(
      markedCommandLineIdentity(command, session, session.processMarker),
    )
  }
  return result(
    commandLineMatchesBackgroundSession(command, session)
      ? 'matches'
      : 'mismatch',
  )
}

export function getBackgroundSessionProcessLiveness(
  pid: number,
  options?: BackgroundSessionProcessIdentityOptions,
): BackgroundSessionProcessLiveness {
  if (options?.isProcessAlive) {
    try {
      return options.isProcessAlive(pid) ? 'alive' : 'not-running'
    } catch {
      return 'unreadable'
    }
  }
  if (pid <= 1) return 'not-running'

  const signalProcess = options?.signalProcess ?? process.kill
  try {
    signalProcess(pid, 0)
    return 'alive'
  } catch (error) {
    return isErrno(error, 'ESRCH') ? 'not-running' : 'unreadable'
  }
}

export function isBackgroundSessionProcessAlive(
  session: BackgroundSession,
  options?: BackgroundSessionProcessIdentityOptions,
): boolean {
  return (
    verifyBackgroundSessionProcessIdentity(session, options).state === 'matches'
  )
}

function naturalTerminalFact(
  id: string,
  pid: number,
  generation: string | undefined,
  termination: BackgroundSessionNaturalTermination,
  now: Date | undefined,
): BackgroundSessionTerminalFact {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error('Invalid background session owner PID')
  }
  const finishedAt = iso(now)
  if (termination.signal !== undefined) {
    if (!isSafeSignal(termination.signal)) {
      throw new Error('Invalid background session termination signal')
    }
    return {
      version: 1,
      id,
      pid,
      ...(generation ? { generation } : {}),
      status: 'failed',
      finishedAt,
      terminalReason: 'signal',
      signal: termination.signal,
    }
  }
  if (!isSafeExitCode(termination.exitCode)) {
    throw new Error('Invalid background session exit code')
  }
  return {
    version: 1,
    id,
    pid,
    ...(generation ? { generation } : {}),
    status: termination.exitCode === 0 ? 'exited' : 'failed',
    finishedAt,
    terminalReason: 'exit_code',
    exitCode: termination.exitCode,
  }
}

function assertNaturalFinalizationOwner(
  session: BackgroundSession | null,
  id: string,
  ownerPid: number,
  expectedSession?: BackgroundSession,
): asserts session is BackgroundSession {
  if (
    !session ||
    session.id !== id ||
    session.pid !== ownerPid ||
    (expectedSession !== undefined &&
      !isSameBackgroundSessionGeneration(session, expectedSession))
  ) {
    throw new Error('Background session finalizer does not own this session')
  }
}

type BackgroundSessionNaturalFinalizationOptions = {
  ownerPid?: number
  now?: Date
  expectedSession?: BackgroundSession
}

export async function recordBackgroundSessionNaturalTermination(
  id: string,
  termination: BackgroundSessionNaturalTermination,
  options: BackgroundSessionNaturalFinalizationOptions = {},
): Promise<BackgroundSession> {
  assertSafeId(id)
  const ownerPid = options.ownerPid ?? process.pid
  return await withBackgroundSessionIdLock(id, async () => {
    const session = await readSessionFile(metadataPathForId(id))
    assertNaturalFinalizationOwner(
      session,
      id,
      ownerPid,
      options.expectedSession,
    )

    const effective = await applyAuthoritativeTerminalFacts(session)
    if (
      effective.status === 'killed' ||
      session.status === 'exited' ||
      session.status === 'failed'
    ) {
      return effective
    }
    if (
      session.status !== 'running' &&
      session.status !== 'unknown' &&
      session.status !== 'stale'
    ) {
      // Retain an exhaustive guard so future status additions require a deliberate
      // natural-finalization policy.
      throw new Error(
        'Background session is not eligible for natural finalization',
      )
    }

    await installTerminalFact(
      naturalTerminalFact(
        id,
        ownerPid,
        session.terminalFactGeneration,
        termination,
        options.now,
      ),
      'natural',
    )
    if (session.name) await releaseNameReservation(session.name, session.id)
    return await applyAuthoritativeTerminalFacts(session)
  })
}

export function recordBackgroundSessionNaturalTerminationSync(
  id: string,
  termination: BackgroundSessionNaturalTermination,
  options: BackgroundSessionNaturalFinalizationOptions = {},
): void {
  assertSafeId(id)
  const ownerPid = options.ownerPid ?? process.pid
  try {
    withBackgroundSessionIdLockSync(id, () => {
      const session = readSessionFileSync(metadataPathForId(id))
      assertNaturalFinalizationOwner(
        session,
        id,
        ownerPid,
        options.expectedSession,
      )
      if (
        session.status === 'killed' ||
        session.status === 'exited' ||
        session.status === 'failed' ||
        readTerminalFactSync(
          id,
          'killed',
          session.terminalFactGeneration,
        )?.pid === ownerPid
      ) {
        return
      }
      if (
        session.status !== 'running' &&
        session.status !== 'unknown' &&
        session.status !== 'stale'
      ) {
        // Retain an exhaustive guard so future status additions require a deliberate
        // natural-finalization policy.
        throw new Error(
          'Background session is not eligible for natural finalization',
        )
      }

      installTerminalFactSync(
        naturalTerminalFact(
          id,
          ownerPid,
          session.terminalFactGeneration,
          termination,
          options.now,
        ),
        'natural',
      )
      if (session.name) releaseNameReservationSync(session.name, session.id)
    })
  } catch (error) {
    const expectedSession = options.expectedSession
    const generation = expectedSession?.terminalFactGeneration
    const hasSafeCompatibilityHandoff =
      generation !== undefined || expectedSession?.processMarker !== undefined
    if (
      !isErrno(error, 'ELOCKED') ||
      !expectedSession ||
      !hasSafeCompatibilityHandoff
    ) {
      throw error
    }
    // The exit event cannot wait for another process's metadata lock. A marked
    // session can still leave an immutable fact without touching metadata or a
    // name reservation. Marker-only metadata predates generation-scoped fact
    // paths, but new marked replacements never read its legacy path and a
    // markerless replacement cannot reuse the ID while that fact remains.
    assertNaturalFinalizationOwner(
      expectedSession,
      id,
      ownerPid,
      expectedSession,
    )
    if (
      expectedSession.status === 'killed' ||
      expectedSession.status === 'exited' ||
      expectedSession.status === 'failed' ||
      readTerminalFactSync(
        id,
        'killed',
        generation,
      )?.pid === ownerPid
    ) {
      return
    }
    installTerminalFactSync(
      naturalTerminalFact(
        id,
        ownerPid,
        generation,
        termination,
        options.now,
      ),
      'natural',
    )
  }
}

export async function markBackgroundSessionKilled(
  target: string,
  options?: {
    now?: Date
    _beforeMarkWriteForTesting?: (session: BackgroundSession) => Promise<void>
  },
): Promise<BackgroundSession> {
  const session = await resolveBackgroundSession(target)
  await options?._beforeMarkWriteForTesting?.(session)
  return await withBackgroundSessionIdLock(session.id, async () => {
    const rawSession = await readSessionFile(metadataPathForId(session.id))
    if (
      !rawSession ||
      !isSameBackgroundSessionGeneration(rawSession, session)
    ) {
      throw new Error(
        'Background session changed before it could be marked killed',
      )
    }
    await installTerminalFact(
      {
        version: 1,
        id: rawSession.id,
        pid: rawSession.pid,
        ...(rawSession.terminalFactGeneration
          ? { generation: rawSession.terminalFactGeneration }
          : {}),
        status: 'killed',
        finishedAt: iso(options?.now),
        terminalReason: 'explicit_kill',
      },
      'killed',
    )
    if (rawSession.name) {
      await releaseNameReservation(rawSession.name, rawSession.id)
    }
    return await applyAuthoritativeTerminalFacts(rawSession)
  })
}

export async function backgroundSessionLogExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export function isTerminalBackgroundSession(
  session: BackgroundSession,
): boolean {
  return TERMINAL_STATUSES.has(session.status)
}
