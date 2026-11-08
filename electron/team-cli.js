// dobius-team: the orchestrator's command for the team communicator (docs/team-communicator.md, "Sending and
// replying from Claude"). Installed per instance in <userData>/bin, which every tab has on PATH.
import { shQuote } from '../shared/sh-quote.js';

export function buildTeamCliScript({ port, tokenFile }) {
  return `#!/bin/bash
# dobius-team: talk to teammates' Dobius orchestrators (Settings > Team).
#   dobius-team peers                      linked teammates
#   dobius-team inbox                      recent messages in and out
#   dobius-team send <name|fingerprint>    message text on stdin
#   dobius-team reply <id>@<fingerprint>   answer a received message (exactly as its card prints it), text on stdin
#   dobius-team approve <request id>       orchestrator only: send a request another tab handed over
#   dobius-team show <id>@<fingerprint>    one message's timeline (delivered, read, working, replied, done...)
#   dobius-team release <id>@<fingerprint> orchestrator only: type a held message into this tab now
#   dobius-team done <id>@<fingerprint>    orchestrator only: tell the sender you finished it
#   dobius-team failed <id>@<fingerprint>  orchestrator only: tell the sender you could not (reason on stdin, optional)
# send and reply run in any tab other than the pinned orchestrator are handed to it to approve; nothing leaves the Mac
# until it does.
# Text is read from stdin only, so it never appears in the process list; the token reaches curl through a pipe
# (printf is a builtin, <( ) is not a file on disk), never argv or a temp file. curl -q (first) ignores ~/.curlrc, so
# no user config can turn on tracing that would log the token or the text:
#   dobius-team reply 0123abcd-4567-4890-8abc-0123456789ab@<fingerprint> <<'EOF'
#   the catalog is live, link in the Axiom board
#   EOF
set -e
CMD="$1"; ARG="$2"
case "$CMD" in
  peers|inbox) ;;
  send|reply) [ -n "$ARG" ] || { echo "usage: dobius-team $CMD <$( [ "$CMD" = send ] && echo 'name|fingerprint' || echo 'id@fingerprint')> (text on stdin)" >&2; exit 1; } ;;
  approve) [ -n "$ARG" ] || { echo "usage: dobius-team approve <request id>" >&2; exit 1; } ;;
  show|release|done|failed) [ -n "$ARG" ] || { echo "usage: dobius-team $CMD <id@fingerprint>" >&2; exit 1; } ;;
  *) echo 'usage: dobius-team peers | inbox | send <name|fingerprint> | reply <id@fingerprint>   (text on stdin) | approve <request id> | show|release|done|failed <id@fingerprint>' >&2; exit 1 ;;
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
# failed: an optional reason on stdin.
if [ "$CMD" = failed ] && [ ! -t 0 ]; then TEXT=$(cat); fi
BODY=$(PYTHONIOENCODING=utf-8 T_CMD="$CMD" T_ARG="$ARG" T_TEXT="$TEXT" T_TAB="\${DOBIUS_TAB_ID:-}" python3 -c 'import json,os; print(json.dumps({"cmd": os.environ["T_CMD"], "arg": os.environ["T_ARG"], "text": os.environ["T_TEXT"], "tabId": os.environ["T_TAB"]}, ensure_ascii=False))')
RESPONSE=$(printf '%s' "$BODY" | curl -q -sS --noproxy '*' --max-time 30 -X POST "http://127.0.0.1:${port}/team" \\
  -H "Host: 127.0.0.1:${port}" \\
  -H @<(printf 'Authorization: Bearer %s\\n' "$TOKEN") \\
  -H "Content-Type: application/json" \\
  --data-binary @-)
printf '%s' "$RESPONSE" | PYTHONIOENCODING=utf-8 python3 -c '
import json, re, sys
# Never print a control character into the terminal (an echoed argument could carry escape sequences).
clean = lambda s: re.sub("[\\x00-\\x1f\\x7f-\\x9f\\u2028\\u2029]", "?", str(s))
r = json.load(sys.stdin)
if not r.get("ok"):
    print("dobius-team: " + clean(r.get("error", "failed")), file=sys.stderr); sys.exit(1)
for line in r.get("lines", []): print(clean(line))
'
`;
}
