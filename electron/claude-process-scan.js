// Which Claude processes are running RIGHT NOW, and which credential each is
// actually using (v1.0.75).
//
// Why by process and not by tab. Sam spent an evening spending a colleague's
// quota because nothing could tell him which account anything was on. A tab's
// recorded spawn binding is only the INITIAL intent: a login-shell profile can
// export CLAUDE_CONFIG_DIR, a wrapper can change it, and `CLAUDE_CONFIG_DIR=...
// claude` on one command line overrides it for that run. Processes started
// outside Dobius, detached descendants, and a second Dobius instance are not in
// the terminal registry at all. Grouping by the registry would therefore MISS
// running sessions, and missing one means the user keeps spending the old
// account believing they switched.
//
// Entirely read-only: `pgrep` and `ps`, no writes, and never `claude auth
// status`, which writes into the config dir it is asked about.
//
// Two rules this module will not bend:
//   - A binding that cannot be read is UNRESOLVED, never "default". Claiming a
//     session is on the default account when the environment could not be read
//     is the confident wrong answer that caused the incident.
//   - A process we cannot classify is still REPORTED, never silently dropped,
//     so a caller can say "I could not cover everything" instead of implying
//     full coverage.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyClaudeProcess } from './claude-argv.js';
import { keychainServiceFor } from './account-identity.js';

const execFileP = promisify(execFile);

/** The CLI's own default config dir, used when CLAUDE_CONFIG_DIR is unset. */
export const defaultConfigDir = () => path.join(os.homedir(), '.claude');

/**
 * Every live Claude process id for the current user.
 *
 * BOTH passes must succeed for the answer to be complete. They find different
 * things: `-x` matches the native binary by name, `-f` matches the npm shim
 * that runs as `node .../claude`. Treating "one pass worked" as success let a
 * timeout in the other pass hide an entire class of session, and the job then
 * reported every session switched while that one kept spending the old account
 * (reviewer HIGH, two lenses).
 *
 * @returns {{ pids: number[], failed: boolean }} `failed` when EITHER lookup
 *   errored, so "none running" can be told apart from "could not look".
 */
