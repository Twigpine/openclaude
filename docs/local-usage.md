# Local Usage Ledger

OpenClaude keeps a small local record of token usage so it can show usage for
any provider, including ones that do not offer a usage API. The record lives
on your machine only. Nothing is sent anywhere.

## Viewing your usage

Run `/usage`. The **Local** tab shows usage from this record for every
provider:

- total tokens, requests, sessions and the share served from prompt cache
- a chart by hour (today) or by day (7d, 30d, all)
- usage per model and provider, with an estimated cost
- how usage splits across your conversation, subagents, compaction and
  background helpers, and across projects

Press `r` to switch between this session, today, the last 7 days, the last 30
days and all time. Today is compared with your average day over the previous
week, and 7d and 30d with the period before them, once that much history
exists.

Cost is shown only for models with a known price: built-in Claude prices or
your `modelPricing` setting. Other models show `—`, and models served from
your own machine show `local`.

When your provider reports plan limits (Claude.ai subscriptions, Codex,
MiniMax, ClinePass), `/usage` opens on the **Plan** tab instead. Use `←`/`→`
to switch tabs, or run `/usage local` to open the Local tab directly.

## What is recorded

One line per billed model request, written when the request finishes:

```json
{"v":1,"id":"15ed7ece4b91","ts":1762682400000,"session":"…","project":"/path/to/project",
 "model":"qwen/qwen3.8-max","route":"gitlawb-opengateway","source":"repl_main_thread",
 "input":1768,"output":206,"cacheRead":0,"cacheWrite":0,"webSearch":0}
```

| Field | Meaning |
|---|---|
| `ts` | When the request finished (epoch milliseconds) |
| `session`, `project` | The session id and the directory OpenClaude was started in |
| `model`, `route` | The model id and the provider route that served it (an id such as `openrouter`, never the URL) |
| `source` | What made the request: the conversation, a subagent, compaction, or a background helper |
| `input`, `output`, `cacheRead`, `cacheWrite`, `webSearch` | Counts reported by the provider |
| `local` | The endpoint is on this machine or a private network |
| `noCache` | The provider does not report prompt-cache use |
| `unreported` | The provider returned no token counts |

Prompts, responses, file contents, base URLs and API keys are never recorded.
Cost is not stored either; it is estimated when displayed, and only for models
with a known price (built-in Claude prices or your `modelPricing` setting).

Requests from the main conversation, subagents, compaction, side queries (for
example auto-mode checks and session search) and advisor calls are all
recorded. API-key checks and token-count probes are not.

## Where it lives

```text
~/.openclaude/usage/
├── events/2026-11-09.jsonl   one file per local day, one line per request
└── rollups/2026-11.json      daily totals per model, provider, source and project
```

Files are created with owner-only permissions. Several OpenClaude processes
can write at the same time; appends are serialized with a file lock.

## Retention

Event files follow `cleanupPeriodDays` (default 30). Before a day's file is
deleted, its totals are saved to the monthly rollup file, so long-range totals
survive while the per-request lines expire.

Rollup files are not deleted automatically. They hold daily totals per model,
provider, source and project directory, and no per-request detail. If a rollup
file cannot be read (for example it is corrupt or was written by a newer
OpenClaude) and its days' event files are already gone, `/usage` names the
months whose totals may be incomplete.

## Turning it off

The ledger follows the same switch as session transcripts. Nothing is written
to disk when any of these apply:

- `cleanupPeriodDays` is `0` in settings
- `--no-session-persistence` (print mode)
- `CLAUDE_CODE_SKIP_PROMPT_HISTORY` is set

With `cleanupPeriodDays` set to `0`, cleanup also deletes event files left from
earlier days without saving their totals. Rollup files written before the
setting changed are kept. Under the other two switches, cleanup leaves expired
event files in place until a later run can save their totals.

To remove all usage history, including rollups, delete `~/.openclaude/usage/`.
