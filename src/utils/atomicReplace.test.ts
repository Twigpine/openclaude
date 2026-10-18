import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import {
  type AtomicReplaceFaultStage,
  replaceFileAtomic,
  resetAtomicReplaceFaultInjectorForTesting,
  setAtomicReplaceFaultInjectorForTesting,
  setAtomicReplaceWriteLimitForTesting,
} from './atomicReplace.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

const tempDirs: string[] = []

async function tempTarget(initial?: string): Promise<{
  dir: string
  target: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'openclaude-atomic-replace-'))
  tempDirs.push(dir)
  const target = join(dir, 'transcript.jsonl')
  if (initial !== undefined) await writeFile(target, initial)
  return { dir, target }
}

async function tempFiles(dir: string, target: string): Promise<string[]> {
  const prefix = `.${basename(target)}.tmp-`
  return (await readdir(dir)).filter(name => name.startsWith(prefix))
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/atomicReplace.test.ts')
})

afterEach(async () => {
  try {
    resetAtomicReplaceFaultInjectorForTesting()
    setAtomicReplaceWriteLimitForTesting(undefined)
    await Promise.all(
      tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
    )
  } finally {
    releaseSharedMutationLock()
  }
})

test('replaces from strings, bytes, and streamed chunks', async () => {
  const { target } = await tempTarget('old')

  await replaceFileAtomic(target, 'string')
  expect(await readFile(target, 'utf8')).toBe('string')

  await replaceFileAtomic(target, new TextEncoder().encode('bytes'))
  expect(await readFile(target, 'utf8')).toBe('bytes')

  async function* chunks() {
    yield 'stream-'
    yield new TextEncoder().encode('complete')
  }
  await replaceFileAtomic(target, chunks())
  expect(await readFile(target, 'utf8')).toBe('stream-complete')
})

test('retries deterministic short low-level writes until the chunk is complete', async () => {
  const { target } = await tempTarget('old-complete')
  setAtomicReplaceWriteLimitForTesting(3)

  await replaceFileAtomic(target, 'new-complete-transcript')

  expect(await readFile(target, 'utf8')).toBe('new-complete-transcript')
})

test('a zero-progress low-level write preserves the original and cleans the temp', async () => {
  const { dir, target } = await tempTarget('old-complete')
  setAtomicReplaceWriteLimitForTesting(0)

  await expect(replaceFileAtomic(target, 'new')).rejects.toThrow(
    'Atomic replacement made no progress while writing',
  )
  expect(await readFile(target, 'utf8')).toBe('old-complete')
  expect(await tempFiles(dir, target)).toEqual([])
})

test('preserves an existing restrictive mode and creates new files as 0600', async () => {
  if (process.platform === 'win32') return

  const existing = await tempTarget('old')
  await chmod(existing.target, 0o640)
  await replaceFileAtomic(existing.target, 'new')
  expect((await stat(existing.target)).mode & 0o777).toBe(0o640)

  const created = await tempTarget()
  await replaceFileAtomic(created.target, 'new')
  expect((await stat(created.target)).mode & 0o777).toBe(0o600)
})

test('an explicit mode overrides preservation for an existing target', async () => {
  if (process.platform === 'win32') return

  const existing = await tempTarget('old')
  await chmod(existing.target, 0o640)

  await replaceFileAtomic(existing.target, 'new', { mode: 0o600 })

  expect((await stat(existing.target)).mode & 0o777).toBe(0o600)
})

test('preserveMode false applies the private default to an existing target', async () => {
  if (process.platform === 'win32') return

  const existing = await tempTarget('old')
  await chmod(existing.target, 0o644)

  await replaceFileAtomic(existing.target, 'new', { preserveMode: false })

  expect((await stat(existing.target)).mode & 0o777).toBe(0o600)
})

test('full flush commits complete content', async () => {
  const { target } = await tempTarget('old')

  await replaceFileAtomic(target, 'new-complete', { flush: 'full' })

  expect(await readFile(target, 'utf8')).toBe('new-complete')
})

