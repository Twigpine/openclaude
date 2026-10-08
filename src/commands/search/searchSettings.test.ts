import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getAllowedSettingSources, setAllowedSettingSources } from '../../bootstrap/state.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { ProviderOutput } from '../../tools/WebSearchTool/providers/index.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

import {
  applySearchSelection,
  describeSearchStatus,
  findSearchBackend,
  findSettingsEnvOverride,
  globalConfigSearchEnvStore,
  needsApiKey,
  parseSearchArgs,
  removeSearchApiKey,
  runSearchTest,
  saveSearchApiKey,
  type SearchBackendOption,
  type SearchEnvStore,
} from './searchSettings.js'

const SEARCH_ENV_KEYS = [
  'WEB_SEARCH_PROVIDER',
  'EXA_API_KEY',
  'EXA_FREE_TIER',
  'TAVILY_API_KEY',
  'ANYSEARCH_API_KEY',
  'ANYSEARCH_MAX_RESULTS',
  'FIRECRAWL_API_KEY',
  'FIRECRAWL_API_URL',
  'YOU_API_KEY',
  'JINA_API_KEY',
  'BRAVE_API_KEY',
  'BING_API_KEY',
  'MOJEEK_API_KEY',
  'LINKUP_API_KEY',
  'OLLAMA_API_KEY',
  'OLLAMA_BASE_URL',
  'CLAUDE_CODE_USE_OPENAI',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'CLAUDE_CODE_PROVIDER_ROUTE_ID',
] as const

const savedEnv = Object.fromEntries(SEARCH_ENV_KEYS.map(k => [k, process.env[k]]))
const originalFetch = globalThis.fetch

beforeEach(async () => {
  await acquireSharedMutationLock('commands/search/searchSettings.test.ts')
  for (const key of SEARCH_ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  try {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  } finally {
    releaseSharedMutationLock()
  }
})

function backend(name: string): SearchBackendOption {
  const option = findSearchBackend(name)
  if (!option) throw new Error(`unknown backend ${name}`)
  return option
}

interface RecordingStore extends SearchEnvStore {
  saves: Array<{ set: Record<string, string>; unset: readonly string[] }>
}

function recordingStore(
  overrides: Record<string, string> = {},
  savedValues: Record<string, string> = {},
): RecordingStore {
  const saves: RecordingStore['saves'] = []
  return {
    saves,
    save: (set, unset) => {
      saves.push({ set, unset })
    },
    overriddenBy: key => overrides[key],
    saved: key => savedValues[key],
  }
}

const failingStore: SearchEnvStore = {
  save: () => {
    throw new Error('read-only')
  },
  overriddenBy: () => undefined,
  saved: () => undefined,
}

describe('parseSearchArgs', () => {
  test('no args opens the picker', () => {
    expect(parseSearchArgs('')).toEqual({ kind: 'picker' })
    expect(parseSearchArgs('   ')).toEqual({ kind: 'picker' })
  })

  test('status, help, and test subcommands', () => {
    expect(parseSearchArgs('status')).toEqual({ kind: 'status' })
    expect(parseSearchArgs('--help')).toEqual({ kind: 'help' })
    expect(parseSearchArgs('test')).toMatchObject({ kind: 'test' })
    expect(parseSearchArgs('test rust async traits')).toEqual({
      kind: 'test',
      query: 'rust async traits',
    })
  })

  test('a backend name selects it, case-insensitively and by alias', () => {
    expect(parseSearchArgs('EXA')).toMatchObject({
      kind: 'set',
      option: { mode: 'exa' },
      typedInline: false,
    })
    expect(parseSearchArgs('duckduckgo')).toMatchObject({ kind: 'set', option: { mode: 'ddg' } })
    expect(parseSearchArgs('builtin')).toMatchObject({ kind: 'set', option: { mode: 'native' } })
    expect(parseSearchArgs('anysearch')).toMatchObject({
      kind: 'set',
      option: { mode: 'anysearch' },
      typedInline: false,
    })
  })

  test('extra tokens after a backend are flagged as an inline key', () => {
    expect(parseSearchArgs('tavily tvly-secret')).toMatchObject({
      kind: 'set',
      option: { mode: 'tavily' },
      typedInline: true,
    })
  })

  test('key defaults to Exa and accepts any keyed backend', () => {
    expect(parseSearchArgs('key')).toMatchObject({
      kind: 'key',
      option: { mode: 'exa' },
      typedInline: false,
    })
    expect(parseSearchArgs('key brave')).toMatchObject({ kind: 'key', option: { mode: 'brave' } })
    expect(parseSearchArgs('key exa exa-secret')).toMatchObject({ kind: 'key', typedInline: true })
  })

  test('key for a backend without keys is an error', () => {
    expect(parseSearchArgs('key ddg')).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('DuckDuckGo does not take an API key'),
    })
  })

  test('key followed by a non-backend token is treated as an inline Exa key', () => {
    expect(parseSearchArgs('key exa-abc123secret')).toEqual({
      kind: 'key',
      option: expect.objectContaining({ mode: 'exa' }),
      typedInline: true,
    })
  })

  test('unknown tokens are never echoed back', () => {
    const action = parseSearchArgs('sk-looks-like-a-secret')
    expect(action).toMatchObject({ kind: 'error' })
    const message = action.kind === 'error' ? action.message : ''
    expect(message).toContain('Unknown search backend.')
    expect(message).toContain('Usage:')
    expect(message).not.toContain('sk-looks-like-a-secret')
  })

  test('remove-key defaults to Exa and rejects unknown backends without echoing', () => {
    expect(parseSearchArgs('remove-key')).toMatchObject({
      kind: 'remove-key',
      option: { mode: 'exa' },
    })
    expect(parseSearchArgs('remove-key tavily')).toMatchObject({
      kind: 'remove-key',
      option: { mode: 'tavily' },
    })
    const action = parseSearchArgs('remove-key secret-token')
    expect(action).toMatchObject({ kind: 'error' })
    expect(action.kind === 'error' && action.message).not.toContain('secret-token')
  })
})

