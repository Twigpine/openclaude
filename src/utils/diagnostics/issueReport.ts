import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve, basename } from 'node:path'
import { arch, platform } from 'node:os'
import { getCatalogEntriesForRoute } from '../../integrations/index.js'
import {
  getRouteDefaultBaseUrl,
  getRouteDefaultModel,
  getRouteDescriptor,
  getRouteProviderTypeLabel,
  resolveActiveRouteIdFromEnv,
  resolveRouteIdFromBaseUrl,
  getRouteCredentialEnvVars,
} from '../../integrations/routeMetadata.js'
import { resolveModelRuntimeLimits } from '../../integrations/runtimeMetadata.js'
import { parseCredentialList } from '../../services/api/credentialPool.js'
import type { CapabilityFlags, ModelCatalogEntry } from '../../integrations/descriptors.js'
import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'
import { getClaudeCodeMcpConfigs } from '../../services/mcp/config.js'
import {
  resolveProviderRequest,
  resolveRuntimeCodexCredentials,
} from '../../services/api/providerConfig.js'
import { getInMemoryErrors } from '../log.js'
import {
  getGeminiVertexEndpointError,
  getGeminiVertexLocation,
  getGeminiVertexModel,
  getGeminiVertexProjectId,
} from '../geminiAuth.js'
import { getRipgrepStatus, testRipgrepOnFirstUse } from '../ripgrep.js'
import {
  getSettingsWithErrors,
  getSettingsWithSources,
} from '../settings/settings.js'
import type { SettingSource } from '../settings/constants.js'
import type { ValidationError } from '../settings/validation.js'
import {
  collectProviderSecretEnvVars,
  redactDiagnosticObject,
  redactDiagnosticUrl,
  redactHomePath,
  redactLikelySecrets,
} from '../redaction.js'

export type IssueReportFormat = 'json' | 'markdown'

export type IssueReportArgs = {
  format: IssueReportFormat
  outFile: string | null
  includeDebug: boolean
  // Unredacted reports are intentionally unsupported; this captures --redacted
  // as an explicit safety assertion and lets handlers reject future false values.
  redacted: boolean
}

export type DiagnosticCheck = {
  label: string
  ok: boolean
  detail: string
}

export type IssueReport = {
  schemaVersion: 1
  generatedAt: string
  openclaude: {
    version: string
    displayVersion?: string
    buildTime?: string
    source: 'source' | 'dist' | 'unknown'
  }
  workspace: {
    cwd: string
  }
  runtime: {
    platform: NodeJS.Platform
    arch: string
    node: string
    bun: string | null
    packageManager: string | null
    tty: {
      stdin: boolean
      stdout: boolean
      stderr: boolean
    }
  }
  provider: {
    routeId: string
    label: string
    providerType: string
    model: string
    apiFormat?: string
    baseUrl?: string
    credential: {
      required: boolean
      present: boolean
      sources: string[]
    }
  }
  model: {
    contextWindow?: number
    maxOutputTokens?: number
    catalogSource: 'static' | 'dynamic' | 'hybrid' | 'custom' | 'unknown'
    capabilities: CapabilityFlags
  }
  settings: {
    sourcesPresent: SettingSource[]
    validationErrors: Array<{ file: string; path: string; message: string }>
  }
  checks: DiagnosticCheck[]
  mcp: {
    serverCount: number
    transports: Record<string, number>
  }
  errors: {
    recent: Array<{ category: string; count: number }>
    debug?: string[]
  }
  warnings: string[]
  redaction: {
    homeRedacted: boolean
    cwdRedacted: boolean
    secretsIncluded: false
  }
}

type BuildIssueReportOptions = {
  env?: NodeJS.ProcessEnv
  cwd?: string
  now?: Date
  packageInfo?: {
    version?: string
    displayVersion?: string
    buildTime?: string
  }
  checks?: {
    buildArtifactsPresent?: boolean
    ripgrep?: { available: boolean; detail: string }
  }
  settings?: {
    sourcesPresent: SettingSource[]
    validationErrors: Array<Pick<ValidationError, 'file' | 'path' | 'message'>>
  }
  mcpServers?: Record<string, Partial<ScopedMcpServerConfig>>
  errors?: Array<{ error: string; timestamp: string }>
  includeDebug?: boolean
}

