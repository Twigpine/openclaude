import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getCwdState, setCwdState } from '../bootstrap/state.js'
import { shouldIncludeGitInstructions } from './gitSettings.js'

const realSettings = (await import(
  `./settings/settings.js?gitSettingsTestReal=${Date.now()}-${Math.random()}`
)) as typeof import('./settings/settings.js')

let originalCwdState: string
let originalEnv: string | undefined
let tempRoot: string
let settingsFixture: Record<string, unknown> = {}

beforeEach(() => {
  originalCwdState = getCwdState()
  originalEnv = process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS
  delete process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS
  tempRoot = mkdtempSync(join(tmpdir(), 'gitsettings-test-'))
  settingsFixture = {}
  mock.module('./settings/settings.js', () => ({
    ...realSettings,
    getInitialSettings: () => settingsFixture,
  }))
})

afterEach(() => {
  setCwdState(originalCwdState)
  if (originalEnv === undefined) {
    delete process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS
  } else {
    process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS = originalEnv
  }
  rmSync(tempRoot, { recursive: true, force: true })
  mock.module('./settings/settings.js', () => ({ ...realSettings }))
  mock.restore()
})

test('omits git instructions outside a git repository', () => {
  const plainDir = join(tempRoot, 'plain')
  mkdirSync(plainDir)
  setCwdState(plainDir)
  expect(shouldIncludeGitInstructions()).toBe(false)
})

test('includes git instructions inside a git repository', () => {
  const repoDir = join(tempRoot, 'repo')
  mkdirSync(join(repoDir, '.git'), { recursive: true })
  setCwdState(repoDir)
  expect(shouldIncludeGitInstructions()).toBe(true)
})

test('includes git instructions in a subdirectory of a git repository', () => {
  const repoDir = join(tempRoot, 'repo2')
  mkdirSync(join(repoDir, '.git'), { recursive: true })
  const subDir = join(repoDir, 'src', 'nested')
  mkdirSync(subDir, { recursive: true })
  setCwdState(subDir)
  expect(shouldIncludeGitInstructions()).toBe(true)
})

test('follows the session cwd, not the process cwd (Bash cd / daemon safety)', () => {
  const plainDir = join(tempRoot, 'plain-then-repo')
  mkdirSync(plainDir)
  const repoDir = join(tempRoot, 'repo3')
  mkdirSync(join(repoDir, '.git'), { recursive: true })

  setCwdState(plainDir)
  expect(shouldIncludeGitInstructions()).toBe(false)
  setCwdState(repoDir)
  expect(shouldIncludeGitInstructions()).toBe(true)
})

test('explicit includeGitInstructions: true wins over the repo probe', () => {
  const plainDir = join(tempRoot, 'plain-forced-on')
  mkdirSync(plainDir)
  setCwdState(plainDir)
  settingsFixture = { includeGitInstructions: true }
  expect(shouldIncludeGitInstructions()).toBe(true)
})

test('explicit includeGitInstructions: false wins inside a repository', () => {
  const repoDir = join(tempRoot, 'repo-forced-off')
  mkdirSync(join(repoDir, '.git'), { recursive: true })
  setCwdState(repoDir)
  settingsFixture = { includeGitInstructions: false }
  expect(shouldIncludeGitInstructions()).toBe(false)
})

test('env kill switch wins even inside a git repository', () => {
  const repoDir = join(tempRoot, 'repo4')
  mkdirSync(join(repoDir, '.git'), { recursive: true })
  setCwdState(repoDir)
  process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS = '1'
  expect(shouldIncludeGitInstructions()).toBe(false)
})

test('explicit CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=0 forces instructions on outside a repository', () => {
  const plainDir = join(tempRoot, 'plain-env-forced-on')
  mkdirSync(plainDir)
  setCwdState(plainDir)
  process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS = '0'
  // The defined-falsy env value short-circuits before repository detection.
  expect(shouldIncludeGitInstructions()).toBe(true)
})
