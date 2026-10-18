import type { ValidationError } from '../../utils/settings/validation.js'
import { clearServerCache, connectToServer } from './client.js'
import {
  getAllMcpConfigs,
  getMcpConfigsByScope,
  isMcpServerDisabled,
} from './config.js'
import type {
  ConfigScope,
  McpStdioServerConfig,
  ScopedMcpServerConfig,
} from './types.js'
import { describeMcpConfigFilePath, getProjectMcpServerStatus } from './utils.js'

export type McpDoctorSeverity = 'info' | 'warn' | 'error'
export type McpDoctorScopeFilter = 'local' | 'project' | 'user' | 'enterprise'

export type McpDoctorFinding = {
  blocking: boolean
  code: string
  message: string
  remediation?: string
  scope?: string
  serverName?: string
  severity: McpDoctorSeverity
  sourcePath?: string
}

export type McpDoctorLiveCheck = {
  attempted: boolean
  durationMs?: number
  error?: string
  result?: 'connected' | 'needs-auth' | 'failed' | 'pending' | 'disabled' | 'skipped'
}

export type McpDoctorDefinition = {
  name: string
  sourceType:
    | 'local'
    | 'project'
    | 'user'
    | 'enterprise'
    | 'managed'
    | 'plugin'
    | 'claudeai'
    | 'dynamic'
    | 'internal'
  sourcePath?: string
  transport?: string
  runtimeVisible: boolean
  runtimeActive: boolean
  pendingApproval?: boolean
  disabled?: boolean
}

export type McpDoctorServerReport = {
  serverName: string
  requestedByUser: boolean
  definitions: McpDoctorDefinition[]
  liveCheck: McpDoctorLiveCheck
  findings: McpDoctorFinding[]
}

export type McpDoctorDependencies = {
  getAllMcpConfigs: typeof getAllMcpConfigs
  getMcpConfigsByScope: typeof getMcpConfigsByScope
  getProjectMcpServerStatus: typeof getProjectMcpServerStatus
  isMcpServerDisabled: typeof isMcpServerDisabled
  describeMcpConfigFilePath: typeof describeMcpConfigFilePath
  connectToServer: typeof connectToServer
  clearServerCache: typeof clearServerCache
}

export type McpDoctorReport = {
  generatedAt: string
  targetName?: string
  scopeFilter?: McpDoctorScopeFilter
  configOnly: boolean
  summary: {
    totalReports: number
    healthy: number
    warnings: number
    blocking: number
  }
  findings: McpDoctorFinding[]
  servers: McpDoctorServerReport[]
}

const DEFAULT_DEPENDENCIES: McpDoctorDependencies = {
  getAllMcpConfigs,
  getMcpConfigsByScope,
  getProjectMcpServerStatus,
  isMcpServerDisabled,
  describeMcpConfigFilePath,
  connectToServer,
  clearServerCache,
}

export function buildEmptyDoctorReport(options: {
  configOnly: boolean
  scopeFilter?: McpDoctorScopeFilter
  targetName?: string
}): McpDoctorReport {
  return {
    generatedAt: new Date().toISOString(),
    targetName: options.targetName,
    scopeFilter: options.scopeFilter,
    configOnly: options.configOnly,
    summary: {
      totalReports: 0,
      healthy: 0,
      warnings: 0,
      blocking: 0,
    },
    findings: [],
    servers: [],
  }
}

function getFindingCode(error: ValidationError): string {
  if (error.message === 'MCP config is not a valid JSON') {
    return 'config.invalid_json'
  }
  if (error.message.startsWith('Missing environment variables:')) {
    return 'config.missing_env_vars'
  }
  if (error.message.includes("Windows requires 'cmd /c' wrapper to execute npx")) {
    return 'config.windows_npx_wrapper_required'
  }
  if (error.message === 'Does not adhere to MCP server configuration schema') {
    return 'config.invalid_schema'
  }
  return 'config.validation_error'
}

function getSeverity(error: ValidationError): McpDoctorSeverity {
  const severity = error.mcpErrorMetadata?.severity
  if (severity === 'fatal') {
    return 'error'
  }
  if (severity === 'warning') {
    return 'warn'
  }
  return 'warn'
}

