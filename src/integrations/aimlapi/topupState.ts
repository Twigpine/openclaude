import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

import { logForDebugging } from '../../utils/debug.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import * as lockfile from '../../utils/lockfile.js'

export type AimlapiTopupIntent = {
  email: string
  amountUsdMinor: number
  autoTopUp: boolean
  partnerId: string
  partnerName: string
  appBaseUrl: string
  inferenceBaseUrl: string
  payBaseUrl: string
  verificationBaseUrl: string
}

export type AimlapiPersistedTopup = AimlapiTopupIntent & {
  paymentSessionId: string
  resumeSessionToken: string
  /**
   * Existing-account key issued for this intent, retained so an interrupted
   * checkout resumes on the same credential instead of minting another key.
   */
  apiKey?: string
  apiKeyId?: string
  /**
   * Model chosen for this provisioning; retained with the settled receipt so a
   * resumed profile write configures the original model instead of recomputing
   * it from (possibly different) retry arguments.
   */
  model?: string
  /**
   * Set once payment/exchange has completed and `apiKey` is the final
   * provisioned credential. The next run then resumes the profile write with
   * that key instead of re-provisioning a one-shot-exchanged (now stranded)
   * session.
   */
  settled?: boolean
  /**
   * Whether this checkout must be exchanged for a fresh key (a paid sign-up
   * checkout). Persisted so a retry that now resolves to sign-in still exchanges
   * the paid session instead of minting an unrelated key and stranding it.
   */
  exchange?: boolean
  /**
   * Exchange lease. The one-shot key exchange is not idempotent, so exactly one
   * process may run it for a given payment id. The owner claims the lease under
   * the state lock before the network call; a peer that sees a fresh foreign
   * lease waits for the resulting settled receipt instead of exchanging too. A
   * lease older than `EXCHANGE_LEASE_STALE_MS` belonged to a crashed holder and
   * is reclaimable.
   */
  exchangeLeaseOwner?: string
  exchangeLeaseAt?: number
  /**
   * Key-mint lease. Minting an existing-account key (POST /v1/keys) is not
   * idempotent either — the server mints a fresh credential on every call, with
   * nothing to detect a duplicate — so exactly one process may mint per intent.
   * Same acquire/reclaim shape as the exchange lease; see
   * `KEY_MINT_LEASE_STALE_MS`.
   */
  keyMintLeaseOwner?: string
  keyMintLeaseAt?: number
}

export type AimlapiCheckoutState = Pick<
  AimlapiPersistedTopup,
  | 'paymentSessionId'
  | 'resumeSessionToken'
  | 'apiKey'
  | 'apiKeyId'
  | 'model'
  | 'settled'
  | 'exchange'
>

function statePath(): string {
  return join(getClaudeConfigHomeDir(), 'aimlapi-topup.json')
}

const LOCK_RETRY_MS = 25
const LOCK_TIMEOUT_MS = 5_000
// The interactive (Ink) flow waits for the lock without blocking timers, the UI,
// or SIGINT, so it can afford a longer ceiling than the sync path.
const LOCK_TIMEOUT_ASYNC_MS = 15_000
// Short enough that a dead holder's lock is recoverable well within the deadline
// (our critical sections are sub-millisecond, so a live holder never approaches
// this; proper-lockfile also refreshes the mtime while held).
const LOCK_STALE_MS = 8_000
// A fresh exchange lease means a live peer is mid-exchange; older than this it
// belonged to a crashed holder and is reclaimable. Generous: the exchange is a
// single remote POST, but a slow network must not orphan the one-shot session.
const EXCHANGE_LEASE_STALE_MS = 75_000
// Same reasoning as EXCHANGE_LEASE_STALE_MS: minting a key is also a single
// remote POST with no long poll before it, so the same generous window covers
// a slow network without letting a crashed holder pin the slot for long.
const KEY_MINT_LEASE_STALE_MS = 75_000
/** Owner-only file/dir modes; these records hold API credentials. */
const FILE_MODE = 0o600
const DIR_MODE = 0o700
/**
 * Identity fields for topup-intent matching, NOT `partnerName`. The partner id
 * is the identity; `partnerName` is display metadata that travels alongside it
 * and is free to change (it did, on the Gitlawb -> Twigpine rebrand). Matching
 * on the name would strand a persisted receipt written under the old name, so a
 * user resuming an in-flight topup after upgrading would fail `matchesIntent` and
 * restart the checkout.
 */
const INTENT_KEYS: ReadonlyArray<keyof AimlapiTopupIntent> = [
  'email',
  'amountUsdMinor',
  'autoTopUp',
  'partnerId',
  'appBaseUrl',
  'inferenceBaseUrl',
  'payBaseUrl',
  'verificationBaseUrl',
]

/**
 * proper-lockfile clears a stale lock with `rmdir` + `mkdir` and does not
 * re-check ownership in between, so two processes reclaiming the same abandoned
 * lock can surface a transient filesystem error instead of `ELOCKED` (observed:
 * `EPERM` on `rmdir` under Windows). Those mean contention, not failure - retry
 * until the deadline so exactly one winner emerges instead of killing the caller.
 */
const RETRYABLE_LOCK_CODES: ReadonlySet<string> = new Set([
  'ELOCKED',
  'EPERM',
  'EEXIST',
  'ENOENT',
  'ENOTEMPTY',
  'EBUSY',
])

/**
 * `ELOCKED` is ordinary contention. The rest are also produced by a genuine
 * permission or disk problem, which must not hide behind five seconds of quiet
 * retries followed by a generic timeout, so they are surfaced louder.
 */
const EXPECTED_CONTENTION_CODES: ReadonlySet<string> = new Set(['ELOCKED'])

// Jitter so racing acquirers do not retry in lockstep and collide again on the
// same steal window.
function jitteredLockDelay(): number {
  return LOCK_RETRY_MS + Math.floor(Math.random() * LOCK_RETRY_MS)
}

function waitForLock(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, jitteredLockDelay())
}

// Non-blocking counterpart of waitForLock for the interactive flow: yields to the
// event loop between retries instead of freezing timers, the Ink UI, and SIGINT.
function delayForLock(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, jitteredLockDelay()))
}

function lockOptions(target: string): Parameters<typeof lockfile.lockSync>[1] {
  return {
    lockfilePath: `${target}.lock`,
    stale: LOCK_STALE_MS,
    // The state file may not exist yet on the first claim, so skip realpath.
    realpath: false,
    onCompromised: (error: Error) => {
      logForDebugging(`AI/ML API checkout state lock compromised: ${error}`, {
        level: 'error',
      })
    },
  }
}

/**
 * Classify a lock-acquire error: return the code to retry on, or rethrow a
 * genuine permission/disk failure. Logs each distinct condition the first time
 * it is swallowed so a real failure is visible immediately instead of looking
 * like plain contention (logging every pass would bury it under ~100 lines).
 */
function classifyLockError(
  error: unknown,
  seenCodes: Set<string>,
  target: string,
): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : undefined
  if (!code || !RETRYABLE_LOCK_CODES.has(code)) throw error
  if (!seenCodes.has(code)) {
    seenCodes.add(code)
    logForDebugging(
      `AI/ML API checkout state lock retrying after ${code} on ${target}`,
      { level: EXPECTED_CONTENTION_CODES.has(code) ? 'debug' : 'warn' },
    )
  }
  return code
}

function lockTimeoutError(code: string, retries: number): Error {
  return new Error(
    `Timed out waiting for the AI/ML API checkout state lock (last: ${code}, ${retries} retries).`,
  )
}

function ensureOwnerOnlyDir(target: string): void {
  const dir = dirname(target)
  // mkdirSync(recursive) returns the first directory it created, or undefined if
  // `dir` already existed.
  const created = mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  // Only tighten a directory THIS flow created. OPENCLAUDE_CONFIG_DIR may point
  // at a pre-existing shared/project root (or `/`), and forcing that to 0700
  // would break other users of it — the state file's own 0600 mode protects the
  // credential regardless. (mkdir's mode is masked by umask, so re-apply it to
  // the directory we made. Best-effort: platforms without POSIX modes ignore it.)
  if (created !== undefined) {
    try {
      chmodSync(created, DIR_MODE)
    } catch {
      // No POSIX permissions to enforce here.
    }
  }
}

