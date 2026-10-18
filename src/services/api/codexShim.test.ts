import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../../test/sharedMutationLock.js'
import {
  codexStreamToAnthropic,
  convertAnthropicMessagesToResponsesInput,
  convertCodexResponseToAnthropicMessage,
  convertSystemPrompt,
  convertToolsToResponsesTools,
} from './codexShim.js'
import { __test as webSearchToolTest } from '../../tools/WebSearchTool/WebSearchTool.js'
import { setToolHistoryCompressionEnabledOverrideForTest } from './compressToolHistory.js'

const tempDirs: string[] = []
const originalFetch = globalThis.fetch
const originalEnv = {
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_BASE: process.env.OPENAI_API_BASE,
  CLAUDE_CODE_USE_GITHUB: process.env.CLAUDE_CODE_USE_GITHUB,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
}

beforeEach(async () => {
  await acquireSharedMutationLock('codexShim.test.ts')
})

afterEach(() => {
  try {
    globalThis.fetch = originalFetch
    if (originalEnv.OPENAI_BASE_URL === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = originalEnv.OPENAI_BASE_URL

    if (originalEnv.OPENAI_API_BASE === undefined) delete process.env.OPENAI_API_BASE
    else process.env.OPENAI_API_BASE = originalEnv.OPENAI_API_BASE

    if (originalEnv.CLAUDE_CODE_USE_GITHUB === undefined) delete process.env.CLAUDE_CODE_USE_GITHUB
    else process.env.CLAUDE_CODE_USE_GITHUB = originalEnv.CLAUDE_CODE_USE_GITHUB

    if (originalEnv.OPENAI_MODEL === undefined) delete process.env.OPENAI_MODEL
    else process.env.OPENAI_MODEL = originalEnv.OPENAI_MODEL

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  } finally {
    releaseSharedMutationLock()
  }
})

function createTempAuthJson(payload: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'openclaude-codex-'))
  tempDirs.push(dir)
  const authPath = join(dir, 'auth.json')
  writeFileSync(authPath, JSON.stringify(payload), 'utf8')
  return authPath
}

async function collectStreamEventTypes(responseText: string): Promise<string[]> {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(responseText))
      controller.close()
    },
  })

  const events: string[] = []
  for await (const event of codexStreamToAnthropic(new Response(stream), 'gpt-5.4')) {
    events.push(event.type)
  }
  return events
}

async function waitForPromise<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

function makeStallingCodexResponse(firstChunk: string): {
  response: Response
  cancelReasons: unknown[]
  close: () => void
} {
  const encoder = new TextEncoder()
  const cancelReasons: unknown[] = []
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
  let closed = false

  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
        controller.enqueue(encoder.encode(firstChunk))
      },
      cancel(reason) {
        closed = true
        cancelReasons.push(reason)
      },
    }),
  )

  return {
    response,
    cancelReasons,
    close: () => {
      if (closed) return
      closed = true
      try {
        streamController?.close()
      } catch {
        // The test may already have cancelled the stream.
      }
    },
  }
}

async function importFreshProviderConfigModule() {
  return import(`./providerConfig.js?ts=${Date.now()}-${Math.random()}`)
}

