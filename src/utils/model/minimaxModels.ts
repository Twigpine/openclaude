/**
 * MiniMax model list for the /model picker.
 * Full model catalog from MiniMax API.
 */

import type { ModelOption } from './modelOptions.js'
import { getAPIProvider } from './providers.js'
export function isMiniMaxProvider(): boolean {
  return getAPIProvider() === 'minimax'
}

function getMiniMaxModels(): ModelOption[] {
  return [
    // Latest Generation Models - use correct MiniMax naming with M prefix
    { value: 'MiniMax-M2', label: 'MiniMax M2', description: 'MoE model - 131K context - Chat/Code/Reasoning' },
    { value: 'MiniMax-M2.1', label: 'MiniMax M2.1', description: 'Enhanced - 200K context - Vision' },
    { value: 'MiniMax-M2.5', label: 'MiniMax M2.5', description: 'Flagship - 256K context - Vision/Function-calling' },
    { value: 'MiniMax-M2.7', label: 'MiniMax M2.7', description: 'Flagship - 256K context - Chat/Code/Reasoning' },
    { value: 'MiniMax-M2.7-highspeed', label: 'MiniMax M2.7 Highspeed', description: 'Fast flagship - 256K context - Chat/Code/Reasoning' },
    { value: 'MiniMax-M3', label: 'MiniMax M3', description: 'Next-gen - 1M context - Coding/Agentic/Reasoning' },
    { value: 'MiniMax-Text-01', label: 'MiniMax Text 01', description: 'Text-focused - 512K context - FREE' },
    { value: 'MiniMax-Text-01-Preview', label: 'MiniMax Text 01 Preview', description: 'Preview - 256K context - FREE' },
    { value: 'MiniMax-Vision-01', label: 'MiniMax Vision 01', description: 'Vision model - 32K context' },
    { value: 'MiniMax-Vision-01-Fast', label: 'MiniMax Vision 01 Fast', description: 'Fast vision - 16K context - FREE' },
    // Legacy free tier models
    { value: 'abab6.5s-chat', label: 'ABAB 6.5S Chat', description: 'Legacy free - 16K context' },
    { value: 'abab6.5-chat', label: 'ABAB 6.5 Chat', description: 'Legacy free - 32K context' },
    { value: 'abab6.5g-chat', label: 'ABAB 6.5G Chat', description: 'Generation 6.5 - 32K context' },
    { value: 'abab6-chat', label: 'ABAB 6 Chat', description: 'Legacy - 8K context' },
  ]
}

let cachedMiniMaxOptions: ModelOption[] | null = null

export function getCachedMiniMaxModelOptions(): ModelOption[] {
  if (!cachedMiniMaxOptions) {
    cachedMiniMaxOptions = getMiniMaxModels()
  }
  return cachedMiniMaxOptions
}
