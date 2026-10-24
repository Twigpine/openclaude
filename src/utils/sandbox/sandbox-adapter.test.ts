import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { SandboxManager as BaseSandboxManager } from '@anthropic-ai/sandbox-runtime'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'
import {
  getCwdState,
  getOriginalCwd,
  setCwdState,
  setOriginalCwd,
} from '../../bootstrap/state.js'
import { snapshotEnv } from '../../test/envSnapshot.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { getSettingsForSource } from '../settings/settings.js'
import {
  resetSettingsCache,
  setCachedSettingsForSource,
} from '../settings/settingsCache.js'
import { SettingsSchema, type SettingsJson } from '../settings/types.js'
import {
  convertToSandboxRuntimeConfig,
  SandboxManager,
  type SandboxRuntimeConfig,
  SandboxRuntimeConfigSchema,
} from './sandbox-adapter.js'

const policyGetters = [
  'getFsReadConfig',
  'getFsWriteConfig',
  'getNetworkRestrictionConfig',
  'getAllowUnixSockets',
  'getAllowLocalBinding',
  'getIgnoreViolations',
  'getEnableWeakerNestedSandbox',
] as const

type RuntimePolicy = {
  [K in (typeof policyGetters)[number]]: ReturnType<(typeof SandboxManager)[K]>
}

