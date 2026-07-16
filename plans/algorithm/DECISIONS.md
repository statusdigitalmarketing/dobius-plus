# Algorithm Decision Log — Manager tab "operating layer" (2026-07-12)

Append-only. Each KILL records the future evidence that would justify re-adding it,
so the ~10% add-back rate is measurable. Grounding: two scout reports (committed
state at `dobius/src/main/manager/`, `dobius/src/main/ipc/manager.ts`,
`dobius/src/renderer/src/components/manager/`), branch `feat/manager-operating-layer`.

## Kills

| Date | Item | Why it died | Re-add trigger |
|---|---|---|---|
| 2026-07-12 | **Send email from the Manager tab** | Outward action on a real account; unverifiable automation surface; reading/searching mail plus opening Gmail in-app covers the workflow without the risk. | Read/search email ships, gets daily use, and replying in the embedded Gmail webview proves genuinely painful. |
| 2026-07-12 | **Provider write ops (move/rename/delete/share) in v1** | Destructive surface against live Drive; open-in-app webview gives the real Drive UI for writes at zero build cost. | A specific write action is performed via the webview 3+ times a week (count it) and round-tripping hurts. |
| 2026-07-12 | **Multiple accounts in v1** | Solo user has exactly one wired account (`manager.ts:16`); bridge Map already supports many, so this is UI+config work with zero users. Webview session partitions already solve multi-login for embedded pages. | A second real Google account needs indexing — then mirror `AccountsPane.tsx` and expose `unregisterSource` over IPC in the same task. |
| 2026-07-12 | **Microsoft 365 / other providers in v1** | Solo user is Google-only; `document-source.ts` seam makes later providers cheap by design. | A real M365 account with real documents enters the workflow. |
| 2026-07-12 | **Per-account refresh button in the UI** | With one account, `refreshAll` IS per-account refresh. The IPC (`manager:refreshAccount`) stays — it's built and harmless. | Ships with multi-account. |

## Add-backs / reversals (the ~10%, measured)

| Date | Original verdict | What live use proved | New state |
|---|---|---|---|
| 2026-07-12 | TASK-1: open docs in the in-app webview (KEEP, "highest reuse lever") | The embedded browser has its own cookie jar — every Google doc opened to a Sign-in wall (user screenshot). Session partitions solve multi-login only if the user logs in there, which is friction with zero payoff over the default browser. | REVERSED: rows open in the system default browser. In-app open returns only if a use case needs docs beside terminals badly enough to justify a one-time webview Google login. |
| 2026-07-12 | Drive source: flat, no folder resolution (ponytail deferral) | User needs folder structure to navigate ("folder 'Elderly people' → drop down → see the photos"). | ADDED BACK: parents field + folder names resolve in the same API call; Folders section in the rail; folders excluded as docs. This was the predicted ~10%. |

## Kills — round 2 (bundles feature, 2026-07-12)

| Date | Item | Why it died | Re-add trigger |
|---|---|---|---|
| 2026-07-12 | **Full-content extraction from Drive for clustering** | 598 per-file downloads/exports per refresh to improve grouping that name+path+snippet term math can prove first. | Bundles built from names/snippets feel shallow after 2 weeks of real use — then extract content for the top-N most-accessed docs only. |
| 2026-07-12 | **LLM / embedding-based clustering in v1** | API cost + latency + nondeterminism before the cheap deterministic version has ever been seen; the suggester's output is a UI suggestion, not a judgment call needing intelligence yet. | Term-math bundles are demonstrably wrong/noisy on real data AND the user wants semantic grouping (then: small local embedding or one Haiku classify pass, still suggestion-only). |

## Kills — round 3 (agent-memory arc, 2026-07-13)

| Date | Item | Why it died | Re-add trigger |
|---|---|---|---|
| 2026-07-13 | **Embeddings / RAG server for agent context** | The brief (TASK-7) is an assembly of indexed facts over a ~1k-doc corpus; SQL filter + truncation covers it. A vector store is infrastructure for a retrieval problem we don't have yet. | Corpus grows past what a filtered brief can hold AND agents demonstrably miss relevant filed items that semantic search would find. |
| 2026-07-13 | **Agents writing outputs back into the index (two-way memory)** | One-way (read) must prove valuable first; write-back adds provenance/trust questions (what did an agent file, was it right) before the read path has a single real use. | TASK-6/7 briefs are used by real sessions for 2+ weeks AND the user asks "why isn't the report the agent made in the Manager?" |
| 2026-07-13 | **Auto-injecting briefs into every project terminal at open** | Injection before demand: costs tokens in every session for projects whose briefs may be empty. The CLI/copy path (TASK-6/7/8) proves demand first. | Briefs get pulled manually 3+ times for the same project (rep counter can see the CLI calls). |

## Questioned / deferred (not killed)

| Date | Item | Status | Note |
|---|---|---|---|
| 2026-07-12 | **Manager vs Knowledge indexer convergence** | DEFERRED — decide before either grows another source | Two indexers now exist (Manager = cloud Drive via `manager/`, Knowledge = local files via `knowledge-indexer.ts`). Converging is an architecture task, not a v1 UI task. Do not add a third indexer anywhere before this is decided. |
| 2026-07-12 | **Disconnect-account UI (`unregisterSource` not exposed over IPC)** | DEFERRED | Real gap found by scout, but meaningless with one hardcoded account. Bundle with multi-account. |

## Not ready to automate (step-5 re-test candidates)

| Date | Candidate | Missing | Re-test when |
|---|---|---|---|
| 2026-07-12 | Scheduled background index refresh (auto-refresh every N min) | 0 evidence the manual Refresh button cadence is a pain; rep log too young to show anything (counter run 2026-07-12: no command ≥3 reps) | After 2 weeks of real Manager use, check the rep log / usage for refresh frequency. |
| 2026-07-12 | Any build-loop automation for this feature | Rep log 1 day old; nothing has 3 reps | Re-run `reps.py` at feature end (build-mode step 5). |
