/**
 * Frontmatter parser for markdown files
 * Extracts and parses YAML frontmatter between --- delimiters
 */

import { logForDebugging } from './debug.js'
import type { HooksSettings } from './settings/types.js'
import { parseYaml } from './yaml.js'

export type FrontmatterData = {
  // YAML can return null for keys with no value (e.g., "key:" with nothing after)
  'allowed-tools'?: string | string[] | null
  description?: string | null
  // Memory type: 'user', 'feedback', 'project', or 'reference'
  // Only applicable to memory files; narrowed via parseMemoryType() in src/memdir/memoryTypes.ts
  type?: string | null
  'argument-hint'?: string | null
  when_to_use?: string | null
  version?: string | null
  // Only applicable to slash commands -- a string similar to a boolean env var
  // to determine whether to make them visible to the SlashCommand tool.
  'hide-from-slash-command-tool'?: string | null
  // Model alias or name (e.g., 'haiku', 'sonnet', 'opus', or specific model names)
  // Use 'inherit' for commands to use the parent model
  model?: string | null
  // Comma-separated list of skill names to preload (only applicable to agents)
  skills?: string | null
  // Whether users can invoke this skill by typing /skill-name
  // 'true' = user can type /skill-name to invoke
  // 'false' = only model can invoke via Skill tool
  // Default depends on source: commands/ defaults to true, skills/ defaults to false
  'user-invocable'?: string | null
  // Hooks to register when this skill is invoked
  // Keys are hook events (PreToolUse, PostToolUse, Stop, etc.)
  // Values are arrays of matcher configurations with hooks
  // Validated by HooksSchema in loadSkillsDir.ts
  hooks?: HooksSettings | null
  // Effort level for agents (e.g., 'low', 'medium', 'high', 'max', or an integer)
  // Controls the thinking effort used by the agent's model
  effort?: string | null
  // Execution context for skills: 'inline' (default) or 'fork' (run as sub-agent)
  // 'inline' = skill content expands into the current conversation
  // 'fork' = skill runs in a sub-agent with separate context and token budget
  context?: 'inline' | 'fork' | null
  // Agent type to use when forked (e.g., 'Bash', 'general-purpose')
  // Only applicable when context is 'fork'
  agent?: string | null
  // Glob patterns for file paths this skill applies to. Accepts either a
  // comma-separated string or a YAML list of strings.
  // When set, the skill is only activated when the model touches matching files
  // Uses the same format as CLAUDE.md paths frontmatter
  paths?: string | string[] | null
  // Shell to use for !`cmd` and ```! blocks in skill/command .md content.
  // 'bash' (default) or 'powershell'. File-scoped — applies to all !-blocks.
  // Never consults settings.defaultShell: skills are portable across platforms,
  // so the author picks the shell, not the reader. See docs/design/ps-shell-selection.md §5.3.
  shell?: string | null
  [key: string]: unknown
}

export type ParsedMarkdown = {
  frontmatter: FrontmatterData
  content: string
}

// Characters that require quoting in YAML values (when unquoted)
// - { } are flow mapping indicators
// - * is anchor/alias indicator
// - [ ] are flow sequence indicators
// - ': ' (colon followed by space) is key indicator — causes 'Nested mappings
//   are not allowed in compact mappings' when it appears mid-value. Match the
//   pattern rather than bare ':' so '12:34' times and 'https://' URLs stay unquoted.
// - # is comment indicator
// - & is anchor indicator
// - ! is tag indicator
// - | > are block scalar indicators (only at start)
// - % is directive indicator (only at start)
// - @ ` are reserved
const YAML_SPECIAL_CHARS = /[{}[\]*&#!|>%@`]|: /

/**
 * Pre-processes frontmatter text to quote values that contain special YAML characters.
 * This allows glob patterns like **\/*.{ts,tsx} to be parsed correctly.
 */
function quoteProblematicValues(frontmatterText: string): string {
  const lines = frontmatterText.split('\n')
  const result: string[] = []

  for (const line of lines) {
    // Match simple key: value lines (not indented, not list items, not block scalars)
    const match = line.match(/^([a-zA-Z_-]+):\s+(.+)$/)
    if (match) {
      const [, key, value] = match
      if (!key || !value) {
        result.push(line)
        continue
      }

      // Skip if already quoted
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        result.push(line)
        continue
      }

      // Quote if contains special YAML characters
      if (YAML_SPECIAL_CHARS.test(value)) {
        // Use double quotes and escape any existing double quotes
        const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        result.push(`${key}: "${escaped}"`)
        continue
      }
    }

    result.push(line)
  }

  return result.join('\n')
}

