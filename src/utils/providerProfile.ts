import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  DEFAULT_CODEX_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENCODE_BASE_URL,
  isCodexBaseUrl,
  parseOpenAICompatibleApiFormat,
  resolveCodexApiCredentials,
  resolveProviderRequest,
} from '../services/api/providerConfig.js'
import { parseChatgptAccountId } from '../services/api/codexOAuthShared.js'
import { isCanonicalAimlapiInferenceBaseUrl } from '../integrations/aimlapi/config.js'
import { parseCredentialList } from '../services/api/credentialPool.js'
import {
  getGoalDefaultOpenAIModel,
  normalizeRecommendationGoal,
  type RecommendationGoal,
} from './providerRecommendation.js'
import { readGeminiAccessToken } from './geminiCredentials.js'
import { getOllamaChatBaseUrl } from './providerDiscovery.js'
import { getPrimaryModel } from './providerModels.js'
import { getProviderValidationError } from './providerValidation.js'
import { getErrnoCode } from './errors.js'
import {
  getRouteDefaultBaseUrl,
  getRouteDefaultModel,
  isCanonicalApiRouteInferenceBaseUrl,
  isCanonicalApismartInferenceBaseUrl,
  isCanonicalConcentrateInferenceBaseUrl,
  isCanonicalLlmtrInferenceBaseUrl,
  isCanonicalCommandcodeInferenceBaseUrl,
  isLongcatBaseUrl,
  normalizeXiaomiMimoBaseUrl,
  resolveRouteCredentialValue,
  resolveActiveRouteIdFromEnv,
  resolveRouteIdFromBaseUrl,
} from '../integrations/routeMetadata.js'
import {
  maskSecretForDisplay,
  redactSecretValueForDisplay,
  sanitizeApiKey,
  sanitizeProviderConfigValue,
  type SecretValueSource,
} from './providerSecrets.js'

export {
  maskSecretForDisplay,
  redactSecretValueForDisplay,
  sanitizeApiKey,
  sanitizeProviderConfigValue,
} from './providerSecrets.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'

export const PROFILE_FILE_NAME = '.openclaude-profile.json'
export const DEFAULT_GEMINI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai'
export const DEFAULT_GEMINI_MODEL = 'gemini-3-flash-preview'
export const DEFAULT_MISTRAL_BASE_URL = 'https://api.mistral.ai/v1'
export const DEFAULT_MISTRAL_MODEL = 'mistral-vibe-cli-latest'
export const DEFAULT_STARTUP_PROVIDER_ENV_VAR =
  'CLAUDE_CODE_DEFAULT_STARTUP_PROVIDER'

const PROFILE_ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_MODEL',
  'OPENAI_API_FORMAT',
  'OPENAI_AZURE_STYLE',
  'OPENAI_AUTH_HEADER',
  'OPENAI_AUTH_SCHEME',
  'OPENAI_AUTH_HEADER_VALUE',
  'OPENAI_API_KEYS',
  'OPENAI_API_KEY',
  'GITHUB_COPILOT_KEY',
  'GITHUB_ENTERPRISE_URL',
  'CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS',
  'CODEX_API_KEY',
  'CODEX_CREDENTIAL_SOURCE',
  'CHATGPT_ACCOUNT_ID',
  'CODEX_ACCOUNT_ID',
  'GEMINI_API_KEY',
  'GEMINI_AUTH_MODE',
  'GEMINI_ACCESS_TOKEN',
  'GEMINI_MODEL',
  'GEMINI_BASE_URL',
  'GOOGLE_API_KEY',
  'NVIDIA_NIM',
  'NVIDIA_API_KEY',
  'NVIDIA_MODEL',
  'MINIMAX_API_KEY',
  'MINIMAX_BASE_URL',
  'MINIMAX_MODEL',
  'MISTRAL_BASE_URL',
  'MISTRAL_API_KEY',
  'MISTRAL_MODEL',
  'BANKR_BASE_URL',
  'BNKR_API_KEY',
  'BANKR_MODEL',
  'XAI_API_KEY',
  'XAI_CREDENTIAL_SOURCE',
  'AIMLAPI_API_KEY',
  'VENICE_API_KEY',
  'MIMO_API_KEY',
  'ATLAS_CLOUD_API_KEY',
  'APISMART_API_KEY',
  'APISMART_MODEL',
  'API_ROUTE_API_KEY',
  'API_ROUTE_MODEL',
  'NEARAI_API_KEY',
  'FIREWORKS_API_KEY',
  'LONGCAT_API_KEY',
  'LLMTR_API_KEY',
  'CMD_API_KEY',
  'COMMANDCODE_API_KEY',
  'COMMAND_CODE_API_KEY',
  'CONCENTRATE_API_KEY',
  'CONCENTRATE_BASE_URL',
  'CONCENTRATE_MODEL',
  'CLINE_API_KEY',
  'OPENCODE_API_KEY',
  'CLAUDE_CODE_PROVIDER_ROUTE_ID',
  'CLOUDFLARE_API_TOKEN',
  DEFAULT_STARTUP_PROVIDER_ENV_VAR,
] as const

function isCommandcodeCredentialEnvVar(envVar: string): boolean {
  return (
    envVar === 'CMD_API_KEY' ||
    envVar === 'COMMANDCODE_API_KEY' ||
    envVar === 'COMMAND_CODE_API_KEY'
  )
}

export type CompatibilityProfileMode =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'mistral'
  | 'github'
  | 'github-enterprise'
  | 'bedrock'
  | 'vertex'

export type ProviderProfile =
  | 'anthropic'
  | 'openai'
  | 'ollama'
  | 'codex'
  | 'gemini'
  | 'atomic-chat'
  | 'nvidia-nim'
  | 'minimax'
  | 'mistral'
  | 'github'
  | 'github-enterprise'
  | 'bedrock'
  | 'vertex'
  | 'xai'
  | 'opencode'
  | 'clinepass'

export type ProfileEnv = {
  ANTHROPIC_BASE_URL?: string
  ANTHROPIC_MODEL?: string
  ANTHROPIC_API_KEY?: string
  ANTHROPIC_AUTH_TOKEN?: string
  ANTHROPIC_CUSTOM_HEADERS?: string
  ANTHROPIC_BEDROCK_BASE_URL?: string
  ANTHROPIC_VERTEX_BASE_URL?: string
  OPENAI_BASE_URL?: string
  OPENAI_API_BASE?: string
  OPENAI_MODEL?: string
  OPENAI_API_FORMAT?: 'chat_completions' | 'responses' | 'responses_compat'
  OPENAI_AZURE_STYLE?: string
  OPENAI_AUTH_HEADER?: string
  OPENAI_AUTH_SCHEME?: 'bearer' | 'raw'
  OPENAI_AUTH_HEADER_VALUE?: string
  OPENAI_API_KEYS?: string
  OPENAI_API_KEY?: string
  GITHUB_COPILOT_KEY?: string
  GITHUB_ENTERPRISE_URL?: string
  CODEX_API_KEY?: string
  CODEX_CREDENTIAL_SOURCE?: 'oauth' | 'existing'
  CHATGPT_ACCOUNT_ID?: string
  CODEX_ACCOUNT_ID?: string
  GEMINI_API_KEY?: string
  GEMINI_AUTH_MODE?: 'api-key' | 'access-token' | 'adc'
  GEMINI_ACCESS_TOKEN?: string
  GEMINI_MODEL?: string
  GEMINI_BASE_URL?: string
  GOOGLE_API_KEY?: string
  NVIDIA_NIM?: string
  NVIDIA_API_KEY?: string
  MINIMAX_API_KEY?: string
  MINIMAX_BASE_URL?: string
  MINIMAX_MODEL?: string
  MISTRAL_BASE_URL?: string
  MISTRAL_API_KEY?: string
  MISTRAL_MODEL?: string
  BANKR_BASE_URL?: string
  BNKR_API_KEY?: string
  BANKR_MODEL?: string
  XAI_API_KEY?: string
  XAI_CREDENTIAL_SOURCE?: 'oauth'
  AIMLAPI_API_KEY?: string
  VENICE_API_KEY?: string
  MIMO_API_KEY?: string
  ATLAS_CLOUD_API_KEY?: string
  APISMART_API_KEY?: string
  API_ROUTE_API_KEY?: string
  CLINE_API_KEY?: string
  NEARAI_API_KEY?: string
  FIREWORKS_API_KEY?: string
  LONGCAT_API_KEY?: string
  LLMTR_API_KEY?: string
  CMD_API_KEY?: string
  COMMANDCODE_API_KEY?: string
  COMMAND_CODE_API_KEY?: string
  CONCENTRATE_API_KEY?: string
  CONCENTRATE_BASE_URL?: string
  CONCENTRATE_MODEL?: string
  OPENCODE_API_KEY?: string
  CLOUDFLARE_API_TOKEN?: string
  CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS?: string
  CLAUDE_CODE_PROVIDER_ROUTE_ID?: string
}

export type ProfileFile = {
  profile: ProviderProfile
  env: ProfileEnv
  createdAt: string
}

// SecretValueSource is intentionally open (Partial<Record<string, ...>>) so
// that newly declared provider credential env vars are redactable without a
// matching type update. See providerSecrets.ts for the canonical definition.
export type { SecretValueSource } from './providerSecrets.js'

export type ProfileFileLocation = {
  configDir?: string
  cwd?: string
  filePath?: string
}

export function getDefaultProfileFilePath(configDir?: string): string {
  return join(configDir ?? getClaudeConfigHomeDir(), PROFILE_FILE_NAME)
}

function resolveLegacyProfileFilePath(cwd = process.cwd()): string {
  return resolve(cwd, PROFILE_FILE_NAME)
}

function resolveProfileFilePath(options?: ProfileFileLocation): string {
  if (options?.filePath) {
    return options.filePath
  }

  if (options?.cwd && !options?.configDir) {
    return resolveLegacyProfileFilePath(options.cwd)
  }

  return getDefaultProfileFilePath(options?.configDir)
}

function resolveProfileFileReadPaths(options?: ProfileFileLocation): string[] {
  const primary = resolveProfileFilePath(options)
  if (options?.filePath || (options?.cwd && !options?.configDir)) {
    return [primary]
  }

  if (existsSync(primary)) {
    return [primary]
  }

  const legacy = resolveLegacyProfileFilePath(options?.cwd)
  return legacy === primary ? [primary] : [primary, legacy]
}

function resolveProfileFileCleanupPaths(options?: ProfileFileLocation): string[] {
  const primary = resolveProfileFilePath(options)
  if (options?.filePath || (options?.cwd && !options?.configDir)) {
    return [primary]
  }

  const legacy = resolveLegacyProfileFilePath(options?.cwd)
  return legacy === primary ? [primary] : [primary, legacy]
}

function ensureProfileDirectory(filePath: string): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  } catch (error) {
    if (getErrnoCode(error) !== 'EEXIST') {
      throw error
    }
  }
}

function readProfileFile(filePath: string): ProfileFile | null {
  if (!existsSync(filePath)) {
    return null
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<ProfileFile>
    if (!isProviderProfile(parsed.profile) || !parsed.env || typeof parsed.env !== 'object') {
      return null
    }

    return {
      profile: parsed.profile,
      env: parsed.env,
      createdAt:
        typeof parsed.createdAt === 'string'
          ? parsed.createdAt
          : new Date().toISOString(),
    }
  } catch {
    return null
  }
}

function normalizeProfileModel(
  value: string | undefined | null,
): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) {
    return undefined
  }

  const primary = getPrimaryModel(trimmed)
  return primary.length > 0 ? primary : undefined
}

export function isProviderProfile(value: unknown): value is ProviderProfile {
  return (
    value === 'anthropic' ||
    value === 'openai' ||
    value === 'ollama' ||
    value === 'codex' ||
    value === 'gemini' ||
    value === 'atomic-chat' ||
    value === 'nvidia-nim' ||
    value === 'minimax' ||
    value === 'mistral' ||
    value === 'github' ||
    value === 'github-enterprise' ||
    value === 'bedrock' ||
    value === 'vertex' ||
    value === 'xai' ||
    value === 'opencode'
  )
}

export function buildGithubProfileEnv(options: {
  model?: string | null
  baseUrl?: string | null
}): ProfileEnv {
  const env: ProfileEnv = {
    OPENAI_MODEL:
      normalizeProfileModel(
        sanitizeProviderConfigValue(options.model),
      ) || 'github:copilot',
  }

  const baseUrl = sanitizeProviderConfigValue(options.baseUrl)
  if (baseUrl) {
    env.OPENAI_BASE_URL = baseUrl
  }

  return env
}

function deriveGithubEnterpriseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl?.trim()) return undefined
  try {
    const parsed = new URL(baseUrl)
    if (parsed.origin === 'https://api.githubcopilot.com') {
      return undefined
    }
    return parsed.origin
  } catch {
    return undefined
  }
}

export function buildOllamaProfileEnv(
  model: string,
  options: {
    baseUrl?: string | null
    getOllamaChatBaseUrl: (baseUrl?: string) => string
  },
): ProfileEnv {
  return {
    OPENAI_BASE_URL: options.getOllamaChatBaseUrl(options.baseUrl ?? undefined),
    OPENAI_MODEL: model,
    CLAUDE_CODE_PROVIDER_ROUTE_ID: 'ollama',
  }
}

export function buildAtomicChatProfileEnv(
  model: string,
  options: {
    baseUrl?: string | null
    getAtomicChatChatBaseUrl: (baseUrl?: string) => string
  },
): ProfileEnv {
  return {
    OPENAI_BASE_URL: options.getAtomicChatChatBaseUrl(options.baseUrl ?? undefined),
    OPENAI_MODEL: model,
  }
}

