import { expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, join } from 'path'
import { snapshotEnv } from '../test/envSnapshot.js'
import { gitFixtureEnv } from '../test/gitEnv.js'

test.each([false, true])('filesystem discovery matches Git ceilings, including cached boundary changes (inherited repository variables: %s)', inheritedRepository => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-ceiling-')))
  const cwd = join(root, 'nested', 'cwd')
  const alias = join(root, 'alias')
  const inheritedEnv = {
    GIT_DIR: join(root, 'unexpected.git'),
    GIT_WORK_TREE: join(root, 'unexpected-worktree'),
    GIT_INDEX_FILE: join(root, 'unexpected-index'),
    GIT_COMMON_DIR: join(root, 'unexpected-common'),
  }
  const restoreEnv = snapshotEnv(Object.keys(inheritedEnv))
  try {
    if (inheritedRepository) Object.assign(process.env, inheritedEnv)
    const gitEnv = gitFixtureEnv()
    mkdirSync(cwd, { recursive: true })
    execFileSync('git', ['init', '-b', 'main', root], { env: gitEnv })
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
      `${delimiter}${root}/.`, // Git preserves the dot suffix after an empty entry.
      `${root}/.`, // Without an empty entry, Git canonicalizes the same suffix.
      null, // Revisit the original cached result.
    ]
    const expected = settings.map(setting => {
      const env = { ...gitEnv }
      if (setting === null) delete env.GIT_CEILING_DIRECTORIES
      else env.GIT_CEILING_DIRECTORIES = setting
      const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
        cwd, env, encoding: 'utf8', timeout: 5_000,
      })
      expect(result.error).toBeUndefined()
      expect(result.status === 0 || result.status === 128).toBe(true)
      return result.status === 0 ? realpathSync(result.stdout.trim()) : null
    })
    expect(expected).toEqual([root, null, root, null, null, null, null, null, root, null, root])
    const stdout = execFileSync(process.execPath, [
      'run', join(import.meta.dir, 'git.ceiling.fixture.ts'), cwd, JSON.stringify(settings),
    ], { encoding: 'utf8', timeout: 30_000, env: gitEnv })
    expect(JSON.parse(stdout)).toEqual(expected)
  } finally {
    restoreEnv()
    rmSync(root, { recursive: true, force: true })
  }
  // Leave time beyond the child deadline for Git setup, assertions and cleanup.
}, { timeout: 60_000 })
