/**
 * Hybrid Context Strategy - Production Grade
 * 
 * Combines cached + new tokens intelligently.
 * Optimizes for cost vs accuracy.
 */

import { roughTokenCountEstimation } from '../services/tokenEstimation.js'
import type { Message } from '../types/message.js'

export interface HybridConfig {
  cacheWeight: number
  freshWeight: number
  maxTotalTokens: number
  costThreshold?: number
}

export interface ContextSplit {
  cached: Message[]
  fresh: Message[]
  cachedTokens: number
  freshTokens: number
  totalTokens: number
}

export interface HybridStrategyResult {
  selectedMessages: Message[]
  totalTokens: number
  strategy: 'cache_heavy' | 'fresh_heavy' | 'balanced'
  estimatedCost: number
}

const DEFAULT_CONFIG: Required<HybridConfig> = {
  cacheWeight: 0.4,
  freshWeight: 0.6,
  maxTotalTokens: 100000,
  costThreshold: 0.01,
}

// Keep enough for: tool_use -> tool_result -> assistant -> user -> next
const MIN_TAILMessages = 5

function getMessageChain(
  messages: Message[],
): { chains: Message[][]; orphans: Message[] } {
  const toolUseIds = new Set<string>()
  const toolUseMessages = new Map<string, Message[]>()
  const allMessagesByUuid = new Map<string, Message[]>()

  for (const msg of messages) {
    const uuid = msg.uuid ?? ''
    if (uuid) {
      const existing = allMessagesByUuid.get(uuid) ?? []
      existing.push(msg)
      allMessagesByUuid.set(uuid, existing)
    }

    const content = msg.message?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_use' && block?.id) {
          toolUseIds.add(block.id)
          const existing = toolUseMessages.get(block.id) ?? []
          existing.push(msg)
          toolUseMessages.set(block.id, existing)
        }
      }
    }
  }

  const chains: Message[][] = []
  const orphans: Message[] = []

  for (const [toolUseId, msgs] of toolUseMessages) {
    const chainMessages: Message[] = [...msgs]

    for (const msg of messages) {
      const content = msg.message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_result' && block?.tool_use_id === toolUseId) {
            chainMessages.push(msg)
          }
        }
      }
    }

    chains.push(chainMessages)
  }

  const chainMessageUuids = new Set<string>()
  for (const chain of chains) {
    for (const msg of chain) {
      if (msg.uuid) chainMessageUuids.add(msg.uuid)
    }
  }

  for (const [uuid, msgs] of allMessagesByUuid) {
    if (!chainMessageUuids.has(uuid)) {
      orphans.push(...msgs)
    }
  }

  return { chains, orphans }
}

function getCacheAge(message: Message): number {
  const created = message.message?.created_at ?? 0
  if (created === 0) return 1000
  return (Date.now() - created) / (1000 * 60 * 60)
}

function getMessageTokenCount(message: Message): number {
  const countTextTokens = (text: string): number => {
    if (text.length === 0) return 0
    return Math.max(1, roughTokenCountEstimation(text))
  }

  const content = message.message?.content
  if (typeof content === 'string') {
    return countTextTokens(content)
  }
  if (Array.isArray(content)) {
    let tokens = 0
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue

      const b = block as Record<string, unknown>

      if (b.type === 'text' && typeof b.text === 'string') {
        tokens += countTextTokens(b.text)
      } else if (b.type === 'tool_use') {
        const inputSize = JSON.stringify(b.input ?? {}).length
        tokens += Math.ceil(inputSize / 4) + 20
      } else if (b.type === 'tool_result') {
        if (typeof b.content === 'string') {
          tokens += countTextTokens(b.content)
        } else if (Array.isArray(b.content)) {
          for (const rc of b.content) {
            if (typeof rc === 'object' && rc !== null && 'text' in rc) {
              tokens += countTextTokens((rc as { text: string }).text)
            }
          }
        } else {
          tokens += 50
        }
        if (b.is_error === true) tokens += 10
      } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
        tokens += countTextTokens(b.thinking)
      }
    }
    return tokens
  }
  return 0
}

function calculateCacheValue(message: Message): number {
  const content = typeof message.message?.content === 'string' ? message.message.content : ''
  const age = getCacheAge(message)

  let value = 0.5

  if (content.includes('error') || content.includes('fail')) value += 0.3
  if (content.includes('function') || content.includes('class')) value += 0.2
  if (content.includes('important') || content.includes('key')) value += 0.15

  if (age < 1) value += 0.2
  else if (age < 6) value += 0.1
  else value -= 0.2

  if (message.message?.role === 'system') value += 0.1

  return Math.max(0, Math.min(1, value))
}

