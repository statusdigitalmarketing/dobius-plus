// Recording stand-in for terminal-manager.js (see chat-service-loader.mjs).
export const writes = [];
export const ptys = new Map();
export const seqs = new Map();
const outs = new Map(); // id -> { out, atInput }
export function writeTerminal(id, data) {
  writes.push([id, data]); seqs.set(id, (seqs.get(id) || 0) + 1);
  const o = outs.get(id) || { out: 0, atInput: 0 }; o.atInput = o.out; outs.set(id, o);
}
/** Simulate the PTY printing something. */
export function emitOutput(id) { const o = outs.get(id) || { out: 0, atInput: 0 }; o.out += 1; outs.set(id, o); }
export function terminalSettledSinceInput(id) {
  const o = outs.get(id);
  return !seqs.get(id) || (!!o && o.out > o.atInput);
}
export function terminalInputSeq(id) { return seqs.get(id) || 0; }
export function terminalInstance(id) { return ptys.get(id) || null; }
export function getTerminalBuffer() { return ''; }
export const closing = new Set();
export function terminalClosing(id) { return closing.has(id); }
