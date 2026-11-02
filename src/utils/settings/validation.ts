import type { ConfigScope } from 'src/services/mcp/types.js'
import { type ZodError, type ZodIssue, z } from 'zod/v4'
import { COMMAND_HOOK_ARGS_UNSUPPORTED_MESSAGE } from '../../schemas/hooks.js'
import { jsonParse } from '../slowOperations.js'
import { plural } from '../stringUtils.js'
import { validatePermissionRule } from './permissionValidation.js'
import { generateSettingsJSONSchema } from './schemaOutput.js'
import type { SettingsJson } from './types.js'
import {
  ModelPricingDiagnosticSchema,
  SettingsSchema,
} from './types.js'
import { getValidationTip } from './validationTips.js'

/**
 * Helper type guards for specific Zod v4 issue types
 * In v4, issue types have different structures than v3
 */
function isInvalidTypeIssue(issue: ZodIssue): issue is ZodIssue & {
  code: 'invalid_type'
  expected: string
  input: unknown
} {
  return issue.code === 'invalid_type'
}

function isInvalidValueIssue(issue: ZodIssue): issue is ZodIssue & {
  code: 'invalid_value'
  values: unknown[]
  input: unknown
} {
  return issue.code === 'invalid_value'
}

function isUnrecognizedKeysIssue(
  issue: ZodIssue,
): issue is ZodIssue & { code: 'unrecognized_keys'; keys: string[] } {
  return issue.code === 'unrecognized_keys'
}

function isTooSmallIssue(issue: ZodIssue): issue is ZodIssue & {
  code: 'too_small'
  minimum: number | bigint
  origin: string
} {
  return issue.code === 'too_small'
}

/** Field path in dot notation (e.g., "permissions.defaultMode", "env.DEBUG") */
export type FieldPath = string

export type ValidationError = {
  /** Relative file path */
  file?: string
  /** Field path in dot notation */
  path: FieldPath
  /** Human-readable error message */
  message: string
  /** Expected value or type */
  expected?: string
  /** The actual invalid value that was provided */
  invalidValue?: unknown
  /** Suggestion for fixing the error */
  suggestion?: string
  /** Link to relevant documentation */
  docLink?: string
  /** MCP-specific metadata - only present for MCP configuration errors */
  mcpErrorMetadata?: {
    /** Which configuration scope this error came from */
    scope: ConfigScope
    /** The server name if error is specific to a server */
    serverName?: string
    /** Severity of the error */
    severity?: 'fatal' | 'warning'
  }
}

export type SettingsWithErrors = {
  settings: SettingsJson
  errors: ValidationError[]
}

/**
 * Format a Zod validation error into human-readable validation errors
 */
/**
 * Get the type string for an unknown value (for error messages)
 */
