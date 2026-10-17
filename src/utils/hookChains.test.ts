import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

import * as policyLimits from '../services/policyLimits/index.js'

type HookChainsModule = typeof import('./hookChains.js')

const tempDirs: string[] = []
const originalHookChainsEnabled = process.env.CLAUDE_CODE_ENABLE_HOOK_CHAINS

/** Write a hook-chain fixture configuration in a temporary directory owned by the test. */
async function makeConfigFile(config: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'openclaude-hook-chains-'))
  tempDirs.push(dir)
  const filePath = join(dir, 'hook-chains.json')
  await writeFile(filePath, JSON.stringify(config, null, 2), 'utf-8')
  return filePath
}

/** Load a fresh hook-chain module with deterministic policy and telemetry behavior. */
async function importHookChainsModule(options?: {
  allowRemoteSessions?: boolean
}): Promise<HookChainsModule> {
  mock.restore()

  const allowRemoteSessions = options?.allowRemoteSessions ?? true

  mock.module('../services/analytics/index.js', () => ({
    logEvent: () => {},
  }))

  mock.module('./telemetry/events.js', () => ({
    logOTelEvent: async () => {},
  }))

  spyOn(policyLimits, 'isPolicyAllowed').mockImplementation(() => allowRemoteSessions)

  return import(`./hookChains.js?test=${Date.now()}-${Math.random()}`)
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/hookChains.test.ts')
  process.env.CLAUDE_CODE_ENABLE_HOOK_CHAINS = '1'
})

