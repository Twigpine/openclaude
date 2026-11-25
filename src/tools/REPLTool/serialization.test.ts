import { describe, expect, test } from 'bun:test'
import { serializeBridgeError, serializeBridgeValue } from './serialization.js'

describe('serializeBridgeValue', () => {
  test('serializes ordinary JSON-compatible values', () => {
    expect(serializeBridgeValue({ a: 1, b: [true, 'x', null] })).toEqual({ a: 1, b: [true, 'x', null] })
  })

  test('represents cycles deterministically', () => {
    const value: { self?: unknown } = {}
    value.self = value
    expect(serializeBridgeValue(value)).toEqual({ self: '[Circular]' })
  })

  test('represents bigint, function, symbol, promise, and binary values without host references', () => {
    const output = serializeBridgeValue({
      bigint: 12n,
      fn: function named() {},
      symbol: Symbol('s'),
      promise: Promise.resolve(1),
      bytes: new Uint8Array(4),
    }) as Record<string, unknown>
    expect(output.bigint).toBe('12n')
    expect(output.fn).toBe('[function named]')
    expect(output.symbol).toBe('Symbol(s)')
    expect(output.promise).toBe('[Promise]')
    expect(output.bytes).toEqual({ type: 'Uint8Array', byteLength: 4, note: 'binary data omitted' })
  })

  test('applies aggregate node and string budgets across shared references', () => {
    const shared = { text: 'x'.repeat(100) }
    const output = serializeBridgeValue({ first: shared, second: shared }, {
      maxTotalNodes: 5,
      maxTotalStringLength: 30,
    }) as Record<string, unknown>
    expect(JSON.stringify(output).length).toBeLessThan(500)
    expect(JSON.stringify(output)).toContain('truncated')

    const wide = serializeBridgeValue({
      a: 'x'.repeat(100),
      b: 'y'.repeat(100),
      c: 'z'.repeat(100),
    }, { maxTotalStringLength: 25 }) as Record<string, unknown>
    expect(String(wide.a).length + String(wide.b).length + String(wide.c).length).toBeLessThan(180)
  })

  test('bounds strings, arrays, objects, and depth', () => {
    const deep: Record<string, unknown> = {}
    let cursor = deep
    for (let i = 0; i < 12; i++) {
      cursor.next = {}
      cursor = cursor.next as Record<string, unknown>
    }
    const output = serializeBridgeValue({
      string: 'x'.repeat(100),
      array: Array.from({ length: 8 }, (_, i) => i),
      object: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, i])),
      deep,
    }, { maxStringLength: 10, maxArrayLength: 3, maxObjectProperties: 2, maxDepth: 3 }) as Record<string, unknown>
    expect(String(output.string)).toContain('truncated')
    expect(output.array).toEqual([0, 1, 2, '[truncated 5 items]'])
    const nestedObject = serializeBridgeValue(
      Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, i])),
      { maxObjectProperties: 2 },
    ) as Record<string, unknown>
    expect(nestedObject.__truncated__).toBe('6 properties omitted')
    const deepOutput = serializeBridgeValue(deep, { maxDepth: 3 })
    expect(JSON.stringify(deepOutput)).toContain('MaxDepth')
  })
})

describe('serializeBridgeError', () => {
  test('serializes Error objects with bounded message and stack', () => {
    const output = serializeBridgeError(new Error('x'.repeat(100)), { maxStringLength: 20 })
    expect(output.name).toBe('Error')
    expect(output.message).toContain('truncated')
  })
})
