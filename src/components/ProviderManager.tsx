import figures from 'figures'
import * as React from 'react'
import { DEFAULT_CODEX_BASE_URL } from '../services/api/providerConfig.js'
import { Box, Text, useInput } from '../ink.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { useSetAppState } from '../state/AppState.js'
import type {
  OpenAICompatibleApiFormat,
  ProviderProfile,
} from '../utils/config.js'
import {
  clearCodexCredentials,
  readCodexCredentialsAsync,
} from '../utils/codexCredentials.js'
import { isBareMode, isEnvTruthy } from '../utils/envUtils.js'
import { isFirstPartyAnthropicBaseUrlForEnv } from '../utils/anthropicBaseUrl.js'
import { logForDebugging } from '../utils/debug.js'
import {
  parseProfileCustomHeadersInput,
  serializeProfileCustomHeaders,
} from '../utils/providerCustomHeaders.js'
import { getPrimaryModel, hasMultipleModels, parseModelList } from '../utils/providerModels.js'
import {
  applySavedProfileToCurrentSession,
  buildCodexOAuthProfileEnv,
  buildXaiOAuthProfileEnv,
  clearPersistedCodexOAuthProfile,
  clearPersistedXaiOAuthProfile,
  createProfileFile,
} from '../utils/providerProfile.js'
import {
  clearXaiCredentials,
  readXaiCredentialsAsync,
} from '../utils/xaiCredentials.js'
import {
  getProviderPresetUiMetadata,
  getRouteProviderTypeLabel,
  getRouteDescriptor,
  ORDERED_PROVIDER_PRESETS,
  routeSupportsApiFormatSelection,
  routeSupportsAuthHeaders,
  routeSupportsCustomHeaders,
  routeShowsAuthHeader,
  routeShowsAuthHeaderValue,
  routeShowsCustomHeaders,
  resolveProfileRoute,
  resolveRouteCredentialValue,
  resolveRouteIdFromBaseUrl,
} from '../integrations/index.js'
import {
  provisionAimlapiKey,
  topUpAimlapiByApiKey,
  parseAimlapiAmountUsd,
  isValidAimlapiEmail,
  isValidAimlapiSignInCode,
  beginAimlapiEmailOnboarding,
  completeAimlapiCodeSignIn,
  validateAimlapiApiKey,
  AimlapiApiError,
  AIMLAPI_MESSAGES,
  claimAimlapiTopupStateAsync,
  clearAimlapiTopupStateAsync,
  recordAimlapiCheckoutSessionAsync,
  resetAimlapiCheckoutSessionAsync,
  saveAimlapiTopupStateAsync,
  reconcileSettledAimlapiTopupStateAsync,
  aimlapiByKeyIdentity,
  loadAimlapiSignInKey,
  saveAimlapiSignInKeyAsync,
  clearAimlapiSignInKeyAsync,
  type AimlapiTopupIntent,
  type AimlapiTopupStatus,
} from './providerManagerAimlapi.js'
import {
  DEFAULT_AMOUNT_USD_MINOR,
  DEFAULT_PARTNER_NAME,
  isCanonicalAimlapiInferenceBaseUrl,
  resolveEndpoints,
  resolvePartnerId,
} from '../integrations/aimlapi/config.js'
import { openAIShimSupportsApiFormatForModel } from '../integrations/runtimeMetadata.js'
import { getCommandcodeChatCompletionsModelError } from '../integrations/gateways/commandcode.js'
import { probeRouteReadiness } from '../integrations/discoveryService.js'
import {
  addProviderProfile,
  ANTHROPIC_DEFAULT_PROFILE_ID,
  applyActiveProviderProfileFromConfig,
  clearActiveProviderProfile,
  deleteProviderProfile,
  getActiveProviderProfile,
  getProviderPresetDefaults,
  getProviderProfiles,
  resolveProfileCapabilityRouteId,
  setActiveProviderProfile,
  type ProviderPreset,
  type ProviderProfileInput,
  updateProviderProfile,
} from '../utils/providerProfiles.js'
import { getDefaultMainLoopModelSetting } from '../utils/model/model.js'
import {
  clearGithubModelsToken,
  clearHydratedGithubModelsTokenFromEnv,
  GITHUB_MODELS_HYDRATED_ENV_MARKER,
  hydrateGithubModelsTokenFromSecureStorage,
  readGithubModelsToken,
  readGithubModelsTokenAsync,
} from '../utils/githubModelsCredentials.js'
import {
  type AtomicChatReadiness,
  type OllamaGenerationReadiness,
} from '../utils/providerDiscovery.js'
import {
  rankOllamaModels,
  recommendOllamaModel,
} from '../utils/providerRecommendation.js'
import { clearStartupProviderOverrides } from '../utils/providerStartupOverrides.js'
import { redactSensitiveInfo, redactUrlForDisplay } from '../utils/redaction.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import {
  type OptionWithDescription,
  Select,
} from './CustomSelect/index.js'
import { Pane } from './design-system/Pane.js'
import { Spinner } from './Spinner.js'
import TextInput from './TextInput.js'
import { useCodexOAuthFlow } from './useCodexOAuthFlow.js'
import { useXaiOAuthFlow } from './useXaiOAuthFlow.js'

export type ProviderManagerResult = {
  action: 'saved' | 'cancelled' | 'activated'
  activeProfileId?: string
  activeProviderName?: string
  activeProviderModel?: string
  message?: string
}

type Props = {
  mode: 'first-run' | 'manage'
  onDone: (result?: ProviderManagerResult) => void
}

type Screen =
  | 'menu'
  | 'select-preset'
  | 'select-ollama-model'
  | 'select-atomic-chat-model'
  | 'codex-oauth'
  | 'xai-oauth'
  | 'form'
  | 'preset-model'
  | 'aimlapi-api-key-choice'
  | 'aimlapi-configured'
  | 'aimlapi-topup-email'
  | 'aimlapi-signin-code'
  | 'aimlapi-low-balance'
  | 'aimlapi-topup-amount'
  | 'aimlapi-topup-progress'
  | 'aimlapi-done'
  | 'preset-api-key'
  | 'select-active'
  | 'select-edit'
  | 'select-delete'

type CodexOAuthPersistenceResult = { warning?: string }
type PersistCodexOAuthCredentials = (options?: {
  profileId?: string
}) => CodexOAuthPersistenceResult | void

type DraftField =
  | 'name'
  | 'baseUrl'
  | 'model'
  | 'apiKey'
  | 'apiFormat'
  | 'authHeader'
  | 'authHeaderValue'
  | 'customHeaders'

type ProviderDraft = Record<DraftField, string>

type OllamaSelectionState =
  | { state: 'idle' }
  | { state: 'loading' }
  | {
      state: 'ready'
      options: OptionWithDescription<string>[]
      defaultValue?: string
    }
  | { state: 'unavailable'; message: string }

type AtomicChatSelectionState =
  | { state: 'idle' }
  | { state: 'loading' }
  | {
      state: 'ready'
      options: OptionWithDescription<string>[]
      defaultValue?: string
    }
  | { state: 'unavailable'; message: string }

const FORM_STEPS: Array<{
  key: DraftField
  label: string
  placeholder: string
  helpText: string
  optional?: boolean
}> = [
  {
    key: 'name',
    label: 'Provider name',
    placeholder: 'e.g. Ollama Home, OpenAI Work',
    helpText: 'A short label shown in /provider and startup setup.',
  },
  {
    key: 'baseUrl',
    label: 'Base URL',
    placeholder: 'e.g. http://localhost:11434/v1',
    helpText: 'API base URL used for this provider profile.',
  },
  {
    key: 'model',
    label: 'Default model',
    placeholder: 'e.g. llama3.1:8b or glm-4.7; glm-4.7-flash',
    helpText: 'Model name(s) to use. Separate multiple with ";" or ","; first is default.',
  },
  {
    key: 'apiFormat',
    label: 'API mode',
    placeholder: 'automatic',
    helpText: 'Automatically select the API surface, or choose one explicitly.',
    optional: true,
  },
  {
    key: 'authHeader',
    label: 'Auth header',
    placeholder: 'e.g. api-key or X-API-Key',
    helpText: 'Optional. Header name used for a custom provider key.',
    optional: true,
  },
  {
    key: 'authHeaderValue',
    label: 'Auth header value',
    placeholder: 'Leave empty to use the API key value',
    helpText: 'Optional. Value sent in the custom auth header.',
    optional: true,
  },
  {
    key: 'apiKey',
    label: 'API key',
    placeholder: 'Leave empty if your provider does not require one',
    helpText: 'Optional. Press Enter with empty value to skip.',
    optional: true,
  },
  {
    key: 'customHeaders',
    label: 'Custom headers',
    placeholder: 'e.g. X-Trace: enabled; X-Team: devtools',
    helpText: 'Optional. Extra non-auth request headers for providers that support them.',
    optional: true,
  },
]

const GITHUB_PROVIDER_ID = '__github_models__'
const GITHUB_PROVIDER_LABEL = 'GitHub Models'
const ANTHROPIC_PROVIDER_LABEL = 'Anthropic (built-in)'
const GITHUB_PROVIDER_DEFAULT_MODEL = 'github:copilot'
const GITHUB_PROVIDER_DEFAULT_BASE_URL = 'https://models.github.ai/inference'
const CODEX_OAUTH_PROVIDER_NAME = 'Codex OAuth'
const CODEX_OAUTH_PROVIDER_MODEL = 'codexplan'
const XAI_OAUTH_PROVIDER_NAME = 'xAI OAuth'
const XAI_OAUTH_PROVIDER_MODEL = 'grok-4.6'
const XAI_OAUTH_PROVIDER_BASE_URL = 'https://api.x.ai/v1'
type GithubCredentialSource = 'stored' | 'env' | 'none'

function toDraft(profile: ProviderProfile): ProviderDraft {
  return {
    name: profile.name,
    baseUrl: profile.baseUrl,
    model: profile.model,
    apiKey: profile.apiKey ?? '',
    apiFormat: profile.apiFormat ?? 'auto',
    authHeader: profile.authHeader ?? '',
    authHeaderValue: profile.authHeaderValue ?? '',
    customHeaders: serializeProfileCustomHeaders(profile.customHeaders) ?? '',
  }
}

function getPresetLabel(preset: ProviderPreset, label: string, metadata?: { badge?: { text: string; color?: string } }): React.ReactNode {
  if (metadata?.badge) {
    if (metadata.badge.text.toLowerCase() === 'recommended') {
      return (
        <Text>
          <Text>{label} </Text>
          <Text color={metadata.badge.color ?? 'success'} bold>★ Recommended</Text>
        </Text>
      )
    }

    return (
      <Text>
        <Text>{label} </Text>
        <Text color={metadata.badge.color ?? 'green'} bold>[{metadata.badge.text}]</Text>
      </Text>
    )
  }
  return label
}

function presetToDraft(preset: ProviderPreset): ProviderDraft {
  const defaults = getProviderPresetDefaults(preset)
  return {
    name: defaults.name,
    baseUrl: defaults.baseUrl,
    model: defaults.model,
    apiKey: defaults.apiKey ?? '',
    apiFormat: 'chat_completions',
    authHeader: '',
    authHeaderValue: '',
    customHeaders: '',
  }
}

function isSetupPlaceholder(value: string): boolean {
  return (
    /\bYOUR[-_\s]/i.test(value) ||
    /<[^>]+>/.test(value) ||
    /:\/\/[^/]+\.example(?:\/|$)/i.test(value)
  )
}

function canUseStreamlinedPresetFlow(draft: ProviderDraft): boolean {
  // Descriptor placeholder defaults mean the endpoint/model are user-specific,
  // so those presets still need the full setup form.
  return !isSetupPlaceholder(draft.baseUrl) && !isSetupPlaceholder(draft.model)
}

function profileSummary(profile: ProviderProfile, isActive: boolean): string {
  const activeSuffix = isActive ? ' (active)' : ''
  const keyInfo = profile.apiKey ? 'key set' : 'no key'
  const routeId = resolveProfileRoute(profile.provider).routeId
  const providerKind = getRouteProviderTypeLabel(routeId)
  const models = parseModelList(profile.model)
  const modelDisplay =
    models.length <= 3
      ? models.join(', ')
      : `${models[0]}, ${models[1]} + ${models.length - 2} more`
  const modeInfo =
    routeSupportsApiFormatSelection(routeId)
      ? ` · ${profile.apiFormat === 'responses_compat' ? 'responses (compat)' : profile.apiFormat === 'responses' ? 'responses' : profile.apiFormat === 'chat_completions' ? 'chat/completions' : 'automatic'}`
      : ''
  const authInfo =
    routeSupportsAuthHeaders(routeId) && profile.authHeader
      ? ` · ${profile.authHeader} auth`
      : ''
  return `${providerKind} · ${profile.baseUrl} · ${modelDisplay}${modeInfo}${authInfo} · ${keyInfo}${activeSuffix}`
}

function getGithubCredentialSourceFromEnv(
  processEnv: NodeJS.ProcessEnv = process.env,
): GithubCredentialSource {
  if (processEnv.GITHUB_TOKEN?.trim() || processEnv.GH_TOKEN?.trim()) {
    return 'env'
  }
  return 'none'
}

function resolveProviderEditorRouteId(
  provider: ProviderProfile['provider'],
  baseUrl?: string,
): string {
  return resolveProfileCapabilityRouteId(provider, baseUrl)
}

function routeSupportsResponsesModel(routeId: string, model: string): boolean {
  return openAIShimSupportsApiFormatForModel(
    getRouteDescriptor(routeId)?.transportConfig.openaiShim,
    'responses',
    getPrimaryModel(model),
  )
}

function getResponsesApiModelSetLabel(routeId: string): string {
  const prefixes =
    getRouteDescriptor(routeId)?.transportConfig.openaiShim
      ?.responsesApiModelPrefixes
  if (!prefixes || prefixes.length === 0) {
    return "this provider's configured model set"
  }

  return `${prefixes.join(', ')} models`
}

async function resolveGithubCredentialSource(
  processEnv: NodeJS.ProcessEnv = process.env,
): Promise<GithubCredentialSource> {
  const envSource = getGithubCredentialSourceFromEnv(processEnv)
  if (envSource !== 'none') {
    return envSource
  }

  if (await readGithubModelsTokenAsync()) {
    return 'stored'
  }

  return 'none'
}

function isGithubProviderAvailable(
  credentialSource: GithubCredentialSource,
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isEnvTruthy(processEnv.CLAUDE_CODE_USE_GITHUB)) {
    return true
  }
  return credentialSource !== 'none'
}

function getGithubProviderModel(
  processEnv: NodeJS.ProcessEnv = process.env,
): string {
  if (isEnvTruthy(processEnv.CLAUDE_CODE_USE_GITHUB)) {
    return processEnv.OPENAI_MODEL?.trim() || GITHUB_PROVIDER_DEFAULT_MODEL
  }
  return GITHUB_PROVIDER_DEFAULT_MODEL
}

function getGithubProviderSummary(
  isActive: boolean,
  credentialSource: GithubCredentialSource,
  processEnv: NodeJS.ProcessEnv = process.env,
): string {
  const credentialSummary =
    credentialSource === 'stored'
      ? 'token stored'
      : credentialSource === 'env'
        ? 'token via env'
        : 'no token found'
  const activeSuffix = isActive ? ' (active)' : ''
  return `github-models · ${GITHUB_PROVIDER_DEFAULT_BASE_URL} · ${getGithubProviderModel(processEnv)} · ${credentialSummary}${activeSuffix}`
}

function describeAtomicChatSelectionIssue(
  readiness: AtomicChatReadiness,
  baseUrl: string,
): string {
  if (readiness.state === 'unreachable') {
    return `Could not reach Atomic Chat at ${redactUrlForDisplay(baseUrl)}. Start the Atomic Chat app first, or enter the endpoint manually.`
  }

  if (readiness.state === 'no_models') {
    return 'Atomic Chat is running, but no models are loaded. Download and load a model inside the Atomic Chat app first, or enter details manually.'
  }

  return ''
}

function describeOllamaSelectionIssue(
  readiness: OllamaGenerationReadiness,
  baseUrl: string,
): string {
  if (readiness.state === 'unreachable') {
    return `Could not reach Ollama at ${redactUrlForDisplay(baseUrl)}. Start Ollama first, or enter the endpoint manually.`
  }

  if (readiness.state === 'no_models') {
    return 'Ollama is running, but no installed models were found. Pull a chat model such as qwen2.5-coder:7b or llama3.1:8b first, or enter details manually.'
  }

  if (readiness.state === 'generation_failed') {
    const modelHint = readiness.probeModel ?? 'the selected model'
    const detailSuffix = readiness.detail
      ? ` Details: ${readiness.detail}.`
      : ''
    return `Ollama is reachable and models are installed, but a generation probe failed for ${modelHint}.${detailSuffix} Run "ollama run ${modelHint}" once and retry, or enter details manually.`
  }

  return ''
}

function findCodexOAuthProfile(
  profiles: ProviderProfile[],
  profileId?: string,
): ProviderProfile | undefined {
  if (!profileId) {
    return undefined
  }

  return profiles.find(profile => profile.id === profileId)
}

function isCodexOAuthProfile(
  profile: ProviderProfile | null | undefined,
  profileId?: string,
): boolean {
  return Boolean(profile && profileId && profile.id === profileId)
}

function findXaiOAuthProfile(
  profiles: ProviderProfile[],
  profileId?: string,
): ProviderProfile | undefined {
  if (!profileId) return undefined
  return profiles.find(profile => profile.id === profileId)
}

function isXaiOAuthProfile(
  profile: ProviderProfile | null | undefined,
  profileId?: string,
): boolean {
  return Boolean(profile && profileId && profile.id === profileId)
}

function XaiOAuthSetup({
  onBack,
  onConfigured,
}: {
  onBack: () => void
  onConfigured: (
    tokens: {
      accessToken: string
      refreshToken: string
      idToken?: string
      accountId?: string
      email?: string
      displayName?: string
      tokenEndpoint: string
      expiresAt?: number
    },
    persistCredentials: () => void,
  ) => void | Promise<void>
}): React.ReactNode {
  const handleAuthenticated = React.useCallback(
    async (tokens: Parameters<typeof onConfigured>[0], persist: () => void) => {
      await onConfigured(tokens, persist)
    },
    [onConfigured],
  )
  useKeybinding('confirm:no', onBack)

  const status = useXaiOAuthFlow({
    onAuthenticated: handleAuthenticated,
  })

  if (status.state === 'error') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="error" bold>
          xAI OAuth failed
        </Text>
        <Text>{status.message}</Text>
        <Text dimColor>Press Enter or Esc to go back.</Text>
        <Select
          options={[
            {
              value: 'back',
              label: 'Back',
              description: 'Return to provider presets',
            },
          ]}
          onChange={onBack}
          onCancel={onBack}
          visibleOptionCount={1}
        />
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text color="remember" bold>
        xAI OAuth (Grok)
      </Text>
      <Text>
        Sign in with your xAI account in the browser. OpenClaude will store
        the resulting OAuth credentials securely and switch this session to
        Grok when setup completes.
      </Text>
      <Text dimColor>
        The xAI consent screen may label the app "Grok Build" — that's
        expected. OpenClaude uses xAI's shared OAuth client.
      </Text>
      {status.state === 'starting' ? (
        <Text dimColor>
          Starting local callback on 127.0.0.1:56121 and preparing your
          browser…
        </Text>
      ) : status.browserOpened === false ? (
        <>
          <Text color="warning">
            Browser did not open automatically. Visit this URL to continue:
          </Text>
          <Text>{status.authUrl}</Text>
        </>
      ) : status.browserOpened === true ? (
        <>
          <Text dimColor>
            Browser opened. Finish the xAI sign-in there and this setup will
            complete automatically.
          </Text>
          <Text>{status.authUrl}</Text>
        </>
      ) : (
        <Text dimColor>Opening your browser…</Text>
      )}
      {status.state === 'waiting' ? (
        <>
          <Text dimColor>
            If xAI shows "Could not establish connection", paste the code
            below and press Enter:
          </Text>
          <XaiManualCodeInput onSubmit={status.submitManualCode} />
        </>
      ) : null}
      <Text dimColor>Press Esc to cancel and go back.</Text>
    </Box>
  )
}

