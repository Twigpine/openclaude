import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearInvokedSkills,
  getInvokedSkills,
} from '../bootstrap/state.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import * as realUdsClient from './udsClient.js'
import * as realProviders from './model/providers.js'
import type { NormalizedMessage } from '../types/message.js'

// Typed fixture for the thinking-strip gate tests. The full NormalizedMessage
// shape carries fields these tests don't exercise, so the cast is centralized
// here once rather than re-spelled as `as any` at each call site.
function assistantThinkingMessage(): NormalizedMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'answer' }],
    },
  } as unknown as NormalizedMessage
}

const tempDirs: string[] = []
const originalSimple = process.env.CLAUDE_CODE_SIMPLE
const providerEnvKeys = [
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_FOUNDRY',
  'OPENAI_MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'NVIDIA_NIM',
  'MINIMAX_API_KEY',
  'XAI_API_KEY',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED',
] as const
const originalProviderEnv = Object.fromEntries(
  providerEnvKeys.map(key => [key, process.env[key]]),
) as Record<(typeof providerEnvKeys)[number], string | undefined>
const sessionId = '00000000-0000-4000-8000-000000001999'
const ts = '2026-04-02T00:00:00.000Z'

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

function user(uuid: string, content: string, parentUuid: string | null = null) {
  return {
    type: 'user',
    uuid,
    parentUuid,
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

function assistant(
  uuid: string,
  content: string,
  parentUuid: string | null = null,
) {
  return {
    type: 'assistant',
    uuid,
    parentUuid,
    timestamp: ts,
    sessionId,
    version: 'test',
    isSidechain: false,
    isMeta: false,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: content }],
    },
  }
}

function attachment(
  uuid: string,
  value: unknown,
  parentUuid: string | null = null,
) {
  return {
    type: 'attachment',
    uuid,
    parentUuid,
    timestamp: ts,
    sessionId,
    attachment: value,
  }
}

function activeGoal(condition = 'resume goal') {
  return {
    id: id(900),
    condition,
    status: 'active',
    createdAt: ts,
    updatedAt: ts,
    startedAt: ts,
    turnCount: 1,
    maxTurns: 50,
    evaluatorFailures: 0,
  }
}

async function writeJsonl(entry: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'openclaude-conversation-recovery-'))
  tempDirs.push(dir)
  const filePath = join(dir, 'resume.jsonl')
  await writeFile(filePath, `${JSON.stringify(entry)}\n`)
  return filePath
}

async function writeJsonlEntries(entries: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'openclaude-conversation-recovery-'))
  tempDirs.push(dir)
  const filePath = join(dir, 'resume.jsonl')
  await writeFile(filePath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n')
  return filePath
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/conversationRecovery.test.ts')
})

