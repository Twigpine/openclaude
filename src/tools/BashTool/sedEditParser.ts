/**
 * Parser for sed edit commands (-i flag substitutions)
 * Extracts file paths and substitution patterns to enable file-edit-style rendering
 */

import { randomBytes } from 'crypto'
import { tryParseShellCommand } from '../../utils/bash/shellQuote.js'

// BRE→ERE conversion placeholders (null-byte sentinels, never appear in user input)

export type SedEditInfo = {
  /** The file path being edited */
  filePath: string
  /** The search pattern (regex) */
  pattern: string
  /** The replacement string */
  replacement: string
  /** Substitution flags (g, i, etc.) */
  flags: string
  /** Whether to use extended regex (-E or -r flag) */
  extendedRegex: boolean
}

// Escaped forms that are portable POSIX BRE operators: `\(` `\)` (grouping).
// The escaped forms of the characters below are NOT portable — `\+` `\?` `\|`
// are GNU extensions that BSD/macOS sed matches literally — so they decline
// instead (see the branch handling them).
const BRE_PORTABLE_OPERATOR_ESCAPES = '()'

// JS regex metacharacters that are literal when bare in BRE (the reverse of
// JS), so they must be escaped in the translation. Braces are handled
// separately because they only form an operator when escaped around a valid
// count.
const BRE_BARE_LITERAL_METACHARS = '+?|()'

/**
 * Translate the body of a BRE interval `\{...\}` to its JS quantifier form, or
 * null when it cannot be previewed faithfully. Only the POSIX-portable forms
 * `n`, `n,` and `n,m` are accepted: the GNU-only `,m` extension is rejected by
 * BSD/macOS sed (which this parser explicitly supports via its `-i ''`
 * handling), so previewing it would show an edit on platforms where the real
 * command fails and changes nothing. Anything else — empty, extra commas,
 * non-numeric — is rejected by sed itself ("Invalid content of \{\}"), which
 * aborts the command and leaves the file untouched.
 */
function breIntervalBodyToJs(body: string): string | null {
  if (/^[0-9]+(,[0-9]*)?$/.test(body)) {
    return `{${body}}`
  }
  return null
}

/**
 * Find the index of the `]` closing the BRE bracket expression that starts at
 * `open`, or -1 when it is never closed. A `]` in the first position (after an
 * optional leading `^`) is an ordinary member, not the terminator.
 */
function findBracketEnd(pattern: string, open: number): number {
  let i = open + 1
  if (pattern[i] === '^') i++
  if (pattern[i] === ']') i++
  for (; i < pattern.length; i++) {
    if (pattern[i] === ']') return i
  }
  return -1
}

/**
 * True when a bracket expression opens with a `]` member (`[]]`, `[^]]`).
 *
 * POSIX treats that first `]` as an ordinary member, so `s/[]]/X/g` rewrites
 * "a]b" to "aXb". JavaScript reads it as the class terminator instead, leaving
 * the text untouched, so the two dialects disagree and the pattern declines.
 */
function bracketHasLeadingCloseMember(pattern: string, open: number): boolean {
  let i = open + 1
  if (pattern[i] === '^') i++
  return pattern[i] === ']'
}

/**
 * Convert a BRE pattern to its JS equivalent, or null when it cannot be
 * translated faithfully and the caller must decline to simulate the edit.
 */
