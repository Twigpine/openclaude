import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { crc32 } from 'node:zlib'
import { snapshotEnv } from '../../test/envSnapshot.js'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../../test/sharedMutationLock.js'
import { asMockFetch } from '../../test/typedMocks.js'

const envKeys = [
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_OPENAI', 'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GITHUB', 'CLAUDE_CODE_USE_MISTRAL',
  'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL', 'AWS_REGION',
] as const
let restoreEnv: () => void
let originalMacro: PropertyDescriptor | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('client.bedrockStreaming.test.ts')
  restoreEnv = snapshotEnv(envKeys, { clear: true })
  originalMacro = Object.getOwnPropertyDescriptor(globalThis, 'MACRO')
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: 'test-version' }
  process.env.CLAUDE_CODE_USE_BEDROCK = '1'
  process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH = '1'
  process.env.AWS_REGION = 'us-east-1'
  process.env.ANTHROPIC_BEDROCK_BASE_URL = 'https://bedrock.example.test'
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

// Encode the public AWS event-stream wire format, including both CRC checks.
// The real Bedrock SDK must decode these frames before the Anthropic SSE parser.
function bedrockFrame(event: object): Buffer {
  const headers = Buffer.concat(Object.entries({
    ':message-type': 'event', ':event-type': 'chunk',
    ':content-type': 'application/json',
  }).map(([name, value]) => {
    const key = Buffer.from(name)
    const text = Buffer.from(value)
    const prefix = Buffer.from([key.length, ...key, 7, 0, 0])
    prefix.writeUInt16BE(text.length, prefix.length - 2)
    return Buffer.concat([prefix, text])
  }))
  const body = Buffer.from(JSON.stringify({
    bytes: Buffer.from(JSON.stringify(event)).toString('base64'),
  }))
  const frame = Buffer.alloc(16 + headers.length + body.length)
  frame.writeUInt32BE(frame.length, 0)
  frame.writeUInt32BE(headers.length, 4)
  frame.writeUInt32BE(crc32(frame.subarray(0, 8)), 8)
  headers.copy(frame, 12)
  body.copy(frame, 12 + headers.length)
  frame.writeUInt32BE(crc32(frame.subarray(0, -4)), frame.length - 4)
  return frame
}

test('the real Bedrock client decodes AWS streaming frames with the installed Anthropic SDK', async () => {
  const events = [
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7, output_tokens_details: { thinking_tokens: 5 } } },
    { type: 'message_stop' },
  ]
  const fetch = mock(async () => new Response(Buffer.concat(events.map(bedrockFrame)), {
    headers: { 'content-type': 'application/vnd.amazon.eventstream' },
  }))
  const { getAnthropicClient } = await import(
    `./client.js?bedrock-stream=${Date.now()}-${Math.random()}`
  ) as typeof import('./client.js')
  const client = await getAnthropicClient({
    maxRetries: 0,
    model: 'anthropic.claude-sonnet-4-6',
    fetchOverride: asMockFetch(fetch),
  })
  expect(client.constructor.name).toBe('AnthropicBedrock')
  const received: unknown[] = []
  for await (const event of await client.beta.messages.create({
    model: 'anthropic.claude-sonnet-4-6', max_tokens: 16,
    messages: [{ role: 'user', content: 'hello' }], stream: true,
  })) received.push(event)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(received).toEqual(events)
})