afterEach(async () => {
  try {
    mock.restore()
    clearInvokedSkills()
    // Bun 1.3.13 can leave restored module instances visible to later test
    // files, so re-register full exports after using partial module mocks.
    mock.module('./udsClient.js', () => realUdsClient)
    mock.module('./model/providers.js', () => realProviders)
    if (originalSimple === undefined) {
      delete process.env.CLAUDE_CODE_SIMPLE
    } else {
      process.env.CLAUDE_CODE_SIMPLE = originalSimple
    }
    for (const key of providerEnvKeys) {
      const value = originalProviderEnv[key]
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    await Promise.all(
      tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
    )
  } finally {
    releaseSharedMutationLock()
  }
})

async function importFreshConversationRecovery() {
  mock.restore()
  mock.module('./model/providers.js', () => ({
    ...realProviders,
    getAPIProvider: () => {
      if (process.env.CLAUDE_CODE_USE_GITHUB) return 'github'
      if (process.env.CLAUDE_CODE_USE_OPENAI) return 'openai'
      if (process.env.CLAUDE_CODE_USE_BEDROCK) return 'bedrock'
      if (process.env.CLAUDE_CODE_USE_VERTEX) return 'vertex'
      if (process.env.CLAUDE_CODE_USE_FOUNDRY) return 'foundry'
      return 'firstParty'
    },
  }))
  const nonce = `${Date.now()}-${Math.random()}`
  return import(`./conversationRecovery.ts?conversationRecoveryTest=${nonce}`)
}

function clearProviderEnv(): void {
  for (const key of providerEnvKeys) {
    delete process.env[key]
  }
}

test('loadConversationForResume accepts a small transcript from jsonl path', async () => {
  process.env.CLAUDE_CODE_SIMPLE = '1'
  const path = await writeJsonl(user(id(1), 'hello'))
  const { loadConversationForResume } = await importFreshConversationRecovery()

  const result = await loadConversationForResume('fixture', path)
  expect(result).not.toBeNull()
  expect(result?.sessionId).toBe(sessionId)
  expect(result?.messages.length).toBeGreaterThan(0)
})

test('loadConversationForResume preserves goal metadata from a loaded log option', async () => {
  process.env.CLAUDE_CODE_SIMPLE = '1'
  const goal = activeGoal('keep going after resume')
  const { loadConversationForResume } = await importFreshConversationRecovery()

  const result = await loadConversationForResume(
    {
      date: ts,
      messages: [user(id(10), 'hello')],
      value: 0,
      created: new Date(ts),
      modified: new Date(ts),
      firstPrompt: 'hello',
      messageCount: 1,
      isSidechain: false,
      sessionId,
      goal,
    } as any,
    undefined,
  )

  expect(result?.goal).toEqual(goal)
})

test('loadConversationForResume preserves goal metadata from jsonl transcript path', async () => {
  process.env.CLAUDE_CODE_SIMPLE = '1'
  const goal = activeGoal('keep going after jsonl resume')
  const path = await writeJsonlEntries([
    {
      type: 'goal-state',
      sessionId,
      goal,
    },
    user(id(11), 'hello'),
  ])
  const { loadConversationForResume } = await importFreshConversationRecovery()

  const result = await loadConversationForResume('fixture', path)

  expect(result?.goal).toEqual(goal)
})

test('findResumeLogByPrSelector selects the first non-sidechain PR match', async () => {
  const { findResumeLogByPrSelector } = await importFreshConversationRecovery()
  const linked = {
    date: ts,
    messages: [user(id(12), 'linked')],
    value: 0,
    created: new Date(ts),
    modified: new Date(ts),
    firstPrompt: 'linked',
    messageCount: 1,
    isSidechain: false,
    sessionId: id(12),
    prNumber: 1642,
    prUrl: 'https://github.com/Twigpine/openclaude/pull/1642',
    prRepository: 'Twigpine/openclaude',
  } as any
  const sidechain = {
    ...linked,
    isSidechain: true,
    sessionId: id(13),
  } as any
  const unrelated = {
    ...linked,
    sessionId: id(14),
    prNumber: 17,
    prUrl: 'https://github.com/Twigpine/openclaude/pull/17',
  } as any

  expect(findResumeLogByPrSelector([sidechain, linked, unrelated], true)).toBe(
    linked,
  )
  expect(
    findResumeLogByPrSelector([sidechain, linked, unrelated], '1642'),
  ).toBe(linked)
  expect(
    findResumeLogByPrSelector(
      [sidechain, linked, unrelated],
      'https://github.com/Twigpine/openclaude/pull/1642',
    ),
  ).toBe(linked)
  expect(
    findResumeLogByPrSelector([sidechain, linked, unrelated], 'missing'),
  ).toBeNull()
})

test('loadConversationForResume rejects oversized reconstructed transcripts', async () => {
  process.env.CLAUDE_CODE_SIMPLE = '1'
  const hugeContent = 'x'.repeat(8 * 1024 * 1024 + 32 * 1024)
  const path = await writeJsonl(user(id(2), hugeContent))
  const {
    loadConversationForResume,
    ResumeTranscriptTooLargeError,
  } = await importFreshConversationRecovery()

  let caught: unknown
  try {
    await loadConversationForResume('fixture', path)
  } catch (error) {
    caught = error
  }

  expect(caught).toBeInstanceOf(ResumeTranscriptTooLargeError)
  expect((caught as Error).message).toContain(
    'Reconstructed transcript is too large to resume safely',
  )
})

test('collectLiveBackgroundSessionIds includes local registry sessions when UDS is empty', async () => {
  process.env.CLAUDE_CODE_SIMPLE = '1'
  const liveSessionId = '00000000-0000-4000-8000-000000000111'
  const staleSessionId = '00000000-0000-4000-8000-000000000222'
  const { collectLiveBackgroundSessionIds } =
    await importFreshConversationRecovery()

  expect(
    await collectLiveBackgroundSessionIds({
      listAllLiveSessions: async () => [],
      refreshBackgroundSessionStatuses: async () => [
        {
          sessionId: liveSessionId,
          status: 'running',
        },
        {
          sessionId: staleSessionId,
          status: 'stale',
        },
      ],
      isTerminalBackgroundSession: session => session.status !== 'running',
    }),
  ).toEqual(new Set([liveSessionId]))
})

test('collectLiveBackgroundSessionIds falls back to registry sessions when UDS fails', async () => {
  process.env.CLAUDE_CODE_SIMPLE = '1'
  const liveSessionId = '00000000-0000-4000-8000-000000000333'
  const { collectLiveBackgroundSessionIds } =
    await importFreshConversationRecovery()

  expect(
    await collectLiveBackgroundSessionIds({
      listAllLiveSessions: async () => {
        throw new Error('UDS unavailable')
      },
      refreshBackgroundSessionStatuses: async () => [
        {
          sessionId: liveSessionId,
          status: 'running',
        },
      ],
      isTerminalBackgroundSession: session => session.status !== 'running',
    }),
  ).toEqual(new Set([liveSessionId]))
})

test('collectLiveBackgroundSessionIds falls back to UDS sessions when registry refresh fails', async () => {
  process.env.CLAUDE_CODE_SIMPLE = '1'
  const liveSessionId = '00000000-0000-4000-8000-000000000444'
  const interactiveSessionId = '00000000-0000-4000-8000-000000000555'
  const { collectLiveBackgroundSessionIds } =
    await importFreshConversationRecovery()

  expect(
    await collectLiveBackgroundSessionIds({
      listAllLiveSessions: async () => [
        {
          kind: 'background',
          sessionId: liveSessionId,
        },
        {
          kind: 'interactive',
          sessionId: interactiveSessionId,
        },
      ],
      refreshBackgroundSessionStatuses: async () => {
        throw new Error('Registry unavailable')
      },
      isTerminalBackgroundSession: session => session.status !== 'running',
    }),
  ).toEqual(new Set([liveSessionId]))
})

test('deserializeMessages preserves thinking blocks for GitHub native Claude transport', async () => {
  clearProviderEnv()
  process.env.CLAUDE_CODE_USE_GITHUB = '1'
  process.env.OPENAI_MODEL = 'claude-sonnet-4-6'
  const { deserializeMessages } = await importFreshConversationRecovery()

  const deserialized = deserializeMessages([
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'need a plan' },
          { type: 'text', text: 'working on it' },
        ],
      },
    } as any,
  ])

  const content = (deserialized[0] as any)?.message?.content as Array<{
    type: string
  }>
  expect(content.some(block => block.type === 'thinking')).toBe(true)
})

