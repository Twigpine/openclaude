import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_GLOBAL_CONFIG,
  GLOBAL_CONFIG_KEYS,
  isGlobalConfigKey,
} from './config.js'

describe('GlobalConfig focusView registration', () => {
  test('is listed in GLOBAL_CONFIG_KEYS', () => {
    expect(GLOBAL_CONFIG_KEYS).toContain('focusView')
    expect(isGlobalConfigKey('focusView')).toBe(true)
  })

  test('a fresh config reads focusView as off', () => {
    expect(DEFAULT_GLOBAL_CONFIG.focusView ?? false).toBe(false)
  })
})
