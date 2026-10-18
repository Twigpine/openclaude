# OpenClaude Quick Start for macOS and Linux

This guide uses a standard shell such as Terminal, iTerm, bash, or zsh.

## 1. Install Node.js

Install Node.js 22 LTS or newer from:

- `https://nodejs.org/`

Then check it:

```bash
node --version
npm --version
```

## 2. Install OpenClaude

```bash
npm install -g @twigpine/openclaude@latest
```

Upgrading from `@gitlawb/openclaude`? The package moved to the `@twigpine`
scope and the old one is no longer updated. npm will not install one over the
other because both provide the `openclaude` command, so remove the old package
first:

```bash
npm uninstall -g @gitlawb/openclaude
npm install -g @twigpine/openclaude@latest
```

On Arch Linux, you can alternatively install OpenClaude via the community-maintained [AUR package](https://aur.archlinux.org/packages/openclaude):

```bash
paru -S openclaude
```
## 3. Pick One Provider

### Option A: OpenAI

Replace `sk-your-key-here` with your real key.

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=sk-your-key-here
export OPENAI_MODEL=gpt-4o

openclaude
```

### Option B: DeepSeek

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=sk-your-key-here
export OPENAI_BASE_URL=https://api.deepseek.com/v1
export OPENAI_MODEL=deepseek-v4-flash

openclaude
```

Use `deepseek-v4-pro` when you want the stronger model. `deepseek-chat` and `deepseek-reasoner` still work as DeepSeek's legacy API aliases.

### Option C: Ollama

Install Ollama first from:

- `https://ollama.com/download`

Then run:

```bash
ollama pull llama3.1:8b

export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_BASE_URL=http://localhost:11434/v1
export OPENAI_MODEL=llama3.1:8b

openclaude
```

No API key is needed for Ollama local models.

OpenClaude asks Ollama for a 32768-token context window on each chat request.
If you need a different size, set `OPENCLAUDE_OLLAMA_NUM_CTX` before launching
OpenClaude, or start Ollama with a global context setting:

```bash
# Stop any existing Ollama app/server first, then run:
OLLAMA_CONTEXT_LENGTH=32768 ollama serve
```

After a chat request, run `ollama ps` in another terminal and check the
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

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_BASE_URL=http://localhost:1234/v1
export OPENAI_MODEL=your-model-name
# export OPENAI_API_KEY=lmstudio  # optional: some users need a dummy key

openclaude
```

Replace `your-model-name` with the model name shown in LM Studio.

No API key is needed for LM Studio local models (but uncomment the `OPENAI_API_KEY` line if you hit auth errors).

### Option E: Using a .env file (Optional)

If you prefer to keep your keys in a `.env` file instead of exporting them individually, note that OpenClaude does not load `.env` files automatically. You must explicitly pass it:

```bash
openclaude --provider-env-file .env
```

Keep `.env` out of git because it contains secrets.
The explicit loader accepts provider/setup variables. Export runtime/debug variables from your shell or launcher instead.

## 4. If `openclaude` Is Not Found

Close the terminal, open a new one, and try again:

```bash
openclaude
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

**Via npm:**
```bash
npm install -g @twigpine/openclaude@latest
```

**Via AUR:**
```bash
paru
```
*(Or use your preferred AUR helper like `yay -Syu`)*

## 7. Uninstalling OpenClaude

**Via npm:**
```bash
npm uninstall -g @twigpine/openclaude
```

**Via AUR (Arch Linux):**
```bash
paru -Rns openclaude
```

## Need Advanced Setup?

Use:

- [Advanced Setup](advanced-setup.md)
  For Codex, Gemini, Mistral, LiteLLM, provider profiles, and runtime diagnostics.
