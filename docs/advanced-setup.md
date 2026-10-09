# OpenClaude Advanced Setup

This guide is for users who want source builds, Bun workflows, provider profiles, diagnostics, or more control over runtime behavior.

## Install Options

OpenClaude requires Node.js `>=22.0.0` for npm installs and runtime. Bun is
only required when building or running from source.

### Option A: npm

```bash
npm install -g @gitlawb/openclaude@latest
```

### Option B: From source with Bun

Use Bun `1.3.13` or newer for source builds. Older Bun versions can fail during `bun run build`.

```bash
git clone https://github.com/Twigpine/openclaude.git
cd openclaude

bun install
bun run build
npm link
```

### Option C: Run directly with Bun

```bash
git clone https://github.com/Twigpine/openclaude.git
cd openclaude

bun install
bun run dev
```

## Provider Examples

### OpenAI

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-4o
```

### Codex via ChatGPT auth

`codexplan` maps to GPT-5.6 Sol on the Codex backend with high reasoning.
`codexspark` maps to GPT-5.3 Codex Spark for faster loops.

If you use the in-app provider wizard, choose `Codex OAuth` to open ChatGPT sign-in in your browser and let OpenClaude store Codex credentials securely.

If you already use the Codex CLI, OpenClaude reads `~/.codex/auth.json` automatically. You can also point it elsewhere with `CODEX_AUTH_JSON_PATH` or override the token directly with `CODEX_API_KEY`.

If you set `CODEX_API_KEY` manually and are not relying on `auth.json` or stored
Codex OAuth credentials, also set `CHATGPT_ACCOUNT_ID` (or
`CODEX_ACCOUNT_ID`).

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_MODEL=codexplan

# optional if you do not already have ~/.codex/auth.json
export CODEX_API_KEY=...
export CHATGPT_ACCOUNT_ID=...

openclaude
```

### DeepSeek

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.deepseek.com/v1
export OPENAI_MODEL=deepseek-v4-flash
```

Use `deepseek-v4-pro` when you want the stronger model. `deepseek-chat` and `deepseek-reasoner` remain available as DeepSeek's legacy API aliases.

### Google Gemini

```bash
export CLAUDE_CODE_USE_GEMINI=1
export GEMINI_API_KEY=...
export GEMINI_MODEL=gemini-3-flash-preview
```

### Claude on Vertex AI

The Vertex route uses Anthropic's Claude-on-Vertex API. It is not a general
Vertex AI Model Garden adapter for Gemini or arbitrary partner models; use the
Gemini provider for Gemini models and OpenAI-compatible routes for compatible
third-party gateways.

Authentication uses Google Application Default Credentials through
`google-auth-library`. There is no `OPENAI_API_KEY`-style API key for this
route. **For global npm installs, install the auth package on demand** (it is
not bundled by default — see [Optional provider packages](#optional-provider-packages)):

```bash
npm i -g google-auth-library
```

Authenticate with either local Application Default Credentials (ADC) or a
service-account key file:

```bash
# Option 1 — local ADC (interactive, uses your own Google account):
gcloud auth application-default login

# Option 2 — service-account key file (headless / CI):
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

Minimal setup:

```bash
export CLAUDE_CODE_USE_VERTEX=1
export ANTHROPIC_VERTEX_PROJECT_ID=my-gcp-project
export GOOGLE_CLOUD_PROJECT=my-gcp-project
export CLOUD_ML_REGION=us-east5

openclaude --model claude-sonnet-4-6
```

`CLOUD_ML_REGION` is optional and defaults to `us-east5`. Model-specific
Vertex region override variables are also supported for Claude models; see
`src/utils/envUtils.ts` for the current override names.

### Gemini via OpenRouter

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=sk-or-...
export OPENAI_BASE_URL=https://openrouter.ai/api/v1
export OPENAI_MODEL=google/gemini-2.5-pro
```

OpenRouter model availability changes over time. If a model stops working, try another current OpenRouter model before assuming the integration is broken.

### Ollama

```bash
ollama pull llama3.3:70b

export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_BASE_URL=http://localhost:11434/v1
export OPENAI_MODEL=llama3.3:70b
```

#### Ollama Context Length

OpenClaude sends the current conversation history to Ollama on each turn and
uses Ollama's native chat API for Ollama endpoints. Native chat lets OpenClaude
send `options.num_ctx` with each request, so Ollama receives a 32768-token
context window by default instead of falling back to the smaller context often
used by Ollama's OpenAI-compatible `/v1/chat/completions` shim.

To choose a different request-level context size, set
`OPENCLAUDE_OLLAMA_NUM_CTX` before launching OpenClaude:

```bash
export OPENCLAUDE_OLLAMA_NUM_CTX=65536
```

You can also start Ollama with a global context length:

macOS / Linux:

```bash
# Stop any existing Ollama app/server first, then run:
OLLAMA_CONTEXT_LENGTH=32768 ollama serve
```

Windows PowerShell:

```powershell
# Quit any existing Ollama app/server first, then run:
$env:OLLAMA_CONTEXT_LENGTH="32768"
ollama serve
```

After a chat request, verify the loaded model is using the requested context:

```bash
ollama ps
```

Check the `CONTEXT` column. If it still shows a small value such as `4K` after a
new OpenClaude request, stop the existing Ollama app/server, start it again, and
retry the request.

Use a concrete recall test after changing the setting, such as asking the model
to repeat the first topic from the current chat. Questions like "do you remember our
conversation?" can trigger generic local-model disclaimers even when history is
present.

### Atomic Chat (local, Apple Silicon)

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_BASE_URL=http://127.0.0.1:1337/v1
export OPENAI_MODEL=your-model-name
```

No API key is needed for Atomic Chat local models.

Or use the profile launcher:

