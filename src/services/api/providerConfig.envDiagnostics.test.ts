import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../../test/sharedMutationLock.js'
import type { DebugLogLevel } from '../../utils/debug.js'

type DebugModule = typeof import('../../utils/debug.js')
type DebugSpy = ReturnType<
  typeof mock<(message: string, options?: { level?: DebugLogLevel }) => void>
>

const originalEnv = {
  CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
  CLAUDE_CODE_USE_GEMINI: process.env.CLAUDE_CODE_USE_GEMINI,
  CLAUDE_CODE_USE_GEMINI_VERTEX: process.env.CLAUDE_CODE_USE_GEMINI_VERTEX,
  CLAUDE_CODE_USE_MISTRAL: process.env.CLAUDE_CODE_USE_MISTRAL,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENAI_API_BASE: process.env.OPENAI_API_BASE,
  MISTRAL_BASE_URL: process.env.MISTRAL_BASE_URL,
  MISTRAL_MODEL: process.env.MISTRAL_MODEL,
  GEMINI_BASE_URL: process.env.GEMINI_BASE_URL,
  GEMINI_MODEL: process.env.GEMINI_MODEL,
  GEMINI_VERTEX_PROJECT: process.env.GEMINI_VERTEX_PROJECT,
  GEMINI_VERTEX_LOCATION: process.env.GEMINI_VERTEX_LOCATION,
  GEMINI_VERTEX_MODEL: process.env.GEMINI_VERTEX_MODEL,
  GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
  GCLOUD_PROJECT: process.env.GCLOUD_PROJECT,
  GOOGLE_PROJECT_ID: process.env.GOOGLE_PROJECT_ID,
}
let actualDebugModule: DebugModule | undefined

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

type DebugCall = [string, { level?: string }?]

function debugCalls(debugSpy: ReturnType<typeof mock>): DebugCall[] {
  return debugSpy.mock.calls as unknown as DebugCall[]
}

function findDebugCall(
  debugSpy: ReturnType<typeof mock>,
  predicate: (message: string) => boolean,
): DebugCall | undefined {
  return debugCalls(debugSpy).find(([message]) => predicate(message))
}

beforeEach(async () => {
  await acquireSharedMutationLock('providerConfig.envDiagnostics.test.ts')
})

afterEach(() => {
  try {
    restoreEnv('CLAUDE_CODE_USE_OPENAI', originalEnv.CLAUDE_CODE_USE_OPENAI)
    restoreEnv('CLAUDE_CODE_USE_GEMINI', originalEnv.CLAUDE_CODE_USE_GEMINI)
    restoreEnv('CLAUDE_CODE_USE_GEMINI_VERTEX', originalEnv.CLAUDE_CODE_USE_GEMINI_VERTEX)
    restoreEnv('CLAUDE_CODE_USE_MISTRAL', originalEnv.CLAUDE_CODE_USE_MISTRAL)
    restoreEnv('OPENAI_BASE_URL', originalEnv.OPENAI_BASE_URL)
    restoreEnv('OPENAI_MODEL', originalEnv.OPENAI_MODEL)
    restoreEnv('OPENAI_API_BASE', originalEnv.OPENAI_API_BASE)
    restoreEnv('MISTRAL_BASE_URL', originalEnv.MISTRAL_BASE_URL)
    restoreEnv('MISTRAL_MODEL', originalEnv.MISTRAL_MODEL)
    restoreEnv('GEMINI_BASE_URL', originalEnv.GEMINI_BASE_URL)
    restoreEnv('GEMINI_MODEL', originalEnv.GEMINI_MODEL)
    restoreEnv('GEMINI_VERTEX_PROJECT', originalEnv.GEMINI_VERTEX_PROJECT)
    restoreEnv('GEMINI_VERTEX_LOCATION', originalEnv.GEMINI_VERTEX_LOCATION)
    restoreEnv('GEMINI_VERTEX_MODEL', originalEnv.GEMINI_VERTEX_MODEL)
    restoreEnv('GOOGLE_CLOUD_PROJECT', originalEnv.GOOGLE_CLOUD_PROJECT)
    restoreEnv('GCLOUD_PROJECT', originalEnv.GCLOUD_PROJECT)
    restoreEnv('GOOGLE_PROJECT_ID', originalEnv.GOOGLE_PROJECT_ID)
    mock.restore()
    restoreDebugModule()
  } finally {
    releaseSharedMutationLock()
  }
})

