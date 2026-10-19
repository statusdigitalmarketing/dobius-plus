// Ship-test for the DESKTOP Office v2 canvas renderer. Serves the standalone
// harness in scripts/office-desktop-harness/ via vite on 5175, drives it with
// playwright, saves screenshots:
//   desktop-1-floor       full floor with lobby + rooms
//   desktop-2-recording   recording mode landscape with auto-pan
//   desktop-3-vertical    9:16 recording layout
//   desktop-4-room-zoom   one room zoomed in (clicked)
//   desktop-5-needs       close-up of a needs-state desk + ! bubble + door
//                         light + red floor glow + wall-board NEED count
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const URL = process.env.SHIPTEST_URL || 'http://127.0.0.1:5175/';
const OUT = process.env.SHIPTEST_OUT || '.';
const shot = (page, name, clip) => page.screenshot({ path: `${OUT}/shiptest-office-${name}.png`, ...(clip ? { clip } : {}) });

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
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForSelector('.office-root canvas', { timeout: 10000 });
// Allow a couple of RAF frames for the first draw.
await page.waitForTimeout(600);

await shot(page, 'desktop-1-floor');

// Click somewhere ON a room (not the lobby) to zoom in. We use the harness's
// test hook: it hangs the active scene on window.__officeScene for the test.
// If no hook, click a well-known pixel inside a room.
await page.evaluate(() => {
  // Click near the center of what should be the second room's floor at
  // viewport scale. The harness renders at 1600x1000 with the full floor fit.
  const canvas = document.querySelector('.office-root canvas');
  const rect = canvas.getBoundingClientRect();
  const cx = rect.left + rect.width * 0.55;
  const cy = rect.top + rect.height * 0.3;
  canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: cx, clientY: cy }));
});
await page.waitForTimeout(900);
await shot(page, 'desktop-4-room-zoom');

// Reset to full view.
await page.evaluate(() => {
  const canvas = document.querySelector('.office-root canvas');
  const rect = canvas.getBoundingClientRect();
  // Click OUTSIDE any room (near the top-right corner) to trigger fit.
  canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + rect.width - 20, clientY: rect.top + 20 }));
});
await page.click('button:has-text("Fit floor")');
await page.waitForTimeout(600);

// Recording landscape. The chrome auto-hides; shoot a frame right after
// entering so Sam sees exactly what a reel capture would look like.
await page.click('button:has-text("Record mode")');
await page.waitForTimeout(500);
await shot(page, 'desktop-2-recording');

// 9:16. Reveal the hidden toolbar by hovering the top strip first.
await page.hover('.office-recording-reveal');
await page.waitForTimeout(200);
await page.click('button:has-text("9:16")');
await page.waitForTimeout(400);
await shot(page, 'desktop-3-vertical');

// Exit recording.
await page.hover('.office-recording-reveal');
await page.waitForTimeout(200);
await page.click('button:has-text("Exit")');
await page.waitForTimeout(300);

// Needs close-up: scroll into the first office room by clicking it, then crop.
await page.evaluate(() => {
  const canvas = document.querySelector('.office-root canvas');
  const rect = canvas.getBoundingClientRect();
  const cx = rect.left + rect.width * 0.42;
  const cy = rect.top + rect.height * 0.35;
  canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: cx, clientY: cy }));
});
await page.waitForTimeout(900);
await shot(page, 'desktop-5-needs');

console.log('DESKTOP SHIPTEST DONE');
await browser.close();
process.exit(0);
