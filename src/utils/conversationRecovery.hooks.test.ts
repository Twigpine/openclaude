/**
 * Hook-side-effect regression lives in a separate file with no static import of
 * conversationRecovery so Bun's mock.module can replace sessionStart before
 * that module is first loaded.
 */
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

const nonce = `${Date.now()}-${Math.random()}`
const realProviders = {
  ...await import(`./model/providers.js?real=${nonce}`),
}
const realSessionStart = {
  ...await import(`./sessionStart.js?real=${nonce}`),
}

afterAll(() => {
  mock.restore()
  mock.module('./model/providers.js', () => realProviders)
  mock.module('./sessionStart.js', () => realSessionStart)
})

const tempDirs: string[] = []
const originalEnv = { ...process.env }
const sessionId = '00000000-0000-4000-8000-000000001999'
const ts = '2026-04-02T00:00:00.000Z'
let providerForTest: ReturnType<typeof realProviders.getAPIProvider> = 'firstParty'

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

function user(uuid: string, content: string) {
  return {
    type: 'user',
    uuid,
    parentUuid: null,
    timestamp: ts,
    cwd: '/tmp',
    userType: 'external',
    sessionId,
    version: 'test',
    isSidechain: false,
    isMeta: false,
    message: {
      role: 'user',
      content,
    },
  }
}

async function writeJsonl(entry: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'openclaude-conversation-recovery-hooks-'))
  tempDirs.push(dir)
  const filePath = join(dir, 'resume.jsonl')
  await writeFile(filePath, `${JSON.stringify(entry)}\n`)
  return filePath
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/conversationRecovery.hooks.test.ts')
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_API_BASE
  delete process.env.OPENAI_MODEL
  providerForTest = 'firstParty'
  mock.module('./model/providers.js', () => ({
    ...realProviders,
    getAPIProvider: () => providerForTest,
  }))
})

afterEach(async () => {
  try {
    mock.restore()
    mock.module('./model/providers.js', () => realProviders)
    mock.module('./sessionStart.js', () => realSessionStart)
    providerForTest = 'firstParty'
    process.env = { ...originalEnv }
    await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  } finally {
    releaseSharedMutationLock()
  }
})

test('loadConversationForResume rejects oversized transcripts before resume hooks run', async () => {
  delete process.env.CLAUDE_CODE_SIMPLE
  const hugeContent = 'x'.repeat(8 * 1024 * 1024 + 32 * 1024)
  const path = await writeJsonl(user(id(3), hugeContent))
  const hookSpy = mock(() => Promise.resolve([{ type: 'hook' }]))

  mock.module('./sessionStart.js', () => ({
    ...realSessionStart,
    processSessionStartHooks: hookSpy,
  }))

  const { loadConversationForResume, ResumeTranscriptTooLargeError } = await import(
    './conversationRecovery.ts'
  )

  await expect(loadConversationForResume('fixture', path)).rejects.toBeInstanceOf(
    ResumeTranscriptTooLargeError,
  )
  expect(hookSpy).not.toHaveBeenCalled()
})

test('deserializeMessagesWithInterruptDetection strips thinking blocks only for OpenAI-compatible providers', async () => {
  const serializedMessages = [
    user(id(10), 'hello'),
    {
      type: 'assistant',
      uuid: id(11),
      parentUuid: id(10),
      timestamp: ts,
      cwd: '/tmp',
      sessionId,
      version: 'test',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'secret reasoning' },
          { type: 'text', text: 'visible reply' },
        ],
      },
    },
    {
      type: 'assistant',
      uuid: id(12),
      parentUuid: id(11),
      timestamp: ts,
      cwd: '/tmp',
      sessionId,
      version: 'test',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'only hidden reasoning' }],
      },
    },
    user(id(13), 'follow up'),
  ]

  providerForTest = 'openai'
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_MODEL = 'gpt-5-mini'

  const openaiModule = await import(`./conversationRecovery.ts?provider=openai-${Date.now()}`)
  const thirdParty = openaiModule.deserializeMessagesWithInterruptDetection(serializedMessages as never[])
  const thirdPartyAssistantMessages = thirdParty.messages.filter(
    message => message.type === 'assistant',
  )

  expect(thirdPartyAssistantMessages).toHaveLength(2)
  expect(thirdPartyAssistantMessages[0]?.message?.content).toEqual([
    { type: 'text', text: 'visible reply' },
  ])
  expect(
    JSON.stringify(thirdPartyAssistantMessages.map(message => message.message?.content)),
  ).not.toContain('secret reasoning')
  expect(
    JSON.stringify(thirdPartyAssistantMessages.map(message => message.message?.content)),
  ).not.toContain('only hidden reasoning')

  process.env.OPENAI_MODEL = 'mimo-v2.5-pro'

  const mimoModule = await import(`./conversationRecovery.ts?provider=mimo-${Date.now()}`)
  const mimo = mimoModule.deserializeMessagesWithInterruptDetection(serializedMessages as never[])
  const mimoAssistantMessages = mimo.messages.filter(
    message => message.type === 'assistant',
  )

  expect(mimoAssistantMessages).toHaveLength(2)
  expect(mimoAssistantMessages[0]?.message?.content).toEqual([
    { type: 'thinking', thinking: 'secret reasoning' },
    { type: 'text', text: 'visible reply' },
  ])
  expect(
    JSON.stringify(mimoAssistantMessages.map(message => message.message?.content)),
  ).toContain('secret reasoning')
  expect(
    JSON.stringify(mimoAssistantMessages.map(message => message.message?.content)),
  ).not.toContain('only hidden reasoning')
  delete process.env.OPENAI_MODEL

  providerForTest = 'bedrock'
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_MODEL

  const bedrockModule = await import(`./conversationRecovery.ts?provider=bedrock-${Date.now()}`)
  const anthropicCompatible = bedrockModule.deserializeMessagesWithInterruptDetection(serializedMessages as never[])
  const anthropicAssistantMessages = anthropicCompatible.messages.filter(
    message => message.type === 'assistant',
  )

  expect(anthropicAssistantMessages).toHaveLength(2)
  expect(anthropicAssistantMessages[0]?.message?.content).toEqual([
    { type: 'thinking', thinking: 'secret reasoning' },
    { type: 'text', text: 'visible reply' },
  ])
  expect(
    JSON.stringify(anthropicAssistantMessages.map(message => message.message?.content)),
  ).toContain('secret reasoning')
  expect(
    JSON.stringify(anthropicAssistantMessages.map(message => message.message?.content)),
  ).not.toContain('only hidden reasoning')
})