describe('needsApiKey', () => {
  test('keyed-only backends need a key until one is set', () => {
    expect(needsApiKey(backend('tavily'))).toBe(true)
    process.env.TAVILY_API_KEY = 'tvly-test'
    expect(needsApiKey(backend('tavily'))).toBe(false)
  })

  test('Exa needs no key while the free tier is on, and keyless backends never do', () => {
    expect(needsApiKey(backend('exa'))).toBe(false)
    expect(needsApiKey(backend('ddg'))).toBe(false)
    expect(needsApiKey(backend('auto'))).toBe(false)
    expect(needsApiKey(backend('anysearch'))).toBe(false)
  })

  test('Exa needs a key when the free tier is turned off', () => {
    process.env.EXA_FREE_TIER = '0'
    expect(needsApiKey(backend('exa'))).toBe(true)
  })

  test('Ollama needs a key without an active Ollama route', () => {
    expect(needsApiKey(backend('ollama'))).toBe(true)
  })
})

describe('describeSearchStatus', () => {
  test('default setup reports the Exa free tier with DuckDuckGo as fallback', () => {
    const status = describeSearchStatus(false)
    expect(status).toContain('Web search: auto')
    expect(status).toContain('Searches go to: Exa free tier')
    expect(status).toContain('Fallbacks: DuckDuckGo')
    expect(status).toContain('/search key exa')
  })

  test('an Exa key puts keyed Exa first', () => {
    process.env.EXA_API_KEY = 'exa-test'
    const status = describeSearchStatus(false)
    expect(status).toContain('Searches go to: Exa (API key)')
    expect(status).not.toContain('/search key exa')
  })

  test('auto mode on a provider with built-in search reports it', () => {
    const status = describeSearchStatus(true)
    expect(status).toContain("model provider's built-in web search")
    expect(status).toContain('/search exa')
  })

  test('an explicit backend without its key says how to add one', () => {
    process.env.WEB_SEARCH_PROVIDER = 'tavily'
    expect(describeSearchStatus(false)).toContain(
      'Tavily is not configured — add TAVILY_API_KEY with /search key tavily.',
    )
  })

  test('an explicit AnySearch selection reports the active backend without a key', () => {
    process.env.WEB_SEARCH_PROVIDER = 'anysearch'
    expect(describeSearchStatus(false)).toContain('Searches go to: AnySearch')
  })

  test('native mode without built-in search reports searches as unavailable', () => {
    process.env.WEB_SEARCH_PROVIDER = 'native'
    expect(describeSearchStatus(false)).toContain('searches are unavailable')
  })
})

