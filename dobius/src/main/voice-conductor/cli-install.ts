import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { app } from 'electron'

// Auto-installer for the Voice Conductor's dobius-* CLIs. Ported from v1
// electron/voice-bridge.js. Each script curls a token-authed JSON POST at the
// conductor CLI server (see cli-server.ts). Kept electron-light: only reads the
// userData path for the token file location.
//
// Bump when any script body changes so writeIfChanged rewrites installed copies.
const CLI_VERSION = 1
const MARKER = `# dobius-conductor-cli v${CLI_VERSION}`

// The conductor CLI server binds its OWN port + token file, distinct from the
// dobius-cli dispatch server on 8421 (src/main/dobius-cli). 8422 is unused
// elsewhere in the tree. Using a distinct token file name also means these
// scripts do NOT carry the legacy voice-bridge markers ('voice-bridge-token' /
// '127.0.0.1:8421'), so the dobius-cli installer's replaceStaleLegacyClis()
// will not clobber them into retired stubs.
const PORT = 8422
const HOST = '127.0.0.1'
const TOKEN_FILE_NAME = 'voice-conductor-cli-token'

/** Absolute location the CLIs read the bearer token and server port from. */
export function conductorCliServerAddress(): { host: string; port: number; tokenFile: string } {
  return {
    host: HOST,
    port: PORT,
    tokenFile: path.join(app.getPath('userData'), TOKEN_FILE_NAME)
  }
}

function cliDir(): string {
  return path.join(homedir(), '.local', 'bin')
}

// Common script preamble: shebang, marker, one-line usage, tool checks, and the
// token read (0600 file → Bearer header). Scripts JSON-encode args via python3
// so arbitrary text is safely escaped with no shell interpolation into the body.
function header(name: string, usage: string, tokenFile: string): string {
  return `#!/bin/bash
${MARKER}
# ${usage}
set -e
command -v python3 >/dev/null 2>&1 || { echo "$(basename "$0"): python3 not found on PATH" >&2; exit 3; }
command -v curl >/dev/null 2>&1 || { echo "$(basename "$0"): curl not found on PATH" >&2; exit 3; }
TOKEN=$(cat "${tokenFile}" 2>/dev/null) || { echo "${name}: bridge token unreadable (is Dobius+ running?)" >&2; exit 2; }`
}

