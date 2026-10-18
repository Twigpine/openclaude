import { afterEach, beforeEach, expect, test } from 'bun:test'

import type { ModelUsage } from 'src/entrypoints/agentSdkTypes.js'

import {
  addToTotalCostState,
  getModelUsage,
  getUsageForModel,
  resetStateForTests,
  setCostStateForRestore,
} from './state.js'

// Per-model usage is keyed by the model id, an arbitrary string for
// custom/OpenAI-compatible providers. `STATE.modelUsage` is a plain map, so an
// id of `constructor` / `__proto__` reaches both the read (`getUsageForModel`)
// and the write (`STATE.modelUsage[model] = ...`). On a normal object the read
// of an absent key returns an inherited Object.prototype member and the write
// of `__proto__` invokes the prototype setter -- the cost accumulator then
// mutates that inherited object, polluting Object.prototype process-wide.

const PROTO_NAMES = ['__proto__', 'constructor', 'toString', 'valueOf']

function sampleUsage(): ModelUsage {
  return {
    inputTokens: 10,
    outputTokens: 20,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 1,
    contextWindow: 0,
    maxOutputTokens: 0,
  }
}

let savedNodeEnv: string | undefined

beforeEach(() => {
  savedNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'test'
  resetStateForTests()
})

afterEach(() => {
  resetStateForTests()
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = savedNodeEnv
  // Undo any accidental pollution so a regression here cannot corrupt other
  // suites sharing the process.
  delete (Object.prototype as Record<string, unknown>).inputTokens
})

test('getUsageForModel returns undefined for prototype-member ids on an empty map', () => {
  for (const name of PROTO_NAMES) {
    expect(getUsageForModel(name)).toBeUndefined()
  }
})

test('recording usage under a prototype-member id does not pollute Object.prototype', () => {
  for (const name of PROTO_NAMES) {
    addToTotalCostState(1, sampleUsage(), name)
  }

  // The headline hazard: a `__proto__` write must not reach Object.prototype.
  expect((Object.prototype as Record<string, unknown>).inputTokens).toBeUndefined()
  expect(({} as Record<string, unknown>).inputTokens).toBeUndefined()

  // The ids are stored as ordinary own keys and read back verbatim.
  for (const name of PROTO_NAMES) {
    expect(getUsageForModel(name)?.inputTokens).toBe(10)
  }
  expect(Object.keys(getModelUsage()).sort()).toEqual([...PROTO_NAMES].sort())
})

test('restore re-keys a persisted breakdown into a null-prototype map', () => {
  // A breakdown deserialized from JSON can carry an own `__proto__` key.
  const persisted = JSON.parse(
    '{"__proto__":{"inputTokens":7,"outputTokens":0,"cacheReadInputTokens":0,' +
      '"cacheCreationInputTokens":0,"webSearchRequests":0,"costUSD":0,' +
      '"contextWindow":0,"maxOutputTokens":0}}',
  ) as { [modelName: string]: ModelUsage }

  setCostStateForRestore({
    totalCostUSD: 0,
    totalAPIDuration: 0,
    totalAPIDurationWithoutRetries: 0,
    totalToolDuration: 0,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    lastDuration: undefined,
    modelUsage: persisted,
  })

  // Restored as an own key, not the map's prototype, and safe to mutate.
  expect(getUsageForModel('__proto__')?.inputTokens).toBe(7)
  addToTotalCostState(1, sampleUsage(), '__proto__')
  expect((Object.prototype as Record<string, unknown>).inputTokens).toBeUndefined()
})
