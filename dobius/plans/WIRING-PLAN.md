# Wiring Plan — engine ↔ system ↔ UI (Dobius+ automation port)

Canonical spec for connecting the ported Dobius engine services to dobius's UI. **Codex implements from this; Claude reviews against it** (review-audit + ship-test as gates). Every connection follows an dobius convention already in the codebase — nothing invented.

---

## 0. Proven reference chain (already shipped — copy its shape)

The iMessage bridge is wired end-to-end and in production. Every new feature repeats this exact chain:

```
src/main/imessage-bridge/bridge-service.ts     (engine: poll chat.db, dispatch)
  └─ src/main/imessage-bridge/bridge-config.ts (system: self-owned JSON in userData)
  └─ src/main/ipc/imessage-bridge.ts           (IPC: imessageBridge:getConfig|updateConfig|status)
       registered in src/main/ipc/register-core-handlers.ts
  └─ src/preload/index.ts (window.api.imessageBridge)  +  src/preload/api-types.ts (types)
  └─ src/renderer/.../settings/ImessageBridgeSetting.tsx  (UI: Mobile settings pane)
  └─ src/shared/imessage-bridge.ts             (shared types across the boundary)
lifecycle: start/stop in src/main/index.ts (whenReady / will-quit)
dispatch:  src/main/runtime/dobius-runtime.ts  resolveActiveTerminal() → sendTerminal(handle,{text,enter})
```

Request/response only. New features that need **live** UI add a push channel on top (§2).

---

## 1. The canonical 5-layer wiring pattern

| Layer | dobius home | Convention |
|---|---|---|
| **Engine** | `src/main/<feature>/…-service.ts` | long-running logic; no Electron/IPC imports leak into it |
| **System/config** | `src/main/<feature>/…-config.ts` (JSON) + `…-token-store.ts` (safeStorage `.enc` for secrets) | self-owned files in `app.getPath('userData')`; **never** `GlobalSettings` |
| **IPC boundary** | `src/main/ipc/<feature>.ts` → `register<Feature>Handlers()` | request: `ipcMain.handle('feature:verb', …)`; **push**: `mainWindow.webContents.send('feature:updated', payload)` guarded by `!isDestroyed()` |
| **Preload** | `src/preload/index.ts` `window.api.<feature>` + `src/preload/api-types.ts` | request: `invoke(...)`; push: `onFeatureUpdated(cb) → ipcRenderer.on(...)` returning an unsubscribe (copy `repos:changed`, preload `index.ts:574`) |
| **Renderer** | live data → zustand slice `store/slices/<feature>.ts` + `use<Feature>()` hook subscribing to `onFeatureUpdated`; config-only → read directly in the pane, no slice | UI component mounts on one of the 3 surfaces below |

**Reactive rule:** any data that changes while a window is open (task lists, auto-mode state, build progress) flows **engine → `webContents.send` push → preload `onX` → hook updates slice → component re-renders**. Do **not** leave the UI on a bare `setInterval`. Config that only changes on user save reads request/response on pane open.

**Three UI mount surfaces (all additive — see §4):**
1. Right-sidebar tab — `store/slices/editor.ts` (`ActiveRightSidebarTab` union) + `components/right-sidebar/index.tsx` (items array + render switch). For list/status panels.
2. Status-bar item — `components/status-bar/StatusBar.tsx`. For small always-visible indicators.
3. Settings section — `components/settings/Settings.tsx` (`SETTINGS_NAV_GROUPS` + `<SettingsSection>`) + `hooks/useSettingsNavigationMetadata.ts`. For config UIs. Desktop-gate with `showDesktopOnlySettings`.

---

## 2. Per-feature wiring maps

