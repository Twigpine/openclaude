import chalk from 'chalk'
import { relative, resolve } from 'path'
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
import { expandPath } from '../../utils/path.js'
import { applyPermissionUpdate } from '../../utils/permissions/PermissionUpdate.js'
import { getPlansDirectory } from '../../utils/plans.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
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
    relative(absolutePath, previousRoot).startsWith('..')
  ) {
    directoriesToAdd.push(previousRoot)
  }

  if (directoriesToAdd.length > 0) {
    const updatedContext = applyPermissionUpdate(permissionContext, {
      type: 'addDirectories',
      directories: directoriesToAdd,
      destination: 'session',
    })
    context.setAppState(prev => ({
      ...prev,
      toolPermissionContext: updatedContext,
    }))
  }

  if (result.resultType === 'success') {
    const currentDirs = getAdditionalDirectoriesForClaudeMd()
    if (!currentDirs.includes(absolutePath)) {
      setAdditionalDirectoriesForClaudeMd([...currentDirs, absolutePath])
    }
  }

  process.chdir(absolutePath)
  setCwd(absolutePath)
  setOriginalCwd(getCwd())
  SandboxManager.refreshConfig()
  clearSystemPromptSections()
  clearMemoryFileCaches()
  getPlansDirectory.cache.clear?.()

  return {
    type: 'text',
    value: `Changed working directory to ${chalk.bold(absolutePath)}`,
  }
}