/**
 * The opening delimiter is anchored but the closing one must be too.
 *
 * `[\s\S]*?` is lazy, so an unanchored close stops at the first `---` appearing
 * anywhere -- including in the middle of a value. `description: Reviews code
 * --- thoroughly` ends the block early: the description is truncated to
 * "Reviews code", and the rest of the frontmatter plus the real delimiter leak
 * into the body that is sent to the model. A `---` line inside a block scalar
 * has the same effect.
 *
 * Requiring the captured block to be empty or to end at a line break pins the
 * close to the start of a line. The `m` flag would do the same for the close
 * but would also un-anchor the open, letting a horizontal rule partway down a
 * body be read as frontmatter. Only spaces and tabs may sit between the close
 * `---` and its line terminator -- letting `\s*` match the terminator itself
 * accepted a bare `---` with no line ending mid-document.
 *
 * Once that terminator (or EOF) is confirmed, the trailing `\s*` consumes the
 * conventional blank separator line(s) between frontmatter and body, matching
 * the pre-anchor behavior. Skill and plugin-command bodies are passed into
 * prompts untrimmed, so leaving that blank line in would prepend a stray
 * newline to the model instructions. This consumption runs only after a valid
 * line-terminated close, so it cannot revive the mid-document false close.
 *
 * The captured block is lazy at the outer level too (`)??`). A greedy `)?`
 * consumes one YAML line before trying empty, so empty frontmatter followed by
 * a body horizontal rule (`---\n---\n---\nBody`) reads the second `---` as YAML
 * and closes on the third, swallowing the rule into the frontmatter. Preferring
 * the empty capture closes at the first `---` line, as it did before the block
 * was anchored, while real frontmatter still matches by taking the non-empty
 * branch on backtrack.
 */
export const FRONTMATTER_REGEX =
  /^---[ \t]*\r?\n((?:[\s\S]*?\r?\n)??)---[ \t]*(?:\r?\n\s*|$)/

/**
 * Parses markdown content to extract frontmatter and content
 * @param markdown The raw markdown content
 * @returns Object containing parsed frontmatter and content without frontmatter
 */
export function parseFrontmatter(
  markdown: string,
  sourcePath?: string,
): ParsedMarkdown {
  const match = markdown.match(FRONTMATTER_REGEX)

  if (!match) {
    // No frontmatter found
    return {
      frontmatter: {},
      content: markdown,
    }
  }

  const frontmatterText = match[1] || ''
  const content = markdown.slice(match[0].length)

  let frontmatter: FrontmatterData = {}
  try {
    const parsed = parseYaml(frontmatterText) as FrontmatterData | null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      frontmatter = parsed
    }
  } catch {
    // YAML parsing failed - try again after quoting problematic values
    try {
      const quotedText = quoteProblematicValues(frontmatterText)
      const parsed = parseYaml(quotedText) as FrontmatterData | null
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        frontmatter = parsed
      }
    } catch (retryError) {
      // Still failed - log for debugging so users can diagnose broken frontmatter
      const location = sourcePath ? ` in ${sourcePath}` : ''
      logForDebugging(
        `Failed to parse YAML frontmatter${location}: ${retryError instanceof Error ? retryError.message : retryError}`,
        { level: 'warn' },
      )
    }
  }

  return {
    frontmatter,
    content,
  }
}

