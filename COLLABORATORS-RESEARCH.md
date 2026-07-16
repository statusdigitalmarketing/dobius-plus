# Dobius+ "Collaborators" — Research & Design Report

_Prepared 2026-07-11. Audience: a developer learning as they build — technical terms are defined in plain English on first use._

---

## 0. How to read this report (and one honesty note)

**What "Collaborators" is meant to be:** two people, each running Dobius+ on their own Mac, get invited into a shared space tied to a project/repo/task/campaign. Inside that space they share (a) **notes, memory, and knowledge** that sync to both machines and are readable by both the humans *and* the Claude Code agents running in each person's terminals; (b) **agent-to-agent delegation** — my agent can hand a piece of work to your agent across the two machines; (c) an **invite system** (a link or code to join a repo/task/campaign); and (d) **end-to-end encrypted chat** inside the app (end-to-end encrypted = only the two Macs can read the messages; any server in the middle sees only scrambled bytes).

**Honesty note on the research process.** This report was produced by a deep-research harness that fanned out web searches, fetched 16 sources, and pulled 77 factual claims. The final step — a robot "fact-check panel" that re-reads each source to confirm every claim — was cut off partway by an API credit limit. So the claims below are **quoted from primary sources** (official docs, the actual protocol specs, vendor engineering blogs) but were **not independently cross-verified** by a second pass. I've marked the few numbers that most deserve a manual sanity-check with ⚠️. The engineering recommendations and the build plan are my synthesis on top of those sources.

Sources are cited inline as `[n]` and listed in §8.

---

## 1. Transport — how the two Macs actually talk

This is the foundational choice; everything else rides on top of it. The problem: two Macs sitting behind home routers can't just "call" each other directly, because a router hides the machines behind it (this is called **NAT** — Network Address Translation, the thing that lets many devices share one public internet address). Getting through it is called **NAT traversal** or **hole-punching**.

Three families of approach:

**(i) Pure peer-to-peer (P2P)** — the two Macs connect directly, no server in the middle holding data.
- **Iroh** (a Rust P2P library, Tailscale-inspired) reports **~95% hole-punching success**, and when a direct connection can't be made it automatically falls back to cheap, stateless relay servers it hosts [1]. ⚠️ (the 95% is Iroh's own published figure).
- **libp2p** (the P2P stack from the IPFS project) reports **~70%** hole-punching success by comparison [1].
- **WebRTC data channels** — the browser/Electron-native way to open a direct P2P data pipe. Works well but needs a small "signaling" server (a matchmaker that helps the two peers find each other before they connect directly) and STUN/TURN servers (STUN helps a peer discover its own public address; TURN is a relay used when direct fails).
- **Tailscale / WireGuard** — an "overlay network" (a private virtual network laid over the public internet) that makes two machines behave as if they're on the same LAN. Rock-solid, but it's a separate product each user has to install and log into — heavy for a two-person feature.

**The decisive real-world evidence** comes from VS Code Live Share, a shipped product solving nearly this exact problem [9][10]:
- Live Share **tries a direct peer connection first and falls back to a cloud relay** when no direct route exists — a hybrid design, not pure P2P [9].
- Direct connections need the host to open an inbound firewall port (range 5990–5999), and **if the user declines the firewall prompt it silently falls back to always relaying** [9].
- **Lesson: pure direct P2P behind consumer firewalls/NAT is unreliable enough that a relay fallback is mandatory in any shipped product.** Live Share ships the fallback precisely because direct-only fails too often.

**(ii) Small self-hosted relay** — a lightweight always-on server that just passes encrypted messages between the two Macs (and holds them if one Mac is asleep). Cheapest to *build*, and it's the only clean answer to **offline/async delivery** — if your teammate's Mac is closed, a pure-P2P link has nobody to talk to, whereas a relay can hold the message until they wake up. The relay never sees plaintext if we encrypt end-to-end.

**(iii) Piggyback on existing infrastructure** — Matrix (an open chat-network protocol), Nostr (a lightweight relay-based messaging protocol), or even GitHub as a sync medium. These give you async delivery and encryption "for free" but drag in a large protocol surface and a dependency on someone else's network for a feature that only ever needs to connect two known people.

### Recommendation — transport
**Ship v1 on a tiny self-hosted WebSocket relay, with end-to-end encryption on top so the relay is untrusted.** (WebSocket = a persistent two-way connection between an app and a server, the standard way apps get real-time messages.) Rationale:
- It's the **simplest thing that handles the one-Mac-asleep case** — the hard requirement pure P2P can't meet.
- Because we encrypt end-to-end (§3), the relay is a **dumb, untrusted pipe** — it can be a ~$5/month box, and a breach of it leaks nothing readable.
- **Migration path:** the relay stays as the fallback, and we can later add a direct-P2P "fast path" (WebRTC or Iroh) that upgrades the connection when both Macs are online — exactly Live Share's hybrid model [9]. We get async delivery now and can bolt on P2P speed later without changing the app's data model.