export function findingsFromValidationErrors(
  validationErrors: ValidationError[],
): McpDoctorFinding[] {
  return validationErrors.map(error => {
    const severity = getSeverity(error)
    return {
      blocking: severity === 'error',
      code: getFindingCode(error),
      message: error.message,
      remediation: error.suggestion,
      scope: error.mcpErrorMetadata?.scope,
      serverName: error.mcpErrorMetadata?.serverName,
      severity,
      sourcePath: error.file,
    }
  })
}

function splitValidationFindings(validationFindings: McpDoctorFinding[]): {
  globalFindings: McpDoctorFinding[]
  serverFindingsByName: Map<string, McpDoctorFinding[]>
} {
  const globalFindings: McpDoctorFinding[] = []
  const serverFindingsByName = new Map<string, McpDoctorFinding[]>()

  for (const finding of validationFindings) {
    if (!finding.serverName) {
      globalFindings.push(finding)
      continue
    }

    const findings = serverFindingsByName.get(finding.serverName) ?? []
    findings.push(finding)
    serverFindingsByName.set(finding.serverName, findings)
  }

  return {
    globalFindings,
    serverFindingsByName,
  }
}

function getSourceType(config: ScopedMcpServerConfig): McpDoctorDefinition['sourceType'] {
  if (config.scope === 'claudeai') {
    return 'claudeai'
  }
  if (config.scope === 'dynamic') {
    return config.pluginSource ? 'plugin' : 'dynamic'
  }
  if (config.scope === 'managed') {
    return 'managed'
  }
  return config.scope
}

function getTransport(config: ScopedMcpServerConfig): string {
  return config.type ?? 'stdio'
}

function getConfigSignature(config: ScopedMcpServerConfig): string {
  switch (config.type) {
    case 'sse':
    case 'http':
    case 'ws':
    case 'claudeai-proxy':
      return `${config.scope}:${config.type}:${config.url}`
    case 'sdk':
      return `${config.scope}:${config.type}:${config.name}`
    default: {
      // 'sse-ide' / 'ws-ide' configs also land here; they carry no
      // command/args, so read them as optional stdio fields.
      const { command, args } = config as Partial<
        Pick<McpStdioServerConfig, 'command' | 'args'>
      >
      return `${config.scope}:${config.type ?? 'stdio'}:${command}:${JSON.stringify(args ?? [])}`
    }
  }
}

function isSameDefinition(
  config: ScopedMcpServerConfig,
  activeConfig: ScopedMcpServerConfig | undefined,
): boolean {
  if (!activeConfig) {
    return false
  }
  return getSourceType(config) === getSourceType(activeConfig) && getConfigSignature(config) === getConfigSignature(activeConfig)
}

function buildScopeDefinitions(
  name: string,
  scope: ConfigScope,
  servers: Record<string, ScopedMcpServerConfig>,
  activeConfig: ScopedMcpServerConfig | undefined,
  deps: McpDoctorDependencies,
): McpDoctorDefinition[] {
  // Own-property lookup: these maps are plain objects from JSON config, so a
  // bare servers[name] resolves inherited Object.prototype members and would
  // fabricate a definition for a name like 'constructor'.
  const config = Object.hasOwn(servers, name) ? servers[name] : undefined
  if (!config) {
    return []
  }

  const pendingApproval =
    scope === 'project' ? deps.getProjectMcpServerStatus(name) === 'pending' : false
  const disabled = deps.isMcpServerDisabled(name)
  const runtimeActive = !disabled && isSameDefinition(config, activeConfig)

  return [
    {
      name,
      sourceType: getSourceType(config),
      sourcePath: deps.describeMcpConfigFilePath(scope),
      transport: getTransport(config),
      runtimeVisible: runtimeActive,
      runtimeActive,
      pendingApproval,
      disabled,
    },
  ]
}

function shouldIncludeScope(
  scope: ConfigScope,
  scopeFilter: McpDoctorScopeFilter | undefined,
): boolean {
  if (!scopeFilter) {
    return scope === 'enterprise' || scope === 'local' || scope === 'project' || scope === 'user'
  }
  return scope === scopeFilter
}

