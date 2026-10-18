/**
 * AI/ML API passwordless onboarding and partner-checkout orchestration.
 *
 * End to end:
 *   1. Resolve the account email and check the account          -> sign-in | sign-up
 *   2. Sign in with a 6-digit email code, or create a new account -> access (Bearer) token
 *   3. Reuse a retained existing-account key, or mint one (sign-in) / exchange one (sign-up)
 *   4. Create a partner-checkout session and open the hosted payment page
 *   5. Poll the session until it is paid, then exchange the paid session for the key
 *   6. Write the key into OpenClaude's provider profile and retire the record
 *
 * Checkout crosses the browser/terminal boundary, so the payment session and
 * payment identity are retained (see topupState.ts) to make retries, cancellation
 * and exchange idempotent and resumable.
 */

import { randomUUID } from 'node:crypto'

import chalk from 'chalk'

import { openBrowser } from '../../utils/browser.js'
import { logForDebugging } from '../../utils/debug.js'
import { saveProfileFile } from '../../utils/providerProfile.js'
import {
  AimlapiApiError,
  AimlapiClient,
  type PartnerCheckoutSession,
} from './client.js'
import {
  buildPartnerCheckoutReturnUrls,
  buildPartnerReturnUrl,
  DEFAULT_MODEL,
  DEFAULT_PARTNER_NAME,
  isCanonicalAimlapiInferenceBaseUrl,
  resolveEndpoints,
  resolvePartnerId,
} from './config.js'
import { promptHidden, promptText } from './prompt.js'
import {
  acquireAimlapiExchangeLeaseAsync,
  acquireAimlapiKeyMintLeaseAsync,
  claimAimlapiTopupState,
  clearAimlapiTopupState,
  recordAimlapiCheckoutSession,
  recordAimlapiMintedKeyAsync,
  recordAimlapiSettledKeyAsync,
  refreshAimlapiExchangeLeaseAsync,
  releaseAimlapiExchangeLeaseAsync,
  releaseAimlapiKeyMintLeaseAsync,
  resetAimlapiCheckoutSession,
  saveAimlapiTopupState,
  type AimlapiTopupIntent,
} from './topupState.js'
import { abortError, isAmbiguousTransportApiError, sleep } from './transport.js'
import {
  isValidAimlapiEmail,
  isValidAimlapiSignInCode,
  parseAimlapiAmountUsd,
} from './validation.js'

export type AimlapiTopupOptions = {
  email?: string
  /** 6-digit email sign-in code (else prompted / `AIMLAPI_CODE`). */
  code?: string
  /** Top-up amount in whole USD (e.g. "25"). */
  amountUsd?: string
  autoTopUp?: boolean
  model?: string
  /** Skip opening the browser (print the URL instead). */
  noOpen?: boolean
  signal?: AbortSignal
}

export type AimlapiProvisionedKey = {
  apiKey: string
  apiKeyId: string
  baseUrl: string
  model: string
}

export type AimlapiTopupStatus =
  | 'checking-account'
  | 'sending-code'
  | 'verifying-code'
  | 'creating-account'
  | 'creating-key'
  | 'creating-session'
  | 'opening-checkout'
  | 'waiting-payment'
  | 'provisioning-key'

export type AimlapiProvisionOptions = Omit<AimlapiTopupOptions, 'email' | 'code'> & {
  /** Access (Bearer) token from sign-in / account creation. */
  sessionToken: string
  /** Endpoint that validated an existing key and must own any key-bound billing. */
  inferenceBaseUrl?: string
  /** Exchange the paid session for a fresh key (sign-up), else reuse the passed key. */
  exchange: boolean
  existingApiKey?: string
  existingApiKeyId?: string
  resumeSessionToken?: string
  /** Stable idempotency handle retained for one amount/auto-top-up intent. */
  paymentSessionId: string
  /**
   * The checkout intent, supplied by the guided flows so the one-shot key
   * exchange is serialized cross-process via the exchange lease. Omitted by unit
   * tests with no persisted state, which exchange directly.
   */
  intent?: AimlapiTopupIntent
  /**
   * Persist the session token; returns (or resolves to) the elected token
   * when a peer won. Async so the interactive flow's CAS write never blocks
   * Ink's event loop on lock contention.
   */
  onSession?: (sessionToken: string) => string | void | Promise<string | void>
  onStatus?: (status: AimlapiTopupStatus, detail?: string) => void
}

export type AimlapiByKeyTopupOptions = Omit<AimlapiTopupOptions, 'email' | 'code'> & {
  apiKey: string
  inferenceBaseUrl?: string
  paymentSessionId: string
  resumeSessionToken?: string
  /**
   * Persist the session token; returns (or resolves to) the elected token
   * when a peer won. Async so the interactive flow's CAS write never blocks
   * Ink's event loop on lock contention.
   */
  onSession?: (sessionToken: string) => string | void | Promise<string | void>
  onStatus?: (status: AimlapiTopupStatus, detail?: string) => void
}

type TopupPhase = 'pay' | 'poll' | 'exchange' | 'wait-exchange'

const POLL_INTERVAL_MS = 3000
const POLL_TIMEOUT_MS = 20 * 60 * 1000
// Unlike the payment/exchange waits, a key-mint lease holder never sits in a
// long poll before its single POST — a few retry cycles is enough headroom
// for a slow network or a couple of lease hand-offs.
const KEY_MINT_POLL_TIMEOUT_MS = 2 * 60 * 1000

// Test seam. The unit tests drive the flow against a stub transport and a
// capturing profile writer by swapping these in, rather than a process-global
// `mock.module('./client.js')` — that mock is not confined to one file (bun's
// module registry is shared across the whole run), so it would bleed into
// client.test.ts. Injecting keeps the seam local to this module.
type AimlapiClientFactory = (endpoints: ReturnType<typeof resolveEndpoints>) => AimlapiClient
let createAimlapiClient: AimlapiClientFactory = endpoints => new AimlapiClient(endpoints)
let writeAimlapiProviderProfile: typeof saveProfileFile = saveProfileFile
let promptTextFn: typeof promptText = promptText
let promptHiddenFn: typeof promptHidden = promptHidden