function logContendedAcquire(
  retries: number,
  startedAt: number,
  lastCode?: string,
): void {
  if (retries === 0) return
  logForDebugging(
    `AI/ML API checkout state lock contended: acquired after ${retries} retries in ${Date.now() - startedAt}ms (last: ${lastCode})`,
    { level: 'debug' },
  )
}

/**
 * Serialize checkout-state mutations through the shared `proper-lockfile`
 * wrapper rather than a bespoke advisory lock: its mkdir-based acquire is atomic
 * and its release is ownership-aware, so a holder cannot delete a lock another
 * process re-acquired after ours went stale. It retries until a deadline so
 * contending callers converge on the single stored payment session instead of
 * failing outright.
 */
function withStateLock<T>(operation: () => T, target: string = statePath()): T {
  ensureOwnerOnlyDir(target)
  const startedAt = Date.now()
  const deadline = startedAt + LOCK_TIMEOUT_MS
  let release: (() => void) | undefined
  let retries = 0
  let lastCode: string | undefined
  const seenCodes = new Set<string>()
  while (!release) {
    try {
      release = lockfile.lockSync(target, lockOptions(target))
    } catch (error) {
      lastCode = classifyLockError(error, seenCodes, target)
      retries += 1
      if (Date.now() >= deadline) throw lockTimeoutError(lastCode, retries)
      waitForLock()
    }
  }
  logContendedAcquire(retries, startedAt, lastCode)
  try {
    return operation()
  } finally {
    try {
      release()
    } catch {
      // Already released, or the lock was compromised and re-acquired by another
      // owner; proper-lockfile will not delete a lock that is no longer ours.
    }
  }
}

/**
 * Async counterpart of withStateLock for the interactive (Ink) flow: it awaits
 * between lock retries so a contended lock never freezes timers, the UI, or
 * SIGINT while it waits.
 */
async function withStateLockAsync<T>(
  operation: () => T,
  target: string = statePath(),
): Promise<T> {
  ensureOwnerOnlyDir(target)
  const startedAt = Date.now()
  const deadline = startedAt + LOCK_TIMEOUT_ASYNC_MS
  let release: (() => void) | undefined
  let retries = 0
  let lastCode: string | undefined
  const seenCodes = new Set<string>()
  while (!release) {
    try {
      release = lockfile.lockSync(target, lockOptions(target))
    } catch (error) {
      lastCode = classifyLockError(error, seenCodes, target)
      retries += 1
      if (Date.now() >= deadline) throw lockTimeoutError(lastCode, retries)
      await delayForLock()
    }
  }
  logContendedAcquire(retries, startedAt, lastCode)
  try {
    return operation()
  } finally {
    try {
      release()
    } catch {
      // Already released, or the lock was compromised and re-acquired by another
      // owner; proper-lockfile will not delete a lock that is no longer ours.
    }
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function matchesIntent(
  state: AimlapiPersistedTopup,
  intent: AimlapiTopupIntent,
): boolean {
  // Compare email case/whitespace-insensitively so resuming with a
  // differently-cased email reuses the same payment session instead of minting a
  // duplicate one.
  return INTENT_KEYS.every(key =>
    key === 'email'
      ? normalizeEmail(String(state[key])) === normalizeEmail(String(intent[key]))
      : state[key] === intent[key],
  )
}

// Same freshness rule as acquire{Exchange,KeyMint}LeaseOperation: an owner
// with no timestamp, or a future-dated one, cannot describe a live holder on
// this machine, so it counts as stale (not live) here too.
function isLeaseLive(
  owner: string | undefined,
  heldAt: number | undefined,
  staleMs: number,
): boolean {
  if (typeof owner !== 'string' || !owner) return false
  const now = Date.now()
  const ageMs = typeof heldAt === 'number' && heldAt <= now ? now - heldAt : Number.POSITIVE_INFINITY
  return ageMs < staleMs
}

// A live exchange or key-mint lease means a non-idempotent POST (/exchange or
// /v1/keys) may be in flight for THIS record right now. Replacing the record
// out from under that lease — even for a different, unrelated intent — would
// let the in-flight request's eventual CAS save find no matching record to
// land in, orphaning a newly minted/exchanged credential with no receipt to
// recover it. See claimTopupStateOperation.
function hasLiveMintOrExchangeLease(state: AimlapiPersistedTopup): boolean {
  return (
    isLeaseLive(state.exchangeLeaseOwner, state.exchangeLeaseAt, EXCHANGE_LEASE_STALE_MS) ||
    isLeaseLive(state.keyMintLeaseOwner, state.keyMintLeaseAt, KEY_MINT_LEASE_STALE_MS)
  )
}

/**
 * Shared shape check for a lease pair (exchangeLease{Owner,At} or
 * keyMintLease{Owner,At}): protects a non-idempotent mutation's in-flight
 * marker, so a malformed or one-sided pair (an owner with no timestamp, or
 * vice versa) must fail the WHOLE receipt closed rather than being silently
 * accepted and then read by isLeaseLive as merely "not currently live" —
 * that would let claimTopupStateOperation treat a receipt that could not be
 * trusted as safe to replace, or a peer treat it as safe to mint/exchange
 * into, exactly the outcome the fail-closed contract exists to prevent.
 */
function isValidLeasePair(owner: unknown, at: unknown): boolean {
  if (owner === undefined && at === undefined) return true
  return (
    typeof owner === 'string' &&
    Boolean(owner.trim()) &&
    typeof at === 'number' &&
    Number.isFinite(at)
  )
}

function isPersistedTopup(value: unknown): value is AimlapiPersistedTopup {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Record<string, unknown>
  return (
    typeof state.email === 'string' &&
    Boolean(state.email.trim()) &&
    typeof state.amountUsdMinor === 'number' &&
    Number.isSafeInteger(state.amountUsdMinor) &&
    state.amountUsdMinor >= 0 &&
    typeof state.autoTopUp === 'boolean' &&
    typeof state.partnerId === 'string' &&
    Boolean(state.partnerId.trim()) &&
    typeof state.partnerName === 'string' &&
    typeof state.appBaseUrl === 'string' &&
    Boolean(state.appBaseUrl.trim()) &&
    typeof state.inferenceBaseUrl === 'string' &&
    Boolean(state.inferenceBaseUrl.trim()) &&
    typeof state.payBaseUrl === 'string' &&
    Boolean(state.payBaseUrl.trim()) &&
    typeof state.verificationBaseUrl === 'string' &&
    Boolean(state.verificationBaseUrl.trim()) &&
    typeof state.paymentSessionId === 'string' &&
    Boolean(state.paymentSessionId.trim()) &&
    typeof state.resumeSessionToken === 'string' &&
    (state.apiKey === undefined ||
      (typeof state.apiKey === 'string' && Boolean(state.apiKey.trim()))) &&
    (state.apiKeyId === undefined ||
      (typeof state.apiKeyId === 'string' && Boolean(state.apiKeyId.trim()))) &&
    (state.model === undefined || typeof state.model === 'string') &&
    (state.settled === undefined || typeof state.settled === 'boolean') &&
    (state.exchange === undefined || typeof state.exchange === 'boolean') &&
    isValidLeasePair(state.exchangeLeaseOwner, state.exchangeLeaseAt) &&
    isValidLeasePair(state.keyMintLeaseOwner, state.keyMintLeaseAt)
  )
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'ENOENT'
  )
}

/**
 * Read+parse a JSON object file, matching readAimlapiTopupStateUnlocked's
 * fail-closed contract: only a genuinely missing file (ENOENT) means "no
 * record yet" (returns null). A file that exists but cannot be trusted — a
 * permission/I/O error, invalid JSON, or a top-level value that isn't even a
 * plausible object — is surfaced as a thrown error instead of silently
 * treated as empty. Used by the sign-in key cache and its mint lease: an
 * unreadable/corrupt file there must not be treated as "no cached key, no
 * live lease", since that would authorize a fresh non-idempotent createKey
 * call (or a fresh lease acquisition over a possibly-still-live one) on top
 * of a record this read simply failed to confirm.
 */
function readJsonObjectFile(path: string, label: string): Record<string, unknown> | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (isEnoentError(error)) return null
    throw new Error(
      `Could not read the local ${label} at ${path}. Resolve the underlying issue and ` +
        `retry, rather than proceeding as if it were empty.`,
      { cause: error },
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `The local ${label} at ${path} is not valid JSON. Remove or repair it manually ` +
        `before retrying.`,
      { cause: error },
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`The local ${label} at ${path} does not match the expected format.`)
  }
  return parsed as Record<string, unknown>
}

