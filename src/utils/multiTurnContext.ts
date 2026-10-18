/**
 * Multi-Turn Context Tracking - Production Grade
 * 
 * Tracks context across multiple tool use cycles.
 * Preserves state between tool invocations.
 */

import { roughTokenCountEstimation } from '../services/tokenEstimation.js'
import type { Message } from '../types/message.js'
import { getAutoMemPath } from '../memdir/paths.js'

export interface TurnContext {
  turnId: string
  startTime: number
  messages: Message[]
  toolCalls: Array<{
    id: string
    name: string
    input: Record<string, unknown>
    timestamp: number
  }>
  state: Map<string, unknown>
  tokens: number
}

export interface MultiTurnOptions {
  maxTurns?: number
  maxTokensPerTurn?: number
  preserveState?: boolean
}

const DEFAULT_OPTIONS: Required<MultiTurnOptions> = {
  maxTurns: 10,
  maxTokensPerTurn: 50000,
  preserveState: true,
}

let turnHistory: TurnContext[] = []
let currentTurn: TurnContext | null = null
let turnCounter = 0
let activeOptions: Required<MultiTurnOptions> = { ...DEFAULT_OPTIONS }
let activeProjectKey = ''

function currentProjectKeyForMultiTurn(): string {
  return getAutoMemPath() || ''
}

function ensureProjectScope(): void {
  const key = currentProjectKeyForMultiTurn()
  if (key !== activeProjectKey) {
    turnHistory = []
    currentTurn = null
    turnCounter = 0
    activeProjectKey = key
  }
}

export function startNewTurn(): TurnContext {
  ensureProjectScope()
  const turn: TurnContext = {
    turnId: `turn_${++turnCounter}_${Date.now()}`,
    startTime: Date.now(),
    messages: [],
    toolCalls: [],
    state: new Map(),
    tokens: 0,
  }

  if (turnHistory.length >= activeOptions.maxTurns) {
    turnHistory = turnHistory.slice(-activeOptions.maxTurns + 1)
  }

  currentTurn = turn
  turnHistory.push(turn)

  return turn
}

export function getCurrentTurn(): TurnContext | null {
  ensureProjectScope()
  return currentTurn
}

export function addMessageToTurn(message: Message): void {
  ensureProjectScope()
  const turn = currentTurn || startNewTurn()
  turn.messages.push(message)
  
  // Update token estimate
  const content = typeof message.message.content === 'string' 
    ? message.message.content 
    : JSON.stringify(message.message.content)
  turn.tokens += roughTokenCountEstimation(content)
}

export function addToolCallToTurn(call: TurnContext['toolCalls'][0]): void {
  ensureProjectScope()
  const turn = currentTurn || startNewTurn()
  turn.toolCalls.push(call)
}

export function setTurnState(key: string, value: unknown): void {
  ensureProjectScope()
  const turn = currentTurn || startNewTurn()
  turn.state.set(key, value)
}

export function getTurnState<T>(key: string): T | undefined {
  ensureProjectScope()
  return currentTurn?.state.get(key) as T
}

export function getTurnHistory(): TurnContext[] {
  ensureProjectScope()
  return turnHistory
}

export function getRecentTurns(n: number): TurnContext[] {
  ensureProjectScope()
  return turnHistory.slice(-n)
}

export function getMultiTurnStats() {
  ensureProjectScope()
  return {
    totalTurns: turnHistory.length,
    totalTokens: turnHistory.reduce((acc, t) => acc + t.tokens, 0),
    avgTokensPerTurn: turnHistory.length > 0 
      ? Math.round(turnHistory.reduce((acc, t) => acc + t.tokens, 0) / turnHistory.length) 
      : 0,
  }
}

export function clearTurnHistory(): void {
  turnHistory = []
  currentTurn = null
}

export function resetMultiTurnState(): void {
  clearTurnHistory()
  turnCounter = 0
}

export function createMultiTurnTracker(options: MultiTurnOptions = {}) {
  activeOptions = { ...DEFAULT_OPTIONS, ...options }
  return {
    startTurn: startNewTurn,
    getCurrentTurn,
    addMessage: addMessageToTurn,
    addToolCall: addToolCallToTurn,
    setState: (k: string, v: unknown) => setTurnState(k, v),
    getState: <T>(k: string) => getTurnState<T>(k),
    getHistory: getTurnHistory,
    getRecent: (n: number) => getRecentTurns(n),
    getStats: getMultiTurnStats,
    reset: resetMultiTurnState,
  }
}
