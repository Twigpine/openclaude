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

import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { resetEnvMutexForTesting } from './shared'
import type { SDKMessage } from './coreTypes'
import { getAnthropicClient } from '../../services/api/client'
import { snapshotEnv } from '../../test/envSnapshot'
import { clearApiKeyHelperCache, clearAwsCredentialsCache, clearOAuthTokenCache, refreshAndGetAwsCredentials } from '../../utils/auth'
import * as settings from '../../utils/settings/settings'
import * as aws from '../../utils/aws'
import * as secureStorage from '../../utils/secureStorage/index'

const KEY = 'OPENCLAUDE_TEST_SESSION_ENV_TURN'

const authEnvKeys = [
  'OPENCLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_OPENAI', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_GITHUB', 'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GEMINI_VERTEX', 'CLAUDE_CODE_USE_MISTRAL',
  'MINIMAX_API_KEY', 'MIMO_API_KEY', 'XAI_API_KEY', 'NEARAI_API_KEY',
  'FIREWORKS_API_KEY', 'LONGCAT_API_KEY', 'AIMLAPI_API_KEY', 'APISMART_API_KEY',
  'CONCENTRATE_API_KEY', 'API_ROUTE_API_KEY', 'GEMINI_AUTH_MODE',
  'GEMINI_ACCESS_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_COPILOT_KEY',
  'CLAUDE_CODE_GITHUB_TOKEN_HYDRATED', 'OPENAI_API_KEY', 'OPENAI_API_KEYS',
]

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
let realInit: typeof import('../init.js')

beforeAll(async () => {
  // Held so the registration can be put back. Raised in review: a
  // `mock.module` registration is process-global and `mock.restore()` does
  // not remove it, so a stubbed `init` would go on standing in for the real
  // one in every test file that runs after this one in the same bun process.
  realInit = { ...(await import('../init.js')) }
  mock.module('../init.js', () => ({ init: async () => {} }))
  createSession = (await import('./v2')).unstable_v2_createSession
})

