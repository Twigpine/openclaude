import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import {
  applySedSubstitution,
  parseSedEditCommand,
  sedLocaleCountsCharacters,
  type SedEditInfo,
} from './sedEditParser.js'

// Simulation is only claimed in a UTF-8 locale (see sedLocaleCountsCharacters),
// and CI machines do not reliably set one. Pin it so these cases exercise the
// translation rather than the locale gate; the gate has its own tests below.
const savedLcAll = process.env.LC_ALL
beforeAll(() => {
  process.env.LC_ALL = 'en_US.UTF-8'
})
afterAll(() => {
  if (savedLcAll === undefined) {
    delete process.env.LC_ALL
  } else {
    process.env.LC_ALL = savedLcAll
  }
})

function sedInfo(pattern: string, replacement: string, extendedRegex = false): SedEditInfo {
  return {
    filePath: 'example.txt',
    pattern,
    replacement,
    flags: 'g',
    extendedRegex,
  }
}

test('BRE mode keeps unescaped plus literal', () => {
  const result = applySedSubstitution(
    'a+b and aaab',
    sedInfo('a+b', 'literal-plus'),
  )

  expect(result).toBe('literal-plus and aaab')
})

test('BRE mode declines the GNU-only escaped plus and question mark', () => {
  // `\+` and `\?` are GNU extensions: BSD/macOS sed matches them as literal
  // `+`/`?`, so one platform's operator is the other's literal and a single
  // preview cannot be right for both.
  expect(
    parseSedEditCommand("sed -i '' 's/ab\\+/X/' example.txt"),
  ).toBeNull()
  expect(
    parseSedEditCommand("sed -i '' 's/ab\\?c/X/' example.txt"),
  ).toBeNull()
})

test('BRE mode preserves escaped backslashes', () => {
  const result = applySedSubstitution(
    String.raw`foo\bar foo/bar`,
    sedInfo(String.raw`foo\\bar`, 'backslash-match'),
  )

  expect(result).toBe('backslash-match foo/bar')
})

test('BRE mode treats escaped braces as an interval quantifier', () => {
  // `a\{2\}` is the BRE interval quantifier (exactly two a's). Before the fix
  // braces were omitted from the metacharacter set, so it was emitted as the
  // JS literal `a\{2\}` and matched nothing — the preview showed no change
  // while real sed rewrote the file.
  const result = applySedSubstitution('aa and a', sedInfo('a\\{2\\}', 'X'))
  expect(result).toBe('X and a')
})

test('BRE mode treats bare braces as literals', () => {
  // A bare `{2}` is literal in BRE, so it must not become a JS quantifier.
  const result = applySedSubstitution('a{2} and aa', sedInfo('a{2}', 'X'))
  expect(result).toBe('X and aa')
})

test('BRE mode supports escaped interval ranges', () => {
  // `b\{1,3\}` matches one-to-three b's; on "bbbc" it consumes the three b's
  // (the upper bound) and leaves the trailing "c".
  const result = applySedSubstitution('bbbc', sedInfo('b\\{1,3\\}', 'X'))
  expect(result).toBe('Xc')
})

test('BRE mode declines the GNU-only open lower-bound interval \\{,m\\}', () => {
  // `\{,3\}` is a GNU extension: BSD/macOS sed rejects it and leaves the file
  // untouched, and this parser explicitly supports macOS via its `-i ''`
  // handling. Previewing a {0,3} result would show an edit on platforms where
  // the real command fails, so no sed edit is claimed even without `g`.
  expect(
    parseSedEditCommand("sed -i '' 's/a\\{,3\\}/X/' example.txt"),
  ).toBeNull()
})

test('BRE mode supports the open upper-bound interval \\{n,\\}', () => {
  const result = applySedSubstitution('aaab', sedInfo('a\\{2,\\}', 'X'))
  expect(result).toBe('Xb')
})

test('BRE mode declines malformed intervals rather than guessing', () => {
  // GNU sed rejects both of these outright ("Invalid content of \{\}"), so the
  // command aborts and the file is untouched. They are not literal braces, and
  // there is no edit to render.
  expect(
    parseSedEditCommand("sed -i '' 's/a\\{\\}/X/g' example.txt"),
  ).toBeNull()
  expect(
    parseSedEditCommand("sed -i '' 's/a\\{1,2,3\\}/X/g' example.txt"),
  ).toBeNull()
})

