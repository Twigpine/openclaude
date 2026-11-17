import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getCwdState,
  getOriginalCwd,
  getProjectRoot,
  setCwdState,
  setOriginalCwd,
  setProjectRoot,
} from '../../bootstrap/state.js'
import { setCwd } from '../../utils/Shell.js'
import * as hooksConfigSnapshot from '../../utils/hooks/hooksConfigSnapshot.js'
import {
  exitRestoredWorktree,
  restoreWorktreeForResume,
} from '../../utils/sessionRestore.js'
import {
  getClaudeConfigHomeDirOverrideForTesting,
  setClaudeConfigHomeDirForTesting,
} from '../../utils/envUtils.js'
import type { WorktreeSession } from '../../utils/worktree.js'
import {
  getCurrentWorktreeSession,
  restoreWorktreeSession,
} from '../../utils/worktree.js'
import {
  restoreSessionToOriginalCwd,
  worktreeSessionOwnsProjectRoot,
} from './ExitWorktreeTool.js'

describe('ExitWorktreeTool startup-worktree ownership', () => {
  let root: string
  let originalRoot: string
  let worktreePath: string
  let savedCwd: string
  let savedRoot: string
  let savedShellCwd: string
  let savedProcessCwd: string
  let savedConfig: string | undefined

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'oc-exit-wt-')))
    originalRoot = join(root, 'original')
    worktreePath = join(root, 'worktree')
    mkdirSync(originalRoot)
    mkdirSync(worktreePath)
    savedCwd = getOriginalCwd()
    savedRoot = getProjectRoot()
    savedShellCwd = getCwdState()
    savedProcessCwd = process.cwd()
    savedConfig = getClaudeConfigHomeDirOverrideForTesting()
    setClaudeConfigHomeDirForTesting(join(root, 'config'))
    // --worktree startup: session entered the worktree and projectRoot
    // moved onto it.
    setOriginalCwd(worktreePath)
    setProjectRoot(worktreePath)
    setCwd(worktreePath)
    restoreWorktreeSession(null)
  })

  afterEach(() => {
    setOriginalCwd(savedCwd)
    setProjectRoot(savedRoot)
    setClaudeConfigHomeDirForTesting(savedConfig)
    restoreWorktreeSession(null)
    // Restore both cwd layers before removing the fixture, so a later
    // test in this process never inherits a deleted working directory.
    setCwdState(savedShellCwd)
    process.chdir(savedProcessCwd)
    rmSync(root, { recursive: true, force: true })
  })

  const session = (): WorktreeSession => ({
    originalCwd: originalRoot,
    worktreePath,
    worktreeName: 'test-worktree',
    sessionId: 'test-session' as never,
    projectRootIsWorktree: true,
  })

  it('restores projectRoot after /cd moved the working root off the worktree', () => {
    // A mid-session /cd to a subdirectory moves originalCwd while
    // projectRoot stays at the worktree. Comparing the two mutable roots
    // would misjudge this startup session as mid-session and skip the
    // projectRoot restore.
    const subdir = join(worktreePath, 'sub')
    mkdirSync(subdir)
    setOriginalCwd(subdir)
    expect(getProjectRoot()).toBe(worktreePath)

    // Same no-op spy as the resume/exit tests below: the real refresh would
    // recompute the module-level hooks snapshot from this fixture and leak it.
    const hooksSpy = spyOn(
      hooksConfigSnapshot,
      'updateHooksConfigSnapshot',
    ).mockImplementation(() => {})
    try {
      restoreSessionToOriginalCwd(originalRoot, worktreeSessionOwnsProjectRoot(session()))

      expect(getOriginalCwd()).toBe(originalRoot)
      expect(getProjectRoot()).toBe(originalRoot)
      // Owning the project root means re-reading hooks for the original root,
      // symmetric to setup.ts's --worktree block (the exit-side counterpart
      // of the resume assertions in the persisted-session test below).
      expect(hooksSpy).toHaveBeenCalledTimes(1)
    } finally {
      hooksSpy.mockRestore()
    }
  })

  it('does not restore projectRoot for a mid-session entered worktree', () => {
    const midSession = session()
    delete midSession.projectRootIsWorktree

    restoreSessionToOriginalCwd(originalRoot, worktreeSessionOwnsProjectRoot(midSession))

    // projectRoot was never moved by EnterWorktreeTool, so it must stay
    // where the session anchored it, not jump to the pre-worktree cwd.
    expect(getProjectRoot()).toBe(worktreePath)
  })

  it('restores projectRoot through resume and exit for a persisted --worktree session', () => {
    // Simulate the pre-resume process state: the shell sits in the launch
    // checkout with projectRoot anchored there.
    setCwd(originalRoot)
    setOriginalCwd(originalRoot)
    setProjectRoot(originalRoot)

    // Replace the implementation: the real refresh resets the settings
    // cache and recomputes the module-level snapshot from this test's
    // temporary fixture, which leaks to later tests in the same process.
    // These tests only assert the call count, so a no-op keeps that contract.
    const hooksSpy = spyOn(
      hooksConfigSnapshot,
      'updateHooksConfigSnapshot',
    ).mockImplementation(() => {})
    try {
      restoreWorktreeForResume(session())

      expect(getOriginalCwd()).toBe(worktreePath)
      expect(getProjectRoot()).toBe(worktreePath)
      // Owning the project root means re-reading hooks for the new root,
      // mirroring setup.ts's --worktree block.
      expect(hooksSpy).toHaveBeenCalledTimes(1)
      const restored = getCurrentWorktreeSession()
      expect(restored).not.toBeNull()
      expect(worktreeSessionOwnsProjectRoot(restored!)).toBe(true)

      // The mid-session /resume undo path must also refresh so hooks do not
      // stay bound to the abandoned worktree root.
      exitRestoredWorktree()
      expect(hooksSpy).toHaveBeenCalledTimes(2)
      expect(getOriginalCwd()).toBe(originalRoot)
      expect(getProjectRoot()).toBe(originalRoot)
    } finally {
      hooksSpy.mockRestore()
    }
  })

  it('keeps projectRoot on the launch root when resuming a mid-session worktree', () => {
    setCwd(originalRoot)
    setOriginalCwd(originalRoot)
    setProjectRoot(originalRoot)
    const midSession = session()
    delete midSession.projectRootIsWorktree

    // Replace the implementation: the real refresh resets the settings
    // cache and recomputes the module-level snapshot from this test's
    // temporary fixture, which leaks to later tests in the same process.
    // These tests only assert the call count, so a no-op keeps that contract.
    const hooksSpy = spyOn(
      hooksConfigSnapshot,
      'updateHooksConfigSnapshot',
    ).mockImplementation(() => {})
    try {
      restoreWorktreeForResume(midSession)

      expect(getOriginalCwd()).toBe(worktreePath)
      expect(getProjectRoot()).toBe(originalRoot)
      // No root move, no hooks refresh.
      expect(hooksSpy).not.toHaveBeenCalled()
      expect(getCurrentWorktreeSession()).not.toBeNull()
      expect(worktreeSessionOwnsProjectRoot(getCurrentWorktreeSession()!)).toBe(false)
    } finally {
      hooksSpy.mockRestore()
    }
  })
})
