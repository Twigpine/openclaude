import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getOriginalCwd,
  getProjectRoot,
  setIsInteractive,
  setOriginalCwd,
  setProjectRoot,
} from '../bootstrap/state.js'
import {
  fileHistoryMakeSnapshot,
  type FileHistoryState,
} from './fileHistory.js'
import { setClaudeConfigHomeDirForTesting } from './envUtils.js'

// Regression for the same-named-file hazard: a './'-prefixed tracking key
// anchored to the project root must keep resolving there after /cd, even
// when the project file was deleted and an unrelated same-named file exists
// under the new working root. Existence-based fallback would back up (and
// later rewind over) the wrong file.
describe('fileHistory project-root anchoring', () => {
  let root: string
  let projectRoot: string
  let workRoot: string
  let savedCwd: string
  let savedRoot: string
  let savedConfig: string | undefined
  let latest: FileHistoryState

  const stateUpdater = (updater: (prev: FileHistoryState) => FileHistoryState) => {
    latest = updater(latest)
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'oc-fh-')))
    projectRoot = join(root, 'project')
    workRoot = join(root, 'elsewhere')
    mkdirSync(projectRoot)
    mkdirSync(workRoot)
    savedCwd = getOriginalCwd()
    savedRoot = getProjectRoot()
    savedConfig = undefined
    setClaudeConfigHomeDirForTesting(join(root, 'config'))
    setIsInteractive(true)
    setProjectRoot(projectRoot)
    setOriginalCwd(workRoot)
    latest = {
      snapshots: [
        { messageId: 'm1' as never, trackedFileBackups: {}, timestamp: new Date() },
      ],
      trackedFiles: new Set<string>(),
      snapshotSequence: 1,
    }
  })

  afterEach(() => {
    setOriginalCwd(savedCwd)
    setProjectRoot(savedRoot)
    rmSync(root, { recursive: true, force: true })
  })

  it('resolves ./ keys at the project root, not a same-named file under the new cwd', async () => {
    // The tracked project file is deleted; a same-named file exists in the
    // working root. A './' key must record the deletion, not back up the
    // unrelated file.
    writeFileSync(join(workRoot, 'gone.txt'), 'unrelated content')
    latest.trackedFiles.add('./gone.txt')

    await fileHistoryMakeSnapshot(stateUpdater, 'm2' as never)

    const backup = latest.snapshots.at(-1)!.trackedFileBackups['./gone.txt']
    expect(backup).toBeDefined()
    expect(backup.backupFileName).toBeNull()
  })

  it('backs up a live ./ key from the project root while cwd is elsewhere', async () => {
    writeFileSync(join(projectRoot, 'live.txt'), 'project content')
    writeFileSync(join(workRoot, 'live.txt'), 'different content')
    latest.trackedFiles.add('./live.txt')

    await fileHistoryMakeSnapshot(stateUpdater, 'm2' as never)

    const backup = latest.snapshots.at(-1)!.trackedFileBackups['./live.txt']
    expect(backup).toBeDefined()
    expect(backup.backupFileName).not.toBeNull()
  })
})
