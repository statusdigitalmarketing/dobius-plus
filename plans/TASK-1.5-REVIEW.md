# Task 1.5 Review — Global animations + skeleton loaders

## Three things that could be better
1. The Skeleton component exports named exports — could add a barrel export, but direct imports are fine for 3 components.
2. The global `button { transition: all 150ms ease }` may affect xterm.js buttons if any — unlikely since xterm uses canvas.
3. Could add @keyframes for a custom shimmer effect instead of Tailwind's animate-pulse for premium feel.

## One thing I'm fixing right now
Nothing — the implementation is clean and minimal.

## Concerns
- The `glass` utility class is defined but not yet used — will be used by ThemePicker dropdown and Build Monitor overlays.
