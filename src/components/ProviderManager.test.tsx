import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import React from 'react'
import { stripVTControlCharacters as stripAnsi } from 'node:util'

import { createRoot } from '../ink.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../state/AppState.js'
import { AIMLAPI_MESSAGES } from '../integrations/aimlapi/messages.js'
import { aimlapiByKeyIdentity } from '../integrations/aimlapi/topupState.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

type SettingsModule = typeof import('../utils/settings/settings.js')
type ProviderStartupOverridesModule = typeof import('../utils/providerStartupOverrides.js')

const actualSettingsModule = (await import(
  `../utils/settings/settings.ts?providerManagerSettingsActual=${Date.now()}-${Math.random()}`
)) as SettingsModule
const actualProviderStartupOverridesModule = (await import(
  `../utils/providerStartupOverrides.ts?providerManagerStartupOverridesActual=${Date.now()}-${Math.random()}`
)) as ProviderStartupOverridesModule
const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'

const ORIGINAL_ENV = {
  CLAUDE_CODE_SIMPLE: process.env.CLAUDE_CODE_SIMPLE,
  CLAUDE_CODE_USE_GITHUB: process.env.CLAUDE_CODE_USE_GITHUB,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  GH_TOKEN: process.env.GH_TOKEN,
  AIMLAPI_EMAIL: process.env.AIMLAPI_EMAIL,
  AIMLAPI_CODE: process.env.AIMLAPI_CODE,
  AIMLAPI_API_KEY: process.env.AIMLAPI_API_KEY,
  AIMLAPI_INFERENCE_URL: process.env.AIMLAPI_INFERENCE_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_API_KEYS: process.env.OPENAI_API_KEYS,
}

function extractLastFrame(output: string): string {
  let lastFrame: string | null = null
  let cursor = 0

  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor)
    if (start === -1) {
      break
    }

    const contentStart = start + SYNC_START.length
    const end = output.indexOf(SYNC_END, contentStart)
    if (end === -1) {
      break
    }

    const frame = output.slice(contentStart, end)
    if (frame.trim().length > 0) {
      lastFrame = frame
    }
    cursor = end + SYNC_END.length
  }

  return lastFrame ?? output
}

function createTestStreams(): {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  getOutput: () => string
} {
  let output = ''
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }

  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  return {
    stdout,
    stdin,
    getOutput: () => output,
  }
}

async function waitForCondition(
  predicate: () => boolean,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  // Default generously: the predicate is polled every 10ms and returns as soon
  // as it is satisfied, so a higher ceiling only adds patience for a slow/loaded
  // CI runner (it never slows a passing wait) and keeps the Ink-driven GUI flows
  // from flaking when a render lands a little late.
  const timeoutMs = options?.timeoutMs ?? 5000
  const intervalMs = options?.intervalMs ?? 10
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return
    }
    await Bun.sleep(intervalMs)
  }

  throw new Error('Timed out waiting for ProviderManager test condition')
}

// Provider list is sorted from generated preset metadata by description, with
// Twigpine Opengateway pinned first, aimlapi.com second, Anthropic third, Codex OAuth injected
// after DeepSeek, and Custom always pinned last. Keep the target-by-label
// indirection here so
// these tests survive future list edits without hardcoding raw key counts.
//
// Order matches ProviderManager.renderPresetSelection() when
// canUseCodexOAuth === true (default in mocked tests).
const PRESET_ORDER = [
  'Twigpine Opengateway',
  'aimlapi.com',
  'Anthropic',
  'Alibaba Coding Plan (China)',
  'Alibaba Coding Plan',
  'ApiSmart',
  'Atlas Cloud',
  'Azure OpenAI',
  'Bankr',
  'ClinePass',
  'Cloudflare Workers AI',
  'Command Code',
  'Concentrate',
  'DeepSeek',
  'Codex OAuth',
  'xAI OAuth (Grok)',
  'Fireworks AI',
  'Google AI / Gemini',
  'Groq',
  'Hicap',
  'LLMTR',
  'LM Studio',
  'Atomic Chat',
  'Ollama',
  'LongCat',
  'MiniMax',
  'Mistral AI',
  'Moonshot AI - API',
  'Moonshot AI - Kimi Code',
  'NEAR AI',
  'NVIDIA NIM',
  'OpenAI',
  'OpenCode Go',
  'OpenCode Zen',
  'OpenRouter',
  'Together AI',
  'Venice',
  'xAI',
  'Xiaomi MiMo',
  'Xiaomi MiMo (Token Plan)',
  'Z.AI - GLM Coding Plan',
  'Custom (OpenAI-compatible)',
  'Custom (Anthropic-compatible)',
] as const

async function navigateToPreset(
  stdin: { write: (data: string) => void },
  label: (typeof PRESET_ORDER)[number],
): Promise<void> {
  const index = PRESET_ORDER.indexOf(label)
  if (index < 0) throw new Error(`Unknown preset label: ${label}`)
  for (let i = 0; i < index; i++) {
    stdin.write('j')
    await Bun.sleep(25)
  }
}

function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

function mockProviderProfilesModule(options?: {
  addProviderProfile?: (...args: unknown[]) => unknown
  getActiveProviderProfile?: () => unknown
  getProviderProfiles?: () => unknown[]
  updateProviderProfile?: (...args: unknown[]) => unknown
  setActiveProviderProfile?: (...args: unknown[]) => unknown
}): void {
  mock.module('../utils/providerProfiles.js', () => ({
    addProviderProfile: options?.addProviderProfile ?? (() => null),
    applyActiveProviderProfileFromConfig: () => {},
    deleteProviderProfile: () => ({ removed: false, activeProfileId: null }),
    getActiveProviderProfile: options?.getActiveProviderProfile ?? (() => null),
    getProviderPresetDefaults: (preset: string) => {
      if (preset === 'ollama') {
        return {
          provider: 'openai',
          name: 'Ollama',
          baseUrl: 'http://localhost:11434/v1',
          model: 'llama3.1:8b',
          apiKey: '',
          requiresApiKey: false,
        }
      }

      if (preset === 'atomic-chat') {
        return {
          provider: 'openai',
          name: 'Atomic Chat',
          baseUrl: 'http://127.0.0.1:1337/v1',
          model: 'Qwen3_5-4B_Q4_K_M',
          apiKey: '',
          requiresApiKey: false,
        }
      }

      if (preset === 'custom') {
        return {
          provider: 'custom',
          name: 'Custom OpenAI-compatible',
          baseUrl: 'http://localhost:11434/v1',
          model: 'custom-model',
          apiKey: '',
          requiresApiKey: true,
        }
      }

      if (preset === 'custom-anthropic') {
        return {
          provider: 'custom-anthropic',
          name: 'Custom (Anthropic-compatible)',
          baseUrl: 'https://anthropic-proxy.example',
          model: 'claude-sonnet-4-6',
          apiKey: '',
          requiresApiKey: true,
        }
      }

      if (preset === 'azure-openai') {
        return {
          provider: 'azure-openai',
          name: 'Azure OpenAI',
          baseUrl: 'https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1',
          model: 'YOUR-DEPLOYMENT-NAME',
          apiKey: '',
          requiresApiKey: true,
        }
      }

      if (preset === 'openai') {
        return {
          provider: 'openai',
          name: 'OpenAI',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-5.4',
          apiKey: '',
          requiresApiKey: true,
        }
      }

      if (preset === 'aimlapi') {
        return {
          provider: 'aimlapi',
          name: 'aimlapi.com',
          baseUrl: 'https://api.aimlapi.com/v1',
          model: 'gpt-4o',
          apiKey: '',
          requiresApiKey: true,
        }
      }

      if (preset === 'minimax') {
        return {
          provider: 'minimax',
          name: 'MiniMax',
          baseUrl: 'https://api.minimax.io/anthropic',
          model: 'MiniMax-M2.7',
          apiKey: '',
          requiresApiKey: true,
        }
      }

      if (preset === 'hicap') {
        return {
          provider: 'hicap',
          name: 'Hicap',
          baseUrl: 'https://api.hicap.ai/v1',
          model: 'claude-opus-4.8',
          apiKey: '',
          requiresApiKey: true,
        }
      }

      if (preset === 'llmtr') {
        return {
          provider: 'llmtr',
          name: 'LLMTR',
          baseUrl: 'https://llmtr.com/v1',
          model: 'deepseek/deepseek-v4-flash',
          apiKey: '',
          requiresApiKey: true,
        }
      }

      if (preset === 'commandcode') {
        return {
          provider: 'commandcode',
          name: 'Command Code',
          baseUrl: 'https://api.commandcode.ai/provider/v1',
          model: 'deepseek/deepseek-v4-flash',
          apiKey: '',
          requiresApiKey: true,
        }
      }

      return {
        provider: 'openai',
        name: 'Mock provider',
        baseUrl: 'http://localhost:11434/v1',
        model: 'mock-model',
        apiKey: '',
        requiresApiKey: true,
      }
    },
    getProviderProfiles: options?.getProviderProfiles ?? (() => []),
    setActiveProviderProfile: options?.setActiveProviderProfile ?? (() => null),
    updateProviderProfile: options?.updateProviderProfile ?? (() => null),
  }))
}

function mockProviderManagerDependencies(
  githubSyncRead: () => string | undefined,
  githubAsyncRead: () => Promise<string | undefined>,
  options?: {
    addProviderProfile?: (...args: any[]) => unknown
    applySavedProfileToCurrentSession?: (...args: any[]) => Promise<string | null>
    clearCodexCredentials?: () => { success: boolean; warning?: string }
    getActiveProviderProfile?: () => unknown
    getProviderProfiles?: () => unknown[]
    probeRouteReadiness?: (
      routeId: string,
      options?: { baseUrl?: string; model?: string; timeoutMs?: number; apiKey?: string },
    ) => Promise<unknown>
    probeOllamaGenerationReadiness?: () => Promise<{
      state: 'ready' | 'unreachable' | 'no_models' | 'generation_failed'
      models: Array<
        {
          name: string
          sizeBytes?: number | null
          family?: string | null
          families?: string[]
          parameterSize?: string | null
          quantizationLevel?: string | null
        }
      >
      probeModel?: string
      detail?: string
    }>
    codexSyncRead?: () => unknown
    codexAsyncRead?: () => Promise<unknown>
    updateProviderProfile?: (...args: any[]) => unknown
    setActiveProviderProfile?: (...args: any[]) => unknown
    provisionAimlapiKey?: (...args: any[]) => Promise<unknown>
    topUpAimlapiByApiKey?: (...args: any[]) => Promise<unknown>
    beginAimlapiEmailOnboarding?: (...args: any[]) => Promise<unknown>
    completeAimlapiCodeSignIn?: (...args: any[]) => Promise<unknown>
    validateAimlapiApiKey?: (...args: any[]) => Promise<unknown>
    claimAimlapiTopupStateAsync?: (...args: any[]) => unknown
    clearAimlapiTopupStateAsync?: (...args: any[]) => unknown
    recordAimlapiCheckoutSessionAsync?: (...args: any[]) => unknown
    resetAimlapiCheckoutSessionAsync?: (...args: any[]) => unknown
    saveAimlapiTopupStateAsync?: (...args: any[]) => unknown
    reconcileSettledAimlapiTopupStateAsync?: (...args: any[]) => unknown
    loadAimlapiSignInKey?: (...args: any[]) => unknown
    saveAimlapiSignInKeyAsync?: (...args: any[]) => unknown
    clearAimlapiSignInKeyAsync?: (...args: any[]) => unknown
    useCodexOAuthFlow?: (options: {
      onAuthenticated: (
        tokens: {
          accessToken: string
          refreshToken: string
          accountId?: string
          idToken?: string
          apiKey?: string
        },
        persistCredentials: (options?: {
          profileId?: string
        }) => { warning?: string } | void,
      ) => void | Promise<void>
    }) => {
      state: 'starting' | 'waiting' | 'error'
      authUrl?: string
      browserOpened?: boolean | null
      message?: string
      submitManualCallback?: (input: string) => {
        ok: boolean
        error?: string
      }
    }
  },
): void {
  let persistedAimlapiTopup: Record<string, unknown> | undefined
  let aimlapiPaymentSequence = 0
  const matchesAimlapiIntent = (
    state: Record<string, unknown> | undefined,
    intent: Record<string, unknown>,
  ): boolean =>
    Boolean(state) && Object.keys(intent).every(key => state?.[key] === intent[key])

  mockProviderProfilesModule({
    addProviderProfile: options?.addProviderProfile,
    getActiveProviderProfile: options?.getActiveProviderProfile,
    getProviderProfiles: options?.getProviderProfiles,
    updateProviderProfile: options?.updateProviderProfile,
    setActiveProviderProfile: options?.setActiveProviderProfile,
  })

  mock.module('../utils/providerDiscovery.js', () => ({
  }))

  mock.module('../integrations/discoveryService.js', () => ({
    probeRouteReadiness:
      options?.probeRouteReadiness ??
      (async (routeId: string) => {
        if (routeId === 'ollama') {
          return (
            options?.probeOllamaGenerationReadiness?.() ?? {
              state: 'unreachable' as const,
              models: [],
            }
          )
        }

        if (routeId === 'atomic-chat') {
          return {
            state: 'unreachable' as const,
          }
        }

        return null
      }),
  }))

  mock.module('../utils/githubModelsCredentials.js', () => ({
    clearGithubModelsToken: () => ({ success: true }),
    GITHUB_MODELS_HYDRATED_ENV_MARKER: 'CLAUDE_CODE_GITHUB_TOKEN_HYDRATED',
    hydrateGithubModelsTokenFromSecureStorage: () => {},
    readGithubModelsToken: githubSyncRead,
    readGithubModelsTokenAsync: githubAsyncRead,
  }))

  mock.module('../utils/codexCredentials.js', () => ({
    attachCodexProfileIdToStoredCredentials: () => ({ success: true }),
    clearCodexCredentials:
      options?.clearCodexCredentials ?? (() => ({ success: true })),
    readCodexCredentials:
      options?.codexSyncRead ?? (() => undefined),
    readCodexCredentialsAsync:
      options?.codexAsyncRead ?? (async () => undefined),
  }))

  mock.module('../utils/providerProfile.js', () => ({
    applySavedProfileToCurrentSession:
      options?.applySavedProfileToCurrentSession ?? (async () => null),
    buildCodexOAuthProfileEnv: (tokens: {
      accessToken: string
      accountId?: string
      idToken?: string
    }) => {
      const accountId =
        tokens.accountId ??
        (tokens.idToken ? 'acct_from_id_token' : undefined) ??
        (tokens.accessToken ? 'acct_from_access_token' : undefined)

      if (!accountId) {
        return null
      }

      return {
        OPENAI_BASE_URL: 'https://chatgpt.com/backend-api/codex',
        OPENAI_MODEL: 'codexplan',
        CHATGPT_ACCOUNT_ID: accountId,
        CODEX_CREDENTIAL_SOURCE: 'oauth' as const,
      }
    },
    clearPersistedCodexOAuthProfile: () => null,
    createProfileFile: (profile: string, env: Record<string, unknown>) => ({
      profile,
      env,
      createdAt: '2026-04-10T00:00:00.000Z',
    }),
  }))

  mock.module('../utils/settings/settings.js', () => ({
    ...actualSettingsModule,
    updateSettingsForSource: () => ({ error: null }),
  }))

  mock.module('./providerManagerAimlapi.js', () => ({
    AIMLAPI_MESSAGES,
    AimlapiApiError: class AimlapiApiError extends Error {
      constructor(
        message: string,
        readonly status: number,
        readonly body = '',
      ) {
        super(message)
      }
    },
    beginAimlapiEmailOnboarding:
      options?.beginAimlapiEmailOnboarding ??
      (async () => ({ action: 'new-account', sessionToken: 'session_test' })),
    completeAimlapiCodeSignIn:
      options?.completeAimlapiCodeSignIn ??
      (async () => ({
        sessionToken: 'session_test',
        apiKey: 'issued_test',
        apiKeyId: 'key_test',
        balanceStatus: 'confirmed' as const,
        lowBalance: false,
      })),
    validateAimlapiApiKey:
      options?.validateAimlapiApiKey ??
      (async () => ({ balance: 25, lowBalance: false, lowBalanceThreshold: 20 })),
    claimAimlapiTopupStateAsync:
      options?.claimAimlapiTopupStateAsync ??
      (async (intent: Record<string, unknown>) => {
        if (matchesAimlapiIntent(persistedAimlapiTopup, intent)) {
          return {
            paymentSessionId: persistedAimlapiTopup?.paymentSessionId,
            resumeSessionToken: persistedAimlapiTopup?.resumeSessionToken,
          }
        }
        persistedAimlapiTopup = {
          ...intent,
          paymentSessionId: `payment-${++aimlapiPaymentSequence}`,
          resumeSessionToken: '',
        }
        return {
          paymentSessionId: persistedAimlapiTopup.paymentSessionId,
          resumeSessionToken: '',
        }
      }),
    clearAimlapiTopupStateAsync:
      options?.clearAimlapiTopupStateAsync ??
      (async (intent: Record<string, unknown>) => {
        if (matchesAimlapiIntent(persistedAimlapiTopup, intent)) {
          persistedAimlapiTopup = undefined
        }
      }),
    saveAimlapiTopupStateAsync:
      options?.saveAimlapiTopupStateAsync ??
      (async (state: Record<string, unknown>) => {
        // Mirror the real CAS (saveTopupStateOperation): a slot that no longer
        // matches this intent + payment id is left untouched, and a
        // first-writer-wins resumeSessionToken/apiKey survive a caller whose
        // in-memory copy is still empty — the sibling
        // recordAimlapiCheckoutSessionAsync mock below models the same rule.
        const matchable: Record<string, unknown> = { ...state }
        for (const key of [
          'resumeSessionToken',
          'apiKey',
          'apiKeyId',
          'model',
          'settled',
          'exchange',
          'exchangeLeaseOwner',
          'exchangeLeaseAt',
          'keyMintLeaseOwner',
          'keyMintLeaseAt',
        ]) {
          delete matchable[key]
        }
        if (!matchesAimlapiIntent(persistedAimlapiTopup, matchable)) return
        const existingToken = persistedAimlapiTopup?.resumeSessionToken
        const existingApiKey = persistedAimlapiTopup?.apiKey
        persistedAimlapiTopup = {
          ...state,
          resumeSessionToken:
            (typeof existingToken === 'string' && existingToken.trim() && existingToken) ||
            state.resumeSessionToken,
          apiKey:
            (typeof existingApiKey === 'string' && existingApiKey.trim() && existingApiKey) ||
            state.apiKey,
          apiKeyId:
            (typeof existingApiKey === 'string' && existingApiKey.trim() && persistedAimlapiTopup?.apiKeyId) ||
            state.apiKeyId,
          // AimlapiCheckoutState (what real callers spread checkoutState from)
          // never carries either lease pair, so a plain checkout save must not
          // drop a peer's in-flight lease — mirrors both merges in
          // topupState.ts (saveTopupStateOperation / recordCheckoutSessionOperation).
          exchangeLeaseOwner: state.exchangeLeaseOwner ?? persistedAimlapiTopup?.exchangeLeaseOwner,
          exchangeLeaseAt: state.exchangeLeaseAt ?? persistedAimlapiTopup?.exchangeLeaseAt,
          keyMintLeaseOwner: state.keyMintLeaseOwner ?? persistedAimlapiTopup?.keyMintLeaseOwner,
          keyMintLeaseAt: state.keyMintLeaseAt ?? persistedAimlapiTopup?.keyMintLeaseAt,
        }
      }),
    recordAimlapiCheckoutSessionAsync:
      options?.recordAimlapiCheckoutSessionAsync ??
      (async (state: Record<string, unknown>) => {
        // Mirror the real semantics: match on the intent + payment id only (not
        // the volatile session token or receipt fields). A slot that no longer
        // matches records nothing and returns null; otherwise the first writer
        // wins and a peer's recorded token is retained.
        const matchable: Record<string, unknown> = { ...state }
        for (const key of [
          'resumeSessionToken',
          'apiKey',
          'apiKeyId',
          'model',
          'settled',
          'exchange',
          'exchangeLeaseOwner',
          'exchangeLeaseAt',
          'keyMintLeaseOwner',
          'keyMintLeaseAt',
        ]) {
          delete matchable[key]
        }
        if (!matchesAimlapiIntent(persistedAimlapiTopup, matchable)) {
          return null
        }
        const existingToken = persistedAimlapiTopup?.resumeSessionToken
        if (typeof existingToken === 'string' && existingToken.trim()) {
          return { ...persistedAimlapiTopup }
        }
        // Same lease-preservation rule as saveAimlapiTopupStateAsync above.
        persistedAimlapiTopup = {
          ...state,
          exchangeLeaseOwner: state.exchangeLeaseOwner ?? persistedAimlapiTopup?.exchangeLeaseOwner,
          exchangeLeaseAt: state.exchangeLeaseAt ?? persistedAimlapiTopup?.exchangeLeaseAt,
          keyMintLeaseOwner: state.keyMintLeaseOwner ?? persistedAimlapiTopup?.keyMintLeaseOwner,
          keyMintLeaseAt: state.keyMintLeaseAt ?? persistedAimlapiTopup?.keyMintLeaseAt,
        }
        return { ...persistedAimlapiTopup }
      }),
    resetAimlapiCheckoutSessionAsync:
      options?.resetAimlapiCheckoutSessionAsync ??
      (async (expected: Record<string, unknown>) => {
        // Mirror the real CAS: match on intent + paymentSessionId, and only
        // reset (mint a fresh payment session, drop the dead resume token)
        // when a minted key is present to retain — otherwise the caller falls
        // back to a full clear.
        if (!matchesAimlapiIntent(persistedAimlapiTopup, expected)) return null
        const apiKey = persistedAimlapiTopup?.apiKey
        if (typeof apiKey !== 'string' || !apiKey.trim()) return null
        const next = {
          ...persistedAimlapiTopup,
          paymentSessionId: `payment-${++aimlapiPaymentSequence}`,
          resumeSessionToken: '',
        }
        persistedAimlapiTopup = next
        return { ...next }
      }),
    reconcileSettledAimlapiTopupStateAsync:
      options?.reconcileSettledAimlapiTopupStateAsync ??
      (async (apiKey: string) => {
        // Mirror the real semantics: match on the by-key intent's identity
        // fingerprint (see aimlapiByKeyIdentity), not on the stored apiKey —
        // an env-sourced credential's settled receipt never stores one.
        const trimmed = apiKey.trim()
        if (!trimmed || !persistedAimlapiTopup?.settled) return
        if (persistedAimlapiTopup.email !== aimlapiByKeyIdentity(trimmed)) return
        persistedAimlapiTopup = undefined
      }),
    aimlapiByKeyIdentity,
    loadAimlapiSignInKey: options?.loadAimlapiSignInKey ?? (() => null),
    saveAimlapiSignInKeyAsync: options?.saveAimlapiSignInKeyAsync ?? (async () => {}),
    clearAimlapiSignInKeyAsync: options?.clearAimlapiSignInKeyAsync ?? (async () => {}),
    parseAimlapiAmountUsd: (value: string | undefined) => {
      const amount = Number(value || 25)
      if (!Number.isFinite(amount) || amount < 20 || amount > 10000) {
        throw new Error('Invalid top-up amount.')
      }
      return Math.round(amount * 100)
    },
    isValidAimlapiEmail: (value: string) => /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(value),
    provisionAimlapiKey:
      options?.provisionAimlapiKey ??
      (async () => {
        throw new Error('Unexpected AI/ML API top-up in test')
      }),
    topUpAimlapiByApiKey:
      options?.topUpAimlapiByApiKey ??
      (async () => {
        throw new Error('Unexpected AI/ML API by-key top-up in test')
      }),
  }))

  mock.module('./useCodexOAuthFlow.js', () => ({
    useCodexOAuthFlow:
      options?.useCodexOAuthFlow ??
      (() => ({
        state: 'waiting' as const,
        authUrl: 'https://chatgpt.com/codex',
        browserOpened: true,
      })),
  }))
}

