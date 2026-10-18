/**
 * Security hardening regression tests.
 *
 * Covers:
 * 1. MCP tool result Unicode sanitization
 * 2. Sandbox settings source filtering (exclude projectSettings)
 * 3. Plugin git clone/pull hooks disabled
 * 4. ANTHROPIC_FOUNDRY_API_KEY removed from SAFE_ENV_VARS
 * 5. WebFetch SSRF protection via ssrfGuardedLookup
 */

import { describe, test, expect } from 'bun:test'
import { resolve } from 'path'

const SRC = resolve(import.meta.dir, '..')
const file = (relative: string) => Bun.file(resolve(SRC, relative))

// ---------------------------------------------------------------------------
// Fix 1: MCP tool result Unicode sanitization
// ---------------------------------------------------------------------------
describe('MCP tool result sanitization', () => {
  test('transformResultContent sanitizes text content', async () => {
    const content = await file('services/mcp/client.ts').text()
    // The complete, aggregated tool list is sanitized before conversion.
    expect(content).toContain('recursivelySanitizeUnicode(tools)')
    // Tool results must also be sanitized
    expect(content).toMatch(
      /case 'text':[\s\S]*?recursivelySanitizeUnicode\(resultContent\.text\)/,
    )
  })

  test('resource text content is also sanitized', async () => {
    const content = await file('services/mcp/client.ts').text()
    expect(content).toMatch(
      /recursivelySanitizeUnicode\(\s*`\$\{prefix\}\$\{resource\.text\}`/,
    )
  })
})

// ---------------------------------------------------------------------------
// Fix 2: Sandbox settings source filtering
// ---------------------------------------------------------------------------
describe('Sandbox settings trust boundary', () => {
  test('getSandboxEnabledSetting does not use getSettings_DEPRECATED', async () => {
    const content = await file('utils/sandbox/sandbox-adapter.ts').text()
    // Extract the getSandboxEnabledSetting function body
    const fnMatch = content.match(
      /function getSandboxEnabledSetting\(\)[^{]*\{([\s\S]*?)\n\}/,
    )
    expect(fnMatch).not.toBeNull()
    const fnBody = fnMatch![1]
    // Must NOT use getSettings_DEPRECATED (reads all sources including project)
    expect(fnBody).not.toContain('getSettings_DEPRECATED')
    // Must use getSettingsForSource for individual trusted sources
    expect(fnBody).toContain("getSettingsForSource('userSettings')")
    expect(fnBody).toContain("getSettingsForSource('policySettings')")
    // Must NOT read from projectSettings
    expect(fnBody).not.toContain("'projectSettings'")
  })
})

// ---------------------------------------------------------------------------
// Fix 3: Plugin git hooks disabled
// ---------------------------------------------------------------------------
describe('Plugin git operations disable hooks', () => {
  test('gitClone includes core.hooksPath=/dev/null', async () => {
    const content = await file('utils/plugins/marketplaceManager.ts').text()
    // The clone args must disable hooks
    const cloneSection = content.slice(
      content.indexOf('export async function gitClone('),
      content.indexOf('export async function gitClone(') + 2000,
    )
    expect(cloneSection).toContain("'core.hooksPath=/dev/null'")
  })

  test('gitPull includes core.hooksPath=/dev/null', async () => {
    const content = await file('utils/plugins/marketplaceManager.ts').text()
    const pullSection = content.slice(
      content.indexOf('export async function gitPull('),
      content.indexOf('export async function gitPull(') + 2000,
    )
    expect(pullSection).toContain("'core.hooksPath=/dev/null'")
  })

  test('gitSubmoduleUpdate includes core.hooksPath=/dev/null', async () => {
    const content = await file('utils/plugins/marketplaceManager.ts').text()
    const subSection = content.slice(
      content.indexOf('async function gitSubmoduleUpdate('),
      content.indexOf('async function gitSubmoduleUpdate(') + 1000,
    )
    expect(subSection).toContain("'core.hooksPath=/dev/null'")
  })
})

// ---------------------------------------------------------------------------
// Fix 4: ANTHROPIC_FOUNDRY_API_KEY not in SAFE_ENV_VARS
// ---------------------------------------------------------------------------
describe('SAFE_ENV_VARS excludes credentials', () => {
  test('ANTHROPIC_FOUNDRY_API_KEY is not in SAFE_ENV_VARS', async () => {
    const content = await file('utils/managedEnvConstants.ts').text()
    // Extract the SAFE_ENV_VARS set definition
    const safeStart = content.indexOf('export const SAFE_ENV_VARS')
    const safeEnd = content.indexOf('])', safeStart)
    const safeSection = content.slice(safeStart, safeEnd)
    expect(safeSection).not.toContain('ANTHROPIC_FOUNDRY_API_KEY')
  })
})

// ---------------------------------------------------------------------------
// Fix 5: WebFetch SSRF protection
// ---------------------------------------------------------------------------
describe('WebFetch SSRF guard', () => {
  test('getWithPermittedRedirects uses ssrfGuardedLookup', async () => {
    const content = await file('tools/WebFetchTool/utils.ts').text()
    expect(content).toContain(
      "import { ssrfGuardedLookup } from '../../utils/hooks/ssrfGuard.js'",
    )
    // The axios.get call in getWithPermittedRedirects must include lookup
    const fnSection = content.slice(
      content.indexOf('export async function getWithPermittedRedirects('),
      content.indexOf('export async function getWithPermittedRedirects(') +
        1000,
    )
    expect(fnSection).toContain('lookup: ssrfGuardedLookup')
  })
})

// ---------------------------------------------------------------------------
// Fix 6: Swarm permission file polling removed (security hardening)
// ---------------------------------------------------------------------------
describe('Swarm permission file polling removed', () => {
  test('useSwarmPermissionPoller hook no longer exists', async () => {
    const content = await file(
      'hooks/useSwarmPermissionPoller.ts',
    ).text()
    // The file-based polling hook must not exist — it read from an
    // unauthenticated resolved/ directory where any local process could
    // forge approval files.
    expect(content).not.toContain('function useSwarmPermissionPoller(')
    // The file-based processResponse must not exist
    expect(content).not.toContain('function processResponse(')
  })

  test('poller does not import from permissionSync', async () => {
    const content = await file(
      'hooks/useSwarmPermissionPoller.ts',
    ).text()
    // Must not import anything from permissionSync — all file-based
    // functions have been removed from this module's dependencies
    expect(content).not.toContain('permissionSync')
  })

  test('file-based permission functions are marked deprecated', async () => {
    const content = await file(
      'utils/swarm/permissionSync.ts',
    ).text()
    // All file-based functions must have @deprecated JSDoc
    const deprecatedFns = [
      'writePermissionRequest',
      'readPendingPermissions',
      'readResolvedPermission',
      'resolvePermission',
      'pollForResponse',
      'removeWorkerResponse',
    ]
    for (const fn of deprecatedFns) {
      // Find the function and check that @deprecated appears before it
      const fnIndex = content.indexOf(`export async function ${fn}(`)
      if (fnIndex === -1) continue // submitPermissionRequest is a const, not async function
      const preceding = content.slice(Math.max(0, fnIndex - 500), fnIndex)
      expect(preceding).toContain('@deprecated')
    }
  })

  test('mailbox-based functions are NOT deprecated', async () => {
    const content = await file(
      'utils/swarm/permissionSync.ts',
    ).text()
    // These are the active path — must not be deprecated
    const activeFns = [
      'sendPermissionRequestViaMailbox',
      'sendPermissionResponseViaMailbox',
    ]
    for (const fn of activeFns) {
      const fnIndex = content.indexOf(`export async function ${fn}(`)
      expect(fnIndex).not.toBe(-1)
      const preceding = content.slice(Math.max(0, fnIndex - 300), fnIndex)
      expect(preceding).not.toContain('@deprecated')
    }
  })
})
