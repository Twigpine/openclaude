/**
 * Logic behind /search: the backend catalog, argument parsing, status text,
 * and persistence.
 *
 * Selections (WEB_SEARCH_PROVIDER and backend API keys) are saved to the
 * `env` block of the global config (~/.openclaude.json, written with 0600
 * permissions — the file /provider and /ads also keep credentials in) rather
 * than settings.json, which is world-readable and often committed to dotfiles.
 * The global config env is applied to process.env first at startup, so any
 * settings.json `env` entry for the same variable (user, project, flag, or
 * policy) overrides it. Changes are mirrored into process.env so they take
 * effect immediately, except for variables a settings file overrides — those
 * keep the overriding value, matching what the next launch will do.
 */

import {
  getProviderChain,
  getProviderMode,
  runSearch,
  type ProviderMode,
  type ProviderOutput,
  type SearchInput,
} from '../../tools/WebSearchTool/providers/index.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import {
  isSettingSourceEnabled,
  type SettingSource,
} from '../../utils/settings/constants.js'
import {
  getSettingsFilePathForSource,
  getSettingsForSource,
} from '../../utils/settings/settings.js'

export interface SearchBackendOption {
  mode: ProviderMode
  label: string
  description: string
  /** Env var holding this backend's API key, when it takes one. */
  keyEnv?: string
  /** True when the backend also works without its key. */
  keyOptional?: boolean
}

export const SEARCH_BACKENDS: readonly SearchBackendOption[] = [
  {
    mode: 'auto',
    label: 'Auto (recommended)',
    description: 'Exa first, then any backend you configured, then free fallbacks',
  },
  {
    mode: 'exa',
    label: 'Exa',
    keyEnv: 'EXA_API_KEY',
    keyOptional: true,
    description: 'Exa only — free tier without a key, higher limits with one',
  },
  { mode: 'tavily', label: 'Tavily', keyEnv: 'TAVILY_API_KEY', description: 'Tavily only' },
  {
    mode: 'brave',
    label: 'Brave',
    keyEnv: 'BRAVE_API_KEY',
    description: 'Brave Search only (independent index)',
  },
  { mode: 'firecrawl', label: 'Firecrawl', keyEnv: 'FIRECRAWL_API_KEY', description: 'Firecrawl only' },
  { mode: 'you', label: 'You.com', keyEnv: 'YOU_API_KEY', description: 'You.com only' },
  { mode: 'jina', label: 'Jina', keyEnv: 'JINA_API_KEY', description: 'Jina only' },
  { mode: 'linkup', label: 'Linkup', keyEnv: 'LINKUP_API_KEY', description: 'Linkup only' },
  { mode: 'mojeek', label: 'Mojeek', keyEnv: 'MOJEEK_API_KEY', description: 'Mojeek only' },
  { mode: 'bing', label: 'Bing', keyEnv: 'BING_API_KEY', description: 'Bing only' },
  {
    mode: 'ollama',
    label: 'Ollama',
    keyEnv: 'OLLAMA_API_KEY',
    keyOptional: true,
    description: 'Active Ollama route, or hosted Ollama with an API key',
  },
  {
    mode: 'ddg',
    label: 'DuckDuckGo',
    description: 'No key needed; scraped and heavily rate-limited',
  },
  {
    mode: 'native',
    label: 'Built-in search',
    description: "The model provider's own search (Anthropic, Vertex, Foundry, Codex)",
  },
]

const BACKEND_ALIASES: Record<string, ProviderMode> = {
  duckduckgo: 'ddg',
  builtin: 'native',
  'built-in': 'native',
}

const BACKEND_DISPLAY_NAMES: Record<string, string> = {
  exa: 'Exa (API key)',
  'exa-free': 'Exa free tier',
  ollama: 'Ollama',
  firecrawl: 'Firecrawl',
  tavily: 'Tavily',
  you: 'You.com',
  jina: 'Jina',
  brave: 'Brave',
  bing: 'Bing',
  mojeek: 'Mojeek',
  linkup: 'Linkup',
  duckduckgo: 'DuckDuckGo',
  custom: 'Custom API',
}

export const DEFAULT_TEST_QUERY = 'latest stable Node.js release'

export function findSearchBackend(name: string): SearchBackendOption | undefined {
  const normalized = name.trim().toLowerCase()
  const mode = BACKEND_ALIASES[normalized] ?? normalized
  return SEARCH_BACKENDS.find(b => b.mode === mode)
}

