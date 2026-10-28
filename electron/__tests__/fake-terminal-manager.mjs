// Recording stand-in for terminal-manager.js (see chat-service-loader.mjs).
export const writes = [];
export const ptys = new Map();
export const seqs = new Map();
export function writeTerminal(id, data) { writes.push([id, data]); seqs.set(id, (seqs.get(id) || 0) + 1); }
export function terminalInputSeq(id) { return seqs.get(id) || 0; }
export function terminalInstance(id) { return ptys.get(id) || null; }
export function getTerminalBuffer() { return ''; }
