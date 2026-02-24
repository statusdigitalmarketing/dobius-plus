# Task 2.4: Memory Management — Clear and Pruning

## What
1. Clear Memory button with confirmation (already in Task 2.2 MemoryPanel)
2. Auto-pruning: appendJournalEntry now calls pruneOldMemory(90) after each append
3. Memory stat card shows real count of agents with memory (already in Task 2.1)

## Why
Memory should be self-managing — old entries pruned automatically, clear available manually.

## Verification
- `npx vite build` exits 0

## Risks
- pruneOldMemory on every append is extra work — negligible since it only iterates agents (small set)
