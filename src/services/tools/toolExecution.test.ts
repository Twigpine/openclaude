import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import { z } from 'zod/v4'

import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { getEmptyToolPermissionContext, type Tool, type ToolUseContext } from '../../Tool.js'
import {
  getReplayIndexBuilder,
  resetAllReplayIndexBuilders,
} from '../../bootstrap/state.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { createToolFixture } from '../../test/toolFixtures.js'
import { SkillTool } from '../../tools/SkillTool/SkillTool.js'
import { AskUserQuestionTool } from '../../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/constants.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../../tools/NotebookEditTool/constants.js'
import { asAgentId } from '../../types/ids.js'
import { AbortError } from '../../utils/errors.js'
import { getDoomLoopState, resetDoomLoop } from '../../utils/doomLoop.js'
import { CANCEL_MESSAGE, createAssistantMessage } from '../../utils/messages.js'
import {
  type QueryActiveOperationSnapshot,
  QueryLifecycleOperationTracker,
} from '../../utils/queryLifecycle.js'
import { ReplayIndexBuilder } from '../../utils/replayIndexBuilder.js'
import {
  getReplayResultStatusForError,
  getReplayModifiedFiles,
  getSchemaValidationErrorOverride,
  getSchemaValidationToolUseResult,
  checkPermissionsAndCallTool,
  type MessageUpdateLazy,
  normalizeReplayToolInput,
  normalizeToolInputForValidation,
  runToolUse,
} from './toolExecution.js'

function firstToolResultText(message: unknown): string {
  const content = (message as { message?: { content?: unknown } }).message
    ?.content
  if (!Array.isArray(content)) return ''
  const toolResult = content.find(
    block =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'tool_result',
  ) as { content?: unknown } | undefined
  return String(toolResult?.content ?? '')
}

function toolUseResultText(message: unknown): string {
  return String((message as { toolUseResult?: unknown }).toolUseResult ?? '')
}

afterEach(() => {
  delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  resetAllReplayIndexBuilders()
})

class CountingQueryLifecycleTracker extends QueryLifecycleOperationTracker {
  startCount = 0
  updateCount = 0
  endCount = 0

  override startToolUse(
    toolUse: Parameters<QueryLifecycleOperationTracker['startToolUse']>[0],
  ): void {
    this.startCount++
    super.startToolUse(toolUse)
  }

  override updateToolUse(
    toolUse: Parameters<QueryLifecycleOperationTracker['updateToolUse']>[0],
  ): void {
    this.updateCount++
    super.updateToolUse(toolUse)
  }

  override endToolUse(toolUseId: string): void {
    this.endCount++
    super.endToolUse(toolUseId)
  }
}

function createLifecycleToolUseContext(
  tools: readonly Tool[],
  queryLifecycle: QueryLifecycleOperationTracker,
  abortController = new AbortController(),
): ToolUseContext {
  const appState = getDefaultAppState()
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'test-model',
      tools,
      verbose: false,
      thinkingConfig: {},
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { agents: [], errors: [] },
    },
    abortController,
    queryLifecycle,
    readFileState: {},
    getAppState: () => ({
      ...appState,
      sessionHooks: new Map(),
      toolPermissionContext: getEmptyToolPermissionContext(),
    }),
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
  } as unknown as ToolUseContext
}

async function collectRunToolUse(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
  canUseTool: CanUseToolFn = async (_tool, toolInput) => ({
    behavior: 'allow',
    updatedInput: toolInput,
  }),
) {
  const updates: MessageUpdateLazy[] = []
  for await (const update of runToolUse(
    {
      type: 'tool_use',
      id: 'toolu_lifecycle',
      name: tool.name,
      input,
    } as ToolUseBlock,
    createAssistantMessage({ content: 'run tool' }),
    canUseTool,
    context,
  )) {
    updates.push(update)
  }
  return updates
}

