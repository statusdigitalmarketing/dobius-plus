import { execFile } from 'child_process';
import path from 'path';

const EXEC_TIMEOUT = 10_000;
const HASH_RE = /^[a-f0-9]{4,40}$/;
const NUMBER_RE = /^\d+$/;

let ghAvailableCache = null;

/**
 * Validate and resolve a project directory path.
 */
function validateDir(dir) {
  if (!dir || typeof dir !== 'string') return null;
  const resolved = path.resolve(dir);
  if (resolved !== path.normalize(dir)) return null;
  return resolved;
}

/**
 * Run a command and return stdout as a string.
 */
function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: EXEC_TIMEOUT, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

/**
 * Get git status: branch, ahead/behind, file counts, isRepo flag.
 */
export async function getGitStatus(projectDir) {
  const dir = validateDir(projectDir);
  if (!dir) return { isRepo: false };
  try {
    const [branchOut, statusOut, aheadBehindOut] = await Promise.all([
      run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], dir),
      run('git', ['status', '--porcelain'], dir),
      run('git', ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], dir).catch(() => '0\t0'),
    ]);

    const lines = statusOut.trim().split('\n').filter(Boolean);
    let staged = 0, modified = 0, untracked = 0;
    for (const line of lines) {
      const x = line[0], y = line[1];
      if (x === '?' && y === '?') { untracked++; continue; }
      if (x !== ' ' && x !== '?') staged++;
      if (y !== ' ' && y !== '?') modified++;
    }

    const [ahead, behind] = aheadBehindOut.trim().split(/\s+/).map(Number);

    return {
      isRepo: true,
      branch: branchOut.trim(),
      ahead: ahead || 0,
      behind: behind || 0,
      staged,
      modified,
      untracked,
    };
  } catch {
    return { isRepo: false };
  }
}

/**
 * Get commit log with hash, author, date, subject.
 */
export async function getCommitLog(projectDir, count = 50) {
  const dir = validateDir(projectDir);
  if (!dir) return [];
  try {
    const sep = '\x00';
    const format = ['%H', '%an', '%aI', '%s'].join(sep);
    const stdout = await run('git', ['log', `--max-count=${Math.min(count, 200)}`, `--format=${format}`], dir);
    return stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [hash, author, date, subject] = line.split(sep);
      return { hash, author, date, subject };
    });
  } catch {
    return [];
  }
}

/**
 * Get local + remote branches with current indicator.
 */
export async function getBranches(projectDir) {
  const dir = validateDir(projectDir);
  if (!dir) return { current: '', local: [], remote: [] };
  try {
    const stdout = await run('git', ['branch', '-a', '--no-color'], dir);
    const local = [], remote = [];
    let current = '';
    for (const raw of stdout.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('* ')) {
        current = line.slice(2);
        local.push(current);
      } else if (line.startsWith('remotes/')) {
        if (!line.includes('HEAD ->')) remote.push(line.replace('remotes/', ''));
      } else {
        local.push(line);
      }
    }
    return { current, local, remote };
  } catch {
    return { current: '', local: [], remote: [] };
  }
}

/**
 * Get unified diff for a specific commit hash.
 */
export async function getCommitDiff(projectDir, hash) {
  const dir = validateDir(projectDir);
  if (!dir || !HASH_RE.test(hash)) return '';
  try {
    const stdout = await run('git', ['show', '--format=', '--stat', '--patch', hash], dir);
    // Truncate large diffs at 50K chars
    return stdout.length > 50_000 ? stdout.slice(0, 50_000) + '\n\n[diff truncated at 50K chars]' : stdout;
  } catch {
    return '';
  }
}

/**
 * Check if gh CLI is available (cached).
 */
export async function checkGhAvailable() {
  if (ghAvailableCache !== null) return ghAvailableCache;
  try {
    await run('which', ['gh'], '/');
    ghAvailableCache = true;
  } catch {
    ghAvailableCache = false;
  }
  return ghAvailableCache;
}

/**
 * Get open pull requests via gh CLI.
 */
export async function getPullRequests(projectDir) {
  const dir = validateDir(projectDir);
  if (!dir) return [];
  try {
    const stdout = await run('gh', [
      'pr', 'list', '--json', 'number,title,state,author,createdAt,headRefName,statusCheckRollup,reviewRequests',
      '--limit', '20',
    ], dir);
    return JSON.parse(stdout);
  } catch {
    return [];
  }
}

/**
 * Get open issues via gh CLI.
 */
export async function getIssues(projectDir) {
  const dir = validateDir(projectDir);
  if (!dir) return [];
  try {
    const stdout = await run('gh', [
      'issue', 'list', '--json', 'number,title,state,author,createdAt,labels,assignees',
      '--limit', '30',
    ], dir);
    return JSON.parse(stdout);
  } catch {
    return [];
  }
}

/**
 * Get details for a specific PR.
 */
export async function getPrDetails(projectDir, prNumber) {
  const dir = validateDir(projectDir);
  if (!dir || !NUMBER_RE.test(String(prNumber))) return null;
  try {
    const stdout = await run('gh', [
      'pr', 'view', String(prNumber), '--json',
      'number,title,state,body,author,createdAt,headRefName,baseRefName,additions,deletions,commits,reviews,statusCheckRollup',
    ], dir);
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/**
 * Get details for a specific issue.
 */
export async function getIssueDetails(projectDir, issueNumber) {
  const dir = validateDir(projectDir);
  if (!dir || !NUMBER_RE.test(String(issueNumber))) return null;
  try {
    const stdout = await run('gh', [
      'issue', 'view', String(issueNumber), '--json',
      'number,title,state,body,author,createdAt,labels,assignees,comments',
    ], dir);
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}
