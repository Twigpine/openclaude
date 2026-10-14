#!/bin/bash
# ============================================================================
# Start the opencode free-model stack for the OpenClaude fork.
#   1. `opencode serve`   on 127.0.0.1:18085
#   2. the Anthropic bridge on 127.0.0.1:18095
#
# Idempotent: safe to re-run. Prints the bridge token and the free models found.
# ============================================================================
set -u

OC_PORT=18085
BRIDGE_PORT=18095
STATE_DIR="${TMPDIR:-/tmp}/opencode"
mkdir -p "$STATE_DIR"
TOKEN_FILE="$STATE_DIR/bridge-token"
FORK_DIR="$(cd "$(dirname "$0")" && pwd)"

log() { printf '\n=== %s ===\n' "$1"; }

# --- 1. opencode server -----------------------------------------------------
if ss -tln 2>/dev/null | grep -q ":${OC_PORT} "; then
  log "opencode server already on ${OC_PORT}"
  OC_TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null)
  if [ -z "$OC_TOKEN" ]; then
    echo "No saved token; cannot reuse the running server."
    echo "Stop it and re-run, or set OC_BRIDGE_TOKEN manually."
    exit 1
  fi
else
  log "starting opencode serve on ${OC_PORT}"
  setsid nohup opencode serve --port "$OC_PORT" > "$STATE_DIR/opencode-serve.log" 2>&1 < /dev/null &
  # The port opens before the password line is flushed, so wait on the line
  # itself rather than on the listener — reading too early saves an empty token.
  OC_TOKEN=""
  for _ in $(seq 1 30); do
    OC_TOKEN=$(grep -o 'server password .*' "$STATE_DIR/opencode-serve.log" 2>/dev/null | awk '{print $3}')
    [ -n "$OC_TOKEN" ] && break
    sleep 1
  done
  if [ -z "$OC_TOKEN" ]; then
    echo "Could not read the server password:"
    cat "$STATE_DIR/opencode-serve.log"
    exit 1
  fi
  printf '%s' "$OC_TOKEN" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  echo "token saved to $TOKEN_FILE"
fi

# --- 1b. FCC proxy (nim backend) -------------------------------------------
if ss -tln 2>/dev/null | grep -q ":8082 "; then
  log "FCC already on 8082"
else
  if command -v fcc-server > /dev/null 2>&1; then
    log "starting FCC on 8082"
    setsid nohup fcc-server > "$STATE_DIR/fcc.log" 2>&1 < /dev/null &
    for _ in $(seq 1 20); do
      ss -tln 2>/dev/null | grep -q ":8082 " && break
      sleep 1
    done
  else
    log "fcc-server not installed — nim models unavailable"
    log "Install:  uv tool install /path/to/free-claude-code"
  fi
fi

# --- 2. bridge --------------------------------------------------------------
if ss -tln 2>/dev/null | grep -q ":${BRIDGE_PORT} "; then
  log "bridge already on ${BRIDGE_PORT}"
else
  log "starting bridge on ${BRIDGE_PORT}"
  OC_BRIDGE_PORT="$BRIDGE_PORT" OC_BRIDGE_URL="http://127.0.0.1:${OC_PORT}" \
    OC_BRIDGE_TOKEN="$OC_TOKEN" \
    setsid nohup node "$FORK_DIR/opencode-bridge.mjs" > "$STATE_DIR/bridge.log" 2>&1 < /dev/null &
  for _ in $(seq 1 20); do
    ss -tln 2>/dev/null | grep -q ":${BRIDGE_PORT} " && break
    sleep 1
  done
fi

# --- 3. verify --------------------------------------------------------------
log "bridge health"
# The opencode server populates its catalog a moment after boot. cline's entries
# are hardcoded in the bridge, so they are present immediately — waiting on the
# total count would stop as soon as those show up. Wait for opencode's instead.
OC_COUNT=0
for _ in $(seq 1 15); do
  OC_COUNT=$(curl -s -m 10 "http://127.0.0.1:${BRIDGE_PORT}/v1/models" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(sum(1 for m in d.get('data', []) if m.get('owned_by') == 'opencode'))
except Exception:
    print(0)
" 2>/dev/null)
  [ "${OC_COUNT:-0}" -gt 0 ] && break
  sleep 2
done

curl -s -m 10 "http://127.0.0.1:${BRIDGE_PORT}/v1/models" | python3 -c "
import sys, json
d = json.load(sys.stdin).get('data', [])
oc = [m for m in d if m.get('owned_by') == 'opencode']
cl = [m for m in d if m.get('owned_by') == 'cline']
print(f'{len(oc)} opencode models:')
for m in oc: print('  -', m['id'])
print(f'{len(cl)} cline models:')
for m in cl: print('  -', m['id'])
" 2>/dev/null || { echo "bridge unhealthy:"; tail -5 "$STATE_DIR/bridge.log"; exit 1; }

if [ "${OC_COUNT:-0}" -eq 0 ]; then
  echo ""
  echo "WARNING: opencode's catalog is still loading. Re-run in a few seconds."
fi

log "one live turn"
# A turn can come back empty while the model warms up; retry rather than
# reporting a stack that is actually fine.
LIVE_REPLY=""
for _ in 1 2 3; do
  LIVE_REPLY=$(curl -s -m 60 -X POST "http://127.0.0.1:${BRIDGE_PORT}/v1/messages" \
    -H 'Content-Type: application/json' -H 'x-api-key: bridge' -H 'anthropic-version: 2023-06-01' \
    -d "{\"model\":\"opencode/space-bunny-free\",\"max_tokens\":40,\"messages\":[{\"role\":\"user\",\"content\":\"Say exactly: READY\"}]}" \
    | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d['content'][0]['text'][:60] if 'content' in d else '')
except Exception:
    print('')
" 2>/dev/null)
  [ -n "$LIVE_REPLY" ] && break
  sleep 3
done
if [ -n "$LIVE_REPLY" ]; then
  echo "reply: $LIVE_REPLY"
else
  echo "WARNING: live turn returned nothing. The stack is up but the model may"
  echo "         still be warming — try again in a minute."
fi

cat << EOF

$(printf '%.0s─' {1..70})
Stack is up — three free providers behind one Anthropic API:

  opencode   session API   ~1.2 s    (opencode/space-bunny-free)
  nim        FCC proxy     ~1.3 s    (anthropic/nvidia_nim/...)
  cline      CLI spawn     6-15 s    (cline-free/...)

Launch the fork with:

  ${FORK_DIR}/run-opencode-free.sh            # TUI
  ${FORK_DIR}/run-opencode-free.sh -p "hi"    # headless

In /model, press 'c' to probe availability — free tiers rotate, so the list and
the verdicts are always re-read rather than trusted.
$(printf '%.0s─' {1..70})
EOF
