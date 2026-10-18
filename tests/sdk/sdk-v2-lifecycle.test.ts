import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  createSdkMcpServer,
  tool,
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  unstable_v2_prompt,
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
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../src/test/sharedMutationLock.js'
import { clearAgentDefinitionsCache } from '../../src/tools/AgentTool/loadAgentsDir.js'
import type { SessionId } from '../../src/entrypoints/agentSdkTypes.js'
import {
  drainQuery,
  withTempDir,
  createSessionJsonl,
  createMinimalConversation,
  createMultiTurnConversation,
  isExpectedDrainAbort,
  UUID_REGEX,
} from './helpers/query-test-doubles.js'
import { MockQueryEngine } from './helpers/mock-engine.js'

// sendMessage drains trigger init(), which checks auth. Stub it for CI.
const AUTH_KEY = 'ANTHROPIC_API_KEY'
const DISABLE_BUILTIN_AGENTS_KEY = 'CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS'
let savedApiKey: string | undefined
let savedDisableBuiltinAgents: string | undefined
let hadSavedMacro = false
let savedMacro: unknown
let originalSessionId: SessionId
let originalSessionProjectDir: string | null
let originalCwd: string
let originalOriginalCwd: string

// Collect temp dirs for cleanup
const tempDirs: string[] = []

function attachMockEngine(session: unknown, mockEngine: MockQueryEngine): void {
  ;(session as { setEngine(engine: MockQueryEngine): void }).setEngine(mockEngine)
}

beforeAll(async () => {
  await acquireSharedMutationLock('sdk-v2-lifecycle')
  savedApiKey = process.env[AUTH_KEY]
  savedDisableBuiltinAgents = process.env[DISABLE_BUILTIN_AGENTS_KEY]
  hadSavedMacro = Object.hasOwn(globalThis, 'MACRO')
  savedMacro = (globalThis as Record<string, unknown>).MACRO
  if (!savedApiKey) process.env[AUTH_KEY] = 'sk-test-v2-lifecycle-stub'
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
    if (savedApiKey === undefined) delete process.env[AUTH_KEY]
    else process.env[AUTH_KEY] = savedApiKey
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

afterEach(() => {
  switchSession(originalSessionId, originalSessionProjectDir)
  setCwdState(originalCwd)
  setOriginalCwd(originalOriginalCwd)
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
  tempDirs.length = 0
})

beforeEach(() => {
  originalSessionId = getSessionId()
  originalSessionProjectDir = getSessionProjectDir()
  originalCwd = getCwdState()
  originalOriginalCwd = getOriginalCwd()
})

describe('V2: session creation', () => {
  test('lazy sendMessage iteration keeps each session scoped to its engine work', async () => {
    const globalId = getSessionId()
    let arrivals = 0
    let release!: () => void
    const bothStarted = new Promise<void>(resolve => { release = resolve })

    class ContextCapturingEngine extends MockQueryEngine {
      observedSessionId: SessionId | undefined

      override async *submitMessage(): AsyncGenerator<never, void, unknown> {
        arrivals += 1
        if (arrivals === 2) release()
        await bothStarted
        this.observedSessionId = getSessionId()
      }
    }

    const session1 = unstable_v2_createSession({ cwd: process.cwd() })
    const session2 = unstable_v2_createSession({ cwd: process.cwd() })
    try {
      const engine1 = new ContextCapturingEngine()
      const engine2 = new ContextCapturingEngine()
      attachMockEngine(session1, engine1)
      attachMockEngine(session2, engine2)

      const drain = async (messages: AsyncIterable<unknown>) => {
        for await (const _message of messages) {
          // The capturing engines intentionally yield no messages.
        }
      }
      await Promise.all([
        drain(session1.sendMessage('context-a')),
        drain(session2.sendMessage('context-b')),
      ])

      expect(engine1.observedSessionId).toBe(session1.sessionId)
      expect(engine2.observedSessionId).toBe(session2.sessionId)
      expect(engine1.observedSessionId).not.toBe(engine2.observedSessionId)
      expect(getSessionId()).toBe(globalId)
    } finally {
      session1.close()
      session2.close()
    }
  })

  test('createSession() returns SDKSession with valid sessionId', () => {
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
    })
    expect(session.sessionId).toBeDefined()
    expect(UUID_REGEX.test(session.sessionId)).toBe(true)
  })

  test('createSession().getMessages() returns empty array initially', () => {
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
    })
    const messages = session.getMessages()
    expect(Array.isArray(messages)).toBe(true)
    expect(messages.length).toBe(0)
  })

  test('createSession() with no cwd throws', () => {
    expect(() =>
      unstable_v2_createSession({} as any)
    ).toThrow()
  })

  test('createSession() with model option — session created without error', () => {
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
      model: 'claude-sonnet-4-6',
    })
    expect(session.sessionId).toBeDefined()
  })
})

