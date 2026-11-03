import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { isAppUrl, installNavGuard } from '../nav-guard.js';

const PROD = { dev: false, appFile: '/Applications/Dobius+.app/Contents/Resources/app.asar/dist/index.html' };
const DEV = { dev: true, appFile: '/x/dist/index.html' };

test('isAppUrl: only Dobius\'s own page', () => {
  assert.equal(isAppUrl('http://localhost:5173/?project=%2Fp', DEV), true);
  assert.equal(isAppUrl('http://localhost:5174/', DEV), false);
  assert.equal(isAppUrl('https://evil.example/', DEV), false);
  assert.equal(isAppUrl('file:///Applications/Dobius+.app/Contents/Resources/app.asar/dist/index.html?project=%2Fp#x', PROD), true);
  assert.equal(isAppUrl('file:///Applications/Dobius+.app/Contents/Resources/app.asar/dist/other.html', PROD), false);
  assert.equal(isAppUrl('file:///Applications/Dobius+.app/Contents/Resources/app.asar/dist/../dist/index.html', PROD), true);
  assert.equal(isAppUrl('file://evil-host/Applications/Dobius+.app/Contents/Resources/app.asar/dist/index.html', PROD), false);
  assert.equal(isAppUrl('http://localhost:5173/', PROD), false, 'the dev server is not the app in a packaged build');
  assert.equal(isAppUrl('', PROD), false);
  assert.equal(isAppUrl('not a url', DEV), false);
});

function harness() {
  const app = new EventEmitter();
  const opened = [];
  const shell = { openExternal: (u) => opened.push(u) };
  installNavGuard(app, shell, DEV);
  const make = (type) => {
    const c = new EventEmitter();
    c.getType = () => type;
    c.setWindowOpenHandler = (fn) => { c.openHandler = fn; };
    app.emit('web-contents-created', {}, c);
    return c;
  };
  const navigate = (c, url, ev = 'will-navigate') => {
    let prevented = false;
    c.emit(ev, { preventDefault: () => { prevented = true; } }, url);
    return prevented;
  };
  return { make, navigate, opened };
}

test('an app window cannot leave Dobius; links open in the browser instead', () => {
  const { make, navigate, opened } = harness();
  const win = make('window');
  assert.equal(navigate(win, 'http://localhost:5173/?project=%2Fp'), false, 'its own page is allowed');
  assert.equal(navigate(win, 'https://evil.example/steal'), true);
  assert.deepEqual(opened, ['https://evil.example/steal']);
  assert.equal(navigate(win, 'javascript:alert(1)'), true);
  assert.equal(navigate(win, 'file:///etc/passwd'), true);
  assert.deepEqual(opened, ['https://evil.example/steal'], 'only http(s) is handed to the browser');
  assert.equal(navigate(win, 'mailto:kim@example.com'), true);
  assert.deepEqual(opened, ['https://evil.example/steal', 'mailto:kim@example.com'], 'email links go to the mail app');
  opened.pop();
  assert.equal(navigate(win, 'https://evil.example/', 'will-redirect'), true);
  assert.deepEqual(win.openHandler({ url: 'https://a.example/' }), { action: 'deny' });
  assert.deepEqual(win.openHandler({ url: 'file:///x' }), { action: 'deny' });
  assert.deepEqual(opened, ['https://evil.example/steal', 'https://a.example/']);
});

test('a browser pane (webview) keeps browsing freely', () => {
  const { make, navigate, opened } = harness();
  const pane = make('webview');
  assert.equal(navigate(pane, 'https://example.com/'), false);
  assert.equal(pane.openHandler, undefined);
  assert.deepEqual(opened, []);
});
