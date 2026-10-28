// Recording stand-in for terminal-manager.js (see chat-service-loader.mjs).
export const writes = [];
export const ptys = new Map();
export function writeTerminal(id, data) { writes.push([id, data]); }
export function terminalInstance(id) { return ptys.get(id) || null; }
export function getTerminalBuffer() { return ''; }
