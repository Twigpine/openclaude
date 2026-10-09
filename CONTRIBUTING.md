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
- Run narrow checks while iterating, then complete the required [Validation](#validation) contract before opening the PR.

Every PR needs a reason. Your PR description must include:

- confirmation that you reviewed both this `CONTRIBUTING.md` file and [`AGENTS.md`](AGENTS.md)
- what changed and why
- the user or developer impact
- the exact checks you ran
- a linked issue when one exists, using `Fixes #123`, `Closes #123`, or another clear link
- screenshots when the PR touches UI, terminal presentation, or the VS Code extension
- which provider path was tested when the PR changes provider behavior

The PR author is responsible for ensuring their PR is merge-ready. PRs with merge conflicts will not be reviewed or approved until the conflicts are resolved.

Issues are the recommended starting point for anything non-trivial — opening one first helps avoid wasted effort if the change is out of scope or already being worked on. Small fixes, doc corrections, and obvious improvements can stand on their own without a linked issue, as long as the PR description explains the intent.

### Automated Review (CodeRabbit)

We use [CodeRabbit](https://coderabbit.ai) to assist with PR reviews. CodeRabbit will automatically review your PR and leave comments on potential issues, bugs, or style concerns.

**PR authors must address CodeRabbit findings** — do not ignore its comments and wait for a maintainer override. If you're waiting for a maintainer review and CodeRabbit has completed its review with findings, fix those findings first. Maintainer reviews will not proceed until automated review feedback has been addressed.

One important caveat: **verify each suggested change against your PR's stated scope and intent before applying it.** Automated reviewers can suggest fixes that accidentally force changes to surfaces you never intended to touch, or that quietly pull the PR away from its original framing. When a suggestion would cause that kind of drift:

- you may decline it with a brief justification in the comment thread
- when unsure whether a suggestion is in scope, ask a maintainer before applying or declining it

Declining an out-of-scope suggestion with a clear reason is acceptable. Silently ignoring findings is not — every finding should end up either fixed, declined with justification, or escalated to a maintainer.

### Keep Your Branch Current

The PR author is responsible for keeping their branch current with `main`. Rebase onto `main` whenever you resume work on a PR, and before pushing follow-up fixes.

Stale branches cause real problems: maintainers end up requesting fixes for issues that are already resolved on `main`, which produces endless fix-churn requests for work nobody needs to do again. A quick rebase before each update keeps review feedback relevant and avoids wasted rounds on both sides.

Before rebasing an already-pushed PR branch, fetch the current remote PR head, record its exact commit SHA, and incorporate any commits that were added to the remote branch. Then fetch upstream `main` and rebase. Publish with an explicit lease pinned to the PR-head SHA you recorded, never an unguarded `--force` or an unqualified lease:

```bash
git push --force-with-lease=refs/heads/<pr-branch>:<recorded-pr-head-sha> <pr-remote> HEAD:refs/heads/<pr-branch>
```

Pinning the expected SHA prevents a background fetch from silently moving a remote-tracking ref and weakening the lease. If the lease is rejected, stop: fetch and inspect the new remote PR head, incorporate its commits, redo the rebase, and retry with that newly recorded SHA. If the branch is shared or does not allow force-pushes, coordinate with a maintainer and use a repository-approved non-rewriting update path instead of discarding remote work.

Note that PRs with merge conflicts will not be reviewed or approved regardless (see [Pull Requests](#pull-requests)) — staying current prevents that state entirely.

### PR Follow-Up Requirements

Submitting a PR is a commitment to see it through to the end. Review here is in-depth and can take multiple rounds — do not be surprised if every review pass results in follow-up fix requests; that is the normal shape of this project's review process, not a signal that your PR is unwelcome. Please be prepared to:

- **Respond to review feedback within 1 week** of a maintainer or CodeRabbit review request
- **If you need more time**, leave a comment explaining your situation and expected timeline
- **PRs with no activity for 2 weeks after a review request** will be closed as abandoned. At that point, another contributor may pick up the work under a new PR

This policy ensures the project stays maintainable and that contributor queue doesn't grow stale. We understand life happens — a quick note explaining a delay goes a long way.

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

## AI Agent Guidelines

If you are an AI agent (Copilot, Cursor, Claude, etc.) working on this codebase, refer to [AGENTS.md](AGENTS.md) for project-specific coding guidelines, conventions, and validation commands. Following these guidelines will help your contributions align with the project's patterns and reduce review friction.

In particular: link release-notes navigation to GitHub Releases rather than adding a local changelog page or manually maintained release data.

## Code Style

- Follow the existing code style in the touched files.
- Prefer small, readable changes over broad rewrites.
- Do not reformat unrelated files just because they are nearby.
- Keep comments useful and concise.

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

CI runs a fixed set of checks on every PR (see `.github/workflows/pr-checks.yml`). This section is the **authoritative local pre-push validation contract** — `AGENTS.md` defers to it. **Run every locally applicable check before every push to an open PR, including follow-up pushes during review.** Do not wait for GitHub CI to discover failures you could have caught locally — wasted Actions minutes are a real cost on this repo.

The security scan requires the commit ancestry needed to find the PR's merge base. Check whether your clone is shallow:

```bash
git rev-parse --is-shallow-repository
```

If that prints `true`, fetch the rest of the current branch's history before running the preflight (replace the default remote if your PR branch is tracked elsewhere):

```bash
git fetch --unshallow
```

Required local preflight:

```bash
bun install --frozen-lockfile
bun run check
bun run typecheck
bun run typecheck:type-tests
node bin/openclaude --version
bun run test:provider
npm run test:provider-recommendation
git fetch https://github.com/Twigpine/openclaude.git main
bun run security:pr-scan -- --base FETCH_HEAD --head HEAD
```

Also run the compile-cache-disabled launcher check using the syntax for your shell.

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

- `bun run check` already builds the CLI and includes smoke, deadcode, and the full unit pass (`test:full`) — do not run those separately, or you execute work twice.
- Fetching upstream `main` by URL avoids assuming that a fork checkout's `origin` points at Twigpine/openclaude. `FETCH_HEAD` is the fetched upstream tip. The scan deliberately uses local `HEAD` so it includes commits that have not been pushed yet; CI uses the pushed PR head SHA after the push.
- The web CI job remains unconditional as an integration backstop. Contributors do not need to run the web suite locally for changes that cannot affect the site.
- This preflight covers the same command families as CI, but it does not reproduce CI exactly in one shell. CI runs the main checks under Node 22 and 24.11.x, separately builds and launches under exact Node 22.0.0, and executes every job on a clean runner.

If a local or GitHub CI check fails, first determine whether the PR owns the failure. Treat a failure as pre-existing only when you can reproduce it on the PR's current base (or link to the same failure on a current `main` CI run) and the PR neither changes the causal surface nor claims to fix that problem.

For a verified pre-existing failure:

- record the failing check, relevant output, and base commit or `main` CI run in the PR
- note the pre-existing failure in the PR summary or testing notes so maintainers can track it separately; link an existing issue when one is already available
- explain briefly why the failure is unrelated to the PR

The contributor may then proceed and is not responsible for repairing that failure in the current PR. A maintainer may still need to rerun or waive a required GitHub check, or land the separate fix, before branch protection permits a merge. Failures caused by the PR, or in behavior the PR claims to fix, remain the author's responsibility and must be resolved.

PRs with unresolved PR-owned CI failures will not be merged. Verified pre-existing failures follow the exception above.

### Recommended Local Checks

These are not enforced by CI but are worth running locally before submitting.

Focused tests:

```bash
bun test ./path/to/test-file.test.ts
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
