// A folder for display on the phone: only the Mac's own home folder becomes ~ (the Mac sends it), so /Users/Shared/x
// and another person's home stay in full and two folders never read the same (Codex phone tasks round 5). No home
// (an older Mac): the full path.
export function shortPath(p, home) {
  const s = String(p || '');
  const h = typeof home === 'string' ? home.replace(/[\\/]+$/, '') : '';
  if (!h) return s;
  if (s === h) return '~';
  return s.startsWith(h) && (s[h.length] === '/' || s[h.length] === '\\') ? `~${s.slice(h.length)}` : s;
}

// What the phone shows for a folder must name exactly one folder: HTML collapses a double space and hides tabs,
// newlines and zero-width or direction marks, so `/work/a  b` read as `/work/a b` (Codex phone tasks round 6). A
// single space between words stays; every other space in a run, and every invisible character, is shown as a mark.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f­؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￹-￻]/u;
export function visiblePath(p) {
  const s = String(p || '');
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === ' ') {
      const lone = i > 0 && i < s.length - 1 && s[i - 1] !== ' ' && s[i + 1] !== ' ';
      out += lone ? ' ' : '␣';
    } else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (INVISIBLE.test(ch) || /\s/u.test(ch)) out += `\\u{${ch.codePointAt(0).toString(16)}}`;
    else out += ch;
  }
  return out;
}
