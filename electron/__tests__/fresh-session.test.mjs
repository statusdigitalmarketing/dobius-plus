import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// ISOLATION: point HOME at a throwaway dir BEFORE importing data-service, whose
// PROJECTS_DIR is derived from os.homedir() at module load (os.homedir() reads
// $HOME on POSIX). Without this the suite writes fixtures into the developer's
// REAL ~/.claude/projects, which pollutes live Claude data and hard-fails
// wherever HOME is read-only or sandboxed. `npm test` runs this, so it has to
// be inert. Codex v1.0.39 r10 P2.
const TMP_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'dobius-freshtest-home-'));
process.env.HOME = TMP_HOME;
// Dynamic, so it resolves PROJECTS_DIR against TMP_HOME. A static import would
// hoist above the assignment above and defeat the whole point.
const { resolveFreshSessionsForTabs } = await import('../data-service.js');

// Real fixture: real transcript files whose birth times are real, created 15s
// apart so they sit outside the resolver's 10s clock slack and each start time
// maps to exactly one candidate. All of it lives under TMP_HOME.
const PROJ = '/private/tmp/dobius-freshtest-proj';
const enc = PROJ.replace(/[^a-zA-Z0-9.\-]/g, '-');
const dir = path.join(TMP_HOME, '.claude', 'projects', enc);
const X = 'aaaaaaaa-1111-1111-1111-111111111111';
const Y = 'bbbbbbbb-2222-2222-2222-222222222222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        got=${got} want=${want}`);
};

await fs.mkdir(dir, { recursive: true });
try {
  await fs.writeFile(path.join(dir, `${X}.jsonl`), '{}\n');
  await sleep(15000);
  await fs.writeFile(path.join(dir, `${Y}.jsonl`), '{}\n');
  const bx = (await fs.stat(path.join(dir, `${X}.jsonl`))).birthtimeMs;
  const by = (await fs.stat(path.join(dir, `${Y}.jsonl`))).birthtimeMs;
  console.log(`fixture: X born ${new Date(bx).toISOString()}  Y born ${new Date(by).toISOString()}  gap=${Math.round(by - bx)}ms\n`);

  const tabs = (ids) => ids.map((id) => ({ id, cwd: PROJ }));
  const mk = (starts) => {
    const info = new Map(), cwd = new Map();
    for (const [id, s] of Object.entries(starts)) {
      info.set(id, { sessionId: null, startedAt: s });
      cwd.set(id, PROJ);
    }
    return { info, cwd };
  };

  // CASE 1 (Codex r6, the regression this fix targets): tab A is a fresh claude
  // ALREADY LINKED to X and still running. Sam then starts a second bare
  // `claude` (tab B) in the same project. A's start predates Y's birth, so the
  // old code called B ambiguous and declined it FOREVER. A owns X already, so
  // it cannot own Y: B must resolve to Y.
  {
    const { info, cwd } = mk({ A: bx - 5000, B: by - 1000 });
    const r = await resolveFreshSessionsForTabs(
      tabs(['A', 'B']), info, cwd, new Map([['A', X]]), new Set([X]),
    );
    check('r6: 2nd bare claude links while an older linked one runs', r.get('B'), Y);
    check('r6: the older linked tab still re-resolves to its own X', r.get('A'), X);
  }

  // CASE 2 (Codex r4 guard MUST survive): two UNLINKED fresh claudes, both
  // started before X was born. Either could have created it. Decline both.
  {
    const { info, cwd } = mk({ A: bx - 5000, B: bx - 4000 });
    const r = await resolveFreshSessionsForTabs(
      tabs(['A', 'B']), info, cwd, new Map(), new Set([Y]),
    );
    check('r4: genuinely ambiguous pair declines (A)', r.get('A'), undefined);
    check('r4: genuinely ambiguous pair declines (B)', r.get('B'), undefined);
  }

  // CASE 3: two unlinked fresh claudes started far apart cascade in ONE pass.
  // Earliest-first ordering: A links X, which removes A from B's ambiguity set,
  // so B then links Y. Quit has no next tick, so one pass has to do it.
  {
    const { info, cwd } = mk({ A: bx - 1000, B: by - 1000 });
    const r = await resolveFreshSessionsForTabs(
      tabs(['B', 'A']), info, cwd, new Map(), new Set(),  // deliberately out of order
    );
    check('cascade: earlier claude takes X', r.get('A'), X);
    check('cascade: later claude then takes Y in the same pass', r.get('B'), Y);
  }

  // CASE 4: no double-claim. Two tabs must never resolve to the same id.
  {
    const { info, cwd } = mk({ A: bx - 1000, B: by - 1000 });
    const r = await resolveFreshSessionsForTabs(
      tabs(['A', 'B']), info, cwd, new Map(), new Set(),
    );
    const vals = [...r.values()];
    check('no two tabs share one transcript', new Set(vals).size, vals.length);
  }

  // CASE 5 (Codex r7): tab A carries a STALE link to X (X was born BEFORE A's
  // current process started, so a previous process in that tab owned it) and is
  // now running a bare `claude`. A's real transcript is therefore still
  // unresolved, which keeps A a rival claimant for Y. Both A and B started
  // before Y was born, so Y is genuinely ambiguous and BOTH must decline.
  // Treating A as "linked" (it has a map entry) let B claim Y outright.
  {
    const { info, cwd } = mk({ A: by - 3000, B: by - 2000 });
    const r = await resolveFreshSessionsForTabs(
      tabs(['A', 'B']), info, cwd, new Map([['A', X]]), new Set([X]),
    );
    check('r7: stale-linked tab still counts as a rival (B declines)', r.get('B'), undefined);
    check('r7: stale-linked tab does not claim the ambiguous one either', r.get('A'), undefined);
  }

  // CASE 6: abort (the quit 2s cap) stops the loop.
  {
    const { info, cwd } = mk({ A: bx - 1000, B: by - 1000 });
    const r = await resolveFreshSessionsForTabs(
      tabs(['A', 'B']), info, cwd, new Map(), new Set(), () => true,
    );
    check('abort flag stops resolution immediately', r.size, 0);
  }
} finally {
  // Remove the whole throwaway HOME, not just the project dir.
  await fs.rm(TMP_HOME, { recursive: true, force: true });
  console.log(`\ncleaned up ${TMP_HOME}`);
}
console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