test('a late successful tool result resets doom blocks without clearing another agent', async () => {
  const agentId = asAgentId('doom-loop-late-success')
  const siblingId = asAgentId('doom-loop-sibling')
  let finish!: () => void
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const pending = new Promise<void>(resolve => { finish = resolve })
  let calls = 0
  const tool = createToolFixture(z.object({ value: z.string() }), {
    name: 'DoomLoopLateSuccessTool',
    async call() {
      if (++calls === 2) {
        started()
        await pending
      }
      return { data: 'ok' }
    },
  })
  const context = createLifecycleToolUseContext([tool], new CountingQueryLifecycleTracker())
  context.agentId = agentId
  const sibling = { ...context, agentId: siblingId }
  let inFlight: Promise<MessageUpdateLazy[]> | undefined
  try {
    await collectRunToolUse(tool, { value: 'same' }, context)
    inFlight = collectRunToolUse(tool, { value: 'same' }, context)
    await ready
    for (let i = 0; i < 4; i++) await collectRunToolUse(tool, { value: 'same' }, context)
    for (let i = 0; i < 6; i++) await collectRunToolUse(tool, { value: 'same' }, sibling)
    expect(getDoomLoopState(agentId).consecutiveBlocks).toBe(4)
    finish()
    await inFlight
    expect(getDoomLoopState(agentId).consecutiveBlocks).toBe(0)
    expect(getDoomLoopState(siblingId).consecutiveBlocks).toBe(4)
    for (let i = 0; i < 4; i++) await collectRunToolUse(tool, { value: 'same' }, context)
    expect(getDoomLoopState(agentId).terminalMessage).toBeNull()
    await collectRunToolUse(tool, { value: 'same' }, context)
    expect(getDoomLoopState(agentId).terminalMessage).toContain('5 consecutive')
    const executedBefore = calls
    const skipped = await collectRunToolUse(tool, { value: 'different' }, context)
    expect(calls).toBe(executedBefore)
    expect(firstToolResultText(skipped[0]?.message)).toContain('force-terminated')
  } finally {
    finish()
    await inFlight
    resetDoomLoop(agentId)
    resetDoomLoop(siblingId)
  }
})

describe('getSchemaValidationErrorOverride', () => {
  test('returns actionable missing-skill error for SkillTool', () => {
    expect(getSchemaValidationErrorOverride(SkillTool, {})).toBe(
      'Missing skill name. Pass the slash command name as the skill parameter (e.g., skill: "commit" for /commit, skill: "review-pr" for /review-pr).',
    )
  })

  test('does not override unrelated tool schema failures', () => {
    expect(getSchemaValidationErrorOverride({ name: 'Read' } as never, {})).toBe(
      null,
    )
  })

  test('does not override SkillTool when skill is present', () => {
    expect(
      getSchemaValidationErrorOverride(SkillTool, { skill: 'commit' }),
    ).toBe(null)
  })

  test('uses the actionable override for structured toolUseResult too', () => {
    expect(getSchemaValidationToolUseResult(SkillTool, {} as never)).toBe(
      'InputValidationError: Missing skill name. Pass the slash command name as the skill parameter (e.g., skill: "commit" for /commit, skill: "review-pr" for /review-pr).',
    )
  })
})

describe('getReplayModifiedFiles', () => {
  test('captures file-editing tool paths', () => {
    expect(
      getReplayModifiedFiles(FILE_EDIT_TOOL_NAME, { file_path: 'src/a.ts' }),
    ).toEqual(['src/a.ts'])
    expect(
      getReplayModifiedFiles(FILE_WRITE_TOOL_NAME, { file_path: 'src/b.ts' }),
    ).toEqual(['src/b.ts'])
    expect(
      getReplayModifiedFiles(NOTEBOOK_EDIT_TOOL_NAME, {
        notebook_path: 'notebooks/a.ipynb',
      }),
    ).toEqual(['notebooks/a.ipynb'])
  })

  test('captures Bash simulated sed edit paths', () => {
    expect(
      getReplayModifiedFiles(BASH_TOOL_NAME, {
        command: "sed -i 's/a/b/' src/a.ts",
        _simulatedSedEdit: {
          filePath: 'src/a.ts',
          newContent: 'updated',
        },
      }),
    ).toEqual(['src/a.ts'])
  })
})

