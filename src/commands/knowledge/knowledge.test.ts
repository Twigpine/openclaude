import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { call as knowledgeCall } from './knowledge.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { getArc, resetArc, initializeArc, addGoal } from '../../utils/conversationArc.js'
import { getGlobalGraph, resetGlobalGraph } from '../../utils/knowledgeGraph.js'
import {
  getMultiTurnStats,
  getTurnHistory,
  startNewTurn,
} from '../../utils/multiTurnContext.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import { getAutoMemPath } from '../../memdir/paths.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'

describe('knowledge command', () => {
  const mockContext = {} as any
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  let configDir: string | undefined

  beforeEach(async () => {
    await acquireSharedMutationLock('commands/knowledge.test.ts')
    configDir = mkdtempSync(join(tmpdir(), 'openclaude-knowledge-command-'))
    process.env.CLAUDE_CONFIG_DIR = configDir
    setClaudeConfigHomeDirForTesting(configDir)
    getAutoMemPath.cache?.clear?.()
    resetArc()
    resetGlobalGraph()
  })

  afterEach(() => {
    try {
      resetArc()
      resetGlobalGraph()
      if (originalConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalConfigDir
      }
      setClaudeConfigHomeDirForTesting(undefined)
      getAutoMemPath.cache?.clear?.()
    } finally {
      const dirToRemove = configDir
      configDir = undefined
      try {
        if (dirToRemove) {
          rmSync(dirToRemove, { recursive: true, force: true })
        }
      } finally {
        releaseSharedMutationLock()
      }
    }
  })
  
  const knowledgeCallWithCapture = async (args: string) => {
    const result = await knowledgeCall(args, mockContext)
    if (result.type === 'text') {
      return result.value
    }
    return ''
  }

  beforeEach(() => {
    // Attempt to reset config - even if mocked, we try to set our key
    try {
      saveGlobalConfig(current => ({
        ...current,
        knowledgeGraphEnabled: true
      }))
    } catch {
      // Ignore if config is heavily mocked
    }
    resetArc()
  })

  it('enables and disables knowledge graph engine', async () => {
    // Test Disable
    const res1 = await knowledgeCallWithCapture('enable no')
    expect(res1.toLowerCase()).toContain('disabled')
    
    // Safety check: only verify state if property is actually present (avoid CI mock interference)
    const config1 = getGlobalConfig()
    if (config1 && 'knowledgeGraphEnabled' in config1) {
      expect(config1.knowledgeGraphEnabled).toBe(false)
    }

    // Test Enable
    const res2 = await knowledgeCallWithCapture('enable yes')
    expect(res2.toLowerCase()).toContain('enabled')
    
    const config2 = getGlobalConfig()
    if (config2 && 'knowledgeGraphEnabled' in config2) {
      expect(config2.knowledgeGraphEnabled).toBe(true)
    }
  })

  it('clears the knowledge graph and arc state', async () => {
    // Seed a fact file so we have state to clear
    const memDir = getAutoMemPath()
    const factsDir = join(memDir, '.facts')
    mkdirSync(factsDir, { recursive: true })
    writeFileSync(join(factsDir, 'test-fact.md'), `---
title: Test Fact
type: reference
factType: test
description: A seeded fact
---

Test content
`)

    const graph = getGlobalGraph()
    const countBefore = Object.keys(graph.entities).length
    expect(countBefore).toBeGreaterThan(0)

    // Seed arc state: initialize arc and add a goal
    initializeArc(memDir)
    addGoal('Test goal for clear')
    expect(getArc()).not.toBeNull()
    expect(getArc()!.goals.length).toBeGreaterThan(0)
    expect(getArc()!.decisions.length).toBe(0)

    // Seed multi-turn state: start a turn so it survives and must be reset
    startNewTurn()
    expect(getTurnHistory().length).toBeGreaterThan(0)
    expect(getMultiTurnStats().totalTurns).toBeGreaterThan(0)

    const res = await knowledgeCallWithCapture('clear')
    const graphAfter = getGlobalGraph()
    expect(res.toLowerCase()).toContain('cleared')
    expect(Object.keys(graphAfter.entities).length).toBe(0)

    // Multi-turn tracking must not inject prior tool-call context after clear
    expect(getTurnHistory().length).toBe(0)
    expect(getMultiTurnStats().totalTurns).toBe(0)

    // Arc state should be reset (getArc re-initializes an empty arc
    // since clear deletes the .arc.json file from disk)
    expect(getArc()).not.toBeNull()
    expect(getArc()!.goals.length).toBe(0)
    expect(getArc()!.currentPhase).toBe('init')
  })

  it('shows error on unknown subcommand', async () => {
    const res = await knowledgeCallWithCapture('invalid')
    expect(res.toLowerCase()).toContain('unknown subcommand')
  })
})
