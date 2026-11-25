import variant from '@jitl/quickjs-singlefile-mjs-release-sync'
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core'
import { jsonParse } from '../../utils/slowOperations.js'
import { isLegalGuestIdentifier } from './guestIdentifiers.js'
import { sleep } from '../../utils/sleep.js'
import {
  serializeBridgeError,
  serializeBridgeValue,
} from './serialization.js'

export type QuickJSHostFunction = (args: unknown[]) => unknown | Promise<unknown>

export interface QuickJSScriptCompletionState {
  pendingHostFunctionNames: readonly string[]
}

export interface QuickJSExecutionOptions {
  code: string
  hostFunctions?: Record<string, QuickJSHostFunction>
  timeoutMs?: number
  memoryLimitBytes?: number
  maxStackSizeBytes?: number
  stdoutLimit?: number
  stderrLimit?: number
  /**
   * Maximum UTF-8 bytes accepted in the serialized arguments of one host call.
   * Inputs are measured as JSON text before JSON.parse materializes host objects.
   */
  maxInputBytesPerCall?: number
  /**
   * Maximum aggregate UTF-8 bytes accepted across all host calls in one script.
   * This includes calls that are still queued behind inner tool concurrency control.
   */
  maxInputBytesPerScript?: number
  abortSignal?: AbortSignal
  promptWaitTracker?: PromptWaitTracker
  onScriptCompletion?: (state: QuickJSScriptCompletionState) => void
}

export interface QuickJSExecutionResult {
  status: 'completed' | 'error' | 'timeout' | 'aborted'
  result?: unknown
  error?: ReturnType<typeof serializeBridgeError>
  stdout: string
  stderr: string
  durationMs: number
}

