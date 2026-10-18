import { describe, expect, test } from 'bun:test'
import {
  doesSourceMatchHostPattern,
  extractHostFromSource,
} from './marketplaceHelpers.js'
import type { MarketplaceSource } from './schemas.js'

function hostPattern(
  pattern: string,
): MarketplaceSource & { source: 'hostPattern' } {
  return { source: 'hostPattern', hostPattern: pattern }
}

function urlSource(url: string): MarketplaceSource {
  return { source: 'url', url }
}

function gitSource(url: string): MarketplaceSource {
  return { source: 'git', url }
}

// Regression: strictKnownMarketplaces hostPattern entries are compiled with
// `new RegExp(pattern)` and applied with `.test(host)`, which is a substring
// search. An admin pattern that is not fully anchored therefore matched any
// host merely CONTAINING it. Because host authority reads right-to-left, an
// attacker who controls `evil.example` can serve `github.mycompany.com.evil.example`
// and pass an allowlist meant to permit only `github.mycompany.com` — which
// gates plugin marketplace installation, so it leads to plugin execution.
describe('doesSourceMatchHostPattern — allowlist cannot be satisfied by a substring', () => {
  const unanchored = hostPattern('github\\.mycompany\\.com')

  test('the intended host still matches', () => {
    expect(doesSourceMatchHostPattern(urlSource('https://github.mycompany.com/mp.json'), unanchored)).toBe(true)
  })

  test('an attacker-controlled parent domain is rejected', () => {
    // Suffix attack: the pattern appears at the start, so a leading `^` alone
    // would not have caught this one.
    expect(doesSourceMatchHostPattern(urlSource('https://github.mycompany.com.evil.example/mp.json'), unanchored)).toBe(false)
  })

  test('an attacker-controlled prefix label is rejected', () => {
    expect(doesSourceMatchHostPattern(urlSource('https://evil-github.mycompany.com/mp.json'), unanchored)).toBe(false)
    expect(doesSourceMatchHostPattern(urlSource('https://notgithub.mycompany.com/mp.json'), unanchored)).toBe(false)
  })

  test('the attack is rejected for SSH git sources too', () => {
    expect(doesSourceMatchHostPattern(gitSource('git@github.mycompany.com:team/repo.git'), unanchored)).toBe(true)
    expect(doesSourceMatchHostPattern(gitSource('git@github.mycompany.com.evil.example:team/repo.git'), unanchored)).toBe(false)
  })
})

describe('doesSourceMatchHostPattern — existing admin patterns keep working', () => {
  test('a fully anchored pattern behaves identically', () => {
    const anchored = hostPattern('^github\\.mycompany\\.com$')
    expect(doesSourceMatchHostPattern(urlSource('https://github.mycompany.com/mp.json'), anchored)).toBe(true)
    expect(doesSourceMatchHostPattern(urlSource('https://github.mycompany.com.evil.example/mp.json'), anchored)).toBe(false)
  })

  test('a top-level alternation is not broken by the added anchors', () => {
    // Without the non-capturing group this would become
    // `^github\.com|gitlab\.com$` and match far more than intended.
    const either = hostPattern('github\\.com|gitlab\\.com')
    expect(doesSourceMatchHostPattern(urlSource('https://github.com/mp.json'), either)).toBe(true)
    expect(doesSourceMatchHostPattern(urlSource('https://gitlab.com/mp.json'), either)).toBe(true)
    expect(doesSourceMatchHostPattern(urlSource('https://github.com.evil.example/mp.json'), either)).toBe(false)
    expect(doesSourceMatchHostPattern(urlSource('https://evil.example/gitlab.com'), either)).toBe(false)
  })

  test('an intentional wildcard subdomain pattern still matches', () => {
    const wildcard = hostPattern('.*\\.mycompany\\.com')
    expect(doesSourceMatchHostPattern(urlSource('https://github.mycompany.com/mp.json'), wildcard)).toBe(true)
    expect(doesSourceMatchHostPattern(urlSource('https://git.eu.mycompany.com/mp.json'), wildcard)).toBe(true)
    expect(doesSourceMatchHostPattern(urlSource('https://mycompany.com.evil.example/mp.json'), wildcard)).toBe(false)
  })

  test('a catch-all pattern still allows everything', () => {
    const all = hostPattern('.*')
    expect(doesSourceMatchHostPattern(urlSource('https://anything.example/mp.json'), all)).toBe(true)
  })

  test('github shorthand sources resolve to github.com', () => {
    expect(extractHostFromSource({ source: 'github', repo: 'owner/repo' })).toBe('github.com')
    expect(doesSourceMatchHostPattern({ source: 'github', repo: 'owner/repo' }, hostPattern('github\\.com'))).toBe(true)
    expect(doesSourceMatchHostPattern({ source: 'github', repo: 'owner/repo' }, hostPattern('hub\\.com'))).toBe(false)
  })
})

describe('doesSourceMatchHostPattern — malformed input fails closed', () => {
  test('an invalid regex does not match', () => {
    expect(doesSourceMatchHostPattern(urlSource('https://github.com/mp.json'), hostPattern('['))).toBe(false)
  })

  test('a source with no extractable host does not match', () => {
    expect(doesSourceMatchHostPattern(urlSource('not-a-url'), hostPattern('.*'))).toBe(false)
  })
})
