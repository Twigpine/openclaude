import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { UUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  getSessionId,
  getSessionProjectDir,
  isSessionPersistenceDisabled,
  setSessionPersistenceDisabled,
  switchSession,
} from '../bootstrap/state.js'
import type { AppState } from '../state/AppStateStore.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import type { PersistedWorktreeSession } from '../types/logs.js'
import type { Message } from '../types/message.js'
import {
  flushSessionStorage,
  getTranscriptPath,
  loadTranscriptFile,
  recordTranscript,
  resetProjectForTesting,
  resetSessionFilePointer,
} from './sessionStorage.ts'
import {
  enforceCodeModeResumeCompatibility,
  processResumedConversation,
  withCodeModeResumeActivation,
  type ProcessedResume,
} from './sessionRestore.js'
import type { ContentReplacementRecord } from './toolResultStorage.js'
import { loadConversationForResume } from './conversationRecovery.js'
import {
  getReplModeConversationOverride,
  isReplModeEnabled,
  resetReplModeToSessionEligibility,
  setReplModeEnabledForSession,
  setReplModeForConversation,
} from '../tools/REPLTool/constants.js'

const tempDirs: string[] = []
const ts = '2026-04-02T00:00:00.000Z'
const sourceSessionId = '00000000-0000-4000-8000-000000000111'
const forkSessionId = '00000000-0000-4000-8000-000000000222'

let originalNodeEnv: string | undefined
let originalTestPersistence: string | undefined
let originalPersistence: string | undefined
let originalSkipPromptHistory: string | undefined
let originalSessionId: string
let originalSessionProjectDir: string | null
let originalPersistenceDisabled: boolean

function id(n: number): UUID {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as UUID
}

function userMessage(uuid: UUID, parentUuid: UUID | null, content: string) {
  return {
    uuid,
    parentUuid,
    timestamp: ts,
    type: 'user',
    isMeta: false,
    message: {
      role: 'user',
      content,
    },
  } as unknown as Message
}

function assistantMessage(
  uuid: UUID,
  parentUuid: UUID | null,
  content: string,
) {
  return {
    uuid,
    parentUuid,
    timestamp: ts,
    type: 'assistant',
    message: {
      id: uuid,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: content }],
      model: 'test-model',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  } as unknown as Message
}

function assistantToolUseMessage(
  uuid: UUID,
  parentUuid: UUID | null,
  toolUseId: string,
) {
  return {
    uuid,
    parentUuid,
    timestamp: ts,
    type: 'assistant',
    message: {
      id: uuid,
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Read',
          input: { file_path: 'file.txt' },
        },
      ],
      model: 'test-model',
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  } as unknown as Message
}

function toolResultUserMessage(
  uuid: UUID,
  parentUuid: UUID | null,
  toolUseId: string,
) {
  return {
    uuid,
    parentUuid,
    timestamp: ts,
    type: 'user',
    isMeta: false,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: 'full tool output',
          is_error: false,
        },
      ],
    },
    toolUseResult: {
      stdout: 'full tool output',
      stderr: '',
    },
  } as unknown as Message
}

function sourceMessages(): Message[] {
  return [
    userMessage(id(1), null, 'source prompt'),
    assistantMessage(id(2), id(1), 'source response'),
  ]
}

function sourceMessagesWithToolResult(): Message[] {
  return [
    userMessage(id(1), null, 'source prompt'),
    assistantToolUseMessage(id(2), id(1), 'tool-use-1'),
    toolResultUserMessage(id(3), id(2), 'tool-use-1'),
    assistantMessage(id(4), id(3), 'source response'),
  ]
}

function testContext(initialState: AppState = getDefaultAppState()) {
  return {
    modeApi: null,
    mainThreadAgentDefinition: undefined,
    agentDefinitions: { activeAgents: [], allAgents: [] },
    currentCwd: '/tmp',
    cliAgents: [],
    initialState,
  }
}

async function createTempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'openclaude-session-restore-'))
  tempDirs.push(dir)
  return dir
}

