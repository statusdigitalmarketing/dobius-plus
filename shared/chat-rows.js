// Transcript rows as both chat views render them: the desktop Chat pane and
// the phone's Chat view.
//
// RENDERER-ONLY, like loose-dismiss.js: both vite builds inline it, and
// `shared/` is not packaged for the main process.
//
// The rows come from main (data-service entryToMessage + mergeTurns), but a
// renderer must not crash on a row it does not understand: an older or newer
// Mac, or a transcript record of a shape nobody has seen yet, would otherwise
// blank the whole conversation (Codex Medium). So blocks are checked here,
// field by field, and a row whose blocks are unusable renders its plain
// `content` instead.

const str = (v) => (typeof v === 'string' ? v : undefined);

function normBlock(b) {
  if (!b || typeof b !== 'object') return null;
  if (b.type === 'text' || b.type === 'thinking') {
    return typeof b.text === 'string' && b.text ? { type: b.type, text: b.text } : null;
  }
  if (b.type !== 'tool' || typeof b.name !== 'string' || !b.name) return null;
  const out = { type: 'tool', name: b.name };
  if (str(b.id)) out.id = b.id;
  if (str(b.summary)) out.summary = b.summary;
  if (str(b.input)) out.input = b.input;
  if (b.diff && typeof b.diff === 'object' && (typeof b.diff.old === 'string' || typeof b.diff.new === 'string')) {
    out.diff = { old: str(b.diff.old) || '', new: str(b.diff.new) || '' };
  }
  if (str(b.result) !== undefined) out.result = b.result;
  if (b.isError === true) out.isError = true;
  const images = toolImages(b.images);
  if (images.length) out.images = images;
  return out;
}

// Image references a tool result carried (main sends refs, never pixels).
const IMAGE_REF = /^[0-9a-fA-F-]{8,64}:\d{1,3}:\d{1,2}$/;
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/;
function toolImages(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((i) => i && typeof i.ref === 'string' && IMAGE_REF.test(i.ref) && typeof i.mime === 'string' && IMAGE_MIME.test(i.mime))
    .slice(0, 6).map((i) => ({ ref: i.ref, mime: i.mime }));
}

/**
 * Every tool image in a run of steps, in order: what a chat view shows as
 * thumbnails beside the (possibly folded) steps.
 */
export function stepImages(steps) {
  const out = [];
  for (const b of steps || []) for (const i of b.images || []) if (out.length < 8) out.push(i);
  return out;
}

/**
 * A small cache in front of a view's image fetch(ref) -> Promise<{mime,data}>,
 * so a re-render or a poll never fetches a picture twice. Bounded: the oldest
 * entries go past `max`.
 */
export function createImageCache(fetchOne, max = 24) {
  const cache = new Map();
  return (ref) => {
    if (cache.has(ref)) {
      const hit = cache.get(ref);
      cache.delete(ref);
      cache.set(ref, hit);
      return hit;
    }
    const p = Promise.resolve().then(() => fetchOne(ref)).then(
      (img) => (img && IMAGE_MIME.test(img.mime) && typeof img.data === 'string' ? `data:${img.mime};base64,${img.data}` : null),
      () => null,
    );
    cache.set(ref, p);
    p.then((url) => { if (!url) cache.delete(ref); }); // a miss may succeed later
    while (cache.size > max) cache.delete(cache.keys().next().value);
    return p;
  };
}

/** The row's usable blocks, or null to render `content` as before. */
export function normalizeBlocks(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) return null;
  const out = [];
  for (const b of blocks) { const n = normBlock(b); if (n) out.push(n); }
  return out.length ? out : null;
}

/**
 * What a row's copy button copies, and what decides whether it is long: the
 * reply text the user reads. For a blocks row that is its text blocks in full
 * (the row's `content` is only a capped plain-text copy of them).
 */
export function rowText(content, blocks) {
  if (!blocks) return String(content ?? '');
  return blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
}

/**
 * A React key per row. Rows carry their transcript record id when main sent
 * one, so a row's open/closed state stays with it while the 200-row window
 * slides; index keys moved one row's state onto its neighbour (Codex Medium).
 * Rows without an id (queued sends, an older Mac) fall back to their index,
 * and a repeated id is made unique rather than trusted.
 */
