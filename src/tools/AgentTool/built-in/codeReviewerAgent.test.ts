import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getAllowedSettingSources,
  setAllowedSettingSources,
} from 'src/bootstrap/state.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from 'src/test/sharedMutationLock.js'
import {
  getClaudeConfigHomeDir,
  getClaudeConfigHomeDirOverrideForTesting,
  setClaudeConfigHomeDirForTesting,
} from 'src/utils/envUtils.js'
import { loadMarkdownFilesForSubdir } from 'src/utils/markdownConfigLoader.js'
import { SETTING_SOURCES } from 'src/utils/settings/constants.js'
import { resetSettingsCache } from 'src/utils/settings/settingsCache.js'
import {
  clearAgentDefinitionsCache,
  getAgentDefinitionsWithOverrides,
} from '../loadAgentsDir.js'
import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'
import type { ToolUseContext } from 'src/Tool.js'

// ── Shared env snapshot ────────────────────────────────────────

let originalEnv: Record<string, string | undefined> = {}

function restoreEnv(key: string): void {
  if (!originalEnv || !(key in originalEnv)) return
  const val = originalEnv[key]
  if (val === undefined) delete process.env[key]
  else process.env[key] = val
}

function restoreAllEnv(): void {
  if (!originalEnv) return
  for (const key of Object.keys(originalEnv)) {
    restoreEnv(key)
  }
}

