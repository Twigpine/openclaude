#!/bin/bash
# ---------------------------------------------------------------------------
# SUPERSEDED (2026-10-16) — kept for reference.
# The stack now runs the Anthropic bridge (127.0.0.1:18095) in front of FCC +
# free providers, so OpenClaude gets failover, opencode/cline routing and
# native tool_use. Use instead:
#   start-all-free.sh      boots FCC + bridge + opencode serve (idempotent)
#   run-opencode-free.sh   the TUI (add --resume <id> to resume a session)
#   continue-tui.sh        resume the last TUI session in a new terminal
# This direct-FCC path still works when fcc-server is up, but has no failover.
# ---------------------------------------------------------------------------
# ============================================================================
# OpenClaude fork — free-model launcher (no Anthropic login)
# ============================================================================
# Routes the fork through Free Claude Code (FCC), a local Anthropic-compatible
# proxy on port 8082 backed by NVIDIA NIM's free tier.
#
# Prerequisites:
#   1. FCC installed:   uv tool install /path/to/free-claude-code
#   2. ~/.fcc/.env has NVIDIA_NIM_API_KEY + MODEL
#   3. fcc-server running (port 8082)
#
# Usage:  ~/duo-stack/openclaude/run-free.sh [extra args]
# ============================================================================

FCC_PORT="${FCC_PORT:-8082}"
FCC_TOKEN="${FCC_TOKEN:-freecc}"
FCC_MODEL="${FCC_MODEL:-nvidia_nim/nvidia/nemotron-3-super-120b-a12b}"

# Fail fast if the proxy is not up.
if ! curl -s -m 3 "http://127.0.0.1:${FCC_PORT}/admin/api/status" > /dev/null 2>&1; then
  echo "ERROR: FCC proxy not reachable on 127.0.0.1:${FCC_PORT}."
  echo "Start it with:  setsid nohup fcc-server > /tmp/fcc-server.log 2>&1 < /dev/null &"
  exit 1
fi

export ANTHROPIC_BASE_URL="http://127.0.0.1:${FCC_PORT}"
export ANTHROPIC_AUTH_TOKEN="${FCC_TOKEN}"
export ANTHROPIC_MODEL="${FCC_MODEL}"

# FCC's recommended Claude Code env policy (mirrors FCC's own fcc-claude launcher).
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
export CLAUDE_CODE_AUTO_MODE_SERVER=0
export CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=190000
export DISABLE_AUTOUPDATER=1
export DISABLE_FEEDBACK_COMMAND=1
export DISABLE_ERROR_REPORTING=1

# Belt and braces: make sure no real Anthropic credential shadows the proxy.
unset ANTHROPIC_API_KEY
unset CLAUDE_CODE_USE_OPENAI
unset CLAUDE_CODE_USE_BEDROCK
unset CLAUDE_CODE_USE_VERTEX

cd "$(dirname "$0")"
exec node dist/cli.mjs "$@"
