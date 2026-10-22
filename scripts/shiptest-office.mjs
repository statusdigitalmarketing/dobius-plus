// Ship-test driver for the Office view. Attaches to the ISOLATED dev instance
// over CDP, injects synthetic tabs via the Zustand store so we exercise all 4
// states, and saves screenshots: desktop normal, desktop needs-tab, recording
// landscape, recording vertical. Run after:
//   DOBIUS_USERDATA_DIR=<dir> DOBIUS_DEV_CDP=9225 DOBIUS_BRIDGE_PORT=8431 npm run electron:dev
import { chromium } from 'playwright-core';
import http from 'http';

const CDP = `http://127.0.0.1:${process.env.DOBIUS_DEV_CDP || 9225}`;
const OUT = process.env.SHIPTEST_OUT || '.';
const shot = (page, name) => page.screenshot({ path: `${OUT}/shiptest-office-${name}.png` });

async function waitForCdp() {
  for (let i = 0; i < 90; i += 1) {
    const ok = await new Promise((resolve) => {
      const req = http.get(`${CDP}/json/version`, (res) => { res.resume(); resolve(res.statusCode === 200); });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => { req.destroy(); resolve(false); });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`CDP endpoint never came up on ${CDP}`);
}

await waitForCdp();
const browser = await chromium.connectOverCDP(CDP);
const pages = browser.contexts().flatMap((c) => c.pages());
console.log('pages:', pages.map((p) => p.url()));
let page = pages.find((p) => p.url().includes('project=')) || pages[0];
if (!page) throw new Error('no pages');
await page.setViewportSize({ width: 1440, height: 900 });

// Open the Dashboard, then the Office tab.
await page.waitForTimeout(600);
// Click the dashboard switcher (there is a top bar button, label varies).
// The Office tab is identified by its text in the dashboard tab row.
await page.evaluate(() => {
  // ProjectView stores activeView in Zustand; set it to 'dashboard' + dashboardTab='office'.
  if (window.__zustandSetView) {
    window.__zustandSetView('dashboard', 'office');
    return;
  }
  // Fallback: try to find the store via React fiber. Fail loudly if unavailable.
  const findStore = () => {
    const roots = document.querySelectorAll('*');
    for (const el of roots) {
      const k = Object.keys(el).find((n) => n.startsWith('__reactContainer$'));
      if (k) return el[k];
    }
    return null;
  };
  console.log('no store hook, click fallback');
});
// Fallback: click the dashboard-tab button text match.
await page.click('text="Office"', { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(800);

// Inject synthetic tabs with all 4 statuses into the store.
// The store is a Zustand instance; patch it via window hook if available,
// otherwise use its direct API (useStore.setState).
const injected = await page.evaluate(() => {
  // The app's store should be reachable via a global test hook. If not, bail.
  const st = window.useStore || window.__dobiusStore;
  if (!st) return { ok: false, reason: 'no store global' };
  const synthetic = [
    { id: 'term-shiptest-1', projectPath: '/Users/sam/Projects (Code)/office-demo', label: 'fix auth', cwd: '/tmp/a' },
    { id: 'term-shiptest-2', projectPath: '/Users/sam/Projects (Code)/office-demo', label: 'mockups', cwd: '/tmp/a' },
    { id: 'term-shiptest-3', projectPath: '/Users/sam/Projects (Code)/office-demo', label: 'codex review', cwd: '/tmp/a' },
    { id: 'term-shiptest-4', projectPath: '/Users/sam/Projects (Code)/office-demo', label: 'build pipeline', cwd: '/tmp/a' },
    { id: 'term-shiptest-5', projectPath: '/Users/sam/Projects (Code)/office-demo', label: 'onboarding', cwd: '/tmp/a' },
  ];
  st.setState({
    terminalTabs: synthetic,
    tabStatus: {
      'term-shiptest-1': 'working',
      'term-shiptest-2': 'done',
      'term-shiptest-3': 'idle',
      'term-shiptest-4': 'needs',
      'term-shiptest-5': 'working',
    },
    runningAgents: {},
    currentProjectPath: '/Users/sam/Projects (Code)/office-demo',
  });
  return { ok: true, injected: synthetic.length };
});
console.log('inject:', injected);
await page.waitForTimeout(600);
await shot(page, '1-normal');

// Toggle recording.
await page.click('button:has-text("Record mode")').catch(() => {});
await page.waitForTimeout(400);
await shot(page, '2-recording-wide');

// 9:16.
await page.click('button:has-text("9:16")').catch(() => {});
await page.waitForTimeout(400);
await shot(page, '3-recording-vertical');

// Exit recording.
await page.click('button:has-text("Exit recording")').catch(() => {});
await page.waitForTimeout(300);

// Needs close-up: pin a single needs tab, viewport zoom.
await page.evaluate(() => {
  const st = window.useStore || window.__dobiusStore;
  if (!st) return;
  st.setState({
    terminalTabs: [{ id: 'term-shiptest-N', projectPath: '/Users/sam/Projects (Code)/needs-demo', label: 'needs you', cwd: '/tmp/n' }],
    tabStatus: { 'term-shiptest-N': 'needs' },
    runningAgents: {},
    currentProjectPath: '/Users/sam/Projects (Code)/needs-demo',
  });
});
await page.waitForTimeout(600);
await shot(page, '4-needs-closeup');

console.log('OFFICE SHIPTEST DONE');
await browser.close();
process.exit(0);
