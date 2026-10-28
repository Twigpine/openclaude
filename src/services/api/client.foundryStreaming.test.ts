import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { snapshotEnv } from '../../test/envSnapshot.js'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../../test/sharedMutationLock.js'
import { asMockFetch } from '../../test/typedMocks.js'
import { importOptionalRuntimeModule } from '../../utils/optionalRuntimeModule.js'
import { updateUsage } from './claude.js'
import { EMPTY_USAGE } from './emptyUsage.js'
import type { BetaMessage, BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

const envKeys = [
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_OPENAI', 'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GITHUB', 'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH', 'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
] as const
let restoreEnv: () => void
let originalMacro: PropertyDescriptor | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('client.foundryStreaming.test.ts')
  restoreEnv = snapshotEnv(envKeys, { clear: true })
  originalMacro = Object.getOwnPropertyDescriptor(globalThis, 'MACRO')
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: 'test-version' }
  process.env.CLAUDE_CODE_USE_FOUNDRY = '1'
  process.env.ANTHROPIC_FOUNDRY_RESOURCE = 'test-resource'
})

afterEach(() => {
  try {
    restoreEnv()
    if (originalMacro) Object.defineProperty(globalThis, 'MACRO', originalMacro)
    else delete (globalThis as Record<string, unknown>).MACRO
  } finally {
    releaseSharedMutationLock()
  }
})

for (const auth of ['api-key', 'entra'] as const) {
  test(`the real Foundry client constructs and decodes beta streams with ${auth} auth`, async () => {
    if (auth === 'api-key') process.env.ANTHROPIC_FOUNDRY_API_KEY = 'foundry-test-key'
    else {
      delete process.env.ANTHROPIC_FOUNDRY_RESOURCE
      process.env.ANTHROPIC_FOUNDRY_BASE_URL = 'https://foundry.example.test/anthropic/'
    }
    const message: BetaMessage = {
      id: 'msg_foundry', type: 'message', role: 'assistant',
      model: 'claude-sonnet-4-6', content: [],
      usage: { ...EMPTY_USAGE, input_tokens: 4 },
      stop_reason: null, stop_sequence: null, container: null,
      context_management: null, diagnostics: null, stop_details: null,
    }
    const events: BetaRawMessageStreamEvent[] = [
      { type: 'message_start', message },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_lookup', name: 'lookup', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"hello"}' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta', context_management: null,
        delta: { container: null, stop_reason: 'tool_use', stop_sequence: null, stop_details: null },
        usage: { ...message.usage, output_tokens: 7, output_tokens_details: { thinking_tokens: 3 }, fallback_credit: { status: { type: 'redeemed' } } },
      },
      { type: 'message_stop' },
    ]
    const requests: { url: string; headers: Headers; body: unknown }[] = []
    const fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const tokenProvider = mock(async () => `entra-test-token-${tokenProvider.mock.calls.length}`)
    const getBearerTokenProvider = mock((_credential: unknown, _scope: string) => tokenProvider)
    const { getAnthropicClient, _setOptionalRuntimeModuleImporterForTesting } = await import(
      `./client.js?foundry-stream=${Date.now()}-${Math.random()}`
    ) as typeof import('./client.js')
    // Keep the installed Foundry SDK and its stream implementation real; replace
    // only Azure credential acquisition so no cloud account is needed.
    _setOptionalRuntimeModuleImporterForTesting(async <T>(specifier: string, feature: string): Promise<T> => {
      if (specifier === '@azure/identity') return {
        DefaultAzureCredential: class {}, getBearerTokenProvider,
      } as T
      return importOptionalRuntimeModule<T>(specifier, feature)
    })
    try {
      const client = await getAnthropicClient({ maxRetries: 0, model: 'claude-sonnet-4-6', fetchOverride: asMockFetch(fetch) })
      expect(client.constructor.name).toBe('AnthropicFoundry')
      // Two requests prove the Entra token callback is invoked for each request.
      for (let i = 0; i < 2; i++) {
        const received: unknown[] = []
        let usage = { ...EMPTY_USAGE }
        for await (const event of await client.beta.messages.create({
          model: 'claude-sonnet-4-6', max_tokens: 16, stream: true,
          messages: [{ role: 'user', content: 'hello' }],
          tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
        })) {
          received.push(event)
          if (event.type === 'message_delta') usage = updateUsage(usage, event.usage)
        }
        expect(received).toEqual(events)
        expect(usage).toMatchObject({
          output_tokens: 7, output_tokens_details: { thinking_tokens: 3 },
          fallback_credit: { status: { type: 'redeemed' } },
        })
      }
      expect(requests).toHaveLength(2)
      for (const [i, request] of requests.entries()) {
        expect(request.url).toBe(auth === 'api-key'
          ? 'https://test-resource.services.ai.azure.com/anthropic/v1/messages?beta=true'
          : 'https://foundry.example.test/anthropic/v1/messages?beta=true')
        expect(request.body).toMatchObject({ model: 'claude-sonnet-4-6', max_tokens: 16, stream: true, tools: [{ name: 'lookup' }] })
        expect(request.headers.get('x-api-key')).toBe(auth === 'api-key' ? 'foundry-test-key' : null)
        expect(request.headers.get('authorization')).toBe(auth === 'entra' ? `Bearer entra-test-token-${i + 1}` : null)
      }
      if (auth === 'entra') {
        expect(getBearerTokenProvider).toHaveBeenCalledWith(expect.anything(), 'https://cognitiveservices.azure.com/.default')
        expect(tokenProvider).toHaveBeenCalledTimes(2)
      } else expect(getBearerTokenProvider).not.toHaveBeenCalled()
    } finally {
      _setOptionalRuntimeModuleImporterForTesting()
    }
  })
}