/**
 * Read the stored record. Only a genuinely missing file (ENOENT) means "no
 * state" — an empty slot claimTopupStateOperation may safely write a fresh
 * claim over. A file that exists but cannot be trusted — a permission/I/O
 * error, invalid JSON, or a record that fails validation (e.g. an
 * unrecognized schema/version) — is NOT the same as empty: silently treating
 * it as empty would let a claim overwrite a still-live pending or
 * already-paid receipt whose bytes just happened to be momentarily
 * unreadable. Surface those as a fail-closed error instead, and never touch
 * the original bytes while the failure is unresolved.
 */
function readAimlapiTopupStateUnlocked(): AimlapiPersistedTopup | null {
  const path = statePath()
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (isEnoentError(error)) return null
    throw new Error(
      `Could not read the local AI/ML API checkout receipt at ${path}. Resolve the ` +
        `underlying issue and retry, rather than starting a new checkout — it may still ` +
        `point at a pending or already-paid one.`,
      { cause: error },
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `The local AI/ML API checkout receipt at ${path} is not valid JSON. Remove or repair ` +
        `it manually before retrying — it may still point at a pending or already-paid checkout.`,
      { cause: error },
    )
  }
  if (!isPersistedTopup(parsed)) {
    throw new Error(
      `The local AI/ML API checkout receipt at ${path} does not match the expected format. ` +
        `Remove or repair it manually before retrying — it may still point at a pending or ` +
        `already-paid checkout.`,
    )
  }
  return parsed
}

/**
 * Write owner-only JSON atomically: a reader never observes a partial file, and
 * the temporary is removed even when the write or rename fails.
 */
function writeJsonAtomic(target: string, data: unknown): void {
  ensureOwnerOnlyDir(target)
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: FILE_MODE,
    })
    chmodSync(temporary, FILE_MODE)
    renameSync(temporary, target)
  } finally {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // Temp file already gone or unremovable; keep the original error.
    }
  }
}

function writeAimlapiTopupStateUnlocked(state: AimlapiPersistedTopup): void {
  writeJsonAtomic(statePath(), state)
}

function toCheckoutState(state: AimlapiPersistedTopup): AimlapiCheckoutState {
  return {
    paymentSessionId: state.paymentSessionId,
    resumeSessionToken: state.resumeSessionToken,
    apiKey: state.apiKey,
    apiKeyId: state.apiKeyId,
    model: state.model,
    settled: state.settled,
    exchange: state.exchange,
  }
}

/**
 * Stable, non-secret identity for a by-key checkout intent: a saved-profile
 * or env-sourced credential has no account email to key the intent on (the
 * top-up is against the key itself, not a passwordless account), so the
 * intent's `email` field carries this fingerprint instead. Shared by
 * ProviderManager's intent construction and reconcileSettledAimlapiTopupStateAsync
 * so both sides compute the identical value — a second, independently
 * maintained hash computation could silently drift (a different algorithm,
 * different trimming) and break the match either by never matching a real
 * receipt or, worse, by colliding across different keys.
 */
export function aimlapiByKeyIdentity(apiKey: string): string {
  return `key:${createHash('sha256').update(apiKey.trim()).digest('hex')}`
}

/**
 * Best-effort reconciliation for a settled receipt whose claiming intent this
 * process never saw (e.g. it was left behind by an earlier run that settled a
 * by-key top-up but never reached the profile write — see
 * claimTopupStateOperation's unconditional refusal to overwrite a
 * settled-but-unsaved receipt). Clears the record only when it is settled AND
 * already belongs to the SAME credential the caller is about to reuse as-is:
 * that is the one case where discarding it loses nothing — the credential's
 * funds are already reflected server-side (the caller just confirmed its
 * balance), and no new payment is being made here to record. Safe no-op
 * otherwise — mismatched, unpaid, or in-progress state is left untouched for
 * its actual owner to resolve.
 *
 * Matches on the intent's `email` field (see aimlapiByKeyIdentity), not on
 * the stored `apiKey`: an env-sourced credential's settled receipt never
 * stores `apiKey` in the first place (see saveTopupStateOperation's
 * aimlapiExistingUsesEnv branch — the ambient secret is deliberately never
 * written to disk), so a raw-value comparison could never match it and would
 * leave it stranded forever. Worse, matching on "settled with no stored key"
 * alone — the only other signal a keyless receipt offers — cannot tell TWO
 * different env credentials' keyless receipts apart, and would let checking
 * credential B's balance delete credential A's still-unrecovered receipt.
 * The identity fingerprint is present and stable for a by-key receipt
 * regardless of whether its key ended up stored, so it works for both.
 */
export function reconcileSettledAimlapiTopupStateAsync(apiKey: string): Promise<void> {
  const trimmedApiKey = apiKey.trim()
  if (!trimmedApiKey) return Promise.resolve()
  const identity = aimlapiByKeyIdentity(trimmedApiKey)
  return withStateLockAsync(() => {
    const current = readAimlapiTopupStateUnlocked()
    if (!current?.settled || current.email !== identity) return
    rmSync(statePath(), { force: true })
  })
}

/**
 * The stored record, but only while it still belongs to the caller's intent and
 * payment session. This is the compare-and-swap precondition shared by save,
 * reset and clear.
 */
function matchingStateOrNull(
  expected: AimlapiTopupIntent & Pick<AimlapiPersistedTopup, 'paymentSessionId'>,
): AimlapiPersistedTopup | null {
  const current = readAimlapiTopupStateUnlocked()
  if (
    !current ||
    !matchesIntent(current, expected) ||
    current.paymentSessionId !== expected.paymentSessionId
  ) {
    return null
  }
  return current
}

export function loadAimlapiTopupState(
  intent: AimlapiTopupIntent,
): AimlapiCheckoutState | null {
  const state = readAimlapiTopupStateUnlocked()
  if (!state || !matchesIntent(state, intent)) return null
  return toCheckoutState(state)
}

/**
 * Compare-and-swap: the write only lands while the stored record still belongs
 * to this intent and payment session. Retained key fields (`apiKey`, `apiKeyId`,
 * `model`, `settled`) are MERGED, not replaced, so omitting them preserves what
 * is already stored rather than wiping an already-issued credential.
 *
 * `resumeSessionToken` and `apiKey`/`apiKeyId` are elected FIRST-WRITER-WINS,
 * not last-writer-wins: two concurrent runs for the same intent can each mint
 * their own key or create their own checkout session before either one's save
 * lands. Whichever save lands first must stick — a later save from a losing
 * peer must adopt (not overwrite) the already-recorded value, or the "elected"
 * credential/session becomes whichever process happened to save last, and the
 * loser's own mint/session becomes an orphaned, unreferenced duplicate.
 */
export function saveAimlapiTopupState(state: AimlapiPersistedTopup): void {
  withStateLock(() => saveTopupStateOperation(state))
}

/**
 * Non-blocking counterpart for the interactive flow, which must never risk
 * freezing Ink's render loop, Esc, or SIGINT on lock contention (the sync
 * lock's `Atomics.wait` retry blocks the whole event loop for up to
 * `LOCK_TIMEOUT_MS`). See `saveAimlapiTopupState`.
 */
export function saveAimlapiTopupStateAsync(state: AimlapiPersistedTopup): Promise<void> {
  return withStateLockAsync(() => saveTopupStateOperation(state))
}

