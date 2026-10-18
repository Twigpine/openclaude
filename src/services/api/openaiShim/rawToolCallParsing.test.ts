import { expect, test } from 'bun:test'
import {
  couldBeRawToolCallsRequestedPrefix,
  parseRawToolCallsRequestedText,
  parseTextToolCalls,
  repairPossiblyTruncatedObjectJson,
  stripRanges,
} from './rawToolCallParsing.js'

test('parses a Gemini raw tool call accumulated across stream chunks', () => {
  const accumulated = [
    'Tool calls',
    ' requested:\n- Write({"file_path":"style.css","content":"ul { padding: 0; }"}) [id: call79435b5a26564619b0151197]',
  ].join('')

  expect(couldBeRawToolCallsRequestedPrefix('Tool calls')).toBe(true)
  expect(couldBeRawToolCallsRequestedPrefix('ordinary prose')).toBe(false)
  expect(couldBeRawToolCallsRequestedPrefix('Tool cogs')).toBe(false)
  expect(parseRawToolCallsRequestedText(accumulated)).toEqual([{
    id: 'call79435b5a26564619b0151197',
    name: 'Write',
    argumentsJson: JSON.stringify({
      file_path: 'style.css',
      content: 'ul { padding: 0; }',
    }),
  }])
})

test('parses balanced JSON inside a fenced tool call', () => {
  const text = '```json\n{"name":"Bash","arguments":{"command":"echo {ok}"}}\n```'

  expect(parseTextToolCalls(text, () => 1)).toEqual({
    calls: [{
      id: 'ollama_tc_1',
      name: 'Bash',
      arguments: { command: 'echo {ok}' },
    }],
    toolCallRanges: [[0, text.length]],
  })
})

test('does not parse a fenced JSON example with trailing prose before its fence', () => {
  const text = '```json\n{"name":"Bash","arguments":{}}\nexample\n```'

  expect(parseTextToolCalls(text, () => 1)).toEqual({
    calls: [],
    toolCallRanges: [],
  })
})

test('parses stringified arguments in a bare-name tool call', () => {
  const text = '{"name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}'

  expect(parseTextToolCalls(text, () => 1).calls).toEqual([{
    id: 'ollama_tc_1',
    name: 'Bash',
    arguments: { command: 'ls' },
  }])
})

test('rejects non-object arguments in text tool calls', () => {
  for (const argumentsValue of [[], null, 'text']) {
    const text = JSON.stringify({ name: 'Bash', arguments: argumentsValue })

    expect(parseTextToolCalls(text, () => 1).calls).toEqual([{
      id: 'ollama_tc_1',
      name: 'Bash',
      arguments: {},
    }])
  }

  const stringifiedArray = JSON.stringify({ name: 'Bash', arguments: '[]' })
  expect(parseTextToolCalls(stringifiedArray, () => 1).calls[0]?.arguments).toEqual({})
})

test('strips tool-call ranges regardless of input order', () => {
  expect(stripRanges('a{one}b{two}c', [[7, 12], [1, 6]])).toBe('abc')
})

test('parses a complete Gemini raw tool-call response', () => {
  const parsed = parseRawToolCallsRequestedText(
    'Tool calls requested:\n- Agent({"description":"Verify the todo list application functionality.","prompt":"Check files.","subagent_type":"verification"}) [id: call9a8b7c6d5e4f3a2b1c0d9e8f]',
  )

  expect(parsed).toEqual([{
    id: 'call9a8b7c6d5e4f3a2b1c0d9e8f',
    name: 'Agent',
    argumentsJson: JSON.stringify({
      description: 'Verify the todo list application functionality.',
      prompt: 'Check files.',
      subagent_type: 'verification',
    }),
  }])
})

test('JSON fallback: recovers raw-text tool call into tool_use block', () => {
  expect(parseRawToolCallsRequestedText(
    'Tool calls requested:\n- Bash({"command":"ls"}) [id: call_raw_1]',
  )).toEqual([{
    id: 'call_raw_1',
    name: 'Bash',
    argumentsJson: '{"command":"ls"}',
  }])
})

test('rejects malformed raw tool-call request text atomically', () => {
  expect(parseRawToolCallsRequestedText('ordinary prose')).toBeNull()
  expect(parseRawToolCallsRequestedText('Tool calls requested:')).toBeNull()
  expect(parseRawToolCallsRequestedText(
    'Tool calls requested:\n- Bash({"command":"ls"}) [id: ok]\nmalformed',
  )).toBeNull()
})

test('repairs only JSON objects with bounded suffixes', () => {
  expect(repairPossiblyTruncatedObjectJson('{"command":"ls"')).toBe(
    '{"command":"ls"}',
  )
  expect(repairPossiblyTruncatedObjectJson('[]')).toBeNull()
  expect(repairPossiblyTruncatedObjectJson('false')).toBeNull()
  expect(repairPossiblyTruncatedObjectJson('{not json')).toBeNull()
})

test('repairs truncated structured Bash JSON in streaming responses', () => {
  expect(repairPossiblyTruncatedObjectJson('{"command":"pwd"')).toBe(
    '{"command":"pwd"}',
  )
})

test('repairs truncated JSON objects even without command field', () => {
  expect(repairPossiblyTruncatedObjectJson('{"cwd":"/tmp"')).toBe(
    '{"cwd":"/tmp"}',
  )
})
