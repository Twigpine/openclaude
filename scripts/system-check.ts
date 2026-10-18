// @ts-nocheck
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  resolveCodexApiCredentials,
  resolveProviderRequest,
  isLocalProviderUrl as isProviderLocalUrl,
} from '../src/services/api/providerConfig.js'
import {
  getRouteCredentialEnvVars,
  getRouteCredentialValue,
  resolveActiveRouteIdFromEnv,
  resolveRouteIdFromBaseUrl,
} from '../src/integrations/routeMetadata.js'
import {
  getLocalOpenAICompatibleProviderLabel,
  probeOllamaGenerationReadiness,
} from '../src/utils/providerDiscovery.js'
import {
  DEFAULT_GEMINI_MODEL,
  resolveOpenAICredentialEnvState,
} from '../src/utils/providerProfile.js'
import {
  redactSecretValueForDisplay,
  redactSecretSubstringsForDisplay,
  type SecretValueSource,
} from '../src/utils/providerSecrets.js'
import { redactUrlForDisplay } from '../src/utils/redaction.js'
import {
  MIN_NODE_ENGINE_RANGE,
  checkSupportedNodeVersion,
} from '../src/utils/nodeRuntime.js'
import { SandboxManager } from '../src/utils/sandbox/sandbox-adapter.js'
import {
  DEFAULT_MAX_ACTIVE_MESSAGES_HARD_CAP,
  getMaxActiveMessagesHardCap,
} from '../src/utils/maxActiveMessages.js'
import {
  isValidMaxMessagesCompactionThreshold,
  normalizeMaxMessagesCompactionThreshold,
} from '../src/utils/config.js'
import {
  getAvailableProviders,
  getProviderChain,
  getProviderMode,
  type ProviderMode,
} from '../src/tools/WebSearchTool/providers/index.js'
import {
  getUsableOllamaApiKey,
  getUsableOllamaBaseUrlEnvValue,
  isOllamaWebSearchBaseUrl,
} from '../src/tools/WebSearchTool/providers/ollama.js'
import { getWebSearchTimeoutMs } from '../src/tools/WebSearchTool/providers/timeout.js'
import { isFirecrawlCloudApiUrl } from '../src/tools/firecrawl/client.js'
import { getAPIProvider } from '../src/utils/model/providers.js'
import { getMainLoopModel } from '../src/utils/model/model.js'

type CheckResult = {
  ok: boolean
  label: string
  detail?: string
}

type MemoryGuardConfigInput = {
  autoCompactEnabled: boolean
  maxMessagesCompactionThreshold?: string
  env?: NodeJS.ProcessEnv
}

type NodeExecutableVersionProbe =
  | {
    ok: true
    version: string
  }
  | {
    ok: false
    detail: string
  }

type CliOptions = {
  json: boolean
  outFile: string | null
}

function pass(label: string, detail?: string): CheckResult {
  return { ok: true, label, detail }
}

function fail(label: string, detail?: string): CheckResult {
  return { ok: false, label, detail }
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'no'
}

function parsePositiveInteger(value: string | undefined): number {
  if (!value) return 0
  const trimmed = value.trim()
  if (!/^[1-9]\d*$/.test(trimmed)) return 0
  const parsed = Number.parseInt(trimmed, 10)
  return Number.isSafeInteger(parsed) ? parsed : 0
}

function formatActiveHardCapDetail(
  hardCap: number,
  rawOverride: string | undefined,
): string {
  if (rawOverride === undefined) {
    return `Active at ${hardCap} messages (default; malformed overrides fall back to ${DEFAULT_MAX_ACTIVE_MESSAGES_HARD_CAP}).`
  }
  if (parsePositiveInteger(rawOverride) > 0) {
    return `Active at ${hardCap} messages.`
  }
  return `Active at ${hardCap} messages; malformed override fell back to ${DEFAULT_MAX_ACTIVE_MESSAGES_HARD_CAP}.`
}

export function buildMemoryGuardChecks(
  input: MemoryGuardConfigInput,
): CheckResult[] {
  const env = input.env ?? process.env
  const results: CheckResult[] = []
  const disableCompact = isTruthy(env.DISABLE_COMPACT)
  const disableAutoCompact = isTruthy(env.DISABLE_AUTO_COMPACT)
  const autoCompactAvailable =
    input.autoCompactEnabled && !disableCompact && !disableAutoCompact
  const hardCapOverride = env.OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP
  const hardCap = getMaxActiveMessagesHardCap(env)
  const legacyLimit = parsePositiveInteger(env.OPENCLAUDE_MAX_ACTIVE_MESSAGES)
  const configuredLimit =
    ((input.maxMessagesCompactionThreshold === undefined ||
      input.maxMessagesCompactionThreshold === 'off') &&
      legacyLimit > 0)
      ? legacyLimit
      : normalizeMaxMessagesCompactionThreshold(
          input.maxMessagesCompactionThreshold,
        )
  const hasExplicitMessageCountGuard =
    input.maxMessagesCompactionThreshold !== undefined &&
    isValidMaxMessagesCompactionThreshold(
      input.maxMessagesCompactionThreshold,
    ) &&
    input.maxMessagesCompactionThreshold !== 'off'
  const hasLegacyMessageCountGuard =
    (input.maxMessagesCompactionThreshold === undefined ||
      input.maxMessagesCompactionThreshold === 'off') &&
    legacyLimit > 0
  const memoryBudget = parsePositiveInteger(env.OPENCLAUDE_MAX_MEMORY_MB) || 1536
  const hasIndependentMessageCountGuard =
    configuredLimit !== 'off' &&
    (hasExplicitMessageCountGuard || hasLegacyMessageCountGuard)
  const autoCompactDisabledReason =
    [
      input.autoCompactEnabled ? undefined : 'settings disabled',
      disableCompact ? 'DISABLE_COMPACT is set' : undefined,
      disableAutoCompact ? 'DISABLE_AUTO_COMPACT is set' : undefined,
    ].filter(Boolean).join('; ') || 'Disabled by configuration.'

  results.push(
    autoCompactAvailable
      ? pass(
          'Auto-compact guard',
          `Enabled; message-count threshold ${configuredLimit}; hard cap ${hardCap === 0 ? 'disabled' : hardCap}.`,
        )
      : fail(
          'Auto-compact guard',
          autoCompactDisabledReason +
            (hasIndependentMessageCountGuard
              ? `; message-count threshold ${configuredLimit} remains active.`
              : ''),
        ),
  )

  results.push(
    hardCap === 0
      ? fail(
          'Active-message hard cap',
          'Disabled by OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP=0; long sessions can grow without the active-message safety cap.',
        )
      : pass(
          'Active-message hard cap',
          formatActiveHardCapDetail(hardCap, hardCapOverride),
        ),
  )

  results.push(
    pass(
      'Memory pressure guard',
      `Per-session budget ${memoryBudget}MB; elevated/critical compaction thresholds are derived from this budget at runtime.`,
    ),
  )

  return results
}

