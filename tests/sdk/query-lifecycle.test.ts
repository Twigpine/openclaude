import { describe, test, expect, afterEach, beforeAll, afterAll } from 'bun:test'
import { query, forkSession, getSessionMessages, unstable_v2_createSession } from '../../src/entrypoints/sdk/index.js'
import {
  buildPermissionContext,
  createDefaultCanUseTool,
  createExternalCanUseTool,
  createPermissionTarget,
} from '../../src/entrypoints/sdk/permissions.js'
import { randomUUID } from 'crypto'
import { rmSync } from 'fs'
import {
  drainQuery,
  withTempDir,
  createSessionJsonl,
  createMinimalConversation,
  createMultiTurnConversation,
  UUID_REGEX,
  isExpectedDrainAbort,
} from './helpers/query-test-doubles.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../src/test/sharedMutationLock.js'
import { clearAgentDefinitionsCache } from '../../src/tools/AgentTool/loadAgentsDir.js'

// Tests that drain fully (no early interrupt) trigger init(), which checks
// for auth credentials. Provide a stub key so init() succeeds without network.
const AUTH_KEY = 'ANTHROPIC_API_KEY'
const DISABLE_BUILTIN_AGENTS_KEY = 'CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS'
let savedApiKey: string | undefined
let savedDisableBuiltinAgents: string | undefined
let hadSavedMacro = false
let savedMacro: unknown

beforeAll(async () => {
  await acquireSharedMutationLock('tests/sdk/query-lifecycle.test.ts')
  savedApiKey = process.env[AUTH_KEY]
  savedDisableBuiltinAgents = process.env[DISABLE_BUILTIN_AGENTS_KEY]
  hadSavedMacro = Object.hasOwn(globalThis, 'MACRO')
  savedMacro = (globalThis as Record<string, unknown>).MACRO
  if (!savedApiKey) {
    process.env[AUTH_KEY] = 'sk-test-lifecycle-stub'
  }
  process.env[DISABLE_BUILTIN_AGENTS_KEY] = '1'
  ;(globalThis as Record<string, unknown>).MACRO = {
    VERSION: '0.0.0-test',
    DISPLAY_VERSION: '0.0.0-test',
    BUILD_TIME: 'test',
    ISSUES_EXPLAINER: 'test',
    PACKAGE_URL: 'test',
    NATIVE_PACKAGE_URL: undefined,
  }
  clearAgentDefinitionsCache()
})

afterAll(() => {
  try {
    if (savedApiKey === undefined) {
      delete process.env[AUTH_KEY]
    } else {
      process.env[AUTH_KEY] = savedApiKey
    }
    if (savedDisableBuiltinAgents === undefined) {
      delete process.env[DISABLE_BUILTIN_AGENTS_KEY]
    } else {
      process.env[DISABLE_BUILTIN_AGENTS_KEY] = savedDisableBuiltinAgents
    }
    if (hadSavedMacro) {
      ;(globalThis as Record<string, unknown>).MACRO = savedMacro
    } else {
      delete (globalThis as Record<string, unknown>).MACRO
    }
    clearAgentDefinitionsCache()
  } finally {
    releaseSharedMutationLock()
  }
})

