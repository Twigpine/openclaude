# Windows aliases and launchers

This page documents optional PowerShell helper functions for launching OpenClaude on Windows after a global npm install.

These helpers are designed for the installed package workflow:

~~~powershell
npm install -g @twigpine/openclaude
~~~

The helpers use the installed `openclaude` CLI command. They do not require a source checkout and do not call source-only `bun run scripts/*.ts` entrypoints.

## One-time setup

Run this once in PowerShell:

~~~powershell
$packageRoot = Join-Path (npm root -g) "@twigpine/openclaude"
$aliases = Join-Path $packageRoot "scripts\windows\openclaude-aliases.ps1"

if (-not (Test-Path $aliases)) {
  throw "Alias script not found at $aliases. Update or reinstall @twigpine/openclaude."
}

if (-not (Test-Path $PROFILE)) {
  New-Item -ItemType File -Path $PROFILE -Force | Out-Null
}

$profileLine = ". `"$aliases`""

if (-not (Select-String -Path $PROFILE -Pattern ([regex]::Escape($profileLine)) -Quiet)) {
  Add-Content -Path $PROFILE -Value "`n$profileLine"
}

. $aliases
oc-help
~~~

Open a new PowerShell window after setup, or dot-source the profile:

~~~powershell
. $PROFILE
~~~

### Upgrading from `@gitlawb/openclaude`

The setup above adds a line to `$PROFILE` that loads the helpers from the
installed package folder. If you ran it while the package was still named
`@gitlawb/openclaude`, that line points at a folder that no longer exists once
you switch packages, and every new PowerShell window reports an error.

After installing `@twigpine/openclaude`, remove the old line and run the
one-time setup again:

~~~powershell
(Get-Content $PROFILE) | Where-Object { $_ -notmatch '@gitlawb[\\/]openclaude' } | Set-Content $PROFILE
~~~

## Daily commands

### Launch OpenClaude using the installed CLI

~~~powershell
oc
~~~

You can pass normal CLI arguments through `oc`:

~~~powershell
oc --version
oc --help
~~~

### Launch with local Ollama/OpenAI-compatible environment hints

~~~powershell
oc-local
~~~

By default, this uses local Ollama through the OpenAI-compatible API:

~~~text
CLAUDE_CODE_USE_OPENAI=1
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_MODEL=llama3.1:8b
~~~

To use a different local model for that invocation:

~~~powershell
oc-local -Model "qwen2.5-coder:7b"
~~~

The environment overrides are scoped to that single `openclaude` invocation. A later plain `oc` call returns to normal installed CLI behavior and saved-provider-profile behavior.

### Launch with low-latency local defaults

~~~powershell
oc-fast
~~~

To use a different model:

~~~powershell
oc-fast -Model "qwen2.5-coder:7b"
~~~

Like `oc-local`, the environment overrides are scoped to that single invocation.

### Open the provider manager

~~~powershell
oc-provider
~~~

This opens the provider manager through the installed OpenClaude CLI.

### Check local Ollama state

~~~powershell
oc-check
~~~

To check a specific model:

~~~powershell
oc-check -Model "qwen2.5-coder:7b"
~~~

### Pull/check a local model, then launch local mode

~~~powershell
oc-init
~~~

To choose a model:

~~~powershell
oc-init -Model "qwen2.5-coder:7b"
~~~

To skip pulling the model and only check/launch:

~~~powershell
oc-init -Model "qwen2.5-coder:7b" -SkipModelPull
~~~

`oc-init` does not save a provider profile. It pulls/checks the local Ollama model and then launches `oc-local`.

### Show quick help

~~~powershell
oc-help
~~~

## Command summary

| Command | Purpose |
| --- | --- |
| `oc` | Launch OpenClaude using the installed CLI and saved/default behavior |
| `oc-local` | Launch once with local Ollama/OpenAI-compatible environment hints |
| `oc-fast` | Launch once with local Ollama/OpenAI-compatible low-latency hints |
| `oc-provider` | Open the provider manager |
| `oc-check` | Show local Ollama install/listening/model state |
| `oc-init` | Pull/check a local Ollama model, then launch local mode |
| `oc-help` | Show quick command help |

## Notes

These helpers are intentionally global-install oriented. They use the installed CLI instead of source-checkout development scripts.

For advanced provider setup, use the built-in provider manager:

~~~powershell
oc-provider
~~~
