# OpenClaude Quick Start for Windows

This guide uses Windows PowerShell.

## 1. Install Node.js

Install Node.js 24.22.1 or newer (Node 26 recommended/default) from:

- `https://nodejs.org/`

Then open PowerShell and check it:

```powershell
node --version
npm.cmd --version
```

## 2. Install OpenClaude

### Install the Llama for Windows fork build

Choose one installation method below. To use the fork's native Llama for
Windows integration, paste this into PowerShell. It requires Node.js 22+ and
Git, clones the fork to
`%LOCALAPPDATA%\OpenClaude-Fork`, builds it, and adds the `openclaude` command
to npm's global command path:

```powershell
irm https://raw.githubusercontent.com/LightningEX19/openclaude/lightningex19-llama-windows-provider/scripts/windows/install-openclaude.ps1 | iex
```

After it finishes, start OpenClaude with `openclaude.cmd` (or `openclaude` if
PowerShell script execution is enabled). To configure Llama for Windows, run
`/provider` and choose **Llama for Windows**.

To update this fork installation, rerun the same installer; it updates the
checkout only when it has no local changes. To remove its global command link,
open PowerShell in `%LOCALAPPDATA%\OpenClaude-Fork` and run:

```powershell
npm.cmd unlink -g
```

This removes the command link, not the fork checkout or your local files.

### Install the published OpenClaude release

Use this instead if you want the published release; it is separate from the
fork build above. Installing both globally can replace the `openclaude`
command link, so choose one method.

```powershell
npm.cmd install -g @twigpine/openclaude@latest
```

Update the published release with `npm.cmd update -g @twigpine/openclaude`.
Remove it with `npm.cmd uninstall -g @twigpine/openclaude`; these commands do
not update or remove the fork checkout.

Upgrading from `@gitlawb/openclaude`? The package moved to the `@twigpine`
scope and the old one is no longer updated. npm will not install one over the
other because both provide the `openclaude` command, so remove the old package
first:

```powershell
npm.cmd uninstall -g @gitlawb/openclaude
npm.cmd install -g @twigpine/openclaude@latest
```

