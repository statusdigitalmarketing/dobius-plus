// Share sheet routes (electron/phone-share.js, docs/phone-share.md) on a real express server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mountShareRoutes, orderTargets, shareMessage, cleanNote, imageKind, MAX_IMAGE_BYTES, MAX_TEXT_BYTES, SHARE_PREFIX } from '../phone-share.js';

const TOKEN = 'a'.repeat(64);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);

async function server(over = {}) {
  const calls = { saved: [], delivered: [], discarded: [] };
  const deps = {
    auth: (req) => req.headers.authorization === `Bearer ${TOKEN}`,
    targets: () => ({ mac: 'Mac', orchestrator: 't1', tabs: [{ id: 't1', label: 'Orch' }] }),
    tabAlive: (id) => id === 't1' || id === 't2',
    saveImage: (buf, ext) => { calls.saved.push({ size: buf.length, ext }); return `/tmp/up-1-share.${ext}`; },
    deliver: async (tab, message, images) => { calls.delivered.push(images ? { tab, message, images } : { tab, message }); return { status: 200, body: { ok: true } }; },
    discard: (file) => { calls.discarded.push(file); },
    label: (id) => (id === 't1' ? 'Orch' : 'Other'),
    ...over,
  };
  const app = express();
  mountShareRoutes(app, deps);
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (qs, body, headers = {}) => fetch(`${base}/share?${qs}`, { method: 'POST', body, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/octet-stream', ...headers } });
  return { base, post, calls, close: () => new Promise((r) => srv.close(r)) };
}

test('imageKind reads magic bytes only', () => {
  assert.equal(imageKind(PNG), 'png');
  assert.equal(imageKind(JPG), 'jpg');
  assert.equal(imageKind(Buffer.from('GIF89a......')), 'gif');
  assert.equal(imageKind(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
  assert.equal(imageKind(Buffer.from('#!/bin/sh\nrm -rf ~\n')), null);
  assert.equal(imageKind(Buffer.alloc(4)), null);
});

test('orderTargets: orchestrator first, then Claude tabs by activity, capped', () => {
  const rows = orderTargets([
    { id: 'shell', label: 'zsh', claudeLive: false, lastActivityAt: 900 },
    { id: 'old', label: 'Old', claudeLive: true, lastActivityAt: 100 },
    { id: 'orch', label: 'Global orchestrator', claudeLive: true, lastActivityAt: 1 },
    { id: 'new', label: 'New', claudeLive: true, lastActivityAt: 500 },
    null,
  ], 'orch');
  assert.deepEqual(rows.map((r) => r.id), ['orch', 'new', 'old', 'shell']);
  assert.equal(rows[0].orchestrator, true);
  assert.equal(rows[1].orchestrator, false);
  const many = Array.from({ length: 90 }, (_, i) => ({ id: `t${i}`, lastActivityAt: i }));
  assert.equal(orderTargets(many, null).length, 40);
});

test('shareMessage puts the image path on its own line after the note', () => {
  assert.equal(shareMessage({ note: 'look', path: '/tmp/a.png' }), `${SHARE_PREFIX} look\n\n/tmp/a.png`);
  assert.equal(shareMessage({ note: '', text: 'https://x.y' }), `${SHARE_PREFIX}\n\nhttps://x.y`);
});

test('cleanNote flattens control characters and caps length', () => {
  assert.equal(cleanNote('a\nb\x1b[201~c\u2028d'), 'a b [201~c d');
  assert.equal(cleanNote('x'.repeat(5000)).length, 2000);
  assert.equal(cleanNote(undefined), '');
});

test('an image is saved and its path delivered to the chosen tab', async () => {
  const s = await server();
  try {
    const r = await s.post('kind=image&tab=t1&note=see%20this', PNG);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, sent: true, label: 'Orch' });
    assert.deepEqual(s.calls.saved, [{ size: PNG.length, ext: 'png' }]);
    assert.deepEqual(s.calls.delivered, [{ tab: 't1', message: `${SHARE_PREFIX} see this\n\n/tmp/up-1-share.png`, images: ['/tmp/up-1-share.png'] }]);
  } finally { await s.close(); }
});

test('text is delivered as text, nothing saved', async () => {
  const s = await server();
  try {
    const r = await s.post('kind=text&tab=t2', 'https://example.com/a');
    assert.equal(r.status, 200);
    assert.equal(s.calls.saved.length, 0);
    assert.equal(s.calls.delivered[0].message, `${SHARE_PREFIX}\n\nhttps://example.com/a`);
  } finally { await s.close(); }
});

test('refusals: no auth, bad kind, unknown tab, not an image, too big', async () => {
  const s = await server();
  try {
    assert.equal((await s.post('kind=image&tab=t1', PNG, { Authorization: 'Bearer nope' })).status, 401);
    assert.equal((await fetch(`${s.base}/share/targets`)).status, 401);
    assert.equal((await s.post('kind=video&tab=t1', PNG)).status, 400);
    const gone = await s.post('kind=image&tab=zz', PNG);
    assert.equal(gone.status, 404);
    assert.equal((await gone.json()).reason, 'no-tab');
    assert.equal((await s.post('kind=image&tab=t1', Buffer.from('#!/bin/sh\necho hi\n'))).status, 415);
    assert.equal((await s.post('kind=text&tab=t1', 'x'.repeat(MAX_TEXT_BYTES + 1))).status, 413);
    assert.equal((await s.post('kind=image&tab=t1', Buffer.alloc(MAX_IMAGE_BYTES + 1))).status, 413);
    assert.equal((await s.post('kind=image&tab=t1&id=bad%20id', PNG)).status, 400);
    assert.equal(s.calls.delivered.length, 0);
    assert.equal(s.calls.saved.length, 0);
  } finally { await s.close(); }
});

test('targets are listed with auth', async () => {
  const s = await server();
  try {
    const r = await fetch(`${s.base}/share/targets`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.deepEqual(await r.json(), { ok: true, mac: 'Mac', orchestrator: 't1', tabs: [{ id: 't1', label: 'Orch' }] });
  } finally { await s.close(); }
});

test('one share at a time: a second is refused while the first is delivered, then the lock is free', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = await server({ deliver: async () => { await gate; return { status: 200, body: { ok: true } }; } });
  try {
    const first = s.post('kind=text&tab=t1', 'one');
    await new Promise((r) => setTimeout(r, 100));
    const second = await s.post('kind=text&tab=t1', 'two');
    assert.equal(second.status, 429);
    assert.equal((await second.json()).reason, 'busy');
    release();
    assert.equal((await first).status, 200);
    assert.equal((await s.post('kind=text&tab=t1', 'three')).status, 200);
  } finally { await s.close(); }
});

test('the lock is released when the body read fails', async () => {
  const s = await server();
  try {
    // A stream has no Content-Length, so only the parser's own limit can refuse it (after the lock was taken).
    const big = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('x'.repeat(MAX_TEXT_BYTES + 10))); c.close(); } });
    const r = await fetch(`${s.base}/share?kind=text&tab=t1`, { method: 'POST', body: big, duplex: 'half', headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(r.status, 413);
    assert.equal((await s.post('kind=text&tab=t1', 'ok')).status, 200);
  } finally { await s.close(); }
});