const WEB_SEARCH_API_PROVIDER_NAMES = new Set([
  'ollama',
  'firecrawl',
  'tavily',
  'exa',
  'you',
  'jina',
  'brave',
  'bing',
  'mojeek',
  'linkup',
])

const WEB_SEARCH_RELIABLE_BACKEND_ENV_HINT =
  'OLLAMA_BASE_URL, OLLAMA_API_KEY, FIRECRAWL_API_KEY, TAVILY_API_KEY, EXA_API_KEY, YOU_API_KEY, JINA_API_KEY, BRAVE_API_KEY, BING_API_KEY, MOJEEK_API_KEY, or LINKUP_API_KEY'

const WEB_SEARCH_PROVIDER_ENV_VARS: Record<
  Exclude<ProviderMode, 'auto' | 'native'>,
  string[]
> = {
  custom: ['WEB_SEARCH_API', 'WEB_PROVIDER', 'WEB_URL_TEMPLATE'],
  ollama: ['OLLAMA_BASE_URL', 'OLLAMA_API_KEY'],
  firecrawl: ['FIRECRAWL_API_KEY', 'FIRECRAWL_API_URL'],
  ddg: [],
  tavily: ['TAVILY_API_KEY'],
  exa: ['EXA_API_KEY'],
  you: ['YOU_API_KEY'],
  jina: ['JINA_API_KEY'],
  brave: ['BRAVE_API_KEY'],
  bing: ['BING_API_KEY'],
  mojeek: ['MOJEEK_API_KEY'],
  linkup: ['LINKUP_API_KEY'],
}

const WEB_SEARCH_CUSTOM_PRESET_REQUIRED_ENV_VARS: Record<string, string[]> = {
  google: ['WEB_KEY', 'GOOGLE_CSE_ID'],
  brave: ['WEB_KEY'],
  serpapi: ['WEB_KEY'],
  searxng: [],
}

function formatEnvVarList(envVars: string[]): string {
  if (envVars.length <= 1) return envVars[0] ?? ''
  if (envVars.length === 2) return `${envVars[0]} or ${envVars[1]}`
  return `${envVars.slice(0, -1).join(', ')}, or ${envVars[envVars.length - 1]}`
}

