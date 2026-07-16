# Knowledge Brain Theme Awareness Report

## Palette

| Role | Light theme | Dark theme |
| --- | --- | --- |
| Page background | `#ffffff` with `#f6f8fc` radial base | `#050a1e` with `#0a1230` radial base |
| Dot grid | `rgba(15, 23, 42, 0.14)` | `rgba(125, 249, 255, 0.13)` |
| Chrome ink | `#0f172a` | `#dbeafe` |
| Chrome dim text | `#64748b` | `#5b7bb2` |
| Chrome accent | `#2563eb` | `#7df9ff` |
| Panels | `rgba(255, 255, 255, 0.82)` | `rgba(7, 13, 32, 0.78)` |
| Lines and borders | `rgba(15, 23, 42, 0.12)` | `rgba(125, 249, 255, 0.14)` |
| Node category colors | `KNOWLEDGE_BRAIN_CATS` multiplied by `0.55` | Existing `KNOWLEDGE_BRAIN_CATS` colors |
| Fill points | `0x475569` | `0x4a9fe8` |
| Bright points | `0x1e3a5f` | `0x8ceaff` |
| Mesh lines | `0x94a3b8` | `0xa5e6ff` |
| Fold lines | `0x64748b` | `0xbdf0ff` |
| Fan lines | `0x64748b` | `0x9fe8ff` |
| Link lines | `0x334155` | `0x7df9ff` |
| Selection highlight | `0x0f172a` | `0xffffff` |
| Search highlight | `0x2563eb` | `0xaef4ff` |

## Theme Detection

`KnowledgeBrain.tsx` reads the current app theme from `document.documentElement.classList.contains('dark')`.

A `MutationObserver` watches the root element's `class` attribute. When the app toggles the root `dark` class, React updates local theme state and passes `theme: 'dark' | 'light'` into `createKnowledgeBrainScene`.

The scene-creation effect now depends on `theme`, so a theme change disposes the old WebGL scene and creates a fresh one. The selected node is restored after rebuild so the selected panel and rendered brain stay in sync.

## WebGL Switch

`knowledge-brain-geometry.ts` now accepts a blending mode in `buildPoints()` and `addEdges()`. The default remains `THREE.AdditiveBlending`, preserving existing dark behavior.

Light theme passes `THREE.NormalBlending`; dark theme passes `THREE.AdditiveBlending`.

`makeGlow()` now accepts the theme. Dark mode keeps the existing white-cyan radial sprite. Light mode uses a dark soft radial sprite:

`rgba(12,20,44,1)` -> `rgba(30,52,90,.85)` -> `rgba(60,90,140,.25)` -> transparent.

## CSS Variable Mapping

`.kn-brain` now defines the light theme variables by default:

`--knb-bg`, `--knb-panel`, `--knb-line`, `--knb-ink`, `--knb-dim`, `--knb-accent`, `--knb-dot`, `--knb-base-1`, `--knb-base-2`.

`.dark .kn-brain` overrides those variables with the previous dark palette. The background layers the dot grid first and the base radial gradient second, using a 22px grid.

The HUD, stats, search, results, legend, selected panel, tooltip, footer buttons, and fallback now read from these variables instead of hardcoded dark chrome colors. Two narrow additional variables preserve exact existing dark appearance for panel body copy and the WebGL fallback overlay: `--knb-body` and `--knb-fallback`.

## Files Changed

- `src/renderer/src/components/knowledge/KnowledgeBrain.tsx`
- `src/renderer/src/components/knowledge/knowledge-brain-geometry.ts`
- `src/renderer/src/components/knowledge/knowledge-brain-scene.ts`
- `src/renderer/src/components/knowledge/knowledge.css`
- `plans/KNOWLEDGE-THEME-CODEX-REPORT.md`

## Verification

- `pnpm run typecheck` passed.
- `pnpm run build:electron-vite` passed.
- Confirmed the generated `out/renderer/assets/KnowledgePage-CKLuLSNm.js` bundle includes Three/WebGL symbols including `WebGLRenderer`, `CanvasTexture`, `AdditiveBlending`, and `NormalBlending`.

Both commands emitted the existing engine warning because this shell is running Node `v26.0.0` while the project requests Node `24`.

## Uncertainties

The light-mode brain palette is implemented but not visually inspected in the running app. The dark ink points, normal blending, and dark sprite should make the brain readable on white, but final readability and density still need a human visual pass in Electron light mode.
