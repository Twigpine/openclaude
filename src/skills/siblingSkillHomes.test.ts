import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import type { Command } from '../types/command.js'
import type { SettingSource } from '../utils/settings/constants.js'
import type { SettingsJson } from '../utils/settings/types.js'
import {
  applySiblingSkillPrecedence,
  filterShadowedSiblingSkills,
  getSiblingSkillsHome,
  isSiblingSkillsHomeEnabled,
  resolveSiblingSkillsHomes,
  type SiblingSkillsHomeId,
} from './siblingSkillHomes.js'

const ALL_SOURCES: SettingSource[] = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
]

const agentsHome = getSiblingSkillsHome('agents')
const claudeCodeHome = getSiblingSkillsHome('claude-code')

function settingsBySource(
  settings: Partial<Record<SettingSource, SettingsJson>>,
): (source: SettingSource) => SettingsJson | null {
  return source => settings[source] ?? null
}

function skill(
  name: string,
  options: {
    siblingSkillsHome?: SiblingSkillsHomeId
    source?: Extract<Command, { type: 'prompt' }>['source']
    userFacingName?: string
  } = {},
): Command {
  return {
    type: 'prompt',
    name,
    description: `${name} description`,
    progressMessage: 'running',
    contentLength: 0,
    source: options.source ?? 'userSettings',
    loadedFrom: 'skills',
    siblingSkillsHome: options.siblingSkillsHome,
    ...(options.userFacingName
      ? { userFacingName: () => options.userFacingName! }
      : {}),
    async getPromptForCommand() {
      return []
    },
  }
}

function builtin(name: string, aliases: string[] = []): Command {
  return {
    type: 'local',
    name,
    aliases,
    description: `${name} command`,
    supportsNonInteractive: true,
    load: async () => ({ call: async () => ({ type: 'skip' }) }),
  } as Command
}

function names(commands: Command[]): string[] {
  return commands.map(command =>
    command.type === 'prompt' && command.siblingSkillsHome
      ? `${command.name}@${command.siblingSkillsHome}`
      : command.name,
  )
}

describe('isSiblingSkillsHomeEnabled', () => {
  test('loads ~/.agents/skills by default and keeps ~/.claude/skills opt-in', () => {
    const noSettings = settingsBySource({})
    expect(isSiblingSkillsHomeEnabled(agentsHome, noSettings, ALL_SOURCES)).toBe(
      true,
    )
    expect(
      isSiblingSkillsHomeEnabled(claudeCodeHome, noSettings, ALL_SOURCES),
    ).toBe(false)
  })

  test('honors a user settings opt-in and opt-out', () => {
    const read = settingsBySource({
      userSettings: { claudeCodeSkillsEnabled: true, agentsSkillsEnabled: false },
    })
    expect(isSiblingSkillsHomeEnabled(claudeCodeHome, read, ALL_SOURCES)).toBe(
      true,
    )
    expect(isSiblingSkillsHomeEnabled(agentsHome, read, ALL_SOURCES)).toBe(false)
  })

  test('ignores project settings so a repository cannot opt the user in', () => {
    const read = settingsBySource({
      projectSettings: { claudeCodeSkillsEnabled: true, agentsSkillsEnabled: false },
    })
    expect(isSiblingSkillsHomeEnabled(claudeCodeHome, read, ALL_SOURCES)).toBe(
      false,
    )
    expect(isSiblingSkillsHomeEnabled(agentsHome, read, ALL_SOURCES)).toBe(true)
  })

  test('lets managed policy override user settings', () => {
    const read = settingsBySource({
      policySettings: { agentsSkillsEnabled: false },
      userSettings: { agentsSkillsEnabled: true },
    })
    expect(isSiblingSkillsHomeEnabled(agentsHome, read, ALL_SOURCES)).toBe(false)
  })

  test('prefers local settings over user settings', () => {
    const read = settingsBySource({
      localSettings: { claudeCodeSkillsEnabled: true },
      userSettings: { claudeCodeSkillsEnabled: false },
    })
    expect(isSiblingSkillsHomeEnabled(claudeCodeHome, read, ALL_SOURCES)).toBe(
      true,
    )
  })

  test('skips settings sources that are disabled for the session', () => {
    const read = settingsBySource({
      userSettings: { claudeCodeSkillsEnabled: true },
    })
    expect(
      isSiblingSkillsHomeEnabled(claudeCodeHome, read, [
        'projectSettings',
        'policySettings',
        'flagSettings',
      ]),
    ).toBe(false)
  })
})

