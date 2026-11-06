// POSIX single-quote a string for a /bin/sh command line: the one quoting the
// generated scripts and shell commands share (claude-usage's statusLine,
// dobius-tab, dobius-open, the New Tab wrapper). Inside single quotes nothing
// is special, so only a quote itself needs care: close, escaped quote, reopen.
export const shQuote = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;

// PowerShell single-quoted literal (Windows tabs). Inside one only a quote is
// special, and PowerShell counts the typographic single quotes (U+2018 to
// U+201B) as quotes too, so each of them is doubled, which is its escape.
export const psQuote = (v) => `'${String(v).replace(/['‘’‚‛]/g, (q) => q + q)}'`;

/**
 * Whether a value can be passed to a tool on Windows at all. npm installs
 * claude and codex as .cmd launchers, and cmd.exe re-reads their arguments,
 * so a path with one of these characters would run as a command whatever
 * PowerShell's quoting says (Codex). Callers refuse such a value.
 */
export const cmdSafe = (v) => !/[&|<>^%!"\r\n]/.test(String(v));

/** One argument typed into a tab's shell: PowerShell quoting on Windows. */
export function shellArg(v, platform) {
  return platform === 'win32' ? psQuote(v) : shQuote(v);
}

/**
 * A typed command that runs Claude or Codex (`tool` is a fixed literal, never
 * user text). Windows resolves it as an Application (claude.exe, or npm's
 * claude.cmd), as new tabs do, because the default execution policy blocks
 * npm's claude.ps1 shim that a bare `claude` would pick.
 */
export function toolCommand(tool, args, platform) {
  const rest = args ? ` ${args}` : '';
  if (platform === 'win32') return `& (Get-Command ${tool} -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source${rest}`;
  return `${tool}${rest}`;
}

/**
 * A command typed into a tab that changes to `dir` and, only if that worked,
 * runs `command` (a fixed command the caller built, never user text). macOS:
 * `cd '<dir>' && <command>`. Windows tabs run PowerShell, where `&&` does not
 * exist in 5.1 and sh quoting does not hold, so it is Set-Location -LiteralPath
 * with PowerShell quoting.
 */
export function cdThen(dir, command, platform) {
  if (platform === 'win32') return `Set-Location -LiteralPath ${psQuote(dir)}; if ($?) { ${command} }`;
  return `cd ${shQuote(dir)} && ${command}`;
}
