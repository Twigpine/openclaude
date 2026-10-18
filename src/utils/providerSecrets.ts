import type { ProviderPresetManifestEntry } from '../integrations/descriptors.js'
// Import the preset manifest from the lightweight manifest module (it only
// imports a compile-time type, so it pulls in zero descriptor data). The heavy
// descriptor arrays live in integrationArtifacts.generated.js and are required
// lazily below so that merely importing this module on the bootstrap startup
// path (bootstrap -> providerConfig -> providerProfile -> providerSecrets) does
// not eagerly evaluate the full descriptor graph.
import { PROVIDER_PRESET_MANIFEST } from '../integrations/generated/integrationManifest.generated.js'

// Manually-curated fallback. Kept defensive for legacy and OAuth/token
// credential paths that either predate descriptors or are accepted by
// provider-specific auth helpers outside setup.credentialEnvVars.
const FALLBACK_SECRET_ENV_KEYS: readonly string[] = [
  'OPENAI_API_KEYS',
  'OPENAI_API_KEY',
  'OPENAI_AUTH_HEADER_VALUE',
  'CODEX_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_ACCESS_TOKEN',
  'MISTRAL_API_KEY',
  'BNKR_API_KEY',
  'XAI_API_KEY',
  'AIMLAPI_API_KEY',
]

function readDescriptorCredentialEnvKeys(): readonly string[] {
  const keys = new Set<string>()

  const presets: readonly ProviderPresetManifestEntry[] = PROVIDER_PRESET_MANIFEST
  for (const preset of presets) {
    for (const key of preset.apiKeyEnvVars ?? []) {
      if (key) keys.add(key)
    }
  }

  // Lazy require so the descriptor graph is only evaluated on the first (and,
  // thanks to getKnownProviderSecretEnvKeys's cache, only) call, rather than at
  // module import time. Same pattern as the lazy requires in integrations/index.ts.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const artifacts =
    require('../integrations/generated/integrationArtifacts.generated.js') as typeof import('../integrations/generated/integrationArtifacts.generated.js')

  const descriptorsWithSetup = [
    ...artifacts.VENDOR_DESCRIPTORS,
    ...artifacts.GATEWAY_DESCRIPTORS,
    ...(artifacts.ANTHROPIC_PROXY_DESCRIPTORS as readonly { setup?: { credentialEnvVars?: readonly string[] } }[]),
  ]
  for (const descriptor of descriptorsWithSetup) {
    for (const key of descriptor.setup?.credentialEnvVars ?? []) {
      if (key) keys.add(key)
    }

    const validation = (descriptor as { validation?: { credentialEnvVars?: readonly string[] } }).validation
    for (const key of validation?.credentialEnvVars ?? []) {
      if (key) keys.add(key)
    }
  }

  return [...keys]
}

let cachedKnownSecretKeys: readonly string[] | null = null

/**
 * Every environment variable name that the integration registry declares as
 * holding a provider credential. Used to decide which display values must be
 * redacted. Derived from PROVIDER_PRESET_MANIFEST plus descriptor setup and
 * validation metadata so adding a new provider cannot silently create an
 * unredacted path.
 */
export function getKnownProviderSecretEnvKeys(): readonly string[] {
  if (cachedKnownSecretKeys) return cachedKnownSecretKeys
  const merged = new Set<string>(FALLBACK_SECRET_ENV_KEYS)
  for (const key of readDescriptorCredentialEnvKeys()) {
    merged.add(key)
  }
  cachedKnownSecretKeys = Object.freeze([...merged])
  return cachedKnownSecretKeys
}

// Secret sources are intentionally open: a provider can declare new credential
// env vars at any time, and forcing callers through a closed union would
// re-introduce the drift this module exists to prevent.
export type SecretValueSource = Partial<Record<string, string | undefined>>

export function sanitizeApiKey(
  key: string | null | undefined,
): string | undefined {
  if (!key) return undefined
  const trimmed = key.trim()
  if (!trimmed) return undefined
  const normalized = trimmed.toLowerCase()
  // Keep profile/env sanitization aligned with credentialPool placeholders so
  // template values like SUA_CHAVE / null / undefined never persist as keys.
  if (
    normalized === 'sua_chave' ||
    normalized === 'null' ||
    normalized === 'undefined'
  ) {
    return undefined
  }
  return key
}

