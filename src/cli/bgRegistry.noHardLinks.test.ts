import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Regression tests for CodeRabbit #2497 (review 5825606005):
 * writeNewSession published new sessions with link(), which fails on
 * filesystems that reject hard links (EPERM/ENOSYS/EOPNOTSUPP), so
 * `openclaude --bg` failed and terminated the child there. Session
 * creation must work without hard links while keeping atomic visibility
 * and duplicate-ID protection.
 *
 * The filesystem is simulated by making every link() call fail with
 * EPERM; the registry module is imported after the mock is registered so
 * it binds the mocked link.
 */

// Capture the real implementation before any mock.module call: Bun's
// mock.module mutates the shared node:fs/promises namespace object, so a
// later import returns the mock — capturing the module object alone does
// not preserve the real link(). These bindings are plain values, not live
// module bindings, so the mock cannot rewrite them (CodeRabbit #2497).
const realFsPromises = await import('node:fs/promises')
const realLink = realFsPromises.link
const realFs = await import('node:fs')
const realLinkSync = realFs.linkSync

describe('background session creation without hard links', () => {
  let configDir: string
  let registry: typeof import('./bgRegistry.js')

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'openclaude-bg-no-hardlink-'))
    const linkError = Object.assign(
      new Error('Operation not permitted'),
      { code: 'EPERM' },
    )
    mock.module('node:fs/promises', () => ({
      ...realFsPromises,
      link: async () => {
        throw linkError
      },
    }))
    registry = await import('./bgRegistry.js')
    registry._setBackgroundSessionsRootForTesting(
      join(configDir, 'bg-sessions'),
    )
  })

  afterEach(async () => {
    mock.restore()
    // mock.restore() does NOT undo a mock.module registration: the mocked
    // link() leaked into test files loaded later in the same Bun process
    // (verified: a later file's real link() threw this mock's EPERM).
    // Re-register the real module explicitly so later files bind the
    // unmocked implementation again (CodeRabbit #2497).
    mock.module('node:fs/promises', () => ({
      ...realFsPromises,
      link: realLink,
    }))
    registry?._setBackgroundSessionsRootForTesting(undefined)
    await rm(configDir, { force: true, recursive: true })
  })

  it('the link() mock is active while these tests run', async () => {
    // Guards the regression tests below: if the mock silently stopped
    // applying, session creation would no longer be proven link-free.
    const fsPromises = await import('node:fs/promises')
    await expect(fsPromises.link('x', 'y')).rejects.toThrow(
      'Operation not permitted',
    )
  })

  it('creates a session when link() is rejected', async () => {
    const session = await registry.createBackgroundSession({
      id: 'bg-no-link-1',
      pid: 424242,
      cwd: '/repo',
      command: ['sleep', '30'],
      sessionId: 'sess-no-link-1',
    })
    expect(session.id).toBe('bg-no-link-1')
    const listed = await registry.listBackgroundSessions()
    expect(listed.map(entry => entry.id)).toContain('bg-no-link-1')
  })

  it('still rejects a duplicate session id when link() is rejected', async () => {
    await registry.createBackgroundSession({
      id: 'bg-no-link-dup',
      pid: 424242,
      cwd: '/repo',
      command: ['sleep', '30'],
      sessionId: 'sess-no-link-dup',
    })
    await expect(
      registry.createBackgroundSession({
        id: 'bg-no-link-dup',
        pid: 424243,
        cwd: '/repo',
        command: ['sleep', '30'],
        sessionId: 'sess-no-link-dup-2',
      }),
    ).rejects.toThrow('already exists')
    expect(await registry.listBackgroundSessions()).toHaveLength(1)
  })
})

/**
 * Regression tests for maintainer review 5830922741 on #2497:
 * installTerminalFact / installTerminalFactSync still published terminal
 * facts with link() / linkSync(), so on filesystems that reject hard links
 * natural/kill finalization threw and no authoritative terminal fact was
 * installed — `openclaude wait` then reported stale (exit 1) or timeout
 * (exit 124) instead of the real child exit code. Terminal facts must
 * publish with the same temp + sync + rename() duplicate-guard pattern
 * as writeNewSession, for both the async and the sync installer.
 *
 * Both link() and linkSync() fail with EPERM here; the registry module is
 * imported after the mocks are registered so it binds the mocked
 * functions (same mechanism as the creation tests above).
 */
