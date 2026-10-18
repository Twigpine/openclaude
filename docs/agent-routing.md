# Agent Routing and Step Limits

OpenClaude can route different agents to different models, and custom agents
can cap how many tool-use steps they may execute. Both features live in
settings and agent frontmatter — no code changes required.

## Agent step limits

Custom agents can define `maxSteps` as a positive integer to cap how many
tool-use steps a sub-agent may execute. When the limit is reached, OpenClaude
stops additional tool calls and asks the sub-agent for a concise final summary
covering completed work, findings, remaining tasks, and whether another run is
needed. Omitting `maxSteps`, or setting it to an invalid value such as `0` or
malformed input, preserves the default unlimited behavior.

```markdown
---
name: bounded-researcher
description: Use for focused research with bounded tool use
maxSteps: 8
---

You are a focused research agent.
```

## Agent routing

OpenClaude can route different agents to different models through
settings-based routing. This is useful for cost optimization or splitting work
by model strength.

Add to `~/.openclaude/settings.json`:

> **Note:** `api_key` values in `settings.json` are stored in plaintext. Keep this file private and do not commit it to version control.

```json
{
  "agentModels": {
    "deepseek-v4-flash": {
      "base_url": "https://api.deepseek.com/v1",
      "api_key": "sk-your-key"
    },
    "zai-default": {
      "model": "glm-5.2",
      "base_url": "https://api.z.ai/api/coding/paas/v4",
      "api_key": "sk-your-key"
    },
    "gpt-4o": {
      "base_url": "https://api.openai.com/v1",
      "api_key": "sk-your-key"
    }
  },
  "agentRouting": {
    "Explore": "deepseek-v4-flash",
    "Plan": "gpt-4o",
    "general-purpose": "gpt-4o",
    "frontend-dev": "zai-default",
    "default": "gpt-4o"
  }
}
```

When no routing match is found, the global provider remains the fallback.

`agentRouting` values and explicit Agent tool `model` overrides match keys in
`agentModels`. By default, that key is also the model string sent to the
provider. Set `agentModels.<key>.model` when you want a local route key such
as `zai-default` to call a different provider model name such as `glm-5.2`.

> **Note:** `/provider` changes the global/parent provider for your current
> session. `agentModels` and `agentRouting` are specifically for configuring
> per-agent provider overrides while keeping the parent session unchanged.

> **Note:** `api_key` values in `settings.json` are stored in plaintext. Keep
> this file private and do not commit it to version control.

**Model-only routes (same provider):** Omit `base_url` and `api_key` to run an
agent on a different model using your *current* provider's endpoint and key —
no credential duplication:

```json
{
  "agentModels": {
    "mini": { "model": "gpt-5-mini" }
  },
  "agentRouting": {
    "verification": "mini"
  }
}
```

**Built-in agents are routable by their type name.** Useful keys:
`verification` (the read-only auditor that runs before completion; **feature-gated**: requires `VERIFICATION_AGENT` and `tengu_hive_evidence` flag), `Explore`
and `Plan` (if feature-gated on), and `code-reviewer` (requires diff inline). For example, `"agentRouting": { "verification": "mini" }` runs the
verifier on `gpt-5-mini` while your main session stays on its model, but only when the verification gate is active. Absent
any entry, the verifier inherits the main-loop model.

## Sub-agent permission prompts

In an interactive session, an ordinary foreground or background Agent tool
sub-agent that reaches an unresolved tool permission request forwards it to
the main session. The user can approve or deny the request there, and the
sub-agent continues with that decision. Existing allow and deny rules are
still evaluated first. Background agents and their pending permission prompts
remain owned by the session that spawned them; switching sessions never moves
a prompt or approval into the newly active session. Unattended scheduled
commands remain fail-closed.

Non-interactive sessions remain fail-closed: unresolved requests are denied
unless a configured permission rule resolves them. You do not need to
enable `--dangerously-skip-permissions` for interactive sub-agent verification.

## GitHub Copilot sub-agent optimization

When `CLAUDE_CODE_USE_GITHUB=1`, OpenClaude serializes sub-agent execution to
reduce GitHub Copilot Premium Request consumption. Default behavior is
`GITHUB_COPILOT_MAX_SUBAGENTS=1` (synchronous, one sub-agent at a time).
Tuning vars (all optional):

| Var | Effect |
|---|---|
| `GITHUB_COPILOT_MAX_SUBAGENTS=0` | Suppress sub-agents entirely (sub-agents throw an error). |
| `GITHUB_COPILOT_MAX_SUBAGENTS=1` | Force synchronous execution. **Default.** |
| `GITHUB_COPILOT_MAX_SUBAGENTS=2..10` | Parsed/clamped but not enforced differently from `=1` (any positive cap = synchronous). |
| `GITHUB_COPILOT_ALLOW_SUBAGENTS=1` | Re-enable parallel/background sub-agents, overriding the cap. |
| `GITHUB_COPILOT_FORCE_SYNC_SUBAGENTS=1` | Force synchronous execution regardless of cap. |
| `GITHUB_COPILOT_OPTIMIZATION_DISABLED=1` | Disable all of the above; sub-agents run as before this feature. |

The `is_async` field reported in the `tengu_agent_tool_selected` event and the
agent metadata reflects the final execution mode (i.e., `false` when
synchronous is forced). See `.env.example` for the full descriptions.

For best results, use models with strong tool/function calling support.
