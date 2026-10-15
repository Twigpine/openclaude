#!/bin/bash
# Relaunch the TUI continuing the most recent conversation (-c).
export FCC_MODEL="${FCC_MODEL:-opencode/longcat-2.5-preview-free}"
exec "$HOME/duo-stack/openclaude/run-opencode-free.sh" -c
