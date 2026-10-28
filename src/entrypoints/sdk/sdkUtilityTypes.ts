/**
 * SDK utility types that can't be expressed as Zod schemas (see coreTypes.ts).
 *
 * Type-only module — it must stay runtime-inert because it is imported by
 * both SDK type surfaces (sdk/coreTypes.ts) and runtime modules
 * (services/api/logging.ts, services/api/emptyUsage.ts).
 */

import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

/**
 * API usage with counters made required and non-null.
 *
 * The Anthropic API types most usage fields as `T | null`; internally the
 * CLI zero-initializes them (see EMPTY_USAGE in services/api/emptyUsage.ts)
 * so accumulation code doesn't have to null-check on every add. Fallback-credit
 * metadata stays nullable because absence is distinct from a redemption outcome.
 */
export type NonNullableUsage = {
  [K in keyof Omit<Usage, 'fallback_credit'>]: NonNullable<Usage[K]>
} & Pick<Usage, 'fallback_credit'>