// Heuristic masks for secret-shaped values whose env var name is not known.
// These catch values that slipped into display fields through unexpected paths
// (profile files, custom base URLs with embedded tokens, hand-edited configs).
const SECRET_PREFIX_PATTERNS = [
  /^sk-/,
  /^sk-ant-/,
  /^AIza/,
  /^ghp_/,
  /^gho_/,
  /^ghu_/,
  /^ghs_/,
  /^ghr_/,
  /^github_pat_/,
  /^npm_/,
  /^glpat-/,
  /^AKIA/,
  /^ASIA/,
  /^xox[baprs]-/,
]

const SECRET_PREFIX_SUBSTRING_PATTERN =
  /(?:sk-ant-|sk-|AIza|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|npm_|glpat-|AKIA|ASIA|xox[baprs]-)[A-Za-z0-9._-]{8,}/g
const JWT_SUBSTRING_PATTERN =
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g

export function looksLikeSecretValue(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false

  for (const pattern of SECRET_PREFIX_PATTERNS) {
    if (pattern.test(trimmed)) return true
  }

  return looksLikeOpaqueToken(trimmed)
}

// Opaque provider tokens are typically long, mixed-case alphanumeric payloads,
// sometimes with short prefix segments separated by dashes/underscores/dots.
function looksLikeOpaqueToken(value: string): boolean {
  if (value.length < 11) return false
  if (value.includes('://')) return false
  if (value.includes(' ')) return false
  if (value.includes('/')) return false

  if (/^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(value)) {
    return true
  }

  for (const ch of value) {
    const isAllowed =
      (ch >= 'a' && ch <= 'z') ||
      (ch >= 'A' && ch <= 'Z') ||
      (ch >= '0' && ch <= '9') ||
      ch === '-' ||
      ch === '_' ||
      ch === '.'
    if (!isAllowed) return false
  }

  const hasLower = /[a-z]/.test(value)
  const hasUpper = /[A-Z]/.test(value)
  const hasDigit = /[0-9]/.test(value)
  const hasSep = /[-_.]/.test(value)
  const len = value.length
  const segments = value.split(/[-_.]+/)

  // Check for common credential keywords using word boundaries on separator-normalized value
  const containsSecretKeyword = /\b(?:token|secret|pass|password|passphrase|pwd|key|credential|secure|private)\b|\bauth\b/i.test(value.replace(/[-_.]/g, ' '))

  // 1. If it contains a secret keyword and is of moderate length, it's a secret.
  //    When the value has separators, require at least one segment to be long
  //    so that compound model names (e.g. "prefix-sk-or-SECRET-VALUE-123-suffix")
  //    are not falsely flagged.
  if (containsSecretKeyword && len >= 12) {
    if (!hasSep) return true
    if (segments.some(seg => seg.length >= 12)) return true
  }

  // 2. pure hex blobs
  if (len >= 16 && /^[a-f0-9]+$/i.test(value) && hasDigit) return true

  if (!hasSep) {
    // Single segment (no hyphens/underscores/dots)
    // Mixed-case with digit >= 11 (e.g. Tr0ub4dour1)
    if (hasLower && hasUpper && hasDigit && len >= 11) return true
    // All-caps + digit >= 11 (e.g. TOKENABC123)
    if (hasUpper && hasDigit && !hasLower && len >= 11) return true
    // Lowercase + digit >= 16
    if (hasLower && hasDigit && !hasUpper && len >= 16) return true
    // Mixed-case without digit >= 24
    if (hasLower && hasUpper && !hasDigit && len >= 24) return true
  } else {
    // Has separators
    // Mixed-case with digit: require at least one segment with digit to be >= 12
    if (hasLower && hasUpper && hasDigit) {
      if (segments.some(seg => seg.length >= 12 && /[0-9]/.test(seg))) return true
    }
    // Lowercase with separator: require at least one segment to be >= 16
    if (!hasUpper && segments.some(seg => seg.length >= 16)) return true
    // Mixed-case without digit: require at least one segment to be >= 16
    if (hasLower && hasUpper && !hasDigit && segments.some(seg => seg.length >= 16)) return true
  }

  return false
}

// Redaction sources may be full process env objects, so also collect values
// from generic credential-bearing suffixes. The descriptor registry covers
// known providers; this defensive path covers custom routes and cloud/database
// auth variables that can still be surfaced through status/config displays.
function isSecretEnvKey(
  key: string,
  knownKeys: ReadonlySet<string>,
): boolean {
  return (
    knownKeys.has(key) ||
    key.endsWith('_API_KEY') ||
    key.endsWith('_AUTH_HEADER_VALUE') ||
    key.endsWith('_PASSWORD') ||
    key.endsWith('_SECRET') ||
    key.endsWith('_SECRET_ACCESS_KEY') ||
    key.endsWith('_SECRET_KEY') ||
    key.endsWith('_TOKEN')
  )
}