function getValidationErrorsForSelectedScopes(
  scopeResults: {
    enterprise: ReturnType<McpDoctorDependencies['getMcpConfigsByScope']>
    local: ReturnType<McpDoctorDependencies['getMcpConfigsByScope']>
    project: ReturnType<McpDoctorDependencies['getMcpConfigsByScope']>
    user: ReturnType<McpDoctorDependencies['getMcpConfigsByScope']>
  },
  scopeFilter: McpDoctorScopeFilter | undefined,
): ValidationError[] {
  return [
    ...(shouldIncludeScope('enterprise', scopeFilter) ? scopeResults.enterprise.errors : []),
    ...(shouldIncludeScope('local', scopeFilter) ? scopeResults.local.errors : []),
    ...(shouldIncludeScope('project', scopeFilter) ? scopeResults.project.errors : []),
    ...(shouldIncludeScope('user', scopeFilter) ? scopeResults.user.errors : []),
  ]
}

function buildObservedDefinition(
  name: string,
  activeConfig: ScopedMcpServerConfig,
  options?: {
    disabled?: boolean
    runtimeActive?: boolean
    runtimeVisible?: boolean
  },
): McpDoctorDefinition {
  return {
    name,
    sourceType: getSourceType(activeConfig),
    sourcePath:
      getSourceType(activeConfig) === 'plugin'
        ? `plugin:${activeConfig.pluginSource ?? 'unknown'}`
        : getSourceType(activeConfig) === 'claudeai'
          ? 'claude.ai'
          : activeConfig.scope,
    transport: getTransport(activeConfig),
    runtimeVisible: options?.runtimeVisible ?? true,
    runtimeActive: options?.runtimeActive ?? true,
    disabled: options?.disabled ?? false,
  }
}

function hasDefinitionForRuntimeSource(
  definitions: McpDoctorDefinition[],
  runtimeConfig: ScopedMcpServerConfig,
  deps: McpDoctorDependencies,
): boolean {
  const runtimeSourceType = getSourceType(runtimeConfig)
  const runtimeSourcePath =
    runtimeSourceType === 'plugin'
      ? `plugin:${runtimeConfig.pluginSource ?? 'unknown'}`
      : runtimeSourceType === 'claudeai'
        ? 'claude.ai'
        : deps.describeMcpConfigFilePath(runtimeConfig.scope)

  return definitions.some(
    definition =>
      definition.sourceType === runtimeSourceType &&
      definition.sourcePath === runtimeSourcePath &&
      definition.transport === getTransport(runtimeConfig),
  )
}

function buildShadowingFindings(definitions: McpDoctorDefinition[]): McpDoctorFinding[] {
  const userEditable = definitions.filter(definition =>
    definition.sourceType === 'local' ||
    definition.sourceType === 'project' ||
    definition.sourceType === 'user' ||
    definition.sourceType === 'enterprise',
  )

  if (userEditable.length <= 1) {
    return []
  }

  const active = userEditable.find(definition => definition.runtimeActive) ?? userEditable[0]
  return [
    {
      blocking: false,
      code: 'duplicate.same_name_multiple_scopes',
      message: `Server is defined in multiple config scopes; active source is ${active.sourceType}`,
      remediation: 'Remove or rename one of the duplicate definitions to avoid confusion.',
      serverName: active.name,
      severity: 'warn',
    },
    {
      blocking: false,
      code: 'scope.shadowed',
      message: `${active.name} has shadowed definitions in lower-precedence config scopes.`,
      remediation: 'Inspect the other definitions and remove the ones you no longer want to keep.',
      serverName: active.name,
      severity: 'warn',
    },
  ]
}

