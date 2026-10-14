#!/bin/bash
# Open the OpenClaude TUI in a new terminal window on the free model.
# Requires: fcc-server running on 127.0.0.1:8082, DISPLAY set.
set -euo pipefail

export DISPLAY="${DISPLAY:-:0.0}"
RUN_FREE="$HOME/duo-stack/openclaude/run-free.sh"

if ! curl -s -m 3 "http://127.0.0.1:8082/admin/api/status" > /dev/null 2>&1; then
  echo "FCC proxy is not running. Starting it..."
  setsid nohup fcc-server > /tmp/fcc-server.log 2>&1 < /dev/null &
  sleep 8
fi

setsid nohup xfce4-terminal \
  --hide-menubar \
  --hide-toolbar \
  --hide-scrollbar \
  --initial-title="OpenClaude - free model (nemotron-3-super)" \
  --geometry=120x36 \
  --hold \
  -x "$RUN_FREE" \
  > /tmp/oc-terminal.log 2>&1 < /dev/null &

sleep 4
export DISPLAY
if wmctrl -l 2>/dev/null | grep -qi "OpenClaude - free model"; then
  echo "OpenClaude window opened:"
  wmctrl -l | grep -i "OpenClaude - free model"
else
  echo "Window may not have opened. Check /tmp/oc-terminal.log"
fi
