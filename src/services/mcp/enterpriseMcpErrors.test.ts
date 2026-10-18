import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { getManagedFilePath } from '../../utils/settings/managedPath.js'
import { doesEnterpriseMcpConfigExist, getClaudeCodeMcpConfigs } from './config.js'

// getManagedFilePath / doesEnterpriseMcpConfigExist are memoized; clear their
// lodash caches so the env override below is observed and does not leak.
function clearManagedPathCaches(): void {
  ;(getManagedFilePath as unknown as { cache: { clear(): void } }).cache.clear()
  ;(
    doesEnterpriseMcpConfigExist as unknown as { cache: { clear(): void } }
  ).cache.clear()
}

let dir: string
let savedUserType: string | undefined
let savedManagedPath: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('services/mcp/enterpriseMcpErrors.test.ts')
  savedUserType = process.env.USER_TYPE
  savedManagedPath = process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH
  dir = mkdtempSync(join(tmpdir(), 'managed-mcp-'))
  process.env.USER_TYPE = 'ant'
  process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH = dir
  clearManagedPathCaches()
})

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
    if (savedUserType === undefined) {
      delete process.env.USER_TYPE
    } else {
      process.env.USER_TYPE = savedUserType
    }
    if (savedManagedPath === undefined) {
      delete process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH
    } else {
      process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH = savedManagedPath
    }
    clearManagedPathCaches()
  } finally {
    releaseSharedMutationLock()
  }
})

test('surfaces managed-mcp.json parse errors in enterprise exclusive mode', async () => {
  // A reserved __proto__ entry makes the whole managed file fatal, so the
  // enterprise scope parses to zero servers. Presence still engages the policy
  // lock (fail-closed), so without propagating the parse error the caller would
  // see an empty server list and no reason why.
  writeFileSync(
    join(dir, 'managed-mcp.json'),
    '{"mcpServers":{"__proto__":{"command":"echo","args":[]},' +
      '"real":{"command":"echo","args":[]}}}',
  )

  const { servers, errors } = await getClaudeCodeMcpConfigs()

  expect(
    errors.some(
      e =>
        e.type === 'generic-error' &&
        e.error.includes('Managed MCP config is invalid'),
    ),
  ).toBe(true)
  // Fail-closed: the valid sibling is not loaded either while the file is fatal.
  expect(Object.keys(servers)).not.toContain('real')
})

test('reports no managed error for a clean managed-mcp.json', async () => {
  writeFileSync(
    join(dir, 'managed-mcp.json'),
    '{"mcpServers":{"real":{"command":"echo","args":[]}}}',
  )

  const { servers, errors } = await getClaudeCodeMcpConfigs()

  expect(
    errors.some(
      e =>
        e.type === 'generic-error' &&
        e.error.includes('Managed MCP config is invalid'),
    ),
  ).toBe(false)
  expect(Object.keys(servers)).toContain('real')
})
