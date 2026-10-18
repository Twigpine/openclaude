# AGENTS.md - AI Agent Coding Guide

This guide is for AI coding agents working in the OpenClaude repository. Read it before changing code, and also follow [CONTRIBUTING.md](CONTRIBUTING.md) for contributor policy, PR expectations, review follow-up, and project scope.

## Project Snapshot

OpenClaude is a coding-agent CLI for cloud and local model providers. It supports OpenAI-compatible APIs, Anthropic, Gemini, DeepSeek, Ollama, MCP, local backends, slash commands, tools, agents, and a React/Ink terminal UI.

The installed CLI runs on Node.js `>=22.0.0`. Bun is used for source builds, scripts, dependency management, and tests.

## Work Style

- Keep changes focused on one problem.
- Prefer existing patterns in the file or nearby module.
- Avoid unrelated formatting, renames, dependency changes, or broad rewrites.
- Add or update tests when behavior changes.
- Update docs when setup, commands, provider behavior, or user-facing behavior changes.
- For new features, larger refactors, dependencies, or runtime changes, follow the issue-first guidance in [CONTRIBUTING.md](CONTRIBUTING.md).
- Keep PR branches current with `main` using the synchronization and guarded-push workflow in [CONTRIBUTING.md § Keep Your Branch Current](CONTRIBUTING.md#keep-your-branch-current). Rebase whenever resuming work or pushing follow-up fixes, but never overwrite remote PR-head updates with an unguarded force-push.
- Run the authoritative local pre-push validation contract defined in [CONTRIBUTING.md § Validation](CONTRIBUTING.md#validation) before every push to a PR, not just the first one. CI adds clean-runner and supported-Node-matrix coverage that is not practical to reproduce in one local shell.

## Stack And Conventions

- TypeScript with strict mode and ESM imports.
- React + Ink for terminal UI.
- Bun lockfile and Bun scripts for development workflows.
- Node runtime for the built CLI.

Common libraries and patterns:

- `chalk` for terminal color.
- `commander` for CLI argument parsing.
- `execa` for child processes.
- Existing service, provider, settings, permission, and UI patterns over new abstractions.

## Repository Map

- `src/commands/` - slash and CLI command implementations.
- `src/components/` - React/Ink UI components.
- `src/services/` - API, MCP, OAuth, wiki, voice, and other service integrations.
- `src/tools/` - tool implementations.
- `src/utils/` - shared utilities.
- `src/integrations/` - provider and model integration metadata.
- `src/entrypoints/` - CLI, MCP, SDK, and generated public types.
- `src/tasks/` - local, remote, workflow, and monitor task handling.
- `docs/integrations/` - provider integration guidance.
- `web/` - documentation website.

## Validation

The authoritative local pre-push validation contract lives in [CONTRIBUTING.md § Validation](CONTRIBUTING.md#validation) and must be run before every push to a PR, including follow-up fixes during review. It covers the same command families as `.github/workflows/pr-checks.yml`; CI remains authoritative for clean-runner, supported-Node-matrix, and platform-specific coverage. The lists below are for narrowing checks while you iterate; they do not replace the pre-push contract.

Core checks:

```bash
bun install
bun run build
bun run smoke
bun run check
bun run typecheck
bun run typecheck:type-tests
```

Focused checks:

```bash
bun test ./path/to/test-file.test.ts
bun run test:provider
bun run test:provider-recommendation
```

Web checks, when changes can affect the site:

```bash
bun run web:typecheck
bun run web:build
```

Website release notes live on GitHub Releases; do not add a manually maintained release-notes data source to the static site.

Diagnostics and PR hygiene:

```bash
bun run doctor:runtime
```

For PR intent scanning, use the canonical upstream fetch and explicit-ref invocation in [CONTRIBUTING.md § Validation](CONTRIBUTING.md#validation); the scanner's default `origin/main` base is not portable to fork checkouts.

## Provider Changes

When modifying provider behavior:

1. Start with `docs/integrations/overview.md`.
2. Use the relevant how-to guide under `docs/integrations/how-to/`.
3. Check existing provider implementations before adding a new pattern.
4. Test the exact provider/model path you changed when possible.
5. Avoid breaking third-party providers while fixing first-party behavior.

## Things To Avoid

- Do not change the Node runtime or Bun development workflow without prior maintainer agreement.
- Do not add new Python code, Python provider paths, or Python dependencies without explicit maintainer approval.
- Do not introduce dependencies without clear project benefit.
- Do not skip tests for behavior changes.
- Do not silently change provider tags; maintainers control them during review.
- Do not ignore CodeRabbit or maintainer feedback; address it before requesting more review. Before applying an automated review suggestion, verify it does not pull the PR away from its stated scope or intent — decline out-of-scope suggestions with justification, or ask a maintainer when unsure. Never silently ignore findings.
- Do not push commits with failing, incomplete, or unrun local checks unless an exception in [CONTRIBUTING.md § Validation](CONTRIBUTING.md#validation) applies. Verify pre-existing failures against the current PR base and document the evidence in the PR; PR-owned failures must still be fixed.
- Do not submit a PR whose description still contains template placeholder text; fill in every section of the [PR template](.github/pull_request_template.md) for the actual change.
- Do not surface-patch recurring review findings; repeated fix requests usually indicate a core design issue — investigate and fix the root cause instead of the reported symptom.
- Do not add a manually maintained release-notes data source to the static site; link to GitHub Releases instead.