test('a retried share id is answered from its receipt, never delivered twice', async () => {
  const s = await server();
  try {
    const a = await s.post('kind=text&tab=t1&id=abcdef12-3456', 'hello');
    assert.equal(a.status, 200);
    const b = await s.post('kind=text&tab=t1&id=abcdef12-3456', 'hello');
    assert.equal(b.status, 200);
    assert.equal((await b.json()).repeat, true);
    assert.equal(s.calls.delivered.length, 1);
  } finally { await s.close(); }
});

test('a refused delivery passes the reason back and is not remembered', async () => {
  let n = 0;
  const s = await server({ deliver: async () => (++n === 1 ? { status: 409, body: { ok: false, error: 'Claude in that tab is not at its prompt', reason: 'no-prompt-box' } } : { status: 200, body: { ok: true } }) });
  try {
    const a = await s.post('kind=text&tab=t1&id=retry-0001', 'hi');
    assert.equal(a.status, 409);
    assert.deepEqual(await a.json(), { ok: false, error: 'Claude in that tab is not at its prompt', reason: 'no-prompt-box' });
    const b = await s.post('kind=text&tab=t1&id=retry-0001', 'hi');
    assert.equal(b.status, 200);
    assert.equal(n, 2);
  } finally { await s.close(); }
});

test('typed but not confirmed is reported as typed', async () => {
  const s = await server({ deliver: async () => ({ status: 202, body: { ok: false, typed: true, note: 'in the box' } }) });
  try {
    const r = await s.post('kind=text&tab=t1', 'hi');
    assert.deepEqual(await r.json(), { ok: true, sent: false, typed: true, label: 'Orch', note: 'in the box' });
  } finally { await s.close(); }
});

