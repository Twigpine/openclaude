import { expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { snapshotEnv } from '../test/envSnapshot.js'
import { gitFixtureEnv } from '../test/gitEnv.js'

// Regression for #2052 — sessions started in a non-git parent of multiple
// child repos must still be able to create agent worktrees when cwd points
// at a child repository.

function git(cwd: string, ceiling: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...gitFixtureEnv(),
      GIT_CEILING_DIRECTORIES: ceiling,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim()
}

const FIXTURE = join(import.meta.dir, 'worktree.multiRepoParent.fixture.ts')

function runCreateAgentWorktree(
  ceiling: string,
  cfgDir: string,
  targetCwd: string,
  name: string,
):
  | { ok: true; worktreePath: string; gitRoot: string | null }
  | { ok: false; error: string; gitRoot: string | null } {
  const stdout = execFileSync(
    process.execPath,
    ['run', FIXTURE, cfgDir, targetCwd, name],
    {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...gitFixtureEnv(), GIT_CEILING_DIRECTORIES: ceiling },
    },
  )
  return JSON.parse(stdout) as
    | { ok: true; worktreePath: string; gitRoot: string | null }
    | { ok: false; error: string; gitRoot: string | null }
}

test.each([
  ['none', false],
  ['writable', false],
  ['read-only', false],
  ['read-only', true],
] as const)(
  'createAgentWorktree fails for a non-git multi-repo parent, succeeds for a child repo cwd (enclosing repo: %s, inherited repository variables: %s)',
  (enclosing, inheritedRepository) => {
    const root = mkdtempSync(join(tmpdir(), 'openclaude-2052-'))
    const cfgDir = join(root, 'config')
    const parent = join(root, 'parent')
    const repoA = join(parent, 'repo-a')
    const repoB = join(parent, 'repo-b')
    const inheritedEnv = {
      GIT_DIR: join(root, 'unexpected.git'),
      GIT_WORK_TREE: join(root, 'unexpected-worktree'),
      GIT_INDEX_FILE: join(root, 'unexpected-index'),
      GIT_COMMON_DIR: join(root, 'unexpected-common'),
    }
    const restoreEnv = snapshotEnv(Object.keys(inheritedEnv))

    try {
      if (inheritedRepository) Object.assign(process.env, inheritedEnv)
      mkdirSync(repoA, { recursive: true })
      mkdirSync(repoB, { recursive: true })
      mkdirSync(cfgDir)

      // Always exercise the enclosing-repository case, even on a clean host.
      // The ceiling confines both filesystem discovery and real Git children.
      if (enclosing !== 'none') {
        git(root, root, 'init', '-b', 'main')
        if (enclosing === 'read-only') chmodSync(join(root, '.git'), 0o555)
      }

      for (const repo of [repoA, repoB]) {
        git(repo, root, 'init', '-b', 'main')
        writeFileSync(join(repo, 'README.md'), `${repo}\n`)
        git(repo, root, 'add', '.')
        git(repo, root, 'commit', '-m', 'init')
      }

      const parentResult = runCreateAgentWorktree(
        root,
        cfgDir,
        parent,
        'issue-2052-parent',
      )
      expect(parentResult.ok).toBe(false)
      if (!parentResult.ok) {
        expect(parentResult.gitRoot).toBeNull()
        expect(parentResult.error).toContain(
          'Cannot create agent worktree: not in a git repository',
        )
      }

      const childResult = runCreateAgentWorktree(
        root,
        cfgDir,
        repoA,
        'issue-2052-child',
      )
      expect(childResult.ok).toBe(true)
      if (childResult.ok) {
        expect(existsSync(childResult.worktreePath)).toBe(true)
        expect(childResult.gitRoot).toBe(repoA)
        expect(existsSync(join(childResult.worktreePath, 'README.md'))).toBe(
          true,
        )

        git(repoA, root, 'worktree', 'remove', '--force', childResult.worktreePath)
      }
    } finally {
      restoreEnv()
      if (enclosing === 'read-only' && existsSync(join(root, '.git'))) {
        chmodSync(join(root, '.git'), 0o755)
      }
      rmSync(root, { recursive: true, force: true })
    }
  },
  { timeout: 60_000 },
)
