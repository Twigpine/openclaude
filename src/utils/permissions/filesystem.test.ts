import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { z } from 'zod/v4'
import type { ToolPermissionContext } from '../../types/permissions.js'
import {
  getOriginalCwd,
  getCwdState,
  getProjectRoot,
  setCwdState,
  setOriginalCwd,
  setProjectRoot,
} from '../../bootstrap/state.js'
import { getAutoMemPath } from '../../memdir/paths.js'
import { createToolFixture } from '../../test/toolFixtures.js'
import {
  checkWritePermissionForTool,
  getResolvedWorkingDirPaths,
} from './filesystem.js'
import { resetSafetyLevelCache } from './safetyLevel.js'
import { resetSafetyLevelForTest } from '../../test/safetyLevelTestHelpers.js'

const writeInputSchema = z.object({
  file_path: z.string(),
})

describe('auto-memory write permissions', () => {
  let originalProjectRoot: string
  let originalMemoryPathOverride: string | undefined
  let projectDir: string

  beforeEach(async () => {
    originalProjectRoot = getProjectRoot()
    originalMemoryPathOverride = process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
    delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
    getAutoMemPath.cache.clear?.()
    projectDir = await mkdtemp(join(tmpdir(), 'openclaude-memory-perms-'))
    setProjectRoot(projectDir)
  })

  afterEach(async () => {
    setProjectRoot(originalProjectRoot)
    if (originalMemoryPathOverride === undefined) {
      delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
    } else {
      process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE =
        originalMemoryPathOverride
    }
    getAutoMemPath.cache.clear?.()
    await rm(projectDir, { recursive: true, force: true })
  })

  test('requires approval for default auto-memory writes', () => {
    const result = checkWritePermissionForTool(
      writeTool,
      { file_path: join(getAutoMemPath(), 'user_role.md') },
      permissionContext('bypassPermissions'),
    )

    expect(result.behavior).toBe('ask')
    expect(result.decisionReason).toMatchObject({
      type: 'safetyCheck',
      reason: 'Persistent memory writes require explicit approval',
    })
  })

  test('requires approval for overridden auto-memory writes', async () => {
    const overrideDir = await mkdtemp(join(tmpdir(), 'openclaude-memory-'))
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = overrideDir
    getAutoMemPath.cache.clear?.()

    try {
      const result = checkWritePermissionForTool(
        writeTool,
        { file_path: join(getAutoMemPath(), 'user_role.md') },
        permissionContext('bypassPermissions'),
      )

      expect(result.behavior).toBe('ask')
      expect(result.decisionReason).toMatchObject({
        type: 'safetyCheck',
        reason: 'Persistent memory writes require explicit approval',
      })
    } finally {
      await rm(overrideDir, { recursive: true, force: true })
    }
  })
})

const writeTool = createToolFixture(writeInputSchema, {
  name: 'Write',
  getPath(input: { file_path: string }) {
    return input.file_path
  },
})

function permissionContext(mode: ToolPermissionContext['mode']) {
  return {
    mode,
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable:
      mode === 'bypassPermissions' || mode === 'fullAccess',
  } satisfies ToolPermissionContext
}

describe('OpenClaude commit message temp file permissions', () => {
  let originalCwd: string
  let projectDir: string

  beforeEach(async () => {
    originalCwd = getOriginalCwd()
    projectDir = await mkdtemp(join(tmpdir(), 'openclaude-perms-'))
    await mkdir(join(projectDir, '.git'))
    setOriginalCwd(projectDir)
  })

  afterEach(async () => {
    setOriginalCwd(originalCwd)
    resetSafetyLevelForTest()
    await rm(projectDir, { recursive: true, force: true })
  })

  test('allows the project-local OPENCLAUDE_COMMIT_MSG file without a safety prompt', () => {
    const result = checkWritePermissionForTool(
      writeTool,
      { file_path: join(projectDir, '.git', 'OPENCLAUDE_COMMIT_MSG') },
      permissionContext('bypassPermissions'),
    )

    expect(result.behavior).toBe('allow')
    expect(result.decisionReason).toMatchObject({
      type: 'other',
      reason: 'OpenClaude commit message file is allowed for writing',
    })
  })

  test('allows the project-local OPENCLAUDE_COMMIT_MSG file in fullAccess mode', () => {
    const result = checkWritePermissionForTool(
      writeTool,
      { file_path: join(projectDir, '.git', 'OPENCLAUDE_COMMIT_MSG') },
      permissionContext('fullAccess'),
    )

    expect(result.behavior).toBe('allow')
    expect(result.decisionReason).toMatchObject({
      type: 'other',
      reason: 'OpenClaude commit message file is allowed for writing',
    })
  })

  test('preserves case-insensitive matching for the commit message exception', () => {
    const result = checkWritePermissionForTool(
      writeTool,
      { file_path: join(projectDir, '.git', 'openclaude_commit_msg') },
      permissionContext('bypassPermissions'),
    )

    expect(result.behavior).toBe('allow')
    expect(result.decisionReason).toMatchObject({
      type: 'other',
      reason: 'OpenClaude commit message file is allowed for writing',
    })
  })

  test('still prompts for the commit message file in default mode', () => {
    const result = checkWritePermissionForTool(
      writeTool,
      { file_path: join(projectDir, '.git', 'OPENCLAUDE_COMMIT_MSG') },
      permissionContext('default'),
    )

    expect(result.behavior).toBe('ask')
    expect(result.decisionReason).toMatchObject({ type: 'safetyCheck' })
  })

  test('continues to block other .git files with a safety prompt', () => {
    const result = checkWritePermissionForTool(
      writeTool,
      { file_path: join(projectDir, '.git', 'config') },
      permissionContext('bypassPermissions'),
    )

    expect(result.behavior).toBe('ask')
    expect(result.decisionReason).toMatchObject({ type: 'safetyCheck' })
  })

  test('does not allow same-named files outside the project git directory', () => {
    const otherDir = join(projectDir, 'other')
    const result = checkWritePermissionForTool(
      writeTool,
      { file_path: join(otherDir, '.git', 'OPENCLAUDE_COMMIT_MSG') },
      permissionContext('bypassPermissions'),
    )

    expect(result.behavior).not.toBe('allow')
  })

  test.each([
    '.gitmodules',
    '.bashrc',
    '.zshrc',
    '.profile',
    '.mcp.json',
    '.claude.json',
    '.openclaude.json',
  ])('permits dangerous-file-list edit for %s in permissive safety mode', fileName => {
    process.env.OPENCLAUDE_SAFETY_LEVEL = 'permissive'
    resetSafetyLevelCache()

    const result = checkWritePermissionForTool(
      writeTool,
      { file_path: join(projectDir, fileName) },
      {
        ...permissionContext('acceptEdits'),
        additionalWorkingDirectories: new Map([
          [projectDir, { path: projectDir, source: 'session' }],
        ]),
      },
    )

    expect(result.behavior).toBe('allow')
  })

  test('still prompts for dangerous directories in permissive safety mode', () => {
    process.env.OPENCLAUDE_SAFETY_LEVEL = 'permissive'
    resetSafetyLevelCache()

    const result = checkWritePermissionForTool(
      writeTool,
      { file_path: join(projectDir, '.git', 'config') },
      {
        ...permissionContext('acceptEdits'),
        additionalWorkingDirectories: new Map([
          [projectDir, { path: projectDir, source: 'session' }],
        ]),
      },
    )

    expect(result.behavior).toBe('ask')
    expect(result.decisionReason).toMatchObject({ type: 'safetyCheck' })
  })
})

