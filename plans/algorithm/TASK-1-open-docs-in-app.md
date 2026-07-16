# TASK-1 — Open Manager documents inside the app (webview), not the external browser

**Verdict:** KEEP — the single highest reuse-per-effort move toward "operating layer".
This is the difference between a launcher and a workspace.

## What
Clicking a document row in the Manager tab opens it in Dobius+'s own embedded
browser (a webview tab/panel) instead of `shell.openUrl` kicking it to the
external default browser. A "open externally" affordance remains (e.g. small
icon / cmd-click).

## Why
Scout finding: the app already ships a full Chromium embed — the browser store
slice (`dobius/src/renderer/src/store/slices/browser.ts`: session profiles,
`sessionPartition`, cookie import, history) and the TV webview pattern
(`floating-tv/FloatingTvRoot.tsx:114-119`, `partition` + `allowpopups`, seed
apps already include Gmail). Reusing it turns every Drive doc (and later Gmail
thread) into an in-app surface with login state solved by session partitions.

## Concrete simplification chosen
Rung: **reuse what's in the codebase.** Do NOT build a new browser component.
Route the row's `webUrl` into the existing browser/webview machinery (whichever
entry point the browser slice exposes for opening a URL — follow how the TV or
embedded browser opens one today). Replace `ManagerDocumentRow.tsx:37`'s
`window.api.shell.openUrl(doc.webUrl)` as the row's primary action; keep
external-open as the secondary action.

## Acceptance test
- Click a Drive doc row → the document opens inside Dobius+ (webview surface),
  logged in (session partition holds Google auth after first login).
- Secondary action still opens the external browser.
- No new `<webview>` wrapper component was created (proves reuse).

## Estimate (rough — not measured)
~0.5–1 day, dominated by finding the right existing open-a-URL entry point.
