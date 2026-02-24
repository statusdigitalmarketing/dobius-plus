# Task 1.1: Extend Config Schema with Agent Memory Storage

## What
Add `agentMemory` top-level config object keyed by agentId. Add helper functions:
- `getAgentMemory(agentId)` — returns memory or empty default
- `setAgentMemory(agentId, memory)` — validates + saves with size guards
- `appendJournalEntry(agentId, entry)` — push + FIFO trim to 50
- `pruneOldMemory(maxAgeDays)` — remove entries older than N days

## Why
Agent memory needs persistent storage. Config manager already handles debounced atomic writes — extending it keeps the pattern consistent.

## Verification
- `npx vite build` exits 0
- New functions exported from config-manager.js

## Risks
- Config file could grow if memory is not bounded — mitigated by strict size limits