/** Swap in stubs for tests; pass `undefined` to restore the real implementations. */
export function setAimlapiTopupTestDoubles(
  doubles:
    | {
        createClient?: AimlapiClientFactory
        writeProfile?: typeof saveProfileFile
        promptText?: typeof promptText
        promptHidden?: typeof promptHidden
      }
    | undefined,
): void {
  createAimlapiClient = doubles?.createClient ?? (endpoints => new AimlapiClient(endpoints))
  writeAimlapiProviderProfile = doubles?.writeProfile ?? saveProfileFile
  promptTextFn = doubles?.promptText ?? promptText
  promptHiddenFn = doubles?.promptHidden ?? promptHidden
}

function maskKey(key: string): string {
  return key.length <= 10 ? '****' : `${key.slice(0, 6)}...${key.slice(-4)}`
}

// A session the provider reports as `exchanged` has already minted its one-shot
// key; it can never be paid or exchanged again. Both the poll loop and the
// resume path use this so neither opens a second, separately chargeable checkout
// for a credential that is already gone.
function alreadyExchangedError(session: PartnerCheckoutSession): Error {
  const keyHint = session.issuedKeyId?.trim()
    ? ` for issued key ${session.issuedKeyId.trim()}`
    : ''
  return new Error(
    `Session was already exchanged${keyHint}. Open https://aimlapi.com/app and rotate the issued key to recover access.`,
  )
}

// Marks a client.exchange transport failure as ambiguous (see
// isAmbiguousTransportApiError): the POST may have committed server-side with
// only its response lost. Distinguishes that case from other doExchange
// failures (a pre-POST bail from pollUntilExchangeSettled, or a definite
// rejection) that carry no such ambiguity and need no recovery check.
class AmbiguousExchangeFailure extends Error {
  constructor(readonly original: unknown) {
    super('Ambiguous /exchange failure: the request may have committed server-side.')
  }
}

