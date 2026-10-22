import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
type ConfigModule = typeof import('../../utils/config.js')
type McpConfigModule = typeof import('./config.js')

let realConfig: ConfigModule
let incomingConfig: ConfigModule
let isMcpServerDisabled: McpConfigModule['isMcpServerDisabled']
let setMcpServerEnabled: McpConfigModule['setMcpServerEnabled']

beforeAll(async () => {
  await acquireSharedMutationLock('services/mcp/config.test.ts')
  incomingConfig = { ...await import('../../utils/config.js') }
  realConfig = { ...await import(`../../utils/config.js?real=${Date.now()}-${Math.random()}`) }
  mock.module('../../utils/config.js', () => realConfig)
  const mcpConfig = await import(`./config.js?test=${Date.now()}-${Math.random()}`)
  isMcpServerDisabled = mcpConfig.isMcpServerDisabled
  setMcpServerEnabled = mcpConfig.setMcpServerEnabled
})

afterAll(() => {
  try {
    mock.module('../../utils/config.js', () => incomingConfig)
  } finally {
    releaseSharedMutationLock()
  }
})

let savedNodeEnv: string | undefined
let savedGlobalDisabled: string[] | undefined
let savedProjectDisabled: string[] | undefined
let savedProjectEnabled: string[] | undefined

beforeEach(() => {
  savedNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'test'
  savedGlobalDisabled = realConfig.getGlobalConfig().disabledMcpServers
  savedProjectDisabled = realConfig.getCurrentProjectConfig().disabledMcpServers
  savedProjectEnabled = realConfig.getCurrentProjectConfig().enabledMcpServers
  realConfig.saveGlobalConfig(c => ({ ...c, disabledMcpServers: undefined }))
  realConfig.saveCurrentProjectConfig(c => ({
    ...c,
    disabledMcpServers: undefined,
    enabledMcpServers: undefined,
  }))
})

afterEach(() => {
  realConfig.saveGlobalConfig(c => ({ ...c, disabledMcpServers: savedGlobalDisabled }))
  realConfig.saveCurrentProjectConfig(c => ({
    ...c,
    disabledMcpServers: savedProjectDisabled,
    enabledMcpServers: savedProjectEnabled,
  }))
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = savedNodeEnv
})

test('without project or global lists, servers are enabled', () => {
  expect(isMcpServerDisabled('server')).toBe(false)
  expect(isMcpServerDisabled('')).toBe(false)
})

test('an undefined project list inherits only global disables', () => {
  realConfig.getGlobalConfig().disabledMcpServers = ['a', 'b']
  expect(isMcpServerDisabled('a')).toBe(true)
  expect(isMcpServerDisabled('b')).toBe(true)
  expect(isMcpServerDisabled('other')).toBe(false)
})

test.each([{ list: [] }, { list: ['local'] }])('an explicit project list %j overrides global disables', ({ list }) => {
  realConfig.getGlobalConfig().disabledMcpServers = ['global']
  realConfig.saveCurrentProjectConfig(c => ({ ...c, disabledMcpServers: [...list] }))
  expect(isMcpServerDisabled('global')).toBe(false)
  expect(isMcpServerDisabled('local')).toBe(list.length > 0)
})

test('disabling preserves inherited entries and propagates globally without duplicates', () => {
  realConfig.getGlobalConfig().disabledMcpServers = ['a']
  setMcpServerEnabled('b', false)
  setMcpServerEnabled('b', false)
  expect(isMcpServerDisabled('a')).toBe(true)
  expect(isMcpServerDisabled('b')).toBe(true)
  expect(realConfig.getCurrentProjectConfig().disabledMcpServers).toEqual(['a', 'b'])
  expect(realConfig.getGlobalConfig().disabledMcpServers).toEqual(['a', 'b'])
})

test('toggling an explicit project list preserves its overrides and enables locally', () => {
  realConfig.getGlobalConfig().disabledMcpServers = ['global']
  realConfig.saveCurrentProjectConfig(c => ({ ...c, disabledMcpServers: ['local'] }))
  setMcpServerEnabled('target', false)
  expect(isMcpServerDisabled('target')).toBe(true)
  setMcpServerEnabled('target', true)
  setMcpServerEnabled('target', true)
  expect(isMcpServerDisabled('target')).toBe(false)
  expect(isMcpServerDisabled('local')).toBe(true)
  expect(isMcpServerDisabled('global')).toBe(false)
  expect(realConfig.getGlobalConfig().disabledMcpServers).toEqual(['global', 'target'])
})

test('enabling one inherited server preserves other disables and stays local', () => {
  realConfig.getGlobalConfig().disabledMcpServers = ['a', 'b']
  setMcpServerEnabled('a', true)
  setMcpServerEnabled('a', true)
  expect(isMcpServerDisabled('a')).toBe(false)
  expect(isMcpServerDisabled('b')).toBe(true)
  expect(realConfig.getGlobalConfig().disabledMcpServers).toEqual(['a', 'b'])
})

test('enabling the last inherited server keeps an explicit empty override', () => {
  realConfig.getGlobalConfig().disabledMcpServers = ['a']
  setMcpServerEnabled('a', true)
  expect(realConfig.getCurrentProjectConfig().disabledMcpServers).toEqual([])
  expect(isMcpServerDisabled('a')).toBe(false)
  expect(realConfig.getGlobalConfig().disabledMcpServers).toEqual(['a'])
})
