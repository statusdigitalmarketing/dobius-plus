// Pure logic for new tabs: which tool a new tab starts, the shell argv that
// starts it, and the New Tab picker's project list. Shared by main
// (terminal:create, terminal-manager) and the renderer. No React
// or Electron here so it is unit-tested under plain node
// (electron/__tests__/new-tab.test.mjs).

import { shQuote } from './sh-quote.js';
import { isAbsPath, baseName, isWindows } from './platform.js';

export const NEW_TAB_TOOLS = ['claude', 'codex', 'shell'];
export const DEFAULT_NEW_TAB_TOOL = 'claude';

// settings.newTabTool, defaulting to Claude for a missing or unknown value.
export function normalizeNewTabTool(value) {
  return NEW_TAB_TOOLS.includes(value) ? value : DEFAULT_NEW_TAB_TOOL;
}

// What to type into a new tab's shell, or null for a plain shell. The tab's
// PTY already starts in the project directory with the active Claude and
// Codex account env (terminal:create), so the bare command is enough.
export { PS_GWS_FUNCTION };

export function newTabCommand(tool) {
  if (tool === 'claude') return 'claude';
  if (tool === 'codex') return 'codex';
  return null;
}

// The defaults a new tab's Claude starts with (Settings, also from the phone). '' means Claude's own default: no flag.
// A fixed allowlist, checked again where the shell is spawned (loginShellSpawn): these are the only words that can ever
// follow `claude` from here. bypassPermissions and dontAsk are deliberately not offered.
export const NEW_TAB_MODELS = ['', 'opus', 'sonnet', 'fable', 'haiku'];
export const NEW_TAB_PERMISSION_MODES = ['', 'acceptEdits', 'plan', 'auto'];
export const normalizeNewTabModel = (v) => (NEW_TAB_MODELS.includes(v) ? v : '');
export const normalizeNewTabPermissionMode = (v) => (NEW_TAB_PERMISSION_MODES.includes(v) ? v : '');
// `[[ $2 == opus || $2 == sonnet ... ]]` for the non-empty words of an allowlist (they are plain identifiers, so no quoting).
const shellAllow = (v, list) => `[[ ${list.filter(Boolean).map((w) => `${v} == ${w}`).join(' || ')} ]]`;
// Settings to the options loginShellSpawn takes for a new tab running claude, or null when both are Claude's default.
export function claudeLaunchOptions(settings) {
  const model = normalizeNewTabModel(settings?.newTabModel);
  const permissionMode = normalizeNewTabPermissionMode(settings?.newTabPermissionMode);
  return model || permissionMode ? { model, permissionMode } : null;
}

// A renderer's launch request for a new terminal: 'default' (the Settings
// choice, settingTool) or an explicit tool. Anything else starts nothing.
export function launchCommandFor(request, settingTool) {
  if (request === 'default') return newTabCommand(normalizeNewTabTool(settingTool));
  return NEW_TAB_TOOLS.includes(request) ? newTabCommand(request) : null;
}