async function waitForFrameOutput(
  getOutput: () => string,
  predicate: (output: string) => boolean,
  timeoutMs = 5000,
): Promise<string> {
  let output = ''

  await waitForCondition(() => {
    output = stripAnsi(extractLastFrame(getOutput()))
    return predicate(output)
  }, { timeoutMs })

  // The predicate matched, but Ink registers input handlers in an effect that
  // runs after the render commits. A caller that types on the next line can lose
  // the first post-transition keystroke on a loaded runner, stranding the flow.
  // Let the effect flush before returning the (unchanged) matched frame.
  await Bun.sleep(25)
  return output
}

async function mountProviderManager(
  ProviderManager: React.ComponentType<{
    mode: 'first-run' | 'manage'
    onDone: (result?: unknown) => void
  }>,
  options?: {
    mode?: 'first-run' | 'manage'
    onDone?: (result?: unknown) => void
    onChangeAppState?: (args: {
      newState: unknown
      oldState: unknown
    }) => void
  },
): Promise<{
  stdin: PassThrough
  getOutput: () => string
  dispose: () => Promise<void>
}> {
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  root.render(
    <AppStateProvider onChangeAppState={options?.onChangeAppState}>
      <KeybindingSetup>
        <ProviderManager
          mode={options?.mode ?? 'manage'}
          onDone={options?.onDone ?? (() => {})}
        />
      </KeybindingSetup>
    </AppStateProvider>,
  )

  return {
    stdin,
    getOutput,
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await Bun.sleep(0)
    },
  }
}

async function renderProviderManagerFrame(
  ProviderManager: React.ComponentType<{
    mode: 'first-run' | 'manage'
    onDone: (result?: unknown) => void
  }>,
  options?: {
    mode?: 'first-run' | 'manage'
    waitForOutput?: (output: string) => boolean
    timeoutMs?: number
  },
): Promise<string> {
  const mounted = await mountProviderManager(ProviderManager, {
    mode: options?.mode,
  })
  const output = await waitForFrameOutput(
    mounted.getOutput,
    frame => {
      if (!options?.waitForOutput) {
        return frame.includes('Provider manager')
      }
      return options.waitForOutput(frame)
    },
    options?.timeoutMs ?? 2500,
  )

  await mounted.dispose()
  return output
}

beforeEach(async () => {
  await acquireSharedMutationLock('components/ProviderManager.test.tsx')
})

afterEach(() => {
  try {
    mock.restore()
    mock.module('../utils/settings/settings.js', () => actualSettingsModule)
    mock.module('../utils/providerStartupOverrides.js', () => actualProviderStartupOverridesModule)

    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) {
        delete process.env[key as keyof typeof ORIGINAL_ENV]
      } else {
        process.env[key as keyof typeof ORIGINAL_ENV] = value
      }
    }
  } finally {
    releaseSharedMutationLock()
  }
})

test('the mocked saveAimlapiTopupStateAsync/recordAimlapiCheckoutSessionAsync preserve an in-flight key-mint lease', async () => {
  mockProviderManagerDependencies(() => undefined, async () => undefined, {})

  // No cache-busting query string here: this must resolve to the mocked
  // module mock.module just registered, not a fresh (real) one.
  const impl = await import('./providerManagerAimlapi.js')

  const intent = {
    email: 'user@example.com',
    amountUsdMinor: 2500,
    autoTopUp: false,
    partnerId: 'part_test',
    partnerName: 'OpenClaude',
    appBaseUrl: 'https://app.example.test',
    inferenceBaseUrl: 'https://api.example.test/v1',
    payBaseUrl: 'https://pay.example.test',
    verificationBaseUrl: 'https://front.example.test',
  }
  const claimed = (await impl.claimAimlapiTopupStateAsync(intent)) as {
    paymentSessionId: string
  }
  const base = { ...intent, paymentSessionId: claimed.paymentSessionId }

  // A peer process is actively minting (an in-flight key-mint lease).
  await impl.saveAimlapiTopupStateAsync({
    ...base,
    resumeSessionToken: '',
    keyMintLeaseOwner: 'owner-a',
    keyMintLeaseAt: Date.now(),
  })

  // A plain, unrelated checkout save must not drop that lease.
  await impl.saveAimlapiTopupStateAsync({ ...base, resumeSessionToken: '', exchange: false })
  // Elect a checkout session so persistedAimlapiTopup.resumeSessionToken is
  // non-empty, making the next call return a full snapshot to assert against.
  await impl.recordAimlapiCheckoutSessionAsync({ ...base, resumeSessionToken: 'live-session' })
  const snapshot = (await impl.recordAimlapiCheckoutSessionAsync({
    ...base,
    resumeSessionToken: 'a-different-session',
  })) as { keyMintLeaseOwner?: string }

  expect(snapshot.keyMintLeaseOwner).toBe('owner-a')
})

test('ProviderManager resolves GitHub virtual provider from async storage without sync reads in render flow', async () => {
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  const syncRead = mock(() => {
    throw new Error('sync credential read should not run in ProviderManager render flow')
  })
  const asyncRead = mock(async () => 'stored-token')

  mockProviderManagerDependencies(syncRead, asyncRead)

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const output = await renderProviderManagerFrame(ProviderManager, {
    waitForOutput: frame =>
      frame.includes('Provider manager') &&
      frame.includes('GitHub Models') &&
      frame.includes('token stored'),
  })

  expect(output).toContain('Provider manager')
  expect(output).toContain('GitHub Models')
  expect(output).toContain('token stored')
  expect(output).not.toContain('No provider profiles configured yet.')

  expect(syncRead).not.toHaveBeenCalled()
  expect(asyncRead).toHaveBeenCalled()
})

test('ProviderManager avoids first-frame false negative while stored-token lookup is pending', async () => {
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  const syncRead = mock(() => {
    throw new Error('sync credential read should not run in ProviderManager render flow')
  })
  const deferredStoredToken = createDeferred<string | undefined>()
  const asyncRead = mock(async () => deferredStoredToken.promise)

  mockProviderManagerDependencies(syncRead, asyncRead)

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)

  const firstFrame = await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Provider manager'),
  )

  expect(firstFrame).toContain('Checking GitHub Models credentials...')
  expect(firstFrame).not.toContain('No provider profiles configured yet.')

  deferredStoredToken.resolve('stored-token')

  const resolvedFrame = await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('GitHub Models') && frame.includes('token stored'),
  )

  expect(resolvedFrame).toContain('GitHub Models')
  expect(resolvedFrame).toContain('token stored')

  await mounted.dispose()

  expect(syncRead).not.toHaveBeenCalled()
  expect(asyncRead).toHaveBeenCalled()
})

test('ProviderManager shows API mode picker for custom OpenAI-compatible providers', async () => {
  mockProviderManagerDependencies(() => undefined, async () => undefined)

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)

  try {
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Provider manager'),
    )

    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Choose provider preset'),
    )

    await navigateToPreset(mounted.stdin, 'Custom (OpenAI-compatible)')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Create provider profile') &&
      frame.includes('Provider name'),
    )

    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Base URL'),
    )
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Default model'),
    )
    mounted.stdin.write('\r')

    const output = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('API mode') && frame.includes('Automatic'),
    )
    expect(output).toContain('Responses')
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager offers a token field for custom Anthropic-compatible providers', async () => {
  mockProviderManagerDependencies(() => undefined, async () => undefined)

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)

  try {
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Provider manager'),
    )
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Choose provider preset'),
    )
    await navigateToPreset(mounted.stdin, 'Custom (Anthropic-compatible)')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider name'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Base URL'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Default model'))
    mounted.stdin.write('\r')

    const output = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Credential') && frame.includes('Anthropic-compatible API'),
    )
    expect(output).not.toContain('API mode')
    mounted.stdin.write('\r')
    const requiredOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Credential is required.'),
    )
    expect(requiredOutput).toContain('Credential is required.')
    mounted.stdin.write('proxy-token')
    mounted.stdin.write('\r')
    const headersOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Custom headers'),
    )
    expect(headersOutput).toContain('Extra non-auth request headers')
    mounted.stdin.write('\r')
    const placeholderError = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Base URL must be a real Anthropic-compatible endpoint.'),
    )
    expect(placeholderError).toContain(
      'Base URL must be a real Anthropic-compatible endpoint.',
    )
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager keeps full setup flow for presets with placeholder endpoint defaults', async () => {
  mockProviderManagerDependencies(() => undefined, async () => undefined)

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)

  try {
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Provider manager'),
    )

    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Choose provider preset'),
    )

    await navigateToPreset(mounted.stdin, 'Azure OpenAI')
    mounted.stdin.write('\r')
    const nameOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Create provider profile') &&
      frame.includes('Provider name'),
    )

    expect(nameOutput).toContain('Azure OpenAI')
    expect(nameOutput).not.toContain('Step 1 of 2: Default model')

    mounted.stdin.write('\r')
    const baseUrlOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Base URL'),
    )
    expect(baseUrlOutput).toContain('YOUR-RESOURCE-NAME')
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager asks for model and API key when adding OpenAI preset', async () => {
  const addProviderProfile = mock((payload: any) => ({
    id: 'openai_profile',
    ...payload,
  }))

  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    addProviderProfile,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)

  try {
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Provider manager'),
    )

    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Choose provider preset'),
    )

    await navigateToPreset(mounted.stdin, 'OpenAI')
    mounted.stdin.write('\r')
    const modelOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Create provider profile') &&
      frame.includes('Step 1 of 2: Default model'),
    )

    expect(modelOutput).toContain('OpenAI')
    expect(modelOutput).toContain('gpt-5.4')
    expect(modelOutput).not.toContain('Provider name')
    expect(modelOutput).not.toContain('Base URL')
    expect(modelOutput).not.toContain('API mode')
    expect(modelOutput).not.toContain('Custom headers')

    mounted.stdin.write('\r')
    const keyOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Step 2 of 2: API key'),
    )
    expect(keyOutput).not.toContain('Provider name')
    expect(keyOutput).not.toContain('Base URL')
    expect(keyOutput).not.toContain('API mode')
    expect(keyOutput).not.toContain('Custom headers')

    mounted.stdin.write('sk-openai-test')
    await Bun.sleep(25)
    mounted.stdin.write('\r')

    await waitForCondition(() => addProviderProfile.mock.calls.length > 0)
    expect(addProviderProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai',
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.4',
        apiKey: 'sk-openai-test',
        apiFormat: 'responses',
      }),
      expect.objectContaining({ makeActive: true }),
    )
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager adds LLMTR with only model selection and API key', async () => {
  const addProviderProfile = mock((payload: any) => ({
    id: 'llmtr_profile',
    ...payload,
  }))

  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    addProviderProfile,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)

  try {
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Provider manager'),
    )

    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Choose provider preset'),
    )

    await navigateToPreset(mounted.stdin, 'LLMTR')
    mounted.stdin.write('\r')
    const modelOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Create provider profile') &&
      frame.includes('Step 1 of 2: Default model'),
    )

    expect(modelOutput).toContain('LLMTR')
    expect(modelOutput).toContain('deepseek/deepseek-v4-flash')
    expect(modelOutput).not.toContain('Provider name')
    expect(modelOutput).not.toContain('Base URL')
    expect(modelOutput).not.toContain('API mode')
    expect(modelOutput).not.toContain('Custom headers')

    mounted.stdin.write('\r')
    const keyOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Step 2 of 2: API key'),
    )
    expect(keyOutput).not.toContain('Provider name')
    expect(keyOutput).not.toContain('Base URL')
    expect(keyOutput).not.toContain('API mode')
    expect(keyOutput).not.toContain('Custom headers')

    mounted.stdin.write('llmtr-test-key')
    await Bun.sleep(25)
    mounted.stdin.write('\r')

    await waitForCondition(() => addProviderProfile.mock.calls.length > 0)
    expect(addProviderProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'llmtr',
        name: 'LLMTR',
        baseUrl: 'https://llmtr.com/v1',
        model: 'deepseek/deepseek-v4-flash',
        apiKey: 'llmtr-test-key',
        apiFormat: 'chat_completions',
      }),
      expect.objectContaining({ makeActive: true }),
    )
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager adds Command Code with only model selection and API key', async () => {
  const addProviderProfile = mock((payload: any) => ({
    id: 'commandcode_profile',
    ...payload,
  }))

  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    addProviderProfile,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)

  try {
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Provider manager'),
    )

    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Choose provider preset'),
    )

    await navigateToPreset(mounted.stdin, 'Command Code')
    mounted.stdin.write('\r')
    const modelOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Create provider profile') &&
      frame.includes('Step 1 of 2: Default model'),
    )

    expect(modelOutput).toContain('Command Code')
    expect(modelOutput).toContain('deepseek/deepseek-v4-flash')
    expect(modelOutput).not.toContain('Provider name')
    expect(modelOutput).not.toContain('Base URL')
    expect(modelOutput).not.toContain('API mode')
    expect(modelOutput).not.toContain('Custom headers')

    mounted.stdin.write('\r')
    const keyOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Step 2 of 2: API key'),
    )
    expect(keyOutput).not.toContain('Provider name')
    expect(keyOutput).not.toContain('Base URL')
    expect(keyOutput).not.toContain('API mode')
    expect(keyOutput).not.toContain('Custom headers')

    mounted.stdin.write('cmd-test-key')
    await Bun.sleep(25)
    mounted.stdin.write('\r')

    await waitForCondition(() => addProviderProfile.mock.calls.length > 0)
    expect(addProviderProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'commandcode',
        name: 'Command Code',
        baseUrl: 'https://api.commandcode.ai/provider/v1',
        model: 'deepseek/deepseek-v4-flash',
        apiKey: 'cmd-test-key',
        apiFormat: 'chat_completions',
      }),
      expect.objectContaining({ makeActive: true }),
    )
  } finally {
    await mounted.dispose()
  }
})

test.each([',', ';'])(
  'ProviderManager rejects Anthropic-only models after a %s in a Command Code model list',
  async separator => {
    const addProviderProfile = mock((payload: any) => ({
      id: 'commandcode_profile',
      ...payload,
    }))

    mockProviderManagerDependencies(() => undefined, async () => undefined, {
      addProviderProfile,
    })

    const nonce = `${Date.now()}-${Math.random()}`
    const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
    const mounted = await mountProviderManager(ProviderManager)

    try {
      await waitForFrameOutput(mounted.getOutput, frame =>
        frame.includes('Provider manager'),
      )
      mounted.stdin.write('\r')
      await waitForFrameOutput(mounted.getOutput, frame =>
        frame.includes('Choose provider preset'),
      )
      await navigateToPreset(mounted.stdin, 'Command Code')
      mounted.stdin.write('\r')
      await waitForFrameOutput(mounted.getOutput, frame =>
        frame.includes('Step 1 of 2: Default model'),
      )

      mounted.stdin.write('\x7f'.repeat('deepseek/deepseek-v4-flash'.length))
      mounted.stdin.write(
        `deepseek/deepseek-v4-flash${separator} anthropic/claude-sonnet-4-6`,
      )
      await Bun.sleep(25)
      mounted.stdin.write('\r')
      await waitForFrameOutput(mounted.getOutput, frame =>
        frame.includes('Step 2 of 2: API key'),
      )
      mounted.stdin.write('cmd-test-key')
      await Bun.sleep(25)
      mounted.stdin.write('\r')

      const output = await waitForFrameOutput(mounted.getOutput, frame =>
        frame.includes('Anthropic Messages'),
      )
      expect(output).toContain('OpenAI Chat Completions')
      expect(addProviderProfile).not.toHaveBeenCalled()
    } finally {
      await mounted.dispose()
    }
  },
)

test('ProviderManager edits query-bearing LLMTR endpoints with generic proxy controls', async () => {
  const llmtrProxyProfile = {
    id: 'provider_llmtr_proxy',
    provider: 'llmtr',
    name: 'LLMTR query proxy',
    baseUrl: 'https://llmtr.com/v1?tenant=proxy',
    model: 'proxy-model',
    apiKey: undefined,
    apiFormat: 'responses',
    authHeader: 'X-Proxy-Key',
    authScheme: 'raw',
    authHeaderValue: 'proxy-auth-value',
    customHeaders: { 'X-Proxy-Trace': 'enabled' },
  }

  mockProviderManagerDependencies(
    () => undefined,
    async () => undefined,
    {
      getProviderProfiles: () => [llmtrProxyProfile],
      getActiveProviderProfile: () => llmtrProxyProfile,
    },
  )

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)

  try {
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Provider manager') && frame.includes('Edit provider'),
    )

    mounted.stdin.write('j')
    await Bun.sleep(25)
    mounted.stdin.write('j')
    await Bun.sleep(25)
    mounted.stdin.write('\r')

    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Edit provider') &&
      frame.includes('LLMTR query proxy') &&
      !frame.includes('Provider manager'),
    )

    mounted.stdin.write('\r')
    const editOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Edit provider profile') && frame.includes('Step 1 of 8'),
    )

    expect(editOutput).toContain('Advanced: this provider supports custom request headers')
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager saves OpenAI preset GPT-5 models with Responses API', async () => {
  const addProviderProfile = mock((payload: any) => ({
    id: 'openai_profile',
    ...payload,
  }))

  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    addProviderProfile,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)

  try {
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Provider manager'),
    )

    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Choose provider preset'),
    )

    await navigateToPreset(mounted.stdin, 'OpenAI')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Step 1 of 2: Default model'),
    )

    mounted.stdin.write('\u0015')
    await Bun.sleep(25)
    mounted.stdin.write('gpt-5.5')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('gpt-5.5'),
    )
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Step 2 of 2: API key'),
    )

    mounted.stdin.write('sk-openai-test')
    await Bun.sleep(25)
    mounted.stdin.write('\r')

    await waitForCondition(() => addProviderProfile.mock.calls.length > 0)
    expect(addProviderProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai',
        model: 'gpt-5.5',
        apiFormat: 'responses',
      }),
      expect.objectContaining({ makeActive: true }),
    )
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager saves AI/ML API preset with OpenAI-compatible defaults', async () => {
  const addProviderProfile = mock((payload: any) => ({
    id: 'aimlapi_profile',
    ...payload,
  }))
  const validateAimlapiApiKey = mock(async () => ({
    balance: 25,
    lowBalance: false,
    lowBalanceThreshold: 20,
  }))

  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    addProviderProfile,
    validateAimlapiApiKey,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)

  try {
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Provider manager'),
    )

    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Choose provider preset'),
    )

    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    const modelOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Create provider profile') &&
      frame.includes('Step 1 of 2: Default model'),
    )

    expect(modelOutput).toContain('aimlapi.com')
    expect(modelOutput).toContain('gpt-4o')
    expect(modelOutput).not.toContain('Provider name')
    expect(modelOutput).not.toContain('Base URL')

    mounted.stdin.write('\r')
    const choiceOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Do you have an aimlapi.com key?'),
    )
    expect(choiceOutput).toContain('I am a new user')
    expect(choiceOutput).toContain('I already have an aimlapi.com key')
    expect(choiceOutput).not.toContain('One click set up')
    expect(choiceOutput).not.toContain('Proceed to paste the key')

    mounted.stdin.write('j')
    await Bun.sleep(25)
    mounted.stdin.write('\r')
    const apiKeyOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Enter your aimlapi.com key.'),
    )
    expect(apiKeyOutput).toContain(
      'Your API key will be hidden and verified automatically.',
    )
    expect(apiKeyOutput).toContain('API key:')
    expect(apiKeyOutput).not.toContain('Create provider profile')
    expect(apiKeyOutput).not.toContain('Provider type:')
    expect(apiKeyOutput).not.toContain('Step 2 of 2: API key')

    mounted.stdin.write('aimlapi-test-key')
    await Bun.sleep(25)
    mounted.stdin.write('\r')

    await waitForCondition(() => addProviderProfile.mock.calls.length > 0)
    expect(validateAimlapiApiKey).toHaveBeenCalledWith(
      'aimlapi-test-key',
      expect.any(AbortSignal),
      'https://api.aimlapi.com/v1',
    )
    const doneOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Everything is ready.'),
    )
    expect(doneOutput).toContain('Press Enter to continue.')
    expect(addProviderProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'aimlapi',
        name: 'aimlapi.com',
        baseUrl: 'https://api.aimlapi.com/v1',
        model: 'gpt-4o',
        apiKey: 'aimlapi-test-key',
        apiFormat: 'chat_completions',
      }),
      expect.objectContaining({ makeActive: true }),
    )
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager tops up a low-balance saved key by API key, not a new checkout', async () => {
  const addProviderProfile = mock((payload: any) => ({
    id: 'aimlapi_profile',
    ...payload,
  }))
  const validateAimlapiApiKey = mock(async () => ({
    balance: 5,
    lowBalance: true,
    lowBalanceThreshold: 20,
  }))
  const topUpAimlapiByApiKey = mock(async (options: any) => {
    options.onSession?.('by-key-checkout')
    options.onStatus?.('waiting-payment')
    return {
      apiKey: 'aimlapi-test-key',
      apiKeyId: '',
      baseUrl: 'https://api.aimlapi.com/v1',
      model: 'gpt-4o',
    }
  })

  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    addProviderProfile,
    validateAimlapiApiKey,
    topUpAimlapiByApiKey,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)

  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Step 1 of 2: Default model'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Do you have an aimlapi.com key?'))

    mounted.stdin.write('j')
    await Bun.sleep(25)
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your aimlapi.com key.'))
    mounted.stdin.write('aimlapi-test-key')
    await Bun.sleep(25)
    mounted.stdin.write('\r')

    // A low balance routes to the top-up-or-skip choice instead of saving
    // straight away; the default (first) option is "top up".
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes(AIMLAPI_MESSAGES.lowBalance))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))

    // Submit the default amount → charges the EXISTING key by API key, never
    // opening a new passwordless-account checkout.
    mounted.stdin.write('\r')
    await waitForCondition(() => topUpAimlapiByApiKey.mock.calls.length === 1)
    const topUpOptions = topUpAimlapiByApiKey.mock.calls[0]?.[0] as any
    expect(topUpOptions.apiKey).toBe('aimlapi-test-key')
    expect(topUpOptions.paymentSessionId).toEqual(expect.any(String))
    expect(topUpOptions.paymentSessionId).not.toBe('')
    expect(topUpOptions.resumeSessionToken).toBe('')

    await waitForCondition(() => addProviderProfile.mock.calls.length > 0)
    expect(addProviderProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'aimlapi',
        apiKey: 'aimlapi-test-key',
        model: 'gpt-4o',
      }),
      expect.objectContaining({ makeActive: true }),
    )
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Top-up successful - $25 credited to your account'),
    )
  } finally {
    await mounted.dispose()
  }
}, 20_000)

