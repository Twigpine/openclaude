import { PassThrough } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'

import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import React from 'react'

import { createRoot } from '../../ink.js'
import { AppStateProvider } from '../../state/AppState.js'
import type { RouteReadinessResult } from '../../integrations/discoveryService.js'
import type {
  ProfileEnv,
  ProfileFile,
  ProviderProfile,
} from '../../utils/providerProfile.js'

const realDiscoveryService = await import(
  '../../integrations/discoveryService.js'
)
const realProviderProfile = await import('../../utils/providerProfile.js')

let probeResult: RouteReadinessResult | null = null
const probeRouteReadiness = mock(
  async (
    _routeId: string,
    _options?: Parameters<
      typeof realDiscoveryService.probeRouteReadiness
    >[1],
  ): Promise<RouteReadinessResult | null> => probeResult,
)

let savedProfileFile: ProfileFile | undefined
const saveProfileFile = mock((profileFile: ProfileFile) => {
  savedProfileFile = profileFile
  return 'test-profile-path'
})

mock.module('../../integrations/discoveryService.js', () => ({
  ...realDiscoveryService,
  probeRouteReadiness,
}))
mock.module('../../utils/providerProfile.js', () => ({
  ...realProviderProfile,
  saveProfileFile,
}))

const { LlamaWindowsModelStep, ProviderWizard } = await import('./provider.js')

function createTestStreams() {
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
    getOutput: () => stripVTControlCharacters(output),
  }
}

async function waitForOutput(
  getOutput: () => string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 2500
  while (Date.now() < deadline) {
    if (getOutput().includes(expected)) {
      return
    }
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for output: ${expected}`)
}

async function renderLlamaStep(
  onSave: (profile: ProviderProfile, env: ProfileEnv) => void,
) {
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  root.render(
    <AppStateProvider>
      <LlamaWindowsModelStep
        onSave={onSave}
        onBack={() => {}}
        onCancel={() => {}}
      />
    </AppStateProvider>,
  )
  return {
    getOutput,
    root,
    stdin,
    async dispose() {
      root.unmount()
      stdin.end()
      stdout.end()
      await Bun.sleep(0)
    },
  }
}

async function renderProviderWizard(onDone: (message?: string) => void) {
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  root.render(
    <AppStateProvider>
      <ProviderWizard onDone={message => onDone(message)} />
    </AppStateProvider>,
  )
  return {
    getOutput,
    root,
    stdin,
    async dispose() {
      root.unmount()
      stdin.end()
      stdout.end()
      await Bun.sleep(0)
    },
  }
}

beforeEach(() => {
  probeResult = null
  probeRouteReadiness.mockClear()
  savedProfileFile = undefined
  saveProfileFile.mockClear()
})

afterAll(() => {
  mock.module('../../integrations/discoveryService.js', () => realDiscoveryService)
  mock.module('../../utils/providerProfile.js', () => realProviderProfile)
})

test('shows an actionable message when the Llama for Windows server is unreachable', async () => {
  probeResult = { state: 'unreachable' }
  const ui = await renderLlamaStep(() => {})

  try {
    await waitForOutput(ui.getOutput, 'Could not reach Llama for Windows')
  } finally {
    await ui.dispose()
  }
})

test('reports when the Llama for Windows server has no models', async () => {
  probeResult = { state: 'no_models' }
  const ui = await renderLlamaStep(() => {})

  try {
    await waitForOutput(ui.getOutput, 'did not report any models')
  } finally {
    await ui.dispose()
  }
})

test('saves the selected model with the Llama for Windows route', async () => {
  probeResult = { state: 'ready', models: ['test-model'] }
  const previousBaseUrl = process.env.LLAMA_WINDOWS_BASE_URL
  delete process.env.LLAMA_WINDOWS_BASE_URL
  let saved:
    | { profile: ProviderProfile; env: ProfileEnv }
    | undefined
  let ui: Awaited<ReturnType<typeof renderLlamaStep>> | undefined

  try {
    ui = await renderLlamaStep((profile, env) => {
      saved = { profile, env }
    })
    await waitForOutput(ui.getOutput, 'test-model')
    ui.stdin.write('1')
    const deadline = Date.now() + 2500
    while (!saved && Date.now() < deadline) {
      await Bun.sleep(10)
    }
    expect(saved).toEqual({
      profile: 'openai',
      env: {
        OPENAI_BASE_URL: 'http://127.0.0.1:9931/v1',
        OPENAI_MODEL: 'test-model',
        CLAUDE_CODE_PROVIDER_ROUTE_ID: 'llama-windows',
      },
    })
  } finally {
    await ui?.dispose()
    if (previousBaseUrl === undefined) {
      delete process.env.LLAMA_WINDOWS_BASE_URL
    } else {
      process.env.LLAMA_WINDOWS_BASE_URL = previousBaseUrl
    }
  }
})

test('saves a Llama for Windows profile through ProviderWizard', async () => {
  probeResult = { state: 'ready', models: ['test-model'] }
  const previousBaseUrl = process.env.LLAMA_WINDOWS_BASE_URL
  delete process.env.LLAMA_WINDOWS_BASE_URL
  let doneMessage: string | undefined
  let ui: Awaited<ReturnType<typeof renderProviderWizard>> | undefined

  try {
    ui = await renderProviderWizard(message => {
      doneMessage = message
    })
    await waitForOutput(ui.getOutput, 'Llama for Windows')
    ui.stdin.write('3')
    await waitForOutput(ui.getOutput, 'Choose a Llama for Windows model')
    await waitForOutput(ui.getOutput, 'test-model')
    ui.stdin.write('1')
    const deadline = Date.now() + 2500
    while (!savedProfileFile && Date.now() < deadline) {
      await Bun.sleep(10)
    }

    expect(savedProfileFile).toMatchObject({
      profile: 'openai',
      env: {
        OPENAI_BASE_URL: 'http://127.0.0.1:9931/v1',
        OPENAI_MODEL: 'test-model',
        CLAUDE_CODE_PROVIDER_ROUTE_ID: 'llama-windows',
      },
    })
    expect(doneMessage).toContain('test-profile-path')
  } finally {
    await ui?.dispose()
    if (previousBaseUrl === undefined) {
      delete process.env.LLAMA_WINDOWS_BASE_URL
    } else {
      process.env.LLAMA_WINDOWS_BASE_URL = previousBaseUrl
    }
  }
})
