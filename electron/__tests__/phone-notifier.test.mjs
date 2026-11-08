// Phone notifications by event: debounce, rate limits, coalescing, quiet hours, and what a notification may say.
// Run: npm run test:phonenotifier
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPhoneNotifier, alertSettings, inQuietHours, cleanLabel, tabTag, ALERT_DEFAULTS,
  TAB_GAP_MS, GLOBAL_MAX, HANDOFF_WAIT_MS,
} from '../phone-notifier.js';

// A fake clock: timers fire in order as time is advanced.
function rig({ alerts = {}, status = {}, looking = () => false, labels = {}, waiting = () => true, minute = 12 * 60, quitting = () => false } = {}) {
  let t = 1_000_000;
  let timers = [];
  let nextId = 1;
  const sent = [];
  const st = { ...status };
  const cfg = { alerts: { ...alerts }, morningAt: '08:00', quietAfter: '20:00' };
  const n = createPhoneNotifier({
    now: () => t,
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ id, at: t + ms, fn }); return id; },
    clearTimer: (id) => { timers = timers.filter((x) => x.id !== id); },
    settings: () => cfg,
    minuteOfDay: () => minute,
    statusOf: (id) => st[id] ?? null,
    labelFor: (id) => labels[id] || { label: `Tab ${id}`, project: 'proj' },
    handoffWaiting: waiting,
    isLooking: looking,
    quitting,
    send: (x) => { sent.push({ ...x, at: t }); return Promise.resolve(); },
  });
  const advance = (ms) => {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      t = next.at;
      next.fn();
    }
    t = end;
  };
  return { n, sent, st, cfg, advance };
}

test('a permission prompt notifies once after the debounce, with a label and a fixed phrase only', () => {
  const r = rig({ status: { a: 'needs' }, labels: { a: { label: 'Fix login', project: 'webapp' } } });
  r.n.tabHook('a', 'working');
  r.n.tabHook('a', 'needs', null);
  r.advance(1000);
  assert.equal(r.sent.length, 0, 'debounced');
  r.advance(1000);
  assert.equal(r.sent.length, 1);
  assert.deepEqual(Object.keys(r.sent[0]).sort(), ['at', 'body', 'current', 'kind', 'tabId', 'tag', 'title']);
  assert.equal(r.sent[0].current(), true);
  r.st.a = 'working';
  assert.equal(r.sent[0].current(), false, 'answered: the sender stops before the next phone');
  assert.equal(r.sent[0].title, 'webapp');
  assert.equal(r.sent[0].body, 'Fix login needs you');
  assert.equal(r.sent[0].kind, 'needs');
  assert.match(r.sent[0].tag, /^t[0-9a-f]{16}$/);
  assert.equal(r.sent[0].tag.includes('a'), r.sent[0].tag === tabTag('a') && /a/.test(tabTag('a')));
});

test('a prompt answered at the Mac inside the debounce never notifies', () => {
  const r = rig({ status: { a: 'needs' } });
  r.n.tabHook('a', 'needs', null);
  r.advance(500);
  r.n.tabInput('a'); // the answer: no hook follows
  r.st.a = 'working';
  r.advance(5000);
  assert.equal(r.sent.length, 0);
});

test('the same red told twice (PermissionRequest then the permission_prompt backstop) is one buzz', () => {
  const r = rig({ status: { a: 'needs' } });
  r.n.tabHook('a', 'needs', null);
  r.advance(6000);
  r.n.tabHook('a', 'needs', null);
  r.advance(TAB_GAP_MS * 2);
  assert.equal(r.sent.length, 1);
  // After an answer, a new prompt is a new red.
  r.n.tabInput('a');
  r.n.tabHook('a', 'needs', null);
  r.advance(TAB_GAP_MS * 2);
  assert.equal(r.sent.length, 2);
});

test('a prompt answered then the turn finishing inside the debounce still says finished', () => {
  const r = rig({ status: { a: 'needs' } });
  r.n.tabHook('a', 'needs', null);
  r.advance(300);
  r.n.tabInput('a');
  r.n.tabHook('a', 'done', null);
  r.st.a = 'done';
  r.advance(3000);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].kind, 'done');
});

