import { resolve } from 'node:path'
import { hasPrintFlag } from './printFlag.js'
import '../integrations/index.js'
import {
  ensureIntegrationsLoaded,
  getAllGateways,
  getAllVendors,
} from '../integrations/index.js'
import type {
  GatewayDescriptor,
  ValidationMetadata,
  VendorDescriptor,
} from '../integrations/descriptors.js'
import {
  getMiniMaxBaseUrlOverride,
  getMiniMaxBaseUrlValidationError,
  getRouteCredentialEnvVars,
  getRouteCredentialValue,
  getRouteDescriptor,
  getRouteDefaultModel,
  isCanonicalApiRouteInferenceBaseUrl,
  isCanonicalApismartInferenceBaseUrl,
  isCanonicalConcentrateInferenceBaseUrl,
  isCanonicalCommandcodeInferenceBaseUrl,
  isCloudflareBaseUrl,
  isLongcatBaseUrl,
  matchHostnameAgainstRouteHosts,
  resolveActiveRouteIdFromEnv,
  resolveRouteIdFromBaseUrl,
} from '../integrations/routeMetadata.js'
import {
  getGithubEndpointType,
  isLikelyOllamaEndpoint,
  isLocalProviderUrl,
  resolveCodexApiCredentials,
  resolveProviderRequest,
  shouldUseCodexTransport,
} from '../services/api/providerConfig.js'
import { hasUsableOpenAICredential } from '../services/api/credentialPool.js'
import { getGlobalClaudeFile } from './env.js'
import { isBareMode } from './envUtils.js'
import {
  type GeminiResolvedCredential,
  resolveGeminiCredential,
} from './geminiAuth.js'
import { getCommandcodeChatCompletionsModelError } from '../integrations/gateways/commandcode.js'
import { readXaiCredentialsAsync } from './xaiCredentials.js'

async function defaultHasStoredXaiOAuthCredentials(): Promise<boolean> {
  const stored = await readXaiCredentialsAsync()
  return Boolean(stored?.accessToken && stored?.refreshToken)
}
import {
  PROFILE_FILE_NAME,
  resolveOpenAICredentialEnvState,
} from './providerProfile.js'
import {
  redactSecretValueForDisplay,
  type SecretValueSource,
} from './providerSecrets.js'

function isEnvTruthy(value: string | undefined): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'no'
}

type GithubTokenStatus = 'valid' | 'expired' | 'invalid_format'

type ValidationTarget =
  | { kind: 'vendor'; descriptor: VendorDescriptor }
  | { kind: 'gateway'; descriptor: GatewayDescriptor }

const GITHUB_PAT_PREFIXES = ['ghp_', 'gho_', 'ghs_', 'ghr_', 'github_pat_']

function checkGithubTokenStatus(
  token: string,
  endpointType: 'copilot' | 'models' | 'ghe' | 'custom' = 'copilot',
): GithubTokenStatus {
  // PATs work with GitHub Models but not with Copilot API
  // For GHE, PATs work if they have the right scopes
  if (GITHUB_PAT_PREFIXES.some(prefix => token.startsWith(prefix))) {
    if (endpointType === 'copilot') {
      return 'expired'
    }
    return 'valid'
  }

  const expMatch = token.match(/exp=(\d+)/)
  if (expMatch) {
    const expSeconds = Number(expMatch[1])
    if (!Number.isNaN(expSeconds)) {
      return Date.now() >= expSeconds * 1000 ? 'expired' : 'valid'
    }
  }

  const parts = token.split('.')
  const looksLikeJwt =
    parts.length === 3 && parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))
  if (looksLikeJwt) {
    try {
      const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/')
      const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
      const json = Buffer.from(padded, 'base64').toString('utf8')
      const parsed = JSON.parse(json)
      if (parsed && typeof parsed === 'object' && parsed.exp) {
        return Date.now() >= (parsed.exp as number) * 1000 ? 'expired' : 'valid'
      }
    } catch {
      return 'invalid_format'
    }
  }

  // Keep compatibility with opaque token formats that do not expose expiry.
  return 'valid'
}

