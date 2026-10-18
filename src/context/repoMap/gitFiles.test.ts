import { expect, test } from 'bun:test'

import { getLanguageForFile, isSupportedFile } from './gitFiles.js'

test('resolves supported extensions to their language', () => {
  expect(getLanguageForFile('src/index.ts')).toBe('typescript')
  expect(getLanguageForFile('src/App.tsx')).toBe('tsx')
  expect(getLanguageForFile('lib/util.js')).toBe('javascript')
  expect(getLanguageForFile('worker.mjs')).toBe('javascript')
  expect(getLanguageForFile('main.py')).toBe('python')
})

test('returns null for an unsupported extension', () => {
  expect(getLanguageForFile('README.md')).toBeNull()
  expect(getLanguageForFile('data.json')).toBeNull()
  expect(isSupportedFile('notes.txt')).toBe(false)
})

test('returns null for an extensionless file instead of keying on the whole name', () => {
  // lastIndexOf('.') === -1 previously fell back to substring(0), so the entire
  // filename became the lookup key.
  expect(getLanguageForFile('Makefile')).toBeNull()
  expect(getLanguageForFile('Dockerfile')).toBeNull()
  expect(isSupportedFile('LICENSE')).toBe(false)
})

test('does not treat an Object.prototype-member filename as a supported language', () => {
  // A root file with no extension named after an inherited member would resolve
  // SUPPORTED_EXTENSIONS['constructor'] to Object.prototype.constructor (truthy)
  // and slip past the `?? null` guard, misclassifying the file as supported.
  for (const name of [
    'constructor',
    '__proto__',
    'toString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
  ]) {
    expect(getLanguageForFile(name)).toBeNull()
    expect(isSupportedFile(name)).toBe(false)
  }
})
