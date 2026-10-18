# How To Add a Model

## When to add a model descriptor

Add a shared model descriptor when the metadata is useful across more than one
route or when the model deserves a stable glossary/index entry of its own.

Good reasons to add a model descriptor:

- the model appears across multiple vendor or gateway catalogs;
- the model has stable capabilities, context, or output limits worth reusing;
- route-specific catalogs should be able to reference one shared model id;
- you want `providerModelMap` to document route-specific API names for the same
  conceptual model.

Do add or update a shared model descriptor when the model's context window,
output limit, or capabilities need to be available to runtime model lookup. Do
not use model descriptors as route availability lists. Route-owned catalogs are
still the source of truth for where a model is offered.

## Step-by-step

1. Pick the model file.
   Use an existing family file under `src/integrations/models/` when the model
   belongs to a current family such as `gpt`, `claude`, or `deepseek`.
2. Decide whether the model also needs a brand descriptor.
   Add or update a brand descriptor only when shared model-family identity is
   useful across multiple model descriptors.
3. Add the `defineModel(...)` entry.
   Include `id`, `label`, `vendorId`, `classification`, `defaultModel`, and
   capabilities.
4. Add optional shared metadata.
   Include `brandId`, `contextWindow`, `maxOutputTokens`, and `cacheConfig`
   when the data is stable enough to be reused. Set
   `runtimeMetadataScope: 'catalog'` when verified limits and capabilities
   should apply only on route catalogs that explicitly reference the
   descriptor.
5. Add `providerModelMap` only when the same model needs route-specific API
   names across multiple catalogs.
6. Update route-owned catalogs only if the model should be offered by those
   routes.

## Authoring rules

Model descriptor files should:

- use `defineModel`;
- default-export model descriptors, typically as an array for a family file;
- act as glossary/index metadata and optional route enrichment;
- avoid encoding gateway availability as if every route automatically exposes
  the shared model.

Shared runtime metadata uses the legacy global model-name fallback by default.
Use `runtimeMetadataScope: 'catalog'` for a model whose verified limits and
capabilities belong to specific routes; that metadata then applies only when a
route catalog entry names the descriptor through `modelDescriptorId`.

Normal contributor-facing examples should not call `registerModel(...)`
directly.

## Shared model descriptors vs route catalogs

The important boundary is:

- shared model descriptors answer what the model is;
- route-owned catalogs answer where the model is offered.

That is why gateway or direct-vendor onboarding should not normally require
editing multiple shared model files. In the common path:

- add or update the route descriptor/catalog first;
- add a shared model descriptor only if the metadata is reusable beyond that
  one route;
- let the route catalog continue to own the offered subset.

## Reasoning and `/effort` metadata

Use `classification: ['reasoning']` and `capabilities.supportsReasoning` to
describe that a model is known to reason or think. Those fields do not by
themselves enable `/effort` request mutation.

Only add `reasoning` metadata when the model's exact control surface has been
verified for the route that will call it, including accepted levels, rejected
levels, and any thinking-disable format. For the full checklist, see
`docs/integrations/reasoning-effort.md`.

## When to add a brand descriptor

Add or update a brand descriptor when:

- multiple related models share a recognizable family identity;
- shared defaults or capability guidance are useful across that family;
- the docs/UI benefit from grouping those models under one brand.

Skip the brand descriptor when:

- the model is one-off or route-local;
- the shared family metadata would not actually be reused;
- the route catalog is enough on its own.

## Example: model attached to a canonical vendor only

This is the simplest pattern: one model, one canonical vendor, no shared
route-name aliases needed.

```ts
import { defineModel } from '../define.js'

export default [
  defineModel({
    id: 'acme-chat',
    label: 'Acme Chat',
    vendorId: 'acme',
    classification: ['chat', 'coding'],
    defaultModel: 'acme-chat',
    capabilities: {
      supportsStreaming: true,
      supportsFunctionCalling: true,
      supportsJsonMode: true,
      supportsReasoning: false,
    },
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
  }),
]
```

Use this when:

- the model belongs to one canonical vendor;
- the route does not need multiple route-specific API names recorded in the
  shared model metadata;
- the descriptor is mainly reusable metadata, not a route-availability table.

## Example: shared model across multiple routes with `providerModelMap`

Use `providerModelMap` when the same conceptual model appears on multiple
routes under different API names.

```ts
import { defineModel } from '../define.js'

export default [
  defineModel({
    id: 'deepseek-reasoner',
    label: 'DeepSeek Reasoner',
    brandId: 'deepseek',
    vendorId: 'deepseek',
    classification: ['chat', 'reasoning', 'coding'],
    defaultModel: 'deepseek-reasoner',
    providerModelMap: {
      deepseek: 'deepseek-reasoner',
      openrouter: 'deepseek/deepseek-r1',
      galaxy: 'galaxy/deepseek-r1',
    },
    capabilities: {
      supportsStreaming: true,
      supportsFunctionCalling: true,
      supportsJsonMode: true,
      supportsReasoning: true,
    },
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
  }),
]
```

What `providerModelMap` is for:

- recording route-specific API names for the same model;
- helping route catalogs reference one shared descriptor while still using the
  route's real API name;
- keeping shared metadata reusable across direct vendors and gateways.

What `providerModelMap` is not for:

- declaring route availability by itself;
- replacing the route-owned catalog;
- assuming every route in the map is automatically enabled.

## Model lookup and fallback behavior

Model lookup should prefer:

1. route-owned catalog metadata;
2. shared model-descriptor enrichment when a catalog entry references
   `modelDescriptorId`;
3. global shared model descriptors under `src/integrations/models/` for legacy
   and custom OpenAI-compatible model names;
4. documented user overrides from `src/utils/model/openaiContextWindows.ts` —
   the `CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS` / `CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS`
   env vars and the `modelLimits` map in `settings.json` (see the
   `modelLimits` section in `docs/advanced-setup.md` for key matching and
   precedence).

`openaiContextWindows.ts` is compatibility glue for user-provided overrides
(env vars and the `settings.json` `modelLimits` map). It should not grow a
second built-in model table. Built-in model limits belong in model descriptor
files.

A descriptor with `runtimeMetadataScope: 'catalog'` is intentionally excluded
from global name-only lookups. Its limits and capabilities are available only
through an explicit route catalog entry, preventing one vendor's verified
contract from leaking onto an uncataloged gateway model with the same API name.

## What not to do

Avoid these patterns:

- turning shared model files into the default place to list every route's
  offered subset;
- assuming a shared model descriptor means every gateway supports it;
- using `providerModelMap` as a substitute for route catalogs;
- adding a brand descriptor when no shared family metadata is actually useful;
- calling `registerModel(...)` from contributor-authored examples.
- adding built-in model limits to `src/utils/model/openaiContextWindows.ts`
  instead of `src/integrations/models/`.

## Verification checklist

Before calling a model doc update complete:

- the example uses `defineModel`;
- the example makes clear that shared model descriptors are glossary/index
  metadata plus optional route enrichment;
- `providerModelMap` is shown only as a route-name mapping tool;
- the doc explains when a brand descriptor is useful;
- the doc explains that global lookup reads `src/integrations/models/`, while
  `src/utils/model/openaiContextWindows.ts` only preserves env overrides;
- the doc explains why normal gateway/direct-vendor onboarding should not
  require editing multiple shared model files.