describe('Codex provider config', () => {
  const originalOpenaiBaseUrl = process.env.OPENAI_BASE_URL
  const originalOpenaiApiBase = process.env.OPENAI_API_BASE

  beforeEach(() => {
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_BASE
  })

  afterEach(() => {
    if (originalOpenaiBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = originalOpenaiBaseUrl
    if (originalOpenaiApiBase === undefined) delete process.env.OPENAI_API_BASE
    else process.env.OPENAI_API_BASE = originalOpenaiApiBase
  })

  test('resolves codexplan alias to Codex transport with reasoning', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_BASE
    delete process.env.CLAUDE_CODE_USE_GITHUB

    const resolved = resolveProviderRequest({ model: 'codexplan' })
    expect(resolved.transport).toBe('codex_responses')
    expect(resolved.resolvedModel).toBe('gpt-5.6-sol')
    expect(resolved.reasoning).toEqual({ effort: 'high' })
    expect(resolved.baseUrl).toBe('https://chatgpt.com/backend-api/codex')
  })

  test('resolves codexspark alias to Codex transport with Codex base URL', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_BASE
    delete process.env.CLAUDE_CODE_USE_GITHUB

    const resolved = resolveProviderRequest({ model: 'codexspark' })
    expect(resolved.transport).toBe('codex_responses')
    expect(resolved.resolvedModel).toBe('gpt-5.3-codex-spark')
    expect(resolved.baseUrl).toBe('https://chatgpt.com/backend-api/codex')
  })

  test('does not force Codex transport when a local non-Codex base URL is explicit', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    const resolved = resolveProviderRequest({
      model: 'codexplan',
      baseUrl: 'http://127.0.0.1:8080/v1',
    })

    expect(resolved.transport).toBe('chat_completions')
    expect(resolved.baseUrl).toBe('http://127.0.0.1:8080/v1')
    expect(resolved.resolvedModel).toBe('gpt-5.6-sol')
    expect(resolved.reasoning).toEqual({ effort: 'high' })
  })

  test('resolves codexplan to Codex transport even when OPENAI_BASE_URL is the string "undefined"', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    // On Windows, env vars can leak as the literal string "undefined" instead of
    // the JS value undefined when not properly unset (issue #336).
    process.env.OPENAI_BASE_URL = 'undefined'
    const resolved = resolveProviderRequest({ model: 'codexplan' })
    expect(resolved.transport).toBe('codex_responses')
  })

  test('resolves codexplan to Codex transport even when OPENAI_BASE_URL is an empty string', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    process.env.OPENAI_BASE_URL = ''
    const resolved = resolveProviderRequest({ model: 'codexplan' })
    expect(resolved.transport).toBe('codex_responses')
  })

  test('prefers explicit baseUrl option over env var', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    process.env.OPENAI_BASE_URL = 'https://example.com/v1'
    const resolved = resolveProviderRequest({ model: 'codexplan', baseUrl: 'https://chatgpt.com/backend-api/codex' })
    expect(resolved.transport).toBe('codex_responses')
    expect(resolved.baseUrl).toBe('https://chatgpt.com/backend-api/codex')
  })

  test('default gpt-4o uses OpenAI base URL (no regression)', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    delete process.env.OPENAI_BASE_URL
    delete process.env.CLAUDE_CODE_USE_GITHUB

    const resolved = resolveProviderRequest({ model: 'gpt-4o' })
    expect(resolved.transport).toBe('chat_completions')
    expect(resolved.baseUrl).toBe('https://api.openai.com/v1')
    expect(resolved.resolvedModel).toBe('gpt-4o')
  })

  test('resolves codexplan from env var OPENAI_MODEL to Codex endpoint', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    process.env.OPENAI_MODEL = 'codexplan'
    delete process.env.OPENAI_BASE_URL
    delete process.env.CLAUDE_CODE_USE_GITHUB

    const resolved = resolveProviderRequest()
    expect(resolved.transport).toBe('codex_responses')
    expect(resolved.baseUrl).toBe('https://chatgpt.com/backend-api/codex')
    expect(resolved.resolvedModel).toBe('gpt-5.6-sol')
  })

  test('does not override custom base URL for codexplan (e.g., local provider)', async () => {
    const { resolveProviderRequest } = await importFreshProviderConfigModule()
    process.env.OPENAI_MODEL = 'codexplan'
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
    delete process.env.CLAUDE_CODE_USE_GITHUB

    const resolved = resolveProviderRequest()
    expect(resolved.transport).toBe('chat_completions')
    expect(resolved.baseUrl).toBe('http://localhost:11434/v1')
  })

  test('loads Codex credentials from auth.json fallback', async () => {
    const { resolveCodexApiCredentials } = await importFreshProviderConfigModule()
    const authPath = createTempAuthJson({
      tokens: {
        access_token: 'header.payload.signature',
        account_id: 'acct_test',
      },
    })

    const credentials = resolveCodexApiCredentials({
      CODEX_AUTH_JSON_PATH: authPath,
    } as NodeJS.ProcessEnv)

    expect(credentials.apiKey).toBe('header.payload.signature')
    expect(credentials.accountId).toBe('acct_test')
    expect(credentials.source).toBe('auth.json')
  })

  test('does not treat auth.json id_token as a Codex bearer credential', async () => {
    const { resolveCodexApiCredentials } = await importFreshProviderConfigModule()
    const idTokenPayload = Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'acct_from_id_token',
        },
      }),
      'utf8',
    ).toString('base64url')
    const authPath = createTempAuthJson({
      tokens: {
        id_token: `header.${idTokenPayload}.signature`,
      },
    })

    const credentials = resolveCodexApiCredentials({
      CODEX_AUTH_JSON_PATH: authPath,
    } as NodeJS.ProcessEnv)

    expect(credentials.apiKey).toBe('')
    expect(credentials.accountId).toBe('acct_from_id_token')
    expect(credentials.source).toBe('none')
  })
})

