// Selector parser (mobile Chat selector buttons). Verifies it extracts the
// trailing numbered-option block + cursor from raw ANSI terminal output.
import { parseSelector, stripAnsi } from '../selector-parser.js';

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

// 1. Classic permission prompt with ANSI color + cursor on option 1.
const perm =
  'Some context above\n' +
  '\x1b[1mDo you want to proceed?\x1b[0m\n' +
  '\x1b[36m❯ 1. Yes\x1b[0m\n' +
  "  2. Yes, and don't ask again this session\n" +
  '  3. No, and tell Claude what to do differently\n';
check('permission prompt parses 3 opts', parseSelector(perm), {
  prompt: 'Do you want to proceed?',
  options: [
    { num: 1, label: 'Yes' },
    { num: 2, label: "Yes, and don't ask again this session" },
    { num: 3, label: 'No, and tell Claude what to do differently' },
  ],
  selectedIndex: 0,
});

// 2. Cursor on option 2 -> selectedIndex 1.
const sel2 = 'Pick one\n  1. Alpha\n❯ 2. Beta\n  3. Gamma\n';
check('cursor on 2', parseSelector(sel2)?.selectedIndex, 1);

// 3. No selector present -> null.
check('plain text -> null', parseSelector('just some\noutput here\nno options\n'), null);

// 4. Single option is not a selector.
check('single option -> null', parseSelector('Q\n❯ 1. Only\n'), null);

// 5. Trailing blank line after the block is tolerated.
const withTrailer = 'Choose a plan\n❯ 1. MVP first\n  2. Risk first\n\n';
check('trailing blank tolerated', parseSelector(withTrailer)?.options?.length, 2);

// 6. `)` numbering + `>` cursor.
const paren = 'Which?\n> 1) Keep\n  2) Discard\n';
check('paren style + > cursor', parseSelector(paren), {
  prompt: 'Which?',
  options: [{ num: 1, label: 'Keep' }, { num: 2, label: 'Discard' }],
  selectedIndex: 0,
});

// 7. The LAST block wins (ignore an earlier stray numbered line).
const twoBlocks =
  '1. old list item that is prose\n' +
  'some unrelated line\n' +
  'Real question?\n' +
  '❯ 1. First\n' +
  '  2. Second\n';
check('last block wins', parseSelector(twoBlocks)?.prompt, 'Real question?');

// 8. stripAnsi removes CSI + OSC without eating text.
check('stripAnsi keeps text', stripAnsi('\x1b[31mred\x1b[0m \x1b]0;title\x07plain'), 'red plain');

// 9. Non-string input -> null (defensive).
check('null input -> null', parseSelector(null), null);

// 10. No cursor marker at all -> NOT a real selector (prose list) -> null.
check('no cursor -> null', parseSelector('Q\n  1. A\n  2. B\n'), null);

// 11. A short footer hint after the block is tolerated (still a live selector).
const withFooter =
  'Proceed?\n❯ 1. Yes\n  2. No\n\n  Use up/down to select, enter to confirm\n';
check('footer hint tolerated', parseSelector(withFooter)?.options?.length, 2);

// 12. STALE selector: even a SHORT response after the block -> null (Codex).
const staleShort =
  'Proceed?\n❯ 1. Yes\n  2. No\nGreat, proceeding now.\n> \n';
check('stale w/ short response -> null', parseSelector(staleShort), null);

// 13. STALE selector: long response after the block -> null.
const staleLong =
  'Proceed?\n❯ 1. Yes\n  2. No\n' +
  'Great, proceeding now.\nReading files.\nRan the build.\nRunning tests.\n';
check('stale w/ long response -> null', parseSelector(staleLong), null);

// 14. PROSE numbered list in Claude's output (no cursor, then a caret) -> null (Codex).
const prose =
  'Claude says:\nHere are the options:\n  1. Refactor parser\n  2. Add tests\n> \n';
check('prose numbered list -> null', parseSelector(prose), null);

// 15. Real live selector with a trailing bare caret only -> still parses.
check('trailing caret tolerated', parseSelector('Proceed?\n❯ 1. Yes\n  2. No\n> \n')?.options?.length, 2);

// 16. Short non-hint response after the block ("OK") -> stale -> null (Codex).
check('short non-hint trailer -> null', parseSelector('Proceed?\n❯ 1. Yes\n  2. No\nOK\n'), null);

