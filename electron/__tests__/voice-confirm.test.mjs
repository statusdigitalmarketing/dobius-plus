// A confirmed phone Send is delivered once per sendId, and refused when where it goes changed since the card showed it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Receipts are written under userData: point it at a throwaway folder before anything sends.
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-voicerc-'));
process.env.DOBIUS_TEST_USERDATA = UD;
const { sendConfirmedVoice, currentVoiceTarget, setVoiceOrchestratorLabel } = await import('../mobile-server.js');

const counting = (result) => {
  const calls = [];
  const route = async (t) => { calls.push(t); return typeof result === 'function' ? result(calls.length) : result; };
  return { calls, route };
};

test('a retried Send with the same sendId is delivered once and answered the same', async () => {
  const { calls, route } = counting({ requestId: 'req-1', mode: 'conductor' });
  const a = await sendConfirmedVoice({ transcript: 'make an invoice', sendId: 'abcdefgh-0001' }, route);
  const b = await sendConfirmedVoice({ transcript: 'make an invoice', sendId: 'abcdefgh-0001' }, route);
  assert.deepEqual(calls, ['make an invoice']);
  assert.deepEqual(a, { status: 200, body: { ok: true, mode: 'conductor', requestId: 'req-1' } });
  assert.deepEqual(b, a);
});

test('two Sends at once with one sendId share one delivery', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = [];
  const route = async (t) => { calls.push(t); await gate; return { requestId: 'req-2', mode: 'conductor' }; };
  const p1 = sendConfirmedVoice({ transcript: 'x', sendId: 'abcdefgh-0002' }, route);
  const p2 = sendConfirmedVoice({ transcript: 'x', sendId: 'abcdefgh-0002' }, route);
  release();
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(calls.length, 1);
  assert.deepEqual(a, b);
});

test('a refusal is not remembered: the retry really tries again', async () => {
  const { calls, route } = counting((n) => (n === 1 ? { requestId: null, error: 'a draft is open' } : { requestId: 'req-3', mode: 'orchestrator' }));
  const a = await sendConfirmedVoice({ transcript: 'y', sendId: 'abcdefgh-0003' }, route);
  assert.deepEqual(a, { status: 503, body: { ok: false, error: 'a draft is open' } });
  const b = await sendConfirmedVoice({ transcript: 'y', sendId: 'abcdefgh-0003' }, route);
  assert.equal(b.status, 200);
  assert.equal(calls.length, 2);
});

test('a Send expecting a destination that changed is refused without routing', async (t) => {
  t.after(() => setVoiceOrchestratorLabel(null));
  setVoiceOrchestratorLabel(() => ({ id: 'term-/p/fleet-1', label: 'Fleet' }));
  const shown = currentVoiceTarget();
  assert.equal(shown.to, 'orchestrator');
  assert.match(shown.key, /^orchestrator:[0-9a-f]{16}$/);
  setVoiceOrchestratorLabel(() => ({ id: 'term-/p/other-2', label: 'Other' }));
  const { calls, route } = counting({ requestId: 'req-4', mode: 'orchestrator' });
  const r = await sendConfirmedVoice({ transcript: 'z', sendId: 'abcdefgh-0004', expect: shown.key }, route);
  assert.equal(r.status, 409);
  assert.equal(r.body.changed, true);
  assert.equal(r.body.target.label, 'your orchestrator tab "Other"');
  assert.equal(calls.length, 0);
  // Same destination as shown: delivered.
  const ok = await sendConfirmedVoice({ transcript: 'z', sendId: 'abcdefgh-0004', expect: currentVoiceTarget().key }, route);
  assert.equal(ok.status, 200);
  assert.equal(calls.length, 1);
});