export function buildBedrockProfileEnv(options: {
  model?: string | null
  baseUrl?: string | null
}): ProfileEnv {
  const env: ProfileEnv = {
    ANTHROPIC_MODEL:
      normalizeProfileModel(
        sanitizeProviderConfigValue(options.model),
      ) || 'claude-sonnet-4-6',
  }

  const baseUrl = sanitizeProviderConfigValue(options.baseUrl)
  if (baseUrl) {
    env.ANTHROPIC_BEDROCK_BASE_URL = baseUrl
  }

  return env
}

export function buildVertexProfileEnv(options: {
  model?: string | null
  baseUrl?: string | null
}): ProfileEnv {
  const env: ProfileEnv = {
    ANTHROPIC_MODEL:
      normalizeProfileModel(
        sanitizeProviderConfigValue(options.model),
      ) || 'claude-sonnet-4-6',
  }

  const baseUrl = sanitizeProviderConfigValue(options.baseUrl)
  if (baseUrl) {
    env.ANTHROPIC_VERTEX_BASE_URL = baseUrl
  }

  return env
}

export function buildNvidiaNimProfileEnv(options: {
  model?: string | null
  baseUrl?: string | null
  apiKey?: string | null
  processEnv?: NodeJS.ProcessEnv
}): ProfileEnv | null {
  const processEnv = options.processEnv ?? process.env
  const key = sanitizeApiKey(options.apiKey ?? processEnv.NVIDIA_API_KEY)
  if (!key) {
    return null
  }

  const defaultBaseUrl = 'https://integrate.api.nvidia.com/v1'
  const secretSource: SecretValueSource = { OPENAI_API_KEY: key }

  return {
    OPENAI_BASE_URL:
      sanitizeProviderConfigValue(options.baseUrl, secretSource) ||
      sanitizeProviderConfigValue(processEnv.OPENAI_BASE_URL, secretSource) ||
      defaultBaseUrl,
    OPENAI_MODEL:
      normalizeProfileModel(
        sanitizeProviderConfigValue(options.model, secretSource),
      ) ||
      normalizeProfileModel(
        sanitizeProviderConfigValue(processEnv.OPENAI_MODEL, secretSource),
      ) ||
      'nvidia/llama-3.1-nemotron-70b-instruct',
    OPENAI_API_KEY: key,
    NVIDIA_NIM: '1',
  }
}

export function buildMiniMaxProfileEnv(options: {
  model?: string | null
  baseUrl?: string | null
  apiKey?: string | null
  processEnv?: NodeJS.ProcessEnv
}): ProfileEnv | null {
  const processEnv = options.processEnv ?? process.env
  const key = sanitizeApiKey(options.apiKey ?? processEnv.MINIMAX_API_KEY)
  if (!key) {
    return null
  }

  const defaultBaseUrl = getRouteDefaultBaseUrl('minimax')
  const defaultModel = getRouteDefaultModel('minimax')
  if (!defaultBaseUrl || !defaultModel) {
    throw new Error('MiniMax route defaults are missing from integration metadata.')
  }
  const secretSource: SecretValueSource = {
    ANTHROPIC_API_KEY: key,
    MINIMAX_API_KEY: key,
    OPENAI_API_KEY: key,
  }

  return {
    ANTHROPIC_BASE_URL:
      sanitizeProviderConfigValue(options.baseUrl, secretSource) ||
      sanitizeProviderConfigValue(processEnv.ANTHROPIC_BASE_URL, secretSource) ||
      defaultBaseUrl,
    ANTHROPIC_MODEL:
      normalizeProfileModel(
        sanitizeProviderConfigValue(options.model, secretSource),
      ) ||
      normalizeProfileModel(
        sanitizeProviderConfigValue(
          processEnv.ANTHROPIC_MODEL ?? processEnv.OPENAI_MODEL,
          secretSource,
        ),
      ) ||
      defaultModel,
    ANTHROPIC_API_KEY: key,
    MINIMAX_API_KEY: key,
    MINIMAX_BASE_URL: defaultBaseUrl,
    MINIMAX_MODEL: defaultModel,
  }
}

export function buildVeniceProfileEnv(options: {
  model?: string | null
  baseUrl?: string | null
  apiKey?: string | null
  processEnv?: NodeJS.ProcessEnv
}): ProfileEnv | null {
  const processEnv = options.processEnv ?? process.env
  const key = sanitizeApiKey(options.apiKey ?? processEnv.VENICE_API_KEY)
  if (!key) {
    return null
  }

  const defaultBaseUrl = getRouteDefaultBaseUrl('venice')
  const defaultModel = getRouteDefaultModel('venice')
  if (!defaultBaseUrl || !defaultModel) {
    throw new Error('Venice route defaults are missing from integration metadata.')
  }
  const secretSource: SecretValueSource = {
    OPENAI_API_KEY: key,
    VENICE_API_KEY: key,
  }

  return {
    OPENAI_BASE_URL:
      sanitizeProviderConfigValue(options.baseUrl, secretSource) ||
      sanitizeProviderConfigValue(processEnv.OPENAI_BASE_URL, secretSource) ||
      defaultBaseUrl,
    OPENAI_MODEL:
      normalizeProfileModel(
        sanitizeProviderConfigValue(options.model, secretSource),
      ) ||
      normalizeProfileModel(
        sanitizeProviderConfigValue(processEnv.OPENAI_MODEL, secretSource),
      ) ||
      defaultModel,
    OPENAI_API_KEY: key,
    VENICE_API_KEY: key,
  }
}

export function buildXiaomiMimoProfileEnv(options: {
  model?: string | null
  baseUrl?: string | null
  apiKey?: string | null
  processEnv?: NodeJS.ProcessEnv
}): ProfileEnv | null {
  const processEnv = options.processEnv ?? process.env
  const key = sanitizeApiKey(options.apiKey ?? processEnv.MIMO_API_KEY)
  if (!key) {
    return null
  }

  const defaultBaseUrl = getRouteDefaultBaseUrl('xiaomi-mimo')
  const defaultModel = getRouteDefaultModel('xiaomi-mimo')
  if (!defaultBaseUrl || !defaultModel) {
    throw new Error('Xiaomi MiMo route defaults are missing from integration metadata.')
  }
  const secretSource: SecretValueSource = {
    OPENAI_API_KEY: key,
    MIMO_API_KEY: key,
  }

  return {
    OPENAI_BASE_URL:
      normalizeXiaomiMimoBaseUrl(
        sanitizeProviderConfigValue(options.baseUrl, secretSource),
      ) ||
      normalizeXiaomiMimoBaseUrl(
        sanitizeProviderConfigValue(processEnv.OPENAI_BASE_URL, secretSource),
      ) ||
      defaultBaseUrl,
    OPENAI_MODEL:
      normalizeProfileModel(
        sanitizeProviderConfigValue(options.model, secretSource),
      ) ||
      normalizeProfileModel(
        sanitizeProviderConfigValue(processEnv.OPENAI_MODEL, secretSource),
      ) ||
      defaultModel,
    OPENAI_API_KEY: key,
    MIMO_API_KEY: key,
  }
}

export function buildAtlasCloudProfileEnv(options: {
  model?: string | null
  baseUrl?: string | null
  apiKey?: string | null
  processEnv?: NodeJS.ProcessEnv
}): ProfileEnv | null {
  const processEnv = options.processEnv ?? process.env
  const key = sanitizeApiKey(options.apiKey ?? processEnv.ATLAS_CLOUD_API_KEY)
  if (!key) {
    return null
  }

  const defaultBaseUrl = getRouteDefaultBaseUrl('atlas-cloud')
  const defaultModel = getRouteDefaultModel('atlas-cloud')
  if (!defaultBaseUrl || !defaultModel) {
    throw new Error('Atlas Cloud route defaults are missing from integration metadata.')
  }
  const secretSource: SecretValueSource = {
    OPENAI_API_KEY: key,
    ATLAS_CLOUD_API_KEY: key,
  }

  return {
    OPENAI_BASE_URL:
      sanitizeProviderConfigValue(options.baseUrl, secretSource) ||
      sanitizeProviderConfigValue(processEnv.OPENAI_BASE_URL, secretSource) ||
      defaultBaseUrl,
    OPENAI_MODEL:
      normalizeProfileModel(
        sanitizeProviderConfigValue(options.model, secretSource),
      ) ||
      normalizeProfileModel(
        sanitizeProviderConfigValue(processEnv.OPENAI_MODEL, secretSource),
      ) ||
      defaultModel,
    OPENAI_API_KEY: key,
    ATLAS_CLOUD_API_KEY: key,
  }
}

export function buildApismartProfileEnv(options: {
  model?: string | null
  baseUrl?: string | null
  apiKey?: string | null
  processEnv?: NodeJS.ProcessEnv
}): ProfileEnv | null {
  const processEnv = options.processEnv ?? process.env
  const key = sanitizeApiKey(options.apiKey ?? processEnv.APISMART_API_KEY)
  if (!key) {
    return null
  }

  const defaultBaseUrl = getRouteDefaultBaseUrl('apismart')
  const defaultModel = getRouteDefaultModel('apismart')
  if (!defaultBaseUrl || !defaultModel) {
    throw new Error('ApiSmart route defaults are missing from integration metadata.')
  }
  const secretSource: SecretValueSource = {
    OPENAI_API_KEY: key,
    APISMART_API_KEY: key,
  }
  const configuredBaseUrl =
    sanitizeProviderConfigValue(options.baseUrl, secretSource) ||
    sanitizeProviderConfigValue(processEnv.OPENAI_BASE_URL, secretSource)
  // Only the documented `/v1` inference URL may carry the dedicated key.
  // Host-only or path-suffixed ApiSmart URLs fall through to the generic
  // OpenAI path (same canonical gate AIMLAPI uses for ambient forwarding).
  if (
    configuredBaseUrl &&
    !isCanonicalApismartInferenceBaseUrl(configuredBaseUrl)
  ) {
    return null
  }

  return {
    OPENAI_BASE_URL: configuredBaseUrl || defaultBaseUrl,
    OPENAI_MODEL:
      normalizeProfileModel(
        sanitizeProviderConfigValue(options.model, secretSource),
      ) ||
      normalizeProfileModel(
        sanitizeProviderConfigValue(processEnv.APISMART_MODEL, secretSource),
      ) ||
      normalizeProfileModel(
        sanitizeProviderConfigValue(processEnv.OPENAI_MODEL, secretSource),
      ) ||
      defaultModel,
    OPENAI_API_KEY: key,
    APISMART_API_KEY: key,
    CLAUDE_CODE_PROVIDER_ROUTE_ID: 'apismart',
  }
}

export function buildConcentrateProfileEnv(options: {
  model?: string | null
  baseUrl?: string | null
  apiKey?: string | null
  processEnv?: NodeJS.ProcessEnv
}): ProfileEnv | null {
  const processEnv = options.processEnv ?? process.env
  const key = sanitizeApiKey(options.apiKey ?? processEnv.CONCENTRATE_API_KEY)
  if (!key) {
    return null
  }

  const defaultBaseUrl = getRouteDefaultBaseUrl('concentrate')
  const defaultModel = getRouteDefaultModel('concentrate')
  if (!defaultBaseUrl || !defaultModel) {
    throw new Error('Concentrate route defaults are missing from integration metadata.')
  }
  const secretSource: SecretValueSource = {
    OPENAI_API_KEY: key,
    CONCENTRATE_API_KEY: key,
  }
  const configuredBaseUrl =
    sanitizeProviderConfigValue(options.baseUrl, secretSource) ||
    sanitizeProviderConfigValue(processEnv.CONCENTRATE_BASE_URL, secretSource) ||
    sanitizeProviderConfigValue(processEnv.OPENAI_BASE_URL, secretSource)
  // The dedicated credential belongs only to Concentrate's documented
  // inference endpoint. Returning null lets the caller use its generic
  // profile path without serializing this secret for a proxy or alternate
  // same-host path.
  if (
    configuredBaseUrl &&
    !isCanonicalConcentrateInferenceBaseUrl(configuredBaseUrl)
  ) {
    return null
  }

  return {
    OPENAI_BASE_URL: configuredBaseUrl || defaultBaseUrl,
    OPENAI_MODEL:
      normalizeProfileModel(
        sanitizeProviderConfigValue(options.model, secretSource),
      ) ||
      normalizeProfileModel(
        sanitizeProviderConfigValue(processEnv.CONCENTRATE_MODEL, secretSource),
      ) ||
      normalizeProfileModel(
        sanitizeProviderConfigValue(processEnv.OPENAI_MODEL, secretSource),
      ) ||
      defaultModel,
    OPENAI_API_KEY: key,
    CONCENTRATE_API_KEY: key,
    CLAUDE_CODE_PROVIDER_ROUTE_ID: 'concentrate',
  }
}

