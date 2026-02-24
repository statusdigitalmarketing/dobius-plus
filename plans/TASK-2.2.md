# Task 2.2: Create Expandable Memory Panel in AgentCard

## What
- Add Memory button to AgentCard action bar
- Expandable panel with AnimatePresence for smooth transitions
- Three sections: Context (editable textarea), Journal (scrollable list), Experience (list with add/remove)
- Clear Memory button with confirmation dialog

## Why
Users need to view and edit agent memory directly from the agent card.

## Verification
- `npx vite build` exits 0

## Risks
- AnimatePresence height animation could cause layout shift — mitigated by layout animation on card