describe('background session terminal facts without hard links', () => {
  let configDir: string
  let registry: typeof import('./bgRegistry.js')

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'openclaude-bg-no-hardlink-'))
    const linkError = Object.assign(
      new Error('Operation not permitted'),
      { code: 'EPERM' },
    )
    mock.module('node:fs/promises', () => ({
      ...realFsPromises,
      link: async () => {
        throw linkError
      },
    }))
    mock.module('node:fs', () => ({
      ...realFs,
      linkSync: () => {
        throw linkError
      },
    }))
    registry = await import('./bgRegistry.js')
    registry._setBackgroundSessionsRootForTesting(
      join(configDir, 'bg-sessions'),
    )
  })

  afterEach(async () => {
    mock.restore()
    // See the creation tests above: mock.restore() does not undo a
    // mock.module registration, so re-register both real modules.
    mock.module('node:fs/promises', () => ({
      ...realFsPromises,
      link: realLink,
    }))
    mock.module('node:fs', () => ({
      ...realFs,
      linkSync: realLinkSync,
    }))
    registry?._setBackgroundSessionsRootForTesting(undefined)
    await rm(configDir, { force: true, recursive: true })
  })

  it('the linkSync() mock is active while these tests run', async () => {
    // Guards the sync regression test below: if the mock silently stopped
    // applying, the sync installer would no longer be proven link-free.
    const fs = await import('node:fs')
    expect(() => fs.linkSync('x', 'y')).toThrow('Operation not permitted')
  })

  it('publishes a natural terminal fact when link() is rejected', async () => {
    const session = await registry.createBackgroundSession({
      id: 'bg-no-link-fact-1',
      pid: 424242,
      cwd: '/repo',
      command: ['sleep', '30'],
      sessionId: 'sess-no-link-fact-1',
    })
    const terminated =
      await registry.recordBackgroundSessionNaturalTermination(
        session.id,
        { exitCode: 0 },
        { ownerPid: session.pid },
      )
    expect(terminated).toMatchObject({ status: 'exited', exitCode: 0 })
    // `wait` reads through the same strict selector: it must see the
    // terminal fact and the real child exit code, not stale/timeout.
    const forWait = await registry.resolveBackgroundSessionForWait(session.id)
    expect(forWait).toMatchObject({ status: 'exited', exitCode: 0 })
  })

  it('publishes a killed terminal fact when link() is rejected', async () => {
    const session = await registry.createBackgroundSession({
      id: 'bg-no-link-fact-killed',
      pid: 424242,
      cwd: '/repo',
      command: ['sleep', '30'],
      sessionId: 'sess-no-link-fact-killed',
    })
    const killed = await registry.markBackgroundSessionKilled(session.id)
    expect(killed).toMatchObject({ status: 'killed' })
    const forWait = await registry.resolveBackgroundSessionForWait(session.id)
    expect(forWait).toMatchObject({ status: 'killed' })
  })

  it('publishes a natural terminal fact from the sync installer when linkSync() is rejected', async () => {
    const session = await registry.createBackgroundSession({
      id: 'bg-no-link-fact-sync',
      pid: 424242,
      cwd: '/repo',
      command: ['sleep', '30'],
      sessionId: 'sess-no-link-fact-sync',
    })
    registry.recordBackgroundSessionNaturalTerminationSync(
      session.id,
      { exitCode: 3 },
      { ownerPid: session.pid },
    )
    const forWait = await registry.resolveBackgroundSessionForWait(session.id)
    expect(forWait).toMatchObject({ status: 'failed', exitCode: 3 })
  })

  it('does not overwrite an already-published terminal fact when link() is rejected', async () => {
    // Duplicate-guard semantics of the old link() EEXIST path, preserved
    // by the rename() pre-check: a second install returns the existing
    // fact instead of overwriting it. The pre-existing fact belongs to
    // another PID, so it is ignored by the terminal-fact reader and the
    // session stays running — but the file itself must be untouched.
    const session = await registry.createBackgroundSession({
      id: 'bg-no-link-fact-dup',
      pid: 424242,
      cwd: '/repo',
      command: ['sleep', '30'],
      sessionId: 'sess-no-link-fact-dup',
    })
    const factPath = join(
      configDir,
      'bg-sessions',
      'terminal',
      'bg-no-link-fact-dup.natural.json',
    )
    const existingFact = JSON.stringify({
      version: 1,
      id: 'bg-no-link-fact-dup',
      pid: 999999,
      status: 'failed',
      finishedAt: '2026-11-09T00:00:00.000Z',
      terminalReason: 'exit_code',
      exitCode: 7,
    })
    await writeFile(factPath, existingFact)
    const result = await registry.recordBackgroundSessionNaturalTermination(
      session.id,
      { exitCode: 0 },
      { ownerPid: session.pid },
    )
    expect(await readFile(factPath, 'utf8')).toBe(existingFact)
    expect(result.status).toBe('running')
  })
})
