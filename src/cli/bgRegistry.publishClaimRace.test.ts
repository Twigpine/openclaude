import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { randomUUID } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises'
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
const realLink = realFsPromises.link
const realRename = realFsPromises.rename
const realFs = await import('node:fs')
const realLinkSync = realFs.linkSync
const realRenameSync = realFs.renameSync
const realWriteFileSync = realFs.writeFileSync

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

// Commit-injection control for the delayed-commit regression tests
// (maintainer review 5942761094 on #2497). When armed, the next commit
// call for the given target first publishes the successor fact to the
// target, then performs the real commit — reproducing a fact another
// installer already published landing between the owner's ownership
// check and its commit. The commit must be atomic (link() EEXIST), so
// the delayed owner returns the successor's fact instead of replacing
// it. One-shot: consumed by the first matching commit call.
type CommitInjection = {
  target: string
  successor: Record<string, unknown>
  fired: () => void
}
let commitInjection: CommitInjection | undefined

// Commit-pause control for the writeNewSession race test. When armed,
// every commit call for the given target waits on a gate the test
// releases, so the test can order two creates' commits: the first
// create commits first, the second create's commit then lands on the
// published row.
type CommitPause = {
  target: string
  onPaused: (control: { release: () => void }) => void
}
let commitPause: CommitPause | undefined

// Forces link()/linkSync() to fail with EPERM: simulates a filesystem
// that rejects hard links (same mechanism as
// bgRegistry.noHardLinks.test.ts). Armed per-test below, so the
// concurrent-create and delayed-commit regressions can run the
// rename() fallback path (CodeRabbit #2497 review 5945720742).
let linkUnsupported = false
const linkUnsupportedError = Object.assign(
  new Error('Operation not permitted'),
  { code: 'EPERM' },
)

// Records every mocked link() destination, so a test can wait until a
// second create has entered the commit before releasing the first
// create's paused rename (CodeRabbit #2497).
const linkCallTargets: string[] = []

async function mockedLink(oldPath: string, newPath: string): Promise<void> {
  linkCallTargets.push(newPath)
  if (commitInjection && newPath === commitInjection.target) {
    const injection = commitInjection
    commitInjection = undefined
    await realWriteFile(newPath, JSON.stringify(injection.successor))
    injection.fired()
  }
  if (linkUnsupported) throw linkUnsupportedError
  if (commitPause && newPath === commitPause.target) {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    commitPause.onPaused({ release })
    await gate
  }
  await realLink(oldPath, newPath)
}

async function mockedRename(
  oldPath: string,
  newPath: string,
): Promise<void> {
  if (commitInjection && newPath === commitInjection.target) {
    const injection = commitInjection
    commitInjection = undefined
    await realWriteFile(newPath, JSON.stringify(injection.successor))
    injection.fired()
  }
  if (commitPause && newPath === commitPause.target) {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    commitPause.onPaused({ release })
    await gate
  }
  await realRename(oldPath, newPath)
}

function mockedLinkSync(oldPath: string, newPath: string): void {
  if (commitInjection && newPath === commitInjection.target) {
    const injection = commitInjection
    commitInjection = undefined
    realWriteFileSync(newPath, JSON.stringify(injection.successor))
    injection.fired()
  }
  if (linkUnsupported) throw linkUnsupportedError
  realLinkSync(oldPath, newPath)
}

