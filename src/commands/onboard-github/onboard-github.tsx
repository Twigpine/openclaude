import * as React from 'react'
import { useCallback, useState } from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import { Spinner } from '../../components/Spinner.js'
import TextInput from '../../components/TextInput.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink.js'
import {
  exchangeForCopilotToken,
  openVerificationUri,
  pollAccessToken,
  requestDeviceCode,
} from '../../services/github/deviceFlow.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  hydrateGithubModelsTokenFromSecureStorage,
  readGithubModelsToken,
  saveGithubModelsToken,
} from '../../utils/githubModelsCredentials.js'
import { getDisplayPath } from '../../utils/file.js'
import {
  getSettingsFilePathForSource,
  getSettingsForSource,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'

const DEFAULT_MODEL = 'github:copilot'
const FORCE_RELOGIN_ARGS = new Set([
  'force',
  '--force',
  'relogin',
  '--relogin',
  'reauth',
  '--reauth',
])

type Step = 'menu' | 'ghe-url' | 'copilot-key' | 'device-busy' | 'error'

const PROVIDER_SPECIFIC_KEYS = new Set([
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GEMINI_VERTEX',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_API_KEYS',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'GITHUB_COPILOT_KEY',
  'GITHUB_ENTERPRISE_URL',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_BASE_URL',
  'GEMINI_MODEL',
  'GEMINI_ACCESS_TOKEN',
  'GEMINI_AUTH_MODE',
])

function getUserSettingsDisplayPath(): string {
  const userSettingsPath = getSettingsFilePathForSource('userSettings')
  return userSettingsPath ? getDisplayPath(userSettingsPath) : 'user settings'
}

export function shouldForceGithubRelogin(args?: string): boolean {
  const normalized = (args ?? '').trim().toLowerCase()
  if (!normalized) {
    return false
  }
  return normalized.split(/\s+/).some(arg => FORCE_RELOGIN_ARGS.has(arg))
}

const GITHUB_PAT_PREFIXES = ['ghp_', 'gho_','ghs_', 'ghr_', 'github_pat_']

function isGithubPat(token: string): boolean {
  return GITHUB_PAT_PREFIXES.some(prefix => token.startsWith(prefix))
}

export function hasExistingGithubModelsLoginToken(
  env: NodeJS.ProcessEnv = process.env,
  storedToken?: string,
): boolean {
  const envToken = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim()
  if (envToken) {
    // PATs are no longer supported - require OAuth re-auth
    if (isGithubPat(envToken)) {
      return false
    }
    return true
  }
  const persisted = (storedToken ?? readGithubModelsToken())?.trim()
  // PATs are no longer supported - require OAuth re-auth
  if (persisted && isGithubPat(persisted)) {
    return false
  }
  return Boolean(persisted)
}

export function buildGithubOnboardingSettingsEnv(
  model: string,
  gheUrl?: string,
): Record<string, string | undefined> {
  return {
    CLAUDE_CODE_USE_GITHUB: '1',
    OPENAI_MODEL: model,
    GITHUB_ENTERPRISE_URL: gheUrl,
    OPENAI_API_KEYS: undefined,
    OPENAI_API_KEY: undefined,
    OPENAI_ORG: undefined,
    OPENAI_PROJECT: undefined,
    OPENAI_ORGANIZATION: undefined,
    OPENAI_BASE_URL: undefined,
    OPENAI_API_BASE: undefined,
    CLAUDE_CODE_USE_OPENAI: undefined,
    CLAUDE_CODE_USE_GEMINI: undefined,
    CLAUDE_CODE_USE_GEMINI_VERTEX: undefined,
    CLAUDE_CODE_USE_BEDROCK: undefined,
    CLAUDE_CODE_USE_VERTEX: undefined,
    CLAUDE_CODE_USE_FOUNDRY: undefined,
  }
}

export function applyGithubOnboardingProcessEnv(
  model: string,
  gheUrl?: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  env.CLAUDE_CODE_USE_GITHUB = '1'
  env.OPENAI_MODEL = model
  if (gheUrl) {
    env.GITHUB_ENTERPRISE_URL = gheUrl
  } else {
    delete env.GITHUB_ENTERPRISE_URL
  }

  delete env.OPENAI_API_KEYS
  delete env.OPENAI_API_KEY
  delete env.OPENAI_ORG
  delete env.OPENAI_PROJECT
  delete env.OPENAI_ORGANIZATION
  delete env.OPENAI_BASE_URL
  delete env.OPENAI_API_BASE
  delete env.GITHUB_COPILOT_KEY

  delete env.CLAUDE_CODE_USE_OPENAI
  delete env.CLAUDE_CODE_USE_GEMINI
  delete env.CLAUDE_CODE_USE_GEMINI_VERTEX
  delete env.CLAUDE_CODE_USE_BEDROCK
  delete env.CLAUDE_CODE_USE_VERTEX
  delete env.CLAUDE_CODE_USE_FOUNDRY
  delete env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
  delete env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID
}

function mergeUserSettingsEnv(
  model: string,
  gheUrl?: string,
): { ok: boolean; detail?: string } {
  const currentSettings = getSettingsForSource('userSettings')
  const currentEnv = currentSettings?.env ?? {}

  const newEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(currentEnv)) {
    if (!PROVIDER_SPECIFIC_KEYS.has(key)) {
      newEnv[key] = value
    }
  }

  newEnv.CLAUDE_CODE_USE_GITHUB = '1'
  newEnv.OPENAI_MODEL = model
  if (gheUrl) {
    newEnv.GITHUB_ENTERPRISE_URL = gheUrl
  } else {
    delete newEnv.GITHUB_ENTERPRISE_URL
  }

  const { error } = updateSettingsForSource('userSettings', {
    env: newEnv,
  })
  if (error) {
    return { ok: false, detail: error.message }
  }
  return { ok: true }
}

