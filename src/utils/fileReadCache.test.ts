import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileReadCache } from './fileReadCache.js'
import { getFsImplementation } from './fsOperations.js'

describe('fileReadCache invalidation', () => {
  let directory: string
  const preservedTime = new Date('2020-01-01T00:00:00Z')

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'openclaude-file-cache-'))
    fileReadCache.clear()
  })

  afterEach(() => {
    fileReadCache.clear()
    rmSync(directory, { recursive: true, force: true })
  })

  test('reuses cached contents when file stats are unchanged', () => {
    const path = join(directory, 'file.txt')
    writeFileSync(path, 'unchanged')
    const read = spyOn(getFsImplementation(), 'readFileSync')
    try {
      expect(fileReadCache.readFile(path).content).toBe('unchanged')
      expect(fileReadCache.readFile(path).content).toBe('unchanged')
      expect(read).toHaveBeenCalledTimes(1)
    } finally {
      read.mockRestore()
    }
  })

  test('reloads a resized file whose modification time is preserved', () => {
    const path = join(directory, 'file.txt')
    writeFileSync(path, 'old')
    utimesSync(path, preservedTime, preservedTime)
    expect(fileReadCache.readFile(path).content).toBe('old')

    writeFileSync(path, 'externally updated content')
    utimesSync(path, preservedTime, preservedTime)

    expect(fileReadCache.readFile(path).content).toBe('externally updated content')
  })

  test('reloads an atomic replacement with the same size and modification time', () => {
    const path = join(directory, 'file.txt')
    const replacement = join(directory, 'replacement.txt')
    writeFileSync(path, 'old')
    utimesSync(path, preservedTime, preservedTime)
    expect(fileReadCache.readFile(path).content).toBe('old')
    writeFileSync(replacement, 'new')
    utimesSync(replacement, preservedTime, preservedTime)

    renameSync(replacement, path)

    expect(fileReadCache.readFile(path).content).toBe('new')
  })
})
