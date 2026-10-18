import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'bun:test'
import chokidar from 'chokidar'
import React from 'react'
import { clearCommandsCache, findCommand, getCommands } from '../commands.js'
import { formatCommandsWithinBudget } from '../tools/SkillTool/prompt.js'
import { useSkillsChange } from '../hooks/useSkillsChange.js'
import { useSettingsChange } from '../hooks/useSettingsChange.js'
import { createRoot } from '../ink.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { onChangeAppState } from '../state/onChangeAppState.js'
import { createStore } from '../state/store.js'
import { applySettingsChange } from '../utils/settings/applySettingsChange.js'
import { settingsChangeDetector } from '../utils/settings/changeDetector.js'
import { getPluginCommands } from '../utils/plugins/loadPluginCommands.js'
import { getManagedFilePath, getManagedSettingsDropInDir } from '../utils/settings/managedPath.js'

import {
  getOriginalCwd,
  getFlagSettingsPath,
  setFlagSettingsPath,
  setAllowedSettingSources,
  setOriginalCwd,
} from '../bootstrap/state.js'
import {
  enableUserAndProjectSettingSources,
  restoreSettingState,
} from '../test/settingSourceState.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import type { Command } from '../types/command.ts'
import {
  getClaudeConfigHomeDir,
  getClaudeConfigHomeDirOverrideForTesting,
  setClaudeConfigHomeDirForTesting,
} from '../utils/envUtils.ts'
import {
  getFsImplementation,
  setFsImplementation,
} from '../utils/fsOperations.ts'
import { getSettingsForSource } from '../utils/settings/settings.ts'
import {
  resetSettingsCache,
  setCachedSettingsForSource,
} from '../utils/settings/settingsCache.ts'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  clearDynamicSkills,
  getConditionalSkillCount,
  discoverSkillDirsForPaths,
  getSkillDirCommands,
  getProjectSkillsPaths,
  getUnloadedSiblingSkillHomes,
} from './loadSkillsDir.ts'
import { setSiblingSkillsHomeDirForTesting } from './siblingSkillHomes.ts'

function writeSkill(
  rootDir: string,
  skillPath: string,
  options?: { configDirName?: '.claude' | '.openclaude'; description?: string },
): void {
  const skillDir = join(
    rootDir,
    options?.configDirName ?? '.openclaude',
    'skills',
    ...skillPath.split('/'),
  )
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\ndescription: ${options?.description ?? skillPath}\n---\n# ${skillPath}\n`,
    'utf8',
  )
}

function isPromptSkillNamed(
  skill: Command,
  name: string,
): skill is Extract<Command, { type: 'prompt' }> {
  return (
    skill.type === 'prompt' &&
    skill.name === name
  )
}

function writeUserSkill(
  configDir: string,
  skillPath: string,
  description = skillPath,
): void {
  const skillDir = join(configDir, 'skills', ...skillPath.split('/'))
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\ndescription: ${description}\n---\n# ${skillPath}\n`,
    'utf8',
  )
}

function clearSkillAndConfigCaches(): void {
  clearCommandsCache()
  getClaudeConfigHomeDir.cache?.clear?.()
  resetSettingsCache()
}

function setRealFilesystemForTest(): ReturnType<typeof getFsImplementation> {
  const originalFs = getFsImplementation()
  setFsImplementation({
    ...originalFs,
    stat: async path => statSync(path),
    readdir: async path => readdirSync(path, { withFileTypes: true }),
    readFile: async (path, options) => readFileSync(path, options),
  })
  return originalFs
}

function setConfigDirEnv(configDir: string): void {
  setClaudeConfigHomeDirForTesting(undefined)
  process.env.OPENCLAUDE_CONFIG_DIR = configDir
  delete process.env.CLAUDE_CONFIG_DIR
}

function restoreConfigDirEnv(original: {
  openClaudeConfigDir: string | undefined
  claudeConfigDir: string | undefined
  configHomeOverride: string | undefined
}): void {
  setClaudeConfigHomeDirForTesting(original.configHomeOverride)

  if (original.openClaudeConfigDir === undefined) {
    delete process.env.OPENCLAUDE_CONFIG_DIR
  } else {
    process.env.OPENCLAUDE_CONFIG_DIR = original.openClaudeConfigDir
  }

  if (original.claudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = original.claudeConfigDir
  }
}

test.serial('loads flat and nested skills with colon namespaces', async () => {
  await acquireSharedMutationLock('loadSkillsDir.test.ts')
  const configDir = mkdtempSync(join(tmpdir(), 'openclaude-skills-'))
  const cwd = join(configDir, 'workspace')
  const originalConfigDir = {
    openClaudeConfigDir: process.env.OPENCLAUDE_CONFIG_DIR,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
    configHomeOverride: getClaudeConfigHomeDirOverrideForTesting(),
  }
  const originalSettingsState = enableUserAndProjectSettingSources()
  const originalFs = setRealFilesystemForTest()

  try {
    mkdirSync(cwd, { recursive: true })
    writeSkill(configDir, 'flat-skill')
    writeSkill(configDir, 'git/commit')
    writeSkill(configDir, 'frontend/react/form')

    setConfigDirEnv(configDir)
    clearSkillAndConfigCaches()

    const skills = await getSkillDirCommands(cwd)
    const fixtureSkillsRoot = join(configDir, '.openclaude', 'skills')
    const promptSkills = skills.filter(
      (
        skill,
      ): skill is Extract<(typeof skills)[number], { type: 'prompt' }> & {
        skillRoot: string
      } =>
        skill.type === 'prompt' &&
        skill.skillRoot?.startsWith(fixtureSkillsRoot) === true,
    )
    const skillNames = promptSkills.map(skill => skill.name).sort()

    assert.deepEqual(skillNames, [
      'flat-skill',
      'frontend:react:form',
      'git:commit',
    ])

    const nestedSkill = promptSkills.find(skill => skill.name === 'git:commit')
    assert.ok(nestedSkill)
    assert.equal(nestedSkill.skillRoot, join(configDir, '.openclaude', 'skills', 'git', 'commit'))

    const deepSkill = promptSkills.find(
      skill => skill.name === 'frontend:react:form',
    )
    assert.ok(deepSkill)
    assert.equal(
      deepSkill.skillRoot,
      join(configDir, '.openclaude', 'skills', 'frontend', 'react', 'form'),
    )
  } finally {
    try {
      restoreConfigDirEnv(originalConfigDir)
      setFsImplementation(originalFs)
      restoreSettingState(originalSettingsState)
      clearSkillAndConfigCaches()
      rmSync(configDir, { recursive: true, force: true })
    } finally {
      releaseSharedMutationLock()
    }
  }
})

