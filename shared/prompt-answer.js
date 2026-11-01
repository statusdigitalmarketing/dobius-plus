// A red ("needs") tab has nothing that tells it the dialog is gone: Claude
// sends no hook when a permission prompt is answered, so the tab stayed red
// while an approved command ran, until the next tool or the end of the turn.
// main watches input to every terminal (any surface: desktop keys, Chat
// buttons, the phone); on an answer to a red tab its status tracker goes back
// to working (terminal-status noteInput) and it tells the tab's window
// ('terminal:statusHint'). The PTY output stream is never touched.
// Esc is left out: it declines, and Claude's Stop hook then turns it green.
// ponytail: an AskUserQuestion with several questions turns yellow after the
// first answer, while later questions still wait; a number that is no option
// (9 on a three-option dialog) does the same. Colour only, nothing is sent.

const PASTE_START = '\x1b[200~';

// Enter (choose the highlighted option) or a bare option number; never a paste,
// whose newlines arrive as carriage returns but answer nothing.
export function answersPrompt(data) {
  if (typeof data !== 'string' || data.includes(PASTE_START)) return false;
  return data.includes('\r') || /^[1-9]$/.test(data);
}

// A line SUBMITTED: a carriage return that is not Option+Enter (ESC then CR,
// a newline inside the prompt) and not part of a paste. What answers a
// handed-back `! command` (shared/handoff.js), and what marks the tab where
// a prompt was sent from (codex-status.js).
export function submitsInput(data) {
  return typeof data === 'string' && !data.includes(PASTE_START) && /(^|[^\x1b])\r/.test(data);
}
