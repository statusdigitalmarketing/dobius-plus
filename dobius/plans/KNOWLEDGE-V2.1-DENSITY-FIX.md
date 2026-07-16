# Knowledge v2.1 — density + composition fixes

Screenshots of the running app vs the reference show v2's layout math was tuned
for a 137-node catalog; our branches have 3–60 entries, so the map reads sparse,
gappy, and dim. Fix the geometry so ANY entry count composes densely. All work in
`src/renderer/src/components/knowledge/` (+ CSS). No data-model changes.

## 1. Overview must compose as a tight mandala (worst problem)

Current: hubs far from center, 6-dot previews, giant empty world, labels nearly
invisible. Target (like the reference): hubs on a snug ring around the burst,
each sector FILLED by its preview dendrites, labels bright.

- Hub ring radius: ~330 world units from center (burst radius ~150).
- Preview constellations: up to 16 leaves per branch (not 6–9). 2–3 stems per
  hub, stems leave the hub outward AND sideways, step 55–70px, so dendrites fill
  the annulus from ~380 to ~700. Branch with n<4 leaves: n single-node stems.
- Department labels: just past each branch's outermost preview node (~+60),
  full-opacity ivory serif as the DEFAULT state. Carousel highlight = active
  label in `--kn-accent` + others at 65% opacity — NEVER the current
  everything-faint state when no highlight is active.
- Empty branch (0 leaves): hub + label at 45% opacity with sublabel `empty` —
  still on the ring.

## 2. Fit must frame content, not the world constant

`fitViewFor` currently fits WORLD_SIZE, leaving an ocean of margin. Replace with
fit-to-content: compute the bounding box of everything actually placed (hubs,
preview extents, labels; in focus view: hub, nodes, group labels, watermark
padding) and fit THAT + 8% margin. Applies to initial overview fit, the Fit
button, and the auto-fit when entering a focus view.

## 3. Focus view: always a fan, never a stick

Current: Rules (3 items) renders one vertical 3-node chain starting ~400px above
the hub. Target: the reference's multi-stem fan regardless of count.

- First node of every stem starts 140–170px from the hub (kill the dead gap).
- Stem count = clamp(3, ceil(totalLeaves / 4), 7). When the branch has fewer
  groups than that, SPLIT the largest groups' chains into extra stems; a 3-item
  branch = 3 stems of 1, fanned.
- Stems spread across a 170–200° arc opening upward from the bottom-anchored
  hub, mirrored around vertical. Chain wobble stays as spec'd, but consecutive
  segments must not be collinear: enforce a minimum 8° heading change per step.
- Group labels sit past the outermost node of their stems (unchanged rule).
- Focus entry auto-fits per §2 so a 3-node branch fills the frame with big
  nodes rather than floating in the void.

## Acceptance (verify by reasoning through the math, then build)

- At overview fit, placed content spans ≥70% of the viewport's smaller axis.
- Rules branch (3 entries) in focus: 3 stems off the hub, first nodes ≤180px
  away, no 3 collinear nodes, content fills ≥60% of the frame at auto-fit.
- Overview with no carousel highlight: all 7 labels at full opacity.
- `pnpm run typecheck`, knowledge-scope oxlint, and `pnpm run build:electron-vite`
  all exit 0. No new dependencies. max-lines respected.

Report to plans/KNOWLEDGE-V2.1-CODEX-REPORT.md (files touched + verification exits).
Do NOT commit. Do not touch agents/imessage/crew files.
