# Task 0.1 — Pre-Flight Validation + Create Infrastructure

## What will change
- Create `scripts/verify-task.sh` — gate script
- Create `scripts/crackbot-supervisor.sh` — auto-resume wrapper
- Create `BUILD-LOG.md` — empty build log
- Create `claude-progress.json` — initial progress state
- Create `HANDOFF.md` — initial handoff file
- Create `.test-baseline.txt` — build baseline capture

## Why
These files form the autonomous build infrastructure. Every subsequent task depends on them for verification, progress tracking, and crash recovery.

## Verification
- `npx vite build` exits 0
- On branch `build/mission-control`
- All infrastructure files exist

## What could go wrong
- Git stash might fail if there are conflicts — already handled above
- Build might fail from pre-existing issues — already verified passes

## Estimated time
5 minutes
