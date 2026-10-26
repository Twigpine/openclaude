import { describe, expect, test } from 'bun:test'

import {
  renderMessagesToJSON as renderMessagesToJSONStrict,
  renderMessagesToMarkdown as renderMessagesToMarkdownStrict,
} from './exportRenderer.js'

// The renderers are defensive against malformed transcript entries, and these
// tests deliberately feed minimal/invalid shapes (e.g. type: 'tool'). Loosen
// the signatures type-side only so the fixtures don't need full envelopes.
const renderMessagesToMarkdown =
  renderMessagesToMarkdownStrict as unknown as (messages: unknown[]) => string
const renderMessagesToJSON = renderMessagesToJSONStrict as unknown as (
  messages: unknown[],
) => string

// Minimal Message-shaped objects (full Message union now reconstructed; the
// fixtures here intentionally remain partial)
function userMessage(text: string) {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    timestamp: '2026-05-13T12:00:00Z',
  }
}

function assistantMessage(text: string) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    timestamp: '2026-05-13T12:00:01Z',
  }
}

function toolUseMessage(toolName: string, input: Record<string, unknown>) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tool-123', name: toolName, input },
      ],
    },
    timestamp: '2026-05-13T12:00:02Z',
  }
}

function toolResultMessage(content: string, isError = false) {
  return {
    type: 'tool',
    message: {
      role: 'tool',
      content: [
        { type: 'tool_result', tool_use_id: 'tool-123', content, is_error: isError },
      ],
    },
    timestamp: '2026-05-13T12:00:03Z',
  }
}

