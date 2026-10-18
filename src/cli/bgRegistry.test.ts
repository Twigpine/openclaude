import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as lockfile from '../utils/lockfile.js'
import * as backgroundSessionRegistry from './bgRegistry.js'
import {
  _setBackgroundSessionsRootForTesting,
  cleanupBackgroundSessionsBefore,
  createBackgroundSession,
  isBackgroundSessionProcessAlive,
  isTerminalBackgroundSession,
  listBackgroundSessions,
  markBackgroundSessionKilled,
  readBackgroundSessionForOwner,
  refreshBackgroundSessionStatuses,
  resolveBackgroundSession,
  snapshotBackgroundSessionRecoveryJournal,
  takeBackgroundSessionRecoveryBatch,
  verifyBackgroundSessionProcessIdentity,
  type BackgroundSession,
} from './bgRegistry.js'

const TEST_PROCESS_MARKER = 'a'.repeat(64)
const OTHER_PROCESS_MARKER = 'b'.repeat(64)
// Keep this test-only constructor available on the pre-marker base so the
// marker-authoritative regression can prove red there. Production identity
// constructs its expected token independently, so token-format drift still
// fails the marked-match tests below.
const backgroundProcessMarkerToken = (marker: string) =>
  `--openclaude-bg-session-marker=${marker}`

const {
  reconcileBackgroundSessionTerminalFacts,
  recordBackgroundSessionNaturalTermination,
  recordBackgroundSessionNaturalTerminationSync,
} = backgroundSessionRegistry

type Assert<T extends true> = T
type IsEqual<A, B> = (<T>() => T extends A ? 1 : 2) extends <
  T,
>() => T extends B ? 1 : 2
  ? true
  : false

type _ResolveBackgroundSessionParametersAreTargetOnly = Assert<
  IsEqual<Parameters<typeof resolveBackgroundSession>, [target: string]>
>