describe('V2: session interrupt', () => {
  test('session.interrupt() does not throw', () => {
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
    })
    expect(() => session.interrupt()).not.toThrow()
  })

  test('session.close() aborts its wrapper controller after an engine override', () => {
    const abortController = new AbortController()
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
      abortController,
    })
    attachMockEngine(session, new MockQueryEngine())

    session.close()

    expect(abortController.signal.aborted).toBe(true)
  })

  test('session with external abortController — abort signal propagates', async () => {
    const ac = new AbortController()
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
      abortController: ac,
    })
    ac.abort()
    const messages: unknown[] = []
    let caught: unknown = null
    try {
      for await (const msg of session.sendMessage('test')) {
        messages.push(msg)
      }
    } catch (err) {
      caught = err
    }
    if (caught) {
      expect(isExpectedDrainAbort(caught)).toBe(true)
    } else {
      expect(messages.length).toBe(0)
    }
  }, 10_000)
})

describe('V2: session resume', () => {
  test('resumeSession() loads prior messages from JSONL', async () => {
    await withTempDir(async (dir) => {
      tempDirs.push(dir)
      const sid = randomUUID()
      const entries = createMinimalConversation(sid)
      createSessionJsonl(dir, sid, entries)

      const session = await unstable_v2_resumeSession(sid, { cwd: dir })
      expect(session.sessionId).toBe(sid)

      const messages = session.getMessages()
      expect(messages.length).toBeGreaterThanOrEqual(2)
    })
  })

  test('resumeSession() with invalid sessionId throws', async () => {
    await expect(
      unstable_v2_resumeSession('not-a-uuid', { cwd: process.cwd() })
    ).rejects.toThrow('Invalid session ID')
  })

  test('resumeSession() with non-existent session — creates session with empty messages', async () => {
    const fakeSid = randomUUID()
    const session = await unstable_v2_resumeSession(fakeSid, { cwd: process.cwd() })
    expect(session.sessionId).toBe(fakeSid)
    const messages = session.getMessages()
    expect(messages.length).toBe(0)
  })

  test('resumeSession() preserves multi-turn conversation order', async () => {
    await withTempDir(async (dir) => {
      tempDirs.push(dir)
      const sid = randomUUID()
      const entries = createMultiTurnConversation(sid, 3)
      createSessionJsonl(dir, sid, entries)

      const session = await unstable_v2_resumeSession(sid, { cwd: dir })
      const messages = session.getMessages()

      expect(messages.length).toBeGreaterThanOrEqual(6)
    })
  })

  test('resumeSession() sets sessionProjectDir via switchSession', async () => {
    await withTempDir(async (dir) => {
      tempDirs.push(dir)
      const sid = randomUUID()
      createSessionJsonl(dir, sid, createMinimalConversation(sid))

      await unstable_v2_resumeSession(sid, { cwd: dir })

      // Fix verification: resumeSession must call switchSession with the
      // resolved projectPath so that transcript writes go to the correct dir.
      const projectDir = getSessionProjectDir()
      expect(projectDir).not.toBeNull()
    })
  })
})

describe('V2: permission handling', () => {
  test('respondToPermission() with unknown toolUseId — no-op', () => {
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
    })
    expect(() =>
      session.respondToPermission('unknown-id', {
        behavior: 'allow',
      })
    ).not.toThrow()
  })

  test('createSession() with canUseTool callback — session created successfully', () => {
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
      canUseTool: async (name: string, _input: unknown) => ({
        behavior: 'deny' as const,
        message: `Tool ${name} denied by test`,
      }),
    })
    expect(session.sessionId).toBeDefined()
  })

  test('createSession() with onPermissionRequest callback — session created successfully', () => {
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
      onPermissionRequest: (_msg) => {
        // No-op — just verify it doesn't throw during construction
      },
    })
    expect(session.sessionId).toBeDefined()
  })
})

