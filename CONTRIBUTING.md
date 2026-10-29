# Contributing to OpenClaude

Thanks for contributing.

OpenClaude is a rapidly evolving open-source coding-agent CLI with support for multiple providers, local backends, MCP, and a terminal-first workflow. The project is actively developed and updated frequently. Our current focus is on **stability and performance** — we're prioritizing reliable, well-tested contributions over new feature additions. The best contributions here are focused, well-tested, and easy to review.

## Table of Contents

- [Before You Start](#before-you-start)
- [Proposing New Features](#proposing-new-features)
- [Pull Requests](#pull-requests)
  - [Automated Review (CodeRabbit)](#automated-review-coderabbit)
  - [Keep Your Branch Current](#keep-your-branch-current)
  - [PR Follow-Up Requirements](#pr-follow-up-requirements)
  - [Duplicate PRs](#duplicate-prs)
  - [What Gets Closed Without Review](#what-gets-closed-without-review)
  - [Contributor Conduct](#contributor-conduct)
  - [Project Consistency](#project-consistency)
- [Development Workflow](#development-workflow)
- [AI Agent Guidelines](#ai-agent-guidelines)
- [Code Style](#code-style)
- [Provider Changes](#provider-changes)
- [Local Setup](#local-setup)
- [Validation](#validation)
- [Community](#community)

## Before You Start

- Search existing [issues](https://github.com/Twigpine/openclaude/issues) and [discussions](https://github.com/Twigpine/openclaude/discussions) before opening a new thread.
- Check [open pull requests](https://github.com/Twigpine/openclaude/pulls) for work that overlaps with your contribution. If a PR already exists that addresses the same change, open an issue or discussion first to align on direction — duplicate PRs may be closed without review.
- Use issues for confirmed bugs and actionable feature work.
- Use discussions for setup help, ideas, and general community conversation.
- For larger changes, open an issue first so the scope is clear before implementation.
- For security reports, follow [SECURITY.md](SECURITY.md).

## Proposing New Features

OpenClaude is moving toward a more **maintainer-directed roadmap**. We are focusing development efforts on stability, performance, and core reliability. As a result, new feature additions are being evaluated more carefully to ensure they align with the project's direction.

**Before investing time in a feature PR, please open an issue first** to propose and discuss your idea with the maintainers. This isn't about gatekeeping — we genuinely value your ideas and want to help shape them into contributions that fit the project's goals. The conversation will help you understand:

- Whether the feature aligns with our current roadmap
- If similar work is already planned or in progress
- The best approach that maintains project consistency

This step prevents wasted effort on PRs that might otherwise be closed without review simply because the feature doesn't match where we're taking the project. Your idea may be great — it just needs to fit the bigger picture.

## Pull Requests

Before opening a PR:

- Read this `CONTRIBUTING.md` file.
- Read [`AGENTS.md`](AGENTS.md) for repo-specific coding-agent conventions, validation commands, provider guidance, and architecture rules.
- Re-check open and recently closed PRs for duplicates.
- Keep the branch focused on one issue or one clearly scoped improvement.
- Run the checks required for the affected surfaces in [Validation](#validation) before opening the PR. After pushing, monitor CI and automated review until the PR is ready for maintainer review.

Every PR needs a reason. Your PR description must include:

- confirmation that you reviewed both this `CONTRIBUTING.md` file and [`AGENTS.md`](AGENTS.md)
- what changed and why
- the user or developer impact
- the exact checks you ran
- a linked issue when one exists, using `Fixes #123`, `Closes #123`, or another clear link
- screenshots when the PR touches UI, terminal presentation, or the VS Code extension
- which provider path was tested when the PR changes provider behavior

The PR author is responsible for a reviewable, merge-ready contribution: passing applicable local checks, green CI on the current revision, and addressed automated review feedback. This applies to the initial PR and follow-up pushes. Keep work in progress as a draft; do not request maintainer review with unresolved PR-owned failures. PRs with merge conflicts will not be reviewed or approved until the conflicts are resolved. Verified pre-existing failures follow the exception in [Validation](#validation).

Issues are the recommended starting point for anything non-trivial — opening one first helps avoid wasted effort if the change is out of scope or already being worked on. Small fixes, doc corrections, and obvious improvements can stand on their own without a linked issue, as long as the PR description explains the intent.

### Automated Review (CodeRabbit)

We use [CodeRabbit](https://coderabbit.ai) to assist with PR reviews. CodeRabbit will automatically review your PR and leave comments on potential issues, bugs, or style concerns.

**PR authors must follow up on CodeRabbit findings until CodeRabbit approves the current revision**, or a maintainer explicitly accepts a documented exception. Fix valid, in-scope findings, reply with the resolution, and request another automated review when needed. A PR may not receive maintainer review while requested fixes remain unaddressed, even if CI is green. Do not leave the maintainer to chase feedback or finish the author's validation.

One important caveat: **verify each suggested change against your PR's stated scope and intent before applying it.** Automated reviewers can suggest fixes that accidentally force changes to surfaces you never intended to touch, or that quietly pull the PR away from its original framing. When a suggestion would cause that kind of drift:

- you may decline it with a brief justification in the comment thread
- when unsure whether a suggestion is in scope, ask a maintainer before applying or declining it

Declining an incorrect or out-of-scope suggestion with evidence and a clear reason is acceptable. Explain why it is incorrect or would cause scope drift in the comment thread, continue resolving the remaining findings, and seek a maintainer decision if the disagreement still blocks approval. Do not expand the PR merely to obtain automated approval. Silently ignoring findings is not acceptable: every finding needs a fix, a justified decline, or an explicit escalation.

### Keep Your Branch Current

Keep the PR mergeable. **Rebase when conflicts need resolving**, or when a maintainer identifies a specific upstream change needed for correctness or validation. You do not need to rebase merely because `main` advanced, you resumed work, or you are pushing a review fix. Ordinary follow-ups can be new commits on the existing branch.

Check relevant upstream changes before acting on stale review feedback. After a rebase or conflict resolution, rerun checks whose inputs or behavior changed under [Validation](#validation); use the full local preflight when the integration has broad impact.

Before rebasing an already-pushed PR branch, fetch the current remote PR head, record its exact commit SHA, and incorporate any commits that were added to the remote branch. Then fetch upstream `main` and rebase. Publish with an explicit lease pinned to the PR-head SHA you recorded, never an unguarded `--force` or an unqualified lease:

```bash
git push --force-with-lease=refs/heads/<pr-branch>:<recorded-pr-head-sha> <pr-remote> HEAD:refs/heads/<pr-branch>
```

Pinning the expected SHA prevents a background fetch from silently moving a remote-tracking ref and weakening the lease. If the lease is rejected, stop: fetch and inspect the new remote PR head, incorporate its commits, redo the rebase, and retry with that newly recorded SHA. If the branch is shared or does not allow force-pushes, coordinate with a maintainer and use a repository-approved non-rewriting update path instead of discarding remote work.

Resolve conflicts before requesting review. A branch being behind `main` is not by itself a reason to rewrite it or repeat unrelated local checks.

### PR Follow-Up Requirements

Submitting a PR is a commitment to see it through to the end. Review here is in-depth and can take multiple rounds — do not be surprised if every review pass results in follow-up fix requests; that is the normal shape of this project's review process, not a signal that your PR is unwelcome. Please be prepared to:

- **Respond to review feedback within 1 week** of a maintainer or CodeRabbit review request
- **If you need more time**, leave a comment explaining your situation and expected timeline
- **PRs with no activity for 2 weeks after a review request** will be closed as abandoned. At that point, another contributor may pick up the work under a new PR

This policy ensures the project stays maintainable and that contributor queue doesn't grow stale. We understand life happens — a quick note explaining a delay goes a long way.

Once applicable CI is green and automated feedback is resolved, the PR is ready for maintainer review. Maintainers own the final design review, acceptance decision, and merge. They may choose to take over integration or follow-up work, but contributors should not assume that handoff: continue to address new requests unless a maintainer explicitly takes ownership. While waiting, no periodic rebase, full local rerun, or new push is required solely to keep the PR active. Green checks make a PR eligible for review; they do not guarantee acceptance.

If you find yourself getting fix requests on every round, treat that as a signal rather than noise: repeated findings on the same PR usually trace back to a core design issue, with each surface-level patch exposing another symptom. Investigate the root cause of what reviewers are flagging instead of patching the reported problem. And if you are driving the work with an AI agent, this is also the moment to re-evaluate how you are prompting it — vague or narrow prompts produce surface fixes; detailed instructions to investigate the requested change and its surrounding design produce fixes that hold up under review.

### Duplicate PRs

We are proactive about closing duplicate PRs. Before submitting, **it is your responsibility to check** whether a similar PR already exists:

- Search [open pull requests](https://github.com/Twigpine/openclaude/pulls) for related work
- Check [closed pull requests](https://github.com/Twigpine/openclaude/pulls?q=is%3Apr+is%3Aclosed) to see if similar work was previously addressed or declined
- If you find an existing PR, engage in that thread rather than opening a new one

Duplicate PRs will likely be closed without review or follow-up. This isn't personal — it's about keeping the review queue focused and efficient.

### What Gets Closed Without Review

PRs may be closed without review if they:

- duplicate work already covered by an open pull request
- bundle unrelated fixes, features, or refactors into a single PR without prior discussion and maintainer approval
- add features, refactors, or dependency changes that were not discussed first
- drift from the approved scope of a linked issue
- change the project's language, core runtime, or dependency stack without prior maintainer agreement
- are drive-by contributions with no context, no tests, and no clear purpose
- submit a PR with the [PR template](.github/pull_request_template.md) ignored — generic filler text or leftover template placeholders (`what changed`, `provider/model path tested:`, etc.) show the description was not written for your PR. These will not be reviewed until corrected and risk being closed without review
- are automated bounty-hunting or mass-submitted PRs that provide little meaningful value to the codebase
- are advertisements, sales pitches, or promotional submissions for a product or service — open an issue first to discuss with maintainers if you believe your product or service is relevant to this project

This is not a judgment on the contributor. It is how the project stays reviewable. If your PR is closed, the best next step is to open an issue, clarify the intent, and get alignment before re-submitting.

### Contributor Conduct

We want OpenClaude to be a welcoming community, but we must also protect the project's quality and contributor time. The following actions will result in a **ban from future contributions**:

- Repeated fly-by PRs with no follow-up after review requests
- Repeated submission of duplicate PRs
- Ignoring CodeRabbit findings and waiting for maintainer override
- Automated or mass-submitted PRs that provide little meaningful value

We don't take this lightly. If you're unsure whether your contribution is a good fit, open an issue first — we're happy to help guide you.

### Project Consistency

Stay within the project's existing technical direction. PRs that shift the codebase to a new language, significantly restructure dependencies, or introduce a new runtime are unlikely to be accepted without prior discussion.

Dependency changes need a clear project benefit — fixing a bug, addressing a security issue, or supporting an approved feature. Preference-based reasoning alone is not enough — explain the concrete benefit.

## Development Workflow

- Keep PRs focused on one problem or feature.
- Avoid mixing unrelated cleanup into the same change.
- Preserve existing repo patterns unless the change is intentionally refactoring them.
- Add or update tests when the change affects behavior.
- For vendor/integration catalog tests, cover each vendor with one table-driven test of its registry contract (route resolution, default base URL and model, credential env vars, catalog-to-descriptor linkage, and capability/limit values the runtime uses), plus a small number of behavioral tests such as model-discovery keep/drop parsing or availability windows. Do not copy full curated model lists or cache/refresh settings from vendor definitions into tests.
- Test files share a process within each run or shard; restore `mock.module` registrations, environment variables, globals, and process state in `afterEach`/`afterAll`.
- Git discovery honors `GIT_CEILING_DIRECTORIES` in both filesystem lookups and Git subprocesses. Use an explicit ceiling for temporary fixtures that must exclude enclosing repositories; a ceiling prevents ascent into that directory without excluding the starting working directory. Separate multiple absolute ceiling directories with the platform's path-list delimiter.
- When tests set or delete environment variables, import `snapshotEnv` from `src/test/envSnapshot.ts` using the appropriate relative `.js` path. In `beforeEach`, save the named variables before changing them with `restoreEnv = snapshotEnv(keys)`; pass `{ clear: true }` when setup needs those variables unset. Call `restoreEnv()` in `afterEach`, or use `finally` for changes scoped to one test. Restoration preserves previous values, including empty strings, and deletes variables that were previously unset. List only the variables the test changes or deliberately clears; do not replace `process.env` or blanket-clear unrelated variables. When using the shared mutation lock, snapshot after acquiring it and restore before releasing it.
- In timing-sensitive tests, drive timers with Bun's fake timers (`jest.useFakeTimers()` and `jest.advanceTimersByTime()`) instead of racing real delays, and restore real timers during cleanup, so the tests pass in a single-process whole-suite run as well as in the sharded runner.
- Await completion promises or explicit readiness signals before asserting asynchronous results. For tests that deliberately suppress readiness, use a short, bounded wait and assert the expected failure.
- For tests that launch real subprocesses, set an explicit per-test timeout longer than the child-process deadline, leaving time for assertions and cleanup. The launcher heap tests use an 8-second child deadline and a 10-second test timeout. Document the reason for the timeout beside the test.
- Update docs when setup, commands, or user-facing behavior changes.
- Website release notes live on GitHub Releases. Do not add manually maintained release-note data to the static site.

AI-assisted and vibe-coded contributions are welcome, but please review your own changes thoroughly before opening a PR. Even frontier models produce subtle bugs, incorrect assumptions, and code that looks right but isn't.

Before submitting, run multiple rounds of review on generated code:

- check for correctness, not just whether it compiles
- verify style consistency with the rest of the codebase
- remove unnecessary changes or auto-generated noise
- confirm adherence to the project's patterns and architecture
- ask your AI assistant "are you sure there are no issues with this code?" — this alone can surface problems that would otherwise slip through

Self-review up front saves everyone time and reduces back-and-forth during maintainer review.

### Markdown parsing and rendering

Use the exact `marked` version in `package.json` and its bundled TypeScript types;
import `marked`, `Lexer`, `Token`, or `Tokens` from the package's ESM entry point.
Do not add `@types/marked` or a separate rendering extension. Use
`configureMarked()` before terminal lexing and `formatToken()` / `applyMarkdown()`
for terminal output; strikethrough parsing is deliberately disabled.

List items can contain `paragraph` children and `checkbox` tokens. Preserve list
markers for paragraph children and omit checkbox glyphs in terminal output. Pass
the previous sibling to `formatToken()` when rendering block sequences so separate
`space` tokens do not duplicate spacing after headings, tables, or indented code.
Indented code has trailing newlines removed for terminal display and `/copy`;
fenced code retains its content. Keep streaming boundary calculations on the
complete lexer token stream, including whitespace and each token's `raw` length.

CLAUDE.md parsing uses its own `new Lexer({ gfm: false })` to preserve include
paths. When removing a comment-only HTML block, consume its following whitespace
token too; preserve whitespace with visible comment residue and leave code blocks
untouched. When updating `marked`, compare representative terminal, table, list,
code, link, streaming, and memory-file output and run the markdown regression tests.
Regenerate the exact dependency pin and lockfile with `bun add --exact marked@<version>`.

### Subprocesses and terminal colors

Development scripts run under Bun and use `Bun.spawn` or `Bun.spawnSync`.
Use argument arrays and set stdin, stdout, stderr, cwd, environment, and deadlines
explicitly to preserve the command contract. The capture helper in
`scripts/subprocess.ts` returns UTF-8 stdout and stderr, a nullable status, and
launch, timeout, or output-limit errors for synchronous probes. Check errors and
status before consuming output. Keep the fixed processor probe's platform shell
invocation when testing command wrappers; never interpolate user input into it.
The clean-install verifier retains its existing command runner for cross-platform
package-manager wrappers. The startup benchmark runs under Node to measure its
startup and compile cache; its process calls and the real Node pipe observer in
the test runner's backpressure fixture use Node's process API.

Use the exact `execa` and `chalk` pins in `package.json` and their public ESM
exports and bundled types. Regenerate both pins and the lockfile with
`bun add --exact execa@<version> chalk@<version>`.

Prefer asynchronous `execa(file, args, options)`; use `shell: true` only for
commands that need shell syntax. With `reject: false`, check `failed`,
`timedOut` and `exitCode` before consuming `stdout` or `stderr`. Use
`SyncOptions` for synchronous options. The subprocess is a promise; access
Node child-process event and lifecycle APIs through `subprocess.nodeChildProcess`.
Use template strings or `parseCommandString()` for command splitting, and
`ipc: true` for IPC. Explicit `input` takes precedence over inherited stdin;
set stdin deliberately, and bound subprocess output with `maxBuffer` and
execution time with `timeout`.

Use the shared default `chalk` instance for terminal styles and the existing
`colorize()` and theme helpers for theme colors. Keep the VS Code color boost
and tmux clamp in `src/ink/colorize.ts`. Numeric `FORCE_COLOR` selects an exact
level (0 disables color, 1 selects 16 colors, 2 selects 256, 3 selects truecolor);
`ansi256()` and `bgAnsi256()` downsample at level 1. Use `new Chalk({ level })`
only when a separate capability level is intentional, as for Apple Terminal
charts. Tests that change `chalk.level` must restore it, and environment-driven
color detection tests must import in a fresh process.

### CLI argument parsing

Keep `commander` and `@commander-js/extra-typings` pinned together at exactly
`15.0.0`; the typings peer requires `commander ~15.0.0`. Regenerate `bun.lock`
with `bun install` after changing both pins. Use their public ESM exports.

Declare positional arguments explicitly, including variadic arguments for commands
that forward subprocess arguments. Excess arguments are rejected by default.
Short flags must be a single character; use `--debug-to-stderr` in place of the
unsupported `-d2e` spelling. Dual long flags, such as `--yolo` and
`--dangerously-skip-permissions`, are supported. When registering both positive
and negative boolean flags, set an explicit default only if the command needs one;
otherwise the omitted option remains undefined. Keep help and parse-error checks
on the built CLI so command registration is exercised under Node.

### Dependency pins and overrides

Terminal syntax highlighting uses the exact `highlight.js` pin directly, with
the shared Chalk instance for ANSI colors. Keep the lazy loader and terminal
palette in `src/utils/cliHighlight.ts` for terminal code and Markdown highlighting
only. Structured diff rendering in `src/native-ts/color-diff/index.ts` loads
`highlight.js` separately. Run the highlighting and Markdown regression tests
when changing this dependency or its ANSI renderer.

Keep all direct dependencies and devDependencies pinned to exact versions in the
root and web manifests. Regenerate the relevant Bun lockfile
when changing a pin.

Schema validation uses Zod `4.6.7`, pinned exactly in the root development
dependencies and in the root and website resolution overrides. Import
`zod/v4` for application schemas, use native conversion through the shared
`zodToJsonSchema` helper, and preserve validation messages and generated schema
contracts. Follow [Schema validation](docs/schema-validation.md) for object
strictness, defaults, error customization, dependency compatibility and SDK
peer handling. Regenerate both lockfiles with `bun install` after changing
the shared pin.

The static website in `web/` uses Astro `7.4.2`, `@astrojs/check` `0.9.12`,
and `@astrojs/sitemap` `3.7.4`, all pinned exactly. Install its dependencies
with `bun install --cwd web`, then run `bun run web:typecheck` and
`bun run web:build` from the root. The build includes `scripts/verify-dist.ts`
to check rendered navigation, release redirects, sprites, and sitemap entries.
Astro's Node.js `>=22.23.4` requirement is covered by the repository's
`>=24.22.1` runtime floor. Keep `compressHTML: true` in the site config to
preserve HTML-aware whitespace compression; Astro 7 defaults to JSX whitespace
rules. The site uses Astro templates and typed data without remark or rehype
plugins, so it does not need the optional `@astrojs/markdown-remark` peer.
If adding those plugins later, install a compatible exact pin and configure
the Markdown processor according to the Astro 7 upgrade guide.

Linting uses ESLint `10.13.0` with `@typescript-eslint/parser` and
`@typescript-eslint/eslint-plugin` both pinned to `8.72.0`, which support ESLint 10.
Keep these pins compatible and regenerate `bun.lock` with `bun install` after
updating them. Run `bun run lint` from the repository root; ESLint 10 discovers
`eslint.config.js` from each linted file's directory. The JavaScript flat config
does not require `jiti` or extend a recommended preset. Keep its explicit rules
and ignores when upgrading. ESLint's Node.js requirement is covered by the
supported Node.js `>=24.22.1` runtime.

Keep `chokidar` pinned exactly to `6.0.0` and use its public ESM exports and
bundled types. Pass literal paths rather than globs. Use `backend` to select
watching behavior and `pollingInterval` / `pollingBinaryInterval` for polling;
`awaitWriteFinish.pollInterval` is a separate, unchanged option. Skill watching
uses the polling backend under Bun with explicit `atomic: true` to preserve
atomic-save handling. Await `close()` when teardown must finish, and create a
new watcher for subsequent subscriptions because closing is terminal. Its
Node.js 22.22 minimum is covered by the supported Node.js `>=24.22.1` runtime.
Regenerate `bun.lock` with `bun install` after updating the exact pin.

Keep `@sentry/node` pinned exactly to `11.9.0` and regenerate `bun.lock` with
`bun install` after updating it. The optional reporter uses a lazy ESM import
after trust is established. Keep default integrations and tracing disabled,
set `attachStacktrace: false`, and explicitly disable `dataCollection` categories
so only vetted messages are reported. Do not add automatic instrumentation or
an OpenTelemetry provider to this path. Run `bun test src/utils/sentry.test.ts`
when updating the SDK or initialization. Its Node.js minimum is covered by the
supported runtime; self-hosted Sentry requires 26.4.2 or later.

The root `overrides` block also controls transitive resolutions:

- `ip-address`: `10.7.4` sets the security floor for the MCP SDK's
  `express-rate-limit` dependency path.
- `google-auth-library`: `11.3.1` keeps Google authentication on the same version
  as the direct dependency. The override accompanies the replacement of the
  legacy Vertex SDK to remove its deprecated UUID dependency path.
- `lodash-es`: `4.18.1` keeps transitive copies on the security fixes for template
  code injection and prototype pollution, avoiding the deprecated `4.18.0` release.
- `node-domexception`: the existing shim re-exports the platform's native
  `DOMException` for `fetch-blob`, replacing the deprecated polyfill.

## AI Agent Guidelines

If you are an AI agent (Copilot, Cursor, Claude, etc.) working on this codebase, refer to [AGENTS.md](AGENTS.md) for project-specific coding guidelines, conventions, and validation commands. Following these guidelines will help your contributions align with the project's patterns and reduce review friction.

In particular: link release-notes navigation to GitHub Releases rather than adding a local changelog page or manually maintained release data.

## Code Style

- Follow the existing code style in the touched files.
- Prefer small, readable changes over broad rewrites.
- Do not reformat unrelated files just because they are nearby.
- Keep comments useful and concise.

When working on diff generation or rendering, import public APIs and types from
`diff`; the package supplies its own TypeScript declarations, so do not add
`@types/diff` or import internal library paths. Use `diffWordsWithSpace` when
rendering must preserve whitespace. Keep patch filenames separate from hunk
content: serialized headers may quote or escape filenames, and parsed patches
can omit filenames. Check the diff and edit-snippet tests when changing these
paths.

### Proxy agents

Use the exact `undici` 8.12.3 pin and its public exports and bundled types.
Regenerate `bun.lock` with `bun install` after changing the manifest pin.
Its Node.js minimum is covered by the supported `>=24.22.1` runtime.
Wrap per-request fetch dispatchers with the public `Dispatcher1Wrapper` so
Node 24's native fetch can use its legacy callbacks; the wrapper also accepts
the current handler API. `setGlobalDispatcher()` handles the global bridge.
Undici 8 enables HTTP/2 by default; the bridge keeps legacy requests on HTTP/1.1.
Set `proxyTunnel: true` to retain CONNECT for plain HTTP targets. Normalize
leading `*.` bypass entries to `.` before constructing the environment proxy
dispatcher so apex and subdomain bypasses continue to match the shared helpers.
Keep custom TLS options on `Agent.connect` for direct requests, including
`NO_PROXY` bypasses, and on `ProxyAgent.requestTls` for CONNECT targets.

Use the shared helpers in `src/utils/proxy.ts`: `createAxiosInstance()` for
Axios, `getWebSocketProxyAgent(url)` for Node WebSockets, and `getProxyFetchOptions()`
for fetch. The Axios and WebSocket helpers apply `NO_PROXY` bypasses before
selecting an agent. `getWebSocketProxyUrl(url)` supplies Bun's native WebSocket proxy
option. Lowercase proxy environment variables take precedence over uppercase
variants on the Axios, WebSocket, and fetch/undici paths. The shared helpers read
`no_proxy` before `NO_PROXY` using `??`, so an empty lowercase `no_proxy` is kept
and does not fall back to `NO_PROXY`.

`https-proxy-agent` is pinned exactly to `9.1.0` and remains an external runtime
module in `scripts/externals.ts`. Use its public named ESM exports, such as
`import { HttpsProxyAgent } from 'https-proxy-agent'`, and the constructor
`new HttpsProxyAgent(proxyUrl, options)`. Both it and `agent-base` are ESM
packages requiring Node.js 20 or later; use OpenClaude's supported Node.js
`>=24.22.1` runtime. Keep dependency updates exact and generate `bun.lock` with
`bun add --exact https-proxy-agent@<version>`.

Keep TLS verification enabled. Configure `NODE_EXTRA_CA_CERTS` before starting
the CLI when a custom CA is needed. For runtime certificate configuration, the
shared CA loader reads that file and the TLS helpers supply explicit options;
clear the CA and mTLS caches after configuration changes. Structured I/O
environment updates to TLS or proxy settings refresh CA, mTLS, and proxy caches
and global agents; effective bypass-list changes do the same. Proxy-agent
constructor options configure the connection to the proxy. Supply target TLS
options on the HTTPS request, using `getWebSocketTLSOptions()` where applicable;
do not assume constructor `ca` options also trust the target inside a CONNECT
tunnel. Run `bun test src/utils/proxy.connect.test.ts src/utils/proxy.test.ts`
when changing these paths to verify HTTPS CONNECT routing and `NO_PROXY`
bypass with certificate validation enabled.

## Provider Changes

OpenClaude supports multiple provider paths. Before contributing provider changes, review the relevant documentation to ensure your implementation follows the expected patterns:

- start with `docs/integrations/overview.md` for an understanding of how integrations are structured
- use the focused how-to guides under `docs/integrations/how-to/` for new vendors, gateways, models, anthropic proxies, and `/usage` support
- PRs that skip documented patterns or introduce inconsistent provider behavior may be sent back for rework

When submitting provider changes:

- be explicit about which providers are affected
- avoid breaking third-party providers while fixing first-party behavior
- test the exact provider/model path you changed when possible
- call out any limitations or follow-up work in the PR description
- do not assign or use provider tags — these are controlled by maintainers and will be applied during review

## Local Setup

Use Node.js `>=24.22.1` (Node 26 recommended/default) and Bun `1.4.4` (tracked in `.bun-version`).

Keep `@types/node` on the Node 24 major to match the minimum supported runtime, even when developing on Node 26. Pin it to an exact published 24.x version; the type package version does not need to match the Node.js runtime patch version.

Install dependencies:

```bash
bun install
```

Build the CLI:

```bash
bun run build
```

Smoke test:

```bash
bun run smoke
```

Full local check:

```bash
bun run check
```

Run the app locally:

```bash
bun run dev
```

If you are working on provider setup or saved profiles, useful commands include:

```bash
bun run profile:init
bun run dev:profile
```

## Validation

This section is the **authoritative local validation contract**; `AGENTS.md` and the PR template defer to it. Select checks by what the change can affect, not just its size. Applicable lint, static checks, type checks, and regression tests are mandatory. A focused test pass does not replace these checks, and green CI does not excuse deliberately skipping applicable local validation.

CI evaluates the **complete PR diff**, including after a small follow-up push. PR Checks skips code jobs for Markdown/docs-only PRs unless `.github/` is touched; otherwise its code filter selects all unit shards, static checks, type checks, and launcher checks, not individual subsystems. The web job is selected independently. The intent scan runs on every PR, and every PR Checks job runs on pushes to `main`. See `.github/workflows/pr-checks.yml` for exact filters.

### Required merge checks

The stable checks are `PR checks required`, `Install hygiene required`, and `VS Code launcher required`. Each reports on every PR: selected jobs must pass, while jobs for untouched surfaces may skip. Failed change detection, failed or cancelled jobs, and unexpectedly skipped applicable jobs fail the corresponding check. Documentation-only PRs still run the intent scan and existing CodeQL checks; they do not wait for unrelated application, install, or extension jobs.

For repository administrators: after these workflows are merged into `main`, add these three check names to the branch ruleset as required checks from GitHub Actions, preserving the existing CodeQL requirements. Do not require individual matrix jobs or path-filtered workflow names. Enable the requirements only after the workflows are available on the base branch; existing PRs may need an update to pick up the new jobs. Keep the requirement to update branches before merging disabled unless a separate policy change is intended.

### Select the required local checks

Before the initial PR, apply this table to the complete proposed diff. Combine rows when more than one surface is affected. Before a follow-up push, apply it to the update since the last successfully validated revision, subject to the reuse rules below.

| Affected surface | Required local validation |
| --- | --- |
| Prose-only Markdown/docs, including PR-template wording, with no executable examples or site/build inputs changed | Review rendering, links, and documented commands for accuracy; `git diff --check`; PR intent scan. No application build, lint, typecheck, or unit suite is required solely for prose. |
| CLI, SDK, providers, shared source, root tests or scripts | Core checks below, plus the regression tests for the changed behavior and affected callers. Use the full preflight for broad impact. |
| Website content, assets, templates or tooling under `web/`, or shared inputs affecting the site | Website typecheck/build below and relevant site tests. Add core/full checks when root code or shared tooling is also affected. |
| Root dependencies/lockfile, runtime/toolchain pins, lint/type/build/test configuration, CI workflows, or changes spanning shared runtime behavior | Full local preflight below, plus website checks when its inputs are affected. |
| VS Code extension | `npm --prefix vscode-extension/openclaude-vscode run lint` and `bun run --cwd vscode-extension/openclaude-vscode test`; add core checks if CLI behavior is affected. Windows launcher changes also need the launcher test in `.github/workflows/vscode-launcher.yml`; disclose local platform limits and follow that CI result. |

For a documentation change to executable examples, run the relevant commands/tests as well. A Markdown extension does not make executable content safe to leave unchecked. When the impact is uncertain, broaden validation; do not guess that a check is inapplicable.

### Follow-up pushes

- Rerun the applicable lint, static and type checks whenever their inputs change. For a root code/test fix, run the core checks and affected regression tests; the full unit suite is not required merely because another commit is being pushed.
- Reuse a successful result only while its inputs, dependencies, configuration and relevant upstream behavior are unchanged. Record the previously validated revision and which results remain applicable. Rebase/conflict resolutions invalidate affected results, not automatically every result.
- A prose-only follow-up to a code PR can reuse its earlier code validation, but CI still evaluates the whole PR. A dependency, shared-runtime or configuration change requires broader validation even if its diff is one line.
- Update the PR's testing notes with the new commands/results, the validation scope, and reasons for any inapplicable or blocked checks. An unrun, failed or incomplete applicable check is not a pass; document a blocker and keep the PR in draft until it is resolved or a maintainer explicitly accepts an exception.
- After every push, monitor CI and CodeRabbit, diagnose failures and fix PR-owned problems before requesting maintainer review. Initial and follow-up CI success remains the author's responsibility. Do not repeatedly push known failures and leave maintainers to investigate them.

### Commands

Install root dependencies with `bun install --frozen-lockfile` before validation in a fresh checkout, and again when the root manifest or lockfile changes. An unchanged, successfully installed dependency tree may be reused between follow-ups. Keep lockfiles in sync; a cache hit does not replace the required checks.

Core checks for root code/test changes:

```bash
bun run check:static
bun run typecheck:fast
bun run typecheck:type-tests
node bin/openclaude --version
```

`check:static` includes **ESLint**, the any-usage budget, the smoke build, and deadcode checks. It is also the static-check command run by CI. `bun run lint` runs ESLint alone; do not run it a second time after a successful `check:static` unless its inputs changed. ESLint's current configuration warns on explicit `any` and excludes the website and extension; the separate budget check enforces the tracked limits. A passing root lint does not replace those surfaces' own checks.

Add focused tests using the guarded runner (replace the example path):

```bash
bun run test ./path/to/test-file.test.ts
```

Include affected callers and integration paths, not only the edited file. Run `bun run test:conversation-arc` or `bun run test:context-efficiency` when changing those feature paths; their flags differ from the default unit pass. For provider changes, test the affected provider/model path as described above.

Full local preflight for broad changes (use this **instead of** separately running `check:static` and the same unit tests):

```bash
bun run check
bun run typecheck:fast
bun run typecheck:type-tests
node bin/openclaude --version
```

Run the compile-cache-disabled launcher check below whenever core or full checks apply. Run the PR intent scan before every push, including documentation changes. The scan reads commits: commit the validated changes before scanning `HEAD`, and rerun it if you add or amend commits before pushing. A scan of an unchanged `HEAD` does not cover uncommitted edits.

The security scan requires the commit ancestry needed to find the PR's merge base. Check whether your clone is shallow:

```bash
git rev-parse --is-shallow-repository
```

If that prints `true`, fetch the rest of the current branch's history before running the preflight (replace the default remote if your PR branch is tracked elsewhere):

```bash
git fetch --unshallow
```

PR intent scan (fetching does not rebase your branch):

```bash
git fetch https://github.com/Twigpine/openclaude.git main
bun run security:pr-scan -- --base FETCH_HEAD --head HEAD
```

Compile-cache-disabled launcher check, when core or full checks apply, using the syntax for your shell:

Bash, zsh, and similar shells:

```bash
NODE_DISABLE_COMPILE_CACHE=1 node bin/openclaude --version
```

PowerShell:

```powershell
& {
  $previousValue = [Environment]::GetEnvironmentVariable('NODE_DISABLE_COMPILE_CACHE', 'Process')
  try {
    $env:NODE_DISABLE_COMPILE_CACHE = '1'
    node bin/openclaude --version
    $launcherExitCode = $LASTEXITCODE
    if ($launcherExitCode -ne 0) {
      throw "Launcher compatibility check failed with exit code $launcherExitCode"
    }
  } finally {
    [Environment]::SetEnvironmentVariable('NODE_DISABLE_COMPILE_CACHE', $previousValue, 'Process')
  }
}
```

If the PR can affect the website — including changes under `web/`, root or web dependency and lock files, shared site assets or content, or build/toolchain configuration used by the site — also run:

```bash
bun install --cwd web --frozen-lockfile
bun run web:typecheck
bun run web:build
```

Notes on the local preflight:

- `bun run typecheck:fast` runs Bun's builtin type checker against `tsconfig.json` and is the CI typecheck. Its wrapper resolves the config relative to the script and runs from outside the repository because the package's `check` script shadows `bun check` inside the project. Use `bun run typecheck:fast` from the root or a subdirectory; from elsewhere, use `bun run --cwd /path/to/openclaude typecheck:fast`. `bun run typecheck:type-tests` also runs in CI and uses TypeScript for focused type assertions. Keep the `typescript` devDependency for these assertions, ESLint, and `@astrojs/check`.
- PR Checks caches Bun package downloads using OS-scoped keys derived from `bun.lock` for root installs and `web/bun.lock` for web installs, with separate restore prefixes. Dependency installs still run with `--frozen-lockfile` on cache hits. Keep the relevant lockfile in sync with dependency changes and run the required local preflight regardless of cache status.
- `bun run check` runs `check:static` (ESLint, the any-usage budget, smoke build, and deadcode checks), then the full unit pass (`test:full`) — do not run those separately, or you execute work twice.
- `bun run test` runs test files in a shared process and requires Bun's completed JUnit report as well as a successful exit. `test:full` runs all eight native Bun shards serially to release memory between groups. Use `bun run scripts/run-tests.ts --shards=N --shard-index=K` with the same test flags to run only shard K of N. `test:full` then applies the same completion check to the conversation-arc pass and the context-efficiency pass with `HISTORY_SNIP` enabled. Every shard must produce a complete report; a failed shard does not prevent the remaining shards from running. A test that terminates the runner early fails the command, even if it exits with code zero. Each shard has a ten-minute deadline (override with `--shard-timeout-ms=<milliseconds>`), reports its start/end and elapsed time, and kills its process group on timeout or cancellation. A timeout stops the remaining shards and exits nonzero. On Linux, shard output is relayed from temporary regular files; diagnostics remain visible during execution. Temporary reports and logs are removed after the check. CI runs `check:static` in `smoke-and-tests`, runs the eight unit shards as parallel `unit-tests` jobs, and runs each dedicated feature pass once in `dedicated-tests`. Each unit shard builds the CLI before testing. CI caps these jobs at 15 minutes each and the other jobs at five minutes.
- Fetching upstream `main` by URL avoids assuming that a fork checkout's `origin` points at Twigpine/openclaude. `FETCH_HEAD` is the fetched upstream tip. The scan deliberately uses local `HEAD` so it includes commits that have not been pushed yet; CI uses the pushed PR head SHA after the push.
- The web CI job runs on PRs that change `web/**`, root `package.json` or `bun.lock`, `.bun-version`, or `.github/workflows/pr-checks.yml`, and on every push to `main`. Contributors do not need to run the web suite locally for changes that cannot affect the site.
- The full preflight covers the same command families as PR Checks, but focused local validation deliberately runs fewer tests. Neither reproduces CI exactly in one shell. When selected, CI runs static checks with Node 26 available for smoke checks, runs the unit shards and dedicated feature passes under Node 26, separately builds and checks launcher compatibility under Node 24.22.1 and 26, separately builds and launches under exact Node 24.22.1, and executes every job on a clean runner.

If a local or GitHub CI check fails, first determine whether the PR owns the failure. Treat a failure as pre-existing only when you can reproduce it on the PR's current base (or link to the same failure on a current `main` CI run) and the PR neither changes the causal surface nor claims to fix that problem.

For a verified pre-existing failure:

- record the failing check, relevant output, and base commit or `main` CI run in the PR
- note the pre-existing failure in the PR summary or testing notes so maintainers can track it separately; link an existing issue when one is already available
- explain briefly why the failure is unrelated to the PR

The contributor may then proceed and is not responsible for repairing that failure in the current PR. A maintainer may still need to rerun or waive a required GitHub check, or land the separate fix, before branch protection permits a merge. Failures caused by the PR, or in behavior the PR claims to fix, remain the author's responsibility and must be resolved.

PRs with unresolved PR-owned CI failures are not ready for maintainer review and will not be merged. All applicable CI must pass on the final revision before merge; jobs legitimately skipped by their path filters are not failures. Verified pre-existing failures follow the exception above.

### Recommended Local Checks

These are not enforced by CI but are worth running locally before submitting.

Additional local TypeScript check against the same `tsconfig.json`:

```bash
bun run typecheck
```

Provider/runtime diagnostics:

```bash
bun run doctor:runtime
```

## Community

Please be respectful and constructive with other contributors.

Maintainers may ask for:

- narrower scope
- focused follow-up PRs
- stronger validation
- docs updates for behavior changes

That is normal and helps keep the project reviewable as it grows.
