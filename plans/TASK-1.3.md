# Task 1.3: Redesign Sidebar + ConversationCard + Preview

## What
- Sidebar: search with icon + focus animation, pinned section with separator, thin themed scrollbar
- ConversationCard: left-border selection (3px accent), hover state with surface-hover bg, staggered animation, pin dot
- Preview: chat bubble style (user right, assistant left), role labels in small caps dim, timestamp monospace, code block bg

## Files changed
- `src/components/Project/Sidebar.jsx`
- `src/components/Project/ConversationCard.jsx`
- `src/components/Project/Preview.jsx`

## Design rules
- Left-border selection indicator (3px solid accent on selected)
- No accent-colored role labels — use var(--dim)
- Resume button is the only accent CTA
- Staggered list animation on ConversationCards

## Verification
- `npx vite build` exits 0
- No hardcoded hex in components

## Risks
- Chat bubble layout may need careful flex/alignment for bidirectional messages