test('ProviderManager tops up and persists a low-balance manually-entered key against the endpoint it was validated on, not the ambient default', async () => {
  // Reproduces the real divergence: existingAimlapiCredential only offers the
  // quick-continue screen for a CANONICAL profile, so the saved profile here
  // must be canonical to even reach it — but the AMBIENT endpoint
  // (AIMLAPI_INFERENCE_URL) is a proxy override. "Set up a new key or switch
  // account" then resets aimlapiInferenceBaseUrl to that ambient proxy, while
  // draft.baseUrl (what the new key is actually validated against) stays at
  // the old profile's canonical endpoint. The top-up and the saved profile
  // must follow the validated (canonical) endpoint, not the ambient proxy
  // aimlapiInferenceBaseUrl was reset to.
  process.env.AIMLAPI_INFERENCE_URL = 'https://proxy.example.test/v1'
  delete process.env.AIMLAPI_API_KEY
  delete process.env.AIMLAPI_EMAIL
  delete process.env.AIMLAPI_CODE
  const profile = {
    id: 'aimlapi_existing',
    provider: 'aimlapi',
    name: 'aimlapi.com',
    baseUrl: 'https://api.aimlapi.com/v1',
    model: 'old-model',
    apiKey: 'old-key',
    apiFormat: 'chat_completions',
  }
  const addProviderProfile = mock((payload: any) => ({
    id: 'aimlapi_profile',
    ...payload,
  }))
  const validateAimlapiApiKey = mock(async () => ({
    balance: 5,
    lowBalance: true,
    lowBalanceThreshold: 20,
  }))
  const topUpAimlapiByApiKey = mock(async (options: any) => {
    options.onSession?.('by-key-checkout')
    options.onStatus?.('waiting-payment')
    return {
      apiKey: 'aimlapi-test-key',
      apiKeyId: '',
      baseUrl: 'https://api.aimlapi.com/v1',
      model: 'gpt-4o',
    }
  })

  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    getProviderProfiles: () => [profile],
    getActiveProviderProfile: () => profile,
    addProviderProfile,
    validateAimlapiApiKey,
    topUpAimlapiByApiKey,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)

  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('aimlapi.com account is already configured'),
    )

    // Select "Set up a new key or switch account" (the second option) —
    // this is what resets aimlapiInferenceBaseUrl to the ambient default
    // while draft.baseUrl keeps the old profile's endpoint.
    const beforeFocusMove = mounted.getOutput()
    mounted.stdin.write('j')
    let previousConfiguredFrame = ''
    await waitForCondition(() => {
      const frame = mounted.getOutput()
      const settled =
        frame !== beforeFocusMove &&
        frame === previousConfiguredFrame &&
        frame.includes('already configured')
      previousConfiguredFrame = frame
      return settled
    })
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Do you have an aimlapi.com key?'))

    mounted.stdin.write('j')
    await Bun.sleep(25)
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your aimlapi.com key.'))
    mounted.stdin.write('aimlapi-test-key')
    await Bun.sleep(25)
    mounted.stdin.write('\r')

    await waitForFrameOutput(mounted.getOutput, frame => frame.includes(AIMLAPI_MESSAGES.lowBalance))
    expect(validateAimlapiApiKey).toHaveBeenCalledWith(
      'aimlapi-test-key',
      expect.any(AbortSignal),
      'https://api.aimlapi.com/v1',
    )
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))

    mounted.stdin.write('\r')
    await waitForCondition(() => topUpAimlapiByApiKey.mock.calls.length === 1)
    const topUpOptions = topUpAimlapiByApiKey.mock.calls[0]?.[0] as any
    expect(topUpOptions.apiKey).toBe('aimlapi-test-key')
    // The endpoint this key was validated against, not the ambient proxy
    // aimlapiInferenceBaseUrl was reset to by "switch account".
    expect(topUpOptions.inferenceBaseUrl).toBe('https://api.aimlapi.com/v1')

    await waitForCondition(() => addProviderProfile.mock.calls.length > 0)
    expect(addProviderProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'aimlapi',
        apiKey: 'aimlapi-test-key',
        baseUrl: 'https://api.aimlapi.com/v1',
      }),
      expect.objectContaining({ makeActive: true }),
    )
  } finally {
    await mounted.dispose()
  }
}, 20_000)

test('ProviderManager offers and reuses an existing AIMLAPI profile', async () => {
  delete process.env.AIMLAPI_API_KEY
  const profile = {
    id: 'aimlapi_existing',
    provider: 'aimlapi',
    name: 'aimlapi.com',
    baseUrl: 'https://api.aimlapi.com/v1',
    model: 'old-model',
    apiKey: 'saved-key',
    apiFormat: 'chat_completions',
  }
  const updateProviderProfile = mock((id: string, payload: any) => ({
    id,
    ...payload,
  }))
  const validateAimlapiApiKey = mock(async () => ({
    balance: 25,
    lowBalance: false,
    lowBalanceThreshold: 20,
  }))
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    getProviderProfiles: () => [profile],
    getActiveProviderProfile: () => profile,
    updateProviderProfile,
    validateAimlapiApiKey,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    const configured = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('aimlapi.com account is already configured'),
    )
    expect(configured).toContain('Continue with your saved API key')
    expect(configured).toContain('Set up a new key or switch account')
    expect(configured).not.toContain('Use existing configuration')
    expect(configured).not.toContain('Configure again')

    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Create provider profile') && frame.includes('Default model'),
    )
    expect(validateAimlapiApiKey).toHaveBeenCalledWith(
      'saved-key',
      expect.any(AbortSignal),
      'https://api.aimlapi.com/v1',
    )
    await Bun.sleep(25)
    mounted.stdin.write('\r')
    await waitForCondition(() => updateProviderProfile.mock.calls.length > 0, {
      timeoutMs: 5000,
    })
    expect(updateProviderProfile).toHaveBeenCalledWith(
      'aimlapi_existing',
      expect.objectContaining({ apiKey: 'saved-key' }),
    )
    // Continuing with a saved key never charges the account, so the done
    // screen must report readiness rather than a phantom top-up.
    const doneOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Everything is ready.'),
    )
    expect(doneOutput).not.toContain('Top-up successful')
    expect(doneOutput).not.toContain('credited to your account')
  } finally {
    await mounted.dispose()
  }
}, 10_000)

test('ProviderManager reconciles a stale settled receipt for this credential when reusing an already-funded saved key', async () => {
  const profile = {
    id: 'aimlapi_existing',
    provider: 'aimlapi',
    name: 'aimlapi.com',
    baseUrl: 'https://api.aimlapi.com/v1',
    model: 'old-model',
    apiKey: 'saved-key',
    apiFormat: 'chat_completions',
  }
  const updateProviderProfile = mock((id: string, payload: any) => ({
    id,
    ...payload,
  }))
  const validateAimlapiApiKey = mock(async () => ({
    balance: 25,
    lowBalance: false,
    lowBalanceThreshold: 20,
  }))
  // A stale receipt left behind by an earlier, now-closed run: it settled a
  // by-key top-up for THIS SAME credential but was never cleared (e.g. the
  // manager closed at the post-payment model picker before this fix).
  const reconcileSettledAimlapiTopupStateAsync = mock(async () => {})

  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    getProviderProfiles: () => [profile],
    getActiveProviderProfile: () => profile,
    updateProviderProfile,
    validateAimlapiApiKey,
    reconcileSettledAimlapiTopupStateAsync,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('aimlapi.com account is already configured'),
    )
    // Default (first) option: "Continue with your saved API key" — this is
    // the balance-shortcut path that skips claiming a checkout entirely, so
    // it must reconcile any stale receipt for this credential itself.
    mounted.stdin.write('\r')

    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Create provider profile') && frame.includes('Default model'),
    )
    expect(reconcileSettledAimlapiTopupStateAsync).toHaveBeenCalledWith('saved-key')
  } finally {
    await mounted.dispose()
  }
}, 10_000)

test('ProviderManager waits for stale-receipt reconciliation before showing the model picker', async () => {
  const profile = {
    id: 'aimlapi_existing',
    provider: 'aimlapi',
    name: 'aimlapi.com',
    baseUrl: 'https://api.aimlapi.com/v1',
    model: 'old-model',
    apiKey: 'saved-key',
    apiFormat: 'chat_completions',
  }
  const validateAimlapiApiKey = mock(async () => ({
    balance: 25,
    lowBalance: false,
    lowBalanceThreshold: 20,
  }))
  // Held open deliberately: reconciliation must be awaited (not fired and
  // forgotten) before the flow moves on, so a genuinely new settlement for
  // this same by-key credential landing in this window can never be raced
  // by a still-in-flight reconcile call from an earlier, unrelated entry.
  let releaseReconcile: (() => void) | undefined
  const reconcileSettledAimlapiTopupStateAsync = mock(
    () => new Promise<void>(resolve => { releaseReconcile = resolve }),
  )

  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    getProviderProfiles: () => [profile],
    getActiveProviderProfile: () => profile,
    validateAimlapiApiKey,
    reconcileSettledAimlapiTopupStateAsync,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('aimlapi.com account is already configured'),
    )
    mounted.stdin.write('\r')

    await waitForCondition(() => reconcileSettledAimlapiTopupStateAsync.mock.calls.length > 0)
    // Reconcile is still pending: the model picker must not have appeared
    // yet, and the screen must still be the non-interactive spinner — not
    // the "Continue with your saved API key" / "Set up a new key" Select,
    // which would let the user start a competing top-up for this same
    // credential while the reconcile is still running unattended.
    await Bun.sleep(50)
    const pendingFrame = stripAnsi(extractLastFrame(mounted.getOutput()))
    expect(pendingFrame).not.toContain('Create provider profile')
    expect(pendingFrame).toContain('Checking balance...')
    expect(pendingFrame).not.toContain('Set up a new key or switch account')

    releaseReconcile?.()
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Create provider profile') && frame.includes('Default model'),
    )
  } finally {
    await mounted.dispose()
  }
}, 10_000)

test('ProviderManager ignores Esc at the configured screen while stale-receipt reconciliation is still pending', async () => {
  const profile = {
    id: 'aimlapi_existing',
    provider: 'aimlapi',
    name: 'aimlapi.com',
    baseUrl: 'https://api.aimlapi.com/v1',
    model: 'old-model',
    apiKey: 'saved-key',
    apiFormat: 'chat_completions',
  }
  const validateAimlapiApiKey = mock(async () => ({
    balance: 25,
    lowBalance: false,
    lowBalanceThreshold: 20,
  }))
  let releaseReconcile: (() => void) | undefined
  const reconcileSettledAimlapiTopupStateAsync = mock(
    () => new Promise<void>(resolve => { releaseReconcile = resolve }),
  )

  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    getProviderProfiles: () => [profile],
    getActiveProviderProfile: () => profile,
    validateAimlapiApiKey,
    reconcileSettledAimlapiTopupStateAsync,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('aimlapi.com account is already configured'),
    )
    mounted.stdin.write('\r')
    await waitForCondition(() => reconcileSettledAimlapiTopupStateAsync.mock.calls.length > 0)
    await Bun.sleep(50)

    // Esc while the reconcile is still pending must be a no-op: escaping to
    // select-preset here would let the user start a brand new top-up for
    // this same credential while the abandoned reconcile (which has no
    // abort signal of its own and keeps running regardless) could still
    // catch and delete that new settlement's receipt.
    mounted.stdin.write('\x1B')
    await Bun.sleep(50)
    expect(stripAnsi(extractLastFrame(mounted.getOutput()))).toContain('Checking balance...')

    releaseReconcile?.()
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Create provider profile') && frame.includes('Default model'),
    )
  } finally {
    await mounted.dispose()
  }
}, 10_000)

test('ProviderManager completes (not strands) a settled by-key top-up when Esc is pressed at the post-payment model picker', async () => {
  const profile = {
    id: 'aimlapi_existing',
    provider: 'aimlapi',
    name: 'aimlapi.com',
    baseUrl: 'https://api.aimlapi.com/v1',
    model: 'old-model',
    apiKey: 'saved-key',
    apiFormat: 'chat_completions',
  }
  const updateProviderProfile = mock((id: string, payload: any) => ({
    id,
    ...payload,
  }))
  const validateAimlapiApiKey = mock(async () => ({
    balance: 5,
    lowBalance: true,
    lowBalanceThreshold: 20,
  }))
  const topUpAimlapiByApiKey = mock(async () => ({
    apiKey: 'saved-key',
    apiKeyId: '',
    baseUrl: 'https://api.aimlapi.com/v1',
    model: 'old-model',
  }))
  const clearAimlapiTopupStateAsync = mock(async () => {})

  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    getProviderProfiles: () => [profile],
    getActiveProviderProfile: () => profile,
    updateProviderProfile,
    validateAimlapiApiKey,
    topUpAimlapiByApiKey,
    clearAimlapiTopupStateAsync,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('aimlapi.com account is already configured'),
    )
    // Default (first) option: "Continue with your saved API key".
    mounted.stdin.write('\r')

    // A low balance routes to the top-up-or-skip choice; the default option
    // is "top up".
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes(AIMLAPI_MESSAGES.lowBalance))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))
    mounted.stdin.write('\r')

    await waitForCondition(() => topUpAimlapiByApiKey.mock.calls.length === 1)

    // Payment settled: the receipt is already persisted, and the flow now
    // routes through the generic model picker to confirm/complete the saved
    // profile — this is the screen the finding says Esc could abandon.
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Create provider profile') && frame.includes('Default model'),
    )

    // Esc here must NOT simply wander back to preset selection: the payment
    // already cleared, so it must complete the pending profile update instead
    // of stranding the settled receipt.
    mounted.stdin.write('\x1B')

    await waitForCondition(() => updateProviderProfile.mock.calls.length > 0)
    expect(updateProviderProfile).toHaveBeenCalledWith(
      'aimlapi_existing',
      expect.objectContaining({ apiKey: 'saved-key' }),
    )
    // The receipt must be cleared as part of that completion — not left
    // behind to block a later, differently-amounted top-up.
    expect(clearAimlapiTopupStateAsync).toHaveBeenCalled()
    const doneOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Top-up successful'),
    )
    expect(doneOutput).not.toContain('Choose provider preset')
  } finally {
    await mounted.dispose()
  }
}, 20_000)

test('ProviderManager switch-account overrides a stale receipt left by an earlier process', async () => {
  delete process.env.AIMLAPI_API_KEY
  delete process.env.AIMLAPI_EMAIL
  delete process.env.AIMLAPI_CODE
  const profile = {
    id: 'aimlapi_existing',
    provider: 'aimlapi',
    name: 'aimlapi.com',
    baseUrl: 'https://api.aimlapi.com/v1',
    model: 'old-model',
    apiKey: 'saved-key',
    apiFormat: 'chat_completions',
  }
  // Simulates a durable on-disk record left by an EARLIER process for a
  // different account — this mount's refs were never populated for it, so
  // only an explicit "switch account" forces the claim through.
  const claimAimlapiTopupStateAsync = mock(
    async (intent: any, options?: { abandonExisting?: boolean }) => {
      if (intent.email === 'old@example.com') {
        return { paymentSessionId: 'stale-payment-id', resumeSessionToken: 'stale-session' }
      }
      if (!options?.abandonExisting) {
        throw new Error(
          "An earlier AI/ML API top-up of $25.00 hasn't finished and may already be paid.",
        )
      }
      return { paymentSessionId: 'new-payment-id', resumeSessionToken: '' }
    },
  )
  const provisionAimlapiKey = mock(async () => await new Promise<never>(() => {}))
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    getProviderProfiles: () => [profile],
    getActiveProviderProfile: () => profile,
    claimAimlapiTopupStateAsync,
    provisionAimlapiKey,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('aimlapi.com account is already configured'),
    )

    // Select "Set up a new key or switch account" (the second option). Wait
    // for the frame to both DIFFER from its pre-keypress snapshot (proof Ink
    // actually processed "j" and re-rendered, not just caught the same old
    // frame twice in a row) and then settle (unchanged across a poll), rather
    // than a fixed delay — so Enter never lands before the highlighted row
    // actually moved and could select "Continue with your saved API key"
    // instead.
    const beforeFocusMove = mounted.getOutput()
    mounted.stdin.write('j')
    let previousConfiguredFrame = ''
    await waitForCondition(() => {
      const frame = mounted.getOutput()
      const settled =
        frame !== beforeFocusMove &&
        frame === previousConfiguredFrame &&
        frame.includes('already configured')
      previousConfiguredFrame = frame
      return settled
    })
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Do you have an aimlapi.com key?'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('I am a new user'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
    mounted.stdin.write('new@example.com')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('new@example.com'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))
    mounted.stdin.write('\r')

    // The claim for the NEW email must go through with abandonExisting: true —
    // not throw the stale receipt's refusal — because the user just explicitly
    // chose to switch accounts.
    await waitForCondition(() => claimAimlapiTopupStateAsync.mock.calls.length > 0)
    const call = claimAimlapiTopupStateAsync.mock.calls.find(
      (c: any) => c[0]?.email === 'new@example.com',
    )
    expect(call?.[1]).toEqual({ abandonExisting: true })
    const output = mounted.getOutput()
    expect(output).not.toContain("hasn't finished")
  } finally {
    await mounted.dispose()
  }
}, 10_000)

test('ProviderManager still discovers a saved canonical-endpoint profile while AIMLAPI_INFERENCE_URL points elsewhere', async () => {
  delete process.env.AIMLAPI_API_KEY
  // A staging/custom endpoint currently configured must not hide a profile
  // that was itself saved against the canonical production endpoint — only
  // sending ITS key to a non-canonical endpoint is what must stay blocked.
  process.env.AIMLAPI_INFERENCE_URL = 'https://proxy.example.test/v1'
  const profile = {
    id: 'aimlapi_existing',
    provider: 'aimlapi',
    name: 'aimlapi.com',
    baseUrl: 'https://api.aimlapi.com/v1',
    model: 'old-model',
    apiKey: 'saved-key',
    apiFormat: 'chat_completions',
  }
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    getProviderProfiles: () => [profile],
    getActiveProviderProfile: () => profile,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    const configured = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('aimlapi.com account is already configured'),
    )
    expect(configured).toContain('Continue with your saved API key')
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager uses OPENAI_API_KEY for an existing keyless AIMLAPI profile', async () => {
  delete process.env.AIMLAPI_API_KEY
  delete process.env.OPENAI_API_KEYS
  process.env.OPENAI_API_KEY = 'openai-fallback-key'
  const profile = {
    id: 'aimlapi_existing',
    provider: 'aimlapi',
    name: 'aimlapi.com',
    baseUrl: 'https://api.aimlapi.com/v1',
    model: 'gpt-4o',
    apiKey: undefined,
    apiFormat: 'chat_completions',
  }
  const validateAimlapiApiKey = mock(async () => ({
    balance: 25,
    lowBalance: false,
    lowBalanceThreshold: 20,
  }))
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    getProviderProfiles: () => [profile],
    getActiveProviderProfile: () => profile,
    validateAimlapiApiKey,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('aimlapi.com account is already configured'),
    )
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Create provider profile') && frame.includes('Default model'),
    )
    expect(validateAimlapiApiKey).toHaveBeenCalledWith(
      'openai-fallback-key',
      expect.any(AbortSignal),
      'https://api.aimlapi.com/v1',
    )
  } finally {
    await mounted.dispose()
  }
}, 10_000)

