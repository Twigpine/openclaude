import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GoogleAuth, UserRefreshClient } from 'google-auth-library'

import { snapshotEnv } from '../../test/envSnapshot.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { checkGcpCredentialsValid } from '../../utils/auth.js'
import { resolveGeminiCredential } from '../../utils/geminiAuth.js'
import { getAnthropicClient } from './client.js'

const originalGetClient = GoogleAuth.prototype.getClient
const envKeys = [
  'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT',
  'GOOGLE_CLOUD_QUOTA_PROJECT', 'GOOGLE_PROJECT_ID',
  'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'ANTHROPIC_VERTEX_PROJECT_ID', 'ANTHROPIC_VERTEX_BASE_URL', 'CLOUD_ML_REGION',
  'CLAUDE_CODE_USE_GEMINI', 'GEMINI_AUTH_MODE', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'GEMINI_ACCESS_TOKEN', 'GEMINI_BASE_URL', 'GEMINI_MODEL',
  'CLAUDE_CODE_USE_OPENAI', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GITHUB', 'CLAUDE_CODE_USE_MISTRAL', 'ANTHROPIC_CUSTOM_HEADERS',
] as const

let restoreEnv: () => void
let fixtureDir: string
let originalMacro: PropertyDescriptor | undefined
let authInstances: GoogleAuth[]
let tokenRequests: URLSearchParams[]
let apiHeaders: Headers | undefined
let apiUrl: string | undefined

const apiFetch = (async (input, init) => {
  apiUrl = String(input)
  apiHeaders = new Headers(init?.headers)
  const vertex = process.env.CLAUDE_CODE_USE_VERTEX === '1'
  return new Response(JSON.stringify(vertex ? {
    id: 'msg_auth', type: 'message', role: 'assistant',
    model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } : {
    id: 'chatcmpl_auth', model: 'gemini-2.5-flash',
    choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch

beforeEach(async () => {
  await acquireSharedMutationLock('services/api/googleAuth.integration.test.ts')
  restoreEnv = snapshotEnv(envKeys, { clear: true })
  originalMacro = Object.getOwnPropertyDescriptor(globalThis, 'MACRO')
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: 'test-version' }
  fixtureDir = mkdtempSync(join(tmpdir(), 'openclaude-google-auth-'))
  const credentialsPath = join(fixtureDir, 'adc.json')
  writeFileSync(credentialsPath, JSON.stringify({
    type: 'authorized_user',
    client_id: 'fixture-client',
    client_secret: 'fixture-secret',
    refresh_token: 'fixture-refresh',
    quota_project_id: 'fixture-quota',
  }))
  process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath
  process.env.GOOGLE_CLOUD_PROJECT = 'fixture-project'
  authInstances = []
  tokenRequests = []
  apiHeaders = undefined
  apiUrl = undefined

  // Keep the production constructor, ADC file loading, getClient, and token/header
  // methods real. Replace only the HTTP transport of the resulting auth client.
  spyOn(GoogleAuth.prototype, 'getClient').mockImplementation(async function (this: GoogleAuth) {
    const client = await originalGetClient.call(this)
    expect(client).toBeInstanceOf(UserRefreshClient)
    authInstances.push(this)
    client.transporter.defaults.fetchImplementation = async (url, init) => {
      expect(String(url)).toBe('https://oauth2.googleapis.com/token')
      expect(init?.method).toBe('POST')
      tokenRequests.push(new URLSearchParams(String(init?.body)))
      return new Response(JSON.stringify({
        access_token: 'fixture-access-token', token_type: 'Bearer', expires_in: 3600,
      }), { headers: { 'Content-Type': 'application/json' } })
    }
    return client
  })
})

afterEach(() => {
  try {
    mock.restore()
    restoreEnv()
    if (originalMacro) {
      Object.defineProperty(globalThis, 'MACRO', originalMacro)
    } else {
      delete (globalThis as Record<string, unknown>).MACRO
    }
    rmSync(fixtureDir, { recursive: true, force: true })
  } finally {
    releaseSharedMutationLock()
  }
})

function expectRealAuthFlow(): void {
  expect(authInstances).toHaveLength(1)
  expect(tokenRequests).toHaveLength(1)
  expect(Object.fromEntries(tokenRequests[0]!)).toEqual({
    client_id: 'fixture-client',
    client_secret: 'fixture-secret',
    refresh_token: 'fixture-refresh',
    grant_type: 'refresh_token',
  })
}

test('Vertex loads ADC and forwards real Google auth Headers to rawPredict', async () => {
  process.env.CLAUDE_CODE_USE_VERTEX = '1'
  process.env.CLOUD_ML_REGION = 'us-east5'
  process.env.ANTHROPIC_VERTEX_PROJECT_ID = 'fixture-target'
  const client = await getAnthropicClient({
    maxRetries: 0, model: 'claude-sonnet-4-6', fetchOverride: apiFetch,
  })
  await client.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 16,
    messages: [{ role: 'user', content: 'hello' }],
  })

  expectRealAuthFlow()
  expect(apiUrl).toContain('/projects/fixture-target/locations/us-east5/')
  expect(apiUrl).toEndWith(':rawPredict')
  expect(apiHeaders?.get('authorization')).toBe('Bearer fixture-access-token')
  expect(apiHeaders?.get('x-goog-user-project')).toBe('fixture-quota')
})

test('Gemini loads ADC and normalizes the real getAccessToken result for requests', async () => {
  // The OpenAI shim uses the shared fetch transport rather than fetchOverride.
  spyOn(globalThis, 'fetch').mockImplementation(apiFetch)
  process.env.CLAUDE_CODE_USE_GEMINI = '1'
  process.env.GEMINI_AUTH_MODE = 'adc'
  process.env.GEMINI_MODEL = 'gemini-2.5-flash'
  process.env.GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai'
  const client = await getAnthropicClient({
    maxRetries: 0, model: 'gemini-2.5-flash', fetchOverride: apiFetch,
  })
  await client.messages.create({
    model: 'gemini-2.5-flash', max_tokens: 16,
    messages: [{ role: 'user', content: 'hello' }],
  })

  expectRealAuthFlow()
  expect(apiUrl).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
  expect(apiHeaders?.get('authorization')).toBe('Bearer fixture-access-token')
  expect(apiHeaders?.get('x-goog-user-project')).toBe('fixture-project')
})

test('Vertex credential validation loads ADC and retrieves a real access token', async () => {
  await expect(checkGcpCredentialsValid()).resolves.toBe(true)
  expectRealAuthFlow()
})

test('Vertex validation and Gemini ADC reject malformed credential files', async () => {
  writeFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS!, '{invalid json')
  process.env.GEMINI_AUTH_MODE = 'adc'
  await expect(checkGcpCredentialsValid()).resolves.toBe(false)
  await expect(resolveGeminiCredential()).resolves.toEqual({ kind: 'none' })
  expect(tokenRequests).toHaveLength(0)
})
