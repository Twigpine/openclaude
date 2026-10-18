import { randomBytes } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import {
  lstat,
  open,
  readlink,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
} from 'node:path'
import { getErrnoCode } from './errors.js'

export type AtomicReplaceOptions = {
  mode?: number
  preserveMode?: boolean
  signal?: AbortSignal
  flush?: 'data' | 'full'
  /** Refuse to commit if a caller's existing-file snapshot is stale. */
  expectedTargetSize?: number
}

export type AtomicReplaceFaultStage =
  | 'temp-open'
  | 'stream-write'
  | 'data-flush'
  | 'chmod'
  | 'close'
  | 'rename'
  | 'directory-sync'
  | 'cleanup'

export type AtomicReplaceFaultContext = {
  requestedPath: string
  targetPath: string
  tempPath?: string
}

type AtomicReplaceFaultInjector = (
  stage: AtomicReplaceFaultStage,
  context: AtomicReplaceFaultContext,
) => void | Promise<void>

let faultInjector: AtomicReplaceFaultInjector | undefined
let writeLimitForTesting: number | undefined

/** @internal Test-only deterministic failure injection. */
export function setAtomicReplaceFaultInjectorForTesting(
  injector: AtomicReplaceFaultInjector,
): void {
  faultInjector = injector
}

/** @internal Reset test-only deterministic failure injection. */
export function resetAtomicReplaceFaultInjectorForTesting(): void {
  faultInjector = undefined
}

/** @internal Limit each low-level write for deterministic short-write tests. */
export function setAtomicReplaceWriteLimitForTesting(
  limit: number | undefined,
): void {
  writeLimitForTesting = limit
}

async function injectFault(
  stage: AtomicReplaceFaultStage,
  context: AtomicReplaceFaultContext,
): Promise<void> {
  await faultInjector?.(stage, context)
}

async function resolveWriteTarget(requestedPath: string): Promise<string> {
  let currentPath = resolve(requestedPath)
  const visited = new Set<string>()

  for (let depth = 0; depth < 40; depth++) {
    if (visited.has(currentPath)) {
      throw new Error(
        `Cannot atomically replace circular symlink: ${requestedPath}`,
      )
    }
    visited.add(currentPath)

    let fileStat
    try {
      fileStat = await lstat(currentPath)
    } catch (error) {
      if (getErrnoCode(error) === 'ENOENT') return currentPath
      throw error
    }

    if (!fileStat.isSymbolicLink()) return currentPath

    try {
      return await realpath(currentPath)
    } catch {
      const linkTarget = await readlink(currentPath)
      currentPath = isAbsolute(linkTarget)
        ? linkTarget
        : resolve(dirname(currentPath), linkTarget)
    }
  }

  throw new Error(`Cannot atomically replace symlink chain: ${requestedPath}`)
}

function isAsyncIterable(
  data: unknown,
): data is AsyncIterable<string | Uint8Array> {
  return (
    typeof data === 'object' &&
    data !== null &&
    Symbol.asyncIterator in data &&
    typeof data[Symbol.asyncIterator] === 'function'
  )
}

async function writeChunkFully(
  handle: FileHandle,
  chunk: string | Uint8Array,
  signal: AbortSignal | undefined,
  context: AtomicReplaceFaultContext,
): Promise<void> {
  const buffer =
    typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
  let offset = 0

  while (offset < buffer.length) {
    signal?.throwIfAborted()
    const remaining = buffer.length - offset
    const writeLength =
      writeLimitForTesting === undefined
        ? remaining
        : Math.min(remaining, writeLimitForTesting)
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      writeLength,
      null,
    )
    if (bytesWritten === 0) {
      throw new Error('Atomic replacement made no progress while writing')
    }
    offset += bytesWritten
    await injectFault('stream-write', context)
  }
}

async function writeReplacement(
  handle: FileHandle,
  data: string | Uint8Array | AsyncIterable<string | Uint8Array>,
  signal: AbortSignal | undefined,
  context: AtomicReplaceFaultContext,
): Promise<void> {
  if (isAsyncIterable(data)) {
    for await (const chunk of data) {
      await writeChunkFully(handle, chunk, signal, context)
    }
    return
  }

  await writeChunkFully(handle, data, signal, context)
}

async function syncDirectoryBestEffort(
  targetPath: string,
  context: AtomicReplaceFaultContext,
): Promise<void> {
  if (process.platform === 'win32') return

  let directoryHandle: FileHandle | undefined
  try {
    directoryHandle = await open(dirname(targetPath), 'r')
    await injectFault('directory-sync', context)
    await directoryHandle.sync()
  } catch {
    // The rename is already committed. Some filesystems do not support
    // syncing directory handles, so directory durability is best-effort.
  } finally {
    try {
      await directoryHandle?.close()
    } catch {
      // Best-effort directory sync must not turn a committed write into failure.
    }
  }
}

/**
 * Replace a regular file through an exclusive sibling temp and atomic rename.
 * No failure before rename modifies or unlinks the target.
 */
export async function replaceFileAtomic(
  requestedPath: string,
  data: string | Uint8Array | AsyncIterable<string | Uint8Array>,
  options: AtomicReplaceOptions = {},
): Promise<void> {
  options.signal?.throwIfAborted()

  const targetPath = await resolveWriteTarget(requestedPath)
  let replacementMode = options.mode ?? 0o600

  try {
    const targetStat = await stat(targetPath)
    if (!targetStat.isFile()) {
      throw new Error(
        `Atomic replacement target is not a regular file: ${requestedPath}`,
      )
    }
    if (options.mode === undefined && options.preserveMode !== false) {
      replacementMode = targetStat.mode & 0o7777
    }
  } catch (error) {
    if (getErrnoCode(error) !== 'ENOENT') throw error
  }

  const tempPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.tmp-${randomBytes(16).toString('hex')}`,
  )
  const context: AtomicReplaceFaultContext = {
    requestedPath,
    targetPath,
    tempPath,
  }

  let handle: FileHandle | undefined
  let tempCreated = false
  let committed = false

  try {
    options.signal?.throwIfAborted()
    await injectFault('temp-open', context)
    handle = await open(tempPath, 'wx', 0o600)
    tempCreated = true

    await writeReplacement(handle, data, options.signal, context)
    options.signal?.throwIfAborted()

    await injectFault('data-flush', context)
    if (options.flush === 'full') {
      await handle.sync()
    } else {
      await handle.datasync()
    }

    await injectFault('chmod', context)
    await handle.chmod(replacementMode)

    await handle.close()
    handle = undefined
    await injectFault('close', context)

    options.signal?.throwIfAborted()
    if (
      options.expectedTargetSize !== undefined &&
      (await stat(targetPath)).size !== options.expectedTargetSize
    ) {
      throw new Error('Atomic replacement target changed before commit')
    }
    await injectFault('rename', context)
    options.signal?.throwIfAborted()
    await rename(tempPath, targetPath)
    committed = true

    await syncDirectoryBestEffort(targetPath, context)
  } catch (error) {
    if (handle) {
      try {
        await handle.close()
      } catch {
        // Preserve the operation error; cleanup below still gets a chance.
      }
    }

    if (tempCreated && !committed) {
      try {
        await injectFault('cleanup', context)
        await unlink(tempPath)
      } catch {
        // Preserve the primary operation error.
      }
    }

    throw error
  }
}