test('a delivery is still recognised after a restart (receipts file)', async () => {
  const { calls, route } = counting({ requestId: 'req-5', mode: 'conductor' });
  const first = await sendConfirmedVoice({ transcript: 'pay invoice 123', sendId: 'abcdefgh-0005' }, route);
  assert.equal(first.status, 200);
  const rows = JSON.parse(fs.readFileSync(path.join(UD, 'voice-sent.json'), 'utf8'));
  assert.ok(rows.some((r) => r.id === 'abcdefgh-0005' && r.body.requestId === 'req-5'));
  // A fresh copy of the module stands in for the restarted app: empty memory, same file.
  const fresh = await import('../mobile-server.js?restart=1');
  const again = await fresh.sendConfirmedVoice({ transcript: 'pay invoice 123', sendId: 'abcdefgh-0005' }, route);
  assert.deepEqual(again, { status: 200, body: { ok: true, mode: 'conductor', requestId: 'req-5' } });
  assert.equal(calls.length, 1);
});

test('a Send is written down before it is typed; after a crash mid-delivery the retry is refused, not re-sent', async (t) => {
  t.after(() => fs.rmSync(UD, { recursive: true, force: true }));
  let seenPending = false;
  // The route never finishes: Dobius "dies" while typing.
  const route = async () => {
    const rows = JSON.parse(fs.readFileSync(path.join(UD, 'voice-sent.json'), 'utf8'));
    seenPending = rows.some((r) => r.id === 'abcdefgh-0006' && r.pending === true);
    return new Promise(() => {});
  };
  sendConfirmedVoice({ transcript: 'pay invoice 456', sendId: 'abcdefgh-0006' }, route);
  await new Promise((r) => setImmediate(r));
  assert.equal(seenPending, true);
  const fresh = await import('../mobile-server.js?restart=2');
  const calls = [];
  const retry = await fresh.sendConfirmedVoice({ transcript: 'pay invoice 456', sendId: 'abcdefgh-0006' }, async (x) => { calls.push(x); return { requestId: 'req-7', mode: 'conductor' }; });
  assert.equal(retry.status, 409);
  assert.equal(retry.body.uncertain, true);
  assert.equal(calls.length, 0);
});

test('when the receipt cannot be written first, nothing is sent', async (t) => {
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-voicerc-ro-'));
  t.after(() => { fs.chmodSync(bad, 0o700); fs.rmSync(bad, { recursive: true, force: true }); });
  process.env.DOBIUS_TEST_USERDATA = bad;
  const fresh = await import('../mobile-server.js?readonly=1');
  fs.chmodSync(bad, 0o500); // the write (and rename) into userData fails
  const calls = [];
  const r = await fresh.sendConfirmedVoice({ transcript: 'pay invoice 789', sendId: 'abcdefgh-0008' }, async (x) => { calls.push(x); return { requestId: 'req-8', mode: 'conductor' }; });
  assert.equal(r.status, 503);
  assert.equal(calls.length, 0);
});

test('an unreadable receipts file: a retry the Mac cannot vouch for is refused, a fresh message still goes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-voicerc-bad-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'voice-sent.json'), '{ not json');
  process.env.DOBIUS_TEST_USERDATA = dir;
  const fresh = await import('../mobile-server.js?badfile=1');
  const calls = [];
  const route = async (x) => { calls.push(x); return { requestId: 'req-9', mode: 'conductor' }; };
  const retry = await fresh.sendConfirmedVoice({ transcript: 'pay invoice 1', sendId: 'abcdefgh-0009', retry: true }, route);
  assert.equal(retry.status, 409);
  assert.equal(retry.body.uncertain, true);
  assert.equal(calls.length, 0);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('voice-sent.json.unreadable-')));
  const first = await fresh.sendConfirmedVoice({ transcript: 'pay invoice 2', sendId: 'abcdefgh-0010' }, route);
  assert.equal(first.status, 200);
  assert.equal(calls.length, 1);
  // Restarted again (twice): the set-aside file still marks the loss, so the retry is still refused.
  for (const n of [2, 3]) {
    const again = await import(`../mobile-server.js?badfile=${n}`);
    const r = await again.sendConfirmedVoice({ transcript: 'pay invoice 1', sendId: 'abcdefgh-0009', retry: true }, route);
    assert.equal(r.status, 409);
  }
  assert.equal(calls.length, 1);
});

