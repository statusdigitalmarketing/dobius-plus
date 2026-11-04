// App Review demo mode: only the demo's own pairing gets fake answers, a real token never does, and a prompt queued
// during a turn still gets its reply. Run: node ./electron/__tests__/mobile-demo.test.mjs
import assert from 'node:assert/strict';

globalThis.window = globalThis;
const { DemoConnection, DEMO_ORIGIN, DEMO_TOKEN, isDemoPairing, installDemoFetch } = await import('../../mobile/demo.js');
const { mixedContent } = await import('../../mobile/host.js');

const realToken = 'ab'.repeat(32);
assert.equal(isDemoPairing(DEMO_ORIGIN, DEMO_TOKEN), true);
assert.equal(isDemoPairing(DEMO_ORIGIN, 'demo-review-token'), true, 'a build 4 install keeps its demo');
assert.equal(isDemoPairing(DEMO_ORIGIN, realToken), false, 'a real token on the demo address is not the demo');
assert.equal(isDemoPairing('http://my-mac.ts.net:8420', DEMO_TOKEN), false, 'the demo token on a real Mac is not the demo');
console.log('PASS  the demo needs both its address and its token');

const reached = [];
globalThis.fetch = async (u) => { reached.push(String(u)); return new Response('{"real":true}'); };
installDemoFetch();
const bearer = (t) => ({ headers: { Authorization: `Bearer ${t}` } });
assert.equal((await fetch(`${DEMO_ORIGIN}/health`, bearer(realToken))).status, 401, 'a real token is refused');
assert.equal((await (await fetch(`${DEMO_ORIGIN}/health`, bearer(DEMO_TOKEN))).json()).app, 'dobius-plus');
assert.equal((await fetch(`${DEMO_ORIGIN}/health`)).status, 200, 'pairing probes carry no token');
assert.deepEqual(reached, [], 'nothing for the demo reaches the network');
await fetch('http://demo.dobius.evil.example:8420/health');
assert.deepEqual(reached, ['http://demo.dobius.evil.example:8420/health'], 'a lookalike address is a real request');
console.log('PASS  demo requests stay in the page, and others pass through');

assert.equal(mixedContent(DEMO_ORIGIN, 'https://my-mac.ts.net'), false);
assert.equal(mixedContent('http://my-mac:8420', 'https://my-mac.ts.net'), true, 'a real http Mac is still blocked');
console.log('PASS  the demo opens from an https page');

const c = new DemoConnection({ id: 'x', origin: DEMO_ORIGIN, token: DEMO_TOKEN });
assert.equal((await (await c.request('/health')).json()).app, 'dobius-plus');
const tab = c.tabs.find((t) => t.claudeLive);
const before = c.transcripts[tab.sessionId].length;
c._handle({ type: 'submitPrompt', id: tab.id, text: 'run the tests' });
c._handle({ type: 'submitPrompt', id: tab.id, text: 'open a pull request' });
await new Promise((r) => setTimeout(r, 5000));
const added = c.transcripts[tab.sessionId].slice(before);
assert.deepEqual(added.map((m) => m.role), ['user', 'user', 'assistant', 'assistant'], 'both prompts are answered');
assert.match(added[2].content, /48 passed/);
assert.match(added[3].content, /pull request/);
assert.equal(tab.status, 'done');
c.close();
await assert.rejects(c.request('/health'), /closed/);
console.log('PASS  a queued prompt keeps its answer');
process.exit(0);
