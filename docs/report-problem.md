# Report a problem (status bar bug button)

The bug icon at the right of the status bar opens a small popover. The person writes what went wrong and presses Send (or Cmd+Enter). Main files it as an issue in the private reports repo through this computer's own `gh` login, the same way `electron/error-reporter.js` files faults. No token ships in the app.

## IPC `report:submit`

Renderer: `window.electronAPI.reportProblem(text, includeLog)`.

Request:

| Field | Type | Required | Notes |
|---|---|---|---|
| `text` | string | yes | The person's description. Control bytes dropped, the home folder shortened to `~`, capped at 4000 characters. |
| `includeLog` | boolean | no, default false | When true, the last 40 lines of `<userData>/logs/error.log` (read from its last 32 KB only) go in, scrubbed by `scrub()`. |

Responses:

```json
{ "ok": true, "url": "https://github.com/<repo>/issues/123" }
{ "ok": false, "reason": "empty" }
{ "ok": false, "reason": "busy" }
{ "ok": false, "reason": "no-gh", "report": { "title": "...", "body": "..." } }
{ "ok": false, "reason": "no-access", "report": { "title": "...", "body": "..." } }
{ "ok": false, "reason": "failed", "report": { "title": "...", "body": "..." } }
```

`busy`: a report is in flight, or one was filed in the last 15 s. Every refusal after the text was read carries the report, and the popover copies it to the clipboard so it can be pasted to Sam.

## Side effects

One `gh issue create -R <repo> --title <title> --body <body>` (30 s timeout). The title is `[report] ` plus the first line of the text. The body names the app version, OS and architecture.

## Overrides (ship-tests)

`DOBIUS_GH_BIN` picks the gh binary and `DOBIUS_REPORTS_REPO` the repo, so a harness can use a fake gh and file nothing real. There is no curl form: it is IPC only.
