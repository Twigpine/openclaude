import { expect, test } from 'bun:test'
import { Children, isValidElement, type ReactNode } from 'react'
import { Message } from '../../components/Message.js'
import { EMPTY_USAGE } from '../../services/api/emptyUsage.js'
import type { AssistantMessage } from '../../types/message.js'
import { renderToolResultMessage } from './UI.js'

function findAssistantMessage(node: ReactNode): AssistantMessage | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode; message?: AssistantMessage }>(child)) continue
    if (child.type === Message) return child.props.message
    const message = findAssistantMessage(child.props.children)
    if (message) return message
  }
}

test('completed agent summaries supply null details when tool-result usage omits them', () => {
  const { output_tokens_details: _details, ...usage } = EMPTY_USAGE
  const tree = renderToolResultMessage({
    status: 'completed',
    agentId: 'test-agent',
    content: [],
    prompt: '',
    totalToolUseCount: 1,
    totalDurationMs: 100,
    totalTokens: 7,
    usage: { ...usage, input_tokens: 3, output_tokens: 4 },
  }, [], { tools: [], verbose: false, theme: 'dark' })
  const message = findAssistantMessage(tree)
  expect(message).toBeDefined()
  expect(message?.message.usage.output_tokens_details).toBeNull()
  expect(message?.message.usage.output_tokens).toBe(4)
})
