import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  isCodexRefreshFailureCoolingDown,
  readCodexCredentials,
  type CodexCredentialBlob,
} from '../../utils/codexCredentials.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import {
  asTrimmedString,
  parseChatgptAccountId,
} from './codexOAuthShared.js'
import {
  DEFAULT_GEMINI_BASE_URL,
  DEFAULT_GEMINI_MODEL,
} from 'src/utils/providerProfile.js'
import {
  DEFAULT_CLINEPASS_BASE_URL,
} from './clinepassUsage/types.js'
import { getCatalogEntriesForRoute } from '../../integrations/registry.js'
import {
  getRouteDefaultBaseUrl,
  getRouteDefaultModel,
  isApismartBaseUrl,
  isClinePassBaseUrl,
} from '../../integrations/routeMetadata.js'
import { hasUsableOpenAICredential } from './credentialPool.js'
import {
  openAIShimSupportsApiFormatForModel,
  resolveOpenAIShimRuntimeContext,
} from '../../integrations/runtimeMetadata.js'

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'
export const DEFAULT_MISTRAL_BASE_URL = 'https://api.mistral.ai/v1'
export const DEFAULT_OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1'
export const DEFAULT_OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1'
export const DEFAULT_CLINEPASS_API_BASE_URL = `${DEFAULT_CLINEPASS_BASE_URL}/api/v1`
/** Default GitHub Copilot API model when user selects copilot / github:copilot */
export const DEFAULT_GITHUB_MODELS_API_MODEL = 'gpt-4o'
const warnedUndefinedEnvNames = new Set<string>()

function asGithubEnterpriseEnvUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed || trimmed.toLowerCase() === 'undefined') {
    return undefined
  }
  return trimmed
}

function normalizeGitlawbOpengatewayBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined
  try {
    const parsed = new URL(baseUrl)
    const hostname = parsed.hostname.toLowerCase()
    if (hostname !== 'opengateway.gitlawb.com' && hostname !== 'opengateway.fly.dev') {
      return baseUrl
    }
    const path = parsed.pathname.replace(/\/+$/, '').toLowerCase()
    if (path === '/v1/xiaomi-mimo' || path === '/v1/gmi-cloud') {
      parsed.pathname = '/v1'
      parsed.search = ''
      parsed.hash = ''
      return parsed.toString().replace(/\/+$/, '')
    }
  } catch {
    return baseUrl
  }
  return baseUrl
}

const CODEX_ALIAS_MODELS: Record<
  string,
  {
    model: string
    reasoningEffort?: ReasoningEffort
  }
> = {
  codexplan: {
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
  },
  // GPT-5.6 family (July 2026). `gpt-5.6` follows the Codex CLI convention of
  // resolving the bare version to the flagship tier (Sol).
  'gpt-5.6': {
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
  },
  'gpt-5.6-sol': {
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
  },
  'gpt-5.6-terra': {
    model: 'gpt-5.6-terra',
    reasoningEffort: 'medium',
  },
  'gpt-5.6-luna': {
    model: 'gpt-5.6-luna',
    reasoningEffort: 'medium',
  },
  'gpt-5.5': {
    model: 'gpt-5.5',
    reasoningEffort: 'high',
  },
  'gpt-5.4': {
    model: 'gpt-5.4',
    reasoningEffort: 'high',
  },
  'gpt-5.3-codex': {
    model: 'gpt-5.3-codex',
    reasoningEffort: 'high',
  },
  'gpt-5.3-codex-spark': {
    model: 'gpt-5.3-codex-spark',
  },
  codexspark: {
    model: 'gpt-5.3-codex-spark',
  },
  'gpt-5.2-codex': {
    model: 'gpt-5.2-codex',
    reasoningEffort: 'high',
  },
  'gpt-5.1-codex-max': {
    model: 'gpt-5.1-codex-max',
    reasoningEffort: 'high',
  },
  'gpt-5.1-codex-mini': {
    model: 'gpt-5.1-codex-mini',
  },
  'gpt-5.5-mini': {
    model: 'gpt-5.5-mini',
    reasoningEffort: 'medium',
  },
  'gpt-5.4-mini': {
    model: 'gpt-5.4-mini',
    reasoningEffort: 'medium',
  },
  'gpt-5.2': {
    model: 'gpt-5.2',
    reasoningEffort: 'medium',
  },
} as const

type CodexAlias = keyof typeof CODEX_ALIAS_MODELS
type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
type ThinkingType = 'enabled' | 'disabled'

const OPENAI_CODEX_SHORTCUT_ALIASES = new Set(['codexplan', 'codexspark'])
const KIMI_K3_REASONING_ALIASES: Record<ReasoningEffort, ReasoningEffort> = {
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
}

export type ProviderTransport = 'chat_completions' | 'responses' | 'responses_compat' | 'codex_responses'
export type OpenAICompatibleApiFormat = 'chat_completions' | 'responses' | 'responses_compat'

export type ResolvedProviderRequest = {
  transport: ProviderTransport
  requestedModel: string
  resolvedModel: string
  baseUrl: string
  reasoning?: {
    effort: ReasoningEffort
  }
  thinking?: {
    type: ThinkingType
  }
}

export type ResolvedCodexCredentials = {
  apiKey: string
  accountId?: string
  authPath?: string
  source: 'env' | 'secure-storage' | 'auth.json' | 'none'
}

type ModelDescriptor = {
  raw: string
  baseModel: string
  reasoning?: {
    effort: ReasoningEffort
  }
  // True when `reasoning` is the CODEX_ALIAS_MODELS default rather than an
  // explicit ?reasoning= query pick. Alias defaults are a Codex convention:
  // they must not leak onto non-Codex transports (an OPENAI_API_BASE gateway
  // serving gpt-5.6 must not inherit first-party effort metadata).
  reasoningFromAlias?: boolean
  thinking?: {
    type: ThinkingType
  }
}

const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])

function hashCacheScopePartition(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 16)
}

function normalizeCacheScopeHeaderValue(value: string | undefined): string {
  return value?.trim() ?? ''
}

function isPrivateIpv4Address(hostname: string): boolean {
  const octets = hostname.split('.').map(part => Number.parseInt(part, 10))
  if (octets.length !== 4 || octets.some(octet => Number.isNaN(octet))) {
    return false
  }

  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  )
}

function isPrivateIpv6Address(hostname: string): boolean {
  const firstHextet = hostname.split(':', 1)[0]
  if (!firstHextet) return false

  const prefix = Number.parseInt(firstHextet, 16)
  if (Number.isNaN(prefix)) return false

  return (prefix & 0xfe00) === 0xfc00 || (prefix & 0xffc0) === 0xfe80
}

