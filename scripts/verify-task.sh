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

# 5. Code must build
echo ""
echo "--- Build check ---"
if npm run build 2>/dev/null; then
  echo "OK Builds clean"
else
  echo "FAIL: Build errors. Run: npm run build"
  PASS=false
fi

# 6. Ban checks — source
if [ -d "src/" ]; then
  echo ""
  echo "--- Banned patterns (source) ---"
  EMPTY_CATCH=$(grep -rPc 'catch\s*(\(\w+\))?\s*\{\s*\}' src/ 2>/dev/null | awk -F: '{s+=$NF} END {print s+0}')
  EMPTY_CATCH=${EMPTY_CATCH:-0}
  if [ "$EMPTY_CATCH" -gt 0 ]; then
    echo "FAIL: Found $EMPTY_CATCH empty catch blocks in src/"
    PASS=false
  else
    echo "OK No empty catch blocks"
  fi

  # Check for type suppression (eslint-disable has 2 pre-existing in protected files)
  for SUPPRESS in "@ts-ignore" "@ts-nocheck" "# type: ignore"; do
    SUP_COUNT=$(grep -rc "$SUPPRESS" src/ 2>/dev/null | awk -F: '{s+=$NF} END {print s+0}')
    if [ "$SUP_COUNT" -gt 0 ]; then
      echo "FAIL: Found $SUP_COUNT uses of '$SUPPRESS' in src/"
      PASS=false
    else
      echo "OK No '$SUPPRESS' in source"
    fi
  done

  # eslint-disable: baseline is 2 (useTerminal.js + ProjectView.jsx — both pre-existing, protected)
  ESLINT_COUNT=$(grep -rc "// eslint-disable" src/ 2>/dev/null | awk -F: '{s+=$NF} END {print s+0}')
  if [ "$ESLINT_COUNT" -gt 2 ]; then
    echo "FAIL: Found $ESLINT_COUNT uses of '// eslint-disable' in src/ (baseline: 2)"
    PASS=false
  else
    echo "OK No new '// eslint-disable' in source (baseline: $ESLINT_COUNT)"
  fi
fi

# 7. Existing features haven't decreased
FEATURE_COUNT=$(grep -c "{ id:" src/components/Dashboard/DashboardView.jsx 2>/dev/null || echo "0")
if [ "$FEATURE_COUNT" -lt 12 ]; then
  echo "FAIL: Dashboard tab count dropped to $FEATURE_COUNT (must be >= 12)"
  PASS=false
else
  echo "OK Dashboard tab count: $FEATURE_COUNT (>= 12)"
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
