# Orchestrator Build — Handoff

## Status: BUILD COMPLETE
## Branch: build/orchestrator (merged to main)

## What Was Built
- **Task Orchestrator**: 14th dashboard tab for delegating work to agent teams
- **Decomposition Engine**: Uses Haiku to break tasks into 2-5 subtasks
- **Parallel Agent Launch**: Launch All button with 1s stagger, or per-subtask Launch
- **Progress Monitoring**: Real-time status via terminal exit handler + agentActivity
- **Synthesis Summary**: Status banner, per-subtask output, duration, history
- **Cross-linking**: MC stats card, Board orchestration banner, View on Board/Terminal links
- **Self-review**: 8 findings fixed (shell injection, race conditions, listener leaks, dead code)

## Stats
- 10 commits, 0 verification failures
- 14 files changed, +1,263/-45 lines
- Bundle: ~1,330KB (minimal growth, no new deps)
- Dashboard tabs: 14

## Key Files
- `electron/config-manager.js` — orchestration CRUD (max 20 runs, FIFO)
- `electron/main.js` — orchestration IPC handlers
- `electron/preload.js` — orchestration API bridge
- `src/store/store.js` — activeOrchestration + updateSubtaskStatus
- `src/components/Dashboard/Orchestrator/OrchestratorView.jsx` — full UI
- `src/components/Project/ProjectView.jsx` — orchestration completion tracking
- `src/components/Dashboard/DashboardView.jsx` — tab registration (#14)
- `src/components/Dashboard/Agents.jsx` — Orchestrator stat card
- `src/components/Dashboard/Board/BoardView.jsx` — orchestration banner

## Key Security
- Shell injection fix: user description piped via temp file, never shell-evaluated
- ALLOWED_MODELS allowlist enforced on all agent launches
- IPC input validation: length checks, type checks, prototype pollution guards
- Listener cleanup: try-finally pattern prevents leaks

## Build Passes: YES

---

## Handoff update — 2026-06-13 (scaffolding)

**Done:**
- `.claude/CLAUDE.md` (Claude workflow layer) in place.
- `.claude/settings.json` created with scoped permissions: allows `dev`, `build`, `build:mobile`, `electron:dev`, `start`, read-only git (`status`, `diff`, `log`), and `npx electron-rebuild`. Denies `npm run electron:build` (signed/notarized release — human-only) and `./build-and-install.sh` (rm -rf + install to /Applications — human-only).
- Scaffolding files (LESSONS-LEARNED.md, BUILD-LOG.md, HANDOFF.md) updated with a dated section each.

**In progress:**
- ~27 uncommitted files — the in-flight dashboard feature. Untracked: `electron/file-change-service.js`, `src/components/Dashboard/{ChangeFeed,Costs,Prompts,Search}.jsx`, `src/components/Launcher/ProjectContextMenu.jsx`. Plus 21 modified (Dashboard views, store.js, electron data/preload/window/voice services, several launcher/project/shared components, AUTONOMOUS-BUILD.md, package-lock.json).
- Branch: `feature/multi-account-cli-path`, last commit `d082675`.

**Next:**
- Review and branch the in-flight dashboard work deliberately before starting new builds. Do not blow it away; confirm intent before committing or branching over it.

**Known issues / cautions:**
- See `LESSONS-LEARNED.md` (incl. the 2026-06-13 audit section) for runtime/build gotchas: null bytes in `execFile`, dev process name `"Electron"`, `build-and-install.sh` rm -rf, mounted-tab requirement, native-module rebuild, remote-debugging-port pre-ship check, config.json not hand-editable.
- `npm run electron:build` and `./build-and-install.sh` are human-initiated only and are denied in `.claude/settings.json`.
