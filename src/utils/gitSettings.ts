// Git-related behaviors that depend on user settings.
//
// This lives outside git.ts because git.ts is in the vscode extension's
// dep graph and must stay free of settings.ts, which transitively pulls
// @opentelemetry/api + undici (forbidden in vscode). It's also a cycle:
// settings.ts → git/gitignore.ts → git.ts, so git.ts → settings.ts loops.
//
// If you're tempted to add `import settings` to git.ts — don't. Put it here.
// (Importing git.ts from here is fine — the dependency only flows one way.)

import { getCwd } from './cwd.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
import { findGitRoot } from './git.js'
import { getInitialSettings } from './settings/settings.js'

export function shouldIncludeGitInstructions(): boolean {
  const envVal = process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS
  if (isEnvTruthy(envVal)) return false
  if (isEnvDefinedFalsy(envVal)) return true
  // An explicit settings value always wins — it is the recourse for layouts
  // the repo probe can't see (bare-repo checkouts with GIT_DIR/GIT_WORK_TREE,
  // --separate-git-dir outside the cwd ancestry).
  const configured = getInitialSettings().includeGitInstructions
  if (configured !== undefined) return configured
  // Default: ship the ~1.7k-token commit/PR protocol in the Bash tool
  // description only when the session is inside a git repository — it is
  // pure waste elsewhere. findGitRoot handles worktree/submodule .git files
  // and is LRU-memoized; getCwd() tracks the session cwd (Bash `cd`,
  // daemon/SDK sessions), which process.cwd() does not.
  return findGitRoot(getCwd()) !== null
}
