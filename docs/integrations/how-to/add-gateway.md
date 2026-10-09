# How To Add a Gateway

## When to add a gateway

Add a gateway descriptor when the route hosts, proxies, or aggregates models
behind its own endpoint contract.

Typical gateway cases:

- a hosted OpenAI-compatible route with its own base URL and auth;
- a local route such as Ollama or LM Studio;
- an aggregating route that mixes third-party brands/models;
- a route that needs discovery metadata, discovery caching, or readiness
  probing.

## Step-by-step

1. Choose the file layout.
   Use `src/integrations/gateways/<id>.ts` for the descriptor. Add
   `src/integrations/gateways/<id>.models.ts` only when the catalog/discovery
   details are large enough to deserve a companion file.
2. Pick the transport family.
   `transportConfig.kind` is the routing contract.
3. Pick a `category`.
   `category` is optional grouping/display metadata only. It must not drive
   runtime routing.
4. Define setup and startup metadata.
   Gateways often need readiness or auto-detection hints in `startup`.
5. Choose the catalog strategy.
   Use `static`, `dynamic`, or `hybrid`.
6. Decide whether the gateway needs discovery cache TTL, refresh mode, and
   manual refresh.
7. For OpenAI-compatible or local routes, add any required static headers,
   decide whether users may edit API mode and header-related settings through
   `transportConfig.openaiShim.supportsApiFormatSelection` and
   `transportConfig.openaiShim.supportsAuthHeaders`, and use
   `transportConfig.openaiShim.ui.show*` flags to choose which auth-header,
   auth-value, or custom-header prompts appear for tighter built-in preset
   flows.
8. If the gateway should appear in preset-driven `/provider` flows, add a
   `preset` block on the descriptor.
9. Run `bun run integrations:generate` so the generated loader and preset
   manifest stay in sync.

## Authoring rules

Normal gateway examples should:

- use `defineGateway` and `defineCatalog`;
- default-export the gateway descriptor;
- default-export the catalog from any companion `*.models.ts` file;
- avoid `registerGateway(...)` in contributor-authored examples;
- avoid removed legacy fields such as `targetVendorId`,
  `isOpenAICompatible`, or routing-oriented gateway `classification`.

The routing decision belongs to `transportConfig.kind`, not to `category`.

## Reasoning controls in mixed catalogs

Gateway catalogs often mix models with different reasoning APIs. Keep
`capabilities.supportsReasoning` as descriptive capability metadata unless
the exact gateway route and model ID have been probed.

Add `/effort`-controllable `reasoning` metadata per catalog entry, not at the
gateway level. If a gateway accepts one upstream model's `reasoning_effort`
but rejects another model's field, each entry must say so explicitly. See
`docs/integrations/reasoning-effort.md` before adding or changing reasoning
controls.

## Generated loader and preset manifest

Normal gateway onboarding is additive now:

1. add or edit the descriptor file;
2. add a `preset` block only if the route should be user-facing in preset
   flows;
3. run `bun run integrations:generate`;
4. let `src/integrations/generated/integrationArtifacts.generated.ts` feed the
   loader, compatibility mapping, preset typing, and provider UI metadata.

Preset ordering is not configured manually. The generated manifest pins
`anthropic` first, sorts the remaining preset-participating routes by preset
description using standard alphanumeric sorting, and always pins `custom` to
the bottom automatically.

For gateway presets, set `preset.vendorId` so compatibility/profile helpers
know which vendor contract the gateway belongs to.

## One-file example: hosted gateway with only first-party models

This is the simplest hosted OpenAI-compatible gateway pattern.

```ts
import { defineCatalog, defineGateway } from '../define.js'

const catalog = defineCatalog({
  source: 'static',
  models: [
    {
      id: 'acme-hosted-fast',
      apiName: 'acme-hosted-fast',
      label: 'Acme Hosted Fast',
      modelDescriptorId: 'acme-hosted-fast',
    },
    {
      id: 'acme-hosted-pro',
      apiName: 'acme-hosted-pro',
      label: 'Acme Hosted Pro',
      modelDescriptorId: 'acme-hosted-pro',
      capabilities: {
        supportsReasoning: true,
      },
      notes: 'Practical input limit is lower than the full context window.',
    },
  ],
})

export default defineGateway({
  id: 'acme-hosted',
  label: 'Acme Hosted',
  category: 'hosted',
  defaultBaseUrl: 'https://gateway.acme.example/v1',
  defaultModel: 'acme-hosted-fast',
  supportsModelRouting: true,
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: ['ACME_HOSTED_API_KEY'],
  },
  transportConfig: {
    kind: 'openai-compatible',
    openaiShim: {
      headers: {
        'X-Acme-Client': 'openclaude',
      },
      supportsApiFormatSelection: false,
      supportsAuthHeaders: true,
      ui: {
        showAuthHeader: false,
        showAuthHeaderValue: false,
        showCustomHeaders: true,
      },
      // Optional: use a non-Authorization default auth header.
      defaultAuthHeader: { name: 'api-key', scheme: 'raw' },
      // Optional: restrict Responses API mode to model ids with these prefixes.
      responsesApiModelPrefixes: ['gpt-'],
      maxTokensField: 'max_completion_tokens',
    },
  },
  preset: {
    id: 'acme-hosted',
    description: 'Acme Hosted gateway',
    vendorId: 'openai',
    apiKeyEnvVars: ['ACME_HOSTED_API_KEY'],
  },
  catalog,
  usage: {
    supported: false,
  },
})
```

