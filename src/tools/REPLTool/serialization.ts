export interface BridgeSerializationOptions {
  maxStringLength?: number
  maxDepth?: number
  maxArrayLength?: number
  maxObjectProperties?: number
  maxTotalNodes?: number
  maxTotalStringLength?: number
}

const DEFAULT_MAX_STRING_LENGTH = 16_000
const DEFAULT_MAX_DEPTH = 8
const DEFAULT_MAX_ARRAY_LENGTH = 200
const DEFAULT_MAX_OBJECT_PROPERTIES = 200
const DEFAULT_MAX_TOTAL_NODES = 2_000
const DEFAULT_MAX_TOTAL_STRING_LENGTH = 128_000

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]`
}

function errorStringField(error: Error, key: 'name' | 'message' | 'stack'): string | undefined {
  try {
    const value = error[key]
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

function safeToString(value: unknown): string {
  try {
    return String(value)
  } catch {
    return '[unprintable value]'
  }
}

export function serializeBridgeValue(
  value: unknown,
  options: BridgeSerializationOptions = {},
): unknown {
  const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxArrayLength = options.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH
  const maxObjectProperties = options.maxObjectProperties ?? DEFAULT_MAX_OBJECT_PROPERTIES
  const maxTotalNodes = options.maxTotalNodes ?? DEFAULT_MAX_TOTAL_NODES
  const maxTotalStringLength = options.maxTotalStringLength ?? DEFAULT_MAX_TOTAL_STRING_LENGTH
  const seen = new WeakSet<object>()
  let nodes = 0
  let stringChars = 0

  function capString(value: string): string {
    const serialized = truncateString(value, Math.min(maxStringLength, Math.max(0, maxTotalStringLength - stringChars)))
    stringChars += serialized.length
    return serialized
  }

  function consumeNode(): boolean {
    if (nodes >= maxTotalNodes) return false
    nodes += 1
    return true
  }

  function capErrorPart(value: string): string {
    if (!consumeNode()) return '[SerializationBudget]'
    return capString(value)
  }

  function serializeErrorValue(error: Error): SerializedBridgeError {
    const message = errorStringField(error, 'message') || safeToString(error)
    const stack = errorStringField(error, 'stack')
    return {
      name: capErrorPart(errorStringField(error, 'name') || 'Error'),
      message: capErrorPart(message),
      ...(stack ? { stack: capErrorPart(stack) } : {}),
    }
  }

  function serializeInner(current: unknown, depth: number): unknown {
    if (!consumeNode()) return '[SerializationBudget]'
    if (current === null) return null
    if (typeof current === 'string') {
      return capString(current)
    }
    if (typeof current === 'number' || typeof current === 'boolean') return current
    if (typeof current === 'undefined') return '[undefined]'
    if (typeof current === 'bigint') return `${current.toString()}n`
    if (typeof current === 'symbol') return String(current)
    if (typeof current === 'function') {
      const fn = current as { name?: string }
      return `[function${fn.name ? ` ${fn.name}` : ''}]`
    }
    if (current instanceof Date) return current.toISOString()
    if (current instanceof Error) return serializeErrorValue(current)
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
    {
      if (Array.isArray(current)) {
        const items = current.slice(0, maxArrayLength).map(item => serializeInner(item, depth + 1))
        if (current.length > maxArrayLength) {
          items.push(`[truncated ${current.length - maxArrayLength} items]`)
        }
        return items
      }
      const out: Record<string, unknown> = {}
      let propertyCount = 0
      let serializedProperties = 0
      for (const key in current as Record<string, unknown>) {
        if (!Object.prototype.hasOwnProperty.call(current, key)) continue
        propertyCount += 1
        if (serializedProperties >= maxObjectProperties) continue
        serializedProperties += 1
        out[capString(key)] = serializeInner((current as Record<string, unknown>)[key], depth + 1)
      }
      if (propertyCount > maxObjectProperties) {
        out.__truncated__ = `${propertyCount - maxObjectProperties} properties omitted`
      }
      return out
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
    const message = errorStringField(error, 'message') || safeToString(error)
    const stack = errorStringField(error, 'stack')
    return {
      name: truncateString(errorStringField(error, 'name') || 'Error', maxStringLength),
      message: truncateString(message, maxStringLength),
      ...(stack ? { stack: truncateString(stack, maxStringLength) } : {}),
    }
  }
  if (typeof error === 'object' && error !== null) {
    try {
      const serialized = error as { name?: unknown; message?: unknown; stack?: unknown }
      if (typeof serialized.name === 'string' && typeof serialized.message === 'string') {
        return {
          name: truncateString(serialized.name || 'Error', maxStringLength),
          message: truncateString(serialized.message, maxStringLength),
          ...(typeof serialized.stack === 'string'
            ? { stack: truncateString(serialized.stack, maxStringLength) }
            : {}),
        }
      }
    } catch {
      return {
        name: 'Error',
        message: 'Error object could not be serialized',
      }
    }
  }
  let message: string
  try {
    message = String(serializeBridgeValue(error, options) ?? error)
  } catch {
    message = safeToString(error)
  }
  return {
    name: 'Error',
    message: truncateString(message, maxStringLength),
  }
}
