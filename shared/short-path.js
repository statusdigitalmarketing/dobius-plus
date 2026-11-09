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

// What the phone shows for a folder must name exactly one folder, since Run acts on the folder the card names. HTML
// collapses a double space, and Unicode has more invisible and look-alike characters than any list can hold (Codex
// found a new one each round: zero-width, bidi, tag, combining grapheme joiner). So the label keeps printable ASCII
// as it is, a single space between words as a space, and writes everything else as a code: a run of spaces as
// open-box marks, a backslash doubled, a tab as \t, any other character as \u{hex}. A folder with accented or
// non-Latin letters reads as codes, and no two folders can ever read the same (Codex phone tasks rounds 6 to 8).
const BS = String.fromCharCode(92);
const OPEN_BOX = String.fromCodePoint(0x2423);
// A lone space is written as a no-break space: a line never wraps at it, so it always shows as a gap between two
// characters on one line and cannot vanish at a line end (Codex phone tasks round 13). A real no-break space in a
// folder name is not printable ASCII, so it is written as a code and never reads the same.
const NBSP = String.fromCharCode(160);
const NAMED = new Map([[9, 't'], [10, 'n'], [13, 'r']]);
export function visiblePath(p) {
  const s = Array.from(String(p || ''));
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const cp = s[i].codePointAt(0);
    if (cp === 32) {
      const lone = i > 0 && i < s.length - 1 && s[i - 1] !== ' ' && s[i + 1] !== ' ';
      out += lone ? NBSP : OPEN_BOX;
    } else if (cp === 92) out += BS + BS;
    else if (NAMED.has(cp)) out += BS + NAMED.get(cp);
    else if (cp > 32 && cp < 127) out += s[i];
    else out += `${BS}u{${cp.toString(16)}}`;
  }
  return out;
}