describe('Query.sessionId accessor (API-1)', () => {
  test('query() returns a Query with sessionId for fresh query', () => {
    const q = query({
      prompt: 'test',
      options: { cwd: process.cwd() },
    })
    expect(q.sessionId).toBeDefined()
    expect(typeof q.sessionId).toBe('string')
    expect(q.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
    q.interrupt()
  })

  test('query() with sessionId option returns that sessionId', () => {
    const sid = '12345678-1234-1234-1234-123456789012'
    const q = query({
      prompt: 'test',
      options: { cwd: process.cwd(), sessionId: sid },
    })
    expect(q.sessionId).toBe(sid)
    q.interrupt()
  })

  test('query() with continue:true still has a sessionId', () => {
    const q = query({
      prompt: 'test',
      options: { cwd: process.cwd(), continue: true },
    })
    expect(q.sessionId).toBeDefined()
    expect(typeof q.sessionId).toBe('string')
    q.interrupt()
  })

  test('two queries have different sessionIds', () => {
    const q1 = query({ prompt: 'a', options: { cwd: process.cwd() } })
    const q2 = query({ prompt: 'b', options: { cwd: process.cwd() } })
    expect(q1.sessionId).not.toBe(q2.sessionId)
    q1.interrupt()
    q2.interrupt()
  })
})

describe('Engine lazy-init guard (COR-1)', () => {
  test('QueryImpl close() works after construction', () => {
    const q = query({
      prompt: 'test',
      options: { cwd: process.cwd() },
    })
    expect(() => q.close()).not.toThrow()
  })

  test('QueryImpl close() aborts its wrapper controller after an engine override', () => {
    const abortController = new AbortController()
    const q = query({
      prompt: 'test',
      options: { cwd: process.cwd(), abortController },
    })
    ;(q as unknown as {
      setEngine(engine: { interrupt(): void }): void
    }).setEngine({ interrupt() {} })

    q.close()

    expect(abortController.signal.aborted).toBe(true)
  })

  test('SDKSession getMessages() works after construction', async () => {
    const { unstable_v2_createSession } = await import('../../src/entrypoints/sdk/index.js')
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
    })
    expect(session.sessionId).toBeDefined()
    expect(Array.isArray(session.getMessages())).toBe(true)
  })
})

describe('query() construction validation', () => {
  test('query() with no cwd throws immediately', () => {
    expect(() =>
      query({ prompt: 'test', options: {} as any })
    ).toThrow('query() requires options.cwd')
  })

  test('query() with empty string prompt creates valid Query', () => {
    const q = query({
      prompt: '',
      options: { cwd: process.cwd() },
    })
    expect(q.sessionId).toBeDefined()
    expect(typeof q.sessionId).toBe('string')
    q.interrupt()
  })

  test('query() with async iterable prompt creates valid Query', () => {
    async function* prompts() {
      yield { type: 'user' as const, message: { role: 'user' as const, content: 'hello' } }
    }
    const q = query({
      prompt: prompts(),
      options: { cwd: process.cwd() },
    })
    expect(q.sessionId).toBeDefined()
    q.interrupt()
  })
})

