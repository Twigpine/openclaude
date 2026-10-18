import chokidar, { type FSWatcher } from 'chokidar'
import * as platformPath from 'path'
import { getAdditionalDirectoriesForClaudeMd } from '../../bootstrap/state.js'
import {
  clearCommandMemoizationCaches,
  clearCommandsCache,
} from '../../commands.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import {
  getEnabledSiblingSkillsHomes,
  getSkillsPath,
  onDynamicSkillsLoaded,
} from '../../skills/loadSkillsDir.js'
import { PROJECT_CONFIG_DIR_NAMES } from '../markdownConfigLoader.js'
import { resetSentSkillNames } from '../attachments.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { logForDebugging } from '../debug.js'
import { getFsImplementation } from '../fsOperations.js'
import { executeConfigChangeHooks, hasBlockingResult } from '../hooks.js'
import { logError } from '../log.js'
import { settingsChangeDetector } from '../settings/changeDetector.js'
import { createSignal } from '../signal.js'

/**
 * Time in milliseconds to wait for file writes to stabilize before processing.
 */
const FILE_STABILITY_THRESHOLD_MS = 1000

/**
 * Polling interval in milliseconds for checking file stability.
 */
const FILE_STABILITY_POLL_INTERVAL_MS = 500

/**
 * Time in milliseconds to debounce rapid skill change events into a single
 * reload. Prevents cascading reloads when many skill files change at once
 * (e.g. during auto-update, folder moves/renames, or when another session
 * modifies skill directories).
 */
const RELOAD_DEBOUNCE_MS = 3000

/**
 * Minimum spacing between completed skill reloads. Some filesystem operations
 * emit multiple event waves; this prevents a second wave from causing an
 * immediate back-to-back reload after the first batch finishes.
 */
const RELOAD_COOLDOWN_MS = 5000

/**
 * Polling interval for chokidar when usePolling is enabled.
 * Skill files change rarely (manual edits, git operations), so a 2s interval
 * trades negligible latency for far fewer stat() calls than the default 100ms.
 */
const POLLING_INTERVAL_MS = 2000

/**
 * Bun's native fs.watch() has a PathWatcherManager deadlock (oven-sh/bun#27469,
 * #26385): closing a watcher on the main thread while the File Watcher thread
 * is delivering events can hang both threads in __ulock_wait2 forever. Chokidar
 * with depth: 2 on large skill trees (hundreds of subdirs) triggers this
 * reliably when a git operation touches many directories at once — chokidar
 * internally closes/reopens per-directory FSWatchers as dirs are added/removed.
 *
 * Workaround: use stat() polling under Bun. No FSWatcher = no deadlock.
 * The fix is pending upstream; remove this once the Bun PR lands.
 */
const USE_POLLING = typeof Bun !== 'undefined'

let watcher: FSWatcher | null = null
let siblingWatcher: FSWatcher | null = null
let ownWatchPaths: string[] = []
let siblingWatchUpdate: Promise<void> = Promise.resolve()
let siblingWatchPaths: string[] = []
let siblingSourcePaths: string[] = []
let unsubscribeSettingsChanges: (() => void) | null = null
let reloadTimer: ReturnType<typeof setTimeout> | null = null
const pendingChangedPaths = new Set<string>()
let lastReloadTime = 0
let reloadInProgress = false
let initialized = false
let disposed = false
let dynamicSkillsCallbackRegistered = false
let unregisterDynamicSkillsCallback: (() => void) | null = null
let unregisterCleanup: (() => void) | null = null
const skillsChanged = createSignal()

// Test overrides for timing constants
let testOverrides: {
  stabilityThreshold?: number
  pollInterval?: number
  reloadDebounce?: number
  reloadCooldown?: number
  /** Chokidar fs.stat polling interval when USE_POLLING is active. */
  chokidarInterval?: number
} | null = null

