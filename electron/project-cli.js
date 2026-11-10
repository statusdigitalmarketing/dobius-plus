// dobius-project: the project orchestrator's work board (docs/project-orchestrator.md, electron/project-board.js).
// Installed per instance in <userData>/bin, which every tab has on PATH, so it always reaches the Dobius that owns the
// tab. `brief` runs from the managed SessionStart and UserPromptSubmit hooks on every prompt: it must stay silent and
// quick whatever happens (2 s cap, no python unless there is something to print, always exit 0). It reads the hook's
// stdin for Claude's session id, so a nested `claude -p` in the same tab keeps its own place on the board.
import { shQuote } from '../shared/sh-quote.js';

export function buildProjectCliScript({ port, tokenFile }) {
  return `#!/bin/bash
# dobius-project: who coordinates this project and what each tab is working on.
#   dobius-project                       the board: the orchestrator, open work, what finished in the last day
#   dobius-project claim "<task>"        before starting a distinct task (prints what the other tabs have open)
#   dobius-project done <id> "<result>"  when it is finished, with a one-line result the next tab can use
#   dobius-project drop <id> "<why>"     when you stop without finishing it
#   dobius-project tell "<message>"      send a message to the project orchestrator's Claude
#   dobius-project brief [start]         (hooks) print the board only when it changed since this tab last saw it
[ -n "\${DOBIUS_TAB_ID:-}" ] || { [ "$1" = brief ] && exit 0; echo "dobius-project: run it inside a Dobius+ tab" >&2; exit 1; }
CMD="\${1:-status}"; ARG=""; TEXT=""; SID=""
case "$CMD" in
  status) ;;
  brief) ARG="\${2:-}"
    if [ ! -t 0 ]; then
      # Only the head, with a 1 s cap: session_id is the first field, a stdin left open must never hold a prompt up,
      # and the rest (the whole prompt) is left unread, as every other hook that ignores stdin does.
      IN=""; IFS= read -r -t 1 -n 1024 IN
      re='"session_id"[[:space:]]*:[[:space:]]*"([A-Za-z0-9-]{1,80})"'
      [[ $IN =~ $re ]] && SID="\${BASH_REMATCH[1]}"
    fi ;;
  claim|tell) TEXT="\${*:2}" ;;
  done|drop) ARG="\${2:-}"; TEXT="\${*:3}" ;;
  *) echo 'usage: dobius-project [status] | claim "<task>" | done <id> "<result>" | drop <id> "<why>" | tell "<message>"' >&2; exit 1 ;;
esac
TOKEN=$(cat ${shQuote(tokenFile)} 2>/dev/null) || { [ "$CMD" = brief ] && exit 0; echo "dobius-project: bridge token unreadable (is Dobius+ running?)" >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { [ "$CMD" = brief ] && exit 0; echo "dobius-project: curl not found on PATH" >&2; exit 3; }
esc() { local LC_ALL=C; local s="$1"; s="\${s//\\\\/\\\\\\\\}"; s="\${s//\\"/\\\\\\"}"; printf '%s' "$s" | LC_ALL=C tr '\\000-\\037' ' '; }
BODY="{\\"cmd\\":\\"$(esc "$CMD")\\",\\"arg\\":\\"$(esc "$ARG")\\",\\"text\\":\\"$(esc "$TEXT")\\",\\"tabId\\":\\"$(esc "$DOBIUS_TAB_ID")\\",\\"pwd\\":\\"$(esc "$PWD")\\",\\"session\\":\\"$(esc "$SID")\\"}"
MAXT=30; [ "$CMD" = brief ] && MAXT=2
RESPONSE=$(printf '%s' "$BODY" | curl -q -sS --noproxy '*' --max-time "$MAXT" -X POST "http://127.0.0.1:${port}/project" \\
  -H "Host: 127.0.0.1:${port}" \\
  -H @<(printf 'Authorization: Bearer %s\\n' "$TOKEN") \\
  -H "Content-Type: application/json" \\
  --data-binary @- 2>/dev/null) || { [ "$CMD" = brief ] && exit 0; echo "dobius-project: Dobius+ did not answer" >&2; exit 2; }
if [ "$CMD" = brief ]; then
  # Only an answer with lines to print starts python (a refusal or an empty answer, on every prompt, must not).
  case "$RESPONSE" in *'"ok":true'*'"lines":["'*) ;; *) exit 0 ;; esac
  command -v python3 >/dev/null 2>&1 || exit 0
fi
command -v python3 >/dev/null 2>&1 || { echo "dobius-project: python3 not found on PATH" >&2; exit 3; }
printf '%s' "$RESPONSE" | PYTHONIOENCODING=utf-8 B="$CMD" python3 -c '
import json, os, re, sys
clean = lambda s: re.sub("[\\x00-\\x1f\\x7f-\\x9f\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069\\u2028\\u2029]", "?", str(s))
brief = os.environ.get("B") == "brief"
try: r = json.load(sys.stdin)
except Exception: sys.exit(0 if brief else 2)
if not r.get("ok"):
    if brief: sys.exit(0)
    print("dobius-project: " + clean(r.get("error", "failed")), file=sys.stderr); sys.exit(1)
for line in r.get("lines", []): print(clean(line))
' || { [ "$CMD" = brief ] && exit 0; exit 1; }
exit 0
`;
}