test.serial('ignores legacy .claude project skills when .openclaude skills exist', async () => {
  await acquireSharedMutationLock('loadSkillsDir.test.ts')
  const configDir = mkdtempSync(join(tmpdir(), 'openclaude-skills-'))
  const cwd = join(configDir, 'workspace')
  const originalConfigDir = {
    openClaudeConfigDir: process.env.OPENCLAUDE_CONFIG_DIR,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
    configHomeOverride: getClaudeConfigHomeDirOverrideForTesting(),
  }
  const originalSettingsState = enableUserAndProjectSettingSources()
  const originalFs = setRealFilesystemForTest()

  try {
    mkdirSync(cwd, { recursive: true })
    writeSkill(cwd, 'shared', {
      configDirName: '.claude',
      description: 'legacy project skill',
    })
    writeSkill(cwd, 'shared', {
      configDirName: '.openclaude',
      description: 'native project skill',
    })

    setConfigDirEnv(configDir)
    clearSkillAndConfigCaches()

    const skills = await getSkillDirCommands(cwd)
    const sharedSkills = skills.filter(
      skill => skill.type === 'prompt' && skill.name === 'shared',
    )

    assert.equal(sharedSkills.length, 1)
    assert.equal(sharedSkills[0]?.type, 'prompt')
    assert.equal(sharedSkills[0]?.description, 'native project skill')
    assert.match(sharedSkills[0]?.skillRoot ?? '', /\.openclaude/)
  } finally {
    restoreConfigDirEnv(originalConfigDir)
    setFsImplementation(originalFs)
    try {
      clearSkillAndConfigCaches()
      restoreSettingState(originalSettingsState)
      rmSync(configDir, { recursive: true, force: true })
    } finally {
      releaseSharedMutationLock()
    }
  }
})

test.serial('loads persisted registry trust metadata from skill.json', async () => {
  await acquireSharedMutationLock('loadSkillsDir.test.ts')
  const configDir = mkdtempSync(join(tmpdir(), 'openclaude-skills-'))
  const cwd = join(configDir, 'workspace')
  const originalConfigDir = {
    openClaudeConfigDir: process.env.OPENCLAUDE_CONFIG_DIR,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
    configHomeOverride: getClaudeConfigHomeDirOverrideForTesting(),
  }
  const originalSettingsState = enableUserAndProjectSettingSources()
  const originalFs = setRealFilesystemForTest()

  try {
    mkdirSync(cwd, { recursive: true })
    const skillDir = join(cwd, '.openclaude', 'skills', 'registry-skill')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\ndescription: Registry skill\n---\n# Registry Skill\n`,
      'utf8',
    )
    writeFileSync(
      join(skillDir, 'skill.json'),
      JSON.stringify({ trust: 'official' }),
      'utf8',
    )

    setConfigDirEnv(configDir)
    clearSkillAndConfigCaches()

    const registrySkill = (await getSkillDirCommands(cwd)).find(skill =>
      isPromptSkillNamed(skill, 'registry-skill'),
    )

    assert.equal(registrySkill?.skillTrust, 'official')
  } finally {
    try {
      restoreConfigDirEnv(originalConfigDir)
      setFsImplementation(originalFs)
      restoreSettingState(originalSettingsState)
      clearSkillAndConfigCaches()
      rmSync(configDir, { recursive: true, force: true })
    } finally {
      releaseSharedMutationLock()
    }
  }
})

test.serial('project skills are ordered before user skills with the same name', async () => {
  await acquireSharedMutationLock('loadSkillsDir.test.ts')
  const configDir = mkdtempSync(join(tmpdir(), 'openclaude-skills-'))
  const cwd = join(configDir, 'workspace')
  const originalConfigDir = {
    openClaudeConfigDir: process.env.OPENCLAUDE_CONFIG_DIR,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
    configHomeOverride: getClaudeConfigHomeDirOverrideForTesting(),
  }
  const originalSettingsState = enableUserAndProjectSettingSources()
  const originalFs = setRealFilesystemForTest()

  try {
    mkdirSync(cwd, { recursive: true })
    setConfigDirEnv(configDir)
    const userConfigDir = getClaudeConfigHomeDir()
    writeUserSkill(userConfigDir, 'shared', 'user skill')
    writeSkill(cwd, 'shared', {
      configDirName: '.openclaude',
      description: 'project skill',
    })

    clearSkillAndConfigCaches()

    const sharedSkills = (await getSkillDirCommands(cwd))
      .filter(skill => isPromptSkillNamed(skill, 'shared'))
      .map(skill => ({
        description: skill.description,
        source: skill.source,
        skillRoot: skill.skillRoot,
      }))

    assert.deepEqual(sharedSkills, [
      {
        description: 'project skill',
        source: 'projectSettings',
        skillRoot: join(cwd, '.openclaude', 'skills', 'shared'),
      },
      {
        description: 'user skill',
        source: 'userSettings',
        skillRoot: join(userConfigDir, 'skills', 'shared'),
      },
    ])
  } finally {
    try {
      restoreConfigDirEnv(originalConfigDir)
      setFsImplementation(originalFs)
      restoreSettingState(originalSettingsState)
      clearSkillAndConfigCaches()
      rmSync(configDir, { recursive: true, force: true })
    } finally {
      releaseSharedMutationLock()
    }
  }
})

