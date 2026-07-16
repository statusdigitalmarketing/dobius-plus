# TASK-2 — Gmail as a second DocumentSource (read/search only)

**Verdict:** KEEP (SIMPLIFIED from "manage emails") — unified search across Drive +
Gmail is the operating-layer feel; sending stays out (see DECISIONS.md).

## What
A `GmailSource implements DocumentSource` that lists/searches the account's
Gmail threads (subject, from, date, snippet, thread webUrl) into the same
manager index, provider `gmail`. The Manager search box then searches Drive
files AND mail in one place; a Gmail row opens the thread (in-app via TASK-1).

## Why
Scout finding: the OAuth token the Manager already reads
(`google-workspace-credentials.ts`, `~/.google_workspace_mcp/credentials/`) is
the Google Workspace MCP's own store, whose tool surface includes Gmail — the
scopes are almost certainly already granted (UNVERIFIED until the first API
call; if the token lacks Gmail scope, the source must fail soft exactly like
`registerSourceSafely` does today). No new integration, no new auth flow.

## Concrete simplification chosen
Rung: **reuse what's in the codebase.** Mirror `google-workspace-source.ts`
verbatim: same pluggable token-getter + pluggable lister (so mapping is
testable without network, same as the Drive source), same retry-once-on-401.
Endpoint: `gmail.googleapis.com/gmail/v1/users/me/threads` (list, paged, cap
~500 like Drive's 1000). Map thread → `SourceDocument` (externalId = threadId,
name = subject, path = from, webUrl = `https://mail.google.com/mail/u/0/#inbox/<id>`).
READ ONLY — no send, no modify, no labels. Register in `ipc/manager.ts` next to
the Drive source under the same account email.

## Acceptance test
- Vitest: thread→SourceDocument mapping with a fake lister (no network), same
  pattern as the existing Drive source tests.
- Live: refreshAll indexes real threads; searching a known subject in the
  Manager box returns the thread; missing Gmail scope degrades to an error
  banner for that source only (Drive keeps working).

## Estimate (rough — not measured)
~1 day including tests.
