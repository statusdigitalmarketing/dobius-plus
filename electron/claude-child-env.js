// Claude Code marks every command its Bash tool runs with these variables. A Dobius+ started from inside a Claude
// session (a dev run, or Claude restarting the app by running its binary) inherits them, and every tab after that
// starts Claude as a "child session": it shows "Transcript saving is off, inherited CLAUDE_CODE_CHILD_SESSION marker"
// and writes no transcript, so --resume and History cannot find the conversation. A tab is a new top-level session,
// never a child of whatever launched the app, so main drops them from its own environment at startup and every PTY,
// claude -p call and helper starts clean. Read from Claude Code 2.1.325 (setChildSession, setClaudecode, setEntrypoint,
// setSpawnedByAttendedSession). The person's own CLAUDE_CODE_SKIP_PROMPT_HISTORY and FORCE_SESSION_PERSISTENCE stay.
export const CLAUDE_CHILD_MARKERS = Object.freeze([
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ATTENDED',
]);

/** Removes the markers from `env` in place; returns the names that were there. */
export function dropClaudeChildMarkers(env = process.env) {
  const dropped = [];
  for (const name of CLAUDE_CHILD_MARKERS) {
    if (Object.prototype.hasOwnProperty.call(env, name) || env[name] !== undefined) { dropped.push(name); delete env[name]; }
  }
  return dropped;
}
