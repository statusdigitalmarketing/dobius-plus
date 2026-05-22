# Dobius+ Mobile PWA — Plan

## Context

Dobius+ is a Mac desktop app. The goal: from a phone, view Claude Code chat
history and interact with the live terminals running on the Mac — send input,
do the interactive stuff, open new tabs, switch between terminals. One terminal
visible at a time. This is a companion surface, not a full port of the desktop
dashboard.

The blocker: terminals are `node-pty` processes inside the Electron main
process, reachable only via Electron IPC by the local desktop renderer. The
phone needs a network path in. So Dobius+ gains an **embedded server** that
bridges the terminals and chat history onto the network, plus a separate
mobile-optimized PWA frontend.

## Network + auth (decided)

- **Tailscale.** The server binds only to the Mac's tailnet interface
  (`100.x.x.x`), so the port is not routable from the public internet. The
  phone reaches it over the tailnet from anywhere. Detect the tailnet IP via
  `tailscale ip -4` (fall back to scanning interfaces for the `100.64.0.0/10`
  CGNAT range).
- **Pairing token on top.** Desktop shows a one-time code; the phone submits it
  once and receives a long-lived device token stored in the PWA. Defense in
  depth — a bug in the token check is still contained by the tailnet boundary.

## Installing on the phone / iPad

No App Store. The PWA installs from the browser:
1. Tailscale on (Mac + device).
2. Open Safari, go to the connect URL from Settings > Mobile Access
   (`http://<tailnet-ip>:8420`).
3. Share > Add to Home Screen. Launches full-screen via the web manifest.

Nuance: plain `http://` is not a secure context, so iOS won't register a
service worker (offline caching) over it. The home-screen app experience works
without one. The full-PWA upgrade is **Tailscale HTTPS** (`tailscale cert` +
MagicDNS gives `https://<machine>.<tailnet>.ts.net` with a real cert). That is
a v1.1 polish step, not a blocker for v1.

## Architecture

```
 Phone (PWA)  ──WSS over tailnet──>  Dobius+ embedded server  ──>  node-pty
   xterm.js                          (electron/mobile-server.js)    terminals
   chat view                                │
                                            └──>  data-service.js (chat history)
```

The same PTY is shared: a session started on the desktop is the one the phone
attaches to. Input from either side writes to the same shell.

## Decided scope (user, 2026-05-22)

- **Shared terminals.** The phone sees the exact set of terminals open on the
  desktop and attaches to those live PTYs. Not separate phone-only terminals.
- **Open new tabs from the phone**, two ways:
  1. From chat history — tap a past session, it opens a new tab that *resumes*
     that session (`claude --resume <id>` style, reusing the desktop app's
     existing resume path).
  2. A plain new terminal — opens a fresh tab where the user types `claude` (or
     anything) themselves.
- So chat history is **not** read-only: it is the launch point for resuming.
- **Delivery: phased.** Ship server foundation first, then the bridge, then the
  PWA, then history — so each phase is testable on the real phone before the
  next.

## Components

### `electron/mobile-server.js` (new)
- Express serves the built PWA static files from `dist-mobile/`.
- `ws` WebSocket server for terminal I/O + commands.
- Binds to the tailnet IP only. Off by default; a Settings toggle starts/stops it.
- Pairing: generate code, verify, issue device token, persist known devices in
  config.

### Terminal fan-out refactor (`electron/terminal-manager.js`) — riskiest change
- Today each terminal streams `onData` output to exactly one `webContents`.
- Generalize to a **subscriber set**: the desktop window plus any attached
  WebSocket clients. Input/resize/kill already take an `id`, so they need no
  change beyond also accepting WS-originated calls.
- Must not regress the desktop app — the desktop `webContents` stays a
  subscriber exactly as before.

### WebSocket protocol
- Client → server: `auth`, `listTerminals`, `attach {termId}`, `detach`,
  `input {termId,data}`, `resize {termId,cols,rows}`, `createTerminal
  {projectPath}`, `listSessions`, `loadTranscript {sessionId,projectPath}`.
- Server → client: `output {termId,data}`, `terminals {list}`, `exit {termId}`,
  `sessions {list}`, `transcript {entries}`, `error {message}`.

### Mobile PWA frontend (new `mobile/` Vite entry → `dist-mobile/`)
- Single xterm.js terminal, one at a time, touch-optimized.
- **Special-keys accessory bar** — Esc, Tab, Ctrl, arrows, Cmd. iOS/Android
  keyboards can't send these; a terminal PWA is unusable without it.
- Terminal switcher: tap-list of open terminals, tap to switch.
- "New terminal" button: pick a project, server calls `createTerminal`.
- Chat history: session list + transcript viewer, served from `data-service.js`.
- PWA manifest + service worker → installable, full-screen, app-like.

### Build
- Add a second Vite entry for `mobile/`, output to `dist-mobile/`.
- `electron-builder.yml` `files:` must include `dist-mobile/**/*` so the server
  can serve it from the packaged app.
- New deps: `express`, `ws` (both small).

## Phasing

1. **Server foundation** — `mobile-server.js`, tailnet bind, Settings toggle,
   pairing flow. Verify: hit the server from a browser on the phone.
2. **Terminal bridge** — fan-out refactor + WS protocol. Verify: desktop app
   still works unchanged; phone can attach and see live output.
3. **Mobile PWA** — xterm UI, special-keys bar, terminal switcher, new-terminal.
   Verify: drive a real Claude session from the phone.
4. **Chat history** — session list + transcript in the PWA.
5. **Polish/hardening** — reconnect on network flap, token rotation, rate
   limiting, connection-status indicator.

## Known risks / open questions

- **Fan-out refactor** touches the core terminal data path. Highest regression
  risk; phase 2 needs careful review and a desktop smoke test.
- **PTY resize conflict** — desktop and phone have different terminal
  dimensions sharing one PTY. Proposal: the most-recently-active client owns
  the size; the other reflows. Worth confirming the UX is acceptable.
- **iOS PWA backgrounding** — WebSockets get killed when the PWA backgrounds.
  Need reconnect + state resync (replay recent scrollback on re-attach).
- **Scrollback on attach** — when the phone attaches to an existing terminal,
  replay the persisted scrollback so the screen isn't blank.