test('done: Claude idle-for-a-minute is never "finished", and a new turn inside the debounce cancels it', () => {
  const r = rig({ status: { a: 'done' } });
  r.n.tabHook('a', 'working');
  r.n.tabHook('a', 'done', 'idle');
  r.advance(5000);
  assert.equal(r.sent.length, 0);
  r.n.tabHook('a', 'done', null);
  r.advance(1000);
  r.n.tabHook('a', 'working');
  r.st.a = 'working';
  r.advance(5000);
  assert.equal(r.sent.length, 0);
});

test('a flapping tab is held to one buzz per gap; the newest event goes out when the gap ends if still true', () => {
  const r = rig({ status: { a: 'done' } });
  for (let i = 0; i < 6; i += 1) {
    r.n.tabHook('a', 'working');
    r.n.tabHook('a', 'done', null);
    r.advance(3000);
  }
  assert.equal(r.sent.length, 1, 'one inside the gap');
  r.advance(TAB_GAP_MS);
  assert.equal(r.sent.length, 2, 'the held one when the gap ended');
  assert.ok(r.sent[1].at - r.sent[0].at >= TAB_GAP_MS);
});

test('a red may follow a green at once', () => {
  const r = rig({ status: { a: 'done' } });
  r.n.tabHook('a', 'done', null);
  r.advance(2500);
  r.st.a = 'needs';
  r.n.tabHook('a', 'needs', null);
  r.advance(2000);
  assert.deepEqual(r.sent.map((s) => s.kind), ['done', 'needs']);
});

test('a burst across tabs becomes one summary; more than the cap in ten minutes is dropped', () => {
  const r = rig({ status: { a: 'done', b: 'done', c: 'needs' } });
  r.n.tabHook('a', 'done', null);
  r.n.tabHook('b', 'done', null);
  r.n.tabHook('c', 'needs', null);
  r.advance(2500);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].kind, 'summary');
  assert.equal(r.sent[0].tabId, null);
  assert.match(r.sent[0].body, /1 need you/);
  const r2 = rig();
  for (let i = 0; i < GLOBAL_MAX + 5; i += 1) { r2.st[`t${i}`] = 'done'; r2.n.tabHook(`t${i}`, 'done', null); r2.advance(2500); }
  assert.equal(r2.sent.length, GLOBAL_MAX);
});

test('round 1: a burst waits for its members (never sends one early); an answer inside the wait still cancels', () => {
  const r = rig({ status: { a: 'done', b: 'needs' } });
  r.n.tabHook('a', 'done', null); // due at +2000
  r.advance(1000);
  r.n.tabHook('b', 'needs', null); // due at +2500
  r.advance(1100); // +2100: a is due, b is not yet; the flush waits for b
  assert.equal(r.sent.length, 0);
  r.n.tabInput('b'); // b answered at the Mac before its own debounce ended
  r.st.b = 'working';
  r.advance(2000);
  assert.deepEqual(r.sent.map((s) => s.kind), ['done']);
});

test('round 1: with no phone to tell, nothing counts against the limits', () => {
  let phones = false;
  // 25 finishes with nobody subscribed, then a red once a phone exists: it still goes out.
  const sent = [];
  let t = 0;
  let timers = [];
  const m = createPhoneNotifier({
    now: () => t,
    setTimer: (fn, ms) => { timers.push({ at: t + ms, fn }); return timers.length; },
    clearTimer: () => {},
    settings: () => ({}),
    statusOf: (id) => (id === 'red' ? 'needs' : 'done'),
    labelFor: () => ({ label: 'x', project: 'p' }),
    hasRecipients: () => phones,
    send: (x) => { sent.push(x); return Promise.resolve(); },
  });
  const run = (ms) => { const end = t + ms; for (;;) { timers.sort((a, b) => a.at - b.at); const x = timers[0]; if (!x || x.at > end) break; timers.shift(); t = x.at; x.fn(); } t = end; };
  for (let i = 0; i < 25; i += 1) { m.tabHook(`t${i}`, 'done', null); run(3000); }
  assert.equal(sent.length, 0);
  phones = true;
  m.tabHook('red', 'needs', null);
  run(3000);
  assert.equal(sent.length, 1);
});

