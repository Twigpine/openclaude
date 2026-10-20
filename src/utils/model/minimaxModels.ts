/** MiniMax suggestions share the route catalog used by provider profiles. */
import { getCatalogEntriesForRoute, getRouteDefaultModel } from '../../integrations/index.js'
import type { ModelOption } from './modelOptions.js'
import { getAPIProvider } from './providers.js'
import { buildRouteCatalogModelOptions } from './routeCatalogOptions.js'

export function isMiniMaxProvider(): boolean {
  return getAPIProvider() === 'minimax'
}

export function getCachedMiniMaxModelOptions(): ModelOption[] {
  return buildRouteCatalogModelOptions(
    'MiniMax',
    getCatalogEntriesForRoute('minimax'),
    getRouteDefaultModel('minimax'),
  )
}
