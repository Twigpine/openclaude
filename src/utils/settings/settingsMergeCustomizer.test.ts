import { describe, expect, test } from 'bun:test'
import mergeWith from 'lodash-es/mergeWith.js'
import { settingsMergeCustomizer } from './settings.js'

/**
 * Unit tests for the multi-source settings merge customizer.
 *
 * The customizer is the security-sensitive seam that combines policy,
 * user, and project settings: permission arrays concatenate with
 * deduplication (target/source priority), modelPricing entries replace
 * atomically on a null-prototype map so arbitrary model ids cannot be
 * interpreted as structure, and every other key defers to lodash's
 * default deep merge.
 */
function merge(a: unknown, b: unknown, key?: PropertyKey): unknown {
  return mergeWith(
    structuredClone(a),
    structuredClone(b),
    (objValue: unknown, srcValue: unknown, k: PropertyKey | undefined) =>
      settingsMergeCustomizer(objValue, srcValue, k ?? key),
  )
}

describe('settingsMergeCustomizer', () => {
  test('concatenates and deduplicates string arrays with target priority', () => {
    const merged = merge(
      { permissions: { allow: ['Bash(npm:*)', 'Read(*)'] } },
      { permissions: { allow: ['Bash(npm:*)', 'WebFetch(domain:x.com)'] } },
    ) as { permissions: { allow: string[] } }

    expect(merged.permissions.allow).toEqual([
      'Bash(npm:*)',
      'Read(*)',
      'WebFetch(domain:x.com)',
    ])
  })

  test('deduplicates object arrays only by reference, keeping both copies of equal-content objects', () => {
    // Documents current behaviour: uniq() cannot collapse structurally
    // equal but distinct object elements (e.g. hook definitions from two
    // sources). Both survive the merge.
    const merged = merge(
      { hooks: [{ matcher: 'Bash', command: 'a' }] },
      { hooks: [{ matcher: 'Bash', command: 'a' }] },
    ) as { hooks: unknown[] }

    expect(merged.hooks).toHaveLength(2)
  })

  test('replaces modelPricing entries atomically per model id', () => {
    const merged = merge(
      {
        modelPricing: {
          'claude-x': { input: 3, output: 15, webSearchRequests: 10 },
        },
      },
      {
        modelPricing: {
          'claude-x': { input: 5, output: 25 },
          'claude-y': { input: 1, output: 4 },
        },
      },
    ) as {
      modelPricing: Record<
        string,
        { input: number; output: number; webSearchRequests?: number }
      >
    }

    // The higher-priority entry wins whole: a missing optional field must
    // use its documented default, not inherit the lower source's value.
    expect(merged.modelPricing['claude-x']).toEqual({
      input: 5,
      output: 25,
    })
    expect(merged.modelPricing['claude-y']).toEqual({ input: 1, output: 4 })
  })

  test('preserves Object.prototype-named model ids without polluting structure', () => {
    const merged = merge(
      {},
      {
        modelPricing: {
          constructor: { input: 1, output: 2 },
          toString: { input: 3, output: 6 },
        },
      },
    ) as { modelPricing: Record<string, unknown> }

    expect(Object.keys(merged.modelPricing).sort()).toEqual([
      'constructor',
      'toString',
    ])
    expect(merged.modelPricing['constructor']).toEqual({ input: 1, output: 2 })
    expect(merged.modelPricing['toString']).toEqual({ input: 3, output: 6 })

    // The merged map itself must be the null-prototype map the customizer
    // builds, not a plain object that happens to carry the keys.
    expect(Object.getPrototypeOf(merged.modelPricing)).toBeNull()
  })

  test('defers non-array non-modelPricing keys to lodash default deep merge', () => {
    const merged = merge(
      { a: { b: 1, c: 2 }, keep: true },
      { a: { c: 3, d: 4 } },
    ) as { a: { b: number; c: number; d: number }; keep: boolean }

    expect(merged).toEqual({
      a: { b: 1, c: 3, d: 4 },
      keep: true,
    })
  })

  test('customizer passes keys through to lodash untouched', () => {
    // The key argument is optional; calling without one must still defer.
    expect(settingsMergeCustomizer(1, 2)).toBeUndefined()
    expect(settingsMergeCustomizer([1], [2], 'permissions')).toEqual([1, 2])
  })
})
