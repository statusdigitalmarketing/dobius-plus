// "Report a problem" from the status bar (Sam, 2026-11-15: "make it easy to submit bugs and error reporting to
// dobius... a little tiny emoji icon in the bottom footer"). The person writes what went wrong; it is filed as an
// issue in the private reports repo through this computer's own `gh` login, the same way error-reporter.js files
// faults (no token ships in the app). A computer whose gh cannot see that repo gets the report back to copy and paste
// to Sam instead, so nothing is lost and nothing leaves silently.
//
// Bounded: the person's text is capped, the error log is read from its last LOG_TAIL_BYTES only (it only grows, and
// never whole), at most LOG_LINES lines go out, scrubbed. One report at a time, and a short cooldown after one is sent.

import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';
import { REPORTS_REPO, findGh, scrub } from './error-reporter.js';

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
  return async function submit({ text, includeLog } = {}) {
    if (typeof text !== 'string' || !cleanText(text)) return { ok: false, reason: 'empty' };
    if (inFlight || now() - lastSent < COOLDOWN_MS) return { ok: false, reason: 'busy' };
    inFlight = true;
    try {
      const log = includeLog === true && logPath ? readTail(typeof logPath === 'function' ? logPath() : logPath) : '';
      const report = buildReport({ text, log, env: env() });
      const bin = ghBin();
      if (!bin) return { ok: false, reason: 'no-gh', report };
      const r = await exec(bin, ['issue', 'create', '-R', repo, '--title', report.title, '--body', report.body]);
      if (r.ok && /^https:\/\/github\.com\/\S+\/issues\/\d+$/.test(r.out.split('\n').pop())) {
        lastSent = now();
        return { ok: true, url: r.out.split('\n').pop() };
      }
      // gh answers "Could not resolve to a Repository" (or a 404) when this login cannot see the private repo.
      const noAccess = /could not resolve|not found|404|permission|authentication|gh auth login/i.test(r.err);
      return { ok: false, reason: noAccess ? 'no-access' : 'failed', report };
    } finally {
      inFlight = false;
    }
  };
}