test.serial('dynamic discovery checks .openclaude skill directories', async () => {
  await acquireSharedMutationLock('loadSkillsDir.test.ts')
  const originalFs = setRealFilesystemForTest()
  const originalArgv = [...process.argv]
  const originalClaudeCodeSimple = process.env.CLAUDE_CODE_SIMPLE
  const rootDir = mkdtempSync(join(tmpdir(), 'openclaude-skills-'))
  const cwd = join(rootDir, 'workspace')
  const featureDir = join(cwd, 'src', 'feature')

  try {
    process.argv = process.argv.filter(arg => arg !== '--bare')
    delete process.env.CLAUDE_CODE_SIMPLE
    mkdirSync(featureDir, { recursive: true })
    execFileSync('git', ['init'], { cwd, stdio: 'ignore' })
    writeSkill(featureDir, 'feature-skill', {
      configDirName: '.openclaude',
    })

    assert.deepEqual(getProjectSkillsPaths(featureDir), [
      join(featureDir, '.openclaude', 'skills'),
    ])
  } finally {
    try {
      process.argv = originalArgv
      if (originalClaudeCodeSimple === undefined) {
        delete process.env.CLAUDE_CODE_SIMPLE
      } else {
        process.env.CLAUDE_CODE_SIMPLE = originalClaudeCodeSimple
      }
      setFsImplementation(originalFs)
      clearDynamicSkills()
      rmSync(rootDir, { recursive: true, force: true })
    } finally {
      releaseSharedMutationLock()
    }
  }
})

// --- Sibling skills homes (~/.agents/skills, ~/.claude/skills) ---

type SiblingHomeFixture = {
  homeDir: string
  configDir: string
  cwd: string
}

function writeSiblingSkill(
  homeDir: string,
  homeDirName: '.agents' | '.claude',
  skillPath: string,
  frontmatter = `description: ${skillPath} from ${homeDirName}`,
): string {
  const skillDir = join(homeDir, homeDirName, 'skills', ...skillPath.split('/'))
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\n${frontmatter}\n---\n# ${skillPath}\n`,
    'utf8',
  )
  return skillDir
}

function writeSettingsFile(path: string, settings: object): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(settings), 'utf8')
  clearSkillAndConfigCaches()
}

function promptSkillsNamed(
  skills: Command[],
  name: string,
): Extract<Command, { type: 'prompt' }>[] {
  return skills.filter((skill): skill is Extract<Command, { type: 'prompt' }> =>
    isPromptSkillNamed(skill, name),
  )
}

async function withSiblingHomeFixture(
  run: (fixture: SiblingHomeFixture) => Promise<void>,
): Promise<void> {
  await acquireSharedMutationLock('loadSkillsDir.test.ts')
  const rootDir = mkdtempSync(join(tmpdir(), 'openclaude-sibling-skills-'))
  const homeDir = join(rootDir, 'home')
  const configDir = join(homeDir, '.openclaude')
  // Inside the fake home so project-dir traversal stops at it.
  const cwd = join(homeDir, 'workspace')
  const originalConfigDir = {
    openClaudeConfigDir: process.env.OPENCLAUDE_CONFIG_DIR,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
    configHomeOverride: getClaudeConfigHomeDirOverrideForTesting(),
  }
  const originalOriginalCwd = getOriginalCwd()
  const originalSettingsState = enableUserAndProjectSettingSources()
  const originalFs = setRealFilesystemForTest()

  try {
    mkdirSync(cwd, { recursive: true })
    mkdirSync(configDir, { recursive: true })
    setSiblingSkillsHomeDirForTesting(homeDir)
    setConfigDirEnv(configDir)
    setOriginalCwd(cwd)
    clearSkillAndConfigCaches()
    await run({ homeDir, configDir, cwd })
  } finally {
    try {
      setSiblingSkillsHomeDirForTesting(undefined)
      restoreConfigDirEnv(originalConfigDir)
      setOriginalCwd(originalOriginalCwd)
      setFsImplementation(originalFs)
      restoreSettingState(originalSettingsState)
      clearDynamicSkills()
      clearSkillAndConfigCaches()
      rmSync(rootDir, { recursive: true, force: true })
    } finally {
      releaseSharedMutationLock()
    }
  }
}

test.serial('loads ~/.agents/skills by default and keeps ~/.claude/skills opt-in', async () => {
  await withSiblingHomeFixture(async ({ homeDir }) => {
    writeSiblingSkill(homeDir, '.agents', 'agent-skill')
    writeSiblingSkill(homeDir, '.claude', 'claude-skill')

    const skills = await getSkillDirCommands(join(homeDir, 'workspace'))
    const [agentSkill] = promptSkillsNamed(skills, 'agent-skill')

    assert.equal(agentSkill?.siblingSkillsHome, 'agents')
    assert.equal(agentSkill?.source, 'userSettings')
    assert.equal(agentSkill?.loadedFrom, 'skills')
    assert.equal(
      agentSkill?.skillRoot,
      join(homeDir, '.agents', 'skills', 'agent-skill'),
    )
    assert.deepEqual(promptSkillsNamed(skills, 'claude-skill'), [])

    const unloaded = await getUnloadedSiblingSkillHomes()
    assert.deepEqual(
      unloaded.map(({ home, count }) => ({ id: home.id, count })),
      [{ id: 'claude-code', count: 1 }],
    )
  })
})

test.serial('loads ~/.claude/skills after a user opt-in but not a project opt-in', async () => {
  await withSiblingHomeFixture(async ({ homeDir, configDir, cwd }) => {
    writeSiblingSkill(homeDir, '.claude', 'claude-skill')

    writeSettingsFile(join(cwd, '.openclaude', 'settings.json'), {
      claudeCodeSkillsEnabled: true,
    })
    // The project file is read, but a project cannot opt the user in.
    assert.equal(
      getSettingsForSource('projectSettings')?.claudeCodeSkillsEnabled,
      true,
    )
    assert.deepEqual(
      promptSkillsNamed(await getSkillDirCommands(cwd), 'claude-skill'),
      [],
    )

    writeSettingsFile(join(configDir, 'settings.json'), {
      claudeCodeSkillsEnabled: true,
    })
    const [claudeSkill] = promptSkillsNamed(
      await getSkillDirCommands(cwd),
      'claude-skill',
    )
    assert.equal(claudeSkill?.siblingSkillsHome, 'claude-code')
    assert.deepEqual(await getUnloadedSiblingSkillHomes(), [])
  })
})

