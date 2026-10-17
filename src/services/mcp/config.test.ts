import { feature } from 'bun:bundle'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import {
  getCurrentProjectConfig,
  getGlobalConfig,
  saveCurrentProjectConfig,
  saveGlobalConfig,
} from '../../utils/config.js'
import { isMcpServerDisabled, setMcpServerEnabled } from './config.js'

let savedNodeEnv: string | undefined
let savedGlobalDisabled: string[] | undefined
let savedProjectDisabled: string[] | undefined
let savedProjectEnabled: string[] | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('services/mcp/config.test.ts')
  savedNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'test'
  savedGlobalDisabled = getGlobalConfig().disabledMcpServers
  savedProjectDisabled = getCurrentProjectConfig().disabledMcpServers
  savedProjectEnabled = getCurrentProjectConfig().enabledMcpServers
  saveGlobalConfig(c => ({ ...c, disabledMcpServers: undefined }))
  saveCurrentProjectConfig(c => ({
    ...c,
    disabledMcpServers: undefined,
    enabledMcpServers: undefined,
  }))
})

afterEach(() => {
  try {
    saveGlobalConfig(c => ({ ...c, disabledMcpServers: savedGlobalDisabled }))
    saveCurrentProjectConfig(c => ({
      ...c,
      disabledMcpServers: savedProjectDisabled,
      enabledMcpServers: savedProjectEnabled,
    }))
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = savedNodeEnv
  } finally {
    releaseSharedMutationLock()
  }
})

test('without project or global lists, servers are enabled', () => {
  expect(isMcpServerDisabled('server')).toBe(false)
  expect(isMcpServerDisabled('')).toBe(false)
})

test('an undefined project list inherits only global disables', () => {
  getGlobalConfig().disabledMcpServers = ['a', 'b']
  expect(isMcpServerDisabled('a')).toBe(true)
  expect(isMcpServerDisabled('b')).toBe(true)
  expect(isMcpServerDisabled('other')).toBe(false)
})

test.each([{ list: [] }, { list: ['local'] }])('an explicit project list %j overrides global disables', ({ list }) => {
  getGlobalConfig().disabledMcpServers = ['global']
  saveCurrentProjectConfig(c => ({ ...c, disabledMcpServers: [...list] }))
  expect(isMcpServerDisabled('global')).toBe(false)
  expect(isMcpServerDisabled('local')).toBe(list.length > 0)
})

test('disabling preserves inherited entries and propagates globally without duplicates', () => {
  getGlobalConfig().disabledMcpServers = ['a']
  setMcpServerEnabled('b', false)
  setMcpServerEnabled('b', false)
  expect(isMcpServerDisabled('a')).toBe(true)
  expect(isMcpServerDisabled('b')).toBe(true)
  expect(getCurrentProjectConfig().disabledMcpServers).toEqual(['a', 'b'])
  expect(getGlobalConfig().disabledMcpServers).toEqual(['a', 'b'])
})

test('toggling an explicit project list preserves its overrides and enables locally', () => {
  getGlobalConfig().disabledMcpServers = ['global']
  saveCurrentProjectConfig(c => ({ ...c, disabledMcpServers: ['local'] }))
  setMcpServerEnabled('target', false)
  expect(isMcpServerDisabled('target')).toBe(true)
  setMcpServerEnabled('target', true)
  setMcpServerEnabled('target', true)
  expect(isMcpServerDisabled('target')).toBe(false)
  expect(isMcpServerDisabled('local')).toBe(true)
  expect(isMcpServerDisabled('global')).toBe(false)
  expect(getGlobalConfig().disabledMcpServers).toEqual(['global', 'target'])
})

test('enabling one inherited server preserves other disables and stays local', () => {
  getGlobalConfig().disabledMcpServers = ['a', 'b']
  setMcpServerEnabled('a', true)
  setMcpServerEnabled('a', true)
  expect(isMcpServerDisabled('a')).toBe(false)
  expect(isMcpServerDisabled('b')).toBe(true)
  expect(getGlobalConfig().disabledMcpServers).toEqual(['a', 'b'])
})

test('enabling the last inherited server keeps an explicit empty override', () => {
  getGlobalConfig().disabledMcpServers = ['a']
  setMcpServerEnabled('a', true)
  expect(getCurrentProjectConfig().disabledMcpServers).toEqual([])
  expect(isMcpServerDisabled('a')).toBe(false)
  expect(getGlobalConfig().disabledMcpServers).toEqual(['a'])
})

test.skipIf(feature('CHICAGO_MCP') ? false : true)('builtin toggles leave disabled lists unchanged', () => {
  getGlobalConfig().disabledMcpServers = ['computer-use', 'other']
  expect(isMcpServerDisabled('computer-use')).toBe(true)
  setMcpServerEnabled('computer-use', true)
  expect(isMcpServerDisabled('computer-use')).toBe(false)
  setMcpServerEnabled('computer-use', false)
  expect(isMcpServerDisabled('computer-use')).toBe(true)
  expect(getGlobalConfig().disabledMcpServers).toEqual(['computer-use', 'other'])
  expect(getCurrentProjectConfig().disabledMcpServers).toBeUndefined()
})