function convertBrePatternToJs(pattern: string): string | null {
  if (!breAnchorsAreUnambiguous(pattern)) return null
  let result = ''

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!

    if (char === '[') {
      // Inside a bracket expression `\{`/`\}` are ordinary members rather than
      // an interval, so the interval scan below must not see them. Several
      // bracket constructs cannot be previewed faithfully and must decline:
      //  - an unterminated `[` is an error in sed (file untouched), not a
      //    literal;
      //  - a backslash is a literal member in a POSIX bracket expression but an
      //    escape in a JS character class;
      //  - `[:class:]`, `[=equiv=]` and `[.collate.]` constructs mean nothing
      //    to JS, which would read them as a plain set of characters.
      const end = findBracketEnd(pattern, i)
      if (end === -1) return null
      if (bracketHasLeadingCloseMember(pattern, i)) return null
      const body = pattern.slice(i, end + 1)
      if (body.includes('\\') || body.slice(1).includes('[')) return null
      // Remaining members are literal in both dialects; carry the body as-is.
      result += body
      i = end
      continue
    }

    if (char === '\\') {
      const next = pattern[i + 1]
      if (next === undefined) {
        result += '\\\\'
        continue
      }
      if (next === '{') {
        // `\{...\}` is the BRE interval quantifier. An unterminated or
        // illegal-bodied interval is an error in sed rather than a literal, so
        // decline instead of emitting braces that would match something else.
        const close = pattern.indexOf('\\}', i + 2)
        if (close === -1) return null
        const js = breIntervalBodyToJs(pattern.slice(i + 2, close))
        if (js === null) return null
        result += js
        i = close + 1 // consume through the closing `\}`
        continue
      }
      if (next === '}') {
        // A stray escaped closing brace with no matching interval open: literal.
        result += '\\}'
        i++
        continue
      }
      if (next === '|') {
        // GNU alternation extension. Doubly unfaithful: BSD/macOS sed matches
        // `\|` as a literal pipe, and even on GNU, POSIX regex selects the
        // leftmost-longest alternative while JavaScript takes the first one
        // that matches (`\(a\|aa\)` previews `aa` as `Xa` where GNU sed writes
        // `X`). Decline.
        return null
      }
      if (next === '+' || next === '?') {
        // GNU extensions: BSD/macOS sed matches `\+` and `\?` as literal
        // `+`/`?`, so one platform's operator is the other's literal and a
        // single preview cannot be right for both. Decline.
        return null
      }
      if (next === '\\') {
        result += '\\\\'
      } else if (BRE_PORTABLE_OPERATOR_ESCAPES.includes(next)) {
        result += next
      } else if (BRE_PORTABLE_LITERAL_ESCAPES.includes(next)) {
        result += `\\${next}`
      } else {
        // Not a portable escape: its sed meaning is not the JS meaning.
        return null
      }
      i++
      continue
    }

    if (BRE_BARE_LITERAL_METACHARS.includes(char)) {
      result += `\\${char}`
      continue
    }

    // Bare braces are literal in BRE (the reverse of JS), so escape them.
    if (char === '{' || char === '}') {
      result += `\\${char}`
      continue
    }

    result += char
  }

  return result
}

/**
 * Only replacements that are pure literal text can be previewed.
 *
 * sed's replacement syntax has its own meanings that this module does not
 * translate: `\1`-`\9` are backreferences, `&` is the whole match, `\n`/`\t`
 * are escapes, and `\U`/`\L` (GNU) case-fold. The simulator passes the
 * replacement to String.replace as-is, so `s/\(a\)\{2\}/\1/` writes the two
 * literal characters `\1` where sed writes `a`.
 *
 * `\/` and `\&` are the exceptions: both denote a literal character, and the
 * translation below already handles them, so rejecting them would send
 * ordinary commands like `s/foo/path\/to/` back to the generic bash approval
 * for no reason. Every other backslash escape, and a bare `&` (sed's
 * whole-match token), declines.
 */
function isFaithfullyLiteralReplacement(replacement: string): boolean {
  for (let i = 0; i < replacement.length; i++) {
    const char = replacement[i]!
    if (char === '\\') {
      const escaped = replacement[i + 1]
      if (escaped !== '/' && escaped !== '&') return false
      i++
      continue
    }
    if (char === '&') return false
  }
  return true
}

/**
 * `$` is an ordinary character in a sed replacement but a substitution token in
 * a JS one: `$1`, `$$`, `` $` `` and `$'` all expand. `s/\(a\)/$1/` is a
 * literal replacement by the rule above, yet String.replace would write the
 * matched text where sed writes the two characters `$1`. Doubling each `$` is
 * the documented way to emit one literally.
 */