afterAll(() => {
  mock.module('../init.js', () => realInit)
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

  test('close returns a paused turn and admits the next scoped turn', async () => {
    process.env[KEY] = 'before'
    const one = session({ [KEY]: 'during' })
    const iterator = one.sendMessage('hi')[Symbol.asyncIterator]()
    try {
      await iterator.next()
      one.close()
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(process.env[KEY]).toBe('before')
      const two = session({ [KEY]: 'next' })
      try {
        for await (const _ of two.sendMessage('hi')) break
        expect(seen).toEqual(['during', 'next'])
      } finally {
        two.close()
      }
    } finally {
      await iterator.return?.()
      one.close()
    }
  })

  test('close waits for active engine cleanup before restoring the environment', async () => {
    let finish!: () => void
    const cleanup = new Promise<void>(resolve => { finish = resolve })
    const one = session({ [KEY]: 'during' })
    const engine = engineSeeingEnv(1)
    engine.submitMessage = async function* () {
      try {
        yield* engineSeeingEnv(1).submitMessage()
      } finally {
        await cleanup
        seen.push(process.env[KEY])
      }
    }
    ;(one as unknown as { setEngine: (engine: unknown) => void }).setEngine(engine)
    const iterator = one.sendMessage('hi')[Symbol.asyncIterator]()
    try {
      await iterator.next()
      one.close()
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(process.env[KEY]).toBe('during')
      finish()
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(seen).toEqual(['during', 'during'])
      expect(Object.hasOwn(process.env, KEY)).toBe(false)
    } finally {
      finish()
      await iterator.return?.()
      one.close()
    }
  })

  test('close during a pending next waits for work without yielding another message', async () => {
    let finish!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const work = new Promise<void>(resolve => { finish = resolve })
    const one = session({ [KEY]: 'during' })
    const engine = engineSeeingEnv(1)
    engine.submitMessage = async function* () {
      entered()
      await work
      yield* engineSeeingEnv(1).submitMessage()
    }
    ;(one as unknown as { setEngine: (engine: unknown) => void }).setEngine(engine)
    const iterator = one.sendMessage('hi')[Symbol.asyncIterator]()
    const next = iterator.next()
    try {
      await started
      one.close()
      one.close()
      expect(process.env[KEY]).toBe('during')
      finish()
      expect((await next).done).toBe(true)
      expect(seen).toEqual(['during'])
      expect(Object.hasOwn(process.env, KEY)).toBe(false)
    } finally {
      finish()
      await iterator.return?.()
      one.close()
    }
  })

  test('closing a turn queued for the mutex never submits its engine', async () => {
    const first = session({ [KEY]: 'first' })
    const second = session({ [KEY]: 'second' })
    const firstIterator = first.sendMessage('hi')[Symbol.asyncIterator]()
    const secondIterator = second.sendMessage('hi')[Symbol.asyncIterator]()
    try {
      await firstIterator.next()
      const pending = secondIterator.next()
      await new Promise(resolve => setTimeout(resolve, 10))
      second.close()
      expect(() => second.getMessages()).toThrow('engine not initialized')
      first.close()
      expect((await pending).done).toBe(true)
      expect(seen).toEqual(['first'])
      expect(Object.hasOwn(process.env, KEY)).toBe(false)
      const third = session({ [KEY]: 'third' })
      try {
        for await (const _ of third.sendMessage('hi')) break
        expect(seen).toEqual(['first', 'third'])
      } finally {
        third.close()
      }
    } finally {
      await firstIterator.return?.()
      await secondIterator.return?.()
      first.close()
      second.close()
    }
  })

  for (const route of [
    { key: 'XAI_API_KEY', model: 'grok-4', host: 'api.x.ai', native: false },
    { key: 'MINIMAX_API_KEY', model: 'MiniMax-M2.5', host: 'api.minimax.io', native: true },
    { key: 'API_ROUTE_API_KEY', model: 'claude-sonnet-4-6', host: 'global.api-route.com', native: false },
  ]) {
    test(`restores provider-derived environment after a ${route.key} request`, async () => {
      const keys = [
        'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
        'ANTHROPIC_CUSTOM_HEADERS', 'OPENAI_API_KEY', 'OPENAI_API_KEYS',
        'OPENAI_BASE_URL', 'OPENAI_MODEL', 'OPENAI_API_FORMAT',
        'OPENAI_AZURE_STYLE', 'OPENAI_AUTH_HEADER', 'OPENAI_AUTH_SCHEME',
        'OPENAI_AUTH_HEADER_VALUE', 'CLAUDE_CODE_USE_OPENAI', route.key,
      ]
      const restore = snapshotEnv(keys, { clear: true })
      const originalFetch = globalThis.fetch
      const globals = globalThis as Record<string, unknown>
      const originalMacro = globals.MACRO
      globals.MACRO = { VERSION: 'test-version' }
      const requests: { url: string; headers: Headers }[] = []
      const one = session({ [route.key]: 'session-test-secret' })
      try {
        // These ambient values are deleted or overwritten by normalization.
        process.env.OPENAI_AUTH_HEADER = 'X-Ambient-Key'
        process.env.OPENAI_AUTH_SCHEME = 'Bearer'
        process.env.OPENAI_AUTH_HEADER_VALUE = 'ambient-auth'
        process.env.OPENAI_AZURE_STYLE = '1'
        process.env.OPENAI_API_FORMAT = 'responses'
        if (route.native) {
          process.env.ANTHROPIC_API_KEY = 'ambient-native-key'
          process.env.ANTHROPIC_MODEL = 'ambient-model'
          process.env.CLAUDE_CODE_USE_OPENAI = '1'
        }
        if (route.key === 'API_ROUTE_API_KEY') {
          process.env.OPENAI_API_KEYS = 'ambient-pool-key'
          process.env.ANTHROPIC_CUSTOM_HEADERS = 'X-Ambient: before'
        }
        const before = Object.fromEntries(keys.map(key => [key, process.env[key]]))
        globalThis.fetch = (async (input, init) => {
          requests.push({ url: String(input), headers: new Headers(init?.headers) })
          return Response.json(route.native
            ? { id: 'msg-test', type: 'message', role: 'assistant', model: route.model,
                content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
                usage: { input_tokens: 1, output_tokens: 1 } }
            : { id: 'chat-test', object: 'chat.completion', model: route.model,
                choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1 } })
        }) as typeof fetch
        const engine = engineSeeingEnv(1)
        engine.submitMessage = async function* () {
          const client = await getAnthropicClient({ maxRetries: 0, model: route.model })
          await client.beta.messages.create({
            model: route.model, max_tokens: 16,
            messages: [{ role: 'user', content: 'hello' }],
          })
          yield* engineSeeingEnv(1).submitMessage()
        }
        ;(one as unknown as { setEngine: (engine: unknown) => void }).setEngine(engine)
        for await (const _ of one.sendMessage('hi')) { /* drain */ }
        expect(requests).toHaveLength(1)
        expect(new URL(requests[0]!.url).hostname).toBe(route.host)
        expect(requests[0]!.headers.get(route.native ? 'x-api-key' : 'authorization'))
          .toBe(route.native ? 'session-test-secret' : 'Bearer session-test-secret')
        expect(Object.fromEntries(keys.map(key => [key, process.env[key]]))).toEqual(before)
      } finally {
        one.close()
        globalThis.fetch = originalFetch
        if (originalMacro === undefined) delete globals.MACRO
        else globals.MACRO = originalMacro
        restore()
      }
    })
  }


  for (const exit of ['complete', 'break', 'throw'] as const) {
    test(`OAuth identity follows scoped and ambient environments after ${exit}`, async () => {
      const restore = snapshotEnv(authEnvKeys, { clear: true })
      const configDir = mkdtempSync(join(tmpdir(), 'sdk-env-oauth-'))
      const globals = globalThis as Record<string, unknown>
      const originalMacro = globals.MACRO
      globals.MACRO = { VERSION: 'test-version' }
      const authorization: (string | null)[] = []
      try {
        process.env.OPENCLAUDE_CONFIG_DIR = configDir
        // A stable credentials file prevents ENOENT/mtime invalidation from
        // hiding a token cached under another environment.
        writeFileSync(join(configDir, '.credentials.json'), '{}')
        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'ambient-token'
        clearOAuthTokenCache()
        const request = async () => {
          const client = await getAnthropicClient({
            maxRetries: 0,
            fetchOverride: async (_input, init) => {
              authorization.push(new Headers(init?.headers).get('authorization'))
              return Response.json({
                id: 'msg-test', type: 'message', role: 'assistant',
                model: 'claude-sonnet-4-6', content: [], stop_reason: 'end_turn',
                usage: { input_tokens: 1, output_tokens: 0 },
              })
            },
          })
          await client.beta.messages.create({
            model: 'claude-sonnet-4-6', max_tokens: 16,
            messages: [{ role: 'user', content: 'hello' }],
          })
        }
        // Prewarm ambient auth, then check entry AND exit without manually
        // clearing caches between any of the observed requests.
        await request()
        for (const token of ['first-token', 'second-token']) {
          const one = session({ CLAUDE_CODE_OAUTH_TOKEN: token })
          const engine = engineSeeingEnv(1)
          engine.submitMessage = async function* () {
            await request()
            if (exit === 'throw') throw new Error('engine-turn-failure')
            yield* engineSeeingEnv(1).submitMessage()
          }
          ;(one as unknown as { setEngine: (engine: unknown) => void }).setEngine(engine)
          try {
            const drain = async () => {
              for await (const _ of one.sendMessage('hi')) {
                if (exit === 'break') break
              }
            }
            if (exit === 'throw') await expect(drain()).rejects.toThrow('engine-turn-failure')
            else await drain()
          } finally {
            one.close()
          }
          expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('ambient-token')
          await request()
        }
        expect(authorization).toEqual([
          'Bearer ambient-token', 'Bearer first-token', 'Bearer ambient-token',
          'Bearer second-token', 'Bearer ambient-token',
        ])
      } finally {
        restore()
        clearOAuthTokenCache()
        if (originalMacro === undefined) delete globals.MACRO
        else globals.MACRO = originalMacro
        rmSync(configDir, { recursive: true, force: true })
      }
    })
  }

  for (const credentialSource of ['apiKeyHelper', 'awsCredentialExport'] as const) {
    for (const exit of ['complete', 'break', 'throw'] as const) {
      test(`${credentialSource} identity follows scoped and ambient environments after ${exit}`, async () => {
        const restore = snapshotEnv([...authEnvKeys, KEY, 'NODE_ENV', 'CI'], { clear: true })
        const configDir = mkdtempSync(join(tmpdir(), 'sdk-env-helper-'))
        const globals = globalThis as Record<string, unknown>
        const originalMacro = globals.MACRO
        globals.MACRO = { VERSION: 'test-version' }
        process.env.OPENCLAUDE_CONFIG_DIR = configDir
        process.env.NODE_ENV = 'production'
        process.env[KEY] = 'ambient'
        const helperPath = join(configDir, 'credential-helper.cjs')
        // Real, cross-platform helper execution: the command inherits the turn
        // environment; only network/storage dependencies are substituted.
        writeFileSync(helperPath, credentialSource === 'apiKeyHelper'
          ? `process.stdout.write(process.env.${KEY})`
          : `process.stdout.write(JSON.stringify({ Credentials: {
              AccessKeyId: process.env.${KEY}, SecretAccessKey: 'test-secret', SessionToken: 'test-token',
            } }))`)
        const helperSettings = { [credentialSource]: `"${process.execPath}" "${helperPath}"` }
        const mergedSettings = spyOn(settings, 'getSettings_DEPRECATED').mockReturnValue(helperSettings)
        const sourceSettings = spyOn(settings, 'getSettingsForSource')
          .mockImplementation(source => source === 'userSettings' ? helperSettings : null)
        const storage = spyOn(secureStorage, 'getSecureStorage').mockReturnValue({
          name: 'session-env-helper-fixture', read: () => null, readAsync: async () => null,
          update: () => ({ success: true }), delete: () => true,
        })
        const sts = credentialSource === 'awsCredentialExport'
          ? spyOn(aws, 'checkStsCallerIdentity').mockRejectedValue(new Error('export required'))
          : undefined
        const ini = credentialSource === 'awsCredentialExport'
          ? spyOn(aws, 'clearAwsIniCache').mockResolvedValue(undefined)
          : undefined
        clearApiKeyHelperCache()
        clearAwsCredentialsCache()
        clearOAuthTokenCache()
        const identities: (string | null | undefined)[] = []
        const request = async () => {
          if (credentialSource === 'awsCredentialExport') {
            // This is the credential object getAnthropicClient passes to
            // Bedrock; STS and INI operations above avoid live AWS access.
            identities.push((await refreshAndGetAwsCredentials())?.accessKeyId)
            return
          }
          const client = await getAnthropicClient({
            maxRetries: 0,
            fetchOverride: async (_input, init) => {
              identities.push(new Headers(init?.headers).get('authorization'))
              return Response.json({
                id: 'msg-helper', type: 'message', role: 'assistant',
                model: 'claude-sonnet-4-6', content: [], stop_reason: 'end_turn',
                usage: { input_tokens: 1, output_tokens: 0 },
              })
            },
          })
          await client.beta.messages.create({
            model: 'claude-sonnet-4-6', max_tokens: 16,
            messages: [{ role: 'user', content: 'hello' }],
          })
        }
        try {
          // A warm ambient cache must not supply the scoped request. Conversely,
          // each scope's cached result must disappear before the ambient read.
          await request()
          for (const identity of ['first', 'second']) {
            const one = session({ [KEY]: identity })
            const engine = engineSeeingEnv(1)
            engine.submitMessage = async function* () {
              await request()
              if (exit === 'throw') throw new Error('helper-turn-failure')
              yield* engineSeeingEnv(1).submitMessage()
            }
            ;(one as unknown as { setEngine: (engine: unknown) => void }).setEngine(engine)
            try {
              const drain = async () => {
                for await (const _ of one.sendMessage('hi')) {
                  if (exit === 'break') break
                }
              }
              if (exit === 'throw') await expect(drain()).rejects.toThrow('helper-turn-failure')
              else await drain()
            } finally {
              one.close()
            }
            expect(process.env[KEY]).toBe('ambient')
            await request()
          }
          expect(identities).toEqual(credentialSource === 'apiKeyHelper'
            ? ['Bearer ambient', 'Bearer first', 'Bearer ambient', 'Bearer second', 'Bearer ambient']
            : ['ambient', 'first', 'ambient', 'second', 'ambient'])
        } finally {
          ini?.mockRestore()
          sts?.mockRestore()
          storage.mockRestore()
          sourceSettings.mockRestore()
          mergedSettings.mockRestore()
          restore()
          clearApiKeyHelperCache()
          clearAwsCredentialsCache()
          clearOAuthTokenCache()
          if (originalMacro === undefined) delete globals.MACRO
          else globals.MACRO = originalMacro
          rmSync(configDir, { recursive: true, force: true })
        }
      })
    }
  }

  for (const route of ['gemini', 'github-token', 'github-key'] as const) {
    for (const original of [undefined, ' '] as const) {
      test(`restores ${route} hydration outputs originally ${original === undefined ? 'absent' : 'present'}`, async () => {
        const restore = snapshotEnv(authEnvKeys, { clear: true })
        const globals = globalThis as Record<string, unknown>
        const originalMacro = globals.MACRO
        globals.MACRO = { VERSION: 'test-version' }
        const data = {
          claudeAiOauth: undefined,
          gemini: { accessToken: 'stored-gemini-secret' },
          githubModels: {
            accessToken: 'stored-github-secret',
            credentialType: route === 'github-key' ? 'copilot_key' : 'copilot_token',
          },
        }
        const storage = spyOn(secureStorage, 'getSecureStorage').mockReturnValue({
          name: 'session-env-fixture', read: () => data, readAsync: async () => data,
          update: () => ({ success: true }), delete: () => true,
        })
        const outputs = [
          'GEMINI_ACCESS_TOKEN', 'GITHUB_TOKEN', 'GITHUB_COPILOT_KEY',
          'CLAUDE_CODE_GITHUB_TOKEN_HYDRATED',
        ]
        for (const key of outputs) {
          if (original !== undefined) process.env[key] = original
        }
        const before = outputs.map(key => [Object.hasOwn(process.env, key), process.env[key]])
        const one = session(route === 'gemini'
          ? { CLAUDE_CODE_USE_GEMINI: '1', GEMINI_AUTH_MODE: 'access-token' }
          : { CLAUDE_CODE_USE_GITHUB: '1' })
        try {
          const engine = engineSeeingEnv(1)
          engine.submitMessage = async function* () {
            await getAnthropicClient({
              maxRetries: 0, model: route === 'gemini' ? 'gemini-2.5-flash' : 'gpt-4.1',
            })
            // Prove real hydration ran; the storage double only supplies data.
            const key = route === 'gemini' ? 'GEMINI_ACCESS_TOKEN'
              : route === 'github-key' ? 'GITHUB_COPILOT_KEY' : 'GITHUB_TOKEN'
            expect(process.env[key]).toBe(route === 'gemini'
              ? 'stored-gemini-secret' : 'stored-github-secret')
            yield* engineSeeingEnv(1).submitMessage()
          }
          ;(one as unknown as { setEngine: (engine: unknown) => void }).setEngine(engine)
          for await (const _ of one.sendMessage('hi')) { /* drain */ }
          expect(outputs.map(key => [Object.hasOwn(process.env, key), process.env[key]])).toEqual(before)
        } finally {
          one.close()
          storage.mockRestore()
          restore()
          clearOAuthTokenCache()
          if (originalMacro === undefined) delete globals.MACRO
          else globals.MACRO = originalMacro
        }
      })
    }
  }

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

  /**
   * THE LIMIT, WRITTEN DOWN AS A TEST.
   *
   * A turn that asked for no environment takes no mutex — nothing to take and
   * nothing to put back — so it is free to run beside an env-scoped turn. And
   * `process.env` is one object for the whole process: while the scoped turn
   * holds its variables, the other turn is looking at the same object and
   * sees them.
   *
   * This is the price of the design and not a defect in it. The alternative —
   * making every turn take the mutex — would serialise an embedder's whole
   * process the moment one session used `env`, which is a far worse trade for
   * the host this exists for. What IS guaranteed, and asserted below, is that
   * nothing survives the turn.
   *
   * The suggestion to cover a concurrent env-less turn came from review; it
   * was written expecting isolation, and this is what it actually found.
   */
  test('AN ENV-LESS TURN RUNNING ALONGSIDE ONE CAN SEE ITS VARIABLES, BUT NOT OUTLIVE THEM', async () => {
    const scoped = session({ [KEY]: 'scoped' }, 3)
    const plain = session(undefined, 3)

    const drain = async (one: ReturnType<typeof session>) => {
      for await (const _ of one.sendMessage('hi')) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    }

    await Promise.all([drain(scoped), drain(plain)])

    expect(seen.length).toBe(6)
    // Both turns were looking at the same `process.env` while it was set.
    expect(seen.every(one => one === 'scoped')).toBe(true)
    // And the guarantee that does hold: the turn took its variables with it.
    expect(KEY in process.env).toBe(false)

    scoped.close()
    plain.close()
  })
})