function saveTopupStateOperation(state: AimlapiPersistedTopup): void {
  const current = matchingStateOrNull(state)
  if (!current) return
  // apiKey/apiKeyId travel as a pair: once a key is elected, its id (which
  // may itself legitimately be an empty "not applicable" sentinel) must come
  // from the SAME winner, never mixed with a losing caller's id.
  const existingApiKeyWins = Boolean(current.apiKey?.trim())
  writeAimlapiTopupStateUnlocked({
    ...state,
    resumeSessionToken: current.resumeSessionToken?.trim() || state.resumeSessionToken,
    // An empty key id/key is a "not applicable" sentinel (e.g. the existing-key
    // top-up path), NOT a value to persist: the reader rejects empty strings, so
    // a serialized "" would make the whole receipt unreadable and lose an
    // otherwise-recoverable checkout. Coerce it to absent instead. Never fall
    // back to current.apiKeyId here: current.apiKey is already known falsy in
    // this branch, so that id (if somehow present) belongs to no key of ours,
    // and pairing it with a genuinely new state.apiKey would tag it with the
    // wrong id.
    apiKey: existingApiKeyWins ? current.apiKey : state.apiKey?.trim() || undefined,
    apiKeyId: existingApiKeyWins
      ? current.apiKeyId
      : state.apiKey?.trim()
        ? state.apiKeyId?.trim() || undefined
        : undefined,
    model: state.model ?? current.model,
    settled: state.settled ?? current.settled,
    exchange: state.exchange ?? current.exchange,
    exchangeLeaseOwner: state.exchangeLeaseOwner ?? current.exchangeLeaseOwner,
    exchangeLeaseAt: state.exchangeLeaseAt ?? current.exchangeLeaseAt,
    // AimlapiCheckoutState (what callers spread `checkoutState` from) carries
    // neither lease pair, so an unrelated save (e.g. persisting the exchange
    // flag) must not silently drop an in-flight peer's key-mint lease — that
    // would let a THIRD process see the lease as absent and mint a second key.
    // This generic save has no owner to check before clearing it, so it never
    // does — see recordAimlapiMintedKeyAsync for the owner-checked retirement
    // a successful mint actually needs.
    keyMintLeaseOwner: state.keyMintLeaseOwner ?? current.keyMintLeaseOwner,
    keyMintLeaseAt: state.keyMintLeaseAt ?? current.keyMintLeaseAt,
  })
}

/**
 * Thrown by recordAimlapiMintedKeyAsync when this call's result cannot be
 * trusted as authoritative: the checkout was cleared/reset (no matching
 * record), or the key-mint lease moved to a different owner before this
 * call landed and no key is recorded yet to adopt instead. See
 * recordAimlapiMintedKeyAsync for why writing anyway would be unsafe.
 */
export class AimlapiKeyMintOwnershipLostError extends Error {}

/**
 * Record a freshly minted existing-account key under the same CAS, and —
 * only while the key-mint lease is still held by THIS call's `owner` —
 * retire it in the same update. Returns the credential now durably on
 * record, which is NOT always this call's own: if a peer already recorded
 * one first, that peer's key is returned instead (first-writer-wins, same
 * as saveAimlapiTopupState) so the caller never reports having saved a key
 * that was actually discarded.
 *
 * createKey (unlike the sign-in/exchange leases) is never refreshed while
 * the caller waits on it, so a slow response can let the lease go stale and
 * be reclaimed by a peer before this save lands. If no key is recorded yet
 * AND the lease has moved to a different owner, this call's own result is
 * REJECTED (throws AimlapiKeyMintOwnershipLostError) rather than written:
 * the new owner's mint may still be genuinely in flight, and writing this
 * (superseded) result now would let that owner's later, equally
 * first-writer-wins save silently discard ITS OWN just-minted key once it
 * lands — turning one lost credential into two. The caller should surface
 * this as a fail-closed recovery error (the key this call minted still
 * exists server-side) rather than retry blindly.
 */
export function recordAimlapiMintedKeyAsync(
  expected: AimlapiTopupIntent & Pick<AimlapiPersistedTopup, 'paymentSessionId'>,
  key: { apiKey: string; apiKeyId?: string },
  owner: string,
): Promise<{ apiKey: string; apiKeyId?: string }> {
  return withStateLockAsync(() => {
    const current = matchingStateOrNull(expected)
    if (!current) {
      throw new AimlapiKeyMintOwnershipLostError(
        'The checkout for this key mint no longer exists (cleared, reset, or claimed anew).',
      )
    }
    if (current.apiKey?.trim()) {
      // Someone already recorded a key for this checkout — adopt it rather
      // than attempt to overwrite it; first writer wins regardless of who
      // currently holds (or held) the lease.
      return { apiKey: current.apiKey, apiKeyId: current.apiKeyId }
    }
    const leaseOwner = current.keyMintLeaseOwner
    if (leaseOwner !== undefined && leaseOwner !== owner) {
      throw new AimlapiKeyMintOwnershipLostError(
        'The key-mint lease was reclaimed by another process before this result could be ' +
          'committed; its own mint may still be in flight.',
      )
    }
    const trimmedApiKey = key.apiKey.trim() || undefined
    const trimmedApiKeyId = trimmedApiKey ? key.apiKeyId?.trim() || undefined : undefined
    writeAimlapiTopupStateUnlocked({
      ...current,
      resumeSessionToken: current.resumeSessionToken?.trim() || '',
      apiKey: trimmedApiKey,
      apiKeyId: trimmedApiKeyId,
      keyMintLeaseOwner: undefined,
      keyMintLeaseAt: undefined,
    })
    return { apiKey: trimmedApiKey ?? '', apiKeyId: trimmedApiKeyId }
  })
}

/**
 * Record a completed one-shot key exchange (apiKey/apiKeyId + settled) under the
 * same async lock/CAS, MERGING over the stored record so the resume token and
 * intent survive. The exchange-lease winner calls this BEFORE it returns the key,
 * so a crash after the non-idempotent /exchange can still recover the paid key
 * from the receipt instead of re-running (and being rejected by) the spent
 * exchange. Clears the lease — a settled receipt supersedes it.
 *
 * Returns whether the receipt was actually written. Both no-op cases — the slot
 * no longer belongs to this intent + payment id (a reset/clear happened), or no
 * credential could be resolved to settle with — return false rather than
 * throwing, since neither is an I/O failure. Callers that treat this as the
 * only durable record of the exchange (see exchangeKeyWithLease) must treat a
 * `false` return exactly like a thrown error: nothing was committed.
 */
export function recordAimlapiSettledKeyAsync(
  expected: AimlapiTopupIntent & Pick<AimlapiPersistedTopup, 'paymentSessionId'>,
  key: { apiKey: string; apiKeyId?: string; model?: string },
): Promise<boolean> {
  return withStateLockAsync(() => {
    const current = matchingStateOrNull(expected)
    if (!current) return false
    const apiKey = key.apiKey.trim() || current.apiKey?.trim()
    // Never settle without a credential: marking the receipt settled and clearing
    // the lease with no key would make a peer resume from a receipt that holds
    // nothing while the one-shot /exchange is already spent. Leave the record
    // (and its lease) untouched so a retry can still exchange.
    if (!apiKey) return false
    writeAimlapiTopupStateUnlocked({
      ...current,
      apiKey,
      apiKeyId: key.apiKeyId?.trim() || current.apiKeyId,
      model: key.model?.trim() || current.model,
      settled: true,
      exchangeLeaseOwner: undefined,
      exchangeLeaseAt: undefined,
    })
    return true
  })
}

/**
 * Atomic session election. Concurrent runs of the same intent + payment id
 * settle on a SINGLE payable checkout: the first writer wins, and a loser gets
 * the winner's token back so it can resume that session and abandon the one it
 * just opened instead of leaving two chargeable checkouts. Retained key fields
 * are merged (as in `saveAimlapiTopupState`). Returns the winning checkout state,
 * or null when the slot no longer belongs to this intent + payment id (a
 * reset/clear happened meanwhile).
 */
export function recordAimlapiCheckoutSession(
  state: AimlapiPersistedTopup,
): AimlapiCheckoutState | null {
  return withStateLock(() => recordCheckoutSessionOperation(state))
}

/**
 * Non-blocking counterpart for the interactive flow, which must never risk
 * freezing Ink's render loop, Esc, or SIGINT on lock contention (the sync
 * lock's `Atomics.wait` retry blocks the whole event loop for up to
 * `LOCK_TIMEOUT_MS`). See `recordAimlapiCheckoutSession`.
 */