test('logs a warning when OPENAI_BASE_URL is literal undefined', async () => {
  const debugSpy = await mockDebugLogging()

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'undefined'
  process.env.OPENAI_MODEL = 'gpt-4o'
  delete process.env.OPENAI_API_BASE

  const nonce = `${Date.now()}-${Math.random()}`
  const { resolveProviderRequest } = await import(`./providerConfig.ts?ts=${nonce}`)

  const resolved = resolveProviderRequest()

  expect(resolved.baseUrl).toBe('https://api.openai.com/v1')

  const warningCall = findDebugCall(
    debugSpy,
    message => message.includes('OPENAI_BASE_URL') && message.includes('"undefined"'),
  )

  expect(warningCall).toBeDefined()
  expect(warningCall?.[1]).toEqual({ level: 'warn' })
})

test('does not warn for OPENAI_API_BASE when OPENAI_BASE_URL is active', async () => {
  const debugSpy = await mockDebugLogging()

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:11434/v1'
  process.env.OPENAI_MODEL = 'qwen2.5-coder:7b'
  process.env.OPENAI_API_BASE = 'undefined'

  const nonce = `${Date.now()}-${Math.random()}`
  const { resolveProviderRequest } = await import(`./providerConfig.ts?ts=${nonce}`)

  const resolved = resolveProviderRequest()

  expect(resolved.baseUrl).toBe('http://127.0.0.1:11434/v1')

  const aliasWarning = findDebugCall(
    debugSpy,
    message => message.includes('OPENAI_API_BASE') && message.includes('"undefined"'),
  )

  expect(aliasWarning).toBeUndefined()
})

test('uses OPENAI_API_BASE as fallback in mistral mode when MISTRAL_BASE_URL is unset', async () => {
  const debugSpy = await mockDebugLogging()

  delete process.env.CLAUDE_CODE_USE_OPENAI
  process.env.CLAUDE_CODE_USE_MISTRAL = '1'
  delete process.env.MISTRAL_BASE_URL
  process.env.MISTRAL_MODEL = 'mistral-medium-latest'
  process.env.OPENAI_API_BASE = 'http://127.0.0.1:11434/v1'

  const nonce = `${Date.now()}-${Math.random()}`
  const { resolveProviderRequest } = await import(`./providerConfig.ts?ts=${nonce}`)

  const resolved = resolveProviderRequest()

  expect(resolved.baseUrl).toBe('http://127.0.0.1:11434/v1')
  expect(debugSpy.mock.calls).toHaveLength(0)
})

