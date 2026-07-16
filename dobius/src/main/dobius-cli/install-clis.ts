import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

// Bump when a script body changes so writeIfChanged rewrites installed copies.
const CLI_VERSION = 1
const MARKER = `# dobius-cli v${CLI_VERSION}`
const PORT = 8421
const RETIRED_MESSAGE =
  'This Dobius+ command was retired in the new engine. See dobius --help / the Tasks panel.'
const LEGACY_MARKERS = ['voice-bridge-token', '127.0.0.1:8421'] as const
export const STALE_LEGACY_CLIS = [
  'dobius-tabs',
  'dobius-reply',
  'dobius-track',
  'dobius-mark-done',
  'dobius-asana-complete',
  'dobius-stage',
  'dobius-spawn',
  'dobius-ask',
  'dobius-lead-tab',
  'dobius-asana-fetch',
  'dobius-asana-allow',
  'dobius-asana-list-allowed',
  'dobius-confirm',
  'dobius-handoff',
  'dobius-scheduled'
] as const

function cliDir(): string {
  return path.join(homedir(), '.local', 'bin')
}

// Scripts JSON-encode args via python3 so arbitrary text is safely escaped —
// no shell interpolation into the JSON body. Mirrors the old voice-bridge CLIs.
function scriptFor(
  name: string,
  route: string,
  buildBody: string,
  usage: string,
  tokenFile: string
): string {
  return `#!/bin/bash
${MARKER}
# ${usage}
set -e
command -v python3 >/dev/null 2>&1 || { echo "$(basename "$0"): python3 not found on PATH" >&2; exit 3; }
command -v curl >/dev/null 2>&1 || { echo "$(basename "$0"): curl not found on PATH" >&2; exit 3; }
TOKEN=$(cat "${tokenFile}" 2>/dev/null) || { echo "${name}: bridge token unreadable (is Dobius+ running?)" >&2; exit 2; }
${buildBody}
curl -sS -X POST "http://127.0.0.1:${PORT}${route}" \\
  -H "Host: 127.0.0.1:${PORT}" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  --data-binary "$BODY"
`
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

function retiredStub(): string {
  return `#!/bin/bash
${MARKER}
echo "${RETIRED_MESSAGE}" >&2
exit 1
`
}

function replaceStaleLegacyClis(dir: string): void {
  for (const name of STALE_LEGACY_CLIS) {
    if (name === 'dobius-tabs') {
      continue
    }
    const file = path.join(dir, name)
    try {
      const contents = readFileSync(file, 'utf8')
      if (!LEGACY_MARKERS.some((marker) => contents.includes(marker))) {
        continue
      }
      writeIfChanged(file, retiredStub())
    } catch (err) {
      // Missing or unreadable stale scripts are harmless.
      void err
    }
  }
}

export function installDobiusClis(tokenFile: string): void {
  const dir = cliDir()
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    console.warn(`[dobius-cli] could not create ${dir}: ${(err as Error).message}`)
    return
  }

  const scripts: Record<string, string> = {
    'dobius-send': scriptFor(
      'dobius-send',
      '/tabSend',
      `if [ $# -lt 1 ]; then echo "usage: dobius-send <message>" >&2; exit 1; fi
MESSAGE="$*"
BODY=$(python3 -c 'import json,sys; print(json.dumps({"message": sys.argv[1]}))' "$MESSAGE")`,
      'Send a line into the active Dobius+ terminal. Usage: dobius-send "<message>"',
      tokenFile
    ),
    'dobius-task-done': scriptFor(
      'dobius-task-done',
      '/taskDone',
      `if [ $# -lt 1 ]; then echo "usage: dobius-task-done <task title|asanaGid>" >&2; exit 1; fi
REF="$*"
BODY=$(python3 -c 'import json,sys; print(json.dumps({"ref": sys.argv[1]}))' "$REF")`,
      'Tick a task done in the Dobius+ Tasks panel (LOCAL only — never completes it in Asana). Usage: dobius-task-done "<task title|asanaGid>"',
      tokenFile
    ),
    'dobius-status': scriptFor(
      'dobius-status',
      '/getStatus',
      `BODY="{}"`,
      'Check the Dobius+ CLI bridge is up. Usage: dobius-status',
      tokenFile
    ),
    'dobius-tabs': scriptFor(
      'dobius-tabs',
      '/tabList',
      `BODY="{}"`,
      'List Dobius+ terminal tabs. Usage: dobius-tabs',
      tokenFile
    )
  }
  replaceStaleLegacyClis(dir)

  for (const [name, body] of Object.entries(scripts)) {
    try {
      writeIfChanged(path.join(dir, name), body)
    } catch (err) {
      console.warn(`[dobius-cli] could not install ${name}: ${(err as Error).message}`)
    }
  }
}