interface HostPromiseObservation {
  token: number
  functionName: string
  observed: boolean
  settled: boolean
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024
const DEFAULT_STACK_SIZE_BYTES = 1024 * 1024
const DEFAULT_OUTPUT_LIMIT = 64 * 1024
// One MiB preserves ordinary large Write/Bash inputs while preventing a single
// tool call from consuming a large fraction of the 64 MiB QuickJS memory limit.
const DEFAULT_INPUT_BYTES_PER_CALL = 1024 * 1024
// Eight MiB matches eight saturated default concurrency lanes. The aggregate is
// charged when the input crosses the host boundary, before any queueing in the
// inner tool runner, so queued fanout cannot multiply host memory without bound.
const DEFAULT_INPUT_BYTES_PER_SCRIPT = 8 * 1024 * 1024
// Input conversion failures never reach the inner tool runner, so the bridge
// keeps its own finite count of attempted host crossings. Keep this aligned
// with DEFAULT_REPL_RESOURCE_CAPS.maxTotalCalls.
const MAX_HOST_CALL_ATTEMPTS = 100


// Native promise awaiting uses internal promise slots and does not call the
// observable Promise.prototype.then implementation. A Proxy has no promise
// internal slots, so await, return assimilation, and Promise.all read its then
// property while the proxy still preserves the target promise's shape.
const OBSERVABLE_HOST_PROMISE_FACTORY_SOURCE = `
(function() {
  const promiseThen = Promise.prototype.then
  const promiseCatch = Promise.prototype.catch
  const promiseFinally = Promise.prototype.finally
  const reflectGet = Reflect.get
  const proxyConstructor = Proxy
  return function createObservableHostPromise(promise, token, observe) {
    let observed = false
    function markObserved() {
      if (!observed) {
        observed = true
        observe(token)
      }
    }
    // Keep host rejections out of QuickJS's unhandled-rejection path. Observation
    // is tracked separately so a detached rejection remains a contract violation.
    promiseCatch.call(promise, function() {})
    return new proxyConstructor(promise, {
      get: function(target, property, receiver) {
        if (property === 'then') {
          return function(onFulfilled, onRejected) {
            markObserved()
            return promiseThen.call(target, onFulfilled, onRejected)
          }
        }
        if (property === 'catch') {
          return function(onRejected) {
            markObserved()
            return promiseCatch.call(target, onRejected)
          }
        }
        if (property === 'finally') {
          return function(onFinally) {
            markObserved()
            return promiseFinally.call(target, onFinally)
          }
        }
        return reflectGet(target, property, receiver)
      },
    })
  }
})()
`

const BOUNDED_GUEST_SERIALIZER_SOURCE = `
(function() {
  const maxStringLength = 16000
  const maxDepth = 8
  const maxArrayLength = 200
  const maxObjectProperties = 200
  const maxTotalNodes = 2000
  const maxTotalStringChars = 128000
  const truncationMarkerPrefix = '... [truncated '
  const truncationMarkerSuffix = ' chars]'
  const compactTruncationMarker = '...'
  const objectHasOwn = Object.prototype.hasOwnProperty

  function truncationMarker(omittedChars) {
    return truncationMarkerPrefix + omittedChars + truncationMarkerSuffix
  }

  function truncateString(value, remaining) {
    const maxLength = Math.min(maxStringLength, Math.max(0, remaining))
    if (value.length <= maxLength) return value
    if (maxLength <= 0) return ''
    const markerBaseLength = truncationMarkerPrefix.length + truncationMarkerSuffix.length
    const maxDigits = String(value.length).length
    for (let digits = 1; digits <= maxDigits; digits += 1) {
      const payloadLength = maxLength - markerBaseLength - digits
      if (payloadLength < 0) continue
      const omittedChars = value.length - payloadLength
      if (String(omittedChars).length !== digits) continue
      return value.slice(0, payloadLength) + truncationMarker(omittedChars)
    }
    if (maxLength <= compactTruncationMarker.length) {
      return compactTruncationMarker.slice(0, maxLength)
    }
    return value.slice(0, maxLength - compactTruncationMarker.length) + compactTruncationMarker
  }

  function writeDataProperty(out, key, value) {
    Object.defineProperty(out, key, {
      value: value,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }

  function writePropertiesOmission(out, omittedProperties) {
    let markerKey = '__truncated__'
    let collision = 0
    while (objectHasOwn.call(out, markerKey)) {
      collision += 1
      markerKey = '__truncated_' + collision + '__'
    }
    writeDataProperty(out, markerKey, omittedProperties + ' properties omitted')
  }

  return function serializeReplValue(value) {
    let nodes = 0
    let stringChars = 0
    const seen = new WeakSet()
    function capString(value) {
      const stringValue = String(value)
      const serialized = truncateString(stringValue, maxTotalStringChars - stringChars)
      stringChars += serialized.length
      return serialized
    }
    function serializeInner(current, depth) {
      if (nodes >= maxTotalNodes) return '[SerializationBudget]'
      nodes += 1
      if (current === null) return null
      const type = typeof current
      if (type === 'string') return capString(current)
      if (type === 'number' || type === 'boolean') return current
      if (type === 'undefined') return '[undefined]'
      if (type === 'bigint') return capString(current.toString() + 'n')
      if (type === 'symbol') return capString(String(current))
      if (type === 'function') return capString('[function' + (current.name ? ' ' + current.name : '') + ']')
      if (type !== 'object') return capString(String(current))
      if (seen.has(current)) return '[Circular]'
      if (depth >= maxDepth) return '[MaxDepth]'
      seen.add(current)
      if (current instanceof Date) return current.toISOString()
      if (current instanceof Error) {
        return {
          name: capString(current.name || 'Error'),
          message: serializeInner(current.message || String(current), depth + 1),
          ...(current.stack ? { stack: serializeInner(current.stack, depth + 1) } : {}),
        }
      }
      if (ArrayBuffer.isView(current)) {
        return { type: capString(current.constructor && current.constructor.name || 'TypedArray'), byteLength: current.byteLength || 0, note: 'binary data omitted' }
      }
      if (current instanceof ArrayBuffer) {
        return { type: 'ArrayBuffer', byteLength: current.byteLength, note: 'binary data omitted' }
      }
      if (current instanceof Promise) return '[Promise]'
      if (Array.isArray(current)) {
        const items = current.slice(0, maxArrayLength).map(item => serializeInner(item, depth + 1))
        if (current.length > maxArrayLength) items.push('[truncated ' + (current.length - maxArrayLength) + ' items]')
        return items
      }
      const out = {}
      const entries = Object.entries(current)
      let omittedProperties = 0
      const entryLimit = Math.min(entries.length, maxObjectProperties)
      for (let index = 0; index < entryLimit; index += 1) {
        const entry = entries[index]
        const serializedKey = capString(entry[0])
        const serializedValue = serializeInner(entry[1], depth + 1)
        if (objectHasOwn.call(out, serializedKey)) {
          omittedProperties += 1
          continue
        }
        writeDataProperty(out, serializedKey, serializedValue)
      }
      if (entries.length > maxObjectProperties) omittedProperties += entries.length - maxObjectProperties
      if (omittedProperties > 0) writePropertiesOmission(out, omittedProperties)
      return out
    }
    return serializeInner(value, 0)
  }
})()
`

let quickjsModulePromise: Promise<QuickJSWASMModule> | undefined

function getQuickJSModule(): Promise<QuickJSWASMModule> {
  quickjsModulePromise ??= newQuickJSWASMModuleFromVariant(variant)
  return quickjsModulePromise
}

export class PromptWaitTracker {
  private excludedMs = 0
  private activeWaits = 0
  private startedAt: number | undefined

