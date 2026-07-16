// Pure argv parsing for Claude CLI process detection.
//
// Split out of terminal-manager.js (which imports node-pty, a native module,
// and so cannot be loaded in plain Node) purely so this can be unit tested.
// It has bitten twice in review: too loose matched unrelated processes (r3),
// too tight missed shimmed installs (r9). See electron/__tests__/.

/**
 * Is this command line ACTUALLY the claude CLI, as opposed to some unrelated
 * process that merely mentions the word?
 *
 * The old check was /\bclaude\b/ against the whole line, so `vim
 * claude-notes.md` or `tail -f claude.log` in a tab counted as a live Claude.
 * At quit that made the reconcile see claudeAlive and skip clearing a stopped
 * session's freshness stamp, so auto-resume would resurrect it.
 * Codex v1.0.39 r3 P2.
 *
 * Accepts `claude`, an absolute path ending in `/claude`, and the versioned
 * binary the CLI re-execs as (~/.local/share/claude/versions/<v>), which is how
 * the native install appears in ps on this machine.
 *
 * ALSO accepts the interpreter/shim form. An npm install
 * (`npm i -g @anthropic-ai/claude-code`) puts a `#!/usr/bin/env node` script on
 * PATH, so exec'ing it yields a process whose ps line reads
 * `node /opt/homebrew/bin/claude --resume <id>`: argv[0] is the interpreter and
 * the real entrypoint is argv[1]. Judging argv[0] alone called those idle, so
 * the reconcile would clear lastRunningAt for sessions that were genuinely
 * running and the tab would lose its name and its auto-resume. This machine
 * runs the native binary and cannot hit it, but Brett (whose missing tab names
 * are the reason v1.0.39 exists) may well be on the npm install.
 * Codex v1.0.39 r9 P2.
 *
 * The r3 false-positive guard still holds: only a token that looks like a PATH
 * to a claude entrypoint counts, so `vim claude-notes.md` and `node
 * claude-notes.js` stay excluded (their argv[0] is not an interpreter, and the
 * bare filename has no directory separator).
 */
const SHIM_INTERPRETERS = new Set(['node', 'bun', 'deno', 'env', 'npx']);

/** Does this single argv token name a claude entrypoint? */
export function isClaudeEntrypoint(tok) {
  if (!tok) return false;
  const base = tok.split('/').pop();
  if (base === 'claude') return true;
  if (/[/\\]claude[/\\]versions[/\\][^/\\]+$/.test(tok)) return true;
  // node .../@anthropic-ai/claude-code/cli.js, .../claude/versions/<v>/cli.js
  return /[/\\]\.?claude(-code)?[/\\].*\.(js|mjs|cjs)$/.test(tok);
}

export function isClaudeCommand(command) {
  if (!command) return false;
  const parts = command.trim().split(/\s+/);
  const argv0 = parts[0] || '';
  if (!argv0) return false;
  if (isClaudeEntrypoint(argv0)) return true;
  // Shim form: only look past argv[0] when argv[0] is actually an interpreter,
  // and only at tokens carrying a path separator. Both conditions are what keep
  // a mere filename argument from matching.
  if (!SHIM_INTERPRETERS.has(argv0.split('/').pop())) return false;
  for (const tok of parts.slice(1)) {
    if (tok.startsWith('-')) continue;
    if (!tok.includes('/')) continue;
    if (isClaudeEntrypoint(tok)) return true;
  }
  return false;
}

