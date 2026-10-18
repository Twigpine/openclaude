import { expect, test } from 'bun:test'
import { buildAnthropicUsageFromRawUsage } from '../cacheMetrics.js'
import { normalizeToolArguments } from '../toolArgumentNormalization.js'
import { stripThinkTags } from '../thinkTagSanitizer.js'
import {
  geminiThoughtSignatureFromExtraContent,
  mergeGeminiThoughtSignature,
} from './providerCompatibility.js'
import {
  parseRawToolCallsRequestedText,
  stripRanges,
} from './rawToolCallParsing.js'
import {
  isHy3Model,
  parseXmlToolCalls as parseXmlToolCallsModule,
} from './xmlToolCallParsing.js'
import {
  convertNonStreamingResponseToAnthropicMessage,
  type NonStreamingOpenAIResponse,
} from './responseConversion.js'

const parseXmlToolCalls = (text: string, allowHy3: boolean) => {
  let sequence = 0
  return parseXmlToolCallsModule(text, allowHy3, () => ++sequence)
}

const dependencies = {
  makeMessageId: () => 'msg-test',
  buildUsage: (usage: Record<string, unknown> | undefined) =>
    buildAnthropicUsageFromRawUsage(usage),
  stripThinkTags,
  parseXmlToolCalls,
  isHy3Model,
  stripRanges,
  parseRawToolCalls: parseRawToolCallsRequestedText,
  normalizeToolArguments,
  getGeminiThoughtSignature: geminiThoughtSignatureFromExtraContent,
  mergeGeminiThoughtSignature,
}

function convert(data: NonStreamingOpenAIResponse, model = 'fallback-model') {
  return convertNonStreamingResponseToAnthropicMessage(data, model, dependencies)
}

test('recovers a non-streaming Gemini raw tool call without exposing provider text', () => {
  const message = convert({
    id: 'chatcmpl-raw-tool',
    model: 'google/gemini-3.1-flash-lite',
    choices: [{
      message: {
        role: 'assistant',
        content:
          'Tool calls requested:\n- Agent({"description":"Verify the todo list application functionality.","prompt":"Check files.","subagent_type":"verification"}) [id: call9a8b7c6d5e4f3a2b1c0d9e8f]',
      },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
  })

  expect(message.content).toEqual([{
    type: 'tool_use',
    id: 'call9a8b7c6d5e4f3a2b1c0d9e8f',
    name: 'Agent',
    input: {
      description: 'Verify the todo list application functionality.',
      prompt: 'Check files.',
      subagent_type: 'verification',
    },
  }])
  expect(message.stop_reason).toBe('tool_use')
  expect(message.usage).toEqual({
    input_tokens: 12,
    output_tokens: 4,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  })
})

test('emits reasoning_content as thinking when content is null', () => {
  const message = convert({
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        reasoning_content: 'Let me think about this step by step.',
      },
      finish_reason: 'stop',
    }],
  }, 'glm-5')

  expect(message.content).toEqual([{
    type: 'thinking',
    thinking: 'Let me think about this step by step.',
  }])
})

test('does not convert empty content into visible reasoning text', () => {
  const message = convert({
    choices: [{
      message: {
        role: 'assistant',
        content: '',
        reasoning_content: 'Chain of thought here.',
      },
      finish_reason: 'stop',
    }],
  }, 'glm-5')

  expect(message.content).toEqual([{
    type: 'thinking',
    thinking: 'Chain of thought here.',
  }])
})

test('preserves real content alongside reasoning_content', () => {
  const message = convert({
    choices: [{
      message: {
        role: 'assistant',
        content: 'The answer is 42.',
        reasoning_content: 'I need to calculate this.',
      },
      finish_reason: 'stop',
    }],
  }, 'glm-5')

  expect(message.content).toEqual([
    { type: 'thinking', thinking: 'I need to calculate this.' },
    { type: 'text', text: 'The answer is 42.' },
  ])
})

test('strips think tags from non-streaming assistant content', () => {
  const message = convert({
    choices: [{
      message: {
        role: 'assistant',
        content: '<think>respond briefly</think>Hey! How can I help you today?',
      },
      finish_reason: 'stop',
    }],
  }, 'gpt-5-mini')

  expect(message.content).toEqual([{
    type: 'text',
    text: 'Hey! How can I help you today?',
  }])
})

test('recovers Tencent HY3 XML calls in the JSON fallback conversion', () => {
  const message = convert({
    id: 'chatcmpl-json-hy3',
    model: 'tencent/hy3',
    choices: [{
      message: {
        role: 'assistant',
        content:
          '<tool_call:call_hy3>TaskCreate\n subject: Verify HY3\n description: Run the live test\n</tool_call:call_hy3>',
      },
      finish_reason: 'stop',
    }],
  }, 'tencent/hy3')

  expect(message.content).toEqual([{
    type: 'tool_use',
    id: expect.stringMatching(/^xml_tc_\d+$/),
    name: 'TaskCreate',
    input: {
      subject: 'Verify HY3',
      description: 'Run the live test',
    },
  }])
  expect(message.stop_reason).toBe('tool_use')
})

test('preserves structured Gemini signatures and safety terminal responses', () => {
  const message = convert({
    model: 'gemini',
    choices: [{
      finish_reason: 'safety',
      message: {
        tool_calls: [{
          id: 'call-2',
          function: { name: 'Write', arguments: '{"path":"a.ts"}' },
          extra_content: { google: { thought_signature: 'sig-2' } },
        }],
      },
    }],
  })

  expect(message.content).toEqual([
    {
      type: 'tool_use',
      id: 'call-2',
      name: 'Write',
      input: { path: 'a.ts' },
      extra_content: { google: { thought_signature: 'sig-2' } },
      signature: 'sig-2',
    },
    { type: 'text', text: '\n\n[Content blocked by provider safety filter]' },
  ])
  expect(message.model).toBe('gemini')
  expect(message.stop_reason).toBe('tool_use')
})

test('normalizes array content and length stop reasons', () => {
  const functionPart = Object.assign(() => {}, {
    type: 'text' as const,
    text: 'ignored-fn',
  })
  const message = convert({
    choices: [{
      message: {
        content: [
          { type: 'text', text: 'first' },
          { type: 'image' },
          functionPart,
          { type: 'text', text: 'second' },
        ],
      },
      finish_reason: 'length',
    }],
  })

  expect(message.content).toEqual([{ type: 'text', text: 'first\nsecond' }])
  expect(message.stop_reason).toBe('max_tokens')
  expect(message.id).toBe('msg-test')
})