function projectName(p) {
  return p.displayName || baseName(p.decodedPath) || p.decodedPath;
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
    if (!p || typeof p.decodedPath !== 'string' || !isAbsPath(p.decodedPath)) return;
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
  // Cmd on the Mac, Ctrl on Windows.
  const mod = isWindows() ? (e?.ctrlKey && !e?.metaKey) : (e?.metaKey && !e?.ctrlKey);
  if (!e || !mod || e.altKey || e.shiftKey) return -1;
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
// resume ({ sessionId, cwd }, an account move): the same wrapper runs
// `cd <cwd> && claude --resume <id>`, or plain `claude` with sessionId null,
// nothing typed. Both values travel in env and reach the fixed command as $2 and
// $3, never eval'd. carryOn (an automatic move after a usage limit) adds the
// fixed CARRY_ON_PROMPT as Claude's first prompt, on its command line.
export const START_TOOL_ENV = 'DOBIUS_NEW_TAB_TOOL';
// Several words, so a future `claude` subcommand can never take it for its name.
// No quote characters: it sits inside single quotes in the shell script.
export const CARRY_ON_PROMPT = 'Your previous Claude account hit its usage limit, so Dobius moved this conversation to another account. Continue where you left off.';
// Any of these in the new shell decides Claude's login instead of its folder
// (main.js AUTH_OVERRIDE_NAMES reads the same list), so the carry-on waits.
export const CLAUDE_AUTH_ENV = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_BASE_URL'];
// Read from the exported environment, so only what Claude would inherit
// counts (`export -n` keeps a shell value that never reaches it). The token
// test is an exit status, never an expanded value, so `set -x` in a startup
// file cannot print a key into the tab. grep without -q reads all of env's
// output, so pipefail cannot see a SIGPIPE as "no token".
const CARRY_ON_TOKEN = `/usr/bin/env | /usr/bin/grep -E '^(${CLAUDE_AUTH_ENV.join('|')})=.' >/dev/null`;
const CARRY_ON_DIR = '$(/usr/bin/printenv CLAUDE_CONFIG_DIR)';
const resumeTool = (resume) => (resume.sessionId === null ? 'fresh' : resume.carryOn === true ? 'resume-on' : 'resume');

// Windows PowerShell (powershell.exe) or PowerShell 7 (pwsh.exe).
export function isPowerShell(shell) {
  return /^(powershell|pwsh)\.exe$/i.test(String(shell).split(/[\\/]/).pop());
}

// PowerShell's version of the wrapper below: the profile runs first (PATH and
// the user's setup, as with -l), then the tool, and -NoExit leaves the same
// interactive shell when it exits. Same rules as the zsh/bash wrapper: the
// values travel in env, are read once into locals and removed, and dispatch is
// a fixed allowlist with nothing evaluated. The tool is resolved as an
// Application (claude.exe, or npm's claude.cmd) so the default execution
// policy, which blocks npm's .ps1 shims, never stops it. Passed encoded, so no
// quoting survives into the command line to be misread.
// `gws` in a PowerShell tab is Dobius's per-account shim run under Dobius's Electron, defined in EVERY PowerShell tab
// (plain ones too). A function, so no .ps1 meets the execution policy. It builds the command line itself (the C runtime
// rules: quotes as \", backslashes doubled before a quote) and starts the process through .NET (Codex rounds 1 and 2):
// PowerShell's own passing strips the quotes inside --params '{"userId":"me"}' through a .cmd and in 5.1 everywhere,
// and it would not wait for Electron (a GUI program) or report its exit code. It runs in the tab's CURRENT folder
// (PowerShell's cd does not move the process). stdout comes back down the pipeline, so `gws ... | ConvertFrom-Json`
// works, and piped input (`'text' | gws ...`) is handed to gws on stdin as UTF-8 with no byte order mark (5.1 takes
// the pipe's encoding from the console, so the console's input encoding is switched for the moment of the start). ELECTRON_RUN_AS_NODE is set for
// the child only, never the session, and a gws left running when the pipeline stops early (Select-Object -First 1)
// is ended with everything it started (taskkill /T: the shim runs the real gws as its own child, Codex round 5).
// A profile alias named gws is removed (aliases win over functions, so it would run gws as the default account), and
// an array argument passes its elements as separate arguments, as PowerShell does for a native command (Codex round 6).
// `gws auth login` and `gws auth setup` draw on the console themselves (the scope picker is cursor frames, not lines),
// so their output is not captured (every other command is, auth export and auth status included, Codex round 8); a Constant alias cannot be removed, so the tab says so at start instead of running as the default account
// unnoticed (Codex round 7). Output is read and the exit awaited in 200 ms waits, never one blocking call, so Ctrl+C
// stops the function and finally ends the gws tree (a blocked ReadLine cannot be interrupted, Codex round 9). Accepted: stderr goes to the console, not the
// error stream (2> cannot catch it), $? stays true on failure (check $LASTEXITCODE), and a huge piped input is written
// before any output is read.
const PS_GWS_FUNCTION = String.raw`if ($env:DOBIUS_GWS_SHIM_JS -and $env:DOBIUS_ELECTRON_EXE) { Remove-Item Alias:gws -Force -ErrorAction SilentlyContinue; if (Test-Path Alias:gws) { Write-Warning 'gws is a constant alias in your PowerShell profile, so it runs as your default Google account, not the one Dobius picks. Remove it from the profile to use Dobius accounts here.' }; function global:gws { $q = { param($s) if ($s -eq '') { return '""' }; if ($s -notmatch '[\s"]') { return $s }; $r = '"'; $n = 0; foreach ($c in $s.ToCharArray()) { if ($c -eq [char]92) { $n++ } elseif ($c -eq [char]34) { $r += ('\' * (2 * $n + 1)) + '"'; $n = 0 } else { $r += ('\' * $n) + $c; $n = 0 } }; return $r + ('\' * (2 * $n)) + '"' }; $fa = @($args | ForEach-Object { $_ }); $line = (@($env:DOBIUS_GWS_SHIM_JS) + $fa | ForEach-Object { & $q ([string]$_) }) -join ' '; $pipe = $MyInvocation.ExpectingInput; $cap = -not ($fa.Count -gt 1 -and [string]$fa[0] -eq 'auth' -and @('login', 'setup') -contains [string]$fa[1]); $p = $null; try { $i = New-Object System.Diagnostics.ProcessStartInfo; $i.FileName = $env:DOBIUS_ELECTRON_EXE; $i.Arguments = $line; $i.WorkingDirectory = (Get-Location -PSProvider FileSystem).ProviderPath; $i.UseShellExecute = $false; $i.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'; $i.EnvironmentVariables['DOBIUS_GWS_SHIM_SELF'] = $env:DOBIUS_GWS_SHIM_JS; $i.RedirectStandardOutput = $cap; $i.RedirectStandardInput = $pipe; if ($cap) { $i.StandardOutputEncoding = [System.Text.Encoding]::UTF8 }; $u = New-Object System.Text.UTF8Encoding $false; $ie = $null; if ($pipe) { if ($i.PSObject.Properties['StandardInputEncoding']) { $i.StandardInputEncoding = $u } else { try { $ie = [Console]::InputEncoding; [Console]::InputEncoding = $u } catch { $ie = $null } } }; try { $p = [System.Diagnostics.Process]::Start($i) } finally { if ($ie) { try { [Console]::InputEncoding = $ie } catch { } } }; if ($pipe) { foreach ($x in $input) { $b = $u.GetBytes(([string]$x) + [char]10); $p.StandardInput.BaseStream.Write($b, 0, $b.Length) }; $p.StandardInput.BaseStream.Flush(); $p.StandardInput.Close() }; if ($cap) { while ($true) { $t = $p.StandardOutput.ReadLineAsync(); while (-not $t.Wait(200)) { }; if ($null -eq $t.Result) { break }; $t.Result } }; while (-not $p.WaitForExit(200)) { }; $p.WaitForExit(); $global:LASTEXITCODE = $p.ExitCode } finally { if ($p -and -not $p.HasExited) { try { & "$env:SystemRoot\System32\taskkill.exe" /PID $p.Id /T /F 2>$null | Out-Null } catch { }; try { $p.Kill() } catch { } } } } }`;

function powerShellSpawn(resuming) {
  const v = START_TOOL_ENV;
  const script = [
    `$__dt = $env:${v}; $__di = $env:${v}_ID; $__dc = $env:${v}_CWD`,
    `Remove-Item Env:${v}, Env:${v}_ID, Env:${v}_CWD -ErrorAction SilentlyContinue`,
    'function __dobius_run($n) { $a = Get-Command $n -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; if ($a) { & $a.Source @args } else { & $n @args } }',
    PS_GWS_FUNCTION,
    resuming
      ? "if ($__dt -eq 'resume') { Set-Location -LiteralPath $__dc; __dobius_run claude --resume $__di } elseif ($__dt -eq 'fresh') { Set-Location -LiteralPath $__dc; __dobius_run claude }"
      : "if ($__dt -eq 'claude') { __dobius_run claude } elseif ($__dt -eq 'codex') { __dobius_run codex }",
    'Remove-Item Function:__dobius_run -ErrorAction SilentlyContinue; Remove-Variable __dt, __di, __dc -ErrorAction SilentlyContinue',
  ].join('; ');
  return ['-NoLogo', '-NoExit', '-EncodedCommand', utf16Base64(script)];
}

function utf16Base64(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    bytes.push(c & 0xff, c >> 8);
  }
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  return btoa(String.fromCharCode(...bytes));
}