export function recordAimlapiCheckoutSessionAsync(
  state: AimlapiPersistedTopup,
): Promise<AimlapiCheckoutState | null> {
  return withStateLockAsync(() => recordCheckoutSessionOperation(state))
}

function recordCheckoutSessionOperation(state: AimlapiPersistedTopup): AimlapiCheckoutState | null {
  const current = matchingStateOrNull(state)
  if (!current) return null
  // A peer already recorded a session for this payment id: keep theirs so the
  // loser adopts the winning token instead of overwriting it.
  if (current.resumeSessionToken?.trim()) {
    return toCheckoutState(current)
  }
  const recorded: AimlapiPersistedTopup = {
    ...state,
    apiKey: state.apiKey ?? current.apiKey,
    apiKeyId: state.apiKeyId ?? current.apiKeyId,
    model: state.model ?? current.model,
    settled: state.settled ?? current.settled,
    exchange: state.exchange ?? current.exchange,
    exchangeLeaseOwner: state.exchangeLeaseOwner ?? current.exchangeLeaseOwner,
    exchangeLeaseAt: state.exchangeLeaseAt ?? current.exchangeLeaseAt,
    // See saveTopupStateOperation: must not drop an in-flight key-mint lease.
    keyMintLeaseOwner: state.keyMintLeaseOwner ?? current.keyMintLeaseOwner,
    keyMintLeaseAt: state.keyMintLeaseAt ?? current.keyMintLeaseAt,
  }
  writeAimlapiTopupStateUnlocked(recorded)
  return toCheckoutState(recorded)
}

/**
 * Adopt the stored checkout for this intent, or start a new one. This is a single
 * slot, so claiming a DIFFERENT intent would replace the stored record. That is
 * safe for a never-advanced claim, but it must NOT silently drop a checkout that
 * still holds recoverable value — an opened session (a resume token, which may
 * already be PAID but not yet exchanged) or a settled key not yet written to a
 * profile. Dropping the resume token there strands a paid session/key that is
 * only reachable through this record, so a changed intent is refused until the
 * caller finishes or cancels the retained checkout (re-running the SAME intent
 * resumes it). The identity includes amount/partner/endpoints, so a changed
 * intent is genuinely a different checkout.
 *
 * `abandonExisting` overrides that refusal for a caller that has already gotten
 * an explicit, out-of-band user confirmation to abandon the retained checkout
 * (e.g. a re-edited amount the user chose to submit anyway). The overwrite still
 * happens under this same lock acquisition, so the caller never observes a
 * window where the slot is cleared but not yet re-claimed.
 */
export function claimAimlapiTopupState(
  intent: AimlapiTopupIntent,
  options: { abandonExisting?: boolean } = {},
): AimlapiCheckoutState {
  return withStateLock(() => claimTopupStateOperation(intent, options))
}

/**
 * Non-blocking counterpart for the interactive flow, which must never risk
 * freezing Ink's render loop, Esc, or SIGINT on lock contention (the sync
 * lock's `Atomics.wait` retry blocks the whole event loop for up to
 * `LOCK_TIMEOUT_MS`). See `claimAimlapiTopupState`.
 */
export function claimAimlapiTopupStateAsync(
  intent: AimlapiTopupIntent,
  options: { abandonExisting?: boolean } = {},
): Promise<AimlapiCheckoutState> {
  return withStateLockAsync(() => claimTopupStateOperation(intent, options))
}

function claimTopupStateOperation(
  intent: AimlapiTopupIntent,
  options: { abandonExisting?: boolean },
): AimlapiCheckoutState {
  const existing = readAimlapiTopupStateUnlocked()
  if (existing && matchesIntent(existing, intent)) {
    return toCheckoutState(existing)
  }
  if (existing && existing.settled === true && existing.apiKey?.trim()) {
    // abandonExisting confirms giving up an UNPAID checkout (the amount-edit
    // "do NOT pay it" gate) — never an already paid + exchanged credential
    // just waiting on its profile write. Refuse unconditionally, so a rare
    // race (a peer settled this exact payment id while the caller was
    // confirming abandonment of what it still saw as unpaid) can't silently
    // discard a paid credential; the caller must go through the normal
    // settled-receipt recovery path instead.
    const priorUsd = (existing.amountUsdMinor / 100).toFixed(2)
    throw new Error(
      `An earlier AI/ML API top-up of $${priorUsd} already succeeded and is waiting to ` +
        `be saved. Re-run that same top-up to finish saving it before starting a ` +
        `different one.`,
    )
  }
  if (existing && hasLiveMintOrExchangeLease(existing)) {
    // A record with no resumeSessionToken/settled/apiKey yet still isn't safe
    // to replace while a lease on it is live: mintExistingAccountKeyWithLease
    // and exchangeKeyWithLease claim the receipt BEFORE sending their
    // non-idempotent POST, so a blank-looking record can still have a request
    // in flight whose eventual CAS save expects this exact record to still be
    // here. Refuse unconditionally (even under abandonExisting) — the request
    // already sent cannot be recalled, so the only safe move is to wait for
    // the lease to settle or go stale, never to overwrite it out from under
    // that in-flight request.
    const priorUsd = (existing.amountUsdMinor / 100).toFixed(2)
    throw new Error(
      `An earlier AI/ML API top-up of $${priorUsd} is minting or exchanging a key right ` +
        `now. Re-run that same top-up in a moment once it finishes before starting a ` +
        `different one.`,
    )
  }
  if (
    !options.abandonExisting &&
    existing &&
    (Boolean(existing.resumeSessionToken?.trim()) ||
      existing.settled === true ||
      Boolean(existing.apiKey?.trim()))
  ) {
    const priorUsd = (existing.amountUsdMinor / 100).toFixed(2)
    throw new Error(
      `An earlier AI/ML API top-up of $${priorUsd} hasn't finished and may already be ` +
        `paid. Re-run that same top-up to complete it (or cancel it) before starting a ` +
        `different one.`,
    )
  }
  const claimed: AimlapiCheckoutState = {
    paymentSessionId: randomUUID(),
    resumeSessionToken: '',
    // A settled credential is already refused above regardless of
    // abandonExisting, so anything reaching here is (at worst) a minted but
    // not-yet-paid existing-account key — still worth keeping, matching
    // resetAimlapiCheckoutSession's retain-key pattern. Deliberately
    // excludes `settled`/`exchange`: those describe the OLD payment
    // intent's outcome, not this new one's. `email` doubles as the account/
    // key identity (a `key:<hash>` id for the by-key flow), so it must match
    // too — abandonExisting also covers "switch account", where the retained
    // key belongs to a DIFFERENT identity and carrying it into the new claim
    // would let a later resume pay account A but save A's key into B's
    // receipt.
    ...(options.abandonExisting && existing?.apiKey?.trim() && existing.email === intent.email
      ? { apiKey: existing.apiKey, apiKeyId: existing.apiKeyId, model: existing.model }
      : {}),
  }
  writeAimlapiTopupStateUnlocked({ ...intent, ...claimed })
  return claimed
}

function resetCheckoutSessionOperation(
  expected: AimlapiTopupIntent & Pick<AimlapiPersistedTopup, 'paymentSessionId'>,
): AimlapiCheckoutState | null {
  const current = matchingStateOrNull(expected)
  if (!current || !current.apiKey?.trim()) return null
  const next: AimlapiPersistedTopup = {
    ...current,
    paymentSessionId: randomUUID(),
    resumeSessionToken: '',
  }
  writeAimlapiTopupStateUnlocked(next)
  return toCheckoutState(next)
}

/**
 * A terminal checkout (cancelled/expired/failed, or a dead session) invalidates
 * the payment session but not an already-issued existing-account key. Drop the
 * dead session/payment identifiers and mint a fresh payment session while
 * retaining the key, so the next run reuses the credential instead of minting
 * another. Returns the refreshed checkout, or null when no matching keyed state
 * exists (callers clear the state instead).
 */