type CredentialSummary = IssueReport['provider']['credential']

type DiagnosticProviderContext = {
  routeId: string
  label: string
  providerType: string
  model: string
  limitsModel: string
  catalogRouteId: string
  baseUrl?: string
  apiFormat?: string
  credential: CredentialSummary
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'no'
}

function readPackageManager(env: NodeJS.ProcessEnv): string | null {
  const userAgent = env.npm_config_user_agent?.trim()
  if (userAgent) return userAgent.split(' ')[0] ?? userAgent
  const execPath = env.npm_execpath?.trim()
  if (!execPath) return null
  if (execPath.includes('bun')) return 'bun'
  if (execPath.includes('pnpm')) return 'pnpm'
  if (execPath.includes('yarn')) return 'yarn'
  if (execPath.includes('npm')) return 'npm'
  return basename(execPath)
}

function readMacroVersion(): string | undefined {
  try {
    return MACRO.VERSION
  } catch {
    return undefined
  }
}

function readMacroDisplayVersion(): string | undefined {
  try {
    return MACRO.DISPLAY_VERSION
  } catch {
    return undefined
  }
}

function readMacroBuildTime(): string | undefined {
  try {
    return MACRO.BUILD_TIME
  } catch {
    return undefined
  }
}

function readPackageInfo(options?: BuildIssueReportOptions['packageInfo']) {
  const version =
    options?.version ?? readMacroVersion() ?? 'unknown'
  const displayVersion = options?.displayVersion ?? readMacroDisplayVersion()
  const buildTime = options?.buildTime ?? readMacroBuildTime()

  return { version, displayVersion, buildTime }
}

function detectSource(cwd: string): IssueReport['openclaude']['source'] {
  if (existsSync(resolve(cwd, 'src')) && existsSync(resolve(cwd, 'package.json'))) {
    return 'source'
  }
  if (existsSync(resolve(cwd, 'dist', 'cli.mjs'))) {
    return 'dist'
  }
  return 'unknown'
}

function resolveProviderModel(routeId: string, env: NodeJS.ProcessEnv): string {
  if (routeId === 'gemini-vertex') {
    return getGeminiVertexModel(env) ?? 'unknown'
  }
  if (routeId === 'gemini') {
    return env.GEMINI_MODEL?.trim() || getRouteDefaultModel(routeId) || 'unknown'
  }
  if (routeId === 'mistral') {
    return env.MISTRAL_MODEL?.trim() || getRouteDefaultModel(routeId) || 'unknown'
  }
  if (routeId === 'anthropic') {
    return env.ANTHROPIC_MODEL?.trim() || getRouteDefaultModel(routeId) || 'unknown'
  }
  return env.OPENAI_MODEL?.trim() || getRouteDefaultModel(routeId) || 'unknown'
}

function resolveProviderBaseUrl(
  routeId: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (routeId === 'gemini-vertex') {
    const project = getGeminiVertexProjectId(env)
    if (!project) return undefined // Ambient ADC may supply it at request time.
    const location = getGeminiVertexLocation(env)
    if (getGeminiVertexEndpointError({ project, location })) return undefined
    const host = location === 'global'
      ? 'aiplatform.googleapis.com'
      : `${location}-aiplatform.googleapis.com`
    return `https://${host}/v1/projects/${project}/locations/${location}/publishers/google`
  }
  if (routeId === 'gemini') {
    return env.GEMINI_BASE_URL?.trim() || getRouteDefaultBaseUrl(routeId)
  }
  if (routeId === 'mistral') {
    return env.MISTRAL_BASE_URL?.trim() || getRouteDefaultBaseUrl(routeId)
  }
  if (routeId === 'anthropic') {
    return env.ANTHROPIC_BASE_URL?.trim() || getRouteDefaultBaseUrl(routeId)
  }
  return (
    env.OPENAI_BASE_URL?.trim() ||
    env.OPENAI_API_BASE?.trim() ||
    getRouteDefaultBaseUrl(routeId)
  )
}

