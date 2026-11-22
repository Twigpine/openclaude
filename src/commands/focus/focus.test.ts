import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { LocalCommandResult } from '../../types/command.js'
import * as configModule from '../../utils/config.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { _resetTmuxControlModeProbeForTesting } from '../../utils/fullscreen.js'
import { call } from './focus.js'

const noopContext = {
  getAppState: () => ({ isBriefOnly: false }),
} as Parameters<typeof call>[1]

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
  let savedFlickerFreeMode: boolean | undefined

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k]
    process.env.CLAUDE_CODE_NO_FLICKER = '1'
    _resetTmuxControlModeProbeForTesting()
    savedFlickerFreeMode = getGlobalConfig().flickerFreeMode
    setFocus(undefined)
  })

  afterEach(() => {
    setFocus(undefined)
    saveGlobalConfig(current => ({ ...current, flickerFreeMode: savedFlickerFreeMode }))
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
    test(`with fullscreen off by setting it points to /tui fullscreen and leaves focus ${start}`, async () => {
      delete process.env.CLAUDE_CODE_NO_FLICKER
      saveGlobalConfig(current => ({ ...current, flickerFreeMode: false }))
      setFocus(start)
      const res = expectText(await call('', noopContext))
      expect(res.value).toContain('/tui fullscreen')
      expect(getGlobalConfig().focusView).toBe(start)
    })

    test(`with CLAUDE_CODE_NO_FLICKER=0 it names the variable, not /tui, and leaves focus ${start}`, async () => {
      process.env.CLAUDE_CODE_NO_FLICKER = '0'
      setFocus(start)
      const res = expectText(await call('', noopContext))
      expect(res.value).toContain('CLAUDE_CODE_NO_FLICKER')
      expect(res.value).not.toContain('/tui fullscreen')
      expect(getGlobalConfig().focusView).toBe(start)
    })
  }

  test('under tmux -CC it names the override variable, not /tui', async () => {
    delete process.env.CLAUDE_CODE_NO_FLICKER
    process.env.TMUX = '/tmp/tmux-1/default,1,0'
    process.env.TERM_PROGRAM = 'iTerm.app'
    process.env.TERM = 'xterm-256color'
    _resetTmuxControlModeProbeForTesting()
    const res = expectText(await call('', noopContext))
    expect(res.value).toContain('tmux -CC')
    expect(res.value).toContain('CLAUDE_CODE_NO_FLICKER=1')
    expect(res.value).not.toContain('/tui fullscreen')
    expect(getGlobalConfig().focusView).toBeUndefined()
  })

  test('with fullscreen forced off it leaves an unset setting unset', async () => {
    process.env.CLAUDE_CODE_NO_FLICKER = '0'
    expectText(await call('', noopContext))
    expect(getGlobalConfig().focusView).toBeUndefined()
  })

  test('with Brief-only on it still saves the setting but says Brief owns the display', async () => {
    const brief = {
      getAppState: () => ({ isBriefOnly: true }),
    } as Parameters<typeof call>[1]
    const res = expectText(await call('', brief))
    expect(getGlobalConfig().focusView).toBe(true)
    expect(res.value).toBe(
      'Focus view is on, but Brief mode owns the display. It takes effect once Brief mode is off.',
    )
    const off = expectText(await call('', brief))
    expect(getGlobalConfig().focusView).toBe(false)
    expect(off.value).toContain('Focus view is off')
  })

  test('the confirmation lists what stays visible', async () => {
    const res = expectText(await call('', noopContext))
    expect(res.value).toContain('failures')
    expect(res.value).not.toMatch(/\bonly\b/i)
  })

  test('toggles against the config the locked updater sees, not a stale cached read', async () => {
    setFocus(true)
    // Another session already turned focus on; this session's cache still says off.
    const stale = spyOn(configModule, 'getGlobalConfig').mockReturnValue({
      ...getGlobalConfig(),
      focusView: false,
    })
    try {
      const res = expectText(await call('', noopContext))
      stale.mockRestore()
      expect(getGlobalConfig().focusView).toBe(false)
      expect(res.value).toContain('Focus view is off')
    } finally {
      stale.mockRestore()
    }
  })

  test('does not report success when the write was skipped', async () => {
    setFocus(false)
    const skipped = spyOn(configModule, 'saveGlobalConfig').mockImplementation(
      () => {},
    )
    try {
      const res = expectText(await call('', noopContext))
      expect(getGlobalConfig().focusView).toBe(false)
      expect(res.value).not.toContain('Focus view is on')
      expect(res.value).toContain('Could not save')
    } finally {
      skipped.mockRestore()
    }
  })
})