describe('applySearchSelection', () => {
  test('saves AnySearch selection without requiring an API key', () => {
    const store = recordingStore()
    const message = applySearchSelection(backend('anysearch'), undefined, false, store)

    expect(store.saves).toEqual([
      { set: { WEB_SEARCH_PROVIDER: 'anysearch' }, unset: [] },
    ])
    expect(message).toBe('Web search set to AnySearch.')
  })

  test('saves the backend and its key, and applies them to this session', () => {
    const store = recordingStore()
    const message = applySearchSelection(backend('tavily'), ' tvly-key ', false, store)

    expect(store.saves).toEqual([
      { set: { WEB_SEARCH_PROVIDER: 'tavily', TAVILY_API_KEY: 'tvly-key' }, unset: [] },
    ])
    expect(process.env.WEB_SEARCH_PROVIDER).toBe('tavily')
    expect(process.env.TAVILY_API_KEY).toBe('tvly-key')
    expect(message).toBe('Web search set to Tavily with TAVILY_API_KEY.')
  })

  test('ignores a key for a backend that takes none', () => {
    const store = recordingStore()
    applySearchSelection(backend('ddg'), 'stray', false, store)
    expect(store.saves).toEqual([{ set: { WEB_SEARCH_PROVIDER: 'ddg' }, unset: [] }])
  })

  test('a value set in a settings file wins: warn and leave the session value alone', () => {
    process.env.WEB_SEARCH_PROVIDER = 'brave'
    const store = recordingStore({
      WEB_SEARCH_PROVIDER: 'managed (policy) settings (/etc/openclaude/managed-settings.json)',
    })
    const message = applySearchSelection(backend('exa'), undefined, false, store)

    expect(process.env.WEB_SEARCH_PROVIDER).toBe('brave')
    expect(message).toStartWith('Saved Exa for future sessions, but not applied:')
    expect(message).toContain(
      'WEB_SEARCH_PROVIDER is also set in managed (policy) settings (/etc/openclaude/managed-settings.json), which takes precedence',
    )
    expect(message).not.toContain('Web search set to')
  })

  test('Exa without a key points at the free tier', () => {
    expect(applySearchSelection(backend('exa'), undefined, false, recordingStore())).toContain(
      'Using the Exa free tier',
    )
  })

  test('auto on a provider with built-in search explains the precedence', () => {
    expect(applySearchSelection(backend('auto'), undefined, true, recordingStore())).toContain(
      'auto mode uses first',
    )
  })

  test('native without built-in search warns', () => {
    expect(applySearchSelection(backend('native'), undefined, false, recordingStore())).toContain(
      'searches will be unavailable',
    )
  })

  test('reports a save failure and leaves the session unchanged', () => {
    const message = applySearchSelection(backend('exa'), undefined, false, failingStore)
    expect(message).toBe('Failed to save web search settings: read-only')
    expect(process.env.WEB_SEARCH_PROVIDER).toBeUndefined()
  })
})

