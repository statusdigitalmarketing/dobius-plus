# Task 2.1: Add Memory Indicator to AgentCard

## What
- Load memory data for all agents in MissionControl component
- Show memory badges on AgentCard: run count, context icon, experience icon
- Update Memory stat card to show actual count

## Why
Visual indicators let users see at-a-glance which agents have memory and how much.

## Verification
- `npx vite build` exits 0

## Risks
- Loading memories for all agents on mount could be slow with many agents — mitigated by small data size
