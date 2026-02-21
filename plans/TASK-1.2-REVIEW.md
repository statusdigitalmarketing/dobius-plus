# Task 1.2 Review — Redesign TopBar + StatusBar + ThemePicker

## Three things that could be better
1. ThemePicker dropdown could have keyboard navigation (up/down arrows) for accessibility.
2. The StatusBar hardcoded green dot for active used var(--accent) — this means the dot color changes with theme, which is actually better than hardcoded green.
3. TopBar underline indicator width (60%) is hardcoded — could calculate based on text width, but 60% looks good for both "Terminal" and "Dashboard".

## One thing I'm fixing right now
Nothing critical — the StatusBar no longer has the hardcoded `#3FB950`, now uses `var(--accent)`.

## Concerns
- ThemePicker dropdown z-index (50) should be sufficient, but may need adjustment if overlapping with other elements.
- Click-outside handler uses mousedown — could also need Escape key support.
