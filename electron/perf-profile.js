// A CPU profile of the main process, taken from INSIDE it (node:inspector Session): no --inspect flag, no open
// port, no restart. Built 2026-11-11 after the live app sat at ~47% CPU with 37 tabs while a 12-tab harness idled
// at 7%: the cost depends on the real data, so it has to be measured in the real app. Reached only through the
// token-guarded loopback bridge (POST /perfProfile, docs/bridge-perf-profile.md).
//
// Bounded: one profile at a time, 2 to 60 seconds, 1ms sampling, and only the newest KEEP_FILES profiles are kept on
// disk (a 60s profile is a few MB).
import inspector from 'node:inspector';
import fs from 'node:fs';
import path from 'node:path';

export const MIN_SECONDS = 2;
export const MAX_SECONDS = 60;
const KEEP_FILES = 3;
// Only names this module writes (main-<ISO time with : and . as ->.cpuprofile): never anyone else's file.
const FILE_RE = /^main-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.cpuprofile$/;
const DEFAULT_SECONDS = 10;

let running = false;

// "fn dir/file.js:line" for a profile node. The last two path segments are enough to find the code and keep the
// user's home folder out of the summary.
function frameKey(n) {
  const cf = n.callFrame || {};
  const where = String(cf.url || '').split('/').slice(-2).join('/');
  return `${cf.functionName || '(anon)'} ${where}:${(cf.lineNumber ?? -1) + 1}`;
}

/** Pure: busy share, top self time, and top inclusive time for app code (electron/, shared/). */
export function summarizeProfile(profile, top = 20) {
  const nodes = Array.isArray(profile?.nodes) ? profile.nodes : [];
  const samples = Array.isArray(profile?.samples) ? profile.samples : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of nodes) for (const c of n.children || []) parent.set(c, n.id);
  const hits = new Map();
  for (const s of samples) hits.set(s, (hits.get(s) || 0) + 1);
  const self = new Map();
  const incl = new Map();
  let idle = 0;
  for (const [id, count] of hits) {
    const n = byId.get(id);
    if (!n) continue;
    const name = n.callFrame?.functionName;
    if (name === '(idle)') { idle += count; continue; }
    const k = frameKey(n);
    self.set(k, (self.get(k) || 0) + count);
    const seen = new Set();
    for (let cur = id, guard = 0; cur != null && guard < 10000; cur = parent.get(cur), guard += 1) {
      const pn = byId.get(cur);
      if (!pn) break;
      const pk = frameKey(pn);
      if (!seen.has(pk)) { seen.add(pk); incl.set(pk, (incl.get(pk) || 0) + count); }
    }
  }
  const total = samples.length;
  const pct = (v) => (total ? Math.round((1000 * v) / total) / 10 : 0);
  const rank = (m, keep) => [...m].filter(([k]) => keep(k)).sort((a, b) => b[1] - a[1]).slice(0, top).map(([fn, v]) => ({ pct: pct(v), fn }));
  return {
    samples: total,
    busyPct: pct(total - idle),
    topSelf: rank(self, () => true),
    topApp: rank(incl, (k) => /\s(electron|shared)\/[^/\s]+:\d+$/.test(k)),
  };
}

/** Pure: the caller's `seconds` as a whole number in 2..60. Only a real number counts (Number() on a caller's object
 * can throw: a toString of null), anything else is the 10 s default, and 0 is the minimum. */
export function clampSeconds(seconds) {
  const asked = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : DEFAULT_SECONDS;
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(asked)));
}

function post(session, method, params = {}) {
  return new Promise((resolve, reject) => {
    session.post(method, params, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

// Keeps the file just written whatever its name says (a clock that was wrong earlier must not make the new profile
// look oldest), plus the newest KEEP_FILES - 1 others.
function pruneOld(dir, keep) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => FILE_RE.test(n) && n !== keep); } catch (err) {
    console.warn(`[perf-profile] could not list ${dir}: ${err.message}`);
    return;
  }
  names.sort(); // timestamped names sort oldest first
  for (const n of names.slice(0, Math.max(0, names.length - (KEEP_FILES - 1)))) {
    try { fs.unlinkSync(path.join(dir, n)); } catch (err) { console.warn(`[perf-profile] could not remove ${n}: ${err.message}`); }
  }
}

/**
 * Profile the main process for `seconds` (a number, clamped to 2..60, default 10), write
 * <logDir>/main-<time>.cpuprofile (open it in Chrome DevTools > Performance) and return the summary with the file's
 * NAME only (never the folder: it holds the user's home path). Refuses while another profile runs.
 */
export async function profileMain(seconds, logDir, { now = () => new Date() } = {}) {
  if (running) return { ok: false, error: 'a profile is already running' };
  const secs = clampSeconds(seconds);
  running = true;
  const session = new inspector.Session();
  try {
    session.connect();
    await post(session, 'Profiler.enable');
    await post(session, 'Profiler.setSamplingInterval', { interval: 1000 });
    await post(session, 'Profiler.start');
    await new Promise((r) => setTimeout(r, secs * 1000));
    const { profile } = await post(session, 'Profiler.stop');
    let file = null;
    if (logDir) {
      try {
        fs.mkdirSync(logDir, { recursive: true });
        file = `main-${now().toISOString().replace(/[:.]/g, '-')}.cpuprofile`;
        // 'wx': a new file only. Never follows or replaces something already at that name (a symlink, a same-
        // millisecond earlier profile).
        fs.writeFileSync(path.join(logDir, file), JSON.stringify(profile), { flag: 'wx', mode: 0o600 });
        pruneOld(logDir, file);
      } catch (err) {
        console.warn(`[perf-profile] could not save the profile: ${err.message}`);
        file = null;
      }
    }
    return { ok: true, seconds: secs, file, ...summarizeProfile(profile) };
  } catch (err) {
    return { ok: false, error: `profile failed: ${err?.message || err}` };
  } finally {
    try { session.post('Profiler.disable'); } catch { /* the session may already be gone */ }
    try { session.disconnect(); } catch { /* already disconnected */ }
    running = false;
  }
}