function getOpenAIMissingKeyMessage(): string {
  const globalConfigPath = getGlobalClaudeFile()
  const profilePath = resolve(process.cwd(), PROFILE_FILE_NAME)

  return [
    'OPENAI_API_KEYS or OPENAI_API_KEY is required when CLAUDE_CODE_USE_OPENAI=1 and OPENAI_BASE_URL is not local.',
    `To recover, run /provider and switch provider, or set CLAUDE_CODE_USE_OPENAI=0 in your shell environment.`,
    `Saved startup settings can come from ${globalConfigPath} or ${profilePath}.`,
  ].join('\n')
}

function hasNonEmptyEnvValue(
  env: NodeJS.ProcessEnv,
  envVar: string,
): boolean {
  return typeof env[envVar] === 'string' && env[envVar]!.trim() !== ''
}

function hasUsableCredentialEnvValue(
  env: NodeJS.ProcessEnv,
  envVar: string,
): boolean {
  const value = env[envVar]
  if (typeof value !== 'string') {
    return false
  }

  if (
    envVar === 'OPENAI_API_KEYS' ||
    envVar === 'OPENAI_API_KEY' ||
    envVar === 'AIMLAPI_API_KEY' ||
    envVar === 'APISMART_API_KEY' ||
    envVar === 'API_ROUTE_API_KEY' ||
    envVar === 'CONCENTRATE_API_KEY' ||
    envVar === 'LLMTR_API_KEY' ||
    envVar === 'CMD_API_KEY' ||
    envVar === 'COMMANDCODE_API_KEY' ||
    envVar === 'COMMAND_CODE_API_KEY'
  ) {
    return hasUsableOpenAICredential(value)
  }

  return value.trim() !== ''
}

function hasOpenAICredential(env: NodeJS.ProcessEnv): boolean {
  return (
    hasUsableCredentialEnvValue(env, 'OPENAI_API_KEYS') ||
    hasUsableCredentialEnvValue(env, 'OPENAI_API_KEY')
  )
}

function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) {
    return undefined
  }

  const trimmed = baseUrl.trim()
  if (!trimmed) {
    return undefined
  }

  return trimmed.replace(/\/+$/, '').toLowerCase()
}

function baseUrlMatchesDescriptor(
  baseUrl: string | undefined,
  descriptorBaseUrl: string | undefined,
): boolean {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  const normalizedDescriptorBaseUrl = normalizeBaseUrl(descriptorBaseUrl)

  return Boolean(
    normalizedBaseUrl &&
      normalizedDescriptorBaseUrl &&
      normalizedBaseUrl === normalizedDescriptorBaseUrl,
  )
}

