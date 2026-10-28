import { APIConnectionTimeoutError, APIUserAbortError } from '@anthropic-ai/sdk'
import { expect, jest, test } from 'bun:test'
import { createGeminiVertexClient, type GeminiVertexStreamEvent } from './geminiVertexClient.js'

function createJsonVertexResponse(text: string) {
  return new Response(
    JSON.stringify({
      candidates: [
        { content: { parts: [{ text }] } },
      ],
    }),
    { headers: { 'Content-Type': 'application/json', 'x-request-id': 'vertex-request-123' } },
  )
}

test.each([false, true])('Vertex request cancellation reaches fetch and settles (stream=%s)', async stream => {
  const started = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  const controller = new AbortController()
  let fetchSignal: AbortSignal | null | undefined
  const client = createGeminiVertexClient({
    project: 'project-test', location: 'global', model: 'gemini-2.5-flash',
    getAccessToken: async () => 'token',
    fetch: async (_input, init) => {
      fetchSignal = init?.signal
      fetchSignal?.addEventListener('abort', () => response.reject(fetchSignal?.reason), { once: true })
      started.resolve()
      return response.promise
    },
  })
  const request = (stream ? client.beta.messages : client.messages).create({
    model: 'gemini-2.5-flash', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }], stream,
  }, { signal: controller.signal })
  const outcome = (stream ? request.withResponse() : request).then(() => undefined, error => error)
  try {
    await started.promise
    controller.abort()
    response.resolve(createJsonVertexResponse('late'))
    expect(await outcome).toBeInstanceOf(APIUserAbortError)
    expect(fetchSignal?.aborted).toBe(true)
  } finally {
    controller.abort()
    response.resolve(createJsonVertexResponse('cleanup'))
    await outcome
  }
})

test('Vertex honors an explicit request timeout and releases its timer', async () => {
  jest.useFakeTimers()
  const started = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  const client = createGeminiVertexClient({
    project: 'project-test', location: 'global', model: 'gemini-2.5-flash',
    getAccessToken: async () => 'token',
    fetch: async (_input, init) => {
      init?.signal?.addEventListener('abort', () => response.reject(init.signal?.reason), { once: true })
      started.resolve()
      return response.promise
    },
  })
  const outcome = client.messages.create({
    model: 'gemini-2.5-flash', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }],
  }, { timeout: 5 }).then(() => undefined, error => error)
  try {
    await started.promise
    jest.advanceTimersByTime(5)
    response.resolve(createJsonVertexResponse('late'))
    expect(await outcome).toBeInstanceOf(APIConnectionTimeoutError)
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    response.resolve(createJsonVertexResponse('cleanup'))
    await outcome
    jest.useRealTimers()
  }
})

test('an already-cancelled Vertex request never resolves credentials or sends a request', async () => {
  let calls = 0
  const client = createGeminiVertexClient({
    project: 'project-test', location: 'global', model: 'gemini-2.5-flash',
    getAccessToken: async () => { calls++; return 'token' },
    fetch: async () => { calls++; return createJsonVertexResponse('unexpected') },
  })
  await expect(client.messages.create({
    model: 'gemini-2.5-flash', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }],
  }, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(APIUserAbortError)
  expect(calls).toBe(0)
})

test('Gemini Vertex client uses root aiplatform host for global location', async () => {
  let capturedUrl: string | undefined

  const client = createGeminiVertexClient({
    project: 'project-123',
    location: 'global',
    model: 'gemini-3.5-flash',
    getAccessToken: async () => 'access-token-123',
    fetch: (async (input) => {
      capturedUrl = String(input)
      return createJsonVertexResponse('Bonjour Global Vertex')
    }) as typeof fetch,
  })

  await client.messages.create({
    model: 'gemini-3.5-flash',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'Salut' }],
  })

  expect(capturedUrl).toBe(
    'https://aiplatform.googleapis.com/v1/projects/project-123/locations/global/publishers/google/models/gemini-3.5-flash:generateContent',
  )
})