test('a refused image is deleted from the Mac; a typed one is kept', async () => {
  let typed = false;
  const s = await server({ deliver: async () => (typed ? { status: 200, body: { ok: false, typed: true } } : { status: 409, body: { ok: false, error: 'draft', reason: 'draft' } }) });
  try {
    assert.equal((await s.post('kind=image&tab=t1', PNG)).status, 409);
    assert.deepEqual(s.calls.discarded, ['/tmp/up-1-share.png']);
    typed = true;
    assert.equal((await s.post('kind=image&tab=t1', PNG)).status, 200);
    assert.equal(s.calls.discarded.length, 1);
  } finally { await s.close(); }
});

test('a delivery that never settles frees the lock at the deadline and is reported as unknown, never as sent', async () => {
  let n = 0;
  const s = await server({ deadlineMs: 150, deliver: () => (++n === 1 ? new Promise(() => {}) : Promise.resolve({ status: 200, body: { ok: true } })) });
  try {
    const a = await s.post('kind=text&tab=t1&id=hang-00001', 'one');
    assert.equal(a.status, 504);
    assert.equal((await a.json()).uncertain, true);
    // Retried with the same id: the same unknown answer, not a second paste.
    const again = await s.post('kind=text&tab=t1&id=hang-00001', 'one');
    assert.equal(again.status, 504);
    assert.equal(n, 1);
    assert.equal((await s.post('kind=text&tab=t2', 'two')).status, 200);
  } finally { await s.close(); }
});

test('boxHoldsMessage accepts Claude\'s image marker only for a declared image path', async () => {
  const { boxHoldsMessage } = await import('../bridge-open-tab.js');
  const p = '/var/folders/x/T/dobius-mobile-uploads/up-1-share.jpg';
  const msg = `${SHARE_PREFIX} look at this\n\n${p}`;
  // Captured from Claude Code 2.1.x after the paste (scratchpad probe, 2026-11-19).
  assert.equal(boxHoldsMessage('[Image #1][shared from the phone] look at this', msg, true, [p]), true);
  assert.equal(boxHoldsMessage('[Image #7][shared from the phone]', `${SHARE_PREFIX}\n\n${p}`, true, [p]), true);
  // Not converted (still the path): the exact match still holds.
  assert.equal(boxHoldsMessage(`[shared from the phone] look at this ${p}`, msg, true, [p]), true);
  // A send that named no image never accepts a marker.
  assert.equal(boxHoldsMessage('[Image #1][shared from the phone] look at this', msg, true), false);
  // Anything else in the box, or a second marker, is someone else's text.
  assert.equal(boxHoldsMessage('[Image #1][shared from the phone] look at this please', msg, true, [p]), false);
  assert.equal(boxHoldsMessage('[Image #1][Image #2][shared from the phone] look at this', msg, true, [p]), false);
  assert.equal(boxHoldsMessage('[Image #1]', msg, true, [p]), false);
});

test('share mirror: only what the extension needs, and removals before additions', async () => {
  const { shareRecords, withoutAdditions, mirrorPairings } = await import('../../mobile/share-mirror.js');
  const a = { id: 'a', origin: 'https://a.ts.net:8420', token: 'ta', name: 'Work', addedAt: 1, lastUsedAt: 1, drafts: 'x' };
  const b = { id: 'b', origin: 'https://b.ts.net:8420', token: 'tb', name: 'Home', addedAt: 2, lastUsedAt: 2 };
  assert.deepEqual(shareRecords({ pairings: [a, b], activeId: 'b' }), {
    pairings: [{ id: 'a', name: 'Work', origin: 'https://a.ts.net:8420', token: 'ta' }, { id: 'b', name: 'Home', origin: 'https://b.ts.net:8420', token: 'tb' }],
    activeId: 'b',
  });
  assert.equal(shareRecords({ pairings: [a], activeId: 'gone' }).activeId, null);
  // Removing b and adding c: the pre-save mirror drops b and does not yet add c.
  const c = { ...b, id: 'c', token: 'tc' };
  assert.deepEqual(withoutAdditions({ pairings: [a, b], activeId: 'b' }, { pairings: [a, c], activeId: 'c' }).pairings.map((p) => p.id), ['a']);
  // A replaced token counts as a removal of the old one.
  assert.deepEqual(withoutAdditions({ pairings: [a] }, { pairings: [{ ...a, token: 'new' }] }).pairings, []);
  // Outside the native app it does nothing.
  assert.equal(await mirrorPairings({ pairings: [a], activeId: 'a' }), true);
});
