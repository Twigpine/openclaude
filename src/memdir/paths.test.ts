import { afterEach, beforeEach, expect, test, mock } from 'bun:test'
import {
  getIsInteractive,
  setAllowedSettingSources,
  setIsInteractive,
} from '../bootstrap/state.js'
import { SETTING_SOURCES } from '../utils/settings/constants.js'
import { isAutoMemoryEnabled } from './paths.ts'

const realSettings = (await import(
  `../utils/settings/settings.js?pathsTestReal=${Date.now()}-${Math.random()}`
)) as typeof import('../utils/settings/settings.js')

// Pin issue #1326: `memory.autoWrite` is a discoverable alias for the legacy
// `autoMemoryEnabled` setting, and either key opts out for governance /
// regulated / client-sensitive repos. The opt-out is evaluated across the raw
// per-source settings (low-to-high priority) rather than the merged object, so
// a `false` in any source survives source-precedence merging and a parent-scope
// opt-out can't be silently re-enabled by a narrower scope flipping the key.

let _originalEnv: Record<string, string | undefined> = {}
let _originalInteractive = false

type SourceFixture = { source: string; settings: Record<string, unknown> }
let _sources: SourceFixture[] = []

// Drive the raw per-source view that isAutoMemoryEnabled() reads. Sources are
// listed low-to-high priority (userSettings lowest, policySettings highest) —
// the order getEnabledSettingSources() yields. We use the REAL enabled-sources
// list (all sources are allowed below) and only stub getSettingsForSource, so
// no shared module other than settings.js is mocked.
function mockSources(sources: SourceFixture[]): void {
  _sources = sources
}

beforeEach(() => {
  _originalEnv = {
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY,
    CLAUDE_CODE_SIMPLE: process.env.CLAUDE_CODE_SIMPLE,
    CLAUDE_CODE_REMOTE: process.env.CLAUDE_CODE_REMOTE,
    CLAUDE_CODE_REMOTE_MEMORY_DIR: process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR,
  }
  delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  delete process.env.CLAUDE_CODE_SIMPLE
  delete process.env.CLAUDE_CODE_REMOTE
  delete process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR

  _sources = []
  // Auto-memory defaults off for non-interactive (-p) sessions; these tests
  // exercise the interactive default unless a test overrides this.
  _originalInteractive = getIsInteractive()
  setIsInteractive(true)
  // Enable every source so getEnabledSettingSources() returns the full set in
  // priority order; the fixtures decide which of them carry a value.
  setAllowedSettingSources([...SETTING_SOURCES])
  // Stub only the per-source reader. Spread the real module so every other
  // export keeps its real binding.
  mock.module('../utils/settings/settings.js', () => ({
    ...realSettings,
    getSettingsForSource: (source: string) =>
      _sources.find(s => s.source === source)?.settings ?? null,
  }))
})

afterEach(() => {
  for (const [k, v] of Object.entries(_originalEnv)) {
    if (v === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = v
    }
  }
  setIsInteractive(_originalInteractive)
  setAllowedSettingSources([...SETTING_SOURCES])
  // mock.restore() undoes spies but NOT mock.module() registrations, which
  // otherwise leak into later test files in the same (serial) run. Re-register
  // the real settings module so the process is left clean.
  mock.module('../utils/settings/settings.js', () => ({ ...realSettings }))
  mock.restore()
})

test('defaults to enabled when no source sets the key and no env override', () => {
  mockSources([{ source: 'userSettings', settings: {} }])
  expect(isAutoMemoryEnabled()).toBe(true)
})

test('defaults to disabled in non-interactive (-p) sessions', () => {
  setIsInteractive(false)
  mockSources([{ source: 'userSettings', settings: {} }])
  expect(isAutoMemoryEnabled()).toBe(false)
})

test('an explicit settings opt-in overrides the non-interactive default', () => {
  setIsInteractive(false)
  mockSources([
    { source: 'userSettings', settings: { memory: { autoWrite: true } } },
  ])
  expect(isAutoMemoryEnabled()).toBe(true)
})

test('memory.autoWrite: false opts out via the new discoverable alias (#1326)', () => {
  mockSources([
    { source: 'projectSettings', settings: { memory: { autoWrite: false } } },
  ])
  expect(isAutoMemoryEnabled()).toBe(false)
})

test('memory.autoWrite: true explicitly opts in', () => {
  mockSources([
    { source: 'projectSettings', settings: { memory: { autoWrite: true } } },
  ])
  expect(isAutoMemoryEnabled()).toBe(true)
})

test('legacy autoMemoryEnabled: false still opts out (back-compat)', () => {
  mockSources([{ source: 'projectSettings', settings: { autoMemoryEnabled: false } }])
  expect(isAutoMemoryEnabled()).toBe(false)
})

test('legacy autoMemoryEnabled: true still opts in (back-compat)', () => {
  mockSources([{ source: 'projectSettings', settings: { autoMemoryEnabled: true } }])
  expect(isAutoMemoryEnabled()).toBe(true)
})

test('a lower-priority memory.autoWrite: false survives a higher-priority true (#1326)', () => {
  // The regression the merged-object read missed: source precedence collapses
  // same-key values, so getInitialSettings() would keep only the higher-priority
  // `true` and silently re-enable auto-memory. Evaluating the raw per-source
  // list keeps the parent-scope opt-out authoritative.
  mockSources([
    { source: 'userSettings', settings: { memory: { autoWrite: false } } },
    { source: 'localSettings', settings: { memory: { autoWrite: true } } },
  ])
  expect(isAutoMemoryEnabled()).toBe(false)
})

test('a parent autoMemoryEnabled: false is not re-enabled by a narrower memory.autoWrite: true', () => {
  mockSources([
    { source: 'projectSettings', settings: { autoMemoryEnabled: false } },
    { source: 'localSettings', settings: { memory: { autoWrite: true } } },
  ])
  expect(isAutoMemoryEnabled()).toBe(false)
})

test('env var still overrides settings', () => {
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
  mockSources([
    { source: 'projectSettings', settings: { memory: { autoWrite: true } } },
  ])
  expect(isAutoMemoryEnabled()).toBe(false)
})
