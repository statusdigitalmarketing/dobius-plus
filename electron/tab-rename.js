// `dobius-tab "<summary>"`: lets the agent in a tab label its own tab.
//
// An agent's Bash tool runs in a child process whose output is captured, not
// written to the tty, so it cannot set the terminal title itself. Instead each
// tab's shell carries DOBIUS_TAB_ID, and this command posts the label to the
// voice bridge (127.0.0.1, Bearer token from a 0600 file, same checks as every
// other bridge route), which forwards it to the window showing that tab.
//
// Pure module (no electron import) so the script and the body check are unit
// tested against a real HTTP server: electron/__tests__/tab-rename.test.mjs.

import { shQuote } from '../shared/sh-quote.js';

export const MAX_RAW_LABEL = 500; // the renderer trims to 40; this only bounds the IPC payload

/** Validate a /tabRename body. Returns { tabId, label } or { error }. */
export function validateTabRename(body, tabIdRe) {
  const { tabId, label } = body || {};
  if (typeof tabId !== 'string' || !tabIdRe.test(tabId)) return { error: 'tabId missing or malformed' };
  if (typeof label !== 'string' || !label.trim()) return { error: 'label must be a non-empty string' };
  // Something the renderer will keep: a glyph-only label would be dropped
  // there yet still replace the label main replays on a tear-off claim.
  if (!/[\p{L}\p{N}]/u.test(label)) return { error: 'label needs at least one letter or digit' };
  if (label.length > MAX_RAW_LABEL) return { error: `label longer than ${MAX_RAW_LABEL} characters` };
  return { tabId, label };
}


/** The bash script installed as <userData>/bin/dobius-tab. */
export function buildTabCliScript({ port, tokenFile }) {
  return `#!/bin/bash
# dobius-tab: label the Dobius+ tab this command runs in.
# Usage: dobius-tab "<3-6 word summary of the current task>"
# The label shows in the tab bar (40 chars max) unless the user has renamed
# the tab by hand, which always wins.
set -e
if [ -z "$DOBIUS_TAB_ID" ]; then
  echo "dobius-tab: not running inside a Dobius+ tab (DOBIUS_TAB_ID is unset)" >&2
  exit 1
fi
if [ $# -lt 1 ] || [ -z "$*" ]; then
  echo 'usage: dobius-tab "<3-6 word summary>"' >&2
  exit 1
fi
command -v python3 >/dev/null 2>&1 || { echo "dobius-tab: python3 not found on PATH" >&2; exit 3; }
command -v curl >/dev/null 2>&1 || { echo "dobius-tab: curl not found on PATH" >&2; exit 3; }
TOKEN=$(cat ${shQuote(tokenFile)} 2>/dev/null) || { echo "dobius-tab: bridge token unreadable (is Dobius+ running?)" >&2; exit 2; }
BODY=$(python3 -c 'import json,sys; print(json.dumps({"tabId": sys.argv[1], "label": sys.argv[2]}))' "$DOBIUS_TAB_ID" "$*")
curl -fsS -X POST "http://127.0.0.1:${port}/tabRename" \\
  -H "Host: 127.0.0.1:${port}" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  --data-binary "$BODY" >/dev/null
echo "dobius-tab: tab labeled"
`;
}