export async function runAimlapiTopup(options: AimlapiTopupOptions): Promise<void> {
  const endpoints = resolveEndpoints()
  const client = createAimlapiClient(endpoints)
  const email =
    options.email?.trim() ||
    process.env.AIMLAPI_EMAIL?.trim() ||
    (await promptTextFn('AI/ML API email'))
  if (!isValidAimlapiEmail(email)) throw new Error('Email format is incorrect.')

  // Guided provisioning mints/exchanges a production-account key via production
  // auth and writes it as OPENAI_BASE_URL. Refuse a non-canonical inference
  // override so a freshly minted key is never sent to a custom/proxy endpoint
  // (mirrors the provider-manager gate).
  if (!isCanonicalAimlapiInferenceBaseUrl(endpoints.inferenceBaseUrl)) {
    throw new Error(
      'Guided top-up requires the aimlapi.com production endpoint. Unset AIMLAPI_INFERENCE_URL to create or fund a key.',
    )
  }

  console.log(chalk.bold('\n  AI/ML API top-up') + chalk.dim(`  -  ${endpoints.appBaseUrl}\n`))

  // Validate the amount and claim (or reuse) the retained checkout before any
  // account lookup or key mint: an invalid amount must not strand an unused key,
  // and an interrupted checkout must resume on the same key rather than mint a
  // fresh one on every retry.
  const amountUsdMinor = parseAimlapiAmountUsd(options.amountUsd)
  const partnerId = resolvePartnerId()
  const partnerName = DEFAULT_PARTNER_NAME
  const intent: AimlapiTopupIntent = {
    email: email.toLowerCase(),
    amountUsdMinor,
    autoTopUp: options.autoTopUp === true,
    partnerId,
    partnerName,
    appBaseUrl: endpoints.appBaseUrl.trim().replace(/\/+$/, ''),
    inferenceBaseUrl: endpoints.inferenceBaseUrl.trim().replace(/\/+$/, ''),
    payBaseUrl: endpoints.payBaseUrl.trim().replace(/\/+$/, ''),
    verificationBaseUrl: endpoints.verificationBaseUrl.trim().replace(/\/+$/, ''),
  }
  const checkoutState = claimAimlapiTopupState(intent)

  const finishProfile = (provisioned: AimlapiProvisionedKey): void => {
    const profilePath = writeAimlapiProviderProfile({
      profile: 'openai',
      env: {
        OPENAI_BASE_URL: provisioned.baseUrl,
        OPENAI_API_KEY: provisioned.apiKey,
        AIMLAPI_API_KEY: provisioned.apiKey,
        OPENAI_MODEL: provisioned.model,
        CLAUDE_CODE_PROVIDER_ROUTE_ID: 'aimlapi',
      },
      createdAt: new Date().toISOString(),
    })
    // Best-effort cleanup: the profile is already saved, so a lock/permission/IO
    // failure clearing the receipt must not report the whole top-up as failed.
    try {
      clearAimlapiTopupState({ ...intent, paymentSessionId: checkoutState.paymentSessionId })
    } catch {
      // Non-fatal: the profile is already saved. Note it (the stale receipt is
      // reconciled — resumed or replaced — on the next run) rather than fail.
      console.warn(
        chalk.dim(
          '    note: could not clear the local checkout receipt; it will be reconciled on the next run.',
        ),
      )
    }
    console.log(chalk.green('\n  [OK] Balance topped up and provider configured.'))
    console.log(`    key      ${chalk.dim(maskKey(provisioned.apiKey))}  (id ${provisioned.apiKeyId})`)
    console.log(`    base URL ${chalk.dim(provisioned.baseUrl)}`)
    console.log(`    model    ${chalk.dim(provisioned.model)}`)
    console.log(`    profile  ${chalk.dim(profilePath)}`)
  }

  // Resume: a prior run provisioned the key but was interrupted before the
  // profile write. Finish that last step with the retained key instead of
  // re-provisioning a now-exchanged (otherwise stranded) session. This runs
  // BEFORE any account lookup, so a re-authentication prompt or auth outage can
  // never strand a paid-for key that is already recorded locally.
  if (checkoutState.settled && checkoutState.apiKey) {
    finishProfile({
      apiKey: checkoutState.apiKey,
      apiKeyId: checkoutState.apiKeyId ?? '',
      baseUrl: endpoints.inferenceBaseUrl,
      // Prefer the model captured when the key was provisioned; a retry with a
      // different --model must not silently reconfigure the settled profile.
      model: checkoutState.model?.trim() || options.model?.trim() || DEFAULT_MODEL,
    })
    return
  }

  console.log(chalk.dim('  -> Checking account...'))
  const account = await client.checkAccount(email, options.signal)
  const persistSession = (resumeSessionToken: string): string | undefined => {
    if (!resumeSessionToken) {
      // A terminal checkout invalidates the payment session, but a minted
      // existing-account key is still valid: retain it (with a fresh payment
      // session) so the next run reuses the credential instead of issuing
      // another. Fall back to a full clear when there is no key to keep.
      if (
        checkoutState.apiKey &&
        resetAimlapiCheckoutSession({
          ...intent,
          paymentSessionId: checkoutState.paymentSessionId,
        })
      ) {
        return undefined
      }
      clearAimlapiTopupState({
        ...intent,
        paymentSessionId: checkoutState.paymentSessionId,
      })
      return undefined
    }
    // Atomic election: the first run to record a session for this payment id
    // wins; a loser gets the winner's token back and adopts it, so concurrent
    // runs never leave two chargeable checkouts.
    const recorded = recordAimlapiCheckoutSession({
      ...intent,
      ...checkoutState,
      resumeSessionToken,
    })
    if (!recorded) {
      // A null result means the stored checkout was cleared/reset meanwhile — a
      // sibling run already completed (or invalidated) this exact top-up. Abort
      // rather than pay a second, unrecorded checkout for a completed top-up.
      throw new Error(
        'This top-up was already completed or cancelled elsewhere. Re-run to try again.',
      )
    }
    const elected = recorded.resumeSessionToken || resumeSessionToken
    checkoutState.resumeSessionToken = elected
    return elected
  }

  let sessionToken: string
  let apiKey = checkoutState.apiKey?.trim() ?? ''
  let apiKeyId = checkoutState.apiKeyId?.trim() ?? ''
  let exchange: boolean

  switch (account.action) {
    case 'sign-in': {
      console.log(chalk.dim('  -> Sending sign-in code...'))
      await client.sendSignInCode(email, options.signal)
      const code =
        options.code?.trim() ||
        process.env.AIMLAPI_CODE?.trim() ||
        (await promptHiddenFn(`6-digit code sent to ${email}`))
      if (!code) throw new Error('Sign-in code is required.')
      if (!isValidAimlapiSignInCode(code)) {
        throw new Error('Sign-in code must be the 6-digit code sent by email.')
      }
      sessionToken = (await client.verifySignInCode(email, code, options.signal)).token
      // Do not mint a key when the retained checkout was a paid sign-up that must
      // still be exchanged (see `mustExchange` below): the exchange yields the key.
      if (!apiKey && checkoutState.exchange !== true) {
        const minted = await mintExistingAccountKeyWithLease(
          client,
          intent,
          checkoutState.paymentSessionId,
          sessionToken,
          options.signal,
        )
        apiKey = minted.apiKey
        apiKeyId = minted.apiKeyId
        checkoutState.apiKey = apiKey
        checkoutState.apiKeyId = apiKeyId
      }
      exchange = false
      break
    }
    case 'sign-up': {
      console.log(chalk.dim('  -> Creating account...'))
      sessionToken = (await client.createPasswordlessAccount(email, options.signal)).token
      exchange = true
      break
    }
    default:
      // Fail closed: only the two account actions the flow understands may
      // proceed (mirrors the guided onboarding path).
      throw new Error('AI/ML API returned an unsupported account action.')
  }

  // A retained checkout remembers whether it must be exchanged. A paid sign-up
  // checkout that was interrupted before /exchange still needs it on retry, even
  // though the account now resolves to sign-in (exchange === false). Persist the
  // mode on the first run and prefer the persisted value afterwards.
  const mustExchange = checkoutState.exchange ?? exchange
  if (checkoutState.exchange === undefined) {
    checkoutState.exchange = exchange
    try {
      saveAimlapiTopupState({ ...intent, ...checkoutState })
    } catch {
      // Retained in memory for this run; persistence is only a resume aid.
    }
  }

  const provisioned = await provisionAimlapiKey({
    amountUsd: options.amountUsd,
    autoTopUp: options.autoTopUp,
    model: options.model,
    noOpen: options.noOpen,
    signal: options.signal,
    sessionToken,
    exchange: mustExchange,
    intent,
    paymentSessionId: checkoutState.paymentSessionId,
    resumeSessionToken: checkoutState.resumeSessionToken,
    existingApiKey: apiKey,
    existingApiKeyId: apiKeyId,
    onSession: persistSession,
    onStatus: (status, detail) => {
      if (status === 'opening-checkout' && detail) {
        console.log(
          chalk.bold(`\n  Pay $${(amountUsdMinor / 100).toFixed(2)} to top up:\n`) +
            `  ${chalk.cyan(detail)}\n`,
        )
      }
      if (status === 'waiting-payment') console.log(chalk.dim('  Waiting for payment...'))
    },
  })

  // Persist the provisioned key (and its model) as recoverable before the
  // profile write, so an interruption or a failed write resumes the write
  // instead of stranding a paid, one-shot-exchanged key. This receipt is the
  // ONLY durable record of that key until the profile write below lands, and
  // /exchange cannot be retried to recover it — so unlike the earlier,
  // genuinely-optional resume-aid saves, a failure here must stop the flow
  // rather than risk losing the key silently if the profile write also fails
  // or the process is interrupted before it runs. saveAimlapiTopupState
  // already retries internally on lock contention (withStateLock, up to
  // LOCK_TIMEOUT_MS), so a failure this deep signals a real problem, not a
  // transient blip an outer retry would likely fix.
  checkoutState.apiKey = provisioned.apiKey
  checkoutState.apiKeyId = provisioned.apiKeyId
  checkoutState.model = provisioned.model
  checkoutState.settled = true
  try {
    saveAimlapiTopupState({ ...intent, ...checkoutState })
  } catch (error) {
    throw new Error(
      `Payment succeeded and a key was issued (id ${provisioned.apiKeyId}), but the local ` +
        `recovery receipt could not be saved (${error instanceof Error ? error.message : String(error)}). ` +
        `Open https://aimlapi.com/app and rotate the issued key to recover access.`,
      { cause: error },
    )
  }

  finishProfile(provisioned)
}