```bash
bun run dev:atomic-chat
```

Download Atomic Chat from [atomic.chat](https://atomic.chat/). The app must be running with a model loaded before launching.

### LM Studio

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_BASE_URL=http://localhost:1234/v1
export OPENAI_MODEL=your-model-name
```

### Together AI

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=...
export OPENAI_BASE_URL=https://api.together.xyz/v1
export OPENAI_MODEL=meta-llama/Llama-3.3-70B-Instruct-Turbo
```

### Groq

```bash
export CLAUDE_CODE_USE_OPENAI=1
export GROQ_API_KEY=gsk_...
export OPENAI_BASE_URL=https://api.groq.com/openai/v1
export OPENAI_MODEL=llama-3.3-70b-versatile
```

`GROQ_API_KEY` matches the built-in Groq gateway preset. `OPENAI_API_KEY` also works as a fallback on the generic OpenAI-compatible path, but `GROQ_API_KEY` is the preferred variable for Groq-specific setup.

### OpenCode Zen (pay-as-you-go)

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENCODE_API_KEY=...
export OPENAI_BASE_URL=https://opencode.ai/zen/v1
export OPENAI_MODEL=gpt-5.4

openclaude
```

OpenCode Zen is a pay-as-you-go AI gateway with 48 models (GPT, Claude, Gemini,
Qwen, MiniMax, GLM, Kimi, Grok, Big Pickle, DeepSeek, Nemotron). Uses the same
`OPENCODE_API_KEY` as OpenCode Go. Get your key from https://opencode.ai.

### OpenCode Go (subscription)

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENCODE_API_KEY=...
export OPENAI_BASE_URL=https://opencode.ai/zen/go/v1
export OPENAI_MODEL=glm-5.1

openclaude
```

OpenCode Go is a $10/mo subscription for 13 open models (GLM, Kimi, DeepSeek,
MiMo, MiniMax, Qwen). Uses the same `OPENCODE_API_KEY` as OpenCode Zen.
OpenClaude automatically sends the session and product identity headers that
OpenCode Go requires for prompt caching and traffic attribution.

### Twigpine Opengateway

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_BASE_URL=https://opengateway.gitlawb.com/v1
export OPENGATEWAY_API_KEY=ogw_live_...
export OPENAI_MODEL=mimo-v2.5-pro
```

The Opengateway route is the fresh-install startup default and requires an API
key from https://gitlawb.com/opengateway/keys. Keep the base URL at `/v1` and
switch models with `/model` or `OPENAI_MODEL`. Current partner models include:

- `mimo-v2.5-pro`
- `google/gemini-3.1-flash-lite-preview`

### Xiaomi MiMo

```bash
export CLAUDE_CODE_USE_OPENAI=1
export MIMO_API_KEY=...
export OPENAI_BASE_URL=https://api.xiaomimimo.com/v1
export OPENAI_MODEL=mimo-v2.5-pro
```

The `/provider` Xiaomi MiMo preset uses the same endpoint and stores the key as `MIMO_API_KEY`. `OPENAI_API_KEY` also works as a compatibility fallback, but `MIMO_API_KEY` keeps the profile tied to the MiMo route.

### NEAR AI

```bash
export CLAUDE_CODE_USE_OPENAI=1
export NEARAI_API_KEY=...
export OPENAI_BASE_URL=https://cloud-api.near.ai/v1
export OPENAI_MODEL=anthropic/claude-sonnet-4-6

openclaude
```

NEAR AI is a unified OpenAI-compatible gateway that proxies Anthropic, OpenAI,
and Google models alongside TEE-hosted open models (GLM 5.1, Qwen3.5, Kimi K2.6).
All models are accessible from a single endpoint with one API key.
Get your key from https://cloud.near.ai/dashboard/organizations.

Model IDs use `provider/model-name` format (e.g. `anthropic/claude-opus-4-7`,
`openai/gpt-5.5`, `google/gemini-3.5-flash`, `zai-org/GLM-5.1-FP8`).

For direct TEE completions (lower latency, verifiable privacy):

```bash
export OPENAI_BASE_URL=https://qwen35-122b.completions.near.ai/v1
```

### Cloudflare Workers AI

```bash
export CLAUDE_CODE_USE_OPENAI=1
export CLOUDFLARE_API_TOKEN=...
export OPENAI_BASE_URL=https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1
export OPENAI_MODEL=@cf/meta/llama-3.3-70b-instruct-fp8-fast
```

Replace `<ACCOUNT_ID>` with your Cloudflare account id (visible in the Cloudflare dashboard URL). `OPENAI_API_KEY` also works as a compatibility fallback, but `CLOUDFLARE_API_TOKEN` keeps the profile tied to the Cloudflare preset. The `/provider` Cloudflare Workers AI preset stores the token under `CLOUDFLARE_API_TOKEN`.

### Mistral

```bash
export CLAUDE_CODE_USE_MISTRAL=1
export MISTRAL_API_KEY=...
export MISTRAL_MODEL=devstral-latest
```

### Azure OpenAI

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=your-azure-key
export OPENAI_BASE_URL=https://your-resource.openai.azure.com/openai/deployments/your-deployment/v1
export OPENAI_MODEL=gpt-4o
```

### Microsoft Foundry / Azure OpenAI (resource URL + deployment)

When your endpoint is the **resource base URL** (not the full `.../deployments/.../v1` path), set `OPENAI_MODEL` to the **deployment name** and `AZURE_OPENAI_API_VERSION` to your API version. The OpenAI shim builds:

`{base}/openai/deployments/{OPENAI_MODEL}/chat/completions?api-version={AZURE_OPENAI_API_VERSION}`

and sends the key in the `api-key` header for Azure hosts.

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=your-azure-key
export OPENAI_BASE_URL=https://your-resource.openai.azure.com
export OPENAI_MODEL=your-deployment-name
export AZURE_OPENAI_API_VERSION=2024-12-01-preview
```

If your hostname is not detected as Azure (for example some inference endpoints), force Azure URL and header behavior:

```bash
export OPENAI_AZURE_STYLE=1
```

### Fireworks AI

Fireworks AI provides a fully OpenAI-compatible endpoint. Model IDs use the full path format `accounts/fireworks/models/<model-name>`.

```bash
export CLAUDE_CODE_USE_OPENAI=1
export FIREWORKS_API_KEY=fw_your_key_here
export OPENAI_BASE_URL=https://api.fireworks.ai/inference/v1
export OPENAI_MODEL=accounts/fireworks/models/llama-v3p1-70b-instruct
```

The **OpenClaude VS Code extension** can store the key in Secret Storage and set these variables for you when you launch from the Control Center. See `vscode-extension/openclaude-vscode/README.md`.

## Optional provider packages

To keep the default `npm i -g @gitlawb/openclaude` install small and
warning-free, a few provider SDKs and the native image library are **not
bundled**. They are loaded on demand, and the CLI prints an `npm install <pkg>`
hint (add `-g` for the global CLI) if you enable a feature whose package is
missing. Install only what you need:

**Image handling note:** default global installs do **not** ship `sharp`. Clipboard paste, drag-and-drop of a local image path, and FileReadTool paths that decode a local file need `npm i -g sharp`. Forwarding an already-encoded image URL/base64 that the API accepts without local decode (passthrough) does not. This opt-in is intentional for published installs; it is not an accidental omission.

| Feature | Trigger | Install |
| --- | --- | --- |
| AWS Bedrock | `CLAUDE_CODE_USE_BEDROCK=1` | `npm i -g @anthropic-ai/bedrock-sdk`. Profile-based auth (`~/.aws/credentials`) additionally needs `@aws-sdk/credential-providers` and `@aws-sdk/client-sts`; model listing needs `@aws-sdk/client-bedrock`. Proxy and skip-auth setups may also need `@aws-sdk/credential-provider-node`, `@smithy/node-http-handler`, or `@smithy/core`. The CLI prints the exact missing package if you hit one. |
| Azure Foundry | `CLAUDE_CODE_USE_FOUNDRY=1` | `npm i -g @anthropic-ai/foundry-sdk @azure/identity` |
| Claude on Vertex AI / Gemini ADC | `CLAUDE_CODE_USE_VERTEX=1` / Gemini ADC auth | `npm i -g google-auth-library` |
| Reading/processing images (clipboard paste, drag-and-drop paths, FileReadTool local decode) | local image decode — **not** pre-encoded URL/base64 passthrough | `npm i -g sharp` (intentionally opt-in; prebuilt releases load it externally only when processing requires it) |
| Optional error reporting | `SENTRY_DSN` is set | `npm i -g @sentry/node`. Without this package installed, setting `SENTRY_DSN` has no effect and reporting is silently disabled. |

When installing OpenClaude from source (`bun install`), all of these are
already present as dev dependencies, so source/dev builds need no extra steps.

## Node.js heap size

The installed CLI relaunches Node with `--max-old-space-size=8192` unless a heap
limit is already present in `NODE_OPTIONS` or `process.execArgv`. That fixed cap
is too large for small containers and too small for high-RAM workstations.

To size the V8 old-space heap as a percentage of available memory (cgroup or OS
constraint when Node reports a real byte cap, otherwise total system RAM), pass
the percentage through the OpenClaude launcher. OpenClaude converts
`--max-old-space-size-percentage` and
`OPENCLAUDE_NODE_MAX_OLD_SPACE_SIZE_PERCENTAGE` to an explicit
`--max-old-space-size` in megabytes so the same command works on every supported
Node version, including `22.0.0`:

```bash
openclaude --max-old-space-size-percentage=50
openclaude --max-old-space-size-percentage=75
```

Heap size precedence, earlier wins:

1. `--max-memory=<MB>` (explicit megabyte override)
2. `--max-old-space-size-percentage`
3. `OPENCLAUDE_NODE_MAX_OLD_SPACE_SIZE_PERCENTAGE`
4. `OPENCLAUDE_NODE_MAX_OLD_SPACE_SIZE_MB`
5. Default `8192`

Putting the native flag in `NODE_OPTIONS` or
`node --max-old-space-size-percentage=…` only works on Node versions that accept
that option; Node 22.0.0 rejects it before OpenClaude starts. When a supporting
Node already applied that native flag, OpenClaude leaves it in place and does
not append `8192`. Launcher-only flags (`--max-old-space-size-percentage`,
`--max-memory=`) are still stripped so Commander can start. That native-flag
short-circuit also skips OpenClaude’s numbered precedence, including
`--max-memory`. If a valid percentage is requested but available memory cannot
be measured, OpenClaude prints one warning on stderr and uses `8192` instead
of an unrelated megabyte environment value.

## Environment Variables

### Custom (Anthropic-compatible) APIs

For an endpoint that accepts Anthropic's native Messages API, set its base URL,
Bearer token, and model directly. Do not set `CLAUDE_CODE_USE_OPENAI`; that
selects the OpenAI-compatible transport instead.

```bash
export ANTHROPIC_BASE_URL=https://anthropic-proxy.example
export ANTHROPIC_AUTH_TOKEN=your-provider-token
export ANTHROPIC_MODEL=your-model-name
openclaude
```

`ANTHROPIC_AUTH_TOKEN` is sent as `Authorization: Bearer ...`. The
`/provider` → `Add provider` menu uses that Bearer-token setup as **Custom
(Anthropic-compatible)**, including optional extra request headers. For a
directly configured endpoint that instead requires Anthropic's native
`x-api-key` authentication, set `ANTHROPIC_API_KEY` in place of the Bearer
token; do not set both credentials.

#### Keeping a subscription (OAuth) session through a local proxy

Pointing `ANTHROPIC_BASE_URL` at any host other than `api.anthropic.com`
normally switches the client to API-key mode, so a signed-in subscription
session is dropped. To route traffic through a **local, transparent** proxy
(compression, request inspection, caching) that forwards the `Authorization`
and `anthropic-beta` headers to Anthropic unchanged, opt in with
`ANTHROPIC_FIRST_PARTY_PROXY_HOSTS` — a comma-separated `host[:port]` allowlist
that extends first-party detection:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:47821
export ANTHROPIC_FIRST_PARTY_PROXY_HOSTS=127.0.0.1:47821
openclaude   # OAuth session persists; traffic rides the local proxy
```

Only loopback hosts (`127.0.0.1`, `[::1]`, `localhost`) are ever honored, so
the setting can never route OAuth tokens off the machine — a non-loopback entry
is ignored. Write IPv6 in bracket form (`[::1]` or `[::1]:8080`). An entry with
a port matches that port only; an entry without a port matches any port on the
host. Without this variable the behavior is unchanged.

| Variable | Required | Description |
|----------|----------|-------------|
| `CLAUDE_CODE_USE_OPENAI` | OpenAI-compatible only | Set to `1` to enable the OpenAI-compatible provider path |
| `OPENAI_API_KEYS` | One of `OPENAI_API_KEYS` or `OPENAI_API_KEY` for non-local OpenAI-compatible cloud routes* | Comma-separated OpenAI-compatible API key pool. Takes precedence over `OPENAI_API_KEY` and rotates to the next key on auth, quota, or rate-limit failures (`*` not needed for local models like Ollama, LM Studio, Atomic Chat, or other local OpenAI-compatible proxies). |
| `OPENAI_API_KEY` | Required only when `OPENAI_API_KEYS` is unset or empty for non-local OpenAI-compatible cloud routes* | Your API key (`*` not needed for local models like Ollama, LM Studio, Atomic Chat, or other local OpenAI-compatible proxies). A comma-separated list also enables key rotation. |
| `OPENAI_MODEL` | OpenAI-compatible only | Model name such as `gpt-4o`, `deepseek-v4-flash`, or `llama3.3:70b` |
| `OPENAI_BASE_URL` | No | API endpoint, defaulting to `https://api.openai.com/v1` |
| `OPENAI_API_BASE` | No | Compatibility alias for `OPENAI_BASE_URL` |
| `API_TIMEOUT_MS` | No | Request timeout in milliseconds, shared by the OpenAI-compatible and native Anthropic paths (default: `600000`, or 10 minutes). The value must be a safe positive integer; invalid, empty, zero, negative, or fractional values fall back to the applicable default, and values above `2147483647` are capped. For generic OpenAI-compatible requests, direct GitHub Copilot Responses, and Copilot chat-to-Responses fallback requests it is a time-to-response-headers deadline that is disarmed once headers arrive, so it does not limit response streaming. For native Anthropic clients it sets the Anthropic SDK request timeout, and for the non-streaming fallback it overrides that path's own default (`120000` on remote sessions, `300000` otherwise) under the same validation and clamping. Export this runtime setting from your shell or launcher; the provider env-file loader ignores runtime/debug settings, so a value configured only there leaves the default in effect. First-party Codex OAuth Responses retain their existing timeout handling. |
| `OPENCLAUDE_OLLAMA_NUM_CTX` | Ollama only | Request-level Ollama context window. Defaults to `32768`; set a larger value for longer same-session history if your model and hardware can handle it. |
| `OLLAMA_BASE_URL` | Ollama only | Optional Ollama server base URL used for model discovery and the signed-in local Web Search proxy. The Ollama provider profile normally supplies the equivalent `OPENAI_BASE_URL`. |
| `OLLAMA_API_KEY` | Ollama Web Search only | Enables hosted Ollama search at `https://ollama.com/api/web_search` and acts as a fallback when the configured local Ollama search endpoint is unavailable. |
| `OPENCLAUDE_NODE_MAX_OLD_SPACE_SIZE_MB` | No | Explicit V8 old-space heap cap in megabytes for the Node launcher. Used only when `--max-memory`, `--max-old-space-size-percentage`, and `OPENCLAUDE_NODE_MAX_OLD_SPACE_SIZE_PERCENTAGE` are all unset. Default `8192`. |
| `OPENCLAUDE_NODE_MAX_OLD_SPACE_SIZE_PERCENTAGE` | No | Size the V8 old-space heap as a percentage (greater than 0, up to 100) of constrained/container memory when Node reports it, otherwise total system RAM. Converted to `--max-old-space-size` so Node 22.0.0 can start. Precedence, earlier wins: `--max-memory` → `--max-old-space-size-percentage` → this variable → `OPENCLAUDE_NODE_MAX_OLD_SPACE_SIZE_MB` → default `8192`. |
| `CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS` | No | JSON map of OpenAI-compatible model names to context windows, such as `{"custom-model":1000000}`. Use this when a custom provider does not expose context metadata from `/v1/models`. |
| `CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS` | No | JSON map of OpenAI-compatible model names to max output tokens, such as `{"custom-model":32768}`. Use this when a custom provider does not expose output-limit metadata from `/v1/models`. |
| `OPENCODE_API_KEY` | OpenCode Zen / Go | Shared API key for OpenCode Zen (pay-as-you-go) and OpenCode Go (subscription); get yours from https://opencode.ai |
| `MIMO_API_KEY` | Xiaomi MiMo route | Xiaomi MiMo API key for `https://api.xiaomimimo.com/v1`; mirrored into the OpenAI-compatible auth env when the MiMo route is active |
| `CLAUDE_CODE_USE_GEMINI` | Gemini only | Set to `1` to enable the direct Gemini provider path |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Gemini API-key auth | Gemini API key for direct Gemini setup |
| `GEMINI_MODEL` | Gemini only | Model name such as `gemini-3-flash-preview` or `gemini-2.5-pro` |
| `GEMINI_BASE_URL` | No | Override the Gemini base URL |
| `CLAUDE_CODE_USE_MISTRAL` | Mistral only | Set to `1` to enable the dedicated Mistral provider path |
| `MISTRAL_API_KEY` | Mistral only | Mistral API key |
| `MISTRAL_MODEL` | Mistral only | Model name such as `devstral-latest` |
| `MISTRAL_BASE_URL` | No | Override the Mistral base URL |
| `CODEX_API_KEY` | Codex only | Codex or ChatGPT access token override |
| `CHATGPT_ACCOUNT_ID` / `CODEX_ACCOUNT_ID` | Codex only | Required for manual Codex env setup when the account id is not coming from `auth.json` or stored OAuth credentials |
| `CODEX_AUTH_JSON_PATH` | Codex only | Path to a Codex CLI `auth.json` file |
| `CODEX_HOME` | Codex only | Alternative Codex home directory |
| `OPENCLAUDE_MAX_RETRIES` | No | Maximum retry attempts for retryable API failures, capped at 100 (default: 10). Set to `0` to disable retries after the initial request. If unset, deprecated `CLAUDE_CODE_MAX_RETRIES` is still honored for compatibility. |
| `OPENCLAUDE_MAX_TURNS` | No | Per-prompt **local** interactive REPL turn cap for the in-process query loop. Defaults to `50`. Set a larger positive integer for long autonomous local interactive sessions (for example models that take many small tool steps). CLI `--max-turns 0` explicitly disables this cap and prints a cautionary warning. Precedence for a valid override: CLI `--max-turns` → this env var → legacy `CLAUDE_CODE_MAX_TURNS` (only when this var is unset/empty) → `/config` → Max turns (interactive) → `50`. If this env var is set but invalid (zero, negative, non-integer), the default `50` is used and lower layers are not consulted — same pattern as `OPENCLAUDE_MAX_RETRIES`. Does not apply to remote-backed interactive sessions (`connect` / `ssh` / `--remote`). |
| `OPENCLAUDE_RETRY_DELAY_MS` | No | Base retry delay in milliseconds for APIs that do not send `Retry-After`; exponential backoff starts from this value, capped at 60000 (default: 500) |
| `OPENCLAUDE_QUERY_IDLE_TIMEOUT_MS` | No | Foreground QueryGuard inactivity timeout in milliseconds. Defaults to 300000 (5 minutes) and can also be changed interactively through `/config` → Query idle timeout; this environment variable takes precedence over the saved preference. The saved preference applies to the next foreground query. Use a larger positive integer to allow longer gaps between observable query activity. This does not change provider transport stream watchdogs, lease expiry, or human-interaction suspension. The hard maximum below still wins, so raise `OPENCLAUDE_QUERY_HARD_MAX_MS` too when the desired idle interval exceeds it. Invalid, zero, negative, fractional, or timer-overflow environment values are ignored with a warning and use the default rather than the saved preference. |
| `OPENCLAUDE_QUERY_HARD_MAX_MS` | No | Foreground query hard maximum in milliseconds. Defaults to 1800000 (30 minutes). Use a larger positive integer for long autonomous sessions; invalid, zero, negative, fractional, or timer-overflow values are ignored with a warning. |
| `OPENCLAUDE_INTERRUPT_TRACE` | No | Set to `1` or `true` to retain a bounded, privacy-safe interruption lifecycle trace in memory. Disabled by default. The trace contains only allowlisted lifecycle metadata—never prompts, responses, tool arguments, credentials, or raw error messages. |
| `OPENCLAUDE_INTERRUPT_TRACE_FILE` | No | Optional absolute JSONL output path used only when `OPENCLAUDE_INTERRUPT_TRACE` is enabled. On Linux, missing parent directories are created privately and every parent is opened through `/proc/self/fd` without following symbolic links before the final regular file is appended. If the file already exists, its mode is reset to `0600` on every append, so do not configure a shared file. Other platforms retain the bounded trace in memory but do not write this file because Node does not expose an equivalent safe descriptor-relative traversal API there. Writes are best-effort and never change request behavior. Use a separate path per OpenClaude process and keep the resulting diagnostic file private. |
| `OPENCLAUDE_DISABLE_CO_AUTHORED_BY` | No | Suppress the default `Co-Authored-By` trailer in generated git commits |
| `OPENCLAUDE_LOG_TOKEN_USAGE` | No | When truthy (e.g. `verbose`), emits one JSON line on stderr per API request with input/output/cache tokens and the resolved provider. **User-facing debug output** — complements the REPL display controlled by `/config showCacheStats`. Distinct from `CLAUDE_CODE_ENABLE_TOKEN_USAGE_ATTACHMENT`, which is **model-facing** (injects context usage info into the prompt itself). Both can run together. |

Model env vars are provider-scoped: first-party Anthropic sessions read
`ANTHROPIC_MODEL`, OpenAI-compatible sessions read `OPENAI_MODEL`, Gemini reads
`GEMINI_MODEL`, and Mistral reads `MISTRAL_MODEL`. For manual Bedrock, Vertex,
or Foundry launches, select the model with `--model`.

An OpenAI-compatible provider profile's maximum context length applies to every
model in its configured list and the supported saved `/model` selection restored
for that profile. Query options such as `?reasoning=high` or `?thinking=disabled`
remain in the selected model, but context-limit keys use the model name before
`?`. For example, `gpt-5.4?reasoning=high` uses the `gpt-5.4` context limit.

### Web search

[Exa](https://exa.ai) is the default web search backend. With no setup, searches
on non-Anthropic models use Exa's keyless free tier, which has per-second and
daily limits. Run `/search` to pick a backend, add or remove an API key in a
hidden input, check which backend is active (`/search status`), or run a test
search (`/search test`). `/search` saves its choices to the `env` block of
`~/.openclaude.json`; an `env` entry for the same variable in any
`settings.json` takes precedence, and `/search` says so when that happens.

| Variable | Required | Description |
|----------|----------|-------------|
| `WEB_SEARCH_PROVIDER` | No | `auto` (default): keyed Exa first, then any other backend you configured with a key, then the Exa free tier, then DuckDuckGo. Anthropic first-party, Vertex, Foundry, and Codex keep their built-in search in `auto`. Set one backend (`exa`, `tavily`, `brave`, `firecrawl`, `you`, `jina`, `bing`, `mojeek`, `linkup`, `ollama`, `ddg`, `custom`, or `native`) to use only that backend and fail instead of falling back. |
| `EXA_API_KEY` | No | Exa API key for higher limits than the free tier. Free keys: https://dashboard.exa.ai/api-keys |
| `EXA_SEARCH_TYPE` | No | Exa search type with a key: `auto` (default), `instant`, `fast`, `deep-lite`, `deep`, or `deep-reasoning`. The deep types can need a higher `WEB_SEARCH_TIMEOUT_SEC`. |
| `EXA_NUM_RESULTS` | No | Results per Exa search, 1–50 (default `15`). |
| `EXA_FREE_TIER` | No | Set to `0` so searches never go to Exa without a key. |
| `WEB_SEARCH_TIMEOUT_SEC` | No | Timeout for built-in search backends in seconds (default `15`). |

See [Web Search Providers](../src/tools/WebSearchTool/README_SEARCH_PROVIDERS.md)
for every backend, its key, and the custom-API options.

### Per-model limit overrides (`settings.json`)

When a custom OpenAI-compatible provider does not expose context metadata from
`/v1/models`, you can pin a model's context window and max output tokens. In
addition to the `CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS` /
`CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS` env vars above, you can set a
`modelLimits` map in your `settings.json` (the same file `/config` writes, e.g.
`~/.openclaude/settings.json`):

```json
{
  "modelLimits": {
    "my-custom-deployment": { "contextWindow": 262144, "maxOutputTokens": 32768 },
    "api.private-llm.test:my-custom-deployment": { "contextWindow": 1000000 }
  }
}
```

- **Key matching** — keys match the model api-name exactly, or by prefix (e.g.
  `my-custom` matches `my-custom-deployment-v2`). An **exact** key always wins
  over a **prefix** key. A host-qualified key (`<host>:<model>`) only wins over a
  bare key **within the same match kind** — a host-qualified exact key beats a
  bare exact key, and a host-qualified prefix beats a bare prefix, but a bare
  exact key still beats a host-qualified prefix. So to give the same model
  different limits per endpoint, use host-qualified **exact** keys for each
  endpoint. `<host>` is the `OPENAI_BASE_URL` host **including the port when the
  URL has one** (`new URL(baseUrl).host`): for `http://localhost:4000/v1` the
  key is `localhost:4000:my-model`, not `localhost:my-model`. Either field may be
  omitted to override only one limit.
- **Precedence** — from highest to lowest: an **exact** env-var override → the
  built-in catalog value → a **prefix** env-var override → `modelLimits` → the
  discovery-cache value → the descriptor default. So env-var overrides and
  `modelLimits` both win over discovery. A known catalog model keeps its catalog
  limit unless you set an *exact* env override for it.
- **When a gateway advertises the wrong window** — some OpenAI-compatible
  gateways report a flat `context_length` (often `128000`) for every model they
  proxy. OpenClaude keeps that value, because an advertised window can just as
  easily be a real per-deployment cap, and budgeting above the endpoint's true
  limit turns early auto-compact into a mid-session API failure. If you know the
  real window, use an **exact** `CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS` entry for a
  catalogued model. For a custom or discovered model, use `modelLimits` or an
  exact env entry. Use `/set-context-window <tokens>` for the current session
  only.

### Exact-model pricing overrides (`settings.json`)

Use `modelPricing` when a gateway's real price differs from OpenClaude's
built-in price or unknown-model estimate. Keys match the exact, case-sensitive
model identifier sent to the API. They are not prefixes, aliases, globs, or
route/profile-qualified keys.

The four token fields are USD per 1,000,000 tokens. `webSearchRequests` is USD
per request; it defaults to `$0.01` when omitted. All four token fields are
required so an omitted cache rate never falls through to an unrelated built-in
price. Explicit zero is supported, including fully free gateways. The GLM
entry below is an illustrative paid estimate; replace it with your actual
gateway rates:

```json
{
  "modelPricing": {
    "nvidia/llama-3.1-nemotron-70b-instruct": {
      "inputTokens": 0,
      "outputTokens": 0,
      "promptCacheReadTokens": 0,
      "promptCacheWriteTokens": 0,
      "webSearchRequests": 0
    },
    "z-ai/glm-5.2": {
      "inputTokens": 0.6,
      "outputTokens": 2.2,
      "promptCacheReadTokens": 0.06,
      "promptCacheWriteTokens": 0.75,
      "webSearchRequests": 0.01
    }
  }
}
```

Set this in user settings (`~/.openclaude/settings.json`), local gitignored
settings (`.openclaude/settings.local.json`), a `--settings`/SDK settings
source, or managed settings. Shared project settings
(`.openclaude/settings.json`) are deliberately ignored for `modelPricing`, so
repository content cannot silently change personal USD accounting. Under the
current architecture, one key applies to that exact model id across every
route and profile; route-specific prices are not represented yet.

Pricing precedence is:

1. exact trusted `modelPricing` entry;
2. built-in known-model pricing, including fast-mode pricing;
3. the existing unknown-model estimate and warning.

For ordinary provider routes, find the exact pre-canonicalization identifier by
running with `OPENCLAUDE_LOG_TOKEN_USAGE=verbose` and copying the JSON log
line's `model` field. Use that value verbatim. Bedrock application inference
profiles are the exception: cost calculation uses the profile's resolved
backing model id. For example, an override for `claude-opus-4-8` does not match
a resolved id such as `claude-opus-4-8-20260815`; dated, backing, or
provider-suffixed ids need their own exact keys.

Rates must be finite and nonnegative. Token rates are capped at `$100,000` per
million tokens, web-search rates at `$1,000` per request, model ids at 512
characters, and the map at 256 entries. These deliberately generous bounds
reject accidental absurd values. An invalid pricing map is ignored without
discarding unrelated settings from the same file. `/config` does not currently
edit record-valued settings, so edit the JSON file directly.

## Optional Error Reporting (Sentry)

OpenClaude can optionally report sanitized error events to Sentry. This is
disabled by default and opt-in only.

```bash
export SENTRY_DSN=https://your-key@your-org.ingest.sentry.io/your-project
openclaude
```

Notes:

- Reporting only activates when `SENTRY_DSN` is set. Unset, this is a no-op.
- Reporting is skipped even when `SENTRY_DSN` is set if `DISABLE_TELEMETRY` or
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, matching the same privacy
  levels used for existing telemetry (see [Runtime Hardening](#runtime-hardening)).
- Only sanitized, telemetry-safe error messages are sent — never raw error
  messages, which may contain file paths or other identifying information.
- `@sentry/node` is an optional dev dependency and is **not included** in the
  default `npm install -g @gitlawb/openclaude` install (see
  [Optional provider packages](#optional-provider-packages)). If you set
  `SENTRY_DSN` without installing it separately, reporting is silently
  disabled (no error, no crash). Install it explicitly with:

```bash
  npm i -g @sentry/node
```

  Source builds (`bun install`) already include it as a dev dependency, so no
  extra step is needed there.

## Safety strictness

OpenClaude runs several "safety" checks: a model-level refusal directive, bash
command-injection validation, and sensitive-file / auto-edit guards. These are
conservative by design, but a few of them can surface as refusals or approval
prompts for entirely benign, routine coding tasks (e.g. editing `.gitmodules`,
running a build script that contains `$(date)`, or writing a CTF port scanner).
See [issue #1616](https://github.com/Twigpine/openclaude/issues/1616).

Set `OPENCLAUDE_SAFETY_LEVEL` to dial strictness without changing behavior for
everyone:

| Value | Behavior |
|-------|----------|
| `strict` | Current/default-equivalent non-permissive behavior. |
| `balanced` | Default. Same behavior as `strict`. |
| `permissive` | Opt-in mode for users who prefer fewer false-positive stops. It bypasses the legacy bash command-injection validation path entirely, keeps ordinary interpreter allow-rules (`Bash(python:*)`, `Bash(npm run:*)`, …) when entering auto mode, and skips prompts for routine edits to filenames on the broad sensitive-file list. Dangerous directory, Windows-path, symlink-resolved path, and UNC guards remain active. The model-level prompt is not weakened by this flag. |

```bash
export OPENCLAUDE_SAFETY_LEVEL=permissive   # relax benign-task false positives
```

## Runtime Hardening

Use these commands to validate your setup and catch mistakes early:

```bash
# quick startup sanity check
bun run smoke

# validate provider env + reachability
bun run doctor:runtime

# print machine-readable runtime diagnostics
bun run doctor:runtime:json

# persist a diagnostics report to reports/doctor-runtime.json
bun run doctor:report

# print a redacted public issue report
openclaude doctor report --markdown

# write a redacted JSON issue report for attachment
openclaude doctor report --json --out openclaude-report.json

# write a deterministic task report from a session transcript
openclaude report --json --transcript ~/.openclaude/projects/-path-to-project/session-id.jsonl --out task-report.json

# print a human-readable task report from the latest session in the current project
openclaude report --markdown

# full local hardening check (smoke + runtime doctor)
bun run hardening:check

# strict hardening (includes project-wide typecheck)
bun run hardening:strict
```

Notes:

- `doctor:runtime` fails fast if `CLAUDE_CODE_USE_OPENAI=1` with a placeholder key or a missing key for non-local providers.
- `doctor:runtime` also validates the dedicated Gemini and Mistral env paths when `CLAUDE_CODE_USE_GEMINI=1` or `CLAUDE_CODE_USE_MISTRAL=1`.
- Local providers such as `http://localhost:11434/v1`, `http://10.0.0.1:11434/v1`, and `http://127.0.0.1:1337/v1` can run without `OPENAI_API_KEY`.
- Codex profiles validate `CODEX_API_KEY` or the Codex CLI auth file and probe `POST /responses` instead of `GET /models`.
- `openclaude doctor report` is redacted by default and is intended for GitHub issues. It summarizes provider/runtime/build/settings state without prompts, transcripts, raw settings files, API keys, MCP command details, or full home-directory paths.
- `openclaude report --json` and `openclaude report --markdown` summarize observed session facts such as tool uses, Bash commands, validation commands, changed files, branch metadata, warnings, and linked issue/PR references. Use `--transcript <file>` for an explicit transcript, `--session <id>` for a stored session, or omit both to report the latest session for the current project. Large previews are truncated and credential-shaped strings are redacted. When no validation command is observed, the report keeps `validations` empty and includes a warning instead of claiming checks passed.

## Provider Launch Profiles

Use profile launchers to avoid repeated environment setup:

```bash
# one-time profile bootstrap (prefer viable local Ollama, otherwise OpenAI)
bun run profile:init

# preview the best provider/model for your goal
bun run profile:recommend -- --goal coding --benchmark

# auto-apply the best available local/openai provider/model for your goal
bun run profile:auto -- --goal latency

# codex bootstrap (defaults to codexplan and ~/.codex/auth.json)
bun run profile:codex

# openai bootstrap with explicit key
bun run profile:init -- --provider openai --api-key sk-...

# gemini bootstrap with explicit key
bun run profile:init -- --provider gemini --api-key ...

# ollama bootstrap with custom model
bun run profile:init -- --provider ollama --model llama3.1:8b

# ollama bootstrap with intelligent model auto-selection
bun run profile:init -- --provider ollama --goal coding

# atomic-chat bootstrap (auto-detects running model)
bun run profile:init -- --provider atomic-chat

# codex bootstrap with a fast model alias
bun run profile:init -- --provider codex --model codexspark

# launch using persisted user-level provider profile
bun run dev:profile

# codex profile (uses CODEX_API_KEY or ~/.codex/auth.json)
bun run dev:codex

# OpenAI profile (uses the saved OpenAI profile, or OPENAI_API_KEYS / OPENAI_API_KEY from your shell)
bun run dev:openai

# Gemini profile (uses the saved Gemini profile, or GEMINI_API_KEY / GOOGLE_API_KEY from your shell)
bun run dev:gemini

# Ollama profile (defaults: localhost:11434, llama3.1:8b)
bun run dev:ollama

# Atomic Chat profile (Apple Silicon local LLMs at 127.0.0.1:1337)
bun run dev:atomic-chat
```

`profile:recommend` ranks installed Ollama models for `latency`, `balanced`, or `coding`, and `profile:auto` can persist the recommendation directly.

If no profile exists yet, `dev:profile` uses the same goal-aware defaults when picking the initial model.

### Provider Profile Model Picker Mode

When a saved provider profile is active, `/model` can either show the provider's
catalog/discovered models or only the models explicitly listed in the profile.
Configure this in `~/.openclaude.json`:

```json
{
  "providerProfileModelPickerMode": "auto"
}
```

Supported values:

- `auto` (default): single-model profiles show the provider catalog; multi-model
  profiles show the explicit profile list; native vendor routes keep their full
  provider catalog.
- `provider`: show the provider catalog/discovery list first and append
  profile-only custom model IDs.
- `profile`: show only explicitly configured profile models.

When the provider-profile env workflow is active (i.e. a profile has been
applied and `CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED=1` is set — as it is after
launching with a saved profile) and you have more than one saved provider
profile, `/model` also lists models from your **inactive** profiles, grouped
under their profile name. Selecting one activates that provider profile and
switches to the chosen model in a single step, reconciling fast mode if the
target provider cannot run it. These cross-profile entries appear only in the
interactive `/model` picker — they are never returned to SDK/automation callers
and are hidden from inline pickers (such as the prompt hotkey or Settings),
which cannot switch the active profile. Simply having multiple profiles
configured without the env workflow active does not surface them.

Use `--provider ollama` when you want a local-only path. Auto mode falls back to OpenAI when no viable local chat model is installed.

Use `--provider atomic-chat` when you want Atomic Chat as the local Apple Silicon provider.

Use `profile:codex` or `--provider codex` when you want the ChatGPT Codex backend.

`dev:openai`, `dev:gemini`, `dev:ollama`, `dev:atomic-chat`, and `dev:codex`
run `doctor:runtime` first and only launch the app if checks pass.

For `dev:ollama`, make sure Ollama is running locally before launch.

For `dev:atomic-chat`, make sure Atomic Chat is running with a model loaded before launch.

## Message-Count Compaction Threshold

By default, OpenClaude compacts conversations based on token usage and also
applies a safety hard cap of 1000 active messages. The hard cap catches long
sessions that accumulate many small messages with negligible token cost.

This hard cap is a safety net: it can still trigger compaction even when
`DISABLE_COMPACT`, `DISABLE_AUTO_COMPACT`, or a disabled auto-compact setting
would otherwise prevent it. Set `OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP=0`
only when you need to suppress that safety cap for diagnostics.

If you frequently resume long sessions that accumulate hundreds of small
tool-result messages with negligible token cost, adjust message-count
compaction via the in-app `/config` command:

```text
/config
```

Message-count compaction defaults to `200` messages. Select
**Message-count compaction** to choose a different threshold (`100`, `500`, or
`1000`), or set it to `off` to disable the setting's proactive guard. The
built-in hard cap remains, and an `OPENCLAUDE_MAX_ACTIVE_MESSAGES` override
remains active when configured.

The legacy `OPENCLAUDE_MAX_ACTIVE_MESSAGES` environment variable is honored
when the setting is unset or `off`. An explicit numeric setting takes
precedence over that legacy value. `OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP`
can override the safety cap; set it to `0` only for diagnostics.

### Long-session memory guard validation

For changes that touch auto-compact, provider request conversion, transcript
retention, or in-process teammates, run the focused long-session guard checks:

```bash
bun test --feature=UNATTENDED_RETRY src/query/autoCompactCooldown.test.ts src/utils/maxActiveMessages.test.ts src/services/api/openaiShim.test.ts
```

These tests cover repeated over-cap turns, auto-compact cooldown blocking,
teammate active-message compaction, malformed hard-cap overrides, and
pruned-history tool-call/tool-result pairing. They are not a substitute for a
multi-hour manual soak, but they pin the bounded-history and conversion
invariants that previously let long sessions grow until Node/V8 OOM.