describe('Codex request translation', () => {
  test('normalizes optional parameters into strict Responses schemas', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'Agent',
        description: 'Spawn a sub-agent',
        input_schema: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            prompt: { type: 'string' },
            subagent_type: { type: 'string' },
          },
          required: ['description', 'prompt'],
          additionalProperties: false,
        },
      },
    ])

    expect(tools).toEqual([
      {
        type: 'function',
        name: 'Agent',
        description: 'Spawn a sub-agent',
        parameters: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            prompt: { type: 'string' },
            subagent_type: { type: 'string' },
          },
          required: ['description', 'prompt', 'subagent_type'],
          additionalProperties: false,
        },
        strict: true,
      },
    ])
  })

  test('keeps strict mode for tools whose schema already matches Responses requirements', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'Ping',
        description: 'Ping tool',
        input_schema: {
          type: 'object',
          properties: {
            value: { type: 'string' },
          },
          required: ['value'],
          additionalProperties: false,
        },
      },
    ])

    expect(tools).toEqual([
      {
        type: 'function',
        name: 'Ping',
        description: 'Ping tool',
        parameters: {
          type: 'object',
          properties: {
            value: { type: 'string' },
          },
          required: ['value'],
          additionalProperties: false,
        },
        strict: true,
      },
    ])
  })

  test('preserves Grep tool pattern field in Codex strict schemas', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'Grep',
        description: 'Search file contents',
        input_schema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Search pattern' },
            path: { type: 'string' },
          },
          required: ['pattern'],
          additionalProperties: false,
        },
      },
    ])

    expect(tools).toEqual([
      {
        type: 'function',
        name: 'Grep',
        description: 'Search file contents',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Search pattern' },
            path: { type: 'string' },
          },
          required: ['pattern', 'path'],
          additionalProperties: false,
        },
        strict: true,
      },
    ])
  })

  test('preserves Glob tool pattern field in Codex strict schemas', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'Glob',
        description: 'Find files by pattern',
        input_schema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Glob pattern' },
            path: { type: 'string' },
          },
          required: ['pattern'],
          additionalProperties: false,
        },
      },
    ])

    expect(tools).toEqual([
      {
        type: 'function',
        name: 'Glob',
        description: 'Find files by pattern',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Glob pattern' },
            path: { type: 'string' },
          },
          required: ['pattern', 'path'],
          additionalProperties: false,
        },
        strict: true,
      },
    ])
  })

  test('strips validator pattern keyword but keeps string field named pattern in Codex schemas', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'RegexProbe',
        description: 'Probe regex schema handling',
        input_schema: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              pattern: '^[a-z]+$',
            },
          },
          required: ['pattern'],
          additionalProperties: false,
        },
      },
    ])

    expect(tools).toEqual([
      {
        type: 'function',
        name: 'RegexProbe',
        description: 'Probe regex schema handling',
        parameters: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
            },
          },
          required: ['pattern'],
          additionalProperties: false,
        },
        strict: true,
      },
    ])
  })

  test('removes unsupported uri format from strict Responses schemas', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'WebFetch',
        description: 'Fetch a URL',
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string', format: 'uri' },
            prompt: { type: 'string' },
          },
          required: ['url', 'prompt'],
          additionalProperties: false,
        },
      },
    ])

    expect(tools).toEqual([
      {
        type: 'function',
        name: 'WebFetch',
        description: 'Fetch a URL',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            prompt: { type: 'string' },
          },
          required: ['url', 'prompt'],
          additionalProperties: false,
        },
        strict: true,
      },
    ])
  })

  test('sanitizes malformed enum/default values for Responses tool schemas', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'mcp__clientry__create_task',
        description: 'Create a task',
        input_schema: {
          type: 'object',
          properties: {
            priority: {
              type: 'integer',
              description: 'Priority: 0=low, 1=medium, 2=high, 3=urgent',
              default: true,
              enum: [false, 0, 1, 2, 3],
            },
          },
        },
      },
    ])

    expect(tools).toEqual([
      {
        type: 'function',
        name: 'mcp__clientry__create_task',
        description: 'Create a task',
        parameters: {
          type: 'object',
          properties: {
            priority: {
              type: 'integer',
              description: 'Priority: 0=low, 1=medium, 2=high, 3=urgent',
              enum: [0, 1, 2, 3],
            },
          },
          required: ['priority'],
          additionalProperties: false,
        },
        strict: true,
      },
    ])
  })

  test('defaults untyped MCP tool properties to string for Codex strict mode (issue #1114)', () => {
    // Repro from issue #1114: MCP server (Ruflo) registers a `value` parameter
    // with no `type`, which makes Codex strict mode 400 with
    // "schema must have a 'type' key".
    const tools = convertToolsToResponsesTools([
      {
        name: 'mcp__ruflo__config_set',
        description: 'Set a Ruflo config value',
        input_schema: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            value: { description: 'Any JSON value' },
          },
          required: ['key', 'value'],
        },
      },
    ])

    const valueSchema = (tools[0].parameters as Record<string, Record<string, Record<string, unknown>>>).properties.value
    expect(valueSchema.type).toBe('string')
    expect(valueSchema.description).toBe('Any JSON value')
  })

  test('drops orphan required keys when Ruflo MCP schema has no properties', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'mcp__ruflo__daa_workflow_create',
        description: 'Create a Ruflo DAA workflow',
        input_schema: {
          type: 'object',
          required: ['steps'],
        },
      },
    ])

    expect(tools[0].parameters).toEqual({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    })
  })

  test('infers object type for untyped schemas with nested properties', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'mcp__nest__call',
        input_schema: {
          type: 'object',
          properties: {
            payload: {
              properties: { name: { type: 'string' } },
            },
          },
        },
      },
    ])

    const payload = (tools[0].parameters as Record<string, Record<string, Record<string, unknown>>>).properties.payload
    expect(payload.type).toBe('object')
  })

  test('infers array type for untyped schemas with items', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'mcp__list__call',
        input_schema: {
          type: 'object',
          properties: {
            tags: { items: { type: 'string' } },
          },
        },
      },
    ])

    const tags = (tools[0].parameters as Record<string, Record<string, Record<string, unknown>>>).properties.tags
    expect(tags.type).toBe('array')
  })

  test('infers type from enum values when type is missing', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'mcp__enum__call',
        input_schema: {
          type: 'object',
          properties: {
            mode: { enum: ['fast', 'slow'] },
            level: { enum: [1, 2, 3] },
            ratio: { enum: [0.5, 1.5] },
            flag: { enum: [true, false] },
          },
        },
      },
    ])

    const props = (tools[0].parameters as Record<string, Record<string, Record<string, unknown>>>).properties
    expect(props.mode.type).toBe('string')
    expect(props.level.type).toBe('integer')
    expect(props.ratio.type).toBe('number')
    expect(props.flag.type).toBe('boolean')
  })

  test('leaves combinator-only schemas untyped to preserve alternatives', () => {
    const tools = convertToolsToResponsesTools([
      {
        name: 'mcp__combo__call',
        input_schema: {
          type: 'object',
          properties: {
            either: {
              anyOf: [{ type: 'string' }, { type: 'number' }],
            },
          },
        },
      },
    ])

    const either = (tools[0].parameters as Record<string, Record<string, Record<string, unknown>>>).properties.either
    expect(either.type).toBeUndefined()
    expect(either.anyOf).toEqual([{ type: 'string' }, { type: 'number' }])
  })

  test('converts plain string user message into Codex input_text chunk type', () => {
    const items = convertAnthropicMessagesToResponsesInput([
      { role: 'user', content: 'hello' },
    ], false) // forceTextChunks = false

    expect(items).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      },
    ])
  })

  test('converts plain string user message into standard text chunk type when forceTextChunks=true', () => {
    const items = convertAnthropicMessagesToResponsesInput([
      { role: 'user', content: 'hello' },
    ], true)

    expect(items).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      },
    ])
  })

  test('preserves wrapped string message content', () => {
    const items = convertAnthropicMessagesToResponsesInput([
      {
        message: { role: 'user', content: 'hello' }
      },
    ])

    expect(items).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      },
    ])
  })

  test('converts assistant tool use and user tool result into Responses items', () => {
    const items = convertAnthropicMessagesToResponsesInput([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Working...' },
          { type: 'tool_use', id: 'call_123', name: 'search', input: { q: 'x' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_123', content: 'done' },
        ],
      },
    ])

    expect(items).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Working...' }],
      },
      {
        type: 'function_call',
        id: 'fc_123',
        call_id: 'call_123',
        name: 'search',
        arguments: '{"q":"x"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_123',
        output: 'done',
      },
    ])
  })

  test('joins structured tool-result text with the Responses separator', () => {
    const items = convertAnthropicMessagesToResponsesInput([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_123', name: 'search', input: {} }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call_123',
          content: [
            { type: 'text', text: 'first block' },
            { type: 'text', text: 'second block' },
          ],
        }],
      },
    ])

    const output = items.find(item => item.type === 'function_call_output') as
      | { type: 'function_call_output'; output: string }
      | undefined
    expect(output?.output).toBe('first block\nsecond block')
  })

  test('keeps tool history uncompressed on the Codex transport (implicit prefix caching)', async () => {
    // Codex talks to OpenAI Responses backends, which do implicit prefix
    // caching: compressToolHistory's end-relative window would rewrite
    // already-sent tool results each turn and bust the cache, so the Codex
    // path must send history verbatim even with compression enabled.
    setToolHistoryCompressionEnabledOverrideForTest(true)
    try {
      mock.restore()
      const isolatedModulePath = './codexShim.ts?compression-test'
      const { performCodexRequest } = await import(isolatedModulePath)
      const messages = Array.from({ length: 30 }, (_, index) => [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: `call_${index}`, name: 'Read', input: {} }],
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: `call_${index}`,
            content: index === 16
              ? [
                { type: 'text', text: 'a'.repeat(1_000) },
                { type: 'text', text: 'b'.repeat(1_500) },
              ]
              : 'recent',
          }],
        },
      ]).flat()
      let body: Record<string, unknown> | undefined
      globalThis.fetch = (async (_url, init) => {
        body = JSON.parse(String(init?.body))
        return new Response('', { status: 200 })
      }) as typeof globalThis.fetch

      await performCodexRequest({
        request: {
          transport: 'codex_responses',
          requestedModel: 'gpt-4o',
          resolvedModel: 'gpt-4o',
          baseUrl: 'https://api.openai.test/v1',
        },
        credentials: { apiKey: 'test-key', source: 'env' },
        params: { model: 'gpt-4o', messages, max_tokens: 100 },
        defaultHeaders: {},
      })

      const outputs = (body?.input as Array<{ type?: string; output?: string }>)
        .filter(item => item.type === 'function_call_output')
      expect(outputs[16]?.output).toBe(
        `${'a'.repeat(1_000)}\n${'b'.repeat(1_500)}`,
      )
      for (const item of outputs) {
        expect(item.output).not.toContain('truncated')
        expect(item.output).not.toContain('chars omitted')
      }
    } finally {
      setToolHistoryCompressionEnabledOverrideForTest(undefined)
    }
  })

  test('renders tool_reference blocks from ToolSearch results as readable text', () => {
    const items = convertAnthropicMessagesToResponsesInput([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_ts1', name: 'ToolSearch', input: { query: 'memory' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_ts1',
            content: [
              { type: 'tool_reference', tool_name: 'mcp__example__memory_search' },
              { type: 'tool_reference', tool_name: 'mcp__example__memory_store' },
            ],
          },
        ],
      },
    ])

    const output = items.find(item => item.type === 'function_call_output') as
      | { type: 'function_call_output'; output: string }
      | undefined
    expect(output).toBeDefined()
    expect(output!.output).toContain('mcp__example__memory_search')
    expect(output!.output).toContain('mcp__example__memory_store')
  })

  test('keeps the ToolSearch tool in the Responses tools list', () => {
    const tools = convertToolsToResponsesTools([
      { name: 'ToolSearch', description: 'Find deferred tools', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
      { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: {} } },
    ])

    expect(tools.map(t => t.name)).toEqual(['ToolSearch', 'Read'])
  })

  test('converts completed Codex tool response into Anthropic message', () => {
    const message = convertCodexResponseToAnthropicMessage(
      {
        id: 'resp_1',
        model: 'gpt-5.3-codex-spark',
        output: [
          {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'ping',
            arguments: '{"value":"ping"}',
          },
        ],
        usage: { input_tokens: 12, output_tokens: 4 },
      },
      'gpt-5.3-codex-spark',
    )

    expect(message.stop_reason).toBe('tool_use')
    expect(message.content).toEqual([
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'ping',
        input: { value: 'ping' },
      },
    ])
  })

  test('strips <think> tag block from completed Codex text responses', () => {
    const message = convertCodexResponseToAnthropicMessage(
      {
        id: 'resp_1',
        model: 'gpt-5.4',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text:
                  '<think>user wants a greeting, respond briefly</think>Hey! How can I help you today?',
              },
            ],
          },
        ],
        usage: { input_tokens: 12, output_tokens: 4 },
      },
      'gpt-5.4',
    )

    expect(message.content).toEqual([
      {
        type: 'text',
        text: 'Hey! How can I help you today?',
      },
    ])
  })

  test('strips unterminated <think> tag at block boundary in Codex completed response', () => {
    const message = convertCodexResponseToAnthropicMessage(
      {
        id: 'resp_1',
        model: 'gpt-5.4',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text:
                  'Here is the answer.\n<think>wait, let me reconsider the user request',
              },
            ],
          },
        ],
        usage: { input_tokens: 12, output_tokens: 4 },
      },
      'gpt-5.4',
    )

    expect(message.content).toEqual([
      {
        type: 'text',
        text: 'Here is the answer.',
      },
    ])
  })

  test('recovers Codex web search text and sources from sparse completed response', () => {
    const output = webSearchToolTest.makeOutputFromCodexWebSearchResponse(
      {
        output: [
          {
            type: 'web_search_call',
            sources: [
              {
                title: 'OpenClaude repo',
                url: 'https://github.com/example/openclaude',
              },
            ],
          },
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'OpenClaude is available on GitHub.',
                sources: [
                  {
                    title: 'Docs',
                    url: 'https://docs.example.com/openclaude',
                  },
                ],
              },
            ],
          },
        ],
      },
      'OpenClaude GitHub 2026',
      0.42,
    )

    expect(output.results).toEqual([
      'OpenClaude is available on GitHub.',
      {
        tool_use_id: 'codex-web-search',
        content: [
          {
            title: 'OpenClaude repo',
            url: 'https://github.com/example/openclaude',
          },
          {
            title: 'Docs',
            url: 'https://docs.example.com/openclaude',
          },
        ],
      },
    ])
  })

  test('falls back to a non-empty Codex web search result message', () => {
    const output = webSearchToolTest.makeOutputFromCodexWebSearchResponse(
      { output: [] },
      'OpenClaude GitHub 2026',
      0.11,
    )

    expect(output.results).toEqual(['No results found.'])
  })

  test('surfaces Codex web search failure reason with a message', () => {
    const output = webSearchToolTest.makeOutputFromCodexWebSearchResponse(
      {
        output: [
          {
            type: 'web_search_call',
            status: 'failed',
            error: { message: 'upstream search provider rate-limited' },
          },
        ],
      },
      'OpenClaude GitHub 2026',
      0.05,
    )

    expect(output.results).toEqual([
      'Web search failed: upstream search provider rate-limited',
    ])
  })

  test('surfaces Codex web search failure reason nested under action.error', () => {
    const output = webSearchToolTest.makeOutputFromCodexWebSearchResponse(
      {
        output: [
          {
            type: 'web_search_call',
            status: 'failed',
            action: { error: { message: 'query blocked' } },
          },
        ],
      },
      'OpenClaude GitHub 2026',
      0.05,
    )

    expect(output.results).toEqual(['Web search failed: query blocked'])
  })

  test('handles Codex web search failure with no reason attached', () => {
    const output = webSearchToolTest.makeOutputFromCodexWebSearchResponse(
      {
        output: [
          {
            type: 'web_search_call',
            status: 'failed',
          },
        ],
      },
      'OpenClaude GitHub 2026',
      0.05,
    )

    expect(output.results).toEqual(['Web search failed.'])
  })

  test('a failure item does not suppress sources from a later message item', () => {
    const output = webSearchToolTest.makeOutputFromCodexWebSearchResponse(
      {
        output: [
          {
            type: 'web_search_call',
            status: 'failed',
            error: { message: 'partial outage' },
          },
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'Partial results below.',
                sources: [
                  { title: 'Docs', url: 'https://docs.example.com/openclaude' },
                ],
              },
            ],
          },
        ],
      },
      'OpenClaude GitHub 2026',
      0.05,
    )

    expect(output.results).toEqual([
      'Web search failed: partial outage',
      'Partial results below.',
      {
        tool_use_id: 'codex-web-search',
        content: [
          { title: 'Docs', url: 'https://docs.example.com/openclaude' },
        ],
      },
    ])
  })

  test('translates Codex SSE text stream into Anthropic events', async () => {
    const responseText = [
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message","status":"in_progress","content":[],"role":"assistant"},"output_index":0,"sequence_number":0}',
      '',
      'event: response.content_part.added',
      'data: {"type":"response.content_part.added","content_index":0,"item_id":"msg_1","output_index":0,"part":{"type":"output_text","text":""},"sequence_number":1}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","content_index":0,"delta":"ok","item_id":"msg_1","output_index":0,"sequence_number":2}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"id":"msg_1","type":"message","status":"completed","content":[{"type":"output_text","text":"ok"}],"role":"assistant"},"output_index":0,"sequence_number":3}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5.4","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":2,"output_tokens":1}},"sequence_number":4}',
      '',
    ].join('\n')

    const eventTypes = await collectStreamEventTypes(responseText)

    expect(eventTypes).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
  })

  test('Codex stream: abort signal cancels source while paused after message_start', async () => {
    const stalled = makeStallingCodexResponse([
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","content_index":0,"delta":"partial","item_id":"msg_1","output_index":0,"sequence_number":0}',
      '',
    ].join('\n'))
    const controller = new AbortController()
    const iterator = codexStreamToAnthropic(
      stalled.response,
      'gpt-5.4',
      controller.signal,
    )[Symbol.asyncIterator]()

    try {
      const first = await waitForPromise(
        iterator.next(),
        500,
        'Codex stream did not produce message_start',
      )
      expect(first.done).toBe(false)
      expect(first.value?.type).toBe('message_start')

      controller.abort()
      await waitForPromise(
        (async () => {
          for (let i = 0; i < 10; i++) {
            if (stalled.cancelReasons.length > 0) return
            await new Promise(resolve => setTimeout(resolve, 0))
          }
          throw new Error('Codex stream did not cancel source on abort')
        })(),
        500,
        'Codex stream did not cancel source on abort',
      )

      expect(stalled.cancelReasons).toHaveLength(1)
      expect((stalled.cancelReasons[0] as { name?: unknown }).name).toBe('AbortError')
    } finally {
      await Promise.resolve(iterator.return?.(undefined)).catch(() => {})
      stalled.close()
    }
  })

  test('Codex stream: abort signal stops buffered events after emitted delta', async () => {
    const stalled = makeStallingCodexResponse([
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","content_index":0,"delta":"first","item_id":"msg_1","output_index":0,"sequence_number":0}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","content_index":0,"delta":"second","item_id":"msg_1","output_index":0,"sequence_number":1}',
      '',
    ].join('\n'))
    const controller = new AbortController()
    const iterator = codexStreamToAnthropic(
      stalled.response,
      'gpt-5.4',
      controller.signal,
    )[Symbol.asyncIterator]()

    try {
      const messageStart = await waitForPromise(
        iterator.next(),
        500,
        'Codex stream did not produce message_start',
      )
      expect(messageStart.done).toBe(false)
      expect(messageStart.value?.type).toBe('message_start')

      const blockStart = await waitForPromise(
        iterator.next(),
        500,
        'Codex stream did not produce content_block_start',
      )
      expect(blockStart.done).toBe(false)
      expect(blockStart.value?.type).toBe('content_block_start')

      const firstDelta = await waitForPromise(
        iterator.next(),
        500,
        'Codex stream did not produce first delta',
      )
      expect(firstDelta.done).toBe(false)
      expect(firstDelta.value?.type).toBe('content_block_delta')
      expect((firstDelta.value as { delta?: { text?: string } }).delta?.text).toBe('first')

      controller.abort()
      const afterAbort = await waitForPromise(
        iterator.next().then(
          value => ({ status: 'resolved' as const, value }),
          error => ({ status: 'rejected' as const, error }),
        ),
        500,
        'Codex stream did not stop after abort',
      )

      if (afterAbort.status !== 'rejected') {
        throw new Error(`Codex stream yielded after abort: ${JSON.stringify(afterAbort.value)}`)
      }
      expect((afterAbort.error as { name?: unknown }).name).toBe('AbortError')
    } finally {
      await Promise.resolve(iterator.return?.(undefined)).catch(() => {})
      stalled.close()
    }
  })

  test('strips <think> tag block from Codex SSE text stream', async () => {
    const responseText = [
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message","status":"in_progress","content":[],"role":"assistant"},"output_index":0,"sequence_number":0}',
      '',
      'event: response.content_part.added',
      'data: {"type":"response.content_part.added","content_index":0,"item_id":"msg_1","output_index":0,"part":{"type":"output_text","text":""},"sequence_number":1}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","content_index":0,"delta":"<think>user wants a greeting, respond briefly</think>Hey! How can I help you today?","item_id":"msg_1","output_index":0,"sequence_number":2}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"id":"msg_1","type":"message","status":"completed","content":[{"type":"output_text","text":"<think>user wants a greeting, respond briefly</think>Hey! How can I help you today?"}],"role":"assistant"},"output_index":0,"sequence_number":3}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5.4","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"<think>user wants a greeting, respond briefly</think>Hey! How can I help you today?"}]}],"usage":{"input_tokens":2,"output_tokens":1}},"sequence_number":4}',
      '',
    ].join('\n')

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(responseText))
        controller.close()
      },
    })

    const textDeltas: string[] = []
    for await (const event of codexStreamToAnthropic(
      new Response(stream),
      'gpt-5.4',
    )) {
      const delta = (event as { delta?: { type?: string; text?: string } }).delta
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        textDeltas.push(delta.text)
      }
    }

    expect(textDeltas.join('')).toBe('Hey! How can I help you today?')
  })

  test('preserves prose without tags (no phrase-based false positive)', async () => {
    // Regression test: older phrase-based sanitizer would incorrectly strip text
    // starting with "I should" or "The user". The tag-based approach leaves it alone.
    const responseText = [
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message","status":"in_progress","content":[],"role":"assistant"},"output_index":0,"sequence_number":0}',
      '',
      'event: response.content_part.added',
      'data: {"type":"response.content_part.added","content_index":0,"item_id":"msg_1","output_index":0,"part":{"type":"output_text","text":""},"sequence_number":1}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","content_index":0,"delta":"I should note that the user role requires a briefly concise friendly response format.","item_id":"msg_1","output_index":0,"sequence_number":2}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"id":"msg_1","type":"message","status":"completed","content":[{"type":"output_text","text":"I should note that the user role requires a briefly concise friendly response format."}],"role":"assistant"},"output_index":0,"sequence_number":3}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5.4","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"I should note that the user role requires a briefly concise friendly response format."}]}],"usage":{"input_tokens":2,"output_tokens":1}},"sequence_number":4}',
      '',
    ].join('\n')

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(responseText))
        controller.close()
      },
    })

    const textDeltas: string[] = []
    for await (const event of codexStreamToAnthropic(
      new Response(stream),
      'gpt-5.4',
    )) {
      const delta = (event as { delta?: { type?: string; text?: string } }).delta
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        textDeltas.push(delta.text)
      }
    }

    expect(textDeltas.join('')).toBe(
      'I should note that the user role requires a briefly concise friendly response format.',
    )
  })

  // Regression for #1259 — codexspark / gpt-5.3-codex-spark backend delivers
  // complete function-call arguments only via the terminal `done` event with
  // zero `delta` events in between. Without handling either `done` variant,
  // the Anthropic tool_use block closed with `input: {}` and Glob/Bash/etc.
  // failed validation with "required parameter X is missing".
  async function collectToolArgs(responseText: string): Promise<string> {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(responseText))
        controller.close()
      },
    })

    const argsParts: string[] = []
    for await (const event of codexStreamToAnthropic(
      new Response(stream),
      'gpt-5.3-codex-spark',
    )) {
      const delta = (event as {
        delta?: { type?: string; partial_json?: string }
      }).delta
      if (
        delta?.type === 'input_json_delta' &&
        typeof delta.partial_json === 'string'
      ) {
        argsParts.push(delta.partial_json)
      }
    }
    return argsParts.join('')
  }

  test('Codex stream: tool args delivered only via function_call_arguments.done (#1259)', async () => {
    const args = '{"path":"./openclaude-codex-repro","pattern":"**/*.md"}'
    const responseText = [
      'event: response.output_item.added',
      `data: {"type":"response.output_item.added","item":{"id":"fc_1","call_id":"call_1","type":"function_call","name":"Glob","arguments":""},"output_index":0,"sequence_number":0}`,
      '',
      'event: response.function_call_arguments.done',
      `data: {"type":"response.function_call_arguments.done","item_id":"fc_1","arguments":${JSON.stringify(args)},"output_index":0,"sequence_number":1}`,
      '',
      'event: response.output_item.done',
      `data: {"type":"response.output_item.done","item":{"id":"fc_1","call_id":"call_1","type":"function_call","name":"Glob","arguments":${JSON.stringify(args)}},"output_index":0,"sequence_number":2}`,
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5.3-codex-spark","output":[],"usage":{"input_tokens":2,"output_tokens":3}},"sequence_number":3}',
      '',
    ].join('\n')

    expect(await collectToolArgs(responseText)).toBe(args)
  })

  test('Codex stream: tool args fallback via output_item.done when no delta + no arguments.done', async () => {
    const args = '{"command":"ls -la"}'
    const responseText = [
      'event: response.output_item.added',
      `data: {"type":"response.output_item.added","item":{"id":"fc_1","call_id":"call_1","type":"function_call","name":"Bash","arguments":""},"output_index":0,"sequence_number":0}`,
      '',
      'event: response.output_item.done',
      `data: {"type":"response.output_item.done","item":{"id":"fc_1","call_id":"call_1","type":"function_call","name":"Bash","arguments":${JSON.stringify(args)}},"output_index":0,"sequence_number":1}`,
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5.3-codex-spark","output":[],"usage":{"input_tokens":2,"output_tokens":3}},"sequence_number":2}',
      '',
    ].join('\n')

    expect(await collectToolArgs(responseText)).toBe(args)
  })

  test('Codex stream: delta path still works when present (no duplication on done)', async () => {
    const args = '{"path":"./x","pattern":"**/*.ts"}'
    const responseText = [
      'event: response.output_item.added',
      `data: {"type":"response.output_item.added","item":{"id":"fc_1","call_id":"call_1","type":"function_call","name":"Glob","arguments":""},"output_index":0,"sequence_number":0}`,
      '',
      'event: response.function_call_arguments.delta',
      `data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":${JSON.stringify(args)},"output_index":0,"sequence_number":1}`,
      '',
      'event: response.function_call_arguments.done',
      `data: {"type":"response.function_call_arguments.done","item_id":"fc_1","arguments":${JSON.stringify(args)},"output_index":0,"sequence_number":2}`,
      '',
      'event: response.output_item.done',
      `data: {"type":"response.output_item.done","item":{"id":"fc_1","call_id":"call_1","type":"function_call","name":"Glob","arguments":${JSON.stringify(args)}},"output_index":0,"sequence_number":3}`,
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5.3-codex-spark","output":[],"usage":{"input_tokens":2,"output_tokens":3}},"sequence_number":4}',
      '',
    ].join('\n')

    // Delta wins; done branches must NOT re-emit and double the JSON.
    expect(await collectToolArgs(responseText)).toBe(args)
  })
})

describe('convertSystemPrompt', () => {
  test('strips Anthropic attribution header block from text-block array (#607)', () => {
    const result = convertSystemPrompt([
      {
        type: 'text',
        text:
          'x-anthropic-billing-header: cc_version=0.8.0.abc123; ' +
          'cc_entrypoint=cli;',
      },
      { type: 'text', text: 'You are Claude Code.' },
      { type: 'text', text: 'Project context: bun + react.' },
    ])

    expect(result).not.toContain('x-anthropic-billing-header')
    expect(result).not.toContain('cc_version=')
    expect(result).toContain('You are Claude Code.')
    expect(result).toContain('Project context: bun + react.')
  })

  test('returns empty string when only the attribution block is present', () => {
    const result = convertSystemPrompt([
      {
        type: 'text',
        text: 'x-anthropic-billing-header: cc_version=0.8.0.abc;',
      },
    ])

    expect(result).toBe('')
  })

  test('passes plain string system prompts through untouched', () => {
    expect(convertSystemPrompt('You are Claude Code.')).toBe(
      'You are Claude Code.',
    )
  })
})
