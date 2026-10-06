# Web Search Providers

OpenClaude supports multiple search backends through a provider adapter system.

**Exa is the default search backend.** With no configuration at all, web search
runs on Exa's keyless free tier. Add an `EXA_API_KEY` for higher limits; any other
backend you configure with a key is used before the free tier.

## Configure with `/search`

The `/search` command sets everything below without editing env vars:

| Command | Effect |
|---|---|
| `/search` | Pick a backend from a list that shows which ones have keys |
| `/search <backend>` | Select a backend directly (`auto`, `exa`, `tavily`, `brave`, …); prompts for its key if needed |
| `/search key [backend]` | Add or replace an API key in a hidden input (defaults to `exa`) |
| `/search remove-key [backend]` | Remove a saved API key (defaults to `exa`) |
| `/search status` | Show which backend handles searches and what it falls back to |
| `/search test [query]` | Run a test search through the configured backends |

Selections are saved as `WEB_SEARCH_PROVIDER` and the backend's key variable in
the `env` block of `~/.openclaude.json` (readable only by you — the same file
`/provider` uses), and take effect immediately. Keys are never accepted on the
command line.

Precedence: values saved by `/search` override the same variables exported in
your shell, and are overridden by an `env` entry for that variable in any
`settings.json` (user, project, `--settings`, or managed policy) — `/search`
tells you when that happens. `/search remove-key` only removes keys that
`/search` saved; a key that comes from your shell or a settings file is reported
instead.

## Supported Providers

| Provider | Env Var | Auth Header | Method |
|---|---|---|---|
| Custom API | `WEB_SEARCH_API` | Configurable | GET/POST |
| Ollama | Active Ollama route or `OLLAMA_API_KEY` | Local sign-in / `Authorization: Bearer` | POST |
| SearXNG | `WEB_PROVIDER=searxng` | — | GET |
| Google | `WEB_PROVIDER=google` + `GOOGLE_CSE_ID` | *(query param `?key=`)* | GET |
| Brave (preset) | `WEB_PROVIDER=brave` | `X-Subscription-Token` | GET |
| Brave (adapter) | `BRAVE_API_KEY` | `X-Subscription-Token` | GET |
| SerpAPI | `WEB_PROVIDER=serpapi` | `Authorization: Bearer` | GET |
| Firecrawl | `FIRECRAWL_API_KEY` | Internal | SDK |
| Tavily | `TAVILY_API_KEY` | `Authorization: Bearer` | POST |
| Exa (default) | `EXA_API_KEY` | `x-api-key` | POST |
| Exa free tier | *(none — zero-config default)* | — | POST |
| You.com | `YOU_API_KEY` | `X-API-Key` | GET |
| Jina | `JINA_API_KEY` | `Authorization: Bearer` | GET |
| Bing | `BING_API_KEY` | `Ocp-Apim-Subscription-Key` | GET |
| Mojeek | `MOJEEK_API_KEY` | `Authorization: Bearer` | GET |
| Linkup | `LINKUP_API_KEY` | `Authorization: Bearer` | POST |
| DuckDuckGo | *(none — last-resort fallback)* | — | SDK |

## Quick Start

```bash
# Exa (default) — works with no setup on the free tier; add a key for higher limits
export EXA_API_KEY=your-exa-key

# Tavily (fast, RAG-ready)
export TAVILY_API_KEY=tvly-your-key

# Brave (independent index, good free tier)
export BRAVE_API_KEY=your-brave-key

# Bing
export BING_API_KEY=your-bing-key

# Self-hosted SearXNG (free, private)
export WEB_PROVIDER=searxng
export WEB_SEARCH_API=https://search.example.com/search
```

## Provider Selection Mode

`WEB_SEARCH_PROVIDER` controls fallback behavior:

| Mode | Behavior |
|---|---|
| `auto` (default) | Try all configured providers in order, fall through on failure |
| `ollama` | Local signed-in Ollama, then hosted Ollama when `OLLAMA_API_KEY` is set; throws if both fail |
| `tavily` | Tavily only — throws on failure |
| `exa` | Exa only — keyed API when `EXA_API_KEY` is set, otherwise the free tier; throws on failure |
| `brave` | Brave only — throws on failure |
| `custom` | Custom API only — throws on failure. **Not in the auto chain** — must be explicitly selected |
| `firecrawl` | Firecrawl only — throws on failure |
| `ddg` | DuckDuckGo only — throws on failure |
| `native` | Anthropic native / Codex only |

**Auto mode priority:** exa → ollama → firecrawl → tavily → you → jina → brave → bing → mojeek → linkup → exa free tier → ddg