function resolveRouteId(env: NodeJS.ProcessEnv): string {
  const activeRoute = resolveActiveRouteIdFromEnv(env)
  const baseUrl = env.OPENAI_BASE_URL ?? env.OPENAI_API_BASE
  const normalizedBaseUrlRoute = resolveRouteIdFromBaseUrl(
    normalizeRouteMatchBaseUrl(baseUrl),
  )
  if (activeRoute && activeRoute !== 'custom') return activeRoute
  return normalizedBaseUrlRoute ?? activeRoute ?? 'custom'
}

function normalizeRouteMatchBaseUrl(
  baseUrl: string | undefined,
): string | undefined {
  if (!baseUrl?.trim()) return baseUrl
  try {
    const parsed = new URL(baseUrl)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return baseUrl
  }
}

function hasDiagnosticCredentialValue(name: string, value: string | undefined): boolean {
  if (name === 'OPENAI_API_KEYS' || name === 'OPENAI_API_KEY') {
    return parseCredentialList(value).length > 0
  }
  return Boolean(value?.trim())
}

function getCredentialSummary(routeId: string, env: NodeJS.ProcessEnv) {
  const descriptor = getRouteDescriptor(routeId)
  const envVars = getRouteCredentialEnvVars(routeId)
  const sources = envVars.filter(name =>
    hasDiagnosticCredentialValue(name, env[name]),
  )
  const requiresAuth = descriptor?.setup.requiresAuth ?? routeId !== 'custom'

  return {
    required: requiresAuth,
    present: sources.length > 0,
    sources,
  }
}

function getCodexCredentialSummary(env: NodeJS.ProcessEnv): CredentialSummary {
  const credentials = resolveRuntimeCodexCredentials({ env })
  const sources: string[] = []

  if (env.CODEX_API_KEY?.trim()) {
    sources.push('CODEX_API_KEY')
  }
  if (env.CODEX_ACCOUNT_ID?.trim()) {
    sources.push('CODEX_ACCOUNT_ID')
  } else if (env.CHATGPT_ACCOUNT_ID?.trim()) {
    sources.push('CHATGPT_ACCOUNT_ID')
  }

  if (credentials.source === 'auth.json') {
    if (env.CODEX_AUTH_JSON_PATH?.trim()) {
      sources.push('CODEX_AUTH_JSON_PATH')
    } else if (env.CODEX_HOME?.trim()) {
      sources.push('CODEX_HOME')
    } else {
      sources.push('auth.json')
    }
  } else if (credentials.source === 'secure-storage') {
    sources.push('secure-storage')
  }

  return {
    required: true,
    present: Boolean(credentials.apiKey && credentials.accountId),
    sources: [...new Set(sources)],
  }
}

function getKnownCredentialSourceNames(routeId: string): Set<string> {
  return new Set([
    ...collectProviderSecretEnvVars(),
    ...getRouteCredentialEnvVars(routeId),
    ...(routeId === 'codex'
      ? [
          'CODEX_API_KEY',
          'CODEX_ACCOUNT_ID',
          'CHATGPT_ACCOUNT_ID',
          'CODEX_AUTH_JSON_PATH',
          'CODEX_HOME',
          'auth.json',
          'secure-storage',
        ]
      : []),
  ])
}

function resolveDiagnosticProviderContext(
  env: NodeJS.ProcessEnv,
): DiagnosticProviderContext {
  if (isTruthy(env.CLAUDE_CODE_USE_OPENAI)) {
    const request = resolveProviderRequest({ processEnv: env })
    if (request.transport === 'codex_responses') {
      return {
        routeId: 'codex',
        label: 'Codex',
        providerType: 'Codex Responses API',
        model: request.requestedModel,
        limitsModel: request.resolvedModel,
        catalogRouteId: 'openai',
        baseUrl: request.baseUrl,
        credential: getCodexCredentialSummary(env),
      }
    }
  }

  const routeId = resolveRouteId(env)
  const descriptor = getRouteDescriptor(routeId)
  const model = resolveProviderModel(routeId, env)

  return {
    routeId,
    label: descriptor?.label ?? routeId,
    providerType: getRouteProviderTypeLabel(routeId),
    model,
    limitsModel: model,
    catalogRouteId: routeId,
    baseUrl: resolveProviderBaseUrl(routeId, env),
    ...(isTruthy(env.CLAUDE_CODE_USE_OPENAI) && env.OPENAI_API_FORMAT
      ? { apiFormat: env.OPENAI_API_FORMAT }
      : {}),
    credential: getCredentialSummary(routeId, env),
  }
}

