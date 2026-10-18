import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { z } from 'zod/v4'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import { createToolFixture } from '../../test/toolFixtures.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { PermissionRequestResult } from '../../types/hooks.js'
import {
  __getInterruptionTraceSnapshotForTests,
  __resetInterruptionTraceForTests,
  __waitForInterruptionTraceFlushForTests,
} from '../interruptionTrace.js'
import { permissionPromptToolResultToPermissionDecision } from './PermissionPromptToolResultSchema.js'

type HookDecision = PermissionRequestResult

let hookDecision: HookDecision
let hasPermissionsToUseTool: typeof import('./permissions.js').hasPermissionsToUseTool
let createPermissionContext: typeof import('../../hooks/toolPermission/PermissionContext.js').createPermissionContext
let StructuredIO: typeof import('../../cli/structuredIO.js').StructuredIO
let actualHooks: typeof import('../hooks.js')
let beforeHookDecision: (() => void) | undefined
const originalInterruptionTrace = process.env.OPENCLAUDE_INTERRUPT_TRACE

beforeAll(async () => {
  await acquireSharedMutationLock(
    'utils/permissions/permissions.headlessPlanHooks.test.ts',
  )
  actualHooks = await import(
    `../hooks.ts?headlessPlanHooksActual=${Date.now()}-${Math.random()}`
  )
  mock.module('../hooks.js', () => ({
    ...actualHooks,
    async *executePermissionRequestHooks() {
      beforeHookDecision?.()
      yield { permissionRequestResult: hookDecision }
    },
  }))
  ;({ hasPermissionsToUseTool } = await import(
    `./permissions.ts?headlessPlanHooks=${Date.now()}-${Math.random()}`
  ))
  ;({ createPermissionContext } = await import(
    `../../hooks/toolPermission/PermissionContext.ts?headlessPlanHooks=${Date.now()}-${Math.random()}`
  ))
  ;({ StructuredIO } = await import(
    `../../cli/structuredIO.ts?headlessPlanHooks=${Date.now()}-${Math.random()}`
  ))
})

afterAll(() => {
  try {
    mock.restore()
    mock.module('../hooks.js', () => actualHooks)
  } finally {
    releaseSharedMutationLock()
  }
})

afterEach(async () => {
  await __waitForInterruptionTraceFlushForTests()
  __resetInterruptionTraceForTests()
  if (originalInterruptionTrace === undefined) {
    delete process.env.OPENCLAUDE_INTERRUPT_TRACE
  } else {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = originalInterruptionTrace
  }
})

function planContext(
  overrides: Partial<ToolPermissionContext> = {},
): {
  context: ToolUseContext
  getPermissionContext: () => ToolPermissionContext
  setPermissionContext: (context: ToolPermissionContext) => void
} {
  let toolPermissionContext: ToolPermissionContext = {
    mode: 'plan',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: true,
    shouldAvoidPermissionPrompts: true,
    ...overrides,
  }
  const context = {
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext }),
    setAppState: (
      update: (state: { toolPermissionContext: ToolPermissionContext }) => {
        toolPermissionContext: ToolPermissionContext
      },
    ) => {
      toolPermissionContext = update({ toolPermissionContext })
        .toolPermissionContext
    },
    options: {},
  } as unknown as ToolUseContext
  return {
    context,
    getPermissionContext: () => toolPermissionContext,
    setPermissionContext: nextContext => {
      toolPermissionContext = nextContext
    },
  }
}

const assistantMessage = {} as Parameters<
  typeof import('./permissions.js').hasPermissionsToUseTool
>[3]

