# CLI Skill Local Install Report

## Rename map

- `skills/dobius-cli` -> `skills/dobius-cli`
- `skills/dobius-emulator` -> `skills/dobius-emulator`
- Constants:
  - `DOBIUS_CLI_SKILL_NAME` -> `DOBIUS_CLI_SKILL_NAME` = `dobius-cli`
  - `DOBIUS_CLI_*` install/update constants -> `DOBIUS_CLI_*`
  - `DOBIUS_CLI_ORCHESTRATION_SKILL_INSTALL_COMMAND` -> `DOBIUS_CLI_ORCHESTRATION_SKILL_INSTALL_COMMAND`
  - `DOBIUS_LINEAR_*` constants -> `DOBIUS_LINEAR_*` while keeping the directory/name `dobius-linear`
- Added `DOBIUS_EMULATOR_SKILL_NAME` = `dobius-emulator`.

## Local install flow

- New main-process module: `src/main/skills/local-skill-installer.ts`.
- IPC:
  - `skills:installBundled` -> `installBundledSkill(skillName)`
  - `skills:isInstalled` -> `isBundledSkillInstalled(skillName)`
- Preload:
  - `window.api.skills.installBundled(skillName)`
  - `window.api.skills.isBundledInstalled(skillName)`
- Source resolution:
  - Packaged app: `path.join(process.resourcesPath, 'skills', skillName)`
  - Dev app: `path.join(app.getAppPath(), 'skills', skillName)`
- Target:
  - `~/.claude/skills/<skillName>/`
- Safety:
  - Skill names are validated against an allowlist before any path construction.
  - Source must be a directory with `SKILL.md`.
  - Copy writes to a temporary sibling, moves any existing install aside, renames the temp directory into place, then removes the backup.
  - No network calls, no `npx`, no `skills` npm CLI.

## Skill bodies rebranded

- Renamed and rewrote:
  - `skills/dobius-cli/SKILL.md`
  - `skills/dobius-emulator/SKILL.md`
- Content-only rebranded where command/product references appeared:
  - `skills/orchestration/SKILL.md`
  - `skills/computer-use/SKILL.md`
  - `skills/dobius-linear/SKILL.md`
  - `skills/linear-tickets/SKILL.md`
  - `skills/dobius-emulator-android/SKILL.md`
  - `skills/dobius-per-workspace-env/SKILL.md`
- Final targeted grep found no `statusdigitalmarketing/dobius-plus` references and no skill docs teaching `dobius ...` command invocations.

## Packaging

- Added `skills` to shared electron-builder `extraResources`:
  - `from: 'skills'`
  - `to: 'skills'`
- `skills/` remains excluded from `app.asar`, so packaged installs read real files from `process.resourcesPath/skills`.

## Consumers updated

- Shared command constants: `src/shared/agent-feature-install-commands.ts`
- Renderer re-export: `src/renderer/src/lib/agent-feature-install-commands.ts`
- Install panels/actions updated to call `window.api.skills.installBundled(...)`:
  - `CliAgentSkillSetup.tsx`
  - `CliSection.tsx`
  - `BrowserUsePane.tsx`
  - `BrowserUseSkillStep.tsx`
  - `BrowserUseSkillSetupCard.tsx`
  - `MobileEmulatorAgentControlRow.tsx`
  - `MobileEmulatorAgentSetupGuideSteps.tsx`
  - `OrchestrationPane.tsx`
  - `OrchestrationSetupCard.tsx`
  - `FloatingTerminalOrchestrationDialog.tsx`
  - `ComputerUseSkillSetupPanel.tsx`
  - `EphemeralVmsPane.tsx`
  - `LinearAgentSkillSetupPrompt.tsx`
  - `LinearAgentSkillSetupDialog.tsx`
  - `CliSkillSetupTerminal.tsx`
- Skill detection references updated to `dobius-cli` in:
  - browser-use setup/status
  - feature-wall setup/status
  - mobile emulator setup state
  - onboarding feature setup
  - setup-guide progress

## Verification

- `pnpm exec oxlint <all changed ts/tsx/cjs files>`: passed.
- `pnpm exec vitest run -c config/vitest.config.ts src/main/skills/local-skill-installer.test.ts src/main/ipc/skills.test.ts src/renderer/src/components/settings/AgentSkillSetupPanel.test.tsx src/shared/agent-feature-install-commands.test.ts`: passed, 25 tests.
- `pnpm exec vitest run -c config/vitest.config.ts src/renderer/src/components/sidebar/LinearAgentSkillSetupPrompt.test.tsx src/renderer/src/components/sidebar/LinearAgentSkillSetupPrompt.update-command.test.tsx src/renderer/src/components/settings/CliSection.test.tsx src/renderer/src/components/settings/BrowserUseSkillStep.test.tsx src/renderer/src/components/settings/OrchestrationPane.test.tsx src/renderer/src/components/onboarding/onboarding-feature-setup.test.ts`: passed, 43 tests.
- `pnpm run typecheck`: passed. Note: pnpm emitted the existing engine warning because this shell uses Node v26 while the repo requests Node 24.
- `pnpm run build:electron-vite`: passed. Note: Vite emitted existing dynamic/static import chunking warnings and the same Node engine warning.

## Uncertainties

- The local bundled installer targets the host user's `~/.claude/skills`, matching the requested install path and the npm `skills --global` on-disk shape. Existing WSL/remote runtime setup UI can still show runtime-specific discovery state; this change does not add a separate WSL-home or SSH-home copy path.
- The legacy Linear skill directory remains `dobius-linear` by request. Its body now teaches `dobius linear ...`, but the skill name is intentionally unchanged for compatibility.
