# Phone voice API

The phone app (mobile/VoiceButton.jsx) records a command, the Mac transcribes it locally with whisper.cpp, and the
text goes to the **team orchestrator tab** when one is pinned and alive, else to the **Voice Conductor**. Audio never
leaves the Mac. All routes are on the phone server (`mobile-server.js`, tailnet only) and need the paired device's
`Authorization: Bearer <device token>`; a wrong or missing token answers `401 { ok: false, error: "auth" }`.

Since 2.2.25 the phone never sends on release (Brett, Asana 1220412677067987): it transcribes with `?confirm=1`, shows
what it heard and where it goes, and only a tap on **Send** posts the text to `/voice/intent`. **Keep talking** records
again and appends; **Discard** drops it.

Order of calls from the phone: `GET /voice/target` first (a Mac that does not answer it with `confirm: true` would route
the audio on upload, so the phone uploads nothing and says to update the Mac), then `POST /voice/audio?confirm=1`, then
on Send `POST /voice/intent` with `sendId` and `expect`.

## POST /voice/audio

Body: the raw recording (any type ffmpeg reads; the phone sends `audio/webm` or `audio/mp4`), at most 8 MB.

| Query | Type | Default | Meaning |
|---|---|---|---|
| `confirm` | `"1"` | absent | Transcribe only. Nothing is routed. |

```json
// ?confirm=1
{ "ok": true, "transcript": "check the board for new tasks", "held": true, "requestId": null, "routed": false }
// without confirm (phones before 2.2.25): transcribed AND routed at once
{ "ok": true, "transcript": "check the board", "requestId": "req-3f9a1c2b4d5e", "routed": true }
```

`held: true` is how the phone knows the Mac understood `confirm`. The phone never relies on it alone: it has already
checked `/voice/target` before uploading, so a Mac before 2.2.25 never receives the audio.

Errors: `503` transcription not set up (whisper-cli or ffmpeg missing), `422` transcription failed, `413` too large.

```bash
curl -sS -X POST "http://<tailnet-ip>:8420/voice/audio?confirm=1" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: audio/webm" --data-binary @clip.webm
```

Side effects: none beyond CPU (whisper-server is started on first use and reused; at most a couple of transcriptions
run at once).

## GET /voice/target

Where Send would deliver right now. Reads only.

```json
{ "ok": true, "confirm": true, "to": "orchestrator", "label": "your orchestrator tab \"Fleet\"", "key": "orchestrator:9f2c1a7b3d4e5f60" }
{ "ok": true, "confirm": true, "to": "conductor", "label": "the Voice Conductor", "key": "conductor" }
{ "ok": true, "confirm": true, "to": "none", "label": "", "key": "none" }
```

`confirm: true` says this Mac holds audio sent with `?confirm=1`. `key` names the destination without revealing the tab
id (`orchestrator:` + the first 16 hex of sha256 of the tab id); the phone sends it back as `expect`. The phone shows
`Goes to: <label>` on the Heard card. A Mac before 2.2.25 answers 404, and the phone then refuses to record for it.

```bash
curl -sS "http://<tailnet-ip>:8420/voice/target" -H "Authorization: Bearer $TOKEN"
```

## POST /voice/intent

`{ "transcript": string (required, at most 4000 characters), "sendId"?: string, "expect"?: string, "tabId"?: string }`

| Field | Type | Meaning |
|---|---|---|
| `sendId` | 8 to 64 of `A-Z a-z 0-9 _ -` | One id per message. A repeat with the same id is answered with the first delivery's result and is never delivered twice (an in-flight one is shared). Only deliveries are remembered, 200 at most, for 24 hours, also on disk in `<userData>/voice-sent.json` so a retry after a restart is still recognised. A refusal is forgotten, so retrying really retries. |
| `expect` | a `key` from `/voice/target` | Deliver only if the destination is still that one. |
| `retry` | boolean | `true` when this is Send again after an unanswered Send. If the Mac's record of past Sends could not be read (it is then set aside as `voice-sent.json.unreadable-<ms>`), a retry of an id it does not know answers `409 { uncertain: true }` instead of possibly delivering twice. |

A sendId is written down as pending before anything is typed; if Dobius stops mid-delivery, a later retry of it answers
`409 { ok: false, uncertain: true, error }` and is never typed again. If that note cannot be written (disk full), the
answer is `503` and nothing is sent.

Without `tabId`: routed like any voice command (team orchestrator, else Voice Conductor).
`200 { ok: true, mode: "orchestrator" | "conductor", requestId, note? }` (`note` only when the text was typed into
the orchestrator tab but its submission was not confirmed; the phone shows it instead of "Sent", and it is kept in the
saved receipt so a retry after a restart says it too), or `503 { ok: false, error }` when nothing took it
(the reason, e.g. a draft open in the orchestrator tab). When `expect` no longer matches:
`409 { ok: false, changed: true, target: { to, label, key }, error: "Where this goes changed: now ... Check it and Send again." }`,
nothing routed. Over 4000 characters: `413`, nothing routed (never cut short). With a live `tabId`: typed into that tab
(`200 { ok: true, mode: "direct", tabId }`, `409` with the reason when the guarded paste refused, `404` tab gone).

Side effects: the text is pasted into a Claude session as `[voice from the phone] <text>` (orchestrator) or
`[<requestId>] <text>` (Conductor), through the guarded tab-send path (refused at a dialog, a draft, or while someone
types).

```bash
curl -sS -X POST "http://<tailnet-ip>:8420/voice/intent" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"transcript":"check the board","sendId":"a1b2c3d4e5f6","expect":"conductor"}'
```

## POST /voice/reply

`{ "requestId": string, "timeoutMs"?: number (1000 to 60000, default 25000) }`. Long-polls for the answer to that
request: `{ ok: true, reply, ts }` or `{ ok: false, reason: "timeout" }`. For the orchestrator route the answer is
Dobius's own delivery note ("Sent to your orchestrator tab ..."), recorded at once.

## iMessage `d:` commands

Texts to yourself that start with the trigger (default `d:`) take the same route as phone voice, pasted as
`[text from iMessage] <text>` into the orchestrator tab, else the Voice Conductor. The answer comes back as an iMessage
to yourself; when nothing took the text, the reply says why (`(not delivered: ...)`).

## Crash cleanup (whisper-server)

Each whisper-server Dobius starts is recorded in `<userData>/whisper-servers.json` (pid, start time as `ps` prints it,
its per-start secret request path; 8 records at most). Before starting another, Dobius stops any recorded server whose
parent is now launchd (1) and whose start time and request path still match, so a crash no longer leaves copies
stacking up. Nothing that is not on that list is ever stopped.
