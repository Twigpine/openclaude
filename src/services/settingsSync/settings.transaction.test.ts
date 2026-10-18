import { spawn, type ChildProcessByStdio } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { expect, test } from 'bun:test'
import { getOriginalCwd, setOriginalCwd } from '../../bootstrap/state.js'
import {
  getClaudeConfigHomeDirOverrideForTesting,
  setClaudeConfigHomeDirForTesting,
} from '../../utils/envUtils.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import {
  _applyRemoteEntriesToLocalForTesting,
  _setDownloadedEntriesForTesting,
  downloadUserSettings,
  redownloadUserSettings,
} from './index.js'
import { SYNC_KEYS } from './types.js'

const fixturePath = resolve(
  import.meta.dir,
  '../../test/fixtures/settingsTransactionWriter.fixture.ts',
)
const CHILD_TIMEOUT_MS = 15_000
const TEST_TIMEOUT_MS = CHILD_TIMEOUT_MS + 5_000

type Holder = {
  process: ChildProcessByStdio<null, Readable, Readable>
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  output: () => { stdout: string; stderr: string }
}

function startHolder(
  targetPath: string,
  holdMs: number,
  enteredMarker: string,
  completedMarker: string,
): Holder {
  const child = spawn(
    process.execPath,
    [
      fixturePath,
      'hold-path-for',
      targetPath,
      'unused',
      String(holdMs),
      enteredMarker,
      completedMarker,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    stdout += chunk
  })
  child.stderr.on('data', chunk => {
    stderr += chunk
  })
  return {
    process: child,
    exited: new Promise(resolveExit => {
      child.once('exit', (code, signal) => resolveExit({ code, signal }))
    }),
    output: () => ({ stdout, stderr }),
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms))
}

async function waitForHolder(marker: string, holder: Holder): Promise<void> {
  const deadline = performance.now() + CHILD_TIMEOUT_MS
  while (!existsSync(marker)) {
    if (
      holder.process.exitCode !== null ||
      holder.process.signalCode !== null
    ) {
      const { stdout, stderr } = holder.output()
      throw new Error(
        `Holder exited before acquiring the lock\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      )
    }
    if (performance.now() >= deadline) {
      throw new Error('Timed out waiting for holder to acquire the lock')
    }
    await delay(10)
  }
}

async function finishHolder(holder: Holder): Promise<void> {
  const outcome = await Promise.race([
    holder.exited,
    delay(CHILD_TIMEOUT_MS).then(() => {
      throw new Error('Holder did not exit')
    }),
  ])
  const { stdout, stderr } = holder.output()
  if (outcome.code !== 0) {
    throw new Error(
      `Holder exited with code ${outcome.code ?? 'null'} and signal ${outcome.signal ?? 'none'}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    )
  }
}

async function terminateHolder(holder: Holder | undefined): Promise<void> {
  if (
    !holder ||
    holder.process.exitCode !== null ||
    holder.process.signalCode !== null
  ) {
    return
  }
  holder.process.kill('SIGTERM')
  await Promise.race([holder.exited, delay(500)])
  if (
    holder.process.exitCode === null &&
    holder.process.signalCode === null
  ) {
    holder.process.kill('SIGKILL')
    await holder.exited
  }
}

async function withSyncEnvironment(
  run: (paths: {
    root: string
    userSettings: string
    userMemory: string
    localSettings: string
  }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'openclaude-settings-sync-'))
  const project = join(root, 'project')
  const previousConfig = getClaudeConfigHomeDirOverrideForTesting()
  const previousCwd = getOriginalCwd()
  mkdirSync(project)
  setClaudeConfigHomeDirForTesting(root)
  setOriginalCwd(project)
  resetSettingsCache()
  try {
    await run({
      root,
      userSettings: join(root, 'settings.json'),
      userMemory: join(root, 'CLAUDE.md'),
      localSettings: join(project, '.openclaude', 'settings.local.json'),
    })
  } finally {
    setClaudeConfigHomeDirForTesting(previousConfig)
    setOriginalCwd(previousCwd)
    resetSettingsCache()
    rmSync(root, { recursive: true, force: true })
  }
}

test(
  'user settings sync waits for the shared transaction lock and succeeds',
  async () => {
    await withSyncEnvironment(async ({ root, userSettings }) => {
      writeFileSync(userSettings, '{}\n')
      const entered = join(root, 'user-holder-entered')
      const completed = join(root, 'user-holder-completed')
      const holder = startHolder(userSettings, 1_000, entered, completed)
      try {
        await waitForHolder(entered, holder)
        const startedAt = performance.now()
        const result = await _applyRemoteEntriesToLocalForTesting(
          {
            [SYNC_KEYS.USER_SETTINGS]: '{"env":{"SYNCED":"yes"}}\n',
          },
          null,
        )
        const elapsedMs = performance.now() - startedAt

        expect(result).toEqual({
          appliedCount: 1,
          settingsFilesWritten: 1,
          settingsFilesFailed: 0,
          settingsFilesRejected: 0,
          memoryFilesWritten: 0,
        })
        expect(elapsedMs).toBeGreaterThanOrEqual(500)
        expect(JSON.parse(readFileSync(userSettings, 'utf8')).env).toEqual({
          SYNCED: 'yes',
        })
        await finishHolder(holder)
        expect(existsSync(`${userSettings}.lock`)).toBe(false)
      } finally {
        await terminateHolder(holder)
      }
    })
  },
  TEST_TIMEOUT_MS,
)

