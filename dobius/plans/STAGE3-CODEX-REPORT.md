# Stage 3 Codex Report

## A. CLI command name: dobius only

- `package.json`
- `config/electron-builder.config.cjs`
- `config/scripts/dobius-dev.mjs` (renamed from `config/scripts/dobius-dev.mjs`)
- `config/scripts/install-dev-cli.mjs`
- `config/scripts/run-electron-vite-dev.mjs`
- `config/scripts/smoke-packaged-cli.mjs`
- `resources/darwin/bin/dobius` (renamed from `resources/darwin/bin/dobius`)
- `resources/linux/bin/dobius` (renamed from `resources/linux/bin/dobius-ide`)
- `resources/linux/packaging/after-install.sh`
- `resources/linux/packaging/after-remove.sh`
- `resources/win32/bin/dobius.cmd` (renamed from `resources/win32/bin/dobius.cmd`)
- `src/cli/handlers/core.ts`
- `src/cli/help.ts`
- `src/cli/index.ts`
- `src/cli/specs/core.ts`
- `src/cli/specs/environment.ts`
- `src/cli/specs/vm.ts`
- `src/main/cli/cli-installer.ts`
- `src/main/cli/linux-bare-dobius-dispatcher.ts`
- `src/main/cli/wsl-cli-installer.ts`
- `src/main/cli/wsl-cli-scripts.ts`
- `src/main/index.ts`
- `src/main/runtime/claude-agent-teams-shim-env.ts`
- `src/main/runtime/orchestration/preamble.ts`
- `src/renderer/src/components/feature-tips/CliFeatureTipVisual.tsx`
- `src/renderer/src/components/settings/CliSection.tsx`
- `src/renderer/src/components/settings/WslCliRegistration.tsx`
- `src/renderer/src/web/web-preload-api.ts`
- `src/shared/dobius-cli-command-name.ts`
- `src/shared/tui-agent-config.ts`

Notes:

- The installed CLI command becomes `dobius` on next CLI install/reinstall.
- The dev CLI command becomes `dobius-dev`.
- The old `dobius` Linux cleanup constant remains only for removing previously managed legacy symlinks.

## B. Repo config file: dobius.yaml only

- `config/scripts/locale-ko-key-overrides.json`
- `src/cli/handlers/vm.ts`
- `src/main/hooks.ts`
- `src/main/ipc/worktree-remote.ts`
- `src/main/ipc/worktrees.ts`
- `src/main/repo-config-yaml.ts`
- `src/main/runtime/dobius-runtime.ts`
- `src/renderer/src/components/NewWorkspaceComposerCard.tsx`
- `src/renderer/src/components/automations/automation-setup-decision.ts`
- `src/renderer/src/components/feature-wall/WorkspacesAnimatedVisual.tsx`
- `src/renderer/src/components/settings/EphemeralVmsPane.tsx`
- `src/renderer/src/components/settings/RepositoryHooksSection.tsx`
- `src/renderer/src/components/settings/RepositoryPane.tsx`
- `src/renderer/src/components/settings/repository-git-hooks-search-entries.ts`
- `src/renderer/src/components/sidebar/DobiusYamlTrustDialog.tsx`
- `src/renderer/src/components/sidebar/SetupScriptPromptCardViews.tsx`
- `src/renderer/src/i18n/locales/en.json`
- `src/renderer/src/i18n/locales/es.json`
- `src/renderer/src/i18n/locales/ja.json`
- `src/renderer/src/i18n/locales/ko.json`
- `src/renderer/src/i18n/locales/zh.json`
- `src/renderer/src/lib/ensure-hooks-confirmed.ts`
- `src/renderer/src/lib/new-workspace.ts`
- `src/shared/ephemeral-vm-recipe-doctor.ts`
- `src/shared/dobius-yaml.ts`
- `src/shared/types.ts`

Notes:

- `REPO_CONFIG_YAML_NAMES` is now `['dobius.yaml']`.
- Existing `dobius.yaml` files stop being read.
- `node config/scripts/verify-localization-catalog.mjs --fix` passed.

## C. Pairing scheme: dobius:// only

- `config/scripts/locale-ja-phrase-fixes.mjs`
- `config/scripts/locale-phrase-fixes.mjs`
- `config/scripts/locale-translation-policy.mjs`
- `src/cli/runtime/client.ts`
- `src/renderer/src/components/settings/RuntimeEnvironmentsPane.tsx`
- `src/renderer/src/components/sidebar/AddRemoteHostFields.tsx`
- `src/renderer/src/web/web-pairing.ts`
- `src/shared/ephemeral-vm-recipe-diagnostics.ts`
- `src/shared/pairing.ts`
- `src/shared/runtime-environment-store.ts`

Notes:

- Pairing parsers now accept `dobius://pair` only.
- Diagnostics redaction now redacts `dobius://pair?code=...`.

## Verification

- `pnpm run typecheck`: passed.
- `pnpm run build:electron-vite`: passed.
- `electron-builder`: not run.