test.serial('OpenClaude skills shadow sibling skills and the first sibling home wins', async () => {
  await withSiblingHomeFixture(async ({ homeDir, configDir, cwd }) => {
    writeSettingsFile(join(configDir, 'settings.json'), {
      claudeCodeSkillsEnabled: true,
    })
    writeUserSkill(configDir, 'shared', 'user skill')
    writeSkill(cwd, 'project-shared', { description: 'project skill' })
    writeSiblingSkill(homeDir, '.agents', 'shared')
    writeSiblingSkill(homeDir, '.agents', 'project-shared')
    writeSiblingSkill(homeDir, '.agents', 'both')
    writeSiblingSkill(homeDir, '.claude', 'both')
    writeSiblingSkill(homeDir, '.claude', 'shared')

    const skills = await getSkillDirCommands(cwd)
    const summarize = (name: string) =>
      promptSkillsNamed(skills, name).map(skill => ({
        description: skill.description,
        siblingSkillsHome: skill.siblingSkillsHome,
      }))

    assert.deepEqual(summarize('shared'), [
      { description: 'user skill', siblingSkillsHome: undefined },
    ])
    assert.deepEqual(summarize('project-shared'), [
      { description: 'project skill', siblingSkillsHome: undefined },
    ])
    assert.deepEqual(summarize('both'), [
      { description: 'both from .agents', siblingSkillsHome: 'agents' },
    ])
  })
})

test.serial('keeps the OpenClaude copy of a skill symlinked into a sibling home', async () => {
  await withSiblingHomeFixture(async ({ homeDir, configDir, cwd }) => {
    writeSettingsFile(join(configDir, 'settings.json'), {
      claudeCodeSkillsEnabled: true,
    })
    const agentsLinked = writeSiblingSkill(homeDir, '.agents', 'linked')
    mkdirSync(join(configDir, 'skills'), { recursive: true })
    symlinkSync(agentsLinked, join(configDir, 'skills', 'linked'), 'dir')

    // `npx skills` style: ~/.claude/skills/<name> -> ~/.agents/skills/<name>
    const agentsShared = writeSiblingSkill(homeDir, '.agents', 'npx-shared')
    mkdirSync(join(homeDir, '.claude', 'skills'), { recursive: true })
    symlinkSync(
      agentsShared,
      join(homeDir, '.claude', 'skills', 'npx-shared'),
      'dir',
    )

    const skills = await getSkillDirCommands(cwd)
    const linked = promptSkillsNamed(skills, 'linked')
    assert.equal(linked.length, 1)
    assert.equal(linked[0]?.siblingSkillsHome, undefined)
    assert.equal(linked[0]?.skillRoot, join(configDir, 'skills', 'linked'))

    const npxShared = promptSkillsNamed(skills, 'npx-shared')
    assert.equal(npxShared.length, 1)
    assert.equal(npxShared[0]?.siblingSkillsHome, 'agents')
  })
})

test.serial('skips sibling homes when disabled, without user settings, and in bare mode', async () => {
  await withSiblingHomeFixture(async ({ homeDir, configDir, cwd }) => {
    writeSiblingSkill(homeDir, '.agents', 'agent-skill')
    assert.equal(
      promptSkillsNamed(await getSkillDirCommands(cwd), 'agent-skill').length,
      1,
    )

    writeSettingsFile(join(configDir, 'settings.json'), {
      agentsSkillsEnabled: false,
    })
    assert.deepEqual(
      promptSkillsNamed(await getSkillDirCommands(cwd), 'agent-skill'),
      [],
    )

    writeSettingsFile(join(configDir, 'settings.json'), {})
    setAllowedSettingSources(['projectSettings', 'localSettings'])
    clearSkillAndConfigCaches()
    assert.deepEqual(
      promptSkillsNamed(await getSkillDirCommands(cwd), 'agent-skill'),
      [],
    )
    assert.deepEqual(await getUnloadedSiblingSkillHomes(), [])

    setAllowedSettingSources([
      'userSettings',
      'projectSettings',
      'localSettings',
      'flagSettings',
      'policySettings',
    ])
    process.env.CLAUDE_CODE_SIMPLE = '1'
    clearSkillAndConfigCaches()
    assert.deepEqual(
      promptSkillsNamed(await getSkillDirCommands(cwd), 'agent-skill'),
      [],
    )
  })
})

test.serial('stores conditional sibling skills until a matching path is touched', async () => {
  await withSiblingHomeFixture(async ({ homeDir, cwd }) => {
    writeSiblingSkill(
      homeDir,
      '.agents',
      'docs-only',
      'description: docs helper\npaths: docs/**',
    )

    const skills = await getSkillDirCommands(cwd)
    assert.deepEqual(promptSkillsNamed(skills, 'docs-only'), [])
    assert.equal(getConditionalSkillCount(), 1)
    assert.deepEqual(
      activateConditionalSkillsForPaths([join(cwd, 'docs', 'guide.md')], cwd),
      ['docs-only'],
    )
  })
})

