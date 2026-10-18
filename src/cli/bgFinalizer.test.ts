import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { isProcessRunning } from '../utils/genericProcessUtils.js'
import {
  BACKGROUND_SESSION_ID_ENV,
  BACKGROUND_SESSION_LAUNCHER_PID_ENV,
  prepareBackgroundSessionFinalizer,
  startBackgroundSessionCleanupWorker,
} from './bgFinalizer.js'
import { buildBackgroundChildProcessConfig } from './bg.js'
import {
  BACKGROUND_PROCESS_MARKER_FLAG,
  backgroundProcessMarkerToken,
  isValidBackgroundProcessMarker,
} from './bgRouting.js'
import {
  _setBackgroundSessionsRootForTesting,
  listBackgroundSessions,
  refreshBackgroundSessionStatuses,
  verifyBackgroundSessionProcessIdentity,
  type BackgroundSession,
} from './bgRegistry.js'

const fixturePath = join(import.meta.dir, 'bgFinalizer.fixture.ts')
const installedLauncherPath = join(import.meta.dir, '../../bin/openclaude')
const BACKGROUND_SESSION_CLEANUP_WORKER_ENV =
  'OPENCLAUDE_INTERNAL_BACKGROUND_CLEANUP_WORKER'
const BACKGROUND_SESSION_CLEANUP_OWNER_PID_ENV =
  'OPENCLAUDE_INTERNAL_BACKGROUND_CLEANUP_OWNER_PID'
const FIXTURE_OUTPUT_LIMIT_BYTES = 64 * 1024

