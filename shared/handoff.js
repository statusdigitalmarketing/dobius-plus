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

export function isHandoff(text) {
  return typeof text === 'string' && HANDOFF_RE.test(text);
}

export const HANDOFF_LINE_GREP = '^[ ]*([-*] |[0-9]+\\. )?`?! [^[:space:]]';
export const HANDOFF_SHELL = `/usr/bin/plutil -extract last_assistant_message raw -o - - 2>/dev/null | /usr/bin/grep -qE '${HANDOFF_LINE_GREP}'`;
