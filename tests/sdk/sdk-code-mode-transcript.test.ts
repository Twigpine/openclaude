import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { randomUUID } from 'crypto'
import { join } from 'path'
import {
  forkSession,
  getSessionMessages,
  query,
  unstable_v2_resumeSession,
} from '../../src/entrypoints/sdk/index.js'
import {
  getCwdState,
  getOriginalCwd,
  getSessionId,
  getSessionProjectDir,
  setCwdState,
  setOriginalCwd,
  switchSession,
} from '../../src/bootstrap/state.js'
import {
  isReplModeEnabled,
  setReplModeEnabledForSession,
} from '../../src/tools/REPLTool/constants.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../src/test/sharedMutationLock.js'
import type { SessionId } from '../../src/types/ids.js'
import { readJSONLFile } from '../../src/utils/json.js'
import type { JsonlEntry } from '../../src/entrypoints/sdk/shared.js'
import {
  collectMessages,
  createMinimalConversation,
  createSessionJsonl,
  queryInternals,
  sessionInternals,
  withTempDir,
} from './helpers/query-test-doubles.js'
import { MockQueryEngine } from './helpers/mock-engine.js'

let originalSessionId: SessionId
let originalSessionProjectDir: string | null
let originalCwd: string
let originalOriginalCwd: string

function conversationWithCodeModeMarker(
  sessionId: string,
  codeMode: boolean,
): Array<Record<string, unknown>> {
  return [
    { type: 'code-mode', sessionId, codeMode },
    ...createMinimalConversation(sessionId),
  ]
}

async function iterateError(q: ReturnType<typeof query>): Promise<unknown> {
  try {
    for await (const _message of q) {
      // Drain until the boundary error stops iteration.
    }
    return null
  } catch (error) {
    return error
  }
}

beforeEach(async () => {
  await acquireSharedMutationLock('sdk-code-mode-transcript')
  setReplModeEnabledForSession(false)
  originalSessionId = getSessionId()
  originalSessionProjectDir = getSessionProjectDir()
  originalCwd = getCwdState()
  originalOriginalCwd = getOriginalCwd()
})

afterEach(() => {
  try {
    setReplModeEnabledForSession(false)
    switchSession(originalSessionId, originalSessionProjectDir)
    setCwdState(originalCwd)
    setOriginalCwd(originalOriginalCwd)
  } finally {
    releaseSharedMutationLock()
  }
})