test('ProviderManager does not send the OPENAI_API_KEY fallback to a custom AIMLAPI endpoint', async () => {
  delete process.env.AIMLAPI_API_KEY
  delete process.env.OPENAI_API_KEYS
  process.env.OPENAI_API_KEY = 'env-runtime-key'
  process.env.AIMLAPI_INFERENCE_URL = 'https://proxy.example.test/v1'
  const addProviderProfile = mock((payload: any) => ({
    id: 'aimlapi_env',
    ...payload,
  }))
  const validateAimlapiApiKey = mock(async () => ({
    balance: 25,
    lowBalance: false,
    lowBalanceThreshold: 20,
  }))
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    addProviderProfile,
    validateAimlapiApiKey,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager, { mode: 'first-run' })
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Set up provider'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Create provider profile') && frame.includes('Default model'),
    )
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Do you have an aimlapi.com key?'),
    )
    expect(validateAimlapiApiKey).not.toHaveBeenCalled()
    expect(addProviderProfile).not.toHaveBeenCalled()
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager refuses guided new-key creation on a custom AIMLAPI endpoint', async () => {
  delete process.env.AIMLAPI_API_KEY
  delete process.env.AIMLAPI_EMAIL
  process.env.AIMLAPI_INFERENCE_URL = 'https://proxy.example.test/v1'
  const beginAimlapiEmailOnboarding = mock(async () => ({ action: 'code-sent' as const }))
  const provisionAimlapiKey = mock(async () => ({
    apiKey: 'issued',
    apiKeyId: 'id',
    baseUrl: 'https://proxy.example.test/v1',
    model: 'gpt-4o',
  }))
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    beginAimlapiEmailOnboarding,
    provisionAimlapiKey,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager, { mode: 'first-run' })
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Set up provider'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Create provider profile') && frame.includes('Default model'),
    )
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Do you have an aimlapi.com key?'),
    )
    // Selecting "I am a new user" must be refused off the canonical endpoint,
    // since guided provisioning would mint a production key against the proxy.
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('production endpoint'))
    expect(beginAimlapiEmailOnboarding).not.toHaveBeenCalled()
    expect(provisionAimlapiKey).not.toHaveBeenCalled()
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager manage flow does not reuse env credentials for a custom AIMLAPI endpoint', async () => {
  delete process.env.AIMLAPI_API_KEY
  delete process.env.OPENAI_API_KEYS
  process.env.OPENAI_API_KEY = 'env-runtime-key'
  process.env.AIMLAPI_INFERENCE_URL = 'https://proxy.example.test/v1'
  const validateAimlapiApiKey = mock(async () => ({
    balance: 25,
    lowBalance: false,
    lowBalanceThreshold: 20,
  }))
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    validateAimlapiApiKey,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Create provider profile') && frame.includes('Default model'),
    )
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Do you have an aimlapi.com key?'),
    )
    expect(validateAimlapiApiKey).not.toHaveBeenCalled()
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager does not persist an invalid or low-balance first-run AIMLAPI env key', async () => {
  process.env.AIMLAPI_API_KEY = 'env-runtime-key'
  process.env.AIMLAPI_INFERENCE_URL = 'https://api.aimlapi.com/v1'

  for (const scenario of ['invalid', 'low-balance'] as const) {
    const addProviderProfile = mock(() => null)
    const validateAimlapiApiKey = mock(async () => {
      if (scenario === 'invalid') {
        throw Object.assign(new Error('Unauthorized'), { status: 401 })
      }
      return { balance: 5, lowBalance: true, lowBalanceThreshold: 20 }
    })
    mockProviderManagerDependencies(() => undefined, async () => undefined, {
      addProviderProfile,
      validateAimlapiApiKey,
    })

    const nonce = `${Date.now()}-${Math.random()}`
    const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
    const mounted = await mountProviderManager(ProviderManager, { mode: 'first-run' })
    try {
      await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Set up provider'))
      await navigateToPreset(mounted.stdin, 'aimlapi.com')
      mounted.stdin.write('\r')
      await waitForFrameOutput(mounted.getOutput, frame =>
        frame.includes('Create provider profile') && frame.includes('Default model'),
      )
      mounted.stdin.write('\r')
      await waitForFrameOutput(mounted.getOutput, frame =>
        scenario === 'invalid'
          ? frame.includes('API key is invalid.')
          : frame.includes('credits are running low'),
      )
      expect(validateAimlapiApiKey).toHaveBeenCalledWith(
        'env-runtime-key',
        expect.any(AbortSignal),
        'https://api.aimlapi.com/v1',
      )
      expect(addProviderProfile).not.toHaveBeenCalled()

      if (scenario === 'invalid') {
        // Re-submitting after a failed env-key validation must re-validate, not
        // short-circuit into persisting the key that just failed: the first-run
        // adoption markers are cleared on failure.
        mounted.stdin.write('\r')
        await waitForCondition(() => validateAimlapiApiKey.mock.calls.length >= 2)
        expect(addProviderProfile).not.toHaveBeenCalled()
      }
    } finally {
      await mounted.dispose()
    }
  }
})

test('ProviderManager never persists an ambient env API key into the top-up receipt', async () => {
  process.env.AIMLAPI_API_KEY = 'env-runtime-key'
  process.env.AIMLAPI_INFERENCE_URL = 'https://api.aimlapi.com/v1'

  const addProviderProfile = mock((payload: any) => ({ id: 'aimlapi_profile', ...payload }))
  const validateAimlapiApiKey = mock(async () => ({
    balance: 5,
    lowBalance: true,
    lowBalanceThreshold: 20,
  }))
  const topUpAimlapiByApiKey = mock(async (options: any) => {
    options.onSession?.('by-key-checkout')
    options.onStatus?.('waiting-payment')
    return {
      apiKey: 'env-runtime-key',
      apiKeyId: '',
      baseUrl: 'https://api.aimlapi.com/v1',
      model: 'gpt-4o',
    }
  })
  const savedStates: any[] = []
  const saveAimlapiTopupStateAsync = mock(async (state: any) => {
    savedStates.push(state)
  })

  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    addProviderProfile,
    validateAimlapiApiKey,
    topUpAimlapiByApiKey,
    saveAimlapiTopupStateAsync,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager, { mode: 'first-run' })
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Set up provider'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Create provider profile') && frame.includes('Default model'),
    )
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('credits are running low'))

    // Default (first) option is "top up".
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))
    mounted.stdin.write('\r')

    await waitForCondition(() => topUpAimlapiByApiKey.mock.calls.length === 1)
    expect(topUpAimlapiByApiKey.mock.calls[0]?.[0]?.apiKey).toBe('env-runtime-key')

    // An env-backed credential routes through the model picker (instead of
    // saving straight away) before the profile is written.
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Default model'))
    mounted.stdin.write('\r')

    await waitForCondition(() => addProviderProfile.mock.calls.length > 0)
    // The eventual profile intentionally stays keyless for an env-backed
    // credential (the runtime env var is used instead) — confirms this test
    // reached the real leak point, not an unrelated early exit.
    expect(addProviderProfile).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'aimlapi', apiKey: '' }),
      expect.anything(),
    )

    // No receipt write along the way ever carried the literal env secret.
    expect(savedStates.length).toBeGreaterThan(0)
    for (const state of savedStates) {
      expect(state.apiKey).not.toBe('env-runtime-key')
    }
  } finally {
    await mounted.dispose()
  }
}, 20_000)

test('ProviderManager rejects an invalid AIMLAPI key using the Zero error copy', async () => {
  const addProviderProfile = mock(() => null)
  const validateAimlapiApiKey = mock(async () => {
    throw Object.assign(new Error('Unauthorized'), { status: 401 })
  })

  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    addProviderProfile,
    validateAimlapiApiKey,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)

  try {
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Provider manager'),
    )
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Choose provider preset'),
    )
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Step 1 of 2: Default model'),
    )
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Do you have an aimlapi.com key?'),
    )
    mounted.stdin.write('j')
    await Bun.sleep(25)
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Enter your aimlapi.com key.'),
    )

    mounted.stdin.write('bad-aimlapi-key')
    await Bun.sleep(25)
    mounted.stdin.write('\r')

    const invalidOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes(
        'API key is invalid. Please make sure you enter a valid aimlapi.com key.',
      ),
    )
    expect(invalidOutput).toContain('Enter your aimlapi.com key.')
    expect(validateAimlapiApiKey).toHaveBeenCalledWith(
      'bad-aimlapi-key',
      expect.any(AbortSignal),
      'https://api.aimlapi.com/v1',
    )
    expect(addProviderProfile).not.toHaveBeenCalled()
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager clears the sign-in cache with the minted key id on a sufficient-balance sign-in', async () => {
  const beginAimlapiEmailOnboarding = mock(async () => ({ action: 'code-sent' as const }))
  const completeAimlapiCodeSignIn = mock(async () => ({
    sessionToken: 'session_test',
    apiKey: 'issued_test',
    apiKeyId: 'minted-key-id',
    balanceStatus: 'confirmed' as const,
    lowBalance: false,
  }))
  const clearAimlapiSignInKeyAsync = mock(async () => {})
  const addProviderProfile = mock((payload: any) => ({ id: 'aimlapi_profile', ...payload }))
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    beginAimlapiEmailOnboarding,
    completeAimlapiCodeSignIn,
    clearAimlapiSignInKeyAsync,
    addProviderProfile,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Step 1 of 2: Default model'),
    )
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Do you have an aimlapi.com key?'),
    )
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
    mounted.stdin.write('stan@aimlapi.com')
    await Bun.sleep(25)
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Enter the 6-digit code sent to stan@aimlapi.com.'),
    )
    // The code screen just transitioned in; wait for it to settle so its input
    // handler is attached before typing, otherwise the digits are dropped and
    // the masked value never renders.
    let previousCodeFrame = ''
    await waitForCondition(() => {
      const frame = mounted.getOutput()
      const settled = frame === previousCodeFrame && frame.includes('6-digit code')
      previousCodeFrame = frame
      return settled
    })
    mounted.stdin.write('123456')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('******'))
    mounted.stdin.write('\r')

    // A sufficient balance auto-persists; the sign-in cache must be cleared with
    // the just-minted key id, not the stale (empty) issued-key-id state that a
    // synchronous onSaved callback would otherwise close over.
    await waitForCondition(() => addProviderProfile.mock.calls.length > 0)
    expect(clearAimlapiSignInKeyAsync).toHaveBeenCalledWith('stan@aimlapi.com', 'minted-key-id')
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager rejects a malformed sign-in code locally instead of calling verifySignInCode', async () => {
  const beginAimlapiEmailOnboarding = mock(async () => ({ action: 'code-sent' as const }))
  const completeAimlapiCodeSignIn = mock(async () => ({
    sessionToken: 'session_test',
    apiKey: 'issued_test',
    apiKeyId: 'minted-key-id',
    balanceStatus: 'confirmed' as const,
    lowBalance: false,
  }))
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    beginAimlapiEmailOnboarding,
    completeAimlapiCodeSignIn,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Step 1 of 2: Default model'),
    )
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Do you have an aimlapi.com key?'),
    )
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
    mounted.stdin.write('stan@aimlapi.com')
    await Bun.sleep(25)
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Enter the 6-digit code sent to stan@aimlapi.com.'),
    )
    let previousCodeFrame = ''
    await waitForCondition(() => {
      const frame = mounted.getOutput()
      const settled = frame === previousCodeFrame && frame.includes('6-digit code')
      previousCodeFrame = frame
      return settled
    })

    // Too short, non-numeric — neither can ever succeed against the
    // documented 6-digit numeric contract, so both must be rejected before
    // reaching completeAimlapiCodeSignIn (which wraps verifySignInCode).
    mounted.stdin.write('12345')
    mounted.stdin.write('\r')
    const rejectedOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes(AIMLAPI_MESSAGES.codeIncorrect),
    )
    expect(rejectedOutput).toContain('Enter the 6-digit code sent to stan@aimlapi.com.')
    expect(completeAimlapiCodeSignIn).not.toHaveBeenCalled()
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager persists a minted sign-in key into the top-up receipt before provisioning', async () => {
  const beginAimlapiEmailOnboarding = mock(async () => ({ action: 'code-sent' as const }))
  const completeAimlapiCodeSignIn = mock(async () => ({
    sessionToken: 'session_test',
    apiKey: 'minted-key',
    apiKeyId: 'minted-id',
    balanceStatus: 'confirmed' as const,
    lowBalance: true,
  }))
  const saveAimlapiTopupStateAsync = mock(async (state: any) => {})
  const provisionAimlapiKey = mock(async () => await new Promise<never>(() => {}))
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    beginAimlapiEmailOnboarding,
    completeAimlapiCodeSignIn,
    saveAimlapiTopupStateAsync,
    provisionAimlapiKey,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Step 1 of 2: Default model'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Do you have an aimlapi.com key?'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
    mounted.stdin.write('stan@aimlapi.com')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('stan@aimlapi.com'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Enter the 6-digit code sent to stan@aimlapi.com.'),
    )
    let previousCodeFrame = ''
    await waitForCondition(() => {
      const frame = mounted.getOutput()
      const settled = frame === previousCodeFrame && frame.includes('6-digit code')
      previousCodeFrame = frame
      return settled
    })
    mounted.stdin.write('123456')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('******'))
    mounted.stdin.write('\r')

    // Low balance routes to the top-up-or-skip choice first; the default
    // (first) option is "top up", which then reaches the amount screen.
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes(AIMLAPI_MESSAGES.lowBalance))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))
    mounted.stdin.write('\r')

    // Before provisioning even resolves (it hangs forever above), the receipt
    // must already carry the key minted at sign-in — not just the separate
    // sign-in-key cache — so a restart right here can still recover it.
    await waitForCondition(() => saveAimlapiTopupStateAsync.mock.calls.length > 0)
    const savedState = saveAimlapiTopupStateAsync.mock.calls[0]?.[0] as any
    expect(savedState.apiKey).toBe('minted-key')
    expect(savedState.apiKeyId).toBe('minted-id')
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager retains a minted key on a terminal session instead of a full clear', async () => {
  const beginAimlapiEmailOnboarding = mock(async () => ({ action: 'code-sent' as const }))
  const completeAimlapiCodeSignIn = mock(async () => ({
    sessionToken: 'session_test',
    apiKey: 'minted-key',
    apiKeyId: 'minted-id',
    balanceStatus: 'confirmed' as const,
    lowBalance: true,
  }))
  const resetAimlapiCheckoutSessionAsync = mock(async (expected: any) => ({
    paymentSessionId: 'fresh-payment-id',
    resumeSessionToken: '',
    apiKey: 'minted-key',
    apiKeyId: 'minted-id',
  }))
  const clearAimlapiTopupStateAsync = mock(async () => {})
  const provisionAimlapiKey = mock(async (options: any) => {
    // A session is elected, then goes terminal (cancelled/expired/dead) before
    // ever settling — the scenario reportSession('') must handle by retaining
    // the minted key instead of wiping the whole receipt.
    options.onSession?.('live-session')
    options.onSession?.('')
    await new Promise(() => {})
    return { apiKey: 'minted-key', apiKeyId: 'minted-id', baseUrl: 'https://api.aimlapi.com/v1', model: 'gpt-4o' }
  })
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    beginAimlapiEmailOnboarding,
    completeAimlapiCodeSignIn,
    resetAimlapiCheckoutSessionAsync,
    clearAimlapiTopupStateAsync,
    provisionAimlapiKey,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Step 1 of 2: Default model'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Do you have an aimlapi.com key?'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
    mounted.stdin.write('stan@aimlapi.com')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('stan@aimlapi.com'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Enter the 6-digit code sent to stan@aimlapi.com.'),
    )
    let previousCodeFrame = ''
    await waitForCondition(() => {
      const frame = mounted.getOutput()
      const settled = frame === previousCodeFrame && frame.includes('6-digit code')
      previousCodeFrame = frame
      return settled
    })
    mounted.stdin.write('123456')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('******'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes(AIMLAPI_MESSAGES.lowBalance))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))
    mounted.stdin.write('\r')

    await waitForCondition(() => resetAimlapiCheckoutSessionAsync.mock.calls.length > 0)
    const resetArg = resetAimlapiCheckoutSessionAsync.mock.calls[0]?.[0] as any
    expect(resetArg.email).toBe('stan@aimlapi.com')
    // The key-retaining reset ran; the full-wipe fallback must NOT also run.
    expect(clearAimlapiTopupStateAsync).not.toHaveBeenCalled()
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager awaits terminal-session receipt cleanup before its onSession callback resolves', async () => {
  const beginAimlapiEmailOnboarding = mock(async () => ({ action: 'code-sent' as const }))
  const completeAimlapiCodeSignIn = mock(async () => ({
    sessionToken: 'session_test',
    apiKey: 'minted-key',
    apiKeyId: 'minted-id',
    balanceStatus: 'confirmed' as const,
    lowBalance: true,
  }))
  let resetSettled = false
  const resetAimlapiCheckoutSessionAsync = mock(async () => {
    // Simulate a contended lock (the real resetAimlapiCheckoutSessionAsync
    // awaits withStateLockAsync): the fix must not let reportSession('')
    // resolve before this lands.
    await new Promise(resolve => setTimeout(resolve, 30))
    resetSettled = true
    return {
      paymentSessionId: 'fresh-payment-id',
      resumeSessionToken: '',
      apiKey: 'minted-key',
      apiKeyId: 'minted-id',
    }
  })
  const clearAimlapiTopupStateAsync = mock(async () => {})
  let cleanupAlreadySettledWhenOnSessionResolved = false
  const provisionAimlapiKey = mock(async (options: any) => {
    options.onSession?.('live-session')
    // Mirrors how the real poll helpers now call this: awaited, so its
    // caller only proceeds once the callback's own work (here, the delayed
    // reset above) has actually finished.
    await options.onSession?.('')
    cleanupAlreadySettledWhenOnSessionResolved = resetSettled
    await new Promise(() => {})
    return {
      apiKey: 'minted-key',
      apiKeyId: 'minted-id',
      baseUrl: 'https://api.aimlapi.com/v1',
      model: 'gpt-4o',
    }
  })
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    beginAimlapiEmailOnboarding,
    completeAimlapiCodeSignIn,
    resetAimlapiCheckoutSessionAsync,
    clearAimlapiTopupStateAsync,
    provisionAimlapiKey,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Step 1 of 2: Default model'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Do you have an aimlapi.com key?'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
    mounted.stdin.write('stan@aimlapi.com')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('stan@aimlapi.com'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Enter the 6-digit code sent to stan@aimlapi.com.'),
    )
    let previousCodeFrame = ''
    await waitForCondition(() => {
      const frame = mounted.getOutput()
      const settled = frame === previousCodeFrame && frame.includes('6-digit code')
      previousCodeFrame = frame
      return settled
    })
    mounted.stdin.write('123456')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('******'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes(AIMLAPI_MESSAGES.lowBalance))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))
    mounted.stdin.write('\r')

    await waitForCondition(() => resetSettled)
    expect(cleanupAlreadySettledWhenOnSessionResolved).toBe(true)
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager matches the AIMLAPI code and low-credit screen copy', async () => {
  const beginAimlapiEmailOnboarding = mock(async () => ({ action: 'code-sent' as const }))
  const completeAimlapiCodeSignIn = mock(async () => ({
    sessionToken: 'session_test',
    apiKey: 'issued_test',
    apiKeyId: 'key_test',
    balanceStatus: 'confirmed' as const,
    lowBalance: true,
  }))
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    beginAimlapiEmailOnboarding,
    completeAimlapiCodeSignIn,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Provider manager'),
    )
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Choose provider preset'),
    )
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Step 1 of 2: Default model'),
    )
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Do you have an aimlapi.com key?'),
    )
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Enter your email.'),
    )
    mounted.stdin.write('stan@aimlapi.com')
    await Bun.sleep(25)
    mounted.stdin.write('\r')

    const codeOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Enter the 6-digit code sent to stan@aimlapi.com.'),
    )
    expect(codeOutput).not.toContain('Enter it below to continue.')
    expect(codeOutput).not.toContain('We sent a 6-digit code')
    mounted.stdin.write('123456')
    // Wait for the masked frame to render rather than a fixed sleep: a slower CI
    // runner may not have painted the six mask characters within a fixed delay.
    const maskedCodeOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('******'),
    )
    expect(maskedCodeOutput).not.toContain('123456')
    expect(maskedCodeOutput).toContain('******')
    mounted.stdin.write('\r')

    const lowCreditOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Your aimlapi.com credits are running low - top up now?'),
    )
    expect(lowCreditOutput).toContain("Sure, let's do that")
    expect(lowCreditOutput).toContain("I'll skip for now")
    expect(lowCreditOutput).not.toContain(
      'It is recommended to top up your balance.',
    )
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager persists the sign-in key through the non-blocking async cache write', async () => {
  const beginAimlapiEmailOnboarding = mock(async () => ({ action: 'code-sent' as const }))
  const completeAimlapiCodeSignIn = mock(async () => ({
    sessionToken: 'session_test',
    apiKey: 'issued_test',
    apiKeyId: 'key_test',
    balanceStatus: 'confirmed' as const,
    lowBalance: false,
  }))
  const saveCalls: unknown[][] = []
  // Hold the save open briefly, like a contended lock would: if the caller
  // still used the synchronous saveAimlapiSignInKey, this delay would freeze
  // Ink's whole event loop instead of just this one awaited call.
  const saveAimlapiSignInKeyAsync = mock(async (...args: unknown[]) => {
    saveCalls.push(args)
    await Bun.sleep(20)
  })
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    beginAimlapiEmailOnboarding,
    completeAimlapiCodeSignIn,
    saveAimlapiSignInKeyAsync,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Step 1 of 2: Default model'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Do you have an aimlapi.com key?'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
    mounted.stdin.write('stan@aimlapi.com')
    await Bun.sleep(25)
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Enter the 6-digit code sent to stan@aimlapi.com.'),
    )
    mounted.stdin.write('123456')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('******'))
    mounted.stdin.write('\r')

    // The save call lands (and its artificial delay resolves) without
    // freezing the render loop — a blocking sync lock would stall the whole
    // process here instead of just this one awaited call, and this poll
    // itself relies on real timers still firing to observe it.
    await waitForCondition(() => saveCalls.length > 0, { timeoutMs: 5000 })
    expect(saveCalls).toEqual([['stan@aimlapi.com', 'issued_test', 'key_test']])
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager does not block the completion screen on a contended sign-in cache clear', async () => {
  const beginAimlapiEmailOnboarding = mock(async () => ({ action: 'code-sent' as const }))
  const completeAimlapiCodeSignIn = mock(async () => ({
    sessionToken: 'session_test',
    apiKey: 'issued_test',
    apiKeyId: 'key_test',
    balanceStatus: 'confirmed' as const,
    lowBalance: false,
  }))
  let clearResolved = false
  // Hold the clear open, like a contended lock would: if persistAimlapiKey's
  // onSaved callback still used the synchronous clearAimlapiSignInKey (or
  // awaited this async one from its own synchronous callback, which it
  // cannot), reaching the done screen would stall behind this delay instead
  // of proceeding immediately.
  const clearAimlapiSignInKeyAsync = mock(async () => {
    await Bun.sleep(200)
    clearResolved = true
  })
  const addProviderProfile = mock((payload: any) => ({ id: 'aimlapi_profile', ...payload }))
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    beginAimlapiEmailOnboarding,
    completeAimlapiCodeSignIn,
    clearAimlapiSignInKeyAsync,
    addProviderProfile,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Step 1 of 2: Default model'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Do you have an aimlapi.com key?'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
    mounted.stdin.write('stan@aimlapi.com')
    await Bun.sleep(25)
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Enter the 6-digit code sent to stan@aimlapi.com.'),
    )
    mounted.stdin.write('123456')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('******'))
    mounted.stdin.write('\r')

    // The done screen must appear well before the 200ms clear resolves — a
    // blocking clear (sync, or awaited from the synchronous onSaved
    // callback) would delay this transition until after clearResolved flips.
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Everything is ready.'))
    expect(clearResolved).toBe(false)

    await waitForCondition(() => clearResolved, { timeoutMs: 5000 })
    expect(clearAimlapiSignInKeyAsync).toHaveBeenCalledWith('stan@aimlapi.com', 'key_test')
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager rejects an empty AIMLAPI top-up amount instead of charging the default', async () => {
  delete process.env.AIMLAPI_EMAIL
  const provisionAimlapiKey = mock(async () => ({
    apiKey: 'unexpected',
    apiKeyId: 'unexpected',
    baseUrl: 'https://api.aimlapi.com/v1',
    model: 'gpt-4o',
  }))
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    provisionAimlapiKey,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Step 1 of 2: Default model'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('I am a new user'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
    mounted.stdin.write('user@example.com')
    await Bun.sleep(25)
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))

    mounted.stdin.write('\x15')
    await Bun.sleep(25)
    mounted.stdin.write('\r')
    const output = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Please enter a top-up amount.'),
    )
    expect(output).toContain('Please enter a top-up amount.')
    expect(provisionAimlapiKey).not.toHaveBeenCalled()
  } finally {
    await mounted.dispose()
  }
}, 10_000)

