/** MiniMax suggestions share the route catalog used by provider profiles. */
import { getCatalogEntriesForRoute, getRouteDefaultModel } from '../../integrations/index.js'
import type { ModelOption } from './modelOptions.js'
import { getAPIProvider } from './providers.js'
import { buildRouteCatalogModelOptions } from './routeCatalogOptions.js'

export function isMiniMaxProvider(): boolean {
  return getAPIProvider() === 'minimax'
}

// These legacy IDs were accepted before the descriptor-backed picker, but
// have no shared descriptor. Retirement from suggestions must not revoke them.
const legacyMiniMaxModelIds = new Set([
  'abab6.5s-chat',
  'abab6.5-chat',
  'abab6.5g-chat',
  'abab6-chat',
])

export function isKnownMiniMaxModel(model: string): boolean {
  return legacyMiniMaxModelIds.has(model) ||
    getCatalogEntriesForRoute('minimax').some(entry => entry.apiName === model)
}

export function getCachedMiniMaxModelOptions(): ModelOption[] {
  return buildRouteCatalogModelOptions(
    'MiniMax',
    getCatalogEntriesForRoute('minimax'),
    getRouteDefaultModel('minimax'),
    'minimax',
  )
}