Each entry is only tried when it is configured (has its key or route). Keyed Exa
leads the chain; any other keyed backend still runs before the keyless Exa free
tier, and DuckDuckGo is the last resort.

In `auto` mode, providers with built-in web search (Anthropic first-party,
Vertex, Foundry, Codex) keep using it. Set `WEB_SEARCH_PROVIDER=exa` to use Exa
there too.

> **Note:** The `custom` provider is excluded from the `auto` chain. It is only used when `WEB_SEARCH_PROVIDER=custom` is explicitly set. This prevents the generic outbound provider from silently becoming the default backend.

```bash
# Fail loudly if Tavily is down (don't silently switch backends)
export WEB_SEARCH_PROVIDER=tavily

# Try everything, fall through gracefully
export WEB_SEARCH_PROVIDER=auto
```

## Built-in Provider Timeout

Built-in adapter providers use a 15s request timeout so `auto` mode can fall through when a backend stalls. Override it with:

```bash
export WEB_SEARCH_TIMEOUT_SEC=30
```

Invalid, fractional, zero, negative, or very large values fall back to 15s. Custom API providers keep their separate `WEB_CUSTOM_TIMEOUT_SEC` setting because self-hosted endpoints may need different budgets.

## Provider Request & Response Formats

### Ollama

When the active route resolves to Ollama, OpenClaude first calls the configured server's signed-in proxy:

```text
POST http://localhost:11434/api/experimental/web_search
Content-Type: application/json

{"query":"search terms","max_results":10}
```

If that request fails and `OLLAMA_API_KEY` is set, it retries the hosted API with `Authorization: Bearer $OLLAMA_API_KEY`. The key is never sent to the local server.

```text
POST https://ollama.com/api/web_search
Authorization: Bearer $OLLAMA_API_KEY
Content-Type: application/json
```

Both endpoints return structured `results` containing `title`, `url`, and `content`. Use `WEB_SEARCH_PROVIDER=ollama` to select only this local-to-hosted Ollama chain; in `auto` mode, another configured search backend is tried if Ollama search fails.

### Tavily

```bash
export TAVILY_API_KEY=tvly-your-key
```

**Request:**
```
POST https://api.tavily.com/search
Authorization: Bearer tvly-your-key
Content-Type: application/json

{"query": "search terms", "max_results": 10, "include_answer": false}
```

**Response:**
```json
{
  "results": [
    {
      "title": "Result Title",
      "url": "https://example.com/page",
      "content": "Full text snippet from the page...",
      "score": 0.95
    }
  ]
}
```

### Exa (default)

```bash
export EXA_API_KEY=your-exa-key   # optional — the free tier works without it
```

| Env var | Default | Effect |
|---|---|---|
| `EXA_API_KEY` | — | Use the keyed Exa API (higher limits) |
| `EXA_SEARCH_TYPE` | `auto` | `auto`, `instant`, `fast`, `deep-lite`, `deep`, or `deep-reasoning` (keyed API only; the deep types may need a higher `WEB_SEARCH_TIMEOUT_SEC`) |
| `EXA_NUM_RESULTS` | `15` | Results per search, 1–50 (keyed API and free tier) |
| `EXA_FREE_TIER` | on | Set to `0` to never use the keyless free tier |

**Request:**
```
POST https://api.exa.ai/search
x-api-key: your-exa-key
Content-Type: application/json

{"query": "search terms", "numResults": 15, "type": "auto", "contents": {"highlights": true}}
```

`allowed_domains` / `blocked_domains` are sent as `includeDomains` / `excludeDomains`.

**Response:**
```json
{
  "results": [
    {
      "title": "Result Title",
      "url": "https://example.com/page",
      "highlights": ["The most query-relevant excerpt...", "Another excerpt..."],
      "highlightScores": [0.91, 0.84]
    }
  ]
}
```

### Exa Free Tier (Zero-Config Default)

No configuration needed. When no `EXA_API_KEY` is set, OpenClaude calls Exa's
hosted endpoint, which serves a free tier with a per-IP requests-per-second limit
and a daily quota. Concurrent searches are spaced automatically. When the limit is
hit, `auto` mode falls through to DuckDuckGo and skips the free tier for the next
few minutes; in `exa` mode (and `/search test`) the error tells you to add a key
with `/search key exa`.

**Request** (MCP streamable HTTP, JSON-RPC):
```
POST https://mcp.exa.ai/mcp
Content-Type: application/json
Accept: application/json, text/event-stream
x-exa-source: openclaude

{"jsonrpc": "2.0", "id": 1, "method": "tools/call",
 "params": {"name": "web_search_exa",
            "arguments": {"query": "search terms", "objective": "...", "numResults": 15}}}
```

