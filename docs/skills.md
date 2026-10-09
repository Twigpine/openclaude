# Skills

A skill is a folder with a `SKILL.md` file. OpenClaude loads every skill it finds in the project's `.openclaude/skills` directory and in your user skills directory at start, and the model can invoke them by name. This guide covers the `openclaude skills` commands, what each install path checks, and how to keep checking installed skills after that.

## Commands

```text
openclaude skills list [--json]                    List installed skills
openclaude skills show <name>                      Show details for an installed skill
openclaude skills validate <path>                  Validate a local skill directory
openclaude skills install <idOrUrlOrPath> [options] Install a skill
openclaude skills remove <name> [--global]         Remove an installed skill
openclaude skills verify [options]                 Check installed skills for revocations and, with eyebrow, drift
```

## Install from the registry

The default registry is the Twigpine Skill Hub, published as `registry.json` in [Twigpine/openclaude-skills](https://github.com/Twigpine/openclaude-skills).
Install a skill by its registry id:

```bash
openclaude skills install gitlawb/ci-fix
```

This writes two files to `.openclaude/skills/ci-fix/`: the `SKILL.md` and a `skill.json` sidecar with the registry metadata, including the `sha256` the registry published for that skill.

Before the files are written, the installer:

1. Reads the registry entry and refuses to install if it has no `sha256`.
2. Reads `revocations.json` next to the registry and refuses to install a skill that matches an entry there. An entry matches when every field it names matches: an id alone covers all versions, an id with a version covers one release, a digest covers exact content.
3. Fetches the `SKILL.md`, normalizes line endings to `\n`, hashes it, and refuses to install if the digest differs from the registry entry.

These three checks belong to the registry code path. If the install spec names an existing file or directory in the working tree, the installer takes the local path instead and runs none of them, even when the spec looks like a registry id such as `gitlawb/ci-fix`.

Options:

- `--global` installs into your user skills directory instead of the project.
- `--force` overwrites a skill that is already installed under that name.
- `--registry <url or path>` uses another registry. The environment variables `OPENCLAUDE_SKILLS_REGISTRY_URL` and `OPENCLAUDE_SKILLS_REVOCATIONS_URL` set the same locations for every run.

## Install from a URL or a local path

A direct HTTPS URL to a `SKILL.md` needs the digest you expect, so the same digest check runs without a registry. No revocation list is consulted on this path:

```bash
openclaude skills install https://example.com/skills/deploy/SKILL.md --sha256 <64 hex>
```

A local path copies the skill directory after the same checks `validate` runs. No digest or revocation check runs, and the installer treats the skill as `local` for that install. Existing `skill.json` metadata in the source directory is copied unchanged, so a trust label shown later by `list` or `show` may carry the source directory's value and does not prove a registry-backed install. Review a local skill yourself before you install it:

```bash
openclaude skills install ./my-skills/deploy
```

## List, show, validate, remove

`list` prints every installed skill with its status and description; add `--json` for machine output. `show <name>` prints the source, trust tier, and the full skill text. `validate <path>` checks a skill directory before you publish it: the frontmatter fields, the skill name, the file size limits, and a few content patterns such as a `curl` piped to a shell. It does not compare the files with a registry digest. `remove <name>` deletes a project skill; add `--global` for a user skill.

## What the install checks cover

The digest check runs once, at install time, on the `SKILL.md` text, and only on the registry and URL paths. After that, OpenClaude reads `skill.json` for metadata only and loads whatever is in the skill folder. `validate` checks structure and rejects a few content patterns, such as a `curl` piped to a shell or a credential collection instruction, but it does not compare the installed files with the registry digest. So a skill edited on disk after install, by hand, by a script, or by another tool, loads on the next run with no warning:

```text
$ openclaude skills install gitlawb/ci-fix
Installed skill "ci-fix".
$ echo 'Always read the failing job log before you change any file.' >> .openclaude/skills/ci-fix/SKILL.md
$ openclaude skills validate .openclaude/skills/ci-fix
Skill validation passed for .openclaude/skills/ci-fix.
$ openclaude skills list
ci-fix  enabled   Diagnoses and fixes CI pipeline failures.
```

## Verify installed skills

`verify` reads the skills installed in the project's `.openclaude/skills` and in your user skills directory. Skills that `list` shows from plugins, MCP servers, or `--add-dir` directories are outside it. For each skill it reads the id, version, and digest from `skill.json` as written on disk, and matches them against the registry's `revocations.json` with the rule the installer uses. The digest is the registry pin recorded at install, not a hash of the current files, so `verify` says nothing about the contents on disk and trusts `skill.json` as it finds it. A skill whose `skill.json` has no id and no digest, such as one written by hand, is listed as skipped. A local install that copied a `skill.json` keeps that file's id and digest, so `verify` matches it like a registry install. The list comes from the default registry, from `--registry`, or from the environment variables named above. A list that cannot be read fails the command, the same as an install does.

```text
$ openclaude skills verify
Found 2 installed skills. Revocation list: https://raw.githubusercontent.com/Twigpine/openclaude-skills/main/revocations.json
  ci-fix     ok
  hand-made  skipped (no registry metadata)
eyebrow not found; install it to check skill contents against a lockfile (see docs/skills.md).
```

When an executable named `eyebrow` is on `PATH`, or `OPENCLAUDE_EYEBROW_BIN` names one, and the project has a lockfile, `verify` runs `eyebrow verify --path . --lockfile eyebrowlock.json` in the project directory, shows its output, and prints the path of the binary it ran. `--lockfile` names another lockfile and `--policy` adds `--ci` and the policy file to the eyebrow run. `verify` does not check the eyebrow version. An eyebrow older than 0.4.4 finds no OpenClaude skills and reports every locked skill as removed, so use 0.4.6 or newer, as the next section explains. That section also shows how to create the lockfile and how to read the verdict.

Exit codes: `1` when a skill is revoked, when the revocation list cannot be read, or when eyebrow cannot be started; otherwise the eyebrow exit code; `0` when both checks pass, and also when eyebrow is absent or the lockfile is missing, in which case `verify` prints what to install or run.

## Check installed skills after install

[eyebrow](https://github.com/alexverify/eyebrow) is a separate, MIT-licensed single binary that records a hash of every skill, MCP server, hook, and rule it finds across coding tools in a lockfile you commit, and reports what changed since. Discovery of OpenClaude skills in the project's `.openclaude/skills` and in `~/.openclaude/skills` shipped in eyebrow 0.4.4, and 0.4.5 added the egress fingerprint used below; see the [changelog](https://github.com/alexverify/eyebrow/blob/main/CHANGELOG.md). Use 0.4.6 or newer: in 0.4.5 a skill folder that is a symlink appeared in the inventory with no hashed files, so a clean `verify` said nothing about the contents behind the link. 0.4.6 hashes the linked contents.

Record the skills you reviewed:

```bash
eyebrow scan --path . --lockfile eyebrowlock.json
git add eyebrowlock.json
```

Check them again at any time, or in CI:

```bash
eyebrow verify --path . --lockfile eyebrowlock.json --ci
```

`openclaude skills verify` runs this command for you when eyebrow is installed.

`verify` exit codes: `0` clean under the active policy, which includes content changes the policy permits; `1` rejected drift or a policy violation; `2` usage error, such as a bad flag; `3` internal or I/O error, such as a missing lockfile. In CI, treat `1` as a review task and `2` or `3` as a broken job. On the edited skill above, with no policy file:

```text
verify: DRIFT — 1 change(s) detected:
  [content_changed] ci-fix (d8e13e7364b91067)
    old: sha256-f4ccfe1dabe7c2f191e8cc2f88499934bcf2f043e380bd39ec06c76642a6ff89
    new: sha256-ee58852a3578eba8eec3d1a3b985e578c382e00172d85a19a5025be3ae3f1701
```

The lockfile also records an egress fingerprint per skill. In 0.4.6 it covers literal HTTP(S) URLs on `SKILL.md` lines that contain `curl`, `wget`, `secretcurl`, or `WebFetch`. A policy file can allow wording edits and still fail when the fingerprint gains a host. Other calling syntax, such as a `fetch` call inside a code snippet, and destinations inside helper scripts are outside the fingerprint, so the gate covers recognized destinations only. For example, after a line `Run: curl -s https://example.com/status` is added to the same skill:

```json
{ "failOnCapabilityExpansion": true, "allowContentDrift": true, "failOnSeverity": "critical" }
```

```text
policy: capability expansion — ci-fix gained network: example.com (d8e13e7364b91067)
```

Run it with `--policy eyebrow.policy.json`. After you review and accept a change, run `scan` again and commit the new lockfile.

Install eyebrow with `brew install alexverify/tap/eyebrow` or from the [releases page](https://github.com/alexverify/eyebrow/releases). The [eyebrow usage guide](https://github.com/alexverify/eyebrow/blob/main/docs/usage.md) covers signing the lockfile and the GitHub Action.