function escapeJsReplacement(replacement: string): string {
  return replacement.replaceAll('$', '$$$$')
}

/**
 * Escapes that mean the same thing in a POSIX BRE and in the emitted JS regex.
 *
 * Everything outside this set declines. GNU sed reads `\<`/`\>` as word
 * boundaries while JS reads them as literal angle brackets, so `s/\<foo\>/X/g`
 * previews no change while sed rewrites the file; `\d` has the converse problem
 * (a digit class in JS, a literal `d` in BRE). Carrying unhandled escapes
 * through means the emitted regex is not the pattern sed was given.
 */
const BRE_PORTABLE_LITERAL_ESCAPES = '.*[]^$/'

/**
 * `^` and `$` are only anchors at the start/end of a BRE or of a `\( \)`
 * subexpression; anywhere else sed matches them literally, while JS always
 * reads them as anchors. `s/a^b/X/` would therefore be accepted and preview no
 * edit while sed rewrites the literal text. Rather than model every
 * subexpression boundary, decline when either character appears outside the
 * positions where both dialects agree it anchors.
 */
function breAnchorsAreUnambiguous(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === '\\') {
      i++
      continue
    }
    if (char === '[') {
      const end = findBracketEnd(pattern, i)
      if (end === -1) return false
      i = end
      continue
    }
    // A leading `^` and a trailing `$` are anchors in both dialects.
    if (char === '^' && i !== 0) return false
    if (char === '$' && i !== pattern.length - 1) return false
  }
  return true
}

/**
 * Check if a command is a sed in-place edit command
 * Returns true only for simple sed -i 's/pattern/replacement/flags' file commands
 */
export function isSedInPlaceEdit(command: string): boolean {
  const info = parseSedEditCommand(command)
  return info !== null
}

/**
 * Parse a sed edit command and extract the edit information
 * Returns null if the command is not a valid sed in-place edit
 */
