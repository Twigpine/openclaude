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
describe('background session creation without hard links', () => {
  let configDir: string
  let registry: typeof import('./bgRegistry.js')

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'openclaude-bg-no-hardlink-'))
    const fsPromises = await import('node:fs/promises')
    const linkError = Object.assign(
      new Error('Operation not permitted'),
      { code: 'EPERM' },
    )
    mock.module('node:fs/promises', () => ({
      ...fsPromises,
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
    registry?._setBackgroundSessionsRootForTesting(undefined)
    await rm(configDir, { force: true, recursive: true })
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
