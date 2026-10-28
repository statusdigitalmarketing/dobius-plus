// Error and crash reports filed as GitHub issues (v1.0.84): pure helpers,
// then one end-to-end flush against a FAKE gh that records every call, so no
// test can ever file a real issue.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-reporter-'));
const crashDir = path.join(tmp, 'crashes');
const userData = path.join(tmp, 'ud');
fs.mkdirSync(crashDir, { recursive: true });
fs.mkdirSync(path.join(userData, 'logs'), { recursive: true });

// The fake gh: logs argv (one JSON line per call) and answers like gh would.
const ghLog = path.join(tmp, 'gh-calls.jsonl');
const ghBin = path.join(tmp, 'gh');
fs.writeFileSync(ghBin, `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify(a) + '\\n');
const repo = process.env.DOBIUS_REPORTS_REPO;
if (a[0] === 'api') { console.log(process.env.FAKE_GH_NO_ACCESS ? '' : repo); process.exit(process.env.FAKE_GH_NO_ACCESS ? 1 : 0); }
if (process.env.FAKE_GH_FAIL && a[0] === 'issue') process.exit(1);
const sigIn = (t) => (String(t).match(/dobius-report: ([0-9a-f]{12})/) || [])[1];
if (a[0] === 'issue' && a[1] === 'list') {
  const lost = ${JSON.stringify(tmp)} + '/lost-' + sigIn(a[a.indexOf('--search') + 1]);
  console.log(fs.existsSync(lost) ? fs.readFileSync(lost, 'utf8') : ''); process.exit(0);
}
if (a[0] === 'issue' && a[1] === 'create' && process.env.FAKE_GH_LOSE_REPLY && a[a.indexOf('--body') + 1].includes(process.env.FAKE_GH_LOSE_REPLY)) {
  fs.writeFileSync(${JSON.stringify(tmp)} + '/lost-' + sigIn(a[a.indexOf('--body') + 1]), '555');
  fs.writeFileSync(${JSON.stringify(tmp)} + '/lost-body-555', a[a.indexOf('--body') + 1]); process.exit(1);
}
if (a[0] === 'issue' && a[1] === 'create') {
  const n = fs.readFileSync(${JSON.stringify(ghLog)}, 'utf8').split('\\n').filter((l) => l.includes('"create"')).length;
  console.log('https://github.com/' + repo + '/issues/' + (100 + n)); process.exit(0);
}
if (a[0] === 'issue' && a[1] === 'view' && a.includes('body') && process.env.FAKE_GH_BODY_FAIL) process.exit(1);
if (a[0] === 'issue' && a[1] === 'view' && a.includes('body')) {
  const lost = ${JSON.stringify(tmp)} + '/lost-body-' + a[2];
  console.log(fs.existsSync(lost) ? fs.readFileSync(lost, 'utf8') : ''); process.exit(0);
}
if (a[0] === 'issue' && a[1] === 'view' && process.env.FAKE_GH_GONE === a[2]) { console.error('GraphQL: Could not resolve to an issue or pull request with the number of ' + a[2] + '.'); process.exit(1); }
if (a[0] === 'issue' && a[1] === 'view') { console.log('CLOSED'); process.exit(0); }
if (a[0] === 'issue' && a[1] === 'comment') { process.exit(0); }
process.exit(2);
`);
fs.chmodSync(ghBin, 0o755);

process.env.DOBIUS_REPORTS_FORCE = '1';
process.env.DOBIUS_REPORTS_REPO = 'test-owner/test-reports';
process.env.DOBIUS_GH_BIN = ghBin;
process.env.DOBIUS_CRASH_DIR = crashDir;

