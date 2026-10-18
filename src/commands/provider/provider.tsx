import * as React from 'react'

import type { LocalJSXCommandCall, LocalJSXCommandOnDone } from '../../types/command.js'
import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from '../../constants/xml.js'
import {
  ProviderManager,
  type ProviderManagerResult,
} from '../../components/ProviderManager.js'
import TextInput from '../../components/TextInput.js'
import {
  Select,
  type OptionWithDescription,
} from '../../components/CustomSelect/index.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { LoadingState } from '../../components/design-system/LoadingState.js'
import { useCodexOAuthFlow } from '../../components/useCodexOAuthFlow.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink.js'
import { probeRouteReadiness } from '../../integrations/discoveryService.js'
import {
  getProviderPresetUiMetadata,
  getRouteLabel,
  resolveRouteIdFromBaseUrl,
} from '../../integrations/index.js'
import {
  type CodexOAuthTokens,
} from '../../services/api/codexOAuth.js'
import {
  DEFAULT_CODEX_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
  isLocalProviderUrl,
  resolveCodexApiCredentials,
  resolveProviderRequest,
} from '../../services/api/providerConfig.js'
import {
  applySavedProfileToCurrentSession as applySharedProfileToCurrentSession,
  buildCodexOAuthProfileEnv as buildSharedCodexOAuthProfileEnv,
  buildCodexProfileEnv,
  buildGeminiProfileEnv,
  buildMistralProfileEnv,
  buildOllamaProfileEnv,
  buildOpenAIProfileEnv,
  createProfileFile,
  DEFAULT_GEMINI_BASE_URL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_MISTRAL_BASE_URL,
  DEFAULT_MISTRAL_MODEL,
  deleteProfileFile,
  loadProfileFile,
  maskSecretForDisplay,
  redactSecretValueForDisplay,
  sanitizeApiKey,
  sanitizeOpenAICredentialPool,
  sanitizeProviderConfigValue,
  saveProfileFile,
  type ProfileEnv,
  type ProfileFile,
  type ProviderProfile,
} from '../../utils/providerProfile.js'
import {
  getGeminiProjectIdHint,
  mayHaveGeminiAdcCredentials,
} from '../../utils/geminiAuth.js'
import {
  readGeminiAccessToken,
  saveGeminiAccessToken,
} from '../../utils/geminiCredentials.js'
import { isBareMode } from '../../utils/envUtils.js'
import {
  getGoalDefaultOpenAIModel,
  normalizeRecommendationGoal,
  rankOllamaModels,
  recommendOllamaModel,
  type RecommendationGoal,
} from '../../utils/providerRecommendation.js'
import {
  getOllamaChatBaseUrl,
  getLocalOpenAICompatibleProviderLabel,
  type OllamaGenerationReadiness,
} from '../../utils/providerDiscovery.js'

export function buildProviderManagerCompletion(result?: ProviderManagerResult): {
  message: string
  metaMessages?: string[]
} {
  const message =
    result?.message ??
    (result?.action === 'saved'
      ? 'Provider profile updated'
      : 'Provider manager closed')
  const metaMessages =
    result?.action === 'activated' && result.activeProviderName
      ? [
          `<system-reminder>Provider switched mid-session to ${result.activeProviderName}${
            result.activeProviderModel
              ? ` using model ${result.activeProviderModel}`
              : ''
          }. Use this provider/model for subsequent requests unless the user switches again.</system-reminder>`,
        ]
      : undefined

  return { message, metaMessages }
}

function describeOllamaReadinessIssue(
  readiness: OllamaGenerationReadiness,
  options?: {
    baseUrl?: string
    allowManualFallback?: boolean
  },
): string {
  const endpoint = options?.baseUrl ?? 'http://localhost:11434'

  if (readiness.state === 'unreachable') {
    return `Could not reach Ollama at ${endpoint}. Start Ollama first, then run /provider again.`
  }

  if (readiness.state === 'no_models') {
    const manualSuffix = options?.allowManualFallback
      ? ', or enter details manually'
      : ''
    return `Ollama is running, but no installed models were found. Pull a chat model such as qwen2.5-coder:7b or llama3.1:8b first${manualSuffix}.`
  }

  if (readiness.state === 'generation_failed') {
    const modelHint = readiness.probeModel ?? 'the selected model'
    const detailSuffix = readiness.detail
      ? ` Details: ${readiness.detail}.`
      : ''
    const manualSuffix = options?.allowManualFallback
      ? ' You can also enter details manually.'
      : ''
    return `Ollama is reachable and models are installed, but a generation probe failed for ${modelHint}.${detailSuffix} Run "ollama run ${modelHint}" once and retry.${manualSuffix}`
  }

  return ''
}

type ProviderChoice = 'auto' | ProviderProfile | 'codex-oauth' | 'clear'

type Step =
  | { name: 'choose' }
  | { name: 'auto-goal' }
  | { name: 'auto-detect'; goal: RecommendationGoal }
  | { name: 'ollama-detect' }
  | { name: 'openai-key'; defaultModel: string }
  | { name: 'openai-base'; apiKey: string; defaultModel: string }
  | {
      name: 'openai-model'
      apiKey: string
      baseUrl: string | null
      defaultModel: string
    }
  | { name: 'mistral-key'; defaultModel: string }
  | { name: 'mistral-base'; apiKey: string; defaultModel: string }
  | {
      name: 'mistral-model'
      apiKey: string
      baseUrl: string | null
      defaultModel: string
    }
  | { name: 'gemini-auth-method' }
  | { name: 'gemini-key' }
  | { name: 'gemini-access-token' }
  | {
      name: 'gemini-model'
      apiKey?: string
      authMode: 'api-key' | 'access-token' | 'adc'
    }
  | { name: 'codex-oauth' }
  | { name: 'codex-check' }

type CurrentProviderSummary = {
  providerLabel: string
  modelLabel: string
  endpointLabel: string
  savedProfileLabel: string
}

type SavedProfileSummary = {
  providerLabel: string
  modelLabel: string
  endpointLabel: string
  credentialLabel?: string
}

type TextEntryDialogProps = {
  title: string
  subtitle?: string
  resetStateKey?: string
  description: React.ReactNode
  initialValue: string
  placeholder?: string
  mask?: string
  allowEmpty?: boolean
  validate?: (value: string) => string | null
  onSubmit: (value: string) => void
  onCancel: () => void
}

type ProviderWizardDefaults = {
  openAIModel: string
  openAIBaseUrl: string
  geminiModel: string
  mistralModel: string
  mistralBaseUrl: string
}

type SecretSourceEnv = NodeJS.ProcessEnv & Partial<ProfileEnv>