export function buildGeminiProfileEnv(options: {
  model?: string | null
  baseUrl?: string | null
  apiKey?: string | null
  authMode?: 'api-key' | 'access-token' | 'adc'
  processEnv?: NodeJS.ProcessEnv
}): ProfileEnv | null {
  const processEnv = options.processEnv ?? process.env
  const authMode = options.authMode ?? 'api-key'
  const key = sanitizeApiKey(
    options.apiKey ??
      processEnv.GEMINI_API_KEY ??
      processEnv.GOOGLE_API_KEY,
  )
  if (authMode === 'api-key' && !key) {
    return null
  }

  const secretSource: SecretValueSource = key ? { GEMINI_API_KEY: key } : {}

  const env: ProfileEnv = {
    GEMINI_AUTH_MODE: authMode,
    GEMINI_MODEL:
      normalizeProfileModel(
        sanitizeProviderConfigValue(options.model, secretSource),
      ) ||
      normalizeProfileModel(
        sanitizeProviderConfigValue(processEnv.GEMINI_MODEL, secretSource),
      ) ||
      DEFAULT_GEMINI_MODEL,
  }

  if (authMode === 'api-key' && key) {
    env.GEMINI_API_KEY = key
  }

  const baseUrl =
    sanitizeProviderConfigValue(options.baseUrl, secretSource) ||
    sanitizeProviderConfigValue(processEnv.GEMINI_BASE_URL, secretSource)
  if (baseUrl) {
    env.GEMINI_BASE_URL = baseUrl
  }

  return env
}

export function sanitizeOpenAICredentialPool(
  value: string | null | undefined,
): string | undefined {
  const resolved = resolveOpenAICredentialPool(value)
  return resolved.kind === 'usable' ? resolved.value : undefined
}

export function hasInvalidOpenAICredentialPool(
  value: string | null | undefined,
): boolean {
  return resolveOpenAICredentialPool(value).kind === 'invalid'
}

export function resolveOpenAICredentialEnvState(env: Record<string, string | undefined>): {
  configured: boolean
  invalid: boolean
  envVar?: 'OPENAI_API_KEYS' | 'OPENAI_API_KEY'
} {
  const plural = resolveOpenAICredentialPool(env.OPENAI_API_KEYS)
  if (plural.kind === 'usable') {
    return { configured: true, invalid: false, envVar: 'OPENAI_API_KEYS' }
  }
  if (plural.kind === 'invalid') {
    return { configured: false, invalid: true, envVar: 'OPENAI_API_KEYS' }
  }

  const singular = resolveOpenAICredentialPool(env.OPENAI_API_KEY)
  if (singular.kind === 'usable') {
    return { configured: true, invalid: false, envVar: 'OPENAI_API_KEY' }
  }
  if (singular.kind === 'invalid') {
    return { configured: false, invalid: true, envVar: 'OPENAI_API_KEY' }
  }

  return { configured: false, invalid: false }
}

function resolveOpenAICredentialPool(
  value: string | null | undefined,
):
  | { kind: 'empty' }
  | { kind: 'invalid' }
  | { kind: 'usable'; value: string; count: number } {
  const credentials = parseCredentialList(value ?? undefined)
  if (credentials.length === 0) {
    return { kind: 'empty' }
  }
  if (credentials.some(credential => credential === 'SUA_CHAVE')) {
    return { kind: 'invalid' }
  }
  return {
    kind: 'usable',
    value: credentials.join(','),
    count: credentials.length,
  }
}
type OpenAICredentialEnvSelection =
  | {
      kind: 'usable'
      envVar: 'OPENAI_API_KEYS' | 'OPENAI_API_KEY'
      value: string
    }
  | {
      kind: 'invalid'
      envVar: 'OPENAI_API_KEYS' | 'OPENAI_API_KEY'
      value: string
    }

function resolveOpenAICredentialEnvSelection(
  env: SecretValueSource,
): OpenAICredentialEnvSelection | undefined {
  const pooled = resolveOpenAICredentialPool(env.OPENAI_API_KEYS)
  if (pooled.kind === 'invalid') {
    return {
      kind: 'invalid',
      envVar: 'OPENAI_API_KEYS',
      value: env.OPENAI_API_KEYS ?? '',
    }
  }
  if (pooled.kind === 'usable') {
    return { kind: 'usable', envVar: 'OPENAI_API_KEYS', value: pooled.value }
  }

  const single = resolveOpenAICredentialPool(env.OPENAI_API_KEY)
  if (single.kind === 'invalid') {
    return {
      kind: 'invalid',
      envVar: 'OPENAI_API_KEY',
      value: env.OPENAI_API_KEY ?? '',
    }
  }
  if (single.kind === 'usable') {
    return { kind: 'usable', envVar: 'OPENAI_API_KEY', value: single.value }
  }

  return undefined
}

function resolveOpenAICredentialEnvOverride(
  primary: SecretValueSource,
  fallback: SecretValueSource,
): OpenAICredentialEnvSelection | undefined {
  return (
    resolveOpenAICredentialEnvSelection(primary) ||
    resolveOpenAICredentialEnvSelection(fallback)
  )
}

export function buildOpenAIProfileEnv(options: {
  goal: RecommendationGoal
  model?: string | null
  baseUrl?: string | null
  apiKey?: string | null
  apiFormat?: 'chat_completions' | 'responses' | 'responses_compat' | null
  azureStyle?: string | null
  authHeader?: string | null
  authScheme?: 'bearer' | 'raw' | null
  authHeaderValue?: string | null
  maxContextLength?: number | null
  processEnv?: NodeJS.ProcessEnv
}): ProfileEnv | null {
  const processEnv = options.processEnv ?? process.env
  const explicitCredential = resolveOpenAICredentialPool(options.apiKey)
  if (explicitCredential.kind === 'invalid') {
    return null
  }

  const envOpenAIKeysCredential = resolveOpenAICredentialPool(
    processEnv.OPENAI_API_KEYS,
  )
  const envOpenAIKeyCredential = resolveOpenAICredentialPool(
    processEnv.OPENAI_API_KEY,
  )
  if (
    explicitCredential.kind !== 'usable' &&
    (envOpenAIKeysCredential.kind === 'invalid' ||
      envOpenAIKeyCredential.kind === 'invalid')
  ) {
    return null
  }

  const envCredential = resolveOpenAICredentialEnvSelection(processEnv)
  const key =
    explicitCredential.kind === 'usable'
      ? explicitCredential.value
      : envCredential?.value
  const keyEnvVar =
    explicitCredential.kind === 'usable' && explicitCredential.count > 1
      ? 'OPENAI_API_KEYS'
      : explicitCredential.kind === 'usable'
        ? 'OPENAI_API_KEY'
        : envCredential?.envVar ?? 'OPENAI_API_KEY'
  const authHeaderValue = sanitizeApiKey(
    options.authHeaderValue ?? processEnv.OPENAI_AUTH_HEADER_VALUE,
  )
  if (!key && !authHeaderValue) {
    return null
  }

  const defaultModel = getGoalDefaultOpenAIModel(options.goal)
  const secretSource: SecretValueSource = {
    OPENAI_API_KEYS: key,
    OPENAI_API_KEY: key,
    OPENAI_AUTH_HEADER_VALUE: authHeaderValue,
  }
  const shellOpenAIModel = normalizeProfileModel(
    sanitizeProviderConfigValue(
      processEnv.OPENAI_MODEL,
      secretSource,
    ),
  )
  const shellOpenAIBaseUrl = sanitizeProviderConfigValue(
    processEnv.OPENAI_BASE_URL,
    secretSource,
  )
  const shellOpenAIRequest = resolveProviderRequest({
    model: shellOpenAIModel,
    baseUrl: shellOpenAIBaseUrl,
    fallbackModel: defaultModel,
    apiFormat: processEnv.OPENAI_API_FORMAT,
  })
  const useShellOpenAIConfig = shellOpenAIRequest.transport !== 'codex_responses'
  const normalizedModel =
    normalizeProfileModel(
      sanitizeProviderConfigValue(options.model, secretSource),
    ) ||
    (useShellOpenAIConfig ? shellOpenAIModel : undefined) ||
    defaultModel
  const resolvedBaseUrl =
    sanitizeProviderConfigValue(options.baseUrl, secretSource) ||
    (useShellOpenAIConfig ? shellOpenAIBaseUrl : undefined) ||
    DEFAULT_OPENAI_BASE_URL

  return {
    ...(resolveRouteIdFromBaseUrl(resolvedBaseUrl) === 'aimlapi' && key
      ? { AIMLAPI_API_KEY: key }
      : {}),
    OPENAI_BASE_URL: resolvedBaseUrl,
    OPENAI_MODEL: normalizedModel,
    ...(options.apiFormat ? { OPENAI_API_FORMAT: options.apiFormat } : {}),
    ...(isEnvTruthy(options.azureStyle ?? processEnv.OPENAI_AZURE_STYLE)
      ? { OPENAI_AZURE_STYLE: '1' }
      : {}),
    ...(options.authHeader ? { OPENAI_AUTH_HEADER: options.authHeader } : {}),
    ...(options.authScheme ? { OPENAI_AUTH_SCHEME: options.authScheme } : {}),
    ...(authHeaderValue ? { OPENAI_AUTH_HEADER_VALUE: authHeaderValue } : {}),
    ...(key ? { [keyEnvVar]: key } : {}),
    ...(options.maxContextLength
      ? {
          CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS: JSON.stringify({
            [normalizedModel]: options.maxContextLength,
          }),
        }
      : {}),
  }
}

export function buildCodexProfileEnv(options: {
  model?: string | null
  baseUrl?: string | null
  apiKey?: string | null
  credentialSource?: 'oauth' | 'existing'
  processEnv?: NodeJS.ProcessEnv
}): ProfileEnv | null {
  const processEnv = options.processEnv ?? process.env
  const key = sanitizeApiKey(options.apiKey ?? processEnv.CODEX_API_KEY)
  const credentialEnv = key
    ? ({ ...processEnv, CODEX_API_KEY: key } as NodeJS.ProcessEnv)
    : processEnv
  const credentials = resolveCodexApiCredentials(credentialEnv)
  if (!credentials.apiKey || !credentials.accountId) {
    return null
  }
  const credentialSource =
    options.credentialSource ??
    (credentials.source === 'secure-storage' ? 'oauth' : 'existing')

  const env: ProfileEnv = {
    OPENAI_BASE_URL: options.baseUrl || DEFAULT_CODEX_BASE_URL,
    OPENAI_MODEL: options.model || 'codexplan',
    CODEX_CREDENTIAL_SOURCE: credentialSource,
  }

  if (key) {
    env.CODEX_API_KEY = key
  }

  env.CHATGPT_ACCOUNT_ID = credentials.accountId

  return env
}

export function buildMistralProfileEnv(options: {
  model?: string | null
  baseUrl?: string | null
  apiKey?: string | null
  processEnv?: NodeJS.ProcessEnv
}): ProfileEnv | null {
  const processEnv = options.processEnv ?? process.env
  const key = sanitizeApiKey(options.apiKey ?? processEnv.MISTRAL_API_KEY)
  if (!key) {
    return null
  }

  const env: ProfileEnv = {
    MISTRAL_API_KEY: key,
    MISTRAL_MODEL:
      normalizeProfileModel(
        sanitizeProviderConfigValue(options.model, { MISTRAL_API_KEY: key }),
      ) ||
      normalizeProfileModel(
        sanitizeProviderConfigValue(
          processEnv.MISTRAL_MODEL,
          { MISTRAL_API_KEY: key },
        ),
      ) ||
      DEFAULT_MISTRAL_MODEL,
  }

  const baseUrl =
    sanitizeProviderConfigValue(options.baseUrl, { MISTRAL_API_KEY: key }) ||
    sanitizeProviderConfigValue(
      processEnv.MISTRAL_BASE_URL,
      { MISTRAL_API_KEY: key },
    )
  if (baseUrl) {
    env.MISTRAL_BASE_URL = baseUrl
  }

  return env
}

export function buildBankrProfileEnv(options: {
  model?: string | null
  baseUrl?: string | null
  apiKey?: string | null
  processEnv?: NodeJS.ProcessEnv
}): ProfileEnv | null {
  const processEnv = options.processEnv ?? process.env
  const key = sanitizeApiKey(options.apiKey ?? processEnv.BNKR_API_KEY)
  if (!key) {
    return null
  }

  const env: ProfileEnv = {
    BNKR_API_KEY: key,
    BANKR_MODEL:
      sanitizeProviderConfigValue(options.model, { BNKR_API_KEY: key }) ||
      sanitizeProviderConfigValue(
        processEnv.BANKR_MODEL,
        { BNKR_API_KEY: key },
      ) ||
      'claude-opus-4.6',
  }

  const baseUrl =
    sanitizeProviderConfigValue(options.baseUrl, { BNKR_API_KEY: key }) ||
    sanitizeProviderConfigValue(
      processEnv.BANKR_BASE_URL,
      { BNKR_API_KEY: key },
    )
  if (baseUrl) {
    env.BANKR_BASE_URL = baseUrl
  }

  return env
}

function buildXaiProfileEnv(options: {
  model?: string | null
  baseUrl?: string | null
  apiKey?: string | null
  processEnv?: NodeJS.ProcessEnv
}): ProfileEnv {
  const processEnv = options.processEnv ?? process.env
  const key = sanitizeApiKey(options.apiKey ?? processEnv.XAI_API_KEY)
  const secretSource: SecretValueSource = {
    OPENAI_API_KEY: key,
    XAI_API_KEY: key,
  }
  const defaultBaseUrl = getRouteDefaultBaseUrl('xai') ?? 'https://api.x.ai/v1'
  const defaultModel = getRouteDefaultModel('xai') ?? 'grok-4.6'
  const env: ProfileEnv = {
    OPENAI_BASE_URL:
      sanitizeProviderConfigValue(options.baseUrl, secretSource) ||
      sanitizeProviderConfigValue(processEnv.OPENAI_BASE_URL, secretSource) ||
      defaultBaseUrl,
    OPENAI_MODEL:
      normalizeProfileModel(
        sanitizeProviderConfigValue(options.model, secretSource),
      ) ||
      normalizeProfileModel(
        sanitizeProviderConfigValue(processEnv.OPENAI_MODEL, secretSource),
      ) ||
      defaultModel,
  }

  if (key) {
    env.OPENAI_API_KEY = key
    env.XAI_API_KEY = key
  }

  return env
}

