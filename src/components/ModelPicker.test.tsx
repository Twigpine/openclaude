import { PassThrough } from 'node:stream'
import { stripVTControlCharacters as stripAnsi } from 'node:util'

import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import React from 'react'

import { render } from '../ink.js'
import { AppStateProvider, getDefaultAppState } from '../state/AppState.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { SWITCH_PROFILE_VALUE_PREFIX } from '../utils/model/modelOptions.js'
import {
  resetSettingsCache,
  setSessionSettingsCache,
} from '../utils/settings/settingsCache.js'
import type { SettingsJson } from '../utils/settings/types.js'

const nonce = `${Date.now()}-${Math.random()}`
const realSettings = {
  ...await import(`../utils/settings/settings.js?real=${nonce}`),
} as typeof import('../utils/settings/settings.js')
const realModelAllowlist = {
  ...await import(`../utils/model/modelAllowlist.js?real=${nonce}`),
} as typeof import('../utils/model/modelAllowlist.js')

type SettingsModule = typeof import('../utils/settings/settings.js')

let actualSettingsModule: SettingsModule | undefined = realSettings
let settingsForTest: SettingsJson = {}

function useSettings(settings: SettingsJson): void {
  settingsForTest = settings
  setSessionSettingsCache({ settings, errors: [] })
}

async function mockSettingsForTest(): Promise<void> {
  actualSettingsModule ??= await import(
    `../utils/settings/settings.ts?modelPickerSettingsActual=${Date.now()}-${Math.random()}`
  )
  mock.module('../utils/settings/settings.js', () => ({
    ...actualSettingsModule!,
    getInitialSettings: () => settingsForTest,
    getSettings_DEPRECATED: () => settingsForTest,
  }))
  mock.module('../utils/model/modelAllowlist.js', () => ({
    isModelAllowed: isModelAllowedForTest,
  }))
}

function isModelAllowedForTest(model: string): boolean {
  const { availableModels } = settingsForTest
  if (!availableModels) {
    return true
  }
  if (availableModels.length === 0) {
    return false
  }

  const normalizedModel = model.trim().toLowerCase()
  return availableModels.some(
    allowed => allowed.trim().toLowerCase() === normalizedModel,
  )
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return
    }
    await Bun.sleep(10)
  }

  throw new Error('Timed out waiting for ModelPicker test condition')
}

beforeEach(async () => {
  await acquireSharedMutationLock('components/ModelPicker.test.tsx')
  mock.restore()
  settingsForTest = {}
  await mockSettingsForTest()
  useSettings({} as SettingsJson)
})

afterEach(() => {
  try {
    mock.restore()
    mock.module('../utils/settings/settings.js', () => realSettings)
    mock.module('../utils/model/modelAllowlist.js', () => realModelAllowlist)
    resetSettingsCache()
    settingsForTest = {}
  } finally {
    releaseSharedMutationLock()
  }
})

test('does not append a blocked current model to filtered override options', async () => {
  useSettings({ availableModels: ['allowed-model'] } as SettingsJson)
  const { ModelPicker } = await import(
    `./ModelPicker.js?blocked-current-${Date.now()}`
  )
  let output = ''
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  const instance = await render(
    <AppStateProvider
      initialState={{
        ...getDefaultAppState(),
        mainLoopModel: 'blocked-model',
      }}
    >
      <ModelPicker
        initial="blocked-model"
        onSelect={() => {}}
        optionsOverride={[
          {
            value: 'allowed-model',
            label: 'Allowed Model',
            description: 'Allowed by policy',
          },
        ]}
      />
    </AppStateProvider>,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
    },
  )

  try {
    await waitForCondition(() => stripAnsi(output).includes('Allowed Model'))
    const rendered = stripAnsi(output)
    expect(rendered).toContain('Allowed Model')
    expect(rendered).not.toContain('blocked-model')
  } finally {
    instance.unmount()
    stdin.end()
    stdout.end()
  }
})

