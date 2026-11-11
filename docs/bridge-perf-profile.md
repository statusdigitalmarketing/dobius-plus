# Bridge: POST /perfProfile

A CPU profile of the Dobius+ main process, taken from inside the running app (node:inspector Session). No restart, no
`--inspect` flag and no open debugging port. Use it when the app is slow or busy under real load: the cost often
depends on the real tabs, windows and transcripts, so a harness cannot reproduce it.

Code: `electron/perf-profile.js` (profiler and summary), `electron/voice-bridge.js` (route).

## Request

- **URL:** `http://127.0.0.1:8421/perfProfile` (the voice bridge; an isolated harness uses `DOBIUS_BRIDGE_PORT`)
- **Method:** POST
- **Auth:** the same five bridge checks as every route: loopback source, `Host: 127.0.0.1:<port>` exactly, no
  `Origin` header, `Content-Type: application/json`, and `Authorization: Bearer <token>` where the token is the
  contents of `<userData>/voice-bridge-token`.

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `seconds` | number | no | 10 | How long to sample. Rounded and clamped to 2..60; anything that is not a finite number means 10 |

## Response

`200` when the profile ran:

```json
{
  "ok": true,
  "seconds": 20,
  "file": "main-2026-11-11T22-10-00-000Z.cpuprofile",
  "samples": 19873,
  "busyPct": 46.2,
  "topSelf": [{ "pct": 12.4, "fn": "stripAnsi electron/selector-parser.js:34" }],
  "topApp": [{ "pct": 20.1, "fn": "pollStatusTick electron/mobile-server.js:518" }]
}
```

- `busyPct`: share of samples where the main thread was not idle.
- `topSelf`: top 20 functions by time spent in the function itself (any code: app, Node, Electron).
- `topApp`: top 20 app functions (`electron/` or `shared/`) by time including everything they call.
- `fn` carries only the last two path segments, never the full install path.
- `file`: the NAME of the full profile in `<userData>/logs/` (the folder is left out: it holds the user's home path),
  for Chrome DevTools > Performance > Load profile. `null` if it could not be saved, including when something already
  exists at that name (a symlink there is never followed).

`409` with `{ "ok": false, "error": "a profile is already running" }` when another profile is in progress, or
`{ "ok": false, "error": "profile failed: ..." }` if the inspector refused. `400` for a body that is not JSON. `401`,
`403`, `405`, `415`, `421` for the bridge checks above.

## Side effects

- Writes `<userData>/logs/main-<time>.cpuprofile` (a few MB for 60 s, mode 0600) and keeps it plus the two newest
  older ones. Only files named exactly like its own (`main-<ISO time>.cpuprofile`) are ever deleted.
- Sampling at 1 ms adds a little main-process CPU for the duration. Only one profile runs at a time.

## Example

The token is a secret: read it from the file inside the command, never paste it.

```bash
node -e '
const fs = require("fs"), http = require("http"), os = require("os");
const tok = fs.readFileSync(os.homedir() + "/Library/Application Support/dobius-plus/voice-bridge-token", "utf8").trim();
const body = JSON.stringify({ seconds: 20 });
const req = http.request({ host: "127.0.0.1", port: 8421, path: "/perfProfile", method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok, "Content-Length": body.length } },
  (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => console.log(res.statusCode, d)); });
req.end(body);'
```

(Some Claude Code setups block inline `node -e` HTTP; put the same lines in a `.mjs` file.)
