# Task 2.3: Memory Injection into Agent System Prompts on Launch

## What
- Modified handleLaunch to build enhanced prompt with memory section
- Injects context, experience (numbered), and last 3 journal entries
- Total prompt capped at 10,000 chars

## Why
Agents should be aware of their accumulated memory on launch for continuity.

## Verification
- `npx vite build` exits 0

## Risks
- Long prompts could affect Claude's behavior — mitigated by 10K char limit
