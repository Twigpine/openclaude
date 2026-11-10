import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

import { calculateKnownUSDCost } from '../../utils/modelCost.js'
import type { UsageRollupRow } from './types.js'

/**
 * Estimated USD cost of a rollup row, or null when the model has no known
 * price. Local endpoints are priced too when the user configured a price,
 * since a localhost URL can be a proxy to a paid provider.
 */
export function estimateUsageRowCostUSD(row: UsageRollupRow): number | null {
  const usage = {
    input_tokens: row.input,
    output_tokens: row.output,
    cache_read_input_tokens: row.cacheRead,
    cache_creation_input_tokens: row.cacheWrite,
    server_tool_use: { web_search_requests: row.webSearch },
    ...(row.fast && { speed: 'fast' }),
  } as Usage
  return calculateKnownUSDCost(row.model, usage) ?? null
}
