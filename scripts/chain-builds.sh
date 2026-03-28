#!/bin/bash
# scripts/chain-builds.sh — Run multiple autonomous builds sequentially
# Usage: bash scripts/chain-builds.sh
#
# Runs each build with the supervisor. When one completes (BUILD COMPLETE),
# starts the next. Stops if a build fails after max retries.

set -uo pipefail

LOG_FILE="scripts/chain-builds.log"
BUILDS=("BUILD-agent-memory.md" "BUILD-board-view.md" "BUILD-orchestrator.md")
TOTAL=${#BUILDS[@]}

echo "$(date '+%Y-%m-%d %H:%M:%S') [chain] Starting chain build: ${TOTAL} builds" | tee -a "$LOG_FILE"

for i in "${!BUILDS[@]}"; do
  BUILD="${BUILDS[$i]}"
  NUM=$((i + 1))

  echo "" | tee -a "$LOG_FILE"
  echo "$(date '+%Y-%m-%d %H:%M:%S') [chain] ========================================" | tee -a "$LOG_FILE"
  echo "$(date '+%Y-%m-%d %H:%M:%S') [chain] Build ${NUM}/${TOTAL}: ${BUILD}" | tee -a "$LOG_FILE"
  echo "$(date '+%Y-%m-%d %H:%M:%S') [chain] ========================================" | tee -a "$LOG_FILE"

  # Run with supervisor
  bash scripts/crackbot-supervisor.sh "$BUILD" 5
  EXIT_CODE=$?

  if [ $EXIT_CODE -ne 0 ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [chain] FAILED: ${BUILD} (exit code ${EXIT_CODE})" | tee -a "$LOG_FILE"
    echo "$(date '+%Y-%m-%d %H:%M:%S') [chain] Stopping chain. Check HANDOFF.md for details." | tee -a "$LOG_FILE"

    # macOS notification
    osascript -e "display notification \"Build ${NUM}/${TOTAL} FAILED: ${BUILD}\" with title \"Dobius+ Chain Build\" sound name \"Basso\"" 2>/dev/null
    exit 1
  fi

  echo "$(date '+%Y-%m-%d %H:%M:%S') [chain] COMPLETE: ${BUILD}" | tee -a "$LOG_FILE"

  # Brief pause between builds
  if [ $NUM -lt $TOTAL ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [chain] Pausing 10s before next build..." | tee -a "$LOG_FILE"
    sleep 10

    # Clean up build artifacts from previous build (progress files get regenerated)
    rm -f claude-progress.json HANDOFF.md BUILD-LOG.md SELF-REVIEW-FINDINGS.md
    rm -rf plans/
  fi
done

echo "" | tee -a "$LOG_FILE"
echo "$(date '+%Y-%m-%d %H:%M:%S') [chain] ========================================" | tee -a "$LOG_FILE"
echo "$(date '+%Y-%m-%d %H:%M:%S') [chain] ALL ${TOTAL} BUILDS COMPLETE" | tee -a "$LOG_FILE"
echo "$(date '+%Y-%m-%d %H:%M:%S') [chain] ========================================" | tee -a "$LOG_FILE"

# macOS notification
osascript -e "display notification \"All ${TOTAL} builds completed successfully!\" with title \"Dobius+ Chain Build\" sound name \"Glass\"" 2>/dev/null

# Summary
echo ""
echo "Chain build summary:"
echo "  1. Agent Memory  — merged to main"
echo "  2. Board View    — merged to main"
echo "  3. Orchestrator  — merged to main"
echo ""
echo "Check git log for full history: git log --oneline -40"