function normalizeOptionalGithubEnterpriseUrl(
  value: unknown,
): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed.toLowerCase() === 'undefined') {
    return undefined
  }
  try {
    return normalizeGithubEnterpriseInputUrl(trimmed)
  } catch {
    return undefined
  }
}

export function getExistingGithubEnterpriseUrl(
  env: NodeJS.ProcessEnv = process.env,
  settingsEnv?: Record<string, unknown>,
): string | undefined {
  return (
    normalizeOptionalGithubEnterpriseUrl(env.GITHUB_ENTERPRISE_URL) ??
    normalizeOptionalGithubEnterpriseUrl(
      settingsEnv?.GITHUB_ENTERPRISE_URL ??
        getSettingsForSource('userSettings')?.env?.GITHUB_ENTERPRISE_URL,
    )
  )
}

export function activateGithubOnboardingMode(
  model: string = DEFAULT_MODEL,
  options?: {
    gheUrl?: string
    mergeSettingsEnv?: (
      model: string,
      gheUrl?: string,
    ) => { ok: boolean; detail?: string }
    applyProcessEnv?: (model: string, gheUrl?: string) => void
    hydrateToken?: () => void
    onChangeAPIKey?: () => void
  },
): { ok: boolean; detail?: string } {
  const normalizedModel = model.trim() || DEFAULT_MODEL
  const mergeSettingsEnv = options?.mergeSettingsEnv ?? mergeUserSettingsEnv
  const applyProcessEnv = options?.applyProcessEnv ?? applyGithubOnboardingProcessEnv
  const hydrateToken =
    options?.hydrateToken ?? hydrateGithubModelsTokenFromSecureStorage

  const merged = mergeSettingsEnv(normalizedModel, options?.gheUrl)
  if (!merged.ok) {
    return merged
  }

  applyProcessEnv(normalizedModel, options?.gheUrl)
  hydrateToken()
  options?.onChangeAPIKey?.()
  return { ok: true }
}

export function normalizeGithubEnterpriseInputUrl(value: string): string {
  const parsed = new URL(value.trim())
  if (!parsed.hostname) {
    throw new Error('Invalid URL: must include a hostname.')
  }
  return parsed.origin
}

