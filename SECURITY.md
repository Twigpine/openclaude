# Security Policy

## Supported Versions

Open Claude is currently maintained on the latest `main` branch and the latest
npm release only.

| Version | Supported |
| ------- | --------- |
| Latest release | :white_check_mark: |
| Older releases | :x: |
| Unreleased forks / modified builds | :x: |

Security fixes are generally released in the next patch version and may also be
landed directly on `main` before a package release is published.

## Reporting a Vulnerability

If you believe you have found a security vulnerability in Open Claude, please
report it privately.

Preferred reporting channel:

- GitHub Security Advisories / private vulnerability reporting for this
  repository

Please include:

- a clear description of the issue
- affected version, commit, or environment
- reproduction steps or a proof of concept
- impact assessment
- any suggested remediation, if available

Please do **not** open a public issue for an unpatched vulnerability.

## Response Process

Our general goals are:

- initial triage acknowledgment within 7 days
- follow-up after validation when we can reproduce the issue
- coordinated disclosure after a fix is available

Severity, exploitability, and maintenance bandwidth may affect timelines.

## Disclosure and CVEs

Valid reports may be fixed privately first and disclosed after a patch is
available.

If a report is accepted and the issue is significant enough to warrant formal
tracking, we may publish a GitHub Security Advisory and request or assign a CVE
through the appropriate channel. CVE issuance is not guaranteed for every
report.

## Scope

This policy applies to:

- the Open Claude source code in this repository
- official release artifacts published from this repository
- the `@twigpine/openclaude` npm package

The package was previously published as `@gitlawb/openclaude`. That name is no
longer updated and receives no fixes; switch to `@twigpine/openclaude`.

This policy does not cover:

- third-party model providers, endpoints, or hosted services
- local misconfiguration on the reporter's machine
- vulnerabilities in unofficial forks, mirrors, or downstream repackages