for (const home of ['.agents', '.claude'] as const) {
  for (const invalidation of ['disable', 'edit', 'delete'] as const) {
    test.serial(`rejects obsolete ${home} reads after ${invalidation}`, async () => {
      await withSiblingHomeFixture(async ({ homeDir, configDir, cwd }) => {
        writeSettingsFile(join(configDir, 'settings.json'), {
          agentsSkillsEnabled: true, claudeCodeSkillsEnabled: true,
        })
        const dirs = ['pending-docs', 'always'].map(name => writeSiblingSkill(
          homeDir, home, name,
          `description: original${name === 'pending-docs' ? '\npaths: docs/**' : ''}`,
        ))
        const paths = dirs.map(dir => join(dir, 'SKILL.md'))
        const fs = getFsImplementation()
        let release!: () => void
        const held = new Promise<void>(resolve => { release = resolve })
        let entered!: () => void
        const reading = new Promise<void>(resolve => { entered = resolve })
        const captured = new Set<string>()
        setFsImplementation({ ...fs, readFile: async (path, options) => {
          const bytes = await fs.readFile(path, options)
          if (paths.includes(path) && !captured.has(path)) {
            captured.add(path)
            if (captured.size === paths.length) entered()
            await held
          }
          return bytes
        } })
        const oldScan = getSkillDirCommands(cwd)
        try {
          await reading
          if (invalidation === 'disable') {
            writeFileSync(join(configDir, 'settings.json'), JSON.stringify({
              agentsSkillsEnabled: false, claudeCodeSkillsEnabled: false,
            }))
            resetSettingsCache()
          } else if (invalidation === 'edit') {
            paths.forEach((path, i) => writeFileSync(path,
              `---\ndescription: revised${i === 0 ? '\npaths: docs/**' : ''}\n---\nRevised\n`))
          } else {
            dirs.forEach(dir => rmSync(dir, { recursive: true }))
          }
          const { reloadAfterSkillSourceSettingsChange } = await import('../utils/skills/skillChangeDetector.js')
          await reloadAfterSkillSourceSettingsChange()
          await getCommands(cwd) // Finish a fresh scan before the obsolete read.
          release()
          assert.deepEqual(promptSkillsNamed(await oldScan, 'always'), [])
          activateConditionalSkillsForPaths([join(cwd, 'docs', 'guide.md')], cwd)
          const commands = await getCommands(cwd)
          for (const name of ['pending-docs', 'always']) {
            const skills = promptSkillsNamed(commands, name)
            assert.equal(skills.length, invalidation === 'edit' ? 1 : 0, name)
            if (invalidation === 'edit') assert.equal(skills[0]?.description, 'revised')
          }
        } finally {
          release()
          await oldScan
          setFsImplementation(fs)
        }
      })
    })
  }

  for (const invalidation of ['disable', 'edit', 'delete'] as const) {
    test.serial(`refreshes completed ${home} scans invalidated during command aggregation (${invalidation})`, async () => {
      await withSiblingHomeFixture(async ({ homeDir, configDir, cwd }) => {
        writeSettingsFile(join(configDir, 'settings.json'), {
          agentsSkillsEnabled: true, claudeCodeSkillsEnabled: true,
        })
        const skillDir = writeSiblingSkill(homeDir, home, 'late-skill', 'description: original')
        let release!: () => void
        // Hold a different real command source after the sibling scan completes.
        getPluginCommands.cache.set(undefined, new Promise<Command[]>(resolve => {
          release = () => resolve([])
        }))
        const oldCommands = getCommands(cwd)
        try {
          assert.equal(promptSkillsNamed(await getSkillDirCommands(cwd), 'late-skill').length, 1)
          if (invalidation === 'disable') {
            writeSettingsFile(join(configDir, 'settings.json'), {
              agentsSkillsEnabled: false, claudeCodeSkillsEnabled: false,
            })
          } else if (invalidation === 'edit') {
            writeSiblingSkill(homeDir, home, 'late-skill', 'description: revised')
          } else {
            rmSync(skillDir, { recursive: true })
          }
          clearCommandsCache()
          const fresh = promptSkillsNamed(await getCommands(cwd), 'late-skill')
          assert.equal(fresh.length, invalidation === 'edit' ? 1 : 0)
          if (invalidation === 'edit') assert.equal(fresh[0]?.description, 'revised')
          release()
          assert.deepEqual(promptSkillsNamed(await oldCommands, 'late-skill'), fresh)
        } finally {
          release()
          await oldCommands
        }
      })
    })
  }

  test.serial(`reloads activated ${home} skills after disable, edit, and deletion`, async () => {
    await withSiblingHomeFixture(async ({ homeDir, configDir, cwd }) => {
      const settingKey = home === '.agents'
        ? 'agentsSkillsEnabled'
        : 'claudeCodeSkillsEnabled'
      writeSettingsFile(join(configDir, 'settings.json'), { [settingKey]: true })
      const skillDir = writeSiblingSkill(
        homeDir,
        home,
        'docs-only',
        'description: original\npaths: docs/**',
      )
      const { reloadAfterSkillSourceSettingsChange } = await import(
        '../utils/skills/skillChangeDetector.js'
      )
      const matchingPath = join(cwd, 'docs', 'guide.md')
      await getCommands(cwd)
      activateConditionalSkillsForPaths([matchingPath], cwd)
      assert.equal(
        promptSkillsNamed(await getCommands(cwd), 'docs-only').length,
        1,
      )

      writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ [settingKey]: false }))
      resetSettingsCache()
      await reloadAfterSkillSourceSettingsChange()
      assert.deepEqual(promptSkillsNamed(await getCommands(cwd), 'docs-only'), [])

      writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ [settingKey]: true }))
      resetSettingsCache()
      await reloadAfterSkillSourceSettingsChange()
      await getCommands(cwd)
      activateConditionalSkillsForPaths([matchingPath], cwd)
      writeSiblingSkill(
        homeDir, home, 'docs-only', 'description: revised\npaths: docs/**',
      )
      clearCommandsCache() // The same invalidation used by the file watcher.
      await getCommands(cwd)
      activateConditionalSkillsForPaths([matchingPath], cwd)
      assert.equal(
        promptSkillsNamed(await getCommands(cwd), 'docs-only')[0]?.description,
        'revised',
      )

      rmSync(skillDir, { recursive: true })
      clearCommandsCache()
      assert.deepEqual(promptSkillsNamed(await getCommands(cwd), 'docs-only'), [])
    })
  })
}

test.serial('live command refresh preserves activation and revokes disabled sibling sources', async () => {
  await withSiblingHomeFixture(async ({ homeDir, configDir, cwd }) => {
    const detector = await import('../utils/skills/skillChangeDetector.js')
    writeSettingsFile(join(configDir, 'settings.json'), {
      agentsSkillsEnabled: true,
      claudeCodeSkillsEnabled: true,
    })
    for (const [home, name] of [['.agents', 'agents-docs'], ['.claude', 'claude-docs']] as const) {
      writeSiblingSkill(homeDir, home, name, 'description: docs helper\npaths: docs/**')
    }
    writeUserSkill(configDir, 'owned-docs')
    writeFileSync(join(configDir, 'skills', 'owned-docs', 'SKILL.md'),
      '---\ndescription: owned helper\npaths: docs/**\n---\nOwned docs\n')
    const stdout = new PassThrough()
    const stdin = new PassThrough()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })
    let mounted = false
    const refreshed: Command[][] = []
    const onCommandsChange = (commands: Command[]) => { refreshed.push(commands) }
    function Harness() {
      useSkillsChange(cwd, onCommandsChange)
      React.useEffect(() => { mounted = true }, [])
      return null
    }
    async function waitFor(predicate: () => boolean) {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (predicate()) return
        await Bun.sleep(10)
      }
      assert.fail('Timed out waiting for live skill refresh')
    }
    try {
      await detector.resetForTesting()
      await detector.initialize()
      root.render(React.createElement(Harness))
      await waitFor(() => mounted)
      const names = ['agents-docs', 'claude-docs', 'owned-docs']
      const before = await getCommands(cwd)
      for (const name of names) assert.equal(promptSkillsNamed(before, name).length, 0)
      activateConditionalSkillsForPaths([join(cwd, 'docs', 'guide.md')], cwd)
      await waitFor(() => refreshed.length > 0)
      for (const name of names) {
        assert.equal(promptSkillsNamed(refreshed.at(-1)!, name).length, 1, name)
      }

      // A real source change still invalidates activated siblings before notifying
      // the same consumer. Owned dynamic skills must survive that refresh.
      writeSettingsFile(join(configDir, 'settings.json'), {
        agentsSkillsEnabled: false,
        claudeCodeSkillsEnabled: false,
      })
      resetSettingsCache()
      refreshed.length = 0
      await detector.reloadAfterSkillSourceSettingsChange()
      await waitFor(() => refreshed.length > 0)
      for (const name of names.slice(0, 2)) {
        assert.equal(promptSkillsNamed(refreshed.at(-1)!, name).length, 0, name)
      }
      assert.equal(promptSkillsNamed(refreshed.at(-1)!, 'owned-docs').length, 1)
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await detector.resetForTesting()
    }
  })
})

