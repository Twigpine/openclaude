export interface BridgeSerializationOptions {
  maxStringLength?: number
  maxDepth?: number
  maxArrayLength?: number
  maxObjectProperties?: number
}

const DEFAULT_MAX_STRING_LENGTH = 16_000
const DEFAULT_MAX_DEPTH = 8
const DEFAULT_MAX_ARRAY_LENGTH = 200
const DEFAULT_MAX_OBJECT_PROPERTIES = 200

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]`
}

export function serializeBridgeValue(
  value: unknown,
  options: BridgeSerializationOptions = {},
): unknown {
  const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxArrayLength = options.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH
  const maxObjectProperties = options.maxObjectProperties ?? DEFAULT_MAX_OBJECT_PROPERTIES
  const seen = new WeakSet<object>()

  function serializeInner(current: unknown, depth: number): unknown {
    if (current === null) return null
    if (typeof current === 'string') return truncateString(current, maxStringLength)
    if (typeof current === 'number' || typeof current === 'boolean') return current
    if (typeof current === 'undefined') return '[undefined]'
    if (typeof current === 'bigint') return `${current.toString()}n`
    if (typeof current === 'symbol') return String(current)
    if (typeof current === 'function') {
      const fn = current as { name?: string }
      return `[function${fn.name ? ` ${fn.name}` : ''}]`
    }
    if (current instanceof Date) return current.toISOString()
    if (current instanceof Error) return serializeBridgeError(current, options)
    if (ArrayBuffer.isView(current)) {
      const view = current as { constructor?: { name?: string }; byteLength?: number }
      return {
        type: view.constructor?.name ?? 'TypedArray',
        byteLength: view.byteLength ?? 0,
        note: 'binary data omitted',
      }
    }
    if (current instanceof ArrayBuffer) {
      return { type: 'ArrayBuffer', byteLength: current.byteLength, note: 'binary data omitted' }
    }
    if (current instanceof Promise) return '[Promise]'
    if (typeof current !== 'object') return String(current)
    if (seen.has(current)) return '[Circular]'
    if (depth >= maxDepth) return '[MaxDepth]'
    seen.add(current)
    try {
      if (Array.isArray(current)) {
        const items = current.slice(0, maxArrayLength).map(item => serializeInner(item, depth + 1))
        if (current.length > maxArrayLength) {
          items.push(`[truncated ${current.length - maxArrayLength} items]`)
        }
        return items
      }
      const out: Record<string, unknown> = {}
      const entries = Object.entries(current as Record<string, unknown>)
      for (const [key, entryValue] of entries.slice(0, maxObjectProperties)) {
        out[key] = serializeInner(entryValue, depth + 1)
      }
      if (entries.length > maxObjectProperties) {
        out.__truncated__ = `${entries.length - maxObjectProperties} properties omitted`
      }
      return out
    } finally {
      seen.delete(current)
    }
  }

  return serializeInner(value, 0)
}

export interface SerializedBridgeError {
  name: string
  message: string
  stack?: string
}

export function serializeBridgeError(
  error: unknown,
  options: BridgeSerializationOptions = {},
): SerializedBridgeError {
  const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: truncateString(error.message || String(error), maxStringLength),
      ...(error.stack ? { stack: truncateString(error.stack, maxStringLength) } : {}),
    }
  }
  return {
    name: 'Error',
    message: truncateString(String(serializeBridgeValue(error, options) ?? error), maxStringLength),
  }
}
