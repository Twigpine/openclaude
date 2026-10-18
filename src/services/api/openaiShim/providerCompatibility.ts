import { isEnvTruthy } from '../../../utils/envUtils.js'

export function isGithubModelsMode(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_GITHUB)
}

export function filterAnthropicHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) return {}

  const filtered: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (
      lower.startsWith('x-anthropic') ||
      lower.startsWith('anthropic-') ||
      lower.startsWith('x-claude') ||
      lower === 'x-app' ||
      lower === 'x-client-app' ||
      lower === 'authorization' ||
      lower === 'x-api-key' ||
      lower === 'api-key'
    ) {
      continue
    }
    filtered[key] = value
  }

  return filtered
}

export function hasGeminiApiHost(
  baseUrl: string | undefined,
  expectedHost: string,
): boolean {
  if (!baseUrl) return false

  try {
    return new URL(baseUrl).hostname.toLowerCase() === expectedHost
  } catch {
    return false
  }
}

export function isGeminiModelName(model: string | undefined): boolean {
  const normalized = model?.trim().toLowerCase()
  return (
    normalized?.startsWith('google/gemini-') === true ||
    normalized?.startsWith('gemini-') === true
  )
}

export function shouldPreserveGeminiThoughtSignature(
  model: string | undefined,
  baseUrl: string | undefined,
  isGeminiMode: boolean,
  geminiApiHost: string,
): boolean {
  return (
    isGeminiMode ||
    hasGeminiApiHost(baseUrl, geminiApiHost) ||
    isGeminiModelName(model)
  )
}

export function geminiThoughtSignatureFromExtraContent(
  extraContent: unknown,
): string | undefined {
  if (!extraContent || typeof extraContent !== 'object') return undefined
  const google = (extraContent as Record<string, unknown>).google
  if (!google || typeof google !== 'object') return undefined
  const signature = (google as Record<string, unknown>).thought_signature
  return typeof signature === 'string' && signature.length > 0 ? signature : undefined
}

export function mergeGeminiThoughtSignature(
  extraContent: Record<string, unknown> | undefined,
  signature: string | undefined,
): Record<string, unknown> | undefined {
  if (!signature) return extraContent
  const existingGoogle =
    extraContent?.google && typeof extraContent.google === 'object'
      ? extraContent.google as Record<string, unknown>
      : {}
  return {
    ...extraContent,
    google: { ...existingGoogle, thought_signature: signature },
  }
}

export function hasCerebrasApiHost(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false

  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === 'api.cerebras.ai' || host.endsWith('.cerebras.ai')
  } catch {
    return false
  }
}

export function hasMistralApiHost(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false

  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === 'api.mistral.ai' || host.endsWith('.mistral.ai')
  } catch {
    return false
  }
}

function hasNvidiaNimApiHost(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false

  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'integrate.api.nvidia.com'
  } catch {
    return false
  }
}

export function maybeSetNvidiaNimChatTemplateThinking(
  body: Record<string, unknown>,
  baseUrl: string | undefined,
  reasoningRequestPlan: {
    thinkingType?: string
    reasoningEffort?: string
  },
): void {
  if (!hasNvidiaNimApiHost(baseUrl)) return
  if (
    reasoningRequestPlan.thinkingType === 'disabled' ||
    (reasoningRequestPlan.thinkingType !== 'enabled' &&
      !reasoningRequestPlan.reasoningEffort)
  ) {
    return
  }

  const existing = body.chat_template_kwargs
  const kwargs =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {}
  kwargs.thinking = true
  kwargs.enable_thinking = true
  body.chat_template_kwargs = kwargs
}