function getCompatibilityProfileFlag(
  compatibilityMode: CompatibilityProfileMode,
):
  | 'CLAUDE_CODE_USE_OPENAI'
  | 'CLAUDE_CODE_USE_GITHUB'
  | 'CLAUDE_CODE_USE_GEMINI'
  | 'CLAUDE_CODE_USE_MISTRAL'
  | 'CLAUDE_CODE_USE_BEDROCK'
  | 'CLAUDE_CODE_USE_VERTEX'
  | undefined {
  switch (compatibilityMode) {
    case 'openai':
      return 'CLAUDE_CODE_USE_OPENAI'
    case 'github':
    case 'github-enterprise':
      return 'CLAUDE_CODE_USE_GITHUB'
    case 'gemini':
      return 'CLAUDE_CODE_USE_GEMINI'
    case 'mistral':
      return 'CLAUDE_CODE_USE_MISTRAL'
    case 'bedrock':
      return 'CLAUDE_CODE_USE_BEDROCK'
    case 'vertex':
      return 'CLAUDE_CODE_USE_VERTEX'
    default:
      return undefined
  }
}

export function clearManagedProfileEnv(
  targetEnv: NodeJS.ProcessEnv,
): void {
  for (const key of PROFILE_ENV_KEYS) {
    delete targetEnv[key]
  }
}

export function buildCompatibilityProcessEnv(options: {
  compatibilityMode: CompatibilityProfileMode
  profileEnv: ProfileEnv
  processEnv?: NodeJS.ProcessEnv
}): NodeJS.ProcessEnv {
  const env = { ...(options.processEnv ?? process.env) }
  const nextEnv: NodeJS.ProcessEnv = { ...options.profileEnv }
  const flag = getCompatibilityProfileFlag(options.compatibilityMode)

  if (flag) {
    nextEnv[flag] = '1'
  }

  applyProfileEnvToProcessEnv(env, nextEnv)
  return env
}

export function isDefaultStartupProviderEnv(env: NodeJS.ProcessEnv): boolean {
  return env[DEFAULT_STARTUP_PROVIDER_ENV_VAR] === 'gitlawb-opengateway'
}

export function buildCodexOAuthProfileEnv(
  tokens: {
    accessToken: string
    idToken?: string
    accountId?: string
  },
): ProfileEnv | null {
  const accountId =
    tokens.accountId ??
    parseChatgptAccountId(tokens.idToken) ??
    parseChatgptAccountId(tokens.accessToken)

  if (!accountId) {
    return null
  }

  return {
    OPENAI_BASE_URL: DEFAULT_CODEX_BASE_URL,
    OPENAI_MODEL: 'codexplan',
    CHATGPT_ACCOUNT_ID: accountId,
    CODEX_CREDENTIAL_SOURCE: 'oauth',
  }
}

export function createProfileFile(
  profile: ProviderProfile,
  env: ProfileEnv,
): ProfileFile {
  return {
    profile,
    env,
    createdAt: new Date().toISOString(),
  }
}

export function isPersistedCodexOAuthProfile(
  persisted: ProfileFile | null,
): boolean {
  return (
    persisted?.profile === 'codex' &&
    persisted.env.CODEX_CREDENTIAL_SOURCE === 'oauth'
  )
}

export function clearPersistedCodexOAuthProfile(
  options?: ProfileFileLocation,
): string | null {
  let removedPath: string | null = null

  for (const filePath of resolveProfileFileCleanupPaths(options)) {
    const persisted = readProfileFile(filePath)
    if (isPersistedCodexOAuthProfile(persisted)) {
      rmSync(filePath, { force: true })
      removedPath ??= filePath
    }
  }

  return removedPath
}

const XAI_OAUTH_DEFAULT_BASE_URL = 'https://api.x.ai/v1'

export function buildXaiOAuthProfileEnv(options: {
  model?: string
}): ProfileEnv {
  return {
    OPENAI_BASE_URL: XAI_OAUTH_DEFAULT_BASE_URL,
    OPENAI_MODEL: options.model ?? 'grok-4.6',
    XAI_CREDENTIAL_SOURCE: 'oauth',
  }
}

export function isPersistedXaiOAuthProfile(
  persisted: ProfileFile | null,
): boolean {
  return (
    persisted?.profile === 'xai' &&
    persisted.env.XAI_CREDENTIAL_SOURCE === 'oauth'
  )
}

export function clearPersistedXaiOAuthProfile(
  options?: ProfileFileLocation,
): string | null {
  let removedPath: string | null = null

  for (const filePath of resolveProfileFileCleanupPaths(options)) {
    const persisted = readProfileFile(filePath)
    if (isPersistedXaiOAuthProfile(persisted)) {
      rmSync(filePath, { force: true })
      removedPath ??= filePath
    }
  }

  return removedPath
}

export function loadProfileFile(options?: ProfileFileLocation): ProfileFile | null {
  for (const filePath of resolveProfileFileReadPaths(options)) {
    const profile = readProfileFile(filePath)
    if (profile) {
      return profile
    }
  }

  return null
}

export function saveProfileFile(
  profileFile: ProfileFile,
  options?: ProfileFileLocation,
): string {
  const filePath = resolveProfileFilePath(options)
  ensureProfileDirectory(filePath)
  writeFileSync(filePath, JSON.stringify(profileFile, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  })
  chmodSync(filePath, 0o600)
  return filePath
}

export function deleteProfileFile(options?: ProfileFileLocation): string {
  const filePath = resolveProfileFilePath(options)
  const cleanupPaths = new Set(resolveProfileFileCleanupPaths(options))

  for (const cleanupPath of cleanupPaths) {
    rmSync(cleanupPath, { force: true })
  }

  return filePath
}

export function hasExplicitProviderSelection(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  // If env was already applied from a provider profile, preserve it.
  if (processEnv.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED === '1') {
    return true
  }

  return (
    isEnvTruthy(processEnv.CLAUDE_CODE_USE_OPENAI) ||
    isEnvTruthy(processEnv.CLAUDE_CODE_USE_GITHUB) ||
    isEnvTruthy(processEnv.CLAUDE_CODE_USE_GEMINI) ||
    isEnvTruthy(processEnv.CLAUDE_CODE_USE_MISTRAL) ||
    isEnvTruthy(processEnv.CLAUDE_CODE_USE_BEDROCK) ||
    isEnvTruthy(processEnv.CLAUDE_CODE_USE_VERTEX) ||
    isEnvTruthy(processEnv.CLAUDE_CODE_USE_FOUNDRY)
  )
}

function hasExplicitNonOpenAIProviderSelection(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    isEnvTruthy(processEnv.CLAUDE_CODE_USE_GITHUB) ||
    isEnvTruthy(processEnv.CLAUDE_CODE_USE_GEMINI) ||
    isEnvTruthy(processEnv.CLAUDE_CODE_USE_MISTRAL) ||
    isEnvTruthy(processEnv.CLAUDE_CODE_USE_BEDROCK) ||
    isEnvTruthy(processEnv.CLAUDE_CODE_USE_VERTEX) ||
    isEnvTruthy(processEnv.CLAUDE_CODE_USE_FOUNDRY)
  )
}

function hasExplicitOpenAICompatibleOptOut(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    processEnv.CLAUDE_CODE_USE_OPENAI !== undefined &&
    !isEnvTruthy(processEnv.CLAUDE_CODE_USE_OPENAI)
  )
}

function hasConcreteProviderSelection(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  if (processEnv.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED === '1') {
    return true
  }

  if (isEnvTruthy(processEnv.CLAUDE_CODE_USE_OPENAI)) {
    return (
      sanitizeProviderConfigValue(processEnv.OPENAI_BASE_URL) !== undefined ||
      sanitizeProviderConfigValue(processEnv.OPENAI_API_BASE) !== undefined ||
      normalizeProfileModel(
        sanitizeProviderConfigValue(processEnv.OPENAI_MODEL),
      ) !== undefined
    )
  }

  if (isEnvTruthy(processEnv.CLAUDE_CODE_USE_GEMINI)) {
    return (
      sanitizeProviderConfigValue(processEnv.GEMINI_BASE_URL) !== undefined ||
      normalizeProfileModel(
        sanitizeProviderConfigValue(processEnv.GEMINI_MODEL),
      ) !== undefined ||
      sanitizeApiKey(processEnv.GEMINI_API_KEY) !== undefined ||
      sanitizeApiKey(processEnv.GOOGLE_API_KEY) !== undefined
    )
  }

  if (isEnvTruthy(processEnv.CLAUDE_CODE_USE_MISTRAL)) {
    return (
      sanitizeProviderConfigValue(processEnv.MISTRAL_BASE_URL) !== undefined ||
      normalizeProfileModel(
        sanitizeProviderConfigValue(processEnv.MISTRAL_MODEL),
      ) !== undefined ||
      sanitizeApiKey(processEnv.MISTRAL_API_KEY) !== undefined
    )
  }

  if (isEnvTruthy(processEnv.CLAUDE_CODE_USE_GITHUB)) {
    return (
      sanitizeApiKey(processEnv.GITHUB_TOKEN) !== undefined ||
      sanitizeApiKey(processEnv.GH_TOKEN) !== undefined ||
      normalizeProfileModel(
        sanitizeProviderConfigValue(processEnv.OPENAI_MODEL),
      ) !== undefined
    )
  }

  if (
    isEnvTruthy(processEnv.CLAUDE_CODE_USE_BEDROCK) ||
    isEnvTruthy(processEnv.CLAUDE_CODE_USE_VERTEX) ||
    isEnvTruthy(processEnv.CLAUDE_CODE_USE_FOUNDRY)
  ) {
    return true
  }

  // Anthropic-native proxies are selected by their own endpoint, model, and
  // Bearer token rather than a CLAUDE_CODE_USE_* flag. Treat that complete
  // contract as explicit so fresh-install fallback cannot replace it with the
  // default OpenAI-compatible provider.
  if (
    sanitizeProviderConfigValue(processEnv.ANTHROPIC_BASE_URL) !== undefined &&
    normalizeProfileModel(
      sanitizeProviderConfigValue(processEnv.ANTHROPIC_MODEL),
    ) !== undefined &&
    (sanitizeApiKey(processEnv.ANTHROPIC_AUTH_TOKEN) !== undefined ||
      sanitizeApiKey(processEnv.ANTHROPIC_API_KEY) !== undefined)
  ) {
    return true
  }

  // Env-only provider setups — no CLAUDE_CODE_USE_* flag needed. These must
  // survive startup-profile selection so client routing can apply their
  // descriptor defaults; otherwise a saved/default profile clears the key
  // before the env-only resolver has a chance to see it.
  return (
    sanitizeApiKey(processEnv.APISMART_API_KEY) !== undefined ||
    sanitizeApiKey(processEnv.API_ROUTE_API_KEY) !== undefined ||
    sanitizeApiKey(processEnv.FIREWORKS_API_KEY) !== undefined ||
    sanitizeApiKey(processEnv.NEARAI_API_KEY) !== undefined ||
    sanitizeApiKey(processEnv.LONGCAT_API_KEY) !== undefined ||
    sanitizeApiKey(processEnv.CONCENTRATE_API_KEY) !== undefined
  )
}

function getConcreteOpenAICompatibleEnvRouteId(
  processEnv: NodeJS.ProcessEnv = process.env,
): string | null {
  const openAIBaseUrl =
    sanitizeProviderConfigValue(processEnv.OPENAI_BASE_URL) ??
    sanitizeProviderConfigValue(processEnv.OPENAI_API_BASE)
  const openAIModel = normalizeProfileModel(
    sanitizeProviderConfigValue(processEnv.OPENAI_MODEL),
  )
  const openAICredential = resolveOpenAICredentialEnvSelection(processEnv)
  const openAIRouteId = resolveRouteIdFromBaseUrl(openAIBaseUrl)
  const routeCredential = sanitizeApiKey(
    resolveRouteCredentialValue({
      routeId: openAIRouteId ?? 'custom',
      baseUrl: openAIBaseUrl,
      processEnv,
    }),
  )
  const authHeaderValue = sanitizeApiKey(processEnv.OPENAI_AUTH_HEADER_VALUE)
  if (
    openAIBaseUrl !== undefined &&
    openAIModel !== undefined &&
    (openAICredential?.kind === 'usable' ||
      routeCredential !== undefined ||
      authHeaderValue !== undefined)
  ) {
    return openAIRouteId ?? 'custom'
  }

  return null
}

export function selectAutoProfile(
  recommendedOllamaModel: string | null,
): ProviderProfile {
  return recommendedOllamaModel ? 'ollama' : 'openai'
}

/**
 * Endpoint equivalence for deciding whether a launch may inherit a saved
 * profile's route identity — and with it that profile's dedicated credential.
 *
 * Scheme and host case, plus a single trailing slash, are pure spelling of the
 * same endpoint. Path case and query parameters are NOT: `/tenantA` and
 * `/tenanta`, or `?tenant=a` and `?tenant=b`, are distinct targets on the same
 * host, and letting one inherit the other's identity would hand it a credential
 * configured for somewhere else. Deliberately stricter than
 * `normalizeComparableBaseUrl`, which lowercases paths and drops queries for
 * route *lookup*, where a false match is harmless.
 */
