// `d:` texts take the same route as phone voice (team orchestrator, else Voice Conductor) and the answer comes back as
// an iMessage. The sender is a stand-in: nothing here reaches Messages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleCommand, setImessageCommandRoute } from '../imessage-bridge.js';
import { recordReply } from '../voice-bridge.js';

test('a routed text gets the recorded reply back as an iMessage', async (t) => {
  t.after(() => setImessageCommandRoute(null));
  const seen = [];
  setImessageCommandRoute(async (text) => {
    seen.push(text);
    recordReply('req-im-test-1', 'Sent to your orchestrator tab "Fleet".');
    return { requestId: 'req-im-test-1', mode: 'orchestrator' };
  });
  const sent = [];
  await handleCommand('look at\nthis screenshot', async (m) => { sent.push(m); });
  assert.deepEqual(seen, ['look at this screenshot']);
  assert.deepEqual(sent, ['Sent to your orchestrator tab "Fleet".']);
});

test('a text nothing took says why, and waits for nothing', async (t) => {
  t.after(() => setImessageCommandRoute(null));
  setImessageCommandRoute(async () => ({ requestId: null, error: 'Your orchestrator tab did not take it: a draft is open' }));
  const sent = [];
  const t0 = Date.now();
  await handleCommand('hello', async (m) => { sent.push(m); });
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(sent, ['(not delivered: Your orchestrator tab did not take it: a draft is open)']);
});

test('a route that throws is reported, not swallowed', async (t) => {
  t.after(() => setImessageCommandRoute(null));
  setImessageCommandRoute(async () => { throw new Error('boom'); });
  const sent = [];
  await handleCommand('hello', async (m) => { sent.push(m); });
  assert.deepEqual(sent, ['(not delivered: boom)']);
});
