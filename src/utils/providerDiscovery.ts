import type { OllamaModelDescriptor } from './providerRecommendation.ts'
import { DEFAULT_OPENAI_BASE_URL } from '../services/api/providerConfig.js'
import {
  getRouteLabel,
  resolveRouteIdFromBaseUrl,
} from '../integrations/routeMetadata.js'

export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434'
export const DEFAULT_ATOMIC_CHAT_BASE_URL = 'http://127.0.0.1:1337'

export type OllamaGenerationReadiness = {
  state: 'ready' | 'unreachable' | 'no_models' | 'generation_failed'
  models: OllamaModelDescriptor[]
  probeModel?: string
  detail?: string
}

function withTimeoutSignal(timeoutMs: number): {
  signal: AbortSignal
  clear: () => void
} {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function compactDetail(value: string, maxLength = 180): string {
  const compact = value.trim().replace(/\s+/g, ' ')
  if (!compact) {
    return ''
  }

  if (compact.length <= maxLength) {
    return compact
  }

  return `${compact.slice(0, maxLength)}...`
}

type OllamaTagsPayload = {
  models?: Array<{
    name?: string
    size?: number
    details?: {
      family?: string
      families?: string[]
      parameter_size?: string
      quantization_level?: string
    }
  }>
}

function normalizeOllamaModels(
  payload: OllamaTagsPayload,
): OllamaModelDescriptor[] {
  return (payload.models ?? [])
    .filter(model => Boolean(model.name))
    .map(model => ({
      name: model.name!,
      sizeBytes: typeof model.size === 'number' ? model.size : null,
      family: model.details?.family ?? null,
      families: model.details?.families ?? [],
      parameterSize: model.details?.parameter_size ?? null,
      quantizationLevel: model.details?.quantization_level ?? null,
    }))
}

async function fetchOllamaModelsProbe(
  baseUrl?: string,
  timeoutMs = 5000,
): Promise<{
  reachable: boolean
  models: OllamaModelDescriptor[]
}> {
  const { signal, clear } = withTimeoutSignal(timeoutMs)
  try {
    const response = await fetch(`${getOllamaApiBaseUrl(baseUrl)}/api/tags`, {
      method: 'GET',
      signal,
    })

    if (!response.ok) {
      return {
        reachable: false,
        models: [],
      }
    }

    const payload = (await response.json().catch(() => ({}))) as OllamaTagsPayload
    return {
      reachable: true,
      models: normalizeOllamaModels(payload),
    }
  } catch {
    return {
      reachable: false,
      models: [],
    }
  } finally {
    clear()
  }
}

export async function probeOllamaModelCatalog(options?: {
  baseUrl?: string
  timeoutMs?: number
}): Promise<{
  reachable: boolean
  models: OllamaModelDescriptor[]
}> {
  return fetchOllamaModelsProbe(options?.baseUrl, options?.timeoutMs ?? 5000)
}

export function getOllamaApiBaseUrl(baseUrl?: string): string {
  const parsed = new URL(
    baseUrl || process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL,
  )
  const pathname = trimTrailingSlash(parsed.pathname)
  parsed.pathname = pathname.endsWith('/v1')
    ? pathname.slice(0, -3) || '/'
    : pathname || '/'
  parsed.search = ''
  parsed.hash = ''
  return trimTrailingSlash(parsed.toString())
}

export function getOllamaChatBaseUrl(baseUrl?: string): string {
  return `${getOllamaApiBaseUrl(baseUrl)}/v1`
}

export function getAtomicChatApiBaseUrl(baseUrl?: string): string {
  const parsed = new URL(
    baseUrl || process.env.ATOMIC_CHAT_BASE_URL || DEFAULT_ATOMIC_CHAT_BASE_URL,
  )
  const pathname = trimTrailingSlash(parsed.pathname)
  parsed.pathname = pathname.endsWith('/v1')
    ? pathname.slice(0, -3) || '/'
    : pathname || '/'
  parsed.search = ''
  parsed.hash = ''
  return trimTrailingSlash(parsed.toString())
}

export function getAtomicChatChatBaseUrl(baseUrl?: string): string {
  return `${getAtomicChatApiBaseUrl(baseUrl)}/v1`
}

export function getOpenAICompatibleModelsBaseUrl(baseUrl?: string): string {
  return (
    baseUrl || process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL
  ).replace(/\/+$/, '')
}

export function getOpenAICompatibleModelsUrl(
  baseUrl?: string,
  discoveryPath?: string,
): string {
  const resolvedBaseUrl = getOpenAICompatibleModelsBaseUrl(baseUrl)
  if (!discoveryPath?.trim()) {
    return `${resolvedBaseUrl}/models`
  }

  const parsedBaseUrl = new URL(resolvedBaseUrl)
  const resolvedUrl = new URL(
    discoveryPath.trim(),
    `${resolvedBaseUrl}/`,
  )
  if (resolvedUrl.origin !== parsedBaseUrl.origin) {
    throw new Error('Model discovery path must stay on the provider origin')
  }

  return resolvedUrl.toString()
}

export function getLocalOpenAICompatibleProviderLabel(baseUrl?: string): string {
  try {
    const parsed = new URL(getOpenAICompatibleModelsBaseUrl(baseUrl))
    const host = parsed.host.toLowerCase()
    const hostname = parsed.hostname.toLowerCase()
    const path = parsed.pathname.toLowerCase()
    const haystack = `${hostname} ${path}`

    if (
      host.endsWith(':1234') ||
      haystack.includes('lmstudio') ||
      haystack.includes('lm-studio')
    ) {
      return 'LM Studio'
    }
    if (host.endsWith(':11434') || haystack.includes('ollama')) {
      return 'Ollama'
    }
    if (haystack.includes('localai')) {
      return 'LocalAI'
    }
    if (haystack.includes('jan')) {
      return 'Jan'
    }
    if (haystack.includes('kobold')) {
      return 'KoboldCpp'
    }
    if (haystack.includes('llama.cpp') || haystack.includes('llamacpp')) {
      return 'llama.cpp'
    }
    if (haystack.includes('vllm')) {
      return 'vLLM'
    }
    if (
      haystack.includes('open-webui') ||
      haystack.includes('openwebui')
    ) {
      return 'Open WebUI'
    }
    if (
      haystack.includes('text-generation-webui') ||
      haystack.includes('oobabooga')
    ) {
      return 'text-generation-webui'
    }
    // Check for NVIDIA NIM
    if (host.includes('nvidia') || haystack.includes('nvidia') || host.includes('integrate.api.nvidia')) {
      return 'NVIDIA NIM'
    }
    // Check for MiniMax (both api.minimax.io and api.minimax.chat)
    if (host.includes('minimax') || haystack.includes('minimax')) {
      return 'MiniMax'
    }
    // Check for Xiaomi MiMo
    if (
      host.includes('xiaomimimo') ||
      haystack.includes('xiaomimimo') ||
      host.includes('mimo-v2') ||
      haystack.includes('mimo-v2')
    ) {
      return 'Xiaomi MiMo'
    }
    // Kimi Code subscription API
    if (hostname === 'api.kimi.com' && path.includes('/coding')) {
      return 'Moonshot AI - Kimi Code'
    }
    // Check for Bankr LLM gateway
    if (host.includes('bankr') || haystack.includes('bankr')) {
      return 'Bankr'
    }
    const routeId = resolveRouteIdFromBaseUrl(parsed.href)
    if (routeId && routeId !== 'custom' && routeId !== 'openai') {
      return getRouteLabel(routeId) ?? routeId
    }
    // Moonshot AI direct API
    if (
      host.includes('moonshot') ||
      haystack.includes('moonshot') ||
      haystack.includes('kimi')
    ) {
      return 'Moonshot AI - API'
    }
  } catch {
    // Fall back to the generic label when the base URL is malformed.
  }

  return 'Local OpenAI-compatible'
}

export async function hasLocalOllama(baseUrl?: string): Promise<boolean> {
  const { reachable } = await fetchOllamaModelsProbe(baseUrl, 1200)
  return reachable
}

export async function listOllamaModels(
  baseUrl?: string,
): Promise<OllamaModelDescriptor[]> {
  const { models } = await fetchOllamaModelsProbe(baseUrl, 5000)
  return models
}

export async function listOpenAICompatibleModels(options?: {
  baseUrl?: string
  apiKey?: string
  headers?: Record<string, string>
  path?: string
}): Promise<string[] | null> {
  const { signal, clear } = withTimeoutSignal(5000)
  try {
    const modelsUrl = getOpenAICompatibleModelsUrl(
      options?.baseUrl,
      options?.path,
    )
    const isBankr = modelsUrl.toLowerCase().includes('bankr')
    const headers = {
      ...(options?.headers ?? {}),
      ...(options?.apiKey
        ? isBankr
          ? { 'X-API-Key': options.apiKey }
          : { Authorization: `Bearer ${options.apiKey}` }
        : {}),
    }
    const response = await fetch(
      modelsUrl,
      {
        method: 'GET',
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        signal,
      },
    )
    if (!response.ok) {
      return null
    }

    const data = (await response.json()) as {
      data?: Array<{ id?: string }>
    }

    return Array.from(
      new Set(
        (data.data ?? [])
          .filter(model => Boolean(model.id))
          .map(model => model.id!),
      ),
    )
  } catch {
    return null
  } finally {
    clear()
  }
}

export async function fetchOpenAICompatibleModelsRaw(options?: {
  baseUrl?: string
  apiKey?: string
  headers?: Record<string, string>
  path?: string
}): Promise<Record<string, unknown>[] | null> {
  const { signal, clear } = withTimeoutSignal(5000)
  try {
    const modelsUrl = getOpenAICompatibleModelsUrl(
      options?.baseUrl,
      options?.path,
    )
    const isBankr = modelsUrl.toLowerCase().includes('bankr')
    const headers = {
      ...(options?.headers ?? {}),
      ...(options?.apiKey
        ? isBankr
          ? { 'X-API-Key': options.apiKey }
          : { Authorization: `Bearer ${options.apiKey}` }
        : {}),
    }
    const response = await fetch(modelsUrl, {
      method: 'GET',
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      signal,
    })
    if (!response.ok) {
      return null
    }

    const data = (await response.json()) as {
      data?: Array<Record<string, unknown>>
    }

    return data.data ?? null
  } catch {
    return null
  } finally {
    clear()
  }
}

export async function hasLocalAtomicChat(baseUrl?: string): Promise<boolean> {
  const { signal, clear } = withTimeoutSignal(1200)
  try {
    const response = await fetch(`${getAtomicChatChatBaseUrl(baseUrl)}/models`, {
      method: 'GET',
      signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    clear()
  }
}

export async function listAtomicChatModels(
  baseUrl?: string,
): Promise<string[]> {
  const { signal, clear } = withTimeoutSignal(5000)
  try {
    const response = await fetch(`${getAtomicChatChatBaseUrl(baseUrl)}/models`, {
      method: 'GET',
      signal,
    })
    if (!response.ok) {
      return []
    }

    const data = (await response.json()) as {
      data?: Array<{ id?: string }>
    }

    return (data.data ?? [])
      .filter(model => Boolean(model.id))
      .map(model => model.id!)
  } catch {
    return []
  } finally {
    clear()
  }
}

export type AtomicChatReadiness =
  | { state: 'unreachable' }
  | { state: 'no_models' }
  | { state: 'ready'; models: string[] }

export async function probeAtomicChatReadiness(options?: {
  baseUrl?: string
}): Promise<AtomicChatReadiness> {
  if (!(await hasLocalAtomicChat(options?.baseUrl))) {
    return { state: 'unreachable' }
  }
  const models = await listAtomicChatModels(options?.baseUrl)
  if (models.length === 0) {
    return { state: 'no_models' }
  }
  return { state: 'ready', models }
}

export async function benchmarkOllamaModel(
  modelName: string,
  baseUrl?: string,
): Promise<number | null> {
  const start = Date.now()
  const { signal, clear } = withTimeoutSignal(20000)
  try {
    const response = await fetch(`${getOllamaApiBaseUrl(baseUrl)}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal,
      body: JSON.stringify({
        model: modelName,
        stream: false,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        options: {
          temperature: 0,
          num_predict: 8,
        },
      }),
    })
    if (!response.ok) {
      return null
    }
    await response.json()
    return Date.now() - start
  } catch {
    return null
  } finally {
    clear()
  }
}

export async function probeOllamaGenerationReadiness(options?: {
  baseUrl?: string
  model?: string
  timeoutMs?: number
}): Promise<OllamaGenerationReadiness> {
  const timeoutMs = options?.timeoutMs ?? 8000
  const { reachable, models } = await fetchOllamaModelsProbe(
    options?.baseUrl,
    timeoutMs,
  )
  if (!reachable) {
    return {
      state: 'unreachable',
      models: [],
    }
  }

  if (models.length === 0) {
    return {
      state: 'no_models',
      models: [],
    }
  }

  const requestedModel = options?.model?.trim() || undefined
  if (requestedModel && !models.some(model => model.name === requestedModel)) {
    return {
      state: 'generation_failed',
      models,
      probeModel: requestedModel,
      detail: `requested model not installed: ${requestedModel}`,
    }
  }

  const probeModel = requestedModel ?? models[0]!.name
  const { signal, clear } = withTimeoutSignal(timeoutMs)

  try {
    const response = await fetch(`${getOllamaApiBaseUrl(options?.baseUrl)}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal,
      body: JSON.stringify({
        model: probeModel,
        stream: false,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        options: {
          temperature: 0,
          num_predict: 8,
        },
      }),
    })

    if (!response.ok) {
      const responseBody = await response.text().catch(() => '')
      const detailSuffix = compactDetail(responseBody)
      return {
        state: 'generation_failed',
        models,
        probeModel,
        detail: detailSuffix
          ? `status ${response.status}: ${detailSuffix}`
          : `status ${response.status}`,
      }
    }

    try {
      await response.json()
    } catch {
      return {
        state: 'generation_failed',
        models,
        probeModel,
        detail: 'invalid JSON response',
      }
    }

    return {
      state: 'ready',
      models,
      probeModel,
    }
  } catch (error) {
    const detail =
      error instanceof Error
        ? error.name === 'AbortError'
          ? 'request timed out'
          : error.message
        : String(error)

    return {
      state: 'generation_failed',
      models,
      probeModel,
      detail,
    }
  } finally {
    clear()
  }
}
