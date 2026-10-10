/**
 * duo — access to installed skills.
 *
 * Lets a debate run under a skill: `/duo skills` lists what is installed and
 * `/duo skill <name> <question>` feeds the skill text to both debaters, so
 * skills such as `tdd`, `grill-with-docs` or `code-review` apply inside the
 * debate instead of being retyped by hand.
 *
 * Discovery mirrors the repo's own loader (src/skills/loadSkillsDir.ts):
 * a skill is identified by its DIRECTORY name, nested `category/skill`
 * layouts are supported, and a SKILL.md without frontmatter `name` is still a
 * valid skill. Only the user and project roots are covered — that is where
 * `openclaude skills install --global` and project installs land.
 */

import { readdir, readFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { parseFrontmatter } from '../../utils/frontmatterParser.js'

export type DuoSkillInfo = {
  /** Directory name — the identifier used everywhere else, like the loader. */
  name: string
  description: string
  file: string
}

/**
 * Skill roots in precedence order: project last, so it wins (both for the
 * listing and for reads).
 */
export function duoSkillDirs(cwd: string): string[] {
  return [
    join(getClaudeConfigHomeDir(), 'skills'),
    join(cwd, '.openclaude', 'skills'),
  ]
}

/** Accept a skill name only if it can be a directory name, never a path. */
function isSafeSkillName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..') &&
    !name.includes('\0')
  )
}

/** Read a SKILL.md; description is optional, the directory name is the id. */
async function readSkillFile(file: string, name: string): Promise<DuoSkillInfo | null> {
  try {
    const raw = await readFile(file, 'utf-8')
    const { frontmatter } = parseFrontmatter(raw, file)
    const description =
      typeof frontmatter.description === 'string' ? frontmatter.description : ''
    return { name, description, file }
  } catch {
    return null
  }
}

/** SKILL.md files directly under a root, plus one nested category level. */
async function findSkillFiles(root: string): Promise<Array<{ name: string; file: string }>> {
  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const dirs = entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  const found: Array<{ name: string; file: string }> = []
  for (const dirName of dirs) {
    const direct = join(root, dirName, 'SKILL.md')
    if (await readSkillFile(direct, dirName)) {
      found.push({ name: dirName, file: direct })
      continue
    }
    let nested: Dirent[]
    try {
      nested = await readdir(join(root, dirName), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of nested) {
      if (!entry.isDirectory()) continue
      const nestedFile = join(root, dirName, entry.name, 'SKILL.md')
      if (await readSkillFile(nestedFile, entry.name)) {
        found.push({ name: entry.name, file: nestedFile })
      }
    }
  }
  return found
}

/** Every installed skill, sorted by name; project skills override user ones. */
export async function listDuoSkills(cwd: string): Promise<DuoSkillInfo[]> {
  const found = new Map<string, DuoSkillInfo>()
  for (const root of duoSkillDirs(cwd)) {
    for (const candidate of await findSkillFiles(root)) {
      const info = await readSkillFile(candidate.file, candidate.name)
      if (info) found.set(info.name, info)
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Raw SKILL.md text for one skill (frontmatter included), or null. */
export async function readDuoSkill(
  name: string,
  cwd: string,
): Promise<string | null> {
  if (!isSafeSkillName(name)) return null
  // Reverse order: project wins, matching the listing's precedence.
  for (const root of [...duoSkillDirs(cwd)].reverse()) {
    for (const candidate of await findSkillFiles(root)) {
      if (candidate.name !== name) continue
      try {
        const raw = await readFile(candidate.file, 'utf-8')
        if (raw.trim()) return raw
      } catch {
        continue
      }
    }
  }
  return null
}

/**
 * Wrap a question with the skill text both debaters must follow.
 * Pure so the shape is testable without touching the filesystem.
 */
export function composeSkillQuestion(
  skillName: string,
  skillText: string,
  question: string,
): string {
  return [
    `<skill name="${skillName}">`,
    skillText.trim(),
    '</skill>',
    '',
    `Apply the skill above to the following question:`,
    question,
  ].join('\n')
}