function buildScripts(tokenFile: string): Record<string, string> {
  const base = `-H "Host: ${HOST}:${PORT}" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json"`
  return {
    // dobius-send <tabId> "<message>" -> POST /tabSend
    'dobius-send': `${header('dobius-send', 'Send a message into another Dobius+ terminal tab. Usage: dobius-send <tabId> "<message>"', tokenFile)}
if [ $# -lt 2 ]; then echo "usage: dobius-send <tabId> <message>" >&2; exit 1; fi
TAB_ID="$1"; shift
MESSAGE="$*"
BODY=$(python3 -c 'import json,sys; print(json.dumps({"tabId": sys.argv[1], "message": sys.argv[2]}))' "$TAB_ID" "$MESSAGE")
curl -sS -X POST "http://${HOST}:${PORT}/tabSend" ${base} --data-binary "$BODY"
`,

    // dobius-tabs -> POST /tabList
    'dobius-tabs': `${header('dobius-tabs', 'List currently open Dobius+ terminal tabs (id + cwd). Usage: dobius-tabs', tokenFile)}
curl -sS -X POST "http://${HOST}:${PORT}/tabList" ${base} -d "{}" \\
  | python3 -c 'import json,sys; d=json.load(sys.stdin); [print(t.get("id",""), "-", t.get("cwd") or t.get("projectPath","")) for t in d.get("tabs", [])]'
`,

    // dobius-reply <requestId> "<msg>" -> POST /setReply
    'dobius-reply': `${header('dobius-reply', 'Set the spoken reply for a voice request id. Usage: dobius-reply <requestId> "<one-line reply>"', tokenFile)}
if [ $# -lt 2 ]; then echo "usage: dobius-reply <requestId> <message>" >&2; exit 1; fi
REQUEST_ID="$1"; shift
MESSAGE="$*"
BODY=$(python3 -c 'import json,sys; print(json.dumps({"requestId": sys.argv[1], "message": sys.argv[2]}))' "$REQUEST_ID" "$MESSAGE")
curl -sS -X POST "http://${HOST}:${PORT}/setReply" ${base} --data-binary "$BODY" >/dev/null
`,

    // dobius-track <workId> <tabId> <requestId> "<desc>" -> POST /trackWork
    'dobius-track': `${header('dobius-track', 'Register dispatched work with the registry. Usage: dobius-track <workId> <tabId> <requestId> "<description>"', tokenFile)}
if [ $# -lt 4 ]; then echo "usage: dobius-track <workId> <tabId> <requestId> <description>" >&2; exit 1; fi
WORK_ID="$1"; TAB_ID="$2"; REQUEST_ID="$3"; shift 3
DESCRIPTION="$*"
BODY=$(python3 -c 'import json,sys; print(json.dumps({"workId": sys.argv[1], "tabId": sys.argv[2], "requestId": sys.argv[3], "description": sys.argv[4]}))' "$WORK_ID" "$TAB_ID" "$REQUEST_ID" "$DESCRIPTION")
curl -sS -X POST "http://${HOST}:${PORT}/trackWork" ${base} --data-binary "$BODY"
`,

    // dobius-status [target] -> POST /getStatus, prints .snapshot
    'dobius-status': `${header('dobius-status', 'Query the work registry. Usage: dobius-status [target]  (workId / project substring / empty for all)', tokenFile)}
TARGET="$*"
BODY=$(python3 -c 'import json,sys; print(json.dumps({"target": sys.argv[1]}))' "$TARGET")
curl -sS -X POST "http://${HOST}:${PORT}/getStatus" ${base} --data-binary "$BODY" \\
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("snapshot",""))'
`,

    // dobius-mark-done <workId> "<summary>" [status] -> POST /markDone
    'dobius-mark-done': `${header('dobius-mark-done', 'Manually mark a tracked work item done. Usage: dobius-mark-done <workId> "<summary>" [status]', tokenFile)}
if [ $# -lt 2 ]; then echo "usage: dobius-mark-done <workId> <summary> [status]" >&2; exit 1; fi
WORK_ID="$1"; SUMMARY="$2"; STATUS="\${3-}"
BODY=$(python3 -c 'import json,sys; print(json.dumps({"workId": sys.argv[1], "summary": sys.argv[2], "status": sys.argv[3]}))' "$WORK_ID" "$SUMMARY" "$STATUS")
curl -sS -X POST "http://${HOST}:${PORT}/markDone" ${base} --data-binary "$BODY"
`,

    // dobius-spawn <projectPath> <agentId> "<prompt>" -> POST /spawn (imessage-gated server-side)
    'dobius-spawn': `${header('dobius-spawn', 'Start a fresh Dobius+ custom-agent run in a project (asks Carson via iMessage to confirm). Usage: dobius-spawn <projectPath> <agentId> ["<initial prompt>"]', tokenFile)}
if [ $# -lt 2 ]; then echo "usage: dobius-spawn <projectPath> <agentId> [initial prompt]" >&2; exit 1; fi
PROJECT="$1"; AGENT="$2"; shift 2
INITIAL="$*"
BODY=$(python3 -c 'import json,sys; print(json.dumps({"projectPath": sys.argv[1], "agentId": sys.argv[2], "initialPrompt": sys.argv[3]}))' "$PROJECT" "$AGENT" "$INITIAL")
curl -sS --max-time 320 -X POST "http://${HOST}:${PORT}/spawn" ${base} --data-binary "$BODY"
`,

    // dobius-ask "<question>" -> POST /ask, blocks up to 5 min, prints .answer
    'dobius-ask': `${header('dobius-ask', 'Ask Sam a question via iMessage and wait up to 5 min. Usage: dobius-ask "<question>"', tokenFile)}
if [ $# -lt 1 ]; then echo "usage: dobius-ask <question>" >&2; exit 1; fi
QUESTION="$*"
BODY=$(python3 -c 'import json,sys; print(json.dumps({"question": sys.argv[1]}))' "$QUESTION")
curl -sS --max-time 320 -X POST "http://${HOST}:${PORT}/ask" ${base} --data-binary "$BODY" \\
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("answer") or ("(timeout)" if d.get("timedOut") else ""))'
`,

    // dobius-lead-tab get|set|clear <projectPath> [tabId]
    'dobius-lead-tab': `${header('dobius-lead-tab', 'Manage a project lead tab. Usage: dobius-lead-tab get|set|clear <projectPath> [tabId]', tokenFile)}
case "\${1-}" in
  get)
    [ $# -ge 2 ] || { echo "usage: dobius-lead-tab get <projectPath>" >&2; exit 1; }
    BODY=$(python3 -c 'import json,sys; print(json.dumps({"projectPath": sys.argv[1]}))' "$2")
    curl -sS -X POST "http://${HOST}:${PORT}/getLeadTab" ${base} --data-binary "$BODY"
    ;;
  set)
    [ $# -ge 3 ] || { echo "usage: dobius-lead-tab set <projectPath> <tabId>" >&2; exit 1; }
    BODY=$(python3 -c 'import json,sys; print(json.dumps({"projectPath": sys.argv[1], "tabId": sys.argv[2]}))' "$2" "$3")
    curl -sS -X POST "http://${HOST}:${PORT}/setLeadTab" ${base} --data-binary "$BODY"
    ;;
  clear)
    [ $# -ge 2 ] || { echo "usage: dobius-lead-tab clear <projectPath>" >&2; exit 1; }
    BODY=$(python3 -c 'import json,sys; print(json.dumps({"projectPath": sys.argv[1], "tabId": None}))' "$2")
    curl -sS -X POST "http://${HOST}:${PORT}/setLeadTab" ${base} --data-binary "$BODY"
    ;;
  *)
    echo "usage: dobius-lead-tab get|set|clear <projectPath> [tabId]" >&2; exit 1 ;;
esac
`,

    // dobius-asana-fetch [queue] -> POST /asana/fetch, prints raw JSON (.tasks + .summary)
    'dobius-asana-fetch': `${header('dobius-asana-fetch', 'Fetch queued Asana tasks + a formatted summary. Usage: dobius-asana-fetch [queue]', tokenFile)}
QUEUE="$*"
BODY=$(python3 -c 'import json,sys; print(json.dumps({"queue": sys.argv[1]}))' "$QUEUE")
curl -sS -X POST "http://${HOST}:${PORT}/asana/fetch" ${base} --data-binary "$BODY"
`
  }
}

function writeIfChanged(file: string, contents: string): void {
  try {
    if (readFileSync(file, 'utf8') === contents) {
      return
    }
  } catch {
    // missing — write below
  }
  writeFileSync(file, contents, 'utf8')
  chmodSync(file, 0o755)
}

/**
 * Write the conductor dobius-* scripts to ~/.local/bin. Idempotent + cheap to
 * run on boot (only rewrites when the marker/body changes). Never throws —
 * per-script failures are logged and skipped so one bad write can't block boot.
 */
export function installConductorClis(): void {
  const dir = cliDir()
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    console.warn(`[conductor-cli] could not create ${dir}: ${(err as Error).message}`)
    return
  }
  const { tokenFile } = conductorCliServerAddress()
  for (const [name, body] of Object.entries(buildScripts(tokenFile))) {
    try {
      writeIfChanged(path.join(dir, name), body)
    } catch (err) {
      console.warn(`[conductor-cli] could not install ${name}: ${(err as Error).message}`)
    }
  }
}
