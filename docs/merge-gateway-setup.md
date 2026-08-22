# Merge Gateway setup

OpenClaude connects to [Merge Gateway](https://gateway.merge.dev) through its OpenAI-compatible endpoint at `https://api-gateway.merge.dev/v1/openai`. The route supports Merge's multi-provider model catalog and routing policies with a dedicated `MERGE_GATEWAY_API_KEY`.

## Guided setup

1. Create an API key in the [Merge Gateway dashboard](https://gateway.merge.dev/api-keys).
2. Start OpenClaude and run `/provider`.
3. Choose **Add provider**, then **Merge Gateway**.
4. Paste the API key when prompted.
5. Choose a discovered model, or select **Default routing policy** to let the policy attached to the key choose the provider and model.
6. Choose **Chat Completions** or **Responses** for the API format supported by the selected model and route.

The model picker keeps a cached catalog for one day and can be refreshed manually. If discovery is temporarily unavailable, the routing-policy and GPT-5.5 fallback entries remain selectable.

## CLI setup

```bash
export MERGE_GATEWAY_API_KEY="your-api-key"
openclaude --provider merge-gateway --model openai/gpt-5.5
```

To delegate model selection to a Merge Gateway routing policy:

```bash
openclaude --provider merge-gateway --model default_routing
```

The dedicated Merge credential is not replaced by `OPENAI_API_KEY`.

## Verify

Inside OpenClaude:

1. Run `/status` and confirm the active provider is **Merge Gateway** and the base URL is `https://api-gateway.merge.dev/v1/openai`.
2. Run `/model`, refresh the catalog, and confirm Merge Gateway models appear.
3. Send a short prompt and confirm the request appears in the [Gateway dashboard](https://gateway.merge.dev).

For direct catalog troubleshooting, use the authenticated public model endpoint:

```bash
curl --fail --silent --show-error \
  -H "Authorization: Bearer $MERGE_GATEWAY_API_KEY" \
  "https://api-gateway.merge.dev/v1/models?limit=5"
```

Never commit the API key or paste it into issue or pull-request text.