What this example covers:

- one-file descriptor authoring;
- hosted OpenAI-compatible routing;
- required static custom headers;
- API mode editing disabled for a fixed hosted gateway;
- route-owned auth with only regular custom-header prompts shown in the preset UI;
- route-owned default auth header and Responses API model-prefix rules;
- a static catalog;
- a gateway with only its own hosted models;
- different reasoning/context/input/output behavior across models;
- route defaults declared once through `defaultModel`.

## Transport family examples

### Hosted OpenAI-compatible gateway

Use `transportConfig.kind: 'openai-compatible'` when the route speaks an
OpenAI-compatible request/response contract.

```ts
transportConfig: {
  kind: 'openai-compatible',
  openaiShim: {
    supportsApiFormatSelection: false,
    supportsAuthHeaders: false,
  },
}
```

### Local gateway

Use `transportConfig.kind: 'local'` for routes such as Ollama or LM Studio.

```ts
transportConfig: {
  kind: 'local',
  openaiShim: {
    supportsApiFormatSelection: false,
    supportsAuthHeaders: true,
    maxTokensField: 'max_tokens',
  },
}
```

### Anthropic-proxy transport family

If you truly have a gateway-shaped route that accepts Anthropic-native traffic,
the routing contract still comes from `transportConfig.kind`.

```ts
transportConfig: {
  kind: 'anthropic-proxy',
}
```

In most cases, a real Anthropic-native third-party route should eventually be
documented through the dedicated anthropic-proxy guide. The key
point here is that the transport family belongs in `transportConfig.kind`, not
in a gateway-specific compatibility flag.

## Local dynamic discovery example

This is the common local gateway shape.

```ts
import { defineGateway } from '../define.js'

export default defineGateway({
  id: 'acme-local',
  label: 'Acme Local',
  category: 'local',
  defaultBaseUrl: 'http://localhost:11434/v1',
  defaultModel: 'acme-local:latest',
  supportsModelRouting: true,
  setup: {
    requiresAuth: false,
    authMode: 'none',
  },
  startup: {
    autoDetectable: true,
    probeReadiness: 'openai-compatible-models',
  },
  transportConfig: {
    kind: 'local',
    openaiShim: {
      supportsApiFormatSelection: false,
      supportsAuthHeaders: true,
      maxTokensField: 'max_tokens',
    },
  },
  catalog: {
    source: 'dynamic',
    discovery: {
      kind: 'openai-compatible',
      // Set requiresAuth: false when /models is public even if inference needs auth.
      requiresAuth: false,
    },
    discoveryCacheTtl: '1d',
    discoveryRefreshMode: 'startup',
    allowManualRefresh: true,
  },
  usage: {
    supported: false,
  },
})
```

What this example covers:

- `transportConfig.kind: 'local'`;
- `catalog.source: 'dynamic'`;
- a local readiness/discovery flow;
- `max_tokens` for a local/legacy-compatible token field;
- a `startup` refresh mode example.

## Two-file example: hybrid gateway with discovery cache

Use a companion `*.models.ts` file when the catalog or discovery rules are too
large to keep inline.

`src/integrations/gateways/galaxy.models.ts`

```ts
import { defineCatalog } from '../define.js'

export default defineCatalog({
  source: 'hybrid',
  discovery: {
    kind: 'openai-compatible',
  },
  discoveryCacheTtl: '1h',
  discoveryRefreshMode: 'background-if-stale',
  allowManualRefresh: true,
  models: [
    {
      id: 'galaxy-curated-default',
      apiName: 'galaxy/gpt-5-mini',
      label: 'GPT-5 Mini (via Galaxy)',
      modelDescriptorId: 'gpt-5-mini',
    },
    {
      id: 'galaxy-curated-reasoner',
      apiName: 'galaxy/deepseek-r1',
      label: 'DeepSeek R1 (via Galaxy)',
      modelDescriptorId: 'deepseek-reasoner',
      capabilities: {
        supportsReasoning: true,
      },
      notes: 'Practical input limit is 192k tokens on this route.',
      transportOverrides: {
        openaiShim: {
          preserveReasoningContent: true,
          requireReasoningContentOnAssistantMessages: true,
          reasoningContentFallback: '',
        },
      },
    },
  ],
})
```

