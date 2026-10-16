import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeFileSync } from 'fs'

import * as analyticsNs from '../services/analytics/index.js'
import type { QueryParams } from '../query.js'
import type { QueryDeps } from './deps.js'
import {
  createAssistantMessage,
  createUserMessage,
} from '../utils/messages.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'
import {
  setClaudeConfigHomeDirForTesting,
} from '../utils/envUtils.js'
import { resetSettingsCache } from '../utils/settings/settingsCache.js'

// Failover analytics are part of the contract: capture logEvent calls so the
// test can assert tengu_model_auto_failover_triggered. query.ts imports the
// module as 'src/services/analytics/index.js' while other files spell it
// relatively — bun keys mock.module() by specifier string, so both spellings
// are registered (same reason promptCacheBreakDetection.test.ts mocks both
// spellings of debug.js). Must run BEFORE '../query.js' is imported below.
const events: Array<{ name: string; metadata: Record<string, unknown> }> = []
const captureLogEvent = (name: string, metadata?: Record<string, unknown>) => {
  events.push({ name, metadata: metadata ?? {} })
}
mock.module('../services/analytics/index.js', () => ({
  ...analyticsNs,
  logEvent: captureLogEvent,
}))
mock.module('src/services/analytics/index.js', () => ({
  ...analyticsNs,
  logEvent: captureLogEvent,
}))

// Import after the mocks so query.js binds the capturing logEvent.
const { query } = await import('../query.js')

// The mock registry is process-global: hand the real module back to any test
// file that runs after this one (branch.test.ts does the same in afterEach).
afterAll(() => {
  mock.module('../services/analytics/index.js', () => ({ ...analyticsNs }))
  mock.module('src/services/analytics/index.js', () => ({ ...analyticsNs }))
})

function makeToolUseContext(): QueryParams['toolUseContext'] {
  const abortController = new AbortController()
  let inProgressToolUseIDs = new Set<string>()

  return {
    abortController,
    getAppState: () => ({
      fastMode: false,
      mcp: { tools: {}, clients: [] },
      toolPermissionContext: { mode: 'default' },
      sessionHooks: new Map(),
      mainLoopModel: 'gpt-4o',
      effortValue: undefined,
      advisorModel: undefined,
    }),
    options: {
      commands: [],
      debug: false,
      thinkingConfig: { type: 'disabled' },
      tools: [],
      verbose: false,
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [], allowedAgentTypes: undefined },
      appendSystemPrompt: undefined,
      providerOverride: undefined,
      mainLoopModel: 'gpt-4o',
    },
    addNotification: () => {},
    messages: [],
    setInProgressToolUseIDs: updater => {
      inProgressToolUseIDs = updater(inProgressToolUseIDs)
    },
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as QueryParams['toolUseContext']
}

function makeParams(
  callModel: QueryDeps['callModel'],
): QueryParams {
  return {
    messages: [createUserMessage({ content: 'hello' })],
    systemPrompt: asSystemPrompt([]),
    userContext: {},
    systemContext: {},
    canUseTool: async () => ({ behavior: 'allow' }),
    toolUseContext: makeToolUseContext(),
    querySource: 'sdk',
    deps: {
      callModel,
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({
        compactionResult: null,
        consecutiveFailures: undefined,
      }),
      uuid: () => '00000000-0000-4000-8000-000000000000',
    } as unknown as QueryDeps,
  }
}

async function collect(params: QueryParams): Promise<any[]> {
  const previousSimple = process.env.CLAUDE_CODE_SIMPLE
  process.env.CLAUDE_CODE_SIMPLE = '1'
  const messages: any[] = []
  try {
    for await (const message of query(params)) {
      messages.push(message)
    }
  } finally {
    if (previousSimple === undefined) {
      delete process.env.CLAUDE_CODE_SIMPLE
    } else {
      process.env.CLAUDE_CODE_SIMPLE = previousSimple
    }
  }
  return messages
}

test('switches model, retries, and emits tengu_model_auto_failover_triggered on enriched error', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'oc-failover-'))
  setClaudeConfigHomeDirForTesting(tempDir)
  resetSettingsCache()
  writeFileSync(
    join(tempDir, 'settings.json'),
    JSON.stringify({ autoModelFailover: true }),
  )
  resetSettingsCache()

  const seenModels: string[] = []
  const callModel: QueryDeps['callModel'] = async function* ({ options }) {
    seenModels.push(String(options?.model ?? ''))
    if (seenModels.length === 1) {
      const err = new Error('Stream idle timeout - no chunks received')
      ;(err as any).streamIdleAborted = true
      throw err
    }
    yield createAssistantMessage({ content: 'ok after failover' })
  }

  const messages = await collect(makeParams(callModel))

  expect(seenModels.length).toBe(2)
  expect(seenModels[0]).not.toBe(seenModels[1])
  expect(
    messages.some(
      (m: any) =>
        m?.type === 'system' &&
        typeof m?.content === 'string' &&
        m.content.includes('Auto failover'),
    ),
  ).toBe(true)
  expect(
    messages.some(
      (m: any) =>
        m?.type === 'assistant' &&
        m?.message?.content?.[0]?.text === 'ok after failover',
    ),
  ).toBe(true)

  // The failover must be reported to analytics with both models and a reason.
  const failoverEvents = events.filter(
    e => e.name === 'tengu_model_auto_failover_triggered',
  )
  expect(failoverEvents.length).toBe(1)
  const metadata = failoverEvents[0].metadata
  expect(metadata.original_model).toBe(seenModels[0])
  expect(metadata.next_model).toBe(seenModels[1])
  expect(metadata.entrypoint).toBe('cli')
  expect(typeof metadata.reason).toBe('string')
  expect(String(metadata.reason).length).toBeGreaterThan(0)
})