describe('headless plan-mode PermissionRequest hooks', () => {
  test('agent permission updates persist against untransformed root state', async () => {
    const readTool = createToolFixture(z.object({}), {
      name: 'AgentPersistentReadTool',
      isReadOnly: () => true,
    })
    const rootPermissionContext: ToolPermissionContext = {
      mode: 'default',
      additionalWorkingDirectories: new Map(),
      alwaysAllowRules: {
        session: ['ExistingRootTool'],
      },
      alwaysDenyRules: {},
      alwaysAskRules: {},
      isBypassPermissionsModeAvailable: true,
    }
    const childPermissionContext: ToolPermissionContext = {
      ...rootPermissionContext,
      mode: 'plan',
      alwaysAllowRules: {
        session: ['ChildScopedTool'],
      },
      shouldAvoidPermissionPrompts: false,
      awaitAutomatedChecksBeforeDialog: true,
    }
    let persistedContext: ToolPermissionContext | undefined
    const context = {
      abortController: new AbortController(),
      getAppState: () => ({ toolPermissionContext: childPermissionContext }),
      getRootAppState: () => ({
        toolPermissionContext: rootPermissionContext,
      }),
      options: {},
    } as unknown as ToolUseContext
    const permissionContext = createPermissionContext(
      readTool,
      {},
      context,
      { message: { id: 'assistant-message' } } as never,
      'agent-root-permission-persistence',
      nextContext => {
        persistedContext = nextContext
      },
    )

    await permissionContext.persistPermissions([
      {
        type: 'addRules',
        rules: [{ toolName: 'ApprovedFromAgent' }],
        behavior: 'allow',
        destination: 'session',
      },
    ])

    expect(persistedContext?.mode).toBe('default')
    expect(persistedContext?.shouldAvoidPermissionPrompts).toBeUndefined()
    expect(persistedContext?.awaitAutomatedChecksBeforeDialog).toBeUndefined()
    expect(persistedContext?.alwaysAllowRules.session).toEqual([
      'ExistingRootTool',
      'ApprovedFromAgent',
    ])
  })

  test('agent setMode cannot enable bypass when root availability is disabled', async () => {
    const readTool = createToolFixture(z.object({}), {
      name: 'AgentRootBypassAvailabilityReadTool',
      isReadOnly: () => true,
    })
    const rootPermissionContext: ToolPermissionContext = {
      mode: 'default',
      additionalWorkingDirectories: new Map(),
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      alwaysAskRules: {},
      isBypassPermissionsModeAvailable: false,
    }
    const childPermissionContext: ToolPermissionContext = {
      ...rootPermissionContext,
      isBypassPermissionsModeAvailable: true,
    }
    let persistedContext: ToolPermissionContext | undefined
    const context = {
      abortController: new AbortController(),
      getAppState: () => ({ toolPermissionContext: childPermissionContext }),
      getRootAppState: () => ({
        toolPermissionContext: rootPermissionContext,
      }),
      options: {},
    } as unknown as ToolUseContext
    const permissionContext = createPermissionContext(
      readTool,
      {},
      context,
      { message: { id: 'assistant-message' } } as never,
      'agent-root-bypass-availability',
      nextContext => {
        persistedContext = nextContext
      },
    )

    const persisted = await permissionContext.persistPermissions([
      {
        type: 'setMode',
        mode: 'fullAccess',
        destination: 'session',
      },
      {
        type: 'setMode',
        mode: 'bypassPermissions',
        destination: 'session',
      },
    ])

    expect(persisted).toBe(false)
    expect(persistedContext).toBeUndefined()
  })

  test('agent permission updates cannot escape root plan mode', async () => {
    const readTool = createToolFixture(z.object({}), {
      name: 'AgentRootPlanReadTool',
      isReadOnly: () => true,
    })
    const rootPermissionContext: ToolPermissionContext = {
      mode: 'plan',
      additionalWorkingDirectories: new Map(),
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      alwaysAskRules: {},
      isBypassPermissionsModeAvailable: true,
    }
    const childPermissionContext: ToolPermissionContext = {
      ...rootPermissionContext,
      mode: 'acceptEdits',
    }
    let persistedContext: ToolPermissionContext | undefined
    const context = {
      abortController: new AbortController(),
      getAppState: () => ({ toolPermissionContext: childPermissionContext }),
      getRootAppState: () => ({ toolPermissionContext: rootPermissionContext }),
      options: {},
    } as unknown as ToolUseContext
    const permissionContext = createPermissionContext(
      readTool,
      {},
      context,
      { message: { id: 'assistant-message' } } as never,
      'agent-root-plan-permission-persistence',
      nextContext => {
        persistedContext = nextContext
      },
    )

    const result = await permissionContext.handleUserAllow({}, [
      {
        type: 'addRules',
        rules: [{ toolName: 'ApprovedFromAgent' }],
        behavior: 'allow',
        destination: 'session',
      },
    ])

    expect(result.behavior).toBe('allow')
    expect(persistedContext).toBeUndefined()
  })

  test('agent mutation approval respects root plan mode', async () => {
    const mutationTool = createToolFixture(z.object({}), {
      name: 'AgentRootPlanMutationTool',
      isReadOnly: () => false,
    })
    const state = planContext({ mode: 'acceptEdits' })
    state.context.getRootAppState = () => ({
      toolPermissionContext: {
        ...state.getPermissionContext(),
        mode: 'plan',
      },
    }) as never
    const permissionContext = createPermissionContext(
      mutationTool,
      {},
      state.context,
      { message: { id: 'assistant-message' } } as never,
      'agent-root-plan-mutation',
      state.setPermissionContext,
    )

    const result = await permissionContext.handleUserAllow({}, [])

    expect(result).toMatchObject({
      behavior: 'deny',
      decisionReason: { type: 'mode', mode: 'plan' },
    })
  })

  test('interactive user approval cannot rewrite a read into a mutation', async () => {
    const conditionalTool = createToolFixture(
      z.object({ operation: z.enum(['read', 'write']) }),
      {
        name: 'InteractiveUserConditionalTool',
        isReadOnly: input => input.operation === 'read',
      },
    )
    const state = planContext()
    const permissionContext = createPermissionContext(
      conditionalTool,
      { operation: 'read' },
      state.context,
      { message: { id: 'assistant-message' } } as never,
      'interactive-user-input-rewrite',
      state.setPermissionContext,
    )

    const result = await permissionContext.handleUserAllow(
      { operation: 'write' },
      [],
    )

    expect(result).toMatchObject({
      behavior: 'deny',
      decisionReason: { type: 'mode', mode: 'plan' },
    })
  })

  test('interactive user approval cannot persist permission updates in plan mode', async () => {
    const readTool = createToolFixture(z.object({}), {
      name: 'InteractiveUserReadTool',
      isReadOnly: () => true,
    })
    const state = planContext()
    const permissionContext = createPermissionContext(
      readTool,
      {},
      state.context,
      { message: { id: 'assistant-message' } } as never,
      'interactive-user-mode-update',
      state.setPermissionContext,
    )

    const result = await permissionContext.handleUserAllow({}, [
      { type: 'setMode', mode: 'fullAccess', destination: 'session' },
    ])

    expect(result.behavior).toBe('allow')
    expect(state.getPermissionContext().mode).toBe('plan')
  })

  test('interactive classifier approval is denied when plan mode starts during revalidation', async () => {
    const mutationTool = createToolFixture(z.object({}), {
      name: 'InteractiveClassifierMutationTool',
      isReadOnly: () => false,
    })
    const state = planContext({ mode: 'default' })
    const permissionContext = createPermissionContext(
      mutationTool,
      {},
      state.context,
      { message: { id: 'assistant-message' } } as never,
      'interactive-classifier-enter-plan-mode',
      state.setPermissionContext,
    )
    queueMicrotask(() => {
      state.setPermissionContext({
        ...state.getPermissionContext(),
        mode: 'plan',
      })
    })

    const result = await permissionContext.handleClassifierAllow(
      {},
      {
        type: 'classifier',
        classifier: 'bash_allow',
        reason: 'Allowed by classifier',
      },
    )

    expect(result).toMatchObject({
      behavior: 'deny',
      decisionReason: { type: 'mode', mode: 'plan' },
    })
  })

  test('interactive user approval is denied when plan mode starts at the final validation boundary', async () => {
    const mutationTool = createToolFixture(z.object({}), {
      name: 'InteractiveUserFinalValidationMutationTool',
      isReadOnly: () => false,
    })
    const state = planContext({ mode: 'default' })
    const getAppState = state.context.getAppState.bind(state.context)
    let appStateReads = 0
    state.context.getAppState = () => {
      appStateReads += 1
      const appState = getAppState()
      if (appStateReads === 3) {
        queueMicrotask(() => {
          state.setPermissionContext({
            ...state.getPermissionContext(),
            mode: 'plan',
          })
        })
      }
      return appState
    }
    const permissionContext = createPermissionContext(
      mutationTool,
      {},
      state.context,
      { message: { id: 'assistant-message' } } as never,
      'interactive-user-final-validation-enter-plan-mode',
      state.setPermissionContext,
    )

    const result = await permissionContext.handleUserAllow({}, [])

    expect(result).toMatchObject({
      behavior: 'deny',
      decisionReason: { type: 'mode', mode: 'plan' },
    })
  })

  test('interactive user approval preserves an explicit deny on rewritten input', async () => {
    const tool = createToolFixture(
      z.object({ target: z.enum(['review', 'restricted']) }),
      {
        name: 'InteractiveUserDenyTool',
        isReadOnly: () => true,
        async checkPermissions(input) {
          return input.target === 'restricted'
            ? {
                behavior: 'deny' as const,
                message: 'Restricted target',
                decisionReason: {
                  type: 'other' as const,
                  reason: 'Restricted target',
                },
              }
            : { behavior: 'ask' as const, message: 'Review target' }
        },
      },
    )
    const state = planContext()
    const permissionContext = createPermissionContext(
      tool,
      { target: 'review' },
      state.context,
      { message: { id: 'assistant-message' } } as never,
      'interactive-user-deny-rewrite',
      state.setPermissionContext,
    )

    const result = await permissionContext.handleUserAllow(
      { target: 'restricted' },
      [],
    )

    expect(result).toMatchObject({
      behavior: 'deny',
      message: 'Restricted target',
    })
  })

  test('interactive user approval preserves a changed ask constraint', async () => {
    const tool = createToolFixture(
      z.object({ target: z.enum(['review', 'sensitive']) }),
      {
        name: 'InteractiveUserAskTool',
        isReadOnly: () => true,
        async checkPermissions(input) {
          return {
            behavior: 'ask' as const,
            message: `Approval required for ${input.target}`,
            decisionReason: {
              type: 'rule' as const,
              rule: {
                source: 'session' as const,
                ruleBehavior: 'ask' as const,
                ruleValue: {
                  toolName: 'InteractiveUserAskTool',
                  ruleContent: input.target,
                },
              },
            },
          }
        },
      },
    )
    const state = planContext()
    const permissionContext = createPermissionContext(
      tool,
      { target: 'review' },
      state.context,
      { message: { id: 'assistant-message' } } as never,
      'interactive-user-ask-rewrite',
      state.setPermissionContext,
    )

    const result = await permissionContext.handleUserAllow(
      { target: 'sensitive' },
      [],
    )

    expect(result).toMatchObject({
      behavior: 'ask',
      message: 'Approval required for sensitive',
    })
  })

  test('SDK permission prompt approval rechecks rewritten input and drops plan-mode updates', async () => {
    const conditionalTool = createToolFixture(
      z.object({ operation: z.enum(['read', 'write']) }),
      {
        name: 'SDKPromptConditionalTool',
        isReadOnly: input => input.operation === 'read',
      },
    )
    const state = planContext()

    const result = await permissionPromptToolResultToPermissionDecision(
      {
        behavior: 'allow',
        updatedInput: { operation: 'write' },
        updatedPermissions: [
          { type: 'setMode', mode: 'fullAccess', destination: 'session' },
        ],
      },
      conditionalTool,
      { operation: 'read' },
      state.context,
    )

    expect(result).toMatchObject({
      behavior: 'deny',
      decisionReason: { type: 'mode', mode: 'plan' },
    })
    expect(state.getPermissionContext().mode).toBe('plan')
  })

  test('SDK permission prompt keeps a read-only approval but drops plan-mode updates', async () => {
    const readTool = createToolFixture(z.object({}), {
      name: 'SDKPromptReadTool',
      isReadOnly: () => true,
    })
    const state = planContext()

    const result = await permissionPromptToolResultToPermissionDecision(
      {
        behavior: 'allow',
        updatedInput: {},
        updatedPermissions: [
          { type: 'setMode', mode: 'fullAccess', destination: 'session' },
        ],
      },
      readTool,
      {},
      state.context,
    )

    expect(result).toMatchObject({ behavior: 'allow', updatedInput: {} })
    expect(result).not.toHaveProperty('updatedPermissions')
    expect(state.getPermissionContext().mode).toBe('plan')
  })

  test('labels SDK permission prompt interrupts as query-root aborts', async () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    __resetInterruptionTraceForTests()
    const tool = createToolFixture(z.object({}), {
      name: 'SDKPromptInterruptTool',
      isReadOnly: () => true,
    })
    const state = planContext({ mode: 'default' })

    const result = await permissionPromptToolResultToPermissionDecision(
      {
        behavior: 'deny',
        message: 'Stop the query',
        interrupt: true,
      },
      tool,
      {},
      state.context,
    )

    expect(result.behavior).toBe('deny')
    expect(state.context.abortController.signal.aborted).toBe(true)
    expect(
      __getInterruptionTraceSnapshotForTests().find(
        entry =>
          entry.event === 'abort.requested' &&
          entry.source === 'sdk_permission_interrupt',
      ),
    ).toMatchObject({
      subsystem: 'tool_permission',
      controllerRole: 'query-root',
    })
  })

  test('labels headless permission hook interrupts as query-root aborts', async () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    __resetInterruptionTraceForTests()
    const tool = createToolFixture(z.object({}), {
      name: 'HeadlessHookInterruptTool',
      isReadOnly: () => true,
      async checkPermissions() {
        return { behavior: 'ask' as const, message: 'Review read' }
      },
    })
    const state = planContext({
      mode: 'default',
      shouldAvoidPermissionPrompts: true,
    })
    hookDecision = {
      behavior: 'deny',
      message: 'Stop the query',
      interrupt: true,
    }

    const result = await hasPermissionsToUseTool(
      tool,
      {},
      state.context,
      assistantMessage,
      'headless-hook-interrupt',
    )

    expect(result.behavior).toBe('deny')
    expect(state.context.abortController.signal.aborted).toBe(true)
    expect(
      __getInterruptionTraceSnapshotForTests().find(
        entry =>
          entry.event === 'abort.requested' &&
          entry.source === 'permission_hook',
      ),
    ).toMatchObject({
      subsystem: 'tool_permission',
      controllerRole: 'query-root',
    })
  })

  test('SDK permission prompt rechecks plan mode after approval normalization', async () => {
    const conditionalTool = createToolFixture(
      z.object({ operation: z.enum(['read', 'write']) }),
      {
        name: 'SDKPromptTransitionTool',
        isReadOnly: input => input.operation === 'read',
      },
    )
    const state = planContext({ mode: 'default' })
    const promptResult = {
      behavior: 'allow' as const,
      get updatedInput() {
        queueMicrotask(() => {
          state.setPermissionContext({
            ...state.getPermissionContext(),
            mode: 'plan',
          })
        })
        return { operation: 'write' }
      },
    }

    const result = await permissionPromptToolResultToPermissionDecision(
      promptResult,
      conditionalTool,
      { operation: 'read' },
      state.context,
    )

    expect(result).toMatchObject({
      behavior: 'deny',
      decisionReason: { type: 'mode', mode: 'plan' },
    })
  })

  test('SDK permission prompt rechecks a mutation after its update enters plan mode', async () => {
    const mutationTool = createToolFixture(z.object({}), {
      name: 'SDKPromptUpdateTransitionTool',
      isReadOnly: () => false,
    })
    const state = planContext({ mode: 'default' })

    const result = await permissionPromptToolResultToPermissionDecision(
      {
        behavior: 'allow',
        updatedInput: {},
        updatedPermissions: [
          { type: 'setMode', mode: 'plan', destination: 'session' },
        ],
      },
      mutationTool,
      {},
      state.context,
    )

    expect(result).toMatchObject({
      behavior: 'deny',
      decisionReason: { type: 'mode', mode: 'plan' },
    })
    expect(state.getPermissionContext().mode).toBe('plan')
  })

  test('denies input rewritten into an explicit deny', async () => {
    const tool = createToolFixture(
      z.object({ target: z.enum(['review', 'restricted']) }),
      {
        name: 'HeadlessTargetTool',
        isReadOnly: () => true,
        async checkPermissions(input) {
          return input.target === 'restricted'
            ? {
                behavior: 'deny' as const,
                message: 'Restricted target',
                decisionReason: {
                  type: 'other' as const,
                  reason: 'Restricted target',
                },
              }
            : { behavior: 'ask' as const, message: 'Review target' }
        },
      },
    )
    hookDecision = {
      behavior: 'allow',
      updatedInput: { target: 'restricted' },
    }

    const result = await hasPermissionsToUseTool(
      tool,
      { target: 'review' },
      planContext().context,
      assistantMessage,
      'deny-rewrite',
    )

    expect(result).toMatchObject({
      behavior: 'deny',
      message: 'Restricted target',
    })
  })

  test('preserves an ask constraint introduced by rewritten input', async () => {
    const tool = createToolFixture(
      z.object({ target: z.enum(['review', 'sensitive']) }),
      {
        name: 'HeadlessAskTool',
        isReadOnly: () => true,
        async checkPermissions(input) {
          return {
            behavior: 'ask' as const,
            message: `Approval required for ${input.target}`,
            decisionReason: {
              type: 'rule' as const,
              rule: {
                source: 'session' as const,
                ruleBehavior: 'ask' as const,
                ruleValue: {
                  toolName: 'HeadlessAskTool',
                  ruleContent: input.target,
                },
              },
            },
          }
        },
      },
    )
    hookDecision = {
      behavior: 'allow',
      updatedInput: { target: 'sensitive' },
    }

    const result = await hasPermissionsToUseTool(
      tool,
      { target: 'review' },
      planContext().context,
      assistantMessage,
      'ask-rewrite',
    )

    expect(result).toMatchObject({
      behavior: 'ask',
      message: 'Approval required for sensitive',
    })
  })

  test.each([
    'acceptEdits',
    'bypassPermissions',
    'fullAccess',
  ] as const)('does not let hook permission updates enter %s', async mode => {
    const readTool = createToolFixture(z.object({}), {
      name: 'HeadlessReadTool',
      isReadOnly: () => true,
      async checkPermissions() {
        return { behavior: 'ask' as const, message: 'Review read' }
      },
    })
    const writeTool = createToolFixture(z.object({}), {
      name: 'HeadlessWriteTool',
      isReadOnly: () => false,
    })
    const { context, getPermissionContext } = planContext()
    hookDecision = {
      behavior: 'allow',
      updatedPermissions: [
        { type: 'setMode', mode, destination: 'session' },
      ],
    }

    const readResult = await hasPermissionsToUseTool(
      readTool,
      {},
      context,
      assistantMessage,
      'mode-update',
    )
    const writeResult = await hasPermissionsToUseTool(
      writeTool,
      {},
      context,
      assistantMessage,
      'subsequent-write',
    )

    expect(readResult.behavior).toBe('allow')
    expect(getPermissionContext().mode).toBe('plan')
    expect(writeResult).toMatchObject({
      behavior: 'deny',
      decisionReason: { type: 'mode', mode: 'plan' },
    })
  })

  test('interactive PermissionRequest hooks cannot persist a plan-mode escape', async () => {
    const readTool = createToolFixture(z.object({}), {
      name: 'InteractiveReadTool',
      isReadOnly: () => true,
    })
    const state = planContext({
      alwaysAskRules: { session: ['InteractiveReadTool'] },
    })
    const permissionContext = createPermissionContext(
      readTool,
      {},
      state.context,
      { message: { id: 'assistant-message' } } as never,
      'interactive-mode-update',
      state.setPermissionContext,
    )
    hookDecision = {
      behavior: 'allow',
      updatedPermissions: [
        { type: 'setMode', mode: 'fullAccess', destination: 'session' },
        {
          type: 'replaceRules',
          rules: [],
          behavior: 'ask',
          destination: 'session',
        },
      ],
    }

    const result = await permissionContext.runHooks(undefined, undefined)

    expect(result?.behavior).toBe('allow')
    expect(state.getPermissionContext().mode).toBe('plan')
    expect(state.getPermissionContext().alwaysAskRules.session).toEqual([
      'InteractiveReadTool',
    ])
  })

  test('labels interactive permission hook interrupts as query-root aborts', async () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    __resetInterruptionTraceForTests()
    const tool = createToolFixture(z.object({}), {
      name: 'InteractiveHookInterruptTool',
      isReadOnly: () => true,
    })
    const state = planContext({ mode: 'default' })
    const permissionContext = createPermissionContext(
      tool,
      {},
      state.context,
      { message: { id: 'assistant-message' } } as never,
      'interactive-hook-interrupt',
      state.setPermissionContext,
    )
    hookDecision = {
      behavior: 'deny',
      message: 'Stop the query',
      interrupt: true,
    }

    const result = await permissionContext.runHooks(undefined, undefined)

    expect(result).toMatchObject({
      behavior: 'deny',
      message: 'Stop the query',
    })
    expect(state.context.abortController.signal.aborted).toBe(true)
    expect(
      __getInterruptionTraceSnapshotForTests().find(
        entry =>
          entry.event === 'abort.requested' &&
          entry.source === 'permission_hook',
      ),
    ).toMatchObject({
      subsystem: 'tool_permission',
      controllerRole: 'query-root',
    })
  })

  test('interactive PermissionRequest hooks cannot rewrite a read into a mutation', async () => {
    const conditionalTool = createToolFixture(
      z.object({ operation: z.enum(['read', 'write']) }),
      {
        name: 'InteractiveConditionalTool',
        isReadOnly: input => input.operation === 'read',
      },
    )
    const state = planContext()
    const permissionContext = createPermissionContext(
      conditionalTool,
      { operation: 'read' },
      state.context,
      { message: { id: 'assistant-message' } } as never,
      'interactive-input-rewrite',
      state.setPermissionContext,
    )
    hookDecision = {
      behavior: 'allow',
      updatedInput: { operation: 'write' },
    }

    const result = await permissionContext.runHooks(undefined, undefined)

    expect(result).toMatchObject({
      behavior: 'deny',
      decisionReason: { type: 'mode', mode: 'plan' },
    })
  })

  test('interactive PermissionRequest hooks cannot rewrite into an explicit deny', async () => {
    const tool = createToolFixture(
      z.object({ target: z.enum(['review', 'restricted']) }),
      {
        name: 'InteractiveTargetTool',
        isReadOnly: () => true,
        async checkPermissions(input) {
          return input.target === 'restricted'
            ? {
                behavior: 'deny' as const,
                message: 'Restricted target',
                decisionReason: {
                  type: 'other' as const,
                  reason: 'Restricted target',
                },
              }
            : { behavior: 'ask' as const, message: 'Review target' }
        },
      },
    )
    const state = planContext()
    const permissionContext = createPermissionContext(
      tool,
      { target: 'review' },
      state.context,
      { message: { id: 'assistant-message' } } as never,
      'interactive-deny-rewrite',
      state.setPermissionContext,
    )
    hookDecision = {
      behavior: 'allow',
      updatedInput: { target: 'restricted' },
    }

    const result = await permissionContext.runHooks(undefined, undefined)

    expect(result).toMatchObject({
      behavior: 'deny',
      message: 'Restricted target',
    })
  })

  test('interactive PermissionRequest hooks preserve a new ask constraint', async () => {
    const tool = createToolFixture(
      z.object({ target: z.enum(['review', 'sensitive']) }),
      {
        name: 'InteractiveAskTool',
        isReadOnly: () => true,
        async checkPermissions(input) {
          return {
            behavior: 'ask' as const,
            message: `Approval required for ${input.target}`,
            decisionReason: {
              type: 'rule' as const,
              rule: {
                source: 'session' as const,
                ruleBehavior: 'ask' as const,
                ruleValue: {
                  toolName: 'InteractiveAskTool',
                  ruleContent: input.target,
                },
              },
            },
          }
        },
      },
    )
    const state = planContext()
    const permissionContext = createPermissionContext(
      tool,
      { target: 'review' },
      state.context,
      { message: { id: 'assistant-message' } } as never,
      'interactive-ask-rewrite',
      state.setPermissionContext,
    )
    hookDecision = {
      behavior: 'allow',
      updatedInput: { target: 'sensitive' },
    }

    const result = await permissionContext.runHooks(undefined, undefined)

    expect(result).toMatchObject({
      behavior: 'ask',
      message: 'Approval required for sensitive',
    })
  })

  test('SDK PermissionRequest hooks cannot persist a plan-mode escape', async () => {
    const readTool = createToolFixture(z.object({}), {
      name: 'SDKReadTool',
      isReadOnly: () => true,
    })
    const writeTool = createToolFixture(z.object({}), {
      name: 'SDKWriteTool',
      isReadOnly: () => false,
    })
    const state = planContext()
    const structuredIO = new StructuredIO(
      (async function* () {
        yield* []
      })(),
    )
    hookDecision = {
      behavior: 'allow',
      updatedPermissions: [
        {
          type: 'setMode',
          mode: 'fullAccess',
          destination: 'session',
        },
      ],
    }

    const readResult = await structuredIO.createCanUseTool()(
      readTool,
      {},
      state.context,
      assistantMessage,
      'sdk-mode-update',
      { behavior: 'ask', message: 'Review read' },
    )
    const writeResult = await hasPermissionsToUseTool(
      writeTool,
      {},
      state.context,
      assistantMessage,
      'sdk-subsequent-write',
    )

    expect(readResult.behavior).toBe('allow')
    expect(state.getPermissionContext().mode).toBe('plan')
    expect(writeResult).toMatchObject({
      behavior: 'deny',
      decisionReason: { type: 'mode', mode: 'plan' },
    })
  })

  test('SDK PermissionRequest hooks cannot rewrite a read into a mutation', async () => {
    const conditionalTool = createToolFixture(
      z.object({ operation: z.enum(['read', 'write']) }),
      {
        name: 'SDKConditionalTool',
        isReadOnly: input => input.operation === 'read',
      },
    )
    const state = planContext()
    const structuredIO = new StructuredIO(
      (async function* () {
        yield* []
      })(),
    )
    hookDecision = {
      behavior: 'allow',
      updatedInput: { operation: 'write' },
    }

    const result = await structuredIO.createCanUseTool()(
      conditionalTool,
      { operation: 'read' },
      state.context,
      assistantMessage,
      'sdk-input-rewrite',
      { behavior: 'ask', message: 'Review read' },
    )

    expect(result).toMatchObject({
      behavior: 'deny',
      decisionReason: { type: 'mode', mode: 'plan' },
    })
  })

  test('entering plan mode while an SDK hook runs blocks its permission updates', async () => {
    const readTool = createToolFixture(z.object({}), {
      name: 'SDKTransitionReadTool',
      isReadOnly: () => true,
    })
    const state = planContext({ mode: 'default' })
    const structuredIO = new StructuredIO(
      (async function* () {
        yield* []
      })(),
    )
    hookDecision = {
      behavior: 'allow',
      updatedPermissions: [
        {
          type: 'setMode',
          mode: 'fullAccess',
          destination: 'session',
        },
      ],
    }
    beforeHookDecision = () => {
      state.setPermissionContext({
        ...state.getPermissionContext(),
        mode: 'plan',
      })
    }

    try {
      const result = await structuredIO.createCanUseTool()(
        readTool,
        {},
        state.context,
        assistantMessage,
        'sdk-enter-plan-mode',
        { behavior: 'ask', message: 'Review read' },
      )

      expect(result.behavior).toBe('allow')
      expect(state.getPermissionContext().mode).toBe('plan')
    } finally {
      beforeHookDecision = undefined
    }
  })

  test.each(['SDK', 'interactive', 'headless'] as const)(
    '%s hooks recheck plan mode immediately before applying updates',
    async executionPath => {
      const readTool = createToolFixture(z.object({}), {
        name: `${executionPath}LateTransitionReadTool`,
        isReadOnly: () => true,
        async checkPermissions() {
          return { behavior: 'ask' as const, message: 'Review read' }
        },
      })
      const state = planContext({ mode: 'default' })
      const structuredIO = new StructuredIO(
        (async function* () {
          yield* []
        })(),
      )
      hookDecision = {
        behavior: 'allow',
        updatedPermissions: [
          {
            type: 'setMode',
            mode: 'fullAccess',
            destination: 'session',
          },
        ],
      }
      Object.defineProperty(hookDecision, 'updatedInput', {
        configurable: true,
        get() {
          queueMicrotask(() => {
            state.setPermissionContext({
              ...state.getPermissionContext(),
              mode: 'plan',
            })
          })
          return {}
        },
      })

      const result =
        executionPath === 'SDK'
          ? await structuredIO.createCanUseTool()(
              readTool,
              {},
              state.context,
              assistantMessage,
              'sdk-late-enter-plan-mode',
              { behavior: 'ask', message: 'Review read' },
            )
          : executionPath === 'headless'
            ? await hasPermissionsToUseTool(
                readTool,
                {},
                state.context,
                assistantMessage,
                'headless-late-enter-plan-mode',
              )
          : await createPermissionContext(
              readTool,
              {},
              state.context,
              { message: { id: 'assistant-message' } } as never,
              'interactive-late-enter-plan-mode',
              state.setPermissionContext,
            ).runHooks(undefined, undefined)

      expect(result?.behavior).toBe('allow')
      expect(state.getPermissionContext().mode).toBe('plan')
    },
  )

  test('interactive hooks recheck plan mode at the update commit boundary', async () => {
    const readTool = createToolFixture(z.object({}), {
      name: 'InteractiveCommitTransitionReadTool',
      isReadOnly: () => true,
    })
    const state = planContext({ mode: 'default' })
    const modeUpdate = {
      type: 'setMode' as const,
      destination: 'session' as const,
      get mode() {
        queueMicrotask(() => {
          state.setPermissionContext({
            ...state.getPermissionContext(),
            mode: 'plan',
          })
        })
        return 'acceptEdits' as const
      },
    }
    hookDecision = {
      behavior: 'allow',
      updatedPermissions: [
        modeUpdate,
        {
          type: 'addRules',
          rules: [{ toolName: 'LaterWriteTool' }],
          behavior: 'allow',
          destination: 'session',
        },
      ],
    }

    const result = await createPermissionContext(
      readTool,
      {},
      state.context,
      { message: { id: 'assistant-message' } } as never,
      'interactive-commit-enter-plan-mode',
      state.setPermissionContext,
    ).runHooks(undefined, undefined)

    expect(result?.behavior).toBe('allow')
    expect(state.getPermissionContext().mode).toBe('plan')
    expect(state.getPermissionContext().alwaysAllowRules.session ?? []).toEqual(
      [],
    )
  })

  test('entering plan mode while an interactive hook runs guards its rewritten input', async () => {
    const conditionalTool = createToolFixture(
      z.object({ operation: z.enum(['read', 'write']) }),
      {
        name: 'TransitionConditionalTool',
        isReadOnly: input => input.operation === 'read',
      },
    )
    const state = planContext({ mode: 'default' })
    const permissionContext = createPermissionContext(
      conditionalTool,
      { operation: 'read' },
      state.context,
      { message: { id: 'assistant-message' } } as never,
      'enter-plan-input-rewrite',
      state.setPermissionContext,
    )
    hookDecision = {
      behavior: 'allow',
      updatedInput: { operation: 'write' },
    }
    beforeHookDecision = () => {
      state.setPermissionContext({
        ...state.getPermissionContext(),
        mode: 'plan',
      })
    }

    try {
      const result = await permissionContext.runHooks(undefined, undefined)

      expect(result).toMatchObject({
        behavior: 'deny',
        decisionReason: { type: 'mode', mode: 'plan' },
      })
    } finally {
      beforeHookDecision = undefined
    }
  })

  test.each(['headless', 'interactive'] as const)(
    'entering plan mode while a %s hook runs blocks its permission updates',
    async executionPath => {
      const readTool = createToolFixture(z.object({}), {
        name: 'TransitionReadTool',
        isReadOnly: () => true,
        async checkPermissions() {
          return { behavior: 'ask' as const, message: 'Review read' }
        },
      })
      const state = planContext({ mode: 'default' })
      hookDecision = {
        behavior: 'allow',
        updatedPermissions: [
          { type: 'setMode', mode: 'fullAccess', destination: 'session' },
        ],
      }
      beforeHookDecision = () => {
        state.setPermissionContext({
          ...state.getPermissionContext(),
          mode: 'plan',
        })
      }

      try {
        const result =
          executionPath === 'headless'
            ? await hasPermissionsToUseTool(
                readTool,
                {},
                state.context,
                assistantMessage,
                'enter-plan-headless',
              )
            : await createPermissionContext(
                readTool,
                {},
                state.context,
                { message: { id: 'assistant-message' } } as never,
                'enter-plan-interactive',
                state.setPermissionContext,
              ).runHooks(undefined, undefined)

        expect(result?.behavior).toBe('allow')
        expect(state.getPermissionContext().mode).toBe('plan')
      } finally {
        beforeHookDecision = undefined
      }
    },
  )

  test.each(['SDK', 'interactive', 'headless'] as const)(
    '%s hooks recheck a mutation after their update enters plan mode',
    async executionPath => {
      const mutationTool = createToolFixture(z.object({}), {
        name: `${executionPath}HookUpdateTransitionTool`,
        isReadOnly: () => false,
        async checkPermissions() {
          return { behavior: 'ask' as const, message: 'Review mutation' }
        },
      })
      const state = planContext({ mode: 'default' })
      const structuredIO = new StructuredIO(
        (async function* () {
          yield* []
        })(),
      )
      hookDecision = {
        behavior: 'allow',
        updatedPermissions: [
          { type: 'setMode', mode: 'plan', destination: 'session' },
        ],
      }

      const result =
        executionPath === 'SDK'
          ? await structuredIO.createCanUseTool()(
              mutationTool,
              {},
              state.context,
              assistantMessage,
              'sdk-hook-update-enter-plan-mode',
              { behavior: 'ask', message: 'Review mutation' },
            )
          : executionPath === 'headless'
            ? await hasPermissionsToUseTool(
                mutationTool,
                {},
                state.context,
                assistantMessage,
                'headless-hook-update-enter-plan-mode',
              )
            : await createPermissionContext(
                mutationTool,
                {},
                state.context,
                { message: { id: 'assistant-message' } } as never,
                'interactive-hook-update-enter-plan-mode',
                state.setPermissionContext,
              ).runHooks(undefined, undefined)

      expect(result).toMatchObject({
        behavior: 'deny',
        decisionReason: { type: 'mode', mode: 'plan' },
      })
      expect(state.getPermissionContext().mode).toBe('plan')
    },
  )
})