export function resetAimlapiCheckoutSession(
  expected: AimlapiTopupIntent & Pick<AimlapiPersistedTopup, 'paymentSessionId'>,
): AimlapiCheckoutState | null {
  return withStateLock(() => resetCheckoutSessionOperation(expected))
}

/**
 * Non-blocking counterpart for the interactive flow's onSession callback,
 * which runs off a synchronous-signature hook (`onSession?: (token: string) =>
 * string | void`) and must never risk freezing the UI on lock contention. See
 * `resetAimlapiCheckoutSession`.
 */
export function resetAimlapiCheckoutSessionAsync(
  expected: AimlapiTopupIntent & Pick<AimlapiPersistedTopup, 'paymentSessionId'>,
): Promise<AimlapiCheckoutState | null> {
  return withStateLockAsync(() => resetCheckoutSessionOperation(expected))
}

export function clearAimlapiTopupState(
  expected: AimlapiTopupIntent & Pick<AimlapiPersistedTopup, 'paymentSessionId'>,
): void {
  withStateLock(() => {
    if (matchingStateOrNull(expected)) {
      rmSync(statePath(), { force: true })
    }
  })
}

/**
 * Non-blocking clear for the interactive flow. Runs in a synchronous Ink save
 * callback where the sync lock would freeze the UI on contention, so it awaits
 * the lock instead. Callers treat it as best-effort (the receipt is a resume aid).
 */
export function clearAimlapiTopupStateAsync(
  expected: AimlapiTopupIntent & Pick<AimlapiPersistedTopup, 'paymentSessionId'>,
): Promise<void> {
  return withStateLockAsync(() => {
    if (matchingStateOrNull(expected)) {
      rmSync(statePath(), { force: true })
    }
  })
}

/**
 * Outcome of an exchange-lease acquisition (see `exchangeLeaseOwner`):
 * - `acquired`: the caller holds the lease and is the sole process cleared to
 *   run the one-shot key exchange.
 * - `settled`: a peer already exchanged and recorded the key — resume from it.
 * - `held`: a live peer holds a fresh lease and is exchanging — wait for its
 *   settled receipt rather than exchanging in parallel.
 * - `gone`: the checkout for this intent + payment id was cleared/reset meanwhile.
 */
export type AimlapiExchangeLease =
  | { status: 'acquired'; state: AimlapiCheckoutState }
  | { status: 'settled'; state: AimlapiCheckoutState }
  | { status: 'held'; owner: string; ageMs: number }
  | { status: 'gone' }

function acquireExchangeLeaseOperation(
  expected: AimlapiTopupIntent & Pick<AimlapiPersistedTopup, 'paymentSessionId'>,
  owner: string,
): AimlapiExchangeLease {
  const current = matchingStateOrNull(expected)
  if (!current) return { status: 'gone' }
  // A peer already completed the one-shot exchange and recorded the key.
  if (current.settled && current.apiKey?.trim()) {
    return { status: 'settled', state: toCheckoutState(current) }
  }
  const now = Date.now()
  const leaseOwner = current.exchangeLeaseOwner
  const heldAt = current.exchangeLeaseAt
  // A lease timestamped in the FUTURE cannot describe a live holder on this
  // machine (all processes share the wall clock), so it comes from a backwards
  // clock jump or a hand-edited state file. Treat it — like a non-numeric value —
  // as an expired lease to reclaim, not a fresh one: a negative age would read as
  // perpetually fresh and clamping it to 0 would still pin the slot until real
  // time crawled up to the bogus timestamp (hours, or years). Reclaiming is safe:
  // a genuinely live holder's parallel /exchange is caught server-side.
  const ageMs =
    typeof heldAt === 'number' && heldAt <= now ? now - heldAt : Number.POSITIVE_INFINITY
  // A fresh lease held by another process: it is exchanging right now, so back
  // off. A stale lease (crashed holder) or our own is reclaimed below.
  if (
    typeof leaseOwner === 'string' &&
    leaseOwner !== owner &&
    ageMs < EXCHANGE_LEASE_STALE_MS
  ) {
    return { status: 'held', owner: leaseOwner, ageMs }
  }
  // No fresh foreign lease (absent, already ours, or stale): claim it. Writing
  // under the state lock is the compare-and-swap that elects a single exchanger.
  writeAimlapiTopupStateUnlocked({
    ...current,
    exchangeLeaseOwner: owner,
    exchangeLeaseAt: now,
  })
  return { status: 'acquired', state: toCheckoutState(current) }
}

/**
 * Elect a single process to perform the non-idempotent key exchange for a
 * checkout, serializing racing same-intent processes onto one exchange. See
 * `AimlapiExchangeLease`. Async so it never blocks the Ink event loop.
 */
export function acquireAimlapiExchangeLeaseAsync(
  expected: AimlapiTopupIntent & Pick<AimlapiPersistedTopup, 'paymentSessionId'>,
  owner: string,
): Promise<AimlapiExchangeLease> {
  return withStateLockAsync(() => acquireExchangeLeaseOperation(expected, owner))
}

function releaseExchangeLeaseOperation(
  expected: AimlapiTopupIntent & Pick<AimlapiPersistedTopup, 'paymentSessionId'>,
  owner: string,
): void {
  const current = matchingStateOrNull(expected)
  // Only clear a lease we still own and that a settled receipt has not already
  // superseded — never one a peer re-claimed after ours went stale.
  if (!current || current.exchangeLeaseOwner !== owner || current.settled) return
  writeAimlapiTopupStateUnlocked({
    ...current,
    exchangeLeaseOwner: undefined,
    exchangeLeaseAt: undefined,
  })
}

/**
 * Release the exchange lease after a FAILED exchange (the key was not minted, or
 * the outcome is unknown) so a retry proceeds promptly instead of waiting out the
 * stale window. Best-effort and ownership-aware. Never called on success — the
 * settled receipt supersedes the lease there.
 */
export function releaseAimlapiExchangeLeaseAsync(
  expected: AimlapiTopupIntent & Pick<AimlapiPersistedTopup, 'paymentSessionId'>,
  owner: string,
): Promise<void> {
  return withStateLockAsync(() => releaseExchangeLeaseOperation(expected, owner))
}

function refreshExchangeLeaseOperation(
  expected: AimlapiTopupIntent & Pick<AimlapiPersistedTopup, 'paymentSessionId'>,
  owner: string,
): boolean {
  const current = matchingStateOrNull(expected)
  if (!current || current.exchangeLeaseOwner !== owner) return false
  writeAimlapiTopupStateUnlocked({ ...current, exchangeLeaseAt: Date.now() })
  return true
}

/**
 * Touch the exchange lease's timestamp while its holder is still working. The
 * lease is acquired once and `EXCHANGE_LEASE_STALE_MS` (75s) is sized for a
 * single non-idempotent POST, but a resumed `wait-exchange` holder can sit in a
 * read-only poll for up to `POLL_TIMEOUT_MS` (20 minutes) before ever reaching
 * that POST — without refreshing, a peer would see the lease go stale mid-wait,
 * reclaim it, and risk a second concurrent /exchange on the same one-shot
 * session. Returns false once the lease is no longer ours (reclaimed, cleared,
 * or superseded by a settled receipt), so the caller can stop refreshing.
 */
export function refreshAimlapiExchangeLeaseAsync(
  expected: AimlapiTopupIntent & Pick<AimlapiPersistedTopup, 'paymentSessionId'>,
  owner: string,
): Promise<boolean> {
  return withStateLockAsync(() => refreshExchangeLeaseOperation(expected, owner))
}

/**
 * Outcome of a key-mint lease acquisition (see `keyMintLeaseOwner`):
 * - `acquired`: the caller holds the lease and is the sole process cleared to
 *   POST /v1/keys.
 * - `minted`: a peer already minted and recorded a key — resume from it.
 * - `held`: a live peer holds a fresh lease and is minting — wait for its
 *   result rather than minting in parallel.
 * - `gone`: the checkout for this intent + payment id was cleared/reset meanwhile.
 */
export type AimlapiKeyMintLease =
  | { status: 'acquired'; state: AimlapiCheckoutState }
  | { status: 'minted'; state: AimlapiCheckoutState }
  | { status: 'held'; owner: string; ageMs: number }
  | { status: 'gone' }

