import { detectLocale } from './locale.js'
import { en } from './languages/en.js'
import { vi } from './languages/vi.js'
import zhHK from './languages/zh-HK.js'
import type {
  I18nDictionary,
  InterpolationValues,
  LocalizationKey,
} from './types.js'

const dictionaries: Record<string, I18nDictionary> = {
  en,
  vi,
  'zh-HK': zhHK,
}

export { detectLocale }
export { getOpenClaudeCommandDescriptionKey } from './commandDescriptions.js'
export type { InterpolationValues, Locale, LocalizationKey } from './types.js'

export function localize(
  key: LocalizationKey | undefined,
  fallback: string,
  values?: InterpolationValues,
): string {
  if (!key) return fallback

  const locale = detectLocale()
  const template = dictionaries[locale]?.[key] ?? en[key] ?? fallback
  return interpolate(template, values)
}

function interpolate(
  template: string,
  values: InterpolationValues | undefined,
): string {
  if (!values) return template
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key)
      ? String(values[key])
      : match,
  )
}