function getNormalizedBaseUrlHost(
  baseUrl: string | undefined,
): string | undefined {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  if (!normalizedBaseUrl) {
    return undefined
  }

  try {
    return new URL(normalizedBaseUrl).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

function getValidationTargets(): ValidationTarget[] {
  ensureIntegrationsLoaded()

  return [
    ...getAllVendors()
      .filter((descriptor): descriptor is VendorDescriptor => Boolean(descriptor.validation))
      .map(descriptor => ({ kind: 'vendor', descriptor }) as const),
    ...getAllGateways()
      .filter((descriptor): descriptor is GatewayDescriptor => Boolean(descriptor.validation))
      .map(descriptor => ({ kind: 'gateway', descriptor }) as const),
  ]
}

function getValidationRouting(target: ValidationTarget) {
  return target.descriptor.validation?.routing
}

function isGithubEnterpriseValidationEnv(env: NodeJS.ProcessEnv): boolean {
  if (env.GITHUB_ENTERPRISE_URL?.trim()) {
    return true
  }
  return getGithubEndpointType(env.OPENAI_BASE_URL) === 'ghe'
}

function getValidationTargetBaseUrl(
  target: ValidationTarget,
): string | undefined {
  return target.descriptor.defaultBaseUrl
}

function getRuntimeValidationTarget(
  env: NodeJS.ProcessEnv,
): ValidationTarget | undefined {
  const useOpenAI = isEnvTruthy(env.CLAUDE_CODE_USE_OPENAI)
  const validationTargets = getValidationTargets()

  const enabledTarget = validationTargets.find(target => {
    const routing = getValidationRouting(target)
    if (!routing?.enablementEnvVar || !isEnvTruthy(env[routing.enablementEnvVar])) {
      return false
    }

    if (useOpenAI && routing.skipWhenUseOpenAI) {
      return false
    }

    if (target.kind === 'gateway') {
      if (target.descriptor.id === 'github-enterprise') {
        return isGithubEnterpriseValidationEnv(env)
      }
      if (
        target.descriptor.id === 'github' &&
        isGithubEnterpriseValidationEnv(env)
      ) {
        return false
      }
    }

    return true
  })

  if (enabledTarget) {
    return enabledTarget
  }

  // The documented CONCENTRATE_API_KEY-only and API_ROUTE_API_KEY-only setup
  // is routed before the client applies its default base URL. Select its descriptor
  // directly so startup validates the dedicated credential, including a noncanonical
  // dedicated base URL, instead of returning early for an unset OpenAI mode.
  const activeRouteId = resolveActiveRouteIdFromEnv(env)
  if (activeRouteId === 'concentrate' || activeRouteId === 'api-route') {
    return validationTargets.find(target => target.descriptor.id === activeRouteId)
  }

  if (!useOpenAI) {
    return undefined
  }

  const request = resolveProviderRequest({
    model: env.OPENAI_MODEL,
    baseUrl: env.OPENAI_BASE_URL?.trim() || env.OPENAI_API_BASE?.trim(),
    fallbackModel: getRouteDefaultModel('openai'),
  })

  const baseUrlMatchedTarget = validationTargets.find(target => {
    const routing = getValidationRouting(target)
    if (!routing?.matchDefaultBaseUrl && !routing?.matchBaseUrlHosts?.length) {
      return false
    }

    // Some routes have stricter endpoint boundaries than a host match. Keep
    // validation aligned with the runtime resolver so a custom endpoint on a
    // shared host is not forced through a dedicated-credential contract.
    if (
      ((target.descriptor.id === 'cloudflare' &&
        !isCloudflareBaseUrl(request.baseUrl)) ||
        (target.descriptor.id === 'longcat' &&
          !isLongcatBaseUrl(request.baseUrl)) ||
        (target.descriptor.id === 'apismart' &&
          !isCanonicalApismartInferenceBaseUrl(request.baseUrl)) ||
        (target.descriptor.id === 'concentrate' &&
          !isCanonicalConcentrateInferenceBaseUrl(request.baseUrl)) ||
        (target.descriptor.id === 'api-route' &&
          !isCanonicalApiRouteInferenceBaseUrl(request.baseUrl)) ||
        (target.descriptor.id === 'commandcode' &&
          !isCanonicalCommandcodeInferenceBaseUrl(request.baseUrl)))
    ) {
      return false
    }

    if (baseUrlMatchesDescriptor(
      request.baseUrl,
      getValidationTargetBaseUrl(target),
    )) {
      return true
    }

    const requestHost = getNormalizedBaseUrlHost(request.baseUrl)
    if (!requestHost) {
      return false
    }

    return (
      routing.matchBaseUrlHosts &&
      matchHostnameAgainstRouteHosts(requestHost, routing.matchBaseUrlHosts)
    )
  })

  if (baseUrlMatchedTarget) {
    return baseUrlMatchedTarget
  }

  return validationTargets.find(
    target => getValidationRouting(target)?.fallbackWhenUseOpenAI,
  )
}

function getCredentialEnvValidationError(
  validation: Extract<ValidationMetadata, { kind: 'credential-env' }>,
  env: NodeJS.ProcessEnv,
  request?: ReturnType<typeof resolveProviderRequest>,
): string | null {
  const credentialEnvVars = validation.credentialEnvVars
  const usesOpenAIFallback =
    credentialEnvVars.includes('OPENAI_API_KEYS') ||
    credentialEnvVars.includes('OPENAI_API_KEY')

  if (usesOpenAIFallback) {
    const openAIState = resolveOpenAICredentialEnvState(env)
    if (openAIState.invalid) {
      const hasUsableDedicatedCredential = credentialEnvVars.some(
        envVar =>
          envVar !== 'OPENAI_API_KEYS' &&
          envVar !== 'OPENAI_API_KEY' &&
          hasUsableCredentialEnvValue(env, envVar),
      )
      if (!hasUsableDedicatedCredential) {
        return (
          validation.invalidCredentialValues?.find(
            invalidValue => invalidValue.envVar === openAIState.envVar,
          )?.message ??
          validation.missingCredentialMessage ??
          null
        )
      }
    }
  }

  for (const invalidValue of validation.invalidCredentialValues ?? []) {
    if (
      usesOpenAIFallback &&
      (invalidValue.envVar === 'OPENAI_API_KEYS' ||
        invalidValue.envVar === 'OPENAI_API_KEY')
    ) {
      continue
    }

    const envValue = env[invalidValue.envVar]
    const envValues = (envValue ?? '').split(',').map(value => value.trim())
    if (envValues.includes(invalidValue.value)) {
      return invalidValue.message
    }
  }

  if (
    validation.allowLocalBaseUrlWithoutCredential &&
    request &&
    (isLocalProviderUrl(request.baseUrl) ||
      isLikelyOllamaEndpoint(request.baseUrl))
  ) {
    return null
  }

  if (
    credentialEnvVars.some(envVar => hasUsableCredentialEnvValue(env, envVar))
  ) {
    return null
  }

  return validation.missingCredentialMessage ?? null
}

async function getDescriptorValidationError(
  target: ValidationTarget,
  env: NodeJS.ProcessEnv,
  options: {
    request?: ReturnType<typeof resolveProviderRequest>
    resolveGeminiCredential?: (
      env: NodeJS.ProcessEnv,
    ) => Promise<GeminiResolvedCredential>
    hasStoredXaiOAuthCredentials?: () => Promise<boolean>
  },
): Promise<string | null> {
  const validation = target.descriptor.validation
  if (!validation) {
    return null
  }

  // An explicit Concentrate credential carries the dedicated contract. A
  // same-host proxy with only generic OpenAI variables is not selected as this
  // route, but once Concentrate is selected its base must be canonical.
  const concentrateBaseUrl =
    env.CONCENTRATE_BASE_URL?.trim() ||
    env.OPENAI_BASE_URL?.trim() ||
    env.OPENAI_API_BASE?.trim()
  if (
    target.descriptor.id === 'concentrate' &&
    concentrateBaseUrl &&
    !isCanonicalConcentrateInferenceBaseUrl(concentrateBaseUrl)
  ) {
    return 'Concentrate credentials require the canonical https://api.concentrate.ai/v1 endpoint.'
  }

  const apiRouteBaseUrl =
    env.OPENAI_BASE_URL?.trim() ||
    env.OPENAI_API_BASE?.trim()
  if (
    target.descriptor.id === 'api-route' &&
    apiRouteBaseUrl &&
    !isCanonicalApiRouteInferenceBaseUrl(apiRouteBaseUrl)
  ) {
    return 'API Route credentials require the canonical https://global.api-route.com/v1 endpoint.'
  }

  switch (validation.kind) {
    case 'credential-env':
      return getCredentialEnvValidationError(validation, env, options.request)

    case 'gemini-credential': {
      const geminiCredential = await (
        options.resolveGeminiCredential ?? resolveGeminiCredential
      )(env)
      return geminiCredential.kind === 'none'
        ? validation.missingCredentialMessage
        : null
    }

    case 'github-token': {
      // GITHUB_COPILOT_KEY is a direct API key for GitHub Copilot Enterprise
      // It doesn't need token status validation as it's used directly
      if (env.GITHUB_COPILOT_KEY?.trim()) {
        return null
      }

      const token = (env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim()) ?? ''
      if (!token) {
        return validation.missingCredentialMessage
      }

      const githubEnterpriseUrl = env.GITHUB_ENTERPRISE_URL?.trim()
      const endpointType = githubEnterpriseUrl
        ? (env.OPENAI_BASE_URL?.trim()
          ? getGithubEndpointType(env.OPENAI_BASE_URL, {
            githubEnterpriseUrl,
          })
          : 'ghe')
        : getGithubEndpointType(env.OPENAI_BASE_URL)
      const status = checkGithubTokenStatus(token, endpointType)
      if (status === 'expired') {
        return validation.expiredCredentialMessage
      }
      if (status === 'invalid_format') {
        return validation.invalidCredentialMessage
      }

      return null
    }

    case 'xai-credential': {
      // 1. API key in env (legacy / explicit override path)
      if (
        validation.credentialEnvVars.some(envVar => hasNonEmptyEnvValue(env, envVar))
      ) {
        return null
      }
      // 2. OAuth profile marker, e.g. XAI_CREDENTIAL_SOURCE=oauth set by
      // the saved profile's env. Cheap synchronous check before we touch
      // secure storage.
      const markers = validation.credentialSourceEnvMarkers
      if (markers) {
        for (const [markerEnv, allowedValues] of Object.entries(markers)) {
          const value = env[markerEnv]?.trim()
          if (value && allowedValues.includes(value)) {
            return null
          }
        }
      }
      // 3. Stored OAuth credentials — covers the gap where a user has
      // signed in (secure storage populated) but the profile env hasn't
      // been applied yet (e.g. fresh process before applySavedProfile).
      // Bare mode short-circuits inside readXaiCredentialsAsync, so this
      // is safe to call unconditionally. Injectable so tests don't
      // depend on the developer's actual login state.
      const hasStored = options.hasStoredXaiOAuthCredentials
        ? await options.hasStoredXaiOAuthCredentials()
        : await defaultHasStoredXaiOAuthCredentials()
      if (hasStored) {
        return null
      }
      return validation.missingCredentialMessage
    }
  }
}

function getGenericRouteCredentialValidationError(
  env: NodeJS.ProcessEnv,
  request: ReturnType<typeof resolveProviderRequest>,
): { applicable: boolean; error: string | null } {
  const routeId =
    resolveRouteIdFromBaseUrl(request.baseUrl) ??
    resolveActiveRouteIdFromEnv(env)
  if (!routeId || routeId === 'anthropic' || routeId === 'custom') {
    return { applicable: false, error: null }
  }

  const descriptor = getRouteDescriptor(routeId)
  if (
    !descriptor ||
    descriptor.validation ||
    !descriptor.setup.requiresAuth ||
    !['openai-compatible', 'local'].includes(descriptor.transportConfig.kind)
  ) {
    return { applicable: false, error: null }
  }

  if (
    descriptor.setup.authMode !== 'api-key' &&
    descriptor.setup.authMode !== 'token'
  ) {
    return { applicable: false, error: null }
  }

  if (
    descriptor.setup.authMode === 'api-key' &&
    isLocalProviderUrl(request.baseUrl)
  ) {
    return { applicable: true, error: null }
  }

  if (getRouteCredentialValue(routeId, env)) {
    return { applicable: true, error: null }
  }

  const credentialEnvVars = getRouteCredentialEnvVars(routeId)
  if (credentialEnvVars.length === 0) {
    return { applicable: false, error: null }
  }

  return {
    applicable: true,
    error: `${descriptor.label} auth is required. Set ${credentialEnvVars.join(' or ')}.`,
  }
}

export async function getProviderValidationError(
  env: NodeJS.ProcessEnv = process.env,
  options?: {
    resolveGeminiCredential?: (
      env: NodeJS.ProcessEnv,
    ) => Promise<GeminiResolvedCredential>
    hasStoredXaiOAuthCredentials?: () => Promise<boolean>
  },
): Promise<string | null> {
  const secretSource = env as SecretValueSource
  const useOpenAI = isEnvTruthy(env.CLAUDE_CODE_USE_OPENAI)
  const validationTarget = getRuntimeValidationTarget(env)

  if (resolveActiveRouteIdFromEnv(env) === 'minimax') {
    const baseUrl = useOpenAI
      ? env.OPENAI_BASE_URL?.trim() || env.OPENAI_API_BASE?.trim()
      : getMiniMaxBaseUrlOverride(env)
    const validationError = getMiniMaxBaseUrlValidationError(baseUrl)
    if (validationError) return validationError
  }

  if (!useOpenAI && !validationTarget) {
    return null
  }

  const request = resolveProviderRequest({
    model: env.OPENAI_MODEL,
    baseUrl: env.OPENAI_BASE_URL,
    fallbackModel: getRouteDefaultModel('openai'),
  })
  const genericRouteValidation = getGenericRouteCredentialValidationError(
    env,
    request,
  )

  // Codex auth depends on transport resolution plus local auth/account state,
  // so it intentionally stays procedural instead of moving into descriptors.
  const explicitBaseUrl =
    env.OPENAI_BASE_URL?.trim() || env.OPENAI_API_BASE?.trim()
  const hasExplicitCodexIntent =
    (env.OPENAI_MODEL?.trim()
      ? shouldUseCodexTransport(env.OPENAI_MODEL, explicitBaseUrl)
      : false) || Boolean(explicitBaseUrl && shouldUseCodexTransport('', explicitBaseUrl))

  if (hasExplicitCodexIntent) {
    const credentials = resolveCodexApiCredentials(env)
    if (!credentials.apiKey) {
      const oauthHint = isBareMode() ? '' : ', choose Codex OAuth in /provider'
      const authHint = credentials.authPath
        ? `${oauthHint} or put auth.json at ${credentials.authPath}`
        : oauthHint
      const safeModel =
        redactSecretValueForDisplay(env.OPENAI_MODEL, secretSource) ??
        redactSecretValueForDisplay(request.requestedModel, secretSource) ??
        'the requested model'
      return `Codex auth is required for ${safeModel}. Set CODEX_API_KEY${authHint}.`
    }
    if (!credentials.accountId) {
      return 'Codex auth is missing chatgpt_account_id. Re-login with Codex OAuth, Codex CLI, or set CHATGPT_ACCOUNT_ID/CODEX_ACCOUNT_ID.'
    }
    return null
  }

  const activeRouteId = resolveActiveRouteIdFromEnv(env)
  if (activeRouteId === 'commandcode') {
    const modelError = getCommandcodeChatCompletionsModelError(
      request.resolvedModel,
    )
    if (modelError) return modelError
  }
  const shouldPreferGenericRouteValidation =
    validationTarget?.kind === 'vendor' &&
    validationTarget.descriptor.id === 'openai' &&
    genericRouteValidation.applicable &&
    activeRouteId !== 'openai' &&
    activeRouteId !== 'custom'

  if (validationTarget) {
    if (!shouldPreferGenericRouteValidation) {
      const descriptorValidationError = await getDescriptorValidationError(
        validationTarget,
        env,
        {
          request,
          resolveGeminiCredential: options?.resolveGeminiCredential,
          hasStoredXaiOAuthCredentials: options?.hasStoredXaiOAuthCredentials,
        },
      )

      if (descriptorValidationError) {
        if (
          descriptorValidationError ===
            validationTarget.descriptor.validation?.missingCredentialMessage &&
          validationTarget.kind === 'vendor' &&
          validationTarget.descriptor.id === 'openai' &&
          !hasOpenAICredential(env) &&
          !isLocalProviderUrl(request.baseUrl) &&
          !isLikelyOllamaEndpoint(request.baseUrl)
        ) {
          return getOpenAIMissingKeyMessage()
        }

        return descriptorValidationError
      }

      return null
    }
  }

  if (genericRouteValidation.applicable) {
    return genericRouteValidation.error
  }

  if (
    !hasOpenAICredential(env) &&
    !isLocalProviderUrl(request.baseUrl) &&
    !isLikelyOllamaEndpoint(request.baseUrl)
  ) {
    // If we have a validation target that explicitly says it doesn't require auth,
    // we should not require OPENAI_API_KEY.
    if (validationTarget?.descriptor.setup?.requiresAuth === false) {
      return null
    }

    // For other OpenAI-compatible providers, check if any of their specific
    // credential env vars are set before falling back to the generic error.
    const envVars = validationTarget?.descriptor.setup?.credentialEnvVars ?? []
    if (envVars.some(v => env[v])) {
      return null
    }

    return getOpenAIMissingKeyMessage()
  }

  return null
}

export async function validateProviderEnvOrExit(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const error = await getProviderValidationError(env)
  if (error) {
    console.error(error)
    process.exit(1)
  }
}

export function shouldExitForStartupProviderValidationError(options: {
  args?: string[]
  stdoutIsTTY?: boolean
} = {}): boolean {
  const args = options.args ?? process.argv.slice(2)
  const stdoutIsTTY = options.stdoutIsTTY ?? process.stdout.isTTY

  if (!stdoutIsTTY) {
    return true
  }

  return (
    hasPrintFlag(args) ||
    args.includes('--init-only') ||
    args.some(arg => arg.startsWith('--sdk-url'))
  )
}

export async function validateProviderEnvForStartupOrExit(
  env: NodeJS.ProcessEnv = process.env,
  options?: {
    args?: string[]
    stdoutIsTTY?: boolean
  },
): Promise<void> {
  const error = await getProviderValidationError(env)
  if (!error) {
    return
  }

  if (shouldExitForStartupProviderValidationError(options)) {
    console.error(error)
    process.exit(1)
  }

  console.error(
    `Warning: provider configuration is incomplete.\n${error}\nOpenClaude will continue starting so you can run /provider and repair the saved provider settings.`,
  )
}