function collectSecretValues(
  sources: Array<SecretValueSource | null | undefined>,
): string[] {
  const knownKeys = new Set(getKnownProviderSecretEnvKeys())
  const values = new Set<string>()

  for (const source of sources) {
    if (!source) continue

    for (const key of Object.keys(source)) {
      if (!isSecretEnvKey(key, knownKeys)) continue

      const value = sanitizeApiKey(source[key])?.trim()
      if (value) {
        values.add(value)
        for (const part of value.split(',')) {
          const trimmedPart = sanitizeApiKey(part)?.trim()
          if (trimmedPart) values.add(trimmedPart)
        }
      }
    }
  }

  return [...values]
}

export function maskSecretForDisplay(
  value: string | null | undefined,
): string | undefined {
  const sanitized = sanitizeApiKey(value)
  if (!sanitized) return undefined

  if (sanitized.length <= 8) {
    return 'configured'
  }

  return `${sanitized.slice(0, 3)}...${sanitized.slice(-3)}`
}

export function redactSecretValueForDisplay(
  value: string | null | undefined,
  ...sources: Array<SecretValueSource | null | undefined>
): string | undefined {
  if (!value) return undefined

  const trimmed = value.trim()
  if (!trimmed) return value

  const secretValues = collectSecretValues(sources)
  if (secretValues.includes(trimmed) || looksLikeSecretValue(trimmed)) {
    return maskSecretForDisplay(trimmed) ?? 'configured'
  }

  return trimmed
}

export function redactSecretSubstringsForDisplay(
  value: string | null | undefined,
  ...sources: Array<SecretValueSource | null | undefined>
): string | undefined {
  if (!value) return undefined

  let redacted = value
  const secretValues = collectSecretValues(sources).sort(
    (a, b) => b.length - a.length,
  )
  for (const secretValue of secretValues) {
    const mask = maskSecretForDisplay(secretValue) ?? 'configured'
    redacted = redacted.split(secretValue).join(mask)
  }

  redacted = redacted.replace(
    SECRET_PREFIX_SUBSTRING_PATTERN,
    match => maskSecretForDisplay(match) ?? 'configured',
  )
  redacted = redacted.replace(
    JWT_SUBSTRING_PATTERN,
    match => maskSecretForDisplay(match) ?? 'configured',
  )

  return redacted
}

const MAX_SECRET_ENCODING_LAYERS = 4

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function encodedVariantPattern(value: string): string {
  return Array.from(value, char => {
    const lower = char.toLowerCase()
    return lower >= 'a' && lower <= 'f'
      ? `[${lower}${lower.toUpperCase()}]`
      : escapeRegex(char)
  }).join('')
}

function percentEncodeUtf8(value: string): string {
  return Array.from(
    new TextEncoder().encode(value),
    byte => `%${byte.toString(16).padStart(2, '0').toUpperCase()}`,
  ).join('')
}

function encodedSecretPattern(value: string): RegExp {
  const characterPatterns = Array.from(value, char => {
    const variants = [escapeRegex(char)]
    let encoded = percentEncodeUtf8(char)
    for (let layer = 0; layer < MAX_SECRET_ENCODING_LAYERS; layer++) {
      variants.push(encodedVariantPattern(encoded))
      encoded = encodeURIComponent(encoded)
    }
    return `(?:${variants.join('|')})`
  })
  return new RegExp(characterPatterns.join(''), 'g')
}

/**
 * Redacts configured secrets when each character is literal or percent-encoded
 * without decoding unrelated message text. Encoding depth is explicitly
 * bounded to keep matching predictable on untrusted diagnostics.
 */
export function redactEncodedSecretSubstringsForDisplay(
  value: string | null | undefined,
  ...sources: Array<SecretValueSource | null | undefined>
): string | undefined {
  if (!value) return undefined

  let redacted = value
  const secretValues = collectSecretValues(sources).sort(
    (a, b) => b.length - a.length,
  )
  for (const secretValue of secretValues) {
    const mask = maskSecretForDisplay(secretValue) ?? 'configured'
    redacted = redacted.replace(encodedSecretPattern(secretValue), mask)
  }

  return redacted
}

export function sanitizeProviderConfigValue(
  value: string | null | undefined,
  ...sources: Array<SecretValueSource | null | undefined>
): string | undefined {
  if (!value) return undefined

  const trimmed = value.trim()
  if (!trimmed) return undefined

  const secretValues = collectSecretValues(sources)
  if (secretValues.includes(trimmed) || looksLikeSecretValue(trimmed)) {
    return undefined
  }

  return trimmed
}
