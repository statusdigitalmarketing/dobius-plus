#!/bin/bash
# scripts/verify-task.sh — Gate script for Dobius+ autonomous build (v5)
# Usage: bash scripts/verify-task.sh 1.1
# Claude CANNOT proceed to the next task until this exits with code 0.

set -uo pipefail

TASK="${1:-}"
if [ -z "$TASK" ]; then
  echo "FAIL: Usage: bash scripts/verify-task.sh <task-number>"
  exit 1
fi

PASS=true
WARNINGS=""

echo "=== Verifying Task $TASK ==="
echo ""

# 1. Plan file must exist
if [ ! -f "plans/TASK-${TASK}.md" ]; then
  echo "FAIL: plans/TASK-${TASK}.md does not exist."
  PASS=false
else
  echo "OK Plan file exists"
fi

# 2. Review file must exist
if [ ! -f "plans/TASK-${TASK}-REVIEW.md" ]; then
  echo "FAIL: plans/TASK-${TASK}-REVIEW.md does not exist."
  PASS=false
else
  echo "OK Review file exists"
fi

# 3. Latest commit must reference this task
LAST_COMMIT=$(git log -1 --format=%s 2>/dev/null || echo "")
if ! echo "$LAST_COMMIT" | grep -qi "Task ${TASK}\|WIP.*${TASK}"; then
  echo "FAIL: Latest commit doesn't reference Task ${TASK}."
  echo "  Last commit: '$LAST_COMMIT'"
  PASS=false
else
  echo "OK Commit references Task ${TASK}"
fi

# 4. Must be on feature branch (not main)
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
if [ "$CURRENT_BRANCH" = "main" ] || [ "$CURRENT_BRANCH" = "master" ]; then
  echo "FAIL: On '$CURRENT_BRANCH' — should be on feature branch. Commits must NOT go directly to main."
  PASS=false
else
  echo "OK On branch: $CURRENT_BRANCH"
fi

# 5. Build must succeed (after Task 1.1 sets up Vite)
if [ -f "vite.config.js" ] || [ -f "vite.config.mjs" ]; then
  echo ""
  echo "--- Build check ---"
  if npm run build 2>/dev/null; then
    echo "OK Build succeeds"
  else
    echo "FAIL: Build errors. Run: npm run build"
    PASS=false
  fi
fi

# 6. Ban checks — source
if [ -d "src" ]; then
  echo ""
  echo "--- Banned patterns (source) ---"
  EMPTY_CATCH=$(grep -rEc 'catch[[:space:]]*(\([a-zA-Z_]+\))?[[:space:]]*\{[[:space:]]*\}' src/ 2>/dev/null | awk -F: '{s+=$NF} END {print s+0}')
  EMPTY_CATCH=${EMPTY_CATCH:-0}
  if [ "$EMPTY_CATCH" -gt 0 ]; then
    echo "FAIL: Found $EMPTY_CATCH empty catch blocks in src/"
    PASS=false
  else
    echo "OK No empty catch blocks"
  fi

  # CRITICAL: Check for writes to ~/.claude/
  CLAUDE_WRITES=$(grep -rc 'writeFile.*\.claude\|fs\.write.*\.claude\|unlink.*\.claude\|rmSync.*\.claude\|mkdirSync.*\.claude' src/ electron/ 2>/dev/null | awk -F: '{s+=$NF} END {print s+0}')
  CLAUDE_WRITES=${CLAUDE_WRITES:-0}
  if [ "$CLAUDE_WRITES" -gt 0 ]; then
    echo "FAIL: Found $CLAUDE_WRITES writes to ~/.claude/ — MUST be read-only"
    PASS=false
  else
    echo "OK No writes to ~/.claude/"
  fi
fi

# 7. Component count (should grow over time)
if compgen -G "src/components/**/*.jsx" > /dev/null 2>&1 || compgen -G "src/components/*.jsx" > /dev/null 2>&1; then
  COMPONENT_COUNT=$(find src/components -name "*.jsx" 2>/dev/null | wc -l | tr -d ' ')
  echo "OK Component count: $COMPONENT_COUNT"
fi

# 8. BUILD-LOG has entry
if [ -f "BUILD-LOG.md" ]; then
  if grep -q "Task ${TASK}" BUILD-LOG.md 2>/dev/null; then
    echo "OK BUILD-LOG.md has entry"
  else
    WARNINGS="$WARNINGS\n- Missing BUILD-LOG entry"
  fi
fi

# 9. Progress file
if [ -f "claude-progress.json" ]; then
  echo "OK claude-progress.json exists"
else
  WARNINGS="$WARNINGS\n- Missing claude-progress.json"
fi

# 10. HANDOFF.md exists and is up-to-date
if [ -f "HANDOFF.md" ]; then
  if grep -q "Task ${TASK}\|${TASK}" HANDOFF.md 2>/dev/null; then
    echo "OK HANDOFF.md mentions Task ${TASK}"
  else
    echo "FAIL: HANDOFF.md does not mention Task ${TASK}. Update it NOW — stale handoffs waste 20+ min on restart."
    PASS=false
  fi
else
  echo "FAIL: HANDOFF.md missing"
  PASS=false
fi

# Results
echo ""
echo "==========================================="
if [ "$PASS" = true ]; then
  echo "PASS: Task $TASK verified."
  if [ -n "$WARNINGS" ]; then
    echo "Warnings:"; echo -e "$WARNINGS"
  fi
  exit 0
else
  echo "FAIL: Task $TASK has failures. Fix and re-run."
  exit 1
fi
