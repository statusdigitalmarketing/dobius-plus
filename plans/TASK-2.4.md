# Task 2.4 — Rename tab label and verify full integration

## What will change
- `src/components/Dashboard/DashboardView.jsx`: Change `{ id: 'agents', label: 'Agents' }` to `{ id: 'agents', label: 'Mission Control' }`

## Why
The tab label should reflect the new name of the component.

## Verification
- `npx vite build` exits 0
- `grep -c "Mission Control" src/components/Dashboard/DashboardView.jsx` returns 1
- `grep -c "{ id:" src/components/Dashboard/DashboardView.jsx` returns 12 (unchanged)

## What could go wrong
- Tab label change might be wider and overflow tab bar on narrow windows

## Estimated time
5 minutes
