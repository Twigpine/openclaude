import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as platformPath from 'path'
import chokidar, { type FSWatcher } from 'chokidar'
import { type Stats, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'

type SkillChangeDetectorModule = typeof import('./skillChangeDetector.js') & {
  _scheduleReloadForTesting: (changedPath: string) => void
  _setDependenciesForTesting: (overrides?: Record<string, unknown>) => void
}

let clearCommandsCache = mock(() => {})
let clearCommandMemoizationCaches = mock(() => {})
let clearSkillCaches = mock(() => {})
let resetSentSkillNames = mock(() => {})
let hookResults: { blocked: boolean }[] = []
let executeConfigChangeHooksImpl = async () => hookResults
let executeConfigChangeHooks = mock(async () => hookResults)
let settingsChangedCallback: (() => void) | undefined
let unsubscribeSettingsChanges = mock(() => {})
let dynamicSkillsLoadedCallback: (() => void) | undefined
let unregisterDynamicSkillsLoaded = mock(() => {})
let additionalDirectories: string[] = []
let siblingSkillsHomePaths: string[] = []
let getSkillsPathImpl = (_source: string, _dir: string) => ''
let statImpl = mock(async (_path: string) => {})
let chokidarWatch = mock(() => ({
  on: mock(() => {}),
  close: mock(async () => {}),
}))
let activeDetector: SkillChangeDetectorModule | null = null

function installMocks(): void {
  clearCommandsCache = mock(() => {})
  clearCommandMemoizationCaches = mock(() => {})
  clearSkillCaches = mock(() => {})
  resetSentSkillNames = mock(() => {})
  hookResults = []
  executeConfigChangeHooksImpl = async () => hookResults
  executeConfigChangeHooks = mock(() => executeConfigChangeHooksImpl())
  settingsChangedCallback = undefined
  unsubscribeSettingsChanges = mock(() => {})
  dynamicSkillsLoadedCallback = undefined
  unregisterDynamicSkillsLoaded = mock(() => {})
  additionalDirectories = []
  siblingSkillsHomePaths = []
  getSkillsPathImpl = () => ''
  statImpl = mock(async () => {})
  chokidarWatch = mock(() => ({
    on: mock(() => {}),
    close: mock(async () => {}),
  }))
}

async function importFreshModule(): Promise<SkillChangeDetectorModule> {
  activeDetector = (await import(
    `./skillChangeDetector.ts?test=${Date.now()}-${Math.random()}`
  )) as SkillChangeDetectorModule
  activeDetector._setDependenciesForTesting({
    clearCommandMemoizationCaches,
    clearCommandsCache,
    executeConfigChangeHooks,
    getFsImplementation: () => ({
      stat: statImpl,
    }),
    getAdditionalDirectoriesForClaudeMd: () => additionalDirectories,
    getSkillsPath: (source: string, dir: string) =>
      getSkillsPathImpl(source, dir),
    getSiblingSkillsHomePaths: () => siblingSkillsHomePaths,
    hasBlockingResult: (results: { blocked: boolean }[]) =>
      results.some(result => result.blocked),
    onDynamicSkillsLoaded: (callback: () => void) => {
      dynamicSkillsLoadedCallback = callback
      return unregisterDynamicSkillsLoaded
    },
    subscribeToSettingsChanges: (callback: () => void) => {
      settingsChangedCallback = callback
      return unsubscribeSettingsChanges
    },
    resetSentSkillNames,
    watch: chokidarWatch,
  })
  return activeDetector
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/skills/skillChangeDetector.test.ts')
  installMocks()
})

afterEach(async () => {
  try {
    await activeDetector?.resetForTesting()
    activeDetector?._setDependenciesForTesting()
    activeDetector = null
    mock.restore()
  } finally {
    releaseSharedMutationLock()
  }
})

