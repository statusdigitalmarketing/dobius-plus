/**
 * deploy-service.js — git-based deploy for the Visual panel.
 *
 * Two actions back the Visual window's Deploy buttons:
 *   • deployPreview — commit working changes and force-push them to a throwaway
 *     preview branch. A git-integrated host (Vercel) builds a preview URL.
 *     Production is never touched.
 *   • promote — push the prod branch (main) to origin. The host auto-deploys to
 *     the live site.
 *
 * Safety: git runs via execFile (no shell). Force-push is allowed ONLY to the
 * throwaway preview branch; the prod branch is a plain push that refuses
 * non-fast-forwards. Every result carries captured stdout/stderr so failures are
 * shown, never swallowed. Nothing here runs unless the user presses a button.
 */
import { execFile } from 'child_process';
import path from 'path';

const PUSH_TIMEOUT = 120_000; // network pushes can be slow
const READ_TIMEOUT = 15_000;
const DEFAULT_PREVIEW_BRANCH = 'visual-preview';
const DEFAULT_PROD_BRANCH = 'main';

// Run git without a shell. Never rejects — returns a structured result so the
// caller can surface stderr instead of throwing it away.
function git(args, cwd, timeout = READ_TIMEOUT) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err?.code ?? 0,
        stdout: (stdout || '').toString(),
        stderr: (stderr || '').toString(),
      });
    });
  });
}

function validateDir(dir) {
  if (!dir || typeof dir !== 'string') return null;
  const resolved = path.resolve(dir);
  return path.isAbsolute(resolved) ? resolved : null;
}

// Only accept simple, safe branch names; reject anything that could be an option
// or a traversal. Falls back to null so callers use their default.
// SECURITY (Codex PR#3 r11 P1): also reject fully qualified refs like
// `refs/heads/main`. The downstream `previewBranch === prodBranch` guard does
// short-name equality, so a preview branch configured as `refs/heads/main`
// alongside prodBranch `main` would slip past, and `git push -f origin
// HEAD:refs/heads/main` would force-update production through the preview
// deploy path. Strip the refs/heads/ prefix and treat the bare name as the
// candidate (or reject entirely; we reject to keep the contract simple).
function sanitizeBranch(name) {
  if (!name || typeof name !== 'string') return null;
  const s = name.trim();
  // Refuse fully qualified refs.
  if (s.startsWith('refs/')) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(s)) return null;
  if (s.includes('..')) return null;
  return s;
}

// "XY path" porcelain v1 lines -> { status, file }. Untracked is "?? path".
function parseStatusLine(line) {
  return { status: line.slice(0, 2).trim() || '??', file: line.slice(3) };
}

async function repoRootOf(dir) {
  const top = await git(['rev-parse', '--show-toplevel'], dir);
  return top.ok ? top.stdout.trim() : null;
}

/**
 * Read-only snapshot for the UI: branch, changed files, whether a preview
 * branch already exists, and how many commits are ahead of live.
 */
export async function deployStatus(projectDir, opts = {}) {
  const dir = validateDir(projectDir);
  if (!dir) return { ok: false, error: 'Invalid project path' };
  const prodBranch = sanitizeBranch(opts.prodBranch) || DEFAULT_PROD_BRANCH;
  const previewBranch = sanitizeBranch(opts.previewBranch) || DEFAULT_PREVIEW_BRANCH;

  const repoRoot = await repoRootOf(dir);
  if (!repoRoot) return { ok: false, error: 'Not a git repository' };

  const [branchR, statusR, aheadR, lsR] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot),
    git(['status', '--porcelain'], repoRoot),
    git(['rev-list', '--count', `origin/${prodBranch}..HEAD`], repoRoot),
    git(['ls-remote', '--heads', 'origin', previewBranch], repoRoot),
  ]);

  const changedFiles = statusR.stdout.split('\n').filter(Boolean).map(parseStatusLine);
  const ahead = aheadR.ok ? (parseInt(aheadR.stdout.trim(), 10) || 0) : 0;

  return {
    ok: true,
    repoRoot,
    branch: branchR.stdout.trim(),
    changedFiles,
    ahead,
    hasPreviewBranch: lsR.ok && lsR.stdout.trim().length > 0,
    prodBranch,
    previewBranch,
  };
}

