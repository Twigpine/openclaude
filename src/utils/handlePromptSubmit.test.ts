import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import * as realAnalyticsModule from 'src/services/analytics/index.js'
import { getCommandQueue, resetCommandQueue } from './messageQueueManager.js'
import { createUserMessage } from './messages.js'
import * as realProcessUserInputModule from './processUserInput/processUserInput.js'
import {
  __getInterruptionTraceSnapshotForTests,
  __resetInterruptionTraceForTests,
  __waitForInterruptionTraceFlushForTests,
} from './interruptionTrace.js'
import type { HandlePromptSubmitParams } from './handlePromptSubmit.js'

const realAnalytics = { ...realAnalyticsModule }
const realProcessUserInput = { ...realProcessUserInputModule }

describe('handlePromptSubmit', () => {
  beforeEach(async () => {
    await acquireSharedMutationLock('utils/handlePromptSubmit.test.ts')
    resetCommandQueue()
    mock.module('src/services/analytics/index.js', () => ({
      logEvent: () => {},
    }))
  })

  afterEach(() => {
    try {
      resetCommandQueue()
      mock.restore()
      mock.module('src/services/analytics/index.js', () => realAnalytics)
      mock.module(
        './processUserInput/processUserInput.js',
        () => realProcessUserInput,
      )
    } finally {
      releaseSharedMutationLock()
    }
  })

  it('prepends a pending interruption reminder to the next normal prompt', async () => {
    const correctionMessage = createUserMessage({ content: 'do Y instead' })
    const reminderMessage = createUserMessage({
      content: '<system-reminder>interrupted</system-reminder>',
      isMeta: true,
    })
    mock.module('./processUserInput/processUserInput.js', () => ({
      processUserInput: async () => ({
        messages: [correctionMessage],
        shouldQuery: true,
      }),
    }))
    const { handlePromptSubmit } = await import('./handlePromptSubmit.js')

    const queriedMessages: unknown[][] = []
    let reminderTakeCount = 0

    await handlePromptSubmit({
      input: 'do Y instead',
      mode: 'prompt',
      pastedContents: {},
      helpers: {
        setCursorOffset: () => {},
        clearBuffer: () => {},
        resetHistory: () => {},
      },
      onInputChange: () => {},
      setPastedContents: () => {},
      takeInterruptionCorrectionReminder: () => {
        reminderTakeCount++
        return reminderMessage
      },
      queryGuard: {
        isActive: false,
        reserve: () => true,
        cancelReservation: () => {},
      } as never,
      isExternalLoading: false,
      commands: [],
      messages: [],
      mainLoopModel: 'sonnet',
      ideSelection: undefined,
      querySource: 'repl' as never,
      setToolJSX: () => {},
      getToolUseContext: () => ({}) as never,
      setUserInputOnProcessing: () => {},
      setAbortController: () => {},
      onQuery: async newMessages => {
        queriedMessages.push(newMessages)
      },
      setAppState: () => ({}) as never,
    })

    expect(reminderTakeCount).toBe(1)
    expect(queriedMessages).toEqual([[reminderMessage, correctionMessage]])
  })

  it('restores a reminder when a normal prompt is blocked before query dispatch', async () => {
    const correctionMessage = createUserMessage({ content: 'do Y instead' })
    const reminderMessage = createUserMessage({
      content: '<system-reminder>interrupted</system-reminder>',
      isMeta: true,
    })
    mock.module('./processUserInput/processUserInput.js', () => ({
      processUserInput: async () => ({
        messages: [correctionMessage],
        shouldQuery: false,
      }),
    }))
    const { handlePromptSubmit } = await import('./handlePromptSubmit.js')

    let reminderTakeCount = 0
    let restoreCount = 0
    const queriedMessages: unknown[][] = []
    await handlePromptSubmit({
      input: 'do Y instead',
      mode: 'prompt',
      pastedContents: {},
      helpers: {
        setCursorOffset: () => {},
        clearBuffer: () => {},
        resetHistory: () => {},
      },
      onInputChange: () => {},
      setPastedContents: () => {},
      takeInterruptionCorrectionReminder: () => {
        reminderTakeCount++
        return reminderMessage
      },
      restoreInterruptionCorrectionReminder: () => {
        restoreCount++
      },
      queryGuard: {
        isActive: false,
        reserve: () => true,
        cancelReservation: () => {},
      } as never,
      isExternalLoading: false,
      commands: [],
      messages: [],
      mainLoopModel: 'sonnet',
      ideSelection: undefined,
      querySource: 'repl' as never,
      setToolJSX: () => {},
      getToolUseContext: () => ({}) as never,
      setUserInputOnProcessing: () => {},
      setAbortController: () => {},
      onQuery: async newMessages => {
        queriedMessages.push(newMessages)
      },
      setAppState: () => ({}) as never,
    })

    expect(reminderTakeCount).toBe(1)
    expect(restoreCount).toBe(1)
    expect(queriedMessages).toEqual([[correctionMessage]])
  })

  it('re-arms an injected reminder when the query guard declines ownership', async () => {
    const correctionMessage = createUserMessage({ content: 'do Y instead' })
    const reminderMessage = createUserMessage({
      content: '<system-reminder>interrupted</system-reminder>',
      isMeta: true,
    })
    mock.module('./processUserInput/processUserInput.js', () => ({
      processUserInput: async () => ({
        messages: [correctionMessage],
        shouldQuery: true,
      }),
    }))
    const { handlePromptSubmit } = await import('./handlePromptSubmit.js')

    let restoreCount = 0
    await handlePromptSubmit({
      input: 'do Y instead',
      mode: 'prompt',
      pastedContents: {},
      helpers: {
        setCursorOffset: () => {},
        clearBuffer: () => {},
        resetHistory: () => {},
      },
      onInputChange: () => {},
      setPastedContents: () => {},
      takeInterruptionCorrectionReminder: () => reminderMessage,
      restoreInterruptionCorrectionReminder: () => {
        restoreCount++
      },
      queryGuard: {
        isActive: false,
        reserve: () => true,
        cancelReservation: () => {},
      } as never,
      isExternalLoading: false,
      commands: [],
      messages: [],
      mainLoopModel: 'sonnet',
      ideSelection: undefined,
      querySource: 'repl' as never,
      setToolJSX: () => {},
      getToolUseContext: () => ({}) as never,
      setUserInputOnProcessing: () => {},
      setAbortController: () => {},
      onQuery: async () => false,
      setAppState: () => ({}) as never,
    } as never)

    expect(restoreCount).toBe(1)
  })

  it('does not re-arm a reminder when an owned query rejects', async () => {
    const correctionMessage = createUserMessage({ content: 'do Y instead' })
    const reminderMessage = createUserMessage({
      content: '<system-reminder>interrupted</system-reminder>',
      isMeta: true,
    })
    mock.module('./processUserInput/processUserInput.js', () => ({
      processUserInput: async () => ({
        messages: [correctionMessage],
        shouldQuery: true,
      }),
    }))
    const { handlePromptSubmit } = await import('./handlePromptSubmit.js')

    let restoreCount = 0
    const submission = handlePromptSubmit({
      input: 'do Y instead',
      mode: 'prompt',
      pastedContents: {},
      helpers: {
        setCursorOffset: () => {},
        clearBuffer: () => {},
        resetHistory: () => {},
      },
      onInputChange: () => {},
      setPastedContents: () => {},
      takeInterruptionCorrectionReminder: () => reminderMessage,
      restoreInterruptionCorrectionReminder: () => {
        restoreCount++
      },
      queryGuard: {
        isActive: false,
        reserve: () => true,
        cancelReservation: () => {},
      } as never,
      isExternalLoading: false,
      commands: [],
      messages: [],
      mainLoopModel: 'sonnet',
      ideSelection: undefined,
      querySource: 'repl' as never,
      setToolJSX: () => {},
      getToolUseContext: () => ({}) as never,
      setUserInputOnProcessing: () => {},
      setAbortController: () => {},
      onQuery: async (
        _messages,
        _abortController,
        _shouldQuery,
        _tools,
        _model,
        _beforeQuery,
        _input,
        _effort,
        _eligible,
        onModelRequestStart,
      ) => {
        onModelRequestStart?.()
        throw new Error('completion failed')
      },
      setAppState: () => ({}) as never,
    } as never)

    await expect(submission).rejects.toThrow('completion failed')
    expect(restoreCount).toBe(0)
  })

  it('restores a reminder when a later queued normal prompt throws before dispatch', async () => {
    const reminderMessage = createUserMessage({
      content: '<system-reminder>interrupted</system-reminder>',
      isMeta: true,
    })
    let calls = 0
    mock.module('./processUserInput/processUserInput.js', () => ({
      processUserInput: async () => {
        calls++
        if (calls === 2) throw new Error('hook failed')
        return {
          messages: [createUserMessage({ content: 'first correction' })],
          shouldQuery: true,
        }
      },
    }))
    const { handlePromptSubmit } = await import('./handlePromptSubmit.js')

    let reminderTakeCount = 0
    let restoreCount = 0
    const submission = handlePromptSubmit({
      input: 'do Y instead',
      mode: 'prompt',
      queuedCommands: [
        {
          value: 'first correction',
          preExpansionValue: 'first correction',
          mode: 'prompt',
        },
        {
          value: 'second correction',
          preExpansionValue: 'second correction',
          mode: 'prompt',
        },
      ],
      pastedContents: {},
      helpers: {
        setCursorOffset: () => {},
        clearBuffer: () => {},
        resetHistory: () => {},
      },
      onInputChange: () => {},
      setPastedContents: () => {},
      takeInterruptionCorrectionReminder: () => {
        reminderTakeCount++
        return reminderMessage
      },
      restoreInterruptionCorrectionReminder: () => {
        restoreCount++
      },
      queryGuard: {
        isActive: false,
        reserve: () => true,
        cancelReservation: () => {},
      } as never,
      isExternalLoading: false,
      commands: [],
      messages: [],
      mainLoopModel: 'sonnet',
      ideSelection: undefined,
      querySource: 'repl' as never,
      setToolJSX: () => {},
      getToolUseContext: () => ({}) as never,
      setUserInputOnProcessing: () => {},
      setAbortController: () => {},
      onQuery: async () => {},
      setAppState: () => ({}) as never,
    } as never)

    await expect(submission).rejects.toThrow('hook failed')
    expect(reminderTakeCount).toBe(1)
    expect(restoreCount).toBe(1)
  })

  it('preserves a reminder across a queued slash command and injects it once', async () => {
    const reminderMessage = createUserMessage({
      content: '<system-reminder>interrupted</system-reminder>',
      isMeta: true,
    })
    mock.module('./processUserInput/processUserInput.js', () => ({
      processUserInput: async ({ input }: { input: string }) => ({
        messages: input.startsWith('/')
          ? []
          : [createUserMessage({ content: input })],
        shouldQuery: !input.startsWith('/'),
      }),
    }))
    const { handlePromptSubmit } = await import('./handlePromptSubmit.js')

    let pending = true
    let injectedCount = 0
    const queriedMessages: unknown[][] = []
    const takeReminder = () => {
      if (!pending) return null
      pending = false
      injectedCount++
      return reminderMessage
    }
    const baseParams = {
      helpers: {
        setCursorOffset: () => {},
        clearBuffer: () => {},
        resetHistory: () => {},
      },
      onInputChange: () => {},
      setPastedContents: () => {},
      takeInterruptionCorrectionReminder: takeReminder,
      queryGuard: {
        isActive: false,
        reserve: () => true,
        cancelReservation: () => {},
      } as never,
      isExternalLoading: false,
      commands: [],
      messages: [],
      mainLoopModel: 'sonnet',
      ideSelection: undefined,
      querySource: 'repl' as never,
      setToolJSX: () => {},
      getToolUseContext: () => ({}) as never,
      setUserInputOnProcessing: () => {},
      setAbortController: () => {},
      onQuery: async (newMessages: unknown[]) => {
        queriedMessages.push(newMessages)
      },
      setAppState: () => ({}) as never,
    }

    await handlePromptSubmit({
      ...baseParams,
      queuedCommands: [
        {
          value: '/help',
          preExpansionValue: '[Pasted text #1]',
          mode: 'prompt',
        },
      ],
    } as never)
    expect(pending).toBe(true)
    expect(injectedCount).toBe(0)

    for (const value of ['do Y instead', 'future prompt']) {
      await handlePromptSubmit({
        ...baseParams,
        queuedCommands: [{ value, preExpansionValue: value, mode: 'prompt' }],
      } as never)
    }

    expect(injectedCount).toBe(1)
    expect(queriedMessages).toHaveLength(2)
    expect(queriedMessages[0]).toEqual([
      reminderMessage,
      expect.objectContaining({
        type: 'user',
        message: expect.objectContaining({ content: 'do Y instead' }),
      }),
    ])
    expect(queriedMessages[1]).toEqual([
      expect.objectContaining({
        type: 'user',
        message: expect.objectContaining({ content: 'future prompt' }),
      }),
    ])
  })

  it('only consumes correction reminders for normal local keyboard prompts', async () => {
    const promptSubmitModule = await import('./handlePromptSubmit.js')
    const isNormalLocalUserPrompt = (
      promptSubmitModule as typeof promptSubmitModule & {
        isNormalLocalUserPrompt?: (command: Record<string, unknown>) => boolean
      }
    ).isNormalLocalUserPrompt

    expect(typeof isNormalLocalUserPrompt).toBe('function')

    const normalPrompt = {
      value: 'do Y instead',
      preExpansionValue: 'do Y instead',
      mode: 'prompt',
    }
    expect(isNormalLocalUserPrompt?.(normalPrompt)).toBe(true)

    const ineligiblePrompts = [
      { ...normalPrompt, value: '/help', preExpansionValue: '/help' },
      {
        ...normalPrompt,
        value: '/help',
        preExpansionValue: '[Pasted text #1]',
      },
      { ...normalPrompt, mode: 'bash' },
      { ...normalPrompt, preExpansionValue: undefined },
      { ...normalPrompt, skipSlashCommands: true },
      { ...normalPrompt, bridgeOrigin: true },
      { ...normalPrompt, isMeta: true },
      { ...normalPrompt, origin: { kind: 'task-notification' } },
      { ...normalPrompt, slashCommandOverride: {} },
      { ...normalPrompt, workload: 'cron' },
      { ...normalPrompt, agentId: 'agent-1' },
      { ...normalPrompt, value: [{ type: 'text', text: 'do Y instead' }] },
    ]

    for (const prompt of ineligiblePrompts) {
      expect(isNormalLocalUserPrompt?.(prompt)).toBe(false)
    }
  })

  it('preserves local prompt provenance when a concurrent turn is requeued', async () => {
    const { buildConcurrentRequeuedPrompt } =
      await import('./handlePromptSubmit.js')

    expect(buildConcurrentRequeuedPrompt('do Y instead', true)).toEqual({
      value: 'do Y instead',
      preExpansionValue: 'do Y instead',
      allowInterruptionCorrection: true,
      mode: 'prompt',
    })
    expect(buildConcurrentRequeuedPrompt('remote prompt', false)).toEqual({
      value: 'remote prompt',
      preExpansionValue: undefined,
      allowInterruptionCorrection: false,
      mode: 'prompt',
    })
  })

  it('marks only normal local prompts as correction-eligible model turns', async () => {
    mock.module('./processUserInput/processUserInput.js', () => ({
      processUserInput: async ({ input }: { input: string }) => ({
        messages: [createUserMessage({ content: input })],
        shouldQuery: true,
      }),
    }))
    const { handlePromptSubmit } = await import('./handlePromptSubmit.js')

    const correctionEligibility: unknown[] = []
    const baseParams = {
      helpers: {
        setCursorOffset: () => {},
        clearBuffer: () => {},
        resetHistory: () => {},
      },
      onInputChange: () => {},
      setPastedContents: () => {},
      queryGuard: {
        isActive: false,
        reserve: () => true,
        cancelReservation: () => {},
      } as never,
      isExternalLoading: false,
      commands: [],
      messages: [],
      mainLoopModel: 'sonnet',
      ideSelection: undefined,
      querySource: 'repl' as never,
      setToolJSX: () => {},
      getToolUseContext: () => ({}) as never,
      setUserInputOnProcessing: () => {},
      setAbortController: () => {},
      onQuery: async (
        _newMessages: unknown,
        _abortController: unknown,
        _shouldQuery: unknown,
        _allowedTools: unknown,
        _mainLoopModel: unknown,
        _onBeforeQuery: unknown,
        _input: unknown,
        _effort: unknown,
        isInterruptionCorrectionEligible: unknown,
      ) => {
        correctionEligibility.push(isInterruptionCorrectionEligible)
      },
      setAppState: () => ({}) as never,
    }

    await handlePromptSubmit({
      ...baseParams,
      queuedCommands: [
        {
          value: 'local prompt',
          preExpansionValue: 'local prompt',
          mode: 'prompt',
        },
      ],
    } as never)
    await handlePromptSubmit({
      ...baseParams,
      queuedCommands: [
        {
          value: 'remote prompt',
          preExpansionValue: 'remote prompt',
          mode: 'prompt',
          bridgeOrigin: true,
          skipSlashCommands: true,
        },
      ],
    } as never)
    await handlePromptSubmit({
      ...baseParams,
      queuedCommands: [
        {
          value: 'local prompt',
          preExpansionValue: 'local prompt',
          mode: 'prompt',
        },
        {
          value: 'remote prompt',
          preExpansionValue: 'remote prompt',
          mode: 'prompt',
          bridgeOrigin: true,
          skipSlashCommands: true,
        },
      ],
    } as never)
    await handlePromptSubmit({
      ...baseParams,
      input: 'programmatic initial prompt',
      mode: 'prompt',
      pastedContents: {},
      allowInterruptionCorrection: false,
    } as never)

    expect(correctionEligibility).toEqual([true, false, false, false])
  })

  it('queues prompt submissions during generation without interrupting the current turn', async () => {
    const { handlePromptSubmit } = await import('./handlePromptSubmit.js')

    const abortCalls: unknown[] = []
    const inputChanges: string[] = []
    let cursorOffset = 123
    let bufferCleared = false
    let pastedContentsCleared = false
    let historyReset = false

    await handlePromptSubmit({
      input: '  use another library  ',
      mode: 'prompt',
      pastedContents: {},
      helpers: {
        setCursorOffset: offset => {
          cursorOffset = offset
        },
        clearBuffer: () => {
          bufferCleared = true
        },
        resetHistory: () => {
          historyReset = true
        },
      },
      onInputChange: value => {
        inputChanges.push(value)
      },
      setPastedContents: updater => {
        const nextValue =
          typeof updater === 'function'
            ? updater({ 1: { id: 1, type: 'text', content: 'x' } })
            : updater
        pastedContentsCleared = Object.keys(nextValue).length === 0
      },
      abortController: {
        abort: (reason: unknown) => {
          abortCalls.push(reason)
        },
      } as never,
      hasInterruptibleToolInProgress: true,
      queryGuard: {
        isActive: true,
      } as never,
      isExternalLoading: false,
      commands: [],
      messages: [],
      mainLoopModel: 'sonnet',
      ideSelection: undefined,
      querySource: 'repl' as never,
      setToolJSX: () => {},
      getToolUseContext: () => ({}) as never,
      setUserInputOnProcessing: () => {},
      setAbortController: () => {},
      onQuery: async () => {},
      setAppState: () => ({}) as never,
    })

    expect(abortCalls).toEqual([])
    expect(inputChanges).toEqual([''])
    expect(cursorOffset).toBe(0)
    expect(bufferCleared).toBe(true)
    expect(pastedContentsCleared).toBe(true)
    expect(historyReset).toBe(true)
    expect(getCommandQueue()).toMatchObject([
      {
        value: 'use another library',
        preExpansionValue: 'use another library',
        mode: 'prompt',
      },
    ])
  })

  it('traces the explicit submit-interrupt path at runtime', async () => {
    const originalTrace = process.env.OPENCLAUDE_INTERRUPT_TRACE
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    __resetInterruptionTraceForTests()
    const controller = new AbortController()
    const { handlePromptSubmit } = await import('./handlePromptSubmit.js')
    try {
      const params: HandlePromptSubmitParams = {
        input: 'echo ready',
        mode: 'bash',
        pastedContents: {},
        helpers: {
          setCursorOffset: () => {},
          clearBuffer: () => {},
          resetHistory: () => {},
        },
        onInputChange: () => {},
        setPastedContents: () => {},
        abortController: controller,
        hasInterruptibleToolInProgress: true,
        streamMode: 'requesting',
        queryGuard: { isActive: true } as never,
        isExternalLoading: false,
        commands: [],
        messages: [],
        mainLoopModel: 'sonnet',
        ideSelection: undefined,
        querySource: 'repl' as never,
        setToolJSX: () => {},
        getToolUseContext: () => ({}) as never,
        setUserInputOnProcessing: () => {},
        setAbortController: () => {},
        onQuery: async () => {},
        setAppState: () => ({}) as never,
      }
      await handlePromptSubmit(params)

      expect(controller.signal.aborted).toBe(true)
      const trace = __getInterruptionTraceSnapshotForTests()
      const inputEvent = trace.find(
        entry => entry.event === 'input.submit_interrupt',
      )
      const abortEvent = trace.find(entry => entry.event === 'abort.requested')
      expect(abortEvent?.source).toBe('interrupt_on_submit')
      expect(inputEvent).toBeDefined()
      expect(abortEvent).toBeDefined()
      expect(typeof inputEvent!.eventId).toBe('string')
      expect(typeof abortEvent!.causalEventId).toBe('string')
      expect(abortEvent!.causalEventId).toBe(inputEvent!.eventId)
    } finally {
      await __waitForInterruptionTraceFlushForTests()
      __resetInterruptionTraceForTests()
      if (originalTrace === undefined) delete process.env.OPENCLAUDE_INTERRUPT_TRACE
      else process.env.OPENCLAUDE_INTERRUPT_TRACE = originalTrace
    }
  })
})