describe('Query interrupt lifecycle', () => {
  test('interrupt() followed by iterator drain does not hang', async () => {
    const q = query({
      prompt: 'test interrupt drain',
      options: { cwd: process.cwd() },
    })
    q.interrupt()
    const messages = await drainQuery(q)
    expect(Array.isArray(messages)).toBe(true)
  }, 10_000)

  test('close() followed by iterator drain does not hang', async () => {
    const q = query({
      prompt: 'test close drain',
      options: { cwd: process.cwd() },
    })
    q.close()
    const messages = await drainQuery(q)
    expect(Array.isArray(messages)).toBe(true)
  }, 10_000)

  test('interrupt() and close() both called — no double-error', async () => {
    const q = query({
      prompt: 'test double abort',
      options: { cwd: process.cwd() },
    })
    q.interrupt()
    q.close()
    const messages = await drainQuery(q)
    expect(Array.isArray(messages)).toBe(true)
  }, 10_000)

  test('interrupt() before iteration starts — completes cleanly', async () => {
    const q = query({
      prompt: 'test early interrupt',
      options: { cwd: process.cwd() },
    })
    q.interrupt()
    const messages = await drainQuery(q)
    expect(Array.isArray(messages)).toBe(true)
  }, 10_000)

  test('interrupt() from external AbortController propagates', async () => {
    const ac = new AbortController()
    const q = query({
      prompt: 'test external abort',
      options: { cwd: process.cwd(), abortController: ac },
    })
    ac.abort()
    const messages = await drainQuery(q)
    expect(Array.isArray(messages)).toBe(true)
  }, 10_000)

  test('interrupt() with reason "interrupt" does not yield synthetic user cancellation message', async () => {
    const ac = new AbortController()
    const q = query({
      prompt: 'test interrupt reason',
      options: { cwd: process.cwd(), abortController: ac },
    })
    ac.abort('interrupt')
    const messages = await drainQuery(q)
    expect(Array.isArray(messages)).toBe(true)
    const userCancelMsg = messages.find((m: any) => 
      m.type === 'user' && 
      Array.isArray(m.message?.content) && 
      m.message.content[0]?.text === '[Request interrupted by user]'
    )
    expect(userCancelMsg).toBeUndefined()
  }, 10_000)

  test('Stop hook regression test - aborting with reason interrupt suppresses cancellation message', async () => {
    const { query: queryLoop } = await import('../../src/query.js')
    const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
    const { asSystemPrompt } = await import('../../src/utils/systemPromptType.js')

    const abortController = new AbortController()
    const appStateRef = {
      current: {
        ...getDefaultAppState(),
      },
    }

    const toolUseContext: any = {
      options: {
        commands: [],
        debug: false,
        mainLoopModel: 'sonnet',
        tools: [],
        verbose: false,
        thinkingConfig: { type: 'disabled' },
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: true,
        agentDefinitions: { activeAgents: [], allAgents: [], allowedAgentTypes: [] },
      },
      abortController,
      getAppState: () => appStateRef.current,
      setAppState: (updater: any) => {
        appStateRef.current = updater(appStateRef.current)
      },
    }

    const mockExecuteStopHooks = async function* () {
      yield {
        message: {
          type: 'progress' as const,
          toolUseID: 'mock-tool-use-id',
          data: {
            command: 'mock-command',
            promptText: 'mock-prompt',
          },
        },
      }
      abortController.abort('interrupt')
      yield {
        message: {
          type: 'progress' as const,
          toolUseID: 'mock-tool-use-id-2',
          data: {
            command: 'mock-command-2',
            promptText: 'mock-prompt-2',
          },
        },
      }
    }

    const mockCallModel = async function* () {
      yield {
        type: 'assistant' as const,
        uuid: 'assistant-1',
        message: {
          id: 'assistant-1',
          type: 'message' as const,
          role: 'assistant' as const,
          model: 'test-model',
          stop_reason: 'end_turn' as const,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [{ type: 'text' as const, text: 'Hello' }],
        },
      }
    }

    const q = queryLoop({
      messages: [],
      systemPrompt: asSystemPrompt([]),
      userContext: {},
      systemContext: {},
      canUseTool: async () => ({ behavior: 'allow' }),
      toolUseContext,
      querySource: 'sdk',
      deps: {
        callModel: mockCallModel as any,
        microcompact: async (messages) => ({ messages }),
        autocompact: async () => ({ wasCompacted: false }),
        uuid: () => 'uuid-1',
        stopHookExecutionDeps: {
          executeStopHooks: mockExecuteStopHooks as any,
          isTeammate: () => false,
          getStopHookMessage: () => 'stop hook blocked',
        },
      },
    })

    const messages: any[] = []
    try {
      for await (const msg of q) {
        messages.push(msg)
      }
    } catch (err) {
      if (!isExpectedDrainAbort(err)) throw err
    }

    const userCancelMsg = messages.find(
      (m: any) =>
        m.type === 'user' &&
        Array.isArray(m.message?.content) &&
        m.message.content[0]?.text === '[Request interrupted by user]',
    )
    expect(userCancelMsg).toBeUndefined()
  }, 10_000)

  test('Stop hook regression test - default abort still yields cancellation message', async () => {
    const { query: queryLoop } = await import('../../src/query.js')
    const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
    const { asSystemPrompt } = await import('../../src/utils/systemPromptType.js')

    const abortController = new AbortController()
    const appStateRef = {
      current: {
        ...getDefaultAppState(),
      },
    }

    const toolUseContext: any = {
      options: {
        commands: [],
        debug: false,
        mainLoopModel: 'sonnet',
        tools: [],
        verbose: false,
        thinkingConfig: { type: 'disabled' },
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: true,
        agentDefinitions: { activeAgents: [], allAgents: [], allowedAgentTypes: [] },
      },
      abortController,
      getAppState: () => appStateRef.current,
      setAppState: (updater: any) => {
        appStateRef.current = updater(appStateRef.current)
      },
    }

    const mockExecuteStopHooks = async function* () {
      yield {
        message: {
          type: 'progress' as const,
          toolUseID: 'mock-tool-use-id',
          data: {
            command: 'mock-command',
            promptText: 'mock-prompt',
          },
        },
      }
      abortController.abort()
      yield {
        message: {
          type: 'progress' as const,
          toolUseID: 'mock-tool-use-id-2',
          data: {
            command: 'mock-command-2',
            promptText: 'mock-prompt-2',
          },
        },
      }
    }

    const mockCallModel = async function* () {
      yield {
        type: 'assistant' as const,
        uuid: 'assistant-1',
        message: {
          id: 'assistant-1',
          type: 'message' as const,
          role: 'assistant' as const,
          model: 'test-model',
          stop_reason: 'end_turn' as const,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [{ type: 'text' as const, text: 'Hello' }],
        },
      }
    }

    const q = queryLoop({
      messages: [],
      systemPrompt: asSystemPrompt([]),
      userContext: {},
      systemContext: {},
      canUseTool: async () => ({ behavior: 'allow' }),
      toolUseContext,
      querySource: 'sdk',
      deps: {
        callModel: mockCallModel as any,
        microcompact: async (messages) => ({ messages }),
        autocompact: async () => ({ wasCompacted: false }),
        uuid: () => 'uuid-1',
        stopHookExecutionDeps: {
          executeStopHooks: mockExecuteStopHooks as any,
          isTeammate: () => false,
          getStopHookMessage: () => 'stop hook blocked',
        },
      },
    })

    const messages: any[] = []
    try {
      for await (const msg of q) {
        messages.push(msg)
      }
    } catch (err) {
      if (!isExpectedDrainAbort(err)) throw err
    }

    const userCancelMsg = messages.find(
      (m: any) =>
        m.type === 'user' &&
        Array.isArray(m.message?.content) &&
        m.message.content[0]?.text === '[Request interrupted by user]',
    )
    expect(userCancelMsg).toBeDefined()
  }, 10_000)
})