function buildStateFindings(definitions: McpDoctorDefinition[]): McpDoctorFinding[] {
  const findings: McpDoctorFinding[] = []

  for (const definition of definitions) {
    if (definition.pendingApproval) {
      findings.push({
        blocking: false,
        code: 'state.pending_project_approval',
        message: `${definition.name} is declared in project config but pending project approval.`,
        remediation: 'Approve the server in the project MCP approval flow before expecting it to become active.',
        scope: 'project',
        serverName: definition.name,
        severity: 'warn',
        sourcePath: definition.sourcePath,
      })
    }

    if (definition.disabled) {
      findings.push({
        blocking: false,
        code: 'state.disabled',
        message: `${definition.name} is currently disabled.`,
        remediation: 'Re-enable the server before expecting it to be available at runtime.',
        serverName: definition.name,
        severity: 'warn',
        sourcePath: definition.sourcePath,
      })
    }
  }

  return findings
}

function summarizeReport(report: McpDoctorReport): McpDoctorReport {
  const allFindings = [...report.findings, ...report.servers.flatMap(server => server.findings)]
  const blocking = allFindings.filter(finding => finding.blocking).length
  const warnings = allFindings.filter(finding => finding.severity === 'warn').length
  const healthy = report.servers.filter(
    server =>
      server.liveCheck.result === 'connected' &&
      server.findings.every(finding => !finding.blocking && finding.severity !== 'warn'),
  ).length

  return {
    ...report,
    summary: {
      totalReports: report.servers.length,
      healthy,
      warnings,
      blocking,
    },
  }
}

async function getLiveCheck(
  name: string,
  activeConfig: ScopedMcpServerConfig | undefined,
  configOnly: boolean,
  definitions: McpDoctorDefinition[],
  deps: McpDoctorDependencies,
): Promise<McpDoctorLiveCheck> {
  if (configOnly) {
    return { attempted: false, result: 'skipped' }
  }

  if (!activeConfig) {
    if (definitions.some(definition => definition.pendingApproval)) {
      return { attempted: false, result: 'pending' }
    }
    if (definitions.some(definition => definition.disabled)) {
      return { attempted: false, result: 'disabled' }
    }
    return { attempted: false, result: 'skipped' }
  }

  const startedAt = Date.now()
  const connection = await deps.connectToServer(name, activeConfig)
  const durationMs = Date.now() - startedAt

  try {
    switch (connection.type) {
      case 'connected':
        return { attempted: true, result: 'connected', durationMs }
      case 'needs-auth':
        return { attempted: true, result: 'needs-auth', durationMs }
      case 'disabled':
        return { attempted: true, result: 'disabled', durationMs }
      case 'pending':
        return { attempted: true, result: 'pending', durationMs }
      case 'failed':
        return {
          attempted: true,
          result: 'failed',
          durationMs,
          error: connection.error,
        }
    }
    return { attempted: true, result: 'failed', durationMs }
  } finally {
    await deps.clearServerCache(name, activeConfig).catch(() => {
      // Best-effort cleanup for diagnostic connections.
    })
  }
}

function buildLiveFindings(
  name: string,
  definitions: McpDoctorDefinition[],
  liveCheck: McpDoctorLiveCheck,
): McpDoctorFinding[] {
  const activeDefinition = definitions.find(definition => definition.runtimeActive)

  if (liveCheck.result === 'needs-auth') {
    return [
      {
        blocking: false,
        code: 'auth.needs_auth',
        message: `${name} requires authentication before it can be used.`,
        remediation: 'Authenticate the server and then rerun the doctor command.',
        serverName: name,
        severity: 'warn',
        sourcePath: activeDefinition?.sourcePath,
      },
    ]
  }

  if (liveCheck.result === 'failed') {
    const commandNotFound =
      activeDefinition?.transport === 'stdio' &&
      typeof liveCheck.error === 'string' &&
      liveCheck.error.toLowerCase().includes('not found')

    return [
      {
        blocking: true,
        code: commandNotFound ? 'stdio.command_not_found' : 'health.failed',
        message: liveCheck.error
          ? `${name} failed its live health check: ${liveCheck.error}`
          : `${name} failed its live health check.`,
        remediation: commandNotFound
          ? 'Verify the configured executable exists on PATH or use a full executable path.'
          : 'Inspect the server configuration and retry the connection once the underlying problem is fixed.',
        serverName: name,
        severity: 'error',
        sourcePath: activeDefinition?.sourcePath,
      },
    ]
  }

  return []
}

