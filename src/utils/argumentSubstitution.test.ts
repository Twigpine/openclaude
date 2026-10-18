import { describe, expect, test } from 'bun:test'
import { substituteArguments } from './argumentSubstitution.js'

describe('substituteArguments named-argument regex safety', () => {
  test('substitutes a normal named argument', () => {
    expect(substituteArguments('hello $name', 'world', false, ['name'])).toBe(
      'hello world',
    )
  })

  // A frontmatter argument name is author-defined and unrestricted beyond
  // rejecting empty/numeric-only names, so a name with regex metacharacters must
  // be treated literally rather than compiled into a live pattern.
  test('does not over-match when the name contains a regex wildcard', () => {
    // Name `a.` must not let `.` match the `b` in `$ab`.
    expect(substituteArguments('$ab', 'X', false, ['a.'])).toBe('$ab')
    // The literal `$a.` placeholder still substitutes.
    expect(substituteArguments('$a.', 'X', false, ['a.'])).toBe('X')
  })

  test('does not throw when the name contains unbalanced regex characters', () => {
    for (const name of ['a)', 'a(', 'a[', 'a+', 'a*', 'a{2']) {
      expect(() =>
        substituteArguments('body has no placeholder', 'x', true, [name]),
      ).not.toThrow()
    }
  })

  test('substitutes a literal placeholder whose name has metacharacters', () => {
    expect(substituteArguments('run $a+b now', 'VAL', false, ['a+b'])).toBe(
      'run VAL now',
    )
  })
})

describe('substituteArguments $-token literalness', () => {
  test('inserts $$ in $ARGUMENTS verbatim rather than collapsing it', () => {
    // String.replaceAll treats `$$` in the replacement as an escaped `$`.
    expect(substituteArguments('cost $ARGUMENTS', 'is 100$$')).toBe(
      'cost is 100$$',
    )
  })

  test('inserts match-reference tokens in $ARGUMENTS verbatim', () => {
    // $&, $` and $' are all String.replace match references; they must stay
    // literal when they come from user-supplied argument text.
    expect(substituteArguments('run $ARGUMENTS now', 'deploy $& svc')).toBe(
      'run deploy $& svc now',
    )
    expect(substituteArguments('x $ARGUMENTS y', 'a $` b')).toBe('x a $` b y')
    expect(substituteArguments('x $ARGUMENTS y', "a $' b")).toBe("x a $' b y")
  })

  test('inserts $$ in a named argument value verbatim', () => {
    // parseArguments preserves `100$$` as a single token; the substitution must
    // not then let String.replace collapse the `$$` to a single `$`.
    expect(substituteArguments('v=$name', '100$$', false, ['name'])).toBe(
      'v=100$$',
    )
  })

  test('does not re-scan an inserted named value for later placeholders', () => {
    // parseArguments preserves the first argument as the literal `$1`. Once it
    // has been substituted for $name it is a value, not a placeholder — the
    // later `$n` pass must not rewrite it into the second argument.
    expect(
      substituteArguments('v=$name', '"$1" second', false, ['name']),
    ).toBe('v=$1')
  })

  test('does not re-scan an inserted indexed value for later placeholders', () => {
    expect(substituteArguments('v=$ARGUMENTS[0]', '"$1" second', false)).toBe(
      'v=$1',
    )
  })

  test('keeps $n tokens literal through $ARGUMENTS', () => {
    expect(substituteArguments('v=$ARGUMENTS', '"$1" second', false)).toBe(
      'v="$1" second',
    )
  })
})