// 17. Long line containing a hint word is response prose, not chrome -> null.
const longHint =
  'Proceed?\n❯ 1. Yes\n  2. No\nLet me select the right approach and refactor everything now.\n';
check('long hint-word line -> null', parseSelector(longHint), null);

// 18. AskUserQuestion shape: description lines INDENTED under each option
// (including the last one). The old contiguous scan broke on these, so
// question popups never parsed on mobile (v1.0.51 bug 1).
const askUser =
  'Which polish items should I do?\n' +
  '❯ 1. Config diet + housekeeping\n' +
  '     The 11MB config.json shrink with migration.\n' +
  '  2. Release autopilot script\n' +
  '     One-command release.sh wrapping build and sign.\n' +
  '  3. Keep local for now\n' +
  '     Stays committed on the feature branch.\n';
check('AskUserQuestion w/ descriptions parses', parseSelector(askUser), {
  prompt: 'Which polish items should I do?',
  options: [
    { num: 1, label: 'Config diet + housekeeping' },
    { num: 2, label: 'Release autopilot script' },
    { num: 3, label: 'Keep local for now' },
  ],
  selectedIndex: 0,
});

// 19. Descriptions + nav hint chrome after the last option -> still parses.
const askUserHint = askUser + '  ↑/↓ to select · enter to confirm\n';
check('descriptions + hint chrome parses', parseSelector(askUserHint)?.options?.length, 3);

// 20. ANSWERED AskUserQuestion: flush-left response prose after the block -> null.
const askUserStale = askUser + 'Great choice, starting with the config diet.\n';
check('answered AskUserQuestion -> null', parseSelector(askUserStale), null);

// 21. Flush-left prose BETWEEN two numbered fragments does NOT glue them into
// one selector (indent rule): the lower fragment alone lacks a cursor -> null.
const glued =
  'Steps:\n  1. First do this\nThen a whole paragraph of explanation text.\n  2. Second thing\n> \n';
check('flush-left prose does not glue blocks', parseSelector(glued), null);

// 22. Deep-indented continuation cap: >4 description lines between options ends
// the block, leaving a single option below -> null (bounded, not greedy).
const tooManyCont =
  'Q?\n  1. Alpha\n     d1\n     d2\n     d3\n     d4\n     d5\n❯ 2. Beta\n';
check('continuation cap bounds the block', parseSelector(tooManyCont), null);

// 23. STALE plain selector answered from desktop, followed only by INDENTED
// response lines (code): must be null. Codex found the first continuation rule
// treated these as a trailing description; the sawInBlockDesc gate fixes it.
const staleIndented =
  'Proceed?\n❯ 1. Yes\n  2. No\n    const ok = true;\n    return ok;\n> \n';
check('stale selector + indented code -> null', parseSelector(staleIndented), null);

// 24. Indented lines AFTER hint chrome are response text, not description,
// even for an AskUserQuestion-style block (desc phase ends at chrome).
const descThenChromeThenCode =
  'Q?\n❯ 1. A\n     desc a\n  2. B\n     desc b\n  ↑/↓ select\n     indented response\n';
check('indented after chrome -> null', parseSelector(descThenChromeThenCode), null);

// 25. REAL AskUserQuestion frame shape from Claude Code 2.1.224 (captured live
// 2026-08-07, Sam: "make sure the interactive stuff works well on mobile").
// Three things broke it before: rows separated by bare \r (not \n), spacing
// drawn with cursor-forward (CSI n C) so stripping glued "2." to "Blue", a
// horizontal-rule divider inside the block before "Chat about this", and the
// 50-char footer exceeding the old 40-char chrome cap.
const rule25 = '─'.repeat(80);
const realAskQ = [
  rule25, ' ☐ Color ', 'Pick a color', '', '❯ 1. Red', '\x1b[3CThe color red',
].join('\r') + '\n' + [
  '2.\x1b[1CBlue', '\x1b[3CThe color blue', '3.\x1b[1CGreen', '\x1b[3CThe color green',
  '4.\x1b[1CType something.', rule25, '5.\x1b[1CChat about this', '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');
