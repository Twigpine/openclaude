export type Locale = 'en' | 'vi' | 'zh-HK'

export type LocalizationKey = string

export type I18nDictionary = Record<LocalizationKey, string>

export type InterpolationValues = Record<string, string | number>
