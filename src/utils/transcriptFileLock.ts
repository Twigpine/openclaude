import { lstatSync, readlinkSync } from 'node:fs'
import { lstat, readlink } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { getErrnoCode } from './errors.js'
import * as lockfile from './lockfile.js'

const TRANSCRIPT_LOCK_STALE_MS = 30_000
const TRANSCRIPT_LOCK_WAIT_MS = 30_000
const syncWaitBuffer = new Int32Array(new SharedArrayBuffer(4))
const asyncHeldLockCounts = new Map<string, number>()
const syncHeldLockCounts = new Map<string, number>()

async function resolveTranscriptMutationTarget(
  requestedPath: string,
): Promise<string> {
  let currentPath = resolve(requestedPath)
  const visited = new Set<string>()

  for (let depth = 0; depth < 40; depth++) {
    if (visited.has(currentPath)) {
      throw new Error(`Cannot lock circular transcript symlink: ${requestedPath}`)
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

    const linkTarget = await readlink(currentPath)
    currentPath = isAbsolute(linkTarget)
      ? linkTarget
      : resolve(dirname(currentPath), linkTarget)
  }

  throw new Error(`Cannot lock transcript symlink chain: ${requestedPath}`)
}

function resolveTranscriptMutationTargetSync(requestedPath: string): string {
  let currentPath = resolve(requestedPath)
  const visited = new Set<string>()

  for (let depth = 0; depth < 40; depth++) {
    if (visited.has(currentPath)) {
      throw new Error(`Cannot lock circular transcript symlink: ${requestedPath}`)
    }
    visited.add(currentPath)

    let fileStat
    try {
      fileStat = lstatSync(currentPath)
    } catch (error) {
      if (getErrnoCode(error) === 'ENOENT') return currentPath
      throw error
    }
    if (!fileStat.isSymbolicLink()) return currentPath

    const linkTarget = readlinkSync(currentPath)
    currentPath = isAbsolute(linkTarget)
      ? linkTarget
      : resolve(dirname(currentPath), linkTarget)
  }

  throw new Error(`Cannot lock transcript symlink chain: ${requestedPath}`)
}

function incrementHeldLock(
  counts: Map<string, number>,
  targetPath: string,
): void {
  counts.set(targetPath, (counts.get(targetPath) ?? 0) + 1)
}

function decrementHeldLock(
  counts: Map<string, number>,
  targetPath: string,
): void {
  const remaining = (counts.get(targetPath) ?? 1) - 1
  if (remaining === 0) counts.delete(targetPath)
  else counts.set(targetPath, remaining)
}

function asyncLockOptions(
  targetPath: string,
  onCompromised: (error: Error) => void,
) {
  return {
    lockfilePath: `${targetPath}.lock`,
    realpath: false,
    stale: TRANSCRIPT_LOCK_STALE_MS,
    update: 5_000,
    retries: {
      retries: 240,
      factor: 1.1,
      minTimeout: 5,
      maxTimeout: 250,
      randomize: true,
    },
    onCompromised,
  }
}

function acquireTranscriptLockSync(targetPath: string): () => void {
  const deadline = Date.now() + TRANSCRIPT_LOCK_WAIT_MS
  let retryDelay = 5

  while (true) {
    try {
      return lockfile.lockSync(targetPath, {
        lockfilePath: `${targetPath}.lock`,
        realpath: false,
        stale: TRANSCRIPT_LOCK_STALE_MS,
        update: 5_000,
      })
    } catch (error) {
      if (getErrnoCode(error) !== 'ELOCKED' || Date.now() >= deadline) {
        throw error
      }
      Atomics.wait(syncWaitBuffer, 0, 0, retryDelay)
      retryDelay = Math.min(retryDelay * 2, 100)
    }
  }
}

/** Serialize a complete transcript mutation with writers in other processes. */
export async function withTranscriptFileLock<T>(
  requestedPath: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const targetPath = await resolveTranscriptMutationTarget(requestedPath)
  const controller = new AbortController()
  const release = await lockfile.lock(
    targetPath,
    asyncLockOptions(targetPath, error => controller.abort(error)),
  )
  incrementHeldLock(asyncHeldLockCounts, targetPath)
  try {
    controller.signal.throwIfAborted()
    return await operation(controller.signal)
  } finally {
    try {
      try {
        await release()
      } catch (error) {
        if (
          !controller.signal.aborted ||
          getErrnoCode(error) !== 'ERELEASED'
        ) {
          throw error
        }
      }
    } finally {
      decrementHeldLock(asyncHeldLockCounts, targetPath)
    }
  }
}

/** Synchronous counterpart for shutdown and metadata append call sites. */
export function withTranscriptFileLockSync<T>(
  requestedPath: string,
  operation: () => T,
): T {
  const targetPath = resolveTranscriptMutationTargetSync(requestedPath)
  if ((syncHeldLockCounts.get(targetPath) ?? 0) > 0) return operation()

  const release = acquireTranscriptLockSync(targetPath)
  incrementHeldLock(syncHeldLockCounts, targetPath)
  try {
    return operation()
  } finally {
    try {
      release()
    } finally {
      decrementHeldLock(syncHeldLockCounts, targetPath)
    }
  }
}

/** Return whether this process currently holds an async mutation lock. */
export function isTranscriptFileLockHeldByAsyncOperation(
  requestedPath: string,
): boolean {
  const targetPath = resolveTranscriptMutationTargetSync(requestedPath)
  return (asyncHeldLockCounts.get(targetPath) ?? 0) > 0
}

/** @internal Verify exact lock coverage in deterministic concurrency tests. */
export async function isTranscriptFileLockHeldForTesting(
  requestedPath: string,
): Promise<boolean> {
  const targetPath = await resolveTranscriptMutationTarget(requestedPath)
  return (
    (asyncHeldLockCounts.get(targetPath) ?? 0) > 0 ||
    (syncHeldLockCounts.get(targetPath) ?? 0) > 0
  )
}
