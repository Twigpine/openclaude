import { afterEach, describe, expect, it, beforeEach } from 'bun:test'
import {
  startNewTurn,
  getCurrentTurn,
  addMessageToTurn,
  addToolCallToTurn,
  setTurnState,
  getTurnState,
  getTurnHistory,
  getRecentTurns,
  getMultiTurnStats,
  resetMultiTurnState,
  createMultiTurnTracker,
} from './multiTurnContext.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

function createMessage(role: string, content: string): any {
  return {
    message: { role, content, id: 'test', type: 'message', created_at: Date.now() },
    sender: role,
  }
}

describe('multiTurnContext', () => {
  describe('production pipeline integration', () => {
    // Exercises the same calls query.ts makes when
    // MULTI_TURN_CONTEXT + knowledgeGraphEnabled are both on:
    //   startNewTurn (query start) → addMessageToTurn + addToolCallToTurn (post-tool)

    it('processes a full tool cycle through multi-turn context', async () => {
      resetMultiTurnState()

      // query.ts calls startNewTurn at the start of each query
      const turn1 = startNewTurn()
      expect(turn1.turnId).toContain('turn_1')

      // query.ts calls addMessageToTurn for each assistant message after tool execution
      addMessageToTurn(createMessage('assistant', 'Let me check the codebase'))
      addMessageToTurn(createMessage('assistant', 'I found the relevant file'))

      // query.ts calls addToolCallToTurn for each tool use
      addToolCallToTurn({
        id: 'call_1',
        name: 'read_file',
        input: { path: '/src/index.ts' },
        timestamp: Date.now(),
      })
      addToolCallToTurn({
        id: 'call_2',
        name: 'grep_search',
        input: { pattern: 'TODO' },
        timestamp: Date.now(),
      })

      // Verify turn state after query.ts hooks complete
      const currentTurn = getCurrentTurn()
      expect(currentTurn).not.toBeNull()
      expect(currentTurn!.messages.length).toBe(2)
      expect(currentTurn!.toolCalls.length).toBe(2)
      expect(currentTurn!.toolCalls[0].name).toBe('read_file')
      expect(currentTurn!.tokens).toBeGreaterThan(0)

      // getRecentTurns and getMultiTurnStats are used downstream for context
      const recent = getRecentTurns(1)
      expect(recent.length).toBe(1)
      expect(recent[0].turnId).toBe(turn1.turnId)

      const stats = getMultiTurnStats()
      expect(stats.totalTurns).toBe(1)
      expect(stats.totalTokens).toBeGreaterThan(0)
    })

    it('tracks multiple turn cycles across consecutive tool rounds', async () => {
      resetMultiTurnState()

      // Round 1
      const turn1 = startNewTurn()
      addMessageToTurn(createMessage('assistant', 'Checking file'))
      addToolCallToTurn({ id: 'call_1', name: 'read_file', input: {}, timestamp: Date.now() })

      // Round 2
      const turn2 = startNewTurn()
      addMessageToTurn(createMessage('assistant', 'Fixing bug'))
      addToolCallToTurn({ id: 'call_2', name: 'edit_file', input: {}, timestamp: Date.now() })

      // Verify history across both turns
      const history = getTurnHistory()
      expect(history.length).toBe(2)
      expect(history[0].turnId).toBe(turn1.turnId)
      expect(history[1].turnId).toBe(turn2.turnId)

      // getRecentTurns returns most recent N
      const recent = getRecentTurns(1)
      expect(recent.length).toBe(1)
      expect(recent[0].turnId).toBe(turn2.turnId)

      const stats = getMultiTurnStats()
      expect(stats.totalTurns).toBe(2)
      expect(stats.totalTokens).toBeGreaterThan(0)
    })
  })

  beforeEach(async () => {
    await acquireSharedMutationLock('utils/multiTurnContext.test.ts')
    createMultiTurnTracker()
    resetMultiTurnState()
  })

  afterEach(() => {
    try {
      createMultiTurnTracker()
      resetMultiTurnState()
    } finally {
      releaseSharedMutationLock()
    }
  })

  describe('startNewTurn', () => {
    it('creates a new turn', () => {
      const turn = startNewTurn()
      expect(turn.turnId).toBeDefined()
      expect(turn.startTime).toBeDefined()
      expect(turn.messages).toEqual([])
    })

    it('tracks turn count', () => {
      startNewTurn()
      const turn2 = startNewTurn()
      expect(turn2.turnId).toContain('turn_2')
    })
  })

  describe('addMessageToTurn', () => {
    it('adds message to current turn', () => {
      startNewTurn()
      addMessageToTurn(createMessage('user', 'Hello'))
      expect(getCurrentTurn()?.messages.length).toBe(1)
    })

    it('creates turn if none exists', () => {
      addMessageToTurn(createMessage('user', 'Hello'))
      expect(getCurrentTurn()).toBeDefined()
      expect(getCurrentTurn()?.messages.length).toBe(1)
    })
  })

  describe('addToolCallToTurn', () => {
    it('adds tool call to turn', () => {
      startNewTurn()
      addToolCallToTurn({
        id: 'call_1',
        name: 'test_tool',
        input: {},
        timestamp: Date.now(),
      })
      expect(getCurrentTurn()?.toolCalls.length).toBe(1)
    })
  })

  describe('state management', () => {
    it('sets and gets turn state', () => {
      startNewTurn()
      setTurnState('key', 'value')
      expect(getTurnState<string>('key')).toBe('value')
    })

    it('returns undefined for unknown keys', () => {
      startNewTurn()
      expect(getTurnState('unknown')).toBeUndefined()
    })
  })

  describe('getTurnHistory', () => {
    it('returns turn history', () => {
      startNewTurn()
      startNewTurn()
      expect(getTurnHistory().length).toBe(2)
    })
  })

  describe('getRecentTurns', () => {
    it('returns recent turns', () => {
      startNewTurn()
      startNewTurn()
      startNewTurn()
      expect(getRecentTurns(2).length).toBe(2)
    })
  })

  describe('getMultiTurnStats', () => {
    it('returns statistics', () => {
      startNewTurn()
      addMessageToTurn(createMessage('user', 'Hello'))
      const stats = getMultiTurnStats()
      expect(stats.totalTurns).toBe(1)
      expect(stats.totalTokens).toBeGreaterThan(0)
    })
  })

  describe('createMultiTurnTracker', () => {
    it('creates tracker with all methods', () => {
      const tracker = createMultiTurnTracker()
      expect(tracker.startTurn).toBeDefined()
      expect(tracker.addMessage).toBeDefined()
      expect(tracker.getStats).toBeDefined()
    })

    it('respects the maxTurns option', () => {
      // Create a tracker with a very small maxTurns
      createMultiTurnTracker({ maxTurns: 2 })
      
      startNewTurn() // turn 1
      startNewTurn() // turn 2
      startNewTurn() // turn 3 - should drop turn 1
      
      const history = getTurnHistory()
      expect(history.length).toBe(2)
      // The first remaining turn should be the 2nd one created
      expect(history[0].turnId).toContain('turn_2')
    })
  })
})
