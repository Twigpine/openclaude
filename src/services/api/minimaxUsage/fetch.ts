import { getMiniMaxBaseUrlValidationError } from '../../../integrations/routeMetadata.js'
import { createCombinedAbortSignal } from '../../../utils/combinedAbortSignal.js'
import { logForDebugging } from '../../../utils/debug.js'
import { getClaudeCodeUserAgent } from '../../../utils/userAgent.js'
import {
  DEFAULT_MINIMAX_BASE_URL,
  DEFAULT_MINIMAX_UNAVAILABLE_MESSAGE,
  type MiniMaxUsageData,
} from './types.js'
import { normalizeMiniMaxUsagePayload } from './parse.js'

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

export function resolveMiniMaxUsageBaseUrl(
  baseUrl = process.env.OPENAI_BASE_URL ??
    process.env.OPENAI_API_BASE ??
    DEFAULT_MINIMAX_BASE_URL,
): string {
  const trimmed = baseUrl.trim()
  return trimmed ? trimTrailingSlash(trimmed) : DEFAULT_MINIMAX_BASE_URL
}

function resolveConfiguredMiniMaxUsageBaseUrl(
  baseUrl?: string,
): { baseUrl: string; usedDefault: boolean } {
  const configuredBaseUrl =
    baseUrl ?? process.env.OPENAI_BASE_URL ?? process.env.OPENAI_API_BASE

  if (!configuredBaseUrl?.trim()) {
    return {
      baseUrl: DEFAULT_MINIMAX_BASE_URL,
      usedDefault: true,
    }
  }

  return {
    baseUrl: resolveMiniMaxUsageBaseUrl(configuredBaseUrl),
    usedDefault: false,
  }
}

function buildUnavailableResult(message: string): MiniMaxUsageData {
  return {
    availability: 'unknown',
    snapshots: [],
    message,
  }
}

export function getMiniMaxUsageUrls(baseUrl?: string): string[] {
  const { baseUrl: resolvedBaseUrl, usedDefault } =
    resolveConfiguredMiniMaxUsageBaseUrl(baseUrl)

  try {
    const base = new URL(`${resolvedBaseUrl}/`)
    return [
      new URL('token_plan/remains', base).toString(),
      new URL('api/openplatform/coding_plan/remains', base).toString(),
    ]
  } catch {
    if (usedDefault) {
      const fallbackBase = new URL(`${DEFAULT_MINIMAX_BASE_URL}/`)
      return [
        new URL('token_plan/remains', fallbackBase).toString(),
        new URL('api/openplatform/coding_plan/remains', fallbackBase).toString(),
      ]
    }

    throw new Error(
      `MiniMax usage base URL is invalid: ${resolvedBaseUrl}`,
    )
  }
}

export async function fetchMiniMaxUsage(): Promise<MiniMaxUsageData> {
  const apiKey = process.env.MINIMAX_API_KEY || process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error(
      'MiniMax auth is required. Set MINIMAX_API_KEY or OPENAI_API_KEY.',
    )
  }

  const usageUrls = getMiniMaxUsageUrls()
  for (const usageUrl of usageUrls) {
    const validationError = getMiniMaxBaseUrlValidationError(usageUrl)
    if (validationError) throw new Error(validationError)
  }
  const nonFatalFailures: Array<{ status: number; body: string }> = []
  let lastFatalError: Error | null = null

  for (const usageUrl of usageUrls) {
    let response: Response
    const { signal, cleanup } = createCombinedAbortSignal(undefined, {
      timeoutMs: 5000,
    })
    try {
      try {
        response = await fetch(usageUrl, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'User-Agent': getClaudeCodeUserAgent(),
          },
          signal,
        })
      } catch (error) {
        logForDebugging(
          `[minimax] usage request failed for ${usageUrl}: ${error instanceof Error ? error.message : String(error)}`,
          { level: 'warn' },
        )
        lastFatalError =
          error instanceof Error ? error : new Error(String(error))
        continue
      }

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '')
        if ([400, 401, 403, 404].includes(response.status)) {
          nonFatalFailures.push({ status: response.status, body: errorBody })
          continue
        }
        lastFatalError = new Error(
          `MiniMax usage error ${response.status}: ${errorBody || 'unknown error'}`,
        )
        continue
      }

      const normalized = normalizeMiniMaxUsagePayload(await response.json())
      if (normalized.availability === 'available') {
        return normalized
      }
    } finally {
      cleanup()
    }
  }

  if (nonFatalFailures.length > 0) {
    const latest = nonFatalFailures[nonFatalFailures.length - 1]
    logForDebugging(
      `[minimax] usage endpoint returned non-fatal status ${latest.status}: ${latest.body}`,
      { level: 'warn' },
    )
    return buildUnavailableResult(DEFAULT_MINIMAX_UNAVAILABLE_MESSAGE)
  }

  if (lastFatalError) {
    throw lastFatalError
  }

  return buildUnavailableResult(DEFAULT_MINIMAX_UNAVAILABLE_MESSAGE)
}
