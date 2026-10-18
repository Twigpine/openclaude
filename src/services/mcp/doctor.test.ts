import assert from 'node:assert/strict'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import memoize from 'lodash-es/memoize.js'

import type { ValidationError } from '../../utils/settings/validation.js'

import {
  buildEmptyDoctorReport,
  doctorAllServers,
  doctorServer,
  findingsFromValidationErrors,
  type McpDoctorDependencies,
} from './doctor.js'
import { getServerCacheKey } from './client.js'
import type {
  ConfigScope,
  MCPServerConnection,
  ScopedMcpServerConfig,
} from './types.js'

type AllConfigResult = Awaited<ReturnType<McpDoctorDependencies['getAllMcpConfigs']>>
type ScopeConfigResult = ReturnType<McpDoctorDependencies['getMcpConfigsByScope']>
type ConnectToServerHandler = (
  ...args: Parameters<McpDoctorDependencies['connectToServer']>
) => ReturnType<McpDoctorDependencies['connectToServer']>
type ConfigFileScope = Extract<ConfigScope, 'enterprise' | 'local' | 'project' | 'user'>
type McpDoctorDependencyOverrides = Partial<
  Omit<McpDoctorDependencies, 'connectToServer'> & {
    connectToServer: ConnectToServerHandler
  }
>

function stdioConfig(scope: ConfigFileScope, command: string): ScopedMcpServerConfig {
  return {
    type: 'stdio' as const,
    command,
    args: [],
    scope,
  }
}

function allConfig(
  servers: Record<string, ScopedMcpServerConfig> = {},
  errors: AllConfigResult['errors'] = [],
): AllConfigResult {
  return { servers, errors }
}

function scopeConfig(
  servers: Record<string, ScopedMcpServerConfig> = {},
  errors: ValidationError[] = [],
): ScopeConfigResult {
  return { servers, errors }
}

function connectedServer(name: string, config: ScopedMcpServerConfig): MCPServerConnection {
  return {
    name,
    type: 'connected',
    client: new Client({ name: 'test-client', version: '0.0.0' }),
    capabilities: {},
    config,
    cleanup: async () => {},
  }
}

function failedServer(
  name: string,
  config: ScopedMcpServerConfig,
  error: string,
): MCPServerConnection {
  return {
    name,
    type: 'failed',
    config,
    error,
  }
}

function needsAuthServer(name: string, config: ScopedMcpServerConfig): MCPServerConnection {
  return {
    name,
    type: 'needs-auth',
    config,
  }
}

function connectMock(handler: ConnectToServerHandler): McpDoctorDependencies['connectToServer'] {
  return memoize(handler, getServerCacheKey)
}

function makeDependencies(overrides: McpDoctorDependencyOverrides = {}): McpDoctorDependencies {
  const {
    connectToServer = async (name, config) => connectedServer(name, config),
    ...rest
  } = overrides

  return {
    getAllMcpConfigs: async () => allConfig(),
    getMcpConfigsByScope: () => scopeConfig(),
    getProjectMcpServerStatus: () => 'approved',
    isMcpServerDisabled: () => false,
    describeMcpConfigFilePath: scope => `scope://${scope}`,
    clearServerCache: async () => {},
    connectToServer: connectMock(connectToServer),
    ...rest,
  }
}

test('buildEmptyDoctorReport returns zeroed summary', () => {
  const report = buildEmptyDoctorReport({
    configOnly: true,
    scopeFilter: 'project',
    targetName: 'filesystem',
  })

  assert.equal(report.targetName, 'filesystem')
  assert.equal(report.scopeFilter, 'project')
  assert.equal(report.configOnly, true)
  assert.deepEqual(report.summary, {
    totalReports: 0,
    healthy: 0,
    warnings: 0,
    blocking: 0,
  })
  assert.deepEqual(report.findings, [])
  assert.deepEqual(report.servers, [])
})

test('findingsFromValidationErrors maps missing env warnings into doctor findings', () => {
  const validationErrors: ValidationError[] = [
    {
      file: '.mcp.json',
      path: 'mcpServers.filesystem',
      message: 'Missing environment variables: API_KEY, API_URL',
      suggestion: 'Set the following environment variables: API_KEY, API_URL',
      mcpErrorMetadata: {
        scope: 'project',
        serverName: 'filesystem',
        severity: 'warning',
      },
    },
  ]

  const findings = findingsFromValidationErrors(validationErrors)

  assert.equal(findings.length, 1)
  assert.deepEqual(findings[0], {
    blocking: false,
    code: 'config.missing_env_vars',
    message: 'Missing environment variables: API_KEY, API_URL',
    remediation: 'Set the following environment variables: API_KEY, API_URL',
    scope: 'project',
    serverName: 'filesystem',
    severity: 'warn',
    sourcePath: '.mcp.json',
  })
})

