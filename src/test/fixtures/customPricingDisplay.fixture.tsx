import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { stripVTControlCharacters as stripAnsi } from 'node:util'
import React from 'react'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import {
  getAllowedSettingSources,
  getFlagSettingsInline,
  getFlagSettingsPath,
  resetModelStringsForTestingOnly,
  setAllowedSettingSources,
  setFlagSettingsInline,
  setFlagSettingsPath,
} from '../../bootstrap/state.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

const originalOpenClaudeConfigDir = process.env.OPENCLAUDE_CONFIG_DIR
const fixtureDir = mkdtempSync(join(tmpdir(), 'openclaude-pricing-display-'))
const userConfigDir = join(fixtureDir, 'user-config')
const pricingSettingsPath = join(fixtureDir, 'pricing-settings.json')
process.env.OPENCLAUDE_CONFIG_DIR = userConfigDir

mock.module('../../utils/model/providers.js', () => ({
  getAPIProvider: () => 'firstParty',
  getAPIProviderForStatsig: () => 'firstParty',
  isFirstPartyAnthropicBaseUrl: () => true,
  isFirstPartyAnthropicProvider: () => true,
  isCustomAnthropicProvider: () => false,
  isGithubNativeAnthropicMode: () => false,
  usesAnthropicAccountFlow: () => true,
}))
mock.module('../../utils/auth.js', () => ({
  getSubscriptionType: () => null,
  isClaudeAISubscriber: () => false,
  isMaxSubscriber: () => false,
  isProSubscriber: () => false,
  isTeamPremiumSubscriber: () => false,
}))
mock.module('../../utils/fastMode.js', () => ({
  clearFastModeCooldown: () => {},
  FAST_MODE_MODEL_DISPLAY: 'Opus 4.8',
  getFastModeModel: () => 'opus',
  getFastModeRuntimeState: () => ({ status: 'active' }),
  getFastModeUnavailableReason: () => null,
  isFastModeEnabled: () => true,
  isFastModeSupportedByModel: () => true,
  prefetchFastModeStatus: async () => {},
}))

const originalSources = [...getAllowedSettingSources()]
const originalFlagPath = getFlagSettingsPath()
const originalFlagInline = getFlagSettingsInline()

function writePricing(opusInput: number, opusOutput: number): void {
  writeFileSync(
    pricingSettingsPath,
    `${JSON.stringify({
      modelPricing: {
        'claude-sonnet-4-6': {
          inputTokens: 9,
          outputTokens: 10,
          promptCacheReadTokens: 0,
          promptCacheWriteTokens: 0,
          webSearchRequests: 0,
        },
        'claude-opus-4-8': {
          inputTokens: opusInput,
          outputTokens: opusOutput,
          promptCacheReadTokens: 0,
          promptCacheWriteTokens: 0,
          webSearchRequests: 0,
        },
      },
    })}\n`,
    'utf8',
  )
}

async function waitFor(
  check: () => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`)
    }
    await Bun.sleep(5)
  }
}

let cleanupRender: (() => void) | undefined

try {
  writePricing(7, 8)
  setAllowedSettingSources(['flagSettings'])
  setFlagSettingsPath(pricingSettingsPath)
  setFlagSettingsInline(null)
  resetSettingsCache()
  resetModelStringsForTestingOnly()

  const {
    getDefaultOptionForUser,
    getMaxOpus46_1MOption,
    getMaxSonnet46_1MOption,
    getOpus46_1MOption,
    getSonnet46_1MOption,
  } = await import('../../utils/model/modelOptions.js')

  assert.match(getDefaultOptionForUser().description, /\$9\/\$10 per Mtok/)
  assert.match(getSonnet46_1MOption().description, /\$9\/\$10 per Mtok/)
  assert.match(getMaxSonnet46_1MOption().description, /\$9\/\$10 per Mtok/)
  assert.match(getOpus46_1MOption(true).description, /\$7\/\$8 per Mtok/)
  assert.match(getMaxOpus46_1MOption(true).description, /\$7\/\$8 per Mtok/)

  const { FastModePicker, handleFastModeShortcut } = await import(
    '../../commands/fast/fast.js'
  )
  const { AppStateProvider, getDefaultAppState, useAppStateStore } =
    await import('../../state/AppState.js')
  const { createRoot } = await import('../../ink.js')
  let appState = getDefaultAppState()
  const shortcut = await handleFastModeShortcut(
    true,
    () => appState,
    update => {
      appState = update(appState)
    },
  )
  assert.match(shortcut, /\$7\/\$8 per Mtok/)
  const isolatedUserSettings = JSON.parse(
    readFileSync(join(userConfigDir, 'settings.json'), 'utf8'),
  ) as Record<string, unknown>
  assert.equal(isolatedUserSettings.fastMode, true)

  let output = ''
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    ref: () => PassThrough
    setRawMode: (mode: boolean) => void
    unref: () => PassThrough
  }
  stdin.isTTY = true
  stdin.ref = () => stdin
  stdin.setRawMode = () => {}
  stdin.unref = () => stdin
  ;(stdout as unknown as { columns: number }).columns = 120
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  const completions: string[] = []
  const onPickerDone = (message: string) => completions.push(message)
  let triggerSettingsReload: (() => void) | undefined
  const PickerWithSettingsReload = () => {
    const store = useAppStateStore()
    triggerSettingsReload = () => {
      store.setState(previous => ({
        ...previous,
        settings: { ...previous.settings },
      }))
    }
    return <FastModePicker onDone={onPickerDone} unavailableReason={null} />
  }
  const picker = () => (
    <AppStateProvider initialState={appState}>
      <KeybindingSetup>
        <PickerWithSettingsReload />
      </KeybindingSetup>
    </AppStateProvider>
  )
  const instance = await createRoot({
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  cleanupRender = () => {
    instance.unmount()
    stdin.end()
    stdout.end()
  }
  instance.render(picker())
  await waitFor(
    () => /\$7\/\$8 per Mtok/.test(stripAnsi(output)),
    'the initial fast-mode pricing render',
  )
  assert.match(stripAnsi(output), /\$7\/\$8 per Mtok/)

  writePricing(17, 18)
  resetSettingsCache()
  output = ''
  assert.ok(triggerSettingsReload)
  triggerSettingsReload()
  await waitFor(
    () => /\$17\/\$18 per Mtok/.test(stripAnsi(output)),
    'the reloaded fast-mode pricing render',
  )
  assert.match(stripAnsi(output), /\$17\/\$18 per Mtok/)

  stdin.write('\r')
  await waitFor(
    () => /\$17\/\$18 per Mtok/.test(completions.at(-1) ?? ''),
    'the fast-mode confirmation',
  )
  assert.match(completions.at(-1) ?? '', /\$17\/\$18 per Mtok/)

  cleanupRender()
  cleanupRender = undefined
} finally {
  cleanupRender?.()
  mock.restore()
  resetModelStringsForTestingOnly()
  setAllowedSettingSources(originalSources)
  setFlagSettingsPath(originalFlagPath)
  setFlagSettingsInline(originalFlagInline)
  resetSettingsCache()
  if (originalOpenClaudeConfigDir === undefined) {
    delete process.env.OPENCLAUDE_CONFIG_DIR
  } else {
    process.env.OPENCLAUDE_CONFIG_DIR = originalOpenClaudeConfigDir
  }
  rmSync(fixtureDir, { recursive: true, force: true })
}
