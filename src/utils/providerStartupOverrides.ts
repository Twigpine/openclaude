import { saveGlobalConfig, type GlobalConfig } from './config.js'
import { updateSettingsForSource } from './settings/settings.js'

export const STARTUP_PROVIDER_OVERRIDE_ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_MODEL',
  'OPENAI_API_KEYS',
  'OPENAI_API_KEY',
  'LLMTR_API_KEY',
  'CMD_API_KEY',
  'COMMANDCODE_API_KEY',
  'COMMAND_CODE_API_KEY',
  'OPENAI_ORG',
  'OPENAI_PROJECT',
  'OPENAI_ORGANIZATION',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_BASE_URL',
  'GEMINI_MODEL',
  'GEMINI_ACCESS_TOKEN',
  'GEMINI_AUTH_MODE',
  'MISTRAL_BASE_URL',
  'MISTRAL_MODEL',
  'MISTRAL_API_KEY',
  'CODEX_API_KEY',
  'CODEX_CREDENTIAL_SOURCE',
  'CHATGPT_ACCOUNT_ID',
  'CODEX_ACCOUNT_ID',
  'MINIMAX_API_KEY',
  'MINIMAX_BASE_URL',
  'MINIMAX_MODEL',
  'NVIDIA_API_KEY',
  'NVIDIA_NIM',
  'VENICE_API_KEY',
  'LONGCAT_API_KEY',
] as const

type GlobalConfigWithEnv = {
  env?: Record<string, string>
}

type SettingsEnvPatch = Partial<
  Record<(typeof STARTUP_PROVIDER_OVERRIDE_ENV_KEYS)[number], string>
>

const DELETE_SETTINGS_ENV_VALUE = undefined as unknown as string

export function clearStartupProviderOverrides(options?: {
  updateUserSettings?: typeof updateSettingsForSource
  saveConfig?: (
    updater: (current: GlobalConfigWithEnv) => GlobalConfigWithEnv,
  ) => unknown
}): string | null {
  const updateUserSettings = options?.updateUserSettings ?? updateSettingsForSource
  const saveConfig =
    options?.saveConfig ??
    ((updater: (current: GlobalConfigWithEnv) => GlobalConfigWithEnv) =>
      saveGlobalConfig(
        updater as unknown as (currentConfig: GlobalConfig) => GlobalConfig,
      ))
  const envPatch = Object.fromEntries(
    STARTUP_PROVIDER_OVERRIDE_ENV_KEYS.map(key => [
      key,
      DELETE_SETTINGS_ENV_VALUE,
    ]),
  ) as SettingsEnvPatch

  const { error } = updateUserSettings('userSettings', { env: envPatch })

  let globalConfigError: string | null = null
  try {
    saveConfig((current: GlobalConfigWithEnv) => {
      const currentEnv = current.env ?? {}
      let changed = false
      const nextEnv = { ...currentEnv }
      for (const key of STARTUP_PROVIDER_OVERRIDE_ENV_KEYS) {
        if (key in nextEnv) {
          delete nextEnv[key]
          changed = true
        }
      }
      return changed ? { ...current, env: nextEnv } : current
    })
  } catch (configError) {
    globalConfigError =
      configError instanceof Error ? configError.message : String(configError)
  }

  return error?.message ?? globalConfigError
}
