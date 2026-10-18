/**
 * Passwordless email onboarding helpers for the guided provider-manager flow:
 * discover whether an email signs in or signs up, complete a 6-digit code
 * sign-in (minting or reusing an existing-account key), and validate a pasted
 * key's balance. The CLI top-up flow (topup.ts) inlines the same steps.
 */

import { randomUUID } from 'node:crypto'

import { logForDebugging } from '../../utils/debug.js'
import { AimlapiApiError, AimlapiClient, type BalanceResult } from './client.js'
import { resolveEndpoints } from './config.js'
import {
  acquireAimlapiSignInKeyLeaseAsync,
  clearAimlapiSignInKeyAsync,
  commitAimlapiSignInKeyAsync,
  refreshAimlapiSignInKeyLeaseAsync,
  releaseAimlapiSignInKeyLeaseAsync,
} from './topupState.js'
import { abortError, isAmbiguousTransportApiError, sleep } from './transport.js'

// A 401/403 from getBalance for a CACHED (not freshly minted) key is a
// definite rejection: the key was revoked or deleted server-side, not
// merely unreachable. Distinct from isAmbiguousTransportApiError's set
// (network/timeout/rate-limit/5xx), which says nothing about the key's
// validity and must not trigger cache invalidation or a replacement mint.
function isDefiniteCredentialRejection(error: unknown): boolean {
  return error instanceof AimlapiApiError && (error.status === 401 || error.status === 403)
}

function clientForInferenceBaseUrl(inferenceBaseUrl?: string): AimlapiClient {
  const endpoints = resolveEndpoints()
  if (inferenceBaseUrl?.trim()) endpoints.inferenceBaseUrl = inferenceBaseUrl.trim()
  return new AimlapiClient(endpoints)
}

const SIGN_IN_KEY_LEASE_POLL_INTERVAL_MS = 3000
// A losing process's own patience while a peer holds the lease. Kept at
// least as long as SIGN_IN_KEY_LEASE_STALE_MS's worst case, so a loser never
// gives up on (and reports an error for) a winner that is still legitimately
// within its own generous stale window.
const SIGN_IN_KEY_LEASE_POLL_TIMEOUT_MS = 160_000

/**
 * Mint the sign-in key for this email under a cross-process lease so racing
 * ProviderManager instances never both call POST /v1/keys for the same
 * account before either caches its result — the loser adopts the winner's
 * cached key instead of minting (and orphaning) its own. See
 * `AimlapiSignInKeyLease`.
 */
async function mintOrAdoptSignInKey(
  client: AimlapiClient,
  email: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<{ apiKey: string; apiKeyId: string }> {
  const owner = randomUUID()
  const deadline = Date.now() + SIGN_IN_KEY_LEASE_POLL_TIMEOUT_MS
  for (;;) {
    if (signal?.aborted) throw abortError(signal)
    const lease = await acquireAimlapiSignInKeyLeaseAsync(email, owner)
    if (lease.status === 'cached') {
      return { apiKey: lease.apiKey, apiKeyId: lease.apiKeyId }
    }
    if (lease.status === 'acquired') {
      let created: { key: string; id: string }
      try {
        created = await client.createKey(accessToken, 'OpenClaude CLI', signal)
      } catch (error) {
        // createKey is non-idempotent and exposes no retrieval-by-id
        // endpoint, so a transport-level failure is ambiguous: the POST may
        // have minted a key server-side before its response was lost, with
        // no way to recover that credential here. Releasing the lease in
        // that case would let a retry (or a racing peer) mint a second,
        // orphaned key. A caller-driven abort mid-flight is ambiguous too —
        // cancelling client-side does not stop the server from completing an
        // already-sent POST. A definite rejection means nothing was created,
        // so release immediately to let a retry proceed without waiting out
        // the stale window.
        if (!isAmbiguousTransportApiError(error) && !signal?.aborted) {
          await releaseAimlapiSignInKeyLeaseAsync(email, owner).catch((releaseError: unknown) => {
            logForDebugging(
              `Failed to release the AI/ML API sign-in key-mint lease: ${String(releaseError)}`,
              { level: 'warn' },
            )
          })
        }
        throw error
      }
      // createKey succeeded — the key exists server-side regardless of what
      // happens below, so nothing from here on may release the lease: this
      // commit is the ONLY durable record of that key, and losing it while
      // the lease is reclaimable would let a peer mint (and orphan) a
      // second one before this credential is ever recovered.
      //
      // Best-effort: give the cache-write phase its own fresh stale window
      // (see refreshAimlapiSignInKeyLeaseAsync) instead of sharing the
      // mint's budget — SIGN_IN_KEY_LEASE_STALE_MS already carries generous
      // margin over this refresh's own worst-case lock wait, so losing
      // ownership here should be exceedingly rare. A failed refresh call,
      // or one that reports ownership already lost, is still non-fatal: the
      // key was already minted, and the commit below is safe to attempt
      // regardless (its cache write is first-writer-wins, so a losing write
      // here is a harmless no-op, and it only retires a lease it still
      // owns) — but log the lost-ownership case, since it signals the
      // stale window was cut closer than expected and a peer may now also
      // be minting concurrently.
      const refreshed = await refreshAimlapiSignInKeyLeaseAsync(email, owner).catch(
        (refreshError: unknown): false => {
          logForDebugging(
            `Failed to refresh the AI/ML API sign-in key-mint lease: ${String(refreshError)}`,
            { level: 'warn' },
          )
          return false
        },
      )
      if (!refreshed) {
        logForDebugging(
          'AI/ML API sign-in key-mint lease ownership was lost before the cache write; ' +
            'a concurrent mint may be in flight.',
          { level: 'warn' },
        )
      }
      try {
        // Commits the cache entry and retires this lease together: leaving
        // the lease behind after a successful mint would let it resurface
        // as "held" for a fresh acquire as soon as something later clears
        // just the cache entry (see clearAimlapiSignInKeyAsync), even
        // though no mint is still running.
        await commitAimlapiSignInKeyAsync(email, created.key, created.id, owner)
      } catch (error) {
        // A required checkpoint, not a best-effort resume aid: returning the
        // key only in memory here risks losing it outright — if the caller
        // is then interrupted (e.g. the user presses Esc while verification
        // is completing) before it reaches a durable save of its own, the
        // lease is all that is left, and it eventually goes stale and lets a
        // retry mint (and orphan) a second key. Stop instead, and leave the
        // lease exactly as it is: still held, so a retry waits for it rather
        // than reclaiming it out from under this still-unresolved commit.
        throw new Error(
          `A key was issued (id ${created.id}), but the local recovery receipt could not ` +
            `be saved (${error instanceof Error ? error.message : String(error)}). Open ` +
            `https://aimlapi.com/app and rotate the issued key to recover access.`,
          { cause: error },
        )
      }
      return { apiKey: created.key, apiKeyId: created.id }
    }
    // held: a live peer is minting; back off and re-attempt rather than
    // minting in parallel and orphaning a credential.
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for a concurrent sign-in key mint. Retry to resume.')
    }
    await sleep(SIGN_IN_KEY_LEASE_POLL_INTERVAL_MS, signal)
  }
}