test('Gemini Vertex client sends Anthropic-style messages to Vertex generateContent', async () => {
  let capturedUrl: string | undefined
  let capturedHeaders: Headers | undefined
  let capturedBody: Record<string, unknown> | undefined

  const client = createGeminiVertexClient({
    project: 'project-123',
    location: 'us-central1',
    model: 'gemini-3.5-flash',
    getAccessToken: async () => 'access-token-123',
    fetch: (async (input, init) => {
      capturedUrl = String(input)
      capturedHeaders = new Headers(init?.headers)
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>

      return createJsonVertexResponse('Bonjour Vertex')
    }) as typeof fetch,
  })

  const response = await client.messages.create({
    model: 'gemini-2.5-pro',
    max_tokens: 321,
    temperature: 0.25,
    messages: [
      { role: 'user', content: 'Salut' },
      { role: 'assistant', content: [{ type: 'text', text: 'Ancienne rÃ©ponse' }] },
      { role: 'user', content: [{ type: 'text', text: 'Suite' }] },
    ],
  })

  expect(capturedUrl).toBe(
    'https://us-central1-aiplatform.googleapis.com/v1/projects/project-123/locations/us-central1/publishers/google/models/gemini-3.5-flash:generateContent',
  )
  expect(capturedHeaders?.get('authorization')).toBe('Bearer access-token-123')
  expect(capturedHeaders?.get('x-goog-user-project')).toBe('project-123')
  expect(capturedBody).toEqual({
    contents: [
      { role: 'user', parts: [{ text: 'Salut' }] },
      { role: 'model', parts: [{ text: 'Ancienne rÃ©ponse' }] },
      { role: 'user', parts: [{ text: 'Suite' }] },
    ],
    generationConfig: {
      // gemini-3.5-flash is a thinking model: we raise the floor so the
      // model has room to think AND emit visible text. The caller asked
      // for 321 but the floor wins.
      maxOutputTokens: 8192,
      // Thinking models degrade (looping / empty output) below temperature
      // 1.0, so the caller's 0.25 is clamped up to the documented 1.0 floor.
      temperature: 1,
    },
  })
  expect(response).toMatchObject({
    role: 'assistant',
    model: 'gemini-3.5-flash',
    content: [{ type: 'text', text: 'Bonjour Vertex' }],
  })
})

test('Gemini Vertex client clamps thinking-model temperature to the 1.0 floor', async () => {
  let capturedBody: Record<string, unknown> | undefined

  const client = createGeminiVertexClient({
    project: 'project-123',
    location: 'global',
    model: 'gemini-3.5-flash',
    getAccessToken: async () => 'access-token-123',
    fetch: (async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return createJsonVertexResponse('ok')
    }) as typeof fetch,
  })

  await client.messages.create({
    model: 'gemini-3.5-flash',
    max_tokens: 100,
    temperature: 0, // coding-agent determinism â€” must be lifted to 1.0
    messages: [{ role: 'user', content: 'salut' }],
  })

  expect((capturedBody?.generationConfig as Record<string, unknown>).temperature).toBe(1)
})

test('Gemini Vertex client renders tool_reference blocks in tool results as readable text', async () => {
  let capturedBody: Record<string, unknown> | undefined

  const client = createGeminiVertexClient({
    project: 'project-123',
    location: 'global',
    model: 'gemini-2.5-flash',
    getAccessToken: async () => 'access-token-123',
    fetch: (async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return createJsonVertexResponse('ok')
    }) as typeof fetch,
  })

  await client.messages.create({
    model: 'gemini-2.5-flash',
    max_tokens: 100,
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_ts1', name: 'ToolSearch', input: { query: 'memory' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_ts1',
            content: [
              { type: 'tool_reference', tool_name: 'mcp__example__memory_search' },
            ] as never,
          },
        ],
      },
    ],
  })

  const serialized = JSON.stringify(capturedBody?.contents)
  expect(serialized).toContain('mcp__example__memory_search')
})

