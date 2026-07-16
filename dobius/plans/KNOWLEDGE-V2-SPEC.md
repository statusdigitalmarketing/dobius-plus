# Knowledge v2 — "The Brain" (SkillTree-class map)

Upgrade the existing Knowledge tab (commit 0371e4a: `src/renderer/src/components/knowledge/`, `src/main/ipc/knowledge.ts`, `src/shared/knowledge.ts`) from a flat radial dot-map into a two-level, icon-node constellation map with a department focus view, a rich detail sheet, and live updates. Design reference is skilltree.altari.ai's live map; this spec describes every visual element in words — follow it, do not guess extra chrome.

## Visual language (applies everywhere)

- Background: near-black (`--kn-bg`) with TWO subtle layers: (1) the existing starfield canvas, (2) a faint dot-grid (2px dots every ~28px at ~4% ivory opacity — CSS radial-gradient background-image is fine).
- Nodes are NO LONGER bare dots. A node is a filled ivory circle (`--kn-ivory`, ~46px in focus view, ~26px in overview) containing a dark line-art lucide icon (~55% of circle size, stroke ~1.6, color near `--kn-bg`). Selected/hover: ring in the branch color + soft glow.
- Satellite dots: a node with outbound links gets 1–3 small (7px) branch-colored dots floating at the end of a short (14–20px) thin line off the node's rim, at deterministic angles (hash of id). Purely informational: satellites = min(3, links.length).
- Edges: thin (1.1px) lines at ~30% branch color. Within a group, nodes CHAIN: group hub → node1 → node2 → ... (a bent constellation path), NOT a star of spokes. Only group-anchor nodes connect back toward the branch hub. Chain algorithm (deterministic, no randomness at render time): start at the group's anchor angle; each next node steps 78–96px (step = 78 + hash%18) with heading = previous heading + wobble, where wobble = ((hash>>4)%40 − 20)° CLAMPED so total heading stays within ±35° of the group's outward radial direction; every 4th node branches a 1–2 node side-twig at +55° or −55°. After placement, one collision pass: any two nodes closer than 54px → push the later node 30px further along its heading. This is what makes it read as dendrites instead of spaghetti.
- Serif display type: existing `--kn-serif` stack, uppercase, wide tracking (0.25–0.3em) for all department names and group labels.
- All colors via the existing `--kn-*` variables in knowledge.css. Extend that palette only inside `.kn-page` scope. Never hardcode hex in TSX.
- Respect `prefers-reduced-motion`: all entrance/pulse animations become none.

## Data model (extend, don't rewrite)

`src/shared/knowledge.ts`:
- `KnowledgeLeaf` += `icon: string` (lucide icon name), `links: string[]` (ids of other leaves), `addedAt: number` (file mtime ms).
- New `KnowledgeGroup = { id, label, leafIds: string[] }`.
- `KnowledgeBranch` += `groups: KnowledgeGroup[]` (every leaf belongs to exactly one group).

`src/main/ipc/knowledge.ts`:
- Grouping: skills/learned → by name-prefix family before the first `-` when ≥2 leaves share it (e.g. `higgsfield-*`, `ponytail-*`, `writing-*`). memory → by project folder name. lessons/projects → by repo name. docs → by first-level subfolder. rules → single group `house rules`. HARD CAP: max 6 groups per branch — keep the 5 largest, merge everything else (and all singletons) into one group labeled `assorted`. Never render a wall of tiny group labels.
- Icons: deterministic keyword→lucide map (e.g. mail→`mail`, git/commit→`git-branch`, test→`flask-conical`, deploy/ship→`rocket`, review/audit→`search-check`, memory→`database`, rule→`scale`, doc→`file-text`, skill default→`sparkles`, learned default→`graduation-cap`); fallback: pick from a curated 12-icon list by id hash. Store the NAME; renderer maps name→component via one lookup module.
- Links: parse each markdown body for `[[wiki-links]]` and bare mentions of other leaf slugs; resolve to leaf ids (skip self/unresolved).
- Live: `knowledge:watch` handler starts `fs.watch` (recursive where supported) on `~/.claude/skills` and each `~/.claude/projects/*/memory`; debounce 1.5s; on change `webContents.send('knowledge:changed')`. Preload: `knowledge.onChanged(cb)` returning unsubscribe, typed in api-types. Guard: start watchers once, dispose on app quit.

## View 1 — Overview (the ring)

