// "Report a problem" from the status bar (Sam, 2026-11-15: "make it easy to submit bugs and error reporting to
// dobius... a little tiny emoji icon in the bottom footer"). The person writes what went wrong; it is filed as an
// issue in the private reports repo through this computer's own `gh` login, the same way error-reporter.js files
// faults (no token ships in the app). A computer whose gh cannot see that repo gets the report back to copy and paste
// to Sam instead, so nothing is lost and nothing leaves silently.
//
// A computer whose gh cannot file can send the report through a linked teammate's Dobius instead, which files it with
// ITS gh (docs/report-via-team.md): `relay` here on the sender, `fileRelayedReport` on the teammate's Mac.
//
// Bounded: the person's text is capped, the error log is read from its last LOG_TAIL_BYTES only (it only grows, and
// never whole), at most LOG_LINES lines go out, scrubbed. One report at a time, and a short cooldown after one is sent.

import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';
import { REPORTS_REPO, findGh, scrub } from './error-reporter.js';
import { MAX_TEXT as TEAM_MAX_TEXT } from './team-protocol.js';
import { shortFp } from './team-crypto.js';

export const MAX_TEXT = 4000; // characters of the person's own description
const LOG_TAIL_BYTES = 32 * 1024; // read from the end of error.log, never the whole file
const LOG_LINES = 40;
const GH_TIMEOUT_MS = 30_000;
const COOLDOWN_MS = 15_000; // after a report is filed, so a double click files one

/** The last `maxBytes` of a file as text, starting at a line boundary; '' when it cannot be read. */
export function readTail(file, maxBytes = LOG_TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.subarray(0, n).toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

/** Pure: the person's text with their home folder shortened to ~ (it names them), trimmed and capped. */
export function cleanText(text, home = os.homedir()) {
  let s = String(text ?? '').replace(/\r/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (home && home.length > 1) s = s.split(home).join('~');
  return s.slice(0, MAX_TEXT);
}

/** Pure: the issue's title and body. `log` is the raw tail of error.log, or '' to leave it out. */
export function buildReport({ text, log = '', env, home = os.homedir() }) {
  const said = cleanText(text, home);
  const first = said.split('\n')[0].replace(/\s+/g, ' ').trim();
  const title = `[report] ${first.length > 80 ? `${first.slice(0, 77)}...` : first || 'A problem in Dobius+'}`;
  const lines = String(log || '').split('\n').filter((l) => l.trim()).slice(-LOG_LINES).join('\n');
  const errors = lines ? scrub(lines, home).replace(/```/g, "'''") : '';
  const body = [
    `Reported from Dobius+ ${env.version} (${env.os}, ${env.arch}).`,
    '',
    '## What happened',
    '',
    said.replace(/```/g, "'''"),
    '',
    ...(errors ? ['## Recent errors on this computer (scrubbed)', '', '```', errors, '```', ''] : []),
    '<!-- dobius-user-report -->',
  ].join('\n');
  return { title, body };
}

const ISSUE_URL = /^https:\/\/github\.com\/\S+\/issues\/\d+$/;
// gh answers "Could not resolve to a Repository" (or a 404) when this login cannot see the private repo.
const NO_ACCESS = /could not resolve|not found|404|permission|authentication|gh auth login/i;

async function fileIssue(exec, bin, repo, title, body) {
  const r = await exec(bin, ['issue', 'create', '-R', repo, '--title', title, '--body', body]);
  const last = r.out.split('\n').pop();
  if (r.ok && ISSUE_URL.test(last)) return { ok: true, url: last };
  return { ok: false, noAccess: NO_ACCESS.test(r.err) };
}

/** Pure: a report as one team message, title on the first line (fileRelayedReport reads it back). */
export const relayText = (report) => `${report.title}\n\n${report.body}`;

/**
 * Pure: the issue a teammate's relayed report becomes on THIS Mac. The text is theirs and untrusted: the title is one
 * cleaned line, and the attribution is the sender's verified fingerprint, never the name it chose for itself.
 */
export function relayedIssue({ text, peer, id, selfName = '' }) {
  const s = String(text ?? '').replace(/\r/g, '');
  const nl = s.indexOf('\n');
  const first = (nl < 0 ? s : s.slice(0, nl)).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  const t = first || 'A problem in Dobius+';
  const prefixed = /^\[report\]/i.test(t) ? t : `[report] ${t}`;
  const title = prefixed.length > 120 ? `${prefixed.slice(0, 117)}...` : prefixed;
  const name = String(selfName).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029"`<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  const fp = String(peer || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64); // base64url, like team fingerprints
  const mid = String(id || '').replace(/[^0-9a-f-]/gi, '').slice(0, 36);
  // The attribution goes FIRST, and every HTML comment opener or closer in their text is defanged: an unclosed `<!--`
  // in the text could otherwise hide the attribution and the marker in the rendered issue, or forge a marker.
  const said = (nl < 0 ? '' : s.slice(nl + 1)).replace(/^\n+/, '').replace(/<!--/g, '&lt;!--').replace(/--!?>/g, '--&gt;');
  const body = [
    `> Relayed by a linked teammate's Dobius, fingerprint ${shortFp(fp)}.${name ? ` Their Dobius calls itself "${name}".` : ''}`,
    `<!-- dobius-relayed-report ${fp}/${mid} -->`,
    '',
    said,
  ].join('\n');
  return { title, body };
}

/**
 * On the teammate's Mac: file a relayed report with this computer's gh. Answers { ok: true, url } or
 * { ok: false, reason } in words the sender is shown.
 */
export async function fileRelayedReport({ text, peer, id, selfName, repo = process.env.DOBIUS_REPORTS_REPO || REPORTS_REPO,
  ghBin = () => findGh(), exec = run }) {
  const bin = ghBin();
  if (!bin) return { ok: false, reason: 'GitHub CLI is not installed on their computer' };
  const { title, body } = relayedIssue({ text, peer, id, selfName });
  const r = await fileIssue(exec, bin, repo, title, body);
  if (r.ok) return { ok: true, url: r.url };
  return { ok: false, reason: r.noAccess ? 'their GitHub login cannot see the reports repo either' : 'GitHub did not accept it' };
}

function run(bin, args) {
  return new Promise((resolve) => {
    try {
      execFile(bin, args, {
        timeout: GH_TIMEOUT_MS,
        maxBuffer: 256 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', PATH: `${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin` },
      }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || err?.message || '').trim() }));
    } catch (err) { resolve({ ok: false, out: '', err: String(err?.message || err) }); }
  });
}

