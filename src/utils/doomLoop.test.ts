import { describe, it, expect, beforeEach } from 'bun:test'
import {
  checkDoomLoop,
  resetDoomLoop,
  resetAllDoomLoops,
  getDoomLoopState,
} from './doomLoop.js'

describe('doomLoop', () => {
  beforeEach(() => {
    resetAllDoomLoops()
  })

  it('allows first call', () => {
    const result = checkDoomLoop('Bash', { command: 'ls' })
    expect(result.blocked).toBe(false)
    expect(result.count).toBe(1)
  })

  it('allows second identical call', () => {
    checkDoomLoop('Bash', { command: 'ls' })
    const result = checkDoomLoop('Bash', { command: 'ls' })
    expect(result.blocked).toBe(false)
    expect(result.count).toBe(2)
  })

  it('blocks third identical call by default', () => {
    checkDoomLoop('Bash', { command: 'ls' })
    checkDoomLoop('Bash', { command: 'ls' })
    const result = checkDoomLoop('Bash', { command: 'ls' })
    expect(result.blocked).toBe(true)
    expect(result.count).toBe(3)
  })

  it('resets when a different tool/input is called', () => {
    checkDoomLoop('Bash', { command: 'ls' })
    checkDoomLoop('Bash', { command: 'ls' })
    // Different tool
    const result = checkDoomLoop('Grep', { pattern: 'foo' })
    expect(result.blocked).toBe(false)
    expect(result.count).toBe(1)
  })

  it('resets when same tool has different input', () => {
    checkDoomLoop('Bash', { command: 'ls' })
    checkDoomLoop('Bash', { command: 'ls' })
    const result = checkDoomLoop('Bash', { command: 'pwd' })
    expect(result.blocked).toBe(false)
    expect(result.count).toBe(1)
  })

  it('respects custom threshold', () => {
    checkDoomLoop('Bash', { command: 'ls' }, { threshold: 5 })
    checkDoomLoop('Bash', { command: 'ls' }, { threshold: 5 })
    checkDoomLoop('Bash', { command: 'ls' }, { threshold: 5 })
    const result = checkDoomLoop('Bash', { command: 'ls' }, { threshold: 5 })
    expect(result.blocked).toBe(false)
    expect(result.count).toBe(4)
    const blocked = checkDoomLoop('Bash', { command: 'ls' }, { threshold: 5 })
    expect(blocked.blocked).toBe(true)
    expect(blocked.count).toBe(5)
  })

  it('reset clears state for the main agent', () => {
    checkDoomLoop('Bash', { command: 'ls' })
    checkDoomLoop('Bash', { command: 'ls' })
    resetDoomLoop()
    const result = checkDoomLoop('Bash', { command: 'ls' })
    expect(result.blocked).toBe(false)
    expect(result.count).toBe(1)
  })

  it('tracks agents independently', () => {
    // Three "agents" each make the same call once — interleaved they must
    // not trip the shared-counter block.
    expect(checkDoomLoop('Read', { file: 'a' }, { agentKey: 'agent-1' }).count).toBe(1)
    expect(checkDoomLoop('Read', { file: 'a' }, { agentKey: 'agent-2' }).count).toBe(1)
    const third = checkDoomLoop('Read', { file: 'a' }, { agentKey: 'agent-3' })
    expect(third.blocked).toBe(false)
    expect(third.count).toBe(1)
  })

  it('interleaved calls from another agent do not reset the counter', () => {
    checkDoomLoop('Bash', { command: 'ls' })
    checkDoomLoop('Grep', { pattern: 'x' }, { agentKey: 'agent-1' })
    checkDoomLoop('Bash', { command: 'ls' })
    const result = checkDoomLoop('Bash', { command: 'ls' })
    expect(result.blocked).toBe(true)
    expect(result.count).toBe(3)
  })

  it('resetting one agent leaves others intact', () => {
    checkDoomLoop('Bash', { command: 'ls' })
    checkDoomLoop('Bash', { command: 'ls' })
    checkDoomLoop('Bash', { command: 'ls' }, { agentKey: 'agent-1' })
    checkDoomLoop('Bash', { command: 'ls' }, { agentKey: 'agent-1' })
    resetDoomLoop('agent-1')
    // agent-1 restarts from scratch
    expect(checkDoomLoop('Bash', { command: 'ls' }, { agentKey: 'agent-1' }).count).toBe(1)
    // main still one call away from the block
    const main = checkDoomLoop('Bash', { command: 'ls' })
    expect(main.blocked).toBe(true)
    expect(main.count).toBe(3)
  })

  it('getDoomLoopState returns current state', () => {
    checkDoomLoop('Bash', { command: 'ls' })
    const state = getDoomLoopState()
    expect(state.consecutiveCount).toBe(1)
    expect(state.blocked).toBe(false)
    expect(state.lastSignature).toContain('Bash')
  })

  it('getDoomLoopState is per-agent', () => {
    checkDoomLoop('Bash', { command: 'ls' }, { agentKey: 'agent-1' })
    expect(getDoomLoopState('agent-1').consecutiveCount).toBe(1)
    expect(getDoomLoopState().consecutiveCount).toBe(0)
  })

  it('distinguishes large inputs that share a long identical prefix', () => {
    // Regression: prefix-truncated signatures collided for inputs identical
    // in the first 2KB — e.g. two Write calls to the same file differing only
    // in trailing content — falsely tripping the block on distinct work.
    const prefix = 'x'.repeat(4096)
    checkDoomLoop('Write', { file_path: '/a.ts', content: prefix + 'ONE' })
    checkDoomLoop('Write', { file_path: '/a.ts', content: prefix + 'TWO' })
    const third = checkDoomLoop('Write', { file_path: '/a.ts', content: prefix + 'THREE' })
    expect(third.blocked).toBe(false)
    expect(third.count).toBe(1)
  })
})
