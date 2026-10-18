import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  isSessionPersistenceDisabled,
  setSessionPersistenceDisabled,
} from '../../bootstrap/state.js'
import type { AutoCompactTrackingState } from '../../services/compact/autoCompact.js'
import type { AppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'

function compactBoundaryMessage(): Message {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    level: 'info',
    compactMetadata: {
      trigger: 'manual',
      preTokens: 100_000,
    },
  }
}

async function drain(generator: AsyncGenerator<unknown>): Promise<void> {
  for await (const _event of generator) {
    // Drain the SDK generator so submitMessage completes.
  }
}

const savedSessionPersistenceDisabled = isSessionPersistenceDisabled()
const fixtureCwd = mkdtempSync(
  join(tmpdir(), 'openclaude-query-engine-cooldown-'),
)

try {
  const trippedTracking: AutoCompactTrackingState = {
    compacted: false,
    turnCounter: 0,
    turnId: 'turn',
    consecutiveFailures: 3,
    nextRetryAtMs: Date.now() + 60_000,
    lastFailureAtMs: Date.now(),
  }
  const processUserInputResults = [
    {
      messages: [compactBoundaryMessage()],
      shouldQuery: false,
      allowedTools: [],
      model: undefined,
      resultText: 'compacted',
    },
  ]

  mock.module('../../utils/processUserInput/processUserInput.js', () => ({
    processUserInput: mock(async () => {
      const result = processUserInputResults.shift()
      if (!result) {
        throw new Error('unexpected processUserInput call')
      }
      return result
    }),
  }))
  mock.module('../../utils/queryContext.js', () => ({
    fetchSystemPromptParts: mock(async () => ({
      defaultSystemPrompt: [],
      userContext: {},
      systemContext: {},
    })),
  }))
  mock.module('../../utils/messages/systemInit.js', () => ({
    buildSystemInitMessage: mock(() => ({
      type: 'system',
      subtype: 'init',
      session_id: 'test-session',
      tools: [],
      mcp_servers: [],
      model: 'claude-sonnet-4',
      permissionMode: 'default',
      apiKeySource: 'none',
      cwd: fixtureCwd,
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
  mock.module('src/entrypoints/agentSdkTypes.js', () => ({
    HOOK_EVENTS: [],
  }))
  setSessionPersistenceDisabled(true)

  const { QueryEngine } = await import('../../QueryEngine.js')
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
    cwd: fixtureCwd,
    tools: [],
    commands: [],
    mcpClients: [],
    agents: [],
    canUseTool: async () => ({ behavior: 'allow' }),
    getAppState: () => appState,
    setAppState: updater => {
      appState = updater(appState)
    },
    readFileCache: {} as never,
    userSpecifiedModel: 'claude-sonnet-4',
    thinkingConfig: { type: 'disabled' },
  })
  ;(
    engine as unknown as {
      autoCompactTracking?: AutoCompactTrackingState
    }
  ).autoCompactTracking = trippedTracking

  await drain(engine.submitMessage('/compact'))

  assert.equal(
    (
      engine as unknown as {
        autoCompactTracking?: AutoCompactTrackingState
      }
    ).autoCompactTracking,
    undefined,
  )
} finally {
  mock.restore()
  setSessionPersistenceDisabled(savedSessionPersistenceDisabled)
  rmSync(fixtureCwd, { recursive: true, force: true })
}