test('the loss marker holds with no receipts file at all (restart right after setting it aside)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-voicerc-marker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, `voice-sent.json.unreadable-${Date.now() - 60_000}`), 'x');
  fs.writeFileSync(path.join(dir, `voice-sent.json.unreadable-${Date.now() - 25 * 3600_000}`), 'x'); // past 24 h: removed
  process.env.DOBIUS_TEST_USERDATA = dir;
  const fresh = await import('../mobile-server.js?marker=1');
  const calls = [];
  const r = await fresh.sendConfirmedVoice({ transcript: 'x', sendId: 'abcdefgh-0011', retry: true }, async (x) => { calls.push(x); return { requestId: 'req-11', mode: 'conductor' }; });
  assert.equal(r.status, 409);
  assert.equal(calls.length, 0);
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.unreadable-')).length, 1);
});

test('when the bad file cannot be set aside, the first save writes a loss marker before replacing anything', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-voicerc-noaside-'));
  t.after(() => { fs.chmodSync(dir, 0o700); fs.rmSync(dir, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(dir, 'voice-sent.json'), '{ not json');
  process.env.DOBIUS_TEST_USERDATA = dir;
  const fresh = await import('../mobile-server.js?noaside=1');
  const calls = [];
  const route = async (x) => { calls.push(x); return { requestId: 'req-12', mode: 'conductor' }; };
  fs.chmodSync(dir, 0o500); // the set-aside rename fails
  const retry = await fresh.sendConfirmedVoice({ transcript: 'pay invoice 1', sendId: 'abcdefgh-0012', retry: true }, route);
  assert.equal(retry.status, 409);
  fs.chmodSync(dir, 0o700);
  const ok = await fresh.sendConfirmedVoice({ transcript: 'new', sendId: 'abcdefgh-0013' }, route);
  assert.equal(ok.status, 200);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('voice-sent.json.unreadable-')));
  const again = await import('../mobile-server.js?noaside=2');
  const r = await again.sendConfirmedVoice({ transcript: 'pay invoice 1', sendId: 'abcdefgh-0012', retry: true }, route);
  assert.equal(r.status, 409);
  assert.equal(calls.length, 1);
});

test('an unconfirmed delivery keeps its warning in the receipt, also after a restart', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-voicerc-note-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.DOBIUS_TEST_USERDATA = dir;
  const fresh = await import('../mobile-server.js?note=1');
  const note = 'Typed into your orchestrator tab "Fleet", not confirmed: check that tab.';
  const route = async () => ({ requestId: 'req-14', mode: 'orchestrator', note });
  const first = await fresh.sendConfirmedVoice({ transcript: 'x', sendId: 'abcdefgh-0014' }, route);
  assert.equal(first.body.note, note);
  const again = await import('../mobile-server.js?note=2');
  const r = await again.sendConfirmedVoice({ transcript: 'x', sendId: 'abcdefgh-0014', retry: true }, route);
  assert.equal(r.status, 200);
  assert.equal(r.body.note, note);
});

test('a Conductor paste that was typed but not submitted is answered with a note, not plain success', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-voicerc-cnote-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.DOBIUS_TEST_USERDATA = dir;
  const fresh = await import('../mobile-server.js?cnote=1');
  const route = async () => ({ requestId: 'req-15', mode: 'conductor', note: 'Typed into the Voice Conductor, not confirmed: check that tab.' });
  const r = await fresh.sendConfirmedVoice({ transcript: 'x', sendId: 'abcdefgh-0015' }, route);
  assert.equal(r.status, 200);
  assert.match(r.body.note, /not confirmed/);
});
