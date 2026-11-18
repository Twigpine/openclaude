/**
 * Local usage ledger types.
 *
 * The ledger records one small line per billed model request so `/usage` can
 * show provider-neutral, machine-local token usage. It never stores prompts,
 * responses, file contents, base URLs, or credentials.
 */

export const USAGE_EVENT_VERSION = 1
export const USAGE_ROLLUP_VERSION = 1

/** One billed model request, as written to `usage/events/<date>.jsonl`. */
export type UsageEvent = {
  v: typeof USAGE_EVENT_VERSION
  /** Random id, unique per event; lets readers merge in-memory and on-disk copies. */
  id: string
  /** Epoch milliseconds when the request finished. */
  ts: number
  session: string
  /** Directory OpenClaude was started in. */
  project: string
  model: string
  /** Integration route id, e.g. `opengateway`, `anthropic`, `codex`, `ollama`. */
  route: string
  /** The endpoint is on this machine or a private network. */
  local?: true
  /** The query source that made the request, e.g. `repl_main_thread`. */
  source: string
  agentId?: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  webSearch: number
  /** The provider does not report prompt-cache usage for this request. */
  noCache?: true
  /** Fast-mode request (priced differently on some models). */
  fast?: true
  /** The provider returned no token counts for this request. */
  unreported?: true
}

export type UsageTokenCounts = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  webSearch: number
}

/** Totals for one combination of dimensions on one local day. */
export type UsageRollupRow = UsageTokenCounts & {
  model: string
  route: string
  local?: true
  source: string
  project: string
  fast?: true
  requests: number
  unreported: number
  /** Requests whose provider did not report prompt-cache usage. */
  noCacheRequests: number
  /** Input-side tokens (input + cache read + cache write) of those requests. */
  noCacheInputTokens: number
}

export type UsageDayRollup = {
  rows: UsageRollupRow[]
  sessions: string[]
  /** Size of the day's event file when this rollup was built. */
  sourceBytes: number
}

/** Contents of `usage/rollups/<YYYY-MM>.json`. */
export type UsageRollupFile = {
  version: typeof USAGE_ROLLUP_VERSION
  days: Record<string, UsageDayRollup>
}
