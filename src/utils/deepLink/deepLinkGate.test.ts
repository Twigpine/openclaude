import { describe, expect, test } from 'bun:test'
import { buildDeepLink, parseDeepLink } from './parseDeepLink.js'

describe('parseDeepLink', () => {
  test('parses an open action with cwd, repo, and query', () => {
    const action = parseDeepLink(
      'claude-cli://open?cwd=/tmp/work&repo=owner/repo&q=fix%20the%20tests',
    )

    expect(action).toEqual({
      cwd: '/tmp/work',
      repo: 'owner/repo',
      query: 'fix the tests',
    })
  })

  test('round-trips through buildDeepLink', () => {
    const uri = buildDeepLink({ cwd: '/tmp/work', query: 'hello' })

    expect(parseDeepLink(uri)).toEqual({ cwd: '/tmp/work', query: 'hello' })
  })

  test('rejects a relative cwd', () => {
    expect(() => parseDeepLink('claude-cli://open?cwd=relative/path')).toThrow(
      'absolute path',
    )
  })

  test('rejects a malformed repo slug', () => {
    expect(() => parseDeepLink('claude-cli://open?repo=not-a-slug')).toThrow(
      'owner/repo',
    )
  })

  test('rejects unknown actions and wrong schemes', () => {
    expect(() => parseDeepLink('claude-cli://delete')).toThrow(
      'Unknown deep link action',
    )
    expect(() => parseDeepLink('https://open')).toThrow('claude-cli')
  })
})