function formatAndList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? ''
  if (values.length === 2) return `${values[0]} and ${values[1]}`
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`
}

function formatDuckDuckGoReliabilityDetail(providerMode: string): string {
  return `${providerMode}; DuckDuckGo selected. DuckDuckGo scraping can be rate-limited from datacenter/VPN/repeated-request networks. Configure ${WEB_SEARCH_RELIABLE_BACKEND_ENV_HINT} for reliable search.`
}

function vertexModelSupportsNativeWebSearch(model: string): boolean {
  return (
    model.includes('claude-opus-4') ||
    model.includes('claude-sonnet-4') ||
    model.includes('claude-haiku-4')
  )
}

function isCodexResponsesWebSearchEnabledForDoctor(): boolean {
  const request = resolveProviderRequest({
    model: getMainLoopModel(),
    baseUrl: process.env.OPENAI_BASE_URL,
  })
  return request.transport === 'codex_responses'
}

function buildNativeWebSearchCheck(): CheckResult {
  const provider = getAPIProvider()

  if (provider === 'openai' && isCodexResponsesWebSearchEnabledForDoctor()) {
    return pass(
      'Web search backend',
      'WEB_SEARCH_PROVIDER=native selected; Codex responses provider supports web search.',
    )
  }

  if (provider === 'firstParty' || provider === 'foundry') {
    return pass(
      'Web search backend',
      `WEB_SEARCH_PROVIDER=native selected; ${provider} provider supports native web search.`,
    )
  }

  if (provider === 'vertex') {
    const model = getMainLoopModel()
    if (vertexModelSupportsNativeWebSearch(model)) {
      return pass(
        'Web search backend',
        `WEB_SEARCH_PROVIDER=native selected; vertex provider supports native web search for ${safeDisplayValue(model, 'the active model')}.`,
      )
    }
    return fail(
      'Web search backend',
      `WEB_SEARCH_PROVIDER=native selected, but vertex model ${safeDisplayValue(model, 'the active model')} does not support native web search. Use a Claude 4 Vertex model or configure ${WEB_SEARCH_RELIABLE_BACKEND_ENV_HINT}.`,
    )
  }

  return fail(
    'Web search backend',
    `WEB_SEARCH_PROVIDER=native selected, but ${provider} provider does not support native web search. Configure ${WEB_SEARCH_RELIABLE_BACKEND_ENV_HINT}, or switch to an Anthropic, Vertex, Foundry, or Codex responses provider.`,
  )
}

function buildAutoNativeWebSearchCheck(): CheckResult | undefined {
  const provider = getAPIProvider()

  if (provider === 'openai' && isCodexResponsesWebSearchEnabledForDoctor()) {
    return pass(
      'Web search backend',
      'WEB_SEARCH_PROVIDER=auto; Codex responses web search will be used before adapter providers.',
    )
  }

  if (provider === 'firstParty' || provider === 'foundry') {
    return pass(
      'Web search backend',
      `WEB_SEARCH_PROVIDER=auto; ${provider} native web search will be used before adapter providers.`,
    )
  }

  if (provider === 'vertex') {
    const model = getMainLoopModel()
    if (vertexModelSupportsNativeWebSearch(model)) {
      return pass(
        'Web search backend',
        `WEB_SEARCH_PROVIDER=auto; vertex native web search will be used before adapter providers for ${safeDisplayValue(model, 'the active model')}.`,
      )
    }
    return fail(
      'Web search backend',
      `WEB_SEARCH_PROVIDER=auto selected, but vertex model ${safeDisplayValue(model, 'the active model')} does not support native web search and runtime will not use adapter providers in auto mode. Use a Claude 4 Vertex model or set an explicit WEB_SEARCH_PROVIDER adapter mode with ${WEB_SEARCH_RELIABLE_BACKEND_ENV_HINT}.`,
    )
  }

  return undefined
}

function getConfiguredWebSearchApiProviderNames(): string[] {
  return getAvailableProviders()
    .map(provider => provider.name)
    .filter(providerName => WEB_SEARCH_API_PROVIDER_NAMES.has(providerName))
    .filter(isWebSearchApiProviderConfiguredForDoctor)
}

function appendConfiguredWebSearchApiProviderDetail(result: CheckResult): CheckResult {
  const configuredProviders = getConfiguredWebSearchApiProviderNames()
  if (configuredProviders.length === 0) return result

  const providerDetail = `Configured API-backed providers: ${configuredProviders.join(', ')}.`
  return {
    ...result,
    detail: result.detail ? `${result.detail} ${providerDetail}` : providerDetail,
  }
}

function hasFirecrawlRunnableConfig(): boolean {
  return Boolean(process.env.FIRECRAWL_API_KEY) ||
    Boolean(process.env.FIRECRAWL_API_URL && !isFirecrawlCloudApiUrl(process.env.FIRECRAWL_API_URL))
}

function buildFirecrawlWebSearchCheck(): CheckResult {
  const apiKey = process.env.FIRECRAWL_API_KEY
  const apiUrl = process.env.FIRECRAWL_API_URL

  if (!apiKey && isFirecrawlCloudApiUrl(apiUrl)) {
    return fail(
      'Web search backend',
      'WEB_SEARCH_PROVIDER=firecrawl but FIRECRAWL_API_KEY is missing for the Firecrawl cloud API.',
    )
  }

  if (apiKey) {
    return pass(
      'Web search backend',
      'WEB_SEARCH_PROVIDER=firecrawl; FIRECRAWL_API_KEY configured.',
    )
  }

  if (apiUrl) {
    return pass(
      'Web search backend',
      'WEB_SEARCH_PROVIDER=firecrawl; FIRECRAWL_API_URL configured.',
    )
  }

  return fail(
    'Web search backend',
    'WEB_SEARCH_PROVIDER=firecrawl but FIRECRAWL_API_KEY is missing.',
  )
}

function isInvalidOllamaBaseUrl(value: string | undefined): boolean {
  const trimmed = value?.trim()
  if (!trimmed) return false

  try {
    const parsed = new URL(trimmed)
    return parsed.protocol !== 'http:' && parsed.protocol !== 'https:'
  } catch {
    return true
  }
}

type OllamaLocalConfig =
  | { status: 'absent' }
  | {
      status: 'configured' | 'invalid'
      source: 'explicit' | 'active'
    }

function getOllamaLocalConfig(): OllamaLocalConfig {
  const explicitBaseUrl = getUsableOllamaBaseUrlEnvValue(
    process.env.OLLAMA_BASE_URL,
  )
  if (explicitBaseUrl) {
    return {
      status: isInvalidOllamaBaseUrl(explicitBaseUrl)
        ? 'invalid'
        : 'configured',
      source: 'explicit',
    }
  }

  if (!isTruthy(process.env.CLAUDE_CODE_USE_OPENAI)) {
    return { status: 'absent' }
  }

  const activeBaseUrl =
    getUsableOllamaBaseUrlEnvValue(process.env.OPENAI_BASE_URL) ??
    getUsableOllamaBaseUrlEnvValue(process.env.OPENAI_API_BASE)
  if (!activeBaseUrl) return { status: 'absent' }

  const markedOllamaRoute =
    process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID?.trim().toLowerCase() === 'ollama'
  if (!markedOllamaRoute && !isOllamaWebSearchBaseUrl(activeBaseUrl)) {
    return { status: 'absent' }
  }

  return {
    status: isInvalidOllamaBaseUrl(activeBaseUrl) ? 'invalid' : 'configured',
    source: 'active',
  }
}

function buildOllamaWebSearchCheck(providerConfigured: boolean): CheckResult {
  const ollamaApiKey = getUsableOllamaApiKey(process.env.OLLAMA_API_KEY)
  const localConfig = getOllamaLocalConfig()
  if (localConfig.status === 'invalid') {
    const configLabel =
      localConfig.source === 'explicit'
        ? 'OLLAMA_BASE_URL'
        : 'active Ollama provider endpoint'
    if (ollamaApiKey) {
      return pass(
        'Web search backend',
        `WEB_SEARCH_PROVIDER=ollama; OLLAMA_API_KEY configured; ${configLabel} is invalid and local search will be skipped.`,
      )
    }
    return fail(
      'Web search backend',
      `WEB_SEARCH_PROVIDER=ollama but ${configLabel} is not a valid HTTP(S) URL.`,
    )
  }

  if (!providerConfigured) {
    return fail(
      'Web search backend',
      'WEB_SEARCH_PROVIDER=ollama but an active Ollama provider, OLLAMA_BASE_URL, or OLLAMA_API_KEY is missing.',
    )
  }

  const configured: string[] = []
  if (localConfig.status === 'configured') {
    configured.push(
      localConfig.source === 'explicit'
        ? 'OLLAMA_BASE_URL'
        : 'active Ollama provider endpoint',
    )
  }
  if (ollamaApiKey) configured.push('OLLAMA_API_KEY')

  return pass(
    'Web search backend',
    `WEB_SEARCH_PROVIDER=ollama; ${formatAndList(configured)} configured.`,
  )
}

function getAutoOllamaConfigDetail(): string | undefined {
  const localConfig = getOllamaLocalConfig()
  if (localConfig.status !== 'invalid') return undefined

  const configLabel =
    localConfig.source === 'explicit'
      ? 'OLLAMA_BASE_URL'
      : 'Active Ollama provider endpoint'

  if (getUsableOllamaApiKey(process.env.OLLAMA_API_KEY)) {
    return `${configLabel} is invalid; runtime will skip local Ollama search and use the hosted Ollama API.`
  }

  return `${configLabel} is invalid; runtime will skip ollama and fall through to the next provider in auto mode.`
}

function appendAutoOllamaConfigDetail(result: CheckResult): CheckResult {
  const ollamaDetail = getAutoOllamaConfigDetail()
  if (!ollamaDetail) return result

  return {
    ...result,
    detail: result.detail ? `${result.detail} ${ollamaDetail}` : ollamaDetail,
  }
}

function getAutoFirecrawlMissingCredentialDetail(): string | undefined {
  const firecrawlSelectedByAutoChain = getAvailableProviders()
    .some(provider => provider.name === 'firecrawl')
  if (!firecrawlSelectedByAutoChain || hasFirecrawlRunnableConfig()) return undefined

  return 'FIRECRAWL_API_URL points to the Firecrawl cloud API but FIRECRAWL_API_KEY is missing; runtime will try firecrawl first and then fall through to the next provider in auto mode.'
}

function appendAutoFirecrawlMissingCredentialDetail(result: CheckResult): CheckResult {
  const firecrawlDetail = getAutoFirecrawlMissingCredentialDetail()
  if (!firecrawlDetail) return result

  return {
    ...result,
    detail: result.detail ? `${result.detail} ${firecrawlDetail}` : firecrawlDetail,
  }
}

function isWebSearchApiProviderConfiguredForDoctor(providerName: string): boolean {
  return providerName !== 'firecrawl' || hasFirecrawlRunnableConfig()
}

function buildCustomWebSearchCheck(providerConfigured: boolean): CheckResult {
  const providerPreset = process.env.WEB_PROVIDER
  const trimmedProviderPreset = providerPreset?.trim()
  const customUrlEnv = process.env.WEB_URL_TEMPLATE
    ? 'WEB_URL_TEMPLATE'
    : process.env.WEB_SEARCH_API
      ? 'WEB_SEARCH_API'
      : undefined

  if (!providerConfigured) {
    return fail(
      'Web search backend',
      'WEB_SEARCH_PROVIDER=custom but WEB_SEARCH_API, WEB_PROVIDER, or WEB_URL_TEMPLATE is missing.',
    )
  }

  if (!providerPreset) {
    return pass(
      'Web search backend',
      `WEB_SEARCH_PROVIDER=custom; ${customUrlEnv ?? formatEnvVarList(WEB_SEARCH_PROVIDER_ENV_VARS.custom)} configured.`,
    )
  }

  const requiredEnvVars = WEB_SEARCH_CUSTOM_PRESET_REQUIRED_ENV_VARS[providerPreset]
  if (!requiredEnvVars) {
    if (!customUrlEnv) {
      if (
        trimmedProviderPreset &&
        trimmedProviderPreset !== providerPreset &&
        WEB_SEARCH_CUSTOM_PRESET_REQUIRED_ENV_VARS[trimmedProviderPreset]
      ) {
        return fail(
          'Web search backend',
          `WEB_SEARCH_PROVIDER=custom with WEB_PROVIDER=${trimmedProviderPreset} but the raw WEB_PROVIDER value has surrounding whitespace and does not match a runtime custom preset. Remove the whitespace or configure WEB_SEARCH_API or WEB_URL_TEMPLATE.`,
        )
      }

      return fail(
        'Web search backend',
        `WEB_SEARCH_PROVIDER=custom with WEB_PROVIDER=${providerPreset} but WEB_SEARCH_API or WEB_URL_TEMPLATE is missing for an unknown custom preset.`,
      )
    }
    return pass(
      'Web search backend',
      `WEB_SEARCH_PROVIDER=custom; WEB_PROVIDER and ${customUrlEnv} configured.`,
    )
  }

  if (providerPreset === 'searxng' && !customUrlEnv) {
    return fail(
      'Web search backend',
      'WEB_SEARCH_PROVIDER=custom with WEB_PROVIDER=searxng but WEB_SEARCH_API or WEB_URL_TEMPLATE is missing for the SearXNG endpoint.',
    )
  }

  const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar])
  if (missingEnvVars.length > 0) {
    return fail(
      'Web search backend',
      `WEB_SEARCH_PROVIDER=custom with WEB_PROVIDER=${providerPreset} but ${formatAndList(missingEnvVars)} ${missingEnvVars.length === 1 ? 'is' : 'are'} missing.`,
    )
  }

  return pass(
    'Web search backend',
    `WEB_SEARCH_PROVIDER=custom; ${formatAndList(['WEB_PROVIDER', ...requiredEnvVars])} configured.`,
  )
}

function formatWebSearchTimeoutSeconds(): string {
  return String(getWebSearchTimeoutMs() / 1000)
}

function appendWebSearchTimeoutDetail(result: CheckResult): CheckResult {
  const timeoutDetail = `Built-in provider timeout: ${formatWebSearchTimeoutSeconds()}s.`
  return {
    ...result,
    detail: result.detail ? `${result.detail} ${timeoutDetail}` : timeoutDetail,
  }
}

function appendWebSearchTimeoutDetails(results: CheckResult[]): CheckResult[] {
  return results.map(appendWebSearchTimeoutDetail)
}

function buildWebSearchEnvChecks(): CheckResult[] {
  const mode = getProviderMode()

  if (mode === 'native') {
    return [appendConfiguredWebSearchApiProviderDetail(buildNativeWebSearchCheck())]
  }

  if (mode === 'auto') {
    const nativeCheck = buildAutoNativeWebSearchCheck()
    if (nativeCheck) {
      return [appendConfiguredWebSearchApiProviderDetail(nativeCheck)]
    }

    const configuredProviders = getConfiguredWebSearchApiProviderNames()

    if (configuredProviders.length > 0) {
      return appendWebSearchTimeoutDetails([
        appendAutoFirecrawlMissingCredentialDetail(
          appendAutoOllamaConfigDetail(
            pass(
              'Web search backend',
              `WEB_SEARCH_PROVIDER=auto; configured providers: ${configuredProviders.join(', ')}; fallback includes duckduckgo.`,
            ),
          ),
        ),
      ])
    }

    return appendWebSearchTimeoutDetails([
      appendAutoFirecrawlMissingCredentialDetail(
        appendAutoOllamaConfigDetail(
          pass(
            'Web search backend',
            `WEB_SEARCH_PROVIDER=auto; only DuckDuckGo fallback is available. DuckDuckGo scraping can be rate-limited from datacenter/VPN/repeated-request networks. Configure ${WEB_SEARCH_RELIABLE_BACKEND_ENV_HINT} for reliable search.`,
          ),
        ),
      ),
    ])
  }

  if (mode === 'ddg') {
    return appendWebSearchTimeoutDetails([
      pass(
        'Web search backend',
        formatDuckDuckGoReliabilityDetail('WEB_SEARCH_PROVIDER=ddg'),
      ),
    ])
  }

  const provider = getProviderChain(mode)[0]
  const envVars = WEB_SEARCH_PROVIDER_ENV_VARS[mode] ?? []
  const envVarLabel = formatEnvVarList(envVars)
  const providerConfigured = Boolean(provider?.isConfigured())

  if (mode === 'firecrawl') {
    return appendWebSearchTimeoutDetails([buildFirecrawlWebSearchCheck()])
  }

  if (mode === 'ollama') {
    return appendWebSearchTimeoutDetails([buildOllamaWebSearchCheck(providerConfigured)])
  }

  if (mode === 'custom') {
    return [buildCustomWebSearchCheck(providerConfigured)]
  }

  if (!providerConfigured) {
    return appendWebSearchTimeoutDetails([
      fail(
        'Web search backend',
        `WEB_SEARCH_PROVIDER=${mode} but ${envVarLabel} is missing.`,
      ),
    ])
  }

  return appendWebSearchTimeoutDetails([
    pass(
      'Web search backend',
      `WEB_SEARCH_PROVIDER=${mode}; ${envVarLabel} configured.`,
    ),
  ])
}

export function checkWebSearchEnv(): CheckResult[] {
  return buildWebSearchEnvChecks()
}

function parseOptions(argv: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    outFile: null,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') {
      options.json = true
      continue
    }

    if (arg === '--out') {
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        options.outFile = next
        i++
      }
    }
  }

  return options
}

export function formatReachabilityFailureDetail(
  endpoint: string,
  status: number,
  responseBody: string,
  request: {
    transport: string
    requestedModel: string
    resolvedModel: string
  },
): string {
  const compactBody = safeDiagnosticText(
    responseBody.trim().replace(/\s+/g, ' ').slice(0, 240),
    '',
  )
  const base = `Unexpected status ${status} from ${redactUrlForDisplay(endpoint)}.`
  const bodySuffix = compactBody ? ` Body: ${compactBody}` : ''

  if (request.transport !== 'codex_responses' || status !== 400) {
    return `${base}${bodySuffix}`
  }

  if (!/not supported.*chatgpt account/i.test(responseBody)) {
    return `${base}${bodySuffix}`
  }

  const requestedModel = safeDisplayValue(request.requestedModel, 'the requested model')
  const resolvedModel = safeDisplayValue(request.resolvedModel, 'the resolved model')
  return `${base}${bodySuffix} Hint: model alias "${requestedModel}" resolved to "${resolvedModel}", which this ChatGPT account does not currently allow. Try "codexplan" or another entitled Codex model.`
}

export function readNodeExecutableVersion(
  spawn = spawnSync,
): NodeExecutableVersionProbe {
  const result = spawn('node', ['--version'], {
    encoding: 'utf8',
  })

  if (result.error) {
    return {
      ok: false,
      detail: `Unable to run \`node --version\`: ${result.error.message}. OpenClaude requires Node.js ${MIN_NODE_ENGINE_RANGE} on PATH.`,
    }
  }

  if (result.status !== 0) {
    const output = (result.stderr || result.stdout || '').trim()
    const suffix = output ? `: ${output}` : `: exit code ${result.status ?? 'unknown'}`
    return {
      ok: false,
      detail: `Unable to run \`node --version\`${suffix}. OpenClaude requires Node.js ${MIN_NODE_ENGINE_RANGE} on PATH.`,
    }
  }

  const version = (result.stdout || result.stderr || '').trim()
  if (!version) {
    return {
      ok: false,
      detail: `Unable to read Node.js version from \`node --version\`. OpenClaude requires Node.js ${MIN_NODE_ENGINE_RANGE} on PATH.`,
    }
  }

  return {
    ok: true,
    version,
  }
}

