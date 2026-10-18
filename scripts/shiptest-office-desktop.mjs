// Ship-test for the DESKTOP OfficeView via the standalone harness in
// scripts/office-desktop-harness/, served by vite on 5175. Produces:
//   desktop-1-normal, desktop-2-recording-wide, desktop-3-recording-vertical,
//   desktop-4-needs-closeup.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const URL = process.env.SHIPTEST_URL || 'http://127.0.0.1:5175/';
const OUT = process.env.SHIPTEST_OUT || '.';
const shot = (page, name) => page.screenshot({ path: `${OUT}/shiptest-office-${name}.png` });

function findExecutable() {
  const envPath = process.env.PLAYWRIGHT_CHROMIUM;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const home = process.env.HOME || '/Users/bigfuckingdog';
  const paths = [
    `${home}/Library/Caches/ms-playwright/chromium-1232/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    `${home}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const p of paths) if (fs.existsSync(p)) return p;
  return null;
}

const exe = findExecutable();
const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.waitForSelector('button[aria-label^="Focus "]', { timeout: 10000 });

await shot(page, 'desktop-1-normal');

// Toggle recording.
await page.click('button:has-text("Record mode")');
await page.waitForTimeout(400);
await shot(page, 'desktop-2-recording-wide');

// 9:16.
await page.click('button:has-text("9:16")');
await page.waitForTimeout(400);
await shot(page, 'desktop-3-recording-vertical');

// Exit recording.
await page.click('button:has-text("Exit recording")');
await page.waitForTimeout(300);

// Needs close-up: scroll to the needs desk (t5).
const needsBtn = await page.locator('button[aria-label="Focus needs you (needs)"]').first();
await needsBtn.scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
const bb = await needsBtn.boundingBox();
if (bb) {
  await page.screenshot({
    path: `${OUT}/shiptest-office-desktop-4-needs-closeup.png`,
    clip: { x: Math.max(0, bb.x - 20), y: Math.max(0, bb.y - 30), width: Math.min(400, bb.width + 60), height: Math.min(400, bb.height + 60) },
  });
}

console.log('DESKTOP SHIPTEST DONE');
await browser.close();
process.exit(0);
