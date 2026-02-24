# Task 3.1 — Review

## Three things that could be better
1. The useEffect for auto-resize fires on every `input` state change including clearing — minor overhead but negligible
2. The \n→\r replacement in sendCommand is a simple global replace — could use more nuanced handling for mixed content, but for command input this is correct
3. Could add visual feedback (line count indicator) for multiline input, but that's scope creep

## One thing I'm fixing now
Nothing — the three-part fix (resize via useEffect, \n→\r for PTY, updated placeholder) is complete and clean.

## Concerns
- The `\n→\r` replacement means each line in multiline input is sent as a separate Enter. For shell commands this is correct (each line executes). For Claude Code's TUI (which reads one input prompt), multiline input with \r would submit each line separately — but this is actually the expected behavior since Shift+Enter in the command bar creates multiple commands to execute sequentially.