describe('saveSearchApiKey', () => {
  test('stores only the key', () => {
    const store = recordingStore()
    saveSearchApiKey(backend('exa'), ' exa-key ', false, store)
    expect(store.saves).toEqual([{ set: { EXA_API_KEY: 'exa-key' }, unset: [] }])
    expect(process.env.EXA_API_KEY).toBe('exa-key')
  })

  test('in auto mode, an Exa key takes effect immediately', () => {
    expect(saveSearchApiKey(backend('exa'), 'exa-key', false, recordingStore())).toBe(
      'Saved EXA_API_KEY. Exa now runs with your key.',
    )
  })

  test('with built-in search active, says the key is not used yet', () => {
    expect(saveSearchApiKey(backend('exa'), 'exa-key', true, recordingStore())).toContain(
      "Searches still use the model provider's built-in web search — run /search exa",
    )
  })

  test('for another backend, says how to select it', () => {
    expect(saveSearchApiKey(backend('brave'), 'brv-key', false, recordingStore())).toContain(
      'Run /search brave to use only Brave',
    )
  })

  test('does not claim the key is in use when a settings file overrides it', () => {
    process.env.EXA_API_KEY = 'exa-from-settings'
    const store = recordingStore({ EXA_API_KEY: 'user settings (~/.openclaude/settings.json)' })
    const message = saveSearchApiKey(backend('exa'), 'exa-new', false, store)

    expect(process.env.EXA_API_KEY).toBe('exa-from-settings')
    expect(message).toStartWith('Saved EXA_API_KEY for future sessions, but not applied:')
    expect(message).not.toContain('now runs with your key')
  })
})

describe('removeSearchApiKey', () => {
  test('unsets the saved key and clears it from the session', () => {
    process.env.EXA_API_KEY = 'exa-old'
    const store = recordingStore({}, { EXA_API_KEY: 'exa-old' })
    const message = removeSearchApiKey(backend('exa'), store)

    expect(store.saves).toEqual([{ set: {}, unset: ['EXA_API_KEY'] }])
    expect(process.env.EXA_API_KEY).toBeUndefined()
    expect(message).toBe('Removed the saved EXA_API_KEY.')
  })

  test('warns when removing the key of the selected backend leaves it unusable', () => {
    process.env.WEB_SEARCH_PROVIDER = 'tavily'
    process.env.TAVILY_API_KEY = 'tvly-old'
    const store = recordingStore({}, { TAVILY_API_KEY: 'tvly-old' })
    const message = removeSearchApiKey(backend('tavily'), store)

    expect(process.env.TAVILY_API_KEY).toBeUndefined()
    expect(message).toContain('Removed the saved TAVILY_API_KEY.')
    expect(message).toContain('still set to Tavily, which no longer works without a key')
    expect(message).toContain('/search auto')
  })

  test('does not warn when the selected backend still works without the key', () => {
    process.env.WEB_SEARCH_PROVIDER = 'exa'
    process.env.EXA_API_KEY = 'exa-old'
    const message = removeSearchApiKey(backend('exa'), recordingStore({}, { EXA_API_KEY: 'exa-old' }))

    expect(message).toBe('Removed the saved EXA_API_KEY.')
  })

  test('says so when the key was never saved by /search', () => {
    process.env.EXA_API_KEY = 'exa-from-shell'
    const store = recordingStore()
    const message = removeSearchApiKey(backend('exa'), store)

    expect(store.saves).toEqual([])
    expect(process.env.EXA_API_KEY).toBe('exa-from-shell')
    expect(message).toContain('comes from your shell environment')
  })

  test('points at the settings file when the key comes from one', () => {
    const store = recordingStore({ EXA_API_KEY: 'user settings (~/.openclaude/settings.json)' })
    expect(removeSearchApiKey(backend('exa'), store)).toBe(
      'No EXA_API_KEY is saved by /search; it comes from user settings (~/.openclaude/settings.json).',
    )
  })

  test('reports nothing to remove', () => {
    expect(removeSearchApiKey(backend('exa'), recordingStore())).toBe('No EXA_API_KEY is saved.')
  })
})

