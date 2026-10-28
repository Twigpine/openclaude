import { expect, test } from 'bun:test'
import type { Message } from '../../types/message.js'

const factories = (await import(
  `./factories.js?factory-test=${Date.now()}-${Math.random()}`
)) as typeof import('./factories.js')

const {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createModelSwitchBreadcrumbs,
  createProgressMessage,
  createSyntheticUserCaveatMessage,
  createToolResultStopMessage,
  createUserInterruptionMessage,
  createUserMessage,
  formatCommandInputTags,
  getLastAssistantMessage,
  hasToolCallsInLastAssistantTurn,
  isSyntheticApiErrorMessage,
  isSyntheticMessage,
  prepareUserContent,
} = factories

test('createAssistantMessage builds a synthetic assistant message', () => {
  const message = createAssistantMessage({ content: 'hello' })

  expect(message.type).toBe('assistant')
  expect(message.message.usage.output_tokens_details).toBeNull()
  expect(message.message.usage.fallback_credit).toBeNull()
  expect(message.message.content[0]).toMatchObject({
    type: 'text',
    text: 'hello',
  })
})

test('createAssistantMessage preserves supplied output token details', () => {
  const usage = {
    ...createAssistantMessage({ content: 'default' }).message.usage,
    output_tokens: 7,
    output_tokens_details: { thinking_tokens: 4 },
  }
  const message = createAssistantMessage({ content: 'hello', usage })
  expect(message.message.usage.output_tokens_details).toEqual({ thinking_tokens: 4 })
  expect(message.message.usage.output_tokens).toBe(7)
})

test('createAssistantMessage preserves supplied fallback-credit outcomes', () => {
  const usage = {
    ...createAssistantMessage({ content: 'default' }).message.usage,
    fallback_credit: { status: { type: 'redeemed' as const } },
  }
  const message = createAssistantMessage({ content: 'hello', usage })
  expect(message.message.usage.fallback_credit).toEqual(usage.fallback_credit)
})

test('createAssistantAPIErrorMessage builds a synthetic API error message', () => {
  const message = createAssistantAPIErrorMessage({
    content: '',
    errorDetails: 'rate limited',
  })

  expect(message.isApiErrorMessage).toBe(true)
  expect(message.errorDetails).toBe('rate limited')
  expect(message.message.content[0]).toMatchObject({
    type: 'text',
    text: '(no content)',
  })
  expect(isSyntheticApiErrorMessage(message)).toBe(true)
})

test('createUserMessage preserves metadata and normalizes permission mode', () => {
  const message = createUserMessage({
    content: '',
    isMeta: true,
    permissionMode: 'default',
  })
  const dangerousMessage = createUserMessage({
    content: 'dangerous',
    permissionMode: 'fullAccess',
  })

  expect(message.type).toBe('user')
  expect(message.isMeta).toBe(true)
  expect(message.message.content).toBe('(no content)')
  expect(message.permissionMode).toBe('default')
  expect(dangerousMessage.permissionMode).toBeUndefined()
})

test('synthetic helpers identify interruption messages and ignore normal messages', () => {
  const interruption = createUserInterruptionMessage({})
  const toolInterruption = createUserInterruptionMessage({ toolUse: true })
  const normalMessage = createUserMessage({ content: 'hello' })

  expect(isSyntheticMessage(interruption)).toBe(true)
  expect(isSyntheticMessage(toolInterruption)).toBe(true)
  expect(isSyntheticMessage(normalMessage)).toBe(false)
})

test('getLastAssistantMessage returns the nearest assistant from the tail', () => {
  const first = createAssistantMessage({ content: 'first' })
  const second = createAssistantMessage({ content: 'second' })
  const messages: Message[] = [
    createUserMessage({ content: 'start' }),
    first,
    createUserMessage({ content: 'middle' }),
    second,
    createUserMessage({ content: 'tail' }),
  ]

  expect(getLastAssistantMessage(messages)).toBe(second)
})

test('hasToolCallsInLastAssistantTurn inspects only the last assistant', () => {
  const toolAssistant = createAssistantMessage({
    content: [
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Read',
        input: {},
      } as never,
    ],
  })
  const textAssistant = createAssistantMessage({ content: 'done' })

  expect(
    hasToolCallsInLastAssistantTurn([
      createUserMessage({ content: 'run tool' }),
      toolAssistant,
      createUserMessage({ content: 'next' }),
    ]),
  ).toBe(true)
  expect(hasToolCallsInLastAssistantTurn([toolAssistant, textAssistant])).toBe(
    false,
  )
})

test('hasToolCallsInLastAssistantTurn preserves non-array assistant content behavior', () => {
  const toolAssistant = createAssistantMessage({
    content: [
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Read',
        input: {},
      } as never,
    ],
  })
  const baseAssistant = createAssistantMessage({ content: 'legacy text content' })
  const nonArrayAssistant = {
    ...baseAssistant,
    message: {
      ...baseAssistant.message,
      content: 'legacy text content',
    },
  } as unknown as Message

  expect(
    hasToolCallsInLastAssistantTurn([toolAssistant, nonArrayAssistant]),
  ).toBe(true)
})

test('prepareUserContent keeps plain input unless preceding blocks exist', () => {
  expect(
    prepareUserContent({ inputString: 'hello', precedingInputBlocks: [] }),
  ).toBe('hello')

  expect(
    prepareUserContent({
      inputString: 'tail',
      precedingInputBlocks: [{ type: 'text', text: 'head' }],
    }),
  ).toEqual([
    { type: 'text', text: 'head' },
    { type: 'text', text: 'tail' },
  ])
})

test('createSyntheticUserCaveatMessage marks local command caveats as meta', () => {
  const message = createSyntheticUserCaveatMessage()

  expect(message.isMeta).toBe(true)
  expect(message.message.content).toContain('<local-command-caveat>')
})

test('formatCommandInputTags and createToolResultStopMessage retain public shape', () => {
  expect(formatCommandInputTags('model', 'sonnet')).toContain('<command-name>')
  expect(createToolResultStopMessage('toolu_1')).toMatchObject({
    type: 'tool_result',
    tool_use_id: 'toolu_1',
    is_error: true,
  })
})

test('createModelSwitchBreadcrumbs builds the command breadcrumb sequence', () => {
  const breadcrumbs = createModelSwitchBreadcrumbs('sonnet', 'Claude Sonnet')

  expect(breadcrumbs).toHaveLength(3)
  expect(breadcrumbs[0]?.isMeta).toBe(true)
  expect(breadcrumbs[1]?.message.content).toContain('<command-name>/model')
  expect(breadcrumbs[2]?.message.content).toContain(
    '<local-command-stdout>Set model to Claude Sonnet</local-command-stdout>',
  )
})

test('createProgressMessage preserves tool IDs and payload', () => {
  const message = createProgressMessage({
    toolUseID: 'toolu_child',
    parentToolUseID: 'toolu_parent',
    data: { message: 'working' },
  })

  expect(message).toMatchObject({
    type: 'progress',
    toolUseID: 'toolu_child',
    parentToolUseID: 'toolu_parent',
    data: { message: 'working' },
  })
})
