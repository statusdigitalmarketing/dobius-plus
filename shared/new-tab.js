// Pure logic for new tabs: which tool a new tab starts, the shell argv that
// starts it, and the New Tab picker's project list. Shared by main
// (terminal:create, terminal-manager) and the renderer. No React
// or Electron here so it is unit-tested under plain node
// (electron/__tests__/new-tab.test.mjs).

import { shQuote } from './sh-quote.js';

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

// A resume types `claude --resume <id>` at a shell prompt, so it must not go
// into a tab where a program is running (typed into Claude, it is submitted as
// a prompt) or about to run (a New Tab whose shell is still starting its tool).
// proc: terminal:getProcess's answer, the name of a non-shell child or null.
// ponytail: the start is judged by a 15s window from the tab's creation, not
// tracked; a slower start than that is missed, and resuming in a tab whose tool
// already exited opens one tab more than needed.
export const NEW_TAB_START_MS = 15_000;
export function resumeNeedsNewTab(proc, tab, now = Date.now()) {
  if (proc) return true;
  return !!tab?.startsTool && now - (tab.createdAt || 0) < NEW_TAB_START_MS;
}

// The PTY's own process as ps names it: null when it is still a shell (a login
// shell reads -zsh, and the user's own $SHELL counts), otherwise the program
// that replaced it with `exec`.
export function ptyProgramName(comm, shellPath = '') {
  const name = String(comm || '').trim().replace(/^-/, '').split('/').pop();
  const own = String(shellPath).split('/').pop();
  return !name || name === own || ['zsh', 'bash', 'sh'].includes(name) ? null : name;
}

// How to spawn a new PTY's login shell: { args, env }. With a startCommand
// (only a bare tool name from launchCommandFor) the shell runs it after its rc
// files, so PATH and the account env are the user's own, then replaces itself
// with a plain login shell when the tool exits, leaving the tab usable.
// - The prompt hooks run first (zsh precmd, bash PROMPT_COMMAND): direnv and
//   similar tools load a project's environment there, and -c shows no prompt.
//   The tool name is read before them into $1 and launched only through a
//   fixed allowlist (no eval), so neither a hook nor a project .env can turn
//   it into code.
// - The tool name travels in an env var. The wrapper's argv does contain the
//   allowlist words, so loose argv scans (data-service getActiveProcesses)
//   skip it by the DOBIUS_NEW_TAB_TOOL marker in that same argv.
// - A tool suspended with Ctrl+Z is resumed (fg) rather than left stopped
//   behind the replacement shell, where nothing could ever resume it.
//   The tool runs in the foreground (a direct child, as process checks
//   expect) and only a suspended job that did not exist before it started is
//   resumed, by number, never %+ (which can name an rc file's background job).
//   zsh reads its job table from $jobstates (no subshell); bash reads
//   `jobs -sl` and repeats the step unrolled, because bash abandons a loop
//   whose foreground job stops.
//   ponytail: 25 suspends per tool run; past that the tool is ended (bash)
//   or left stopped (zsh) when the wrapper becomes a login shell.
// - nounset / errexit from the user's rc are switched off for this script
//   only (the replacement shell reads the rc again), so an unset hook array
//   or the tool's exit status cannot abort it before it becomes a shell.
// Only zsh and bash are driven this way; any other shell opens plain.
export const START_TOOL_ENV = 'DOBIUS_NEW_TAB_TOOL';
export function loginShellSpawn(shell, startCommand) {
  const plain = { args: ['-l'], env: {} };
  if (!NEW_TAB_TOOLS.some((x) => newTabCommand(x) && newTabCommand(x) === startCommand)) return plain;
  const name = String(shell).split('/').pop();
  // The tool name is read before the hooks (a hook or a project .env could set
  // the variable) into the positional parameter $1, which no variable
  // assignment (direnv's dotenv included) can reach. Nothing is ever eval'd:
  // the launch is a fixed allowlist dispatch, so whatever a hook assigns can
  // only select one of these commands or none. A literal command word keeps
  // the user's alias or function for it, as when typed.
  const take = `set -- "$${START_TOOL_ENV}"; unset ${START_TOOL_ENV};`;
  // An and-list, not case/if: zsh forks a suspended compound command off as
  // its own job, so a Ctrl+Z inside one ended the whole wrapper (and the tab).
  const launch = NEW_TAB_TOOLS.filter((x) => newTabCommand(x))
    .map((x) => `[[ $1 == ${x} ]] && ${newTabCommand(x)};`).join(' ');
  let run;
  if (name === 'zsh') {
    run = `setopt no_nounset no_err_exit 2>/dev/null; ${take} (( $+functions[precmd] )) && precmd; for f in $precmd_functions; do "$f"; done; `
      + `zmodload zsh/parameter 2>/dev/null; pre=(\${(k)jobstates}); ${launch} `
      + 'i=0; while (( i++ < 25 )); do s=(${(k)jobstates[(R)suspended*]}); s=(${s:|pre}); (( $#s )) || break; '
      + 'fg %$s[1] >/dev/null 2>&1; done;';
  } else if (name === 'bash') {
    // The hooks run inside a function, so a `set --` among them cannot reach $1.
    run = `set +eu; ${take} __dobius_hooks() { for c in "\${PROMPT_COMMAND[@]}"; do eval "$c"; done; }; __dobius_hooks; pre=" $(jobs -p | tr '\\n' ' ') "; ${launch} `
      // A stopped pipeline's continuation lines start with a pid, not [n].
      + ('j=$(jobs -sl 2>/dev/null | while read -r n p r; do [[ $n == \\[* ]] || continue; [[ $pre == *" $p "* ]] && continue; '
        + 'n=${n#[}; echo "${n%%]*}"; break; done); [ -n "$j" ] && fg %$j >/dev/null 2>&1; ').repeat(25).trim();
  } else {
    return plain;
  }
  const script = `trap : INT; ${run} exec ${shQuote(shell)} -l`;
  return { args: ['-l', '-i', '-c', script], env: { [START_TOOL_ENV]: startCommand } };
}

// True for a `pgrep -lf` / ps line that is a New Tab wrapper shell (it names
// the tools in its own argv but is the tab's shell, not a Claude process).
// Matches the wrapper's exact shape, not a mere mention of the marker, so a
// real `claude -p "...DOBIUS_NEW_TAB_TOOL..."` still counts.
export function isNewTabWrapperCommand(line) {
  // Anchored on argv0 (after an optional pgrep pid), so the same text inside
  // some other program's arguments never matches.
  return /^\s*(?:\d+\s+)?(?:\S*\/)?(?:zsh|bash) -l -i -c trap : INT; (?:setopt no_nounset no_err_exit 2>\/dev\/null; |set \+eu; )set -- "\$DOBIUS_NEW_TAB_TOOL"; /.test(String(line));
}
