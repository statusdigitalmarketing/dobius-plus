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
| Tab names show raw paths and do not clean up; paths not recognized | Done (f1cf428): program paths never become tab names; tabs find claude, npm tools, Node, Git, Tailscale |
| Tab status dots do not work ("does not recognize a window") | Open (the hooks are POSIX shell; Windows needs its own) |
| "Add to Claude Desktop" said "not installed on this Mac" | Done: works on Windows (Store or %APPDATA% config, runs Dobius+.exe) |
| Auto-update needs Windows releases | Done (see email 1 #2) |
| Tailscale cross-Dobius communication with Max's PC | Open: link the two Dobius copies (Settings > Team) once his build has the Tailscale fix |
| Agents in Dobius tabs should know Dobius's commands; core settings on by default | Built, waiting on Codex review: agent-context.md via the SessionStart hook; status dots on once by default on the Mac (a choice to turn them off sticks) |

## From Max, email 5 (from mr.max.ii.llc@gmail.com, 2026-11-07 ~22:10 ET): patches 0009, 0010
Max now writes from mr.max.ii.llc@gmail.com (mschwarz@ is for insurance only).
| Fix | State |
|---|---|
| 0009 Voice Conductor hidden on Windows (`visibleBuiltinAgents`) | Applied as is |
| 0010 per-account gws shim on Windows (gws.cmd wrapper, Windows real-gws lookup, run.js under Electron) | Applied, adapted: a path with `%`, `"` or a line break gets no wrapper; the Mac path is unchanged |
| 0010 empty gws config dir for every token call on Windows (quota project) | Not taken: the existing per-account probe marks any account Google refuses the client's Cloud project for and runs it with no quota project, on both platforms (opening Settings > Google Accounts runs the probe) |

## From Max, status email (2026-11-07 22:25 ET): "waiting on Sam"
| Item | Answer |
|---|---|
| Windows port source + build config | Branch `feat/windows-max` on github.com/statusdigitalmarketing/dobius-plus (public); electron-builder.yml has the win/nsis config, .github/workflows/windows.yml builds it |
| Quota project on gmail-oauth-486517 (testers lack serviceusage.services.use) | Fixed in code (probe and mark, above). The alternative is granting testers Service Usage Consumer on that project, which needs Sam |
| Updater 404 (no latest.yml on v2.2.7) | Fixed from the next release on: CI attaches the Windows installer and latest.yml to every published release. Needs Sam's release word |

Note (2026-11-07, Mac): in a Dobius tab the login shell puts /opt/homebrew/bin ahead of the gws shim folder, so a bare
`gws` there is Homebrew's and ignores DOBIUS_GWS_ACCOUNT. The agent context names the shim by full path; the PATH order
itself is still open.

## From Max, email 6 (2026-11-07 23:11 ET): 3 patches on top of f1cf428 (not pushed)
| Patch | State |
|---|---|
| 0001 Windows UI: shortcuts work while the command bar has focus; Accounts, iMessage, Text to yourself, status dots and the Voice Conductor toggle hidden on Windows; Windows fonts; Ctrl+Shift / This PC wording | Applied as is (closes UI 1 and UI 3 from email 2). Accepted: on Windows the translated chords also fire inside a rename or text field; none of them can be typed text |
| 0002 gws shim on Windows | Not taken: same as the adapted 0010 already applied, which also refuses unsafe paths and keeps the Mac running a JS gws directly |
| 0003 Voice Conductor off the Windows agent lists (electron/visible-agents.js + tests) | Applied in place of 0009 (same behavior, testable module) |
| Accounts connected before the quota check fail until checked | Done: Dobius checks every account once, 30 s after launch |
| Local installer build fails without admin (winCodeSign 7z holds macOS symlinks) | CI is unaffected; documented for local builds: pre-extract winCodeSign-2.6.0 into the electron-builder cache |
