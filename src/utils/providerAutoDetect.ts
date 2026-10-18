/**
 * Zero-config provider autodetection.
 *
 * Scans the environment (API keys, OAuth tokens, stored credentials) and local
 * network (Ollama, LM Studio) to pick the best provider for first-run users
 * who have not explicitly configured one. Returns a structured detection
 * result that callers can consume to build a launch-ready profile env, or
 * null when nothing is detected — in which case the existing onboarding /
 * picker flow should take over.
 *
 * Detection priority (first match wins):
 *   1. ANTHROPIC_API_KEY → first-party Claude (most capable default)
 *   2. Codex: CODEX_API_KEY, CHATGPT_ACCOUNT_ID, or valid ~/.codex/auth.json
 *   3. GitHub Copilot: GITHUB_TOKEN or GH_TOKEN
 *   4. OPENAI_API_KEY / OPENAI_API_KEYS
 *   5. GEMINI_API_KEY or GOOGLE_API_KEY
 *   6. MISTRAL_API_KEY
 *   7. MINIMAX_API_KEY
 *   8. MIMO_API_KEY (Xiaomi Mimo)
 *   9. XAI_API_KEY
  *  10. NEARAI_API_KEY
  *  11. FIREWORKS_API_KEY
  *  12. LONGCAT_API_KEY
  *  13. Local Ollama reachable (default localhost:11434)
  *  14. Local LM Studio reachable (default localhost:1234)
 *
 * Local-service probes are parallelized and cheap (short timeout, no
 * request body). Env scans are synchronous and run first so we don't make
 * network calls when a credential is already present.
 *
 * This module intentionally does NOT decide whether to apply the detection;
 * callers should gate on hasExplicitProviderSelection() (providerProfile.ts)
 * and the presence of a persisted profile file.
 */

import { existsSync } from 'fs'
import { homedir } from 'os'
import { hasUsableOpenAICredential } from '../services/api/credentialPool.js'
import { join } from 'path'

export type DetectedProviderKind =
  | 'anthropic'
  | 'codex'
  | 'github'
  | 'openai'
  | 'gemini'
  | 'mistral'
  | 'minimax'
  | 'xiaomi-mimo'
  | 'xai'
  | 'nearai'
  | 'fireworks'
  | 'longcat'
  | 'ollama'
  | 'lm-studio'
  | 'gitlawb-opengateway'

export type DetectedProvider = {
  kind: DetectedProviderKind
  /** One-line human-readable reason, e.g. "ANTHROPIC_API_KEY set". */
  source: string
  /** Present when the detection already resolved a usable base URL. */
  baseUrl?: string
  /** Present when detection also narrowed down a specific model. */
  model?: string
}

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>

function envHasNonEmpty(env: EnvLike, key: string): boolean {
  const value = env[key]
  return typeof value === 'string' && value.trim().length > 0
}

function envHasUsableOpenAICredential(env: EnvLike, key: string): boolean {
  return hasUsableOpenAICredential(env[key])
}

function firstSet(env: EnvLike, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    if (envHasNonEmpty(env, key)) return key
  }
  return undefined
}

function firstOpenAICredentialSet(
  env: EnvLike,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    if (envHasUsableOpenAICredential(env, key)) return key
  }
  return undefined
}

function defaultHasCodexAuthFile(): boolean {
  const paths = [
    process.env.CODEX_AUTH_PATH,
    join(homedir(), '.codex', 'auth.json'),
  ]
  return paths.some(p => p && existsSync(p))
}

export type DetectProviderFromEnvOptions = {
  env?: EnvLike
  /**
   * Override Codex auth-file detection. Primarily for tests — the default
   * implementation checks ~/.codex/auth.json and CODEX_AUTH_PATH on disk.
   */
  hasCodexAuth?: () => boolean
}

/**
 * Synchronous env-only scan. Returns the highest-priority env-provided
 * provider, or null if nothing is present. Intentionally does not touch
 * the network — fast path for the common case where a user has exported
 * one of the standard API-key env vars.
 */
function isOptionsObject(
  value: EnvLike | DetectProviderFromEnvOptions | undefined,
): value is DetectProviderFromEnvOptions {
  if (!value || typeof value !== 'object') return false
  if ('hasCodexAuth' in value && typeof value.hasCodexAuth === 'function') {
    return true
  }
  if ('env' in value && typeof (value as { env?: unknown }).env === 'object') {
    return true
  }
  return false
}