export async function provisionAimlapiKey(
  options: AimlapiProvisionOptions,
): Promise<AimlapiProvisionedKey> {
  if (!options.sessionToken.trim()) throw new Error('A session is required to top up.')
  if (!options.paymentSessionId?.trim()) {
    throw new Error('A payment session id is required to top up.')
  }
  const endpoints = resolveEndpoints()
  if (options.inferenceBaseUrl?.trim()) {
    endpoints.inferenceBaseUrl = options.inferenceBaseUrl.trim()
  }
  const client = createAimlapiClient(endpoints)
  const amountUsdMinor = parseAimlapiAmountUsd(options.amountUsd)
  const partnerId = resolvePartnerId()
  const partnerName = DEFAULT_PARTNER_NAME

  options.onStatus?.('creating-session')
  const { sessionToken, phase } = await resolveTopupSession(client, {
    resumeSessionToken: options.resumeSessionToken,
    partnerId,
    partnerName,
    verificationBaseUrl: endpoints.verificationBaseUrl,
    signal: options.signal,
    onSession: options.onSession,
  })
  // The session token is persisted inside resolveTopupSession as part of the
  // atomic election, so there is no separate onSession call here.

  // `pay` runs for a fresh checkout AND for a resumed pending_payment one: the
  // original /pay response (its only payUrl) can be lost to an interruption, and
  // the stable paymentSessionId makes re-issuing idempotent, so this recovers the
  // checkout URL instead of leaving the user polling a session they cannot open.
  if (phase === 'pay' || phase === 'poll') {
    const returnUrls = buildPartnerCheckoutReturnUrls(endpoints.payBaseUrl, sessionToken)
    options.onStatus?.('opening-checkout')
    const { checkout } = await client.pay(
      options.sessionToken,
      sessionToken,
      {
        amountUsdMinor,
        paymentSessionId: options.paymentSessionId,
        ...returnUrls,
        autoTopUp: options.autoTopUp,
      },
      options.signal,
    )
    await announceCheckout(checkout?.payUrl, options)
  }

  let paidToken = sessionToken
  let settledPhase = phase
  if (phase === 'pay' || phase === 'poll') {
    options.onStatus?.('waiting-payment')
    const paid = await pollUntilPaid(client, sessionToken, options.signal, options.onSession)
    paidToken = paid.sessionToken
    if (paid.status === 'exchanging') settledPhase = 'wait-exchange'
  }
  let apiKey = options.existingApiKey?.trim() || ''
  let apiKeyId = options.existingApiKeyId?.trim() || ''
  if (options.exchange) {
    options.onStatus?.('provisioning-key')
    const exchanged = await exchangeKeyWithLease(client, options, paidToken, settledPhase)
    apiKey = exchanged.apiKey
    apiKeyId = exchanged.apiKeyId
  } else if (settledPhase === 'wait-exchange') {
    // A resumed sign-in top-up was still crediting the account balance. Wait for
    // it to settle before reporting success, otherwise the caller marks the
    // balance credited while the billing operation is still in flight (mirrors
    // topUpAimlapiByApiKey's resume path).
    options.onStatus?.('waiting-payment')
    await pollUntilByKeyToppedUp(client, sessionToken, options.signal, options.onSession)
  }
  if (!apiKey) throw new Error('AI/ML API did not return an API key.')

  return {
    apiKey,
    apiKeyId,
    baseUrl: endpoints.inferenceBaseUrl,
    model: options.model?.trim() || DEFAULT_MODEL,
  }
}

export async function topUpAimlapiByApiKey(
  options: AimlapiByKeyTopupOptions,
): Promise<AimlapiProvisionedKey> {
  const apiKey = options.apiKey.trim()
  if (!apiKey) throw new Error('An API key is required to top up.')
  if (!options.paymentSessionId.trim()) {
    throw new Error('A payment session id is required to top up.')
  }
  const endpoints = resolveEndpoints()
  if (options.inferenceBaseUrl?.trim()) {
    endpoints.inferenceBaseUrl = options.inferenceBaseUrl.trim()
  }
  const client = createAimlapiClient(endpoints)
  const amountUsdMinor = parseAimlapiAmountUsd(options.amountUsd)
  const partnerId = resolvePartnerId()
  const partnerName = DEFAULT_PARTNER_NAME

  options.onStatus?.('creating-session')
  const { sessionToken, phase } = await resolveTopupSession(client, {
    resumeSessionToken: options.resumeSessionToken,
    partnerId,
    partnerName,
    verificationBaseUrl: endpoints.verificationBaseUrl,
    signal: options.signal,
    onSession: options.onSession,
    byKey: true,
  })
  // The session token is persisted inside resolveTopupSession as part of the
  // atomic election, so there is no separate onSession call here.

  // Re-issue for a resumed pending_payment checkout too: the idempotent
  // paymentSessionId recovers the original payUrl (lost to an interruption)
  // instead of leaving the user polling a session they cannot open.
  if (phase === 'pay' || phase === 'poll') {
    const returnUrls = buildPartnerCheckoutReturnUrls(endpoints.payBaseUrl, sessionToken)
    options.onStatus?.('opening-checkout')
    const { checkout } = await client.topUpByKey(
      apiKey,
      {
        sessionToken,
        amountUsdMinor,
        paymentSessionId: options.paymentSessionId,
        ...returnUrls,
        autoTopUp: options.autoTopUp,
      },
      options.signal,
    )
    await announceCheckout(checkout?.payUrl, options)
  }
  if (phase === 'pay' || phase === 'poll') {
    options.onStatus?.('waiting-payment')
    const paid = await pollUntilPaid(client, sessionToken, options.signal, options.onSession)
    if (paid.status === 'exchanging') {
      await pollUntilByKeyToppedUp(client, sessionToken, options.signal, options.onSession)
    }
  } else if (phase === 'wait-exchange') {
    // A resumed session was still settling the top-up; wait for it to reach a
    // terminal state before reporting success, otherwise the caller marks the
    // balance credited while the billing operation is still in flight.
    options.onStatus?.('waiting-payment')
    await pollUntilByKeyToppedUp(client, sessionToken, options.signal, options.onSession)
  }

  return {
    apiKey,
    apiKeyId: '',
    baseUrl: endpoints.inferenceBaseUrl,
    model: options.model?.trim() || DEFAULT_MODEL,
  }
}