async function claudePids() {
  const pids = new Set();
  let failed = false;
  for (const args of [['-x', 'claude'], ['-f', 'claude']]) {
    try {
      const { stdout } = await execFileP('/usr/bin/pgrep', args, { timeout: 2000, encoding: 'utf8' });
      for (const line of stdout.split('\n')) {
        const pid = Number(line.trim());
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
    } catch (err) {
      // pgrep exits 1 with no output when nothing matched, which is a real
      // answer. Anything else (timeout, missing binary) is a failed lookup.
      if (!err || err.code !== 1) failed = true;
    }
  }
  pids.delete(process.pid);
  return { pids: [...pids], failed };
}

/**
 * Every place the LAST CLAUDE_CONFIG_DIR value could plausibly end, longest
 * first.
 *
 * A config dir may contain spaces, and `ps` separates variables with spaces
 * too, so the format alone cannot say where the value stops. Stopping at the
 * first space turned `/Users/x/Claude Profiles/a` into `/Users/x/Claude` and
 * pointed a logout at a third directory; stopping at the first `NAME=` still
 * truncated `/profiles/team TAG=prod`, and an unusual variable name such as
 * `BUILD-TAG=prod` was not recognised as a stop at all (reviewer HIGH, three
 * rounds). Only the filesystem can settle it, so every reading is offered and
 * the caller picks the longest that is a real directory.
 */
function configDirCandidates(tail) {
  const starts = [...tail.matchAll(/(?:^|\s)CLAUDE_CONFIG_DIR=/g)];
  if (starts.length === 0) return { found: false, candidates: [] };
  // A real environment carries the variable ONCE. A second occurrence means one
  // of them sits inside another variable's value, and the text gives no way to
  // say which: `HINT=use CLAUDE_CONFIG_DIR=/profiles/bob` is shaped exactly
  // like a real assignment, and taking the last one pointed the logout at Bob
  // while Alice's session kept spending (reviewer HIGH). Undecidable, so it is
  // reported rather than picked.
  if (starts.length > 1) return { found: true, candidates: [] };
  const last = starts[starts.length - 1];
  const raw = tail.slice(last.index + last[0].length);
  // Deliberately loose: anything shaped like a variable can end the value.
  const cuts = new Set([raw.length]);
  for (const m of raw.matchAll(/\s[^\s=]+=/g)) cuts.add(m.index);
  const candidates = [];
  for (const c of [...cuts].sort((a, b) => b - a)) {
    const v = raw.slice(0, c);
    if (v && !candidates.includes(v)) candidates.push(v);
  }
  return { found: true, candidates };
}

/**
 * The account binding a pair of `ps` reads proves, if any.
 *
 * Pure, and exported so the tests exercise THIS logic rather than a copy of the
 * regex that can drift away from it.
 *
 * @param {string} command argv only, from `ps -o command=`.
 * @param {string|null} envLine argv + environment, from `ps eww -o command=`.
 * @returns {{state:'explicit'|'default'|'unknown', configDir?:string}}
 *   'default' means the variable is provably unset. 'unknown' means we did not
 *   observe the binding and the caller must not guess.
 */
export function bindingFrom(command, envLine) {
  if (!envLine) return { state: 'unknown' };
  // These are two separate ps snapshots and a process can rewrite its own argv
  // between them. Slicing the second by the first's length then cut INTO the
  // environment, losing the CLAUDE_CONFIG_DIR assignment while leaving enough
  // other variables to look like a deliberate unset, so an explicitly bound
  // session was reported as default and the wrong credential re-logged
  // (reviewer HIGH). If the two reads do not agree on the argv, we did not
  // observe this process's environment and must say so.
  if (!envLine.startsWith(command)) return { state: 'unknown' };

  const tail = envLine.slice(command.length);
  // The prefix check alone only catches argv SHRINKING. If argv GREW between
  // the reads, the new arguments sit where the environment should start and get
  // parsed as variables: `claude` becoming `claude -p CLAUDE_CONFIG_DIR=/decoy`
  // aimed a logout at /decoy (reviewer HIGH, two passes). A real environment
  // region begins with an assignment, so anything else means we are not looking
  // at one.
  if (tail && !/^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(tail)) return { state: 'unknown' };
  const { found, candidates } = configDirCandidates(tail);
  if (!found) {
    // Unset ONLY if we can see an environment at all. If ps gave us no
    // variables we cannot tell, and must not claim the default.
    const sawAnyEnv = /(?:^|\s)[A-Za-z_][A-Za-z0-9_]*=/.test(tail);
    return { state: sawAnyEnv ? 'default' : 'unknown' };
  }
  if (candidates.length === 0) return { state: 'unknown' };
  // A RELATIVE binding is resolved by the CLI against ITS OWN working
  // directory, which we do not know. Resolving it against Dobius's cwd mapped
  // `CLAUDE_CONFIG_DIR=.claude` onto the default credential and pointed a
  // logout at the wrong item (reviewer HIGH). We cannot name the credential, so
  // this counts as unresolved rather than as a guess.
  if (!candidates[candidates.length - 1].startsWith('/')) return { state: 'unknown' };
  // The spellings stay verbatim, never realpath'd: the Keychain item is keyed
  // by a hash of exactly this string.
  return { state: 'explicit', candidates };
}

/**
 * One process's command line and, separately, its environment.
 *
 * `ps eww` appends the environment AFTER the argv, so testing that combined
 * string for "is this Claude" lets an unrelated interpreter match on a variable
 * value: `node /tmp/claude-helper.js CLAUDE_CONFIG_DIR=/profiles/claude` would
 * be counted as Claude and its directory scheduled for a logout (reviewer
 * HIGH). The command is therefore read WITHOUT the environment and classified
 * on its own.
 */
// `ps` terminates its output with a newline. Only that is stripped, never a
// trailing SPACE: a config dir whose name ends in one is a legal directory, and
// trimming it turned the binding into its differently named neighbour, whose
// credential then took the logout (reviewer HIGH).
const psOut = (r) => {
  const out = (r?.stdout || '').replace(/\r?\n+$/, '');
  return out.trim() ? out : null;
};

async function inspect(pid) {
  const argv = async () => {
    try {
      return psOut(await execFileP('/bin/ps', ['-p', String(pid), '-o', 'command='], { timeout: 2000, encoding: 'utf8' }));
    } catch { return null; } // gone, or not ours
  };

  const command = await argv();
  if (!command) return { pid, command: null, classify: 'unreadable' };
  let { kind, token } = classifyClaudeProcess(command);
  if (kind === 'not-claude') return { pid, command, classify: 'not-claude' };

  // The token the verdict rests on has to BE an executable file. A directory
  // named `claude` satisfies the name test, so both `/tmp/claude tools/sleep`
  // and `node '/tmp/claude tools/sleep.js'` read as Claude and scheduled a
  // logout for a process that was only sleeping (reviewer HIGH, twice: the
  // first fix checked argv[0], which is the INTERPRETER in the second shape).
  // A bare name goes through PATH and cannot be checked here.
  if (kind === 'claude' && token && token.includes('/')) {
    let isFile;
    try { isFile = (await fsp.stat(token)).isFile(); } catch { isFile = false; }
    if (!isFile) kind = 'maybe';
  }

  // A claude path is present but is not what this process runs. Acting on it
  // would log out a directory with no session on it; dropping it would hide a
  // session that may be real. Reported as unidentified instead.
  if (kind === 'maybe') return { pid, command, classify: 'ambiguous-command' };

  let envLine = null;
  try {
    envLine = psOut(await execFileP('/bin/ps', ['eww', '-p', String(pid), '-o', 'command='], {
      timeout: 2000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    }));
  } catch { /* environment unreadable */ }

  // Read argv AGAIN. The environment is parsed out of the second read by
  // stripping the first read's argv, so a process that rewrote its own argv in
  // between makes that split land in the wrong place. Both reads agreeing is
  // the evidence that the split is valid. Residual, and accepted: argv could
  // change and change back inside the window.
  if (envLine && (await argv()) !== command) return { pid, command, classify: 'claude', state: 'unknown' };

  const binding = bindingFrom(command, envLine);
  if (binding.state !== 'explicit') return { pid, command, classify: 'claude', ...binding };

  // Settle where the value ends by asking the filesystem. A reading that is not
  // a directory is proof we cut in the wrong place.
  //
  // EXACTLY ONE reading may be real. With `/profiles/team` and
  // `/profiles/team TAG=prod` both on disk, the ps line is identical whether
  // the value contains a space or TAG is simply the next variable, so
  // preferring either the longer or the shorter reading is a coin flip that
  // logs out a real credential when it loses (reviewer HIGH, both directions,
  // rounds three and four). Two survivors means we cannot name the credential.
  const real = [];
  for (const candidate of binding.candidates) {
    try { if ((await fsp.stat(candidate)).isDirectory()) real.push(candidate); } catch { /* not this one */ }
  }
  if (real.length !== 1) return { pid, command, classify: 'claude', state: 'unknown' };
  return { pid, command, classify: 'claude', state: 'explicit', configDir: real[0] };
}

async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

/**
 * Live Claude processes grouped by the CREDENTIAL they use.
 *
 * Grouping is by Keychain service name, not by the literal directory string,
 * because an unset CLAUDE_CONFIG_DIR and an explicit `~/.claude` resolve to the
 * SAME credential. Treating them as two groups would log the same credential
 * out twice, and a cancellation between the two would strand the sessions the
 * first pass had just moved (reviewer HIGH).
 *
 * @returns {Promise<{groups, unresolved, total, discoveryFailed}>}
 *   A caller must treat a non-empty `unresolved` or a true `discoveryFailed` as
 *   "I cannot claim to have covered everything".
 */
export async function scanClaudeProcesses() {
  const { pids, failed } = await claudePids();
  const rows = await mapLimit(pids, 8, inspect);

  const byCred = new Map();
  const unresolved = [];
  let total = 0;

  for (const r of rows) {
    if (!r || r.classify === 'not-claude') continue;
    if (r.classify === 'unreadable') {
      // pgrep saw a live Claude-matching pid but ps would not describe it.
      // Reported, never dropped (reviewer MEDIUM).
      total += 1; unresolved.push({ pid: r.pid, reason: 'command unreadable' });
      continue;
    }
    if (r.classify === 'ambiguous-command') {
      total += 1; unresolved.push({ pid: r.pid, reason: 'not clearly a Claude session' });
      continue;
    }
    total += 1;
    if (r.state === 'unknown') { unresolved.push({ pid: r.pid, reason: 'binding unreadable' }); continue; }

    const envUnset = r.state === 'default';
    const configDir = envUnset ? defaultConfigDir() : r.configDir;
    // The credential key is what a logout/login actually affects.
    let key;
    try { key = keychainServiceFor(configDir); } catch { key = configDir; }
    if (!byCred.has(key)) {
      byCred.set(key, { key, configDir, envUnset, sawUnset: false, sawExplicit: false, pids: [] });
    }
    const g = byCred.get(key);
    // If ANY session in this credential group ran with the variable unset, the
    // group must be operated on with it unset: that is the mode that reads the
    // home-level metadata file and the bare Keychain service.
    if (envUnset) { g.envUnset = true; g.configDir = defaultConfigDir(); g.sawUnset = true; }
    else g.sawExplicit = true;
    g.pids.push(r.pid);
  }

  // One credential, but its sessions were started in BOTH binding modes. The
  // two modes read DIFFERENT metadata files (home-level ~/.claude.json versus
  // ~/.claude/.claude.json) which can name different addresses while sharing
  // one credential, so neither file can be trusted to say who this group is
  // (reviewer HIGH, two lenses). Flagged rather than guessed.
  const groups = [...byCred.values()].map((g) => ({ ...g, mixedModes: g.sawUnset && g.sawExplicit }));

  return { groups, unresolved, total, discoveryFailed: failed };
}
