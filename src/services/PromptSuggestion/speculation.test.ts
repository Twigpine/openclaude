import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { AppState } from '../../state/AppStateStore.js'
import { IDLE_SPECULATION_STATE } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../Tool.js'
import type { REPLHookContext } from '../../utils/hooks/postSamplingHooks.js'
import {
  __getInterruptionTraceSnapshotForTests,
  __resetInterruptionTraceForTests,
} from '../../utils/interruptionTrace.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'

let startSpeculation: typeof import('./speculation.js').startSpeculation
let abortSpeculation: typeof import('./speculation.js').abortSpeculation
let actualForkedAgent: typeof import('../../utils/forkedAgent.js')
let capturedDecision: PermissionDecision | undefined
let previousUserType: string | undefined

beforeAll(async () => {
  await acquireSharedMutationLock(
    'services/PromptSuggestion/speculation.test.ts',
  )
  previousUserType = process.env.USER_TYPE
  process.env.USER_TYPE = 'ant'
  actualForkedAgent = await import(
    `../../utils/forkedAgent.ts?speculationActual=${Date.now()}-${Math.random()}`
  )
  mock.module('../../utils/forkedAgent.js', () => ({
    ...actualForkedAgent,
    async runForkedAgent({ canUseTool }) {
      capturedDecision = await canUseTool!(
        { name: 'Write' } as never,
        { file_path: '/tmp/speculation-plan-mode.ts' },
        {} as never,
        {} as never,
        'speculation-write',
      )
      return { totalUsage: { output_tokens: 0 } } as never
    },
  }))
  ;({ startSpeculation, abortSpeculation } = await import(
    `./speculation.ts?speculationTest=${Date.now()}-${Math.random()}`
  ))
})

afterAll(() => {
  try {
    mock.restore()
    mock.module('../../utils/forkedAgent.js', () => actualForkedAgent)
    if (previousUserType === undefined) {
      delete process.env.USER_TYPE
    } else {
      process.env.USER_TYPE = previousUserType
    }
  } finally {
    releaseSharedMutationLock()
  }
})

describe('startSpeculation', () => {
  test('stops speculative writes in plan mode even when bypass is available', async () => {
    const originalTrace = process.env.OPENCLAUDE_INTERRUPT_TRACE
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    __resetInterruptionTraceForTests()
    let appState = {
      speculation: IDLE_SPECULATION_STATE,
      toolPermissionContext: {
        mode: 'plan',
        isBypassPermissionsModeAvailable: true,
      },
    } as unknown as AppState
    const setAppState = (update: (prev: AppState) => AppState) => {
      appState = update(appState)
    }
    const context: REPLHookContext = {
      messages: [],
      systemPrompt: asSystemPrompt([]),
      userContext: {},
      systemContext: {},
      toolUseContext: {
        abortController: new AbortController(),
        getAppState: () => appState,
      } as unknown as ToolUseContext,
    }
    capturedDecision = undefined

    try {
      await startSpeculation(
        'edit a source file',
        context,
        setAppState,
        false,
        {} as never,
      )

      expect(capturedDecision).toMatchObject({
        behavior: 'deny',
        decisionReason: {
          reason: 'speculation_edit_boundary',
        },
      })
      expect(appState.speculation).toMatchObject({
        status: 'active',
        boundary: {
          type: 'edit',
          toolName: 'Write',
        },
      })
      expect(
        __getInterruptionTraceSnapshotForTests().find(
          entry => entry.event === 'abort.requested',
        ),
      ).toMatchObject({
        source: 'speculation_edit_boundary',
        subsystem: 'prompt_suggestion',
        controllerRole: 'speculation',
      })
      abortSpeculation(setAppState)
      expect(
        __getInterruptionTraceSnapshotForTests().find(
          entry => entry.event === 'abort.repeated',
        ),
      ).toMatchObject({
        source: 'speculation_cancelled',
        subsystem: 'prompt_suggestion',
        controllerRole: 'speculation',
        outcome: 'ignored_first_abort_wins',
        repeatedCount: 1,
      })
    } finally {
      abortSpeculation(setAppState)
      __resetInterruptionTraceForTests()
      if (originalTrace === undefined) {
        delete process.env.OPENCLAUDE_INTERRUPT_TRACE
      } else {
        process.env.OPENCLAUDE_INTERRUPT_TRACE = originalTrace
      }
    }
  })
})