// Reads an env-var-style string intended as a URL or path, rejecting both
// empty strings and the literal string "undefined" that Windows shells can
// write when a variable is unset-then-referenced without quotes (issue #336).
function asEnvUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const normalized = trimmed.toLowerCase()
  // Windows/dotenv templates often materialize unset vars as the literal
  // strings "undefined" or "null". Neither is a usable endpoint.
  if (normalized === 'undefined' || normalized === 'null') {
    return undefined
  }
  return trimmed
}

function asNamedEnvUrl(
  value: string | undefined,
  envName: string,
): string | undefined {
  if (!value) return undefined

  const trimmed = value.trim()
  if (!trimmed) return undefined

  const normalized = trimmed.toLowerCase()
  if (normalized === 'undefined' || normalized === 'null') {
    if (!warnedUndefinedEnvNames.has(envName)) {
      warnedUndefinedEnvNames.add(envName)
      logForDebugging(
        `[provider-config] Environment variable ${envName} is the literal string "${trimmed}"; ignoring it.`,
        { level: 'warn' },
      )
    }
    return undefined
  }

  return trimmed
}

function asUsableModelEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  const normalized = trimmed.toLowerCase()
  return normalized === 'undefined' || normalized === 'null'
    ? undefined
    : trimmed
}

function readNestedString(
  value: unknown,
  paths: string[][],
): string | undefined {
  for (const path of paths) {
    let current = value
    let valid = true
    for (const key of path) {
      if (!current || typeof current !== 'object' || !(key in current)) {
        valid = false
        break
      }
      current = (current as Record<string, unknown>)[key]
    }
    if (!valid) continue
    const stringValue = asTrimmedString(current)
    if (stringValue) return stringValue
  }
  return undefined
}

function normalizeModelLookupKey(model: string): string {
  return model.trim().split('?', 1)[0]?.trim().toLowerCase() ?? ''
}

function resolveRouteCatalogAliasApiName(options: {
  model: string
  baseUrl: string | undefined
  processEnv: NodeJS.ProcessEnv
}): string {
  const normalizedModel = normalizeModelLookupKey(options.model)
  if (!normalizedModel) return options.model

  const runtimeShimContext = resolveOpenAIShimRuntimeContext({
    processEnv: options.processEnv,
    baseUrl: options.baseUrl,
    model: options.model,
    treatAsLocal: options.baseUrl ? isLocalProviderUrl(options.baseUrl) : false,
    preferBaseUrlRoute: options.baseUrl !== undefined,
  })
  const routeId = runtimeShimContext.routeId
  if (!routeId || routeId === 'anthropic' || routeId === 'openai') {
    return options.model
  }

  const entry = getCatalogEntriesForRoute(routeId).find(catalogEntry =>
    normalizeModelLookupKey(catalogEntry.apiName) === normalizedModel ||
    normalizeModelLookupKey(catalogEntry.id) === normalizedModel ||
    (catalogEntry.aliases ?? []).some(
      alias => normalizeModelLookupKey(alias) === normalizedModel,
    ),
  )
  return entry?.apiName ?? options.model
}

function parseReasoningEffort(value: string | undefined): ReasoningEffort | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'xhigh' || normalized === 'max') {
    return normalized
  }
  return undefined
}

function parseThinkingType(value: string | undefined): ThinkingType | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  return normalized === 'enabled' || normalized === 'disabled'
    ? normalized
    : undefined
}

export function parseOpenAICompatibleApiFormat(
  value: string | undefined,
): OpenAICompatibleApiFormat | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase().replace(/[- ]+/g, '_')
  if (
    normalized === 'responses' ||
    normalized === 'response' ||
    normalized === 'responses_api'
  ) {
    return 'responses'
  }
  if (normalized === 'responses_compat' || normalized === 'responses_text') {
    return 'responses_compat'
  }
  if (
    normalized === 'chat_completions' ||
    normalized === 'chat_completion' ||
    normalized === 'completions' ||
    normalized === 'completion' ||
    normalized === 'chat'
  ) {
    return 'chat_completions'
  }
  return undefined
}

function parseModelDescriptor(model: string): ModelDescriptor {
  // A trailing [1m] suffix is the client-side 1M-context opt-in (see
  // has1mContext) — never part of the wire model id or the ?query syntax.
  // Strip it before parsing so tagged aliases keep their mapping and effort
  // defaults and the resolved model id stays valid for the backend. The tag
  // can trail the whole string (`gpt-5.6-sol?reasoning=medium[1m]`) or sit
  // on the base id (`gpt-5.5[1m]`); both forms are handled.
  const trimmed = model.trim().replace(/\[1m]$/i, '').trim()
  const queryIndex = trimmed.indexOf('?')
  if (queryIndex === -1) {
    const alias = trimmed.toLowerCase() as CodexAlias
    const aliasConfig = Object.hasOwn(CODEX_ALIAS_MODELS, alias)
      ? CODEX_ALIAS_MODELS[alias]
      : undefined
    if (aliasConfig) {
      return {
        raw: trimmed,
        baseModel: aliasConfig.model,
        reasoning: aliasConfig.reasoningEffort
          ? { effort: aliasConfig.reasoningEffort }
          : undefined,
        reasoningFromAlias: Boolean(aliasConfig.reasoningEffort),
      }
    }
    return {
      raw: trimmed,
      baseModel: trimmed,
    }
  }

  const baseModel = trimmed
    .slice(0, queryIndex)
    .trim()
    .replace(/\[1m]$/i, '')
  const params = new URLSearchParams(trimmed.slice(queryIndex + 1))
  const alias = baseModel.toLowerCase() as CodexAlias
  const aliasConfig = Object.hasOwn(CODEX_ALIAS_MODELS, alias)
    ? CODEX_ALIAS_MODELS[alias]
    : undefined
  const resolvedBaseModel = aliasConfig?.model ?? baseModel
  const queryReasoning = parseReasoningEffort(params.get('reasoning') ?? undefined)
  const reasoning =
    queryReasoning ??
    (aliasConfig?.reasoningEffort
      ? { effort: aliasConfig.reasoningEffort }
      : undefined)
  const thinking = parseThinkingType(params.get('thinking') ?? undefined)

  return {
    raw: trimmed,
    baseModel: resolvedBaseModel,
    reasoning: typeof reasoning === 'string' ? { effort: reasoning } : reasoning,
    reasoningFromAlias:
      queryReasoning === undefined && Boolean(aliasConfig?.reasoningEffort),
    thinking: thinking ? { type: thinking } : undefined,
  }
}

export function isCodexAlias(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  const base = normalized.split('?', 1)[0] ?? normalized
  return Object.hasOwn(CODEX_ALIAS_MODELS, base)
}

function isOpenAICodexShortcutAlias(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  const base = normalized.split('?', 1)[0] ?? normalized
  return OPENAI_CODEX_SHORTCUT_ALIASES.has(base)
}

export function shouldUseCodexTransport(
  model: string,
  baseUrl: string | undefined,
): boolean {
  const explicitBaseUrl = asEnvUrl(baseUrl)
  return isCodexBaseUrl(explicitBaseUrl) || (!explicitBaseUrl && isCodexAlias(model))
}