function mockedRenameSync(oldPath: string, newPath: string): void {
  if (commitInjection && newPath === commitInjection.target) {
    const injection = commitInjection
    commitInjection = undefined
    realWriteFileSync(newPath, JSON.stringify(injection.successor))
    injection.fired()
  }
  realRenameSync(oldPath, newPath)
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

  function metadataPath(id: string): string {
    return join(configDir, 'bg-sessions', 'sessions', `${id}.json`)
  }

  function sessionLockfilePath(id: string): string {
    return join(configDir, 'bg-sessions', 'sessions', `${id}.json.lock`)
  }

  // Builds the successor fact the commit-injection mock publishes: same
  // session and owner pid as the first installer, but the opposite
  // outcome, so the stored fact proves which publisher won.
  function successorFact(
    id: string,
    exitCode: number,
  ): Record<string, unknown> {
    return {
      version: 1,
      id,
      pid: 424242,
      generation: TEST_PROCESS_MARKER,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      terminalReason: 'exit_code',
      exitCode,
    }
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

  // Ages a no-hard-link commit claim (`<target>.commit`) past the
  // 10 s stale threshold, so a second publisher reclaims it while the
  // first is paused between its target recheck and its rename —
  // the stale-claim probe from maintainer review 5948202472 on #2497.
  async function ageCommitClaim(target: string): Promise<void> {
    const stale = new Date(Date.now() - 11_000)
    await utimes(`${target}.commit`, stale, stale)
  }

  // Arms the commit-publish hook so only the first commit call pauses:
  // the holder stalls between its target recheck and its rename, and
  // every later commit (the successor's) proceeds normally. `entered`
  // resolves once the holder has reached the hook.
  function armCommitHookPause(): {
    entered: Promise<void>
    release: () => void
  } {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    let enteredResolve!: () => void
    const entered = new Promise<void>(resolve => {
      enteredResolve = resolve
    })
    let calls = 0
    registry._setCommitPublishHookForTesting(async () => {
      calls += 1
      if (calls === 1) {
        enteredResolve()
        await gate
      }
    })
    return { entered, release }
  }

  // Fails fast with a clear message when the commit hook never fires
  // (e.g. the holder never reached its commit), instead of hanging.
  async function awaitCommitHookEntered(
    entered: Promise<void>,
  ): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        entered,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  'commit hook never fired: the holder never reached its commit',
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

  // Waits until the commit-pause mock has paused the nth commit for the
  // target, failing fast when the pause never fires (e.g. the mock
  // stopped applying), instead of hanging on the gate.
  async function awaitCommitPaused(
    commits: Array<{ release: () => void }>,
    index: number,
  ): Promise<void> {
    const deadline = Date.now() + 5000
    while (commits[index] === undefined) {
      if (Date.now() >= deadline) {
        throw new Error(
          `commit pause ${index} never fired: the link/rename mock is not active`,
        )
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  // Waits until link() has been called `count` times for the target,
  // failing fast when the calls never arrive (e.g. the mock stopped
  // applying), instead of hanging.
  async function awaitLinkCalls(target: string, count: number): Promise<void> {
    const deadline = Date.now() + 5000
    while (
      linkCallTargets.filter(path => path === target).length < count
    ) {
      if (Date.now() >= deadline) {
        throw new Error(
          `link() was not called ${count} times for ${target}: the link mock is not active`,
        )
      }
      await new Promise(resolve => setTimeout(resolve, 10))
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
      link: mockedLink,
      rename: mockedRename,
    }))
    mock.module('node:fs', () => ({
      ...realFs,
      linkSync: mockedLinkSync,
      renameSync: mockedRenameSync,
    }))
    registry = await import('./bgRegistry.js')
    registry._setBackgroundSessionsRootForTesting(
      join(configDir, 'bg-sessions'),
    )
  })

  afterEach(async () => {
    pausedClaimWrite = undefined
    commitInjection = undefined
    commitPause = undefined
    linkUnsupported = false
    linkCallTargets.length = 0
    registry?._setCommitPublishHookForTesting(undefined)
    registry?._setCommitPublishHookForTestingSync(undefined)
    mock.restore()
    // See bgRegistry.noHardLinks.test.ts: mock.restore() does not undo a
    // mock.module registration, so re-register the real module explicitly
    // so later files bind the unmocked implementation again.
    mock.module('node:fs/promises', () => ({
      ...realFsPromises,
      writeFile: realWriteFile,
      link: realLink,
      rename: realRename,
    }))
    mock.module('node:fs', () => ({
      ...realFs,
      linkSync: realLinkSync,
      renameSync: realRenameSync,
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

  it('keeps the successor fact when a delayed owner commits after it was published', async () => {
    // Regression test for maintainer review 5942761094 (P2) on #2497:
    // the owner's ownership check passed, but a successor published its
    // fact before the owner's commit landed. The commit must be atomic
    // (link() EEXIST), so the delayed owner returns the successor's
    // fact instead of renaming over it. The commit-injection mock
    // publishes the successor fact inside the owner's commit call, so
    // the interleaving is deterministic: on a rename commit the
    // successor fact is overwritten, on a link commit it wins.
    const session = await registry.createBackgroundSession({
      id: 'bg-commit-race-async',
      pid: 424242,
      cwd: '/repo',
      command: ['sleep', '30'],
      sessionId: 'sess-commit-race-async',
      processMarker: TEST_PROCESS_MARKER,
    })
    let injectionFired = false
    commitInjection = {
      target: terminalFactPath(session.id, 'natural'),
      successor: successorFact(session.id, 3),
      fired: () => {
        injectionFired = true
      },
    }
    try {
      const terminated =
        await registry.recordBackgroundSessionNaturalTermination(
          session.id,
          { exitCode: 0 },
          { ownerPid: session.pid, expectedSession: session },
        )
      expect(injectionFired).toBe(true)
      // The delayed owner must not replace the published fact.
      expect(terminated).toMatchObject({ status: 'failed', exitCode: 3 })
      expect(
        await registry.resolveBackgroundSessionForWait(session.id),
      ).toMatchObject({ status: 'failed', exitCode: 3 })
      expect(await storedExitCode(session.id)).toBe(3)
    } finally {
      commitInjection = undefined
    }
  })

  it('keeps the successor fact when a delayed owner commits after it was published without hard links', async () => {
    // Same delayed-commit race as the test above, but with link()
    // rejected (EPERM): the commit falls back to rename(), which
    // overwrites the successor fact, and the readback matches the
    // owner's own bytes — so without an exclusive fallback the delayed
    // owner replaces the published fact (CodeRabbit #2497 review
    // 5945720742).
    const session = await registry.createBackgroundSession({
      id: 'bg-commit-race-async-no-link',
      pid: 424242,
      cwd: '/repo',
      command: ['sleep', '30'],
      sessionId: 'sess-commit-race-async-no-link',
      processMarker: TEST_PROCESS_MARKER,
    })
    let injectionFired = false
    commitInjection = {
      target: terminalFactPath(session.id, 'natural'),
      successor: successorFact(session.id, 3),
      fired: () => {
        injectionFired = true
      },
    }
    linkUnsupported = true
    try {
      const terminated =
        await registry.recordBackgroundSessionNaturalTermination(
          session.id,
          { exitCode: 0 },
          { ownerPid: session.pid, expectedSession: session },
        )
      expect(injectionFired).toBe(true)
      // The delayed owner must not replace the published fact.
      expect(terminated).toMatchObject({ status: 'failed', exitCode: 3 })
      expect(
        await registry.resolveBackgroundSessionForWait(session.id),
      ).toMatchObject({ status: 'failed', exitCode: 3 })
      expect(await storedExitCode(session.id)).toBe(3)
    } finally {
      commitInjection = undefined
      linkUnsupported = false
    }
  })

  it('recovers an abandoned terminal-fact claim whose temp is gone', async () => {
    // Regression test for maintainer review 5948202472 (P2) on #2497:
    // a valid claim naming a temp that was unlinked — the winner died
    // after writing the claim, as in the review-probe fixture
    // runtime/wave1-contract/stale-claim.log — must be reclaimed so
    // the next attempt can claim the publish itself, instead of
    // retrying against the same dead pointer until the attempts run
    // out and the session stays `running`.
    const session = await registry.createBackgroundSession({
      id: 'bg-stale-claim-async',
      pid: 424242,
      cwd: '/repo',
      command: ['sleep', '30'],
      sessionId: 'sess-stale-claim-async',
      processMarker: TEST_PROCESS_MARKER,
    })
    const target = terminalFactPath(session.id, 'natural')
    const claimDir = `${target}.claim`
    await mkdir(claimDir, { recursive: true })
    const missingTmp = join(
      configDir,
      'bg-sessions',
      'terminal',
      `${session.id}.${session.pid}.${randomUUID()}.tmp`,
    )
    await writeFile(join(claimDir, 'tmp'), missingTmp)
    const terminated = await registry.recordBackgroundSessionNaturalTermination(
      session.id,
      { exitCode: 0 },
      { ownerPid: session.pid, expectedSession: session },
    )
    expect(terminated).toMatchObject({ status: 'exited', exitCode: 0 })
    expect(
      await registry.resolveBackgroundSessionForWait(session.id),
    ).toMatchObject({ status: 'exited', exitCode: 0 })
    expect(await storedExitCode(session.id)).toBe(0)
  })

  it('recovers an abandoned terminal-fact claim whose temp is gone through the sync fallback', async () => {
    // Same abandoned-claim recovery as the test above, but through the
    // synchronous exit fallback (maintainer review 5948202472 on
    // #2497): the sync adopter reclaims the dead pointer and the
    // termination completes instead of throwing after its attempts.
    const session = await registry.createBackgroundSession({
      id: 'bg-stale-claim-sync',
      pid: 424242,
      cwd: '/repo',
      command: ['sleep', '30'],
      sessionId: 'sess-stale-claim-sync',
      processMarker: TEST_PROCESS_MARKER,
    })
    const target = terminalFactPath(session.id, 'natural')
    const claimDir = `${target}.claim`
    await mkdir(claimDir, { recursive: true })
    const missingTmp = join(
      configDir,
      'bg-sessions',
      'terminal',
      `${session.id}.${session.pid}.${randomUUID()}.tmp`,
    )
    await writeFile(join(claimDir, 'tmp'), missingTmp)
    registry.recordBackgroundSessionNaturalTerminationSync(
      session.id,
      { exitCode: 0 },
      { ownerPid: session.pid, expectedSession: session },
    )
    expect(await storedExitCode(session.id)).toBe(0)
    expect(
      await registry.resolveBackgroundSessionForWait(session.id),
    ).toMatchObject({ status: 'exited', exitCode: 0 })
  })

  it('keeps the successor fact when the sync fallback adopts after it was published', async () => {
    // Same delayed-commit race through the synchronous exit fallback:
    // the async installer is paused after claiming, the sync fallback
    // adopts its tmp, and a successor fact lands before the adopt
    // commit. The adopt commit must be atomic too.
    const session = await registry.createBackgroundSession({
      id: 'bg-commit-race-sync',
      pid: 424242,
      cwd: '/repo',
      command: ['sleep', '30'],
      sessionId: 'sess-commit-race-sync',
      processMarker: TEST_PROCESS_MARKER,
    })
    let releaseHook: (() => void) | undefined
    let hookReachedResolve: (() => void) | undefined
    const hookReached = new Promise<void>(resolve => {
      hookReachedResolve = resolve
    })
    const hookGate = new Promise<void>(resolve => {
      releaseHook = resolve
    })
    registry._setTerminalFactPublishHookForTesting(async () => {
      hookReachedResolve?.()
      await hookGate
    })
    const asyncTermination =
      registry.recordBackgroundSessionNaturalTermination(
        session.id,
        { exitCode: 0 },
        { ownerPid: session.pid, expectedSession: session },
      )
    asyncTermination.catch(() => {})
    try {
      await hookReached
      let injectionFired = false
      commitInjection = {
        target: terminalFactPath(session.id, 'natural'),
        successor: successorFact(session.id, 3),
        fired: () => {
          injectionFired = true
        },
      }
      // The first installer holds the per-ID lock, so the sync call
      // takes the ELOCKED fallback and adopts the pending publish.
      registry.recordBackgroundSessionNaturalTerminationSync(
        session.id,
        { exitCode: 3 },
        { ownerPid: session.pid, expectedSession: session },
      )
      expect(injectionFired).toBe(true)
      expect(
        await registry.resolveBackgroundSessionForWait(session.id),
      ).toMatchObject({ status: 'failed', exitCode: 3 })
      expect(await storedExitCode(session.id)).toBe(3)
      releaseHook?.()
      const first = await asyncTermination
      // The resumed installer must not replace the published fact.
      expect(first).toMatchObject({ status: 'failed', exitCode: 3 })
      expect(
        await registry.resolveBackgroundSessionForWait(session.id),
      ).toMatchObject({ status: 'failed', exitCode: 3 })
      expect(await storedExitCode(session.id)).toBe(3)
    } finally {
      commitInjection = undefined
      registry._setTerminalFactPublishHookForTesting(undefined)
      releaseHook?.()
      await asyncTermination.catch(() => {})
    }
  })

  it('keeps the successor fact when the sync fallback adopts after it was published without hard links', async () => {
    // Same sync-adopt race as the test above, but with linkSync()
    // rejected (EPERM): the sync commit falls back to renameSync(),
    // which overwrites the successor fact, and the readback matches
    // the adopter's own bytes — so without an exclusive fallback the
    // adopter replaces the published fact (CodeRabbit #2497 review
    // 5945720742).
    const session = await registry.createBackgroundSession({
      id: 'bg-commit-race-sync-no-link',
      pid: 424242,
      cwd: '/repo',
      command: ['sleep', '30'],
      sessionId: 'sess-commit-race-sync-no-link',
      processMarker: TEST_PROCESS_MARKER,
    })
    let releaseHook: (() => void) | undefined
    let hookReachedResolve: (() => void) | undefined
    const hookReached = new Promise<void>(resolve => {
      hookReachedResolve = resolve
    })
    const hookGate = new Promise<void>(resolve => {
      releaseHook = resolve
    })
    registry._setTerminalFactPublishHookForTesting(async () => {
      hookReachedResolve?.()
      await hookGate
    })
    const asyncTermination =
      registry.recordBackgroundSessionNaturalTermination(
        session.id,
        { exitCode: 0 },
        { ownerPid: session.pid, expectedSession: session },
      )
    asyncTermination.catch(() => {})
    try {
      await hookReached
      let injectionFired = false
      commitInjection = {
        target: terminalFactPath(session.id, 'natural'),
        successor: successorFact(session.id, 3),
        fired: () => {
          injectionFired = true
        },
      }
      linkUnsupported = true
      // The first installer holds the per-ID lock, so the sync call
      // takes the ELOCKED fallback and adopts the pending publish.
      registry.recordBackgroundSessionNaturalTerminationSync(
        session.id,
        { exitCode: 3 },
        { ownerPid: session.pid, expectedSession: session },
      )
      expect(injectionFired).toBe(true)
      expect(
        await registry.resolveBackgroundSessionForWait(session.id),
      ).toMatchObject({ status: 'failed', exitCode: 3 })
      expect(await storedExitCode(session.id)).toBe(3)
      // Let the resumed async installer commit through the normal
      // link() path (linkUnsupported cleared below): it must not
      // replace the published fact either.
      linkUnsupported = false
      releaseHook?.()
      const first = await asyncTermination
      expect(first).toMatchObject({ status: 'failed', exitCode: 3 })
      expect(
        await registry.resolveBackgroundSessionForWait(session.id),
      ).toMatchObject({ status: 'failed', exitCode: 3 })
      expect(await storedExitCode(session.id)).toBe(3)
    } finally {
      commitInjection = undefined
      linkUnsupported = false
      registry._setTerminalFactPublishHookForTesting(undefined)
      releaseHook?.()
      await asyncTermination.catch(() => {})
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
    {
      name: 'keeps the first publisher metadata when a second create commits after it',
      run: async () => {
    // Regression test for maintainer review 5942761094 (P2) on #2497:
    // a second create whose duplicate check ran before the first commit
    // must not replace the first publisher's metadata row. The
    // per-ID lock is aged past the stale threshold (a clock jump), as
    // in the review's probe, and both creates use caller-owned
    // precreated logs so the duplicate-ID check — not log creation —
    // decides the outcome. The commit-pause mock orders the commits:
    // the first create commits first, the second create's commit then
    // lands on the published row. The first publisher must win (base
    // behavior): the second create is rejected and the stored PID is
    // the first publisher's.
    const id = 'bg-commit-race-create'
    const logDir = join(configDir, 'bg-commit-race-create-logs')
    await mkdir(logDir, { recursive: true })
    const stdoutLogPath = join(logDir, 'stdout.log')
    const stderrLogPath = join(logDir, 'stderr.log')
    await writeFile(stdoutLogPath, '')
    await writeFile(stderrLogPath, '')
    const commits: Array<{ release: () => void }> = []
    commitPause = {
      target: metadataPath(id),
      onPaused: control => {
        commits.push(control)
      },
    }
    const firstCreate = registry.createBackgroundSession({
      id,
      pid: 424243,
      cwd: '/repo',
      command: ['sleep', '30'],
      sessionId: 'sess-commit-race-create',
      logFilesPrecreated: true,
      stdoutLogPath,
      stderrLogPath,
    })
    firstCreate.catch(() => {})
    try {
      await awaitCommitPaused(commits, 0)
      // The first create holds the per-ID lock: age it past the stale
      // threshold so the second create can proceed while the first is
      // paused mid-publish.
      await ageSessionLock(id)
      const secondCreate = registry.createBackgroundSession({
        id,
        pid: 424242,
        cwd: '/repo',
        command: ['sleep', '30'],
        sessionId: 'sess-commit-race-create-2',
        logFilesPrecreated: true,
        stdoutLogPath,
        stderrLogPath,
      })
      secondCreate.catch(() => {})
      await awaitCommitPaused(commits, 1)
      // The first create commits first...
      commits[0]!.release()
      const first = await firstCreate
      expect(first.pid).toBe(424243)
      // ...then the second create's commit lands on the published row.
      commits[1]!.release()
      await expect(secondCreate).rejects.toThrow('already exists')
      const stored = await registry.readBackgroundSessionForOwner(id)
      expect(stored?.pid).toBe(424243)
    } finally {
      commitPause = undefined
      for (const commit of commits) commit.release()
      await firstCreate.catch(() => {})
    }
      },
    },
    {
      name: 'keeps the first publisher metadata when a second create commits after it without hard links',
      run: async () => {
    // Same duplicate-create race as the scenario above, but with
    // link() rejected (EPERM): the commit falls back to rename(),
    // which overwrites the first publisher's row, and the readback
    // matches the second creator's own bytes — so without an
    // exclusive fallback both creates succeed instead of rejecting
    // the duplicate (CodeRabbit #2497 review 5945720742). The
    // fallback must preserve exclusive publication without hard
    // links.
    const id = 'bg-commit-race-create-no-link'
    const logDir = join(configDir, 'bg-commit-race-create-no-link-logs')
    await mkdir(logDir, { recursive: true })
    const stdoutLogPath = join(logDir, 'stdout.log')
    const stderrLogPath = join(logDir, 'stderr.log')
    await writeFile(stdoutLogPath, '')
    await writeFile(stderrLogPath, '')
    const commits: Array<{ release: () => void }> = []
    linkUnsupported = true
    commitPause = {
      target: metadataPath(id),
      onPaused: control => {
        commits.push(control)
      },
    }
    const firstCreate = registry.createBackgroundSession({
      id,
      pid: 424243,
      cwd: '/repo',
      command: ['sleep', '30'],
      sessionId: 'sess-commit-race-create-no-link',
      logFilesPrecreated: true,
      stdoutLogPath,
      stderrLogPath,
    })
    firstCreate.catch(() => {})
    try {
      await awaitCommitPaused(commits, 0)
      // The first create holds the per-ID lock: age it past the stale
      // threshold so the second create can proceed while the first is
      // paused mid-publish.
      await ageSessionLock(id)
      const secondCreate = registry.createBackgroundSession({
        id,
        pid: 424242,
        cwd: '/repo',
        command: ['sleep', '30'],
        sessionId: 'sess-commit-race-create-no-link-2',
        logFilesPrecreated: true,
        stdoutLogPath,
        stderrLogPath,
      })
      secondCreate.catch(() => {})
      // Wait until the second create has entered the commit — its
      // link() call — so it is inside the fallback, past its
      // duplicate check, while the first create is still paused
      // before its rename.
      await awaitLinkCalls(metadataPath(id), 2)
      // The first create commits first...
      commits[0]!.release()
      const first = await firstCreate
      expect(first.pid).toBe(424243)
      // ...then the second create's commit lands on the published row.
      // Without the exclusive fallback its rename is paused here too,
      // so release any recorded commit before awaiting it.
      for (const commit of commits) commit.release()
      await expect(secondCreate).rejects.toThrow('already exists')
      const stored = await registry.readBackgroundSessionForOwner(id)
      expect(stored?.pid).toBe(424243)
    } finally {
      linkUnsupported = false
      commitPause = undefined
      for (const commit of commits) commit.release()
      await firstCreate.catch(() => {})
    }
      },
    },
    {
      name: 'keeps the first publisher metadata when a stalled holder loses its commit claim without hard links',
      run: async () => {
    // Regression test for maintainer review 5948202472 (P2) on #2497:
    // with link() rejected (EPERM), a session create that stalls past
    // the stale threshold after claiming `<target>.commit` loses its
    // claim to a second create, which publishes first. The stalled
    // holder's resumed rename must not overwrite the first
    // publisher's row: the holder re-verifies claim ownership
    // immediately before the rename and reports the duplicate
    // instead. The first publisher (second create, pid 424242) wins.
    const id = 'bg-commit-race-stale-create-no-link'
    const logDir = join(configDir, 'bg-commit-race-stale-create-no-link-logs')
    await mkdir(logDir, { recursive: true })
    const stdoutLogPath = join(logDir, 'stdout.log')
    const stderrLogPath = join(logDir, 'stderr.log')
    await writeFile(stdoutLogPath, '')
    await writeFile(stderrLogPath, '')
    linkUnsupported = true
    const { entered, release } = armCommitHookPause()
    const firstCreate = registry.createBackgroundSession({
      id,
      pid: 424243,
      cwd: '/repo',
      command: ['sleep', '30'],
      sessionId: 'sess-commit-race-stale-create-no-link',
      logFilesPrecreated: true,
      stdoutLogPath,
      stderrLogPath,
    })
    firstCreate.catch(() => {})
    try {
      await awaitCommitHookEntered(entered)
      // The first create holds the per-ID lock and the commit claim:
      // age both past their stale thresholds so the second create can
      // proceed and reclaim the claim while the first is paused
      // between its target recheck and its rename.
      await ageSessionLock(id)
      await ageCommitClaim(metadataPath(id))
      const secondCreate = registry.createBackgroundSession({
        id,
        pid: 424242,
        cwd: '/repo',
        command: ['sleep', '30'],
        sessionId: 'sess-commit-race-stale-create-no-link-2',
        logFilesPrecreated: true,
        stdoutLogPath,
        stderrLogPath,
      })
      const second = await secondCreate
      expect(second.pid).toBe(424242)
      // The resumed holder must not overwrite the first publisher.
      release()
      await expect(firstCreate).rejects.toThrow('already exists')
      const stored = await registry.readBackgroundSessionForOwner(id)
      expect(stored?.pid).toBe(424242)
    } finally {
      linkUnsupported = false
      release()
      await firstCreate.catch(() => {})
    }
      },
    },
    {
      name: 'keeps the first publisher fact when a stalled holder loses its commit claim without hard links',
      run: async () => {
    // Regression test for maintainer review 5948202472 (P2) on #2497:
    // same stale-commit-claim race as the metadata scenario, but for a
    // terminal fact. The holder (exitCode 0) stalls between its target
    // recheck and its rename; the successor (exitCode 3) must publish
    // its own fact, not adopt the holder's tmp — so the holder's
    // terminal-fact claim is withdrawn first (as an adopter does when
    // the pointer is unreadable), letting the successor claim the
    // publish itself. The holder's resumed rename must not overwrite
    // the successor's fact, and the holder must return it.
    const session = await registry.createBackgroundSession({
      id: 'bg-commit-race-stale-fact-no-link',
      pid: 424242,
      cwd: '/repo',
      command: ['sleep', '30'],
      sessionId: 'sess-commit-race-stale-fact-no-link',
      processMarker: TEST_PROCESS_MARKER,
    })
    linkUnsupported = true
    const { entered, release } = armCommitHookPause()
    const firstTermination =
      registry.recordBackgroundSessionNaturalTermination(
        session.id,
        { exitCode: 0 },
        { ownerPid: session.pid, expectedSession: session },
      )
    firstTermination.catch(() => {})
    try {
      await awaitCommitHookEntered(entered)
      // Withdraw the holder's terminal-fact claim and age its commit
      // claim, so the successor claims the publish itself (with its
      // own fact) instead of adopting the holder's tmp; age the
      // per-ID lock so the successor can proceed while the holder is
      // paused.
      await rm(`${terminalFactPath(session.id, 'natural')}.claim`, {
        force: true,
        recursive: true,
      })
      await ageCommitClaim(terminalFactPath(session.id, 'natural'))
      await ageSessionLock(session.id)
      const secondTermination =
        await registry.recordBackgroundSessionNaturalTermination(
          session.id,
          { exitCode: 3 },
          { ownerPid: session.pid, expectedSession: session },
        )
      expect(secondTermination).toMatchObject({
        status: 'failed',
        exitCode: 3,
      })
      // The resumed holder must not overwrite the first publisher.
      release()
      const first = await firstTermination
      expect(first).toMatchObject({ status: 'failed', exitCode: 3 })
      expect(await storedExitCode(session.id)).toBe(3)
    } finally {
      linkUnsupported = false
      release()
      await firstTermination.catch(() => {})
    }
      },
    },
    {
      name: 'keeps the first publisher fact when a stalled holder loses its sync commit claim without hard links',
      run: async () => {
    // Same stale-commit-claim race as the async fact scenario, but
    // through the synchronous exit fallback: the holder is a sync
    // termination paused at its commit, and the successor is a second
    // sync termination run from inside the sync commit hook (the
    // holder's per-ID lock forces the ELOCKED fallback). The sync hook
    // withdraws the holder's terminal-fact claim and ages its commit
    // claim, then publishes the successor's fact inline; the resumed
    // holder must return the successor's fact, not overwrite it.
    const session = await registry.createBackgroundSession({
      id: 'bg-commit-race-stale-fact-sync-no-link',
      pid: 424242,
      cwd: '/repo',
      command: ['sleep', '30'],
      sessionId: 'sess-commit-race-stale-fact-sync-no-link',
      processMarker: TEST_PROCESS_MARKER,
    })
    linkUnsupported = true
    let calls = 0
    registry._setCommitPublishHookForTestingSync(() => {
      calls += 1
      if (calls !== 1) return
      const target = terminalFactPath(session.id, 'natural')
      realFs.rmSync(`${target}.claim`, { force: true, recursive: true })
      const stale = new Date(Date.now() - 11_000)
      realFs.utimesSync(`${target}.commit`, stale, stale)
      // The holder's per-ID lock is held, so this sync termination
      // takes the ELOCKED fallback and publishes without it.
      registry.recordBackgroundSessionNaturalTerminationSync(
        session.id,
        { exitCode: 3 },
        { ownerPid: session.pid, expectedSession: session },
      )
    })
    try {
      registry.recordBackgroundSessionNaturalTerminationSync(
        session.id,
        { exitCode: 0 },
        { ownerPid: session.pid, expectedSession: session },
      )
      expect(await storedExitCode(session.id)).toBe(3)
      expect(
        await registry.resolveBackgroundSessionForWait(session.id),
      ).toMatchObject({ status: 'failed', exitCode: 3 })
    } finally {
      linkUnsupported = false
      registry._setCommitPublishHookForTestingSync(undefined)
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