test('Gemini Vertex client preserves temperature for non-thinking models', async () => {
  let capturedBody: Record<string, unknown> | undefined

  const client = createGeminiVertexClient({
    project: 'project-123',
    location: 'global',
    model: 'gemini-2.5-flash', // not a thinking model
    getAccessToken: async () => 'access-token-123',
    fetch: (async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return createJsonVertexResponse('ok')
    }) as typeof fetch,
  })

  await client.messages.create({
    model: 'gemini-2.5-flash',
    max_tokens: 100,
    temperature: 0.25,
    messages: [{ role: 'user', content: 'salut' }],
  })

  expect((capturedBody?.generationConfig as Record<string, unknown>).temperature).toBe(0.25)
})

test('Gemini Vertex client supports Anthropic streaming withResponse contract', async () => {
  const client = createGeminiVertexClient({
    project: 'project-123',
    location: 'us-central1',
    model: 'gemini-3.5-flash',
    getAccessToken: async () => 'access-token-123',
    fetch: (async () => createJsonVertexResponse('Bonjour Vertex')) as unknown as typeof fetch,
  })

  const result = await client.beta.messages.create({
    model: 'gemini-3.5-flash',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'Salut' }],
    stream: true,
  }).withResponse()

  const events: GeminiVertexStreamEvent[] = []
  for await (const event of result.data) {
    events.push(event)
  }

  expect(result.request_id).toBe('vertex-request-123')
  expect(result.response).toBeInstanceOf(Response)
  expect(events.map(event => event.type)).toEqual([
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ])
  expect(events[2]).toMatchObject({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Bonjour Vertex' },
  })
})

test('Gemini Vertex client forwards Anthropic tools as Vertex functionDeclarations', async () => {
  let capturedBody: Record<string, unknown> | undefined

  const client = createGeminiVertexClient({
    project: 'project-123',
    location: 'global',
    model: 'gemini-2.5-flash',
    getAccessToken: async () => 'access-token-123',
    fetch: (async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return createJsonVertexResponse('ok')
    }) as typeof fetch,
  })

  await client.messages.create({
    model: 'gemini-2.5-flash',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'list files' }],
    tools: [
      {
        name: 'Read',
        description: 'Read a file',
        input_schema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'absolute path' },
            limit: { type: 'integer' },
          },
          required: ['file_path'],
          additionalProperties: false,
        },
      },
    ],
  })

  expect(capturedBody?.tools).toEqual([
    {
      functionDeclarations: [
        {
          name: 'Read',
          description: 'Read a file',
          parameters: {
            type: 'OBJECT',
            properties: {
              file_path: { type: 'STRING', description: 'absolute path' },
              limit: { type: 'INTEGER' },
            },
            required: ['file_path'],
          },
        },
      ],
    },
  ])
})

test('Gemini Vertex client strips JSON Schema keywords Vertex rejects', async () => {
  let capturedBody: Record<string, unknown> | undefined

  const client = createGeminiVertexClient({
    project: 'project-123',
    location: 'global',
    model: 'gemini-2.5-flash',
    getAccessToken: async () => 'access-token-123',
    fetch: (async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return createJsonVertexResponse('ok')
    }) as typeof fetch,
  })

  await client.messages.create({
    model: 'gemini-2.5-flash',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'go' }],
    tools: [
      {
        name: 'Tricky',
        description: 'Schema with keywords Vertex does not accept',
        input_schema: {
          type: 'object',
          $schema: 'http://json-schema.org/draft-07/schema#',
          additionalProperties: false,
          propertyNames: { pattern: '^[a-z]+$' },
          properties: {
            count: { type: 'integer', exclusiveMinimum: 0 },
            mode: { type: 'string', const: 'fast' },
            tags: {
              type: 'array',
              items: { type: 'string' },
              patternProperties: { '.*': { type: 'string' } },
            },
          },
          required: ['count'],
        },
      },
    ],
  })

  const tools = capturedBody?.tools as Array<{
    functionDeclarations: Array<{ parameters: Record<string, unknown> }>
  }>
  const params = tools[0]!.functionDeclarations[0]!.parameters
  expect(params).toEqual({
    type: 'OBJECT',
    properties: {
      // exclusiveMinimum approximated as minimum, type uppercased
      count: { type: 'INTEGER', minimum: 0 },
      // const translated to single-value enum
      mode: { type: 'STRING', enum: ['fast'] },
      tags: { type: 'ARRAY', items: { type: 'STRING' } },
    },
    required: ['count'],
  })
})

