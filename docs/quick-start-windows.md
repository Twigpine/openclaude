# OpenClaude Quick Start for Windows

This guide uses Windows PowerShell.

## 1. Install Node.js

Install Node.js 22 LTS or newer from:

- `https://nodejs.org/`

Then open PowerShell and check it:

```powershell
node --version
npm --version
```

## 2. Install OpenClaude

```powershell
npm install -g @twigpine/openclaude@latest
```

Upgrading from `@gitlawb/openclaude`? The package moved to the `@twigpine`
scope and the old one is no longer updated. npm will not install one over the
other because both provide the `openclaude` command, so remove the old package
first:

```powershell
npm uninstall -g @gitlawb/openclaude
npm install -g @twigpine/openclaude@latest
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

openclaude
```

### Option B: DeepSeek

```powershell
$env:CLAUDE_CODE_USE_OPENAI="1"
$env:OPENAI_API_KEY="sk-your-key-here"
$env:OPENAI_BASE_URL="https://api.deepseek.com/v1"
$env:OPENAI_MODEL="deepseek-v4-flash"

openclaude
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

openclaude
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

openclaude
```

Replace `your-model-name` with the model name shown in LM Studio.

No API key is needed for LM Studio local models (but uncomment the `OPENAI_API_KEY` line if you hit auth errors).

### Option E: Using a .env file (Optional)

If you prefer to keep your keys in a `.env` file instead of exporting them individually, note that OpenClaude does not load `.env` files automatically. You must explicitly pass it:

```powershell
openclaude --provider-env-file .env
```

Keep `.env` out of git because it contains secrets.
The explicit loader accepts provider/setup variables. Set runtime/debug variables in PowerShell or your launcher instead.

## 4. If `openclaude` Is Not Found

Close PowerShell, open a new one, and try again:

```powershell
openclaude
```

If PowerShell still says `openclaude` is not recognized, npm's global bin
folder may be missing from your user `Path`. Add it, then open a new
PowerShell window:

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
npm install -g @twigpine/openclaude@latest
```

## 7. Uninstalling OpenClaude

```powershell
npm uninstall -g @twigpine/openclaude
```


## Need Advanced Setup?

For advanced provider setup, custom endpoints, environment variables, and enterprise launch workflows, see the advanced setup guide:

- [Advanced setup](advanced-setup.md)

For Windows helper aliases and launcher shortcuts such as `oc`, `oc-init`, `oc-local`, `oc-provider`, and `oc-check`, see:

- [Windows aliases and launchers](windows-aliases-and-launchers.md)
