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

export interface QuickJSExecutionOptions {
  code: string
  hostFunctions?: Record<string, QuickJSHostFunction>
  timeoutMs?: number
  memoryLimitBytes?: number
  maxStackSizeBytes?: number
  stdoutLimit?: number
  stderrLimit?: number
  abortSignal?: AbortSignal
  promptWaitTracker?: PromptWaitTracker
}

export interface QuickJSExecutionResult {
  status: 'completed' | 'error' | 'timeout' | 'aborted'
  result?: unknown
  error?: ReturnType<typeof serializeBridgeError>
  stdout: string
  stderr: string
  durationMs: number
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024
const DEFAULT_STACK_SIZE_BYTES = 1024 * 1024
const DEFAULT_OUTPUT_LIMIT = 64 * 1024

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

function errorHandleToSerialized(context: QuickJSContext, errorHandle: QuickJSHandle) {
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
  const promptWaitTracker = options.promptWaitTracker ?? new PromptWaitTracker()
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  let stdoutLength = 0
  let stderrLength = 0
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
  const jsonHandle = context.getProp(context.global, 'JSON')
  const jsonStringifyHandle = context.getProp(jsonHandle, 'stringify')
  disposeQuietly(jsonHandle)
  activeDisposables.add(jsonStringifyHandle)

  function guestInputFromHandle(handle: QuickJSHandle): unknown {
    const stringified = context.callFunction(jsonStringifyHandle, context.undefined, [handle])
    if (stringified.error) {
      const serialized = errorHandleToSerialized(context, stringified.error)
      disposeQuietly(stringified.error)
      throw new Error(`REPL tool input is not JSON-compatible: ${serialized.message}`)
    }
    const jsonText = context.dump(stringified.value) as string | undefined
    disposeQuietly(stringified.value)
    return jsonText === undefined ? undefined : jsonParse(jsonText)
  }

  function installConsole(): void {
    const consoleObject = context.newObject()
    for (const method of ['log', 'info', 'debug'] as const) {
      const fn = context.newFunction(method, (...args) => {
        stdoutLength = appendOutput(
          stdoutChunks,
          stdoutLength,
          `${args.map(arg => String(serializeBridgeValue(context.dump(arg)))).join(' ')}\n`,
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
          `${args.map(arg => String(serializeBridgeValue(context.dump(arg)))).join(' ')}\n`,
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
      const deferred = context.newPromise()
      activeDisposables.add(deferred)
      const args = argHandles.map(handle => guestInputFromHandle(handle))
      void Promise.resolve()
        .then(() => implementation(args))
        .then(value => {
          if (tornDown) return
          const serialized = serializeBridgeValue(value)
          const resultHandle = hostValueToQuickJS(context, serialized)
          deferred.resolve(resultHandle)
          disposeQuietly(resultHandle)
        })
        .catch((error: unknown) => {
          if (tornDown) return
          const serialized = serializeBridgeError(error)
          const errorHandle = context.newError({
            name: serialized.name,
            message: serialized.message,
          })
          deferred.reject(errorHandle)
          disposeQuietly(errorHandle)
        })
        .finally(() => {
          activeDisposables.delete(deferred)
          disposeQuietly(deferred)
        })
      return deferred.handle
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
      return {
        status: timedOut ? 'timeout' : aborted ? 'aborted' : 'error',
        error: errorHandleToSerialized(context, evalResult.error),
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
        settlementFailure = jobs.error
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
        error: serializeBridgeError(settlementFailure),
        stdout: stdoutText(),
        stderr: stderrText(),
        durationMs: Date.now() - startedAt,
      }
    }

    if (settlementValue?.error) {
      const serialized = errorHandleToSerialized(context, settlementValue.error)
      disposeQuietly(settlementValue.error)
      return {
        status: 'error',
        error: serialized,
        stdout: stdoutText(),
        stderr: stderrText(),
        durationMs: Date.now() - startedAt,
      }
    }

    const valueHandle = settlementValue?.value
    const result = valueHandle ? serializeBridgeValue(context.dump(valueHandle)) : undefined
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
    for (const disposable of activeDisposables) disposeQuietly(disposable)
    activeDisposables.clear()
    disposeQuietly(context)
    disposeQuietly(runtime)
  }
}
