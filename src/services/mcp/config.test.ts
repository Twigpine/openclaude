import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  getCurrentProjectConfig,
  getGlobalConfig,
  saveCurrentProjectConfig,
  saveGlobalConfig,
} from '../../utils/config.js'
import { isMcpServerDisabled, setMcpServerEnabled } from './config.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Use saveCurrentProjectConfig / saveGlobalConfig for state manipulation
 * because they share the same test singleton that isMcpServerDisabled reads.
 *
 * Direct property assignment on getCurrentProjectConfig() does NOT work
 * in CI — the returned object differs between calls — but the functional
 * save helpers correctly update the shared singleton.
 */
let savedGlobal: Record<string, unknown>
let savedProject: Record<string, unknown>

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
    saveCurrentProjectConfig(c => ({
      ...c,
      disabledMcpServers: ['server-a', 'server-b'],
    }))
    expect(isMcpServerDisabled('server-a')).toBe(true)
    expect(isMcpServerDisabled('server-b')).toBe(true)
  })

  test('returns false when server is NOT in project-level disabledMcpServers', () => {
    saveCurrentProjectConfig(c => ({
      ...c,
      disabledMcpServers: ['server-a'],
    }))
    expect(isMcpServerDisabled('server-b')).toBe(false)
    expect(isMcpServerDisabled('server-c')).toBe(false)
  })

  test('falls back to global disabledMcpServers when project config is undefined', () => {
    saveGlobalConfig(c => ({
      ...c,
      disabledMcpServers: ['global-server'],
    }))
    expect(isMcpServerDisabled('global-server')).toBe(true)
    expect(isMcpServerDisabled('other-server')).toBe(false)
  })

  test('project empty array is authoritative and does NOT fall back to global', () => {
    saveCurrentProjectConfig(c => ({
      ...c,
      disabledMcpServers: [],
    }))
    saveGlobalConfig(c => ({
      ...c,
      disabledMcpServers: ['global-server'],
    }))
    expect(isMcpServerDisabled('global-server')).toBe(false)
  })

  test('returns false when neither project nor global has disabledMcpServers', () => {
    expect(isMcpServerDisabled('any-server')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// setMcpServerEnabled – disable direction
// ---------------------------------------------------------------------------

describe('setMcpServerEnabled — disable', () => {
  test('disabling a server adds it to project-level disabledMcpServers', () => {
    setMcpServerEnabled('server-x', false)
    expect(isMcpServerDisabled('server-x')).toBe(true)
  })

  test('disabling a server propagates to global fallback (M1 fix)', () => {
    // Start clean
    saveCurrentProjectConfig(c => {
      const { disabledMcpServers: _, ...rest } = c
      return rest
    })

    setMcpServerEnabled('server-x', false)

    // A fresh project (no opinion) should inherit the global disable.
    // Use setMcpServerEnabled to clear project, but since Object.assign
    // can't delete keys, we also need to verify by checking getGlobalConfig.
    const global = getGlobalConfig()
    expect(global.disabledMcpServers).toContain('server-x')
  })

  test('disabling a server that is already disabled is idempotent', () => {
    saveCurrentProjectConfig(c => ({
      ...c,
      disabledMcpServers: ['server-y'],
    }))
    setMcpServerEnabled('server-y', false)
    expect(isMcpServerDisabled('server-y')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// setMcpServerEnabled – enable direction
// ---------------------------------------------------------------------------

describe('setMcpServerEnabled — enable', () => {
  test('enabling a server removes it from project-level disabledMcpServers', () => {
    saveCurrentProjectConfig(c => ({
      ...c,
      disabledMcpServers: ['server-z'],
    }))
    setMcpServerEnabled('server-z', true)
    expect(isMcpServerDisabled('server-z')).toBe(false)
  })

  test('enabling a server does NOT propagate to global (M1 fix)', () => {
    // Setup: server-x disabled in both project and global
    saveCurrentProjectConfig(c => ({
      ...c,
      disabledMcpServers: ['server-x'],
    }))
    saveGlobalConfig(c => ({
      ...c,
      disabledMcpServers: ['server-x'],
    }))

    // Enable in current project
    setMcpServerEnabled('server-x', true)

    // Current project: server-x is now enabled (project [] wins)
    expect(isMcpServerDisabled('server-x')).toBe(false)

    // Verify global list was untouched
    const global = getGlobalConfig()
    expect(global.disabledMcpServers).toContain('server-x')
  })

  test('enabling a server that is already enabled is idempotent', () => {
    saveCurrentProjectConfig(c => ({
      ...c,
      disabledMcpServers: [],
    }))
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
    expect(isMcpServerDisabled('anything')).toBe(false)
  })
})
