export type OpenAICompatibilityFailureCategory =
  | 'connection_refused'
  | 'localhost_resolution_failed'
  | 'request_timeout'
  | 'network_error'
  | 'auth_invalid'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'model_not_found'
  | 'endpoint_not_found'
  | 'vision_not_supported'
  | 'context_overflow'
  | 'tool_call_incompatible'
  | 'tool_stream_unsupported'
  | 'stream_options_unsupported'
  | 'malformed_provider_response'
  | 'provider_unavailable'
  | 'unknown'

export type OpenAICompatibilityFailure = {
  source: 'network' | 'http'
  category: OpenAICompatibilityFailureCategory
  retryable: boolean
  message: string
  hint?: string
  code?: string
  status?: number
  requestUrl?: string
}

const NON_REPLAYABLE_OPENAI_REQUEST = Symbol.for(
  'openclaude.openai.nonReplayableRequest',
)

export function markOpenAIRequestNonReplayable<T extends object>(error: T): T {
  Object.defineProperty(error, NON_REPLAYABLE_OPENAI_REQUEST, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  })
  return error
}

export function isOpenAIRequestNonReplayable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, NON_REPLAYABLE_OPENAI_REQUEST) === true
  )
}

const OPENAI_CATEGORY_MARKER_PREFIX = '[openai_category='

const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])

const OPENAI_COMPATIBILITY_FAILURE_CATEGORIES: ReadonlySet<OpenAICompatibilityFailureCategory> =
  new Set<OpenAICompatibilityFailureCategory>([
    'connection_refused',
    'localhost_resolution_failed',
    'request_timeout',
    'network_error',
    'auth_invalid',
    'rate_limited',
    'quota_exhausted',
    'model_not_found',
    'endpoint_not_found',
    'vision_not_supported',
    'context_overflow',
    'tool_call_incompatible',
    'tool_stream_unsupported',
    'stream_options_unsupported',
    'malformed_provider_response',
    'provider_unavailable',
    'unknown',
  ])

const RETRYABLE_OPENAI_COMPATIBILITY_FAILURE_CATEGORIES: ReadonlySet<OpenAICompatibilityFailureCategory> =
  new Set<OpenAICompatibilityFailureCategory>([
    'connection_refused',
    'localhost_resolution_failed',
    'request_timeout',
    'network_error',
    'rate_limited',
    'provider_unavailable',
  ])

function isOpenAICompatibilityFailureCategory(
  value: string,
): value is OpenAICompatibilityFailureCategory {
  return OPENAI_COMPATIBILITY_FAILURE_CATEGORIES.has(
    value as OpenAICompatibilityFailureCategory,
  )
}

export function isRetryableOpenAICompatibilityFailureCategory(
  category: OpenAICompatibilityFailureCategory,
): boolean {
  return RETRYABLE_OPENAI_COMPATIBILITY_FAILURE_CATEGORIES.has(category)
}

function getErrorCode(error: unknown): string | undefined {
  let current: unknown = error
  const maxDepth = 5

  for (let depth = 0; depth < maxDepth; depth++) {
    if (
      current &&
      typeof current === 'object' &&
      'code' in current &&
      typeof (current as { code?: unknown }).code === 'string'
    ) {
      return (current as { code: string }).code
    }

    if (
      current &&
      typeof current === 'object' &&
      'cause' in current &&
      (current as { cause?: unknown }).cause !== current
    ) {
      current = (current as { cause?: unknown }).cause
      continue
    }

    break
  }

  return undefined
}

function getHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

function isLocalhostLikeHostname(hostname: string | null): boolean {
  if (!hostname) return false
  if (LOCALHOST_HOSTNAMES.has(hostname)) return true
  return /^127\./.test(hostname)
}

export function isLocalhostLikeHost(host: string | null | undefined): boolean {
  if (!host) return false
  return isLocalhostLikeHostname(host.toLowerCase())
}

