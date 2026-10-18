import { disableKeepAlive, getProxyFetchOptions } from '../../utils/proxy.js'

const RETRYABLE_FETCH_ERROR_PATTERN =
  /socket connection was closed unexpectedly|ECONNRESET|EPIPE|socket hang up|Connection reset by peer|fetch failed/i

export type ProxyRetryFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export function isRetryableFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  if (error.name === 'AbortError') {
    return false
  }
  return RETRYABLE_FETCH_ERROR_PATTERN.test(error.message)
}

export async function fetchWithProxyRetry(
  input: string | URL | Request,
  init?: RequestInit,
  options?: {
    forAnthropicAPI?: boolean
    maxAttempts?: number
    fetcher?: ProxyRetryFetcher
  },
): Promise<Response> {
  const maxAttempts = Math.max(1, options?.maxAttempts ?? 2)
  const fetcher = options?.fetcher ?? fetch
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetcher(input, {
        ...init,
        ...getProxyFetchOptions({
          forAnthropicAPI: options?.forAnthropicAPI,
        }),
      })
      if (signal?.aborted) {
        void response.body?.cancel().catch(() => {})
        throw (
          signal.reason ??
          new DOMException('The operation was aborted.', 'AbortError')
        )
      }

      // If an upstream proxy or local NAT silently dropped the keep-alive socket,
      // it might result in a 502/504 response instead of a hard network exception.
      // We automatically disable keep-alive and retry to force a clean handshake.
      if (
        (response.status === 502 || response.status === 504) &&
        attempt < maxAttempts
      ) {
        void response.body?.cancel().catch(() => {})
        disableKeepAlive()
        continue
      }

      return response
    } catch (error) {
      lastError = error
      if (signal?.aborted) {
        throw error instanceof Error && error.name === 'AbortError'
          ? error
          : (signal.reason ?? error)
      }
      if (
        attempt >= maxAttempts ||
        !isRetryableFetchError(error)
      ) {
        throw error
      }
      disableKeepAlive()
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Fetch failed without an error object')
}