describe('SDK Code Mode transcript boundaries', () => {
  test('v2 resume rejects a Code Mode transcript when only direct tools are available', async () => {
    await withTempDir(async dir => {
      const sessionId = randomUUID()
      createSessionJsonl(
        dir,
        sessionId,
        conversationWithCodeModeMarker(sessionId, true),
      )

      await expect(
        unstable_v2_resumeSession(sessionId, { cwd: dir }),
      ).rejects.toThrow('cannot be resumed with direct tools')
    })
  })

  test('v2 resume keeps a direct transcript on direct tools when Code Mode is enabled', async () => {
    await withTempDir(async dir => {
      setReplModeEnabledForSession(true)
      const sessionId = randomUUID()
      createSessionJsonl(
        dir,
        sessionId,
        conversationWithCodeModeMarker(sessionId, false),
      )

      const session = await unstable_v2_resumeSession(sessionId, { cwd: dir })
      try {
        expect(isReplModeEnabled()).toBe(false)
        const toolNames = sessionInternals(session)._engine?.config.tools.map(
          tool => tool.name,
        )
        expect(toolNames).toContain('Read')
        expect(toolNames).not.toContain('REPL')
      } finally {
        session.close()
      }
    })
  })

  test('v2 resume builds the Code Mode tool surface before injecting a Code Mode transcript', async () => {
    await withTempDir(async dir => {
      setReplModeEnabledForSession(true)
      const sessionId = randomUUID()
      createSessionJsonl(
        dir,
        sessionId,
        conversationWithCodeModeMarker(sessionId, true),
      )

      const session = await unstable_v2_resumeSession(sessionId, { cwd: dir })
      try {
        expect(isReplModeEnabled()).toBe(true)
        const toolNames = sessionInternals(session)._engine?.config.tools.map(
          tool => tool.name,
        )
        expect(toolNames).toContain('REPL')
        expect(toolNames).not.toContain('Read')
      } finally {
        session.close()
      }
    })
  })

  test('query rejects a Code Mode transcript before injecting it into a direct engine', async () => {
    await withTempDir(async dir => {
      const sessionId = randomUUID()
      createSessionJsonl(
        dir,
        sessionId,
        conversationWithCodeModeMarker(sessionId, true),
      )

      const q = query({
        prompt: 'continue',
        options: { cwd: dir, sessionId },
      })
      const mockEngine = new MockQueryEngine()
      queryInternals(q).setEngine(mockEngine)

      const error = await iterateError(q)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain(
        'cannot be resumed with direct tools',
      )
      expect(mockEngine.getMessages()).toEqual([])
      q.close()
    })
  })

  test('query rebuilds direct tools before resuming a direct transcript in a Code Mode process', async () => {
    await withTempDir(async dir => {
      setReplModeEnabledForSession(true)
      const sessionId = randomUUID()
      createSessionJsonl(
        dir,
        sessionId,
        conversationWithCodeModeMarker(sessionId, false),
      )

      const q = query({
        prompt: 'continue',
        options: { cwd: dir, sessionId },
      })
      const mockEngine = new MockQueryEngine()
      queryInternals(q).setEngine(mockEngine)
      await collectMessages(q)

      expect(isReplModeEnabled()).toBe(false)
      const toolNames = mockEngine.config.tools.map(tool => tool.name)
      expect(toolNames).toContain('Read')
      expect(toolNames).not.toContain('REPL')
      expect(mockEngine.getMessages().length).toBeGreaterThanOrEqual(2)
      q.close()
    })
  })

  test('query fork does not swallow the Code Mode compatibility error', async () => {
    await withTempDir(async dir => {
      const sourceSessionId = randomUUID()
      createSessionJsonl(
        dir,
        sourceSessionId,
        conversationWithCodeModeMarker(sourceSessionId, true),
      )

      const q = query({
        prompt: 'continue',
        options: { cwd: dir, sessionId: sourceSessionId, fork: true },
      })
      const mockEngine = new MockQueryEngine()
      queryInternals(q).setEngine(mockEngine)

      const error = await iterateError(q)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain(
        'cannot be resumed with direct tools',
      )
      expect(mockEngine.getMessages()).toEqual([])
      q.close()
    })
  })

  test('forkSession copies the Code Mode marker onto the forked session', async () => {
    await withTempDir(async dir => {
      const sourceSessionId = randomUUID()
      const sessionDir = createSessionJsonl(
        dir,
        sourceSessionId,
        conversationWithCodeModeMarker(sourceSessionId, true),
      )

      const forked = await forkSession(sourceSessionId, { dir })
      const forkedEntries = await readJSONLFile<JsonlEntry>(
        join(sessionDir, `${forked.sessionId}.jsonl`),
      )
      const marker = forkedEntries.find(entry => entry.type === 'code-mode')
      expect(marker).toBeDefined()
      expect(marker?.sessionId).toBe(forked.sessionId)
      expect(marker?.codeMode).toBe(true)
    })
  })

  test('a pre-compact Code Mode marker still gates a large transcript resume', async () => {
    await withTempDir(async dir => {
      const sessionId = randomUUID()
      const staleUserUuid = randomUUID()
      const staleAssistantUuid = randomUUID()
      const postUserUuid = randomUUID()
      const postAssistantUuid = randomUUID()
      const filler = 'x'.repeat(5 * 1024 * 1024)
      createSessionJsonl(dir, sessionId, [
        {
          type: 'user',
          message: { role: 'user', content: filler },
          uuid: staleUserUuid,
          parentUuid: null,
          sessionId,
          isSidechain: false,
        },
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'stale' }] },
          uuid: staleAssistantUuid,
          parentUuid: staleUserUuid,
          sessionId,
          isSidechain: false,
        },
        { type: 'code-mode', sessionId, codeMode: true },
        {
          type: 'system',
          subtype: 'compact_boundary',
          compactMetadata: { trigger: 'manual', preTokens: 10000 },
          uuid: randomUUID(),
          sessionId,
          isSidechain: false,
        },
        {
          type: 'user',
          message: { role: 'user', content: 'post compact' },
          uuid: postUserUuid,
          parentUuid: staleAssistantUuid,
          sessionId,
          isSidechain: false,
        },
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'post reply' }] },
          uuid: postAssistantUuid,
          parentUuid: postUserUuid,
          sessionId,
          isSidechain: false,
        },
      ])

      await expect(
        unstable_v2_resumeSession(sessionId, { cwd: dir }),
      ).rejects.toThrow('cannot be resumed with direct tools')
    })
  }, 20_000)

  test('getSessionMessages preserves virtual message provenance', async () => {
    await withTempDir(async dir => {
      const sessionId = randomUUID()
      const entries = createMinimalConversation(sessionId)
      entries[0]!.isVirtual = true
      entries[1]!.isVirtual = true
      createSessionJsonl(dir, sessionId, entries)

      const messages = await getSessionMessages(sessionId, { dir })
      expect(messages.length).toBeGreaterThanOrEqual(2)
      expect(messages[0]?.isVirtual).toBe(true)
      expect(messages[1]?.isVirtual).toBe(true)
    })
  })
})