for (const mode of ['interactive', 'headless'] as const) {
  for (const source of ['userSettings', 'localSettings', 'flagSettings', 'policySettings', 'plugin-only'] as const) {
    test.serial(`${mode} accepted ${source} notifications reconcile sibling commands and watches`, async () => {
      await withSiblingHomeFixture(async ({ homeDir, configDir, cwd }) => {
        const detector = await import('../utils/skills/skillChangeDetector.js')
        const managedPath = getManagedFilePath()
        const dropInPath = getManagedSettingsDropInDir()
        const flagPath = getFlagSettingsPath()
        const managedDir = join(homeDir, 'managed')
        getManagedFilePath.cache.set(undefined, managedDir)
        getManagedSettingsDropInDir.cache.set(undefined, join(managedDir, 'managed-settings.d'))
        setFlagSettingsPath(join(homeDir, 'flags.json'))
        const settingsPath = source === 'userSettings' ? join(configDir, 'settings.json')
          : source === 'localSettings' ? join(cwd, '.openclaude', 'settings.local.json')
          : source === 'flagSettings' ? getFlagSettingsPath()!
          : join(managedDir, 'managed-settings.json')
        writeSettingsFile(settingsPath, {})
        writeSiblingSkill(homeDir, '.agents', 'agent-skill')
        writeSiblingSkill(homeDir, '.claude', 'claude-skill')
        const store = createStore(getDefaultAppState(), onChangeAppState)
        const apply = (changed: Parameters<typeof applySettingsChange>[0]) => applySettingsChange(changed, store.setState)
        const refreshed: Command[][] = []
        const onCommandsChange = (commands: Command[]) => { refreshed.push(commands) }
        const watched: Array<{ paths: string[]; watcher: ReturnType<typeof chokidar.watch> }> = []
        detector._setDependenciesForTesting({ watch: (paths, options) => {
          const watcher = chokidar.watch(paths, options)
          watched.push({ paths: typeof paths === 'string' ? [paths] : paths, watcher })
          return watcher
        } })
        let mounted = false
        function Harness() {
          useSettingsChange(apply)
          useSkillsChange(cwd, onCommandsChange)
          React.useEffect(() => { mounted = true }, [])
          return null
        }
        const stdout = new PassThrough()
        const stdin = new PassThrough()
        const root = await createRoot({
          stdout: stdout as unknown as NodeJS.WriteStream,
          stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false,
        })
        const unsubscribeSettings = mode === 'headless' ? settingsChangeDetector.subscribe(apply) : () => {}
        const unsubscribeSkills = mode === 'headless' ? detector.subscribe(() => {
          void getCommands(cwd).then(onCommandsChange)
        }) : () => {}
        async function waitFor(predicate: () => boolean) {
          for (let i = 0; i < 200; i++) {
            if (predicate()) return
            await Bun.sleep(10)
          }
          assert.fail('Timed out waiting for accepted settings refresh')
        }
        try {
          await detector.initialize()
          if (mode === 'interactive') {
            root.render(React.createElement(Harness))
            await waitFor(() => mounted)
          }
          assert.equal(promptSkillsNamed(await getCommands(cwd), 'agent-skill').length, 1)
          // No manual cache clear or skill reload: this is the real notifier and
          // settings consumer used by each session mode.
          writeFileSync(settingsPath, JSON.stringify(source === 'plugin-only'
            ? { strictPluginOnlyCustomization: ['skills'] }
            : { agentsSkillsEnabled: false, claudeCodeSkillsEnabled: true }))
          settingsChangeDetector.notifyChange(source === 'plugin-only' ? 'policySettings' : source)
          await waitFor(() => refreshed.length > 0)
          assert.equal(promptSkillsNamed(refreshed.at(-1)!, 'agent-skill').length, 0)
          assert.equal(promptSkillsNamed(refreshed.at(-1)!, 'claude-skill').length, source === 'plugin-only' ? 0 : 1)
          const activePaths = watched.filter(entry => !entry.watcher.closed).flatMap(entry => entry.paths)
          assert.equal(activePaths.includes(join(homeDir, '.agents', 'skills')), false)
          assert.equal(activePaths.includes(join(homeDir, '.claude', 'skills')), source !== 'plugin-only')
          if (source === 'plugin-only') assert.deepEqual(store.getState().settings.strictPluginOnlyCustomization, ['skills'])
          else assert.equal(store.getState().settings.agentsSkillsEnabled, false)
        } finally {
          root.unmount()
          stdin.end()
          stdout.end()
          unsubscribeSettings()
          unsubscribeSkills()
          await detector.resetForTesting()
          detector._setDependenciesForTesting()
          getManagedFilePath.cache.set(undefined, managedPath)
          getManagedSettingsDropInDir.cache.set(undefined, dropInPath)
          setFlagSettingsPath(flagPath)
        }
      })
    })
  }
}