describe('replay tool lifecycle records', () => {
  test('records permission denied completions', () => {
    const builder = new ReplayIndexBuilder()

    builder.trackToolStart('tool-1', BASH_TOOL_NAME, { command: 'git status' })
    builder.trackToolEnd('tool-1', BASH_TOOL_NAME, 'permission_denied', 'denied')

    const step = builder.build('session-1').steps[0]
    expect(step?.type).toBe('tool')
    if (step?.type !== 'tool') {
      throw new Error('expected tool replay step')
    }
    expect(step.resultStatus).toBe('permission_denied')
    expect(step.resultPreview).toBe('denied')
  })

  test('records success completions with modified files', () => {
    const builder = new ReplayIndexBuilder()

    builder.trackToolStart('tool-1', FILE_EDIT_TOOL_NAME, {
      file_path: 'src/final.ts',
      old_string: 'old',
      new_string: 'new',
    })
    builder.trackToolEnd('tool-1', FILE_EDIT_TOOL_NAME, 'success', 'patched', [
      'src/final.ts',
    ])

    const step = builder.build('session-1').steps[0]
    expect(step?.type).toBe('tool')
    if (step?.type !== 'tool') {
      throw new Error('expected tool replay step')
    }
    expect(step.resultStatus).toBe('success')
    expect(step.filesModified).toEqual(['src/final.ts'])
  })

  test('records error completions', () => {
    const builder = new ReplayIndexBuilder()

    builder.trackToolStart('tool-1', BASH_TOOL_NAME, { command: 'bun test' })
    builder.trackToolEnd('tool-1', BASH_TOOL_NAME, 'error', 'failed')

    const step = builder.build('session-1').steps[0]
    expect(step?.type).toBe('tool')
    if (step?.type !== 'tool') {
      throw new Error('expected tool replay step')
    }
    expect(step.resultStatus).toBe('error')
    expect(step.resultPreview).toBe('failed')
  })

  test('classifies abort-shaped tool failures as cancelled', () => {
    expect(getReplayResultStatusForError(new AbortError('interrupted'))).toBe(
      'cancelled',
    )
    expect(getReplayResultStatusForError(new Error('failed'))).toBe('error')
  })

  test('captures the final executable input', () => {
    const builder = new ReplayIndexBuilder()
    const finalInput = {
      file_path: 'src/final.ts',
      old_string: 'before',
      new_string: 'after',
    }

    builder.trackToolStart('tool-1', FILE_EDIT_TOOL_NAME, finalInput)
    builder.trackToolEnd('tool-1', FILE_EDIT_TOOL_NAME, 'success')

    const step = builder.build('session-1').steps[0]
    expect(step?.type).toBe('tool')
    if (step?.type !== 'tool') {
      throw new Error('expected tool replay step')
    }
    expect(step.input).toEqual(finalInput)
    expect(step.inputSummary).toBe('Edit src/final.ts')
  })

  test('normalizes denied file-tool replay inputs to match allowed retry inputs', () => {
    const builder = new ReplayIndexBuilder()
    const modelInput = {
      file_path: 'src/final.ts',
      old_string: 'before',
      new_string: 'after',
    }
    const backfilledClone = {
      ...modelInput,
      file_path: 'C:\\temp\\openclaude\\src\\final.ts',
    }
    const deniedReplayInput = normalizeReplayToolInput(
      backfilledClone,
      modelInput,
      backfilledClone,
    )

    builder.trackToolStart('tool-1', FILE_EDIT_TOOL_NAME, deniedReplayInput)
    builder.trackToolEnd(
      'tool-1',
      FILE_EDIT_TOOL_NAME,
      'permission_denied',
      'denied',
    )
    builder.trackToolStart('tool-2', FILE_EDIT_TOOL_NAME, modelInput)
    builder.trackToolEnd('tool-2', FILE_EDIT_TOOL_NAME, 'success')

    const index = builder.build('session-1')
    const first = index.steps[0]
    const second = index.steps[1]

    expect(first?.type).toBe('tool')
    expect(second?.type).toBe('tool')
    if (first?.type !== 'tool' || second?.type !== 'tool') {
      throw new Error('expected tool replay steps')
    }

    expect(first.input.file_path).toBe('src/final.ts')
    expect(second.repeatedAttemptNumber).toBe(2)
    expect(second.isRepeatedAttempt).toBe(true)
  })

  test('records one error terminal status when post-call result processing fails', async () => {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = 'true'
    resetAllReplayIndexBuilders()
    const toolUseId = 'tool-1'
    const tool = {
      name: 'TestTool',
      inputSchema: z.object({ value: z.string() }),
      maxResultSizeChars: 1000,
      call: mock(() =>
        Promise.resolve({
          data: 'tool succeeded',
        }),
      ),
      mapToolResultToToolResultBlockParam: mock(() => {
        throw new Error('mapping failed')
      }),
      checkPermissions: mock(() =>
        Promise.resolve({
          behavior: 'allow',
          updatedInput: { value: 'final' },
        }),
      ),
      isEnabled: () => true,
      isReadOnly: () => false,
      isConcurrencySafe: () => true,
      description: () => Promise.resolve('test tool'),
      prompt: () => Promise.resolve('test tool'),
    } as unknown as Tool
    const appState = getDefaultAppState()
    const context = {
      options: {
        commands: [],
        debug: false,
        mainLoopModel: 'test-model',
        tools: [tool],
        verbose: false,
        thinkingConfig: {},
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: true,
        agentDefinitions: { agents: [], errors: [] },
      },
      abortController: new AbortController(),
      readFileState: {},
      getAppState: () => ({
        ...appState,
        toolPermissionContext: getEmptyToolPermissionContext(),
      }),
      setAppState: () => {},
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: () => {},
      updateAttributionState: () => {},
      messages: [],
    } as unknown as ToolUseContext

    const result = await checkPermissionsAndCallTool(
      tool,
      toolUseId,
      { value: 'initial' },
      context,
      () =>
        Promise.resolve({
          behavior: 'allow',
          updatedInput: { value: 'final' },
        }),
      {
        uuid: 'assistant-1',
        type: 'assistant',
        message: { id: 'msg-1' },
      } as never,
      'msg-1',
      undefined,
      undefined as never,
      undefined,
      () => {},
    )

    expect(result).toHaveLength(1)
    const index = getReplayIndexBuilder().build('session-1')
    expect(index.steps).toHaveLength(1)
    const step = index.steps[0]
    expect(step?.type).toBe('tool')
    if (step?.type !== 'tool') {
      throw new Error('expected tool replay step')
    }
    expect(step.toolUseId).toBe(toolUseId)
    expect(step.resultStatus).toBe('error')
    expect(step.resultPreview).toBe('mapping failed')
    expect(step.input).toEqual({ value: 'final' })
  })
})

