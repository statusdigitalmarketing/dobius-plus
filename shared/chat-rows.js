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
 * SETTLED entries go past `max`; a pending one is never evicted, or a page of
 * more thumbnails than `max` re-requests every one on each poll and none
 * ever lands (Codex P2). Pending entries are bounded by what is on screen.
 */
export function createImageCache(fetchOne, max = 24) {
  const cache = new Map();
  const pending = new Set();
  const evict = () => {
    for (const [k, v] of cache) {
      if (cache.size <= max) return;
      if (!pending.has(v)) cache.delete(k);
    }
  };
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
    pending.add(p);
    p.then((url) => {
      pending.delete(p);
      if (!url && cache.get(ref) === p) cache.delete(ref); // a miss may succeed later
      evict();
    });
    evict();
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
  // Only the rows the mark covered, counted back from it: older rows loaded
  // ABOVE it (the phone paging back through history) are not news (Codex).
  const first = markedFirst(at, mark);
  if (first < 0) return -1; // rows it covered are gone from the top
  return sigOf(rows, first, at) !== mark.sig ? -1 : 0;
}

// The window's rows: a result can land in ANY row still open (queued
// messages can sit between two live turns), and only new content changes a
// row, so any change is news (Codex Medium, four times). 2000 rows at most.
const sigOf = (rows, from, to) => (from > to ? '' : rows.slice(from, to + 1).map(rowSig).join('|'));
// Where the rows a mark covered begin (a mark without a count covered the
// whole window it was made on).
const markedFirst = (at, mark) => (typeof mark.n === 'number' ? at - mark.n + 1 : 0);

/** The reading mark for the newest row, or null for none. */
export function markLatest(rows, keys) {
  return keys.length ? { key: keys[keys.length - 1], n: keys.length, sig: sigOf(rows, 0, rows.length - 1) } : null;
}

/**
 * The same mark, stretched over rows that appeared ABOVE the rows it covered
 * (an older page, or a tail read reaching further back), taking those rows as
 * they are now. The rows it already covered keep the state the reader saw,
 * so an unseen change there still counts, and a result that later lands in
 * one of the new rows is news too (Codex, twice). Run it on every render, so
 * new rows are captured the moment they first appear.
 *
 * Accepted residual: a window that starts partway through a turn gets that
 * turn's start merged into its first row when an older page loads, which
 * reads as a change and shows "New messages" once (cleared at the bottom).
 * Leaving the first row out to avoid it hid real tool results (Codex round 4).
 */
export function widenMark(rows, keys, mark) {
  if (!mark || !mark.key || typeof mark.n !== 'number' || !keys.length) return mark;
  const at = keys.lastIndexOf(mark.key);
  const first = at === -1 ? -1 : markedFirst(at, mark);
  if (first <= 0) return mark;
  const added = sigOf(rows, 0, first - 1);
  return { key: mark.key, n: at + 1, sig: mark.sig ? `${added}|${mark.sig}` : added };
}

/** The fingerprint half of a selector token (`base|fingerprint`), or ''. */
export function tokenFingerprint(token) {
  if (typeof token !== 'string') return '';
  const at = token.indexOf('|');
  return at === -1 ? '' : token.slice(at + 1);
}

// The option Claude Code's AskUserQuestion card offers for your own words ("3. Type something.", verified on 2.1.325):
// pressing its number opens an input in place, pasted text goes into it, Enter sends it as the answer. Chat sends typed
// text through it while such a card is up (Asana 1220550214785317), never as a bare paste plus Enter, which would pick
// whatever option is highlighted.
export const FREE_TEXT_LABEL = /^type something\.?$/i;
export function freeTextOption(sel) {
  if (!sel || !Array.isArray(sel.options)) return null;
  return sel.options.find((o) => FREE_TEXT_LABEL.test(optionMark(o?.label).text)) || null;
}

