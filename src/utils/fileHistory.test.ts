import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getIsInteractive,
  getOriginalCwd,
  getProjectRoot,
  getSessionId,
  setIsInteractive,
  setOriginalCwd,
  setProjectRoot,
} from '../bootstrap/state.js'
import {
  fileHistoryMakeSnapshot,
  fileHistoryTrackEdit,
  type FileHistoryState,
} from './fileHistory.js'
import {
  getClaudeConfigHomeDirOverrideForTesting,
  setClaudeConfigHomeDirForTesting,
} from './envUtils.js'

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
  let savedInteractive: boolean
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
    savedConfig = getClaudeConfigHomeDirOverrideForTesting()
    savedInteractive = getIsInteractive()
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
    setClaudeConfigHomeDirForTesting(savedConfig)
    setIsInteractive(savedInteractive)
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
    // Both roots contain live.txt; the backup must hold the project file's
    // content, not the same-named file under the moved working root.
    const backupPath = join(
      root,
      'config',
      'file-history',
      getSessionId(),
      backup.backupFileName!,
    )
    expect(readFileSync(backupPath, 'utf8')).toBe('project content')
  })


  it('reuses a legacy unprefixed key instead of overwriting its v1 backup', async () => {
    const absPath = join(projectRoot, 'legacy.txt')
    writeFileSync(absPath, 'edited content')
    // Simulate a checkpoint restored from a pre-'./' log: unprefixed key
    // with an existing version-1 backup file holding the original bytes.
    const backupName = 'legacy-backup-v1'
    const backupDir = join(root, 'config', 'file-history', getSessionId())
    mkdirSync(backupDir, { recursive: true })
    writeFileSync(join(backupDir, backupName), 'original content')
    latest.trackedFiles.add('legacy.txt')
    latest.snapshots[0].trackedFileBackups['legacy.txt'] = {
      backupFileName: backupName,
      version: 1,
      backupTime: new Date(),
    }

    await fileHistoryTrackEdit(stateUpdater, absPath, 'm3' as never)

    // The legacy key stays the identity: no './' twin and the v1 backup
    // file keeps its original contents for rewind.
    expect(latest.snapshots.at(-1)!.trackedFileBackups['./legacy.txt']).toBeUndefined()
    expect(readFileSync(join(backupDir, backupName), 'utf8')).toBe(
      'original content',
    )
  })

  it('keeps a distinct identity when both roots contain the file', async () => {
    // A legacy checkpoint tracked file.txt while anchored to the working
    // root. Editing the project-root file.txt must not adopt that key:
    // its v1 backup holds the other file's contents.
    const projectFile = join(projectRoot, 'file.txt')
    writeFileSync(projectFile, 'project content')
    writeFileSync(join(workRoot, 'file.txt'), 'working-root content')
    const backupName = 'workroot-backup-v1'
    const backupDir = join(root, 'config', 'file-history', getSessionId())
    mkdirSync(backupDir, { recursive: true })
    writeFileSync(join(backupDir, backupName), 'working-root original')
    latest.trackedFiles.add('file.txt')
    latest.snapshots[0].trackedFileBackups['file.txt'] = {
      backupFileName: backupName,
      version: 1,
      backupTime: new Date(),
    }

    await fileHistoryTrackEdit(stateUpdater, projectFile, 'm3' as never)

    const backups = latest.snapshots.at(-1)!.trackedFileBackups
    // The two files are different, so they keep different identities and
    // each backup file holds its own contents.
    expect(backups['./file.txt']).toBeDefined()
    expect(readFileSync(join(backupDir, backupName), 'utf8')).toBe(
      'working-root original',
    )
    expect(
      readFileSync(
        join(backupDir, backups['./file.txt'].backupFileName!),
        'utf8',
      ),
    ).toBe('project content')
  })

  it('reuses a legacy key for the same project file despite the ambiguous anchor', async () => {
    // The legacy checkpoint tracked the project-root file.txt itself.
    // A same-named file under the working root makes the anchor ambiguous,
    // but the v1 backup name derives from the absolute path, so a match
    // proves the key tracked this file and reuse is safe: a './' twin
    // would overwrite that very backup blob.
    const projectFile = join(projectRoot, 'file.txt')
    writeFileSync(projectFile, 'edited content')
    writeFileSync(join(workRoot, 'file.txt'), 'working-root content')
    const backupName = `${createHash('sha256').update(projectFile).digest('hex').slice(0, 16)}@v1`
    const backupDir = join(root, 'config', 'file-history', getSessionId())
    mkdirSync(backupDir, { recursive: true })
    writeFileSync(join(backupDir, backupName), 'original content')
    latest.trackedFiles.add('file.txt')
    latest.snapshots[0].trackedFileBackups['file.txt'] = {
      backupFileName: backupName,
      version: 1,
      backupTime: new Date(),
    }

    await fileHistoryTrackEdit(stateUpdater, projectFile, 'm3' as never)

    expect(latest.snapshots.at(-1)!.trackedFileBackups['./file.txt']).toBeUndefined()
    expect(readFileSync(join(backupDir, backupName), 'utf8')).toBe(
      'original content',
    )
  })
})