test('deserializeMessages strips dangerous permission modes from rewindable user messages', async () => {
  clearProviderEnv()
  const { deserializeMessages } = await importFreshConversationRecovery()

  const deserialized = deserializeMessages([
    {
      ...user(id(3), 'run it'),
      permissionMode: 'fullAccess',
    } as any,
  ])

  expect((deserialized[0] as any)?.permissionMode).toBeUndefined()
})

test('deserializeMessages drops an attachment message with missing attachment payload', async () => {
  clearProviderEnv()
  const { deserializeMessages } = await importFreshConversationRecovery()

  const deserialized = deserializeMessages([
    user(id(20), 'before'),
    {
      type: 'attachment',
      uuid: id(21),
      parentUuid: id(20),
      timestamp: ts,
      sessionId,
    } as any,
    assistant(id(22), 'after') as any,
  ])

  expect(deserialized.map(message => message.type)).toEqual([
    'user',
    'assistant',
  ])
  expect((deserialized[1] as any).message.content[0].text).toBe('after')
})

test('deserializeMessages drops an attachment message with null attachment payload', async () => {
  clearProviderEnv()
  const { deserializeMessages } = await importFreshConversationRecovery()

  const deserialized = deserializeMessages([
    user(id(23), 'before'),
    attachment(id(24), null, id(23)) as any,
    assistant(id(25), 'after', id(24)) as any,
  ])

  expect(deserialized.map(message => message.type)).toEqual([
    'user',
    'assistant',
  ])
  expect((deserialized[1] as any).message.content[0].text).toBe('after')
})

const invalidLegacyPathValues: Array<[string, unknown]> = [
  ['missing', undefined],
  ['null', null],
  ['numeric', 42],
  ['object', { path: '/tmp/file.txt' }],
  ['empty', ''],
]