test('round 1: a handoff whose command was dismissed does not swallow a new permission prompt', () => {
  let waiting = true;
  const r = rig({ status: { a: 'needs' }, waiting: () => waiting });
  r.n.tabHook('a', 'needs', null);
  r.advance(2000);
  assert.equal(r.sent.length, 1);
  r.n.handoffAdded('a'); // held by the 30 s gap... (already notified as needs: skipped)
  r.n.tabHook('a', 'working');
  r.n.tabHook('a', 'needs', 'handoff');
  r.n.handoffAdded('a');
  waiting = false; // dismissed on the Mac
  r.n.tabHook('a', 'working');
  r.n.tabHook('a', 'needs', null); // a real permission prompt now
  r.advance(TAB_GAP_MS + 5000);
  assert.equal(r.sent.length, 2);
  assert.equal(r.sent[1].kind, 'needs');
});

test('round 2: a red behind a live handoff still goes out if the command is dismissed first; input clears the last green', () => {
  let waiting = true;
  const r = rig({ status: { a: 'needs' }, waiting: () => waiting });
  r.n.tabHook('a', 'needs', null);
  r.advance(2000); // sent: needs
  r.n.tabHook('a', 'working');
  r.n.handoffAdded('a'); // held by the 30 s gap
  r.n.tabHook('a', 'needs', null); // a real prompt behind the handoff
  waiting = false; // the command dismissed before the held handoff fires
  r.advance(TAB_GAP_MS + 1000);
  assert.deepEqual(r.sent.map((s) => s.kind), ['needs', 'needs']);
  // A finish, Enter in the tab, then another finish with no hook between: both are told.
  const g = rig({ status: { b: 'done' } });
  g.n.tabHook('b', 'done', null);
  g.advance(3000);
  g.n.tabInput('b');
  g.n.tabHook('b', 'done', null);
  g.advance(TAB_GAP_MS + 3000);
  assert.equal(g.sent.length, 2);
});

test('round 3: a sent prompt stops being current once answered, even if a later prompt makes the tab red again', () => {
  const r = rig({ status: { a: 'needs' } });
  r.n.tabHook('a', 'needs', null);
  r.advance(2000);
  const sentA = r.sent[0];
  assert.equal(sentA.current(), true);
  r.n.tabInput('a'); // answered while the send is in flight
  r.n.tabHook('a', 'needs', null); // prompt B, red again
  assert.equal(sentA.current(), false, 'prompt A is not prompt B');
});

test('round 3: a summary is current while any of it is; a handoff sent as "needs you" is judged by its command', () => {
  const r = rig({ status: { a: 'needs', b: 'needs', c: 'needs' } });
  for (const id of ['a', 'b', 'c']) r.n.tabHook(id, 'needs', null);
  r.advance(2000);
  assert.equal(r.sent[0].kind, 'summary');
  assert.equal(r.sent[0].current(), true);
  for (const id of ['a', 'b', 'c']) r.n.tabInput(id);
  assert.equal(r.sent[0].current(), false);
  let waiting = true;
  const h = rig({ alerts: { handoff: false }, status: { x: 'working' }, waiting: () => waiting });
  h.n.handoffAdded('x');
  h.advance(1000);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].kind, 'needs');
  assert.equal(h.sent[0].current(), true, 'the command still waits, though the tab is working');
  waiting = false;
  assert.equal(h.sent[0].current(), false);
});