test('ProviderManager drops a retained checkout when the onboarding email changes', async () => {
  delete process.env.AIMLAPI_EMAIL
  const addProviderProfile = mock((payload: any) => ({ id: 'aimlapi_profile', ...payload }))
  let accountSequence = 0
  const beginAimlapiEmailOnboarding = mock(async () => ({
    action: 'new-account' as const,
    sessionToken: `account-session-${++accountSequence}`,
  }))
  let provisionSequence = 0
  const provisionAimlapiKey = mock(async (options: any) => {
    provisionSequence += 1
    if (provisionSequence === 1) {
      options.onSession?.('checkout-for-first-account')
      throw new Error('temporary checkout failure')
    }
    return {
      apiKey: 'issued-for-second-account',
      apiKeyId: 'key_second',
      baseUrl: 'https://api.aimlapi.com/v1',
      model: 'gpt-4o',
    }
  })
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    addProviderProfile,
    beginAimlapiEmailOnboarding,
    provisionAimlapiKey,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Step 1 of 2: Default model'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('I am a new user'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
    const firstEmail = 'first@example.com'
    mounted.stdin.write(firstEmail)
    await Bun.sleep(25)
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))
    await Bun.sleep(25)
    mounted.stdin.write('\r')
    await waitForCondition(() => provisionAimlapiKey.mock.calls.length === 1)
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('temporary checkout failure'))

    mounted.stdin.write('\x1b')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
    // The shared cursorOffset state was last set for the amount field (its
    // default "25" is 2 chars), and going back here doesn't reset it — so the
    // cursor sits mid-string, not at the end of the retained "first@example.com".
    // Move to end-of-line first so the backspaces below clear the whole field
    // regardless of where the stale cursor was left.
    mounted.stdin.write('\x1b[F')
    mounted.stdin.write('\x7f'.repeat(firstEmail.length))
    mounted.stdin.write('second@example.com')
    await Bun.sleep(25)
    mounted.stdin.write('\r')

    // The first account's checkout is chargeable (a resume token was recorded
    // before it failed), so switching email must warn and require confirmation
    // rather than silently abandon it.
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('checkout from a previous email is still pending'),
    )
    expect(provisionAimlapiKey.mock.calls.length).toBe(1)
    mounted.stdin.write('\r')

    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))
    mounted.stdin.write('\r')
    await waitForCondition(() => provisionAimlapiKey.mock.calls.length === 2)

    const firstOptions = provisionAimlapiKey.mock.calls[0]?.[0] as any
    const secondOptions = provisionAimlapiKey.mock.calls[1]?.[0] as any
    expect(firstOptions.sessionToken).toBe('account-session-1')
    expect(secondOptions.sessionToken).toBe('account-session-2')
    expect(secondOptions.resumeSessionToken).toBe('')
    expect(secondOptions.paymentSessionId).not.toBe(firstOptions.paymentSessionId)
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager stops before the profile write when the post-exchange receipt save fails', async () => {
  delete process.env.AIMLAPI_EMAIL
  const beginAimlapiEmailOnboarding = mock(async () => ({
    action: 'new-account' as const,
    sessionToken: 'account-session',
  }))
  const provisionAimlapiKey = mock(async (options: any) => {
    options.onSession?.('checkout-session')
    return {
      apiKey: 'exchanged-key',
      apiKeyId: 'exchanged-id',
      baseUrl: 'https://api.aimlapi.com/v1',
      model: 'gpt-4o',
    }
  })
  // The exchange committed server-side (provisionAimlapiKey above already
  // returned the key), but the local recovery receipt for it fails to save —
  // e.g. a contended lock or a permission/I/O error.
  const saveAimlapiTopupStateAsync = mock(async () => {
    throw new Error('EACCES: permission denied')
  })
  const addProviderProfile = mock((payload: any) => ({ id: 'aimlapi_profile', ...payload }))
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    beginAimlapiEmailOnboarding,
    provisionAimlapiKey,
    saveAimlapiTopupStateAsync,
    addProviderProfile,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Step 1 of 2: Default model'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('I am a new user'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
    mounted.stdin.write('user@example.com')
    await Bun.sleep(25)
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))
    await Bun.sleep(25)
    mounted.stdin.write('\r')

    // Must stop with a clear, actionable error — not silently proceed to the
    // profile write with no durable receipt to fall back on if that write
    // also fails or the app is closed before it runs. The issued key id is
    // the recovery handle this error exists to surface, so it must be named,
    // not just a generic failure description.
    const errorFrame = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('could not be saved'),
    )
    expect(errorFrame).toContain('exchanged-id')
    expect(addProviderProfile).not.toHaveBeenCalled()

    // The screen stays interactive (usable) after the error: a retry reaches
    // the amount-submission path again rather than the app being stuck.
    mounted.stdin.write('\r')
    await waitForCondition(() => provisionAimlapiKey.mock.calls.length === 2)
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager carries a confirmed email-switch abandonment into the atomic claim even when the pre-clear never lands', async () => {
  delete process.env.AIMLAPI_EMAIL
  let accountSequence = 0
  const beginAimlapiEmailOnboarding = mock(async () => ({
    action: 'new-account' as const,
    sessionToken: `account-session-${++accountSequence}`,
  }))
  // A faithful-enough double of the real CAS refusal: a differing intent is
  // rejected unless abandonExisting is set. Unlike the file's shared default
  // mock (which always accepts a new intent regardless of abandonExisting),
  // this is needed to actually exercise the refusal this test guards against.
  let persistedIntent: Record<string, unknown> | undefined
  let claimSequence = 0
  const claimAimlapiTopupStateAsync = mock(
    async (intent: Record<string, unknown>, claimOptions?: { abandonExisting?: boolean }) => {
      claimSequence += 1
      if (persistedIntent && persistedIntent.email !== intent.email && !claimOptions?.abandonExisting) {
        throw new Error(
          "An earlier AI/ML API top-up hasn't finished and may already be paid. Re-run " +
            'that same top-up to complete it (or cancel it) before starting a different one.',
        )
      }
      persistedIntent = { ...intent, paymentSessionId: `payment-${claimSequence}` }
      return { paymentSessionId: persistedIntent.paymentSessionId, resumeSessionToken: '' }
    },
  )
  // Never settles — simulating a lock that stays contended (or a failure the
  // caller swallows) for the rest of this run. resetAimlapiCheckoutIntent's
  // clear is fire-and-forget, so if the confirmed abandonment weren't ALSO
  // carried into the claim itself via the force-abandon signal, the switch
  // below would hang behind claimAimlapiTopupStateAsync's refusal forever.
  const clearAimlapiTopupStateAsync = mock(() => new Promise<void>(() => {}))
  // Session recording isn't what this test is about; always elect the
  // caller's own token (no contention to model here) so the flow reaches
  // provisioning after a successful claim.
  const recordAimlapiCheckoutSessionAsync = mock(async (state: Record<string, unknown>) => state)
  let provisionSequence = 0
  const provisionAimlapiKey = mock(async (options: any) => {
    provisionSequence += 1
    if (provisionSequence === 1) {
      options.onSession?.('checkout-for-first-account')
      throw new Error('temporary checkout failure')
    }
    return {
      apiKey: 'issued-for-second-account',
      apiKeyId: 'key_second',
      baseUrl: 'https://api.aimlapi.com/v1',
      model: 'gpt-4o',
    }
  })
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    beginAimlapiEmailOnboarding,
    provisionAimlapiKey,
    claimAimlapiTopupStateAsync,
    clearAimlapiTopupStateAsync,
    recordAimlapiCheckoutSessionAsync,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Step 1 of 2: Default model'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('I am a new user'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
    const firstEmail = 'first@example.com'
    mounted.stdin.write(firstEmail)
    await Bun.sleep(25)
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))
    await Bun.sleep(25)
    mounted.stdin.write('\r')
    await waitForCondition(() => provisionAimlapiKey.mock.calls.length === 1)
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('temporary checkout failure'))

    mounted.stdin.write('\x1b')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
    // The shared cursorOffset state was last set for the amount field (its
    // default "25" is 2 chars), and going back here doesn't reset it — so the
    // cursor sits mid-string, not at the end of the retained "first@example.com".
    // Move to end-of-line first so the backspaces below clear the whole field
    // regardless of where the stale cursor was left.
    mounted.stdin.write('\x1b[F')
    mounted.stdin.write('\x7f'.repeat(firstEmail.length))
    mounted.stdin.write('second@example.com')
    await Bun.sleep(25)
    mounted.stdin.write('\r')

    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('checkout from a previous email is still pending'),
    )
    // Second Enter: the user explicitly confirms abandoning the first email's
    // checkout.
    mounted.stdin.write('\r')

    // The switch must proceed to the second account's checkout — not hang or
    // surface the CAS refusal — even though clearAimlapiTopupStateAsync above
    // never resolves.
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))
    mounted.stdin.write('\r')
    await waitForCondition(() => provisionAimlapiKey.mock.calls.length === 2)

    const secondOptions = provisionAimlapiKey.mock.calls[1]?.[0] as any
    expect(secondOptions.sessionToken).toBe('account-session-2')
    // The claim for the new email carried abandonExisting through, rather
    // than relying on the (never-landing) pre-clear.
    const secondClaimCall = claimAimlapiTopupStateAsync.mock.calls[1]
    expect((secondClaimCall?.[1] as any)?.abandonExisting).toBe(true)
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager does not carry a stale force-abandon confirmation into an unrelated later flow', async () => {
  delete process.env.AIMLAPI_EMAIL
  let accountSequence = 0
  let onboardingSequence = 0
  const beginAimlapiEmailOnboarding = mock(async () => {
    onboardingSequence += 1
    // The second email's onboarding fails, so the force-abandon flag armed
    // by confirming that switch is never consumed by a claim — it must not
    // leak into the third (unrelated) flow started after backing all the
    // way out and re-entering the aimlapi preset.
    if (onboardingSequence === 2) throw new Error('temporary onboarding failure')
    return { action: 'new-account' as const, sessionToken: `account-session-${++accountSequence}` }
  })
  // Deliberately permissive (unlike the real CAS, which would itself refuse
  // an unconfirmed conflict): this test isolates whether the STALE
  // force-abandon flag leaks into the third flow's claim, not whether the
  // real refusal logic also happens to catch it.
  let claimSequence = 0
  const claimAimlapiTopupStateAsync = mock(
    async (_intent: Record<string, unknown>, _claimOptions?: { abandonExisting?: boolean }) => {
      claimSequence += 1
      return { paymentSessionId: `payment-${claimSequence}`, resumeSessionToken: '' }
    },
  )
  const clearAimlapiTopupStateAsync = mock(async () => {})
  const recordAimlapiCheckoutSessionAsync = mock(async (state: Record<string, unknown>) => state)
  let provisionSequence = 0
  const provisionAimlapiKey = mock(async (options: any) => {
    provisionSequence += 1
    if (provisionSequence === 1) {
      options.onSession?.('checkout-for-first-account')
      throw new Error('temporary checkout failure')
    }
    return {
      apiKey: `issued-${provisionSequence}`,
      apiKeyId: `key_${provisionSequence}`,
      baseUrl: 'https://api.aimlapi.com/v1',
      model: 'gpt-4o',
    }
  })
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    beginAimlapiEmailOnboarding,
    provisionAimlapiKey,
    claimAimlapiTopupStateAsync,
    clearAimlapiTopupStateAsync,
    recordAimlapiCheckoutSessionAsync,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Step 1 of 2: Default model'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('I am a new user'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
    const firstEmail = 'first@example.com'
    mounted.stdin.write(firstEmail)
    await Bun.sleep(25)
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))
    await Bun.sleep(25)
    mounted.stdin.write('\r')
    await waitForCondition(() => provisionAimlapiKey.mock.calls.length === 1)
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('temporary checkout failure'))

    // Switch to a second email and confirm abandoning the first's checkout —
    // this arms the force-abandon flag — but the second email's own
    // onboarding then fails, so the flag is never consumed by a claim.
    mounted.stdin.write('\x1b')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
    // The shared cursorOffset state was last set for the amount field (its
    // default "25" is 2 chars), and going back here doesn't reset it — so the
    // cursor sits mid-string, not at the end of the retained "first@example.com".
    // Move to end-of-line first so the backspaces below clear the whole field
    // regardless of where the stale cursor was left.
    mounted.stdin.write('\x1b[F')
    mounted.stdin.write('\x7f'.repeat(firstEmail.length))
    mounted.stdin.write('second@example.com')
    await Bun.sleep(25)
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('checkout from a previous email is still pending'),
    )
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('temporary onboarding failure'))

    // Back all the way out to preset selection and start a completely fresh
    // aimlapi flow with a third email.
    mounted.stdin.write('\x1b')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Do you have an aimlapi.com key?'))
    mounted.stdin.write('\x1b')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Step 1 of 2: Default model'))
    mounted.stdin.write('\x1b')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Step 1 of 2: Default model'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('I am a new user'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
    mounted.stdin.write('third@example.com')
    await Bun.sleep(25)
    mounted.stdin.write('\r')

    // No conflict warning: this fresh mount has nothing chargeable of its
    // own, and the stale force-abandon flag from the second flow must not
    // silently authorize overriding the still-live first-email checkout.
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))
    mounted.stdin.write('\r')
    await waitForCondition(() => provisionAimlapiKey.mock.calls.length === 2)

    const thirdClaimCall = claimAimlapiTopupStateAsync.mock.calls.at(-1)
    expect((thirdClaimCall?.[1] as any)?.abandonExisting).toBeFalsy()
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager carries a confirmed API-key-choice abandonment into the atomic claim even when the pre-clear never lands', async () => {
  delete process.env.AIMLAPI_EMAIL
  let accountSequence = 0
  const beginAimlapiEmailOnboarding = mock(async () => ({
    action: 'new-account' as const,
    sessionToken: `account-session-${++accountSequence}`,
  }))
  // A faithful-enough double of the real CAS refusal: a differing intent is
  // rejected unless abandonExisting is set.
  let persistedIntent: Record<string, unknown> | undefined
  let claimSequence = 0
  const claimAimlapiTopupStateAsync = mock(
    async (intent: Record<string, unknown>, claimOptions?: { abandonExisting?: boolean }) => {
      claimSequence += 1
      if (persistedIntent && persistedIntent.email !== intent.email && !claimOptions?.abandonExisting) {
        throw new Error(
          "An earlier AI/ML API top-up hasn't finished and may already be paid. Re-run " +
            'that same top-up to complete it (or cancel it) before starting a different one.',
        )
      }
      persistedIntent = { ...intent, paymentSessionId: `payment-${claimSequence}` }
      return { paymentSessionId: persistedIntent.paymentSessionId, resumeSessionToken: '' }
    },
  )
  // Never settles — resetAimlapiOnboardingIdentity's clear (via
  // resetAimlapiCheckoutIntent) is fire-and-forget, so if the confirmation
  // given at the API-key-choice screen weren't ALSO carried into the claim
  // via the force-abandon signal, the flow below would hang behind
  // claimAimlapiTopupStateAsync's refusal forever.
  const clearAimlapiTopupStateAsync = mock(() => new Promise<void>(() => {}))
  const recordAimlapiCheckoutSessionAsync = mock(async (state: Record<string, unknown>) => state)
  let provisionSequence = 0
  const provisionAimlapiKey = mock(async (options: any) => {
    provisionSequence += 1
    if (provisionSequence === 1) {
      options.onSession?.('checkout-for-first-account')
      throw new Error('temporary checkout failure')
    }
    return {
      apiKey: 'issued-for-second-account',
      apiKeyId: 'key_second',
      baseUrl: 'https://api.aimlapi.com/v1',
      model: 'gpt-4o',
    }
  })
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    beginAimlapiEmailOnboarding,
    provisionAimlapiKey,
    claimAimlapiTopupStateAsync,
    clearAimlapiTopupStateAsync,
    recordAimlapiCheckoutSessionAsync,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Step 1 of 2: Default model'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('I am a new user'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
    const firstEmail = 'first@example.com'
    mounted.stdin.write(firstEmail)
    await Bun.sleep(25)
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))
    await Bun.sleep(25)
    mounted.stdin.write('\r')
    await waitForCondition(() => provisionAimlapiKey.mock.calls.length === 1)
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('temporary checkout failure'))

    // Back out through the email screen to the API-key-choice screen —
    // deliberately NOT re-submitting the same email, so the confirmation
    // below goes through THIS screen's own gate (line ~3607), not
    // startAimlapiEmailOnboarding's.
    mounted.stdin.write('\x1b')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
    mounted.stdin.write('\x1b')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Do you have an aimlapi.com key?'))

    // Re-picking "I am a new user" here hits hasChargeableAimlapiCheckout's
    // own confirm gate on this screen.
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('checkout from this account is still pending'),
    )
    // Second Enter: explicitly confirms abandoning it.
    mounted.stdin.write('\r')

    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
    mounted.stdin.write('second@example.com')
    await Bun.sleep(25)
    mounted.stdin.write('\r')

    // Must proceed to the second account's checkout — not hang or surface
    // the CAS refusal — even though clearAimlapiTopupStateAsync never lands.
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))
    mounted.stdin.write('\r')
    await waitForCondition(() => provisionAimlapiKey.mock.calls.length === 2)

    const secondOptions = provisionAimlapiKey.mock.calls[1]?.[0] as any
    expect(secondOptions.sessionToken).toBe('account-session-2')
    const secondClaimCall = claimAimlapiTopupStateAsync.mock.calls[1]
    expect((secondClaimCall?.[1] as any)?.abandonExisting).toBe(true)
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager cancellation returns a live checkout to the resumable amount screen', async () => {
  delete process.env.AIMLAPI_EMAIL
  let provisionSequence = 0
  const provisionAimlapiKey = mock(async (options: any) => {
    provisionSequence += 1
    if (provisionSequence === 1) {
      options.onSession?.('live-checkout')
      await new Promise<never>((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        })
      })
    }
    return {
      apiKey: 'issued-after-resume',
      apiKeyId: 'key_after_resume',
      baseUrl: 'https://api.aimlapi.com/v1',
      model: 'gpt-4o',
    }
  })
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    provisionAimlapiKey,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Step 1 of 2: Default model'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('I am a new user'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
    mounted.stdin.write('user@example.com')
    await Bun.sleep(25)
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))
    await Bun.sleep(25)
    mounted.stdin.write('\r')
    await waitForCondition(() => provisionAimlapiKey.mock.calls.length === 1)

    const firstOptions = provisionAimlapiKey.mock.calls[0]?.[0] as any
    mounted.stdin.write('\x1b')
    const amountOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Add credits'),
    )
    expect(amountOutput).not.toContain('Do you have an aimlapi.com key?')
    expect(firstOptions.signal.aborted).toBe(true)

    await Bun.sleep(25)
    mounted.stdin.write('\r')
    await waitForCondition(() => provisionAimlapiKey.mock.calls.length === 2)
    const secondOptions = provisionAimlapiKey.mock.calls[1]?.[0] as any
    expect(secondOptions.resumeSessionToken).toBe('live-checkout')
    expect(secondOptions.paymentSessionId).toBe(firstOptions.paymentSessionId)
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager cancels a top-up whose state-lock claim is still pending when the user backs out', async () => {
  delete process.env.AIMLAPI_EMAIL
  const beginAimlapiEmailOnboarding = mock(async () => ({
    action: 'new-account' as const,
    sessionToken: 'account-session',
  }))
  let releaseClaim: (() => void) | undefined
  const claimHeld = new Promise<void>(resolve => {
    releaseClaim = resolve
  })
  // Simulates claimAimlapiTopupStateAsync contending for the state lock: the
  // screen stays aimlapi-topup-amount for as long as this stays pending.
  const claimAimlapiTopupStateAsync = mock(async () => {
    await claimHeld
    return { paymentSessionId: 'payment-1', resumeSessionToken: '' }
  })
  const provisionAimlapiKey = mock(async () => {
    throw new Error('should never be reached: the claim was cancelled before this point')
  })
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    beginAimlapiEmailOnboarding,
    claimAimlapiTopupStateAsync,
    provisionAimlapiKey,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Step 1 of 2: Default model'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('I am a new user'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
    mounted.stdin.write('user@example.com')
    await Bun.sleep(25)
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))
    mounted.stdin.write('\r')

    // The claim is now pending (held open) and the screen is still
    // aimlapi-topup-amount — exactly the window the fix must cover. Back out
    // while it's still in flight.
    await waitForCondition(() => claimAimlapiTopupStateAsync.mock.calls.length > 0)
    mounted.stdin.write('\x1b')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))

    // Only now let the claim resolve, well after the user already navigated
    // away — a pre-fix build would let this stale invocation barge back onto
    // the progress screen and start provisioning.
    releaseClaim?.()
    await Bun.sleep(50)

    expect(mounted.getOutput()).toContain('Enter your email.')
    expect(provisionAimlapiKey).not.toHaveBeenCalled()
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager cancels a top-up whose state-lock claim is still pending when the manager unmounts', async () => {
  delete process.env.AIMLAPI_EMAIL
  const beginAimlapiEmailOnboarding = mock(async () => ({
    action: 'new-account' as const,
    sessionToken: 'account-session',
  }))
  let releaseClaim: (() => void) | undefined
  const claimHeld = new Promise<void>(resolve => {
    releaseClaim = resolve
  })
  const claimAimlapiTopupStateAsync = mock(async () => {
    await claimHeld
    return { paymentSessionId: 'payment-1', resumeSessionToken: '' }
  })
  const provisionAimlapiKey = mock(async () => {
    throw new Error('should never be reached: the claim was cancelled before this point')
  })
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    beginAimlapiEmailOnboarding,
    claimAimlapiTopupStateAsync,
    provisionAimlapiKey,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
  mounted.stdin.write('\r')
  await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
  await navigateToPreset(mounted.stdin, 'aimlapi.com')
  mounted.stdin.write('\r')
  await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Step 1 of 2: Default model'))
  mounted.stdin.write('\r')
  await waitForFrameOutput(mounted.getOutput, frame => frame.includes('I am a new user'))
  mounted.stdin.write('\r')
  await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
  mounted.stdin.write('user@example.com')
  await Bun.sleep(25)
  mounted.stdin.write('\r')
  await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))
  mounted.stdin.write('\r')

  // The claim is pending; unmount the whole manager while it's still in
  // flight, then let the claim resolve well after that.
  await waitForCondition(() => claimAimlapiTopupStateAsync.mock.calls.length > 0)
  await mounted.dispose()
  releaseClaim?.()
  await Bun.sleep(50)

  expect(provisionAimlapiKey).not.toHaveBeenCalled()
})