export function checkNodeVersion(
  raw: string | NodeExecutableVersionProbe = readNodeExecutableVersion(),
): CheckResult {
  if (typeof raw !== 'string' && !raw.ok) {
    return fail('Node.js version', raw.detail)
  }

  const versionCheck = checkSupportedNodeVersion(
    typeof raw === 'string' ? raw : raw.version,
  )
  if (!versionCheck.ok) {
    return fail('Node.js version', versionCheck.message)
  }

  return pass('Node.js version', versionCheck.version)
}

function checkBunRuntime(): CheckResult {
  const bunVersion = (globalThis as { Bun?: { version?: string } }).Bun?.version
  if (!bunVersion) {
    return pass('Bun runtime', 'Not running inside Bun (this is acceptable for Node startup).')
  }
  return pass('Bun runtime', bunVersion)
}

function checkBuildArtifacts(): CheckResult {
  const distCli = resolve(process.cwd(), 'dist', 'cli.mjs')
  if (!existsSync(distCli)) {
    return fail('Build artifacts', `Missing ${distCli}. Run: bun run build`)
  }
  return pass('Build artifacts', distCli)
}

export function isCliSandboxRuntimeStubbed(bundleText: string): boolean {
  return bundleText.includes('native-stub:@anthropic-ai/sandbox-runtime')
}