describe('nested Git worktree write permissions', () => {
  test('allows relative writes in acceptEdits mode when the session uses a nested worktree', async () => {
    const originalCwd = getOriginalCwd()
    const originalCwdState = getCwdState()
    const repository = await mkdtemp(join(tmpdir(), 'openclaude-worktree-perms-'))
    const worktree = join(repository, 'a', 'b', 'worktrees', 'feature-branch')

    try {
      execFileSync('git', ['init', repository])
      execFileSync('git', ['-C', repository, 'config', 'user.email', 'test@example.com'])
      execFileSync('git', ['-C', repository, 'config', 'user.name', 'OpenClaude Test'])
      await writeFile(join(repository, 'seed.txt'), 'seed\n')
      execFileSync('git', ['-C', repository, 'add', 'seed.txt'])
      execFileSync('git', ['-C', repository, 'commit', '-m', 'seed'])
      await mkdir(join(repository, 'a', 'b', 'worktrees'), { recursive: true })
      execFileSync('git', [
        '-C',
        repository,
        'worktree',
        'add',
        '-b',
        'feature-branch',
        worktree,
      ])

      // Scoped sessions update application CWD state without changing the
      // shared process CWD. Relative tool paths must still target this worktree.
      setOriginalCwd(worktree)
      setCwdState(worktree)
      getResolvedWorkingDirPaths.cache.clear?.()

      const result = checkWritePermissionForTool(
        writeTool,
        { file_path: 'src/new-file.ts' },
        permissionContext('acceptEdits'),
      )

      expect(result.behavior).toBe('allow')
    } finally {
      setOriginalCwd(originalCwd)
      setCwdState(originalCwdState)
      getResolvedWorkingDirPaths.cache.clear?.()
      await rm(repository, { recursive: true, force: true })
    }
  })
})

describe('SDK-context project roots', () => {
  test('session rules and projectRoot resolve per SDK context', async () => {
    const { runWithSdkContext } = await import('../../bootstrap/state.js')
    const { getFileReadIgnorePatterns } = await import('./filesystem.js')
    const { applyPermissionUpdate } = await import(
      './PermissionUpdate.js'
    )
    const { getEmptyToolPermissionContext } = await import('../../Tool.js')
    const rootA = await mkdtemp(join(tmpdir(), 'oc-sdk-root-a-'))
    const rootB = await mkdtemp(join(tmpdir(), 'oc-sdk-root-b-'))
    try {
      for (const [root, name] of [
        [rootA, 'a'],
        [rootB, 'b'],
      ] as const) {
        const keys = await runWithSdkContext(
          {
            sessionId: `sdk-root-${name}` as import('../../types/ids.js').SessionId,
            sessionProjectDir: null,
            cwd: root,
            originalCwd: root,
            projectRoot: root,
          },
          () => {
            const ctx = applyPermissionUpdate(
              getEmptyToolPermissionContext(),
              {
                type: 'addRules',
                behavior: 'deny',
                rules: [{ toolName: 'Read', ruleContent: '/secret.txt' }],
                destination: 'session',
              },
            )
            return [...getFileReadIgnorePatterns(ctx).keys()]
          },
        )
        // The deny rule's root resolves against this context's project
        // root, not the process-global STATE.projectRoot.
        expect(keys).toContain(root)
      }
    } finally {
      await rm(rootA, { recursive: true, force: true })
      await rm(rootB, { recursive: true, force: true })
    }
  })
})
