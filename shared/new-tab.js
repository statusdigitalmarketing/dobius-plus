// Pure logic for new tabs: which tool a new tab starts, the shell argv that
// starts it, and the New Tab picker's project list. Shared by main
// (terminal:create, terminal-manager) and the renderer. No React
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

// How to spawn a new PTY's login shell: { args, env }. With a startCommand
// (only a bare tool name from launchCommandFor) the shell runs it after its rc
// files, so PATH and the account env are the user's own, then replaces itself
// with a plain login shell when the tool exits, leaving the tab usable.
// - The prompt hooks run first (zsh precmd, bash PROMPT_COMMAND): direnv and
//   similar tools load a project's environment there, and -c shows no prompt.
// - The tool name travels in an env var, so no process argv says "claude"
//   except the tool's own (process scans match on argv).
// - The INT trap keeps a Ctrl+C that kills the tool before it owns the
//   terminal from also ending the wrapper and the tab. A trap with a handler
//   is not inherited by the tool.
// Only zsh and bash are driven this way; any other shell opens plain.
export const START_TOOL_ENV = 'DOBIUS_NEW_TAB_TOOL';
export function loginShellSpawn(shell, startCommand) {
  const plain = { args: ['-l'], env: {} };
  if (typeof startCommand !== 'string' || !/^[a-z]+$/.test(startCommand)) return plain;
  const name = String(shell).split('/').pop();
  let hooks;
  if (name === 'zsh') hooks = '(( $+functions[precmd] )) && precmd; for f in $precmd_functions; do "$f"; done;';
  else if (name === 'bash') hooks = 'for c in "${PROMPT_COMMAND[@]}"; do eval "$c"; done;';
  else return plain;
  const quoted = `'${String(shell).replace(/'/g, "'\\''")}'`;
  const script = `trap : INT; t=$${START_TOOL_ENV}; unset ${START_TOOL_ENV}; ${hooks} "$t"; exec ${quoted} -l`;
  return { args: ['-l', '-i', '-c', script], env: { [START_TOOL_ENV]: startCommand } };
}
