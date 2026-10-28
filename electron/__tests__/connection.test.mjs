// Mobile Connection outbound queue (v1.0.43 resilience). Verifies that user
// input typed during a disconnect is buffered and flushed on re-auth, that
// ephemeral messages are not queued, and that the auth handshake is not
// deadlocked by the "send only when authed" guard.
const instances = [];
global.WebSocket = class {
  constructor() { this.readyState = 0; this.sent = []; instances.push(this); }
  send(d) { this.sent.push(JSON.parse(d)); }
  close() { this.readyState = 3; }
};
global.WebSocket.OPEN = 1;
global.location = { protocol: 'http:', host: 'x' };

const { Connection } = await import('../../mobile/connection.js');

let pass = 0, fail = 0;
const check = (label, cond) => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); };

const c = new Connection({ id: 'a', origin: 'http://x', token: 'tok' });

// 1. Before any socket: user input is queued, ephemeral is dropped.
c.send({ type: 'input', id: 't1', data: 'ls\r' });
c.send({ type: 'listTerminals' });
c.send({ type: 'ping' });
check('input queued while disconnected', c._queue.length === 1);
check('ephemeral (listTerminals/ping) not queued', c._queue.every((m) => m.type === 'input'));

// 1a-v1.0.62: submitPrompt is the CHAT send. It was not queueable, so a
// message typed during the reconnect blip iOS causes on every foreground was
// silently dropped ("it swallows up messages once in a while"). The echo
// bubble made it LOOK sent, which is the worst version of lost.
c.send({ type: 'submitPrompt', id: 't1', text: 'hello from the phone' });
check('submitPrompt queued while disconnected', c._queue.some((m) => m.type === 'submitPrompt'));

// 1b. One-shot write actions queue too (audit HIGH-5), but reads (re-issued by
// screens on authed) do not, so they can't double-fire.
const q = new Connection({ id: 'a', origin: 'http://x', token: 'tok' });
q.send({ type: 'resumeSession', sessionId: 's', projectPath: '/p' });
q.send({ type: 'createTerminal', cwd: '/p' });
q.send({ type: 'loadTranscript', sessionId: 's', projectPath: '/p' });
q.send({ type: 'listSessions' });
check('resumeSession/createTerminal queued while disconnected', q._queue.length === 2);
check('read requests (loadTranscript/listSessions) NOT queued',
  !q._queue.some((m) => m.type === 'loadTranscript' || m.type === 'listSessions'));

// 2. Connect + open: the auth handshake goes out even though not yet authed.
c.connect();
const ws = instances[instances.length - 1];
ws.readyState = 1; // OPEN
ws.onopen();
check('auth sent on open (not deadlocked)', ws.sent.some((m) => m.type === 'auth'));
check('queued input NOT sent before authed', !ws.sent.some((m) => m.type === 'input'));

// 3. Authed: the queue flushes, input is delivered, queue emptied.
ws.onmessage({ data: JSON.stringify({ type: 'authed', version: 't' }) });
check('queued input flushed after authed', ws.sent.some((m) => m.type === 'input' && m.data === 'ls\r'));
check('queue emptied after flush', c._queue.length === 0);

// 4. While authed, sends go straight out.
c.send({ type: 'input', id: 't1', data: 'pwd\r' });
check('live input sent immediately when authed', ws.sent.filter((m) => m.type === 'input').length === 2);

// 5. Queue is bounded.
const c2 = new Connection({ id: 'a', origin: 'http://x', token: 'tok' });
for (let i = 0; i < 500; i++) c2.send({ type: 'input', id: 't', data: `${i}` });
check('queue bounded at 200', c2._queue.length === 200);
check('bounded queue keeps the NEWEST', c2._queue[c2._queue.length - 1].data === '499');

// 6. Liveness probe (v1.0.62, Codex High): iOS can kill the network path
// while the socket still reports OPEN. wake() while authed must park
// queueable sends until the path proves itself, so a message typed right
// after foregrounding can never vanish into a zombie socket.
{
  const c3 = new Connection({ id: 'a', origin: 'http://x', token: 'tok' });
  c3.connect();
  const w = instances[instances.length - 1];
  w.readyState = 1;
  w.onopen();
  w.onmessage({ data: JSON.stringify({ type: 'authed' }) });
  const sentBeforeWake = w.sent.length;

  c3.wake(); // suspect mode: a ping went straight out to probe
  check('probe ping bypasses the park (sent directly)', w.sent.some((m, i) => i >= sentBeforeWake && m.type === 'ping'));
  c3.send({ type: 'submitPrompt', id: 't1', text: 'ship it' });
  check('send during a pending probe is PARKED, not trusted to the socket',
    !w.sent.some((m) => m.type === 'submitPrompt') && c3._queue.some((m) => m.type === 'submitPrompt'));
  // Reads/subscriptions are NOT parked: they self-heal (polls re-fire, attach
  // re-issues on authed), and parking them starved screens that never
  // re-request outside authed (Codex round 2 High).
  c3.send({ type: 'selectorSnapshot', id: 't1' });
  check('reads still go out best-effort during the probe', w.sent.some((m) => m.type === 'selectorSnapshot'));

  // The path proves alive (any frame): parked sends flush on the SAME socket.
  w.onmessage({ data: JSON.stringify({ type: 'pong' }) });
  check('parked send flushes when the probe hears back', w.sent.some((m) => m.type === 'submitPrompt'));
  check('suspect cleared after proof of life', c3._suspect === false && c3._queue.length === 0);
  clearTimeout(c3._probeTimer);

  // Zombie case: probe times out silently. Force the timer's callback path by
  // waiting it out with fake time is overkill here; instead verify the timer
  // is armed and the state is suspect until something arrives.
  const c4 = new Connection({ id: 'a', origin: 'http://x', token: 'tok' });
  c4.connect();
  const w2 = instances[instances.length - 1];
  w2.readyState = 1;
  w2.onopen();
  w2.onmessage({ data: JSON.stringify({ type: 'authed' }) });
  c4.wake();
  check('probe timer armed while suspect', !!c4._probeTimer && c4._suspect === true);
  c4.send({ type: 'input', id: 't', data: 'x' });
  check('zombie socket never receives the parked input', !w2.sent.some((m) => m.type === 'input'));
  // A reconnect (new socket) resets probe state so the fresh socket is trusted.
  c4._open();
  check('fresh socket clears suspect state', c4._suspect === false && c4._probeTimer === null);
  const w3 = instances[instances.length - 1];
  w3.readyState = 1;
  w3.onopen();
  w3.onmessage({ data: JSON.stringify({ type: 'authed' }) });
  check('parked input flushes after the reconnect auths', w3.sent.some((m) => m.type === 'input' && m.data === 'x'));
  clearTimeout(c4._probeTimer);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