function isSameConfiguredEndpoint(
  left: string | undefined,
  right: string | undefined,
): boolean {
  const normalize = (value: string | undefined): string | null => {
    if (!value?.trim()) return null
    try {
      // `origin` lowercases scheme and host; pathname and search keep their case.
      const url = new URL(value.trim())
      return `${url.origin}${url.pathname.replace(/\/$/, '')}${url.search}`
    } catch {
      return null
    }
  }

  const normalizedLeft = normalize(left)
  return normalizedLeft !== null && normalizedLeft === normalize(right)
}

export async function buildLaunchEnv(options: {
  profile: ProviderProfile
  persisted: ProfileFile | null
  goal: RecommendationGoal
  processEnv?: NodeJS.ProcessEnv
  getOllamaChatBaseUrl?: (baseUrl?: string) => string
  resolveOllamaDefaultModel?: (goal: RecommendationGoal) => Promise<string>
  getAtomicChatChatBaseUrl?: (baseUrl?: string) => string
  resolveAtomicChatDefaultModel?: () => Promise<string | null>
  readGeminiAccessToken?: () => string | undefined
}): Promise<NodeJS.ProcessEnv> {
  const processEnv = options.processEnv ?? process.env
  let selectedProfile = options.profile
  const persistedEnv =
    options.persisted?.profile === selectedProfile
      ? options.persisted.env ?? {}
      : {}
  const persistedOpenAIModel = normalizeProfileModel(
    sanitizeProviderConfigValue(
      persistedEnv.OPENAI_MODEL,
      persistedEnv,
    ),
  )
  const persistedOpenAIBaseUrl = sanitizeProviderConfigValue(
    persistedEnv.OPENAI_BASE_URL,
    persistedEnv,
  )
  const persistedOpenAIApiFormat = persistedEnv.OPENAI_API_FORMAT
  const persistedOpenAIAzureStyle = persistedEnv.OPENAI_AZURE_STYLE
  const persistedOpenAIAuthHeader = persistedEnv.OPENAI_AUTH_HEADER
  const persistedOpenAIAuthScheme = persistedEnv.OPENAI_AUTH_SCHEME
  const persistedOpenAIAuthHeaderValue = sanitizeApiKey(
    persistedEnv.OPENAI_AUTH_HEADER_VALUE,
  )
  const persistedCustomHeaders = persistedEnv.ANTHROPIC_CUSTOM_HEADERS
  const shellCustomHeaders = processEnv.ANTHROPIC_CUSTOM_HEADERS
  const shellOpenAIModel = normalizeProfileModel(
    sanitizeProviderConfigValue(
      processEnv.OPENAI_MODEL,
      processEnv as SecretValueSource,
    ),
  )
  const shellOpenAIBaseUrl =
    sanitizeProviderConfigValue(
      processEnv.OPENAI_BASE_URL,
      processEnv as SecretValueSource,
    ) ??
    sanitizeProviderConfigValue(
      processEnv.OPENAI_API_BASE,
      processEnv as SecretValueSource,
    )
  const persistedGeminiModel = normalizeProfileModel(
    sanitizeProviderConfigValue(
      persistedEnv.GEMINI_MODEL,
      persistedEnv,
    ),
  )
  const persistedGeminiBaseUrl = sanitizeProviderConfigValue(
    persistedEnv.GEMINI_BASE_URL,
    persistedEnv,
  )
  const shellGeminiModel = normalizeProfileModel(
    sanitizeProviderConfigValue(
      processEnv.GEMINI_MODEL,
      processEnv as SecretValueSource,
    ),
  )
  const shellGeminiBaseUrl = sanitizeProviderConfigValue(
    processEnv.GEMINI_BASE_URL,
    processEnv as SecretValueSource,
  )
  const shellGeminiAccessToken =
    processEnv.GEMINI_ACCESS_TOKEN?.trim() || undefined
  const storedGeminiAccessToken =
    options.readGeminiAccessToken?.() ?? readGeminiAccessToken()

  const shellGeminiKey = sanitizeApiKey(
    processEnv.GEMINI_API_KEY ?? processEnv.GOOGLE_API_KEY,
  )
  const persistedGeminiKey = sanitizeApiKey(persistedEnv.GEMINI_API_KEY)
  const persistedGeminiAuthMode = persistedEnv.GEMINI_AUTH_MODE

  if (hasExplicitProviderSelection(processEnv)) {
    const explicitProfileOverrides: Array<[string, ProviderProfile]> = [
      ['CLAUDE_CODE_USE_GITHUB', 'github'],
      ['CLAUDE_CODE_USE_BEDROCK', 'bedrock'],
      ['CLAUDE_CODE_USE_VERTEX', 'vertex'],
      ['CLAUDE_CODE_USE_MISTRAL', 'mistral'],
      ['CLAUDE_CODE_USE_GEMINI', 'gemini'],
      ['CLAUDE_CODE_USE_OPENAI', 'openai'],
    ]

    for (const [envKey, provider] of explicitProfileOverrides) {
      if (isEnvTruthy(processEnv[envKey])) {
        const isCodexOAuthProfile =
          selectedProfile === 'codex' &&
          provider === 'openai' &&
          persistedEnv.CODEX_CREDENTIAL_SOURCE === 'oauth'
        if (!isCodexOAuthProfile) {
          selectedProfile = provider
        }
        break
      }
    }
  }

  if (selectedProfile === 'github' || selectedProfile === 'github-enterprise') {
    const baseUrl = shellOpenAIBaseUrl || persistedOpenAIBaseUrl
    const profileEnv = buildGithubProfileEnv({
      model: shellOpenAIModel || persistedOpenAIModel || 'github:copilot',
      baseUrl,
    })
    if (selectedProfile === 'github-enterprise') {
      const enterpriseUrl = deriveGithubEnterpriseUrl(baseUrl)
      if (enterpriseUrl) {
        profileEnv.GITHUB_ENTERPRISE_URL = enterpriseUrl
      }
      const copilotKey =
        sanitizeApiKey(processEnv.GITHUB_COPILOT_KEY) ||
        sanitizeApiKey(persistedEnv.GITHUB_COPILOT_KEY)
      if (copilotKey) {
        profileEnv.GITHUB_COPILOT_KEY = copilotKey
      }
    }
    return buildCompatibilityProcessEnv({
      processEnv,
      compatibilityMode: 'github',
      profileEnv,
    })
  }

  if (selectedProfile === 'anthropic') {
    const anthropicBaseUrl =
      sanitizeProviderConfigValue(processEnv.ANTHROPIC_BASE_URL) ||
      sanitizeProviderConfigValue(persistedEnv.ANTHROPIC_BASE_URL)
    const anthropicAuthToken =
      sanitizeApiKey(processEnv.ANTHROPIC_AUTH_TOKEN) ||
      sanitizeApiKey(persistedEnv.ANTHROPIC_AUTH_TOKEN)
    const anthropicApiKey = anthropicAuthToken
      ? undefined
      : sanitizeApiKey(processEnv.ANTHROPIC_API_KEY) ||
        sanitizeApiKey(persistedEnv.ANTHROPIC_API_KEY)

    return buildCompatibilityProcessEnv({
      processEnv,
      compatibilityMode: 'anthropic',
      profileEnv: {
        ...(anthropicBaseUrl
          ? { ANTHROPIC_BASE_URL: anthropicBaseUrl }
          : {}),
        ANTHROPIC_MODEL:
          normalizeProfileModel(
            sanitizeProviderConfigValue(processEnv.ANTHROPIC_MODEL),
          ) ||
          normalizeProfileModel(
            sanitizeProviderConfigValue(persistedEnv.ANTHROPIC_MODEL),
          ) ||
          'claude-sonnet-4-6',
        ...(anthropicApiKey
          ? { ANTHROPIC_API_KEY: anthropicApiKey }
          : {}),
        ...(anthropicAuthToken
          ? { ANTHROPIC_AUTH_TOKEN: anthropicAuthToken }
          : {}),
        ...(shellCustomHeaders || persistedCustomHeaders
          ? {
              ANTHROPIC_CUSTOM_HEADERS:
                shellCustomHeaders || persistedCustomHeaders,
            }
          : {}),
      },
    })
  }

  if (selectedProfile === 'bedrock') {
    const bedrockBaseUrl =
      sanitizeProviderConfigValue(processEnv.ANTHROPIC_BEDROCK_BASE_URL) ||
      sanitizeProviderConfigValue(persistedEnv.ANTHROPIC_BEDROCK_BASE_URL)

    return buildCompatibilityProcessEnv({
      processEnv,
      compatibilityMode: 'bedrock',
      profileEnv: buildBedrockProfileEnv({
        model:
          normalizeProfileModel(
            sanitizeProviderConfigValue(processEnv.ANTHROPIC_MODEL),
          ) ||
          normalizeProfileModel(
            sanitizeProviderConfigValue(persistedEnv.ANTHROPIC_MODEL),
          ) ||
          'claude-sonnet-4-6',
        baseUrl: bedrockBaseUrl,
      }),
    })
  }

  if (selectedProfile === 'vertex') {
    const vertexBaseUrl =
      sanitizeProviderConfigValue(processEnv.ANTHROPIC_VERTEX_BASE_URL) ||
      sanitizeProviderConfigValue(persistedEnv.ANTHROPIC_VERTEX_BASE_URL)

    return buildCompatibilityProcessEnv({
      processEnv,
      compatibilityMode: 'vertex',
      profileEnv: buildVertexProfileEnv({
        model:
          normalizeProfileModel(
            sanitizeProviderConfigValue(processEnv.ANTHROPIC_MODEL),
          ) ||
          normalizeProfileModel(
            sanitizeProviderConfigValue(persistedEnv.ANTHROPIC_MODEL),
          ) ||
          'claude-sonnet-4-6',
        baseUrl: vertexBaseUrl,
      }),
    })
  }

  if (selectedProfile === 'gemini') {
    const env: ProfileEnv = {
      GEMINI_MODEL:
        shellGeminiModel ||
        persistedGeminiModel ||
        DEFAULT_GEMINI_MODEL,
      GEMINI_BASE_URL:
        shellGeminiBaseUrl ||
        persistedGeminiBaseUrl ||
        DEFAULT_GEMINI_BASE_URL,
    }

    const geminiAuthMode =
      persistedGeminiAuthMode === 'access-token' ||
      persistedGeminiAuthMode === 'adc'
        ? persistedGeminiAuthMode
        : 'api-key'
    const geminiKey = shellGeminiKey || persistedGeminiKey
    if (geminiAuthMode === 'api-key' && geminiKey) {
      env.GEMINI_API_KEY = geminiKey
    }
    env.GEMINI_AUTH_MODE = geminiAuthMode
    if (geminiAuthMode === 'access-token') {
      const geminiAccessToken =
        shellGeminiAccessToken || storedGeminiAccessToken
      if (geminiAccessToken) {
        env.GEMINI_ACCESS_TOKEN = geminiAccessToken
      }
    }

    return buildCompatibilityProcessEnv({
      processEnv,
      compatibilityMode: 'gemini',
      profileEnv: env,
    })
  }

  if (selectedProfile === 'mistral') {
    const shellMistralModel = normalizeProfileModel(
      sanitizeProviderConfigValue(
        processEnv.MISTRAL_MODEL,
      ),
    )
    const persistedMistralModel = normalizeProfileModel(
      sanitizeProviderConfigValue(
        persistedEnv.MISTRAL_MODEL,
      ),
    )
    const shellMistralBaseUrl = sanitizeProviderConfigValue(
      processEnv.MISTRAL_BASE_URL,
    )
    const persistedMistralBaseUrl = sanitizeProviderConfigValue(
      persistedEnv.MISTRAL_BASE_URL,
    )

    const shellMistralKey = sanitizeApiKey(
      processEnv.MISTRAL_API_KEY,
    )
    const persistedMistralKey = sanitizeApiKey(persistedEnv.MISTRAL_API_KEY)
    const mistralKey = shellMistralKey || persistedMistralKey

    const env: ProfileEnv = {
      MISTRAL_MODEL:
        shellMistralModel || persistedMistralModel || DEFAULT_MISTRAL_MODEL,
    }

    if (mistralKey) {
      env.MISTRAL_API_KEY = mistralKey
    }

    if (shellMistralBaseUrl || persistedMistralBaseUrl) {
      env.MISTRAL_BASE_URL = shellMistralBaseUrl || persistedMistralBaseUrl
    }

    return buildCompatibilityProcessEnv({
      processEnv,
      compatibilityMode: 'mistral',
      profileEnv: env,
    })
  }

  if (selectedProfile === 'xai') {
    // For OAuth-tagged profiles, do not fall back to OPENAI_API_KEY /
    // persisted OPENAI_API_KEY. The user's shell OpenAI key is for
    // api.openai.com — sending it as a bearer to api.x.ai/v1 just
    // returns 401 (or worse, leaks the OpenAI key to xAI). When the
    // saved profile is OAuth, only an explicit XAI_API_KEY can
    // override; otherwise leave the env keyless and let openaiShim
    // resolve the stored OAuth access token at request time.
    const isOAuthProfile = persistedEnv.XAI_CREDENTIAL_SOURCE === 'oauth'
    const xaiKey = isOAuthProfile
      ? sanitizeApiKey(processEnv.XAI_API_KEY) ||
        sanitizeApiKey(persistedEnv.XAI_API_KEY)
      : sanitizeApiKey(processEnv.XAI_API_KEY) ||
        sanitizeApiKey(persistedEnv.XAI_API_KEY) ||
        sanitizeApiKey(processEnv.OPENAI_API_KEY) ||
        sanitizeApiKey(persistedEnv.OPENAI_API_KEY)

    const env = buildXaiProfileEnv({
      model: shellOpenAIModel || persistedOpenAIModel,
      baseUrl: shellOpenAIBaseUrl || persistedOpenAIBaseUrl,
      apiKey: xaiKey,
      // Scrub OPENAI_API_KEY before buildXaiProfileEnv reads processEnv
      // so it can't be re-introduced via the internal fallback inside
      // that helper. The shell key still survives in the wider
      // processEnv copy returned by buildCompatibilityProcessEnv, but
      // it won't be promoted into XAI_API_KEY / OPENAI_API_KEY for
      // this profile's env.
      processEnv: isOAuthProfile
        ? {
            ...processEnv,
            OPENAI_API_KEYS: undefined,
            OPENAI_API_KEY: undefined,
            XAI_API_KEY: undefined,
          }
        : processEnv,
    })
    const customHeaders = shellCustomHeaders || persistedCustomHeaders
    if (customHeaders) {
      env.ANTHROPIC_CUSTOM_HEADERS = customHeaders
    }
    // Preserve the OAuth credential-source marker so startup validation
    // accepts an xAI OAuth profile (no XAI_API_KEY needed; openaiShim
    // resolves the stored access token at request time).
    if (!env.XAI_API_KEY && isOAuthProfile) {
      env.XAI_CREDENTIAL_SOURCE = 'oauth'
    }

    // For OAuth profiles, also clear any ambient OpenAI credentials from
    // the returned compatibility env. openaiShim's resolver checks
    // process.env.OPENAI_API_KEYS / OPENAI_API_KEY before falling back
    // to the stored OAuth token; leaving shell credentials there would
    // short-circuit OAuth and send the wrong bearer to api.x.ai/v1.
    const compatibilityProcessEnv =
      isOAuthProfile && !env.XAI_API_KEY
        ? {
            ...processEnv,
            OPENAI_API_KEYS: undefined,
            OPENAI_API_KEY: undefined,
          }
        : processEnv
    const result = buildCompatibilityProcessEnv({
      processEnv: compatibilityProcessEnv,
      compatibilityMode: 'openai',
      profileEnv: env,
    })
    if (isOAuthProfile && !env.XAI_API_KEY) {
      delete result.OPENAI_API_KEYS
      delete result.OPENAI_API_KEY
    }
    return result
  }

  if (selectedProfile === 'opencode') {
    const opencodeKey =
      sanitizeApiKey(processEnv.OPENCODE_API_KEY) ||
      sanitizeApiKey(persistedEnv.OPENCODE_API_KEY)
    const openAICredential = resolveOpenAICredentialEnvOverride(
      processEnv,
      persistedEnv,
    )
    const opencodeBaseUrl =
      sanitizeProviderConfigValue(processEnv.OPENAI_BASE_URL) ||
      sanitizeProviderConfigValue(persistedEnv.OPENAI_BASE_URL) ||
      DEFAULT_OPENCODE_BASE_URL
    const opencodeModel =
      shellOpenAIModel || persistedOpenAIModel || 'gpt-5.4'
    const profileEnv: ProfileEnv = {
      OPENAI_BASE_URL: opencodeBaseUrl,
      OPENAI_MODEL: opencodeModel,
    }
    if (opencodeKey) {
      profileEnv.OPENAI_API_KEY = opencodeKey
    } else if (openAICredential) {
      profileEnv[openAICredential.envVar] = openAICredential.value
    }

    return buildCompatibilityProcessEnv({
      processEnv,
      compatibilityMode: 'openai',
      profileEnv,
    })
  }

  if (selectedProfile === 'ollama') {
    const getOllamaBaseUrl =
      options.getOllamaChatBaseUrl ?? (() => 'http://localhost:11434/v1')
    const resolveOllamaModel =
      options.resolveOllamaDefaultModel ?? (async () => 'llama3.1:8b')

    return buildCompatibilityProcessEnv({
      processEnv,
      compatibilityMode: 'openai',
      profileEnv: {
        OPENAI_BASE_URL: persistedOpenAIBaseUrl || getOllamaBaseUrl(),
        OPENAI_MODEL:
          persistedOpenAIModel ||
          (await resolveOllamaModel(options.goal)),
        CLAUDE_CODE_PROVIDER_ROUTE_ID: 'ollama',
      },
    })
  }

  if (selectedProfile === 'atomic-chat') {
    const getAtomicChatBaseUrl =
      options.getAtomicChatChatBaseUrl ?? (() => 'http://127.0.0.1:1337/v1')
    const resolveModel =
      options.resolveAtomicChatDefaultModel ?? (async () => null as string | null)

    return buildCompatibilityProcessEnv({
      processEnv,
      compatibilityMode: 'openai',
      profileEnv: {
        OPENAI_BASE_URL: persistedEnv.OPENAI_BASE_URL || getAtomicChatBaseUrl(),
        OPENAI_MODEL:
          persistedEnv.OPENAI_MODEL ||
          (await resolveModel()) ||
          '',
      },
    })
  }

  if (selectedProfile === 'codex') {
    const isCodexOAuthProfile = persistedEnv.CODEX_CREDENTIAL_SOURCE === 'oauth'
    const codexKey = isCodexOAuthProfile
      ? undefined
      : sanitizeApiKey(processEnv.CODEX_API_KEY) ||
        sanitizeApiKey(persistedEnv.CODEX_API_KEY)
    const liveCodexCredentials = isCodexOAuthProfile
      ? undefined
      : resolveCodexApiCredentials(processEnv)
    const codexAccountId = isCodexOAuthProfile
      ? persistedEnv.CHATGPT_ACCOUNT_ID || persistedEnv.CODEX_ACCOUNT_ID
      : processEnv.CHATGPT_ACCOUNT_ID ||
        processEnv.CODEX_ACCOUNT_ID ||
        liveCodexCredentials?.accountId ||
        persistedEnv.CHATGPT_ACCOUNT_ID ||
        persistedEnv.CODEX_ACCOUNT_ID

    return buildCompatibilityProcessEnv({
      processEnv,
      compatibilityMode: 'openai',
      profileEnv: {
        OPENAI_BASE_URL:
          persistedOpenAIBaseUrl && isCodexBaseUrl(persistedOpenAIBaseUrl)
            ? persistedOpenAIBaseUrl
            : DEFAULT_CODEX_BASE_URL,
        OPENAI_MODEL: persistedOpenAIModel || 'codexplan',
        ...(codexKey ? { CODEX_API_KEY: codexKey } : {}),
        ...(codexAccountId ? { CHATGPT_ACCOUNT_ID: codexAccountId } : {}),
      },
    })
  }

  const defaultOpenAIModel = getGoalDefaultOpenAIModel(options.goal)
  const shellOpenAIRequest = resolveProviderRequest({
    model: shellOpenAIModel,
    baseUrl: shellOpenAIBaseUrl,
    fallbackModel: defaultOpenAIModel,
    apiFormat: processEnv.OPENAI_API_FORMAT,
  })
  const persistedOpenAIRequest = resolveProviderRequest({
    model: persistedOpenAIModel,
    baseUrl: persistedOpenAIBaseUrl,
    fallbackModel: defaultOpenAIModel,
    apiFormat: persistedOpenAIApiFormat,
  })
  const useShellOpenAIConfig = shellOpenAIRequest.transport !== 'codex_responses'
  const usePersistedOpenAIConfig =
    (!persistedOpenAIModel && !persistedOpenAIBaseUrl) ||
    persistedOpenAIRequest.transport !== 'codex_responses'

  const env: ProfileEnv = {
    OPENAI_BASE_URL:
      (useShellOpenAIConfig ? shellOpenAIBaseUrl : undefined) ||
      (usePersistedOpenAIConfig ? persistedOpenAIBaseUrl : undefined) ||
      DEFAULT_OPENAI_BASE_URL,
    OPENAI_MODEL:
      (useShellOpenAIConfig ? shellOpenAIModel : undefined) ||
      (usePersistedOpenAIConfig ? persistedOpenAIModel : undefined) ||
      defaultOpenAIModel,
  }
  const openAIApiFormat =
    parseOpenAICompatibleApiFormat(processEnv.OPENAI_API_FORMAT) ||
    (usePersistedOpenAIConfig ? persistedOpenAIApiFormat : undefined)
  if (openAIApiFormat) {
    env.OPENAI_API_FORMAT = openAIApiFormat
  } else {
    delete env.OPENAI_API_FORMAT
  }
  const usePersistedAzureStyle =
    processEnv.OPENAI_AZURE_STYLE === undefined &&
    usePersistedOpenAIConfig &&
    env.OPENAI_BASE_URL === persistedOpenAIBaseUrl
  if (
    isEnvTruthy(processEnv.OPENAI_AZURE_STYLE) ||
    (usePersistedAzureStyle && isEnvTruthy(persistedOpenAIAzureStyle))
  ) {
    env.OPENAI_AZURE_STYLE = '1'
  } else {
    delete env.OPENAI_AZURE_STYLE
  }
  const openAIAuthHeader =
    processEnv.OPENAI_AUTH_HEADER ||
    (usePersistedOpenAIConfig ? persistedOpenAIAuthHeader : undefined)
  if (openAIAuthHeader) {
    env.OPENAI_AUTH_HEADER = openAIAuthHeader
  } else {
    delete env.OPENAI_AUTH_HEADER
  }
  const openAIAuthScheme =
    (processEnv.OPENAI_AUTH_SCHEME === 'bearer' ||
    processEnv.OPENAI_AUTH_SCHEME === 'raw'
      ? processEnv.OPENAI_AUTH_SCHEME
      : undefined) ||
    (usePersistedOpenAIConfig ? persistedOpenAIAuthScheme : undefined)
  if (openAIAuthScheme) {
    env.OPENAI_AUTH_SCHEME = openAIAuthScheme
  } else {
    delete env.OPENAI_AUTH_SCHEME
  }
  const openAIAuthHeaderValue =
    sanitizeApiKey(processEnv.OPENAI_AUTH_HEADER_VALUE) ||
    (usePersistedOpenAIConfig ? persistedOpenAIAuthHeaderValue : undefined)
  if (openAIAuthHeaderValue) {
    env.OPENAI_AUTH_HEADER_VALUE = openAIAuthHeaderValue
  } else {
    delete env.OPENAI_AUTH_HEADER_VALUE
  }
  const openAICredential = resolveOpenAICredentialEnvOverride(
    processEnv,
    persistedEnv,
  )
  if (openAICredential) {
    env[openAICredential.envVar] = openAICredential.value
  }
  // Dedicated vendor credentials ride alongside the generic OpenAI env in
  // persisted profiles (e.g. ATLAS_CLOUD_API_KEY). Carry them over — a live
  // shell value wins over the persisted one, matching OPENAI_API_KEY
  // precedence — because dedicatedCredentialsOnly routes ignore
  // OPENAI_API_KEY, so dropping them would leave the relaunched profile
  // unauthenticated.
  const resolvedOpenAIRouteId = resolveRouteIdFromBaseUrl(env.OPENAI_BASE_URL)
  const persistedOpenAIRouteId = persistedEnv.CLAUDE_CODE_PROVIDER_ROUTE_ID?.trim()
  // Compare on endpoint equivalence, not the raw string: a shell
  // `OPENAI_BASE_URL` that differs from the saved one only by a trailing slash
  // (or scheme/host casing) still names the same endpoint. A literal comparison
  // would drop the saved route identity there, and with it the aimlapi proxy
  // guard below. Path case and query parameters are NOT spelling, though — a
  // different tenant path or query is a distinct target and must not inherit
  // the profile's identity, which is what carries its dedicated credential.
  const shouldUsePersistedOpenAIRouteId =
    !resolvedOpenAIRouteId &&
    !!persistedOpenAIRouteId &&
    !!persistedOpenAIBaseUrl &&
    isSameConfiguredEndpoint(env.OPENAI_BASE_URL, persistedOpenAIBaseUrl)
  const effectiveOpenAIRouteId =
    resolvedOpenAIRouteId ||
    (shouldUsePersistedOpenAIRouteId ? persistedOpenAIRouteId : undefined)
  if (resolvedOpenAIRouteId && resolvedOpenAIRouteId !== 'openai') {
    env.CLAUDE_CODE_PROVIDER_ROUTE_ID = resolvedOpenAIRouteId
  } else if (shouldUsePersistedOpenAIRouteId && persistedOpenAIRouteId) {
    env.CLAUDE_CODE_PROVIDER_ROUTE_ID = persistedOpenAIRouteId
  } else {
    delete env.CLAUDE_CODE_PROVIDER_ROUTE_ID
  }
  // A keyless retained aimlapi/apismart profile on a non-canonical (proxy) base
  // URL must not receive the ambient canonical credential via the generic
  // OPENAI_API_KEY / OPENAI_API_KEYS alias either (the generic selection above
  // prefers the live shell value). Re-source the generic credential from the
  // profile's OWN persisted env and drop a purely ambient one.
  // Scoped to a launch that actually carries the route identity. A profile
  // retargeted to an endpoint it was not saved for keeps no identity, so it is
  // handled by the route-agnostic precedence above rather than here: forcing the
  // profile's own credential in would both hand a key to an endpoint it was not
  // configured for and discard a credential the user supplied for that endpoint.
  const isNoncanonicalAimlapiLaunch =
    effectiveOpenAIRouteId === 'aimlapi' &&
    !!env.OPENAI_BASE_URL?.trim() &&
    !isCanonicalAimlapiInferenceBaseUrl(env.OPENAI_BASE_URL)
  const isNoncanonicalApismartLaunch =
    effectiveOpenAIRouteId === 'apismart' &&
    !!env.OPENAI_BASE_URL?.trim() &&
    !isCanonicalApismartInferenceBaseUrl(env.OPENAI_BASE_URL)
  const isNoncanonicalConcentrateLaunch =
    effectiveOpenAIRouteId === 'concentrate' &&
    !!env.OPENAI_BASE_URL?.trim() &&
    !isCanonicalConcentrateInferenceBaseUrl(env.OPENAI_BASE_URL)
  const isNoncanonicalLlmtrLaunch =
    effectiveOpenAIRouteId === 'llmtr' &&
    !!env.OPENAI_BASE_URL?.trim() &&
    !isCanonicalLlmtrInferenceBaseUrl(env.OPENAI_BASE_URL)
  const isNoncanonicalCommandcodeLaunch =
    effectiveOpenAIRouteId === 'commandcode' &&
    !!env.OPENAI_BASE_URL?.trim() &&
    !isCanonicalCommandcodeInferenceBaseUrl(env.OPENAI_BASE_URL)
  const isNoncanonicalApiRouteLaunch =
    effectiveOpenAIRouteId === 'api-route' &&
    !!env.OPENAI_BASE_URL?.trim() &&
    !isCanonicalApiRouteInferenceBaseUrl(env.OPENAI_BASE_URL)
  const isNoncanonicalDedicatedOpenAILaunch =
    isNoncanonicalAimlapiLaunch ||
    isNoncanonicalApismartLaunch ||
    isNoncanonicalConcentrateLaunch ||
    isNoncanonicalLlmtrLaunch ||
    isNoncanonicalCommandcodeLaunch ||
    isNoncanonicalApiRouteLaunch
  if (isNoncanonicalDedicatedOpenAILaunch) {
    delete env.OPENAI_API_KEY
    delete env.OPENAI_API_KEYS
    // AIMLAPI and ApiSmart may retain a user-configured proxy credential in
    // their persisted generic OpenAI field. Concentrate is different: its
    // dedicated credential is never valid off the canonical endpoint, and
    // older profiles could have stored that same secret under either generic
    // alias. Do not resurrect it for a noncanonical Concentrate launch.
    if (
      !isNoncanonicalConcentrateLaunch &&
      !isNoncanonicalLlmtrLaunch &&
      !isNoncanonicalCommandcodeLaunch
    ) {
      const persistedCredential = resolveOpenAICredentialEnvSelection(persistedEnv)
      if (persistedCredential) {
        env[persistedCredential.envVar] = persistedCredential.value
      }
    }
    // Custom authentication is a second credential channel, not just transport
    // metadata: the OpenAI shim sends OPENAI_AUTH_HEADER_VALUE as the request
    // credential whenever OPENAI_AUTH_HEADER names a header. The selections
    // above prefer the live shell value, so without this an ambient canonical
    // secret would still reach the proxy through custom auth. Re-source the
    // whole trio from the profile's OWN persisted env and drop ambient values;
    // the three are applied as a unit so a shell header name can never activate
    // a value the profile did not configure.
    delete env.OPENAI_AUTH_HEADER
    delete env.OPENAI_AUTH_SCHEME
    delete env.OPENAI_AUTH_HEADER_VALUE
    if (usePersistedOpenAIConfig) {
      if (persistedOpenAIAuthHeader) {
        env.OPENAI_AUTH_HEADER = persistedOpenAIAuthHeader
      }
      if (persistedOpenAIAuthScheme) {
        env.OPENAI_AUTH_SCHEME = persistedOpenAIAuthScheme
      }
      if (persistedOpenAIAuthHeaderValue) {
        env.OPENAI_AUTH_HEADER_VALUE = persistedOpenAIAuthHeaderValue
      }
    }
  }
  for (const dedicatedKey of [
    'ATLAS_CLOUD_API_KEY',
    'APISMART_API_KEY',
    'CONCENTRATE_API_KEY',
    'LLMTR_API_KEY',
    'CMD_API_KEY',
    'COMMANDCODE_API_KEY',
    'COMMAND_CODE_API_KEY',
    'NEARAI_API_KEY',
    'FIREWORKS_API_KEY',
    'LONGCAT_API_KEY',
    'AIMLAPI_API_KEY',
    'MIMO_API_KEY',
    'NVIDIA_API_KEY',
    'VENICE_API_KEY',
  ] as const) {
    // AI/ML API accepts the generic OPENAI_API_KEY, so it does not need an
    // unconditional carry-over. Only mirror AIMLAPI_API_KEY when the launch
    // actually targets the aimlapi route — otherwise an ambient or persisted
    // AI/ML key would leak into an unrelated OpenAI-compatible session.
    if (dedicatedKey === 'AIMLAPI_API_KEY' && effectiveOpenAIRouteId !== 'aimlapi') {
      continue
    }
    if (dedicatedKey === 'APISMART_API_KEY' && effectiveOpenAIRouteId !== 'apismart') {
      continue
    }
    if (dedicatedKey === 'CONCENTRATE_API_KEY' && effectiveOpenAIRouteId !== 'concentrate') {
      continue
    }
    if (dedicatedKey === 'LLMTR_API_KEY' && effectiveOpenAIRouteId !== 'llmtr') {
      continue
    }
    if (
      isCommandcodeCredentialEnvVar(dedicatedKey) &&
      effectiveOpenAIRouteId !== 'commandcode'
    ) {
      continue
    }
    if (dedicatedKey === 'NVIDIA_API_KEY' && effectiveOpenAIRouteId !== 'nvidia-nim') {
      continue
    }
    if (
      dedicatedKey === 'LONGCAT_API_KEY' &&
      (effectiveOpenAIRouteId !== 'longcat' || !isLongcatBaseUrl(env.OPENAI_BASE_URL))
    ) {
      continue
    }
    // On a non-canonical (proxy) aimlapi/apismart base URL, never source the
    // dedicated key from ambient/session credentials — that would leak the
    // canonical provider key to a user-controlled proxy on restart. The
    // profile's OWN persisted key is still applied, since the user configured
    // that key for that proxy.
    const dedicatedBaseUrl = env.OPENAI_BASE_URL?.trim()
    const withholdAmbientAimlapiKey =
      dedicatedKey === 'AIMLAPI_API_KEY' &&
      !!dedicatedBaseUrl &&
      !isCanonicalAimlapiInferenceBaseUrl(dedicatedBaseUrl)
    const withholdAmbientApismartKey =
      dedicatedKey === 'APISMART_API_KEY' &&
      !!dedicatedBaseUrl &&
      !isCanonicalApismartInferenceBaseUrl(dedicatedBaseUrl)
    const withholdAmbientConcentrateKey =
      dedicatedKey === 'CONCENTRATE_API_KEY' &&
      !!dedicatedBaseUrl &&
      !isCanonicalConcentrateInferenceBaseUrl(dedicatedBaseUrl)
    const withholdAmbientLlmtrKey =
      dedicatedKey === 'LLMTR_API_KEY' &&
      !!dedicatedBaseUrl &&
      !isCanonicalLlmtrInferenceBaseUrl(dedicatedBaseUrl)
    const withholdAmbientCommandcodeKey =
      isCommandcodeCredentialEnvVar(dedicatedKey) &&
      !!dedicatedBaseUrl &&
      !isCanonicalCommandcodeInferenceBaseUrl(dedicatedBaseUrl)
    const withholdAmbientDedicatedKey =
      withholdAmbientAimlapiKey ||
      withholdAmbientApismartKey ||
      withholdAmbientConcentrateKey ||
      withholdAmbientLlmtrKey ||
      withholdAmbientCommandcodeKey
    // Unlike the generic proxy-compatible routes above, Concentrate's
    // dedicated key is never valid outside its canonical inference endpoint.
    // Do not preserve a legacy persisted key for a retargeted Concentrate
    // profile: older versions could have serialized one before this boundary
    // was enforced.
    if (
      withholdAmbientConcentrateKey ||
      withholdAmbientLlmtrKey ||
      withholdAmbientCommandcodeKey
    ) {
      continue
    }
    // AIMLAPI accepts generic OpenAI credentials, but ApiSmart is
    // dedicatedCredentialsOnly. Never promote a shell OPENAI_API_KEY into the
    // dedicated credential on relaunch.
    const backfillDedicatedFromOpenAI =
      dedicatedKey === 'AIMLAPI_API_KEY' &&
      openAICredential?.kind === 'usable'
        ? sanitizeApiKey(openAICredential.value)
        : undefined
    // Older ApiSmart profiles predate APISMART_API_KEY and persisted their
    // *profile-owned* credential only as OPENAI_API_KEY. Migrate that stored
    // value for the canonical ApiSmart endpoint, but never use the live shell
    // credential: the latter may belong to an unrelated OpenAI provider.
    const persistedOpenAICredential = resolveOpenAICredentialEnvSelection(persistedEnv)
    const backfillLegacyApismartProfileKey =
      dedicatedKey === 'APISMART_API_KEY' &&
      effectiveOpenAIRouteId === 'apismart' &&
      !!dedicatedBaseUrl &&
      isCanonicalApismartInferenceBaseUrl(dedicatedBaseUrl) &&
      persistedOpenAICredential?.kind === 'usable'
        ? sanitizeApiKey(persistedOpenAICredential.value)
        : undefined
    const backfillLegacyConcentrateProfileKey =
      dedicatedKey === 'CONCENTRATE_API_KEY' &&
      effectiveOpenAIRouteId === 'concentrate' &&
      persistedOpenAIRouteId === 'concentrate' &&
      !!dedicatedBaseUrl &&
      isCanonicalConcentrateInferenceBaseUrl(dedicatedBaseUrl) &&
      persistedOpenAICredential?.kind === 'usable'
        ? sanitizeApiKey(persistedOpenAICredential.value)
        : undefined
    // A selected canonical LLMTR profile owns its saved credential. Prefer it
    // over an unrelated ambient LLMTR_API_KEY on restart, and migrate startup
    // files written before LLMTR_API_KEY was persisted explicitly.
    const persistedLlmtrProfileKey =
      dedicatedKey === 'LLMTR_API_KEY' &&
      effectiveOpenAIRouteId === 'llmtr' &&
      !!dedicatedBaseUrl &&
      isCanonicalLlmtrInferenceBaseUrl(dedicatedBaseUrl)
        ? sanitizeApiKey(persistedEnv.LLMTR_API_KEY) ||
          (persistedOpenAICredential?.kind === 'usable'
            ? sanitizeApiKey(persistedOpenAICredential.value)
            : undefined)
        : undefined
    // A selected canonical Command Code profile owns its saved credential.
    // Prefer persisted dedicated keys, then migrate startup files that only
    // mirrored the secret into OPENAI_API_KEY (LLMTR parity). Do not treat a
    // live generic OpenAI key as a Command Code credential.
    const persistedCommandcodeProfileIdentity =
      persistedOpenAIRouteId === 'commandcode' ||
      (!persistedOpenAIRouteId &&
        isCanonicalCommandcodeInferenceBaseUrl(persistedOpenAIBaseUrl))
    const persistedCommandcodeProfileKey =
      isCommandcodeCredentialEnvVar(dedicatedKey) &&
      effectiveOpenAIRouteId === 'commandcode' &&
      persistedCommandcodeProfileIdentity &&
      !!dedicatedBaseUrl &&
      isCanonicalCommandcodeInferenceBaseUrl(dedicatedBaseUrl)
        ? sanitizeApiKey(persistedEnv[dedicatedKey]) ||
          (dedicatedKey === 'CMD_API_KEY'
            ? sanitizeApiKey(persistedEnv.COMMANDCODE_API_KEY) ||
              sanitizeApiKey(persistedEnv.COMMAND_CODE_API_KEY)
            : undefined) ||
          (dedicatedKey === 'CMD_API_KEY' &&
          persistedOpenAICredential?.kind === 'usable'
            ? sanitizeApiKey(persistedOpenAICredential.value)
            : undefined)
        : undefined
    const dedicatedValue = withholdAmbientDedicatedKey
      ? sanitizeApiKey(persistedEnv[dedicatedKey])
      : backfillDedicatedFromOpenAI ||
        persistedLlmtrProfileKey ||
        persistedCommandcodeProfileKey ||
        sanitizeApiKey(processEnv[dedicatedKey]) ||
        sanitizeApiKey(persistedEnv[dedicatedKey]) ||
        backfillLegacyApismartProfileKey ||
        backfillLegacyConcentrateProfileKey
    if (dedicatedValue) {
      env[dedicatedKey] = dedicatedValue
    }
  }
  if (effectiveOpenAIRouteId === 'nvidia-nim') {
    const nvidiaNimFlag = processEnv.NVIDIA_NIM || persistedEnv.NVIDIA_NIM
    if (nvidiaNimFlag) {
      env.NVIDIA_NIM = nvidiaNimFlag
    }
  }
  // ANTHROPIC_CUSTOM_HEADERS is a third credential channel: client.ts parses it
  // and merges the result into the defaultHeaders it hands to the OpenAI shim
  // client, and its own filter only drops `authorization`, `x-api-key` and
  // `api-key` — a custom-named header such as `X-Proxy-Auth: <secret>` survives
  // and is sent on every request. So an ambient value must be withheld from a
  // non-canonical aimlapi/apismart launch exactly like the API key and the
  // custom-auth trio; only headers the profile itself persisted are restored.
  const customHeaders = isNoncanonicalDedicatedOpenAILaunch
    ? persistedCustomHeaders
    : shellCustomHeaders || persistedCustomHeaders
  if (customHeaders) {
    env.ANTHROPIC_CUSTOM_HEADERS = customHeaders
  } else {
    delete env.ANTHROPIC_CUSTOM_HEADERS
  }
  const contextWindows =
    processEnv.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS ||
    (usePersistedOpenAIConfig
      ? persistedEnv.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS
      : undefined)
  if (contextWindows) {
    env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS = contextWindows
  }

  return buildCompatibilityProcessEnv({
    processEnv,
    compatibilityMode: 'openai',
    profileEnv: env,
  })
}

