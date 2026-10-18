import { expect, test } from 'bun:test'
import {
  parseFrontmatter,
  splitPathInFrontmatter,
} from './frontmatterParser.ts'

// splitPathInFrontmatter is the public entry that flatMaps each comma-separated
// part through the (private) expandBraces helper, so it exercises the brace
// expansion that loadSkillsDir.ts and claudemd.ts depend on for path-scoped
// activation. These cover the regression where the old `[^}]+` regex stopped at
// the first '}' and corrupted nested groups (leaving stray '}' in globs).

test('passes through a pattern with no braces unchanged', () => {
  expect(splitPathInFrontmatter('src/index.ts')).toEqual(['src/index.ts'])
})

test('expands a single-level brace group', () => {
  expect(splitPathInFrontmatter('a.{js,ts}')).toEqual(['a.js', 'a.ts'])
})

test('expands a nested brace group without leaking braces', () => {
  expect(splitPathInFrontmatter('{a,{b,c}}')).toEqual(['a', 'b', 'c'])
})

test('expands a nested glob group into valid globs', () => {
  expect(splitPathInFrontmatter('src/**/*.{js,{ts,tsx}}')).toEqual([
    'src/**/*.js',
    'src/**/*.ts',
    'src/**/*.tsx',
  ])
})

test('expands sibling brace groups as a cartesian product', () => {
  expect(splitPathInFrontmatter('{a,b}/{c,d}')).toEqual([
    'a/c',
    'a/d',
    'b/c',
    'b/d',
  ])
})

test('returns unbalanced braces unchanged rather than throwing', () => {
  // No matching close brace: treat as literal text, do not corrupt or throw.
  expect(splitPathInFrontmatter('src/{a,b')).toEqual(['src/{a,b'])
})

test('keeps an empty brace group literal instead of yielding an empty path', () => {
  // `{}` is not an alternation. Expanding it to '' would make parseSkillPaths
  // and the CLAUDE.md path parser drop the empty string and treat the file as
  // having NO path restriction (activating everywhere). Keep it literal so the
  // pattern matches a literal `{}` (i.e. effectively nothing) instead.
  expect(splitPathInFrontmatter('{}')).toEqual(['{}'])
  expect(splitPathInFrontmatter('src/{}/file.ts')).toEqual(['src/{}/file.ts'])
})

test('keeps a literal empty group while still expanding later groups', () => {
  expect(splitPathInFrontmatter('{}/{a,b}')).toEqual(['{}/a', '{}/b'])
})

// The opening `---` was anchored but the closing one was not, and `[\s\S]*?` is
// lazy, so parsing stopped at the first `---` appearing anywhere -- including
// inside a value. Every .md frontmatter consumer is affected: agents, skills,
// slash commands, output styles and memory files all go through here.

test('does not end the block at a --- inside a quoted value', () => {
  const { frontmatter, content } = parseFrontmatter(
    '---\nname: r\ndescription: "Reviews code --- thoroughly"\n---\n\nBody.\n',
  )

  // Previously the block ended at the `---` inside the quotes: the description
  // was truncated, and the rest of the frontmatter plus the real delimiter
  // leaked into the body that is sent to the model.
  expect(frontmatter.description).toBe('Reviews code --- thoroughly')
  expect(frontmatter.name).toBe('r')
  // The blank separator line after the closing delimiter is consumed, so the
  // body starts at the first real line (not with a leading newline).
  expect(content).toBe('Body.\n')
  expect(content).not.toContain('---')
})

test('does not end the block at a --- line inside a block scalar', () => {
  const { frontmatter, content } = parseFrontmatter(
    '---\ndescription: |\n  step one\n  ---\n  step two\n---\nBody\n',
  )

  expect(frontmatter.description).toBe('step one\n---\nstep two\n')
  expect(content).toBe('Body\n')
})

test('does not leak the frontmatter tail into the body', () => {
  // Whether the YAML layer can make sense of an unquoted value containing
  // `---` is its own question; what must not happen is the delimiter being
  // found mid-value, which spilled the remaining frontmatter lines and a stray
  // `---` into the body.
  const { content } = parseFrontmatter(
    '---\nname: a\nsummary: uses --- as a separator\n---\nBody\n',
  )

  expect(content).toBe('Body\n')
})

