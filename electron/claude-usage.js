// How much of each account's quota is gone, as last REPORTED by a live session.
//
// Sam runs six or seven Claude logins and wanted to know when one is close to
// its limit. Claude Code hands its statusLine command a JSON payload that
// carries the real numbers:
//   rate_limits: { five_hour: { used_percentage, resets_at },
//                  seven_day: { used_percentage, resets_at } }
// Verified live on 2.1.274. The window names are NOT fixed: the binary also
// carries seven_day_opus, seven_day_sonnet and seven_day_cowork, so this treats
// rate_limits as an open map and never as two known fields.
//
// THE THING THAT SHAPES THIS WHOLE MODULE: the payload contains no measurement
// timestamp, and Claude re-renders a status line for reasons that have nothing
// to do with an API call. A session can therefore republish a half-hour-old
// cached reading that looks brand new. So there is no honest way to call any of
// this "current usage". It is LAST REPORTED usage, it carries the age of the
// report, and a window is dropped at its own resets_at rather than being shown
// as zero on no evidence. An account with no live reporting session has unknown
// usage, which is stated rather than implied by an empty bar.

import fs from 'node:fs/promises';
import path from 'node:path';
import { keychainServiceFor, defaultClaudeDir } from './account-identity.js';

// Bumped when the on-disk record format changes, so a stale reporter left by an
// older build is ignored rather than misparsed.
const FORMAT = 'DOBIUS1';

// The marker that identifies OUR statusLine command inside a settings file, the
// same way the status hooks are identified. It has to survive the user editing
// the surrounding value, so it lives in the command string itself.
export const REPORTER_MARKER = 'dobius-usage-reporter';

/** POSIX single-quote a string for a /bin/sh command line. */
export const shQuote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

/**
 * The statusLine value is a SHELL COMMAND, not an argv array, so the path has
 * to be quoted. userData on macOS is under "Library/Application Support", so an
 * unquoted path splits at the space and every render fails before the reporter
 * even starts, taking the user's own status line down with it (reviewer HIGH).
 */
export const reporterCommand = (userDataDir) => shQuote(reporterScriptPath(userDataDir));

export const usageDirPath = (userDataDir) => path.join(userDataDir, 'usage');
export const reporterScriptPath = (userDataDir) => path.join(userDataDir, `${REPORTER_MARKER}.sh`);

/**
 * The reporter, generated with its paths BAKED IN rather than read from the
 * environment.
 *
 * Baked in because a session started outside Dobius (another terminal, a
 * detached process, a second Dobius) inherits none of Dobius's environment but
 * does read the shared settings.json. Reading the paths from env would silently
 * report nothing for exactly the sessions hardest to account for.
 *
 * Runs on EVERY status line render, of which there are many across many
 * sessions, so it does no PARSING in a subprocess: no jq, no date, no hash
 * utility. Extracting the session id and the binding is pure shell expansion.
 * Two cheap helpers remain per render, `cat` to slurp stdin and `mv` to publish
 * by rename, because POSIX sh has no builtin that slurps stdin safely and the
 * rename is what makes a half-written record unreadable-by-construction.
 * The receipt time is the file's own mtime, so no `date` call is needed.
 *
 * `chain` is the user's own statusLine command, which must keep working. Its
 * stdin is replayed because this script has already consumed it, and its stdout
 * is passed through untouched so the line renders exactly as it did before.
 */
export function reporterScript(usageDir, chainCommand) {
  const q = shQuote;
  const chain = chainCommand
    ? `printf '%s' "$payload" | exec /bin/sh -c ${q(chainCommand)}\n`
    : '';
  return `#!/bin/sh
# ${REPORTER_MARKER}: written by Dobius+. Reports Claude usage per session.
# Safe to delete. Disabling "Account usage" in Dobius Settings removes it and
# restores whatever statusLine was here before.
payload=$(cat)
d=${q(usageDir)}
rest=\${payload#*\\"session_id\\":\\"}
if [ "$rest" != "$payload" ]; then
  sid=\${rest%%\\"*}
  # The payload is DATA. A crafted session_id must never steer the write out of
  # the usage directory, so anything but a plain id is refused.
  case "$sid" in
    *[!A-Za-z0-9_-]*|'') sid= ;;
  esac
  if [ -n "$sid" ]; then
    # Unset and empty are DIFFERENT bindings: unset means the CLI default and
    # the home-level metadata file, so the distinction is recorded, not guessed.
    s=0
    [ -n "\${CLAUDE_CONFIG_DIR+x}" ] && s=1
    t="$d/.tmp.$sid.$$"
    # Write to a unique temp file then rename: a reader must never catch a
    # record mid-write, and a shared temp name would just move the collision.
    if printf '${FORMAT} %s\\n%s\\n%s' "$s" "\${CLAUDE_CONFIG_DIR-}" "$payload" > "$t" 2>/dev/null; then
      mv -f "$t" "$d/$sid.json" 2>/dev/null || rm -f "$t" 2>/dev/null
    else
      rm -f "$t" 2>/dev/null
    fi
  fi
fi
${chain}exit 0
`;
}

