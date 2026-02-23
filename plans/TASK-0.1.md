# Task 0.1 — Pre-Flight Validation + Create Infrastructure

## What will change
- Create `scripts/verify-task.sh` — gate script
- Create `scripts/crackbot-supervisor.sh` — auto-resume wrapper
- Create `BUILD-LOG.md` — append-only task log
- Create `claude-progress.json` — machine-readable state
- Create `HANDOFF.md` — context recovery file
- Create `plans/` directory
- Record `.test-baseline.txt`

## Why
These files enable the autonomous build protocol: gate checks after every task, crash recovery via HANDOFF.md, and supervisor auto-resume.

## Verification
- `npm run build` exits 0
- On branch `build/session-manager`
- All infrastructure files exist

## What could go wrong
- Very little — these are all new files with no code changes

## Estimated time
5 minutes
