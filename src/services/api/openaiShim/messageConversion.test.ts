import { expect, test } from 'bun:test'
import {
  convertMessages,
  convertSystemPrompt,
  convertToolResultContent,
} from './messageConversion.js'

type InputMessage = Parameters<typeof convertMessages>[0][number]

function convert(messages: InputMessage[], system: unknown = '') {
  return convertMessages(messages, system)
}

function toolExchange(
  resultContent: unknown,
  id = 'call_1',
): InputMessage[] {
  return [
    { role: 'user', content: 'Run the tool' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: 'image.png' } }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: resultContent }],
    },
  ]
}

test('preserves image tool results as placeholders in follow-up requests', () => {
  const messages = convert(toolExchange([
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZQ==' },
    },
  ]))
  const tool = messages.find(message => message.role === 'tool')

  expect(tool?.content).toEqual([
    { type: 'text', text: 'Image attached.' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,ZmFrZQ==' } },
  ])
})

test('adds text part for image-only user messages', () => {
  const messages = convert([{
    role: 'user',
    content: [{
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' },
    }],
  }])

  expect(messages[0]?.content).toEqual([
    { type: 'text', text: 'Image attached.' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
  ])
})

test('rejects image content for text-only providers', () => {
  expect(() => convertMessages(
    [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.test/image.png' } }] }],
    undefined,
    { supportsImageInputs: false },
  )).toThrow('does not support image inputs')
})

test('reports multipart shape for text+image tool results', () => {
  const messages = convert(toolExchange([
    { type: 'text', text: 'Screenshot captured' },
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZQ==' },
    },
  ], 'call_image_2'))
  const tool = messages.find(message => message.role === 'tool')

  expect(tool?.content).toEqual([
    { type: 'text', text: 'Screenshot captured' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,ZmFrZQ==' } },
  ])
})

test('skips malformed image and non-object content blocks', () => {
  expect(convert([{ role: 'user', content: [null, { type: 'image', source: { type: 'base64' } }] }], undefined))
    .toEqual([{ role: 'user', content: '' }])
})

test('coalesces consecutive user messages to avoid alternation errors (issue #202)', () => {
  const messages = convert([
    { role: 'user', content: 'First' },
    { role: 'user', content: 'Second' },
  ])

  expect(messages).toEqual([{ role: 'user', content: 'First\nSecond' }])
})

test('coalesces consecutive assistant messages preserving tool_calls (issue #202)', () => {
  const messages = convert([
    { role: 'assistant', content: 'First response' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Second response' },
        { type: 'tool_use', id: 'call_last', name: 'Bash', input: { command: 'pwd' } },
      ],
    },
  ])

  expect(messages).toHaveLength(1)
  expect(messages[0]?.content).toBe('First response\nSecond response')
  expect(messages[0]?.tool_calls?.[0]).toMatchObject({
    id: 'call_last',
    function: { name: 'Bash', arguments: '{"command":"pwd"}' },
  })
})

test('preserves valid tool_result and drops orphan tool_result', () => {
  const logs: string[] = []
  const messages = convertMessages([
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'valid_call_1', name: 'Search', input: { query: 'openclaude' } }],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'valid_call_1', content: 'Found it!' },
        { type: 'tool_result', tool_use_id: 'orphan_call_2', content: 'Interrupted result' },
        { type: 'text', text: 'What happened?' },
      ],
    },
  ], '', { log: message => logs.push(message) })
  const tools = messages.filter(message => message.role === 'tool')

  expect(tools).toHaveLength(1)
  expect(tools[0]?.tool_call_id).toBe('valid_call_1')
  expect(messages.some(message => message.content === '[Tool results received]')).toBe(false)
  expect(logs).toContain('Dropping orphan tool_result for ID: orphan_call_2 to prevent API error')
})

test('drops empty assistant message when only thinking block was present and stripped', () => {
  const messages = convert([
    { role: 'user', content: 'Initial' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'I am thinking...', signature: 'sig' }] },
    { role: 'user', content: 'Interrupting query' },
  ])

  expect(messages).toEqual([{ role: 'user', content: 'Initial\nInterrupting query' }])
})

test('drops empty assistant message when only redacted_thinking block was present and stripped', () => {
  const messages = convert([
    { role: 'user', content: 'Initial' },
    { role: 'assistant', content: [{ type: 'redacted_thinking', data: '[thinking hidden]' }] },
    { role: 'user', content: 'Interrupting query' },
  ])

  expect(messages).toEqual([{ role: 'user', content: 'Initial\nInterrupting query' }])
})

test('passes tool results through as role:tool messages without synthetic assistant filler (issue #2039)', () => {
  const messages = convert([
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'search', input: {} }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Result' }],
    },
    { role: 'user', content: 'Next user query' },
  ])

  expect(messages.map(message => message.role)).toEqual(['assistant', 'tool', 'user'])
  expect(messages.some(message => message.content === '[Tool results received]')).toBe(false)
})

test('keeps parallel tool results as consecutive role:tool messages before the next user turn (issue #2039)', () => {
  const messages = convert([
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'call_a', name: 'Read', input: { file_path: 'a.ts' } },
        { type: 'tool_use', id: 'call_b', name: 'Read', input: { file_path: 'b.ts' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_a', content: 'A contents' },
        { type: 'tool_result', tool_use_id: 'call_b', content: 'B contents' },
      ],
    },
    { role: 'user', content: 'Summarize both files' },
  ])

  expect(messages.map(message => message.role)).toEqual(['assistant', 'tool', 'tool', 'user'])
  expect(messages.filter(message => message.role === 'tool').map(message => message.tool_call_id))
    .toEqual(['call_a', 'call_b'])
  expect(messages[messages.length - 1]).toEqual({ role: 'user', content: 'Summarize both files' })
})