export function parseSedEditCommand(command: string): SedEditInfo | null {
  const trimmed = command.trim()

  // Must start with sed
  const sedMatch = trimmed.match(/^\s*sed\s+/)
  if (!sedMatch) return null

  const withoutSed = trimmed.slice(sedMatch[0].length)
  const parseResult = tryParseShellCommand(withoutSed)
  if (!parseResult.success) return null
  const tokens = parseResult.tokens

  // Extract string tokens only
  const args: string[] = []
  for (const token of tokens) {
    if (typeof token === 'string') {
      args.push(token)
    } else if (
      typeof token === 'object' &&
      token !== null &&
      'op' in token &&
      token.op === 'glob'
    ) {
      // Glob patterns are too complex for this simple parser
      return null
    }
  }

  // Parse flags and arguments
  let hasInPlaceFlag = false
  let extendedRegex = false
  let expression: string | null = null
  let filePath: string | null = null

  let i = 0
  while (i < args.length) {
    const arg = args[i]!

    // Handle -i flag (with or without backup suffix)
    if (arg === '-i' || arg === '--in-place') {
      hasInPlaceFlag = true
      i++
      // On macOS, -i requires a suffix argument (even if empty string)
      // Check if next arg looks like a backup suffix (empty, or starts with dot)
      // Don't consume flags (-E, -r) or sed expressions (starting with s, y, d)
      if (i < args.length) {
        const nextArg = args[i]
        // If next arg is empty string or starts with dot, it's a backup suffix
        if (
          typeof nextArg === 'string' &&
          !nextArg.startsWith('-') &&
          (nextArg === '' || nextArg.startsWith('.'))
        ) {
          i++ // Skip the backup suffix
        }
      }
      continue
    }
    if (arg.startsWith('-i')) {
      // -i.bak or similar (inline suffix)
      hasInPlaceFlag = true
      i++
      continue
    }

    // Handle extended regex flags
    if (arg === '-E' || arg === '-r' || arg === '--regexp-extended') {
      extendedRegex = true
      i++
      continue
    }

    // Handle -e flag with expression
    if (arg === '-e' || arg === '--expression') {
      if (i + 1 < args.length && typeof args[i + 1] === 'string') {
        // Only support single expression
        if (expression !== null) return null
        expression = args[i + 1]!
        i += 2
        continue
      }
      return null
    }
    if (arg.startsWith('--expression=')) {
      if (expression !== null) return null
      expression = arg.slice('--expression='.length)
      i++
      continue
    }

    // Skip other flags we don't understand
    if (arg.startsWith('-')) {
      // Unknown flag - not safe to parse
      return null
    }

    // Non-flag argument
    if (expression === null) {
      // First non-flag arg is the expression
      expression = arg
    } else if (filePath === null) {
      // Second non-flag arg is the file path
      filePath = arg
    } else {
      // More than one file - not supported for simple rendering
      return null
    }

    i++
  }

  // Must have -i flag, expression, and file path
  if (!hasInPlaceFlag || !expression || !filePath) {
    return null
  }

  // Parse the substitution expression: s/pattern/replacement/flags
  // Only support / as delimiter for simplicity
  const substMatch = expression.match(/^s\//)
  if (!substMatch) {
    return null
  }

  const rest = expression.slice(2) // Skip 's/'

  // Find pattern and replacement by tracking escaped characters
  let pattern = ''
  let replacement = ''
  let flags = ''
  let state: 'pattern' | 'replacement' | 'flags' = 'pattern'
  let j = 0

  while (j < rest.length) {
    const char = rest[j]!

    if (char === '\\' && j + 1 < rest.length) {
      // Escaped character
      if (state === 'pattern') {
        pattern += char + rest[j + 1]
      } else if (state === 'replacement') {
        replacement += char + rest[j + 1]
      } else {
        flags += char + rest[j + 1]
      }
      j += 2
      continue
    }

    if (char === '/') {
      if (state === 'pattern') {
        state = 'replacement'
      } else if (state === 'replacement') {
        state = 'flags'
      } else {
        // Extra delimiter in flags - unexpected
        return null
      }
      j++
      continue
    }

    if (state === 'pattern') {
      pattern += char
    } else if (state === 'replacement') {
      replacement += char
    } else {
      flags += char
    }
    j++
  }

  // Must have found all three parts (pattern, replacement delimiter, and optional flags)
  if (state !== 'flags') {
    return null
  }

  // Only the flags this module actually models. `1`-`9` select the Nth match on
  // each line and `p` prints, neither of which the simulator implements — it
  // always rewrites the first match (or every match under `g`), so
  // `s/a\{2\}/X/2` on "aaaa" would be previewed as "Xaa" where sed writes
  // "aaX". `m`/`M` redefine `^`/`$` per line inside the pattern space. Decline
  // all of them rather than approve a write that differs from the command.
  //
  // `i`/`I` are declined for a subtler reason: the emitted regex needs `u` for
  // the quantifier fix, and `u` + `i` selects ECMAScript Unicode case folding
  // rather than sed's locale-based matching. `s/k/X/I` would then rewrite a
  // Kelvin sign, which GNU sed under C.UTF-8 leaves alone. Until that folding
  // can be modeled, an approved preview would not be the edit sed performs.
  // At most one `g`: GNU sed rejects a repeated flag ("multiple `g' options to
  // `s' command"), so a `gg` that this module previewed as a successful global
  // rewrite would diverge from the command sed actually refuses to run.
  const validFlags = /^g?$/
  if (!validFlags.test(flags)) {
    return null
  }

  // The emitted regex counts characters, which is only what sed does in a
  // UTF-8 locale; under a byte locale it counts bytes and writes a different
  // file.
  if (!sedLocaleCountsCharacters()) {
    return null
  }

  // Only claim this is a renderable sed edit if we can reproduce it faithfully.
  // Declining falls back to ordinary bash rendering, which is far better than
  // showing the user a diff that does not match what sed will write.
  if (!canSimulateFaithfully(pattern, flags, extendedRegex)) {
    return null
  }

  if (!isFaithfullyLiteralReplacement(replacement)) {
    return null
  }

  return {
    filePath,
    pattern,
    replacement,
    flags,
    extendedRegex,
  }
}

/**
 * Escapes that denote the same literal character in a POSIX ERE and in the
 * emitted JS regex: the ERE metacharacters, plus the delimiter and a literal
 * backslash.
 *
 * ERE patterns are handed to JS verbatim, so an escape outside this set is not
 * the pattern sed was given. `\d` is the clearest case -- GNU sed reads it as a
 * literal `d`, JS as a digit class, so `sed -E 's/\d/X/g'` on "1d2" previews
 * "XdX" while sed writes "1X2". `\w`, `\s`, `\b` and `\u{...}` diverge the same
 * way, and several are not valid sed at all.
 */
const ERE_PORTABLE_LITERAL_ESCAPES = '.*[]^$/+?(){}|\\'

/**
 * Reject ERE constructs whose behavior in a JS regex is not the POSIX behavior.
 * The BRE converter declines these itself; ERE patterns carry over verbatim, so
 * they need the same screening:
 *  - alternation: POSIX picks the leftmost-longest alternative, JS the first
 *    that matches;
 *  - bracket expressions holding a backslash (literal member in POSIX, escape
 *    in JS), a POSIX `[:class:]`-style construct, or no terminator at all
 *    (an error in sed, not a literal);
 *  - escapes outside the set that is literal in both dialects (see
 *    ERE_PORTABLE_LITERAL_ESCAPES).
 */
function ereHasUnfaithfulConstructs(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === '\\') {
      const escaped = pattern[i + 1]
      if (escaped === undefined) return true
      if (!ERE_PORTABLE_LITERAL_ESCAPES.includes(escaped)) return true
      i++
      continue
    }
    if (char === '|') return true
    if (char === '^' && i !== 0) return true
    if (char === '$' && i !== pattern.length - 1) return true
    if (char === '(' && pattern[i + 1] === '?') {
      // POSIX/GNU `sed -E` supports only plain capturing groups `(...)`. A `(?`
      // opens JavaScript-only syntax -- non-capturing `(?:)`, lookaround
      // `(?=)`/`(?!)`/`(?<=)`/`(?<!)`, and named `(?<name>)` groups -- which JS
      // compiles but GNU sed rejects ("Invalid preceding regular expression").
      // The simulator would render a concrete edit for a command sed refuses to
      // run, so decline.
      return true
    }
    if (char === '{') {
      // JS reads an illegal interval body as literal braces, but GNU sed either
      // errors or applies its own extension: `sed -E 's/a{,3}/X/g'` rewrites
      // "aaaab" to "XXbX" while JS matches the literal text "a{,3}". BSD has no
      // portable behavior here either, so anything outside the POSIX forms
      // declines.
      const close = pattern.indexOf('}', i + 1)
      if (close === -1) return true
      if (breIntervalBodyToJs(pattern.slice(i + 1, close)) === null) return true
      i = close
      continue
    }
    if (char === '[') {
      const end = findBracketEnd(pattern, i)
      if (end === -1) return true
      if (bracketHasLeadingCloseMember(pattern, i)) return true
      const body = pattern.slice(i + 1, end)
      if (body.includes('\\') || body.includes('[')) return true
      i = end
    }
  }
  return false
}

