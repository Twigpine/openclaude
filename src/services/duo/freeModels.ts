/**
 * duo — free model catalogue (OpenCode + Cline).
 *
 * Snapshot produced by the probe in the duo project
 * (duo/probe_free.py, run from the machine that hosts the fork) on
 * 2026-10-08 — 11 OpenCode and 4 Cline models verified live, cost 0 — then
 * re-probed on 2026-10-10 after the first rate-limit outage (see
 * RATE_LIMITED_MODELS and KNOWN_BAD_MODELS). Re-run the probe after
 * PROBE_STALE_AFTER and update this file.
 */

/** Verified-cost-zero OpenCode models (provider/model-id). */
export const OC_FREE_MODELS = [
  'opencode/mimo-v2.6-flash-free',
  'opencode/space-bunny-free',
  'opencode/nemotron-3.5-lightning-free',
  'opencode/nemotron-3-ultra-free',
  'opencode/ling-3.1-flash-free',
  'opencode/longcat-2.5-preview-free',
  'opencode/fledge-alpha-free',
  'opencode/muse-spark-1.3-contributor-free',
  'opencode/step-5-preview-free',
  'orcarouter/z-ai/glm-5.3-flash-free',
  'orcarouter/deepseek/deepseek-v4-flash-free',
  'orcarouter/tencent/hy3-free',
  'zenmux/z-ai/glm-4.7-flash-free',
] as const

/** Verified-cost-zero Cline models (provider/model-id). */
export const CLINE_FREE_MODELS = [
  'cline-free/muse-spark-1.3-contributor',
  'cline-free/deepseek-v4.1-flash',
  'cline-free/mimo-v2.6-flash',
  'stealth/space-bunny-alpha',
] as const

/** Probe date of the lists above. */
export const PROBE_DATE = '2026-10-10'

/** Re-probe after this date: free tiers churn. */
export const PROBE_STALE_AFTER = '2026-11-08'

/**
 * Free models that were serving on 2026-10-08 and returned 429 on 2026-10-10.
 *
 * Deliberately kept out of KNOWN_BAD_MODELS: a 429 is the free tier working as
 * designed, not a broken entry, and these ids come back within the hour. They
 * stay in OC_FREE_MODELS because they are still the strongest instruction
 * followers available at cost 0 — they just must not be the *only* option,
 * which is what DUO_MODEL_A_FALLBACKS exists for.
 */
export const RATE_LIMITED_MODELS: ReadonlyArray<readonly [string, string]> = [
  [
    'opencode/longcat-2.5-preview-free',
    '429 on 2026-10-10 — transient, retry later or rotate via DUO_MODEL_A_FALLBACKS',
  ],
]

/** Candidates that failed the probe, with their failure mode. */
export const KNOWN_BAD_MODELS: ReadonlyArray<readonly [string, string]> = [
  ['freemodel/*', '401 — requires an API key (`opencode auth`)'],
  ['orcarouter/orcarouter/free', '402 — quota exhausted'],
  ['tokenrouter/z-ai/glm-5.3-free', '503 — unavailable'],
  ['opencode/ling-3.0-flash-fin-free', '400 — invalid model'],
  // Listed in the catalog, absent on the endpoint. A 404 rather than a 429:
  // these ids were never valid, so neither retrying nor pacing can help.
  ['zenmux/anthropic/claude-sonnet-5-free', '404 — "Requested model is not valid"'],
  ['zenmux/moonshotai/kimi-k3-free', '404 — "Requested model is not valid"'],
  ['zenmux/stepfun/step-3.7-flash-free', '404 — "Requested model is not valid"'],
]

/**
 * `stealth/space-bunny-alpha` was announced to retire on 2026-10-05 but was
 * still serving at cost 0 on 2026-10-08 — treat it as volatile, not gone.
 */
export const CLINE_RETIREMENT_WARNING =
  'stealth/space-bunny-alpha was announced to retire on 2026-10-05 and was still working on 2026-10-08 — treat it as volatile'