test(
  'local settings sync uses the same physical-target lock',
  async () => {
    await withSyncEnvironment(async ({ root, localSettings }) => {
      mkdirSync(dirname(localSettings), { recursive: true })
      writeFileSync(localSettings, '{}\n')
      const entered = join(root, 'local-holder-entered')
      const completed = join(root, 'local-holder-completed')
      const holder = startHolder(localSettings, 1_000, entered, completed)
      try {
        await waitForHolder(entered, holder)
        const result = await _applyRemoteEntriesToLocalForTesting(
          {
            [SYNC_KEYS.projectSettings('project-id')]:
              '{"env":{"LOCAL_SYNCED":"yes"}}\n',
          },
          'project-id',
        )

        expect(result).toEqual({
          appliedCount: 1,
          settingsFilesWritten: 1,
          settingsFilesFailed: 0,
          settingsFilesRejected: 0,
          memoryFilesWritten: 0,
        })
        expect(JSON.parse(readFileSync(localSettings, 'utf8')).env).toEqual({
          LOCAL_SYNCED: 'yes',
        })
        await finishHolder(holder)
        expect(existsSync(`${localSettings}.lock`)).toBe(false)
      } finally {
        await terminateHolder(holder)
      }
    })
  },
  TEST_TIMEOUT_MS,
)

test(
  'a timed-out settings entry is not reported applied and memory still syncs',
  async () => {
    await withSyncEnvironment(async ({ root, userMemory, userSettings }) => {
      writeFileSync(userSettings, '{"env":{"ORIGINAL":"yes"}}\n')
      const entered = join(root, 'timeout-holder-entered')
      const completed = join(root, 'timeout-holder-completed')
      const holder = startHolder(userSettings, 4_500, entered, completed)
      try {
        await waitForHolder(entered, holder)
        const result = await _applyRemoteEntriesToLocalForTesting(
          {
            [SYNC_KEYS.USER_SETTINGS]: '{"env":{"REPLACED":"no"}}\n',
            [SYNC_KEYS.USER_MEMORY]: 'synced memory\n',
          },
          null,
        )

        expect(result).toEqual({
          appliedCount: 1,
          settingsFilesWritten: 0,
          settingsFilesFailed: 1,
          settingsFilesRejected: 0,
          memoryFilesWritten: 1,
        })
        expect(JSON.parse(readFileSync(userSettings, 'utf8')).env).toEqual({
          ORIGINAL: 'yes',
        })
        expect(readFileSync(userMemory, 'utf8')).toBe('synced memory\n')
        await finishHolder(holder)

        expect(
          await _applyRemoteEntriesToLocalForTesting(
            {
              [SYNC_KEYS.USER_SETTINGS]: '{"env":{"LATER":"yes"}}\n',
            },
            null,
          ),
        ).toEqual({
          appliedCount: 1,
          settingsFilesWritten: 1,
          settingsFilesFailed: 0,
          settingsFilesRejected: 0,
          memoryFilesWritten: 0,
        })
        expect(JSON.parse(readFileSync(userSettings, 'utf8')).env).toEqual({
          LATER: 'yes',
        })
        expect(existsSync(`${userSettings}.lock`)).toBe(false)
      } finally {
        await terminateHolder(holder)
      }
    })
  },
  TEST_TIMEOUT_MS,
)

test('permanent settings rejections are reported without retry failure', async () => {
  await withSyncEnvironment(async ({ userSettings }) => {
    const oversizedSettings = 'x'.repeat(500 * 1024 + 1)
    const entries = {
      [SYNC_KEYS.USER_SETTINGS]: oversizedSettings,
      [SYNC_KEYS.projectSettings('project-id')]: oversizedSettings,
    }

    expect(
      await _applyRemoteEntriesToLocalForTesting(entries, 'project-id'),
    ).toEqual({
      appliedCount: 0,
      settingsFilesWritten: 0,
      settingsFilesFailed: 0,
      settingsFilesRejected: 2,
      memoryFilesWritten: 0,
    })
    expect(existsSync(userSettings)).toBe(false)

    try {
      _setDownloadedEntriesForTesting({ entries, projectId: 'project-id' })
      expect(await redownloadUserSettings()).toBe(true)
    } finally {
      _setDownloadedEntriesForTesting(null)
    }
  })
})

test(
  'startup and reload downloads return false after a timed-out settings apply',
  async () => {
    await withSyncEnvironment(async ({ root, userMemory, userSettings }) => {
      writeFileSync(userSettings, '{"env":{"ORIGINAL":"yes"}}\n')
      const entered = join(root, 'download-holder-entered')
      const completed = join(root, 'download-holder-completed')
      const holder = startHolder(userSettings, 9_000, entered, completed)
      try {
        await waitForHolder(entered, holder)
        _setDownloadedEntriesForTesting({
          entries: {
            [SYNC_KEYS.USER_SETTINGS]: '{"env":{"REPLACED":"no"}}\n',
            [SYNC_KEYS.USER_MEMORY]: 'best-effort memory\n',
          },
          projectId: null,
        })

        const startupDownload = downloadUserSettings()
        expect(downloadUserSettings()).toBe(startupDownload)
        expect(await startupDownload).toBe(false)
        expect(await redownloadUserSettings()).toBe(false)

        expect(JSON.parse(readFileSync(userSettings, 'utf8')).env).toEqual({
          ORIGINAL: 'yes',
        })
        expect(readFileSync(userMemory, 'utf8')).toBe('best-effort memory\n')
        await finishHolder(holder)
        expect(existsSync(`${userSettings}.lock`)).toBe(false)
      } finally {
        _setDownloadedEntriesForTesting(null)
        await terminateHolder(holder)
      }
    })
  },
  TEST_TIMEOUT_MS,
)