async function writeSourceTranscript(
  dir: string,
  messages: Message[] = sourceMessages(),
): Promise<string> {
  const filePath = join(dir, `${sourceSessionId}.jsonl`)
  const entries = messages.map(message => ({
    ...message,
    cwd: dir,
    userType: 'external',
    sessionId: sourceSessionId as UUID,
    version: 'test',
    isSidechain: false,
  }))
  await writeFile(
    filePath,
    `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`,
  )
  return filePath
}

function forkInfoMessage(messages: Message[]): Message | undefined {
  return messages.find(
    message =>
      message.type === 'system' &&
      message.subtype === 'informational' &&
      message.level === 'info' &&
      message.content.includes('Forked conversation'),
  )
}

async function processForkedResume(
  options: {
    sessionIdOverride?: string
    transcriptPath?: string
    messages?: Message[]
    contentReplacements?: ContentReplacementRecord[]
    worktreeSession?: PersistedWorktreeSession | null
  } = {},
): Promise<ProcessedResume> {
  return processResumedConversation(
    {
      messages: options.messages ?? sourceMessages(),
      sessionId: sourceSessionId as UUID,
      contentReplacements: options.contentReplacements,
      worktreeSession: options.worktreeSession,
    },
    {
      forkSession: true,
      sessionIdOverride: options.sessionIdOverride,
      transcriptPath: options.transcriptPath,
    },
    testContext(),
  )
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/sessionRestore.test.ts')
  originalNodeEnv = process.env.NODE_ENV
  originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  originalPersistence = process.env.ENABLE_SESSION_PERSISTENCE
  originalSkipPromptHistory = process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
  originalSessionId = getSessionId()
  originalSessionProjectDir = getSessionProjectDir()
  originalPersistenceDisabled = isSessionPersistenceDisabled()

  process.env.NODE_ENV = 'test'
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = 'true'
  process.env.ENABLE_SESSION_PERSISTENCE = 'true'
  delete process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
  setSessionPersistenceDisabled(false)
  resetProjectForTesting()
})

afterEach(async () => {
  try {
    await flushSessionStorage()
    await Promise.all(
      tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
    )
  } finally {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = originalNodeEnv
    }
    if (originalTestPersistence === undefined) {
      delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    } else {
      process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalTestPersistence
    }
    if (originalPersistence === undefined) {
      delete process.env.ENABLE_SESSION_PERSISTENCE
    } else {
      process.env.ENABLE_SESSION_PERSISTENCE = originalPersistence
    }
    if (originalSkipPromptHistory === undefined) {
      delete process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
    } else {
      process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY =
        originalSkipPromptHistory
    }
    setSessionPersistenceDisabled(originalPersistenceDisabled)
    switchSession(originalSessionId as never, originalSessionProjectDir)
    resetProjectForTesting()
    releaseSharedMutationLock()
  }
})

