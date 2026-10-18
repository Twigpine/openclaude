export const ANTHROPIC_BILLING_ATTRIBUTION_PREFIX =
  'x-anthropic-billing-header'

export type AnthropicAttributionRoute =
  | 'official_anthropic'
  | 'non_official'
  | 'unknown'

export type AnthropicAttributionAuth =
  | 'oauth_subscription'
  | 'api_key'
  | 'unknown'

export type AnthropicAttributionCredentialInput = {
  apiKey: 'external' | 'managed' | 'none'
  authToken: 'oauth' | 'api_key' | 'none'
  isSubscriber: boolean
}

export type AnthropicAttributionPolicyReason =
  | 'official_oauth_required'
  | 'official_api_key_enabled'
  | 'official_api_key_disabled'
  | 'official_auth_unknown_enabled'
  | 'official_auth_unknown_disabled'
  | 'non_official_route'
  | 'unknown_route'

export type AnthropicAttributionPolicy = {
  generate: boolean
  retain: boolean
  reason: AnthropicAttributionPolicyReason
}

export function resolveAnthropicAttributionAuth({
  apiKey,
  authToken,
  isSubscriber,
}: AnthropicAttributionCredentialInput): AnthropicAttributionAuth {
  if (apiKey === 'external' || authToken === 'api_key') return 'api_key'
  if (authToken === 'oauth' && isSubscriber) return 'oauth_subscription'
  if (apiKey === 'managed') return 'api_key'
  return 'unknown'
}

export function resolveAnthropicAttributionPolicy({
  route,
  auth,
  attributionEnabled,
}: {
  route: AnthropicAttributionRoute
  auth: AnthropicAttributionAuth
  attributionEnabled: boolean
}): AnthropicAttributionPolicy {
  if (route === 'unknown') {
    return { generate: false, retain: false, reason: 'unknown_route' }
  }
  if (route !== 'official_anthropic') {
    return { generate: false, retain: false, reason: 'non_official_route' }
  }

  if (auth === 'oauth_subscription') {
    return {
      generate: true,
      retain: true,
      reason: 'official_oauth_required',
    }
  }

  if (auth === 'api_key') {
    return attributionEnabled
      ? {
          generate: true,
          retain: true,
          reason: 'official_api_key_enabled',
        }
      : {
          generate: false,
          retain: false,
          reason: 'official_api_key_disabled',
        }
  }

  return attributionEnabled
    ? {
        generate: true,
        retain: true,
        reason: 'official_auth_unknown_enabled',
      }
    : {
        generate: false,
        retain: false,
        reason: 'official_auth_unknown_disabled',
      }
}

export function isAnthropicBillingAttributionBlock(
  text: string | undefined,
): boolean {
  return text?.startsWith(ANTHROPIC_BILLING_ATTRIBUTION_PREFIX) ?? false
}

type AttributionBlock = string | { type?: string; text?: string }

function getAttributionBlockText(block: AttributionBlock): string | undefined {
  if (typeof block === 'string') return block
  return block.type === undefined || block.type === 'text'
    ? block.text
    : undefined
}

export function applyAnthropicAttributionPolicy<T extends AttributionBlock>(
  blocks: readonly T[],
  policy: AnthropicAttributionPolicy,
): T[] {
  let retainedAttribution = false
  return blocks.filter(block => {
    if (!isAnthropicBillingAttributionBlock(getAttributionBlockText(block))) {
      return true
    }
    if (!policy.retain || retainedAttribution) return false
    retainedAttribution = true
    return true
  })
}

export function getAnthropicAttributionDiagnostic(
  policy: AnthropicAttributionPolicy,
): string | null {
  switch (policy.reason) {
    case 'unknown_route':
      return '[anthropic-attribution] disabled for an unresolved request route'
    case 'official_auth_unknown_enabled':
    case 'official_auth_unknown_disabled':
      return '[anthropic-attribution] preserved the configured setting for ambiguous official auth'
    default:
      return null
  }
}
