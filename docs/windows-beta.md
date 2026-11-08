# Windows beta: everything raised so far

Tracks every Windows report (Max's emails to sam@statusdigitalmarketing.com, Sam's own notes from Max's PC) and
where each stands. Branch: `feat/windows-max` (the Windows port, main's next release merged in, Max's fixes applied).
Update this file whenever a report comes in or an item moves.

## From Max, email 1 (v2.2.5, 2026-11-07 18:17 PT)
| # | Report | State |
|---|---|---|
| 1 | Add Google Account: generic "gws auth login failed", gws stderr dropped, nothing in error.log | Done: Setup checklist on Windows (gws under %APPDATA%\npm or gws.exe, client file or env client, %APPDATA%\gws legacy folder); Add off until ready; gws's own lines shown and logged |
| 2 | Auto-update 404 on every check; Updates page offers v2.2.7 | Done: releases get the Windows installer + latest.yml from CI (`release: published`); "no Windows build yet" is quiet. Needs a release from main with the Windows code to take effect |
| 3 | `history.jsonl` ENOENT warning every launch | Done |

## From Max, email 2 (fixes zip, 18:36 PT)
| Fix | State |
|---|---|
| 0001 tabs never linked to their Claude session (`procStart` FILETIME) | Applied |
| 0002 windows/tabs gone after closing the app | Applied |
| 0003 gws: say why sign-in cannot work | Superseded by the gws Setup work (same result) |
| 0004 Overview processes, Chrome profiles | Applied (+ Claude Desktop never listed, any install) |
| 0005 Tailscale CLI on Windows | Applied (history.jsonl part already done) |
| 0006 Launcher project names from transcript cwd | Applied (+ dot-encoded names) |
| 0007 scheduled-task titles in History | Applied |
| 0008 doc comment | Applied |
| UI 1 shortcuts dead while the command bar has focus | Open: redo in src (UI-EDITS.md) |
| UI 2 gws errors vanish after 8s; Claude Desktop card | Done (errors stay); Claude Desktop now works on Windows instead of hidden |
| UI 3 Mac-only settings and wording | Open: redo in src (UI-EDITS.md list) |

Still open from his README: Windows code signing (installer and updates are unsigned), Launcher click vs
double-click wording, History double-click also renaming, setup guide notes (PATH for `%USERPROFILE%\.local\bin`,
gws needs an OAuth client).

## From Max, email 3 (18:48 PT)
Asks for the Windows source with history and the Windows build config. Answer: branch `feat/windows-max` on
github.com/statusdigitalmarketing/dobius-plus (electron-builder.yml has the win/nsis settings; the Windows CI build is
.github/workflows/windows.yml).

## From Max, email 4 (18:48 PT): SSH to "workmachine" over Tailscale
Accepted for Dobius debugging only. Sam's Mac public key sent.

## From Sam on Max's PC (2026-11-07)
| Report | State |
|---|---|
| Tab names show raw paths and do not clean up; paths not recognized | Open (shared/tab-label.js only knows POSIX paths and shells) |
| Tab status dots do not work ("does not recognize a window") | Open (the hooks are POSIX shell; Windows needs its own) |
| "Add to Claude Desktop" said "not installed on this Mac" | Done: works on Windows (Store or %APPDATA% config, runs Dobius+.exe) |
| Auto-update needs Windows releases | Done (see email 1 #2) |
| Tailscale cross-Dobius communication with Max's PC | Open: link the two Dobius copies (Settings > Team) once his build has the Tailscale fix |
| Agents in Dobius tabs should know Dobius's commands; core settings on by default | Open |
