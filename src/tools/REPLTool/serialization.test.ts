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
    expect(JSON.stringify(output)).toContain('...')

    const wide = serializeBridgeValue({
      a: 'x'.repeat(100),
      b: 'y'.repeat(100),
      c: 'z'.repeat(100),
    }, { maxTotalStringLength: 25 }) as Record<string, unknown>
    const retainedPayloadChars =
      (String(wide.a).match(/^x*/)?.[0].length ?? 0) +
      (String(wide.b).match(/^y*/)?.[0].length ?? 0) +
      (String(wide.c).match(/^z*/)?.[0].length ?? 0)
    expect(retainedPayloadChars).toBeLessThanOrEqual(25)
  })

  test('applies aggregate string budgets to generated primitive representations', () => {
    const values = [
      Symbol('s'.repeat(200)),
      BigInt(`1${'0'.repeat(200)}`),
      function generatedPrimitiveBudgetProbe() {},
    ]
    for (const value of values) {
      const serialized = serializeBridgeValue(value, {
        maxStringLength: 1_000,
        maxTotalStringLength: 40,
      })
      expect(typeof serialized).toBe('string')
      expect(String(serialized).length).toBeLessThanOrEqual(40)
    }
  })

  test('keeps truncation markers within the configured string length', () => {
    const output = serializeBridgeError(new Error('x'.repeat(100)), { maxStringLength: 30 })
    expect(output.message.length).toBeLessThanOrEqual(30)
    expect(output.message).toMatch(/^x+\.\.\. \[truncated \d+ chars\]$/)

    const compact = serializeBridgeError(new Error('x'.repeat(100)), { maxStringLength: 10 })
    expect(compact.message.length).toBeLessThanOrEqual(10)
  })

  test('does not emit a truncation marker after the aggregate string budget is exhausted', () => {
    const output = serializeBridgeValue(['x'.repeat(100), 'y'.repeat(100)], {
      maxTotalStringLength: 10,
    }) as string[]
    expect(output[0].length).toBeLessThanOrEqual(10)
    expect(output[1]).toBe('')
  })

  test('serializes shared siblings while preserving ancestor cycle detection', () => {
    const shared = { text: 'shared' }
    const value: { self?: unknown; first?: unknown; second?: unknown } = {
      first: shared,
      second: shared,
    }
    value.self = value
    expect(serializeBridgeValue(value)).toEqual({
      first: { text: 'shared' },
      second: { text: 'shared' },
      self: '[Circular]',
    })
  })

  test('omits colliding truncated object keys instead of overwriting them', () => {
    const commonPrefix = 'k'.repeat(100)
    const output = serializeBridgeValue({
      [`${commonPrefix}${'a'.repeat(20)}`]: 'first',
      [`${commonPrefix}${'b'.repeat(20)}`]: 'second',
    }, { maxStringLength: 40 }) as Record<string, unknown>
    const serializedEntries = Object.entries(output).filter(([key]) => key !== '__truncated__')
    expect(serializedEntries).toHaveLength(1)
    expect(serializedEntries[0]?.[1]).toBe('first')
    expect(output.__truncated__).toBe('1 properties omitted')
  })

  test('preserves an own __proto__ entry as a data property', () => {
    const input: Record<string, unknown> = {}
    Object.defineProperty(input, '__proto__', {
      value: 'kept',
      enumerable: true,
      writable: true,
      configurable: true,
    })
    const output = serializeBridgeValue(input) as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(output, '__proto__')).toBe(true)
    expect(Object.getOwnPropertyDescriptor(output, '__proto__')?.value).toBe('kept')
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype)
  })

  test('checks node budget before reading object children and emits one omission marker', () => {
    const input: Record<string, unknown> = { first: 'x' }
    Object.defineProperty(input, 'explosive', {
      enumerable: true,
      get() {
        throw new Error('should not be read')
      },
    })
    const output = serializeBridgeValue(input, { maxTotalNodes: 2 }) as Record<string, unknown>
    expect(output.first).toBe('x')
    expect(output.__truncated__).toBe('1 properties omitted')
  })

  test('checks node budget before reading array children and emits one omission marker', () => {
    const input: unknown[] = ['x']
    Object.defineProperty(input, '1', {
      enumerable: true,
      get() {
        throw new Error('should not be read')
      },
    })
    const output = serializeBridgeValue(input, { maxTotalNodes: 2 })
    expect(output).toEqual(['x', '[truncated 1 items]'])
  })

  test('applies string budgets to object keys as well as values', () => {
    const longKey = 'k'.repeat(10_000)
    const output = serializeBridgeValue({ [longKey]: 'value' }, {
      maxStringLength: 100,
      maxTotalStringLength: 120,
    }) as Record<string, unknown>
    const key = Object.keys(output)[0] ?? ''
    expect(key.length).toBeLessThan(150)
    expect(key).toContain('truncated')
    expect(JSON.stringify(output).length).toBeLessThan(500)
  })

  test('counts host Error message and stack toward aggregate string budgets', () => {
    const error = new Error('m'.repeat(500))
    error.stack = 's'.repeat(500)
    const output = serializeBridgeValue(error, {
      maxStringLength: 1_000,
      maxTotalStringLength: 120,
      maxTotalNodes: 100,
    }) as { name: string; message: string; stack?: string }
    expect(output.name).toBe('Error')
    expect(output.message).toContain('truncated')
    expect(JSON.stringify(output).length).toBeLessThan(500)
  })

  test('counts host Error fields toward aggregate node budgets', () => {
    const error = new Error('message')
    error.stack = 'stack'
    const output = serializeBridgeValue({ error, after: 'x' }, {
      maxTotalNodes: 4,
    }) as { error: { message: string; stack?: string }; after?: string; __truncated__?: string }
    expect(output.error.message).toBe('message')
    expect(output.error.stack).toBe('[SerializationBudget]')
    expect(output.after).toBeUndefined()
    expect(output.__truncated__).toBe('1 properties omitted')
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
    expect(String(output.string).length).toBeLessThanOrEqual(10)
    expect(String(output.string)).toEndWith('...')
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
    expect(output.message.length).toBeLessThanOrEqual(20)
    expect(output.message).toEndWith('...')
  })

  test('preserves already serialized guest error identity', () => {
    const output = serializeBridgeError({
      name: 'TypeError',
      message: 'useful message',
      stack: 'stack text',
    })
    expect(output).toEqual({
      name: 'TypeError',
      message: 'useful message',
      stack: 'stack text',
    })
  })
})
