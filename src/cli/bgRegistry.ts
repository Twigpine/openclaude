import {
  link,
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
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
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
// Temp files written by writeNewSession/replaceSessionFile are named
// `<id>.<pid>.<uuid>.tmp`; the id is everything before the numeric pid
// and the random UUID suffix, and the pid is the publishing process.
const SESSION_TEMP_FILE_RE =
  /^(.*)\.(\d+)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/

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

// Whether link() failed because the filesystem rejects hard links: the
// no-hard-link publication fallback applies. Any other link() failure
// (EEXIST, ENOENT, EACCES, ...) is a real outcome, not a capability
// signal (CodeRabbit #2497). Node on Linux surfaces a refused link() as
// ENOTSUP as well as EOPNOTSUPP, so both enter the fallback (maintainer
// review 5948202472 on #2497).
function isHardLinkUnsupported(error: unknown): boolean {
  return (
    isErrno(error, 'EPERM') ||
    isErrno(error, 'ENOSYS') ||
    isErrno(error, 'EOPNOTSUPP') ||
    isErrno(error, 'ENOTSUP')
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
    // directory and commit it into place, so a concurrent name/prefix
    // scan in resolveBackgroundSessionForWait never reads a
    // partially-written metadata document as malformed (CodeRabbit
    // #2497). The commit is link(), which fails with EEXIST when the
    // target is already published: the lstat pre-check below is not
    // enough on its own, because the per-ID lock can be stolen after a
    // wall-clock jump, and a second create whose check ran before the
    // first commit would otherwise rename over the first publisher's
    // metadata (maintainer review 5942761094 on #2497). On filesystems
    // that reject hard links the commit falls back to a claim-serialized
    // rename, so the second publisher still reports the duplicate
    // instead of overwriting the first publisher's row (CodeRabbit
    // #2497 review 5945720742). Temp files end in .tmp so the scan
    // skips them.
    const target = metadataPathForId(session.id)
    const tmp = join(
      getBackgroundSessionMetadataDir(),
      `${session.id}.${process.pid}.${randomUUID()}.tmp`,
    )
    // Sync the completed temp file to storage before committing it into
    // place, matching installTerminalFact: without a sync, a crash or
    // power loss after the commit can leave a zero-length or partial
    // session metadata file on filesystems with delayed allocation
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
        const committed = await commitPublishFile(tmp, target)
        if (committed !== 'committed') {
          throw new Error(
            `Background session id "${session.id}" already exists`,
          )
        }
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
// Bound for the no-hard-link commit-claim wait below: a claim holder's
// critical section (recheck + rename) takes microseconds, so a waiter
// only polls this long when the holder is suspended; the claim goes
// stale after COMMIT_PUBLISH_CLAIM_STALE_MS and is reclaimed first.
// 3000 polls at 10 ms is about 30 s.
const COMMIT_PUBLISH_CLAIM_MAX_POLLS = 3000
// A commit claim older than this belongs to a dead or suspended
// holder: the waiter reclaims it. Matches proper-lockfile's 10 s stale
// threshold used by the per-ID locks in this file.
const COMMIT_PUBLISH_CLAIM_STALE_MS = 10_000

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

// Whether the claim file still names this installer's temp file: the
// claim is withdrawn when the file is gone or names another tmp. A
// publisher checks this immediately before committing, so a delayed
// owner whose claim was withdrawn cannot rename over a fact another
// installer published in the meantime (maintainer review 5896325929
// on #2497).
async function ownsTerminalFactClaim(
  target: string,
  tmp: string,
): Promise<boolean> {
  const claimed = await readFile(terminalFactClaimFile(target), 'utf8').catch(
    () => undefined,
  )
  return claimed?.trim() === tmp
}

function ownsTerminalFactClaimSync(target: string, tmp: string): boolean {
  let claimed: string | undefined
  try {
    claimed = readFileSync(terminalFactClaimFile(target), 'utf8')
  } catch {
    return false
  }
  return claimed?.trim() === tmp
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
  if (!(await ownsTerminalFactClaim(target, tmp))) return
  await removeTerminalFactClaim(target)
}

function removeOwnTerminalFactClaimSync(
  target: string,
  tmp: string,
): void {
  if (!ownsTerminalFactClaimSync(target, tmp)) return
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

// Test-only hook invoked by publishTerminalFact after it has checked the
// target and before it claims the publish, so a test can let a second
// installer publish while the first is between the check and the claim
// (CodeRabbit #2497). Never set outside tests.
let terminalFactPublishClaimHookForTesting: (() => Promise<void>) | undefined

export function _setTerminalFactPublishClaimHookForTesting(
  hook: (() => Promise<void>) | undefined,
): void {
  terminalFactPublishClaimHookForTesting = hook
}

// Test-only hook invoked by commitPublishFile after it has claimed a
// no-hard-link publish and rechecked the target, and before it renames
// the temp file into place, so a test can pause one publisher while a
// second publisher reclaims its stale claim and publishes (maintainer
// review 5948202472 on #2497). Never set outside tests.
let commitPublishHookForTesting: (() => Promise<void>) | undefined

export function _setCommitPublishHookForTesting(
  hook: (() => Promise<void>) | undefined,
): void {
  commitPublishHookForTesting = hook
}

// Synchronous counterpart of the hook above, for commitPublishFileSync.
// Never set outside tests.
let commitPublishHookForTestingSync: (() => void) | undefined

export function _setCommitPublishHookForTestingSync(
  hook: (() => void) | undefined,
): void {
  commitPublishHookForTestingSync = hook
}

async function waitForTerminalFact(
  id: string,
  kind: 'natural' | 'killed',
  generation?: string,
): Promise<BackgroundSessionTerminalFact | null> {
  const deadline = performance.now() + TERMINAL_FACT_PUBLISH_WAIT_MS
  for (;;) {
    const existing = await readTerminalFact(id, kind, generation)
    if (existing) return existing
    if (performance.now() >= deadline) return null
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
  const deadline = performance.now() + TERMINAL_FACT_PUBLISH_WAIT_MS
  for (;;) {
    const existing = readTerminalFactSync(id, kind, generation)
    if (existing) return existing
    if (performance.now() >= deadline) return null
    sleepSync(10)
  }
}

async function readTerminalFactClaim(
  target: string,
): Promise<string | undefined> {
  const claimFile = terminalFactClaimFile(target)
  const deadline = performance.now() + TERMINAL_FACT_PUBLISH_WAIT_MS
  for (;;) {
    let claimed: string | undefined
    try {
      claimed = (await readFile(claimFile, 'utf8')).trim()
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) return undefined
      claimed = undefined
    }
    if (claimed !== undefined) {
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
      // A non-empty claim that names an invalid path is corrupt: no
      // publisher will fix it, so stop polling. An empty claim means
      // the winner opened the claim file but has not finished writing
      // its pointer yet — keep polling until the deadline, so a live
      // publisher is not treated as dead while its write is in flight
      // (maintainer review 5896325929 on #2497).
      if (claimed) return undefined
    }
    if (performance.now() >= deadline) return undefined
    await new Promise(resolve => setTimeout(resolve, 10))
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
  const deadline = performance.now() + TERMINAL_FACT_PUBLISH_WAIT_MS
  for (;;) {
    let claimed: string | undefined
    try {
      claimed = readFileSync(claimFile, 'utf8').trim()
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) return undefined
      claimed = undefined
    }
    if (claimed !== undefined) {
      const terminalDir = getBackgroundSessionTerminalDir()
      if (
        claimed &&
        join(terminalDir, basename(claimed)) === claimed &&
        SESSION_TEMP_FILE_RE.test(basename(claimed))
      ) {
        return claimed
      }
      // Same empty-claim rule as readTerminalFactClaim: a non-empty
      // invalid claim is corrupt, but an empty claim is a pointer
      // write still in flight, so keep polling until the deadline.
      if (claimed) return undefined
    }
    if (performance.now() >= deadline) return undefined
    sleepSync(10)
  }
}

// Whether the temp file a claim names no longer exists: the winner died
// (or its publish failed) after writing the claim, and its temp was
// unlinked. Any error other than ENOENT is treated as "still there",
// so the commit surfaces the real failure instead of reclaiming a live
// publisher's claim.
async function isTerminalFactClaimTempGone(tmp: string): Promise<boolean> {
  try {
    await lstat(tmp)
    return false
  } catch (error) {
    return isErrno(error, 'ENOENT')
  }
}

function isTerminalFactClaimTempGoneSync(tmp: string): boolean {
  try {
    lstatSync(tmp)
    return false
  } catch (error) {
    return isErrno(error, 'ENOENT')
  }
}

type PublishCommitOutcome = 'committed' | 'exists' | 'gone'

/**
 * Commits a synced temp file as a published fact or session row, and
 * reports which fact actually ended up at the target.
 *
 * link() is the atomic commit: it fails with EEXIST when the target is
 * already published, so a delayed owner whose claim was withdrawn can
 * never replace a fact another installer published (maintainer review
 * 5942761094 on #2497) — the rename() pre-checks alone leave a window
 * between the check and the rename, which a successor's publish can
 * land in. A missing temp file means another installer adopted this
 * publish, so the caller waits for the fact at the target instead.
 *
 * On filesystems that reject hard links, link() fails with
 * EPERM/ENOSYS/EOPNOTSUPP and the commit falls back to a
 * claim-serialized rename: mkdir() on `<target>.commit` is atomic, so
 * exactly one publisher wins the claim, rechecks the target under it,
 * and renames, while a loser that finds the claim waits for the target
 * to appear and reports it. A plain rename() cannot replace link()
 * here — it overwrites an existing target, so two publishers that both
 * reach the fallback publish in turn and the second one's readback
 * matches its own bytes, letting both creates succeed instead of
 * rejecting the duplicate (CodeRabbit #2497 review 5945720742). The
 * target still only ever appears complete, via rename, and a stale
 * claim is reclaimed by the waiter. A holder that stalls past the
 * stale threshold can lose its claim that way, so the holder records
 * the claim directory's (dev, ino) identity when it wins the claim
 * and re-verifies it immediately before the rename: a superseded
 * holder reports the successor's publish instead of overwriting it,
 * and the claim directory is only removed while it is still the
 * holder's own (maintainer review 5948202472 on #2497).
 */
async function commitPublishFile(
  tmp: string,
  target: string,
): Promise<PublishCommitOutcome> {
  try {
    await link(tmp, target)
    return 'committed'
  } catch (error) {
    if (isErrno(error, 'EEXIST')) return 'exists'
    if (isErrno(error, 'ENOENT')) return 'gone'
    if (!isHardLinkUnsupported(error)) throw error
  }
  const claimDir = commitPublishClaimDir(target)
  for (let attempt = 0; attempt < COMMIT_PUBLISH_CLAIM_MAX_POLLS; attempt++) {
    let claimIdentity: CleanupFileIdentity | undefined
    try {
      await mkdir(claimDir)
      claimIdentity = await readCommitPublishClaimIdentity(claimDir)
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error
    }
    if (claimIdentity === undefined) {
      // Another publisher holds the claim: its rename lands within
      // microseconds, so the target appears — report it instead of
      // racing it.
      try {
        await lstat(target)
        return 'exists'
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error
      }
      if (await isCommitPublishClaimStale(claimDir)) {
        await rmdir(claimDir).catch(() => {})
        continue
      }
      await new Promise(resolve => setTimeout(resolve, 10))
      continue
    }
    // We hold the claim: recheck the target, then verify we still own
    // the claim immediately before the rename. A holder stalled past
    // the stale threshold can lose its claim to a successor, which
    // publishes first; without the ownership check the resumed rename
    // would overwrite the successor's publish and still report success
    // (maintainer review 5948202472 on #2497). Keep the ownership
    // check as the last verification before the rename: a target
    // recheck after it would reopen the same window for a holder
    // stalled past the stale threshold (CodeRabbit #2497 review
    // 5950772048).
    try {
      try {
        await lstat(target)
        return 'exists'
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error
      }
      await commitPublishHookForTesting?.()
      if (!(await ownsCommitPublishClaim(claimDir, claimIdentity))) {
        try {
          await lstat(target)
          return 'exists'
        } catch (error) {
          if (!isErrno(error, 'ENOENT')) throw error
        }
        // The claim is gone but nothing was published (the successor's
        // commit failed): re-enter the claim loop instead of reporting
        // a fact that does not exist.
        continue
      }
      try {
        await rename(tmp, target)
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error
        return 'gone'
      }
      return 'committed'
    } finally {
      await removeOwnCommitPublishClaim(claimDir, claimIdentity)
    }
  }
  throw new Error(`Timed out waiting for a concurrent publish to ${target}`)
}

function commitPublishFileSync(
  tmp: string,
  target: string,
): PublishCommitOutcome {
  try {
    linkSync(tmp, target)
    return 'committed'
  } catch (error) {
    if (isErrno(error, 'EEXIST')) return 'exists'
    if (isErrno(error, 'ENOENT')) return 'gone'
    if (!isHardLinkUnsupported(error)) throw error
  }
  const claimDir = commitPublishClaimDir(target)
  for (let attempt = 0; attempt < COMMIT_PUBLISH_CLAIM_MAX_POLLS; attempt++) {
    let claimIdentity: CleanupFileIdentity | undefined
    try {
      mkdirSync(claimDir)
      claimIdentity = readCommitPublishClaimIdentitySync(claimDir)
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error
    }
    if (claimIdentity === undefined) {
      try {
        lstatSync(target)
        return 'exists'
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error
      }
      if (isCommitPublishClaimStaleSync(claimDir)) {
        try {
          rmdirSync(claimDir)
        } catch {}
        continue
      }
      sleepSync(10)
      continue
    }
    // We hold the claim: recheck the target, then verify we still own
    // the claim immediately before the rename (see commitPublishFile).
    // Keep the ownership check last here too: a target recheck after
    // it would reopen the same stalled-holder window.
    try {
      try {
        lstatSync(target)
        return 'exists'
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error
      }
      commitPublishHookForTestingSync?.()
      if (!ownsCommitPublishClaimSync(claimDir, claimIdentity)) {
        try {
          lstatSync(target)
          return 'exists'
        } catch (error) {
          if (!isErrno(error, 'ENOENT')) throw error
        }
        // The claim is gone but nothing was published: re-enter the
        // claim loop instead of reporting a fact that does not exist.
        continue
      }
      try {
        renameSync(tmp, target)
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error
        return 'gone'
      }
      return 'committed'
    } finally {
      removeOwnCommitPublishClaimSync(claimDir, claimIdentity)
    }
  }
  throw new Error(`Timed out waiting for a concurrent publish to ${target}`)
}

// The publish claim for one commit target: a directory, so creating it
// with mkdir() is atomic and works on filesystems without hard-link
// support — the same idiom as the terminal-fact claim directories
// above. It serializes the recheck-and-rename in the no-hard-link
// fallback only; the link() path never creates one.
function commitPublishClaimDir(target: string): string {
  return `${target}.commit`
}

// The identity of a commit claim directory, recorded when the claim is
// won: a stale-reclaiming successor removes this directory and creates
// a new one, so the (dev, ino) pair no longer matches and a delayed
// holder can tell its claim was superseded. The pair is the same
// identity idiom as CleanupFileIdentity above.
async function readCommitPublishClaimIdentity(
  claimDir: string,
): Promise<CleanupFileIdentity | undefined> {
  try {
    const stats = await lstat(claimDir)
    return { dev: stats.dev, ino: stats.ino }
  } catch {
    return undefined
  }
}

function readCommitPublishClaimIdentitySync(
  claimDir: string,
): CleanupFileIdentity | undefined {
  try {
    const stats = lstatSync(claimDir)
    return { dev: stats.dev, ino: stats.ino }
  } catch {
    return undefined
  }
}

// Whether the claim directory is still the one this publisher won: a
// successor that reclaimed a stale claim removed it and created a new
// directory, so the identity differs (or the directory is gone).
async function ownsCommitPublishClaim(
  claimDir: string,
  identity: CleanupFileIdentity,
): Promise<boolean> {
  const current = await readCommitPublishClaimIdentity(claimDir)
  return (
    current !== undefined &&
    current.dev === identity.dev &&
    current.ino === identity.ino
  )
}

function ownsCommitPublishClaimSync(
  claimDir: string,
  identity: CleanupFileIdentity,
): boolean {
  const current = readCommitPublishClaimIdentitySync(claimDir)
  return (
    current !== undefined &&
    current.dev === identity.dev &&
    current.ino === identity.ino
  )
}

// Removes a commit claim only while it is still ours: an unguarded
// rmdir() in the commit finally could delete a successor's active
// claim directory after our claim was stale-reclaimed, letting a third
// publisher claim while the successor is mid-publish.
async function removeOwnCommitPublishClaim(
  claimDir: string,
  identity: CleanupFileIdentity,
): Promise<void> {
  if (!(await ownsCommitPublishClaim(claimDir, identity))) return
  await rmdir(claimDir).catch(() => {})
}

function removeOwnCommitPublishClaimSync(
  claimDir: string,
  identity: CleanupFileIdentity,
): void {
  if (!ownsCommitPublishClaimSync(claimDir, identity)) return
  try {
    rmdirSync(claimDir)
  } catch {}
}

// Whether a commit claim belongs to a dead or suspended holder: its
// mtime is older than the stale threshold. A live holder's critical
// section (recheck + rename) takes microseconds, so a fresh claim
// means the holder is about to publish.
async function isCommitPublishClaimStale(claimDir: string): Promise<boolean> {
  try {
    const stats = await lstat(claimDir)
    return Date.now() - stats.mtimeMs > COMMIT_PUBLISH_CLAIM_STALE_MS
  } catch {
    // The claim disappeared: not stale, the waiter just retries.
    return false
  }
}

function isCommitPublishClaimStaleSync(claimDir: string): boolean {
  try {
    const stats = lstatSync(claimDir)
    return Date.now() - stats.mtimeMs > COMMIT_PUBLISH_CLAIM_STALE_MS
  } catch {
    return false
  }
}

/**
 * Publishes one terminal fact with atomic no-overwrite semantics. The
 * target only ever appears complete, via link() (or rename() on
 * filesystems that reject hard links) of a synced temp file, so a
 * concurrent `wait` never reads a partially-written fact as malformed;
 * and the first publisher wins: an installer claims the target by
 * creating `<target>.claim` (mkdir is atomic) and recording its temp
 * path in `<target>.claim/tmp`, so a second installer that finds the
 * claim — including the synchronous ELOCKED exit fallback, which
 * publishes without the per-ID lock — completes the winner's publish
 * instead of racing it. A loser whose winner died after claiming removes
 * the stale claim and retries. A claim whose pointer write is still in
 * flight reads as empty, so an adopter polls for it instead of removing
 * it; and the commit itself is atomic (link() EEXIST, with a
 * claim-serialized rename() fallback where hard links fail), so a delayed owner whose claim was
 * withdrawn never replaces a fact another installer published
 * (maintainer review 5896325929 and 5942761094 on #2497). This keeps
 * the old link() EEXIST duplicate semantics where hard links work, and
 * keeps publication working without them where they fail (maintainer
 * review 5830922741 on #2497).
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
    // Test-only pause point between the target check and the claim, so a
    // test can publish from a second installer inside that gap
    // (CodeRabbit #2497).
    await terminalFactPublishClaimHookForTesting?.()
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
    // Recheck the target now that this installer holds the claim: a
    // publisher may have completed and removed its claim after the
    // lstat above. Drop this installer's own fresh claim directory, but
    // only the directory: the claim file has not been written yet, so a
    // claim file present here belongs to another publisher that claimed
    // into this directory meanwhile, and rmdir refuses a non-empty
    // directory, so that claim survives (maintainer review 5942761094
    // on #2497).
    try {
      await lstat(target)
      await rmdir(claimDir).catch(() => {})
      const existing = await readTerminalFact(fact.id, kind, fact.generation)
      if (!existing) {
        throw new Error(`Invalid background session ${kind} terminal fact`)
      }
      return existing
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error
    }
    try {
      await writeFile(claimFile, tmp, { flag: 'wx' })
    } catch (error) {
      if (isErrno(error, 'ENOENT')) continue
      // Another publisher claimed first and wrote its pointer while this
      // installer was stalled: retry the publish instead of failing —
      // the loop rechecks the target and adopts that publish.
      if (isErrno(error, 'EEXIST')) continue
      throw error
    }
    await terminalFactPublishHookForTesting?.()
    // Commit only while this installer still owns the claim and the
    // target is still unpublished: the claim may have been withdrawn
    // while this installer was stalled — e.g. between opening the
    // claim file and finishing its pointer write — and a successor may
    // have adopted the publish or published its own fact in the
    // meantime. Committing over that fact would replace the
    // first-published fact, so return it instead (or retry the publish
    // if nothing was published yet). The commit itself is atomic
    // (link() EEXIST), so no publisher can land between this recheck
    // and the commit.
    let targetPublished = false
    try {
      await lstat(target)
      targetPublished = true
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error
    }
    if (targetPublished) {
      const existing = await readTerminalFact(fact.id, kind, fact.generation)
      if (!existing) {
        throw new Error(`Invalid background session ${kind} terminal fact`)
      }
      return existing
    }
    if (!(await ownsTerminalFactClaim(target, tmp))) continue
    const committed = await commitPublishFile(tmp, target)
    if (committed === 'gone') {
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
    if (committed === 'exists') {
      // Another installer published first; the fact at the target wins.
      const existing = await readTerminalFact(fact.id, kind, fact.generation)
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
  // committing its tmp to the target. Its tmp is complete — the claim
  // file is written only after the tmp is synced — so the target only
  // ever appears complete, and the first publisher still wins. The
  // commit is atomic (link() EEXIST), so a publisher that committed
  // after this adopter read the claim is not overwritten.
  const claimedTmp = await readTerminalFactClaim(target)
  if (claimedTmp === undefined) {
    // No claim file: the winner died between mkdir and the claim-file
    // write, or stalled there. Remove the stale claim so the next
    // attempt can claim the publish.
    await removeTerminalFactClaim(target)
    return null
  }
  // Abandoned winner: the claim names a temp that no longer exists
  // and the target is still unpublished — the winner died (or its
  // publish failed) after writing the claim, and its temp was
  // unlinked. Committing the missing temp would return 'gone' and the
  // caller would retry against the same dead pointer until the
  // attempts run out, leaving the session `running` and `wait` never
  // reaching terminal JSON. Reclaim the claim — removeOwn leaves a
  // successor's active claim alone — so the next attempt can claim
  // the publish itself (maintainer review 5948202472 on #2497).
  if (await isTerminalFactClaimTempGone(claimedTmp)) {
    const adopted = await readTerminalFact(fact.id, kind, fact.generation)
    if (adopted) return adopted
    await removeOwnTerminalFactClaim(target, claimedTmp)
    return null
  }
  const committed = await commitPublishFile(claimedTmp, target)
  if (committed !== 'committed') {
    // The target already holds a fact, or the winner's tmp was adopted
    // by another installer: return the fact at the target if it
    // appeared, else retry the publish.
    return await waitForTerminalFact(fact.id, kind, fact.generation)
  }
  // The winner's tmp is now redundant at the target: unlink it so a
  // stalled winner's delayed cleanup cannot mistake it for a live
  // publish. The winner's own commit sees the target already published
  // and returns the fact instead.
  await unlink(claimedTmp).catch(() => {})
  // This publish is complete, so the winner's claim is stale — remove
  // it only while it still names the adopted tmp, so a newer
  // publisher's claim is left alone (maintainer review 5942761094
  // on #2497).
  await removeOwnTerminalFactClaim(target, claimedTmp)
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
    // Same post-claim recheck as publishTerminalFact: a publisher may
    // have completed and removed its claim after the lstat above.
    // Drop only this installer's own fresh claim directory (see the
    // async path): a claim file present here belongs to another
    // publisher, and rmdir refuses a non-empty directory.
    try {
      lstatSync(target)
      try {
        rmdirSync(claimDir)
      } catch {}
      const existing = readTerminalFactSync(fact.id, kind, fact.generation)
      if (!existing) {
        throw new Error(`Invalid background session ${kind} terminal fact`)
      }
      return existing
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error
    }
    try {
      writeFileSync(claimFile, tmp, { flag: 'wx' })
    } catch (error) {
      if (isErrno(error, 'ENOENT')) continue
      // Same claim-write race as publishTerminalFact: another publisher
      // claimed first, so retry instead of failing.
      if (isErrno(error, 'EEXIST')) continue
      throw error
    }
    // Same pre-commit ownership check as publishTerminalFact: only
    // commit while this installer still owns the claim and the target
    // is still unpublished.
    let targetPublished = false
    try {
      lstatSync(target)
      targetPublished = true
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error
    }
    if (targetPublished) {
      const existing = readTerminalFactSync(fact.id, kind, fact.generation)
      if (!existing) {
        throw new Error(`Invalid background session ${kind} terminal fact`)
      }
      return existing
    }
    if (!ownsTerminalFactClaimSync(target, tmp)) continue
    const committed = commitPublishFileSync(tmp, target)
    if (committed === 'gone') {
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
    if (committed === 'exists') {
      // Another installer published first; the fact at the target wins.
      const existing = readTerminalFactSync(fact.id, kind, fact.generation)
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
  // Abandoned winner, same as adoptTerminalFactPublish: a valid claim
  // naming a temp that no longer exists must be reclaimed so the next
  // attempt can claim the publish instead of retrying against the
  // same dead pointer (maintainer review 5948202472 on #2497).
  if (isTerminalFactClaimTempGoneSync(claimedTmp)) {
    const adopted = readTerminalFactSync(fact.id, kind, fact.generation)
    if (adopted) return adopted
    removeOwnTerminalFactClaimSync(target, claimedTmp)
    return null
  }
  const committed = commitPublishFileSync(claimedTmp, target)
  if (committed !== 'committed') {
    return waitForTerminalFactSync(fact.id, kind, fact.generation)
  }
  // Same post-adoption cleanup as adoptTerminalFactPublish: the
  // winner's tmp is redundant at the target, and the claim is removed
  // only while it still names the adopted tmp.
  try {
    unlinkSync(claimedTmp)
  } catch {}
  removeOwnTerminalFactClaimSync(target, claimedTmp)
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
  | { state: 'valid'; value: BackgroundSession; identity: FileIdentity }
  | { state: 'unreadable' }
  | { state: 'malformed' }
  | { state: 'id_mismatch'; value: BackgroundSession; identity: FileIdentity }

/** The (device, inode) identity of an opened registry file, used to tell
 * whether two spellings of a path opened the same file. Kept as bigint:
 * Node on Windows can expose 64-bit file IDs, and two distinct IDs above
 * 2^53 round to the same JavaScript number — a collision that could drop
 * a distinct candidate row or accept two separate files as one alias
 * (CodeRabbit #2497 review 5957376769). The string key built from these
 * values stays exact because bigint template interpolation never rounds. */
type FileIdentity = { dev: bigint; ino: bigint }

function sameFileIdentity(first: FileIdentity, second: FileIdentity): boolean {
  return first.dev === second.dev && first.ino === second.ino
}

/**
 * Reads a `wait`-path registry file without ever blocking on a
 * non-regular file. `open()` on a FIFO blocks until a writer appears, so
 * a plain `readFile` on a FIFO at a metadata or terminal-fact path stalls
 * the waiter forever; under Node the timeout exit then cannot run either,
 * because `process.exit()` waits for the blocked libuv threadpool worker
 * (CodeRabbit #2497). Open with O_NONBLOCK so the open itself cannot
 * block, then stat the opened handle — the type check applies to the file
 * actually read, so a swap between the check and the open cannot retarget
 * it — and refuse anything that is not a regular file. A non-regular file
 * reports as unreadable metadata, the same outcome a directory already
 * produced via EISDIR. The same guard covers the 130/143 signal path,
 * which reads through these same strict readers.
 */
async function readWaitRegistryFile(
  path: string,
): Promise<
  | { state: 'missing' }
  | { state: 'unreadable' }
  | { state: 'ok'; content: string; identity: FileIdentity }
> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK,
    )
  } catch (error) {
    // A path that cannot exist is missing, not unreadable: a valid long
    // session name exceeds the 255-byte filename limit, so the
    // speculative exact-ID metadata path fails with ENAMETOOLONG before
    // the name/prefix scan can find the session (maintainer review
    // 5942761094 on #2497). True unreadable errors for paths that can
    // exist are unchanged.
    return isErrno(error, 'ENOENT') || isErrno(error, 'ENAMETOOLONG')
      ? { state: 'missing' }
      : { state: 'unreadable' }
  }
  try {
    const fileStat = await handle.stat({ bigint: true })
    if (!fileStat.isFile()) return { state: 'unreadable' }
    return {
      state: 'ok',
      content: await handle.readFile('utf8'),
      identity: { dev: fileStat.dev, ino: fileStat.ino },
    }
  } catch {
    return { state: 'unreadable' }
  } finally {
    await handle.close().catch(() => {})
  }
}

async function readSessionFileStrict(
  path: string,
  id: string,
): Promise<StrictSessionRead> {
  const read = await readWaitRegistryFile(path)
  if (read.state === 'missing') return { state: 'missing' }
  if (read.state === 'unreadable') return { state: 'unreadable' }
  let parsed: unknown
  try {
    parsed = jsonParse(read.content)
  } catch {
    return { state: 'malformed' }
  }
  if (isBackgroundSession(parsed, id)) {
    return { state: 'valid', value: parsed, identity: read.identity }
  }
  // A structurally valid session whose stored id differs from the
  // requested id is not a corrupt document: on a case-insensitive
  // registry the exact-ID path can open another session's file (for
  // example `wait BG-ab` opens `bg-ab.json`). Report it distinctly so
  // the resolver can treat that read as missing instead of failing
  // with a malformed-metadata error, while a file whose stored id
  // matches but fails other validation still reports `malformed`
  // (CodeRabbit #2497 review 5953263672).
  const storedId =
    parsed !== null && typeof parsed === 'object'
      ? (parsed as Partial<BackgroundSession>).id
      : undefined
  if (
    typeof storedId === 'string' &&
    storedId !== id &&
    isBackgroundSession(parsed, storedId)
  ) {
    return { state: 'id_mismatch', value: parsed, identity: read.identity }
  }
  return { state: 'malformed' }
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
  const read = await readWaitRegistryFile(
    terminalFactPathForId(id, kind, generation),
  )
  if (read.state === 'missing') return { state: 'missing' }
  if (read.state === 'unreadable') return { state: 'unreadable' }
  let parsed: unknown
  try {
    parsed = jsonParse(read.content)
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
export type ResolveBackgroundSessionForWaitOptions = {
  isProcessAlive?: (pid: number) => boolean
  signalProcess?: (pid: number, signal: 0) => unknown
  getProcessCommandAsync?: (
    pid: number,
    options: { signal?: AbortSignal },
  ) => Promise<string | null>
  // Cancels the exact-name liveness probes: the waiter's client-or-
  // deadline signal aborts the in-flight probe, and no further probe
  // starts once it has fired (CodeRabbit #2497 review 5950772048).
  signal?: AbortSignal
  // Test-only hooks for the alias identity checks below: invoked when
  // an alias read disagrees with its canonical read (before the retry
  // re-reads) and after an alias is verified (before the candidate is
  // recorded). They let a test place a filesystem change at the exact
  // point the resolver observes it, instead of racing a timer
  // (CodeRabbit #2497 review 5961433156).
  _onAliasIdentityMismatchForTesting?: (attempt: number) => Promise<void>
  _afterAliasVerifiedForTesting?: () => Promise<void>
}

export async function resolveBackgroundSessionForWait(
  target: string,
  options?: ResolveBackgroundSessionForWaitOptions,
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
    // A missing exact-ID file — or one whose stored id differs from
    // the requested id (a case-insensitive registry opening another
    // session's file) — can still allow name or prefix matching.
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
  // One row per file: on a case-insensitive registry the same file can
  // be enumerated under two spellings (bg-other.json and BG-other.json),
  // and the mismatch branch below retains the verified row, so a second
  // spelling of the same file must not add a duplicate candidate — two
  // identical name rows would report an ambiguous name (CodeRabbit #2497
  // review 5956497652).
  const seenCandidateIdentities = new Set<string>()
  // One row per validated stored ID: a verified alias and its canonical
  // entry are the same session, but a metadata update can replace the
  // canonical file between the alias check and the canonical entry's
  // read, so the two rows carry different file identities for one
  // stored ID. Record only the first row — two rows for one id would
  // report an ambiguous name for a single session (CodeRabbit #2497
  // review 5961433156).
  const seenCandidateIds = new Set<string>()
  const addCandidateOnce = (
    session: BackgroundSession,
    identity: FileIdentity,
  ): void => {
    if (seenCandidateIds.has(session.id)) return
    const key = `${identity.dev}:${identity.ino}`
    if (seenCandidateIdentities.has(key)) return
    seenCandidateIdentities.add(key)
    seenCandidateIds.add(session.id)
    candidates.push(session)
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const id = entry.slice(0, -'.json'.length)
    if (!SAFE_ID_RE.test(id)) continue
    const read = await readSessionFileStrict(metadataPathForId(id), id)
    if (read.state === 'missing') continue
    if (read.state === 'id_mismatch') {
      // A stored-id mismatch is an alias only when the stored id names
      // a valid canonical row: on a case-insensitive registry the same
      // file is reachable under both spellings, and the canonical row
      // is enumerated under its real filename. A mismatch with no valid
      // canonical row is a stray document whose stored name or id could
      // match the target, so it fails the lookup instead of being
      // skipped silently — skipping it could pin the wrong session
      // (CodeRabbit #2497 review 5954753623).
      const canonical = await readSessionFileStrict(
        metadataPathForId(read.value.id),
        read.value.id,
      )
      if (canonical.state !== 'valid') {
        throwWaitMetadataError(
          canonical.state === 'unreadable' ? 'unreadable' : 'malformed',
          `Background session ${id} metadata`,
          null,
        )
      }
      // A valid canonical row makes the mismatch an alias only when
      // both reads opened the same file. A row in a different file
      // that claims the canonical id is a stray document, not an
      // alias: skipping it could pin the wrong session, so it fails
      // the lookup instead. When the identities match, the canonical
      // row may be enumerated only under its case variant on a
      // case-insensitive registry, so retain the verified row once
      // instead of discarding it — discarding it would let an
      // unrelated prefix match win over a live named session
      // (CodeRabbit #2497 review 5956497652).
      //
      // The two reads can disagree without the row being stray:
      // replaceSessionFile can rename a valid update into place
      // between them, so the alias read returns the old inode and
      // the canonical read the new one. Re-read both paths and retry
      // the comparison while either identity keeps changing; a stable
      // mismatch is still a genuinely different file and fails the
      // lookup. Refreshing only the alias read would compare a fresh
      // alias identity against a stale canonical one, so a second
      // update landing during the retry could still fail a row whose
      // two paths now agree (CodeRabbit #2497 reviews 5957376769 and
      // 5961433156). The retry is bounded so a file replaced on every
      // read cannot spin the resolver.
      const MAX_ALIAS_IDENTITY_RETRIES = 2
      let aliasRead = read
      let canonicalRead = canonical
      let aliasVerified = false
      for (
        let attempt = 0;
        attempt <= MAX_ALIAS_IDENTITY_RETRIES;
        attempt++
      ) {
        if (sameFileIdentity(aliasRead.identity, canonicalRead.identity)) {
          aliasVerified = true
          break
        }
        if (attempt === MAX_ALIAS_IDENTITY_RETRIES) break
        // Test hook (see ResolveBackgroundSessionForWaitOptions): lets
        // a test place the repoint between the mismatch and the retry's
        // re-reads.
        await options?._onAliasIdentityMismatchForTesting?.(attempt)
        const reread = await readSessionFileStrict(
          metadataPathForId(id),
          id,
        )
        if (
          reread.state !== 'id_mismatch' ||
          reread.value.id !== read.value.id
        ) {
          // The enumerated row changed shape while it was being
          // verified (for example it was replaced by a row for
          // another id): fail closed rather than guess which row
          // it is now.
          throwWaitMetadataError(
            reread.state === 'unreadable' ? 'unreadable' : 'malformed',
            `Background session ${id} metadata`,
            null,
          )
        }
        const rereadCanonical = await readSessionFileStrict(
          metadataPathForId(read.value.id),
          read.value.id,
        )
        if (rereadCanonical.state !== 'valid') {
          // The canonical row changed shape while it was being
          // verified: fail closed rather than guess which row it
          // is now.
          throwWaitMetadataError(
            rereadCanonical.state === 'unreadable' ? 'unreadable' : 'malformed',
            `Background session ${id} metadata`,
            null,
          )
        }
        aliasRead = reread
        canonicalRead = rereadCanonical
      }
      if (!aliasVerified) {
        throwWaitMetadataError(
          'malformed',
          `Background session ${id} metadata`,
          null,
        )
      }
      // Test hook (see ResolveBackgroundSessionForWaitOptions): lets a
      // test replace the canonical file after verification and before
      // the scan reads the canonical entry.
      await options?._afterAliasVerifiedForTesting?.()
      addCandidateOnce(aliasRead.value, aliasRead.identity)
      continue
    }
    if (read.state === 'unreadable' || read.state === 'malformed') {
      // The name lives inside the file, so any entry could be the named or
      // prefix-matched session; it cannot be skipped safely.
      throwWaitMetadataError(
        read.state,
        `Background session ${id} metadata`,
        null,
      )
    }
    addCandidateOnce(read.value, read.identity)
  }

  const exactId = candidates.filter(s => s.id === target)
  if (exactId.length === 1) {
    return await readEffectiveSessionStrict(exactId[0], null)
  }

  // Liveness is an effective-status property, so name candidates need their
  // terminal facts applied strictly before the live/terminal split — but
  // only for rows that could still be live. A row whose recorded status
  // is already terminal cannot become live, regardless of its terminal
  // facts, so its facts are read only when selection reaches it: an old
  // exited row with a malformed fact must not block a newer live row
  // with the same name (CodeRabbit #2497 review 5963778469). The
  // deferred rows are strict-read in the terminal-name fallback below,
  // where a malformed fact still reports exit 4 when the row is
  // selected.
  const byName = candidates.filter(s => s.name === target)
  const effectiveByName: BackgroundSession[] = []
  const deferredTerminalByName: BackgroundSession[] = []
  for (const session of byName) {
    if (isTerminalBackgroundSession(session)) {
      deferredTerminalByName.push(session)
    } else {
      effectiveByName.push(await readEffectiveSessionStrict(session, null))
    }
  }
  // A `status: running` row whose child is already gone must not win
  // exact-name resolution over a unique live ID-prefix match: a name
  // candidate counts as live only when read-only inspection says its
  // pinned PID is still alive and its recorded command still matches
  // (maintainer review 5948202472 on #2497). This reuses the async
  // process-identity verifier with the caller's cancellation signal,
  // writes nothing, and never refreshes registry status from `wait`.
  // A cancelled probe stops the scan: further candidates are not probed
  // once the waiter is gone (CodeRabbit #2497 review 5950772048).
  // Terminal candidates are unaffected — they fall through to the
  // terminal-name match below.
  const liveByName: BackgroundSession[] = []
  for (const session of effectiveByName) {
    if (isTerminalBackgroundSession(session)) continue
    if (options?.signal?.aborted) break
    const identity = await verifyBackgroundSessionProcessIdentityAsync(
      session,
      {
        isProcessAlive: options?.isProcessAlive,
        signalProcess: options?.signalProcess,
        getProcessCommandAsync: options?.getProcessCommandAsync,
        signal: options?.signal,
      },
    )
    if (identity.state === 'matches') liveByName.push(session)
  }
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

  // Terminal-name fallback: only now are the deferred terminal rows'
  // facts read, in scan order, so a malformed fact still reports exit 4
  // when its row is the selected one (CodeRabbit #2497 review 5963778469).
  for (const session of deferredTerminalByName) {
    effectiveByName.push(await readEffectiveSessionStrict(session, null))
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

export type BackgroundSessionWaitIdentity = Pick<
  BackgroundSession,
  'id' | 'pid' | 'terminalFactGeneration' | 'processMarker'
>

/**
 * Strict `wait`-only re-read of an already-pinned session. A missing or
 * invalid record or a changed launch identity fails with exit code 4.
 */
export async function readPinnedBackgroundSessionForWait(
  pinned: BackgroundSessionWaitIdentity,
): Promise<BackgroundSession> {
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
  if (
    read.state === 'unreadable' ||
    read.state === 'malformed' ||
    read.state === 'id_mismatch'
  ) {
    // A pinned re-read whose stored id differs is a replaced document,
    // not an absent one: fail with the metadata error, never retarget.
    throwWaitMetadataError(
      read.state === 'id_mismatch' ? 'malformed' : read.state,
      `Background session ${pinned.id} metadata`,
      pinned.id,
    )
  }
  // Generation identifies current launches. Older metadata used the process
  // marker alone, and unmarked legacy sessions still use ID and PID.
  const pinnedGeneration = pinned.terminalFactGeneration
  const pinnedMarker = pinned.processMarker
  if (
    read.value.pid !== pinned.pid ||
    (pinnedGeneration !== undefined
      ? read.value.terminalFactGeneration !== pinnedGeneration
      : pinnedMarker !== undefined && read.value.processMarker !== pinnedMarker)
  ) {
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
      : identity.state === 'unreadable' || identity.state === 'aborted'
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
  state: 'not-running' | 'matches' | 'mismatch' | 'unreadable' | 'aborted'
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
  // A lookup cut short by the caller's abort signal is not an unreadable
  // process: the command was never observed, so callers (notably the wait
  // timeout boundary) must not classify it as unknown state. The real
  // lookup returns null on abort rather than throwing, so the aborted
  // check runs on both the throw and the null paths below.
  const isAborted = () => options?.signal?.aborted === true
  if (isAborted()) return result('aborted')
  let command: string | null
  try {
    command = await readCommand(session.pid, { signal: options?.signal })
  } catch {
    const latestLiveness = getLiveness()
    if (latestLiveness !== 'alive') return result(latestLiveness)
    return result(isAborted() ? 'aborted' : 'unreadable')
  }
  const latestLiveness = getLiveness()
  if (latestLiveness !== 'alive') return result(latestLiveness)
  if (isAborted()) return result('aborted')
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
