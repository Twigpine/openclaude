import {
  getSiblingSkillsHomeDisplayPath,
  type ResolvedSiblingSkillsHome,
} from '../../skills/siblingSkillHomes.js'
import { getCommandName, type Command } from '../../types/command.js'
import { getDisplayPath } from '../../utils/file.js'
import { plural } from '../../utils/stringUtils.js'

export type SkillListCommand = Command & { type: 'prompt' }

export type UnloadedSiblingSkillsHome = {
  home: ResolvedSiblingSkillsHome
  count: number
}

export function sourceLabel(skill: SkillListCommand): string {
  if (skill.siblingSkillsHome) return skill.siblingSkillsHome
  if (!skill.source) return '-'
  if (skill.source === 'projectSettings') return 'project'
  if (skill.source === 'userSettings') return 'user'
  if (skill.source === 'policySettings') return 'managed'
  return skill.source
}

export function trustLabel(skill: SkillListCommand): string {
  if (skill.source === 'bundled') return 'bundled'
  if (skill.source === 'plugin') return 'plugin'
  if (skill.source === 'mcp') return 'mcp'
  if (skill.source === 'policySettings') return 'managed'
  if (skill.skillTrust) return skill.skillTrust
  return 'local'
}

export function locationLabel(skill: SkillListCommand): string {
  if (skill.skillFilePath) return getDisplayPath(skill.skillFilePath)
  if (skill.skillRoot) return getDisplayPath(skill.skillRoot)
  return '-'
}

export function isPublicSkill(skill: SkillListCommand): boolean {
  return skill.source !== 'bundled'
}

function publicSkills(skills: SkillListCommand[]): SkillListCommand[] {
  return skills.filter(isPublicSkill)
}

function getResolutionState(
  skills: SkillListCommand[],
): Map<SkillListCommand, string> {
  const winners = new Map<string, SkillListCommand>()
  const states = new Map<SkillListCommand, string>()

  for (const skill of skills) {
    const key = getCommandName(skill)
    const winner = winners.get(key)
    if (winner) {
      states.set(skill, `shadowed by ${sourceLabel(winner)}`)
    } else {
      winners.set(key, skill)
      states.set(skill, 'enabled')
    }
  }

  return states
}

function normalizeDescription(text: string | undefined): string {
  const normalized = text?.trim().replace(/\s+/g, ' ') ?? ''
  return normalized || 'No description provided.'
}

function descriptionSummary(text: string | undefined): string {
  const normalized = normalizeDescription(text)
  if (normalized === 'No description provided.') return normalized
  const firstSentence = normalized.match(/^.*?(?:\.(?:\s|$)|$)/)?.[0] ?? normalized
  const withoutSkillPrefix = firstSentence.replace(/^Use this skill to\s+/i, '')
  const summary = (
    withoutSkillPrefix
      ? withoutSkillPrefix[0]!.toUpperCase() + withoutSkillPrefix.slice(1)
      : withoutSkillPrefix
  ).trim()
  return /[.!?]$/.test(summary) ? summary : `${summary}.`
}

export function wrapSkillDescription(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length > width && current) {
      lines.push(current)
      current = word
    } else {
      current = next
    }
  }

  if (current) {
    lines.push(current)
  }

  return lines
}

function terminalWidth(): number {
  return process.stdout.columns && process.stdout.columns > 0
    ? process.stdout.columns
    : 100
}

function separator(width: number): string {
  return '─'.repeat(width)
}

function formatSkillListRow({
  skill,
  state,
  nameWidth,
  statusWidth,
  descriptionWidth,
  descriptionIndent,
}: {
  skill: SkillListCommand
  state: string | undefined
  nameWidth: number
  statusWidth: number
  descriptionWidth: number
  descriptionIndent: string
}): string {
  const status = state ?? 'enabled'
  const prefix = `${getCommandName(skill).padEnd(nameWidth)}  ${status.padEnd(statusWidth)}   `
  const descriptionLines = wrapSkillDescription(
    descriptionSummary(skill.description),
    descriptionWidth,
  )
  const lines = [`${prefix}${descriptionLines[0] ?? ''}`]
  lines.push(
    ...descriptionLines.slice(1).map(line => `${descriptionIndent}${line}`),
  )
  return lines.join('\n')
}

