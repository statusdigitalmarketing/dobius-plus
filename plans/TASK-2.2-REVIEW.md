# Task 2.2 Review — Search, filter, and sort controls

## Three things that could be better
1. Could debounce the search input for better perf with many sessions
2. The select dropdown styling is limited by browser defaults — could use a custom dropdown component
3. Could persist the sort preference to config

## One thing I'm fixing right now
- Nothing needed — the implementation is clean and matches existing patterns

## Concerns
- The filtering runs on every render — with 500 sessions max this is fine, but for thousands it could be optimized with useMemo
