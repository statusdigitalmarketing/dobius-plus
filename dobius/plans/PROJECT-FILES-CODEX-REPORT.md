# Project Files Settings Report

## Scope

Added per-project settings UI and IPC for editing project-root agent context files:

- `CLAUDE.md`
- `AGENTS.md`
- `HANDOFF.md`
- `BUILD-LOG.md`
- `.claude/rules/<name>.md` where `<name>` matches `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`

No `knowledge/*` files were read or edited.

## IPC Surface

Preload exposes `window.api.projectFiles`:

- `list(repoId)` -> `{ rootFiles, ruleFiles }`
- `read(repoId, name)` -> `{ name, content, exists }`
- `write(repoId, name, content)` -> `{ name, size }`
- `delete(repoId, name)` -> `{ name }`

Main registration is in `src/main/ipc/register-core-handlers.ts` via
`registerProjectFilesHandlers(store)`.

## Allowlist And Containment Proof

`src/main/ipc/project-files.ts` accepts only a `repoId`, never a renderer-provided repo path.
Each handler resolves the repo from `store.getRepos()` and rejects unknown IDs.

File names are normalized through `normalizeProjectFileName()`:

- exact root-file allowlist for the four root files
- `.claude/rules/<name>.md` only when `<name>` matches the rule-name regex
- no `..`, slashes inside rule names, absolute paths, or alternate extensions

Path confinement:

- `repo.path` is resolved and `realpath`ed.
- target path is built from the real repo path plus the allowlisted relative file name.
- target path must equal the repo real path or start with `repoRealPath + path.sep`.
- existing target files are `realpath`ed before read/write/delete to reject symlink escapes.
- writes check the nearest existing ancestor before `mkdir`, then check the final parent and temp
  file real paths before atomic `rename`.
- writes use temp-file plus rename and create parent directories only after ancestor containment.

The symlink escape test covers a repo where `.claude` points outside the repo; write is rejected
before creating `.claude/rules` through the symlink.

## Renderer Placement

`RepositoryInstructionsSection` is added to `RepositoryPane` after the identity block and before
hooks/source-control/MCP-related sections. Search metadata is added to `repository-search.ts` so
queries like `AGENTS.md`, `CLAUDE.md`, `instructions`, and `rules` reveal the section.

The UI lists the four root files with present/absent state, lazy-loads file contents only when
editing, supports Save, and offers Create for `CLAUDE.md` and `AGENTS.md`. It also lists existing
`.claude/rules/*.md` files with edit/delete and provides a compact Add rule input.

## Files Changed

- `src/shared/project-files.ts`
- `src/main/ipc/project-files.ts`
- `src/main/ipc/project-files.test.ts`
- `src/main/ipc/register-core-handlers.ts`
- `src/preload/index.ts`
- `src/preload/api-types.ts`
- `src/renderer/src/components/settings/RepositoryInstructionsSection.tsx`
- `src/renderer/src/components/settings/ProjectInstructionFileRow.tsx`
- `src/renderer/src/components/settings/project-instruction-templates.ts`
- `src/renderer/src/components/settings/RepositoryPane.tsx`
- `src/renderer/src/components/settings/repository-search.ts`

## Verification

- `pnpm exec oxlint <changed files>`: pass
- `pnpm exec vitest run src/main/ipc/project-files.test.ts`: pass, 5 tests
- `pnpm run typecheck`: pass
- `pnpm run build:electron-vite`: pass

Notes: commands emitted the existing Node engine warning because this shell is on Node v26 while
the repo requests Node 24. The build also emitted existing Vite dynamic/static import chunking
warnings.

## Uncertainties

- The section uses a native styled `textarea` because this repo does not currently provide a
shadcn textarea primitive.
- Root-file delete is supported by IPC but intentionally not exposed in this first UI pass; only
rule files have a delete affordance.
