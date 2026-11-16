import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
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
import { restoreWorktreeForResume } from '../../utils/sessionRestore.js'
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

    restoreSessionToOriginalCwd(originalRoot, worktreeSessionOwnsProjectRoot(session()))

    expect(getOriginalCwd()).toBe(originalRoot)
    expect(getProjectRoot()).toBe(originalRoot)
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

    restoreWorktreeForResume(session())

    expect(getOriginalCwd()).toBe(worktreePath)
    expect(getProjectRoot()).toBe(worktreePath)
    const restored = getCurrentWorktreeSession()
    expect(restored).not.toBeNull()
    expect(worktreeSessionOwnsProjectRoot(restored!)).toBe(true)

    restoreSessionToOriginalCwd(originalRoot, worktreeSessionOwnsProjectRoot(restored!))

    expect(getOriginalCwd()).toBe(originalRoot)
    expect(getProjectRoot()).toBe(originalRoot)
  })

  it('keeps projectRoot on the launch root when resuming a mid-session worktree', () => {
    setCwd(originalRoot)
    setOriginalCwd(originalRoot)
    setProjectRoot(originalRoot)
    const midSession = session()
    delete midSession.projectRootIsWorktree

    restoreWorktreeForResume(midSession)

    expect(getOriginalCwd()).toBe(worktreePath)
    expect(getProjectRoot()).toBe(originalRoot)
    expect(getCurrentWorktreeSession()).not.toBeNull()
    expect(worktreeSessionOwnsProjectRoot(getCurrentWorktreeSession()!)).toBe(false)
  })
})