test('writes through live and dangling relative symlinks without replacing them', async () => {
  if (process.platform === 'win32') return

  const live = await tempTarget()
  const liveTarget = join(live.dir, 'live-target.jsonl')
  await writeFile(liveTarget, 'old-live')
  await symlink(basename(liveTarget), live.target)
  await replaceFileAtomic(live.target, 'new-live')
  expect((await lstat(live.target)).isSymbolicLink()).toBe(true)
  expect(await readlink(live.target)).toBe(basename(liveTarget))
  expect(await readFile(liveTarget, 'utf8')).toBe('new-live')

  const dangling = await tempTarget()
  const danglingTarget = join(dangling.dir, 'created-through-link.jsonl')
  await symlink(basename(danglingTarget), dangling.target)
  await replaceFileAtomic(dangling.target, 'new-dangling')
  expect((await lstat(dangling.target)).isSymbolicLink()).toBe(true)
  expect(await readFile(danglingTarget, 'utf8')).toBe('new-dangling')
})

test('an already-aborted replacement preserves the original', async () => {
  const { target } = await tempTarget('old')
  const controller = new AbortController()
  controller.abort()

  await expect(
    replaceFileAtomic(target, 'new', { signal: controller.signal }),
  ).rejects.toBeDefined()
  expect(await readFile(target, 'utf8')).toBe('old')
})

test('an abort at the rename boundary preserves the original', async () => {
  const { dir, target } = await tempTarget('old')
  const controller = new AbortController()
  setAtomicReplaceFaultInjectorForTesting(stage => {
    if (stage === 'rename') controller.abort(new Error('lock compromised'))
  })

  await expect(
    replaceFileAtomic(target, 'new', { signal: controller.signal }),
  ).rejects.toThrow('lock compromised')
  expect(await readFile(target, 'utf8')).toBe('old')
  expect(await tempFiles(dir, target)).toEqual([])
})

const preRenameFaults: AtomicReplaceFaultStage[] = [
  'temp-open',
  'stream-write',
  'data-flush',
  'chmod',
  'close',
  'rename',
]

for (const faultStage of preRenameFaults) {
  test(`${faultStage} failure preserves the original and cleans the temp`, async () => {
    const { dir, target } = await tempTarget('old-complete')
    setAtomicReplaceFaultInjectorForTesting(stage => {
      if (stage === faultStage) throw new Error(`fault:${stage}`)
    })

    async function* replacement() {
      yield 'partial-'
      yield 'replacement'
    }

    await expect(replaceFileAtomic(target, replacement())).rejects.toThrow(
      `fault:${faultStage}`,
    )
    expect(await readFile(target, 'utf8')).toBe('old-complete')
    expect(await tempFiles(dir, target)).toEqual([])
  })
}

test('cleanup failure does not mask the primary failure or modify the target', async () => {
  const { dir, target } = await tempTarget('old')
  setAtomicReplaceFaultInjectorForTesting(stage => {
    if (stage === 'rename') throw new Error('primary rename fault')
    if (stage === 'cleanup') throw new Error('cleanup fault')
  })

  await expect(replaceFileAtomic(target, 'new')).rejects.toThrow(
    'primary rename fault',
  )
  expect(await readFile(target, 'utf8')).toBe('old')
  expect((await tempFiles(dir, target)).length).toBe(1)
})

test('directory sync failure is post-commit and leaves the complete new file', async () => {
  const { target } = await tempTarget('old')
  setAtomicReplaceFaultInjectorForTesting(stage => {
    if (stage === 'directory-sync') throw new Error('directory sync fault')
  })

  await replaceFileAtomic(target, 'new-complete')
  expect(await readFile(target, 'utf8')).toBe('new-complete')
})

test('concurrent readers observe only complete old or complete new bytes', async () => {
  const oldContent = 'old-complete-transcript'
  const newContent = 'new-complete-transcript'
  const { target } = await tempTarget(oldContent)

  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let firstWrite!: () => void
  const wroteFirstChunk = new Promise<void>(resolve => {
    firstWrite = resolve
  })
  let writes = 0
  setAtomicReplaceFaultInjectorForTesting(stage => {
    if (stage === 'stream-write' && writes++ === 0) firstWrite()
  })

  async function* slowReplacement() {
    yield 'new-complete-'
    await gate
    yield 'transcript'
  }

  const replacing = replaceFileAtomic(target, slowReplacement())
  await wroteFirstChunk
  for (let i = 0; i < 25; i++) {
    expect(await readFile(target, 'utf8')).toBe(oldContent)
  }
  release()
  await replacing
  expect(await readFile(target, 'utf8')).toBe(newContent)
})
