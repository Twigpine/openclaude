import { describe, expect, test } from 'bun:test'
import { executeQuickJSScript, PromptWaitTracker } from './quickjsRuntime.js'

const TEST_TIMEOUT = 10_000

describe('executeQuickJSScript', () => {
  test('returns arithmetic and object completion values', async () => {
    const numeric = await executeQuickJSScript({ code: 'return 1 + 1' })
    expect(numeric.status).toBe('completed')
    expect(numeric.result).toBe(2)

    const object = await executeQuickJSScript({ code: 'return {ok: true, items: [1, 2]}' })
    expect(object.status).toBe('completed')
    expect(object.result).toEqual({ ok: true, items: [1, 2] })
  }, TEST_TIMEOUT)

  test('bounds large object keys in completion results', async () => {
    const result = await executeQuickJSScript({
      code: "const key = 'k'.repeat(20000); const value = {}; value[key] = 'result'; return value",
    })
    expect(result.status).toBe('completed')
    const key = Object.keys(result.result as Record<string, unknown>)[0] ?? ''
    expect(key.length).toBeLessThan(17_000)
    expect(key).toContain('truncated')
    expect(JSON.stringify(result.result).length).toBeLessThan(18_000)
  }, TEST_TIMEOUT)

  test('includes generated representations in the guest string budget', async () => {
    const result = await executeQuickJSScript({
      code: [
        "const description = 'd'.repeat(15000)",
        "const hiddenText = 'h'.repeat(15000)",
        "const keyBase = 'k'.repeat(16000)",
        "const firstKey = keyBase + 'a'.repeat(4000)",
        "const secondKey = keyBase + 'b'.repeat(4000)",
        // The overwritten collision value still consumes guest serialization budget.
        'const collision = {}',
        'collision[firstKey] = [hiddenText, hiddenText, hiddenText, hiddenText, hiddenText]',
        "collision[secondKey] = 'visible'",
        "const marker = 'm'.repeat(10000)",
        'return [Symbol(description), collision, marker]',
      ].join('\n'),
    })
    expect(result.status).toBe('completed')
    const [symbolText, collision, marker] = result.result as [
      string,
      Record<string, unknown>,
      string,
    ]
    expect(symbolText).toBe(`Symbol(${'d'.repeat(15_000)})`)
    expect(Object.values(collision)).toEqual(['visible'])
    expect(marker).toContain('truncated')
    expect(marker.length).toBeLessThan(7_000)
  }, TEST_TIMEOUT)

  test('preserves generated representations within the string budget', async () => {
    const result = await executeQuickJSScript({
      code: [
        'function named() {}',
        "const error = new Error('problem')",
        "return [123n, Symbol('desc'), named, error]",
      ].join('\n'),
    })
    expect(result.status).toBe('completed')
    const [bigintText, symbolText, functionLabel, error] = result.result as [
      string,
      string,
      string,
      { name: string; message: string },
    ]
    expect(bigintText).toBe('123n')
    expect(symbolText).toBe('Symbol(desc)')
    expect(functionLabel).toBe('[function named]')
    expect(error.name).toBe('Error')
    expect(error.message).toBe('problem')
  }, TEST_TIMEOUT)

  test('captures bounded console output', async () => {
    const result = await executeQuickJSScript({
      code: "console.log('hello', {a: 1}); console.error('bad'); return undefined",
      stdoutLimit: 12,
      stderrLimit: 4,
    })
    expect(result.status).toBe('completed')
    expect(result.stdout.length).toBeLessThanOrEqual(12)
    expect(result.stdout).toContain('hello')
    expect(result.stderr).toBe('bad\n')
  }, TEST_TIMEOUT)

  test('preserves large string inputs exactly instead of truncating tool arguments', async () => {
    const result = await executeQuickJSScript({
      code: "const content = 'x'.repeat(20000); return await capture({content})",
      hostFunctions: {
        capture: args => (args[0] as { content: string }).content.length,
      },
    })
    expect(result.status).toBe('completed')
    expect(result.result).toBe(20_000)
  }, TEST_TIMEOUT)

  test('rejects non-JSON host inputs instead of coercing them into tool arguments', async () => {
    let captureCalls = 0
    const circular = await executeQuickJSScript({
      code: "const value = {}; value.self = value; try { await capture(value); return 'coerced' } catch (error) { return error.message }",
      hostFunctions: {
        capture: args => {
          captureCalls += 1
          return args[0]
        },
      },
    })
    expect(circular.status).toBe('completed')
    expect(String(circular.result)).toContain('REPL tool input is not JSON-compatible')
    expect(captureCalls).toBe(0)
  }, TEST_TIMEOUT)

  test('overlaps deferred host promises through Promise.all and drains pending jobs', async () => {
    let active = 0
    let maxActive = 0
    const result = await executeQuickJSScript({
      code: "const a = hostDelay('a'); const b = hostDelay('b'); return await Promise.all([a, b])",
      hostFunctions: {
        hostDelay: async args => {
          active += 1
          maxActive = Math.max(maxActive, active)
          await new Promise(resolve => setTimeout(resolve, 25))
          active -= 1
          return args[0]
        },
      },
    })
    expect(result.status).toBe('completed')
    expect(result.result).toEqual(['a', 'b'])
    expect(maxActive).toBe(2)
  }, TEST_TIMEOUT)

  test('settles one host promise while another remains pending', async () => {
    const result = await executeQuickJSScript({
      code: "const slow = hostNever(); const fast = hostValue(3); return await fast",
      timeoutMs: 100,
      hostFunctions: {
        hostNever: () => new Promise(() => {}),
        hostValue: async args => args[0],
      },
    })
    expect(result.status).toBe('completed')
    expect(result.result).toBe(3)
  }, TEST_TIMEOUT)

  test('rejects a fulfilled host call that settles before completion without observation', async () => {
    const result = await executeQuickJSScript({
      code: "hostFast(); await hostSlow(); return 'done'",
      hostFunctions: {
        hostFast: async () => 'fast-result',
        hostSlow: async () => {
          await new Promise(resolve => setTimeout(resolve, 25))
          return 'slow-result'
        },
      },
    })
    expect(result.status).toBe('error')
    expect(result.error?.message).toContain('without observing settled inner tool results: hostFast')
  }, TEST_TIMEOUT)

  test('releases settlement values on early completion errors and completion callback failures', async () => {
    const actualCore = await import('quickjs-emscripten-core')
    const originalGetPromiseState = actualCore.QuickJSContext.prototype.getPromiseState
    const duplicatedValueDisposals: Array<{ disposed: boolean }> = []

    actualCore.QuickJSContext.prototype.getPromiseState = function (promiseHandle) {
      const result = originalGetPromiseState.call(this, promiseHandle)
      if (result.type === 'fulfilled') {
        const value = result.value
        const disposal = { disposed: false }
        const originalDispose = value.dispose.bind(value)
        value.dispose = () => {
          disposal.disposed = true
          originalDispose()
        }
        duplicatedValueDisposals.push(disposal)
      }
      return result
    }

    try {
      const earlyCompletion = await executeQuickJSScript({
        code: "hostFast(); await hostSlow(); return 'done'",
        hostFunctions: {
          hostFast: async () => 'fast-result',
          hostSlow: async () => {
            await new Promise(resolve => setTimeout(resolve, 25))
            return 'slow-result'
          },
        },
      })
      expect(earlyCompletion.status).toBe('error')
      expect(earlyCompletion.error?.message).toContain('without observing settled inner tool results')

      const callbackFailure = await executeQuickJSScript({
        code: "return 'done'",
        onScriptCompletion: () => {
          throw new Error('completion callback failed')
        },
      })
      expect(callbackFailure.status).toBe('error')
      expect(callbackFailure.error?.message).toBe('completion callback failed')
      expect(duplicatedValueDisposals).toHaveLength(2)
      expect(duplicatedValueDisposals.every(disposal => disposal.disposed)).toBe(true)
    } finally {
      actualCore.QuickJSContext.prototype.getPromiseState = originalGetPromiseState
    }
  }, TEST_TIMEOUT)

  test('rejects a rejected host call that settles before completion without observation', async () => {
    const result = await executeQuickJSScript({
      code: "hostFast(); await hostSlow(); return 'done'",
      hostFunctions: {
        hostFast: async () => { throw new Error('fast failure') },
        hostSlow: async () => {
          await new Promise(resolve => setTimeout(resolve, 25))
          return 'slow-result'
        },
      },
    })
    expect(result.status).toBe('error')
    expect(result.error?.message).toContain('without observing settled inner tool results: hostFast')
  }, TEST_TIMEOUT)

  test('counts then handlers as observation before completion', async () => {
    const result = await executeQuickJSScript({
      code: "hostFast().then(() => {}); await hostSlow(); return 'done'",
      hostFunctions: {
        hostFast: async () => 'fast-result',
        hostSlow: async () => {
          await new Promise(resolve => setTimeout(resolve, 25))
          return 'slow-result'
        },
      },
    })
    expect(result.status).toBe('completed')
    expect(result.result).toBe('done')
  }, TEST_TIMEOUT)

  test('returning a host promise observes it through async result assimilation', async () => {
    const result = await executeQuickJSScript({
      code: 'return hostValue(4)',
      hostFunctions: {
        hostValue: async args => args[0],
      },
    })
    expect(result.status).toBe('completed')
    expect(result.result).toBe(4)
  }, TEST_TIMEOUT)

  test('keeps host promises native-shaped to guest inspection', async () => {
    const result = await executeQuickJSScript({
      code: "const pending = hostNever(); return [pending instanceof Promise, typeof pending.then, Object.prototype.toString.call(pending)]",
      timeoutMs: 100,
      hostFunctions: {
        hostNever: () => new Promise(() => {}),
      },
    })
    expect(result.status).toBe('completed')
    expect(result.result).toEqual([true, 'function', '[object Promise]'])
  }, TEST_TIMEOUT)

  test('times out an infinite loop under a test-shortened budget', async () => {
    const started = Date.now()
    const result = await executeQuickJSScript({ code: 'while (true) {}', timeoutMs: 40 })
    expect(result.status).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(2_000)
  }, TEST_TIMEOUT)

  test('disposes interrupted pending jobs without a QuickJS assertion', () => {
    const runtimeUrl = new URL('./quickjsRuntime.ts', import.meta.url).href
    const source = `
      import { executeQuickJSScript, PromptWaitTracker } from ${JSON.stringify(runtimeUrl)}
      const promptWaitTracker = new PromptWaitTracker()
      await executeQuickJSScript({ code: 'return 1' })
      const result = await executeQuickJSScript({
        code: 'hostPromptOpen(); return await hostSibling().then(() => { const started = Date.now(); while (Date.now() - started < 200) {} return "loop-finished" })',
        timeoutMs: 100,
        promptWaitTracker,
        hostFunctions: {
          hostPromptOpen: () => {
            promptWaitTracker.begin()
            return new Promise(() => {})
          },
          hostSibling: async () => {
            await new Promise(resolve => setTimeout(resolve, 20))
            return 'sibling'
          },
        },
      })
      if (result.status !== 'timeout') throw new Error('expected timeout, got ' + result.status)
    `
    const child = Bun.spawnSync([process.execPath, '--eval', source], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: TEST_TIMEOUT,
    })
    if (child.exitCode !== 0) {
      throw new Error(
        `interrupted pending-jobs child exited ${child.exitCode}\nstdout:\n${child.stdout.toString()}\nstderr:\n${child.stderr.toString()}`,
      )
    }
    expect(child.stdout.toString()).not.toContain('Assertion failed')
    expect(child.stderr.toString()).not.toContain('Assertion failed')
    expect(child.stdout.toString()).not.toContain('Aborted(')
    expect(child.stderr.toString()).not.toContain('Aborted(')
  }, TEST_TIMEOUT)

  test('counts guest jobs run while a prompt wait is open toward the timeout', async () => {
    await executeQuickJSScript({ code: 'return 1' })
    const promptWaitTracker = new PromptWaitTracker()
    let siblingSettled = false
    const result = await executeQuickJSScript({
      code: [
        'hostPromptOpen()',
        'return await hostSibling().then(() => {',
        '  const started = Date.now()',
        '  while (Date.now() - started < 200) {}',
        "  return 'loop-finished'",
        '})',
      ].join('\n'),
      timeoutMs: 100,
      promptWaitTracker,
      hostFunctions: {
        hostPromptOpen: () => {
          promptWaitTracker.begin()
          return new Promise(() => {})
        },
        hostSibling: async () => {
          await new Promise(resolve => setTimeout(resolve, 80))
          siblingSettled = true
          return 'sibling'
        },
      },
    })
    expect(siblingSettled).toBe(true)
    expect(result.status).toBe('timeout')
    expect(result.error?.message).toBe('Script execution timed out')
  }, TEST_TIMEOUT)

  test('returns timeout when completion projection crosses the deadline', async () => {
    const result = await executeQuickJSScript({
      code: [
        'const value = {}',
        "Object.defineProperty(value, 'slow', {",
        '  enumerable: true,',
        '  get() {',
        '    const started = Date.now()',
        '    while (Date.now() - started < 300) {}',
        '    return 1',
        '  },',
        '})',
        'return value',
      ].join('\n'),
      timeoutMs: 80,
    })
    expect(result.status).toBe('timeout')
    expect(result.error?.message).toBe('Script execution timed out')
  }, TEST_TIMEOUT)

  test('preserves completion when projection finishes within the deadline', async () => {
    const result = await executeQuickJSScript({
      code: [
        'const value = {}',
        "Object.defineProperty(value, 'projected', { enumerable: true, get() { return 7 } })",
        'return value',
      ].join('\n'),
      timeoutMs: 1_000,
    })
    expect(result.status).toBe('completed')
    expect(result.result).toEqual({ projected: 7 })
  }, TEST_TIMEOUT)

  test('disposes cleanly with an unsettled host promise', async () => {
    const result = await executeQuickJSScript({
      code: 'await hostNever(); return 1',
      timeoutMs: 40,
      hostFunctions: { hostNever: () => new Promise(() => {}) },
    })
    expect(result.status).toBe('timeout')
  }, TEST_TIMEOUT)

  test('does not expose require, process, or dynamic module loading', async () => {
    const globals = await executeQuickJSScript({ code: "return [typeof require, typeof process]" })
    expect(globals.status).toBe('completed')
    expect(globals.result).toEqual(['undefined', 'undefined'])

    const dynamicImport = await executeQuickJSScript({ code: "await import('x'); return 1", timeoutMs: 1_000 })
    expect(dynamicImport.status).toBe('error')
  }, TEST_TIMEOUT)

  test('memory exhaustion produces a controlled error', async () => {
    const result = await executeQuickJSScript({
      code: 'const a=[]; while (true) { a.push(new Array(1000).fill(1)) }',
      timeoutMs: 10_000,
      memoryLimitBytes: 2 * 1024 * 1024,
    })
    expect(result.status).toBe('error')
    expect(result.error).toBeDefined()
  }, TEST_TIMEOUT)

  test('uncaught guest TypeError preserves its name and message', async () => {
    const result = await executeQuickJSScript({ code: "throw new TypeError('useful message')" })
    expect(result.status).toBe('error')
    expect(result.error?.name).toBe('TypeError')
    expect(result.error?.message).toBe('useful message')
  })

  test('malformed guest errors serialize as controlled errors without recursive inspection', async () => {
    const result = await executeQuickJSScript({
      code: "const e = new Error('outer'); Object.defineProperty(e, 'message', { get() { throw this } }); throw e",
    })
    expect(result.status).toBe('error')
    expect(result.error?.name).toBe('Error')
    expect(result.error?.message).toBe('QuickJS guest value could not be serialized')
  })

  test('rejects oversized Write and Bash inputs as catchable tool errors', async () => {
    const calls: string[] = []
    const result = await executeQuickJSScript({
      code: [
        "const content = 'x'.repeat(1100 * 1024)",
        'const errors = []',
        "try { await Write({ file_path: '/tmp/repl-large-write', content }) } catch (error) { errors.push(error.message) }",
        'try { await Bash({ command: content }) } catch (error) { errors.push(error.message) }',
        'return errors',
      ].join('\n'),
      hostFunctions: {
        Write: () => {
          calls.push('Write')
          return 'unexpected'
        },
        Bash: () => {
          calls.push('Bash')
          return 'unexpected'
        },
      },
    })
    expect(result.status).toBe('completed')
    expect(calls).toEqual([])
    const errors = result.result as string[]
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain('per-call serialized input budget')
    expect(errors[1]).toContain('per-call serialized input budget')
  }, TEST_TIMEOUT)

  test('honors configured serialized input byte budgets', async () => {
    const result = await executeQuickJSScript({
      code: [
        "const first = await capture({ text: 'first' })",
        "let message = ''",
        "try { await capture({ text: 'second' }) } catch (error) { message = error.message }",
        'return [first, message]',
      ].join('\n'),
      maxInputBytesPerCall: 100,
      maxInputBytesPerScript: 20,
      hostFunctions: {
        capture: args => (args[0] as { text: string }).text,
      },
    })
    expect(result.status).toBe('completed')
    const [first, message] = result.result as [string, string]
    expect(first).toBe('first')
    expect(message).toContain('per-script serialized input budget')
  }, TEST_TIMEOUT)

  test('measures serialized input budgets as UTF-8 bytes', async () => {
    let called = false
    const result = await executeQuickJSScript({
      code: "try { await capture({ text: 'é'.repeat(6) }); return 'accepted' } catch (error) { return error.message }",
      maxInputBytesPerCall: 15,
      hostFunctions: {
        capture: () => {
          called = true
          return 'unexpected'
        },
      },
    })
    expect(result.status).toBe('completed')
    expect(result.result).toContain('per-call serialized input budget')
    expect(called).toBe(false)
  }, TEST_TIMEOUT)

  test('enforces the aggregate input budget across queued multi-MB fanout', async () => {
    let started = 0
    const result = await executeQuickJSScript({
      code: [
        "const chunk = 'x'.repeat(600 * 1024)",
        'const pending = []',
        'const errors = []',
        'for (let index = 0; index < 20; index++) {',
        '  const call = Write({ file_path: `/tmp/repl-fanout-${index}`, content: chunk }).then(',
        "    () => 'ok',",
        "    error => { errors.push(error.message); return 'rejected' },",
        '  )',
        '  pending.push(call)',
        '}',
        'const outcomes = await Promise.all(pending)',
        "return { accepted: outcomes.filter(outcome => outcome === 'ok').length, errors: errors.length, firstError: errors[0] || '' }",
      ].join('\n'),
      hostFunctions: {
        Write: async () => {
          started += 1
          await new Promise(resolve => setTimeout(resolve, 5))
          return 'ok'
        },
      },
    })
    expect(result.status).toBe('completed')
    const outcome = result.result as { accepted: number; errors: number; firstError: string }
    expect(outcome.errors).toBeGreaterThan(0)
    expect(outcome.firstError).toContain('per-script serialized input budget')
    expect(outcome.accepted).toBe(started)
    expect(started).toBeLessThan(20)
    expect(started + outcome.errors).toBe(20)
  }, TEST_TIMEOUT)

  test('enforces the host call attempt budget for repeated input conversion failures', async () => {
    let captureCalls = 0
    const result = await executeQuickJSScript({
      code: [
        'let caught = 0',
        'for (let index = 0; index < 105; index++) {',
        '  const value = {}',
        '  value.self = value',
        '  try { await capture(value) } catch { caught += 1 }',
        '}',
        'return caught',
      ].join('\n'),
      hostFunctions: {
        capture: () => {
          captureCalls += 1
          return 'unexpected'
        },
      },
    })
    expect(result.status).toBe('error')
    expect(result.error?.message).toContain('REPL host call attempt budget exceeded (100)')
    expect(captureCalls).toBe(0)
  }, TEST_TIMEOUT)

  test('keeps input validation failures catchable within the host call attempt budget', async () => {
    const result = await executeQuickJSScript({
      code: [
        'const errors = []',
        'for (let index = 0; index < 3; index++) {',
        '  const value = {}',
        '  value.self = value',
        '  try { await capture(value) } catch (error) { errors.push(error.message) }',
        '}',
        'return errors',
      ].join('\n'),
      hostFunctions: {
        capture: () => 'unexpected',
      },
    })
    expect(result.status).toBe('completed')
    const errors = result.result as string[]
    expect(errors).toHaveLength(3)
    expect(errors.every(message => message.includes('REPL tool input is not JSON-compatible'))).toBe(true)
  }, TEST_TIMEOUT)

  test('host errors become catchable guest rejections', async () => {
    const result = await executeQuickJSScript({
      code: "try { await hostFail(); return 'not reached' } catch (error) { return error.message }",
      hostFunctions: {
        hostFail: async () => { throw new Error('host failed') },
      },
    })
    expect(result.status).toBe('completed')
    expect(result.result).toBe('host failed')
  }, TEST_TIMEOUT)
})

describe('PromptWaitTracker', () => {
  test('excludes active and completed wait intervals', async () => {
    const tracker = new PromptWaitTracker()
    tracker.begin()
    await new Promise(resolve => setTimeout(resolve, 10))
    const activeExcluded = tracker.currentExcludedMs()
    tracker.end()
    const completedExcluded = tracker.currentExcludedMs()
    expect(activeExcluded).toBeGreaterThan(0)
    expect(completedExcluded).toBeGreaterThanOrEqual(activeExcluded)
  })
})