describe('resolveSiblingSkillsHomes', () => {
  test('resolves both homes under the given home directory in precedence order', () => {
    const homes = resolveSiblingSkillsHomes({
      homeDir: '/home/tester',
      readSettingsForSource: settingsBySource({
        policySettings: { claudeCodeSkillsEnabled: false },
      }),
      enabledSources: ALL_SOURCES,
    })

    expect(
      homes.map(({ id, path, enabled, pinnedBy }) => ({
        id,
        path,
        enabled,
        pinnedBy,
      })),
    ).toEqual([
      {
        id: 'agents',
        path: join('/home/tester', '.agents', 'skills'),
        enabled: true,
        pinnedBy: undefined,
      },
      {
        id: 'claude-code',
        path: join('/home/tester', '.claude', 'skills'),
        enabled: false,
        pinnedBy: 'policySettings',
      },
    ])
  })

  test('reports a home pinned by any source that outranks user settings', () => {
    const homes = resolveSiblingSkillsHomes({
      homeDir: '/home/tester',
      readSettingsForSource: settingsBySource({
        flagSettings: { agentsSkillsEnabled: false },
        localSettings: { claudeCodeSkillsEnabled: true },
        userSettings: {
          agentsSkillsEnabled: true,
          claudeCodeSkillsEnabled: false,
        },
      }),
      enabledSources: ALL_SOURCES,
    })

    expect(homes.map(({ id, enabled, pinnedBy }) => ({ id, enabled, pinnedBy })))
      .toEqual([
        { id: 'agents', enabled: false, pinnedBy: 'flagSettings' },
        { id: 'claude-code', enabled: true, pinnedBy: 'localSettings' },
      ])
  })

  test('leaves a home unpinned when only user settings, or a disabled source, set it', () => {
    const homes = resolveSiblingSkillsHomes({
      homeDir: '/home/tester',
      readSettingsForSource: settingsBySource({
        localSettings: { agentsSkillsEnabled: false },
        projectSettings: { claudeCodeSkillsEnabled: true },
        userSettings: { claudeCodeSkillsEnabled: true },
      }),
      enabledSources: ['userSettings', 'projectSettings', 'policySettings', 'flagSettings'],
    })

    expect(homes.map(({ id, enabled, pinnedBy }) => ({ id, enabled, pinnedBy })))
      .toEqual([
        { id: 'agents', enabled: true, pinnedBy: undefined },
        { id: 'claude-code', enabled: true, pinnedBy: undefined },
      ])
  })
})

describe('filterShadowedSiblingSkills', () => {
  test('drops sibling skills whose name matches a command name, alias, or display name', () => {
    const kept = filterShadowedSiblingSkills(
      [
        skill('help', { siblingSkillsHome: 'agents' }),
        skill('h', { siblingSkillsHome: 'agents' }),
        skill('pretty', { siblingSkillsHome: 'agents' }),
        skill('renamed-help', { siblingSkillsHome: 'agents', userFacingName: 'help' }),
        skill('nested:alias', { siblingSkillsHome: 'claude-code', userFacingName: 'h' }),
        skill('nested:display', { siblingSkillsHome: 'agents', userFacingName: 'pretty' }),
        skill('help', { siblingSkillsHome: 'claude-code', userFacingName: 'unreserved' }),
        skill('unique', { siblingSkillsHome: 'agents', userFacingName: 'unique-display' }),
      ],
      [
        builtin('help', ['h']),
        skill('plugin:ugly', { source: 'plugin', userFacingName: 'pretty' }),
      ],
    )

    expect(names(kept)).toEqual(['unique@agents'])
  })
})

describe('applySiblingSkillPrecedence', () => {
  test('returns the same list when no sibling skills are present', () => {
    const commands = [skill('one'), builtin('help')]
    expect(applySiblingSkillPrecedence(commands)).toBe(commands)
  })

  test('uses home priority for overlapping invocation names even when input is reversed', () => {
    const agents = skill('nested:deploy', { siblingSkillsHome: 'agents', userFacingName: 'deploy' })
    const claude = skill('deploy', { siblingSkillsHome: 'claude-code' })
    for (const commands of [[claude, agents], [agents, claude]]) {
      expect(applySiblingSkillPrecedence(commands)).toEqual([agents])
    }
  })

  test('preserves same-home invocation overlaps while excluding lower-home collisions', () => {
    const first = skill('first', { siblingSkillsHome: 'agents', userFacingName: 'shared' })
    const second = skill('shared', { siblingSkillsHome: 'agents' })
    const lower = skill('renamed', { siblingSkillsHome: 'claude-code', userFacingName: 'shared' })
    expect(applySiblingSkillPrecedence([lower, first, second, first])).toEqual([first, second])
  })

  test('moves sibling skills after every other command and lets the first home win', () => {
    const resolved = applySiblingSkillPrecedence([
      skill('shared-agent', { siblingSkillsHome: 'agents' }),
      skill('mine'),
      skill('mine', { siblingSkillsHome: 'claude-code' }),
      skill('shared-agent', { siblingSkillsHome: 'claude-code' }),
      skill('claude-only', { siblingSkillsHome: 'claude-code' }),
      builtin('help'),
      skill('help', { siblingSkillsHome: 'agents' }),
    ])

    expect(names(resolved)).toEqual([
      'mine',
      'help',
      'shared-agent@agents',
      'claude-only@claude-code',
    ])
  })
})
