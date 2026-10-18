import {
  getKnownProviderSecretEnvKeys,
  looksLikeSecretValue,
  redactSecretSubstringsForDisplay,
} from '../utils/providerSecrets.js'
import {
  redactLikelySecrets,
  redactUrlForDisplay,
  shouldRedactUrlQueryParam,
} from '../utils/redaction.js'

export interface SanitizedMemoryText {
  text: string
  changed: boolean
  wholeSecret: boolean
}

const REDACTED_VALUE = '[REDACTED]'
const REDACTION_MARKER = /\[(?:redacted[^\]]*|configured)\]/i

function isConfiguredSecretValue(value: string): boolean {
  const candidate = value.trim().replace(/^[`'\"]|[`'\"]$/g, '')
  if (!candidate) return false
  const knownKeys = new Set(getKnownProviderSecretEnvKeys())
  for (const [key, rawValue] of Object.entries(process.env)) {
    if (
      !knownKeys.has(key) &&
      !/(?:_API_KEY|_AUTH_HEADER_VALUE|_PASSWORD|_SECRET(?:_ACCESS)?_KEY|_SECRET|_TOKEN)$/.test(key)
    ) {
      continue
    }
    if (!rawValue) continue
    if (rawValue.trim() === candidate) return true
    if (rawValue.split(',').some(part => part.trim() === candidate)) return true
  }
  return false
}

// Provider-level secret detection deliberately avoids slash-containing values
// because URLs and paths are common configuration values. Memory extraction has
// more context: a standalone base64-shaped value must not become a durable fact,
// while URL/path handling happens separately and preserves safe structure.
export function looksLikeMemorySecretValue(value: string): boolean {
  const trimmed = value.trim().replace(/^[`'\"]|[`'\"]$/g, '')
  if (!trimmed || trimmed.includes('://') || trimmed.startsWith('/')) return false
  if (looksLikeSecretValue(trimmed)) return true

  return (
    trimmed.length >= 20 &&
    /^[A-Za-z0-9+/_=-]+$/.test(trimmed) &&
    /[+/=]/.test(trimmed) &&
    /[A-Za-z]/.test(trimmed) &&
    /[0-9]/.test(trimmed)
  )
}

function redactCredentialContext(value: string): string {
  const credentialName =
    '(?:api[-_ ]?key|access[-_ ]?key|private[-_ ]?key|password|passwd|passphrase|pwd|access[-_ ]?token|refresh[-_ ]?token|auth[-_ ]?token|token|credential|secret)'
  const credentialValue = '(?:`[^`\\n]+`|"[^"\\n]+"|\'[^\'\\n]+\'|[^\\s,;.!?]+)'

  // Explicit assignment language: "password is ...", "token: ...", etc.
  let redacted = value.replace(
    new RegExp(`(\\b${credentialName}\\b\\s*(?::|=|\\bis\\b|\\bwas\\b|\\bare\\b|\\bwere\\b)\\s*)${credentialValue}`, 'gi'),
    `$1${REDACTED_VALUE}`,
  )

  // Imperative/use language without a separator: "Always use password ...".
  redacted = redacted.replace(
    new RegExp(`(\\b(?:use|using|with|set|enter|supply|provide|send|store|save|remember|implement|configure)\\s+(?:the\\s+|my\\s+)?${credentialName}\\b\\s+(?:to\\s+|as\\s+)?)${credentialValue}`, 'gi'),
    `$1${REDACTED_VALUE}`,
  )

  return redacted
}

function redactOpaqueBase64Tokens(value: string): string {
  return value.replace(
    /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+_-]{8,}\/[A-Za-z0-9+/_=-]{8,}(?![A-Za-z0-9+/_=-])/g,
    candidate => looksLikeMemorySecretValue(candidate) ? REDACTED_VALUE : candidate,
  )
}

function sanitizeMemoryUrl(rawUrl: string): string {
  const providerRedacted = redactSecretSubstringsForDisplay(rawUrl, process.env) ?? rawUrl
  try {
    const parsed = new URL(providerRedacted)
    const hasSensitiveQuery = [...parsed.searchParams.keys()]
      .some(shouldRedactUrlQueryParam)
    if (parsed.username || parsed.password || hasSensitiveQuery) {
      return redactUrlForDisplay(providerRedacted)
    }
    return providerRedacted
  } catch {
    if (
      /\/\/[^\s/]+@/.test(providerRedacted) ||
      /[?&][^&=#]*(?:token|key|secret|password|passwd|pwd|auth|signature|sig)[^&=#]*=/i.test(providerRedacted)
    ) {
      return redactUrlForDisplay(providerRedacted)
    }
    return providerRedacted
  }
}

function protectUrls(value: string): { text: string; restore: (text: string) => string } {
  const urls: string[] = []
  const text = value.replace(/(?:https?:)?\/\/[^\s"'`,<>()]+/gi, rawUrl => {
    const index = urls.push(sanitizeMemoryUrl(rawUrl)) - 1
    return `__OPENCLAUDE_MEMORY_URL_${index}__`
  })
  return {
    text,
    restore: sanitized => urls.reduce(
      (current, url, index) => current.replace(`__OPENCLAUDE_MEMORY_URL_${index}__`, url),
      sanitized,
    ),
  }
}

/**
 * Sanitizes untrusted text before it is written to persistent memory.
 *
 * `wholeSecret` lets callers drop fields that carry no useful context (for
 * example a legacy summary whose complete value is a password). Embedded
 * credentials are redacted so the surrounding diagnostic context can survive.
 */
export function sanitizeMemoryText(value: unknown): SanitizedMemoryText {
  const input = String(value ?? '')
  if (!input.trim()) return { text: input, changed: false, wholeSecret: false }

  const wholeSecret = looksLikeMemorySecretValue(input) || isConfiguredSecretValue(input)
  if (wholeSecret) {
    return { text: REDACTED_VALUE, changed: true, wholeSecret: true }
  }

  const protectedUrls = protectUrls(input)
  let text = redactSecretSubstringsForDisplay(protectedUrls.text, process.env) ?? protectedUrls.text
  text = redactLikelySecrets(text)
  text = redactCredentialContext(text)
  text = redactOpaqueBase64Tokens(text)
  text = protectedUrls.restore(text)

  return { text, changed: text !== input, wholeSecret: false }
}

/** Identifiers are persisted in titles and filenames, so partial redaction is unsafe. */
export function sanitizeMemoryIdentifier(value: unknown): string | null {
  const sanitized = sanitizeMemoryText(value)
  if (
    !sanitized.text.trim() ||
    sanitized.changed ||
    sanitized.wholeSecret ||
    REDACTION_MARKER.test(sanitized.text)
  ) {
    return null
  }
  return sanitized.text
}

export function containsMemoryRedaction(value: string): boolean {
  return REDACTION_MARKER.test(value)
}
