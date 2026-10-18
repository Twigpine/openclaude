import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdir,
  chmod,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  _setBackgroundSessionsRootForTesting,
  createBackgroundSession,
  recordBackgroundSessionNaturalTermination,
} from '../cli/bgRegistry.js'
import { cleanupOldSessionFilesInProjectsDir } from './cleanup.js'
import { NodeFsOperations } from './fsOperations.js'

const tempDirs: string[] = []
const FIXTURE_OUTPUT_LIMIT_BYTES = 64 * 1024
// The production minute-recovery contract caps each pass at 256 records.
const BACKGROUND_RECOVERY_ENTRY_LIMIT = 256

afterEach(async () => {
  _setBackgroundSessionsRootForTesting(undefined)
  await Promise.all(
    tempDirs.splice(0).map(async dir => {
      await chmod(join(dir, 'bg-sessions', 'terminal'), 0o755).catch(() => {})
      await rm(dir, { recursive: true, force: true })
    }),
  )
})

async function readBoundedFixtureOutput(
  stream: ReadableStream<Uint8Array>,
  label: string,
): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > FIXTURE_OUTPUT_LIMIT_BYTES) {
        throw new Error(
          `${label} exceeded ${FIXTURE_OUTPUT_LIMIT_BYTES} bytes`,
        )
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

async function runCleanupFixture(
  configDir: string,
  mode:
    | 'once'
    | 'pass-outcome'
    | 'marker-failure'
    | 'periodic-policy-recheck'
    | 'periodic-recovery'
    | 'periodic-recovery-bounded'
    | 'periodic-retention'
    | 'periodic-retention-policy-recheck'
    | 'post-finalization-gate'
    | 'post-finalization-policy-recheck'
    | 'post-finalization-exact-cutoff'
    | 'post-finalization-timeout'
    | 'explicit-kill' = 'once',
  fixtureEnv: NodeJS.ProcessEnv = {},
  expectedError?: string,
): Promise<Record<string, unknown>> {
  const fixture = join(import.meta.dir, 'cleanupBackgroundSessions.fixture.ts')
  const { USER_TYPE: _userType, ...inheritedEnv } = process.env
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  const child = Bun.spawn([process.execPath, fixture], {
    cwd: configDir,
    env: {
      ...inheritedEnv,
      HOME: configDir,
      XDG_CACHE_HOME: join(configDir, 'cache'),
      OPENCLAUDE_CONFIG_DIR: configDir,
      OPENCLAUDE_CLEANUP_FIXTURE_MODE: mode,
      NODE_ENV: 'test',
      ...fixtureEnv,
    },
    signal: controller.signal,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      readBoundedFixtureOutput(
        child.stdout as ReadableStream<Uint8Array>,
        'cleanup fixture stdout',
      ),
      readBoundedFixtureOutput(
        child.stderr as ReadableStream<Uint8Array>,
        'cleanup fixture stderr',
      ),
    ])
    if (expectedError !== undefined) {
      expect(exitCode, stderr).toBe(1)
      expect(stdout).toBe('')
      expect(stderr).toContain(
        `background cleanup fixture failed: Error: ${expectedError}`,
      )
      expect(stderr).toMatch(
        /\bat .*cleanupBackgroundSessions\.fixture\.ts:\d+:\d+/,
      )
      return {}
    }
    expect(exitCode, stderr).toBe(0)
    const result = JSON.parse(stdout) as Record<string, unknown>
    if (mode === 'once') expect(result).toEqual({ completed: true })
    return result
  } finally {
    clearTimeout(timeout)
    controller.abort()
  }
}

async function createCompletedBackgroundSession(
  configDir: string,
  id: string,
  finishedAt: Date,
  name?: string,
  processMarker?: string,
): Promise<string> {
  const root = join(configDir, 'bg-sessions')
  _setBackgroundSessionsRootForTesting(root)
  await createBackgroundSession({
    id,
    name,
    processMarker,
    pid: process.pid,
    cwd: configDir,
    command: ['openclaude', '--print', 'fixture'],
    sessionId: `${id}-conversation`,
    now: new Date(finishedAt.getTime() - 60_000),
  })
  await recordBackgroundSessionNaturalTermination(
    id,
    { exitCode: 0 },
    { ownerPid: process.pid, now: finishedAt },
  )
  _setBackgroundSessionsRootForTesting(undefined)
  return join(root, 'sessions', `${id}.json`)
}