function getReceivedType(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function extractReceivedFromMessage(msg: string): string | undefined {
  const match = msg.match(/received (\w+)/)
  return match ? match[1] : undefined
}

export function formatZodError(
  error: ZodError,
  filePath: string,
): ValidationError[] {
  return error.issues.map((issue): ValidationError => {
    const path = issue.path.map(String).join('.')
    let message = issue.message
    let expected: string | undefined

    let enumValues: string[] | undefined
    let expectedValue: string | undefined
    let receivedValue: unknown
    let invalidValue: unknown

    if (isInvalidValueIssue(issue)) {
      enumValues = issue.values.map(v => String(v))
      expectedValue = enumValues.join(' | ')
      receivedValue = undefined
      invalidValue = undefined
    } else if (isInvalidTypeIssue(issue)) {
      expectedValue = issue.expected
      const receivedType = extractReceivedFromMessage(issue.message)
      receivedValue = receivedType ?? getReceivedType(issue.input)
      invalidValue = receivedType ?? getReceivedType(issue.input)
    } else if (isTooSmallIssue(issue)) {
      expectedValue = String(issue.minimum)
    } else if (issue.code === 'custom' && 'params' in issue) {
      const params = issue.params as { received?: unknown }
      receivedValue = params.received
      invalidValue = receivedValue
    }

    const tip = getValidationTip({
      path,
      code: issue.code,
      expected: expectedValue,
      received: receivedValue,
      enumValues,
      message: issue.message,
      value: receivedValue,
    })

    if (isInvalidValueIssue(issue)) {
      expected = enumValues?.map(v => `"${v}"`).join(', ')
      message = `Invalid value. Expected one of: ${expected}`
    } else if (isInvalidTypeIssue(issue) && issue.expected !== 'never') {
      // Forbidden fields use the schema's explanation of what to remove or
      // replace; treating `never` as an ordinary type loses that guidance.
      const receivedType =
        extractReceivedFromMessage(issue.message) ??
        getReceivedType(issue.input)
      if (
        issue.expected === 'object' &&
        receivedType === 'null' &&
        path === ''
      ) {
        message = 'Invalid or malformed JSON'
      } else {
        message = `Expected ${issue.expected}, but received ${receivedType}`
      }
    } else if (isUnrecognizedKeysIssue(issue)) {
      const keys = issue.keys.join(', ')
      message = `Unrecognized ${plural(issue.keys.length, 'field')}: ${keys}`
    } else if (isTooSmallIssue(issue)) {
      message = `Number must be greater than or equal to ${issue.minimum}`
      expected = String(issue.minimum)
    }

    return {
      file: filePath,
      path,
      message,
      expected,
      invalidValue,
      suggestion: tip?.suggestion,
      docLink: tip?.docLink,
    }
  })
}

/**
 * Validates that settings file content conforms to the SettingsSchema.
 * This is used during file edits to ensure the resulting file is valid.
 */
export function validateSettingsFileContent(content: string):
  | {
      isValid: true
    }
  | {
      isValid: false
      error: string
      fullSchema: string
    } {
  try {
    // Parse the JSON first
    const jsonData = jsonParse(content)

    // Validate against SettingsSchema in strict mode
    const result = z.strictObject(SettingsSchema().shape).safeParse(jsonData)

    if (result.success) {
      return { isValid: true }
    }

    // Format the validation error in a helpful way
    const errors = formatZodError(result.error, 'settings')
    const errorMessage =
      'Settings validation failed:\n' +
      errors.map(err => `- ${err.path}: ${err.message}`).join('\n')

    return {
      isValid: false,
      error: errorMessage,
      fullSchema: generateSettingsJSONSchema(),
    }
  } catch (parseError) {
    return {
      isValid: false,
      error: `Invalid JSON: ${parseError instanceof Error ? parseError.message : 'Unknown parsing error'}`,
      fullSchema: generateSettingsJSONSchema(),
    }
  }
}

/**
 * Filters invalid permission rules from raw parsed JSON data before schema validation.
 * This prevents one bad rule from poisoning the entire settings file.
 * Returns warnings for each filtered rule.
 */
export function filterInvalidPermissionRules(
  data: unknown,
  filePath: string,
): ValidationError[] {
  if (!data || typeof data !== 'object') return []
  const obj = data as Record<string, unknown>
  if (!obj.permissions || typeof obj.permissions !== 'object') return []
  const perms = obj.permissions as Record<string, unknown>

  const warnings: ValidationError[] = []
  for (const key of ['allow', 'deny', 'ask']) {
    const rules = perms[key]
    if (!Array.isArray(rules)) continue

    perms[key] = rules.filter(rule => {
      if (typeof rule !== 'string') {
        warnings.push({
          file: filePath,
          path: `permissions.${key}`,
          message: `Non-string value in ${key} array was removed`,
          invalidValue: rule,
        })
        return false
      }
      const result = validatePermissionRule(rule)
      if (!result.valid) {
        let message = `Invalid permission rule "${rule}" was skipped`
        if (result.error) message += `: ${result.error}`
        if (result.suggestion) message += `. ${result.suggestion}`
        warnings.push({
          file: filePath,
          path: `permissions.${key}`,
          message,
          invalidValue: rule,
        })
        return false
      }
      return true
    })
  }
  return warnings
}

/**
 * Removes command hooks that supply the unsupported `args` field from raw
 * parsed JSON before schema validation. The hook is skipped (it never runs
 * with a different command than intended), and the rest of the file, including
 * its permission rules, still loads. Returns a warning for each removed hook.
 *
 * Matchers, events and the `hooks` object that end up empty because of this
 * filter are removed too. Otherwise a managed source that held nothing but a
 * skipped hook would still count as non-empty and win first-source-wins
 * policy selection over a lower-priority source with real rules.
 */
export function filterUnsupportedCommandHookArgs(
  data: unknown,
  filePath: string,
): ValidationError[] {
  if (!data || typeof data !== 'object') return []
  const root = data as Record<string, unknown>
  const hooks = root.hooks
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return []
  const hooksByEvent = hooks as Record<string, unknown>

  const warnings: ValidationError[] = []
  for (const [event, matchers] of Object.entries(hooksByEvent)) {
    if (!Array.isArray(matchers)) continue
    const keptMatchers = matchers.filter((matcher: unknown, matcherIndex) => {
      if (!matcher || typeof matcher !== 'object') return true
      const config = matcher as Record<string, unknown>
      if (!Array.isArray(config.hooks)) return true
      const hookCount = config.hooks.length
      const keptHooks = config.hooks.filter((hook: unknown, hookIndex) => {
        if (
          !hook ||
          typeof hook !== 'object' ||
          (hook as Record<string, unknown>).type !== 'command' ||
          (hook as Record<string, unknown>).args === undefined
        ) {
          return true
        }
        warnings.push({
          file: filePath,
          path: `hooks.${event}.${matcherIndex}.hooks.${hookIndex}.args`,
          message: `Command hook was skipped. ${COMMAND_HOOK_ARGS_UNSUPPORTED_MESSAGE}`,
          invalidValue: (hook as Record<string, unknown>).args,
        })
        return false
      })
      config.hooks = keptHooks
      return hookCount === 0 || keptHooks.length > 0
    })
    if (keptMatchers.length === matchers.length) continue
    if (keptMatchers.length > 0) {
      hooksByEvent[event] = keptMatchers
    } else {
      delete hooksByEvent[event]
    }
  }
  if (warnings.length > 0 && Object.keys(hooksByEvent).length === 0) {
    delete root.hooks
  }
  return warnings
}

export function filterInvalidModelPricing(
  data: unknown,
  filePath: string,
): ValidationError[] {
  if (
    !data ||
    typeof data !== 'object' ||
    !Object.hasOwn(data, 'modelPricing')
  ) {
    return []
  }

  const result = z
    .object({ modelPricing: ModelPricingDiagnosticSchema })
    .safeParse({
      modelPricing: (data as Record<string, unknown>).modelPricing,
    })
  return result.success ? [] : formatZodError(result.error, filePath)
}