async function buildServerReport(
  name: string,
  options: {
    configOnly: boolean
    requestedByUser: boolean
    scopeFilter?: McpDoctorScopeFilter
  },
  validationFindingsByName: Map<string, McpDoctorFinding[]>,
  deps: McpDoctorDependencies,
): Promise<McpDoctorServerReport> {
  const scopeResults = {
    enterprise: deps.getMcpConfigsByScope('enterprise'),
    local: deps.getMcpConfigsByScope('local'),
    project: deps.getMcpConfigsByScope('project'),
    user: deps.getMcpConfigsByScope('user'),
  }
  const { servers: activeServers } = await deps.getAllMcpConfigs()
  const serverDisabled = deps.isMcpServerDisabled(name)
  const runtimeConfig = Object.hasOwn(activeServers, name)
    ? activeServers[name]
    : undefined
  const activeConfig = serverDisabled ? undefined : runtimeConfig

  const definitions = [
    ...(shouldIncludeScope('enterprise', options.scopeFilter)
      ? buildScopeDefinitions(name, 'enterprise', scopeResults.enterprise.servers, activeConfig, deps)
      : []),
    ...(shouldIncludeScope('local', options.scopeFilter)
      ? buildScopeDefinitions(name, 'local', scopeResults.local.servers, activeConfig, deps)
      : []),
    ...(shouldIncludeScope('project', options.scopeFilter)
      ? buildScopeDefinitions(name, 'project', scopeResults.project.servers, activeConfig, deps)
      : []),
    ...(shouldIncludeScope('user', options.scopeFilter)
      ? buildScopeDefinitions(name, 'user', scopeResults.user.servers, activeConfig, deps)
      : []),
  ]

  const shouldAddObservedDefinition =
    !!runtimeConfig &&
    !hasDefinitionForRuntimeSource(definitions, runtimeConfig, deps) &&
    ((definitions.length === 0 && !options.scopeFilter) ||
      (definitions.length > 0 && definitions.every(definition => !definition.runtimeActive)))

  if (runtimeConfig && shouldAddObservedDefinition) {
    definitions.push(
      buildObservedDefinition(name, runtimeConfig, {
        disabled: serverDisabled,
        runtimeActive: !serverDisabled,
        runtimeVisible: !serverDisabled,
      }),
    )
  }

  const visibleRuntimeConfig =
    definitions.some(definition => definition.runtimeActive) || shouldAddObservedDefinition
      ? activeConfig
      : undefined

  const nameValidationFindings = validationFindingsByName.get(name) ?? []
  const findings: McpDoctorFinding[] = [
    ...nameValidationFindings,
    ...buildShadowingFindings(definitions),
    ...buildStateFindings(definitions),
  ]

  // A reserved-name target (`__proto__`/`constructor`) never survives parsing,
  // so it has no definition -- but its fatal validation finding already names
  // the problem. Adding `state.not_found` on top would report two blocking
  // findings with contradictory messages, so skip it when validation already
  // explains this name.
  if (
    definitions.length === 0 &&
    !shouldAddObservedDefinition &&
    nameValidationFindings.length === 0
  ) {
    findings.push({
      blocking: true,
      code: 'state.not_found',
      message: `${name} was not found in the selected MCP configuration sources.`,
      remediation: 'Check the server name and scope, or add the MCP server before retrying.',
      serverName: name,
      severity: 'error',
    })
  }

  const liveCheck = await getLiveCheck(name, visibleRuntimeConfig, options.configOnly, definitions, deps)
  findings.push(...buildLiveFindings(name, definitions, liveCheck))

  return {
    serverName: name,
    requestedByUser: options.requestedByUser,
    definitions,
    liveCheck,
    findings,
  }
}

function getServerNames(
  scopeServers: Array<Record<string, ScopedMcpServerConfig>>,
  activeServers: Record<string, ScopedMcpServerConfig>,
  includeActiveServers: boolean,
): string[] {
  const names = new Set<string>(includeActiveServers ? Object.keys(activeServers) : [])
  for (const servers of scopeServers) {
    for (const name of Object.keys(servers)) {
      names.add(name)
    }
  }
  return [...names].sort()
}