function shouldUseGithubResponsesApi(model: string): boolean {
  const normalized = model.trim().toLowerCase()

  // Codex-branded models require /responses.
  if (normalized.includes('codex')) return true

  // GPT-5+ models use /responses, except gpt-5-mini.
  const match = /^gpt-(\d+)/.exec(normalized)
  if (!match) return false
  const major = Number(match[1])
  if (major < 5) return false
  if (normalized.startsWith('gpt-5-mini')) return false
  return true
}

// GPT-5.4/5.5/5.6 (incl. sol/terra/luna suffixes) reject function tools +
// reasoning_effort on /v1/chat/completions and must use /v1/responses. An
// agent CLI always sends tools, so plain OpenAI/Azure users can't otherwise
// reach these models. Matches gpt-5.4/5.5/5.6 with any non-mini/nano
// suffix. -mini/-nano variants are excluded as unverified — they keep
// chat/completions, and the OPENAI_API_FORMAT / profile apiFormat override
// covers them if they turn out to need /responses. Two-digit minors
// (gpt-5.10+) are deliberately unmatched: auto-routing unverified future
// models is the exact risk this predicate exists to avoid. Bare gpt-5,
// gpt-5-mini, gpt-4.x, o-series, and claude-* stay on chat/completions.
export function modelRequiresResponsesApi(model: string): boolean {
  const normalized = model.trim().toLowerCase().split('?', 1)[0] ?? ''
  return /^gpt-5\.[4-6](?!\d)/.test(normalized) &&
    !GPT5_MINI_NANO_RE.test(normalized)
}

// The gpt-5 family boundary: gpt-5, gpt-5-*, gpt-5.x — without matching
// gpt-50-style ids. Shared by supportsCodexReasoningEffort and the Codex
// profile model gate so the family shape lives in one place.
const GPT5_FAMILY_RE = /^gpt-5(?:[.-]|$)/
const GPT5_MINI_NANO_RE = /(?:^|[-.])(?:mini|nano)(?:[-.]|$)/

// gpt-5 family models the ChatGPT Codex backend can serve. The -mini/-nano
// tiers are API-only (never exposed through the Codex transport), so a
// stale gpt-5-mini pick saved under a direct-OpenAI profile must fall back
// to the Codex profile's default rather than be sent to the backend and 400.
export function isCodexEligibleGpt5Model(model: string): boolean {
  const base = model.trim().toLowerCase().split('?', 1)[0] ?? ''
  return GPT5_FAMILY_RE.test(base) && !GPT5_MINI_NANO_RE.test(base)
}

// The responses auto-route only fires for the OpenAI first-party surface
// (the default base, api.openai.com, and its OpenAI-controlled subdomains
// like the eu./us. regional endpoints) and Azure OpenAI hosts, where
// /v1/responses is known to exist. Arbitrary OpenAI-compatible gateways
// (OpenRouter-style proxies) often lack it, so those keep chat/completions
// unless the user opts in via OPENAI_API_FORMAT / apiFormat.
function isDefaultOrDirectOpenAIBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl || baseUrl === DEFAULT_OPENAI_BASE_URL) return true
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase()
    return hostname === 'api.openai.com' || hostname.endsWith('.api.openai.com')
  } catch {
    return false
  }
}

// Azure-style endpoint detection shared by the responses auto-route gate and
// the shim's URL/auth handling. OPENAI_AZURE_STYLE=1 forces Azure handling
// for endpoints whose hostname would not otherwise match (APIM-fronted,
// private link); hostname-based otherwise (not raw URL) to prevent bypass
// via path segments like https://evil.com/cognitiveservices.azure.com/.
export function isAzureStyleBaseUrl(
  baseUrl: string | undefined,
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isEnvTruthy(processEnv.OPENAI_AZURE_STYLE)) return true
  if (!baseUrl) return false
  try {
    const hostname = new URL(baseUrl).hostname
    return hostname.endsWith('.openai.azure.com') ||
      hostname.endsWith('.cognitiveservices.azure.com') ||
      hostname.endsWith('.services.ai.azure.com') ||
      hostname.endsWith('.inference.ml.azure.com')
  } catch {
    return false
  }
}

export function baseUrlSupportsResponsesAutoRoute(
  baseUrl: string | undefined,
  processEnv: NodeJS.ProcessEnv,
): boolean {
  return isDefaultOrDirectOpenAIBaseUrl(baseUrl) || isAzureStyleBaseUrl(baseUrl, processEnv)
}

export function isLocalProviderUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    let hostname = new URL(baseUrl).hostname.toLowerCase()

    // Strip IPv6 brackets added by the URL parser (e.g. "[::1]" -> "::1")
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      hostname = hostname.slice(1, -1)
    }

    // Strip RFC6874 IPv6 zone identifiers (e.g. "fe80::1%25en0" -> "fe80::1")
    const zoneIdIndex = hostname.indexOf('%25')
    if (zoneIdIndex !== -1) {
      hostname = hostname.slice(0, zoneIdIndex)
    }

    if (LOCALHOST_HOSTNAMES.has(hostname)) {
      return true
    }
    if (hostname.endsWith('.local')) {
      return true
    }

    const ipVersion = isIP(hostname)
    if (ipVersion === 4) {
      // Treat the full 127.0.0.0/8 loopback range as local
      const firstOctet = Number.parseInt(hostname.split('.', 1)[0] ?? '', 10)
      return firstOctet === 127 || isPrivateIpv4Address(hostname)
    }
    if (ipVersion === 6) {
      return isPrivateIpv6Address(hostname)
    }

    return false
  } catch {
    return false
  }
}

// Fast-path opt-outs that are safe (and beneficial) when the provider is a
// local OpenAI-compatible endpoint. These features are designed for cloud
// behaviours that do not exist on local backends:
//   - byte-stable serialization (`stableStringify`) targets implicit prefix
//     caching on OpenAI/Kimi/DeepSeek/Codex; local backends do not hash
//     request prefixes, so the deep key-sort is pure CPU overhead.
//   - strict tool-schema normalization rewrites Anthropic schemas to the
//     `additionalProperties: false` shape required by Groq/Azure; local
//     llama.cpp/vLLM accept either form, so the recursive walk is wasted.
//   - tool-result compression tiers tool_result blocks for stateless cloud
//     providers; on a single-user local box where the conversation lives
//     in RAM, the tier-walk is wasted unless the user opts back in.
//
// Issue #1016 traced cumulative client-side overhead as the dominant cause
// of v0.5+ regressions against ~45 tok/s local models: against a 200ms cloud
// API the layers are invisible, but against multi-second local round-trips
// they multiply per-call.
//
// Set `OPENCLAUDE_LOCAL_FAST_PATH=1` to force it on, `=0` to force off, or
// leave it unset to let `isLocalProviderUrl` decide. The opt-out is intended
// to be conservative: if the env var is set explicitly, callers can audit
// regressions; if not, behaviour only changes for hosts already classified
// as local by the existing detector (loopback, RFC1918, .local, ULA/LL).
const LOCAL_FAST_PATH_ENV = 'OPENCLAUDE_LOCAL_FAST_PATH'

