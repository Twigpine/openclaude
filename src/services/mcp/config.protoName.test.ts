import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import {
  getAllowedSettingSources,
  setAllowedSettingSources,
} from '../../bootstrap/state.js'
import {
  SETTING_SOURCES,
  type SettingSource,
} from '../../utils/settings/constants.js'
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
import { runWithCwdOverride } from '../../utils/cwd.js'
import {
  addMcpConfig,
  getMcpConfigByName,
  parseMcpConfig,
  removeMcpConfig,
} from './config.js'

// A hand-authored .mcp.json that fails to parse as a whole (a reserved name
// plus a valid sibling). JSON.parse creates a true own "__proto__" key.
const POISONED_MCP_JSON =
  '{"mcpServers":{"__proto__":{"command":"echo","args":[]},' +
  '"realone":{"command":"echo","args":[]}}}'

// The MCP `servers` maps are plain objects built from JSON config, so a bare
// `servers[name]` lookup exposes inherited Object.prototype members. A user
// running `openclaude mcp get constructor` (or `__proto__`, `toString`, …) must
// get "not found", not the Object constructor cast as a server config.
const PROTO_NAMES = [
  'constructor',
  '__proto__',
  'toString',
  'hasOwnProperty',
  'valueOf',
  'isPrototypeOf',
]

let savedGlobalMcp: ReturnType<typeof getGlobalConfig>['mcpServers']
let savedProjectMcp: ReturnType<typeof getCurrentProjectConfig>['mcpServers']

let savedNodeEnv: string | undefined
let savedSettingSources: ReturnType<typeof getAllowedSettingSources>

beforeEach(async () => {
  // This suite swaps NODE_ENV and the process-wide global/project MCP configs,
  // so it has to be serialized against the other state-mutating suites bun may
  // run alongside it -- otherwise they observe the injected fixtures, or their
  // updates are clobbered when this teardown restores a stale snapshot.
  await acquireSharedMutationLock('services/mcp/config.protoName.test.ts')
  savedNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'test'
  // getMcpConfigsByScope() short-circuits a scope's writability errors to an
  // empty list when that scope's setting source is disabled, and
  // allowedSettingSources is a process-wide global other suites mutate (and may
  // leave without localSettings if they crash before their own teardown). If
  // localSettings were disabled here the "fatally poisoned local scope" guard
  // would never fire and addMcpConfig would resolve instead of rejecting, so
  // pin the full source set for the duration of this suite.
  savedSettingSources = getAllowedSettingSources()
  setAllowedSettingSources([...SETTING_SOURCES])
  savedGlobalMcp = getGlobalConfig().mcpServers
  savedProjectMcp = getCurrentProjectConfig().mcpServers
  saveGlobalConfig(config => ({
    ...config,
    mcpServers: { realserver: { command: 'echo', args: [] } },
  }))
  saveCurrentProjectConfig(config => ({
    ...config,
    mcpServers: { locallyreal: { command: 'echo', args: [] } },
  }))
})

afterEach(() => {
  try {
    saveGlobalConfig(config => ({ ...config, mcpServers: savedGlobalMcp }))
    saveCurrentProjectConfig(config => ({
      ...config,
      mcpServers: savedProjectMcp,
    }))
    if (savedNodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = savedNodeEnv
    }
    setAllowedSettingSources(savedSettingSources)
  } finally {
    releaseSharedMutationLock()
  }
})

test('resolves a real server by name', () => {
  const found = getMcpConfigByName('realserver')
  expect(found).not.toBeNull()
  expect(found?.scope).toBe('user')
})

test('returns null for a plainly missing name', () => {
  expect(getMcpConfigByName('nope-not-here')).toBeNull()
})

test('returns null for Object.prototype member names', () => {
  // Before the fix each of these resolved to an inherited function (truthy),
  // so the lookup returned a bogus config and callers skipped their not-found
  // guard.
  for (const name of PROTO_NAMES) {
    expect(getMcpConfigByName(name)).toBeNull()
  }
})

test('rejects adding a server under a reserved name', async () => {
  // "constructor" persists, but the schema then rejects the whole mcpServers
  // object on the next read -- so adding it takes down every other server in
  // that scope too.
  await expect(
    addMcpConfig('constructor', { command: 'echo', args: [] }, 'user'),
  ).rejects.toThrow('reserved')
})

test('rejects adding a server named __proto__', async () => {
  // "__proto__" passes the character check but assigning it on a plain object
  // hits the prototype setter, so the server would be reported as added and
  // silently vanish rather than becoming an own property.
  await expect(
    addMcpConfig('__proto__', { command: 'echo', args: [] }, 'user'),
  ).rejects.toThrow('reserved')
})

test('reports proto-name removal as not found instead of succeeding', async () => {
  // Before the fix the scoped-removal existence checks accepted inherited
  // members, so `mcp remove constructor -s user` claimed success while leaving
  // the real configuration untouched.
  for (const name of PROTO_NAMES) {
    await expect(removeMcpConfig(name, 'user')).rejects.toThrow(
      'No user-scoped MCP server found',
    )
  }
})

