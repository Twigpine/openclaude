/**
 * A session's own environment, through a real turn.
 *
 * `v2.sessionEnv.test.ts` drives the apply/restore directly; these tests
 * iterate `sendMessage()` itself, because that is where the behaviour has to
 * hold: the variables must be in place by the time the engine asks the
 * provider anything, and gone once the turn is over — including when the
 * consumer walks away from the iterator half way through.
 *
 * The engine is a stand-in that reports what it sees in `process.env` instead
 * of calling a provider, and `init()` is stubbed because the real one
 * configures proxies, mTLS and remote settings process-wide.
 */

import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'

import { resetEnvMutexForTesting } from './shared'
import type { SDKMessage } from './coreTypes'

const KEY = 'OPENCLAUDE_TEST_SESSION_ENV_TURN'

/** What the engine saw in the environment, one entry per yielded message. */
let seen: (string | undefined)[] = []

/** An engine that answers out of the environment and never leaves the process. */
function engineSeeingEnv(messages = 2) {
  return {
    // Everything the turn and `close()` touch on an engine, doing nothing.
    injectAgents: () => {},
    setMcpClients: () => {},
    updateTools: () => {},
    getMcpClients: () => [],
    getMessages: () => [],
    interrupt: () => {},
    submitMessage: async function* (): AsyncGenerator<SDKMessage> {
      for (let i = 0; i < messages; i++) {
        seen.push(process.env[KEY])
        yield { type: 'assistant', message: { content: [] }, session_id: 's' } as unknown as SDKMessage
        // Hand control back, so a second turn could interleave if it were let in.
        await new Promise(resolve => setTimeout(resolve, 0))
      }
    },
  }
}

let createSession: typeof import('./v2').unstable_v2_createSession

beforeAll(async () => {
  mock.module('../init.js', () => ({ init: async () => {} }))
  createSession = (await import('./v2')).unstable_v2_createSession
})

afterEach(() => {
  delete process.env[KEY]
  seen = []
  resetEnvMutexForTesting()
})

/** A session whose turn is answered by `engineSeeingEnv`. */
function session(env?: Record<string, string | undefined>, messages = 2) {
  const made = createSession({ cwd: process.cwd(), ...(env ? { env } : {}) })
  ;(made as unknown as { setEngine: (engine: unknown) => void }).setEngine(engineSeeingEnv(messages))
  return made
}

describe('SDKSessionOptions.env through a turn', () => {
  test('THE TURN SEES ITS OWN VARIABLES, AND AFTERWARDS NOBODY DOES', async () => {
    process.env[KEY] = 'before'
    const one = session({ [KEY]: 'during' })

    for await (const _ of one.sendMessage('hi')) {
      // The point is what the engine saw, not what came back.
    }

    expect(seen).toEqual(['during', 'during'])
    expect(process.env[KEY]).toBe('before')
    one.close()
  })

  /**
   * The case a direct apply/restore test cannot reach: a consumer that stops
   * iterating. Breaking out of the loop calls the generator's `return`, which
   * must run the restore — otherwise the variables, and the mutex, outlive the
   * turn and every later env-setting turn waits forever.
   */
  test('AN ABANDONED TURN STILL PUTS THE ENVIRONMENT BACK', async () => {
    process.env[KEY] = 'before'
    const one = session({ [KEY]: 'during' }, 5)

    for await (const _ of one.sendMessage('hi')) {
      break
    }

    expect(seen).toEqual(['during'])
    expect(process.env[KEY]).toBe('before')

    // And the mutex came back with it: a second turn gets in without waiting.
    const two = session({ [KEY]: 'second' })
    for await (const _ of two.sendMessage('hi')) {
      break
    }
    expect(seen).toEqual(['during', 'second'])
    expect(process.env[KEY]).toBe('before')

    one.close()
    two.close()
  })

  /**
   * Two turns, two environments, one process. They may not interleave, and the
   * proof is in what each engine saw: never the other session's value.
   */
  test('TWO TURNS WITH DIFFERENT ENVIRONMENTS DO NOT INTERLEAVE', async () => {
    const first = session({ [KEY]: 'first' }, 3)
    const second = session({ [KEY]: 'second' }, 3)

    const drain = async (one: ReturnType<typeof session>) => {
      for await (const _ of one.sendMessage('hi')) {
        // Drain, slowly enough that an unguarded second turn would slip in.
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    }

    await Promise.all([drain(first), drain(second)])

    expect(seen.length).toBe(6)
    const halves = [seen.slice(0, 3), seen.slice(3)].map(half => new Set(half))
    expect(halves[0]!.size).toBe(1)
    expect(halves[1]!.size).toBe(1)
    expect([...halves[0]!][0]).not.toBe([...halves[1]!][0])
    expect(KEY in process.env).toBe(false)

    first.close()
    second.close()
  })
})
