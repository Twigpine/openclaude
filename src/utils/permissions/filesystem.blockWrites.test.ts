import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { z } from 'zod/v4'
import {
  getOriginalCwd,
  setOriginalCwd,
} from '../../bootstrap/state.js'
import { createToolFixture } from '../../test/toolFixtures.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import type { SettingsJson } from '../settings/types.js'

const realSettings = await import(
  `../settings/settings.js?blockWritesActual=${Date.now()}-${Math.random()}`
)
let blockWritesOutsideWorkingDirectories = false
mock.module('../settings/settings.js', () => ({
  ...realSettings,
  getInitialSettings: (): SettingsJson => ({
    permissions: { blockWritesOutsideWorkingDirectories },
  }),
}))

const { checkWritePermissionForTool } = await import('./filesystem.js')
const { hasPermissionsToUseTool, checkRuleBasedPermissions } = await import(
  './permissions.js'
)

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
      setOriginalCwd(originalCwd)
      mock.restore()
      mock.module('../settings/settings.js', () => realSettings)
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
})
