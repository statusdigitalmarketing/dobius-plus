// A whisper-server is stopped as an orphan only when it matches the record written when Dobius started it: parent
// launchd (1), the same start time, and our per-start secret request path as a real argument.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOurOrphan, reapOrphanServers } from '../voice-transcribe.js';

const RP = '/dobius-0123456789abcdef0123456789abcdef';
const rec = { pid: 56122, lstart: 'Wed Nov 11 02:07:56 2026', requestPath: RP };
const args = `--model /m.bin --host 127.0.0.1 --port 8089 --request-path ${RP} --convert --flash-attn --tmp-dir /tmp/dobius-whisper-1`;

test('our server, orphaned, same start time: stopped', () => {
  assert.equal(isOurOrphan(rec, `    1 Wed Nov 11 02:07:56 2026     /opt/homebrew/bin/whisper-server ${args}`), true);
  // ps pads single-digit days with a space
  assert.equal(isOurOrphan({ ...rec, lstart: 'Mon Nov  3 09:01:02 2026' }, `    1 Mon Nov  3 09:01:02 2026     /opt/homebrew/bin/whisper-server ${args}`), true);
});

test('anything else is left alone', () => {
  // still has its parent (a running copy)
  assert.equal(isOurOrphan(rec, `47036 Wed Nov 11 02:07:56 2026     /opt/homebrew/bin/whisper-server ${args}`), false);
  // pid reused: different start time
  assert.equal(isOurOrphan(rec, `    1 Wed Nov 11 03:00:00 2026     /opt/homebrew/bin/whisper-server ${args}`), false);
  // a different request path (another run's, or none)
  assert.equal(isOurOrphan(rec, `    1 Wed Nov 11 02:07:56 2026     /opt/homebrew/bin/whisper-server ${args.replace(RP, '/dobius-ffffffffffffffffffffffffffffffff')}`), false);
  // not a whisper-server
  assert.equal(isOurOrphan(rec, `    1 Wed Nov 11 02:07:56 2026     /usr/bin/vim whisper-server ${args}`), false);
  assert.equal(isOurOrphan(rec, ''), false);
  assert.equal(isOurOrphan(rec, null), false);
});

test('an orphan that ignores SIGTERM keeps its record and gets SIGKILL next time; a gone one is dropped', async () => {
  const line = `    1 Wed Nov 11 02:07:56 2026     /opt/homebrew/bin/whisper-server ${args}`;
  let saved = [rec];
  const sent = [];
  const deps = { ps: async () => line, kill: (pid, sig) => sent.push([pid, sig]), records: () => saved, save: (r) => { saved = r; } };
  await reapOrphanServers(deps);
  assert.deepEqual(sent, [[56122, 'SIGTERM']]);
  assert.equal(saved.length, 1);
  await reapOrphanServers(deps); // still alive: wedged
  assert.deepEqual(sent[1], [56122, 'SIGKILL']);
  await reapOrphanServers({ ...deps, ps: async () => null }); // ps failed (timeout): not known, kept
  assert.equal(saved.length, 1);
  await reapOrphanServers({ ...deps, ps: async () => '' }); // gone now
  assert.deepEqual(saved, []);
  // A record whose process has a live parent is left alone and kept.
  saved = [rec]; sent.length = 0;
  await reapOrphanServers({ ...deps, ps: async () => line.replace(/^ {4}1 /, '4703 ') });
  assert.deepEqual(sent, []);
  assert.equal(saved.length, 1);
});

test('a provisional record (start time not known yet) still matches by the secret request path, never without it', () => {
  const prov = { ...rec, lstart: null };
  assert.equal(isOurOrphan(prov, `    1 Wed Nov 11 09:09:09 2026     /opt/homebrew/bin/whisper-server ${args}`), true);
  assert.equal(isOurOrphan(prov, `    1 Wed Nov 11 09:09:09 2026     /opt/homebrew/bin/whisper-server ${args.replace(RP, '/dobius-ffffffffffffffffffffffffffffffff')}`), false);
});