async function runConcurrentPeriodicRecovery(
  configDir: string,
): Promise<string[]> {
  const fixture = join(import.meta.dir, 'cleanupBackgroundSessions.fixture.ts')
  const { NODE_ENV: _nodeEnv, USER_TYPE: _userType, ...inheritedEnv } =
    process.env
  const runRecovery = async (): Promise<string> => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    const child = Bun.spawn([process.execPath, fixture], {
      cwd: configDir,
      env: {
        ...inheritedEnv,
        HOME: configDir,
        XDG_CACHE_HOME: join(configDir, 'cache'),
        OPENCLAUDE_CONFIG_DIR: configDir,
        OPENCLAUDE_CLEANUP_FIXTURE_MODE: 'periodic-recovery',
      },
      signal: controller.signal,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        readBoundedFixtureOutput(
          child.stdout as ReadableStream<Uint8Array>,
          'periodic recovery stdout',
        ),
        readBoundedFixtureOutput(
          child.stderr as ReadableStream<Uint8Array>,
          'periodic recovery stderr',
        ),
      ])
      expect(exitCode, stderr).toBe(0)
      return (JSON.parse(stdout) as { result: string }).result
    } finally {
      clearTimeout(timeout)
      controller.abort()
    }
  }
  return await Promise.all([runRecovery(), runRecovery()])
}

