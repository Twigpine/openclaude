import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
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
import type { ToolPermissionContext } from '../../types/permissions.js'
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
): ToolPermissionContext {
  return {
    mode,
    additionalWorkingDirectories,
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable:
      mode === 'bypassPermissions' || mode === 'fullAccess',
  } satisfies ToolPermissionContext
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
})