function findCatalogEntry(
  routeId: string,
  model: string,
): ModelCatalogEntry | undefined {
  const normalizedModel = model.trim().toLowerCase()
  if (!normalizedModel) return undefined
  return getCatalogEntriesForRoute(routeId).find(entry => {
    return (
      entry.apiName.trim().toLowerCase() === normalizedModel ||
      entry.id.trim().toLowerCase() === normalizedModel
    )
  })
}

function buildModelSummary(
  catalogRouteId: string,
  model: string,
  limitsModel: string,
  env: NodeJS.ProcessEnv,
  baseUrl?: string,
): IssueReport['model'] {
  const descriptor = getRouteDescriptor(catalogRouteId)
  const catalogEntry =
    findCatalogEntry(catalogRouteId, limitsModel) ??
    findCatalogEntry(catalogRouteId, model)
  const limits = resolveModelRuntimeLimits({
    model: limitsModel,
    processEnv: env,
    baseUrl,
  })
  const fallbackCapabilities =
    catalogEntry?.capabilities ??
    descriptor?.catalog?.models?.find(entry => entry.default)?.capabilities ??
    {}

  return {
    contextWindow: limits.contextWindow,
    maxOutputTokens: limits.maxOutputTokens,
    catalogSource: resolveCatalogSource(catalogRouteId, descriptor, catalogEntry),
    capabilities: fallbackCapabilities,
  }
}

function resolveCatalogSource(
  routeId: string,
  descriptor: ReturnType<typeof getRouteDescriptor>,
  catalogEntry: ModelCatalogEntry | undefined,
): IssueReport['model']['catalogSource'] {
  if (catalogEntry) return descriptor?.catalog?.source ?? 'unknown'
  if (descriptor?.catalog?.discovery) return 'dynamic'
  if (routeId === 'custom') return 'custom'
  return 'unknown'
}

function summarizeSettings(
  options?: BuildIssueReportOptions['settings'],
): IssueReport['settings'] {
  if (options) {
    return {
      sourcesPresent: options.sourcesPresent,
      validationErrors: options.validationErrors.map(error => ({
        file: basename(redactHomePath(error.file ?? 'unknown')),
        path: error.path,
        message: redactLikelySecrets(redactHomePath(error.message)),
      })),
    }
  }

  const withSources = getSettingsWithSources()
  const withErrors = getSettingsWithErrors()

  return {
    sourcesPresent: withSources.sources.map(source => source.source),
    validationErrors: withErrors.errors.map(error => ({
      file: basename(redactHomePath(error.file ?? 'unknown')),
      path: error.path,
      message: redactLikelySecrets(redactHomePath(error.message)),
    })),
  }
}

function getMcpTransport(config: Partial<ScopedMcpServerConfig>): string {
  return config.type ?? 'stdio'
}

function summarizeMcpServers(
  servers: Record<string, Partial<ScopedMcpServerConfig>>,
): IssueReport['mcp'] {
  const transports: Record<string, number> = {}
  for (const config of Object.values(servers)) {
    const transport = getMcpTransport(config)
    transports[transport] = (transports[transport] ?? 0) + 1
  }
  return {
    serverCount: Object.keys(servers).length,
    transports,
  }
}

async function getMcpSummary(
  servers?: Record<string, Partial<ScopedMcpServerConfig>>,
): Promise<IssueReport['mcp']> {
  if (servers) return summarizeMcpServers(servers)
  try {
    const result = await getClaudeCodeMcpConfigs()
    return summarizeMcpServers(result.servers)
  } catch {
    return { serverCount: 0, transports: {} }
  }
}

