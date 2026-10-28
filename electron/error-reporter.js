// Error and crash reports filed as GitHub issues (v1.0.84). Sam (10/28):
// "crash reports and error reports should also go to github so that we can
// resolve all of them".
//
// Sources:
// - every entry error-log.js writes that is a fault (not warnings, not the
//   startup line), via setLogSink;
// - native crashes, which kill the process before any JS runs: macOS writes
//   them to ~/Library/Logs/DiagnosticReports/Dobius+*.ips, read on the next
//   launch.
//
// Each distinct fault is ONE issue, found again by a `dobius-report: <sig>`
// marker in its body, so repeats (on any Mac) add a comment instead of a new
// issue. Filing goes through the `gh` CLI under the Mac's OWN login. No token
// ships in the app (it is public, a bundled token would be anyone's). A Mac
// whose gh login cannot see the private reports repo files nothing, so a
// stranger's errors never leave their machine.
//
// Sent text is scrubbed (home paths, emails, token-shaped strings) and capped;
// the error log already excludes terminal output and transcripts.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFile, execFileSync } from 'child_process';

export const REPORTS_REPO = 'statusdigitalmarketing/dobius-plus-reports';
const FIRST_FLUSH_MS = 90_000;
const FLUSH_EVERY_MS = 30 * 60_000;
const RESEND_AFTER_MS = 6 * 3600_000; // one comment per fault per 6h per Mac
const NEW_ISSUES_PER_DAY = 20;        // per Mac: an error storm cannot flood the repo
const MAX_SIGS = 200;
const SAMPLE_CHARS = 3000;
const CRASH_LOOKBACK_MS = 14 * 86400_000;
const GH_TIMEOUT_MS = 30_000;
// Every regex below runs on at most this much text: a renderer can log a
// 100KB line, and an unanchored pattern over it stalls the main process.
const SCAN_CHARS = 8000;
const IPS_SETTLE_MS = 10 * 60_000;
const MAX_GH_FAILURES = 3; // in a row: GitHub is down or rate limiting, back off

// Log kinds that are not faults, or that another kind already reports:
// crash.render-process-gone / crash.child-process-gone duplicate
// renderer.gone / child.gone (both handlers log the same event).
// main.stall-watchdog is the watchdog's own status (armed, clock jumped over a
// sleep), not a stall; main.stall is the real one.
// guest.* is a <webview> pane's third-party page (error-log.js): never ours.
const SKIP_KIND = /^(app|error-log|main\.warn|main\.stall-watchdog|crash\.render-process-gone|crash\.child-process-gone|guest\..*)$/;

/** Pure: should this log entry be reported? */
export function isReportable(kind, detail) {
  const k = String(kind || '');
  if (!k || SKIP_KIND.test(k)) return false;
  // A child that exited cleanly or that we killed is not a fault.
  if (k === 'child.gone' && /reason=(clean-exit|killed)\b/.test(String(detail))) return false;
  return true;
}

// Any letter or digit in any script: 'L'Étoile' has its apostrophe inside a
// word just like 'O'Brien' (Codex).
const WORD_CHAR = /[\p{L}\p{N}_]/u;
/** `/a/b/c.js:10` -> `…/c.js:10`, `~/a/b.txt` -> `~/…/b.txt`: only the file
 * name. A query or fragment goes too: cutting at a slash INSIDE it would strand
 * a secret's tail without its key (`/v1?token=abc/secret`, Codex). */
function reducePath(p) {
  p = p.split(/[?#]/)[0];
  const last = p.lastIndexOf('/');
  if (last <= 0 || (p.startsWith('~') && last === 1)) return p;
  return `${p.startsWith('~') ? '~/' : ''}…/${p.slice(last + 1)}`;
}

/**
 * Quoted text is user data (JSON parse errors quote the raw input, services
 * quote names), so only its length survives.
 *
 * Quotes are not paired: V8 copies raw input, quotes and backslashes and all,
 * into its messages, and every pairing heuristic (nearest, escape-aware,
 * close-before-non-word, last-on-line, per-line counts, one pass per kind)
 * was broken by some input (Codex, rounds 3 to 13). Instead:
 * 1. A single-quoted code word (`(reading 'id')` names the bug) or path (kept
 *    as its file name) is set aside first.
 * 2. Every other quote character counts: " and ` always, ' unless it sits
 *    between two letters (an apostrophe: don't, O'Brien).
 * 3. Everything from the first counted quote to the last is ONE redacted
 *    span, or to the end when the count is odd or the cap truncated the text.
 * 4. A set-aside token survives only if it was outside that span.
 * So nothing between any two quote characters can survive. Over-redacting is
 * the safe direction; stack frames rarely hold quotes.
 */
const KEPT = /(?<![\p{L}\p{N}_])'(?:([A-Za-z_$][\w$.:-]{0,40})|((?:~|\.{0,2})\/[^'\n]{0,500}))'(?![\p{L}\p{N}_])/gu;
const isQuoteAt = (s, k) => {
  const c = s[k];
  return c === '"' || c === '`' || (c === "'" && !(WORD_CHAR.test(s[k - 1] || '') && WORD_CHAR.test(s[k + 1] || '')));
};
function redactQuotes(s, truncated = false) {
  const kept = [];
  const masked = s.replace(KEPT, (m, word, p) => {
    kept.push(word ? `'${word}'` : `'${reducePath(p)}'`);
    return `\u0001${kept.length - 1}\u0002`;
  });
  // Code words and paths are kept only when they are the ONLY quotes: next to
  // any other quote they could be the edge of a value (`'x' Client Orion''`,
  // Codex), so then every quote counts.
  let others = 0;
  for (let k = 0; k < masked.length; k += 1) if (isQuoteAt(masked, k)) others += 1;
  if (others) kept.length = 0;
  s = others ? s : masked;
  const at = [];
  for (let k = 0; k < s.length; k += 1) if (isQuoteAt(s, k)) at.push(k);
  if (at.length) {
    const first = at[0];
    const last = at[at.length - 1];
    s = truncated || at.length % 2 === 1
      ? `${s.slice(0, first)}${s[first]}[…]`
      : `${s.slice(0, first)}${s[first]}[${last - first - 1} chars]${s[last]}${s.slice(last + 1)}`;
  }
  return s.replace(/\u0001(\d+)\u0002/g, (m, n) => kept[Number(n)] ?? '');
}