// runScript (a path, Tasks > Commands): the same wrapper runs `/bin/bash -- <path>`, a file Dobius wrote in its own
// folder (electron/main.js handoffCommands), the path in env as $2, never eval'd. The command itself is never on a
// command line and never typed; the tab is a plain login shell afterwards. Only the shape below is accepted. Not on
// PowerShell (Run is zsh and bash only).
export const isRunScriptPath = (p) => typeof p === 'string' && /^\/[^\x00-\x1F\x7F]*\/dobius-run-[A-Za-z0-9_-]{16,}\.sh$/.test(p);
export function loginShellSpawn(shell, startCommand, resume = null, runScript = null, claudeOpts = null) {
  const powershell = isPowerShell(shell);
  const plain = { args: powershell ? ['-NoLogo', '-NoExit', '-EncodedCommand', utf16Base64(PS_GWS_FUNCTION)] : ['-l'], env: {} };
  const running = !powershell && isRunScriptPath(runScript);
  const resuming = !running && !!resume && (resume.sessionId === null || /^[a-zA-Z0-9][\w-]{0,99}$/.test(String(resume.sessionId))) && isAbsPath(String(resume.cwd)) && !/[\x00-\x1F\x7F]/.test(resume.cwd);
  if (!running && !resuming && !NEW_TAB_TOOLS.some((x) => newTabCommand(x) && newTabCommand(x) === startCommand)) return plain;
  if (powershell) {
    const env = resuming
      ? { [START_TOOL_ENV]: resume.sessionId === null ? 'fresh' : 'resume', [`${START_TOOL_ENV}_ID`]: resume.sessionId ?? '', [`${START_TOOL_ENV}_CWD`]: resume.cwd }
      : { [START_TOOL_ENV]: startCommand };
    return { args: powerShellSpawn(resuming), env };
  }
  const name = String(shell).split('/').pop();
  // A new tab's Claude defaults (model, permission mode): only for a plain `claude` start and only allowlisted words.
  // They travel in env like the tool name and are read into $2 and $3 with it, before any hook runs.
  const plainClaude = startCommand === 'claude' && !running && !resuming;
  const model = plainClaude ? normalizeNewTabModel(claudeOpts?.model) : '';
  const perm = plainClaude ? normalizeNewTabPermissionMode(claudeOpts?.permissionMode) : '';
  const withOpts = !!(model || perm);
  // The tool name is read before the hooks (a hook or a project .env could set
  // the variable) into the positional parameter $1, which no variable
  // assignment (direnv's dotenv included) can reach. Nothing is ever eval'd:
  // the launch is a fixed allowlist dispatch, so whatever a hook assigns can
  // only select one of these commands or none. A literal command word keeps
  // the user's alias or function for it, as when typed.
  const take = running
    ? `set -- "$${START_TOOL_ENV}" "$${START_TOOL_ENV}_SCRIPT"; unset ${START_TOOL_ENV} ${START_TOOL_ENV}_SCRIPT;`
    : resuming
      ? `set -- "$${START_TOOL_ENV}" "$${START_TOOL_ENV}_ID" "$${START_TOOL_ENV}_CWD" "$${START_TOOL_ENV}_CFG"; unset ${START_TOOL_ENV} ${START_TOOL_ENV}_ID ${START_TOOL_ENV}_CWD ${START_TOOL_ENV}_CFG;`
      : withOpts
        ? `set -- "$${START_TOOL_ENV}" "$${START_TOOL_ENV}_MODEL" "$${START_TOOL_ENV}_PERM"; unset ${START_TOOL_ENV} ${START_TOOL_ENV}_MODEL ${START_TOOL_ENV}_PERM;`
        : `set -- "$${START_TOOL_ENV}"; unset ${START_TOOL_ENV};`;
  // An and-list, not case/if: zsh forks a suspended compound command off as
  // its own job, so a Ctrl+Z inside one ended the whole wrapper (and the tab).
  // -p: bash imports no functions from the environment and reads no BASH_ENV/ENV, so a project .env (direnv) cannot
  // redefine `cd` or run a file before the script.
  const launch = running ? '[[ $1 == run ]] && /bin/bash -p -- "$2";'
    : resuming ? `[[ $1 == resume ]] && cd -- "$3" && claude --resume "$2"; __dobius_on=; [[ $1 == resume-on ]] && cd -- "$3" && __dobius_on=1; [[ $__dobius_on == 1 && "${CARRY_ON_DIR}" != "$4" ]] && __dobius_on=0; [[ $__dobius_on == 1 ]] && ${CARRY_ON_TOKEN} && __dobius_on=0; [[ $__dobius_on == 1 ]] && claude --resume "$2" '${CARRY_ON_PROMPT}'; [[ $__dobius_on == 0 ]] && claude --resume "$2"; [[ $1 == fresh ]] && cd -- "$3" && claude;`
      // The flags are fixed words plus the allowlisted values in $2 and $3, built as an array, never eval'd.
      // Checked again in the shell against the same fixed words: a login rc file runs before this script and could
      // have exported other values into the variables (Codex round 2).
      : withOpts ? `__dobius_a=(); ${shellAllow('$2', NEW_TAB_MODELS)} && __dobius_a+=(--model "$2"); ${shellAllow('$3', NEW_TAB_PERMISSION_MODES)} && __dobius_a+=(--permission-mode "$3"); [[ $1 == claude ]] && claude "\${__dobius_a[@]}";`
        : NEW_TAB_TOOLS.filter((x) => newTabCommand(x)).map((x) => `[[ $1 == ${x} ]] && ${newTabCommand(x)};`).join(' ');
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
  const env = running
    ? { [START_TOOL_ENV]: 'run', [`${START_TOOL_ENV}_SCRIPT`]: runScript }
    : resuming
      ? { [START_TOOL_ENV]: resumeTool(resume), [`${START_TOOL_ENV}_ID`]: resume.sessionId ?? '', [`${START_TOOL_ENV}_CWD`]: resume.cwd, [`${START_TOOL_ENV}_CFG`]: typeof resume.configDir === 'string' ? resume.configDir : '' }
      : withOpts
        ? { [START_TOOL_ENV]: startCommand, [`${START_TOOL_ENV}_MODEL`]: model, [`${START_TOOL_ENV}_PERM`]: perm }
        : { [START_TOOL_ENV]: startCommand };
  return { args: ['-l', '-i', '-c', script], env };
}

// True for a `pgrep -lf` / ps line that is a New Tab wrapper shell (it names
// the tools in its own argv but is the tab's shell, not a Claude process).
// Matches the wrapper's exact shape, not a mere mention of the marker, so a
// real `claude -p "...DOBIUS_NEW_TAB_TOOL..."` still counts.
export function isNewTabWrapperCommand(line) {
  // Anchored on argv0 (after an optional pgrep pid), so the same text inside
  // some other program's arguments never matches.
  return /^\s*(?:\d+\s+)?(?:\S*\/)?(?:zsh|bash) -l -i -c trap : INT; (?:setopt no_nounset no_err_exit 2>\/dev\/null; |set \+eu; )set -- "\$DOBIUS_NEW_TAB_TOOL"(?: "\$DOBIUS_NEW_TAB_TOOL_ID" "\$DOBIUS_NEW_TAB_TOOL_CWD"(?: "\$DOBIUS_NEW_TAB_TOOL_CFG")?| "\$DOBIUS_NEW_TAB_TOOL_SCRIPT"| "\$DOBIUS_NEW_TAB_TOOL_MODEL" "\$DOBIUS_NEW_TAB_TOOL_PERM")?; /.test(String(line));
}
