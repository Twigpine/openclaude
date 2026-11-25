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
    const circular = await executeQuickJSScript({
      code: "const value = {}; value.self = value; try { await capture(value); return 'coerced' } catch (error) { return error.message }",
      hostFunctions: { capture: args => args[0] },
    })
    expect(circular.status).toBe('completed')
    expect(String(circular.result)).not.toBe('coerced')
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

  test('times out an infinite loop under a test-shortened budget', async () => {
    const started = Date.now()
    const result = await executeQuickJSScript({ code: 'while (true) {}', timeoutMs: 40 })
    expect(result.status).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(2_000)
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
      timeoutMs: 2_000,
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