/**
 * Pure: strip what identifies the machine, its owner or their data, then cap.
 * Order matters: quoted values (see redactQuotes), then SECRETS while their
 * context ("?token=", "Bearer", "user:pass@") is still intact, then paths:
 * every absolute path, file:// URL and home path keeps only its file name,
 * because folders are client and project names. A path cut at its last slash
 * before the secret pass could strand a secret's tail without its key, and a
 * secret pass before the quotes could swallow a closing quote (Codex).
 * ACCEPTED (Codex, round 2): a file name, and a quoted single code-like word
 * (or several, when they are the only quotes), can still be a project or
 * customer name. Reports only reach a repo the
 * filing Mac's own gh login can see, i.e. the same org's private repo, and
 * without file names a report cannot be debugged.
 */
export function scrub(text, home = os.homedir()) {
  // Control characters (a NUL in a logged value) cannot even be passed to gh.
  const truncated = String(text ?? '').length > SCAN_CHARS;
  let s = String(text ?? '').slice(0, SCAN_CHARS).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  // Named credentials first, while a quoted key (`{"password":123456}`) is
  // still readable; the value may start with anything, `[` included (Codex).
  s = s
    // A cookie header is credentials to the end of its line. Everything but
    // its quote characters goes, BEFORE the quote pass: the quotes stay where
    // they were, so that pass's span cannot move, and the header cannot be
    // swallowed by it first (Codex, rounds 15 to 17).
    // (A word-internal apostrophe, O'Brien, is not a quote: it goes too, or it
    // would sit between placeholders and start counting as one.)
    .replace(/\b((?:set-)?cookie\s*:\s*)([^\n]+)/gi, (m, head, value) => head + value.replace(/(?<=[\p{L}\p{N}_])'(?=[\p{L}\p{N}_])/gu, '').replace(/[^"'`]+/g, '[redacted]'))
    // URL credentials likewise, before the quote pass and keeping its quote
    // characters, so a quote inside a password cannot hide the '@' (Codex).
    .replace(/\b([a-z][\w+.-]{0,20}:\/\/)([^\s/@]{1,256})@/gi, (m, scheme, info) => `${scheme}${info.replace(/(?<=[\p{L}\p{N}_])'(?=[\p{L}\p{N}_])/gu, '').replace(/[^"'`]+/g, '[credentials]')}@`)
    // Any key ENDING in a credential word (access_token, refresh_token,
    // x-api-key) and any value, punctuation included (`#Hunter2!`).
    // No prefix quantifier at all: the credential word is found wherever it
    // ends a key, however long the key (SPRING_..._PASSWORD=, Codex).
    .replace(/((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|session(?:[_-]?id)?|sid|cookie|auth)['"`]?\s*[=:]\s*['"`]?)(?:[^\s"'`]|(?<=[\p{L}\p{N}_])'(?=[\p{L}\p{N}_]))*[^\s"'`)\]},;]/giu, '$1[redacted]');
  // Home and user paths only AFTER the credentials: a user-name rule that may
  // span spaces would otherwise eat `/Users/sam password` and strand the
  // value (Codex).
  // The home dir only as a whole path component, never inside a longer word
  // or URL (`/h` must not touch `https://hooks...`).
  if (home && home.length > 1) s = s.replace(new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=/)`, 'g'), '~');
  // A user name never contains ? # & = : stopping there keeps a URL's
  // "?token=" context intact for the secret pass below (Codex).
  // ...and may contain spaces (`/Users/sam Archive/...`): up to the next slash.
  s = s.replace(/file:\/\/(?=\/)/gi, '').replace(/\/Users\/[^/\n'"`)?#&=:]+/g, '~');

  // Then quoted values: a secret pattern run earlier could swallow a quote.
  s = redactQuotes(s, truncated);
  s = s
    .replace(/\b([a-z][\w+.-]{0,20}:\/\/)[^\s/@"`]{1,256}@/gi, '$1[credentials]@')
    .replace(/\b(sk-|ghp_|gho_|ghs_|github_pat_|xox[abpr]-)[\w-]+/g, '[token]')
    // Webhook URLs ARE the secret, with no recognisable prefix in them.
    .replace(/(hooks\.slack\.com\/(?:services|workflows|triggers)\/)[^\s"`]+/gi, '$1[redacted]')
    .replace(/(discord(?:app)?\.com\/api\/webhooks\/)[^\s"`]+/gi, '$1[redacted]')
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, '$1 [token]')
    .replace(/([?&#;][\w-]*(token|key|secret|password|passwd|auth|sig|code|session)[\w-]*=)[^&#\s"`]+/gi, '$1[redacted]')
    .replace(/[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){1,6}/gu, '[email]')
    // Long letter+digit runs are keys, tokens and ids; a long name with no
    // digits is left alone.
    .replace(/[A-Za-z0-9+_-]{32,}={0,2}/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? '[redacted]' : m));
  // Then paths, AFTER the secrets (cutting a path at its last slash can strand
  // a secret's tail without its key). A path's end is unknowable in free text
  // ("Projects (Code)/Blue Atlas/x.js"): drop everything up to the LAST slash
  // on the line. Quoted values are already gone, so an apostrophe left here is
  // part of a name ("O'Brien"). Over-redacting is the safe direction.
  // A path also ends at ": " (what follows is an error, `EACCES: ...`), so two
  // different failures between two paths are not merged into one (Codex).
  s = s.replace(/~\/(?:(?!: )[^\n"`])*\//g, '~/…/')
    .replace(/(^|[^\w/:.~])\.{1,2}\/(?:(?!: )[^\n"`])*\//gm, '$1…/') // ./x/y, ../x/y
    .replace(/(^|[^\w/:.~])\/(?=[^\s/])(?:(?!: )[^\n"`])*\//gm, '$1…/');
  return s.slice(0, SAMPLE_CHARS);
}

/**
 * Pure: the stable shape of a message, so the same fault on another version,
 * another Mac or another file gets one signature. Drops numbers, ids, quoted
 * values, directories and bundle hashes (index-AbC123.js -> index.js).
 */
export function normalizeMessage(text) {
  return String(text ?? '').slice(0, SCAN_CHARS)
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z?/g, 'T')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'U')
    // Any path form (file://, ~/, …/, /abs) down to its file name, so the
    // same fault from another install location or user is one signature.
    .replace(/(?:file:\/\/)?(?:~|…)?(?:\/[^/\s:()'"]+)*\/([^/\s:()'"]+)/g, '$1')
    // A vite bundle hash: exactly 8 base64url chars with a capital or digit
    // (`index-BQa-CPvz.js`), never a word (`codex-account-env.js`).
    .replace(/-(?=[\w-]{0,7}[A-Z0-9])[A-Za-z0-9_-]{8}(\.m?js)/g, '$1')
    // Everything from a line's first quote to its last is one token: how many
    // values were quoted, kept ('id') or redacted, is data, never part of
    // what the fault is (Codex).
    .replace(/["'`]\[…\]/g, 'Q') // an unclosed value runs to the end
    .replace(/(?<=[\p{L}\p{N}_])'(?=[\p{L}\p{N}_])/gu, '') // can't is a word, not a quote
    // Per line, first quote to last by index (a regex `["'`].*["'`]` is
    // quadratic on a line full of quotes).
    .split('\n').map((line) => {
      const a = line.search(/["'`]/);
      if (a < 0) return line;
      const b = Math.max(line.lastIndexOf('"'), line.lastIndexOf("'"), line.lastIndexOf('`'));
      return b > a ? `${line.slice(0, a)}Q${line.slice(b + 1)}` : line;
    }).join('\n')
    // A window's random id inside a tab id (term-<path>~w-abcdefgh-1).
    .replace(/\bw-[A-Za-z0-9]{8}\b/g, 'w-W')
    .replace(/0x[0-9a-f]+/gi, '0x')
    // An HTTP status is the fault (401 is not 500): keep it.
    .replace(/\b(HTTP|status|code)(\s*:?\s*)([1-5]\d\d)\b/gi, '$1$2S$3')
    .replace(/\b[0-9a-f]{12,}\b/gi, 'H')
    .replace(/(?<!S[1-5]?\d?)\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pure: the first line plus the first stack frame, normalized. */
function headOf(detail) {
  const lines = String(detail ?? '').slice(0, SCAN_CHARS).split('\n').map((l) => l.trim()).filter(Boolean);
  const first = lines[0] || '';
  // A real V8 frame (`at fn (file:1:2)` or `at file:1:2`), not quoted text
  // that happens to start with "at" (Codex). ACCEPTED: frame-shaped text inside
  // quoted data can still be picked, and a project name inside a logged path
  // can split one failure per project; both only affect grouping, nothing
  // leaks, and the daily cap still holds.
  const frame = lines.find((l, i) => i > 0 && /^at (?:[^()\n]{1,300} \([^\n]{1,500}:\d+:\d+\)|\S{1,500}:\d+:\d+)$/.test(l)) || '';
  return { first, frame };
}

/** Pure: 12-hex signature of a fault. */
export function signatureFor(kind, detail) {
  // Signed AFTER scrubbing, so two messages that differ only in a secret or
  // a quoted value (which the report hides anyway) are one fault. A terminal
  // id names its project (term-<path>-1, the path may hold spaces and inner
  // "-1" segments): it is collapsed on the RAW text, up to its last -N before
  // a colon, before scrubbing could cut it (Codex).
  const raw = String(detail ?? '').slice(0, SCAN_CHARS * 2).replace(/\bterm-[^\n:]{0,2000}-\d+/g, 'term-T');
  // The first stack frame comes from the RAW text: it is only hashed, never
  // sent, and quote redaction could otherwise swallow it for one variant of a
  // message and not another (Codex).
  const { first } = headOf(scrub(raw));
  const { frame } = headOf(raw);
  // Its paths still go through scrubbing (on that one line), so a client
  // folder with spaces in it cannot split one fault (Codex).
  const basis = `${kind}\n${normalizeMessage(first)}\n${normalizeMessage(scrub(frame))}`;
  return crypto.createHash('sha1').update(basis).digest('hex').slice(0, 12);
}

/** Pure: issue title, e.g. "[crash] crash.native: EXC_CRASH SIGABRT ...". */
export function issueTitle(kind, detail) {
  const tag = /^crash\./.test(kind) || kind === 'renderer.gone' ? 'crash' : 'error';
  // Scrub the WHOLE detail, then take its first line: scrubbing only a cut
  // prefix would miss that the cap truncated a quoted value (Codex).
  const first = headOf(scrub(detail)).first.replace(/\s+/g, ' ');
  // No @mentions or #refs from logged text into a title (zero-width break).
  const t = `[${tag}] ${kind}: ${first.replace(/([@#])(?=\w)/g, '$1\u200b')}`;
  return t.length > 120 ? `${t.slice(0, 117)}...` : t;
}

const SYSTEM_IMAGE = /^(libsystem_[\w.]+|libc\+\+abi\.dylib|libc\+\+\.1\.dylib|libobjc\.A\.dylib|libdyld\.dylib|dyld)$/;

/**
 * Pure: one native crash report (.ips text) as { kind, detail, sig }, or null
 * when it is not ours or will not parse. The .ips format is a JSON header
 * line followed by a JSON body.
 */
export function parseIps(text) {
  try {
    const nl = String(text).indexOf('\n');
    if (nl < 0) return null;
    const head = JSON.parse(text.slice(0, nl));
    const body = JSON.parse(text.slice(nl + 1));
    if (!String(head.bundleID || '').startsWith('com.statusdigital.dobius-plus')) return null;
    const imgs = Array.isArray(body.usedImages) ? body.usedImages : [];
    const thread = Array.isArray(body.threads) ? body.threads[body.faultingThread] : null;
    const frames = (thread && Array.isArray(thread.frames) ? thread.frames : []).slice(0, 30).map((f) => {
      const img = imgs[f?.imageIndex]?.name || '?';
      // Without a symbol the offset is what tells two functions apart.
      const sym = typeof f?.symbol === 'string' ? f.symbol
        : Number.isFinite(f?.imageOffset) ? `+0x${f.imageOffset.toString(16)}` : '';
      return { img, sym };
    });
    const ex = body.exception || {};
    const term = body.termination || {};
    const proc = body.procName || head.name || 'Dobius+';
    const first = `${proc} ${ex.type || '?'} ${ex.signal || ''} ${term.indicator || ''}`.replace(/\s+/g, ' ').trim();
    const detail = [
      first,
      `version ${head.app_version || '?'} | ${head.os_version || '?'} | ${body.cpuType || '?'}${body.translated ? ' (Rosetta)' : ''} | ${head.timestamp || ''}`,
      ...frames.map((f, i) => `${i} ${f.img} ${f.sym}`.trim()),
    ].join('\n');
    // An abort's top frames are the same termination machinery for EVERY
    // crash (pthread_kill, abort, std::terminate, __cxa_throw), so they would
    // merge unrelated crashes into one issue. Sign the first frames past it.
    const own = frames.filter((f) => !SYSTEM_IMAGE.test(f.img));
    const basis = `crash.native\n${proc}\n${ex.type}\n${ex.signal}\n${(own.length ? own : frames).slice(0, 8).map((f) => `${f.img}:${f.sym}`).join('\n')}`;
    const sig = crypto.createHash('sha1').update(basis).digest('hex').slice(0, 12);
    return { kind: 'crash.native', detail, sig, version: head.app_version || '' };
  } catch {
    return null;
  }
}

/** Pure: the new-issue body. */
export function issueBody(entry, env) {
  return [
    `Filed automatically by Dobius+ ${env.version} (${env.os}, ${env.arch}).`,
    '',
    `Kind: \`${entry.kind}\`  `,
    `Seen: ${entry.count} time(s), first ${entry.firstSeen}, last ${entry.lastSeen}  `,
    `Versions: ${entry.versions.join(', ')}`,
    '',
    '```',
    entry.sample.replace(/```/g, "'''"),
    '```',
    '',
    `<!-- dobius-report: ${entry.sig} -->`,
    `dobius-report: ${entry.sig}`,
  ].join('\n');
}

/** Pure: the repeat comment. */
export function repeatComment(entry, delta, env, wasClosed) {
  return [
    `${wasClosed ? 'Seen again AFTER this issue was closed. ' : ''}${delta} more time(s) on Dobius+ ${env.version} (${env.os}, ${env.arch}), last ${entry.lastSeen}.`,
    `Versions so far: ${entry.versions.join(', ')}`,
  ].join('\n');
}

// ---- runtime -----------------------------------------------------------

let state = null;     // { seenIps, day, newToday, sigs: { [sig]: entry } }
let stateFile = null;
let dirtyTimer = null;
let flushing = false;
// The fault whose request is in flight: never pruned, so everything its send
// establishes (reservation, cooldown, issue number) lands on the live record.
const inFlight = new Set();
let access = null;    // null unknown, true, false (this session)
let ctx = null;       // { version, isEnabled, ghBin, repo, crashDir }

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (s && typeof s === 'object' && s.sigs && typeof s.sigs === 'object') return s;
  } catch { /* first run or unreadable: start fresh */ }
  return { seenIps: [], day: '', newToday: 0, sigs: {} };
}

/**
 * Pure-ish: bound the remembered faults. Entries still unsent, or sent within
 * the resend window (their cooldown lives here), go last: evicting one would
 * lose a report or let a repeat comment early (Codex, two lenses). Beyond
 * HARD_MAX_SIGS the oldest go regardless, so memory stays bounded.
 */
const HARD_MAX_SIGS = 1000;
export function pruneSigs(st, now, protect = null) {
  const keys = Object.keys(st.sigs).filter((k) => !protect || !protect.has(k));
  if (keys.length <= MAX_SIGS) return;
  const keep = (e) => e.count > e.sent || now - e.lastSentAt < RESEND_AFTER_MS;
  const byAge = (a, b) => String(st.sigs[a].lastSeen).localeCompare(String(st.sigs[b].lastSeen));
  const idle = keys.filter((k) => !keep(st.sigs[k])).sort(byAge);
  let extra = keys.length - MAX_SIGS;
  for (const k of idle) { if (extra <= 0) break; delete st.sigs[k]; extra -= 1; }
  // Beyond the hard cap: never-filed faults go first (a storm of new ones),
  // and a filed fault's cooldown last, so a repeat cannot comment early.
  const rest = Object.keys(st.sigs).filter((k) => !protect || !protect.has(k));
  if (rest.length > HARD_MAX_SIGS) {
    const order = (k) => (st.sigs[k].issue ? 1 : 0);
    rest.sort((a, b) => order(a) - order(b) || byAge(a, b));
    for (const k of rest.slice(0, rest.length - HARD_MAX_SIGS)) delete st.sigs[k];
  }
}

function saveSoon() {
  if (dirtyTimer) return;
  dirtyTimer = setTimeout(() => { dirtyTimer = null; saveNow(); }, 5000);
  dirtyTimer.unref?.();
}

/** Persist the state. True when it reached disk; callers that are about to
 * send something must not send when it did not (a restart would resend). */
function saveNow() {
  if (!state || !stateFile || !ownsLock()) return false;
  try {
    pruneSigs(state, Date.now(), inFlight);
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, stateFile);
    return true;
  } catch (e) {
    process.stderr.write(`[error-reporter] could not save ${stateFile}: ${e?.message || e}\n`);
    return false;
  }
}

/** Record one fault occurrence. Never throws. */
export function noteFault(kind, detail, sig = signatureFor(kind, detail), version = ctx?.version) {
  if (!state) return;
  try {
    const now = new Date().toISOString();
    let e = state.sigs[sig];
    if (!e) {
      e = state.sigs[sig] = { sig, kind, title: issueTitle(kind, detail), sample: scrub(detail), count: 0, sent: 0, firstSeen: now, lastSeen: now, versions: [], issue: null, lastSentAt: 0 };
    }
    e.count += 1;
    e.lastSeen = now;
    if (version && !e.versions.includes(version)) e.versions = [...e.versions, version].slice(-10);
    saveSoon();
  } catch { /* reporting must never take the app down */ }
}

function gh(args) {
  return new Promise((resolve) => {
    // execFile THROWS (not calls back) on an argument it rejects, and that
    // must be one failed call, not the end of the flush.
    try { execFile(ctx.ghBin, args, {
      timeout: GH_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', PATH: `${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin` },
    }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || err?.message || '').trim() })); }
    catch (err) { resolve({ ok: false, out: '', err: String(err?.message || err) }); }
  });
}

function findGh() {
  if (process.env.DOBIUS_GH_BIN) return process.env.DOBIUS_GH_BIN;
  return ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
}

function envInfo() {
  return { version: ctx.version, os: `macOS ${os.release()}`, arch: `${process.arch}${process.arch === 'x64' && os.cpus()[0]?.model?.includes('Apple') ? ' Rosetta' : ''}` };
}

/**
 * Read native crash reports not read before. Remembered by NAME, not by an
 * mtime watermark: a report that fails to read is retried on the next scan
 * instead of being stepped over by a newer one (Codex). Reports older than
 * CRASH_LOOKBACK_MS are ignored, which also bounds the name list.
 */
export function scanCrashReports(now = Date.now()) {
  if (!state || !ctx?.crashDir) return 0;
  if (!Array.isArray(state.seenIps)) state.seenIps = [];
  const seen = new Set(state.seenIps);
  let n = 0;
  let names;
  try { names = fs.readdirSync(ctx.crashDir); } catch { return 0; }
  const live = [];
  let added = 0;
  for (const name of names) {
    if (!/^Dobius\+.*\.ips$/.test(name)) continue;
    const p = path.join(ctx.crashDir, name);
    let st;
    // A report we cannot stat right now is still there: keep its name, or it
    // would be counted again once readable (Codex).
    try { st = fs.statSync(p); } catch { live.push(name); continue; }
    if (now - st.mtimeMs > CRASH_LOOKBACK_MS) continue;
    live.push(name);
    if (seen.has(name)) continue;
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const r = parseIps(text);
    // A report macOS is still writing does not parse yet: retry it while it
    // is fresh. An old one that does not parse is not ours (or is garbage).
    if (!r && now - st.mtimeMs < IPS_SETTLE_MS) continue;
    if (r) { noteFault(r.kind, r.detail, r.sig, r.version); n += 1; }
    seen.add(name);
    added += 1;
  }
  // Forget names that aged out of the window or were deleted.
  const next = [...seen].filter((x) => live.includes(x));
  if (next.length !== state.seenIps.length || added) { state.seenIps = next; saveSoon(); }
  return n;
}

async function hasAccess() {
  if (access) return true;
  const r = await gh(['api', `repos/${ctx.repo}`, '--jq', '.full_name']);
  // Only a yes is remembered: a no may be offline, so the next flush asks again.
  if (r.ok && r.out.toLowerCase() === ctx.repo.toLowerCase()) return (access = true);
  if (access === null) console.log(`[error-reporter] not filing: this Mac's gh login cannot see ${ctx.repo} (${r.err.slice(0, 120)})`);
  access = false;
  return false;
}

// One reporter per userData. There is no single-instance lock, so a second
// instance (an `open -n`, a crash-relaunch race) would otherwise keep its own
// stale copy of the state and double-file. The first instance takes this lock
// with its pid; another instance whose lock owner is a LIVE Dobius+ process
// does not report at all. A pid can be reused after a crash or a reboot, so a
// live pid that is not Dobius+ (or Electron, in dev) does not count.
function isLiveDobius(pid) {
  try { process.kill(pid, 0); } catch (e) { if (e?.code !== 'EPERM') return false; }
  try {
    // The SAME executable as this process: another Dobius+ instance (or this
    // repo's dev Electron). Any other Electron app is not a reporter (Codex).
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 2000 }).trim() === process.execPath;
  } catch { return false; }
}
// Two instances can both find a DEAD owner and both take over; the last
// writer holds the lock. The other notices here, before any save or send,
// and stops reporting for the rest of its life (Codex, two lenses).
function ownsLock() {
  if (!stateFile) return false;
  try {
    if (Number(fs.readFileSync(`${stateFile}.lock`, 'utf8')) === process.pid) return true;
  } catch { /* gone: not ours */ }
  console.log('[error-reporter] another Dobius+ instance took over reporting for this profile');
  state = null;
  return false;
}

export function takeReporterLock(lock, { isOurs = isLiveDobius } = {}) {
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    try {
      const pid = Number(fs.readFileSync(lock, 'utf8'));
      if (pid && pid !== process.pid && isOurs(pid)) return false;
      fs.writeFileSync(lock, String(process.pid));
      return Number(fs.readFileSync(lock, 'utf8')) === process.pid;
    } catch { return false; }
  }
}

/**
 * 'ok' sent, 'linked' found our own earlier create, 'skip' nothing to do yet
 * (daily cap), 'fail' a gh call failed.
 * ACCEPTED (Codex): two Macs that both search for a brand-new fault before
 * either creates it file two issues for it; the window is two 30-minute
 * flushes coinciding on the same new fault, and the cost is a duplicate issue.
 */
async function fileOne(live, env, count) {
  // The text sent and the count recorded as sent must be the SAME number:
  // occurrences that land while this awaits are the next report's.
  const e = { ...live, count };
  const today = new Date().toISOString().slice(0, 10);
  if (state.day !== today) { state.day = today; state.newToday = 0; }
  // With today's creations used up, an unlinked fault waits for tomorrow
  // WITHOUT a search, so a storm cannot turn into a search storm.
  if (!e.issue && state.newToday >= NEW_ISSUES_PER_DAY) return 'skip';
  if (!e.issue) {
    const found = await gh(['issue', 'list', '-R', ctx.repo, '--state', 'all', '--search', `"dobius-report: ${e.sig}" in:body`, '--json', 'number', '--jq', '.[0].number // empty']);
    if (!found.ok) return 'fail';
    const foundIssue = found.out ? Number(found.out) : null;
    // Our own earlier create, whose reply was lost: it already reported those
    // occurrences, so link it without a comment that would count them twice.
    // Only when the found issue carries THIS attempt's nonce: another Mac may
    // have created it, and then our reserved occurrences were never reported.
    // The issue is linked only AFTER this check, so a failed body lookup
    // retries it on the next flush instead of skipping it for good (Codex).
    let ours = false;
    if (foundIssue && live.pendingCreate && live.pendingNonce) {
      const body = await gh(['issue', 'view', String(foundIssue), '-R', ctx.repo, '--json', 'body', '--jq', '.body']);
      if (!body.ok) return 'fail';
      ours = body.out.includes(`dobius-attempt: ${live.pendingNonce}`);
    }
    if (foundIssue) live.issue = e.issue = foundIssue;
    if (foundIssue && live.pendingCreate && !ours) { delete live.pendingCreate; delete live.pendingAt; delete live.pendingNonce; }
    if (foundIssue && ours) {
      live.sent = Math.max(live.sent, live.pendingCreate);
      live.lastSentAt = live.pendingAt || Date.now();
      delete live.pendingCreate;
      delete live.pendingAt;
      delete live.pendingNonce;
      return 'linked';
    }
  }
  if (!e.issue) {
    // The attempt counts, not the answer, and it is on disk BEFORE the
    // request: a create GitHub accepted whose reply timed out, or that the
    // app crashed under, still used one of today's issues.
    state.newToday += 1;
    live.pendingCreate = count;
    live.pendingAt = Date.now();
    live.pendingNonce = crypto.randomBytes(6).toString('hex');
    if (!saveNow()) {
      // Nothing was sent: undo the reservation, or a later save would record
      // a create that never happened (Codex).
      state.newToday -= 1;
      delete live.pendingCreate; delete live.pendingAt; delete live.pendingNonce;
      return 'fail';
    }
    const r = await gh(['issue', 'create', '-R', ctx.repo, '--title', e.title, '--body', `${issueBody(e, env)}\n<!-- dobius-attempt: ${live.pendingNonce} -->`]);
    const m = r.ok && r.out.match(/\/issues\/(\d+)\s*$/);
    if (!m) { console.log(`[error-reporter] issue create failed: ${r.err.slice(0, 200)}`); return 'fail'; }
    live.issue = Number(m[1]);
    delete live.pendingCreate;
    delete live.pendingAt;
    delete live.pendingNonce;
    return 'ok';
  }
  const view = await gh(['issue', 'view', String(e.issue), '-R', ctx.repo, '--json', 'state', '--jq', '.state']);
  if (!view.ok) {
    // Deleted or transferred: forget the link so the next flush searches
    // again, instead of failing on it first every flush forever (Codex).
    if (/could not resolve to an issue/i.test(view.err)) { live.issue = null; saveNow(); return 'skip'; }
    // Anything else (the repo itself unreachable, access revoked) is a real
    // failure: it counts toward the backoff, and access is asked again (Codex).
    if (/could not resolve to a repository/i.test(view.err)) access = null;
    return 'fail';
  }
  // Likewise a comment: the ATTEMPT counts as sent and starts the cooldown,
  // so a comment GitHub took whose reply was lost is neither posted again nor
  // re-counted later. A comment that truly failed under-counts once, which is
  // the harmless direction (Codex).
  const delta = e.count - e.sent;
  const before = { sent: live.sent, lastSentAt: live.lastSentAt };
  live.lastSentAt = Date.now();
  live.sent = Math.max(live.sent, count);
  if (!saveNow()) { Object.assign(live, before); return 'fail'; } // nothing was sent
  const r = await gh(['issue', 'comment', String(e.issue), '-R', ctx.repo, '--body', repeatComment(e, delta, env, view.out === 'CLOSED')]);
  return r.ok ? 'ok' : 'fail';
}

/**
 * A save while this entry's request was in flight may have pruned it: put
 * back what the send established (issue number, acknowledgement, cooldown),
 * merging into a fresh entry if the fault recurred meanwhile (Codex).
 */
function reattach(e) {
  const cur = state.sigs[e.sig];
  if (!cur) { state.sigs[e.sig] = e; return; }
  if (cur === e) return;
  cur.issue = cur.issue || e.issue;
  cur.lastSentAt = Math.max(cur.lastSentAt || 0, e.lastSentAt || 0);
}

/** Send what is unsent. One flush at a time; never throws. */
export async function flushReports(now = Date.now()) {
  if (flushing || !state || !ctx || !ctx.isEnabled() || !ownsLock()) return { filed: 0, skipped: 'disabled' };
  flushing = true;
  const started = Date.now();
  let filed = 0;
  try {
    scanCrashReports();
    const due = Object.values(state.sigs).filter((e) => e.count > e.sent && (!e.issue || now - e.lastSentAt >= RESEND_AFTER_MS));
    if (!due.length) return { filed: 0 };
    if (!ctx.ghBin || !(await hasAccess())) return { filed: 0, skipped: 'no-access' };
    const env = envInfo();
    let failures = 0;
    for (const e of due) {
      // Pruned meanwhile: its record is gone, so nothing could remember the send.
      if (state.sigs[e.sig] !== e) continue;
      const count = e.count;
      inFlight.add(e.sig);
      let result;
      try { result = await fileOne(e, env, count); } finally { inFlight.delete(e.sig); }
      if (!state) break; // another instance took over reporting
      if (result === 'skip') continue;
      if (result === 'ok') {
        failures = 0;
        e.sent = count;
        // The cooldown starts when THIS one was sent, not when the flush began.
        e.lastSentAt = now + (Date.now() - started);
        filed += 1;
      }
      reattach(e);
      if (result === 'linked') failures = 0; // GitHub answered: the streak is over
      if (result === 'ok' || result === 'linked') {
        saveNow(); // a crash right after a send must not resend it
      } else if ((failures += 1) >= MAX_GH_FAILURES) {
        return { filed, skipped: 'gh-failing' };
      }
    }
    return { filed };
  } catch (err) {
    console.log(`[error-reporter] flush failed: ${err?.message || err}`);
    return { filed, skipped: 'error' };
  } finally {
    flushing = false;
  }
}

/**
 * Start reporting. Off in dev and in an isolated harness instance
 * (DOBIUS_USERDATA_DIR) so test runs never file real issues;
 * DOBIUS_REPORTS_FORCE=1 overrides for a ship-test, and DOBIUS_REPORTS_REPO /
 * DOBIUS_GH_BIN point it somewhere else. settings.errorReports === false
 * turns it off.
 */
export function startErrorReporter({ userDataDir, version, isPackaged, getSettings }) {
  if (state) return;
  const forced = process.env.DOBIUS_REPORTS_FORCE === '1';
  if (!forced && (!isPackaged || process.env.DOBIUS_USERDATA_DIR)) return;
  stateFile = path.join(userDataDir, 'logs', 'error-reports.json');
  try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); } catch { /* saveNow reports it */ }
  if (!takeReporterLock(`${stateFile}.lock`)) {
    console.log('[error-reporter] another Dobius+ instance is reporting for this profile; this one will not');
    stateFile = null;
    return;
  }
  state = load();
  const repo = process.env.DOBIUS_REPORTS_REPO || REPORTS_REPO;
  // Issue numbers mean nothing in another repo: drop the links (and their
  // cooldowns) when the target changed, so each fault is searched again.
  if (state.repo !== repo) {
    for (const e of Object.values(state.sigs)) { e.issue = null; e.lastSentAt = 0; delete e.pendingCreate; delete e.pendingAt; delete e.pendingNonce; }
    state.repo = repo;
  }
  ctx = {
    version,
    repo,
    ghBin: findGh(),
    crashDir: process.env.DOBIUS_CRASH_DIR || path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports'),
    isEnabled: () => { try { return getSettings().errorReports !== false; } catch { return true; } },
  };
  const first = setTimeout(() => flushReports(), FIRST_FLUSH_MS);
  first.unref?.();
  const every = setInterval(() => flushReports(), FLUSH_EVERY_MS);
  every.unref?.();
  process.on('exit', () => {
    saveNow();
    try { if (Number(fs.readFileSync(`${stateFile}.lock`, 'utf8')) === process.pid) fs.unlinkSync(`${stateFile}.lock`); } catch { /* gone */ }
  });
}
