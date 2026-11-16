import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { TerminalQuerier } from '../ink/terminal-querier.js'
import { getSystemThemeName, setCachedSystemTheme } from './systemTheme.js'
import { watchSystemTheme } from './systemThemeWatcher.js'

const savedSystemTheme = getSystemThemeName()

afterEach(() => {
  setCachedSystemTheme(savedSystemTheme)
})

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
    const stop = watchSystemTheme(
      fakeQuerier(data),
      theme => seen.push(theme),
      10,
    )

    await sleep(50)
    expect(seen).toEqual(['dark'])
    expect(getSystemThemeName()).toBe('dark')

    data.current = 'rgb:ffff/ffff/ffff'
    await sleep(50)
    expect(seen).toEqual(['dark', 'light'])
    expect(getSystemThemeName()).toBe('light')

    stop()
  })

  test('does not fire for unparseable or unanswered queries', async () => {
    const data = { current: 'not-a-color' as string | undefined }
    const onThemeChange = mock(() => {})
    const stop = watchSystemTheme(fakeQuerier(data), onThemeChange, 10)

    await sleep(50)
    expect(onThemeChange).not.toHaveBeenCalled()

    data.current = undefined
    await sleep(50)
    expect(onThemeChange).not.toHaveBeenCalled()

    stop()
  })

  test('stops polling after unsubscribe', async () => {
    const data = { current: 'rgb:0000/0000/0000' as string | undefined }
    const seen: string[] = []
    const stop = watchSystemTheme(
      fakeQuerier(data),
      theme => seen.push(theme),
      10,
    )

    await sleep(50)
    expect(seen).toEqual(['dark'])
    stop()

    data.current = 'rgb:ffff/ffff/ffff'
    await sleep(50)
    expect(seen).toEqual(['dark'])
  })
})
