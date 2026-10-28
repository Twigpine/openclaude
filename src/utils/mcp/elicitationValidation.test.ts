import { describe, expect, test } from 'bun:test'
import { validateElicitationInput } from './elicitationValidation.js'

describe('formatted input validation', () => {
  test.each([
    ['email', 'not-email', 'Must be a valid email address'],
    ['uri', 'not-uri', 'Must be a valid URI'],
    ['date', '2024-02-31', 'Must be a valid date'],
    ['date-time', 'not-time', 'Must be a valid date-time'],
  ] as const)('preserves the custom %s error', (format, input, message) => {
    const result = validateElicitationInput(input, { type: 'string', format })
    expect(result.isValid).toBe(false)
    expect(result.error).toStartWith(message)
  })

  test('retains length checks alongside format checks', () => {
    const schema = { type: 'string', format: 'uri', minLength: 20, maxLength: 25 } as const
    expect(validateElicitationInput('urn:example:abc', schema).error)
      .toBe('Must be at least 20 characters')
    expect(validateElicitationInput('urn:example:abcdefghijklmnop', schema).error)
      .toBe('Must be at most 25 characters')
    expect(validateElicitationInput('urn:example:abcdefghij', schema))
      .toEqual({ value: 'urn:example:abcdefghij', isValid: true })
  })
})
