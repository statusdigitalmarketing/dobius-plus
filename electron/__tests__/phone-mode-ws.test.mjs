// Phone mode requests on the phone's socket: every one answered, refused before acting when off, malformed,
// unauthorized or revoked, and passed to phone mode with only the checked fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePhoneOp, PHONE_OPS } from '../phone-mode-ws.js';

const T = 'term-/Users/x/Projects (Code)/app-1';
const S = '0b5c2a6e-1111-4222-8333-444455556666';
const RUN = 'a'.repeat(32);

function harness(over = {}) {
  const calls = [];
  const sent = [];
  const pm = {
    take: async (...a) => { calls.push(['take', ...a]); return { ok: true, runId: RUN, gen: 9 }; },
    send: async (...a) => { calls.push(['send', ...a]); return { ok: true }; },
    answer: async (...a) => { calls.push(['answer', ...a]); return { ok: true }; },
    stopTurn: async (...a) => { calls.push(['stop', ...a]); return { ok: true }; },
    giveBack: async (...a) => { calls.push(['giveBack', ...a]); return { ok: true }; },
    stateOf: (id) => ({ id, on: false, gen: 3 }),
    ...over.pm,
  };
  const deps = {
    pm: () => (over.noPm ? null : pm),
    on: () => over.on ?? true,
    send: (o) => sent.push(o),
    isLive: (id) => id === T,
    authed: new Set(over.authed ?? [T]),
    stillOk: () => over.stillOk ?? true,
  };
  return { calls, sent, deps, run: (m) => handlePhoneOp(m, deps) };
}

test('the six requests are the phone ops', () => {
  assert.deepEqual([...PHONE_OPS].sort(), ['phoneAnswer', 'phoneGiveBack', 'phoneSend', 'phoneStateGet', 'phoneStop', 'phoneTake']);
});

test('refusals act on nothing and are answered', async () => {
  const cases = [
    [{ on: false }, { type: 'phoneTake', id: T, sessionId: S, gen: 1 }, 'off'],
    [{ noPm: true }, { type: 'phoneTake', id: T, sessionId: S, gen: 1 }, 'off'],
    [{}, { type: 'phoneTake', id: T, sessionId: 'nope', gen: 1 }, 'bad_request'],
    [{}, { type: 'phoneTake', id: T, sessionId: S, gen: 1, reqId: { x: 1 } }, 'bad_request'],
    [{}, { type: 'phoneSend', id: T, runId: RUN, text: '   ', sendId: 's1' }, 'bad_request'],
    [{}, { type: 'phoneAnswer', id: T, runId: RUN, requestId: 'tu1', answer: { kind: 'permission', allow: 'yes' } }, 'bad_answer'],
    [{}, { type: 'phoneTake', id: 'term-/other', sessionId: S, gen: 1 }, 'unknown_tab'],
    [{ authed: [] }, { type: 'phoneTake', id: T, sessionId: S, gen: 1 }, 'not_authorized'],
    [{ authed: [] }, { type: 'phoneStateGet', id: T }, 'not_authorized'],
    [{ stillOk: false }, { type: 'phoneGiveBack', id: T, runId: RUN }, 'revoked'],
  ];
  for (const [over, msg, code] of cases) {
    const h = harness(over);
    await h.run({ reqId: 'r1', ...msg });
    assert.equal(h.sent.length, 1, JSON.stringify(msg));
    assert.deepEqual([h.sent[0].type, h.sent[0].code], ['opError', code], JSON.stringify(msg));
    assert.deepEqual(h.calls, [], `${code}: nothing acted`);
  }
});

