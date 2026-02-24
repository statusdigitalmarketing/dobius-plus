# Task 2.1 — Rewrite Agents.jsx — MissionControl layout with StatsBar

## What will change
- `src/components/Dashboard/Agents.jsx`: Replace outer component with MissionControl structure
  - Add StatsBar with 4 stat cards (Agents, Terminals, Sessions, Memory)
  - Add Mission Control header with subtitle and + New Agent button
  - Keep existing loadAgents, handleLaunch, handleDelete, handleSave logic
  - Keep AgentEditor, Field, inputStyle unchanged
  - Add store selectors for terminalTabs and runningAgents

## Why
This is the first visual task of the Mission Control UI rewrite. The StatsBar provides an at-a-glance overview of the system state.

## Verification
- `npx vite build` exits 0
- MissionControl component renders with 4 stat cards + header

## What could go wrong
- Importing motion from framer-motion might cause build issues if not already used in this file
- Session count needs async load — must handle loading state

## Estimated time
15 minutes