function acquireKeyMintLeaseOperation(
  expected: AimlapiTopupIntent & Pick<AimlapiPersistedTopup, 'paymentSessionId'>,
  owner: string,
): AimlapiKeyMintLease {
  const current = matchingStateOrNull(expected)
  if (!current) return { status: 'gone' }
  // A peer already minted a key for this intent.
  if (current.apiKey?.trim()) {
    return { status: 'minted', state: toCheckoutState(current) }
  }
  const now = Date.now()
  const leaseOwner = current.keyMintLeaseOwner
  const heldAt = current.keyMintLeaseAt
  // See acquireExchangeLeaseOperation: a future-dated lease cannot describe a
  // live holder on this machine, so treat it as stale and reclaimable too.
  const ageMs =
    typeof heldAt === 'number' && heldAt <= now ? now - heldAt : Number.POSITIVE_INFINITY
  if (
    typeof leaseOwner === 'string' &&
    leaseOwner !== owner &&
    ageMs < KEY_MINT_LEASE_STALE_MS
  ) {
    return { status: 'held', owner: leaseOwner, ageMs }
  }
  writeAimlapiTopupStateUnlocked({
    ...current,
    keyMintLeaseOwner: owner,
    keyMintLeaseAt: now,
  })
  return { status: 'acquired', state: toCheckoutState(current) }
}

/**
 * Elect a single process to mint the existing-account key for a checkout,
 * serializing racing same-intent processes onto one POST /v1/keys instead of
 * each minting (and orphaning) their own credential. See `AimlapiKeyMintLease`.
 * Async so it never blocks the Ink event loop.
 */
export function acquireAimlapiKeyMintLeaseAsync(
  expected: AimlapiTopupIntent & Pick<AimlapiPersistedTopup, 'paymentSessionId'>,
  owner: string,
): Promise<AimlapiKeyMintLease> {
  return withStateLockAsync(() => acquireKeyMintLeaseOperation(expected, owner))
}

/**
 * Release the key-mint lease after a failed (or unknown-outcome) mint attempt
 * so a retry proceeds promptly instead of waiting out the stale window.
 * Best-effort and ownership-aware. Never called on success — the recorded key
 * supersedes the lease there.
 */
export function releaseAimlapiKeyMintLeaseAsync(
  expected: AimlapiTopupIntent & Pick<AimlapiPersistedTopup, 'paymentSessionId'>,
  owner: string,
): Promise<void> {
  return withStateLockAsync(() => {
    const current = matchingStateOrNull(expected)
    if (!current || current.keyMintLeaseOwner !== owner || current.apiKey?.trim()) return
    writeAimlapiTopupStateUnlocked({
      ...current,
      keyMintLeaseOwner: undefined,
      keyMintLeaseAt: undefined,
    })
  })
}

// --- Sign-in key cache ------------------------------------------------------
// The guided provider-manager mints an existing-account key at code sign-in,
// before the top-up amount (and therefore the full checkout intent) is known.
// This lightweight per-email cache retains that key so a restart before/without
// completing the checkout reuses it instead of minting another one.

type AimlapiSignInKeyEntry = { apiKey: string; apiKeyId: string }
// Email-keyed collection so concurrent/interrupted sign-ins for different
// accounts never overwrite each other's recovery key.
type AimlapiSignInKeyStore = Record<string, AimlapiSignInKeyEntry>

function signInKeyPath(): string {
  return join(getClaudeConfigHomeDir(), 'aimlapi-signin-key.json')
}

// A cached receipt is only useful if it can bypass createKey, which needs both
// the key and its identifier; treat an entry missing either as absent so the
// flow mints a fresh, complete credential rather than propagating an empty id.
function isSignInKeyEntry(value: unknown): value is AimlapiSignInKeyEntry {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.apiKey === 'string' &&
    Boolean(record.apiKey.trim()) &&
    typeof record.apiKeyId === 'string' &&
    Boolean(record.apiKeyId.trim())
  )
}

function readSignInKeyStoreUnlocked(): AimlapiSignInKeyStore {
  const record = readJsonObjectFile(signInKeyPath(), 'AI/ML API sign-in key cache')
  if (!record) return {}
  // Migrate a pre-collection single-record file `{ email, apiKey, apiKeyId }`.
  const legacyEmail = record.email
  if (typeof legacyEmail === 'string' && isSignInKeyEntry(record)) {
    return {
      [normalizeEmail(legacyEmail)]: {
        apiKey: record.apiKey,
        apiKeyId: record.apiKeyId,
      },
    }
  }
  const store: AimlapiSignInKeyStore = {}
  for (const [email, entry] of Object.entries(record)) {
    if (email && isSignInKeyEntry(entry)) {
      store[normalizeEmail(email)] = { apiKey: entry.apiKey, apiKeyId: entry.apiKeyId }
    }
  }
  return store
}

export function loadAimlapiSignInKey(
  email: string,
): { apiKey: string; apiKeyId: string } | null {
  const entry = readSignInKeyStoreUnlocked()[normalizeEmail(email)]
  return entry ? { apiKey: entry.apiKey, apiKeyId: entry.apiKeyId } : null
}

// First-writer-wins, like saveAimlapiTopupState's key election: two concurrent
// sign-ins for the same email can each mint their own key before either save
// lands (the read-then-mint check above this call is not atomic with it).
// Keeping whichever key was recorded first — instead of last-writer-wins —
// means every caller converges on the SAME credential instead of the loser
// silently overwriting the winner's cached key with its own orphaned one.
function saveSignInKeyOperation(
  normalizedEmail: string,
  apiKey: string,
  apiKeyId: string,
): void {
  const store = readSignInKeyStoreUnlocked()
  if (!store[normalizedEmail]) store[normalizedEmail] = { apiKey, apiKeyId }
  writeJsonAtomic(signInKeyPath(), store)
}

export function saveAimlapiSignInKey(
  email: string,
  apiKey: string,
  apiKeyId: string,
): void {
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail || !apiKey.trim() || !apiKeyId.trim()) return
  withStateLock(
    () => saveSignInKeyOperation(normalizedEmail, apiKey, apiKeyId),
    signInKeyPath(),
  )
}

/**
 * Non-blocking counterpart for the interactive (Ink) flow: it awaits between
 * lock retries so a contended lock never freezes timers, the UI, or SIGINT
 * while it waits. See `saveAimlapiSignInKey`.
 */
export function saveAimlapiSignInKeyAsync(
  email: string,
  apiKey: string,
  apiKeyId: string,
): Promise<void> {
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail || !apiKey.trim() || !apiKeyId.trim()) return Promise.resolve()
  return withStateLockAsync(
    () => saveSignInKeyOperation(normalizedEmail, apiKey, apiKeyId),
    signInKeyPath(),
  )
}

/**
 * Commit a freshly minted sign-in key to the cache AND retire the mint lease
 * that authorized minting it, under the same lock acquisition (both are
 * already locked on signInKeyPath() — see the sign-in key-mint lease comment
 * below). Completion was previously represented only indirectly, via the
 * cache entry masking the lease on lookup (acquireSignInKeyLeaseOperation
 * checks the cache first) — but the lease itself was never cleared, so it
 * resurfaces as live and blocks a fresh acquire for up to
 * SIGN_IN_KEY_LEASE_STALE_MS as soon as something later clears just the
 * cache entry (see clearSignInKeyOperation), even though no mint is running.
 * The lease is retired only while it still belongs to `owner`, so a stale
 * writer (one whose lease already went stale and was reclaimed by a newer
 * owner) can never clear that newer owner's live lease. If the cache write
 * itself throws, the lease is left untouched — a failed commit must stay
 * indeterminate, not silently retire the lease for a key that was never
 * durably recorded.
 */
export function commitAimlapiSignInKeyAsync(
  email: string,
  apiKey: string,
  apiKeyId: string,
  owner: string,
): Promise<void> {
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail || !apiKey.trim() || !apiKeyId.trim()) return Promise.resolve()
  return withStateLockAsync(() => {
    saveSignInKeyOperation(normalizedEmail, apiKey, apiKeyId)
    const leaseStore = readSignInLeaseStoreUnlocked()
    if (leaseStore[normalizedEmail]?.owner === owner) {
      delete leaseStore[normalizedEmail]
      writeSignInLeaseStore(leaseStore)
    }
  }, signInKeyPath())
}