test('Gemini Vertex client surfaces functionCall responses as tool_use blocks', async () => {
  const client = createGeminiVertexClient({
    project: 'project-123',
    location: 'global',
    model: 'gemini-2.5-flash',
    getAccessToken: async () => 'access-token-123',
    fetch: (async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: 'Read',
                      args: { file_path: '/tmp/notes.md' },
                    },
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch,
  })

  const response = await client.messages.create({
    model: 'gemini-2.5-flash',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'list files' }],
  })

  expect(response.stop_reason).toBe('tool_use')
  expect(response.content).toHaveLength(1)
  const block = response.content[0]!
  expect(block.type).toBe('tool_use')
  expect(block).toMatchObject({
    type: 'tool_use',
    name: 'Read',
    input: { file_path: '/tmp/notes.md' },
  })
})

test('Gemini Vertex client round-trips functionCall thoughtSignature through history', async () => {
  let capturedBody: Record<string, unknown> | undefined

  const client = createGeminiVertexClient({
    project: 'project-123',
    location: 'global',
    model: 'gemini-3.5-flash',
    getAccessToken: async () => 'access-token-123',
    fetch: (async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      // The model emits a functionCall WITH a thoughtSignature (thinking model).
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { name: 'Skill', args: { skill: 'x' } },
                    thoughtSignature: 'SIG_ABC_123',
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof fetch,
  })

  // First turn: capture the tool_use id the client synthesises.
  const first = await client.messages.create({
    model: 'gemini-3.5-flash',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'salut' }],
  })
  const toolUse = first.content[0] as { type: string; id: string; name: string }
  expect(toolUse.type).toBe('tool_use')

  // Second turn: replay the assistant tool_use + a tool_result, exactly as the
  // agent loop would. The functionCall part sent to Vertex MUST carry the
  // original thoughtSignature, or Vertex 400s.
  await client.messages.create({
    model: 'gemini-3.5-flash',
    max_tokens: 100,
    messages: [
      { role: 'user', content: 'salut' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUse.id, name: toolUse.name, input: { skill: 'x' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'done' }],
      },
    ],
  })

  const contents = capturedBody?.contents as Array<{
    role: string
    parts: Array<Record<string, unknown>>
  }>
  const functionCallPart = contents
    .flatMap(c => c.parts)
    .find(p => 'functionCall' in p)
  expect(functionCallPart).toEqual({
    functionCall: { name: 'Skill', args: { skill: 'x' } },
    thoughtSignature: 'SIG_ABC_123',
  })
})

test('Gemini Vertex client keeps functionResponse turns pure (splits trailing text)', async () => {
  let capturedBody: Record<string, unknown> | undefined

  const client = createGeminiVertexClient({
    project: 'project-123',
    location: 'global',
    model: 'gemini-2.5-flash',
    getAccessToken: async () => 'access-token-123',
    fetch: (async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return createJsonVertexResponse('Bonjour')
    }) as typeof fetch,
  })

  await client.messages.create({
    model: 'gemini-2.5-flash',
    max_tokens: 100,
    messages: [
      { role: 'user', content: 'salut' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Skill', input: { skill: 'x' } }],
      },
      {
        // openclaude appends a system-reminder text AFTER the tool_result in
        // the SAME user message â€” this must not pollute the functionResponse turn.
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'loaded' },
          { type: 'text', text: '<system-reminder>stay on task</system-reminder>' },
        ],
      },
    ],
  })

  // The functionResponse turn is emitted pure, immediately after the model's
  // functionCall; the reminder text is pushed to its own following user turn.
  expect(capturedBody?.contents).toEqual([
    { role: 'user', parts: [{ text: 'salut' }] },
    { role: 'model', parts: [{ functionCall: { name: 'Skill', args: { skill: 'x' } } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'Skill', response: { result: 'loaded' } } }] },
    { role: 'user', parts: [{ text: '<system-reminder>stay on task</system-reminder>' }] },
  ])
})