### C — Asana config (Phase 0) — request/response, no live data
```
ENGINE/SYSTEM  src/main/asana/asana-config.ts    (JSON: myGid, reviewGid, allowedProjects[], autoMode{enabled,intervalMinutes})
               src/main/asana/asana-token-store.ts (safeStorage .enc — PAT; hasToken() without decrypt)
IPC            src/main/ipc/asana.ts  asana:getConfig | updateConfig | setToken | hasToken | clearToken
PRELOAD        window.api.asana.{getConfig,updateConfig,setToken,hasToken,clearToken}
UI (NEW)       settings section "Automation" → AsanaPane.tsx
               PAT field is write-only (shows "set / not set" from hasToken — the raw token NEVER crosses to the renderer),
               two lane-GID fields, Auto Mode toggle.
```
No store slice (config changes only on save). Pane calls `window.api.asana.getConfig()` on mount.

### A2 + B1 — Asana queue + Tasks panel (Phase 1) — **live**, needs push
```
ENGINE   src/main/asana/asana-client.ts        (https to app.asana.com w/ PAT; build lane = my incomplete, review lane = Sam recently-done)
         src/main/asana/asana-queue-service.ts (poll on interval; cache; on change → PUSH)
PUSH     mainWindow.webContents.send('asana:tasksUpdated', { build[], review[] })   (guarded !isDestroyed)
IPC      src/main/ipc/asana.ts (extend)  asana:listTasks | refresh | completeTask | markLocalDone
PRELOAD  window.api.asana.{listTasks, refresh, completeTask, markLocalDone, onTasksUpdated(cb)}
STATE    src/renderer/src/store/slices/asana.ts  ({ buildTasks, reviewTasks, lastSync })
HOOK     useAsanaTasks() — subscribes to onTasksUpdated, hydrates the slice
UI (NEW) Tasks right-sidebar tab → TasksPanel.tsx (two lanes, color-coded, "⟳ Sync" → refresh, local-done tick)
```
Reactive path: service polls → pushes `asana:tasksUpdated` → hook writes slice → TasksPanel re-renders. **`completeTask` (the one Asana write) is only invoked by an explicit user click — never by the poller, never by markLocalDone.**

### A1 — dobius-* CLI dispatch (Phase 2) — wires to UI *indirectly*
```
ENGINE  src/main/dobius-cli/dispatch-server.ts (127.0.0.1 HTTP, Bearer token 0600 in userData, timingSafeEqual)
        src/main/dobius-cli/install-clis.ts    (writes dobius-* scripts to ~/.local/bin, versioned marker)
ROUTES  send/reply → dobius-runtime.sendTerminal ;  task-done → asana service markLocalDone (which PUSHES asana:tasksUpdated) ;
        spawn → dobius claude-agent-teams-service
UI      none direct. dobius-task-done ticks the Tasks panel THROUGH the existing asana:tasksUpdated push. (Same reactive channel — no new UI wiring.)
```

### A3 + A4 + B8 — Conductor + Auto Mode + status item (Phase 3) — **live**
```
ENGINE  src/main/conductor/conductor-service.ts (headless claude via dobius hidden-PTY src/main/rate-limits/claude-pty.ts; auto-respawn; GATED off by default)
        src/main/asana/auto-mode.ts             (interval poll → inject [auto-<gid>] into Conductor; cap 3/tick; persist seen[])
PUSH    webContents.send('autoMode:updated', { enabled, lastPollAt, pendingCount })
IPC     src/main/ipc/asana.ts (extend) autoMode:get | setEnabled
PRELOAD window.api.autoMode.{get,setEnabled,onUpdated(cb)}
STATE   slices/asana.ts (extend) autoMode:{enabled,lastPollAt}
UI (NEW) StatusBar item (surface #2) — on/off dot + last-poll time; click opens Automation settings section.
```

