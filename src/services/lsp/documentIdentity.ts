import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const MAX_LSP_FILE_SIZE_BYTES = 10_000_000

export class LspDocumentTooLargeError extends Error {
  readonly sizeBytes: number

  constructor(sizeBytes: number) {
    super(
      `File too large for LSP analysis (${Math.ceil(sizeBytes / 1_000_000)}MB exceeds 10MB limit)`,
    )
    this.name = 'LspDocumentTooLargeError'
    this.sizeBytes = sizeBytes
  }
}

export type LspDocumentIdentity = {
  resolvedPath: string
  fileUri: string
  stateKey: string
  activityPath: string
}

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/

function encodeWindowsFileUri(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/').toLowerCase()
  const [drive, ...segments] = normalized.split('/')
  const encodedSegments = segments.map(segment =>
    encodeURIComponent(segment).replace(/[!'()*]/g, character =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    ),
  )
  return `file:///${drive?.toLowerCase()}/${encodedSegments.join('/')}`
}

/**
 * Resolve the filesystem path and stable URI/key used for one LSP document.
 * Windows document identity is case-insensitive; POSIX identity is not.
 */
export function getLspDocumentIdentity(
  filePath: string,
): LspDocumentIdentity {
  if (process.platform === 'win32' || WINDOWS_DRIVE_PATH.test(filePath)) {
    const resolvedPath = path.win32.resolve(filePath)
    if (WINDOWS_DRIVE_PATH.test(resolvedPath)) {
      const fileUri = encodeWindowsFileUri(resolvedPath)
      return {
        resolvedPath,
        fileUri,
        stateKey: fileUri,
        activityPath: fileURLToPath(fileUri),
      }
    }

    const fileUri = pathToFileURL(resolvedPath).href
    return {
      resolvedPath,
      fileUri,
      stateKey: fileUri.toLowerCase(),
      activityPath: fileURLToPath(fileUri),
    }
  }

  const resolvedPath = path.resolve(filePath)
  const fileUri = pathToFileURL(resolvedPath).href
  return {
    resolvedPath,
    fileUri,
    stateKey: fileUri,
    activityPath: resolvedPath,
  }
}

/** Read a complete LSP document without bypassing the tool's size policy. */
export async function readLspDocumentContents(
  filePath: string,
): Promise<string> {
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NONBLOCK,
  )
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) {
      throw new Error(`LSP document is not a regular file: ${filePath}`)
    }
    if (stats.size > MAX_LSP_FILE_SIZE_BYTES) {
      throw new LspDocumentTooLargeError(stats.size)
    }

    const chunks: Buffer[] = []
    let totalBytes = 0
    while (totalBytes <= MAX_LSP_FILE_SIZE_BYTES) {
      const bytesRemaining = MAX_LSP_FILE_SIZE_BYTES + 1 - totalBytes
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, bytesRemaining))
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        null,
      )
      if (bytesRead === 0) break

      totalBytes += bytesRead
      if (totalBytes > MAX_LSP_FILE_SIZE_BYTES) {
        throw new LspDocumentTooLargeError(totalBytes)
      }
      chunks.push(buffer.subarray(0, bytesRead))
    }

    return Buffer.concat(chunks, totalBytes).toString('utf-8')
  } finally {
    await handle.close()
  }
}
