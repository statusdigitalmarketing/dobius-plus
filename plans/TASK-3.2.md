# Task 3.2: Final theme audit + responsive polish

## What
- Add --danger and --warning CSS variables to theme system
- Replace hardcoded #F85149 and #E3B341 in BuildMonitor components with CSS vars
- Audit all new components for: CSS variable usage, hover states, responsive behavior at 900px

## Files
- EDIT: src/lib/themes.js (add --danger, --warning CSS vars)
- EDIT: src/components/Dashboard/BuildMonitor/BuildHealthGauge.jsx (replace hardcoded colors)
- EDIT: src/components/Dashboard/BuildMonitor/SupervisorStatus.jsx (replace hardcoded colors)
- EDIT: src/styles/index.css (add --danger, --warning to :root fallbacks)

## Verification
- `npx vite build` exits 0
- `grep -rn '#[0-9a-fA-F]' src/components/Dashboard/BuildMonitor/` returns 0 matches
