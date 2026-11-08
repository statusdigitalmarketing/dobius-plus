// Windows keyboard (Windows build, 2026-11-06). On the Mac, app shortcuts use
// Cmd, which a terminal never needs. On Windows the only modifier is Ctrl, and
// Claude Code and every shell use Ctrl+C, B, G, K, R, T, W themselves, so the
// app's shortcuts move to Ctrl+Shift, as in Windows Terminal and VS Code.
//
// Pure: no DOM, unit-tested under plain node (electron/__tests__/win-keys.test.mjs).

/**
 * The Mac shortcut a Windows key press stands for, as an event-like object
 * the project window's existing Cmd handler understands, or null when the
 * press is not an app shortcut (it then goes to the terminal untouched).
 *   Ctrl+Shift+T  new tab            Ctrl+Shift+W  close tab
 *   Ctrl+Shift+N  new window         Ctrl+Shift+P  command palette
 *   Ctrl+Shift+B  sidebar            Ctrl+Shift+G  git panel
 *   Ctrl+Shift+K  clear terminal     Ctrl+Shift+R  resume latest session
 *   Ctrl+Shift+M  Terminal / Chat    Ctrl+Shift+D  Terminal / Dashboard
 *   Ctrl+Shift+Z  reopen closed tab  Ctrl+Tab, Ctrl+Shift+Tab  next / previous tab
 *   Ctrl+1..9     tab N
 */
export function winToMacShortcut(e) {
  if (!e || e.type && e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey) return null;
  const k = String(e.key || '');
  const as = (key, shiftKey = false, extra = {}) => ({
    key, shiftKey, altKey: false, metaKey: true, ctrlKey: false, code: extra.code || '', ...extra,
    preventDefault: () => e.preventDefault?.(),
  });
  if (k === 'Tab') return as(e.shiftKey ? '[' : ']', true);
  if (!e.shiftKey) return /^[1-9]$/.test(k) ? as(k) : null;
  switch (k.toLowerCase()) {
    case 't': return as('t');
    case 'w': return as('w');
    case 'n': return as('n', true);
    case 'p': return as('p');
    case 'b': return as('b');
    case 'g': return as('g');
    case 'k': return as('k');
    case 'r': return as('r');
    case 'm': return as('c', true);
    case 'z': return as('T', true, { reopenOnly: true });
    case 'd': return as('T', true, { viewToggle: true });
    default: return null;
  }
}

/**
 * What a key press in a Windows terminal does before xterm sees it:
 *   'copy'  Ctrl+C with text selected, or Ctrl+Shift+C
 *   'paste' Ctrl+V or Ctrl+Shift+V (the browser's own paste event delivers it)
 *   'app'   an app shortcut (winToMacShortcut): xterm must not send it
 *   null    the terminal gets it (Ctrl+C with nothing selected interrupts)
 */
export function winTerminalKey(e, hasSelection) {
  if (!e || e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey) return null;
  const k = String(e.key || '').toLowerCase();
  if (k === 'c' && (e.shiftKey || hasSelection)) return 'copy';
  if (k === 'v') return 'paste';
  if (k === 'f' && e.shiftKey) return 'app'; // terminal search (TerminalPane)
  if (winToMacShortcut(e)) return 'app';
  return null;
}

/** Shortcut text for menus and hints: "Cmd+T" on the Mac, "Ctrl+Shift+T" on Windows. */
export function shortcutLabel(mac, win, platform) {
  return platform === 'win32' ? win : mac;
}

/**
 * Settings > Keyboard Shortcuts on Windows: every app shortcut above, in the
 * order people reach for them. windows-port.test.mjs checks each Ctrl chord here
 * really is one winToMacShortcut / winTerminalKey answers, so the page cannot
 * list a key that does nothing.
 */
export const WINDOWS_SHORTCUT_ROWS = [
  { keys: 'Ctrl+Shift+T', action: 'New Tab' },
  { keys: 'Ctrl+Shift+W', action: 'Close Tab' },
  { keys: 'Ctrl+1-9', action: 'Switch to Tab N' },
  { keys: 'Ctrl+Tab', action: 'Next Tab' },
  { keys: 'Ctrl+Shift+Tab', action: 'Previous Tab' },
  { keys: 'Ctrl+Shift+Z', action: 'Reopen Closed Tab' },
  { keys: 'Ctrl+Shift+N', action: 'New Window' },
  { keys: 'Ctrl+Shift+M', action: 'Terminal / Chat View' },
  { keys: 'Ctrl+Shift+D', action: 'Toggle Terminal / Dashboard' },
  { keys: 'Ctrl+Shift+B', action: 'Toggle Sidebar' },
  { keys: 'Ctrl+Shift+G', action: 'Toggle Git Panel' },
  { keys: 'Ctrl+Shift+P', action: 'Command Palette' },
  { keys: 'Ctrl+Shift+K', action: 'Clear Terminal' },
  { keys: 'Ctrl+Shift+F', action: 'Search Terminal' },
  { keys: 'Ctrl+Shift+R', action: 'Resume Latest Session' },
  { keys: 'Ctrl+C', action: 'Copy selection (stops the command when nothing is selected)' },
  { keys: 'Ctrl+V', action: 'Paste' },
  { keys: 'Close the last window', action: 'Quit (windows and sessions come back next time)' },
  { keys: 'Esc', action: 'Focus Terminal (from input)' },
  { keys: 'Enter', action: 'Send Command (from input)' },
];
