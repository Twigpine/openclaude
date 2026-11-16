import chalk from 'chalk'
import { resolve } from 'path'
import {
  getAdditionalDirectoriesForClaudeMd,
  getOriginalCwd,
  setAdditionalDirectoriesForClaudeMd,
  setOriginalCwd,
} from '../../bootstrap/state.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import type { LocalCommandCall } from '../../types/command.js'
import { clearMemoryFileCaches } from '../../utils/claudemd.js'
import { getCwd } from '../../utils/cwd.js'
import { clearRepositoryCaches } from '../../utils/detectRepository.js'
import {
  findCanonicalGitRoot,
  findGitRoot,
  getIsGit,
} from '../../utils/git.js'
import {
  clearResolveGitDirCache,
  resetGitFileWatcher,
} from '../../utils/git/gitFilesystem.js'
import { onCwdChangedForHooks } from '../../utils/hooks/fileChangedWatcher.js'
import { expandPath, isPathInsideDir } from '../../utils/path.js'
import { applyPermissionUpdate } from '../../utils/permissions/PermissionUpdate.js'
import { getPlansDirectory } from '../../utils/plans.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { invalidateSessionEnvCache } from '../../utils/sessionEnvironment.js'
import { setCwd } from '../../utils/Shell.js'
import { validateDirectoryForWorkspace } from '../add-dir/validation.js'

export const call: LocalCommandCall = async (args, context) => {
  const input = (args ?? '').trim()
  if (!input) {
    return { type: 'text', value: `Current working directory: ${getCwd()}` }
  }

  const permissionContext = context.getAppState().toolPermissionContext
  const absolutePath = resolve(expandPath(input))
  const result = await validateDirectoryForWorkspace(input, permissionContext)
  switch (result.resultType) {
    case 'emptyPath':
      return { type: 'text', value: 'Please provide a directory path.' }
    case 'pathNotFound':
      return {
        type: 'text',
        value: `Path ${chalk.bold(result.absolutePath)} was not found.`,
      }
    case 'notADirectory':
      return {
        type: 'text',
        value: `${chalk.bold(result.directoryPath)} is not a directory.`,
      }
  }

  // Keep the previous root authorized when the move leaves it; a move inside
  // it stays covered by that root.
  const previousRoot = getOriginalCwd()
  const directoriesToAdd =
    result.resultType === 'success' ? [absolutePath] : []
  if (
    previousRoot !== absolutePath &&
    !isPathInsideDir(previousRoot, absolutePath)
  ) {
    directoriesToAdd.push(previousRoot)
  }

  if (directoriesToAdd.length > 0) {
    // Apply inside the updater: validation above awaited I/O, so the context
    // captured at entry may be stale by now. Reading prev preserves any rule
    // or mode change that landed in between.
    context.setAppState(prev => ({
      ...prev,
      toolPermissionContext: applyPermissionUpdate(prev.toolPermissionContext, {
        type: 'addDirectories',
        directories: directoriesToAdd,
        destination: 'session',
      }),
    }))

    // The sandbox's allowWrite reads this list, not the permission context —
    // mirror every directory the session just gained (including the retained
    // previous root) or sandboxed Bash loses write access file tools keep.
    const claudeMdDirs = new Set(getAdditionalDirectoriesForClaudeMd())
    for (const dir of directoriesToAdd) {
      claudeMdDirs.add(dir)
    }
    setAdditionalDirectoriesForClaudeMd([...claudeMdDirs])
  }

  const previousCwd = getCwd()
  process.chdir(absolutePath)
  setCwd(absolutePath)
  const newCwd = getCwd() // canonical: setCwd resolves symlinks like pwd -P
  setOriginalCwd(newCwd)

  // The cwd-transition lifecycle other flows already run: drop prior-cwd env
  // exports, fire CwdChanged hooks, rebind the Git file watcher, and expire
  // cached Git identity so the next command sees this directory's repo.
  invalidateSessionEnvCache()
  void onCwdChangedForHooks(previousCwd, newCwd)
  getIsGit.cache.clear?.()
  findGitRoot.cache.clear?.()
  findCanonicalGitRoot.cache.clear?.()
  clearResolveGitDirCache()
  resetGitFileWatcher()
  clearRepositoryCaches()

  await SandboxManager.refreshWorktreeMainRepoPath(newCwd)
  SandboxManager.refreshConfig()
  clearSystemPromptSections()
  clearMemoryFileCaches()
  getPlansDirectory.cache.clear?.()

  return {
    type: 'text',
    value: `Changed working directory to ${chalk.bold(absolutePath)}`,
  }
}