test('parses the ordinary shapes exactly as before', () => {
  const simple = parseFrontmatter('---\nname: a\n---\nBody\n')
  expect(simple.frontmatter).toEqual({ name: 'a' })
  expect(simple.content).toBe('Body\n')

  const empty = parseFrontmatter('---\n---\nBody\n')
  expect(empty.frontmatter).toEqual({})
  expect(empty.content).toBe('Body\n')

  // Trailing spaces are allowed on either delimiter.
  const padded = parseFrontmatter('---   \nname: a\n---   \nBody\n')
  expect(padded.frontmatter).toEqual({ name: 'a' })
  expect(padded.content).toBe('Body\n')

  // Tabs too: the trailing run is [ \t]* on both delimiters.
  const tabbed = parseFrontmatter('---\t\nname: a\n---\t\nBody\n')
  expect(tabbed.frontmatter).toEqual({ name: 'a' })
  expect(tabbed.content).toBe('Body\n')

  // Frontmatter that ends at EOF with no trailing newline.
  const atEof = parseFrontmatter('---\nname: a\n---')
  expect(atEof.frontmatter).toEqual({ name: 'a' })
  expect(atEof.content).toBe('')
})

test('parses CRLF-delimited frontmatter (Windows-authored files)', () => {
  // `---\r\n` must be recognized: the delimiter matcher accepts an optional
  // carriage return on the open, the captured body lines, and the close.
  const crlf = parseFrontmatter('---\r\nname: a\r\n---\r\nBody\r\n')
  expect(crlf.frontmatter).toEqual({ name: 'a' })
  expect(crlf.content).toBe('Body\r\n')

  // Empty CRLF frontmatter.
  const empty = parseFrontmatter('---\r\n---\r\nBody\r\n')
  expect(empty.frontmatter).toEqual({})
  expect(empty.content).toBe('Body\r\n')
})

test('consumes blank and whitespace-only separator lines after the close', () => {
  // Bodies are passed into prompts untrimmed, so a conventional blank line
  // between frontmatter and body must not survive as a leading newline. The
  // pre-anchor regex consumed it via `\s*`; the anchored one has to as well.
  const oneBlank = parseFrontmatter('---\nname: a\n---\n\nBody\n')
  expect(oneBlank.content).toBe('Body\n')

  const manyBlank = parseFrontmatter('---\nname: a\n---\n\n\n\nBody\n')
  expect(manyBlank.content).toBe('Body\n')

  // Whitespace-only separator lines (spaces/tabs) are consumed too.
  const wsOnly = parseFrontmatter('---\nname: a\n---\n   \n\t\nBody\n')
  expect(wsOnly.content).toBe('Body\n')

  // CRLF blank separators.
  const crlfBlank = parseFrontmatter('---\r\nname: a\r\n---\r\n\r\nBody\r\n')
  expect(crlfBlank.content).toBe('Body\r\n')
})

test('keeps a body horizontal rule out of empty frontmatter', () => {
  // Empty frontmatter closes at the first `---` line, so a `---` rule that
  // starts the body must survive as body content -- not be read as YAML.
  const rule = parseFrontmatter('---\n---\n---\nBody\n')
  expect(rule.frontmatter).toEqual({})
  expect(rule.content).toBe('---\nBody\n')

  // The same holds with blank lines between the close and the body rule.
  const blankThenRule = parseFrontmatter('---\n---\n\n---\nBody\n')
  expect(blankThenRule.frontmatter).toEqual({})
  expect(blankThenRule.content).toBe('---\nBody\n')

  // Real frontmatter followed by a body rule is unaffected.
  const realThenRule = parseFrontmatter('---\nname: a\n---\n---\nBody\n')
  expect(realThenRule.frontmatter).toEqual({ name: 'a' })
  expect(realThenRule.content).toBe('---\nBody\n')
})

test('leaves a file without frontmatter untouched', () => {
  const markdown = 'Just a body.\n\nWith a --- rule in it.\n'
  const { frontmatter, content } = parseFrontmatter(markdown)

  expect(frontmatter).toEqual({})
  expect(content).toBe(markdown)
})

test('does not treat a body horizontal rule as frontmatter', () => {
  // The document does not open with a delimiter, so nothing is consumed even
  // though `---` lines appear later.
  const markdown = '# Title\n\n---\n\nSection\n\n---\n'
  expect(parseFrontmatter(markdown).content).toBe(markdown)
})
