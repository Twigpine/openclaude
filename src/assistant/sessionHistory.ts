import axios from 'axios'
import { getOauthConfig } from '../constants/oauth.js'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import { logForDebugging } from '../utils/debug.js'
import { getOAuthHeaders, prepareApiRequest } from '../utils/teleport/api.js'
import {
  ConversationCache,
  createConversationCache,
} from '../utils/conversationCache.js'
import {
  deserializeFromCacheMessage,
  serializeToCacheMessage,
  type SDKMessageCacheRecord,
} from './sessionHistorySerialization.js'
import {
  saveSession,
  loadSession,
  createSession,
} from '../utils/sessionPersistence.js'

export const HISTORY_PAGE_SIZE = 100

// Module-level cache for session history
let historyCache: ConversationCache | undefined

function getHistoryCache(): ConversationCache {
  if (!historyCache) {
    historyCache = createConversationCache({
      maxSize: 50,
      ttlMs: 60 * 60 * 1000, // 1 hour
    })
  }
  return historyCache
}

export type HistoryPage = {
  events: SDKMessage[]
  firstId: string | null
  hasMore: boolean
}

type SessionEventsResponse = {
  data: SDKMessage[]
  has_more: boolean
  first_id: string | null
  last_id: string | null
}

export type HistoryAuthCtx = {
  baseUrl: string
  headers: Record<string, string>
}

export async function createHistoryAuthCtx(
  sessionId: string,
): Promise<HistoryAuthCtx> {
  const { accessToken, orgUUID } = await prepareApiRequest()
  return {
    baseUrl: `${getOauthConfig().BASE_API_URL}/v1/sessions/${sessionId}/events`,
    headers: {
      ...getOAuthHeaders(accessToken),
      'anthropic-beta': 'ccr-byoc-2025-07-29',
      'x-organization-uuid': orgUUID,
    },
  }
}

async function fetchPage(
  ctx: HistoryAuthCtx,
  params: Record<string, string | number | boolean>,
  label: string,
): Promise<HistoryPage | null> {
  const resp = await axios
    .get<SessionEventsResponse>(ctx.baseUrl, {
      headers: ctx.headers,
      params,
      timeout: 15000,
      validateStatus: () => true,
    })
    .catch(() => null)
  if (!resp || resp.status !== 200) {
    logForDebugging(`[${label}] HTTP ${resp?.status ?? 'error'}`)
    return null
  }
  return {
    events: Array.isArray(resp.data.data) ? resp.data.data : [],
    firstId: resp.data.first_id,
    hasMore: resp.data.has_more,
  }
}

function extractSessionId(baseUrl: string): string {
  // More robust extraction - handle various URL formats
  const match = baseUrl.match(/\/v1\/sessions\/([^/]+)/)
  return match ? match[1] : 'default'
}

export async function fetchLatestEvents(
  ctx: HistoryAuthCtx,
  limit = HISTORY_PAGE_SIZE,
): Promise<HistoryPage | null> {
  const sessionId = extractSessionId(ctx.baseUrl)

  const page = await fetchPage(ctx, { limit, anchor_to_latest: true }, 'fetchLatestEvents')

  if (page && page.events.length > 0) {
    await cacheSession(sessionId, page.events, page.hasMore, page.firstId)
    return page
  }

  const cached = await loadCachedSession(sessionId)
  if (cached && cached.length > 0) {
    const metadata = getSessionCacheMetadata(sessionId)
    return {
      events: cached,
      firstId: metadata?.lastId ?? null,
      hasMore: metadata?.hasMore ?? false,
    }
  }

  return page
}

export async function fetchOlderEvents(
  ctx: HistoryAuthCtx,
  beforeId: string,
  limit = HISTORY_PAGE_SIZE,
): Promise<HistoryPage | null> {
  return fetchPage(ctx, { limit, before_id: beforeId }, 'fetchOlderEvents')
}

const lastSavedCounts = new Map<string, number>()
const lastSavedIds = new Map<string, Set<string>>()
const sessionMetadataCache = new Map<string, { hasMore: boolean; lastId: string | null }>()

export async function cacheSession(
  sessionId: string,
  events: SDKMessage[],
  hasMore = false,
  lastId: string | null = null,
): Promise<void> {
  const cache = getHistoryCache()
  const messages = serializeToCacheMessage(events)
  cache.set(sessionId, messages)

  sessionMetadataCache.set(sessionId, { hasMore, lastId })

  const newUuids = new Set(
    events
      .map(event => ('uuid' in event ? event.uuid : undefined))
      .filter((uuid): uuid is string => typeof uuid === 'string'),
  )
  const lastUuids = lastSavedIds.get(sessionId)
  const newCount = events.length
  const lastCount = lastSavedCounts.get(sessionId) ?? 0

  const hasNewUuids =
    newUuids.size > 0 &&
    (!lastUuids || [...newUuids].some(uuid => !lastUuids.has(uuid)))
  if (hasNewUuids || newCount !== lastCount) {
    lastSavedCounts.set(sessionId, newCount)
    lastSavedIds.set(sessionId, newUuids)

    const session = createSession(
      messages as never,
      { model: process.env.OPENAI_MODEL },
    )
    session.id = sessionId
    session.pagination = { hasMore, lastId }
    await saveSession(session)
  }
}

export async function loadCachedSession(
  sessionId: string,
): Promise<SDKMessage[] | null> {
  const cache = getHistoryCache()
  const cached = cache.get(sessionId)
  if (cached) {
    return deserializeFromCacheMessage(cached)
  }

  try {
    const session = await loadSession(sessionId)
    if (session) {
      const events = session.messages as unknown as SDKMessageCacheRecord[]
      cache.set(sessionId, events)

      if (session.pagination) {
        sessionMetadataCache.set(sessionId, {
          hasMore: session.pagination.hasMore,
          lastId: session.pagination.lastId,
        })
      }

      return deserializeFromCacheMessage(events)
    }
  } catch {
    // Session not found or corrupt
  }

  return null
}

export function getSessionCacheMetadata(
  sessionId: string,
): { hasMore: boolean; lastId: string | null } | undefined {
  return sessionMetadataCache.get(sessionId)
}