Matches the reference overview: seven branch hubs evenly on a ring around the center.
- Branch hub: 44px circle, transparent fill, 1.5px ring in branch color, containing a small abstract glyph (use the branch's default lucide icon at 16px in branch color).
- Department label: OUTSIDE the ring (further from center than the hub, along the hub's angle): serif uppercase ~26px, with a ~10px sublabel underneath (existing `sub` text) in `--kn-faint`.
- Around each hub, a PREVIEW constellation: the first ~6–9 leaves as small (18px) ivory icon-less dots chained outward — enough to give the dendrite silhouette without labels.
- Center: particle burst — a static canvas scatter of tiny (1–2.5px) dots in ALL seven branch colors + ivory, gaussian-clustered within ~130px radius, plus faint 1px lines connecting random near pairs. Particle count SCALES with the brain: `120 + totalEntries * 2` (cap 900), line count = particles/12. The brain visibly densifies as knowledge grows. No text in the center; the burst IS the brain.
- Bottom center: left/right chevron buttons that rotate a "highlighted" department (its label brightens, others dim slightly); clicking the highlighted label or any hub ENTERS focus view for that branch.
- Top bar (keep existing back/search); top-right counter: `{total} ENTRIES · {recent} NEW THIS WEEK` (recent = addedAt within 7 days) in small caps, recent number in `--kn-accent`.

## View 2 — Focus (one department)

Transition: do NOT attempt a continuous shared-element pan/zoom between the two views (the reference itself uses separate pages). Crossfade-scale: overview scales 1→1.15 while fading out, focus view fades in from scale 0.92, 350ms ease-out, skipped entirely under reduced-motion. Per-branch layout:
- The branch hub sits bottom-center (like the reference's DEALS view): 64px circle, branch-color ring, icon inside; serif name + sublabel BELOW it.
- Behind the cluster: a giant ghost watermark of the branch name — serif uppercase at ~340px, ivory at 3% opacity, centered in the cluster area, non-interactive.
- Groups fan out upward/outward from the hub in a 200° arc: each group has a small-caps label `{LABEL}` with `{n} ITEMS` beneath (10px, `--kn-faint`), positioned past its outermost node.
- Within a group: chained icon nodes (46px) as described above; node labels (11px ivory-dim, max 2 lines) appear under each node when zoom ≥ ~0.55, hidden below that.
- The newest leaf overall (max addedAt) in the branch gets a small `LATEST` tag in `--kn-accent` small-caps above its node (the reference's "START HERE" treatment).
- Edge navigation: vertical (writing-mode) serif names of the previous/next department on the left/right screen edges with chevrons; clicking hops directly to that branch's focus view. Top-left under the topbar: `‹ ALL DEPARTMENTS` text button → back to overview.
- Pan/zoom/search keep working in both views (search in focus view dims non-matching nodes as today).

## Detail sheet (replaces current reader panel)

Right-side sheet (~440px), opened on node click, structured like the reference job card:
1. Eyebrow: branch label small-caps in branch color (e.g. `MEMORY`, `HOUSE RULE`) — EXCEPT learned skills, whose eyebrow reads `MINTED FROM FAILURE`: provenance is the point of that branch.
2. Title (serif, ~26px) + close X.
3. Category path line: `{Branch} · {Group}` in `--kn-ivory-dim`.
4. Summary paragraph (existing `summary`).
5. A bordered row: file icon + `lives on disk` + the basename, with a **Reveal** button using the same mechanism SkillsPage's "Reveal file" uses (find and reuse that IPC — do not invent a new one).
6. `LINKS TO` chip row (only if links exist): bordered chips with the linked leaf's title; clicking a chip navigates the map to that leaf (enter its branch focus, select it).
7. `THE CONTENT` divider, then the rendered markdown (existing react-markdown setup and `.kn-reader-body` styles).
Scrollable; keyboard Esc closes.

## Live updates

On `knowledge:changed`: refetch tree, diff leaf ids against previous. New ids: animate in (scale 0→1 + glow pulse ~1.2s) and increment the top-right counter. Removed ids: fade out. Keep selection if its id survives.

## Constraints

- No new dependencies. lucide-react, react-markdown, remark-gfm only.
- oxlint max-lines applies (components 300/400 tiers) — split into focused modules under `components/knowledge/`: e.g. `knowledge-icons.ts`, `knowledge-groups-layout.ts`, `knowledge-overview.tsx`, `knowledge-focus-view.tsx`, `knowledge-detail-sheet.tsx`, `use-knowledge-tree.ts`. No `helpers.ts`/`utils.ts` names (AGENTS.md).
- `pnpm run typecheck` and `pnpm exec oxlint src/renderer/src/components/knowledge src/main/ipc/knowledge.ts` must exit 0.
- Do not touch any `agents/*`, crew, or terminal code. Do not commit.