function skillListJson(
  skill: SkillListCommand,
  state: string | undefined,
): object {
  return {
    name: getCommandName(skill),
    status: state ?? 'enabled',
    source: sourceLabel(skill),
    trust: trustLabel(skill),
    version: skill.version ?? null,
    description: skill.description ?? null,
    location: locationLabel(skill),
    loadedFrom: skill.loadedFrom ?? null,
    siblingHome: skill.siblingSkillsHome ?? null,
    userInvocable: skill.userInvocable ?? null,
    whenToUse: skill.whenToUse ?? null,
    allowedTools: skill.allowedTools ?? [],
  }
}

/** Hint for a sibling skills home that holds skills but is switched off. */
export function formatUnloadedSiblingSkillsHint({
  home,
  count,
}: UnloadedSiblingSkillsHome): string {
  return `${count} ${plural(count, 'skill')} in ${getSiblingSkillsHomeDisplayPath(home)} ${count === 1 ? "isn't" : "aren't"} loaded. Enable "${home.configLabel}" in /config or set "${home.settingKey}": true in user settings.`
}

export function formatSkillsListJson(
  skills: SkillListCommand[],
  unloadedSiblingHomes: UnloadedSiblingSkillsHome[] = [],
): string {
  const visibleSkills = publicSkills(skills)
  const states = getResolutionState(visibleSkills)
  return JSON.stringify(
    {
      enabledCount: [...states.values()].filter(s => s === 'enabled').length,
      skills: visibleSkills
        .slice()
        .sort((a, b) => getCommandName(a).localeCompare(getCommandName(b)))
        .map(skill => skillListJson(skill, states.get(skill))),
      unloadedSkillHomes: unloadedSiblingHomes.map(({ home, count }) => ({
        path: getSiblingSkillsHomeDisplayPath(home),
        setting: home.settingKey,
        count,
      })),
    },
    null,
    2,
  )
}

export function formatSkillsListForDisplay(
  skills: SkillListCommand[],
  columns = terminalWidth(),
  unloadedSiblingHomes: UnloadedSiblingSkillsHome[] = [],
): string {
  const visibleSkills = publicSkills(skills)
  const states = getResolutionState(visibleSkills)
  const sortedSkills = visibleSkills
    .slice()
    .sort((a, b) => getCommandName(a).localeCompare(getCommandName(b)))
  const enabledCount = sortedSkills.filter(
    skill => states.get(skill) === 'enabled',
  ).length
  const hints =
    unloadedSiblingHomes.length > 0
      ? ['', ...unloadedSiblingHomes.map(formatUnloadedSiblingSkillsHint)]
      : []

  if (sortedSkills.length === 0) {
    return [
      'Skills: 0 enabled',
      '',
      'No installed skills found.',
      ...hints,
    ].join('\n')
  }

  const nameWidth = Math.max(
    'Name'.length,
    ...sortedSkills.map(skill => getCommandName(skill).length),
  )
  const statusWidth = Math.max(
    'Status'.length,
    ...sortedSkills.map(skill => (states.get(skill) ?? 'enabled').length),
  )
  const descriptionStart = nameWidth + 2 + statusWidth + 3
  const descriptionWidth = Math.max(20, columns - descriptionStart)
  const descriptionIndent = ' '.repeat(descriptionStart)
  const header = `${'Name'.padEnd(nameWidth)}  ${'Status'.padEnd(statusWidth)}   Description`
  const rule = `${separator(nameWidth)}  ${separator(statusWidth)}   ${separator(descriptionWidth)}`
  const rows = sortedSkills.map(skill =>
    formatSkillListRow({
      skill,
      state: states.get(skill),
      nameWidth,
      statusWidth,
      descriptionWidth,
      descriptionIndent,
    }),
  )

  return [
    `Skills: ${enabledCount} enabled`,
    '',
    header,
    rule,
    ...rows,
    ...hints,
  ].join('\n')
}