describe('renderMessagesToMarkdown', () => {
  test('includes conversation export header', () => {
    const md = renderMessagesToMarkdown([userMessage('hello')])
    expect(md).toContain('# Conversation Export')
    expect(md).toContain('Format: Markdown')
  })

  test('includes exported timestamp', () => {
    const md = renderMessagesToMarkdown([])
    expect(md).toMatch(/Exported: \d{4}-\d{2}-\d{2}T/)
  })

  test('renders user and assistant headings', () => {
    const md = renderMessagesToMarkdown([
      userMessage('hello'),
      assistantMessage('world'),
    ])
    expect(md).toContain('## User')
    expect(md).toContain('## Assistant')
  })

  test('preserves text content', () => {
    const md = renderMessagesToMarkdown([userMessage('hello world')])
    expect(md).toContain('hello world')
  })

  test('renders tool use blocks', () => {
    const md = renderMessagesToMarkdown([
      toolUseMessage('Bash', { command: 'ls -la' }),
    ])
    expect(md).toContain('### Tool Use: Bash')
    expect(md).toContain('```json')
    expect(md).toContain('ls -la')
  })

  test('uses a longer Markdown fence when tool input contains backticks', () => {
    const md = renderMessagesToMarkdown([
      toolUseMessage('Bash', { command: 'printf "```"' }),
    ])
    expect(md).toContain('````json')
    expect(md).toContain('printf \\"```\\"')
  })

  test('renders tool result blocks', () => {
    const md = renderMessagesToMarkdown([
      toolResultMessage('file1.txt\nfile2.txt'),
    ])
    expect(md).toContain('## Tool Result')
    expect(md).toContain('file1.txt')
    // Should NOT have duplicate sub-heading since message heading already says "Tool Result"
    expect(md).not.toContain('### Tool Result')
  })

  test('uses a longer Markdown fence when tool output contains backticks', () => {
    const md = renderMessagesToMarkdown([
      toolResultMessage('before\n```\ninside\n```\nafter'),
    ])
    expect(md).toContain('````text')
    expect(md).toContain('before\n```\ninside\n```\nafter')
  })

  test('marks errored tool results from runtime is_error field', () => {
    const md = renderMessagesToMarkdown([
      toolResultMessage('failure output', true),
    ])
    expect(md).toContain('failure output')
    expect(md).toContain('*(Error)*')
  })

  test('renders tool result from runtime shape (type: user with tool_result content)', () => {
    // Real runtime: tool results are type:'user' messages with tool_result content blocks
    const runtimeToolResult = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'output text' }],
      },
    }
    const md = renderMessagesToMarkdown([runtimeToolResult])
    expect(md).toContain('## Tool Result')
    expect(md).toContain('output text')
    expect(md).not.toContain('## User')
    expect(md).not.toContain('### Tool Result')
  })

  test('does not label mixed human text and tool result content as a tool result message', () => {
    const mixedMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu-1', content: 'tool output' },
          { type: 'text', text: 'human follow-up' },
        ],
      },
    }
    const md = renderMessagesToMarkdown([mixedMessage])
    expect(md).toContain('## User')
    expect(md).toContain('### Tool Result')
    expect(md).toContain('human follow-up')
  })

  test('treats system-reminder siblings as tool result metadata', () => {
    const runtimeToolResult = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu-1', content: 'tool output' },
          { type: 'text', text: '<system-reminder>note</system-reminder>' },
        ],
      },
    }
    const md = renderMessagesToMarkdown([runtimeToolResult])
    expect(md).toContain('## Tool Result')
    expect(md).not.toContain('## User')
    expect(md).not.toContain('<system-reminder>')
  })

  test('handles empty messages array', () => {
    const md = renderMessagesToMarkdown([])
    expect(md).toContain('# Conversation Export')
    expect(md).not.toContain('## User')
  })

  test('handles null/undefined messages gracefully', () => {
    const md = renderMessagesToMarkdown([null, undefined])
    expect(md).toContain('# Conversation Export')
  })

  test('renders image placeholder', () => {
    const msg = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png' } }],
      },
    }
    const md = renderMessagesToMarkdown([msg])
    expect(md).toContain('[Image attachment]')
  })

  test('skips progress messages', () => {
    const progressMsg = { type: 'progress', message: { role: 'user', content: [{ type: 'text', text: 'Loading...' }] } }
    const md = renderMessagesToMarkdown([progressMsg, userMessage('hello')])
    expect(md).not.toContain('## Progress')
    expect(md).toContain('## User')
  })

  test('skips attachment messages', () => {
    const attMsg = { type: 'attachment', attachment: { type: 'file', name: 'test.txt' } }
    const md = renderMessagesToMarkdown([attMsg, userMessage('hello')])
    expect(md).not.toContain('## Attachment')
    expect(md).toContain('## User')
  })

  test('skips system api_metrics messages', () => {
    const metricsMsg = { type: 'system', subtype: 'api_metrics', message: { role: 'system', content: [] } }
    const md = renderMessagesToMarkdown([metricsMsg, userMessage('hello')])
    expect(md).not.toContain('## System')
    expect(md).toContain('## User')
  })

  test('skips messages with empty content', () => {
    const emptyMsg = { type: 'system', message: { role: 'system', content: [] } }
    const md = renderMessagesToMarkdown([emptyMsg, userMessage('hello')])
    expect(md).not.toContain('## System')
    expect(md).toContain('## User')
  })

  test('skips thinking blocks', () => {
    const msg = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Let me think about this...' }],
      },
    }
    const md = renderMessagesToMarkdown([msg])
    expect(md).not.toContain('Let me think about this...')
    expect(md).not.toContain('## Assistant')
  })

  test('skips redacted thinking blocks', () => {
    const msg = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'redacted_thinking' }],
      },
    }
    const md = renderMessagesToMarkdown([msg])
    expect(md).not.toContain('redacted_thinking')
    // Should skip the message entirely since it has no visible content
    expect(md).not.toContain('## Assistant')
  })

  test('renders top-level system message content', () => {
    const md = renderMessagesToMarkdown([
      {
        type: 'system',
        subtype: 'local_command',
        content: 'local command output',
      },
    ])
    expect(md).toContain('## System')
    expect(md).toContain('local command output')
  })

  test('renders local command output wrappers without leaking XML tags', () => {
    const md = renderMessagesToMarkdown([
      {
        type: 'user',
        message: {
          role: 'user',
          content: '<local-command-stdout>command output</local-command-stdout>',
        },
      },
    ])
    expect(md).toContain('## Local Command Output')
    expect(md).toContain('command output')
    expect(md).not.toContain('<local-command-stdout>')
  })

  test('renders combined terminal output wrappers without leaking XML tags', () => {
    const md = renderMessagesToMarkdown([
      {
        type: 'user',
        message: {
          role: 'user',
          content: '<bash-stdout>stdout text</bash-stdout><bash-stderr>stderr text</bash-stderr>',
        },
      },
    ])
    expect(md).toContain('## Bash Output')
    expect(md).toContain('### STDOUT')
    expect(md).toContain('stdout text')
    expect(md).toContain('### STDERR')
    expect(md).toContain('stderr text')
    expect(md).not.toContain('<bash-stdout>')
    expect(md).not.toContain('<bash-stderr>')
  })

  test('renders bash input wrappers without leaking XML tags', () => {
    const md = renderMessagesToMarkdown([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '<bash-input>ls -la</bash-input>' }],
        },
      },
    ])
    expect(md).toContain('## Bash Input')
    expect(md).toContain('ls -la')
    expect(md).not.toContain('<bash-input>')
  })

  test('renders terminal wrappers with internal siblings as system output in Markdown', () => {
    const md = renderMessagesToMarkdown([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '<bash-stdout>stdout text</bash-stdout>' },
            { type: 'text', text: '<system-reminder>hidden metadata</system-reminder>' },
          ],
        },
      },
    ])
    expect(md).toContain('## Bash Output')
    expect(md).toContain('stdout text')
    expect(md).not.toContain('## User')
    expect(md).not.toContain('<system-reminder>')
  })

  test('renders unknown content block payload in Markdown', () => {
    const md = renderMessagesToMarkdown([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'server_tool_use', id: 'srv-1', name: 'web_search' }],
        },
      },
    ])
    expect(md).toContain('*[server_tool_use content block]*')
    expect(md).toContain('```json')
    expect(md).toContain('"id": "srv-1"')
    expect(md).toContain('"name": "web_search"')
  })

  test('handles malformed numeric message types in Markdown', () => {
    const md = renderMessagesToMarkdown([
      {
        type: 42,
        message: { content: [{ type: 'text', text: 'numeric type' }] },
      },
    ])
    expect(md).toContain('## 42')
    expect(md).toContain('numeric type')
  })

  test('skips internal meta and command breadcrumb messages in Markdown', () => {
    const md = renderMessagesToMarkdown([
      {
        type: 'user',
        isMeta: true,
        message: { role: 'user', content: [{ type: 'text', text: 'internal caveat' }] },
      },
      {
        type: 'user',
        message: { role: 'user', content: '<command-name>/model</command-name>' },
      },
      {
        type: 'user',
        message: { role: 'user', content: '<system-reminder>hidden</system-reminder>' },
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>hidden array</system-reminder>' }] },
      },
      userMessage('visible user text'),
    ])
    expect(md).not.toContain('internal caveat')
    expect(md).not.toContain('<command-name>')
    expect(md).not.toContain('<system-reminder>')
    expect(md).toContain('visible user text')
  })

  test('filters internal text blocks while preserving mixed real content in Markdown', () => {
    const md = renderMessagesToMarkdown([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '<command-name>/export</command-name>' },
            { type: 'text', text: 'real user content' },
          ],
        },
      },
    ])
    expect(md).toContain('## User')
    expect(md).toContain('real user content')
    expect(md).not.toContain('<command-name>')
  })

  test('does not drop visible Markdown text that contains internal tag wrappers', () => {
    const md = renderMessagesToMarkdown([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'visible before <command-name>/export</command-name> visible after' }],
        },
      },
    ])
    expect(md).toContain('## User')
    expect(md).toContain('visible before  visible after')
    expect(md).not.toContain('<command-name>')
  })

  test('strips system reminders embedded in visible Markdown text', () => {
    const md = renderMessagesToMarkdown([
      userMessage('visible before <system-reminder>hidden</system-reminder> visible after'),
    ])
    expect(md).toContain('visible before  visible after')
    expect(md).not.toContain('<system-reminder>')
    expect(md).not.toContain('hidden')
  })

  test('renders Markdown fallback for non-array unknown content', () => {
    const md = renderMessagesToMarkdown([
      {
        type: 'custom',
        content: { value: 42 },
      },
    ])
    expect(md).toContain('## Custom')
    expect(md).toContain('*[unknown content]*')
    expect(md).toContain('"value": 42')
  })

  test('renders Markdown fallback for primitive array entries', () => {
    const md = renderMessagesToMarkdown([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: ['primitive content'],
        },
      },
    ])
    expect(md).toContain('## Assistant')
    expect(md).toContain('*[unknown content]*')
    expect(md).toContain('primitive content')
  })
})

