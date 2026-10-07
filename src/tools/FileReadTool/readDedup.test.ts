import { describe, expect, test } from 'bun:test'

import type { FileState } from '../../utils/fileStateCache.js'
import { checkReadDedup, type ReadDedupDeps } from './readDedup.js'

const FILE = 'line 1\nline 2\nline 3\nline 4\nline 5\n'

function fullRead(overrides: Partial<FileState> = {}): FileState {
  return { content: FILE, timestamp: 1000, offset: 1, limit: undefined, ...overrides }
}

function deps(
  mtime: number,
  disk: string = FILE,
): ReadDedupDeps & { reads: Array<[number, number | undefined]> } {
  const reads: Array<[number, number | undefined]> = []
  return {
    reads,
    getModificationTime: async () => mtime,
    readRange: async (offset, limit) => {
      reads.push([offset, limit])
      return { content: disk, mtimeMs: mtime + 0.4 }
    },
  }
}

describe('checkReadDedup', () => {
  test('misses with no prior state', async () => {
    expect(await checkReadDedup(undefined, 1, undefined, deps(1000))).toEqual({ kind: 'miss' })
  })

  test('misses for Edit/Write entries (offset undefined)', async () => {
    const state = fullRead({ offset: undefined })
    expect(await checkReadDedup(state, 1, undefined, deps(1000))).toEqual({ kind: 'miss' })
  })

  test('misses for partial-view entries', async () => {
    const state = fullRead({ isPartialView: true })
    expect(await checkReadDedup(state, 1, undefined, deps(1000))).toEqual({ kind: 'miss' })
  })

  test('same range and same mtime is unchanged without re-reading', async () => {
    const d = deps(1000)
    expect(await checkReadDedup(fullRead(), 1, undefined, d)).toEqual({ kind: 'unchanged' })
    expect(d.reads).toEqual([])
  })

  test('mtime moved but bytes identical is touched with refreshed timestamp', async () => {
    const d = deps(2000)
    expect(await checkReadDedup(fullRead(), 1, undefined, d)).toEqual({
      kind: 'touched',
      timestamp: 2000,
    })
    expect(d.reads).toEqual([[1, undefined]])
  })

  test('mtime moved and bytes changed is a miss', async () => {
    const d = deps(2000, FILE + 'line 6\n')
    expect(await checkReadDedup(fullRead(), 1, undefined, d)).toEqual({ kind: 'miss' })
  })

  test('touched check re-reads the stored range, not the requested one', async () => {
    const state = fullRead({ content: 'line 2\nline 3\n', offset: 2, limit: 2 })
    const d = deps(2000, 'line 2\nline 3\n')
    expect(await checkReadDedup(state, 2, 2, d)).toEqual({ kind: 'touched', timestamp: 2000 })
    expect(d.reads).toEqual([[2, 2]])
  })

  test('sub-range of a prior full read is unchanged', async () => {
    expect(await checkReadDedup(fullRead(), 2, 2, deps(1000))).toEqual({ kind: 'unchanged' })
    expect(await checkReadDedup(fullRead(), 5, undefined, deps(1000))).toEqual({ kind: 'unchanged' })
    expect(await checkReadDedup(fullRead(), 4, 100, deps(1000))).toEqual({ kind: 'unchanged' })
  })

  test('sub-range of a touched-but-identical full read is touched', async () => {
    expect(await checkReadDedup(fullRead(), 3, 1, deps(2000))).toEqual({
      kind: 'touched',
      timestamp: 2000,
    })
  })

  test('offset past the end of a full read misses so the normal warning fires', async () => {
    expect(await checkReadDedup(fullRead(), 6, undefined, deps(1000))).toEqual({ kind: 'miss' })
  })

  test('a different range of a partial read misses', async () => {
    const state = fullRead({ content: 'line 1\nline 2\n', offset: 1, limit: 2 })
    expect(await checkReadDedup(state, 2, 1, deps(1000))).toEqual({ kind: 'miss' })
  })

  test('a range read cannot be served by an earlier full read of an empty file', async () => {
    const state = fullRead({ content: '' })
    expect(await checkReadDedup(state, 1, 10, deps(1000))).toEqual({ kind: 'miss' })
  })

  test('stat or read failure falls through to a miss', async () => {
    const failingStat: ReadDedupDeps = {
      getModificationTime: async () => {
        throw new Error('EACCES')
      },
      readRange: async () => ({ content: FILE, mtimeMs: 1000 }),
    }
    expect(await checkReadDedup(fullRead(), 1, undefined, failingStat)).toEqual({ kind: 'miss' })

    const failingRead: ReadDedupDeps = {
      getModificationTime: async () => 2000,
      readRange: async () => {
        throw new Error('too large')
      },
    }
    expect(await checkReadDedup(fullRead(), 1, undefined, failingRead)).toEqual({ kind: 'miss' })
  })
})