type SandboxRuntimeCheckInput =
  | {
      inspectionError: unknown
    }
  | {
      cliRuntimeStubbed: boolean
      sandboxEnabled: boolean
      failIfUnavailable: boolean
      sandboxingEnabled: boolean
      unavailableReason?: string
    }

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function buildSandboxRuntimeCheck(
  input: SandboxRuntimeCheckInput,
): CheckResult {
  if ('inspectionError' in input) {
    return fail(
      'Sandbox runtime',
      `Unable to inspect CLI sandbox runtime: ${formatUnknownError(input.inspectionError)}`,
    )
  }

  const effectiveBehavior = input.sandboxingEnabled
    ? 'enforcing'
    : input.sandboxEnabled
      ? input.failIfUnavailable
        ? 'fail-closed'
        : 'warning-only'
      : 'disabled'

  const detailParts = [
    `CLI bundle: ${input.cliRuntimeStubbed ? 'stubbed' : 'real runtime'}`,
    `sandbox.enabled: ${input.sandboxEnabled}`,
    `failIfUnavailable: ${input.failIfUnavailable}`,
    `effective behavior: ${effectiveBehavior}`,
  ]
  const reason =
    input.unavailableReason ??
    (input.cliRuntimeStubbed && input.sandboxEnabled
      ? 'CLI bundle contains a no-op sandbox runtime stub'
      : undefined)
  if (reason) {
    detailParts.push(`reason: ${reason}`)
  }

  const ok = !(
    input.sandboxEnabled &&
    input.failIfUnavailable &&
    Boolean(reason)
  )
  return ok
    ? pass('Sandbox runtime', detailParts.join('; '))
    : fail('Sandbox runtime', detailParts.join('; '))
}

function checkSandboxRuntime(): CheckResult {
  const distCli = resolve(process.cwd(), 'dist', 'cli.mjs')
  if (!existsSync(distCli)) {
    return fail(
      'Sandbox runtime',
      `CLI bundle missing at ${distCli}. Run: bun run build`,
    )
  }

  try {
    const bundle = readFileSync(distCli, 'utf8')
    return buildSandboxRuntimeCheck({
      cliRuntimeStubbed: isCliSandboxRuntimeStubbed(bundle),
      sandboxEnabled: SandboxManager.isSandboxEnabledInSettings(),
      failIfUnavailable: SandboxManager.isSandboxRequired(),
      sandboxingEnabled: SandboxManager.isSandboxingEnabled(),
      unavailableReason: SandboxManager.getSandboxUnavailableReason(),
    })
  } catch (error) {
    return buildSandboxRuntimeCheck({ inspectionError: error })
  }
}

function isLocalBaseUrl(baseUrl: string): boolean {
  return isProviderLocalUrl(baseUrl)
}

const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai'
const MISTRAL_DEFAULT_BASE_URL = 'https://api.mistral.ai/v1'
const GITHUB_COPILOT_BASE = 'https://api.githubcopilot.com'

function currentSecretSource(): SecretValueSource {
  return process.env as SecretValueSource
}

function safeDisplayValue(
  value: string | null | undefined,
  fallback: string,
): string {
  return redactSecretValueForDisplay(value, currentSecretSource()) ?? fallback
}

function safeDiagnosticText(
  value: string | null | undefined,
  fallback: string,
): string {
  return redactSecretSubstringsForDisplay(value, currentSecretSource()) ?? fallback
}

function safeBaseUrlDisplay(
  value: string | null | undefined,
  fallback: string,
): string {
  if (!value) return fallback
  return safeDisplayValue(redactUrlForDisplay(value), fallback)
}

function getOpenAICompatibleRouteId(baseUrl: string): string {
  return (
    resolveRouteIdFromBaseUrl(baseUrl) ??
    resolveActiveRouteIdFromEnv(process.env) ??
    'custom'
  )
}

function getOpenAICompatibleCredentialContext(baseUrl: string): {
  routeId: string
  envVars: string[]
  value: string | undefined
} {
  const routeId = getOpenAICompatibleRouteId(baseUrl)
  return {
    routeId,
    envVars: getRouteCredentialEnvVars(routeId),
    value: getRouteCredentialValue(routeId, process.env),
  }
}

function hasPlaceholderCredential(value: string | undefined): boolean {
  return (value ?? '').split(',').some(part => part.trim() === 'SUA_CHAVE')
}

function currentBaseUrl(): string {
  if (isTruthy(process.env.CLAUDE_CODE_USE_GEMINI)) {
    return process.env.GEMINI_BASE_URL ?? GEMINI_DEFAULT_BASE_URL
  }
  if (isTruthy(process.env.CLAUDE_CODE_USE_MISTRAL)) {
    return process.env.MISTRAL_BASE_URL ?? MISTRAL_DEFAULT_BASE_URL
  }
  if (isTruthy(process.env.CLAUDE_CODE_USE_GITHUB)) {
    return process.env.OPENAI_BASE_URL ?? GITHUB_COPILOT_BASE
  }
  return process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'
}

