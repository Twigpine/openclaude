import { homedir } from 'os'
import { join } from 'path'
import type { Command, PromptCommand } from '../types/command.js'
import { getCommandName } from '../types/command.js'
import { logForDebugging } from '../utils/debug.js'
import {
  getEnabledSettingSources,
  type SettingSource,
} from '../utils/settings/constants.js'
import { getSettingsForSource } from '../utils/settings/settings.js'
import type { SettingsJson } from '../utils/settings/types.js'

/**
 * Skills homes owned by other agent harnesses. OpenClaude reads them
 * read-only, after every OpenClaude-owned skill source (#2258).
 *
 * - `~/.agents/skills` is the shared cross-agent home (Codex's user skills
 *   directory and the `npx skills` global install target), so it is on by
 *   default.
 * - `~/.claude/skills` is Claude Code's private config directory. OpenClaude
 *   stays isolated from Claude Code config by default (#1875), so it is
 *   opt-in.
 */
export type SiblingSkillsHomeId = NonNullable<PromptCommand['siblingSkillsHome']>

export type SiblingSkillsHome = {
  id: SiblingSkillsHomeId
  /** Path segments below the user's home directory. */
  segments: readonly [string, string]
  settingKey: 'agentsSkillsEnabled' | 'claudeCodeSkillsEnabled'
  defaultEnabled: boolean
  /** Section title in the /skills menu. */
  title: string
  /** Label shown in `/config`. */
  configLabel: string
}

// Order is precedence: when both homes hold a skill with the same name, the
// earlier home wins.
export const SIBLING_SKILL_HOMES: readonly SiblingSkillsHome[] = [
  {
    id: 'agents',
    segments: ['.agents', 'skills'],
    settingKey: 'agentsSkillsEnabled',
    defaultEnabled: true,
    title: 'Shared agent skills',
    configLabel: 'Load skills from ~/.agents/skills',
  },
  {
    id: 'claude-code',
    segments: ['.claude', 'skills'],
    settingKey: 'claudeCodeSkillsEnabled',
    defaultEnabled: false,
    title: 'Claude Code skills',
    configLabel: 'Load skills from ~/.claude/skills',
  },
]

// projectSettings is intentionally excluded: a cloned repository must not be
// able to opt the user into reading another tool's home directory. Policy is
// checked first so managed settings can force either value.
const TRUSTED_SETTING_SOURCES: readonly SettingSource[] = [
  'policySettings',
  'flagSettings',
  'localSettings',
  'userSettings',
]

type ReadSettingsForSource = (source: SettingSource) => SettingsJson | null

// Bun caches os.homedir() at startup (Node re-reads $HOME), so tests point the
// homes at a fixture directory through this seam instead of $HOME.
let homeDirOverrideForTesting: string | undefined

export function setSiblingSkillsHomeDirForTesting(
  homeDir: string | undefined,
): void {
  homeDirOverrideForTesting = homeDir
}

function getHomeDir(): string {
  return homeDirOverrideForTesting ?? homedir()
}

export function getSiblingSkillsHome(
  id: SiblingSkillsHomeId,
): SiblingSkillsHome {
  const home = SIBLING_SKILL_HOMES.find(candidate => candidate.id === id)
  if (!home) {
    throw new Error(`Unknown sibling skills home: ${id}`)
  }
  return home
}

export function getSiblingSkillsHomePath(
  home: SiblingSkillsHome,
  homeDir: string = getHomeDir(),
): string {
  return join(homeDir, ...home.segments)
}

/** `~/.agents/skills` style path for UI and logs. */
export function getSiblingSkillsHomeDisplayPath(
  home: SiblingSkillsHome,
): string {
  return `~/${home.segments.join('/')}`
}

export function isSiblingSkillsHomeEnabled(
  home: SiblingSkillsHome,
  readSettingsForSource: ReadSettingsForSource = getSettingsForSource,
  enabledSources: readonly SettingSource[] = getEnabledSettingSources(),
): boolean {
  for (const source of TRUSTED_SETTING_SOURCES) {
    if (!enabledSources.includes(source)) continue
    const value = readSettingsForSource(source)?.[home.settingKey]
    if (typeof value === 'boolean') return value
  }
  return home.defaultEnabled
}

