import { afterEach, beforeEach, expect, test } from 'bun:test'

import type { McpServerConfig } from '../../services/mcp/types.js'
import type { PluginError } from '../../types/plugin.js'
import { resolvePluginMcpEnvironment } from '../../utils/plugins/mcpPluginIntegration.js'
import {
  clearBuiltinPlugins,
  getBuiltinPluginDefinition,
} from '../builtinPlugins.js'
import { initBuiltinPlugins } from './index.js'
import { registerMemlawbPlugin } from './memlawb.js'

const MEMLAWB_VARS = [
  'MEMLAWB_URL',
  'MEMLAWB_API_KEY',
  'MEMLAWB_NAMESPACE',
  'MEMLAWB_PASSPHRASE_FILE',
] as const

/** The secret itself. It lives in a file; nothing here should carry its value. */
const PASSPHRASE = 'correct-horse-battery-staple-9f3a'
const PASSPHRASE_PATH = '/home/alice/.config/memlawb/passphrase'
const API_KEY = 'mk_live_servicekey_7c21'

const PLUGIN_REF = { path: 'builtin', source: 'memlawb@builtin' }

const TOUCHED = [...MEMLAWB_VARS, 'MEMLAWB_PASSPHRASE'] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  registerMemlawbPlugin()
  for (const name of TOUCHED) saved[name] = process.env[name]
  process.env.MEMLAWB_URL = 'https://memlawb.example/api'
  process.env.MEMLAWB_API_KEY = API_KEY
  process.env.MEMLAWB_NAMESPACE = 'user:alice/repo'
  process.env.MEMLAWB_PASSPHRASE_FILE = PASSPHRASE_PATH
  // A stale export of the raw passphrase, which is exactly the thing the path
  // form exists to stop mattering. The plugin must not pick it up.
  process.env.MEMLAWB_PASSPHRASE = PASSPHRASE
})