// reset() retains config and the public API cannot clear it. Inspect policies
// in a child so an initially unconfigured shared manager stays unconfigured.
async function inspectRuntimePolicy(config: SandboxRuntimeConfig): Promise<RuntimePolicy> {
  const previousConfig = BaseSandboxManager.getConfig()
  const adapterUrl = new URL('./sandbox-adapter.ts', import.meta.url).href
  const child = Bun.spawn([process.execPath, '--eval', `
    import { SandboxManager as BaseSandboxManager } from '@anthropic-ai/sandbox-runtime'
    import { SandboxManager } from ${JSON.stringify(adapterUrl)}
    const initiallyUnconfigured = BaseSandboxManager.getConfig() === undefined
    BaseSandboxManager.updateConfig(await Bun.stdin.json())
    const policy = Object.fromEntries(${JSON.stringify(policyGetters)}.map(
      getter => [getter, SandboxManager[getter]()],
    ))
    console.log(JSON.stringify({ initiallyUnconfigured, policy }))
  `], {
    stdin: new Blob([JSON.stringify(config)]),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 8_000,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(exitCode, stderr).toBe(0)
  const result = JSON.parse(stdout) as {
    initiallyUnconfigured: boolean
    policy: RuntimePolicy
  }
  expect(result.initiallyUnconfigured).toBe(true)
  expect(BaseSandboxManager.getConfig()).toBe(previousConfig)
  return result.policy
}

describe('convertToSandboxRuntimeConfig', () => {
  let restoreEnv: () => void
  let previousOriginalCwd: string
  let previousCwd: string
  let tempRoot: string
  let activeCwd: string
  let previousRuntimeConfig: ReturnType<typeof BaseSandboxManager.getConfig>

  beforeEach(async () => {
    await acquireSharedMutationLock('utils/sandbox/sandbox-adapter.test.ts')

    previousRuntimeConfig = BaseSandboxManager.getConfig()
    restoreEnv = snapshotEnv(['CLAUDE_CONFIG_DIR', 'OPENCLAUDE_CONFIG_DIR'])
    previousOriginalCwd = getOriginalCwd()
    previousCwd = getCwdState()

    tempRoot = await mkdtemp(join(tmpdir(), 'openclaude-sandbox-adapter-'))
    const originalCwd = join(tempRoot, 'original-project')
    activeCwd = join(tempRoot, 'active-project')

    process.env.CLAUDE_CONFIG_DIR = join(tempRoot, 'config')
    process.env.OPENCLAUDE_CONFIG_DIR = join(tempRoot, 'openclaude-config')
    resetSettingsCache()
    setOriginalCwd(originalCwd)
    setCwdState(activeCwd)
  })

  afterEach(async () => {
    try {
      await SandboxManager.reset()
      if (previousRuntimeConfig !== undefined) {
        BaseSandboxManager.updateConfig(previousRuntimeConfig)
      }
      expect(BaseSandboxManager.getConfig()).toEqual(previousRuntimeConfig)
    } finally {
      try {
        restoreEnv()
        setOriginalCwd(previousOriginalCwd)
        setCwdState(previousCwd)
        resetSettingsCache()
        await rm(tempRoot, { recursive: true, force: true })
      } finally {
        releaseSharedMutationLock()
      }
    }
  })

  test('denies canonical OpenClaude settings files in changed cwd', () => {
    const config = convertToSandboxRuntimeConfig({} as SettingsJson)

    expect(config.filesystem.denyWrite).toContain(
      resolve(activeCwd, '.openclaude', 'settings.json'),
    )
    expect(config.filesystem.denyWrite).toContain(
      resolve(activeCwd, '.openclaude', 'settings.local.json'),
    )
  })

  test('denies legacy Claude config surfaces in original and changed cwd', () => {
    const config = convertToSandboxRuntimeConfig({} as SettingsJson)

    for (const cwd of [getOriginalCwd(), activeCwd]) {
      expect(config.filesystem.denyWrite).toContain(
        resolve(cwd, '.claude'),
      )
    }
  })

  test('denies legacy Claude config surfaces from CLAUDE_CONFIG_DIR', () => {
    const config = convertToSandboxRuntimeConfig({} as SettingsJson)
    const configDir = process.env.CLAUDE_CONFIG_DIR!

    expect(config.filesystem.denyWrite).toContain(resolve(configDir))
  })

  test('root deny covers non-settings legacy Claude state', () => {
    const config = convertToSandboxRuntimeConfig({} as SettingsJson)

    const representativeLegacyPaths = [
      resolve(getOriginalCwd(), '.claude', 'CLAUDE.md'),
      resolve(activeCwd, '.claude', 'credentials.json'),
      resolve(process.env.CLAUDE_CONFIG_DIR!, 'plugins', 'plugin.json'),
      resolve(process.env.CLAUDE_CONFIG_DIR!, 'scheduled-tasks', 'task.json'),
    ]

    for (const legacyPath of representativeLegacyPaths) {
      expect(
        config.filesystem.denyWrite.some(
          deniedRoot =>
            legacyPath === deniedRoot ||
            legacyPath.startsWith(`${deniedRoot}${sep}`),
        ),
      ).toBe(true)
    }
  })

  // Each child has an 8s deadline; allow 2s more for assertions and teardown.
  test('maps validated settings to the runtime network and process policy', async () => {
    const settings = SettingsSchema().parse({
      permissions: {
        allow: ['WebFetch(domain:api.example.com:443)'],
        deny: ['WebFetch(domain:blocked.example.com)', 'WebFetch(domain:*:22)'],
      },
      sandbox: {
        network: {
          allowedDomains: ['*.example.org'],
          allowUnixSockets: ['/var/run/example.sock'],
          allowAllUnixSockets: false,
          allowLocalBinding: false,
          httpProxyPort: 8080,
          socksProxyPort: 1080,
        },
        ignoreViolations: { '*': ['/dev/example'] },
        enableWeakerNestedSandbox: false,
        enableWeakerNetworkIsolation: false,
        ripgrep: { command: 'rg', args: ['--hidden'] },
      },
    })
    const config = SandboxRuntimeConfigSchema.parse(
      convertToSandboxRuntimeConfig(settings),
    )

    expect(config.network).toEqual({
      allowedDomains: ['*.example.org', 'api.example.com:443'],
      deniedDomains: ['blocked.example.com', '*:22'],
      allowUnixSockets: ['/var/run/example.sock'],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
      httpProxyPort: 8080,
      socksProxyPort: 1080,
    })
    expect(config.ignoreViolations).toEqual({ '*': ['/dev/example'] })
    expect(config.enableWeakerNestedSandbox).toBe(false)
    expect(config.enableWeakerNetworkIsolation).toBe(false)
    expect(config.ripgrep).toEqual({ command: 'rg', args: ['--hidden'] })
    expect(config.filesystem.disabled).toBeUndefined()
    expect(config.allowNestedUserNamespaces).toBeUndefined()
    expect(config.credentials).toBeUndefined()
    expect(config.windows).toBeUndefined()

    const policy = await inspectRuntimePolicy(config)
    expect(policy.getNetworkRestrictionConfig).toEqual({
      allowedHosts: ['*.example.org', 'api.example.com:443'],
      deniedHosts: ['blocked.example.com', '*:22'],
    })
    expect(policy.getAllowUnixSockets).toEqual(['/var/run/example.sock'])
    expect(policy.getAllowLocalBinding).toBe(false)
    expect(policy.getIgnoreViolations).toEqual({ '*': ['/dev/example'] })
    expect(policy.getEnableWeakerNestedSandbox).toBe(false)
  }, 10_000)

  test('loads filesystem rules from disk with their source path semantics', async () => {
    const configDir = process.env.OPENCLAUDE_CONFIG_DIR!
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'settings.json'), JSON.stringify({
      permissions: {
        allow: ['Edit(/editable/**)'],
        deny: ['Read(//private/**)', 'Edit(/locked/**)'],
      },
      sandbox: {
        filesystem: {
          allowWrite: ['./build'],
          denyWrite: [join(tempRoot, 'protected')],
          denyRead: ['./secrets'],
          allowRead: ['./secrets/public'],
        },
      },
    }))
    resetSettingsCache()
    const settings = getSettingsForSource('userSettings')!
    expect(settings.sandbox?.filesystem?.allowWrite).toEqual(['./build'])
    const config = SandboxRuntimeConfigSchema.parse(
      convertToSandboxRuntimeConfig(settings),
    )
    const policy = await inspectRuntimePolicy(config)
    const read = policy.getFsReadConfig
    const write = policy.getFsWriteConfig
    expect(read.denyOnly).toContain('/private')
    expect(read.denyOnly).toContain(join(configDir, 'secrets'))
    expect(read.allowWithinDeny).toContain(join(configDir, 'secrets/public'))
    expect(write.allowOnly).toContain(join(configDir, 'editable'))
    expect(write.allowOnly).toContain(join(configDir, 'build'))
    expect(write.denyWithinAllow).toContain(join(configDir, 'locked'))
    expect(write.denyWithinAllow).toContain(join(tempRoot, 'protected'))
    expect(write.denyWithinAllow).toContain(
      join(activeCwd, '.openclaude', 'settings.json'),
    )
  }, 10_000)

  test('keeps managed domain and read exceptions exclusive without dropping denies', () => {
    setCachedSettingsForSource('policySettings', SettingsSchema().parse({
      permissions: { allow: ['WebFetch(domain:managed.example.com)'] },
      sandbox: {
        network: {
          allowManagedDomainsOnly: true,
          allowedDomains: ['policy.example.com'],
        },
        filesystem: {
          allowManagedReadPathsOnly: true,
          allowRead: [join(tempRoot, 'policy-public')],
        },
      },
    }))
    const userSettings = SettingsSchema().parse({
      permissions: {
        allow: ['WebFetch(domain:user.example.com)'],
        deny: ['WebFetch(domain:blocked.example.com)'],
      },
      sandbox: {
        network: { allowedDomains: ['extra.example.com'] },
        filesystem: {
          allowRead: [join(tempRoot, 'user-public')],
          denyRead: [join(tempRoot, 'secrets')],
        },
      },
    })
    setCachedSettingsForSource('userSettings', userSettings)
    const config = SandboxRuntimeConfigSchema.parse(
      convertToSandboxRuntimeConfig(userSettings),
    )

    expect(config.network.allowedDomains).toEqual([
      'policy.example.com', 'managed.example.com',
    ])
    expect(config.network.deniedDomains).toEqual(['blocked.example.com'])
    expect(config.filesystem.allowRead).toEqual([join(tempRoot, 'policy-public')])
    expect(config.filesystem.denyRead).toContain(join(tempRoot, 'secrets'))
  })

  test('preserves an empty network allowlist through the runtime adapter', async () => {
    const config = SandboxRuntimeConfigSchema.parse(
      convertToSandboxRuntimeConfig(SettingsSchema().parse({})),
    )
    const policy = await inspectRuntimePolicy(config)

    expect(policy.getNetworkRestrictionConfig).toEqual({
      allowedHosts: [],
    })
    expect(policy.getAllowLocalBinding).toBeUndefined()
    expect(policy.getAllowUnixSockets).toBeUndefined()
  }, 10_000)

  test('exposes sanitized violation events and subscriptions through the adapter', () => {
    const store = SandboxManager.getSandboxViolationStore()
    const timestamp = new Date('2026-01-01T00:00:00Z')
    const count = store.getTotalCount()
    const lines: string[][] = []
    const unsubscribe = store.subscribe(events => {
      lines.push(events.map(event => event.line))
    })
    try {
      store.addViolation({
        line: 'deny\n<file-write>', command: 'touch blocked', timestamp,
      })
      expect(store.getViolations().at(-1)).toEqual({
        line: 'deny file-write', command: 'touch blocked', timestamp,
      })
      expect(store.getTotalCount()).toBe(count + 1)
      expect(lines.at(-1)).toEqual(['deny file-write'])
    } finally {
      unsubscribe()
      store.clear()
    }
  })
})