test('findingsFromValidationErrors maps Windows npx warnings into doctor findings', () => {
  const validationErrors: ValidationError[] = [
    {
      file: '.mcp.json',
      path: 'mcpServers.node-tools',
      message: "Windows requires 'cmd /c' wrapper to execute npx",
      suggestion:
        'Change command to "cmd" with args ["/c", "npx", ...]. See: https://code.claude.com/docs/en/mcp#configure-mcp-servers',
      mcpErrorMetadata: {
        scope: 'project',
        serverName: 'node-tools',
        severity: 'warning',
      },
    },
  ]

  const findings = findingsFromValidationErrors(validationErrors)

  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.code, 'config.windows_npx_wrapper_required')
  assert.equal(findings[0]?.serverName, 'node-tools')
  assert.equal(findings[0]?.severity, 'warn')
  assert.equal(findings[0]?.blocking, false)
})

test('findingsFromValidationErrors maps fatal parse errors into blocking findings', () => {
  const validationErrors: ValidationError[] = [
    {
      file: 'C:/repo/.mcp.json',
      path: '',
      message: 'MCP config is not a valid JSON',
      suggestion: 'Fix the JSON syntax errors in the file',
      mcpErrorMetadata: {
        scope: 'project',
        severity: 'fatal',
      },
    },
  ]

  const findings = findingsFromValidationErrors(validationErrors)

  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.code, 'config.invalid_json')
  assert.equal(findings[0]?.severity, 'error')
  assert.equal(findings[0]?.blocking, true)
})

test('doctorAllServers reports global validation findings once without duplicating them into every server', async () => {
  const localConfig = stdioConfig('local', 'node-local')
  const deps = makeDependencies({
    getAllMcpConfigs: async () => allConfig({ filesystem: localConfig }),
    getMcpConfigsByScope: scope =>
      scope === 'project'
        ? scopeConfig(
            {},
            [
              {
                file: '.mcp.json',
                path: '',
                message: 'MCP config is not a valid JSON',
                suggestion: 'Fix the JSON syntax errors in the file',
                mcpErrorMetadata: {
                  scope: 'project',
                  severity: 'fatal',
                },
              },
            ],
          )
        : scope === 'local'
          ? scopeConfig({ filesystem: localConfig })
          : scopeConfig(),
  })

  const report = await doctorAllServers({ configOnly: true }, deps)

  assert.equal(report.summary.totalReports, 1)
  assert.equal(report.summary.blocking, 1)
  assert.equal(report.findings.length, 1)
  assert.equal(report.findings[0]?.code, 'config.invalid_json')
  assert.deepEqual(report.servers[0]?.findings, [])
})

test('doctorAllServers surfaces a finding for a name that produced no server report', async () => {
  // A fatal reserved-name error ("__proto__") is keyed by a server name that
  // never survives parsing, so it is absent from the active/parsed name set and
  // gets no server report. Its finding must still be emitted -- otherwise
  // `mcp doctor --config-only` reads clean while the invalid config is present.
  const deps = makeDependencies({
    getAllMcpConfigs: async () => allConfig(),
    getMcpConfigsByScope: scope =>
      scope === 'project'
        ? scopeConfig({}, [
            {
              file: '.mcp.json',
              path: 'mcpServers.__proto__',
              message: 'Invalid MCP server name "__proto__": this name is reserved.',
              suggestion: 'Rename the "__proto__" entry under mcpServers.',
              mcpErrorMetadata: {
                scope: 'project',
                serverName: '__proto__',
                severity: 'fatal',
              },
            },
          ])
        : scopeConfig(),
  })

  const report = await doctorAllServers({ configOnly: true }, deps)

  const reserved = report.findings.find(f => f.serverName === '__proto__')
  assert.ok(reserved, 'reserved-name finding should surface globally')
  assert.equal(reserved?.blocking, true)
  assert.equal(report.summary.blocking, 1)
})

const PROTO_RESERVED_ERROR: ValidationError = {
  file: '.mcp.json',
  path: 'mcpServers.__proto__',
  message: 'Invalid MCP server name "__proto__": this name is reserved.',
  suggestion: 'Rename the "__proto__" entry under mcpServers.',
  mcpErrorMetadata: {
    scope: 'project',
    serverName: '__proto__',
    severity: 'fatal',
  },
}

