import { getTransportKindForRoute } from '../../integrations/routeMetadata.js'

/** Filter ordinary suggestions only; explicit saved/custom model IDs stay valid. */
export function isCurrentMiniMaxModelOption(
  model: unknown,
  routeId?: string | null,
  localEndpoint = false,
): boolean {
  if (model === null) return true
  // Persisted bootstrap options reach this boundary without normalization.
  if (typeof model !== 'string') return false
  const name = model.trim().toLowerCase().split('/').at(-1)!.split('?', 1)[0]!
  if (!/^(minimax-(?:m\d|text-|\d)|abab\d)/.test(name)) return true
  // Independently hosted servers own their installed/discovered model names.
  if (localEndpoint || (routeId && getTransportKindForRoute(routeId) === 'local')) return true
  // Retired Zen "-free" IDs remain raw metadata for explicit saved selections.
  return /^(minimax-m3(?:\.1-flash)?)(?::free)?$/.test(name)
}
