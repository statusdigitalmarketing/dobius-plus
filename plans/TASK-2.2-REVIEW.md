# Task 2.2 Review

## Three things that could be better
1. The `parseJsonl` function reads the entire file into memory — for very large history files, streaming would be more efficient
2. The `listProjects` directory-to-path decoding assumes a specific encoding pattern — should verify against real Claude data
3. The transcript parser only handles simple message formats — Claude transcripts may have nested tool_use blocks that we skip

## One thing I'm fixing right now
Changed `execSync` to `execFile` with callback for `getActiveProcesses` to avoid shell injection risk (caught by security hook). Using `pgrep -lf claude` instead of piped shell commands.

## Concerns
- chokidar v5 is a major version — verify it works with ESM imports
- The `loadTranscript` function scans all project dirs if the direct path fails — could be slow with many projects
- CRITICAL check: verified zero writes to ~/.claude/ — PASS
