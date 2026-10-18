import { describe, expect, test } from 'bun:test'
import { isFirstPartyAnthropicBaseUrlForEnv } from './anthropicBaseUrl.js'

describe('isFirstPartyAnthropicBaseUrlForEnv', () => {
  test('accepts the canonical HTTPS endpoint with its explicit default port', () => {
    expect(
      isFirstPartyAnthropicBaseUrlForEnv({
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com:443',
      }),
    ).toBe(true)
  })

  test('rejects a non-default port on an Anthropic host', () => {
    expect(
      isFirstPartyAnthropicBaseUrlForEnv({
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com:444',
      }),
    ).toBe(false)
  })

  test('defaults to true when ANTHROPIC_BASE_URL is unset', () => {
    expect(isFirstPartyAnthropicBaseUrlForEnv({})).toBe(true)
  })

  test('rejects non-HTTPS URLs and lookalike hosts', () => {
    expect(
      isFirstPartyAnthropicBaseUrlForEnv({
        ANTHROPIC_BASE_URL: 'http://api.anthropic.com',
      }),
    ).toBe(false)
    expect(
      isFirstPartyAnthropicBaseUrlForEnv({
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com.evil.example',
      }),
    ).toBe(false)
  })

  test('only accepts the staging host for ant users', () => {
    expect(
      isFirstPartyAnthropicBaseUrlForEnv({
        ANTHROPIC_BASE_URL: 'https://api-staging.anthropic.com',
      }),
    ).toBe(false)
    expect(
      isFirstPartyAnthropicBaseUrlForEnv({
        ANTHROPIC_BASE_URL: 'https://api-staging.anthropic.com',
        USER_TYPE: 'ant',
      }),
    ).toBe(true)
  })

  test('fails closed for malformed URLs', () => {
    expect(
      isFirstPartyAnthropicBaseUrlForEnv({ ANTHROPIC_BASE_URL: 'not a URL' }),
    ).toBe(false)
  })
})

