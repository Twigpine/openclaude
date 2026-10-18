import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'
import {
  CLAUDE_IN_CHROME_SKILL_HINT,
  CLAUDE_IN_CHROME_SKILL_HINT_WITH_WEBBROWSER,
} from './prompt.js'
import {
  mergeClaudeInChromeStartupConfig,
  resolveClaudeInChromeStartupMode,
} from './startup.js'

async function runSetupFixture(mode: 'existing' | 'missing'): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), 'openclaude chrome setup '))
  const fixturePath = join(scratch, 'setup.fixture.test.ts')
  const configDir = join(scratch, 'config dir')
  const cliEntrypoint = join(scratch, 'package dir', 'bin', 'openclaude')

  try {
    if (mode === 'existing') {
      await Bun.write(cliEntrypoint, '#!/usr/bin/env node\n')
    }
    await Bun.write(
      fixturePath,
      `import { expect, mock, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

mock.module('@ant/claude-for-chrome-mcp', () => ({ BROWSER_TOOLS: [] }))

const envUtilsUrl = process.env.TEST_ENV_UTILS_URL
const setupUrl = process.env.TEST_SETUP_MODULE_URL
if (!envUtilsUrl || !setupUrl) throw new Error('Missing fixture module URL')
process.argv.push('--debug-to-stderr')
const { setClaudeConfigHomeDirForTesting } = await import(envUtilsUrl)
const { setupClaudeInChrome, waitForClaudeInChromeSetup } = await import(setupUrl)

test('isolated Claude-in-Chrome setup', async () => {
  const mode = process.env.TEST_SETUP_MODE
  const configDir = process.env.TEST_CONFIG_DIR!
  const cliEntrypoint = process.env.TEST_CLI_ENTRYPOINT!
  process.argv[1] = cliEntrypoint
  setClaudeConfigHomeDirForTesting(configDir)

  if (mode === 'missing') {
    expect(() => setupClaudeInChrome()).toThrow(
      'Unable to resolve the current OpenClaude CLI entrypoint',
    )
    const wrapperName = process.platform === 'win32'
      ? 'chrome-native-host.bat'
      : 'chrome-native-host'
    expect(existsSync(join(configDir, 'chrome', wrapperName))).toBe(false)
    return
  }

  const setup = setupClaudeInChrome()
  const chromeServer = setup.mcpConfig['claude-in-chrome']
  expect(chromeServer?.type).toBe('stdio')
  if (chromeServer?.type !== 'stdio') {
    throw new Error('Expected the Claude-in-Chrome stdio server')
  }

  const resolvedTarget = chromeServer.args[0]
  expect(resolvedTarget).toBe(cliEntrypoint)
  expect(existsSync(resolvedTarget!)).toBe(true)

  const wrapperName = process.platform === 'win32'
    ? 'chrome-native-host.bat'
    : 'chrome-native-host'
  const wrapperPath = join(configDir, 'chrome', wrapperName)
  await waitForClaudeInChromeSetup()
  expect(existsSync(wrapperPath)).toBe(true)
  const wrapper = await Bun.file(wrapperPath).text()
  expect(wrapper).toContain(resolvedTarget!)
  expect(wrapper).toContain('--chrome-native-host')
})
`,
    )

    const result = spawnSync(process.execPath, ['test', fixturePath], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        CI: '1',
        NO_COLOR: '1',
        HOME: scratch,
        USERPROFILE: scratch,
        APPDATA: join(scratch, 'AppData', 'Roaming'),
        LOCALAPPDATA: join(scratch, 'AppData', 'Local'),
        OPENCLAUDE_SKIP_CHROME_NATIVE_HOST_REGISTRATION: '1',
        TEST_CLI_ENTRYPOINT: cliEntrypoint,
        TEST_CONFIG_DIR: configDir,
        TEST_ENV_UTILS_URL: pathToFileURL(
          join(import.meta.dir, '..', 'envUtils.ts'),
        ).href,
        TEST_SETUP_MODE: mode,
        TEST_SETUP_MODULE_URL: pathToFileURL(join(import.meta.dir, 'setup.ts'))
          .href,
      },
    })
    if (result.status !== 0) {
      throw new Error(
        `Isolated setup fixture failed (status=${result.status ?? 'none'}, signal=${result.signal ?? 'none'}, error=${result.error?.message ?? 'none'}):\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
      )
    }
    if (mode === 'existing') {
      const marker = '[Claude in Chrome] Setup launch configuration: '
      const receiptLine = (result.stderr ?? '')
        .split(/\r?\n/)
        .find(line => line.includes(marker))
      expect(receiptLine).toBeDefined()
      const receipt = JSON.parse(
        receiptLine!.slice(receiptLine!.indexOf(marker) + marker.length),
      )
      expect(receipt.nativeHost.args[0]).toBe(cliEntrypoint)
      expect(receipt.mcpServer.args[0]).toBe(cliEntrypoint)
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

const existingMcpConfig: Record<string, ScopedMcpServerConfig> = {
  existing: {
    type: 'stdio',
    command: 'existing-command',
    args: [],
    scope: 'dynamic',
  },
}

const setupResult = {
  mcpConfig: {
    'claude-in-chrome': {
      type: 'stdio' as const,
      command: 'chrome-command',
      args: ['--chrome'],
      scope: 'dynamic' as const,
    },
  },
  allowedTools: ['mcp__claude-in-chrome__tabs_context_mcp'],
  systemPrompt: 'chrome system prompt',
}

describe('resolveClaudeInChromeStartupMode', () => {
  test('uses explicit Chrome startup only when subscriber access is available', () => {
    expect(
      resolveClaudeInChromeStartupMode({
        explicitEnabled: true,
        autoEnabled: false,
        hasClaudeInChromeAccess: true,
      }),
    ).toBe('explicit')

    expect(
      resolveClaudeInChromeStartupMode({
        explicitEnabled: true,
        autoEnabled: false,
        hasClaudeInChromeAccess: false,
      }),
    ).toBe('disabled')
  })

  test('uses auto Chrome startup only when subscriber access is available', () => {
    expect(
      resolveClaudeInChromeStartupMode({
        explicitEnabled: false,
        autoEnabled: true,
        hasClaudeInChromeAccess: true,
      }),
    ).toBe('auto')

    expect(
      resolveClaudeInChromeStartupMode({
        explicitEnabled: false,
        autoEnabled: true,
        hasClaudeInChromeAccess: false,
      }),
    ).toBe('disabled')
  })

  test('prefers explicit startup over auto startup', () => {
    expect(
      resolveClaudeInChromeStartupMode({
        explicitEnabled: true,
        autoEnabled: true,
        hasClaudeInChromeAccess: true,
      }),
    ).toBe('explicit')
  })
})

describe('mergeClaudeInChromeStartupConfig', () => {
  test('explicit startup merges MCP config, allowed tools, and prepends the Chrome system prompt', () => {
    const merged = mergeClaudeInChromeStartupConfig({
      mode: 'explicit',
      setupResult,
      dynamicMcpConfig: existingMcpConfig,
      appendSystemPrompt: 'existing prompt',
      hasWebBrowserTool: false,
    })

    expect(Object.keys(merged.dynamicMcpConfig)).toEqual([
      'existing',
      'claude-in-chrome',
    ])
    expect(merged.allowedTools).toEqual(setupResult.allowedTools)
    expect(merged.appendSystemPrompt).toBe(
      'chrome system prompt\n\nexisting prompt',
    )
  })

  test('auto startup merges MCP config and appends the Chrome skill hint only for subscribers', () => {
    const merged = mergeClaudeInChromeStartupConfig({
      mode: 'auto',
      setupResult,
      dynamicMcpConfig: existingMcpConfig,
      appendSystemPrompt: 'existing prompt',
      hasWebBrowserTool: false,
    })

    expect(Object.keys(merged.dynamicMcpConfig)).toEqual([
      'existing',
      'claude-in-chrome',
    ])
    expect(merged.allowedTools).toEqual([])
    expect(merged.appendSystemPrompt).toBe(
      `existing prompt\n\n${CLAUDE_IN_CHROME_SKILL_HINT}`,
    )
  })

  test('auto startup uses the WebBrowser-specific hint when that tool is available', () => {
    const merged = mergeClaudeInChromeStartupConfig({
      mode: 'auto',
      setupResult,
      dynamicMcpConfig: {},
      hasWebBrowserTool: true,
    })

    expect(merged.appendSystemPrompt).toBe(
      CLAUDE_IN_CHROME_SKILL_HINT_WITH_WEBBROWSER,
    )
  })
})

describe('setupClaudeInChrome', () => {
  test('uses an existing current CLI entrypoint for npm-style child launches', async () => {
    await runSetupFixture('existing')
  })

  test('does not write a wrapper when the current CLI entrypoint is missing', async () => {
    await runSetupFixture('missing')
  })
})