/**
 * Splits a comma-separated string and expands brace patterns.
 * Commas inside braces are not treated as separators.
 * Also accepts a YAML list (string array) for ergonomic frontmatter.
 * @param input - Comma-separated string, or array of strings, with optional brace patterns
 * @returns Array of expanded strings
 * @example
 * splitPathInFrontmatter("a, b") // returns ["a", "b"]
 * splitPathInFrontmatter("a, src/*.{ts,tsx}") // returns ["a", "src/*.ts", "src/*.tsx"]
 * splitPathInFrontmatter("{a,b}/{c,d}") // returns ["a/c", "a/d", "b/c", "b/d"]
 * splitPathInFrontmatter(["a", "src/*.{ts,tsx}"]) // returns ["a", "src/*.ts", "src/*.tsx"]
 */
export function splitPathInFrontmatter(input: string | string[]): string[] {
  if (Array.isArray(input)) {
    return input.flatMap(splitPathInFrontmatter)
  }
  if (typeof input !== 'string') {
    return []
  }
  // Split by comma while respecting braces
  const parts: string[] = []
  let current = ''
  let braceDepth = 0

  for (let i = 0; i < input.length; i++) {
    const char = input[i]

    if (char === '{') {
      braceDepth++
      current += char
    } else if (char === '}') {
      braceDepth--
      current += char
    } else if (char === ',' && braceDepth === 0) {
      // Split here - we're at a comma outside of braces
      const trimmed = current.trim()
      if (trimmed) {
        parts.push(trimmed)
      }
      current = ''
    } else {
      current += char
    }
  }

  // Add the last part
  const trimmed = current.trim()
  if (trimmed) {
    parts.push(trimmed)
  }

  // Expand brace patterns in each part
  return parts
    .filter(p => p.length > 0)
    .flatMap(pattern => expandBraces(pattern))
}

/**
 * Expands brace patterns in a glob string.
 *
 * Uses a balance-aware scan to locate the first brace group's matching close
 * brace, so nested groups expand correctly. Alternatives are split on
 * top-level commas only — commas nested inside deeper groups belong to those
 * sub-groups and are preserved until the recursion reaches them.
 *
 * Unmatched/unbalanced braces are treated as literal text: the input is
 * returned unchanged rather than throwing.
 *
 * @example
 * expandBraces("src/*.{ts,tsx}") // returns ["src/*.ts", "src/*.tsx"]
 * expandBraces("{a,b}/{c,d}") // returns ["a/c", "a/d", "b/c", "b/d"]
 * expandBraces("{a,{b,c}}") // returns ["a", "b", "c"]
 * expandBraces("src/**\/*.{js,{ts,tsx}}") // returns ["src/**\/*.js", "src/**\/*.ts", "src/**\/*.tsx"]
 */
function expandBraces(pattern: string): string[] {
  // Find the first opening brace.
  const open = pattern.indexOf('{')
  if (open === -1) {
    // No braces found, return pattern as-is.
    return [pattern]
  }

  // Scan forward from the first '{' tracking brace depth to find its matching
  // '}' (the point where depth returns to 0). Record the top-level comma
  // positions (depth === 1) so we split alternatives on those only — commas
  // nested deeper belong to sub-groups and are left for the recursion.
  let depth = 0
  let close = -1
  const topLevelCommas: number[] = []
  for (let i = open; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '{') {
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0) {
        close = i
        break
      }
    } else if (char === ',' && depth === 1) {
      topLevelCommas.push(i)
    }
  }

  if (close === -1) {
    // Unbalanced braces (no matching '}'): treat as literal, return unchanged.
    return [pattern]
  }

  if (close === open + 1) {
    // Empty brace group `{}` is not an alternation. The previous regex required
    // at least one inner character, so `{}` stayed literal; expanding it to an
    // empty alternative would collapse `paths: "{}"` to `[""]`, and both
    // parseSkillPaths and the CLAUDE.md path parser filter that empty string and
    // treat the file as having NO path restriction (applying everywhere).
    // Keep the `{}` literal, but still expand any later groups in the suffix.
    return expandBraces(pattern.slice(close + 1)).map(
      rest => pattern.slice(0, close + 1) + rest,
    )
  }

  const prefix = pattern.slice(0, open)
  const inner = pattern.slice(open + 1, close)
  const suffix = pattern.slice(close + 1)

  // Split the inner content on top-level commas (relative to `inner`, whose
  // indices are offset by open + 1 from the recorded positions).
  const alternatives: string[] = []
  let start = 0
  for (const commaIndex of topLevelCommas) {
    const rel = commaIndex - (open + 1)
    alternatives.push(inner.slice(start, rel))
    start = rel + 1
  }
  alternatives.push(inner.slice(start))

  // Recursively expand each option combined with the surrounding prefix/suffix,
  // which also handles any further brace groups in the suffix.
  const expanded: string[] = []
  for (const alternative of alternatives) {
    const combined = prefix + alternative.trim() + suffix
    expanded.push(...expandBraces(combined))
  }

  return expanded
}