function GheUrlInput(props: {
  onSubmit: (url: string) => void
  onCancel: () => void
}): React.ReactNode {
  const { onSubmit, onCancel } = props
  const [input, setInput] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const { columns } = useTerminalSize()

  const handleSubmit = useCallback((value: string = input) => {
    const trimmed = value.trim()
    if (!trimmed) {
      setError('URL cannot be empty.')
      return
    }
    // Validate URL format
    try {
      onSubmit(normalizeGithubEnterpriseInputUrl(trimmed))
    } catch {
      setError('Invalid URL format. Enter the full URL (e.g. https://github.mycompany.com)')
    }
  }, [input, onSubmit])

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>GitHub Enterprise URL</Text>
      <Text dimColor>
        Enter your GitHub Enterprise Server URL (e.g. https://github.mycompany.com)
      </Text>
      {error && <Text color="red">{error}</Text>}
      <Box>
        <Text>URL: </Text>
        <TextInput
          value={input}
          onChange={(value) => {
            setInput(value)
            setError(null)
          }}
          onSubmit={handleSubmit}
          onExit={onCancel}
          placeholder="https://github.mycompany.com"
          columns={Math.max(20, columns - 6)}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={setCursorOffset}
          focus
          showCursor
        />
      </Box>
    </Box>
  )
}

function CopilotKeyInput(props: {
  onSubmit: (key: string) => void
  onCancel: () => void
}): React.ReactNode {
  const { onSubmit, onCancel } = props
  const [input, setInput] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const { columns } = useTerminalSize()

  const handleSubmit = useCallback((value: string = input) => {
    const trimmed = value.trim()
    if (!trimmed) {
      setError('API key cannot be empty.')
      return
    }
    onSubmit(trimmed)
  }, [input, onSubmit])

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>GitHub Copilot API Key</Text>
      <Text dimColor>
        Enter your GitHub Copilot API key for direct authentication.
      </Text>
      {error && <Text color="red">{error}</Text>}
      <Box>
        <Text>Key: </Text>
        <TextInput
          value={input}
          onChange={(value) => {
            setInput(value)
            setError(null)
          }}
          onSubmit={handleSubmit}
          onExit={onCancel}
          placeholder="Copilot API key"
          mask="*"
          columns={Math.max(20, columns - 6)}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={setCursorOffset}
          focus
          showCursor
        />
      </Box>
    </Box>
  )
}

