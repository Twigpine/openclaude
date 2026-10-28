import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import axios from 'axios'
import { existsSync, mkdtempSync, readFileSync, rmSync, type WriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../test/sharedMutationLock.js'
import * as config from './config.js'
import * as executor from './execFileNoThrow.js'
import { getFsImplementation, setFsImplementation } from './fsOperations.js'
import { maybeInstallIDEExtension } from './ide.js'

let originalFs: ReturnType<typeof getFsImplementation>
let originalUserType: string | undefined
let originalArtifactory: string | undefined
let scratch: string
let downloadedPath: string
let destination: WriteStream | undefined
let source: Readable
let failDestination: boolean
let getSpy: ReturnType<typeof spyOn<typeof axios, 'get'>>
let execSpy: ReturnType<typeof spyOn<typeof executor, 'execFileNoThrowWithCwd'>>
let configSpy: ReturnType<typeof spyOn<typeof config, 'getGlobalConfig'>>

beforeEach(async () => {
  await acquireSharedMutationLock('ide.download.test.ts')
  originalFs = getFsImplementation()
  originalUserType = process.env.USER_TYPE
  originalArtifactory = process.env.CLAUDE_CODE_INTERNAL_ARTIFACTORY_BASE_URL
  scratch = mkdtempSync(join(tmpdir(), 'ide-download-'))
  downloadedPath = ''
  destination = undefined
  failDestination = false
  process.env.USER_TYPE = 'ant'
  process.env.CLAUDE_CODE_INTERNAL_ARTIFACTORY_BASE_URL = 'https://artifactory.example.test'
  configSpy = spyOn(config, 'getGlobalConfig').mockReturnValue({ diffTool: 'auto' } as ReturnType<typeof config.getGlobalConfig>)
  execSpy = spyOn(executor, 'execFileNoThrowWithCwd').mockResolvedValue({ code: 0, stdout: '', stderr: '' })
  getSpy = spyOn(axios, 'get')
  setFsImplementation({
    ...originalFs,
    readFile: (path, options) => path.endsWith('.npmrc')
      ? Promise.resolve('//artifactory.example.test/api/npm/npm-all/:_authToken=test-token')
      : originalFs.readFile(path, options),
    createWriteStream: path => {
      downloadedPath = String(path)
      destination = originalFs.createWriteStream(
        failDestination ? join(scratch, 'missing', 'extension.vsix') : path,
      )
      return destination
    },
  })
})

afterEach(() => {
  source?.destroy()
  destination?.destroy()
  getSpy.mockRestore()
  execSpy.mockRestore()
  configSpy.mockRestore()
  setFsImplementation(originalFs)
  if (originalUserType === undefined) delete process.env.USER_TYPE
  else process.env.USER_TYPE = originalUserType
  if (originalArtifactory === undefined) delete process.env.CLAUDE_CODE_INTERNAL_ARTIFACTORY_BASE_URL
  else process.env.CLAUDE_CODE_INTERNAL_ARTIFACTORY_BASE_URL = originalArtifactory
  rmSync(scratch, { recursive: true, force: true })
  releaseSharedMutationLock()
})

async function install() {
  getSpy
    .mockResolvedValueOnce({ data: '1.2.3' } as Awaited<ReturnType<typeof axios.get>>)
    .mockResolvedValueOnce({ data: source } as Awaited<ReturnType<typeof axios.get>>)
  const pending = maybeInstallIDEExtension('vscode')
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('installation did not settle after download failure')), 2000)
      }),
    ])
  } finally {
    clearTimeout(deadline)
    // Also settle the old, broken implementation when running the regression before the fix.
    if (destination && !destination.destroyed) destination.destroy(new Error('test teardown'))
    await pending
  }
}

test('reports a failed source download and removes the partial VSIX without installing it', async () => {
  source = Readable.from((async function* () {
    yield Buffer.from('partial extension')
    throw new Error('download interrupted')
  })())
  // Keep the baseline implementation from raising an uncaught stream error.
  // The caller must still report the failure and settle its installation promise.
  source.on('error', () => {})
  const result = await install()
  expect(result).toMatchObject({ installed: false, error: 'download interrupted', installedVersion: null })
  expect(execSpy).not.toHaveBeenCalled()
  expect(destination?.closed).toBe(true)
  expect(existsSync(downloadedPath)).toBe(false)
})

test('reports destination errors and destroys the source without installing', async () => {
  source = new Readable({ read() {} })
  failDestination = true
  const result = await install()
  expect(result?.installed).toBe(false)
  expect(result?.error).toContain('ENOENT')
  expect(source.destroyed).toBe(true)
  expect(execSpy).not.toHaveBeenCalled()
  expect(existsSync(downloadedPath)).toBe(false)
})

test('installs the complete downloaded VSIX and cleans it up afterward', async () => {
  source = Readable.from([Buffer.from('complete extension')])
  execSpy.mockImplementation(async (_command, args) => {
    expect(readFileSync(args[2]!, 'utf8')).toBe('complete extension')
    return { code: 0, stdout: '', stderr: '' }
  })
  const result = await install()
  expect(result).toMatchObject({ installed: true, error: null, installedVersion: '1.2.3' })
  expect(execSpy).toHaveBeenCalledTimes(1)
  expect(existsSync(downloadedPath)).toBe(false)
})