export async function buildStartupEnvFromProfile(options?: {
  persisted?: ProfileFile | null
  goal?: RecommendationGoal
  processEnv?: NodeJS.ProcessEnv
  getOllamaChatBaseUrl?: (baseUrl?: string) => string
  resolveOllamaDefaultModel?: (goal: RecommendationGoal) => Promise<string>
  readGeminiAccessToken?: () => string | undefined
}): Promise<NodeJS.ProcessEnv> {
  const processEnv = options?.processEnv ?? process.env
  const persisted =
    options && 'persisted' in options ? options.persisted : loadProfileFile()

  const profileManagedEnv = processEnv.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED === '1'

  // The single-profile file in the user config directory is a
  // first-run / fallback mechanism. The newer plural provider-profile
  // system (`/provider` presets + activeProviderProfileId in config) is
  // applied earlier in the bootstrap via applyActiveProviderProfileFromConfig
  // and signals completion with CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED=1.
  //
  // If the plural system has already set env, trust it — do NOT overlay the
  // legacy file. addProviderProfile() does not sync the legacy file, so a
  // stale legacy file (e.g. OpenAI defaults from an earlier manual setup)
  // would otherwise overwrite the correct plural env and surface as the
  // "banner shows gpt-4o / api.openai.com even though my saved profile is
  // Moonshot" bug.
  if (profileManagedEnv) {
    return processEnv
  }

  const concreteOpenAIRouteId = getConcreteOpenAICompatibleEnvRouteId(processEnv)
  if (
    concreteOpenAIRouteId === 'nvidia-nim' &&
    !isEnvTruthy(processEnv.CLAUDE_CODE_USE_OPENAI) &&
    !hasExplicitOpenAICompatibleOptOut(processEnv) &&
    !hasExplicitNonOpenAIProviderSelection(processEnv)
  ) {
    return buildLaunchEnv({
      profile: 'openai',
      persisted: null,
      goal:
        options?.goal ??
        normalizeRecommendationGoal(processEnv.OPENCLAUDE_PROFILE_GOAL),
      processEnv,
    })
  }

  // If startup already has a concrete provider selection, keep trusting it.
  // This prevents legacy profiles or the fresh-install default from becoming
  // a silent third precedence layer over explicit env/flags.
  // Retained dedicated-provider proxy profiles carry route identity specifically
  // to withhold ambient credentials from their noncanonical endpoint. Do not
  // let an env-only key skip that guard; the persisted profile must be applied
  // first so buildLaunchEnv can preserve the credential boundary.
  const persistedApismartProxy =
    persisted?.profile === 'openai' &&
    persisted.env.CLAUDE_CODE_PROVIDER_ROUTE_ID === 'apismart' &&
    !!persisted.env.OPENAI_BASE_URL?.trim() &&
    !isCanonicalApismartInferenceBaseUrl(persisted.env.OPENAI_BASE_URL)
  const persistedConcentrateProxy =
    persisted?.profile === 'openai' &&
    persisted.env.CLAUDE_CODE_PROVIDER_ROUTE_ID === 'concentrate' &&
    !!persisted.env.OPENAI_BASE_URL?.trim() &&
    !isCanonicalConcentrateInferenceBaseUrl(persisted.env.OPENAI_BASE_URL)
  const persistedLlmtrProxy =
    persisted?.profile === 'openai' &&
    persisted.env.CLAUDE_CODE_PROVIDER_ROUTE_ID === 'llmtr' &&
    !!persisted.env.OPENAI_BASE_URL?.trim() &&
    !isCanonicalLlmtrInferenceBaseUrl(persisted.env.OPENAI_BASE_URL)
  const persistedCommandcodeProxy =
    persisted?.profile === 'openai' &&
    persisted.env.CLAUDE_CODE_PROVIDER_ROUTE_ID === 'commandcode' &&
    !!persisted.env.OPENAI_BASE_URL?.trim() &&
    !isCanonicalCommandcodeInferenceBaseUrl(persisted.env.OPENAI_BASE_URL)
  const persistedApiRouteProxy =
    persisted?.profile === 'openai' &&
    persisted.env.CLAUDE_CODE_PROVIDER_ROUTE_ID === 'api-route' &&
    !!persisted.env.OPENAI_BASE_URL?.trim() &&
    !isCanonicalApiRouteInferenceBaseUrl(persisted.env.OPENAI_BASE_URL)
  if (
    hasConcreteProviderSelection(processEnv) &&
    !persistedApismartProxy &&
    !persistedConcentrateProxy &&
    !persistedLlmtrProxy &&
    !persistedCommandcodeProxy &&
    !persistedApiRouteProxy
  ) {
    return processEnv
  }

  if (isEnvTruthy(processEnv.CLAUDE_CODE_USE_GITHUB)) {
    return processEnv
  }

  if (!persisted) {
    // No saved profile. If the user explicitly disabled the OpenAI-compatible
    // provider (CLAUDE_CODE_USE_OPENAI=0), honor that opt-out instead of
    // injecting the default Opengateway profile — otherwise the fallback
    // re-enables OpenAI and the startup validator reports a spurious missing
    // OPENAI_API_KEY warning (#1245).
    if (hasExplicitOpenAICompatibleOptOut(processEnv)) {
      return processEnv
    }

    // No saved profile — default to Twigpine Opengateway.
    const env = buildCompatibilityProcessEnv({
      processEnv,
      compatibilityMode: 'openai',
      profileEnv: {
        OPENAI_BASE_URL:
          getRouteDefaultBaseUrl('gitlawb-opengateway') ??
          'https://opengateway.gitlawb.com/v1',
        OPENAI_MODEL:
          getRouteDefaultModel('gitlawb-opengateway') ?? 'mimo-v2.5-pro',
      },
    })
    env[DEFAULT_STARTUP_PROVIDER_ENV_VAR] = 'gitlawb-opengateway'
    return env
  }

  return buildLaunchEnv({
    profile: persisted.profile,
    persisted,
    goal:
      options?.goal ??
      normalizeRecommendationGoal(processEnv.OPENCLAUDE_PROFILE_GOAL),
    processEnv,
    getOllamaChatBaseUrl:
      options?.getOllamaChatBaseUrl ?? getOllamaChatBaseUrl,
    resolveOllamaDefaultModel: options?.resolveOllamaDefaultModel,
    readGeminiAccessToken: options?.readGeminiAccessToken,
  })
}