function summarizeErrors(
  errors: Array<{ error: string; timestamp: string }>,
  includeDebug: boolean,
): IssueReport['errors'] {
  const counts = new Map<string, number>()
  const debug: string[] = []

  for (const entry of errors.slice(-20)) {
    const firstLine = entry.error.split(/\r?\n/, 1)[0] ?? entry.error
    const category =
      firstLine.match(/^([A-Za-z][A-Za-z0-9_ .-]{0,60})(?::|$)/)?.[1]?.trim() ||
      'Error'
    counts.set(category, (counts.get(category) ?? 0) + 1)
    if (includeDebug) {
      debug.push(redactLikelySecrets(redactHomePath(firstLine)).slice(0, 500))
    }
  }

  const recent = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([category, count]) => ({ category, count }))

  return includeDebug ? { recent, debug } : { recent }
}

async function buildChecks(
  cwd: string,
  options?: BuildIssueReportOptions['checks'],
): Promise<DiagnosticCheck[]> {
  const buildArtifactsPresent =
    options?.buildArtifactsPresent ?? existsSync(resolve(cwd, 'dist', 'cli.mjs'))
  if (!options?.ripgrep) {
    await testRipgrepOnFirstUse()
  }
  const ripgrep =
    options?.ripgrep ??
    (() => {
      const status = getRipgrepStatus()
      return {
        available: status.working ?? false,
        detail:
          status.working === null
            ? `${status.mode} ripgrep (not tested)`
            : status.mode === 'system' && status.path
              ? 'system rg'
              : `${status.mode} ripgrep`,
      }
    })()

  return [
    {
      label: 'Build artifacts',
      ok: buildArtifactsPresent,
      detail: buildArtifactsPresent ? 'dist/cli.mjs present' : 'dist/cli.mjs missing',
    },
    {
      label: 'ripgrep',
      ok: ripgrep.available,
      detail: ripgrep.detail,
    },
  ]
}

export async function buildIssueReport(
  options: BuildIssueReportOptions = {},
): Promise<IssueReport> {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const now = options.now ?? new Date()
  const packageInfo = readPackageInfo(options.packageInfo)
  const providerContext = resolveDiagnosticProviderContext(env)
  const mcp = await getMcpSummary(options.mcpServers)
  const settings = summarizeSettings(options.settings)
  const knownCredentialSourceNames = getKnownCredentialSourceNames(
    providerContext.routeId,
  )
  const activeCredentialSources = providerContext.credential.sources.filter(source =>
    knownCredentialSourceNames.has(source),
  )

  const report: IssueReport = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    openclaude: {
      version: packageInfo.version,
      ...(packageInfo.displayVersion ? { displayVersion: packageInfo.displayVersion } : {}),
      ...(packageInfo.buildTime ? { buildTime: packageInfo.buildTime } : {}),
      source: detectSource(cwd),
    },
    workspace: {
      cwd: basename(cwd) || '(unknown)',
    },
    runtime: {
      platform: platform(),
      arch: arch(),
      node: process.versions.node,
      bun: (globalThis as { Bun?: { version?: string } }).Bun?.version ?? null,
      packageManager: readPackageManager(env),
      tty: {
        stdin: Boolean(process.stdin.isTTY),
        stdout: Boolean(process.stdout.isTTY),
        stderr: Boolean(process.stderr.isTTY),
      },
    },
    provider: {
      routeId: providerContext.routeId,
      label: providerContext.label,
      providerType: providerContext.providerType,
      model: providerContext.model,
      ...(providerContext.apiFormat ? { apiFormat: providerContext.apiFormat } : {}),
      ...(providerContext.baseUrl
        ? { baseUrl: redactDiagnosticUrl(providerContext.baseUrl) }
        : {}),
      credential: {
        ...providerContext.credential,
        sources: activeCredentialSources,
      },
    },
    model: buildModelSummary(
      providerContext.catalogRouteId,
      providerContext.model,
      providerContext.limitsModel,
      env,
      providerContext.baseUrl,
    ),
    settings,
    checks: await buildChecks(cwd, options.checks),
    mcp,
    errors: summarizeErrors(options.errors ?? getInMemoryErrors(), options.includeDebug ?? false),
    warnings: [],
    redaction: {
      homeRedacted: true,
      cwdRedacted: true,
      secretsIncluded: false,
    },
  }

  return redactDiagnosticObject(report) as IssueReport
}

function formatStatus(ok: boolean): string {
  return ok ? 'PASS' : 'WARN'
}

