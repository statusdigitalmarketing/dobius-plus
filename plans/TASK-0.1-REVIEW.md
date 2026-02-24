# Task 0.1 — Review

## Three things that could be better
1. The verify-task.sh script uses `grep -P` which requires GNU grep (macOS has BSD grep by default but Homebrew grep is likely installed)
2. The supervisor script pipes stdin to claude which may have buffering issues on very large build files
3. The progress JSON could include a schema version for future compatibility

## One thing I'm fixing now
Nothing — infrastructure files are simple scaffolding, all verified working.

## Concerns
- The `grep -P` in verify-task.sh may not work if only BSD grep is available (but macOS Homebrew typically provides it)