export function applyProfileEnvToProcessEnv(
  targetEnv: NodeJS.ProcessEnv,
  nextEnv: NodeJS.ProcessEnv,
): void {
  clearManagedProfileEnv(targetEnv)
  Object.assign(targetEnv, nextEnv)
}

type StartupEnvOptions = NonNullable<Parameters<typeof buildStartupEnvFromProfile>[0]>

export async function applyStartupEnvFromProfile(options?: StartupEnvOptions & {
  modelOverride?: string
  onValidationError?: (message: string) => void
}): Promise<string | null> {
  const processEnv = options?.processEnv ?? process.env
  const { modelOverride, onValidationError, ...startupOptions } = options ?? {}
  // Resolve the persisted profile HERE (once) so the warning gate below has
  // explicit provenance. Sniffing the DEFAULT_STARTUP_PROVIDER_ENV_VAR marker
  // alone is not enough: a persisted profile's launch env spreads processEnv,
  // so a marker inherited from a parent CLI process (pane/teammate children)
  // could make a genuinely saved profile look like the injected default.
  const persisted =
    startupOptions && 'persisted' in startupOptions
      ? startupOptions.persisted
      : loadProfileFile()
  const startupEnv = await buildStartupEnvFromProfile({
    ...startupOptions,
    persisted,
    processEnv,
  })
  if (startupEnv === processEnv) {
    return null
  }

  // A root CLI --model is higher precedence than saved profile state. Apply
  // it to the candidate before Command Code's model contract is validated so
  // a compatible override can recover a stale saved model.
  if (modelOverride && resolveActiveRouteIdFromEnv(startupEnv) === 'commandcode') {
    startupEnv.OPENAI_MODEL =
      modelOverride === 'default'
        ? getRouteDefaultModel('commandcode') ?? modelOverride
        : modelOverride
  }

  const validationError = await getProviderValidationError(startupEnv)
  if (validationError) {
    // The injected fresh-install Opengateway default failing validation is the
    // EXPECTED state for a brand-new machine with no OPENGATEWAY_API_KEY —
    // nothing was "saved", so warning on every command (even --help) is
    // first-boot noise, not signal (#1651 chose ignore+warn; the warn half
    // broke the zero-warning install contract). Onboarding surfaces provider
    // setup instead. Genuinely persisted profiles that fail validation still
    // warn: the user configured something that no longer works. Both checks
    // are required — `!persisted` is the provenance, the marker check keeps
    // non-default fallback envs (e.g. the nvidia-nim rescue path) warning.
    if (persisted || !isDefaultStartupProviderEnv(startupEnv)) {
      onValidationError?.(
        `Warning: ignoring saved provider profile. ${validationError}`,
      )
    }
    return validationError
  }

  applyProfileEnvToProcessEnv(processEnv, startupEnv)
  return null
}