test('ProviderManager warns before abandoning an already-open checkout on re-edit', async () => {
  delete process.env.AIMLAPI_EMAIL
  delete process.env.AIMLAPI_CODE

  const provisionAimlapiKey = mock(async (options: any) => {
    // Open a checkout URL, then stay on the progress screen (never resolve) so
    // the user can go back and edit the amount.
    options.onStatus?.('opening-checkout', 'https://checkout.test/pay')
    await new Promise(() => {})
    return { apiKey: 'k', apiKeyId: 'id', baseUrl: 'https://api.aimlapi.com/v1', model: 'gpt-4o' }
  })
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    provisionAimlapiKey,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Step 1 of 2: Default model'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('I am a new user'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
    mounted.stdin.write('user@example.com')
    await Bun.sleep(25)
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))

    // Submit the default amount → a checkout URL is opened.
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Opening checkout in browser...'),
    )
    await waitForCondition(() => provisionAimlapiKey.mock.calls.length === 1)

    // Go back and change the amount, then submit: the first submit must WARN (the
    // open browser tab is still chargeable) rather than start a second checkout.
    mounted.stdin.write('\x1b')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))
    mounted.stdin.write('0')
    // Wait until the edited amount is reflected in the rendered frame (not a fixed
    // delay) before submitting, so Enter is never processed against the stale
    // amount on a slow runner. The negative lookahead pins the COMPLETE value so
    // "$250" cannot match a stray "$2500" and hide an input regression.
    await waitForFrameOutput(mounted.getOutput, frame => /Amount: \$250(?!\d)/.test(frame))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('unpaid checkout is still open'),
    )
    expect(provisionAimlapiKey.mock.calls.length).toBe(1)

    // Confirm by submitting again → a new checkout is started.
    mounted.stdin.write('\r')
    await waitForCondition(() => provisionAimlapiKey.mock.calls.length === 2)

    // The confirmation is single-use: now that the SECOND checkout is open, a
    // further edit to yet another amount must warn again rather than silently
    // abandon this newly-opened tab (the ack is reset when a checkout opens).
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Opening checkout in browser...'),
    )
    mounted.stdin.write('\x1b')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))
    mounted.stdin.write('0')
    // Same as above: synchronize on the COMPLETE rendered amount rather than a
    // fixed delay before submitting ("$2500" must not match a stray "$25000").
    await waitForFrameOutput(mounted.getOutput, frame => /Amount: \$2500(?!\d)/.test(frame))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('unpaid checkout is still open'),
    )
    expect(provisionAimlapiKey.mock.calls.length).toBe(2)
  } finally {
    await mounted.dispose()
  }
}, 20_000)

test('ProviderManager keeps the open checkout resumable through an edit that is never confirmed', async () => {
  delete process.env.AIMLAPI_EMAIL
  delete process.env.AIMLAPI_CODE

  const provisionAimlapiKey = mock(async (options: any) => {
    // Open a checkout URL, then stay on the progress screen (never resolve) so
    // the user can go back and edit the amount.
    options.onSession?.('live-checkout')
    options.onStatus?.('opening-checkout', 'https://checkout.test/pay')
    await new Promise(() => {})
    return { apiKey: 'k', apiKeyId: 'id', baseUrl: 'https://api.aimlapi.com/v1', model: 'gpt-4o' }
  })
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    provisionAimlapiKey,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Step 1 of 2: Default model'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('I am a new user'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
    mounted.stdin.write('user@example.com')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('user@example.com'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))

    // Submit the default amount → a checkout URL is opened and its resumable
    // token/payment id are recorded (mirrors a real chargeable browser tab).
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Opening checkout in browser...'),
    )
    await waitForCondition(() => provisionAimlapiKey.mock.calls.length === 1)
    const firstOptions = provisionAimlapiKey.mock.calls[0]?.[0] as any

    // Go back and start editing the amount — a draft edit, never submitted.
    mounted.stdin.write('\x1b')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))
    mounted.stdin.write('0')
    await waitForFrameOutput(mounted.getOutput, frame => /Amount: \$250(?!\d)/.test(frame))

    // Back out of the edit (typed a new amount and changed their mind) by
    // erasing it, restoring the original amount exactly, instead of ever
    // pressing Enter to confirm the abandon-ack warning.
    mounted.stdin.write('\x7f')
    await waitForFrameOutput(mounted.getOutput, frame => /Amount: \$25(?!\d)/.test(frame))
    mounted.stdin.write('\r')

    // Resubmitting the ORIGINAL amount must resume the still-open checkout — no
    // abandon warning, no new payment session — proving the draft edit never
    // discarded the durable receipt for the checkout that's still live in the
    // browser.
    await waitForCondition(() => provisionAimlapiKey.mock.calls.length === 2)
    const secondOptions = provisionAimlapiKey.mock.calls[1]?.[0] as any
    expect(secondOptions.resumeSessionToken).toBe('live-checkout')
    expect(secondOptions.paymentSessionId).toBe(firstOptions.paymentSessionId)
    const output = mounted.getOutput()
    expect(output).not.toContain('unpaid checkout is still open')
  } finally {
    await mounted.dispose()
  }
}, 20_000)

test('ProviderManager requires abandon confirmation for a persisted session backed out before a checkout URL appeared', async () => {
  delete process.env.AIMLAPI_EMAIL
  delete process.env.AIMLAPI_CODE

  const provisionAimlapiKey = mock(async (options: any) => {
    // A session is elected/recorded (mirrors resolveTopupSession's onSession
    // call inside createSession) but the flow never reaches 'opening-checkout'
    // — e.g. the request to /pay is still in flight when the user backs out.
    options.onSession?.('pending-session')
    await new Promise(() => {})
    return { apiKey: 'k', apiKeyId: 'id', baseUrl: 'https://api.aimlapi.com/v1', model: 'gpt-4o' }
  })
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    provisionAimlapiKey,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Step 1 of 2: Default model'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('I am a new user'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
    mounted.stdin.write('user@example.com')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('user@example.com'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))

    // Submit the default amount → the session is persisted, but the progress
    // screen never reaches "Opening checkout in browser..." (onStatus never
    // fires opening-checkout), so aimlapiOpenedCheckoutRef is never armed.
    mounted.stdin.write('\r')
    await waitForCondition(() => provisionAimlapiKey.mock.calls.length === 1)
    const firstOptions = provisionAimlapiKey.mock.calls[0]?.[0] as any

    // Back out before a checkout URL ever appeared, then edit the amount.
    mounted.stdin.write('\x1b')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))
    mounted.stdin.write('0')
    await waitForFrameOutput(mounted.getOutput, frame => /Amount: \$250(?!\d)/.test(frame))
    mounted.stdin.write('\r')

    // Must warn and require confirmation — not silently throw the generic
    // "hasn't finished and may already be paid" refusal error — even though no
    // browser tab was ever shown.
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('checkout for the previous amount is still pending'),
    )
    expect(provisionAimlapiKey.mock.calls.length).toBe(1)
    const output = mounted.getOutput()
    expect(output).not.toContain("hasn't finished")

    // Confirm → abandons the pending session and starts a genuinely new one.
    mounted.stdin.write('\r')
    await waitForCondition(() => provisionAimlapiKey.mock.calls.length === 2)
    const secondOptions = provisionAimlapiKey.mock.calls[1]?.[0] as any
    expect(secondOptions.paymentSessionId).not.toBe(firstOptions.paymentSessionId)
  } finally {
    await mounted.dispose()
  }
}, 20_000)

test('ProviderManager preserves receipt ownership when terminal-session cleanup fails, instead of silently losing it', async () => {
  delete process.env.AIMLAPI_EMAIL
  delete process.env.AIMLAPI_CODE

  // Both the key-retaining reset and its full-clear fallback fail — e.g. a
  // contended lock or a permission/I/O error — so the durable receipt for
  // the terminal session is never actually reset or cleared on disk.
  const resetAimlapiCheckoutSessionAsync = mock(async () => {
    throw new Error('lock timeout')
  })
  const clearAimlapiTopupStateAsync = mock(async () => {
    throw new Error('lock timeout')
  })
  let provisionSequence = 0
  const provisionAimlapiKey = mock(async (options: any) => {
    provisionSequence += 1
    if (provisionSequence === 1) {
      options.onSession?.('pending-session')
      // Mirrors the real poll helpers: await the terminal-session callback
      // before surfacing the terminal error.
      await options.onSession?.('')
      throw new Error('Payment cancelled. Re-run the top-up to try again.')
    }
    return {
      apiKey: 'k',
      apiKeyId: 'id',
      baseUrl: 'https://api.aimlapi.com/v1',
      model: 'gpt-4o',
    }
  })
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    provisionAimlapiKey,
    resetAimlapiCheckoutSessionAsync,
    clearAimlapiTopupStateAsync,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Step 1 of 2: Default model'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('I am a new user'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
    mounted.stdin.write('user@example.com')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('user@example.com'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))
    mounted.stdin.write('\r')

    // The session goes terminal and its (failing) cleanup runs; the error
    // surfaces automatically once provisionAimlapiKey's promise rejects.
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Payment cancelled'))
    expect(resetAimlapiCheckoutSessionAsync).toHaveBeenCalledTimes(1)
    // The reset attempt itself threw, so the full-clear fallback (only
    // reached when reset resolves falsy) never ran.
    expect(clearAimlapiTopupStateAsync).not.toHaveBeenCalled()

    // Edit the amount and resubmit.
    mounted.stdin.write('0')
    await waitForFrameOutput(mounted.getOutput, frame => /Amount: \$250(?!\d)/.test(frame))
    mounted.stdin.write('\r')

    // The failed cleanup must not have silently discarded receipt ownership:
    // the normal confirmation gate still appears (proving the persisted
    // intent ref was preserved) — not the raw, unrecoverable CAS refusal a
    // caller with no ownership left to retry cleanup would hit instead, and
    // not a silent, unconfirmed override of the still-undetermined receipt.
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('checkout for the previous amount is still pending'),
    )
    expect(provisionAimlapiKey.mock.calls.length).toBe(1)
  } finally {
    await mounted.dispose()
  }
}, 20_000)

test('ProviderManager requires abandon confirmation when Esc backs all the way out to the key-choice screen', async () => {
  delete process.env.AIMLAPI_EMAIL
  delete process.env.AIMLAPI_CODE

  const provisionAimlapiKey = mock(async (options: any) => {
    options.onSession?.('live-checkout')
    await new Promise(() => {})
    return { apiKey: 'k', apiKeyId: 'id', baseUrl: 'https://api.aimlapi.com/v1', model: 'gpt-4o' }
  })
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    provisionAimlapiKey,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Step 1 of 2: Default model'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('I am a new user'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
    mounted.stdin.write('user@example.com')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('user@example.com'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))

    // Submit the default amount → a checkout session is recorded (a resume
    // token exists) even though the progress screen never shows a URL.
    mounted.stdin.write('\r')
    await waitForCondition(() => provisionAimlapiKey.mock.calls.length === 1)

    // Esc all the way back out: progress -> amount -> email -> key choice.
    mounted.stdin.write('\x1b')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))
    mounted.stdin.write('\x1b')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
    mounted.stdin.write('\x1b')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Do you have an aimlapi.com key?'),
    )

    // Picking either path here must not silently abandon the live checkout.
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('checkout from this account is still pending'),
    )
    expect(provisionAimlapiKey.mock.calls.length).toBe(1)

    // Confirm → now the identity is free to reset and onboarding proceeds.
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
  } finally {
    await mounted.dispose()
  }
}, 20_000)

test('ProviderManager recovers a settled receipt without re-provisioning', async () => {
  delete process.env.AIMLAPI_EMAIL
  delete process.env.AIMLAPI_CODE

  const addProviderProfile = mock((payload: any) => ({ id: 'aimlapi_profile', ...payload }))
  const provisionAimlapiKey = mock(async () => {
    throw new Error('provisionAimlapiKey must not run when a settled receipt exists')
  })
  // A prior run paid + exchanged the key and saved the settled receipt, then was
  // interrupted before the profile write.
  const claimAimlapiTopupStateAsync = mock(async () => ({
    paymentSessionId: 'persisted-payment-id',
    resumeSessionToken: 'exchanged-session',
    settled: true,
    apiKey: 'recovered-key',
    apiKeyId: 'recovered-id',
    model: 'gpt-4o',
  }))
  const clearAimlapiTopupStateAsync = mock(async () => {})
  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    addProviderProfile,
    provisionAimlapiKey,
    claimAimlapiTopupStateAsync,
    clearAimlapiTopupStateAsync,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)
  try {
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Provider manager'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Choose provider preset'))
    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Step 1 of 2: Default model'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('I am a new user'))
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Enter your email.'))
    mounted.stdin.write('user@example.com')
    await Bun.sleep(25)
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame => frame.includes('Add credits'))
    mounted.stdin.write('\t')
    await Bun.sleep(25)
    mounted.stdin.write('\t')
    await Bun.sleep(25)
    mounted.stdin.write('\r')

    // Recovery persists the saved key directly instead of re-entering
    // provisioning against the now-exchanged session.
    await waitForCondition(() => addProviderProfile.mock.calls.length > 0)
    expect(provisionAimlapiKey).not.toHaveBeenCalled()
    expect(addProviderProfile).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'aimlapi', apiKey: 'recovered-key' }),
      expect.objectContaining({ makeActive: true }),
    )
    // Recovery treats the settled receipt as a completed payment, so the done
    // screen must show the top-up copy — not the plain "ready" copy, which would
    // wrongly tell the user no payment happened.
    const doneOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Top-up successful'),
    )
    expect(doneOutput).not.toContain('Everything is ready.')
  } finally {
    await mounted.dispose()
  }
}, 20_000)

test('ProviderManager can top up AI/ML API and save the issued key', async () => {
  delete process.env.AIMLAPI_EMAIL
  delete process.env.AIMLAPI_CODE

  const events: string[] = []
  const addProviderProfile = mock((payload: any) => {
    events.push('profile')
    return { id: 'aimlapi_profile', ...payload }
  })
  const saveAimlapiTopupStateAsync = mock(async (state: any) => {
    if (state?.settled) events.push(`receipt:${String(state.apiKey)}`)
  })
  const checkoutUrl =
    'https://checkout.stripe.com/c/pay/cs_test_1234567890#signed-checkout-fragment-that-must-remain-visible-across-terminal-lines-tail'
  const provisionAimlapiKey = mock(async (options: any) => {
    options.onStatus?.('creating-session')
    await Bun.sleep(150)
    options.onStatus?.('opening-checkout', checkoutUrl)
    await Bun.sleep(150)
    options.onStatus?.('waiting-payment')
    options.onStatus?.('provisioning-key')
    return {
      apiKey: 'aimlapi-issued-key',
      apiKeyId: 'key_test',
      baseUrl: 'https://api.aimlapi.com/v1',
      model: 'gpt-4o',
    }
  })
  const claimAimlapiTopupStateAsync = mock(async () => ({
    paymentSessionId: 'persisted-payment-id',
    resumeSessionToken: 'persisted-checkout-session',
  }))
  const clearAimlapiTopupStateAsync = mock(async () => {})

  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    addProviderProfile,
    provisionAimlapiKey,
    claimAimlapiTopupStateAsync,
    clearAimlapiTopupStateAsync,
    saveAimlapiTopupStateAsync,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)

  try {
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Provider manager'),
    )

    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Choose provider preset'),
    )

    await navigateToPreset(mounted.stdin, 'aimlapi.com')
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Step 1 of 2: Default model'),
    )

    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('I am a new user'),
    )

    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Enter your email.'),
    )
    mounted.stdin.write('user@example.com')
    await Bun.sleep(25)
    mounted.stdin.write('\r')

    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Add credits') &&
      frame.includes('Auto top up: on/off'),
    )
    await Bun.sleep(25)
    mounted.stdin.write('\t')
    await Bun.sleep(25)
    mounted.stdin.write(' ')
    await Bun.sleep(25)
    mounted.stdin.write('\t')
    await Bun.sleep(25)
    mounted.stdin.write('\r')

    await waitForCondition(() => provisionAimlapiKey.mock.calls.length > 0)
    const spinnerOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      !frame.includes('Auto top up:') &&
      !frame.includes('Top-up successful -'),
    )
    expect(spinnerOutput).not.toContain('Creating checkout session...')
    expect(spinnerOutput).not.toContain('Waiting for payment...')
    expect(spinnerOutput).not.toContain('Issuing API key...')
    // The three checks above can never fail on their own: none of those strings
    // are ever rendered by this GUI screen (they're CLI-only console output).
    // This is the one that actually distinguishes "still provisioning" from a
    // regression that silently failed and left the failure copy on this frame.
    expect(spinnerOutput).not.toContain(AIMLAPI_MESSAGES.topUpFailed)

    const paymentOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Opening checkout in browser...'),
    )
    expect(paymentOutput).toContain(
      'If the browser did not open automatically please use this link to top up your account:',
    )
    expect(paymentOutput).toContain('https://checkout.stripe.com/c/pay/cs_test_1234567890')
    expect(paymentOutput.replace(/\s/g, '')).toContain(checkoutUrl)

    await waitForCondition(() => addProviderProfile.mock.calls.length > 0)
    const doneOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Top-up successful - $25 credited to your account'),
    )
    expect(doneOutput).not.toContain('has been added to your balance')
    expect(doneOutput).toContain(
      'Your aimlapi.com account is ready. Sign in at https://aimlapi.com/app with user@example.com to review your usage.',
    )
    // Wait for the done screen to settle (an unchanged frame across a poll)
    // rather than a fixed delay, so Ink has committed the render and attached its
    // input handler before the final keystroke — otherwise a slow CI runner can
    // drop it and strand the flow on the success screen.
    let previousDoneFrame = ''
    await waitForCondition(() => {
      const frame = mounted.getOutput()
      const settled = frame === previousDoneFrame && frame.includes('Top-up successful')
      previousDoneFrame = frame
      return settled
    })
    mounted.stdin.write('\r')
    await waitForFrameOutput(
      mounted.getOutput,
      frame => frame.includes('Provider manager'),
      12_000,
    )
    expect(provisionAimlapiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        amountUsd: '25',
        model: 'gpt-4o',
        sessionToken: 'session_test',
        paymentSessionId: 'persisted-payment-id',
        resumeSessionToken: 'persisted-checkout-session',
        exchange: true,
        autoTopUp: false,
        onStatus: expect.any(Function),
      }),
    )
    expect(addProviderProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'aimlapi',
        name: 'aimlapi.com',
        baseUrl: 'https://api.aimlapi.com/v1',
        model: 'gpt-4o',
        apiKey: 'aimlapi-issued-key',
        apiFormat: 'chat_completions',
      }),
      expect.objectContaining({ makeActive: true }),
    )
    expect(claimAimlapiTopupStateAsync).toHaveBeenCalledTimes(1)
    expect(clearAimlapiTopupStateAsync).toHaveBeenCalledTimes(1)
    // The settled receipt (the paid, one-shot exchanged key) is persisted BEFORE
    // the profile write, so an interrupted or failed write resumes with the paid
    // key instead of stranding it.
    expect(events).toEqual(['receipt:aimlapi-issued-key', 'profile'])
  } finally {
    await mounted.dispose()
  }
}, 20_000)

