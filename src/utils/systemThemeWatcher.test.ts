import { afterEach, describe, expect, mock, test } from 'bun:test'
import { feature } from 'bun:bundle'
import type { TerminalQuerier } from '../ink/terminal-querier.js'
import { getSystemThemeName, setCachedSystemTheme } from './systemTheme.js'
import { startSystemThemeWatchIfEnabled } from './systemThemeWatchGate.js'
import { watchSystemTheme } from './systemThemeWatcher.js'

const savedSystemTheme = getSystemThemeName()
const stops: Array<() => void> = []

afterEach(() => {
  for (const stop of stops.splice(0)) {
    stop()
  }
  setCachedSystemTheme(savedSystemTheme)
})

function watch(
  querier: TerminalQuerier,
  onThemeChange: (theme: string) => void,
): void {
  stops.push(watchSystemTheme(querier, onThemeChange, 10))
}

function fakeQuerier(data: { current: string | undefined }): TerminalQuerier {
  return {
    send: mock(() =>
      Promise.resolve(
        data.current === undefined
          ? undefined
          : { type: 'osc' as const, code: 11, data: data.current },
      ),
    ),
    flush: mock(() => Promise.resolve()),
    onResponse: () => {},
  } as unknown as TerminalQuerier
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('watchSystemTheme', () => {
  test('fires onThemeChange with the detected theme and tracks live changes', async () => {
    const data = { current: 'rgb:0000/0000/0000' as string | undefined }
    const seen: string[] = []
    watch(fakeQuerier(data), theme => seen.push(theme))

    await sleep(50)
    expect(seen).toEqual(['dark'])
    expect(getSystemThemeName()).toBe('dark')

    data.current = 'rgb:ffff/ffff/ffff'
    await sleep(50)
    expect(seen).toEqual(['dark', 'light'])
    expect(getSystemThemeName()).toBe('light')
  })

  test('does not fire for unparseable or unanswered queries', async () => {
    const data = { current: 'not-a-color' as string | undefined }
    const onThemeChange = mock(() => {})
    watch(fakeQuerier(data), onThemeChange)

    await sleep(50)
    expect(onThemeChange).not.toHaveBeenCalled()

    data.current = undefined
    await sleep(50)
    expect(onThemeChange).not.toHaveBeenCalled()
  })

  test('stops polling after unsubscribe', async () => {
    const data = { current: 'rgb:0000/0000/0000' as string | undefined }
    const seen: string[] = []
    const stop = watchSystemTheme(fakeQuerier(data), theme => seen.push(theme), 10)
    stops.push(stop)

    await sleep(50)
    expect(seen).toEqual(['dark'])
    stop()

    data.current = 'rgb:ffff/ffff/ffff'
    await sleep(50)
    expect(seen).toEqual(['dark'])
  })

  test('AUTO_THEME gate starts the watcher only when the flag is on', async () => {
    const querier = fakeQuerier({ current: 'rgb:0000/0000/0000' })
    const stop = startSystemThemeWatchIfEnabled(querier, () => {})
    stops.push(stop)

    await sleep(50)
    if (feature('AUTO_THEME')) {
      expect(querier.send).toHaveBeenCalled()
    } else {
      expect(querier.send).not.toHaveBeenCalled()
    }
  })
})
