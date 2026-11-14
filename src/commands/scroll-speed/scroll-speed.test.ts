import { afterEach, describe, expect, test } from 'bun:test'
import { readScrollSpeedBase } from '../../components/ScrollKeybindingHandler.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { call } from './scroll-speed.js'

const noopContext = {} as Parameters<typeof call>[1]

function resetConfig(): void {
  saveGlobalConfig(current => ({ ...current, scrollSpeed: undefined }))
}

describe('/scroll-speed', () => {
  afterEach(() => {
    resetConfig()
    delete process.env.CLAUDE_CODE_SCROLL_SPEED
  })

  test('reports the current speed and usage with no argument', async () => {
    const result = await call('', noopContext)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('Current scroll speed')
      expect(result.value).toContain('/scroll-speed <1-20>')
    }
  })

  test('persists a valid speed', async () => {
    const result = await call('3', noopContext)
    expect(getGlobalConfig().scrollSpeed).toBe(3)
    if (result.type === 'text') {
      expect(result.value).toContain('3')
    }
  })

  test('rejects invalid input without writing', async () => {
    for (const bad of ['abc', '0', '-2', '21']) {
      const result = await call(bad, noopContext)
      if (result.type === 'text') {
        expect(result.value).toContain('Usage')
      }
    }
    expect(getGlobalConfig().scrollSpeed).toBeUndefined()
  })
})

describe('readScrollSpeedBase', () => {
  afterEach(() => {
    resetConfig()
    delete process.env.CLAUDE_CODE_SCROLL_SPEED
  })

  test('defaults to 1 with nothing configured', () => {
    expect(readScrollSpeedBase()).toBe(1)
  })

  test('reads the persisted scrollSpeed', () => {
    saveGlobalConfig(current => ({ ...current, scrollSpeed: 5 }))
    expect(readScrollSpeedBase()).toBe(5)
  })

  test('the env var wins over the persisted value', () => {
    saveGlobalConfig(current => ({ ...current, scrollSpeed: 5 }))
    process.env.CLAUDE_CODE_SCROLL_SPEED = '2'
    expect(readScrollSpeedBase()).toBe(2)
  })

  test('falls back to 1 on a garbage env value', () => {
    process.env.CLAUDE_CODE_SCROLL_SPEED = 'fast'
    expect(readScrollSpeedBase()).toBe(1)
  })
})
