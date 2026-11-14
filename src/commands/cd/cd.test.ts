import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import {
  getAdditionalDirectoriesForClaudeMd,
  getCwdState,
  getOriginalCwd,
  setAdditionalDirectoriesForClaudeMd,
  setCwdState,
  setOriginalCwd,
} from '../../bootstrap/state.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { LocalJSXCommandContext } from '../../types/command.js'
import { getCwd } from '../../utils/cwd.js'
import { allWorkingDirectories } from '../../utils/permissions/filesystem.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { call } from './cd.js'

describe('/cd', () => {
  let sandbox: string
  let savedCwdState: string
  let savedOriginalCwd: string
  let savedAdditionalDirs: string[]
  let savedProcessCwd: string
  let latestPermissionContext: ReturnType<
    typeof getEmptyToolPermissionContext
  >

  const context = (): LocalJSXCommandContext =>
    ({
      getAppState: () => ({ toolPermissionContext: latestPermissionContext }),
      setAppState: (updater: (prev: unknown) => unknown) => {
        latestPermissionContext = (
          updater({ toolPermissionContext: latestPermissionContext }) as {
            toolPermissionContext: typeof latestPermissionContext
          }
        ).toolPermissionContext
      },
    }) as unknown as LocalJSXCommandContext

  beforeEach(async () => {
    await acquireSharedMutationLock('commands/cd.test.ts')
    sandbox = mkdtempSync(join(tmpdir(), 'oc-cd-test-'))
    savedProcessCwd = process.cwd()
    savedCwdState = getCwdState()
    savedOriginalCwd = getOriginalCwd()
    savedAdditionalDirs = getAdditionalDirectoriesForClaudeMd()
    latestPermissionContext = getEmptyToolPermissionContext()
    process.chdir(sandbox)
    setCwdState(sandbox)
    setOriginalCwd(sandbox)
  })

  afterEach(() => {
    try {
      process.chdir(savedProcessCwd)
      setCwdState(savedCwdState)
      setOriginalCwd(savedOriginalCwd)
      setAdditionalDirectoriesForClaudeMd(savedAdditionalDirs)
      rmSync(sandbox, { recursive: true, force: true })
    } finally {
      releaseSharedMutationLock()
    }
  })

  it('reports the current working directory with no args', async () => {
    const result = await call('', context())
    expect(result).toEqual({
      type: 'text',
      value: `Current working directory: ${sandbox}`,
    })
  })

  it('switches into a subdirectory without touching the working set', async () => {
    const sub = join(sandbox, 'sub')
    mkdirSync(sub)
    const result = await call('sub', context())
    expect(result.type).toBe('text')
    if (result.type === 'text') expect(result.value).toContain(sub)
    expect(getCwd()).toBe(sub)
    expect(process.cwd()).toBe(sub)
    expect(getOriginalCwd()).toBe(sub)
    expect(getAdditionalDirectoriesForClaudeMd()).toEqual([])
  })

  it('adds an outside directory to the working set, then switches', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'oc-cd-outside-'))
    try {
      const result = await call(outside, context())
      expect(result.type).toBe('text')
      if (result.type === 'text') {
        expect(result.value).toContain(resolve(outside))
      }
      expect(getCwd()).toBe(resolve(outside))
      expect(getAdditionalDirectoriesForClaudeMd()).toContain(resolve(outside))
      expect(allWorkingDirectories(latestPermissionContext)).toContain(
        resolve(outside),
      )
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('errors when the path does not exist', async () => {
    const result = await call('no-such-dir', context())
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('was not found')
    }
    expect(getCwd()).toBe(sandbox)
  })

  it('errors when the path is a file', async () => {
    writeFileSync(join(sandbox, 'file.txt'), 'x')
    const result = await call('file.txt', context())
    expect(result.type).toBe('text')
    if (result.type === 'text') {
      expect(result.value).toContain('is not a directory')
    }
    expect(getCwd()).toBe(sandbox)
  })
})
