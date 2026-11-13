// "Run this yourself": a turn that ends by handing the person a command to
// run with Claude Code's `! ` prefix (the way a classifier-blocked action
// comes back) is waiting on them, so the tab goes red, not green.
//
// The rule: some line of the last reply starts with `! ` (optionally inside
// one backtick) followed by a command. A `!` mentioned mid-sentence or an
// exclamation does not count. Measured 2026-11-01 on Claude Code 2.1.316: the
// Stop hook's input carries last_assistant_message, e.g.
//   "Run this yourself:\n! echo dobius-bang-test"
// Codex's Stop hook carries the same field.
//
// Two forms of ONE rule, held together by electron/__tests__/handoff.test.mjs:
//   isHandoff(text)   the decoded message (Codex, routed in main)
//   HANDOFF_SHELL     a shell test the Claude Stop hook runs on its stdin:
//                     macOS's own plutil decodes last_assistant_message from
//                     the JSON (no python, no jq) and grep checks each line,
//                     so both forms read the same text. Matching the raw JSON
//                     instead took a literal backslash-n for a line break.
// A line may open with a list bullet ("- ", "* ", "1. ") before the command.

export const HANDOFF_RE = /(^|\n)[ ]*(?:[-*] |\d+\. )?`?! \S/;

// What a command card could hide, or a shell could read differently from what is shown: control and format
// characters, invisible (default-ignorable) ones, unassigned and private-use code points. A handed-back command
// holding one is never offered to run or copy (Tasks > Commands and the phone chat's command boxes).
export const HIDDEN_CMD_RE = /[\x00-\x1f\x7f-\x9f\u2028\u2029\p{Cf}\p{Default_Ignorable_Code_Point}\p{Cn}\p{Co}]/u;

export function isHandoff(text) {
  return typeof text === 'string' && HANDOFF_RE.test(text);
}

export const HANDOFF_LINE_GREP = '^[ ]*([-*] |[0-9]+\\. )?`?! [^[:space:]]';
// Not while Claude still has background work running (a Codex review it
// started, say): it comes back on its own when that ends (measured: a new
// turn, then a Stop with background_tasks []), and THAT reply decides. A
// running task is listed as {"status":"running"} in background_tasks; the
// message's own quotes are escaped in the JSON, so its text cannot match.
export const BACKGROUND_RUNNING_GREP = '"status"[[:space:]]*:[[:space:]]*"(running|pending)"';
// The Stop input again ($P, read by HANDOFF_SHELL just before): background
// work still running. The turn ended but Claude is waiting on that work (a
// Codex review, a build), so the tab stays working, tagged background, and
// the phone says so instead of "done" (Sam). The next turn decides again.
export const BACKGROUND_SHELL = `printf '%s' "$P" | /usr/bin/grep -qE '${BACKGROUND_RUNNING_GREP}'`;
export const HANDOFF_SHELL = `P=$(cat); printf '%s' "$P" | /usr/bin/plutil -extract last_assistant_message raw -o - - 2>/dev/null | /usr/bin/grep -qE '${HANDOFF_LINE_GREP}' && ! printf '%s' "$P" | /usr/bin/grep -qE '${BACKGROUND_RUNNING_GREP}'`;

/** The same decision on a decoded Stop input (tests; Codex has no background tasks). */
export function isHandoffStop(input) {
  const running = Array.isArray(input?.background_tasks)
    && input.background_tasks.some((t) => t && (t.status === 'running' || t.status === 'pending'));
  return !running && isHandoff(input?.last_assistant_message);
}

/**
 * The Claude Stop hook's command: a handed-back `! command` is red
 * (needs;handoff), a turn that ended with background work still running stays
 * working (working;background), anything else is done. `statusCmd(state)`
 * prints the marker for a state (main.js addDobiusHooks).
 */
export function stopHookCommand(statusCmd) {
  return `if ${HANDOFF_SHELL}; then ${statusCmd('needs;handoff')}; elif ${BACKGROUND_SHELL}; then ${statusCmd('working;background')}; else ${statusCmd('done')}; fi`;
}

// The placeholder rule lives in shared/placeholder.js, compiled at first use so an old iPhone can still load the
// phone app (it cannot parse a lookbehind literal).
export { commandPlaceholder } from './placeholder.js';