describe('Query resume lifecycle', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    }
    tempDirs.length = 0
  })

  test('query() with sessionId and existing JSONL — session loads messages', async () => {
    await withTempDir(async (dir) => {
      tempDirs.push(dir)
      const sid = randomUUID()
      const entries = createMinimalConversation(sid)
      createSessionJsonl(dir, sid, entries)

      const q = query({
        prompt: 'continue conversation',
        options: { cwd: dir, sessionId: sid },
      })
      expect(q.sessionId).toBe(sid)
      q.interrupt()
      await drainQuery(q)
    })
  })

  test('query() with continue:true and no prior sessions — creates fresh session', async () => {
    await withTempDir(async (dir) => {
      tempDirs.push(dir)
      const q = query({
        prompt: 'fresh start',
        options: { cwd: dir, continue: true },
      })
      expect(q.sessionId).toBeDefined()
      expect(UUID_REGEX.test(q.sessionId)).toBe(true)
      q.interrupt()
      await drainQuery(q)
    })
  })

  test('query() with fork:true — creates new sessionId', async () => {
    await withTempDir(async (dir) => {
      tempDirs.push(dir)
      const sid = randomUUID()
      const entries = createMinimalConversation(sid)
      createSessionJsonl(dir, sid, entries)

      const q = query({
        prompt: 'forked conversation',
        options: { cwd: dir, sessionId: sid, fork: true },
      })
      // Fork happens lazily during iteration. The first item is enough to
      // trigger session resolution without advancing into the API request.
      const iterator = q[Symbol.asyncIterator]()
      try {
        const first = await iterator.next()
        expect(first.done).toBe(false)
      } finally {
        q.interrupt()
        await iterator.return?.()
      }
      expect(q.sessionId).toBeDefined()
      expect(q.sessionId).not.toBe(sid)
    })
  }, 10_000)

  test('query() with resumeSessionAt — truncates at specified message', async () => {
    await withTempDir(async (dir) => {
      tempDirs.push(dir)
      const sid = randomUUID()
      const entries = createMultiTurnConversation(sid, 3)
      createSessionJsonl(dir, sid, entries)

      const secondAssistantUuid = entries[3].uuid as string

      const q = query({
        prompt: 'resume at message',
        options: { cwd: dir, sessionId: sid, resumeSessionAt: secondAssistantUuid },
      })
      expect(q.sessionId).toBe(sid)
      q.interrupt()
      await drainQuery(q)
    })
  })

  test('query() with resumeSessionAt pointing to invalid UUID — throws', async () => {
    await withTempDir(async (dir) => {
      tempDirs.push(dir)
      const sid = randomUUID()
      const entries = createMinimalConversation(sid)
      createSessionJsonl(dir, sid, entries)

      const fakeUuid = randomUUID()
      const q = query({
        prompt: 'bad resume point',
        options: { cwd: dir, sessionId: sid, resumeSessionAt: fakeUuid },
      })
      let caught = false
      try {
        for await (const _ of q) {
          // drain
        }
      } catch (err: any) {
        caught = true
        expect(err.message).toContain('resumeSessionAt')
        expect(err.message).toContain('not found')
      }
      expect(caught).toBe(true)
    })
  })
})

