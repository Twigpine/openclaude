import type { FileState } from '../../utils/fileStateCache.js'

/**
 * Outcome of the Read dedup check.
 * - `miss`: send the file content as usual.
 * - `unchanged`: the model already has this content; return the stub.
 * - `touched`: mtime moved but the bytes are identical (git checkout, stash
 *   pop, a formatter rewriting the same output, `touch`). Return the stub and
 *   refresh the cached timestamp so later checks stay on the fast path.
 */
export type ReadDedupResult =
  | { kind: 'miss' }
  | { kind: 'unchanged' }
  | { kind: 'touched'; timestamp: number }

export interface ReadDedupDeps {
  getModificationTime: () => Promise<number>
  /** Re-read the given range with the same semantics as the original Read. */
  readRange: (
    offset: number,
    limit: number | undefined,
  ) => Promise<{ content: string; mtimeMs: number }>
}

function isFullRead(state: FileState): boolean {
  return (state.offset === 1 || state.offset === 0) && state.limit === undefined
}

function countLines(content: string): number {
  if (content === '') return 0
  const lines = content.split('\n').length
  return content.endsWith('\n') ? lines - 1 : lines
}

/**
 * Whether the requested range is already in context from a prior full Read.
 * Requires the start line to exist so an out-of-range offset still reaches
 * the normal path and gets its "file is shorter than offset" warning.
 */
function isCoveredByFullRead(
  state: FileState,
  offset: number,
  limit: number | undefined,
): boolean {
  if (!isFullRead(state)) return false
  if (limit !== undefined && limit <= 0) return false
  const startLine = offset === 0 ? 1 : offset
  return startLine >= 1 && startLine <= countLines(state.content)
}

/**
 * Decide whether a Read can be answered with the "file unchanged" stub.
 *
 * Only entries from a prior Read qualify (offset is always set by Read;
 * Edit/Write store offset=undefined and reflect post-edit content the model
 * never saw as a Read result). A hit is either the exact same range, or any
 * in-bounds range of a file the model already read in full. When mtime has
 * moved, the stored range is re-read and compared byte-for-byte before
 * deduping, so a touched-but-identical file doesn't resend its content.
 * Any failure falls through to a normal read.
 */
export async function checkReadDedup(
  state: FileState | undefined,
  offset: number,
  limit: number | undefined,
  deps: ReadDedupDeps,
): Promise<ReadDedupResult> {
  if (!state || state.isPartialView || state.offset === undefined) {
    return { kind: 'miss' }
  }
  const exactRange = state.offset === offset && state.limit === limit
  if (!exactRange && !isCoveredByFullRead(state, offset, limit)) {
    return { kind: 'miss' }
  }

  try {
    const mtimeMs = await deps.getModificationTime()
    if (mtimeMs === state.timestamp) return { kind: 'unchanged' }

    const current = await deps.readRange(state.offset, state.limit)
    if (current.content === state.content) {
      return { kind: 'touched', timestamp: Math.floor(current.mtimeMs) }
    }
  } catch {
    // stat/read failed — fall through to full read
  }
  return { kind: 'miss' }
}
