# Self-Review Findings — Mission Control Build

## Code Review Findings
- [x] **SECURITY** `src/components/Dashboard/Agents.jsx:80` — agent.model is interpolated into shell command without validation. **FIXED**: Added ALLOWED_MODELS allowlist, model flag only set if agent.model is in the allowlist.
- [x] **QUALITY** `src/components/Project/ProjectView.jsx:100` — removeExitListener cleanup could throw if onTerminalExit returns undefined. **FIXED**: Changed to `return () => removeExitListener?.()`.

## Architecture Audit Findings
No high-confidence issues found.