test('BRE mode declines alternation rather than mis-selecting a branch', () => {
  // POSIX regex picks the leftmost-longest alternative while JavaScript picks
  // the first that matches: sed writes `\(a\|aa\)` on "aa" as "X", a JS
  // preview as "Xa". Selection cannot be reproduced, so no edit is claimed.
  expect(
    parseSedEditCommand("sed -i '' 's/cat\\|dog/X/g' example.txt"),
  ).toBeNull()
  expect(
    parseSedEditCommand("sed -i '' 's/\\(a\\|aa\\)\\{1\\}/X/' example.txt"),
  ).toBeNull()
})

test('BRE mode keeps escaped groups with portable interval quantifiers', () => {
  // `\(...\)` and `\{n\}` are POSIX BRE, supported identically by GNU and
  // BSD sed, so groups repeated via an interval still simulate.
  const result = applySedSubstitution('abab cd', sedInfo('\\(ab\\)\\{2\\}', 'X'))
  expect(result).toBe('X cd')
})

test('BRE mode applies g across multiple interval quantifiers', () => {
  const result = applySedSubstitution(
    'aabb aabb',
    sedInfo('a\\{2\\}b\\{2\\}', 'X'),
  )
  expect(result).toBe('X X')
})

test('ERE mode uses native brace intervals', () => {
  // Under -E the braces are already the JS quantifier form and must pass
  // through untouched.
  const result = applySedSubstitution('aaab', sedInfo('a{2}', 'X', true))
  expect(result).toBe('Xab')
})

