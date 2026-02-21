# Task 1.1 Review — Redesign Launcher

## Three things that could be better
1. The skeleton loader in ProjectList uses hardcoded count (6) — could match last-known project count from config.
2. The search icon SVG is inline — could extract to a shared Icon component if reused elsewhere.
3. Bundle size jumped from 559KB to 684KB due to framer-motion — acceptable for the animation quality.

## One thing I'm fixing right now
Nothing critical found — the implementation follows all design rules correctly.

## Concerns
- framer-motion's AnimatePresence mode="popLayout" may cause layout recalculation on fast filter changes — monitor performance.
- The `whileHover` on motion.button only affects scale, not border — CSS transition handles border-color.