describe('code-reviewer built-in agent', () => {
  let agent: BuiltInAgentDefinition
  let dir: string
  let lockAcquired = false
  let previousOverride: ReturnType<typeof getClaudeConfigHomeDirOverrideForTesting>
  let previousSettingSources: ReturnType<typeof getAllowedSettingSources>

  beforeAll(async () => {
    await acquireSharedMutationLock('codeReviewerAgent.test.ts')
    lockAcquired = true

    originalEnv = {
      HOME: process.env.HOME,
      OPENCLAUDE_CONFIG_DIR: process.env.OPENCLAUDE_CONFIG_DIR,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      EMBEDDED_SEARCH_TOOLS: process.env.EMBEDDED_SEARCH_TOOLS,
      CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT,
      CLAUDE_CODE_USE_NATIVE_FILE_SEARCH: process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH,
    }
    previousOverride = getClaudeConfigHomeDirOverrideForTesting()
    previousSettingSources = getAllowedSettingSources()

    dir = await mkdtemp(join(tmpdir(), 'openclaude-reviewer-test-'))
    const configDir = join(dir, '.openclaude')

    setClaudeConfigHomeDirForTesting(configDir)
    process.env.HOME = dir
    process.env.OPENCLAUDE_CONFIG_DIR = configDir
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH = '1'
    setAllowedSettingSources([...SETTING_SOURCES])
    getClaudeConfigHomeDir.cache?.clear?.()
    resetSettingsCache()
    clearAgentDefinitionsCache()
    loadMarkdownFilesForSubdir.cache.clear?.()

    const { activeAgents } = await getAgentDefinitionsWithOverrides(dir)
    const found = activeAgents.find((a) => a.agentType === 'code-reviewer')
    if (!found || found.source !== 'built-in') {
      throw new Error('code-reviewer agent not found in built-in agents')
    }
    agent = found as BuiltInAgentDefinition
  })

  afterAll(async () => {
    try {
      restoreAllEnv()
      setClaudeConfigHomeDirForTesting(previousOverride)
      getClaudeConfigHomeDir.cache?.clear?.()
      setAllowedSettingSources(previousSettingSources)
      resetSettingsCache()
      clearAgentDefinitionsCache()
      loadMarkdownFilesForSubdir.cache.clear?.()
      if (dir) {
        await rm(dir, { recursive: true, force: true })
      }
    } finally {
      if (lockAcquired) {
        releaseSharedMutationLock()
      }
    }
  })

  // ── Definition ────────────────────────────────────────────────

  test('source is built-in', () => {
    expect(agent.source).toBe('built-in')
  })

  test('model is inherit (allows agentRouting override)', () => {
    expect(agent.model).toBe('inherit')
  })

  test('omitClaudeMd is true', () => {
    expect(agent.omitClaudeMd).toBe(true)
  })

  test('whenToUse is non-empty', () => {
    expect(agent.whenToUse.length).toBeGreaterThan(0)
  })

  test('whenToUse requires the caller to provide the diff inline', () => {
    expect(agent.whenToUse).toContain('diff')
    expect(agent.whenToUse).toContain('inline')
  })

  test('disallows mutation tools', () => {
    const disallowed = agent.disallowedTools ?? []
    expect(disallowed).toContain('Agent')
    expect(disallowed).toContain('Bash')
    expect(disallowed).toContain('PowerShell')
    expect(disallowed).toContain('Edit')
    expect(disallowed).toContain('Write')
    expect(disallowed).toContain('NotebookEdit')
    expect(disallowed).toContain('ExitPlanMode')
  })

  // ── System prompt — non-embedded ─────────────────────────────

  describe('system prompt (non-embedded search)', () => {
    let prompt: string

    beforeEach(() => {
      // Ensure embedded search is OFF for this branch
      delete process.env.EMBEDDED_SEARCH_TOOLS
      prompt = agent.getSystemPrompt({
        toolUseContext: {} as Pick<ToolUseContext, 'options'>,
      })
    })

    test('returns non-empty string', () => {
      expect(typeof prompt).toBe('string')
      expect(prompt.length).toBeGreaterThan(0)
    })

    test('lists Read, Glob, and Grep in tools', () => {
      const tools = agent.tools ?? []
      expect(tools).toEqual(['Read', 'Glob', 'Grep'])
    })

    test('covers all review dimensions', () => {
      expect(prompt).toContain('Correctness')
      expect(prompt).toContain('Security')
      expect(prompt).toContain('Performance')
      expect(prompt).toContain('Maintainability')
      expect(prompt).toContain('Design')
    })

    test('defines severity levels', () => {
      expect(prompt).toContain('CRITICAL')
      expect(prompt).toContain('HIGH')
      expect(prompt).toContain('MEDIUM')
      expect(prompt).toContain('LOW')
    })

    test('enforces read-only constraint', () => {
      expect(prompt).toContain('READ-ONLY')
      expect(prompt).toContain('Do NOT attempt to run shell commands')
    })

    test('includes verdict in output format', () => {
      expect(prompt).toContain('Verdict')
    })

    test('references Glob and Grep search tools', () => {
      expect(prompt).toContain('Glob')
      expect(prompt).toContain('Grep')
    })

    test('requires diff to be provided inline', () => {
      expect(prompt).toContain('diff MUST be provided inline')
    })
  })

  // ── System prompt — embedded search ──────────────────────────

  describe('system prompt (embedded search)', () => {
    let prompt: string

    beforeEach(() => {
      // Simulate the embedded-search build variant
      process.env.EMBEDDED_SEARCH_TOOLS = '1'
      // Ensure we're not in an SDK entrypoint that disables embedded tools
      delete process.env.CLAUDE_CODE_ENTRYPOINT
      prompt = agent.getSystemPrompt({
        toolUseContext: {} as Pick<ToolUseContext, 'options'>,
      })
    })

    afterEach(() => {
      restoreEnv('EMBEDDED_SEARCH_TOOLS')
      restoreEnv('CLAUDE_CODE_ENTRYPOINT')
    })

    test('returns non-empty string', () => {
      expect(typeof prompt).toBe('string')
      expect(prompt.length).toBeGreaterThan(0)
    })

    test('lists only Read in tools since Glob/Grep are absent', () => {
      const tools = agent.tools ?? []
      expect(tools).toEqual(['Read'])
    })

    test('documents limited search capability', () => {
      // In embedded builds, the prompt must acknowledge that Glob/Grep
      // are unavailable and shell access is denied.
      expect(prompt).toContain('unavailable')
      expect(prompt).toContain('Read')
    })

    test('still covers all review dimensions', () => {
      expect(prompt).toContain('Correctness')
      expect(prompt).toContain('Security')
      expect(prompt).toContain('Performance')
      expect(prompt).toContain('Maintainability')
      expect(prompt).toContain('Design')
    })

    test('still enforces read-only constraint', () => {
      expect(prompt).toContain('READ-ONLY')
      expect(prompt).toContain('Do NOT attempt to run shell commands')
    })

    test('requires diff to be provided inline', () => {
      expect(prompt).toContain('diff MUST be provided inline')
    })
  })
})