function isEnvTruthy(value: string | undefined): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'no'
}

function getSafeDisplayValue(
  value: string | undefined,
  processEnv: SecretSourceEnv,
  profileEnv?: ProfileEnv,
  fallback = '(not set)',
): string {
  return (
    redactSecretValueForDisplay(value, processEnv, profileEnv) ?? fallback
  )
}

function getConfiguredOpenAICompatibleProviderLabel(
  baseUrl: string,
  options?: {
    processEnv?: SecretSourceEnv
    model?: string
  },
): string {
  const routeId = resolveRouteIdFromBaseUrl(baseUrl)
  if (routeId) {
    return getRouteLabel(routeId) ?? 'OpenAI-compatible'
  }

  const request = resolveProviderRequest({
    model: options?.model,
    baseUrl,
  })

  if (request.transport === 'codex_responses') {
    return 'Codex'
  }

  if (isLocalProviderUrl(request.baseUrl)) {
    return getLocalOpenAICompatibleProviderLabel(request.baseUrl)
  }

  return 'OpenAI-compatible'
}

export function getProviderWizardDefaults(
  processEnv: NodeJS.ProcessEnv = process.env,
): ProviderWizardDefaults {
  const secretSource = processEnv as SecretSourceEnv
  const safeOpenAIModel =
    sanitizeProviderConfigValue(processEnv.OPENAI_MODEL, secretSource) ||
    'gpt-4o'
  const safeOpenAIBaseUrl =
    sanitizeProviderConfigValue(processEnv.OPENAI_BASE_URL, secretSource) ||
    DEFAULT_OPENAI_BASE_URL
  const safeGeminiModel =
    sanitizeProviderConfigValue(processEnv.GEMINI_MODEL, secretSource) ||
    DEFAULT_GEMINI_MODEL
  const safeMistralModel =
    sanitizeProviderConfigValue(processEnv.MISTRAL_MODEL, secretSource) ||
    DEFAULT_MISTRAL_MODEL
  const safeMistralBaseUrl =
    sanitizeProviderConfigValue(processEnv.MISTRAL_BASE_URL, secretSource) ||
    DEFAULT_MISTRAL_BASE_URL

  return {
    openAIModel: safeOpenAIModel,
    openAIBaseUrl: safeOpenAIBaseUrl,
    geminiModel: safeGeminiModel,
    mistralModel: safeMistralModel,
    mistralBaseUrl: safeMistralBaseUrl,
  }
}

export function buildCurrentProviderSummary(options?: {
  processEnv?: NodeJS.ProcessEnv
  persisted?: ProfileFile | null
}): CurrentProviderSummary {
  const processEnv = options?.processEnv ?? process.env
  const secretSource = processEnv as SecretSourceEnv
  const persisted = options?.persisted ?? loadProfileFile()
  const savedProfileLabel = persisted?.profile ?? 'none'

  if (isEnvTruthy(processEnv.CLAUDE_CODE_USE_GEMINI)) {
    const geminiMetadata = getProviderPresetUiMetadata('gemini', processEnv)
    return {
      providerLabel: geminiMetadata.label,
      modelLabel: getSafeDisplayValue(
        processEnv.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
        secretSource,
      ),
      endpointLabel: getSafeDisplayValue(
        processEnv.GEMINI_BASE_URL ?? DEFAULT_GEMINI_BASE_URL,
        secretSource,
      ),
      savedProfileLabel,
    }
  }

  if (isEnvTruthy(processEnv.CLAUDE_CODE_USE_MISTRAL)) {
    const mistralMetadata = getProviderPresetUiMetadata('mistral', processEnv)
    return {
      providerLabel: mistralMetadata.label,
      modelLabel: getSafeDisplayValue(
        processEnv.MISTRAL_MODEL ?? DEFAULT_MISTRAL_MODEL,
        processEnv
      ),
      endpointLabel: getSafeDisplayValue(
        processEnv.MISTRAL_BASE_URL ?? DEFAULT_MISTRAL_BASE_URL,
        processEnv
      ),
      savedProfileLabel,
    }
  }

  if (isEnvTruthy(processEnv.CLAUDE_CODE_USE_GITHUB)) {
    return {
      providerLabel: 'GitHub Models',
      modelLabel: getSafeDisplayValue(
        processEnv.OPENAI_MODEL ?? 'github:copilot',
        secretSource,
      ),
      endpointLabel: getSafeDisplayValue(
        processEnv.OPENAI_BASE_URL ??
          processEnv.OPENAI_API_BASE ??
          'https://models.github.ai/inference',
        secretSource,
      ),
      savedProfileLabel,
    }
  }

  if (isEnvTruthy(processEnv.CLAUDE_CODE_USE_OPENAI)) {
    const request = resolveProviderRequest({
      model: processEnv.OPENAI_MODEL,
      baseUrl: processEnv.OPENAI_BASE_URL,
    })

    return {
      providerLabel: getConfiguredOpenAICompatibleProviderLabel(
        request.baseUrl,
        {
          model: processEnv.OPENAI_MODEL,
          processEnv: secretSource,
        },
      ),
      modelLabel: getSafeDisplayValue(request.requestedModel, secretSource),
      endpointLabel: getSafeDisplayValue(request.baseUrl, secretSource),
      savedProfileLabel,
    }
  }

  return {
    providerLabel: 'Anthropic',
    modelLabel: getSafeDisplayValue(
      processEnv.ANTHROPIC_MODEL ??
        processEnv.CLAUDE_MODEL ??
        'claude-sonnet-4-6',
      secretSource,
    ),
    endpointLabel: getSafeDisplayValue(
      processEnv.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
      secretSource,
    ),
    savedProfileLabel,
  }
}

