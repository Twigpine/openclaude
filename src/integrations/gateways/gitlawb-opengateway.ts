import { defineGateway } from '../define.js'
import type { ModelCatalogEntry } from '../descriptors.js'
import {
  firstPositiveNumber,
  getTrimmedString,
  isFreeModel,
  isKnownNonCodingModelId,
  isRecord,
} from '../modelMapping.js'

/**
 * Normalizes OpenGateway model IDs by removing the `xiaomi/` prefix when the
 * remainder starts with `mimo` (the gateway exposes some Xiaomi models both
 * with and without the vendor prefix; we keep the shorter form for the catalog).
 */
function normalizeOpenGatewayModelId(id: string): string {
  return id.replace(/^xiaomi\/(?=mimo(?:-|$))/i, '')
}

/**
 * Map OpenGateway's public GET /v1/models payload into a catalog entry.
 * The gateway already curates what it exposes, so every non-empty id is kept
 * except retired routes (`?status=all` adds them with `status: "retired"`)
 * and clearly non-coding names if they ever appear.
 */
export function mapOpenGatewayModel(raw: unknown): ModelCatalogEntry | null {
  if (!isRecord(raw)) {
    return null
  }

  if (getTrimmedString(raw, 'status')?.toLowerCase() === 'retired') {
    return null
  }

  const rawId = getTrimmedString(raw, 'id')
  if (!rawId || isKnownNonCodingModelId(rawId)) {
    return null
  }
  const id = normalizeOpenGatewayModelId(rawId)

  const name =
    getTrimmedString(raw, 'name') ||
    getTrimmedString(raw, 'display_name') ||
    getTrimmedString(raw, 'title')
  const free = isFreeModel(id, raw)
  let label = name || id
  if (free && !label.toLowerCase().includes('free')) {
    label = `${label} (free)`
  }

  const contextWindow = firstPositiveNumber(
    raw.context_window,
    raw.contextWindow,
    raw.context_length,
    raw.max_context_length,
  )

  return {
    id,
    apiName: id,
    label,
    ...(contextWindow ? { contextWindow } : {}),
    ...(free ? { notes: 'Free' } : {}),
  }
}

export default defineGateway({
  id: 'gitlawb-opengateway',
  label: 'Twigpine OpenGateway',
  category: 'aggregating',
  defaultBaseUrl: 'https://api.twigpine.com/v1',
  // Smart routing is the default: a key with no credits is routed to a free
  // model instead of failing with 402 on a paid one.
  defaultModel: 'auto',
  supportsModelRouting: true,
  vendorId: 'openai',
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: ['OPENGATEWAY_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
  },
  validation: {
    kind: 'credential-env',
    // OPENGATEWAY_API_KEY first so users who set both don't get their generic
    // OpenAI key sent to opengateway by accident. OPENAI_API_KEYS / OPENAI_API_KEY kept as
    // fallbacks because existing openclaude configs may already hold generic credentials there.
    credentialEnvVars: ['OPENGATEWAY_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    missingCredentialMessage:
      'OPENGATEWAY_API_KEY is required to use Twigpine OpenGateway.\n' +
      'Mint an API key at https://twigpine.com/console/gateway/keys and set it as OPENGATEWAY_API_KEY (or OPENAI_API_KEYS / OPENAI_API_KEY when OPENAI_BASE_URL points at the gateway).',
    routing: {
      // api.twigpine.com is the public address; the legacy hosts still serve
      // older clients and saved profiles.
      matchBaseUrlHosts: ['api.twigpine.com', 'opengateway.gitlawb.com', 'opengateway.fly.dev'],
    },
  },
  transportConfig: {
    kind: 'openai-compatible',
    openaiShim: {
      // Opengateway expects `Authorization: Bearer ogw_live_...`. Previous
      // `api-key` raw header was a leftover from the direct-Xiaomi era.
      headers: {
        'Accept-Encoding': 'identity',
      },
      defaultAuthHeader: {
        name: 'authorization',
        scheme: 'bearer',
      },
      maxTokensField: 'max_completion_tokens',
      removeBodyFields: ['store', 'stream_options'],
      supportsApiFormatSelection: false,
      supportsAuthHeaders: false,
    },
  },
  preset: {
    id: 'gitlawb-opengateway',
    description: 'Twigpine OpenGateway - (API key required, signup at https://twigpine.com/console/gateway/keys)',
    apiKeyEnvVars: ['OPENGATEWAY_API_KEY'],
    label: 'Twigpine OpenGateway',
    name: 'Twigpine OpenGateway',
    badge: {
      text: 'Recommended',
      color: 'success',
    },
    vendorId: 'openai',
    modelEnvVars: ['OPENAI_MODEL'],
    baseUrlEnvVars: ['OPENGATEWAY_BASE_URL', 'OPENAI_BASE_URL'],
    fallbackBaseUrl: 'https://api.twigpine.com/v1',
    fallbackModel: 'auto',
  },
  catalog: {
    // The live GET /v1/models list (active models only) is the source of
    // truth for the picker; the gateway retires routes server-side, so no
    // curated copy of its catalog is kept here. The few entries below are
    // the offline floor: they are what the picker shows when discovery has
    // never succeeded, and they name routes the live list also carries, so
    // the matching live rows dedupe against them by apiName and every other
    // live route is appended. `hybrid` is the source that allows a floor
    // (`dynamic` may not declare models); keep it to models the gateway is
    // not about to retire.
    source: 'hybrid',
    discovery: {
      kind: 'openai-compatible',
      // Public model list works without a key (chat still requires auth).
      requiresAuth: false,
      mapModel: mapOpenGatewayModel,
    },
    // The gateway adds and retires routes within a day, and its list is
    // public and small, so cache it for an hour: a new launch picks up
    // lineup changes the same hour instead of the next day.
    discoveryCacheTtl: '1h',
    discoveryRefreshMode: 'startup',
    allowManualRefresh: true,
    models: [
      // Virtual model: the gateway's smart router picks the cheapest model
      // expected to handle the request and escalates on upstream failure
      // (see opengateway/src/routing/). Billed at the serving model's rate;
      // the x-gateway-served-model response header names who answered.
      // The gateway lists `auto` with `context_window: null`, so pin a window
      // here: 200k sits under the smallest model the router can pick
      // (204,800), and the gateway skips models a request does not fit.
      {
        id: 'opengateway-auto',
        apiName: 'auto',
        label: 'Auto — Smart Routing (via OpenGateway)',
        contextWindow: 200_000,
        notes: 'Gateway picks the cheapest capable model and escalates on failure',
      },
      // The gateway accepts bare MiMo ids and lists them as `xiaomi/mimo-*`;
      // mapOpenGatewayModel strips the prefix so the live rows dedupe here.
      // No shared mimo-v2.6 model descriptor exists yet, so the context
      // window the gateway advertises is pinned on the entry.
      {
        id: 'opengateway-mimo-v2.6-pro',
        apiName: 'mimo-v2.6-pro',
        label: 'MiMo V2.6 Pro (via OpenGateway)',
        contextWindow: 262_144,
      },
      {
        id: 'opengateway-mimo-v2.6-flash',
        apiName: 'mimo-v2.6-flash',
        label: 'MiMo V2.6 Flash (via OpenGateway)',
        contextWindow: 262_144,
      },
    ],
  },
  usage: { supported: false },
})