test('Gemini Vertex client includes a response diagnostic on empty STOP responses', async () => {
  const client = createGeminiVertexClient({
    project: 'project-123',
    location: 'global',
    model: 'gemini-3.5-flash',
    getAccessToken: async () => 'access-token-123',
    fetch: (async () =>
      new Response(
        JSON.stringify({
          // A "thought-only" turn: the model burned tokens thinking but emitted
          // no visible parts. finishReason STOP, empty content.
          candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
          usageMetadata: {
            promptTokenCount: 1200,
            candidatesTokenCount: 0,
            thoughtsTokenCount: 640,
            totalTokenCount: 1840,
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch,
  })

  await expect(
    client.messages.create({
      model: 'gemini-3.5-flash',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'salut' }],
    }),
  ).rejects.toThrow(/\[diag candidates=1 content:yes parts=\[\] \| usage prompt=1200 candidates=0 thoughts=640 total=1840 \| promptBlock:none\]/)
})

test('Gemini Vertex client propagates HTTP errors', async () => {
  const client = createGeminiVertexClient({
    project: 'project-123',
    location: 'us-central1',
    model: 'gemini-3.5-flash',
    getAccessToken: async () => 'access-token-123',
    fetch: (async () => new Response('permission denied', { status: 403 })) as NonNullable<import('@anthropic-ai/sdk').ClientOptions['fetch']>,
  })

  await expect(client.messages.create({
    model: 'gemini-3.5-flash',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'Salut' }],
  })).rejects.toThrow('Gemini Vertex request failed: 403 permission denied')
})

test('native wire preserves direct media and FileRead images without mixing function responses', async () => {
  const { FileReadTool } = await import('../../tools/FileReadTool/FileReadTool.js')
  const image = { type: 'image' as const, source: {
    type: 'base64' as const, media_type: 'image/png' as const, data: 'cG5n',
  } }
  const pdf = { type: 'document' as const, source: {
    type: 'base64' as const, media_type: 'application/pdf' as const, data: 'cGRm',
  } }
  const result = FileReadTool.mapToolResultToToolResultBlockParam({
    type: 'image', file: { base64: image.source.data, type: image.source.media_type, originalSize: 3 },
  }, 'read-image')
  let sent: Record<string, unknown> | undefined
  const client = createGeminiVertexClient({
    project: 'project-test', location: 'global', model: 'gemini-2.5-flash',
    getAccessToken: async () => 'token',
    fetch: async (_url, init) => {
      sent = JSON.parse(String(init?.body))
      return createJsonVertexResponse('seen')
    },
  })
  await client.messages.create({
    model: 'gemini-2.5-flash', max_tokens: 8, messages: [
      { role: 'user', content: [image] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'read-image', name: 'Read', input: {} }] },
      { role: 'user', content: [result] },
      { role: 'user', content: [pdf] },
    ],
  })
  expect(sent?.contents).toEqual([
    { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'cG5n' } }] },
    { role: 'model', parts: [{ functionCall: { name: 'Read', args: {} } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'Read', response: { result: '' } } }] },
    { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'cG5n' } }] },
    { role: 'user', parts: [{ inlineData: { mimeType: 'application/pdf', data: 'cGRm' } }] },
  ])
})

test('native wire rejects unsupported URL media before sending instead of losing it', async () => {
  let requests = 0
  const client = createGeminiVertexClient({
    project: 'project-test', location: 'global', model: 'gemini-2.5-flash',
    getAccessToken: async () => 'token',
    fetch: async () => { requests++; return createJsonVertexResponse('unexpected') },
  })
  await expect(client.messages.create({
    model: 'gemini-2.5-flash', max_tokens: 8, messages: [{
      role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.invalid/secret' } }],
    }],
  })).rejects.toThrow(/base64/)
  expect(requests).toBe(0)
})

test('direct native client rejects a host-changing location before resolving a bearer', () => {
  let credentials = 0
  expect(() => createGeminiVertexClient({
    project: 'project-test', location: 'evil.example/x#', model: 'gemini-2.5-flash',
    getAccessToken: async () => { credentials++; return 'token' },
  })).toThrow('GEMINI_VERTEX_LOCATION')
  expect(credentials).toBe(0)
})
