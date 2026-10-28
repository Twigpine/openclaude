// Use a fresh process so shared module mocks cannot replace filesystem discovery.
import { findGitRoot } from './git.js'
import { snapshotEnv } from '../test/envSnapshot.js'

const [cwd, settingsJson] = process.argv.slice(2)
if (!cwd || !settingsJson) process.exit(2)

const restoreEnv = snapshotEnv(['GIT_CEILING_DIRECTORIES'])
try {
  const results = (JSON.parse(settingsJson) as (string | null)[]).map(setting => {
    if (setting === null) delete process.env.GIT_CEILING_DIRECTORIES
    else process.env.GIT_CEILING_DIRECTORIES = setting
    // Reuse the same cwd without clearing caches when the boundary changes.
    return findGitRoot(cwd)
  })
  process.stdout.write(JSON.stringify(results))
} finally {
  restoreEnv()
}