// A multi-select option's checkbox, as Claude Code draws it ("[ ] Cheese", "[✔] Cheese"; older builds "☐"/"☒"):
// { checked: true | false, text } for a checkbox row, { checked: null, text } for any other.
const OPTION_MARK = /^(\[[ x✓✔]\]|[☐☒])\s+/;
export function optionMark(label) {
  const s = String(label ?? '').trim();
  const m = s.match(OPTION_MARK);
  if (!m) return { checked: null, text: s };
  return { checked: m[1] !== '[ ]' && m[1] !== '☐', text: s.slice(m[0].length).trim() };
}
/** True when the card is a multi-select question (its options carry checkboxes). */
export function isMultiSelect(sel) {
  if (!sel || !Array.isArray(sel.options)) return false;
  // Every row but "Chat about this" carries a box: one answer that merely starts with "[ ]" does not make a
  // single-select question multi (Codex Medium, round 4).
  const body = sel.options.filter((o) => !/^chat about this$/i.test(String(o?.label ?? '').trim()));
  return body.length > 0 && body.every((o) => optionMark(o?.label).checked !== null);
}

/**
 * How a question card lays out (both chat views): `main` the answers ({ num, label, detail, checked }, checkbox marks
 * taken off the label), `free` Claude's "Type something" row ({ num, empty, text, checked }), `chat` its "Chat about
 * this" row ({ num }), `multi`, and `action` (a multi-select question's own "Submit" or "Next"). Claude's escape
 * hatches are its exact tail: "Type something." (in a multi-select question the last checkbox row, which keeps the
 * words typed into it), then optionally "Chat about this", last, with no description. Anything else that shares a
 * label is a real answer (Codex, twice).
 */
export function askLayout(sel) {
  const opts = Array.isArray(sel?.options) ? sel.options : [];
  const multi = isMultiSelect(sel);
  const action = sel?.action === 'Submit' || sel?.action === 'Next' ? sel.action : null;
  let cut = opts.length;
  let chat = null;
  const last = opts[cut - 1];
  if (last && !last.detail && optionMark(last.label).checked === null && /^chat about this$/i.test(optionMark(last.label).text)) {
    chat = { num: last.num };
    cut -= 1;
  }
  let free = null;
  const cand = opts[cut - 1];
  // Only an AskUserQuestion card (its question tab bar parsed as `steps`) has a free row: a plain menu can offer a
  // real option that reads "Type something", and its number picks it (Codex Medium).
  if (cand && sel?.steps) {
    const m = optionMark(cand.label);
    const empty = FREE_TEXT_LABEL.test(m.text) && !cand.detail;
    // A multi-select row keeps the words typed into it ("[✔] extra spicy"): it is the free row while the question
    // draws its own Submit / Next under it. A single-select row only while it still reads "Type something.".
    if (multi ? m.checked !== null && (empty || (action && chat)) : m.checked === null && empty) {
      free = { num: cand.num, empty, text: empty ? '' : [m.text, cand.detail].filter(Boolean).join(' '), checked: m.checked === true };
      cut -= 1;
    }
  }
  const main = opts.slice(0, cut).map((o) => {
    const m = optionMark(o?.label);
    return { num: o?.num, label: m.text, detail: o?.detail || '', checked: m.checked };
  });
  return { multi, main, free, chat, action };
}

/**
 * The React key a phone or desktop question card mounts under. A multi-select question keeps one key while its
 * boxes are ticked, so a tap never remounts the card (which dropped its scroll position: Sam, 2026-11-19); the key
 * leaves out the checkbox marks, the free row's words and `fp` (the fingerprint covers the marks). The press guard,
 * not the key, is what binds a tap to the card it began on (it compares tokens, which every tick changes). Every
 * other card keys exactly as selectorKey does.
 */