test('strips echoed [Tool results received] markers from legacy assistant history (issue #2039)', () => {
  const messages = convert([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'text', text: '[Tool results received]' }] },
    { role: 'user', content: 'ok' },
  ])

  expect(messages).toEqual([{ role: 'user', content: 'go\nok' }])
})

test('strips inline [Tool results received] echoes while keeping surrounding assistant prose', () => {
  const messages = convert([
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Working.\n[Tool results received]\nDone.' }],
    },
    { role: 'user', content: 'next' },
  ])

  expect(messages[0]).toEqual({ role: 'assistant', content: 'Working.\n\nDone.' })
})

test('drops legacy string assistant messages containing only the marker echo', () => {
  const messages = convert([
    { role: 'user', content: 'run' },
    { role: 'assistant', content: '[Tool results received]' },
    { role: 'user', content: 'done?' },
  ])

  expect(messages).toEqual([{ role: 'user', content: 'run\ndone?' }])
})

test('collapses multiple text blocks in tool_result to string for DeepSeek compatibility (issue #774)', () => {
  const messages = convert(toolExchange([
    { type: 'text', text: 'line one' },
    { type: 'text', text: 'line two' },
  ]))
  const tool = messages.find(message => message.role === 'tool')

  expect(typeof tool?.content).toBe('string')
  expect(tool?.content).toBe('line one\n\nline two')
})

test('collapses multiple text blocks into a single string for DeepSeek compatibility (issue #774)', () => {
  const messages = convert([{
    role: 'user',
    content: [
      { type: 'text', text: 'Hello!' },
      { type: 'text', text: 'How are you?' },
    ],
  }], 'test system')

  expect(messages).toEqual([
    { role: 'system', content: 'test system' },
    { role: 'user', content: 'Hello!\n\nHow are you?' },
  ])
})

test('preserves mixed text and image tool results as multipart content', () => {
  const messages = convert(toolExchange([
    { type: 'text', text: 'Here is the image:' },
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
    },
  ]))
  const tool = messages.find(message => message.role === 'tool')
  const content = tool?.content

  expect(Array.isArray(content)).toBe(true)
  expect(content).toHaveLength(2)
  expect(content?.[0]).toMatchObject({ type: 'text' })
  expect(content?.[1]).toMatchObject({ type: 'image_url' })
})

test('strips Anthropic attribution header block from chat-completions system prompt (#607)', () => {
  expect(convertSystemPrompt([
    { type: 'text', text: 'You are useful.' },
    { type: 'text', text: 'x-anthropic-billing-header: cc_version=1.0.0' },
  ])).toBe('You are useful.')
})

test('strips Anthropic attribution header block from responses-API instructions (#607)', () => {
  expect(convertSystemPrompt([
    { type: 'text', text: 'Follow these instructions.' },
    { type: 'text', text: 'x-anthropic-billing-header: cc_version=1.0.0; cc_entrypoint=cli' },
  ])).toBe('Follow these instructions.')
})

test('DeepSeek: redacted_thinking block preserves continuity with reasoning_content: ""', () => {
  const messages = convertMessages([{
    role: 'assistant',
    content: [
      { type: 'redacted_thinking', data: '' },
      { type: 'tool_use', id: 'call_1', name: 'Bash', input: {} },
    ],
  }], '', {
    preserveReasoningContent: true,
    reasoningContentFallback: '',
  })

  expect(messages[0]?.reasoning_content).toBe('')
  expect(messages[0]?.tool_calls).toHaveLength(1)
})

test('DeepSeek: redacted_thinking block with non-empty data propagates data into reasoning_content', () => {
  const messages = convertMessages([{
    role: 'assistant',
    content: [
      { type: 'redacted_thinking', data: 'preserved reasoning' },
      { type: 'tool_use', id: 'call_1', name: 'Bash', input: {} },
    ],
  }], '', { preserveReasoningContent: true })

  expect(messages[0]?.reasoning_content).toBe('preserved reasoning')
})

test('renders tool_reference blocks as text on the chat/completions path', () => {
  expect(convertToolResultContent([
    { type: 'tool_reference', tool_name: 'mcp__github__search_code' },
  ])).toBe('Tool "mcp__github__search_code" is now loaded and available to call.')
})

test('preserves valid tool pairs after history pruning while dropping orphaned tool calls', () => {
  const logs: string[] = []
  const messages = convertMessages([
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'valid', name: 'Read', input: { file_path: 'a.ts' } },
        { type: 'tool_use', id: 'orphan', name: 'Read', input: { file_path: 'b.ts' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'valid', content: 'contents' },
        { type: 'tool_result', tool_use_id: 'missing-call', content: 'stale' },
      ],
    },
  ], '', { log: message => logs.push(message) })

  expect(messages[0]?.tool_calls?.map(call => call.id)).toEqual(['valid'])
  expect(messages.filter(message => message.role === 'tool').map(message => message.tool_call_id)).toEqual(['valid'])
  expect(logs).toContain('Dropping orphan tool_result for ID: missing-call to prevent API error')
})
