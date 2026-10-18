import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import React from 'react'
import { stripVTControlCharacters as stripAnsi } from 'node:util'

import { type Instance, createRoot, render, useApp } from '../../ink.js'
import { AppStateProvider } from '../../state/AppState.js'
import {
  applySavedProfileToCurrentSession,
  buildCodexOAuthProfileEnv,
  buildCurrentProviderSummary,
  buildProfileSaveMessage,
  buildProviderManagerCompletion,
  CodexCredentialStep,
  getProviderWizardDefaults,
  ProviderWizard,
  TextEntryDialog,
} from './provider.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { createProfileFile } from '../../utils/providerProfile.js'

const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'
const ORIGINAL_SIMPLE_ENV = process.env.CLAUDE_CODE_SIMPLE
const ORIGINAL_CODEX_API_KEY = process.env.CODEX_API_KEY
const ORIGINAL_CHATGPT_ACCOUNT_ID = process.env.CHATGPT_ACCOUNT_ID
const ORIGINAL_CODEX_ACCOUNT_ID = process.env.CODEX_ACCOUNT_ID

async function importFreshProviderProfileModule(
  suffix: string,
): Promise<typeof import('../../utils/providerProfile.js')> {
  return import(`../../utils/providerProfile.js?${suffix}`) as Promise<
    typeof import('../../utils/providerProfile.js')
  >
}

function extractLastFrame(output: string): string {
  let lastFrame: string | null = null
  let cursor = 0

  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor)
    if (start === -1) {
      break
    }

    const contentStart = start + SYNC_START.length
    const end = output.indexOf(SYNC_END, contentStart)
    if (end === -1) {
      break
    }

    const frame = output.slice(contentStart, end)
    if (frame.trim().length > 0) {
      lastFrame = frame
    }
    cursor = end + SYNC_END.length
  }

  return lastFrame ?? output
}

async function renderFinalFrame(
  node: React.ReactNode,
): Promise<{ output: string; instance: Instance }> {
  const { stdout, stdin, getOutput } = createTestStreams()

  const instance = await render(node, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  // Timeout guard: if render throws before exit effect fires, don't hang
  await Promise.race([
    instance.waitUntilExit(),
    new Promise<void>(resolve => setTimeout(resolve, 3000)),
  ])
  return { output: stripAnsi(extractLastFrame(getOutput())), instance }
}

async function waitForOutput(
  getOutput: () => string,
  predicate: (output: string) => boolean,
  timeoutMs = 2500,
): Promise<string> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const output = stripAnsi(extractLastFrame(getOutput()))
    if (predicate(output)) {
      return output
    }
    await Bun.sleep(10)
  }

  throw new Error('Timed out waiting for ProviderWizard test output')
}

