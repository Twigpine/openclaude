import { isClaudeAISubscriber } from '../../utils/auth.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { getActiveProviderProfile } from '../../utils/providerProfiles.js'
import {
  getUsageDescriptor,
  type ResolvedUsageDescriptor,
  resolveActiveUsageId,
} from './index.js'

/** Provider plan-limit screens that `/usage` can show. */
export type ProviderUsageScreen = 'codex' | 'minimax' | 'clinepass' | 'anthropic'

export type UsageTab = 'Local' | 'Plan'

/** The active provider's usage descriptor (label and support). */
export function getActiveUsageDescriptor(): ResolvedUsageDescriptor {
  const activeProfile = getActiveProviderProfile()
  return getUsageDescriptor(
    resolveActiveUsageId(process.env, {
      activeProfileProvider: activeProfile?.provider,
      activeProfileBaseUrl: activeProfile?.baseUrl,
      providerCategory: getAPIProvider(),
    }),
  )
}

/** Which provider plan-limit screen applies to the active provider, if any. */
export function resolveProviderUsageScreen(
  provider: string = getAPIProvider(),
  descriptor: Pick<ResolvedUsageDescriptor, 'resolvedId' | 'supported'> =
    getActiveUsageDescriptor(),
): ProviderUsageScreen | null {
  if (provider === 'codex') return 'codex'
  if (!descriptor.supported) return null
  switch (descriptor.resolvedId) {
    case 'minimax':
      return 'minimax'
    case 'clinepass':
      return 'clinepass'
    case 'anthropic':
      return 'anthropic'
    default:
      return null
  }
}

/**
 * True when the Plan tab has limits to show. Anthropic plan limits exist only
 * for Claude.ai subscriptions, not API keys.
 */
export function hasProviderPlanUsage(
  screen: ProviderUsageScreen | null = resolveProviderUsageScreen(),
  isSubscriber: () => boolean = isClaudeAISubscriber,
): boolean {
  if (screen === null) return false
  return screen !== 'anthropic' || isSubscriber()
}

/**
 * The tab `/usage` opens on: Local for `/usage local` or when the provider
 * has no plan limits to show, otherwise Plan.
 */
export function resolveInitialUsageTab(
  args: string,
  hasPlan: boolean,
): UsageTab {
  if (!hasPlan) return 'Local'
  return args.trim().toLowerCase() === 'local' ? 'Local' : 'Plan'
}