function buildSavedProfileSummary(
  profile: ProviderProfile,
  env: ProfileEnv,
): SavedProfileSummary {
  switch (profile) {
    case 'gemini':
      {
        const geminiMetadata = getProviderPresetUiMetadata('gemini')
      return {
        providerLabel: geminiMetadata.label,
        modelLabel: getSafeDisplayValue(
          env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
          process.env,
          env,
        ),
        endpointLabel: getSafeDisplayValue(
          env.GEMINI_BASE_URL ?? DEFAULT_GEMINI_BASE_URL,
          process.env,
          env,
        ),
        credentialLabel:
          env.GEMINI_AUTH_MODE === 'access-token'
            ? 'access token (stored securely)'
            : env.GEMINI_AUTH_MODE === 'adc'
              ? 'local ADC'
            : maskSecretForDisplay(env.GEMINI_API_KEY) !== undefined
              ? 'configured'
              : undefined,
      }
      }
    case 'mistral':
      {
        const mistralMetadata = getProviderPresetUiMetadata('mistral')
      return {
        providerLabel: mistralMetadata.label,
        modelLabel: getSafeDisplayValue(
          env.MISTRAL_MODEL ?? DEFAULT_MISTRAL_MODEL,
          process.env,
          env,
        ),
        endpointLabel: getSafeDisplayValue(
          env.MISTRAL_BASE_URL ?? DEFAULT_MISTRAL_BASE_URL,
          process.env,
          env,
        ),
        credentialLabel:
          maskSecretForDisplay(env.MISTRAL_API_KEY) !== undefined
            ? 'configured'
            : undefined,
      }
      }
    case 'codex':
      return {
        providerLabel: 'Codex',
        modelLabel: getSafeDisplayValue(
          env.OPENAI_MODEL ?? 'codexplan',
          process.env,
          env,
        ),
        endpointLabel: getSafeDisplayValue(
          env.OPENAI_BASE_URL ?? DEFAULT_CODEX_BASE_URL,
          process.env,
          env,
        ),
        credentialLabel:
          maskSecretForDisplay(env.CODEX_API_KEY) !== undefined
            ? 'configured'
            : undefined,
      }
    case 'ollama':
      return {
        providerLabel: 'Ollama',
        modelLabel: getSafeDisplayValue(
          env.OPENAI_MODEL,
          process.env,
          env,
        ),
        endpointLabel: getSafeDisplayValue(
          env.OPENAI_BASE_URL,
          process.env,
          env,
        ),
      }
    case 'openai':
    default: {
      const baseUrl = env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL

      return {
        providerLabel: getConfiguredOpenAICompatibleProviderLabel(baseUrl, {
          model: env.OPENAI_MODEL,
        }),
        modelLabel: getSafeDisplayValue(
          env.OPENAI_MODEL ?? 'gpt-4o',
          process.env,
          env,
        ),
        endpointLabel: getSafeDisplayValue(
          baseUrl,
          process.env,
          env,
        ),
        credentialLabel:
          maskSecretForDisplay(
            sanitizeOpenAICredentialPool(env.OPENAI_API_KEYS) ??
              sanitizeOpenAICredentialPool(env.OPENAI_API_KEY),
          ) !== undefined
            ? 'configured'
            : undefined,
      }
    }
  }
}

export function buildProfileSaveMessage(
  profile: ProviderProfile,
  env: ProfileEnv,
  filePath: string,
  options?: {
    activatedInSession?: boolean
    activationWarning?: string | null
  },
): string {
  const summary = buildSavedProfileSummary(profile, env)
  const lines = [
    `Saved ${summary.providerLabel} profile.`,
    `Model: ${summary.modelLabel}`,
    `Endpoint: ${summary.endpointLabel}`,
  ]

  if (summary.credentialLabel) {
    lines.push(`Credentials: ${summary.credentialLabel}`)
  }

  lines.push(`Profile: ${filePath}`)
  if (options?.activatedInSession) {
    lines.push('OpenClaude switched to it for this session.')
  } else if (options?.activationWarning) {
    lines.push(
      `Saved for next startup. Warning: could not activate it in this session (${options.activationWarning}).`,
    )
  } else {
    lines.push('Restart OpenClaude to use it.')
  }

  return lines.join('\n')
}

function buildUsageText(): string {
  const summary = buildCurrentProviderSummary()
  const availableProviders = isBareMode()
    ? 'Choose Auto, Ollama, OpenAI-compatible, Google AI / Gemini, or Codex, then save a provider profile.'
    : 'Choose Auto, Ollama, OpenAI-compatible, Google AI / Gemini, Codex, or Codex OAuth, then save a provider profile.'
  return [
    'Usage: /provider',
    '',
    'Guided setup for saved provider profiles.',
    '',
    `Current provider: ${summary.providerLabel}`,
    `Current model: ${summary.modelLabel}`,
    `Current endpoint: ${summary.endpointLabel}`,
    `Saved profile: ${summary.savedProfileLabel}`,
    '',
    availableProviders,
  ].join('\n')
}

function finishProfileSave(
  onDone: LocalJSXCommandOnDone,
  profile: ProviderProfile,
  env: ProfileEnv,
): void {
  void saveProfileAndNotify(onDone, profile, env)
}

export function buildCodexOAuthProfileEnv(
  tokens: Pick<CodexOAuthTokens, 'accessToken' | 'idToken' | 'accountId'>,
): ProfileEnv | null {
  return buildSharedCodexOAuthProfileEnv(tokens)
}

export async function applySavedProfileToCurrentSession(options: {
  profileFile: ProfileFile
  processEnv?: NodeJS.ProcessEnv
}): Promise<string | null> {
  return applySharedProfileToCurrentSession(options)
}