function XaiManualCodeInput({
  onSubmit,
}: {
  onSubmit: (code: string) => void
}): React.ReactNode {
  const [value, setValue] = React.useState('')
  const [cursorOffset, setCursorOffset] = React.useState(0)
  const { columns: terminalColumns } = useTerminalSize()
  const inputColumns = Math.max(20, Math.min(80, terminalColumns - 8))
  return (
    <Box>
      <Text>Code › </Text>
      <TextInput
        value={value}
        onChange={setValue}
        cursorOffset={cursorOffset}
        onChangeCursorOffset={setCursorOffset}
        columns={inputColumns}
        onSubmit={submitted => {
          const trimmed = submitted.trim()
          if (trimmed) onSubmit(trimmed)
        }}
        mask="*"
        // The parent `XaiOAuthSetup` owns Esc via `useKeybinding('confirm:no')`.
        // Without this flag, BaseTextInput's child-effect Esc handler runs
        // before the parent keybinding, triggering the "press Esc again to
        // clear" double-press flow and swallowing the cancel.
        disableEscapeDoublePress
      />
    </Box>
  )
}

function CodexManualCallbackInput({
  onSubmit,
}: {
  onSubmit: (input: string) => void
}): React.ReactNode {
  const [value, setValue] = React.useState('')
  const [cursorOffset, setCursorOffset] = React.useState(0)
  const { columns: terminalColumns } = useTerminalSize()
  const inputColumns = Math.max(20, Math.min(120, terminalColumns - 12))
  return (
    <Box>
      <Text>Callback URL › </Text>
      <TextInput
        value={value}
        onChange={setValue}
        cursorOffset={cursorOffset}
        onChangeCursorOffset={setCursorOffset}
        columns={inputColumns}
        onSubmit={submitted => {
          const trimmed = submitted.trim()
          if (trimmed) onSubmit(trimmed)
        }}
        // The pasted callback URL carries the OAuth `code` and `state` query
        // params — enough to complete the in-flight exchange — so mask it the
        // same way the xAI manual-code field above does, to keep it out of
        // terminal scrollback, recordings, and shared sessions.
        mask="*"
        // The parent `CodexOAuthSetup` owns Esc via `useKeybinding('confirm:no')`.
        disableEscapeDoublePress
      />
    </Box>
  )
}

function CodexOAuthSetup({
  onBack,
  onConfigured,
}: {
  onBack: () => void
  onConfigured: (
    tokens: {
      accessToken: string
      refreshToken: string
      accountId?: string
      idToken?: string
      apiKey?: string
    },
    persistCredentials: PersistCodexOAuthCredentials,
  ) => void | Promise<void>
}): React.ReactNode {
  const handleAuthenticated = React.useCallback(
    async (
      tokens: {
        accessToken: string
        refreshToken: string
        accountId?: string
        idToken?: string
        apiKey?: string
      },
      persistCredentials: PersistCodexOAuthCredentials,
    ) => {
      await onConfigured(tokens, persistCredentials)
    },
    [onConfigured],
  )
  useKeybinding('confirm:no', onBack)

  const status = useCodexOAuthFlow({
    onAuthenticated: handleAuthenticated,
  })
  const [pasteError, setPasteError] = React.useState<string | undefined>()
  const isRemoteSession = Boolean(
    process.env['SSH_CONNECTION'] || process.env['SSH_CLIENT'],
  )

  if (status.state === 'error') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="error" bold>
          Codex OAuth failed
        </Text>
        <Text>{status.message}</Text>
        <Text dimColor>Press Enter or Esc to go back.</Text>
        <Select
          options={[
            {
              value: 'back',
              label: 'Back',
              description: 'Return to provider presets',
            },
          ]}
          onChange={onBack}
          onCancel={onBack}
          visibleOptionCount={1}
        />
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text color="remember" bold>
        Codex OAuth
      </Text>
      <Text>
        Sign in with your ChatGPT account in the browser. OpenClaude will store
        the resulting Codex credentials securely and switch this session to the
        new Codex login when setup completes.
      </Text>
      {status.state === 'starting' ? (
        <Text dimColor>Starting local callback and preparing your browser...</Text>
      ) : status.browserOpened === false ? (
        <>
          <Text color="warning">
            Browser did not open automatically. Visit this URL to continue:
          </Text>
          <Text>{status.authUrl}</Text>
        </>
      ) : status.browserOpened === true ? (
        <>
          <Text dimColor>
            Browser opened. Finish the ChatGPT sign-in there and this setup will
            complete automatically.
          </Text>
          <Text>{status.authUrl}</Text>
        </>
      ) : (
        <Text dimColor>Opening your browser...</Text>
      )}
      {status.state === 'waiting' ? (
        <>
          {isRemoteSession ? (
            <Text color="warning">
              SSH session detected — the browser cannot reach this host's
              localhost callback. After signing in, copy the full URL your
              browser was redirected to (it starts with http://localhost:) and
              paste it below.
            </Text>
          ) : (
            <Text dimColor>
              If the browser cannot reach localhost (remote / containerized
              session), paste the full callback URL it was redirected to:
            </Text>
          )}
          <CodexManualCallbackInput
            onSubmit={input => {
              const result = status.submitManualCallback(input)
              if (!result.ok) {
                setPasteError(result.error)
              } else {
                setPasteError(undefined)
              }
            }}
          />
          {pasteError ? <Text color="error">{pasteError}</Text> : null}
        </>
      ) : null}
      <Text dimColor>Press Esc to cancel and go back.</Text>
    </Box>
  )
}

type AimlapiTopupFormProps = {
  amountUsd: string
  autoTopUp: boolean
  columns: number
  cursorOffset: number
  onAmountChange: (value: string) => void
  onCursorOffsetChange: (offset: number) => void
  onAutoTopUpChange: (enabled: boolean) => void
  onSubmit: () => void
}

function wrapAimlapiCheckoutUrl(url: string, width: number): string[] {
  const characters = Array.from(url.trim())
  const chunkSize = Math.max(20, width)
  const lines: string[] = []
  for (let offset = 0; offset < characters.length; offset += chunkSize) {
    lines.push(characters.slice(offset, offset + chunkSize).join(''))
  }
  return lines
}

// Structural, not `instanceof AimlapiApiError`: some callers surface a
// duck-typed error (e.g. an Error with a bolted-on `status`) instead of the
// real class, and this still needs to recognize its HTTP status.
function aimlapiApiErrorStatus(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status: unknown }).status)
    : undefined
}

function safeAimlapiErrorMessage(
  error: unknown,
  secrets: Array<string | undefined> = [],
): string {
  // AimlapiApiError.message deliberately excludes its server-controlled body.
  // Redact exact active values as well as keys matching known credential shapes.
  let message = error instanceof Error ? error.message : String(error)
  for (const secret of secrets) {
    const value = secret?.trim()
    if (value) message = message.split(value).join('[REDACTED]')
  }
  return redactSensitiveInfo(message)
}

function AimlapiTopupForm({
  amountUsd,
  autoTopUp,
  columns,
  cursorOffset,
  onAmountChange,
  onCursorOffsetChange,
  onAutoTopUpChange,
  onSubmit,
}: AimlapiTopupFormProps): React.ReactNode {
  const [focusedField, setFocusedField] = React.useState<'amount' | 'auto'>(
    'amount',
  )

  // This small form intentionally mirrors Zero's two-row top-up control while
  // keeping OpenClaude's native input and event system.
  useInput((input, key, event) => {
    if (key.tab || key.upArrow || key.downArrow) {
      setFocusedField(field => (field === 'amount' ? 'auto' : 'amount'))
      event.stopImmediatePropagation()
      return
    }
    if (focusedField !== 'auto') return
    if (key.leftArrow || key.rightArrow || input === ' ') {
      onAutoTopUpChange(!autoTopUp)
      event.stopImmediatePropagation()
      return
    }
    if (key.return) {
      onSubmit()
      event.stopImmediatePropagation()
      return
    }
    if (!key.escape) event.stopImmediatePropagation()
  })

  const amountFocused = focusedField === 'amount'
  const autoFocused = focusedField === 'auto'
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row">
        <Text color={amountFocused ? 'suggestion' : undefined} bold={amountFocused}>
          {amountFocused ? `${figures.pointer} ` : '  '}Amount: $
        </Text>
        <TextInput
          value={amountUsd}
          onChange={onAmountChange}
          onSubmit={() => onSubmit()}
          focus={amountFocused}
          showCursor={amountFocused}
          columns={columns}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={onCursorOffsetChange}
        />
      </Box>
      <Box flexDirection="row">
        <Text color={autoFocused ? 'suggestion' : undefined} bold={autoFocused}>
          {autoFocused ? `${figures.pointer} ` : '  '}Auto top up:{' '}
        </Text>
        <Text
          color={autoFocused ? 'suggestion' : undefined}
          dimColor={!autoTopUp}
          bold={autoFocused && autoTopUp}
        >
          on
        </Text>
        <Text color={autoFocused ? 'suggestion' : undefined}>/</Text>
        <Text
          color={autoFocused ? 'suggestion' : undefined}
          dimColor={autoTopUp}
          bold={autoFocused && !autoTopUp}
        >
          off
        </Text>
      </Box>
    </Box>
  )
}