check('real 2.1.x AskUserQuestion frame parses', parseSelector(realAskQ), {
  prompt: 'Pick a color',
  options: [
    { num: 1, label: 'Red' }, { num: 2, label: 'Blue' }, { num: 3, label: 'Green' },
    { num: 4, label: 'Type something.' }, { num: 5, label: 'Chat about this' },
  ],
  selectedIndex: 0,
});

// 26. The GOLD fixture: verbatim raw PTY bytes of a Claude Code 2.1.224
// AskUserQuestion frame (captured over the mobile WS attach on 2026-08-07).
// SGR colors mid-line, \r\r\n row endings, CHA column layout, CUD row moves.
// If Ink's renderer changes shape again, THIS is the case that should break.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const fixDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const rawFrame = fs.readFileSync(path.join(fixDir, 'askq-2.1.224-raw.txt'), 'utf8');
check('raw captured 2.1.224 frame parses', parseSelector(rawFrame), {
  prompt: 'Pick a color',
  options: [
    { num: 1, label: 'Red' }, { num: 2, label: 'Blue' }, { num: 3, label: 'Green' },
    { num: 4, label: 'Type something.' }, { num: 5, label: 'Chat about this' },
  ],
  selectedIndex: 0,
});

// 27. INTENTIONAL residual (Codex adjudicated "Accept the residual"): a rule
// row after the footer stays LIVE, because a live boxed prompt's bottom
// border after its hints is the same shape. This locks the decision so a
// future "fix" of the stale case knows it trades away boxed prompts.
const ruleAfterFooter =
  'Q?\n❯ 1. A\n     desc a\n  2. B\n     desc b\n'
  + 'Enter to select · ↑/↓ to navigate · Esc to cancel\n'
  + '────────────────\n';
check('rule after footer stays live (accepted residual)',
  parseSelector(ruleAfterFooter),
  { prompt: 'Q?', options: [{ num: 1, label: 'A' }, { num: 2, label: 'B' }], selectedIndex: 0 });

