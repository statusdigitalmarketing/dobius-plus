#!/usr/bin/env node
// Refuses a packaged app that lacks a runtime dependency (2.2.34: every scoped package, @xterm/* among them, was left
// out and the app died at launch with ERR_MODULE_NOT_FOUND). release.sh runs it while the release is still a draft.
//
// From each production dependency it follows `dependencies` (not optional or peer ones) the way Node resolves them:
// <dir>/node_modules/<name>, then each ancestor folder's node_modules up to the app root (Codex r1: a missing transitive
// dependency such as chokidar's readdirp also kills the app at launch). A manifest asarUnpack moved out of the asar is
// only listed in the header, so its file must also exist under app.asar.unpacked (Codex r1).
//
// Usage: node scripts/verify-packaged-deps.mjs <path to app.asar>
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar'); // electron-builder's own dependency, so always installed with it

const asarPath = process.argv[2];
if (!asarPath) { console.error('usage: verify-packaged-deps.mjs <app.asar>'); process.exit(2); }

const files = new Set(asar.listPackage(asarPath).map((f) => f.replace(/\\/g, '/').replace(/^\/+/, '')));

// A package.json that is really in the app: in the asar, or listed as unpacked and present on disk.
function manifest(rel) {
  if (!files.has(rel)) return null;
  let stat = null;
  try { stat = asar.statFile(asarPath, rel); } catch (e) { return { error: `unreadable (${e.code || e.message})` }; }
  const text = stat?.unpacked
    ? (existsSync(path.join(`${asarPath}.unpacked`, rel)) ? readFileSync(path.join(`${asarPath}.unpacked`, rel), 'utf8') : null)
    : asar.extractFile(asarPath, rel).toString('utf8');
  if (text == null) return { error: 'listed as unpacked but not on disk' };
  try { return { json: JSON.parse(text) }; } catch (e) { return { error: `not valid JSON (${e.message})` }; }
}

// Node's lookup from a package directory ('' is the app root): every ancestor folder, one level at a time, except
// folders that are themselves named node_modules (Codex r2: a scope folder's own node_modules counts).
function resolve(name, fromDir) {
  for (let dir = fromDir; ; dir = path.posix.dirname(dir) === '.' ? '' : path.posix.dirname(dir)) {
    if (path.posix.basename(dir) !== 'node_modules') {
      const rel = path.posix.join(dir, 'node_modules', name, 'package.json');
      if (files.has(rel)) return rel;
    }
    if (!dir) return null;
  }
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const problems = [];
const seen = new Set();
const queue = Object.keys(pkg.dependencies || {}).map((name) => ({ name, from: '', via: 'package.json' }));
while (queue.length) {
  const { name, from, via } = queue.shift();
  const rel = resolve(name, from);
  if (!rel) { problems.push(`${name} (needed by ${via}): not in the app`); continue; }
  if (seen.has(rel)) continue;
  seen.add(rel);
  const m = manifest(rel);
  if (!m.json) { problems.push(`${name} (needed by ${via}): ${m.error}`); continue; }
  const dir = rel.slice(0, -'/package.json'.length);
  for (const dep of Object.keys(m.json.dependencies || {})) {
    if (m.json.optionalDependencies && dep in m.json.optionalDependencies) continue;
    queue.push({ name: dep, from: dir, via: name });
  }
}

if (problems.length) {
  console.error(`ERROR: ${asarPath} is missing ${problems.length} runtime dependencies:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`packaged deps OK: ${seen.size} runtime packages found from ${Object.keys(pkg.dependencies || {}).length} production dependencies`);