/**
 * Parse one record file.
 *
 * Line 1 is the format marker and whether CLAUDE_CONFIG_DIR was SET. Line 2 is
 * its raw value. Everything after is the payload verbatim. Deliberately not a
 * JSON envelope: embedding a pathname into JSON from a shell script means
 * escaping it correctly in shell, and getting that subtly wrong is how a
 * reader ends up trusting a mangled path.
 */
export function parseRecord(text, receivedAtMs) {
  if (typeof text !== 'string') return null;
  const firstNl = text.indexOf('\n');
  if (firstNl < 0) return null;
  const header = text.slice(0, firstNl).split(' ');
  if (header[0] !== FORMAT) return null;
  const secondNl = text.indexOf('\n', firstNl + 1);
  if (secondNl < 0) return null;
  const bindingSet = header[1] === '1';
  const configDir = text.slice(firstNl + 1, secondNl);

  let payload;
  try { payload = JSON.parse(text.slice(secondNl + 1)); } catch { return null; }
  if (!payload || typeof payload !== 'object') return null;

  // A relative binding is resolved by the CLI against ITS OWN working
  // directory, which we cannot read. Naming a credential from it would repeat
  // the mistake the process scanner already refuses to make.
  const usable = !bindingSet || configDir.startsWith('/');
  const dir = bindingSet ? configDir : defaultClaudeDir();
  let key = null;
  if (usable) {
    try { key = keychainServiceFor(dir); } catch { key = null; }
  }

  return {
    sessionId: typeof payload.session_id === 'string' ? payload.session_id : null,
    key,
    configDir: usable ? dir : configDir,
    envUnset: !bindingSet,
    unresolvedBinding: !usable,
    // Absent until the session's FIRST API call. Absent is unknown, never zero.
    windows: normalizeWindows(payload.rate_limits),
    receivedAt: receivedAtMs,
  };
}

/** rate_limits as an open map, keeping only entries that carry a real number. */
function normalizeWindows(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [name, v] of Object.entries(raw)) {
    if (!v || typeof v !== 'object') continue;
    const pct = v.used_percentage;
    if (typeof pct !== 'number' || !Number.isFinite(pct)) continue;
    const resets = typeof v.resets_at === 'number' && Number.isFinite(v.resets_at)
      ? v.resets_at : null;
    out[name] = { usedPercentage: Math.max(0, Math.min(100, pct)), resetsAt: resets };
  }
  return Object.keys(out).length ? out : null;
}

/** Every record currently on disk, newest receipt first. Never throws. */
export async function readUsageRecords(userDataDir) {
  const dir = usageDirPath(userDataDir);
  let names;
  try { names = await fs.readdir(dir); } catch { return []; }
  const out = [];
  await Promise.all(names.map(async (name) => {
    if (!name.endsWith('.json') || name.startsWith('.')) return; // .tmp.* is mid-write
    const file = path.join(dir, name);
    let fh;
    try {
      // ONE open, then stat and read through that handle. A separate
      // readFile + stat pair can straddle the publisher's rename and pair an
      // OLD payload with the NEW file's mtime, which would make a stale
      // reading look like it arrived a moment ago (reviewer HIGH).
      fh = await fs.open(file, 'r');
      const st = await fh.stat();
      const text = await fh.readFile('utf8');
      const rec = parseRecord(text, st.mtimeMs);
      if (rec) out.push(rec);
    } catch { /* vanished or unreadable: it simply does not contribute */ }
    finally { await fh?.close().catch(() => {}); }
  }));
  return out.sort((a, b) => b.receivedAt - a.receivedAt);
}

