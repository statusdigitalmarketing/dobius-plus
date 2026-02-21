# Task 1.4 Review — Redesign Dashboard tabs

## Three things that could be better
1. Stats.jsx uses getComputedStyle to read CSS variables for recharts — this only runs on initial mount, so theme changes won't update chart colors until remount. Acceptable since tab switch causes remount.
2. Bundle size jumped from 684KB to 1034KB due to recharts — could lazy-load Stats tab to reduce initial load.
3. Sessions table hover uses onMouseEnter/Leave like ConversationCard — consistent pattern but still not pure CSS.

## One thing I'm fixing right now
Nothing critical — all 7 files pass build and follow design rules consistently.

## Concerns
- Recharts ResponsiveContainer may have issues if the parent has height: 0 initially (hidden tab). AnimatePresence mode="wait" should handle this since it fully unmounts/remounts.
- The chartColors useMemo has an empty dependency array — intentional since we want initial theme colors and remount on tab switch handles theme changes.
