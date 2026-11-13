import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/**
 * Regression tests for maintainer review 5896325929 (P2) on #2497:
 * a terminal-fact claim file becomes visible before its pointer write
 * finishes, so a concurrent installer can observe it empty, treat it as
 * invalid, remove the claim, and publish its own complete fact — and the
 * original writer's rename then replaces the successor's fact. A delayed
 * owner must never replace an already-published fact.
 *
 * The open-before-write phase is reproduced by pausing the claim-file
 * write between open() and write: the claim file exists but is still
 * empty while the owner has not finished writing its pointer. The
 * registry module is imported after the mock is registered so it binds
 * the mocked writeFile (same mechanism as bgRegistry.noHardLinks.test.ts).
 */

// Capture the real implementation before any mock.module call: Bun's
// mock.module mutates the shared node:fs/promises namespace object, so a
// later import returns the mock — capturing the module object alone does
// not preserve the real writeFile. These bindings are plain values, not
// live module bindings, so the mock cannot rewrite them (CodeRabbit #2497).
const realFsPromises = await import('node:fs/promises')
const realWriteFile = realFsPromises.writeFile
const realOpen = realFsPromises.open

const TEST_PROCESS_MARKER = 'a'.repeat(64)

// Pause control for the next terminal-fact claim-file write. Consumed by
// the first paused write, so a second installer's claim write proceeds
// normally instead of deadlocking on the same gate.
type PausedClaimWrite = {
  opened: () => void
  gate: Promise<void>
}
let pausedClaimWrite: PausedClaimWrite | undefined

function isTerminalFactClaimFilePath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    basename(path) === 'tmp' &&
    basename(dirname(path)).endsWith('.claim')
  )
}

async function mockedWriteFile(
  path: string | Buffer | URL,
  data: string | Uint8Array,
  options?: {
    encoding?: BufferEncoding
    flag?: string | number
    mode?: number
  },
): Promise<void> {
  if (pausedClaimWrite && isTerminalFactClaimFilePath(path)) {
    const control = pausedClaimWrite
    pausedClaimWrite = undefined
    // Reproduce the real open-before-write phase: the claim file is
    // created (visible) before its content is written, so a concurrent
    // adopter can observe it empty.
    const handle = await realOpen(path, 'wx')
    try {
      control.opened()
      await control.gate
      await handle.writeFile(data)
    } finally {
      await handle.close()
    }
    return
  }
  await realWriteFile(path, data, options)
}