function checkGeminiEnv(): CheckResult[] {
  const results: CheckResult[] = []
  const model = process.env.GEMINI_MODEL
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
  const baseUrl = process.env.GEMINI_BASE_URL ?? GEMINI_DEFAULT_BASE_URL

  results.push(pass('Provider mode', 'Google Gemini provider enabled.'))

  if (!model) {
    results.push(pass('GEMINI_MODEL', `Not set. Default ${DEFAULT_GEMINI_MODEL} will be used.`))
  } else {
    results.push(pass('GEMINI_MODEL', safeDisplayValue(model, '')))
  }

  results.push(pass('GEMINI_BASE_URL', safeBaseUrlDisplay(baseUrl, '')))

  if (!key) {
    results.push(fail('GEMINI_API_KEY', 'Missing. Set GEMINI_API_KEY or GOOGLE_API_KEY.'))
  } else {
    results.push(pass('GEMINI_API_KEY', 'Configured.'))
  }

  return results
}

function checkMistralEnv(): CheckResult[] {
  const results: CheckResult[] = []
  const model = process.env.MISTRAL_MODEL
  const key = process.env.MISTRAL_API_KEY
  const baseUrl = process.env.MISTRAL_BASE_URL ?? MISTRAL_DEFAULT_BASE_URL

  results.push(pass('Provider mode', 'Mistral provider enabled.'))

  if (!model) {
    results.push(pass('MISTRAL_MODEL', 'Not set. Default will be used at runtime.'))
  } else {
    results.push(pass('MISTRAL_MODEL', safeDisplayValue(model, '')))
  }

  results.push(pass('MISTRAL_BASE_URL', safeBaseUrlDisplay(baseUrl, '')))

  if (!key) {
    results.push(fail('MISTRAL_API_KEY', 'Missing. Set MISTRAL_API_KEY.'))
  } else {
    results.push(pass('MISTRAL_API_KEY', 'Configured.'))
  }

  return results
}

function checkGithubEnv(): CheckResult[] {
  const results: CheckResult[] = []
  const baseUrl = process.env.OPENAI_BASE_URL ?? GITHUB_COPILOT_BASE
  results.push(pass('Provider mode', 'GitHub Models provider enabled.'))

  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (!token?.trim()) {
    results.push(fail('GITHUB_TOKEN', 'Missing. Set GITHUB_TOKEN or GH_TOKEN.'))
  } else {
    results.push(pass('GITHUB_TOKEN', 'Configured.'))
  }

  if (!process.env.OPENAI_MODEL) {
    results.push(
      pass(
        'OPENAI_MODEL',
        'Not set. Default github:copilot → openai/gpt-4.1 at runtime.',
      ),
    )
  } else {
    results.push(pass('OPENAI_MODEL', safeDisplayValue(process.env.OPENAI_MODEL, '')))
  }

  results.push(pass('OPENAI_BASE_URL', safeBaseUrlDisplay(baseUrl, '')))
  return results
}

export function checkOpenAIEnv(): CheckResult[] {
  const results: CheckResult[] = []
  const useGemini = isTruthy(process.env.CLAUDE_CODE_USE_GEMINI)
  const useGithub = isTruthy(process.env.CLAUDE_CODE_USE_GITHUB)
  const useMistral = isTruthy(process.env.CLAUDE_CODE_USE_MISTRAL)
  const useOpenAI = isTruthy(process.env.CLAUDE_CODE_USE_OPENAI)

  if (useGemini) {
    return checkGeminiEnv()
  }

  if (useMistral) {
    return checkMistralEnv()
  }

  if (useGithub && !useOpenAI) {
    return checkGithubEnv()
  }

  if (!useOpenAI) {
    results.push(pass('Provider mode', 'Anthropic login flow enabled (CLAUDE_CODE_USE_OPENAI is off).'))
    return results
  }

  const request = resolveProviderRequest({
    model: process.env.OPENAI_MODEL,
    baseUrl: process.env.OPENAI_BASE_URL,
  })

  results.push(
    pass(
      'Provider mode',
      request.transport === 'codex_responses'
        ? 'Codex responses backend enabled.'
        : 'OpenAI-compatible provider enabled.',
    ),
  )

  if (!process.env.OPENAI_MODEL) {
    results.push(pass('OPENAI_MODEL', 'Not set. Runtime fallback model will be used.'))
  } else {
    results.push(pass('OPENAI_MODEL', safeDisplayValue(process.env.OPENAI_MODEL, '')))
  }

  results.push(pass('OPENAI_BASE_URL', safeBaseUrlDisplay(request.baseUrl, '')))

  if (request.transport === 'codex_responses') {
    const credentials = resolveCodexApiCredentials(process.env)
    if (!credentials.apiKey) {
      const authHint = credentials.authPath
        ? `Missing CODEX_API_KEY and no usable auth.json at ${credentials.authPath}.`
        : 'Missing CODEX_API_KEY and auth.json fallback.'
      results.push(fail('CODEX auth', authHint))
    } else if (!credentials.accountId) {
      results.push(fail('CHATGPT_ACCOUNT_ID', 'Missing chatgpt_account_id in Codex auth.'))
    } else {
      const detail = credentials.source === 'env'
        ? 'Using CODEX_API_KEY.'
        : `Using ${credentials.authPath}.`
      results.push(pass('CODEX auth', detail))
    }
    return results
  }

  const credentialContext = getOpenAICompatibleCredentialContext(request.baseUrl)
  const providerCredential = credentialContext.value
  const credentialLabel =
    credentialContext.envVars.length > 0
      ? credentialContext.envVars.join(' or ')
      : 'OPENAI_API_KEY'
  const githubToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  const hasGithubRouteCredential =
    credentialContext.routeId === 'github' && Boolean(githubToken?.trim())
  const openAIState = resolveOpenAICredentialEnvState(process.env)
  const hasOpenAIFallback =
    credentialContext.envVars.includes('OPENAI_API_KEYS') ||
    credentialContext.envVars.includes('OPENAI_API_KEY')
  const hasPlaceholderProviderCredential = credentialContext.envVars.some(envVar => {
    if (
      hasOpenAIFallback &&
      (envVar === 'OPENAI_API_KEYS' || envVar === 'OPENAI_API_KEY')
    ) {
      return openAIState.invalid && openAIState.envVar === envVar
    }
    return hasPlaceholderCredential(process.env[envVar])
  })
  if (
    hasPlaceholderCredential(providerCredential) ||
    hasPlaceholderProviderCredential
  ) {
    results.push(fail(credentialLabel, 'Placeholder value detected: SUA_CHAVE.'))
  } else if (
    !providerCredential &&
    !isLocalBaseUrl(request.baseUrl) &&
    !hasGithubRouteCredential
  ) {
    results.push(fail(credentialLabel, `Missing key for non-local provider URL. Set ${credentialLabel}.`))
  } else if (!providerCredential && hasGithubRouteCredential) {
    results.push(
      pass('OPENAI_API_KEY', 'Not set; GITHUB_TOKEN/GH_TOKEN will be used for GitHub Models.'),
    )
  } else if (!providerCredential) {
    results.push(pass(credentialLabel, 'Not set (allowed for local providers like Atomic Chat/Ollama/LM Studio).'))
  } else {
    results.push(pass(credentialLabel, 'Configured.'))
  }

  return results
}

