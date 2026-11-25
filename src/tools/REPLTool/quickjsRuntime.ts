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
  function truncateString(value, remaining) {
    const maxLength = Math.min(maxStringLength, Math.max(0, remaining))
    if (value.length <= maxLength) return value
    return value.slice(0, maxLength) + '... [truncated ' + (value.length - maxLength) + ' chars]'
  }
  return function serializeReplValue(value) {
    let nodes = 0
    let stringChars = 0
    const seen = new WeakSet()
    function serializeInner(current, depth) {
      if (nodes >= maxTotalNodes) return '[SerializationBudget]'
      nodes += 1
      if (current === null) return null
      const type = typeof current
      if (type === 'string') {
        const serialized = truncateString(current, maxTotalStringChars - stringChars)
        stringChars += serialized.length
        return serialized
      }
      if (type === 'number' || type === 'boolean') return current
      if (type === 'undefined') return '[undefined]'
      if (type === 'bigint') return current.toString() + 'n'
      if (type === 'symbol') return String(current)
      if (type === 'function') return '[function' + (current.name ? ' ' + current.name : '') + ']'
      if (type !== 'object') return String(current)
      if (seen.has(current)) return '[Circular]'
      if (depth >= maxDepth) return '[MaxDepth]'
      seen.add(current)
      if (current instanceof Date) return current.toISOString()
      if (current instanceof Error) {
        return {
          name: current.name || 'Error',
          message: serializeInner(current.message || String(current), depth + 1),
          ...(current.stack ? { stack: serializeInner(current.stack, depth + 1) } : {}),
        }
      }
      if (ArrayBuffer.isView(current)) {
        return { type: current.constructor && current.constructor.name || 'TypedArray', byteLength: current.byteLength || 0, note: 'binary data omitted' }
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
      for (const entry of entries.slice(0, maxObjectProperties)) {
        const serializedKey = truncateString(entry[0], maxTotalStringChars - stringChars)
        stringChars += serializedKey.length
        out[serializedKey] = serializeInner(entry[1], depth + 1)
      }
      if (entries.length > maxObjectProperties) out.__truncated__ = (entries.length - maxObjectProperties) + ' properties omitted'
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

  const executionMs = () => Date.now() - startedAt - promptWaitTracker.currentExcludedMs()
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
    if (executionMs() > timeoutMs) {
      timedOut = true
      return true
    }
    return false
  })

  const context = runtime.newContext()
  const activeDisposables = new Set<{ dispose: () => void }>()
  const activeDeferreds = new Set<{ reject: (value: QuickJSHandle) => void }>()
  const serializerResult = context.evalCode(BOUNDED_GUEST_SERIALIZER_SOURCE, 'repl-serializer.js', { type: 'global', strict: true })
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
  let nextHostPromiseToken = 1
  let observableFactoryHandle: QuickJSHandle | undefined
  let observeHostPromiseHandle: QuickJSHandle | undefined
  if (Object.keys(options.hostFunctions ?? {}).length > 0) {
    const observableFactoryResult = context.evalCode(
      OBSERVABLE_HOST_PROMISE_FACTORY_SOURCE,
      'repl-observable-host-promise.js',
      { type: 'global', strict: true },
    )
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
      if (observation) observation.observed = true
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
    const wrapped = context.callFunction(observableFactoryHandle, context.undefined, [
      promiseHandle,
      tokenHandle,
      observeHostPromiseHandle,
    ])
    disposeQuietly(tokenHandle)
    // The wrapper closure now owns the guest-side promise reference. Since the
    // raw promise handle is not the host function return value, release this
    // host reference; resolver handles stay alive until settlement.
    disposeQuietly(promiseHandle)
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
    const serialized = context.callFunction(serializerHandle, context.undefined, [handle])
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
      const stringified = context.callFunction(jsonStringifyHandle, context.undefined, [handle])
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
        activeDisposables.add(rejectedInput)
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
          observation.settled = true
          const serialized = serializeBridgeValue(value)
          const resultHandle = hostValueToQuickJS(context, serialized)
          deferred.resolve(resultHandle)
          disposeQuietly(resultHandle)
        })
        .catch((error: unknown) => {
          if (tornDown) return
          observation.settled = true
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

  try {
    installConsole()
    for (const [name, implementation] of Object.entries(options.hostFunctions ?? {})) {
      installHostFunction(name, implementation)
    }

    const wrappedCode = `(async function() {\n${options.code}\n})()`
    const evalResult = context.evalCode(wrappedCode, 'repl.js', { type: 'global', strict: true })
    if (evalResult.error) {
      const serializedEvalError = errorHandleToSerialized(evalResult.error)
      disposeQuietly(evalResult.error)
      return {
        status: timedOut ? 'timeout' : aborted ? 'aborted' : 'error',
        error: serializedEvalError,
        stdout: stdoutText(),
        stderr: stderrText(),
        durationMs: Date.now() - startedAt,
      }
    }

    const promiseHandle = evalResult.value
    const settlement = context.resolvePromise(promiseHandle)
    disposeQuietly(promiseHandle)

    let settled = false
    let settlementValue: Awaited<typeof settlement> | undefined
    let settlementFailure: unknown
    void settlement.then(
      value => {
        settlementValue = value
        settled = true
      },
      failure => {
        settlementFailure = failure
        settled = true
      },
    )

    while (!settled) {
      if (options.abortSignal?.aborted) {
        aborted = true
        break
      }
      if (executionMs() > timeoutMs) {
        timedOut = true
        break
      }
      const jobs = runtime.executePendingJobs()
      if (jobs.error) {
        settlementFailure = errorHandleToSerialized(jobs.error)
        disposeQuietly(jobs.error)
        settled = true
        break
      }
      await sleep(1)
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
        error: typeof settlementFailure === 'object' && settlementFailure !== null && 'message' in settlementFailure
        ? settlementFailure as ReturnType<typeof serializeBridgeError>
        : serializeBridgeError(settlementFailure),
        stdout: stdoutText(),
        stderr: stderrText(),
        durationMs: Date.now() - startedAt,
      }
    }

    if (settlementValue?.error) {
      const serialized = errorHandleToSerialized(settlementValue.error)
      disposeQuietly(settlementValue.error)
      return {
        status: 'error',
        error: serialized,
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

    const valueHandle = settlementValue?.value
    const result = valueHandle ? serializeBridgeValue(dumpBoundedGuestValue(valueHandle)) : undefined
    disposeQuietly(valueHandle)
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