async function announceCheckout(
  payUrl: string | null | undefined,
  options: Pick<AimlapiTopupOptions, 'noOpen'> & {
    onStatus?: (status: AimlapiTopupStatus, detail?: string) => void
  },
): Promise<void> {
  const checkoutUrl = payUrl?.trim()
  if (!checkoutUrl) throw new Error('Payment provider did not return a valid HTTPS checkout URL.')
  let parsed: URL
  try {
    parsed = new URL(checkoutUrl)
  } catch {
    throw new Error('Payment provider did not return a valid HTTPS checkout URL.')
  }
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new Error('Payment provider did not return a valid HTTPS checkout URL.')
  }
  // Surface the validated checkout URL before attempting to open a browser: a
  // launcher failure (e.g. on a headless host) must not hide an already-created
  // checkout, or the user cannot finish paying and retries only re-poll.
  options.onStatus?.('opening-checkout', checkoutUrl)
  if (!options.noOpen) {
    try {
      await openBrowser(checkoutUrl)
    } catch {
      // The URL is already surfaced; a failed launch must not abort payment.
    }
  }
}

async function resolveTopupSession(
  client: AimlapiClient,
  options: {
    resumeSessionToken?: string
    partnerId: string
    partnerName: string
    verificationBaseUrl: string
    signal?: AbortSignal
    onSession?: (sessionToken: string) => string | void | Promise<string | void>
    byKey?: boolean
  },
): Promise<{ sessionToken: string; phase: TopupPhase }> {
  const resume = options.resumeSessionToken?.trim()
  if (!resume) {
    const session = await client.createSession(
      {
        partnerId: options.partnerId,
        partnerName: options.partnerName,
        returnUrl: buildPartnerReturnUrl(options.verificationBaseUrl),
      },
      options.signal,
    )
    // Atomic election happens as the session is recorded: if a peer already
    // opened a payable checkout for this payment id, adopt its token and resume
    // that session instead of leaving this freshly created one chargeable too.
    const elected = await options.onSession?.(session.sessionToken)
    if (elected && elected !== session.sessionToken) {
      return resolveTopupSession(client, { ...options, resumeSessionToken: elected })
    }
    return { sessionToken: session.sessionToken, phase: 'pay' }
  }
  let session: PartnerCheckoutSession
  try {
    session = await client.getSession(resume, options.signal)
  } catch (error) {
    if (isTerminalSessionApiError(error)) await options.onSession?.('')
    throw error
  }
  let phase: TopupPhase
  switch (session.status) {
    case 'pending_auth':
      phase = 'pay'
      break
    case 'pending_payment':
      phase = 'poll'
      break
    case 'paid':
      phase = 'exchange'
      break
    case 'exchanging':
      // Not settled yet for either flow: the account flow must wait then
      // exchange, the by-key flow must wait for the top-up to finish crediting.
      phase = 'wait-exchange'
      break
    case 'exchanged':
      if (!options.byKey) throw alreadyExchangedError(session)
      phase = 'exchange'
      break
    default:
      await options.onSession?.('')
      throw new Error(`Payment ${session.status}. Re-run the top-up to try again.`)
  }
  // Re-notify the resumed token so the caller keeps its in-memory + on-disk copy
  // in sync (idempotent: the election keeps the already-recorded token).
  await options.onSession?.(resume)
  return { sessionToken: resume, phase }
}

/**
 * Mint the existing-account key for a checkout under a cross-process lease so
 * racing same-intent processes never call POST /v1/keys twice — the server
 * mints a fresh credential on every call with no idempotency of its own, so a
 * second call doesn't fail, it just mints (and orphans) a second valid key.
 * The lease winner mints; a peer that finds a live lease backs off and
 * re-attempts, resuming from the winner's recorded key or minting itself once
 * the lease frees (the winner failed, or crashed and it went stale); a peer
 * that finds a recorded key resumes from it. Falls back to a direct mint when
 * no intent is supplied (unit tests with no persisted state).
 */
