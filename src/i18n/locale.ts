import { getInitialSettings } from '../utils/settings/settings.js'
import { getSessionSettingsCache } from '../utils/settings/settingsCache.js'
import type { Locale } from './types.js'

const LANGUAGE_MAP: Map<string, Locale> = new Map([
  ['english', 'en'],
  ['en', 'en'],
  ['vietnamese', 'vi'],
  ['vi', 'vi'],
  ['zh-hk', 'zh-HK'],
  ['zh_hk', 'zh-HK'],
  ['traditional chinese', 'zh-HK'],
  ['chinese (hong kong)', 'zh-HK'],
])

function localeFromEnv(): Locale | undefined {
  const raw = (
    process.env.LC_ALL ||
    process.env.LC_MESSAGES ||
    process.env.LANG ||
    ''
  ).toLowerCase()

  if (!raw) return undefined

  const [langRegion] = raw.split('.')
  const [lang, region] = langRegion.split(/[-_]/)

  if (lang === 'zh' && region === 'hk') return 'zh-HK'
  if (lang === 'vi') return 'vi'
  if (lang === 'en') return 'en'

  return undefined
}

export function detectLocale(): Locale {
  const settings = getSessionSettingsCache()?.settings ?? getInitialSettings()
  const lang = settings.language

  if (typeof lang === 'string') {
    const mapped = LANGUAGE_MAP.get(lang.toLowerCase())
    if (mapped) return mapped
  }

  return localeFromEnv() ?? 'en'
}