test('surfaces a __proto__ entry and rejects the whole file', () => {
  // A hand-authored .mcp.json can carry this name: the schema accepts it, but
  // copying it into a plain object hits the prototype setter, so the entry
  // vanished with no diagnostic and the user could not tell why their server
  // did not exist. It must be reported, not silently discarded.
  // Parsed from text, exactly as the real file is: JSON.parse creates a true
  // own "__proto__" key, which an object literal would not.
  const { config, errors } = parseMcpConfig({
    configObject: JSON.parse(
      '{"mcpServers":{"__proto__":{"command":"echo","args":[]},' +
        '"realone":{"command":"echo","args":[]}}}',
    ),
    expandVars: false,
    scope: 'project',
    filePath: '/tmp/.mcp.json',
  })

  const protoError = errors.find(e => e.path === 'mcpServers.__proto__')
  expect(protoError).toBeDefined()
  expect(protoError?.message).toContain('reserved')
  expect(protoError?.mcpErrorMetadata?.severity).toBe('fatal')
  // A fatal reserved name rejects the whole input (config: null), the same as
  // "constructor" does when the schema fails -- so a caller that branches on
  // config cannot start with the bad entry quietly dropped and the error lost.
  expect(config).toBeNull()
})

test('refuses to add a project server when .mcp.json is fatally poisoned', async () => {
  // The fatal parse returns config: null, so getProjectMcpConfigsFromCwd reports
  // an empty map even though `realone` is on disk. Rebuilding the file from that
  // empty snapshot and writing only the new server would drop the valid sibling,
  // so the add must refuse and leave the file untouched.
  const dir = mkdtempSync(join(tmpdir(), 'mcp-add-poison-'))
  const mcpPath = join(dir, '.mcp.json')
  writeFileSync(mcpPath, POISONED_MCP_JSON)
  try {
    await runWithCwdOverride(dir, async () => {
      await expect(
        addMcpConfig('newsrv', { command: 'echo', args: [] }, 'project'),
      ).rejects.toThrow('Cannot modify .mcp.json')
    })
    // The valid sibling survives: the file was not rewritten.
    expect(readFileSync(mcpPath, 'utf8')).toBe(POISONED_MCP_JSON)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('refuses to remove a project server when .mcp.json is fatally poisoned', async () => {
  // An empty parsed map is not proof the server is absent, so removal must not
  // report "not found" (nor clobber the siblings) -- it refuses with the fatal
  // parse error for both a valid sibling and the reserved key itself.
  const dir = mkdtempSync(join(tmpdir(), 'mcp-remove-poison-'))
  const mcpPath = join(dir, '.mcp.json')
  writeFileSync(mcpPath, POISONED_MCP_JSON)
  try {
    await runWithCwdOverride(dir, async () => {
      await expect(removeMcpConfig('realone', 'project')).rejects.toThrow(
        'Cannot modify .mcp.json',
      )
      await expect(removeMcpConfig('__proto__', 'project')).rejects.toThrow(
        'Cannot modify .mcp.json',
      )
    })
    expect(readFileSync(mcpPath, 'utf8')).toBe(POISONED_MCP_JSON)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('still adds and removes a project server when .mcp.json is clean', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-clean-'))
  const mcpPath = join(dir, '.mcp.json')
  writeFileSync(
    mcpPath,
    '{"mcpServers":{"realone":{"command":"echo","args":[]}}}',
  )
  try {
    await runWithCwdOverride(dir, async () => {
      await addMcpConfig('newsrv', { command: 'echo', args: [] }, 'project')
      const afterAdd = JSON.parse(readFileSync(mcpPath, 'utf8'))
      expect(Object.keys(afterAdd.mcpServers).sort()).toEqual([
        'newsrv',
        'realone',
      ])
      await removeMcpConfig('realone', 'project')
      const afterRemove = JSON.parse(readFileSync(mcpPath, 'utf8'))
      expect(Object.keys(afterRemove.mcpServers)).toEqual(['newsrv'])
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('preserves .mcp.json siblings on mutation when projectSettings is disabled', async () => {
  // A mutation must read the real .mcp.json, not the load-time source view.
  // With projectSettings excluded from --setting-sources the load helper
  // reports no project servers, so rebuilding the file from that empty view
  // would drop the valid sibling on add and mis-report the server as absent on
  // remove. The mutation path reads the raw file, so both stay correct.
  const dir = mkdtempSync(join(tmpdir(), 'mcp-project-disabled-'))
  const mcpPath = join(dir, '.mcp.json')
  writeFileSync(
    mcpPath,
    '{"mcpServers":{"realone":{"command":"echo","args":[]}}}',
  )
  setAllowedSettingSources(
    SETTING_SOURCES.filter(source => source !== 'projectSettings'),
  )
  try {
    await runWithCwdOverride(dir, async () => {
      await addMcpConfig('newsrv', { command: 'echo', args: [] }, 'project')
      const afterAdd = JSON.parse(readFileSync(mcpPath, 'utf8'))
      // The valid sibling survives the rebuild instead of being dropped.
      expect(Object.keys(afterAdd.mcpServers).sort()).toEqual([
        'newsrv',
        'realone',
      ])
      await removeMcpConfig('realone', 'project')
      const afterRemove = JSON.parse(readFileSync(mcpPath, 'utf8'))
      expect(Object.keys(afterRemove.mcpServers)).toEqual(['newsrv'])
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('refuses user add/remove when the user scope is fatally poisoned', async () => {
  // A hand-authored ~/.openclaude.json can carry an own "__proto__" server. The
  // scope then parses to config: null, so an add would claim success while the
  // scope loads nothing, and a remove would mutate siblings in a raw map that
  // stays unloadable. Both must refuse.
  saveGlobalConfig(config => ({
    ...config,
    mcpServers: JSON.parse(
      '{"__proto__":{"command":"echo","args":[]},' +
        '"realuser":{"command":"echo","args":[]}}',
    ),
  }))
  await expect(
    addMcpConfig('newsrv', { command: 'echo', args: [] }, 'user'),
  ).rejects.toThrow('Cannot modify user config')
  await expect(removeMcpConfig('realuser', 'user')).rejects.toThrow(
    'Cannot modify user config',
  )
})

// Re-establish the poisoned local-scope fixture synchronously, immediately
// before the mutation under test. addMcpConfig/removeMcpConfig reach their scope
// write guard with no awaited work in between, so the guard's read of NODE_ENV,
// the enabled setting sources, and the process-wide test project config all run
// in the same tick as this call. Pinning all three here -- with no await
// separating it from the mutation -- keeps the read atomic even if another
// suite's stray async task clobbered NODE_ENV or testProjectConfigForTesting
// during an await gap earlier in this test. sharedMutationLock only serializes
// other lock holders, not every writer of the shared test config, so this is
// the isolation that makes the regression stable under the full parallel suite.
function pinPoisonedLocalScope(sources: SettingSource[]): void {
  process.env.NODE_ENV = 'test'
  setAllowedSettingSources(sources)
  saveCurrentProjectConfig(config => ({
    ...config,
    mcpServers: JSON.parse(
      '{"__proto__":{"command":"echo","args":[]},' +
        '"reallocal":{"command":"echo","args":[]}}',
    ),
  }))
}

test('refuses local add/remove when the local scope is fatally poisoned', async () => {
  pinPoisonedLocalScope([...SETTING_SOURCES])
  await expect(
    addMcpConfig('newsrv', { command: 'echo', args: [] }, 'local'),
  ).rejects.toThrow('Cannot modify local config')
  pinPoisonedLocalScope([...SETTING_SOURCES])
  await expect(removeMcpConfig('reallocal', 'local')).rejects.toThrow(
    'Cannot modify local config',
  )
})

test('still refuses a poisoned scope whose setting source is disabled', async () => {
  // The mutation guards must not defer to the load-time source filter:
  // getMcpConfigsByScope() reports no errors for a disabled source, but
  // add/remove still write the raw map, so a fatally poisoned scope has to be
  // refused even when the user narrowed --setting-sources to exclude it.
  const withoutLocal = SETTING_SOURCES.filter(
    source => source !== 'localSettings',
  )
  pinPoisonedLocalScope(withoutLocal)
  await expect(
    addMcpConfig('newsrv', { command: 'echo', args: [] }, 'local'),
  ).rejects.toThrow('Cannot modify local config')
  pinPoisonedLocalScope(withoutLocal)
  await expect(removeMcpConfig('reallocal', 'local')).rejects.toThrow(
    'Cannot modify local config',
  )
})

test('still allows adding and removing a real server name', async () => {
  await addMcpConfig('addedserver', { command: 'echo', args: [] }, 'user')
  expect(getMcpConfigByName('addedserver')).not.toBeNull()
  await removeMcpConfig('addedserver', 'user')
  expect(getMcpConfigByName('addedserver')).toBeNull()
})

test('names a reserved constructor entry instead of failing the whole file', () => {
  // The schema rejects the entire mcpServers object for this name, so every
  // other server in the scope stops loading. Before, the only diagnostic was a
  // generic "does not adhere to schema" against `mcpServers`, which does not
  // say which entry is at fault.
  const { errors } = parseMcpConfig({
    configObject: JSON.parse(
      '{"mcpServers":{"constructor":{"command":"echo","args":[]},' +
        '"realone":{"command":"echo","args":[]}}}',
    ),
    expandVars: false,
    scope: 'project',
    filePath: '/tmp/.mcp.json',
  })

  const named = errors.find(e => e.path === 'mcpServers.constructor')
  expect(named).toBeDefined()
  expect(named?.message).toContain('reserved')
  expect(named?.mcpErrorMetadata?.severity).toBe('fatal')
})