for (const [label, filename] of invalidLegacyPathValues) {
  test(`deserializeMessages drops legacy new_file attachment with ${label} filename`, async () => {
    clearProviderEnv()
    const { deserializeMessages } = await importFreshConversationRecovery()
    const legacyAttachment =
      filename === undefined
        ? { type: 'new_file', content: { type: 'text', text: 'legacy' } }
        : {
            type: 'new_file',
            filename,
            content: { type: 'text', text: 'legacy' },
          }

    const deserialized = deserializeMessages([
      user(id(30), 'before'),
      attachment(id(31), legacyAttachment, id(30)) as any,
      assistant(id(32), 'after', id(31)) as any,
    ])

    expect(deserialized.map(message => message.type)).toEqual([
      'user',
      'assistant',
    ])
  })
}

for (const [label, directoryPath] of invalidLegacyPathValues) {
  test(`deserializeMessages drops legacy new_directory attachment with ${label} path`, async () => {
    clearProviderEnv()
    const { deserializeMessages } = await importFreshConversationRecovery()
    const legacyAttachment =
      directoryPath === undefined
        ? { type: 'new_directory', content: 'legacy directory' }
        : {
            type: 'new_directory',
            path: directoryPath,
            content: 'legacy directory',
          }

    const deserialized = deserializeMessages([
      user(id(33), 'before'),
      attachment(id(34), legacyAttachment, id(33)) as any,
      assistant(id(35), 'after', id(34)) as any,
    ])

    expect(deserialized.map(message => message.type)).toEqual([
      'user',
      'assistant',
    ])
  })
}

test('deserializeMessages preserves valid legacy file and directory displayPath migration', async () => {
  clearProviderEnv()
  const { deserializeMessages } = await importFreshConversationRecovery()
  const legacyFilePath = join(process.cwd(), 'src', 'legacy-file.txt')
  const legacyDirectoryPath = join(process.cwd(), 'src', 'legacy-directory')

  const deserialized = deserializeMessages([
    user(id(40), 'before'),
    attachment(
      id(41),
      {
        type: 'new_file',
        filename: legacyFilePath,
        content: { type: 'text', text: 'legacy file' },
      },
      id(40),
    ) as any,
    attachment(
      id(42),
      {
        type: 'new_directory',
        path: legacyDirectoryPath,
        content: 'legacy directory',
      },
      id(41),
    ) as any,
    assistant(id(43), 'after', id(42)) as any,
  ])

  const attachments = deserialized.filter(
    message => message.type === 'attachment',
  ) as any[]

  expect(attachments).toHaveLength(2)
  expect(attachments[0].attachment).toMatchObject({
    type: 'file',
    filename: legacyFilePath,
    displayPath: join('src', 'legacy-file.txt'),
  })
  expect(attachments[1].attachment).toMatchObject({
    type: 'directory',
    path: legacyDirectoryPath,
    displayPath: join('src', 'legacy-directory'),
  })
})

test('restoreSkillStateFromMessages ignores invoked_skills attachments with missing or non-array skills', async () => {
  const { restoreSkillStateFromMessages } =
    await importFreshConversationRecovery()

  expect(() =>
    restoreSkillStateFromMessages([
      attachment(id(50), { type: 'invoked_skills' }) as any,
      attachment(id(51), {
        type: 'invoked_skills',
        skills: 'not an array',
      }) as any,
    ]),
  ).not.toThrow()
  expect(getInvokedSkills().size).toBe(0)
})

test('restoreSkillStateFromMessages restores only complete valid invoked skill records', async () => {
  const { restoreSkillStateFromMessages } =
    await importFreshConversationRecovery()

  restoreSkillStateFromMessages([
    attachment(id(52), {
      type: 'invoked_skills',
      skills: [
        { name: 'valid-skill', path: '/skills/valid', content: 'follow this' },
        null,
        { name: 123, path: '/skills/bad', content: 'bad name' },
        { name: 'missing-path', content: 'bad path' },
        { name: 'missing-content', path: '/skills/missing-content' },
        { name: '', path: '/skills/empty-name', content: 'empty name' },
      ],
    }) as any,
  ])

  expect([...getInvokedSkills().values()]).toMatchObject([
    {
      skillName: 'valid-skill',
      skillPath: '/skills/valid',
      content: 'follow this',
      agentId: null,
    },
  ])
})