const defaultDependencies = {
  clearCommandMemoizationCaches,
  clearCommandsCache,
  executeConfigChangeHooks,
  getFsImplementation,
  getAdditionalDirectoriesForClaudeMd,
  getSkillsPath,
  getSiblingSkillsHomePaths: (): string[] =>
    getEnabledSiblingSkillsHomes().map(home => home.path),
  hasBlockingResult,
  onDynamicSkillsLoaded,
  resetSentSkillNames,
  watch: chokidar.watch.bind(chokidar),
  subscribeToSettingsChanges: settingsChangeDetector.subscribe,
}
type SkillChangeDetectorDependencies = typeof defaultDependencies
let dependencies: SkillChangeDetectorDependencies = defaultDependencies

/**
 * Initialize file watching for skill directories
 */
export async function initialize(): Promise<void> {
  if (initialized || disposed) return
  initialized = true

  // Register cleanup before the first await so dispose() can win races during
  // async path discovery.
  unregisterCleanup = registerCleanup(async () => {
    await dispose()
  })

  siblingSourcePaths = dependencies.getSiblingSkillsHomePaths()
  unsubscribeSettingsChanges = dependencies.subscribeToSettingsChanges(() => {
    if (disposed) return
    const paths = dependencies.getSiblingSkillsHomePaths()
    if (paths.length === siblingSourcePaths.length &&
      paths.every((path, index) => path === siblingSourcePaths[index])) return
    // The settings notifier has already invalidated its cache. Use effective
    // eligibility so unrelated settings changes do not reset activated skills.
    void reloadAfterSkillSourceSettingsChange().catch(logError)
  })

  // Register callback for when dynamic skills are loaded (only once)
  if (!dynamicSkillsCallbackRegistered) {
    dynamicSkillsCallbackRegistered = true
    unregisterDynamicSkillsCallback = dependencies.onDynamicSkillsLoaded(() => {
      if (disposed) return
      // Clear memoization caches so new skills are picked up
      // Note: we use clearCommandMemoizationCaches (not clearCommandsCache)
      // because clearCommandsCache would call clearSkillCaches which
      // wipes out the dynamic skills we just loaded
      dependencies.clearCommandMemoizationCaches()
      // Notify listeners that skills changed
      skillsChanged.emit()
    })
  }

  const paths = await getWatchablePaths()
  if (disposed) return
  ownWatchPaths = paths
  watcher = watchPaths(paths)
  await reconcileSiblingWatchPaths()
}

/** Serialize live toggles so a slower path lookup cannot restore an old source. */
function reconcileSiblingWatchPaths(): Promise<void> {
  const update = siblingWatchUpdate.then(updateSiblingWatchPaths)
  siblingWatchUpdate = update.catch(() => {})
  return update
}

async function updateSiblingWatchPaths(): Promise<void> {
  if (disposed) return
  const fs = dependencies.getFsImplementation()
  const paths: string[] = []
  for (const path of dependencies.getSiblingSkillsHomePaths()) {
    if (ownWatchPaths.includes(path)) continue
    try {
      await fs.stat(path)
      paths.push(path)
    } catch {
      // Only existing skill homes are watched, as at startup.
    }
  }
  if (disposed) return
  if (
    paths.length === siblingWatchPaths.length &&
    paths.every(path => siblingWatchPaths.includes(path))
  ) return
  // Chokidar unwatch(root) leaves existing descendant file watchers active.
  // Give sibling subscriptions their own lifetime so closing them fully does
  // not interrupt OpenClaude-owned watches.
  const previous = siblingWatcher
  siblingWatcher = null
  if (previous) await previous.close()
  if (disposed) return
  siblingWatchPaths = paths
  siblingWatcher = watchPaths(paths, true)
}

/**
 * Create a watcher for one group of skill sources. Empty groups need no watcher.
 */