test('doctorServer surfaces a poisoned sibling scope while reporting another target', async () => {
  // `mcp doctor realserver` with realserver in user settings but a poisoned
  // project .mcp.json must not exit 0 with the fatal project error hidden. The
  // reserved-name finding is keyed by a name that never survives parsing, so
  // only the orphan fold surfaces it.
  const deps = makeDependencies({
    getAllMcpConfigs: async () =>
      allConfig({ realserver: stdioConfig('user', 'node') }),
    getMcpConfigsByScope: scope =>
      scope === 'user'
        ? scopeConfig({ realserver: stdioConfig('user', 'node') })
        : scope === 'project'
          ? scopeConfig({}, [PROTO_RESERVED_ERROR])
          : scopeConfig(),
  })

  const report = await doctorServer('realserver', { configOnly: true }, deps)

  const reserved = report.findings.find(f => f.serverName === '__proto__')
  assert.ok(reserved, 'poisoned sibling finding must surface')
  assert.equal(reserved?.blocking, true)
  assert.ok(report.summary.blocking >= 1)
})

test('doctorServer does not add not_found when a reserved-name finding already explains the target', async () => {
  // `mcp doctor __proto__` against a file that still carries that entry attaches
  // the fatal reserved-name finding; pushing state.not_found on top would report
  // two blocking findings with contradictory messages.
  const deps = makeDependencies({
    getMcpConfigsByScope: scope =>
      scope === 'project'
        ? scopeConfig({}, [PROTO_RESERVED_ERROR])
        : scopeConfig(),
  })

  const report = await doctorServer('__proto__', { configOnly: true }, deps)

  const server = report.servers[0]
  assert.ok(
    server?.findings.some(f => f.serverName === '__proto__' && f.blocking),
    'reserved-name finding should explain the target',
  )
  assert.equal(
    server?.findings.some(f => f.code === 'state.not_found'),
    false,
    'not_found must not double up on the reserved-name finding',
  )
  assert.equal(report.summary.blocking, 1)
})

test('doctorServer explains same-name shadowing across scopes', async () => {
  const localConfig = stdioConfig('local', 'node-local')
  const userConfig = stdioConfig('user', 'node-user')
  const deps = makeDependencies({
    getAllMcpConfigs: async () => allConfig({ filesystem: localConfig }),
    getMcpConfigsByScope: scope => {
      switch (scope) {
        case 'local':
          return scopeConfig({ filesystem: localConfig })
        case 'user':
          return scopeConfig({ filesystem: userConfig })
        default:
          return scopeConfig()
      }
    },
  })

  const report = await doctorServer('filesystem', { configOnly: true }, deps)
  assert.equal(report.servers.length, 1)
  assert.equal(report.servers[0]?.definitions.length, 2)
  assert.equal(report.servers[0]?.definitions.find(def => def.sourceType === 'local')?.runtimeActive, true)
  assert.equal(report.servers[0]?.definitions.find(def => def.sourceType === 'user')?.runtimeActive, false)
  assert.deepEqual(
    report.servers[0]?.findings.map(finding => finding.code).sort(),
    ['duplicate.same_name_multiple_scopes', 'scope.shadowed'],
  )
})

test('doctorServer reports project servers pending approval', async () => {
  const projectConfig = stdioConfig('project', 'node-project')
  const deps = makeDependencies({
    getMcpConfigsByScope: scope =>
      scope === 'project'
        ? scopeConfig({ sentry: projectConfig })
        : scopeConfig(),
    getProjectMcpServerStatus: name => (name === 'sentry' ? 'pending' : 'approved'),
  })

  const report = await doctorServer('sentry', { configOnly: true }, deps)
  assert.equal(report.servers.length, 1)
  assert.equal(report.servers[0]?.definitions[0]?.pendingApproval, true)
  assert.equal(report.servers[0]?.definitions[0]?.runtimeActive, false)
  assert.equal(report.servers[0]?.definitions[0]?.runtimeVisible, false)
  assert.equal(
    report.servers[0]?.findings.some(finding => finding.code === 'state.pending_project_approval'),
    true,
  )
})

