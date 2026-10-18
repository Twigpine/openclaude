# OpenClaude on Android (Termux)

A complete guide to running OpenClaude on Android using Termux + proot Ubuntu.

---

## Prerequisites

- Android phone with ~700MB free storage
- [Termux](https://f-droid.org/en/packages/com.termux/) installed from **F-Droid** (not Play Store)
- An [OpenRouter](https://openrouter.ai) API key (free, no credit card required)

---

## Why This Setup?

OpenClaude requires [Bun](https://bun.sh) to build, and Bun does not support Android natively. The workaround is running a real Ubuntu environment inside Termux via `proot-distro`, where Bun's Linux binary works correctly.

---

## Installation

### Step 1 — Update Termux

```bash
pkg update && pkg upgrade
```

Press `N` or Enter for any config file conflict prompts.

### Step 2 — Install dependencies

```bash
pkg install nodejs-lts git proot-distro
```

Verify Node.js:
```bash
node --version  # should be v20+
```

### Step 3 — Clone OpenClaude

```bash
git clone https://github.com/Twigpine/openclaude.git
cd openclaude
npm install
npm link
```

### Step 4 — Install Ubuntu via proot

```bash
proot-distro install ubuntu
```

This downloads ~200–400MB. Wait for it to complete.

### Step 5 — Install Bun inside Ubuntu

```bash
proot-distro login ubuntu
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
bun --version  # should show 1.3.13+
```

### Step 6 — Build OpenClaude

```bash
cd /data/data/com.termux/files/home/openclaude
bun run build
```

You should see:
```
✓ Built openclaude v0.1.6 → dist/cli.mjs
```

### Step 7 — Save env vars permanently

Still inside Ubuntu, add your OpenRouter config to `.bashrc`:

```bash
echo 'export CLAUDE_CODE_USE_OPENAI=1' >> ~/.bashrc
echo 'export OPENAI_API_KEY=your_openrouter_key_here' >> ~/.bashrc
echo 'export OPENAI_BASE_URL=https://openrouter.ai/api/v1' >> ~/.bashrc
echo 'export OPENAI_MODEL=qwen/qwen3.6-plus-preview:free' >> ~/.bashrc
source ~/.bashrc
```

Replace `your_openrouter_key_here` with your actual key from [openrouter.ai/keys](https://openrouter.ai/keys).

### Step 8 — Run OpenClaude

```bash
node dist/cli.mjs
```

Select **3** (3rd-party platform) at the login screen. Your env vars will be detected automatically.

---

## Restarting After Closing Termux

Every time you reopen Termux after killing it, run:

```bash
proot-distro login ubuntu
cd /data/data/com.termux/files/home/openclaude
node dist/cli.mjs
```

---

## Recommended Free Model

**`qwen/qwen3.6-plus-preview:free`** — Best free model on OpenRouter as of April 2026.

- 1M token context window
- Beats Claude 4.5 Opus on Terminal-Bench 2.0 agentic coding (61.6 vs 59.3)
- Built-in chain-of-thought reasoning
- Native tool use and function calling
- $0/M tokens (preview period)

> ⚠️ Free status may change when the preview period ends. Check [openrouter.ai](https://openrouter.ai/qwen/qwen3.6-plus-preview:free) for current pricing.

---

## Alternative Free Models (OpenRouter)

| Model ID | Context | Notes |
|---|---|---|
| `qwen/qwen3-coder:free` | 262K | Best for pure coding tasks |
| `openai/gpt-oss-120b:free` | 131K | OpenAI open model, strong tool calling |
| `nvidia/nemotron-3-super-120b-a12b:free` | 262K | Hybrid MoE, good general use |
| `meta-llama/llama-3.3-70b-instruct:free` | 66K | Reliable, widely tested |

Switch models anytime:
```bash
export OPENAI_MODEL=qwen/qwen3-coder:free
node dist/cli.mjs
```

---

## Why Not Groq or Cerebras?

Both were tested and fail due to OpenClaude's large system prompt (~50K tokens):

- **Groq free tier**: TPM limits too low (6K–12K tokens/min)
- **Cerebras free tier**: TPM limits exceeded, even on `llama3.1-8b`

OpenRouter free models have no TPM restrictions — only 20 req/min and 200 req/day.

---

## Tips

- **Don't swipe Termux away** from recent apps mid-session — use the home button to minimize instead.
- The Ubuntu environment persists between Termux sessions; your build and config are saved.
- Run `bun run build` again only if you pull updates to the OpenClaude repo.