test('matches current model to override options case-insensitively', async () => {
  const { ModelPicker } = await import(
    `./ModelPicker.js?case-current-${Date.now()}`
  )
  let output = ''
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  const instance = await render(
    <AppStateProvider
      initialState={{
        ...getDefaultAppState(),
        mainLoopModel: 'GLM-5.2',
      }}
    >
      <ModelPicker
        initial="GLM-5.2"
        onSelect={() => {}}
        optionsOverride={[
          {
            value: 'glm-5.2',
            label: 'GLM 5.2',
            description: 'Provider: Hicap',
          },
        ]}
      />
    </AppStateProvider>,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
    },
  )

  try {
    await waitForCondition(() => stripAnsi(output).includes('GLM 5.2'))
    const rendered = stripAnsi(output)
    expect(rendered).toContain('GLM 5.2')
    expect(rendered).not.toContain('Current model')
  } finally {
    instance.unmount()
    stdin.end()
    stdout.end()
  }
})

function makeStdio(): {
  stdin: PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdout: PassThrough
  getOutput: () => string
} {
  let output = ''
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  return { stdin, stdout, getOutput: () => output }
}

const CROSS_PROFILE_OPTIONS = [
  {
    value: 'claude-opus-4-6',
    label: 'Active Model',
    description: 'Current profile',
  },
  {
    value: `${SWITCH_PROFILE_VALUE_PREFIX}work:gpt-5.5`,
    label: 'Switch to Work · gpt-5.5',
    description: 'Inactive provider profile',
    // Genuine switch option carries the marker (as production builds it).
    switchToProfileId: 'work',
  },
  {
    // A real custom model id that merely starts with the switch prefix but is
    // NOT a switch option (no switchToProfileId marker). It must stay visible in
    // inline pickers — the filter keys on the marker, not the raw value prefix.
    value: `${SWITCH_PROFILE_VALUE_PREFIX}vendor:gpt-5.4`,
    label: 'Prefixed Custom Model',
    description: 'Literal custom model, not a switch',
  },
]

test('hides cross-profile switch options when allowProfileSwitch is falsy', async () => {
  const { ModelPicker } = await import(
    `./ModelPicker.js?cross-profile-hidden-${Date.now()}`
  )
  const { stdin, stdout, getOutput } = makeStdio()

  const instance = await render(
    <AppStateProvider initialState={getDefaultAppState()}>
      <ModelPicker
        initial="claude-opus-4-6"
        onSelect={() => {}}
        optionsOverride={CROSS_PROFILE_OPTIONS}
      />
    </AppStateProvider>,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
    },
  )

  try {
    await waitForCondition(() => stripAnsi(getOutput()).includes('Active Model'))
    const rendered = stripAnsi(getOutput())
    expect(rendered).toContain('Active Model')
    // The inline picker cannot honor a profile switch, so the marked switch
    // option must never surface.
    expect(rendered).not.toContain('Switch to Work')
    expect(rendered).not.toContain(SWITCH_PROFILE_VALUE_PREFIX)
    // ...but a real custom model that merely starts with the prefix is NOT a
    // switch (no marker) and must remain visible.
    expect(rendered).toContain('Prefixed Custom Model')
  } finally {
    instance.unmount()
    stdin.end()
    stdout.end()
  }
})

test('shows cross-profile switch options when allowProfileSwitch is set', async () => {
  const { ModelPicker } = await import(
    `./ModelPicker.js?cross-profile-shown-${Date.now()}`
  )
  const { stdin, stdout, getOutput } = makeStdio()

  const instance = await render(
    <AppStateProvider initialState={getDefaultAppState()}>
      <ModelPicker
        initial="claude-opus-4-6"
        onSelect={() => {}}
        allowProfileSwitch
        optionsOverride={CROSS_PROFILE_OPTIONS}
      />
    </AppStateProvider>,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
    },
  )

  try {
    await waitForCondition(() =>
      stripAnsi(getOutput()).includes('Switch to Work'),
    )
    const rendered = stripAnsi(getOutput())
    expect(rendered).toContain('Active Model')
    expect(rendered).toContain('Switch to Work')
  } finally {
    instance.unmount()
    stdin.end()
    stdout.end()
  }
})