describe('forked session resume', () => {

describe('Code Mode resume compatibility', () => {
  afterEach(() => setReplModeEnabledForSession(false))

  test('accepts matching direct and Code Mode sessions', () => {
    setReplModeEnabledForSession(false)
    expect(() => enforceCodeModeResumeCompatibility(false)).not.toThrow()
    expect(() => enforceCodeModeResumeCompatibility(undefined)).not.toThrow()

    setReplModeEnabledForSession(true)
    expect(() => enforceCodeModeResumeCompatibility(true)).not.toThrow()
    setReplModeEnabledForSession(true)
  })


  test('loadConversationForResume rejects mismatched resume mode', async () => {
    setReplModeEnabledForSession(false)
    const log = {
      date: ts,
      messages: sourceMessages(),
      value: 0,
      created: new Date(ts),
      modified: new Date(ts),
      firstPrompt: 'source prompt',
      messageCount: sourceMessages().length,
      isSidechain: false,
      sessionId: sourceSessionId,
      codeMode: true,
    }

    await expect(
      loadConversationForResume(log as never, undefined),
    ).rejects.toThrow('cannot be resumed with direct tools')
  })

  test('processResumedConversation rejects a Code Mode transcript in direct mode', async () => {
    setReplModeEnabledForSession(false)
    await expect(
      processResumedConversation(
        {
          messages: sourceMessages(),
          sessionId: sourceSessionId as UUID,
          codeMode: true,
        },
        { forkSession: true },
        testContext(),
      ),
    ).rejects.toThrow('cannot be resumed with direct tools')
  })

  test('a direct transcript resumed in Code Mode keeps the direct contract', () => {
    setReplModeEnabledForSession(true)
    enforceCodeModeResumeCompatibility(false)
    expect(isReplModeEnabled()).toBe(false)
  })


  test('direct resume does not consume startup eligibility for later conversations', () => {
    setReplModeEnabledForSession(true)
    enforceCodeModeResumeCompatibility(false)
    expect(isReplModeEnabled()).toBe(false)

    expect(resetReplModeToSessionEligibility()).toBe(true)
    expect(isReplModeEnabled()).toBe(true)

    enforceCodeModeResumeCompatibility(true)
    expect(isReplModeEnabled()).toBe(true)
  })

  test('withCodeModeResumeActivation keeps the activation on success', async () => {
    setReplModeEnabledForSession(true)
    const result = await withCodeModeResumeActivation(true, async () => {
      expect(isReplModeEnabled()).toBe(true)
      return 'done'
    })
    expect(result).toBe('done')
    expect(getReplModeConversationOverride()).toBe(true)
  })

  test('withCodeModeResumeActivation restores the prior override when work fails after validation', async () => {
    setReplModeEnabledForSession(true)
    setReplModeForConversation(false)
    await expect(
      withCodeModeResumeActivation(true, async () => {
        expect(isReplModeEnabled()).toBe(true)
        throw new Error('resume failed mid-flight')
      }),
    ).rejects.toThrow('resume failed mid-flight')
    expect(getReplModeConversationOverride()).toBe(false)
  })

  test('withCodeModeResumeActivation restores an undefined prior override on failure', async () => {
    setReplModeEnabledForSession(true)
    setReplModeForConversation(undefined)
    await expect(
      withCodeModeResumeActivation(false, async () => {
        throw new Error('resume failed mid-flight')
      }),
    ).rejects.toThrow('resume failed mid-flight')
    expect(getReplModeConversationOverride()).toBeUndefined()
  })

  test('withCodeModeResumeActivation validation failure never activates', async () => {
    setReplModeEnabledForSession(false)
    setReplModeForConversation(false)
    let workRan = false
    await expect(
      withCodeModeResumeActivation(true, async () => {
        workRan = true
      }),
    ).rejects.toThrow('cannot be resumed with direct tools')
    expect(workRan).toBe(false)
    expect(getReplModeConversationOverride()).toBe(false)
  })

  test('processResumedConversation restores the prior mode override when resume fails after validation', async () => {
    setReplModeEnabledForSession(true)
    setReplModeForConversation(false)
    const failingResult = {
      messages: sourceMessages(),
      sessionId: sourceSessionId as UUID,
      codeMode: true,
      get contentReplacements(): ContentReplacementRecord[] | undefined {
        throw new Error('injected post-validation failure')
      },
    }

    await expect(
      processResumedConversation(
        failingResult,
        { forkSession: true },
        testContext(),
      ),
    ).rejects.toThrow('injected post-validation failure')
    expect(getReplModeConversationOverride()).toBe(false)
  })

  test('processResumedConversation keeps the transcript mode active after a compatible resume', async () => {
    setReplModeEnabledForSession(true)
    setReplModeForConversation(false)
    const dir = await createTempProject()
    switchSession(forkSessionId as never, dir)
    await resetSessionFilePointer()

    await processResumedConversation(
      {
        messages: sourceMessages(),
        sessionId: sourceSessionId as UUID,
        codeMode: true,
      },
      { forkSession: true },
      testContext(),
    )

    expect(getReplModeConversationOverride()).toBe(true)
    expect(isReplModeEnabled()).toBe(true)
  })

  test('processResumedConversation validation failure never activates the transcript mode', async () => {
    setReplModeEnabledForSession(false)
    setReplModeForConversation(false)
    await expect(
      processResumedConversation(
        {
          messages: sourceMessages(),
          sessionId: sourceSessionId as UUID,
          codeMode: true,
        },
        { forkSession: true },
        testContext(),
      ),
    ).rejects.toThrow('cannot be resumed with direct tools')
    expect(getReplModeConversationOverride()).toBe(false)
  })
})

test('--continue --fork-session keeps the startup session id and adds an info message', async () => {
    const dir = await createTempProject()
    switchSession(forkSessionId as never, dir)
    await resetSessionFilePointer()

    const result = await processForkedResume()

    expect(String(getSessionId())).toBe(forkSessionId)
    const message = forkInfoMessage(result.messages)
    expect(message?.content).toContain(sourceSessionId)
    expect(message?.content).toContain(forkSessionId)
    expect(message?.content).toContain('conversation branching')
    expect(message?.content).toContain('not filesystem isolation')
  })

  test('--resume <id> --fork-session keeps the startup session id and reports the selected source id', async () => {
    const dir = await createTempProject()
    switchSession(forkSessionId as never, dir)
    await resetSessionFilePointer()

    const result = await processForkedResume({
      sessionIdOverride: sourceSessionId,
    })

    expect(String(getSessionId())).toBe(forkSessionId)
    const message = forkInfoMessage(result.messages)
    expect(message?.content).toContain(sourceSessionId)
    expect(message?.content).toContain(forkSessionId)
  })

  test('fork materializes a new transcript with replacement records and no original worktree ownership', async () => {
    const dir = await createTempProject()
    const messages = sourceMessagesWithToolResult()
    const sourceFile = await writeSourceTranscript(dir, messages)
    const sourceBefore = await readFile(sourceFile, 'utf8')
    const replacement: ContentReplacementRecord = {
      kind: 'tool-result',
      toolUseId: 'tool-use-1',
      replacement: '[persisted tool result preview]',
    }
    const droppedReplacement: ContentReplacementRecord = {
      kind: 'tool-result',
      toolUseId: 'tool-use-2',
      replacement: '[stale tool result preview]',
    }
    const sourceWorktree: PersistedWorktreeSession = {
      originalCwd: '/repo',
      worktreePath: '/repo/.worktrees/source',
      worktreeName: 'source',
      worktreeBranch: 'feature/source',
      originalBranch: 'main',
      originalHeadCommit: 'abcdef',
      sessionId: sourceSessionId as UUID,
    }

    switchSession(forkSessionId as never, dir)
    await resetSessionFilePointer()

    const result = await processForkedResume({
      transcriptPath: sourceFile,
      messages,
      contentReplacements: [replacement, droppedReplacement],
      worktreeSession: sourceWorktree,
    })
    expect(result.contentReplacements).toEqual([replacement])
    await recordTranscript(result.messages)
    await flushSessionStorage()

    const sourceAfter = await readFile(sourceFile, 'utf8')
    expect(sourceAfter).toBe(sourceBefore)

    const forkFile = join(dir, `${forkSessionId}.jsonl`)
    expect(getTranscriptPath()).toBe(forkFile)
    const forkText = await readFile(forkFile, 'utf8')
    const forkEntries = forkText
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { type?: string; sessionId?: string })

    expect(
      forkEntries
        .filter(entry => entry.type === 'user' || entry.type === 'assistant')
        .every(entry => entry.sessionId === forkSessionId),
    ).toBe(true)
    expect(
      forkEntries.some(entry => entry.type === 'content-replacement'),
    ).toBe(true)
    expect(
      forkEntries.some(entry => entry.type === 'worktree-state'),
    ).toBe(false)

    const loaded = await loadTranscriptFile(forkFile)
    expect(loaded.contentReplacements.get(forkSessionId as UUID)).toEqual([
      replacement,
    ])
    expect(JSON.stringify(forkEntries)).not.toContain('tool-use-2')
    expect(
      loaded.contentReplacements.get(sourceSessionId as UUID),
    ).toBeUndefined()
  })

  test('normal resume switches to and adopts the source transcript without adding fork metadata', async () => {
    const dir = await createTempProject()
    const sourceFile = await writeSourceTranscript(dir)

    switchSession(forkSessionId as never, dir)
    await resetSessionFilePointer()

    const result = await processResumedConversation(
      {
        messages: sourceMessages(),
        sessionId: sourceSessionId as UUID,
      },
      {
        forkSession: false,
        sessionIdOverride: sourceSessionId,
        transcriptPath: sourceFile,
      },
      testContext(),
    )

    expect(String(getSessionId())).toBe(sourceSessionId)
    expect(getTranscriptPath()).toBe(sourceFile)
    expect(forkInfoMessage(result.messages)).toBeUndefined()
  })
})
