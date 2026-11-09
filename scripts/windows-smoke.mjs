// Windows smoke test for the packaged app (run by .github/workflows/windows.yml
// on a real Windows machine; never against anyone's real profile).
//
// 1. Launches dist-electron/win-unpacked/Dobius+.exe on an isolated userData
//    with one project and PowerShell as the new-tab tool.
// 2. Types a command into the tab and reads the answer off the terminal.
// 3. Starts a stand-in Claude in the tab (node running a file at the npm
//    claude-code/cli.js path) that writes Claude's own session record and a
//    transcript, then checks the Chat view finds it and shows the reply.
// 4. Checks the session is listed in History.
// 5. Closes the window and checks the app quits on its own.
// Screenshots of each step land in smoke-out/.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const exe = path.join(repo, 'dist-electron', 'win-unpacked', 'Dobius+.exe');
const out = path.join(repo, 'smoke-out');
fs.mkdirSync(out, { recursive: true });
const root = path.join(process.env.SystemDrive || 'C:', '\\', 'dobius-smoke');
const userData = path.join(root, 'userdata');
const project = path.join(root, 'demo-app');
const standinDir = path.join(root, 'standin', 'node_modules', '@anthropic-ai', 'claude-code');
fs.rmSync(root, { recursive: true, force: true });
for (const d of [userData, project, standinDir]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(project, 'README.md'), '# demo\n');
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
  lastOpenProjects: [project],
  settings: { newTabTool: 'shell' },
}, null, 2));

const REPLY = 'Hello from the Windows smoke test';
const QUESTION = 'Say hello from Windows';
// The stand-in Claude: records itself the way Claude Code does on Windows
// (<home>/.claude/sessions/<pid>.json with procStartFt) and writes a transcript.
fs.writeFileSync(path.join(standinDir, 'cli.js'), `
const fs = require('fs'); const os = require('os'); const path = require('path'); const { execFileSync } = require('child_process');
const crypto = require('crypto');
const ps = '(Get-CimInstance Win32_Process -Filter "ProcessId=' + process.pid + '").CreationDate.ToFileTimeUtc()';
const ft = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { encoding: 'utf8' }).trim();
const sessionId = crypto.randomUUID();
const cwd = process.cwd();
const home = path.join(os.homedir(), '.claude');
fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(home, 'sessions', process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId, cwd, procStartFt: ft, startedAt: Date.now(), status: 'idle', kind: 'interactive' }));
const dir = path.join(home, 'projects', cwd.replace(/[^a-zA-Z0-9-]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const t = new Date().toISOString();
const base = { sessionId, cwd, entrypoint: 'cli', version: '2.1.999', gitBranch: '', userType: 'external' };
fs.writeFileSync(path.join(dir, sessionId + '.jsonl'), [
  JSON.stringify({ ...base, type: 'user', uuid: 'u1', parentUuid: null, timestamp: t, message: { role: 'user', content: ${JSON.stringify(QUESTION)} } }),
  JSON.stringify({ ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: t, message: { id: 'msg_1', role: 'assistant', model: 'claude-test', type: 'message', content: [{ type: 'text', text: ${JSON.stringify(REPLY)} }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } } }),
].join('\\n') + '\\n');
process.stdout.write('stand-in claude ready ' + sessionId + '\\n');
setInterval(() => {}, 60000);
`);

const results = [];
const step = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = spawn(exe, [], {
  env: { ...process.env, DOBIUS_USERDATA_DIR: userData, DOBIUS_DEV_CDP: '9229', DOBIUS_BRIDGE_PORT: '8431', DOBIUS_MOBILE_PORT: '8461' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let appLog = '';
app.stdout.on('data', (d) => { appLog += d; });
app.stderr.on('data', (d) => { appLog += d; });
let exited = null;
app.on('exit', (code) => { exited = { code, at: Date.now() }; });

async function connect() {
  for (let i = 0; i < 60; i += 1) {
    try { return await chromium.connectOverCDP('http://127.0.0.1:9229'); } catch { await sleep(1000); }
  }
  throw new Error('CDP never came up');
}

async function projectPage(browser) {
  for (let i = 0; i < 60; i += 1) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) if (/project=/.test(p.url())) return p;
    }
    await sleep(1000);
  }
  return null;
}

async function terminalText(page) {
  return page.evaluate(() => [...document.querySelectorAll('.xterm-rows')].map((r) => r.innerText).join('\n'));
}

async function waitFor(fn, ms, every = 1000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(every);
  }
  return null;
}

