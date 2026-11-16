// Clickable [Image #N] labels in the terminal (Asana 1220551275244579). Run: node ./electron/__tests__/pasted-images.test.mjs
import assert from 'node:assert/strict';

const store = new Map();
globalThis.window = { localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) } };
const { recordImageLabel, imageForLabel, labelsOnScreen, watchForImageLabels, reserveImageLabel, imageLinkProvider } = await import('../../src/lib/pasted-images.js');

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
// Two pastes before Claude draws either: one joint watch, so #1 goes to the first and #2 to the second.
term = fakeTerm(['>']);
watchForImageLabels('tab-e', () => term, ['/e/A.png'], labelsOnScreen(term));
watchForImageLabels('tab-e', () => term, ['/e/B.png'], labelsOnScreen(term));
term = fakeTerm(['> [Image #1]']);
await new Promise((r) => setTimeout(r, 200));
term = fakeTerm(['> [Image #1] [Image #2]']);
await new Promise((r) => setTimeout(r, 300));
assert.equal(imageForLabel('tab-e', 1), '/e/A.png');
assert.equal(imageForLabel('tab-e', 2), '/e/B.png');
// A printed [Image #9000] on screen does not block Claude's real #1.
term = fakeTerm(['output: [Image #9000]', '>']);
watchForImageLabels('tab-f', () => term, ['/f/1.png'], labelsOnScreen(term));
term = fakeTerm(['output: [Image #9000]', '> [Image #1]']);
await new Promise((r) => setTimeout(r, 300));
assert.equal(imageForLabel('tab-f', 1), '/f/1.png');
assert.equal(imageForLabel('tab-f', 9000), null);
// A pasted before B, B saved first: labels follow paste order, not save order. A paste that did not go in is skipped.
term = fakeTerm(['>']);
const slotA = reserveImageLabel('tab-g', () => term, labelsOnScreen(term));
const slotB = reserveImageLabel('tab-g', () => term, labelsOnScreen(term));
const slotC = reserveImageLabel('tab-g', () => term, labelsOnScreen(term));
slotB('/g/B.png');
term = fakeTerm(['> [Image #1] [Image #2]']);
await new Promise((r) => setTimeout(r, 200));
assert.equal(imageForLabel('tab-g', 1), null, 'held until A is saved');
slotA('/g/A.png');
slotC(null);
await new Promise((r) => setTimeout(r, 200));
assert.equal(imageForLabel('tab-g', 1), '/g/A.png');
assert.equal(imageForLabel('tab-g', 2), '/g/B.png');
// A place given up after a label was matched to it hands that label to the next place in line.
term = fakeTerm(['>']);
const hA = reserveImageLabel('tab-h', () => term, labelsOnScreen(term));
const hB = reserveImageLabel('tab-h', () => term, labelsOnScreen(term));
term = fakeTerm(['> [Image #1]']);
await new Promise((r) => setTimeout(r, 200));
hA(null); hB('/h/B.png');
await new Promise((r) => setTimeout(r, 200));
assert.equal(imageForLabel('tab-h', 1), '/h/B.png');
// A slow save outlives the watch window: its place in line holds, so a later quick paste does not take its label.
term = fakeTerm(['>']);
const iA = reserveImageLabel('tab-i', () => term, labelsOnScreen(term), 150);
await new Promise((r) => setTimeout(r, 400)); // past A's window, A still saving
const iB = reserveImageLabel('tab-i', () => term, labelsOnScreen(term), 150);
iB('/i/B.png');
iA('/i/A.png');
term = fakeTerm(['> [Image #1] [Image #2]']);
await new Promise((r) => setTimeout(r, 300));
assert.equal(imageForLabel('tab-i', 1), '/i/A.png');
assert.equal(imageForLabel('tab-i', 2), '/i/B.png');
// A finished watch takes the next paste's own baseline: text printed in between is not that paste's label.
term = fakeTerm(['>']);
const jA = reserveImageLabel('tab-j', () => term, labelsOnScreen(term));
term = fakeTerm(['> [Image #1]']);
jA('/j/A.png');
term = fakeTerm(['printed: [Image #9000]', '> [Image #1]']);
const jB = reserveImageLabel('tab-j', () => term, labelsOnScreen(term));
jB('/j/B.png');
term = fakeTerm(['printed: [Image #9000]', '> [Image #1] [Image #2]']);
await new Promise((r) => setTimeout(r, 300));
assert.equal(imageForLabel('tab-j', 1), '/j/A.png');
assert.equal(imageForLabel('tab-j', 2), '/j/B.png');
assert.equal(imageForLabel('tab-j', 9000), null);
console.log('ALL PASS  (pasted-images)');
