// Terminal font selection (v1.0.61, Sam: "move the terminal to a more
// friendly font"). Pure, so the fail-safes are unit-testable in plain node.
//
// The terminal is a character GRID: xterm.js measures one cell and draws
// every glyph into that box, so a proportional face like Helvetica shatters
// alignment: Claude Code's borders, tables and selectors are drawn with
// box characters that only line up in a monospace face. The friendly move
// that actually works is a friendlier MONOSPACE, so the picker curates the
// humanist monos every Mac ships with and lets a custom name through for
// anything the user installed. Whatever happens, the stack always ends in
// `monospace`, so a typo'd or missing font degrades to a working terminal,
// never a broken one.

export const DEFAULT_TERMINAL_STACK = "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace";

// Every entry ships with macOS. `hint` is the one-line pitch in Settings.
export const CURATED_TERMINAL_FONTS = [
  { id: '', label: 'Default (SF Mono)', hint: 'The sharp system mono' },
  { id: 'Monaco', label: 'Monaco', hint: 'The classic friendly Mac mono, round and soft' },
  { id: 'Menlo', label: 'Menlo', hint: 'Humanist and easy on the eyes' },
  { id: 'PT Mono', label: 'PT Mono', hint: 'Warm, slightly narrow' },
  { id: 'Andale Mono', label: 'Andale Mono', hint: 'Wide and airy' },
  { id: 'Courier New', label: 'Courier New', hint: 'Typewriter nostalgia' },
];

// Windows ships none of the Mac faces above except Courier New. Every entry
// here ships with Windows 11 (Cascadia with Windows Terminal); the default
// stack already falls through to Cascadia Code there.
export const WINDOWS_TERMINAL_FONTS = [
  { id: '', label: 'Default (Cascadia Code)', hint: 'The modern Windows Terminal mono' },
  { id: 'Cascadia Mono', label: 'Cascadia Mono', hint: 'Cascadia without ligatures' },
  { id: 'Consolas', label: 'Consolas', hint: 'The classic Windows coding mono' },
  { id: 'Lucida Console', label: 'Lucida Console', hint: 'Wide and very legible' },
  { id: 'Courier New', label: 'Courier New', hint: 'Typewriter nostalgia' },
];

/** The font list Settings offers on this platform. */
export function curatedTerminalFontsFor(platform) {
  return platform === 'win32' ? WINDOWS_TERMINAL_FONTS : CURATED_TERMINAL_FONTS;
}

/**
 * Keep only characters that can appear in a legitimate font family name.
 * The value lands in canvas ctx.font / CSS font-family, so quotes, braces,
 * semicolons and the rest have no business in it. Length-capped; whitespace
 * collapsed.
 */
export function sanitizeFontFamily(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/[^A-Za-z0-9 .-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/**
 * The full font-family stack for xterm given the user's setting.
 * '' (or garbage that sanitizes away) -> the default stack. A chosen face is
 * quoted and PREPENDED to the default stack, so a font that does not exist on
 * this machine falls through to the same terminal the user had before.
 */
export function buildTerminalFontFamily(setting) {
  const clean = sanitizeFontFamily(setting);
  if (!clean) return DEFAULT_TERMINAL_STACK;
  return `'${clean}', ${DEFAULT_TERMINAL_STACK}`;
}
