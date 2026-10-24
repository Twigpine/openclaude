import { expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, join } from 'path'

test('filesystem discovery matches Git ceilings, including changes to cached boundaries', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-ceiling-')))
  const cwd = join(root, 'nested', 'cwd')
  const alias = join(root, 'alias')
  try {
    mkdirSync(cwd, { recursive: true })
    execFileSync('git', ['init', '-b', 'main', root])
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const settings = [
      null,
      root,
      cwd, // Git never excludes the starting directory.
      join(root, 'nested'),
      `relative${delimiter}${root}`,
      `${join(root, 'missing')}${delimiter}${root}`,
      alias, // Resolve symlinked ceilings as Git does.
      `${delimiter}${root}`, // Empty entries disable subsequent symlink resolution.
      null, // Revisit the original cached result.
    ]
    const expected = settings.map(setting => {
      const env = { ...process.env }
      if (setting === null) delete env.GIT_CEILING_DIRECTORIES
      else env.GIT_CEILING_DIRECTORIES = setting
      const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
        cwd, env, encoding: 'utf8', timeout: 5_000,
      })
      expect(result.error).toBeUndefined()
      expect([0, 128]).toContain(result.status)
      return result.status === 0 ? realpathSync(result.stdout.trim()) : null
    })
    expect(expected).toEqual([root, null, root, null, null, null, null, null, root])
    const stdout = execFileSync(process.execPath, [
      'run', join(import.meta.dir, 'git.ceiling.fixture.ts'), cwd, JSON.stringify(settings),
    ], { encoding: 'utf8', timeout: 30_000 })
    expect(JSON.parse(stdout)).toEqual(expected)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  // Leave time beyond the child deadline for Git setup, assertions and cleanup.
}, { timeout: 60_000 })