test('ProviderManager saves MiniMax preset with Anthropic-compatible endpoint and type', async () => {
  const addProviderProfile = mock((payload: any) => ({
    id: 'minimax_profile',
    ...payload,
  }))

  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    addProviderProfile,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)

  try {
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Provider manager'),
    )

    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Choose provider preset'),
    )

    await navigateToPreset(mounted.stdin, 'MiniMax')
    mounted.stdin.write('\r')
    const modelOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Create provider profile') &&
      frame.includes('Step 1 of 2: Default model'),
    )

    expect(modelOutput).toContain('MiniMax')
    expect(modelOutput).toContain('MiniMax-M2.7')
    expect(modelOutput).toContain('Provider type: Anthropic-compatible API')
    expect(modelOutput).not.toContain('Provider name')
    expect(modelOutput).not.toContain('Base URL')
    expect(modelOutput).not.toContain('API mode')
    expect(modelOutput).not.toContain('Auth header')
    expect(modelOutput).not.toContain('Custom headers')

    mounted.stdin.write('\r')
    const keyOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Step 2 of 2: API key'),
    )
    expect(keyOutput).not.toContain('Provider name')
    expect(keyOutput).not.toContain('Base URL')
    expect(keyOutput).not.toContain('API mode')
    expect(keyOutput).not.toContain('Auth header')
    expect(keyOutput).not.toContain('Custom headers')

    mounted.stdin.write('minimax-test-key')
    await Bun.sleep(25)
    mounted.stdin.write('\r')

    await waitForCondition(() => addProviderProfile.mock.calls.length > 0)
    expect(addProviderProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'minimax',
        baseUrl: 'https://api.minimax.io/anthropic',
        model: 'MiniMax-M2.7',
        apiFormat: 'chat_completions',
      }),
      expect.objectContaining({ makeActive: true }),
    )
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager edit flow keeps MiniMax on Anthropic-compatible provider path', async () => {
  const minimaxProfile = {
    id: 'provider_minimax',
    provider: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.io/anthropic',
    model: 'MiniMax-M2.7',
    apiKey: 'minimax-key',
  }
  const updateProviderProfile = mock((id: string, payload: any) => ({
    ...minimaxProfile,
    id,
    ...payload,
  }))

  mockProviderManagerDependencies(
    () => undefined,
    async () => undefined,
    {
      getProviderProfiles: () => [minimaxProfile],
      getActiveProviderProfile: () => minimaxProfile,
      updateProviderProfile,
    },
  )

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)

  try {
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Provider manager') &&
      frame.includes('Edit provider'),
    )

    mounted.stdin.write('j')
    await Bun.sleep(25)
    mounted.stdin.write('j')
    await Bun.sleep(25)
    mounted.stdin.write('\r')

    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Edit provider') &&
      frame.includes('MiniMax') &&
      !frame.includes('Provider manager'),
    )

    mounted.stdin.write('\r')
    const editOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Edit provider profile') &&
      frame.includes('Provider type: Anthropic-compatible API'),
    )

    expect(editOutput).toContain('Provider type: Anthropic-compatible API')
    expect(editOutput).not.toContain('API mode')
    expect(editOutput).not.toContain('Auth header')
    expect(editOutput).not.toContain('Custom headers')

    for (let step = 2; step <= 4; step++) {
      mounted.stdin.write('\r')
      await waitForFrameOutput(mounted.getOutput, frame =>
        frame.includes(`Step ${step} of 4`),
      )
    }
    mounted.stdin.write('\r')

    await waitForCondition(() => updateProviderProfile.mock.calls.length > 0)
    expect(updateProviderProfile).toHaveBeenCalledWith(
      'provider_minimax',
      expect.objectContaining({
        provider: 'minimax',
        baseUrl: 'https://api.minimax.io/anthropic',
        model: 'MiniMax-M2.7',
      }),
    )
    expect(updateProviderProfile.mock.calls[0]?.[1]).toMatchObject({
      authHeader: undefined,
      authScheme: undefined,
      authHeaderValue: undefined,
      customHeaders: undefined,
    })
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager saves Hicap preset non-GPT model with Chat Completions', async () => {
  const addProviderProfile = mock((payload: any) => ({
    id: 'hicap_profile',
    ...payload,
  }))

  mockProviderManagerDependencies(() => undefined, async () => undefined, {
    addProviderProfile,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)

  try {
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Provider manager'),
    )

    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Choose provider preset'),
    )

    await navigateToPreset(mounted.stdin, 'Hicap')
    mounted.stdin.write('\r')
    const modelOutput = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Step 1 of 2: Default model'),
    )

    expect(modelOutput).toContain('Hicap')
    expect(modelOutput).toContain('claude-opus-4.8')

    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Step 2 of 2: API key'),
    )
    mounted.stdin.write('hicap-test-key')
    await Bun.sleep(25)
    mounted.stdin.write('\r')

    await waitForCondition(() => addProviderProfile.mock.calls.length > 0)
    expect(addProviderProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'hicap',
        model: 'claude-opus-4.8',
        apiFormat: 'chat_completions',
      }),
      expect.objectContaining({ makeActive: true }),
    )
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager clears hidden Hicap auth fields when editing', async () => {
  const legacyHicapProfile = {
    id: 'provider_legacy_hicap',
    provider: 'hicap',
    name: 'Legacy Hicap',
    baseUrl: 'https://api.hicap.ai/v1',
    model: 'claude-opus-4.7',
    apiKey: 'hicap-key',
    apiFormat: 'chat_completions',
    authHeader: 'Authorization',
    authHeaderValue: 'stale-hidden-secret',
    customHeaders: {
      'X-Regular-Header': 'kept',
    },
  }
  const updateProviderProfile = mock((id: string, payload: any) => ({
    ...legacyHicapProfile,
    id,
    ...payload,
  }))

  mockProviderManagerDependencies(
    () => undefined,
    async () => undefined,
    {
      getProviderProfiles: () => [legacyHicapProfile],
      getActiveProviderProfile: () => legacyHicapProfile,
      updateProviderProfile,
    },
  )

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)

  try {
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Provider manager') &&
      frame.includes('Edit provider'),
    )

    mounted.stdin.write('j')
    await Bun.sleep(25)
    mounted.stdin.write('j')
    await Bun.sleep(25)
    mounted.stdin.write('\r')

    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Edit provider') &&
      frame.includes('Legacy Hicap'),
    )

    await Bun.sleep(25)
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Edit provider profile') &&
      frame.includes('Step 1 of 6'),
    )

    for (let step = 2; step <= 6; step++) {
      mounted.stdin.write('\r')
      await waitForFrameOutput(mounted.getOutput, frame =>
        frame.includes(`Step ${step} of 6`),
      )
    }
    mounted.stdin.write('\r')

    await waitForCondition(() => updateProviderProfile.mock.calls.length > 0)
    expect(updateProviderProfile).toHaveBeenCalledWith(
      'provider_legacy_hicap',
      expect.objectContaining({
        provider: 'hicap',
        customHeaders: {
          'X-Regular-Header': 'kept',
        },
      }),
    )
    expect(updateProviderProfile.mock.calls[0]?.[1]).toMatchObject({
      authHeader: undefined,
      authScheme: undefined,
      authHeaderValue: undefined,
    })
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager skips advanced fields for legacy Kimi Code profiles', async () => {
  const legacyKimiProfile = {
    id: 'provider_legacy_kimi',
    provider: 'openai',
    name: 'Legacy Kimi Code',
    baseUrl: 'https://api.kimi.com/coding/v1',
    model: 'kimi-for-coding',
    apiKey: 'sk-test',
  }

  mockProviderManagerDependencies(
    () => undefined,
    async () => undefined,
    {
      getProviderProfiles: () => [legacyKimiProfile],
      getActiveProviderProfile: () => legacyKimiProfile,
    },
  )

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)

  try {
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Provider manager') &&
      frame.includes('Edit provider'),
    )

    mounted.stdin.write('j')
    await Bun.sleep(25)
    mounted.stdin.write('j')
    await Bun.sleep(25)
    mounted.stdin.write('\r')

    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Edit provider') &&
      frame.includes('Legacy Kimi Code'),
    )

    await Bun.sleep(25)
    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Edit provider profile') &&
      frame.includes('Provider name') &&
      frame.includes('Step 1 of 4'),
    )

    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Base URL') &&
      frame.includes('Step 2 of 4'),
    )

    mounted.stdin.write('\r')
    await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('Default model') &&
      frame.includes('Step 3 of 4'),
    )

    mounted.stdin.write('\r')
    const output = await waitForFrameOutput(mounted.getOutput, frame =>
      frame.includes('API key') &&
      frame.includes('Step 4 of 4'),
    )

    expect(output).not.toContain('API mode')
    expect(output).not.toContain('Auth header')
    expect(output).not.toContain('Custom headers')
  } finally {
    await mounted.dispose()
  }
})

test('ProviderManager first-run Ollama preset auto-detects installed models', async () => {
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  const onDone = mock(() => {})
  const addProviderProfile = mock((payload: {
    provider: string
    name: string
    baseUrl: string
    model: string
    apiKey?: string
  }) => ({
    id: 'provider_ollama',
    provider: payload.provider,
    name: payload.name,
    baseUrl: payload.baseUrl,
    model: payload.model,
    apiKey: payload.apiKey,
  }))

  mockProviderManagerDependencies(
    () => undefined,
    async () => undefined,
    {
      addProviderProfile,
      probeOllamaGenerationReadiness: async () => ({
        state: 'ready',
        models: [
          {
            name: 'gemma4:31b-cloud',
            family: 'gemma',
            parameterSize: '31b',
          },
          {
            name: 'kimi-k2.5:cloud',
            family: 'kimi',
            parameterSize: '2.5b',
          },
        ],
        probeModel: 'gemma4:31b-cloud',
      }),
    },
  )

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager, {
    mode: 'first-run',
    onDone,
  })

  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Set up provider'),
  )

  await navigateToPreset(mounted.stdin, 'Ollama')
  mounted.stdin.write('\r')

  const modelFrame = await waitForFrameOutput(
    mounted.getOutput,
    frame =>
      frame.includes('Choose an Ollama model') &&
      frame.includes('gemma4:31b-cloud') &&
      frame.includes('kimi-k2.5:cloud'),
  )

  expect(modelFrame).toContain('Choose an Ollama model')
  expect(modelFrame).toContain('gemma4:31b-cloud')

  await Bun.sleep(25)
  mounted.stdin.write('\r')

  await waitForCondition(() => onDone.mock.calls.length > 0)

  expect(addProviderProfile).toHaveBeenCalled()
  expect(addProviderProfile.mock.calls[0]?.[0]).toMatchObject({
    name: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    model: 'gemma4:31b-cloud',
  })
  expect(onDone).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'saved',
      message: 'Provider configured: Ollama',
    }),
  )

  await mounted.dispose()
})

test('ProviderManager preserves the Ollama readiness message when the probe is unreachable', async () => {
  const onDone = mock(() => {})

  mockProviderManagerDependencies(
    () => undefined,
    async () => undefined,
  )

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager, {
    mode: 'first-run',
    onDone,
  })

  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Set up provider'),
  )

  await navigateToPreset(mounted.stdin, 'Ollama')
  mounted.stdin.write('\r')

  const messageFrame = await waitForFrameOutput(
    mounted.getOutput,
    frame =>
      frame.includes('Could not reach Ollama at http://localhost:11434/v1.') &&
      frame.includes('enter the endpoint manually'),
  )

  expect(messageFrame).toContain(
    'Could not reach Ollama at http://localhost:11434/v1. Start Ollama first, or enter the endpoint manually.',
  )

  await mounted.dispose()
})

test('ProviderManager first-run Atomic Chat preset auto-detects loaded models', async () => {
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  const onDone = mock(() => {})
  const addProviderProfile = mock((payload: {
    provider: string
    name: string
    baseUrl: string
    model: string
    apiKey?: string
  }) => ({
    id: 'provider_atomic_chat',
    provider: payload.provider,
    name: payload.name,
    baseUrl: payload.baseUrl,
    model: payload.model,
    apiKey: payload.apiKey,
  }))

  mockProviderManagerDependencies(
    () => undefined,
    async () => undefined,
    {
      addProviderProfile,
      probeRouteReadiness: async routeId => {
        if (routeId === 'atomic-chat') {
          return {
            state: 'ready' as const,
            models: ['Qwen3_5-4B_Q4_K_M', 'Llama-3.1-8B-Instruct'],
          }
        }

        return null
      },
    },
  )

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager, {
    mode: 'first-run',
    onDone,
  })

  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Set up provider'),
  )

  await navigateToPreset(mounted.stdin, 'Atomic Chat')
  mounted.stdin.write('\r')

  const modelFrame = await waitForFrameOutput(
    mounted.getOutput,
    frame =>
      frame.includes('Choose an Atomic Chat model') &&
      frame.includes('Qwen3_5-4B_Q4_K_M') &&
      frame.includes('Llama-3.1-8B-Instruct'),
  )

  expect(modelFrame).toContain('Choose an Atomic Chat model')
  expect(modelFrame).toContain('Qwen3_5-4B_Q4_K_M')

  await Bun.sleep(25)
  mounted.stdin.write('\r')

  await waitForCondition(() => onDone.mock.calls.length > 0)

  expect(addProviderProfile).toHaveBeenCalled()
  expect(addProviderProfile.mock.calls[0]?.[0]).toMatchObject({
    name: 'Atomic Chat',
    baseUrl: 'http://127.0.0.1:1337/v1',
    model: 'Qwen3_5-4B_Q4_K_M',
  })
  expect(onDone).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'saved',
      message: 'Provider configured: Atomic Chat',
    }),
  )

  await mounted.dispose()
})

test('ProviderManager first-run Codex OAuth switches the current session after login completes', async () => {
  delete process.env.CLAUDE_CODE_SIMPLE
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  const onDone = mock(() => {})
  const applySavedProfileToCurrentSession = mock(async () => null)
  const persistCredentials = mock(() => {})
  const setActiveProviderProfile = mock((profileId: string) => ({
    id: profileId,
    provider: 'openai',
    name: 'Codex OAuth',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    model: 'codexplan',
    apiKey: '',
  }))
  const addProviderProfile = mock((payload: {
    provider: string
    name: string
    baseUrl: string
    model: string
    apiKey?: string
  }) => ({
    id: 'provider_codex_oauth',
    provider: payload.provider,
    name: payload.name,
    baseUrl: payload.baseUrl,
    model: payload.model,
    apiKey: payload.apiKey,
  }))

  mockProviderManagerDependencies(
    () => undefined,
    async () => undefined,
    {
      addProviderProfile,
      applySavedProfileToCurrentSession,
      setActiveProviderProfile,
      useCodexOAuthFlow: ({ onAuthenticated }) => {
        React.useEffect(() => {
          void onAuthenticated({
            accessToken: 'oauth-access-token',
            refreshToken: 'oauth-refresh-token',
            accountId: 'acct_oauth',
          }, persistCredentials)
        }, [onAuthenticated])

        return {
          state: 'waiting',
          authUrl: 'https://chatgpt.com/codex',
          browserOpened: true,
        }
      },
    },
  )

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager, {
    mode: 'first-run',
    onDone,
  })

  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Set up provider') && frame.includes('Codex OAuth'),
  )

  await navigateToPreset(mounted.stdin, 'Codex OAuth')
  mounted.stdin.write('\r')

  await waitForCondition(() => onDone.mock.calls.length > 0)

  expect(addProviderProfile).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: 'openai',
      name: 'Codex OAuth',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      model: 'codexplan',
      apiKey: '',
    }),
    expect.objectContaining({ makeActive: false }),
  )
  expect(setActiveProviderProfile).toHaveBeenCalledWith(
    'provider_codex_oauth',
  )
  expect(applySavedProfileToCurrentSession).toHaveBeenCalled()
  expect(persistCredentials).toHaveBeenCalledWith({
    profileId: 'provider_codex_oauth',
  })
  expect(onDone).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'saved',
      message:
        'Codex OAuth configured. OpenClaude switched to it for this session.',
    }),
  )

  await mounted.dispose()
})

test('ProviderManager Codex OAuth waiting state masks the paste field and delegates a good callback', async () => {
  delete process.env.CLAUDE_CODE_SIMPLE
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN
  delete process.env.SSH_CONNECTION
  delete process.env.SSH_CLIENT

  const onDone = mock(() => {})
  const submitManualCallback = mock((_input: string) => ({ ok: true }))

  mockProviderManagerDependencies(
    () => undefined,
    async () => undefined,
    {
      // Stay in `waiting` (never call onAuthenticated) so the manual-paste UI
      // renders. The hook returns a spy submitManualCallback.
      useCodexOAuthFlow: () => ({
        state: 'waiting',
        authUrl: 'https://chatgpt.com/codex',
        browserOpened: true,
        submitManualCallback,
      }),
    },
  )

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager, {
    mode: 'first-run',
    onDone,
  })

  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Set up provider') && frame.includes('Codex OAuth'),
  )

  await navigateToPreset(mounted.stdin, 'Codex OAuth')
  mounted.stdin.write('\r')

  // Non-SSH session shows the generic "paste the callback URL" hint and the input.
  await waitForFrameOutput(
    mounted.getOutput,
    frame =>
      frame.includes('Callback URL') &&
      frame.includes('paste the full callback URL'),
  )

  const callbackUrl =
    'http://localhost:41100/auth/callback?code=goodsecret&state=s'
  mounted.stdin.write(callbackUrl)
  // The pasted secret must be masked — the raw code must never reach the frame.
  await waitForFrameOutput(
    mounted.getOutput,
    frame => !frame.includes('goodsecret') && frame.includes('Callback URL'),
  )

  mounted.stdin.write('\r')
  await waitForCondition(() => submitManualCallback.mock.calls.length > 0)
  expect(submitManualCallback).toHaveBeenCalledWith(callbackUrl)
  // A successful submit leaves no inline error on screen.
  expect(
    stripAnsi(extractLastFrame(mounted.getOutput())),
  ).not.toContain('State mismatch')

  await mounted.dispose()
})

test('ProviderManager Codex OAuth waiting state shows the SSH banner and surfaces a bad-callback error', async () => {
  delete process.env.CLAUDE_CODE_SIMPLE
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN
  process.env.SSH_CONNECTION = '10.0.0.1 22 10.0.0.2 22'
  delete process.env.SSH_CLIENT

  const onDone = mock(() => {})
  const submitManualCallback = mock((_input: string) => ({
    ok: false,
    error: 'State mismatch',
  }))

  try {
    mockProviderManagerDependencies(
      () => undefined,
      async () => undefined,
      {
        useCodexOAuthFlow: () => ({
          state: 'waiting',
          authUrl: 'https://chatgpt.com/codex',
          browserOpened: true,
          submitManualCallback,
        }),
      },
    )

    const nonce = `${Date.now()}-${Math.random()}`
    const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
    const mounted = await mountProviderManager(ProviderManager, {
      mode: 'first-run',
      onDone,
    })

    await waitForFrameOutput(
      mounted.getOutput,
      frame =>
        frame.includes('Set up provider') && frame.includes('Codex OAuth'),
    )

    await navigateToPreset(mounted.stdin, 'Codex OAuth')
    mounted.stdin.write('\r')

    // SSH session shows the dedicated banner instead of the generic hint.
    await waitForFrameOutput(
      mounted.getOutput,
      frame =>
        frame.includes('SSH session detected') &&
        frame.includes('Callback URL'),
    )

    mounted.stdin.write('http://localhost:41100/auth/callback?code=x&state=s')
    mounted.stdin.write('\r')

    // A rejected callback renders the inline error returned by the hook.
    await waitForFrameOutput(
      mounted.getOutput,
      frame => frame.includes('State mismatch'),
    )
    expect(submitManualCallback).toHaveBeenCalledTimes(1)

    await mounted.dispose()
  } finally {
    delete process.env.SSH_CONNECTION
  }
})

test('ProviderManager first-run Codex OAuth surfaces credential storage warnings', async () => {
  delete process.env.CLAUDE_CODE_SIMPLE
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  const onDone = mock(() => {})
  const applySavedProfileToCurrentSession = mock(async () => null)
  const persistCredentials = mock(() => ({
    warning: 'Warning: Storing credentials in plaintext.',
  }))
  const setActiveProviderProfile = mock((profileId: string) => ({
    id: profileId,
    provider: 'openai',
    name: 'Codex OAuth',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    model: 'codexplan',
    apiKey: '',
  }))
  const addProviderProfile = mock((payload: {
    provider: string
    name: string
    baseUrl: string
    model: string
    apiKey?: string
  }) => ({
    id: 'provider_codex_oauth',
    provider: payload.provider,
    name: payload.name,
    baseUrl: payload.baseUrl,
    model: payload.model,
    apiKey: payload.apiKey,
  }))

  mockProviderManagerDependencies(
    () => undefined,
    async () => undefined,
    {
      addProviderProfile,
      applySavedProfileToCurrentSession,
      setActiveProviderProfile,
      useCodexOAuthFlow: ({ onAuthenticated }) => {
        React.useEffect(() => {
          void onAuthenticated({
            accessToken: 'oauth-access-token',
            refreshToken: 'oauth-refresh-token',
            accountId: 'acct_oauth',
          }, persistCredentials)
        }, [onAuthenticated])

        return {
          state: 'waiting',
          authUrl: 'https://chatgpt.com/codex',
          browserOpened: true,
        }
      },
    },
  )

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager, {
    mode: 'first-run',
    onDone,
  })

  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Set up provider') && frame.includes('Codex OAuth'),
  )

  await navigateToPreset(mounted.stdin, 'Codex OAuth')
  mounted.stdin.write('\r')

  await waitForCondition(() => onDone.mock.calls.length > 0)

  expect(persistCredentials).toHaveBeenCalledWith({
    profileId: 'provider_codex_oauth',
  })
  expect(onDone).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'saved',
      message:
        'Codex OAuth configured. OpenClaude switched to it for this session with warnings: Warning: Storing credentials in plaintext.',
    }),
  )

  await mounted.dispose()
})

test('ProviderManager first-run Codex OAuth reports next-startup fallback when session activation fails', async () => {
  delete process.env.CLAUDE_CODE_SIMPLE
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  const onDone = mock(() => {})
  const applySavedProfileToCurrentSession = mock(
    async () => 'validation failed',
  )
  const persistCredentials = mock(() => {})
  const setActiveProviderProfile = mock((profileId: string) => ({
    id: profileId,
    provider: 'openai',
    name: 'Codex OAuth',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    model: 'codexplan',
    apiKey: '',
  }))
  const addProviderProfile = mock((payload: {
    provider: string
    name: string
    baseUrl: string
    model: string
    apiKey?: string
  }) => ({
    id: 'provider_codex_oauth',
    provider: payload.provider,
    name: payload.name,
    baseUrl: payload.baseUrl,
    model: payload.model,
    apiKey: payload.apiKey,
  }))

  mockProviderManagerDependencies(
    () => undefined,
    async () => undefined,
    {
      addProviderProfile,
      applySavedProfileToCurrentSession,
      setActiveProviderProfile,
      useCodexOAuthFlow: ({ onAuthenticated }) => {
        React.useEffect(() => {
          void onAuthenticated({
            accessToken: 'oauth-access-token',
            refreshToken: 'oauth-refresh-token',
            accountId: 'acct_oauth',
          }, persistCredentials)
        }, [onAuthenticated])

        return {
          state: 'waiting',
          authUrl: 'https://chatgpt.com/codex',
          browserOpened: true,
        }
      },
    },
  )

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager, {
    mode: 'first-run',
    onDone,
  })

  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Set up provider') && frame.includes('Codex OAuth'),
  )

  await navigateToPreset(mounted.stdin, 'Codex OAuth')
  mounted.stdin.write('\r')

  await waitForCondition(() => onDone.mock.calls.length > 0)

  expect(persistCredentials).toHaveBeenCalledWith({
    profileId: 'provider_codex_oauth',
  })
  expect(setActiveProviderProfile).toHaveBeenCalledWith(
    'provider_codex_oauth',
  )
  expect(onDone).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'saved',
      message:
        'Codex OAuth configured. Saved for next startup. Warning: validation failed.',
    }),
  )

  await mounted.dispose()
})