/**
 * Commit working changes and force-push them to the throwaway preview branch.
 * Production (the prod branch) is not touched.
 */
export async function deployPreview(projectDir, opts = {}) {
  const dir = validateDir(projectDir);
  if (!dir) return { ok: false, error: 'Invalid project path' };
  const previewBranch = sanitizeBranch(opts.previewBranch) || DEFAULT_PREVIEW_BRANCH;
  const prodBranch = sanitizeBranch(opts.prodBranch) || DEFAULT_PROD_BRANCH;
  const message = (typeof opts.message === 'string' && opts.message.trim())
    ? opts.message.trim()
    : 'Visual preview deploy';

  // Enforce the force-push-only-targets-preview invariant in code, not config:
  // a preview branch equal to the prod branch would turn the force-push below
  // into a force-push to production.
  if (previewBranch === prodBranch) {
    return { ok: false, error: `Refusing to deploy: preview branch must differ from the live branch ("${prodBranch}").` };
  }

  const repoRoot = await repoRootOf(dir);
  if (!repoRoot) return { ok: false, error: 'Not a git repository' };

  const log = [];
  const record = (label, r) => { log.push(`$ git ${label}\n${(r.stdout + r.stderr).trim()}`); return r; };

  const add = record('add -A', await git(['add', '-A'], repoRoot));
  if (!add.ok) return { ok: false, error: 'git add failed', detail: add.stderr, log };

  // `diff --cached --quiet` exits 0 when nothing is staged, 1 when there are
  // staged changes. Only commit when there is something to commit.
  const staged = await git(['diff', '--cached', '--quiet'], repoRoot);
  let committed = false;
  if (!staged.ok) {
    // `--` terminates options so a message beginning with '-' can't be parsed as a flag.
    const commit = record(`commit -m "${message}"`, await git(['commit', '-m', message, '--'], repoRoot));
    if (!commit.ok) return { ok: false, error: 'git commit failed', detail: commit.stderr, log };
    committed = true;
  }

  const headR = await git(['rev-parse', 'HEAD'], repoRoot);
  const sha = headR.stdout.trim().slice(0, 7);

  // Force ONLY the throwaway preview branch — never the prod branch.
  const push = record(`push -f origin HEAD:${previewBranch}`,
    await git(['push', '-f', 'origin', `HEAD:${previewBranch}`], repoRoot, PUSH_TIMEOUT));
  if (!push.ok) return { ok: false, error: 'Push to preview branch failed', detail: push.stderr, log, committed, sha };

  return { ok: true, committed, sha, previewBranch, log };
}

/**
 * Push the prod branch to origin so the host deploys it live. Plain push (no
 * force): a non-fast-forward is surfaced, not overwritten.
 */
export async function promote(projectDir, opts = {}) {
  const dir = validateDir(projectDir);
  if (!dir) return { ok: false, error: 'Invalid project path' };
  const prodBranch = sanitizeBranch(opts.prodBranch) || DEFAULT_PROD_BRANCH;

  const repoRoot = await repoRootOf(dir);
  if (!repoRoot) return { ok: false, error: 'Not a git repository' };

  const branchR = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  const branch = branchR.stdout.trim();
  if (branch !== prodBranch) {
    return { ok: false, error: `Not on ${prodBranch} (currently on ${branch}). Switch to ${prodBranch} before going live.` };
  }

  const push = await git(['push', 'origin', prodBranch], repoRoot, PUSH_TIMEOUT);
  const log = [`$ git push origin ${prodBranch}\n${(push.stdout + push.stderr).trim()}`];
  if (!push.ok) {
    return { ok: false, error: 'Push to live failed — the remote may be ahead (pull first).', detail: push.stderr, log };
  }
  return { ok: true, prodBranch, log };
}