describe('background session finalizer', () => {
  let configDir: string
  let sessionsRoot: string

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'openclaude-bg-finalizer-'))
    sessionsRoot = join(configDir, 'bg-sessions')
    _setBackgroundSessionsRootForTesting(sessionsRoot)
  })

  afterEach(async () => {
    _setBackgroundSessionsRootForTesting(undefined)
    await rm(configDir, { recursive: true, force: true })
  })

  function ownedSession(id: string, pid: number): BackgroundSession {
    return {
      id,
      pid,
      cwd: '/repo',
      status: 'running',
      sessionId: `conversation-${id}`,
      startedAt: '2026-08-15T08:00:00.000Z',
      updatedAt: '2026-08-15T08:00:00.000Z',
      command: ['openclaude', '--print', 'work'],
      stdoutLogPath: '/tmp/stdout.log',
      stderrLogPath: '/tmp/stderr.log',
    }
  }

  it('ignores missing and invalid private routing metadata', async () => {
    expect(
      await prepareBackgroundSessionFinalizer({ env: {} }),
    ).toBe('not-background')

    const partialEnv = {
      [BACKGROUND_SESSION_LAUNCHER_PID_ENV]: '123',
    }
    expect(
      await prepareBackgroundSessionFinalizer({ env: partialEnv }),
    ).toBe('invalid-routing')
    expect(partialEnv[BACKGROUND_SESSION_LAUNCHER_PID_ENV]).toBeUndefined()

    const env = {
      [BACKGROUND_SESSION_ID_ENV]: '../unsafe',
      [BACKGROUND_SESSION_LAUNCHER_PID_ENV]: '123',
    }
    expect(await prepareBackgroundSessionFinalizer({ env })).toBe(
      'invalid-routing',
    )
    expect(env[BACKGROUND_SESSION_ID_ENV]).toBeUndefined()
    expect(env[BACKGROUND_SESSION_LAUNCHER_PID_ENV]).toBeUndefined()
  })

  it('falls through when routing metadata does not own this PID', async () => {
    const env = {
      [BACKGROUND_SESSION_ID_ENV]: 'bg-mismatch',
      [BACKGROUND_SESSION_LAUNCHER_PID_ENV]: '123',
    }
    const preparation = await prepareBackgroundSessionFinalizer({
      env,
      pid: 500,
      readSession: async () => ownedSession('bg-mismatch', 501),
      isLauncherAlive: () => true,
    })

    expect(preparation).toBe('invalid-routing')
    expect(env[BACKGROUND_SESSION_ID_ENV]).toBeUndefined()
  })

  it('accepts a PID 1 launcher while waiting for exact ownership', async () => {
    const env = {
      [BACKGROUND_SESSION_ID_ENV]: 'bg-pid-one-launcher',
      [BACKGROUND_SESSION_LAUNCHER_PID_ENV]: '1',
    }
    let reads = 0

    const preparation = await prepareBackgroundSessionFinalizer({
      env,
      pid: 500,
      readSession: async () =>
        ++reads === 1 ? null : ownedSession('bg-pid-one-launcher', 500),
      sleep: async () => {},
      registrationWaitMs: 2,
      registrationPollMs: 1,
      registerCleanup: () => () => {},
      onBeforeExit: () => {},
      onExit: () => {},
    })

    expect(preparation).toBe('installed')
    expect(reads).toBe(2)
  })

  it('rechecks exact ownership before timing out after launcher exit', async () => {
    const env = {
      [BACKGROUND_SESSION_ID_ENV]: 'bg-launcher-exit-race',
      [BACKGROUND_SESSION_LAUNCHER_PID_ENV]: '123',
    }
    let reads = 0

    const preparation = await prepareBackgroundSessionFinalizer({
      env,
      pid: 500,
      readSession: async () =>
        ++reads === 1 ? null : ownedSession('bg-launcher-exit-race', 500),
      isLauncherAlive: () => false,
      sleep: async () => {},
      registrationWaitMs: 2,
      registrationPollMs: 1,
      registerCleanup: () => () => {},
      onBeforeExit: () => {},
      onExit: () => {},
    })

    expect(preparation).toBe('installed')
    expect(reads).toBe(2)
  })

  it('fails after the bounded registration wait without exact ownership', async () => {
    const env = {
      [BACKGROUND_SESSION_ID_ENV]: 'bg-registration-timeout',
      [BACKGROUND_SESSION_LAUNCHER_PID_ENV]: '123',
    }
    let reads = 0

    await expect(
      prepareBackgroundSessionFinalizer({
        env,
        pid: 500,
        readSession: async () => {
          reads += 1
          return null
        },
        isLauncherAlive: () => true,
        sleep: async () => {},
        registrationWaitMs: 2,
        registrationPollMs: 1,
      }),
    ).rejects.toThrow('Background session registration was not established')
    expect(reads).toBe(3)
    expect(env[BACKGROUND_SESSION_ID_ENV]).toBeUndefined()
    expect(env[BACKGROUND_SESSION_LAUNCHER_PID_ENV]).toBeUndefined()
  })

  it('waits for exact ownership before installing awaited and sync finalizers', async () => {
    const env = {
      [BACKGROUND_SESSION_ID_ENV]: 'bg-owned',
      [BACKGROUND_SESSION_LAUNCHER_PID_ENV]: '123',
    }
    let reads = 0
    let cleanup: (() => void | Promise<void>) | undefined
    let beforeExitListener: (() => void | Promise<void>) | undefined
    let exitListener: ((code: number) => void) | undefined
    const finalized: number[] = []
    const finalizedSync: number[] = []
    const registeredSession = ownedSession('bg-owned', 500)
    let finalizationOwner: BackgroundSession | undefined

    const preparation = await prepareBackgroundSessionFinalizer({
      env,
      pid: 500,
      readSession: async () =>
        ++reads < 3 ? null : registeredSession,
      isLauncherAlive: () => true,
      sleep: async () => {},
      registrationWaitMs: 10,
      registrationPollMs: 1,
      registerCleanup: fn => {
        cleanup = fn
        return () => {}
      },
      onBeforeExit: listener => {
        beforeExitListener = listener
      },
      onExit: listener => {
        exitListener = listener
      },
      finalize: async (_id, termination, options) => {
        finalized.push(termination.exitCode ?? -1)
        finalizationOwner = options?.expectedSession
        return ownedSession('bg-owned', 500)
      },
      finalizeSync: (_id, termination) => {
        finalizedSync.push(termination.exitCode ?? -1)
      },
      startCleanupWorker: () => {},
    })

    expect(preparation).toBe('installed')
    expect(reads).toBe(3)
    expect(env[BACKGROUND_SESSION_ID_ENV]).toBeUndefined()
    const previousExitCode = process.exitCode
    process.exitCode = '7' as unknown as number
    try {
      await beforeExitListener?.()
      await cleanup?.()
      exitListener?.(7)
    } finally {
      process.exitCode = previousExitCode ?? 0
    }
    expect(finalized).toEqual([7])
    expect(finalizedSync).toEqual([])
    expect(finalizationOwner).toEqual(registeredSession)
  })

  it('starts a detached cleanup owner after awaited finalization', async () => {
    let beforeExitListener: (() => void | Promise<void>) | undefined
    const order: string[] = []
    let spawnedArgs: readonly string[] | undefined
    let spawnedEnv: NodeJS.ProcessEnv | undefined
    let unrefCalls = 0

    await prepareBackgroundSessionFinalizer({
      env: {
        [BACKGROUND_SESSION_ID_ENV]: 'bg-launcher-handoff',
        [BACKGROUND_SESSION_LAUNCHER_PID_ENV]: '123',
      },
      pid: 500,
      readSession: async () => ownedSession('bg-launcher-handoff', 500),
      registerCleanup: () => () => {},
      onBeforeExit: listener => {
        beforeExitListener = listener
      },
      onExit: () => {},
      finalize: async () => {
        order.push('finalize')
        return ownedSession('bg-launcher-handoff', 500)
      },
      settingsArgs: [
        '--settings',
        JSON.stringify({
          cleanupPeriodDays: 0,
          permissions: { defaultMode: 'bogus' },
        }),
      ],
      settingsCwd: configDir,
      spawnCleanupWorkerProcess: ((_command, args, options) => {
        order.push('worker')
        spawnedArgs = args
        spawnedEnv = options.env
        return {
          once: () => {},
          unref: () => {
            unrefCalls++
          },
        }
      }) as unknown as typeof spawn,
    })

    await beforeExitListener?.()
    expect(order).toEqual(['finalize', 'worker'])
    expect(spawnedArgs).not.toContain('--settings')
    expect(
      spawnedEnv?.[
        'OPENCLAUDE_INTERNAL_BACKGROUND_RETENTION_POLICY_STATE'
      ],
    ).toBe('invalid')
    expect(unrefCalls).toBe(1)
  })

  it('passes only settings-source inputs to the detached cleanup worker', () => {
    let spawnedArgs: readonly string[] | undefined
    let spawnedEnv: NodeJS.ProcessEnv | undefined
    let unrefCalls = 0
    startBackgroundSessionCleanupWorker({
      sessionId: 'bg-worker-settings',
      ownerPid: 500,
      launcherPid: 123,
      execPath: 'node',
      execArgv: ['--expose-gc'],
      entrypoint: '/openclaude/cli.mjs',
      settingsArgs: [
        '--provider',
        'openai',
        '--settings={"cleanupPeriodDays":0,"apiKeyHelper":"private"}',
        '--setting-sources',
        'project,user',
      ],
      spawnProcess: ((_command, args, options) => {
        spawnedArgs = args
        spawnedEnv = options.env
        return {
          once: () => {},
          unref: () => {
            unrefCalls++
          },
        }
      }) as unknown as typeof spawn,
    })

    expect(spawnedArgs).toEqual([
      '--expose-gc',
      '/openclaude/cli.mjs',
      '--settings',
      '{"cleanupPeriodDays":0}',
      '--setting-sources',
      'project,user',
    ])
    expect(spawnedEnv?.[BACKGROUND_SESSION_ID_ENV]).toBe(
      'bg-worker-settings',
    )
    expect(
      spawnedEnv?.[
        'OPENCLAUDE_INTERNAL_BACKGROUND_RETENTION_POLICY_STATE'
      ],
    ).toBe('preserved')
    expect(unrefCalls).toBe(1)
  })

  it('marks a projected inline settings handoff invalid when a sibling setting fails validation', () => {
    let spawnedArgs: readonly string[] | undefined
    let spawnedEnv: NodeJS.ProcessEnv | undefined
    startBackgroundSessionCleanupWorker({
      sessionId: 'bg-worker-invalid-settings',
      ownerPid: 500,
      launcherPid: 123,
      execPath: 'node',
      entrypoint: '/openclaude/cli.mjs',
      settingsArgs: [
        '--settings',
        JSON.stringify({
          cleanupPeriodDays: 0,
          permissions: { defaultMode: 'bogus' },
        }),
      ],
      spawnProcess: ((_command, args, options) => {
        spawnedArgs = args
        spawnedEnv = options.env
        return { once: () => {}, unref: () => {} }
      }) as unknown as typeof spawn,
    })

    expect(spawnedArgs).toEqual(['/openclaude/cli.mjs'])
    expect(
      spawnedEnv?.[
        'OPENCLAUDE_INTERNAL_BACKGROUND_RETENTION_POLICY_STATE'
      ],
    ).toBe('invalid')
  })

  it('retains cleanup when the detached worker cannot observe process exit', async () => {
    const { runBackgroundSessionCleanupWorker } = await import(
      './bgFinalizer.js'
    )
    const env = {
      [BACKGROUND_SESSION_CLEANUP_WORKER_ENV]: '1',
      [BACKGROUND_SESSION_CLEANUP_OWNER_PID_ENV]: '500',
      [BACKGROUND_SESSION_ID_ENV]: 'bg-worker-timeout',
      [BACKGROUND_SESSION_LAUNCHER_PID_ENV]: '123',
    }
    let observedExit: boolean | undefined

    await runBackgroundSessionCleanupWorker({
      env,
      isProcessAlive: () => true,
      sleep: async () => {},
      waitMs: 2,
      pollMs: 1,
      cleanup: async (_sessionId, waitForProcessesToExit) => {
        observedExit = await waitForProcessesToExit()
      },
    })

    expect(observedExit).toBe(false)
    expect(env[BACKGROUND_SESSION_CLEANUP_WORKER_ENV]).toBeUndefined()
    expect(env[BACKGROUND_SESSION_CLEANUP_OWNER_PID_ENV]).toBeUndefined()
    expect(env[BACKGROUND_SESSION_LAUNCHER_PID_ENV]).toBeUndefined()
  })

  it('does not run detached cleanup for an invalid originating policy', async () => {
    const { runBackgroundSessionCleanupWorker } = await import(
      './bgFinalizer.js'
    )
    const env = {
      [BACKGROUND_SESSION_CLEANUP_WORKER_ENV]: '1',
      [BACKGROUND_SESSION_CLEANUP_OWNER_PID_ENV]: '500',
      [BACKGROUND_SESSION_ID_ENV]: 'bg-worker-invalid-policy',
      [BACKGROUND_SESSION_LAUNCHER_PID_ENV]: '123',
      OPENCLAUDE_INTERNAL_BACKGROUND_RETENTION_POLICY_STATE: 'invalid',
    }
    let cleanupRuns = 0

    await runBackgroundSessionCleanupWorker({
      env,
      cleanup: async () => {
        cleanupRuns++
      },
    })

    expect(cleanupRuns).toBe(0)
    expect(
      env.OPENCLAUDE_INTERNAL_BACKGROUND_RETENTION_POLICY_STATE,
    ).toBeUndefined()
  })

  it('passes the registered generation to the synchronous exit fallback', async () => {
    let cleanup: (() => void | Promise<void>) | undefined
    let exitListener: ((code: number) => void) | undefined
    const registeredSession: BackgroundSession = {
      ...ownedSession('bg-sync-generation', 500),
      processMarker: 'a'.repeat(64),
      terminalFactGeneration: 'a'.repeat(64),
    }
    let syncOwner: BackgroundSession | undefined
    const cleanupWorkers: Array<[string, number, number]> = []

    await prepareBackgroundSessionFinalizer({
      env: {
        [BACKGROUND_SESSION_ID_ENV]: registeredSession.id,
        [BACKGROUND_SESSION_LAUNCHER_PID_ENV]: '123',
      },
      pid: registeredSession.pid,
      readSession: async () => registeredSession,
      isLauncherAlive: () => true,
      registerCleanup: fn => {
        cleanup = fn
        return () => {}
      },
      onBeforeExit: () => {},
      onExit: listener => {
        exitListener = listener
      },
      finalize: async () => {
        throw Object.assign(new Error('contended'), { code: 'ELOCKED' })
      },
      debug: () => {},
      finalizeSync: (_id, _termination, options) => {
        syncOwner = options?.expectedSession
      },
      startCleanupWorker: (sessionId, ownerPid, launcherPid) => {
        cleanupWorkers.push([sessionId, ownerPid, launcherPid])
      },
    })

    await cleanup?.()
    exitListener?.(23)
    expect(syncOwner).toEqual(registeredSession)
    expect(cleanupWorkers).toEqual([
      [registeredSession.id, registeredSession.pid, 123],
    ])
  })

  it('keeps the original exit code when both persistence paths fail', async () => {
    let cleanup: (() => void | Promise<void>) | undefined
    let exitListener: ((code: number) => void) | undefined
    const diagnostics: string[] = []
    const previousExitCode = process.exitCode
    process.exitCode = 29
    try {
      await prepareBackgroundSessionFinalizer({
        env: {
          [BACKGROUND_SESSION_ID_ENV]: 'bg-write-failure',
          [BACKGROUND_SESSION_LAUNCHER_PID_ENV]: '123',
        },
        pid: 500,
        readSession: async () => ownedSession('bg-write-failure', 500),
        isLauncherAlive: () => true,
        registerCleanup: fn => {
          cleanup = fn
          return () => {}
        },
        onBeforeExit: () => {},
        onExit: listener => {
          exitListener = listener
        },
        finalize: async () => {
          throw Object.assign(new Error('private path /secret'), { code: 'EIO' })
        },
        finalizeSync: () => {
          throw new Error('private sync details')
        },
        debug: message => {
          diagnostics.push(message)
          throw new Error('diagnostic sink failed')
        },
      })

      await cleanup?.()
      exitListener?.(29)
      expect(process.exitCode).toBe(29)
    } finally {
      process.exitCode = previousExitCode ?? 0
    }
    expect(diagnostics).toHaveLength(2)
    expect(diagnostics[0]).toContain('(EIO)')
    expect(diagnostics.join('\n')).not.toContain('/secret')
    expect(diagnostics.join('\n')).not.toContain('private sync details')
  })

  it('reports post-finalization cleanup failure without changing the outcome', async () => {
    let cleanup: (() => void | Promise<void>) | undefined
    const diagnostics: string[] = []

    await prepareBackgroundSessionFinalizer({
      env: {
        [BACKGROUND_SESSION_ID_ENV]: 'bg-cleanup-failure',
        [BACKGROUND_SESSION_LAUNCHER_PID_ENV]: '123',
      },
      pid: 500,
      readSession: async () => ownedSession('bg-cleanup-failure', 500),
      isLauncherAlive: () => false,
      registerCleanup: fn => {
        cleanup = fn
        return () => {}
      },
      onBeforeExit: () => {},
      onExit: () => {},
      finalize: async () => ownedSession('bg-cleanup-failure', 500),
      startCleanupWorker: () => {
        throw Object.assign(new Error('private cleanup path'), { code: 'EIO' })
      },
      debug: message => {
        diagnostics.push(message)
      },
    })

    await cleanup?.()
    expect(diagnostics).toEqual([
      'Background session post-finalization cleanup failed (EIO)',
    ])
    expect(diagnostics[0]).not.toContain('private cleanup path')
  })

  it('records an observed shutdown signal instead of a successful exit code', async () => {
    let cleanup: (() => void | Promise<void>) | undefined
    let termination: { exitCode?: number; signal?: string } | undefined
    const previousExitCode = process.exitCode
    process.exitCode = 0
    try {
      await prepareBackgroundSessionFinalizer({
        env: {
          [BACKGROUND_SESSION_ID_ENV]: 'bg-observed-sigint',
          [BACKGROUND_SESSION_LAUNCHER_PID_ENV]: '123',
        },
        pid: 500,
        readSession: async () => ownedSession('bg-observed-sigint', 500),
        isLauncherAlive: () => true,
        registerCleanup: fn => {
          cleanup = fn
          return () => {}
        },
        onBeforeExit: () => {},
        onExit: () => {},
        getObservedSignal: () => 'SIGINT',
        finalize: async (_id, observed) => {
          termination = observed
          return ownedSession('bg-observed-sigint', 500)
        },
        startCleanupWorker: () => {},
      })

      await cleanup?.()
    } finally {
      process.exitCode = previousExitCode ?? 0
    }
    expect(termination).toEqual({ signal: 'SIGINT' })
  })

  async function runFixture(
    mode:
      | 'success'
      | 'fail'
      | 'throw'
      | 'handled-throw'
      | 'wait'
      | 'sigint'
      | 'sigterm',
    releasePath?: string,
  ): Promise<{
    id: string
    child: ReturnType<typeof spawn>
    readyPath: string
  }> {
    const id = `bg-fixture-${mode}`
    const readyPath = join(configDir, `${id}.ready`)
    const child = spawn(process.execPath, [fixturePath, mode], {
      env: {
        ...process.env,
        OPENCLAUDE_CONFIG_DIR: configDir,
        [BACKGROUND_SESSION_ID_ENV]: id,
        [BACKGROUND_SESSION_LAUNCHER_PID_ENV]: String(process.pid),
        OPENCLAUDE_BG_FINALIZER_FIXTURE_READY: readyPath,
        ...(releasePath
          ? { OPENCLAUDE_BG_FINALIZER_FIXTURE_RELEASE: releasePath }
          : {}),
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    if (!child.pid) throw new Error('fixture did not start')

    await mkdir(join(sessionsRoot, 'sessions'), { recursive: true })
    await writeFile(
      join(sessionsRoot, 'sessions', `${id}.json`),
      JSON.stringify(ownedSession(id, child.pid)),
    )
    return { id, child, readyPath }
  }

  async function waitForFile(path: string): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (await Bun.file(path).exists()) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('fixture readiness file was not created')
  }

  async function waitForProcessStop(pid: number): Promise<boolean> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (!isProcessRunning(pid)) return true
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    return !isProcessRunning(pid)
  }

  async function stopDetachedFixtureChild(
    childPid: number | undefined,
  ): Promise<void> {
    if (
      childPid === undefined ||
      !Number.isSafeInteger(childPid) ||
      !isProcessRunning(childPid)
    ) {
      return
    }
    try {
      process.kill(childPid, 'SIGTERM')
    } catch {}
    if (await waitForProcessStop(childPid)) return
    try {
      process.kill(childPid, 'SIGKILL')
    } catch {}
    await waitForProcessStop(childPid)
  }

  function sessionArtifactPaths(id: string, name: string): string[] {
    const reservationDigest = createHash('sha256').update(name).digest('hex')
    return [
      join(sessionsRoot, 'sessions', `${id}.json`),
      join(sessionsRoot, 'logs', `${id}.out.log`),
      join(sessionsRoot, 'logs', `${id}.err.log`),
      join(sessionsRoot, 'names', `${reservationDigest}.json`),
    ]
  }

  /** Await reclamation of the session record, logs, name reservation and terminal facts. */
  async function expectSessionArtifactsReclaimed(
    id: string,
    name: string,
  ): Promise<void> {
    const artifacts = sessionArtifactPaths(id, name)
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const present = await Promise.all(
        artifacts.map(async path => await Bun.file(path).exists()),
      )
      if (present.every(exists => !exists)) {
        const terminalFacts = (await readdir(join(sessionsRoot, 'terminal'))).filter(
          file => file.startsWith(`${id}~`),
        )
        if (terminalFacts.length === 0) break
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(
      await Promise.all(
        artifacts.map(async path => await Bun.file(path).exists()),
      ),
    ).toEqual([false, false, false, false])
    expect(
      (await readdir(join(sessionsRoot, 'terminal'))).filter(file =>
        file.startsWith(`${id}~`),
      ),
    ).toEqual([])
  }

  async function expectSessionArtifactsRetained(
    id: string,
    name: string,
    stabilityMs: number = 1_000,
  ): Promise<void> {
    const artifacts = sessionArtifactPaths(id, name)
    const deadline = Date.now() + stabilityMs
    do {
      expect(
        await Promise.all(
          artifacts.map(async path => await Bun.file(path).exists()),
        ),
      ).toEqual([true, true, true, false])
      await new Promise(resolve => setTimeout(resolve, 20))
    } while (Date.now() < deadline)
  }

  async function waitForChildClose(
    child: ReturnType<typeof spawn>,
    label: string,
    timeoutMs: number = 15_000,
  ): Promise<number | null> {
    const close = once(child, 'close') as Promise<[number | null]>
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        close.then(([code]) => code),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true
            child.kill('SIGKILL')
            reject(new Error(`${label} exceeded ${timeoutMs}ms`))
          }, timeoutMs)
          timer.unref?.()
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (timedOut) {
        await Promise.race([
          close.catch(() => [null] as [null]),
          new Promise(resolve => setTimeout(resolve, 2_000)),
        ])
      }
    }
  }

  function captureBoundedOutput(
    child: ReturnType<typeof spawn>,
    stream: NodeJS.ReadableStream | null,
    label: string,
  ): { read: () => string; assertWithinLimit: () => void } {
    let text = ''
    let bytes = 0
    let exceeded = false
    stream?.setEncoding('utf8')
    stream?.on('data', chunk => {
      if (exceeded) return
      const value = String(chunk)
      bytes += Buffer.byteLength(value)
      if (bytes > FIXTURE_OUTPUT_LIMIT_BYTES) {
        exceeded = true
        child.kill('SIGKILL')
        return
      }
      text += value
    })
    return {
      read: () => text,
      assertWithinLimit: () => {
        if (exceeded) {
          throw new Error(
            `${label} exceeded ${FIXTURE_OUTPUT_LIMIT_BYTES} bytes`,
          )
        }
      },
    }
  }

  async function runBuiltBackgroundProviderExit(
    name: string,
    retentionArgs: string[] = [],
  ): Promise<{ id: string; childPid: number }> {
    const homeDir = join(configDir, 'home')
    const cacheDir = join(configDir, 'cache')
    await mkdir(homeDir, { recursive: true })
    await mkdir(cacheDir, { recursive: true })
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDir,
      XDG_CACHE_HOME: cacheDir,
      OPENCLAUDE_CONFIG_DIR: configDir,
    }
    for (const key of [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'OPENAI_API_KEYS',
      'GEMINI_API_KEY',
      'NODE_ENV',
    ]) {
      delete childEnv[key]
    }
    delete childEnv.OPENCLAUDE_DISABLE_CLI_ENTRYPOINT_AUTO_RUN
    const launcher = spawn(
      'node',
      [
        installedLauncherPath,
        '--bg',
        '--name',
        name,
        ...retentionArgs,
        '--provider',
        'openai',
        '--print',
        'noop',
      ],
      {
        cwd: configDir,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const stdoutCapture = captureBoundedOutput(
      launcher,
      launcher.stdout,
      'built background launcher stdout',
    )
    const stderrCapture = captureBoundedOutput(
      launcher,
      launcher.stderr,
      'built background launcher stderr',
    )
    let childPid: number | undefined
    let ownershipTransferred = false
    try {
      const launcherCode = await waitForChildClose(
        launcher,
        'built background launcher',
      )
      stdoutCapture.assertWithinLimit()
      stderrCapture.assertWithinLimit()
      const stdout = stdoutCapture.read()
      const parsedChildPid = Number(stdout.match(/^PID: (\d+)$/m)?.[1])
      if (Number.isSafeInteger(parsedChildPid)) childPid = parsedChildPid
      const stderr = stderrCapture.read()
      expect(launcherCode).toBe(0)
      expect(stderr).toBe('')
      const stdoutLogPath = stdout.match(/^Logs: (.+)$/m)?.[1]
      const id = stdoutLogPath
        ? basename(stdoutLogPath, '.out.log')
        : undefined
      expect(id).toBeDefined()
      expect(childPid).toBeDefined()
      if (!id || childPid === undefined) {
        throw new Error('built launch output omitted its session identity')
      }
      ownershipTransferred = true
      return { id, childPid }
    } finally {
      if (!ownershipTransferred) {
        if (childPid === undefined) {
          const stdout = stdoutCapture.read()
          const parsedChildPid = Number(stdout.match(/^PID: (\d+)$/m)?.[1])
          if (Number.isSafeInteger(parsedChildPid)) childPid = parsedChildPid
        }
        await stopDetachedFixtureChild(childPid)
      }
    }
  }

  async function runBuiltCliSession(
    id: string,
    args: string[],
  ): Promise<number> {
    const processMarker = 'c'.repeat(64)
    const processEnv: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCLAUDE_CONFIG_DIR: configDir,
    }
    delete processEnv.OPENCLAUDE_DISABLE_CLI_ENTRYPOINT_AUTO_RUN
    const childConfig = buildBackgroundChildProcessConfig({
      execPath: 'node',
      execArgv: [],
      entrypoint: installedLauncherPath,
      childArgs: args,
      processEnv,
      stdoutLogPath: join(configDir, `${id}.out.log`),
      backgroundSessionId: id,
      processMarker,
      launcherPid: process.pid,
    })
    const child = spawn(childConfig.command, childConfig.args, {
      env: childConfig.env,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    if (!child.pid) throw new Error('built CLI fixture did not start')

    await mkdir(join(sessionsRoot, 'sessions'), { recursive: true })
    await writeFile(
      join(sessionsRoot, 'sessions', `${id}.json`),
      JSON.stringify({
        ...ownedSession(id, child.pid),
        processMarker,
        command: [childConfig.command, ...childConfig.args],
      }),
    )
    const [code] = (await once(child, 'exit')) as [number]
    return code
  }

  async function waitForTerminalSession(): Promise<BackgroundSession> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const [session] = await listBackgroundSessions()
      if (
        session &&
        (session.status === 'exited' || session.status === 'failed')
      ) {
        return session
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('detached fixture did not persist a terminal outcome')
  }

  async function runDetachedLaunch(
    mode: 'success' | 'fail',
  ): Promise<{ stdout: string; session: BackgroundSession }> {
    const launcher = spawn(process.execPath, [fixturePath, 'launcher', mode], {
      env: {
        ...process.env,
        OPENCLAUDE_CONFIG_DIR: configDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdoutCapture = captureBoundedOutput(
      launcher,
      launcher.stdout,
      'detached launcher stdout',
    )
    const stderrCapture = captureBoundedOutput(
      launcher,
      launcher.stderr,
      'detached launcher stderr',
    )
    const [code] = (await once(launcher, 'exit')) as [number]
    stdoutCapture.assertWithinLimit()
    stderrCapture.assertWithinLimit()
    const stdout = stdoutCapture.read()
    const stderr = stderrCapture.read()
    expect(code).toBe(0)
    expect(stderr).toBe('')
    return { stdout, session: await waitForTerminalSession() }
  }

  async function runWaitingDetachedLaunch(
    name: string,
    fixtureEnv: NodeJS.ProcessEnv = {},
  ): Promise<{ id: string; childPid: number; readyPath: string }> {
    const readyPath = join(configDir, `${name}.ready`)
    const launcher = spawn(
      process.execPath,
      [fixturePath, 'launcher', 'wait', name],
      {
        cwd: configDir,
        env: {
          ...process.env,
          OPENCLAUDE_CONFIG_DIR: configDir,
          OPENCLAUDE_BG_FINALIZER_FIXTURE_READY: readyPath,
          ...fixtureEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const stdoutCapture = captureBoundedOutput(
      launcher,
      launcher.stdout,
      'detached wait launcher stdout',
    )
    const stderrCapture = captureBoundedOutput(
      launcher,
      launcher.stderr,
      'detached wait launcher stderr',
    )
    let childPid: number | undefined
    let ownershipTransferred = false
    try {
      const launcherCode = await waitForChildClose(
        launcher,
        'detached wait launcher',
      )
      stdoutCapture.assertWithinLimit()
      stderrCapture.assertWithinLimit()
      const stdout = stdoutCapture.read()
      const parsedChildPid = Number(stdout.match(/^PID: (\d+)$/m)?.[1])
      if (Number.isSafeInteger(parsedChildPid)) childPid = parsedChildPid
      const stderr = stderrCapture.read()
      expect(launcherCode).toBe(0)
      expect(stderr).toBe('')
      const stdoutLogPath = stdout.match(/^Logs: (.+)$/m)?.[1]
      const id = stdoutLogPath
        ? basename(stdoutLogPath, '.out.log')
        : undefined
      expect(id).toBeDefined()
      expect(childPid).toBeDefined()
      if (!id || childPid === undefined) {
        throw new Error('detached wait launch omitted its session identity')
      }
      await waitForFile(readyPath)
      ownershipTransferred = true
      return { id, childPid, readyPath }
    } finally {
      if (!ownershipTransferred) {
        if (childPid === undefined) {
          const stdout = stdoutCapture.read()
          const parsedChildPid = Number(stdout.match(/^PID: (\d+)$/m)?.[1])
          if (Number.isSafeInteger(parsedChildPid)) childPid = parsedChildPid
        }
        await stopDetachedFixtureChild(childPid)
      }
    }
  }

  for (const scenario of [
    {
      label: 'launcher output omits Logs',
      env: {
        OPENCLAUDE_BG_FINALIZER_FIXTURE_OUTPUT: 'omit-logs',
      },
    },
    {
      label: 'readiness is never published',
      env: {
        OPENCLAUDE_BG_FINALIZER_FIXTURE_SKIP_READY: '1',
      },
    },
  ]) {
    it(
      `reaps the detached child when ${scenario.label}`,
      async () => {
        const name = `failed-handoff-${scenario.label.replaceAll(' ', '-')}`
        await expect(
          runWaitingDetachedLaunch(name, scenario.env),
        ).rejects.toThrow()
        const session = (await listBackgroundSessions()).find(
          candidate => candidate.name === name,
        )
        expect(session).toBeDefined()
        expect(
          session ? isProcessRunning(session.pid) : true,
        ).toBe(false)
      },
      30_000,
    )
  }

  async function runBuiltKill(
    id: string,
    settingsArgs: string[] = [],
  ): Promise<string> {
    const killEnv: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCLAUDE_CONFIG_DIR: configDir,
    }
    delete killEnv.NODE_ENV
    delete killEnv.OPENCLAUDE_DISABLE_CLI_ENTRYPOINT_AUTO_RUN
    const kill = spawn(
      'node',
      [installedLauncherPath, 'kill', id, ...settingsArgs],
      {
        cwd: configDir,
        env: killEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const stdoutCapture = captureBoundedOutput(
      kill,
      kill.stdout,
      'built kill stdout',
    )
    const stderrCapture = captureBoundedOutput(
      kill,
      kill.stderr,
      'built kill stderr',
    )
    const code = await waitForChildClose(kill, 'built kill command')
    stdoutCapture.assertWithinLimit()
    stderrCapture.assertWithinLimit()
    const stdout = stdoutCapture.read()
    const stderr = stderrCapture.read()
    expect(code, stderr).toBe(0)
    expect(stderr).toBe('')
    return stdout
  }

  for (const scenario of [
    { label: 'null input', input: 'process.exit(null)', expected: 0 },
    {
      label: 'cleared exitCode',
      input: 'process.exitCode = null; process.exit()',
      expected: 0,
    },
    { label: 'omitted input', input: 'process.exit()', expected: 23 },
    {
      label: 'undefined input',
      input: 'process.exit(undefined)',
      expected: 0,
    },
  ]) {
    it(`records Node's actual explicit exit with ${scenario.label}`, async () => {
      const id = 'bg-node-explicit-exit'
      const preload = join(configDir, 'explicit-exit.cjs')
      // Run the input as soon as the built CLI installs its exit wrapper.
      // Node owns conversion of the input and the observed child status.
      await writeFile(
        preload,
        `
        let exit = process.exit
        Object.defineProperty(process, 'exit', {
          configurable: true,
          get: () => exit,
          set: value => {
            exit = value
            queueMicrotask(() => {
              require('node:fs').writeFileSync(${JSON.stringify(join(configDir, 'exit-input-ran'))}, 'ran')
              process.exitCode = 23
              ${scenario.input}
            })
          },
        })
      `,
      )
      const child = spawn(
        'node',
        ['--require', preload, installedLauncherPath, '--print', 'fixture'],
        {
          cwd: configDir,
          env: {
            ...process.env,
            NODE_ENV: '',
            OPENCLAUDE_DISABLE_HEAP_RELAUNCH: '1',
            OPENCLAUDE_DISABLE_CLI_ENTRYPOINT_AUTO_RUN: '0',
            OPENCLAUDE_CONFIG_DIR: configDir,
            [BACKGROUND_SESSION_ID_ENV]: id,
            [BACKGROUND_SESSION_LAUNCHER_PID_ENV]: String(process.pid),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      const closed = waitForChildClose(child, 'Node explicit exit')
      const stderr = captureBoundedOutput(
        child,
        child.stderr,
        'Node explicit exit stderr',
      )
      try {
        if (!child.pid)
          throw new Error('Node explicit-exit fixture did not start')
        await mkdir(join(sessionsRoot, 'sessions'), { recursive: true })
        await writeFile(
          join(sessionsRoot, 'sessions', `${id}.json`),
          JSON.stringify(ownedSession(id, child.pid)),
        )
        const code = await closed
        expect(
          await Bun.file(join(configDir, 'exit-input-ran')).exists(),
        ).toBe(true)
        expect(code, stderr.read()).toBe(scenario.expected)
        stderr.assertWithinLimit()
        expect((await listBackgroundSessions())[0]).toMatchObject({
          id,
          status: scenario.expected === 0 ? 'exited' : 'failed',
          exitCode: scenario.expected,
        })
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL')
        await closed.catch(() => {})
      }
    }, 30_000)
  }

  for (const expectation of [
    { mode: 'success' as const, status: 'exited', exitCode: 0 },
    { mode: 'fail' as const, status: 'failed', exitCode: 23 },
    { mode: 'throw' as const, status: 'failed', exitCode: 1 },
  ]) {
    it(`records a real ${expectation.mode} child outcome`, async () => {
      const { id, child } = await runFixture(expectation.mode)
      const [code] = (await once(child, 'exit')) as [number]
      expect(code).toBe(expectation.exitCode)

      expect((await listBackgroundSessions())[0]).toMatchObject({
        id,
        status: expectation.status,
        exitCode: expectation.exitCode,
        terminalReason: 'exit_code',
      })
    })
  }

  for (const scenario of [
    { label: 'zero-day', days: 0, reclaimed: true, settingsArgs: [] },
    { label: 'positive', days: 30, reclaimed: false, settingsArgs: [] },
    {
      label: 'failed retention bootstrap',
      days: 0,
      reclaimed: false,
      settingsArgs: ['--settings', 'missing-retention-settings.json'],
    },
  ]) {
    it(
      `keeps built explicit kill successful with ${scenario.label} retention`,
      async () => {
        await writeFile(
          join(configDir, 'settings.json'),
          JSON.stringify({ cleanupPeriodDays: scenario.days }),
        )
        const name = `built-kill-${scenario.label.replaceAll(' ', '-')}`
        const { id, childPid } = await runWaitingDetachedLaunch(name)
        try {
          expect(isProcessRunning(childPid)).toBe(true)
          expect(await runBuiltKill(id, scenario.settingsArgs)).toContain(
            `Killed background session ${id}.`,
          )
          expect(await waitForProcessStop(childPid)).toBe(true)
          if (scenario.reclaimed) {
            await expectSessionArtifactsReclaimed(id, name)
          } else {
            await expectSessionArtifactsRetained(id, name)
          }
        } finally {
          if (isProcessRunning(childPid)) {
            try {
              process.kill(childPid, 'SIGKILL')
            } catch {}
          }
        }
      },
      30_000,
    )
  }

  it(
    'keeps built kill retention independent of malformed project MCP config',
    async () => {
      await writeFile(
        join(configDir, 'settings.json'),
        JSON.stringify({ cleanupPeriodDays: 0 }),
      )
      await writeFile(join(configDir, '.mcp.json'), '{invalid')
      const name = 'built-kill-malformed-mcp'
      const { id, childPid } = await runWaitingDetachedLaunch(name)
      try {
        expect(await runBuiltKill(id)).toContain(
          `Killed background session ${id}.`,
        )
        expect(await waitForProcessStop(childPid)).toBe(true)
        await expectSessionArtifactsReclaimed(id, name)
      } finally {
        if (isProcessRunning(childPid)) {
          try {
            process.kill(childPid, 'SIGKILL')
          } catch {}
        }
      }
    },
    30_000,
  )

  it(
    'keeps a handled uncaught exception live until the actual exit',
    async () => {
      const releasePath = join(configDir, 'handled-throw.release')
      const { id, child, readyPath } = await runFixture(
        'handled-throw',
        releasePath,
      )
      const childExit = once(child, 'exit') as Promise<
        [number | null, NodeJS.Signals | null]
      >
      const forceTimer = setTimeout(() => child.kill('SIGKILL'), 10_000)
      try {
        await waitForFile(readyPath)
        expect(child.pid).toBeDefined()
        expect(isProcessRunning(child.pid!)).toBe(true)
        expect(
          (await listBackgroundSessions()).find(item => item.id === id),
        ).toMatchObject({
          id,
          status: 'running',
        })

        await writeFile(releasePath, 'release')
        const [code, signal] = await childExit
        expect(signal).toBeNull()
        expect(code).toBe(23)
        expect(
          (await listBackgroundSessions()).find(item => item.id === id),
        ).toMatchObject({
          id,
          status: 'failed',
          exitCode: 23,
          terminalReason: 'exit_code',
        })
      } finally {
        clearTimeout(forceTimer)
        await writeFile(releasePath, 'release').catch(() => {})
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL')
          await childExit.catch(() => {})
        }
      }
    },
    30_000,
  )

  for (const expectation of [
    {
      mode: 'sigint' as const,
      signal: 'SIGINT' as NodeJS.Signals,
      childExitCode: 0,
    },
    {
      mode: 'sigterm' as const,
      signal: 'SIGTERM' as NodeJS.Signals,
      childExitCode: 143,
    },
  ]) {
    it.skipIf(process.platform === 'win32')(
      `records an observed ${expectation.signal} as a failed signal fact`,
      async () => {
        const { id, child, readyPath } = await runFixture(expectation.mode)
        await waitForFile(readyPath)
        child.kill(expectation.signal)
        const [code, signal] = (await once(child, 'exit')) as [
          number,
          NodeJS.Signals | null,
        ]
        expect(code).toBe(expectation.childExitCode)
        expect(signal).toBeNull()
        expect((await listBackgroundSessions())[0]).toMatchObject({
          id,
          status: 'failed',
          signal: expectation.signal,
          terminalReason: 'signal',
        })
        expect('exitCode' in (await listBackgroundSessions())[0]!).toBe(false)
      },
    )
  }

  for (const expectation of [
    { mode: 'success' as const, status: 'exited', exitCode: 0 },
    { mode: 'fail' as const, status: 'failed', exitCode: 23 },
  ]) {
    it(
      `finalizes a detached ${expectation.mode} launch through handleBgFlag`,
      async () => {
        const { stdout, session } = await runDetachedLaunch(expectation.mode)

        expect(stdout).toMatch(
          new RegExp(
            `(?:Started background session ${session.id}\\.|Background session ${session.id} finished with status ${expectation.status}\\.)`,
          ),
        )
        expect(session).toMatchObject({
          status: expectation.status,
          exitCode: expectation.exitCode,
          terminalReason: 'exit_code',
        })
        expect(isValidBackgroundProcessMarker(session.processMarker)).toBe(
          true,
        )
        expect(session.command).toContain(
          backgroundProcessMarkerToken(session.processMarker!),
        )
        expect(stdout).not.toContain(BACKGROUND_PROCESS_MARKER_FLAG)
        expect(await Bun.file(session.stdoutLogPath).exists()).toBe(true)
        expect(await Bun.file(session.stderrLogPath).exists()).toBe(true)
      },
      30_000,
    )
  }

  async function runZeroRetentionFinalizerScenario(
    mode: 'controlled' | 'controlled-exit',
  ): Promise<void> {
    await writeFile(
      join(configDir, 'settings.json'),
      JSON.stringify({ cleanupPeriodDays: 0 }),
    )
    const homeDir = join(configDir, 'home')
    const cacheDir = join(configDir, 'cache')
    await mkdir(homeDir, { recursive: true })
    await mkdir(cacheDir, { recursive: true })
    const name = `zero-retention-${mode}`
    const readyPath = join(configDir, `${mode}.ready`)
    const releasePath = join(configDir, `${mode}.release`)
    const launcher = spawn(
      process.execPath,
      [fixturePath, 'launcher', mode, name],
      {
        cwd: configDir,
        env: {
          ...process.env,
          HOME: homeDir,
          XDG_CACHE_HOME: cacheDir,
          OPENCLAUDE_CONFIG_DIR: configDir,
          OPENCLAUDE_BG_FINALIZER_FIXTURE_READY: readyPath,
          OPENCLAUDE_BG_FINALIZER_FIXTURE_RELEASE: releasePath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const stdoutCapture = captureBoundedOutput(
      launcher,
      launcher.stdout,
      'zero-retention launcher stdout',
    )
    const stderrCapture = captureBoundedOutput(
      launcher,
      launcher.stderr,
      'zero-retention launcher stderr',
    )
    const launcherClose = waitForChildClose(launcher, 'zero-retention launcher')
    let childPid: number | undefined
    try {
      const launcherCode = await launcherClose
      stdoutCapture.assertWithinLimit()
      stderrCapture.assertWithinLimit()
      const stdout = stdoutCapture.read()
      const stderr = stderrCapture.read()
      expect(launcherCode).toBe(0)
      expect(stderr).toBe('')
      const stdoutLogPath = stdout.match(/^Logs: (.+)$/m)?.[1]
      const id = stdoutLogPath
        ? basename(stdoutLogPath, '.out.log')
        : undefined
      const parsedChildPid = Number(stdout.match(/^PID: (\d+)$/m)?.[1])
      expect(id).toBeDefined()
      expect(Number.isSafeInteger(parsedChildPid)).toBe(true)
      if (!id || !Number.isSafeInteger(parsedChildPid)) {
        throw new Error('detached launch output omitted its session identity')
      }
      childPid = parsedChildPid
      const artifacts = sessionArtifactPaths(id, name)
      await waitForFile(readyPath)
      expect(isProcessRunning(childPid)).toBe(true)
      expect(
        await Promise.all(
          artifacts.map(async path => await Bun.file(path).exists()),
        ),
      ).toEqual([true, true, true, true])
      await writeFile(releasePath, 'release')

      expect(await waitForProcessStop(childPid)).toBe(true)
      await expectSessionArtifactsReclaimed(id, name)
    } finally {
      await writeFile(releasePath, 'release').catch(() => {})
      if (launcher.exitCode === null && launcher.signalCode === null) {
        launcher.kill('SIGKILL')
        await launcherClose.catch(() => {})
      }
      if (childPid !== undefined && isProcessRunning(childPid)) {
        try {
          process.kill(childPid, 'SIGTERM')
        } catch {}
        if (!(await waitForProcessStop(childPid))) {
          try {
            process.kill(childPid, 'SIGKILL')
          } catch {}
        }
      }
    }
  }

  for (const mode of ['controlled', 'controlled-exit'] as const) {
    it(
      `reclaims a short-lived zero-retention ${mode} launch without a recurring pass`,
      async () => runZeroRetentionFinalizerScenario(mode),
      30_000,
    )
  }

  it(
    'reclaims zero-retention artifacts after a built provider-validation exit',
    async () => {
      await writeFile(
        join(configDir, 'settings.json'),
        JSON.stringify({ cleanupPeriodDays: 0 }),
      )
      const name = 'node-provider-exit'
      const { id, childPid } = await runBuiltBackgroundProviderExit(name)
      try {
        expect(await waitForProcessStop(childPid)).toBe(true)

        await expectSessionArtifactsReclaimed(id, name)
      } finally {
        if (isProcessRunning(childPid)) {
          try {
            process.kill(childPid, 'SIGKILL')
          } catch {}
        }
      }
    },
    30_000,
  )

  for (const scenario of [
    {
      label: 'settings file retains against global zero-day policy',
      globalDays: 0,
      prepare: async () => {
        const path = join(configDir, 'retain-settings.json')
        await writeFile(path, JSON.stringify({ cleanupPeriodDays: 30 }))
        return ['--settings', path]
      },
      reclaimed: false,
    },
    {
      label: 'inline settings enable zero-day against global retention',
      globalDays: 30,
      prepare: async () => [
        '--settings',
        JSON.stringify({ cleanupPeriodDays: 0 }),
      ],
      reclaimed: true,
    },
    {
      label: 'invalid inline sibling retains against global zero-day policy',
      globalDays: 0,
      prepare: async () => [
        '--settings',
        JSON.stringify({
          cleanupPeriodDays: 0,
          permissions: { defaultMode: 'bogus' },
        }),
      ],
      reclaimed: false,
    },
    {
      label: 'project-only sources retain against global zero-day policy',
      globalDays: 0,
      prepare: async () => {
        await mkdir(join(configDir, '.openclaude'), { recursive: true })
        await writeFile(
          join(configDir, '.openclaude', 'settings.json'),
          JSON.stringify({ cleanupPeriodDays: 30 }),
        )
        return ['--setting-sources', 'project']
      },
      reclaimed: false,
    },
    {
      label: 'project-only sources enable zero-day against global retention',
      globalDays: 30,
      prepare: async () => {
        await mkdir(join(configDir, '.openclaude'), { recursive: true })
        await writeFile(
          join(configDir, '.openclaude', 'settings.json'),
          JSON.stringify({ cleanupPeriodDays: 0 }),
        )
        return ['--setting-sources', 'project']
      },
      reclaimed: true,
    },
  ]) {
    it(
      `preserves ${scenario.label} across the cleanup-worker handoff`,
      async () => {
        await writeFile(
          join(configDir, 'settings.json'),
          JSON.stringify({ cleanupPeriodDays: scenario.globalDays }),
        )
        const name = `worker-policy-${scenario.globalDays}-${scenario.reclaimed ? 'clean' : 'retain'}`
        const { id, childPid } = await runBuiltBackgroundProviderExit(
          name,
          await scenario.prepare(),
        )
        try {
          expect(await waitForProcessStop(childPid)).toBe(true)
          if (scenario.reclaimed) {
            await expectSessionArtifactsReclaimed(id, name)
          } else {
            await expectSessionArtifactsRetained(id, name)
          }
        } finally {
          if (isProcessRunning(childPid)) {
            try {
              process.kill(childPid, 'SIGKILL')
            } catch {}
          }
        }
      },
      30_000,
    )
  }

  it.skipIf(process.platform === 'win32')(
    'recognizes a live built marked child through the production command probe',
    async () => {
      const id = 'bg-built-live-marker'
      const processMarker = 'e'.repeat(64)
      const processEnv: NodeJS.ProcessEnv = {
        ...process.env,
        OPENCLAUDE_CONFIG_DIR: configDir,
      }
      delete processEnv.OPENCLAUDE_DISABLE_CLI_ENTRYPOINT_AUTO_RUN
      const childConfig = buildBackgroundChildProcessConfig({
        execPath: 'node',
        execArgv: [],
        entrypoint: installedLauncherPath,
        childArgs: ['--version'],
        processEnv,
        stdoutLogPath: join(configDir, `${id}.out.log`),
        backgroundSessionId: id,
        processMarker,
        launcherPid: process.pid,
      })
      const child = spawn(childConfig.command, childConfig.args, {
        env: childConfig.env,
        stdio: ['ignore', 'ignore', 'ignore'],
      })
      if (!child.pid) throw new Error('built CLI fixture did not start')
      const exit = once(child, 'exit')
      let forceTimer: ReturnType<typeof setTimeout> | undefined

      try {
        expect(child.kill('SIGSTOP')).toBe(true)
        const session: BackgroundSession = {
          ...ownedSession(id, child.pid),
          processMarker,
          command: [childConfig.command, ...childConfig.args],
        }
        await mkdir(join(sessionsRoot, 'sessions'), { recursive: true })
        await writeFile(
          join(sessionsRoot, 'sessions', `${id}.json`),
          JSON.stringify(session),
        )

        expect(verifyBackgroundSessionProcessIdentity(session).state).toBe(
          'matches',
        )
        expect(await refreshBackgroundSessionStatuses()).toMatchObject([
          { id, status: 'running', processMarker },
        ])
      } finally {
        child.kill('SIGCONT')
        forceTimer = setTimeout(() => child.kill('SIGKILL'), 5_000)
        await exit
        clearTimeout(forceTimer)
      }
    },
  )

  it('keeps the installed launcher PID stable and shows outcomes truthfully in ps', async () => {
    expect(await runBuiltCliSession('bg-built-success', ['--version'])).toBe(0)
    expect(
      await runBuiltCliSession('bg-built-failure', [
        '--provider-env-file',
        join(configDir, 'missing.env'),
        '--print',
        'noop',
      ]),
    ).toBe(1)

    const ps = spawn('node', [installedLauncherPath, 'ps'], {
      env: { ...process.env, OPENCLAUDE_CONFIG_DIR: configDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    ps.stdout?.setEncoding('utf8')
    ps.stderr?.setEncoding('utf8')
    ps.stdout?.on('data', chunk => {
      stdout += chunk
    })
    ps.stderr?.on('data', chunk => {
      stderr += chunk
    })
    const [psCode] = (await once(ps, 'exit')) as [number]

    expect(psCode).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toMatch(/bg-built-success\s+exited/)
    expect(stdout).toMatch(/bg-built-failure\s+failed/)
    for (const session of await listBackgroundSessions()) {
      expect(session.processMarker).toBe('c'.repeat(64))
      expect(session.command).toContain(
        backgroundProcessMarkerToken(session.processMarker!),
      )
    }
  })

  it.skipIf(process.platform === 'win32')(
    'does not invent success when a fixture is forcibly destroyed',
    async () => {
      const { child, readyPath } = await runFixture('wait')
      await waitForFile(readyPath)
      child.kill('SIGKILL')
      await once(child, 'exit')

      const refreshed = await refreshBackgroundSessionStatuses({
        isProcessAlive: () => false,
      })
      expect(refreshed[0]?.status).toBe('stale')
      expect('exitCode' in refreshed[0]!).toBe(false)
      expect('terminalReason' in refreshed[0]!).toBe(false)
    },
  )
})
