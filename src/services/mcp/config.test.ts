import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import {
  getGlobalConfig,
  saveCurrentProjectConfig,
} from '../../utils/config.js'
import { isMcpServerDisabled, setMcpServerEnabled } from './config.js'

beforeEach(async () => {
  await acquireSharedMutationLock('services/mcp/config.test.ts')
})

afterEach(() => {
  try {
    delete (getGlobalConfig() as Record<string, unknown>).disabledMcpServers
    saveCurrentProjectConfig(() => ({
      mcpServers: {},
      disabledMcpServers: undefined,
    }))
  } finally {
    releaseSharedMutationLock()
  }
})

describe('isMcpServerDisabled', () => {
  test('disabled after disable', () => {
    setMcpServerEnabled('a', false)
    expect(isMcpServerDisabled('a')).toBe(true)
  })

  test('not disabled for other server', () => {
    setMcpServerEnabled('a', false)
    expect(isMcpServerDisabled('b')).toBe(false)
  })

  test('global fallback', () => {
    getGlobalConfig().disabledMcpServers = ['g']
    expect(isMcpServerDisabled('g')).toBe(true)
  })

  test('empty list wins over global', () => {
    setMcpServerEnabled('x', false)
    setMcpServerEnabled('x', true)
    expect(isMcpServerDisabled('x')).toBe(false)
  })

  test('no list', () => {
    expect(isMcpServerDisabled('x')).toBe(false)
  })
})

describe('disable', () => {
  test('disable', () => {
    setMcpServerEnabled('s', false)
    expect(isMcpServerDisabled('s')).toBe(true)
  })

  test('propagate to global (M1)', () => {
    setMcpServerEnabled('s', false)
    expect(getGlobalConfig().disabledMcpServers).toContain('s')
  })

  test('idempotent', () => {
    setMcpServerEnabled('s', false)
    setMcpServerEnabled('s', false)
    expect(isMcpServerDisabled('s')).toBe(true)
  })
})

describe('enable', () => {
  test('enable', () => {
    setMcpServerEnabled('s', false)
    setMcpServerEnabled('s', true)
    expect(isMcpServerDisabled('s')).toBe(false)
  })

  test('stays local (M1)', () => {
    setMcpServerEnabled('s', false)
    setMcpServerEnabled('s', true)
    expect(getGlobalConfig().disabledMcpServers).toContain('s')
  })

  test('idempotent', () => {
    setMcpServerEnabled('s', false)
    setMcpServerEnabled('s', true)
    setMcpServerEnabled('s', true)
    expect(isMcpServerDisabled('s')).toBe(false)
  })
})

describe('edge cases', () => {
  test('empty name', () => {
    expect(isMcpServerDisabled('')).toBe(false)
  })

  test('undefined global', () => {
    expect(isMcpServerDisabled('x')).toBe(false)
  })
})

describe('global fallback enable', () => {
  test('enabling a server disabled only via global fallback overrides it locally', () => {
    getGlobalConfig().disabledMcpServers = ['server-w']
    // project has no explicit disabledMcpServers here
    expect(isMcpServerDisabled('server-w')).toBe(true)
    setMcpServerEnabled('server-w', true)
    expect(isMcpServerDisabled('server-w')).toBe(false)
  })

  test('enable is idempotent when server is globally disabled', () => {
    getGlobalConfig().disabledMcpServers = ['server-w']
    setMcpServerEnabled('server-w', true)
    setMcpServerEnabled('server-w', true)
    expect(isMcpServerDisabled('server-w')).toBe(false)
  })
})

describe('global fallback disable', () => {
  test('disabling a server when project inherits global disables preserves them', () => {
    getGlobalConfig().disabledMcpServers = ['a']
    // disable a different server 'b' — 'a' should remain disabled locally
    setMcpServerEnabled('b', false)
    expect(isMcpServerDisabled('a')).toBe(true)
    expect(isMcpServerDisabled('b')).toBe(true)
  })

  test('disable propagates to global and preserves existing globals', () => {
    getGlobalConfig().disabledMcpServers = ['a']
    setMcpServerEnabled('b', false)
    expect(getGlobalConfig().disabledMcpServers).toContain('a')
    expect(getGlobalConfig().disabledMcpServers).toContain('b')
  })
})