export function ProviderManager({ mode, onDone }: Props): React.ReactNode {
  const { columns: terminalColumns } = useTerminalSize()
  const inputColumns = Math.max(20, Math.min(80, terminalColumns - 4))
  const setAppState = useSetAppState()
  const initialGithubCredentialSource = getGithubCredentialSourceFromEnv()
  const initialIsGithubActive = isEnvTruthy(process.env.CLAUDE_CODE_USE_GITHUB)
  const initialHasGithubCredential = initialGithubCredentialSource !== 'none'

  // Deferred initialization: useState initializers run synchronously during
  // render, so getProviderProfiles() and getActiveProviderProfile() would block
  // the UI on first mount (sync file I/O). Use empty initial values and load
  // asynchronously in useEffect with queueMicrotask to keep UI responsive.
  const [profiles, setProfiles] = React.useState<ProviderProfile[]>([])
  const [activeProfileId, setActiveProfileId] = React.useState<string | undefined>()
  const [githubProviderAvailable, setGithubProviderAvailable] = React.useState(
    () => isGithubProviderAvailable(initialGithubCredentialSource),
  )
  const [githubCredentialSource, setGithubCredentialSource] = React.useState<GithubCredentialSource>(
    () => initialGithubCredentialSource,
  )
  const [isGithubActive, setIsGithubActive] = React.useState(() => initialIsGithubActive)
  const [isGithubCredentialSourceResolved, setIsGithubCredentialSourceResolved] =
    React.useState(() => initialHasGithubCredential || initialIsGithubActive)
  const githubRefreshEpochRef = React.useRef(0)
  const codexRefreshEpochRef = React.useRef(0)
  const [screen, setScreen] = React.useState<Screen>(
    mode === 'first-run' ? 'select-preset' : 'menu',
  )
  const [editingProfileId, setEditingProfileId] = React.useState<string | null>(null)
  const [draftProvider, setDraftProvider] = React.useState<ProviderProfile['provider']>(
    'openai',
  )
  const [draft, setDraft] = React.useState<ProviderDraft>(() =>
    presetToDraft('ollama'),
  )
  const [presetRequiresApiKey, setPresetRequiresApiKey] = React.useState(false)
  const [formStepIndex, setFormStepIndex] = React.useState(0)
  const [cursorOffset, setCursorOffset] = React.useState(0)
  const [statusMessage, setStatusMessage] = React.useState<string | undefined>()
  const [errorMessage, setErrorMessage] = React.useState<string | undefined>()
  const [aimlapiTopupEmail, setAimlapiTopupEmail] = React.useState('')
  const [aimlapiTopupAmountUsd, setAimlapiTopupAmountUsd] = React.useState(
    String(DEFAULT_AMOUNT_USD_MINOR / 100),
  )
  const [aimlapiSignInCode, setAimlapiSignInCode] = React.useState('')
  const [aimlapiSessionToken, setAimlapiSessionToken] = React.useState('')
  const [aimlapiIssuedKey, setAimlapiIssuedKey] = React.useState('')
  const [aimlapiIssuedKeyId, setAimlapiIssuedKeyId] = React.useState('')
  const [aimlapiTopupByKey, setAimlapiTopupByKey] = React.useState(false)
  const [aimlapiResumeSessionToken, setAimlapiResumeSessionToken] = React.useState('')
  const [aimlapiExistingProfileId, setAimlapiExistingProfileId] = React.useState<string | null>(null)
  const [aimlapiExistingUsesEnv, setAimlapiExistingUsesEnv] = React.useState(false)
  const [aimlapiInferenceBaseUrl, setAimlapiInferenceBaseUrl] = React.useState(
    () => resolveEndpoints().inferenceBaseUrl,
  )
  const [aimlapiNewAccount, setAimlapiNewAccount] = React.useState(false)
  const [aimlapiAutoTopUp, setAimlapiAutoTopUp] = React.useState(true)
  const [aimlapiTopupStatus, setAimlapiTopupStatus] =
    React.useState<AimlapiTopupStatus | undefined>()
  const [aimlapiTopupDetail, setAimlapiTopupDetail] = React.useState<string | undefined>()
  const [aimlapiDoneKind, setAimlapiDoneKind] = React.useState<'ready' | 'topup'>(
    'ready',
  )
  const [isAimlapiKeyValidating, setIsAimlapiKeyValidating] = React.useState(false)
  const aimlapiAbortRef = React.useRef<AbortController | null>(null)
  const aimlapiPersistedIntentRef = React.useRef<
    (AimlapiTopupIntent & { paymentSessionId: string }) | null
  >(null)
  // True only once a top-up payment actually completes. `aimlapiTopupByKey`
  // marks that the flow is driven by a saved key, not that money changed hands,
  // so the done screen must key off this instead to avoid showing the "Top-up
  // successful" copy when the user merely continued with a saved key.
  const aimlapiTopupPaidRef = React.useRef(false)
  // A checkout URL that has already been opened in the browser (and is therefore
  // chargeable). Submitting a changed amount/auto-top-up would start a NEW
  // payment session, abandoning this one — which no endpoint can cancel — so
  // that submit must be explicitly confirmed first (startAimlapiTopup's
  // abandon-ack gate). A mere draft edit (typing) does NOT touch this: the
  // durable receipt must stay resumable until the user actually confirms.
  const aimlapiOpenedCheckoutRef = React.useRef<{
    amountUsdMinor: number
    autoTopUp: boolean
  } | null>(null)
  const aimlapiAbandonAckRef = React.useRef(false)
  // Set when the user explicitly chose "switch account" from the configured
  // screen. Unlike the ack ref above (which confirms abandoning a checkout
  // THIS mount opened), a stale on-disk receipt here can be from an earlier,
  // separate process — this mount's refs are never populated for it, so the
  // normal ref-based abandon detection can't see the conflict at all. Forces
  // the next claim to override it unconditionally, once.
  const aimlapiForceAbandonExistingRef = React.useRef(false)

  function resetAimlapiCheckoutIntent(): void {
    // NOTE: the opened-checkout tracking (aimlapiOpenedCheckoutRef /
    // aimlapiAbandonAckRef) is deliberately NOT cleared here — callers are a
    // fresh flow entry or a completed/terminal outcome, and a confirmed
    // abandonment (startAimlapiTopup, via claimAimlapiTopupStateAsync's
    // abandonExisting) still needs the opened-checkout record until it takes
    // over the slot itself.
    const intent = aimlapiPersistedIntentRef.current
    if (intent) {
      aimlapiPersistedIntentRef.current = null
      // This runs in a synchronous Ink save callback after the profile is written.
      // Fire the clear on the ASYNC lock and do not await it, so a contended lock
      // never freezes the UI; best-effort — a stale receipt is reconciled on the
      // next run, so a failure must not turn a successful configuration into one.
      void clearAimlapiTopupStateAsync(intent).catch(() => {})
    }
    setAimlapiResumeSessionToken('')
  }

  function resetAimlapiOnboardingIdentity(): void {
    resetAimlapiCheckoutIntent()
    setAimlapiSessionToken('')
    setAimlapiIssuedKey('')
    setAimlapiIssuedKeyId('')
    setAimlapiTopupByKey(false)
    aimlapiTopupPaidRef.current = false
    setAimlapiNewAccount(false)
  }

  React.useEffect(() => {
    const cancelAimlapi = (): void => aimlapiAbortRef.current?.abort()
    const unregister = registerCleanup(cancelAimlapi)
    return () => {
      unregister()
      cancelAimlapi()
    }
  }, [])
  const [menuFocusValue, setMenuFocusValue] = React.useState<string | undefined>()
  const [hasStoredCodexOAuthCredentials, setHasStoredCodexOAuthCredentials] =
    React.useState(false)
  const [storedCodexOAuthProfileId, setStoredCodexOAuthProfileId] =
    React.useState<string | undefined>()
  const [hasStoredXaiOAuthCredentials, setHasStoredXaiOAuthCredentials] =
    React.useState(false)
  const [storedXaiOAuthProfileId, setStoredXaiOAuthProfileId] =
    React.useState<string | undefined>()
  const xaiRefreshEpochRef = React.useRef(0)
  const [ollamaSelection, setOllamaSelection] = React.useState<OllamaSelectionState>({
    state: 'idle',
  })
  const [atomicChatSelection, setAtomicChatSelection] =
    React.useState<AtomicChatSelectionState>({ state: 'idle' })
  // Deferred initialization: useState initializers run synchronously during
  // render, so getProviderProfiles() and getActiveProviderProfile() would block
  // the UI (sync file I/O). Defer to queueMicrotask after first render.
  // In test environment, skip defer to avoid timing issues with mocks.
  const [isInitializing, setIsInitializing] = React.useState(
    process.env.NODE_ENV !== 'test',
  )
  const [isActivating, setIsActivating] = React.useState(false)
  const isRefreshingRef = React.useRef(false)

  React.useEffect(() => {
    // Skip deferred initialization in test environment (mocks are synchronous)
    if (process.env.NODE_ENV === 'test') {
      setProfiles(getProviderProfiles())
      setActiveProfileId(getActiveProviderProfile()?.id)
      setIsInitializing(false)
      return
    }

    queueMicrotask(() => {
      const profilesData = getProviderProfiles()
      const activeId = getActiveProviderProfile()?.id
      setProfiles(profilesData)
      setActiveProfileId(activeId)
      setIsInitializing(false)
    })
  }, [])

  const formSteps = React.useMemo(
    () => {
      const routeId = resolveProviderEditorRouteId(draftProvider, draft.baseUrl)
      const showsAuthHeader = routeShowsAuthHeader(routeId)
      const showsAuthHeaderValue = routeShowsAuthHeaderValue(routeId)
      const showsCustomHeaders = routeShowsCustomHeaders(routeId)
      return FORM_STEPS.filter(step => {
        if (step.key === 'apiFormat') {
          return routeSupportsApiFormatSelection(routeId)
        }
        if (step.key === 'authHeader') {
          return showsAuthHeader
        }
        if (step.key === 'authHeaderValue') {
          return showsAuthHeaderValue
        }
        if (step.key === 'customHeaders') {
          return showsCustomHeaders
        }
        return true
      })
    },
    [draft.baseUrl, draftProvider],
  )
  const currentStep = formSteps[formStepIndex] ?? formSteps[0] ?? FORM_STEPS[0]
  const currentStepKey = currentStep.key
  const currentValue = draft[currentStepKey]
  const displayStep =
    draftProvider === 'custom-anthropic' && currentStepKey === 'apiKey'
      ? {
          ...currentStep,
          label: 'Credential',
          placeholder: 'Credential for this endpoint',
          helpText: 'The custom profile stores this as an Authorization Bearer token.',
          optional: false,
        }
      : currentStep

  // Memoize menu options to prevent unnecessary re-renders when navigating
  // the select menu. Without this, each arrow key press creates a new options
  // array reference, causing Select to re-render and feel sluggish.
  const hasProfiles = profiles.length > 0
  const hasSelectableProviders = hasProfiles || githubProviderAvailable
  // A non-Anthropic provider (a saved profile or GitHub Models) is currently
  // active. The switch-back-to-Anthropic recovery option must stay reachable
  // in that case even when no profiles are saved and GitHub credentials have
  // gone away (cleared storage / removed env token); otherwise the user is
  // stranded on an unusable provider with no way back. Scoped to the activate
  // path only — edit/delete still require an actual profile.
  const isNonAnthropicProviderActive = isGithubActive || activeProfileId != null
  const canSwitchActiveProvider =
    hasSelectableProviders || isNonAnthropicProviderActive
  const menuOptions = React.useMemo(
    () => [
      {
        value: 'add',
        label: 'Add provider',
        description: 'Create a new provider profile',
      },
      {
        value: 'activate',
        label: 'Set active provider',
        description: 'Switch the active provider profile',
        disabled: !canSwitchActiveProvider,
      },
      {
        value: 'edit',
        label: 'Edit provider',
        description: 'Update URL, model, or key',
        disabled: !hasProfiles,
      },
      {
        value: 'delete',
        label: 'Delete provider',
        description: 'Remove a provider profile',
        disabled: !hasSelectableProviders,
      },
      ...(hasStoredCodexOAuthCredentials
        ? [
            {
              value: 'logout-codex-oauth',
              label: 'Log out Codex OAuth',
              description: 'Clear securely stored Codex OAuth credentials',
            },
          ]
        : []),
      ...(hasStoredXaiOAuthCredentials
        ? [
            {
              value: 'logout-xai-oauth',
              label: 'Log out xAI OAuth',
              description: 'Clear securely stored xAI OAuth credentials',
            },
          ]
        : []),
      {
        value: 'done',
        label: 'Done',
        description: 'Return to chat',
      },
    ],
    [
      hasSelectableProviders,
      canSwitchActiveProvider,
      hasProfiles,
      hasStoredCodexOAuthCredentials,
      hasStoredXaiOAuthCredentials,
    ],
  )

  const refreshGithubProviderState = React.useCallback((): void => {
    const envCredentialSource = getGithubCredentialSourceFromEnv()
    const githubActive = isEnvTruthy(process.env.CLAUDE_CODE_USE_GITHUB)
    const canResolveFromEnv = githubActive || envCredentialSource !== 'none'

    if (canResolveFromEnv) {
      githubRefreshEpochRef.current += 1
      setGithubCredentialSource(envCredentialSource)
      setGithubProviderAvailable(isGithubProviderAvailable(envCredentialSource))
      setIsGithubActive(githubActive)
      setIsGithubCredentialSourceResolved(true)
      return
    }

    setIsGithubCredentialSourceResolved(false)
    const refreshEpoch = ++githubRefreshEpochRef.current
    void (async () => {
      const credentialSource = await resolveGithubCredentialSource()
      if (refreshEpoch !== githubRefreshEpochRef.current) {
        return
      }

      setGithubCredentialSource(credentialSource)
      setGithubProviderAvailable(isGithubProviderAvailable(credentialSource))
      setIsGithubActive(isEnvTruthy(process.env.CLAUDE_CODE_USE_GITHUB))
      setIsGithubCredentialSourceResolved(true)
    })()
  }, [])

  const refreshCodexOAuthCredentialState = React.useCallback((): void => {
    if (isBareMode()) {
      codexRefreshEpochRef.current += 1
      setHasStoredCodexOAuthCredentials(false)
      setStoredCodexOAuthProfileId(undefined)
      return
    }

    const refreshEpoch = ++codexRefreshEpochRef.current
    void (async () => {
      const credentials = await readCodexCredentialsAsync()
      if (refreshEpoch !== codexRefreshEpochRef.current) {
        return
      }

      setHasStoredCodexOAuthCredentials(
        Boolean(
          credentials?.apiKey ||
            credentials?.accessToken ||
            credentials?.refreshToken ||
            credentials?.idToken,
        ),
      )
      setStoredCodexOAuthProfileId(credentials?.profileId)
    })()
  }, [])

  const refreshXaiOAuthCredentialState = React.useCallback((): void => {
    if (isBareMode()) {
      xaiRefreshEpochRef.current += 1
      setHasStoredXaiOAuthCredentials(false)
      setStoredXaiOAuthProfileId(undefined)
      return
    }

    const refreshEpoch = ++xaiRefreshEpochRef.current
    void (async () => {
      const credentials = await readXaiCredentialsAsync()
      if (refreshEpoch !== xaiRefreshEpochRef.current) {
        return
      }

      setHasStoredXaiOAuthCredentials(
        Boolean(credentials?.accessToken && credentials?.refreshToken),
      )
      // xAI credentials don't carry a profile id; resolve it by finding the
      // active OAuth-flavored xAI profile (env marker XAI_CREDENTIAL_SOURCE).
      const profiles = getProviderProfiles()
      const oauthProfile = profiles.find(
        p => p.provider === 'xai' && p.name === XAI_OAUTH_PROVIDER_NAME,
      )
      setStoredXaiOAuthProfileId(oauthProfile?.id)
    })()
  }, [])

  React.useEffect(() => {
    refreshGithubProviderState()
    refreshCodexOAuthCredentialState()
    refreshXaiOAuthCredentialState()

    return () => {
      githubRefreshEpochRef.current += 1
      codexRefreshEpochRef.current += 1
      xaiRefreshEpochRef.current += 1
    }
  }, [
    refreshCodexOAuthCredentialState,
    refreshGithubProviderState,
    refreshXaiOAuthCredentialState,
  ])

  React.useEffect(() => {
    if (screen !== 'select-ollama-model') {
      return
    }

    let cancelled = false
    setOllamaSelection({ state: 'loading' })

    void (async () => {
      const readiness = await probeRouteReadiness('ollama', {
        baseUrl: draft.baseUrl,
      })
      if (!readiness) {
        if (!cancelled) {
          setOllamaSelection({
            state: 'unavailable',
            message: `Could not load the Ollama readiness probe for ${redactUrlForDisplay(draft.baseUrl)}. Enter the endpoint manually.`,
          })
        }
        return
      }

      if (readiness.state !== 'ready') {
        if (!cancelled) {
          setOllamaSelection({
            state: 'unavailable',
            message: describeOllamaSelectionIssue(readiness, draft.baseUrl),
          })
        }
        return
      }

      const ranked = rankOllamaModels(readiness.models, 'balanced')
      const recommended = recommendOllamaModel(readiness.models, 'balanced')
      if (!cancelled) {
        setOllamaSelection({
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
  }, [draft.baseUrl, screen])

  React.useEffect(() => {
    if (screen !== 'select-atomic-chat-model') {
      return
    }

    let cancelled = false
    setAtomicChatSelection({ state: 'loading' })

    void (async () => {
      const readiness = await probeRouteReadiness('atomic-chat', {
        baseUrl: draft.baseUrl,
      })
      if (!readiness) {
        if (!cancelled) {
          setAtomicChatSelection({
            state: 'unavailable',
            message: `Could not load the Atomic Chat readiness probe for ${redactUrlForDisplay(draft.baseUrl)}. Enter the endpoint manually.`,
          })
        }
        return
      }

      if (readiness.state !== 'ready') {
        if (!cancelled) {
          setAtomicChatSelection({
            state: 'unavailable',
            message: describeAtomicChatSelectionIssue(readiness, draft.baseUrl),
          })
        }
        return
      }

      if (!cancelled) {
        setAtomicChatSelection({
          state: 'ready',
          defaultValue: readiness.models[0],
          options: readiness.models.map(model => ({
            label: model,
            value: model,
          })),
        })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [draft.baseUrl, screen])

  function refreshProfiles(): void {
    // Defer sync I/O to next microtask to prevent UI freeze.
    // getProviderProfiles() and getActiveProviderProfile() read config files
    // synchronously, which can block the main thread on Windows (antivirus, disk cache).
    // queueMicrotask ensures the current render completes first.
    if (isRefreshingRef.current) return
    isRefreshingRef.current = true

    queueMicrotask(() => {
      const nextProfiles = getProviderProfiles()
      setProfiles(nextProfiles)
      setActiveProfileId(getActiveProviderProfile()?.id)
      refreshGithubProviderState()
      refreshCodexOAuthCredentialState()
      isRefreshingRef.current = false
    })
  }

  function clearStartupProviderOverrideFromUserSettings(): string | null {
    return clearStartupProviderOverrides()
  }

  function formatWarningsForMessage(warnings: string[]): string {
    const joined = warnings.join('; ')
    return /[.!?]$/.test(joined.trim()) ? joined : `${joined}.`
  }

  function buildCodexOAuthActivationMessage(options: {
    prefix: string
    activationWarning: string | null
    warnings: string[]
  }): string {
    if (options.activationWarning) {
      return `${options.prefix}. Saved for next startup. Warning: ${formatWarningsForMessage(options.warnings)}`
    }

    if (options.warnings.length > 0) {
      return `${options.prefix}. OpenClaude switched to it for this session with warnings: ${formatWarningsForMessage(options.warnings)}`
    }

    return `${options.prefix}. OpenClaude switched to it for this session.`
  }

  function buildXaiOAuthActivationMessage(options: {
    prefix: string
    activationWarning: string | null
    warnings: string[]
  }): string {
    if (options.activationWarning) {
      return `${options.prefix}. Saved for next startup. Warning: ${options.warnings.join('; ')}.`
    }
    if (options.warnings.length > 0) {
      return `${options.prefix}. OpenClaude switched to it for this session with warnings: ${options.warnings.join('; ')}.`
    }
    return `${options.prefix}. OpenClaude switched to it for this session.`
  }

  async function activateXaiOAuthSession(options?: {
    model?: string
  }): Promise<string | null> {
    const stored = await readXaiCredentialsAsync()
    if (!stored?.accessToken || !stored?.refreshToken) {
      return 'stored xAI OAuth credentials could not be loaded'
    }
    const env = buildXaiOAuthProfileEnv({ model: options?.model })
    return applySavedProfileToCurrentSession({
      profileFile: createProfileFile('xai', env),
    })
  }

  async function activateCodexOAuthSession(tokens?: {
    accessToken: string
    refreshToken?: string
    accountId?: string
    idToken?: string
  }): Promise<string | null> {
    const oauthEnv = buildCodexOAuthProfileEnv({
      accessToken: tokens?.accessToken ?? '',
      accountId: tokens?.accountId,
      idToken: tokens?.idToken,
    })

    if (oauthEnv) {
      return applySavedProfileToCurrentSession({
        profileFile: createProfileFile('codex', oauthEnv),
      })
    }

    const storedCredentials = await readCodexCredentialsAsync()
    if (!storedCredentials) {
      return 'stored Codex OAuth credentials could not be loaded'
    }

    const storedEnv = buildCodexOAuthProfileEnv({
      accessToken: storedCredentials.accessToken,
      accountId: storedCredentials.accountId,
      idToken: storedCredentials.idToken,
    })
    if (!storedEnv) {
      return 'stored Codex OAuth credentials are missing a ChatGPT account id'
    }

    return applySavedProfileToCurrentSession({
      profileFile: createProfileFile('codex', storedEnv),
    })
  }

  async function activateSelectedProvider(profileId: string): Promise<void> {
    let providerLabel = 'provider'

    // Set loading state before sync I/O to keep UI responsive
    setIsActivating(true)
    setStatusMessage('Activating provider...')

    try {
      // Defer sync I/O to next microtask - UI renders loading state first.
      // setActiveProviderProfile(), activateGithubProvider(), and
      // clearStartupProviderOverrideFromUserSettings() all perform sync file writes
      // (saveGlobalConfig, saveProfileFile, updateSettingsForSource) which can
      // block the main thread on Windows (antivirus, disk cache, NTFS metadata).
      await new Promise<void>(resolve => queueMicrotask(resolve))

      if (profileId === GITHUB_PROVIDER_ID) {
        providerLabel = GITHUB_PROVIDER_LABEL
        const githubError = activateGithubProvider()
        if (githubError) {
          setErrorMessage(`Could not activate GitHub provider: ${githubError}`)
          setIsActivating(false)
          returnToMenu()
          return
        }

        setAppState(prev => ({
          ...prev,
          mainLoopModel: GITHUB_PROVIDER_DEFAULT_MODEL,
          mainLoopModelForSession: null,
        }))
        refreshProfiles()
        setStatusMessage(`Active provider: ${GITHUB_PROVIDER_LABEL}`)
        setIsActivating(false)
        onDone({
          action: 'activated',
          activeProviderName: GITHUB_PROVIDER_LABEL,
          activeProviderModel: GITHUB_PROVIDER_DEFAULT_MODEL,
          message: `Provider switched to ${GITHUB_PROVIDER_LABEL} (${GITHUB_PROVIDER_DEFAULT_MODEL})`,
        })
        returnToMenu()
        return
      }

      if (profileId === ANTHROPIC_DEFAULT_PROFILE_ID) {
        providerLabel = ANTHROPIC_PROVIDER_LABEL
        // Switch back to built-in Anthropic: clears the managed provider env so
        // it takes effect this session, records the Anthropic sentinel so
        // startup no longer replays a third-party profile, and keeps saved
        // profiles for later re-selection (#1426).
        clearActiveProviderProfile()
        // clearActiveProviderProfile clears the managed provider flags (e.g.
        // CLAUDE_CODE_USE_GITHUB) but not a GitHub Models token hydrated into the
        // session from secure storage. Drop that hydrated token + marker so the
        // built-in Anthropic session does not keep a GitHub credential around,
        // mirroring the GitHub delete path; a user-supplied token is preserved.
        clearHydratedGithubModelsTokenFromEnv(readGithubModelsToken())
        // Clear any startup provider override persisted in user settings
        // (CLAUDE_CODE_USE_OPENAI, OPENAI_BASE_URL, provider API keys, ...) so a
        // restart does not replay the third-party provider. The saved-profile
        // and GitHub activation paths perform the same cleanup; surface any
        // failure as a warning the same way the saved-profile path does.
        const settingsOverrideError = clearStartupProviderOverrideFromUserSettings()
        const anthropicModel = getPrimaryModel(getDefaultMainLoopModelSetting())
        setAppState(prev => ({
          ...prev,
          mainLoopModel: anthropicModel,
          mainLoopModelForSession: null,
        }))
        refreshProfiles()
        setStatusMessage(
          settingsOverrideError
            ? `Active provider: ${ANTHROPIC_PROVIDER_LABEL}. Warning: could not clear startup provider override (${settingsOverrideError}).`
            : `Active provider: ${ANTHROPIC_PROVIDER_LABEL}`,
        )
        setIsActivating(false)
        onDone({
          action: 'activated',
          activeProviderName: ANTHROPIC_PROVIDER_LABEL,
          activeProviderModel: anthropicModel,
          message: settingsOverrideError
            ? `Provider switched to ${ANTHROPIC_PROVIDER_LABEL} (${anthropicModel}). Warning: could not clear startup provider override (${settingsOverrideError}).`
            : `Provider switched to ${ANTHROPIC_PROVIDER_LABEL} (${anthropicModel})`,
        })
        returnToMenu()
        return
      }

      const active = setActiveProviderProfile(profileId)
      if (!active) {
        setErrorMessage('Could not change active provider.')
        setIsActivating(false)
        returnToMenu()
        return
      }

      // Update the session model to the new provider's first model.
      // persistActiveProviderProfileModel (called by onChangeAppState) will
      // not overwrite the multi-model list because it checks if the model
      // is already in the provider's configured model list.
      const newModel = getPrimaryModel(active.model)
      setAppState(prev => ({
        ...prev,
        mainLoopModel: newModel,
        mainLoopModelForSession: null,
      }))
      providerLabel = active.name
      const settingsOverrideError =
        clearStartupProviderOverrideFromUserSettings()
      const isActiveCodexOAuth = isCodexOAuthProfile(
        active,
        storedCodexOAuthProfileId,
      )
      const isActiveXaiOAuth = isXaiOAuthProfile(
        active,
        storedXaiOAuthProfileId,
      )
      const codexActivationWarning = isActiveCodexOAuth
        ? await activateCodexOAuthSession()
        : null
      const xaiActivationWarning = isActiveXaiOAuth
        ? await activateXaiOAuthSession({ model: newModel })
        : null
      const activationWarning = codexActivationWarning ?? xaiActivationWarning

      refreshProfiles()
      const activationMessage = isActiveCodexOAuth
        ? buildCodexOAuthActivationMessage({
            prefix: `Active provider: ${active.name}`,
            activationWarning,
            warnings: [
              activationWarning,
              settingsOverrideError
                ? `could not clear startup provider override (${settingsOverrideError})`
                : null,
            ].filter((warning): warning is string => Boolean(warning)),
          })
        : isActiveXaiOAuth
          ? buildXaiOAuthActivationMessage({
              prefix: `Active provider: ${active.name}`,
              activationWarning,
              warnings: [
                activationWarning,
                settingsOverrideError
                  ? `could not clear startup provider override (${settingsOverrideError})`
                  : null,
              ].filter((warning): warning is string => Boolean(warning)),
            })
          : settingsOverrideError
            ? `Active provider: ${active.name}. Warning: could not clear startup provider override (${settingsOverrideError}).`
            : `Active provider: ${active.name}`
      setStatusMessage(activationMessage)
      setIsActivating(false)
      onDone({
        action: 'activated',
        activeProfileId: active.id,
        activeProviderName: active.name,
        activeProviderModel: newModel,
        message: `Provider switched to ${active.name} (${newModel})`,
      })
      returnToMenu()
    } catch (error) {
      refreshProfiles()
      setStatusMessage(undefined)
      setIsActivating(false)
      const detail = error instanceof Error ? error.message : String(error)
      setErrorMessage(`Could not finish activating ${providerLabel}: ${detail}`)
      returnToMenu()
    }
  }

  function returnToMenu(): void {
    setMenuFocusValue('done')
    setScreen('menu')
  }

  function closeWithCancelled(message: string): void {
    aimlapiAbortRef.current?.abort()
    aimlapiAbortRef.current = null
    onDone({
      action: 'cancelled',
      message:
        message === 'Provider manager closed' && statusMessage
          ? statusMessage
          : message,
    })
  }

  function activateGithubProvider(): string | null {
    const { error } = updateSettingsForSource('userSettings', {
      env: {
        CLAUDE_CODE_USE_GITHUB: '1',
        OPENAI_MODEL: GITHUB_PROVIDER_DEFAULT_MODEL,
        // `undefined` instructs the merge to clear these keys from saved
        // settings. EnvironmentVariablesSchema coerces to string, so we route
        // through `unknown` instead of `any` for the literal assignment.
        OPENAI_API_KEYS: undefined as unknown as string,
        OPENAI_API_KEY: undefined as unknown as string,
        OPENAI_ORG: undefined as unknown as string,
        OPENAI_PROJECT: undefined as unknown as string,
        OPENAI_ORGANIZATION: undefined as unknown as string,
        OPENAI_BASE_URL: undefined as unknown as string,
        OPENAI_API_BASE: undefined as unknown as string,
        CLAUDE_CODE_USE_OPENAI: undefined as unknown as string,
        CLAUDE_CODE_USE_GEMINI: undefined as unknown as string,
        CLAUDE_CODE_USE_BEDROCK: undefined as unknown as string,
        CLAUDE_CODE_USE_VERTEX: undefined as unknown as string,
        CLAUDE_CODE_USE_FOUNDRY: undefined as unknown as string,
      },
    })
    if (error) {
      return error.message
    }

    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    process.env.OPENAI_MODEL = GITHUB_PROVIDER_DEFAULT_MODEL
    delete process.env.OPENAI_API_KEYS
    delete process.env.OPENAI_API_KEY
    delete process.env.OPENAI_ORG
    delete process.env.OPENAI_PROJECT
    delete process.env.OPENAI_ORGANIZATION
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_BASE
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.CLAUDE_CODE_USE_GEMINI
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY
    delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
    delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID
    delete process.env[GITHUB_MODELS_HYDRATED_ENV_MARKER]

    hydrateGithubModelsTokenFromSecureStorage()
    return null
  }

  function deleteGithubProvider(): string | null {
    const storedTokenBeforeClear = readGithubModelsToken()?.trim()
    const cleared = clearGithubModelsToken()
    if (!cleared.success) {
      return cleared.warning ?? 'Could not clear GitHub credentials.'
    }

    const { error } = updateSettingsForSource('userSettings', {
      env: {
        CLAUDE_CODE_USE_GITHUB: undefined as unknown as string,
        OPENAI_MODEL: undefined as unknown as string,
        OPENAI_BASE_URL: undefined as unknown as string,
        OPENAI_API_BASE: undefined as unknown as string,
      },
    })
    if (error) {
      return error.message
    }

    delete process.env.CLAUDE_CODE_USE_GITHUB
    // Undo any GitHub Models token hydrated into the session from secure
    // storage and drop the marker. Use the shared helper so both hydration
    // modes are reverted: GITHUB_TOKEN and the copilot_key blob's
    // GITHUB_COPILOT_KEY. The old hand-rolled cleanup here only cleared
    // GITHUB_TOKEN, leaving a hydrated Copilot key behind after the marker was
    // removed. A user-supplied token is preserved.
    clearHydratedGithubModelsTokenFromEnv(storedTokenBeforeClear)
    delete process.env.OPENAI_MODEL
    delete process.env.OPENAI_API_KEYS
    delete process.env.OPENAI_API_KEY
    delete process.env.OPENAI_ORG
    delete process.env.OPENAI_PROJECT
    delete process.env.OPENAI_ORGANIZATION
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_BASE

    // Restore active provider profile immediately when one exists.
    applyActiveProviderProfileFromConfig()

    return null
  }

  function startCreateFromPreset(preset: ProviderPreset): void {
    const defaults = getProviderPresetDefaults(preset)
    const provider = defaults.provider ?? 'openai'
    const nextDraft = {
      name: defaults.name,
      baseUrl:
        preset === 'aimlapi'
          ? resolveEndpoints().inferenceBaseUrl
          : defaults.baseUrl,
      model: defaults.model,
      apiKey: defaults.apiKey ?? '',
      apiFormat: preset === 'custom' ? 'auto' : 'chat_completions',
      authHeader: '',
      authHeaderValue: '',
      customHeaders: '',
    }
    setEditingProfileId(null)
    setDraftProvider(provider)
    setDraft(nextDraft)
    setPresetRequiresApiKey(defaults.requiresApiKey)
    setAimlapiTopupEmail('')
    setAimlapiTopupAmountUsd(String(DEFAULT_AMOUNT_USD_MINOR / 100))
    aimlapiAbortRef.current?.abort()
    aimlapiAbortRef.current = null
    setAimlapiSignInCode('')
    setAimlapiSessionToken('')
    setAimlapiIssuedKey('')
    setAimlapiIssuedKeyId('')
    setAimlapiTopupByKey(false)
    aimlapiTopupPaidRef.current = false
    // Fresh flow entry: no open checkout to warn about yet. Drop the tracked
    // intent too (in-memory only — do NOT clear its on-disk receipt, which may be
    // a resumable paid checkout) so a later resetAimlapiCheckoutIntent can never
    // clear a previous flow's record against a stale payment id.
    aimlapiOpenedCheckoutRef.current = null
    aimlapiAbandonAckRef.current = false
    aimlapiPersistedIntentRef.current = null
    // A confirmation armed in an earlier flow (e.g. the user confirmed an
    // email switch, then backed out before that claim ever consumed the
    // flag) must not authorize THIS flow's first claim — it was never
    // confirmed against this flow's receipt.
    aimlapiForceAbandonExistingRef.current = false
    setAimlapiResumeSessionToken('')
    setAimlapiExistingProfileId(null)
    setAimlapiExistingUsesEnv(false)
    setAimlapiInferenceBaseUrl(
      preset === 'aimlapi' ? nextDraft.baseUrl : resolveEndpoints().inferenceBaseUrl,
    )
    setAimlapiNewAccount(false)
    setAimlapiAutoTopUp(true)
    setAimlapiTopupStatus(undefined)
    setAimlapiTopupDetail(undefined)
    setAimlapiDoneKind('ready')
    setFormStepIndex(0)
    setCursorOffset(nextDraft.name.length)
    setErrorMessage(undefined)

    if (preset === 'aimlapi' && mode === 'manage' && startExistingAimlapi(nextDraft)) {
      return
    }

    if (preset === 'ollama') {
      setOllamaSelection({ state: 'loading' })
      setScreen('select-ollama-model')
      return
    }

    if (preset === 'atomic-chat') {
      setAtomicChatSelection({ state: 'loading' })
      setScreen('select-atomic-chat-model')
      return
    }

    if (
      preset === 'custom' ||
      preset === 'custom-anthropic' ||
      !canUseStreamlinedPresetFlow(nextDraft)
    ) {
      setScreen('form')
      return
    }

    setCursorOffset(nextDraft.model.length)
    setScreen('preset-model')
  }

  function startEditProfile(profileId: string): void {
    const existing = profiles.find(profile => profile.id === profileId)
    if (!existing) {
      return
    }

    const nextDraft = toDraft(existing)
    setEditingProfileId(profileId)
    setDraftProvider(existing.provider ?? 'openai')
    setDraft(nextDraft)
    setPresetRequiresApiKey(false)
    setFormStepIndex(0)
    setCursorOffset(nextDraft.name.length)
    setErrorMessage(undefined)
    setScreen('form')
  }

  function persistDraft(
    nextDraft: ProviderDraft = draft,
    provider: ProviderProfile['provider'] = draftProvider,
    profileId: string | null = editingProfileId,
    options: { deferNavigation?: boolean; onSaved?: () => void } = {},
  ): void {
    if (
      provider === 'custom-anthropic' &&
      (isSetupPlaceholder(nextDraft.baseUrl) ||
        isFirstPartyAnthropicBaseUrlForEnv({
          ANTHROPIC_BASE_URL: nextDraft.baseUrl,
          USER_TYPE: process.env.USER_TYPE,
        }))
    ) {
      setErrorMessage('Base URL must be a real Anthropic-compatible endpoint.')
      return
    }
    const routeId = resolveProviderEditorRouteId(provider, nextDraft.baseUrl)
    if (routeId === 'commandcode') {
      const modelError = parseModelList(nextDraft.model)
        .map(model => getCommandcodeChatCompletionsModelError(model))
        .find((error): error is string => error !== null)
      if (modelError) {
        setErrorMessage(modelError)
        return
      }
    }
    const supportsApiFormat = routeSupportsApiFormatSelection(routeId)
    const showsAuthHeader = routeShowsAuthHeader(routeId)
    const showsAuthHeaderValue = routeShowsAuthHeaderValue(routeId)
    const showsCustomHeaders = routeShowsCustomHeaders(routeId)
    const parsedCustomHeaders = parseProfileCustomHeadersInput(
      showsCustomHeaders ? nextDraft.customHeaders : '',
    )
    if (parsedCustomHeaders.error) {
      setErrorMessage(parsedCustomHeaders.error)
      return
    }

    const requestedResponses =
      supportsApiFormat && (nextDraft.apiFormat === 'responses' || nextDraft.apiFormat === 'responses_compat')
    const selectedApiFormat =
      !supportsApiFormat
        ? 'chat_completions'
        : nextDraft.apiFormat === 'auto'
          ? undefined
        : requestedResponses && !routeSupportsResponsesModel(routeId, nextDraft.model)
          ? 'chat_completions'
          : nextDraft.apiFormat as OpenAICompatibleApiFormat
    const payload: ProviderProfileInput = {
      provider,
      name: nextDraft.name,
      baseUrl: nextDraft.baseUrl,
      model: nextDraft.model,
      apiKey: nextDraft.apiKey,
      apiFormat: selectedApiFormat,
      authHeader:
        showsAuthHeader && nextDraft.authHeader
          ? nextDraft.authHeader
          : undefined,
      authScheme:
        showsAuthHeader && nextDraft.authHeader
          ? (nextDraft.authHeader.toLowerCase() === 'authorization' ? 'bearer' : 'raw')
          : undefined,
      authHeaderValue:
        showsAuthHeaderValue && nextDraft.authHeaderValue
          ? nextDraft.authHeaderValue
          : undefined,
      customHeaders:
        showsCustomHeaders &&
        Object.keys(parsedCustomHeaders.headers).length > 0
          ? parsedCustomHeaders.headers
          : undefined,
    }

    const saved = profileId
      ? updateProviderProfile(profileId, payload)
      : addProviderProfile(payload, { makeActive: true })

    if (!saved) {
      setErrorMessage('Could not save provider. Fill all required fields.')
      return
    }

    const isActiveSavedProfile = getActiveProviderProfile()?.id === saved.id
    if (isActiveSavedProfile) {
      setAppState(prev => ({
        ...prev,
        mainLoopModel: getPrimaryModel(saved.model),
        mainLoopModelForSession: null,
      }))
    }
    const settingsOverrideError = isActiveSavedProfile
      ? clearStartupProviderOverrideFromUserSettings()
      : null

    refreshProfiles()
    const successMessage =
      profileId
        ? `Updated provider: ${saved.name}`
        : `Added provider: ${saved.name} (now active)`
    const adjustedApiFormat =
      requestedResponses && saved.apiFormat !== 'responses' && saved.apiFormat !== 'responses_compat'
    const routeLabel =
      getRouteDescriptor(routeId)?.label ?? getRouteProviderTypeLabel(routeId)
    const responseModelSetLabel = getResponsesApiModelSetLabel(routeId)
    const apiFormatMessage = adjustedApiFormat
      ? `. ${routeLabel} only supports the Responses API for ${responseModelSetLabel}, so this profile was saved using Chat Completions.`
      : ''
    const finalSuccessMessage = `${successMessage}${apiFormatMessage}`
    setStatusMessage(
      settingsOverrideError
        ? `${finalSuccessMessage}. Warning: could not clear startup provider override (${settingsOverrideError}).`
        : finalSuccessMessage,
    )

    if (options.deferNavigation) {
      options.onSaved?.()
      return
    }

    if (mode === 'first-run') {
      onDone({
        action: 'saved',
        activeProfileId: saved.id,
        message: `Provider configured: ${saved.name}${apiFormatMessage}`,
      })
      return
    }

    setEditingProfileId(null)
    setFormStepIndex(0)
    setErrorMessage(undefined)
    returnToMenu()
  }

  function applyPresetApiFormat(
    nextDraft: ProviderDraft,
    provider: ProviderProfile['provider'],
  ): ProviderDraft {
    const routeId = resolveProviderEditorRouteId(provider, nextDraft.baseUrl)
    const preferredResponsesMode = nextDraft.apiFormat === 'responses_compat' ? 'responses_compat' : 'responses'
    const apiFormat =
      routeSupportsApiFormatSelection(routeId) &&
      routeSupportsResponsesModel(routeId, nextDraft.model)
        ? preferredResponsesMode
        : 'chat_completions'

    return {
      ...nextDraft,
      apiFormat,
    }
  }

  function renderAtomicChatSelection(): React.ReactNode {
    if (
      atomicChatSelection.state === 'loading' ||
      atomicChatSelection.state === 'idle'
    ) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="remember" bold>
            Checking Atomic Chat
          </Text>
          <Text dimColor>Looking for loaded Atomic Chat models...</Text>
        </Box>
      )
    }

    if (atomicChatSelection.state === 'unavailable') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="remember" bold>
            Atomic Chat setup
          </Text>
          <Text dimColor>{atomicChatSelection.message}</Text>
          <Select
            options={[
              {
                value: 'manual',
                label: 'Enter manually',
                description: 'Fill in the base URL and model yourself',
              },
              {
                value: 'back',
                label: 'Back',
                description: 'Choose another provider preset',
              },
            ]}
            onChange={(value: string) => {
              if (value === 'manual') {
                setFormStepIndex(0)
                setCursorOffset(draft.name.length)
                setScreen('form')
                return
              }
              setScreen('select-preset')
            }}
            onCancel={() => setScreen('select-preset')}
            visibleOptionCount={2}
          />
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          Choose an Atomic Chat model
        </Text>
        <Text dimColor>
          Pick one of the models loaded in Atomic Chat to save into a local
          provider profile.
        </Text>
        <Select
          options={atomicChatSelection.options}
          defaultValue={atomicChatSelection.defaultValue}
          defaultFocusValue={atomicChatSelection.defaultValue}
          inlineDescriptions
          visibleOptionCount={Math.min(8, atomicChatSelection.options.length)}
          onChange={(value: string) => {
            const nextDraft = {
              ...draft,
              model: value,
            }
            setDraft(nextDraft)
            persistDraft(nextDraft)
          }}
          onCancel={() => setScreen('select-preset')}
        />
      </Box>
    )
  }

  function renderOllamaSelection(): React.ReactNode {
    if (ollamaSelection.state === 'loading' || ollamaSelection.state === 'idle') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="remember" bold>
            Checking Ollama
          </Text>
          <Text dimColor>Looking for installed Ollama models...</Text>
        </Box>
      )
    }

    if (ollamaSelection.state === 'unavailable') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="remember" bold>
            Ollama setup
          </Text>
          <Text dimColor>{ollamaSelection.message}</Text>
          <Select
            options={[
              {
                value: 'manual',
                label: 'Enter manually',
                description: 'Fill in the base URL and model yourself',
              },
              {
                value: 'back',
                label: 'Back',
                description: 'Choose another provider preset',
              },
            ]}
            onChange={(value: string) => {
              if (value === 'manual') {
                setFormStepIndex(0)
                setCursorOffset(draft.name.length)
                setScreen('form')
                return
              }
              setScreen('select-preset')
            }}
            onCancel={() => setScreen('select-preset')}
            visibleOptionCount={2}
          />
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          Choose an Ollama model
        </Text>
        <Text dimColor>
          Pick one of the installed Ollama models to save into a local provider
          profile.
        </Text>
        <Select
          options={ollamaSelection.options}
          defaultValue={ollamaSelection.defaultValue}
          defaultFocusValue={ollamaSelection.defaultValue}
          inlineDescriptions
          visibleOptionCount={Math.min(8, ollamaSelection.options.length)}
          onChange={(value: string) => {
            const nextDraft = {
              ...draft,
              model: value,
            }
            setDraft(nextDraft)
            persistDraft(nextDraft)
          }}
          onCancel={() => setScreen('select-preset')}
        />
      </Box>
    )
  }

  function handleFormSubmit(value: string): void {
    const trimmed = value.trim()

    if (!displayStep.optional && trimmed.length === 0) {
      setErrorMessage(`${displayStep.label} is required.`)
      return
    }

    const nextDraft = {
      ...draft,
      [currentStepKey]: trimmed,
    }

    setDraft(nextDraft)
    setErrorMessage(undefined)

    if (formStepIndex < formSteps.length - 1) {
      const nextIndex = formStepIndex + 1
      const nextKey = formSteps[nextIndex]?.key ?? 'name'
      setFormStepIndex(nextIndex)
      setCursorOffset(nextDraft[nextKey].length)
      return
    }

    persistDraft(nextDraft)
  }

  function handleBackFromForm(): void {
    setErrorMessage(undefined)

    if (formStepIndex > 0) {
      const nextIndex = formStepIndex - 1
      const nextKey = formSteps[nextIndex]?.key ?? 'name'
      setFormStepIndex(nextIndex)
      setCursorOffset(draft[nextKey].length)
      return
    }

    if (mode === 'first-run') {
      setScreen('select-preset')
      return
    }

    returnToMenu()
  }

  useKeybinding('confirm:no', handleBackFromForm, {
    context: 'Settings',
    isActive: screen === 'form',
  })

  function handleBackFromPresetModel(): void {
    setErrorMessage(undefined)
    // A by-key top-up payment already settled and its receipt was persisted
    // (checkoutState.settled/apiKey) before routing here to confirm the
    // model — Back cannot "cancel" a payment that already cleared. Complete
    // the pending profile update with the current model instead of
    // abandoning it: leaving without saving strands the settled receipt,
    // which then refuses any later, differently-amounted top-up until it is
    // recovered (by re-running this exact amount) or manually deleted.
    if (
      aimlapiTopupPaidRef.current &&
      aimlapiPersistedIntentRef.current &&
      (aimlapiExistingProfileId || aimlapiExistingUsesEnv)
    ) {
      persistExistingAimlapi()
      return
    }
    setScreen('select-preset')
  }

  useKeybinding('confirm:no', handleBackFromPresetModel, {
    context: 'Settings',
    isActive: screen === 'preset-model',
  })

  function handleBackFromPresetApiKey(): void {
    if (draftProvider === 'aimlapi') {
      aimlapiAbortRef.current?.abort()
      aimlapiAbortRef.current = null
      setIsAimlapiKeyValidating(false)
    }
    setErrorMessage(undefined)
    setCursorOffset(draft.model.length)
    setScreen(draftProvider === 'aimlapi' ? 'aimlapi-api-key-choice' : 'preset-model')
  }

  useKeybinding('confirm:no', handleBackFromPresetApiKey, {
    context: 'Settings',
    isActive: screen === 'preset-api-key',
  })

  function handleBackFromAimlapiKeyChoice(): void {
    setErrorMessage(undefined)
    setCursorOffset(draft.model.length)
    setScreen('preset-model')
  }

  useKeybinding('confirm:no', handleBackFromAimlapiKeyChoice, {
    context: 'Settings',
    isActive: screen === 'aimlapi-api-key-choice',
  })

  function handleBackFromAimlapiConfigured(): void {
    aimlapiAbortRef.current?.abort()
    aimlapiAbortRef.current = null
    setIsAimlapiKeyValidating(false)
    setErrorMessage(undefined)
    setScreen('select-preset')
  }

  useKeybinding('confirm:no', handleBackFromAimlapiConfigured, {
    context: 'Settings',
    // The balance check (and, past it, the stale-receipt reconcile) has no
    // abort-and-stop-the-underlying-work guarantee for the reconcile part —
    // aborting only stops THIS flow from acting on the result. Esc must stay
    // inactive throughout so a user can't escape to select-preset and start
    // a competing top-up for the same credential while that reconcile is
    // still running unattended.
    isActive: screen === 'aimlapi-configured' && !isAimlapiKeyValidating,
  })

  function handleBackFromAimlapiTopupEmail(): void {
    aimlapiAbortRef.current?.abort()
    setErrorMessage(undefined)
    setCursorOffset(0)
    setScreen('aimlapi-api-key-choice')
  }

  useKeybinding('confirm:no', handleBackFromAimlapiTopupEmail, {
    context: 'Settings',
    isActive: screen === 'aimlapi-topup-email',
  })

  function handleBackFromAimlapiTopupAmount(): void {
    // Cancel a startAimlapiTopup invocation that may still be in its preflight
    // (claiming/saving checkout state can contend for the state lock for up
    // to 15s before the screen would otherwise change) — without this, that
    // stale invocation can still resolve after navigating away and barge
    // back onto the progress screen to start provisioning.
    aimlapiAbortRef.current?.abort()
    setErrorMessage(undefined)
    setScreen(aimlapiNewAccount ? 'aimlapi-topup-email' : 'aimlapi-low-balance')
  }

  useKeybinding('confirm:no', handleBackFromAimlapiTopupAmount, {
    context: 'Settings',
    isActive: screen === 'aimlapi-topup-amount',
  })

  function handleBackFromAimlapiSignInCode(): void {
    aimlapiAbortRef.current?.abort()
    setErrorMessage(undefined)
    setAimlapiSignInCode('')
    setCursorOffset(aimlapiTopupEmail.length)
    setScreen('aimlapi-topup-email')
  }

  useKeybinding('confirm:no', handleBackFromAimlapiSignInCode, {
    context: 'Settings',
    isActive: screen === 'aimlapi-signin-code',
  })

  function handleBackFromAimlapiLowBalance(): void {
    setErrorMessage(undefined)
    setScreen(
      aimlapiExistingProfileId || aimlapiExistingUsesEnv
        ? 'aimlapi-configured'
        : 'aimlapi-api-key-choice',
    )
  }

  useKeybinding('confirm:no', handleBackFromAimlapiLowBalance, {
    context: 'Settings',
    isActive: screen === 'aimlapi-low-balance',
  })

  function handleCancelAimlapiTopupProgress(): void {
    aimlapiAbortRef.current?.abort()
    aimlapiAbortRef.current = null
    setErrorMessage(undefined)
    setScreen(
      aimlapiTopupStatus === 'checking-account' ||
        aimlapiTopupStatus === 'sending-code' ||
        aimlapiTopupStatus === 'creating-account'
        ? 'aimlapi-topup-email'
        : aimlapiTopupStatus === 'verifying-code' ||
            aimlapiTopupStatus === 'creating-key'
          ? 'aimlapi-signin-code'
          : 'aimlapi-topup-amount',
    )
  }

  useKeybinding('confirm:no', handleCancelAimlapiTopupProgress, {
    context: 'Settings',
    isActive: screen === 'aimlapi-topup-progress',
  })

  function finishAimlapiDone(): void {
    if (mode === 'first-run') {
      const active = getActiveProviderProfile()
      onDone({
        action: 'saved',
        activeProfileId: active?.id,
        activeProviderName: active?.name,
        activeProviderModel: active ? getPrimaryModel(active.model) : undefined,
        message: `Provider configured: ${active?.name ?? 'aimlapi.com'}`,
      })
      return
    }
    returnToMenu()
  }

  useKeybinding('confirm:yes', finishAimlapiDone, {
    context: 'Confirmation',
    isActive: screen === 'aimlapi-done',
  })

  useKeybinding('confirm:no', finishAimlapiDone, {
    context: 'Confirmation',
    isActive: screen === 'aimlapi-done',
  })

  // xAI OAuth setup renders a TextInput for the manual-code recovery
  // path, which registers its own useInput listener. The child-component
  // useKeybinding inside XaiOAuthSetup ends up racing the input handler
  // and can lose. Register Esc at the top level — same pattern that
  // makes Esc work on preset-api-key (which also has a TextInput).
  function handleBackFromXaiOAuth(): void {
    setErrorMessage(undefined)
    setScreen('select-preset')
  }

  useKeybinding('confirm:no', handleBackFromXaiOAuth, {
    context: 'Settings',
    isActive: screen === 'xai-oauth',
  })

  function renderPresetSelection(): React.ReactNode {
    const canUseCodexOAuth = !isBareMode()
    const canUseXaiOAuth = !isBareMode()
    const options: OptionWithDescription<string>[] = ORDERED_PROVIDER_PRESETS.map(preset => {
      const metadata = getProviderPresetUiMetadata(preset)
      return {
        value: preset,
        label: getPresetLabel(preset, metadata.label, { badge: metadata.badge }),
        description: metadata.description,
      }
    })

    // Insert after DeepSeek so the OAuth options keep their established
    // position in the picker regardless of how the preset list grows; if
    // the anchor ever disappears, append instead of floating to the top.
    const deepseekIndex = options.findIndex(
      option => option.value === 'deepseek',
    )
    let oauthInsertIndex =
      deepseekIndex >= 0 ? deepseekIndex + 1 : options.length
    if (canUseCodexOAuth) {
      options.splice(oauthInsertIndex, 0, {
        value: 'codex-oauth',
        label: (
          <Text>
            <Text>Codex OAuth </Text>
            <Text color="success" bold>★ Recommended</Text>
          </Text>
        ),
        description:
          'Sign in with ChatGPT in your browser and store Codex credentials securely',
      })
      oauthInsertIndex += 1
    }

    if (canUseXaiOAuth) {
      // Place xAI OAuth directly under Codex OAuth so both browser-sign-in
      // options group together visually.
      options.splice(oauthInsertIndex, 0, {
        value: 'xai-oauth',
        label: 'xAI OAuth (Grok)',
        description:
          'Sign in with your xAI account in the browser and store credentials securely',
      })
    }

    if (mode === 'first-run') {
      options.push({
        value: 'skip',
        label: 'Skip for now',
        description: 'Continue with current defaults',
      })
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          {mode === 'first-run' ? 'Set up provider' : 'Choose provider preset'}
        </Text>
        <Text dimColor>
          Pick a preset, then complete the details it needs.
        </Text>
        <Select
          options={options}
          onChange={(value: string) => {
            if (value === 'skip') {
              closeWithCancelled('Provider setup skipped')
              return
            }
            if (value === 'codex-oauth') {
              setScreen('codex-oauth')
              return
            }
            if (value === 'xai-oauth') {
              setScreen('xai-oauth')
              return
            }
            startCreateFromPreset(value as ProviderPreset)
          }}
          onCancel={() => {
            if (mode === 'first-run') {
              closeWithCancelled('Provider setup skipped')
              return
            }
            returnToMenu()
          }}
          visibleOptionCount={Math.min(13, options.length)}
        />
      </Box>
    )
  }

  function renderForm(): React.ReactNode {
    const editorRouteId = resolveProviderEditorRouteId(
      draftProvider,
      draft.baseUrl,
    )
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          {editingProfileId ? 'Edit provider profile' : 'Create provider profile'}
        </Text>
        <Text dimColor>{displayStep.helpText}</Text>
        <Text dimColor>
          Provider type:{' '}
          {getRouteProviderTypeLabel(editorRouteId)}
        </Text>
        {routeSupportsCustomHeaders(editorRouteId) ? (
          <Text dimColor>
            Advanced: this provider supports custom request headers when you
            need them.
          </Text>
        ) : null}
        <Text dimColor>
          Step {formStepIndex + 1} of {formSteps.length}: {displayStep.label}
        </Text>
        {currentStepKey === 'apiFormat' ? (
          <Select
            options={[
              {
                value: 'auto',
                label: 'Automatic',
                description: 'Use the provider and model defaults',
              },
              {
                value: 'chat_completions',
                label: 'Chat Completions',
                description: 'Use /chat/completions for broad OpenAI-compatible support',
              },
              {
                value: 'responses',
                label: 'Responses',
                description: 'Use /responses for providers that support the Responses API',
              },
              {
                value: 'responses_compat',
                label: 'Responses (Compat)',
                description: 'Use /responses with legacy text chunks for strict gateways',
              },
            ]}
            defaultValue={
              currentValue === 'responses_compat' ? 'responses_compat' : currentValue === 'responses' ? 'responses' : currentValue === 'chat_completions' ? 'chat_completions' : 'auto'
            }
            defaultFocusValue={
              currentValue === 'responses_compat' ? 'responses_compat' : currentValue === 'responses' ? 'responses' : currentValue === 'chat_completions' ? 'chat_completions' : 'auto'
            }
            onChange={(value: string) => handleFormSubmit(value)}
            onCancel={handleBackFromForm}
            visibleOptionCount={4}
          />
        ) : (
          <Box flexDirection="row" gap={1}>
            <Text>{figures.pointer}</Text>
            <TextInput
              value={currentValue}
              onChange={value =>
                setDraft(prev => ({
                  ...prev,
                  [currentStepKey]: value,
                }))
              }
              onSubmit={handleFormSubmit}
              focus={true}
              showCursor={true}
              placeholder={`${displayStep.placeholder}${figures.ellipsis}`}
              mask={
                currentStepKey === 'apiKey' ||
                currentStepKey === 'authHeaderValue'
                  ? '*'
                  : undefined
              }
              columns={inputColumns}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
            />
          </Box>
        )}
        {errorMessage && <Text color="error">{errorMessage}</Text>}
        <Text dimColor>
          Press Enter to continue. Press Esc to go back.
        </Text>
      </Box>
    )
  }

  function renderPresetModel(): React.ReactNode {
    const needsApiKey = presetRequiresApiKey && !draft.apiKey.trim()

    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          Create provider profile
        </Text>
        <Text dimColor>
          Choose the default model for {draft.name}. Endpoint and advanced
          details are already configured by the preset.
        </Text>
        <Text dimColor>
          Provider type:{' '}
          {getRouteProviderTypeLabel(resolveProfileRoute(draftProvider).routeId)}
        </Text>
        <Text dimColor>
          Step 1 of {needsApiKey ? 2 : 1}: Default model
        </Text>
        <Box flexDirection="row" gap={1}>
          <Text>{figures.pointer}</Text>
          <TextInput
            value={draft.model}
            onChange={value =>
              setDraft(prev => ({
                ...prev,
                model: value,
              }))
            }
            onSubmit={value => {
              const model = value.trim()
              if (!model) {
                setErrorMessage('Default model is required.')
                return
              }

              const nextDraft = applyPresetApiFormat(
                {
                  ...draft,
                  model,
                },
                draftProvider,
              )
              setDraft(nextDraft)
              setErrorMessage(undefined)

              if (draftProvider === 'aimlapi') {
                // An already-resolved existing credential (saved profile or an
                // ambient env key adopted earlier, e.g. after a top-up) must
                // complete through persistExistingAimlapi so the paid-completion
                // path (aimlapiTopupPaidRef) is honored, instead of being
                // re-detected into the plain "ready" flow below.
                if (aimlapiExistingProfileId || aimlapiExistingUsesEnv) {
                  persistExistingAimlapi(nextDraft.model)
                  return
                }
                const envKey = resolveRouteCredentialValue({
                  routeId: 'aimlapi',
                  baseUrl: nextDraft.baseUrl,
                })?.trim()
                if (
                  mode === 'first-run' &&
                  envKey &&
                  isCanonicalAimlapiInferenceBaseUrl(nextDraft.baseUrl)
                ) {
                  setAimlapiIssuedKey(envKey)
                  setAimlapiExistingUsesEnv(true)
                  void validateAndPersistAimlapiKey(
                    envKey,
                    nextDraft.baseUrl,
                    nextDraft.model,
                    { preserveEnv: true },
                  )
                  return
                }
                if (mode === 'manage' && startExistingAimlapi(nextDraft)) {
                  return
                }
              }

              if (needsApiKey) {
                setCursorOffset(0)
                setScreen(
                  draftProvider === 'aimlapi'
                    ? 'aimlapi-api-key-choice'
                    : 'preset-api-key',
                )
                return
              }

              persistDraft(nextDraft, draftProvider, null)
            }}
            focus={true}
            showCursor={true}
            placeholder={`Enter model${figures.ellipsis}`}
            columns={inputColumns}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
          />
        </Box>
        {errorMessage && <Text color="error">{errorMessage}</Text>}
        <Text dimColor>
          Press Enter to continue. Press Esc to go back.
        </Text>
      </Box>
    )
  }

  function renderPresetApiKey(): React.ReactNode {
    const submitApiKey = (value: string): void => {
      const apiKey = value.trim()
      if (!apiKey) {
        setErrorMessage(`API key is required for ${draft.name}.`)
        return
      }

      const nextDraft = applyPresetApiFormat(
        {
          ...draft,
          apiKey,
        },
        draftProvider,
      )
      setDraft(nextDraft)
      setErrorMessage(undefined)
      if (draftProvider === 'aimlapi') {
        void validateAndPersistAimlapiKey(apiKey, nextDraft.baseUrl, nextDraft.model)
        return
      }
      persistDraft(nextDraft, draftProvider, null)
    }

    if (draftProvider === 'aimlapi') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="remember" bold>
            {AIMLAPI_MESSAGES.apiKeyInputPrompt}
          </Text>
          <Text dimColor>{AIMLAPI_MESSAGES.apiKeyHiddenHint}</Text>
          <Box flexDirection="row">
            <Text>API key: </Text>
            <TextInput
              value={draft.apiKey}
              onChange={value =>
                setDraft(prev => ({
                  ...prev,
                  apiKey: value,
                }))
              }
              onSubmit={submitApiKey}
              focus={!isAimlapiKeyValidating}
              showCursor={!isAimlapiKeyValidating}
              placeholder={`Paste your key${figures.ellipsis}`}
              mask="*"
              columns={inputColumns}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
            />
          </Box>
          {isAimlapiKeyValidating ? <Spinner /> : null}
          {errorMessage && <Text color="error">{errorMessage}</Text>}
          <Text dimColor>
            Press Enter to save. Press Esc to go back.
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          Create provider profile
        </Text>
        <Text dimColor>
          Enter the API key for {draft.name}. Other preset details are already configured.
        </Text>
        <Text dimColor>
          Provider type:{' '}
          {getRouteProviderTypeLabel(resolveProfileRoute(draftProvider).routeId)}
        </Text>
        <Text dimColor>Step 2 of 2: API key</Text>
        <Box flexDirection="row" gap={1}>
          <Text>{figures.pointer}</Text>
          <TextInput
            value={draft.apiKey}
            onChange={value =>
              setDraft(prev => ({
                ...prev,
                apiKey: value,
              }))
            }
            onSubmit={submitApiKey}
            focus={true}
            showCursor={true}
            placeholder={`Enter API key${figures.ellipsis}`}
            mask="*"
            columns={inputColumns}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
          />
        </Box>
        {errorMessage && <Text color="error">{errorMessage}</Text>}
        <Text dimColor>
          Press Enter to save. Press Esc to go back.
        </Text>
      </Box>
    )
  }

  async function validateAndPersistAimlapiKey(
    apiKey: string,
    baseUrl: string,
    model: string,
    options: { preserveEnv?: boolean } = {},
  ): Promise<void> {
    aimlapiAbortRef.current?.abort()
    const controller = new AbortController()
    aimlapiAbortRef.current = controller
    setIsAimlapiKeyValidating(true)
    setErrorMessage(undefined)

    try {
      const balance = await validateAimlapiApiKey(
        apiKey,
        controller.signal,
        baseUrl,
      )
      if (controller.signal.aborted) return
      if (balance.lowBalance) {
        setAimlapiIssuedKey(apiKey.trim())
        setAimlapiIssuedKeyId('')
        setAimlapiTopupByKey(true)
        setAimlapiExistingUsesEnv(options.preserveEnv === true)
        // Carry the endpoint this key was actually validated against into the
        // top-up flow — without this, a non-canonical baseUrl here (e.g. a
        // manually entered key against an overridden AIMLAPI_INFERENCE_URL)
        // leaves aimlapiInferenceBaseUrl at its stale default, so the later
        // by-key top-up and profile save would charge/persist against the
        // wrong endpoint.
        setAimlapiInferenceBaseUrl(baseUrl)
        setIsAimlapiKeyValidating(false)
        setScreen('aimlapi-low-balance')
        return
      }
      persistAimlapiKey(apiKey, baseUrl, model, 'ready', options)
    } catch (error) {
      if (controller.signal.aborted) return
      if (options.preserveEnv) {
        // Validation failed for the ambient env key: drop the adoption markers so
        // the next Enter re-validates instead of short-circuiting into persisting
        // the unvalidated key.
        setAimlapiExistingUsesEnv(false)
        setAimlapiIssuedKey('')
      }
      const status = aimlapiApiErrorStatus(error)
      if (status === 401 || status === 403) {
        setDraft(prev => ({ ...prev, apiKey: '' }))
        setCursorOffset(0)
        setErrorMessage(AIMLAPI_MESSAGES.apiKeyInvalid)
        return
      }
      const detail = safeAimlapiErrorMessage(error, [apiKey])
      setErrorMessage(detail)
    } finally {
      if (aimlapiAbortRef.current === controller) aimlapiAbortRef.current = null
      if (!controller.signal.aborted) setIsAimlapiKeyValidating(false)
    }
  }

  function existingAimlapiCredential(): {
    apiKey: string
    profile?: ProviderProfile
    usesEnv: boolean
    inferenceBaseUrl: string
  } | null {
    const isAimlapiProfile = (profile: ProviderProfile): boolean =>
      profile.provider === 'aimlapi' ||
      resolveRouteIdFromBaseUrl(profile.baseUrl) === 'aimlapi'
    const inferenceBaseUrl = resolveEndpoints().inferenceBaseUrl
    // Discovering an already-saved profile must not depend on the AMBIENT
    // endpoint: a saved production-endpoint profile is still eligible even
    // while AIMLAPI_INFERENCE_URL currently points elsewhere (e.g. staging) —
    // the per-profile canonical check below is what actually enforces "never
    // send a saved key to another environment". The ambient env's key is a
    // different matter: it's only valid to read AT the ambient endpoint, so
    // it stays gated on the ambient endpoint being canonical.
    const ambientIsCanonical = isCanonicalAimlapiInferenceBaseUrl(inferenceBaseUrl)
    const envKey = ambientIsCanonical
      ? resolveRouteCredentialValue({
          routeId: 'aimlapi',
          baseUrl: inferenceBaseUrl,
        })?.trim()
      : undefined
    const active = profiles.find(profile => profile.id === activeProfileId)
    const candidates = active
      ? [active, ...profiles.filter(profile => profile.id !== active.id)]
      : profiles
    for (const profile of candidates) {
      if (!isAimlapiProfile(profile)) continue
      // Saved credentials are eligible for the guided balance/top-up preflight
      // only on the production catalog endpoint. A proxy/staging profile remains
      // usable normally, but its key must never be sent to another environment.
      if (!isCanonicalAimlapiInferenceBaseUrl(profile.baseUrl)) continue
      const apiKey = profile.apiKey?.trim()
      if (apiKey) {
        return {
          apiKey,
          profile,
          usesEnv: false,
          inferenceBaseUrl: profile.baseUrl,
        }
      }
      if (envKey) {
        return {
          apiKey: envKey,
          profile,
          usesEnv: true,
          inferenceBaseUrl: profile.baseUrl,
        }
      }
    }
    return envKey
      ? {
          apiKey: envKey,
          usesEnv: true,
          inferenceBaseUrl,
        }
      : null
  }

  function persistExistingAimlapi(model = draft.model): void {
    const profile = aimlapiExistingProfileId
      ? profiles.find(candidate => candidate.id === aimlapiExistingProfileId)
      : undefined
    if (profile) {
      const nextDraft = applyPresetApiFormat(
        { ...toDraft(profile), model },
        profile.provider,
      )
      setDraft(nextDraft)
      persistDraft(nextDraft, profile.provider, profile.id, {
        deferNavigation: true,
        onSaved: () => {
          resetAimlapiCheckoutIntent()
          // onSaved runs synchronously from persistDraft, so this can only be
          // fire-and-forget (best-effort) here, not awaited — but it must
          // still be the async, lock-yielding variant: the sync one's
          // Atomics.wait retry would otherwise freeze Ink rendering, timers,
          // Esc, and SIGINT right at completion on a contended cache lock.
          void clearAimlapiSignInKeyAsync(aimlapiTopupEmail, aimlapiIssuedKeyId).catch(() => {})
          setAimlapiDoneKind(aimlapiTopupPaidRef.current ? 'topup' : 'ready')
          setErrorMessage(undefined)
          setScreen('aimlapi-done')
        },
      })
      return
    }
    persistAimlapiKey(
      aimlapiIssuedKey,
      aimlapiInferenceBaseUrl,
      model,
      aimlapiTopupPaidRef.current ? 'topup' : 'ready',
      { preserveEnv: aimlapiExistingUsesEnv },
    )
  }

  function startExistingAimlapi(nextDraft: ProviderDraft): boolean {
    const existing = existingAimlapiCredential()
    if (!existing) return false
    setDraft({
      ...nextDraft,
      baseUrl: existing.profile?.baseUrl ?? existing.inferenceBaseUrl,
    })
    setAimlapiIssuedKey(existing.apiKey)
    setAimlapiIssuedKeyId('')
    setAimlapiExistingProfileId(existing.profile?.id ?? null)
    setAimlapiExistingUsesEnv(existing.usesEnv)
    setAimlapiInferenceBaseUrl(existing.inferenceBaseUrl)
    setAimlapiTopupByKey(true)
    setScreen('aimlapi-configured')
    return true
  }

  function useExistingAimlapi(): void {
    const apiKey = aimlapiIssuedKey.trim()
    if (!apiKey) {
      setErrorMessage('The existing AI/ML API key is unavailable. Configure again.')
      return
    }
    // Continuing with a saved key is not a payment; clear any stale paid flag
    // from an earlier top-up so the done screen shows "Everything is ready."
    aimlapiTopupPaidRef.current = false
    aimlapiAbortRef.current?.abort()
    const controller = new AbortController()
    aimlapiAbortRef.current = controller
    setIsAimlapiKeyValidating(true)
    setErrorMessage(undefined)
    void (async () => {
      try {
        const balance = await validateAimlapiApiKey(
          apiKey,
          controller.signal,
          aimlapiInferenceBaseUrl,
        )
        if (controller.signal.aborted) return
        if (balance.lowBalance) {
          setIsAimlapiKeyValidating(false)
          setScreen('aimlapi-low-balance')
        } else {
          // This path reuses an already-funded credential without claiming a
          // checkout, so it never runs startAimlapiTopup's own settled-receipt
          // recovery. An earlier top-up for this SAME credential may still be
          // sitting settled-but-unsaved (its model picker was backed out of or
          // closed before this fix) and would otherwise refuse any later,
          // differently-amounted top-up. Nothing new is being paid for here —
          // the balance just confirmed above already reflects it — so clearing
          // that leftover marker is safe and unblocks a future top-up.
          //
          // Awaited (not fire-and-forget): a by-key top-up reuses this same
          // apiKey, so a genuinely NEW settlement for this credential landing
          // between this call and the user's next action here could otherwise
          // be swept up by a still-in-flight reconcile from THIS call. Waiting
          // for it to finish under its own lock before moving on keeps the two
          // from interleaving. Crucially, isAimlapiKeyValidating (and with it
          // the aimlapi-configured Select and its Esc binding, see the
          // isActive guard below) also stays true for the whole wait: this
          // reconcile has no abort signal of its own, so it keeps running
          // regardless of what the UI does — leaving the Select reachable
          // here would let the user start a genuinely NEW top-up for this
          // same credential (e.g. "Set up a new key or switch account", or
          // Esc then back in) whose fresh settlement could then be caught and
          // deleted by this still-in-flight reconcile.
          await reconcileSettledAimlapiTopupStateAsync(apiKey).catch(() => {})
          if (controller.signal.aborted) return
          setIsAimlapiKeyValidating(false)
          setCursorOffset(draft.model.length)
          setScreen('preset-model')
        }
      } catch (error) {
        if (controller.signal.aborted) return
        setIsAimlapiKeyValidating(false)
        const status = aimlapiApiErrorStatus(error)
        setErrorMessage(
          status === 401 || status === 403
            ? 'The existing AI/ML API key is invalid. Configure again.'
            : safeAimlapiErrorMessage(error, [apiKey]),
        )
      } finally {
        if (aimlapiAbortRef.current === controller) aimlapiAbortRef.current = null
      }
    })()
  }

  function persistAimlapiKey(
    apiKey: string,
    baseUrl: string,
    model = draft.model,
    doneKind: 'ready' | 'topup' = 'ready',
    options: { preserveEnv?: boolean; signInKeyId?: string } = {},
  ): void {
    const nextDraft = applyPresetApiFormat(
      {
        ...draft,
        apiKey: options.preserveEnv ? '' : apiKey.trim(),
        baseUrl,
        model,
      },
      draftProvider,
    )
    setDraft(nextDraft)
    // persistDraft invokes onSaved synchronously, so read the just-minted key id
    // from the caller rather than the aimlapiIssuedKeyId state, whose setter may
    // not have applied yet — otherwise the sign-in cache record is never cleared.
    const signInKeyId = options.signInKeyId ?? aimlapiIssuedKeyId
    persistDraft(nextDraft, draftProvider, null, {
      deferNavigation: true,
      onSaved: () => {
        resetAimlapiCheckoutIntent()
        // Fire-and-forget: see the matching comment in persistExistingAimlapi.
        void clearAimlapiSignInKeyAsync(aimlapiTopupEmail, signInKeyId).catch(() => {})
        setAimlapiDoneKind(doneKind)
        setErrorMessage(undefined)
        setScreen('aimlapi-done')
      },
    })
  }

  // A checkout that is already chargeable (a resume token recorded, a key
  // minted, or a browser tab opened) must not be silently abandoned by
  // navigating elsewhere in the guided flow — e.g. an accidental Esc-back
  // through the email/amount screens to an earlier choice screen and
  // resubmitting. A never-advanced claim (nothing paid or minted yet) is
  // safe to drop without confirmation.
  function hasChargeableAimlapiCheckout(): boolean {
    return Boolean(
      aimlapiPersistedIntentRef.current &&
        (aimlapiResumeSessionToken.trim() ||
          aimlapiIssuedKey.trim() ||
          aimlapiOpenedCheckoutRef.current),
    )
  }

  function startAimlapiEmailOnboarding(email: string): void {
    const trimmedEmail = email.trim()
    if (!isValidAimlapiEmail(trimmedEmail)) {
      setErrorMessage(AIMLAPI_MESSAGES.emailInvalid)
      return
    }
    // Submitting the email starts a fresh account-bound flow. Retaining a
    // checkout from an earlier email/key path could poll or exchange the wrong
    // payment intent, so retries that should resume stay on the amount screen.
    // Require the same explicit confirmation an amount edit does before
    // dropping a chargeable one.
    const hadChargeableCheckout = hasChargeableAimlapiCheckout()
    if (hadChargeableCheckout && !aimlapiAbandonAckRef.current) {
      aimlapiAbandonAckRef.current = true
      setErrorMessage(
        'A checkout from a previous email is still pending — if a browser tab for it is open, do NOT pay it. Press Enter again to abandon it and continue with this email.',
      )
      return
    }
    aimlapiAbandonAckRef.current = false
    resetAimlapiOnboardingIdentity()
    if (hadChargeableCheckout) {
      // The user just confirmed abandoning it (reaching here on the second
      // Enter, past the gate above). resetAimlapiOnboardingIdentity's clear
      // is un-awaited and best-effort, so a contended/failed lock must not
      // leave the abandoned receipt still enforced — make the confirmation
      // authoritative at claimAimlapiTopupStateAsync itself instead, the same
      // one-shot signal the "switch account" flow uses for its own on-disk,
      // this-mount-invisible conflicts.
      aimlapiForceAbandonExistingRef.current = true
    }
    aimlapiAbortRef.current?.abort()
    const controller = new AbortController()
    aimlapiAbortRef.current = controller
    setAimlapiTopupEmail(trimmedEmail)
    setAimlapiTopupStatus('checking-account')
    setAimlapiTopupDetail(undefined)
    setErrorMessage(undefined)
    setScreen('aimlapi-topup-progress')

    void (async () => {
      try {
        const account = await beginAimlapiEmailOnboarding(
          trimmedEmail,
          controller.signal,
        )
        if (account.action === 'code-sent') {
          setAimlapiTopupStatus('sending-code')
          if (controller.signal.aborted) return
          setAimlapiNewAccount(false)
          setAimlapiSignInCode('')
          setCursorOffset(0)
          setScreen('aimlapi-signin-code')
          return
        }
        setAimlapiTopupStatus('creating-account')
        if (controller.signal.aborted) return
        setAimlapiNewAccount(true)
        setAimlapiSessionToken(account.sessionToken)
        setCursorOffset(aimlapiTopupAmountUsd.length)
        setScreen('aimlapi-topup-amount')
      } catch (error) {
        if (controller.signal.aborted) return
        setErrorMessage(
          safeAimlapiErrorMessage(error, [trimmedEmail]),
        )
        setCursorOffset(trimmedEmail.length)
        setScreen('aimlapi-topup-email')
      } finally {
        if (aimlapiAbortRef.current === controller) aimlapiAbortRef.current = null
      }
    })()
  }

  function verifyAimlapiSignInCode(code: string): void {
    const trimmedCode = code.trim()
    if (!isValidAimlapiSignInCode(trimmedCode)) {
      setErrorMessage(AIMLAPI_MESSAGES.codeIncorrect)
      return
    }
    aimlapiAbortRef.current?.abort()
    const controller = new AbortController()
    aimlapiAbortRef.current = controller
    setAimlapiTopupStatus('verifying-code')
    setErrorMessage(undefined)
    setScreen('aimlapi-topup-progress')

    void (async () => {
      try {
        // Reuse a key already minted for this email (e.g. after closing before
        // amount entry or restarting a checkout) instead of creating another.
        const retainedSignInKey = loadAimlapiSignInKey(aimlapiTopupEmail)
        const result = await completeAimlapiCodeSignIn(
          aimlapiTopupEmail,
          trimmedCode,
          controller.signal,
          aimlapiInferenceBaseUrl,
          retainedSignInKey ?? undefined,
        )
        // Copy into memory BEFORE persisting so a cache-write failure cannot
        // discard the just-minted key — otherwise the catch below returns to code
        // entry with neither the key nor a cache record and a retry mints another.
        setAimlapiSessionToken(result.sessionToken)
        setAimlapiIssuedKey(result.apiKey)
        setAimlapiIssuedKeyId(result.apiKeyId)
        // Recovery aid so an abort/restart reuses this key; best-effort — a lock,
        // permission, or disk failure must not lose the key retained above. Async
        // so a contended lock yields to the event loop instead of freezing Ink
        // rendering, timers, Esc, and SIGINT via the sync lock's Atomics.wait.
        try {
          await saveAimlapiSignInKeyAsync(aimlapiTopupEmail, result.apiKey, result.apiKeyId)
        } catch {
          // Retained in component state above; the cache is only a recovery aid.
        }
        if (controller.signal.aborted) return
        if (result.balanceStatus === 'unknown') {
          setDraft(prev => ({ ...prev, apiKey: result.apiKey }))
          setCursorOffset(result.apiKey.length)
          setErrorMessage(
            safeAimlapiErrorMessage(result.balanceError, [result.apiKey]),
          )
          setScreen('preset-api-key')
          return
        }
        if (result.lowBalance) {
          setScreen('aimlapi-low-balance')
        } else {
          persistAimlapiKey(result.apiKey, aimlapiInferenceBaseUrl, draft.model, 'ready', {
            signInKeyId: result.apiKeyId,
          })
        }
      } catch (error) {
        if (controller.signal.aborted) return
        setErrorMessage(
          error instanceof AimlapiApiError && error.status === 400
            ? AIMLAPI_MESSAGES.codeIncorrect
            : safeAimlapiErrorMessage(error, [
                aimlapiTopupEmail,
                trimmedCode,
                aimlapiSessionToken,
              ]),
        )
        setCursorOffset(trimmedCode.length)
        setScreen('aimlapi-signin-code')
      } finally {
        if (aimlapiAbortRef.current === controller) aimlapiAbortRef.current = null
      }
    })()
  }

  async function startAimlapiTopup(autoTopUp = aimlapiAutoTopUp): Promise<void> {
    const amountUsd = aimlapiTopupAmountUsd.trim()
    if (!amountUsd) {
      setErrorMessage(AIMLAPI_MESSAGES.amountRequired)
      setScreen('aimlapi-topup-amount')
      return
    }
    let amountUsdMinor: number
    try {
      amountUsdMinor = parseAimlapiAmountUsd(amountUsd)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
      setScreen('aimlapi-topup-amount')
      return
    }
    if (!aimlapiTopupByKey && !aimlapiSessionToken.trim()) {
      setErrorMessage('Your AI/ML API session expired. Enter your email again.')
      setScreen('aimlapi-topup-email')
      return
    }

    // A checkout URL was already opened for a different amount/auto-top-up:
    // starting a new payment session abandons that still-chargeable browser tab
    // (no endpoint can cancel it), so require an explicit acknowledgement first.
    const openedCheckout = aimlapiOpenedCheckoutRef.current
    const abandoningOpenedCheckout = Boolean(
      openedCheckout &&
        (openedCheckout.amountUsdMinor !== amountUsdMinor ||
          openedCheckout.autoTopUp !== autoTopUp),
    )
    // A session can already be recorded on disk (elected via onSession, inside
    // resolveTopupSession) before a checkout URL ever surfaces — e.g. the user
    // backed out while createSession was still in flight, so opening-checkout
    // never ran and aimlapiOpenedCheckoutRef was never armed. claimAimlapiTopupState
    // still refuses a differing intent against that record, so it needs the same
    // confirmed-abandon path, just without the "do NOT pay it" browser-tab wording.
    const persistedIntent = aimlapiPersistedIntentRef.current
    const abandoningPersistedIntent = Boolean(
      persistedIntent &&
        (persistedIntent.amountUsdMinor !== amountUsdMinor ||
          persistedIntent.autoTopUp !== autoTopUp),
    )
    if (
      (abandoningOpenedCheckout || abandoningPersistedIntent) &&
      !aimlapiAbandonAckRef.current
    ) {
      aimlapiAbandonAckRef.current = true
      setErrorMessage(
        abandoningOpenedCheckout
          ? 'An unpaid checkout is still open in your browser — do NOT pay it. Press Enter again to abandon it and start a new checkout.'
          : 'A checkout for the previous amount is still pending. Press Enter again to abandon it and start a new one.',
      )
      setScreen('aimlapi-topup-amount')
      return
    }

    const endpoints = resolveEndpoints()
    const intentIdentity = aimlapiTopupByKey
      ? aimlapiByKeyIdentity(aimlapiIssuedKey)
      : aimlapiTopupEmail.trim().toLowerCase()
    const intent: AimlapiTopupIntent = {
      email: intentIdentity,
      amountUsdMinor,
      autoTopUp,
      partnerId: resolvePartnerId(),
      partnerName: DEFAULT_PARTNER_NAME,
      appBaseUrl: endpoints.appBaseUrl.trim().replace(/\/+$/, ''),
      inferenceBaseUrl: aimlapiInferenceBaseUrl.trim().replace(/\/+$/, ''),
      payBaseUrl: endpoints.payBaseUrl.trim().replace(/\/+$/, ''),
      verificationBaseUrl: endpoints.verificationBaseUrl.trim().replace(/\/+$/, ''),
    }
    // Single-use: consume it for this claim regardless of outcome, so it can
    // never leak into a later, unrelated claim in the same mount.
    const forceAbandonExisting = aimlapiForceAbandonExistingRef.current
    aimlapiForceAbandonExistingRef.current = false

    // Own this invocation's cancellation from here, BEFORE the first async
    // boundary: claimAimlapiTopupStateAsync below can contend for the state
    // lock for up to LOCK_TIMEOUT_ASYNC_MS (15s) while the screen is still
    // aimlapi-topup-amount, so a stale run must not resume unattended after
    // that wait — reaffirmed after every awaited preflight step below, before
    // any ref/state mutation or network/payment work.
    aimlapiAbortRef.current?.abort()
    const controller = new AbortController()
    aimlapiAbortRef.current = controller

    let checkoutState: Awaited<ReturnType<typeof claimAimlapiTopupStateAsync>>
    try {
      // The abandon-ack gate above already made the user explicitly confirm
      // giving up the retained checkout when one conflicts with this intent
      // (abandoningOpenedCheckout / abandoningPersistedIntent), so this claim
      // may overwrite it instead of refusing. forceAbandonExisting covers the
      // "switch account" case: an on-disk record from an earlier process that
      // this mount's refs were never populated for, so the checks above can't
      // see it, but the user already agreed to abandon whatever's there.
      // Async: the sync lock's Atomics.wait retry would otherwise freeze Ink
      // rendering, Esc, and SIGINT for up to LOCK_TIMEOUT_MS on contention.
      checkoutState = await claimAimlapiTopupStateAsync(intent, {
        abandonExisting:
          abandoningOpenedCheckout || abandoningPersistedIntent || forceAbandonExisting,
      })
    } catch (error) {
      if (controller.signal.aborted) return
      setErrorMessage(safeAimlapiErrorMessage(error, [aimlapiIssuedKey]))
      setScreen('aimlapi-topup-amount')
      return
    }
    // Esc/unmount during the wait above aborted this controller — a screen
    // navigated away from (or a manager closed during) that wait must not
    // have this now-resolved claim barge back in and mutate state or start
    // provisioning as if it were still the active operation.
    if (controller.signal.aborted) return

    aimlapiPersistedIntentRef.current = {
      ...intent,
      paymentSessionId: checkoutState.paymentSessionId,
    }
    setAimlapiResumeSessionToken(checkoutState.resumeSessionToken)

    // Resume: a prior run paid + exchanged the key and saved the settled receipt
    // but was interrupted before the profile write. Finish that last step with
    // the retained key instead of re-entering provisioning against a now-
    // exchanged session (which fails in resolveTopupSession and strands the paid
    // one-shot credential). Mirrors the CLI's settled-receipt recovery.
    if (checkoutState.settled && checkoutState.apiKey) {
      aimlapiTopupPaidRef.current = true
      // An existing saved profile or an ambient env key must complete through
      // persistExistingAimlapi — update the selected profile / keep preserveEnv —
      // instead of minting a new profile and copying the env credential into it.
      if (aimlapiExistingProfileId || aimlapiExistingUsesEnv) {
        persistExistingAimlapi(checkoutState.model?.trim() || draft.model)
      } else {
        persistAimlapiKey(
          checkoutState.apiKey,
          aimlapiInferenceBaseUrl,
          checkoutState.model?.trim() || draft.model,
          'topup',
          { signInKeyId: checkoutState.apiKeyId },
        )
      }
      return
    }

    // Persist whether this checkout must be exchanged, so a retry that now
    // resolves to sign-in still exchanges the paid sign-up session instead of
    // minting an unrelated key (mirrors the CLI). By-key top-ups never exchange.
    if (!aimlapiTopupByKey && checkoutState.exchange === undefined) {
      checkoutState.exchange = aimlapiNewAccount
      // Mirror the CLI (topup.ts): an existing-account key already minted at
      // sign-in is otherwise only recorded in the separate sign-in-key cache,
      // not in this receipt. A restart before settlement would then depend on
      // BOTH files staying consistent to resume; persisting it here too makes
      // the receipt self-contained, matching the CLI's recovery guarantee.
      if (aimlapiIssuedKey.trim()) {
        checkoutState.apiKey = aimlapiIssuedKey
        checkoutState.apiKeyId = aimlapiIssuedKeyId
      }
      try {
        await saveAimlapiTopupStateAsync({ ...intent, ...checkoutState })
      } catch {
        // Retained in memory; persistence is only a resume aid.
      }
      if (controller.signal.aborted) return
    }

    setScreen('aimlapi-topup-progress')
    setErrorMessage(undefined)
    setAimlapiTopupStatus('creating-session')
    setAimlapiTopupDetail(undefined)

    void (async () => {
      try {
        const reportStatus = (status: AimlapiTopupStatus, detail?: string): void => {
          if (status === 'opening-checkout') {
            // A checkout URL is now live in the browser; remember its intent so a
            // later edit that starts a new payment must be confirmed first. Reset
            // the acknowledgement: the confirmation is single-use, so a further
            // edit to a different intent must be confirmed again rather than
            // silently abandoning THIS freshly-opened, still-chargeable tab.
            aimlapiOpenedCheckoutRef.current = { amountUsdMinor, autoTopUp }
            aimlapiAbandonAckRef.current = false
          }
          setAimlapiTopupStatus(status)
          if (detail?.trim()) setAimlapiTopupDetail(detail)
        }
        const reportSession = async (sessionToken: string): Promise<string | undefined> => {
          if (!sessionToken) {
            // Mirrors the CLI's persistSession: a terminal checkout invalidates
            // the payment session but not an already-minted existing-account
            // key, so try to retain it (with a fresh payment session) before
            // falling back to a full clear. Awaited (not fire-and-forget) so
            // the poll loop this onSession callback resolves for only reaches
            // the amount screen once the durable receipt is actually reset or
            // cleared — otherwise an immediate retry can still observe the
            // stale resume token and reject the "already abandoned" checkout.
            // Async on the lock either way, so this never blocks Ink.
            const stale = aimlapiPersistedIntentRef.current
            if (stale) {
              try {
                const reset = await resetAimlapiCheckoutSessionAsync(stale)
                if (!reset) await clearAimlapiTopupStateAsync(stale)
                // Only drop ownership once the durable transition actually
                // committed. On failure, keep the ref instead of discarding it
                // and silently reporting success — the on-disk receipt is
                // still the stale one, so the next claim must go through the
                // normal chargeable-checkout confirmation gate against it
                // (this ref is what that gate compares against) rather than
                // being rejected by the CAS with no ownership left to retry
                // cleanup, or worse, silently proceeding as if abandoned.
                aimlapiPersistedIntentRef.current = null
              } catch (cleanupError) {
                logForDebugging(
                  `Failed to reset/clear the AI/ML API checkout receipt: ${String(cleanupError)}`,
                  { level: 'warn' },
                )
              }
            }
            setAimlapiResumeSessionToken('')
            return undefined
          }
          // Atomic election: a peer that already opened a payable checkout for
          // this payment id wins; adopt its token so concurrent runs never leave
          // two chargeable checkouts. Async so lock contention on this CAS never
          // freezes Ink while a payment session is being created.
          const recorded = await recordAimlapiCheckoutSessionAsync({
            ...intent,
            ...checkoutState,
            resumeSessionToken: sessionToken,
          })
          if (!recorded) {
            // The stored checkout was cleared/reset meanwhile — a sibling run
            // already completed (or invalidated) this top-up. Abort rather than
            // pay a second, unrecorded checkout.
            throw new Error(
              'This top-up was already completed or cancelled elsewhere. Re-run to try again.',
            )
          }
          const elected = recorded.resumeSessionToken || sessionToken
          checkoutState.resumeSessionToken = elected
          setAimlapiResumeSessionToken(elected)
          return elected
        }
        const provisioned = aimlapiTopupByKey
          ? await topUpAimlapiByApiKey({
              apiKey: aimlapiIssuedKey,
              inferenceBaseUrl: aimlapiInferenceBaseUrl,
              amountUsd,
              autoTopUp,
              model: draft.model,
              paymentSessionId: checkoutState.paymentSessionId,
              resumeSessionToken: checkoutState.resumeSessionToken,
              signal: controller.signal,
              onStatus: reportStatus,
              onSession: reportSession,
            })
          : await provisionAimlapiKey({
              amountUsd,
              autoTopUp,
              model: draft.model,
              sessionToken: aimlapiSessionToken,
              inferenceBaseUrl: aimlapiInferenceBaseUrl,
              exchange: checkoutState.exchange ?? aimlapiNewAccount,
              intent,
              paymentSessionId: checkoutState.paymentSessionId,
              existingApiKey: aimlapiIssuedKey,
              existingApiKeyId: aimlapiIssuedKeyId,
              resumeSessionToken: checkoutState.resumeSessionToken,
              signal: controller.signal,
              onStatus: reportStatus,
              onSession: reportSession,
            })
        if (controller.signal.aborted) return
        // Record the settled receipt BEFORE the profile write, so an interruption
        // or a failed save resumes with the paid key instead of stranding a
        // one-shot exchanged credential in resolveTopupSession (mirrors the CLI).
        // This receipt is the ONLY durable record of that key until the profile
        // write below lands, and /exchange cannot be retried to recover it — so
        // a failure here must stop the flow (caught by this function's own
        // catch below, which reports the error and returns to the amount
        // screen) rather than risk losing the key silently if the profile write
        // also fails or the app is closed before it runs.
        // saveAimlapiTopupStateAsync already retries internally on lock
        // contention (withStateLockAsync, up to LOCK_TIMEOUT_ASYNC_MS), so a
        // failure this deep signals a real problem, not a transient blip.
        checkoutState.apiKey = provisioned.apiKey
        checkoutState.apiKeyId = provisioned.apiKeyId
        checkoutState.model = provisioned.model
        checkoutState.settled = true
        try {
          // An ambient env key (aimlapiExistingUsesEnv) is `provisioned.apiKey`
          // verbatim here — never persist it: it's already available from the
          // environment on any resume, and the eventual profile write for it is
          // deliberately keyless (persistExistingAimlapi's preserveEnv), so
          // writing it to the receipt would be pure exposure surface with no
          // recovery benefit. A by-key resume without a locally-stored key still
          // completes correctly (just via the normal, idempotent session
          // resolution instead of the local settled-shortcut above).
          await saveAimlapiTopupStateAsync({
            ...intent,
            ...checkoutState,
            ...(aimlapiExistingUsesEnv ? { apiKey: undefined, apiKeyId: undefined } : {}),
          })
        } catch (error) {
          throw new Error(
            `Payment succeeded and a key was issued (id ${provisioned.apiKeyId}), but the ` +
              `local recovery receipt could not be saved (${error instanceof Error ? error.message : String(error)}). ` +
              `Open https://aimlapi.com/app and rotate the issued key to recover access.`,
            { cause: error },
          )
        }
        // A payment just cleared, so the done screen should report the top-up
        // regardless of whether we route through the model picker first.
        aimlapiTopupPaidRef.current = true
        // The tracked checkout has been paid and settled: there is no longer a
        // chargeable tab to guard, so a later re-edit (e.g. the by-key route that
        // stops at the model picker) must not warn "do NOT pay it" for it.
        aimlapiOpenedCheckoutRef.current = null
        aimlapiAbandonAckRef.current = false
        if (aimlapiTopupByKey) {
          if (aimlapiExistingProfileId || aimlapiExistingUsesEnv) {
            setCursorOffset(provisioned.model.length)
            setScreen('preset-model')
          } else {
            persistExistingAimlapi(provisioned.model)
          }
        } else {
          persistAimlapiKey(
            provisioned.apiKey,
            provisioned.baseUrl,
            provisioned.model,
            'topup',
          )
        }
      } catch (error) {
        if (controller.signal.aborted) return
        const detail = safeAimlapiErrorMessage(error, [
          aimlapiIssuedKey,
          aimlapiTopupEmail,
          aimlapiSignInCode,
          aimlapiSessionToken,
          aimlapiResumeSessionToken,
        ])
        setErrorMessage(`${AIMLAPI_MESSAGES.topUpFailed} ${detail}`)
        setCursorOffset(amountUsd.length)
        setScreen('aimlapi-topup-amount')
      } finally {
        if (aimlapiAbortRef.current === controller) aimlapiAbortRef.current = null
      }
    })()
  }

  function renderAimlapiConfigured(): React.ReactNode {
    if (isAimlapiKeyValidating) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="remember" bold>aimlapi.com account is already configured</Text>
          <Box flexDirection="row" gap={1}>
            <Spinner />
            <Text dimColor>Checking balance...</Text>
          </Box>
        </Box>
      )
    }
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>aimlapi.com account is already configured</Text>
        <Select
          options={[
            {
              value: 'existing',
              label: 'Continue with your saved API key',
            },
            {
              value: 'again',
              label: 'Set up a new key or switch account',
            },
          ]}
          onChange={(value: string) => {
            setErrorMessage(undefined)
            if (value === 'existing') {
              useExistingAimlapi()
              return
            }
            setAimlapiExistingProfileId(null)
            setAimlapiExistingUsesEnv(false)
            setAimlapiTopupByKey(false)
            setAimlapiIssuedKey('')
            setAimlapiInferenceBaseUrl(resolveEndpoints().inferenceBaseUrl)
            setAimlapiResumeSessionToken('')
            setDraft(previous => ({ ...previous, apiKey: '' }))
            // Explicit user-initiated "start over" — unlike an accidental
            // re-submit elsewhere, no confirmation is needed here. But it must
            // still abandon a durable receipt from an earlier interrupted
            // top-up: this only clears the fields above, so without either of
            // the next two lines a stale on-disk record for a DIFFERENT
            // email/key would otherwise make the very next onboarding attempt
            // hit claimAimlapiTopupState's refusal with no way to recover
            // short of deleting the file by hand. resetAimlapiCheckoutIntent
            // covers a checkout interrupted earlier in THIS mount; the force
            // flag covers one already on disk from an earlier process, which
            // this mount's refs were never populated for and so can't detect.
            resetAimlapiCheckoutIntent()
            aimlapiForceAbandonExistingRef.current = true
            setScreen('aimlapi-api-key-choice')
          }}
          onCancel={handleBackFromAimlapiConfigured}
          visibleOptionCount={2}
        />
        {errorMessage && <Text color="error">{errorMessage}</Text>}
      </Box>
    )
  }

  function renderAimlapiApiKeyChoice(): React.ReactNode {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          {AIMLAPI_MESSAGES.pickPathPrompt}
        </Text>
        <Select
          options={[
            {
              value: 'topup',
              label: AIMLAPI_MESSAGES.pickPathNewUser,
            },
            {
              value: 'manual',
              label: AIMLAPI_MESSAGES.pickPathHaveKey,
            },
          ]}
          onChange={(value: string) => {
            setErrorMessage(undefined)
            // Either choice below abandons whatever onboarding identity is
            // currently held (resetAimlapiOnboardingIdentity). Esc can reach
            // this screen after a checkout was already opened further along
            // (email -> amount -> Esc, Esc), so that must not happen silently.
            const hadChargeableCheckout = hasChargeableAimlapiCheckout()
            if (hadChargeableCheckout && !aimlapiAbandonAckRef.current) {
              aimlapiAbandonAckRef.current = true
              setErrorMessage(
                'A checkout from this account is still pending — if a browser tab for it is open, do NOT pay it. Press Enter again to abandon it and continue.',
              )
              return
            }
            aimlapiAbandonAckRef.current = false
            if (value === 'manual') {
              resetAimlapiOnboardingIdentity()
              setCursorOffset(draft.apiKey.length)
              setScreen('preset-api-key')
              return
            }

            // Guided provisioning mints a production-account key via production
            // auth; it must never be written against a non-canonical inference
            // endpoint. Pasting an existing key stays allowed for custom
            // endpoints (handled by the 'manual' branch above).
            if (!isCanonicalAimlapiInferenceBaseUrl(aimlapiInferenceBaseUrl)) {
              setErrorMessage(AIMLAPI_MESSAGES.guidedNeedsCanonicalEndpoint)
              return
            }

            resetAimlapiOnboardingIdentity()
            if (hadChargeableCheckout) {
              // The user just confirmed abandoning it (reaching here on the
              // second Enter, past the gate above). resetAimlapiOnboardingIdentity's
              // clear is un-awaited and best-effort, so a contended/failed lock
              // must not leave the abandoned receipt still enforced — make the
              // confirmation authoritative at claimAimlapiTopupStateAsync itself
              // instead, the same one-shot signal the email-switch and "switch
              // account" flows use for this exact transition.
              aimlapiForceAbandonExistingRef.current = true
            }
            const envEmail = process.env.AIMLAPI_EMAIL?.trim() ?? ''
            setCursorOffset(envEmail.length)
            setAimlapiTopupEmail(envEmail)
            setScreen('aimlapi-topup-email')
          }}
          onCancel={handleBackFromAimlapiKeyChoice}
          visibleOptionCount={2}
        />
        {errorMessage && <Text color="error">{errorMessage}</Text>}
        <Text dimColor>
          Press Enter to continue. Press Esc to go back.
        </Text>
      </Box>
    )
  }

  function renderAimlapiTopupEmail(): React.ReactNode {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          {AIMLAPI_MESSAGES.enterEmail}
        </Text>
        <Box flexDirection="row" gap={1}>
          <Text>{figures.pointer}</Text>
          <TextInput
            value={aimlapiTopupEmail}
            onChange={setAimlapiTopupEmail}
            onSubmit={value => {
              const email = value.trim()
              startAimlapiEmailOnboarding(email)
            }}
            focus={true}
            showCursor={true}
            placeholder={`Enter email${figures.ellipsis}`}
            columns={inputColumns}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
          />
        </Box>
        {errorMessage && <Text color="error">{errorMessage}</Text>}
        <Text dimColor>
          Press Enter to continue. Press Esc to go back.
        </Text>
      </Box>
    )
  }

  function renderAimlapiSignInCode(): React.ReactNode {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          {AIMLAPI_MESSAGES.codeSent(aimlapiTopupEmail)}
        </Text>
        <Box flexDirection="row" gap={1}>
          <Text>{figures.pointer}</Text>
          <TextInput
            value={aimlapiSignInCode}
            onChange={setAimlapiSignInCode}
            onSubmit={verifyAimlapiSignInCode}
            focus={true}
            showCursor={true}
            mask="*"
            placeholder={`6-digit code${figures.ellipsis}`}
            columns={inputColumns}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
          />
        </Box>
        {errorMessage && <Text color="error">{errorMessage}</Text>}
        <Text dimColor>Press Enter to continue. Press Esc to go back.</Text>
      </Box>
    )
  }

  function renderAimlapiLowBalance(): React.ReactNode {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>{AIMLAPI_MESSAGES.lowBalance}</Text>
        <Select
          options={[
            { value: 'topup', label: AIMLAPI_MESSAGES.lowBalanceTopUp },
            { value: 'skip', label: AIMLAPI_MESSAGES.lowBalanceSkip },
          ]}
          onChange={(value: string) => {
            setErrorMessage(undefined)
            if (value === 'skip') {
              if (aimlapiExistingProfileId || aimlapiExistingUsesEnv) {
                setCursorOffset(draft.model.length)
                setScreen('preset-model')
              } else if (aimlapiTopupByKey) {
                persistExistingAimlapi()
              } else {
                persistAimlapiKey(aimlapiIssuedKey, aimlapiInferenceBaseUrl)
              }
              return
            }
            setCursorOffset(aimlapiTopupAmountUsd.length)
            setScreen('aimlapi-topup-amount')
          }}
          onCancel={handleBackFromAimlapiLowBalance}
          visibleOptionCount={2}
        />
      </Box>
    )
  }

  function renderAimlapiTopupAmount(): React.ReactNode {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          {AIMLAPI_MESSAGES.topUpPrompt}
        </Text>
        <AimlapiTopupForm
          amountUsd={aimlapiTopupAmountUsd}
          autoTopUp={aimlapiAutoTopUp}
          columns={inputColumns}
          cursorOffset={cursorOffset}
          onAmountChange={value => {
            // Do NOT reset the persisted checkout intent here: while a checkout
            // is still open in the browser, this is just a draft edit, and the
            // durable receipt must survive it until the user explicitly confirms
            // abandoning that checkout (see startAimlapiTopup's abandon-ack gate).
            setAimlapiTopupAmountUsd(value)
            setErrorMessage(undefined)
          }}
          onCursorOffsetChange={setCursorOffset}
          onAutoTopUpChange={value => {
            setAimlapiAutoTopUp(value)
          }}
          onSubmit={startAimlapiTopup}
        />
        {errorMessage && <Text color="error">{errorMessage}</Text>}
      </Box>
    )
  }

  function renderAimlapiTopupProgress(): React.ReactNode {
    return (
      <Box flexDirection="column" gap={1}>
        {aimlapiTopupDetail ? (
          <>
            <Text color="remember" bold>Opening checkout in browser...</Text>
            <Text dimColor>{AIMLAPI_MESSAGES.topUpBrowserFallback}</Text>
            {/* Stripe Checkout URLs are signed and can require their query and
                fragment verbatim. This is an explicit user-facing fallback,
                not a log field, so redacting it would make the link unusable. */}
            <Box flexDirection="column">
              {wrapAimlapiCheckoutUrl(
                aimlapiTopupDetail,
                terminalColumns - 4,
              ).map((line, index) => (
                <Text key={`${index}:${line}`} color="suggestion">{line}</Text>
              ))}
            </Box>
          </>
        ) : (
          <Spinner />
        )}
        {errorMessage ? <Text color="error">{errorMessage}</Text> : null}
      </Box>
    )
  }

  function renderAimlapiDone(): React.ReactNode {
    // Only parse the amount for the top-up screen. The parse can only reach this
    // screen with a valid amount, but the payment has already cleared here, so a
    // format edge must never crash the success render — fall back to the raw
    // entered value instead of throwing.
    let topUpBody: React.ReactNode = null
    if (aimlapiDoneKind === 'topup') {
      let amountUsd = aimlapiTopupAmountUsd.trim()
      try {
        const amountUsdMinor = parseAimlapiAmountUsd(aimlapiTopupAmountUsd)
        amountUsd =
          amountUsdMinor % 100 === 0
            ? String(amountUsdMinor / 100)
            : (amountUsdMinor / 100).toFixed(2)
      } catch {
        // Keep the raw amount; never fail the success screen on a format edge.
      }
      topUpBody = (
        <>
          <Text color="success" bold>{AIMLAPI_MESSAGES.topUpSuccess(amountUsd)}</Text>
          {aimlapiNewAccount ? (
            <>
              <Text> </Text>
              <Text>{AIMLAPI_MESSAGES.successMagicLink(aimlapiTopupEmail)}</Text>
            </>
          ) : null}
        </>
      )
    }
    return (
      <Box flexDirection="column">
        {aimlapiDoneKind === 'topup' ? (
          topUpBody
        ) : (
          <Text color="success" bold>{AIMLAPI_MESSAGES.everythingRuns}</Text>
        )}
        <Text> </Text>
        <Text dimColor>Press Enter to continue.</Text>
      </Box>
    )
  }

  function renderMenu(): React.ReactNode {
    // Use memoized menuOptions from component scope
    const hasProfiles = profiles.length > 0
    const hasSelectableProviders = hasProfiles || githubProviderAvailable
    // canSwitchActiveProvider is derived once in the component body; reuse it
    // here rather than recomputing so the two sites cannot drift.

    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          Provider manager
        </Text>
        <Text dimColor>
          Active profile controls base URL, model, and API key used by this session.
        </Text>
        {statusMessage && <Text>{statusMessage}</Text>}
        <Box flexDirection="column">
          {profiles.length === 0 && !githubProviderAvailable ? (
            isGithubCredentialSourceResolved ? (
              <Text dimColor>No provider profiles configured yet.</Text>
            ) : (
              <Text dimColor>Checking GitHub Models credentials...</Text>
            )
          ) : (
            <>
              {profiles.map(profile => (
                <Text key={profile.id} dimColor>
                  - {profile.name}: {profileSummary(profile, profile.id === activeProfileId)}
                </Text>
              ))}
              {githubProviderAvailable ? (
                <Text dimColor>
                  - {GITHUB_PROVIDER_LABEL}:{' '}
                  {getGithubProviderSummary(
                    isGithubActive,
                    githubCredentialSource,
                  )}
                </Text>
              ) : null}
            </>
          )}
        </Box>
        <Select
          options={menuOptions}
          onChange={(value: string) => {
            setErrorMessage(undefined)
            switch (value) {
              case 'add':
                setScreen('select-preset')
                break
              case 'activate':
                if (canSwitchActiveProvider) {
                  setScreen('select-active')
                }
                break
              case 'edit':
                if (hasProfiles) {
                  setScreen('select-edit')
                }
                break
              case 'delete':
                if (hasSelectableProviders) {
                  setScreen('select-delete')
                }
                break
              case 'logout-codex-oauth': {
                const cleared = clearCodexCredentials()
                if (!cleared.success) {
                  setErrorMessage(
                    cleared.warning ??
                      'Could not clear Codex OAuth credentials.',
                  )
                  break
                }

                setHasStoredCodexOAuthCredentials(false)
                setStoredCodexOAuthProfileId(undefined)
                const codexProfile = findCodexOAuthProfile(
                  getProviderProfiles(),
                  storedCodexOAuthProfileId,
                )
                let settingsOverrideError: string | null = null
                if (codexProfile) {
                  const result = deleteProviderProfile(codexProfile.id)
                  if (!result.removed) {
                    setErrorMessage(
                      'Codex OAuth credentials were cleared, but the Codex profile could not be removed.',
                    )
                    refreshProfiles()
                    break
                  }

                  clearPersistedCodexOAuthProfile()
                  settingsOverrideError = result.activeProfileId
                    ? clearStartupProviderOverrideFromUserSettings()
                    : null
                }

                refreshProfiles()
                setStatusMessage(
                  settingsOverrideError
                    ? `Codex OAuth logged out. Warning: could not clear startup provider override (${settingsOverrideError}).`
                    : 'Codex OAuth logged out.',
                )
                break
              }
              case 'logout-xai-oauth': {
                const cleared = clearXaiCredentials()
                if (!cleared.success) {
                  setErrorMessage(
                    cleared.warning ??
                      'Could not clear xAI OAuth credentials.',
                  )
                  break
                }

                setHasStoredXaiOAuthCredentials(false)
                setStoredXaiOAuthProfileId(undefined)
                const xaiProfile = findXaiOAuthProfile(
                  getProviderProfiles(),
                  storedXaiOAuthProfileId,
                )
                let settingsOverrideError: string | null = null
                if (xaiProfile) {
                  const result = deleteProviderProfile(xaiProfile.id)
                  if (!result.removed) {
                    setErrorMessage(
                      'xAI OAuth credentials were cleared, but the xAI profile could not be removed.',
                    )
                    refreshProfiles()
                    break
                  }

                  clearPersistedXaiOAuthProfile()
                  settingsOverrideError = result.activeProfileId
                    ? clearStartupProviderOverrideFromUserSettings()
                    : null
                }

                refreshProfiles()
                setStatusMessage(
                  settingsOverrideError
                    ? `xAI OAuth logged out. Warning: could not clear startup provider override (${settingsOverrideError}).`
                    : 'xAI OAuth logged out.',
                )
                break
              }
              default:
                closeWithCancelled('Provider manager closed')
                break
            }
          }}
          onCancel={() => closeWithCancelled('Provider manager closed')}
          defaultFocusValue={menuFocusValue}
          visibleOptionCount={menuOptions.length}
        />
      </Box>
    )
  }

  function renderProfileSelection(
    title: string,
    emptyMessage: string,
    onSelect: (profileId: string) => void,
    options?: { includeGithub?: boolean; includeAnthropic?: boolean },
  ): React.ReactNode {
    const includeGithub = options?.includeGithub ?? false
    const includeAnthropic = options?.includeAnthropic ?? false
    const selectOptions = profiles.map(profile => ({
      value: profile.id,
      label:
        profile.id === activeProfileId
          ? `${profile.name} (active)`
          : profile.name,
      description: `${getRouteProviderTypeLabel(resolveProfileRoute(profile.provider).routeId)} · ${profile.baseUrl} · ${profile.model}`,
    }))

    if (includeGithub && githubProviderAvailable) {
      selectOptions.push({
        value: GITHUB_PROVIDER_ID,
        label: isGithubActive
          ? `${GITHUB_PROVIDER_LABEL} (active)`
          : GITHUB_PROVIDER_LABEL,
        description: `github-models · ${GITHUB_PROVIDER_DEFAULT_BASE_URL} · ${getGithubProviderModel()}`,
      })
    }

    // Offer a way back to built-in Anthropic only when a third-party provider
    // (saved profile or GitHub Models) is currently active — otherwise the user
    // is already on Anthropic and the option is a no-op (#1426).
    if (includeAnthropic && (activeProfileId || isGithubActive)) {
      selectOptions.push({
        value: ANTHROPIC_DEFAULT_PROFILE_ID,
        label: 'Use Anthropic (built-in)',
        description:
          'Switch back to Claude now without a restart — saved profiles are kept',
      })
    }

    if (selectOptions.length === 0) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="remember" bold>
            {title}
          </Text>
          <Text dimColor>{emptyMessage}</Text>
          <Select
            options={[
              {
                value: 'back',
                label: 'Back',
                description: 'Return to provider manager',
              },
            ]}
            onChange={() => returnToMenu()}
            onCancel={() => returnToMenu()}
            visibleOptionCount={1}
          />
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          {title}
        </Text>
        <Select
          options={selectOptions}
          onChange={onSelect}
          onCancel={() => returnToMenu()}
          visibleOptionCount={Math.min(10, Math.max(2, selectOptions.length))}
        />
      </Box>
    )
  }

  let content: React.ReactNode

  switch (screen) {
    case 'select-preset':
      content = renderPresetSelection()
      break
    case 'select-ollama-model':
      content = renderOllamaSelection()
      break
    case 'select-atomic-chat-model':
      content = renderAtomicChatSelection()
      break
    case 'xai-oauth':
      content = (
        <XaiOAuthSetup
          onBack={() => setScreen('select-preset')}
          onConfigured={async (tokens, persistCredentials) => {
            const payload: ProviderProfileInput = {
              provider: 'xai',
              name: XAI_OAUTH_PROVIDER_NAME,
              baseUrl: XAI_OAUTH_PROVIDER_BASE_URL,
              model: XAI_OAUTH_PROVIDER_MODEL,
              apiKey: '',
            }

            const existing = findXaiOAuthProfile(
              getProviderProfiles(),
              storedXaiOAuthProfileId,
            )
            const saved = existing
              ? updateProviderProfile(existing.id, payload)
              : addProviderProfile(payload, { makeActive: false })

            if (!saved) {
              setErrorMessage(
                'xAI OAuth login finished, but the provider profile could not be saved.',
              )
              returnToMenu()
              return
            }

            const active =
              activeProfileId === saved.id
                ? saved
                : setActiveProviderProfile(saved.id)

            if (!active) {
              setErrorMessage(
                'xAI OAuth login finished, but the provider could not be set as the startup provider.',
              )
              returnToMenu()
              return
            }

            persistCredentials()
            const settingsOverrideError =
              clearStartupProviderOverrideFromUserSettings()
            const activationWarning = await activateXaiOAuthSession({
              model: saved.model,
            })
            // Update the running session's model — otherwise the next
            // request keeps hitting the previous provider's model name
            // (e.g. kimi-k2.6) and gets a 400 "Model not found" against
            // api.x.ai. Mirrors the activateSelectedProvider /
            // saveAndCloseProvider flows.
            setAppState(prev => ({
              ...prev,
              mainLoopModel: getPrimaryModel(saved.model),
              mainLoopModelForSession: null,
            }))
            setHasStoredXaiOAuthCredentials(true)
            setStoredXaiOAuthProfileId(saved.id)
            refreshProfiles()
            const warnings = [
              activationWarning,
              settingsOverrideError
                ? `could not clear startup provider override (${settingsOverrideError})`
                : null,
            ].filter((warning): warning is string => Boolean(warning))
            const message = buildXaiOAuthActivationMessage({
              prefix: 'xAI OAuth configured',
              activationWarning,
              warnings,
            })

            if (mode === 'first-run') {
              onDone({
                action: 'saved',
                activeProfileId: active.id,
                message,
              })
              return
            }

            setStatusMessage(message)
            setErrorMessage(undefined)
            returnToMenu()
          }}
        />
      )
      break
    case 'codex-oauth':
      content = (
        <CodexOAuthSetup
          onBack={() => setScreen('select-preset')}
          onConfigured={async (tokens, persistCredentials) => {
            const payload: ProviderProfileInput = {
              provider: 'openai',
              name: CODEX_OAUTH_PROVIDER_NAME,
              baseUrl: DEFAULT_CODEX_BASE_URL,
              model: CODEX_OAUTH_PROVIDER_MODEL,
              apiKey: '',
            }

            const existing = findCodexOAuthProfile(
              getProviderProfiles(),
              storedCodexOAuthProfileId,
            )
            const saved = existing
              ? updateProviderProfile(existing.id, payload)
              : addProviderProfile(payload, { makeActive: false })

            if (!saved) {
              setErrorMessage(
                'Codex OAuth login finished, but the provider profile could not be saved.',
              )
              returnToMenu()
              return
            }

            const active =
              activeProfileId === saved.id
                ? saved
                : setActiveProviderProfile(saved.id)
            if (!active) {
              setErrorMessage(
                'Codex OAuth login finished, but the provider could not be set as the startup provider.',
              )
              returnToMenu()
              return
            }

            const persistenceResult = persistCredentials({
              profileId: saved.id,
            })
            const storageWarning =
              persistenceResult && typeof persistenceResult === 'object'
                ? persistenceResult.warning
                : null
            const settingsOverrideError =
              clearStartupProviderOverrideFromUserSettings()
            const activationWarning = await activateCodexOAuthSession(tokens)
            setHasStoredCodexOAuthCredentials(true)
            setStoredCodexOAuthProfileId(saved.id)
            refreshProfiles()
            const warnings = [
              storageWarning,
              activationWarning,
              settingsOverrideError
                ? `could not clear startup provider override (${settingsOverrideError})`
                : null,
            ].filter((warning): warning is string => Boolean(warning))
            const message = buildCodexOAuthActivationMessage({
              prefix: 'Codex OAuth configured',
              activationWarning,
              warnings,
            })

            if (mode === 'first-run') {
              onDone({
                action: 'saved',
                activeProfileId: active.id,
                message,
              })
              return
            }

            setStatusMessage(message)
            setErrorMessage(undefined)
            returnToMenu()
          }}
        />
      )
      break
    case 'form':
      content = renderForm()
      break
    case 'preset-model':
      content = renderPresetModel()
      break
    case 'aimlapi-api-key-choice':
      content = renderAimlapiApiKeyChoice()
      break
    case 'aimlapi-configured':
      content = renderAimlapiConfigured()
      break
    case 'aimlapi-topup-email':
      content = renderAimlapiTopupEmail()
      break
    case 'aimlapi-signin-code':
      content = renderAimlapiSignInCode()
      break
    case 'aimlapi-low-balance':
      content = renderAimlapiLowBalance()
      break
    case 'aimlapi-topup-amount':
      content = renderAimlapiTopupAmount()
      break
    case 'aimlapi-topup-progress':
      content = renderAimlapiTopupProgress()
      break
    case 'aimlapi-done':
      content = renderAimlapiDone()
      break
    case 'preset-api-key':
      content = renderPresetApiKey()
      break
    case 'select-active':
      content = renderProfileSelection(
        'Set active provider',
        'No providers available. Add one first.',
        profileId => {
          void activateSelectedProvider(profileId)
        },
        { includeGithub: true, includeAnthropic: true },
      )
      break
    case 'select-edit':
      content = renderProfileSelection(
        'Edit provider',
        'No providers available. Add one first.',
        profileId => {
          startEditProfile(profileId)
        },
      )
      break
    case 'select-delete':
      content = renderProfileSelection(
        'Delete provider',
        'No providers available. Add one first.',
        profileId => {
          if (profileId === GITHUB_PROVIDER_ID) {
            const githubDeleteError = deleteGithubProvider()
            if (githubDeleteError) {
              setErrorMessage(`Could not delete GitHub provider: ${githubDeleteError}`)
            } else {
              refreshProfiles()
              setStatusMessage('GitHub provider deleted')
            }
            returnToMenu()
            return
          }

          const deletedCodexOAuthProfile =
            findCodexOAuthProfile(
              profiles,
              storedCodexOAuthProfileId,
            )?.id === profileId
          const deletedXaiOAuthProfile =
            findXaiOAuthProfile(
              profiles,
              storedXaiOAuthProfileId,
            )?.id === profileId
          const result = deleteProviderProfile(profileId)
          if (!result.removed) {
            setErrorMessage('Could not delete provider.')
          } else {
            if (deletedCodexOAuthProfile) {
              const cleared = clearCodexCredentials()
              if (!cleared.success) {
                setErrorMessage(
                  cleared.warning ??
                    'Provider deleted, but Codex OAuth credentials could not be cleared.',
                )
              } else {
                setStoredCodexOAuthProfileId(undefined)
              }
              clearPersistedCodexOAuthProfile()
            }
            if (deletedXaiOAuthProfile) {
              const cleared = clearXaiCredentials()
              if (!cleared.success) {
                setErrorMessage(
                  cleared.warning ??
                    'Provider deleted, but xAI OAuth credentials could not be cleared.',
                )
              } else {
                setStoredXaiOAuthProfileId(undefined)
                setHasStoredXaiOAuthCredentials(false)
              }
              clearPersistedXaiOAuthProfile()
            }
            const settingsOverrideError = result.activeProfileId
              ? clearStartupProviderOverrideFromUserSettings()
              : null
            refreshProfiles()
            setStatusMessage(
              settingsOverrideError
                ? `Provider deleted. Warning: could not clear startup provider override (${settingsOverrideError}).`
                : 'Provider deleted',
            )
          }
          returnToMenu()
        },
        { includeGithub: true },
      )
      break
    case 'menu':
    default:
      content = renderMenu()
      break
  }

  return (
    <Pane color="permission">
      {isInitializing ? (
        <Box flexDirection="column" gap={1}>
          <Text color="remember" bold>Loading providers...</Text>
          <Text dimColor>Reading provider profiles from disk.</Text>
        </Box>
      ) : isActivating ? (
        <Box flexDirection="column" gap={1}>
          <Text color="remember" bold>Activating provider...</Text>
          <Text dimColor>Please wait while the provider is being configured.</Text>
        </Box>
      ) : (
        content
      )}
    </Pane>
  )
}
