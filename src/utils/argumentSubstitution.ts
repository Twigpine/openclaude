/**
 * Utility for substituting $ARGUMENTS placeholders in skill/command prompts.
 *
 * Supports:
 * - $ARGUMENTS - replaced with the full arguments string
 * - $ARGUMENTS[0], $ARGUMENTS[1], etc. - replaced with individual indexed arguments
 * - $0, $1, etc. - shorthand for $ARGUMENTS[0], $ARGUMENTS[1]
 * - Named arguments (e.g., $foo, $bar) - when argument names are defined in frontmatter
 *
 * Arguments are parsed using shell-quote for proper shell argument handling.
 */

import { randomBytes } from 'crypto'
import { tryParseShellCommand } from './bash/shellQuote.js'
import { escapeRegExp } from './stringUtils.js'

/**
 * Parse an arguments string into an array of individual arguments.
 * Uses shell-quote for proper shell argument parsing including quoted strings.
 *
 * Examples:
 * - "foo bar baz" => ["foo", "bar", "baz"]
 * - 'foo "hello world" baz' => ["foo", "hello world", "baz"]
 * - "foo 'hello world' baz" => ["foo", "hello world", "baz"]
 */
export function parseArguments(args: string): string[] {
  if (!args || !args.trim()) {
    return []
  }

  // Return $KEY to preserve variable syntax literally (don't expand variables)
  const result = tryParseShellCommand(args, key => `$${key}`)
  if (!result.success) {
    // Fall back to simple whitespace split if parsing fails
    return args.split(/\s+/).filter(Boolean)
  }

  // Filter to only string tokens (ignore shell operators, etc.)
  return result.tokens.filter(
    (token): token is string => typeof token === 'string',
  )
}

/**
 * Parse argument names from the frontmatter 'arguments' field.
 * Accepts either a space-separated string or an array of strings.
 *
 * Examples:
 * - "foo bar baz" => ["foo", "bar", "baz"]
 * - ["foo", "bar", "baz"] => ["foo", "bar", "baz"]
 */
export function parseArgumentNames(
  argumentNames: string | string[] | undefined,
): string[] {
  if (!argumentNames) {
    return []
  }

  // Filter out empty strings and numeric-only names (which conflict with $0, $1 shorthand)
  const isValidName = (name: string): boolean =>
    typeof name === 'string' && name.trim() !== '' && !/^\d+$/.test(name)

  if (Array.isArray(argumentNames)) {
    return argumentNames.filter(isValidName)
  }
  if (typeof argumentNames === 'string') {
    return argumentNames.split(/\s+/).filter(isValidName)
  }
  return []
}

/**
 * Generate argument hint showing remaining unfilled args.
 * @param argNames - Array of argument names from frontmatter
 * @param typedArgs - Arguments the user has typed so far
 * @returns Hint string like "[arg2] [arg3]" or undefined if all filled
 */
export function generateProgressiveArgumentHint(
  argNames: string[],
  typedArgs: string[],
): string | undefined {
  const remaining = argNames.slice(typedArgs.length)
  if (remaining.length === 0) return undefined
  return remaining.map(name => `[${name}]`).join(' ')
}

/**
 * Substitute $ARGUMENTS placeholders in content with actual argument values.
 *
 * @param content - The content containing placeholders
 * @param args - The raw arguments string (may be undefined/null)
 * @param appendIfNoPlaceholder - If true and no placeholders are found, appends "ARGUMENTS: {args}" to content
 * @param argumentNames - Optional array of named arguments (e.g., ["foo", "bar"]) that map to indexed positions
 * @returns The content with placeholders substituted
 */
export function substituteArguments(
  content: string,
  args: string | undefined,
  appendIfNoPlaceholder = true,
  argumentNames: string[] = [],
): string {
  // undefined/null means no args provided - return content unchanged
  // empty string is a valid input that should replace placeholders with empty
  if (args === undefined || args === null) {
    return content
  }

  const parsedArgs = parseArguments(args)
  const originalContent = content

  // Each pass below substitutes into `content`, and the passes that follow it
  // then re-scan whatever it inserted. Argument text legitimately containing a
  // placeholder token (`$1`, `$ARGUMENTS[0]`, ...) would therefore be rewritten
  // again by a later pass — e.g. `$name` = `$1` used to come back as the *second*
  // argument. Park every substituted value behind an opaque slot token and swap
  // the real values back in once all passes are done, so a value is only ever
  // inserted, never interpreted. The token is NUL-delimited and salted, so it
  // cannot collide with (or be forged by) user text and adds no visible output.
  const slots: string[] = []
  const slotSalt = randomBytes(8).toString('hex')
  const slotToken = (value: string): string => {
    slots.push(value)
    return `\x00ARG_${slotSalt}_${slots.length - 1}\x00`
  }

  // Replace named arguments (e.g., $foo, $bar) with their values
  // Named arguments map to positions: argumentNames[0] -> parsedArgs[0], etc.
  for (let i = 0; i < argumentNames.length; i++) {
    const name = argumentNames[i]
    if (!name) continue

    // Match $name but not $name[...] or $nameXxx (word chars)
    // Also ensure we match word boundaries to avoid partial matches.
    // escapeRegExp: the name comes from author-defined frontmatter, so a name
    // containing regex metacharacters would otherwise throw (unbalanced `(`/`[`)
    // or over-match (`a.` matching `$ab`) — parseArgumentNames does not restrict
    // the character set beyond rejecting empty/numeric-only names.
    const value = parsedArgs[i] ?? ''
    content = content.replace(
      new RegExp(`\\$${escapeRegExp(name)}(?![\\[\\w])`, 'g'),
      () => slotToken(value),
    )
  }

  // Replace indexed arguments ($ARGUMENTS[0], $ARGUMENTS[1], etc.)
  content = content.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, indexStr: string) => {
    const index = parseInt(indexStr, 10)
    return slotToken(parsedArgs[index] ?? '')
  })

  // Replace shorthand indexed arguments ($0, $1, etc.)
  content = content.replace(/\$(\d+)(?!\w)/g, (_, indexStr: string) => {
    const index = parseInt(indexStr, 10)
    return slotToken(parsedArgs[index] ?? '')
  })

  // Replace $ARGUMENTS with the full arguments string
  content = content.replaceAll('$ARGUMENTS', () => slotToken(args))

  // Swap the parked values back in. A function replacer keeps `$`-sequences in
  // the user's argument text (`$$`, `$&`, `` $` ``, `$'`, `$n`) literal instead
  // of letting String.replace treat them as match references.
  content = content.replace(
    new RegExp(`\x00ARG_${slotSalt}_(\\d+)\x00`, 'g'),
    (_, indexStr: string) => slots[Number(indexStr)] ?? '',
  )

  // If no placeholders were found and appendIfNoPlaceholder is true, append
  // But only if args is non-empty (empty string means command invoked with no args)
  if (content === originalContent && appendIfNoPlaceholder && args) {
    content = content + `\n\nARGUMENTS: ${args}`
  }

  return content
}