export type ResolvedSiblingSkillsHome = SiblingSkillsHome & {
  path: string
  enabled: boolean
  /** Managed policy pins this home's setting, so the user cannot toggle it. */
  lockedByPolicy: boolean
}

export function resolveSiblingSkillsHomes({
  homeDir = getHomeDir(),
  readSettingsForSource = getSettingsForSource,
  enabledSources = getEnabledSettingSources(),
}: {
  homeDir?: string
  readSettingsForSource?: ReadSettingsForSource
  enabledSources?: readonly SettingSource[]
} = {}): ResolvedSiblingSkillsHome[] {
  return SIBLING_SKILL_HOMES.map(home => ({
    ...home,
    path: getSiblingSkillsHomePath(home, homeDir),
    enabled: isSiblingSkillsHomeEnabled(
      home,
      readSettingsForSource,
      enabledSources,
    ),
    lockedByPolicy:
      typeof readSettingsForSource('policySettings')?.[home.settingKey] ===
      'boolean',
  }))
}

export type SiblingSkillsSettings = Pick<
  SettingsJson,
  SiblingSkillsHome['settingKey']
>

export function siblingSkillsSettingPatch(
  home: SiblingSkillsHome,
  enabled: boolean | undefined,
): SiblingSkillsSettings {
  return { [home.settingKey]: enabled } as SiblingSkillsSettings
}

export function getSiblingSkillsHomeId(
  command: Command,
): SiblingSkillsHomeId | undefined {
  return command.type === 'prompt' ? command.siblingSkillsHome : undefined
}

/**
 * Drops sibling-home skills whose name collides with any other command, so a
 * sibling skill can never shadow a plugin skill, bundled skill or built-in
 * command. Lookup is first-match (findCommand, uniqBy(name)), and skill-dir
 * commands sort ahead of everything else, so without this a sibling skill
 * would win those collisions.
 */
export function filterShadowedSiblingSkills(
  siblingSkills: Command[],
  otherCommands: Command[],
): Command[] {
  const takenNames = new Map<string, string>()
  for (const command of otherCommands) {
    const owner = command.type === 'prompt' ? command.source : 'builtin'
    for (const name of [
      command.name,
      getCommandName(command),
      ...(command.aliases ?? []),
    ]) {
      if (!takenNames.has(name)) takenNames.set(name, owner)
    }
  }

  return siblingSkills.filter(skill => {
    const owner = takenNames.get(skill.name)
    if (owner === undefined) return true
    logShadowedSiblingSkill(skill, owner)
    return false
  })
}

/**
 * Applies sibling-home precedence to a command list: sibling skills are
 * dropped when any other command owns their name, de-duplicated across homes
 * (earlier home wins), and moved after every other command.
 */
export function applySiblingSkillPrecedence(commands: Command[]): Command[] {
  const ownCommands: Command[] = []
  const siblingSkills: Command[] = []
  for (const command of commands) {
    if (getSiblingSkillsHomeId(command)) {
      siblingSkills.push(command)
    } else {
      ownCommands.push(command)
    }
  }
  if (siblingSkills.length === 0) return commands

  const winners = new Map<string, SiblingSkillsHomeId>()
  const keptSiblingSkills: Command[] = []
  for (const skill of filterShadowedSiblingSkills(siblingSkills, ownCommands)) {
    const winner = winners.get(skill.name)
    if (winner) {
      logShadowedSiblingSkill(
        skill,
        getSiblingSkillsHomeDisplayPath(getSiblingSkillsHome(winner)),
      )
      continue
    }
    winners.set(skill.name, getSiblingSkillsHomeId(skill)!)
    keptSiblingSkills.push(skill)
  }

  return [...ownCommands, ...keptSiblingSkills]
}

function logShadowedSiblingSkill(skill: Command, owner: string): void {
  const homeId = getSiblingSkillsHomeId(skill)
  const homePath = homeId
    ? getSiblingSkillsHomeDisplayPath(getSiblingSkillsHome(homeId))
    : 'a sibling skills home'
  logForDebugging(
    `[skills] Skipping '${skill.name}' from ${homePath} (shadowed by ${owner})`,
  )
}