export function splitContext(
  messages: Message[],
  config: HybridConfig,
): ContextSplit {
  const cfg = { ...DEFAULT_CONFIG, ...config }

  const sorted = [...messages].sort((a, b) => {
    const aValue = calculateCacheValue(a)
    const bValue = calculateCacheValue(b)
    return bValue - aValue
  })

  const cached: Message[] = []
  const fresh: Message[] = []
  let cachedTokens = 0
  let freshTokens = 0

  const cacheTarget = Math.floor(cfg.maxTotalTokens * cfg.cacheWeight)
  const freshTarget = Math.floor(cfg.maxTotalTokens * cfg.freshWeight)

  for (const msg of sorted) {
    const tokens = getMessageTokenCount(msg)
    const age = getCacheAge(msg)

    if (age > 24 && cachedTokens < cacheTarget) {
      if (cachedTokens + tokens <= cacheTarget) {
        cached.push(msg)
        cachedTokens += tokens
        continue
      }
    }

    if (freshTokens + tokens <= freshTarget) {
      fresh.push(msg)
      freshTokens += tokens
    }
  }

  return {
    cached,
    fresh,
    cachedTokens,
    freshTokens,
    totalTokens: cachedTokens + freshTokens,
  }
}

export function applyHybridStrategy(
  messages: Message[],
  config: HybridConfig,
): HybridStrategyResult {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  
  // Preserve message chains (tool_use/tool_result pairs)
  const { chains } = getMessageChain(messages)
  
  // Always preserve the conversation tail (last N messages)
  const tailMessages = messages.slice(-MIN_TAILMessages)
  const coreMessages = messages.slice(0, -MIN_TAILMessages)
  
  const split = splitContext(coreMessages, cfg)

  let strategy: HybridStrategyResult['strategy'] = 'balanced'
  if (split.cachedTokens > split.freshTokens * 1.5) {
    strategy = 'cache_heavy'
  } else if (split.freshTokens > split.cachedTokens * 1.5) {
    strategy = 'fresh_heavy'
  }

  const allSelected = [
    ...chains.flat(),
    ...split.cached,
    ...split.fresh,
    ...tailMessages
  ]

  const seenUuids = new Set<string>()
  const selectedMessages: Message[] = []
  for (const msg of allSelected) {
    const uuid = msg.uuid ?? msg.message?.id ?? ''
    if (!seenUuids.has(uuid)) {
      seenUuids.add(uuid)
      selectedMessages.push(msg)
    }
  }

  selectedMessages.sort(
    (a, b) => (a.message?.created_at ?? 0) - (b.message?.created_at ?? 0)
  )

  let totalTokens = 0
  for (const msg of selectedMessages) {
    totalTokens += getMessageTokenCount(msg)
  }

  const estimatedCost = totalTokens * 0.000001 * 0.5

  return {
    selectedMessages,
    totalTokens,
    strategy,
    estimatedCost,
  }
}

export function optimizeForCost(messages: Message[], budget: number): Message[] {
  const result = applyHybridStrategy(messages, {
    cacheWeight: 0.7,
    freshWeight: 0.3,
    maxTotalTokens: Math.floor(budget * 1000),
    costThreshold: budget,
  })
  return result.selectedMessages
}

export function optimizeForAccuracy(messages: Message[], maxTokens: number): Message[] {
  const result = applyHybridStrategy(messages, {
    cacheWeight: 0.3,
    freshWeight: 0.7,
    maxTotalTokens: maxTokens,
  })
  return result.selectedMessages
}

export function getHybridStats(split: ContextSplit) {
  const cacheRatio = split.totalTokens > 0 ? split.cachedTokens / split.totalTokens : 0
  const freshRatio = split.totalTokens > 0 ? split.freshTokens / split.totalTokens : 0

  return {
    cacheRatio: Math.round(cacheRatio * 100),
    freshRatio: Math.round(freshRatio * 100),
    totalTokens: split.totalTokens,
    messageCount: split.cached.length + split.fresh.length,
    efficiency: split.totalTokens / (split.cachedTokens + split.freshTokens + 1),
  }
}