test('loadConversationForResume keeps valid messages around a malformed attachment record', async () => {
  process.env.CLAUDE_CODE_SIMPLE = '1'
  const path = await writeJsonlEntries([
    user(id(60), 'before'),
    {
      type: 'attachment',
      uuid: id(61),
      parentUuid: id(60),
      timestamp: ts,
      sessionId,
    },
    assistant(id(62), 'after', id(61)),
  ])
  const { loadConversationForResume } = await importFreshConversationRecovery()

  const result = await loadConversationForResume('fixture', path)
  const messages = result?.messages ?? []
  const recoveredTranscriptMessages = messages.filter(
    message => message.uuid === id(60) || message.uuid === id(62),
  )

  expect(messages.some(message => message.uuid === id(61))).toBe(false)
  expect(recoveredTranscriptMessages.map(message => message.type)).toEqual([
    'user',
    'assistant',
  ])
  expect((recoveredTranscriptMessages[1] as any).message.content[0].text).toBe(
    'after',
  )
})

test('deserializeMessages drops malformed attachments before sentinel normalization', async () => {
  clearProviderEnv()
  const { deserializeMessages } = await importFreshConversationRecovery()

  const deserialized = deserializeMessages([
    user(id(63), 'before'),
    attachment(id(64), { type: 42 }, id(63)) as any,
  ])

  expect(deserialized.map(message => message.type)).toEqual([
    'user',
    'assistant',
  ])
  expect((deserialized[1] as any).message.content[0].text).toBe(
    'No response requested.',
  )
})

test('deserializeMessages preserves thinking blocks for DeepSeek 3P provider (#957)', async () => {
  // Regression: DeepSeek requires `reasoning_content` echoed back on assistant
  // messages in thinking mode. The shim reads the thinking block to populate
  // that field; stripping it on resume left the shim with no source and the
  // provider 400'd ("reasoning_content in the thinking mode must be passed
  // back"). preserveReasoningContent: true (from runtimeMetadata's DeepSeek
  // shim config inference) must opt the provider out of the 3P thinking strip.
  clearProviderEnv()
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.deepseek.com/v1'
  process.env.OPENAI_MODEL = 'deepseek-v4-flash'
  const { deserializeMessages } = await importFreshConversationRecovery()

  const deserialized = deserializeMessages([
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'chain of thought' },
          { type: 'text', text: 'answer' },
        ],
      },
    } as any,
  ])

  const content = (deserialized[0] as any)?.message?.content as Array<{
    type: string
  }>
  expect(content.some(block => block.type === 'thinking')).toBe(true)
})

test('stripThinkingBlocksIfProviderAllows preserves thinking for preserve-reasoning 3P (Z.AI GLM / DeepSeek)', async () => {
  // Smart routing reuses this gate on a per-turn model swap. A preserve-reasoning
  // provider 400s if the thinking block is stripped, so the gate must leave it.
  clearProviderEnv()
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.deepseek.com/v1'
  process.env.OPENAI_MODEL = 'deepseek-v4-flash'
  const { stripThinkingBlocksIfProviderAllows } = await importFreshConversationRecovery()

  const result = stripThinkingBlocksIfProviderAllows([assistantThinkingMessage()])
  const content = (result[0] as any)?.message?.content as Array<{ type: string }>
  expect(content.some(block => block.type === 'thinking')).toBe(true)
})

test('stripThinkingBlocksIfProviderAllows strips thinking for generic OpenAI 3P', async () => {
  clearProviderEnv()
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_MODEL = 'gpt-5-mini'
  const { stripThinkingBlocksIfProviderAllows } = await importFreshConversationRecovery()

  const result = stripThinkingBlocksIfProviderAllows([assistantThinkingMessage()])
  const content = (result[0] as any)?.message?.content as Array<{ type: string }>
  expect(content.some(block => block.type === 'thinking')).toBe(false)
})

test('deserializeMessages still strips thinking blocks for generic OpenAI 3P (no preserveReasoningContent)', async () => {
  // Counter-test: providers that don't set preserveReasoningContent keep the
  // original strip behaviour from #248; thinking blocks were causing 400s
  // there, and the fix for #957 must not regress that path.
  clearProviderEnv()
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_MODEL = 'gpt-5-mini'
  const { deserializeMessages } = await importFreshConversationRecovery()

  const deserialized = deserializeMessages([
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'noise' },
          { type: 'text', text: 'answer' },
        ],
      },
    } as any,
  ])

  const content = (deserialized[0] as any)?.message?.content as Array<{
    type: string
  }>
  expect(content.some(block => block.type === 'thinking')).toBe(false)
})
