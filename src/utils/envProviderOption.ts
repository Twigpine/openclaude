import { redactUrlForDisplay } from './redaction.js'
import {
  resolveRouteCredentialValue,
  resolveRouteIdFromBaseUrl,
} from '../integrations/routeMetadata.js'

/**
 * Derivation for the "use current environment configuration" onboarding
 * option (ConsoleOAuthFlow), extracted as a pure seam so the
 * secret-disclosure boundary is regression-tested directly rather than
 * asserted against component source text.
 *
 * The split between `baseUrl` and `displayBaseUrl` is load-bearing:
 * OPENAI_BASE_URL / OPENAI_API_BASE are credential-bearing in the wild
 * (userinfo like https://user:pass@host/v1, or ?token=/?api_key= query
 * params). Anything rendered lands in terminal scrollback, so ONLY
 * `displayBaseUrl` may reach the UI; `baseUrl` keeps the working URL for
 * profile creation/activation.
 */
export type EnvProviderOption = {
  /** True when the route has the endpoint, model, and required env credential. */
  available: boolean
  /** The env var the base URL actually came from, for accurate troubleshooting. */
  varName: 'OPENAI_BASE_URL' | 'OPENAI_API_BASE'
  /** Raw endpoint — for profile persistence/activation only, never rendered. */
  baseUrl: string | undefined
  /** Route-owned credential — for profile persistence only, never rendered. */
  apiKey: string | undefined
  /** Redacted endpoint — the only form safe to render. */
  displayBaseUrl: string | undefined
  model: string | undefined
}

export function getEnvProviderOption(
  processEnv: NodeJS.ProcessEnv = process.env,
): EnvProviderOption {
  const baseUrl = processEnv.OPENAI_BASE_URL ?? processEnv.OPENAI_API_BASE
  const model = processEnv.OPENAI_MODEL
  const routeId =
    resolveRouteIdFromBaseUrl(baseUrl) ?? (baseUrl ? 'custom' : null)
  const apiKey = routeId
    ? resolveRouteCredentialValue({ routeId, baseUrl, processEnv })
    : undefined
  return {
    available: Boolean(
      baseUrl && model && (routeId !== 'commandcode' || apiKey),
    ),
    varName: processEnv.OPENAI_BASE_URL ? 'OPENAI_BASE_URL' : 'OPENAI_API_BASE',
    baseUrl,
    apiKey,
    displayBaseUrl: baseUrl ? redactUrlForDisplay(baseUrl) : baseUrl,
    model,
  }
}