describe('query lifecycle tool-use cleanup', () => {
  const lifecycleInputSchema = z.object({ value: z.string() })

  test('successful tool execution leaves no active lifecycle tool use', async () => {
    const queryLifecycle = new CountingQueryLifecycleTracker()
    let lifecycleSnapshotDuringCall: QueryActiveOperationSnapshot | undefined
    const tool = createToolFixture(lifecycleInputSchema, {
      name: 'LifecycleSuccessTool',
      async call() {
        lifecycleSnapshotDuringCall = queryLifecycle.snapshot()
        return { data: 'ok' }
      },
    })
    const context = createLifecycleToolUseContext([tool], queryLifecycle)

    const updates = await collectRunToolUse(tool, { value: 'ok' }, context)

    expect(updates.length).toBeGreaterThan(0)
    expect(lifecycleSnapshotDuringCall?.toolUses).toMatchObject([
      {
        toolUseId: 'toolu_lifecycle',
        toolName: 'LifecycleSuccessTool',
      },
    ])
    expect(queryLifecycle.startCount).toBe(1)
    expect(queryLifecycle.endCount).toBe(1)
    expect(queryLifecycle.snapshot()).toEqual({ apiCalls: [], toolUses: [] })
  })

  test('custom validation failure leaves no active lifecycle tool use', async () => {
    const queryLifecycle = new CountingQueryLifecycleTracker()
    const tool = createToolFixture(lifecycleInputSchema, {
      name: 'LifecycleValidationTool',
      async validateInput() {
        return {
          result: false,
          message: 'invalid value',
          errorCode: 1,
        }
      },
    })
    const context = createLifecycleToolUseContext([tool], queryLifecycle)

    const updates = await collectRunToolUse(tool, { value: 'bad' }, context)

    expect(updates.length).toBeGreaterThan(0)
    expect(queryLifecycle.startCount).toBe(1)
    expect(queryLifecycle.endCount).toBe(1)
    expect(queryLifecycle.snapshot()).toEqual({ apiCalls: [], toolUses: [] })
  })

  test('schema validation failure does not end a lifecycle entry that never started', async () => {
    const queryLifecycle = new CountingQueryLifecycleTracker()
    const tool = createToolFixture(lifecycleInputSchema, {
      name: 'LifecycleSchemaTool',
    })
    const context = createLifecycleToolUseContext([tool], queryLifecycle)

    const updates = await collectRunToolUse(tool, {}, context)

    expect(updates.length).toBeGreaterThan(0)
    expect(queryLifecycle.startCount).toBe(0)
    expect(queryLifecycle.updateCount).toBe(0)
    expect(queryLifecycle.endCount).toBe(0)
    expect(queryLifecycle.snapshot()).toEqual({ apiCalls: [], toolUses: [] })
  })

  test('unknown tool does not end a lifecycle entry that never started', async () => {
    const queryLifecycle = new CountingQueryLifecycleTracker()
    const tool = createToolFixture(lifecycleInputSchema, {
      name: 'LifecycleUnknownTool',
    })
    const context = createLifecycleToolUseContext([], queryLifecycle)

    const updates = await collectRunToolUse(tool, { value: 'ok' }, context)

    expect(updates.length).toBeGreaterThan(0)
    expect(queryLifecycle.startCount).toBe(0)
    expect(queryLifecycle.updateCount).toBe(0)
    expect(queryLifecycle.endCount).toBe(0)
    expect(queryLifecycle.snapshot()).toEqual({ apiCalls: [], toolUses: [] })
  })

  test('permission denial leaves no active lifecycle tool use', async () => {
    const queryLifecycle = new CountingQueryLifecycleTracker()
    const tool = createToolFixture(lifecycleInputSchema, {
      name: 'LifecycleDeniedTool',
    })
    const context = createLifecycleToolUseContext([tool], queryLifecycle)
    const denyToolUse: CanUseToolFn = async () => ({
      behavior: 'deny',
      message: 'Denied by test',
      decisionReason: {
        type: 'other',
        reason: 'Denied by test',
      },
    })

    const updates = await collectRunToolUse(
      tool,
      { value: 'blocked' },
      context,
      denyToolUse,
    )

    expect(updates.length).toBeGreaterThan(0)
    expect(queryLifecycle.startCount).toBe(1)
    expect(queryLifecycle.updateCount).toBeGreaterThan(0)
    expect(queryLifecycle.endCount).toBe(1)
    expect(queryLifecycle.snapshot()).toEqual({ apiCalls: [], toolUses: [] })
  })

  test.each([
    [
      'query-timeout',
      'Tool use was interrupted because the query timed out.',
      false,
    ],
    [
      'hard_max',
      'Tool use was interrupted because the query reached its hard maximum runtime.',
      false,
    ],
    [
      'background',
      'Tool use was interrupted because the query was backgrounded.',
      false,
    ],
    ['interrupt', CANCEL_MESSAGE, true],
    ['user-abort', CANCEL_MESSAGE, true],
  ])(
    'already-aborted tool execution uses reason-aware result for %s',
    async (abortReason, expectedMessage, isUserCancel) => {
      const queryLifecycle = new CountingQueryLifecycleTracker()
      const tool = createToolFixture(lifecycleInputSchema, {
        name: `LifecycleAlreadyAbortedTool_${abortReason}`,
        async call() {
          throw new Error('tool should not run after parent abort')
        },
      })
      const abortController = new AbortController()
      abortController.abort(abortReason)
      const context = createLifecycleToolUseContext(
        [tool],
        queryLifecycle,
        abortController,
      )

      const updates = await collectRunToolUse(tool, { value: 'abort' }, context)
      const message = updates.find(update => update.message)?.message

      expect(message).toBeDefined()
      expect(firstToolResultText(message)).toContain(expectedMessage)
      expect(toolUseResultText(message)).toBe(expectedMessage)
      expect(firstToolResultText(message)).not.toContain('User rejected')
      if (!isUserCancel) {
        expect(firstToolResultText(message)).not.toContain(
          "The user doesn't want",
        )
      }
    },
  )

  test('thrown tool error leaves no active lifecycle tool use', async () => {
    const queryLifecycle = new CountingQueryLifecycleTracker()
    const tool = createToolFixture(lifecycleInputSchema, {
      name: 'LifecycleThrowTool',
      async call() {
        throw new Error('tool exploded')
      },
    })
    const context = createLifecycleToolUseContext([tool], queryLifecycle)

    const updates = await collectRunToolUse(tool, { value: 'boom' }, context)

    expect(updates.length).toBeGreaterThan(0)
    expect(queryLifecycle.startCount).toBe(1)
    expect(queryLifecycle.endCount).toBe(1)
    expect(queryLifecycle.snapshot()).toEqual({ apiCalls: [], toolUses: [] })
  })

  test('aborted tool execution leaves no active lifecycle tool use', async () => {
    const queryLifecycle = new CountingQueryLifecycleTracker()
    const tool = createToolFixture(lifecycleInputSchema, {
      name: 'LifecycleAbortTool',
      async call() {
        throw new AbortError('interrupted')
      },
    })
    const context = createLifecycleToolUseContext([tool], queryLifecycle)

    const updates = await collectRunToolUse(tool, { value: 'abort' }, context)

    expect(updates.length).toBeGreaterThan(0)
    expect(queryLifecycle.startCount).toBe(1)
    expect(queryLifecycle.endCount).toBe(1)
    expect(queryLifecycle.snapshot()).toEqual({ apiCalls: [], toolUses: [] })
  })

  test('permission-updated input can retrack lifecycle metadata and still ends once', async () => {
    const queryLifecycle = new CountingQueryLifecycleTracker()
    let lifecycleSnapshotDuringCall: QueryActiveOperationSnapshot | undefined
    const tool = createToolFixture(
      z.object({ value: z.string(), timeout: z.number().optional() }),
      {
        name: BASH_TOOL_NAME,
        async call() {
          lifecycleSnapshotDuringCall = queryLifecycle.snapshot()
          return { data: 'ok' }
        },
      },
    )
    const context = createLifecycleToolUseContext([tool], queryLifecycle)
    const updateInput: CanUseToolFn = async () => ({
      behavior: 'allow',
      updatedInput: { value: 'updated', timeout: 20 },
    })

    const updates = await collectRunToolUse(
      tool,
      { value: 'initial', timeout: 10 },
      context,
      updateInput,
    )

    expect(updates.length).toBeGreaterThan(0)
    expect(lifecycleSnapshotDuringCall?.toolUses).toEqual([
      {
        toolUseId: 'toolu_lifecycle',
        toolName: BASH_TOOL_NAME,
        startedAt: expect.any(Number),
        isBash: true,
        timeoutMs: 20,
      },
    ])
    expect(queryLifecycle.startCount).toBe(1)
    expect(queryLifecycle.updateCount).toBeGreaterThan(0)
    expect(queryLifecycle.endCount).toBe(1)
    expect(queryLifecycle.snapshot()).toEqual({ apiCalls: [], toolUses: [] })
  })

  test('permission-updated input does not resurrect externally ended lifecycle tracking', async () => {
    const queryLifecycle = new CountingQueryLifecycleTracker()
    const tool = createToolFixture(lifecycleInputSchema, {
      name: 'LifecycleExternallyEndedTool',
    })
    const context = createLifecycleToolUseContext([tool], queryLifecycle)
    let lifecycleSnapshotBeforeExternalEnd:
      | QueryActiveOperationSnapshot
      | undefined
    const endBeforeUpdatingInput: CanUseToolFn = async () => {
      lifecycleSnapshotBeforeExternalEnd = queryLifecycle.snapshot()
      queryLifecycle.endToolUse('toolu_lifecycle')
      return {
        behavior: 'allow',
        updatedInput: { value: 'updated' },
      }
    }

    const updates = await collectRunToolUse(
      tool,
      { value: 'initial' },
      context,
      endBeforeUpdatingInput,
    )

    expect(updates.length).toBeGreaterThan(0)
    expect(lifecycleSnapshotBeforeExternalEnd?.toolUses).toMatchObject([
      {
        toolUseId: 'toolu_lifecycle',
        toolName: 'LifecycleExternallyEndedTool',
      },
    ])
    expect(queryLifecycle.startCount).toBe(1)
    expect(queryLifecycle.updateCount).toBe(0)
    expect(queryLifecycle.endCount).toBe(1)
    expect(queryLifecycle.snapshot()).toEqual({ apiCalls: [], toolUses: [] })
  })
})

