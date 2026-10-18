# Reasoning and /effort Metadata

OpenClaude treats reasoning support as a per-model capability. Provider and gateway catalogs can contain a mix of reasoning and non-reasoning models, so reasoning controls must never be inferred provider-wide.

## Concepts

`capabilities.supportsReasoning` means the model is known to support reasoning or thinking behavior. It is safe capability metadata, but by itself it does not authorize OpenClaude to mutate API requests.

`reasoning` describes the request control surface OpenClaude can safely use for that exact model entry or model descriptor.

```ts
reasoning: {
  mode: 'levels' | 'toggle' | 'always-on'
  // Any supported subset for this exact model, for example ['high', 'xhigh'].
  levels?: ReasoningEffortLevel[]
  defaultLevel?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  wireFormat?:
    | 'reasoning_effort'
    | 'deepseek_compatible'
    | 'zai_compatible'
    | 'none'
  disableFormat?: 'thinking_type_disabled'
}
```

## Backward Compatibility

The `/effort` resolver is intentionally conservative:

1. Explicit per-model `reasoning` metadata wins.
2. Existing hardcoded legacy effort support remains unchanged.
3. `supportsReasoning: true` without `reasoning` metadata is treated as reasoning-capable but not controllable.
4. Truly unknown models do not receive new reasoning request fields.

This means existing OpenAI, Codex, Claude, Gemini, and configured 3P override behavior remains active, while catalogs can safely mark models with `supportsReasoning` before their exact request shape has been audited.

A temporary compatibility layer also preserves verified request shaping that existed before per-model `reasoning` metadata. For example, DeepSeek-compatible routes can still map `/effort xhigh` to provider `reasoning_effort: "max"`, and Z.AI GLM routes can still map supported controls through their `thinking` request shape. Those compatibility rules also cover matching uncataloged DeepSeek/Z.AI route traffic, so the unknown-model rule only applies after explicit metadata and compatibility resolution both fail. These rules are intentionally centralized in the effort resolver so they can be removed as catalogs gain explicit `reasoning` metadata.

## Provider and Gateway Rules

Annotate reasoning per exact model on the route where it was verified. Aggregating gateways must not add reasoning controls at the provider level because different upstream models accept different parameters and levels.

Prefer catalog-entry metadata when a gateway route differs from the canonical model descriptor. For example, a model may support reasoning directly from its vendor but reject `reasoning_effort` through a gateway.

Use `mode: 'always-on'` with `wireFormat: 'none'` for models that emit reasoning but do not have a verified control parameter on that route.

Currently wired metadata formats are `reasoning_effort`, `deepseek_compatible`, and `zai_compatible`. The descriptor type also reserves `reasoning_object` and `thinking_type`, but those formats are not request-plumbed yet and should not be used to enable `/effort`.

For `deepseek_compatible`, metadata levels must be limited to `high` and/or `xhigh`. The serializer emits provider `high` for OpenClaude `high` and provider `max` for OpenClaude `xhigh`; it cannot represent `low`, `medium`, or standard `max` as distinct levels.

For `zai_compatible`, exact route/model entries may expose verified `low`, `high`, and `xhigh` levels. These serialize as provider `low`, `high`, and `max`, respectively. `medium` is not a distinct GLM-5.3-Flash level, and standard OpenClaude `max` is not added as another picker level. Disabling thinking must be verified separately; low effort is not equivalent to no reasoning.

## Adding Support

Before adding `reasoning` metadata for a model:

1. Probe the exact route and model ID OpenClaude will send.
2. Record accepted levels and rejected levels.
3. Check whether disabling thinking is supported and what request shape is required.
4. Confirm whether accepted parameters actually change behavior or are silent no-ops.
5. Add focused tests for the resolver and request serialization path.

Do not use `supportsReasoning: true` alone as evidence that `reasoning_effort` or any other effort field is accepted.