async function mintExistingAccountKeyWithLease(
  client: AimlapiClient,
  intent: AimlapiTopupIntent | undefined,
  paymentSessionId: string,
  sessionToken: string,
  signal?: AbortSignal,
): Promise<{ apiKey: string; apiKeyId: string }> {
  const expected = intent ? { ...intent, paymentSessionId } : undefined
  // One lease owner per operation (not per process): see exchangeKeyWithLease.
  const owner = randomUUID()

  const doMint = async (): Promise<{ apiKey: string; apiKeyId: string }> => {
    const created = await client.createKey(sessionToken, 'OpenClaude CLI', signal)
    return { apiKey: created.key.trim(), apiKeyId: created.id.trim() }
  }

  if (!expected) return doMint()

  const deadline = Date.now() + KEY_MINT_POLL_TIMEOUT_MS
  for (;;) {
    if (signal?.aborted) throw abortError(signal)
    const lease = await acquireAimlapiKeyMintLeaseAsync(expected, owner)
    if (lease.status === 'gone') {
      throw new Error(
        'This top-up was already completed or cancelled elsewhere. Re-run to try again.',
      )
    }
    if (lease.status === 'minted') {
      // A peer already minted and recorded a key — resume from its receipt.
      return {
        apiKey: lease.state.apiKey?.trim() ?? '',
        apiKeyId: lease.state.apiKeyId?.trim() ?? '',
      }
    }
    if (lease.status === 'acquired') {
      // We are the sole minter for this checkout, either from the start or by
      // taking over from a peer that failed (or crashed) and freed the lease.
      let minted: { apiKey: string; apiKeyId: string }
      try {
        minted = await doMint()
      } catch (error) {
        // createKey is non-idempotent and exposes no retrieval-by-id
        // endpoint, so a transport-level failure (network error, timeout,
        // rate-limit, 5xx) is ambiguous: the POST may have minted a key
        // server-side before its response was lost, with no way to recover
        // that credential here. Releasing the lease in that case would let a
        // retry (or a racing peer) mint a second, orphaned key. Leave the
        // lease held so it only frees once it goes stale, narrowing (not
        // eliminating) the double-mint window. A definite rejection (a real
        // 4xx other than 408/429) means nothing was created, so release
        // immediately to let a retry proceed without waiting out the window.
        // A caller-driven abort mid-flight is ambiguous too — cancelling
        // client-side does not stop the server from completing an
        // already-sent POST, and client.request rethrows the raw abort error
        // instead of an AimlapiApiError for it.
        if (!isAmbiguousTransportApiError(error) && !signal?.aborted) {
          // Best-effort: if the release itself fails the lease still expires
          // on its own, only more slowly.
          await releaseAimlapiKeyMintLeaseAsync(expected, owner).catch(
            (releaseError: unknown) => {
              logForDebugging(
                `Failed to release the AI/ML API key-mint lease: ${String(releaseError)}`,
                { level: 'warn' },
              )
            },
          )
        }
        throw error
      }
      // Persist under the same CAS before returning it, so a crash right
      // after minting still recovers the key on the next run instead of
      // stranding a valid, unused credential. createKey is non-idempotent, so
      // this receipt is the ONLY durable record of the minted key until the
      // checkout finishes and the later, already-fatal save at this
      // function's caller lands — the window between the two can be minutes
      // long (the user paying in a browser). Unlike a genuinely optional
      // resume aid, a failure here must stop the flow with a recovery-
      // oriented error instead of returning the key only in memory.
      // recordAimlapiMintedKeyAsync rejects (throws) instead of writing this
      // result if the key-mint lease moved to a different owner with no key
      // recorded yet — that owner's own mint may still be in flight, and
      // writing anyway risks THEIR key being silently discarded once it
      // lands. The credential it returns on success is not always this
      // call's own, either: a peer that recorded first wins, and that key is
      // what must be reported as saved.
      let recorded: { apiKey: string; apiKeyId?: string }
      try {
        recorded = await recordAimlapiMintedKeyAsync(
          expected,
          { apiKey: minted.apiKey, apiKeyId: minted.apiKeyId },
          owner,
        )
      } catch (error) {
        throw new Error(
          `A key was issued (id ${minted.apiKeyId}), but the local recovery receipt could ` +
            `not be saved (${error instanceof Error ? error.message : String(error)}). Open ` +
            `https://aimlapi.com/app and rotate the issued key to recover access.`,
          { cause: error },
        )
      }
      return { apiKey: recorded.apiKey, apiKeyId: recorded.apiKeyId ?? '' }
    }
    // held: a live peer is minting; back off and re-attempt rather than
    // minting in parallel and orphaning a credential.
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for a concurrent key mint. Retry to resume.')
    }
    await sleep(POLL_INTERVAL_MS, signal)
  }
}

/**
 * Run the one-shot key exchange under a cross-process lease so racing same-intent
 * processes never call /exchange twice (which strands the paid session). The lease
 * winner exchanges; a peer that finds a live lease backs off and re-attempts,
 * resuming from the winner's settled receipt or taking the exchange over itself
 * once the lease is freed (the winner failed, or crashed and it went stale); a
 * peer that finds a settled receipt resumes from it. Falls back to a direct
 * exchange when no intent is supplied (unit tests with no persisted state).
 */
