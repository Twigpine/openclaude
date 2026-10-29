import { describe, expect, test } from 'bun:test'
import { ShellError, AbortError } from './errors.js'
import { formatError, getErrorParts } from './toolErrors.js'

// =============================================================================
// getErrorParts — what the model sees when a tool fails
// =============================================================================

describe('getErrorParts', () => {
  test('ShellError: exit code + stderr + stdout', () => {
    const err = new ShellError('output here', 'error here', 1, false)
    const parts = getErrorParts(err)
    expect(parts).toEqual([
      'Exit code 1',
      '',
      'error here',
      'output here',
    ])
  })

  test('ShellError: interrupted flag adds interrupt message', () => {
    const err = new ShellError('', 'partial output', 130, true)
    const parts = getErrorParts(err)
    expect(parts[0]).toBe('Exit code 130')
    expect(parts[1]).toContain('interrupted')
    expect(parts[2]).toBe('partial output')
  })

  test('ShellError: abort message overrides generic interrupt text', () => {
    const err = new ShellError('', '', 137, true, {
      abortMessage: 'Command was interrupted because the query hit its timeout.',
      abortReason: 'query-timeout',
    })
    const parts = getErrorParts(err)
    expect(parts[0]).toBe('Exit code 137')
    expect(parts[1]).toBe(
      'Command was interrupted because the query hit its timeout.',
    )
  })

  test('ShellError: derives isAbort only from interrupted abort reasons unless overridden', () => {
    expect(
      new ShellError('', '', 137, true, {
        abortReason: 'query-timeout',
      }).isAbort,
    ).toBe(true)
    expect(
      new ShellError('', '', 1, false, {
        abortReason: 'query-timeout',
      }).isAbort,
    ).toBe(false)
    expect(new ShellError('', '', 137, true).isAbort).toBe(false)
    expect(
      new ShellError('', '', 1, false, {
        abortReason: 'query-timeout',
        isAbort: true,
      }).isAbort,
    ).toBe(true)
  })

  test('ShellError: empty stderr and stdout', () => {
    const err = new ShellError('', '', 1, false)
    const parts = getErrorParts(err)
    expect(parts[0]).toBe('Exit code 1')
    expect(parts[2]).toBe('')
    expect(parts[3]).toBe('')
  })

  test('non-ShellError: returns message + stderr + stdout if present', () => {
    const err = Object.assign(new Error('something broke'), {
      stderr: 'stderr data',
      stdout: 'stdout data',
    })
    const parts = getErrorParts(err)
    expect(parts[0]).toBe('something broke')
    expect(parts[1]).toBe('stderr data')
    expect(parts[2]).toBe('stdout data')
  })

  test('non-ShellError: message only when no stderr/stdout', () => {
    const err = new Error('just a message')
    const parts = getErrorParts(err)
    expect(parts).toEqual(['just a message'])
  })
})

// =============================================================================
// formatError — final string sent to the model
// =============================================================================

describe('formatError', () => {
  test('AbortError returns message or interrupt default', () => {
    const err = new AbortError('user cancelled')
    expect(formatError(err)).toBe('user cancelled')
  })

  test('AbortError with empty message returns default interrupt', () => {
    const err = new AbortError('')
    const result = formatError(err)
    expect(result.length).toBeGreaterThan(0)
  })

  test('DOM AbortError with empty message returns default interrupt', () => {
    const err = new DOMException('', 'AbortError')
    const result = formatError(err)
    expect(result.length).toBeGreaterThan(0)
    expect(result).toContain('interrupted')
  })

  test('non-Error value stringified', () => {
    expect(formatError('raw string')).toBe('raw string')
    expect(formatError(42)).toBe('42')
  })

  test('ShellError: combines exit code + stderr + stdout', () => {
    const err = new ShellError('stdout content', 'stderr content', 1, false)
    const result = formatError(err)
    expect(result).toContain('Exit code 1')
    expect(result).toContain('stderr content')
    expect(result).toContain('stdout content')
  })

  test('ShellError: empty output falls back to default message', () => {
    const err = new ShellError('', '', 1, false)
    const result = formatError(err)
    expect(result).toBe('Exit code 1')
  })

  test('non-ShellError: message only', () => {
    const err = new Error('something failed')
    expect(formatError(err)).toBe('something failed')
  })

  test('truncates at 40KB (not 10KB)', () => {
    // 50KB of output — should be truncated at 40KB limit
    const longOutput = 'x'.repeat(50_000)
    const err = new ShellError('', longOutput, 1, false)
    const result = formatError(err)
    expect(result.length).toBeLessThan(50_000)
    expect(result).toContain('truncated')
    // Should keep first 20KB + last 20KB
    expect(result).toContain('x'.repeat(100))
  })

  test('does NOT truncate under 40KB', () => {
    // 30KB of output — should NOT be truncated
    const output = 'y'.repeat(30_000)
    const err = new ShellError('', output, 1, false)
    const result = formatError(err)
    expect(result).not.toContain('truncated')
    expect(result).toContain(output)
  })
})
