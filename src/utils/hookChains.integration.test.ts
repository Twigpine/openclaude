import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

import * as realTeammate from './teammate.js'

const realTeammateSnapshot = { ...realTeammate }

type HookChainsModule = typeof import('./hookChains.js')
type ImportHarnessOptions = {
  allowRemoteSessions?: boolean
  teamFile?:
    | {
        name: string
        members: Array<{ name: string }>
      }
    | null
  teamName?: string
  senderName?: string
  replBridgeHandle?: unknown
}

const tempDirs: string[] = []
const originalHookChainsEnabled = process.env.CLAUDE_CODE_ENABLE_HOOK_CHAINS

async function createConfigFile(config: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'openclaude-hook-chains-int-'))
  tempDirs.push(dir)
  const filePath = join(dir, 'hook-chains.json')
  await writeFile(filePath, JSON.stringify(config, null, 2), 'utf-8')
  return filePath
}

// Cache-busted imports of the real modules so mock.module can spread them.
// This prevents partial mocks from breaking transitive imports in other test
// files that run after this one (mock.module is process-global and
// mock.restore does not fully undo module mocks in Bun).
async function importRealModules() {
  const ts = Date.now()
  const rand = Math.random()
  return {
    analytics: await import(`../services/analytics/index.js?real=${ts}-${rand}`) as typeof import('../services/analytics/index.js'),
    events: await import(`./telemetry/events.js?real=${ts}-${rand}`) as typeof import('./telemetry/events.js'),
    policyLimits: await import(`../services/policyLimits/index.js?real=${ts}-${rand}`) as typeof import('../services/policyLimits/index.js'),
    teamHelpers: await import(`./swarm/teamHelpers.js?real=${ts}-${rand}`) as typeof import('./swarm/teamHelpers.js'),
    teammateMailbox: await import(`./teammateMailbox.js?real=${ts}-${rand}`) as typeof import('./teammateMailbox.js'),
    replBridge: await import(`../bridge/replBridgeHandle.js?real=${ts}-${rand}`) as typeof import('../bridge/replBridgeHandle.js'),
    agentTool: await import(`../tools/AgentTool/AgentTool.js?real=${ts}-${rand}`) as typeof import('../tools/AgentTool/AgentTool.js'),
  }
}

async function restorePersistentModuleMocks(): Promise<void> {
  const real = await importRealModules()
  mock.module('../services/analytics/index.js', () => real.analytics)
  mock.module('./telemetry/events.js', () => real.events)
  mock.module('../services/policyLimits/index.js', () => real.policyLimits)
  mock.module('./swarm/teamHelpers.js', () => real.teamHelpers)
  mock.module('./teammateMailbox.js', () => real.teammateMailbox)
  mock.module('./teammate.js', () => realTeammateSnapshot)
  mock.module('../bridge/replBridgeHandle.js', () => real.replBridge)
  mock.module('../tools/AgentTool/AgentTool.js', () => real.agentTool)
}

async function importHookChainsHarness(
  options: ImportHarnessOptions = {},
): Promise<{
  mod: HookChainsModule
  writeToMailboxSpy: ReturnType<typeof mock>
  agentToolCallSpy: ReturnType<typeof mock>
}> {
  mock.restore()

  const allowRemoteSessions = options.allowRemoteSessions ?? true
  const teamName = options.teamName ?? 'mesh-team'
  const senderName = options.senderName ?? 'mesh-lead'
  const replBridgeHandle = options.replBridgeHandle ?? null

  const writeToMailboxSpy = mock(async () => {})
  const agentToolCallSpy = mock(async () => ({
    data: {
      status: 'async_launched',
      agentId: 'agent-fallback-1',
    },
  }))
  const real = await importRealModules()

  mock.module('../services/analytics/index.js', () => ({
    ...real.analytics,
    logEvent: () => {},
  }))

  mock.module('./telemetry/events.js', () => ({
    ...real.events,
    logOTelEvent: async () => {},
  }))

  mock.module('../services/policyLimits/index.js', () => ({
    ...real.policyLimits,
    isPolicyAllowed: () => allowRemoteSessions,
  }))

  mock.module('./swarm/teamHelpers.js', () => ({
    ...real.teamHelpers,
    readTeamFileAsync: async () => options.teamFile ?? null,
  }))

  mock.module('./teammateMailbox.js', () => ({
    ...real.teammateMailbox,
    writeToMailbox: writeToMailboxSpy,
  }))

  mock.module('./teammate.js', () => ({
    ...realTeammateSnapshot,
    getAgentName: () => senderName,
    getTeamName: () => teamName,
    getTeammateColor: () => 'blue',
  }))

  mock.module('../bridge/replBridgeHandle.js', () => ({
    ...real.replBridge,
    getReplBridgeHandle: () => replBridgeHandle,
  }))

  // Integration mock target requested in the task: fallback action can route
  // through this mocked tool launcher from runtime callback wiring.
  mock.module('../tools/AgentTool/AgentTool.js', () => ({
    ...real.agentTool,
    AgentTool: {
      ...real.agentTool.AgentTool,
      call: agentToolCallSpy,
    },
  }))

  const mod = await import(`./hookChains.js?integration=${Date.now()}-${Math.random()}`)
  return { mod, writeToMailboxSpy, agentToolCallSpy }
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/hookChains.integration.test.ts')
  process.env.CLAUDE_CODE_ENABLE_HOOK_CHAINS = '1'
})

