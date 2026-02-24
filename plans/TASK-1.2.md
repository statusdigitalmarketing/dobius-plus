# Task 1.2: Add IPC Handlers for Agent Memory CRUD

## What
Add 6 IPC handlers in main.js for memory operations:
- `agentMemory:get` — read memory for one agent
- `agentMemory:setContext` — update context (max 5000 chars)
- `agentMemory:appendJournal` — add journal entry
- `agentMemory:addExperience` — add experience item (max 20)
- `agentMemory:removeExperience` — remove by index
- `agentMemory:clear` — reset agent memory

## Why
IPC bridge between renderer and config persistence. All inputs validated with string length limits and type checks.

## Verification
- `npx vite build` exits 0
- `grep -c 'agentMemory:' electron/main.js` returns 6

## Risks
- Prototype pollution — mitigated by UNSAFE_KEYS check in config-manager
