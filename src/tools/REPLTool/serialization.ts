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

const TRUNCATION_MARKER_PREFIX = '... [truncated '
const TRUNCATION_MARKER_SUFFIX = ' chars]'
const COMPACT_TRUNCATION_MARKER = '...'

function truncationMarker(omittedChars: number): string {
  return `${TRUNCATION_MARKER_PREFIX}${omittedChars}${TRUNCATION_MARKER_SUFFIX}`
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  if (maxLength <= 0) return ''
  const markerBaseLength = TRUNCATION_MARKER_PREFIX.length + TRUNCATION_MARKER_SUFFIX.length
  for (let digits = 1; digits <= String(value.length).length; digits += 1) {
    const payloadLength = maxLength - markerBaseLength - digits
    if (payloadLength < 0) continue
    const omittedChars = value.length - payloadLength
    if (String(omittedChars).length !== digits) continue
    return `${value.slice(0, payloadLength)}${truncationMarker(omittedChars)}`
  }
  if (maxLength <= COMPACT_TRUNCATION_MARKER.length) {
    return COMPACT_TRUNCATION_MARKER.slice(0, maxLength)
  }
  return `${value.slice(0, maxLength - COMPACT_TRUNCATION_MARKER.length)}${COMPACT_TRUNCATION_MARKER}`
}

function writePropertiesOmission(out: Record<string, unknown>, omittedProperties: number): void {
  let markerKey = '__truncated__'
  let collision = 0
  while (Object.prototype.hasOwnProperty.call(out, markerKey)) {
    collision += 1
    markerKey = `__truncated_${collision}__`
  }
  out[markerKey] = `${omittedProperties} properties omitted`
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

  function hasNodeBudget(): boolean {
    return nodes < maxTotalNodes
  }

  function consumeNode(): boolean {
    if (!hasNodeBudget()) return false
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
    if (typeof current === 'bigint') return capString(`${current.toString()}n`)
    if (typeof current === 'symbol') return capString(String(current))
    if (typeof current === 'function') {
      const fn = current as { name?: string }
      return capString(`[function${fn.name ? ` ${fn.name}` : ''}]`)
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
    try {
      if (Array.isArray(current)) {
        const items: unknown[] = []
        const itemLimit = Math.min(current.length, maxArrayLength)
        let serializedItems = 0
        while (serializedItems < itemLimit) {
          if (!hasNodeBudget()) break
          items.push(serializeInner(current[serializedItems], depth + 1))
          serializedItems += 1
        }
        if (serializedItems < current.length) {
          items.push(`[truncated ${current.length - serializedItems} items]`)
        }
        return items
      }
      const input = current as Record<string, unknown>
      const out: Record<string, unknown> = {}
      let consideredProperties = 0
      let omittedProperties = 0
      for (const key in input) {
        if (!Object.prototype.hasOwnProperty.call(input, key)) continue
        if (consideredProperties >= maxObjectProperties) {
          omittedProperties += 1
          continue
        }
        consideredProperties += 1
        if (!hasNodeBudget()) {
          omittedProperties += 1
          continue
        }
        const serializedKey = capString(key)
        if (Object.prototype.hasOwnProperty.call(out, serializedKey)) {
          omittedProperties += 1
          continue
        }
        out[serializedKey] = serializeInner(input[key], depth + 1)
      }
      if (omittedProperties > 0) {
        writePropertiesOmission(out, omittedProperties)
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
