# Task 2.1 — Review

## Three things that could be better
1. The StatCard component uses inline motion.div — could be a standalone file, but keeping it local reduces import overhead for a small component
2. Session count is fetched separately rather than shared with DashboardView — acceptable since they have different lifecycle needs
3. The "Memory: Synced" stat is static — could eventually reflect actual sync state

## One thing I'm fixing now
Nothing — the structure is clean and follows the Overview.jsx StatCard pattern.

## Concerns
- None. The StatsBar renders 4 cards matching the existing codebase patterns exactly.