export function askCardKey(sel) {
  const lay = askLayout(sel);
  if (!lay.multi || !sel?.steps || !Array.isArray(sel.steps.labels)) return selectorKey(sel);
  return JSON.stringify(['multi', sel.steps.current, sel.steps.labels, String(sel.prompt ?? ''),
    lay.main.map((o) => [o.num, o.label, o.detail]), lay.free?.num ?? null, lay.chat?.num ?? null]);
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
  // A timed prompt's seconds tick in its text: the same card, not a new one
  // (a remount every second dropped a press mid-tap: Codex, round 16).
  const prompt = String(sel.prompt ?? '');
  // Also when the card text starts partway into the timer row, even inside
  // the time itself: the digits and colons before its fixed ending (Codex, 26).
  // The sentence may wrap anywhere around the time (Codex, round 27).
  const shown = sel.timed ? prompt.replace(/[\d:]+(?=\s*,\s*to\s+avoid\s+holding)/g, '#:##') : prompt;
  return JSON.stringify([String(sel.fp ?? ''), shown, sel.options.map((o) => [o?.num, String(o?.label ?? ''), String(o?.detail ?? '')])]);
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
// A selector token `<run>:<pty>:<input>:<output>|<fingerprint>` without its
// output count; '' for anything else.
function withoutOutput(token) {
  if (typeof token !== 'string') return '';
  const base = token.split('|')[0];
  const at = base.lastIndexOf(':');
  return at > 0 ? base.slice(0, at) : '';
}

export function createPressGuard({ defer = (fn) => setTimeout(fn, RELEASE_MS), now = () => Date.now() } = {}) {
  // A FRESH poison object each time: a release timer captured for an older
  // poison must never clear a newer one (Codex Critical, round 18).
  const POISON = Symbol('poison');
  const poison = () => ({ [POISON]: true });
  const poisoned = (c) => !!c && c[POISON] === true;
  // A timed card (Claude's unattended-session timer) gets a new token every
  // tick, so it is the same card while its fingerprint (timer masked) is;
  // the Mac then checks the click against the timer itself. Untimed cards
  // keep the exact token (Codex, round 16).
  // Only the OUTPUT count may differ (the timer repainting): the same app
  // run, PTY and INPUT count, so nothing was typed or selected anywhere in
  // between, an arrow key from another surface included (Codex P1, round 17).
  const same = (a, b) => a !== undefined && !poisoned(a) && (b?.token == null ? a === b
    : a?.token === b.token || (!!a?.timed && !!b?.timed && !!a.fp && a.fp === b.fp
      && typeof a.token === 'string' && withoutOutput(a.token) === withoutOutput(b.token)));
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
    // While anything is held, the record keeps the card the FIRST press
    // began on: a second press can confirm it or poison it, never replace it
    // (a second finger on a refreshed timed card swapped in its token: Codex
    // P1, round 19).
    if (!busy(sl)) sl.card = card;
    else if (!same(sl.card, card)) sl.card = poison();
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
    /**
     * After take() said yes: the card the press BEGAN on, whose token is the
     * one to send (or `card` when no press was recorded). A timed card's
     * token moves every tick; sending the press-start token makes the Mac
     * check the timer against that reading, so a held press cannot approve
     * a replacement whose timer started over (Codex P1, round 18).
     */
    pressedCard(e, card) {
      const c = e && e.detail > 0 ? ptr.card : key.card;
      return c !== undefined && !poisoned(c) && same(c, card) ? c : card;
    },
  };
}

// --- One line for a run of steps --------------------------------------------
// The Claude app reads a run of tool calls as a sentence ("Created a file, ran
// a command +12 -0", "Used 4 tools"); so do both chat views.
const STEP_PHRASES = {
  Write: ['created a file', 'created {n} files'],
  Edit: ['edited a file', 'edited {n} files'],
  MultiEdit: ['edited a file', 'edited {n} files'],
  NotebookEdit: ['edited a notebook', 'edited {n} notebooks'],
  Read: ['read a file', 'read {n} files'],
  Bash: ['ran a command', 'ran {n} commands'],
  Grep: ['searched the code', 'searched the code {n} times'],
  Glob: ['looked for files', 'looked for files {n} times'],
  WebFetch: ['fetched a page', 'fetched {n} pages'],
  WebSearch: ['searched the web', 'searched the web {n} times'],
  Task: ['ran an agent', 'ran {n} agents'],
  Agent: ['ran an agent', 'ran {n} agents'],
  TodoWrite: ['updated the plan', 'updated the plan'],
  Skill: ['used a skill', 'used {n} skills'],
};
const lineCount = (t) => (t ? String(t).split('\n').length : 0);