export type LocalFastPathConfig = {
  enabled: boolean
  skipStableStringify: boolean
  skipStrictTools: boolean
  skipToolHistoryCompression: boolean
}

const LOCAL_FAST_PATH_OFF: LocalFastPathConfig = {
  enabled: false,
  skipStableStringify: false,
  skipStrictTools: false,
  skipToolHistoryCompression: false,
}

const LOCAL_FAST_PATH_ON: LocalFastPathConfig = {
  enabled: true,
  skipStableStringify: true,
  skipStrictTools: true,
  skipToolHistoryCompression: true,
}

function parseLocalFastPathOverride(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined
  const v = raw.trim().toLowerCase()
  if (v === '' || v === 'auto') return undefined
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true
  return undefined
}

export function getLocalFastPathConfig(
  baseUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): LocalFastPathConfig {
  const override = parseLocalFastPathOverride(env[LOCAL_FAST_PATH_ENV])
  const enabled = override ?? isLocalProviderUrl(baseUrl)
  return enabled ? LOCAL_FAST_PATH_ON : LOCAL_FAST_PATH_OFF
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function normalizePathWithV1(pathname: string): string {
  const trimmed = trimTrailingSlash(pathname)
  if (!trimmed || trimmed === '/') {
    return '/v1'
  }

  if (trimmed.toLowerCase().endsWith('/v1')) {
    return trimmed
  }

  return `${trimmed}/v1`
}

export function isLikelyOllamaEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    const parsed = new URL(baseUrl)
    const hostname = parsed.hostname.toLowerCase()
    const pathname = parsed.pathname.toLowerCase()

    if (parsed.port === '11434') {
      return true
    }

    return (
      hostname.includes('ollama') ||
      pathname.includes('ollama')
    )
  } catch {
    return false
  }
}

export function isDirectLocalOllamaEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    const parsed = new URL(baseUrl)
    let hostname = parsed.hostname.toLowerCase()
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      hostname = hostname.slice(1, -1)
    }
    const ipv4Octets = hostname.split('.')
    const isLoopbackIpv4 =
      ipv4Octets.length === 4 &&
      ipv4Octets.every(octet => /^\d{1,3}$/.test(octet) && Number(octet) <= 255) &&
      ipv4Octets[0] === '127'
    return (
      parsed.protocol === 'http:' &&
      parsed.port === '11434' &&
      (
        hostname === 'localhost' ||
        hostname === '::1' ||
        isLoopbackIpv4
      )
    )
  } catch {
    return false
  }
}

export function getLocalProviderRetryBaseUrls(baseUrl: string): string[] {
  if (!isLocalProviderUrl(baseUrl)) {
    return []
  }

  try {
    const parsed = new URL(baseUrl)
    const original = trimTrailingSlash(parsed.toString())
    const seen = new Set<string>([original])
    const candidates: string[] = []

    const addCandidate = (hostname: string, pathname: string): void => {
      const next = new URL(parsed.toString())
      next.hostname = hostname
      next.pathname = pathname
      next.search = ''
      next.hash = ''

      const normalized = trimTrailingSlash(next.toString())
      if (seen.has(normalized)) {
        return
      }

      seen.add(normalized)
      candidates.push(normalized)
    }

    const v1Pathname = normalizePathWithV1(parsed.pathname)
    if (v1Pathname !== trimTrailingSlash(parsed.pathname)) {
      addCandidate(parsed.hostname, v1Pathname)
    }

    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (hostname === 'localhost' || hostname === '::1') {
      addCandidate('127.0.0.1', parsed.pathname || '/')
      addCandidate('127.0.0.1', v1Pathname)
    }

    return candidates
  } catch {
    return []
  }
}

export function shouldAttemptLocalToollessRetry(options: {
  baseUrl: string
  hasTools: boolean
}): boolean {
  if (!options.hasTools) {
    return false
  }

  if (!isLocalProviderUrl(options.baseUrl)) {
    return false
  }

  return isLikelyOllamaEndpoint(options.baseUrl)
}

export function isCodexBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    const parsed = new URL(baseUrl)
    return (
      parsed.hostname === 'chatgpt.com' &&
      parsed.pathname.replace(/\/+$/, '') === '/backend-api/codex'
    )
  } catch {
    return false
  }
}

function normalizeGithubModelSegment(requestedModel: string): string {
  const noQuery = requestedModel.split('?', 1)[0] ?? requestedModel
  const trimmed = noQuery.trim()
  const lower = trimmed.toLowerCase()
  if (lower.startsWith('github:copilot:')) {
    return trimmed.slice('github:copilot:'.length).trim()
  }
  if (lower.startsWith('github:')) {
    return trimmed.slice('github:'.length).trim()
  }
  if (lower.startsWith('copilot:')) {
    return trimmed.slice('copilot:'.length).trim()
  }
  return trimmed
}

/**
 * Normalize user model string for GitHub Copilot API inference.
 * Mirrors how Copilot resolves model IDs internally.
 */
export function normalizeGithubCopilotModel(requestedModel: string): string {
  const segment = normalizeGithubModelSegment(requestedModel)
  if (!segment || segment.toLowerCase() === 'copilot') {
    return DEFAULT_GITHUB_MODELS_API_MODEL
  }
  // Strip provider prefix if present (e.g., "openai/gpt-4o" -> "gpt-4o")
  const slashIndex = segment.indexOf('/')
  if (slashIndex !== -1) {
    return segment.slice(slashIndex + 1)
  }
  return segment
}

/**
 * Normalize user model string for GitHub Models API inference.
 * Only normalizes the default alias, preserves provider-qualified models.
 */
export function normalizeGithubModelsApiModel(requestedModel: string): string {
  const segment = normalizeGithubModelSegment(requestedModel)
  // Only normalize the default alias for GitHub Models
  if (!segment || segment.toLowerCase() === 'copilot') {
    return DEFAULT_GITHUB_MODELS_API_MODEL
  }
  // Preserve provider prefix for GitHub Models (e.g., "openai/gpt-4.1" stays as-is)
  return segment
}

export const GITHUB_COPILOT_BASE_URL = 'https://api.githubcopilot.com'
export const GITHUB_MODELS_BASE_URL = 'https://models.github.ai/inference'

/**
 * Returns the GitHub endpoint type for a given base URL.
 *
 * - 'copilot': standard GitHub Copilot API (api.githubcopilot.com)
 * - 'models': GitHub Models API (models.github.ai)
 * - 'ghe': GitHub Enterprise Server instance (*.ghe.com or custom GHE URL)
 * - 'custom': any other custom URL
 */
