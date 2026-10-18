import { PassThrough } from 'node:stream'
import { stripVTControlCharacters as stripAnsi } from 'node:util'

import { afterAll, describe, expect, test } from 'bun:test'
import React from 'react'
import type { LocalJSXCommandContext } from '../../commands.js'
import { createRoot } from '../../ink.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../../state/AppState.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import {
  DEFAULT_GLOBAL_CONFIG,
  GLOBAL_CONFIG_KEYS,
  getGlobalConfig,
  isGlobalConfigKey,
  saveGlobalConfig,
  type GlobalConfig,
} from '../../utils/config.js'
import { ThemeProvider } from '../design-system/ThemeProvider.js'
import { Config } from './Config.js'
import { createQueryIdleTimeoutSetting } from './queryIdleTimeoutSetting.js'

await acquireSharedMutationLock(
  'components/Settings/queryIdleTimeoutConfig.test.ts',
)

const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'

function extractLastFrame(output: string): string {
  let lastFrame: string | null = null
  let cursor = 0
  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor)
    if (start === -1) break
    const contentStart = start + SYNC_START.length
    const end = output.indexOf(SYNC_END, contentStart)
    if (end === -1) break
    const frame = output.slice(contentStart, end)
    if (frame.trim()) lastFrame = frame
    cursor = end + SYNC_END.length
  }
  return stripAnsi(lastFrame ?? output)
}

async function waitForFrame(
  getOutput: () => string,
  predicate: (frame: string) => boolean,
): Promise<string> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 3_000) {
    const frame = extractLastFrame(getOutput())
    if (predicate(frame)) return frame
    await Bun.sleep(10)
  }
  throw new Error('Timed out waiting for query idle timeout config frame')
}

afterAll(() => {
  releaseSharedMutationLock()
})

describe('/config query idle timeout', () => {
  test('registers the persisted global preference', () => {
    expect(GLOBAL_CONFIG_KEYS).toContain('queryIdleTimeoutMs')
    expect(isGlobalConfigKey('queryIdleTimeoutMs')).toBe(true)
    expect(DEFAULT_GLOBAL_CONFIG.queryIdleTimeoutMs).toBeUndefined()
  })

  test('selects, persists, and displays the interactive setting', () => {
    let persistedConfig: GlobalConfig = {
      ...DEFAULT_GLOBAL_CONFIG,
      queryIdleTimeoutMs: 5 * 60 * 1000,
    }
    let displayedConfig = persistedConfig
    const loggedValues: number[] = []
    const dependencies = {
      saveGlobalConfig(updater: (current: GlobalConfig) => GlobalConfig) {
        persistedConfig = updater(persistedConfig)
      },
      getGlobalConfig: () => persistedConfig,
      setGlobalConfig(config: GlobalConfig) {
        displayedConfig = config
      },
      logChange(timeoutMs: number) {
        loggedValues.push(timeoutMs)
      },
    }

    const initialSetting = createQueryIdleTimeoutSetting(
      displayedConfig,
      dependencies,
    )
    expect(initialSetting.label).toBe('Query idle timeout')
    expect(initialSetting.value).toBe('5 min')
    expect(initialSetting.options).toContain('15 min')

    initialSetting.onChange('15 min')

    expect(persistedConfig.queryIdleTimeoutMs).toBe(15 * 60 * 1000)
    expect(displayedConfig.queryIdleTimeoutMs).toBe(15 * 60 * 1000)
    expect(loggedValues).toEqual([15 * 60 * 1000])
    expect(
      createQueryIdleTimeoutSetting(displayedConfig, dependencies).value,
    ).toBe('15 min')
  })

  test('renders and changes the setting through the real Config controls', async () => {
    const originalTimeout = getGlobalConfig().queryIdleTimeoutMs
    saveGlobalConfig(current => ({
      ...current,
      queryIdleTimeoutMs: 5 * 60 * 1000,
    }))

    let output = ''
    const stdout = new PassThrough()
    const stdin = new PassThrough() as PassThrough & {
      isTTY: boolean
      setRawMode(mode: boolean): void
      ref(): void
      unref(): void
    }
    stdin.isTTY = true
    stdin.setRawMode = () => {}
    stdin.ref = () => {}
    stdin.unref = () => {}
    ;(stdout as unknown as { columns: number }).columns = 120
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    root.render(
      React.createElement(
        AppStateProvider,
        null,
        React.createElement(
          KeybindingSetup,
          null,
          React.createElement(
            ThemeProvider,
            {
              initialState: 'dark',
              children: React.createElement(Config, {
                onClose: () => {},
                context: {
                  messages: [],
                  options: { mcpClients: [] },
                } as unknown as LocalJSXCommandContext,
                setTabsHidden: () => {},
                contentHeight: 20,
              }),
            },
          ),
        ),
      ),
    )

    try {
      await waitForFrame(
        () => output,
        frame => frame.includes('Search settings'),
      )
      stdin.write('query idle timeout')
      const filteredFrame = await waitForFrame(
        () => output,
        frame =>
          frame.includes('Query idle timeout') && frame.includes('5 min'),
      )
      expect(filteredFrame).toContain('Query idle timeout')

      stdin.write('\x1b[B')
      await waitForFrame(
        () => output,
        frame => frame.includes('change') && frame.includes('save'),
      )
      stdin.write('\x1b[C')

      const changedFrame = await waitForFrame(
        () => output,
        frame =>
          frame.includes('Query idle timeout') && frame.includes('10 min'),
      )
      expect(changedFrame).toContain('10 min')
      expect(getGlobalConfig().queryIdleTimeoutMs).toBe(10 * 60 * 1000)
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      saveGlobalConfig(current => ({
        ...current,
        queryIdleTimeoutMs: originalTimeout,
      }))
      await Bun.sleep(0)
    }
  })
})