describe('declines to simulate what it cannot reproduce faithfully', () => {
  const cmd = (expr: string) => `sed -i '' '${expr}' example.txt`

  test('rejects zero-minimum intervals under g', () => {
    // sed and JS advance differently past an empty match, so a global
    // zero-minimum quantifier genuinely diverges: GNU sed turns "aaaab" into
    // "XXbX" for both of these, while a JS global replace yields "XXXbX".
    // Rendering that as an approved file diff would show the user a change that
    // is not what sed writes, so no sed edit is claimed at all.
    expect(parseSedEditCommand(cmd('s/a\\{0,3\\}/X/g'))).toBeNull()
    expect(parseSedEditCommand(cmd('s/a\\{,3\\}/X/g'))).toBeNull()
    // Same class, pre-dating interval support: `*` also matches empty.
    expect(parseSedEditCommand(cmd('s/a*/X/g'))).toBeNull()
  })

  test('still simulates zero-minimum intervals without g', () => {
    // Only one substitution happens, so the empty-match advance never matters.
    expect(parseSedEditCommand(cmd('s/a\\{0,3\\}/X/'))).not.toBeNull()
  })

  test('rejects interval syntax inside a bracket expression', () => {
    // `[\{,3\}]` is a bracket expression whose members are ordinary characters;
    // GNU sed turns "0,{3}" into "0XXXX". A backslash is a literal member in
    // POSIX brackets but an escape in a JS character class, so this cannot be
    // mapped across and must not be parsed as an interval.
    expect(parseSedEditCommand(cmd('s/[\\{,3\\}]/X/g'))).toBeNull()
  })

  test('still simulates ordinary bracket expressions', () => {
    const info = parseSedEditCommand(cmd('s/[abc]/X/g'))
    expect(info).not.toBeNull()
    expect(applySedSubstitution('abcd', info!)).toBe('XXXd')
  })

  test('rejects a pattern whose translation is not a valid regex', () => {
    // Previously `new RegExp` threw and the catch returned the original
    // content, rendering an invalid pattern as a silent "no change" diff.
    expect(parseSedEditCommand(cmd('s/a*\\{2\\}/X/g'))).toBeNull()
  })

  test('rejects bracket expressions with a leading ] member', () => {
    // POSIX treats the first `]` as an ordinary member, so GNU sed rewrites
    // "a]b" to "aXb"; JavaScript reads it as the class terminator and matches
    // nothing, leaving the text untouched.
    expect(parseSedEditCommand(cmd('s/[]]/X/g'))).toBeNull()
    expect(parseSedEditCommand(cmd('s/[^]]/X/g'))).toBeNull()
    expect(
      parseSedEditCommand("sed -i '' -E 's/[]]/X/g' example.txt"),
    ).toBeNull()
  })

  test('rejects an unterminated bracket expression', () => {
    // GNU sed rejects `s/[/X/g` with an unterminated-address error and leaves
    // the file untouched; rendering `[` as a literal would persist an edit the
    // command cannot perform.
    expect(parseSedEditCommand(cmd('s/[/X/g'))).toBeNull()
  })

  test('rejects POSIX character classes JavaScript cannot interpret', () => {
    // `[[:digit:]]` is a digit class to sed but a plain character set to a JS
    // regex, so the two produce different files ("1a2": sed XaX, JS unchanged).
    expect(parseSedEditCommand(cmd('s/[[:digit:]]/X/g'))).toBeNull()
    expect(
      parseSedEditCommand("sed -i '' -E 's/[[:alpha:]]+/X/g' example.txt"),
    ).toBeNull()
  })

  test('rejects ERE alternation for the same POSIX-selection reason', () => {
    expect(
      parseSedEditCommand("sed -i '' -E 's/(a|aa)/X/' example.txt"),
    ).toBeNull()
  })

  test('rejects ERE (?...) group extensions GNU sed does not implement', () => {
    // `sed -E` supports only plain capturing `(...)`. `(?` opens JS-only syntax
    // -- non-capturing, lookaround, named groups -- that JavaScript compiles
    // but GNU sed rejects, so a preview would edit a file the real command
    // leaves untouched. Every `(?` form must decline.
    for (const pattern of [
      '(?:a)b',
      '(?=a)',
      '(?!a)b',
      '(?<=a)b',
      '(?<!a)b',
      '(?<n>a)',
    ]) {
      expect(
        parseSedEditCommand(`sed -i '' -E 's/${pattern}/X/' example.txt`),
      ).toBeNull()
    }
    // A plain capturing group is faithful and still parses.
    expect(
      parseSedEditCommand("sed -i '' -E 's/(a)b/X/' example.txt"),
    ).not.toBeNull()
  })

  test('rejects numeric occurrence flags it does not model', () => {
    // `2` selects the second match on each line, but the simulator always
    // rewrites the first: sed turns "aaaa" into "aaX", a preview into "Xaa".
    expect(parseSedEditCommand(cmd('s/a\\{2\\}/X/2'))).toBeNull()
    expect(parseSedEditCommand(cmd('s/a/X/9'))).toBeNull()
    // `p` prints and `m`/`M` redefine ^ and $ inside the pattern space.
    expect(parseSedEditCommand(cmd('s/a/X/p'))).toBeNull()
    expect(parseSedEditCommand(cmd('s/a/X/m'))).toBeNull()
    // A repeated `g` is not a global rewrite: GNU sed rejects it outright, so a
    // preview of a successful edit would diverge from the failing command.
    expect(parseSedEditCommand(cmd('s/a/X/gg'))).toBeNull()
    // A single `g` still parses.
    expect(parseSedEditCommand(cmd('s/a/X/g'))).not.toBeNull()
  })

  test('rejects replacements carrying sed-specific syntax', () => {
    // `\1` is a backreference to sed but two literal characters to the
    // simulator: sed rewrites "aa" as "a", the preview as "\1".
    expect(parseSedEditCommand(cmd('s/\\(a\\)\\{2\\}/\\1/'))).toBeNull()
    expect(parseSedEditCommand(cmd('s/a/\\n/'))).toBeNull()
    // A plain literal replacement still simulates.
    expect(parseSedEditCommand(cmd('s/a/X/'))).not.toBeNull()
  })

  test('rejects escapes whose sed meaning is not the JavaScript meaning', () => {
    // GNU sed reads `\<`/`\>` as word boundaries; JS reads literal angle
    // brackets, so the preview shows no change while sed rewrites the file.
    expect(parseSedEditCommand(cmd('s/\\<foo\\>/X/g'))).toBeNull()
    // The converse: `\d` is a digit class in JS but a literal `d` in BRE.
    expect(parseSedEditCommand(cmd('s/\\d/X/g'))).toBeNull()
    expect(parseSedEditCommand(cmd('s/\\w/X/g'))).toBeNull()
  })

  test('rejects ^ and $ where BRE treats them as literals', () => {
    // Bare `^`/`$` only anchor at a BRE boundary; elsewhere sed matches them
    // literally while JS always reads an anchor.
    expect(parseSedEditCommand(cmd('s/a^b/X/'))).toBeNull()
    expect(parseSedEditCommand(cmd('s/a$b/X/'))).toBeNull()
    // Genuine anchors still simulate.
    expect(parseSedEditCommand(cmd('s/^a/X/'))).not.toBeNull()
    expect(parseSedEditCommand(cmd('s/a$/X/'))).not.toBeNull()
  })

  test('validates interval bodies on the ERE path too', () => {
    // JS reads `a{,3}` as literal braces; GNU sed -E applies its extension and
    // rewrites "aaaab" to "XXbX", and BSD has no portable behavior.
    expect(
      parseSedEditCommand("sed -i '' -E 's/a{,3}/X/g' example.txt"),
    ).toBeNull()
    expect(
      parseSedEditCommand("sed -i '' -E 's/a{1,2,3}/X/g' example.txt"),
    ).toBeNull()
  })

  test('counts characters like sed, not UTF-16 code units', () => {
    // Verified against GNU sed 4.10: `s/.\{2\}/X/` on the emoji + "a" writes a
    // bare "X". Without a unicode-aware matcher the quantifier consumes only
    // the emoji's surrogate pair and leaves the "a".
    const info = parseSedEditCommand(cmd('s/.\\{2\\}/X/'))
    expect(info).not.toBeNull()
    expect(applySedSubstitution('\u{1F600}a', info!)).toBe('X')
  })

  test('substitutes every character on a line, matching sed under LF content', () => {
    // The permission path (SedEditPermissionRequest) normalizes CRLF to LF
    // before it ever calls the simulator, so the preview it approves only ever
    // sees `\n`-terminated lines. On that normalized content `s/./X/g` rewrites
    // each character exactly as GNU sed does. Raw-CR fidelity is deliberately
    // out of scope: the simulator never receives a `\r`, so this asserts the
    // behavior the approval gate actually exercises rather than a raw-byte case
    // production cannot reach.
    const info = parseSedEditCommand(cmd('s/./X/g'))
    expect(info).not.toBeNull()
    expect(applySedSubstitution('ab', info!)).toBe('XX')
  })

  test('rejects a standalone empty pattern', () => {
    // `s//X/` has no previous regular expression to reuse, so sed errors and
    // leaves the file untouched; an empty JS regex would prefix every line.
    expect(parseSedEditCommand(cmd('s//X/'))).toBeNull()
  })

  test('applies the substitution once per line like sed, not once per file', () => {
    // sed substitutes the first match on EVERY line even without `g`.
    const info = parseSedEditCommand(cmd('s/a\\{2\\}/X/'))
    expect(info).not.toBeNull()
    expect(applySedSubstitution('aa\naa\n', info!)).toBe('X\nX\n')
    // With `g`, all matches on every line.
    const g = parseSedEditCommand(cmd('s/a\\{2\\}/X/g'))
    expect(applySedSubstitution('aaaa\naa b aa\n', g!)).toBe('XX\nX b X\n')
    // A trailing newline is preserved and never treated as an extra empty line.
    expect(applySedSubstitution('aa', info!)).toBe('X')
  })

  test('leaves an empty file empty like sed', () => {
    // An empty file has no lines: sed never runs the substitution, so even an
    // anchored pattern that matches the empty string writes nothing.
    const info = parseSedEditCommand(cmd('s/^/X/'))
    expect(info).not.toBeNull()
    expect(applySedSubstitution('', info!)).toBe('')
  })
})

