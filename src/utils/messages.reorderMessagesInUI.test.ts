import { describe, expect, test } from 'bun:test'

import type { Message } from '../types/message.js'
import { createAttachmentMessage } from './attachments.js'
import {
  createAssistantMessage,
  createUserMessage,
  reorderMessagesInUI,
} from './messages.js'

function toolUse(id: string, name: string): Message {
  return createAssistantMessage({
    content: [
      {
        type: 'tool_use',
        id,
        name,
        input: {},
      } as never,
    ],
  })
}

function toolResult(id: string): Message {
  return createUserMessage({
    content: [
      {
        type: 'tool_result',
        tool_use_id: id,
        content: 'done',
      } as never,
    ],
  })
}

function hookAttachment(
  toolUseID: string,
  hookEvent: 'PreToolUse' | 'PostToolUse',
  content: string,
): Message {
  return createAttachmentMessage({
    type: 'hook_system_message',
    content,
    hookName: `${hookEvent}:test`,
    toolUseID,
    hookEvent,
  })
}

function messageOrder(messages: Message[]): string[] {
  return reorderMessagesInUI(messages, []).map(message => {
    if (message.type === 'assistant') {
      return `tool:${message.message.content[0].id}`
    }
    if (message.type === 'user') {
      return `result:${message.message.content[0].tool_use_id}`
    }
    if (message.type === 'attachment') {
      return `${message.attachment.hookEvent}:${message.attachment.content}`
    }
    return message.type
  })
}

describe('reorderMessagesInUI REPL hook attachments', () => {
  test('keeps outer REPL PreToolUse and PostToolUse attachments at their original positions', () => {
    const messages = [
      toolUse('repl-tool-use', 'REPL'),
      hookAttachment('repl-tool-use', 'PreToolUse', 'outer pre'),
      toolResult('repl-tool-use'),
      hookAttachment('repl-tool-use', 'PostToolUse', 'outer post'),
    ]

    expect(messageOrder(messages)).toEqual([
      'tool:repl-tool-use',
      'PreToolUse:outer pre',
      'result:repl-tool-use',
      'PostToolUse:outer post',
    ])
  })

  test('preserves grouped hook emission for non-REPL tools', () => {
    const messages = [
      hookAttachment('read-tool-use', 'PreToolUse', 'read pre'),
      toolUse('read-tool-use', 'Read'),
      hookAttachment('read-tool-use', 'PostToolUse', 'read post'),
      toolResult('read-tool-use'),
    ]

    expect(messageOrder(messages)).toEqual([
      'tool:read-tool-use',
      'PreToolUse:read pre',
      'result:read-tool-use',
      'PostToolUse:read post',
    ])
  })
})
