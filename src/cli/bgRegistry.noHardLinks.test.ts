import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
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
