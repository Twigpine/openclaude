import { PassThrough } from 'node:stream'
import { stripVTControlCharacters as stripAnsi } from 'node:util'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as React from 'react'

import { createRoot } from '../../ink.js'
import { AppStateProvider } from '../../state/AppState.js'
import { snapshotEnv } from '../../test/envSnapshot.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import searchCmd from './index.js'
import { backendDescription, setSearchEnvStoreForTests } from './search.js'
import { findSearchBackend, type SearchEnvStore } from './searchSettings.js'

// An in-memory store stands in for the global config so these flows never
// read the developer's settings files or write ~/.openclaude.json, and so
// managed/user settings.json env entries on the test machine can't change
// the outcome.
const savedEnvBlock: Record<string, string> = {}
const memoryStore: SearchEnvStore = {
  save(set, unset) {
    Object.assign(savedEnvBlock, set)
    for (const key of unset) delete savedEnvBlock[key]
  },
  overriddenBy: () => undefined,
  saved: key => savedEnvBlock[key],
}

const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'

const ENV_KEYS = [
  'WEB_SEARCH_PROVIDER',
  'EXA_API_KEY',
  'TAVILY_API_KEY',
  'ANYSEARCH_API_KEY',
  'KEENABLE_API_KEY',
  'AIMLAPI_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'CLAUDE_CODE_PROVIDER_ROUTE_ID',
] as const
let restoreEnv: () => void = () => {}
const originalFetch = globalThis.fetch

beforeEach(async () => {
  await acquireSharedMutationLock('commands/search/search.test.tsx')
  restoreEnv = snapshotEnv(ENV_KEYS, { clear: true })
  for (const key of Object.keys(savedEnvBlock)) delete savedEnvBlock[key]
  setSearchEnvStoreForTests(memoryStore)
})

afterEach(() => {
  try {
    setSearchEnvStoreForTests(undefined)
    globalThis.fetch = originalFetch
    restoreEnv()
  } finally {
    releaseSharedMutationLock()
  }
})

function extractLastFrame(output: string): string {
  let lastFrame: string | null = null
  let cursor = 0
  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor)
    if (start === -1) break
    const contentStart = start + SYNC_START.length
    const end = output.indexOf(SYNC_END, contentStart)
    if (end === -1) break
    const frame = output.slice(contentStart, end)
    if (frame.trim().length > 0) lastFrame = frame
    cursor = end + SYNC_END.length
  }
  return lastFrame ?? output
}

type TestStdin = PassThrough & {
  isTTY: boolean
  setRawMode: (mode: boolean) => void
  ref: () => void
  unref: () => void
}

interface Mounted {
  stdin: TestStdin
  waitFor: (predicate: (frame: string) => boolean) => Promise<string>
  done: () => string | undefined
  unmount: () => void
}

async function waitUntil<T>(read: () => T, predicate: (value: T) => boolean): Promise<T> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 2500) {
    const value = read()
    if (predicate(value)) return value
    await Bun.sleep(10)
  }
  return read()
}

/** Run `/search <args>`; mount whatever UI it returns on TTY-like test streams. */
async function runSearch(args: string): Promise<{ text: string | undefined; mounted?: Mounted }> {
  const { call } = await searchCmd.load()
  let text: string | undefined
  const onDone = (result?: string): void => {
    text = result
  }
  const node = await call(onDone, {} as never, args)
  if (!node) return { text }

  let output = ''
  const stdout = new PassThrough()
  const stdin = new PassThrough() as TestStdin
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  root.render(<AppStateProvider>{node}</AppStateProvider>)

  const frame = (): string => stripAnsi(extractLastFrame(output))
  return {
    text,
    mounted: {
      stdin,
      waitFor: predicate => waitUntil(frame, predicate),
      done: () => text,
      unmount: () => {
        root.unmount()
        stdin.end()
        stdout.end()
      },
    },
  }
}

