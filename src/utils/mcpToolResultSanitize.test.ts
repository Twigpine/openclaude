import { afterEach, describe, expect, it } from 'bun:test'
import {
  sanitizeMcpImageData,
  sanitizeMcpToolText,
  truncateMcpToolText,
} from './mcpToolResultSanitize.js'

afterEach(() => {
  delete process.env.BASH_MAX_OUTPUT_LENGTH
})

describe('sanitizeMcpToolText', () => {
  it('strips NUL bytes', () => {
    expect(sanitizeMcpToolText('ok\u0000more')).toBe('okmore')
  })

  it('preserves normal UTF-8', () => {
    expect(sanitizeMcpToolText('café 你好')).toBe('café 你好')
  })

  it('round-trips lone surrogates into replacement chars', () => {
    // Lone high surrogate — invalid UTF-8 when encoded
    const lone = 'a\uD800b'
    const out = sanitizeMcpToolText(lone)
    expect(out.includes('\u0000')).toBe(false)
    expect(out.startsWith('a')).toBe(true)
    expect(out.endsWith('b')).toBe(true)
  })
})

describe('truncateMcpToolText', () => {
  it('leaves short clean text unchanged', () => {
    expect(truncateMcpToolText('ok')).toBe('ok')
  })

  it('truncates above BASH_MAX_OUTPUT_LENGTH and keeps marker', () => {
    process.env.BASH_MAX_OUTPUT_LENGTH = '32'
    const long = 'x'.repeat(100)
    const out = truncateMcpToolText(long)
    expect(out.startsWith('x'.repeat(32))).toBe(true)
    expect(out).toContain('MCP tool result truncated at 32 chars')
    expect(out.length).toBeLessThan(long.length + 200)
  })

  it('sanitizes before truncating', () => {
    process.env.BASH_MAX_OUTPUT_LENGTH = '8'
    const out = truncateMcpToolText('ab\u0000cd\u0000efghijklmnop')
    expect(out.startsWith('abcdefgh')).toBe(true)
    expect(out.includes('\u0000')).toBe(false)
  })
})

describe('sanitizeMcpImageData', () => {
  it('accepts valid base64', () => {
    const raw = Buffer.from('hi').toString('base64')
    expect(sanitizeMcpImageData(raw)).toBe(raw)
  })

  it('rejects NULs / non-base64', () => {
    expect(sanitizeMcpImageData('abc\u0000def')).toBeNull()
    expect(sanitizeMcpImageData('!!!not-b64!!!')).toBeNull()
    expect(sanitizeMcpImageData('')).toBeNull()
  })
})
