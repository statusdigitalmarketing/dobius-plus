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
const MAX_UNSETTLED = 4; // deliveries still running (past the deadline too) before new shares get 429
const KEPT_FILES_MAX = 16; // settled images kept protected from the upload prune
const TYPED_KEEP_MS = 10 * 60 * 1000; // how long a typed-but-unconfirmed paste's image is protected
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
  return raw.replace(/[\x00-\x1f\x7f\u0080-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS).trim();
}

/**
 * deps:
 *   auth(req) -> boolean (bearer check; reads headers only)
 *   targets() -> { mac, orchestrator, tabs }   (tabs from orderTargets)
 *   tabAlive(id) -> boolean
 *   saveImage(buf, ext) -> absolute path       (throws on a write failure)
 *   deliver(tabId, message, images, allowed) -> Promise<{ status, body }>   (sendToTab, claudeOnly; images = pasted
 *                                              paths; allowed() re-checks the sender before the paste and the Enter)
 *   discard(path)                              (a saved image nothing was typed for; best effort)
 *   label(tabId) -> string
 *   now() -> ms (optional), deadlineMs (optional, tests)
 */
/**
 * What outlives one server: the phone server is restarted in place (HTTPS certificate renewal, port change) while tabs
 * keep running, and a retry after the restart must still find its receipt. mobile-server keeps one for the process.
 */
export function shareState() {
  return { busy: false, unsettled: 0, receipts: new Map(), pendingIds: new Set(), liveFiles: new Map() };
}

