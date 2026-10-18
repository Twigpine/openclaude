import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getAllowedSettingSources,
  getFlagSettingsInline,
  getFlagSettingsPath,
  isSessionPersistenceDisabled,
  setAllowedSettingSources,
  setFlagSettingsInline,
  setFlagSettingsPath,
  setSessionPersistenceDisabled,
} from '../../bootstrap/state.js'
import type { SDKMessage } from '../../entrypoints/agentSdkTypes.js'
import type { AppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import {
  addToTotalSessionCost,
  formatTotalCost,
  resetCostState,
} from '../../cost-tracker.js'
import {
  calculateCostFromTokens,
  calculateUSDCost,
} from '../../utils/modelCost.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

const paidModel = 'provider/paid-model'
const freeModel = 'nvidia/free-model'
const usage = {
  input_tokens: 10_000,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

let requestedModel = paidModel

mock.module('../../utils/processUserInput/processUserInput.js', () => ({
  processUserInput: mock(async () => ({
    messages: [
      {
        type: 'user',
        message: { role: 'user', content: 'run' },
        isMeta: false,
        uuid: `user-${Math.random()}`,
        timestamp: new Date().toISOString(),
      } as Message,
    ],
    shouldQuery: true,
    allowedTools: [],
    model: requestedModel,
    resultText: undefined,
  })),
}))
mock.module('../../utils/queryContext.js', () => ({
  fetchSystemPromptParts: mock(async () => ({
    defaultSystemPrompt: [],
    userContext: {},
    systemContext: {},
  })),
}))
mock.module('../../utils/messages/systemInit.js', () => ({
  buildSystemInitMessage: mock((input: { model: string }) => ({
    type: 'system',
    subtype: 'init',
    session_id: 'test-session',
    tools: [],
    mcp_servers: [],
    model: input.model,
    permissionMode: 'default',
    apiKeySource: 'none',
    cwd: process.cwd(),
  })),
  sdkCompatToolName: (name: string) => name,
}))
mock.module('../../commands.js', () => ({
  REMOTE_SAFE_COMMANDS: new Set<string>(),
  builtInCommandNames: new Set<string>(),
  clearCommandsCache: () => {},
  findCommand: () => undefined,
  getCommand: () => undefined,
  getCommandName: (command: { name?: string }) => command.name ?? '',
  getCommands: () => [],
  getMcpSkillCommands: () => [],
  getSkillToolCommands: () => [],
  getSlashCommandToolSkills: mock(async () => []),
  hasCommand: () => false,
  isCommandEnabled: () => true,
}))
mock.module('src/entrypoints/agentSdkTypes.js', () => ({ HOOK_EVENTS: [] }))

async function* pricedQuery({
  toolUseContext,
}: {
  toolUseContext: { options: { mainLoopModel: string } }
}): AsyncGenerator<Message> {
  const model = toolUseContext.options.mainLoopModel
  const cost = calculateUSDCost(model, usage as never)
  addToTotalSessionCost(cost, usage as never, model)
  yield {
    type: 'assistant',
    message: {
      id: `msg-${Math.random()}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage,
    },
    uuid: `assistant-${Math.random()}`,
    timestamp: new Date().toISOString(),
  } as Message
}

async function runCase(
  QueryEngine: typeof import('../../QueryEngine.js').QueryEngine,
  model: string,
  maxBudgetUsd: number,
): Promise<Extract<SDKMessage, { type: 'result' }>> {
  requestedModel = model
  let appState = {
    fastMode: false,
    toolPermissionContext: {
      mode: 'default',
      additionalWorkingDirectories: new Map(),
      alwaysAllowRules: {},
    },
    fileHistory: {},
    attribution: {},
  } as unknown as AppState
  const engine = new QueryEngine({
    cwd: fixtureDir,
    tools: [],
    commands: [],
    mcpClients: [],
    agents: [],
    canUseTool: async () => ({ behavior: 'allow' }),
    getAppState: () => appState,
    setAppState: update => {
      appState = update(appState)
    },
    readFileCache: {} as never,
    userSpecifiedModel: model,
    thinkingConfig: { type: 'disabled' },
    maxBudgetUsd,
    query: pricedQuery as never,
  })
  const events: SDKMessage[] = []
  for await (const event of engine.submitMessage('run')) events.push(event)
  const result = events.findLast(
    (event): event is Extract<SDKMessage, { type: 'result' }> =>
      event.type === 'result',
  )
  assert.ok(result)
  return result
}

const originalPersistence = isSessionPersistenceDisabled()
const originalSources = [...getAllowedSettingSources()]
const originalFlagPath = getFlagSettingsPath()
const originalFlagInline = getFlagSettingsInline()
const fixtureDir = mkdtempSync(join(tmpdir(), 'openclaude-query-budget-'))
const settingsPath = join(fixtureDir, 'settings.json')

try {
  writeFileSync(
    settingsPath,
    `${JSON.stringify({
      modelPricing: {
        [paidModel]: {
          inputTokens: 100,
          outputTokens: 0,
          promptCacheReadTokens: 0,
          promptCacheWriteTokens: 0,
          webSearchRequests: 0,
        },
        [freeModel]: {
          inputTokens: 0,
          outputTokens: 0,
          promptCacheReadTokens: 0,
          promptCacheWriteTokens: 0,
          webSearchRequests: 0,
        },
      },
    })}\n`,
    'utf8',
  )
  setSessionPersistenceDisabled(true)
  setAllowedSettingSources(['flagSettings'])
  setFlagSettingsPath(settingsPath)
  setFlagSettingsInline(null)
  resetSettingsCache()

  const { QueryEngine } = await import('../../QueryEngine.js')

  resetCostState()
  const paid = await runCase(QueryEngine, paidModel, 0.5)
  assert.equal(paid.subtype, 'error_max_budget_usd')
  assert.equal(paid.total_cost_usd, 1)
  assert.equal(paid.modelUsage[paidModel]?.costUSD, 1)
  assert.equal(
    calculateCostFromTokens(paidModel, {
      inputTokens: 10_000,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    }),
    1,
  )
  assert.match(formatTotalCost(), /Total cost:\s+\$1\.00/)
  assert.match(formatTotalCost(), /provider\/paid-model:.*\(\$1\.00\)/s)
  assert.match(JSON.stringify(paid), /"total_cost_usd":1/)

  resetCostState()
  const free = await runCase(QueryEngine, freeModel, 0.01)
  assert.equal(free.subtype, 'success')
  assert.equal(free.total_cost_usd, 0)
  assert.equal(free.modelUsage[freeModel]?.costUSD, 0)
  assert.equal(free.modelUsage[freeModel]?.inputTokens, 10_000)
} finally {
  mock.restore()
  resetCostState()
  setSessionPersistenceDisabled(originalPersistence)
  setAllowedSettingSources(originalSources)
  setFlagSettingsPath(originalFlagPath)
  setFlagSettingsInline(originalFlagInline)
  resetSettingsCache()
  rmSync(fixtureDir, { recursive: true, force: true })
}