for (const home of ['.agents', '.claude'] as const) {
  for (const layout of ['matching', 'renamed', 'nested'] as const) {
    test.serial(`${home} skills retain disabled owned name reservations (${layout})`, async () => {
      await withSiblingHomeFixture(async ({ homeDir, configDir, cwd }) => {
        writeSettingsFile(join(configDir, 'settings.json'), {
          agentsSkillsEnabled: true, claudeCodeSkillsEnabled: true,
        })
        const names = ['loop', 'reserved-owner', 'reserved-alias', 'reserved-display', 'free-skill']
        const folderName = (name: string) => layout === 'matching' ? name
          : layout === 'renamed' ? `renamed-${name}` : `category/${name}`
        const files = names.map(name => ({ name, file: join(
          writeSiblingSkill(homeDir, home, folderName(name)), 'SKILL.md',
        ) }))
        const freeName = folderName('free-skill').replace('/', ':')
        const moduleUrl = (path: string) => JSON.stringify(new URL(path, import.meta.url).href)
        // Isolate the bundled registry without changing another test's registrations.
        const script = `
          import assert from 'node:assert/strict'
          import { writeFileSync } from 'node:fs'
          import { clearCommandsCache, findCommand, getCommands } from ${moduleUrl('../commands.ts')}
          import { activateConditionalSkillsForPaths, clearDynamicSkills } from ${moduleUrl('./loadSkillsDir.ts')}
          import { setSiblingSkillsHomeDirForTesting } from ${moduleUrl('./siblingSkillHomes.ts')}
          import { enableUserAndProjectSettingSources } from ${moduleUrl('../test/settingSourceState.ts')}
          import { setOriginalCwd } from ${moduleUrl('../bootstrap/state.ts')}
          import { registerLoopSkill } from ${moduleUrl('./bundled/loop.ts')}
          import { getBundledSkills, registerBundledSkill } from ${moduleUrl('./bundledSkills.ts')}
          enableUserAndProjectSettingSources()
          setOriginalCwd(${JSON.stringify(cwd)})
          setSiblingSkillsHomeDirForTesting(${JSON.stringify(homeDir)})
          registerLoopSkill()
          registerBundledSkill({ name: 'reserved-owner', aliases: ['reserved-alias'],
            description: 'disabled owner', isEnabled: () => false,
            getPromptForCommand: async () => [] })
          getBundledSkills().find(skill => skill.name === 'reserved-owner').userFacingName = () => 'reserved-display'
          assert.equal(getBundledSkills().find(skill => skill.name === 'loop').isEnabled(), false)
          for (const builtins of [true, false]) {
            for (const conditional of [false, true]) {
              clearDynamicSkills()
              clearCommandsCache()
              for (const { name, file } of ${JSON.stringify(files)}) {
                writeFileSync(file, '---\\ndescription: sibling\\n' + (${JSON.stringify(layout)} === 'matching' ? '' : 'name: ' + name + '\\n') + (conditional ? 'paths: docs/**\\n' : '') + '---\\nSkill\\n')
              }
              const initial = await getCommands(${JSON.stringify(cwd)})
              // No available built-ins exercises the append branch. Only this
              // isolated child changes availability; registered owners stay put.
              if (!builtins) for (const command of initial) {
                if (!command.siblingSkillsHome) command.isEnabled = () => false
              }
              if (conditional) activateConditionalSkillsForPaths([${JSON.stringify(join(cwd, 'docs', 'guide.md'))}], ${JSON.stringify(cwd)})
              const commands = await getCommands(${JSON.stringify(cwd)})
              const siblingNames = commands.filter(skill => skill.siblingSkillsHome).map(skill => skill.name)
              assert.deepEqual(siblingNames, [${JSON.stringify(freeName)}], JSON.stringify({ builtins, conditional }))
              for (const reserved of ${JSON.stringify(names.slice(0, -1))}) {
                assert.equal(findCommand(reserved, commands), undefined, reserved)
              }
              assert.equal(findCommand('free-skill', commands)?.name, ${JSON.stringify(freeName)})
            }
          }
        `
        execFileSync(process.execPath, ['-e', script], {
          env: { ...process.env, CLAUDE_CODE_DISABLE_CRON: '1' }, timeout: 15_000,
        })
      })
    }, 30_000)
  }
}

for (const layout of ['renamed', 'nested'] as const) {
  for (const conditionalHome of ['neither', '.agents', '.claude'] as const) {
    test.serial(`cross-home invocation priority survives ${layout} folders and ${conditionalHome} activation`, async () => {
      await withSiblingHomeFixture(async ({ homeDir, configDir, cwd }) => {
        writeSettingsFile(join(configDir, 'settings.json'), {
          agentsSkillsEnabled: true, claudeCodeSkillsEnabled: true,
        })
        const agentsName = layout === 'renamed' ? 'renamed-shared' : 'category/shared'
        for (const home of ['.agents', '.claude'] as const) {
          writeSiblingSkill(homeDir, home, home === '.agents' ? agentsName : 'shared',
            `name: shared\ndescription: ${home} instructions${conditionalHome === home ? '\npaths: docs/**' : ''}`)
        }
        writeSiblingSkill(homeDir, '.claude', 'claude-only', 'description: nonconflicting control\npaths: docs/**')
        const before = await getCommands(cwd)
        const beforeWinner = findCommand('shared', before)
        assert.equal(beforeWinner?.type === 'prompt' ? beforeWinner.siblingSkillsHome : undefined,
          conditionalHome === '.agents' ? undefined : 'agents')
        assert.equal(before.some(c => c.type === 'prompt' && c.siblingSkillsHome === 'claude-code' && c.name === 'shared'), false)

        activateConditionalSkillsForPaths([join(cwd, 'docs', 'guide.md')], cwd)
        const after = await getCommands(cwd)
        const winner = findCommand('shared', after)
        assert.equal(winner?.type === 'prompt' ? winner.siblingSkillsHome : undefined, 'agents')
        assert.equal(winner?.name, agentsName.replace('/', ':'))
        const siblings = after.filter(c => c.type === 'prompt' && c.siblingSkillsHome)
        assert.equal(siblings.length, 2)
        assert.equal(findCommand('claude-only', siblings)?.description, 'nonconflicting control')
        const listing = formatCommandsWithinBudget(siblings)
        assert.ok(listing.includes(`- ${winner!.name}: .agents instructions`))
        assert.ok(!listing.includes('.claude instructions'))
        // Every advertised canonical identifier selects those same instructions.
        for (const listed of siblings) assert.equal(findCommand(listed.name, after), listed)
      })
    })
  }
}