/**
 * Fold records into one reading per CREDENTIAL.
 *
 * The rule is NEWEST RECEIPT, and nothing else.
 *
 * An earlier version preferred a reading from a still-running session over one
 * from an exited session. That precedence cannot be fed honestly: a record
 * names a session id, the process scan names pids, and nothing links the two.
 * Judging liveness at the CREDENTIAL level instead does not rescue it, because
 * knowing that some session on this credential is alive says nothing about
 * which session produced the reading that won (reviewer HIGH). Claiming that
 * distinction while being unable to compute it is precisely the confident wrong
 * answer this project keeps paying for, so it is gone.
 *
 * What remains is defensible: this is the most recent report anyone made, and
 * its age travels with it. Highest-percentage was also rejected, because it
 * preserves an obsolete reading forever, including across an account change on
 * the directory.
 */
export function aggregateUsage(records, { now = Date.now() } = {}) {
  const byKey = new Map();
  for (const r of records) {
    if (!r.key || !r.windows) continue;
    const prev = byKey.get(r.key);
    if (prev && prev.receivedAt >= r.receivedAt) continue;
    byKey.set(r.key, {
      key: r.key,
      configDir: r.configDir,
      envUnset: r.envUnset,
      sessionId: r.sessionId,
      receivedAt: r.receivedAt,
      windows: r.windows,
    });
  }

  const out = [];
  for (const g of byKey.values()) {
    // A window past its own reset tells you nothing about the new window, and
    // showing 0% there would invent a measurement nobody made.
    const windows = {};
    for (const [name, w] of Object.entries(g.windows)) {
      if (w.resetsAt !== null && w.resetsAt * 1000 <= now) continue;
      windows[name] = w;
    }
    if (!Object.keys(windows).length) continue;
    out.push({ ...g, windows, ageMs: Math.max(0, now - g.receivedAt) });
  }
  return out;
}

/** Is this settings value OUR reporter? Judged by the command, not the shape. */
export function ownsStatusLine(statusLine) {
  return !!(statusLine && typeof statusLine === 'object'
    && typeof statusLine.command === 'string'
    && statusLine.command.includes(REPORTER_MARKER));
}

/**
 * What settings.statusLine should become, and what to remember so it can be
 * put back.
 *
 * statusLine is a SINGLE value, unlike hooks which are arrays we can append to,
 * so installing is a replacement and a careless one destroys whatever the user
 * had. Three things have to be right:
 *
 *  - CHAINING. Their command still runs and its stdout is still the status
 *    line. The reporter replays the stdin it consumed, because a command handed
 *    an EOF prints nothing and their line would just vanish.
 *  - NO RECURSION. Installing twice must not wrap our own wrapper, which would
 *    make the script call itself. If we already own the value, the remembered
 *    original stays exactly as it was.
 *  - ABSENCE IS A VALUE. If there was no statusLine at all, that is what has to
 *    be restored, not an empty object.
 *
 * Non-command options (padding, and whatever Claude adds later) are carried
 * across so wrapping does not quietly drop them.
 *
 * @returns {{statusLine: object, remember: {present: boolean, value: any}|null}}
 *   `remember` is null when we already own it, meaning keep what is stored.
 */
export function planStatusLineInstall(current, command, chainOverride = null) {
  if (ownsStatusLine(current)) {
    return {
      statusLine: { ...current, type: 'command', command },
      remember: null,
    };
  }
  const present = !!(current && typeof current === 'object');
  const chain = chainOverride !== null
    ? chainOverride
    : (present && typeof current.command === 'string' && current.command.trim()
      ? current.command
      : null);
  const carried = present ? { ...current } : {};
  delete carried.command;
  delete carried.type;
  return {
    statusLine: { ...carried, type: 'command', command },
    remember: { present, value: present ? current : null, chain },
  };
}

/**
 * What settings.statusLine should become on uninstall.
 *
 * Only ever touches a value we still own. If the user has since pointed
 * statusLine somewhere else, theirs stands and the stored original is dropped:
 * blindly restoring it would delete the newer choice they made deliberately.
 *
 * @returns {{action: 'restore'|'delete'|'leave', statusLine?: any}}
 */
export function planStatusLineRemove(current, remembered) {
  if (!ownsStatusLine(current)) return { action: 'leave' };
  if (remembered && remembered.present && remembered.value) {
    // Keep any non-command options the user edited while we were wrapping.
    const kept = { ...current };
    delete kept.command;
    delete kept.type;
    return { action: 'restore', statusLine: { ...kept, ...remembered.value } };
  }
  return { action: 'delete' };
}
