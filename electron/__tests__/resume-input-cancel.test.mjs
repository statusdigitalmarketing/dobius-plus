// A queued auto-resume yields to a person typing, never to the terminal's own replies: opening a window sent a focus
// report that cancelled its resume (Brett, Asana 1220099565720834). Run: node ./electron/__tests__/resume-input-cancel.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isTerminalReply } from '../terminal-reply.js';

const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const write = main.slice(main.indexOf("ipcMain.on('terminal:write'"), main.indexOf("ipcMain.on('terminal:resize'"));
assert.match(write, /if \(!isTerminalReply\(data\)\) cancelAutoResumeTab\(id\);/, 'terminal:write spares replies');
for (const reply of ['\x1b[I', '\x1b[O', '\x1b[?62;4c', '\x1b]11;rgb:1111/1111/1111\x07', '\x1b[24;80R']) assert.equal(isTerminalReply(reply), true, JSON.stringify(reply));
for (const typed of ['a', 'claude', '\r', '\x03', '\x1b', '\x1b[A', '\x1b[1;2R']) assert.equal(isTerminalReply(typed), false, JSON.stringify(typed));
console.log('PASS  replies leave a pending resume alone, and keys still cancel it');

const resume = fs.readFileSync(new URL('../auto-resume.js', import.meta.url), 'utf8');
for (const why of ['already decided', 'no session was running', 'moved or stopped', 'auto-resume is off', 'transcript not found', 'over the size cap', 'queued to resume', 'not resumed:', 'cancelled by input']) assert.ok(resume.includes(why), why);
assert.match(resume, /for \(const tabId of restoredDuringStartup\) \{\s*\/\/[^\n]*\n\s*if \(handled\.has\(tabId\)\) continue;/, 'a tab the launch pass took is not logged again');
assert.ok(resume.includes('its tab closed before the resume was queued'), 'a tab seen then closed during polling gets a line');
assert.match(resume, /for \(const tabId of uncertainTabs\) \{ handled\.add\(tabId\);/, 'an uncertainty rejection is a decision, logged once');
console.log('PASS  the log says why a later window did or did not resume');
