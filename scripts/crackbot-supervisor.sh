#!/bin/bash
# scripts/crackbot-supervisor.sh — Auto-resume wrapper for autonomous builds (v5)
# Usage: bash scripts/crackbot-supervisor.sh AUTONOMOUS-BUILD.md [max-retries]
#
# Watches the Claude process. If it exits before BUILD_COMPLETE,
# auto-resumes with --continue. Stops when BUILD_COMPLETE or max retries hit.

set -uo pipefail

BUILD_FILE="${1:?Usage: crackbot-supervisor.sh <build-file.md> [max-retries]}"
MAX_RETRIES="${2:-5}"
LOG_FILE="scripts/supervisor.log"
RETRY=0

mkdir -p scripts
echo "$(date '+%Y-%m-%d %H:%M:%S') [supervisor] Starting. Build file: $BUILD_FILE, Max retries: $MAX_RETRIES" >> "$LOG_FILE"

# First launch — full prompt
echo "$(date '+%Y-%m-%d %H:%M:%S') [supervisor] Initial launch..." >> "$LOG_FILE"
cat "$BUILD_FILE" | claude --dangerously-skip-permissions -p -
EXIT_CODE=$?

while true; do
  # Check if build is complete
  if [ -f "HANDOFF.md" ] && grep -qi "BUILD.COMPLETE\|BUILD COMPLETE" HANDOFF.md 2>/dev/null; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [supervisor] BUILD COMPLETE detected. Exiting." >> "$LOG_FILE"
    echo "[supervisor] Build completed successfully after $RETRY restart(s)."
    exit 0
  fi

  # Check retry limit
  RETRY=$((RETRY + 1))
  if [ "$RETRY" -gt "$MAX_RETRIES" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [supervisor] Max retries ($MAX_RETRIES) reached. Giving up." >> "$LOG_FILE"
    echo "[supervisor] Max retries reached. Check HANDOFF.md and BUILD-LOG.md for status."
    exit 1
  fi

  # Auto-resume
  echo "$(date '+%Y-%m-%d %H:%M:%S') [supervisor] Claude exited (code $EXIT_CODE). Resuming (attempt $RETRY/$MAX_RETRIES)..." >> "$LOG_FILE"
  sleep 5  # Brief pause before resume

  claude --dangerously-skip-permissions --continue -p "Read claude-progress.json and HANDOFF.md. If SELF-REVIEW-FINDINGS.md exists with unchecked items, read it too. Resume from the current task."
  EXIT_CODE=$?
done
