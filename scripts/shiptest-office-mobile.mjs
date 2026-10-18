// Ship-test for the mobile Office page via Playwright + the vite dev-server
// harness at mobile/office-shiptest.html. Produces 3 screenshots:
//   mobile-1-normal, mobile-2-recording, mobile-3-vertical.
// Launches a bundled Chromium at phone viewport (iPhone 14 Pro portrait).

import { chromium } from 'playwright-core';
import fs from 'node:fs';

const URL = process.env.SHIPTEST_URL || 'http://127.0.0.1:5174/office-shiptest.html';
const OUT = process.env.SHIPTEST_OUT || '.';
const shot = (page, name) => page.screenshot({ path: `${OUT}/shiptest-office-${name}.png` });

// Chromium path: Playwright's default install usually at ~/Library/Caches/ms-playwright
// playwright-core does NOT download browsers, so this expects an existing Chromium
// installation. Alternatives: PLAYWRIGHT_CHROMIUM, or a system Chrome.
function findExecutable() {
  const envPath = process.env.PLAYWRIGHT_CHROMIUM;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const home = process.env.HOME || '/Users/bigfuckingdog';
  const commonPaths = [
    `${home}/Library/Caches/ms-playwright/chromium-1232/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    `${home}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    `${home}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    `${home}/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  for (const p of commonPaths) if (fs.existsSync(p)) return p;
  return null;
}

const exe = findExecutable();
const launchArgs = exe ? { executablePath: exe } : {};
const browser = await chromium.launch({ headless: true, ...launchArgs }).catch(async (e) => {
  console.error('could not launch Chromium:', e.message);
  console.error('set PLAYWRIGHT_CHROMIUM to a Chromium/Chrome binary path.');
  process.exit(2);
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await context.newPage();

await page.goto(URL, { waitUntil: 'networkidle' });
// The harness mounts after a 50ms setTimeout for the terminals push.
await page.waitForTimeout(400);
await page.waitForSelector('button[aria-label^="Open "]', { timeout: 10000 }).catch(() => {});

await shot(page, 'mobile-1-normal');

await page.click('button:has-text("Record")');
await page.waitForTimeout(300);
await shot(page, 'mobile-2-recording');

await page.click('button:has-text("9:16")');
await page.waitForTimeout(300);
await shot(page, 'mobile-3-vertical');

console.log('MOBILE SHIPTEST DONE');
await browser.close();
process.exit(0);