afterEach(() => {
  clearBuiltinPlugins()
  for (const name of TOUCHED) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

function memlawbServer(): McpServerConfig {
  const servers = getBuiltinPluginDefinition('memlawb')?.mcpServers
  const entries = Object.entries(servers ?? {})
  expect(entries.map(([name]) => name)).toEqual(['memlawb'])
  return entries[0]![1]!
}

function resolvedEnv(
  config: McpServerConfig,
  errors?: PluginError[],
): Record<string, string> {
  const resolved = resolvePluginMcpEnvironment(
    config,
    PLUGIN_REF,
    undefined,
    errors,
    'memlawb',
    'memlawb',
  )
  return (resolved as { env?: Record<string, string> }).env ?? {}
}

// The plugin references a memlawb input that older builds do not read, so the
// description has to name the version. Without it, the failure a user meets is
// "no passphrase set", which points at their configuration rather than at their
// binary being too old.
test('the description names the memlawb version the passphrase file needs', () => {
  const plugin = getBuiltinPluginDefinition('memlawb')
  expect(plugin?.description).toContain('0.1.0')
  // Control: it still names the variable that needs that version, so this is a
  // version stated for a reason rather than a number sitting in a sentence.
  expect(plugin?.description).toContain('MEMLAWB_PASSPHRASE_FILE')
})

test('memlawb registers disabled, with one stdio server and no prompting', () => {
  const plugin = getBuiltinPluginDefinition('memlawb')

  expect(plugin).toBeDefined()
  expect(plugin?.defaultEnabled).toBe(false)
  // R7: no skill, no hook, no agent — openclaude's memdir pipeline and team
  // memory must be untouched by enabling this.
  expect(plugin?.skills).toBeUndefined()
  expect(plugin?.hooks).toBeUndefined()

  const server = memlawbServer() as { command: string; args?: string[] }
  expect(server.command).toBe('memlawb')
  expect(server.args).toEqual(['mcp'])
})

test('every memlawb env value is a ${VAR} reference and none is a literal', () => {
  const server = memlawbServer() as { env?: Record<string, string> }
  const env = server.env ?? {}

  expect(Object.keys(env).sort()).toEqual([...MEMLAWB_VARS].sort())
  for (const [key, value] of Object.entries(env)) {
    expect(value).toMatch(/^\$\{[A-Z_][A-Z0-9_]*\}$/)
    // A reference to some unrelated variable would satisfy the shape above.
    expect(value).toBe(`\${${key}}`)
  }
})

test('the passphrase rides as a path and the raw-value variable is not declared', () => {
  const env = (memlawbServer() as { env?: Record<string, string> }).env ?? {}

  // Path alone, never both. memlawb's startup lets the file win but still
  // refuses an unexpanded MEMLAWB_PASSPHRASE, so declaring both would make the
  // safe configuration — file set, raw variable unset — fail to start.
  expect(env.MEMLAWB_PASSPHRASE_FILE).toBe('${MEMLAWB_PASSPHRASE_FILE}')
  expect(env.MEMLAWB_PASSPHRASE).toBeUndefined()
})

test('the passphrase value reaches no configured server, and the service key does reach memlawb', () => {
  // Recorded limitation: this reads resolved plugin config. It cannot see the
  // spawn-time `{ ...subprocessEnv(), ...serverRef.env }` spread in
  // src/services/mcp/client.ts:1056, which hands every stdio child the whole
  // parent environment. What it does prove is that the secret is not something
  // this plugin puts there.
  const memlawbEnv = resolvedEnv(memlawbServer())
  expect(Object.values(memlawbEnv)).not.toContain(PASSPHRASE)
  expect(memlawbEnv.MEMLAWB_PASSPHRASE_FILE).toBe(PASSPHRASE_PATH)

  // Neighbour: a second MCP server the user has configured. It never declares
  // the passphrase, so expansion must not put the value in its environment.
  const neighbour: McpServerConfig = {
    type: 'stdio',
    command: 'other-server',
    args: [],
    env: { OTHER_TOKEN: '${MEMLAWB_API_KEY}', OTHER_MODE: 'plain' },
  }
  expect(Object.values(resolvedEnv(neighbour))).not.toContain(PASSPHRASE)

  // Positive control 1 (the plan's): the service key does ride expansion, so
  // the same reading of a resolved environment finds a secret where one belongs.
  expect(memlawbEnv.MEMLAWB_API_KEY).toBe(API_KEY)

  // Positive control 2: the absence checks above are capable of finding the
  // passphrase. A server that does declare the reference gets the value, so
  // neither `not.toContain` is vacuously true.
  const leaky: McpServerConfig = {
    ...neighbour,
    env: { OTHER_TOKEN: '${MEMLAWB_PASSPHRASE}' },
  }
  expect(Object.values(resolvedEnv(leaky))).toContain(PASSPHRASE)
})

test('resolving with the four variables set yields their values', () => {
  const errors: PluginError[] = []
  const env = resolvedEnv(memlawbServer(), errors)

  expect(env.MEMLAWB_URL).toBe('https://memlawb.example/api')
  expect(env.MEMLAWB_API_KEY).toBe(API_KEY)
  expect(env.MEMLAWB_NAMESPACE).toBe('user:alice/repo')
  expect(env.MEMLAWB_PASSPHRASE_FILE).toBe(PASSPHRASE_PATH)
  expect(errors).toEqual([])
})

test('an unset variable is named in the missing-variable error', () => {
  delete process.env.MEMLAWB_PASSPHRASE_FILE

  const errors: PluginError[] = []
  const env = resolvedEnv(memlawbServer(), errors)

  expect(errors).toHaveLength(1)
  const error = errors[0]!
  if (error.type !== 'mcp-config-invalid') {
    throw new Error(`unexpected plugin error type: ${error.type}`)
  }
  expect(error.serverName).toBe('memlawb')
  expect(error.validationError).toBe(
    'Missing environment variables: MEMLAWB_PASSPHRASE_FILE',
  )
  // openclaude leaves an unresolved reference as its literal text and still
  // registers the server, so memlawb receives the literal as a path. Its own
  // startup refuses that rather than falling back to MEMLAWB_PASSPHRASE.
  expect(env.MEMLAWB_PASSPHRASE_FILE).toBe('${MEMLAWB_PASSPHRASE_FILE}')
})

test('startup registration wires memlawb in alongside the other built-ins', () => {
  clearBuiltinPlugins()
  initBuiltinPlugins()

  expect(getBuiltinPluginDefinition('memlawb')).toBeDefined()
  // Control: the sweep is capable of missing a plugin, so the assertion above
  // is not just "initBuiltinPlugins registered something".
  expect(getBuiltinPluginDefinition('karpathy-guidelines')).toBeDefined()
  expect(getBuiltinPluginDefinition('not-a-plugin')).toBeUndefined()
})
