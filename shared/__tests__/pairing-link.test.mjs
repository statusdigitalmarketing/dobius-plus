import test from 'node:test';
import assert from 'node:assert/strict';
import { pairingOrigin, buildPairingDeepLink, buildPairingWebLink, pairingText, parsePairingLink } from '../pairing-link.js';
import { normaliseHost } from '../../mobile/host.js';

const http = { running: true, pairingCode: '482913', address: { host: '100.89.143.67', port: 8420 }, url: null };
const https = { running: true, pairingCode: '482913', address: { host: '100.89.143.67', port: 8420 }, url: 'https://sams-mac.tail6addbf.ts.net:8420/' };

test('origin keeps the scheme and prefers the HTTPS url', () => {
  assert.equal(pairingOrigin(http), 'http://100.89.143.67:8420');
  assert.equal(pairingOrigin(https), 'https://sams-mac.tail6addbf.ts.net:8420');
  assert.equal(pairingOrigin({}), '');
  assert.equal(pairingOrigin({ url: 'not a url' }), '');
});

test('deep link carries host and code, url-encoded', () => {
  assert.equal(buildPairingDeepLink(https), 'dobiusplus://pair?host=https%3A%2F%2Fsams-mac.tail6addbf.ts.net%3A8420&code=482913');
  assert.equal(buildPairingDeepLink({ ...http, pairingCode: null }), '');
});

test('web link is a plain page on the Mac, code in the fragment only over HTTPS', () => {
  assert.equal(buildPairingWebLink(http), 'http://100.89.143.67:8420/#pair');
  assert.equal(buildPairingWebLink(https), 'https://sams-mac.tail6addbf.ts.net:8420/#pair=482913');
  assert.equal(buildPairingWebLink({ ...http, pairingCode: null }), '');
  assert.equal(buildPairingWebLink({ pairingCode: '482913' }), '');
});

test('the scanner reads every QR the Mac can show', () => {
  assert.deepEqual(parsePairingLink(buildPairingDeepLink(https)), { host: 'https://sams-mac.tail6addbf.ts.net:8420', code: '482913' });
  assert.deepEqual(parsePairingLink(buildPairingDeepLink(http)), { host: 'http://100.89.143.67:8420', code: '482913' });
  assert.deepEqual(parsePairingLink(buildPairingWebLink(https)), { host: 'https://sams-mac.tail6addbf.ts.net:8420', code: '482913' });
  assert.deepEqual(parsePairingLink(buildPairingWebLink(http)), { host: 'http://100.89.143.67:8420', code: '' });
});

test('a hostile address in a scanned code is refused, not thrown', () => {
  const link = parsePairingLink('dobiusplus://pair?host=http%3A%2F%2Fmac%5C%3A65536&code=123456');
  assert.equal(normaliseHost(link.host), '');
  assert.equal(normaliseHost('http://user:pw@mac.ts.net:8420'), '');
  assert.equal(normaliseHost('javascript:alert(1)'), '');
  assert.equal(normaliseHost(buildPairingDeepLink(https) && 'https://sams-mac.tail6addbf.ts.net:8420'), 'https://sams-mac.tail6addbf.ts.net:8420');
});

test('the scanner refuses anything else', () => {
  for (const bad of ['', 'hello', 'https://example.com', 'https://example.com/#other', 'https://example.com/#pair=12', 'dobiusplus://other?host=x', 'dobiusplus://pair',
    'dobius-team:1:mac.ts.net:8420:abc:def', 'javascript:alert(1)//#pair=123456', 'ftp://x/#pair=123456']) {
    assert.equal(parsePairingLink(bad), null, bad);
  }
});

test('text names address, code and link on separate lines', () => {
  assert.equal(pairingText(http), [
    'Dobius+ pairing',
    'Mac address: http://100.89.143.67:8420',
    'Pairing code: 482913',
    'Tap to pair: http://100.89.143.67:8420/#pair',
    'In the Dobius+ iPhone app: dobiusplus://pair?host=http%3A%2F%2F100.89.143.67%3A8420&code=482913',
  ].join('\n'));
});

test('nothing to send when the server is down or has no code', () => {
  assert.equal(pairingText({ ...http, running: false }), '');
  assert.equal(pairingText({ ...http, pairingCode: null }), '');
  assert.equal(pairingText({ running: true, pairingCode: '1' }), '');
});