describe('replacement text is written literally, as sed writes it', () => {
  const cmd = (expr: string) => `sed -i '' '${expr}' example.txt`

  test('writes dollar tokens literally instead of expanding them', () => {
    // `$` is an ordinary character in a sed replacement but a substitution
    // token to String.replace. GNU sed 4.10 writes the two characters `$1`
    // here; before the fix the preview expanded it to the matched text, so an
    // approved diff differed from what the command performs.
    const one = parseSedEditCommand(cmd('s/\\(a\\)/$1/'))
    expect(one).not.toBeNull()
    expect(applySedSubstitution('a', one!)).toBe('$1')

    const dollars = parseSedEditCommand(cmd('s/a/$$/'))
    expect(dollars).not.toBeNull()
    expect(applySedSubstitution('a', dollars!)).toBe('$$')

    // $` and $' expand to the text before/after the match in JS.
    const before = parseSedEditCommand(cmd('s/b/$`/'))
    expect(before).not.toBeNull()
    expect(applySedSubstitution('abc', before!)).toBe('a$`c')

    // `$'` cannot go through the single-quoted fixture above, so drive it
    // directly: in JS it expands to the text following the match.
    expect(applySedSubstitution('abc', sedInfo('b', "$'"))).toBe("a$'c")

    // `&` is sed's own whole-match token and is declined outright, so a
    // replacement spelling JS's `$&` never reaches the simulator.
    expect(parseSedEditCommand(cmd('s/b/$&/'))).toBeNull()
  })

  test('a plain replacement is unaffected', () => {
    const info = parseSedEditCommand(cmd('s/a/USD 5/g'))
    expect(info).not.toBeNull()
    expect(applySedSubstitution('a b a', info!)).toBe('USD 5 b USD 5')
  })
})

