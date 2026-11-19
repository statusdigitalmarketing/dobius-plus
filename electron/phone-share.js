// Share to Dobius+ from the iPhone share sheet (docs/phone-share.md).
//
// Two routes on the phone server, behind its host check, CORS and the paired device's bearer token:
//   GET  /share/targets  the tabs the share sheet offers (team orchestrator first, then by last activity)
//   POST /share          one image or text into one tab's Claude prompt
// The image is saved where /upload saves (the 24 h pruned upload folder) and its path goes on a line of its own after
// the note: Claude Code turns a pasted image path on its own line into an [Image #N] attachment (checked live on
// 2.1.x, 2026-11-19). Delivery is the dobius-send path with claudeOnly, so every guard there applies: never into a draft,
// an open question or a shell.
//
// Bounded by construction: one share at a time on the whole Mac, claimed BEFORE the body is read (a second upload is
// refused with 429 without buffering it); body caps per kind; a receipt map of at most RECEIPTS_MAX entries for an
// hour, so a retried Send (lost answer) is answered again instead of typed twice.
import express from 'express';

export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_TEXT_BYTES = 32 * 1024;
export const MAX_NOTE_CHARS = 2000;
export const MAX_TARGETS = 40;
const RECEIPTS_MAX = 200;
const RECEIPT_TTL_MS = 60 * 60_000;
const SHARE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
// The whole delivery's deadline. sendToTab bounds its own waits, but not a process probe that never settles; past this
// the share lock is let go (sendToTab's own per-tab lock still keeps a second paste out of that tab) and the phone is
// told the outcome is unknown, never that it was sent.
export const DELIVER_DEADLINE_MS = 45_000;
export const SHARE_PREFIX = '[shared from the phone]';

/** The image type by its first bytes, never by a name the phone sent. */
export function imageKind(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/**
 * Pure: the share sheet's list. `terms` are the phone board's terminal rows (buildTerminalsPayload). The orchestrator
 * leads, then Claude tabs by last activity, then the rest by last activity; MAX_TARGETS at most.
 */
export function orderTargets(terms, orchestratorId) {
  const rows = (Array.isArray(terms) ? terms : []).filter((t) => t && typeof t.id === 'string').map((t) => ({
    id: t.id,
    label: String(t.label || '').slice(0, 80),
    project: String(t.projectName || '').slice(0, 80),
    claude: t.claudeLive === true,
    status: typeof t.status === 'string' ? t.status : 'idle',
    lastActivityAt: Number.isFinite(t.lastActivityAt) ? t.lastActivityAt : 0,
    orchestrator: !!orchestratorId && t.id === orchestratorId,
  }));
  const rank = (r) => (r.orchestrator ? 0 : r.claude ? 1 : 2);
  rows.sort((a, b) => rank(a) - rank(b) || b.lastActivityAt - a.lastActivityAt);
  return rows.slice(0, MAX_TARGETS);
}

/** Pure: what is pasted into the tab. An image path stands on its own line so Claude Code attaches it. */
export function shareMessage({ note, text, path }) {
  const head = note ? `${SHARE_PREFIX} ${note}` : SHARE_PREFIX;
  return `${head}\n\n${path || text}`;
}

/** The note from the query: one line of plain text, capped. */
export function cleanNote(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\x00-\x1f\x7f\u0080-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS);
}

/**
 * deps:
 *   auth(req) -> boolean (bearer check; reads headers only)
 *   targets() -> { mac, orchestrator, tabs }   (tabs from orderTargets)
 *   tabAlive(id) -> boolean
 *   saveImage(buf, ext) -> absolute path       (throws on a write failure)
 *   deliver(tabId, message, images) -> Promise<{ status, body }>   (sendToTab, claudeOnly; images = pasted paths)
 *   discard(path)                              (a saved image nothing was typed for; best effort)
 *   label(tabId) -> string
 *   now() -> ms (optional), deadlineMs (optional, tests)
 */