The reply is plain text (`Title:` / `URL:` / `Highlights:` blocks) inside an SSE
`message` event. `allowed_domains` become `site:` operators in the query, and both
domain lists are also enforced on the parsed results.

Opt out (searches never go to Exa without a key):

```bash
export EXA_FREE_TIER=0
```

### You.com

```bash
export YOU_API_KEY=your-you-key
```

**Request:**
```
GET https://api.ydc-index.io/v1/search?query=search+terms
X-API-Key: your-you-key
```

**Response:**
```json
{
  "results": {
    "web": [
      {
        "title": "Result Title",
        "url": "https://example.com/page",
        "snippets": ["First snippet from the page...", "Second snippet..."],
        "description": "Page description"
      }
    ]
  }
}
```

### Jina

```bash
export JINA_API_KEY=your-jina-key
```

**Request:**
```
GET https://s.jina.ai/?q=search+terms
Authorization: Bearer your-jina-key
Accept: application/json
```

**Response:**
```json
{
  "data": [
    {
      "title": "Result Title",
      "url": "https://example.com/page",
      "description": "Snippet from the page..."
    }
  ]
}
```

### Bing

```bash
export BING_API_KEY=your-bing-key
```

**Request:**
```
GET https://api.bing.microsoft.com/v7.0/search?q=search+terms&count=10
Ocp-Apim-Subscription-Key: your-bing-key
```

**Response:**
```json
{
  "webPages": {
    "value": [
      {
        "name": "Result Title",
        "url": "https://example.com/page",
        "snippet": "A short excerpt from the page...",
        "displayUrl": "example.com/page"
      }
    ]
  }
}
```

### Mojeek

```bash
export MOJEEK_API_KEY=your-mojeek-key
```

**Request:**
```
GET https://www.mojeek.com/search?q=search+terms&fmt=json
Authorization: Bearer your-mojeek-key
```

**Response:**
```json
{
  "response": {
    "results": [
      {
        "title": "Result Title",
        "url": "https://example.com/page",
        "snippet": "Excerpt from the page..."
      }
    ]
  }
}
```

### Linkup

```bash
export LINKUP_API_KEY=your-linkup-key
```

**Request:**
```
POST https://api.linkup.so/v1/search
Authorization: Bearer your-linkup-key
Content-Type: application/json

{"q": "search terms", "search_type": "standard"}
```

**Response:**
```json
{
  "results": [
    {
      "name": "Result Title",
      "url": "https://example.com/page",
      "snippet": "A short description of the result..."
    }
  ]
}
```

### SearXNG (Built-in Preset)

```bash
export WEB_PROVIDER=searxng
export WEB_SEARCH_API=https://search.example.com/search
```

**Request:**
```
GET https://search.example.com/search?q=search+terms
```

**Response:**
```json
{
  "results": [
    {
      "title": "Result Title",
      "url": "https://example.com/page",
      "content": "Snippet from the page...",
      "engine": "google"
    }
  ]
}
```

### Google Custom Search (Built-in Preset)

> ⚠️ **Sunset 2027-01-01.** Google has announced the Custom Search JSON API
> will be discontinued and is closed to new customers. Use Brave/Tavily/Exa
> for new setups.

```bash
export WEB_PROVIDER=google
export WEB_KEY=your-google-api-key
export GOOGLE_CSE_ID=your-programmable-search-engine-id
```

`GOOGLE_CSE_ID` is the `cx` value from your Programmable Search Engine — both
the API key and the engine ID are required.

**Request:**
```
GET https://www.googleapis.com/customsearch/v1?q=search+terms&key=your-google-api-key&cx=your-engine-id
```

**Response:**
```json
{
  "items": [
    {
      "title": "Result Title",
      "link": "https://example.com/page",
      "snippet": "A short excerpt...",
      "displayLink": "example.com"
    }
  ]
}
```

### Brave (First-Class Adapter)

The recommended way to use Brave — auto-detected, joins the auto fallback chain.

```bash
export BRAVE_API_KEY=your-brave-key
```

**Request:**
```
GET https://api.search.brave.com/res/v1/web/search?q=search+terms&count=15
X-Subscription-Token: your-brave-key
```

### Brave (Built-in Preset, alternative)

For users who prefer the generic preset path. Functionally equivalent to the
adapter above; either works.

```bash
export WEB_PROVIDER=brave
export WEB_KEY=your-brave-key
```

**Response:**
```json
{
  "web": {
    "results": [
      {
        "title": "Result Title",
        "url": "https://example.com/page",
        "description": "Page description..."
      }
    ]
  }
}
```

### SerpAPI (Built-in Preset)

```bash
export WEB_PROVIDER=serpapi
export WEB_KEY=your-serpapi-key
```

