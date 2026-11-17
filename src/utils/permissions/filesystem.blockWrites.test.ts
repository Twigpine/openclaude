import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { z } from 'zod/v4'
import type { ToolUseConfirm } from '../../components/permissions/PermissionRequest.js'
import {
  getCwdState,
  getOriginalCwd,
  setCwdState,
  setOriginalCwd,
} from '../../bootstrap/state.js'
import { getAutoMemPath } from '../../memdir/paths.js'
import { createToolFixture } from '../../test/toolFixtures.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import { setGovernancePolicySettingsForSourceForTesting } from '../governancePolicy.js'
import type { SettingsJson } from '../settings/types.js'
import {
  registerLeaderSetToolPermissionContext,
  registerLeaderToolUseConfirmQueue,
  unregisterLeaderSetToolPermissionContext,
  unregisterLeaderToolUseConfirmQueue,
} from '../swarm/leaderPermissionBridge.js'
import * as permissionUpdateModule from './PermissionUpdate.js'

const realSettings = await import(
  `../settings/settings.js?blockWritesActual=${Date.now()}-${Math.random()}`
)
let blockWritesOutsideWorkingDirectories = false
let denyInsteadOfPrompting = false
mock.module('../settings/settings.js', () => ({
  ...realSettings,
  getInitialSettings: (): SettingsJson => ({
    permissions: {
      blockWritesOutsideWorkingDirectories,
      denyInsteadOfPrompting,
    },
  }),
}))

let hookPermissionResult:
  | {
      behavior: 'allow'
      updatedInput?: { [key: string]: unknown }
      updatedPermissions?: (
        | {
            type: 'addDirectories' | 'removeDirectories'
            directories: string[]
            destination: 'session'
          }
        | { type: 'setMode'; mode: 'plan' | 'acceptEdits'; destination: 'session' }
      )[]
    }
  | undefined
const realHooks = await import(
  `../hooks.js?blockWritesHooksActual=${Date.now()}-${Math.random()}`
)
mock.module('../hooks.js', () => ({
  ...realHooks,
  executePermissionRequestHooks: async function* () {
    if (hookPermissionResult) {
      yield { permissionRequestResult: hookPermissionResult }
    }
  },
}))

let scratchpadGateEnabled = false
const realGrowthbook = await import(
  `../../services/analytics/growthbook.js?blockWritesGrowthbookActual=${Date.now()}-${Math.random()}`
)
mock.module('../../services/analytics/growthbook.js', () => ({
  ...realGrowthbook,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: (gateName: string): boolean =>
    gateName === 'tengu_scratch'
      ? scratchpadGateEnabled
      : realGrowthbook.checkStatsigFeatureGate_CACHED_MAY_BE_STALE(gateName),
}))

const realPermissions = await import(
  `./permissions.js?blockWritesPermissionsActual=${Date.now()}-${Math.random()}`
)
// When set, the race-guard revalidation removes this directory from the live
// permission context while the caller awaits it — exercising the post-await
// boundary recheck.
let removeDirDuringRevalidation:
  | string
  | { dir: string; onCall: number }
  | null = null
let revalidationCallCount = 0
mock.module('./permissions.js', () => ({
  ...realPermissions,
  revalidatePlanModePermissionAllowWithRaceGuard: (async (
    ...args: unknown[]
  ) => {
    revalidationCallCount++
    if (removeDirDuringRevalidation) {
      const spec =
        typeof removeDirDuringRevalidation === 'string'
          ? { dir: removeDirDuringRevalidation, onCall: 1 }
          : removeDirDuringRevalidation
      const dir = spec.onCall === revalidationCallCount ? spec.dir : null
      const toolUseContext = args[3] as ToolUseContext
      if (!dir) {
        return (
          realPermissions.revalidatePlanModePermissionAllowWithRaceGuard as (
            ...a: unknown[]
          ) => unknown
        )(...args)
      }
      toolUseContext.setAppState(prev => {
        const dirs = new Map(
          prev.toolPermissionContext.additionalWorkingDirectories,
        )
        dirs.delete(dir)
        return {
          ...prev,
          toolPermissionContext: {
            ...prev.toolPermissionContext,
            additionalWorkingDirectories: dirs,
          },
        }
      })
    }
    return (
      realPermissions.revalidatePlanModePermissionAllowWithRaceGuard as (
        ...a: unknown[]
      ) => unknown
    )(...args)
  }) as typeof realPermissions.revalidatePlanModePermissionAllowWithRaceGuard,
}))

const { checkWritePermissionForTool, getScratchpadDir, toPosixPath } = await import(
  './filesystem.js'
)
const {
  hasPermissionsToUseTool,
  checkRuleBasedPermissions,
  checkWriteBoundaryForAskRule,
  runPermissionRequestHooksForHeadlessAgent,
} = await import('./permissions.js')
const { createPermissionContext } = await import(
  '../../hooks/toolPermission/PermissionContext.js'
)
const { executePermissionRequestHooksForSDK, StructuredIO } = await import(
  '../../cli/structuredIO.js'
)
const {
  createExternalCanUseTool,
  createDefaultCanUseTool,
  createPermissionTarget,
} = await import('../../entrypoints/sdk/permissions.js')
const { permissionPromptToolResultToPermissionDecision } = await import(
  './PermissionPromptToolResultSchema.js'
)
const permissionSetupModule = await import('./permissionSetup.js')

const writeTool = createToolFixture(
  z.object({ file_path: z.string() }),
  {
    name: 'Write',
    getPath(input: { file_path: string }) {
      return input.file_path
    },
  },
)

function permissionContext(
  mode: ToolPermissionContext['mode'],
  additionalWorkingDirectories = new Map<
    string,
    { path: string; source: 'session' }
  >(),
  alwaysAskRules: ToolPermissionContext['alwaysAskRules'] = {},
): ToolPermissionContext {
  return {
    mode,
    additionalWorkingDirectories,
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules,
    isBypassPermissionsModeAvailable:
      mode === 'bypassPermissions' || mode === 'fullAccess',
  } satisfies ToolPermissionContext
}

function useContext(
  toolPermissionContext: ToolPermissionContext,
): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext }),
    setAppState: () => {},
    options: {
      agentDefinitions: {
        activeAgents: [],
        allAgents: [],
      },
    },
  } as unknown as ToolUseContext
}

// Unlike useContext, actually applies setAppState updates so tests can
// observe whether a denied path ever applied or persisted anything.
function useMutableContext(toolPermissionContext: ToolPermissionContext): {
  ctx: ToolUseContext
  setAppStateCalls: () => number
  setPermissionContext: (next: ToolPermissionContext) => void
} {
  let current = toolPermissionContext
  let calls = 0
  const ctx = {
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: current }),
    setAppState: (
      fn: (prev: { toolPermissionContext: ToolPermissionContext }) => {
        toolPermissionContext: ToolPermissionContext
      },
    ) => {
      calls++
      current = fn({ toolPermissionContext: current }).toolPermissionContext
    },
    options: {
      agentDefinitions: {
        activeAgents: [],
        allAgents: [],
      },
    },
  } as unknown as ToolUseContext
  return {
    ctx,
    setAppStateCalls: () => calls,
    setPermissionContext: (next: ToolPermissionContext) => {
      current = next
    },
  }
}

