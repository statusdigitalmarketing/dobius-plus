# Knowledge Brain Codex Report

## Mapping

- Source data stays renderer-only and uses the existing `useKnowledgeTree()` hook.
- `buildKnowledgeBrainGraph(tree)` flattens every `KnowledgeBranch.leaves` entry into one interactive node:
  - `id`: `leaf.id`
  - `label`: `leaf.title`
  - `desc`: `leaf.summary`
  - `cat`: stable branch id
  - `icon`, `addedAt`, and the original `leaf` are preserved for detail-sheet handoff.
- Categories are the seven stable branch ids: `learned`, `skills`, `memory`, `lessons`, `docs`, `rules`, `projects`.
- Primary edges come from `leaf.links` after resolving both endpoint ids into visible nodes. Dangling ids are dropped.
- Secondary edges come from `KnowledgeGroup.leafIds` within each branch by linking adjacent visible leaves in the group. This keeps clusters without connecting every same-branch node.

## Cap Handling

- Interactive nodes are capped at `400` via `KNOWLEDGE_BRAIN_NODE_CAP`.
- The graph returns `hiddenCount` and `totalLeafCount`; the HUD shows `+N more capped` when the cap is active.
- The cap is intentionally visible in UI and in code, so entries are not silently dropped.

## KnowledgePage Integration

- `KnowledgePage.tsx` now keeps only page chrome, entry/new counts, load/error state, and the existing `KnowledgeDetailSheet` flow.
- The old 2D overview render path was replaced with:
  - `KnowledgeBrain tree={tree} newLeafIds={newLeafIds} onSelectLeaf={openLeaf}`
- Node click, search result click, and connected-node click all call the same `openLeaf` path, which still uses `window.api.knowledge.read(filePath)` lazily.
- No main-process indexer or IPC code changed.

## Three.js Scene

- `KnowledgeBrain.tsx` owns React state, HUD/search/panel/tooltip UI, and WebGL fallback.
- `knowledge-brain-scene.ts` owns Three renderer lifecycle, drag rotation, wheel zoom, raycast hover/click, search highlighting, reset, and spin toggling.
- `knowledge-brain-geometry.ts` ports the reference brain field, shell sampling, filler cloud, folds, stem, ambient mesh, glow texture, point cloud, and line helpers.
- The scene uses bundled `three` through `import * as THREE from 'three'`.

## Disposal Proof

- On unmount, `scene.dispose()`:
  - cancels the animation frame,
  - disconnects the `ResizeObserver`,
  - removes canvas pointer and wheel listeners,
  - clears hover state,
  - traverses the brain group and disposes geometries/materials,
  - disposes the glow texture,
  - disposes the `WebGLRenderer`.
- Highlight lines are also removed and disposed whenever selection repaint rebuilds them.

## Files Added

- `src/renderer/src/components/knowledge/KnowledgeBrain.tsx`
- `src/renderer/src/components/knowledge/knowledge-brain-graph.ts`
- `src/renderer/src/components/knowledge/knowledge-brain-graph.test.ts`
- `src/renderer/src/components/knowledge/knowledge-brain-geometry.ts`
- `src/renderer/src/components/knowledge/knowledge-brain-scene.ts`

## Files Changed

- `src/renderer/src/components/knowledge/KnowledgePage.tsx`
- `src/renderer/src/components/knowledge/knowledge.css`
- `plans/KNOWLEDGE-BRAIN-CODEX-REPORT.md`

## Verification

- `pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/components/knowledge/knowledge-brain-graph.test.ts`
  - Pass: 1 file, 2 tests.
- `pnpm run typecheck`
  - Pass.
  - Note: pnpm printed the existing engine warning because the shell is using Node v26 while `package.json` wants Node 24.
- `pnpm exec oxlint ...knowledge brain files...`
  - Pass.
- `pnpm run build:electron-vite`
  - Pass.
  - Renderer output included `out/renderer/assets/KnowledgePage-DBx0DZtQ.js`.
- Bundle grep:
  - Found `3D knowledge brain graph` and WebGL fallback text in the KnowledgePage bundle.
  - Found Three renderer/raycast/points classes in the KnowledgePage bundle.

## Uncertainties

- Performance should be acceptable at the 400 interactive-node cap, but the ambient mesh still does an O(n²) neighbor pass over interactive plus filler points during scene build. It may need profiling on older GPUs or remote desktop sessions.
- The brain silhouette matches the reference geometry, but real data distributions can vary. With very low node counts, the filler shell carries the brain shape while the real category nodes may read more sparse.
- Search currently focuses and highlights the first match while listing up to eight results. That matches the reference behavior closely, but broader keyboard navigation could be added later.
