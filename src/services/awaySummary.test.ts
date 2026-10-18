import { afterAll, beforeAll, beforeEach, expect, mock, test } from 'bun:test'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../test/sharedMutationLock.js'
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from '../types/message.js'
import {
  createAssistantMessage,
  createUserMessage,
  validateToolResultPairing,
} from '../utils/messages.js'

let capturedMessages: Message[] | null = null

const queryModelWithoutStreamingMock = mock(
  async (params: { messages: Message[] }) => {
    capturedMessages = params.messages
    return createAssistantMessage({
      content: [
        {
          type: 'text',
          text: 'Back to the implementation.',
          citations: [],
        },
      ],
    })
  },
)

const realClaudeModule = await import(
  `./api/claude.js?real=${Date.now()}-${Math.random()}`
)
const realSessionMemoryUtilsModule = await import(
  `./SessionMemory/sessionMemoryUtils.js?real=${Date.now()}-${Math.random()}`
)

// These stubs are registered in beforeAll (NOT at module load) and torn down in
// afterAll so the shared bun:test process loads the REAL ./api/claude.js and
// ./SessionMemory/sessionMemoryUtils.js for every other test file at startup.
//
// bun evaluates all test files' module-level imports up front and caches the
// resolved modules. A module-level mock.module() here would therefore leak the
// incomplete stubs into every downstream importer of these modules (claude.js
// alone has ~22 importers) and break unrelated files in the smoke suite
// depending on run order — the classic flaky "smoke" defect. Registering the
// stub only for the lifetime of this suite (beforeAll → afterAll) keeps the
// subject's import of the stubbed module isolated to this file.
let generateAwaySummary: Awaited<
  typeof import('./awaySummary.js')
>['generateAwaySummary']
let hasSharedMutationLock = false

beforeAll(async () => {
  await acquireSharedMutationLock('services/awaySummary.test.ts')
  hasSharedMutationLock = true
  try {
    mock.module('./api/claude.js', () => ({
      queryModelWithoutStreaming: queryModelWithoutStreamingMock,
    }))
    mock.module('./SessionMemory/sessionMemoryUtils.js', () => ({
      getSessionMemoryContent: mock(async () => null),
    }))
    ;({ generateAwaySummary } = await import('./awaySummary.js'))
  } catch (error) {
    mock.module('./api/claude.js', () => ({ ...realClaudeModule }))
    mock.module('./SessionMemory/sessionMemoryUtils.js', () => ({
      ...realSessionMemoryUtilsModule,
    }))
    releaseSharedMutationLock()
    hasSharedMutationLock = false
    throw error
  }
})

const RECENT_WINDOW_FOR_TEST = 30

function assistantWithToolUse(id: string): Message {
  return createAssistantMessage({
    content: [
      {
        type: 'tool_use',
        id,
        name: 'Read',
        input: { file_path: '/tmp/example.txt' },
      },
    ],
  })
}

function userWithToolResult(id: string): Message {
  return createUserMessage({
    content: [
      {
        type: 'tool_result',
        tool_use_id: id,
        content: 'file contents',
      },
    ],
  })
}

function isPairableMessage(
  message: Message,
): message is UserMessage | AssistantMessage {
  return message.type === 'user' || message.type === 'assistant'
}

function capturedConversationBeforeRecapPrompt(): (UserMessage | AssistantMessage)[] {
  // The last captured message is the recap prompt added by generateAwaySummary.
  return capturedMessages!.slice(0, -1).filter(isPairableMessage)
}

beforeEach(() => {
  capturedMessages = null
  queryModelWithoutStreamingMock.mockClear()
})

afterAll(() => {
  if (!hasSharedMutationLock) {
    return
  }
  try {
    mock.module('./api/claude.js', () => ({ ...realClaudeModule }))
    mock.module('./SessionMemory/sessionMemoryUtils.js', () => ({
      ...realSessionMemoryUtilsModule,
    }))
  } finally {
    releaseSharedMutationLock()
    hasSharedMutationLock = false
  }
})

test('generateAwaySummary does not start its recent projection with an orphan tool_result', async () => {
  const toolUseId = 'toolu_away_summary'
  const messages: Message[] = [
    assistantWithToolUse(toolUseId),
    userWithToolResult(toolUseId),
  ]

  for (let i = 0; i < RECENT_WINDOW_FOR_TEST - 1; i++) {
    messages.push(createUserMessage({ content: `recent turn ${i}` }))
  }

  const summary = await generateAwaySummary(
    messages,
    new AbortController().signal,
  )

  expect(summary).toBe('Back to the implementation.')
  expect(capturedMessages).not.toBeNull()
  expect(capturedMessages?.[0]?.type).toBe('assistant')
  expect(capturedMessages?.[1]?.type).toBe('user')

  expect(
    validateToolResultPairing(capturedConversationBeforeRecapPrompt()).valid,
  ).toBe(true)
})

test('generateAwaySummary drops an orphaned tool_result instead of expanding beyond the recent window', async () => {
  const toolUseId = 'toolu_away_summary_old'
  const messages: Message[] = [assistantWithToolUse(toolUseId)]

  // Push the matching tool_use beyond the allowed expansion budget.
  for (let i = 0; i < RECENT_WINDOW_FOR_TEST + 5; i++) {
    messages.push(createUserMessage({ content: `older filler ${i}` }))
  }
  messages.push(userWithToolResult(toolUseId))
  for (let i = 0; i < RECENT_WINDOW_FOR_TEST - 1; i++) {
    messages.push(createUserMessage({ content: `recent turn ${i}` }))
  }

  await generateAwaySummary(messages, new AbortController().signal)

  expect(capturedMessages).not.toBeNull()
  expect(capturedMessages?.[0]?.type).toBe('user')
  expect(capturedMessages?.[0]?.message.content).toBe('recent turn 0')

  expect(
    validateToolResultPairing(capturedConversationBeforeRecapPrompt()).valid,
  ).toBe(true)
})
