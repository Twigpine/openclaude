#!/bin/bash
# ============================================================================
# OpenClaude fork — launcher on FREE models (no Anthropic login)
# ============================================================================
# Routes the fork through one local Anthropic-compatible bridge backed by three
# free-tier providers:
#
#   opencode   session API      opencode/space-bunny-free     ~1.2 s
#   nim        FCC proxy        anthropic/nvidia_nim/...      ~1.3 s
#   cline      CLI spawn        cline-free/...               6-15 s
#
# Pick a provider by prefixing the model: `nvidia_nim/...`, `cline-free/...`,
# or leave it bare for opencode. Override the default with FCC_MODEL.
#
# Prerequisites:
#   1. opencode serve running  (port 18085)
#   2. FCC running              (port 8082)
#   3. the bridge running       (port 18095)
#
# start-all-free.sh does all three. This script only launches the fork.
#
# Usage:  ~/duo-stack/openclaude/run-opencode-free.sh [extra args]
# ============================================================================

FCC_PORT=18095
FCC_MODEL="${FCC_MODEL:-opencode/cat-jam-free}"

if ! curl -s -m 3 "http://127.0.0.1:${FCC_PORT}/v1/models" > /dev/null 2>&1; then
  echo "ERROR: opencode bridge not reachable on 127.0.0.1:${FCC_PORT}."
  echo "Run:  ~/duo-stack/openclaude/start-all-free.sh"
  exit 1
fi

export ANTHROPIC_BASE_URL="http://127.0.0.1:${FCC_PORT}"
export ANTHROPIC_AUTH_TOKEN="bridge"
export ANTHROPIC_MODEL="${FCC_MODEL}"

export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
export CLAUDE_CODE_AUTO_MODE_SERVER=0
export CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=190000
export DISABLE_AUTOUPDATER=1
export DISABLE_FEEDBACK_COMMAND=1
export DISABLE_ERROR_REPORTING=1

unset ANTHROPIC_API_KEY
unset CLAUDE_CODE_USE_OPENAI
unset CLAUDE_CODE_USE_BEDROCK
unset CLAUDE_CODE_USE_VERTEX

cd "$(dirname "$0")"
exec node dist/cli.mjs --model "$ANTHROPIC_MODEL" "$@"