/**
 * Convert the sed pattern to the JS regex source this module would run, or null
 * if it cannot be translated faithfully.
 */
function toJsPatternSource(
  pattern: string,
  extendedRegex: boolean,
): string | null {
  const unescaped = pattern.replace(/\\\//g, '/')
  if (extendedRegex) {
    return ereHasUnfaithfulConstructs(unescaped) ? null : unescaped
  }
  return convertBrePatternToJs(unescaped)
}

/**
 * Whether the simulated substitution is guaranteed to match what sed does.
 *
 * Declined here:
 *  - the pattern does not translate — GNU-only interval forms, alternation,
 *    untranslatable or unterminated bracket expressions (see
 *    convertBrePatternToJs / ereHasUnfaithfulConstructs) — or the translation
 *    is not a valid JS regex (previously this threw and was swallowed into a
 *    "no change" preview);
 *  - the pattern can match the empty string under `g`. sed and JS advance
 *    differently after an empty match, so the results genuinely differ:
 *    `s/a*​/X/g` on "aaaab" is "XbX" in sed but "XXbX" in JS, and
 *    `s/a\{0,3\}/X/g` is "XXbX" in sed but "XXXbX" in JS.
 */
function canSimulateFaithfully(
  pattern: string,
  flags: string,
  extendedRegex: boolean,
): boolean {
  // A standalone `s//X/` has no previous regular expression to reuse, so sed
  // errors and leaves the file untouched. JS would compile an empty regex that
  // matches at every position and prefix every line.
  if (pattern === '') return false

  const jsPattern = toJsPatternSource(pattern, extendedRegex)
  if (jsPattern === null) return false

  let regex: RegExp
  try {
    // Same flags the simulator will use, so a source that only compiles without
    // them cannot slip through the gate.
    regex = new RegExp(jsPattern, jsRegexFlags(flags))
  } catch {
    return false
  }

  if (flags.includes('g') && regex.test('')) return false

  if (hasNestedQuantifier(jsPattern)) return false

  return true
}

/**
 * Whether a quantifier is applied to a group that already contains one.
 *
 * Interval support means `\(a\{1,\}\)\{1,\}b` translates to `(a{1,}){1,}b` and
 * otherwise passes this gate. On a run of `a`s with no `b`, matching that
 * backtracks exponentially -- and applySedSubstitution runs synchronously while
 * the permission request is being rendered, so a command plus a repository file
 * can stall the approval UI before the user gets to decide. There is no useful
 * preview to salvage here, so decline.
 */
function hasNestedQuantifier(jsSource: string): boolean {
  const isQuantifierStart = (char: string | undefined): boolean =>
    char === '*' || char === '+' || char === '?' || char === '{'

  for (let i = 0; i < jsSource.length; i++) {
    const char = jsSource[i]!
    if (char === '\\') {
      i++
      continue
    }
    if (char !== ')' || !isQuantifierStart(jsSource[i + 1])) continue

    // Walk back to this group's opening paren, then look for a quantifier
    // inside it. Escaped parens are literals and do not open or close a group.
    let depth = 0
    for (let j = i; j >= 0; j--) {
      if (j > 0 && jsSource[j - 1] === '\\') continue
      const inner = jsSource[j]!
      if (inner === ')') depth++
      else if (inner === '(') {
        depth--
        if (depth === 0) {
          const body = jsSource.slice(j + 1, i)
          for (let k = 0; k < body.length; k++) {
            if (body[k] === '\\') {
              k++
              continue
            }
            if (isQuantifierStart(body[k])) return true
          }
          break
        }
      }
    }
  }
  return false
}

/**
 * The JS flags that reproduce sed's matching for the accepted flag subset.
 *
 * `u` is not optional: in the UTF-8 locales sed runs in, a quantifier counts
 * characters, while a non-unicode JS regex counts UTF-16 code units — without
 * it `s/.\{2\}/X/` turns "\u{1F600}a" into "Xa" (consuming only the emoji's
 * surrogate pair) where sed writes "X".
 *
 * `s` makes `.` match every character in the line. sed's pattern space holds a
 * lone `\r` on CRLF input and `.` matches it, but a JS `.` excludes carriage
 * returns, so `sed 's/./X/g'` on "a\r\n" writes "XX" where an unflagged
 * simulation writes "X\r".
 *
 * There is deliberately no `i` here: `u` + `i` is Unicode case folding, not
 * sed's locale matching, so `i`/`I` are declined at the flag gate instead.
 */
function jsRegexFlags(sedFlags: string): string {
  let flags = 'us'
  if (sedFlags.includes('g')) flags += 'g'
  return flags
}

/**
 * Whether the locale sed will inherit makes character-wise matching correct.
 *
 * The emitted regex always carries `u`, which is required for a quantifier to
 * count characters the way sed does in a UTF-8 locale. But the command inherits
 * the process locale, and in a byte locale (`LC_ALL=C`) sed counts bytes
 * instead: `s/.\{2\}/X/` on "😀a" consumes two bytes of the emoji and leaves
 * the rest of it in the file, where the simulation consumes the whole
 * character. Since an approved preview is written directly, that is a different
 * file.
 *
 * POSIX resolves the locale as LC_ALL, then LC_CTYPE, then LANG, and an unset
 * or empty locale means the C locale -- so require an explicit UTF-8 codeset
 * rather than assuming one. Declining costs only the specialized diff; the
 * command still renders as an ordinary bash approval.
 *
 * Exported for testing.
 */
export function sedLocaleCountsCharacters(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || ''
  // Either a codeset suffix ("en_US.UTF-8", "de_DE.utf8@euro") or the bare
  // codeset, which is what macOS sets for LC_CTYPE.
  return /(^|[.@])utf-?8($|@)/i.test(locale)
}

/**
 * Apply a sed substitution to file content
 * Returns the new content after applying the substitution
 */
export function applySedSubstitution(
  content: string,
  sedInfo: SedEditInfo,
): string {
  const regexFlags = jsRegexFlags(sedInfo.flags)

  // Convert sed pattern to JavaScript regex pattern. In BRE mode (no -E flag)
  // metacharacters have opposite escaping: BRE `\+` means "one or more" and `+`
  // is literal, the reverse of ERE/JS.
  const jsPattern = toJsPatternSource(sedInfo.pattern, sedInfo.extendedRegex)
  if (jsPattern === null) {
    // Not translatable. parseSedEditCommand rejects these up front, so this is
    // only reachable for a hand-built SedEditInfo; leave the content untouched.
    return content
  }

  // Unescape sed-specific escapes in replacement
  // Convert \n to newline, & to $& (match), etc.
  // Use a unique placeholder with random salt to prevent injection attacks
  const salt = randomBytes(8).toString('hex')
  const ESCAPED_AMP_PLACEHOLDER = `___ESCAPED_AMPERSAND_${salt}___`
  const jsReplacement = escapeJsReplacement(sedInfo.replacement)
    // Unescape \/ to /
    .replace(/\\\//g, '/')
    // First escape \& to a placeholder
    .replace(/\\&/g, ESCAPED_AMP_PLACEHOLDER)
    // Convert & to $& (full match) - use $$& to get literal $& in output
    .replace(/&/g, '$$&')
    // Convert placeholder back to literal &
    .replace(new RegExp(ESCAPED_AMP_PLACEHOLDER, 'g'), '&')

  let regex: RegExp
  try {
    regex = new RegExp(jsPattern, regexFlags)
  } catch {
    // If regex is invalid, return original content
    return content
  }

  // An empty file has no lines, so sed never runs the substitution and the
  // output stays empty; splitting '' would fabricate one empty line and let
  // anchored patterns like s/^/X/ preview an edit sed does not make.
  if (content.length === 0) {
    return content
  }

  // sed applies s/// to each line of the pattern space independently: without
  // `g` it substitutes the first match on EVERY line, not the first match in
  // the file. A single whole-buffer replace previewed `sed 's/a\{2\}/X/'` on
  // "aa\naa\n" as "X\naa\n" where sed writes "X\nX\n". Apply per line. A
  // trailing newline produces a final empty split element that corresponds to
  // no input line, so it is carried over untouched.
  const endsWithNewline = content.endsWith('\n')
  const body = endsWithNewline ? content.slice(0, -1) : content
  const result = body
    .split('\n')
    .map(line => line.replace(regex, jsReplacement))
    .join('\n')
  return endsWithNewline ? result + '\n' : result
}
