/**
 * User-Agent string helpers.
 *
 * Kept dependency-free so SDK-bundled code (bridge, cli/transports) can
 * import without pulling in auth.ts and its transitive dependency tree.
 */

export function getClaudeCodeUserAgent(): string {
  return `claude-code/${MACRO.VERSION}`
}

export function getOpenClaudeUserAgent(): string {
  try {
    // Keep macro properties in a direct expression so Bun substitutes them in
    // shipped bundles. The fallback supports unbundled unit-test execution.
    return `openclaude/${MACRO.DISPLAY_VERSION ?? MACRO.VERSION}`
  } catch {
    return 'openclaude/0.0.0'
  }
}
