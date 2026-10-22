// Mobile Office ship-test via Playwright + mobile vite dev-server on 5174.
// Serves mobile/office-shiptest.html harness, which mounts <Office> with a
// scripted mock connection that replays all 4 states.

import { chromium } from 'playwright-core';
import fs from 'node:fs';

const URL = process.env.SHIPTEST_URL || 'http://127.0.0.1:5174/office-shiptest.html';
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
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await context.newPage();

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.waitForSelector('canvas', { timeout: 10000 });

await shot(page, 'mobile-1-normal');

await page.click('button:has-text("Record")');
await page.waitForTimeout(400);
await shot(page, 'mobile-2-recording');

await page.click('button:has-text("9:16")');
await page.waitForTimeout(400);
await shot(page, 'mobile-3-vertical');

console.log('MOBILE SHIPTEST DONE');
await browser.close();
process.exit(0);
