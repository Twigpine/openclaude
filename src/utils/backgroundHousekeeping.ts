import { feature } from 'bun:bundle'
import { initAutoDream } from '../services/autoDream/autoDream.js'
import { initMagicDocs } from '../services/MagicDocs/magicDocs.js'
import { initSkillImprovement } from './hooks/skillImprovement.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const extractMemoriesModule = feature('EXTRACT_MEMORIES')
  ? (require('../services/extractMemories/extractMemories.js') as typeof import('../services/extractMemories/extractMemories.js'))
  : null
const registerProtocolModule = feature('LODESTONE')
  ? (require('./deepLink/registerProtocol.js') as typeof import('./deepLink/registerProtocol.js'))
  : null

/* eslint-enable @typescript-eslint/no-require-imports */

import { getIsInteractive, getLastInteractionTime } from '../bootstrap/state.js'
import {
  cleanupBackgroundSessionRetentionInBackground,
  cleanupBackgroundSessionsInBackground,
  cleanupNpmCacheForAnthropicPackages,
  cleanupOldMessageFilesInBackground,
  cleanupOldVersionsThrottled,
} from './cleanup.js'
import { logError } from './log.js'
import { cleanupOldVersions } from './nativeInstaller/index.js'
import { autoUpdateMarketplacesAndPluginsInBackground } from './plugins/pluginAutoupdate.js'

// 24 hours in milliseconds
const RECURRING_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
// Terminal facts are a durable handoff from background children. The cleanup
// coordinator globally throttles this minute trigger and streams only a bounded
// fact/metadata sample, without rerunning the age-based retention sweep.
const BACKGROUND_SESSION_RECONCILIATION_INTERVAL_MS = 60 * 1000

// 10 minutes after start.
const DELAY_VERY_SLOW_OPERATIONS_THAT_HAPPEN_EVERY_SESSION = 10 * 60 * 1000

type BackgroundSessionScheduleOptions = {
  cleanup?: () => Promise<unknown>
  setInterval?: (
    callback: () => void,
    intervalMs: number,
  ) => { unref(): unknown }
  _onPassFinishedForTesting?: () => void
}

type BackgroundHousekeepingOptions = {
  backgroundSessionReconciliation?: BackgroundSessionScheduleOptions
  backgroundSessionRetention?: BackgroundSessionScheduleOptions
  _reconciliationOnlyForTesting?: boolean
  _backgroundSessionTimersOnlyForTesting?: boolean
}

function scheduleNonOverlappingBackgroundCleanup(
  cleanup: () => Promise<unknown>,
  intervalMs: number,
  options: BackgroundSessionScheduleOptions,
): void {
  const scheduleInterval =
    options.setInterval ??
    ((callback, intervalMs) => setInterval(callback, intervalMs))
  let running = false
  const interval = scheduleInterval(() => {
    if (running) return
    running = true
    void Promise.resolve()
      .then(() => cleanup())
      .catch(error => logError(error as Error))
      .finally(() => {
        running = false
        options._onPassFinishedForTesting?.()
      })
  }, intervalMs)
  interval.unref()
}

function startBackgroundSessionRetention(
  options: BackgroundSessionScheduleOptions = {},
): void {
  scheduleNonOverlappingBackgroundCleanup(
    options.cleanup ?? cleanupBackgroundSessionRetentionInBackground,
    RECURRING_CLEANUP_INTERVAL_MS,
    options,
  )
}

export function startBackgroundSessionReconciliation(
  options: BackgroundSessionScheduleOptions = {},
): void {
  scheduleNonOverlappingBackgroundCleanup(
    options.cleanup ?? cleanupBackgroundSessionsInBackground,
    BACKGROUND_SESSION_RECONCILIATION_INTERVAL_MS,
    options,
  )
}

export function startBackgroundHousekeeping(
  options: BackgroundHousekeepingOptions = {},
): void {
  startBackgroundSessionReconciliation(
    options.backgroundSessionReconciliation,
  )
  if (options._reconciliationOnlyForTesting) return
  startBackgroundSessionRetention(options.backgroundSessionRetention)
  if (options._backgroundSessionTimersOnlyForTesting) return

  void initMagicDocs()
  void initSkillImprovement()
  if (feature('EXTRACT_MEMORIES')) {
    extractMemoriesModule!.initExtractMemories()
  }
  initAutoDream()
  void autoUpdateMarketplacesAndPluginsInBackground()
  if (feature('LODESTONE') && getIsInteractive()) {
    void registerProtocolModule!.ensureDeepLinkProtocolRegistered()
  }
  let needsCleanup = true
  async function runVerySlowOps(): Promise<void> {
    // If the user did something in the last minute, don't make them wait for these slow operations to run.
    if (
      getIsInteractive() &&
      getLastInteractionTime() > Date.now() - 1000 * 60
    ) {
      setTimeout(
        runVerySlowOps,
        DELAY_VERY_SLOW_OPERATIONS_THAT_HAPPEN_EVERY_SESSION,
      ).unref()
      return
    }

    if (needsCleanup) {
      needsCleanup = false
      await cleanupOldMessageFilesInBackground()
    }

    // If the user did something in the last minute, don't make them wait for these slow operations to run.
    if (
      getIsInteractive() &&
      getLastInteractionTime() > Date.now() - 1000 * 60
    ) {
      setTimeout(
        runVerySlowOps,
        DELAY_VERY_SLOW_OPERATIONS_THAT_HAPPEN_EVERY_SESSION,
      ).unref()
      return
    }

    await cleanupOldVersions()
  }

  setTimeout(
    runVerySlowOps,
    DELAY_VERY_SLOW_OPERATIONS_THAT_HAPPEN_EVERY_SESSION,
  ).unref()

  // For long-running sessions, schedule recurring cleanup every 24 hours.
  // Both cleanup functions use marker files and locks to throttle to once per day
  // and skip immediately if another process holds the lock.
  if (process.env.USER_TYPE === 'ant') {
    const interval = setInterval(() => {
      void cleanupNpmCacheForAnthropicPackages()
      void cleanupOldVersionsThrottled()
    }, RECURRING_CLEANUP_INTERVAL_MS)

    // Don't let this interval keep the process alive
    interval.unref()
  }
}