/**
 * The submitter main uses. `submit({ text, includeLog })` answers
 * { ok: true, url } | { ok: false, reason: 'empty' | 'busy' | 'no-gh' | 'no-access' | 'failed', report? }.
 * Every refusal after the text was read carries `report` (title + body) so the screen can offer it to copy.
 */
export function createProblemReporter({ version, logPath, repo = process.env.DOBIUS_REPORTS_REPO || REPORTS_REPO,
  ghBin = () => findGh(), now = Date.now, platform = process.platform, exec = run }) {
  let inFlight = false;
  let lastSent = -Infinity;
  const env = () => ({
    version,
    os: platform === 'darwin' ? `macOS ${os.release()}` : platform === 'win32' ? `Windows ${os.release()}` : `${platform} ${os.release()}`,
    arch: process.arch,
  });
  async function submit({ text, includeLog } = {}) {
    if (typeof text !== 'string' || !cleanText(text)) return { ok: false, reason: 'empty' };
    if (inFlight || now() - lastSent < COOLDOWN_MS) return { ok: false, reason: 'busy' };
    inFlight = true;
    try {
      const log = includeLog === true && logPath ? readTail(typeof logPath === 'function' ? logPath() : logPath) : '';
      const report = buildReport({ text, log, env: env() });
      const bin = ghBin();
      if (!bin) return { ok: false, reason: 'no-gh', report };
      const r = await fileIssue(exec, bin, repo, report.title, report.body);
      if (r.ok) {
        lastSent = now();
        return { ok: true, url: r.url };
      }
      return { ok: false, reason: r.noAccess ? 'no-access' : 'failed', report };
    } finally {
      inFlight = false;
    }
  }
  /**
   * The same report, handed to `send(text)` (one teammate, team kind 'report') instead of gh. `send` answers like
   * the team service's send: { ok, to } or { ok: false, error }. Answers { ok: true, to } |
   * { ok: false, reason: 'empty' | 'busy' | 'failed', error?, report? }.
   */
  async function relay({ text, includeLog, send } = {}) {
    if (typeof text !== 'string' || !cleanText(text)) return { ok: false, reason: 'empty' };
    if (inFlight || now() - lastSent < COOLDOWN_MS) return { ok: false, reason: 'busy' };
    inFlight = true;
    try {
      const log = includeLog === true && logPath ? readTail(typeof logPath === 'function' ? logPath() : logPath) : '';
      let report = buildReport({ text, log, env: env() });
      // Over the team limit only with very long log lines: the description matters more than the log.
      if (relayText(report).length > TEAM_MAX_TEXT) report = buildReport({ text, log: '', env: env() });
      let r;
      try { r = send(relayText(report)); } catch (err) { r = { ok: false, error: String(err?.message || err) }; }
      if (r?.ok) {
        lastSent = now();
        return { ok: true, to: r.to || '' };
      }
      return { ok: false, reason: 'failed', error: r?.error || 'not sent', report };
    } finally {
      inFlight = false;
    }
  }
  submit.relay = relay;
  return submit;
}