describe('cleanupOldSessionFiles', () => {
  test('removes old replay sidecars while preserving non-session files', async () => {
    const projectsDir = join(
      tmpdir(),
      `openclaude-cleanup-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      'projects',
    )
    tempDirs.push(projectsDir)

    const projectDir = join(projectsDir, 'project')
    await mkdir(projectDir, { recursive: true })

    const replayPath = join(projectDir, 'session.replay.json')
    const keepPath = join(projectDir, 'session.notes.json')
    await writeFile(replayPath, '{}', 'utf-8')
    await writeFile(keepPath, '{}', 'utf-8')

    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
    await utimes(replayPath, oldDate, oldDate)
    await utimes(keepPath, oldDate, oldDate)

    const result = await cleanupOldSessionFilesInProjectsDir(
      projectsDir,
      new Date(),
      NodeFsOperations,
    )

    expect(result.messages).toBe(1)
    await expect(stat(replayPath)).rejects.toThrow()
    expect((await stat(keepPath)).isFile()).toBe(true)
  })
})

describe('cleanupOldMessageFilesInBackground', () => {
  for (const limit of [
    undefined,
    '',
    '0',
    '-1',
    '1.5',
    'invalid',
    '9007199254740992',
  ]) {
    test(`rejects invalid bounded recovery fixture limit ${JSON.stringify(limit)}`, async () => {
      const configDir = join(
        tmpdir(),
        `openclaude-cleanup-invalid-limit-${Date.now()}-${Math.random()}`,
      )
      tempDirs.push(configDir)
      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'settings.json'),
        JSON.stringify({ cleanupPeriodDays: 0 }),
      )
      const id = 'bg-invalid-limit'
      const metadata = await createCompletedBackgroundSession(
        configDir,
        id,
        new Date(0),
      )
      const root = join(configDir, 'bg-sessions')
      const journal = join(root, '.recovery-journal')
      const before = await readFile(journal, 'utf8')

      await runCleanupFixture(
        configDir,
        'periodic-recovery-bounded',
        { OPENCLAUDE_CLEANUP_RECOVERY_LIMIT: limit },
        'OPENCLAUDE_CLEANUP_RECOVERY_LIMIT must be a positive safe integer',
      )

      expect(await Bun.file(metadata).exists()).toBe(true)
      expect(
        await Bun.file(join(root, 'logs', `${id}.out.log`)).exists(),
      ).toBe(true)
      expect(await readFile(journal, 'utf8')).toBe(before)
      expect(await Bun.file(join(root, '.recovery-pass')).exists()).toBe(false)
      expect(
        await Bun.file(join(root, '.recovery-cursor.json')).exists(),
      ).toBe(false)
    }, 30_000)
  }

  test(
    'globally throttles and bounds concurrent prompt-recovery passes',
    async () => {
      const configDir = join(
        tmpdir(),
        `openclaude-cleanup-bg-bounded-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      )
      tempDirs.push(configDir)
      const root = join(configDir, 'bg-sessions')
      const metadataDir = join(root, 'sessions')
      const logsDir = join(root, 'logs')
      await Promise.all([
        mkdir(metadataDir, { recursive: true }),
        mkdir(logsDir, { recursive: true }),
        mkdir(join(root, 'names'), { recursive: true }),
        mkdir(join(root, 'terminal'), { recursive: true }),
      ])
      await writeFile(
        join(configDir, 'settings.json'),
        JSON.stringify({ cleanupPeriodDays: 0 }),
      )
      const finishedAt = new Date(Date.now() - 60_000).toISOString()
      const ids = Array.from(
        { length: 300 },
        (_, index) => `bg-bounded-${String(index).padStart(3, '0')}`,
      )
      await Promise.all(
        ids.map(async id => {
          const stdoutLogPath = join(logsDir, `${id}.out.log`)
          const stderrLogPath = join(logsDir, `${id}.err.log`)
          await Promise.all([
            writeFile(
              join(metadataDir, `${id}.json`),
              JSON.stringify({
                id,
                pid: 999_999,
                cwd: configDir,
                status: 'exited',
                sessionId: `${id}-conversation`,
                startedAt: new Date(Date.now() - 120_000).toISOString(),
                updatedAt: finishedAt,
                command: ['openclaude', '--print', 'fixture'],
                stdoutLogPath,
                stderrLogPath,
                finishedAt,
                exitCode: 0,
                terminalReason: 'exit_code',
              }),
            ),
            writeFile(stdoutLogPath, ''),
            writeFile(stderrLogPath, ''),
          ])
        }),
      )
      await writeFile(join(root, '.recovery-journal'), `${ids.join('\n')}\n`)

      expect((await runConcurrentPeriodicRecovery(configDir)).sort()).toEqual([
        'ran',
        'skipped',
      ])
      expect(
        (await readdir(metadataDir)).filter(name => name.endsWith('.json')),
      ).toHaveLength(ids.length - BACKGROUND_RECOVERY_ENTRY_LIMIT)
    },
    30_000,
  )

  test(
    'advances bounded recovery past malformed entries across process restarts',
    async () => {
      const configDir = join(
        tmpdir(),
        `openclaude-cleanup-bg-progress-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      )
      tempDirs.push(configDir)
      const root = join(configDir, 'bg-sessions')
      const metadataDir = join(root, 'sessions')
      const logsDir = join(root, 'logs')
      await Promise.all([
        mkdir(metadataDir, { recursive: true }),
        mkdir(logsDir, { recursive: true }),
        mkdir(join(root, 'names'), { recursive: true }),
        mkdir(join(root, 'terminal'), { recursive: true }),
      ])
      await writeFile(
        join(configDir, 'settings.json'),
        JSON.stringify({ cleanupPeriodDays: 0 }),
      )
      for (const id of ['bg-retained-a', 'bg-retained-b']) {
        await writeFile(join(metadataDir, `${id}.json`), '{')
      }
      const targetId = 'bg-progress-target'
      const targetPath = await createCompletedBackgroundSession(
        configDir,
        targetId,
        new Date(Date.now() - 60_000),
      )
      await writeFile(
        join(root, '.recovery-journal'),
        `bg-retained-a\nbg-retained-b\n${targetId}\n`,
      )
      expect(
        await runCleanupFixture(
          configDir,
          'periodic-recovery-bounded',
          { OPENCLAUDE_CLEANUP_RECOVERY_LIMIT: '2' },
        ),
      ).toEqual({ result: 'ran' })
      expect(await Bun.file(targetPath).exists()).toBe(true)
      await rm(join(root, '.recovery-pass'), { force: true })

      expect(
        await runCleanupFixture(
          configDir,
          'periodic-recovery-bounded',
          { OPENCLAUDE_CLEANUP_RECOVERY_LIMIT: '2' },
        ),
      ).toEqual({ result: 'ran' })
      expect(await Bun.file(targetPath).exists()).toBe(false)
    },
    30_000,
  )

  for (const trigger of [
    'periodic-recovery',
    'periodic-retention',
  ] as const) {
    for (const timing of ['before', 'after'] as const) {
      test(`does not acknowledge policy rejected ${timing} the ${trigger} lock`, async () => {
        const configDir = join(
          tmpdir(),
          `openclaude-policy-outcome-${Date.now()}-${Math.random()}`,
        )
        tempDirs.push(configDir)
        await mkdir(configDir, { recursive: true })
        const settingsPath = join(configDir, 'settings.json')
        const validPolicy = JSON.stringify({ cleanupPeriodDays: 0 })
        await writeFile(
          settingsPath,
          timing === 'before'
            ? JSON.stringify({ cleanupPeriodDays: 'invalid' })
            : validPolicy,
        )
        const id = 'bg-rejected-policy'
        const metadataPath = await createCompletedBackgroundSession(
          configDir,
          id,
          new Date(0),
        )
        const root = join(configDir, 'bg-sessions')
        const marker = join(
          root,
          trigger === 'periodic-recovery'
            ? '.recovery-pass'
            : '.retention-pass',
        )
        const journal = join(root, '.recovery-journal')
        const before = await readFile(journal, 'utf8')
        expect(
          await runCleanupFixture(configDir, 'pass-outcome', {
            OPENCLAUDE_CLEANUP_TRIGGER: trigger,
            OPENCLAUDE_CLEANUP_REJECT_AFTER_LOCK:
              timing === 'after' ? '1' : '0',
          }),
        ).toEqual({ result: 'invalid-policy' })
        expect(await Bun.file(metadataPath).exists()).toBe(true)
        expect(await Bun.file(marker).exists()).toBe(false)
        expect(
          await Bun.file(join(root, '.recovery-cursor.json')).exists(),
        ).toBe(false)
        expect(await readFile(journal, 'utf8')).toBe(before)

        await writeFile(settingsPath, validPolicy)
        expect(
          await runCleanupFixture(configDir, 'pass-outcome', {
            OPENCLAUDE_CLEANUP_TRIGGER: trigger,
          }),
        ).toEqual({ result: 'ran' })
        expect(await Bun.file(metadataPath).exists()).toBe(false)
        expect(await readFile(journal, 'utf8')).toBe('')
        expect(await Bun.file(marker).exists()).toBe(true)
        expect(
          await runCleanupFixture(configDir, 'pass-outcome', {
            OPENCLAUDE_CLEANUP_TRIGGER: trigger,
          }),
        ).toEqual({ result: 'skipped' })
        await rm(marker)
        expect(
          await runCleanupFixture(configDir, 'pass-outcome', {
            OPENCLAUDE_CLEANUP_TRIGGER: trigger,
          }),
        ).toEqual({ result: 'ran' })
        expect(await Bun.file(marker).exists()).toBe(true)
      }, 30_000)
    }

    for (const failure of [
      'names-directory',
      'log-unlink',
      'terminal-unlink',
      'marked-terminal-unlink',
    ] as const) {
      const terminalFailure = failure.endsWith('terminal-unlink')
      test.skipIf(
        terminalFailure &&
          (process.platform === 'win32' || process.geteuid?.() === 0),
      )(`retries ${failure} after a partial ${trigger} pass in a new process`, async () => {
        const configDir = join(
          tmpdir(),
          `openclaude-retry-outcome-${Date.now()}-${Math.random()}`,
        )
        tempDirs.push(configDir)
        await mkdir(configDir, { recursive: true })
        await writeFile(
          join(configDir, 'settings.json'),
          JSON.stringify({ cleanupPeriodDays: 0 }),
        )
        const root = join(configDir, 'bg-sessions')
        const id = 'bg-retryable'
        const metadata = await createCompletedBackgroundSession(
          configDir,
          id,
          new Date(0),
          'retryable',
          failure === 'marked-terminal-unlink' ? 'a'.repeat(64) : undefined,
        )
        const eligible = await createCompletedBackgroundSession(
          configDir,
          'bg-independent',
          new Date(0),
        )
        const malformed = join(root, 'sessions', 'bg-malformed.json')
        await writeFile(malformed, '{invalid')
        const journal = join(root, '.recovery-journal')
        // A full sweep must also recover work whose original journal append failed.
        await writeFile(
          journal,
          trigger === 'periodic-retention'
            ? ''
            : `bg-malformed\n${id}\nbg-independent\n`,
        )
        const brokenPath = terminalFailure
          ? join(root, 'terminal')
          : failure === 'names-directory'
            ? join(root, 'names')
            : join(root, 'logs', `${id}.out.log`)
        if (terminalFailure) {
          await chmod(brokenPath, 0o555)
        } else {
          await rm(brokenPath, { recursive: true, force: true })
          if (failure === 'names-directory')
            await writeFile(brokenPath, 'not a directory')
          else await mkdir(brokenPath)
        }
        const marker = join(
          root,
          trigger === 'periodic-recovery'
            ? '.recovery-pass'
            : '.retention-pass',
        )

        expect(
          await runCleanupFixture(configDir, 'pass-outcome', {
            OPENCLAUDE_CLEANUP_TRIGGER: trigger,
          }),
        ).toEqual({ result: 'partial' })
        expect(await Bun.file(metadata).exists()).toBe(!terminalFailure)
        expect(await Bun.file(eligible).exists()).toBe(false)
        expect(await readFile(malformed, 'utf8')).toBe('{invalid')
        expect(await readFile(journal, 'utf8')).toContain(id)
        if (
          failure === 'names-directory' &&
          trigger === 'periodic-recovery'
        ) {
          expect(await readFile(journal, 'utf8')).toBe(`${id}\n`)
        }
        expect(await Bun.file(marker).exists()).toBe(true)

        if (terminalFailure) await chmod(brokenPath, 0o755)
        else {
          await rm(brokenPath, { recursive: true, force: true })
          if (failure === 'names-directory') await mkdir(brokenPath)
        }
        expect(
          await runCleanupFixture(configDir, 'pass-outcome', {
            OPENCLAUDE_CLEANUP_TRIGGER: trigger,
          }),
        ).toEqual({ result: 'skipped' })
        await rm(marker)
        expect(
          await runCleanupFixture(configDir, 'pass-outcome', {
            OPENCLAUDE_CLEANUP_TRIGGER: terminalFailure
              ? 'periodic-recovery'
              : trigger,
          }),
        ).toEqual({ result: 'ran' })
        expect(await Bun.file(metadata).exists()).toBe(false)
        expect(await readdir(join(root, 'terminal'))).toEqual([])
        expect(await readFile(journal, 'utf8')).toBe('')
        expect(
          await Bun.file(join(root, '.recovery-cursor.json')).exists(),
        ).toBe(false)
        expect(
          await Bun.file(
            terminalFailure ? join(root, '.recovery-pass') : marker,
          ).exists(),
        ).toBe(true)
      }, 30_000)
    }
  }

  for (const trigger of [
    'periodic-recovery',
    'periodic-retention',
  ] as const) {
    test(`acknowledges unnamed work despite a broken names directory during ${trigger}`, async () => {
      const configDir = join(
        tmpdir(),
        `openclaude-unnamed-retry-${Date.now()}-${Math.random()}`,
      )
      tempDirs.push(configDir)
      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'settings.json'),
        JSON.stringify({ cleanupPeriodDays: 0 }),
      )
      const metadata = await createCompletedBackgroundSession(
        configDir,
        'bg-unnamed',
        new Date(0),
      )
      const root = join(configDir, 'bg-sessions')
      await rm(join(root, 'names'), { recursive: true, force: true })
      await writeFile(join(root, 'names'), 'not a directory')
      expect(
        await runCleanupFixture(configDir, 'pass-outcome', {
          OPENCLAUDE_CLEANUP_TRIGGER: trigger,
        }),
      ).toEqual({ result: 'ran' })
      expect(await Bun.file(metadata).exists()).toBe(false)
      expect(await readFile(join(root, '.recovery-journal'), 'utf8')).toBe('')
    }, 30_000)
  }

  test('queues recent reconciliation failures that were absent from the journal', async () => {
    const configDir = join(
      tmpdir(),
      `openclaude-reconcile-retry-${Date.now()}-${Math.random()}`,
    )
    tempDirs.push(configDir)
    await mkdir(configDir, { recursive: true })
    await writeFile(
      join(configDir, 'settings.json'),
      JSON.stringify({ cleanupPeriodDays: 30 }),
    )
    const id = 'bg-recent-reconcile'
    const generation = 'b'.repeat(64)
    const metadata = await createCompletedBackgroundSession(
      configDir,
      id,
      new Date(),
      'recent-reconcile',
      generation,
    )
    const root = join(configDir, 'bg-sessions')
    await writeFile(join(root, '.recovery-journal'), '')
    await rm(join(root, 'names'), { recursive: true, force: true })
    await writeFile(join(root, 'names'), 'not a directory')
    expect(await runCleanupFixture(configDir, 'periodic-retention')).toEqual({
      result: 'partial',
    })
    expect(await Bun.file(metadata).exists()).toBe(true)
    expect(await readFile(join(root, '.recovery-journal'), 'utf8')).toBe(
      `${id}~${generation}\n`,
    )
    await rm(join(root, 'names'))
    await mkdir(join(root, 'names'))
    await rm(join(root, '.retention-pass'))
    expect(await runCleanupFixture(configDir, 'periodic-retention')).toEqual({
      result: 'ran',
    })
    expect(await Bun.file(metadata).exists()).toBe(true)
    expect(await readFile(join(root, '.recovery-journal'), 'utf8')).toBe('')
  }, 30_000)

  test('reports an interrupted full sweep without acknowledging its snapshot', async () => {
    const configDir = join(
      tmpdir(),
      `openclaude-failed-outcome-${Date.now()}-${Math.random()}`,
    )
    tempDirs.push(configDir)
    await mkdir(configDir, { recursive: true })
    await writeFile(
      join(configDir, 'settings.json'),
      JSON.stringify({ cleanupPeriodDays: 0 }),
    )
    const metadata = await createCompletedBackgroundSession(
      configDir,
      'bg-before-interruption',
      new Date(0),
    )
    const root = join(configDir, 'bg-sessions')
    expect(
      await runCleanupFixture(configDir, 'pass-outcome', {
        OPENCLAUDE_CLEANUP_TRIGGER: 'periodic-retention',
        OPENCLAUDE_CLEANUP_APPEND_AFTER_SNAPSHOT: '1',
        OPENCLAUDE_CLEANUP_THROW_AFTER_SNAPSHOT: '1',
      }),
    ).toEqual({ result: 'failed' })
    expect(await Bun.file(metadata).exists()).toBe(true)
    expect(await readFile(join(root, '.recovery-journal'), 'utf8')).toBe(
      'bg-before-interruption\nbg-snapshot-appended\n',
    )
    expect(await Bun.file(join(root, '.retention-pass')).exists()).toBe(false)
    expect(await runCleanupFixture(configDir, 'periodic-retention')).toEqual({
      result: 'ran',
    })
    expect(await Bun.file(metadata).exists()).toBe(false)
    expect(await readFile(join(root, '.recovery-journal'), 'utf8')).toBe('')
    expect(await readdir(join(root, 'terminal'))).toEqual([])
  }, 30_000)

  test('does not throttle a full sweep when its retry inventory is unreadable', async () => {
    const configDir = join(
      tmpdir(),
      `openclaude-failed-inventory-${Date.now()}-${Math.random()}`,
    )
    tempDirs.push(configDir)
    await mkdir(configDir, { recursive: true })
    await writeFile(
      join(configDir, 'settings.json'),
      JSON.stringify({ cleanupPeriodDays: 0 }),
    )
    const metadata = await createCompletedBackgroundSession(
      configDir,
      'bg-unreadable-inventory',
      new Date(0),
    )
    const root = join(configDir, 'bg-sessions')
    const directory = join(root, 'sessions')
    const saved = join(root, 'saved-sessions')
    await rename(directory, saved)
    await writeFile(directory, 'not a directory')
    expect(await runCleanupFixture(configDir, 'periodic-retention')).toEqual({
      result: 'failed',
    })
    expect(await Bun.file(join(root, '.retention-pass')).exists()).toBe(false)
    expect(await readFile(join(root, '.recovery-journal'), 'utf8')).toBe(
      'bg-unreadable-inventory\n',
    )
    await rm(directory)
    await rename(saved, directory)
    expect(await runCleanupFixture(configDir, 'periodic-retention')).toEqual({
      result: 'ran',
    })
    expect(await Bun.file(metadata).exists()).toBe(false)
    expect(await readFile(join(root, '.recovery-journal'), 'utf8')).toBe('')
  }, 30_000)

  test('acknowledges only the full-sweep snapshot while preserving a concurrent append', async () => {
    const configDir = join(
      tmpdir(),
      `openclaude-snapshot-outcome-${Date.now()}-${Math.random()}`,
    )
    tempDirs.push(configDir)
    await mkdir(configDir, { recursive: true })
    await writeFile(
      join(configDir, 'settings.json'),
      JSON.stringify({ cleanupPeriodDays: 30 }),
    )
    const metadata = await createCompletedBackgroundSession(
      configDir,
      'bg-snapshot-old',
      new Date(0),
    )
    expect(
      await runCleanupFixture(configDir, 'pass-outcome', {
        OPENCLAUDE_CLEANUP_TRIGGER: 'periodic-retention',
        OPENCLAUDE_CLEANUP_APPEND_AFTER_SNAPSHOT: '1',
      }),
    ).toEqual({ result: 'ran' })
    const root = join(configDir, 'bg-sessions')
    expect(await Bun.file(metadata).exists()).toBe(false)
    expect(
      await Bun.file(
        join(root, 'sessions', 'bg-snapshot-appended.json'),
      ).exists(),
    ).toBe(true)
    expect(await readFile(join(root, '.recovery-journal'), 'utf8')).toBe(
      'bg-snapshot-appended\n',
    )
    expect(await Bun.file(join(root, '.retention-pass')).exists()).toBe(true)
    await writeFile(
      join(configDir, 'settings.json'),
      JSON.stringify({ cleanupPeriodDays: 0 }),
    )
    expect(await runCleanupFixture(configDir, 'periodic-recovery')).toEqual({
      result: 'ran',
    })
    expect(
      await Bun.file(
        join(root, 'sessions', 'bg-snapshot-appended.json'),
      ).exists(),
    ).toBe(false)
    expect(await readFile(join(root, '.recovery-journal'), 'utf8')).toBe('')
  }, 30_000)

  for (const scenario of [
    { label: 'positive', setting: 30, result: 'ran' },
    { label: 'invalid', setting: 'invalid', result: 'invalid-policy' },
  ] as const) {
    test(
      `keeps periodic recovery non-destructive with ${scenario.label} retention`,
      async () => {
        const configDir = join(
          tmpdir(),
          `openclaude-cleanup-bg-periodic-${scenario.label}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        )
        tempDirs.push(configDir)
        await mkdir(configDir, { recursive: true })
        await writeFile(
          join(configDir, 'settings.json'),
          JSON.stringify({ cleanupPeriodDays: scenario.setting }),
        )
        const metadataPath = await createCompletedBackgroundSession(
          configDir,
          `bg-periodic-${scenario.label}`,
          new Date(Date.now() - 60_000),
        )

        expect(
          await runCleanupFixture(configDir, 'periodic-recovery'),
        ).toEqual({ result: scenario.result })
        expect(await Bun.file(metadataPath).exists()).toBe(true)
        expect(
          await Bun.file(
            join(configDir, 'bg-sessions', '.recovery-pass'),
          ).exists(),
        ).toBe(scenario.result === 'ran')
      },
      30_000,
    )
  }

  test(
    'compacts the recovery journal after a positive-retention full sweep',
    async () => {
      const configDir = join(
        tmpdir(),
        `openclaude-cleanup-bg-journal-compact-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      )
      tempDirs.push(configDir)
      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'settings.json'),
        JSON.stringify({ cleanupPeriodDays: 30 }),
      )
      const metadataPath = await createCompletedBackgroundSession(
        configDir,
        'bg-journal-compact',
        new Date(Date.now() - 60_000),
      )
      const journalPath = join(
        configDir,
        'bg-sessions',
        '.recovery-journal',
      )
      expect((await readFile(journalPath, 'utf8')).length).toBeGreaterThan(0)

      expect(
        await runCleanupFixture(configDir, 'periodic-retention'),
      ).toEqual({ result: 'ran' })
      expect(await Bun.file(metadataPath).exists()).toBe(true)
      expect(await readFile(journalPath, 'utf8')).toBe('')
    },
    30_000,
  )

  test(
    'fails the recurring retention owner closed on project MCP errors',
    async () => {
      const configDir = join(
        tmpdir(),
        `openclaude-cleanup-bg-daily-invalid-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      )
      tempDirs.push(configDir)
      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'settings.json'),
        JSON.stringify({ cleanupPeriodDays: 30 }),
      )
      await writeFile(join(configDir, '.mcp.json'), '{invalid')
      const metadataPath = await createCompletedBackgroundSession(
        configDir,
        'bg-daily-invalid-policy',
        new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      )

      expect(
        await runCleanupFixture(configDir, 'periodic-retention'),
      ).toEqual({ result: 'invalid-policy' })
      expect(await Bun.file(metadataPath).exists()).toBe(true)
      expect(
        await Bun.file(
          join(configDir, 'bg-sessions', '.retention-pass'),
        ).exists(),
      ).toBe(false)
    },
    30_000,
  )

  test(
    'rechecks project MCP errors after acquiring the daily retention lock',
    async () => {
      const configDir = join(
        tmpdir(),
        `openclaude-cleanup-bg-daily-recheck-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      )
      tempDirs.push(configDir)
      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'settings.json'),
        JSON.stringify({ cleanupPeriodDays: 30 }),
      )
      const metadataPath = await createCompletedBackgroundSession(
        configDir,
        'bg-daily-policy-recheck',
        new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      )

      expect(
        await runCleanupFixture(
          configDir,
          'periodic-retention-policy-recheck',
        ),
      ).toEqual({ result: 'invalid-policy' })
      expect(await Bun.file(metadataPath).exists()).toBe(true)
      expect(await Bun.file(join(configDir, 'bg-sessions', '.retention-pass')).exists()).toBe(false)
      await rm(join(configDir, '.mcp.json'))
      expect(await runCleanupFixture(configDir, 'periodic-retention')).toEqual({ result: 'ran' })
      expect(await Bun.file(metadataPath).exists()).toBe(false)
    },
    30_000,
  )

  test(
    'rechecks periodic retention policy after acquiring the global lock',
    async () => {
      const configDir = join(
        tmpdir(),
        `openclaude-cleanup-bg-periodic-recheck-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      )
      tempDirs.push(configDir)
      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'settings.json'),
        JSON.stringify({ cleanupPeriodDays: 0 }),
      )

      expect(
        await runCleanupFixture(configDir, 'periodic-policy-recheck'),
      ).toEqual({ result: 'ran', metadataPresent: true })
    },
    30_000,
  )

  test(
    'continues later cleanup stages when the retention marker cannot be created',
    async () => {
      const configDir = join(
        tmpdir(),
        `openclaude-cleanup-bg-marker-failure-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      )
      tempDirs.push(configDir)
      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'settings.json'),
        JSON.stringify({ cleanupPeriodDays: 0 }),
      )

      expect(
        await runCleanupFixture(configDir, 'marker-failure'),
      ).toEqual({ completed: true, planPresent: false })
    },
    30_000,
  )

  test(
    'removes old completed background-session artifacts through the scheduler',
    async () => {
      const configDir = join(
        tmpdir(),
        `openclaude-cleanup-bg-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      )
      tempDirs.push(configDir)
      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'settings.json'),
        JSON.stringify({ cleanupPeriodDays: 30 }),
      )
      const metadataPath = await createCompletedBackgroundSession(
        configDir,
        'bg-scheduler-old',
        new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      )

      await runCleanupFixture(configDir)

      expect(await Bun.file(metadataPath).exists()).toBe(false)
      expect(
        await Bun.file(
          join(configDir, 'bg-sessions', '.retention-pass'),
        ).exists(),
      ).toBe(true)
    },
    30_000,
  )

  test(
    'uses cleanupPeriodDays zero for completed background sessions',
    async () => {
      const configDir = join(
        tmpdir(),
        `openclaude-cleanup-bg-zero-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      )
      tempDirs.push(configDir)
      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'settings.json'),
        JSON.stringify({ cleanupPeriodDays: 0 }),
      )
      const metadataPath = await createCompletedBackgroundSession(
        configDir,
        'bg-scheduler-zero',
        new Date(Date.now() - 1_000),
      )

      await runCleanupFixture(configDir)

      expect(await Bun.file(metadataPath).exists()).toBe(false)
    },
    30_000,
  )

  test(
    'includes the finalization millisecond in zero-day cleanup',
    async () => {
      const configDir = join(
        tmpdir(),
        `openclaude-cleanup-bg-exact-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      )
      tempDirs.push(configDir)
      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'settings.json'),
        JSON.stringify({ cleanupPeriodDays: 0 }),
      )

      expect(
        await runCleanupFixture(
          configDir,
          'post-finalization-exact-cutoff',
        ),
      ).toEqual({
        waits: 1,
        metadataPresent: false,
        reservationPresent: false,
        stdoutPresent: false,
        stderrPresent: false,
      })
    },
    30_000,
  )

  test(
    'retains zero-day artifacts when worker ownership exit is unobserved',
    async () => {
      const configDir = join(
        tmpdir(),
        `openclaude-cleanup-bg-timeout-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      )
      tempDirs.push(configDir)
      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'settings.json'),
        JSON.stringify({ cleanupPeriodDays: 0 }),
      )

      expect(
        await runCleanupFixture(configDir, 'post-finalization-timeout'),
      ).toEqual({
        waits: 1,
        metadataPresent: true,
        reservationPresent: false,
        stdoutPresent: true,
        stderrPresent: true,
      })
    },
    30_000,
  )

  test(
    'rechecks the originating settings policy after process handoff',
    async () => {
      const configDir = join(
        tmpdir(),
        `openclaude-cleanup-bg-policy-recheck-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      )
      tempDirs.push(configDir)
      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'settings.json'),
        JSON.stringify({ cleanupPeriodDays: 0 }),
      )

      expect(
        await runCleanupFixture(
          configDir,
          'post-finalization-policy-recheck',
        ),
      ).toEqual({
        result: 'skipped',
        waits: 1,
        reloads: 1,
        metadataPresent: true,
      })
    },
    30_000,
  )

  test(
    'reclaims zero-day artifacts after an explicit kill transition',
    async () => {
      const configDir = join(
        tmpdir(),
        `openclaude-cleanup-bg-kill-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      )
      tempDirs.push(configDir)
      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'settings.json'),
        JSON.stringify({ cleanupPeriodDays: 0 }),
      )

      expect(await runCleanupFixture(configDir, 'explicit-kill')).toEqual({
        metadataPresent: false,
        stdoutPresent: false,
        stderrPresent: false,
      })
    },
    30_000,
  )

  for (const setting of [30, 'invalid'] as const) {
    test(
      `does not wait for post-finalization cleanup with ${String(setting)} retention`,
      async () => {
        const configDir = join(
          tmpdir(),
          `openclaude-cleanup-bg-gate-${String(setting)}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        )
        tempDirs.push(configDir)
        await mkdir(configDir, { recursive: true })
        await writeFile(
          join(configDir, 'settings.json'),
          JSON.stringify({ cleanupPeriodDays: setting }),
        )

        expect(
          await runCleanupFixture(configDir, 'post-finalization-gate'),
        ).toEqual({ waits: 0 })
      },
      30_000,
    )
  }

  test(
    'preserves background artifacts when explicit cleanupPeriodDays is invalid',
    async () => {
      const configDir = join(
        tmpdir(),
        `openclaude-cleanup-bg-invalid-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      )
      tempDirs.push(configDir)
      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'settings.json'),
        JSON.stringify({ cleanupPeriodDays: 'invalid' }),
      )
      const metadataPath = await createCompletedBackgroundSession(
        configDir,
        'bg-scheduler-invalid',
        new Date('2026-06-01T00:00:00.000Z'),
      )

      await runCleanupFixture(configDir)

      expect(await Bun.file(metadataPath).exists()).toBe(true)
    },
    30_000,
  )

  test(
    'retains recent background sessions under a nonzero cleanup period',
    async () => {
      const configDir = join(
        tmpdir(),
        `openclaude-cleanup-bg-recent-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      )
      tempDirs.push(configDir)
      await mkdir(configDir, { recursive: true })
      await writeFile(
        join(configDir, 'settings.json'),
        JSON.stringify({ cleanupPeriodDays: 30 }),
      )
      const oldMetadataPath = await createCompletedBackgroundSession(
        configDir,
        'bg-scheduler-old-pair',
        new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      )
      const recentMetadataPath = await createCompletedBackgroundSession(
        configDir,
        'bg-scheduler-recent',
        new Date(Date.now() - 60_000),
      )

      await runCleanupFixture(configDir)

      expect(await Bun.file(oldMetadataPath).exists()).toBe(false)
      expect(await Bun.file(recentMetadataPath).exists()).toBe(true)
    },
    30_000,
  )
})