let browser;
try {
  browser = await connect();
  step('app starts and opens CDP', true);
  const page = await projectPage(browser);
  step('project window opens', !!page, page ? page.url().slice(0, 80) : 'no project window');
  if (!page) throw new Error('no project window');
  await page.setViewportSize({ width: 1400, height: 860 }).catch(() => {});
  await page.waitForSelector('.xterm-screen', { state: 'attached', timeout: 30000 });
  await sleep(4000); // PowerShell profile + prompt
  await page.screenshot({ path: path.join(out, '1-project-window.png') });

  const screen = page.locator('.xterm-screen').filter({ visible: true }).first();
  await screen.click();
  await page.keyboard.type('Write-Output ("dobius-" + (6*7))');
  await page.keyboard.press('Enter');
  const echoed = await waitFor(async () => /dobius-42/.test(await terminalText(page)), 20000);
  step('PowerShell tab runs a command', !!echoed);
  await page.screenshot({ path: path.join(out, '2-powershell.png') });

  // Ctrl+C with nothing selected must reach the shell (interrupt), not copy.
  await page.keyboard.type('Start-Sleep 30');
  await page.keyboard.press('Enter');
  await sleep(800);
  await page.keyboard.press('Control+C');
  await sleep(2000);
  await page.keyboard.type('Write-Output ("after-" + (7*6))');
  await page.keyboard.press('Enter');
  const interrupted = await waitFor(async () => /after-42/.test(await terminalText(page)), 8000);
  step('Ctrl+C interrupts a running command', !!interrupted);

  await page.keyboard.type(`node "${path.join(standinDir, 'cli.js')}"`);
  await page.keyboard.press('Enter');
  const ready = await waitFor(async () => /stand-in claude ready/.test(await terminalText(page)), 30000);
  step('stand-in Claude starts in the tab', !!ready);

  await page.keyboard.press('Control+Shift+M'); // Terminal <-> Chat
  const chat = await waitFor(async () => (await page.evaluate(() => document.body.innerText)).includes(REPLY), 60000, 2000);
  step('Chat view shows the session\'s reply', !!chat);
  await page.screenshot({ path: path.join(out, '3-chat-view.png') });
  await page.keyboard.press('Control+Shift+M');

  await page.locator('.xterm-screen').filter({ visible: true }).first().click();
  const historyButton = page.getByRole('button', { name: 'History', exact: true });
  if (!(await historyButton.isVisible().catch(() => false))) await page.keyboard.press('Control+Shift+B'); // sidebar
  await historyButton.click({ timeout: 10000 });
  // History replaces the Tabs view, and nothing else on screen holds the question
  // (the terminal shows only the stand-in's ready line, Chat is closed).
  const hist = await waitFor(async () => (await page.evaluate(() => document.body.innerText)).includes(QUESTION), 30000, 2000);
  step('History lists the session', !!hist);
  await page.screenshot({ path: path.join(out, '4-history.png') });

  await page.keyboard.press('Control+Shift+T'); // new tab
  const tabs = await waitFor(async () => (await page.locator('.xterm-screen').count()) >= 2, 15000);
  step('Ctrl+Shift+T opens a second tab', !!tabs);
  await page.screenshot({ path: path.join(out, '5-two-tabs.png') });

  // The tab menu on Windows: no Move to account (Windows applies no saved account, Max 2026-11-09).
  await page.locator('button[draggable="true"]').first().click({ button: 'right' });
  const menu = await waitFor(async () => {
    const t = await page.evaluate(() => document.body.innerText);
    return t.includes('Close Others') ? t : null;
  }, 10000, 500);
  step('tab menu opens without Move to account', !!menu && !menu.includes('Move to account'), menu ? '' : 'menu did not open');
  await page.screenshot({ path: path.join(out, '6-tab-menu.png') });
  await page.keyboard.press('Escape');

  // Close every window: the app must quit by itself on Windows.
  for (const ctx of browser.contexts()) for (const p of ctx.pages()) await p.evaluate(() => window.close()).catch(() => {});
  const quit = await waitFor(async () => exited, 30000, 500);
  step('closing the last window quits the app', !!quit, quit ? `exit ${quit.code}` : 'still running after 30s');
} catch (err) {
  step('smoke run', false, err.message);
} finally {
  try { await browser?.close(); } catch { /* gone */ }
  if (!exited) { try { execFileSync('taskkill', ['/pid', String(app.pid), '/T', '/F']); } catch { /* gone */ } }
  fs.writeFileSync(path.join(out, 'app-log.txt'), appLog.slice(-200000));
  try { fs.copyFileSync(path.join(userData, 'logs', 'error.log'), path.join(out, 'error.log')); } catch { /* none */ }
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
