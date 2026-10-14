import { describe, expect, test } from 'bun:test'

import {
  formatAvailabilityState,
  pruneStaleAvailability,
  probeAvailabilityBatch,
  probeModelAvailability,
  type ModelAvailability,
} from './modelAvailability.js'

const ANTHROPIC_PLAN = {
  url: 'http://proxy.test/v1/messages',
  headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
  body: { model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
}

/** Wrap a responder as a `fetch` stand-in. */
function asFetch(
  responder: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return responder as unknown as typeof fetch
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('probeModelAvailability', () => {
  test('a 2xx is available and no detail is attached', async () => {
    const result = await probeModelAvailability({
      plan: ANTHROPIC_PLAN,
      fetchImpl: asFetch(async () =>
        jsonResponse(200, { content: [{ type: 'text', text: 'hi' }] })),
    })

    expect(result.state).toBe('available')
    expect(result.detail).toBeUndefined()
  })

  test('410 is reported as end-of-life, distinct from 404', async () => {
    const result = await probeModelAvailability({
      plan: ANTHROPIC_PLAN,
      fetchImpl: asFetch(async () =>
        jsonResponse(410, { error: { message: 'Model has reached its end of life' } })),
    })

    expect(result.state).toBe('deprecated')
    expect(result.detail).toContain('end of life')
  })

  test('404 means the model is not offered to this credential', async () => {
    const result = await probeModelAvailability({
      plan: ANTHROPIC_PLAN,
      fetchImpl: asFetch(async () =>
        jsonResponse(404, { detail: "Function 'abc': Not found for account 'xyz'" })),
    })

    expect(result.state).toBe('unavailable')
  })

  test('401 and 403 are auth failures, not model problems', async () => {
    for (const status of [401, 403]) {
      const result = await probeModelAvailability({
        plan: ANTHROPIC_PLAN,
        fetchImpl: asFetch(async () =>
          jsonResponse(status, { error: { message: 'invalid key' } })),
      })
      expect(result.state).toBe('auth-failed')
    }
  })

  test('429 is rate limiting and stays retryable', async () => {
    const result = await probeModelAvailability({
      plan: ANTHROPIC_PLAN,
      fetchImpl: asFetch(async () =>
        jsonResponse(429, { error: { message: 'Too Many Requests' } })),
    })

    expect(result.state).toBe('rate-limited')
  })

  test('a slow probe is retried once before being called unreachable', async () => {
    let attempts = 0
    const result = await probeModelAvailability({
      plan: ANTHROPIC_PLAN,
      timeoutMs: 5,
      fetchImpl: asFetch(async (_input, init) => {
        attempts++
        // First attempt hangs past the deadline; the retry answers cleanly.
        if (attempts === 1) {
          await new Promise((resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            )
            setTimeout(resolve, 50)
          })
        }
        return jsonResponse(200, {})
      }),
    })

    expect(result.state).toBe('available')
    expect(attempts).toBe(2)
  })

  test('a persistently slow probe stops after one retry', async () => {
    let attempts = 0
    const result = await probeModelAvailability({
      plan: ANTHROPIC_PLAN,
      timeoutMs: 5,
      fetchImpl: asFetch(async (_input, init) => {
        attempts++
        // Never answers, so every attempt hits its own deadline.
        await new Promise((resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          )
          setTimeout(resolve, 100)
        })
        return jsonResponse(200, {})
      }),
    })

    // Without a depth guard the abort retry recurses with a doubled timeout
    // forever, and the whole batch never completes.
    expect(attempts).toBe(2)
    expect(result.state).toBe('unreachable')
  })

  test('a network failure is unreachable rather than unknown', async () => {
    const result = await probeModelAvailability({
      plan: ANTHROPIC_PLAN,
      fetchImpl: asFetch(async () => {
        throw new Error('ECONNREFUSED')
      }),
    })

    expect(result.state).toBe('unreachable')
    expect(result.detail).toContain('ECONNREFUSED')
  })

  test('long detail is truncated so a picker row stays readable', async () => {
    const result = await probeModelAvailability({
      plan: ANTHROPIC_PLAN,
      fetchImpl: asFetch(async () =>
        jsonResponse(500, { error: { message: 'x'.repeat(400) } })),
    })

    expect(result.state).toBe('unreachable')
    expect(result.detail?.length).toBeLessThanOrEqual(120)
  })
})

