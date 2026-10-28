import { expect, test } from 'bun:test'
import { execSyncWithDefaults_DEPRECATED } from './execFileNoThrowPortable.js'

// Allow assertions and cleanup beyond the subprocess's 8-second deadline.
const options = { timeout: 8_000 }

test('portable sync execution trims captured stdout', () => {
  expect(execSyncWithDefaults_DEPRECATED('echo hello', options)).toBe('hello')
}, 10_000)

test('portable sync execution preserves stdout on nonzero exit', () => {
  expect(execSyncWithDefaults_DEPRECATED('echo partial && exit 7', options)).toBe('partial')
}, 10_000)

test('portable sync execution returns null without stdout', () => {
  expect(execSyncWithDefaults_DEPRECATED('exit 7', options)).toBeNull()
}, 10_000)

test('portable sync execution forwards explicit stdin', () => {
  const command = `"${process.execPath}" -e "process.stdin.pipe(process.stdout)"`
  expect(execSyncWithDefaults_DEPRECATED(command, {
    ...options,
    input: 'payload\n',
    stdio: ['pipe', 'pipe', 'pipe'],
  })).toBe('payload')
}, 10_000)