describe('V2: SDK agents', () => {
  test('createSession() injects SDK agents with maxSteps on first message', async () => {
    await withTempDir(async (dir) => {
      tempDirs.push(dir)
      const mockEngine = new MockQueryEngine()
      const session = unstable_v2_createSession({
        cwd: dir,
        agents: {
          helper: {
            prompt: 'Help with persistent SDK agent injection coverage',
            maxSteps: 2,
          },
        },
      })
      attachMockEngine(session, mockEngine)

      const messages: unknown[] = []
      for await (const msg of session.sendMessage('agent injection success')) {
        messages.push(msg)
      }

      expect(
        messages.some((message: any) => message?.type === 'assistant'),
      ).toBe(true)
      expect(
        mockEngine.config.agents.some(
          (agent: any) =>
            agent?.agentType === 'helper' &&
            agent?.whenToUse === 'helper' &&
            agent?.maxSteps === 2,
        ),
      ).toBe(true)

      const firstTurnAgents = [...mockEngine.config.agents]
      const secondTurnMessages: unknown[] = []
      for await (const msg of session.sendMessage('agent injection second turn')) {
        secondTurnMessages.push(msg)
      }
      expect(
        secondTurnMessages.some((message: any) => message?.type === 'assistant'),
      ).toBe(true)
      expect(mockEngine.config.agents.map((agent: any) => agent?.agentType)).toEqual(
        firstTurnAgents.map((agent: any) => agent?.agentType),
      )
      expect(
        mockEngine.config.agents.filter(
          (agent: any) => agent?.agentType === 'helper',
        ),
      ).toHaveLength(1)
    })
  })

  test('createSession() filters denied SDK MCP tools on every turn', async () => {
    await withTempDir(async (dir) => {
      tempDirs.push(dir)
      const mockEngine = new MockQueryEngine()
      const deniedBash = tool(
        'Bash',
        'Denied persistent SDK MCP Bash duplicate',
        { type: 'object', properties: {} },
        async () => ({ content: [{ type: 'text', text: 'denied' }] }),
      )
      const allowedSdkTool = tool(
        'sdkAllowed',
        'Allowed persistent SDK MCP tool',
        { type: 'object', properties: {} },
        async () => ({ content: [{ type: 'text', text: 'allowed' }] }),
      )
      const session = unstable_v2_createSession({
        cwd: dir,
        disallowedTools: ['Bash'],
        mcpServers: {
          'sdk-tools': createSdkMcpServer({
            type: 'sdk',
            name: 'sdk-tools',
            tools: [deniedBash, allowedSdkTool],
          }),
        },
      })
      const initialTools =
        (session as unknown as { _engine: { config: { tools: unknown[] } } })
          ._engine.config.tools
      const initialToolNames = initialTools.map((entry: any) => entry?.name)
      expect(initialToolNames.length).toBeGreaterThan(0)
      expect(initialToolNames).not.toContain('Bash')
      mockEngine.config.tools = [...initialTools]
      attachMockEngine(session, mockEngine)

      const firstTurnMessages: unknown[] = []
      for await (const msg of session.sendMessage('mcp deny filtering')) {
        firstTurnMessages.push(msg)
      }
      const firstTurnToolNames = mockEngine.config.tools.map(
        (entry: any) => entry?.name,
      )
      for (const initialToolName of initialToolNames) {
        expect(firstTurnToolNames).toContain(initialToolName)
      }
      expect(firstTurnToolNames).toContain('sdkAllowed')
      expect(firstTurnToolNames).not.toContain('Bash')
      expect(
        firstTurnMessages.some((message: any) => message?.type === 'assistant'),
      ).toBe(true)

      const secondTurnMessages: unknown[] = []
      for await (const msg of session.sendMessage('mcp deny filtering second turn')) {
        secondTurnMessages.push(msg)
      }
      const secondTurnToolNames = mockEngine.config.tools.map(
        (entry: any) => entry?.name,
      )
      expect(secondTurnToolNames).toEqual(firstTurnToolNames)
      expect(secondTurnToolNames).toContain('sdkAllowed')
      expect(secondTurnToolNames).not.toContain('Bash')
      expect(
        secondTurnMessages.some((message: any) => message?.type === 'assistant'),
      ).toBe(true)
    })
  })

  test('createSession() merges filesystem and SDK agents before injection', async () => {
    await withTempDir(async (dir) => {
      tempDirs.push(dir)
      const agentsDir = join(dir, '.openclaude', 'agents')
      mkdirSync(agentsDir, { recursive: true })
      writeFileSync(
        join(agentsDir, 'filesystem.md'),
        [
          '---',
          'name: filesystem',
          'description: Use for filesystem agent merge coverage',
          '---',
          'Filesystem agent prompt',
        ].join('\n'),
      )

      const mockEngine = new MockQueryEngine()
      const session = unstable_v2_createSession({
        cwd: dir,
        agents: {
          helper: {
            description: 'Use for persistent SDK agent merge coverage',
            prompt: 'Help with persistent SDK agent merge coverage',
            maxSteps: 2,
          },
        },
      })
      attachMockEngine(session, mockEngine)

      const messages: unknown[] = []
      for await (const msg of session.sendMessage('agent merge success')) {
        messages.push(msg)
      }

      expect(messages.some((message: any) => message?.type === 'assistant')).toBe(
        true,
      )
      const agentTypes = mockEngine.config.agents.map(
        (agent: any) => agent?.agentType,
      )
      expect(agentTypes).toContain('filesystem')
      expect(agentTypes).toContain('helper')

      const secondTurnMessages: unknown[] = []
      for await (const msg of session.sendMessage('agent merge second turn')) {
        secondTurnMessages.push(msg)
      }
      const secondTurnAgentTypes = mockEngine.config.agents.map(
        (agent: any) => agent?.agentType,
      )
      expect(
        secondTurnMessages.some((message: any) => message?.type === 'assistant'),
      ).toBe(true)
      expect(secondTurnAgentTypes).toEqual(agentTypes)
      expect(
        secondTurnAgentTypes.filter(agentType => agentType === 'filesystem'),
      ).toHaveLength(1)
      expect(secondTurnAgentTypes.filter(agentType => agentType === 'helper')).toHaveLength(1)
    })
  })

  test('createSession() lets SDK agents override filesystem agents with the same name', async () => {
    await withTempDir(async (dir) => {
      tempDirs.push(dir)
      const agentsDir = join(dir, '.openclaude', 'agents')
      mkdirSync(agentsDir, { recursive: true })
      writeFileSync(
        join(agentsDir, 'helper.md'),
        [
          '---',
          'name: helper',
          'description: Use for filesystem collision coverage',
          '---',
          'Filesystem helper prompt',
        ].join('\n'),
      )

      const mockEngine = new MockQueryEngine()
      const session = unstable_v2_createSession({
        cwd: dir,
        agents: {
          helper: {
            description: 'Use for SDK collision coverage',
            prompt: 'SDK helper prompt',
            maxSteps: 2,
          },
        },
      })
      attachMockEngine(session, mockEngine)

      const messages: unknown[] = []
      for await (const msg of session.sendMessage('agent collision success')) {
        messages.push(msg)
      }

      const helperAgents = mockEngine.config.agents.filter(
        (agent: any) => agent?.agentType === 'helper',
      )
      expect(messages.some((message: any) => message?.type === 'assistant')).toBe(
        true,
      )
      expect(helperAgents).toHaveLength(1)
      expect((helperAgents[0] as any).getSystemPrompt()).toBe(
        'SDK helper prompt',
      )
      expect((helperAgents[0] as any).maxSteps).toBe(2)

      const secondTurnMessages: unknown[] = []
      for await (const msg of session.sendMessage('agent collision second turn')) {
        secondTurnMessages.push(msg)
      }
      const secondTurnHelpers = mockEngine.config.agents.filter(
        (agent: any) => agent?.agentType === 'helper',
      )
      expect(
        secondTurnMessages.some((message: any) => message?.type === 'assistant'),
      ).toBe(true)
      expect(secondTurnHelpers).toHaveLength(1)
      expect((secondTurnHelpers[0] as any).getSystemPrompt()).toBe(
        'SDK helper prompt',
      )
      expect((secondTurnHelpers[0] as any).maxSteps).toBe(2)
    })
  })

  test('createSession() emits invalid SDK agent failures before engine output', async () => {
    await withTempDir(async (dir) => {
      tempDirs.push(dir)
      const mockEngine = new MockQueryEngine()
      const session = unstable_v2_createSession({
        cwd: dir,
        agents: {
          broken: {
            description: 'Use for broken persistent SDK agent coverage',
            prompt: 2 as unknown as string,
          },
          badLimit: {
            description: 'Use for invalid persistent SDK agent step limit coverage',
            prompt: 'bad limit prompt',
            maxSteps: 0,
          },
        },
      })
      attachMockEngine(session, mockEngine)

      const messages: any[] = []
      for await (const msg of session.sendMessage('agent failure visibility')) {
        messages.push(msg)
      }

      expect(messages[0]).toMatchObject({
        type: 'agent_load_failure',
        stage: 'injection',
      })
      expect(messages[0].error_message).toContain("Invalid SDK agent 'broken'")
      const loadFailures = messages.filter(
        message => message?.type === 'agent_load_failure',
      )
      expect(loadFailures).toHaveLength(2)
      expect(loadFailures[1].error_message).toContain(
        "Invalid SDK agent 'badLimit'",
      )
      expect(loadFailures[1].error_message).toContain('maxSteps')
      const assistantIndex = messages.findIndex(
        message => message?.type === 'assistant',
      )
      expect(assistantIndex).toBeGreaterThan(1)
      expect(
        loadFailures.every(failure => messages.indexOf(failure) < assistantIndex),
      ).toBe(true)
      expect(messages.some(message => message?.type === 'assistant')).toBe(true)
      expect(
        mockEngine.config.agents.some(
          (agent: any) => agent?.agentType === 'broken',
        ),
      ).toBe(false)
      expect(
        mockEngine.config.agents.some(
          (agent: any) => agent?.agentType === 'badLimit',
        ),
      ).toBe(false)

      const secondTurnMessages: any[] = []
      for await (const msg of session.sendMessage('agent failure second turn')) {
        secondTurnMessages.push(msg)
      }

      expect(
        secondTurnMessages.some(
          message => message?.type === 'agent_load_failure',
        ),
      ).toBe(false)
      expect(secondTurnMessages.some(message => message?.type === 'assistant')).toBe(
        true,
      )
    })
  })

  test('createSession() emits filesystem agent parse failures before engine output', async () => {
    await withTempDir(async (dir) => {
      tempDirs.push(dir)
      const agentsDir = join(dir, '.openclaude', 'agents')
      mkdirSync(agentsDir, { recursive: true })
      writeFileSync(
        join(agentsDir, 'broken.md'),
        [
          '---',
          'name: broken',
          '---',
          'Broken filesystem agent prompt',
        ].join('\n'),
      )

      const mockEngine = new MockQueryEngine()
      const session = unstable_v2_createSession({ cwd: dir })
      attachMockEngine(session, mockEngine)

      const messages: any[] = []
      for await (const msg of session.sendMessage('agent parse failure visibility')) {
        messages.push(msg)
      }

      expect(messages[0]).toMatchObject({
        type: 'agent_load_failure',
        stage: 'definitions',
      })
      expect(messages[0].error_message).toContain('broken.md')
      expect(messages[0].error_message).toContain(
        'Missing required "description" field',
      )
      expect(messages.some(message => message?.type === 'assistant')).toBe(true)

      const secondTurnMessages: any[] = []
      for await (const msg of session.sendMessage('agent parse second turn')) {
        secondTurnMessages.push(msg)
      }

      expect(
        secondTurnMessages.some(
          message => message?.type === 'agent_load_failure',
        ),
      ).toBe(false)
      expect(secondTurnMessages.some(message => message?.type === 'assistant')).toBe(
        true,
      )
    })
  })
})

