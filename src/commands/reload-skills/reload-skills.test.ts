import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { LocalJSXCommandContext } from '../../types/command.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
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
  })

  afterEach(() => {
    try {
      if (originalConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalConfigDir
      }
      setClaudeConfigHomeDirForTesting(undefined)
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
})