async function checkBaseUrlReachability(): Promise<CheckResult> {
  const useGemini = isTruthy(process.env.CLAUDE_CODE_USE_GEMINI)
  const useOpenAI = isTruthy(process.env.CLAUDE_CODE_USE_OPENAI)
  const useGithub = isTruthy(process.env.CLAUDE_CODE_USE_GITHUB)
  const useMistral = isTruthy(process.env.CLAUDE_CODE_USE_MISTRAL)

  if (!useGemini && !useOpenAI && !useGithub && !useMistral) {
    return pass('Provider reachability', 'Skipped (OpenAI-compatible mode disabled).')
  }

  if (useGithub && !useOpenAI) {
    return pass(
      'Provider reachability',
      'Skipped for GitHub Models (inference endpoint differs from OpenAI /models probe).',
    )
  }

  const geminiBaseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai'
  const resolvedBaseUrl = useGemini
    ? (process.env.GEMINI_BASE_URL ?? geminiBaseUrl)
    : undefined
  const request = resolveProviderRequest({
    model: process.env.OPENAI_MODEL,
    baseUrl: resolvedBaseUrl ?? process.env.OPENAI_BASE_URL,
  })
  const endpoint = request.transport === 'codex_responses'
    ? `${request.baseUrl}/responses`
    : `${request.baseUrl}/models`
  const redactedEndpoint = redactUrlForDisplay(endpoint)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 4000)

  try {
    const headers: Record<string, string> = {}
    let method = 'GET'
    let body: string | undefined

    if (request.transport === 'codex_responses') {
      const credentials = resolveCodexApiCredentials(process.env)
      if (credentials.apiKey) {
        headers.Authorization = `Bearer ${credentials.apiKey}`
      }
      if (credentials.accountId) {
        headers['chatgpt-account-id'] = credentials.accountId
      }
      headers['Content-Type'] = 'application/json'
      headers.originator = 'openclaude'
      method = 'POST'
      body = JSON.stringify({
        model: request.resolvedModel,
        instructions: 'Runtime doctor probe.',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'ping' }],
          },
        ],
        store: false,
        stream: true,
      })
    } else if (useGemini && (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY)) {
      headers.Authorization = `Bearer ${process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY}`
    } else if (useMistral && process.env.MISTRAL_API_KEY) {
      headers.Authorization = `Bearer ${process.env.MISTRAL_API_KEY}`
    } else {
      const credential = getOpenAICompatibleCredentialContext(request.baseUrl).value
      if (credential) {
        headers.Authorization = `Bearer ${credential}`
      }
    }

    const response = await fetch(endpoint, {
      method,
      headers,
      body,
      signal: controller.signal,
    })

    if (response.status === 200 || response.status === 401 || response.status === 403) {
      return pass(
        'Provider reachability',
        `Reached ${redactedEndpoint} (status ${response.status}).`,
      )
    }

    const responseBody = await response.text().catch(() => '')
    const detail = formatReachabilityFailureDetail(
      endpoint,
      response.status,
      responseBody,
      request,
    )
    return fail(
      'Provider reachability',
      detail,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return fail(
      'Provider reachability',
      `Failed to reach ${redactedEndpoint}: ${message}`,
    )
  } finally {
    clearTimeout(timeout)
  }
}

async function checkProviderGenerationReadiness(): Promise<CheckResult> {
  const useGemini = isTruthy(process.env.CLAUDE_CODE_USE_GEMINI)
  const useOpenAI = isTruthy(process.env.CLAUDE_CODE_USE_OPENAI)
  const useGithub = isTruthy(process.env.CLAUDE_CODE_USE_GITHUB)
  const useMistral = isTruthy(process.env.CLAUDE_CODE_USE_MISTRAL)

  if (!useGemini && !useOpenAI && !useGithub && !useMistral) {
    return pass('Provider generation readiness', 'Skipped (OpenAI-compatible mode disabled).')
  }

  if (useGithub && !useOpenAI) {
    return pass(
      'Provider generation readiness',
      'Skipped for GitHub Models (runtime generation uses a different endpoint flow).',
    )
  }

  if (useGemini || useMistral) {
    return pass(
      'Provider generation readiness',
      'Skipped for managed provider mode.',
    )
  }

  if (!useOpenAI) {
    return pass('Provider generation readiness', 'Skipped (OpenAI-compatible mode disabled).')
  }

  const request = resolveProviderRequest({
    model: process.env.OPENAI_MODEL,
    baseUrl: process.env.OPENAI_BASE_URL,
  })

  if (request.transport === 'codex_responses') {
    return pass(
      'Provider generation readiness',
      'Skipped for Codex responses (reachability probe already performs a lightweight generation request).',
    )
  }

  if (!isLocalBaseUrl(request.baseUrl)) {
    return pass('Provider generation readiness', 'Skipped for non-local provider URL.')
  }

  const localProviderLabel = getLocalOpenAICompatibleProviderLabel(request.baseUrl)
  if (localProviderLabel !== 'Ollama') {
    return pass(
      'Provider generation readiness',
      `Skipped for ${localProviderLabel} (no provider-specific generation probe).`,
    )
  }

  const readiness = await probeOllamaGenerationReadiness({
    baseUrl: request.baseUrl,
    model: request.requestedModel,
  })

  if (readiness.state === 'ready') {
    return pass(
      'Provider generation readiness',
      `Generated a test response with ${safeDisplayValue(readiness.probeModel ?? request.requestedModel, 'the requested model')}.`,
    )
  }

  if (readiness.state === 'unreachable') {
    return fail(
      'Provider generation readiness',
      `Could not reach Ollama at ${redactUrlForDisplay(request.baseUrl)}.`,
    )
  }

  if (readiness.state === 'no_models') {
    return fail(
      'Provider generation readiness',
      'Ollama is reachable, but no installed models were found. Pull a model first (for example: ollama pull qwen2.5-coder:7b).',
    )
  }

  const detail = safeDiagnosticText(readiness.detail, '')
  const detailSuffix = detail ? ` Detail: ${detail}.` : ''
  return fail(
    'Provider generation readiness',
    `Ollama is reachable, but generation failed for ${safeDisplayValue(readiness.probeModel ?? request.requestedModel, 'the requested model')}.${detailSuffix}`,
  )
}

function isAtomicChatUrl(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl)
    return parsed.port === '1337' && isLocalBaseUrl(baseUrl)
  } catch {
    return false
  }
}

