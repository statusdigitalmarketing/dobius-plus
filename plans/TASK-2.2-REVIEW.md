# Task 2.2 — Review

## Three things that could be better
1. AgentCard uses -webkit-line-clamp for description truncation — standard CSS line-clamp would be more portable but has less browser support
2. StatusBadge hardcodes #3FB950 green — could use a CSS variable for consistency, but this matches the codebase green convention
3. Card transition on border-color uses inline CSS transition — could use framer-motion instead

## One thing I'm fixing now
Nothing — the AgentCard implementation is clean.

## Concerns
- None. The card layout follows the existing Sessions.jsx card pattern with appropriate modifications for agent-specific content.