afterEach(async () => {
  try {
    mock.restore()
    await restorePersistentModuleMocks()

    if (originalHookChainsEnabled === undefined) {
      delete process.env.CLAUDE_CODE_ENABLE_HOOK_CHAINS
    } else {
      process.env.CLAUDE_CODE_ENABLE_HOOK_CHAINS = originalHookChainsEnabled
    }

    await Promise.all(
      tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
    )
  } finally {
    releaseSharedMutationLock()
  }
})

describe('hookChains integration dispatch', () => {
  test('end-to-end rule evaluation + action dispatch on TaskCompleted failure', async () => {
    const { mod } = await importHookChainsHarness({
      teamName: 'mesh-team',
      senderName: 'mesh-lead',
      teamFile: {
        name: 'mesh-team',
        members: [{ name: 'mesh-lead' }, { name: 'worker-a' }, { name: 'worker-b' }],
      },
    })

    const configPath = await createConfigFile({
      version: 1,
      enabled: true,
      maxChainDepth: 3,
      defaultCooldownMs: 0,
      defaultDedupWindowMs: 0,
      rules: [
        {
          id: 'task-failure-recovery',
          trigger: { event: 'TaskCompleted', outcome: 'failed' },
          actions: [
            { type: 'spawn_fallback_agent' },
            { type: 'notify_team' },
          ],
        },
      ],
    })

    const spawnSpy = mock(async () => ({ launched: true, agentId: 'agent-e2e-1' }))
    const notifySpy = mock(async () => ({ sent: true, recipientCount: 2 }))

    const result = await mod.dispatchHookChainsForEvent({
      configPathOverride: configPath,
      event: {
        eventName: 'TaskCompleted',
        outcome: 'failed',
        payload: {
          task_id: 'task-001',
          task_subject: 'Patch flaky build',
          error: 'CI timeout',
        },
      },
      runtime: {
        onSpawnFallbackAgent: spawnSpy,
        onNotifyTeam: notifySpy,
      },
    })

    expect(result.enabled).toBe(true)
    expect(result.matchedRuleIds).toEqual(['task-failure-recovery'])
    expect(result.actionResults).toHaveLength(2)
    expect(result.actionResults[0]?.status).toBe('executed')
    expect(result.actionResults[1]?.status).toBe('executed')
    expect(spawnSpy).toHaveBeenCalledTimes(1)
    expect(notifySpy).toHaveBeenCalledTimes(1)
  })

  test('fallback spawn injects failure context into generated prompt', async () => {
    const { mod, agentToolCallSpy } = await importHookChainsHarness()

    const configPath = await createConfigFile({
      version: 1,
      enabled: true,
      maxChainDepth: 3,
      defaultCooldownMs: 0,
      defaultDedupWindowMs: 0,
      rules: [
        {
          id: 'fallback-context',
          trigger: { event: 'TaskCompleted', outcome: 'failed' },
          actions: [
            {
              type: 'spawn_fallback_agent',
              description: 'Fallback for failed task',
            },
          ],
        },
      ],
    })

    const result = await mod.dispatchHookChainsForEvent({
      configPathOverride: configPath,
      event: {
        eventName: 'TaskCompleted',
        outcome: 'failed',
        payload: {
          task_id: 'task-ctx-1',
          task_subject: 'Repair migration guard',
          task_description: 'Fix regression in check ordering',
          error: 'Task failed after retry budget exhausted',
        },
      },
      runtime: {
        onSpawnFallbackAgent: async request => {
          const { AgentTool } = await import('../tools/AgentTool/AgentTool.js')
          await (AgentTool.call as unknown as (...args: unknown[]) => Promise<unknown>)({
            prompt: request.prompt,
            description: request.description,
            run_in_background: request.runInBackground,
            subagent_type: request.agentType,
            model: request.model,
          })
          return { launched: true, agentId: 'agent-fallback-ctx' }
        },
      },
    })

    expect(result.actionResults[0]?.status).toBe('executed')
    expect(agentToolCallSpy).toHaveBeenCalledTimes(1)

    const callInput = agentToolCallSpy.mock.calls[0]?.[0] as {
      prompt: string
      description: string
      run_in_background: boolean
    }

    expect(callInput.description).toBe('Fallback for failed task')
    expect(callInput.run_in_background).toBe(true)
    expect(callInput.prompt).toContain('Event: TaskCompleted')
    expect(callInput.prompt).toContain('Outcome: failed')
    expect(callInput.prompt).toContain('Task subject: Repair migration guard')
    expect(callInput.prompt).toContain('Failure details: Task failed after retry budget exhausted')
  })

  test('notify_team dispatches mailbox writes when team exists and skips when absent', async () => {
    const withTeam = await importHookChainsHarness({
      teamName: 'mesh-a',
      senderName: 'lead-a',
      teamFile: {
        name: 'mesh-a',
        members: [{ name: 'lead-a' }, { name: 'worker-1' }, { name: 'worker-2' }],
      },
    })

    const configPathWithTeam = await createConfigFile({
      version: 1,
      enabled: true,
      maxChainDepth: 3,
      defaultCooldownMs: 0,
      defaultDedupWindowMs: 0,
      rules: [
        {
          id: 'notify-existing-team',
          trigger: { event: 'TaskCompleted', outcome: 'failed' },
          actions: [{ type: 'notify_team' }],
        },
      ],
    })

    const withTeamResult = await withTeam.mod.dispatchHookChainsForEvent({
      configPathOverride: configPathWithTeam,
      event: {
        eventName: 'TaskCompleted',
        outcome: 'failed',
        payload: { task_id: 'task-team-ok', error: 'boom' },
      },
    })

    expect(withTeamResult.actionResults[0]?.status).toBe('executed')
    expect(withTeam.writeToMailboxSpy).toHaveBeenCalledTimes(2)

    const recipients = withTeam.writeToMailboxSpy.mock.calls.map(
      call => call[0] as string,
    )
    expect(recipients.sort()).toEqual(['worker-1', 'worker-2'])

    const withoutTeam = await importHookChainsHarness({
      teamName: 'mesh-missing',
      senderName: 'lead-missing',
      teamFile: null,
    })

    const configPathWithoutTeam = await createConfigFile({
      version: 1,
      enabled: true,
      maxChainDepth: 3,
      defaultCooldownMs: 0,
      defaultDedupWindowMs: 0,
      rules: [
        {
          id: 'notify-missing-team',
          trigger: { event: 'TaskCompleted', outcome: 'failed' },
          actions: [{ type: 'notify_team' }],
        },
      ],
    })

    const withoutTeamResult = await withoutTeam.mod.dispatchHookChainsForEvent({
      configPathOverride: configPathWithoutTeam,
      event: {
        eventName: 'TaskCompleted',
        outcome: 'failed',
        payload: { task_id: 'task-team-missing', error: 'boom' },
      },
    })

    expect(withoutTeamResult.actionResults[0]?.status).toBe('skipped')
    expect(withoutTeamResult.actionResults[0]?.reason).toContain('Team file not found')
    expect(withoutTeam.writeToMailboxSpy).not.toHaveBeenCalled()
  })

  test('warm_remote_capacity is a safe no-op when bridge is inactive', async () => {
    const { mod } = await importHookChainsHarness({
      allowRemoteSessions: true,
      replBridgeHandle: null,
    })

    const configPath = await createConfigFile({
      version: 1,
      enabled: true,
      maxChainDepth: 3,
      defaultCooldownMs: 0,
      defaultDedupWindowMs: 0,
      rules: [
        {
          id: 'bridge-warmup-noop',
          trigger: { event: 'TaskCompleted', outcome: 'failed' },
          actions: [{ type: 'warm_remote_capacity' }],
        },
      ],
    })

    const result = await mod.dispatchHookChainsForEvent({
      configPathOverride: configPath,
      event: {
        eventName: 'TaskCompleted',
        outcome: 'failed',
        payload: { task_id: 'task-warm-1' },
      },
    })

    expect(result.actionResults).toHaveLength(1)
    expect(result.actionResults[0]?.status).toBe('skipped')
    expect(result.actionResults[0]?.reason).toContain('Bridge is not active')
  })
})