export function rowKeys(rows) {
  const seen = new Set();
  return rows.map((m, i) => {
    let k = m && typeof m.id === 'string' && m.id ? `id:${m.id}` : `i:${i}`;
    if (seen.has(k)) k = `${k}#${i}`;
    seen.add(k);
    return k;
  });
}

/**
 * A cheap fingerprint of one row, so a view can tell that the newest row GREW
 * (a live turn folds new steps and text into one row) and not only that new
 * rows arrived. Rows without an id are keyed by index, so a different row can
 * take the marked key when the window slides: the role, the timestamp and
 * the ends of the text tell two such rows apart (Codex Medium, twice).
 */
export function rowSig(m) {
  if (!m) return '';
  const b = Array.isArray(m.blocks) ? m.blocks : null;
  const done = b ? b.filter((x) => x && x.result !== undefined).length : 0;
  const c = String(m.content ?? '');
  return `${m.role}:${m.timestamp ?? ''}:${c.length}:${b ? b.length : 0}:${done}:${c.slice(0, 32)}:${c.slice(-32)}`;
}

/**
 * How many rows are new below a reading mark: a count, -1 for "something
 * new, count unknown" (the mark slid out of the window, or the marked row
 * itself grew), or 0.
 */
export function unseenSince(rows, keys, mark) {
  if (!mark || !mark.key || !keys.length) return 0;
  const at = keys.lastIndexOf(mark.key);
  if (at === -1) return -1;
  if (at < keys.length - 1) return keys.length - 1 - at;
  return tailSig(rows, at) !== mark.sig ? -1 : 0;
}

// The whole window's rows: a result can land in ANY row still open (queued
// messages can sit between two live turns), and only new content changes a
// row, so any change is news (Codex Medium, four times). 200 rows at most.
const tailSig = (rows, at) => rows.slice(0, at + 1).map(rowSig).join('|');

/** The reading mark for the newest row, or null for none. */
export function markLatest(rows, keys) {
  return keys.length ? { key: keys[keys.length - 1], sig: tailSig(rows, rows.length - 1) } : null;
}

/** The fingerprint half of a selector token (`base|fingerprint`), or ''. */
export function tokenFingerprint(token) {
  if (typeof token !== 'string') return '';
  const at = token.indexOf('|');
  return at === -1 ? '' : token.slice(at + 1);
}

/**
 * A React key for a selector card. A different prompt remounts the card, so a
 * press that began on prompt A's button can never complete as a click on
 * prompt B's (React would otherwise reuse the pressed button and swap in B's
 * handler: Codex Critical). What the card SAYS is not enough: two edit
 * prompts can ask the same question with the same options about different
 * diffs that the card does not show (Codex Critical, two lenses). So the key
 * also carries `sel.fp`, the server's fingerprint of the whole prompt
 * context, the same value the answer is checked against. The same prompt
 * with a refreshed token keeps its buttons.
 */
export function selectorKey(sel) {
  if (!sel || !Array.isArray(sel.options)) return 'none';
  return JSON.stringify([String(sel.fp ?? ''), String(sel.prompt ?? ''), sel.options.map((o) => [o?.num, String(o?.label ?? ''), String(o?.detail ?? '')])]);
}

/**
 * Binds a selector click to the press it ended. A press must END on the card
 * it began on: if a new prompt arrived mid-press, React reuses the pressed
 * button and the click carries the NEW card, whose token is valid (Codex
 * Critical, rounds 12 to 15). Keys and fingerprints cannot promise that.
 *
 * Pointer presses and key presses live in separate slots. Each slot tracks
 * what is physically HELD (pointer ids, Enter/Space), and its record lives
 * from the first press until just after the last release, so no other input
 * can erase or overwrite it mid-press:
 * - a second press on a DIFFERENT card while one is held poisons the slot;
 * - auto-repeat and a re-press of a held key do not re-record;
 * - a rejected click never clears anything;
 * - a fresh press with nothing held starts a new record.
 * A pointer click (detail > 0) needs a pointer record for this card. A
 * detail-0 click (Enter/Space, assistive tech, a synthetic click) needs the
 * key record to match, or no key held at all (then it answers what it shows).
 * Same card: the same token when the Mac sends tokens (answering a prompt
 * always changes it, a re-read keeps it); with no tokens (an older Mac), the
 * very card object read. The release clear waits RELEASE_MS because a touch
 * click can trail its pointerup (iOS).
 */