export function getGithubEndpointType(
  baseUrl: string | undefined,
  options?: { githubEnterpriseUrl?: string },
): 'copilot' | 'models' | 'ghe' | 'custom' {
  if (!baseUrl) return 'copilot'
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase()
    if (hostname === 'api.githubcopilot.com') {
      return 'copilot'
    }
    if (hostname === 'models.github.ai' || hostname.endsWith('.github.ai')) {
      return 'models'
    }
    // Detect GitHub Enterprise Server instances:
    // - *.ghe.com (GitHub's hosted GHE domains)
    // - *.github.com (but not api.github.com or models.github.ai)
    // - Any host when GITHUB_ENTERPRISE_URL is set
    if (
      hostname.endsWith('.ghe.com') ||
      (hostname.endsWith('.github.com') &&
        hostname !== 'api.github.com' &&
        hostname !== 'models.github.com')
    ) {
      return 'ghe'
    }
    // Check if GITHUB_ENTERPRISE_URL env var points to this host
    const gheUrl = options?.githubEnterpriseUrl ?? process.env.GITHUB_ENTERPRISE_URL
    if (gheUrl) {
      try {
        const gheHostname = new URL(gheUrl).hostname.toLowerCase()
        if (hostname === gheHostname) {
          return 'ghe'
        }
      } catch {
        // Ignore invalid GITHUB_ENTERPRISE_URL
      }
    }
    return 'custom'
  } catch {
    return 'copilot'
  }
}

/**
 * Get the GitHub Enterprise URL from environment or base URL.
 * Returns undefined if not in GHE mode.
 */
export function getGithubEnterpriseUrl(
  baseUrl?: string,
): string | undefined {
  // Explicit env var takes precedence
  const envUrl = asGithubEnterpriseEnvUrl(process.env.GITHUB_ENTERPRISE_URL)
  if (envUrl) return envUrl

  // If base URL indicates GHE, derive the enterprise URL from it
  if (baseUrl) {
    const endpointType = getGithubEndpointType(baseUrl)
    if (endpointType === 'ghe') {
      try {
        const parsed = new URL(baseUrl)
        return parsed.origin
      } catch {
        // Ignore invalid URL
      }
    }
  }

  return undefined
}

/**
 * Build the Copilot API base URL for a GitHub Enterprise instance.
 * For GHE, the Copilot API is at {ghe_url}/api/copilot
 */
export function buildGithubEnterpriseCopilotBaseUrl(
  gheUrl: string,
): string {
  try {
    return `${new URL(gheUrl.trim()).origin}/api/copilot`
  } catch {
    const normalized = gheUrl.replace(/\/+$/, '')
    return `${normalized}/api/copilot`
  }
}