export type AimlapiEmailOnboardingResult =
  | { action: 'code-sent' }
  | { action: 'new-account'; sessionToken: string }

export type AimlapiCodeSignInResult = {
  sessionToken: string
  apiKey: string
  apiKeyId: string
} & (
  | { balanceStatus: 'confirmed'; lowBalance: boolean }
  | { balanceStatus: 'unknown'; balanceError: string }
)

export async function validateAimlapiApiKey(
  apiKey: string,
  signal?: AbortSignal,
  inferenceBaseUrl?: string,
): Promise<BalanceResult> {
  return clientForInferenceBaseUrl(inferenceBaseUrl).getBalance(apiKey.trim(), signal)
}

export async function beginAimlapiEmailOnboarding(
  email: string,
  signal?: AbortSignal,
): Promise<AimlapiEmailOnboardingResult> {
  const client = new AimlapiClient(resolveEndpoints())
  const account = await client.checkAccount(email, signal)
  switch (account.action) {
    case 'sign-in':
      await client.sendSignInCode(email, signal)
      return { action: 'code-sent' }
    case 'sign-up': {
      const auth = await client.createPasswordlessAccount(email, signal)
      return { action: 'new-account', sessionToken: auth.token }
    }
    default:
      throw new Error('AI/ML API returned an unsupported account action.')
  }
}

export async function completeAimlapiCodeSignIn(
  email: string,
  code: string,
  signal?: AbortSignal,
  inferenceBaseUrl?: string,
  existingKey?: { apiKey: string; apiKeyId: string },
): Promise<AimlapiCodeSignInResult> {
  const client = clientForInferenceBaseUrl(inferenceBaseUrl)
  const auth = await client.verifySignInCode(email, code, signal)
  let apiKey = existingKey?.apiKey?.trim() ?? ''
  let apiKeyId = existingKey?.apiKeyId ?? ''
  let mintedKey = false
  if (!apiKey) {
    // Reuse a previously issued key when one is supplied so a restart does not
    // mint a second key for the same account.
    const minted = await mintOrAdoptSignInKey(client, email, auth.token, signal)
    apiKey = minted.apiKey
    apiKeyId = minted.apiKeyId
    mintedKey = true
  }
  try {
    const balance = await client.getBalance(apiKey, signal)
    return {
      sessionToken: auth.token,
      apiKey,
      apiKeyId,
      balanceStatus: 'confirmed',
      lowBalance: balance.lowBalance,
    }
  } catch (error) {
    // A balance read failure must not discard an already-issued key. When THIS
    // call minted the key, even an aborted read returns it so the caller can
    // cache it — otherwise the next sign-in mints a second key for the account.
    // When the caller supplied the key it already holds it, so an abort can
    // propagate as usual.
    if (signal?.aborted && !mintedKey) throw error
    // A cached (not freshly minted) key the server now definitively rejects
    // is revoked or deleted, not merely unreachable. The cache is only ever
    // cleared on a successful profile save, so returning that dead key here
    // would have the caller re-cache it (first-writer-wins) and loop forever
    // on every future sign-in with no way out short of deleting local state.
    // Invalidate it and mint a replacement instead. This still preserves the
    // duplicate-mint protection for every OTHER (ambiguous) failure below,
    // which must not touch the cache or mint a second key alongside a
    // possibly-still-valid one.
    if (!mintedKey && isDefiniteCredentialRejection(error)) {
      await clearAimlapiSignInKeyAsync(email, apiKeyId).catch(() => {})
      const minted = await mintOrAdoptSignInKey(client, email, auth.token, signal)
      apiKey = minted.apiKey
      apiKeyId = minted.apiKeyId
      mintedKey = true
      try {
        const balance = await client.getBalance(apiKey, signal)
        return {
          sessionToken: auth.token,
          apiKey,
          apiKeyId,
          balanceStatus: 'confirmed',
          lowBalance: balance.lowBalance,
        }
      } catch (retryError) {
        return {
          sessionToken: auth.token,
          apiKey,
          apiKeyId,
          balanceStatus: 'unknown',
          balanceError: retryError instanceof Error ? retryError.message : String(retryError),
        }
      }
    }
    return {
      sessionToken: auth.token,
      apiKey,
      apiKeyId,
      balanceStatus: 'unknown',
      balanceError: error instanceof Error ? error.message : String(error),
    }
  }
}