describe('globalConfigSearchEnvStore', () => {
  // bun test runs with NODE_ENV=test, so saveGlobalConfig writes in memory.
  const originalEnvBlock = getGlobalConfig().env

  afterEach(() => {
    saveGlobalConfig(config => ({ ...config, env: originalEnvBlock }))
  })

  test('merges into the global config env block and removes unset keys', () => {
    saveGlobalConfig(config => ({ ...config, env: { KEEP_ME: '1', EXA_API_KEY: 'old' } }))

    globalConfigSearchEnvStore.save({ WEB_SEARCH_PROVIDER: 'exa' }, ['EXA_API_KEY'])

    expect(getGlobalConfig().env).toEqual({ KEEP_ME: '1', WEB_SEARCH_PROVIDER: 'exa' })
    expect(globalConfigSearchEnvStore.saved('WEB_SEARCH_PROVIDER')).toBe('exa')
    expect(globalConfigSearchEnvStore.saved('EXA_API_KEY')).toBeUndefined()
  })
})

describe('findSettingsEnvOverride', () => {
  let configDir: string
  const originalAllowed = getAllowedSettingSources()

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'openclaude-search-settings-'))
    setClaudeConfigHomeDirForTesting(configDir)
    resetSettingsCache()
  })

  afterEach(() => {
    setAllowedSettingSources(originalAllowed)
    setClaudeConfigHomeDirForTesting(undefined)
    resetSettingsCache()
    rmSync(configDir, { recursive: true, force: true })
  })

  function writeUserSettings(env: Record<string, string>): void {
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ env }))
    resetSettingsCache()
  }

  test('reports a user settings.json env entry with its path', () => {
    writeUserSettings({ EXA_API_KEY: 'from-settings' })

    const source = findSettingsEnvOverride('EXA_API_KEY')
    expect(source).toStartWith('user settings (')
    expect(source).toContain(join(configDir, 'settings.json'))
    expect(findSettingsEnvOverride('WEB_SEARCH_PROVIDER')).toBeUndefined()
  })

  test('ignores sources that are disabled for this session', () => {
    writeUserSettings({ EXA_API_KEY: 'from-settings' })
    setAllowedSettingSources(['projectSettings'])

    expect(findSettingsEnvOverride('EXA_API_KEY')).toBeUndefined()
  })
})

describe('runSearchTest', () => {
  const output: ProviderOutput = {
    hits: [{ title: 'Node.js 24', url: 'https://nodejs.org/en/blog/release' }],
    providerName: 'exa-free',
    durationSeconds: 1.234,
  }

  test('uses the selected AnySearch backend through the normal test entry', async () => {
    process.env.WEB_SEARCH_PROVIDER = 'anysearch'
    let requestedUrl = ''
    globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      requestedUrl = String(input)
      return new Response(JSON.stringify({
        code: 0,
        data: { results: [{ title: 'Any result', url: 'https://example.com/result' }] },
      }), { status: 200 })
    }) as typeof fetch

    const message = await runSearchTest('any query', false)

    expect(requestedUrl).toBe('https://api.anysearch.com/v1/search')
    expect(message).toContain('Search OK via AnySearch: 1 results')
    expect(message).toContain('Top result: Any result — https://example.com/result')
  })

  test('reports the backend, count, timing, and top result', async () => {
    let query = ''
    const message = await runSearchTest('node release', false, async input => {
      query = input.query
      return output
    })
    expect(query).toBe('node release')
    expect(message).toContain('Search OK via Exa free tier: 1 results in 1.2s')
    expect(message).toContain('Top result: Node.js 24 — https://nodejs.org/en/blog/release')
  })

  test('reports failures with the backend error', async () => {
    const message = await runSearchTest('q', false, async () => {
      throw new Error('Exa free tier limit reached')
    })
    expect(message).toBe('Search failed for "q": Exa free tier limit reached')
  })

  test('explains unavailable search in native mode without built-in search', async () => {
    process.env.WEB_SEARCH_PROVIDER = 'native'
    let ran = false
    const message = await runSearchTest('q', false, async () => {
      ran = true
      return output
    })
    expect(ran).toBe(false)
    expect(message).toContain('searches are unavailable')
    expect(message).toContain('/search auto')
  })

  test('does not run when the built-in search handles searches', async () => {
    let ran = false
    const message = await runSearchTest('q', true, async () => {
      ran = true
      return output
    })
    expect(ran).toBe(false)
    expect(message).toContain('built-in web search')
  })
})