describe('renderMessagesToJSON', () => {
  test('produces valid JSON', () => {
    const json = renderMessagesToJSON([userMessage('hello')])
    expect(() => JSON.parse(json)).not.toThrow()
  })

  test('includes version: 1', () => {
    const parsed = JSON.parse(renderMessagesToJSON([]))
    expect(parsed.version).toBe(1)
  })

  test('includes format: json', () => {
    const parsed = JSON.parse(renderMessagesToJSON([]))
    expect(parsed.format).toBe('json')
  })

  test('includes exportedAt as ISO string', () => {
    const parsed = JSON.parse(renderMessagesToJSON([]))
    expect(parsed.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  test('includes messageCount', () => {
    const parsed = JSON.parse(renderMessagesToJSON([userMessage('a'), assistantMessage('b')]))
    expect(parsed.messageCount).toBe(2)
  })

  test('preserves message order', () => {
    const parsed = JSON.parse(renderMessagesToJSON([
      userMessage('first'),
      assistantMessage('second'),
      userMessage('third'),
    ]))
    expect(parsed.messages[0].content[0].text).toBe('first')
    expect(parsed.messages[1].content[0].text).toBe('second')
    expect(parsed.messages[2].content[0].text).toBe('third')
  })

  test('includes message type and role', () => {
    const parsed = JSON.parse(renderMessagesToJSON([userMessage('hello')]))
    expect(parsed.messages[0].type).toBe('user')
    expect(parsed.messages[0].role).toBe('user')
  })

  test('handles tool_use content blocks', () => {
    const parsed = JSON.parse(renderMessagesToJSON([toolUseMessage('Read', { file_path: '/test.ts' })]))
    const content = parsed.messages[0].content[0]
    expect(content.type).toBe('tool_use')
    expect(content.name).toBe('Read')
    expect(content.input.file_path).toBe('/test.ts')
  })

  test('handles tool_result content blocks', () => {
    const parsed = JSON.parse(renderMessagesToJSON([toolResultMessage('result text', true)]))
    expect(parsed.messages[0].role).toBe('tool')
    const content = parsed.messages[0].content[0]
    expect(content.type).toBe('tool_result')
    expect(content.content).toBe('result text')
    expect(content.isError).toBe(true)
  })

  test('exports runtime tool_result messages as semantic tool messages', () => {
    const runtimeToolResult = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'output' }],
      },
    }
    const parsed = JSON.parse(renderMessagesToJSON([runtimeToolResult]))
    expect(parsed.messages[0].type).toBe('tool')
    expect(parsed.messages[0].role).toBe('tool')
    expect(parsed.messages[0].internalType).toBeUndefined()
    expect(parsed.messages[0].rawType).toBeUndefined()
    expect(parsed.messages[0].content[0].type).toBe('tool_result')
  })

  test('keeps mixed human text and tool result content as a user message', () => {
    const mixedMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu-1', content: 'tool output' },
          { type: 'text', text: 'human follow-up' },
        ],
      },
    }
    const parsed = JSON.parse(renderMessagesToJSON([mixedMessage]))
    expect(parsed.messages[0].type).toBe('user')
    expect(parsed.messages[0].role).toBe('user')
    expect(parsed.messages[0].internalType).toBeUndefined()
    expect(parsed.messages[0].content.map((block: { type: string }) => block.type)).toEqual([
      'tool_result',
      'text',
    ])
  })

  test('keeps mixed non-text content and tool result content as a user message', () => {
    const mixedMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu-1', content: 'tool output' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
        ],
      },
    }
    const parsed = JSON.parse(renderMessagesToJSON([mixedMessage]))
    expect(parsed.messages[0].type).toBe('user')
    expect(parsed.messages[0].role).toBe('user')
    expect(parsed.messages[0].content.map((block: { type: string }) => block.type)).toEqual([
      'tool_result',
      'image',
    ])
  })

  test('exports system-reminder siblings as semantic tool messages', () => {
    const runtimeToolResult = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu-1', content: 'tool output' },
          { type: 'text', text: '<system-reminder>note</system-reminder>' },
        ],
      },
    }
    const parsed = JSON.parse(renderMessagesToJSON([runtimeToolResult]))
    expect(parsed.messages[0].type).toBe('tool')
    expect(parsed.messages[0].role).toBe('tool')
    expect(parsed.messages[0].internalType).toBeUndefined()
    expect(parsed.messages[0].rawType).toBeUndefined()
    expect(parsed.messages[0].content).toHaveLength(1)
  })

  test('safely handles non-serializable content', () => {
    const cyclic: { a: number; self?: unknown } = { a: 1 }
    cyclic.self = cyclic
    const msg = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Cyclic', input: cyclic }],
      },
    }
    const parsed = JSON.parse(renderMessagesToJSON([msg]))
    expect(parsed.messages[0].content[0].input).toEqual({
      a: 1,
      self: '[Circular]',
    })
  })

  test('safely handles throwing getters in JSON content', () => {
    const hostile = {}
    Object.defineProperty(hostile, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter exploded')
      },
    })
    const msg = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Hostile', input: hostile }],
      },
    }
    const parsed = JSON.parse(renderMessagesToJSON([msg]))
    expect(parsed.messages[0].content[0].input).toEqual({
      boom: '[Unserializable]',
    })
  })

  test('exports unknown message types with stable public type and raw type', () => {
    const parsed = JSON.parse(renderMessagesToJSON([{ type: 'custom' }]))
    expect(parsed.messages[0].type).toBe('unknown')
    expect(parsed.messages[0].role).toBe('unknown')
    expect(parsed.messages[0].rawType).toBe('custom')
  })

  test('does not emit empty rawType for malformed messages without a type', () => {
    const parsed = JSON.parse(renderMessagesToJSON([{}]))
    expect(parsed.messages[0].type).toBe('unknown')
    expect(parsed.messages[0].role).toBe('unknown')
    expect(parsed.messages[0].rawType).toBeUndefined()
  })

  test('normalizes camelCase tool result ids', () => {
    const parsed = JSON.parse(renderMessagesToJSON([
      {
        type: 'tool',
        message: {
          role: 'tool',
          content: [{ type: 'tool_result', toolUseId: 'camel-id', content: 'ok', isError: false }],
        },
      },
    ]))
    expect(parsed.messages[0].content[0].toolUseId).toBe('camel-id')
    expect(parsed.messages[0].content[0].isError).toBe(false)
  })

  test('preserves timestamp when present', () => {
    const parsed = JSON.parse(renderMessagesToJSON([userMessage('hello')]))
    expect(parsed.messages[0].timestamp).toBe('2026-05-13T12:00:00Z')
  })

  test('uses 2-space indentation', () => {
    const json = renderMessagesToJSON([userMessage('hello')])
    expect(json).toContain('  "version"')
  })

  test('filters out progress messages', () => {
    const progressMsg = { type: 'progress', message: { role: 'user', content: [{ type: 'text', text: 'Loading...' }] } }
    const parsed = JSON.parse(renderMessagesToJSON([progressMsg, userMessage('hello')]))
    expect(parsed.messageCount).toBe(1)
    expect(parsed.messages[0].type).toBe('user')
  })

  test('filters out attachment messages', () => {
    const attMsg = { type: 'attachment', attachment: { type: 'file' } }
    const parsed = JSON.parse(renderMessagesToJSON([attMsg, userMessage('hello')]))
    expect(parsed.messageCount).toBe(1)
  })

  test('skips thinking content blocks', () => {
    const msg = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'inner thoughts' }],
      },
    }
    const parsed = JSON.parse(renderMessagesToJSON([msg]))
    expect(parsed.messageCount).toBe(0)
  })

  test('skips redacted_thinking content blocks', () => {
    const msg = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'redacted_thinking' }],
      },
    }
    const parsed = JSON.parse(renderMessagesToJSON([msg]))
    expect(parsed.messageCount).toBe(0)
  })

  test('preserves top-level system message content', () => {
    const parsed = JSON.parse(renderMessagesToJSON([
      {
        type: 'system',
        subtype: 'local_command',
        content: 'local command output',
        timestamp: '2026-05-13T12:00:04Z',
      },
    ]))
    expect(parsed.messageCount).toBe(1)
    expect(parsed.messages[0].type).toBe('system')
    expect(parsed.messages[0].subtype).toBe('local_command')
    expect(parsed.messages[0].content[0]).toEqual({
      type: 'text',
      text: 'local command output',
    })
  })

  test('exports local command output wrappers as semantic system messages', () => {
    const parsed = JSON.parse(renderMessagesToJSON([
      {
        type: 'user',
        message: {
          role: 'user',
          content: '<local-command-stderr>command failed</local-command-stderr>',
        },
      },
    ]))
    expect(parsed.messages[0].type).toBe('system')
    expect(parsed.messages[0].role).toBe('system')
    expect(parsed.messages[0].subtype).toBe('local_command')
    expect(parsed.messages[0].stream).toBe('stderr')
    expect(parsed.messages[0].content[0].text).toBe('command failed')
  })

  test('exports terminal output wrappers with attributes', () => {
    const parsed = JSON.parse(renderMessagesToJSON([
      {
        type: 'user',
        message: {
          role: 'user',
          content: '<bash-stdout format="persisted">persisted output</bash-stdout>',
        },
      },
    ]))
    expect(parsed.messages[0].type).toBe('system')
    expect(parsed.messages[0].subtype).toBe('bash_output')
    expect(parsed.messages[0].content[0].text).toBe('persisted output')
  })

  test('strips system reminders embedded in visible JSON text', () => {
    const parsed = JSON.parse(renderMessagesToJSON([
      userMessage('visible before <system-reminder>hidden</system-reminder> visible after'),
    ]))
    expect(parsed.messages[0].content[0].text).toBe('visible before  visible after')
  })

  test('strips system reminders nested inside tool result content', () => {
    const parsed = JSON.parse(renderMessagesToJSON([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-1',
              content: [
                { type: 'text', text: 'visible <system-reminder>hidden</system-reminder>' },
              ],
            },
          ],
        },
      },
    ]))
    expect(parsed.messages[0].content[0].content[0].text).toBe('visible')
    expect(JSON.stringify(parsed)).not.toContain('system-reminder')
    expect(JSON.stringify(parsed)).not.toContain('hidden')
  })

  test('exports combined terminal output wrappers as semantic system messages', () => {
    const parsed = JSON.parse(renderMessagesToJSON([
      {
        type: 'user',
        message: {
          role: 'user',
          content: '<bash-stdout>stdout text</bash-stdout><bash-stderr>stderr text</bash-stderr>',
        },
      },
    ]))
    expect(parsed.messages[0].type).toBe('system')
    expect(parsed.messages[0].role).toBe('system')
    expect(parsed.messages[0].subtype).toBe('bash_output')
    expect(parsed.messages[0].stream).toBe('mixed')
    expect(parsed.messages[0].content).toEqual([
      { type: 'text', text: 'stdout text', stream: 'stdout' },
      { type: 'text', text: 'stderr text', stream: 'stderr' },
    ])
  })

  test('exports bash input wrappers as semantic system messages', () => {
    const parsed = JSON.parse(renderMessagesToJSON([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '<bash-input>npm test</bash-input>' }],
        },
      },
    ]))
    expect(parsed.messages[0].type).toBe('system')
    expect(parsed.messages[0].role).toBe('system')
    expect(parsed.messages[0].subtype).toBe('bash_input')
    expect(parsed.messages[0].stream).toBe('stdin')
    expect(parsed.messages[0].content[0].text).toBe('npm test')
  })

  test('exports terminal wrappers with internal siblings as semantic system messages', () => {
    const parsed = JSON.parse(renderMessagesToJSON([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '<bash-stderr>stderr text</bash-stderr>' },
            { type: 'text', text: '<system-reminder>hidden metadata</system-reminder>' },
          ],
        },
      },
    ]))
    expect(parsed.messages[0].type).toBe('system')
    expect(parsed.messages[0].role).toBe('system')
    expect(parsed.messages[0].subtype).toBe('bash_output')
    expect(parsed.messages[0].stream).toBe('stderr')
    expect(parsed.messages[0].content).toEqual([{ type: 'text', text: 'stderr text' }])
  })

  test('preserves sourceIndex when internal messages are filtered', () => {
    const parsed = JSON.parse(renderMessagesToJSON([
      { type: 'progress', message: { role: 'user', content: [{ type: 'text', text: 'loading' }] } },
      userMessage('visible'),
    ]))
    expect(parsed.messages[0].index).toBe(0)
    expect(parsed.messages[0].sourceIndex).toBe(1)
  })

  test('skips synthetic missing tool-result placeholders', () => {
    const parsed = JSON.parse(renderMessagesToJSON([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'missing',
              content: '[Tool result missing due to internal error]',
              is_error: true,
            },
          ],
        },
      },
      userMessage('visible'),
    ]))
    expect(parsed.messageCount).toBe(1)
    expect(parsed.messages[0].content[0].text).toBe('visible')
  })

  test('skips synthetic missing tool-result placeholders with internal siblings', () => {
    const parsed = JSON.parse(renderMessagesToJSON([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'missing',
              content: '[Tool result missing due to internal error]',
              is_error: true,
            },
            { type: 'text', text: '<system-reminder>hidden metadata</system-reminder>' },
          ],
        },
      },
      userMessage('visible'),
    ]))
    expect(parsed.messageCount).toBe(1)
    expect(parsed.messages[0].content[0].text).toBe('visible')
  })

  test('preserves unknown content block type while sanitizing its value', () => {
    const parsed = JSON.parse(renderMessagesToJSON([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'server_tool_use', id: 'srv-1', name: 'web_search' }],
        },
      },
    ]))
    expect(parsed.messages[0].content[0].type).toBe('server_tool_use')
    expect(parsed.messages[0].content[0].value).toEqual({
      type: 'server_tool_use',
      id: 'srv-1',
      name: 'web_search',
    })
  })

  test('skips internal meta and command breadcrumb messages in JSON', () => {
    const parsed = JSON.parse(renderMessagesToJSON([
      {
        type: 'user',
        isMeta: true,
        message: { role: 'user', content: [{ type: 'text', text: 'internal caveat' }] },
      },
      {
        type: 'user',
        message: { role: 'user', content: '<command-name>/model</command-name>' },
      },
      {
        type: 'user',
        message: { role: 'user', content: '<system-reminder>hidden</system-reminder>' },
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>hidden array</system-reminder>' }] },
      },
      userMessage('visible user text'),
    ]))
    expect(parsed.messageCount).toBe(1)
    expect(parsed.messages[0].content[0].text).toBe('visible user text')
  })

  test('filters internal text blocks while preserving mixed real content in JSON', () => {
    const parsed = JSON.parse(renderMessagesToJSON([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '<command-name>/export</command-name>' },
            { type: 'text', text: 'real user content' },
          ],
        },
      },
    ]))
    expect(parsed.messageCount).toBe(1)
    expect(parsed.messages[0].content).toEqual([{ type: 'text', text: 'real user content' }])
  })

  test('does not drop visible JSON text that contains internal tag wrappers', () => {
    const parsed = JSON.parse(renderMessagesToJSON([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'visible before <command-name>/export</command-name> visible after' }],
        },
      },
    ]))
    expect(parsed.messageCount).toBe(1)
    expect(parsed.messages[0].type).toBe('user')
    expect(parsed.messages[0].content[0].text).toBe('visible before  visible after')
  })
})
