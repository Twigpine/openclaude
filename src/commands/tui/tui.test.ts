import { afterEach, describe, expect, test } from 'bun:test'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import {
  _resetTmuxControlModeProbeForTesting,
  isFullscreenEnvEnabled,
} from '../../utils/fullscreen.js'
import { call } from './tui.js'

const noopContext = {} as Parameters<typeof call>[1]

const ENV_KEYS = ['CLAUDE_CODE_NO_FLICKER', 'TMUX', 'TERM_PROGRAM', 'TERM'] as const
const savedEnv = new Map<string, string | undefined>(
  ENV_KEYS.map(k => [k, process.env[k]]),
)

function clearModeEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k]
}

describe('/tui', () => {
  afterEach(() => {
    saveGlobalConfig(current => ({ ...current, flickerFreeMode: undefined }))
    for (const k of ENV_KEYS) {
      const v = savedEnv.get(k)
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    _resetTmuxControlModeProbeForTesting()
  })

  test('reports the current mode and usage with no argument', async () => {
    const result = await call('', noopContext)
    if (result.type === 'text') {
      expect(result.value).toContain('Current display mode')
      expect(result.value).toContain('/tui <fullscreen|inline>')
    }
  })

  test('fullscreen persists flickerFreeMode', async () => {
    await call('fullscreen', noopContext)
    expect(getGlobalConfig().flickerFreeMode).toBe(true)
  })

  test('inline clears flickerFreeMode', async () => {
    saveGlobalConfig(current => ({ ...current, flickerFreeMode: true }))
    await call('inline', noopContext)
    expect(getGlobalConfig().flickerFreeMode).toBe(false)
  })

  test('the saved mode drives the active display check', async () => {
    clearModeEnv()
    await call('fullscreen', noopContext)
    expect(isFullscreenEnvEnabled()).toBe(true)
    await call('inline', noopContext)
    expect(isFullscreenEnvEnabled()).toBe(false)
  })

  test('tmux -CC reports the effective inline mode', async () => {
    clearModeEnv()
    process.env.TMUX = '/tmp/tmux-test'
    process.env.TERM_PROGRAM = 'iTerm.app'
    process.env.TERM = 'xterm-256color'
    _resetTmuxControlModeProbeForTesting()

    const result = await call('fullscreen', noopContext)
    expect(getGlobalConfig().flickerFreeMode).toBe(true)
    expect(isFullscreenEnvEnabled()).toBe(false)
    if (result.type === 'text') {
      expect(result.value).toContain('effective display mode is inline')
    }
  })

  test('an unknown mode shows usage and writes nothing', async () => {
    const result = await call('bogus', noopContext)
    if (result.type === 'text') {
      expect(result.value).toContain('Usage')
    }
    expect(getGlobalConfig().flickerFreeMode).toBeUndefined()
  })
})