function OnboardGithub(props: {
  onDone: Parameters<LocalJSXCommandCall>[0]
  onChangeAPIKey: () => void
}): React.ReactNode {
  const { onDone, onChangeAPIKey } = props
  const [step, setStep] = useState<Step>('menu')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [gheUrl, setGheUrl] = useState<string | null>(null)
  const [deviceHint, setDeviceHint] = useState<{
    user_code: string
    verification_uri: string
  } | null>(null)

  const finalize = useCallback(
    async (
      token: string,
      model: string = DEFAULT_MODEL,
      oauthToken?: string,
    ) => {
      const saved = saveGithubModelsToken(token, oauthToken)
      if (!saved.success) {
        setErrorMsg(saved.warning ?? 'Could not save token to secure storage.')
        setStep('error')
        return
      }
      const activated = activateGithubOnboardingMode(model, {
        gheUrl: gheUrl ?? undefined,
        onChangeAPIKey,
      })
      if (!activated.ok) {
        setErrorMsg(
          `Token saved, but settings were not updated: ${activated.detail ?? 'unknown error'}. ` +
            `Add env CLAUDE_CODE_USE_GITHUB=1 and OPENAI_MODEL=${DEFAULT_MODEL} to ${getUserSettingsDisplayPath()} manually.`,
        )
        setStep('error')
        return
      }
      // Clear stale provider-specific env vars from the current session
      // so resolveProviderRequest() doesn't pick up a previous provider's
      // base URL or key after onboarding completes.
      for (const envKey of PROVIDER_SPECIFIC_KEYS) {
        delete process.env[envKey]
      }
      process.env.CLAUDE_CODE_USE_GITHUB = '1'
      process.env.OPENAI_MODEL = model.trim() || DEFAULT_MODEL
      // Set GITHUB_ENTERPRISE_URL if provided
      if (gheUrl) {
        process.env.GITHUB_ENTERPRISE_URL = gheUrl
      }
      hydrateGithubModelsTokenFromSecureStorage()
      onChangeAPIKey()
      const successMsg = gheUrl
        ? `GitHub Copilot Enterprise onboard complete for ${gheUrl}. `
        : 'GitHub Copilot onboard complete. '
      onDone(
        successMsg +
          'Copilot token and OAuth token stored in secure storage (Windows/Linux: ~/.openclaude/.credentials.json, macOS: Keychain fallback to ~/.openclaude/.credentials.json); user settings updated. Restart if the model does not switch.',
        { display: 'user' },
      )
    },
    [gheUrl, onChangeAPIKey, onDone],
  )

  const runDeviceFlow = useCallback(async () => {
    setStep('device-busy')
    setErrorMsg(null)
    setDeviceHint(null)
    try {
      const device = await requestDeviceCode({ gheUrl: gheUrl ?? undefined })
      setDeviceHint({
        user_code: device.user_code,
        verification_uri: device.verification_uri,
      })
      await openVerificationUri(device.verification_uri)
      const oauthToken = await pollAccessToken(device.device_code, {
        initialInterval: device.interval,
        timeoutSeconds: device.expires_in,
        gheUrl: gheUrl ?? undefined,
      })
      const copilotToken = await exchangeForCopilotToken(
        oauthToken,
        undefined,
        gheUrl ?? undefined,
      )
      await finalize(copilotToken.token, DEFAULT_MODEL, oauthToken)
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
      setStep('error')
    }
  }, [finalize, gheUrl])

  const handleCopilotKeySubmit = useCallback(
    async (key: string) => {
      const trimmed = key.trim()
      if (!trimmed) {
        setErrorMsg('Copilot key cannot be empty.')
        setStep('error')
        return
      }
      // Store the Copilot key directly
      const saved = saveGithubModelsToken(trimmed, undefined, {
        credentialType: 'copilot_key',
      })
      if (!saved.success) {
        setErrorMsg(saved.warning ?? 'Could not save key to secure storage.')
        setStep('error')
        return
      }
      const activated = activateGithubOnboardingMode(DEFAULT_MODEL, {
        gheUrl: gheUrl ?? undefined,
        onChangeAPIKey,
      })
      if (!activated.ok) {
        setErrorMsg(
          `Key saved, but settings were not updated: ${activated.detail ?? 'unknown error'}. ` +
            `Add env CLAUDE_CODE_USE_GITHUB=1 and OPENAI_MODEL to ~/.openclaude/settings.json manually.`,
        )
        setStep('error')
        return
      }
      for (const key of PROVIDER_SPECIFIC_KEYS) {
        delete process.env[key]
      }
      process.env.CLAUDE_CODE_USE_GITHUB = '1'
      process.env.OPENAI_MODEL = DEFAULT_MODEL
      process.env.GITHUB_COPILOT_KEY = trimmed
      if (gheUrl) {
        process.env.GITHUB_ENTERPRISE_URL = gheUrl
      }
      hydrateGithubModelsTokenFromSecureStorage()
      onChangeAPIKey()
      const successMsg = gheUrl
        ? `GitHub Copilot Enterprise onboard complete for ${gheUrl}. `
        : 'GitHub Copilot onboard complete. '
      onDone(
        successMsg + 'Copilot key stored in secure storage; user settings updated.',
        { display: 'user' },
      )
    },
    [gheUrl, onChangeAPIKey, onDone],
  )

  if (step === 'error' && errorMsg) {
    const options = [
      {
        label: 'Back to menu',
        value: 'back' as const,
      },
      {
        label: 'Exit',
        value: 'exit' as const,
      },
    ]
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="red">{errorMsg}</Text>
        <Select
          options={options}
          onChange={(v: string) => {
            if (v === 'back') {
              setStep('menu')
              setErrorMsg(null)
            } else {
              onDone('GitHub onboard cancelled', { display: 'system' })
            }
          }}
        />
      </Box>
    )
  }

  if (step === 'device-busy') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text>GitHub Copilot{gheUrl ? ' Enterprise' : ''} sign-in</Text>
        {deviceHint ? (
          <>
            <Text>
              Enter code <Text bold>{deviceHint.user_code}</Text> at{' '}
              {deviceHint.verification_uri}
            </Text>
            <Text dimColor>
              A browser window may have opened. Waiting for authorization...
            </Text>
          </>
        ) : (
          <Text dimColor>Requesting device code from GitHub...</Text>
        )}
        <Spinner />
      </Box>
    )
  }

  if (step === 'ghe-url') {
    return (
      <GheUrlInput
        onSubmit={(url) => {
          setGheUrl(url)
          setStep('menu')
        }}
        onCancel={() => setStep('menu')}
      />
    )
  }

  if (step === 'copilot-key') {
    return (
      <CopilotKeyInput
        onSubmit={handleCopilotKeySubmit}
        onCancel={() => setStep('menu')}
      />
    )
  }

  const menuOptions = [
    {
      label: 'Sign in with browser',
      value: 'device' as const,
    },
    ...(gheUrl
      ? [
          {
            label: 'Use Copilot API key instead',
            value: 'copilot-key' as const,
          },
        ]
      : []),
    {
      label: gheUrl ? 'Change Enterprise URL' : 'Use GitHub Enterprise',
      value: 'ghe-url' as const,
    },
    {
      label: 'Cancel',
      value: 'cancel' as const,
    },
  ]

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>GitHub Copilot{gheUrl ? ' Enterprise' : ''} setup</Text>
      {gheUrl && (
        <Text dimColor>
          Enterprise URL: {gheUrl}
        </Text>
      )}
      <Text dimColor>
        Stores your token in the OS credential store (macOS Keychain when available)
        and enables CLAUDE_CODE_USE_GITHUB in your user settings - no export
        GITHUB_TOKEN needed for future runs.
      </Text>
      <Select
        options={menuOptions}
        onChange={(v: string) => {
          if (v === 'cancel') {
            onDone('GitHub onboard cancelled', { display: 'system' })
            return
          }
          if (v === 'ghe-url') {
            setStep('ghe-url')
            return
          }
          if (v === 'copilot-key') {
            setStep('copilot-key')
            return
          }
          void runDeviceFlow()
        }}
      />
    </Box>
  )
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const forceRelogin = shouldForceGithubRelogin(args)
  if (hasExistingGithubModelsLoginToken() && !forceRelogin) {
    const existingGheUrl = getExistingGithubEnterpriseUrl()
    const activated = activateGithubOnboardingMode(DEFAULT_MODEL, {
      gheUrl: existingGheUrl,
      onChangeAPIKey: context.onChangeAPIKey,
    })
    if (!activated.ok) {
      onDone(
        `GitHub token detected, but settings activation failed: ${activated.detail ?? 'unknown error'}. ` +
          `Set CLAUDE_CODE_USE_GITHUB=1 and OPENAI_MODEL=github:copilot in ${getUserSettingsDisplayPath()} manually.`,
        { display: 'system' },
      )
      return null
    }

    onDone(
      existingGheUrl
        ? `GitHub Copilot Enterprise already authorized for ${existingGheUrl}. Activated GitHub mode using your existing token. Use /onboard-github --force to re-authenticate.`
        : 'GitHub Models already authorized. Activated GitHub Models mode using your existing token. Use /onboard-github --force to re-authenticate.',
      { display: 'user' },
    )
    return null
  }

  return (
    <OnboardGithub
      onDone={onDone}
      onChangeAPIKey={context.onChangeAPIKey}
    />
  )
}
