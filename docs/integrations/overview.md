# Integrations Overview

## Purpose

This folder is the contributor-facing documentation set for the descriptor-era
integration system.

Use it for:

- terminology and architecture rules;
- authoring rules for descriptor files;
- how-to guides for vendors, gateways, models, anthropic proxies, and
  `/usage`;
- reference samples that match the current implementation.

## Documentation Structure

This is the current docs layout:

```text
docs/
  architecture/
    integrations.md
  integrations/
    overview.md
    glossary.md
    reasoning-effort.md
    how-to/
      add-vendor.md
      add-gateway.md
      add-model.md
      add-anthropic-proxy.md
      add-usage-support.md
    reference-samples.md
    common-pitfalls.md
```

All of the files listed above are part of the current contributor guide for the
descriptor-era integration system.

## Reading Order

If you are onboarding to the integration system:

1. Read `docs/architecture/integrations.md` for the system boundaries.
2. Read `docs/integrations/glossary.md` for the shared vocabulary.
3. Read `docs/integrations/reasoning-effort.md` before marking models as
   reasoning-capable or `/effort`-controllable.
4. Use the how-to guides for the specific descriptor type you are adding.
5. Use `docs/integrations/reference-samples.md` once the architecture and the relevant how-to guide are clear.
6. Read `docs/integrations/common-pitfalls.md` before opening a docs or implementation PR for a new integration.

## Core Rules

### Metadata vs routing vs transport

Keep these concerns separate:

- metadata
  Descriptor files declare labels, defaults, catalogs, setup requirements,
  validation hints, and request-shaping metadata.
- routing
  Route/profile helpers map user config, presets, and env state onto the active
  descriptor route.
- transport
  Runtime execution code actually performs the request using the active
  transport family.

If a change is about what a route is, it likely belongs in descriptors. If it
is about how a request is executed against an external API contract, it likely
belongs in transport code.

### `transportConfig.kind` is the routing contract

For gateways, `transportConfig.kind` is the field that tells runtime code which
transport family the route belongs to.

Examples:

- `'openai-compatible'`
- `'local'`
- `'anthropic-proxy'`
- `'bedrock'`
- `'vertex'`

Do not use gateway `category` for routing decisions. `category` is optional
display/grouping metadata only.

### `category` is descriptive, not executable

Gateway `category` exists to help people understand the route:

- `local`
- `hosted`
- `aggregating`

It is valid to use `category` for docs, grouping, or display copy. It is not
valid to treat `category` as the transport selector.

### OpenAI-compatible request shaping belongs in `openaiShim`

For OpenAI-compatible or local routes, keep request-shaping metadata in
`transportConfig.openaiShim`.

Examples:

- `maxTokensField`
- `headers`
- `supportsApiFormatSelection`
- `supportsAuthHeaders`

That matches the current runtime metadata flow in
`src/integrations/runtimeMetadata.ts`.

`supportsApiFormatSelection` and `supportsAuthHeaders` also control the
advanced `/provider add` and `/provider edit` fields for OpenAI-compatible
routes. Fixed direct vendors usually set both to `false`; broad custom routes
or gateways that intentionally accept user-supplied auth/header details set the
relevant flag to `true`.

OpenAI-compatible streaming chat-completions routes request a terminal usage
chunk with `stream_options: { include_usage: true }` by default. Network
location does not change that protocol behavior. If a server explicitly rejects
the top-level `stream_options` field, the shim retries once without it; user
cancellations and unrelated client errors are not retried. Known routes that
reject the field should still declare `removeBodyFields: ['stream_options']` in
their `transportConfig.openaiShim` so the first request is compatible. Native
transports such as direct Ollama build their own request payloads and are
unaffected.

### Reasoning support is per model and per route

`capabilities.supportsReasoning` is descriptive. It says the model is known to
reason or think, but it does not by itself authorize `/effort` to add request
fields. Only add `reasoning` metadata when the exact route/model request shape,
accepted levels, and disable behavior have been verified. See
`docs/integrations/reasoning-effort.md`.

### Moonshot and Kimi K3 catalogs

The direct Moonshot API exposes Kimi K3 as `kimi-k3`, with a 1,048,576-token
context window, 32,768 maximum output tokens, and `reasoning_effort` levels
`low`, `high`, and `max` (defaulting to `max`). Kimi Code K3 uses the same
controls for two catalog selections: `k3` provides the 1M Allegretto+ window, while
`k3-256k` keeps Moderato+ sessions within their 256K limit.

Kimi Code also lists `kimi-for-coding-highspeed` for eligible Allegretto+
subscriptions. [Kimi documents](https://www.kimi.com/code/docs/en/kimi-code/models.html)
it as HighSpeed with approximately 6× output speed and 3× quota usage; plan
availability can vary. Retain the selected catalog ID in client-side routing so
its route-specific limits and capabilities are not lost when the outbound API
model is normalized.

### Public aggregator model discovery

OpenRouter and Twigpine Opengateway use public model-list endpoints to keep their
hybrid catalogs current. Listing models does not require credentials, but chat
and other inference requests still require the provider's API key. OpenRouter
refreshes stale discovery data in the background. Opengateway refreshes once at
startup and uses that request instead of a separate readiness probe.

## Descriptor Authoring Pattern

Normal descriptor files should:

- use the `define*` helpers from `src/integrations/define.ts`;
- default-export the descriptor object or model list;
- keep registration out of the descriptor file;
- keep route-owned catalogs with the route unless shared model metadata is
  genuinely useful;
- put built-in model limits and capabilities in `src/integrations/models/`,
  not in env-override compatibility helpers.

Typical helper usage:

- `defineVendor`
- `defineGateway`
- `defineCatalog`
- `defineModel`
- `defineBrand`
- `defineAnthropicProxy`

Normal descriptor files should not:

- call `registerGateway`, `registerVendor`, `registerModel`, or similar
  registry functions directly;
- import registry mutation helpers just to make a descriptor visible;
- turn simple route additions into scattered consumer edits.

## Loader-Owned Registration

Registration is owned by `src/integrations/index.ts`.

That means the normal contributor workflow is:

1. create or edit the descriptor file;
2. keep the export typed through the appropriate `define*` helper;
3. let the loader own registration;
4. let registry consumers read the loaded descriptor state.

The loader may still be manually enumerated in some places today, but that is a
generated-artifact concern, not a descriptor-file concern.

Normal contributor flow for new preset-participating routes is:

1. add or edit the descriptor file;
2. add `preset` metadata only when the route should be user-facing;
3. add `preset.badge` metadata if the route should show a display tag (e.g.
   `[FREE]`, `[Sponsor]`) in the preset picker — this avoids
   hard-coded badge logic in `src/components/ProviderManager.tsx`;
4. run `bun run integrations:generate`;
5. let the generated manifest feed the loader, compatibility mapping, preset
   typing, and provider UI metadata.

## Compatibility Layer

The descriptor system is the source of truth, but a compatibility layer still
exists for older env/config/public-callers.

Important compatibility surfaces include:

- `src/integrations/compatibility.ts`
  derived legacy preset name to descriptor-route mapping;
- `src/integrations/profileResolver.ts`
  stored provider/profile id resolution;
- `src/utils/model/providers.ts`
  `APIProvider` / `LegacyAPIProvider`;
- `src/utils/providerFlag.ts`
  env-facing `--provider` behavior.

Contributor docs should describe these as compatibility bridges, not as the
primary architecture.

Preset ordering pins `gitlawb-opengateway` first, derives the middle entries from preset
descriptions with standard alphanumeric sorting, and pins the custom presets
last: `custom` followed by `custom-anthropic`.
