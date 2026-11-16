import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import {
  getAdditionalDirectoriesForClaudeMd,
  getCwdState,
  getOriginalCwd,
  getProjectRoot,
  setAdditionalDirectoriesForClaudeMd,
  setCwdState,
  setOriginalCwd,
  setProjectRoot,
} from '../../bootstrap/state.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { LocalJSXCommandContext } from '../../types/command.js'
import { getCwd } from '../../utils/cwd.js'
import {
  allWorkingDirectories,
  getFileReadIgnorePatterns,
} from '../../utils/permissions/filesystem.js'
import { applyPermissionUpdate } from '../../utils/permissions/PermissionUpdate.js'
import { getSettingsRootPathForSource } from '../../utils/settings/settings.js'
import { getTranscriptPath } from '../../utils/sessionStorage.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { call } from './cd.js'

describe('/cd', () => {
  let sandbox: string
  let savedCwdState: string
  let savedOriginalCwd: string
  let savedProjectRoot: string
  let savedAdditionalDirs: string[]
  let savedProcessCwd: string
  let latestPermissionContext: ReturnType<
    typeof getEmptyToolPermissionContext
  >

  const context = (): LocalJSXCommandContext =>
    ({
      getAppState: () => ({ toolPermissionContext: latestPermissionContext }),
      setAppState: (updater: (prev: unknown) => unknown) => {
        latestPermissionContext = (
          updater({ toolPermissionContext: latestPermissionContext }) as {
            toolPermissionContext: typeof latestPermissionContext
          }
        ).toolPermissionContext
      },
    }) as unknown as LocalJSXCommandContext

  beforeEach(async () => {
    await acquireSharedMutationLock('commands/cd.test.ts')
    sandbox = mkdtempSync(join(tmpdir(), 'oc-cd-test-'))
    savedProcessCwd = process.cwd()
    savedCwdState = getCwdState()
    savedOriginalCwd = getOriginalCwd()
    savedProjectRoot = getProjectRoot()
    savedAdditionalDirs = getAdditionalDirectoriesForClaudeMd()
    latestPermissionContext = getEmptyToolPermissionContext()
    process.chdir(sandbox)
    setCwdState(sandbox)
    setOriginalCwd(sandbox)
    setProjectRoot(sandbox)
  })

  afterEach(() => {
    try {
      process.chdir(savedProcessCwd)
      setCwdState(savedCwdState)
      setOriginalCwd(savedOriginalCwd)
      setProjectRoot(savedProjectRoot)
      setAdditionalDirectoriesForClaudeMd(savedAdditionalDirs)
      rmSync(sandbox, { recursive: true, force: true })
    } finally {
      releaseSharedMutationLock()
    }
  })

  it('reports the current working directory with no args', async () => {
    const result = await call('', context())
    expect(result).toEqual({
      type: 'text',
      value: `Current working directory: ${sandbox}`,
    })
  })

  it('switches into a subdirectory and keeps the previous root authorized', async () => {
    const sub = join(sandbox, 'sub')
    mkdirSync(sub)
    const result = await call('sub', context())
    expect(result.type).toBe('text')
    if (result.type === 'text') expect(result.value).toContain(sub)
    expect(getCwd()).toBe(sub)
    expect(process.cwd()).toBe(sub)
    // The working root retargets; the project root does not.
    expect(getOriginalCwd()).toBe(sub)
    expect(getProjectRoot()).toBe(sandbox)
    // The sandbox reads this list for allowWrite, so the retained previous
    // root must be mirrored into it (the subdirectory is covered by that
    // root, so it does not need its own entry).
    expect(getAdditionalDirectoriesForClaudeMd()).toEqual([sandbox])
    const workingDirs = allWorkingDirectories(latestPermissionContext)
    expect(workingDirs).toContain(sub)
    expect(workingDirs).toContain(sandbox)
  })

  it('grants exactly the new directory and the previous root after switching', async () => {
    const sub = join(sandbox, 'sub')
    mkdirSync(sub)
    const result = await call('sub', context())
    expect(result.type).toBe('text')
    // The session permission set is exactly the new root plus the root the
    // move left behind; nothing else is added or removed.
    expect([...allWorkingDirectories(latestPermissionContext)].sort()).toEqual(
      [sandbox, sub].sort(),
    )
  })

  it('adds an outside directory to the working set, then switches', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'oc-cd-outside-'))
    try {
      const result = await call(outside, context())
      expect(result.type).toBe('text')
      if (result.type === 'text') {
        expect(result.value).toContain(resolve(outside))
      }
      expect(getCwd()).toBe(resolve(outside))
      expect(getAdditionalDirectoriesForClaudeMd()).toContain(resolve(outside))
      const workingDirs = allWorkingDirectories(latestPermissionContext)
      expect(workingDirs).toContain(resolve(outside))
      expect(workingDirs).toContain(sandbox)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('keeps session rules and the transcript bound to the project root', async () => {
    const sub = join(sandbox, 'sub')
    mkdirSync(sub)
    const ctx = context()

    // A session-sourced deny rule written before the move, and the path the
    // materialized transcript already lives at, are session records: they
    // must not retarget when the working root changes.
    ctx.setAppState(prev => ({
      ...prev,
      toolPermissionContext: applyPermissionUpdate(prev.toolPermissionContext, {
        type: 'addRules',
        behavior: 'deny',
        rules: [{ toolName: 'Read', ruleContent: '/secret.txt' }],
        destination: 'session',
      }),
    }))
    const denyBefore = getFileReadIgnorePatterns(latestPermissionContext)
    expect(denyBefore.size).toBeGreaterThan(0)
    const transcriptBefore = getTranscriptPath()

    const result = await call('sub', ctx)
    expect(result.type).toBe('text')

    expect(getFileReadIgnorePatterns(latestPermissionContext)).toEqual(
      denyBefore,
    )
    expect(getTranscriptPath()).toBe(transcriptBefore)
    // The working root still moves; only the bound records stay anchored.
    expect(getOriginalCwd()).toBe(sub)
    expect(getProjectRoot()).toBe(sandbox)
  })

  it('keeps settings-sourced deny rules bound to the project root', async () => {
    const sub = join(sandbox, 'sub')
    mkdirSync(sub)
    const ctx = context()

    // Rules loaded from .openclaude/settings.json carry the projectSettings
    // source; their root must stay at the session's project directory when
    // the working root moves, or the deny silently retargets.
    ctx.setAppState(prev => ({
      ...prev,
      toolPermissionContext: applyPermissionUpdate(prev.toolPermissionContext, {
        type: 'addRules',
        behavior: 'deny',
        rules: [{ toolName: 'Read', ruleContent: '/secret.txt' }],
        destination: 'projectSettings',
      }),
    }))
    const denyBefore = getFileReadIgnorePatterns(latestPermissionContext)
    expect(denyBefore.size).toBeGreaterThan(0)
    expect(getSettingsRootPathForSource('projectSettings')).toBe(
      resolve(sandbox),
    )

    const result = await call('sub', ctx)
    expect(result.type).toBe('text')

    expect(getFileReadIgnorePatterns(latestPermissionContext)).toEqual(
      denyBefore,
    )
    expect(getSettingsRootPathForSource('projectSettings')).toBe(
      resolve(sandbox),
    )
    expect(getOriginalCwd()).toBe(sub)
  })

  it('preserves a permission update made while validation was awaiting', async () => {
    const sub = join(sandbox, 'sub')
    mkdirSync(sub)
    const ctx = context()
    // A rule added by a concurrent writer between validation and setAppState
    // must survive the /cd update.
    await call('sub', {
      ...ctx,
      setAppState: updater => {
        ctx.setAppState(prev => ({
          ...prev,
          toolPermissionContext: applyPermissionUpdate(
            prev.toolPermissionContext,
            {
              type: 'addRules',
              behavior: 'deny',
              rules: [{ toolName: 'Read', ruleContent: '/concurrent.txt' }],
              destination: 'session',
            },
          ),
        }))
        ctx.setAppState(updater)
      },
    } as LocalJSXCommandContext)
    const deny = getFileReadIgnorePatterns(latestPermissionContext)
    expect([...deny.values()].flat()).toContain('/concurrent.txt')
  })

  it('errors when the path does not exist', async () => {
    const result = await call('no-such-dir', context())
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('was not found')
    }
    expect(getCwd()).toBe(sandbox)
  })

  it('errors when the path is a file', async () => {
    writeFileSync(join(sandbox, 'file.txt'), 'x')
    const result = await call('file.txt', context())
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('is not a directory')
    }
    expect(getCwd()).toBe(sandbox)
  })
})
