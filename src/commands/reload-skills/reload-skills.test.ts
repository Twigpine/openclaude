import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { clearSkillCaches } from '../../skills/loadSkillsDir.js'
import type { LocalJSXCommandContext } from '../../types/command.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import {
  getCwdState,
  getProjectRoot,
  setCwdState,
  setProjectRoot,
} from '../../bootstrap/state.js'
import { call } from './reload-skills.js'

const context = {} as LocalJSXCommandContext

function writeSkill(configDir: string, name: string): void {
  const dir = join(configDir, 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: test skill ${name}\n---\nbody\n`,
  )
}

describe('/reload-skills', () => {
  let configDir: string
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(async () => {
    await acquireSharedMutationLock('commands/reload-skills.test.ts')
    configDir = mkdtempSync(join(tmpdir(), 'oc-reload-skills-'))
    process.env.CLAUDE_CONFIG_DIR = configDir
    setClaudeConfigHomeDirForTesting(configDir)
    clearSkillCaches()
  })

  afterEach(() => {
    try {
      if (originalConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalConfigDir
      }
      setClaudeConfigHomeDirForTesting(undefined)
      clearSkillCaches()
    } finally {
      const dir = configDir
      try {
        rmSync(dir, { recursive: true, force: true })
      } finally {
        releaseSharedMutationLock()
      }
    }
  })

  it('reports a newly added skill after reload', async () => {
    writeSkill(configDir, 'skill-one')
    await call('', context)

    writeSkill(configDir, 'skill-two')
    const second = await call('', context)
    expect(second.type).toBe('text')
    if (second.type === 'text') {
      expect(second.value).toContain('1 added')
      expect(second.value).toContain('skill-two')
    }
  })

  it('reports a removed skill after reload', async () => {
    writeSkill(configDir, 'skill-gone')
    await call('', context)

    rmSync(join(configDir, 'skills', 'skill-gone'), {
      recursive: true,
      force: true,
    })
    const result = await call('', context)
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('1 removed')
      expect(result.value).toContain('skill-gone')
    }
  })

  it('scans project skills from the project root after /cd', async () => {
    // After /cd the working dir differs from the project root. The scan must
    // stay anchored to the project root — the same root prefetch and session
    // identity use — so a skill under the new cwd is out of scope and a new
    // skill under the project root is picked up.
    const projectDir = mkdtempSync(join(tmpdir(), 'oc-proj-'))
    const workDir = mkdtempSync(join(tmpdir(), 'oc-work-'))
    mkdirSync(join(projectDir, '.git'))
    mkdirSync(join(workDir, '.git'))
    const projectSkill = join(
      projectDir,
      '.openclaude',
      'skills',
      'proj-skill',
    )
    const workSkill = join(workDir, '.openclaude', 'skills', 'work-skill')
    mkdirSync(projectSkill, { recursive: true })
    mkdirSync(workSkill, { recursive: true })
    writeFileSync(
      join(projectSkill, 'SKILL.md'),
      '---\nname: proj-skill\ndescription: p\n---\nbody\n',
    )
    writeFileSync(
      join(workSkill, 'SKILL.md'),
      '---\nname: work-skill\ndescription: w\n---\nbody\n',
    )

    const prevRoot = getProjectRoot()
    const prevCwd = getCwdState()
    try {
      setProjectRoot(projectDir)
      setCwdState(workDir)
      clearSkillCaches()
      await call('', context)

      const newSkill = join(projectDir, '.openclaude', 'skills', 'new-skill')
      mkdirSync(newSkill, { recursive: true })
      writeFileSync(
        join(newSkill, 'SKILL.md'),
        '---\nname: new-skill\ndescription: n\n---\nbody\n',
      )
      const second = await call('', context)
      expect(second.type).toBe('text')
      if (second.type === 'text') {
        expect(second.value).toContain('1 added')
        expect(second.value).toContain('new-skill')
      }
    } finally {
      setProjectRoot(prevRoot)
      setCwdState(prevCwd)
      clearSkillCaches()
      rmSync(projectDir, { recursive: true, force: true })
      rmSync(workDir, { recursive: true, force: true })
    }
  })
})