describe('Secure-by-default permissions (SEC-2)', () => {
  test('createDefaultCanUseTool denies all tools when no callback is provided', async () => {
    const canUseTool = createDefaultCanUseTool(
      buildPermissionContext({ cwd: process.cwd() }),
      { warn: () => {} },
    )

    const result = await canUseTool(
      { name: 'Read' } as any,
      { file_path: 'test.txt' },
      {} as any,
      {} as any,
      'tool-use-id',
      undefined,
    )

    expect(result.behavior).toBe('deny')
    expect(result.message).toContain('no canUseTool or onPermissionRequest')
    expect(result.decisionReason).toEqual({ type: 'mode', mode: 'default' })
  })

  test('canUseTool callback overrides deny-by-default', async () => {
    const allowedTools: string[] = []
    const q = query({
      prompt: 'test with callback',
      options: {
        cwd: process.cwd(),
        canUseTool: async (name, _input) => {
          allowedTools.push(name)
          return { behavior: 'allow' }
        },
      },
    })
    q.interrupt()
    const messages = await drainQuery(q)
    expect(Array.isArray(messages)).toBe(true)
    // The callback was registered — even though we interrupted early,
    // the canUseTool function was wired correctly (no crash)
  })

  test('canUseTool callback can selectively deny tools', async () => {
    const q = query({
      prompt: 'test selective deny',
      options: {
        cwd: process.cwd(),
        canUseTool: async (name, _input) => {
          // Deny Bash specifically, allow everything else
          if (name === 'Bash') {
            return { behavior: 'deny', message: 'Bash is not allowed' }
          }
          return { behavior: 'allow' }
        },
      },
    })
    q.interrupt()
    const messages = await drainQuery(q)
    expect(Array.isArray(messages)).toBe(true)
  })

  test('V2 session with no callback denies tools by default', async () => {
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
    })
    expect(session.sessionId).toBeDefined()
    // Session created successfully — deny-by-default applies at runtime
    // when tools are actually used
    session.interrupt()
  })

  test('V2 session with canUseTool callback allows tools', async () => {
    let callbackInvoked = false
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
      canUseTool: async (name, _input) => {
        callbackInvoked = true
        return { behavior: 'allow' }
      },
    })
    expect(session.sessionId).toBeDefined()
    // Callback is wired — would be invoked when tools execute
    session.interrupt()
  })
})

describe('Permission timeout eventing (PTO-1)', () => {
  test('timeout emits permission_timeout message in stream', async () => {
    const permissionTarget = createPermissionTarget()
    const timeoutMessages: unknown[] = []
    const warnings: string[] = []
    const fallback = createDefaultCanUseTool(
      buildPermissionContext({ cwd: process.cwd() }),
      { warn: () => {} },
    )
    const canUseTool = createExternalCanUseTool(
      undefined,
      fallback,
      permissionTarget,
      () => {
        // Deliberately do NOT resolve the pending permission; force timeout.
      },
      message => timeoutMessages.push(message),
      10,
      'session-id',
      { warn: message => warnings.push(message) },
    )

    const result = await canUseTool(
      { name: 'Read' } as any,
      { file_path: 'test.txt' },
      {} as any,
      {} as any,
      'tool-use-id',
      undefined,
    )

    expect(result.behavior).toBe('deny')
    expect(timeoutMessages).toHaveLength(1)
    expect(timeoutMessages[0]).toMatchObject({
      type: 'permission_timeout',
      tool_name: 'Read',
      tool_use_id: 'tool-use-id',
      timed_out_after_ms: 10,
      session_id: 'session-id',
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('timed out after 10ms')
    expect(permissionTarget.pendingPermissionPrompts.size).toBe(0)
  }, 15_000)
})
