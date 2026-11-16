import { feature } from 'bun:bundle'
import type { TerminalQuerier } from '../ink/terminal-querier.js'
import type { SystemTheme } from './systemTheme.js'

/**
 * Start watching the system theme only when the AUTO_THEME flag
 * compiled on. The flag check lives here, not in the caller, so the
 * gate is testable; the lazy require keeps systemThemeWatcher dead-code
 * eliminated in builds where the flag folds to false.
 */
export function startSystemThemeWatchIfEnabled(
  querier: TerminalQuerier,
  onThemeChange: (theme: SystemTheme) => void,
): () => void {
  if (!feature('AUTO_THEME')) return () => {}
  const { watchSystemTheme } = require('./systemThemeWatcher.js') as typeof import('./systemThemeWatcher.js')
  return watchSystemTheme(querier, onThemeChange)
}
