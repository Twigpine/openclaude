import { queryInternals } from './helpers/query-test-doubles.js'
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { query } from '../../src/entrypoints/sdk/index.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../src/test/sharedMutationLock.js'

// These tests don't iterate — they test QueryImpl methods that manipulate
// internal state. Auth stub needed because query() triggers init() path.
const AUTH_KEY = 'ANTHROPIC_API_KEY'
let savedApiKey: string | undefined

beforeAll(async () => {
  await acquireSharedMutationLock('tests/sdk/query-methods.test.ts')
  savedApiKey = process.env[AUTH_KEY]
  if (!savedApiKey) process.env[AUTH_KEY] = 'sk-test-query-methods-stub'
})

afterAll(() => {
  try {
    if (savedApiKey === undefined) delete process.env[AUTH_KEY]
    else process.env[AUTH_KEY] = savedApiKey
  } finally {
    releaseSharedMutationLock()
  }
})

describe('QueryImpl.setModel', () => {
  test('updates model in app state', async () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })
    await q.setModel('claude-haiku-4-5')

    const state = queryInternals(q).appStateStore.getState()
    expect(state.mainLoopModel).toBe('claude-haiku-4-5')
    expect(state.mainLoopModelForSession).toBe('claude-haiku-4-5')
    q.interrupt()
  })
})

describe('QueryImpl.supportedAgents', () => {
  test('returns agentType list from active agents', () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })

    // Simulate agents loaded into app state
    ;queryInternals(q).appStateStore.setState(() => ({
      ...queryInternals(q).appStateStore.getState(),
      agentDefinitions: ({
        activeAgents: [
          { agentType: 'code-reviewer' },
          { agentType: 'test-runner' },
        ],
      } as unknown as import("../../src/state/AppStateStore.js").AppState["agentDefinitions"]),
    }))

    const agents = q.supportedAgents()
    expect(agents).toEqual(['code-reviewer', 'test-runner'])
    q.interrupt()
  })

  test('returns empty array when no agents loaded', () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })
    const agents = q.supportedAgents()
    expect(agents).toEqual([])
    q.interrupt()
  })

  test('filters out entries with falsy agentType', () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })

    ;queryInternals(q).appStateStore.setState(() => ({
      ...queryInternals(q).appStateStore.getState(),
      agentDefinitions: ({
        activeAgents: [
          { agentType: 'valid-agent' },
          { agentType: null },
          { agentType: '' },
        ],
      } as unknown as import("../../src/state/AppStateStore.js").AppState["agentDefinitions"]),
    }))

    const agents = q.supportedAgents()
    expect(agents).toEqual(['valid-agent'])
    q.interrupt()
  })
})

describe('QueryImpl.supportedCommands', () => {
  test('returns command names from app state', () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })

    ;queryInternals(q).appStateStore.setState(() => ({
      ...queryInternals(q).appStateStore.getState(),
      mcp: {
        ...queryInternals(q).appStateStore.getState().mcp,
        commands: ([
          { name: '/help' },
          { name: '/clear' },
        ] as unknown as import("../../src/commands.js").Command[]),
      },
    }))

    const cmds = q.supportedCommands()
    expect(cmds).toEqual(['/help', '/clear'])
    q.interrupt()
  })

  test('returns empty array when no commands', () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })
    const cmds = q.supportedCommands()
    expect(cmds).toEqual([])
    q.interrupt()
  })
})

describe('QueryImpl.supportedModels', () => {
  test('returns current model as array', () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })

    ;queryInternals(q).appStateStore.setState(() => ({
      ...queryInternals(q).appStateStore.getState(),
      mainLoopModel: 'claude-sonnet-4-6',
    }))

    const models = q.supportedModels()
    expect(models).toEqual(['claude-sonnet-4-6'])
    q.interrupt()
  })

  test('returns empty array when no model set', () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })

    ;queryInternals(q).appStateStore.setState(() => ({
      ...queryInternals(q).appStateStore.getState(),
      mainLoopModel: (undefined as unknown as import("../../src/state/AppStateStore.js").AppState["mainLoopModel"]),
    }))

    const models = q.supportedModels()
    expect(models).toEqual([])
    q.interrupt()
  })
})

describe('QueryImpl.setMaxThinkingTokens', () => {
  test('enables thinking with budget', () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })
    q.setMaxThinkingTokens(10000)

    const state = queryInternals(q).appStateStore.getState()
    expect(state.thinkingEnabled).toBe(true)
    expect(state.thinkingBudgetTokens).toBe(10000)
    q.interrupt()
  })

  test('disables thinking when tokens is 0', () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })
    // First enable
    q.setMaxThinkingTokens(5000)
    // Then disable
    q.setMaxThinkingTokens(0)

    const state = queryInternals(q).appStateStore.getState()
    expect(state.thinkingEnabled).toBe(false)
    expect(state.thinkingBudgetTokens).toBeUndefined()
    q.interrupt()
  })
})

describe('QueryImpl.respondToPermission', () => {
  test('resolves pending allow decision', async () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })

    const promise = queryInternals(q).registerPendingPermission('tool-123')
    q.respondToPermission('tool-123', { behavior: 'allow' })

    const decision = await promise
    expect(decision.behavior).toBe('allow')
    q.interrupt()
  })

  test('resolves pending deny decision with message', async () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })

    const promise = queryInternals(q).registerPendingPermission('tool-456')
    q.respondToPermission('tool-456', {
      behavior: 'deny',
      message: 'Blocked by policy',
    })

    const decision = await promise
    expect(decision.behavior).toBe('deny')
    expect('message' in decision ? decision.message : undefined).toBe('Blocked by policy')
    q.interrupt()
  })

  test('deny with no message uses default', async () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })

    const promise = queryInternals(q).registerPendingPermission('tool-789')
    q.respondToPermission('tool-789', { behavior: 'deny' })

    const decision = await promise
    expect(decision.behavior).toBe('deny')
    expect('message' in decision ? decision.message : undefined).toBe('Permission denied')
    q.interrupt()
  })

  test('no-op for unknown toolUseId', () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })
    // Should not throw
    expect(() =>
      q.respondToPermission('nonexistent', { behavior: 'allow' })
    ).not.toThrow()
    q.interrupt()
  })

  test('allow with updatedInput passes through', async () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })

    const promise = queryInternals(q).registerPendingPermission('tool-input')
    q.respondToPermission('tool-input', {
      behavior: 'allow',
      updatedInput: { path: '/safe/dir' },
    })

    const decision = await promise
    expect(decision.behavior).toBe('allow')
    expect('updatedInput' in decision ? decision.updatedInput : undefined).toEqual({ path: '/safe/dir' })
    q.interrupt()
  })
})

describe('QueryImpl.rewindFiles', () => {
  test('returns canRewind false when no file history', async () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })
    const result = await q.rewindFiles()
    expect(result.canRewind).toBe(false)
    q.interrupt()
  })
})

// setPermissionMode is tested via buildPermissionContext in permissions.test.ts
// (mode mapping, additionalDirectories, bypass flag). The QueryImpl.setPermissionMode
// method delegates to buildPermissionContext + getTools + engine.updateTools — the
// latter two depend on CI environment state, so integration tests are fragile.
