/**
 * duo — free model catalogue (OpenCode + Cline).
 *
 * Snapshot produced by the probe in the duo project (duo/probe_free.py, run
 * from the machine that hosts the fork), cost 0 verified: 2026-10-08 (first
 * run), 2026-10-10 (rate-limit outage), 2026-10-16 (three OpenCode ids went
 * no-route and two Cline ids failed, longcat recovered, cat-jam-free and
 * big-pickle verified and added). See RATE_LIMITED_MODELS and
 * KNOWN_BAD_MODELS for the caveats. Re-run the probe after PROBE_STALE_AFTER
 * (or `python3 probe_free.py <id…>` for a targeted re-check) and update this
 * file.
 */

/** Verified-cost-zero OpenCode models (provider/model-id). */
export const OC_FREE_MODELS = [
  'opencode/mimo-v2.6-flash-free',
  'opencode/space-bunny-free',
  'opencode/nemotron-3.5-lightning-free',
  'opencode/nemotron-3-ultra-free',
  'opencode/longcat-2.5-preview-free',
  'opencode/muse-spark-1.3-contributor-free',
  'opencode/cat-jam-free',
  'opencode/big-pickle',
  'orcarouter/z-ai/glm-5.3-flash-free',
  'orcarouter/deepseek/deepseek-v4-flash-free',
  'orcarouter/tencent/hy3-free',
  'zenmux/z-ai/glm-4.7-flash-free',
] as const

/** Verified-cost-zero Cline models (provider/model-id). */
export const CLINE_FREE_MODELS = [
  'cline-free/muse-spark-1.3-contributor',
  'cline-free/mimo-v2.6-flash',
] as const

/** Probe date of the lists above. */
export const PROBE_DATE = '2026-10-16'

/** Re-probe after this date: free tiers churn. */
export const PROBE_STALE_AFTER = '2026-11-15'

/**
 * Free models that were serving earlier and misbehaved at the last probe —
 * 429 on 2026-10-10, a 120 s hang instead of a reply on 2026-10-16.
 *
 * Deliberately kept out of KNOWN_BAD_MODELS: a saturated or slow free tier is
 * the service working as designed, not a broken entry, and these ids come
 * back. They stay in OC_FREE_MODELS because they are still the strongest
 * instruction followers available at cost 0 — they just must not be the
 * *only* option, which is what DUO_MODEL_A_FALLBACKS exists for.
 */
export const RATE_LIMITED_MODELS: ReadonlyArray<readonly [string, string]> = [
  [
    'opencode/nemotron-3-ultra-free',
    '120 s without a reply at the 2026-10-16 probe — slow rather than broken; rotate via DUO_MODEL_A_FALLBACKS',
  ],
]

/** Candidates that failed the probe, with their failure mode. */
export const KNOWN_BAD_MODELS: ReadonlyArray<readonly [string, string]> = [
  ['freemodel/*', '401 — requires an API key (`opencode auth`)'],
  ['orcarouter/orcarouter/free', '402 — quota exhausted'],
  ['tokenrouter/z-ai/glm-5.3-free', '503 — unavailable'],
  ['opencode/ling-3.0-flash-fin-free', '400 — invalid model'],
  // Verified live on earlier probes, gone no-route on 2026-10-16 ("Model
  // unavailable"): the catalogue still advertises the ids, the endpoint just
  // does not route them anymore.
  ['opencode/ling-3.1-flash-free', 'no-route — "Model unavailable", 2026-10-16'],
  ['opencode/fledge-alpha-free', 'no-route — "Model unavailable", 2026-10-16'],
  ['opencode/step-5-preview-free', 'no-route — "Model unavailable", 2026-10-16'],
  // Announced for retirement 2026-10-05, still served on 2026-10-08, failed
  // the 2026-10-16 probe — volatile rather than gone.
  ['stealth/space-bunny-alpha', 'finish=error at the 2026-10-16 probe (retirement announced)'],
  ['cline-free/deepseek-v4.1-flash', '"model not found" at the 2026-10-16 probe'],
  // Listed in the catalog, absent on the endpoint. A 404 rather than a 429:
  // these ids were never valid, so neither retrying nor pacing can help.
  ['zenmux/anthropic/claude-sonnet-5-free', '404 — "Requested model is not valid"'],
  ['zenmux/moonshotai/kimi-k3-free', '404 — "Requested model is not valid"'],
  ['zenmux/stepfun/step-3.7-flash-free', '404 — "Requested model is not valid"'],
]

/**
 * `stealth/space-bunny-alpha` was announced to retire on 2026-10-05, still
 * served at cost 0 on 2026-10-08, and failed the 2026-10-16 probe — it moved
 * to KNOWN_BAD_MODELS and may or may not return.
 */
export const CLINE_RETIREMENT_WARNING =
  'stealth/space-bunny-alpha (retirement announced 2026-10-05) failed the 2026-10-16 probe — it may return, but do not rely on it'