describe('terminal-fact publish across withdrawn claims', () => {
  let configDir: string
  let registry: typeof import('./bgRegistry.js')

  // Stealing the per-ID lock orphans the first installer's
  // proper-lockfile update timer: it fires 5 s after acquisition and
  // throws unless the lockfile still exists with the first installer's
  // recorded mtime. Record it here so afterEach can re-create the
  // lockfile (an empty directory under the temp root) and keep that
  // timer harmless for the rest of the suite run.
  let orphanedLockNeutralization:
    | { lockfilePath: string; mtime: Date }
    | undefined

  function terminalFactPath(id: string, kind: 'natural' | 'killed'): string {
    return join(
      configDir,
      'bg-sessions',
      'terminal',
      `${id}~${TEST_PROCESS_MARKER}.${kind}.json`,
    )
  }

  function sessionLockfilePath(id: string): string {
    return join(configDir, 'bg-sessions', 'sessions', `${id}.json.lock`)
  }

  // Ages the per-ID lock past proper-lockfile's 10 s stale threshold
  // (a wall-clock jump), so a second async finalizer can proceed while
  // the first is paused mid-publish — the async stale-lock probe from
  // maintainer review 5896325929 on #2497. Records the lockfile's
  // pre-age mtime first: that is the first installer's lock mtime, and
  // afterEach restores it so the orphaned update timer keeps matching.
  async function ageSessionLock(id: string): Promise<void> {
    const lockfile = sessionLockfilePath(id)
    const { mtime } = await stat(lockfile)
    orphanedLockNeutralization = { lockfilePath: lockfile, mtime }
    const stale = new Date(Date.now() - 11_000)
    await utimes(lockfile, stale, stale)
  }

  // Arms the one-shot open-before-write pause; `opened` resolves once
  // the owner's claim file exists but is still empty.
  function armClaimWritePause(): {
    opened: Promise<void>
    release: () => void
  } {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    let openedResolve!: () => void
    const opened = new Promise<void>(resolve => {
      openedResolve = resolve
    })
    pausedClaimWrite = { opened: openedResolve, gate }
    return { opened, release }
  }

  // Fails fast with a clear message when the pause never fires (e.g.
  // the mock stopped applying), instead of hanging on the gate.
  async function awaitClaimOpened(opened: Promise<void>): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        opened,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  'claim-write pause never fired: the writeFile mock is not active',
                ),
              ),
            5000,
          )
        }),
      ])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }

  async function storedExitCode(id: string): Promise<number | undefined> {
    const stored = JSON.parse(
      await readFile(terminalFactPath(id, 'natural'), 'utf8'),
    ) as { exitCode?: number }
    return stored.exitCode
  }

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'openclaude-bg-claim-race-'))
    mock.module('node:fs/promises', () => ({
      ...realFsPromises,
      writeFile: mockedWriteFile,
    }))
    registry = await import('./bgRegistry.js')
    registry._setBackgroundSessionsRootForTesting(
      join(configDir, 'bg-sessions'),
    )
  })

  afterEach(async () => {
    pausedClaimWrite = undefined
    mock.restore()
    // See bgRegistry.noHardLinks.test.ts: mock.restore() does not undo a
    // mock.module registration, so re-register the real module explicitly
    // so later files bind the unmocked implementation again.
    mock.module('node:fs/promises', () => ({
      ...realFsPromises,
      writeFile: realWriteFile,
    }))
    registry?._setBackgroundSessionsRootForTesting(undefined)
    await rm(configDir, { force: true, recursive: true })
    if (orphanedLockNeutralization) {
      const { lockfilePath, mtime } = orphanedLockNeutralization
      orphanedLockNeutralization = undefined
      // The stolen lock orphaned the first installer's update timer; it
      // fires 5 s after acquisition and throws unless the lockfile still
      // exists with its recorded mtime. Re-create just that empty
      // directory (under the removed temp root) so the timer refreshes
      // it and reschedules instead of failing the suite run.
      await mkdir(dirname(lockfilePath), { recursive: true })
      await mkdir(lockfilePath, { recursive: true })
      await utimes(lockfilePath, mtime, mtime)
    }
  })

  it('the claim-write mock pauses a claim file between open and write', async () => {
    // Guards the regression tests below: if the mock silently stopped
    // applying, the open-before-write phase would no longer be paused.
    const claimFile = join(
      configDir,
      'guard.natural.json.claim',
      'tmp',
    )
    await mkdir(dirname(claimFile), { recursive: true })
    const { opened, release } = armClaimWritePause()
    const mocked = await import('node:fs/promises')
    const writing = mocked.writeFile(claimFile, '/tmp/pointer.tmp')
    try {
      await awaitClaimOpened(opened)
      // The claim file is visible but still empty: the open-before-write
      // phase.
      expect(await readFile(claimFile, 'utf8')).toBe('')
      release()
      await writing
      expect(await readFile(claimFile, 'utf8')).toBe('/tmp/pointer.tmp')
    } finally {
      pausedClaimWrite = undefined
      release()
      await writing.catch(() => {})
    }
  })

  it('keeps the first-published terminal fact when a claim is withdrawn during its pointer write', async () => {
    // Regression test for maintainer review 5896325929 (P2) on #2497:
    // the first installer opens its claim file but has not finished
    // writing its pointer when a second async installer adopts. The
    // adopter treats the empty claim as invalid, removes it, and
    // publishes its own complete fact; the first installer's write then
    // completes on the unlinked inode and its rename replaces the
    // successor's fact, so the waiter first observes failed/exitCode 3
    // and later exited/exitCode 0. The first publisher must win: a
    // delayed owner must never replace an already-published fact.
    const session = await registry.createBackgroundSession({
      id: 'bg-claim-race-async',
      pid: 424242,
      cwd: '/repo',
      command: ['sleep', '30'],
      sessionId: 'sess-claim-race-async',
      processMarker: TEST_PROCESS_MARKER,
    })
    const { opened, release } = armClaimWritePause()
    // Start the first finalization and pause it in the real
    // open-before-write phase: its claim file exists but is empty.
    const firstTermination =
      registry.recordBackgroundSessionNaturalTermination(
        session.id,
        { exitCode: 0 },
        { ownerPid: session.pid, expectedSession: session },
      )
    // Mark the rejection handled so a failure mid-test cannot surface
    // as an unhandled rejection; awaiting the promise still throws.
    firstTermination.catch(() => {})
    try {
      await awaitClaimOpened(opened)
      // The second async finalizer cannot wait for the per-ID lock the
      // first holds: age the lock past the stale threshold (a clock
      // jump), as in the review's async stale-lock probe.
      await ageSessionLock(session.id)
      const second = await registry.recordBackgroundSessionNaturalTermination(
        session.id,
        { exitCode: 3 },
        { ownerPid: session.pid, expectedSession: session },
      )
      // The second installer published while the first was stalled, so
      // the waiter already sees its exit code — not the first's.
      expect(second).toMatchObject({ status: 'failed', exitCode: 3 })
      expect(
        await registry.resolveBackgroundSessionForWait(session.id),
      ).toMatchObject({ status: 'failed', exitCode: 3 })
      release()
      const first = await firstTermination
      // The resumed installer must not replace the published fact.
      expect(first).toMatchObject({ status: 'failed', exitCode: 3 })
      expect(
        await registry.resolveBackgroundSessionForWait(session.id),
      ).toMatchObject({ status: 'failed', exitCode: 3 })
      expect(await storedExitCode(session.id)).toBe(3)
    } finally {
      pausedClaimWrite = undefined
      release()
      await firstTermination.catch(() => {})
    }
  })

  it('completes the first-published fact when its pointer write finishes during adoption', async () => {
    // The adopter must not treat an empty claim as invalid while the
    // winner's pointer write is still in flight: it polls until the
    // claim names a temp file, then completes the winner's publish
    // instead of removing the claim and publishing its own fact.
    const session = await registry.createBackgroundSession({
      id: 'bg-claim-race-adopt',
      pid: 424242,
      cwd: '/repo',
      command: ['sleep', '30'],
      sessionId: 'sess-claim-race-adopt',
      processMarker: TEST_PROCESS_MARKER,
    })
    const { opened, release } = armClaimWritePause()
    const firstTermination =
      registry.recordBackgroundSessionNaturalTermination(
        session.id,
        { exitCode: 0 },
        { ownerPid: session.pid, expectedSession: session },
      )
    firstTermination.catch(() => {})
    try {
      await awaitClaimOpened(opened)
      await ageSessionLock(session.id)
      const secondTermination =
        registry.recordBackgroundSessionNaturalTermination(
          session.id,
          { exitCode: 3 },
          { ownerPid: session.pid, expectedSession: session },
        )
      secondTermination.catch(() => {})
      // The adopter waits 250 ms for the target, then polls the claim:
      // release the pointer write while it is polling, so it reads the
      // completed claim instead of a stale empty one.
      await new Promise(resolve => setTimeout(resolve, 300))
      release()
      const second = await secondTermination
      // The adopter completed the first publisher's fact.
      expect(second).toMatchObject({ status: 'exited', exitCode: 0 })
      const first = await firstTermination
      expect(first).toMatchObject({ status: 'exited', exitCode: 0 })
      expect(
        await registry.resolveBackgroundSessionForWait(session.id),
      ).toMatchObject({ status: 'exited', exitCode: 0 })
      expect(await storedExitCode(session.id)).toBe(0)
    } finally {
      pausedClaimWrite = undefined
      release()
      await firstTermination.catch(() => {})
    }
  })

  it('keeps the first-published terminal fact when the sync exit fallback adopts during a pointer write', async () => {
    // Same withdrawn-claim race through the synchronous reader/adopter:
    // the exit fallback cannot wait for the per-ID lock, so it
    // publishes without it — but it must not replace the pending
    // publish, and the resumed async installer must not replace the
    // fallback's fact either.
    const session = await registry.createBackgroundSession({
      id: 'bg-claim-race-sync',
      pid: 424242,
      cwd: '/repo',
      command: ['sleep', '30'],
      sessionId: 'sess-claim-race-sync',
      processMarker: TEST_PROCESS_MARKER,
    })
    const { opened, release } = armClaimWritePause()
    const firstTermination =
      registry.recordBackgroundSessionNaturalTermination(
        session.id,
        { exitCode: 0 },
        { ownerPid: session.pid, expectedSession: session },
      )
    firstTermination.catch(() => {})
    try {
      await awaitClaimOpened(opened)
      // The first installer holds the per-ID lock, so the sync call
      // takes the ELOCKED fallback and publishes without it.
      registry.recordBackgroundSessionNaturalTerminationSync(
        session.id,
        { exitCode: 3 },
        { ownerPid: session.pid, expectedSession: session },
      )
      expect(
        await registry.resolveBackgroundSessionForWait(session.id),
      ).toMatchObject({ status: 'failed', exitCode: 3 })
      release()
      const first = await firstTermination
      // The resumed installer must not replace the published fact.
      expect(first).toMatchObject({ status: 'failed', exitCode: 3 })
      expect(
        await registry.resolveBackgroundSessionForWait(session.id),
      ).toMatchObject({ status: 'failed', exitCode: 3 })
      expect(await storedExitCode(session.id)).toBe(3)
    } finally {
      pausedClaimWrite = undefined
      release()
      await firstTermination.catch(() => {})
    }
  })
})
