import test from 'node:test';
import assert from 'node:assert/strict';
import { pairingOrigin, buildPairingDeepLink, buildPairingWebLink, pairingText, httpsAllowedFor } from '../pairing-link.js';

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

test('HTTPS only where it cannot strand a phone paired over HTTP', () => {
  assert.equal(httpsAllowedFor({ devices: [] }), true, 'no phone paired yet: HTTPS may come on');
  assert.equal(httpsAllowedFor({}), true, 'no devices list at all');
  assert.equal(httpsAllowedFor({ devices: [{ token: 't' }] }), false, 'a phone paired over HTTP stays at its HTTP address');
  assert.equal(httpsAllowedFor({ devices: [{ token: 't' }], httpsChosen: true }), true, 'chosen in Settings: phones pair once more');
  assert.equal(httpsAllowedFor({ devices: [{ token: 't' }], httpsChosen: 'yes' }), false, 'only a real true counts');
  assert.equal(httpsAllowedFor(null), true);
});
