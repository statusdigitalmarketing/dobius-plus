# Task 1.3 Review — Redesign Sidebar + ConversationCard + Preview

## Three things that could be better
1. ConversationCard uses onMouseEnter/onMouseLeave for hover — could use CSS :hover with a CSS class instead, but inline styles prevent that with CSS variables.
2. The staggered animation uses 0.03s delay — shorter than the 0.05s on ProjectCard, but OK since sidebar items are smaller.
3. Preview chat bubbles use maxWidth: '90%' — could look odd with very short messages. Acceptable tradeoff for layout consistency.

## One thing I'm fixing right now
Nothing critical found — implementation follows all design rules. No hardcoded hex colors.

## Concerns
- The hover effect on ConversationCard (onMouseEnter/Leave) won't work on touch devices — acceptable since this is a desktop app.
- AnimatePresence on large lists (100+ sessions) may impact performance — useSessions already limits to 100 items.
