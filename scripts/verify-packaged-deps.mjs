#!/usr/bin/env node
// Refuses a packaged app that lacks a runtime dependency (2.2.34: every scoped package, @xterm/* among them, was left
// out and the app died at launch with ERR_MODULE_NOT_FOUND). release.sh runs it while the release is still a draft.
//
// From each production dependency it follows `dependencies` (not optional or peer ones) the way Node resolves them:
// <dir>/node_modules/<name>, then each ancestor folder's node_modules up to the app root (Codex r1: a missing transitive
// dependency such as chokidar's readdirp also kills the app at launch). A manifest asarUnpack moved out of the asar is
// only listed in the header, so its file must also exist under app.asar.unpacked (Codex r1). Each package's entry file
// must be there too, since a manifest alone proves nothing loadable (Codex r3).
//
// Usage: node scripts/verify-packaged-deps.mjs <path to app.asar>
import { createRequire } from 'node:module';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar'); // electron-builder's own dependency, so always installed with it

const asarPath = process.argv[2];
if (!asarPath) { console.error('usage: verify-packaged-deps.mjs <app.asar>'); process.exit(2); }

const files = new Set(asar.listPackage(asarPath).map((f) => f.replace(/\\/g, '/').replace(/^\/+/, '')));

// Whether a FILE is really in the app (a folder does not count, Codex r4): a non-folder entry in the asar header, and
// a real file on disk when asarUnpack moved it out.
function present(rel) {
  if (!files.has(rel)) return false;
  let stat;
  try { stat = asar.statFile(asarPath, rel); }
  catch { return false; } // statFile throws only for a path the header does not hold, which files.has just ruled out
  if (!stat || stat.files) return false;
  if (!stat.unpacked) return true;
  try { return statSync(path.join(`${asarPath}.unpacked`, rel)).isFile(); } catch (e) { if (e.code !== 'ENOENT') throw e; return false; }
}

// A package.json that is really in the app, parsed.
function manifest(rel) {
  if (!present(rel)) return { error: files.has(rel) ? 'listed as unpacked but not on disk' : 'not in the app' };
  let stat;
  try { stat = asar.statFile(asarPath, rel); } catch (e) { return { error: `unreadable (${e.code || e.message})` }; }
  const text = stat?.unpacked ? readFileSync(path.join(`${asarPath}.unpacked`, rel), 'utf8') : asar.extractFile(asarPath, rel).toString('utf8');
  try { return { json: JSON.parse(text) }; } catch (e) { return { error: `not valid JSON (${e.message})` }; }
}

// The file `exports` maps the package root to: a string, or the "." entry, following the node/require/import/default
// conditions (arrays: first entry). null when there is no root export to judge (subpath-only maps).
function exportsRoot(exp) {
  if (Array.isArray(exp)) return exportsRoot(exp[0]);
  if (typeof exp === 'string') return exp;
  if (!exp || typeof exp !== 'object') return null;
  const keys = Object.keys(exp);
  if (keys.some((k) => k.startsWith('.'))) return '.' in exp ? exportsRoot(exp['.']) : null;
  for (const c of ['node', 'require', 'import', 'default']) if (c in exp) return exportsRoot(exp[c]);
  return null;
}

// A package's entry file, Node's way: the root of `exports` when it has one (Codex r3), else `main` (as a file, with
// .js/.json/.node added, or as a folder's index), else index.js. Returns the missing entry, or null when it is there
// or cannot be judged (subpath-only exports, or no main and no index.js: a package nobody require()s by name).
function missingEntry(dir, json) {
  let entry;
  if (json.exports !== undefined) {
    entry = exportsRoot(json.exports);
    if (entry == null) return null;
    return present(path.posix.normalize(path.posix.join(dir, entry))) ? null : entry;
  }
  if (json.main === undefined && !files.has(`${dir}/index.js`)) return null;
  entry = json.main ?? 'index.js';
  const main = path.posix.normalize(path.posix.join(dir, entry));
  const tries = [main, `${main}.js`, `${main}.json`, `${main}.node`, `${main}/index.js`, `${main}/index.json`, `${main}/index.node`];
  return tries.some(present) ? null : entry;
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
  const entry = missingEntry(dir, m.json);
  if (entry) problems.push(`${name} (needed by ${via}): its entry file ${entry} is not in the app`);
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
