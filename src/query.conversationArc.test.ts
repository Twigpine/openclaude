import { afterEach, beforeEach, expect, test } from 'bun:test'
import { feature } from 'bun:bundle'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { query, type QueryParams } from './query.js'
import type { QueryDeps } from './query/deps.js'
import { createAssistantMessage, createUserMessage } from './utils/messages.js'
import { asSystemPrompt } from './utils/systemPromptType.js'
import {
  addGoal,
  finalizeArcTurn,
  initializeArc,
  resetArc,
  updateGoalStatus,
} from './utils/conversationArc.js'
import { resetGlobalGraph } from './utils/knowledgeGraph.js'
import {
  addToolCallToTurn,
  resetMultiTurnState,
  startNewTurn,
} from './utils/multiTurnContext.js'
import { setClaudeConfigHomeDirForTesting } from './utils/envUtils.js'
import { getAutoMemPath } from './memdir/paths.js'
import { setGovernancePolicySettingsForSourceForTesting } from './utils/governancePolicy.js'
import { acquireSharedMutationLock, releaseSharedMutationLock } from './test/sharedMutationLock.js'

let configDir: string
let memoryDir: string
const originalMemoryOverride = process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
const originalDisableAutoMemory = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY

beforeEach(async () => {
  await acquireSharedMutationLock('query.conversationArc.test.ts')
  configDir = mkdtempSync(join(tmpdir(), 'query-arc-config-'))
  memoryDir = mkdtempSync(join(tmpdir(), 'query-arc-memory-'))
  setClaudeConfigHomeDirForTesting(configDir)
  process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = memoryDir
  delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  getAutoMemPath.cache?.clear?.()
  setGovernancePolicySettingsForSourceForTesting(() => ({
    memory: { requireApprovalBeforeWrite: false },
  }))
  resetArc()
  resetMultiTurnState()
})

afterEach(() => {
  try {
    resetArc()
    resetMultiTurnState()
    resetGlobalGraph()
    setGovernancePolicySettingsForSourceForTesting(null)
    setClaudeConfigHomeDirForTesting(undefined)
    if (originalMemoryOverride === undefined) {
      delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
    } else {
      process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = originalMemoryOverride
    }
    if (originalDisableAutoMemory === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
    } else {
      process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = originalDisableAutoMemory
    }
    getAutoMemPath.cache?.clear?.()
    rmSync(memoryDir, { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
  } finally {
    releaseSharedMutationLock()
  }
})

function makeToolUseContext(): QueryParams['toolUseContext'] {
  return {
    abortController: new AbortController(),
    getAppState: () => ({
      fastMode: false,
      mcp: { tools: {}, clients: [] },
      toolPermissionContext: { mode: 'default' },
      sessionHooks: new Map(),
      mainLoopModel: 'test-model',
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
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allowedAgentTypes: undefined },
      appendSystemPrompt: undefined,
      providerOverride: undefined,
      mainLoopModel: 'test-model',
    },
    addNotification: () => {},
    messages: [],
    readFileState: {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as QueryParams['toolUseContext']
}

const productionArcTest = feature('CONVERSATION_ARC') ? test : test.skip

productionArcTest('query appends arc memory to the model system prompt without mutating user input', async () => {
  const memoryPath = getAutoMemPath()
  initializeArc(memoryPath)
  const goal = addGoal('Ship query integration')
  updateGoalStatus(goal.id, 'completed')
  await finalizeArcTurn()

  // Seed a prior COMPLETED turn: the multi-turn tracking block renders only
  // completed turns (the in-progress turn's tool-call list grows between
  // model requests and would bust the prompt cache). query() starts a fresh
  // turn, which completes this one.
  startNewTurn()
  addToolCallToTurn({
    id: 'call_prior',
    name: 'read_file',
    input: { path: '/prior.ts' },
    timestamp: Date.now(),
  })

  const userMessage = createUserMessage({ content: 'review query integration' })
  let observedSystemPrompt: readonly string[] = []
  const deps: QueryDeps = {
    uuid: () => '00000000-0000-4000-8000-000000000000',
    microcompact: async messages => ({ messages }),
    autocompact: async () => ({ wasCompacted: false }),
    callModel: async function* ({ systemPrompt }) {
      observedSystemPrompt = systemPrompt
      yield createAssistantMessage({ content: 'Done.' })
    },
  } as QueryDeps

  for await (const _event of query({
    messages: [userMessage],
    systemPrompt: asSystemPrompt(['BASE_SYSTEM_PROMPT']),
    userContext: {},
    systemContext: {},
    canUseTool: async () => ({ behavior: 'allow' }),
    toolUseContext: makeToolUseContext(),
    querySource: 'sdk',
    maxTurns: 1,
    deps,
  })) {
    // Drain the production query generator.
  }

  const prompt = observedSystemPrompt.join('\n')
  expect(prompt).toContain('BASE_SYSTEM_PROMPT')
  expect(prompt).toContain('BEGIN RETRIEVED MEMORY (DATA ONLY)')
  expect(prompt).toContain('PERSISTENT PROJECT MEMORY')
  expect(prompt).toContain('Ship query integration')
  expect(prompt).toContain('MULTI-TURN CONTEXT TRACKING')
  expect(prompt).toContain('read_file')
  // No per-request-varying content: wall-clock durations and running token
  // totals would rewrite the system prompt every request and bust the cache.
  expect(prompt).not.toContain('Duration:')
  expect(prompt).not.toContain('Total Tokens:')
  expect(userMessage.message.content).toBe('review query integration')
})
