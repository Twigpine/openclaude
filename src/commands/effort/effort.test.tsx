import { PassThrough } from 'node:stream'

import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import React from 'react'

import { render } from '../../ink.js'
import { AppStateProvider, getDefaultAppState } from '../../state/AppState.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'

const nonce = `${Date.now()}-${Math.random()}`
const actualAuth = {
  ...await import(`../../utils/auth.js?real=${nonce}`),
} as typeof import('../../utils/auth.js')
const actualModelSupportOverrides = {
  ...await import(`../../utils/model/modelSupportOverrides.js?real=${nonce}`),
} as typeof import('../../utils/model/modelSupportOverrides.js')
const actualSettings = {
  ...await import(`../../utils/settings/settings.js?real=${nonce}`),
} as typeof import('../../utils/settings/settings.js')
const actualThinking = {
  ...await import(`../../utils/thinking.js?real=${nonce}`),
} as typeof import('../../utils/thinking.js')
const actualGrowthbook = {
  ...await import(`../../services/analytics/growthbook.js?real=${nonce}`),
} as typeof import('../../services/analytics/growthbook.js')
const realEffortPicker = {
  ...await import(`../../components/EffortPicker.js?real=${nonce}`),
} as typeof import('../../components/EffortPicker.js')

const providerSpecifier = '../../utils/model/providers.js'
const realProvidersForCleanup = {
  ...await import(
    `${providerSpecifier}?real=${Date.now()}-${Math.random()}`
  ),
}

afterAll(() => {
  mock.restore()
  mock.module(providerSpecifier, () => realProvidersForCleanup)
})

const actualProviders = realProvidersForCleanup

const originalEffortEnv = process.env.CLAUDE_CODE_EFFORT_LEVEL

beforeEach(async () => {
  await acquireSharedMutationLock('commands/effort/effort.test.tsx')
  delete process.env.CLAUDE_CODE_EFFORT_LEVEL
})

afterEach(() => {
  try {
    mock.restore()
    mock.module('../../utils/auth.js', () => actualAuth)
    mock.module('../../utils/model/modelSupportOverrides.js', () => actualModelSupportOverrides)
    mock.module('../../utils/settings/settings.js', () => actualSettings)
    mock.module('../../utils/thinking.js', () => actualThinking)
    mock.module('../../services/analytics/growthbook.js', () => actualGrowthbook)
    mock.module('../../utils/model/providers.js', () => realProvidersForCleanup)
    mock.module('../../components/EffortPicker.js', () => realEffortPicker)
    if (originalEffortEnv === undefined) {
      delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    } else {
      process.env.CLAUDE_CODE_EFFORT_LEVEL = originalEffortEnv
    }
  } finally {
    releaseSharedMutationLock()
  }
})

async function importFreshEffortCommandModule(): Promise<
  typeof import('./effort.js')
> {
  mock.module('../../utils/model/providers.js', () => ({
    ...actualProviders,
    getAPIProvider: () => 'firstParty',
  }))
  mock.module('../../utils/model/modelSupportOverrides.js', () => ({
    ...actualModelSupportOverrides,
    get3PModelCapabilityOverride: () => undefined,
  }))
  mock.module('../../utils/settings/settings.js', () => ({
    ...actualSettings,
    updateSettingsForSource: () => ({ error: null }),
  }))
  mock.module('../../utils/auth.js', () => ({
    ...actualAuth,
    isProSubscriber: () => false,
    isMaxSubscriber: () => false,
    isTeamSubscriber: () => false,
  }))
  mock.module('../../utils/thinking.js', () => ({
    ...actualThinking,
    isUltrathinkEnabled: () => false,
  }))
  mock.module('../../services/analytics/growthbook.js', () => ({
    ...actualGrowthbook,
    getFeatureValue_CACHED_MAY_BE_STALE: (_key: string, fallback: unknown) =>
      fallback,
  }))

  return import(`./effort.js?ts=${Date.now()}-${Math.random()}`) as Promise<
    typeof import('./effort.js')
  >
}

function createTestStreams(): {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
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

  return {
    stdout,
    stdin,
    getOutput: () => output,
  }
}

test('/effort ultracode reports unavailable for a model without ultracode support', async () => {
  const { call } = await importFreshEffortCommandModule()
  const messages: (string | undefined)[] = []
  const onDone = (result?: string) => {
    messages.push(result)
  }

  const element = await call(onDone, {}, 'ultracode')
  const { stdout, stdin } = createTestStreams()

  const instance = await render(
    <AppStateProvider
      initialState={{
        ...getDefaultAppState(),
        mainLoopModelForSession: 'claude-sonnet-4-6',
      }}
    >
      {element}
    </AppStateProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    },
  )

  // Let the mount effect that calls onDone() flush before asserting.
  await Bun.sleep(10)
  instance.unmount()
  stdin.end()
  stdout.end()

  expect(messages).toEqual([
    'ultracode is not available for your current model and provider. Use /effort without arguments to see available options.',
  ])
})

test('/effort ultracode applies the ultracode session effort when available', async () => {
  const { call } = await importFreshEffortCommandModule()
  const messages: (string | undefined)[] = []
  const onDone = (result?: string) => {
    messages.push(result)
  }

  const element = await call(onDone, {}, 'ultracode')
  const { stdout, stdin } = createTestStreams()

  let finalEffortValue: string | number | undefined
  const instance = await render(
    <AppStateProvider
      initialState={{
        ...getDefaultAppState(),
        mainLoopModelForSession: 'claude-opus-4-8',
      }}
      onChangeAppState={({ newState }) => {
        finalEffortValue = newState.effortValue
      }}
    >
      {element}
    </AppStateProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    },
  )

  // Let the mount effect that calls onDone() flush before asserting.
  await Bun.sleep(10)
  instance.unmount()
  stdin.end()
  stdout.end()

  expect(messages).toHaveLength(1)
  expect(messages[0]).toMatch(/^Set effort level to ultracode/)
  expect(finalEffortValue).toBe('ultracode')
})

test('/effort picker reports env override when selecting ultracode', async () => {
  mock.module('../../components/EffortPicker.js', () => ({
    EffortPicker: ({ onSelect }: { onSelect: (effort: string) => void }) => {
      React.useEffect(() => {
        onSelect('ultracode')
      }, [onSelect])
      return null
    },
  }))

  const { call } = await importFreshEffortCommandModule()
  const messages: (string | undefined)[] = []
  const onDone = (result?: string) => {
    messages.push(result)
  }

  process.env.CLAUDE_CODE_EFFORT_LEVEL = 'high'
  const element = await call(onDone, {}, '')
  const { stdout, stdin } = createTestStreams()

  let finalEffortValue: string | number | undefined
  const instance = await render(
    <AppStateProvider
      initialState={{
        ...getDefaultAppState(),
        mainLoopModelForSession: 'claude-opus-4-8',
      }}
      onChangeAppState={({ newState }) => {
        finalEffortValue = newState.effortValue
      }}
    >
      {element}
    </AppStateProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    },
  )

  await Bun.sleep(10)
  instance.unmount()
  stdin.end()
  stdout.end()

  expect(messages).toEqual([
    'Not applied: CLAUDE_CODE_EFFORT_LEVEL=high overrides effort this session, and ultracode is session-only (nothing saved)',
  ])
  expect(finalEffortValue).toBe('ultracode')
})