  begin(): void {
    this.activeWaits += 1
    if (this.activeWaits === 1) this.startedAt = Date.now()
  }

  end(): void {
    if (this.activeWaits === 0) return
    this.activeWaits -= 1
    if (this.activeWaits === 0 && this.startedAt !== undefined) {
      this.excludedMs += Date.now() - this.startedAt
      this.startedAt = undefined
    }
  }

  currentExcludedMs(now = Date.now()): number {
    return this.excludedMs + (this.startedAt === undefined ? 0 : now - this.startedAt)
  }

  isActive(): boolean {
    return this.activeWaits > 0
  }
}

function disposeQuietly(value: { dispose: () => void } | undefined): void {
  if (!value) return
  try {
    value.dispose()
  } catch {
    // Teardown must remain deterministic even when QuickJS already released the handle.
  }
}

function hostValueToQuickJS(context: QuickJSContext, value: unknown, depth = 0): QuickJSHandle {
  if (value === null) return context.null
  if (typeof value === 'undefined') return context.undefined
  if (typeof value === 'number') return context.newNumber(value)
  if (typeof value === 'string') return context.newString(value)
  if (typeof value === 'boolean') return value ? context.true : context.false
  if (typeof value === 'bigint') return context.newBigInt(value)
  if (depth > 8) return context.newString('[MaxDepth]')
  if (Array.isArray(value)) {
    const arr = context.newArray()
    value.forEach((item, index) => {
      const child = hostValueToQuickJS(context, item, depth + 1)
      context.setProp(arr, index, child)
      disposeQuietly(child)
    })
    return arr
  }
  if (typeof value === 'object') {
    const obj = context.newObject()
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      const child = hostValueToQuickJS(context, entryValue, depth + 1)
      context.setProp(obj, key, child)
      disposeQuietly(child)
    }
    return obj
  }
  return context.newString(String(serializeBridgeValue(value)))
}

function errorHandleToSerializedUnbounded(context: QuickJSContext, errorHandle: QuickJSHandle) {
  try {
    return serializeBridgeError(context.dump(errorHandle))
  } catch (error) {
    return serializeBridgeError(error)
  }
}

