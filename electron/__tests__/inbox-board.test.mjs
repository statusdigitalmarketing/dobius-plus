import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { actOnCard, fleetInfo, cardsFrom, readToken, readBoard as readBoardRaw, findBoardDir, listenerIsMine, boardStatus, startBoard, portState } from '../inbox-board.js';

// Tests drive fake listeners; ownership has its own test below.
const readBoard = (opts) => readBoardRaw({ listenerIsMine: async () => true, ...opts });

const TODAY = '2026-11-02';

function card(over = {}) {
  return { id: 'c1', source: 'email', status: 'open', who: 'Kim', subject: 'Hi', summary: 'Needs a reply', priority: 'medium', ...over };
}

test('cardsFrom keeps only open cards the board itself shows', () => {
  const out = cardsFrom({ items: [
    card({ id: 'open' }),
    card({ id: 'done', status: 'done' }),
    card({ id: 'later', status: 'later' }),
    card({ id: 'held', held: true }),
    card({ id: 'box', boxOnly: true }),
    null, 7, 'x', card({ id: '' }),
  ] }, TODAY);
  assert.deepEqual(out.cards.map((c) => c.id), ['open']);
  assert.equal(out.total, 1);
});

test('cardsFrom sorts overdue, then today, then priority, then due day', () => {
  const out = cardsFrom({ items: [
    card({ id: 'later-high', priority: 'high', due: '2026-11-20' }),
    card({ id: 'none-low', priority: 'low' }),
    card({ id: 'today', due: TODAY }),
    card({ id: 'overdue', due: '2026-10-30', priority: 'low' }),
    card({ id: 'later-med', due: '2026-11-05' }),
  ] }, TODAY);
  assert.deepEqual(out.cards.map((c) => c.id), ['overdue', 'today', 'later-high', 'later-med', 'none-low']);
  assert.equal(out.overdue, 1);
  assert.equal(out.dueToday, 1);
});

test('cardsFrom keeps links only to the hosts the board links to', () => {
  const link = (url) => cardsFrom({ items: [card({ url })] }, TODAY).cards[0].url;
  assert.equal(link('https://app.asana.com/0/0/1/f'), 'https://app.asana.com/0/0/1/f');
  assert.equal(link('https://accounts.google.com/AccountChooser?continue=x'), 'https://accounts.google.com/AccountChooser?continue=x');
  assert.equal(link('https://attacker.example/c?t=%30%31'), null);
  assert.equal(link('https://app.asana.com.evil.example/x'), null);
  assert.equal(link('https://user@app.asana.com/x'), null);
  assert.equal(link('http://app.asana.com/x'), null);
  assert.equal(link('not a url'), null);
});

test('cardsFrom drops non-https links, unknown sources and bad dates', () => {
  const [c] = cardsFrom({ items: [card({ url: 'javascript:alert(1)', source: 'fax', due: 'tomorrow', priority: 'urgent' })] }, TODAY).cards;
  assert.equal(c.url, null);
  assert.equal(c.source, 'other');
  assert.equal(c.due, null);
  assert.equal(c.priority, 'medium');
  const [g] = cardsFrom({ items: [card({ url: 'https://mail.google.com/mail/u/0/#inbox/abc' })] }, TODAY).cards;
  assert.equal(g.url, 'https://mail.google.com/mail/u/0/#inbox/abc');
});

test('cardsFrom returns only display fields', () => {
  const [c] = cardsFrom({ items: [card({ sender: 'kim@x.com', lessons: [1], hand: { job: 'j' }, recordings: [{ path: '/tmp/a' }] })] }, TODAY).cards;
  assert.deepEqual(Object.keys(c).sort(), ['due', 'id', 'meeting', 'priority', 'project', 'rev', 'since', 'source', 'subject', 'summary', 'url', 'who', 'why']);
});

test('cardsFrom survives a payload with no items', () => {
  assert.equal(cardsFrom(null, TODAY).total, 0);
  assert.equal(cardsFrom({ items: 'no' }, TODAY).total, 0);
});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-board-test-'));
}

