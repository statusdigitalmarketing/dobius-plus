// Pure logic for new tabs: which tool a new tab starts, the command that
// starts it, when it is safe to type it, and the New Tab picker's project
// list. Shared by main (electron/new-tab-launch.js) and the renderer. No React
// or Electron here so it is unit-tested under plain node
// (electron/__tests__/new-tab.test.mjs).

export const NEW_TAB_TOOLS = ['claude', 'codex', 'shell'];
export const DEFAULT_NEW_TAB_TOOL = 'claude';

// settings.newTabTool, defaulting to Claude for a missing or unknown value.
export function normalizeNewTabTool(value) {
  return NEW_TAB_TOOLS.includes(value) ? value : DEFAULT_NEW_TAB_TOOL;
}

// What to type into a new tab's shell, or null for a plain shell. The tab's
// PTY already starts in the project directory with the active Claude and
// Codex account env (terminal:create), so the bare command is enough.
export function newTabCommand(tool) {
  if (tool === 'claude') return 'claude';
  if (tool === 'codex') return 'codex';
  return null;
}

// A renderer's launch request for a new terminal: 'default' (the Settings
// choice, settingTool) or an explicit tool. Anything else starts nothing.
export function launchCommandFor(request, settingTool) {
  if (request === 'default') return newTabCommand(normalizeNewTabTool(settingTool));
  return NEW_TAB_TOOLS.includes(request) ? newTabCommand(request) : null;
}

function projectName(p) {
  return p.displayName || p.decodedPath.split('/').filter(Boolean).pop() || p.decodedPath;
}

// The picker's rows: the current project first (always, even if hidden or
// outside the scan folder), then every other project in the launcher's order,
// minus the ones hidden from New Tab unless showHidden. A query keeps rows
// whose name or path holds every token, the launcher's search rule.
export function buildPickerProjects({ currentPath = null, projects = [], hidden = [], query = '', showHidden = false } = {}) {
  const hiddenSet = new Set(Array.isArray(hidden) ? hidden : []);
  const seen = new Set();
  const rows = [];
  const add = (p, isCurrent) => {
    if (!p || typeof p.decodedPath !== 'string' || !p.decodedPath.startsWith('/')) return;
    if (seen.has(p.decodedPath)) return;
    seen.add(p.decodedPath);
    rows.push({ path: p.decodedPath, name: projectName(p), isCurrent, hidden: !isCurrent && hiddenSet.has(p.decodedPath) });
  };
  if (currentPath) {
    add(projects.find((p) => p?.decodedPath === currentPath) || { decodedPath: currentPath }, true);
  }
  for (const p of projects) add(p, false);

  const tokens = String(query || '').toLowerCase().split(/[\s\-_/.]+/).filter(Boolean);
  return rows.filter((r) => {
    if (r.hidden && !showHidden) return false;
    if (!tokens.length) return true;
    const hay = `${r.name.toLowerCase()} ${r.path.toLowerCase()}`;
    return tokens.every((t) => hay.includes(t));
  });
}

// Count of projects hidden from New Tab that still exist in the list, so the
// picker can offer "Show hidden" only when there is something to show.
export function countHiddenProjects(projects = [], hidden = [], currentPath = null) {
  const hiddenSet = new Set(Array.isArray(hidden) ? hidden : []);
  return projects.filter((p) => p?.decodedPath && p.decodedPath !== currentPath && hiddenSet.has(p.decodedPath)).length;
}

// Flip one path in the hidden list, returning a new array.
export function toggleHiddenProject(hidden, path) {
  const list = Array.isArray(hidden) ? hidden.filter((p) => typeof p === 'string') : [];
  return list.includes(path) ? list.filter((p) => p !== path) : [...list, path];
}

// Cmd+1..9 inside the picker: the row index it picks, or -1.
export function pickerShortcutIndex(e) {
  if (!e || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return -1;
  return e.key >= '1' && e.key <= '9' && e.key.length === 1 ? Number(e.key) - 1 : -1;
}

// When to type a new tab's command into its fresh shell. Typing while the
// shell is still sourcing its rc files (or while an rc helper is reading the
// terminal) would hand the command to the wrong reader, so it waits for the
// shell's output to go quiet for settleMs. A shell that prints nothing at all
// by fallbackMs gets it then; one still printing at giveUpMs gets nothing.
// canWrite() is asked at the moment of typing (main checks nothing else has
// typed into the tab and it is the same PTY), so the user's own line is never
// extended or submitted. Returns { onOutput, dispose }.
export function armLaunch(command, {
  write, canWrite = () => true, onDone = () => {},
  settleMs = 300, fallbackMs = 4000, giveUpMs = 15000,
  setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  let done = false;
  let sawOutput = false;
  let settle = null;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimer(settle); clearTimer(fallback); clearTimer(giveUp);
    onDone();
  };
  const fire = () => {
    if (done) return;
    const ok = canWrite();
    finish();
    if (ok) write(`${command}\r`);
  };
  const fallback = setTimer(() => { if (!sawOutput) fire(); }, fallbackMs);
  const giveUp = setTimer(finish, giveUpMs);
  if (!command) finish();
  return {
    onOutput() {
      if (done) return;
      sawOutput = true;
      clearTimer(settle);
      settle = setTimer(fire, settleMs);
    },
    dispose: finish,
  };
}
