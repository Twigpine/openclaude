# OpenClaude for Non-Technical Users

This guide is for people who want the easiest setup path.

You do not need to build from source. You do not need Bun. You do not need to understand the full codebase.

If you can copy and paste commands into a terminal, you can set this up.

## What OpenClaude Does

OpenClaude lets you use an AI coding assistant with different model providers such as:

- OpenAI
- DeepSeek
- Gemini
- Ollama
- Codex

For most first-time users, OpenAI is the easiest option.

## Before You Start

You need:

1. Node.js 22 LTS or newer installed
2. A terminal window
3. An API key from your provider, unless you are using a local model like Ollama

## Fastest Path

1. Install OpenClaude with npm
2. Run `openclaude`
3. Inside the CLI, run `/provider` for guided provider setup

The `/provider` command walks you through choosing a provider and entering credentials. You do not need to set environment variables beforehand.

## Choose Your Operating System

- Windows: [Windows Quick Start](quick-start-windows.md)
- macOS / Linux: [macOS / Linux Quick Start](quick-start-mac-linux.md)

## Which Provider Should You Choose?

Once you have picked a provider, run `/provider` inside OpenClaude to set it up with guided prompts.

### OpenAI

Choose this if:

- you want the easiest cloud setup
- you already have an OpenAI API key

### Ollama

Choose this if:

- you want to run models locally
- you do not want to depend on a cloud API for testing

### Codex

Choose this if:

- you already use the Codex CLI
- you already have Codex or ChatGPT auth configured

## What Success Looks Like

After you run `openclaude`, the CLI should start and wait for your prompt.

At that point, you can ask it to:

- explain code
- edit files
- run commands
- review changes

## Common Problems

### `openclaude` command not found

Cause:

- npm installed the package, but your terminal has not refreshed yet
- on Windows, npm's global bin folder may not be in your user `Path`

Fix:

1. Close the terminal
2. Open a new terminal
3. Run `openclaude` again

On Windows PowerShell, if that still does not work, add npm's global bin folder
to your user `Path`, then open a new PowerShell window:

```powershell
$npmPrefix = npm config get prefix
$currentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")

if (($currentUserPath -split ';') -notcontains $npmPrefix) {
    [Environment]::SetEnvironmentVariable(
        "Path",
        "$currentUserPath;$npmPrefix",
        "User"
    )
}
```

### Invalid API key

Cause:

- the key is wrong, expired, or copied incorrectly

Fix:

1. Get a fresh key from your provider
2. Run `/provider` inside OpenClaude to update your credentials
3. Re-run `openclaude`

### Missing Provider Key after copying .env.example

Cause:

- OpenClaude does not automatically load `.env` files. If you copied `.env.example` to `.env`, OpenClaude won't see the variables unless you tell it to.

Fix:

- Load the file explicitly:
  `openclaude --provider-env-file .env`
- Or, use the `/provider` command inside OpenClaude instead (recommended).
- Do not commit your `.env` file to git.
- The explicit loader accepts provider/setup variables. Export runtime/debug variables from your shell or launcher instead.

### Ollama not working

Cause:

- Ollama is not installed or not running

Fix:

1. Install Ollama from `https://ollama.com/download`
2. Start Ollama
3. Try again

## Want More Control?

If you want source builds, advanced provider profiles, diagnostics, or Bun-based workflows, use:

- [Advanced Setup](advanced-setup.md)
  This is also where to find Codex, Gemini, Mistral, LiteLLM, and profile-launcher setup.

## Getting Help

- **GitHub Discussions**: https://github.com/Twigpine/openclaude/discussions
  Use this for Q&A, setup help, and community conversation.

- **GitHub Issues**: https://github.com/Twigpine/openclaude/issues
  Use this for confirmed bugs and feature requests.

### Quick diagnostic check

If OpenClaude is not working after setup, run:

```bash
openclaude --version
```

If this prints a version number, the install succeeded. If it says "command not found," close your terminal, open a new one, and try again. On Windows, you may also need to add npm's global bin folder to your user `Path` (see the [Windows Quick Start](quick-start-windows.md) guide for details).

When filing a bug, run this and paste the redacted output into the issue:

```bash
openclaude doctor report --markdown
```