describe('ERE patterns are screened for JS-only escapes', () => {
  const ere = (expr: string) => `sed -i '' -E '${expr}' example.txt`

  test('declines escapes that mean a character class only in JS', () => {
    // GNU sed reads `\d` as a literal `d`, so `-E 's/\d/X/g'` on "1d2" writes
    // "1X2"; a JS regex reads a digit class and would preview "XdX". The same
    // divergence applies to the other JS-only escapes, and several are not
    // valid sed at all.
    for (const expr of [
      's/\\d/X/g',
      's/\\w/X/g',
      's/\\s/X/g',
      's/\\S/X/g',
      's/\\b/X/g',
      's/\\u{41}/X/g',
      's/\\p{L}/X/g',
      's/\\x41/X/g',
    ]) {
      expect(parseSedEditCommand(ere(expr))).toBeNull()
    }
  })

  test('still accepts escapes that are the same literal in both dialects', () => {
    const dot = parseSedEditCommand(ere('s/a\\.b/X/g'))
    expect(dot).not.toBeNull()
    expect(applySedSubstitution('a.b axb', dot!)).toBe('X axb')

    const plus = parseSedEditCommand(ere('s/a\\+/X/g'))
    expect(plus).not.toBeNull()
    expect(applySedSubstitution('a+ aa', plus!)).toBe('X aa')
  })

  test('declines a trailing lone backslash', () => {
    expect(parseSedEditCommand(ere('s/a\\/X/g'))).toBeNull()
  })
})

describe('case-insensitive matching is declined', () => {
  test('declines the i and I flags rather than folding by Unicode rules', () => {
    // The emitted regex needs `u` for the quantifier fix, and `u` + `i` is
    // ECMAScript Unicode case folding, not sed's locale matching: `s/k/X/I`
    // would rewrite a Kelvin sign that GNU sed under C.UTF-8 leaves alone.
    for (const expr of ["s/k/X/I", "s/k/X/i", "s/k/X/gI", "s/k/X/gi"]) {
      expect(
        parseSedEditCommand(`sed -i '' '${expr}' example.txt`),
      ).toBeNull()
    }
    // The g flag on its own is still simulated.
    expect(
      parseSedEditCommand("sed -i '' 's/k/X/g' example.txt"),
    ).not.toBeNull()
  })
})

