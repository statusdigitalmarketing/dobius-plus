# Task 0.1: Pre-Flight Validation + Create Infrastructure

## What I will change
- Create feature branch `build/dobius-plus-v1`
- Create `scripts/verify-task.sh` — gate script for all tasks
- Create `BUILD-LOG.md` — append-only build log
- Create `claude-progress.json` — machine-readable state
- Create `HANDOFF.md` — recovery document
- Create `plans/` directory
- Create `.test-baseline.txt`

## Why this change is needed
The autonomous build system requires infrastructure files for progress tracking, verification, and crash recovery. Without these, context loss means complete restart.

## Verification
- On branch `build/dobius-plus-v1`
- All 6 infrastructure files exist
- `verify-task.sh` is executable

## What could go wrong
- Branch already exists (would fail checkout)
- Directory permissions

## Estimated time
10-15 minutes
