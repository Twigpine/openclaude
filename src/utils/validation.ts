/**
 * Shared validation utilities for SDK-facing APIs.
 */

/**
 * Validate an array of items using a per-item validator.
 * Throws TypeError with the index and missing field if validation fails.
 */
export function validateArrayOf<T>(
  items: unknown[],
  validator: (item: unknown, index: number) => T,
  label: string,
): T[] {
  if (!Array.isArray(items)) {
    throw new TypeError(`${label}: expected an array, got ${typeof items}`)
  }
  return items.map((item, i) => {
    try {
      return validator(item, i)
    } catch (err) {
      if (err instanceof TypeError) {
        throw new TypeError(`${label}: item at index ${i} - ${err.message}`)
      }
      throw err
    }
  })
}

/**
 * Assert that a value is a non-empty string.
 */
export function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`missing or empty '${field}' (expected non-empty string)`)
  }
}

/**
 * Assert that a value is a non-null object (but not an array).
 */
export function assertObject(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`missing or invalid '${field}' (expected object)`)
  }
}

/**
 * Assert that a value is a function.
 */
export function assertFunction(value: unknown, field: string): asserts value is (...args: unknown[]) => unknown {
  if (typeof value !== 'function') {
    throw new TypeError(`missing or invalid '${field}' (expected function)`)
  }
}
