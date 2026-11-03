// dobius-team: the orchestrator's command for the team communicator (docs/team-communicator.md, "Sending and
// replying from Claude"). Installed per instance in <userData>/bin, which every tab has on PATH.
import { shQuote } from '../shared/sh-quote.js';

export function buildTeamCliScript({ port, tokenFile }) {
  return `#!/bin/bash
# dobius-team: talk to teammates' Dobius orchestrators (Settings > Team).
#   dobius-team peers                      linked teammates
#   dobius-team inbox                      recent messages in and out
#   dobius-team send <name|fingerprint>    message text on stdin
#   dobius-team reply <message id>         answer a received message (the id on its card), text on stdin
# Text is read from stdin only, so it never appears in the process list:
#   dobius-team reply 0123abcd <<'EOF'
#   the catalog is live, link in the Axiom board
#   EOF
set -e
CMD="$1"; ARG="$2"
case "$CMD" in
  peers|inbox) ;;
  send|reply) [ -n "$ARG" ] || { echo "usage: dobius-team $CMD <$( [ "$CMD" = send ] && echo 'name|fingerprint' || echo 'short id')> (text on stdin)" >&2; exit 1; } ;;
  *) echo 'usage: dobius-team peers | inbox | send <name|fingerprint> | reply <short id>   (text on stdin)' >&2; exit 1 ;;
esac
command -v python3 >/dev/null 2>&1 || { echo "dobius-team: python3 not found on PATH" >&2; exit 3; }
command -v curl >/dev/null 2>&1 || { echo "dobius-team: curl not found on PATH" >&2; exit 3; }
TOKEN=$(cat ${shQuote(tokenFile)} 2>/dev/null) || { echo "dobius-team: bridge token unreadable (is Dobius+ running?)" >&2; exit 2; }
TEXT=""
if [ "$CMD" = send ] || [ "$CMD" = reply ]; then
  if [ -t 0 ]; then echo "dobius-team: give the message on stdin (a heredoc), not as an argument" >&2; exit 1; fi
  TEXT=$(cat)
  [ -n "$TEXT" ] || { echo "dobius-team: the message is empty" >&2; exit 1; }
fi
BODY=$(PYTHONIOENCODING=utf-8 T_CMD="$CMD" T_ARG="$ARG" T_TEXT="$TEXT" T_TAB="\${DOBIUS_TAB_ID:-}" python3 -c 'import json,os; print(json.dumps({"cmd": os.environ["T_CMD"], "arg": os.environ["T_ARG"], "text": os.environ["T_TEXT"], "tabId": os.environ["T_TAB"]}, ensure_ascii=False))')
HDR=$(mktemp) || exit 3
trap 'rm -f "$HDR"' EXIT
chmod 600 "$HDR"
printf 'Authorization: Bearer %s\\n' "$TOKEN" > "$HDR"
RESPONSE=$(printf '%s' "$BODY" | curl -sS --noproxy '*' --max-time 30 -X POST "http://127.0.0.1:${port}/team" \\
  -H "Host: 127.0.0.1:${port}" \\
  -H @"$HDR" \\
  -H "Content-Type: application/json" \\
  --data-binary @-)
printf '%s' "$RESPONSE" | PYTHONIOENCODING=utf-8 python3 -c '
import json, sys
r = json.load(sys.stdin)
if not r.get("ok"):
    print("dobius-team: " + str(r.get("error", "failed")), file=sys.stderr); sys.exit(1)
for line in r.get("lines", []): print(line)
'
`;
}
