import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import * as fs from 'fs'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { getCwdState, setCwdState } from '../bootstrap/state.js'
import { snapshotEnv } from '../test/envSnapshot.js'
import { shouldIncludeGitInstructions } from './gitSettings.js'

const realSettings = (await import(
  `./settings/settings.js?gitSettingsTestReal=${Date.now()}-${Math.random()}`
)) as typeof import('./settings/settings.js')

let originalCwdState: string
let restoreEnv: () => void
let tempRoot: string
let settingsFixture: Record<string, unknown> = {}

beforeEach(() => {
  originalCwdState = getCwdState()
  restoreEnv = snapshotEnv(['CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS'], { clear: true })
  tempRoot = mkdtempSync(join(tmpdir(), 'gitsettings-test-'))
  // Isolate filesystem lookups without changing the shared process's Git environment.
  // Hide ancestor repositories when tmpdir() happens to be inside a checkout.
  const ancestorGitPaths = new Set<string>()
  for (let ancestor = dirname(tempRoot); ; ancestor = dirname(ancestor)) {
    ancestorGitPaths.add(join(ancestor, '.git'))
    if (dirname(ancestor) === ancestor) break
  }
  const statSync = fs.statSync
  spyOn(fs, 'statSync').mockImplementation(((path, options) => {
    if (ancestorGitPaths.has(String(path))) {
      throw new Error('Outside the test fixture')
    }
    return statSync(path, options)
  }) as typeof fs.statSync)
  settingsFixture = {}
  mock.module('./settings/settings.js', () => ({
    ...realSettings,
    getInitialSettings: () => settingsFixture,
  }))
})

afterEach(() => {
  setCwdState(originalCwdState)
  restoreEnv()
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
