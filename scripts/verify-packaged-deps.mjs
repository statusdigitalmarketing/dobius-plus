#!/usr/bin/env node
// Refuses a packaged app whose app.asar lacks a production dependency (2.2.34: every scoped package, @xterm/* among
// them, was left out and the app died at launch with ERR_MODULE_NOT_FOUND). release.sh runs it while the release is
// still a draft. Unpacked files (asarUnpack) are still listed in the asar header, so one listing covers both.
//
// Usage: node scripts/verify-packaged-deps.mjs <path to app.asar>
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar'); // electron-builder's own dependency, so always installed with it

const asarPath = process.argv[2];
if (!asarPath) { console.error('usage: verify-packaged-deps.mjs <app.asar>'); process.exit(2); }

const files = new Set(asar.listPackage(asarPath).map((f) => f.replace(/\\/g, '/')));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const missing = Object.keys(pkg.dependencies || {}).filter((n) => !files.has(`/node_modules/${n}/package.json`));

if (missing.length) {
  console.error(`ERROR: ${asarPath} is missing ${missing.length} production dependencies:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
console.log(`packaged deps OK: all ${Object.keys(pkg.dependencies || {}).length} production dependencies are in the app`);
