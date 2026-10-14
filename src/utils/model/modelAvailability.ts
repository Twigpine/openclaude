/**
 * Per-model availability probing.
 *
 * Upstream catalogs (NVIDIA NIM, most OpenAI-compatible gateways) list every
 * model they have ever hosted, including ones the current credential cannot
 * use — end-of-life builds and models gated to other accounts. A picker that
 * shows all of them equally invites a choice that fails at request time.
 *
 * Nothing in the upstream `/models` payload distinguishes these cases, so the
 * only reliable signal is a minimal inference request. This module issues one
 * per model and maps the outcome onto a coarse status.
 *
 * Probes are real inference calls. They are deliberately bounded (concurrency
 * cap, short timeout, one token) and their results are cached by the caller —
 * this is an explicit user action, never a background sweep.
 */

export type ModelAvailabilityState =
  | 'available'
  | 'unavailable'
  | 'deprecated'
  | 'auth-failed'
  | 'rate-limited'
  | 'unreachable'
  | 'unknown'

export type ModelAvailability = {
  state: ModelAvailabilityState
  /** Short upstream detail (truncated) for the cases worth explaining. */
  detail?: string
  checkedAt: number
}

export type ProbeRequestPlan = {
  url: string
  headers: Record<string, string>
  body: unknown
}

export type ProbePlanBuilder = (model: string) => ProbeRequestPlan

const PROBE_TIMEOUT_MS = 25_000
/**
 * Concurrency ceiling.
 *
 * Measured against a local gateway in front of NVIDIA NIM: concurrency 6 timed
 * out 30% of probes, concurrency 3 timed out 10%. Free-tier upstreams queue
 * rather than reject, so a burst reads as slowness and the per-probe timeout
 * turns it into a false "unreachable". Staying low costs wall-time, not
 * accuracy.
 */
const DEFAULT_CONCURRENCY = 3
const MAX_DETAIL_LENGTH = 120

/** Compact marker rendered next to a model in the picker. */
export function formatAvailabilityState(state: ModelAvailabilityState): string {
  switch (state) {
    case 'available':
      return '✓ available'
    case 'unavailable':
      return '✗ unavailable'
    case 'deprecated':
      return '✗ end-of-life'
    case 'auth-failed':
      return '⚠ auth failed'
    case 'rate-limited':
      return '⚠ rate limited'
    case 'unreachable':
      return '⚠ unreachable'
    case 'unknown':
      return '? unchecked'
  }
}

function truncateDetail(value: string): string | undefined {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  if (!collapsed) {
    return undefined
  }
  return collapsed.length > MAX_DETAIL_LENGTH
    ? `${collapsed.slice(0, MAX_DETAIL_LENGTH - 1)}…`
    : collapsed
}

/**
 * Map an HTTP outcome onto a status.
 *
 * 410 is the honest "this model existed but has been retired" signal and is
 * kept distinct from 404 ("never offered, or not to this account") because
 * they call for different user action.
 */
function classifyStatus(
  status: number,
  detail: string | undefined,
): ModelAvailability {
  const checkedAt = Date.now()

  if (status >= 200 && status < 300) {
    return { state: 'available', checkedAt }
  }
  if (status === 410 || status === 451) {
    return { state: 'deprecated', detail, checkedAt }
  }
  if (status === 404 || status === 405) {
    return { state: 'unavailable', detail, checkedAt }
  }
  if (status === 401 || status === 403) {
    return { state: 'auth-failed', detail, checkedAt }
  }
  if (status === 408 || status === 429) {
    return { state: 'rate-limited', detail, checkedAt }
  }
  return { state: 'unreachable', detail, checkedAt }
}

/** Extract a short human-readable reason from an error body. */
async function extractDetail(response: Response): Promise<string | undefined> {
  try {
    const text = (await response.text()).slice(0, 1000)
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      const error = parsed.error
      if (error && typeof error === 'object') {
        const message = (error as { message?: unknown }).message
        if (typeof message === 'string') {
          return truncateDetail(message)
        }
      }
      const topMessage = parsed.message ?? parsed.detail ?? parsed.title
      if (typeof topMessage === 'string') {
        return truncateDetail(topMessage)
      }
    } catch {
      // Not JSON — fall through to the raw body.
    }
    return truncateDetail(text)
  } catch {
    return undefined
  }
}

