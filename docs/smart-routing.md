# Smart auto-routing

Smart routing is an opt-in mode that classifies each user turn as **simple** or **strong** and sends it to your configured **simple** or **strong** model accordingly, so trivial turns ("ok", "rename this", "what does this do?") can go to a cheaper model while the strong model handles everything non-trivial. Whether the simple role is actually cheaper depends on how your provider bills it. OpenClaude routes to the role you set and does not verify your provider's pricing.

It is **off by default** and **experimental** — the classifier is a fast heuristic (prompt length, code blocks, reasoning/planning keywords, first turn of a session), not a perfect judge. When in doubt it routes to the strong model, so the failure mode is "no savings on a turn that could have been cheap," never a silently degraded answer on a turn you cared about.

Smart routing is provider-agnostic: it swaps the model within your current provider. It works against any backend where you have both a cheaper and a stronger model configured. It does not read your provider's, gateway's, or account's pricing, so any savings or cost estimates it shows are based on a first-party reference table and may not match what you are actually billed.

## Setup

Both roles point at `agentModels` keys (or bare model ids). For example, in `~/.openclaude.json`:

```json
{
  "agentModels": {
    "mini": { "model": "gpt-5-mini" },
    "main": { "model": "gpt-5" }
  },
  "smartRouting": {
    "enabled": true,
    "simpleModel": "mini",
    "strongModel": "main"
  }
}
```

Optional tuning fields: `simpleMaxChars` and `simpleMaxWords` raise or lower the size threshold for "simple".

## The `/smartroute` command

| Command | Effect |
| --- | --- |
| `/smartroute` | Show status (enabled/disabled, the two roles, available `agentModels` keys). |
| `/smartroute on` | Enable (requires both roles set). |
| `/smartroute off` | Disable. |
| `/smartroute simple <key>` | Set the simple-turn model to an `agentModels` key. |
| `/smartroute strong <key>` | Set the strong-turn model. |

When you set roles, the command warns if the simple model is not actually priced below the strong model (for models with known first-party pricing).

## Environment variables

These set a startup default. An explicit `smartRouting` block in settings always overrides them.

| Variable | Meaning |
| --- | --- |
| `OPENCLAUDE_SMART_ROUTING` | `1` or `true` enables routing at startup. |
| `OPENCLAUDE_SMART_ROUTING_SIMPLE` | `agentModels` key or model id for simple turns. |
| `OPENCLAUDE_SMART_ROUTING_STRONG` | `agentModels` key or model id for strong turns. |

## Behavior notes

- **One decision per turn.** The model is chosen once when your message arrives and held for the whole turn (including its tool calls), so it does not flap mid-turn.
- **Sub-agents are not routed.** A sub-agent's prompt is not a user turn, so smart routing leaves its model alone: it uses its [`agentRouting`](agent-routing.md) route or agent-definition model, and otherwise inherits the turn's model. Default internal forks (such as `/btw` and SDK side questions) inherit the parent's accepted provider request selection, including explicit reasoning settings, across tool-list refreshes. The implicit Agent-tool fork supplies its own model options and does not inherit this request selection. After an active provider switch, including one during compaction or following automatic recovery, ambient forks use the new provider's configured model; explicit provider overrides remain fixed. Side questions without a saved parent request use the configured model selection; allowed explicit agent, hook, and skill model choices take precedence. These explicit choices still obey `availableModels`; inherited/default choices retain their existing policy. Sub-agent runs are not counted in the `/cost` routing summary.
- **Upgrade note.** Explicit agent-definition, inline-skill, or hook models excluded by `availableModels` are rejected. If a configuration previously relied on such a choice, select an allowed model or have the administrator update the allowlist.
- **Fallback.** If a simple-routed turn's model call errors (transport or server error), it retries once on the strong model. Aborts and auth/permission/bad-request errors are not retried.
- **Model limits still apply.** Inherited request aliases and reasoning settings do not replace the concrete model used for context limits, session context-window overrides, or compaction.
- **Allowlist.** Any model smart routing selects is checked against your org model allowlist (`availableModels`). A disallowed model is coerced to strong; if strong is also disallowed, routing disables itself for the session and the default model is used. Running `/smartroute on` re-enables routing and clears that session disable.
- **Same-provider only.** Roles must be model-only `agentModels` entries (or bare model ids). If a role resolves to a cross-provider entry (one with `base_url`/`api_key`), routing silently disables — cross-provider routing is not supported yet.
- **Auditing.** `/cost` shows a routing summary: how many turns went simple vs strong, how many escalated to strong via fallback, and an estimated savings line when both models appear in the first-party reference pricing table. That estimate is reference pricing only and may not reflect what your provider/gateway/account actually bills.
