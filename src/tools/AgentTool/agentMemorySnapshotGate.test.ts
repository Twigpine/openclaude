import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { feature } from 'bun:bundle'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { setAllowedSettingSources } from '../../bootstrap/state.js'
import {
  getClaudeConfigHomeDirOverrideForTesting,
  setClaudeConfigHomeDirForTesting,
} from '../../utils/envUtils.js'
import { SETTING_SOURCES } from '../../utils/settings/constants.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import {
  clearAgentDefinitionsCache,
  getAgentDefinitionsWithOverrides,
} from './loadAgentsDir.js'

const checkSnapshotSpy = mock(() => Promise.resolve({ action: 'none' as const }))
const initFromSnapshotSpy = mock(() => Promise.resolve())
const loadPluginAgentsSpy = mock(() => Promise.resolve([]))

const realSnapshot = {
  ...(await import(`./agentMemorySnapshot.js?real=${Date.now()}`)),
}
mock.module('./agentMemorySnapshot.js', () => ({
  ...realSnapshot,
  checkAgentMemorySnapshot: checkSnapshotSpy,
  initializeFromSnapshot: initFromSnapshotSpy,
}))
mock.module('../../utils/plugins/loadPluginAgents.js', () => ({
  loadPluginAgents: loadPluginAgentsSpy,
}))

const originalEnv = {
  HOME: process.env.HOME,
  OPENCLAUDE_CONFIG_DIR: process.env.OPENCLAUDE_CONFIG_DIR,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CLAUDE_CODE_SIMPLE: process.env.CLAUDE_CODE_SIMPLE,
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY,
  CLAUDE_CODE_USE_NATIVE_FILE_SEARCH:
    process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH,
  USER_TYPE: process.env.USER_TYPE,
}

let tempDir: string
let projectDir: string
let previousConfigHomeOverride: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('agentMemorySnapshotGate.test.ts')
  tempDir = await mkdtemp(join(tmpdir(), 'openclaude-snapshot-gate-'))
  projectDir = await mkdtemp(join(tmpdir(), 'openclaude-snapshot-project-'))
  const configDir = join(tempDir, '.openclaude')
  previousConfigHomeOverride = getClaudeConfigHomeDirOverrideForTesting()
  setClaudeConfigHomeDirForTesting(configDir)
  process.env.HOME = tempDir
  process.env.OPENCLAUDE_CONFIG_DIR = configDir
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH = '1'
  delete process.env.CLAUDE_CODE_SIMPLE
  // Explicit '0' is the provisioning path that enables auto memory for the
  // otherwise non-interactive test session.
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '0'
  delete process.env.USER_TYPE
  setAllowedSettingSources([...SETTING_SOURCES])
  resetSettingsCache()
  clearAgentDefinitionsCache()
  checkSnapshotSpy.mockClear()
  initFromSnapshotSpy.mockClear()
})

afterEach(async () => {
  setClaudeConfigHomeDirForTesting(previousConfigHomeOverride)
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  try {
    await rm(tempDir, { recursive: true, force: true })
    await rm(projectDir, { recursive: true, force: true })
  } finally {
    releaseSharedMutationLock()
  }
})

describe('AGENT_MEMORY_SNAPSHOT gate', () => {
  test('checks memory snapshots for user-memory agents only when the flag is on', async () => {
    const agentPath = join(
      projectDir,
      '.openclaude',
      'agents',
      'mem-agent.md',
    )
    await mkdir(dirname(agentPath), { recursive: true })
    await writeFile(
      agentPath,
      `---
name: mem-agent
description: "Use for regression coverage"
memory: user
---

You are mem-agent.
`,
    )

    const result = await getAgentDefinitionsWithOverrides(projectDir)
    const hasAgent = result.allAgents.some(
      agent => agent.agentType === 'mem-agent',
    )
    expect(hasAgent).toBe(true)

    if (feature('AGENT_MEMORY_SNAPSHOT')) {
      expect(checkSnapshotSpy).toHaveBeenCalledWith('mem-agent', 'user')
    } else {
      expect(checkSnapshotSpy).not.toHaveBeenCalled()
    }
  })
})