test('doctorServer does not treat disabled servers as runtime-active or live-check targets', async () => {
  let connectCalls = 0
  const localConfig = stdioConfig('local', 'node-local')
  const deps = makeDependencies({
    getAllMcpConfigs: async () => allConfig({ github: localConfig }),
    getMcpConfigsByScope: scope =>
      scope === 'local'
        ? scopeConfig({ github: localConfig })
        : scopeConfig(),
    isMcpServerDisabled: name => name === 'github',
    connectToServer: async (name, config) => {
      connectCalls += 1
      return failedServer(name, config, 'should not connect')
    },
  })

  const report = await doctorServer('github', { configOnly: false }, deps)

  assert.equal(connectCalls, 0)
  assert.equal(report.summary.blocking, 0)
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.servers[0]?.definitions[0]?.disabled, true)
  assert.equal(report.servers[0]?.definitions[0]?.runtimeActive, false)
  assert.equal(report.servers[0]?.definitions[0]?.runtimeVisible, false)
  assert.equal(report.servers[0]?.liveCheck.result, 'disabled')
  assert.equal(
    report.servers[0]?.findings.some(finding => finding.code === 'state.disabled' && finding.severity === 'warn'),
    true,
  )
})

test('doctorAllServers skips live checks in config-only mode', async () => {
  let connectCalls = 0
  const localConfig = stdioConfig('local', 'node-local')
  const deps = makeDependencies({
    getAllMcpConfigs: async () => allConfig({ linear: localConfig }),
    getMcpConfigsByScope: scope =>
      scope === 'local'
        ? scopeConfig({ linear: localConfig })
        : scopeConfig(),
    connectToServer: async (name, config) => {
      connectCalls += 1
      return connectedServer(name, config)
    },
  })

  const report = await doctorAllServers({ configOnly: true }, deps)
  assert.equal(connectCalls, 0)
  assert.equal(report.servers[0]?.liveCheck.attempted, false)
  assert.equal(report.servers[0]?.liveCheck.result, 'skipped')
})

test('doctorAllServers honors scopeFilter when collecting names', async () => {
  const pluginConfig = {
    type: 'http' as const,
    url: 'https://example.test/mcp',
    scope: 'dynamic' as const,
    pluginSource: 'plugin:github@official',
  }
  const deps = makeDependencies({
    getAllMcpConfigs: async () => allConfig({ 'plugin:github:github': pluginConfig }),
  })

  const report = await doctorAllServers({ configOnly: true, scopeFilter: 'user' }, deps)

  assert.equal(report.summary.totalReports, 0)
  assert.deepEqual(report.servers, [])
})

test('doctorAllServers honors scopeFilter when collecting validation errors', async () => {
  const userConfig = stdioConfig('user', 'node-user')
  const deps = makeDependencies({
    getAllMcpConfigs: async () => allConfig({ filesystem: userConfig }),
    getMcpConfigsByScope: scope => {
      switch (scope) {
        case 'project':
          return scopeConfig(
            {},
            [
              {
                file: '.mcp.json',
                path: '',
                message: 'MCP config is not a valid JSON',
                suggestion: 'Fix the JSON syntax errors in the file',
                mcpErrorMetadata: {
                  scope: 'project',
                  severity: 'fatal',
                },
              },
            ],
          )
        case 'user':
          return scopeConfig({ filesystem: userConfig })
        default:
          return scopeConfig()
      }
    },
  })

  const report = await doctorAllServers({ configOnly: true, scopeFilter: 'user' }, deps)

  assert.equal(report.summary.totalReports, 1)
  assert.equal(report.summary.blocking, 0)
  assert.deepEqual(report.findings, [])
  assert.deepEqual(report.servers[0]?.findings, [])
})

test('doctorAllServers includes observed runtime definitions for plugin-only servers', async () => {
  const pluginConfig = {
    type: 'http' as const,
    url: 'https://example.test/mcp',
    scope: 'dynamic' as const,
    pluginSource: 'plugin:github@official',
  }
  const deps = makeDependencies({
    getAllMcpConfigs: async () => allConfig({ 'plugin:github:github': pluginConfig }),
  })

  const report = await doctorAllServers({ configOnly: true }, deps)

  assert.equal(report.summary.totalReports, 1)
  assert.equal(report.servers[0]?.definitions.length, 1)
  assert.equal(report.servers[0]?.definitions[0]?.sourceType, 'plugin')
  assert.equal(report.servers[0]?.definitions[0]?.runtimeActive, true)
})

