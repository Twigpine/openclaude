import { describe, expect, test } from 'bun:test'
import { createAssistantMessage, createUserMessage } from '../utils/messages.js'
import {
  isNavigableMessage,
  MESSAGE_ACTIONS,
  messageExpandKey,
  primaryInputOf,
  type MessageActionsState,
  type NavigableMessage,
} from './messageActions.js'

function replUse(code: string): NavigableMessage {
  return createAssistantMessage({
    content: [{
      type: 'tool_use',
      id: 'repl-use-test',
      name: 'REPL',
      input: { code },
      caller: { type: 'direct' },
    }],
  }) as NavigableMessage
}

describe('messageActions Code Mode rows', () => {
  test('REPL tool uses are navigable and expose code as the primary input', () => {
    const code = 'const x = 1\nreturn x'
    const msg = replUse(code)
    expect(isNavigableMessage(msg)).toBe(true)
    expect(primaryInputOf(msg)).toBe(code)
  })

  test('expansion key pairs a REPL tool use with its result', () => {
    const use = replUse('return 1')
    const result = createUserMessage({
      content: [{
        type: 'tool_result',
        tool_use_id: 'repl-use-test',
        content: 'done',
        is_error: false,
      }],
    }) as NavigableMessage
    expect(messageExpandKey(result)).toBe(messageExpandKey(use))
  })

  test('enter expansion applies to REPL rows and labels exact line count', () => {
    const expand = MESSAGE_ACTIONS[0]
    const state: MessageActionsState = {
      uuid: 'uuid-test',
      msgType: 'assistant',
      expanded: false,
      expandKey: 'repl-use-test',
      toolName: 'REPL',
      primaryInputLineCount: 2,
    }
    expect(expand.applies?.(state)).toBe(true)
    expect(typeof expand.label === 'function' ? expand.label(state) : expand.label).toBe('to show 2 lines')
    expect(typeof expand.label === 'function' ? expand.label({ ...state, expanded: true }) : expand.label).toBe('to collapse')

    const bashState = { ...state, toolName: 'Bash' }
    expect(expand.applies?.(bashState)).toBe(false)
  })
})
