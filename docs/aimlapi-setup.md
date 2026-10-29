# AI/ML API Setup

OpenClaude connects to [AI/ML API](https://aimlapi.com) through its OpenAI-compatible endpoint at `https://api.aimlapi.com/v1`.

## Overview

AI/ML API is an aggregating gateway that exposes many chat models behind a single OpenAI-compatible API. OpenClaude ships a first-class `AI/ML API` provider preset: it uses `AIMLAPI_API_KEY`, sends the OpenClaude attribution headers, and discovers chat-capable models from the public `/models` catalog. It defaults to `gpt-4o`.

## Prerequisites

None. You do not need to visit <https://aimlapi.com> first - the guided top-up flow can create an account and issue a key. If you already have a dashboard key or set `AIMLAPI_API_KEY`, OpenClaude can use that credential instead.

## Option 1 - Interactive (`/provider`)

1. Start OpenClaude and run `/provider`.
2. Choose **aimlapi.com**.
3. If aimlapi.com is already configured, choose one of:
   - **Continue with your saved API key** - validate the saved key or `AIMLAPI_API_KEY`, check its balance, optionally top up a low balance, then choose a model.
   - **Set up a new key or switch account** - enter the new-user or existing-key flow.
4. Otherwise choose how to get an API key:
   - **I am a new user** - enter your email. OpenClaude creates a passwordless account, lets you pick a top-up amount and automatic top-up preference (auto top-up is pre-selected **on** here; toggle it off if you don't want it), opens card checkout, then saves the issued key.
   - **I already have aimlapi.com key** - paste a key from the dashboard. OpenClaude validates it, checks its balance, and offers an optional API-key top-up when the balance is low.

For an email that already has an account, AI/ML API sends a 6-digit sign-in code. OpenClaude creates a new API key for that account, checks its balance, and only offers checkout when the balance is low. You can top up or save the key and skip funding for now.

When `AIMLAPI_API_KEY` supplies the credential, OpenClaude uses its runtime value for validation and balance checks but saves an empty credential in the provider profile. The literal environment value is not copied into configuration.

Checkout progress is durable, not just kept for the current session: the payment identity and any issued key are persisted to disk, so a restart resumes the same checkout too. Retrying an ambiguous payment or exchange failure resumes the original partner session instead of creating a second checkout, and if a prior run already paid and exchanged the key, the next run finishes the profile write instead of re-provisioning.

The key exchange itself is one-shot: it cannot be retried. If payment succeeds and a key is issued but the local recovery receipt for it cannot be saved (for example a locked or read-only config directory), both the CLI and the interactive flow stop rather than risk losing that key silently. The error names the issued key id — open <https://aimlapi.com/app> and rotate that key to recover access, then configure the new key manually.

The base URL (`https://api.aimlapi.com/v1`) and default model (`gpt-4o`) are filled in automatically. Switch models any time with `/model`; only chat-capable models from the AI/ML API catalog are listed.

## Option 2 - CLI (`openclaude aimlapi topup`)

Run the guided account top-up flow from the CLI:

```bash
openclaude aimlapi topup --email you@example.com --amount 25
```

- Pass `--email` (or set `AIMLAPI_EMAIL`). Existing accounts also need the emailed 6-digit code: interactive terminals prompt for it (hidden, not echoed); for scripts, pipe it in with `--code-stdin` (reads one line from stdin) — the recommended noninteractive path, since the value never appears in this process's argv or `ps` output. Whether it also avoids shell history depends on how you feed stdin: reading from a file (`--code-stdin < code.txt`) or a secret manager avoids it, but `echo 123456 | openclaude ...` still records that whole pipeline. `AIMLAPI_CODE` has the same caveat — set it through a mechanism that itself avoids shell history (a CI secret, a sourced env file, `systemd`'s `Environment=`), not by typing `AIMLAPI_CODE=123456 openclaude ...` directly. Avoid the deprecated `--code <value>` flag entirely — a plain argument is always visible to other local users via shell history and the process list.
- `--amount`: top-up amount in USD (min 20, max 10000; defaults to 25).
- Checkout always uses card payment; there is no separate payment-method step.
- `--auto-top-up`: enroll the account in automatic top-up at checkout. Off by default here, unlike the interactive flow above, where it's pre-selected on.
- `--model`: default model id written into the provider profile (defaults to `gpt-4o`).
- `--no-open`: print the payment URL instead of auto-opening a browser.

The issued key is written into OpenClaude's provider profile automatically once payment clears.

## Option 3 - Environment variables

Setting `AIMLAPI_API_KEY` alone is enough; OpenClaude auto-detects the AI/ML API route:

```bash
export AIMLAPI_API_KEY="your-aimlapi-key"
```

To configure the OpenAI-compatible route explicitly:

```bash
export CLAUDE_CODE_USE_OPENAI=1
export AIMLAPI_API_KEY="your-aimlapi-key"
export OPENAI_BASE_URL="https://api.aimlapi.com/v1"
export OPENAI_MODEL="gpt-4o"
```

`OPENAI_API_KEY` also works as a fallback credential for the route.

## Web search (optional, billed)

AI/ML API can also back OpenClaude's web search through the Toolbox tool `web/search`.
Turn it on with `/search aimlapi` (or `WEB_SEARCH_PROVIDER=aimlapi`). It reuses the
`AIMLAPI_API_KEY` this setup provides, so there is no second key to paste.

Each search is billed to your AI/ML API balance at a variable price for the 10 results
OpenClaude requests. Every run requests a cost limit with `max_cost_usd: 0.025`. Because it costs
money, it is never chosen automatically: having an `AIMLAPI_API_KEY` does not put it in
the `auto` search order. Switch back with `/search auto`. See
[Web Search Providers](../src/tools/WebSearchTool/README_SEARCH_PROVIDERS.md#aiml-api-toolbox-websearch)
for the request and response format.

## Verify

- `/status` shows **AI/ML API** as the active provider with the `https://api.aimlapi.com/v1` base URL.
- `/model` lists chat-capable models discovered from the catalog.
- Send any prompt to confirm responses come back from the selected model.

## WebFetch through the AI/ML API Toolbox

`WebFetch` normally fetches pages over plain HTTP and converts the HTML to
Markdown, which can miss JavaScript-rendered content. With an AI/ML API key you
can have it scrape pages through the
[AI/ML API Toolbox](https://docs.aimlapi.com/quickstart/toolbox) instead:

```bash
export AIMLAPI_API_KEY="your-aimlapi-key"
export WEB_FETCH_PROVIDER=aimlapi
```

- **Opt-in.** Each fetched page is one Toolbox run of `search1api/crawl`, billed
  to your AI/ML API balance (about $0.0013 per page on 2026-10-19). Every run
  requests a cost limit with `max_cost_usd: 0.005`. An AI/ML API key on its own
  never turns this on.
- **URL disclosure.** The full requested URL, including query parameters, is
  sent to the external AI/ML API Toolbox. Do not use this backend for private,
  internal, or token-bearing URLs.
- `WEB_FETCH_PROVIDER=aimlapi` takes precedence over `FIRECRAWL_API_KEY` /
  `FIRECRAWL_API_URL` for `WebFetch`. `WebSearch` is not affected.
- Like the Firecrawl backend, a failed scrape (a page that does not exist, a
  refused or failed run) is reported as a `WebFetch` error instead of being
  retried over plain HTTP. Within one `WebFetch` call, retries of a run request
  reuse the same input and idempotency key.
- The key and the attribution headers below are sent only to
  `https://tools.aimlapi.com`, which is fixed and cannot be overridden. When
  the active aimlapi profile points at your own proxy (a non-canonical
  `OPENAI_BASE_URL` or `OPENAI_API_BASE`), its key is treated as the proxy's
  and is not sent; set up a canonical AI/ML API key to use this backend. When
  `AIMLAPI_API_KEY` holds a comma-separated pool, only its first usable key is
  sent, with no rotation across keys. Requests never follow redirects. A
  scraped page is untrusted web content and goes through the same `WebFetch`
  processing as a page fetched over plain HTTP.

## Notes

- Model discovery uses the public, unauthenticated `GET /models` endpoint and surfaces only chat-completions models; image, audio, embeddings, and other modalities are intentionally not routed through the coding workflow.
- Every request to AI/ML API (inference, catalog, sign-in/account, checkout, and Toolbox web search) carries the two mandatory attribution headers `X-AIMLAPI-Source: agent/openclaude` and `X-AIMLAPI-Partner-ID`. On the canonical `api.aimlapi.com` endpoint the inference/catalog requests additionally send `X-AIMLAPI-Integration-*` (owner/repo/version) plus `HTTP-Referer: OpenClaude` and `X-Title: OpenClaude`; all attribution headers are stripped when a non-canonical (proxy) base URL is configured, so a third-party host never receives OpenClaude's partner identity.
- `AIMLAPI_AUTH_URL`, `AIMLAPI_APP_URL`, `AIMLAPI_PAY_URL`, and `AIMLAPI_VERIFICATION_BASE_URL` can point the complete flow at another environment. Guided **new-account** onboarding and key provisioning require the canonical `api.aimlapi.com` inference endpoint, so `AIMLAPI_INFERENCE_URL` must be unset (or left at its default) to create a new account and mint its key — a non-canonical value is rejected there. The existing-key top-up path (paste an aimlapi.com key) instead runs against whatever `AIMLAPI_INFERENCE_URL` is configured. `AIMLAPI_RETURN_URL` overrides only the browser landing page.
- Checkout success is detected by polling. The browser return target is an HTTPS page; OpenClaude does not install a custom URL-scheme handler.
- Usage (`/usage`) reporting is not supported for this provider.