If you set up the optional PowerShell aliases, your `$PROFILE` still loads them
from the old package folder and will show an error in every new window. See
[Upgrading from `@gitlawb/openclaude`](windows-aliases-and-launchers.md#upgrading-from-gitlawbopenclaude).

## 3. Pick One Provider

### Option A: OpenAI

Replace `sk-your-key-here` with your real key.

```powershell
$env:CLAUDE_CODE_USE_OPENAI="1"
$env:OPENAI_API_KEY="sk-your-key-here"
$env:OPENAI_MODEL="gpt-4o"

openclaude.cmd
```

### Option B: DeepSeek

```powershell
$env:CLAUDE_CODE_USE_OPENAI="1"
$env:OPENAI_API_KEY="sk-your-key-here"
$env:OPENAI_BASE_URL="https://api.deepseek.com/v1"
$env:OPENAI_MODEL="deepseek-v4-flash"

openclaude.cmd
```

Use `deepseek-v4-pro` when you want the stronger model. `deepseek-chat` and `deepseek-reasoner` still work as DeepSeek's legacy API aliases.

### Option C: Ollama

Install Ollama first from:

- `https://ollama.com/download/windows`

Then run:

```powershell
ollama pull llama3.1:8b

$env:CLAUDE_CODE_USE_OPENAI="1"
$env:OPENAI_BASE_URL="http://localhost:11434/v1"
$env:OPENAI_MODEL="llama3.1:8b"

openclaude.cmd
```

No API key is needed for Ollama local models.

OpenClaude asks Ollama for a 32768-token context window on each chat request.
If you need a different size, set `OPENCLAUDE_OLLAMA_NUM_CTX` before launching
OpenClaude, or start Ollama with a global context setting:

```powershell
# Quit any existing Ollama app/server first, then run:
$env:OLLAMA_CONTEXT_LENGTH="32768"
ollama serve
```

After a chat request, run `ollama ps` in another PowerShell window and check the
`CONTEXT` column. It should show the requested size. If it still shows a small
value such as `4K`, restart the Ollama app/server and try again.

### Option D: LM Studio

Install LM Studio first from:

- `https://lmstudio.ai/`

Then in LM Studio:

1. Download a model (e.g., Llama 3.1 8B, Mistral 7B)
2. Go to the "Developer" tab
3. Select your model and enable the server via the toggle

Then run:

```powershell
$env:CLAUDE_CODE_USE_OPENAI="1"
$env:OPENAI_BASE_URL="http://localhost:1234/v1"
$env:OPENAI_MODEL="your-model-name"
# $env:OPENAI_API_KEY="lmstudio"  # optional: some users need a dummy key

openclaude.cmd
```

Replace `your-model-name` with the model name shown in LM Studio.

No API key is needed for LM Studio local models (but uncomment the `OPENAI_API_KEY` line if you hit auth errors).

### Option E: Llama for Windows

Llama for Windows requires Windows 11. If you are on Windows 10, use another
local backend such as Ollama or LM Studio.

Install [Llama for Windows](https://github.com/ggml-org/Llama-Windows), start
the tray app, and load a model. Its local OpenAI-compatible server uses
`127.0.0.1:9931` by default.

Run `/provider`, choose **Llama for Windows**, then select one of the models
reported by its server. OpenClaude uses `http://127.0.0.1:9931/v1` and does
not require an API key. If you changed the app's listen address or port, set
`$env:LLAMA_WINDOWS_BASE_URL="http://127.0.0.1:8080/v1"` before running
OpenClaude. Include `/v1` in the custom base URL.

### Option F: Using a .env file (Optional)

If you prefer to keep your keys in a `.env` file instead of exporting them individually, note that OpenClaude does not load `.env` files automatically. You must explicitly pass it:

```powershell
openclaude.cmd --provider-env-file .env
```

Keep `.env` out of git because it contains secrets.
The explicit loader accepts provider/setup variables. Set runtime/debug variables in PowerShell or your launcher instead.

## 4. If `openclaude` Is Not Found

Close PowerShell, open a new one, and try again:

```powershell
openclaude.cmd
```

If PowerShell still says `openclaude` is not recognized, npm's global bin
folder may be missing from your user `Path`. Add it, then open a new
PowerShell window:

```powershell
$npmPrefix = npm.cmd config get prefix
$currentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")

if (($currentUserPath -split ';') -notcontains $npmPrefix) {
    [Environment]::SetEnvironmentVariable(
        "Path",
        "$currentUserPath;$npmPrefix",
        "User"
    )
}
```

## 5. If Your Provider Fails

Check the basics:

### For OpenAI or DeepSeek

- make sure the key is real
- make sure you copied it fully

### For Ollama

- make sure Ollama is installed
- make sure Ollama is running
- make sure the model was pulled successfully
- if same-session chat history appears missing, verify the active `CONTEXT`
  value with `ollama ps`; OpenClaude requests 32K by default

### For LM Studio

- make sure LM Studio is installed
- make sure LM Studio is running
- make sure the server is enabled (toggle on in the "Developer" tab)
- make sure a model is loaded in LM Studio
- make sure the model name matches what you set in `OPENAI_MODEL`

## 6. Updating OpenClaude

```powershell
npm.cmd install -g @twigpine/openclaude@latest
```

## 7. Uninstalling OpenClaude

```powershell
npm.cmd uninstall -g @twigpine/openclaude
```


## Need Advanced Setup?

For advanced provider setup, custom endpoints, environment variables, and enterprise launch workflows, see the advanced setup guide:

- [Advanced setup](advanced-setup.md)

For Windows helper aliases and launcher shortcuts such as `oc`, `oc-init`, `oc-local`, `oc-provider`, and `oc-check`, see:

- [Windows aliases and launchers](windows-aliases-and-launchers.md)