function isContextOverflowMessage(body: string): boolean {
  const lower = body.toLowerCase()
  return (
    lower.includes('too many tokens') ||
    lower.includes('request too large') ||
    lower.includes('context length') ||
    lower.includes('maximum context') ||
    lower.includes('input length') ||
    lower.includes('payload too large') ||
    lower.includes('prompt is too long')
  )
}

function isToolCompatibilityMessage(body: string): boolean {
  const lower = body.toLowerCase()
  return (
    lower.includes('tool_calls') ||
    lower.includes('tool_call') ||
    lower.includes('tool_use') ||
    lower.includes('tool_result') ||
    lower.includes('function calling') ||
    lower.includes('function call')
  )
}

function getStructuredToolStreamValidationError(body: string): boolean | undefined {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown }
    if (!Array.isArray(parsed.detail)) return undefined
    const details: Array<{ loc: unknown[]; type?: unknown; msg?: unknown }> = []
    for (const detail of parsed.detail) {
      if (!detail || typeof detail !== 'object') continue
      const { loc, type, msg } = detail as { loc?: unknown; type?: unknown; msg?: unknown }
      if (Array.isArray(loc)) details.push({ loc, type, msg })
    }
    const isRootToolStreamLocation = (loc: unknown[]): boolean =>
      loc[0] === 'body' && loc[1] === 'tool_stream'
    const isRootToolStreamExtraField = (detail: {
      loc: unknown[]
      type?: unknown
      msg?: unknown
    }): boolean =>
      detail.loc.length === 2 &&
      isRootToolStreamLocation(detail.loc) &&
      (
        detail.type === 'extra_forbidden' ||
        detail.type === 'value_error.extra' ||
        (typeof detail.msg === 'string' && /extra (?:inputs|fields) (?:are )?not permitted/i.test(detail.msg))
      )
    if (details.some(isRootToolStreamExtraField)) return true
    if (
      details.some(
        detail =>
          detail.loc.length === 2 &&
          isRootToolStreamLocation(detail.loc) &&
          typeof detail.msg === 'string' &&
          /tool_stream is (?:unsupported|not supported|unknown|invalid)/i.test(detail.msg),
      )
    ) return true
    if (
      details.some(detail =>
        detail.loc.includes('tools') || isRootToolStreamLocation(detail.loc)
      )
    ) return false
    return undefined
  } catch {
    return undefined
  }
}