export function detectProviderFromEnv(
  envOrOptions: EnvLike | DetectProviderFromEnvOptions = process.env,
): DetectedProvider | null {
  const options: DetectProviderFromEnvOptions = isOptionsObject(envOrOptions)
    ? envOrOptions
    : { env: envOrOptions as EnvLike }
  const env = options.env ?? process.env
  const hasCodexAuth = options.hasCodexAuth ?? defaultHasCodexAuthFile
  if (envHasNonEmpty(env, 'ANTHROPIC_API_KEY')) {
    return { kind: 'anthropic', source: 'ANTHROPIC_API_KEY set' }
  }

  if (
    envHasNonEmpty(env, 'CODEX_API_KEY') ||
    envHasNonEmpty(env, 'CHATGPT_ACCOUNT_ID') ||
    envHasNonEmpty(env, 'CODEX_ACCOUNT_ID') ||
    hasCodexAuth()
  ) {
    const sourceEnv =
      firstSet(env, ['CODEX_API_KEY', 'CHATGPT_ACCOUNT_ID', 'CODEX_ACCOUNT_ID'])
    return {
      kind: 'codex',
      source: sourceEnv ? `${sourceEnv} set` : '~/.codex/auth.json present',
    }
  }

  const githubKey = firstSet(env, ['GITHUB_TOKEN', 'GH_TOKEN'])
  if (githubKey) {
    return {
      kind: 'github',
      source: `${githubKey} set (GitHub Copilot)`,
    }
  }

  const openaiKey = firstOpenAICredentialSet(env, [
    'OPENAI_API_KEYS',
    'OPENAI_API_KEY',
  ])
  if (openaiKey) {
    return {
      kind: 'openai',
      source: `${openaiKey} set`,
      baseUrl: env.OPENAI_BASE_URL ?? env.OPENAI_API_BASE,
    }
  }

  const geminiKey = firstSet(env, ['GEMINI_API_KEY', 'GOOGLE_API_KEY'])
  if (geminiKey) {
    return { kind: 'gemini', source: `${geminiKey} set` }
  }

  if (envHasNonEmpty(env, 'MISTRAL_API_KEY')) {
    return { kind: 'mistral', source: 'MISTRAL_API_KEY set' }
  }

  if (envHasNonEmpty(env, 'MINIMAX_API_KEY')) {
    return { kind: 'minimax', source: 'MINIMAX_API_KEY set' }
  }

  if (envHasNonEmpty(env, 'MIMO_API_KEY')) {
    return { kind: 'xiaomi-mimo', source: 'MIMO_API_KEY set' }
  }

  if (envHasNonEmpty(env, 'XAI_API_KEY')) {
    return { kind: 'xai', source: 'XAI_API_KEY set' }
  }

  if (envHasNonEmpty(env, 'NEARAI_API_KEY')) {
    return {
      kind: 'nearai',
      source: 'NEARAI_API_KEY set',
    }
  }

  if (envHasNonEmpty(env, 'FIREWORKS_API_KEY')) {
    return {
      kind: 'fireworks',
      source: 'FIREWORKS_API_KEY set',
    }
  }

  if (envHasNonEmpty(env, 'LONGCAT_API_KEY')) {
    return {
      kind: 'longcat',
      source: 'LONGCAT_API_KEY set',
    }
  }

  return null
}

type LocalProbe = {
  kind: DetectedProviderKind
  url: string
  timeoutMs: number
  source: string
  baseUrl: string
}

const DEFAULT_LOCAL_PROBE_TIMEOUT_MS = 1200