/**
 * { text, added, removed } for a run of step blocks: up to two kinds of tool
 * as a phrase ("Created a file, ran a command"), more than that as "Used N
 * tools"; thinking alone is "Thought". added/removed: lines across the run's
 * edits and writes (an edit's old and new text, so a rough count).
 */
export function stepSummary(steps) {
  const tools = (steps || []).filter((b) => b && b.type === 'tool');
  if (!tools.length) return { text: 'Thought', added: 0, removed: 0 };
  const counts = new Map();
  let added = 0;
  let removed = 0;
  for (const b of tools) {
    const key = STEP_PHRASES[b.name] ? (b.name === 'MultiEdit' ? 'Edit' : b.name === 'Agent' ? 'Task' : b.name) : b.name;
    counts.set(key, (counts.get(key) || 0) + 1);
    if (b.diff) { added += lineCount(b.diff.new); removed += lineCount(b.diff.old); }
  }
  let text;
  if (counts.size > 2) text = `Used ${tools.length} tools`;
  else {
    text = [...counts].map(([name, n]) => {
      const ph = STEP_PHRASES[name];
      if (!ph) return n > 1 ? `used ${name} ${n} times` : `used ${name}`;
      return (n > 1 ? ph[1] : ph[0]).replace('{n}', String(n));
    }).join(', ');
    text = text.charAt(0).toUpperCase() + text.slice(1);
  }
  return { text, added, removed };
}


/**
 * Older turns fold (Bryan, Asana 1220559095116745): everything before the newest message the person sent shows only
 * that message and Claude's last reply text, with one "Show N steps" toggle per turn. The exchange after the newest
 * sent message stays as it is, live.
 *
 * A turn is everything between two messages the person sent: Claude's rows plus anything injected between them (a
 * skill body, hook context, a queued send that never landed), so one exchange is always ONE folded segment with one
 * identity (Codex r4 P2). Only a sent message is a boundary (`sent` below): a queued send, a command row and injected
 * `meta` text can sit inside an exchange Claude is still working on, and folding there would hide the tool it is
 * running (Codex P1 rounds 1 to 4). Erring this way only leaves a finished exchange open a little longer.
 *
 * Returns segments in row order: { kind: 'row', index } or
 * { kind: 'turn', start, end, steps, summary, anchor }: start..end are the turn's row indexes (inclusive), steps
 * counts its tool and thinking blocks, summary is Claude's last text in it (null when none), and anchor is the index of
 * the sent message right after it, whose key is the turn's stable identity (the turn's own first row changes as the
 * transcript window slides: Codex P2). A turn with no steps is not folded: its rows come back as row segments.
 */
export function foldTurns(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const sent = (r) => r?.role === 'user' && !r.queued && !r.command && !r.meta;
  let lastPerson = -1;
  for (let i = list.length - 1; i >= 0; i--) if (sent(list[i])) { lastPerson = i; break; }
  const out = [];
  let i = 0;
  while (i < list.length) {
    if (i >= lastPerson || sent(list[i])) { out.push({ kind: 'row', index: i }); i++; continue; }
    const start = i;
    let steps = 0;
    let summary = null;
    for (; i < lastPerson && !sent(list[i]); i++) {
      if (list[i]?.role !== 'assistant') continue;
      const blocks = normalizeBlocks(list[i].blocks);
      if (blocks) {
        for (const b of blocks) {
          if (b.type === 'text') { if (b.text.trim()) summary = b.text; } else steps++;
        }
      } else if (String(list[i].content ?? '').trim()) summary = String(list[i].content);
    }
    // i is now the sent message after the turn (lastPerson at the latest).
    if (steps) out.push({ kind: 'turn', start, end: i - 1, steps, summary, anchor: i });
    else for (let j = start; j < i; j++) out.push({ kind: 'row', index: j });
  }
  return out;
}
