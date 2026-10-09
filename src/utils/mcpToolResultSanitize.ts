import {
  BASH_MAX_OUTPUT_UPPER_LIMIT,
  getMaxOutputLength,
} from './shell/outputLimits.js'

/**
 * Make MCP CallTool text safe for mill hosts (Grok Build / Cursor) that
 * re-inject tool results into the next chat/completions request.
 *
 * Grok cli-chat-proxy has returned HTTP 500 "Internal error during token
 * parsing" after Bash/tool loops when the follow-up body carried NULs or
 * invalid UTF-8. Strip NULs and re-encode as well-formed UTF-8.
 */
export function sanitizeMcpToolText(text: string): string {
  // JS strings can hold NULs and lone surrogates; both break some tokenizers.
  const withoutNuls = text.replace(/\u0000/g, '')
  return Buffer.from(withoutNuls, 'utf8').toString('utf8')
}

/**
 * Cap MCP CallTool text returned to mill hosts. Bash already soft-caps
 * stdout via getMaxOutputLength(), but MCP serve bypasses REPL
 * applyToolResultBudget and may jsonStringify object results with no
 * host-side hard cap. Override with BASH_MAX_OUTPUT_LENGTH (default 30000,
 * upper 150000).
 */
export function truncateMcpToolText(text: string): string {
  const sanitized = sanitizeMcpToolText(text)
  const max = getMaxOutputLength()
  if (sanitized.length <= max) return sanitized
  return (
    sanitized.slice(0, max) +
    `\n\n... [MCP tool result truncated at ${max} chars; set BASH_MAX_OUTPUT_LENGTH (max ${BASH_MAX_OUTPUT_UPPER_LIMIT}) to raise] ...`
  )
}

/**
 * Validate/normalize image base64 from tool results. Invalid payloads are
 * dropped (null) so they cannot poison the mill follow-up request.
 */
export function sanitizeMcpImageData(data: string): string | null {
  // NULs in base64 are always corrupt — drop the image rather than strip
  // and accidentally accept a spliced payload.
  if (data.includes('\u0000')) return null
  const cleaned = data.replace(/\s+/g, '')
  if (!cleaned) return null
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) return null
  try {
    const buf = Buffer.from(cleaned, 'base64')
    if (buf.length === 0) return null
    // Reject clearly truncated/corrupt padding by round-tripping
    return buf.toString('base64')
  } catch {
    return null
  }
}
