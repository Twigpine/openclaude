import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { detectLocale } from './i18n/locale.js'
import {
  resetSettingsCache,
  setSessionSettingsCache,
} from './utils/settings/settingsCache.js'

const ORIGINAL_ENV: Record<string, string | undefined> = {}

/**
 * Snapshot the three POSIX locale variables before each test so they can be
 * restored afterwards, avoiding cross-test state leakage.
 */
beforeEach(() => {
  ORIGINAL_ENV.LC_ALL = process.env.LC_ALL
  ORIGINAL_ENV.LC_MESSAGES = process.env.LC_MESSAGES
  ORIGINAL_ENV.LANG = process.env.LANG

  // Clear after snapshotting so every test starts from a known-clean
  // environment, regardless of what the CI/host machine's locale is set
  // to. Without this, settings-based fallback tests (e.g. zh_CN, en_HK)
  // can flakily pass or fail depending on the runner's real LC_ALL/LANG.
  delete process.env.LC_ALL
  delete process.env.LC_MESSAGES
  delete process.env.LANG
})

afterEach(() => {
  resetSettingsCache()

  // Restore individual variables instead of reassigning the whole object.
  for (const key of ['LC_ALL', 'LC_MESSAGES', 'LANG'] as const) {
    if (ORIGINAL_ENV[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = ORIGINAL_ENV[key]
    }
  }
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

  test('falls back to en when no env vars are set', () => {
    clearAll()
    expect(detectLocale()).toBe('en')
  })
})

// ---------------------------------------------------------------------------
// /onboard-github key resolution
// ---------------------------------------------------------------------------

describe('/onboard-github localization', () => {
  test('resolves the zh-HK translation instead of falling back to English', async () => {
    const { localize } = await import('./i18n/index.js')
    setSessionSettingsCache({
      settings: { language: 'zh-HK' },
      errors: [],
    })

    const result = localize(
      'commands.onboard-github.description',
      'Set up GitHub Models authentication',
    )

    expect(result).not.toBe('Set up GitHub Models authentication')
    expect(result).toBe('設定 GitHub Models 認證資訊')
  })
})
