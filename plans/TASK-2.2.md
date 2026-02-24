# Task 2.2 — Create AgentCard component with status indicators

## What will change
- Already implemented in Task 2.1's file rewrite. AgentCard, StatusBadge, and Badge components are in Agents.jsx.

## Implementation
- AgentCard: motion.div with layout, initial/animate, name + StatusBadge top row, badges row, description (3-line clamp), action buttons
- StatusBadge: green dot + RUNNING or gray dot + OFFLINE
- Badge: small tag with configurable bg/color
- Actions: Start (offline) / Chat (running) + Edit/Delete for custom agents

## Verification
- `npx vite build` exits 0 (already verified)