afterEach(async () => {
  try {
    mock.restore()

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

describe('hookChains schema validation', () => {
  test('returns disabled config when env gate is unset', async () => {
    delete process.env.CLAUDE_CODE_ENABLE_HOOK_CHAINS
    const mod = await importHookChainsModule()

    const configPath = await makeConfigFile({
      version: 1,
      enabled: true,
      rules: [
        {
          id: 'env-gated-rule',
          trigger: { event: 'TaskCompleted', outcome: 'failed' },
          actions: [{ type: 'spawn_fallback_agent' }],
        },
      ],
    })

    const loaded = mod.loadHookChainsConfig({ pathOverride: configPath })
    expect(loaded.exists).toBe(false)
    expect(loaded.config.enabled).toBe(false)
    expect(loaded.config.rules).toHaveLength(0)
  })

  test('loads valid config and memoizes by mtime/size', async () => {
    const mod = await importHookChainsModule()

    const configPath = await makeConfigFile({
      version: 1,
      enabled: true,
      maxChainDepth: 3,
      defaultCooldownMs: 5000,
      defaultDedupWindowMs: 5000,
      rules: [
        {
          id: 'task-failure-fallback',
          trigger: { event: 'TaskCompleted', outcome: 'failed' },
          actions: [
            {
              type: 'spawn_fallback_agent',
              description: 'Fallback recovery agent',
            },
          ],
        },
      ],
    })

    const first = mod.loadHookChainsConfig({ pathOverride: configPath })
    expect(first.exists).toBe(true)
    expect(first.error).toBeUndefined()
    expect(first.fromCache).toBe(false)
    expect(first.config.enabled).toBe(true)
    expect(first.config.rules).toHaveLength(1)
    expect(first.config.rules[0]?.id).toBe('task-failure-fallback')

    const second = mod.loadHookChainsConfig({ pathOverride: configPath })
    expect(second.exists).toBe(true)
    expect(second.error).toBeUndefined()
    expect(second.fromCache).toBe(true)
    expect(second.config.rules).toHaveLength(1)
  })

  test('accepts wrapped { hookChains: ... } config shape', async () => {
    const mod = await importHookChainsModule()

    const configPath = await makeConfigFile({
      hookChains: {
        version: 1,
        enabled: true,
        rules: [
          {
            id: 'wrapped-shape',
            trigger: { event: 'PostToolUseFailure', outcomes: ['failed'] },
            actions: [{ type: 'notify_team' }],
          },
        ],
      },
    })

    const loaded = mod.loadHookChainsConfig({ pathOverride: configPath })
    expect(loaded.error).toBeUndefined()
    expect(loaded.config.enabled).toBe(true)
    expect(loaded.config.rules[0]?.id).toBe('wrapped-shape')
  })

  test('returns disabled config for invalid schema', async () => {
    const mod = await importHookChainsModule()

    const configPath = await makeConfigFile({
      version: 1,
      enabled: true,
      rules: [
        {
          id: 'invalid-rule',
          trigger: {
            event: 'TaskCompleted',
            outcome: 'failed',
            outcomes: ['failed'],
          },
          actions: [{ type: 'spawn_fallback_agent' }],
        },
      ],
    })

    const loaded = mod.loadHookChainsConfig({ pathOverride: configPath })
    expect(loaded.exists).toBe(true)
    expect(loaded.error).toBeDefined()
    expect(loaded.config.enabled).toBe(false)
    expect(loaded.config.rules).toHaveLength(0)
  })
})

describe('evaluateHookChainRules', () => {
  test('matches by event + outcome + condition', async () => {
    const mod = await importHookChainsModule()

    const rules = [
      {
        id: 'post-tool-failure-rule',
        trigger: { event: 'PostToolUseFailure', outcome: 'failed' },
        condition: {
          toolNames: ['Edit'],
          errorIncludes: ['permission'],
          eventFieldEquals: { 'meta.source': 'scheduler' },
        },
        actions: [{ type: 'spawn_fallback_agent' }],
      },
    ]

    const matches = mod.evaluateHookChainRules(rules as never, {
      eventName: 'PostToolUseFailure',
      outcome: 'failed',
      payload: {
        tool_name: 'Edit',
        error: 'Permission denied by policy',
        meta: { source: 'scheduler' },
      },
    })

    expect(matches).toHaveLength(1)
    expect(matches[0]?.rule.id).toBe('post-tool-failure-rule')
  })

  test('does not match when event/condition fail', async () => {
    const mod = await importHookChainsModule()

    const rules = [
      {
        id: 'rule-no-match',
        trigger: { event: 'PostToolUseFailure', outcomes: ['failed'] },
        condition: { toolNames: ['Write'] },
        actions: [{ type: 'spawn_fallback_agent' }],
      },
    ]

    const wrongEvent = mod.evaluateHookChainRules(rules as never, {
      eventName: 'TaskCompleted',
      outcome: 'failed',
      payload: { tool_name: 'Write' },
    })
    expect(wrongEvent).toHaveLength(0)

    const wrongCondition = mod.evaluateHookChainRules(rules as never, {
      eventName: 'PostToolUseFailure',
      outcome: 'failed',
      payload: { tool_name: 'Edit' },
    })
    expect(wrongCondition).toHaveLength(0)
  })
})

describe('dispatchHookChainsForEvent guard logic', () => {
  test('dedup skips duplicate event/action within dedup window', async () => {
    const mod = await importHookChainsModule()

    const configPath = await makeConfigFile({
      version: 1,
      enabled: true,
      maxChainDepth: 4,
      defaultCooldownMs: 0,
      defaultDedupWindowMs: 60_000,
      rules: [
        {
          id: 'dedup-rule',
          trigger: { event: 'TaskCompleted', outcome: 'failed' },
          cooldownMs: 0,
          dedupWindowMs: 60_000,
          actions: [{ id: 'spawn-1', type: 'spawn_fallback_agent' }],
        },
      ],
    })

    const spawn = mock(async () => ({ launched: true, agentId: 'agent-1' }))

    const first = await mod.dispatchHookChainsForEvent({
      configPathOverride: configPath,
      event: {
        eventName: 'TaskCompleted',
        outcome: 'failed',
        payload: { task_id: 'task-123', error: 'boom' },
      },
      runtime: { onSpawnFallbackAgent: spawn },
    })

    const second = await mod.dispatchHookChainsForEvent({
      configPathOverride: configPath,
      event: {
        eventName: 'TaskCompleted',
        outcome: 'failed',
        payload: { task_id: 'task-123', error: 'boom' },
      },
      runtime: { onSpawnFallbackAgent: spawn },
    })

    expect(first.actionResults[0]?.status).toBe('executed')
    expect(second.actionResults[0]?.status).toBe('skipped')
    expect(second.actionResults[0]?.reason).toContain('dedup')
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  test('cooldown skips second dispatch when rule cooldown is active', async () => {
    const mod = await importHookChainsModule()

    const configPath = await makeConfigFile({
      version: 1,
      enabled: true,
      maxChainDepth: 4,
      defaultCooldownMs: 60_000,
      defaultDedupWindowMs: 0,
      rules: [
        {
          id: 'cooldown-rule',
          trigger: { event: 'TaskCompleted', outcome: 'failed' },
          cooldownMs: 60_000,
          dedupWindowMs: 0,
          actions: [{ type: 'spawn_fallback_agent' }],
        },
      ],
    })

    const spawn = mock(async () => ({ launched: true, agentId: 'agent-2' }))

    const first = await mod.dispatchHookChainsForEvent({
      configPathOverride: configPath,
      event: {
        eventName: 'TaskCompleted',
        outcome: 'failed',
        payload: { task_id: 'task-456' },
      },
      runtime: { onSpawnFallbackAgent: spawn },
    })

    const second = await mod.dispatchHookChainsForEvent({
      configPathOverride: configPath,
      event: {
        eventName: 'TaskCompleted',
        outcome: 'failed',
        payload: { task_id: 'task-789' },
      },
      runtime: { onSpawnFallbackAgent: spawn },
    })

    expect(first.actionResults[0]?.status).toBe('executed')
    expect(second.actionResults[0]?.status).toBe('skipped')
    expect(second.actionResults[0]?.reason).toContain('cooldown')
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  test('depth limit blocks dispatch when chain depth reaches max', async () => {
    const mod = await importHookChainsModule()

    const configPath = await makeConfigFile({
      version: 1,
      enabled: true,
      maxChainDepth: 1,
      defaultCooldownMs: 0,
      defaultDedupWindowMs: 0,
      rules: [
        {
          id: 'depth-rule',
          trigger: { event: 'TaskCompleted', outcome: 'failed' },
          actions: [{ type: 'spawn_fallback_agent' }],
        },
      ],
    })

    const spawn = mock(async () => ({ launched: true, agentId: 'agent-3' }))

    const result = await mod.dispatchHookChainsForEvent({
      configPathOverride: configPath,
      event: {
        eventName: 'TaskCompleted',
        outcome: 'failed',
        payload: { task_id: 'task-depth' },
      },
      runtime: {
        chainDepth: 1,
        onSpawnFallbackAgent: spawn,
      },
    })

    expect(result.enabled).toBe(true)
    expect(result.matchedRuleIds).toHaveLength(0)
    expect(result.actionResults).toHaveLength(0)
    expect(spawn).not.toHaveBeenCalled()
  })
})

describe('action dispatch skip scenarios', () => {
  test('fails spawn_fallback_agent when launcher callback is missing', async () => {
    const mod = await importHookChainsModule()

    const configPath = await makeConfigFile({
      version: 1,
      enabled: true,
      maxChainDepth: 3,
      defaultCooldownMs: 0,
      defaultDedupWindowMs: 0,
      rules: [
        {
          id: 'missing-launcher',
          trigger: { event: 'TaskCompleted', outcome: 'failed' },
          actions: [{ type: 'spawn_fallback_agent' }],
        },
      ],
    })

    const result = await mod.dispatchHookChainsForEvent({
      configPathOverride: configPath,
      event: {
        eventName: 'TaskCompleted',
        outcome: 'failed',
        payload: { task_id: 'task-missing-launcher' },
      },
      runtime: {},
    })

    expect(result.actionResults[0]?.status).toBe('failed')
    expect(result.actionResults[0]?.reason).toContain('launcher')
  })

  test('skips disabled action and does not execute callback', async () => {
    const mod = await importHookChainsModule()

    const configPath = await makeConfigFile({
      version: 1,
      enabled: true,
      maxChainDepth: 3,
      defaultCooldownMs: 0,
      defaultDedupWindowMs: 0,
      rules: [
        {
          id: 'disabled-action-rule',
          trigger: { event: 'TaskCompleted', outcome: 'failed' },
          actions: [
            {
              type: 'spawn_fallback_agent',
              enabled: false,
            },
          ],
        },
      ],
    })

    const spawn = mock(async () => ({ launched: true, agentId: 'agent-4' }))

    const result = await mod.dispatchHookChainsForEvent({
      configPathOverride: configPath,
      event: {
        eventName: 'TaskCompleted',
        outcome: 'failed',
        payload: { task_id: 'task-disabled' },
      },
      runtime: { onSpawnFallbackAgent: spawn },
    })

    expect(result.actionResults[0]?.status).toBe('skipped')
    expect(result.actionResults[0]?.reason).toContain('disabled')
    expect(spawn).not.toHaveBeenCalled()
  })

  test('skips warm_remote_capacity when policy denies remote sessions', async () => {
    const mod = await importHookChainsModule({ allowRemoteSessions: false })

    const configPath = await makeConfigFile({
      version: 1,
      enabled: true,
      maxChainDepth: 3,
      defaultCooldownMs: 0,
      defaultDedupWindowMs: 0,
      rules: [
        {
          id: 'policy-denied-remote-warm',
          trigger: { event: 'TaskCompleted', outcome: 'failed' },
          actions: [{ type: 'warm_remote_capacity' }],
        },
      ],
    })

    const warm = mock(async () => ({
      warmed: true,
      environmentId: 'env-123',
    }))

    const result = await mod.dispatchHookChainsForEvent({
      configPathOverride: configPath,
      event: {
        eventName: 'TaskCompleted',
        outcome: 'failed',
        payload: { task_id: 'task-policy-denied' },
      },
      runtime: { onWarmRemoteCapacity: warm },
    })

    expect(result.actionResults[0]?.status).toBe('skipped')
    expect(result.actionResults[0]?.reason).toContain('policy')
    expect(warm).not.toHaveBeenCalled()
  })
})
