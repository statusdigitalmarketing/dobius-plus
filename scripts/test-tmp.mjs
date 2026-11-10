#!/usr/bin/env node
// Runs a command (the test suite) with TMPDIR, TMP and TEMP pointed at a fresh folder, then deletes that folder.
// Every temp file a test makes lands inside it, so a run leaves nothing behind even when a test forgets to clean
// up. 2026-11-10: ~100,000 leftover dobius-* test folders had built up in $TMPDIR.
//
// Bounded by construction: one folder per run, removed when the run ends. A run killed too hard to clean up
// (SIGKILL, power loss) leaves its folder; every later run first removes run folders whose owner process is
// gone or that are older than STALE_MS, so leftovers never accumulate.
//
// Usage: node scripts/test-tmp.mjs <command> [args...]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PREFIX = 'dobius-testrun-';
const STALE_MS = 6 * 60 * 60 * 1000; // no test run lasts 6 hours
const base = os.tmpdir();

function remove(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn(`test-tmp: could not remove ${dir}: ${err.message}`);
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function sweep() {
  let names;
  try {
    names = fs.readdirSync(base);
  } catch (err) {
    console.warn(`test-tmp: could not list ${base}: ${err.message}`);
    return;
  }
  for (const name of names) {
    const m = /^dobius-testrun-(\d+)-/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    const dir = path.join(base, name);
    let old = false;
    try {
      old = Date.now() - fs.statSync(dir).mtimeMs > STALE_MS;
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`test-tmp: could not stat ${dir}: ${err.message}`);
      continue;
    }
    if (pid !== process.pid && (old || !alive(pid))) remove(dir);
  }
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('usage: node scripts/test-tmp.mjs <command> [args...]');
  process.exit(2);
}

sweep();
const root = fs.mkdtempSync(path.join(base, `${PREFIX}${process.pid}-`));
const child = spawn(cmd, args, {
  stdio: 'inherit',
  env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
  shell: process.platform === 'win32', // npm is npm.cmd on Windows
});

// Ctrl+C reaches the child through the terminal's process group; a signal sent only to this wrapper is
// passed on. Either way the wrapper stays up until the child exits, then cleans up.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(sig);
  });
}

child.on('error', (err) => {
  console.error(`test-tmp: could not start ${cmd}: ${err.message}`);
  remove(root);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  remove(root);
  process.exit(code ?? (signal ? 1 : 0));
});