describe('locale-sensitive matching is declined outside UTF-8', () => {
  test('declines when sed would count bytes rather than characters', () => {
    // The emitted regex carries `u` so a quantifier counts characters. That is
    // sed's behavior in a UTF-8 locale only: under LC_ALL=C, `s/.\{2\}/X/` on
    // "😀a" consumes two bytes of the emoji and leaves the rest in the file.
    for (const locale of ['C', 'POSIX', 'en_US.ISO-8859-1']) {
      expect(sedLocaleCountsCharacters({ LC_ALL: locale })).toBe(false)
    }
    // POSIX resolves an unset or empty locale to C.
    expect(sedLocaleCountsCharacters({})).toBe(false)
    expect(sedLocaleCountsCharacters({ LC_ALL: '' , LANG: ''})).toBe(false)
  })

  test('accepts the UTF-8 spellings that actually occur', () => {
    expect(sedLocaleCountsCharacters({ LC_ALL: 'en_US.UTF-8' })).toBe(true)
    expect(sedLocaleCountsCharacters({ LANG: 'de_DE.utf8' })).toBe(true)
    // macOS sets the bare codeset for LC_CTYPE.
    expect(sedLocaleCountsCharacters({ LC_CTYPE: 'UTF-8' })).toBe(true)
    expect(sedLocaleCountsCharacters({ LANG: 'fr_FR.UTF-8@euro' })).toBe(true)
  })

  test('honours the POSIX precedence order', () => {
    // LC_ALL overrides everything; LC_CTYPE overrides LANG.
    expect(
      sedLocaleCountsCharacters({ LC_ALL: 'C', LC_CTYPE: 'en_US.UTF-8' }),
    ).toBe(false)
    expect(sedLocaleCountsCharacters({ LC_CTYPE: 'C', LANG: 'en_US.UTF-8' })).toBe(
      false,
    )
    expect(sedLocaleCountsCharacters({ LANG: 'en_US.UTF-8' })).toBe(true)
  })

  test('claims no sed edit at all under a byte locale', () => {
    const saved = process.env.LC_ALL
    process.env.LC_ALL = 'C'
    try {
      expect(
        parseSedEditCommand("sed -i '' 's/a\\{2\\}/X/g' example.txt"),
      ).toBeNull()
    } finally {
      process.env.LC_ALL = saved
    }
  })
})

describe('patterns that can stall the approval UI are declined', () => {
  const cmd = (expr: string) => `sed -i '' '${expr}' example.txt`

  test('declines a quantified group that already contains a quantifier', () => {
    // `(a{1,}){1,}b` backtracks exponentially on a run of `a`s with no `b`, and
    // applySedSubstitution runs synchronously while the permission request is
    // rendered -- so this freezes the approval UI before the user can decide.
    expect(parseSedEditCommand(cmd('s/\\(a\\{1,\\}\\)\\{1,\\}b/X/'))).toBeNull()
    expect(parseSedEditCommand(cmd('s/\\(a*\\)\\{2\\}b/X/'))).toBeNull()
    expect(
      parseSedEditCommand("sed -i '' -E 's/(a+)+b/X/' example.txt"),
    ).toBeNull()
  })

  test('still accepts a quantified group with no inner quantifier', () => {
    const info = parseSedEditCommand(cmd('s/\\(ab\\)\\{2\\}/X/g'))
    expect(info).not.toBeNull()
    expect(applySedSubstitution('abab ab', info!)).toBe('X ab')
  })

  test('still accepts an inner quantifier when the group is not quantified', () => {
    const info = parseSedEditCommand(cmd('s/\\(a\\{2\\}\\)b/X/g'))
    expect(info).not.toBeNull()
    expect(applySedSubstitution('aab ab', info!)).toBe('X ab')
  })
})

describe('literal replacement escapes keep their preview', () => {
  const cmd = (expr: string) => `sed -i '' '${expr}' example.txt`

  test('accepts the two escapes the translation already handles', () => {
    // Rejecting these sent ordinary commands back to the generic bash approval
    // even though applySedSubstitution translates both faithfully.
    const slash = parseSedEditCommand(cmd('s/foo/path\\/to/'))
    expect(slash).not.toBeNull()
    expect(applySedSubstitution('foo\n', slash!)).toBe('path/to\n')

    const amp = parseSedEditCommand(cmd('s/foo/a\\&b/'))
    expect(amp).not.toBeNull()
    expect(applySedSubstitution('foo\n', amp!)).toBe('a&b\n')
  })

  test('still declines backreferences, case folding and a bare &', () => {
    expect(parseSedEditCommand(cmd('s/\\(a\\)/\\1/'))).toBeNull()
    expect(parseSedEditCommand(cmd('s/a/\\U&/'))).toBeNull()
    expect(parseSedEditCommand(cmd('s/a/\\n/'))).toBeNull()
    expect(parseSedEditCommand(cmd('s/a/x&y/'))).toBeNull()
  })
})