export function resolveProviderRequest(options?: {
  model?: string
  baseUrl?: string
  fallbackModel?: string
  reasoningEffortOverride?: ReasoningEffort
  apiFormat?: OpenAICompatibleApiFormat | string
  processEnv?: NodeJS.ProcessEnv
}): ResolvedProviderRequest {
  const processEnv = options?.processEnv ?? process.env
  const isGithubMode = isEnvTruthy(processEnv.CLAUDE_CODE_USE_GITHUB)
  const isMistralMode = isEnvTruthy(processEnv.CLAUDE_CODE_USE_MISTRAL)
  const isGeminiMode = isEnvTruthy(processEnv.CLAUDE_CODE_USE_GEMINI)
  const isClinePassMode = Boolean(processEnv.CLINE_API_KEY?.trim())
  const isApismartMode = hasUsableOpenAICredential(processEnv.APISMART_API_KEY)
  const explicitBaseUrl = asEnvUrl(options?.baseUrl)

  const normalizedMistralEnvBaseUrl = asNamedEnvUrl(
    processEnv.MISTRAL_BASE_URL,
    'MISTRAL_BASE_URL',
  )

  const normalizedGeminiEnvBaseUrl = asNamedEnvUrl(
    processEnv.GEMINI_BASE_URL,
    'GEMINI_BASE_URL',
  )

  const primaryEnvBaseUrl = isMistralMode
    ? normalizedMistralEnvBaseUrl
    : isGeminiMode
    ? normalizedGeminiEnvBaseUrl
    : asNamedEnvUrl(processEnv.OPENAI_BASE_URL, 'OPENAI_BASE_URL')

  // In Mistral mode, a literal "undefined" MISTRAL_BASE_URL is treated as
  // misconfiguration and falls back to OPENAI_API_BASE, then
  // DEFAULT_MISTRAL_BASE_URL for a safe default endpoint.
  const fallbackEnvBaseUrl = isMistralMode
    ? (primaryEnvBaseUrl === undefined
      ? asNamedEnvUrl(processEnv.OPENAI_API_BASE, 'OPENAI_API_BASE') ?? DEFAULT_MISTRAL_BASE_URL
      : undefined)
    : isGeminiMode
    ? (primaryEnvBaseUrl === undefined
      ? asNamedEnvUrl(processEnv.OPENAI_API_BASE, 'OPENAI_API_BASE') ?? DEFAULT_GEMINI_BASE_URL
      : undefined)
    : (primaryEnvBaseUrl === undefined
      ? asNamedEnvUrl(processEnv.OPENAI_API_BASE, 'OPENAI_API_BASE')
      : undefined)

  // ClinePass model selection is only valid when no concrete non-ClinePass
  // base URL is explicitly provided via options or env. This prevents stale
  // CLINE_API_KEY/CLINE_API_MODEL from overriding an explicit OPENAI_BASE_URL
  // pointing at a different provider.
  const concreteBaseUrlBeforeDefault =
    explicitBaseUrl ?? primaryEnvBaseUrl ?? fallbackEnvBaseUrl
  const hasConcreteNonClinePassBaseUrl =
    Boolean(concreteBaseUrlBeforeDefault) && !isClinePassBaseUrl(concreteBaseUrlBeforeDefault)
  const hasConcreteClinePassBaseUrl =
    Boolean(concreteBaseUrlBeforeDefault) && isClinePassBaseUrl(concreteBaseUrlBeforeDefault)
  const effectiveClinePassMode =
    isClinePassMode &&
    // With no endpoint identity, ApiSmart wins the ambiguous dedicated-key
    // case. An explicit ClinePass endpoint is authoritative, however: an
    // ambient ApiSmart key must not suppress CLINE_API_MODEL for that route.
    (!isApismartMode || hasConcreteClinePassBaseUrl) &&
    !isGithubMode &&
    !hasConcreteNonClinePassBaseUrl
  const clinePassDefaultModel = effectiveClinePassMode
    ? getRouteDefaultModel('clinepass')
    : undefined

  // ApiSmart model selection is only valid when no concrete non-ApiSmart
  // base URL is explicitly provided via options or env. This prevents stale
  // APISMART_API_KEY/APISMART_MODEL from overriding an explicit OPENAI_BASE_URL
  // pointing at a different provider.
  const hasConcreteNonApismartBaseUrl =
    Boolean(concreteBaseUrlBeforeDefault) &&
    !isApismartBaseUrl(concreteBaseUrlBeforeDefault)
  const effectiveApismartMode =
    isApismartMode && !isGithubMode && !hasConcreteNonApismartBaseUrl
  const apismartDefaultModel = effectiveApismartMode
    ? getRouteDefaultModel('apismart')
    : undefined

  const requestedModel =
    options?.model?.trim() ||
    (isMistralMode
      ? processEnv.MISTRAL_MODEL?.trim()
      : isGeminiMode
        ? processEnv.GEMINI_MODEL?.trim()
        : effectiveClinePassMode
          ? processEnv.CLINE_API_MODEL?.trim() ||
            processEnv.OPENAI_MODEL?.trim()
          : effectiveApismartMode
            ? asUsableModelEnvValue(processEnv.APISMART_MODEL) ||
              asUsableModelEnvValue(processEnv.OPENAI_MODEL)
            : processEnv.OPENAI_MODEL?.trim()) ||
    options?.fallbackModel?.trim() ||
    (isGeminiMode ? DEFAULT_GEMINI_MODEL : undefined) ||
    clinePassDefaultModel ||
    apismartDefaultModel ||
    (isGithubMode ? 'github:copilot' : 'codexplan')
  const descriptor = parseModelDescriptor(requestedModel)

  const envBaseUrlRaw =
    explicitBaseUrl ??
    primaryEnvBaseUrl ??
    fallbackEnvBaseUrl ??
    (effectiveClinePassMode ? DEFAULT_CLINEPASS_API_BASE_URL : undefined) ??
    (effectiveApismartMode
      ? getRouteDefaultBaseUrl('apismart') ?? undefined
      : undefined)

  const githubEnterpriseEnvUrl = asGithubEnterpriseEnvUrl(
    processEnv.GITHUB_ENTERPRISE_URL,
  )
  const isCodexModelForGithub = isGithubMode && isCodexAlias(requestedModel)
  const envBaseUrl =
    isCodexModelForGithub &&
    envBaseUrlRaw &&
    getGithubEndpointType(envBaseUrlRaw, {
      githubEnterpriseUrl: githubEnterpriseEnvUrl,
    }) === 'custom'
      ? undefined
      : envBaseUrlRaw

  const rawBaseUrl = explicitBaseUrl ?? envBaseUrl

  const shellModel = processEnv.OPENAI_MODEL?.trim() ?? ''
  const envIsCodexShortcut = isOpenAICodexShortcutAlias(shellModel)
  const envResolvedCodexModel = envIsCodexShortcut
    ? parseModelDescriptor(shellModel).baseModel
    : null
  const requestedMatchesEnvCodexShortcut =
    Boolean(options?.model) &&
    Boolean(envResolvedCodexModel) &&
    descriptor.baseModel === envResolvedCodexModel
  const isCodexAliasModel =
    isOpenAICodexShortcutAlias(requestedModel) || requestedMatchesEnvCodexShortcut
  const hasUserSetBaseUrl = rawBaseUrl && rawBaseUrl !== DEFAULT_OPENAI_BASE_URL
  const finalBaseUrlRaw =
    !isGithubMode && isCodexAliasModel && !hasUserSetBaseUrl
      ? DEFAULT_CODEX_BASE_URL
      : rawBaseUrl
  const finalBaseUrl = normalizeGitlawbOpengatewayBaseUrl(finalBaseUrlRaw)

  const gheUrl = githubEnterpriseEnvUrl
  const githubEndpointType = isGithubMode
    ? (gheUrl && !rawBaseUrl
      ? 'ghe'
      : getGithubEndpointType(rawBaseUrl, { githubEnterpriseUrl: gheUrl }))
    : 'custom'
  const isGithubCopilot = isGithubMode && githubEndpointType === 'copilot'
  const isGithubModels = isGithubMode && githubEndpointType === 'models'
  const isGithubGhe = isGithubMode && githubEndpointType === 'ghe'
  const isGithubCustom = isGithubMode && githubEndpointType === 'custom'
  const isGithubCopilotLike = isGithubCopilot || isGithubGhe

  const githubResolvedModel = isGithubMode
    ? normalizeGithubModelsApiModel(requestedModel)
    : requestedModel

  // For GitHub Copilot API, normalize to real model ID (e.g., "github:copilot" -> "gpt-4o")
  // For GitHub Models/custom endpoints:
  //   - Normalize default alias (github:copilot -> gpt-4o)
  //   - Preserve provider-qualified models (openai/gpt-4.1 stays as-is)
  const resolvedModel = isGithubCopilotLike
    ? normalizeGithubCopilotModel(descriptor.baseModel)
    : (isGithubModels || isGithubCustom || isGithubGhe
      ? normalizeGithubModelsApiModel(descriptor.baseModel)
      : resolveRouteCatalogAliasApiName({
          model: descriptor.baseModel,
          baseUrl: finalBaseUrl,
          processEnv,
        }))

  // For GHE instances, build the Copilot API base URL from either
  // GITHUB_ENTERPRISE_URL or an already-classified GHE OPENAI_BASE_URL.
  const gheBaseUrl = isGithubGhe ? (gheUrl ?? rawBaseUrl) : undefined
  const gheCopilotBaseUrl = gheBaseUrl
    ? buildGithubEnterpriseCopilotBaseUrl(gheBaseUrl)
    : undefined

  const runtimeShimContext =
    isGithubMode
      ? null
      : resolveOpenAIShimRuntimeContext({
          processEnv,
          baseUrl: finalBaseUrl,
          model: resolvedModel,
          treatAsLocal: finalBaseUrl ? isLocalProviderUrl(finalBaseUrl) : false,
        })
  const explicitBaseUrlRuntimeContext =
    isGithubMode
      ? null
      : resolveOpenAIShimRuntimeContext({
          processEnv,
          baseUrl: finalBaseUrl,
          model: resolvedModel,
          treatAsLocal: finalBaseUrl ? isLocalProviderUrl(finalBaseUrl) : false,
          preferBaseUrlRoute: true,
        })
  const explicitApiFormat =
    isGithubMode
      ? undefined
      : parseOpenAICompatibleApiFormat(options?.apiFormat) ??
        parseOpenAICompatibleApiFormat(processEnv.OPENAI_API_FORMAT)
  const requiredApiFormat =
    isGithubMode
      ? undefined
      : parseOpenAICompatibleApiFormat(runtimeShimContext?.openaiShimConfig.requiredApiFormat)
  // An explicitly required chat-completions route cannot be switched to a
  // different endpoint. Other catalog-required formats retain their existing
  // precedence over an absent or chat-completions selection.
  const autoResponsesApiFormat =
    !isGithubMode &&
    explicitApiFormat === undefined &&
    requiredApiFormat === undefined &&
    modelRequiresResponsesApi(resolvedModel) &&
    baseUrlSupportsResponsesAutoRoute(finalBaseUrl, processEnv)
      ? ('responses' as const)
      : undefined
  const requestedApiFormat =
    requiredApiFormat === 'chat_completions'
      ? requiredApiFormat
      : requiredApiFormat &&
          (explicitApiFormat === undefined || explicitApiFormat === 'chat_completions')
        ? requiredApiFormat
        : explicitApiFormat ??
          autoResponsesApiFormat ??
          parseOpenAICompatibleApiFormat(runtimeShimContext?.openaiShimConfig.defaultApiFormat)
  const supportsRequestedApiFormat =
    (requestedApiFormat !== 'responses' && requestedApiFormat !== 'responses_compat') ||
    openAIShimSupportsApiFormatForModel(
      runtimeShimContext?.openaiShimConfig,
      'responses',
      resolvedModel,
    )
  const transport: ProviderTransport =
    shouldUseCodexTransport(requestedModel, finalBaseUrl) ||
      (isGithubCopilotLike && shouldUseGithubResponsesApi(githubResolvedModel))
      ? 'codex_responses'
      : (requestedApiFormat === 'responses' || requestedApiFormat === 'responses_compat') && supportsRequestedApiFormat
        ? requestedApiFormat
        : 'chat_completions'

  // Explicit gpt-5.6 alias defaults are Codex-transport-only: off the Codex
  // transport the 5.6 family's effort metadata is owned by the route catalog
  // (#1961), and an OPENAI_API_BASE gateway must not inherit the first-party
  // default. Explicit picks (the /effort override or a ?reasoning= query)
  // still flow on every transport, and codexplan keeps its existing behavior
  // of carrying its high default effort everywhere.
  const requestedReasoning = options?.reasoningEffortOverride
    ? { effort: options.reasoningEffortOverride }
    : descriptor.reasoningFromAlias &&
        transport !== 'codex_responses' &&
        /^gpt-5\.6(?:-|$|[?[])/i.test(requestedModel.trim())
      ? undefined
      : descriptor.reasoning
  const catalogReasoningLevels =
    explicitBaseUrlRuntimeContext?.catalogEntry?.modelDescriptorId === 'k3' &&
    explicitBaseUrlRuntimeContext.catalogEntry.reasoning?.wireFormat === 'reasoning_effort'
      ? explicitBaseUrlRuntimeContext.catalogEntry.reasoning.levels
      : undefined
  const isK3 = catalogReasoningLevels?.includes('max') &&
    explicitBaseUrlRuntimeContext?.catalogEntry?.modelDescriptorId === 'k3'
  const normalizedReasoning =
    isK3 && requestedReasoning?.effort !== undefined
      ? { effort: KIMI_K3_REASONING_ALIASES[requestedReasoning.effort] }
      : requestedReasoning
  const supportsMaxReasoning =
    catalogReasoningLevels?.includes('max') === true
  const reasoning =
    (normalizedReasoning?.effort === 'max' && !supportsMaxReasoning) ||
      (catalogReasoningLevels !== undefined &&
        normalizedReasoning?.effort !== undefined &&
        !catalogReasoningLevels.includes(normalizedReasoning.effort))
      ? undefined
      : normalizedReasoning

  return {
    transport,
    requestedModel,
    resolvedModel,
    baseUrl:
      // For GHE instances, use the GHE Copilot API URL even when a profile
      // stores the Enterprise origin as OPENAI_BASE_URL.
      ((isGithubGhe && gheCopilotBaseUrl
        ? gheCopilotBaseUrl
        : (finalBaseUrl ??
          (isGithubCopilot && transport === 'codex_responses'
            ? GITHUB_COPILOT_BASE_URL
            : (isGithubMode
              ? GITHUB_COPILOT_BASE_URL
              : DEFAULT_OPENAI_BASE_URL))))
      ).replace(/\/+$/, ''),
    reasoning,
    thinking: descriptor.thinking,
  }
}

export function getAdditionalModelOptionsCacheScope(): string | null {
  if (!isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI)) {
    if (!isEnvTruthy(process.env.CLAUDE_CODE_USE_GEMINI) &&
        !isEnvTruthy(process.env.CLAUDE_CODE_USE_MISTRAL) &&
        !isEnvTruthy(process.env.CLAUDE_CODE_USE_GITHUB) &&
        !isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) &&
        !isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) &&
        !isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)) {
      return 'firstParty'
    }
    return null
  }

  const request = resolveProviderRequest()
  if (request.transport !== 'chat_completions') {
    return null
  }

  if (!isLocalProviderUrl(request.baseUrl)) {
    return null
  }

  const partition = hashCacheScopePartition({
    apiKeys: normalizeCacheScopeHeaderValue(process.env.OPENAI_API_KEYS),
    apiKey: normalizeCacheScopeHeaderValue(process.env.OPENAI_API_KEY),
    authHeader: normalizeCacheScopeHeaderValue(process.env.OPENAI_AUTH_HEADER).toLowerCase(),
    authScheme: normalizeCacheScopeHeaderValue(process.env.OPENAI_AUTH_SCHEME).toLowerCase(),
    authHeaderValue: normalizeCacheScopeHeaderValue(process.env.OPENAI_AUTH_HEADER_VALUE),
    customHeaders: normalizeCacheScopeHeaderValue(process.env.ANTHROPIC_CUSTOM_HEADERS),
  })

  return `openai:${request.baseUrl.toLowerCase()}:${partition}`
}