describe('normalizeToolInputForValidation', () => {
  test('treats blank Read.pages as omitted', () => {
    expect(
      normalizeToolInputForValidation({ name: 'Read' } as never, {
        file_path: '/tmp/example.txt',
        offset: 1,
        limit: 20,
        pages: '',
      }),
    ).toEqual({
      file_path: '/tmp/example.txt',
      offset: 1,
      limit: 20,
    })

    expect(
      normalizeToolInputForValidation({ name: 'Read' } as never, {
        file_path: '/tmp/example.txt',
        pages: '   ',
      }),
    ).toEqual({
      file_path: '/tmp/example.txt',
    })
  })

  test('treats null Read.pages as omitted', () => {
    expect(
      normalizeToolInputForValidation({ name: 'Read' } as never, {
        file_path: '/tmp/example.txt',
        pages: null,
      }),
    ).toEqual({
      file_path: '/tmp/example.txt',
    })
  })

  test('wraps Gemini-style single AskUserQuestion payloads', () => {
    const normalized = normalizeToolInputForValidation(AskUserQuestionTool, {
      header: 'Location',
      question: 'Where should we create the app?',
      options: [
        {
          label: '../todo-app (Recommended)',
          description: 'Create the app next to the current project',
        },
        {
          label: 'Custom path',
          description: 'Provide another folder',
        },
      ],
      multiSelect: false,
    })

    expect(AskUserQuestionTool.inputSchema.safeParse(normalized).success).toBe(true)
    expect(normalized).toEqual({
      questions: [
        {
          header: 'Location',
          question: 'Where should we create the app?',
          options: [
            {
              label: '../todo-app (Recommended)',
              description: 'Create the app next to the current project',
            },
            {
              label: 'Custom path',
              description: 'Provide another folder',
            },
          ],
          multiSelect: false,
        },
      ],
    })
  })

  test('leaves already valid AskUserQuestion payloads unchanged', () => {
    const input = {
      questions: [
        {
          header: 'Location',
          question: 'Where should we create the app?',
          options: [
            { label: '../todo-app', description: 'Use the default folder' },
            { label: 'Custom', description: 'Provide another folder' },
          ],
          multiSelect: false,
        },
      ],
    }

    expect(normalizeToolInputForValidation(AskUserQuestionTool, input)).toBe(input)
  })

  test('does not normalize unrelated tool inputs', () => {
    const input = {
      header: 'Location',
      question: 'Where should we create the app?',
      options: [],
    }

    expect(normalizeToolInputForValidation({ name: 'Read' } as never, input)).toBe(input)
  })
})
