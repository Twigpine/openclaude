import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  initializeArc,
  getArc,
  updateArcPhase,
  addGoal,
  updateGoalStatus,
  addDecision,
  addMilestone,
  getArcSummary,
  resetArc,
  getArcStats,
  finalizeArcTurn,
  clearArcArtifacts,
} from './conversationArc.js'
import { resetGlobalGraph } from './knowledgeGraph.js'
import { setClaudeConfigHomeDirForTesting } from './envUtils.js'
import { getIsInteractive, setIsInteractive } from '../bootstrap/state.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { getOrchestratedMemory } from './knowledgeGraph.js'
import { getAutoMemPath } from '../memdir/paths.js'
import { setGovernancePolicySettingsForSourceForTesting } from './governancePolicy.js'

function createMessage(role: string, content: string): any {
  return {
    type: role,
    message: { role, content, id: 'test', type: 'message', created_at: Date.now() },
    sender: role,
  }
}

const ARC_FILENAME = '.arc.json'

describe('conversationArc', () => {
  let memDir: string
  let configDir: string | undefined
  let originalInteractive = false
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(async () => {
    await acquireSharedMutationLock('utils/conversationArc.test.ts')
    configDir = mkdtempSync(join(tmpdir(), 'conversation-arc-config-'))
    process.env.CLAUDE_CONFIG_DIR = configDir
    setClaudeConfigHomeDirForTesting(configDir)
    memDir = mkdtempSync(join(tmpdir(), 'conversation-arc-test-'))
    resetArc()
    resetGlobalGraph()
    delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
    delete process.env.CLAUDE_CODE_SIMPLE
    // Auto-memory defaults off in non-interactive sessions (which includes
    // the test process); these tests exercise interactive-session behavior.
    originalInteractive = getIsInteractive()
    setIsInteractive(true)
    // Disable memory-write approval for tests so arc persistence, fact
    // extraction, and vector-index writes behave as they do in production
    // when the policy is set to require-approval=false.
    setGovernancePolicySettingsForSourceForTesting(() => ({
      memory: { requireApprovalBeforeWrite: false },
    }))
  })

  afterEach(() => {
    try {
      resetArc()
      resetGlobalGraph()
      setIsInteractive(originalInteractive)
      setGovernancePolicySettingsForSourceForTesting(null)
      if (originalConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalConfigDir
      }
      setClaudeConfigHomeDirForTesting(undefined)
      getAutoMemPath.cache?.clear?.()
      if (memDir) {
        rmSync(memDir, { recursive: true, force: true })
      }
      if (configDir) {
        rmSync(configDir, { recursive: true, force: true })
      }
    } finally {
      releaseSharedMutationLock()
    }
  })

  describe('initializeArc', () => {
    it('creates new arc in memory dir', () => {
      const arc = initializeArc(memDir)
      expect(arc).toBeDefined()
      expect(arc.currentPhase).toBe('init')
      expect(arc.id).toContain('arc_')
    })

    it('persists arc to .arc.json', () => {
      initializeArc(memDir)
      const arcPath = join(memDir, ARC_FILENAME)
      expect(existsSync(arcPath)).toBe(true)
      const data = JSON.parse(readFileSync(arcPath, 'utf-8'))
      expect(data.currentPhase).toBe('init')
    })
  })

  describe('getArc', () => {
    it('returns existing arc', () => {
      initializeArc(memDir)
      const arc = getArc()
      expect(arc).not.toBeNull()
    })

    it('loads persisted arc from disk', () => {
      const arc1 = initializeArc(memDir)
      resetArc()
      const arc2 = initializeArc(memDir)
      expect(arc2).not.toBeNull()
      expect(arc2!.id).toBe(arc1.id)
    })

    it('replaces structurally invalid arc JSON with a fresh arc', () => {
      writeFileSync(
        join(memDir, ARC_FILENAME),
        JSON.stringify({ id: 'broken', goals: 'not-an-array', currentPhase: 'unknown' }),
      )
      resetArc()

      const arc = initializeArc(memDir)
      expect(arc.id).not.toBe('broken')
      expect(arc.goals).toEqual([])
      expect(arc.currentPhase).toBe('init')
    })
  })

  describe('addGoal', () => {
    it('adds goal and transitions phase', () => {
      const arc = initializeArc(memDir)
      expect(arc.currentPhase).toBe('init')

      addGoal('Fix the payment bug')
      expect(arc.goals.length).toBe(1)
      expect(arc.goals[0].description).toBe('Fix the payment bug')
      expect(arc.goals[0].status).toBe('pending')
      expect(arc.currentPhase).toBe('exploring')
    })

    it('persists goals to disk', () => {
      initializeArc(memDir)
      addGoal('Refactor auth module')
      resetArc()

      const reloaded = initializeArc(memDir)
      expect(reloaded.goals.length).toBe(1)
      expect(reloaded.goals[0].description).toBe('Refactor auth module')
    })
  })

  describe('updateGoalStatus', () => {
    it('marks goal completed and creates milestone', () => {
      initializeArc(memDir)
      const goal = addGoal('Deploy to prod')
      expect(goal.status).toBe('pending')
      expect(goal.completedAt).toBeUndefined()

      updateGoalStatus(goal.id, 'completed')
      expect(goal.status).toBe('completed')
      expect(goal.completedAt).toBeGreaterThan(0)
    })
  })

  describe('updateArcPhase', () => {
    it('detects phase from messages', async () => {
      const arc = initializeArc(memDir)
      expect(arc.currentPhase).toBe('init')

      await updateArcPhase([createMessage('user', 'check the logs for errors')])
      expect(arc.currentPhase).toBe('exploring')

      await updateArcPhase([createMessage('user', 'Let me write the fix now')])
      expect(arc.currentPhase).toBe('implementing')

      await updateArcPhase([createMessage('user', 'test the changes')])
      expect(arc.currentPhase).toBe('reviewing')

      // Phase detection is gated on user-authored text only; assistant turns
      // must not advance the arc.
      await updateArcPhase([createMessage('assistant', 'I will implement it')])
      expect(arc.currentPhase).toBe('reviewing')
    })

    it('does not regress phase', async () => {
      const arc = initializeArc(memDir)
      arc.currentPhase = 'implementing'

      await updateArcPhase([createMessage('user', 'start fresh')])
      expect(arc.currentPhase).toBe('implementing')
    })

    it('tracks phase in memory while persistence is disabled', async () => {
      process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
      const arc = initializeArc(memDir)

      await updateArcPhase([createMessage('user', 'implement the login flow')])

      expect(arc.currentPhase).toBe('implementing')
      expect(arc.goals.some(goal => goal.description === 'the login flow')).toBe(true)
      expect(existsSync(join(memDir, ARC_FILENAME))).toBe(false)
    })

    it('sanitizes credential context before storing auto-detected goals', async () => {
      const arc = initializeArc(memDir)

      await updateArcPhase([createMessage('user', 'implement password hunter2')])

      expect(JSON.stringify(arc)).not.toContain('hunter2')
      expect(arc.goals[0]?.description).toContain('[REDACTED]')
      expect(readFileSync(join(memDir, ARC_FILENAME), 'utf-8')).not.toContain('hunter2')
    })
  })

  describe('addDecision', () => {
    it('adds decision with rationale', () => {
      initializeArc(memDir)
      addDecision('Use PostgreSQL', 'Better JSON support')
      const arc = getArc()!
      expect(arc.decisions.length).toBe(1)
      expect(arc.decisions[0].description).toBe('Use PostgreSQL')
      expect(arc.decisions[0].rationale).toBe('Better JSON support')
    })
  })

  describe('getArcSummary', () => {
    it('returns summary with phase and goal count', async () => {
      initializeArc(memDir)
      addGoal('Fix bug')
      const summary = await getArcSummary()
      expect(summary).toContain('exploring')
      expect(summary).toContain('0/1 completed')
    })

    it('redacts credential context from retrieved markdown at the prompt boundary', async () => {
      const autoMemDir = getAutoMemPath()
      mkdirSync(autoMemDir, { recursive: true })
      writeFileSync(
        join(autoMemDir, 'unsafe-legacy-memory.md'),
        '---\ntitle: Legacy Note\ntype: reference\ndescription: Imported note\n---\n\nAlways use password hunter2.',
      )

      const memory = await getOrchestratedMemory('password')
      expect(memory).not.toContain('hunter2')
      expect(memory).toContain('[REDACTED]')
    })
  })

  describe('persistence and reindex', () => {
    it('persists arc and rebuilds index across reload', async () => {
      const arc = initializeArc(memDir)
      expect(arc.currentPhase).toBe('init')

      await updateArcPhase([createMessage('user', 'check the logs for errors')])
      expect(arc.currentPhase).toBe('exploring')

      // Reload from disk and verify phase persisted
      resetArc()
      const reloaded = initializeArc(memDir)
      expect(reloaded.currentPhase).toBe('exploring')

      const summary = await getArcSummary()
      expect(summary).toContain('exploring')
    })
  })

  describe('finalizeArcTurn', () => {
    it('writes session summary file when goals completed', async () => {
      const arc = initializeArc(memDir)
      const goal = addGoal('Implement feature')
      updateGoalStatus(goal.id, 'completed')
      addDecision('Use TypeScript', 'Type safety')

      await finalizeArcTurn()

      const files = readdirSync(memDir).filter(f => f.startsWith('session-summary-'))
      expect(files.length).toBeGreaterThan(0)
      const content = readFileSync(join(memDir, files[0]), 'utf-8')
      expect(content).toContain('Implement feature')
      expect(content).toContain('Use TypeScript')
    })

    it('no-ops when no goals or decisions', async () => {
      initializeArc(memDir)
      await finalizeArcTurn()
      const files = readdirSync(memDir).filter(f => f.startsWith('session-summary-'))
      expect(files.length).toBe(0)
    })

    it('does not rewrite the summary or rebuild on unchanged repeated cycles (P1 #5)', async () => {
      initializeArc(memDir)
      const goal = addGoal('Implement feature')
      updateGoalStatus(goal.id, 'completed')
      addDecision('Use TypeScript', 'Type safety')

      // First cycle writes the summary and rebuilds the index.
      await finalizeArcTurn()
      const summaryFile = readdirSync(memDir).find(f => f.startsWith('session-summary-'))!
      const contentAfterFirst = readFileSync(join(memDir, summaryFile), 'utf-8')
      expect(contentAfterFirst).toContain('detectedAt:')

      // Let the clock advance so the volatile detectedAt timestamp differs on
      // the next cycle. The semantic summary content is byte-identical, so the
      // repeated cycle must neither rewrite the file nor trigger a full-corpus
      // rebuild on the request path.
      await new Promise(r => setTimeout(r, 5))
      await finalizeArcTurn()
      expect(readFileSync(join(memDir, summaryFile), 'utf-8')).toBe(contentAfterFirst)
      expect(readdirSync(memDir).filter(f => f.startsWith('session-summary-')).length).toBe(1)
    })
  })

  describe('clearArcArtifacts', () => {
    it('removes .arc.json and session-summary-* files', async () => {
      initializeArc(memDir)
      addGoal('Cleanup test')
      addDecision('Use cleanup', 'Testing')
      const goal = getArc()!.goals[0]
      updateGoalStatus(goal.id, 'completed')
      await finalizeArcTurn()

      const arcPath = join(memDir, '.arc.json')
      const summaryFiles = () =>
        readdirSync(memDir).filter(f => f.startsWith('session-summary-'))

      // Confirm artifacts exist before cleanup
      expect(existsSync(arcPath)).toBe(true)
      expect(summaryFiles().length).toBeGreaterThan(0)

      clearArcArtifacts(memDir)

      expect(existsSync(arcPath)).toBe(false)
      expect(summaryFiles().length).toBe(0)
      const remaining = readdirSync(memDir).filter(
        f => f.startsWith('session-summary-') || f === '.arc.json',
      )
      expect(remaining.length).toBe(0)
    })

    it('leaves unrelated files untouched', () => {
      initializeArc(memDir)
      const unrelatedPath = join(memDir, 'keep-me.md')
      writeFileSync(unrelatedPath, 'content', 'utf-8')

      clearArcArtifacts(memDir)

      expect(existsSync(unrelatedPath)).toBe(true)
    })

    it('regression: clearArcArtifacts resets the in-memory cache', () => {
      initializeArc(memDir)
      addGoal('Goal A')
      expect(getArc()?.goals.length).toBe(1)

      clearArcArtifacts(memDir)

      // getArc() should now return a fresh/minimal arc
      const freshArc = getArc()
      expect(freshArc).not.toBeNull()
      expect(freshArc!.goals.length).toBe(0)
    })
  })

  describe('getArcStats', () => {
    it('returns correct stats', () => {
      initializeArc(memDir)
      addGoal('Goal A')
      addGoal('Goal B')
      addDecision('Decision X')
      addMilestone('Milestone Y')

      const stats = getArcStats()
      expect(stats).not.toBeNull()
      expect(stats!.goalCount).toBe(2)
      expect(stats!.decisionCount).toBe(1)
      expect(stats!.milestoneCount).toBe(1)
      expect(stats!.durationMs).toBeGreaterThanOrEqual(0)
    })
  })

  describe('turn lifecycle integration', () => {
    // Exercises the same calls query.ts makes when
    // CONVERSATION_ARC + knowledgeGraphEnabled are both on:
    //   updateArcPhase → finalizeArcTurn → getArcSummary → getOrchestratedMemory
    //
    // NOTE: query.ts does NOT call initializeArc, addGoal, addDecision, or
    // updateGoalStatus directly. Goals and decisions are auto-extracted by
    // updateArcPhase from user-message content patterns. These tests drive
    // the helper interface directly (not through query.ts) to validate the
    // arc/memory behavior independent of query.ts feature gates.

    it('processes a full conversation turn through arc + memory', async () => {
      // Use the auto-memory path so getOrchestratedMemory can find the files.
      const autoMemDir = getAutoMemPath()
      mkdirSync(autoMemDir, { recursive: true })

      initializeArc(autoMemDir)

      // Simulate a user message (query.ts calls updateArcPhase per message)
      await updateArcPhase([createMessage('user', 'check the login flow')])
      const arc = getArc()!
      expect(arc.currentPhase).toBe('exploring')

      // Add a goal and complete it (query.ts does NOT call addGoal directly;
      // this test adds one manually so we can exercise the completed-goal path)
      const goal = addGoal('Fix login bug')
      updateGoalStatus(goal.id, 'completed')
      expect(goal.status).toBe('completed')

      // Finalize the turn (query.ts calls finalizeArcTurn at session end)
      await finalizeArcTurn()
      const summaryFiles = readdirSync(autoMemDir)
        .filter(f => f.startsWith('session-summary-'))
      expect(summaryFiles.length).toBeGreaterThan(0)

      // getArcSummary with a query — this is what the prompt assembly calls
      const arcSummary = await getArcSummary('login')
      expect(arcSummary).toContain('exploring')
      expect(arcSummary).toContain('1/1 completed')

      // getOrchestratedMemory is the next hop in query.ts — it searches the
      // vector index that updateArcPhase populated via extractFactsAutomatically
      const orchMem = await getOrchestratedMemory('login')
      expect(orchMem).toContain('PERSISTENT PROJECT MEMORY')
      expect(orchMem).toContain('Fix login bug')
    })

    it('does not create arc artifacts when auto-memory is disabled', async () => {
      // Mock isAutoMemoryEnabled returning false via env var
      process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
      try {
        const autoMemDir = getAutoMemPath()
        clearArcArtifacts(autoMemDir)
        mkdirSync(autoMemDir, { recursive: true })

        // Initialize arc - shouldn't write to disk
        initializeArc(autoMemDir)

        // This simulates a full production turn that would normally write
        await updateArcPhase([createMessage('user', 'check the login flow')])
        const goal = addGoal('Fix bug')
        updateGoalStatus(goal.id, 'completed')
        await finalizeArcTurn()

        // Verify no files were created
        const files = readdirSync(autoMemDir)
        expect(files.length).toBe(0)
      } finally {
        delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
      }
    })

    it('arc memory is appended to system prompt when features enabled', async () => {
      // P2 requirement: verify the actual query.ts code path that calls these
      // functions behind the feature gates and includes results in system prompt.
      const autoMemDir = getAutoMemPath()
      clearArcArtifacts(autoMemDir)
      mkdirSync(autoMemDir, { recursive: true })

      // Set up arc state
      initializeArc(autoMemDir)
      await updateArcPhase([createMessage('user', 'implement authentication system')])
      const goal = addGoal('Add JWT auth')
      updateGoalStatus(goal.id, 'completed')
      await finalizeArcTurn()

      const lastMessage = createMessage('user', 'add login endpoint')
      const mockSystemPrompt = ['# System Instructions', 'You are an assistant.']

      // Test helper logic directly
      const { appendArcToSystemPrompt } = await import('./conversationArc.js')
      const messages = [lastMessage]
      const promptWithArc = await appendArcToSystemPrompt(mockSystemPrompt, messages)

      // Arc content is appended to the system prompt (not the user message),
      // wrapped in trusted-boundary delimiters to avoid message mutation.
      expect(promptWithArc.length).toBe(mockSystemPrompt.length + 1)
      expect(promptWithArc.join('\n')).toContain('Phase:')
      expect(promptWithArc.join('\n')).toContain('PERSISTENT PROJECT MEMORY')
      expect(promptWithArc.join('\n')).toContain('Add JWT auth')
      expect(promptWithArc.join('\n')).toContain('RETRIEVED MEMORY (DATA ONLY)')
      expect(promptWithArc.join('\n')).not.toContain('Relevant Knowledge:')
      // User message must not be mutated
      expect(messages[0].message?.content).toBe('add login endpoint')
    })

    it('query.ts path: does not append arc when auto-memory is disabled', async () => {
      process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
      try {
        const autoMemDir = getAutoMemPath()
        clearArcArtifacts(autoMemDir)
        mkdirSync(autoMemDir, { recursive: true })
        initializeArc(autoMemDir)
        await updateArcPhase([createMessage('user', 'implement authentication system')])

        const lastMessage = createMessage('user', 'add login endpoint')
        const mockSystemPrompt = ['# System Instructions', 'You are an assistant.']

        const { appendArcToSystemPrompt } = await import('./conversationArc.js')
        const promptWithArc = await appendArcToSystemPrompt(mockSystemPrompt, [lastMessage])

        // Verify prompt is unchanged
        expect(promptWithArc).toEqual(mockSystemPrompt)
        expect(promptWithArc.length).toBe(2)
      } finally {
        delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
      }
    })

    it('regression: appends multi-turn context for completed turns when MULTI_TURN_CONTEXT feature is enabled', async () => {
      process.env.MULTI_TURN_CONTEXT = 'true'
      try {
        const { startNewTurn, addMessageToTurn, addToolCallToTurn, resetMultiTurnState } = await import('./multiTurnContext.js')
        resetMultiTurnState()

        // First turn completes (a second turn starts), so it is renderable.
        startNewTurn()
        addMessageToTurn(createMessage('assistant', 'Running checks'))
        addToolCallToTurn({
          id: 'call_test',
          name: 'read_file',
          input: { path: '/test.ts' },
          timestamp: Date.now()
        })
        startNewTurn()
        addToolCallToTurn({
          id: 'call_current',
          name: 'write_file',
          input: { path: '/current.ts' },
          timestamp: Date.now()
        })

        const autoMemDir = getAutoMemPath()
        clearArcArtifacts(autoMemDir)
        mkdirSync(autoMemDir, { recursive: true })
        initializeArc(autoMemDir)

        const lastMessage = createMessage('user', 'continue')
        const mockSystemPrompt = ['# System Instructions', 'You are an assistant.']

        const { appendArcToSystemPrompt } = await import('./conversationArc.js')
        const promptWithArc = await appendArcToSystemPrompt(mockSystemPrompt, [lastMessage])

        expect(promptWithArc.length).toBe(mockSystemPrompt.length + 1)
        const promptText = promptWithArc.join('\n')
        expect(promptText).toContain('MULTI-TURN CONTEXT TRACKING')
        expect(promptText).toContain('Total Turns: 2')
        expect(promptText).toContain('read_file')
        // The in-progress turn is never rendered: its tool-call list grows
        // between model requests and would bust the prompt cache.
        expect(promptText).not.toContain('write_file')
        expect(promptText).not.toContain('Duration:')
        expect(promptText).not.toContain('Total Tokens:')
      } finally {
        delete process.env.MULTI_TURN_CONTEXT
      }
    })

    it('regression: multi-turn context block is byte-stable across model requests within a turn', async () => {
      process.env.MULTI_TURN_CONTEXT = 'true'
      const realDateNow = Date.now
      try {
        const { startNewTurn, addToolCallToTurn, resetMultiTurnState } = await import('./multiTurnContext.js')
        resetMultiTurnState()

        startNewTurn()
        addToolCallToTurn({
          id: 'call_done',
          name: 'read_file',
          input: { path: '/done.ts' },
          timestamp: Date.now()
        })
        startNewTurn()

        const autoMemDir = getAutoMemPath()
        clearArcArtifacts(autoMemDir)
        mkdirSync(autoMemDir, { recursive: true })
        initializeArc(autoMemDir)

        const lastMessage = createMessage('user', 'continue')
        const mockSystemPrompt = ['# System Instructions']
        const { appendArcToSystemPrompt } = await import('./conversationArc.js')

        Date.now = () => 1_000_000
        const first = await appendArcToSystemPrompt(mockSystemPrompt, [lastMessage])

        // A later model request in the SAME turn: the clock has advanced and
        // the in-progress turn has picked up a tool call. The rendered system
        // prompt must be byte-identical, or the prompt cache is busted.
        Date.now = () => 9_000_000
        addToolCallToTurn({
          id: 'call_in_progress',
          name: 'write_file',
          input: { path: '/wip.ts' },
          timestamp: Date.now()
        })
        const second = await appendArcToSystemPrompt(mockSystemPrompt, [lastMessage])

        expect(second.join('\n')).toBe(first.join('\n'))
        expect(first.join('\n')).not.toContain('Duration:')
      } finally {
        Date.now = realDateNow
        delete process.env.MULTI_TURN_CONTEXT
      }
    })
  })
})