test('readToken reads a plain token and refuses symlinks and junk', () => {
  const dir = tmpDir();
  try {
    assert.equal(readToken(dir), null, 'missing file');
    fs.writeFileSync(path.join(dir, 'token.txt'), 'abcDEF123_-abcDEF123_-\n');
    assert.equal(readToken(dir), 'abcDEF123_-abcDEF123_-');
    fs.writeFileSync(path.join(dir, 'token.txt'), 'has spaces in it and more\n');
    assert.equal(readToken(dir), null, 'bad characters');
    fs.rmSync(path.join(dir, 'token.txt'));
    const real = path.join(dir, 'real.txt');
    fs.writeFileSync(real, 'abcDEF123_-abcDEF123_-');
    fs.symlinkSync(real, path.join(dir, 'token.txt'));
    assert.equal(readToken(dir), null, 'symlink');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A stand-in for http.request: records the options, answers with `status`/`body`, or fails.
function fakeRequest({ status = 200, body = '{"items":[]}', fail = null, seen = [] } = {}) {
  return (opts, onRes) => {
    seen.push(opts);
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => setImmediate(() => {
      if (fail) return req.emit('error', new Error(fail));
      const res = new EventEmitter();
      res.statusCode = status;
      onRes(res);
      res.emit('data', Buffer.from(body));
      res.emit('end');
    });
    return req;
  };
}

// The board's own gate (allowed() in its server.py): a POST needs its Origin, JSON and the token.
test('actOnCard posts only to the board, shaped to pass its gate, for the card as it was seen', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-act-'));
  fs.writeFileSync(path.join(dir, 'token.txt'), 'tok-abcdefghijklmnop');
  const act = (req, opts = {}) => actOnCard(req, { dir, listenerIsMine: async () => true, ...opts });
  // Answers a read with `items` and a write with `status`, recording what was sent.
  const board = ({ items = [], status = 200, answer = '{"ok":true}' } = {}) => {
    const seen = []; const bodies = [];
    const request = (opts, onRes) => {
      const post = opts.method === 'POST';
      const r = fakeRequest({ seen, status: post ? status : 200, body: post ? answer : JSON.stringify({ items }) })(opts, onRes);
      const end = r.end; r.end = (b) => { if (post) bodies.push(b); end(); };
      return r;
    };
    return { request, seen, bodies, posts: () => seen.filter((o) => o.method === 'POST') };
  };
  try {
    let b = board();
    assert.deepEqual(await act({ kind: 'done', id: 'c1', rev: 7 }, { request: b.request }), { ok: true });
    const [p] = b.posts();
    assert.equal(p.path, '/api/act');
    assert.equal(p.host, '127.0.0.1');
    assert.equal(p.headers.Origin, 'http://127.0.0.1:8765');
    assert.equal(p.headers.Host, '127.0.0.1:8765');
    assert.equal(p.headers['Content-Type'], 'application/json');
    assert.equal(p.headers['X-Token'], 'tok-abcdefghijklmnop');
    assert.deepEqual(JSON.parse(b.bodies[0]), { id: 'c1', action: 'done', rev: 7 });
    b = board();
    await act({ kind: 'done', id: 'c0', rev: 0 }, { request: b.request });
    assert.equal(JSON.parse(b.bodies[0]).rev, 0, 'a rev of 0 is still checked');

    const task = { id: 'a1', source: 'asana', status: 'open', rev: 3 };
    // The print the phone showed is checked against the read made right before the write, and a
    // caller no longer allowed (an unpaired phone) changes nothing (Codex).
    {
      const { cardPrint } = await import('../today-snooze.js');
      const shown = cardsFrom({ items: [{ ...task, subject: 'as seen' }] }, '2026-11-05').cards[0];
      const print = cardPrint(shown);
      b = board({ items: [{ ...task, subject: 'edited, same rev' }] });
      assert.equal((await act({ kind: 'complete', id: 'a1', rev: 3, print }, { request: b.request, today: '2026-11-05' })).reason, 'changed');
      assert.equal(b.posts().length, 0);
      b = board({ items: [{ ...task, subject: 'as seen' }] });
      assert.equal((await act({ kind: 'complete', id: 'a1', rev: 3, print }, { request: b.request, today: '2026-11-05', stillOk: () => false })).reason, 'revoked');
      assert.equal(b.posts().length, 0);
      b = board({ items: [{ ...task, subject: 'as seen' }] });
      assert.deepEqual(await act({ kind: 'complete', id: 'a1', rev: 3, print }, { request: b.request, today: '2026-11-05' }), { ok: true });
      // Done with a print reads first too.
      const mail = { id: 'e1', source: 'email', status: 'open', rev: 4, subject: 'hi' };
      const mp = cardPrint(cardsFrom({ items: [mail] }, '2026-11-05').cards[0]);
      b = board({ items: [{ ...mail, subject: 'hi again' }] });
      assert.equal((await act({ kind: 'done', id: 'e1', rev: 4, print: mp }, { request: b.request, today: '2026-11-05' })).reason, 'changed');
      assert.equal(b.posts().length, 0);
    }
    b = board({ items: [task] });
    assert.deepEqual(await act({ kind: 'complete', id: 'a1', rev: 3 }, { request: b.request }), { ok: true });
    assert.deepEqual(JSON.parse(b.bodies[0]), { id: 'a1', action: 'complete' });
    for (const [name, items, rev] of [['newer revision', [task], 2], ['already closed', [{ ...task, status: 'done' }], 3], ['gone', [], 3], ['not an Asana card', [{ ...task, source: 'email' }], 3]]) {
      b = board({ items });
      assert.equal((await act({ kind: 'complete', id: 'a1', rev }, { request: b.request })).reason, 'changed', name);
      assert.equal(b.posts().length, 0, `${name}: Asana is not touched`);
    }

    const closed = { id: 'c1', source: 'email', status: 'done', rev: 5 };
    b = board({ items: [closed] });
    assert.deepEqual(await act({ kind: 'undo', id: 'c1', rev: 5 }, { request: b.request }), { ok: true });
    assert.deepEqual(JSON.parse(b.bodies[0]), { id: 'c1', action: 'open' });
    for (const [name, item] of [['a new message since', { ...closed, rev: 6 }], ['moved to Later since', { ...closed, status: 'later' }], ['reopened since', { ...closed, status: 'open' }]]) {
      b = board({ items: [item] });
      assert.equal((await act({ kind: 'undo', id: 'c1', rev: 5 }, { request: b.request })).reason, 'changed', name);
      assert.equal(b.posts().length, 0, `${name}: the newer decision stands`);
    }

    const secret = '{"error":"tok-abcdefghijklmnop tok%2Dabcdefghijklmnop"}';
    let r = await act({ kind: 'done', id: 'c1', rev: 1 }, { request: board({ status: 409, answer: secret }).request });
    assert.equal(r.reason, 'changed');
    assert.doesNotMatch(JSON.stringify(r), /abcdefghijklmnop/, 'nothing the listener says reaches the renderer');
    r = await act({ kind: 'done', id: 'c1', rev: 1 }, { request: board({ status: 400, answer: secret }).request });
    assert.equal(r.reason, 'refused');
    assert.doesNotMatch(JSON.stringify(r), /abcdefghijklmnop/);
    assert.equal((await act({ kind: 'done', id: 'c1', rev: 1 }, { request: fakeRequest({ status: 403 }) })).reason, 'denied');
    assert.equal((await act({ kind: 'done', id: 'c1', rev: 1 }, { request: fakeRequest({ status: 500 }) })).reason, 'bad-response');
    assert.equal((await act({ kind: 'done', id: 'c1', rev: 1 }, { request: fakeRequest({ fail: 'refused' }) })).reason, 'not-running');
    assert.equal((await act({ kind: 'done', id: 'c1', rev: 1 }, { listenerIsMine: async () => false })).reason, 'not-running', 'never sends the token to a listener that is not ours');
    let called = 0;
    const counting = (o, cb) => { called += 1; return fakeRequest()(o, cb); };
    for (const bad of [{}, { kind: 'send', id: 'c1', rev: 1 }, { kind: 'edit', id: 'c1', rev: 1 }, { kind: 'toString', id: 'c1', rev: 1 }, { kind: '__proto__', id: 'c1', rev: 1 }, { kind: 'done', rev: 1 }, { kind: 'done', id: 7, rev: 1 }, { kind: 'done', id: 'x'.repeat(201), rev: 1 }, { kind: 'done', id: 'c1' }, { kind: 'complete', id: 'a1' }, { kind: 'undo', id: 'c1', rev: null }]) {
      assert.equal((await act(bad, { request: counting })).reason, 'bad-request', JSON.stringify(bad).slice(0, 40));
    }
    assert.equal(called, 0, 'nothing but done, complete and undo, with a revision, can reach the board');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cardsFrom names a failing mailbox and counts held texts, because an empty list proves nothing then', () => {
  const r = cardsFrom({ items: [card({ id: 'held', held: true })], connections: [
    { name: 'a@x.com', state: 'error' }, { name: 'b@x.com', state: 'ok' }, { name: 'whatsapp', state: 'not connected' }, null, { state: 'error' },
  ] }, TODAY);
  assert.deepEqual(r.failing, ['a@x.com']);
  assert.equal(r.held, 1);
  assert.equal(r.total, 0);
  assert.deepEqual(cardsFrom({}, TODAY).failing, []);
});

test('a connection name cannot carry the token to the renderer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-conn-'));
  fs.writeFileSync(path.join(dir, 'token.txt'), 'tok-abcdefghijklmnop');
  try {
    const body = JSON.stringify({ items: [], connections: [{ name: 'tok-abcdefghijklmnop', state: 'error' }, { name: 'tok%2Dabcdefghijklmnop', state: 'error' }, { name: 'real@x.com', state: 'error' }] });
    const r = await readBoard({ dir, today: TODAY, request: fakeRequest({ body }) });
    assert.deepEqual(r.failing, ['real@x.com']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the Inbox list can read past the default cap, so a card is never just missing', () => {
  const items = Array.from({ length: 320 }, (_, i) => card({ id: `c${i}` }));
  assert.equal(cardsFrom({ items }, TODAY).cards.length, 300);
  assert.equal(cardsFrom({ items }, TODAY, { maxCards: Infinity }).cards.length, 320);
});

test('fleetInfo offers the site only on a Mac that feeds it', () => {
  assert.deepEqual(fleetInfo({ home: '/h', exists: (p) => p === '/h/.claude/fleet-board/board.json' }), { url: 'https://fleet.dobepros.com/' });
  assert.equal(fleetInfo({ home: '/h', exists: () => false }), null);
});

test('readBoard sends the token to 127.0.0.1 with the board Host and no Origin', async () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'token.txt'), 'tokTOKtokTOKtokTOK');
    const seen = [];
    const body = JSON.stringify({ items: [card({ due: '2026-10-01' })] });
    const r = await readBoard({ dir, today: TODAY, request: fakeRequest({ body, seen }) });
    assert.equal(r.ok, true);
    assert.equal(r.total, 1);
    assert.equal(r.overdue, 1);
    assert.equal(r.url, 'http://127.0.0.1:8765/');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].host, '127.0.0.1');
    assert.equal(seen[0].path, '/api/items');
    assert.equal(seen[0].headers.Host, '127.0.0.1:8765');
    assert.equal(seen[0].headers['X-Token'], 'tokTOKtokTOKtokTOK');
    assert.equal('Origin' in seen[0].headers, false);
    assert.equal('X-Visible' in seen[0].headers, false);
    assert.equal(JSON.stringify(r).includes('tokTOK'), false, 'the token never comes back');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readBoard reports why it could not read', async () => {
  const dir = tmpDir();
  try {
    assert.equal((await readBoard({ dir, request: fakeRequest() })).reason, 'not-installed');
    fs.writeFileSync(path.join(dir, 'token.txt'), 'tokTOKtokTOKtokTOK');
    assert.equal((await readBoard({ dir, request: fakeRequest({ status: 403 }) })).reason, 'denied');
    assert.equal((await readBoard({ dir, request: fakeRequest({ status: 500 }) })).reason, 'bad-response');
    assert.equal((await readBoard({ dir, request: fakeRequest({ body: '<html>' }) })).reason, 'bad-response');
    const down = await readBoard({ dir, request: fakeRequest({ fail: 'ECONNREFUSED' }) });
    assert.equal(down.reason, 'not-running');
    assert.equal(JSON.stringify(down).includes('tokTOK'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findBoardDir uses the launchd WorkingDirectory, else the fallback', async () => {
  const dir = tmpDir();
  try {
    const plist = path.join(dir, 'x.plist');
    assert.equal(await findBoardDir({ plist, fallback: '/fb' }), '/fb', 'no plist');
    fs.writeFileSync(plist, '');
    const run = (_bin, _args, _o, cb) => cb(null, '/Users/x/inbox-board\n');
    assert.equal(await findBoardDir({ plist, fallback: '/fb', run }), '/Users/x/inbox-board');
    const relative = (_bin, _args, _o, cb) => cb(null, 'inbox-board\n');
    assert.equal(await findBoardDir({ plist, fallback: '/fb', run: relative }), '/fb');
    const broken = (_bin, _args, _o, cb) => cb(new Error('no key'));
    assert.equal(await findBoardDir({ plist, fallback: '/fb', run: broken }), '/fb');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a listener that echoes the token gets it stripped, and its link dropped', async () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'token.txt'), 'tokTOKtokTOKtokTOK');
    const body = JSON.stringify({ items: [card({ subject: 'x tokTOKtokTOKtokTOK y', url: 'https://app.asana.com/c?t=tokTOKtokTOKtokTOK' }), card({ id: 'c2', url: 'https://mail.google.com/a' })] });
    const r = await readBoard({ dir, today: TODAY, request: fakeRequest({ body }) });
    assert.equal(JSON.stringify(r).includes('tokTOK'), false);
    assert.equal(r.cards.find((c) => c.id === 'c1').subject, 'x [hidden] y');
    assert.equal(r.cards.find((c) => c.id === 'c1').url, null);
    assert.equal(r.cards.find((c) => c.id === 'c2').url, 'https://mail.google.com/a');
    const enc = JSON.stringify({ items: [card({ url: 'https://app.asana.com/?t=%74okTOKtokTOKtokTOK' }), card({ id: 'c3', url: 'https://app.asana.com/?t=%2574okTOKtokTOKtokTOK' })] });
    const r2 = await readBoard({ dir, today: TODAY, request: fakeRequest({ body: enc }) });
    assert.deepEqual(r2.cards.map((c) => c.url), [null, null]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a response that never finishes, or upgrades, still ends the read', async () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'token.txt'), 'tokTOKtokTOKtokTOK');
    let destroyed = 0;
    const dribble = (_opts, onRes) => {
      const req = new EventEmitter();
      req.destroy = () => { destroyed += 1; };
      req.end = () => setImmediate(() => {
        const res = new EventEmitter();
        res.statusCode = 200;
        onRes(res);
        res.emit('data', Buffer.from(' ')); // and never 'end'
      });
      return req;
    };
    const slow = await readBoard({ dir, request: dribble, deadlineMs: 50 });
    assert.equal(slow.reason, 'not-running');
    assert.equal(destroyed, 1);
    const upgrading = (_opts) => {
      const req = new EventEmitter();
      req.destroy = () => {};
      req.end = () => setImmediate(() => req.emit('upgrade'));
      return req;
    };
    assert.equal((await readBoard({ dir, request: upgrading })).reason, 'bad-response');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the request uses a private agent, never the global (proxy-aware) one', async () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'token.txt'), 'tokTOKtokTOKtokTOK');
    const seen = [];
    await readBoard({ dir, request: fakeRequest({ seen }) });
    const http = await import('node:http');
    assert.ok(seen[0].agent instanceof http.Agent);
    assert.notEqual(seen[0].agent, http.globalAgent);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listenerIsMine needs a listener, all owned by this uid', async () => {
  const fake = (out, err = null) => (_bin, _args, _o, cb) => cb(err, out);
  const own = 'p1\nu501\nf4\nn127.0.0.1:8765\n';
  assert.equal(await listenerIsMine({ uid: 501, run: fake(own) }), true);
  assert.equal(await listenerIsMine({ uid: 501, run: fake('p1\nu502\nf4\nn127.0.0.1:8765\n') }), false);
  assert.equal(await listenerIsMine({ uid: 501, run: fake(own + 'p2\nu0\nf3\nn127.0.0.1:8765\n') }), false);
  // ours on another address proves nothing about 127.0.0.1 (lsof hides other users)
  assert.equal(await listenerIsMine({ uid: 501, run: fake('p1\nu501\nf4\nn[::1]:8765\n') }), false);
  assert.equal(await listenerIsMine({ uid: 501, run: fake('p1\nu501\nf4\nn*:8765\n') }), false);
  assert.equal(await listenerIsMine({ uid: 501, run: fake('p1\nu501\nf4\n') }), false);
  assert.equal(await listenerIsMine({ uid: 501, run: fake('', new Error('exit 1')) }), false);
  assert.equal(await listenerIsMine({ uid: null, run: fake('p1\nu501\n') }), false);
});

test('readBoard sends nothing when the listener is not ours', async () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'token.txt'), 'tokTOKtokTOKtokTOK');
    const seen = [];
    const r = await readBoardRaw({ dir, request: fakeRequest({ seen }), listenerIsMine: async () => false });
    assert.equal(r.reason, 'not-running');
    assert.equal(seen.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('boardStatus: installed means the board made its token; canStart means its plist exists', async () => {
  const dir = tmpDir();
  try {
    const plist = path.join(dir, 'job.plist');
    assert.deepEqual(await boardStatus({ dir, plist }), { installed: false, canStart: false });
    fs.writeFileSync(path.join(dir, 'token.txt'), 'tokTOKtokTOKtokTOK');
    fs.writeFileSync(plist, '');
    assert.deepEqual(await boardStatus({ dir, plist }), { installed: true, canStart: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('startBoard kickstarts the job, bootstraps it if not loaded, then waits for our listener', async () => {
  const dir = tmpDir();
  try {
    const plist = path.join(dir, 'job.plist');
    assert.equal((await startBoard({ plist, uid: 501 })).reason, 'not-installed');
    fs.writeFileSync(plist, '');
    const calls = [];
    const run = (fails) => (bin, args, _o, cb) => { calls.push(args.join(' ')); cb(fails.includes(args[0]) ? new Error('x') : null); };
    let checks = 0;
    const upSoon = async () => (checks += 1) >= 3; // down at the pre-check and once after
    // already running (e.g. started by hand): launchctl is never called
    assert.deepEqual(await startBoard({ plist, uid: 501, run: run([]), isMine: async () => true }), { ok: true });
    assert.deepEqual(calls, []);
    const closed = async () => 'closed';
    assert.deepEqual(await startBoard({ plist, uid: 501, run: run([]), isMine: upSoon, probe: closed }), { ok: true });
    assert.deepEqual(calls, ['kickstart gui/501/com.brett.inbox-server']);
    calls.length = 0;
    checks = 0;
    assert.deepEqual(await startBoard({ plist, uid: 501, run: run(['kickstart']), isMine: upSoon, probe: closed }), { ok: true });
    assert.deepEqual(calls, ['kickstart gui/501/com.brett.inbox-server', `bootstrap gui/501 ${plist}`]);
    const never = await startBoard({ plist, uid: 501, run: run([]), isMine: async () => false, waitMs: 50, probe: closed });
    assert.equal(never.reason, 'not-started');
    // lsof failed (false) but the port answers, or the probe is unsure: never launch
    calls.length = 0;
    assert.equal((await startBoard({ plist, uid: 501, run: run([]), isMine: async () => false, probe: async () => 'open' })).reason, 'busy');
    assert.equal((await startBoard({ plist, uid: 501, run: run([]), isMine: async () => false, probe: async () => 'unknown' })).reason, 'not-started');
    assert.deepEqual(calls, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('portState: refused is closed, a connect is open, anything else unknown', async () => {
  const fake = (event, code) => () => {
    const sock = new EventEmitter();
    sock.destroy = () => {};
    sock.setTimeout = () => {};
    setImmediate(() => (event === 'error' ? sock.emit('error', Object.assign(new Error(code), { code })) : sock.emit(event)));
    return sock;
  };
  assert.equal(await portState({ connect: fake('error', 'ECONNREFUSED') }), 'closed');
  assert.equal(await portState({ connect: fake('connect') }), 'open');
  assert.equal(await portState({ connect: fake('error', 'EPERM') }), 'unknown');
});