export function resolveCodexAuthPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = asTrimmedString(env.CODEX_AUTH_JSON_PATH)
  if (explicit) return explicit

  const codexHome = asTrimmedString(env.CODEX_HOME)
  if (codexHome) return join(codexHome, 'auth.json')

  return join(homedir(), '.codex', 'auth.json')
}

function loadCodexAuthJson(
  authPath: string,
): Record<string, unknown> | undefined {
  if (!existsSync(authPath)) return undefined
  try {
    const raw = readFileSync(authPath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function resolveCodexAuthJsonCredentials(options: {
  authJson: Record<string, unknown> | undefined
  authPath: string
  envAccountId?: string
  missingSource?: ResolvedCodexCredentials['source']
}): ResolvedCodexCredentials {
  const { authJson, authPath, envAccountId } = options

  if (!authJson) {
    return {
      apiKey: '',
      authPath,
      source: options.missingSource ?? 'none',
    }
  }

  const apiKey = readNestedString(authJson, [
    ['openai_api_key'],
    ['openaiApiKey'],
    ['access_token'],
    ['accessToken'],
    ['tokens', 'access_token'],
    ['tokens', 'accessToken'],
    ['auth', 'access_token'],
    ['auth', 'accessToken'],
    ['token', 'access_token'],
    ['token', 'accessToken'],
  ])
  // OIDC identity tokens can carry the ChatGPT account id, but they are not
  // valid bearer credentials for Codex API requests.
  const idToken = readNestedString(authJson, [
    ['id_token'],
    ['idToken'],
    ['tokens', 'id_token'],
    ['tokens', 'idToken'],
  ])
  const accountId =
    envAccountId ??
    readNestedString(authJson, [
      ['account_id'],
      ['accountId'],
      ['tokens', 'account_id'],
      ['tokens', 'accountId'],
      ['auth', 'account_id'],
      ['auth', 'accountId'],
    ]) ??
    parseChatgptAccountId(apiKey) ??
    parseChatgptAccountId(idToken)

  if (!apiKey) {
    return {
      apiKey: '',
      accountId,
      authPath,
      source: options.missingSource ?? 'none',
    }
  }

  return {
    apiKey,
    accountId,
    authPath,
    source: 'auth.json',
  }
}

export function resolveStoredCodexCredentials(options: {
  storedCredentials: Pick<
    CodexCredentialBlob,
    'apiKey' | 'accessToken' | 'idToken' | 'accountId'
  >
  envAccountId?: string
}): ResolvedCodexCredentials {
  const { storedCredentials, envAccountId } = options

  return {
    apiKey: storedCredentials.apiKey ?? storedCredentials.accessToken,
    accountId:
      envAccountId ??
      storedCredentials.accountId ??
      parseChatgptAccountId(storedCredentials.idToken) ??
      parseChatgptAccountId(storedCredentials.accessToken),
    source: 'secure-storage',
  }
}

function resolveEnvOrAuthJsonCodexCredentials(
  env: NodeJS.ProcessEnv,
  options?: {
    explicitAuthPathOnly?: boolean
  },
): ResolvedCodexCredentials {
  const envApiKey = asTrimmedString(env.CODEX_API_KEY)
  const envAccountId =
    asTrimmedString(env.CODEX_ACCOUNT_ID) ??
    asTrimmedString(env.CHATGPT_ACCOUNT_ID)

  if (envApiKey) {
    return {
      apiKey: envApiKey,
      accountId: envAccountId ?? parseChatgptAccountId(envApiKey),
      source: 'env',
    }
  }

  const explicitAuthPathConfigured = Boolean(
    asTrimmedString(env.CODEX_AUTH_JSON_PATH) ?? asTrimmedString(env.CODEX_HOME),
  )

  if (!explicitAuthPathConfigured && options?.explicitAuthPathOnly) {
    return {
      apiKey: '',
      accountId: envAccountId,
      source: 'none',
    }
  }

  const authPath = resolveCodexAuthPath(env)
  const authJson = loadCodexAuthJson(authPath)
  return resolveCodexAuthJsonCredentials({
    authJson,
    authPath,
    envAccountId,
  })
}

export function resolveRuntimeCodexCredentials(options?: {
  env?: NodeJS.ProcessEnv
  storedCredentials?: Pick<
    CodexCredentialBlob,
    'apiKey' | 'accessToken' | 'idToken' | 'accountId'
  >
}): ResolvedCodexCredentials {
  const env = options?.env ?? process.env
  const explicitCredentials = resolveEnvOrAuthJsonCodexCredentials(env, {
    explicitAuthPathOnly: true,
  })
  const explicitAuthPathConfigured = Boolean(
    asTrimmedString(env.CODEX_AUTH_JSON_PATH) ?? asTrimmedString(env.CODEX_HOME),
  )
  const hasStoredCredentialsOption = Boolean(
    options &&
      Object.prototype.hasOwnProperty.call(options, 'storedCredentials'),
  )

  if (
    explicitAuthPathConfigured ||
    explicitCredentials.source === 'env' ||
    explicitCredentials.source === 'auth.json'
  ) {
    return explicitCredentials
  }

  if (options?.storedCredentials?.accessToken) {
    return resolveStoredCodexCredentials({
      storedCredentials: options.storedCredentials,
      envAccountId:
        asTrimmedString(env.CODEX_ACCOUNT_ID) ??
        asTrimmedString(env.CHATGPT_ACCOUNT_ID),
    })
  }

  if (hasStoredCredentialsOption) {
    return resolveEnvOrAuthJsonCodexCredentials(env)
  }

  return resolveCodexApiCredentials(env)
}

export function resolveCodexApiCredentials(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCodexCredentials {
  const envAccountId =
    asTrimmedString(env.CODEX_ACCOUNT_ID) ??
    asTrimmedString(env.CHATGPT_ACCOUNT_ID)
  const envOrExplicitAuthJsonCredentials = resolveEnvOrAuthJsonCodexCredentials(
    env,
    {
      explicitAuthPathOnly: true,
    },
  )

  if (
    envOrExplicitAuthJsonCredentials.source === 'env' ||
    envOrExplicitAuthJsonCredentials.source === 'auth.json' ||
    envOrExplicitAuthJsonCredentials.authPath
  ) {
    return envOrExplicitAuthJsonCredentials
  }

  const storedCredentials = readCodexCredentials()
  if (storedCredentials?.accessToken) {
    const resolvedStoredCredentials = resolveStoredCodexCredentials({
      storedCredentials,
      envAccountId,
    })

    const shouldCheckDefaultAuthJson =
      !resolvedStoredCredentials.accountId ||
      isCodexRefreshFailureCoolingDown(storedCredentials)

    if (!shouldCheckDefaultAuthJson) {
      return resolvedStoredCredentials
    }

    const authPath = resolveCodexAuthPath(env)
    const authJson = loadCodexAuthJson(authPath)
    const resolvedAuthJsonCredentials = resolveCodexAuthJsonCredentials({
      authJson,
      authPath,
      envAccountId,
    })

    if (resolvedAuthJsonCredentials.apiKey) {
      return {
        ...resolvedAuthJsonCredentials,
        accountId:
          resolvedAuthJsonCredentials.accountId ??
          resolvedStoredCredentials.accountId,
      }
    }

    return resolvedStoredCredentials
  }

  return resolveEnvOrAuthJsonCodexCredentials(env)
}

export function getReasoningEffortForModel(model: string): ReasoningEffort | undefined {
  const normalized = model.trim().toLowerCase()
  const base = normalized.split('?', 1)[0] ?? normalized
  const alias = base as CodexAlias
  const aliasConfig = Object.hasOwn(CODEX_ALIAS_MODELS, alias)
    ? CODEX_ALIAS_MODELS[alias]
    : undefined
  return aliasConfig?.reasoningEffort
}

export function supportsCodexReasoningEffort(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  const base = normalized.split('?', 1)[0] ?? normalized

  if (base === 'gpt-5.3-codex-spark' || base === 'codexspark') {
    return false
  }

  if (getReasoningEffortForModel(base) !== undefined) {
    return true
  }

  return GPT5_FAMILY_RE.test(base)
}