Skipped for v1: Iroh/libp2p (adds a Rust dependency and NAT-traversal complexity we don't need when a relay already works); Tailscale (a second product for users to install); Matrix/Nostr (too much protocol for two known people).

---

## 2. Shared state & sync — the notes/memory/knowledge store

The shared notes and memory must survive **both people editing at once** without one clobbering the other. The tool for that is a **CRDT** (Conflict-free Replicated Data Type — a data structure that lets multiple people edit the same document concurrently and merges the results automatically, no "conflict" popups). This is the same tech Figma multiplayer and Google Docs-style editing rely on.

The three JS/Node-capable candidates [4][22][23][24]:

| Library | Bundle size | Adoption | Notes |
|---|---|---|---|
| **Yjs** | **~20 KB gzipped, pure JS, no WASM** ⚠️ (sources say 18–25 KB) [5][21][24] | **~920K weekly npm downloads, 17K stars** ⚠️ [23] | Most mature; broadest ready-made adapters (WebSocket, WebRTC, IndexedDB) and editor bindings [24] |
| **Automerge** | ~600 KB gzipped (WASM) [5] | ~85K downloads, 4.2K stars [23] | Best when **full version history + branching/merging + change attribution** are product features [25]. `automerge-repo` adds networking/storage plumbing [1a] but as of its Nov-2023 launch was flagged **not production-ready** on performance ⚠️ — must re-check current releases [1c] |
| **Loro** | ~890 KB gzipped (WASM), youngest [6] | ~12K downloads, 3.8K stars [23] | Very fast document loading, but **early-stage ecosystem, manual WebSocket integration** [24] |

(WASM = WebAssembly, a way to run compiled code like Rust inside a JS app; it works but bloats the bundle and adds loading cost.)

Two things matter uniquely for Dobius+: the shared store is **markdown notes + JSON memory files that agents also read and write** (via the existing `.dobius/NOTES.md` and the memory directory), and it must ship inside an Electron renderer where **bundle size and simplicity win**.

### Recommendation — sync
**Use Yjs for the shared notes/memory store.** It's the smallest (~30× smaller than Automerge), by far the most adopted and battle-tested, and it already has the exact network adapter we want (`y-websocket`, which rides the same relay from §1) plus local persistence (`y-indexeddb`). Automerge's headline advantage — deep version history and branching — isn't a v1 requirement here, and its bundle/WASM cost is real. Loro is promising but too young to bet a shipped feature on.

**Important design point for the agent-readable requirement.** Agents read plain files (`NOTES.md`, memory `.md`/`.json`), not a CRDT's internal binary format. So the pattern is: **Yjs holds the source of truth in memory and syncs it; a thin adapter projects the current Yjs state out to the plain files on disk whenever it changes, and watches those files to fold local (human- or agent-made) edits back into Yjs.** Dobius+ already watches project files with `chokidar` — reuse it. This keeps the "both humans and agents can read/write the same knowledge" promise without teaching agents anything new.

> **Zed is the proof this works.** Zed (a collaborative code editor) is built on CRDTs throughout its editing engine [8][10a], and its **Channels** feature pairs real-time shared editing with a **persistent free-form Notes document per channel used to hand off knowledge between collaborators** [7] — which is almost exactly the Dobius+ shared-notes concept. It's a direct, shipped precedent.

Skipped for v1: append-only logs / git-backed sync (simpler to imagine but you end up re-implementing conflict resolution by hand — that's the problem CRDTs already solve); Automerge and Loro (see above).

---

## 3. End-to-end encrypted chat

The universal expert guidance is blunt: **do not invent your own cryptography — use a vetted library.** The canonical developer reference ("Cryptographic Right Answers," from the security firm Latacora) says to use **libsodium/NaCl constructions** (specifically `crypto_box`, built on XSalsa20-Poly1305) rather than assembling crypto primitives yourself [E2EE search / latacora.com]. NaCl/libsodium is a well-audited crypto library with a deliberately tiny, hard-to-misuse API.

The heavyweight options and why they're overkill for two known devices:
- **libsignal** (the Signal messenger's library) and **MLS / OpenMLS** (Messaging Layer Security, an IETF standard) are designed for **group** messaging, multi-device fan-out, and features like "forget past messages if a key leaks" at scale. Powerful, but a lot of machinery for a two-person channel.
- **Matrix's Olm/Megolm** — same story, tied to the Matrix ecosystem.

**The simplest credible design for exactly two known devices:** during pairing (§6), the two apps exchange long-term public keys. From then on, encrypt each chat message with a NaCl `crypto_box` (which does authenticated public-key encryption between two known keypairs). That's it — no key server, no session ceremony. The invite code carries out-of-band trust: because you exchanged keys through a code you read to each other over a trusted channel (text, voice), each side knows the other's real key and the relay can never impersonate either party.

**Precedent for the invite mechanism:** **Magic Wormhole** pairs two endpoints with **single-use, human-readable codes** and uses a **PAKE** (Password-Authenticated Key Exchange — a method where a short shared code lets two parties derive a strong encryption key without ever sending the code itself) [alternativeto.net]. This is the gold-standard pattern for "short code → strong E2E encryption," and it's worth copying for the pairing step.

### Recommendation — encryption
**Use libsodium (via `libsodium-wrappers` or `sodium-native` in Node/Electron) with `crypto_box` for the two-party channel.** Optionally borrow Magic Wormhole's PAKE idea so the invite code alone bootstraps the encryption. This is the smallest design that experts would sign off on. Explicitly **do not** hand-roll AES + your own key exchange.

⚠️ Caveat to verify before building: `crypto_box` with static long-term keys does **not** give "forward secrecy" (if a key is later stolen, past recorded messages could be decrypted). For a two-person internal tool that's an acceptable v1 trade-off; note it and revisit if the threat model grows.

---

## 4. Prior art — what to borrow

- **Zed Channels [7][8]** — the closest shipped UX to what you want: a named space two+ people join to co-work, **with a shared Notes document per channel for handoff.** Borrow the "channel = shared space + shared notes" mental model wholesale. Built on CRDTs [10a], confirming the §2 choice.
- **VS Code Live Share [9][10]** — the transport reference: direct-first, **relay-fallback**, all peer traffic end-to-end encrypted (over SSH), and a **central service that only does auth + discovery and never sees session content** [10]. This is the exact trust model to copy: the server matchmakes and relays ciphertext, never plaintext. Its invite model — a **non-guessable per-session link that expires**, plus host approval before a guest is admitted [10b] — is a clean template for §6, and its host-approval step is the human-in-the-loop pattern for §5.
- **Magic Wormhole** — the invite-code/PAKE pattern (§3, §6).
- **AI-agent collaboration precedents** — this space is early. The relevant primitive that exists is Google's **A2A protocol** (§5). Shared-agent-memory products (mem0, Letta/MemGPT) were surveyed but their pages didn't extract before the credit cutoff; treat "shared agent memory across two users" as **greenfield** — you'd be early, which is part of the appeal.

---

## 5. Agent-to-agent delegation across machines

The mature primitive here is **Google's A2A (Agent2Agent) protocol** — announced April 2025, contributed to the Linux Foundation June 2025 under Apache 2.0, so it's a vendor-neutral open standard, not a Google-only thing [atlan.com]. What's worth borrowing (you don't have to adopt the whole spec — borrow the *model*):

- A2A's fundamental unit is a **Task**: a stateful piece of work with a unique ID and a defined lifecycle — `submitted → working → input-required → auth-required → completed/failed/canceled` [17][18]. This gives delegation **real handoff semantics** instead of ad-hoc messages.
- Critically for your safety requirement, the lifecycle includes **`input-required` and `auth-required`** states — **protocol-level hooks for pausing a delegated task until the human on the receiving side provides input or approves it** [18]. This is exactly the "an incoming task never auto-executes without the receiving human's approval" rule you asked for, and it's a first-class part of the model, not a bolt-on.
- **MCP is the wrong tool for the network hop.** The Model Context Protocol (which Dobius+/Claude Code already uses for tools) is a **local client-server** design and was **not built to be a cross-machine routing overlay** [dev.to]. Use MCP for what an agent does on *its own* machine; use an A2A-style task message for the hop *between* machines.

### Recommendation — delegation
Model a delegated task as a small JSON "task card" sent over the same encrypted relay channel (§1/§3), with an A2A-inspired lifecycle. **The receiving Dobius+ shows the incoming task in its existing Tasks panel in a `pending-approval` state and does nothing until the human clicks approve** — then and only then does it spawn the agent/terminal to run it. This maps directly onto your existing Asana build/review lanes: the encrypted channel is the transport, the human-approval gate is the `auth-required` state, and Asana stays the system of record. Never auto-run an inbound task — mirror Live Share's host-approval-before-admit posture [10b].

---

## 6. Invite & identity without accounts

You want two known people to pair with no signup, no password, no account server. The proven primitives:

- **Syncthing device IDs** [19][20] — Syncthing (a P2P file-sync tool) identifies each device by a **self-certifying ID: the SHA-256 hash of the device's own TLS certificate.** "Self-certifying" means the identity *is* a property of the device's cryptographic key, not a record in some account database. Pairing = each side adds the other's ID to an allowlist; after the secure handshake, each side computes the peer's ID from the certificate it presented and **drops the connection if it's not on the allowlist — no server, no account** [20]. This is the exact identity primitive to reuse.
- **Magic Wormhole codes** — single-use human-readable codes + PAKE (§3), the friendliest way to carry that identity/key exchange over a text message or a spoken sentence.

### Recommendation — invite/identity
**Each Dobius+ install generates a long-lived keypair on first run; the public key (or a hash of it) is its device identity — self-certifying, Syncthing-style.** To invite, the owner generates a **short one-time pairing code** (Magic-Wormhole-style) that carries or bootstraps a key exchange; the teammate pastes it in; the two apps swap public keys and each pins the other's key to the shared space (the "Pact"). From then on the two devices trust each other permanently for that space — no accounts ever.

**Scaling to 2–10 (v2):** the self-certifying-key model extends cleanly — a shared space just holds a **list** of trusted device keys instead of one. Adding a third person = they pair in and their key joins the allowlist. The one thing that gets harder at group scale is **encryption**: two-party `crypto_box` (§3) doesn't fan out to N people efficiently, so a v2 group version is where you'd graduate to **MLS/OpenMLS** (built exactly for efficient group E2E encryption). Design the message format now so that swap is possible later; don't build it yet.

---

## 7. Recommended v1 architecture (the whole stack, assembled)

A collaboration space — call it a **"Pact"** (one project/repo/task/campaign + exactly two trusted devices + a shared encrypted store). Concretely:

1. **Identity** — each install generates a libsodium keypair on first run; public key = self-certifying device identity [19][20].
2. **Invite** — owner generates a one-time Magic-Wormhole-style pairing code; teammate pastes it; apps exchange & pin public keys to the Pact. No accounts [alternativeto.net][20].
3. **Transport** — a tiny self-hosted **WebSocket relay** (~$5/mo box) that matchmakes and passes **ciphertext only**, and holds messages when a Mac is asleep. Untrusted by design, exactly like Live Share's central service [9][10]. Later: add a WebRTC/Iroh direct fast-path as an upgrade [1][9].
4. **Encryption** — **libsodium `crypto_box`** between the two pinned keys; the relay never sees plaintext [E2EE/latacora]. (⚠️ no forward secrecy in v1 — acceptable, note it.)
5. **Shared notes/memory/knowledge** — a **Yjs** CRDT document synced over the relay via `y-websocket`, projected out to plain `.dobius/NOTES.md` + memory files (and watched back in via `chokidar`) so **both humans and agents read/write normal files** [4][7][24].
6. **Encrypted chat** — a chat panel scoped to the Pact, same `crypto_box` channel.
7. **Agent delegation** — A2A-inspired **task cards** over the encrypted channel, landing in the existing Tasks panel in **`pending-approval`; nothing runs until the receiving human approves** [17][18][10b].

**Why this shape:** every hard requirement is met by the smallest credible piece — async delivery (relay), concurrent-edit safety (Yjs), expert-approved crypto (libsodium), no-accounts pairing (self-certifying keys + wormhole code), and consent-gated delegation (A2A `auth-required` model) — and each piece has a shipped precedent (Live Share, Zed, Syncthing, Magic Wormhole, A2A). Nothing here is invented from scratch, which is the point.

---

## 8. Phased build plan

**Effort estimates are rough** (solo dev, calendar days of focused work), for sizing not committing.

### Phase 0 — Spike the relay + encrypted echo (2–3 days)
- Stand up the WebSocket relay ($5 VPS or a Cloudflare Worker + Durable Object).
- Two Dobius+ instances generate keypairs, exchange them via a pasted code, send one `crypto_box`-encrypted "hello" round-trip through the relay.
- **Done-bar:** the relay's logs show only ciphertext; both apps decrypt. Concrete libs: `ws` (relay), `libsodium-wrappers`.

### Phase 1 — The Pact + encrypted chat (3–5 days)
- Data model for a Pact (id, the two device keys, the bound project path) in Electron config.
- Invite flow UI: generate code / paste code / show "paired."
- Chat panel scoped to the Pact.
- **Done-bar:** two Macs pair with a code and chat end-to-end encrypted; killing/reopening either app resumes the Pact.

### Phase 2 — Shared notes/memory sync (4–6 days)
- Add Yjs (`yjs` + `y-websocket`) over the same relay.
- The file-projection adapter: Yjs ⇄ `.dobius/NOTES.md` + memory files, wired to the existing `chokidar` watcher.
- **Done-bar:** an edit (by a human *or* an agent) to shared notes on one Mac appears on the other within seconds; simultaneous edits merge without loss. Test the agent path explicitly — a Claude Code session writing `NOTES.md` must propagate.

### Phase 3 — Agent delegation with human approval (4–6 days)
- Task-card message type (A2A-inspired lifecycle).
- Receiving side: card lands in the Tasks panel as `pending-approval`; approve → spawn terminal/agent; reject → discard.
- **Done-bar:** my agent delegates a task; it does **nothing** on your machine until you approve; on approval it runs; the result flows back. Verify the never-auto-execute rule with a deliberate "reject" test.

### Phase 4 — Hardening (2–3 days)
- Relay-down handling, message queue/replay when a Mac was asleep, key-mismatch/tampering errors surfaced clearly, basic rate limits.
- **Done-bar:** close one Mac, send messages/tasks, reopen — everything arrives in order.

**v1 total: ~15–23 focused days.**

### v2 — Small team (2–10) — later, don't build yet
- Pact holds a **list** of device keys, not two.
- Graduate encryption from two-party `crypto_box` to **MLS/OpenMLS** for efficient group E2E.
- Roles/permissions (who can approve delegated tasks, who's read-only).
- Consider adding the **WebRTC/Iroh direct fast-path** for speed when peers are online.

---

## 9. Open questions to resolve before Phase 0
1. **Who hosts the relay, and where?** ($5 VPS vs Cloudflare Workers vs a box you already run.)
2. **Forward secrecy** — accept the v1 gap, or spend the extra effort now? (Recommend: accept, note it.)
3. **`automerge-repo` maturity** ⚠️ — not needed given the Yjs choice, but if version-history/branching of shared knowledge becomes a headline feature, re-check whether Automerge has shed its 2023 "not production-ready" caveat [1c].
4. **Verification gap** — the numbers marked ⚠️ (Iroh 95%, Yjs bundle 18–25 KB, adoption figures) are from single primary sources and weren't cross-checked; confirm any that a decision hinges on.

---

## Sources

Primary sources (official docs / specs / vendor engineering blogs) unless noted.

- [1] Iroh — "Comparing Iroh & libp2p" — https://www.iroh.computer/blog/comparing-iroh-and-libp2p
- [1a][1c] Automerge — "automerge-repo" announcement (Nov 2023) — https://automerge.org/blog/automerge-repo/
- [4] CRDT benchmarks (dmonad) — https://github.com/dmonad/crdt-benchmarks
- [5][21][23][24][25] "Yjs vs Automerge vs Loro: CRDT Libraries 2026" (blog) — https://www.pkgpulse.com/guides/yjs-vs-automerge-vs-loro-crdt-libraries-2026
- [6] Loro performance docs — https://loro.dev/docs/performance
- [7] Zed — "Introducing Channels for Collaboration" — https://zed.dev/blog/channels
- [8][10a] Zed — "CRDTs" — https://zed.dev/blog/crdts
- [9] VS Code Live Share — Connectivity reference — https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/connectivity
- [10][10b] VS Code Live Share — Security reference — https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/security
- [17][18] A2A Protocol Specification — https://a2a-protocol.org/latest/specification/
- [19][20] Syncthing — Device IDs (dev docs) — https://docs.syncthing.net/dev/device-ids.html
- MCP vs A2A vs Pilot (blog) — https://dev.to/pstayet/cross-network-agent-task-delegation-mcp-vs-a2a-vs-pilot-protocol-2a9a
- A2A overview (blog) — https://atlan.com/know/google-a2a-protocol/
- Magic Wormhole / Rymdport (listing) — https://alternativeto.net/software/rymdport/
- "Cryptographic Right Answers" — Latacora — https://www.latacora.com/blog/cryptographic-right-answers/
- Noise Protocol Framework — https://noiseprotocol.org/ _(fetched but not extracted before cutoff)_

_Sources fetched but cut off before claim extraction (credit limit): iroh.computer, tailscale.com, latacora.com, soatok.blog, letta.com, magic-wormhole.readthedocs.io, noiseprotocol.org. Their search-result snippets informed this report; their full contents were not mined._
