// Captures a ~10-second video of the Office v2 in recording mode so the
// auto-pan + animations are visible. Playwright writes webm per context, then
// we transcode to mp4 via ffmpeg. Both outputs are saved; mp4 is what Sam
// would post to a reel.
//
// Prereq: vite harness running at http://127.0.0.1:5175/ (same one the
// desktop ship-test uses). ffmpeg must be on PATH.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const URL = process.env.SHIPTEST_URL || 'http://127.0.0.1:5175/';
const OUT = process.env.SHIPTEST_OUT || '.';
const DURATION_MS = Number(process.env.OFFICE_RECORD_MS || 10000);

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

const videoDir = path.join(OUT, 'office-record-tmp');
fs.mkdirSync(videoDir, { recursive: true });

const exe = findExecutable();
const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
});
const page = await ctx.newPage();

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForSelector('.office-root canvas', { timeout: 10000 });
await page.waitForTimeout(500);

// Enter recording mode so chrome is hidden and auto-pan is on.
await page.click('button:has-text("Record mode")');

// Script state transitions so the recording actually shows action: tabs
// going from working to done, idle tabs waking up, a tab flipping to needs
// (red bubble + door light turning red). The harness exposes a tiny setter
// at window.__officeHarness.setStatus(id, status).
const timeline = [
  { at: 1500, id: 'b1', status: 'done' },
  { at: 2800, id: 'd4', status: 'working' },
  { at: 4100, id: 'd2', status: 'needs' },
  { at: 5300, id: 's1', status: 'done' },
  { at: 6700, id: 'h2', status: 'working' },
  { at: 8000, id: 'b4', status: 'needs' },
  { at: 9000, id: 'd5', status: 'working' },
];
const started = Date.now();
for (const step of timeline) {
  const now = Date.now() - started;
  const wait = Math.max(0, step.at - now);
  if (wait) await page.waitForTimeout(wait);
  await page.evaluate(({ id, status }) => window.__officeHarness?.setStatus(id, status), step);
}
// Hold the last state for the remainder of the clip.
const remaining = DURATION_MS - (Date.now() - started);
if (remaining > 0) await page.waitForTimeout(remaining);

await ctx.close();
await browser.close();

// Playwright writes the webm with a random name inside videoDir. Find it.
const files = fs.readdirSync(videoDir).filter((f) => f.endsWith('.webm'));
if (files.length === 0) {
  console.error('no webm captured');
  process.exit(1);
}
const srcWebm = path.join(videoDir, files[0]);
const outWebm = path.join(OUT, 'office-record.webm');
const outMp4 = path.join(OUT, 'office-record.mp4');
fs.copyFileSync(srcWebm, outWebm);
// Transcode to mp4 for broad compatibility (iOS Safari does not play webm
// inline). H.264 baseline, yuv420p for broadest support, no audio.
try {
  execFileSync('/opt/homebrew/bin/ffmpeg', [
    '-y', '-i', outWebm,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an',
    outMp4,
  ], { stdio: 'ignore' });
  console.log(`wrote ${outMp4} (${fs.statSync(outMp4).size} bytes)`);
} catch (e) {
  console.warn('ffmpeg transcode failed:', e.message);
}
console.log(`wrote ${outWebm} (${fs.statSync(outWebm).size} bytes)`);

// Cleanup temp dir.
fs.rmSync(videoDir, { recursive: true, force: true });
process.exit(0);
