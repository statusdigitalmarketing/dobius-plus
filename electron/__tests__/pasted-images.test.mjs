// Clickable [Image #N] labels in the terminal (Asana 1220551275244579). Run: node ./electron/__tests__/pasted-images.test.mjs
import assert from 'node:assert/strict';

const store = new Map();
globalThis.window = { localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) } };
const { recordImageLabel, imageForLabel, labelsOnScreen, watchForImageLabels, imageLinkProvider } = await import('../../src/lib/pasted-images.js');

// A tiny stand-in for an xterm buffer: rows of cells, a wide character taking two cells.
function fakeTerm(rows, cols = 40) {
  const lines = rows.map((r) => {
    const cells = [];
    for (const ch of r) { cells.push({ ch, w: ch === '界' ? 2 : 1 }); if (ch === '界') cells.push({ ch: '', w: 0 }); }
    return {
      translateToString: () => cells.map((c) => c.ch).join(''),
      getCell: (x) => (x < cells.length ? { getChars: () => cells[x].ch, getWidth: () => cells[x].w } : (x < cols ? { getChars: () => ' ', getWidth: () => 1 } : undefined)),
    };
  });
  return { rows: lines.length, cols, buffer: { active: { viewportY: 0, getLine: (y) => lines[y] } } };
}

assert.deepEqual([...labelsOnScreen(fakeTerm(['[Image #3] [Image #4]', 'x', '[Pasted text #5 +2 lines]']))].sort(), [3, 4]);
assert.deepEqual([...labelsOnScreen(null)], []);

// The paste sees #4 appear above the #3 already there and records it for that tab only.
let term = fakeTerm(['[Image #3]']);
const before = labelsOnScreen(term);
watchForImageLabels('tab-a', () => term, ['/tmp/dobius-clipboard/clipboard-1.png'], before);
term = fakeTerm(['[Image #3] [Image #4]']);
await new Promise((r) => setTimeout(r, 300));
assert.equal(imageForLabel('tab-a', 4), '/tmp/dobius-clipboard/clipboard-1.png');
assert.equal(imageForLabel('tab-a', 3), null, 'a label that was already there is not this paste');
assert.equal(imageForLabel('tab-b', 4), null, 'per tab');

// Links only on known labels, at the right cells even after a wide character.
recordImageLabel('tab-a', 3, '/tmp/dobius-clipboard/clipboard-0.png');
const row = fakeTerm(['界 [Image #3] [Image #9]']);
let got;
imageLinkProvider(row, () => 'tab-a', () => {}).provideLinks(1, (l) => { got = l; });
assert.equal(got.length, 1, '#9 was never seen being pasted, so it stays text');
assert.deepEqual(got[0].range, { start: { x: 4, y: 1 }, end: { x: 13, y: 1 } });
let opened = null;
imageLinkProvider(row, () => 'tab-a', (p, n) => { opened = [p, n]; }).provideLinks(1, (l) => l[0].activate());
assert.deepEqual(opened, ['/tmp/dobius-clipboard/clipboard-0.png', 3]);
imageLinkProvider(row, () => 'tab-z', () => {}).provideLinks(1, (l) => { got = l; });
assert.equal(got, undefined);

// Bounded: 30 labels per tab, 40 tabs, and it survives a reload (read back from storage).
for (let n = 1; n <= 40; n += 1) recordImageLabel('tab-c', n, `/p/${n}.png`);
assert.equal(imageForLabel('tab-c', 10), null);
assert.equal(imageForLabel('tab-c', 40), '/p/40.png');
for (let t = 0; t < 45; t += 1) recordImageLabel(`many-${t}`, 1, '/p/x.png');
assert.ok(Object.keys(JSON.parse(store.get('dobius.pastedImages.v1'))).length <= 40);
// Two images sent together: oldest path gets the lower new number.
term = fakeTerm(['[Image #4]']);
watchForImageLabels('tab-d', () => term, ['/a/1.png', '/a/2.png'], labelsOnScreen(term));
term = fakeTerm(['[Image #4]', '> [Image #5] [Image #6] what is this']);
await new Promise((r) => setTimeout(r, 300));
assert.equal(imageForLabel('tab-d', 5), '/a/1.png');
assert.equal(imageForLabel('tab-d', 6), '/a/2.png');
console.log('ALL PASS  (pasted-images)');