const RELEASE_MS = 500;
// How long a press held through a window switch keeps poisoning its slot
// when its release never reaches this window (it was released elsewhere).
const ORPHAN_MS = 10000;
const ACTIVATION_KEYS = new Set(['Enter', ' ']);
export function createPressGuard({ defer = (fn) => setTimeout(fn, RELEASE_MS), now = () => Date.now() } = {}) {
  // A FRESH poison object each time: a release timer captured for an older
  // poison must never clear a newer one (Codex Critical, round 18).
  const POISON = Symbol('poison');
  const poison = () => ({ [POISON]: true });
  const poisoned = (c) => !!c && c[POISON] === true;
  const same = (a, b) => a !== undefined && !poisoned(a) && (b?.token == null ? a === b : a?.token === b.token);
  // held: pressed here and not yet released. orphans: id -> time, pressed
  // before a blur and not yet seen released (Codex Critical, rounds 16-19).
  const slot = () => ({ card: undefined, held: new Set(), orphans: new Map(), clearing: 0 });
  const ptr = slot();
  const key = slot();
  const liveOrphans = (sl) => {
    const t = now();
    for (const [id, at] of sl.orphans) if (t - at >= ORPHAN_MS) sl.orphans.delete(id);
    return sl.orphans.size;
  };
  const busy = (sl) => sl.held.size > 0 || liveOrphans(sl) > 0;
  const down = (sl, id, card) => {
    if (sl.held.has(id)) return; // auto-repeat, or a re-press never released
    sl.orphans.delete(id); // a fresh (non-repeat) press proves it was released
    sl.card = !busy(sl) || same(sl.card, card) ? card : poison();
    sl.held.add(id);
  };
  const clearSoon = (sl) => {
    const c = sl.card;
    sl.clearing += 1;
    defer(() => { sl.clearing -= 1; if (!busy(sl) && sl.card === c) sl.card = undefined; });
  };
  const up = (sl, id) => {
    // Only a release of something this slot tracks counts: an unrelated
    // key's release must not clear a press still held (Codex Critical).
    if (!sl.held.delete(id) && !sl.orphans.delete(id)) return;
    if (!busy(sl)) clearSoon(sl);
  };
  // A poisoned slot whose orphans all EXPIRED (released in another window)
  // is free again, so assistive tech is never wedged (Codex Medium). A slot
  // whose orphan was released HERE waits for its own delayed clear instead:
  // the click right after that release must still be refused.
  const settled = (sl) => { if (poisoned(sl.card) && !busy(sl) && !sl.clearing) sl.card = undefined; return sl.card; };
  return {
    pointerDown(e, card) { if (e.button === 0 || e.button === undefined) down(ptr, e.pointerId ?? 'p', card); },
    pointerUp(e) { up(ptr, e.pointerId ?? 'p'); },
    keyDown(e, card) { if (!e.repeat && ACTIVATION_KEYS.has(e.key)) down(key, e.key, card); },
    keyUp(e) { if (ACTIVATION_KEYS.has(e.key)) up(key, e.key); },
    /**
     * Focus left the window, so releases may never arrive. What is held
     * becomes an orphan and the slot is POISONED, not erased: a key held
     * through the switch and released later must not find an empty slot and
     * answer whatever card is showing then. The orphan's own release, a fresh
     * press of it, or ORPHAN_MS without either, ends it.
     */
    reset() {
      const t = now();
      for (const sl of [ptr, key]) {
        for (const id of sl.held) sl.orphans.set(id, t);
        sl.held.clear();
        sl.card = liveOrphans(sl) || poisoned(sl.card) ? poison() : undefined;
      }
    },
    /** True if this click may answer `card`. */
    take(e, card) {
      if (e && e.detail > 0) return same(settled(ptr), card);
      const k = settled(key);
      return k === undefined || same(k, card);
    },
  };
}
