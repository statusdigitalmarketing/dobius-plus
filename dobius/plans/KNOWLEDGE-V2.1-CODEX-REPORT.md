# Knowledge v2.1 Density Fix Report

## Files touched

- `src/renderer/src/components/knowledge/KnowledgePage.tsx`
- `src/renderer/src/components/knowledge/knowledge-focus-view.tsx`
- `src/renderer/src/components/knowledge/knowledge-groups-layout.ts`
- `src/renderer/src/components/knowledge/knowledge-overview-layout.ts`
- `src/renderer/src/components/knowledge/knowledge-overview.tsx`
- `src/renderer/src/components/knowledge/knowledge.css`
- `plans/KNOWLEDGE-V2.1-CODEX-REPORT.md`

## Implementation notes

- Overview hubs now sit on a 330-unit ring. Preview dendrites render up to 16 leaves per branch, using deterministic 1/2/3-stem placement with 55-70 unit steps.
- Overview labels are placed 60 units past each branch's outermost preview node. With no active highlight, labels render at full opacity; active carousel/hover highlight colors the active label with `--kn-accent` and dims other labels to 65%.
- Empty branches remain on the ring with hub and label at 45% opacity and sublabel `empty`.
- Fit now uses content bounds with an 8% margin for overview, focus auto-fit, and the Fit button.
- Focus layout now splits the largest groups into extra stems until the target fan count is reached, with first nodes 148-165 units from the hub and a minimum 8 degree turn between consecutive chain segments.

## Acceptance reasoning

- Overview fit uses the actual hub, preview-node, and label bounds instead of `WORLD_SIZE`; the 8% fit margin makes the limiting content dimension occupy about 92.6% of that viewport axis, satisfying the >=70% smaller-axis density target for the mandala-shaped overview bounds.
- A 3-entry Rules branch produces `clamp(3, ceil(3 / 4), 7) = 3` target stems. The single largest group is split until it yields three one-node stems, so the focus view is a fan rather than one chain.
- First focus nodes use a deterministic 148-165 unit first step from the hub, satisfying the <=180px requirement.
- Consecutive focus-chain headings enforce at least an 8 degree change before each subsequent node is placed, preventing three-node collinearity in multi-node stems.
- The focus fit uses hub, node, group-label, and watermark padding bounds with 8% margin, so small branches fill the frame instead of floating in the old 4400-unit world.

## Verification

- `pnpm run typecheck`: exit 0
- `pnpm exec oxlint src/renderer/src/components/knowledge --quiet`: exit 0
- `pnpm run build:electron-vite`: exit 0