/**
 * Parses a positive integer value from frontmatter.
 * Handles both number and string representations.
 *
 * @param value The raw value from frontmatter (could be number, string, or undefined)
 * @returns The parsed positive integer, or undefined if invalid or not provided
 */
export function parsePositiveIntFromFrontmatter(
  value: unknown,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined
  }

  const parsed =
    typeof value === 'number'
      ? value
      : /^\d+$/.test(String(value).trim())
        ? Number(String(value).trim())
        : NaN

  if (Number.isSafeInteger(parsed) && parsed > 0) {
    return parsed
  }

  return undefined
}

/**
 * Validate and coerce a description value from frontmatter.
 *
 * Strings are returned as-is (trimmed). Primitive values (numbers, booleans)
 * are coerced to strings via String(). Non-scalar values (arrays, objects)
 * are invalid and are logged then omitted. Null, undefined, and
 * empty/whitespace-only strings return null so callers can fall back to
 * a default.
 *
 * @param value - The raw frontmatter description value
 * @param componentName - The skill/command/agent/style name for log messages
 * @param pluginName - The plugin name, if this came from a plugin
 */
export function coerceDescriptionToString(
  value: unknown,
  componentName?: string,
  pluginName?: string,
): string | null {
  if (value == null) {
    return null
  }
  if (typeof value === 'string') {
    return value.trim() || null
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  // Non-scalar descriptions (arrays, objects) are invalid — log and omit
  const source = pluginName
    ? `${pluginName}:${componentName}`
    : (componentName ?? 'unknown')
  logForDebugging(`Description invalid for ${source} - omitting`, {
    level: 'warn',
  })
  return null
}

/**
 * Parse a boolean frontmatter value.
 * Only returns true for literal true or "true" string.
 */
export function parseBooleanFrontmatter(value: unknown): boolean {
  return value === true || value === 'true'
}

/**
 * Shell values accepted in `shell:` frontmatter for .md `!`-block execution.
 */
export type FrontmatterShell = 'bash' | 'powershell'

const FRONTMATTER_SHELLS: readonly FrontmatterShell[] = ['bash', 'powershell']

/**
 * Parse and validate the `shell:` frontmatter field.
 *
 * Returns undefined for absent/null/empty (caller defaults to bash).
 * Logs a warning and returns undefined for unrecognized values — we fall
 * back to bash rather than failing the skill load, matching how `effort`
 * and other fields degrade.
 */
export function parseShellFrontmatter(
  value: unknown,
  source: string,
): FrontmatterShell | undefined {
  if (value == null) {
    return undefined
  }
  const normalized = String(value).trim().toLowerCase()
  if (normalized === '') {
    return undefined
  }
  if ((FRONTMATTER_SHELLS as readonly string[]).includes(normalized)) {
    return normalized as FrontmatterShell
  }
  logForDebugging(
    `Frontmatter 'shell: ${value}' in ${source} is not recognized. Valid values: ${FRONTMATTER_SHELLS.join(', ')}. Falling back to bash.`,
    { level: 'warn' },
  )
  return undefined
}
