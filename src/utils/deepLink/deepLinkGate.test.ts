import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { feature } from 'bun:bundle'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { withMockMacro } from '../../test/mockMacro.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import {
  getClaudeConfigHomeDirOverrideForTesting,
  setClaudeConfigHomeDirForTesting,
} from '../envUtils.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import { handleUriArgIfEnabled } from './handleUriArg.js'
import { buildDeepLink, parseDeepLink } from './parseDeepLink.js'
import { ensureDeepLinkProtocolRegistered } from './registerProtocol.js'

const handleDeepLinkUriSpy = mock(async (_uri: string) => 0)
const realProtocolHandler = {
  ...(await import(`./protocolHandler.js?real=${Date.now()}`)),
}
mock.module('./protocolHandler.js', () => ({
  ...realProtocolHandler,
  handleDeepLinkUri: handleDeepLinkUriSpy,
}))
const realConfig = {
  ...(await import(`../config.js?real=${Date.now()}`)),
}
mock.module('../config.js', () => ({
  ...realConfig,
  enableConfigs: () => {},
}))

describe('parseDeepLink', () => {
  test('parses an open action with cwd, repo, and query', () => {
    const action = parseDeepLink(
      'claude-cli://open?cwd=/tmp/work&repo=owner/repo&q=fix%20the%20tests',
    )

    expect(action).toEqual({
      cwd: '/tmp/work',
      repo: 'owner/repo',
      query: 'fix the tests',
    })
  })

  test('round-trips through buildDeepLink', () => {
    const uri = buildDeepLink({ cwd: '/tmp/work', query: 'hello' })

    expect(parseDeepLink(uri)).toEqual({ cwd: '/tmp/work', query: 'hello' })
  })

  test('rejects a relative cwd', () => {
    expect(() => parseDeepLink('claude-cli://open?cwd=relative/path')).toThrow(
      'absolute path',
    )
  })

  test('rejects a malformed repo slug', () => {
    expect(() => parseDeepLink('claude-cli://open?repo=not-a-slug')).toThrow(
      'owner/repo',
    )
  })

  test('rejects unknown actions and wrong schemes', () => {
    expect(() => parseDeepLink('claude-cli://delete')).toThrow(
      'Unknown deep link action',
    )
    expect(() => parseDeepLink('https://open')).toThrow('claude-cli')
  })
})

describe('LODESTONE gate', () => {
  test('loads the registration module only when the flag is on', async () => {
    const { registerProtocolModule } = await import(
      '../backgroundHousekeeping.js'
    )

    if (feature('LODESTONE')) {
      expect(registerProtocolModule).not.toBeNull()
      expect(
        typeof registerProtocolModule!.ensureDeepLinkProtocolRegistered,
      ).toBe('function')
    } else {
      expect(registerProtocolModule).toBeNull()
    }
  })
})

describe('handleUriArgIfEnabled gate', () => {
  test('dispatches --handle-uri to the deep-link handler only when the flag is on', async () => {
    handleDeepLinkUriSpy.mockClear()
    const code = await handleUriArgIfEnabled([
      'node',
      'openclaude',
      '--handle-uri',
      'claude-cli://open?cwd=/tmp',
    ])

    if (feature('LODESTONE')) {
      expect(handleDeepLinkUriSpy).toHaveBeenCalledWith(
        'claude-cli://open?cwd=/tmp',
      )
      expect(code).toBe(0)
    } else {
      expect(handleDeepLinkUriSpy).not.toHaveBeenCalled()
      expect(code).toBeUndefined()
    }
  })

  test('ignores a missing or absent uri argument', async () => {
    handleDeepLinkUriSpy.mockClear()
    expect(await handleUriArgIfEnabled(['node', 'openclaude'])).toBeUndefined()
    expect(
      await handleUriArgIfEnabled(['node', 'openclaude', '--handle-uri']),
    ).toBeUndefined()
    expect(handleDeepLinkUriSpy).not.toHaveBeenCalled()
  })
})

const originalEnv = {
  HOME: process.env.HOME,
  OPENCLAUDE_CONFIG_DIR: process.env.OPENCLAUDE_CONFIG_DIR,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
}

describe('ensureDeepLinkProtocolRegistered opt-out', () => {
  let tempDir: string
  let configDir: string
  let dataDir: string
  let previousConfigHomeOverride: string | undefined

  const desktopPath = () =>
    join(dataDir, 'applications', 'claude-code-url-handler.desktop')
  const markerPath = () => join(configDir, '.deep-link-register-failed')

  beforeEach(async () => {
    await acquireSharedMutationLock('deepLinkGate.test.ts')
    tempDir = await mkdtemp(join(tmpdir(), 'openclaude-deeplink-gate-'))
    configDir = join(tempDir, '.openclaude')
    dataDir = join(tempDir, 'xdg-data')
    previousConfigHomeOverride = getClaudeConfigHomeDirOverrideForTesting()
    setClaudeConfigHomeDirForTesting(configDir)
    process.env.HOME = tempDir
    process.env.OPENCLAUDE_CONFIG_DIR = configDir
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.XDG_DATA_HOME = dataDir
    process.env.XDG_CONFIG_HOME = join(tempDir, 'xdg-config')
    resetSettingsCache()
  })

  afterEach(async () => {
    setClaudeConfigHomeDirForTesting(previousConfigHomeOverride)
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    resetSettingsCache()
    try {
      await rm(tempDir, { recursive: true, force: true })
    } finally {
      releaseSharedMutationLock()
    }
  })

  test('skips registration when disableDeepLinkRegistration is set', async () => {
    await mkdir(configDir, { recursive: true })
    await writeFile(
      join(configDir, 'settings.json'),
      JSON.stringify({ disableDeepLinkRegistration: 'disable' }),
    )
    resetSettingsCache()

    await withMockMacro({ PACKAGE_URL: 'Gitlawb/openclaude' }, () =>
      ensureDeepLinkProtocolRegistered(),
    )

    expect(existsSync(desktopPath())).toBe(false)
    expect(existsSync(markerPath())).toBe(false)
  })

  test('attempts OS registration when not opted out', async () => {
    if (process.platform !== 'linux') return

    await withMockMacro({ PACKAGE_URL: 'Gitlawb/openclaude' }, () =>
      ensureDeepLinkProtocolRegistered(),
    )

    // Registration writes the .desktop artifact before any optional
    // xdg-mime call, so the file exists whether or not xdg-utils is
    // installed.
    expect(existsSync(desktopPath())).toBe(true)
  })
})
