import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { formatDescriptionWithSource } from './commands.js'
import onboardGithub from './commands/onboard-github/index.js'
import usage from './commands/usage/index.js'
import { getOpenClaudeCommandDescriptionKey } from './i18n/index.js'
import { detectLocale } from './i18n/locale.js'
import { snapshotEnv } from './test/envSnapshot.js'
import {
  resetSettingsCache,
  setSessionSettingsCache,
} from './utils/settings/settingsCache.js'

let restoreEnv: () => void

beforeEach(() => {
  restoreEnv = snapshotEnv(['LC_ALL', 'LC_MESSAGES', 'LANG'], { clear: true })
})

afterEach(() => {
  resetSettingsCache()
  restoreEnv()
})

// ---------------------------------------------------------------------------
// Settings-based detection
// ---------------------------------------------------------------------------

describe('detectLocale – settings', () => {
  test('returns zh-HK when settings.language is "zh-HK"', () => {
    setSessionSettingsCache({
      settings: { language: 'zh-HK' },
      errors: [],
    })
    expect(detectLocale()).toBe('zh-HK')
  })

  test('returns zh-HK for case-insensitive "zh-hk"', () => {
    setSessionSettingsCache({
      settings: { language: 'zh-hk' },
      errors: [],
    })
    expect(detectLocale()).toBe('zh-HK')
  })

  test('returns en for "en"', () => {
    setSessionSettingsCache({
      settings: { language: 'en' },
      errors: [],
    })
    expect(detectLocale()).toBe('en')
  })

  test('returns vi for "vi"', () => {
    setSessionSettingsCache({
      settings: { language: 'vi' },
      errors: [],
    })
    expect(detectLocale()).toBe('vi')
  })

  test('does NOT match zh_CN to zh-HK', () => {
    setSessionSettingsCache({
      settings: { language: 'zh_CN' },
      errors: [],
    })
    // zh_CN is not in the language map → falls through to env, then 'en'
    expect(detectLocale()).toBe('en')
  })

  test('does NOT match en_HK to zh-HK', () => {
    setSessionSettingsCache({
      settings: { language: 'en_HK' },
      errors: [],
    })
    expect(detectLocale()).toBe('en')
  })
})

// ---------------------------------------------------------------------------
// Environment-based detection (no settings cache)
// ---------------------------------------------------------------------------

describe('detectLocale – environment variables', () => {
  /** Clear settings cache and all locale env vars so env path is exercised. */
  function clearAll() {
    resetSettingsCache()
    setSessionSettingsCache({ settings: {}, errors: [] })
    delete process.env.LC_ALL
    delete process.env.LC_MESSAGES
    delete process.env.LANG
  }

  test('LC_ALL=zh_HK.UTF-8 → zh-HK', () => {
    clearAll()
    process.env.LC_ALL = 'zh_HK.UTF-8'
    expect(detectLocale()).toBe('zh-HK')
  })

  test('LC_MESSAGES=vi_VN.UTF-8 → vi', () => {
    clearAll()
    process.env.LC_MESSAGES = 'vi_VN.UTF-8'
    expect(detectLocale()).toBe('vi')
  })

  test('LANG=en_US.UTF-8 → en', () => {
    clearAll()
    process.env.LANG = 'en_US.UTF-8'
    expect(detectLocale()).toBe('en')
  })

  test('LC_ALL=zh_CN.UTF-8 does NOT match zh-HK', () => {
    clearAll()
    process.env.LC_ALL = 'zh_CN.UTF-8'
    expect(detectLocale()).toBe('en')
  })

  test('LANG=en_HK.UTF-8 does NOT match zh-HK', () => {
    clearAll()
    process.env.LANG = 'en_HK.UTF-8'
    expect(detectLocale()).toBe('en')
  })

  test.each([
    ['en_US.UTF-8', 'zh_HK.UTF-8', 'vi_VN.UTF-8', 'en'],
    ['', 'zh_HK.UTF-8', 'vi_VN.UTF-8', 'zh-HK'],
    ['', '', 'vi_VN.UTF-8', 'vi'],
    ['C', 'zh_HK.UTF-8', 'vi_VN.UTF-8', 'en'],
  ] as const)('prioritizes LC_ALL=%s, LC_MESSAGES=%s, LANG=%s → %s',
    (lcAll, lcMessages, lang, expected) => {
      clearAll()
      process.env.LC_ALL = lcAll
      process.env.LC_MESSAGES = lcMessages
      process.env.LANG = lang
      expect(detectLocale()).toBe(expected)
    },
  )

  test('a supported settings language overrides all locale variables', () => {
    setSessionSettingsCache({ settings: { language: 'en' }, errors: [] })
    process.env.LC_ALL = 'zh_HK.UTF-8'
    process.env.LC_MESSAGES = 'vi_VN.UTF-8'
    process.env.LANG = 'zh_HK.UTF-8'
    expect(detectLocale()).toBe('en')
  })

  test.each([
    ['zh_HK@traditional', 'zh-HK'],
    ['zh_HK.UTF-8@traditional', 'zh-HK'],
    ['zh_CN@traditional', 'en'],
    ['en_HK@traditional', 'en'],
  ] as const)('LANG=%s → %s', (lang, expected) => {
    clearAll()
    process.env.LANG = lang
    expect(detectLocale()).toBe(expected)
  })

  test('falls back to en when no env vars are set', () => {
    clearAll()
    expect(detectLocale()).toBe('en')
  })
})

// ---------------------------------------------------------------------------
// Command-description consumer resolution
// ---------------------------------------------------------------------------

describe('zh-HK command descriptions', () => {
  test.each([
    [usage.name, usage, '顯示計劃用量上限'],
    [onboardGithub.name, onboardGithub, '設定 GitHub Copilot 認證資訊'],
  ] as const)('preserves the purpose of /%s', (_name, command, expected) => {
    setSessionSettingsCache({ settings: { language: 'zh-HK' }, errors: [] })
    const localizationKey = getOpenClaudeCommandDescriptionKey(command.name)
    expect(localizationKey).toBeDefined()

    const localizedCommand = { ...command, localizationKey }
    expect(formatDescriptionWithSource(localizedCommand)).toBe(expected)

    // The same real command must retain its canonical description in English.
    setSessionSettingsCache({ settings: { language: 'en' }, errors: [] })
    expect(formatDescriptionWithSource(localizedCommand)).toBe(command.description)
  })
})
