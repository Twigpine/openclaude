import { afterEach, describe, expect, test } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'
import { expandTilde } from './pathValidation.js'

describe('expandTilde', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  test('expands ~/ using path.join so home and .openclaude stay separate', () => {
    const expanded = expandTilde('~/.openclaude/plugins')
    expect(expanded).toBe(join(homedir(), '.openclaude', 'plugins'))
    expect(expanded).not.toMatch(/[^/\\]\.openclaude/)
  })

  test('expands a bare tilde to the home directory', () => {
    expect(expandTilde('~')).toBe(homedir())
  })

  test('leaves non-tilde paths unchanged', () => {
    expect(expandTilde('C:\\Users\\GarryLai\\.openclaude\\plugins')).toBe(
      'C:\\Users\\GarryLai\\.openclaude\\plugins',
    )
    expect(expandTilde('/tmp/plugins')).toBe('/tmp/plugins')
  })

  test('expands ~\\ on win32 rather than leaving the tilde literal', () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    })
    const expanded = expandTilde('~\\.openclaude\\plugins')
    expect(expanded.startsWith(homedir())).toBe(true)
    expect(expanded).not.toBe('~\\.openclaude\\plugins')
    expect(expanded.includes('.openclaude')).toBe(true)
    expect(expanded).not.toMatch(/[^/\\]\.openclaude/)
  })
})