function tableEscape(value: string | number | boolean | null | undefined): string {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
}

export function formatIssueReportAsMarkdown(report: IssueReport): string {
  const lines = [
    '# OpenClaude diagnostic report',
    '',
    '## Summary',
    `- OpenClaude: ${report.openclaude.displayVersion ?? report.openclaude.version}`,
    `- Runtime: ${report.runtime.platform} ${report.runtime.arch}, Node ${report.runtime.node}`,
    `- Provider: ${report.provider.label} (${report.provider.routeId})`,
    `- Model: ${report.provider.model}`,
    '',
    '## Checks',
    '| Check | Status | Detail |',
    '| --- | --- | --- |',
    ...report.checks.map(check =>
      `| ${tableEscape(check.label)} | ${formatStatus(check.ok)} | ${tableEscape(check.detail)} |`,
    ),
    '',
    '## Provider',
    `- Route: ${report.provider.routeId}`,
    `- Type: ${report.provider.providerType}`,
    `- Base URL: ${report.provider.baseUrl ?? '(not set)'}`,
    `- Credential: ${report.provider.credential.present ? 'present' : 'missing'}${
      report.provider.credential.sources.length > 0
        ? ` (${report.provider.credential.sources.join(', ')})`
        : ''
    }`,
    '',
    '## Model',
    `- Catalog source: ${report.model.catalogSource}`,
    `- Context window: ${report.model.contextWindow ?? 'unknown'}`,
    `- Max output tokens: ${report.model.maxOutputTokens ?? 'unknown'}`,
    `- Capabilities: ${Object.entries(report.model.capabilities)
      .filter(([, enabled]) => enabled === true)
      .map(([name]) => name)
      .sort()
      .join(', ') || 'unknown'}`,
    '',
    '## Settings',
    `- Sources present: ${report.settings.sourcesPresent.join(', ') || 'none'}`,
    `- Validation errors: ${report.settings.validationErrors.length}`,
    '',
    '## MCP',
    `- Server count: ${report.mcp.serverCount}`,
    `- Transports: ${Object.entries(report.mcp.transports)
      .map(([transport, count]) => `${transport}: ${count}`)
      .join(', ') || 'none'}`,
    '',
    '## Recent Errors',
    report.errors.recent.length > 0
      ? report.errors.recent
          .map(error => `- ${error.category}: ${error.count}`)
          .join('\n')
      : '- none',
    '',
    '## Notes',
    'This report is redacted. It should not contain API keys, prompts, transcripts, or file contents.',
    '',
  ]

  return lines.join('\n')
}

export function formatIssueReportAsJson(report: IssueReport): string {
  return JSON.stringify(report, null, 2)
}

export function parseIssueReportArgs(args: string[]): IssueReportArgs {
  const parsed: IssueReportArgs = {
    format: 'markdown',
    outFile: null,
    includeDebug: false,
    redacted: true,
  }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--json') {
      parsed.format = 'json'
      continue
    }
    if (arg === '--markdown') {
      parsed.format = 'markdown'
      continue
    }
    if (arg === '--include-debug') {
      parsed.includeDebug = true
      continue
    }
    if (arg === '--redacted') {
      parsed.redacted = true
      continue
    }
    if (arg === '--out') {
      const outFile = args[index + 1]
      if (outFile && !outFile.startsWith('--')) {
        parsed.outFile = outFile
        index++
      }
      continue
    }
    if (arg.startsWith('--out=')) {
      parsed.outFile = arg.slice('--out='.length)
    }
  }

  return parsed
}

export function formatIssueReport(
  report: IssueReport,
  format: IssueReportFormat,
): string {
  return format === 'json'
    ? formatIssueReportAsJson(report)
    : formatIssueReportAsMarkdown(report)
}

export async function renderIssueReport(
  options: Partial<IssueReportArgs> & BuildIssueReportOptions = {},
): Promise<string> {
  const report = await buildIssueReport({
    ...options,
    includeDebug: options.includeDebug,
  })
  return formatIssueReport(report, options.format ?? 'markdown')
}

export function writeIssueReport(outFile: string, content: string): string {
  const outputPath = resolve(process.cwd(), outFile)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, content, 'utf8')
  return outputPath
}