test('with the setting off, a new move is refused but a conversation already on the phone keeps working', async () => {
  const onPhone = new Set([T]);
  const h = harness({ on: false, pm: { isPhoneTab: (id) => onPhone.has(id) } });
  await h.run({ type: 'phoneTake', id: T, sessionId: S, gen: 1, reqId: 'a' });
  assert.equal(h.sent.at(-1).code, 'off', 'no new move while off');
  await h.run({ type: 'phoneSend', id: T, runId: RUN, text: 'hi', sendId: 's1', reqId: 'b' });
  await h.run({ type: 'phoneAnswer', id: T, runId: RUN, requestId: 'tu1', answer: { kind: 'plan', approve: true }, reqId: 'c' });
  await h.run({ type: 'phoneStop', id: T, runId: RUN, reqId: 'd' });
  await h.run({ type: 'phoneGiveBack', id: T, runId: RUN, reqId: 'e' });
  assert.deepEqual(h.calls.map((c) => c[0]), ['send', 'answer', 'stop', 'giveBack']);
  assert.deepEqual(h.sent.slice(1).map((m) => m.type), ['ack', 'ack', 'ack', 'ack']);
  onPhone.clear();
  await h.run({ type: 'phoneGiveBack', id: T, runId: RUN, reqId: 'f' });
  assert.equal(h.sent.at(-1).code, 'off', 'a tab not on the phone gets nothing while off');
  assert.equal(h.calls.length, 4);
  await h.run({ type: 'phoneStateGet', id: T, reqId: 'g' });
  assert.deepEqual([h.sent.at(-1).type, h.sent.at(-1).gen], ['phoneState', 3], 'its state can always be read');
  const throws = harness({ on: false, pm: { isPhoneTab: () => { throw new Error('x'); } } });
  await throws.run({ type: 'phoneStop', id: T, runId: RUN });
  assert.equal(throws.sent[0].code, 'off', 'a failed lookup is not on the phone');
  assert.deepEqual(throws.calls, []);
});

test('requests reach phone mode with only their checked fields, and acks carry run and generation', async () => {
  const h = harness();
  await h.run({ type: 'phoneTake', id: T, sessionId: S, gen: 4, reqId: 7, extra: 'x' });
  const [name, tid, opts] = h.calls[0];
  assert.deepEqual([name, tid, opts.sessionId, opts.gen, Object.keys(opts).sort()], ['take', T, S, 4, ['gen', 'sessionId', 'stillOk']]);
  assert.equal(opts.stillOk, h.deps.stillOk, "the socket's own pairing check, asked again during the move");
  assert.deepEqual(h.sent[0], { type: 'ack', op: 'phoneTake', id: T, reqId: 7, runId: RUN, gen: 9 });
  await h.run({ type: 'phoneSend', id: T, runId: RUN, text: 'hi', sendId: 's1' });
  await h.run({ type: 'phoneAnswer', id: T, runId: RUN, requestId: 'tu1', answer: { kind: 'permission', allow: true, junk: 1 } });
  await h.run({ type: 'phoneStop', id: T, runId: RUN });
  await h.run({ type: 'phoneGiveBack', id: T, runId: RUN });
  assert.deepEqual(h.calls.slice(1), [
    ['send', T, RUN, 'hi', 's1'],
    ['answer', T, RUN, 'tu1', { kind: 'permission', allow: true, always: false, note: '' }],
    ['stop', T, RUN],
    ['giveBack', T, RUN],
  ]);
  assert.equal(h.sent.filter((m) => m.type === 'ack').length, 5);
});

test('a refusal from phone mode is passed on; a throw is answered, never left hanging', async () => {
  let h = harness({ pm: { send: async () => ({ ok: true, duplicate: true }) } });
  await h.run({ type: 'phoneSend', id: T, runId: RUN, text: 'hi', sendId: 's1', reqId: 'a' });
  assert.equal(h.sent[0].duplicate, true);
  h = harness({ pm: { take: async () => ({ ok: false, code: 'working', error: 'Claude is working' }) } });
  await h.run({ type: 'phoneTake', id: T, sessionId: S, gen: 1, reqId: 'b' });
  assert.deepEqual([h.sent[0].code, h.sent[0].message, h.sent[0].reqId], ['working', 'Claude is working', 'b']);
  h = harness({ pm: { stopTurn: async () => { throw new Error('boom'); } } });
  await h.run({ type: 'phoneStop', id: T, runId: RUN, reqId: 'c' });
  assert.deepEqual([h.sent[0].type, h.sent[0].code], ['opError', 'failed']);
});

test('phoneStateGet answers with the tab state for this tab id', async () => {
  const h = harness({ pm: { stateOf: () => ({ id: 'something-else', on: true, gen: 2, runId: RUN }) } });
  await h.run({ type: 'phoneStateGet', id: T, reqId: 'q' });
  assert.deepEqual(h.sent[0], { type: 'phoneState', id: T, on: true, gen: 2, runId: RUN, reqId: 'q' });
});