async function renderProviderWizardFrame(): Promise<string> {
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  root.render(
    <AppStateProvider>
      <ProviderWizard onDone={() => {}} />
    </AppStateProvider>,
  )

  try {
    return await waitForOutput(
      getOutput,
      output => output.includes('Set up a provider profile'),
    )
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await Bun.sleep(0)
  }
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

beforeEach(async () => {
  await acquireSharedMutationLock('commands/provider/provider.test.tsx')
})

afterEach(() => {
  try {
    mock.restore()

    if (ORIGINAL_SIMPLE_ENV === undefined) {
      delete process.env.CLAUDE_CODE_SIMPLE
    } else {
      process.env.CLAUDE_CODE_SIMPLE = ORIGINAL_SIMPLE_ENV
    }

    if (ORIGINAL_CODEX_API_KEY === undefined) {
      delete process.env.CODEX_API_KEY
    } else {
      process.env.CODEX_API_KEY = ORIGINAL_CODEX_API_KEY
    }

    if (ORIGINAL_CHATGPT_ACCOUNT_ID === undefined) {
      delete process.env.CHATGPT_ACCOUNT_ID
    } else {
      process.env.CHATGPT_ACCOUNT_ID = ORIGINAL_CHATGPT_ACCOUNT_ID
    }

    if (ORIGINAL_CODEX_ACCOUNT_ID === undefined) {
      delete process.env.CODEX_ACCOUNT_ID
    } else {
      process.env.CODEX_ACCOUNT_ID = ORIGINAL_CODEX_ACCOUNT_ID
    }
  } finally {
    releaseSharedMutationLock()
  }
})

function StepChangeHarness(): React.ReactNode {
  const { exit } = useApp()
  const [step, setStep] = React.useState<'api' | 'model'>('api')

  React.useLayoutEffect(() => {
    if (step === 'api') {
      setStep('model')
      return
    }

    const timer = setTimeout(exit, 0)
    return () => clearTimeout(timer)
  }, [exit, step])

  return (
    <AppStateProvider>
      <TextEntryDialog
        title="Provider"
        subtitle={step === 'api' ? 'API key step' : 'Model step'}
        description="Enter the next value"
        initialValue={step === 'api' ? 'stale-secret-key' : 'fresh-model-name'}
        mask={step === 'api' ? '*' : undefined}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    </AppStateProvider>
  )
}

test('TextEntryDialog resets its input state when initialValue changes', async () => {
  const { output } = await renderFinalFrame(<StepChangeHarness />)

  expect(output).toContain('Model step')
  expect(output).toContain('fresh-model-name')
  expect(output).not.toContain('stale-secret-key')
})

test('wizard step remount prevents a typed API key from leaking into the next field', async () => {
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  root.render(
    <AppStateProvider>
      <TextEntryDialog
        resetStateKey="api"
        title="Provider"
        subtitle="API key step"
        description="Enter the API key"
        initialValue=""
        mask="*"
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    </AppStateProvider>,
  )

  await waitForOutput(getOutput, output => output.includes('API key step'))
  stdin.write('sk-secret-12345678')
  await waitForOutput(getOutput, output => output.includes('********'))

  root.render(
    <AppStateProvider>
      <TextEntryDialog
        resetStateKey="model"
        title="Provider"
        subtitle="Model step"
        description="Enter the model"
        initialValue=""
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    </AppStateProvider>,
  )

  const output = await waitForOutput(
    getOutput,
    frame => frame.includes('Model step') && !frame.includes('sk-secret-12345678'),
  )
  root.unmount()
  stdin.end()
  stdout.end()

  expect(output).toContain('Model step')
  expect(output).not.toContain('sk-secret-12345678')
})

test('buildProviderManagerCompletion records provider switch event and model-visible reminder', () => {
  const completion = buildProviderManagerCompletion({
    action: 'activated',
    activeProviderName: 'Sadaf Provider',
    activeProviderModel: 'sadaf-model',
    message: 'Provider switched to Sadaf Provider (sadaf-model)',
  })

  expect(completion.message).toBe(
    'Provider switched to Sadaf Provider (sadaf-model)',
  )
  expect(completion.metaMessages).toEqual([
    '<system-reminder>Provider switched mid-session to Sadaf Provider using model sadaf-model. Use this provider/model for subsequent requests unless the user switches again.</system-reminder>',
  ])
})

test('buildProviderManagerCompletion skips provider reminder when manager is cancelled', () => {
  const completion = buildProviderManagerCompletion({
    action: 'cancelled',
    message: 'Provider manager closed',
  })

  expect(completion.message).toBe('Provider manager closed')
  expect(completion.metaMessages).toBeUndefined()
})

test('buildProfileSaveMessage maps provider fields without echoing secrets', () => {
  const message = buildProfileSaveMessage(
    'openai',
    {
      OPENAI_API_KEY: 'sk-secret-12345678',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
    },
    'D:/codings/Opensource/openclaude/.openclaude-profile.json',
  )

  expect(message).toContain('Saved OpenAI profile.')
  expect(message).toContain('Model: gpt-4o')
  expect(message).toContain('Endpoint: https://api.openai.com/v1')
  expect(message).toContain('Credentials: configured')
  expect(message).not.toContain('sk-secret-12345678')
})

test('buildProfileSaveMessage reports pooled OpenAI credentials as configured', () => {
  const message = buildProfileSaveMessage(
    'openai',
    {
      OPENAI_API_KEYS: 'sk-secret-a,sk-secret-b',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
    },
    'D:/codings/Opensource/openclaude/.openclaude-profile.json',
  )

  expect(message).toContain('Saved OpenAI profile.')
  expect(message).toContain('Credentials: configured')
  expect(message).not.toContain('sk-secret-a')
  expect(message).not.toContain('sk-secret-b')
})
test('buildProfileSaveMessage redacts individual pooled OpenAI credentials in display fields', () => {
  const message = buildProfileSaveMessage(
    'openai',
    {
      OPENAI_API_KEYS: 'lowercasecredentialaaaaaaaaaaaa,lowercasecredentialbbbbbbbbbbbb',
      OPENAI_MODEL: 'lowercasecredentialaaaaaaaaaaaa',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
    },
    'D:/codings/Opensource/openclaude/.openclaude-profile.json',
  )

  expect(message).toContain('Saved OpenAI profile.')
  expect(message).not.toContain('lowercasecredentialaaaaaaaaaaaa')
  expect(message).not.toContain('lowercasecredentialbbbbbbbbbbbb')
  expect(message).toContain('Model: low...aaa')
})
test('buildProfileSaveMessage ignores delimiter-only pooled OpenAI credentials', () => {
  const message = buildProfileSaveMessage(
    'openai',
    {
      OPENAI_API_KEYS: ', ,',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
    },
    'D:/codings/Opensource/openclaude/.openclaude-profile.json',
  )

  expect(message).toContain('Saved OpenAI profile.')
  expect(message).not.toContain('Credentials: configured')
})
test('buildProfileSaveMessage labels local openai-compatible profiles consistently', () => {
  const message = buildProfileSaveMessage(
    'openai',
    {
      OPENAI_MODEL: 'gpt-5.4',
      OPENAI_BASE_URL: 'http://127.0.0.1:8080/v1',
    },
    'D:/codings/Opensource/openclaude/.openclaude-profile.json',
  )

  expect(message).toContain('Saved Local OpenAI-compatible profile.')
  expect(message).toContain('Model: gpt-5.4')
  expect(message).toContain('Endpoint: http://127.0.0.1:8080/v1')
})

test('buildProfileSaveMessage labels descriptor-backed gateway profiles consistently', () => {
  const message = buildProfileSaveMessage(
    'openai',
    {
      OPENAI_API_KEY: 'sk-secret-12345678',
      OPENAI_MODEL: 'openai/gpt-5-mini',
      OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
    },
    'D:/codings/Opensource/openclaude/.openclaude-profile.json',
  )

  expect(message).toContain('Saved OpenRouter profile.')
  expect(message).toContain('Model: openai/gpt-5-mini')
  expect(message).toContain('Endpoint: https://openrouter.ai/api/v1')
  expect(message).toContain('Credentials: configured')
  expect(message).not.toContain('sk-secret-12345678')
})

test('buildProfileSaveMessage labels descriptor-backed Venice profiles consistently', () => {
  const message = buildProfileSaveMessage(
    'openai',
    {
      OPENAI_API_KEY: 'sk-venice-secret-12345678',
      VENICE_API_KEY: 'sk-venice-secret-12345678',
      OPENAI_MODEL: 'venice-uncensored',
      OPENAI_BASE_URL: 'https://api.venice.ai/api/v1',
    },
    'D:/codings/Opensource/openclaude/.openclaude-profile.json',
  )

  expect(message).toContain('Saved Venice profile.')
  expect(message).toContain('Model: venice-uncensored')
  expect(message).toContain('Endpoint: https://api.venice.ai/api/v1')
  expect(message).toContain('Credentials: configured')
  expect(message).not.toContain('sk-venice-secret-12345678')
})

test('buildProfileSaveMessage labels descriptor-backed Cloudflare Workers AI profiles consistently', () => {
  // Cloudflare URLs embed the user's account id, so the saved profile reflects
  // the literal substituted URL. Make sure the label still routes through the
  // descriptor preset rather than falling back to a generic "OpenAI-compatible"
  // string, matching the Venice / MiMo / Bankr coverage above.
  const message = buildProfileSaveMessage(
    'openai',
    {
      OPENAI_API_KEY: 'cf-secret-token-12345678',
      CLOUDFLARE_API_TOKEN: 'cf-secret-token-12345678',
      OPENAI_MODEL: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      OPENAI_BASE_URL:
        'https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1',
    },
    'D:/codings/Opensource/openclaude/.openclaude-profile.json',
  )

  expect(message).toContain('Saved Cloudflare Workers AI profile.')
  expect(message).toContain('Model: @cf/meta/llama-3.3-70b-instruct-fp8-fast')
  expect(message).toContain(
    'Endpoint: https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1',
  )
  expect(message).toContain('Credentials: configured')
  expect(message).not.toContain('cf-secret-token-12345678')
})

test('buildProfileSaveMessage describes Gemini access token / ADC mode clearly', () => {
  const message = buildProfileSaveMessage(
    'gemini',
    {
      GEMINI_AUTH_MODE: 'access-token',
      GEMINI_MODEL: 'gemini-2.5-flash',
      GEMINI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    },
    'D:/codings/Opensource/openclaude/.openclaude-profile.json',
  )

  expect(message).toContain('Saved Google AI / Gemini profile.')
  expect(message).toContain('Model: gemini-2.5-flash')
  expect(message).toContain('Credentials: access token (stored securely)')
  expect(message).not.toContain('AIza')
})

test('buildProfileSaveMessage reflects immediate Codex activation for existing credentials', () => {
  const message = buildProfileSaveMessage(
    'codex',
    {
      OPENAI_MODEL: 'codexplan',
      OPENAI_BASE_URL: 'https://chatgpt.com/backend-api/codex',
      CHATGPT_ACCOUNT_ID: 'acct_codex',
    },
    'D:/codings/Opensource/openclaude/.openclaude-profile.json',
    {
      activatedInSession: true,
    },
  )

  expect(message).toContain('Saved Codex profile.')
  expect(message).toContain('OpenClaude switched to it for this session.')
  expect(message).not.toContain('Restart OpenClaude to use it.')
})

test('buildProfileSaveMessage reflects immediate Codex OAuth activation when the session switched successfully', () => {
  const message = buildProfileSaveMessage(
    'codex',
    {
      OPENAI_MODEL: 'codexplan',
      OPENAI_BASE_URL: 'https://chatgpt.com/backend-api/codex',
      CHATGPT_ACCOUNT_ID: 'acct_codex',
      CODEX_CREDENTIAL_SOURCE: 'oauth',
    },
    'D:/codings/Opensource/openclaude/.openclaude-profile.json',
    {
      activatedInSession: true,
    },
  )

  expect(message).toContain('Saved Codex profile.')
  expect(message).toContain('OpenClaude switched to it for this session.')
  expect(message).not.toContain('Restart OpenClaude to use it.')
})

test('buildCodexOAuthProfileEnv uses the fresh OAuth account id without persisting an API key', () => {
  process.env.CODEX_API_KEY = 'stale-codex-key'
  process.env.CHATGPT_ACCOUNT_ID = 'acct_stale'

  const env = buildCodexOAuthProfileEnv({
    accessToken: 'oauth-access-token',
    accountId: 'acct_oauth',
  })

  expect(env).toEqual({
    OPENAI_BASE_URL: 'https://chatgpt.com/backend-api/codex',
    OPENAI_MODEL: 'codexplan',
    CHATGPT_ACCOUNT_ID: 'acct_oauth',
    CODEX_CREDENTIAL_SOURCE: 'oauth',
  })
  expect(env).not.toHaveProperty('CODEX_API_KEY')
})

test('buildCodexProfileEnv derives oauth source from secure storage when no explicit source is provided', async () => {
  const actualProviderConfig = await import('../../services/api/providerConfig.js')

  mock.module('../../services/api/providerConfig.js', () => ({
    ...actualProviderConfig,
    resolveCodexApiCredentials: () => ({
      apiKey: 'stored-access-token',
      accountId: 'acct_secure_storage',
      source: 'secure-storage' as const,
    }),
  }))

  const { buildCodexProfileEnv } = await importFreshProviderProfileModule(
    'secure-storage-codex-source',
  )

  const env = buildCodexProfileEnv({
    model: 'codexplan',
    processEnv: {},
  })

  expect(env).toEqual({
    OPENAI_BASE_URL: 'https://chatgpt.com/backend-api/codex',
    OPENAI_MODEL: 'codexplan',
    CHATGPT_ACCOUNT_ID: 'acct_secure_storage',
    CODEX_CREDENTIAL_SOURCE: 'oauth',
  })
})

test('explicitly declared env takes precedence over applySavedProfileToCurrentSession', async () => {
  const { applySavedProfileToCurrentSession } =
    await importFreshProviderProfileModule(
      'apply-saved-profile-codex',
    )
  const processEnv: NodeJS.ProcessEnv = {
    CLAUDE_CODE_USE_OPENAI: '1',
    OPENAI_MODEL: 'gpt-4o',
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
    OPENAI_API_KEY: 'sk-openai',
    CODEX_API_KEY: 'codex-live',
    CHATGPT_ACCOUNT_ID: 'acct_codex',
    CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED: '1',
    CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID: 'provider_old',
  }
  const profileFile = createProfileFile('codex', {
    OPENAI_MODEL: 'codexplan',
    OPENAI_BASE_URL: 'https://chatgpt.com/backend-api/codex',
    CODEX_API_KEY: 'codex-live',
    CHATGPT_ACCOUNT_ID: 'acct_codex',
  })

  const warning = await applySavedProfileToCurrentSession({
    profileFile,
    processEnv,
  })

  expect(warning).toBeNull()
  expect(processEnv.CLAUDE_CODE_USE_OPENAI).toBe('1')
  expect(processEnv.OPENAI_MODEL).toBe('gpt-4o')
  expect(processEnv.OPENAI_BASE_URL).toBe(
    "https://api.openai.com/v1",
  )
  expect(processEnv.CODEX_API_KEY).toBeUndefined()
  expect(processEnv.CHATGPT_ACCOUNT_ID).toBeUndefined()
  expect(processEnv.OPENAI_API_KEY).toBe("sk-openai")
  expect(processEnv.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED).toBeUndefined()
  expect(processEnv.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID).toBeUndefined()
})

test('explicitly declared env takes precedence over applySavedProfileToCurrentSession for oauth codex profiles', async () => {
  const { applySavedProfileToCurrentSession } =
    await importFreshProviderProfileModule(
      'apply-saved-profile-codex-oauth',
    )
  const processEnv: NodeJS.ProcessEnv = {
    CLAUDE_CODE_USE_OPENAI: '1',
    OPENAI_MODEL: 'gpt-4o',
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
    CODEX_API_KEY: 'stale-codex-key',
    CHATGPT_ACCOUNT_ID: 'acct_stale',
  }
  const profileFile = createProfileFile('codex', {
    OPENAI_MODEL: 'codexplan',
    OPENAI_BASE_URL: 'https://chatgpt.com/backend-api/codex',
    CHATGPT_ACCOUNT_ID: 'acct_oauth',
    CODEX_CREDENTIAL_SOURCE: 'oauth',
  })

  const warning = await applySavedProfileToCurrentSession({
    profileFile,
    processEnv,
  })

  expect(warning).not.toBeUndefined()
  expect(processEnv.OPENAI_MODEL).toBe('gpt-4o')
  expect(processEnv.OPENAI_BASE_URL).toBe(
    "https://api.openai.com/v1",
  )
  expect(processEnv.CODEX_API_KEY).toBe("stale-codex-key")
  expect(processEnv.CHATGPT_ACCOUNT_ID).toBe('acct_stale')
  expect(processEnv.CHATGPT_ACCOUNT_ID).toBeTruthy()
})

test('buildCurrentProviderSummary redacts poisoned model and endpoint values', () => {
  const summary = buildCurrentProviderSummary({
    processEnv: {
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_API_KEY: 'sk-secret-12345678',
      OPENAI_MODEL: 'sk-secret-12345678',
      OPENAI_BASE_URL: 'sk-secret-12345678',
    },
    persisted: null,
  })

  expect(summary.providerLabel).toBe('OpenAI-compatible')
  expect(summary.modelLabel).toBe('sk-...678')
  expect(summary.endpointLabel).toBe('sk-...678')
})

test('buildCurrentProviderSummary labels generic local openai-compatible providers', () => {
  const summary = buildCurrentProviderSummary({
    processEnv: {
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_MODEL: 'qwen2.5-coder-7b-instruct',
      OPENAI_BASE_URL: 'http://127.0.0.1:8080/v1',
    },
    persisted: null,
  })

  expect(summary.providerLabel).toBe('Local OpenAI-compatible')
  expect(summary.modelLabel).toBe('qwen2.5-coder-7b-instruct')
  expect(summary.endpointLabel).toBe('http://127.0.0.1:8080/v1')
})

test('buildCurrentProviderSummary recognizes descriptor-backed openai-compatible routes', () => {
  const summary = buildCurrentProviderSummary({
    processEnv: {
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_MODEL: 'openai/gpt-5-mini',
      OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
    },
    persisted: null,
  })

  expect(summary.providerLabel).toBe('OpenRouter')
  expect(summary.modelLabel).toBe('openai/gpt-5-mini')
  expect(summary.endpointLabel).toBe('https://openrouter.ai/api/v1')
})

test('buildCurrentProviderSummary recognizes Venice routes', () => {
  const summary = buildCurrentProviderSummary({
    processEnv: {
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_MODEL: 'venice-uncensored',
      OPENAI_BASE_URL: 'https://api.venice.ai/api/v1',
      VENICE_API_KEY: 'sk-venice-secret',
    },
    persisted: null,
  })

  expect(summary.providerLabel).toBe('Venice')
  expect(summary.modelLabel).toBe('venice-uncensored')
  expect(summary.endpointLabel).toBe('https://api.venice.ai/api/v1')
})

test('buildCurrentProviderSummary does not relabel local gpt-5.4 providers as Codex when custom base URL is set', () => {
  const summary = buildCurrentProviderSummary({
    processEnv: {
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_MODEL: 'gpt-5.4',
      OPENAI_BASE_URL: 'http://127.0.0.1:8080/v1',
    },
    persisted: null,
  })

  expect(summary.providerLabel).toBe('Local OpenAI-compatible')
  expect(summary.modelLabel).toBe('gpt-5.4')
  expect(summary.endpointLabel).toBe('http://127.0.0.1:8080/v1')
})

test('buildCurrentProviderSummary recognizes Gemini mode', () => {
  const summary = buildCurrentProviderSummary({
    processEnv: {
      CLAUDE_CODE_USE_GEMINI: '1',
      GEMINI_MODEL: 'gemini-2.5-pro',
      GEMINI_BASE_URL:
        'https://generativelanguage.googleapis.com/v1beta/openai',
    },
    persisted: null,
  })

  expect(summary.providerLabel).toBe('Google AI / Gemini')
  expect(summary.modelLabel).toBe('gemini-2.5-pro')
  expect(summary.endpointLabel).toBe(
    'https://generativelanguage.googleapis.com/v1beta/openai',
  )
})

test('buildCurrentProviderSummary recognizes Mistral mode', () => {
  const summary = buildCurrentProviderSummary({
    processEnv: {
      CLAUDE_CODE_USE_MISTRAL: '1',
      MISTRAL_MODEL: 'mistral-medium-latest',
      MISTRAL_BASE_URL: 'https://api.mistral.ai/v1',
    },
    persisted: null,
  })

  expect(summary.providerLabel).toBe('Mistral AI')
  expect(summary.modelLabel).toBe('mistral-medium-latest')
  expect(summary.endpointLabel).toBe('https://api.mistral.ai/v1')
})

test('buildCurrentProviderSummary recognizes GitHub Models mode', () => {
  const summary = buildCurrentProviderSummary({
    processEnv: {
      CLAUDE_CODE_USE_GITHUB: '1',
      OPENAI_MODEL: 'github:copilot',
      OPENAI_BASE_URL: 'https://models.github.ai/inference',
    },
    persisted: null,
  })

  expect(summary.providerLabel).toBe('GitHub Models')
  expect(summary.modelLabel).toBe('github:copilot')
  expect(summary.endpointLabel).toBe('https://models.github.ai/inference')
})

test('getProviderWizardDefaults ignores poisoned current provider values', () => {
  const defaults = getProviderWizardDefaults({
    OPENAI_API_KEY: 'sk-secret-12345678',
    OPENAI_MODEL: 'sk-secret-12345678',
    OPENAI_BASE_URL: 'sk-secret-12345678',
    GEMINI_API_KEY: 'AIzaSecret12345678',
    GEMINI_MODEL: 'AIzaSecret12345678',
  })

  expect(defaults.openAIModel).toBe('gpt-4o')
  expect(defaults.openAIBaseUrl).toBe('https://api.openai.com/v1')
  expect(defaults.geminiModel).toBe('gemini-3-flash-preview')
})

test('CodexCredentialStep renders the codexplan Sol description', async () => {
  const previousApiKey = process.env.CODEX_API_KEY
  const previousAccountId = process.env.CHATGPT_ACCOUNT_ID
  let instance: Instance | undefined
  try {
    process.env.CODEX_API_KEY = 'codex-test-key'
    process.env.CHATGPT_ACCOUNT_ID = 'acct_test'
    const result = await renderFinalFrame(
      <CodexCredentialStep
        onSave={() => {}}
        onBack={() => {}}
        onCancel={() => {}}
      />,
    )
    instance = result.instance

    expect(result.output).toContain(
      'GPT-5.6 Sol with higher reasoning on the Codex backend',
    )
  } finally {
    instance?.unmount()
    if (previousApiKey === undefined) delete process.env.CODEX_API_KEY
    else process.env.CODEX_API_KEY = previousApiKey

    if (previousAccountId === undefined) delete process.env.CHATGPT_ACCOUNT_ID
    else process.env.CHATGPT_ACCOUNT_ID = previousAccountId
  }
})

test('ProviderWizard hides Codex OAuth while running in bare mode', async () => {
  process.env.CLAUDE_CODE_SIMPLE = '1'

  const output = await renderProviderWizardFrame()

  expect(output).toContain('Set up a provider profile')
  expect(output).not.toContain('Codex OAuth')
})