async function exchangeKeyWithLease(
  client: AimlapiClient,
  options: AimlapiProvisionOptions,
  paidToken: string,
  settledPhase: TopupPhase,
): Promise<{ apiKey: string; apiKeyId: string }> {
  const intent = options.intent
  const expected = intent
    ? { ...intent, paymentSessionId: options.paymentSessionId }
    : undefined
  // One lease owner per operation (not per process): two overlapping top-ups in
  // the same process must each see the other's live lease as foreign and back
  // off, rather than sharing one owner id that lets both reclaim it and POST the
  // non-idempotent /exchange concurrently. A retry WITHIN this operation still
  // reclaims the lease it just released, because it keeps this same owner.
  const owner = randomUUID()

  const doExchange = async (): Promise<{ apiKey: string; apiKeyId: string }> => {
    if (settledPhase === 'wait-exchange') {
      await pollUntilExchangeSettled(
        client,
        paidToken,
        options.signal,
        options.onSession,
        // Keep the lease alive for up to POLL_TIMEOUT_MS of read-only waiting
        // here, even though EXCHANGE_LEASE_STALE_MS is sized for the single
        // POST below — without this a peer reclaims the "stale" lease mid-wait
        // and both processes can reach /exchange on the same one-shot session.
        expected ? () => refreshAimlapiExchangeLeaseAsync(expected, owner) : undefined,
      )
    }
    try {
      const exchanged = await client.exchange(options.sessionToken, paidToken, options.signal)
      return { apiKey: exchanged.apiKey.trim(), apiKeyId: exchanged.apiKeyId.trim() }
    } catch (error) {
      // Only a transport-level failure of THIS POST is genuinely ambiguous
      // about whether it landed server-side. A failure from the poll above
      // (lease reclaimed, terminal session status) never reached /exchange at
      // all, and a definite 4xx rejection here means nothing was minted —
      // neither needs the ambiguous-outcome recovery below. A caller-driven
      // abort mid-flight is ambiguous too: client.request rethrows the raw
      // abort error (not an AimlapiApiError) when options.signal fired, and
      // cancelling client-side does not stop the server from completing an
      // already-sent POST.
      if (isAmbiguousTransportApiError(error) || options.signal?.aborted) {
        throw new AmbiguousExchangeFailure(error)
      }
      throw error
    }
  }

  if (!expected) return doExchange()

  // Elect a single exchanger across racing same-intent operations, then keep
  // re-attempting the lease: a live foreign lease means a peer is exchanging now,
  // so we resume the moment it records a settled receipt OR frees the lease —
  // whether it released after a failure or crashed and let the lease go stale —
  // rather than waiting out the whole 20-minute poll window for a receipt that
  // may never arrive.
  const deadline = Date.now() + POLL_TIMEOUT_MS
  for (;;) {
    if (options.signal?.aborted) throw abortError(options.signal)
    const lease = await acquireAimlapiExchangeLeaseAsync(expected, owner)
    if (lease.status === 'gone') {
      throw new Error(
        'This top-up was already completed or cancelled elsewhere. Re-run to try again.',
      )
    }
    if (lease.status === 'settled') {
      // A peer already exchanged and recorded the key — resume from its receipt.
      return {
        apiKey: lease.state.apiKey?.trim() ?? '',
        apiKeyId: lease.state.apiKeyId?.trim() ?? '',
      }
    }
    if (lease.status === 'acquired') {
      // We are the sole exchanger for this checkout, either from the start or by
      // taking over from a peer that failed (or crashed) and freed the lease.
      let exchanged: { apiKey: string; apiKeyId: string }
      try {
        exchanged = await doExchange()
      } catch (error) {
        // The failure can mean a peer finished /exchange (and recorded the
        // settled key) WHILE this held the lease and was polling/exchanging —
        // e.g. pollUntilExchangeSettled sees the session flip to 'exchanged'
        // and throws, even though the key is already sitting in a settled
        // receipt. Recover from it instead of hard-failing when so; the CAS
        // in this same check is also just a harmless self-reaffirm of our own
        // still-held lease when nothing settled.
        const recheck = await acquireAimlapiExchangeLeaseAsync(expected, owner).catch(
          (): null => null,
        )
        if (recheck?.status === 'settled') {
          return {
            apiKey: recheck.state.apiKey?.trim() ?? '',
            apiKeyId: recheck.state.apiKeyId?.trim() ?? '',
          }
        }
        if (error instanceof AmbiguousExchangeFailure) {
          // /exchange is non-idempotent, so this thrown error is ambiguous: it
          // can mean the POST never reached the server (safe to retry), OR
          // that it committed server-side and only the response was lost. In
          // the second case the session is genuinely 'exchanged' with no
          // local receipt for it — this process is the one whose response
          // vanished, and the key value only ever existed in that lost
          // response, so it cannot be recovered here (the API exposes no
          // retrieval-by-session endpoint). Re-check the session status
          // directly (not just the local receipt) so this run surfaces the
          // accurate "already exchanged, rotate the key" guidance immediately,
          // instead of a transient-looking error that just invites a retry
          // which would hit the exact same wall one round-trip later, via
          // resolveTopupSession's own 'exchanged' handling.
          const ambiguousSession = options.signal?.aborted
            ? null
            : await client.getSession(paidToken, options.signal).catch((): null => null)
          if (ambiguousSession?.status === 'exchanged') {
            await releaseAimlapiExchangeLeaseAsync(expected, owner).catch(
              (releaseError: unknown) => {
                logForDebugging(
                  `Failed to release the AI/ML API exchange lease: ${String(releaseError)}`,
                  { level: 'warn' },
                )
              },
            )
            throw alreadyExchangedError(ambiguousSession)
          }
          // Still genuinely unresolved — the recheck above found no evidence
          // either way. Leave the lease held (instead of releasing it) so a
          // retry or a racing peer cannot send a second /exchange POST for
          // this one-shot session while the first's outcome is still unknown;
          // it frees on its own once the stale window elapses.
          throw error.original
        }
        // Not ambiguous: a pre-POST bail (lease reclaimed, terminal session
        // status) or a definite rejection. Nothing was committed by this
        // attempt, so release the lease promptly instead of waiting out the
        // stale window. If the release itself fails the lease still expires
        // on its own (only more slowly), so this is non-fatal — but record
        // why, so a lock/permission problem behind the delay is diagnosable.
        // Debug logging is file-backed, so this stays safe on the Ink GUI path.
        await releaseAimlapiExchangeLeaseAsync(expected, owner).catch(
          (releaseError: unknown) => {
            logForDebugging(
              `Failed to release the AI/ML API exchange lease: ${String(releaseError)}`,
              { level: 'warn' },
            )
          },
        )
        throw error
      }
      // The /exchange succeeded and is non-idempotent: persist the key under the
      // same CAS BEFORE returning it, so a crash before the caller writes its
      // own (later) receipt can still recover the paid key instead of
      // re-running the spent exchange (which the server would reject as
      // already-exchanged, stranding it). This is the ONLY durable record of
      // the key until that later save lands — the window between the two can
      // be as long as the caller takes to run, including process exit — so a
      // failure here must stop the flow with a recovery-oriented error
      // instead of returning the key only in memory: the exchange lease is
      // left exactly as it is (still held), so a retry sees this checkout as
      // still in flight and cannot send a second /exchange for the spent
      // session rather than falling through to the discovers-it-was-already-
      // exchanged case, which has no automatic recovery.
      let settled: boolean
      try {
        settled = await recordAimlapiSettledKeyAsync(expected, {
          apiKey: exchanged.apiKey,
          apiKeyId: exchanged.apiKeyId,
          model: options.model,
        })
      } catch (error) {
        throw new Error(
          `Payment succeeded and a key was issued (id ${exchanged.apiKeyId}), but the local ` +
            `recovery receipt could not be saved (${error instanceof Error ? error.message : String(error)}). ` +
            `Open https://aimlapi.com/app and rotate the issued key to recover access.`,
          { cause: error },
        )
      }
      // recordAimlapiSettledKeyAsync also returns false (rather than throwing) when
      // the write is a deliberate no-op — the checkout record was cleared/reset out
      // from under this CAS, or no credential could be resolved to settle with.
      // Neither is an I/O failure, but both leave this call as the only place the
      // exchanged key was ever recorded, so they must fail exactly like a thrown
      // save error rather than let the key return with no durable receipt.
      if (!settled) {
        throw new Error(
          `Payment succeeded and a key was issued (id ${exchanged.apiKeyId}), but the local ` +
            `recovery receipt could not be saved (the checkout record was cleared, reset, or claimed ` +
            `anew before it could be committed). Open https://aimlapi.com/app and rotate the issued ` +
            `key to recover access.`,
        )
      }
      return exchanged
    }
    // held: a live peer is exchanging the one-shot session; back off and
    // re-attempt rather than exchanging in parallel and stranding the paid session.
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for a concurrent key exchange. Retry to resume.')
    }
    await sleep(POLL_INTERVAL_MS, options.signal)
  }
}