export async function executeQuickJSScript(
  options: QuickJSExecutionOptions,
): Promise<QuickJSExecutionResult> {
  const startedAt = Date.now()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const stdoutLimit = options.stdoutLimit ?? DEFAULT_OUTPUT_LIMIT
  const stderrLimit = options.stderrLimit ?? DEFAULT_OUTPUT_LIMIT
  const maxInputBytesPerCall = options.maxInputBytesPerCall ?? DEFAULT_INPUT_BYTES_PER_CALL
  const maxInputBytesPerScript = options.maxInputBytesPerScript ?? DEFAULT_INPUT_BYTES_PER_SCRIPT
  const promptWaitTracker = options.promptWaitTracker ?? new PromptWaitTracker()
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  let stdoutLength = 0
  let stderrLength = 0
  let acceptedInputBytes = 0
  let timedOut = false
  let aborted = false
  let tornDown = false

  let hostCallAttempts = 0
  let hostCallAttemptFailure: Error | undefined
  let promptWaitGuestExecutionMs = 0
  let activeGuestExecution: { startedAt: number; duringPromptWait: boolean } | undefined

  const currentPromptWaitGuestExecutionMs = (now: number): number => {
    const activeExecution = activeGuestExecution
    const active = activeExecution?.duringPromptWait
      ? now - activeExecution.startedAt
      : 0
    return promptWaitGuestExecutionMs + active
  }
  // Prompt wait time is excluded as host think time, but any guest jobs that
  // run during that wait still consume the execution budget.
  const executionMs = () => {
    const now = Date.now()
    return now - startedAt - promptWaitTracker.currentExcludedMs(now) + currentPromptWaitGuestExecutionMs(now)
  }
  const runGuest = <T>(operation: () => T): T => {
    if (activeGuestExecution) return operation()
    const execution = {
      startedAt: Date.now(),
      duringPromptWait: promptWaitTracker.isActive(),
    }
    activeGuestExecution = execution
    try {
      return operation()
    } finally {
      const endedAt = Date.now()
      if (execution.duringPromptWait) {
        promptWaitGuestExecutionMs += endedAt - execution.startedAt
      }
      activeGuestExecution = undefined
    }
  }
  const appendOutput = (chunks: string[], currentLength: number, chunk: string, maxLength: number): number => {
    if (currentLength >= maxLength) return currentLength
    const remaining = maxLength - currentLength
    chunks.push(chunk.length <= remaining ? chunk : chunk.slice(0, remaining))
    return Math.min(maxLength, currentLength + chunk.length)
  }
  const stdoutText = () => stdoutChunks.join('')
  const stderrText = () => stderrChunks.join('')
  const quickjs = await getQuickJSModule()
  const runtime = quickjs.newRuntime()
  runtime.setMemoryLimit(options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES)
  runtime.setMaxStackSize(options.maxStackSizeBytes ?? DEFAULT_STACK_SIZE_BYTES)
  runtime.setInterruptHandler(() => {
    if (options.abortSignal?.aborted) {
      aborted = true
      return true
    }
    if (hostCallAttemptFailure) {
      return true
    }
    if (executionMs() > timeoutMs) {
      timedOut = true
      return true
    }
    return false
  })

  const context = runtime.newContext()
  const activeDisposables = new Set<{ dispose: () => void }>()
  const activeDeferreds = new Set<{ reject: (value: QuickJSHandle) => void }>()
  const serializerResult = runGuest(() => context.evalCode(BOUNDED_GUEST_SERIALIZER_SOURCE, 'repl-serializer.js', { type: 'global', strict: true }))
  if (serializerResult.error) {
    const error = errorHandleToSerializedUnbounded(context, serializerResult.error)
    disposeQuietly(serializerResult.error)
    disposeQuietly(context)
    disposeQuietly(runtime)
    throw new Error(`Failed to install REPL serializer: ${error.message}`)
  }
  const serializerHandle = serializerResult.value
  activeDisposables.add(serializerHandle)

  function errorHandleToSerialized(errorHandle: QuickJSHandle) {
    try {
      const dumped = dumpBoundedGuestValue(errorHandle)
      if (
        typeof dumped === 'object' &&
        dumped !== null &&
        typeof (dumped as { serializationError?: unknown }).serializationError === 'string'
      ) {
        return serializeBridgeError(new Error((dumped as { serializationError: string }).serializationError))
      }
      return serializeBridgeError(dumped)
    } catch (error) {
      return serializeBridgeError(error)
    }
  }

  const hostPromiseObservations = new Map<number, HostPromiseObservation>()
  // Retire entries once settlement and observation both happened. Entries that
  // settle before observation stay addressable so a later await can still clear
  // the completion-time violation; the host attempt budget bounds their count.
  const retireObservedSettlement = (observation: HostPromiseObservation): void => {
    if (observation.settled && observation.observed) {
      hostPromiseObservations.delete(observation.token)
    }
  }
  const markHostPromiseSettled = (observation: HostPromiseObservation): void => {
    observation.settled = true
    retireObservedSettlement(observation)
  }
  let nextHostPromiseToken = 1
  let observableFactoryHandle: QuickJSHandle | undefined
  let observeHostPromiseHandle: QuickJSHandle | undefined
  if (Object.keys(options.hostFunctions ?? {}).length > 0) {
    const observableFactoryResult = runGuest(() => context.evalCode(
      OBSERVABLE_HOST_PROMISE_FACTORY_SOURCE,
      'repl-observable-host-promise.js',
      { type: 'global', strict: true },
    ))
    if (observableFactoryResult.error) {
      const error = errorHandleToSerialized(observableFactoryResult.error)
      disposeQuietly(observableFactoryResult.error)
      for (const disposable of activeDisposables) disposeQuietly(disposable)
      disposeQuietly(context)
      disposeQuietly(runtime)
      throw new Error(`Failed to install REPL host promise observer: ${error.message}`)
    }
    observableFactoryHandle = observableFactoryResult.value
    activeDisposables.add(observableFactoryHandle)
    observeHostPromiseHandle = context.newFunction('observeHostPromise', (...args) => {
      const tokenHandle = args[0]
      if (!tokenHandle || context.typeof(tokenHandle) !== 'number') return context.undefined
      const observation = hostPromiseObservations.get(context.getNumber(tokenHandle))
      if (observation) {
        observation.observed = true
        retireObservedSettlement(observation)
      }
      return context.undefined
    })
    activeDisposables.add(observeHostPromiseHandle)
  }

  function beginHostPromiseObservation(functionName: string, settled: boolean): HostPromiseObservation {
    const observation: HostPromiseObservation = {
      token: nextHostPromiseToken,
      functionName,
      observed: false,
      settled,
    }
    nextHostPromiseToken += 1
    hostPromiseObservations.set(observation.token, observation)
    return observation
  }

  function wrapHostPromise(
    promiseHandle: QuickJSHandle,
    observation: HostPromiseObservation,
  ): QuickJSHandle {
    if (!observableFactoryHandle || !observeHostPromiseHandle) {
      throw new Error('REPL host promise observer is not installed')
    }
    const tokenHandle = context.newNumber(observation.token)
    const wrapped = (() => {
      try {
        return runGuest(() => context.callFunction(observableFactoryHandle, context.undefined, [
          promiseHandle,
          tokenHandle,
          observeHostPromiseHandle,
        ]))
      } finally {
        disposeQuietly(tokenHandle)
        // The wrapper closure now owns the guest-side promise reference. Since the
        // raw promise handle is not the host function return value, release this
        // host reference; resolver handles stay alive until settlement.
        disposeQuietly(promiseHandle)
      }
    })()
    if (wrapped.error) {
      const serialized = errorHandleToSerialized(wrapped.error)
      disposeQuietly(wrapped.error)
      throw new Error(`Failed to wrap REPL host promise: ${serialized.message}`)
    }
    return wrapped.value
  }

  const jsonHandle = context.getProp(context.global, 'JSON')
  const jsonStringifyHandle = context.getProp(jsonHandle, 'stringify')
  disposeQuietly(jsonHandle)
  activeDisposables.add(jsonStringifyHandle)

  function dumpBoundedGuestValue(handle: QuickJSHandle): unknown {
    const serialized = runGuest(() => context.callFunction(serializerHandle, context.undefined, [handle]))
    if (serialized.error) {
      disposeQuietly(serialized.error)
      return { serializationError: 'QuickJS guest value could not be serialized' }
    }
    try {
      return context.dump(serialized.value)
    } finally {
      disposeQuietly(serialized.value)
    }
  }

  function guestInputsFromHandles(functionName: string, handles: QuickJSHandle[]): unknown[] {
    const jsonTexts: Array<string | undefined> = []
    let inputBytes = 0
    for (const handle of handles) {
      const stringified = runGuest(() => context.callFunction(jsonStringifyHandle, context.undefined, [handle]))
      if (stringified.error) {
        const serialized = errorHandleToSerialized(stringified.error)
        disposeQuietly(stringified.error)
        throw new Error(`REPL tool input is not JSON-compatible: ${serialized.message}`)
      }
      let jsonText: string | undefined
      if (context.typeof(stringified.value) === 'string') {
        // UTF-8 byte length is at least the UTF-16 string length, so this guest-side
        // check can reject clearly oversized inputs without copying the JSON text.
        const lengthHandle = context.getProp(stringified.value, 'length')
        const jsonTextLength = context.getNumber(lengthHandle)
        disposeQuietly(lengthHandle)
        const callBytesLowerBound = inputBytes + jsonTextLength
        if (callBytesLowerBound > maxInputBytesPerCall) {
          disposeQuietly(stringified.value)
          throw new Error(
            `REPL input to ${functionName} exceeds the per-call serialized input budget (at least ${callBytesLowerBound} of ${maxInputBytesPerCall} bytes)`,
          )
        }
        const acceptedLowerBound = acceptedInputBytes + callBytesLowerBound
        if (acceptedLowerBound > maxInputBytesPerScript) {
          disposeQuietly(stringified.value)
          throw new Error(
            `REPL input to ${functionName} exceeds the per-script serialized input budget (at least ${acceptedLowerBound} of ${maxInputBytesPerScript} bytes)`,
          )
        }
        jsonText = context.dump(stringified.value) as string
      }
      disposeQuietly(stringified.value)
      jsonTexts.push(jsonText)
      if (jsonText !== undefined) inputBytes += Buffer.byteLength(jsonText, 'utf8')
    }

    // Budget the serialized JSON text before JSON.parse materializes the host
    // object graph. Only successfully parsed calls are charged to the aggregate.
    if (inputBytes > maxInputBytesPerCall) {
      throw new Error(
        `REPL input to ${functionName} exceeds the per-call serialized input budget (${inputBytes} of ${maxInputBytesPerCall} bytes)`,
      )
    }
    const acceptedAfterCall = acceptedInputBytes + inputBytes
    if (acceptedAfterCall > maxInputBytesPerScript) {
      throw new Error(
        `REPL input to ${functionName} exceeds the per-script serialized input budget (${acceptedAfterCall} of ${maxInputBytesPerScript} bytes)`,
      )
    }
    const args: unknown[] = []
    for (let index = 0; index < jsonTexts.length; index++) {
      const jsonText = jsonTexts[index]
      jsonTexts[index] = undefined
      args.push(jsonText === undefined ? undefined : jsonParse(jsonText))
    }
    acceptedInputBytes = acceptedAfterCall
    return args
  }

  function installConsole(): void {
    const consoleObject = context.newObject()
    for (const method of ['log', 'info', 'debug'] as const) {
      const fn = context.newFunction(method, (...args) => {
        stdoutLength = appendOutput(
          stdoutChunks,
          stdoutLength,
          `${args.map(arg => String(serializeBridgeValue(dumpBoundedGuestValue(arg)))).join(' ')}\n`,
          stdoutLimit,
        )
        return context.undefined
      })
      context.setProp(consoleObject, method, fn)
      disposeQuietly(fn)
    }
    for (const method of ['warn', 'error'] as const) {
      const fn = context.newFunction(method, (...args) => {
        stderrLength = appendOutput(
          stderrChunks,
          stderrLength,
          `${args.map(arg => String(serializeBridgeValue(dumpBoundedGuestValue(arg)))).join(' ')}\n`,
          stderrLimit,
        )
        return context.undefined
      })
      context.setProp(consoleObject, method, fn)
      disposeQuietly(fn)
    }
    context.setProp(context.global, 'console', consoleObject)
    disposeQuietly(consoleObject)
  }

  function installHostFunction(name: string, implementation: QuickJSHostFunction): void {
    if (!isLegalGuestIdentifier(name)) {
      throw new Error(`Invalid QuickJS host function name: ${name}`)
    }
    const fn = context.newFunction(name, (...argHandles) => {
      hostCallAttempts += 1
      if (hostCallAttempts > MAX_HOST_CALL_ATTEMPTS) {
        hostCallAttemptFailure ??= new Error(`REPL host call attempt budget exceeded (${MAX_HOST_CALL_ATTEMPTS})`)
        throw hostCallAttemptFailure
      }
      let args: unknown[]
      try {
        args = guestInputsFromHandles(name, argHandles)
      } catch (error) {
        // Input validation failures are tool call rejections rather than host
        // exceptions, matching the asynchronous error shape of inner tools.
        const inputError = serializeBridgeError(error)
        const inputErrorHandle = context.newError({
          name: inputError.name,
          message: inputError.message,
        })
        const rejectedInput = context.newPromise()
        rejectedInput.reject(inputErrorHandle)
        disposeQuietly(inputErrorHandle)
        return wrapHostPromise(rejectedInput.handle, beginHostPromiseObservation(name, true))
      }
      const deferred = context.newPromise()
      const observation = beginHostPromiseObservation(name, false)
      activeDeferreds.add(deferred)
      void Promise.resolve()
        .then(() => implementation(args))
        .then(value => {
          if (tornDown) return
          markHostPromiseSettled(observation)
          const serialized = serializeBridgeValue(value)
          const resultHandle = hostValueToQuickJS(context, serialized)
          deferred.resolve(resultHandle)
          disposeQuietly(resultHandle)
        })
        .catch((error: unknown) => {
          if (tornDown) return
          markHostPromiseSettled(observation)
          const serialized = serializeBridgeError(error)
          const errorHandle = context.newError({
            name: serialized.name,
            message: serialized.message,
          })
          deferred.reject(errorHandle)
          disposeQuietly(errorHandle)
        })
        .finally(() => {
          activeDeferreds.delete(deferred)
        })
      return wrapHostPromise(deferred.handle, observation)
    })
    context.setProp(context.global, name, fn)
    disposeQuietly(fn)
  }

  let settlementResultValueHandle: QuickJSHandle | undefined
  let settlementErrorHandle: QuickJSHandle | undefined
  let scriptPromiseHandle: QuickJSHandle | undefined

  try {
    installConsole()
    for (const [name, implementation] of Object.entries(options.hostFunctions ?? {})) {
      installHostFunction(name, implementation)
    }

    const wrappedCode = `(async function() {\n${options.code}\n})()`
    const evalResult = runGuest(() => context.evalCode(wrappedCode, 'repl.js', { type: 'global', strict: true }))
    if (evalResult.error) {
      const serializedEvalError = errorHandleToSerialized(evalResult.error)
      disposeQuietly(evalResult.error)
      return {
        status: timedOut ? 'timeout' : aborted ? 'aborted' : 'error',
        error: hostCallAttemptFailure ? serializeBridgeError(hostCallAttemptFailure) : serializedEvalError,
        stdout: stdoutText(),
        stderr: stderrText(),
        durationMs: Date.now() - startedAt,
      }
    }

    scriptPromiseHandle = evalResult.value

    let settled = false
    let settlementFailure: unknown
    const readPromiseSettlement = (): boolean => {
      const promiseHandle = scriptPromiseHandle
      if (!promiseHandle) return false
      const state = context.getPromiseState(promiseHandle)
      if (state.type === 'pending') return false
      if (state.type === 'fulfilled') {
        settlementResultValueHandle = state.notAPromise ? state.value.dup() : state.value
      } else {
        settlementErrorHandle = state.error
      }
      return true
    }

    while (!settled) {
      if (options.abortSignal?.aborted) {
        aborted = true
        break
      }
      if (executionMs() > timeoutMs) {
        timedOut = true
        break
      }
      const jobs = runGuest(() => runtime.executePendingJobs())
      if (jobs.error) {
        settlementFailure = hostCallAttemptFailure ?? errorHandleToSerialized(jobs.error)
        disposeQuietly(jobs.error)
        break
      }
      if (hostCallAttemptFailure) {
        settlementFailure = hostCallAttemptFailure
        break
      }
      await sleep(1)
      settled = readPromiseSettlement()
    }

    if (hostCallAttemptFailure) {
      settlementFailure ??= hostCallAttemptFailure
    }

    if (timedOut || aborted) {
      return {
        status: timedOut ? 'timeout' : 'aborted',
        error: serializeBridgeError(new Error(timedOut ? 'Script execution timed out' : 'Script execution aborted')),
        stdout: stdoutText(),
        stderr: stderrText(),
        durationMs: Date.now() - startedAt,
      }
    }

    if (settlementFailure) {
      return {
        status: 'error',
        error: serializeBridgeError(settlementFailure),
        stdout: stdoutText(),
        stderr: stderrText(),
        durationMs: Date.now() - startedAt,
      }
    }

    if (settlementErrorHandle) {
      const errorHandle = settlementErrorHandle
      settlementErrorHandle = undefined
      try {
        const serialized = errorHandleToSerialized(errorHandle)
        return {
          status: 'error',
          error: serialized,
          stdout: stdoutText(),
          stderr: stderrText(),
          durationMs: Date.now() - startedAt,
        }
      } finally {
        disposeQuietly(errorHandle)
      }
    }

    const unobservedSettled = [...hostPromiseObservations.values()].filter(observation =>
      observation.settled && !observation.observed,
    )
    if (unobservedSettled.length > 0) {
      const names = [...new Set(unobservedSettled.map(observation => observation.functionName))]
      const shownNames = names.slice(0, 5).join(', ')
      const hiddenCount = names.length - 5
      const nameText = hiddenCount > 0 ? `${shownNames}, and ${hiddenCount} more` : shownNames
      return {
        status: 'error',
        error: serializeBridgeError(new Error(
          `REPL script completed without observing settled inner tool results: ${nameText}`,
        )),
        stdout: stdoutText(),
        stderr: stderrText(),
        durationMs: Date.now() - startedAt,
      }
    }

    const pendingHostFunctionNames = [...new Set(
      [...hostPromiseObservations.values()]
        .filter(observation => !observation.settled)
        .map(observation => observation.functionName),
    )]
    options.onScriptCompletion?.({ pendingHostFunctionNames })

    const valueHandle = settlementResultValueHandle
    const projected = valueHandle ? dumpBoundedGuestValue(valueHandle) : undefined
    if (timedOut || aborted) {
      return {
        status: timedOut ? 'timeout' : 'aborted',
        error: serializeBridgeError(new Error(timedOut ? 'Script execution timed out' : 'Script execution aborted')),
        stdout: stdoutText(),
        stderr: stderrText(),
        durationMs: Date.now() - startedAt,
      }
    }
    const result = valueHandle ? serializeBridgeValue(projected) : undefined
    return {
      status: 'completed',
      result,
      stdout: stdoutText(),
      stderr: stderrText(),
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    return {
      status: timedOut ? 'timeout' : aborted ? 'aborted' : 'error',
      error: serializeBridgeError(error),
      stdout: stdoutText(),
      stderr: stderrText(),
      durationMs: Date.now() - startedAt,
    }
  } finally {
    disposeQuietly(scriptPromiseHandle)
    disposeQuietly(settlementErrorHandle)
    disposeQuietly(settlementResultValueHandle)
    tornDown = true
    for (const deferred of activeDeferreds) {
      try {
        const errorHandle = context.newError({
          name: 'Error',
          message: 'REPL execution ended before an inner tool call completed',
        })
        deferred.reject(errorHandle)
        disposeQuietly(errorHandle)
      } catch {
        // Teardown must continue even when a deferred was already settled.
      }
    }
    activeDeferreds.clear()
    for (const disposable of activeDisposables) disposeQuietly(disposable)
    activeDisposables.clear()
    disposeQuietly(context)
    disposeQuietly(runtime)
  }
}