function checkOllamaProcessorMode(): CheckResult {
  if (
    !isTruthy(process.env.CLAUDE_CODE_USE_OPENAI) ||
    isTruthy(process.env.CLAUDE_CODE_USE_GEMINI) ||
    isTruthy(process.env.CLAUDE_CODE_USE_GITHUB) ||
    isTruthy(process.env.CLAUDE_CODE_USE_MISTRAL)
  ) {
    return pass('Ollama processor mode', 'Skipped (OpenAI-compatible mode disabled).')
  }

  const baseUrl = currentBaseUrl()
  if (!isLocalBaseUrl(baseUrl)) {
    return pass('Ollama processor mode', 'Skipped (provider URL is not local).')
  }

  if (isAtomicChatUrl(baseUrl)) {
    return pass('Ollama processor mode', 'Skipped (Atomic Chat local provider detected, not Ollama).')
  }

  const result = spawnSync('ollama', ['ps'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: true,
  })

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || 'Unable to run ollama ps').trim()
    return pass('Ollama processor mode', `Native CLI check failed (${detail}). Assuming valid Docker/remote backend since HTTP ping passed.`)
  }

  const output = (result.stdout || '').trim()
  if (!output) {
    return fail('Ollama processor mode', 'ollama ps returned empty output.')
  }

  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const modelLine = lines.find(line => line.includes(':') && !line.startsWith('NAME'))
  if (!modelLine) {
    return pass('Ollama processor mode', 'No loaded model found (run a prompt first).')
  }

  if (modelLine.includes('CPU')) {
    return pass('Ollama processor mode', 'Detected CPU mode. This is valid but can be slow for larger models.')
  }

  return pass('Ollama processor mode', `Detected non-CPU mode: ${modelLine}`)
}

export function serializeSafeEnvSummary(): Record<string, string | boolean> {
  if (isTruthy(process.env.CLAUDE_CODE_USE_GEMINI)) {
    return {
      CLAUDE_CODE_USE_GEMINI: true,
      GEMINI_MODEL: safeDisplayValue(process.env.GEMINI_MODEL, `(unset, default: ${DEFAULT_GEMINI_MODEL})`),
      GEMINI_BASE_URL: safeBaseUrlDisplay(process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta/openai', ''),
      GEMINI_API_KEY_SET: Boolean(process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY),
    }
  }
  if (isTruthy(process.env.CLAUDE_CODE_USE_MISTRAL)) {
    return {
      CLAUDE_CODE_USE_MISTRAL: true,
      MISTRAL_MODEL: safeDisplayValue(process.env.MISTRAL_MODEL, '(unset, default: devstral-latest)'),
      MISTRAL_BASE_URL: safeBaseUrlDisplay(process.env.MISTRAL_BASE_URL ?? 'https://api.mistral.ai/v1', ''),
      MISTRAL_API_KEY_SET: Boolean(process.env.MISTRAL_API_KEY),
    }
  }
  if (
    isTruthy(process.env.CLAUDE_CODE_USE_GITHUB) &&
    !isTruthy(process.env.CLAUDE_CODE_USE_OPENAI)
  ) {
    return {
      CLAUDE_CODE_USE_GITHUB: true,
      OPENAI_MODEL:
        safeDisplayValue(
          process.env.OPENAI_MODEL,
          '(unset, default: github:copilot → openai/gpt-4.1)',
        ),
      OPENAI_BASE_URL:
        safeBaseUrlDisplay(process.env.OPENAI_BASE_URL ?? GITHUB_COPILOT_BASE, ''),
      GITHUB_TOKEN_SET: Boolean(
        process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
      ),
    }
  }
  const request = resolveProviderRequest({
    model: process.env.OPENAI_MODEL,
    baseUrl: process.env.OPENAI_BASE_URL,
  })
  const credentialContext = getOpenAICompatibleCredentialContext(request.baseUrl)
  return {
    CLAUDE_CODE_USE_OPENAI: isTruthy(process.env.CLAUDE_CODE_USE_OPENAI),
    OPENAI_MODEL: safeDisplayValue(process.env.OPENAI_MODEL, '(unset)'),
    OPENAI_BASE_URL: safeBaseUrlDisplay(request.baseUrl, ''),
    OPENAI_API_KEY_SET: Boolean(process.env.OPENAI_API_KEY),
    PROVIDER_API_KEY_SET: Boolean(credentialContext.value),
    CODEX_API_KEY_SET: Boolean(resolveCodexApiCredentials(process.env).apiKey),
  }
}

function printResults(results: CheckResult[]): void {
  for (const result of results) {
    const icon = result.ok ? 'PASS' : 'FAIL'
    const suffix = result.detail ? ` - ${result.detail}` : ''
    console.log(`[${icon}] ${result.label}${suffix}`)
  }
}

function writeJsonReport(
  options: CliOptions,
  results: CheckResult[],
): void {
  const envSummary = serializeSafeEnvSummary()
  const payload = {
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
    summary: {
      total: results.length,
      passed: results.filter(result => result.ok).length,
      failed: results.filter(result => !result.ok).length,
    },
    env: envSummary,
    results,
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          timestamp: payload.timestamp,
          cwd: payload.cwd,
          summary: payload.summary,
          env: '[redacted in console JSON output; use --out-file for the full report]',
          results: payload.results,
        },
        null,
        2,
      ),
    )
  }

  if (options.outFile) {
    const outputPath = resolve(process.cwd(), options.outFile)
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, JSON.stringify(payload, null, 2), 'utf8')
    if (!options.json) {
      console.log(`Report written to ${outputPath}`)
    }
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  const results: CheckResult[] = []

  const configModule = await import('../src/utils/config.js')
  configModule.enableConfigs()
  const { applySafeConfigEnvironmentVariables } = await import('../src/utils/managedEnv.js')
  applySafeConfigEnvironmentVariables()
  const { hydrateGithubModelsTokenFromSecureStorage } = await import('../src/utils/githubModelsCredentials.js')
  hydrateGithubModelsTokenFromSecureStorage()

  results.push(checkNodeVersion())
  results.push(checkBunRuntime())
  results.push(checkBuildArtifacts())
  results.push(checkSandboxRuntime())
  const globalConfig = configModule.getGlobalConfig()
  results.push(
    ...buildMemoryGuardChecks({
      autoCompactEnabled: globalConfig.autoCompactEnabled,
      maxMessagesCompactionThreshold:
        globalConfig.maxMessagesCompactionThreshold,
    }),
  )
  results.push(...checkWebSearchEnv())
  results.push(...checkOpenAIEnv())
  results.push(await checkBaseUrlReachability())
  results.push(await checkProviderGenerationReadiness())
  results.push(checkOllamaProcessorMode())

  if (!options.json) {
    printResults(results)
  }

  writeJsonReport(options, results)

  const hasFailure = results.some(result => !result.ok)
  if (hasFailure) {
    process.exitCode = 1
    return
  }

  if (!options.json) {
    console.log('\nRuntime checks completed successfully.')
  }
}

if (import.meta.main) {
  await main()
}

export {}
