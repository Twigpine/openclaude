/**
 * Live terminal theme watcher (OSC 11 polling).
 *
 * Polls the terminal's background color while the 'auto' theme is active so
 * light/dark switches apply without a restart. Each poll is bracketed by the
 * querier's DA1 sentinel, so a terminal that ignores OSC 11 resolves the send
 * with undefined instead of leaving it pending.
 */

import type { TerminalQuerier } from '../ink/terminal-querier.js'
import { oscColor } from '../ink/terminal-querier.js'
import {
  setCachedSystemTheme,
  themeFromOscColor,
  type SystemTheme,
} from './systemTheme.js'

const OSC11_BACKGROUND = 11
const POLL_INTERVAL_MS = 2_000

/**
 * Watch the terminal's background color for live light/dark changes.
 *
 * Fires onThemeChange with the detected theme after each successful query
 * whose result differs from the last detected value, and keeps the
 * module-level systemTheme cache in sync.
 *
 * @returns An unsubscribe function that stops the poll loop.
 */
export function watchSystemTheme(
  querier: TerminalQuerier,
  onThemeChange: (theme: SystemTheme) => void,
  pollIntervalMs: number = POLL_INTERVAL_MS,
): () => void {
  let cancelled = false
  let lastDetected: SystemTheme | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const poll = async (): Promise<void> => {
    while (!cancelled) {
      let response
      try {
        const pending = querier.send(oscColor(OSC11_BACKGROUND))
        // DA1 barrier: resolves the send with undefined when the terminal
        // does not answer OSC 11 at all.
        await querier.flush()
        response = await pending
      } catch {
        return
      }
      if (cancelled) return

      const theme = response ? themeFromOscColor(response.data) : undefined
      if (theme !== undefined && theme !== lastDetected) {
        lastDetected = theme
        setCachedSystemTheme(theme)
        onThemeChange(theme)
      }

      await new Promise<void>(resolve => {
        timer = setTimeout(resolve, pollIntervalMs)
      })
    }
  }

  void poll()

  return () => {
    cancelled = true
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}
