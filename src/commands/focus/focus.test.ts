import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { LocalCommandResult } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { _resetTmuxControlModeProbeForTesting } from '../../utils/fullscreen.js'
import { call } from './focus.js'

const noopContext = {} as Parameters<typeof call>[1]

function expectText(
  res: LocalCommandResult,
): Extract<LocalCommandResult, { type: 'text' }> {
  if (res.type !== 'text') throw new Error(`expected a text result, got ${res.type}`)
  return res
}

const ENV_KEYS = ['CLAUDE_CODE_NO_FLICKER', 'TMUX', 'TERM_PROGRAM', 'TERM'] as const
const savedEnv = new Map<string, string | undefined>(
  ENV_KEYS.map(k => [k, process.env[k]]),
)

function setFocus(value: boolean | undefined): void {
  saveGlobalConfig(current => ({ ...current, focusView: value }))
}

describe('/focus', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k]
    process.env.CLAUDE_CODE_NO_FLICKER = '1'
    _resetTmuxControlModeProbeForTesting()
    setFocus(undefined)
  })

  afterEach(() => {
    setFocus(undefined)
    for (const k of ENV_KEYS) {
      const v = savedEnv.get(k)
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    _resetTmuxControlModeProbeForTesting()
  })

  test('turns focus on from off and says so', async () => {
    setFocus(false)
    const res = expectText(await call('', noopContext))
    expect(getGlobalConfig().focusView).toBe(true)
    expect(res.value).toContain('Focus view is on')
  })

  test('turns focus on when the setting was never stored', async () => {
    const res = expectText(await call('', noopContext))
    expect(getGlobalConfig().focusView).toBe(true)
    expect(res.value).toContain('Focus view is on')
  })

  test('turns focus off from on and says so', async () => {
    setFocus(true)
    const res = expectText(await call('', noopContext))
    expect(getGlobalConfig().focusView).toBe(false)
    expect(res.value).toContain('Focus view is off')
  })

  test('ignores arguments: "on" with focus already on still toggles off', async () => {
    setFocus(true)
    const res = expectText(await call('on', noopContext))
    expect(getGlobalConfig().focusView).toBe(false)
    expect(res.value).toContain('Focus view is off')
  })

  for (const start of [false, true]) {
    test(`outside fullscreen it points to /tui fullscreen and leaves focus ${start}`, async () => {
      process.env.CLAUDE_CODE_NO_FLICKER = '0'
      setFocus(start)
      const res = expectText(await call('', noopContext))
      expect(res.value).toContain('/tui fullscreen')
      expect(getGlobalConfig().focusView).toBe(start)
    })
  }

  test('outside fullscreen it leaves an unset setting unset', async () => {
    process.env.CLAUDE_CODE_NO_FLICKER = '0'
    const res = expectText(await call('', noopContext))
    expect(res.value).toContain('/tui fullscreen')
    expect(getGlobalConfig().focusView).toBeUndefined()
  })
})
