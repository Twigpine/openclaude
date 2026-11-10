# Local Usage Ledger

OpenClaude keeps a small local record of token usage so it can show usage for
any provider, including ones that do not offer a usage API. The record lives
on your machine only. Nothing is sent anywhere.

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
provider, source and project directory, and no per-request detail.

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