test('doctorAllServers reports disabled plugin servers as disabled, not not-found', async () => {
  const pluginConfig = {
    type: 'http' as const,
    url: 'https://example.test/mcp',
    scope: 'dynamic' as const,
    pluginSource: 'plugin:github@official',
  }
  const deps = makeDependencies({
    getAllMcpConfigs: async () => allConfig({ 'plugin:github:github': pluginConfig }),
    isMcpServerDisabled: name => name === 'plugin:github:github',
  })

  const report = await doctorAllServers({ configOnly: true }, deps)

  assert.equal(report.summary.totalReports, 1)
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.summary.blocking, 0)
  assert.equal(report.servers[0]?.definitions.length, 1)
  assert.equal(report.servers[0]?.definitions[0]?.sourceType, 'plugin')
  assert.equal(report.servers[0]?.definitions[0]?.disabled, true)
  assert.equal(report.servers[0]?.definitions[0]?.runtimeActive, false)
  assert.equal(
    report.servers[0]?.findings.some(finding => finding.code === 'state.disabled' && !finding.blocking),
    true,
  )
  assert.equal(
    report.servers[0]?.findings.some(finding => finding.code === 'state.not_found'),
    false,
  )
})

test('doctorServer converts failed live checks into blocking findings', async () => {
  const localConfig = stdioConfig('local', 'node-local')
  const deps = makeDependencies({
    getAllMcpConfigs: async () => allConfig({ github: localConfig }),
    getMcpConfigsByScope: scope =>
      scope === 'local'
        ? scopeConfig({ github: localConfig })
        : scopeConfig(),
    connectToServer: async (name, config) =>
      failedServer(name, config, 'command not found: node-local'),
  })

  const report = await doctorServer('github', { configOnly: false }, deps)

  assert.equal(report.summary.blocking, 1)
  assert.equal(report.servers[0]?.liveCheck.result, 'failed')
  assert.equal(
    report.servers[0]?.findings.some(
      finding => finding.code === 'stdio.command_not_found' && finding.blocking,
    ),
    true,
  )
})

test('doctorServer converts needs-auth live checks into warning findings', async () => {
  const localConfig = stdioConfig('local', 'node-local')
  const deps = makeDependencies({
    getAllMcpConfigs: async () => allConfig({ sentry: localConfig }),
    getMcpConfigsByScope: scope =>
      scope === 'local'
        ? scopeConfig({ sentry: localConfig })
        : scopeConfig(),
    connectToServer: async (name, config) => needsAuthServer(name, config),
  })

  const report = await doctorServer('sentry', { configOnly: false }, deps)

  assert.equal(report.summary.warnings, 1)
  assert.equal(report.summary.blocking, 0)
  assert.equal(
    report.servers[0]?.findings.some(finding => finding.code === 'auth.needs_auth' && finding.severity === 'warn'),
    true,
  )
})

test('doctorServer includes observed runtime definition for plugin-only targets', async () => {
  const pluginConfig = {
    type: 'http' as const,
    url: 'https://example.test/mcp',
    scope: 'dynamic' as const,
    pluginSource: 'plugin:github@official',
  }
  const deps = makeDependencies({
    getAllMcpConfigs: async () => allConfig({ 'plugin:github:github': pluginConfig }),
  })

  const report = await doctorServer('plugin:github:github', { configOnly: true }, deps)

  assert.equal(report.summary.totalReports, 1)
  assert.equal(report.servers[0]?.definitions.length, 1)
  assert.equal(report.servers[0]?.definitions[0]?.sourceType, 'plugin')
  assert.equal(report.servers[0]?.definitions[0]?.runtimeActive, true)
})

test('doctorServer with scopeFilter does not leak runtime definition from another scope when target is absent', async () => {
  let connectCalls = 0
  const localConfig = stdioConfig('local', 'node-local')
  const deps = makeDependencies({
    getAllMcpConfigs: async () => allConfig({ github: localConfig }),
    getMcpConfigsByScope: scope =>
      scope === 'local'
        ? scopeConfig({ github: localConfig })
        : scopeConfig(),
    connectToServer: async (name, config) => {
      connectCalls += 1
      return connectedServer(name, config)
    },
  })

  const report = await doctorServer('github', { configOnly: false, scopeFilter: 'user' }, deps)

  assert.equal(connectCalls, 0)
  assert.equal(report.summary.totalReports, 1)
  assert.equal(report.summary.blocking, 1)
  assert.deepEqual(report.servers[0]?.definitions, [])
  assert.equal(report.servers[0]?.liveCheck.result, 'skipped')
  assert.equal(
    report.servers[0]?.findings.some(finding => finding.code === 'state.not_found' && finding.blocking),
    true,
  )
})

test('doctorServer reports blocking not-found state when no definition exists', async () => {
  const report = await doctorServer('missing-server', { configOnly: true }, makeDependencies())

  assert.equal(report.summary.blocking, 1)
  assert.equal(report.servers[0]?.findings.some(finding => finding.code === 'state.not_found' && finding.blocking), true)
})