export type ProbeModelAvailabilityOptions = {
  plan: ProbeRequestPlan
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Internal: guards the one-shot slow-upstream retry from recursing. */
  allowRetry?: boolean
}

/** An abort is our own timeout, not an upstream verdict. */
function isSelfAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export async function probeModelAvailability(
  options: ProbeModelAvailabilityOptions,
): Promise<ModelAvailability> {
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? PROBE_TIMEOUT_MS,
  )

  try {
    const response = await fetchImpl(options.plan.url, {
      method: 'POST',
      headers: options.plan.headers,
      body: JSON.stringify(options.plan.body),
      signal: controller.signal,
    })
    const detail = await extractDetail(response)
    return classifyStatus(response.status, detail)
  } catch (error) {
    // A slow upstream must not be recorded as a dead model. Retry once, with a
    // longer deadline, and only when this is the first attempt — otherwise a
    // persistently slow endpoint would recurse into an ever-longer retry.
    if (isSelfAbort(error) && options.allowRetry !== false) {
      const retry = await probeModelAvailability({
        ...options,
        timeoutMs: (options.timeoutMs ?? PROBE_TIMEOUT_MS) * 2,
        allowRetry: false,
      })
      if (retry.state !== 'unreachable') {
        return retry
      }
    }
    return {
      state: 'unreachable',
      detail: truncateDetail(error instanceof Error ? error.message : String(error)),
      checkedAt: Date.now(),
    }
  } finally {
    clearTimeout(timer)
  }
}

export type ProbeAvailabilityBatchOptions = {
  models: string[]
  buildPlan: ProbePlanBuilder
  concurrency?: number
  fetchImpl?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
  onProgress?: (completed: number, total: number) => void
  /** Minimum interval between onProgress calls. */
  progressIntervalMs?: number
}

/**
 * Probe a list of models with a bounded worker pool.
 *
 * Ordering of results is irrelevant (keyed by model), but completion is
 * reported so the UI can show progress across a large catalog.
 */
export async function probeAvailabilityBatch(
  options: ProbeAvailabilityBatchOptions,
): Promise<Record<string, ModelAvailability>> {
  const total = options.models.length
  const results: Record<string, ModelAvailability> = {}
  if (total === 0) {
    return results
  }

  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, total),
  )
  const queue = [...options.models]
  let completed = 0
  let cursor = 0
  // Progress drives a re-render. Without a floor, a 168-model run re-renders the
  // whole list 168 times, and the rendering competes with the in-flight
  // requests — measured as a 4x rise in timeout-induced "unreachable" verdicts
  // inside the TUI versus the same probe run headlessly.
  const progressIntervalMs = options.progressIntervalMs ?? 1000
  let lastProgressAt = 0
  let lastReportedCount = -1

  const reportProgress = (force: boolean): void => {
    if (!options.onProgress) {
      return
    }
    // Never repeat the same count: the forced final report would otherwise
    // duplicate a throttled report that already carried it.
    if (completed === lastReportedCount) {
      return
    }
    const now = Date.now()
    if (!force && now - lastProgressAt < progressIntervalMs) {
      return
    }
    lastProgressAt = now
    lastReportedCount = completed
    options.onProgress(completed, total)
  }

  const worker = async (): Promise<void> => {
    for (;;) {
      if (options.signal?.aborted) {
        return
      }
      const index = cursor++
      const model = queue[index]
      if (model === undefined) {
        return
      }

      let outcome: ModelAvailability
      try {
        outcome = await probeModelAvailability({
          plan: options.buildPlan(model),
          fetchImpl: options.fetchImpl,
          timeoutMs: options.timeoutMs,
        })
      } catch {
        outcome = {
          state: 'unknown',
          checkedAt: Date.now(),
        }
      }

      results[model] = outcome
      completed++
      reportProgress(false)
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker))
  // Always surface the final count even if it arrived inside the throttle window.
  reportProgress(true)
  return results
}

/**
 * Drop results older than `ttlMs` so a stale "unavailable" verdict does not
 * outlive the upstream state that produced it.
 */
export function pruneStaleAvailability(
  results: Record<string, ModelAvailability>,
  ttlMs: number,
  now: number = Date.now(),
): Record<string, ModelAvailability> {
  const fresh: Record<string, ModelAvailability> = {}
  for (const [model, availability] of Object.entries(results)) {
    if (now - availability.checkedAt <= ttlMs) {
      fresh[model] = availability
    }
  }
  return fresh
}