// Delete only this email's entry, and only when it still holds the key this flow
// cached, so a stale completion cannot remove a newer key another concurrent
// flow cached for the same account.
function clearSignInKeyOperation(normalizedEmail: string, apiKeyId: string): void {
  const target = signInKeyPath()
  const store = readSignInKeyStoreUnlocked()
  if (store[normalizedEmail]?.apiKeyId !== apiKeyId) return
  delete store[normalizedEmail]
  if (Object.keys(store).length === 0) {
    rmSync(target, { force: true })
  } else {
    writeJsonAtomic(target, store)
  }
}

export function clearAimlapiSignInKey(email: string, apiKeyId: string): void {
  const normalizedEmail = normalizeEmail(email)
  withStateLock(
    () => clearSignInKeyOperation(normalizedEmail, apiKeyId),
    signInKeyPath(),
  )
}

/**
 * Non-blocking counterpart for the interactive (Ink) flow: it awaits between
 * lock retries so a contended lock never freezes timers, the UI, or SIGINT
 * while it waits. See `clearAimlapiSignInKey`.
 */
export function clearAimlapiSignInKeyAsync(email: string, apiKeyId: string): Promise<void> {
  const normalizedEmail = normalizeEmail(email)
  return withStateLockAsync(
    () => clearSignInKeyOperation(normalizedEmail, apiKeyId),
    signInKeyPath(),
  )
}

// --- Sign-in key mint lease --------------------------------------------------
// Looking up the sign-in key cache and minting on a miss is not itself atomic:
// two concurrent processes for the same email can each observe an empty cache
// and both reach createKey (non-idempotent — every call mints a fresh
// credential) before either later saveAimlapiSignInKey call elects a first
// writer. That election only picks which mint gets CACHED; it does not stop
// the second mint from happening, so the loser still orphans a credential.
// This lease closes the gap by serializing the lookup-and-mint section itself:
// a loser waits on a live lease and adopts the winner's cached key instead of
// minting its own. Locked on the key-cache file's path (not a lease-only
// file) so acquiring the lease and saveAimlapiSignInKey's write are mutually
// exclusive, keeping the "check cache" read inside acquire consistent with
// the eventual write. Same acquire/reclaim shape as the checkout-time
// key-mint lease; see `KEY_MINT_LEASE_STALE_MS`.
//
// Unlike that lease, the holder's critical path here isn't just the single
// POST: mintOrAdoptSignInKey also refreshes the lease and then writes the
// cache before it's done, and each of those steps can itself wait out a lock.
// The full worst case is createKey's request timeout (60s) + the refresh's
// own async-lock wait (up to LOCK_TIMEOUT_ASYNC_MS, 15s) + the cache save's
// own async-lock wait (another 15s) — 90s back to back, with zero room left
// for scheduling or filesystem overhead if this were sized to exactly that.
// Generous margin on top keeps a legitimately still-working holder from
// losing the lease to a peer moments before its result is cached.
const SIGN_IN_KEY_LEASE_STALE_MS = 150_000

function signInLeasePath(): string {
  return join(getClaudeConfigHomeDir(), 'aimlapi-signin-lease.json')
}

type AimlapiSignInLeaseRecord = { owner: string; at: number }
type AimlapiSignInLeaseStore = Record<string, AimlapiSignInLeaseRecord>

function isSignInLeaseRecord(value: unknown): value is AimlapiSignInLeaseRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.owner === 'string' && Boolean(record.owner) && typeof record.at === 'number'
}

function readSignInLeaseStoreUnlocked(): AimlapiSignInLeaseStore {
  const record = readJsonObjectFile(signInLeasePath(), 'AI/ML API sign-in key-mint lease')
  if (!record) return {}
  const store: AimlapiSignInLeaseStore = {}
  for (const [email, entry] of Object.entries(record)) {
    if (email && isSignInLeaseRecord(entry)) store[normalizeEmail(email)] = entry
  }
  return store
}

function writeSignInLeaseStore(store: AimlapiSignInLeaseStore): void {
  const target = signInLeasePath()
  if (Object.keys(store).length === 0) {
    rmSync(target, { force: true })
  } else {
    writeJsonAtomic(target, store)
  }
}

/**
 * Status of a sign-in key-mint lease attempt:
 * - `acquired`: the caller holds the lease and is the sole process cleared to
 *   POST /v1/keys for this email.
 * - `cached`: a key is already recorded for this email (a peer's completed
 *   mint, or an earlier run) — adopt it instead of minting.
 * - `held`: a live peer holds a fresh lease and is minting — wait for its
 *   result rather than minting in parallel.
 */
export type AimlapiSignInKeyLease =
  | { status: 'acquired' }
  | { status: 'cached'; apiKey: string; apiKeyId: string }
  | { status: 'held'; owner: string; ageMs: number }

function acquireSignInKeyLeaseOperation(email: string, owner: string): AimlapiSignInKeyLease {
  const normalizedEmail = normalizeEmail(email)
  const cached = readSignInKeyStoreUnlocked()[normalizedEmail]
  if (cached) return { status: 'cached', apiKey: cached.apiKey, apiKeyId: cached.apiKeyId }
  const store = readSignInLeaseStoreUnlocked()
  const existing = store[normalizedEmail]
  const now = Date.now()
  // See acquireExchangeLeaseOperation: a future-dated lease cannot describe a
  // live holder on this machine, so treat it as stale and reclaimable too.
  const ageMs =
    existing && existing.at <= now ? now - existing.at : Number.POSITIVE_INFINITY
  if (existing && existing.owner !== owner && ageMs < SIGN_IN_KEY_LEASE_STALE_MS) {
    return { status: 'held', owner: existing.owner, ageMs }
  }
  store[normalizedEmail] = { owner, at: now }
  writeSignInLeaseStore(store)
  return { status: 'acquired' }
}

/**
 * Elect a single process to mint the sign-in key for this email. Async so it
 * never blocks the Ink event loop.
 */
export function acquireAimlapiSignInKeyLeaseAsync(
  email: string,
  owner: string,
): Promise<AimlapiSignInKeyLease> {
  return withStateLockAsync(() => acquireSignInKeyLeaseOperation(email, owner), signInKeyPath())
}

/**
 * Touch the sign-in key-mint lease's timestamp between createKey succeeding
 * and the cache write landing. createKey alone can take up to the client's
 * request timeout (60s), and the cache write can then wait up to the async
 * lock's own timeout (15s) — back to back those add up to exactly
 * `SIGN_IN_KEY_LEASE_STALE_MS` (75s) with no margin for scheduling or
 * filesystem overhead, so a legitimately still-working holder could have its
 * lease reclaimed by a peer moments before its result is cached. Refreshing
 * here gives the cache-write phase its own full window instead of sharing the
 * mint's budget. Returns false once the lease is no longer ours (reclaimed,
 * cleared, or superseded by a cached key).
 */
export function refreshAimlapiSignInKeyLeaseAsync(
  email: string,
  owner: string,
): Promise<boolean> {
  return withStateLockAsync(() => {
    const normalizedEmail = normalizeEmail(email)
    const store = readSignInLeaseStoreUnlocked()
    if (store[normalizedEmail]?.owner !== owner) return false
    store[normalizedEmail] = { owner, at: Date.now() }
    writeSignInLeaseStore(store)
    return true
  }, signInKeyPath())
}

/**
 * Release the sign-in key-mint lease after a definite (non-ambiguous) failure
 * so a retry proceeds promptly instead of waiting out the stale window.
 * Best-effort and ownership-aware. Never called on success — the cached key
 * supersedes the lease there.
 */
export function releaseAimlapiSignInKeyLeaseAsync(email: string, owner: string): Promise<void> {
  return withStateLockAsync(() => {
    const normalizedEmail = normalizeEmail(email)
    const store = readSignInLeaseStoreUnlocked()
    if (store[normalizedEmail]?.owner !== owner) return
    delete store[normalizedEmail]
    writeSignInLeaseStore(store)
  }, signInKeyPath())
}
