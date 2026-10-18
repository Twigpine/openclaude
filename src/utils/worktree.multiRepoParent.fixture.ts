// Child-process fixture for worktree.multiRepoParent.test.ts.
//
// Same rationale as worktree.agentBase.fixture.ts: run createAgentWorktree in
// a clean process so leaked mock.module stubs from other suites cannot make
// git look unavailable.
import {
  getClaudeConfigHomeDir,
  setClaudeConfigHomeDirForTesting,
} from './envUtils.js'
import { createAgentWorktree } from './worktree.js'

const [cfgDir, targetCwd, name] = process.argv.slice(2)

if (!cfgDir || !targetCwd || !name) {
  process.stderr.write('usage: <cfgDir> <targetCwd> <name>\n')
  process.exit(2)
}

setClaudeConfigHomeDirForTesting(cfgDir)
getClaudeConfigHomeDir.cache?.clear?.()

try {
  const result = await createAgentWorktree(name, { cwd: targetCwd })
  process.stdout.write(
    JSON.stringify({
      ok: true,
      worktreePath: result.worktreePath,
      gitRoot: result.gitRoot ?? null,
    }),
  )
  process.exit(0)
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  )
  process.exit(0)
}