test('ProviderManager does not hijack a manual Codex profile when OAuth credentials are not yet linked', async () => {
  delete process.env.CLAUDE_CODE_SIMPLE
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  const onDone = mock(() => {})
  const manualProfile = {
    id: 'provider_manual_codex',
    provider: 'openai',
    name: 'Codex OAuth',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    model: 'gpt-5.4',
    apiKey: 'manual-key',
  }
  const addProviderProfile = mock((payload: {
    provider: string
    name: string
    baseUrl: string
    model: string
    apiKey?: string
  }) => ({
    id: 'provider_codex_oauth',
    provider: payload.provider,
    name: payload.name,
    baseUrl: payload.baseUrl,
    model: payload.model,
    apiKey: payload.apiKey,
  }))
  const updateProviderProfile = mock(() => manualProfile)
  const persistCredentials = mock(() => {})
  const setActiveProviderProfile = mock((profileId: string) => ({
    id: profileId,
    provider: 'openai',
    name: 'Codex OAuth',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    model: 'codexplan',
    apiKey: '',
  }))

  mockProviderManagerDependencies(
    () => undefined,
    async () => undefined,
    {
      addProviderProfile,
      getProviderProfiles: () => [manualProfile],
      setActiveProviderProfile,
      updateProviderProfile,
      useCodexOAuthFlow: ({ onAuthenticated }) => {
        const hasAuthenticated = React.useRef(false)

        React.useEffect(() => {
          if (hasAuthenticated.current) {
            return
          }
          hasAuthenticated.current = true
          void onAuthenticated({
            accessToken: 'oauth-access-token',
            refreshToken: 'oauth-refresh-token',
            accountId: 'acct_oauth',
          }, persistCredentials)
        }, [onAuthenticated])

        return {
          state: 'waiting',
          authUrl: 'https://chatgpt.com/codex',
          browserOpened: true,
        }
      },
    },
  )

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager, {
    mode: 'first-run',
    onDone,
  })

  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Set up provider') && frame.includes('Codex OAuth'),
  )

  await navigateToPreset(mounted.stdin, 'Codex OAuth')
  mounted.stdin.write('\r')

  await waitForCondition(() => onDone.mock.calls.length > 0)

  expect(addProviderProfile).toHaveBeenCalledTimes(1)
  expect(updateProviderProfile).not.toHaveBeenCalled()
  expect(setActiveProviderProfile).toHaveBeenCalledWith(
    'provider_codex_oauth',
  )
  expect(persistCredentials).toHaveBeenCalledWith({
    profileId: 'provider_codex_oauth',
  })

  await mounted.dispose()
})

test('ProviderManager keeps Codex OAuth as next-startup only when activating the session fails from the menu', async () => {
  delete process.env.CLAUDE_CODE_SIMPLE
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  const codexProfile = {
    id: 'provider_codex_oauth',
    provider: 'openai',
    name: 'Codex OAuth',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    model: 'codexplan',
    apiKey: '',
  }

  const applySavedProfileToCurrentSession = mock(
    async () => 'validation failed',
  )
  const setActiveProviderProfile = mock(() => codexProfile)

  mockProviderManagerDependencies(
    () => undefined,
    async () => undefined,
    {
      applySavedProfileToCurrentSession,
      getProviderProfiles: () => [codexProfile],
      setActiveProviderProfile,
      codexAsyncRead: async () => ({
        accessToken: 'oauth-access-token',
        refreshToken: 'oauth-refresh-token',
        accountId: 'acct_oauth',
        profileId: 'provider_codex_oauth',
      }),
    },
  )

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)

  await waitForFrameOutput(
    mounted.getOutput,
    frame =>
      frame.includes('Provider manager') &&
      frame.includes('Set active provider') &&
      frame.includes('Log out Codex OAuth'),
  )

  mounted.stdin.write('j')
  await Bun.sleep(25)
  mounted.stdin.write('\r')

  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Set active provider') && frame.includes('Codex OAuth'),
  )

  await Bun.sleep(25)
  mounted.stdin.write('\r')

  await waitForCondition(() => setActiveProviderProfile.mock.calls.length > 0)
  await waitForCondition(
    () => applySavedProfileToCurrentSession.mock.calls.length > 0,
  )
  await Bun.sleep(50)
  const output = stripAnsi(extractLastFrame(mounted.getOutput()))

  expect(output).toContain(
    'Active provider: Codex OAuth. Saved for next startup. Warning: validation failed.',
  )
  expect(applySavedProfileToCurrentSession).toHaveBeenCalled()
  expect(setActiveProviderProfile).toHaveBeenCalledWith('provider_codex_oauth')

  await mounted.dispose()
})

test('ProviderManager activating a multi-model provider sets the session model to the primary model', async () => {
  delete process.env.CLAUDE_CODE_SIMPLE
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  const multiModelProfile = {
    id: 'provider_multi_model',
    provider: 'openai',
    name: 'Multi Model Provider',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.4; gpt-5.4-mini',
    apiKey: 'sk-test',
  }

  const setActiveProviderProfile = mock(() => multiModelProfile)
  const appStateChanges: Array<{ newState: any; oldState: any }> = []

  mockProviderManagerDependencies(
    () => undefined,
    async () => undefined,
    {
      getProviderProfiles: () => [multiModelProfile],
      setActiveProviderProfile,
    },
  )

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager, {
    onChangeAppState: args => {
      appStateChanges.push(args as { newState: any; oldState: any })
    },
  })

  await waitForFrameOutput(
    mounted.getOutput,
    frame =>
      frame.includes('Provider manager') &&
      frame.includes('Set active provider'),
  )

  mounted.stdin.write('j')
  await Bun.sleep(25)
  mounted.stdin.write('\r')

  await waitForFrameOutput(
    mounted.getOutput,
    frame =>
      frame.includes('Set active provider') &&
      frame.includes('Multi Model Provider'),
  )

  await Bun.sleep(25)
  mounted.stdin.write('\r')

  await waitForCondition(() => setActiveProviderProfile.mock.calls.length > 0)
  await waitForCondition(() =>
    appStateChanges.some(
      ({ newState, oldState }) =>
        newState.mainLoopModel === 'gpt-5.4' &&
        oldState.mainLoopModel !== newState.mainLoopModel,
    ),
  )

  expect(setActiveProviderProfile).toHaveBeenCalledWith('provider_multi_model')
  expect(
    appStateChanges.some(
      ({ newState }) =>
        newState.mainLoopModel === 'gpt-5.4' &&
        newState.mainLoopModelForSession === null,
    ),
  ).toBe(true)
  expect(
    appStateChanges.some(
      ({ newState }) => newState.mainLoopModel === 'gpt-5.4; gpt-5.4-mini',
    ),
  ).toBe(false)

  await mounted.dispose()
})

test('ProviderManager editing an active multi-model provider keeps app state on the primary model', async () => {
  delete process.env.CLAUDE_CODE_SIMPLE
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  const multiModelProfile = {
    id: 'provider_multi_model',
    provider: 'openai',
    name: 'Multi Model Provider',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.4; gpt-5.4-mini',
    apiKey: 'sk-test',
  }

  const updateProviderProfile = mock(() => multiModelProfile)
  const appStateChanges: Array<{ newState: any; oldState: any }> = []

  mockProviderManagerDependencies(
    () => undefined,
    async () => undefined,
    {
      getActiveProviderProfile: () => multiModelProfile,
      getProviderProfiles: () => [multiModelProfile],
      updateProviderProfile,
    },
  )

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager, {
    onChangeAppState: args => {
      appStateChanges.push(args as { newState: any; oldState: any })
    },
  })

  await waitForFrameOutput(
    mounted.getOutput,
    frame =>
      frame.includes('Provider manager') &&
      frame.includes('Edit provider'),
  )

  mounted.stdin.write('j')
  await Bun.sleep(25)
  mounted.stdin.write('j')
  await Bun.sleep(25)
  mounted.stdin.write('\r')

  await waitForFrameOutput(
    mounted.getOutput,
    frame =>
      frame.includes('Edit provider') &&
      frame.includes('Multi Model Provider'),
  )

  await Bun.sleep(25)
  mounted.stdin.write('\r')

  await waitForFrameOutput(
    mounted.getOutput,
    frame =>
      frame.includes('Edit provider profile') &&
      frame.includes('Step 1 of 8'),
  )

  mounted.stdin.write('\r')
  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Step 2 of 8'),
  )

  mounted.stdin.write('\r')
  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Step 3 of 8'),
  )

  mounted.stdin.write('\r')
  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Step 4 of 8'),
  )

  mounted.stdin.write('\r')
  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Step 5 of 8'),
  )

  mounted.stdin.write('\r')
  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Step 6 of 8'),
  )

  mounted.stdin.write('\r')
  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Step 7 of 8'),
  )

  mounted.stdin.write('\r')
  await waitForFrameOutput(
    mounted.getOutput,
    frame => frame.includes('Step 8 of 8'),
  )

  mounted.stdin.write('\r')

  await waitForCondition(() => updateProviderProfile.mock.calls.length > 0)
  await waitForCondition(() =>
    appStateChanges.some(
      ({ newState, oldState }) =>
        newState.mainLoopModel === 'gpt-5.4' &&
        oldState.mainLoopModel !== newState.mainLoopModel,
    ),
  )

  expect(updateProviderProfile).toHaveBeenCalledWith(
    'provider_multi_model',
    expect.objectContaining({
      model: 'gpt-5.4; gpt-5.4-mini',
    }),
  )
  expect(
    appStateChanges.some(
      ({ newState }) =>
        newState.mainLoopModel === 'gpt-5.4' &&
        newState.mainLoopModelForSession === null,
    ),
  ).toBe(true)
  expect(
    appStateChanges.some(
      ({ newState }) => newState.mainLoopModel === 'gpt-5.4; gpt-5.4-mini',
    ),
  ).toBe(false)

  await mounted.dispose()
})

test('ProviderManager set-active list uses descriptor-backed provider type labels', async () => {
  delete process.env.CLAUDE_CODE_SIMPLE
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  const geminiProfile = {
    id: 'provider_gemini',
    provider: 'gemini',
    name: 'Gemini Work',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-pro',
    apiKey: 'gm-test',
  }

  mockProviderManagerDependencies(
    () => undefined,
    async () => undefined,
    {
      getProviderProfiles: () => [geminiProfile],
    },
  )

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const mounted = await mountProviderManager(ProviderManager)

  await waitForFrameOutput(
    mounted.getOutput,
    frame =>
      frame.includes('Provider manager') &&
      frame.includes('Set active provider'),
  )

  mounted.stdin.write('j')
  await Bun.sleep(25)
  mounted.stdin.write('\r')

  const output = await waitForFrameOutput(
    mounted.getOutput,
    frame =>
      frame.includes('Set active provider') &&
      frame.includes('Gemini Work') &&
      frame.includes('Gemini API'),
  )

  expect(output).toContain(
    'Gemini API · https://generativelanguage.googleapis.com/v1beta/openai · gemini-2.5-pro',
  )

  await mounted.dispose()
})

test('ProviderManager resolves Codex OAuth state from async storage without sync reads in render flow', async () => {
  delete process.env.CLAUDE_CODE_SIMPLE
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  const githubSyncRead = mock(() => undefined)
  const githubAsyncRead = mock(async () => undefined)
  const codexSyncRead = mock(() => {
    throw new Error('sync codex credential read should not run in ProviderManager render flow')
  })
  const codexAsyncRead = mock(async () => ({
    accessToken: 'codex-access-token',
    refreshToken: 'codex-refresh-token',
  }))

  mockProviderManagerDependencies(githubSyncRead, githubAsyncRead, {
    codexSyncRead,
    codexAsyncRead,
  })

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const output = await renderProviderManagerFrame(ProviderManager, {
    waitForOutput: frame =>
      frame.includes('Provider manager') &&
      frame.includes('Log out Codex OAuth'),
  })

  expect(output).toContain('Provider manager')
  expect(output).toContain('Log out Codex OAuth')
  expect(codexSyncRead).not.toHaveBeenCalled()
  expect(codexAsyncRead).toHaveBeenCalled()
})

test('ProviderManager hides Codex OAuth setup in bare mode', async () => {
  process.env.CLAUDE_CODE_SIMPLE = '1'
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN

  const githubSyncRead = mock(() => undefined)
  const githubAsyncRead = mock(async () => undefined)

  mockProviderManagerDependencies(githubSyncRead, githubAsyncRead)

  const nonce = `${Date.now()}-${Math.random()}`
  const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
  const output = await renderProviderManagerFrame(ProviderManager, {
    mode: 'first-run',
    waitForOutput: frame =>
      frame.includes('Set up provider') && frame.includes('OpenAI'),
  })

  expect(output).toContain('Set up provider')
  expect(output).not.toContain('Codex OAuth')
})

test('ProviderManager switches back to Anthropic via the manager UI: resets the model and clears managed env', async () => {
  // GitHub Models is the active provider with no saved profiles. Selecting the
  // "Use Anthropic (built-in)" recovery option must reset the session model and
  // drop the managed CLAUDE_CODE_USE_* flags. This is the production switch-back
  // path; the existing util tests only cover the sentinel in isolation.
  //
  // The test mutates process-wide env and mounts an Ink app, so both are
  // snapshotted/restored in finally — a failed wait or assertion must not leak
  // provider flags or a live mount into later tests.
  const envKeys = [
    'CLAUDE_CODE_USE_GITHUB',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'CLAUDE_CODE_SIMPLE',
  ]
  const envSnapshot = new Map(envKeys.map(key => [key, process.env[key]] as const))
  let mounted: Awaited<ReturnType<typeof mountProviderManager>> | undefined

  try {
    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    delete process.env.GITHUB_TOKEN
    delete process.env.GH_TOKEN
    delete process.env.CLAUDE_CODE_SIMPLE

    // Capture the real providerProfiles module before any mock replaces it so the
    // Anthropic sentinel id and preset helpers stay intact.
    const realProviderProfiles = await import('../utils/providerProfiles.js')

    const githubSyncRead = mock(() => undefined)
    const githubAsyncRead = mock(async () => undefined)
    mockProviderManagerDependencies(githubSyncRead, githubAsyncRead, {
      getProviderProfiles: () => [],
      getActiveProviderProfile: () => null,
    })

    const clearActiveProviderProfile = mock(() => {
      for (const key of Object.keys(process.env)) {
        if (key.startsWith('CLAUDE_CODE_USE_')) {
          delete process.env[key]
        }
      }
      return true
    })
    const clearHydratedGithubModelsTokenFromEnv = mock(() => {})
    // Seed a stored GitHub Models token so the switch-back path has a real
    // token to forward into the cleanup helper (rather than `undefined`).
    const storedToken = 'ghp_stored_secure_storage_token'

    mock.module('../utils/providerProfiles.js', () => ({
      ...realProviderProfiles,
      applyActiveProviderProfileFromConfig: () => {},
      getProviderProfiles: () => [],
      getActiveProviderProfile: () => null,
      setActiveProviderProfile: mock(() => null),
      clearActiveProviderProfile,
    }))
    mock.module('../utils/githubModelsCredentials.js', () => ({
      clearGithubModelsToken: () => ({ success: true }),
      clearHydratedGithubModelsTokenFromEnv,
      GITHUB_MODELS_HYDRATED_ENV_MARKER: 'CLAUDE_CODE_GITHUB_TOKEN_HYDRATED',
      hydrateGithubModelsTokenFromSecureStorage: () => {},
      readGithubModelsToken: () => storedToken,
      readGithubModelsTokenAsync: async () => storedToken,
    }))
    const clearStartupProviderOverrides = mock(() => null)
    mock.module('../utils/providerStartupOverrides.js', () => ({
      clearStartupProviderOverrides,
    }))

    const onDoneResults: Array<Record<string, unknown>> = []
    const appStateChanges: Array<{ newState: any; oldState: any }> = []
    const nonce = `${Date.now()}-${Math.random()}`
    const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
    mounted = await mountProviderManager(ProviderManager, {
      onDone: result => {
        if (result && typeof result === 'object') {
          onDoneResults.push(result as Record<string, unknown>)
        }
      },
      onChangeAppState: args => {
        appStateChanges.push(args as { newState: any; oldState: any })
      },
    })

    await waitForFrameOutput(
      mounted.getOutput,
      frame =>
        frame.includes('Provider manager') &&
        frame.includes('Set active provider'),
    )

    // Open "Set active provider" (second menu item).
    mounted.stdin.write('j')
    await Bun.sleep(25)
    mounted.stdin.write('\r')

    // Options here are [GitHub Models (active), Use Anthropic (built-in)]; move
    // down to the switch-back option and select it.
    await waitForFrameOutput(
      mounted.getOutput,
      frame => frame.includes('Use Anthropic (built-in)'),
    )

    mounted.stdin.write('j')
    await Bun.sleep(25)
    mounted.stdin.write('\r')

    await waitForCondition(() => onDoneResults.length > 0)

    const result = onDoneResults[0]
    expect(result.action).toBe('activated')
    expect(String(result.activeProviderName)).toMatch(/anthropic/i)
    expect(typeof result.activeProviderModel).toBe('string')
    expect((result.activeProviderModel as string).length).toBeGreaterThan(0)
    // The switch-back must also refresh the live session AppState — that is the
    // path onChangeAppState uses to update the runtime mainLoopModelOverride, so
    // without it the running session could keep the previous provider model after
    // selecting "Use Anthropic (built-in)". Mirror the active-provider tests:
    // assert the AppState update sets mainLoopModel to the Anthropic model from
    // the result and clears mainLoopModelForSession to null.
    const anthropicModel = result.activeProviderModel as string
    await waitForCondition(() =>
      appStateChanges.some(
        ({ newState }) => newState.mainLoopModel === anthropicModel,
      ),
    )
    expect(
      appStateChanges.some(
        ({ newState, oldState }) =>
          newState.mainLoopModel === anthropicModel &&
          oldState.mainLoopModel !== newState.mainLoopModel,
      ),
    ).toBe(true)
    expect(
      appStateChanges.some(
        ({ newState }) =>
          newState.mainLoopModel === anthropicModel &&
          newState.mainLoopModelForSession === null,
      ),
    ).toBe(true)
    expect(
      Object.keys(process.env).some(key => key.startsWith('CLAUDE_CODE_USE_')),
    ).toBe(false)
    expect(clearActiveProviderProfile).toHaveBeenCalled()
    // The switch-back must forward the stored token into the cleanup helper so
    // it clears only the hydrated secure-storage token and preserves a
    // user-supplied GITHUB_TOKEN. Asserting the argument (not just the call)
    // means the test fails if the branch stops forwarding the stored token.
    expect(clearHydratedGithubModelsTokenFromEnv).toHaveBeenCalledWith(storedToken)
    // The restart fix depends on clearing persisted startup provider overrides
    // after clearActiveProviderProfile(); without this the next launch replays
    // the third-party provider. Anchor on the mocked symbol so the test fails
    // if the Anthropic branch stops calling it.
    expect(clearStartupProviderOverrides).toHaveBeenCalled()
  } finally {
    if (mounted) {
      await mounted.dispose()
    }
    for (const [key, value] of envSnapshot) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
})

test('ProviderManager deleting the GitHub provider reverts the hydrated credential via the shared cleanup helper', async () => {
  // Regression for the #1429 review: the GitHub Models delete path used to
  // hand-roll its own cleanup that only dropped GITHUB_TOKEN, so a hydrated
  // `copilot_key` (which hydrateGithubModelsTokenFromSecureStorage stores in
  // GITHUB_COPILOT_KEY under the same marker) was left behind once the marker
  // was removed. The delete flow must now delegate to the shared
  // clearHydratedGithubModelsTokenFromEnv helper — the same one the switch-back
  // path uses — so both GitHub Models removal paths revert the hydrated
  // credential consistently. Asserting the helper is invoked with the stored
  // token proves the delete path shares that cleanup rather than the old
  // partial version.
  const envKeys = [
    'CLAUDE_CODE_USE_GITHUB',
    'GITHUB_TOKEN',
    'GITHUB_COPILOT_KEY',
    'GH_TOKEN',
    'CLAUDE_CODE_SIMPLE',
  ]
  const envSnapshot = new Map(envKeys.map(key => [key, process.env[key]] as const))
  let mounted: Awaited<ReturnType<typeof mountProviderManager>> | undefined

  try {
    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    delete process.env.GITHUB_TOKEN
    delete process.env.GITHUB_COPILOT_KEY
    delete process.env.GH_TOKEN
    delete process.env.CLAUDE_CODE_SIMPLE

    const realProviderProfiles = await import('../utils/providerProfiles.js')

    const githubSyncRead = mock(() => undefined)
    const githubAsyncRead = mock(async () => undefined)
    mockProviderManagerDependencies(githubSyncRead, githubAsyncRead, {
      getProviderProfiles: () => [],
      getActiveProviderProfile: () => null,
    })

    const clearHydratedGithubModelsTokenFromEnv = mock(() => {})
    // Seed a stored GitHub Models token so the delete path forwards a real token
    // into the cleanup helper (rather than `undefined`).
    const storedToken = 'ghp_stored_secure_storage_token'

    mock.module('../utils/providerProfiles.js', () => ({
      ...realProviderProfiles,
      applyActiveProviderProfileFromConfig: () => {},
      getProviderProfiles: () => [],
      getActiveProviderProfile: () => null,
    }))
    mock.module('../utils/githubModelsCredentials.js', () => ({
      clearGithubModelsToken: () => ({ success: true }),
      clearHydratedGithubModelsTokenFromEnv,
      GITHUB_MODELS_HYDRATED_ENV_MARKER: 'CLAUDE_CODE_GITHUB_TOKEN_HYDRATED',
      hydrateGithubModelsTokenFromSecureStorage: () => {},
      readGithubModelsToken: () => storedToken,
      readGithubModelsTokenAsync: async () => storedToken,
    }))

    const nonce = `${Date.now()}-${Math.random()}`
    const { ProviderManager } = await import(`./ProviderManager.js?ts=${nonce}`)
    mounted = await mountProviderManager(ProviderManager)

    await waitForFrameOutput(
      mounted.getOutput,
      frame =>
        frame.includes('Provider manager') &&
        frame.includes('Delete provider'),
    )

    // Menu order is [Add, Set active, Edit, Delete, ...]; move to "Delete
    // provider" and open it.
    mounted.stdin.write('j')
    await Bun.sleep(25)
    mounted.stdin.write('j')
    await Bun.sleep(25)
    mounted.stdin.write('j')
    await Bun.sleep(25)
    mounted.stdin.write('\r')

    // The active GitHub Models provider is the deletable entry; wait for the
    // delete list to render before selecting it (avoid a render race).
    await waitForFrameOutput(
      mounted.getOutput,
      frame => frame.includes('Delete provider') && frame.includes('GitHub Models'),
    )
    await Bun.sleep(40)
    mounted.stdin.write('\r')

    await waitForCondition(
      () => clearHydratedGithubModelsTokenFromEnv.mock.calls.length > 0,
    )

    // The delete path must forward the stored token into the shared cleanup
    // helper (which reverts both the GITHUB_TOKEN and GITHUB_COPILOT_KEY
    // hydration modes). Asserting the argument — not just that it was called —
    // fails the test if the delete path regresses to a partial hand-rolled
    // cleanup that leaves the hydrated Copilot key behind.
    expect(clearHydratedGithubModelsTokenFromEnv).toHaveBeenCalledWith(storedToken)
  } finally {
    if (mounted) {
      await mounted.dispose()
    }
    for (const [key, value] of envSnapshot) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
})
