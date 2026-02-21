# Task 2.3 Review — BuildProgressBar + BuildTimeline

## Three things that could be better
1. BuildTimeline uses `✓` unicode character — could use an SVG check for consistency, but it's tiny and works fine.
2. The timeline vertical line uses absolute positioning with fixed left offset (7px) — tied to dot width, fragile if dot size changes.
3. No empty state in BuildTimeline for 0 entries — returns null, which is correct since parent handles empty state.

## One thing I'm fixing right now
Nothing — both components are presentation-only, receive data via props, use CSS variables throughout.

## Concerns
- Both components are not yet imported anywhere — they'll be wired in Task 2.5 (BuildMonitorView).
- The progress bar animation replays on every re-render — framer-motion handles this gracefully with `animate` (only transitions changed values).
