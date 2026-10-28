// shared/chat-activity.js: the live spinner meter both chat views show.
// Run: node ./electron/__tests__/chat-activity.test.mjs
import assert from 'node:assert/strict';
import { fmtElapsed, fmtTokens, normalizeActivity, liveSeconds, activityMeta, SPIN_FRAMES } from '../../shared/chat-activity.js';

// 1. Claude's own formats.
assert.deepEqual([0, 8, 59, 60, 72, 3599, 3600, 3723].map(fmtElapsed), ['0s', '8s', '59s', '1m 0s', '1m 12s', '59m 59s', '1h 0m', '1h 2m']);
assert.deepEqual([null, -1, NaN, '5'].map(fmtElapsed), ['', '', '', '']);
assert.deepEqual([0, 95, 999, 1000, 2300, 9950, 12400, 1.2e6].map(fmtTokens), ['0', '95', '999', '1k', '2.3k', '9.9k', '12k', '1.2M']);
console.log('PASS  elapsed and token formats');

// 2. Whatever a Mac sends is checked field by field.
assert.equal(normalizeActivity(null), null);
assert.equal(normalizeActivity('Whirlpooling'), null);
assert.deepEqual(normalizeActivity({ verb: 'Whirlpooling', seconds: 72, tokens: 2300, dir: 'up' }), { verb: 'Whirlpooling', seconds: 72, tokens: 2300, dir: 'up' });
assert.deepEqual(normalizeActivity({ verb: 7, seconds: '72', tokens: -1, dir: 'sideways' }), { verb: '', seconds: null, tokens: null, dir: null });
assert.equal(normalizeActivity({ verb: 'x'.repeat(200) }).verb.length, 48);
console.log('PASS  activity is normalized');

// 3. The clock counts on from the last reading, and from 0 without one.
assert.equal(liveSeconds({ at: 1000, seconds: 72 }, 4500), 75);
assert.equal(liveSeconds({ at: 1000, seconds: null }, 3999), 2);
assert.equal(liveSeconds({ at: 5000, seconds: 10 }, 1000), 10, 'a clock behind the reading never runs backwards');
assert.equal(liveSeconds(null, 1000), null);
console.log('PASS  the clock ticks between readings');

// 4. The meter line, either half optional.
assert.equal(activityMeta(72, { tokens: 2300, dir: 'up' }), '1m 12s · ↑ 2.3k tokens');
assert.equal(activityMeta(5, { tokens: null }), '5s');
assert.equal(activityMeta(null, { tokens: 95, dir: 'down' }), '↓ 95 tokens');
assert.equal(activityMeta(null, null), '');
assert.equal(SPIN_FRAMES.length, 10);
console.log('PASS  meter line');
