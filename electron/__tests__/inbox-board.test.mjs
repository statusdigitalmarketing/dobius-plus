import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { cardsFrom, readToken, readBoard, findBoardDir } from '../inbox-board.js';

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
  assert.deepEqual(Object.keys(c).sort(), ['due', 'id', 'meeting', 'priority', 'project', 'since', 'source', 'subject', 'summary', 'url', 'who', 'why']);
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