test('round 3: a red behind a dismissed handoff keeps its own debounce; a failure right after a red waits out the gap', () => {
  let waiting = true;
  const r = rig({ status: { a: 'needs' }, waiting: () => waiting });
  r.n.handoffAdded('a'); // due at +300
  r.advance(100);
  r.n.tabHook('a', 'working');
  r.n.tabHook('a', 'needs', null); // red at +100, its own debounce to +1600
  waiting = false;
  r.advance(400); // handoff due, dead: the red is not sent yet
  assert.equal(r.sent.length, 0);
  r.n.tabInput('a'); // answered inside its debounce
  r.st.a = 'working';
  r.advance(3000);
  assert.equal(r.sent.length, 0);
  const f = rig({ status: { b: 'needs' } });
  f.n.tabHook('b', 'needs', null);
  f.advance(2000);
  f.n.tabFailed('b');
  f.n.tabHook('b', 'exit');
  f.advance(2000);
  assert.equal(f.sent.length, 1, 'held by the tab gap');
  f.advance(TAB_GAP_MS);
  assert.deepEqual(f.sent.map((s) => s.kind), ['needs', 'failed']);
});

test('round 4: a finish told twice still notifies once; one tab never gets two buzzes in one flush', () => {
  const r = rig({ status: { a: 'done' } });
  r.n.tabHook('a', 'working');
  r.n.tabHook('a', 'done', null);
  r.advance(100);
  r.n.tabHook('a', 'done', null);
  r.advance(3000);
  assert.deepEqual(r.sent.map((s) => s.kind), ['done']);
  const f = rig({ status: { b: 'needs' } });
  f.n.tabFailed('b'); // due +500
  f.n.tabHook('b', 'needs', null); // due +1500, flushed together with the failure (waits for it)
  f.advance(2000);
  assert.equal(f.sent.length, 1, 'the second waits its gap');
  f.advance(TAB_GAP_MS + 1000);
  assert.equal(f.sent.length, 2);
});

test('round 5: a finish behind a dismissed handoff still goes out; turning tab names off stops a names notification mid-send', () => {
  let waiting = true;
  const r = rig({ status: { a: 'done' }, waiting: () => waiting });
  r.n.tabHook('a', 'needs', null);
  r.st.a = 'needs';
  r.advance(2000); // needs sent
  r.n.handoffAdded('a'); // already covered by the needs a moment ago: nothing queued
  r.n.tabHook('a', 'working');
  r.n.tabHook('a', 'needs', 'handoff');
  r.n.handoffAdded('a'); // held by the gap
  r.n.tabHook('a', 'working');
  r.n.tabHook('a', 'done', null); // behind the live handoff
  r.st.a = 'done';
  waiting = false; // dismissed
  r.advance(TAB_GAP_MS + 3000);
  assert.deepEqual(r.sent.map((s) => s.kind), ['needs', 'done']);
  const n = rig({ status: { b: 'needs' } });
  n.n.tabHook('b', 'needs', null);
  n.advance(2000);
  assert.equal(n.sent[0].current(), true);
  n.cfg.alerts.names = false;
  assert.equal(n.sent[0].current(), false);
});

test('switches: each event obeys its own; a handed-back command goes out as "needs you" with only that one on', () => {
  const r = rig({ alerts: { done: false, team: false }, status: { a: 'done', b: 'needs' } });
  r.n.tabHook('a', 'done', null);
  r.n.teamMessage('Brett');
  r.advance(5000);
  assert.equal(r.sent.length, 0);
  r.cfg.alerts.handoff = false;
  r.n.tabHook('b', 'needs', 'handoff');
  r.n.handoffAdded('b');
  r.advance(1000);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].kind, 'needs');
  r.cfg.alerts.needs = false;
  r.n.tabHook('c', 'needs', null);
  r.st.c = 'needs';
  r.advance(5000);
  assert.equal(r.sent.length, 1);
});

