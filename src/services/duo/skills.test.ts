import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeSkillQuestion } from './skills.js'

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'duo-skills-'))
  // Unique name: real skills are installed in ~/.openclaude/skills and are
  // searched first, so a generic name like `tdd` would read those instead.
  const skillDir = join(dir, '.openclaude', 'skills', 'duo-fixture-skill')
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    join(skillDir, 'SKILL.md'),
    '---\nname: duo-fixture-skill\ndescription: Fixture skill for duo tests.\n---\n\nFixture body marker 12345.\n',
    'utf-8',
  )
  return dir
}

describe('composeSkillQuestion', () => {
  test('wraps the skill and the question', () => {
    const out = composeSkillQuestion('tdd', 'Always red first.', 'add a parser')
    expect(out).toContain('<skill name="tdd">')
    expect(out).toContain('Always red first.')
    expect(out).toContain('</skill>')
    expect(out.endsWith('add a parser')).toBe(true)
  })
})

describe('skill discovery on disk', () => {
  test('reads a skill installed in the project directory', async () => {
    const { listDuoSkills, readDuoSkill } = await import('./skills.js')
    const dir = await fixture()
    try {
      const skills = await listDuoSkills(dir)
      expect(skills.map(s => s.name)).toContain('duo-fixture-skill')
      expect(skills.find(s => s.name === 'duo-fixture-skill')?.description).toBe(
        'Fixture skill for duo tests.',
      )
      const text = await readDuoSkill('duo-fixture-skill', dir)
      expect(text).toContain('Fixture body marker 12345.')
      expect(await readDuoSkill('does-not-exist', dir)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rejects path traversal in a skill name', async () => {
    const { readDuoSkill } = await import('./skills.js')
    const dir = await fixture()
    try {
      expect(await readDuoSkill('../../etc', dir)).toBeNull()
      expect(await readDuoSkill('a/b', dir)).toBeNull()
      expect(await readDuoSkill('a\0b', dir)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('identified by directory name, not frontmatter name', async () => {
    const { listDuoSkills, readDuoSkill } = await import('./skills.js')
    const dir = await mkdtemp(join(tmpdir(), 'duo-skills-'))
    const skillDir = join(dir, '.openclaude', 'skills', 'dir-name-wins')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: frontmatter-name\ndescription: Mismatch on purpose.\n---\n\nBody marker 999.\n',
      'utf-8',
    )
    try {
      const names = (await listDuoSkills(dir)).map(s => s.name)
      expect(names).toContain('dir-name-wins')
      expect(names).not.toContain('frontmatter-name')
      expect(await readDuoSkill('dir-name-wins', dir)).toContain('Body marker 999.')
      expect(await readDuoSkill('frontmatter-name', dir)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('a SKILL.md without frontmatter is still listed and readable', async () => {
    const { listDuoSkills, readDuoSkill } = await import('./skills.js')
    const dir = await mkdtemp(join(tmpdir(), 'duo-skills-'))
    const skillDir = join(dir, '.openclaude', 'skills', 'no-frontmatter')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), 'Just a body, no frontmatter.\n', 'utf-8')
    try {
      const skills = await listDuoSkills(dir)
      expect(skills.map(s => s.name)).toContain('no-frontmatter')
      expect(skills.find(s => s.name === 'no-frontmatter')?.description).toBe('')
      expect(await readDuoSkill('no-frontmatter', dir)).toContain('no frontmatter')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('nested category/skill layout is discovered', async () => {
    const { listDuoSkills, readDuoSkill } = await import('./skills.js')
    const dir = await mkdtemp(join(tmpdir(), 'duo-skills-'))
    const nested = join(dir, '.openclaude', 'skills', 'engineering', 'nested-skill')
    await mkdir(nested, { recursive: true })
    await writeFile(
      join(nested, 'SKILL.md'),
      '---\nname: nested-skill\ndescription: Nested under a category.\n---\n\nNested body marker 777.\n',
      'utf-8',
    )
    try {
      expect((await listDuoSkills(dir)).map(s => s.name)).toContain('nested-skill')
      expect(await readDuoSkill('nested-skill', dir)).toContain('Nested body marker 777.')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})