async function saveProfileAndNotify(
  onDone: LocalJSXCommandOnDone,
  profile: ProviderProfile,
  env: ProfileEnv,
): Promise<void> {
  try {
    const profileFile = createProfileFile(profile, env)
    const filePath = saveProfileFile(profileFile)
    const shouldActivateInSession = profile === 'codex'
    const activationWarning = shouldActivateInSession
      ? await applySharedProfileToCurrentSession({ profileFile })
      : null

    onDone(
      buildProfileSaveMessage(profile, env, filePath, {
        activatedInSession:
          shouldActivateInSession && activationWarning === null,
        activationWarning,
      }),
      {
        display: 'system',
      },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    onDone(`Failed to save provider profile: ${message}`, {
      display: 'system',
    })
  }
}

export function TextEntryDialog({
  title,
  subtitle,
  resetStateKey,
  description,
  initialValue,
  placeholder,
  mask,
  allowEmpty = false,
  validate,
  onSubmit,
  onCancel,
}: TextEntryDialogProps): React.ReactNode {
  const { columns } = useTerminalSize()
  const [value, setValue] = React.useState(initialValue)
  const [cursorOffset, setCursorOffset] = React.useState(initialValue.length)
  const [error, setError] = React.useState<string | null>(null)

  React.useLayoutEffect(() => {
    setValue(initialValue)
    setCursorOffset(initialValue.length)
    setError(null)
  }, [initialValue, resetStateKey])

  const inputColumns = Math.max(30, columns - 6)

  const handleSubmit = React.useCallback(
    (nextValue: string) => {
      if (!allowEmpty && nextValue.trim().length === 0) {
        setError('A value is required for this step.')
        return
      }

      const validationError = validate?.(nextValue)
      if (validationError) {
        setError(validationError)
        return
      }

      setError(null)
      onSubmit(nextValue)
    },
    [allowEmpty, onSubmit, validate],
  )

  return (
    <Dialog title={title} subtitle={subtitle} onCancel={onCancel}>
      <Box flexDirection="column" gap={1}>
        <Text>{description}</Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          placeholder={placeholder}
          mask={mask}
          columns={inputColumns}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={setCursorOffset}
          focus
          showCursor
        />
        {error ? <Text color="error">{error}</Text> : null}
      </Box>
    </Dialog>
  )
}

function ProviderChooser({
  onChoose,
  onCancel,
}: {
  onChoose: (value: ProviderChoice) => void
  onCancel: () => void
}): React.ReactNode {
  const summary = buildCurrentProviderSummary()
  const canUseCodexOAuth = !isBareMode()
  const ollamaMetadata = getProviderPresetUiMetadata('ollama')
  const openAIMetadata = getProviderPresetUiMetadata('openai')
  const geminiMetadata = getProviderPresetUiMetadata('gemini')
  const mistralMetadata = getProviderPresetUiMetadata('mistral')
  const helperText = canUseCodexOAuth
    ? 'Save a provider profile without editing environment variables first. Codex profiles backed by env, auth.json, or OpenClaude secure storage can switch this session immediately when validation succeeds.'
    : 'Save a provider profile without editing environment variables first. Codex profiles backed by env or auth.json can switch this session immediately.'
  const options: OptionWithDescription<ProviderChoice>[] = [
    {
      label: 'Auto',
      value: 'auto',
      description:
        'Prefer local Ollama when available, otherwise guide you into OpenAI-compatible setup',
    },
    {
      label: ollamaMetadata.label,
      value: 'ollama',
      description: ollamaMetadata.description,
    },
    {
      label: openAIMetadata.name,
      value: 'openai',
      description: 'OpenAI and similar OpenAI-compatible APIs',
    },
    {
      label: 'Google AI / Gemini',
      value: 'gemini',
      description:
        'Use a Gemini API key, access token, or local ADC',
    },
    {
      label: mistralMetadata.label,
      value: 'mistral',
      description: mistralMetadata.description,
    },
    {
      label: 'Codex',
      value: 'codex',
      description: 'Use existing ChatGPT Codex CLI auth or env credentials',
    },
    ...(canUseCodexOAuth
      ? [
          {
            label: 'Codex OAuth',
            value: 'codex-oauth' as const,
            description:
              'Sign in with ChatGPT in your browser and store Codex tokens securely',
          },
        ]
      : []),
  ]

  if (summary.savedProfileLabel !== 'none') {
    options.push({
      label: 'Clear saved profile',
      value: 'clear',
      description: 'Remove .openclaude-profile.json and return to normal startup',
    })
  }

  return (
    <Dialog
      title="Set up a provider profile"
      subtitle={`Current provider: ${summary.providerLabel}`}
      onCancel={onCancel}
    >
      <Box flexDirection="column" gap={1}>
        <Text>{helperText}</Text>
        <Box flexDirection="column">
          <Text dimColor>Current model: {summary.modelLabel}</Text>
          <Text dimColor>Current endpoint: {summary.endpointLabel}</Text>
          <Text dimColor>Saved profile: {summary.savedProfileLabel}</Text>
        </Box>
        <Select
          options={options}
          inlineDescriptions
          visibleOptionCount={options.length}
          onChange={onChoose}
          onCancel={onCancel}
        />
      </Box>
    </Dialog>
  )
}

function AutoGoalChooser({
  onChoose,
  onBack,
}: {
  onChoose: (goal: RecommendationGoal) => void
  onBack: () => void
}): React.ReactNode {
  const options: OptionWithDescription<RecommendationGoal>[] = [
    {
      label: 'Balanced',
      value: 'balanced',
      description: 'Strong everyday default for most users',
    },
    {
      label: 'Coding',
      value: 'coding',
      description: 'Prefer coding-oriented local models or GPT-4o defaults',
    },
    {
      label: 'Latency',
      value: 'latency',
      description: 'Prefer faster local models or gpt-4o-mini defaults',
    },
  ]

  return (
    <Dialog title="Auto setup goal" onCancel={onBack}>
      <Box flexDirection="column" gap={1}>
        <Text>Pick the goal Auto setup should optimize for.</Text>
        <Select
          options={options}
          defaultValue="balanced"
          defaultFocusValue="balanced"
          inlineDescriptions
          visibleOptionCount={options.length}
          onChange={onChoose}
          onCancel={onBack}
        />
      </Box>
    </Dialog>
  )
}

function AutoRecommendationStep({
  goal,
  onBack,
  onSave,
  onNeedOpenAI,
  onCancel,
}: {
  goal: RecommendationGoal
  onBack: () => void
  onSave: (profile: ProviderProfile, env: ProfileEnv) => void
  onNeedOpenAI: (defaultModel: string) => void
  onCancel: () => void
}): React.ReactNode {
  const [status, setStatus] = React.useState<
    | {
        state: 'loading'
      }
    | {
        state: 'ollama'
        model: string
        summary: string
      }
    | {
        state: 'openai'
        defaultModel: string
        reason: string
      }
    | {
        state: 'error'
        message: string
      }
  >({ state: 'loading' })

  React.useEffect(() => {
    let cancelled = false

    void (async () => {
      const defaultModel = getGoalDefaultOpenAIModel(goal)
      try {
        const readiness = await probeRouteReadiness('ollama')
        if (!readiness) {
          if (!cancelled) {
            setStatus({
              state: 'error',
              message: 'Ollama readiness probe is not configured for this route.',
            })
          }
          return
        }

        if (readiness.state !== 'ready') {
          if (!cancelled) {
            setStatus({
              state: 'openai',
              defaultModel,
              reason: describeOllamaReadinessIssue(readiness),
            })
          }
          return
        }

        const recommended = recommendOllamaModel(readiness.models, goal)
        if (!recommended) {
          if (!cancelled) {
            setStatus({
              state: 'openai',
              defaultModel,
              reason:
                'Ollama responded to a generation probe, but no recommended chat model matched this goal.',
            })
          }
          return
        }

        if (!cancelled) {
          setStatus({
            state: 'ollama',
            model: recommended.name,
            summary: recommended.summary,
          })
        }
      } catch (error) {
        if (!cancelled) {
          setStatus({
            state: 'error',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [goal])

  if (status.state === 'loading') {
    return <LoadingState message="Checking local providers…" />
  }

  if (status.state === 'error') {
    return (
      <Dialog title="Auto setup failed" onCancel={onCancel} color="warning">
        <Box flexDirection="column" gap={1}>
          <Text>{status.message}</Text>
          <Select
            options={[
              { label: 'Back', value: 'back' },
              { label: 'Cancel', value: 'cancel' },
            ]}
            onChange={(value: string) =>
              value === 'back' ? onBack() : onCancel()
            }
            onCancel={onCancel}
          />
        </Box>
      </Dialog>
    )
  }

  if (status.state === 'openai') {
    return (
      <Dialog title="Auto setup fallback" onCancel={onCancel}>
        <Box flexDirection="column" gap={1}>
          <Text>
            Auto setup can continue into OpenAI-compatible setup with a default model of{' '}
            {status.defaultModel}.
          </Text>
          <Text dimColor>{status.reason}</Text>
          <Select
            options={[
              { label: 'Continue to OpenAI-compatible setup', value: 'continue' },
              { label: 'Back', value: 'back' },
              { label: 'Cancel', value: 'cancel' },
            ]}
            onChange={(value: string) => {
              if (value === 'continue') {
                onNeedOpenAI(status.defaultModel)
              } else if (value === 'back') {
                onBack()
              } else {
                onCancel()
              }
            }}
            onCancel={onCancel}
          />
        </Box>
      </Dialog>
    )
  }

  return (
    <Dialog title="Save recommended profile?" onCancel={onBack}>
      <Box flexDirection="column" gap={1}>
        <Text>
          Auto setup recommends a local Ollama profile for {goal} based on the
          models currently available on this machine.
        </Text>
        <Text dimColor>
          Recommended model: {status.model}
          {status.summary ? ` · ${status.summary}` : ''}
        </Text>
        <Select
          options={[
            { label: 'Save recommended Ollama profile', value: 'save' },
            { label: 'Back', value: 'back' },
            { label: 'Cancel', value: 'cancel' },
          ]}
          onChange={(value: string) => {
            if (value === 'save') {
              onSave(
                'ollama',
                buildOllamaProfileEnv(status.model, {
                  getOllamaChatBaseUrl,
                }),
              )
            } else if (value === 'back') {
              onBack()
            } else {
              onCancel()
            }
          }}
          onCancel={onBack}
        />
      </Box>
    </Dialog>
  )
}

function OllamaModelStep({
  onSave,
  onBack,
  onCancel,
}: {
  onSave: (profile: ProviderProfile, env: ProfileEnv) => void
  onBack: () => void
  onCancel: () => void
}): React.ReactNode {
  const [status, setStatus] = React.useState<
    | { state: 'loading' }
    | {
        state: 'ready'
        options: OptionWithDescription<string>[]
        defaultValue?: string
      }
    | { state: 'unavailable'; message: string }
  >({ state: 'loading' })

  React.useEffect(() => {
    let cancelled = false

    void (async () => {
      const readiness = await probeRouteReadiness('ollama')
      if (!readiness) {
        if (!cancelled) {
          setStatus({
            state: 'unavailable',
            message: 'Ollama readiness probe is not configured for this route.',
          })
        }
        return
      }

      if (readiness.state !== 'ready') {
        if (!cancelled) {
          setStatus({
            state: 'unavailable',
            message: describeOllamaReadinessIssue(readiness),
          })
        }
        return
      }

      const ranked = rankOllamaModels(readiness.models, 'balanced')
      const recommended = recommendOllamaModel(readiness.models, 'balanced')
      if (!cancelled) {
        setStatus({
          state: 'ready',
          defaultValue: recommended?.name ?? ranked[0]?.name,
          options: ranked.map(model => ({
            label: model.name,
            value: model.name,
            description: model.summary,
          })),
        })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  if (status.state === 'loading') {
    return <LoadingState message="Checking local Ollama models…" />
  }

  if (status.state === 'unavailable') {
    return (
      <Dialog title="Ollama setup" onCancel={onCancel} color="warning">
        <Box flexDirection="column" gap={1}>
          <Text>{status.message}</Text>
          <Select
            options={[
              { label: 'Back', value: 'back' },
              { label: 'Cancel', value: 'cancel' },
            ]}
            onChange={(value: string) =>
              value === 'back' ? onBack() : onCancel()
            }
            onCancel={onCancel}
          />
        </Box>
      </Dialog>
    )
  }

  return (
    <Dialog title="Choose an Ollama model" onCancel={onBack}>
      <Box flexDirection="column" gap={1}>
        <Text>
          Pick one of the installed Ollama models to save into a local provider
          profile.
        </Text>
        <Select
          options={status.options}
          defaultValue={status.defaultValue}
          defaultFocusValue={status.defaultValue}
          inlineDescriptions
          visibleOptionCount={Math.min(8, status.options.length)}
          onChange={(value: string) => {
            onSave(
              'ollama',
              buildOllamaProfileEnv(value, {
                getOllamaChatBaseUrl,
              }),
            )
          }}
          onCancel={onBack}
        />
      </Box>
    </Dialog>
  )
}

function CodexOAuthStep({
  onSave,
  onBack,
  onCancel,
}: {
  onSave: (profile: ProviderProfile, env: ProfileEnv) => void
  onBack: () => void
  onCancel: () => void
}): React.ReactNode {
  const handleAuthenticated = React.useCallback(async (
    tokens: CodexOAuthTokens,
    persistCredentials: (options?: { profileId?: string }) => void,
  ) => {
    const env = buildCodexOAuthProfileEnv(tokens)
    if (!env) {
      throw new Error(
        'Codex OAuth succeeded, but OpenClaude could not build a Codex profile from the stored credentials.',
      )
    }

    persistCredentials()
    onSave('codex', env)
  }, [onSave])

  const status = useCodexOAuthFlow({
    onAuthenticated: handleAuthenticated,
  })

  if (status.state === 'error') {
    return (
      <Dialog title="Codex OAuth failed" onCancel={onCancel} color="warning">
        <Box flexDirection="column" gap={1}>
          <Text>{status.message}</Text>
          <Select
            options={[
              { label: 'Back', value: 'back' },
              { label: 'Cancel', value: 'cancel' },
            ]}
            onChange={(value: string) =>
              value === 'back' ? onBack() : onCancel()
            }
            onCancel={onCancel}
          />
        </Box>
      </Dialog>
    )
  }

  if (status.state === 'starting') {
    return <LoadingState message="Starting Codex OAuth..." />
  }

  return (
    <Dialog title="Codex OAuth" onCancel={onBack}>
      <Box flexDirection="column" gap={1}>
        <Text>
          Finish signing in with ChatGPT in your browser. OpenClaude will store
          the resulting Codex credentials securely for future sessions.
        </Text>
        {status.browserOpened === false ? (
          <Text color="warning">
            Browser did not open automatically. Visit this URL to continue:
          </Text>
        ) : status.browserOpened === true ? (
          <Text dimColor>
            Browser opened. Complete the sign-in there, then OpenClaude will
            finish setup automatically.
          </Text>
        ) : (
          <Text dimColor>Opening your browser...</Text>
        )}
        <Text>{status.authUrl}</Text>
        <Text dimColor>Press Esc to cancel and go back.</Text>
      </Box>
    </Dialog>
  )
}

export function CodexCredentialStep({
  onSave,
  onBack,
  onCancel,
}: {
  onSave: (profile: ProviderProfile, env: ProfileEnv) => void
  onBack: () => void
  onCancel: () => void
}): React.ReactNode {
  const credentials = resolveCodexCredentials(process.env)

  if (!credentials.ok) {
    return (
      <Dialog title="Codex setup" onCancel={onCancel} color="warning">
        <Box flexDirection="column" gap={1}>
          <Text>{credentials.message}</Text>
          <Select
            options={[
              { label: 'Back', value: 'back' },
              { label: 'Cancel', value: 'cancel' },
            ]}
            onChange={(value: string) =>
              value === 'back' ? onBack() : onCancel()
            }
            onCancel={onCancel}
          />
        </Box>
      </Dialog>
    )
  }

  const options: OptionWithDescription<string>[] = [
    {
      label: 'codexplan',
      value: 'codexplan',
      description: 'GPT-5.6 Sol with higher reasoning on the Codex backend',
    },
    {
      label: 'codexspark',
      value: 'codexspark',
      description: 'Faster Codex Spark tool loop profile',
    },
  ]

  return (
    <Dialog title="Choose a Codex profile" onCancel={onBack}>
      <Box flexDirection="column" gap={1}>
        <Text>
          Reuse your existing Codex credentials from{' '}
          {credentials.sourceDescription} and save a model alias profile.
        </Text>
        <Select
          options={options}
          defaultValue="codexplan"
          defaultFocusValue="codexplan"
          inlineDescriptions
          visibleOptionCount={options.length}
          onChange={(value: string) => {
            const env = buildCodexProfileEnv({
              model: value,
              credentialSource: credentials.credentialSource,
              processEnv: process.env,
            })
            if (env) {
              onSave('codex', env)
            }
          }}
          onCancel={onBack}
        />
      </Box>
    </Dialog>
  )
}

function resolveCodexCredentials(processEnv: NodeJS.ProcessEnv):
  | {
      ok: true
      sourceDescription: string
      credentialSource: 'oauth' | 'existing'
    }
  | { ok: false; message: string } {
  const credentials = resolveCodexApiCredentials(processEnv)
  const oauthHint = isBareMode()
    ? 'Re-login with the Codex CLI'
    : 'Choose Codex OAuth in /provider, or re-login with the Codex CLI'

  if (!credentials.apiKey) {
    const authHint = credentials.authPath
      ? `Expected auth file: ${credentials.authPath}.`
      : 'Set CODEX_API_KEY or re-login with the Codex CLI.'
    return {
      ok: false,
      message: `Codex setup needs existing credentials. ${oauthHint}, or set CODEX_API_KEY. ${authHint}`,
    }
  }

  if (!credentials.accountId) {
    return {
      ok: false,
      message:
        `Codex auth is missing chatgpt_account_id. ${oauthHint}, or set CHATGPT_ACCOUNT_ID/CODEX_ACCOUNT_ID first.`,
    }
  }

  return {
    ok: true,
    credentialSource:
      credentials.source === 'secure-storage' ? 'oauth' : 'existing',
    sourceDescription:
      credentials.source === 'env'
        ? 'the current shell environment'
        : credentials.source === 'secure-storage'
          ? 'OpenClaude secure storage'
        : credentials.authPath ?? DEFAULT_CODEX_BASE_URL,
  }
}

export function ProviderWizard({
  onDone,
}: {
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const defaults = getProviderWizardDefaults()
  const [step, setStep] = React.useState<Step>({ name: 'choose' })

  switch (step.name) {
    case 'choose':
      return (
        <ProviderChooser
          onChoose={value => {
            if (value === 'auto') {
              setStep({ name: 'auto-goal' })
            } else if (value === 'ollama') {
              setStep({ name: 'ollama-detect' })
            } else if (value === 'openai') {
              setStep({
                name: 'openai-key',
                defaultModel: defaults.openAIModel,
              })
            } else if (value === 'gemini') {
              setStep({ name: 'gemini-auth-method' })
            } else if (value === 'mistral') {
              setStep({
                name: 'mistral-key',
                defaultModel: defaults.mistralModel,
              })
            } else if (value === 'codex-oauth') {
              setStep({ name: 'codex-oauth' })
            } else if (value === 'clear') {
              const filePath = deleteProfileFile()
              onDone(`Removed saved provider profile at ${filePath}. Restart OpenClaude to go back to normal startup.`, {
                display: 'system',
              })
            } else {
              setStep({ name: 'codex-check' })
            }
          }}
          onCancel={() => onDone()}
        />
      )

    case 'auto-goal':
      return (
        <AutoGoalChooser
          onChoose={goal => setStep({ name: 'auto-detect', goal })}
          onBack={() => setStep({ name: 'choose' })}
        />
      )

    case 'auto-detect':
      return (
        <AutoRecommendationStep
          goal={step.goal}
          onBack={() => setStep({ name: 'auto-goal' })}
          onSave={(profile, env) => finishProfileSave(onDone, profile, env)}
          onNeedOpenAI={defaultModel =>
            setStep({ name: 'openai-key', defaultModel })
          }
          onCancel={() => onDone()}
        />
      )

    case 'ollama-detect':
      return (
        <OllamaModelStep
          onSave={(profile, env) => finishProfileSave(onDone, profile, env)}
          onBack={() => setStep({ name: 'choose' })}
          onCancel={() => onDone()}
        />
      )

    case 'openai-key':
      {
        const openAIMetadata = getProviderPresetUiMetadata('openai')
        const currentOpenAIApiKey = openAIMetadata.apiKey
      return (
        <TextEntryDialog
          resetStateKey={step.name}
          title={`${openAIMetadata.name} setup`}
          subtitle="Step 1 of 3"
          description={
            currentOpenAIApiKey
              ? 'Enter an API key, or leave this blank to reuse the current OpenAI credentials from this session.'
              : `Enter the API key for ${openAIMetadata.name}.`
          }
          initialValue=""
          placeholder="sk-..."
          mask="*"
          allowEmpty={Boolean(currentOpenAIApiKey)}
          validate={value => {
            const candidate = value.trim() || currentOpenAIApiKey
            return sanitizeOpenAICredentialPool(candidate)
              ? null
              : 'Enter a real API key. Placeholder values like SUA_CHAVE are not valid.'
          }}
          onSubmit={value => {
            const apiKey = value.trim() || currentOpenAIApiKey
            setStep({
              name: 'openai-base',
              apiKey,
              defaultModel: step.defaultModel,
            })
          }}
          onCancel={() => setStep({ name: 'choose' })}
        />
      )
      }

    case 'openai-base':
      {
        const openAIMetadata = getProviderPresetUiMetadata('openai')
      return (
        <TextEntryDialog
          resetStateKey={step.name}
          title={`${openAIMetadata.name} setup`}
          subtitle="Step 2 of 3"
          description={`Optionally enter a base URL. Leave blank for ${openAIMetadata.baseUrl || DEFAULT_OPENAI_BASE_URL}.`}
          initialValue={
            defaults.openAIBaseUrl === DEFAULT_OPENAI_BASE_URL
              ? ''
              : defaults.openAIBaseUrl
          }
          placeholder={DEFAULT_OPENAI_BASE_URL}
          allowEmpty
          onSubmit={value => {
            setStep({
              name: 'openai-model',
              apiKey: step.apiKey,
              baseUrl: value.trim() || null,
              defaultModel: step.defaultModel,
            })
          }}
          onCancel={() =>
            setStep({
              name: 'openai-key',
              defaultModel: step.defaultModel,
            })
          }
        />
      )
      }

    case 'openai-model':
      {
        const openAIMetadata = getProviderPresetUiMetadata('openai')
      return (
        <TextEntryDialog
          resetStateKey={step.name}
          title={`${openAIMetadata.name} setup`}
          subtitle="Step 3 of 3"
          description={`Enter a model name. Leave blank for ${step.defaultModel}.`}
          initialValue={defaults.openAIModel ?? step.defaultModel}
          placeholder={step.defaultModel}
          allowEmpty
          onSubmit={value => {
            const env = buildOpenAIProfileEnv({
              goal: normalizeRecommendationGoal(null),
              apiKey: step.apiKey,
              baseUrl: step.baseUrl,
              model: value.trim() || step.defaultModel,
              processEnv: {},
            })
            if (env) {
              finishProfileSave(onDone, 'openai', env)
            }
          }}
          onCancel={() =>
            setStep({
              name: 'openai-base',
              apiKey: step.apiKey,
              defaultModel: step.defaultModel,
            })
          }
        />
      )
      }

    case 'mistral-key':
      {
        const mistralMetadata = getProviderPresetUiMetadata('mistral')
      return (
        <TextEntryDialog
          resetStateKey={step.name}
          title={`${mistralMetadata.label} setup`}
          subtitle="Step 1 of 3"
          description={
            process.env.MISTRAL_API_KEY
              ? `Enter an API key, or leave this blank to reuse the current ${mistralMetadata.credentialEnvVars[0] ?? 'MISTRAL_API_KEY'} from this session.`
              : `Enter the API key for ${mistralMetadata.label}.`
          }
          initialValue=""
          placeholder="..."
          mask="*"
          allowEmpty={Boolean(process.env.MISTRAL_API_KEY)}
          validate={value => {
            const candidate = value.trim() || process.env.MISTRAL_API_KEY || ''
            return sanitizeApiKey(candidate)
              ? null
              : 'Enter a real API key. Placeholder values like SUA_CHAVE are not valid.'
          }}
          onSubmit={value => {
            const apiKey = value.trim() || process.env.MISTRAL_API_KEY || ''
            setStep({
              name: 'mistral-base',
              apiKey,
              defaultModel: step.defaultModel,
            })
          }}
          onCancel={() => setStep({ name: 'choose' })}
        />
      )
      }

    case 'mistral-base':
      {
        const mistralMetadata = getProviderPresetUiMetadata('mistral')
      return (
        <TextEntryDialog
          resetStateKey={step.name}
          title={`${mistralMetadata.label} setup`}
          subtitle="Step 2 of 3"
          description={`Optionally enter a base URL. Leave blank for ${mistralMetadata.baseUrl || DEFAULT_MISTRAL_BASE_URL}.`}
          initialValue={
            defaults.mistralBaseUrl === DEFAULT_MISTRAL_BASE_URL
              ? ''
              : defaults.mistralBaseUrl
          }
          placeholder={DEFAULT_MISTRAL_BASE_URL}
          allowEmpty
          onSubmit={value => {
            setStep({
              name: 'mistral-model',
              apiKey: step.apiKey,
              baseUrl: value.trim() || null,
              defaultModel: step.defaultModel,
            })
          }}
          onCancel={() =>
            setStep({
              name: 'mistral-key',
              defaultModel: step.defaultModel,
            })
          }
        />
      )
      }

    case 'mistral-model':
      {
        const mistralMetadata = getProviderPresetUiMetadata('mistral')
      return (
        <TextEntryDialog
          resetStateKey={step.name}
          title={`${mistralMetadata.label} setup`}
          subtitle="Step 3 of 3"
          description={`Enter a model name. Leave blank for ${step.defaultModel}.`}
          initialValue={defaults.mistralModel ?? step.defaultModel}
          placeholder={step.defaultModel}
          allowEmpty
          onSubmit={value => {
            const env = buildMistralProfileEnv({
              model: value.trim() || step.defaultModel,
              baseUrl: step.baseUrl,
              apiKey: step.apiKey,
              processEnv: process.env,
            })
            if (env) {
              finishProfileSave(onDone, 'mistral', env)
            }
          }}
          onCancel={() =>
            setStep({
              name: 'mistral-base',
              apiKey: step.apiKey,
              defaultModel: step.defaultModel,
            })
          }
        />
      )
      }

    case 'gemini-auth-method': {
      const hasShellGeminiKey = Boolean(
        process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
      )
      const hasShellGeminiAccessToken = Boolean(process.env.GEMINI_ACCESS_TOKEN)
      const hasStoredGeminiAccessToken = Boolean(readGeminiAccessToken())
      const hasAdc = mayHaveGeminiAdcCredentials(process.env)
      const projectHint = getGeminiProjectIdHint(process.env)

      const options: OptionWithDescription[] = [
        {
          label: 'API key',
          value: 'api-key',
          description: hasShellGeminiKey
            ? 'Use the current Google AI / Gemini API key from this shell, or enter a new one'
            : 'Use a Google AI / Gemini API key',
        },
        {
          label: 'Access token',
          value: 'access-token',
          description: hasShellGeminiAccessToken || hasStoredGeminiAccessToken
            ? `Use ${
                hasShellGeminiAccessToken
                  ? 'the current GEMINI_ACCESS_TOKEN'
                  : 'the securely stored Google AI / Gemini access token'
              }`
            : 'Enter a Google AI / Gemini access token and store it securely',
        },
        {
          label: 'Local ADC',
          value: 'adc',
          description: hasAdc
            ? `Use local Google ADC credentials${projectHint ? ` (project: ${projectHint})` : ''}`
            : 'Use local Google ADC credentials after running gcloud auth application-default login',
        },
      ]

      return (
        <Dialog title="Google AI / Gemini setup" onCancel={() => onDone()}>
          <Box flexDirection="column" gap={1}>
            <Text>Choose how this Google AI / Gemini profile should authenticate.</Text>
            <Select
              options={options}
              inlineDescriptions
              visibleOptionCount={options.length}
              onChange={(value: string) => {
                if (value === 'api-key') {
                  setStep({ name: 'gemini-key' })
                } else if (value === 'access-token') {
                  setStep({ name: 'gemini-access-token' })
                } else {
                  setStep({
                    name: 'gemini-model',
                    authMode: 'adc',
                  })
                }
              }}
              onCancel={() => setStep({ name: 'choose' })}
            />
          </Box>
        </Dialog>
      )
    }

    case 'gemini-key': {
      const currentGeminiApiKey =
        process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || ''
      return (
        <TextEntryDialog
          resetStateKey={step.name}
          title="Google AI / Gemini setup"
          subtitle="Step 1 of 3"
          description={
            currentGeminiApiKey
              ? 'Enter a Google AI / Gemini API key, or leave this blank to reuse the current GEMINI_API_KEY/GOOGLE_API_KEY from this session.'
              : 'Enter a Google AI / Gemini API key. You can create one at https://aistudio.google.com/apikey.'
          }
          initialValue=""
          placeholder="AIza..."
          mask="*"
          allowEmpty={Boolean(currentGeminiApiKey)}
          onSubmit={value => {
            const apiKey = value.trim() || currentGeminiApiKey
            setStep({ name: 'gemini-model', apiKey, authMode: 'api-key' })
          }}
          onCancel={() => setStep({ name: 'gemini-auth-method' })}
        />
      )
    }

    case 'gemini-access-token': {
      const currentToken =
        process.env.GEMINI_ACCESS_TOKEN || readGeminiAccessToken() || ''
      return (
        <TextEntryDialog
          resetStateKey={step.name}
          title="Google AI / Gemini setup"
          subtitle="Step 2 of 3"
          description={
            currentToken
              ? 'Enter a Google AI / Gemini access token, or leave this blank to reuse the current token from this session or secure storage.'
              : 'Enter a Google AI / Gemini access token. It will be stored securely for this profile.'
          }
          initialValue=""
          placeholder="ya29...."
          mask="*"
          allowEmpty={Boolean(currentToken)}
          validate={value => {
            const token = value.trim() || currentToken
            return token ? null : 'Enter a Google AI / Gemini access token or go back and choose Local ADC.'
          }}
          onSubmit={value => {
            const token = value.trim() || currentToken
            const saved = saveGeminiAccessToken(token)
            if (!saved.success) {
              onDone(
                `Failed to save Google AI / Gemini access token: ${saved.warning ?? 'unknown error'}`,
                {
                  display: 'system',
                },
              )
              return
            }

            setStep({
              name: 'gemini-model',
              authMode: 'access-token',
            })
          }}
          onCancel={() => setStep({ name: 'gemini-auth-method' })}
        />
      )
    }

    case 'gemini-model':
      return (
        <TextEntryDialog
          resetStateKey={step.name}
          title="Google AI / Gemini setup"
          subtitle={
            step.authMode === 'api-key'
              ? 'Step 3 of 3'
              : step.authMode === 'access-token'
                ? 'Step 3 of 3'
                : 'Step 2 of 2'
          }
          description={
            step.authMode === 'api-key'
              ? `Enter a Google AI / Gemini model name. Leave blank for ${DEFAULT_GEMINI_MODEL}.`
              : step.authMode === 'access-token'
                ? `Enter a Google AI / Gemini model name. Leave blank for ${DEFAULT_GEMINI_MODEL}. This profile will use the stored Google AI / Gemini access token at runtime.`
                : `Enter a Google AI / Gemini model name. Leave blank for ${DEFAULT_GEMINI_MODEL}. This profile will use local Google ADC credentials at runtime.`
          }
          initialValue={defaults.geminiModel}
          placeholder={DEFAULT_GEMINI_MODEL}
          allowEmpty
          onSubmit={value => {
            if (
              step.authMode === 'adc' &&
              !mayHaveGeminiAdcCredentials(process.env)
            ) {
              onDone(
                'Local ADC credentials were not detected. Run `gcloud auth application-default login` first, then save the Google AI / Gemini ADC profile again.',
                {
                  display: 'system',
                },
              )
              return
            }

            const env = buildGeminiProfileEnv({
              apiKey: step.apiKey,
              authMode: step.authMode,
              model: value.trim() || DEFAULT_GEMINI_MODEL,
              processEnv: {},
            })
            if (env) {
              finishProfileSave(onDone, 'gemini', env)
            }
          }}
          onCancel={() =>
            step.authMode === 'api-key'
              ? setStep({ name: 'gemini-key' })
              : step.authMode === 'access-token'
                ? setStep({ name: 'gemini-access-token' })
                : setStep({ name: 'gemini-auth-method' })
          }
        />
      )

    case 'codex-check':
      return (
        <CodexCredentialStep
          onSave={(profile, env) => finishProfileSave(onDone, profile, env)}
          onBack={() => setStep({ name: 'choose' })}
          onCancel={() => onDone()}
        />
      )

    case 'codex-oauth':
      return (
        <CodexOAuthStep
          onSave={(profile, env) => finishProfileSave(onDone, profile, env)}
          onBack={() => setStep({ name: 'choose' })}
          onCancel={() => onDone()}
        />
      )
  }
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const trimmedArgs = args?.trim().toLowerCase() ?? ''

  if (
    COMMON_HELP_ARGS.includes(trimmedArgs) ||
    COMMON_INFO_ARGS.includes(trimmedArgs) ||
    trimmedArgs === 'help' ||
    trimmedArgs === '--help' ||
    trimmedArgs === '-h'
  ) {
    onDone(
      'Run /provider to add, edit, delete, or activate provider profiles. The active provider controls base URL, model, and API key.',
      { display: 'system' },
    )
    return
  }

  return (
    <ProviderManager
      mode="manage"
      onDone={result => {
        const { message, metaMessages } = buildProviderManagerCompletion(result)
        onDone(message, { display: 'system', metaMessages })
      }}
    />
  )
}
