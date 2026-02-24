# Task 3.2 — Review

## Three things that could be better
1. The btnHover/btnHoverStyle pattern uses imperative DOM manipulation — could use CSS :hover instead, but inline styles don't support pseudo-selectors
2. The empty state SVG icon is hardcoded — could use a shared icon component, but this is the only place it's used
3. The whileHover on AgentCard uses a hardcoded rgba value — could derive from CSS custom properties, but framer-motion needs literal values

## One thing I'm fixing now
Nothing — all five polish items are implemented cleanly.

## Concerns
- None. The visual polish is additive and doesn't change any functionality.