describe('permissions.blockWritesOutsideWorkingDirectories', () => {
  let projectDir: string
  let outsideDir: string
  let addedDir: string
  let originalCwd: string

  beforeAll(async () => {
    await acquireSharedMutationLock(
      'utils/permissions/filesystem.blockWrites.test.ts',
    )
    originalCwd = getOriginalCwd()
    projectDir = await mkdtemp(join(tmpdir(), 'oc-blockwrites-inside-'))
    outsideDir = await mkdtemp(join(tmpdir(), 'oc-blockwrites-outside-'))
    addedDir = await mkdtemp(join(tmpdir(), 'oc-blockwrites-added-'))
    setOriginalCwd(projectDir)
  })

  afterAll(async () => {
    try {
      blockWritesOutsideWorkingDirectories = false
      scratchpadGateEnabled = false
      setOriginalCwd(originalCwd)
      mock.restore()
      mock.module('../settings/settings.js', () => realSettings)
      mock.module('../hooks.js', () => realHooks)
      mock.module(
        '../../services/analytics/growthbook.js',
        () => realGrowthbook,
      )
      await rm(projectDir, { recursive: true, force: true })
      await rm(outsideDir, { recursive: true, force: true })
      await rm(addedDir, { recursive: true, force: true })
    } finally {
      releaseSharedMutationLock()
    }
  })

  const modes = [
    'default',
    'acceptEdits',
    'plan',
    'bypassPermissions',
  ] as const
  for (const mode of modes) {
    test(`refuses an outside path in ${mode} mode`, () => {
      blockWritesOutsideWorkingDirectories = true
      const result = checkWritePermissionForTool(
        writeTool,
        { file_path: join(outsideDir, 'out.txt') },
        permissionContext(mode),
      )
      if (result.behavior !== 'deny') {
        throw new Error(`expected deny, got ${result.behavior}`)
      }
      expect(result.message).toContain(
        'blockWritesOutsideWorkingDirectories',
      )
    })
  }

  test('allows a path inside the working directory', () => {
    blockWritesOutsideWorkingDirectories = true
    const result = checkWritePermissionForTool(
      writeTool,
      { file_path: join(projectDir, 'in.txt') },
      permissionContext('default'),
    )
    expect(result.behavior).not.toBe('deny')
  })

  test('the write boundary leaves Read inheritance and explicit Read rules intact', async () => {
    const { FileReadTool } = await import('../../tools/FileReadTool/FileReadTool.js')
    const input = { file_path: join(outsideDir, 'note.txt') }
    const pattern = `/${toPosixPath(input.file_path)}`
    const context = {
      ...permissionContext('default'),
      alwaysAllowRules: { session: [`Edit(${pattern})`] },
    }
    const read = (permissions: ToolPermissionContext) =>
      FileReadTool.checkPermissions(input, useContext(permissions))

    blockWritesOutsideWorkingDirectories = false
    expect(await read(context)).toMatchObject({ behavior: 'allow' })
    expect(checkWritePermissionForTool(writeTool, input, context)).toMatchObject({
      behavior: 'allow',
    })

    blockWritesOutsideWorkingDirectories = true
    expect(await read(context)).toMatchObject({ behavior: 'allow' })
    expect(checkWritePermissionForTool(writeTool, input, context)).toMatchObject({
      behavior: 'deny',
      decisionReason: { reason: 'permissions.blockWritesOutsideWorkingDirectories is enabled' },
    })
    expect(await read({
      ...context,
      alwaysDenyRules: { session: [`Read(${pattern})`] },
    })).toMatchObject({ behavior: 'deny' })
    expect(await read({
      ...context,
      alwaysAskRules: { session: [`Read(${pattern})`] },
    })).toMatchObject({ behavior: 'ask', decisionReason: { type: 'rule' } })
  })

  test('an added directory counts as inside', () => {
    blockWritesOutsideWorkingDirectories = true
    const result = checkWritePermissionForTool(
      writeTool,
      { file_path: join(addedDir, 'in.txt') },
      permissionContext(
        'default',
        new Map([[addedDir, { path: addedDir, source: 'session' as const }]]),
      ),
    )
    expect(result.behavior).not.toBe('deny')
  })

  test('keeps existing behavior when the setting is off', () => {
    blockWritesOutsideWorkingDirectories = false
    const result = checkWritePermissionForTool(
      writeTool,
      { file_path: join(outsideDir, 'out.txt') },
      permissionContext('bypassPermissions'),
    )
    if (result.behavior === 'deny') {
      expect(result.message).not.toContain(
        'blockWritesOutsideWorkingDirectories',
      )
    }
  })

  test('a case-variant path does not alias the working directory', async () => {
    if (process.platform !== 'linux') {
      return
    }
    blockWritesOutsideWorkingDirectories = true
    const caseDir = join(tmpdir(), `oc-casecheck-${Date.now()}-lower`)
    await mkdir(caseDir, { recursive: true })
    try {
      setOriginalCwd(caseDir)
      const outside = checkWritePermissionForTool(
        writeTool,
        { file_path: join(caseDir.toUpperCase(), 'x.txt') },
        permissionContext('bypassPermissions'),
      )
      expect(outside.behavior).toBe('deny')
      const inside = checkWritePermissionForTool(
        writeTool,
        { file_path: join(caseDir, 'x.txt') },
        permissionContext('bypassPermissions'),
      )
      expect(inside.behavior).not.toBe('deny')
    } finally {
      setOriginalCwd(projectDir)
      await rm(caseDir, { recursive: true, force: true })
    }
  })

  test('a whole-tool ask rule cannot bypass the boundary', async () => {
    blockWritesOutsideWorkingDirectories = true
    const context = useContext(
      permissionContext('default', new Map(), { localSettings: ['Write'] }),
    )
    const result = await hasPermissionsToUseTool(
      writeTool,
      { file_path: join(outsideDir, 'out.txt') },
      context,
      {} as Parameters<typeof hasPermissionsToUseTool>[3],
      'tool-use-boundary-1',
    )
    if (result.behavior !== 'deny') {
      throw new Error(`expected deny, got ${result.behavior}`)
    }
    expect(result.message).toContain('blockWritesOutsideWorkingDirectories')
  })

  test('checkRuleBasedPermissions enforces the boundary for ask rules', async () => {
    blockWritesOutsideWorkingDirectories = true
    const context = useContext(
      permissionContext('default', new Map(), { localSettings: ['Write'] }),
    )
    const result = await checkRuleBasedPermissions(
      writeTool,
      { file_path: join(outsideDir, 'out.txt') },
      context,
    )
    if (result?.behavior !== 'deny') {
      throw new Error(`expected deny, got ${result?.behavior}`)
    }
    expect(result.message).toContain('blockWritesOutsideWorkingDirectories')
  })

  test('a symlinked launch config cannot escape the boundary', async () => {
    blockWritesOutsideWorkingDirectories = true
    const openclaudeDir = join(projectDir, '.openclaude')
    await mkdir(openclaudeDir, { recursive: true })
    const linkPath = join(openclaudeDir, 'launch.json')
    const targetPath = join(outsideDir, 'launch.json')
    await writeFile(targetPath, '{}')
    await symlink(targetPath, linkPath)
    const result = checkWritePermissionForTool(
      writeTool,
      { file_path: linkPath },
      permissionContext('bypassPermissions'),
    )
    if (result.behavior !== 'deny') {
      throw new Error(`expected deny, got ${result.behavior}`)
    }
    expect(result.message).toContain('blockWritesOutsideWorkingDirectories')
  })

  test('a real launch config inside the project stays allowed', async () => {
    blockWritesOutsideWorkingDirectories = true
    const openclaudeDir = join(projectDir, '.openclaude')
    await mkdir(openclaudeDir, { recursive: true })
    const configPath = join(openclaudeDir, 'launch.json')
    await rm(configPath, { force: true })
    await writeFile(configPath, '{}')
    const result = checkWritePermissionForTool(
      writeTool,
      { file_path: configPath },
      permissionContext('bypassPermissions'),
    )
    expect(result.behavior).not.toBe('deny')
  })

  test('a symlinked launch config is denied through the ask-rule path', async () => {
    blockWritesOutsideWorkingDirectories = true
    const openclaudeDir = join(projectDir, '.openclaude')
    await mkdir(openclaudeDir, { recursive: true })
    const linkPath = join(openclaudeDir, 'launch.json')
    const targetPath = join(outsideDir, 'launch-ask.json')
    await writeFile(targetPath, '{}')
    await rm(linkPath, { force: true })
    await symlink(targetPath, linkPath)
    const context = useContext(
      permissionContext('default', new Map(), { localSettings: ['Write'] }),
    )
    const result = await hasPermissionsToUseTool(
      writeTool,
      { file_path: linkPath },
      context,
      {} as Parameters<typeof hasPermissionsToUseTool>[3],
      'tool-use-boundary-askrule',
    )
    if (result.behavior !== 'deny') {
      throw new Error(`expected deny, got ${result.behavior}`)
    }
    expect(result.message).toContain('blockWritesOutsideWorkingDirectories')
  })

  test('a filesystem-root working directory still contains POSIX paths', () => {
    if (process.platform === 'win32') {
      return
    }
    blockWritesOutsideWorkingDirectories = true
    setOriginalCwd('/')
    try {
      const result = checkWritePermissionForTool(
        writeTool,
        { file_path: join(outsideDir, 'out.txt') },
        permissionContext('bypassPermissions'),
      )
      expect(result.behavior).not.toBe('deny')
    } finally {
      setOriginalCwd(projectDir)
    }
  })

  test('a drive-root working directory does not span volumes', () => {
    if (process.platform !== 'win32') {
      return
    }
    blockWritesOutsideWorkingDirectories = true
    setOriginalCwd('C:\\')
    try {
      const result = checkWritePermissionForTool(
        writeTool,
        { file_path: 'D:\\outside\\out.txt' },
        permissionContext('bypassPermissions'),
      )
      expect(result.behavior).toBe('deny')
    } finally {
      setOriginalCwd(projectDir)
    }
  })

  test('a UNC-prefixed target is denied without path resolution', () => {
    blockWritesOutsideWorkingDirectories = true
    const result = checkWritePermissionForTool(
      writeTool,
      { file_path: '//nonexistent-server/share/out.txt' },
      permissionContext('bypassPermissions'),
    )
    expect(result.behavior).toBe('deny')
  })

  test('a hook-rewritten input still hits the boundary', async () => {
    blockWritesOutsideWorkingDirectories = true
    hookPermissionResult = {
      behavior: 'allow',
      updatedInput: { file_path: join(outsideDir, 'hooked.txt') },
    }
    try {
      const askWriteTool = createToolFixture(
        z.object({ file_path: z.string() }),
        {
          name: 'Write',
          getPath(input: { file_path: string }) {
            return input.file_path
          },
          async checkPermissions(input) {
            return {
              behavior: 'ask' as const,
              message: 'Write requires approval',
              updatedInput: input,
            }
          },
        },
      )
      const toolPermissionContext: ToolPermissionContext = {
        ...permissionContext('default'),
        shouldAvoidPermissionPrompts: true,
      }
      const result = await hasPermissionsToUseTool(
        askWriteTool,
        { file_path: join(projectDir, 'inside.txt') },
        useContext(toolPermissionContext),
        {} as Parameters<typeof hasPermissionsToUseTool>[3],
        'tool-use-boundary-hook',
      )
      if (result.behavior !== 'deny') {
        throw new Error(`expected deny, got ${result.behavior}`)
      }
      expect(result.message).toContain('blockWritesOutsideWorkingDirectories')
    } finally {
      hookPermissionResult = undefined
    }
  })

  test('an interactive hook allow still hits the boundary', async () => {
    blockWritesOutsideWorkingDirectories = true
    hookPermissionResult = {
      behavior: 'allow',
      updatedInput: { file_path: join(outsideDir, 'hooked.txt') },
    }
    try {
      const toolPermissionContext = permissionContext('default')
      const permissionCtx = createPermissionContext(
        writeTool,
        { file_path: join(projectDir, 'inside.txt') },
        useContext(toolPermissionContext),
        { message: { id: 'blockwrites-interactive' } } as never,
        'blockwrites-interactive',
        () => {},
      )
      const result = await permissionCtx.runHooks(undefined, undefined)
      expect(result?.behavior).toBe('deny')
      if (result?.behavior === 'deny') {
        expect(result.message).toContain('blockWritesOutsideWorkingDirectories')
      }
    } finally {
      hookPermissionResult = undefined
    }
  })

  test('an SDK hook allow still hits the boundary', async () => {
    blockWritesOutsideWorkingDirectories = true
    hookPermissionResult = {
      behavior: 'allow',
      updatedInput: { file_path: join(outsideDir, 'hooked.txt') },
    }
    try {
      const toolPermissionContext = permissionContext('default')
      const result = await executePermissionRequestHooksForSDK(
        writeTool,
        'blockwrites-sdk',
        { file_path: join(projectDir, 'inside.txt') },
        useContext(toolPermissionContext),
        undefined,
      )
      expect(result?.behavior).toBe('deny')
      if (result?.behavior === 'deny') {
        expect(result.message).toContain('blockWritesOutsideWorkingDirectories')
      }
    } finally {
      hookPermissionResult = undefined
    }
  })

  test('a user allow with an outside rewrite still hits the boundary', async () => {
    blockWritesOutsideWorkingDirectories = true
    const toolPermissionContext = permissionContext('default')
    const permissionCtx = createPermissionContext(
      writeTool,
      { file_path: join(projectDir, 'inside.txt') },
      useContext(toolPermissionContext),
      { message: { id: 'blockwrites-user-allow' } } as never,
      'blockwrites-user-allow',
      () => {},
    )
    const result = await permissionCtx.handleUserAllow(
      { file_path: join(outsideDir, 'user-edited.txt') },
      [],
    )
    expect(result.behavior).toBe('deny')
    if (result.behavior === 'deny') {
      expect(result.message).toContain('blockWritesOutsideWorkingDirectories')
    }
  })

  test('a classifier allow with an outside rewrite still hits the boundary', async () => {
    blockWritesOutsideWorkingDirectories = true
    const toolPermissionContext = permissionContext('default')
    const permissionCtx = createPermissionContext(
      writeTool,
      { file_path: join(projectDir, 'inside.txt') },
      useContext(toolPermissionContext),
      { message: { id: 'blockwrites-classifier-allow' } } as never,
      'blockwrites-classifier-allow',
      () => {},
    )
    const result = await permissionCtx.handleClassifierAllow(
      { file_path: join(outsideDir, 'classifier.txt') },
      { type: 'hook', hookName: 'PermissionRequest' },
    )
    expect(result.behavior).toBe('deny')
    if (result.behavior === 'deny') {
      expect(result.message).toContain('blockWritesOutsideWorkingDirectories')
    }
  })

  test('an SDK callback allow with an outside rewrite still hits the boundary', async () => {
    blockWritesOutsideWorkingDirectories = true
    const toolPermissionContext = permissionContext('default')
    const canUseTool = createExternalCanUseTool(
      async () => ({
        behavior: 'allow' as const,
        updatedInput: { file_path: join(outsideDir, 'sdk.txt') },
      }),
      async () => ({
        behavior: 'deny' as const,
        message: 'unreached',
        decisionReason: { type: 'other' as const, reason: 'unreached' },
      }),
      { deletePendingPermission: () => {} } as never,
    )
    const result = await canUseTool(
      writeTool,
      { file_path: join(projectDir, 'inside.txt') },
      useContext(toolPermissionContext),
      {} as never,
      'blockwrites-sdk-callback',
    )
    expect(result.behavior).toBe('deny')
    if (result.behavior === 'deny') {
      expect(result.message).toContain('blockWritesOutsideWorkingDirectories')
    }
  })

  test.each(['callback', 'permission request'] as const)(
    'SDK %s approvals require working-directory context only with the boundary enabled',
    async route => {
      const fallback = createDefaultCanUseTool(permissionContext('default'))
      const target = createPermissionTarget()
      const allow = {
        behavior: 'allow',
        updatedInput: { file_path: join(outsideDir, 'sdk.txt') },
      } as const
      const canUseTool = createExternalCanUseTool(
        route === 'callback' ? async () => allow : undefined,
        fallback,
        target,
        route === 'permission request'
          ? ({ tool_use_id }) => {
              target.pendingPermissionPrompts.get(tool_use_id)?.resolve(allow)
            }
          : undefined,
        undefined,
        500,
      )
      const minimalContext = { getAppState: undefined } as unknown as ToolUseContext
      const check = () =>
        canUseTool(
          writeTool,
          { file_path: join(projectDir, 'inside.txt') },
          minimalContext,
          {} as never,
          'minimal-sdk',
        )

      blockWritesOutsideWorkingDirectories = true
      expect(await check()).toMatchObject({
        behavior: 'deny',
        decisionReason: { reason: 'Permission context is unavailable' },
      })
      blockWritesOutsideWorkingDirectories = false
      expect((await check()).behavior).toBe('allow')
    },
  )

  test('SDK and structured IO forced allows honor the rewritten write path', async () => {
    blockWritesOutsideWorkingDirectories = true
    const ctx = useContext(permissionContext('default'))
    const fallback = createDefaultCanUseTool(ctx.getAppState().toolPermissionContext)
    const external = createExternalCanUseTool(undefined, fallback, {} as never)
    const structured = new StructuredIO((async function* () {})()).createCanUseTool()
    const originalInput = { file_path: join(projectDir, 'inside.txt') }
    for (const canUseTool of [fallback, external, structured]) {
      const check = (file_path: string) => canUseTool(
        writeTool, originalInput, ctx, {} as never, 'forced-write',
        { behavior: 'allow', updatedInput: { file_path } },
      )
      expect(await check(join(outsideDir, 'forced.txt'))).toMatchObject({
        behavior: 'deny',
        decisionReason: {
          reason: 'permissions.blockWritesOutsideWorkingDirectories is enabled',
        },
      })
      expect(await check(originalInput.file_path)).toMatchObject({
        behavior: 'allow',
        updatedInput: originalInput,
      })
    }
  })

  test('an SDK PermissionRequest hook can answer a suppression denial', async () => {
    denyInsteadOfPrompting = true
    hookPermissionResult = {
      behavior: 'allow',
      updatedInput: { file_path: join(projectDir, 'hook-allowed.txt') },
    }
    try {
      const askWriteTool = createToolFixture(
        z.object({ file_path: z.string() }),
        {
          name: 'Write',
          getPath(input: { file_path: string }) {
            return input.file_path
          },
          async checkPermissions(input) {
            return {
              behavior: 'ask' as const,
              message: 'Write requires approval',
              updatedInput: input,
            }
          },
        },
      )
      const io = new StructuredIO((async function* () {})())
      const canUseTool = io.createCanUseTool()
      const result = await canUseTool(
        askWriteTool,
        { file_path: join(projectDir, 'inside.txt') },
        useContext(permissionContext('default')),
        {} as never,
        'blockwrites-suppression-hook',
      )
      // denyInsteadOfPrompting converted the ask to a denial, but the hook
      // gets its chance first, matching the headless ordering.
      expect(result.behavior).toBe('allow')
    } finally {
      denyInsteadOfPrompting = false
      hookPermissionResult = undefined
    }
  })

  test('print, structured IO, and worker suppression give hooks the effective ask', async () => {
    const { createCanUseToolWithPermissionPrompt, getCanUseToolFn } =
      await import('../../cli/print.js')
    const { createInProcessCanUseTool } = await import('../swarm/inProcessRunner.js')
    const mutable = useMutableContext(permissionContext('default'))
    const worker = createInProcessCanUseTool(
      {
        agentId: 'permission-test',
        agentName: 'permission-test',
        teamName: 'permission-test',
        planModeRequired: false,
        parentSessionId: 'permission-test',
      },
      mutable.ctx.abortController,
    )
    const prompt = createToolFixture(z.object({}), {
      name: 'mcp__fixture__approve',
      call: async () => {
        throw new Error('unexpected prompt')
      },
    })
    const io = new StructuredIO((async function* () {})())
    const noPrompt = getCanUseToolFn(undefined, io, () => [])
    const originalInput = { file_path: join(projectDir, 'original.txt') }
    const updatedInput = { file_path: join(projectDir, 'replacement.txt') }
    const ask = { behavior: 'ask', message: 'approval required', updatedInput } as const
    const askWrite = { ...writeTool, checkPermissions: async () => ask }
    let prompts = 0
    registerLeaderToolUseConfirmQueue(() => { prompts++ })
    denyInsteadOfPrompting = true
    try {
      const customPrompt = createCanUseToolWithPermissionPrompt(prompt as never)
      for (const canUseTool of [noPrompt, customPrompt, worker, io.createCanUseTool()]) {
        for (const forceDecision of [ask, undefined]) {
          const run = () => canUseTool(
            askWrite, originalInput, mutable.ctx, {} as never, 'suppressed-ask',
            forceDecision,
          )
          expect(await run()).toMatchObject({ behavior: 'deny' })
          hookPermissionResult = { behavior: 'allow' }
          expect(await run()).toMatchObject({ behavior: 'allow', updatedInput })
          hookPermissionResult = undefined
        }
      }
      expect(prompts).toBe(0)
      denyInsteadOfPrompting = false
      expect(await noPrompt(
        writeTool, { file_path: join(projectDir, 'note.txt') },
        mutable.ctx, {} as never, 'forced-ask-off',
        { behavior: 'ask', message: 'approval required' },
      )).toMatchObject({ behavior: 'ask' })
    } finally {
      denyInsteadOfPrompting = false
      hookPermissionResult = undefined
      unregisterLeaderToolUseConfirmQueue()
      mutable.ctx.abortController.abort()
    }
  })

  test('the custom print prompt validates the effective input using the requested tool', async () => {
    const { createCanUseToolWithPermissionPrompt } = await import('../../cli/print.js')
    let finalPath = join(outsideDir, 'rewritten.txt')
    const prompt = createToolFixture(z.object({}), {
      name: 'mcp__fixture__approve',
      call: async () => ({ data: '' }),
      mapToolResultToToolResultBlockParam: () => ({
        type: 'tool_result',
        tool_use_id: 'print-approval',
        content: [{ type: 'text', text: JSON.stringify({
          behavior: 'allow', updatedInput: { file_path: finalPath },
        }) }],
      }),
    })
    const ctx = useContext(permissionContext('default'))
    const canUseTool = createCanUseToolWithPermissionPrompt(prompt as never)
    const run = () => canUseTool(
      writeTool, { file_path: join(projectDir, 'note.txt') },
      ctx, {} as never, 'print-approval',
      { behavior: 'ask', message: 'approval required' },
    )
    blockWritesOutsideWorkingDirectories = true
    expect(await run()).toMatchObject({
      behavior: 'deny',
      decisionReason: { reason: 'permissions.blockWritesOutsideWorkingDirectories is enabled' },
    })
    finalPath = join(projectDir, 'rewritten.txt')
    expect(await run()).toMatchObject({
      behavior: 'allow',
      updatedInput: { file_path: finalPath },
      decisionReason: { permissionPromptToolName: prompt.name },
    })
  })

  test('leader approvals validate both the rewritten target and bundled directory changes', async () => {
    const { createInProcessCanUseTool } = await import('../swarm/inProcessRunner.js')
    const mutable = useMutableContext(permissionContext('default', new Map([
      [addedDir, { path: addedDir, source: 'session' }],
    ])))
    const worker = createInProcessCanUseTool(
      {
        agentId: 'permission-test',
        agentName: 'permission-test',
        teamName: 'permission-test',
        planModeRequired: false,
        parentSessionId: 'permission-test',
      },
      mutable.ctx.abortController,
    )
    let updateCount = 0
    let receivePrompt: (item: ToolUseConfirm) => void
    registerLeaderToolUseConfirmQueue(update => {
      const item = update([])[0]
      if (item) receivePrompt(item)
    })
    registerLeaderSetToolPermissionContext(() => { updateCount++ })
    blockWritesOutsideWorkingDirectories = true
    try {
      async function approve(path: string, removeDirectory: boolean) {
        const presented = new Promise<ToolUseConfirm>(resolve => { receivePrompt = resolve })
        const decision = worker(
          writeTool, { file_path: join(projectDir, 'note.txt') },
          mutable.ctx, {} as never, 'leader-approval',
          { behavior: 'ask', message: 'approval required' },
        )
        const prompt = await presented
        await prompt.onAllow({ file_path: path }, removeDirectory ? [{
          type: 'removeDirectories', directories: [addedDir], destination: 'session',
        }] : [])
        return decision
      }
      expect(await approve(join(outsideDir, 'note.txt'), false)).toMatchObject({ behavior: 'deny' })
      expect(await approve(join(addedDir, 'note.txt'), true)).toMatchObject({ behavior: 'deny' })
      expect(await approve(join(addedDir, 'note.txt'), false)).toMatchObject({ behavior: 'allow' })
      expect(updateCount).toBe(0)
    } finally {
      unregisterLeaderToolUseConfirmQueue()
      unregisterLeaderSetToolPermissionContext()
      mutable.ctx.abortController.abort()
    }
  })

  test('hooks cannot grant the working directory for the write in their own approval', async () => {
    blockWritesOutsideWorkingDirectories = true
    const originalInput = { file_path: join(projectDir, 'note.txt') }
    hookPermissionResult = {
      behavior: 'allow',
      updatedInput: { file_path: join(addedDir, 'note.txt') },
      updatedPermissions: [{
        type: 'addDirectories', directories: [addedDir], destination: 'session',
      }],
    }
    const mutable = useMutableContext(permissionContext('default'))
    try {
      const sdk = await executePermissionRequestHooksForSDK(
        writeTool, 'self-grant', originalInput, mutable.ctx, undefined,
      )
      const headless = await runPermissionRequestHooksForHeadlessAgent(
        writeTool, originalInput, 'self-grant', mutable.ctx, 'default', undefined,
      )
      expect(sdk).toMatchObject({ behavior: 'deny' })
      expect(headless).toMatchObject({ behavior: 'deny' })
      expect(mutable.setAppStateCalls()).toBe(0)
    } finally {
      hookPermissionResult = undefined
    }
  })

  test('an unverified hook rewrite cannot commit permission updates with the boundary enabled', async () => {
    const strictWrite = {
      ...writeTool,
      inputSchema: z.strictObject({ file_path: z.string() }),
    }
    hookPermissionResult = {
      behavior: 'allow',
      updatedInput: { file_path: join(projectDir, 'note.txt'), unexpected: true },
      updatedPermissions: [{
        type: 'addDirectories', directories: [addedDir], destination: 'session',
      }],
    }
    const mutable = useMutableContext(permissionContext('default'))
    const persist = spyOn(permissionUpdateModule, 'persistPermissionUpdates')
      .mockImplementation(() => {})
    const run = () => runPermissionRequestHooksForHeadlessAgent(
      strictWrite,
      { file_path: join(projectDir, 'original.txt') },
      'invalid-hook-approval',
      mutable.ctx,
      'default',
      undefined,
    )
    try {
      blockWritesOutsideWorkingDirectories = true
      expect(await run()).toMatchObject({
        behavior: 'deny',
        decisionReason: { type: 'workingDir', reason: 'Input failed schema validation' },
      })
      expect(mutable.setAppStateCalls()).toBe(0)
      expect(persist).not.toHaveBeenCalled()

      blockWritesOutsideWorkingDirectories = false
      expect(await run()).toMatchObject({ behavior: 'allow' })
    } finally {
      persist.mockRestore()
      hookPermissionResult = undefined
    }
  })

  test('a hook cannot remove a working directory and allow a write under it', async () => {
    blockWritesOutsideWorkingDirectories = true
    // The hook allows a write under outsideDir while the same decision
    // removes outsideDir from the working set. The boundary must be
    // rechecked against the post-update context, before the update is
    // applied or persisted.
    hookPermissionResult = {
      behavior: 'allow',
      updatedInput: { file_path: join(outsideDir, 'hooked.txt') },
      updatedPermissions: [
        {
          type: 'removeDirectories',
          directories: [outsideDir],
          destination: 'session',
        },
      ],
    }
    try {
      const toolPermissionContext = permissionContext(
        'default',
        new Map([[outsideDir, { path: outsideDir, source: 'session' }]]),
      )
      const result = await executePermissionRequestHooksForSDK(
        writeTool,
        'blockwrites-sdk-remove-dir',
        { file_path: join(projectDir, 'inside.txt') },
        useContext(toolPermissionContext),
        undefined,
      )
      expect(result?.behavior).toBe('deny')
      if (result?.behavior === 'deny') {
        expect(result.message).toContain('blockWritesOutsideWorkingDirectories')
      }
    } finally {
      hookPermissionResult = undefined
    }
  })

  test('boundary validation does not fire live mode-transition effects', async () => {
    blockWritesOutsideWorkingDirectories = true
    // A hook bundles a mode change with the directory removal that dooms its
    // own allow. The staged check must not run live transitions: on deny,
    // applyPermissionUpdatesToLiveContext must never be reached.
    hookPermissionResult = {
      behavior: 'allow',
      updatedInput: { file_path: join(outsideDir, 'hooked.txt') },
      updatedPermissions: [
        { type: 'setMode', mode: 'plan', destination: 'session' },
        {
          type: 'removeDirectories',
          directories: [outsideDir],
          destination: 'session',
        },
      ],
    }
    const liveApplySpy = spyOn(
      permissionSetupModule,
      'applyPermissionUpdatesToLiveContext',
    )
    try {
      const toolPermissionContext = permissionContext(
        'default',
        new Map([[outsideDir, { path: outsideDir, source: 'session' }]]),
      )
      const result = await executePermissionRequestHooksForSDK(
        writeTool,
        'blockwrites-staged-pure',
        { file_path: join(projectDir, 'inside.txt') },
        useContext(toolPermissionContext),
        undefined,
      )
      expect(result?.behavior).toBe('deny')
      expect(liveApplySpy).not.toHaveBeenCalled()
    } finally {
      liveApplySpy.mockRestore()
      hookPermissionResult = undefined
    }
  })

  test('a headless hook cannot remove a working directory and allow a write under it', async () => {
    blockWritesOutsideWorkingDirectories = true
    hookPermissionResult = {
      behavior: 'allow',
      updatedInput: { file_path: join(outsideDir, 'hooked.txt') },
      updatedPermissions: [
        {
          type: 'removeDirectories',
          directories: [outsideDir],
          destination: 'session',
        },
      ],
    }
    try {
      const askWriteTool = createToolFixture(
        z.object({ file_path: z.string() }),
        {
          name: 'Write',
          getPath(input: { file_path: string }) {
            return input.file_path
          },
          async checkPermissions(input) {
            return {
              behavior: 'ask' as const,
              message: 'Write requires approval',
              updatedInput: input,
            }
          },
        },
      )
      const toolPermissionContext: ToolPermissionContext = {
        ...permissionContext(
          'default',
          new Map([[outsideDir, { path: outsideDir, source: 'session' }]]),
        ),
        shouldAvoidPermissionPrompts: true,
      }
      const mutable = useMutableContext(toolPermissionContext)
      const result = await hasPermissionsToUseTool(
        askWriteTool,
        { file_path: join(projectDir, 'inside.txt') },
        mutable.ctx,
        {} as Parameters<typeof hasPermissionsToUseTool>[3],
        'blockwrites-headless-remove-dir',
      )
      if (result.behavior !== 'deny') {
        throw new Error(`expected deny, got ${result.behavior}`)
      }
      expect(result.message).toContain('blockWritesOutsideWorkingDirectories')
      // The removal must never have been applied to session state.
      expect(mutable.setAppStateCalls()).toBe(0)
    } finally {
      hookPermissionResult = undefined
    }
  })

  test('an interactive hook allow cannot remove a working directory and allow a write under it', async () => {
    blockWritesOutsideWorkingDirectories = true
    hookPermissionResult = {
      behavior: 'allow',
      updatedInput: { file_path: join(outsideDir, 'hooked.txt') },
      updatedPermissions: [
        {
          type: 'removeDirectories',
          directories: [outsideDir],
          destination: 'session',
        },
      ],
    }
    let contextWrites = 0
    try {
      const toolPermissionContext = permissionContext(
        'default',
        new Map([[outsideDir, { path: outsideDir, source: 'session' }]]),
      )
      const permissionCtx = createPermissionContext(
        writeTool,
        { file_path: join(projectDir, 'inside.txt') },
        useContext(toolPermissionContext),
        { message: { id: 'blockwrites-hook-remove-dir' } } as never,
        'blockwrites-hook-remove-dir',
        () => {
          contextWrites++
        },
      )
      const result = await permissionCtx.runHooks(undefined, undefined)
      expect(result?.behavior).toBe('deny')
      if (result?.behavior === 'deny') {
        expect(result.message).toContain('blockWritesOutsideWorkingDirectories')
      }
      // persistPermissions applies via the context setter; on deny it must
      // never run.
      expect(contextWrites).toBe(0)
    } finally {
      hookPermissionResult = undefined
    }
  })

  test('a user allow cannot remove a working directory and allow a write under it', async () => {
    blockWritesOutsideWorkingDirectories = true
    let contextWrites = 0
    const toolPermissionContext = permissionContext(
      'default',
      new Map([[outsideDir, { path: outsideDir, source: 'session' }]]),
    )
    const permissionCtx = createPermissionContext(
      writeTool,
      { file_path: join(projectDir, 'inside.txt') },
      useContext(toolPermissionContext),
      { message: { id: 'blockwrites-user-remove-dir' } } as never,
      'blockwrites-user-remove-dir',
      () => {
        contextWrites++
      },
    )
    const result = await permissionCtx.handleUserAllow(
      { file_path: join(outsideDir, 'user-edited.txt') },
      [
        {
          type: 'removeDirectories',
          directories: [outsideDir],
          destination: 'session',
        },
      ] as never,
    )
    expect(result.behavior).toBe('deny')
    if (result.behavior === 'deny') {
      expect(result.message).toContain('blockWritesOutsideWorkingDirectories')
    }
    expect(contextWrites).toBe(0)
  })

  test('a permission-prompt responder cannot remove a working directory and allow a write under it', async () => {
    blockWritesOutsideWorkingDirectories = true
    const toolPermissionContext = permissionContext(
      'default',
      new Map([[outsideDir, { path: outsideDir, source: 'session' }]]),
    )
    const mutable = useMutableContext(toolPermissionContext)
    const result = await permissionPromptToolResultToPermissionDecision(
      {
        behavior: 'allow',
        updatedInput: { file_path: join(outsideDir, 'responder.txt') },
        updatedPermissions: [
          {
            type: 'removeDirectories',
            directories: [outsideDir],
            destination: 'session',
          },
        ],
      } as never,
      writeTool,
      { file_path: join(projectDir, 'inside.txt') },
      mutable.ctx,
    )
    expect(result.behavior).toBe('deny')
    if (result.behavior === 'deny') {
      expect(result.message).toContain('blockWritesOutsideWorkingDirectories')
    }
    expect(mutable.setAppStateCalls()).toBe(0)
  })

  test.each(['structured IO', 'headless', 'prompt tool'] as const)(
    '%s discards bundled updates when the live write boundary denies',
    async route => {
      blockWritesOutsideWorkingDirectories = true
      const originalInput = { file_path: join(projectDir, 'inside.txt') }
      const updatedInput = { file_path: join(addedDir, 'approved.txt') }
      const update = { type: 'setMode', mode: 'acceptEdits', destination: 'session' } as const
      const allow = { behavior: 'allow', updatedInput, updatedPermissions: [update] } as const
      hookPermissionResult = { ...allow, updatedPermissions: [update] }
      const mutable = useMutableContext({
        ...permissionContext('default', new Map([
          [addedDir, { path: addedDir, source: 'session' }],
        ])),
        shouldAvoidPermissionPrompts: true,
      })
      let rootReads = 0
      const ctx: ToolUseContext = {
        ...mutable.ctx,
        getRootAppState: () => {
          // The prompt result has an additional validation before staging.
          // Remove the directory only during the final validation round.
          if (++rootReads === (route === 'prompt tool' ? 3 : 1)) {
            mutable.setPermissionContext(permissionContext('default'))
          }
          return mutable.ctx.getAppState()
        },
      }
      const askWrite = { ...writeTool, checkPermissions: async () => ({
        behavior: 'ask' as const,
        message: 'Confirm write',
      }) }
      const persist = spyOn(permissionUpdateModule, 'persistPermissionUpdates')
        .mockImplementation(() => {})
      try {
        const result = route === 'structured IO'
          ? await executePermissionRequestHooksForSDK(
              askWrite, 'staged-structured', originalInput, ctx, undefined,
            )
          : route === 'headless'
            ? await hasPermissionsToUseTool(
                askWrite, originalInput, ctx, {} as never, 'staged-headless',
              )
            : await permissionPromptToolResultToPermissionDecision(
                { ...allow, updatedPermissions: [update] }, askWrite, originalInput, ctx,
              )

        expect(result).toMatchObject({
          behavior: 'deny',
          decisionReason: {
            reason: 'permissions.blockWritesOutsideWorkingDirectories is enabled',
          },
        })
        expect(rootReads).toBeGreaterThan(0)
        expect(mutable.setAppStateCalls()).toBe(0)
        expect(persist).not.toHaveBeenCalled()
      } finally {
        persist.mockRestore()
        hookPermissionResult = undefined
      }
    },
  )

  test('a headless hook allow is denied when a concurrent update removes its directory', async () => {
    blockWritesOutsideWorkingDirectories = true
    const mutable = useMutableContext(
      permissionContext(
        'default',
        new Map([[addedDir, { path: addedDir, source: 'session' }]]),
      ),
    )
    hookPermissionResult = {
      behavior: 'allow',
      updatedInput: { file_path: join(addedDir, 'hooked.txt') },
      // The update list is read after the awaited checks inside the hook
      // helper; removing the directory on read models a concurrent
      // decision landing in that window.
      get updatedPermissions() {
        mutable.ctx.setAppState(prev => ({
          ...prev,
          toolPermissionContext: {
            ...prev.toolPermissionContext,
            additionalWorkingDirectories: new Map(),
          },
        }))
        return []
      },
    }
    try {
      const result = await runPermissionRequestHooksForHeadlessAgent(
        writeTool,
        { file_path: join(projectDir, 'inside.txt') },
        'blockwrites-headless-live',
        mutable.ctx,
        'default',
        undefined,
      )
      expect(result?.behavior).toBe('deny')
      if (result?.behavior === 'deny') {
        expect(result.message).toContain('blockWritesOutsideWorkingDirectories')
      }
    } finally {
      hookPermissionResult = undefined
    }
  })

  test('an allow surviving the hook path is denied when revalidation removes its directory', async () => {
    blockWritesOutsideWorkingDirectories = true
    // The race-guard revalidation reads getRootAppState in the tail await
    // of hasPermissionsToUseTool; flipping the directory there models a
    // concurrent removal while the final awaited validation runs.
    // rootCalls > 0 proves the flow reached the tail (a helper-level deny
    // would never invoke it).
    let rootCalls = 0
    const mutable = useMutableContext({
      ...permissionContext(
        'default',
        new Map([[addedDir, { path: addedDir, source: 'session' }]]),
      ),
      shouldAvoidPermissionPrompts: true,
    })
    const ctx = {
      ...mutable.ctx,
      getRootAppState: () => {
        rootCalls++
        if (rootCalls === 1) {
          mutable.ctx.setAppState(prev => ({
            ...prev,
            toolPermissionContext: {
              ...prev.toolPermissionContext,
              additionalWorkingDirectories: new Map(),
            },
          }))
        }
        return mutable.ctx.getAppState()
      },
    } as unknown as ToolUseContext
    const askWriteTool = createToolFixture(
      z.object({ file_path: z.string() }),
      {
        name: 'Write',
        getPath(input: { file_path: string }) {
          return input.file_path
        },
        async checkPermissions(input) {
          return {
            behavior: 'ask' as const,
            message: 'Write requires approval',
            updatedInput: input,
          }
        },
      },
    )
    hookPermissionResult = {
      behavior: 'allow',
      updatedInput: { file_path: join(addedDir, 'hooked.txt') },
    }
    try {
      const result = await hasPermissionsToUseTool(
        askWriteTool,
        { file_path: join(projectDir, 'inside.txt') },
        ctx,
        {} as Parameters<typeof hasPermissionsToUseTool>[3],
        'blockwrites-tail-live',
      )
      expect(result.behavior).toBe('deny')
      if (result.behavior === 'deny') {
        expect(result.message).toContain('blockWritesOutsideWorkingDirectories')
      }
      expect(rootCalls).toBeGreaterThan(0)
    } finally {
      hookPermissionResult = undefined
    }
  })

  test('an interactive hook allow is denied when a concurrent update removes its directory', async () => {
    blockWritesOutsideWorkingDirectories = true
    // The pre-check in runHooks sees addedDir as working; the removal lands
    // during handleHookAllow's awaited persistence and plan-mode
    // revalidation, so the live recheck before buildAllow must catch it.
    revalidationCallCount = 0
    removeDirDuringRevalidation = addedDir
    hookPermissionResult = {
      behavior: 'allow',
      updatedInput: { file_path: join(addedDir, 'hooked.txt') },
    }
    try {
      const mutable = useMutableContext(
        permissionContext(
          'default',
          new Map([[addedDir, { path: addedDir, source: 'session' }]]),
        ),
      )
      const permissionCtx = createPermissionContext(
        writeTool,
        { file_path: join(projectDir, 'inside.txt') },
        mutable.ctx,
        { message: { id: 'blockwrites-hook-live' } } as never,
        'blockwrites-hook-live',
        () => {},
      )
      const result = await permissionCtx.runHooks(undefined, undefined)
      expect(result?.behavior).toBe('deny')
      if (result?.behavior === 'deny') {
        expect(result.message).toContain('blockWritesOutsideWorkingDirectories')
      }
    } finally {
      removeDirDuringRevalidation = null
      hookPermissionResult = undefined
    }
  })

  test('a denied hook allow never commits its permission updates', async () => {
    blockWritesOutsideWorkingDirectories = true
    hookPermissionResult = {
      behavior: 'allow',
      updatedInput: { file_path: join(addedDir, 'hooked.txt') },
      updatedPermissions: [
        { type: 'setMode', mode: 'plan', destination: 'session' },
      ],
    }
    const mutable = useMutableContext(
      permissionContext(
        'default',
        new Map([[addedDir, { path: addedDir, source: 'session' }]]),
      ),
    )
    const modeDecisionSpy = spyOn(
      permissionSetupModule,
      'getPermissionModeChangeRequestDecision',
    ).mockImplementation(async () => {
      // The staged boundary check already passed; the covering directory
      // disappears during the awaited mode validation inside
      // preparePermissionUpdates. The final deny must not leave the setMode
      // update applied or persisted.
      mutable.ctx.setAppState(prev => ({
        ...prev,
        toolPermissionContext: {
          ...prev.toolPermissionContext,
          additionalWorkingDirectories: new Map(),
        },
      }))
      return { status: 'apply' } as const
    })
    const liveApplySpy = spyOn(
      permissionSetupModule,
      'applyPermissionUpdatesToLiveContext',
    )
    try {
      const permissionCtx = createPermissionContext(
        writeTool,
        { file_path: join(projectDir, 'inside.txt') },
        mutable.ctx,
        { message: { id: 'blockwrites-hook-commit' } } as never,
        'blockwrites-hook-commit',
        () => {},
      )
      const result = await permissionCtx.runHooks(undefined, undefined)
      expect(result?.behavior).toBe('deny')
      if (result?.behavior === 'deny') {
        expect(result.message).toContain('blockWritesOutsideWorkingDirectories')
      }
      expect(mutable.ctx.getAppState().toolPermissionContext.mode).toBe(
        'default',
      )
      expect(liveApplySpy).not.toHaveBeenCalled()
    } finally {
      modeDecisionSpy.mockRestore()
      liveApplySpy.mockRestore()
      hookPermissionResult = undefined
    }
  })

  test('a denied user allow never commits its permission updates', async () => {
    blockWritesOutsideWorkingDirectories = true
    const mutable = useMutableContext(
      permissionContext(
        'default',
        new Map([[addedDir, { path: addedDir, source: 'session' }]]),
      ),
    )
    const modeDecisionSpy = spyOn(
      permissionSetupModule,
      'getPermissionModeChangeRequestDecision',
    ).mockImplementation(async () => {
      mutable.ctx.setAppState(prev => ({
        ...prev,
        toolPermissionContext: {
          ...prev.toolPermissionContext,
          additionalWorkingDirectories: new Map(),
        },
      }))
      return { status: 'apply' } as const
    })
    const liveApplySpy = spyOn(
      permissionSetupModule,
      'applyPermissionUpdatesToLiveContext',
    )
    try {
      const permissionCtx = createPermissionContext(
        writeTool,
        { file_path: join(projectDir, 'inside.txt') },
        mutable.ctx,
        { message: { id: 'blockwrites-user-commit' } } as never,
        'blockwrites-user-commit',
        () => {},
      )
      const result = await permissionCtx.handleUserAllow(
        { file_path: join(addedDir, 'user-edited.txt') },
        [
          { type: 'setMode', mode: 'plan', destination: 'session' },
        ],
      )
      expect(result.behavior).toBe('deny')
      if (result.behavior === 'deny') {
        expect(result.message).toContain('blockWritesOutsideWorkingDirectories')
      }
      expect(mutable.ctx.getAppState().toolPermissionContext.mode).toBe(
        'default',
      )
      expect(liveApplySpy).not.toHaveBeenCalled()
    } finally {
      modeDecisionSpy.mockRestore()
      liveApplySpy.mockRestore()
    }
  })

  test('an allow whose updates add the covering directory is not denied', async () => {
    blockWritesOutsideWorkingDirectories = true
    // The write targets a directory that only exists in the updates. The
    // pre-commit boundary check must evaluate the live context merged
    // with the prepared updates, or this allow is denied fail-closed.
    const mutable = useMutableContext(permissionContext('default'))
    try {
      const permissionCtx = createPermissionContext(
        writeTool,
        { file_path: join(projectDir, 'inside.txt') },
        mutable.ctx,
        { message: { id: 'blockwrites-adddir-allow' } } as never,
        'blockwrites-adddir-allow',
        mutable.setPermissionContext,
      )
      const result = await permissionCtx.handleUserAllow(
        { file_path: join(addedDir, 'newdir-write.txt') },
        [
          {
            type: 'addDirectories',
            directories: [addedDir],
            destination: 'session',
          },
        ],
      )
      expect(result.behavior).toBe('allow')
      expect(
        mutable.ctx
          .getAppState()
          .toolPermissionContext.additionalWorkingDirectories.has(
            addedDir,
          ),
      ).toBe(true)
    } finally {
    }
  })

  test('removal during post-commit revalidation still denies, updates stand', async () => {
    blockWritesOutsideWorkingDirectories = true
    // The covering directory is removed during the awaited plan-mode
    // revalidation, which runs after the commit by design (a setMode
    // update must be live for that check). The boundary deny still
    // fires; the committed updates stand, matching the mode-transition
    // semantics the headlessPlanHooks suite documents.
    revalidationCallCount = 0
    removeDirDuringRevalidation = { dir: addedDir, onCall: 2 }
    const mutable = useMutableContext(
      permissionContext(
        'default',
        new Map([[addedDir, { path: addedDir, source: 'session' }]]),
      ),
    )
    try {
      const permissionCtx = createPermissionContext(
        writeTool,
        { file_path: join(projectDir, 'inside.txt') },
        mutable.ctx,
        { message: { id: 'blockwrites-postcommit-deny' } } as never,
        'blockwrites-postcommit-deny',
        mutable.setPermissionContext,
      )
      const result = await permissionCtx.handleUserAllow(
        { file_path: join(addedDir, 'postcommit.txt') },
        [
          {
            type: 'addDirectories',
            directories: [join(projectDir, 'extra')],
            destination: 'session',
          },
        ],
      )
      expect(result.behavior).toBe('deny')
      if (result.behavior === 'deny') {
        expect(result.message).toContain('blockWritesOutsideWorkingDirectories')
      }
      expect(
        mutable.ctx
          .getAppState()
          .toolPermissionContext.additionalWorkingDirectories.has(
            join(projectDir, 'extra'),
          ),
      ).toBe(true)
    } finally {
      removeDirDuringRevalidation = null
    }
  })

  test('PermissionRequest hooks answer before the external permission_request prompt', async () => {
    hookPermissionResult = {
      behavior: 'allow',
      updatedInput: { file_path: join(projectDir, 'inside.txt') },
    }
    let emitted = false
    let registered = false
    try {
      const canUseTool = createExternalCanUseTool(
        undefined,
        async () => ({
          behavior: 'deny' as const,
          message: 'fallback unreached',
          decisionReason: { type: 'other' as const, reason: 'unreached' },
        }),
        {
          registerPendingPermission: async () => {
            registered = true
            return undefined as never
          },
          deletePendingPermission: () => {},
        } as never,
        () => {
          emitted = true
        },
      )
      const result = await canUseTool(
        writeTool,
        { file_path: join(projectDir, 'inside.txt') },
        useContext(permissionContext('default')),
        {} as never,
        'blockwrites-external-hook',
      )
      // The hook decided: no permission_request emission, no pending entry.
      expect(emitted).toBe(false)
      expect(registered).toBe(false)
      expect(result.behavior).toBe('allow')
    } finally {
      hookPermissionResult = undefined
    }
  })

  test('a forced ask is suppressed without an SDK prompt', async () => {
    denyInsteadOfPrompting = true
    try {
      const io = new StructuredIO((async function* () {})())
      let prompted = false
      const canUseTool = io.createCanUseTool(() => {
        prompted = true
      })
      const result = await canUseTool(
        writeTool,
        { file_path: join(projectDir, 'inside.txt') },
        useContext(permissionContext('default')),
        {} as never,
        'blockwrites-forced-ask',
        { behavior: 'ask' as const } as never,
      )
      expect(prompted).toBe(false)
      expect(result.behavior).toBe('deny')
      if (result.behavior === 'deny') {
        expect(result.message).toContain('denyInsteadOfPrompting')
      }
    } finally {
      denyInsteadOfPrompting = false
    }
  })

  test('a forced ask still reaches the SDK prompt when prompts are allowed', async () => {
    const queued: string[] = []
    let wake: (() => void) | undefined
    const input = (async function* () {
      for (;;) {
        while (queued.length === 0) {
          await new Promise<void>(resolve => {
            wake = resolve
          })
        }
        wake = undefined
        yield queued.shift()!
      }
    })()
    const io = new StructuredIO(input)
    // Drive structuredInput so control_response routing resolves the
    // pending can_use_tool request.
    void (async () => {
      for await (const _ of io.structuredInput) {
        // drain
      }
    })()
    let requestId: string | undefined
    const canUseTool = io.createCanUseTool(details => {
      requestId = details.request_id
    })
    const pending = canUseTool(
      writeTool,
      { file_path: join(projectDir, 'inside.txt') },
      useContext(permissionContext('default')),
      {} as never,
      'blockwrites-forced-ask-prompt',
      { behavior: 'ask' as const } as never,
    )
    while (requestId === undefined) {
      await new Promise(resolve => setImmediate(resolve))
    }
    queued.push(
      JSON.stringify({
        type: 'control_response',
        response: {
          request_id: requestId,
          subtype: 'success',
          response: {
            behavior: 'allow',
            updatedInput: { file_path: join(projectDir, 'inside.txt') },
          },
        },
      }) + '\n',
    )
    wake?.()
    const result = await pending
    expect(result.behavior).toBe('allow')
  })

  test('denyInsteadOfPrompting suppresses the external permission_request path', async () => {
    denyInsteadOfPrompting = true
    try {
      let emitted = false
      let registered = false
      const canUseTool = createExternalCanUseTool(
        undefined,
        async () => ({
          behavior: 'deny' as const,
          message: 'fallback unreached',
          decisionReason: { type: 'other' as const, reason: 'unreached' },
        }),
        {
          registerPendingPermission: async () => {
            registered = true
            return undefined as never
          },
          deletePendingPermission: () => {},
        } as never,
        () => {
          emitted = true
        },
      )
      const result = await canUseTool(
        writeTool,
        { file_path: join(projectDir, 'inside.txt') },
        useContext(permissionContext('default')),
        {} as never,
        'blockwrites-external-suppression',
      )
      expect(emitted).toBe(false)
      expect(registered).toBe(false)
      expect(result.behavior).toBe('deny')
      if (result.behavior === 'deny') {
        expect(result.message).toContain('denyInsteadOfPrompting')
      }
    } finally {
      denyInsteadOfPrompting = false
    }
  })

  test('the suppression denial stands when no hook decides', async () => {
    denyInsteadOfPrompting = true
    try {
      const askWriteTool = createToolFixture(
        z.object({ file_path: z.string() }),
        {
          name: 'Write',
          getPath(input: { file_path: string }) {
            return input.file_path
          },
          async checkPermissions(input) {
            return {
              behavior: 'ask' as const,
              message: 'Write requires approval',
              updatedInput: input,
            }
          },
        },
      )
      const io = new StructuredIO((async function* () {})())
      const canUseTool = io.createCanUseTool()
      const result = await canUseTool(
        askWriteTool,
        { file_path: join(projectDir, 'inside.txt') },
        useContext(permissionContext('default')),
        {} as never,
        'blockwrites-suppression-nohook',
      )
      expect(result.behavior).toBe('deny')
      if (result.behavior === 'deny') {
        expect(result.message).toContain('denyInsteadOfPrompting')
      }
    } finally {
      denyInsteadOfPrompting = false
    }
  })

  describe('SDK forceDecision ask under denyInsteadOfPrompting', () => {
    const forcedAsk = () => ({
      behavior: 'ask' as const,
      message: 'Write requires approval',
      updatedInput: { file_path: join(projectDir, 'inside.txt') },
    })
    const externalFactory = (onPermissionRequest?: () => void) =>
      createExternalCanUseTool(
        undefined,
        async () => ({
          behavior: 'deny' as const,
          message: 'fallback unreached',
          decisionReason: { type: 'other' as const, reason: 'unreached' },
        }),
        {
          registerPendingPermission: async () => undefined as never,
          deletePendingPermission: () => {},
        } as never,
        onPermissionRequest,
      )

    test('external factory converts a forced ask to the suppression denial', async () => {
      denyInsteadOfPrompting = true
      try {
        const result = await externalFactory()(
          writeTool,
          { file_path: join(projectDir, 'inside.txt') },
          useContext(permissionContext('default')),
          {} as never,
          'forced-ask-external',
          forcedAsk(),
        )
        expect(result.behavior).toBe('deny')
        if (result.behavior === 'deny') {
          expect(result.message).toContain('denyInsteadOfPrompting')
        }
      } finally {
        denyInsteadOfPrompting = false
      }
    })

    test('external factory lets a PermissionRequest hook answer the suppressed forced ask', async () => {
      denyInsteadOfPrompting = true
      hookPermissionResult = { behavior: 'allow' }
      try {
        const result = await externalFactory(() => {})(
          writeTool,
          { file_path: join(projectDir, 'inside.txt') },
          useContext(permissionContext('default')),
          {} as never,
          'forced-ask-external-hook',
          forcedAsk(),
        )
        expect(result.behavior).toBe('allow')
      } finally {
        hookPermissionResult = undefined
        denyInsteadOfPrompting = false
      }
    })

    test('external factory still returns the forced ask when the setting is off', async () => {
      const result = await externalFactory()(
        writeTool,
        { file_path: join(projectDir, 'inside.txt') },
        useContext(permissionContext('default')),
        {} as never,
        'forced-ask-external-off',
        forcedAsk(),
      )
      expect(result.behavior).toBe('ask')
    })

    test('external factory leaves a forced allow and a forced deny untouched', async () => {
      denyInsteadOfPrompting = true
      try {
        const allow = await externalFactory()(
          writeTool,
          { file_path: join(projectDir, 'inside.txt') },
          useContext(permissionContext('default')),
          {} as never,
          'forced-allow-external',
          { behavior: 'allow', updatedInput: { file_path: join(projectDir, 'inside.txt') } },
        )
        expect(allow.behavior).toBe('allow')
        const deny = await externalFactory()(
          writeTool,
          { file_path: join(projectDir, 'inside.txt') },
          useContext(permissionContext('default')),
          {} as never,
          'forced-deny-external',
          {
            behavior: 'deny',
            message: 'forced deny',
            decisionReason: { type: 'other', reason: 'forced' },
          },
        )
        expect(deny.behavior).toBe('deny')
        if (deny.behavior === 'deny') {
          expect(deny.message).toBe('forced deny')
        }
      } finally {
        denyInsteadOfPrompting = false
      }
    })

    test('default factory converts a forced ask to the suppression denial', async () => {
      denyInsteadOfPrompting = true
      try {
        const result = await createDefaultCanUseTool(
          permissionContext('default'),
        )(
          writeTool,
          { file_path: join(projectDir, 'inside.txt') },
          useContext(permissionContext('default')),
          {} as never,
          'forced-ask-default',
          forcedAsk(),
        )
        expect(result.behavior).toBe('deny')
        if (result.behavior === 'deny') {
          expect(result.message).toContain('denyInsteadOfPrompting')
        }
      } finally {
        denyInsteadOfPrompting = false
      }
    })

    test('default factory still returns the forced ask when the setting is off', async () => {
      const result = await createDefaultCanUseTool(permissionContext('default'))(
        writeTool,
        { file_path: join(projectDir, 'inside.txt') },
        useContext(permissionContext('default')),
        {} as never,
        'forced-ask-default-off',
        forcedAsk(),
      )
      expect(result.behavior).toBe('ask')
    })
  })

  test('a symlink inside project agent-memory cannot escape the boundary', async () => {
    if (process.platform === 'win32') {
      return
    }
    blockWritesOutsideWorkingDirectories = true
    const previousCwdState = getCwdState()
    setCwdState(projectDir)
    try {
      const memoryDir = join(projectDir, '.openclaude', 'agent-memory')
      await mkdir(memoryDir, { recursive: true })
      const linkPath = join(memoryDir, 'redirect')
      await rm(linkPath, { force: true, recursive: true })
      await symlink(outsideDir, linkPath)
      const result = checkWritePermissionForTool(
        writeTool,
        { file_path: join(linkPath, 'out.txt') },
        permissionContext('bypassPermissions'),
      )
      if (result.behavior !== 'deny') {
        throw new Error(`expected deny, got ${result.behavior}`)
      }
      expect(result.message).toContain('blockWritesOutsideWorkingDirectories')
    } finally {
      setCwdState(previousCwdState)
    }
  })

  test('a normal project agent-memory write stays allowed', async () => {
    blockWritesOutsideWorkingDirectories = true
    const previousCwdState = getCwdState()
    setCwdState(projectDir)
    try {
      const memoryDir = join(projectDir, '.openclaude', 'agent-memory')
      await mkdir(memoryDir, { recursive: true })
      const result = checkWritePermissionForTool(
        writeTool,
        { file_path: join(memoryDir, 'subdir', 'note.md') },
        permissionContext('bypassPermissions'),
      )
      expect(result.behavior).toBe('allow')
    } finally {
      setCwdState(previousCwdState)
    }
  })

  test('a symlink inside the scratchpad cannot escape the boundary', async () => {
    if (process.platform === 'win32') {
      return
    }
    blockWritesOutsideWorkingDirectories = true
    scratchpadGateEnabled = true
    try {
      const scratchpadDir = getScratchpadDir()
      await mkdir(scratchpadDir, { recursive: true })
      const linkPath = join(scratchpadDir, 'redirect')
      await rm(linkPath, { force: true, recursive: true })
      await symlink(outsideDir, linkPath)
      const result = checkWritePermissionForTool(
        writeTool,
        { file_path: join(linkPath, 'out.txt') },
        permissionContext('bypassPermissions'),
      )
      if (result.behavior !== 'deny') {
        throw new Error(`expected deny, got ${result.behavior}`)
      }
      expect(result.message).toContain('blockWritesOutsideWorkingDirectories')
    } finally {
      scratchpadGateEnabled = false
    }
  })

  test('a redirected scratchpad write keeps its legacy exception with the boundary off', async () => {
    if (process.platform === 'win32') return
    blockWritesOutsideWorkingDirectories = false
    scratchpadGateEnabled = true
    const scratchpadDir = getScratchpadDir()
    const linkPath = join(scratchpadDir, 'legacy-scratchpad-redirect')
    try {
      await mkdir(scratchpadDir, { recursive: true })
      await symlink(outsideDir, linkPath)
      expect(checkWritePermissionForTool(
        writeTool, { file_path: join(linkPath, 'note.txt') }, permissionContext('default'),
      )).toMatchObject({ behavior: 'allow' })
    } finally {
      await rm(linkPath, { force: true })
      scratchpadGateEnabled = false
    }
  })

  test('redirected auto-memory writes keep explicit approval within the working directories', async () => {
    if (process.platform === 'win32') return
    const savedOverride = process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
    const memoryDir = join(projectDir, 'persistent-memory')
    const insideTarget = join(projectDir, 'memory-target')
    try {
      process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = memoryDir
      getAutoMemPath.cache.clear?.()
      setGovernancePolicySettingsForSourceForTesting(() => ({
        memory: { requireApprovalBeforeWrite: true },
      }))
      await mkdir(memoryDir)
      await mkdir(insideTarget)
      await symlink(insideTarget, join(memoryDir, 'inside'))
      await symlink(outsideDir, join(memoryDir, 'outside'))
      const ctx = permissionContext('acceptEdits')
      const insideInput = { file_path: join(memoryDir, 'inside', 'note.md') }
      const outsideInput = { file_path: join(memoryDir, 'outside', 'note.md') }
      for (const enabled of [false, true]) {
        blockWritesOutsideWorkingDirectories = enabled
        expect(checkWritePermissionForTool(writeTool, insideInput, ctx)).toMatchObject({
          behavior: 'ask',
          decisionReason: { type: 'safetyCheck', classifierApprovable: false },
        })
      }
      expect(checkWritePermissionForTool(writeTool, outsideInput, ctx)).toMatchObject({
        behavior: 'deny',
        decisionReason: {
          reason: 'permissions.blockWritesOutsideWorkingDirectories is enabled',
        },
      })
      expect(checkWriteBoundaryForAskRule(writeTool, outsideInput, ctx)).toMatchObject({
        behavior: 'deny',
      })
    } finally {
      if (savedOverride === undefined) delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
      else process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = savedOverride
      getAutoMemPath.cache.clear?.()
      setGovernancePolicySettingsForSourceForTesting(null)
    }
  })

  test('an environment memory override needs a working directory grant even after approval', async () => {
    const savedOverride = process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
    const savedBoundary = blockWritesOutsideWorkingDirectories
    const memoryDir = outsideDir
    const context = permissionContext('acceptEdits')
    const input = { file_path: join(memoryDir, 'note.md') }
    const check = (permissions: ToolPermissionContext) =>
      checkWritePermissionForTool(writeTool, input, permissions)
    const approve = (permissions: ToolPermissionContext) =>
      permissionPromptToolResultToPermissionDecision(
        { behavior: 'allow', updatedInput: input },
        writeTool,
        { file_path: join(projectDir, 'note.md') },
        useContext(permissions),
      )

    try {
      process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = memoryDir
      getAutoMemPath.cache.clear?.()
      setGovernancePolicySettingsForSourceForTesting(() => ({
        memory: { requireApprovalBeforeWrite: true },
      }))
      const ask = {
        behavior: 'ask',
        decisionReason: { type: 'safetyCheck', classifierApprovable: false },
      }

      blockWritesOutsideWorkingDirectories = false
      expect(check(context)).toMatchObject(ask)
      expect(await approve(context)).toMatchObject({ behavior: 'allow' })

      blockWritesOutsideWorkingDirectories = true
      const deny = {
        behavior: 'deny',
        decisionReason: {
          reason: 'permissions.blockWritesOutsideWorkingDirectories is enabled',
        },
      }
      expect([check(context), await approve(context)]).toMatchObject([deny, deny])

      const granted = permissionContext(
        'acceptEdits',
        new Map([[memoryDir, { path: memoryDir, source: 'session' }]]),
      )
      expect(check(granted)).toMatchObject(ask)
      expect(await approve(granted)).toMatchObject({ behavior: 'allow' })
    } finally {
      if (savedOverride === undefined) delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
      else process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = savedOverride
      blockWritesOutsideWorkingDirectories = savedBoundary
      getAutoMemPath.cache.clear?.()
      setGovernancePolicySettingsForSourceForTesting(null)
    }
  })

  test('a normal scratchpad write stays allowed', async () => {
    blockWritesOutsideWorkingDirectories = true
    scratchpadGateEnabled = true
    try {
      const scratchpadDir = getScratchpadDir()
      await mkdir(scratchpadDir, { recursive: true })
      const result = checkWritePermissionForTool(
        writeTool,
        { file_path: join(scratchpadDir, 'note.txt') },
        permissionContext('bypassPermissions'),
      )
      expect(result.behavior).toBe('allow')
    } finally {
      scratchpadGateEnabled = false
    }
  })
})
