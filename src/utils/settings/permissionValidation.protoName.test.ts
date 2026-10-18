import { describe, expect, test } from 'bun:test'
import { validatePermissionRule } from './permissionValidation.js'
import { getCustomValidation } from './toolValidationConfig.js'

// Regression: TOOL_VALIDATION_CONFIG.customValidation is a plain object literal
// indexed by the permission rule's tool name. validatePermissionRule gates tool
// names on an uppercase first character, which rejects lowercase prototype
// members (`constructor`, `toString`, ...). But the double-underscore members
// (`__proto__`, `__defineGetter__`, ...) slip past that gate because
// `'_'.toUpperCase() === '_'`, then the bare `customValidation[toolName]` lookup
// resolves the inherited Object.prototype member — a truthy value the caller
// invokes as a function. That threw an uncaught TypeError from
// filterInvalidPermissionRules, so a single hostile rule in a project
// .claude/settings.json aborted validation and discarded the whole file rather
// than skipping just that rule.
describe('getCustomValidation — prototype-safe lookup', () => {
  const protoNames = [
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    '__proto__',
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__',
  ]

  for (const name of protoNames) {
    test(`'${name}' is not treated as a configured tool`, () => {
      expect(getCustomValidation(name)).toBeUndefined()
    })
  }

  test('genuine custom-validation tools still resolve', () => {
    expect(typeof getCustomValidation('WebSearch')).toBe('function')
    expect(typeof getCustomValidation('WebFetch')).toBe('function')
    expect(getCustomValidation('Bash')).toBeUndefined()
  })
})

describe('validatePermissionRule — proto-name tool names do not crash', () => {
  // The double-underscore members pass the uppercase gate and previously reached
  // the invoke-as-function path. Each must validate without throwing.
  const underscoreProtoRules = [
    '__proto__(x)',
    '__defineGetter__(x)',
    '__defineSetter__(x)',
    '__lookupGetter__(x)',
    '__lookupSetter__(x)',
  ]

  for (const rule of underscoreProtoRules) {
    test(`'${rule}' validates without throwing`, () => {
      expect(() => validatePermissionRule(rule)).not.toThrow()
      // The rule targets no real tool, so it is inert (valid) rather than a
      // crash — the important guarantee is that validation completes.
      expect(validatePermissionRule(rule).valid).toBe(true)
    })
  }

  // Controls: the uppercase gate still rejects lowercase proto-name rules, and
  // genuine custom validation still fires for its own tools.
  test('lowercase proto-name rules are rejected by the uppercase gate', () => {
    const result = validatePermissionRule('constructor(x)')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/uppercase/i)
  })

  test('WebSearch custom validation still rejects wildcard content', () => {
    const result = validatePermissionRule('WebSearch(foo?)')
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/wildcard/i)
  })

  test('ordinary rules remain valid', () => {
    expect(validatePermissionRule('Bash(npm install)').valid).toBe(true)
    expect(validatePermissionRule('Read(src/**)').valid).toBe(true)
  })
})