async function pollUntilExchangeSettled(
  client: AimlapiClient,
  sessionToken: string,
  signal?: AbortSignal,
  onSession?: (sessionToken: string) => string | void | Promise<string | void>,
  refreshLease?: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortError(signal)
    // POLL_INTERVAL_MS (3s) refreshes the lease well within EXCHANGE_LEASE_STALE_MS
    // (75s), so a live holder's lease never goes stale mid-wait. A THROWN refresh
    // (e.g. transient lock contention) is treated as still-ours and best-effort —
    // it'll retry next iteration. An explicit `false`, though, means a peer
    // already reclaimed the lease: this function returning normally afterward
    // would let the caller walk straight into the non-idempotent /exchange POST
    // with no ownership check of its own, racing whatever the peer is doing.
    // Bail out instead so the caller's catch block re-checks for that peer's
    // settled receipt (or fails the run, requiring a re-run) rather than racing it.
    if (refreshLease && !(await refreshLease().catch(() => true))) {
      throw new Error(
        'The exchange lease was reclaimed by another process. Re-run to resume from its result.',
      )
    }
    try {
      const session = await client.getSession(sessionToken, signal)
      if (session.status === 'exchanged') throw alreadyExchangedError(session)
      if (
        session.status === 'cancelled' ||
        session.status === 'expired' ||
        session.status === 'failed'
      ) {
        await onSession?.('')
        throw new Error(
          `Key provisioning ${session.status}. Rotate the key from the AI/ML API dashboard.`,
        )
      }
      if (session.status !== 'exchanging') return
    } catch (error) {
      if (signal?.aborted) throw abortError(signal)
      if (isAmbiguousTransportApiError(error)) {
        await sleep(POLL_INTERVAL_MS, signal)
        continue
      }
      if (isTerminalSessionApiError(error)) await onSession?.('')
      throw error
    }
    await sleep(POLL_INTERVAL_MS, signal)
  }
  throw new Error('Timed out waiting for key provisioning. Retry to check the same session.')
}

async function pollUntilByKeyToppedUp(
  client: AimlapiClient,
  sessionToken: string,
  signal?: AbortSignal,
  onSession?: (sessionToken: string) => string | void | Promise<string | void>,
): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortError(signal)
    try {
      const session = await client.getSession(sessionToken, signal)
      switch (session.status) {
        case 'paid':
        case 'exchanged':
          return
        case 'cancelled':
        case 'expired':
        case 'failed':
          await onSession?.('')
          throw new Error(`Top-up ${session.status}. Re-run the top-up to try again.`)
        default:
          // pending_* / exchanging -> keep waiting for the balance to settle.
          await sleep(POLL_INTERVAL_MS, signal)
      }
    } catch (error) {
      if (signal?.aborted) throw abortError(signal)
      if (isAmbiguousTransportApiError(error)) {
        await sleep(POLL_INTERVAL_MS, signal)
        continue
      }
      if (isTerminalSessionApiError(error)) await onSession?.('')
      throw error
    }
  }
  throw new Error('Timed out waiting for the top-up to settle. Re-run once it clears.')
}

export async function pollUntilPaid(
  client: AimlapiClient,
  sessionToken: string,
  signal?: AbortSignal,
  onSession?: (sessionToken: string) => string | void | Promise<string | void>,
): Promise<PartnerCheckoutSession> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortError(signal)
    try {
      const session = await client.getSession(sessionToken, signal)
      switch (session.status) {
        case 'paid':
        case 'exchanging':
          return session
        case 'exchanged':
          throw alreadyExchangedError(session)
        case 'cancelled':
        case 'expired':
        case 'failed':
          await onSession?.('')
          throw new Error(`Payment ${session.status}. Re-run the top-up to try again.`)
        default:
          await sleep(POLL_INTERVAL_MS, signal)
      }
    } catch (error) {
      if (signal?.aborted) throw abortError(signal)
      if (isAmbiguousTransportApiError(error)) {
        await sleep(POLL_INTERVAL_MS, signal)
        continue
      }
      if (isTerminalSessionApiError(error)) await onSession?.('')
      throw error
    }
  }
  throw new Error('Timed out waiting for payment. Re-run once the payment clears.')
}

// A 4xx that is not a rate-limit/timeout is a definitive answer about the
// session (gone / forbidden / bad request), so it retires the recorded checkout
// rather than being retried.
function isTerminalSessionApiError(error: unknown): boolean {
  return (
    error instanceof AimlapiApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    !isAmbiguousTransportApiError(error)
  )
}
