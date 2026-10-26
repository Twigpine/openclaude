import { feature } from 'bun:bundle'
import { expect, test } from 'bun:test'
import {
  createAgentsKilledMessage,
  createApiMetricsMessage,
  createAwaySummaryMessage,
  createBridgeStatusMessage,
  createCommandInputMessage,
  createCompactBoundaryMessage,
  createMemorySavedMessage,
  createMicrocompactBoundaryMessage,
  createPermissionRetryMessage,
  createScheduledTaskFireMessage,
  createStopHookSummaryMessage,
  createSystemAPIErrorMessage,
  createSystemMessage,
  createTurnDurationMessage,
  findLastCompactBoundaryIndex,
  getMessagesAfterCompactBoundary,
  isCompactBoundaryMessage,
} from './systemFactories.js'
import type { Message } from '../../types/message.js'

test('createSystemMessage builds an informational system message', () => {
  const message = createSystemMessage('ready', 'info', 'toolu_1', true)

  expect(message).toMatchObject({
    type: 'system',
    subtype: 'informational',
    content: 'ready',
    level: 'info',
    toolUseID: 'toolu_1',
    preventContinuation: true,
  })
})

test('system factory helpers build their expected message shapes', () => {
  expect(createPermissionRetryMessage(['Bash(ls)', 'Read(*)'])).toMatchObject({
    type: 'system',
    subtype: 'permission_retry',
    content: 'Allowed Bash(ls), Read(*)',
    commands: ['Bash(ls)', 'Read(*)'],
    level: 'info',
    isMeta: false,
  })
  expect(createBridgeStatusMessage('https://remote.test', 'upgrade')).toMatchObject({
    type: 'system',
    subtype: 'bridge_status',
    content: '/remote-control is active. Code in CLI or at https://remote.test',
    url: 'https://remote.test',
    upgradeNudge: 'upgrade',
  })
  expect(createScheduledTaskFireMessage('run task')).toMatchObject({
    type: 'system',
    subtype: 'scheduled_task_fire',
    content: 'run task',
    isMeta: false,
  })
  expect(
    createStopHookSummaryMessage(
      2,
      [{ hookName: 'stop', command: 'echo ok', matcher: undefined }],
      ['failed'],
      true,
      'stop_sequence',
      true,
      'warning',
      'toolu_stop',
      'Stop',
      123,
    ),
  ).toMatchObject({
    type: 'system',
    subtype: 'stop_hook_summary',
    hookCount: 2,
    hookErrors: ['failed'],
    preventedContinuation: true,
    stopReason: 'stop_sequence',
    hasOutput: true,
    level: 'warning',
    toolUseID: 'toolu_stop',
    hookLabel: 'Stop',
    totalDurationMs: 123,
  })
  expect(
    createTurnDurationMessage(
      250,
      { tokens: 10, limit: 100, nudges: 1 },
      4,
    ),
  ).toMatchObject({
    type: 'system',
    subtype: 'turn_duration',
    durationMs: 250,
    budgetTokens: 10,
    budgetLimit: 100,
    budgetNudges: 1,
    messageCount: 4,
    isMeta: false,
  })
  expect(createAwaySummaryMessage('away')).toMatchObject({
    type: 'system',
    subtype: 'away_summary',
    content: 'away',
    isMeta: false,
  })
  expect(createMemorySavedMessage(['/tmp/memory.md'])).toMatchObject({
    type: 'system',
    subtype: 'memory_saved',
    writtenPaths: ['/tmp/memory.md'],
    isMeta: false,
  })
  expect(createAgentsKilledMessage()).toMatchObject({
    type: 'system',
    subtype: 'agents_killed',
    isMeta: false,
  })
  expect(
    createApiMetricsMessage({
      ttftMs: 12,
      otps: 34,
      isP50: true,
      hookDurationMs: 5,
      turnDurationMs: 6,
      toolDurationMs: 7,
      classifierDurationMs: 8,
      toolCount: 2,
      hookCount: 3,
      classifierCount: 1,
      configWriteCount: 4,
    }),
  ).toMatchObject({
    type: 'system',
    subtype: 'api_metrics',
    ttftMs: 12,
    otps: 34,
    isP50: true,
    hookDurationMs: 5,
    turnDurationMs: 6,
    toolDurationMs: 7,
    classifierDurationMs: 8,
    toolCount: 2,
    hookCount: 3,
    classifierCount: 1,
    configWriteCount: 4,
    isMeta: false,
  })
  expect(createCommandInputMessage('<command-name>test</command-name>')).toMatchObject({
    type: 'system',
    subtype: 'local_command',
    content: '<command-name>test</command-name>',
    level: 'info',
    isMeta: false,
  })
})

test('microcompact and API error factories preserve branch-specific fields', () => {
  const microcompact = createMicrocompactBoundaryMessage(
    'auto',
    1000,
    250,
    ['toolu_1'],
    ['attachment_1'],
  )
  expect(microcompact).toMatchObject({
    type: 'system',
    subtype: 'microcompact_boundary',
    content: 'Context microcompacted',
    level: 'info',
    isMeta: false,
    microcompactMetadata: {
      trigger: 'auto',
      preTokens: 1000,
      tokensSaved: 250,
      compactedToolIds: ['toolu_1'],
      clearedAttachmentUUIDs: ['attachment_1'],
    },
  })

  const cause = new Error('network down')
  const errorWithCause = { message: 'api failed', cause } as Parameters<typeof createSystemAPIErrorMessage>[0]
  expect(createSystemAPIErrorMessage(errorWithCause, 100, 2, 5)).toMatchObject({
    type: 'system',
    subtype: 'api_error',
    level: 'error',
    error: errorWithCause,
    cause,
    retryInMs: 100,
    retryAttempt: 2,
    maxRetries: 5,
  })

  const errorWithoutErrorCause = { message: 'api failed', cause: 'string cause' } as Parameters<typeof createSystemAPIErrorMessage>[0]
  expect(
    createSystemAPIErrorMessage(errorWithoutErrorCause, 200, 1, 3).cause,
  ).toBeUndefined()
})

test('compact boundary helpers find and slice from the latest boundary', () => {
  const first = createSystemMessage('old', 'info')
  const boundary = createCompactBoundaryMessage('manual', 100)
  const last = createSystemMessage('new', 'info')

  expect(isCompactBoundaryMessage(boundary)).toBe(true)
  expect(findLastCompactBoundaryIndex([first, boundary, last])).toBe(1)
  expect(getMessagesAfterCompactBoundary([first, boundary, last])).toEqual([
    boundary,
    last,
  ])
})

test('compact boundary slicing also applies snip projection when enabled', () => {
  const removed = createSystemMessage('removed', 'info')
  const kept = createSystemMessage('kept', 'info')
  const snipBoundary = {
    ...createSystemMessage('snipped', 'info'),
    subtype: 'snip_boundary',
    snipMetadata: { removedUuids: [removed.uuid] },
  } as Message

  const messages = [removed, snipBoundary, kept]
  const result = getMessagesAfterCompactBoundary(messages)

  if (feature('HISTORY_SNIP')) {
    expect(result).toEqual([snipBoundary, kept])
  } else {
    expect(result).toEqual(messages)
  }

  expect(getMessagesAfterCompactBoundary(messages, { includeSnipped: true })).toEqual(
    messages,
  )
})