describe('skillChangeDetector reload batching', () => {
  test('dispose unregisters and guards dynamic skill callbacks', async () => {
    const detector = await importFreshModule()

    let notifications = 0
    detector.subscribe(() => {
      notifications += 1
    })

    await detector.initialize()
    expect(dynamicSkillsLoadedCallback).toBeDefined()

    await detector.dispose()
    dynamicSkillsLoadedCallback?.()

    expect(unregisterDynamicSkillsLoaded).toHaveBeenCalledTimes(1)
    expect(clearCommandMemoizationCaches).not.toHaveBeenCalled()
    expect(notifications).toBe(0)
  })

  test('accepted settings changes reload only changed eligibility and unsubscribe on dispose', async () => {
    const detector = await importFreshModule()
    let notifications = 0
    detector.subscribe(() => { notifications++ })
    await detector.initialize()
    expect(settingsChangedCallback).toBeDefined()
    settingsChangedCallback?.()
    await sleep(0)
    expect(clearCommandsCache).not.toHaveBeenCalled()
    expect(notifications).toBe(0)

    siblingSkillsHomePaths = ['/tmp/sibling-skills']
    settingsChangedCallback?.()
    // Invalidation precedes asynchronous watch reconciliation.
    expect(clearCommandsCache).toHaveBeenCalledTimes(1)
    await sleep(0)
    expect(notifications).toBe(1)
    settingsChangedCallback?.()
    await sleep(0)
    expect(clearCommandsCache).toHaveBeenCalledTimes(1)

    await detector.dispose()
    expect(unsubscribeSettingsChanges).toHaveBeenCalledTimes(1)
    siblingSkillsHomePaths = []
    settingsChangedCallback?.()
    await sleep(0)
    expect(clearCommandsCache).toHaveBeenCalledTimes(1)
    expect(notifications).toBe(1)
  })

  test('dispose during initialize prevents watcher creation after path lookup resolves', async () => {
    const detector = await importFreshModule()
    getSkillsPathImpl = (source, dir) =>
      source === 'userSettings' && dir === 'skills' ? '/tmp/skills' : ''

    let resolveStat: (() => void) | undefined
    let blockedFirstStat = false
    statImpl = mock(async () => {
      if (blockedFirstStat) {
        throw new Error('missing')
      }
      blockedFirstStat = true
      await new Promise<void>(resolve => {
        resolveStat = resolve
      })
    })

    const initializePromise = detector.initialize()
    await sleep(0)
    await detector.dispose()
    resolveStat?.()
    await initializePromise

    expect(chokidarWatch).not.toHaveBeenCalled()
  })

  test('watches OpenClaude project/add-dir skill paths that the loader reads', async () => {
    const detector = await importFreshModule()
    const addDir = platformPath.join('/tmp', 'openclaude-add-dir')
    const userSkillsPath = platformPath.join('/tmp', 'user', 'skills')
    const userCommandsPath = platformPath.join('/tmp', 'user', 'commands')
    additionalDirectories = [addDir]
    getSkillsPathImpl = (source, dir) => {
      if (source === 'userSettings' && dir === 'skills') return userSkillsPath
      if (source === 'userSettings' && dir === 'commands') return userCommandsPath
      return ''
    }
    statImpl = mock(async () => {})

    await detector.initialize()

    expect(chokidarWatch).toHaveBeenCalledTimes(1)
    const [watchedPaths = [], watchOptions = {}] = (
      chokidarWatch.mock.calls as unknown as Array<
        [string[] | undefined, { depth?: number } | undefined]
      >
    )[0] ?? []
    expect(watchedPaths).toContain(userSkillsPath)
    expect(watchedPaths).toContain(userCommandsPath)
    expect(watchedPaths).toContain(
      platformPath.join(addDir, '.openclaude', 'skills'),
    )
    expect(watchedPaths).not.toContain(
      platformPath.join(addDir, '.claude', 'skills'),
    )
    expect(
      watchedPaths.some(path =>
        path.endsWith(platformPath.join('.openclaude', 'skills')),
      ),
    ).toBe(true)
    expect(
      watchedPaths.some(path =>
        path.endsWith(platformPath.join('.claude', 'commands')),
      ),
    ).toBe(false)
    expect(
      watchedPaths.some(path =>
        path.endsWith(platformPath.join('.openclaude', 'commands')),
      ),
    ).toBe(true)
    expect(watchOptions.depth).toBeUndefined()
  })

  test('watches enabled sibling skills homes', async () => {
    const detector = await importFreshModule()
    const agentsSkillsPath = platformPath.join('/tmp', 'home', '.agents', 'skills')
    siblingSkillsHomePaths = [agentsSkillsPath]
    statImpl = mock(async () => {})

    await detector.initialize()

    const watchedPaths = (
      chokidarWatch.mock.calls as unknown as Array<[string[]]>
    ).flatMap(([paths]) => paths)
    expect(watchedPaths).toContain(agentsSkillsPath)
  })

  test('follows sibling links while preserving special-file and owned-watch exclusions', async () => {
    const detector = await importFreshModule()
    getSkillsPathImpl = () => '/tmp/owned-skills'
    siblingSkillsHomePaths = ['/tmp/sibling-skills']
    await detector.initialize()
    const calls = chokidarWatch.mock.calls as unknown as Array<[
      string[], { ignored: (path: string, stats: Stats) => boolean },
    ]>
    const link = statSync(import.meta.path)
    link.mode = 0o120000
    for (const [paths, options] of calls) {
      expect(options.ignored('/tmp/linked', link)).toBe(!paths.includes('/tmp/sibling-skills'))
      expect(options.ignored('/tmp/.git/linked', link)).toBe(true)
      for (const mode of [0o140000, 0o010000, 0o020000, 0o060000]) {
        const special = statSync(import.meta.path) // socket, FIFO, character and block device
        special.mode = mode
        expect(options.ignored('/tmp/special', special)).toBe(true)
      }
    }
    expect(calls).toHaveLength(2)
  })

  test('reloads skills and watches newly enabled homes after a settings toggle', async () => {
    const detector = await importFreshModule()
    const userSkillsPath = platformPath.join('/tmp', 'user', 'skills')
    getSkillsPathImpl = (source, dir) =>
      source === 'userSettings' && dir === 'skills' ? userSkillsPath : ''
    statImpl = mock(async () => {})
    await detector.initialize()
    const onChange = mock(() => {})
    detector.subscribe(onChange)

    const claudeSkillsPath = platformPath.join('/tmp', 'home', '.claude', 'skills')
    siblingSkillsHomePaths = [claudeSkillsPath]
    await detector.reloadAfterSkillSourceSettingsChange()

    expect(chokidarWatch).toHaveBeenLastCalledWith([claudeSkillsPath], expect.anything())
    expect(chokidarWatch).toHaveBeenCalledTimes(2)
    expect(clearCommandsCache).toHaveBeenCalledTimes(1)
    expect(resetSentSkillNames).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  test('starts the watcher for a newly enabled home when no skill directory existed at startup', async () => {
    const detector = await importFreshModule()
    const claudeSkillsPath = platformPath.join('/tmp', 'home', '.claude', 'skills')
    statImpl = mock(async (path: string) => {
      if (path !== claudeSkillsPath) throw new Error('ENOENT')
    })
    await detector.initialize()
    expect(chokidarWatch).not.toHaveBeenCalled()

    siblingSkillsHomePaths = [claudeSkillsPath]
    await detector.reloadAfterSkillSourceSettingsChange()

    const [watchedPaths = []] = (
      chokidarWatch.mock.calls as unknown as Array<[string[] | undefined]>
    )[0] ?? []
    expect(watchedPaths).toEqual([claudeSkillsPath])
    expect(clearCommandsCache).toHaveBeenCalledTimes(1)
  })

  test('reloads without starting a watcher before the detector is initialized', async () => {
    const detector = await importFreshModule()
    siblingSkillsHomePaths = [platformPath.join('/tmp', 'home', '.agents', 'skills')]

    await detector.reloadAfterSkillSourceSettingsChange()

    expect(chokidarWatch).not.toHaveBeenCalled()
    expect(clearCommandsCache).toHaveBeenCalledTimes(1)
  })

  test('overlapping toggles and disposal cannot leave a stale sibling watcher', async () => {
    const detector = await importFreshModule()
    const sibling = platformPath.join('/tmp', 'sibling', 'skills')
    const close = mock(async () => {})
    chokidarWatch = mock(() => ({ on: mock(() => {}), close }))
    detector._setDependenciesForTesting({
      getSkillsPath: () => '',
      getAdditionalDirectoriesForClaudeMd: () => [],
      getSiblingSkillsHomePaths: () => siblingSkillsHomePaths,
      getFsImplementation: () => ({ stat: (path: string) => statImpl(path) }),
      watch: chokidarWatch,
      clearCommandsCache,
      resetSentSkillNames,
    })
    statImpl = mock(async () => { throw new Error('ENOENT') })
    await detector.initialize()
    for (const disposeDuringLookup of [false, true]) {
      let releaseStat: (() => void) | undefined
      statImpl = mock(async () => new Promise<void>(resolve => { releaseStat = resolve }))
      siblingSkillsHomePaths = [sibling]
      const enable = detector.reloadAfterSkillSourceSettingsChange()
      await sleep(0)
      siblingSkillsHomePaths = []
      const disable = detector.reloadAfterSkillSourceSettingsChange()
      const disposal = disposeDuringLookup ? detector.dispose() : Promise.resolve()
      releaseStat?.()
      await Promise.all([enable, disable, disposal])
      // First iteration closes the briefly enabled source; disposal prevents
      // the second lookup from creating a replacement at all.
      expect(chokidarWatch).toHaveBeenCalledTimes(1)
      expect(close).toHaveBeenCalledTimes(1)
    }
  })

  test('disabled sibling edits stop triggering hooks while owned roots and re-enabling still work', async () => {
    const root = mkdtempSync(platformPath.join(tmpdir(), 'skill-watch-'))
    const own = platformPath.join(root, 'owned')
    const sibling = platformPath.join(root, 'sibling')
    const ownFile = platformPath.join(own, 'SKILL.md')
    const siblingFile = platformPath.join(sibling, 'SKILL.md')
    mkdirSync(own)
    mkdirSync(sibling)
    writeFileSync(ownFile, 'owned')
    writeFileSync(siblingFile, 'sibling')
    const detector = await importFreshModule()
    let realWatcher: FSWatcher | undefined
    detector._setDependenciesForTesting({
      getSkillsPath: () => own,
      getAdditionalDirectoriesForClaudeMd: () => [],
      getSiblingSkillsHomePaths: () => siblingSkillsHomePaths,
      getFsImplementation: () => ({ stat: async (path: string) => statSync(path) }),
      executeConfigChangeHooks,
      clearCommandsCache,
      resetSentSkillNames,
      watch: (paths: string[], options: Parameters<typeof chokidar.watch>[1]) => {
        realWatcher = chokidar.watch(paths, options)
        return realWatcher
      },
    })
    await detector.resetForTesting({
      stabilityThreshold: 10, pollInterval: 10, chokidarInterval: 10,
      reloadDebounce: 10, reloadCooldown: 10,
    })
    const hookCalls = () => executeConfigChangeHooks.mock.calls.length
    // Settle until no hook has fired for a full window, so a late hook from an
    // earlier phase cannot be attributed to the next one.
    const waitForQuietHooks = async () => {
      const deadline = Date.now() + 2000
      let seen = hookCalls()
      let quietSince = Date.now()
      while (Date.now() - quietSince < 200 && Date.now() < deadline) {
        await sleep(25)
        if (hookCalls() !== seen) {
          seen = hookCalls()
          quietSince = Date.now()
        }
      }
    }
    const editUntilHook = async (path: string, content: string) => {
      // Chokidar's ready marks traversal completion, but Bun may still be
      // initializing its polling baseline. Retry edits until one is observed.
      // A retry already in flight when the first hook lands can still produce
      // one more, so assert that the edit was seen rather than an exact count.
      const before = hookCalls()
      const deadline = Date.now() + 2000
      let edit = 0
      while (hookCalls() === before && Date.now() < deadline) {
        writeFileSync(path, `${content} ${edit++}`)
        await sleep(50)
      }
      expect(hookCalls()).toBeGreaterThan(before)
      await waitForQuietHooks()
    }
    try {
      siblingSkillsHomePaths = [sibling]
      await detector.initialize()
      await new Promise<void>(resolve => realWatcher!.once('ready', resolve))
      await editUntilHook(siblingFile, 'enabled edit')
      siblingSkillsHomePaths = []
      await detector.reloadAfterSkillSourceSettingsChange()
      // Drain anything the sibling watcher emitted before it was closed.
      await waitForQuietHooks()
      const settled = hookCalls()
      writeFileSync(siblingFile, 'disabled edit')
      await sleep(150)
      expect(hookCalls()).toBe(settled)
      await editUntilHook(ownFile, 'owned edit')
      siblingSkillsHomePaths = [sibling]
      await detector.reloadAfterSkillSourceSettingsChange()
      await new Promise<void>(resolve => realWatcher!.once('ready', resolve))
      await editUntilHook(siblingFile, 're-enabled edit')
    } finally {
      await detector.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)

  test('batches rapid reload requests into one hook/cache clear/notification', async () => {
    const detector = await importFreshModule()
    await detector.resetForTesting({ reloadDebounce: 5, reloadCooldown: 20 })

    let notifications = 0
    const unsubscribe = detector.subscribe(() => {
      notifications += 1
    })

    detector._scheduleReloadForTesting('/tmp/skills/a/SKILL.md')
    detector._scheduleReloadForTesting('/tmp/skills/b/SKILL.md')
    detector._scheduleReloadForTesting('/tmp/skills/c/SKILL.md')

    await sleep(30)

    expect(executeConfigChangeHooks).toHaveBeenCalledTimes(1)
    expect(clearCommandsCache).toHaveBeenCalledTimes(1)
    expect(clearSkillCaches).not.toHaveBeenCalled()
    expect(resetSentSkillNames).toHaveBeenCalledTimes(1)
    expect(notifications).toBe(1)

    unsubscribe()
    await detector.resetForTesting()
  })

  test('delays a second burst until the reload cooldown has elapsed', async () => {
    const detector = await importFreshModule()
    await detector.resetForTesting({ reloadDebounce: 5, reloadCooldown: 60 })

    let notifications = 0
    const unsubscribe = detector.subscribe(() => {
      notifications += 1
    })

    detector._scheduleReloadForTesting('/tmp/skills/first/SKILL.md')
    await sleep(20)
    expect(notifications).toBe(1)

    detector._scheduleReloadForTesting('/tmp/skills/second/SKILL.md')
    await sleep(20)
    expect(notifications).toBe(1)

    await sleep(60)
    expect(notifications).toBe(2)
    expect(executeConfigChangeHooks).toHaveBeenCalledTimes(2)

    unsubscribe()
    await detector.resetForTesting()
  })

  test('does not start cooldown when a ConfigChange hook blocks reload', async () => {
    const detector = await importFreshModule()
    await detector.resetForTesting({ reloadDebounce: 5, reloadCooldown: 500 })

    let notifications = 0
    const unsubscribe = detector.subscribe(() => {
      notifications += 1
    })

    hookResults = [{ blocked: true }]
    detector._scheduleReloadForTesting('/tmp/skills/blocked/SKILL.md')
    await sleep(20)
    expect(notifications).toBe(0)
    expect(clearCommandsCache).not.toHaveBeenCalled()

    hookResults = []
    detector._scheduleReloadForTesting('/tmp/skills/allowed/SKILL.md')
    await sleep(20)

    expect(notifications).toBe(1)
    expect(clearCommandsCache).toHaveBeenCalledTimes(1)

    unsubscribe()
    await detector.resetForTesting()
  })

  test('queues events during an in-flight reload before cache clear and notification', async () => {
    const detector = await importFreshModule()
    await detector.resetForTesting({ reloadDebounce: 5, reloadCooldown: 60 })

    let releaseFirstHook: (() => void) | undefined
    let releaseSecondHook: (() => void) | undefined
    let hookCalls = 0
    executeConfigChangeHooksImpl = async () => {
      hookCalls += 1
      if (hookCalls === 1) {
        await new Promise<void>(resolve => {
          releaseFirstHook = resolve
        })
      } else if (hookCalls === 2) {
        await new Promise<void>(resolve => {
          releaseSecondHook = resolve
        })
      }
      return hookResults
    }

    let notifications = 0
    const unsubscribe = detector.subscribe(() => {
      notifications += 1
    })

    detector._scheduleReloadForTesting('/tmp/skills/first/SKILL.md')
    await sleep(20)
    expect(executeConfigChangeHooks).toHaveBeenCalledTimes(1)

    detector._scheduleReloadForTesting('/tmp/skills/second/SKILL.md')
    await sleep(30)
    expect(executeConfigChangeHooks).toHaveBeenCalledTimes(1)

    releaseFirstHook?.()
    await sleep(20)
    expect(notifications).toBe(0)
    expect(clearCommandsCache).not.toHaveBeenCalled()
    expect(executeConfigChangeHooks).toHaveBeenCalledTimes(2)

    releaseSecondHook?.()
    await sleep(30)
    expect(notifications).toBe(1)
    expect(executeConfigChangeHooks).toHaveBeenCalledTimes(2)

    unsubscribe()
    await detector.resetForTesting()
  })

  test('dispose prevents an in-flight reload from clearing caches after hook resolution', async () => {
    const detector = await importFreshModule()
    await detector.resetForTesting({ reloadDebounce: 5, reloadCooldown: 20 })

    let releaseHook: (() => void) | undefined
    executeConfigChangeHooksImpl = async () => {
      await new Promise<void>(resolve => {
        releaseHook = resolve
      })
      return hookResults
    }

    let notifications = 0
    detector.subscribe(() => {
      notifications += 1
    })

    detector._scheduleReloadForTesting('/tmp/skills/in-flight/SKILL.md')
    await sleep(20)
    expect(executeConfigChangeHooks).toHaveBeenCalledTimes(1)

    await detector.dispose()
    releaseHook?.()
    await sleep(20)

    expect(clearCommandsCache).not.toHaveBeenCalled()
    expect(resetSentSkillNames).not.toHaveBeenCalled()
    expect(notifications).toBe(0)
  })

  test('dispose prevents later reload scheduling from running hooks', async () => {
    const detector = await importFreshModule()
    await detector.resetForTesting({ reloadDebounce: 5, reloadCooldown: 20 })

    let notifications = 0
    detector.subscribe(() => {
      notifications += 1
    })

    await detector.dispose()
    detector._scheduleReloadForTesting('/tmp/skills/after-dispose/SKILL.md')
    await sleep(20)

    expect(executeConfigChangeHooks).not.toHaveBeenCalled()
    expect(clearCommandsCache).not.toHaveBeenCalled()
    expect(notifications).toBe(0)
  })

  test('resetForTesting clears pending reload timers', async () => {
    const detector = await importFreshModule()
    await detector.resetForTesting({ reloadDebounce: 20, reloadCooldown: 20 })

    detector._scheduleReloadForTesting('/tmp/skills/pending/SKILL.md')
    await detector.resetForTesting({ reloadDebounce: 5, reloadCooldown: 5 })
    await sleep(30)

    expect(executeConfigChangeHooks).not.toHaveBeenCalled()
    expect(clearCommandsCache).not.toHaveBeenCalled()
  })
})