export async function applySavedProfileToCurrentSession(options: {
  profileFile: ProfileFile
  processEnv?: NodeJS.ProcessEnv
}): Promise<string | null> {
  const processEnv = options.processEnv ?? process.env
  const hasExplicitSelection = hasExplicitProviderSelection(processEnv)
  const profileManagedEnv =
    processEnv.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED === '1'

  if (options.profileFile.profile === 'codex' && hasExplicitSelection) {
    const isCodexOAuthProfile =
      options.profileFile.env.CODEX_CREDENTIAL_SOURCE === 'oauth'
    const buildEnvSource = isCodexOAuthProfile
      ? { ...processEnv }
      : processEnv
    if (isCodexOAuthProfile) {
      delete buildEnvSource.CODEX_API_KEY
      delete buildEnvSource.CODEX_ACCOUNT_ID
      delete buildEnvSource.CHATGPT_ACCOUNT_ID
    }
    const explicitEnv = await buildLaunchEnv({
      profile: options.profileFile.profile,
      persisted: options.profileFile,
      goal: normalizeRecommendationGoal(processEnv.OPENCLAUDE_PROFILE_GOAL),
      processEnv: buildEnvSource,
      getOllamaChatBaseUrl,
      readGeminiAccessToken,
    })
    delete explicitEnv.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
    delete explicitEnv.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID
    const validationEnv = isCodexOAuthProfile
      ? { ...explicitEnv, CODEX_API_KEY: 'codex-oauth-token-for-validation' }
      : explicitEnv
    const validationError = await getProviderValidationError(validationEnv)

    if (profileManagedEnv) {
      delete processEnv.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
      delete processEnv.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID
      applyProfileEnvToProcessEnv(processEnv, explicitEnv)
      return validationError
    }

    return (
      validationError ??
      'current session already has an explicit provider selection'
    )
  }

  const baseEnv = { ...processEnv }
  const isCodexOAuthProfile =
    options.profileFile.profile === 'codex' &&
    options.profileFile.env.CODEX_CREDENTIAL_SOURCE === 'oauth'

  delete baseEnv.CLAUDE_CODE_USE_OPENAI
  delete baseEnv.CLAUDE_CODE_USE_GITHUB
  delete baseEnv.CLAUDE_CODE_USE_GEMINI
  delete baseEnv.CLAUDE_CODE_USE_MISTRAL
  delete baseEnv.CLAUDE_CODE_USE_BEDROCK
  delete baseEnv.CLAUDE_CODE_USE_VERTEX
  delete baseEnv.CLAUDE_CODE_USE_FOUNDRY
  delete baseEnv.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
  delete baseEnv.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID

  if (isCodexOAuthProfile) {
    delete baseEnv.CODEX_API_KEY
    delete baseEnv.CODEX_ACCOUNT_ID
    delete baseEnv.CHATGPT_ACCOUNT_ID
  }

  const nextEnv = await buildLaunchEnv({
    profile: options.profileFile.profile,
    persisted: options.profileFile,
    goal: normalizeRecommendationGoal(processEnv.OPENCLAUDE_PROFILE_GOAL),
    processEnv: baseEnv,
    getOllamaChatBaseUrl,
    readGeminiAccessToken,
  })
  const validationEnv = isCodexOAuthProfile
    ? { ...nextEnv, CODEX_API_KEY: 'codex-oauth-token-for-validation' }
    : nextEnv
  const validationError = await getProviderValidationError(validationEnv)
  if (validationError) {
    return validationError
  }

  delete processEnv.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
  delete processEnv.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID
  applyProfileEnvToProcessEnv(processEnv, nextEnv)
  return null
}
