# TASK — Auto-detect the web root for the Visual preview server

## What
Make the Visual preview's local server serve the folder that actually contains
`index.html`, instead of always serving the project root. This lets ANY website
project (not just Pocket Cologne) preview locally with the existing Local/Live
toggle — edit locally, see it on the Local side, then push to Live separately.

## Why
The Visual feature already spins the local live-reload server up on open and
tears it down on close, with a Local/Live toggle. But it serves the project
ROOT as the web root. Sites whose files live in a subfolder (e.g. Pocket
Cologne's `website/`, common `public/`, `dist/`) and use absolute asset paths
like `/css/app.css` 404 on every asset, so the Local preview looks broken.
Carson wants the local-edit-before-live loop to work for every website he opens
in Dobius+, with zero per-project setup.

## How
Single file: `electron/visual-server.js`.

1. Add `resolveWebRoot(projectPath)`:
   - If `projectPath/index.html` exists -> return projectPath (unchanged
     behavior for every project that already has index.html at root).
   - Else check an ordered candidate list of subfolders for `index.html`:
     `website, public, site, www, docs, dist, build, out`. Return the first
     `path.join(projectPath, sub)` that contains `index.html`.
   - Else fall back to projectPath.
2. Store resolved root in a module-level `_webRoot`. Keep `_projectPath` as the
   original project path (so getVisualProjectPath stays meaningful).
3. Use `_webRoot` everywhere the server reads files:
   - the HTML-injection middleware (`path.join`)
   - `express.static(...)`
   - the chokidar watcher (so edits under the real web root trigger reload)
   - `listVisualPages()` walk (so the page dropdown lists real pages)

No new UI, no new config, no IPC changes. Other projects with a root
`index.html` (dobius-plus included) hit the unchanged path.

## Live side (no code)
User sets the production URL once per project via the existing Visual UI:
Live -> "+ URL" -> e.g. https://pocketcologne.com. Persists in
config.projects[path].visualProdUrl.

## Test
1. `npm run build` exits 0.
2. `npm run electron:dev`; open a project window whose site is in a subfolder
   (pocket-cologne -> website/):
   - Click Visual. Local phone renders index.html with CSS/fonts/images, no 404s.
   - Edit a file under website/ -> phone auto-reloads.
   - Page dropdown lists the site's pages.
   - Toggle Live + set prod URL -> production loads.
3. Regression: open dobius-plus itself (index.html at root) in Visual -> still
   serves the root exactly as before.
4. Screenshot from a fresh window as proof.

## Risks
- A candidate subfolder list could mis-detect a stale `dist/` over a source dir.
  Mitigation: root `index.html` always wins first; `website/public/site` are
  ahead of `dist/build/out` in priority; only used when root has no index.html
  (which today serves nothing useful anyway).

## Estimate
~30 min incl. build + review.

## Scope guard
LOCAL ONLY. No push, no PR, no deploy, no GitHub. Commit stays on the local
feature branch until Carson says otherwise.