/** Human-readable name for a runtime search provider name. */
export function displayBackendName(providerName: string): string {
  return BACKEND_DISPLAY_NAMES[providerName] ?? providerName
}

export function hasApiKey(option: SearchBackendOption): boolean {
  return Boolean(option.keyEnv && process.env[option.keyEnv]?.trim())
}

/** True when selecting this backend would work with the current env. */
export function isBackendReady(option: SearchBackendOption): boolean {
  if (option.mode === 'auto' || option.mode === 'native') return true
  return getProviderChain(option.mode)[0]?.isConfigured() ?? false
}

/**
 * A backend that cannot run until it gets an API key — keyed-only backends
 * without one, and key-optional ones whose keyless path is unavailable (Exa
 * with EXA_FREE_TIER=0, Ollama without an active Ollama route).
 */
export function needsApiKey(option: SearchBackendOption): boolean {
  return Boolean(option.keyEnv) && !isBackendReady(option)
}

/** True when built-in search handles searches instead of the adapters. */
function usesBuiltInSearch(nativeSearchAvailable: boolean): boolean {
  const mode = getProviderMode()
  return mode === 'native' || (mode === 'auto' && nativeSearchAvailable)
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export type SearchCommandAction =
  | { kind: 'picker' }
  | { kind: 'status' }
  | { kind: 'help' }
  | { kind: 'test'; query: string }
  | { kind: 'set'; option: SearchBackendOption; typedInline: boolean }
  | { kind: 'key'; option: SearchBackendOption; typedInline: boolean }
  | { kind: 'remove-key'; option: SearchBackendOption }
  | { kind: 'error'; message: string }

const KEYED_BACKENDS = SEARCH_BACKENDS.filter(b => b.keyEnv).map(b => b.mode)

export const SEARCH_HELP = [
  'Usage:',
  '  /search                     Pick a web search backend',
  '  /search status              Show which backend handles searches',
  '  /search <backend>           Use a backend (auto, exa, tavily, brave, …)',
  '  /search key [backend]       Add or replace an API key (default: exa)',
  '  /search remove-key [backend] Remove a saved API key (default: exa)',
  '  /search test [query]        Run a test search',
  '',
  `Backends: ${SEARCH_BACKENDS.map(b => b.mode).join(', ')}`,
].join('\n')

/**
 * Parse /search arguments. Unrecognized tokens are never echoed back: a token
 * that isn't a backend name may be an API key pasted in the wrong place.
 */
export function parseSearchArgs(args: string): SearchCommandAction {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const sub = (parts[0] ?? '').toLowerCase()

  if (!sub) return { kind: 'picker' }
  if (sub === 'status') return { kind: 'status' }
  if (sub === 'help' || sub === '-h' || sub === '--help') return { kind: 'help' }
  if (sub === 'test') {
    return { kind: 'test', query: parts.slice(1).join(' ') || DEFAULT_TEST_QUERY }
  }

  if (sub === 'key' || sub === 'remove-key') {
    const named = parts[1] ? findSearchBackend(parts[1]) : findSearchBackend('exa')
    if (named && !named.keyEnv) {
      return {
        kind: 'error',
        message: `${named.label} does not take an API key. Backends with keys: ${KEYED_BACKENDS.join(', ')}`,
      }
    }
    if (sub === 'remove-key') {
      if (!named) {
        return {
          kind: 'error',
          message: `Unknown search backend. Backends with keys: ${KEYED_BACKENDS.join(', ')}`,
        }
      }
      return { kind: 'remove-key', option: named }
    }
    if (named) return { kind: 'key', option: named, typedInline: parts.length > 2 }
    // `/search key <something-not-a-backend>` is most likely an Exa key
    // typed inline: open the Exa key dialog with the rotate warning.
    const exa = findSearchBackend('exa')
    if (exa) return { kind: 'key', option: exa, typedInline: true }
  }

  const option = findSearchBackend(sub)
  if (!option) {
    return { kind: 'error', message: `Unknown search backend.\n\n${SEARCH_HELP}` }
  }
  return { kind: 'set', option, typedInline: parts.length > 1 }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Describe where searches go right now. `nativeSearchAvailable` is whether
 * the active model provider has built-in web search, which auto mode prefers.
 */
export function describeSearchStatus(nativeSearchAvailable: boolean): string {
  const mode = getProviderMode()
  const lines = [`Web search: ${mode}`]

  if (usesBuiltInSearch(nativeSearchAvailable)) {
    if (!nativeSearchAvailable) {
      lines.push(
        'This model provider has no built-in web search, so searches are unavailable.',
        'Run /search auto to use Exa.',
      )
      return lines.join('\n')
    }
    lines.push("Searches go to: the model provider's built-in web search")
    if (mode === 'auto') lines.push('Run /search exa to use Exa instead.')
    return lines.join('\n')
  }

  const chain = getProviderChain(mode)
  const [first, ...fallbacks] = chain
  if (!first) {
    lines.push('No search backend is available.')
    return lines.join('\n')
  }
  if (mode !== 'auto' && !first.isConfigured()) {
    const option = findSearchBackend(mode)
    const keyHint = option?.keyEnv
      ? ` — add ${option.keyEnv} with /search key ${mode}`
      : ''
    lines.push(`${displayBackendName(first.name)} is not configured${keyHint}.`)
    return lines.join('\n')
  }

  lines.push(`Searches go to: ${displayBackendName(first.name)}`)
  if (fallbacks.length > 0) {
    lines.push(`Fallbacks: ${fallbacks.map(p => displayBackendName(p.name)).join(' → ')}`)
  }
  if (first.name === 'exa-free') {
    lines.push(
      'The free tier has a per-second and daily limit. Add an Exa API key with /search key exa.',
    )
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface SearchEnvStore {
  /** Persist env changes for future sessions; throws when they did not stick. */
  save(set: Record<string, string>, unset: readonly string[]): void
  /** The settings file that overrides a saved value at startup, if any. */
  overriddenBy(key: string): string | undefined
  /** The currently saved value for a key, if any. */
  saved(key: string): string | undefined
}

// Highest precedence first, matching the settings merge order.
const SETTINGS_ENV_SOURCES: ReadonlyArray<[SettingSource, string]> = [
  ['policySettings', 'managed (policy) settings'],
  ['flagSettings', 'the --settings flag'],
  ['localSettings', 'local project settings'],
  ['projectSettings', 'project settings'],
  ['userSettings', 'user settings'],
]

export function findSettingsEnvOverride(key: string): string | undefined {
  for (const [source, label] of SETTINGS_ENV_SOURCES) {
    // Startup only applies env from enabled sources (--setting-sources).
    if (!isSettingSourceEnabled(source)) continue
    if (getSettingsForSource(source)?.env?.[key] === undefined) continue
    const path = getSettingsFilePathForSource(source)
    return path ? `${label} (${path})` : label
  }
  return undefined
}

export const globalConfigSearchEnvStore: SearchEnvStore = {
  save(set, unset) {
    saveGlobalConfig(config => {
      const env = { ...config.env, ...set }
      for (const key of unset) delete env[key]
      return { ...config, env }
    })
    // saveGlobalConfig swallows permission errors and refuses writes that
    // would drop auth state, so confirm the change actually landed.
    const env = getGlobalConfig().env ?? {}
    const stuck =
      Object.entries(set).every(([key, value]) => env[key] === value) &&
      unset.every(key => env[key] === undefined)
    if (!stuck) {
      throw new Error('the global config (~/.openclaude.json) could not be written')
    }
  },
  overriddenBy: findSettingsEnvOverride,
  saved: key => getGlobalConfig().env?.[key],
}

/**
 * Persist env changes and apply them to this session. Returns warnings for
 * variables that a settings file overrides (those are left untouched in
 * process.env), or throws if the save fails.
 */
function persistSearchEnv(
  set: Record<string, string>,
  unset: readonly string[],
  store: SearchEnvStore,
): string[] {
  store.save(set, unset)
  const warnings: string[] = []
  for (const key of [...Object.keys(set), ...unset]) {
    const source = store.overriddenBy(key)
    if (source) {
      warnings.push(
        `${key} is also set in ${source}, which takes precedence — change or remove it there for this to take effect.`,
      )
      continue
    }
    const value = set[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return warnings
}

function saveFailure(err: unknown): string {
  return `Failed to save web search settings: ${err instanceof Error ? err.message : String(err)}`
}

/** Select a backend (and optionally store its API key). Returns the message to show. */
export function applySearchSelection(
  option: SearchBackendOption,
  apiKey: string | undefined,
  nativeSearchAvailable: boolean,
  store: SearchEnvStore = globalConfigSearchEnvStore,
): string {
  const set: Record<string, string> = { WEB_SEARCH_PROVIDER: option.mode }
  const key = apiKey?.trim()
  if (key && option.keyEnv) set[option.keyEnv] = key

  let warnings: string[]
  try {
    warnings = persistSearchEnv(set, [], store)
  } catch (err) {
    return saveFailure(err)
  }

  const withKey = key && option.keyEnv ? ` with ${option.keyEnv}` : ''
  const lines =
    warnings.length > 0
      ? [`Saved ${option.label}${withKey} for future sessions, but not applied:`, ...warnings]
      : [`Web search set to ${option.label}${withKey}.`]
  if (warnings.length > 0) return lines.join('\n')
  if (option.mode === 'exa' && !hasApiKey(option)) {
    lines.push('Using the Exa free tier — add a key for higher limits with /search key exa.')
  }
  if (option.mode === 'auto' && nativeSearchAvailable) {
    lines.push('This model provider has built-in web search, which auto mode uses first.')
  }
  if (option.mode === 'native' && !nativeSearchAvailable) {
    lines.push('This model provider has no built-in web search — searches will be unavailable.')
  }
  return lines.join('\n')
}

/** Store an API key without changing the selected backend. */
export function saveSearchApiKey(
  option: SearchBackendOption,
  apiKey: string,
  nativeSearchAvailable: boolean,
  store: SearchEnvStore = globalConfigSearchEnvStore,
): string {
  if (!option.keyEnv) return `${option.label} does not take an API key.`

  let warnings: string[]
  try {
    warnings = persistSearchEnv({ [option.keyEnv]: apiKey.trim() }, [], store)
  } catch (err) {
    return saveFailure(err)
  }

  if (warnings.length > 0) {
    return [`Saved ${option.keyEnv} for future sessions, but not applied:`, ...warnings].join('\n')
  }
  const saved = `Saved ${option.keyEnv}.`
  let next: string
  if (usesBuiltInSearch(nativeSearchAvailable)) {
    next = `Searches still use the model provider's built-in web search — run /search ${option.mode} to use ${option.label}.`
  } else if (getProviderMode() === option.mode) {
    next = `${option.label} now uses your key.`
  } else if (option.mode === 'exa' && getProviderMode() === 'auto') {
    next = 'Exa now runs with your key.'
  } else {
    next = `Run /search ${option.mode} to use only ${option.label}.`
  }
  return `${saved} ${next}`
}

/** Remove a saved API key. */
export function removeSearchApiKey(
  option: SearchBackendOption,
  store: SearchEnvStore = globalConfigSearchEnvStore,
): string {
  if (!option.keyEnv) return `${option.label} does not take an API key.`
  const key = option.keyEnv

  if (store.saved(key) === undefined) {
    const source = store.overriddenBy(key)
    if (source) return `No ${key} is saved by /search; it comes from ${source}.`
    if (process.env[key]) {
      return `No ${key} is saved by /search; it comes from your shell environment, so it will be back next launch.`
    }
    return `No ${key} is saved.`
  }

  let warnings: string[]
  try {
    warnings = persistSearchEnv({}, [key], store)
  } catch (err) {
    return saveFailure(err)
  }
  const lines = [`Removed the saved ${key}.`, ...warnings]
  if (warnings.length === 0 && getProviderMode() === option.mode && !isBackendReady(option)) {
    lines.push(
      `Web search is still set to ${option.label}, which no longer works without a key — run /search auto to restore fallbacks.`,
    )
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Test search
// ---------------------------------------------------------------------------

export async function runSearchTest(
  query: string,
  nativeSearchAvailable: boolean,
  run: (input: SearchInput, signal?: AbortSignal) => Promise<ProviderOutput> = runSearch,
  signal?: AbortSignal,
): Promise<string> {
  if (usesBuiltInSearch(nativeSearchAvailable)) {
    if (!nativeSearchAvailable) {
      return (
        'Web search is set to the built-in search, but this model provider has none — ' +
        'searches are unavailable. Run /search auto to use Exa.'
      )
    }
    return (
      "Searches use the model provider's built-in web search, which /search test cannot run. " +
      'Ask for a web search in chat to check it, or run /search exa to switch to Exa.'
    )
  }

  try {
    const output = await run({ query }, signal)
    const backend = displayBackendName(output.providerName)
    const seconds = output.durationSeconds.toFixed(1)
    const top = output.hits[0]
    return [
      `Search OK via ${backend}: ${output.hits.length} results in ${seconds}s for "${query}".`,
      ...(top ? [`Top result: ${top.title} — ${top.url}`] : []),
    ].join('\n')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return `Search failed for "${query}": ${message}`
  }
}
