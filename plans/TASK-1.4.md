# Task 1.4: Redesign Dashboard tabs (all 6)

## What
- DashboardView: underline tab indicator, AnimatePresence tab transitions, skeleton loader
- Overview: stat cards with border+monospace, process table, summary cards
- MCPServers: table layout with headers, status dots
- Skills: card grid with borders
- Stats: recharts BarChart for daily activity + hour distribution, model usage table
- Sessions: table with sortable headers, hover highlight
- Plans: collapsible with chevron animation, monospace content

## Files changed
All 7 files in src/components/Dashboard/

## Design rules
- Section titles in var(--dim), uppercase, tracking-wider — NOT accent colored
- Tables with header row on var(--surface), border around container
- Monospace for all data values
- Recharts colors from CSS variables

## Verification
- `npx vite build` exits 0
