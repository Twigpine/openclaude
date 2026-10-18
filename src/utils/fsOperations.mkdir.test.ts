import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import * as fs from 'fs'
import * as fsPromises from 'fs/promises'
import { NodeFsOperations } from './fsOperations.js'

// Regression test: on Windows, writing a file directly at a drive root
// (e.g. D:\foo) makes recursive mkdir walk up to the root itself, where the
// kernel cannot "create" a root that already exists and libuv maps that to
// EPERM rather than EEXIST. mkdir must treat EACCES/EPERM as a no-op when
// the directory already exists, and must keep propagating them when it does
// not (genuine permission failures).
//
// Uses spyOn + mock.restore() rather than mock.module(): module mocks are
// process-global and leak across test files in the same bun process, and
// neither mock.restore() nor re-registering the real module clears them.

function eperm(): NodeJS.ErrnoException {
  return Object.assign(new Error("EPERM: operation not permitted, mkdir 'D:\\'"), {
    code: 'EPERM',
    path: 'D:\\',
  })
}

function mockMkdir(dirExists: boolean) {
  spyOn(fsPromises, 'mkdir').mockRejectedValue(eperm())
  spyOn(fs, 'existsSync').mockReturnValue(dirExists)
  spyOn(fs, 'mkdirSync').mockImplementation(() => {
    throw eperm()
  })
}

describe('NodeFsOperations mkdir EPERM handling', () => {
  afterEach(() => {
    mock.restore()
  })

  test('async mkdir swallows EPERM when the directory already exists', async () => {
    mockMkdir(true)
    await expect(NodeFsOperations.mkdir('D:\\')).resolves.toBeUndefined()
  })

  test('async mkdir propagates EPERM when the directory does not exist', async () => {
    mockMkdir(false)
    await expect(NodeFsOperations.mkdir('D:\\')).rejects.toMatchObject({
      code: 'EPERM',
    })
  })

  test('sync mkdirSync swallows EPERM when the directory already exists', () => {
    mockMkdir(true)
    expect(() => NodeFsOperations.mkdirSync('D:\\')).not.toThrow()
  })

  test('sync mkdirSync propagates EPERM when the directory does not exist', () => {
    mockMkdir(false)
    expect(() => NodeFsOperations.mkdirSync('D:\\')).toThrow(/EPERM/)
  })
})