`src/integrations/gateways/galaxy.ts`

```ts
import { defineGateway } from '../define.js'
import catalog from './galaxy.models.js'

export default defineGateway({
  id: 'galaxy',
  label: 'Galaxy Gateway',
  category: 'aggregating',
  defaultBaseUrl: 'https://api.galaxy.example/v1',
  defaultModel: 'galaxy/gpt-5-mini',
  supportsModelRouting: true,
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: ['GALAXY_API_KEY'],
  },
  startup: {
    probeReadiness: 'openai-compatible-models',
  },
  transportConfig: {
    kind: 'openai-compatible',
    openaiShim: {
      supportsApiFormatSelection: false,
      supportsAuthHeaders: true,
      maxTokensField: 'max_completion_tokens',
    },
  },
  catalog,
  usage: {
    supported: false,
  },
})
```

What this example covers:

- a two-file gateway pattern;
- `catalog.source: 'hybrid'`;
- human-readable discovery cache TTL;
- `background-if-stale` refresh;
- manual refresh enabled;
- stale cache fallback by design through the shared discovery cache service;
- a mixed catalog of hosted third-party models;
- different reasoning/context/input/output behavior across entries.

Because `allowManualRefresh` is enabled, this is the right pattern for routes
that should support `/model refresh` and in-picker refresh. The shared
discovery cache keeps curated entries visible while refreshes fail or become
stale.

## `providerModelMap` in mixed gateway catalogs

If the gateway exposes a shared model under a route-specific API name, point
the gateway catalog entry at a shared model descriptor and use that model
descriptor's `providerModelMap` to record route-specific names.

Minimal pattern:

```ts
import { defineModel } from '../define.js'

export default [
  defineModel({
    id: 'deepseek-reasoner',
    label: 'DeepSeek Reasoner',
    vendorId: 'deepseek',
    classification: ['chat', 'reasoning'],
    defaultModel: 'deepseek-reasoner',
    providerModelMap: {
      galaxy: 'galaxy/deepseek-r1',
      openrouter: 'deepseek/deepseek-r1',
    },
    capabilities: {
      supportsReasoning: true,
    },
  }),
]
```

The gateway still owns route availability. `providerModelMap` only helps shared
model metadata stay reusable across multiple routes.

## Static vs dynamic vs hybrid

Use:

- `static`
  when discovery is unavailable or unnecessary;
- `dynamic`
  when the route should rely entirely on runtime discovery;
- `hybrid`
  when you need curated entries plus discovered models.

Typical choices:

- `static`
  stable hosted routes with a small fixed catalog;
- `dynamic`
  local routes or provider catalogs that change frequently;
- `hybrid`
  aggregators where curated defaults should stay visible even while discovery
  fills in the rest.

## Discovery cache TTL examples

Use human-readable TTLs in `discoveryCacheTtl`:

- `30m`
  fast-changing catalogs where freshness matters;
- `1h`
  moderately active hosted routes;
- `1d`
  stable hosted or local routes where churn is low.

## Discovery refresh mode examples

Use `discoveryRefreshMode` to match the operational shape of the route:

- `manual`
  flaky or rate-limited providers where refresh should happen only on demand;
- `on-open`
  routes where the picker should always try for a fresh list;
- `background-if-stale`
  the normal hosted-gateway choice when cached models should appear immediately;
- `startup`
  fast local routes where startup probing is cheap and useful.

If an authenticated inference route exposes a public model endpoint, set
`catalog.discovery.requiresAuth` to `false` while keeping `setup.requiresAuth`
enabled. OpenRouter and Twigpine Opengateway use this split: model listing is
keyless, but inference still requires an API key. Avoid combining
`discoveryRefreshMode: 'startup'` with an `openai-compatible-models` readiness
probe when both execute the same request, because that doubles startup traffic.

## `max_tokens` vs `max_completion_tokens`

OpenAI-compatible APIs do not all accept the same max-token field.

Use `openaiShim.maxTokensField: 'max_tokens'` when:

- the route is local or legacy-shaped;
- the provider rejects `max_completion_tokens`;
- the provider is Z.AI-style or otherwise strict about the older field;
- the route matches Moonshot/DeepSeek/local compatibility behavior.