for (const home of ['.agents', '.claude'] as const) {
  test.serial(`${home} linked target edits refresh invoked content and obey source lifetime`, async () => {
    await withSiblingHomeFixture(async ({ homeDir, configDir, cwd }) => {
      const detector = await import('../utils/skills/skillChangeDetector.js')
      const settingKey = home === '.agents' ? 'agentsSkillsEnabled' : 'claudeCodeSkillsEnabled'
      writeSettingsFile(join(configDir, 'settings.json'), {
        agentsSkillsEnabled: false, claudeCodeSkillsEnabled: false, [settingKey]: true,
      })
      const target = join(homeDir, 'external-linked-skill')
      mkdirSync(target)
      const targetFile = join(target, 'SKILL.md')
      writeFileSync(targetFile, '---\ndescription: initial linked\n---\nInstructions initial linked\n')
      const plainFile = join(writeSiblingSkill(homeDir, home, 'plain'), 'SKILL.md')
      symlinkSync(target, join(homeDir, home, 'skills', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
      const ready: Promise<void>[] = []
      await detector.resetForTesting({
        stabilityThreshold: 10, pollInterval: 10, chokidarInterval: 10,
        reloadDebounce: 10, reloadCooldown: 10,
      })
      detector._setDependenciesForTesting({
        executeConfigChangeHooks: async () => [],
        watch: (paths, options) => {
          const watcher = chokidar.watch(paths, options)
          ready.push(new Promise(resolve => watcher.once('ready', resolve)))
          return watcher
        },
      })
      let notifications = 0
      const unsubscribe = detector.subscribe(() => { notifications++ })
      async function invokedText(name: string): Promise<string> {
        const command = findCommand(name, await getCommands(cwd))
        assert.ok(command?.type === 'prompt')
        // These real skill bodies contain no shell substitutions/context access.
        return JSON.stringify(await command.getPromptForCommand('', {} as never))
      }
      async function editUntilRefreshed(file: string, name: string, marker: string) {
        const before = notifications
        const deadline = Date.now() + 2500
        let edit = 0
        while (Date.now() < deadline) {
          writeFileSync(file, `---\ndescription: ${marker}\n---\nInstructions ${marker} ${edit++}\n`)
          await Bun.sleep(50)
          if (notifications > before && (await invokedText(name)).includes(marker)) return
        }
        assert.fail(`No refreshed invocation for ${name}: ${marker}`)
      }
      try {
        await detector.initialize()
        await Promise.all(ready)
        assert.ok((await invokedText('linked')).includes('Instructions initial linked'))
        await editUntilRefreshed(plainFile, 'plain', 'plain control')
        await editUntilRefreshed(targetFile, 'linked', 'revised linked')

        writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ [settingKey]: false }))
        resetSettingsCache()
        await detector.reloadAfterSkillSourceSettingsChange()
        const disabledCount = notifications
        writeFileSync(targetFile, '---\ndescription: disabled edit\n---\nInstructions disabled edit\n')
        await Bun.sleep(150)
        assert.equal(notifications, disabledCount)
        assert.equal(findCommand('linked', await getCommands(cwd)), undefined)

        writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ [settingKey]: true }))
        resetSettingsCache()
        await detector.reloadAfterSkillSourceSettingsChange()
        await Promise.all(ready)
        await editUntilRefreshed(targetFile, 'linked', 're-enabled linked')
        await detector.dispose()
        const disposedCount = notifications
        writeFileSync(targetFile, '---\ndescription: disposed edit\n---\nDisposed\n')
        await Bun.sleep(150)
        assert.equal(notifications, disposedCount)
      } finally {
        unsubscribe()
        await detector.resetForTesting()
        detector._setDependenciesForTesting()
      }
    })
  }, 15_000)
}

test.serial('conditional siblings cannot replace dynamically discovered project skills', async () => {
  await withSiblingHomeFixture(async ({ homeDir, cwd }) => {
    for (const siblingFirst of [false, true]) {
      clearDynamicSkills()
      clearCommandsCache()
      writeSiblingSkill(
        homeDir, '.agents', 'shared', 'description: sibling\npaths: docs/**',
      )
      const nestedDir = join(cwd, 'nested')
      writeSkill(nestedDir, 'shared', { description: 'project winner' })
      await getCommands(cwd)
      const activate = () => activateConditionalSkillsForPaths(
        [join(cwd, 'docs', 'guide.md')], cwd,
      )
      if (siblingFirst) activate()
      await addSkillDirectories(
        await discoverSkillDirsForPaths([join(nestedDir, 'other.ts')], cwd),
      )
      if (!siblingFirst) activate()
      assert.equal(
        promptSkillsNamed(await getCommands(cwd), 'shared')[0]?.description,
        'project winner',
      )
      clearCommandsCache()
      assert.equal(
        promptSkillsNamed(await getCommands(cwd), 'shared')[0]?.description,
        'project winner',
      )
    }
  })
})

test.serial('the watcher applies the loader user-source, bare, and plugin-only gates', async () => {
  await withSiblingHomeFixture(async ({ homeDir }) => {
    const detector = await import('../utils/skills/skillChangeDetector.js')
    writeSiblingSkill(homeDir, '.agents', 'agent-skill')
    const watched: string[] = []
    detector._setDependenciesForTesting({
      getSkillsPath: () => '',
      getAdditionalDirectoriesForClaudeMd: () => [],
      watch: (paths, options) => {
        watched.push(...(typeof paths === 'string' ? [paths] : paths))
        return chokidar.watch(paths, options)
      },
    })
    try {
      for (const gate of ['user-source', 'bare', 'plugin-only', 'enabled']) {
        await detector.resetForTesting()
        watched.length = 0
        delete process.env.CLAUDE_CODE_SIMPLE
        setAllowedSettingSources([
          'userSettings', 'projectSettings', 'localSettings',
        ])
        resetSettingsCache()
        if (gate === 'user-source') setAllowedSettingSources(['projectSettings'])
        if (gate === 'bare') process.env.CLAUDE_CODE_SIMPLE = '1'
        if (gate === 'plugin-only') {
          setCachedSettingsForSource('policySettings', {
            strictPluginOnlyCustomization: ['skills'],
          })
        }
        await detector.initialize()
        assert.equal(
          watched.includes(join(homeDir, '.agents', 'skills')),
          gate === 'enabled',
          gate,
        )
      }
    } finally {
      await detector.resetForTesting()
      detector._setDependenciesForTesting()
    }
  })
})