// --- spinnerVerb (v1.0.61, Sam-requested) -----------------------------------
// The whimsical working word for the phone board. Anchored on the spinner
// GLYPH opening the line, not on "esc to interrupt": a real captured 2.1.227
// frame puts that hint on a separate footer row, which is exactly the kind of
// assumption only a live capture settles.
import { spinnerVerb } from '../selector-parser.js';
const sv = (name, raw, want) => {
  const got = spinnerVerb(raw);
  if (got === want) { console.log(`PASS  ${name}`); pass += 1; }
  else { console.log(`FAIL  ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); fail += 1; }
};

// REAL lines captured live from Claude Code 2.1.227 on this machine.
sv('real frame: verb with stats', '\u2733 Proofing\u2026 (3s \u00b7 \u2193 95 tokens)', 'Proofing');
sv('real frame: bare verb line', '\u00b7 Burrowing\u2026', 'Burrowing');
sv('real frame: full footer context',
  'haiku text above\n\u2733 Proofing\u2026 (3s \u00b7 \u2193 95 tokens)\n  \u23f5\u23f5 auto mode on (shift+tab to cycle) \u00b7 esc to interrupt \u00b7 \u2190 for agents\n',
  'Proofing');
// Older CLI shape (verb + esc-to-interrupt inline) still matches on the glyph.
sv('older inline shape', '\u273b Flibbertigibbeting\u2026 (esc to interrupt)', 'Flibbertigibbeting');
sv('accented + hyphenated words', '\u273b Fiddle-faddling\u2026 (esc to interrupt)', 'Fiddle-faddling');
sv('flambeing', '* Flamb\u00e9ing... (2s)', 'Flamb\u00e9ing');
// The buffer is rolling scrollback: the LAST spinner wins, not the first.
sv('last spinner wins', '\u2733 Noodling\u2026\nassistant text\n\u00b7 Cogitating\u2026 (5s)\n', 'Cogitating');
// Prose ending in "ing\u2026" with no glyph is NOT a spinner, even mid-line.
sv('prose is not a spinner', 'I kept processing\u2026 and then stopped. Working\u2026 hard.', '');
// A glyph line whose status is not a gerund yields nothing, not a wrong word.
sv('non-gerund status yields nothing', '\u2733 Compacting conversation\u2026 (3s)', '');
// ANSI chrome: colors around glyph and verb still parse after the strip.
sv('ansi-wrapped spinner', '\u001b[38;5;174m\u2733\u001b[39m \u001b[1mGallivanting\u001b[22m\u2026 \u001b[2m(4s)\u001b[22m', 'Gallivanting');
sv('empty and junk are safe', '', '');

// spinnerStatus: the same line, read as a live meter for the chat views.
import { spinnerStatus } from '../selector-parser.js';
const ss = (name, raw, want) => {
  const got = JSON.stringify(spinnerStatus(raw));
  if (got === JSON.stringify(want)) { console.log(`PASS  ${name}`); pass += 1; }
  else { console.log(`FAIL  ${name}: got ${got} want ${JSON.stringify(want)}`); fail += 1; }
};
ss('meter: real frame', 'haiku text above\n\u2733 Proofing\u2026 (3s \u00b7 \u2193 95 tokens)\n  esc to interrupt\n', { verb: 'Proofing', seconds: 3, tokens: 95, dir: 'down' });
ss('meter: minutes and k tokens', '\u273b Whirlpooling\u2026 (1m 12s \u00b7 \u2191 2.3k tokens \u00b7 thinking)', { verb: 'Whirlpooling', seconds: 72, tokens: 2300, dir: 'up' });
ss('meter: hours, no tokens', '\u2736 Discombobulating\u2026 (1h 2m 3s \u00b7 esc to interrupt)', { verb: 'Discombobulating', seconds: 3723, tokens: null, dir: null });
ss('meter: comma tokens', '\u2722 Herding\u2026 (12s \u00b7 \u2193 1,204 tokens)', { verb: 'Herding', seconds: 12, tokens: 1204, dir: 'down' });
ss('meter: bare verb', '\u00b7 Burrowing\u2026', { verb: 'Burrowing', seconds: null, tokens: null, dir: null });
ss('meter: hint only is not a time', '\u273b Flibbertigibbeting\u2026 (esc to interrupt)', { verb: 'Flibbertigibbeting', seconds: null, tokens: null, dir: null });
// The parenthetical must be on the SAME line: the next row's "(shift+tab ...)" is not it.
ss('meter: next-line parens ignored', '\u2733 Noodling\u2026\n(4s \u00b7 \u2193 9 tokens)', { verb: 'Noodling', seconds: null, tokens: null, dir: null });
ss('meter: no spinner', 'I kept processing\u2026 (3s)', null);

// --- parseSelectorFromScreen on REAL captured multi-question frames ---------
// Fixtures captured live from Claude Code 2.1.233 over the mobile attach
// stream (fix/mobile-chat-bugs): a two-question AskUserQuestion call. The old
// strip path parsed Q1 but returned null on Q2 (incremental repaint) and on
// the submit screen; the emulator + screen parser must get all three.
import { parseSelectorFromScreen } from '../selector-parser.js';
import { renderScreenLines } from '../screen-render.js';
const screenSel = async (name) => {
  const raw = new Uint8Array(fs.readFileSync(path.join(fixDir, name)));
  const lines = await renderScreenLines(raw);
  if (!lines) return 'RENDER_FAILED';
  return parseSelectorFromScreen(lines);
};
const sv2 = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log(`PASS  ${name}`); pass += 1; }
  else { console.log(`FAIL  ${name}:\n  got  ${g}\n  want ${w}`); fail += 1; }
};

sv2('screen: multi-question Q1', await screenSel('askq-multi-q1-2.1.233-raw.bin'), {
  prompt: 'Pick a color',
  options: [{ num: 1, label: 'Red', detail: 'The color red.' }, { num: 2, label: 'Blue', detail: 'The color blue.' }, { num: 3, label: 'Type something.' }, { num: 4, label: 'Chat about this' }],
  selectedIndex: 0,
  steps: { labels: ['Color', 'Size'], answered: [false, false], current: 0, total: 2 },
});
sv2('screen: multi-question Q2 (the bug)', await screenSel('askq-multi-q2-2.1.233-raw.bin'), {
  prompt: 'Pick a size',
  options: [{ num: 1, label: 'Small', detail: 'The small size.' }, { num: 2, label: 'Large', detail: 'The large size.' }, { num: 3, label: 'Type something.' }, { num: 4, label: 'Chat about this' }],
  selectedIndex: 0,
  steps: { labels: ['Color', 'Size'], answered: [true, false], current: 1, total: 2 },
});
sv2('screen: submit step is a popup too', await screenSel('askq-multi-submit-2.1.233-raw.bin'), {
  // The whole review, not just its last row (Sam: prompts "get cutoff").
  prompt: 'Review your answers\n● Pick a color\n→ Red\n● Pick a size\n→ Small\nReady to submit your answers?',
  options: [{ num: 1, label: 'Submit answers' }, { num: 2, label: 'Cancel' }],
  selectedIndex: 0,
  steps: { labels: ['Color', 'Size'], answered: [true, true], current: 2, total: 2 },
});
// Steps: the SHOWING question is the tab drawn with a background colour, not
// merely the first unanswered one (the user went back to an answered one).
{
  const E = '\x1b';
  const raw = `${E}[2J${E}[H←  ${E}[48;2;177;185;249m${E}[38;2;0;0;0m ☒ Color ${E}[39m${E}[49m  ☐ Size  ✔ Submit  →\r\nPick a color\r\n❯ 1. Red\r\n  2. Blue\r\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel\r\n`;
  const lines = await renderScreenLines(new TextEncoder().encode(raw));
  sv2('screen: steps follow the highlighted tab back to an answered question', parseSelectorFromScreen(lines)?.steps,
    { labels: ['Color', 'Size'], answered: [true, false], current: 0, total: 2 });
  // A long question Claude wrapped over several rows reads as one paragraph.
  const wrapped = parseSelectorFromScreen([
    '─'.repeat(80),
    '←  ☐ Rate  ☐ Payout  ✔ Submit  →',
    'What should Trybe pay creators? Trybe needs a commission program before we',
    'can invite anyone, and the rate is visible to every creator.',
    '❯ 1. 20% of sales (Recommended)',
    "     Trybe's recommended type. Below our 25% affiliate rate, since Trybe also",
    '     takes its cut and runs the ads.',
    '  2. 25% of sales',
    'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
  ]);
  sv2('screen: a wrapped option description re-flows too', wrapped?.options?.[0]?.detail,
    "Trybe's recommended type. Below our 25% affiliate rate, since Trybe also takes its cut and runs the ads.");
  sv2('screen: a wrapped question re-flows into one paragraph', wrapped?.prompt,
    'What should Trybe pay creators? Trybe needs a commission program before we can invite anyone, and the rate is visible to every creator.');
  // A checklist in the transcript above a permission prompt's border is not a
  // tab bar: no steps, so no arrow keys reach a Bash prompt.
  const perm = parseSelectorFromScreen([
    'Todo: ☐ Cleanup ☐ Verify',
    '─'.repeat(80),
    ' Bash command',
    '   rm -rf build',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    ' Esc to cancel',
  ]);
  sv2('screen: a checklist above a permission prompt is not a tab bar', perm?.steps, undefined);
  // Repeated tab labels, and a question named Submit: matched by POSITION.
  const at = async (bar, hlText) => {
    const pre = bar.slice(0, bar.indexOf(hlText));
    const raw = `${E}[2J${E}[H${pre}${E}[48;2;177;185;249m${hlText}${E}[49m${bar.slice(pre.length + hlText.length)}\r\nPick\r\n❯ 1. A\r\n  2. B\r\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel\r\n`;
    return parseSelectorFromScreen(await renderScreenLines(new TextEncoder().encode(raw)))?.steps?.current;
  };
  sv2('screen: the second of two same-named tabs is question 2', await at('←  ☒ Scope  ☐ Scope   ✔ Submit  →', '☐ Scope'), 1);
  sv2('screen: a question named Submit is not the review step', await at('←  ☒ Color  ☐ Submit   ✔ Submit  →', '☐ Submit'), 1);
  sv2('screen: the real Submit tab is the review step', await at('←  ☒ Color  ☒ Size   ✔ Submit  →', '✔ Submit'), 2);
  // A path Claude wrapped mid-token is re-joined without a space.
  const pathy = parseSelectorFromScreen([
    '─'.repeat(80),
    '←  ☐ Target  ✔ Submit  →',
    'Which config should change?',
    '❯ 1. Project config',
    '     Edits /Users/sam/Projects/dobius-',
    '     plus/config.json and nothing else.',
    '  2. Global config',
    'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
  ]);
  sv2('screen: a path wrapped mid-token keeps the terminal break, not a guess', pathy?.options?.[0]?.detail, 'Edits /Users/sam/Projects/dobius-\nplus/config.json and nothing else.');
  const wrapAt = (detail) => parseSelectorFromScreen(['─'.repeat(80), '←  ☐ Target  ✔ Submit  →', 'Which file?', '❯ 1. That one', ...detail.map((d) => '     ' + d), '  2. Neither', 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel'])?.options?.[0]?.detail;
  sv2('screen: a path broken after a letter keeps the break', wrapAt(['Writes /srv/production/confi', 'g.json today.']), 'Writes /srv/production/confi\ng.json today.');
  const longName = 'a'.repeat(60);
  sv2('screen: a token that filled the row keeps the break', wrapAt(['Writes /tmp/' + longName.slice(0, 20), longName, 'aaa.json now.']), `Writes /tmp/${longName.slice(0, 20)}\n${longName}\naaa.json now.`);
  sv2('screen: a path with a space broken before its slash keeps the break', wrapAt(['Edits /Users/sam/Library/Application Supp', 'ort/config.json now.']), 'Edits /Users/sam/Library/Application Supp\nort/config.json now.');
  sv2('screen: a file name broken mid-word keeps the break', wrapAt(['Edits /Users/sam/Desktop/Quarterly Rep', 'ort.pdf today.']), 'Edits /Users/sam/Desktop/Quarterly Rep\nort.pdf today.');
  sv2('screen: a slashless file name broken mid-word keeps the break', wrapAt(['Renames the Quarterly Rep', 'ort.pdf today.']), 'Renames the Quarterly Rep\nort.pdf today.');
  sv2('screen: an extension broken mid-word keeps the break', wrapAt(['Renames Quarterly Report.p', 'df today.']), 'Renames Quarterly Report.p\ndf today.');
  sv2('screen: a name broken right after its dot keeps the break', wrapAt(['Renames Quarterly Report.', 'pdf today.']), 'Renames Quarterly Report.\npdf today.');
  sv2('screen: an uppercase extension after the dot keeps the break', wrapAt(['Renames Quarterly Report.', 'PDF today.']), 'Renames Quarterly Report.\nPDF today.');
  sv2('screen: a long uppercase extension after the dot keeps the break', wrapAt(['Renames backup.', 'SQLITE3 today.']), 'Renames backup.\nSQLITE3 today.');
  sv2('screen: a sentence ending a row still re-flows', wrapAt(['Writes the file.', 'Then it stops.']), 'Writes the file. Then it stops.');
  sv2('screen: ordinary prose still re-flows with a space', wrapAt(['Writes the main config file', 'and nothing else.']), 'Writes the main config file and nothing else.');
  // A crafted row cannot freeze the parser (it backtracked exponentially once).
  { const t0 = Date.now(); parseSelectorFromScreen(['─'.repeat(80), '☐ A '.repeat(2000) + '←', 'Q', '❯ 1. x', '  2. y', 'Enter to select · Esc to cancel']); sv2('screen: a hostile tab-like row parses quickly', Date.now() - t0 < 200, true); }
  // Prose with a checkbox under the real bar does not hide the bar.
  const proseBox = parseSelectorFromScreen(['─'.repeat(80), '←  ☒ A  ☐ B  ✔ Submit  →', 'Should ☐ mean disabled?', '❯ 1. Yes', '  2. No', 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel']);
  sv2('screen: a checkbox in the question does not hide the tabs', proseBox?.steps?.total, 2);
  // ...nor does a question line that STARTS with a checkbox (Codex P2).
  const leadBox = parseSelectorFromScreen(['─'.repeat(80), '←  ☒ Scope  ☐ Deploy  ✔ Submit  →', '☐ means disabled. Should deployment stay disabled?', '❯ 1. Yes', '  2. No', 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel']);
  sv2('screen: a checkbox-led question line does not replace the tabs', leadBox?.steps?.total, 2);
  const quoteBox = parseSelectorFromScreen(['─'.repeat(80), '←  ☒ Scope  ☐ Deploy  ✔ Submit  →', 'Should the bar read like this?', '←  ☐ Preview  ✔ Submit  →', '❯ 1. Yes', '  2. No', 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel']);
  sv2('screen: a quoted bar below the real one does not replace it', quoteBox?.steps?.labels, ['Scope', 'Deploy']);
  const single = parseSelectorFromScreen(['─'.repeat(80), ' ☐ Layout ', 'Should the bar read like this?', '←  ☐ A  ☐ B  ✔ Submit  →', '❯ 1. Yes', '  2. No', 'Enter to select · Esc to cancel']);
  sv2('screen: a quoted multi-question bar does not override a single question', single?.steps?.total, 1);
  const heredoc = parseSelectorFromScreen(['─'.repeat(80), ' Bash command', "   cat <<'EOF' > notes.md", '←  ☐ A  ☐ B  ✔ Submit  →', '   EOF', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel']);
  sv2('screen: a bar inside a permission prompt\'s heredoc is not a tab bar', heredoc?.steps, undefined);
  const checked = parseSelectorFromScreen(['─'.repeat(80), '←  ☐ ✔ Check  ☐ Deploy  ✔ Submit  →', 'Run the check?', '❯ 1. Yes', '  2. No', 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel']);
  const boxHeader = parseSelectorFromScreen(['─'.repeat(80), ' ☐ Use ☐ box ', 'Which box?', '❯ 1. This', '  2. That', 'Enter to select · ↑/↓ to navigate · Esc to cancel']);
  sv2('screen: a checkbox inside a single question\'s header is one question', boxHeader?.steps, { labels: ['Use ☐ box'], answered: [false], current: 0, total: 1 });
  const ruled = parseSelectorFromScreen(['─'.repeat(80), ' Bash command', "   cat <<'EOF' > notes.md", '   ──────────', '   ←  ☐ A  ☐ B  ✔ Submit  →', '   EOF', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel']);
  sv2('screen: a rule and bar inside a heredoc give a permission prompt no steps', ruled?.steps, undefined);
  const quotedRule = parseSelectorFromScreen(['─'.repeat(80), ' ☐ Layout ', 'Should it look like this?', '──────', '←  ☐ A  ☐ B  ✔ Submit  →', '❯ 1. Yes', '  2. No', 'Enter to select · ↑/↓ to navigate · Esc to cancel']);
  sv2('screen: a short rule and bar quoted in a question do not replace its tab', quotedRule?.steps, { labels: ['Layout'], answered: [false], current: 0, total: 1 });
  const multiBox = parseSelectorFromScreen(['─'.repeat(80), '←  ☐ Use ☐ box  ☐ Deploy  ✔ Submit  →', 'Which box?', '❯ 1. This', '  2. That', 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel']);
  const marks = parseSelectorFromScreen(['─'.repeat(80), '←  ☐ Café  ☐ Size  ✔ Submit  →', 'Pick one for the cafe' + 'e\u0301'.repeat(30), '❯ 1. This', '  2. That', 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel']);
  sv2('screen: combining marks do not make a row look wider than the frame', marks?.steps?.total, 2);
  const shortRule = parseSelectorFromScreen(['─'.repeat(80), ' ☐ Layout ', 'Like this?', '─'.repeat(30), '←  ☐ A  ☐ B  ✔ Submit  →', '❯ 1. Yes', '  2. No', 'Enter to select · ↑/↓ to navigate · Esc to cancel']);
  sv2('screen: a rule narrower than the footer does not bound the frame', shortRule?.steps?.total, 1);
  const spaced = parseSelectorFromScreen(['─'.repeat(80), '←  ☐ Deploy  prod  ☐ Deploy  test  ✔ Submit  →', 'Deploy now?', '❯ 1. Yes', '  2. No', 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel']);
  sv2('screen: a header with a double space keeps all of its text', spaced?.steps?.labels, ['Deploy  prod', 'Deploy  test']);
  sv2('screen: a checkbox inside a multi-question header stays in that header', multiBox?.steps?.labels, ['Use ☐ box', 'Deploy']);
  sv2('screen: a checkmark inside a header is part of that header', checked?.steps, { labels: ['✔ Check', 'Deploy'], answered: [false, false], current: 0, total: 2 });
  // Plain lines (no highlight information): the first unanswered one.
  sv2('screen: without highlights, steps fall back to the first unanswered', parseSelectorFromScreen([...lines])?.steps,
    { labels: ['Color', 'Size'], answered: [true, false], current: 1, total: 2 });
}
// A permission prompt: the tool and its command sit above the question, and a
// long option wraps onto an indented row. All of it must reach the card.
sv2('screen: permission prompt keeps the command and wrapped option', parseSelectorFromScreen([
  'previous transcript text that must not leak in',
  '─'.repeat(80),
  ' Bash command',
  '',
  '   git push origin main',
  '   Push the branch',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and don\'t ask again for git push commands in',
  '      /Users/sam/Projects (Code)/dobius-plus',
  '   3. No, and tell Claude what to do differently (esc)',
  '',
  ' Esc to cancel',
]), {
  prompt: 'Bash command\ngit push origin main\nPush the branch\nDo you want to proceed?',
  options: [
    { num: 1, label: 'Yes' },
    { num: 2, label: "Yes, and don't ask again for git push commands in", detail: '/Users/sam/Projects (Code)/dobius-plus' },
    { num: 3, label: 'No, and tell Claude what to do differently (esc)' },
  ],
  selectedIndex: 0,
});
// No rule or tab bar above: only the paragraph touching the block, so the
// transcript above it is never swept into the question.
sv2('screen: unbounded prompt stops at the paragraph', parseSelectorFromScreen([
  'Some earlier reply from Claude.',
  '',
  'Pick one',
  ' ❯ 1. A',
  '   2. B',
  'Enter to select',
]), { prompt: 'Pick one', options: [{ num: 1, label: 'A' }, { num: 2, label: 'B' }], selectedIndex: 0 });
// Erase honored: a screen with NO hint footer (nothing live) yields null,
// whatever numbered prose is lying around.
sv2('screen: no hint footer means no popup',
  parseSelectorFromScreen(['notes', '1. first thing', '2. second thing', 'done']), null);
// Codex High: Claude QUOTING a selector at the end of a message (cursor glyph
// and all) must never become tappable fake options. Only the multi-question
// tab bar legitimizes a footerless cursor block.
sv2('screen: quoted selector prose is not a popup',
  parseSelectorFromScreen(['quoted shell output:', '\u276f 1. foo', '  2. bar']), null);
// Codex High #2: a numbered list in Claude's ANSWER followed by prose that
// trips the hint regex ("Press Enter to confirm when ready") has no cursor
// row, so it is not a selector.
sv2('screen: numbered prose + hint-like sentence is not a popup',
  parseSelectorFromScreen(['Claude says:', '1. Run tests', '2. Deploy', 'Press Enter to confirm when ready']), null);
sv2('screen: null input safe', parseSelectorFromScreen(null), null);

// The chat:key guard: two Bash prompts with identical wording and options must
// not share a fingerprint (one click would approve the command never shown),
// and moving the cursor must not change it. context stays out of JSON.
{
  const { selectorFingerprint } = await import('../selector-parser.js');
  const bash = (cmd, cur) => parseSelectorFromScreen([
    '─'.repeat(80), ' Bash command', '', `   ${cmd}`, '', ' Do you want to proceed?',
    `${cur === 1 ? ' ❯' : '  '} 1. Yes`, `${cur === 2 ? ' ❯' : '  '} 2. No`, '', ' Esc to cancel',
  ]);
  const a = bash('rm -rf build', 1), b = bash('rm -rf ~/src', 1), a2 = bash('rm -rf build', 2);
  sv2('fingerprint: different commands differ', selectorFingerprint(a) === selectorFingerprint(b), false);
  sv2('fingerprint: cursor move keeps it', selectorFingerprint(a) === selectorFingerprint(a2), true);
  sv2('fingerprint: context not serialized', 'context' in JSON.parse(JSON.stringify(a)), false);
  // Same prompt text and options, differing only ABOVE a rule (e.g. two edits
  // to one file whose diffs sit outside the prompt paragraph).
  const edit = (line) => parseSelectorFromScreen([
    `+ ${line}`, '─'.repeat(80), ' Do you want to make this edit to main.js?',
    ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel',
  ]);
  sv2('fingerprint: diff above the rule counts', selectorFingerprint(edit('a = 1')) === selectorFingerprint(edit('a = 2')), false);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