**Request:**
```
GET https://serpapi.com/search.json?q=search+terms
Authorization: Bearer your-serpapi-key
```

**Response:**
```json
{
  "organic_results": [
    {
      "title": "Result Title",
      "link": "https://example.com/page",
      "snippet": "A short excerpt...",
      "displayed_link": "example.com"
    }
  ]
}
```

### DuckDuckGo (Last-Resort Fallback)

No configuration needed. Uses the `duck-duck-scrape` npm package. In `auto` mode it
runs only after every configured backend (including the Exa free tier) has failed.

```bash
# Set as explicit-only backend
export WEB_SEARCH_PROVIDER=ddg
```

---

## Custom API Configuration

### Standard GET

```
GET https://api.example.com/search?q=hello
```

```bash
export WEB_SEARCH_API=https://api.example.com/search
export WEB_QUERY_PARAM=q
```

### Query in URL Path

```
GET https://api.example.com/v2/search/hello
```

```bash
export WEB_URL_TEMPLATE=https://api.example.com/v2/search/{query}
```

### POST with Custom Body

```
POST https://api.example.com/v1/query
Content-Type: application/json

{"input": {"text": "hello"}}
```

```bash
export WEB_SEARCH_API=https://api.example.com/v1/query
export WEB_METHOD=POST
export WEB_BODY_TEMPLATE='{"input":{"text":"{query}"}}'
```

### Extra Static Params

```bash
export WEB_PARAMS='{"lang":"en","count":"10"}'
```

## Auth

API keys are sent in HTTP headers, **never** in query strings.

```bash
# Default: Authorization: Bearer <key>
export WEB_KEY=your-key

# Custom header
export WEB_AUTH_HEADER=X-Api-Key
export WEB_AUTH_SCHEME=""

# Extra headers
export WEB_HEADERS="X-Tenant: acme; Accept: application/json"
```

## Response Parsing

The tool auto-detects many response formats:

```jsonc
{ "results": [{ "title": "...", "url": "..." }] }     // flat array
{ "items": [{ "title": "...", "link": "..." }] }       // Google-style
{ "results": { "engine": [{ "title": "...", "url": "..." }] } }  // nested map
[{ "title": "...", "url": "..." }]                      // bare array
```

Field name aliases: `title`/`headline`/`name`, `url`/`link`/`href`, `description`/`snippet`/`content`

For deeply nested responses:
```bash
export WEB_JSON_PATH=response.payload.results
```

## Retry

Failed custom-provider requests (network errors, 5xx) are retried once after 500ms. Client errors (4xx) are not retried. Custom requests have a default 120s timeout.

## Custom Provider Security Guardrails

The custom provider enforces the following guardrails by default:

| Guardrail | Default | Override |
|-----------|---------|----------|
| HTTPS-only | ✅ | `WEB_CUSTOM_ALLOW_HTTP=true` |
| Block private IPs / localhost | ✅ | `WEB_CUSTOM_ALLOW_PRIVATE=true` |
| Header allowlist | ✅ | `WEB_CUSTOM_ALLOW_ARBITRARY_HEADERS=true` |
| Max POST body | 300 KB | `WEB_CUSTOM_MAX_BODY_KB=<kb>` |
| Request timeout | 120s | `WEB_CUSTOM_TIMEOUT_SEC=<seconds>` |
| Audit log (one-time warning) | ✅ | — |

### Self-hosted SearXNG example

```bash
export WEB_PROVIDER=searxng
export WEB_SEARCH_API=https://search.mydomain.com/search
export WEB_CUSTOM_ALLOW_PRIVATE=true   # needed if SearXNG is on a private IP
```

### Header allowlist

By default only these headers are permitted:
`accept`, `accept-encoding`, `accept-language`, `authorization`, `cache-control`, `content-type`, `if-modified-since`, `if-none-match`, `ocp-apim-subscription-key`, `user-agent`, `x-api-key`, `x-subscription-token`, `x-tenant-id`

## Adding a Provider

1. Create `providers/myprovider.ts`:

```typescript
import type { SearchInput, SearchProvider } from './types.js'
import { applyDomainFilters, type ProviderOutput } from './types.js'

export const myProvider: SearchProvider = {
  name: 'myprovider',
  isConfigured() { return Boolean(process.env.MYPROVIDER_API_KEY) },
  async search(input: SearchInput): Promise<ProviderOutput> {
    const start = performance.now()
    // ... call API, map to SearchHit[] ...
    return {
      hits: applyDomainFilters(hits, input),
      providerName: 'myprovider',
      durationSeconds: (performance.now() - start) / 1000,
    }
  },
}
```

2. Register in `providers/index.ts` — add import and push to `ALL_PROVIDERS`.
