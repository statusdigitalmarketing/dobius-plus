# Task 2.4: Create BuildHealthGauge + SupervisorStatus components

## What
- BuildHealthGauge: semi-circular SVG gauge 0-100, color gradient (red→yellow→green), centered number, failure/restart counts
- SupervisorStatus: status badge with pulse, restart count, branch info, last 5 log lines in monospace mini-terminal

## Files
- NEW: src/components/Dashboard/BuildMonitor/BuildHealthGauge.jsx
- NEW: src/components/Dashboard/BuildMonitor/SupervisorStatus.jsx

## Design rules
- All colors from CSS variables (gauge colors via inline SVG)
- Monospace for all data values
- Section titles: var(--dim), uppercase, tracking-wider
- Status dot: green pulse=running, grey=idle, red=failed

## Verification
- `npx vite build` exits 0
