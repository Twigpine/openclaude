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
import { test } from 'bun:test'
import chokidar from 'chokidar'
import { clearCommandsCache, getCommands } from '../commands.js'

import {
  getOriginalCwd,
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