describe('probeAvailabilityBatch', () => {
  test('every model gets a verdict', async () => {
    const models = ['a', 'b', 'c', 'd', 'e']
    const results = await probeAvailabilityBatch({
      models,
      buildPlan: model => ({ ...ANTHROPIC_PLAN, body: { model } }),
      concurrency: 2,
      fetchImpl: asFetch(async () => jsonResponse(200, {})),
    })

    expect(Object.keys(results).sort()).toEqual(models)
    expect(Object.values(results).every(r => r.state === 'available')).toBe(true)
  })

  test('concurrency is capped and never exceeds the model count', async () => {
    let inFlight = 0
    let peak = 0
    const results = await probeAvailabilityBatch({
      models: ['a', 'b'],
      buildPlan: model => ({ ...ANTHROPIC_PLAN, body: { model } }),
      concurrency: 10,
      fetchImpl: asFetch(async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise(resolve => setTimeout(resolve, 5))
        inFlight--
        return jsonResponse(200, {})
      }),
    })

    expect(Object.keys(results)).toHaveLength(2)
    expect(peak).toBeLessThanOrEqual(2)
  })

  test('progress reports a monotonic completed count', async () => {
    const seen: number[] = []
    await probeAvailabilityBatch({
      models: ['a', 'b', 'c'],
      buildPlan: model => ({ ...ANTHROPIC_PLAN, body: { model } }),
      concurrency: 1,
      // No throttle so every completion is observable.
      progressIntervalMs: 0,
      fetchImpl: asFetch(async () => jsonResponse(200, {})),
      onProgress: completed => seen.push(completed),
    })

    expect(seen).toEqual([1, 2, 3])
  })

  test('progress reports the first and final counts even when throttled', async () => {
    const seen: number[] = []
    await probeAvailabilityBatch({
      models: ['a', 'b', 'c', 'd'],
      buildPlan: model => ({ ...ANTHROPIC_PLAN, body: { model } }),
      concurrency: 1,
      // A floor far longer than the whole run: intermediate completions are
      // collapsed. This is what keeps a large catalog from re-rendering the
      // picker once per model. The first report still goes through so the
      // user gets immediate feedback that the run started.
      progressIntervalMs: 60_000,
      fetchImpl: asFetch(async () => jsonResponse(200, {})),
      onProgress: completed => seen.push(completed),
    })

    expect(seen).toEqual([1, 4])
  })

  test('an empty model list resolves without touching the network', async () => {
    let called = false
    const results = await probeAvailabilityBatch({
      models: [],
      buildPlan: () => ANTHROPIC_PLAN,
      fetchImpl: asFetch(async () => {
        called = true
        return jsonResponse(200, {})
      }),
    })

    expect(results).toEqual({})
    expect(called).toBe(false)
  })

  test('an aborted run stops without reporting models it never probed', async () => {
    const controller = new AbortController()
    const results = await probeAvailabilityBatch({
      models: ['a', 'b', 'c'],
      buildPlan: model => ({ ...ANTHROPIC_PLAN, body: { model } }),
      concurrency: 1,
      fetchImpl: asFetch(async () => {
        controller.abort()
        return jsonResponse(200, {})
      }),
      signal: controller.signal,
    })

    expect(Object.keys(results).length).toBeLessThanOrEqual(1)
  })
})

describe('pruneStaleAvailability', () => {
  test('drops verdicts older than the TTL', () => {
    const now = 1_000_000
    const results: Record<string, ModelAvailability> = {
      fresh: { state: 'available', checkedAt: now - 1000 },
      stale: { state: 'available', checkedAt: now - 999_999 },
    }

    const pruned = pruneStaleAvailability(results, 60_000, now)

    expect(Object.keys(pruned)).toEqual(['fresh'])
  })
})

describe('formatAvailabilityState', () => {
  test('every state renders a distinct marker', () => {
    const states = [
      'available',
      'unavailable',
      'deprecated',
      'auth-failed',
      'rate-limited',
      'unreachable',
      'unknown',
    ] as const

    const rendered = states.map(formatAvailabilityState)

    expect(new Set(rendered).size).toBe(states.length)
    expect(rendered[0]).toBe('✓ available')
  })
})