Use `openaiShim.maxTokensField: 'max_completion_tokens'` when:

- the route expects the newer OpenAI/Azure-style contract;
- the provider rejects `max_tokens`;
- you want the route to stay aligned with newer hosted OpenAI-compatible APIs.

Strict-route example:

```ts
transportConfig: {
  kind: 'openai-compatible',
  openaiShim: {
    supportsApiFormatSelection: false,
    supportsAuthHeaders: false,
    maxTokensField: 'max_tokens',
  },
}
```

Hosted modern-route example:

```ts
transportConfig: {
  kind: 'openai-compatible',
  openaiShim: {
    supportsApiFormatSelection: false,
    supportsAuthHeaders: false,
    maxTokensField: 'max_completion_tokens',
  },
}
```

## Custom headers

For OpenAI-compatible or local routes, required static headers belong in
`transportConfig.openaiShim.headers`.

Optional user-editable API mode, auth header, auth-value, and custom-header
fields should be allowed only when the route really supports them:

```ts
transportConfig: {
  kind: 'openai-compatible',
  openaiShim: {
    headers: {
      'X-Acme-Client': 'openclaude',
    },
    supportsApiFormatSelection: false,
    supportsAuthHeaders: true,
    ui: {
      showAuthHeader: false,
      showAuthHeaderValue: false,
      showCustomHeaders: true,
    },
  },
}
```

Do not use custom headers as a substitute for transport-family selection.
Set these flags explicitly. `supportsAuthHeaders` enables header customization
in general, including auth header prompts and arbitrary custom headers.
When it is false, `/provider add` and `/provider edit` should only expose the
route's normal credential fields. When it is true, the
`openaiShim.ui.showAuthHeader`, `showAuthHeaderValue`, and
`showCustomHeaders` flags decide which header-related prompts are visible.
When `supportsApiFormatSelection` is false, `/provider add` and
`/provider edit` should not expose the API mode picker.

Use:

- `supportsApiFormatSelection: true`
  for broad custom gateways where users may need to choose the API surface.
- `supportsApiFormatSelection: false`
  for fixed hosted or local routes where the descriptor owns the API contract.
- `supportsAuthHeaders: true`
  for gateways that support any user-configurable header behavior, including
  auth header names, auth header values, or arbitrary custom headers.
- `supportsAuthHeaders: false`
  for gateways that require a fixed auth contract and should only collect the
  configured credential.
- `ui.showAuthHeader: false`
  when the route has descriptor-owned auth and the preset flow should not ask
  users for an auth header name. Pair this with `defaultAuthHeader` when the
  descriptor should route the collected API key to a nonstandard auth header.
- `ui.showAuthHeaderValue: false`
  when the preset flow should collect only the header name and reuse the API key
  as the header value.
- `ui.showCustomHeaders: false`
  when the route supports gateway header behavior but the built-in preset should
  not expose arbitrary extra headers.

## Presets and user-facing gateway onboarding

Most runtime/UI surfaces now consume generated descriptor-backed metadata, so a
normal gateway addition should not require broad switch editing.

Only add `preset` metadata when the gateway is supposed to appear as a preset
or explicit selectable route.

```ts
preset: {
  id: 'acme-hosted',
  description: 'Acme Hosted gateway',
  vendorId: 'openai',
  apiKeyEnvVars: ['ACME_HOSTED_API_KEY'],
}
```

Then regenerate:

```bash
bun run integrations:generate
```

That keeps `src/integrations/index.ts`, `src/integrations/compatibility.ts`,
`src/integrations/providerUiMetadata.ts`, and the generated preset-id type in
sync without hand-editing them.

## What not to do

Avoid these patterns:

- `registerGateway(...)` in the descriptor file;
- `targetVendorId`, `isOpenAICompatible`, or routing-oriented gateway
  `classification`;
- using `category` to make runtime routing decisions;
- placing large discovery/cached-catalog logic inline when a companion
  `*.models.ts` file would be clearer;
- treating every gateway as if it exposes every shared model.

## Verification checklist

Before calling the gateway guide complete:

- the descriptor lives under `src/integrations/gateways/`;
- one-file and two-file patterns are both covered where useful;
- the gateway declares only the model subset it actually offers;
- the route default is declared once through `defaultModel`;
- `transportConfig.kind` is the routing contract;
- `category` is treated as grouping/display metadata only;
- any discovery route includes the right cache TTL, refresh mode, and manual
  refresh behavior;
- API mode, auth/header, and token-field behavior are explicit where required;
- user-facing preset participation is expressed through descriptor `preset`
  metadata and regenerated artifacts rather than handwritten follow-through.