describe('ANTHROPIC_FIRST_PARTY_PROXY_HOSTS loopback allowlist', () => {
  test('keeps first-party status for an allowlisted loopback proxy', () => {
    // The whole point: a local transparent proxy (http, non-default port) that
    // forwards auth to Anthropic must not drop the OAuth session.
    expect(
      isFirstPartyAnthropicBaseUrlForEnv({
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:47821',
        ANTHROPIC_FIRST_PARTY_PROXY_HOSTS: '127.0.0.1:47821',
      }),
    ).toBe(true)
  })

  test('honors localhost and bracketed IPv6 loopback entries', () => {
    expect(
      isFirstPartyAnthropicBaseUrlForEnv({
        ANTHROPIC_BASE_URL: 'http://localhost:8080',
        ANTHROPIC_FIRST_PARTY_PROXY_HOSTS: 'localhost:8080',
      }),
    ).toBe(true)
    expect(
      isFirstPartyAnthropicBaseUrlForEnv({
        ANTHROPIC_BASE_URL: 'http://[::1]:8080',
        ANTHROPIC_FIRST_PARTY_PROXY_HOSTS: '[::1]:8080',
      }),
    ).toBe(true)
    // A case-different localhost still matches.
    expect(
      isFirstPartyAnthropicBaseUrlForEnv({
        ANTHROPIC_BASE_URL: 'http://LocalHost:8080',
        ANTHROPIC_FIRST_PARTY_PROXY_HOSTS: 'localhost:8080',
      }),
    ).toBe(true)
  })

  test('an entry with no port matches any port on that loopback host', () => {
    expect(
      isFirstPartyAnthropicBaseUrlForEnv({
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:59999',
        ANTHROPIC_FIRST_PARTY_PROXY_HOSTS: '127.0.0.1',
      }),
    ).toBe(true)
  })

  test('picks the matching host out of a comma-separated list', () => {
    expect(
      isFirstPartyAnthropicBaseUrlForEnv({
        ANTHROPIC_BASE_URL: 'http://[::1]:8080',
        ANTHROPIC_FIRST_PARTY_PROXY_HOSTS: '127.0.0.1:47821, [::1]:8080',
      }),
    ).toBe(true)
  })

  test('a port on the entry must match the base URL port exactly', () => {
    expect(
      isFirstPartyAnthropicBaseUrlForEnv({
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:47821',
        ANTHROPIC_FIRST_PARTY_PROXY_HOSTS: '127.0.0.1:47822',
      }),
    ).toBe(false)
  })

  test('never widens first-party status to an off-machine host', () => {
    // A non-loopback base URL is rejected even if the operator lists it -- the
    // token can only ever ride a proxy on the local machine.
    expect(
      isFirstPartyAnthropicBaseUrlForEnv({
        ANTHROPIC_BASE_URL: 'http://proxy.internal.example:47821',
        ANTHROPIC_FIRST_PARTY_PROXY_HOSTS: 'proxy.internal.example:47821',
      }),
    ).toBe(false)
    // A loopback base URL with a non-loopback allowlist entry does not match.
    expect(
      isFirstPartyAnthropicBaseUrlForEnv({
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:47821',
        ANTHROPIC_FIRST_PARTY_PROXY_HOSTS: 'evil.example:47821',
      }),
    ).toBe(false)
  })

  test('matches a default-port entry against a scheme-default base URL', () => {
    // Node leaves url.port empty for the scheme default; an explicit :80/:443
    // entry must still match.
    expect(
      isFirstPartyAnthropicBaseUrlForEnv({
        ANTHROPIC_BASE_URL: 'http://127.0.0.1',
        ANTHROPIC_FIRST_PARTY_PROXY_HOSTS: '127.0.0.1:80',
      }),
    ).toBe(true)
    expect(
      isFirstPartyAnthropicBaseUrlForEnv({
        ANTHROPIC_BASE_URL: 'https://[::1]',
        ANTHROPIC_FIRST_PARTY_PROXY_HOSTS: '[::1]:443',
      }),
    ).toBe(true)
    // A default-port entry that does not match the scheme default is rejected.
    expect(
      isFirstPartyAnthropicBaseUrlForEnv({
        ANTHROPIC_BASE_URL: 'http://127.0.0.1',
        ANTHROPIC_FIRST_PARTY_PROXY_HOSTS: '127.0.0.1:443',
      }),
    ).toBe(false)
  })

  test('rejects embedded credentials and non-http(s) schemes', () => {
    // Userinfo on an otherwise-canonical URL is never first-party.
    expect(
      isFirstPartyAnthropicBaseUrlForEnv({
        ANTHROPIC_BASE_URL: 'https://user:pass@api.anthropic.com',
      }),
    ).toBe(false)
    // Userinfo on a loopback proxy is likewise rejected.
    expect(
      isFirstPartyAnthropicBaseUrlForEnv({
        ANTHROPIC_BASE_URL: 'http://user@127.0.0.1:47821',
        ANTHROPIC_FIRST_PARTY_PROXY_HOSTS: '127.0.0.1:47821',
      }),
    ).toBe(false)
    // A non-http(s) loopback scheme does not match the proxy allowlist.
    expect(
      isFirstPartyAnthropicBaseUrlForEnv({
        ANTHROPIC_BASE_URL: 'ftp://127.0.0.1:47821',
        ANTHROPIC_FIRST_PARTY_PROXY_HOSTS: '127.0.0.1:47821',
      }),
    ).toBe(false)
  })

  test('does nothing without the opt-in variable', () => {
    // Default behavior is unchanged: a loopback base URL is still a custom
    // provider unless the allowlist explicitly opts in.
    expect(
      isFirstPartyAnthropicBaseUrlForEnv({
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:47821',
      }),
    ).toBe(false)
    expect(
      isFirstPartyAnthropicBaseUrlForEnv({
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:47821',
        ANTHROPIC_FIRST_PARTY_PROXY_HOSTS: '',
      }),
    ).toBe(false)
  })
})