describe('background session registry', () => {
  let configDir: string

  function nameReservationPath(name: string): string {
    const digest = createHash('sha256').update(name).digest('hex')
    return join(configDir, 'bg-sessions', 'names', `${digest}.json`)
  }

  function terminalFactPath(
    id: string,
    kind: 'natural' | 'killed',
    generation?: string,
  ): string {
    const generationSuffix = generation ? `~${generation}` : ''
    return join(
      configDir,
      'bg-sessions',
      'terminal',
      `${id}${generationSuffix}.${kind}.json`,
    )
  }

  async function writeTerminalFact(
    id: string,
    kind: 'natural' | 'killed',
    fact: Record<string, unknown>,
  ): Promise<void> {
    await mkdir(join(configDir, 'bg-sessions', 'terminal'), {
      recursive: true,
    })
    await writeFile(
      terminalFactPath(id, kind),
      JSON.stringify({ version: 1, id, ...fact }),
    )
  }

  async function writeNameReservation(
    name: string,
    reservation: {
      id: string
      creatorPid?: number
      createdAt?: string
    },
  ): Promise<void> {
    await mkdir(join(configDir, 'bg-sessions', 'names'), { recursive: true })
    await writeFile(
      nameReservationPath(name),
      JSON.stringify({ name, ...reservation }),
    )
  }

  async function snapshotRegistryTree(
    root: string,
    relative = '',
  ): Promise<string[]> {
    const current = join(root, relative)
    const entries = await readdir(current, { withFileTypes: true })
    const snapshot: string[] = []
    for (const entry of entries.toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const entryRelative = join(relative, entry.name)
      if (entry.isDirectory()) {
        snapshot.push(`${entryRelative}/`)
        snapshot.push(...(await snapshotRegistryTree(root, entryRelative)))
        continue
      }
      const path = join(root, entryRelative)
      const metadata = await stat(path, { bigint: true })
      snapshot.push(
        `${entryRelative}:${metadata.mtimeNs}:${await readFile(path, 'utf8')}`,
      )
    }
    return snapshot
  }

  async function resolveWithListCallCount(target: string): Promise<{
    session: BackgroundSession
    listCalls: number
  }> {
    let listCalls = 0
    const session =
      await backgroundSessionRegistry.__test.resolveBackgroundSessionWithList(
        target,
        async () => {
          listCalls += 1
          return await listBackgroundSessions()
        },
      )
    return { session, listCalls }
  }

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'openclaude-bg-registry-'))
    _setBackgroundSessionsRootForTesting(join(configDir, 'bg-sessions'))
  })

  afterEach(async () => {
    _setBackgroundSessionsRootForTesting(undefined)
    await rm(configDir, { force: true, recursive: true })
  })

  it('keeps the exported resolver signature free of test dependencies', () => {
    expect(resolveBackgroundSession.length).toBe(1)
  })

  it('creates session metadata and log files under the OpenClaude config dir', async () => {
    const session = await createBackgroundSession({
      id: 'bg-test-1',
      name: 'auth-refactor',
      pid: 12345,
      cwd: '/repo',
      command: [
        'openclaude',
        backgroundProcessMarkerToken(TEST_PROCESS_MARKER),
        '--print',
        'refactor auth',
      ],
      provider: 'openai',
      model: 'gpt-5',
      sessionId: 'conversation-1',
      processMarker: TEST_PROCESS_MARKER,
      now: new Date('2026-06-15T08:00:00.000Z'),
    })

    expect(session).toMatchObject({
      id: 'bg-test-1',
      name: 'auth-refactor',
      pid: 12345,
      cwd: '/repo',
      status: 'running',
      provider: 'openai',
      model: 'gpt-5',
      sessionId: 'conversation-1',
      processMarker: TEST_PROCESS_MARKER,
      terminalFactGeneration: TEST_PROCESS_MARKER,
      startedAt: '2026-06-15T08:00:00.000Z',
      updatedAt: '2026-06-15T08:00:00.000Z',
      command: [
        'openclaude',
        backgroundProcessMarkerToken(TEST_PROCESS_MARKER),
        '--print',
        'refactor auth',
      ],
    })
    expect(session.stdoutLogPath).toBe(
      join(configDir, 'bg-sessions', 'logs', 'bg-test-1.out.log'),
    )
    expect(session.stderrLogPath).toBe(
      join(configDir, 'bg-sessions', 'logs', 'bg-test-1.err.log'),
    )

    const sessions = await listBackgroundSessions()
    expect(sessions.map(s => s.id)).toEqual(['bg-test-1'])
    expect(sessions[0]?.processMarker).toBe(TEST_PROCESS_MARKER)
  })

  it('loads legacy session metadata without a process marker', async () => {
    await mkdir(join(configDir, 'bg-sessions', 'sessions'), {
      recursive: true,
    })
    await writeFile(
      join(configDir, 'bg-sessions', 'sessions', 'bg-legacy.json'),
      JSON.stringify({
        id: 'bg-legacy',
        pid: 123,
        cwd: '/repo',
        status: 'running',
        sessionId: 'conversation-legacy',
        startedAt: '2026-06-15T08:00:00.000Z',
        updatedAt: '2026-06-15T08:00:00.000Z',
        command: ['openclaude', '--print', 'work'],
        stdoutLogPath: '/tmp/stdout.log',
        stderrLogPath: '/tmp/stderr.log',
      }),
    )

    const [session] = await listBackgroundSessions()
    expect(session?.id).toBe('bg-legacy')
    expect(session?.processMarker).toBeUndefined()
    expect(session?.terminalFactGeneration).toBeUndefined()
  })

  it('rejects malformed process markers on creation', async () => {
    await expect(
      createBackgroundSession({
        id: 'bg-invalid-marker',
        pid: 123,
        cwd: '/repo',
        command: ['openclaude', '--print', 'work'],
        sessionId: 'conversation-invalid-marker',
        processMarker: 'not-valid',
      }),
    ).rejects.toThrow('Invalid background process marker')

    expect(await listBackgroundSessions()).toEqual([])
  })

  it('ignores metadata containing malformed process markers', async () => {
    await mkdir(join(configDir, 'bg-sessions', 'sessions'), {
      recursive: true,
    })
    const invalidMarkers = [
      '',
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64),
      `${'a'.repeat(63)} `,
      `${'a'.repeat(63)}/`,
      `${'a'.repeat(63)};`,
      `${'a'.repeat(63)}\u0000`,
    ]

    await Promise.all(
      invalidMarkers.map(async (processMarker, index) => {
        const id = `bg-invalid-marker-${index}`
        await writeFile(
          join(configDir, 'bg-sessions', 'sessions', `${id}.json`),
          JSON.stringify({
            id,
            pid: 123 + index,
            cwd: '/repo',
            status: 'running',
            sessionId: `conversation-${index}`,
            processMarker,
            startedAt: '2026-06-15T08:00:00.000Z',
            updatedAt: '2026-06-15T08:00:00.000Z',
            command: ['openclaude', '--print', 'work'],
            stdoutLogPath: '/tmp/stdout.log',
            stderrLogPath: '/tmp/stderr.log',
          }),
        )
      }),
    )
    await writeFile(
      join(
        configDir,
        'bg-sessions',
        'sessions',
        'bg-mismatched-terminal-generation.json',
      ),
      JSON.stringify({
        id: 'bg-mismatched-terminal-generation',
        pid: 999,
        cwd: '/repo',
        status: 'running',
        sessionId: 'conversation-mismatched-terminal-generation',
        processMarker: TEST_PROCESS_MARKER,
        terminalFactGeneration: OTHER_PROCESS_MARKER,
        startedAt: '2026-06-15T08:00:00.000Z',
        updatedAt: '2026-06-15T08:00:00.000Z',
        command: ['openclaude', '--print', 'work'],
        stdoutLogPath: '/tmp/stdout.log',
        stderrLogPath: '/tmp/stderr.log',
      }),
    )

    expect(await listBackgroundSessions()).toEqual([])
  })

  it('resolves exact live names before session id prefixes', async () => {
    await createBackgroundSession({
      id: 'bg-abcdef',
      pid: 111,
      cwd: '/repo',
      command: ['openclaude', '--print', 'work'],
      sessionId: 'conversation-1',
    })
    await createBackgroundSession({
      id: 'bg-named',
      name: 'bg-abc',
      pid: 222,
      cwd: '/repo',
      command: ['openclaude', '--print', 'named'],
      sessionId: 'conversation-2',
    })

    const { session, listCalls } = await resolveWithListCallCount('bg-abc')
    expect(session.id).toBe('bg-named')
    expect(listCalls).toBe(1)
  })

  it('resolves exact session ids before exact session names', async () => {
    await createBackgroundSession({
      id: 'bg-target',
      pid: 111,
      cwd: '/repo',
      command: ['openclaude', '--print', 'id'],
      sessionId: 'conversation-id',
    })
    await createBackgroundSession({
      id: 'bg-named',
      name: 'bg-target',
      pid: 222,
      cwd: '/repo',
      command: ['openclaude', '--print', 'named'],
      sessionId: 'conversation-name',
    })

    const { session, listCalls } = await resolveWithListCallCount('bg-target')
    expect(session.id).toBe('bg-target')
    expect(listCalls).toBe(0)
  })

  it('resolves an exact session id without listing the metadata directory', async () => {
    await createBackgroundSession({
      id: 'bg-direct',
      pid: 111,
      cwd: '/repo',
      command: ['openclaude', '--print', 'direct'],
      sessionId: 'conversation-direct',
    })
    const metadataDir = join(configDir, 'bg-sessions', 'sessions')
    await writeFile(join(metadataDir, 'unrelated-malformed.json'), '{')

    const { session, listCalls } = await resolveWithListCallCount('bg-direct')
    expect(session.id).toBe('bg-direct')
    expect(listCalls).toBe(0)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'resolves an exact session id when directory enumeration is unavailable',
    async () => {
      await createBackgroundSession({
        id: 'bg-direct-unlisted',
        pid: 112,
        cwd: '/repo',
        command: ['openclaude', '--print', 'direct unlisted'],
        sessionId: 'conversation-direct-unlisted',
      })
      const metadataDir = join(configDir, 'bg-sessions', 'sessions')

      await chmod(metadataDir, 0o100)
      try {
        expect(
          (await resolveBackgroundSession('bg-direct-unlisted')).id,
        ).toBe('bg-direct-unlisted')
      } finally {
        await chmod(metadataDir, 0o700)
      }
    },
  )

  it('applies natural terminal facts on the direct exact-id path', async () => {
    await createBackgroundSession({
      id: 'bg-direct-natural',
      pid: 333,
      cwd: '/repo',
      command: ['openclaude', '--print', 'direct natural'],
      sessionId: 'conversation-direct-natural',
    })
    await writeTerminalFact('bg-direct-natural', 'natural', {
      pid: 333,
      status: 'failed',
      finishedAt: '2026-06-15T08:04:00.000Z',
      exitCode: 23,
      terminalReason: 'exit_code',
    })
    const { session, listCalls } = await resolveWithListCallCount(
      'bg-direct-natural',
    )

    expect(session).toMatchObject({
      status: 'failed',
      finishedAt: '2026-06-15T08:04:00.000Z',
      exitCode: 23,
      terminalReason: 'exit_code',
    })
    expect(listCalls).toBe(0)
  })

  it('keeps killed facts strongest on the direct exact-id path', async () => {
    await createBackgroundSession({
      id: 'bg-direct-killed',
      pid: 334,
      cwd: '/repo',
      command: ['openclaude', '--print', 'direct killed'],
      sessionId: 'conversation-direct-killed',
    })
    await writeTerminalFact('bg-direct-killed', 'natural', {
      pid: 334,
      status: 'failed',
      finishedAt: '2026-06-15T08:04:00.000Z',
      exitCode: 17,
      terminalReason: 'exit_code',
    })
    await writeTerminalFact('bg-direct-killed', 'killed', {
      pid: 334,
      status: 'killed',
      finishedAt: '2026-06-15T08:05:00.000Z',
      terminalReason: 'explicit_kill',
    })
    const { session, listCalls } = await resolveWithListCallCount(
      'bg-direct-killed',
    )

    expect(session).toMatchObject({
      status: 'killed',
      finishedAt: '2026-06-15T08:04:00.000Z',
      exitCode: 17,
      terminalReason: 'explicit_kill',
    })
    expect(listCalls).toBe(0)
  })

  it('falls back to an exact live name when exact-id metadata is malformed', async () => {
    await createBackgroundSession({
      id: 'bg-name-owner',
      name: 'bg-malformed',
      pid: 335,
      cwd: '/repo',
      command: ['openclaude', '--print', 'name owner'],
      sessionId: 'conversation-name-owner',
    })
    await writeFile(
      join(configDir, 'bg-sessions', 'sessions', 'bg-malformed.json'),
      '{',
    )

    const { session, listCalls } = await resolveWithListCallCount(
      'bg-malformed',
    )
    expect(session.id).toBe('bg-name-owner')
    expect(listCalls).toBe(1)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'falls back to an exact live name when exact-id metadata is unreadable',
    async () => {
      await createBackgroundSession({
        id: 'bg-unreadable',
        pid: 336,
        cwd: '/repo',
        command: ['openclaude', '--print', 'unreadable id'],
        sessionId: 'conversation-unreadable-id',
      })
      await createBackgroundSession({
        id: 'bg-unreadable-name-owner',
        name: 'bg-unreadable',
        pid: 337,
        cwd: '/repo',
        command: ['openclaude', '--print', 'unreadable name owner'],
        sessionId: 'conversation-unreadable-name-owner',
      })
      const exactPath = join(
        configDir,
        'bg-sessions',
        'sessions',
        'bg-unreadable.json',
      )

      await chmod(exactPath, 0o000)
      try {
        const { session, listCalls } = await resolveWithListCallCount(
          'bg-unreadable',
        )
        expect(session.id).toBe('bg-unreadable-name-owner')
        expect(listCalls).toBe(1)
      } finally {
        await chmod(exactPath, 0o600)
      }
    },
  )

  it('does not interpret unsafe exact-id candidates as metadata paths', async () => {
    const named = await createBackgroundSession({
      id: 'bg-safe-name-owner',
      name: '../outside',
      pid: 338,
      cwd: '/repo',
      command: ['openclaude', '--print', 'safe name owner'],
      sessionId: 'conversation-safe-name-owner',
    })
    await writeFile(
      join(configDir, 'bg-sessions', 'outside.json'),
      JSON.stringify({ ...named, id: 'outside' }),
    )

    expect((await resolveBackgroundSession('../outside')).id).toBe(
      'bg-safe-name-owner',
    )
  })

  it('does not write registry state while resolving an exact id', async () => {
    await createBackgroundSession({
      id: 'bg-read-only',
      pid: 339,
      cwd: '/repo',
      command: ['openclaude', '--print', 'read only'],
      sessionId: 'conversation-read-only',
    })
    const root = join(configDir, 'bg-sessions')
    const before = await snapshotRegistryTree(root)

    expect((await resolveBackgroundSession('bg-read-only')).id).toBe(
      'bg-read-only',
    )

    expect(await snapshotRegistryTree(root)).toEqual(before)
  })

  it('resolves unique session id prefixes when no exact name matches', async () => {
    await createBackgroundSession({
      id: 'bg-abcdef',
      name: 'named-session',
      pid: 111,
      cwd: '/repo',
      command: ['openclaude', '--print', 'work'],
      sessionId: 'conversation-1',
    })

    expect((await resolveBackgroundSession('bg-abcdef')).id).toBe('bg-abcdef')
    expect((await resolveBackgroundSession('bg-abc')).id).toBe('bg-abcdef')
    expect((await resolveBackgroundSession('named-session')).id).toBe(
      'bg-abcdef',
    )
  })

  it('rejects ambiguous session id prefixes', async () => {
    await createBackgroundSession({
      id: 'bg-prefix-one',
      pid: 111,
      cwd: '/repo',
      command: ['openclaude', '--print', 'one'],
      sessionId: 'conversation-1',
    })
    await createBackgroundSession({
      id: 'bg-prefix-two',
      pid: 222,
      cwd: '/repo',
      command: ['openclaude', '--print', 'two'],
      sessionId: 'conversation-2',
    })

    await expect(resolveBackgroundSession('bg-prefix')).rejects.toThrow(
      'ambiguous',
    )
  })

  it('preserves missing session target errors', async () => {
    await expect(resolveBackgroundSession('missing')).rejects.toThrow(
      'No background session found',
    )
  })

  it('resolves unique terminal session names', async () => {
    await createBackgroundSession({
      id: 'bg-old',
      name: 'old-name',
      pid: 111,
      cwd: '/repo',
      command: ['openclaude', '--print', 'old'],
      sessionId: 'conversation-old',
    })
    await markBackgroundSessionKilled('bg-old')

    expect((await resolveBackgroundSession('old-name')).id).toBe('bg-old')
  })

  it('rejects duplicate terminal session names as ambiguous', async () => {
    await createBackgroundSession({
      id: 'bg-old-one',
      name: 'old-shared',
      pid: 111,
      cwd: '/repo',
      command: ['openclaude', '--print', 'old-one'],
      sessionId: 'conversation-old-one',
    })
    await markBackgroundSessionKilled('bg-old-one')
    await createBackgroundSession({
      id: 'bg-old-two',
      name: 'old-shared',
      pid: 222,
      cwd: '/repo',
      command: ['openclaude', '--print', 'old-two'],
      sessionId: 'conversation-old-two',
    })
    await markBackgroundSessionKilled('bg-old-two')

    await expect(resolveBackgroundSession('old-shared')).rejects.toThrow(
      'Background session name "old-shared" is ambiguous',
    )
  })

  it('rejects duplicate live names before considering id prefixes', async () => {
    await mkdir(join(configDir, 'bg-sessions', 'sessions'), {
      recursive: true,
    })
    const base = {
      cwd: '/repo',
      status: 'running',
      startedAt: '2026-06-15T08:00:00.000Z',
      updatedAt: '2026-06-15T08:00:00.000Z',
      command: ['openclaude', '--print', 'work'],
      stdoutLogPath: '/tmp/stdout.log',
      stderrLogPath: '/tmp/stderr.log',
    }
    await writeFile(
      join(configDir, 'bg-sessions', 'sessions', 'bg-live-one.json'),
      JSON.stringify({
        ...base,
        id: 'bg-live-one',
        name: 'bg-abc',
        pid: 111,
        sessionId: 'conversation-live-one',
      }),
    )
    await writeFile(
      join(configDir, 'bg-sessions', 'sessions', 'bg-live-two.json'),
      JSON.stringify({
        ...base,
        id: 'bg-live-two',
        name: 'bg-abc',
        pid: 222,
        sessionId: 'conversation-live-two',
      }),
    )
    await createBackgroundSession({
      id: 'bg-abcdef',
      pid: 333,
      cwd: '/repo',
      command: ['openclaude', '--print', 'prefix'],
      sessionId: 'conversation-prefix',
    })

    await expect(resolveBackgroundSession('bg-abc')).rejects.toThrow(
      'Background session name "bg-abc" is ambiguous',
    )
  })

  it('rejects duplicate names and reports ambiguous names', async () => {
    await createBackgroundSession({
      id: 'bg-one',
      name: 'shared',
      pid: 111,
      cwd: '/repo',
      command: ['openclaude', '--print', 'one'],
      sessionId: 'conversation-1',
    })

    await expect(
      createBackgroundSession({
        id: 'bg-two',
        name: 'shared',
        pid: 222,
        cwd: '/repo',
        command: ['openclaude', '--print', 'two'],
        sessionId: 'conversation-2',
      }),
    ).rejects.toThrow('already exists')
  })

  it('rejects concurrent duplicate live names atomically', async () => {
    const attempts = await Promise.allSettled([
      createBackgroundSession({
        id: 'bg-race-one',
        name: 'shared-race',
        pid: 111,
        cwd: '/repo',
        command: ['openclaude', '--print', 'one'],
        sessionId: 'conversation-1',
      }),
      createBackgroundSession({
        id: 'bg-race-two',
        name: 'shared-race',
        pid: 222,
        cwd: '/repo',
        command: ['openclaude', '--print', 'two'],
        sessionId: 'conversation-2',
      }),
    ])
    const fulfilled = attempts.filter(result => result.status === 'fulfilled')
    const rejected = attempts.find(result => result.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected?.status).toBe('rejected')
    if (!rejected || rejected.status !== 'rejected') {
      throw new Error('Expected one duplicate-name registration to fail')
    }
    expect(String(rejected.reason?.message ?? rejected.reason)).toContain(
      'already exists',
    )
    expect(
      (await listBackgroundSessions()).filter(
        session => session.name === 'shared-race',
      ),
    ).toHaveLength(1)
  })

  it('does not steal an in-flight name reservation from a live creator', async () => {
    await writeNameReservation('in-flight', {
      id: 'bg-in-flight',
      creatorPid: process.pid,
      createdAt: '2026-06-15T08:00:00.000Z',
    })

    await expect(
      createBackgroundSession({
        id: 'bg-contender',
        name: 'in-flight',
        pid: 222,
        cwd: '/repo',
        command: ['openclaude', '--print', 'contender'],
        sessionId: 'conversation-contender',
      }),
    ).rejects.toThrow('already exists')
    expect(await listBackgroundSessions()).toEqual([])
  })

  it('recovers orphaned name reservations whose owner metadata is missing', async () => {
    await writeNameReservation('orphaned', {
      id: 'bg-missing-owner',
      creatorPid: Number.MAX_SAFE_INTEGER,
      createdAt: '2026-06-15T08:00:00.000Z',
    })

    const session = await createBackgroundSession({
      id: 'bg-recovered',
      name: 'orphaned',
      pid: 222,
      cwd: '/repo',
      command: ['openclaude', '--print', 'recovered'],
      sessionId: 'conversation-recovered',
    })

    expect(session.name).toBe('orphaned')
    expect((await listBackgroundSessions()).map(s => s.id)).toEqual([
      'bg-recovered',
    ])
  })

  it('recovers name reservations owned by terminal sessions', async () => {
    await mkdir(join(configDir, 'bg-sessions', 'sessions'), {
      recursive: true,
    })
    await writeFile(
      join(configDir, 'bg-sessions', 'sessions', 'bg-terminal-owner.json'),
      JSON.stringify({
        id: 'bg-terminal-owner',
        name: 'terminal-name',
        pid: 111,
        cwd: '/repo',
        status: 'killed',
        sessionId: 'conversation-terminal',
        startedAt: '2026-06-15T08:00:00.000Z',
        updatedAt: '2026-06-15T08:05:00.000Z',
        command: ['openclaude', '--print', 'old'],
        stdoutLogPath: '/tmp/old-out.log',
        stderrLogPath: '/tmp/old-err.log',
      }),
    )
    await writeNameReservation('terminal-name', {
      id: 'bg-terminal-owner',
      creatorPid: process.pid,
      createdAt: '2026-06-15T08:00:00.000Z',
    })

    const session = await createBackgroundSession({
      id: 'bg-new-owner',
      name: 'terminal-name',
      pid: 222,
      cwd: '/repo',
      command: ['openclaude', '--print', 'new'],
      sessionId: 'conversation-new',
    })

    expect(session.name).toBe('terminal-name')
    expect((await resolveBackgroundSession('terminal-name')).id).toBe(
      'bg-new-owner',
    )
  })

  it('allows terminal session names to be reused and resolves the active match', async () => {
    await createBackgroundSession({
      id: 'bg-old',
      name: 'reuse-me',
      pid: 111,
      cwd: '/repo',
      command: ['openclaude', '--print', 'old'],
      sessionId: 'conversation-old',
    })
    await markBackgroundSessionKilled('bg-old')

    await createBackgroundSession({
      id: 'bg-new',
      name: 'reuse-me',
      pid: 222,
      cwd: '/repo',
      command: ['openclaude', '--print', 'new'],
      sessionId: 'conversation-new',
    })

    expect((await resolveBackgroundSession('reuse-me')).id).toBe('bg-new')
  })

  it('does not overwrite existing metadata on id collision', async () => {
    await createBackgroundSession({
      id: 'bg-collision',
      name: 'first',
      pid: 111,
      cwd: '/repo',
      command: ['openclaude', '--print', 'one'],
      sessionId: 'conversation-1',
    })

    await expect(
      createBackgroundSession({
        id: 'bg-collision',
        name: 'second',
        pid: 222,
        cwd: '/repo',
        command: ['openclaude', '--print', 'two'],
        sessionId: 'conversation-2',
      }),
    ).rejects.toThrow('already exists')
    expect((await resolveBackgroundSession('bg-collision')).name).toBe('first')
  })

  it('keeps a markerless id unavailable while a terminal fact remains', async () => {
    await writeTerminalFact('bg-retained-fact', 'natural', {
      pid: 111,
      status: 'exited',
      finishedAt: '2026-06-15T08:04:00.000Z',
      terminalReason: 'exit_code',
      exitCode: 0,
    })

    await expect(
      createBackgroundSession({
        id: 'bg-retained-fact',
        pid: 222,
        cwd: '/repo',
        command: ['openclaude', '--print', 'replacement'],
        sessionId: 'conversation-replacement',
      }),
    ).rejects.toThrow('already exists')
    expect(await listBackgroundSessions()).toEqual([])
  })

  it('rejects non-positive pids at creation', async () => {
    await expect(
      createBackgroundSession({
        id: 'bg-zero-pid',
        pid: 0,
        cwd: '/repo',
        command: ['openclaude', '--print', 'zero'],
        sessionId: 'conversation-zero',
      }),
    ).rejects.toThrow('Invalid background session pid')

    await expect(
      createBackgroundSession({
        id: 'bg-negative-pid',
        pid: -1,
        cwd: '/repo',
        command: ['openclaude', '--print', 'negative'],
        sessionId: 'conversation-negative',
      }),
    ).rejects.toThrow('Invalid background session pid')

    expect(await listBackgroundSessions()).toEqual([])
  })

  it('registers a session whose log files were created before spawn', async () => {
    const stdoutLogPath = join(
      configDir,
      'bg-sessions',
      'logs',
      'bg-precreated.out.log',
    )
    const stderrLogPath = join(
      configDir,
      'bg-sessions',
      'logs',
      'bg-precreated.err.log',
    )
    await mkdir(join(configDir, 'bg-sessions', 'logs'), {
      recursive: true,
    })
    await writeFile(stdoutLogPath, '')
    await writeFile(stderrLogPath, '')

    const session = await createBackgroundSession({
      id: 'bg-precreated',
      pid: 222,
      cwd: '/repo',
      command: ['openclaude', '--print', 'work'],
      sessionId: 'conversation-1',
      stdoutLogPath,
      stderrLogPath,
      logFilesPrecreated: true,
    })

    expect(session.stdoutLogPath).toBe(stdoutLogPath)
    expect(session.stderrLogPath).toBe(stderrLogPath)
    expect((await resolveBackgroundSession('bg-precreated')).id).toBe(
      'bg-precreated',
    )
  })

  it('preserves caller-owned precreated logs when metadata registration fails', async () => {
    const stdoutLogPath = join(
      configDir,
      'bg-sessions',
      'logs',
      'bg-precreated-collision.out.log',
    )
    const stderrLogPath = join(
      configDir,
      'bg-sessions',
      'logs',
      'bg-precreated-collision.err.log',
    )
    await mkdir(join(configDir, 'bg-sessions', 'logs'), {
      recursive: true,
    })
    await mkdir(join(configDir, 'bg-sessions', 'sessions'), {
      recursive: true,
    })
    await writeFile(stdoutLogPath, 'stdout already belongs to caller')
    await writeFile(stderrLogPath, 'stderr already belongs to caller')
    await writeFile(
      join(
        configDir,
        'bg-sessions',
        'sessions',
        'bg-precreated-collision.json',
      ),
      JSON.stringify({
        id: 'bg-precreated-collision',
        pid: 111,
        cwd: '/repo',
        status: 'running',
        sessionId: 'conversation-1',
        startedAt: '2026-06-15T08:00:00.000Z',
        updatedAt: '2026-06-15T08:00:00.000Z',
        command: ['openclaude', '--print', 'one'],
        stdoutLogPath: '/tmp/existing-out.log',
        stderrLogPath: '/tmp/existing-err.log',
      }),
    )

    await expect(
      createBackgroundSession({
        id: 'bg-precreated-collision',
        pid: 222,
        cwd: '/repo',
        command: ['openclaude', '--print', 'two'],
        sessionId: 'conversation-2',
        stdoutLogPath,
        stderrLogPath,
        logFilesPrecreated: true,
      }),
    ).rejects.toThrow('already exists')

    expect(await Bun.file(stdoutLogPath).text()).toBe(
      'stdout already belongs to caller',
    )
    expect(await Bun.file(stderrLogPath).text()).toBe(
      'stderr already belongs to caller',
    )
  })

  it('cleans up logs created before detecting a metadata id collision', async () => {
    await mkdir(join(configDir, 'bg-sessions', 'sessions'), {
      recursive: true,
    })
    await writeFile(
      join(configDir, 'bg-sessions', 'sessions', 'bg-log-cleanup.json'),
      JSON.stringify({
        id: 'bg-log-cleanup',
        pid: 111,
        cwd: '/repo',
        status: 'running',
        sessionId: 'conversation-1',
        startedAt: '2026-06-15T08:00:00.000Z',
        updatedAt: '2026-06-15T08:00:00.000Z',
        command: ['openclaude', '--print', 'one'],
        stdoutLogPath: '/tmp/existing-out.log',
        stderrLogPath: '/tmp/existing-err.log',
      }),
    )

    await expect(
      createBackgroundSession({
        id: 'bg-log-cleanup',
        pid: 222,
        cwd: '/repo',
        command: ['openclaude', '--print', 'two'],
        sessionId: 'conversation-2',
      }),
    ).rejects.toThrow('already exists')

    expect(
      await Bun.file(
        join(configDir, 'bg-sessions', 'logs', 'bg-log-cleanup.out.log'),
      ).exists(),
    ).toBe(false)
    expect(
      await Bun.file(
        join(configDir, 'bg-sessions', 'logs', 'bg-log-cleanup.err.log'),
      ).exists(),
    ).toBe(false)
  })

  it('marks running sessions stale when their process is gone', async () => {
    await createBackgroundSession({
      id: 'bg-stale',
      pid: 333,
      cwd: '/repo',
      command: ['openclaude', '--print', 'work'],
      sessionId: 'conversation-1',
      now: new Date('2026-06-15T08:00:00.000Z'),
    })

    const refreshed = await refreshBackgroundSessionStatuses({
      isProcessAlive: () => false,
      now: new Date('2026-06-15T08:05:00.000Z'),
    })

    expect(refreshed).toHaveLength(1)
    expect(refreshed[0]).toMatchObject({
      id: 'bg-stale',
      status: 'stale',
      updatedAt: '2026-06-15T08:05:00.000Z',
    })
  })

  it('reads metadata written without optional terminal fields', async () => {
    await createBackgroundSession({
      id: 'bg-old-metadata',
      pid: 332,
      cwd: '/repo',
      command: ['openclaude', '--print', 'work'],
      sessionId: 'conversation-old-metadata',
    })

    const oldMetadata = (await listBackgroundSessions())[0]!
    expect(oldMetadata).toMatchObject({
      id: 'bg-old-metadata',
      status: 'running',
    })
    expect('finishedAt' in oldMetadata).toBe(false)
    expect('exitCode' in oldMetadata).toBe(false)
    expect('terminalReason' in oldMetadata).toBe(false)
  })

  it('ignores a terminal fact owned by a different PID', async () => {
    await createBackgroundSession({
      id: 'bg-fact-pid-mismatch',
      pid: 350,
      cwd: '/repo',
      command: ['openclaude', '--print', 'work'],
      sessionId: 'conversation-fact-pid-mismatch',
    })
    await writeTerminalFact('bg-fact-pid-mismatch', 'natural', {
      pid: 351,
      status: 'exited',
      finishedAt: '2026-06-15T08:04:00.000Z',
      exitCode: 0,
      terminalReason: 'exit_code',
    })

    const session = await resolveBackgroundSession('bg-fact-pid-mismatch')
    expect(session.status).toBe('running')
    expect('exitCode' in session).toBe(false)
  })

  it('ignores a killed terminal fact that carries an exit code', async () => {
    await createBackgroundSession({
      id: 'bg-fact-malformed-kill',
      pid: 352,
      cwd: '/repo',
      command: ['openclaude', '--print', 'work'],
      sessionId: 'conversation-fact-malformed-kill',
    })
    await writeTerminalFact('bg-fact-malformed-kill', 'killed', {
      pid: 352,
      status: 'killed',
      finishedAt: '2026-06-15T08:04:00.000Z',
      terminalReason: 'explicit_kill',
      exitCode: 0,
    })

    const session = await resolveBackgroundSession('bg-fact-malformed-kill')
    expect(session.status).toBe('running')
    expect('exitCode' in session).toBe(false)
  })

  it('keeps an authoritative successful completion stronger than a stale refresh', async () => {
    await createBackgroundSession({
      id: 'bg-natural-success',
      pid: 333,
      cwd: '/repo',
      command: ['openclaude', '--print', 'work'],
      sessionId: 'conversation-success',
      now: new Date('2026-06-15T08:00:00.000Z'),
    })
    await writeTerminalFact('bg-natural-success', 'natural', {
      pid: 333,
      status: 'exited',
      finishedAt: '2026-06-15T08:04:00.000Z',
      exitCode: 0,
      terminalReason: 'exit_code',
    })

    const refreshed = await refreshBackgroundSessionStatuses({
      isProcessAlive: () => false,
      now: new Date('2026-06-15T08:05:00.000Z'),
    })

    expect(refreshed[0]).toMatchObject({
      id: 'bg-natural-success',
      status: 'exited',
      finishedAt: '2026-06-15T08:04:00.000Z',
      exitCode: 0,
      terminalReason: 'exit_code',
    })
    expect((await listBackgroundSessions())[0]?.status).toBe('exited')
  })

  it('preserves an authoritative nonzero completion and exact exit code', async () => {
    await createBackgroundSession({
      id: 'bg-natural-failure',
      pid: 334,
      cwd: '/repo',
      command: ['openclaude', '--print', 'work'],
      sessionId: 'conversation-failure',
    })
    await writeTerminalFact('bg-natural-failure', 'natural', {
      pid: 334,
      status: 'failed',
      finishedAt: '2026-06-15T08:04:00.000Z',
      exitCode: 23,
      terminalReason: 'exit_code',
    })

    expect(await resolveBackgroundSession('bg-natural-failure')).toMatchObject({
      status: 'failed',
      finishedAt: '2026-06-15T08:04:00.000Z',
      exitCode: 23,
      terminalReason: 'exit_code',
    })
  })

  it('gives explicit kill precedence without erasing observed natural details', async () => {
    await createBackgroundSession({
      id: 'bg-kill-precedence',
      pid: 335,
      cwd: '/repo',
      command: ['openclaude', '--print', 'work'],
      sessionId: 'conversation-kill-precedence',
    })
    await writeTerminalFact('bg-kill-precedence', 'natural', {
      pid: 335,
      status: 'failed',
      finishedAt: '2026-06-15T08:04:00.000Z',
      exitCode: 17,
      terminalReason: 'exit_code',
    })
    await writeTerminalFact('bg-kill-precedence', 'killed', {
      pid: 335,
      status: 'killed',
      finishedAt: '2026-06-15T08:05:00.000Z',
      terminalReason: 'explicit_kill',
    })

    expect(await resolveBackgroundSession('bg-kill-precedence')).toMatchObject({
      status: 'killed',
      finishedAt: '2026-06-15T08:04:00.000Z',
      exitCode: 17,
      terminalReason: 'explicit_kill',
    })
  })

  it('releases a name when an authoritative natural completion is present', async () => {
    await createBackgroundSession({
      id: 'bg-natural-name-old',
      name: 'natural-name',
      pid: 336,
      cwd: '/repo',
      command: ['openclaude', '--print', 'old'],
      sessionId: 'conversation-natural-name-old',
    })
    await writeTerminalFact('bg-natural-name-old', 'natural', {
      pid: 336,
      status: 'exited',
      finishedAt: '2026-06-15T08:04:00.000Z',
      exitCode: 0,
      terminalReason: 'exit_code',
    })

    const replacement = await createBackgroundSession({
      id: 'bg-natural-name-new',
      name: 'natural-name',
      pid: 337,
      cwd: '/repo',
      command: ['openclaude', '--print', 'new'],
      sessionId: 'conversation-natural-name-new',
    })

    expect(replacement.name).toBe('natural-name')
    expect((await resolveBackgroundSession('natural-name')).id).toBe(
      'bg-natural-name-new',
    )
  })

  it('records natural completion only for the exact owning PID', async () => {
    await createBackgroundSession({
      id: 'bg-owner-checked',
      pid: 338,
      cwd: '/repo',
      command: ['openclaude', '--print', 'work'],
      sessionId: 'conversation-owner-checked',
    })

    await expect(
      recordBackgroundSessionNaturalTermination(
        'bg-owner-checked',
        { exitCode: 0 },
        { ownerPid: 339 },
      ),
    ).rejects.toThrow('does not own')
    expect((await resolveBackgroundSession('bg-owner-checked')).status).toBe(
      'running',
    )

    const completed = await recordBackgroundSessionNaturalTermination(
      'bg-owner-checked',
      { exitCode: 0 },
      {
        ownerPid: 338,
        now: new Date('2026-06-15T08:06:00.000Z'),
      },
    )
    expect(completed).toMatchObject({
      status: 'exited',
      finishedAt: '2026-06-15T08:06:00.000Z',
      exitCode: 0,
    })
  })

  it('does not follow a symlinked recovery journal after terminal persistence', async () => {
    const session = await createBackgroundSession({
      id: 'bg-symlinked-recovery-journal',
      pid: 451,
      cwd: '/repo',
      command: ['openclaude', '--print', 'work'],
      sessionId: 'conversation-symlinked-recovery-journal',
    })
    const outside = join(configDir, 'outside-recovery-journal')
    await writeFile(outside, 'keep')
    await symlink(
      outside,
      join(configDir, 'bg-sessions', '.recovery-journal'),
    )

    expect(
      await recordBackgroundSessionNaturalTermination(
        session.id,
        { exitCode: 0 },
        { ownerPid: session.pid },
      ),
    ).toMatchObject({ status: 'exited' })
    expect(await readFile(outside, 'utf8')).toBe('keep')
  })

  it('queues async terminal persistence for bounded recovery', async () => {
    const session = await createBackgroundSession({
      id: 'bg-async-recovery-queue',
      pid: 452,
      cwd: '/repo',
      command: ['openclaude', '--print', 'work'],
      sessionId: 'conversation-async-recovery-queue',
    })
    await recordBackgroundSessionNaturalTermination(
      session.id,
      { exitCode: 0 },
      { ownerPid: session.pid },
    )

    const batch = await takeBackgroundSessionRecoveryBatch(1)
    expect(batch.sessionIds).toEqual([session.id])
    await batch.commit()
    expect(
      (await takeBackgroundSessionRecoveryBatch(1)).sessionIds,
    ).toEqual([])
  })

  it('persists only owned retries behind new work before acknowledging a batch', async () => {
    const root = join(configDir, 'bg-sessions')
    await mkdir(root, { recursive: true })
    const journal = join(root, '.recovery-journal')
    await writeFile(journal, 'bg-retry\nbg-done\nbg-next\n')
    const batch = await takeBackgroundSessionRecoveryBatch(2)
    await batch.commit(['bg-retry', 'bg-foreign', 'bg-retry', '../outside'])
    const contents = await readFile(journal, 'utf8')
    expect(contents).toBe('bg-retry\nbg-done\nbg-next\nbg-retry\n')
    const cursor = JSON.parse(
      await readFile(join(root, '.recovery-cursor.json'), 'utf8'),
    )
    expect(cursor.offset).toBe(Buffer.byteLength('bg-retry\nbg-done\n'))
    await batch.commit(['bg-retry'])
    expect(await readFile(journal, 'utf8')).toBe(contents)

    const next = await takeBackgroundSessionRecoveryBatch(2)
    expect(next.sessionIds).toEqual(['bg-next', 'bg-retry'])
    await next.commit(['bg-retry'])
    // Repeated failures rotate the consumed prefix instead of growing forever.
    expect(await readFile(journal, 'utf8')).toBe('bg-retry\n')
    const retry = await takeBackgroundSessionRecoveryBatch(2)
    expect(retry.sessionIds).toEqual(['bg-retry'])
    await retry.commit()
    expect(await readFile(journal, 'utf8')).toBe('')
  })

  it('retains validated generations for terminal retries after metadata removal', async () => {
    const root = join(configDir, 'bg-sessions')
    await mkdir(root, { recursive: true })
    const journal = join(root, '.recovery-journal')
    const generation = 'a'.repeat(64)
    await writeFile(journal, 'bg-fact-retry\n')
    const batch = await takeBackgroundSessionRecoveryBatch(1)
    await batch.commit(
      ['bg-fact-retry'],
      [
        { id: 'bg-fact-retry', generation },
        { id: 'bg-foreign', generation },
        { id: 'bg-fact-retry', generation: '../outside' },
      ],
    )
    const retry = await takeBackgroundSessionRecoveryBatch(256)
    expect(retry.sessionIds).toEqual(['bg-fact-retry'])
    expect(retry.terminalFacts).toEqual([
      { id: 'bg-fact-retry', generation: undefined },
      { id: 'bg-fact-retry', generation },
    ])
    await retry.commit(['bg-fact-retry'])
    expect(
      (await takeBackgroundSessionRecoveryBatch(256)).terminalFacts,
    ).toEqual(retry.terminalFacts)
    await writeFile(
      journal,
      `bg-bad~invalid\nbg-bad~${generation}~extra\nbg-good\n`,
    )
    expect(
      (await takeBackgroundSessionRecoveryBatch(256)).sessionIds,
    ).toEqual(['bg-good'])
  })

  for (const synchronous of [false, true]) {
    it(`journals marked ownership before interrupted cleanup, sync ${synchronous}`, async () => {
      const id = 'bg-marked-interruption'
      const session = await createBackgroundSession({
        id,
        pid: 452,
        cwd: '/repo',
        command: ['openclaude', '--print', 'fixture'],
        sessionId: 'marked-interruption',
        processMarker: TEST_PROCESS_MARKER,
      })
      const options = {
        ownerPid: session.pid,
        expectedSession: session,
        now: new Date(0),
      }
      if (synchronous)
        recordBackgroundSessionNaturalTerminationSync(
          id,
          { exitCode: 0 },
          options,
        )
      else
        await recordBackgroundSessionNaturalTermination(
          id,
          { exitCode: 0 },
          options,
        )
      const batch = await takeBackgroundSessionRecoveryBatch(256)
      expect(batch.terminalFacts).toEqual([
        { id, generation: TEST_PROCESS_MARKER },
      ])
      const root = join(configDir, 'bg-sessions')
      // Simulate interruption after logs/metadata were removed, before the fact unlink.
      await rm(join(root, 'sessions', `${id}.json`))
      await rm(session.stdoutLogPath, { force: true })
      await rm(session.stderrLogPath, { force: true })
      expect(
        await cleanupBackgroundSessionsBefore(new Date(), {
          sessionIds: batch.sessionIds,
          orphanedTerminalFacts: batch.terminalFacts,
          maxDirectoryEntries: 0,
        }),
      ).toEqual({ sessionsRemoved: 0, artifactsRemoved: 1, errors: 0 })
      await batch.commit()
      expect(
        (await takeBackgroundSessionRecoveryBatch(256)).sessionIds,
      ).toEqual([])
    })
  }

  it('caps recovery batches at 256 journal records', async () => {
    const root = join(configDir, 'bg-sessions')
    await mkdir(root, { recursive: true })
    await writeFile(
      join(root, '.recovery-journal'),
      `${Array.from({ length: 300 }, (_, index) => `bg-batch-cap-${index}`).join('\n')}\n`,
    )

    expect(
      (await takeBackgroundSessionRecoveryBatch(1_000)).sessionIds,
    ).toHaveLength(256)
  })

  it('queues sync terminal persistence for bounded recovery', async () => {
    const session = await createBackgroundSession({
      id: 'bg-sync-recovery-queue',
      pid: 453,
      cwd: '/repo',
      command: ['openclaude', '--print', 'work'],
      sessionId: 'conversation-sync-recovery-queue',
    })
    recordBackgroundSessionNaturalTerminationSync(
      session.id,
      { exitCode: 0 },
      { ownerPid: session.pid, expectedSession: session },
    )

    const batch = await takeBackgroundSessionRecoveryBatch(1)
    expect(batch.sessionIds).toEqual([session.id])
  })

  it('preserves records appended after a full-sweep journal snapshot', async () => {
    const first = await createBackgroundSession({
      id: 'bg-recovery-snapshot-first',
      pid: 455,
      cwd: '/repo',
      command: ['openclaude', '--print', 'first'],
      sessionId: 'conversation-recovery-snapshot-first',
    })
    await recordBackgroundSessionNaturalTermination(
      first.id,
      { exitCode: 0 },
      { ownerPid: first.pid },
    )
    const snapshot =
      await snapshotBackgroundSessionRecoveryJournal()

    const second = await createBackgroundSession({
      id: 'bg-recovery-snapshot-second',
      pid: 456,
      cwd: '/repo',
      command: ['openclaude', '--print', 'second'],
      sessionId: 'conversation-recovery-snapshot-second',
    })
    await recordBackgroundSessionNaturalTermination(
      second.id,
      { exitCode: 0 },
      { ownerPid: second.pid },
    )

    expect(await snapshot.commit()).toBe(true)
    expect(
      (await takeBackgroundSessionRecoveryBatch(2)).sessionIds,
    ).toEqual([second.id])
  })

  it('ignores a stale batch commit after journal rotation', async () => {
    const first = await createBackgroundSession({
      id: 'bg-stale-recovery-batch-first',
      pid: 457,
      cwd: '/repo',
      command: ['openclaude', '--print', 'first'],
      sessionId: 'conversation-stale-recovery-batch-first',
    })
    await recordBackgroundSessionNaturalTermination(
      first.id,
      { exitCode: 0 },
      { ownerPid: first.pid },
    )
    const staleBatch = await takeBackgroundSessionRecoveryBatch(1)
    const snapshot =
      await snapshotBackgroundSessionRecoveryJournal()
    expect(await snapshot.commit()).toBe(true)

    const second = await createBackgroundSession({
      id: 'bg-stale-recovery-batch-second',
      pid: 458,
      cwd: '/repo',
      command: ['openclaude', '--print', 'second'],
      sessionId: 'conversation-stale-recovery-batch-second',
    })
    await recordBackgroundSessionNaturalTermination(
      second.id,
      { exitCode: 0 },
      { ownerPid: second.pid },
    )
    await staleBatch.commit([first.id])

    expect(
      (await takeBackgroundSessionRecoveryBatch(1)).sessionIds,
    ).toEqual([second.id])
  })

  it('does not follow a symlinked recovery journal during sync persistence', async () => {
    const session = await createBackgroundSession({
      id: 'bg-sync-symlinked-recovery-journal',
      pid: 454,
      cwd: '/repo',
      command: ['openclaude', '--print', 'work'],
      sessionId: 'conversation-sync-symlinked-recovery-journal',
    })
    const outside = join(configDir, 'outside-sync-recovery-journal')
    await writeFile(outside, 'keep')
    await symlink(
      outside,
      join(configDir, 'bg-sessions', '.recovery-journal'),
    )

    recordBackgroundSessionNaturalTerminationSync(
      session.id,
      { exitCode: 0 },
      { ownerPid: session.pid, expectedSession: session },
    )
    expect((await resolveBackgroundSession(session.id)).status).toBe(
      'exited',
    )
    expect(await readFile(outside, 'utf8')).toBe('keep')
  })

  it('does not let a late natural finalizer replace the first valid fact', async () => {
    await createBackgroundSession({
      id: 'bg-first-fact',
      pid: 340,
      cwd: '/repo',
      command: ['openclaude', '--print', 'work'],
      sessionId: 'conversation-first-fact',
    })
    await recordBackgroundSessionNaturalTermination(
      'bg-first-fact',
      { exitCode: 19 },
      {
        ownerPid: 340,
        now: new Date('2026-06-15T08:07:00.000Z'),
      },
    )
    await recordBackgroundSessionNaturalTermination(
      'bg-first-fact',
      { exitCode: 0 },
      {
        ownerPid: 340,
        now: new Date('2026-06-15T08:08:00.000Z'),
      },
    )

    expect(await resolveBackgroundSession('bg-first-fact')).toMatchObject({
      status: 'failed',
      finishedAt: '2026-06-15T08:07:00.000Z',
      exitCode: 19,
    })
  })

  it('converges concurrent natural finalizers on one immutable fact', async () => {
    await createBackgroundSession({
      id: 'bg-concurrent-natural',
      pid: 346,
      cwd: '/repo',
      command: [
        'openclaude',
        backgroundProcessMarkerToken(TEST_PROCESS_MARKER),
        '--print',
        'work',
      ],
      sessionId: 'conversation-concurrent-natural',
      processMarker: TEST_PROCESS_MARKER,
    })

    const results = await Promise.all([
      recordBackgroundSessionNaturalTermination(
        'bg-concurrent-natural',
        { exitCode: 31 },
        {
          ownerPid: 346,
          now: new Date('2026-06-15T08:10:00.000Z'),
        },
      ),
      recordBackgroundSessionNaturalTermination(
        'bg-concurrent-natural',
        { exitCode: 0 },
        {
          ownerPid: 346,
          now: new Date('2026-06-15T08:11:00.000Z'),
        },
      ),
    ])

    const facts = results.map(result => {
      if (result.finishedAt === undefined || result.exitCode === undefined) {
        throw new Error('natural terminal fact was incomplete')
      }
      return {
        status: result.status,
        finishedAt: result.finishedAt,
        exitCode: result.exitCode,
      }
    })
    expect(new Set(facts.map(fact => JSON.stringify(fact))).size).toBe(1)
    expect([
      {
        status: 'failed',
        finishedAt: '2026-06-15T08:10:00.000Z',
        exitCode: 31,
      },
      {
        status: 'exited',
        finishedAt: '2026-06-15T08:11:00.000Z',
        exitCode: 0,
      },
    ]).toContainEqual(facts[0])
    expect(await resolveBackgroundSession('bg-concurrent-natural')).toMatchObject(
      facts[0]!,
    )
  })

  it('corrects a stale guess with a later exact-owner natural fact', async () => {
    await createBackgroundSession({
      id: 'bg-stale-correction',
      pid: 341,
      cwd: '/repo',
      command: ['openclaude', '--print', 'work'],
      sessionId: 'conversation-stale-correction',
    })
    await refreshBackgroundSessionStatuses({ isProcessAlive: () => false })

    const corrected = await recordBackgroundSessionNaturalTermination(
      'bg-stale-correction',
      { exitCode: 0 },
      { ownerPid: 341 },
    )
    expect(corrected).toMatchObject({ status: 'exited', exitCode: 0 })
  })

  it('does not return or persist stale over a finalizer racing the refresh write', async () => {
    await createBackgroundSession({
      id: 'bg-refresh-race',
      pid: 343,
      cwd: '/repo',
      command: ['openclaude', '--print', 'work'],
      sessionId: 'conversation-refresh-race',
    })
    let releaseWrite!: () => void
    const writeMayContinue = new Promise<void>(resolve => {
      releaseWrite = resolve
    })
    let refreshReachedWrite!: () => void
    const refreshAtWrite = new Promise<void>(resolve => {
      refreshReachedWrite = resolve
    })

    const refreshing = refreshBackgroundSessionStatuses({
      isProcessAlive: () => false,
      _beforeStatusWriteForTesting: async () => {
        refreshReachedWrite()
        await writeMayContinue
      },
    })
    await refreshAtWrite
    await recordBackgroundSessionNaturalTermination(
      'bg-refresh-race',
      { exitCode: 0 },
      { ownerPid: 343 },
    )
    releaseWrite()

    expect((await refreshing)[0]).toMatchObject({
      status: 'exited',
      exitCode: 0,
    })
    expect((await listBackgroundSessions())[0]).toMatchObject({
      status: 'exited',
      exitCode: 0,
    })
  })

  it('does not let a stale refresh overwrite a same-ID replacement generation', async () => {
    const id = 'bg-refresh-generation-race'
    const name = 'refresh-generation-race'
    const oldSession = await createBackgroundSession({
      id,
      name,
      pid: 360,
      cwd: '/repo',
      command: [
        'openclaude',
        backgroundProcessMarkerToken(TEST_PROCESS_MARKER),
        '--print',
        'old generation',
      ],
      sessionId: 'conversation-refresh-generation-old',
      processMarker: TEST_PROCESS_MARKER,
    })
    let replacement: BackgroundSession | undefined

    const refreshed = await refreshBackgroundSessionStatuses({
      isProcessAlive: () => false,
      _beforeStatusWriteForTesting: async () => {
        await recordBackgroundSessionNaturalTermination(
          id,
          { exitCode: 0 },
          {
            ownerPid: oldSession.pid,
            now: new Date('2026-06-01T00:00:00.000Z'),
          },
        )
        await cleanupBackgroundSessionsBefore(
          new Date('2026-07-01T00:00:00.000Z'),
        )
        replacement = await createBackgroundSession({
          id,
          name,
          pid: 361,
          cwd: '/repo',
          command: [
            'openclaude',
            backgroundProcessMarkerToken(OTHER_PROCESS_MARKER),
            '--print',
            'replacement generation',
          ],
          sessionId: 'conversation-refresh-generation-replacement',
          processMarker: OTHER_PROCESS_MARKER,
        })
      },
    })

    if (!replacement) throw new Error('replacement session was not created')
    expect(refreshed).toHaveLength(1)
    expect(refreshed[0]).toMatchObject({
      id,
      pid: replacement.pid,
      status: 'running',
      processMarker: OTHER_PROCESS_MARKER,
      terminalFactGeneration: OTHER_PROCESS_MARKER,
    })
    expect(await Bun.file(nameReservationPath(name)).json()).toMatchObject({
      id,
    })

    await recordBackgroundSessionNaturalTermination(
      id,
      { exitCode: 23 },
      {
        ownerPid: replacement.pid,
        now: new Date('2026-07-01T00:00:01.000Z'),
      },
    )
    expect(await resolveBackgroundSession(id)).toMatchObject({
      pid: replacement.pid,
      status: 'failed',
      exitCode: 23,
    })
  })

  it('does not let a stale kill mark a same-ID replacement generation', async () => {
    const id = 'bg-kill-generation-race'
    const name = 'kill-generation-race'
    const reusedPid = 362
    const oldSession = await createBackgroundSession({
      id,
      name,
      pid: reusedPid,
      cwd: '/repo',
      command: [
        'openclaude',
        backgroundProcessMarkerToken(TEST_PROCESS_MARKER),
        '--print',
        'old generation',
      ],
      sessionId: 'conversation-kill-generation-old',
      processMarker: TEST_PROCESS_MARKER,
    })
    let replacement: BackgroundSession | undefined

    await expect(
      markBackgroundSessionKilled(id, {
        _beforeMarkWriteForTesting: async () => {
          await recordBackgroundSessionNaturalTermination(
            id,
            { exitCode: 0 },
            {
              ownerPid: oldSession.pid,
              now: new Date('2026-06-01T00:00:00.000Z'),
            },
          )
          await cleanupBackgroundSessionsBefore(
            new Date('2026-07-01T00:00:00.000Z'),
          )
          replacement = await createBackgroundSession({
            id,
            name,
            pid: reusedPid,
            cwd: '/repo',
            command: [
              'openclaude',
              backgroundProcessMarkerToken(OTHER_PROCESS_MARKER),
              '--print',
              'replacement generation',
            ],
            sessionId: 'conversation-kill-generation-replacement',
            processMarker: OTHER_PROCESS_MARKER,
          })
        },
      }),
    ).rejects.toThrow('changed before it could be marked killed')

    if (!replacement) throw new Error('replacement session was not created')
    expect(await Bun.file(nameReservationPath(name)).json()).toMatchObject({
      id,
    })
    expect(
      await Bun.file(
        terminalFactPath(id, 'killed', OTHER_PROCESS_MARKER),
      ).exists(),
    ).toBe(false)

    await recordBackgroundSessionNaturalTermination(
      id,
      { exitCode: 9 },
      {
        ownerPid: replacement.pid,
        now: new Date('2026-07-01T00:00:01.000Z'),
      },
    )
    expect(await resolveBackgroundSession(id)).toMatchObject({
      pid: replacement.pid,
      status: 'failed',
      exitCode: 9,
    })
  })

  it('does not let a late finalizer write a same-ID replacement generation', async () => {
    const id = 'bg-finalizer-generation-race'
    const reusedPid = 363
    const oldSession = await createBackgroundSession({
      id,
      pid: reusedPid,
      cwd: '/repo',
      command: [
        'openclaude',
        backgroundProcessMarkerToken(TEST_PROCESS_MARKER),
        '--print',
        'old generation',
      ],
      sessionId: 'conversation-finalizer-generation-old',
      processMarker: TEST_PROCESS_MARKER,
    })
    await recordBackgroundSessionNaturalTermination(
      id,
      { exitCode: 0 },
      {
        ownerPid: reusedPid,
        expectedSession: oldSession,
        now: new Date('2026-06-01T00:00:00.000Z'),
      },
    )
    await cleanupBackgroundSessionsBefore(
      new Date('2026-07-01T00:00:00.000Z'),
    )
    const replacement = await createBackgroundSession({
      id,
      pid: reusedPid,
      cwd: '/repo',
      command: [
        'openclaude',
        backgroundProcessMarkerToken(OTHER_PROCESS_MARKER),
        '--print',
        'replacement generation',
      ],
      sessionId: 'conversation-finalizer-generation-replacement',
      processMarker: OTHER_PROCESS_MARKER,
    })

    await expect(
      recordBackgroundSessionNaturalTermination(
        id,
        { exitCode: 17 },
        { ownerPid: reusedPid, expectedSession: oldSession },
      ),
    ).rejects.toThrow('does not own this session')
    expect(() =>
      recordBackgroundSessionNaturalTerminationSync(
        id,
        { exitCode: 17 },
        { ownerPid: reusedPid, expectedSession: oldSession },
      ),
    ).toThrow('does not own this session')
    expect(
      await Bun.file(
        terminalFactPath(id, 'natural', OTHER_PROCESS_MARKER),
      ).exists(),
    ).toBe(false)

    await recordBackgroundSessionNaturalTermination(
      id,
      { exitCode: 7 },
      { ownerPid: reusedPid, expectedSession: replacement },
    )
    expect(await resolveBackgroundSession(id)).toMatchObject({
      processMarker: OTHER_PROCESS_MARKER,
      status: 'failed',
      exitCode: 7,
    })
  })

  it('records a bounded observed signal without inventing an exit code', async () => {
    await createBackgroundSession({
      id: 'bg-observed-signal',
      pid: 344,
      cwd: '/repo',
      command: [
        'openclaude',
        backgroundProcessMarkerToken(TEST_PROCESS_MARKER),
        '--print',
        'work',
      ],
      sessionId: 'conversation-observed-signal',
      processMarker: TEST_PROCESS_MARKER,
    })
    const failed = await recordBackgroundSessionNaturalTermination(
      'bg-observed-signal',
      { signal: 'SIGTERM' },
      { ownerPid: 344 },
    )

    expect(failed).toMatchObject({
      status: 'failed',
      signal: 'SIGTERM',
      terminalReason: 'signal',
    })
    expect('exitCode' in failed).toBe(false)
  })

  it('keeps the first marked sync terminal fact immutable', async () => {
    await createBackgroundSession({
      id: 'bg-marked-sync-natural',
      pid: 348,
      cwd: '/repo',
      command: [
        'openclaude',
        backgroundProcessMarkerToken(TEST_PROCESS_MARKER),
        '--print',
        'work',
      ],
      sessionId: 'conversation-marked-sync-natural',
      processMarker: TEST_PROCESS_MARKER,
    })
    recordBackgroundSessionNaturalTerminationSync(
      'bg-marked-sync-natural',
      { exitCode: 19 },
      {
        ownerPid: 348,
        now: new Date('2026-06-15T08:09:10.000Z'),
      },
    )
    recordBackgroundSessionNaturalTerminationSync(
      'bg-marked-sync-natural',
      { exitCode: 0 },
      {
        ownerPid: 348,
        now: new Date('2026-06-15T08:09:20.000Z'),
      },
    )

    expect(await resolveBackgroundSession('bg-marked-sync-natural')).toMatchObject(
      {
        status: 'failed',
        finishedAt: '2026-06-15T08:09:10.000Z',
        exitCode: 19,
      },
    )
    expect(
      await Bun.file(
        terminalFactPath(
          'bg-marked-sync-natural',
          'natural',
          TEST_PROCESS_MARKER,
        ),
      ).json(),
    ).toMatchObject({ generation: TEST_PROCESS_MARKER, exitCode: 19 })
  })

  it('writes a durable marked fact when the metadata lock is contended', async () => {
    const id = 'bg-contended-sync-fact'
    const name = 'contended-sync-fact'
    const session = await createBackgroundSession({
      id,
      name,
      pid: 350,
      cwd: '/repo',
      command: [
        'openclaude',
        backgroundProcessMarkerToken(TEST_PROCESS_MARKER),
        '--print',
        'work',
      ],
      sessionId: 'conversation-contended-sync-fact',
      processMarker: TEST_PROCESS_MARKER,
    })
    const metadataPath = join(
      configDir,
      'bg-sessions',
      'sessions',
      `${id}.json`,
    )
    const release = await lockfile.lock(metadataPath, { realpath: false })
    try {
      recordBackgroundSessionNaturalTerminationSync(
        id,
        { exitCode: 19 },
        {
          ownerPid: session.pid,
          expectedSession: session,
          now: new Date('2026-06-15T08:09:24.000Z'),
        },
      )
    } finally {
      await release()
    }

    expect(
      await Bun.file(
        terminalFactPath(id, 'natural', TEST_PROCESS_MARKER),
      ).json(),
    ).toMatchObject({
      generation: TEST_PROCESS_MARKER,
      status: 'failed',
      exitCode: 19,
    })
    expect(await Bun.file(nameReservationPath(name)).exists()).toBe(true)
    expect(await reconcileBackgroundSessionTerminalFacts()).toEqual({
      sessionsUpdated: 1,
      errors: 0,
    })
    expect(await Bun.file(nameReservationPath(name)).exists()).toBe(false)
  })

  it('bounds recurring reconciliation by terminal directory entries', async () => {
    const sessions = await Promise.all(
      ['bg-bounded-reconcile-a', 'bg-bounded-reconcile-b'].map(
        async (id, index) =>
          await createBackgroundSession({
            id,
            pid: 360 + index,
            cwd: '/repo',
            command: [
              'openclaude',
              backgroundProcessMarkerToken(TEST_PROCESS_MARKER),
              '--print',
              id,
            ],
            sessionId: `conversation-${id}`,
            processMarker: TEST_PROCESS_MARKER,
          }),
      ),
    )
    for (const session of sessions) {
      const metadataPath = join(
        configDir,
        'bg-sessions',
        'sessions',
        `${session.id}.json`,
      )
      const release = await lockfile.lock(metadataPath, { realpath: false })
      try {
        recordBackgroundSessionNaturalTerminationSync(
          session.id,
          { exitCode: 17 },
          { ownerPid: session.pid, expectedSession: session },
        )
      } finally {
        await release()
      }
    }

    expect(
      await reconcileBackgroundSessionTerminalFacts({
        terminalScanLimit: 1,
      }),
    ).toEqual({ sessionsUpdated: 1, errors: 0 })
    const statuses = await Promise.all(
      sessions.map(
        async session =>
          (
            (await Bun.file(
              join(
                configDir,
                'bg-sessions',
                'sessions',
                `${session.id}.json`,
              ),
            ).json()) as { status: string }
          ).status,
      ),
    )
    expect(statuses.sort()).toEqual(['failed', 'running'])
  })

  it('does not bypass a contended metadata lock for a markerless session', async () => {
    const id = 'bg-contended-sync-legacy'
    const session = await createBackgroundSession({
      id,
      pid: 351,
      cwd: '/repo',
      command: ['openclaude', '--print', 'work'],
      sessionId: 'conversation-contended-sync-legacy',
    })
    const metadataPath = join(
      configDir,
      'bg-sessions',
      'sessions',
      `${id}.json`,
    )
    const release = await lockfile.lock(metadataPath, { realpath: false })
    try {
      let error: unknown
      try {
        recordBackgroundSessionNaturalTerminationSync(
          id,
          { exitCode: 0 },
          { ownerPid: session.pid, expectedSession: session },
        )
      } catch (caught) {
        error = caught
      }
      expect(error).toMatchObject({ code: 'ELOCKED' })
    } finally {
      await release()
    }
    expect(await Bun.file(terminalFactPath(id, 'natural')).exists()).toBe(
      false,
    )
  })

  it('uses the isolated legacy fact path for a marker-only sync handoff', async () => {
    const id = 'bg-contended-sync-marker-only'
    const session = await createBackgroundSession({
      id,
      pid: 352,
      cwd: '/repo',
      command: [
        'openclaude',
        backgroundProcessMarkerToken(TEST_PROCESS_MARKER),
        '--print',
        'work',
      ],
      sessionId: 'conversation-contended-sync-marker-only',
      processMarker: TEST_PROCESS_MARKER,
    })
    const metadataPath = join(
      configDir,
      'bg-sessions',
      'sessions',
      `${id}.json`,
    )
    const metadata = (await Bun.file(metadataPath).json()) as Record<
      string,
      unknown
    >
    delete metadata.terminalFactGeneration
    await writeFile(metadataPath, JSON.stringify(metadata))
    const markerOnlySession = await readBackgroundSessionForOwner(id)
    if (!markerOnlySession) throw new Error('marker-only session was not read')
    expect(markerOnlySession.terminalFactGeneration).toBeUndefined()

    const release = await lockfile.lock(metadataPath, { realpath: false })
    try {
      recordBackgroundSessionNaturalTerminationSync(
        id,
        { exitCode: 31 },
        {
          ownerPid: session.pid,
          expectedSession: markerOnlySession,
          now: new Date('2026-06-15T08:09:26.000Z'),
        },
      )
    } finally {
      await release()
    }

    expect(
      await Bun.file(
        terminalFactPath(id, 'natural'),
      ).json(),
    ).toMatchObject({
      status: 'failed',
      exitCode: 31,
    })
    expect(await reconcileBackgroundSessionTerminalFacts()).toEqual({
      sessionsUpdated: 1,
      errors: 0,
    })
    expect(await Bun.file(metadataPath).json()).toMatchObject({
      status: 'failed',
      exitCode: 31,
    })
  })

  it('reconciles a sync finalization after refresh holds the metadata lock', async () => {
    const id = 'bg-contended-sync-natural'
    const name = 'contended-sync-natural'
    const session = await createBackgroundSession({
      id,
      name,
      pid: 349,
      cwd: '/repo',
      command: [
        'openclaude',
        backgroundProcessMarkerToken(TEST_PROCESS_MARKER),
        '--print',
        'work',
      ],
      sessionId: 'conversation-contended-sync-natural',
      processMarker: TEST_PROCESS_MARKER,
    })
    const metadataPath = join(
      configDir,
      'bg-sessions',
      'sessions',
      `${id}.json`,
    )
    expect(
      await refreshBackgroundSessionStatuses({
        isProcessAlive: () => false,
        _whileStatusWriteLockedForTesting: () => {
          recordBackgroundSessionNaturalTerminationSync(
            id,
            { exitCode: 23 },
            {
              ownerPid: session.pid,
              expectedSession: session,
              now: new Date('2026-06-15T08:09:25.000Z'),
            },
          )
        },
      }),
    ).toMatchObject([{ status: 'failed', exitCode: 23 }])

    expect(await Bun.file(metadataPath).json()).toMatchObject({
      status: 'stale',
    })
    expect(
      await Bun.file(
        terminalFactPath(id, 'natural', TEST_PROCESS_MARKER),
      ).json(),
    ).toMatchObject({
      generation: TEST_PROCESS_MARKER,
      status: 'failed',
      exitCode: 23,
    })
    expect(await reconcileBackgroundSessionTerminalFacts()).toEqual({
      sessionsUpdated: 1,
      errors: 0,
    })
    expect(await Bun.file(metadataPath).json()).toMatchObject({
      status: 'failed',
      exitCode: 23,
      finishedAt: '2026-06-15T08:09:25.000Z',
    })
    expect(await Bun.file(nameReservationPath(name)).exists()).toBe(false)

    expect(
      await cleanupBackgroundSessionsBefore(
        new Date('2026-07-01T00:00:00.000Z'),
      ),
    ).toEqual({
      sessionsRemoved: 1,
      artifactsRemoved: 4,
      errors: 0,
    })
    expect(await Bun.file(metadataPath).exists()).toBe(false)
  })

  it('reconciles stronger terminal facts and retries reservation release', async () => {
    const id = 'bg-terminal-reconciliation-retry'
    const name = 'terminal-reconciliation-retry'
    const session = await createBackgroundSession({
      id,
      name,
      pid: 353,
      cwd: '/repo',
      command: [
        'openclaude',
        backgroundProcessMarkerToken(TEST_PROCESS_MARKER),
        '--print',
        'work',
      ],
      sessionId: 'conversation-terminal-reconciliation-retry',
      processMarker: TEST_PROCESS_MARKER,
    })
    await recordBackgroundSessionNaturalTermination(
      id,
      { exitCode: 5 },
      { ownerPid: session.pid },
    )
    expect(await reconcileBackgroundSessionTerminalFacts()).toEqual({
      sessionsUpdated: 1,
      errors: 0,
    })
    await markBackgroundSessionKilled(id, {
      now: new Date('2026-06-15T08:09:27.000Z'),
    })
    await writeNameReservation(name, { id })

    const release = await lockfile.lock(nameReservationPath(name), {
      realpath: false,
    })
    try {
      expect(await reconcileBackgroundSessionTerminalFacts()).toEqual({
        sessionsUpdated: 1,
        errors: 1,
      })
    } finally {
      await release()
    }
    expect(
      await Bun.file(
        join(configDir, 'bg-sessions', 'sessions', `${id}.json`),
      ).json(),
    ).toMatchObject({
      status: 'killed',
      terminalReason: 'explicit_kill',
    })
    expect(await Bun.file(nameReservationPath(name)).exists()).toBe(true)

    expect(await reconcileBackgroundSessionTerminalFacts()).toEqual({
      sessionsUpdated: 0,
      errors: 0,
    })
    expect(await Bun.file(nameReservationPath(name)).exists()).toBe(false)
  })

  for (const sync of [false, true]) {
    it(`preserves a mismatched reservation name during ${sync ? 'sync' : 'async'} finalization`, async () => {
      const suffix = sync ? 'sync' : 'async'
      const id = `bg-mismatched-reservation-${suffix}`
      const name = `mismatched-reservation-${suffix}`
      const session = await createBackgroundSession({
        id,
        name,
        pid: sync ? 354 : 355,
        cwd: '/repo',
        command: ['openclaude', '--print', 'work'],
        sessionId: `conversation-mismatched-reservation-${suffix}`,
      })
      await writeFile(
        nameReservationPath(name),
        JSON.stringify({ name: `${name}-other`, id }),
      )

      if (sync) {
        recordBackgroundSessionNaturalTerminationSync(
          id,
          { exitCode: 0 },
          { ownerPid: session.pid },
        )
      } else {
        await recordBackgroundSessionNaturalTermination(
          id,
          { exitCode: 0 },
          { ownerPid: session.pid },
        )
      }

      expect(await Bun.file(nameReservationPath(name)).exists()).toBe(true)
      expect(await Bun.file(nameReservationPath(name)).json()).toEqual({
        name: `${name}-other`,
        id,
      })
    })
  }

  it('does not let a late natural finalizer overwrite an explicit kill fact', async () => {
    await createBackgroundSession({
      id: 'bg-killed-absorbing',
      pid: 342,
      cwd: '/repo',
      command: ['openclaude', '--print', 'work'],
      sessionId: 'conversation-killed-absorbing',
    })
    await markBackgroundSessionKilled('bg-killed-absorbing', {
      now: new Date('2026-06-15T08:09:00.000Z'),
    })

    const late = await recordBackgroundSessionNaturalTermination(
      'bg-killed-absorbing',
      { exitCode: 0 },
      { ownerPid: 342 },
    )
    expect(late).toMatchObject({
      status: 'killed',
      finishedAt: '2026-06-15T08:09:00.000Z',
      terminalReason: 'explicit_kill',
    })
    expect(
      await Bun.file(
        terminalFactPath('bg-killed-absorbing', 'natural'),
      ).exists(),
    ).toBe(false)
  })

  it('does not let the sync finalizer overwrite an explicit kill fact', async () => {
    await createBackgroundSession({
      id: 'bg-sync-killed-absorbing',
      pid: 347,
      cwd: '/repo',
      command: [
        'openclaude',
        backgroundProcessMarkerToken(TEST_PROCESS_MARKER),
        '--print',
        'work',
      ],
      sessionId: 'conversation-sync-killed-absorbing',
      processMarker: TEST_PROCESS_MARKER,
    })
    await markBackgroundSessionKilled('bg-sync-killed-absorbing', {
      now: new Date('2026-06-15T08:09:30.000Z'),
    })

    recordBackgroundSessionNaturalTerminationSync(
      'bg-sync-killed-absorbing',
      { exitCode: 0 },
      { ownerPid: 347 },
    )

    expect(
      await resolveBackgroundSession('bg-sync-killed-absorbing'),
    ).toMatchObject({
      status: 'killed',
      finishedAt: '2026-06-15T08:09:30.000Z',
      terminalReason: 'explicit_kill',
    })
    expect(
      await Bun.file(
        terminalFactPath(
          'bg-sync-killed-absorbing',
          'natural',
          TEST_PROCESS_MARKER,
        ),
      ).exists(),
    ).toBe(false)
    expect(
      await Bun.file(
        terminalFactPath(
          'bg-sync-killed-absorbing',
          'killed',
          TEST_PROCESS_MARKER,
        ),
      ).json(),
    ).toMatchObject({ generation: TEST_PROCESS_MARKER })
  })

  it('keeps killed strongest when kill and natural completion race', async () => {
    await createBackgroundSession({
      id: 'bg-kill-natural-race',
      pid: 345,
      cwd: '/repo',
      command: ['openclaude', '--print', 'work'],
      sessionId: 'conversation-kill-natural-race',
    })

    await Promise.all([
      recordBackgroundSessionNaturalTermination(
        'bg-kill-natural-race',
        { exitCode: 0 },
        { ownerPid: 345 },
      ),
      markBackgroundSessionKilled('bg-kill-natural-race'),
    ])

    expect(await resolveBackgroundSession('bg-kill-natural-race')).toMatchObject(
      {
        status: 'killed',
        terminalReason: 'explicit_kill',
      },
    )
  })

  it('keeps a marked Windows session running when its exact early token matches', async () => {
    const markerToken = backgroundProcessMarkerToken(TEST_PROCESS_MARKER)
    await createBackgroundSession({
      id: 'bg-marked-windows',
      name: 'marked-windows',
      pid: 333,
      cwd: 'C:\\repo path',
      command: [
        'C:\\Program Files\\nodejs\\node.exe',
        'C:\\repo path\\dist\\cli.mjs',
        markerToken,
        '--session-id',
        'conversation-marked',
        '--print',
        'work',
      ],
      sessionId: 'conversation-marked',
      processMarker: TEST_PROCESS_MARKER,
      now: new Date('2026-06-15T08:00:00.000Z'),
    })

    const refreshed = await refreshBackgroundSessionStatuses({
      isProcessAlive: () => true,
      getProcessCommand: () =>
        `"C:\\Program Files\\nodejs\\node.exe" "C:\\repo path\\dist\\cli.mjs" ${markerToken} --session-id conversation-marked --print work`,
      now: new Date('2026-06-15T08:05:00.000Z'),
    })

    expect(refreshed[0]).toMatchObject({
      id: 'bg-marked-windows',
      status: 'running',
      updatedAt: '2026-06-15T08:00:00.000Z',
    })
    await expect(
      createBackgroundSession({
        id: 'bg-marked-windows-contender',
        name: 'marked-windows',
        pid: 334,
        cwd: '/repo',
        command: ['openclaude', '--print', 'contender'],
        sessionId: 'conversation-contender',
      }),
    ).rejects.toThrow('already exists')
  })

  it('marks a marked session stale when the same session id has a different marker', async () => {
    const markerToken = backgroundProcessMarkerToken(TEST_PROCESS_MARKER)
    await createBackgroundSession({
      id: 'bg-marked-wrong-marker',
      pid: 333,
      cwd: '/repo',
      command: [
        'node',
        '/repo/openclaude',
        markerToken,
        '--session-id',
        'conversation-marked',
      ],
      sessionId: 'conversation-marked',
      processMarker: TEST_PROCESS_MARKER,
      now: new Date('2026-06-15T08:00:00.000Z'),
    })

    const refreshed = await refreshBackgroundSessionStatuses({
      isProcessAlive: () => true,
      getProcessCommand: () =>
        `node /repo/openclaude ${backgroundProcessMarkerToken(OTHER_PROCESS_MARKER)} --session-id conversation-marked`,
      now: new Date('2026-06-15T08:05:00.000Z'),
    })

    expect(refreshed[0]).toMatchObject({
      id: 'bg-marked-wrong-marker',
      status: 'stale',
      updatedAt: '2026-06-15T08:05:00.000Z',
    })
  })

  it('keeps a marked session unknown when its live command is unreadable', async () => {
    const markerToken = backgroundProcessMarkerToken(TEST_PROCESS_MARKER)
    await createBackgroundSession({
      id: 'bg-marked-unreadable',
      pid: 333,
      cwd: '/repo',
      command: ['node', '/repo/openclaude', markerToken, '--print', 'work'],
      sessionId: 'conversation-marked',
      processMarker: TEST_PROCESS_MARKER,
      now: new Date('2026-06-15T08:00:00.000Z'),
    })

    const refreshed = await refreshBackgroundSessionStatuses({
      isProcessAlive: () => true,
      getProcessCommand: () => null,
      now: new Date('2026-06-15T08:05:00.000Z'),
    })

    expect(refreshed[0]).toMatchObject({
      id: 'bg-marked-unreadable',
      status: 'unknown',
      updatedAt: '2026-06-15T08:05:00.000Z',
    })
  })

  it('keeps running sessions fresh when their process identity still matches', async () => {
    await createBackgroundSession({
      id: 'bg-running',
      pid: 333,
      cwd: '/repo',
      command: ['openclaude', '--session-id', 'conversation-1', '--print', 'work'],
      sessionId: 'conversation-1',
      now: new Date('2026-06-15T08:00:00.000Z'),
    })

    const refreshed = await refreshBackgroundSessionStatuses({
      isProcessAlive: () => true,
      getProcessCommand: () =>
        'node openclaude --session-id conversation-1 --print work',
      now: new Date('2026-06-15T08:05:00.000Z'),
    })

    expect(refreshed[0]).toMatchObject({
      id: 'bg-running',
      status: 'running',
      updatedAt: '2026-06-15T08:00:00.000Z',
    })
  })

  it('keeps PR-resume sessions fresh when the live command matches the stored invocation', async () => {
    await createBackgroundSession({
      id: 'bg-from-pr',
      pid: 333,
      cwd: '/repo',
      command: ['openclaude', '--from-pr', '1642', '--print'],
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      now: new Date('2026-06-15T08:00:00.000Z'),
    })

    const refreshed = await refreshBackgroundSessionStatuses({
      isProcessAlive: () => true,
      getProcessCommand: () => 'node openclaude --from-pr 1642 --print',
      now: new Date('2026-06-15T08:05:00.000Z'),
    })

    expect(refreshed[0]).toMatchObject({
      id: 'bg-from-pr',
      status: 'running',
      updatedAt: '2026-06-15T08:00:00.000Z',
    })
  })

  it('marks sessions stale when a live PID no longer matches the session command', async () => {
    await createBackgroundSession({
      id: 'bg-reused-pid',
      pid: 333,
      cwd: '/repo',
      command: ['openclaude', '--session-id', 'conversation-1', '--print', 'work'],
      sessionId: 'conversation-1',
      now: new Date('2026-06-15T08:00:00.000Z'),
    })

    const refreshed = await refreshBackgroundSessionStatuses({
      isProcessAlive: () => true,
      getProcessCommand: () => 'unrelated-process',
      now: new Date('2026-06-15T08:05:00.000Z'),
    })

    expect(refreshed[0]).toMatchObject({
      id: 'bg-reused-pid',
      status: 'stale',
      updatedAt: '2026-06-15T08:05:00.000Z',
    })
  })

  it('marks sessions unknown when a live PID command identity cannot be read', async () => {
    await createBackgroundSession({
      id: 'bg-unreadable-pid',
      pid: 333,
      cwd: '/repo',
      command: ['openclaude', '--session-id', 'conversation-1', '--print', 'work'],
      sessionId: 'conversation-1',
      now: new Date('2026-06-15T08:00:00.000Z'),
    })

    const refreshed = await refreshBackgroundSessionStatuses({
      isProcessAlive: () => true,
      getProcessCommand: () => null,
      now: new Date('2026-06-15T08:05:00.000Z'),
    })

    expect(refreshed[0]).toMatchObject({
      id: 'bg-unreadable-pid',
      status: 'unknown',
      updatedAt: '2026-06-15T08:05:00.000Z',
    })
    expect(isTerminalBackgroundSession(refreshed[0]!)).toBe(false)
  })

  it('marks a session killed without deleting its logs or metadata', async () => {
    await createBackgroundSession({
      id: 'bg-kill',
      name: 'reusable-after-kill',
      pid: 444,
      cwd: '/repo',
      command: ['openclaude', '--print', 'work'],
      sessionId: 'conversation-1',
    })

    const killed = await markBackgroundSessionKilled('bg-kill', {
      now: new Date('2026-06-15T08:10:00.000Z'),
    })

    expect(killed.status).toBe('killed')
    expect(killed.updatedAt).toBe('2026-06-15T08:10:00.000Z')
    expect((await listBackgroundSessions()).map(s => s.id)).toEqual(['bg-kill'])

    const replacement = await createBackgroundSession({
      id: 'bg-after-kill',
      name: 'reusable-after-kill',
      pid: 445,
      cwd: '/repo',
      command: ['openclaude', '--print', 'new work'],
      sessionId: 'conversation-after-kill',
    })
    expect(replacement.name).toBe('reusable-after-kill')
  })

  it('ignores malformed metadata files instead of returning unsafe sessions', async () => {
    await mkdir(join(configDir, 'bg-sessions', 'sessions'), {
      recursive: true,
    })
    await writeFile(
      join(configDir, 'bg-sessions', 'sessions', 'bad.json'),
      JSON.stringify({
        id: 'bg-bad',
        pid: 123,
        status: 'running',
      }),
    )

    expect(await listBackgroundSessions()).toEqual([])
  })

  it('ignores metadata with a non-positive pid', async () => {
    await mkdir(join(configDir, 'bg-sessions', 'sessions'), {
      recursive: true,
    })
    await writeFile(
      join(configDir, 'bg-sessions', 'sessions', 'bg-zero-pid.json'),
      JSON.stringify({
        id: 'bg-zero-pid',
        pid: 0,
        cwd: '/repo',
        status: 'running',
        sessionId: 'conversation-1',
        startedAt: '2026-06-15T08:00:00.000Z',
        updatedAt: '2026-06-15T08:00:00.000Z',
        command: ['openclaude', '--print', 'work'],
        stdoutLogPath: '/tmp/stdout.log',
        stderrLogPath: '/tmp/stderr.log',
      }),
    )

    expect(await listBackgroundSessions()).toEqual([])
  })

  it('ignores metadata whose id does not match its filename', async () => {
    await mkdir(join(configDir, 'bg-sessions', 'sessions'), {
      recursive: true,
    })
    await writeFile(
      join(configDir, 'bg-sessions', 'sessions', 'bg-file.json'),
      JSON.stringify({
        id: 'bg-other',
        pid: 123,
        cwd: '/repo',
        status: 'running',
        sessionId: 'conversation-1',
        startedAt: '2026-06-15T08:00:00.000Z',
        updatedAt: '2026-06-15T08:00:00.000Z',
        command: ['openclaude', '--print', 'work'],
        stdoutLogPath: '/tmp/stdout.log',
        stderrLogPath: '/tmp/stderr.log',
      }),
    )

    expect(await listBackgroundSessions()).toEqual([])
  })
})