export function mountShareRoutes(app, deps) {
  const now = deps.now || Date.now;
  let busy = false;
  const receipts = new Map(); // shareId -> { at, status, body }
  const prune = () => {
    const t = now();
    for (const [id, r] of receipts) if (t - r.at > RECEIPT_TTL_MS) receipts.delete(id);
    while (receipts.size > RECEIPTS_MAX) receipts.delete(receipts.keys().next().value);
  };
  const authOnly = (req, res, next) => (deps.auth(req) ? next() : res.status(401).json({ ok: false, error: 'auth' }));

  app.get('/share/targets', authOnly, (_req, res) => {
    try {
      res.json({ ok: true, ...deps.targets() });
    } catch {
      res.status(500).json({ ok: false, error: 'could not list the tabs' });
    }
  });

  // Everything that can refuse a share is decided before a byte of the body is read.
  const admit = (req, res, next) => {
    const kind = req.query.kind;
    const tab = typeof req.query.tab === 'string' ? req.query.tab : '';
    const shareId = typeof req.query.id === 'string' ? req.query.id : '';
    if (kind !== 'image' && kind !== 'text') return res.status(400).json({ ok: false, error: 'kind must be image or text' });
    if (shareId && !SHARE_ID_RE.test(shareId)) return res.status(400).json({ ok: false, error: 'bad share id' });
    if (shareId) {
      prune();
      const r = receipts.get(shareId);
      if (r) return res.status(r.status).json({ ...r.body, repeat: true });
    }
    if (!tab || !deps.tabAlive(tab)) return res.status(404).json({ ok: false, error: 'that tab is not open on the Mac any more', reason: 'no-tab' });
    const declared = Number(req.headers['content-length']);
    const cap = kind === 'image' ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
    if (Number.isFinite(declared) && declared > cap) return res.status(413).json({ ok: false, error: kind === 'image' ? 'the image is too big' : 'the text is too long' });
    if (busy) return res.status(429).json({ ok: false, error: 'another share is still being delivered; try again in a moment', reason: 'busy' });
    busy = true;
    let released = false;
    req.shareRelease = () => { if (!released) { released = true; busy = false; } };
    // The body read can fail (aborted, too large) before the handler runs: the claim goes with the request.
    res.on('close', () => { if (!req.shareHandled) req.shareRelease(); });
    req.shareKind = kind;
    req.shareTab = tab;
    req.shareId = shareId;
    return next();
  };

  const body = (req, res, next) => express.raw({ type: () => true, limit: req.shareKind === 'image' ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES })(req, res, next);

  app.post('/share', authOnly, admit, body, async (req, res) => {
    req.shareHandled = true;
    const finish = (status, payload) => {
      // Remembered when something may have been typed (sent, typed, or unknown): a retry must not paste it twice.
      if (req.shareId && (payload.ok || payload.typed || payload.uncertain)) { receipts.set(req.shareId, { at: now(), status, body: payload }); prune(); }
      res.status(status).json(payload);
    };
    try {
      const buf = Buffer.isBuffer(req.body) ? req.body : null;
      if (!buf || buf.length === 0) return finish(400, { ok: false, error: 'nothing was shared' });
      const note = cleanNote(req.query.note);
      let message;
      if (req.shareKind === 'image') {
        const ext = imageKind(buf);
        if (!ext) return finish(415, { ok: false, error: 'that is not an image Dobius can pass on (PNG, JPEG, GIF or WebP)' });
        let file;
        try { file = deps.saveImage(buf, ext); } catch { return finish(500, { ok: false, error: 'could not save the image on the Mac' }); }
        message = shareMessage({ note, path: file });
        req.shareFile = file;
      } else {
        const text = buf.toString('utf8').trim();
        if (!text) return finish(400, { ok: false, error: 'nothing was shared' });
        message = shareMessage({ note, text });
      }
      let r;
      let timer;
      const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(null), deps.deadlineMs ?? DELIVER_DEADLINE_MS); });
      try {
        r = await Promise.race([deps.deliver(req.shareTab, message, req.shareFile ? [req.shareFile] : null), deadline]);
      } catch { r = { status: 500, body: { ok: false, error: 'not delivered' } }; } finally { clearTimeout(timer); }
      if (r === null) return finish(504, { ok: false, uncertain: true, error: 'The Mac did not finish delivering it in time. Check the tab before sending it again.' });
      const b = r?.body || {};
      const label = (() => { try { return deps.label(req.shareTab); } catch { return ''; } })();
      if (b.ok) return finish(200, { ok: true, sent: true, label });
      if (b.typed) return finish(200, { ok: true, sent: false, typed: true, label, note: b.note || b.error || '' });
      // Nothing was typed, so nothing will ever read the image: it goes now rather than in a day.
      if (req.shareFile) { try { deps.discard?.(req.shareFile); } catch { /* best effort: the prune takes it */ } }
      return finish(r?.status && r.status >= 400 ? r.status : 409, { ok: false, error: b.error || 'not delivered', reason: b.reason || undefined });
    } finally {
      req.shareRelease();
    }
  });
}