function watchPaths(paths: string[], allowSkillLinks = false): FSWatcher | null {
  if (paths.length === 0) return null

  logForDebugging(
    `Watching for changes in skill/command directories: ${paths.join(', ')}...`,
  )

  const sourceWatcher = dependencies.watch(paths, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold:
        testOverrides?.stabilityThreshold ?? FILE_STABILITY_THRESHOLD_MS,
      pollInterval:
        testOverrides?.pollInterval ?? FILE_STABILITY_POLL_INTERVAL_MS,
    },
    // Ignore special file types (sockets, FIFOs, devices) - they cannot be watched
    // and will error with EOPNOTSUPP on macOS. Sibling discovery also follows
    // links; let Chokidar traverse those and check the resolved target's type.
    ignored: (path, stats) => {
      if (stats && !stats.isFile() && !stats.isDirectory() &&
        !(allowSkillLinks && stats.isSymbolicLink())) return true
      // Ignore .git directories
      return path.split(platformPath.sep).some(dir => dir === '.git')
    },
    ignorePermissionErrors: true,
    usePolling: USE_POLLING,
    interval: testOverrides?.chokidarInterval ?? POLLING_INTERVAL_MS,
    atomic: true,
  })

  sourceWatcher.on('add', handleChange)
  sourceWatcher.on('change', handleChange)
  sourceWatcher.on('unlink', handleChange)
  return sourceWatcher
}

/**
 * Clean up file watcher
 */
export function dispose(): Promise<void> {
  disposed = true
  unsubscribeSettingsChanges?.()
  unsubscribeSettingsChanges = null
  siblingSourcePaths = []
  if (unregisterCleanup) {
    unregisterCleanup()
    unregisterCleanup = null
  }
  if (unregisterDynamicSkillsCallback) {
    unregisterDynamicSkillsCallback()
    unregisterDynamicSkillsCallback = null
    dynamicSkillsCallbackRegistered = false
  }
  const closing = [watcher?.close(), siblingWatcher?.close(), siblingWatchUpdate]
  watcher = null
  siblingWatcher = null
  ownWatchPaths = []
  siblingWatchPaths = []
  if (reloadTimer) {
    clearTimeout(reloadTimer)
    reloadTimer = null
  }
  pendingChangedPaths.clear()
  lastReloadTime = 0
  reloadInProgress = false
  skillsChanged.clear()
  return Promise.all(closing).then(() => {})
}

/**
 * Subscribe to skill changes
 */
export const subscribe = skillsChanged.subscribe

async function getWatchablePaths(): Promise<string[]> {
  const fs = dependencies.getFsImplementation()
  const paths: string[] = []

  async function pushIfExists(path: string): Promise<void> {
    try {
      await fs.stat(path)
      paths.push(path)
    } catch {
      // Path doesn't exist, skip it
    }
  }

  // User skills directory (~/.openclaude/skills)
  const userSkillsPath = dependencies.getSkillsPath('userSettings', 'skills')
  if (userSkillsPath) {
    await pushIfExists(userSkillsPath)
  }

  // User commands directory (~/.openclaude/commands)
  const userCommandsPath = dependencies.getSkillsPath(
    'userSettings',
    'commands',
  )
  if (userCommandsPath) {
    await pushIfExists(userCommandsPath)
  }

  // Project skills/commands directories. Keep this in sync with the loader's
  // OpenClaude project config directories.
  for (const configDirName of PROJECT_CONFIG_DIR_NAMES) {
    await pushIfExists(platformPath.resolve(configDirName, 'skills'))
    await pushIfExists(platformPath.resolve(configDirName, 'commands'))
  }

  // Additional directories (--add-dir) skills
  for (const dir of dependencies.getAdditionalDirectoriesForClaudeMd()) {
    for (const configDirName of PROJECT_CONFIG_DIR_NAMES) {
      await pushIfExists(platformPath.join(dir, configDirName, 'skills'))
    }
  }

  return paths
}

