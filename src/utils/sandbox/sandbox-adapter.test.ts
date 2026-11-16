import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { SandboxManager as BaseSandboxManager } from '@anthropic-ai/sandbox-runtime'
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'
import {
  getCwdState,
  getOriginalCwd,
  setCwdState,
  setOriginalCwd,
} from '../../bootstrap/state.js'
import { snapshotEnv } from '../../test/envSnapshot.js'
import { gitFixtureEnv } from '../../test/gitEnv.js'
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

// Git fixture commands must not inherit the invoking shell's repo env
// (GIT_DIR, GIT_WORK_TREE, ...) or they may operate on the wrong repository.
const git = (args: string[]) =>
  execFileSync('git', args, { env: gitFixtureEnv() })

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

  test('refreshWorktreeMainRepoPath adds the main-repo write allowance for a linked worktree', async () => {
    const repository = join(tempRoot, 'main-repo')
    const linkedWorktree = join(tempRoot, 'linked-worktree')
    git(['init', repository])
    git([
      '-C',
      repository,
      'config',
      'user.email',
      'test@example.com',
    ])
    git([
      '-C',
      repository,
      'config',
      'user.name',
      'OpenClaude Test',
    ])
    await writeFile(join(repository, 'seed.txt'), 'seed\n')
    git(['-C', repository, 'add', 'seed.txt'])
    git(['-C', repository, 'commit', '-m', 'seed'])
    git([
      '-C',
      repository,
      'worktree',
      'add',
      '-b',
      'feature-branch',
      linkedWorktree,
    ])

    // Mirrors the /cd flow: the session cwd moves into a linked worktree
    // after initialize(), so the once-at-init cache must be re-detected
    // before refreshConfig() runs.
    setCwdState(linkedWorktree)
    await SandboxManager.refreshWorktreeMainRepoPath(linkedWorktree)

    const config = convertToSandboxRuntimeConfig({} as SettingsJson)
    expect(config.filesystem.allowWrite).toContain(repository)

    // /cd into a child directory of the worktree must keep the allowance:
    // .git only exists at the worktree root, so detection has to ascend
    // rather than clearing the cached main-repo path.
    const childDir = join(linkedWorktree, 'src')
    await mkdir(childDir, { recursive: true })
    setCwdState(childDir)
    await SandboxManager.refreshWorktreeMainRepoPath(childDir)

    const childConfig = convertToSandboxRuntimeConfig({} as SettingsJson)
    expect(childConfig.filesystem.allowWrite).toContain(repository)
  })

  test('refreshWorktreeMainRepoPath keeps the cached main repo path when detection fails', async () => {
    // The failure path relies on EACCES, which chmod cannot produce on
    // Windows or for root.
    if (process.platform === 'win32' || process.geteuid?.() === 0) {
      return
    }

    const repository = join(tempRoot, 'main-repo-fail')
    const linkedWorktree = join(tempRoot, 'linked-worktree-fail')
    git(['init', repository])
    git([
      '-C',
      repository,
      'config',
      'user.email',
      'test@example.com',
    ])
    git([
      '-C',
      repository,
      'config',
      'user.name',
      'OpenClaude Test',
    ])
    await writeFile(join(repository, 'seed.txt'), 'seed\n')
    git(['-C', repository, 'add', 'seed.txt'])
    git(['-C', repository, 'commit', '-m', 'seed'])
    git([
      '-C',
      repository,
      'worktree',
      'add',
      '-b',
      'feature-branch-fail',
      linkedWorktree,
    ])

    setCwdState(linkedWorktree)
    await SandboxManager.refreshWorktreeMainRepoPath(linkedWorktree)
    expect(
      convertToSandboxRuntimeConfig({} as SettingsJson).filesystem.allowWrite,
    ).toContain(repository)

    // An unreadable .git makes the next lookup fail rather than answer
    // "not a worktree"; the failure must not clear the valid cache.
    const gitFile = join(linkedWorktree, '.git')
    await chmod(gitFile, 0o000)
    try {
      await SandboxManager.refreshWorktreeMainRepoPath(linkedWorktree)
      const config = convertToSandboxRuntimeConfig({} as SettingsJson)
      expect(config.filesystem.allowWrite).toContain(repository)
    } finally {
      await chmod(gitFile, 0o644)
    }
  })

  test('drops the allowance when detection fails inside a different worktree', async () => {
    // The failure path relies on EACCES, which chmod cannot produce on
    // Windows or for root.
    if (process.platform === 'win32' || process.geteuid?.() === 0) {
      return
    }

    const repoA = join(tempRoot, 'main-repo-a')
    const worktreeA = join(tempRoot, 'worktree-a')
    const repoB = join(tempRoot, 'main-repo-b')
    const worktreeB = join(tempRoot, 'worktree-b')
    for (const [repo, worktree, branch] of [
      [repoA, worktreeA, 'branch-a'],
      [repoB, worktreeB, 'branch-b'],
    ] as const) {
      git(['init', repo])
      git(['-C', repo, 'config', 'user.email', 'test@example.com'])
      git(['-C', repo, 'config', 'user.name', 'OpenClaude Test'])
      await writeFile(join(repo, 'seed.txt'), 'seed\n')
      git(['-C', repo, 'add', 'seed.txt'])
      git(['-C', repo, 'commit', '-m', 'seed'])
      git(['-C', repo, 'worktree', 'add', '-b', branch, worktree])
    }

    setCwdState(worktreeA)
    await SandboxManager.refreshWorktreeMainRepoPath(worktreeA)
    expect(
      convertToSandboxRuntimeConfig({} as SettingsJson).filesystem.allowWrite,
    ).toContain(repoA)

    // /cd into a different worktree whose .git is unreadable: a failed
    // re-detection there must not keep worktree A's grant.
    const gitFileB = join(worktreeB, '.git')
    await chmod(gitFileB, 0o000)
    try {
      setCwdState(worktreeB)
      await SandboxManager.refreshWorktreeMainRepoPath(worktreeB)
      const config = convertToSandboxRuntimeConfig({} as SettingsJson)
      expect(config.filesystem.allowWrite).not.toContain(repoA)
    } finally {
      await chmod(gitFileB, 0o644)
    }
  })

  test('detection stops ascending at GIT_CEILING_DIRECTORIES', async () => {
    const repository = join(tempRoot, 'main-repo-ceiling')
    const linkedWorktree = join(tempRoot, 'linked-worktree-ceiling')
    git(['init', repository])
    git(['-C', repository, 'config', 'user.email', 'test@example.com'])
    git(['-C', repository, 'config', 'user.name', 'OpenClaude Test'])
    await writeFile(join(repository, 'seed.txt'), 'seed\n')
    git(['-C', repository, 'add', 'seed.txt'])
    git(['-C', repository, 'commit', '-m', 'seed'])
    git(['-C', repository, 'worktree', 'add', '-b', 'branch-ceiling', linkedWorktree])

    // cwd sits below the worktree root; ceiling at the worktree root means the
    // .git there must not be seen, matching git's own root discovery.
    const childDir = join(linkedWorktree, 'nested')
    await mkdir(childDir, { recursive: true })
    const restoreCeiling = snapshotEnv(['GIT_CEILING_DIRECTORIES'], {
      clear: true,
    })
    try {
      process.env.GIT_CEILING_DIRECTORIES = linkedWorktree
      setCwdState(childDir)
      await SandboxManager.refreshWorktreeMainRepoPath(childDir)
      expect(
        convertToSandboxRuntimeConfig({} as SettingsJson).filesystem
          .allowWrite,
      ).not.toContain(repository)
    } finally {
      restoreCeiling()
    }
  })

  test('keeps the allowance across a failed detection from a canonical path', async () => {
    // The failure path relies on EACCES, which chmod cannot produce on
    // Windows or for root.
    if (process.platform === 'win32' || process.geteuid?.() === 0) {
      return
    }

    const repository = join(tempRoot, 'main-repo-link')
    const linkedWorktree = join(tempRoot, 'linked-worktree-link')
    git(['init', repository])
    git(['-C', repository, 'config', 'user.email', 'test@example.com'])
    git(['-C', repository, 'config', 'user.name', 'OpenClaude Test'])
    await writeFile(join(repository, 'seed.txt'), 'seed\n')
    git(['-C', repository, 'add', 'seed.txt'])
    git(['-C', repository, 'commit', '-m', 'seed'])
    git(['-C', repository, 'worktree', 'add', '-b', 'branch-link', linkedWorktree])

    // Detect via a symlinked path: the recorded owner must be canonical, or a
    // later lookup from the real path reads as a different worktree.
    const link = join(tempRoot, 'worktree-link')
    await symlink(linkedWorktree, link)
    setCwdState(link)
    await SandboxManager.refreshWorktreeMainRepoPath(link)
    expect(
      convertToSandboxRuntimeConfig({} as SettingsJson).filesystem.allowWrite,
    ).toContain(repository)

    const childDir = join(linkedWorktree, 'inner')
    await mkdir(childDir, { recursive: true })
    const gitFile = join(linkedWorktree, '.git')
    await chmod(gitFile, 0o000)
    try {
      setCwdState(childDir)
      await SandboxManager.refreshWorktreeMainRepoPath(childDir)
      const config = convertToSandboxRuntimeConfig({} as SettingsJson)
      expect(config.filesystem.allowWrite).toContain(repository)
    } finally {
      await chmod(gitFile, 0o644)
    }
  })
})
