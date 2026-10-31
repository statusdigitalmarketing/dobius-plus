// POSIX single-quote a string for a /bin/sh command line: the one quoting the
// generated scripts and shell commands share (claude-usage's statusLine,
// dobius-tab, dobius-open, the New Tab wrapper). Inside single quotes nothing
// is special, so only a quote itself needs care: close, escaped quote, reopen.
export const shQuote = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