async function probeReachable(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Returns the highest-priority local service reachable from the host.
 * Runs probes in parallel and picks by priority rather than first-response,
 * so slow-but-preferred services still win over fast-but-lower-priority ones.
 */
export async function detectLocalService(options?: {
  env?: EnvLike
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<DetectedProvider | null> {
  const env = options?.env ?? process.env
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch
  const timeoutMs = options?.timeoutMs ?? DEFAULT_LOCAL_PROBE_TIMEOUT_MS

  const ollamaBase = (env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(
    /\/+$/,
    '',
  )
  const lmStudioBase = (env.LM_STUDIO_BASE_URL ?? 'http://localhost:1234').replace(
    /\/+$/,
    '',
  )

  const probes: LocalProbe[] = [
    {
      kind: 'ollama',
      url: `${ollamaBase}/api/tags`,
      timeoutMs,
      source: `Ollama reachable at ${ollamaBase}`,
      baseUrl: ollamaBase,
    },
    {
      kind: 'lm-studio',
      url: `${lmStudioBase}/v1/models`,
      timeoutMs,
      source: `LM Studio reachable at ${lmStudioBase}`,
      baseUrl: lmStudioBase,
    },
  ]

  const results = await Promise.all(
    probes.map(async probe => ({
      probe,
      reachable: await probeReachable(probe.url, probe.timeoutMs, fetchImpl),
    })),
  )

  for (const { probe, reachable } of results) {
    if (reachable) {
      return {
        kind: probe.kind,
        source: probe.source,
        baseUrl: probe.baseUrl,
      }
    }
  }

  return null
}

/**
 * Orchestrator: env scan first (sync, free), then local-service probes
 * (async, ~1-2s worst case) only if nothing was found in env.
 */
const OPENGATEWAY_DEFAULT_BASE_URL = 'https://opengateway.gitlawb.com/v1'
const OPENGATEWAY_DEFAULT_MODEL = 'mimo-v2.5-pro'

function normalizeOpengatewayBaseUrl(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl)
    const hostname = parsed.hostname.toLowerCase()
    const path = parsed.pathname.replace(/\/+$/, '').toLowerCase()
    if (
      (hostname === 'opengateway.gitlawb.com' || hostname === 'opengateway.fly.dev') &&
      (path === '/v1/xiaomi-mimo' || path === '/v1/gmi-cloud')
    ) {
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

/**
 * Fallback: the Twigpine Opengateway exposes partner inference through a
 * smart OpenAI-compatible route. As of 2026-05-22 it requires a per-user API
 * key (signup at https://gitlawb.com/opengateway/keys); without a key we return
 * null so the caller surfaces the missing-credential prompt instead of
 * silently routing to an endpoint that will 401.
 */
function defaultOpengatewayProvider(env: EnvLike): DetectedProvider | null {
  const hasKey =
    (typeof env.OPENGATEWAY_API_KEY === 'string' && env.OPENGATEWAY_API_KEY.trim().length > 0) ||
    (typeof env.OPENAI_API_KEY === 'string' && env.OPENAI_API_KEY.trim().length > 0)
  if (!hasKey) return null

  const baseUrl =
    (typeof env.OPENGATEWAY_BASE_URL === 'string' && env.OPENGATEWAY_BASE_URL.trim()) ||
    OPENGATEWAY_DEFAULT_BASE_URL
  return {
    kind: 'gitlawb-opengateway',
    source:
      'Twigpine Opengateway (API key required, signup at https://gitlawb.com/opengateway/keys)',
    baseUrl: normalizeOpengatewayBaseUrl(baseUrl),
    model: OPENGATEWAY_DEFAULT_MODEL,
  }
}

export async function detectBestProvider(options?: {
  env?: EnvLike
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Skip local-service probes — useful for tests or offline smoke checks. */
  skipLocal?: boolean
  /** Override for Codex auth-file detection. See detectProviderFromEnv. */
  hasCodexAuth?: () => boolean
  /**
   * Disable the Twigpine Opengateway fallback. Returns null when no other
   * provider is detected. Use this in tests that need to assert "nothing found".
   */
  skipOpengatewayFallback?: boolean
}): Promise<DetectedProvider | null> {
  const env = options?.env ?? process.env

  const fromEnv = detectProviderFromEnv({
    env,
    hasCodexAuth: options?.hasCodexAuth,
  })
  if (fromEnv) return fromEnv

  if (!options?.skipLocal) {
    const local = await detectLocalService({
      env,
      fetchImpl: options?.fetchImpl,
      timeoutMs: options?.timeoutMs,
    })
    if (local) return local
  }

  if (options?.skipOpengatewayFallback) return null

  return defaultOpengatewayProvider(env)
}
