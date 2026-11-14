import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  // throws inside an fs callback once the stolen lock is released — the
  // heartbeat's updateLock re-entry reads locks[file] after the release
  // deleted it (TypeError), or the compromised-lock path throws when the
  // lockfile is gone. Re-creating the lock directory and restoring its
  // mtime does NOT prevent this: it only lets the heartbeat pass its
  // filesystem checks and reach the throw. The timer is unref'd, so it
  // cannot keep a process alive on its own; it can only fail a run that
  // is still alive when it fires. The stale-lock scenarios below
  // therefore run in an isolated child process (ISOLATED_CHILD=1): the
  // child exits right after its scenario, well before the timer fires,
  // and its termination contains the timer (CodeRabbit #2497).
  const ISOLATED_CHILD =
    process.env.OPENCLAUDE_BG_CLAIM_RACE_ISOLATED === '1'

  // Runs one stale-lock scenario in an isolated `bun test` child process
  // (this file, filtered to the scenario, ISOLATED_CHILD=1) and fails
  // with the child's output when it does not exit 0.
  async function runStaleLockScenarioInChild(name: string): Promise<void> {
    const child = Bun.spawn(
      [process.execPath, 'test', fileURLToPath(import.meta.url), '-t', name],
      {
        env: { ...process.env, OPENCLAUDE_BG_CLAIM_RACE_ISOLATED: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (exitCode !== 0) {
      throw new Error(
        `isolated stale-lock scenario "${name}" failed (exit ${exitCode}):\n${stdout}\n${stderr}`,
      )
    }
  }

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
  // maintainer review 5896325929 on #2497.
  async function ageSessionLock(id: string): Promise<void> {
    const lockfile = sessionLockfilePath(id)
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

  // The stale-lock scenarios steal the per-ID lock (see the note at the
  // top of this describe): each runs in an isolated `bun test` child
  // process, and the parent only asserts the child exits 0. In the child
  // the same scenario runs in-process with its assertions intact.
  const staleLockScenarios: Array<{
    name: string
    run: () => Promise<void>
  }> = [
    {
      name: 'keeps the first-published terminal fact when a claim is withdrawn during its pointer write',
      run: async () => {
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
    },
    },
    {
      name: 'completes the first-published fact when its pointer write finishes during adoption',
      run: async () => {
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
    },
    },
    {
      name: 'keeps the first-published terminal fact when the sync exit fallback adopts during a pointer write',
      run: async () => {
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
    },
    },
  ]

  for (const scenario of staleLockScenarios) {
    // A child `bun test` run takes ~1 s; allow 30 s so a slow runner
    // cannot flake the wrapper on spawn or startup time.
    it(
      scenario.name,
      async () => {
        if (!ISOLATED_CHILD) {
          await runStaleLockScenarioInChild(scenario.name)
          return
        }
        await scenario.run()
      },
      30_000,
    )
  }
})