describe('/search command', () => {
  test('is registered as a sensitive local-jsx command', () => {
    expect(searchCmd.name).toBe('search')
    expect(searchCmd.type).toBe('local-jsx')
    expect(searchCmd.isSensitive).toBe(true)
  })

  test('the website command reference matches the command definition', async () => {
    const web = (await import(
      new URL('../../../web/src/data/commands.ts', import.meta.url).href
    )) as { commands: Array<{ name: string; description: string; category: string; args?: string }> }

    expect(web.commands.find(c => c.name === 'search')).toEqual({
      name: 'search',
      description: searchCmd.description,
      category: 'tools',
      args: searchCmd.argumentHint,
    })
  })

  test('help prints usage without rendering UI', async () => {
    const { text, mounted } = await runSearch('help')
    expect(mounted).toBeUndefined()
    expect(text).toContain('/search key [backend]')
    expect(text).toContain('/search remove-key [backend]')
  })

  test('status reports the current web search mode', async () => {
    const { text, mounted } = await runSearch('status')
    expect(mounted).toBeUndefined()
    expect(text).toContain('Web search: auto')
  })

  test('unknown backends report an error without echoing the token', async () => {
    const { text } = await runSearch('altavista')
    expect(text).toContain('Unknown search backend.')
    expect(text).not.toContain('altavista')
  })

  test('no args renders the backend picker', async () => {
    const { mounted } = await runSearch('')
    const frame = await mounted!.waitFor(f => f.includes('Web search backend'))
    mounted!.unmount()

    expect(frame).toContain('Auto (recommended)')
    expect(frame).toContain('Exa')
    expect(frame).toContain('AnySearch')
    expect(frame).toContain('Keenable')
    expect(frame).toContain('needs TAVILY_API_KEY')
  })

  test('the picker shows whether AI/ML API has the provider key', () => {
    const aimlapi = findSearchBackend('aimlapi')!
    expect(backendDescription(aimlapi)).toEndWith(' · needs AIMLAPI_API_KEY (set up with /provider)')

    process.env.AIMLAPI_API_KEY = 'aiml-provider-key'
    expect(backendDescription(aimlapi)).toEndWith(' · uses your AI/ML API key')
  })

  test('direct selection enables AnySearch without opening a key dialog', async () => {
    const { text, mounted } = await runSearch('anysearch')

    expect(mounted).toBeUndefined()
    expect(text).toBe('Web search set to AnySearch.')
    expect(savedEnvBlock).toEqual({ WEB_SEARCH_PROVIDER: 'anysearch' })
  })

  test('direct selection enables Keenable without opening a key dialog', async () => {
    const { text, mounted } = await runSearch('keenable')

    expect(mounted).toBeUndefined()
    expect(text).toBe('Web search set to Keenable.')
    expect(savedEnvBlock).toEqual({ WEB_SEARCH_PROVIDER: 'keenable' })
  })

  test('AI/ML API is selected with the provider key and never asks for or saves one', async () => {
    const missing = await runSearch('aimlapi')
    expect(missing.mounted).toBeUndefined()
    expect(missing.text).toStartWith('Web search settings unchanged. AI/ML API uses AIMLAPI_API_KEY')
    expect(savedEnvBlock).toEqual({})

    const key = await runSearch('key aimlapi')
    expect(key.mounted).toBeUndefined()
    expect(key.text).toContain('/search does not store it')

    process.env.AIMLAPI_API_KEY = 'aiml-provider-key'
    const selected = await runSearch('aimlapi')
    expect(selected.mounted).toBeUndefined()
    expect(selected.text).toStartWith('Web search set to AI/ML API.')
    expect(savedEnvBlock).toEqual({ WEB_SEARCH_PROVIDER: 'aimlapi' })
  })

  test('typing a key saves the backend and key without ever showing the key', async () => {
    const { mounted } = await runSearch('tavily')
    await mounted!.waitFor(f => f.includes('Tavily API key'))

    mounted!.stdin.write('tvly-secret-123')
    const masked = await mounted!.waitFor(f => f.includes('***************'))
    mounted!.stdin.write('\r')
    const message = await waitUntil(mounted!.done, text => text !== undefined)
    mounted!.unmount()

    expect(masked).not.toContain('tvly-secret-123')
    expect(message).toBe('Web search set to Tavily with TAVILY_API_KEY.')
    expect(savedEnvBlock).toEqual({
      WEB_SEARCH_PROVIDER: 'tavily',
      TAVILY_API_KEY: 'tvly-secret-123',
    })
    expect(process.env.TAVILY_API_KEY).toBe('tvly-secret-123')
  })

  test('an AnySearch key can be saved through hidden input and removed', async () => {
    await runSearch('anysearch')
    const { mounted } = await runSearch('key anysearch')
    await mounted!.waitFor(f => f.includes('AnySearch API key'))

    mounted!.stdin.write('private-any-key')
    const masked = await mounted!.waitFor(f => f.includes('***************'))
    mounted!.stdin.write('\r')
    const message = await waitUntil(mounted!.done, text => text !== undefined)
    mounted!.unmount()

    expect(masked).not.toContain('private-any-key')
    expect(message).toBe('Saved ANYSEARCH_API_KEY. AnySearch now uses your key.')
    expect(savedEnvBlock).toEqual({
      WEB_SEARCH_PROVIDER: 'anysearch',
      ANYSEARCH_API_KEY: 'private-any-key',
    })

    const removed = await runSearch('remove-key anysearch')
    expect(removed.text).toBe('Removed the saved ANYSEARCH_API_KEY.')
    expect(process.env.ANYSEARCH_API_KEY).toBeUndefined()

    let authorizationPresent = true
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorizationPresent = Object.hasOwn(init?.headers ?? {}, 'Authorization')
      return new Response(JSON.stringify({ code: 0, data: { results: [] } }), { status: 200 })
    }) as typeof fetch
    const anonymousTest = await runSearch('test anonymous after removing key')
    expect(anonymousTest.text).toContain('Search OK via AnySearch: 0 results')
    expect(authorizationPresent).toBe(false)
  })

  test('a Keenable key can be saved through hidden input and removed', async () => {
    await runSearch('keenable')
    const { mounted } = await runSearch('key keenable')
    await mounted!.waitFor(f => f.includes('Keenable API key'))

    mounted!.stdin.write('private-kn-key')
    const masked = await mounted!.waitFor(f => f.includes('**************'))
    mounted!.stdin.write('\r')
    const message = await waitUntil(mounted!.done, text => text !== undefined)
    mounted!.unmount()

    expect(masked).not.toContain('private-kn-key')
    expect(message).toBe('Saved KEENABLE_API_KEY. Keenable now uses your key.')
    expect(savedEnvBlock).toEqual({
      WEB_SEARCH_PROVIDER: 'keenable',
      KEENABLE_API_KEY: 'private-kn-key',
    })

    const removed = await runSearch('remove-key keenable')
    expect(removed.text).toBe('Removed the saved KEENABLE_API_KEY.')
    expect(process.env.KEENABLE_API_KEY).toBeUndefined()

    let requestedUrl = ''
    let keyHeaderPresent = true
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input)
      keyHeaderPresent = Object.hasOwn(init?.headers ?? {}, 'X-API-Key')
      return new Response(JSON.stringify({ results: [] }), { status: 200 })
    }) as typeof fetch
    const keylessTest = await runSearch('test keyless after removing key')
    expect(keylessTest.text).toContain('Search OK via Keenable: 0 results')
    expect(requestedUrl).toBe('https://api.keenable.ai/v1/search/public')
    expect(keyHeaderPresent).toBe(false)
  })

  test('Esc in the key dialog cancels without saving', async () => {
    const { mounted } = await runSearch('key exa')
    await mounted!.waitFor(f => f.includes('Exa API key'))

    mounted!.stdin.write('\x1b')
    const message = await waitUntil(mounted!.done, text => text !== undefined)
    mounted!.unmount()

    expect(message).toBe('Web search settings unchanged.')
    expect(savedEnvBlock).toEqual({})
  })

  test('an inline key opens the dialog with a rotate warning and never shows it', async () => {
    const { mounted } = await runSearch('key exa exa-leaked-key')
    const frame = await mounted!.waitFor(f => f.includes('Exa API key'))
    mounted!.unmount()

    expect(frame).toContain('typed a key on the command line')
    expect(frame).not.toContain('exa-leaked-key')
  })

  test('remove-key deletes a saved key', async () => {
    Object.assign(savedEnvBlock, { EXA_API_KEY: 'exa-old', KEEP: '1' })
    process.env.EXA_API_KEY = 'exa-old'

    const { text } = await runSearch('remove-key exa')

    expect(text).toBe('Removed the saved EXA_API_KEY.')
    expect(savedEnvBlock).toEqual({ KEEP: '1' })
    expect(process.env.EXA_API_KEY).toBeUndefined()
  })

  test('a stray token after a keyless backend is not applied and gets a rotate hint', async () => {
    const { text, mounted } = await runSearch('auto sk-pasted-by-mistake')

    expect(mounted).toBeUndefined()
    expect(text).toContain('rotate it')
    expect(text).not.toContain('sk-pasted-by-mistake')
    expect(savedEnvBlock).toEqual({})
  })
})
