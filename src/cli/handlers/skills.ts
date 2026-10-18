/**
 * Skills subcommand handler — lists and inspects configured skills.
 */

import { isAbsolute, join, relative, resolve } from 'path'
import {
  findCommand,
  getCommandName,
  getCommands,
  type Command,
} from '../../commands.js'
import { getUnloadedSiblingSkillHomes } from '../../skills/loadSkillsDir.js'
import { getCwd } from '../../utils/cwd.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getDisplayPath } from '../../utils/file.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { PROJECT_CONFIG_DIR_NAMES } from '../../utils/markdownConfigLoader.js'
import {
  formatSkillsListForDisplay,
  formatSkillsListJson,
  isPublicSkill,
  locationLabel,
  sourceLabel,
  trustLabel,
  type SkillListCommand,
} from './skillsListFormat.js'
import {
  findLocalSkillForRemoval,
  getSiblingSkillRemoveMessage,
  getSkillRemoveNotFoundMessage,
} from './skillsRemoveMessage.js'
import { validateSkillPath } from './skillsValidation.js'

export { skillsInstallHandler } from './skillsInstall.js'
export { skillsVerifyHandler } from './skillsVerify.js'

type SkillCommand = SkillListCommand
type ListOptions = { json?: boolean }
type RemoveOptions = { global?: boolean; projectDir?: string }
const VALID_REMOVE_SKILL_NAME = /^[a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)*$/

function isSkillCommand(cmd: Command): cmd is SkillCommand {
  return (
    cmd.type === 'prompt' &&
    (cmd.loadedFrom === 'skills' ||
      cmd.loadedFrom === 'commands_DEPRECATED' ||
      cmd.loadedFrom === 'plugin' ||
      cmd.loadedFrom === 'bundled' ||
      cmd.loadedFrom === 'mcp')
  )
}

function loadSkills(cwd = getCwd()): Promise<SkillCommand[]> {
  return getCommands(cwd).then(commands => commands.filter(isSkillCommand))
}

function resolveContainedPath(root: string, child: string): string {
  const resolvedRoot = resolve(root)
  const resolvedChild = resolve(resolvedRoot, child)
  const relativePath = relative(resolvedRoot, resolvedChild)

  if (
    relativePath === '' ||
    relativePath.startsWith('..') ||
    isAbsolute(relativePath)
  ) {
    throw new Error(
      `Invalid skill remove path "${child}". Skill paths must stay inside ${getDisplayPath(resolvedRoot)}.`,
    )
  }

  return resolvedChild
}

function isContainedInRoot(root: string, child: string): boolean {
  const resolvedRoot = resolve(root)
  const resolvedChild = resolve(child)
  const relativePath = relative(resolvedRoot, resolvedChild)
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  )
}

function localSkillRoots(options: RemoveOptions): string[] {
  return options.global
    ? [join(getClaudeConfigHomeDir(), 'skills')]
    : PROJECT_CONFIG_DIR_NAMES.map(configDirName =>
        join(options.projectDir ?? getCwd(), configDirName, 'skills'),
      )
}

function localSkillRootsForRemoval(
  name: string,
  options: RemoveOptions,
): string[] {
  const skillName = name.trim()
  if (!VALID_REMOVE_SKILL_NAME.test(skillName)) return []
  return localSkillRoots(options).map(root =>
    resolveContainedPath(root, join(...skillName.split(':'))),
  )
}

function isSkillInRemovalRoot(
  skill: SkillCommand,
  options: RemoveOptions,
): boolean {
  return (
    skill.loadedFrom === 'skills' &&
    typeof skill.skillRoot === 'string' &&
    localSkillRoots(options).some(root => isContainedInRoot(root, skill.skillRoot!))
  )
}

async function existingLocalSkillRootForRemoval(
  name: string,
  options: RemoveOptions,
): Promise<string | undefined> {
  for (const skillRoot of localSkillRootsForRemoval(name, options)) {
    try {
      await getFsImplementation().stat(join(skillRoot, 'SKILL.md'))
      return skillRoot
    } catch {
      // Keep checking other supported roots.
    }
  }
  return undefined
}

export async function skillsListHandler(options: ListOptions = {}): Promise<void> {
  const [skills, unloadedSiblingHomes] = await Promise.all([
    loadSkills(),
    getUnloadedSiblingSkillHomes().catch(() => []),
  ])

  if (options.json) {
    console.log(formatSkillsListJson(skills, unloadedSiblingHomes))
    return
  }

  console.log(
    formatSkillsListForDisplay(skills, undefined, unloadedSiblingHomes),
  )
}

export async function skillsShowHandler(name: string): Promise<void> {
  const skills = await loadSkills()
  const skill = findCommand(name, skills.filter(isPublicSkill))
  if (!skill || !isSkillCommand(skill)) {
    console.error(`Skill "${name}" not found.`)
    process.exitCode = 1
    return
  }

  const lines = [
    `Name: ${getCommandName(skill)}`,
    `Source: ${sourceLabel(skill)}`,
    `Trust: ${trustLabel(skill)}`,
    `Version: ${skill.version ?? '-'}`,
    `Location: ${locationLabel(skill)}`,
    `Description: ${skill.description}`,
  ]

  if (skill.whenToUse) {
    lines.push(`When to use: ${skill.whenToUse}`)
  }

  if (skill.allowedTools && skill.allowedTools.length > 0) {
    lines.push(`Allowed tools: ${skill.allowedTools.join(', ')}`)
  }

  if (skill.skillFilePath) {
    try {
      const content = await getFsImplementation().readFile(skill.skillFilePath, {
        encoding: 'utf8',
      })
      lines.push('', '--- SKILL.md ---', content.trimEnd())
    } catch {
      lines.push('', 'SKILL.md could not be read.')
    }
  }

  console.log(lines.join('\n'))
}

export async function skillsValidateHandler(path: string): Promise<void> {
  const errors = await validateSkillPath(path)
  if (errors.length > 0) {
    console.error(`Skill validation failed for ${getDisplayPath(resolve(path))}:`)
    for (const error of errors) {
      console.error(`- ${error}`)
    }
    process.exitCode = 1
    return
  }

  console.log(`Skill validation passed for ${getDisplayPath(resolve(path))}.`)
}

export async function skillsRemoveHandler(
  name: string,
  options: RemoveOptions,
): Promise<void> {
  const directSkillRoot = await existingLocalSkillRootForRemoval(name, options)
  if (directSkillRoot) {
    await getFsImplementation().rm(directSkillRoot, { recursive: true, force: false })
    console.log(
      `Removed skill "${name}" from ${options.global ? 'user' : 'project'}.`,
    )
    return
  }

  const loadedSkills = (await loadSkills(options.projectDir)).filter(
    isPublicSkill,
  )
  const skills = loadedSkills.filter(
    skill =>
      isSkillInRemovalRoot(skill, options) ||
      isSkillInRemovalRoot(skill, { ...options, global: !options.global }),
  )
  const targetSource = options.global ? 'userSettings' : 'projectSettings'
  const skill = findLocalSkillForRemoval(skills, name, targetSource)

  if (!skill) {
    console.error(
      getSiblingSkillRemoveMessage(loadedSkills, name) ??
        getSkillRemoveNotFoundMessage(skills, name, options),
    )
    process.exitCode = 1
    return
  }

  if (!skill.skillRoot) {
    console.error(`Skill "${name}" does not have a removable local directory.`)
    process.exitCode = 1
    return
  }

  await getFsImplementation().rm(skill.skillRoot, { recursive: true, force: false })
  console.log(`Removed skill "${getCommandName(skill)}" from ${sourceLabel(skill)}.`)
}