### B2–B6 — dashboard panels (Phase 4)
- **Costs** → right-sidebar tab; **read-only** reuse of dobius's existing usage/stats store (no new engine). Just a new panel + tab id.
- **Prompts** → right-sidebar tab; list from a small `prompts.json` config store; inject via `dobius-runtime.sendTerminal`.
- **Build Monitor** → right-sidebar tab; engine = file-watch on `claude-progress.json` + `HANDOFF.md` (reuse dobius's chokidar/file-watch), PUSH `buildMonitor:updated`, same hook→slice→panel path as Asana.

---

## 3. Reactive push channels (the "accurate & reactive" contract)

| Channel (main → renderer) | Payload | Consumer |
|---|---|---|
| `asana:tasksUpdated` | `{build[], review[]}` | `useAsanaTasks` → Tasks panel |
| `autoMode:updated` | `{enabled, lastPollAt, pendingCount}` | status-bar item |
| `buildMonitor:updated` | `{progress, handoff}` | Build Monitor panel |
| (existing) `settings:changed`, `repos:changed` | — | reference implementations to copy |

Every push guarded by `if (mainWindow && !mainWindow.webContents.isDestroyed())`.

---

## 4. UI-protection confirmation (design stays 100% intact)

All new UI is **additive at registry level** — existing components are not restyled or restructured:

- **Right-sidebar tabs:** append a new id to the `ActiveRightSidebarTab` union, append one item to the items array, append one branch to the render switch. Existing tabs (`explorer`, `workspaces`, `pr-checks`) untouched.
- **Status bar:** append one segment; existing segments untouched.
- **Settings:** append one section + one nav-metadata entry; existing panes untouched.
- **No changes** to layout, theme tokens, `main.css`, the D+ logo/wordmark, or the shipped iMessage settings.
- New panels are built **from dobius's own primitives** (`components/ui/*`) so they inherit the exact look — no new color/spacing/radius values (per `AGENTS.md` design rule).

Net: the wiring is invisible to the user; only behavior appears. The current installed app remains the visual baseline.

---

## 5. Wiring risks / mismatches flagged

1. **Secret leakage** — the Asana PAT must live only in the `safeStorage` `.enc` file. It must **never** be placed in `asana-config.json`, a store slice, a push payload, or any renderer-visible value. Renderer only ever sees a `hasToken` boolean. (Copy `src/main/speech/openai-api-key-store.ts`.)
2. **Accidental Asana writes** — `completeTask` (PUT completed:true) is the single write and is a hard house-rule risk. It must be reachable *only* from an explicit user action; the poller and `markLocalDone` must not call it. Review gate must verify no code path auto-invokes it.
3. **Destroyed-webContents push** — every `webContents.send` must guard `!isDestroyed()`, else a closed window throws. Reference: how dobius guards `updater:status` (`src/main/updater.ts:239`, `mainWindowRef?`).
4. **Poll vs push mismatch** — if a feature ships with a renderer `setInterval` instead of the push channel, the UI can show stale state. Every live feature MUST use its push channel. Flagged for review.
5. **Headless process surprise** — the Conductor spawns a real `claude` process. It must be **off by default**, gated by the Auto Mode config toggle, excluded from client repos (`axiom-connect`, `elysium-connect`), and cleaned up on `will-quit` (reuse dobius `hidden-pty-cleanup.ts`).
6. **Engine purity** — keep `*-service.ts` free of `ipcMain`/`BrowserWindow` imports (inject the dispatcher, mirroring how `bridge-service.ts` receives `{resolveActiveTerminal, sendTerminal}`). Keeps services testable and matches dobius layering.
7. **Surface choice** — Tasks/Build Monitor are right-sidebar **tabs** (lists), not main-area tab-types; don't wire them into `activeTabTypeByWorktree` (that's for terminal/browser content). Costs/Prompts also right-sidebar for consistency.

---

## 6. Build + verify per phase (unchanged from the approved plan)
`pnpm run typecheck` → `pnpm run build:electron-vite` → `node <scratchpad>/repack.mjs` → assemble + ad-hoc sign + install to `/Applications` (the proven repack path; **not** electron-builder — its alpha packager is broken). Then exercise the phase's feature path. Each self-owned store ships a tiny `--main` assert self-check (sanitize/round-trip) per dobius's `*.test.ts` convention.

**Review gates (Claude, after codex writes each phase):** `review-audit` on the diff (bugs, secret handling, the completeTask guard, push-guards) + `ship-test` against the running app. Nothing merges to the phase branch until both pass.