describe('V2: unstable_v2_prompt', () => {
  test('throws when query completes without a result message (aborted)', async () => {
    const ac = new AbortController()
    // Abort immediately so the query never produces a result
    ac.abort()

    await expect(
      unstable_v2_prompt('test', {
        cwd: process.cwd(),
        abortController: ac,
      }),
    ).rejects.toThrow()
  })

  test('throws when cwd is missing', () => {
    expect(() =>
      unstable_v2_prompt('test', {} as any),
    ).toThrow()
  })
})

describe('E2E: transcript placement — resume sets project dir and resolve still finds file', () => {
  test('resumeSession sets projectDir so resolveSessionFilePath finds the file', async () => {
    await withTempDir(async (dir) => {
      tempDirs.push(dir)
      const sid = randomUUID()
      createSessionJsonl(dir, sid, createMinimalConversation(sid))

      // Before resume: file exists on disk
      const { resolveSessionFilePath } = await import('../../src/utils/sessionStoragePortable.js')
      const before = await resolveSessionFilePath(sid, dir)
      expect(before).toBeDefined()
      expect(before!.filePath).toContain(sid)

      // Resume the session — this should call switchSession internally
      const session = await unstable_v2_resumeSession(sid, { cwd: dir })

      // Verify session is usable
      expect(session.sessionId).toBe(sid)
      const messages = session.getMessages()
      expect(messages.length).toBeGreaterThanOrEqual(2)

      // Verify project dir was set by switchSession
      const projectDir = getSessionProjectDir()
      expect(projectDir).not.toBeNull()

      // Verify resolveSessionFilePath still finds the file at the same path
      const after = await resolveSessionFilePath(sid, dir)
      expect(after).toBeDefined()
      expect(after!.filePath).toBe(before!.filePath)
    })
  })
})
