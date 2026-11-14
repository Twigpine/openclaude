import { afterEach, describe, expect, test } from 'bun:test'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { call } from './tui.js'

const noopContext = {} as Parameters<typeof call>[1]

describe('/tui', () => {
  afterEach(() => {
    saveGlobalConfig(current => ({ ...current, flickerFreeMode: undefined }))
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

  test('an unknown mode shows usage and writes nothing', async () => {
    const result = await call('bogus', noopContext)
    if (result.type === 'text') {
      expect(result.value).toContain('Usage')
    }
    expect(getGlobalConfig().flickerFreeMode).toBeUndefined()
  })
})