// Detect a gateway rejecting the Z.AI-proprietary `tool_stream` parameter
// (e.g. NVIDIA NIM: `400 Unsupported parameter(s): tool_stream`). The
// `tool_call` substring in isToolCompatibilityMessage does NOT match
// `tool_stream`, so this needs its own matcher.
function isToolStreamUnsupportedMessage(body: string): boolean {
  const normalized = body.toLowerCase().replace(/['"`]/g, '')
  const structuredValidation = getStructuredToolStreamValidationError(body)
  if (
    /(?:function|tool)\s*:?\s+tool_stream\b/.test(normalized) ||
    /\b(?:function|tool)\b.*?\b(?:schema|properties?)\b.*?\btool_stream\b/.test(normalized) ||
    /\b(?:invalid|malformed)\s+(?:tool\s+)?schema\b.*?\btool_stream\b/.test(normalized) ||
    /\btool_stream\b.*?\b(?:invalid|malformed)\s+(?:tool\s+)?schema\b/.test(normalized) ||
    /\b(?:tool|function)\s+definition\b.*?\btool_stream\b/.test(normalized) ||
    /\btool_stream\b.*?\b(?:tool|function)\s+definition\b/.test(normalized) ||
    /\btool_stream\b.*?\b(?:body\.)?tools?\s*(?:\.|\[)/.test(normalized) ||
    /\b(?:body\.)?tools?\s*(?:\.|\[).*?\btool_stream\b/.test(normalized) ||
    /(?:unexpected (?:field|property|parameter)|extra[_\s-]?forbidden|extra inputs are not permitted|additional properties? (?:are )?not allowed).*?\btool_stream\b.*?\b(?:in|at|for)\s+(?:(?:an?|the)\s+)?(?:tool|function)?\s*(?:schema|parameters?|properties?)\b/.test(normalized) ||
    /\btool_stream\b.*?(?:unexpected (?:field|property|parameter)|extra[_\s-]?forbidden|extra inputs are not permitted|additional properties? (?:are )?not allowed).*?\b(?:tool|function)\s+(?:schema|parameters?|properties?)\b/.test(normalized) ||
    /\b(?:invalid|malformed)\s+parameter\s+tool_stream\b.*?\b(?:in|for)\s+(?:(?:an?|the)\s+)?(?:function|tool)\s+(?!calls?\b|calling\b)\S+/.test(normalized) ||
    /\badditional properties?\b.*?\btool_stream\b.*?\b(?:in|for)\s+(?:(?:an?|the)\s+)?(?:function|tool)\s+(?!calls?\b|calling\b)\S+/.test(normalized) ||
    structuredValidation === false
  ) return false
  if (structuredValidation === true) return true
  return (
    /(?:unsupported|unknown|unrecognized|invalid)\s+(?:request\s+argument(?:\s+supplied)?|parameter(?:s|\(s\))?)(?:\s*[:=])?\s*(?:[\[(<]\s*)?tool_stream\b(?:\s*[\])>])?/.test(normalized) ||
    /(?:request\s+argument(?:\s+supplied)?|parameter(?:s|\(s\))?)\s+(?:[\[(<]\s*)?tool_stream\b(?:\s*[\])>])?\s+(?:is\s+)?(?:unsupported|not\s+supported|unknown|invalid)\b/.test(normalized) ||
    /tool_stream\s+(?:is\s+)?(?:an?\s+)?(?:unsupported|not\s+supported|unknown|invalid)\s+(?:request\s+argument|parameter(?:s|\(s\))?)\b/.test(normalized) ||
    /(?:unsupported|unknown|unrecognized|invalid)\s+tool_stream\s+(?:request\s+argument|parameter(?:s|\(s\))?)\b/.test(normalized) ||
    /(?:^|\n|\bmessage\s*:\s*)\s*tool_stream\s+(?:is\s+)?(?:an?\s+)?(?:unsupported|not\s+supported|unknown|invalid)\b(?!\s+as\s+(?:a\s+)?(?:function|tool)\b)/.test(normalized) ||
    /(?:unsupported|unknown|unrecognized|invalid|not\s+supported).*?\bparam(?:eter)?\s*[:=]\s*tool_stream\b/.test(normalized) ||
    /\bparam(?:eter)?\s*[:=]\s*tool_stream\b.*?(?:unsupported|unknown|unrecognized|invalid|not\s+supported)/.test(normalized) ||
    /(?:extra[_\s-]?forbidden|extra inputs are not permitted|additional properties? (?:are )?not allowed|unexpected (?:field|property|parameter)).*?tool_stream\b/.test(normalized) ||
    /tool_stream\b.*?(?:extra[_\s-]?forbidden|extra inputs are not permitted|unexpected (?:field|property|parameter))/.test(normalized)
  )
}

function getStructuredStreamOptionsValidationError(
  body: string,
): boolean | undefined {
  try {
    const parsed = JSON.parse(body) as {
      detail?: unknown
      error?: unknown
    }
    if (Array.isArray(parsed.detail)) {
      let referencesRootStreamOptions = false
      let referencesNestedStreamOptions = false
      for (const entry of parsed.detail) {
        if (!entry || typeof entry !== 'object') continue
        const detail = entry as { loc?: unknown; type?: unknown; msg?: unknown }
        if (!Array.isArray(detail.loc) || !detail.loc.includes('stream_options')) {
          continue
        }
        const isRootField =
          (detail.loc.length === 1 && detail.loc[0] === 'stream_options') ||
          (detail.loc.length === 2 &&
            detail.loc[0] === 'body' &&
            detail.loc[1] === 'stream_options')
        if (!isRootField) {
          referencesNestedStreamOptions = true
          continue
        }
        referencesRootStreamOptions = true
        const message = typeof detail.msg === 'string' ? detail.msg : ''
        if (
          detail.type === 'extra_forbidden' ||
          detail.type === 'value_error.extra' ||
          /(?:unsupported|not supported|unknown|unrecognized|unexpected|not permitted|extra (?:inputs|fields))/i.test(message)
        ) {
          return true
        }
      }
      if (referencesNestedStreamOptions) return false
      if (referencesRootStreamOptions) return undefined
    }

    if (parsed.error && typeof parsed.error === 'object') {
      const error = parsed.error as {
        param?: unknown
        message?: unknown
        type?: unknown
        code?: unknown
      }
      const parameter = typeof error.param === 'string'
        ? error.param.toLowerCase().replace(/['"`]/g, '')
        : undefined
      if (parameter === 'stream_options') {
        const signal = [error.message, error.code]
          .filter((value): value is string => typeof value === 'string')
          .join(' ')
        if (
          /(?:unsupported|not supported|unknown|unrecognized|unexpected|not permitted|extra[_ -]?forbidden|invalid (?:request )?(?:argument|parameter|field|property))/i.test(signal)
        ) {
          return true
        }
        return undefined
      }
      if (parameter && /^stream_options(?:\.|\[|\/)/.test(parameter)) {
        return false
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

function isStreamOptionsUnsupportedMessage(body: string): boolean {
  const structuredValidation = getStructuredStreamOptionsValidationError(body)
  if (structuredValidation !== undefined) return structuredValidation

  const normalized = body.toLowerCase().replace(/['"`]/g, '')
  return (
    /(?:^|[\s:{,(])stream_options\b(?![.\[/])\s+(?:is\s+)?(?:an?\s+)?(?:unsupported|not\s+supported|unknown|unrecognized|not\s+permitted)\b/.test(normalized) ||
    /(?:unsupported|unknown|unrecognized|invalid)\s+(?:request\s+argument(?:\s+supplied)?|parameter(?:s|\(s\))?|field|property)(?:\s*[:=])?\s*(?:[\[(<]\s*)?stream_options\b(?![.\[/])/.test(normalized) ||
    /(?:request\s+argument(?:\s+supplied)?|parameter(?:s|\(s\))?|field|property)\s+(?:[\[(<]\s*)?stream_options\b(?![.\[/])(?:\s*[\])>])?\s+(?:is\s+)?(?:unsupported|not\s+supported|unknown|unrecognized|invalid|not\s+permitted)\b/.test(normalized) ||
    /\bstream_options\b(?![.\[/])\s+(?:is\s+)?(?:an?\s+)?(?:unsupported|not\s+supported|unknown|unrecognized|invalid)\s+(?:request\s+argument|parameter|field|property)\b/.test(normalized) ||
    /(?:additional properties? (?:are )?not allowed|extra inputs are not permitted|extra fields? (?:are )?not permitted|unexpected (?:field|property|parameter)).{0,80}\bstream_options\b(?![.\[/])/.test(normalized) ||
    /\bstream_options\b(?![.\[/]).{0,80}(?:additional properties? (?:are )?not allowed|extra inputs are not permitted|extra fields? (?:are )?not permitted|was unexpected)\b/.test(normalized)
  )
}

function isMalformedProviderResponse(body: string): boolean {
  const lower = body.toLowerCase()
  return (
    lower.includes('<!doctype html') ||
    lower.includes('<html') ||
    lower.includes('invalid json') ||
    lower.includes('malformed') ||
    lower.includes('unexpected token') ||
    lower.includes('cannot parse') ||
    lower.includes('not valid json')
  )
}

/**
 * Detect provider messages that complain about a missing/required `text`
 * field on an otherwise image-bearing payload. Xiaomi Mimo surfaces this as
 * `{"error":{"code":"400","message":"Param Incorrect","param":"`text` is not set"}}`
 * (with backticks around `text`) when a `role: "tool"` message carries
 * images but no text part. Other OpenAI-compatible providers may phrase
 * it differently — match liberally.
 *
 * Only meaningful when `hasImages` is true (we never want this branch to fire
 * for text-only requests, which legitimately lack a text field on vision-only
 * payloads).
 */
function isMissingTextPartMessage(body: string): boolean {
  // Strip backticks so `\`text\` is not set` matches the same patterns as
  // `text is not set` — the Xiaomi Mimo 400 body wraps `text` in backticks
  // inside the `param` field, which trips naive substring matching.
  const lower = body.toLowerCase().replace(/`/g, '')
  return (
    lower.includes('text is not set') ||
    lower.includes('text is required') ||
    lower.includes('text parameter is required') ||
    lower.includes('text parameter is missing') ||
    lower.includes('missing text') ||
    lower.includes('"param":"text"') ||
    lower.includes('"param": "text"')
  )
}

function isModelNotFoundMessage(body: string): boolean {
  const lower = body.toLowerCase()
  return (
    lower.includes('model') &&
    (
      lower.includes('not found') ||
      lower.includes('does not exist') ||
      lower.includes('unknown model') ||
      lower.includes('unavailable model')
    )
  )
}

function isQuotaExhaustedMessage(body: string): boolean {
  const lower = body.toLowerCase()
  return (
    lower.includes('limit: 0') ||
    lower.includes('exceeded your current quota') ||
    lower.includes('insufficient credit') ||
    lower.includes('credit limit') ||
    lower.includes('out of credits') ||
    lower.includes('payment required') ||
    lower.includes('usage limit') ||
    lower.includes('quota exceeded') ||
    lower.includes('allotment') ||
    lower.includes('insufficient funds') ||
    lower.includes('billing limit') ||
    lower.includes('billing quota') ||
    lower.includes('billing credits')
  )
}

export function formatOpenAICategoryMarker(
  category: OpenAICompatibilityFailureCategory,
  host?: string,
): string {
  if (host && /^[A-Za-z0-9.\-:]+$/.test(host)) {
    return `${OPENAI_CATEGORY_MARKER_PREFIX}${category},host=${host}]`
  }
  return `${OPENAI_CATEGORY_MARKER_PREFIX}${category}]`
}

export function extractOpenAICategoryMarker(
  message: string,
): OpenAICompatibilityFailureCategory | undefined {
  const match = message.match(/\[openai_category=([a-z_]+)(?:,host=[^\]]+)?]/)
  const category = match?.[1]

  if (!category || !isOpenAICompatibilityFailureCategory(category)) {
    return undefined
  }

  return category
}

export function extractOpenAICategoryHost(message: string): string | undefined {
  const match = message.match(/\[openai_category=[a-z_]+,host=([A-Za-z0-9.\-:]+)]/)
  return match?.[1]
}

export function buildOpenAICompatibilityErrorMessage(
  baseMessage: string,
  failure: Pick<OpenAICompatibilityFailure, 'category' | 'hint' | 'requestUrl'>,
): string {
  const host = failure.requestUrl ? getHostname(failure.requestUrl) ?? undefined : undefined
  const marker = formatOpenAICategoryMarker(failure.category, host)
  const hint = failure.hint ? ` Hint: ${failure.hint}` : ''
  return `${baseMessage} ${marker}${hint}`
}

export function classifyOpenAINetworkFailure(
  error: unknown,
  options: { url: string },
): OpenAICompatibilityFailure {
  const message = error instanceof Error ? error.message : String(error)
  const lowerMessage = message.toLowerCase()
  const code = getErrorCode(error)
  const hostname = getHostname(options.url)
  const isLocalHost = isLocalhostLikeHostname(hostname)

  if (
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    lowerMessage.includes('timeout') ||
    lowerMessage.includes('timed out') ||
    lowerMessage.includes('aborterror')
  ) {
    return {
      source: 'network',
      category: 'request_timeout',
      retryable: true,
      message,
      code,
      hint: 'The provider took too long to respond. Check local model load time or increase API timeout.',
    }
  }

  if (
    isLocalHost &&
    (
      code === 'ENOTFOUND' ||
      code === 'EAI_AGAIN' ||
      lowerMessage.includes('getaddrinfo') ||
      (code === undefined && lowerMessage.includes('fetch failed'))
    )
  ) {
    return {
      source: 'network',
      category: 'localhost_resolution_failed',
      retryable: true,
      message,
      code,
      hint: 'Localhost failed for this request. Retry with 127.0.0.1 and confirm Ollama is serving on the configured port.',
    }
  }

  if (code === 'ECONNREFUSED') {
    return {
      source: 'network',
      category: 'connection_refused',
      retryable: true,
      message,
      code,
      hint: isLocalHost
        ? 'Connection to the local provider was refused. Ensure the local server is running and listening on the configured port.'
        : 'Connection was refused by the provider endpoint. Ensure the server is running and the port is correct.',
    }
  }

  return {
    source: 'network',
    category: 'network_error',
    retryable: true,
    message,
    code,
    hint: 'Network transport failed before a provider response was received.',
  }
}

export function classifyOpenAIHttpFailure(options: {
  status: number
  body: string
  url?: string
  hasImages?: boolean
}): OpenAICompatibilityFailure {
  const body = options.body ?? ''
  const hostname = options.url ? getHostname(options.url) : null
  const isLocalHost = isLocalhostLikeHostname(hostname)

  if (
    options.status === 402 ||
    ((options.status === 400 || options.status === 403 || options.status === 429) &&
      isQuotaExhaustedMessage(body))
  ) {
    return {
      source: 'http',
      category: 'quota_exhausted',
      retryable: false,
      status: options.status,
      message: body,
      hint: 'Provider quota or usage allotment has run out. Enable billing or switch provider.',
    }
  }

  if (options.status === 401 || options.status === 403) {
    // OAuth-issued tokens (GitHub Models via /onboard-github, Codex) expire
    // and surface as 401 with a "token expired" body. The generic API-key
    // hint sends users hunting for a key they never set — point them at the
    // re-auth command instead. Issue #1042.
    const lowerBody = body.toLowerCase()
    const isExpiredOAuthToken =
      lowerBody.includes('token expired') ||
      lowerBody.includes('token has expired') ||
      lowerBody.includes('token revoked')
    return {
      source: 'http',
      category: 'auth_invalid',
      retryable: false,
      status: options.status,
      message: body,
      hint: isExpiredOAuthToken
        ? 'OAuth token expired. Re-authenticate with /onboard-github (GitHub Models) or /login (Codex / Claude) and try again.'
        : 'Authentication failed. Verify API key, token source, and endpoint-specific auth headers.',
    }
  }

  if (options.status === 429) {
    return {
      source: 'http',
      category: 'rate_limited',
      retryable: true,
      status: options.status,
      message: body,
      hint: 'Provider rate-limited the request. Retry after backoff.',
    }
  }

  if (options.status === 404 && isModelNotFoundMessage(body)) {
    return {
      source: 'http',
      category: 'model_not_found',
      retryable: false,
      status: options.status,
      message: body,
      hint: 'The selected model is not installed or not available on this endpoint.',
    }
  }

  if (options.status === 404 && options.hasImages) {
    return {
      source: 'http',
      category: 'vision_not_supported',
      retryable: false,
      status: options.status,
      message: body,
      requestUrl: options.url,
      hint: 'The provider returned 404 for a request containing images. The model may not support vision/image inputs.',
    }
  }

  // Xiaomi Mimo and similar OpenAI-compatible providers reject image-bearing
  // `role: "tool"` messages with a 400 carrying `text is not set` instead of
  // a 404. Classify the same way as the 404 + hasImages branch so the user
  // gets actionable guidance rather than the raw API error (issue #1421).
  if (
    options.status === 400 &&
    options.hasImages &&
    isMissingTextPartMessage(body)
  ) {
    return {
      source: 'http',
      category: 'vision_not_supported',
      retryable: false,
      status: options.status,
      message: body,
      requestUrl: options.url,
      hint: 'The provider rejected a request containing an image (likely a tool result) because it did not include a text part. The model may not support image/vision inputs.',
    }
  }

  if (options.status === 404) {
    const isRemote = hostname !== null && !isLocalHost
    return {
      source: 'http',
      category: 'endpoint_not_found',
      retryable: false,
      status: options.status,
      message: body,
      requestUrl: options.url,
      hint: isRemote
        ? `Endpoint at ${hostname} returned 404. Verify OPENAI_BASE_URL is correct and the requested model is supported by this provider.`
        : 'Endpoint was not found. Confirm OPENAI_BASE_URL includes /v1 for OpenAI-compatible local providers.',
    }
  }

  if (
    options.status === 413 ||
    ((options.status === 400 || options.status >= 500) &&
      isContextOverflowMessage(body))
  ) {
    return {
      source: 'http',
      category: 'context_overflow',
      retryable: false,
      status: options.status,
      message: body,
      hint: 'Prompt context exceeded model/server limits. Reduce context or increase provider context length.',
    }
  }

  // Keep this classification narrower than a generic invalid-request match.
  // The executor uses it to authorize one replay without `stream_options`.
  if (
    (options.status === 400 || options.status === 422) &&
    isStreamOptionsUnsupportedMessage(body)
  ) {
    return {
      source: 'http',
      category: 'stream_options_unsupported',
      retryable: false,
      status: options.status,
      message: body,
      hint: 'Provider rejected the `stream_options` parameter; streaming usage is unavailable on this route.',
    }
  }

  // `tool_stream` is a Z.AI-proprietary streaming extension. Some OpenAI-
  // compatible gateways (e.g. NVIDIA NIM) reject it with a 400 like
  // "Unsupported parameter(s): `tool_stream`". Classify it distinctly so the
  // shim can self-heal by dropping just `tool_stream` and retrying with tools
  // intact (issue #1950). Match liberally on the parameter name plus an
  // unsupported/unknown-parameter signal so provider-specific wording still
  // triggers the fallback.
  if (
    (options.status === 400 || options.status === 422) &&
    isToolStreamUnsupportedMessage(body)
  ) {
    return {
      source: 'http',
      category: 'tool_stream_unsupported',
      retryable: false,
      status: options.status,
      message: body,
      hint: 'Provider rejected the `tool_stream` parameter. Retrying without it (tool calls are not streamed).',
    }
  }

  if (options.status === 400 && isToolCompatibilityMessage(body)) {
    return {
      source: 'http',
      category: 'tool_call_incompatible',
      retryable: false,
      status: options.status,
      message: body,
      hint: 'Provider/model rejected tool-calling payload. Retry without tools or use a tool-capable model.',
    }
  }

  // 5xx errors are always server-side failures and should be retryable,
  // even when the body is HTML (common for gateway 502/504 overload pages
  // that would otherwise classify as malformed_provider_response below).
  // This must run before the malformed-provider-response check so a 5xx
  // HTML page is treated as a transient provider_unavailable rather than
  // a dead-end malformed response. Issue: users see "Provider returned a
  // malformed response" on overload and have to retry manually.
  if (options.status >= 500) {
    return {
      source: 'http',
      category: 'provider_unavailable',
      retryable: true,
      status: options.status,
      message: body,
      hint: 'Provider reported a server-side failure. Retry after a short delay.',
    }
  }

  if (options.status >= 400 && isMalformedProviderResponse(body)) {
    return {
      source: 'http',
      category: 'malformed_provider_response',
      retryable: false,
      status: options.status,
      message: body,
      hint: 'Provider returned malformed or non-JSON response where JSON was expected.',
    }
  }

  return {
    source: 'http',
    category: 'unknown',
    retryable: false,
    status: options.status,
    message: body,
  }
}
