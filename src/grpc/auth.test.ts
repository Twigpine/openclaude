import { describe, expect, test } from 'bun:test'
import { Metadata } from '@grpc/grpc-js'
import {
  DEFAULT_GRPC_HOST,
  extractBearerToken,
  isLoopbackHost,
  resolveGrpcBind,
  tokenMatches,
} from './auth.js'

describe('isLoopbackHost', () => {
  test('recognises loopback bind addresses', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost', 'LOCALHOST', ' 127.0.0.1 ']) {
      expect(isLoopbackHost(host)).toBe(true)
    }
  })

  test('treats interface-exposing addresses as non-loopback', () => {
    for (const host of ['0.0.0.0', '::', '10.0.0.5', 'example.com']) {
      expect(isLoopbackHost(host)).toBe(false)
    }
  })
})

describe('resolveGrpcBind', () => {
  test('defaults to loopback when no host is configured', () => {
    const result = resolveGrpcBind(undefined, undefined)
    expect(result).toEqual({ ok: true, host: DEFAULT_GRPC_HOST })
  })

  test('allows a loopback host without a token', () => {
    expect(resolveGrpcBind('localhost', undefined)).toEqual({
      ok: true,
      host: 'localhost',
    })
  })

  test('refuses a non-loopback host without a token', () => {
    const result = resolveGrpcBind('0.0.0.0', undefined)
    expect(result.ok).toBe(false)
  })

  test('allows a non-loopback host once an auth token is set', () => {
    expect(resolveGrpcBind('0.0.0.0', 'secret-token')).toEqual({
      ok: true,
      host: '0.0.0.0',
    })
  })
})

describe('tokenMatches', () => {
  test('accepts an exact match', () => {
    expect(tokenMatches('abc123', 'abc123')).toBe(true)
  })

  test('rejects a mismatch of equal length', () => {
    expect(tokenMatches('abc123', 'abd123')).toBe(false)
  })

  test('rejects a length mismatch', () => {
    expect(tokenMatches('abc123', 'abc1234')).toBe(false)
  })

  test('rejects when no token is configured', () => {
    expect(tokenMatches(undefined, 'anything')).toBe(false)
    expect(tokenMatches('', 'anything')).toBe(false)
  })

  test('rejects an empty provided token against a configured one', () => {
    expect(tokenMatches('abc123', '')).toBe(false)
  })
})

describe('extractBearerToken', () => {
  test('reads a Bearer authorization header', () => {
    const metadata = new Metadata()
    metadata.set('authorization', 'Bearer my-token')
    expect(extractBearerToken(metadata)).toBe('my-token')
  })

  test('is case-insensitive for the scheme', () => {
    const metadata = new Metadata()
    metadata.set('authorization', 'bearer my-token')
    expect(extractBearerToken(metadata)).toBe('my-token')
  })

  test('falls back to a bare authorization value', () => {
    const metadata = new Metadata()
    metadata.set('authorization', 'bare-token')
    expect(extractBearerToken(metadata)).toBe('bare-token')
  })

  test('falls back to x-api-key', () => {
    const metadata = new Metadata()
    metadata.set('x-api-key', 'api-key-token')
    expect(extractBearerToken(metadata)).toBe('api-key-token')
  })

  test('returns an empty string when no credential is present', () => {
    expect(extractBearerToken(new Metadata())).toBe('')
  })
})