test('uses descriptor-backed Gemini default model when GEMINI_MODEL is unset', async () => {
  await mockDebugLogging()

  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  process.env.CLAUDE_CODE_USE_GEMINI = '1'
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.OPENAI_MODEL
  delete process.env.OPENAI_API_BASE

  const nonce = `${Date.now()}-${Math.random()}`
  const { resolveProviderRequest } = await import(`./providerConfig.ts?ts=${nonce}`)

  const resolved = resolveProviderRequest()

  expect(resolved.resolvedModel).toBe('gemini-3-flash-preview')
  expect(resolved.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta/openai')
})

test('uses GEMINI_VERTEX_MODEL instead of OPENAI_MODEL in Gemini Vertex mode', async () => {
  await mockDebugLogging()

  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  process.env.CLAUDE_CODE_USE_GEMINI_VERTEX = '1'
  process.env.OPENAI_MODEL = 'gpt-5.5'
  process.env.GEMINI_VERTEX_MODEL = 'gemini-vertex-custom'
  delete process.env.OPENAI_API_BASE

  const nonce = `${Date.now()}-${Math.random()}`
  const { resolveProviderRequest } = await import(`./providerConfig.ts?ts=${nonce}`)

  const resolved = resolveProviderRequest()

  expect(resolved.requestedModel).toBe('gemini-vertex-custom')
  expect(resolved.resolvedModel).toBe('gemini-vertex-custom')
})

test('uses current Gemini Vertex fallback model instead of OPENAI_MODEL when vertex model is unset', async () => {
  await mockDebugLogging()

  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  process.env.CLAUDE_CODE_USE_GEMINI_VERTEX = '1'
  process.env.OPENAI_MODEL = 'gpt-5.5'
  delete process.env.GEMINI_VERTEX_MODEL
  delete process.env.OPENAI_API_BASE

  const nonce = `${Date.now()}-${Math.random()}`
  const { resolveProviderRequest } = await import(`./providerConfig.ts?ts=${nonce}`)

  const resolved = resolveProviderRequest()

  expect(resolved.requestedModel).toBe('gemini-2.5-flash')
  expect(resolved.resolvedModel).toBe('gemini-2.5-flash')
})

test('exposes Gemini Vertex project and location from dedicated env vars', async () => {
  await mockDebugLogging()

  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  process.env.CLAUDE_CODE_USE_GEMINI_VERTEX = '1'
  process.env.GEMINI_VERTEX_PROJECT = 'vertex-project'
  process.env.GEMINI_VERTEX_LOCATION = 'europe-west4'
  delete process.env.OPENAI_API_BASE

  const nonce = `${Date.now()}-${Math.random()}`
  const { resolveProviderRequest } = await import(`./providerConfig.ts?ts=${nonce}`)

  const resolved = resolveProviderRequest()

  expect(resolved.vertexProject).toBe('vertex-project')
  expect(resolved.vertexLocation).toBe('europe-west4')
})

test('falls back to Google project env vars for Gemini Vertex project', async () => {
  await mockDebugLogging()

  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  process.env.CLAUDE_CODE_USE_GEMINI_VERTEX = '1'
  process.env.GOOGLE_CLOUD_PROJECT = 'project-test-1234'
  process.env.GEMINI_VERTEX_LOCATION = 'us-central1'
  delete process.env.GEMINI_VERTEX_PROJECT
  delete process.env.GCLOUD_PROJECT
  delete process.env.GOOGLE_PROJECT_ID
  delete process.env.OPENAI_API_BASE

  const nonce = `${Date.now()}-${Math.random()}`
  const { resolveProviderRequest } = await import(`./providerConfig.ts?ts=${nonce}`)

  const resolved = resolveProviderRequest()

  expect(resolved.vertexProject).toBe('project-test-1234')
  expect(resolved.vertexLocation).toBe('us-central1')
})

test('defaults Gemini Vertex location to global when unset', async () => {
  await mockDebugLogging()

  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  process.env.CLAUDE_CODE_USE_GEMINI_VERTEX = '1'
  process.env.GOOGLE_CLOUD_PROJECT = 'project-test-1234'
  delete process.env.GEMINI_VERTEX_PROJECT
  delete process.env.GCLOUD_PROJECT
  delete process.env.GOOGLE_PROJECT_ID
  delete process.env.GEMINI_VERTEX_LOCATION
  delete process.env.OPENAI_API_BASE

  const nonce = `${Date.now()}-${Math.random()}`
  const { resolveProviderRequest } = await import(`./providerConfig.ts?ts=${nonce}`)

  const resolved = resolveProviderRequest()

  expect(resolved.vertexProject).toBe('project-test-1234')
  expect(resolved.vertexLocation).toBe('global')
})

async function mockDebugLogging(): Promise<DebugSpy> {
  actualDebugModule ??= await import(
    `../../utils/debug.ts?providerConfigEnvDiagnosticsActual=${Date.now()}-${Math.random()}`
  )
  const debugSpy = mock(
    (_message: string, _options?: { level?: DebugLogLevel }) => {},
  )
  mock.module('../../utils/debug.js', () => ({
    ...actualDebugModule!,
    logForDebugging: debugSpy,
  }))
  return debugSpy
}

function restoreDebugModule(): void {
  if (actualDebugModule) {
    mock.module('../../utils/debug.js', () => ({ ...actualDebugModule! }))
  }
}
