/**
 * Shared transport-failure helpers for the AI/ML API integration: an
 * abortable sleep used by every lease-poll loop, and the predicate that
 * distinguishes a genuinely ambiguous request outcome from a definite server
 * rejection. Used by both topup.ts (CLI) and onboarding.ts (GUI sign-in) so
 * the ambiguity rule — which decides whether a non-idempotent mutation's
 * lease is safe to release — cannot drift between the two callers.
 */

import { AimlapiApiError } from './client.js'

export function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal))
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => signal?.removeEventListener('abort', onAbort)
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      cleanup()
      reject(abortError(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// Transient transport failures (network error, timeout, rate-limit, 5xx) say
// nothing about whether a request landed server-side: polling retries them
// for a session's fate instead of aborting, and a non-idempotent mutation
// (createKey, exchange) must not treat them as proof it never happened. A
// genuine 4xx (other than 408/429) is a definitive server rejection instead.
//
// A 2xx status belongs in this set too, not the definite-failure side: it
// proves the server received and processed the request, so client.request
// throwing anyway (empty body, non-JSON body, oversized body, or a body that
// parsed but failed an endpoint's own shape check, e.g. createKey's
// isCreatedKey) means the response confirming a non-idempotent mutation was
// lost, not that the mutation never happened — if anything a 2xx is stronger
// evidence the mutation committed than a 5xx or a network error is. Treating
// it as a definite failure would release a mint/exchange lease and let a
// retry orphan the credential the lost response could no longer name.
//
// This predicate alone is NOT the complete ambiguity test for a mutation's
// in-flight request: client.request rethrows a caller-driven abort as the
// raw (unwrapped) abort error rather than an AimlapiApiError, so it fails the
// `instanceof` check here on its own. A caller aborting an in-flight POST
// does not stop the server from completing it, so callers guarding a
// non-idempotent mutation must also treat `signal?.aborted` as ambiguous
// alongside this predicate — see exchangeKeyWithLease, doMint's catch in
// mintExistingAccountKeyWithLease, and mintOrAdoptSignInKey.
export function isAmbiguousTransportApiError(error: unknown): boolean {
  return (
    error instanceof AimlapiApiError &&
    (error.status === 0 ||
      error.status === 408 ||
      error.status === 429 ||
      error.status >= 500 ||
      (error.status >= 200 && error.status < 300))
  )
}