export function mountShareRoutes(app, deps) {
  const now = deps.now || Date.now;
  const st = deps.state || shareState();
  const { receipts, pendingIds, liveFiles } = st; // receipts: shareId -> { at, status, body, fp }
  // The receipt of a delivery that has not settled is never evicted: it is the only thing stopping a second paste.
  // pendingIds is bounded by MAX_UNSETTLED, so this cannot grow past RECEIPTS_MAX + MAX_UNSETTLED.
  const prune = () => {
    const t = now();
    for (const [id, r] of receipts) if (t - r.at > RECEIPT_TTL_MS && !pendingIds.has(id)) receipts.delete(id);
    for (const id of receipts.keys()) {
      if (receipts.size <= RECEIPTS_MAX) break;
      if (!pendingIds.has(id)) receipts.delete(id);
    }
  };
  const authOnly = (req, res, next) => (deps.auth(req) ? next() : res.status(401).json({ ok: false, error: 'auth' }));

  app.get('/share/targets', authOnly, (_req, res) => {
    try {
      res.json({ ok: true, ...deps.targets() });
    } catch {
      res.status(500).json({ ok: false, error: 'could not list the tabs' });
    }
  });

  // Ids whose delivery has not settled (past the deadline too): a retry of one is told it is still going, never run
  // again. Image files a delivery may still paste: the upload prune must not delete them (protectedFiles()).
  // file -> protected until (ms; Infinity while its delivery runs). A typed-but-unconfirmed paste may still be read by
  // Claude later, so its image stays a while after the delivery settles. ponytail: at most MAX_UNSETTLED running plus
  // KEPT_FILES_MAX settled entries (oldest dropped), so the protection itself can hold at most ~20 x 12 MB.
  const protectedFiles = () => {
    const t = now();
    const out = new Set();
    for (const [f, until] of liveFiles) { if (until > t) out.add(f); else liveFiles.delete(f); }
    return out;
  };
  const keepFile = (file, ms) => {
    liveFiles.delete(file);
    if (ms > 0) liveFiles.set(file, now() + ms);
    let settled = [...liveFiles].filter(([, u]) => u !== Infinity);
    while (settled.length > KEPT_FILES_MAX) { liveFiles.delete(settled[0][0]); settled = settled.slice(1); }
  };
  // What a receipt answers for: a retry must be the same share, not the same id reused for another tab or note.
  const fingerprint = (tab, kind, note) => `${kind}\n${tab}\n${note}`;

  // Everything that can refuse a share is decided before a byte of the body is read.
  const admit = (req, res, next) => {
    const kind = req.query.kind;
    const tab = typeof req.query.tab === 'string' ? req.query.tab : '';
    const shareId = typeof req.query.id === 'string' ? req.query.id : '';
    const note = cleanNote(req.query.note);
    if (kind !== 'image' && kind !== 'text') return res.status(400).json({ ok: false, error: 'kind must be image or text' });
    if (shareId && !SHARE_ID_RE.test(shareId)) return res.status(400).json({ ok: false, error: 'bad share id' });
    // A compressed body would be inflated by the parser after the claim could already be gone: refused outright.
    const enc = String(req.headers['content-encoding'] || 'identity').toLowerCase();
    if (enc !== 'identity') return res.status(415).json({ ok: false, error: 'compressed uploads are not accepted' });
    if (shareId) {
      prune();
      const r = receipts.get(shareId);
      if (r) {
        if (r.fp !== fingerprint(tab, kind, note)) return res.status(409).json({ ok: false, error: 'that share id was already used for something else', reason: 'id-reused' });
        return res.status(r.status).json({ ...r.body, repeat: true });
      }
      if (pendingIds.has(shareId)) return res.status(409).json({ ok: false, uncertain: true, error: 'The Mac is still delivering this one. Check the tab in a moment.', reason: 'in-progress' });
    }
    if (!tab || !deps.tabAlive(tab)) return res.status(404).json({ ok: false, error: 'that tab is not open on the Mac any more', reason: 'no-tab' });
    const declared = Number(req.headers['content-length']);
    const cap = kind === 'image' ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
    if (Number.isFinite(declared) && declared > cap) return res.status(413).json({ ok: false, error: kind === 'image' ? 'the image is too big' : 'the text is too long' });
    // busy: one share reads and starts at a time. unsettled: deliveries still running, past their deadline too (each one
    // holds an image and a receipt), so a run of hung deliveries cannot pile up.
    if (st.busy || st.unsettled >= MAX_UNSETTLED) return res.status(429).json({ ok: false, error: 'another share is still being delivered; try again in a moment', reason: 'busy' });
    st.busy = true;
    if (shareId) pendingIds.add(shareId);
    const claim = { released: false, delivering: false };
    req.shareClaim = claim;
    req.shareRelease = () => {
      if (claim.released) return;
      claim.released = true;
      st.busy = false;
      if (!claim.delivering && shareId) pendingIds.delete(shareId);
    };
    // The body read can fail (aborted, too large) before the handler runs: the claim goes with the request.
    res.on('close', () => { if (!req.shareHandled) req.shareRelease(); });
    req.shareKind = kind;
    req.shareTab = tab;
    req.shareId = shareId;
    req.shareNote = note;
    return next();
  };

  const body = (req, res, next) => express.raw({ type: () => true, inflate: false, limit: req.shareKind === 'image' ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES })(req, res, next);

  app.post('/share', authOnly, admit, body, async (req, res) => {
    req.shareHandled = true;
    const claim = req.shareClaim;
    const finish = (status, payload) => {
      // Remembered when something may have been typed (sent, typed, or unknown): a retry must not paste it twice.
      if (req.shareId && (payload.ok || payload.typed || payload.uncertain)) {
        receipts.set(req.shareId, { at: now(), status, body: payload, fp: fingerprint(req.shareTab, req.shareKind, req.shareNote) });
        prune();
      }
      if (!res.headersSent && !res.destroyed) res.status(status).json(payload);
    };
    try {
      // The connection closed while the body was still arriving: the claim is gone and another share may hold it now.
      if (claim.released) return undefined;
      // The device may have been removed while its body was uploading.
      if (!deps.auth(req)) return finish(401, { ok: false, error: 'auth' });
      const buf = Buffer.isBuffer(req.body) ? req.body : null;
      if (!buf || buf.length === 0) return finish(400, { ok: false, error: 'nothing was shared' });
      const note = req.shareNote;
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
      let settledLate = false;
      const labelOf = () => { try { return deps.label(req.shareTab); } catch { return ''; } };
      const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(null), deps.deadlineMs ?? DELIVER_DEADLINE_MS); });
      claim.delivering = true;
      st.unsettled++;
      if (req.shareFile) liveFiles.set(req.shareFile, Infinity);
      const allowed = () => { try { return !!deps.auth(req); } catch { return false; } };
      const delivery = Promise.resolve().then(() => deps.deliver(req.shareTab, message, req.shareFile ? [req.shareFile] : null, allowed));
      // Settled for real (possibly long after the deadline): the receipt then says what really happened, and only then
      // may a retry run. An image is kept a while when its paste may still be read (typed, or not known).
      delivery.then((r) => r, () => null).then((r) => {
        st.unsettled--;
        const b = r?.body || {};
        const typedMaybe = !b.ok && (b.typed || !r);
        if (req.shareFile) keepFile(req.shareFile, typedMaybe ? TYPED_KEEP_MS : 0);
        if (req.shareId && settledLate) {
          const fp = fingerprint(req.shareTab, req.shareKind, req.shareNote);
          if (b.ok) receipts.set(req.shareId, { at: now(), status: 200, fp, body: { ok: true, sent: true, label: labelOf() } });
          else if (b.typed) receipts.set(req.shareId, { at: now(), status: 200, fp, body: { ok: true, sent: false, typed: true, enterPressed: b.enterPressed === true, label: labelOf(), note: b.note || '' } });
          // Refused late: nothing was typed, so the uncertain receipt stays (the phone was told to check the tab).
        }
        if (req.shareId) pendingIds.delete(req.shareId);
      });
      try {
        r = await Promise.race([delivery, deadline]);
      } catch { r = { status: 500, body: { ok: false, error: 'not delivered' } }; } finally { clearTimeout(timer); }
      if (r === null) settledLate = true;
      if (r === null) return finish(504, { ok: false, uncertain: true, error: 'The Mac did not finish delivering it in time. Check the tab before sending it again.' });
      const b = r?.body || {};
      const label = labelOf();
      if (b.ok) return finish(200, { ok: true, sent: true, label });
      if (b.typed) return finish(200, { ok: true, sent: false, typed: true, enterPressed: b.enterPressed === true, label, note: b.note || b.error || '' });
      // Nothing was typed, so nothing will ever read the image: it goes now rather than in a day.
      if (req.shareFile) { liveFiles.delete(req.shareFile); try { deps.discard?.(req.shareFile); } catch { /* best effort: the prune takes it */ } }
      return finish(r?.status && r.status >= 400 ? r.status : 409, { ok: false, error: b.error || 'not delivered', reason: b.reason || undefined });
    } finally {
      req.shareRelease();
    }
  });

  return { protectedFiles };
}
