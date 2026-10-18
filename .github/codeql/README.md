# CodeQL analysis and merge protection

The [CodeQL workflow](../workflows/codeql.yml) scans pull requests to `main`,
including forks, pushes to `main`, and a weekly schedule. It also supports manual
runs once the workflow exists on the default branch. JavaScript/TypeScript uses
the default security queries plus `code-quality`; GitHub Actions retains its
default security queries. Results are uploaded to **code scanning**.

GitHub's CodeQL default setup [excludes fork pull requests](https://docs.github.com/en/code-security/concepts/code-scanning/setup-types#about-default-setup).
The separate managed Code Quality workflow has also failed to run on fork PRs in
this repository. Requiring its results leaves those PRs pending indefinitely.
Custom workflows cannot provide a supported replacement for the managed Code
Quality result: the [CodeQL action](https://github.com/github/codeql-action/blob/6f2ac81f5cd81fe351a197ba0b00d91d03cd2aee/src/analyses.ts)
directs custom workflows to run quality queries through code scanning instead.

## Permissions and activation

Write access permits contributing this workflow. Changing CodeQL default setup
requires repository administration or the relevant security-management access;
editing the ruleset requires administration or a custom role with permission to
edit repository rules. Merging this file does not change either setting.

An administrator must complete this rollout for `Twigpine/openclaude`:

1. In **Settings → Advanced Security → CodeQL analysis**, disable default setup
   and use advanced setup with this workflow. Default setup otherwise rejects
   uploads from custom CodeQL workflows. The equivalent API change is:

   ```sh
   gh api --method PATCH repos/Twigpine/openclaude/code-scanning/default-setup \
     -f state=not-configured
   ```

2. Rerun the new **CodeQL** workflow on the introducing PR after changing the
   setup. Verify that both `CodeQL (javascript-typescript)` and `CodeQL (actions)`
   complete successfully, including their uploads. A successful analysis with
   a failed upload is not sufficient. The `pull_request` trigger supports fork
   uploads with the restricted token; no PAT, fork secret, `pull_request_target`,
   or privileged artifact-upload workflow is needed.

3. In **Settings → Rules → Rulesets → main branch protection** (ruleset
   `14659193`), remove **Require code quality results** and add both CodeQL job
   names as required status checks, selecting **GitHub Actions** as their source.
   Keep every other rule, branch target, enforcement setting, bypass actor, and
   existing required check. This temporary stage lets the introducing PR merge
   with completed scans while the new configuration acquires a `main` baseline.
   Continue the normal PR approval and CI process before merging.

4. After merge, verify the new workflow's push run on `main` uploaded both
   language analyses. Then enable **Require code scanning results**, select
   **CodeQL**, and set **Alerts: Errors** and **Security alerts: None**. Retain the
   two required status checks. The security threshold preserves the previous
   ruleset's policy: it required quality errors but had no security-severity
   merge threshold. Security findings remain visible for review.

5. Verify a fork PR has both successful jobs and a completed CodeQL code-scanning
   evaluation. Older PRs need a new push or a rerun that includes this workflow;
   rerunning a historical workflow definition that lacks it cannot start it.

The separate managed Code Quality feature may remain enabled for its dashboard.
Its **Require code quality results** rule must stay removed for this migration.
Do not disable the entire branch ruleset.

## Prepared rule additions

These are rule fragments for the existing ruleset, not a complete replacement
payload. Remove its `code_quality` rule, add the following `code_scanning` rule
after the baseline upload, and merge these checks into any existing
`required_status_checks` rule. Preserve all unrelated fields and rules from a
fresh administrator-readable export before saving an API update.

```json
[
  {
    "type": "code_scanning",
    "parameters": {
      "code_scanning_tools": [
        {
          "tool": "CodeQL",
          "alerts_threshold": "errors",
          "security_alerts_threshold": "none"
        }
      ]
    }
  },
  {
    "type": "required_status_checks",
    "parameters": {
      "strict_required_status_checks_policy": false,
      "required_status_checks": [
        { "context": "CodeQL (javascript-typescript)", "integration_id": 15368 },
        { "context": "CodeQL (actions)", "integration_id": 15368 }
      ]
    }
  }
]
```

GitHub's [rules API](https://docs.github.com/en/rest/repos/rules#update-a-repository-ruleset)
documents these fields. Code-scanning merge protection needs results for both the
PR and its target branch, which is why activation is staged around the initial
`main` upload.
