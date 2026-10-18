import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import {
  getAllowedSettingSources,
  setAllowedSettingSources,
} from '../../bootstrap/state.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import {
  getCurrentProjectConfig,
  getGlobalConfig,
  saveCurrentProjectConfig,
  saveGlobalConfig,
} from '../../utils/config.js'
import {
  SETTING_SOURCES,
  type SettingSource,
} from '../../utils/settings/constants.js'
import { getManagedFilePath } from '../../utils/settings/managedPath.js'
import { doesEnterpriseMcpConfigExist, getMcpConfigByName } from './config.js'

// getManagedFilePath / doesEnterpriseMcpConfigExist are lodash-memoized; clear
// their caches so the env override below is observed and does not leak.
function clearManagedPathCaches(): void {
  ;(getManagedFilePath as unknown as { cache: { clear(): void } }).cache.clear()
  ;(
    doesEnterpriseMcpConfigExist as unknown as { cache: { clear(): void } }
  ).cache.clear()
}

let dir: string
let savedUserType: string | undefined
let savedManagedPath: string | undefined
let savedNodeEnv: string | undefined
let savedSettingSources: SettingSource[]
let savedGlobalMcp: ReturnType<typeof getGlobalConfig>['mcpServers']
let savedProjectMcp: ReturnType<typeof getCurrentProjectConfig>['mcpServers']

beforeEach(async () => {
  await acquireSharedMutationLock('services/mcp/enterpriseMcpBoundary.test.ts')
  savedUserType = process.env.USER_TYPE
  savedManagedPath = process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH
  savedNodeEnv = process.env.NODE_ENV
  dir = mkdtempSync(join(tmpdir(), 'managed-mcp-boundary-'))
  process.env.USER_TYPE = 'ant'
  process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH = dir
  process.env.NODE_ENV = 'test'
  // A disabled scope's servers would be dropped for an unrelated reason; pin the
  // full source set so the assertions isolate the enterprise-exclusive boundary.
  savedSettingSources = getAllowedSettingSources()
  setAllowedSettingSources([...SETTING_SOURCES])
  // A user- and a local-scoped server that would resolve by name in normal mode.
  savedGlobalMcp = getGlobalConfig().mcpServers
  savedProjectMcp = getCurrentProjectConfig().mcpServers
  saveGlobalConfig(config => ({
    ...config,
    mcpServers: { usersrv: { command: 'echo', args: [] } },
  }))
  saveCurrentProjectConfig(config => ({
    ...config,
    mcpServers: { localsrv: { command: 'echo', args: [] } },
  }))
  clearManagedPathCaches()
})

afterEach(() => {
  try {
    saveGlobalConfig(config => ({ ...config, mcpServers: savedGlobalMcp }))
    saveCurrentProjectConfig(config => ({
      ...config,
      mcpServers: savedProjectMcp,
    }))
    setAllowedSettingSources(savedSettingSources)
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = savedNodeEnv
    if (savedUserType === undefined) delete process.env.USER_TYPE
    else process.env.USER_TYPE = savedUserType
    if (savedManagedPath === undefined)
      delete process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH
    else process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH = savedManagedPath
    rmSync(dir, { recursive: true, force: true })
    clearManagedPathCaches()
  } finally {
    releaseSharedMutationLock()
  }
})

// getMcpConfigByName is the shared chokepoint for both the CLI named lookup
// (`mcp get <server>` → checkMcpServerHealth) and an agent definition's
// named-server reference (via runAgent). A present managed-mcp.json engages
// enterprise-exclusive, fail-closed mode, so neither route may resolve a
// user/local server while it exists.

test('a valid managed file blocks user/local names and resolves only enterprise ones', () => {
  writeFileSync(
    join(dir, 'managed-mcp.json'),
    '{"mcpServers":{"entsrv":{"command":"echo","args":[]}}}',
  )
  clearManagedPathCaches()

  expect(doesEnterpriseMcpConfigExist()).toBe(true)
  // The non-enterprise servers are unreachable by name under the policy.
  expect(getMcpConfigByName('usersrv')).toBeNull()
  expect(getMcpConfigByName('localsrv')).toBeNull()
  // The enterprise-owned server still resolves.
  const ent = getMcpConfigByName('entsrv')
  expect(ent).not.toBeNull()
  expect(ent?.scope).toBe('enterprise')
})

test('a malformed managed file still fails closed (no fall-through to user/local)', () => {
  // The reserved __proto__ entry makes the whole managed file fatal, so the
  // enterprise scope parses to zero servers — but its presence still engages the
  // policy, so a named lookup must not fall back to the user/local scopes.
  writeFileSync(
    join(dir, 'managed-mcp.json'),
    '{"mcpServers":{"__proto__":{"command":"echo","args":[]},' +
      '"entsrv":{"command":"echo","args":[]}}}',
  )
  clearManagedPathCaches()

  expect(doesEnterpriseMcpConfigExist()).toBe(true)
  expect(getMcpConfigByName('usersrv')).toBeNull()
  expect(getMcpConfigByName('localsrv')).toBeNull()
})

test('without a managed file the user/local names resolve as normal', () => {
  // Control: the boundary only applies while the managed file is present.
  expect(doesEnterpriseMcpConfigExist()).toBe(false)
  expect(getMcpConfigByName('usersrv')?.scope).toBe('user')
  expect(getMcpConfigByName('localsrv')?.scope).toBe('local')
})
