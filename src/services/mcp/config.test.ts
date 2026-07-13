import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  getCurrentProjectConfig,
  getGlobalConfig,
  saveGlobalConfig,
} from '../../utils/config.js'
import { isMcpServerDisabled, setMcpServerEnabled } from './config.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Directly manipulate the singleton test config objects rather than going
 * through saveCurrentProjectConfig / saveGlobalConfig, because the test-mode
 * implementations of those use Object.assign which cannot delete keys.
 *
 * Snapshot + restore to prevent test-to-test leakage.
 */
let savedGlobal: Record<string, unknown>
let savedProject: Record<string, unknown>

function setProjectDisabled(names: string[]): void {
  ;(getCurrentProjectConfig() as Record<string, unknown>).disabledMcpServers =
    names
}

function deleteProjectDisabled(): void {
  delete (getCurrentProjectConfig() as Record<string, unknown>)
    .disabledMcpServers
}

function setGlobalDisabled(names: string[]): void {
  ;(getGlobalConfig() as Record<string, unknown>).disabledMcpServers = names
}

function deleteGlobalDisabled(): void {
  delete (getGlobalConfig() as Record<string, unknown>).disabledMcpServers
}

beforeEach(() => {
  savedGlobal = JSON.parse(JSON.stringify(getGlobalConfig()))
  savedProject = JSON.parse(JSON.stringify(getCurrentProjectConfig()))
})

afterEach(() => {
  const global = getGlobalConfig()
  for (const key of Object.keys(global)) {
    delete (global as Record<string, unknown>)[key]
  }
  Object.assign(global, savedGlobal)

  const project = getCurrentProjectConfig()
  for (const key of Object.keys(project)) {
    delete (project as Record<string, unknown>)[key]
  }
  Object.assign(project, savedProject)
})

// ---------------------------------------------------------------------------
// isMcpServerDisabled
// ---------------------------------------------------------------------------

describe('isMcpServerDisabled', () => {
  test('returns true when server is in project-level disabledMcpServers', () => {
    setProjectDisabled(['server-a', 'server-b'])
    expect(isMcpServerDisabled('server-a')).toBe(true)
    expect(isMcpServerDisabled('server-b')).toBe(true)
  })

  test('returns false when server is NOT in project-level disabledMcpServers', () => {
    setProjectDisabled(['server-a'])
    expect(isMcpServerDisabled('server-b')).toBe(false)
    expect(isMcpServerDisabled('server-c')).toBe(false)
  })

  test('falls back to global disabledMcpServers when project config is undefined', () => {
    deleteProjectDisabled()
    setGlobalDisabled(['global-server'])
    expect(isMcpServerDisabled('global-server')).toBe(true)
    expect(isMcpServerDisabled('other-server')).toBe(false)
  })

  test('project empty array is authoritative and does NOT fall back to global', () => {
    setProjectDisabled([])
    setGlobalDisabled(['global-server'])
    expect(isMcpServerDisabled('global-server')).toBe(false)
  })

  test('returns false when neither project nor global has disabledMcpServers', () => {
    deleteProjectDisabled()
    deleteGlobalDisabled()
    expect(isMcpServerDisabled('any-server')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// setMcpServerEnabled – disable direction
// ---------------------------------------------------------------------------

describe('setMcpServerEnabled — disable', () => {
  test('disabling a server adds it to project-level disabledMcpServers', () => {
    deleteProjectDisabled()
    setMcpServerEnabled('server-x', false)
    expect(isMcpServerDisabled('server-x')).toBe(true)
  })

  test('disabling a server propagates to global fallback (M1 fix)', () => {
    deleteProjectDisabled()
    deleteGlobalDisabled()

    setMcpServerEnabled('server-x', false)

    // A fresh project (no opinion) should inherit the global disable
    deleteProjectDisabled()
    expect(isMcpServerDisabled('server-x')).toBe(true)
  })

  test('disabling a server that is already disabled is idempotent', () => {
    setProjectDisabled(['server-y'])
    setMcpServerEnabled('server-y', false)
    expect(isMcpServerDisabled('server-y')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// setMcpServerEnabled – enable direction
// ---------------------------------------------------------------------------

describe('setMcpServerEnabled — enable', () => {
  test('enabling a server removes it from project-level disabledMcpServers', () => {
    setProjectDisabled(['server-z'])
    setMcpServerEnabled('server-z', true)
    expect(isMcpServerDisabled('server-z')).toBe(false)
  })

  test('enabling a server does NOT propagate to global (M1 fix)', () => {
    // Setup: server-x disabled in both project and global
    setProjectDisabled(['server-x'])
    setGlobalDisabled(['server-x'])

    // Enable in current project
    setMcpServerEnabled('server-x', true)

    // Current project: server-x is now enabled (project [] wins)
    expect(isMcpServerDisabled('server-x')).toBe(false)

    // Simulate a fresh project: the global list was untouched, so
    // server-x is still disabled globally.
    deleteProjectDisabled()
    expect(isMcpServerDisabled('server-x')).toBe(true)
  })

  test('enabling a server that is already enabled is idempotent', () => {
    setProjectDisabled([])
    setMcpServerEnabled('server-y', true)
    expect(isMcpServerDisabled('server-y')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  test('unknown or empty server names return false', () => {
    expect(isMcpServerDisabled('')).toBe(false)
    expect(isMcpServerDisabled('   ')).toBe(false)
    expect(isMcpServerDisabled('non-existent-server')).toBe(false)
  })

  test('global disabledMcpServers defaults to empty when undefined', () => {
    deleteProjectDisabled()
    deleteGlobalDisabled()
    expect(isMcpServerDisabled('anything')).toBe(false)
  })
})
