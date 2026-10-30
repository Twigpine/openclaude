import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as cwd from './cwd.js'
import * as execSyncWrapper from './execSyncWrapper.js'
import { getFsImplementation } from './fsOperations.js'
import * as platform from './platform.js'
import { findGitBashPath, setShellIfWindows } from './windowsPaths.js'

describe('Windows Git Bash discovery', () => {
  let tempDir: string
  const originalOverride = process.env.CLAUDE_CODE_GIT_BASH_PATH
  const originalShell = process.env.SHELL

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'git-bash-path-'))
    delete process.env.CLAUDE_CODE_GIT_BASH_PATH
    findGitBashPath.cache.clear?.()
    spyOn(platform, 'getPlatform').mockReturnValue('windows')
    spyOn(console, 'error').mockImplementation(() => {})
    spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit requested')
    })
  })

  afterEach(() => {
    mock.restore()
    findGitBashPath.cache.clear?.()
    if (originalOverride === undefined) delete process.env.CLAUDE_CODE_GIT_BASH_PATH
    else process.env.CLAUDE_CODE_GIT_BASH_PATH = originalOverride
    if (originalShell === undefined) delete process.env.SHELL
    else process.env.SHELL = originalShell
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('sets SHELL to an existing override even when system shell commands fail', () => {
    const bashPath = join(tempDir, 'Git Bash & tools', 'bash.exe')
    mkdirSync(join(tempDir, 'Git Bash & tools'))
    writeFileSync(bashPath, '')
    process.env.CLAUDE_CODE_GIT_BASH_PATH = bashPath
    const exec = spyOn(execSyncWrapper, 'execSync_DEPRECATED').mockImplementation(() => {
      throw new Error('command interpreter unavailable')
    })

    setShellIfWindows()

    expect(process.env.SHELL).toBe(bashPath)
    expect(findGitBashPath()).toBe(bashPath)
    expect(exec).not.toHaveBeenCalled()
  })

  test.each(['missing', 'directory'])('rejects a %s override without falling back', kind => {
    const bashPath = join(tempDir, 'bash.exe')
    if (kind === 'directory') mkdirSync(bashPath)
    process.env.CLAUDE_CODE_GIT_BASH_PATH = bashPath
    const exec = spyOn(execSyncWrapper, 'execSync_DEPRECATED').mockReturnValue('')

    expect(() => setShellIfWindows()).toThrow('exit requested')
    expect(process.exit).toHaveBeenCalledWith(1)
    expect(console.error).toHaveBeenCalledWith(
      `Claude Code was unable to find CLAUDE_CODE_GIT_BASH_PATH path "${bashPath}"`,
    )
    expect(exec).not.toHaveBeenCalled()
  })

  test.each([
    ['default', 'C:\\Program Files\\Git'],
    ['custom', 'D:\\Developer Tools\\Git'],
  ])('discovers a %s installation without using dir', (kind, gitRoot) => {
    spyOn(cwd, 'getCwd').mockReturnValue('C:\\workspace')
    // Model Windows paths on any host, backed by a real file's stat result.
    const file = join(tempDir, 'executable')
    writeFileSync(file, '')
    const fs = getFsImplementation()
    const executableStat = fs.statSync(file)
    const gitPath = `${gitRoot}\\cmd\\git.exe`
    const bashPath = `${gitRoot}\\bin\\bash.exe`
    spyOn(fs, 'statSync').mockImplementation(candidate => {
      if (candidate === gitPath || candidate === bashPath) return executableStat
      throw new Error('file not found')
    })
    const exec = spyOn(execSyncWrapper, 'execSync_DEPRECATED').mockReturnValue(`${gitPath}\r\n`)

    setShellIfWindows()

    expect(process.env.SHELL).toBe(bashPath)
    expect(exec).toHaveBeenCalledTimes(kind === 'default' ? 0 : 1)
    if (kind === 'custom') {
      expect(exec).toHaveBeenCalledWith('where.exe git', {
        stdio: 'pipe',
        encoding: 'utf8',
      })
    }
  })
})