const R = await import('../error-reporter.js');

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got=${JSON.stringify(got)}\n        want=${JSON.stringify(want)}`);
};

// ---- what is reported
check('uncaught exception is reported', R.isReportable('crash.uncaughtException', 'TypeError: x'), true);
check('renderer error is reported', R.isReportable('renderer.error', 'boom (app.js:1)'), true);
check('warnings are not', R.isReportable('main.warn', 'meh'), false);
check('the startup line is not', R.isReportable('app', 'started'), false);
check('crash.render-process-gone duplicates renderer.gone', R.isReportable('crash.render-process-gone', 'reason=crashed'), false);
check('a clean child exit is not a fault', R.isReportable('child.gone', 'type=Utility reason=clean-exit exitCode=0'), false);
check('a crashed child is', R.isReportable('child.gone', 'type=GPU reason=crashed exitCode=5'), true);

// ---- scrubbing
const s = R.scrub('ENOENT /Users/sam/Projects (Code)/Blue/x.js sam@acme.com token ghp_abcdefghij1234567890 ?token=zzz&a=1 Bearer abc.def', '/Users/sam');
check('home dir becomes ~', s.includes('/Users/sam'), false);
check('email removed', s.includes('acme.com'), false);
check('gh token removed', s.includes('ghp_'), false);
check('query token removed', s.includes('zzz'), false);
check('bearer removed', s.includes('abc.def'), false);
check('other users dirs scrubbed', R.scrub('/Users/bob/x', '/Users/sam'), '~/x');
check('paths on other volumes keep only the file name', R.scrub('[tasks] Failed to read /Volumes/Clients/Blue Atlas/tasks.json: EACCES', '/h'), '[tasks] Failed to read …/tasks.json: EACCES');
check('a single-quoted multi-word value is data', R.scrub("Error: rejected customer 'Client Orion'", '/h'), "Error: rejected customer '[12 chars]'");
check('a quoted value of any length is redacted', R.scrub('Error: "' + 'Client Orion '.repeat(170) + '"', '/h').includes('Orion'), false);
check('an unclosed quote hides everything after it', R.scrub('bad record "Client Orion was here\nnext line', '/h'), 'bad record "[…]');
check('an apostrophe in a word is not a quote', R.scrub("can't read 'id'", '/h'), "can't read 'id'");
check('URL credentials are removed', R.scrub('GET https://alice:correct-horse-battery-staple!@example.com/x failed', '/h'), 'GET https://[credentials]@example.com/x failed');
check('an escaped quote does not end a quoted value', R.scrub('Error: rejected "hello \\"Client Orion\\""', '/h').includes('Orion'), false);
check('a quoted value spanning lines is redacted whole', R.scrub('Error: rejected `first\nClient Orion\nlast` end', '/h').includes('Orion'), false);
check('an unclosed quote cut by the cap hides the rest', R.scrub("Error: rejected '" + 'Client Orion '.repeat(700) + "'", '/h').includes('Orion'), false);
check('a path inside a tab id keeps only its last part', R.scrub('resize failed for term-/Volumes/Clients/Client Orion/site-1', '/h'), 'resize failed for term-…/site-1');
check('a file:// URL path keeps only its file name', R.scrub('at run (file:///Volumes/Clients/Blue%20Atlas/app.js:10:3)', '/h'), 'at run (…/app.js:10:3)');
check('a token is removed before a path rewrite can strand its tail',
  R.scrub('read /tmp/input.json failed https://api.example.com/?token=abc/secretValue', '/h').includes('secretValue'), false);
check('URL credentials with an apostrophe are removed', R.scrub("https://alice:correct'horse!@example.com/", '/h'), 'https://[credentials]@example.com/');
check('an ordinary URL keeps its path', R.scrub('GET https://api.example.com/v1/items failed', '/h'), 'GET https://api.example.com/v1/items failed');
check('a token pattern cannot shift quote boundaries',
  R.scrub('Error: GET "https://x.test/?token=abc" for "Client Orion"', '/h').includes('Orion'), false);
check('an apostrophe in a folder name does not stop path reduction',
  R.scrub("read /Volumes/Clients/O'Brien/Client Orion/tasks.json", '/h'), 'read …/tasks.json');
check('a quoted path with a token loses the query, not just the folders',
  R.scrub('Error: request "/v1/items?token=abc/secretValue" failed', '/h').includes('secretValue'), false);
check('an apostrophe inside a single-quoted name does not end it',
  R.scrub("Error: rejected customer 'O'Brien Holdings'", '/h').includes('Brien'), false);
check('two source files with words in their names stay two faults',
  R.signatureFor('crash.uncaughtException', 'Error: boom\n    at x (file:///app/codex-account-env.js:10:1)') === R.signatureFor('crash.uncaughtException', 'Error: boom\n    at x (file:///app/codex-account-identity.js:20:1)'), false);
check('a home path cannot swallow a token key', R.scrub('Error: request "/Users/bob?token=abc/secretValue" failed', '/Users/alice').includes('secretValue'), false);
check('an accented name after an apostrophe stays inside its quote', R.scrub("Error: rejected customer 'L'Étoile Services'", '/h').includes('toile'), false);
check('V8 JSON errors quoting raw input with quotes stay redacted', R.scrub('SyntaxError: Unexpected token \'x\', "x"Client Orion"" is not valid JSON', '/h').includes('Orion'), false);
check('an internationalized email is removed', R.scrub('Error: account alice@bücher.de is disabled', '/h'), 'Error: account [email] is disabled');
check('a JSON object on one line is redacted as one value', R.scrub('bad {"a":"b"} here', '/h'), 'bad {"[5 chars]"} here');
check('V8 nested quotes followed by a space stay redacted', R.scrub('SyntaxError: Unexpected token \'x\', "x" Client Orion"" is not valid JSON', '/h').includes('Orion'), false);
check('a Slack webhook is removed', R.scrub('Error: POST https://hooks.slack.com/services/' + ['T01234567', 'B01234567', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('/') + ' failed', '/h').includes('AbCdEf'), false);
check('a home dir inside a longer name is not rewritten', R.scrub('/Users/samuel/x and /Users/sam/y.js', '/Users/sam').includes('samuel'), false);
check('the home dir as a path component is', R.scrub('open /Users/sam/y.js', '/Users/sam'), 'open ~/y.js');
check('a quoted path then a quoted name: the name does not survive', R.scrub('Error: open "/tmp/input.json" for "Client Orion"', '/h').includes('Orion'), false);
check('a quote whose close the cap cut off hides the rest', R.scrub('Error: field "name", rejected "' + 'Client Orion '.repeat(700) + '"', '/h').includes('Orion'), false);
check('an escaped quote never closes a value', R.scrub('Error: rejected "prefix \\"Client Orion\nsuffix"', '/h').includes('Orion'), false);
check('a named credential assignment is removed', R.scrub('Error: authentication failed (password=hunter2)', '/h'), 'Error: authentication failed (password=[redacted])');
check('"Unexpected token" is not a credential', R.scrub("SyntaxError: Unexpected token 'x'", '/h'), "SyntaxError: Unexpected token 'x'");
check('the watchdog arming line is not a fault', R.isReportable('main.stall-watchdog', 'armed: reporting main-thread stalls over 2000ms'), false);
check('a real stall is', R.isReportable('main.stall', 'event loop blocked ~2.8s'), true);
check('the title also honours the truncation guard', R.issueTitle('main.error', 'Error: field "name", rejected "' + 'Client Orion '.repeat(700) + '"').includes('Orion'), false);
check('a multi-line value after another quoted value is redacted', R.scrub('Error: field "name", rejected "Client Orion\nconfidential"', '/h').includes('Orion') || R.scrub('Error: field "name", rejected "Client Orion\nconfidential"', '/h').includes('confidential'), false);
check('everything between the first and last double quote goes', R.scrub('a "x" b\nc "y" d', '/h'), 'a "[9 chars]" d');
check('a single-quoted credential value is removed', R.scrub("Error: authentication failed (password='hunter2')", '/h').includes('hunter2'), false);
check('one failure across projects is one fault', R.signatureFor('main.error', '[terminal-manager] resize error for term-/x/alpha-1: ioctl failed'), R.signatureFor('main.error', '[terminal-manager] resize error for term-/x/beta-1: ioctl failed'));
check('a V8 message with an embedded quote across lines is redacted', /Acme|secret/.test(R.scrub('SyntaxError: Unexpected token \'x\', "x" Acme\nsecret" is not valid JSON', '/h')), false);
check('a truncated multi-line quote is redacted', /Orion|confidential/.test(R.scrub('Error: field "name", rejected "Client Orion\n' + 'confidential '.repeat(700) + '"', '/h')), false);
check('a quoted credential key is matched', R.scrub("Error: authentication failed {'password': 'hunter2'}", '/h').includes('hunter2'), false);
check('a cookie header is redacted whole', R.scrub('Error: request failed; Cookie: theme=dark; session=abc123', '/h').includes('abc123'), false);
check('session= is a credential', R.scrub('retry with session=abc123 failed', '/h').includes('abc123'), false);
check('a relative path keeps only its file name', R.scrub('Error: open ./Clients/Client Orion/tasks.json failed', '/h'), 'Error: open …/tasks.json failed');
check('terminal ids with spaces normalize together', R.signatureFor('main.error', '[terminal-manager] resize error for term-/x/Blue Atlas-1: ioctl failed'), R.signatureFor('main.error', '[terminal-manager] resize error for term-/x/Blue Orion-1: ioctl failed'));
check('even counts per line cannot hide data between lines', /Acme|secret/.test(R.scrub('SyntaxError: Unexpected token \'x\', "x" Acme\nsecret "" is not valid JSON', '/h')), false);
check('a backtick around a double quote cannot unpair the other', R.scrub('Error: field "name", rejected `"prefix" Client Orion`', '/h').includes('Orion'), false);
check('OAuth keys are credentials', /abc123/.test(R.scrub("Error: authentication failed {'access_token': 'abc123', 'refresh_token': 'abc123'}", '/h')), false);
check('a password starting with punctuation is removed', R.scrub('Error: login failed password=#Hunter2!', '/h').includes('Hunter2'), false);
check('a long terminal name normalizes like a short one', R.signatureFor('main.error', '[terminal-manager] resize error for term-/x/customer-portal-integration-tests-1: ioctl failed'), R.signatureFor('main.error', '[terminal-manager] resize error for term-/x/site-1: ioctl failed'));
check('an inner numbered segment does not stop terminal normalization', R.signatureFor('main.error', '[terminal-manager] resize error for term-/x/Phase-1 Atlas-1: ioctl failed'), R.signatureFor('main.error', '[terminal-manager] resize error for term-/x/Phase-1 Orion-1: ioctl failed'));
check('a trailing backslash inside raw input cannot unpair quotes', R.scrub('SyntaxError: Unexpected token \'x\', "x" Client Orion\\" is not valid JSON', '/h').includes('Orion'), false);
check('a bracket-prefixed password is removed', R.scrub('Error: login failed password=[Hunter2!]', '/h').includes('Hunter2'), false);
check('a JSON credential with a numeric value is removed', R.scrub('Error: authentication failed {"password":123456}', '/h').includes('123456'), false);
check('double quotes inside single quotes cannot expose the rest', R.scrub('Error: field "name", rejected \'"prefix" Client Orion\'', '/h').includes('Orion'), false);
check('HTTP 401 and 500 stay apart', R.signatureFor('main.error', 'Error: HTTP 401') === R.signatureFor('main.error', 'Error: HTTP 500'), false);
check('a single-quoted fs path keeps its file name', R.scrub("ENOENT: no such file or directory, open '/Users/sam/Clients/x/tasks.json'", '/Users/sam'), "ENOENT: no such file or directory, open '~/…/tasks.json'");
check('a cookie header cannot swallow a quote the quote pass needs', R.scrub('Error: rejected "x" Client Orion\nCookie: theme=dark"', '/h').includes('Orion'), false);
check('a password starting with a comma is removed', R.scrub('Error: login failed password=,Hunter2!', '/h').includes('Hunter2'), false);
check('closed and unclosed quoted values sign alike', R.signatureFor('main.error', 'Error: rejected "Client Orion"'), R.signatureFor('main.error', 'Error: rejected "Client "Orion"'));
check('a quoted cookie value does not expose the next cookie', R.scrub('Error: request failed; Cookie: theme="dark"; remember_me=AbCdEf123456', '/h').includes('AbCdEf'), false);
check('a single-quoted cookie value is removed', R.scrub("Error: request failed; Cookie: session='hunter2'", '/h').includes('hunter2'), false);
check('an apostrophe in a credential value cannot become a quote', R.scrub('Error: rejected "password=O\'Brien Client Orion', '/h').includes('Orion'), false);
check('kept and redacted quoted values sign alike', R.signatureFor('main.error', "Error: rejected customer 'Orion'"), R.signatureFor('main.error', "Error: rejected customer 'Client Orion'"));
check('quote parity does not change the stack part of a signature',
  R.signatureFor('crash.uncaughtException', 'Error: rejected "Client Orion"\n    at validate (/app/check.js:10:1)'),
  R.signatureFor('crash.uncaughtException', 'Error: rejected "Client "Orion"\n    at validate (/app/check.js:10:1)'));
check('a cookie header cannot shorten the quote span', /Orion/.test(R.scrub('Error: rejected "x" Client Orion Cookie: theme="dark"', '/h')), false);
check('an apostrophe beside an underscore in a credential value cannot become a quote', R.scrub('Error: rejected "password=O\'_Brien Client Orion', '/h').includes('Orion'), false);
check('a client folder with spaces in a frame does not split a fault',
  R.signatureFor('crash.uncaughtException', 'Error: boom\n    at run (/Users/sam/Client Orion/check.js:10:1)'),
  R.signatureFor('crash.uncaughtException', 'Error: boom\n    at run (/Users/sam/Client Atlas/check.js:10:1)'));
check('how many values were quoted does not split a fault',
  R.signatureFor('main.error', "Error: rejected customer 'Orion' for project 'Atlas'"),
  R.signatureFor('main.error', "Error: rejected customer 'Client Orion' for project 'Project Atlas'"));
check('a quote span cannot erase the Cookie header', R.scrub('Error: rejected "x"; Cookie: theme="dark"; remember_me=AbCdEf123456', '/h').includes('AbCdEf'), false);
check('a code word next to other quotes is not set aside', R.scrub("Error: rejected 'x' Client Orion''", '/h').includes('Orion'), false);
check('a home-like folder with a space is still a path', R.scrub('Error: open /Users/sam Archive/Client Orion/tasks.json', '/Users/sam').includes('Orion'), false);
check('mixed kept and redacted values sign alike',
  R.signatureFor('main.error', "Error: rejected customer 'Orion' for project 'Atlas'"),
  R.signatureFor('main.error', "Error: rejected customer 'Orion' for project 'Project Atlas'"));
check('quoted text starting with "at" is not taken for a frame',
  R.signatureFor('crash.uncaughtException', 'Error: rejected "row\nat Client Orion\nend"\n    at validate (/app/check.js:10:1)'),
  R.signatureFor('crash.uncaughtException', 'Error: rejected "row\nat Client Atlas\nend"\n    at validate (/app/check.js:10:1)'));
check('a home path cannot swallow a following credential key', R.scrub('Error: open /Users/sam: password=hunter2', '/Users/sam').includes('hunter2'), false);
check('EACCES and EMFILE after a home path stay apart', R.signatureFor('main.error', 'Error: open /Users/sam: EACCES') === R.signatureFor('main.error', 'Error: open /Users/sam: EMFILE'), false);
check('an apostrophe in a cookie value cannot become a quote', R.scrub('Error: rejected "row\nCookie: theme=O\'Brien\nClient Orion', '/h').includes('Orion'), false);
check('an apostrophe in a URL password cannot hide the @', R.scrub("Error: GET https://alice:Hunter2!'x@example.com/ failed", '/h').includes('Hunter2'), false);
check("can't read and can't write stay apart", R.signatureFor('main.error', "Error: can't read 'id'") === R.signatureFor('main.error', "Error: can't write 'id'"), false);
check('a home path cannot eat the key of a following credential', R.scrub('Error: login failed for /Users/sam password=hunter2', '/Users/sam').includes('hunter2'), false);
check('a very long credential key still redacts its value', R.scrub('Error: login failed SPRING_DATASOURCE_HIKARI_DATA_SOURCE_PROPERTIES_PASSWORD=hunter2', '/h').includes('hunter2'), false);
check('a password that is an errno name is still redacted', R.scrub('Error: database/password: EACCES', '/h').includes('EACCES'), false);
check('a slash-qualified credential key still redacts its value', R.scrub('Error: invalid config database/password=hunter2', '/h').includes('hunter2'), false);
check('an errno-shaped password is still a secret', R.scrub('Error: invalid config database/password=EASTER2026', '/h').includes('EASTER2026'), false);
check('an errno-shaped value after a colon is still a secret unless it is a real errno', R.scrub('Error: database/password: EASTER2026', '/h').includes('EASTER2026'), false);
check('a slash-qualified key with a non-errno value is still a secret', R.scrub('Error: open /Users/sid: hunter2', '/h').includes('hunter2'), false);
check('"tokens: 5" is not a credential', R.scrub('used tokens: 5', '/h'), 'used tokens: 5');
check('a frame in a path with parentheses is still a frame',
  R.signatureFor('crash.uncaughtException', 'Error: boom\n    at foo (/Applications/Dobius+ (copy).app/Contents/Resources/app.asar/main.js:10:1)') === R.signatureFor('crash.uncaughtException', 'Error: boom\n    at bar (/Applications/Dobius+ (copy).app/Contents/Resources/app.asar/main.js:10:1)'), false);
{
  const P = '/Users/sam/' + 'nested/'.repeat(45);
  check('a long terminal path still normalizes', R.signatureFor('main.error', `[terminal-manager] resize error for term-${P}alpha-1: ioctl failed`), R.signatureFor('main.error', `[terminal-manager] resize error for term-${P}beta-1: ioctl failed`));
}
check('a webview page error is never reported', R.isReportable('guest.error', 'boom'), false);
check('a title cannot mention anyone', R.issueTitle('main.error', 'boom @octocat #12').includes('@octocat'), false);
{
  const t0 = Date.now();
  const hostile = ['a-'.repeat(4000), 'term-'.repeat(1600), 'at x ('.repeat(1300), '"\''.repeat(4000), 'password'.repeat(1000) + '=x', ('x '.repeat(10) + '\n').repeat(400)];
  for (const h of hostile) { R.scrub(h, '/h'); R.signatureFor('main.error', h); R.signatureFor('crash.uncaughtException', 'E\n' + h); R.issueTitle('main.error', h); }
  check('adversarial inputs scrub and sign quickly', Date.now() - t0 < 1500, true);
}
check('a NUL is stripped', R.scrub('bad\u0000record', '/h'), 'badrecord');
check('two failures between two paths stay apart',
  R.signatureFor('main.error', "[tasks] Failed to read tasks for /Users/sam/Client: EACCES: permission denied, open '/Users/sam/tasks.json'") === R.signatureFor('main.error', "[tasks] Failed to read tasks for /Users/sam/Client: EMFILE: too many open files, open '/Users/sam/tasks.json'"), false);
check('a window id does not split a fault', R.signatureFor('main.error', '[terminal-manager] resize error for term-/x/site~w-abcdefgh-1: ioctl failed'), R.signatureFor('main.error', '[terminal-manager] resize error for term-/x/site~w-ijklmnop-1: ioctl failed'));
check('a hyphenated bundle hash does not split a fault',
  R.signatureFor('renderer.error', 'boom (index-BQa-CPvz.js:10)'), R.signatureFor('renderer.error', 'boom (index-AbCdEfGh.js:99)'));
check('a rotated secret does not split a fault',
  R.signatureFor('main.error', 'fetch failed https://api.example.com/v1/items?token=secretAlpha'),
  R.signatureFor('main.error', 'fetch failed https://api.example.com/v1/items?token=secretBeta'));
check('client folders with spaces are dropped, file and line kept',
  R.scrub("ENOENT: open '/Users/sam/Projects (Code)/Blue Atlas/plan.txt'", '/Users/sam'), "ENOENT: open '~/…/plan.txt'");
check('a stack frame keeps its file:line', R.scrub('    at run (/Users/sam/Clients/Acme/app/x.js:10:3)', '/Users/sam'), '    at run (~/…/x.js:10:3)');
check('quoted user data keeps only its length',
  R.scrub('SyntaxError: Unexpected token \'C\', "Client Orion" is not valid JSON', '/h'), 'SyntaxError: Unexpected token \'[17 chars]" is not valid JSON');
check('a short single-quoted property name stays', R.scrub("Cannot read properties of undefined (reading 'id')", '/h'), "Cannot read properties of undefined (reading 'id')");
check('a fragment token is removed', R.scrub('https://x.com/#access_token=0123456789abcdef', '/h').includes('0123456789'), false);
check('a 32-char hex id is removed', R.scrub('id 0123456789abcdef0123456789abcdef', '/h'), 'id [redacted]');
{
  const t0 = Date.now();
  R.scrub('a'.repeat(100000) + '@x.', '/h');
  R.signatureFor('renderer.error', '/a'.repeat(50000) + ' x');
  check('a 100KB hostile line scrubs and signs quickly', Date.now() - t0 < 500, true);
}
check('long secrets redacted', R.scrub('k=' + 'aB3'.repeat(17), '/h'), 'k=[redacted]');
check('a long name without digits is kept', R.scrub('x'.repeat(50), '/h'), 'x'.repeat(50));
check('capped at 3000', R.scrub('x '.repeat(2500), '/h').length, 3000);

// ---- one signature per fault, across versions and paths
const a = R.signatureFor('renderer.error', 'Cannot read properties of undefined (reading \'id\') (file:///Applications/Dobius+.app/Contents/Resources/app.asar/dist/assets/index-AbC123xy.js:4410)');
const b = R.signatureFor('renderer.error', 'Cannot read properties of undefined (reading \'name\') (file:///Users/x/dist/assets/index-ZZ99yy11.js:4999)');
check('same fault, different bundle hash/line/path/value: one signature', a, b);
check('different kind, different signature', R.signatureFor('main.error', 'x') === R.signatureFor('renderer.error', 'x'), false);
const st1 = R.signatureFor('crash.uncaughtException', 'TypeError: a is not a function\n    at foo (/x/main.js:10:3)\n    at bar (/x/y.js:1:1)');
const st2 = R.signatureFor('crash.uncaughtException', 'TypeError: a is not a function\n    at foo (/other/main.js:99:7)');
check('stack: same first frame, other lines: one signature', st1, st2);
const st3 = R.signatureFor('crash.uncaughtException', 'TypeError: a is not a function\n    at baz (/x/main.js:10:3)');
check('stack: different first frame: different signature', st1 === st3, false);
check('titles are capped', R.issueTitle('main.error', 'y '.repeat(150)).length, 120);
check('crash kinds are tagged crash', R.issueTitle('crash.native', 'x').startsWith('[crash]'), true);

// ---- native crash report parsing
const ips = fs.readFileSync(path.join(here, 'fixtures', 'crash-sigabrt.ips'), 'utf8');
const parsed = R.parseIps(ips);
check('ips parses', parsed && parsed.kind, 'crash.native');
check('ips first line names the signal', parsed.detail.split('\n')[0], 'Dobius+ EXC_CRASH SIGABRT Abort trap: 6');
check('ips carries the version', parsed.version, '1.0.79');
check('ips lists the faulting frames', parsed.detail.includes('libsystem_kernel.dylib __pthread_kill'), true);
{
  // Two aborts with the same termination frames but different app frames are
  // different crashes: the signature must look past the abort machinery.
  const [h, b] = [ips.slice(0, ips.indexOf('\n')), JSON.parse(ips.slice(ips.indexOf('\n') + 1))];
  const pty = b.usedImages.findIndex((i) => i.name === 'pty.node');
  const other = JSON.parse(JSON.stringify(b));
  other.usedImages[pty] = { name: 'better_sqlite3.node' };
  check('same abort, different app frames: different signatures', R.parseIps(h + '\n' + JSON.stringify(other)).sig === parsed.sig, false);
  const sameApp = JSON.parse(JSON.stringify(b));
  sameApp.threads[0].frames[0].symbol = 'something_else';
  check('same app frames, different system frames: one signature', R.parseIps(h + '\n' + JSON.stringify(sameApp)).sig, parsed.sig);
}
// Pruning keeps what is unsent or still cooling down.
{
  const now = 10_000_000_000;
  const sigs = {};
  for (let i = 0; i < 260; i += 1) sigs['s' + i] = { count: 1, sent: 1, lastSentAt: 0, lastSeen: String(1000 + i) };
  sigs.s0 = { count: 2, sent: 1, lastSentAt: 0, lastSeen: '0000' };          // oldest, unsent
  sigs.s1 = { count: 1, sent: 1, lastSentAt: now - 1000, lastSeen: '0001' }; // oldest, cooling
  const st = { sigs };
  R.pruneSigs(st, now);
  check('pruned to the cap', Object.keys(st.sigs).length, 200);
  check('an unsent fault survives pruning', !!st.sigs.s0, true);
  check('a cooling fault survives pruning', !!st.sigs.s1, true);
  check('the oldest idle fault goes', !!st.sigs.s2, false);
}
{
  const [h, b] = [ips.slice(0, ips.indexOf('\n')), JSON.parse(ips.slice(ips.indexOf('\n') + 1))];
  const strip = (off) => { const c = JSON.parse(JSON.stringify(b)); for (const f of c.threads[0].frames) { delete f.symbol; f.imageOffset = off; } return R.parseIps(h + '\n' + JSON.stringify(c)); };
  check('unsymbolicated crashes at different offsets stay apart', strip(4096).sig === strip(8192).sig, false);
  check('an unsymbolicated frame shows its offset', strip(4096).detail.includes('pty.node +0x1000'), true);
}
check('another app\'s report is ignored', R.parseIps(ips.replace('com.statusdigital.dobius-plus', 'com.other.app')), null);
check('garbage is ignored', R.parseIps('not json\n{'), null);

// ---- one reporter per profile
{
  const lockDir = fs.mkdtempSync(path.join(tmp, 'lock-'));
  const lock = path.join(lockDir, 'x.lock');
  check('the first instance takes the lock', R.takeReporterLock(lock), true);
  fs.writeFileSync(lock, '999999');
  check('a live Dobius+ owner keeps it', R.takeReporterLock(lock, { isOurs: () => true }), false);
  check('a dead or reused pid is taken over', R.takeReporterLock(lock, { isOurs: () => false }), true);
  check('the lock now names this process', fs.readFileSync(lock, 'utf8'), String(process.pid));
}

// ---- end to end against the fake gh
R.startErrorReporter({ userDataDir: userData, version: '1.0.84', isPackaged: false, getSettings: () => ({}) });
// An unreadable report must be retried later, not skipped for good.
const locked = path.join(crashDir, 'Dobius+-2026-10-28-110000.ips');
fs.writeFileSync(locked, ips.replace('"Dobius+"', '"Dobius+ Helper"'));
fs.chmodSync(locked, 0o000);
check('an unreadable report is not counted', R.scanCrashReports(), 0);
fs.chmodSync(locked, 0o644);
fs.copyFileSync(path.join(here, 'fixtures', 'crash-sigabrt.ips'), path.join(crashDir, 'Dobius+-2026-10-28-120000.ips'));
fs.writeFileSync(path.join(crashDir, 'Other-2026-10-28-120000.ips'), ips);
R.noteFault('crash.uncaughtException', 'TypeError: boom\n    at x (/Users/sam/a.js:1:1)');
R.noteFault('crash.uncaughtException', 'TypeError: boom\n    at x (/Users/sam/a.js:2:2)');
let r = await R.flushReports(Date.now());
check('first flush files the JS fault and the crash once readable (same signature: one issue, two counts)', r.filed, 2);
const calls = () => fs.readFileSync(ghLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
let creates = calls().filter((c) => c[1] === 'create');
check('two issues created', creates.length, 2);
const bodyOf = (c) => c[c.indexOf('--body') + 1];
check('every create targets the configured repo', creates.every((c) => c[c.indexOf('-R') + 1] === 'test-owner/test-reports'), true);
check('the JS fault counts both occurrences', creates.some((c) => bodyOf(c).includes('Seen: 2 time(s)')), true);
check('bodies carry the dedupe marker', creates.every((c) => /dobius-report: [0-9a-f]{12}/.test(bodyOf(c))), true);
check('no home path leaves the machine', creates.some((c) => bodyOf(c).includes('/Users/sam')), false);
check('the other app\'s crash report was not read', creates.filter((c) => bodyOf(c).includes('SIGABRT')).length, 1);
check('the retried report counted with its twin', creates.some((c) => bodyOf(c).includes('SIGABRT') && bodyOf(c).includes('Seen: 2 time(s)')), true);

r = await R.flushReports(Date.now());
check('nothing new: second flush files nothing', r.filed, 0);

R.noteFault('crash.uncaughtException', 'TypeError: boom\n    at x (/Users/sam/a.js:3:3)');
r = await R.flushReports(Date.now());
check('a repeat inside 6h waits', r.filed, 0);
r = await R.flushReports(Date.now() + 7 * 3600_000);
check('after 6h the repeat is sent as a comment', r.filed, 1);
const comment = calls().filter((c) => c[1] === 'comment').pop();
check('comment goes to the existing issue', comment[2], '101');
check('comment says it recurred after close', bodyOf(comment).startsWith('Seen again AFTER this issue was closed. 1 more time(s)'), true);
check('no duplicate issue for the repeat', calls().filter((c) => c[1] === 'create').length, 2);

const saved = JSON.parse(fs.readFileSync(path.join(userData, 'logs', 'error-reports.json'), 'utf8'));
check('state persisted with both faults', Object.keys(saved.sigs).length, 2);

// A report macOS is still writing is retried, not marked read.
{
  const half = path.join(crashDir, 'Dobius+-2026-10-28-130000.ips');
  const other = ips.replace('__pthread_kill', 'other_kill').replace('pty.node', 'sqlite.node');
  fs.writeFileSync(half, other.slice(0, other.length - 40));
  check('a half-written report is not counted', R.scanCrashReports(), 0);
  fs.writeFileSync(half, other);
  check('it is read once complete', R.scanCrashReports(), 1);
}

const listCalls = () => calls().filter((c) => c[1] === 'list').length;
// Three gh failures in a row end the flush (GitHub down or rate limiting).
{
  for (let i = 0; i < 5; i += 1) R.noteFault('main.error', `distinct failure kind ${'abcde'[i]}`);
  process.env.FAKE_GH_FAIL = '1';
  const before = listCalls();
  const res = await R.flushReports(Date.now() + 8 * 3600_000);
  delete process.env.FAKE_GH_FAIL;
  check('the flush backs off after three failures', res.skipped, 'gh-failing');
  check('exactly three calls were tried', listCalls() - before, 3);
}
// A create GitHub accepted whose reply was lost is linked, not re-counted.
{
  R.noteFault('main.error', 'lost reply fault');
  process.env.FAKE_GH_LOSE_REPLY = 'lost reply fault';
  await R.flushReports(Date.now() + 9 * 3600_000);
  delete process.env.FAKE_GH_LOSE_REPLY;
  // The marker lookup fails once: the next flush must retry it, not skip it.
  process.env.FAKE_GH_BODY_FAIL = '1';
  await R.flushReports(Date.now() + 9.3 * 3600_000);
  delete process.env.FAKE_GH_BODY_FAIL;
  await R.flushReports(Date.now() + 9.6 * 3600_000);
  const saved2 = JSON.parse(fs.readFileSync(path.join(userData, 'logs', 'error-reports.json'), 'utf8'));
  const e = Object.values(saved2.sigs).find((x) => x.sample === 'lost reply fault');
  check('the lost-reply issue is linked', e && e.issue, 555);
  check('its occurrence counts as sent', e && e.sent, 1);
  check('no repeat comment was posted on it', calls().filter((c) => c[1] === 'comment' && c[2] === '555').length, 0);
}
// Another Mac's issue for the same fault does NOT absorb our failed create.
{
  R.noteFault('main.error', 'other mac fault');
  process.env.FAKE_GH_LOSE_REPLY = 'other mac fault';
  await R.flushReports(Date.now() + 10 * 3600_000);
  delete process.env.FAKE_GH_LOSE_REPLY;
  fs.writeFileSync(path.join(tmp, 'lost-body-555'), 'created by another Mac, no attempt marker');
  const before = calls().filter((c) => c[1] === 'comment' && c[2] === '555').length;
  await R.flushReports(Date.now() + 10.6 * 3600_000);
  check('our reserved occurrence is reported on the other Mac\'s issue', calls().filter((c) => c[1] === 'comment' && c[2] === '555').length - before, 1);
}

// A linked issue that was deleted is unlinked, not retried forever.
{
  R.noteFault('crash.uncaughtException', 'TypeError: boom\n    at x (/Users/sam/a.js:4:4)');
  process.env.FAKE_GH_GONE = '101';
  const res = await R.flushReports(Date.now() + 14 * 3600_000);
  delete process.env.FAKE_GH_GONE;
  const saved3 = JSON.parse(fs.readFileSync(path.join(userData, 'logs', 'error-reports.json'), 'utf8'));
  const boom = Object.values(saved3.sigs).find((x) => x.sample.startsWith('TypeError: boom'));
  check('a deleted issue is unlinked', boom.issue, null);
  check('and does not count toward the failure backoff', res.skipped === 'gh-failing', false);
}

// Today's creations used up: the rest wait WITHOUT searching.
{
  for (let i = 0; i < 25; i += 1) R.noteFault('main.error', `storm fault ${String.fromCharCode(97 + i)}`);
  const creates0 = calls().filter((c) => c[1] === 'create').length;
  const lists0 = listCalls();
  await R.flushReports(Date.now() + 16 * 3600_000);
  const made = calls().filter((c) => c[1] === 'create').length - creates0;
  check('creations stop at the daily cap', creates0 + made, 20);
  check('no search for a fault that cannot be filed today', listCalls() - lists0, made);
}

console.log(`\n${pass} passed, ${fail} failed`);
// After the reporter's own exit save, which was registered first.
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
process.exit(fail ? 1 : 0);
