# Task 1.1: Redesign Launcher (ProjectList + ProjectCard)

## What
- Redesign ProjectList.jsx: "D+" logotype header, search with focus states, proper empty state, staggered list animation
- Redesign ProjectCard.jsx: subtle hover (scale 1.02 + border transition), left-border for active, monospace stats, staggered fade-in with framer-motion

## Files changed
- `src/components/Launcher/ProjectList.jsx`
- `src/components/Launcher/ProjectCard.jsx`

## Design rules
- Accent color ONLY on Open button CTA
- No gradient backgrounds — flat var(--surface) with var(--border)
- Left-border indicator for active projects (green)
- Session count + time ago in monospace var(--dim)
- Staggered fade-in animation (50ms delay per card)
- ALL colors from CSS variables

## Verification
- `npx vite build` exits 0
- No hardcoded hex colors in component JSX (except themes.js)

## Risks
- framer-motion import may increase bundle size (acceptable)
- Need to ensure staggered animation doesn't cause layout shifts