export async function doctorAllServers(
  options: { configOnly: boolean; scopeFilter?: McpDoctorScopeFilter } = {
    configOnly: false,
  },
  deps: McpDoctorDependencies = DEFAULT_DEPENDENCIES,
): Promise<McpDoctorReport> {
  const report = buildEmptyDoctorReport(options)
  const scopeResults = {
    enterprise: deps.getMcpConfigsByScope('enterprise'),
    local: deps.getMcpConfigsByScope('local'),
    project: deps.getMcpConfigsByScope('project'),
    user: deps.getMcpConfigsByScope('user'),
  }
  const validationFindings = findingsFromValidationErrors(
    getValidationErrorsForSelectedScopes(scopeResults, options.scopeFilter),
  )
  const { globalFindings, serverFindingsByName } = splitValidationFindings(validationFindings)
  const { servers: activeServers } = await deps.getAllMcpConfigs()
  const names = getServerNames(
    [
      ...(shouldIncludeScope('enterprise', options.scopeFilter) ? [scopeResults.enterprise.servers] : []),
      ...(shouldIncludeScope('local', options.scopeFilter) ? [scopeResults.local.servers] : []),
      ...(shouldIncludeScope('project', options.scopeFilter) ? [scopeResults.project.servers] : []),
      ...(shouldIncludeScope('user', options.scopeFilter) ? [scopeResults.user.servers] : []),
    ],
    activeServers,
    !options.scopeFilter,
  )

  const servers = await Promise.all(
    names.map(name =>
      buildServerReport(
        name,
        {
          configOnly: options.configOnly,
          requestedByUser: false,
          scopeFilter: options.scopeFilter,
        },
        serverFindingsByName,
        deps,
      ),
    ),
  )

  // Validation findings are keyed by server name, but a fatal reserved-name
  // error ("__proto__"/"constructor") is keyed by a name that never survives
  // parsing, so it is absent from `names` and its finding would otherwise be
  // built into no server report and silently dropped -- `mcp doctor
  // --config-only` would read clean while the invalid config is present.
  // Surface any finding whose server has no report as a global finding.
  const reportedNames = new Set(names)
  const orphanedFindings = Array.from(serverFindingsByName.entries())
    .filter(([name]) => !reportedNames.has(name))
    .flatMap(([, findings]) => findings)

  report.servers = servers
  report.findings = [...globalFindings, ...orphanedFindings]
  return summarizeReport(report)
}

export async function doctorServer(
  name: string,
  options: { configOnly: boolean; scopeFilter?: McpDoctorScopeFilter },
  deps: McpDoctorDependencies = DEFAULT_DEPENDENCIES,
): Promise<McpDoctorReport> {
  const report = buildEmptyDoctorReport({ ...options, targetName: name })
  const scopeResults = {
    enterprise: deps.getMcpConfigsByScope('enterprise'),
    local: deps.getMcpConfigsByScope('local'),
    project: deps.getMcpConfigsByScope('project'),
    user: deps.getMcpConfigsByScope('user'),
  }
  const validationFindings = findingsFromValidationErrors(
    getValidationErrorsForSelectedScopes(scopeResults, options.scopeFilter),
  )
  const { globalFindings, serverFindingsByName } = splitValidationFindings(validationFindings)
  const server = await buildServerReport(
    name,
    {
      configOnly: options.configOnly,
      requestedByUser: true,
      scopeFilter: options.scopeFilter,
    },
    serverFindingsByName,
    deps,
  )
  report.servers = [server]
  // Mirror the orphan fold in doctorAllServers: a fatal reserved-name finding is
  // keyed by a name that never survives parsing, so unless it happens to be the
  // requested target it is built into no report. Promote any finding for a name
  // other than the one reported so a poisoned sibling scope is not hidden --
  // e.g. `mcp doctor realserver` while `.mcp.json` still carries `__proto__`.
  const orphanedFindings = Array.from(serverFindingsByName.entries())
    .filter(([findingName]) => findingName !== name)
    .flatMap(([, findings]) => findings)
  report.findings = [...globalFindings, ...orphanedFindings]
  return summarizeReport(report)
}