test('a needs;handoff red waits for the command to be listed, then says "handed back"; a later turn does not cancel it', () => {
  const r = rig({ status: { a: 'needs' } });
  r.n.tabHook('a', 'needs', 'handoff');
  r.advance(3000);
  assert.equal(r.sent.length, 0, 'waiting for Tasks > Commands');
  r.n.handoffAdded('a');
  r.n.tabHook('a', 'working'); // a background agent starts a turn; the command still waits
  r.st.a = 'working';
  r.advance(1000);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].kind, 'handoff');
  assert.match(r.sent[0].body, /handed back a command to run$/);
  // No command ever listed: the red goes out as "needs you" when the wait ends.
  const r2 = rig({ status: { b: 'needs' } });
  r2.n.tabHook('b', 'needs', 'handoff');
  r2.advance(HANDOFF_WAIT_MS + 10);
  assert.equal(r2.sent[0].kind, 'needs');
  // A command already run or dismissed before the buzz: nothing.
  const r3 = rig({ status: { c: 'needs' }, waiting: () => false });
  r3.n.handoffAdded('c');
  r3.advance(2000);
  assert.equal(r3.sent.length, 0);
});

test('never for the tab being looked at on the Mac, never while quitting, never in quiet hours when that is on', () => {
  const r = rig({ status: { a: 'needs' }, looking: (id) => id === 'a' });
  r.n.tabHook('a', 'needs', null);
  r.advance(3000);
  assert.equal(r.sent.length, 0);
  const q = rig({ status: { a: 'needs' }, quitting: () => true });
  q.n.tabHook('a', 'needs', null);
  q.advance(3000);
  assert.equal(q.sent.length, 0);
  const night = rig({ status: { a: 'needs' }, minute: 23 * 60, alerts: { quiet: true } });
  night.n.tabHook('a', 'needs', null);
  night.advance(3000);
  assert.equal(night.sent.length, 0);
  const nightOff = rig({ status: { a: 'needs' }, minute: 23 * 60 });
  nightOff.n.tabHook('a', 'needs', null);
  nightOff.advance(3000);
  assert.equal(nightOff.sent.length, 1, 'quiet hours are off by default');
});

test('a failure outlives the tab and keeps the label it had; it opens nothing', () => {
  const labels = { a: { label: 'Build', project: 'api' } };
  const r = rig({ labels });
  r.n.tabFailed('a');
  r.n.tabHook('a', 'exit');
  delete labels.a;
  r.advance(1000);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].body, 'Build stopped with an error');
  assert.equal(r.sent[0].tabId, null);
});

test('privacy: names off says only the event kind; team says only the peer name, never a body', () => {
  const r = rig({ alerts: { names: false }, status: { a: 'needs' }, labels: { a: { label: 'Secret merger memo', project: 'acme-deal' } } });
  r.n.tabHook('a', 'needs', null);
  r.n.teamMessage('Brett');
  r.advance(3000);
  for (const s of r.sent) {
    assert.doesNotMatch(JSON.stringify(s), /Secret|acme|Brett/);
  }
  assert.ok(r.sent.some((s) => s.body === 'A tab needs you'));
  const t = rig();
  t.n.teamMessage('Brett‮\x1b[31m with a very long name that goes on and on and on');
  t.n.teamMessage('Brett');
  t.advance(3000);
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].body, '2 new team messages');
});

test('settings helpers: defaults, quiet window across midnight, label cleaning', () => {
  assert.deepEqual(alertSettings(null), { ...ALERT_DEFAULTS });
  assert.deepEqual(alertSettings({ needs: 'no', done: false, __proto__: { quiet: true } }), { ...ALERT_DEFAULTS, done: false });
  assert.equal(inQuietHours(21 * 60, '08:00', '20:00'), true);
  assert.equal(inQuietHours(7 * 60, '08:00', '20:00'), true);
  assert.equal(inQuietHours(12 * 60, '08:00', '20:00'), false);
  assert.equal(inQuietHours(12 * 60, 'bad', '20:00'), false);
  assert.equal(cleanLabel('a\nb\x1b[0m\u2028c‏'), 'a b [0m c');
  assert.equal([...cleanLabel('x'.repeat(200))].length, 60);
  assert.doesNotMatch(tabTag('term-/Users/sam/Projects/secret-1'), /Users|secret/);
});