describe('isBackgroundSessionProcessAlive process identity', () => {
  const session: BackgroundSession = {
    id: 'bg-identity',
    pid: 4242,
    cwd: '/repo',
    status: 'running',
    startedAt: '2026-07-01T08:00:00.000Z',
    updatedAt: '2026-07-01T08:00:00.000Z',
    // sessionId deliberately absent from the command lines below so the stored
    // launch invocation (command) is what has to match.
    sessionId: 'conversation-identity',
    command: ['node', 'openclaude', '1642'],
    stdoutLogPath: '/tmp/stdout.log',
    stderrLogPath: '/tmp/stderr.log',
  }
  const markerToken = backgroundProcessMarkerToken(TEST_PROCESS_MARKER)
  const markedSession: BackgroundSession = {
    ...session,
    processMarker: TEST_PROCESS_MARKER,
    command: [
      '/opt/Open Claude/node',
      '/repo path/dist/cli.mjs',
      markerToken,
      '--session-id',
      session.sessionId,
      '--print',
      'work',
    ],
  }

  it('does not treat a reused PID whose command merely contains the arg as alive (#1770)', () => {
    // The live process at this PID is unrelated: its final token "16420" only
    // contains the stored selector "1642" as a substring. Ordered substring
    // matching wrongly reported this session as alive, so `kill` could target
    // the wrong process.
    const alive = isBackgroundSessionProcessAlive(session, {
      isProcessAlive: () => true,
      getProcessCommand: () => 'node openclaude 16420 --serve',
    })
    expect(alive).toBe(false)
  })

  it('still recognizes the real process by exact command tokens', () => {
    const alive = isBackgroundSessionProcessAlive(session, {
      isProcessAlive: () => true,
      getProcessCommand: () => 'node openclaude 1642 --serve',
    })
    expect(alive).toBe(true)
  })

  it('matches on the session id when it is present on the command line', () => {
    const alive = isBackgroundSessionProcessAlive(session, {
      isProcessAlive: () => true,
      getProcessCommand: () => 'node openclaude conversation-identity',
    })
    expect(alive).toBe(true)
  })

  it('does not fall back to the session id when marked process identity is missing', () => {
    const result = verifyBackgroundSessionProcessIdentity(markedSession, {
      isProcessAlive: () => true,
      getProcessCommand: () =>
        '/opt/Open Claude/node /repo path/dist/cli.mjs --session-id conversation-identity --print work',
    })

    expect(result.state).toBe('mismatch')
  })

  it('matches a marked Unix command with spaced executable and entrypoint paths', () => {
    const result = verifyBackgroundSessionProcessIdentity(markedSession, {
      isProcessAlive: () => true,
      getProcessCommand: () =>
        `/opt/Open Claude/node /repo path/dist/cli.mjs ${markerToken} --session-id conversation-identity --print work`,
    })

    expect(result.state).toBe('matches')
  })

  it('does not accept a missing, wrong, or shifted marker for a marked session', () => {
    const prefix = '/opt/Open Claude/node /repo path/dist/cli.mjs'
    const commands = [
      `${prefix} --print work --session-id conversation-identity`,
      `${prefix} ${backgroundProcessMarkerToken(OTHER_PROCESS_MARKER)} --session-id conversation-identity --print work`,
      `${prefix} --print ${markerToken} --session-id conversation-identity work`,
    ]

    expect(
      commands.map(
        command =>
          verifyBackgroundSessionProcessIdentity(markedSession, {
            isProcessAlive: () => true,
            getProcessCommand: () => command,
          }).state,
      ),
    ).toEqual(['mismatch', 'mismatch', 'mismatch'])
  })

  it('does not match marker prefix, suffix, or prompt-only collisions', () => {
    const prefix = '/opt/Open Claude/node /repo path/dist/cli.mjs'
    const commands = [
      `${prefix} prefix-${markerToken} --session-id conversation-identity`,
      `${prefix} ${markerToken}-suffix --session-id conversation-identity`,
      `${prefix} --print -- ${markerToken}`,
    ]

    expect(
      commands.map(
        command =>
          verifyBackgroundSessionProcessIdentity(markedSession, {
            isProcessAlive: () => true,
            getProcessCommand: () => command,
          }).state,
      ),
    ).toEqual(['mismatch', 'mismatch', 'mismatch'])
  })

  it('distinguishes truncated marked identity from a shorter unrelated command', () => {
    const prefix = '/opt/Open Claude/node /repo path/dist/cli.mjs'
    const withinMarker = markerToken.slice(0, -8)
    const states = [
      verifyBackgroundSessionProcessIdentity(markedSession, {
        isProcessAlive: () => true,
        getProcessCommand: () => prefix,
      }).state,
      verifyBackgroundSessionProcessIdentity(markedSession, {
        isProcessAlive: () => true,
        getProcessCommand: () => `${prefix} ${withinMarker}`,
      }).state,
      verifyBackgroundSessionProcessIdentity(markedSession, {
        isProcessAlive: () => true,
        getProcessCommand: () => 'unrelated short command',
      }).state,
    ]

    expect(states).toEqual(['unreadable', 'unreadable', 'mismatch'])
  })

  it('treats a marked session whose stored command omits its marker as unreadable', () => {
    const result = verifyBackgroundSessionProcessIdentity(
      {
        ...markedSession,
        command: ['node', 'openclaude', '--print', 'work'],
      },
      {
        isProcessAlive: () => true,
        getProcessCommand: () => 'node openclaude --print work',
      },
    )

    expect(result.state).toBe('unreadable')
  })

  it('does not match the session id as a substring of a larger token (#1770)', () => {
    // A short id must not match an unrelated live command that merely contains
    // it inside a longer token — the same reused-PID collision class as the
    // command-arg path. Command args are absent from the live line so only the
    // session-id branch can produce a match here.
    const shortIdSession: BackgroundSession = {
      ...session,
      sessionId: 'sess-1',
      command: ['node', 'openclaude', 'unused-token'],
    }
    const alive = isBackgroundSessionProcessAlive(shortIdSession, {
      isProcessAlive: () => true,
      getProcessCommand: () => 'node openclaude sess-100 --serve',
    })
    expect(alive).toBe(false)
  })

  it('matches the session id only as a whole token', () => {
    const shortIdSession: BackgroundSession = {
      ...session,
      sessionId: 'sess-1',
      command: ['node', 'openclaude', 'unused-token'],
    }
    const alive = isBackgroundSessionProcessAlive(shortIdSession, {
      isProcessAlive: () => true,
      getProcessCommand: () => 'node openclaude sess-1 --serve',
    })
    expect(alive).toBe(true)
  })

  it('matches a stored multi-word prompt arg across command tokens (#1770)', () => {
    // A prompt like "refactor auth" is stored as a single argv entry but `ps`
    // renders it as separate words; the matcher must span both. The session id
    // is absent from the live line so the command args are what must match.
    const promptSession: BackgroundSession = {
      ...session,
      sessionId: 'conversation-absent',
      command: ['node', 'openclaude', '--print', 'refactor auth'],
    }
    const alive = isBackgroundSessionProcessAlive(promptSession, {
      isProcessAlive: () => true,
      getProcessCommand: () =>
        'node openclaude --print refactor auth --serve',
    })
    expect(alive).toBe(true)
  })

  it('matches a quoted Windows command line with a spaced exe path and prompt (#1770)', () => {
    // Windows `Get-CimInstance ... CommandLine` returns the raw command line
    // with quoted paths/prompts, so a whitespace split fuses quotes onto the
    // edge tokens (`"C:\Program`, `node.exe"`, `"refactor`, `auth"`). The stored
    // argv holds those values unquoted, so without quote trimming the contiguous
    // run never matched and a live `--from-pr` resume (whose only identity path
    // is the stored command) was wrongly marked stale.
    const windowsSession: BackgroundSession = {
      ...session,
      sessionId: 'conversation-absent',
      command: [
        'C:\\Program Files\\nodejs\\node.exe',
        'C:\\repo\\dist\\cli.mjs',
        '--from-pr',
        '1642',
        '--print',
        'refactor auth',
      ],
    }
    const alive = isBackgroundSessionProcessAlive(windowsSession, {
      isProcessAlive: () => true,
      getProcessCommand: () =>
        '"C:\\Program Files\\nodejs\\node.exe" C:\\repo\\dist\\cli.mjs --from-pr 1642 --print "refactor auth"',
    })
    expect(alive).toBe(true)
  })

  it('quote trimming does not reopen the substring collision (#1770)', () => {
    // Trimming surrounding quotes must not degrade to substring matching: a
    // quoted live token "16420" still only contains the stored selector "1642",
    // so it must not satisfy the lookup.
    const alive = isBackgroundSessionProcessAlive(session, {
      isProcessAlive: () => true,
      getProcessCommand: () => '"node" openclaude "16420" --serve',
    })
    expect(alive).toBe(false)
  })

  it('does not treat interspersed stored tokens as alive (#1770)', () => {
    // The stored tokens all appear on the live command line but only as an
    // ordered subsequence with unrelated tokens ("attacker", "extra") wedged
    // between them, i.e. a different process at a reused PID. Requiring a
    // contiguous whole-token run rejects this token-insertion collision; a
    // subsequence match would wrongly report it alive and risk killing the
    // wrong process.
    const alive = isBackgroundSessionProcessAlive(session, {
      isProcessAlive: () => true,
      getProcessCommand: () => 'node attacker openclaude extra 1642 --serve',
    })
    expect(alive).toBe(false)
  })

  it('reports a dead process regardless of command line', () => {
    const alive = isBackgroundSessionProcessAlive(session, {
      isProcessAlive: () => false,
      getProcessCommand: () => 'node openclaude 1642',
    })
    expect(alive).toBe(false)
  })

  it('distinguishes missing, matching, mismatched, and unreadable live processes', () => {
    const states = [
      verifyBackgroundSessionProcessIdentity(session, {
        isProcessAlive: () => false,
        getProcessCommand: () => 'not read',
      }),
      verifyBackgroundSessionProcessIdentity(session, {
        isProcessAlive: () => true,
        getProcessCommand: () => 'node openclaude 1642 --serve',
      }),
      verifyBackgroundSessionProcessIdentity(session, {
        isProcessAlive: () => true,
        getProcessCommand: () => 'node unrelated --serve',
      }),
      verifyBackgroundSessionProcessIdentity(session, {
        isProcessAlive: () => true,
        getProcessCommand: () => null,
      }),
    ]

    expect(states.map(result => result.state)).toEqual([
      'not-running',
      'matches',
      'mismatch',
      'unreadable',
    ])
    expect(
      states.every(result => result.backgroundSessionId === session.id),
    ).toBe(true)
    expect(states.every(result => result.pid === session.pid)).toBe(true)
  })

  it('treats exit during command lookup as not running', () => {
    let aliveChecks = 0

    const result = verifyBackgroundSessionProcessIdentity(session, {
      isProcessAlive: () => ++aliveChecks === 1,
      getProcessCommand: () => null,
    })

    expect(result.state).toBe('not-running')
    expect(aliveChecks).toBe(2)
  })

  it('treats an access-denied liveness probe as unreadable', () => {
    const result = verifyBackgroundSessionProcessIdentity(session, {
      signalProcess: () => {
        throw Object.assign(new Error('access denied'), { code: 'EPERM' })
      },
      getProcessCommand: () => {
        throw new Error('command lookup must not run without confirmed liveness')
      },
    })

    expect(result.state).toBe('unreadable')
  })

  it('maps throwing injected liveness and command probes to unreadable', () => {
    const livenessError = verifyBackgroundSessionProcessIdentity(session, {
      isProcessAlive: () => {
        throw new Error('private liveness details')
      },
      getProcessCommand: () => 'not read',
    })
    const commandError = verifyBackgroundSessionProcessIdentity(session, {
      isProcessAlive: () => true,
      getProcessCommand: () => {
        throw new Error('private command details')
      },
    })

    expect(livenessError.state).toBe('unreadable')
    expect(commandError.state).toBe('unreadable')
  })

  it('treats empty command output as unreadable', () => {
    for (const command of ['', '   ']) {
      const result = verifyBackgroundSessionProcessIdentity(session, {
        isProcessAlive: () => true,
        getProcessCommand: () => command,
      })

      expect(result.state).toBe('unreadable')
    }
  })
})
