/**
 * A session's own environment.
 *
 * `QueryOptions` has accepted `env` for a while; `SDKSessionOptions` could
 * not, so a host keeping several sessions in one process had to share one
 * environment between them. That matters when the variable selects the
 * provider — `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` and their keys are read
 * per request, so two sessions aimed at different endpoints silently used
 * whichever had been set last.
 *
 * These tests drive the apply/restore directly rather than running a turn:
 * what needs proving is that a session's variables are in place for its own
 * turn and gone afterwards, and that no turn can see another session's.
 */

import { describe, expect, test, afterEach } from 'bun:test'
import { execFileSync } from 'node:child_process'

import { unstable_v2_createSession } from './v2'
import { resetEnvMutexForTesting } from './shared'

const KEY = 'OPENCLAUDE_TEST_SESSION_ENV'

afterEach(() => {
  delete process.env[KEY]
  resetEnvMutexForTesting()
})

/** Reach the private apply/restore the turn uses, without running a turn. */
function envHooks(session: unknown): {
  apply: () => Promise<Record<string, string | undefined> | null>
  restore: (snapshot: Record<string, string | undefined> | null) => void
} {
  const impl = session as {
    applySessionEnv: () => Promise<Record<string, string | undefined> | null>
    restoreSessionEnv: (snapshot: Record<string, string | undefined> | null) => void
  }
  return {
    apply: () => impl.applySessionEnv(),
    restore: snapshot => impl.restoreSessionEnv(snapshot),
  }
}

describe('SDKSessionOptions.env', () => {
  test('applies for the turn and restores afterwards', async () => {
    process.env[KEY] = 'before'
    const session = unstable_v2_createSession({ cwd: process.cwd(), env: { [KEY]: 'during' } })
    const hooks = envHooks(session)

    const snapshot = await hooks.apply()
    expect(process.env[KEY]).toBe('during')
    hooks.restore(snapshot)
    expect(process.env[KEY]).toBe('before')
    session.close()
  })

  test('a variable the environment did not have is removed again, not emptied', async () => {
    expect(process.env[KEY]).toBeUndefined()
    const session = unstable_v2_createSession({ cwd: process.cwd(), env: { [KEY]: 'during' } })
    const hooks = envHooks(session)

    const snapshot = await hooks.apply()
    expect(process.env[KEY]).toBe('during')
    hooks.restore(snapshot)
    expect(KEY in process.env).toBe(false)
    session.close()
  })

  test('undefined removes a variable for the turn', async () => {
    process.env[KEY] = 'before'
    const session = unstable_v2_createSession({ cwd: process.cwd(), env: { [KEY]: undefined } })
    const hooks = envHooks(session)

    const snapshot = await hooks.apply()
    expect(KEY in process.env).toBe(false)
    hooks.restore(snapshot)
    expect(process.env[KEY]).toBe('before')
    session.close()
  })

  test('a session without env takes no mutex and changes nothing', async () => {
    process.env[KEY] = 'before'
    const session = unstable_v2_createSession({ cwd: process.cwd() })
    const hooks = envHooks(session)

    const snapshot = await hooks.apply()
    expect(snapshot).toBeNull()
    expect(process.env[KEY]).toBe('before')
    // Restoring a null snapshot must not release a mutex nobody took: a
    // stray release would let two env-setting turns overlap.
    hooks.restore(snapshot)
    expect(process.env[KEY]).toBe('before')
    session.close()
  })

  /**
   * The point of the mutex. One process has one environment, so two sessions
   * wanting different values cannot both have them at once — the honest
   * behaviour is to serialise, not to interleave and let the last writer win.
   */
  test('TWO SESSIONS WITH DIFFERENT ENVIRONMENTS SERIALISE', async () => {
    const first = unstable_v2_createSession({ cwd: process.cwd(), env: { [KEY]: 'first' } })
    const second = unstable_v2_createSession({ cwd: process.cwd(), env: { [KEY]: 'second' } })

    const firstHooks = envHooks(first)
    const secondHooks = envHooks(second)

    const firstSnapshot = await firstHooks.apply()
    expect(process.env[KEY]).toBe('first')

    let secondEntered = false
    const secondTurn = secondHooks.apply().then(snapshot => {
      secondEntered = true
      return snapshot
    })

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(secondEntered).toBe(false)
    expect(process.env[KEY]).toBe('first')

    firstHooks.restore(firstSnapshot)
    const secondSnapshot = await secondTurn
    expect(secondEntered).toBe(true)
    expect(process.env[KEY]).toBe('second')

    secondHooks.restore(secondSnapshot)
    expect(KEY in process.env).toBe(false)
    first.close()
    second.close()
  })
})

test('built Node SDK preserves absence of inherited environment names', () => {
  const sdkUrl = new URL('../../../dist/sdk.mjs', import.meta.url).href
  const result = execFileSync('node', ['--input-type=module', '-e', `
    import { unstable_v2_createSession } from ${JSON.stringify(sdkUrl)};
    const keys = ['__proto__', 'constructor', 'toString'];
    for (const key of keys) delete process.env[key];
    const session = unstable_v2_createSession({
      cwd: process.cwd(), env: Object.fromEntries(keys.map(key => [key, 'during'])),
    });
    const snapshot = await session.applySessionEnv();
    session.restoreSessionEnv(snapshot);
    session.close();
    if (keys.some(key => Object.hasOwn(process.env, key))) {
      throw new Error('restoration created an originally absent environment entry');
    }
    console.log('restored absence');
  `], { encoding: 'utf8' })
  expect(result.trim()).toBe('restored absence')
})