function handleChange(path: string): void {
  if (disposed) return
  logForDebugging(`Detected skill change: ${path}`)
  logEvent('tengu_skill_file_changed', {
    source:
      'chokidar' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  scheduleReload(path)
}

/**
 * Debounce rapid skill changes into a single reload. When many skill files
 * change at once (e.g. auto-update installs a new binary and a new session
 * touches skill directories), each file fires its own chokidar event. Without
 * debouncing, each event triggers clearCommandsCache() + listener notification
 * — 30 events means 30 full reload cycles, which can deadlock the Bun event
 * loop via rapid FSWatcher watch/unwatch churn.
 */
function scheduleReload(changedPath: string): void {
  if (disposed) return
  pendingChangedPaths.add(changedPath)
  if (reloadInProgress) return
  scheduleReloadTimer()
}

function scheduleReloadTimer(): void {
  if (reloadTimer) clearTimeout(reloadTimer)
  const debounceMs = testOverrides?.reloadDebounce ?? RELOAD_DEBOUNCE_MS
  const reloadCooldownMs = testOverrides?.reloadCooldown ?? RELOAD_COOLDOWN_MS
  const cooldownRemaining = lastReloadTime + reloadCooldownMs - Date.now()
  const delay = Math.max(debounceMs, cooldownRemaining)
  reloadTimer = setTimeout(async () => {
    reloadTimer = null
    if (disposed) return
    const paths = [...pendingChangedPaths]
    pendingChangedPaths.clear()
    if (paths.length === 0) return

    reloadInProgress = true
    try {
      // Fire ConfigChange hook once for the batch — the hook query is always
      // 'skills' so firing per-path (which can be hundreds during a git
      // operation) just spams the hook matcher with identical queries. Pass the
      // first path as a representative; hooks can inspect all paths via the
      // skills directory if they need the full set.
      const results = await dependencies.executeConfigChangeHooks(
        'skills',
        paths[0]!,
      )
      if (dependencies.hasBlockingResult(results)) {
        logForDebugging(
          `ConfigChange hook blocked skill reload (${paths.length} paths)`,
        )
        return
      }
      if (disposed) return
      if (pendingChangedPaths.size > 0) {
        logForDebugging(
          `Deferring skill reload because ${pendingChangedPaths.size} newer paths arrived during hooks`,
        )
        return
      }
      dependencies.clearCommandsCache()
      dependencies.resetSentSkillNames()
      lastReloadTime = Date.now()
      skillsChanged.emit()
    } finally {
      reloadInProgress = false
      if (!disposed && pendingChangedPaths.size > 0) {
        scheduleReloadTimer()
      }
    }
  }, delay)
}

/**
 * Reset internal state for testing purposes only.
 */
export async function resetForTesting(overrides?: {
  stabilityThreshold?: number
  pollInterval?: number
  reloadDebounce?: number
  reloadCooldown?: number
  chokidarInterval?: number
}): Promise<void> {
  // Drain in-flight source updates before restoring test state.
  disposed = true
  unsubscribeSettingsChanges?.()
  unsubscribeSettingsChanges = null
  siblingSourcePaths = []
  await siblingWatchUpdate
  await Promise.all([watcher?.close(), siblingWatcher?.close()])
  watcher = null
  siblingWatcher = null
  ownWatchPaths = []
  siblingWatchPaths = []
  if (unregisterCleanup) {
    unregisterCleanup()
    unregisterCleanup = null
  }
  if (unregisterDynamicSkillsCallback) {
    unregisterDynamicSkillsCallback()
    unregisterDynamicSkillsCallback = null
    dynamicSkillsCallbackRegistered = false
  }
  if (reloadTimer) {
    clearTimeout(reloadTimer)
    reloadTimer = null
  }
  pendingChangedPaths.clear()
  lastReloadTime = 0
  reloadInProgress = false
  skillsChanged.clear()
  initialized = false
  disposed = false
  testOverrides = overrides ?? null
}

/**
 * Reload skills right away after a setting changed which skill directories
 * load (sibling skills homes toggled in /config). Add enabled homes and stop
 * watching disabled homes so only eligible sources trigger later reloads.
 */
export async function reloadAfterSkillSourceSettingsChange(): Promise<void> {
  if (disposed) return
  siblingSourcePaths = dependencies.getSiblingSkillsHomePaths()
  // Invalidate synchronously, before asynchronous watcher reconciliation, so
  // neither cached commands nor an older sibling scan can survive the signal.
  dependencies.clearCommandsCache()
  dependencies.resetSentSkillNames()
  if (initialized) {
    await reconcileSiblingWatchPaths()
  }
  if (disposed) return
  skillsChanged.emit()
}

export const _scheduleReloadForTesting = scheduleReload

export function _setDependenciesForTesting(
  overrides: Partial<SkillChangeDetectorDependencies> = {},
): void {
  dependencies = { ...defaultDependencies, ...overrides }
}

export const skillChangeDetector = {
  initialize,
  dispose,
  subscribe,
  reloadAfterSkillSourceSettingsChange,
  resetForTesting,
}
