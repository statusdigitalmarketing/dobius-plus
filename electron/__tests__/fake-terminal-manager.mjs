// Recording stand-in for terminal-manager.js (see chat-service-loader.mjs).
export const writes = [];
export const ptys = new Map();
export const seqs = new Map();
const outs = new Map(); // id -> { out, atInput }
const raws = new Map(); // id -> every output chunk, escape-only ones included
export function writeTerminal(id, data) {
  writes.push([id, data]); seqs.set(id, (seqs.get(id) || 0) + 1);
  const o = outs.get(id) || { out: 0, atInput: 0 }; o.atInput = o.out; outs.set(id, o);
}
/** Simulate the PTY printing something. */
export function emitOutput(id) { const o = outs.get(id) || { out: 0, atInput: 0 }; o.out += 1; outs.set(id, o); emitRawOutput(id); }
/** Simulate output that draws nothing printable (cursor moves, a clear). */
export function emitRawOutput(id) { raws.set(id, (raws.get(id) || 0) + 1); }
export function terminalRawOutputSeq(id) { return raws.get(id) || 0; }
export function terminalSettledSinceInput(id) {
  const o = outs.get(id);
  return !seqs.get(id) || (!!o && o.out > o.atInput);
}
export function terminalInputSeq(id) { return seqs.get(id) || 0; }
/** Tests set how long ago the last input was; unset reads as just now. */
export const inputAges = new Map();
export function terminalInputAgeMs(id) { return inputAges.has(id) ? inputAges.get(id) : 0; }
export function terminalInstance(id) { return ptys.get(id) || null; }
export const buffers = new Map(); // id -> raw PTY tail
export function getTerminalBuffer(id) { return buffers.get(id) || ''; }
export const closing = new Set();
export function terminalClosing(id) { return closing.has(id); }
