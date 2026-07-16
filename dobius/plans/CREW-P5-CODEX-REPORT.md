# Crew Phase 5 Codex Report

## Data Sources

- Terminal roster and Live terminal rows use `useDashboardData()` from `src/renderer/src/components/dashboard/useDashboardData.ts`.
- That hook reuses the renderer app store's `repos`, `worktreesByRepo`, `tabsByWorktree`, `agentStatusByPaneKey`, and `migrationUnsupportedByPtyId`, plus the same freshness decay rules as dashboard/sidebar agent rows.
- Terminal status originates in the existing `agentHookServer` pipeline: main sends `agentStatus:set` / `agentStatus:clear`, preload exposes the agent-status snapshot/listeners, and the store-backed dashboard hook maps entries to terminal tabs/worktrees.
- Terminal opening reuses renderer terminal navigation actions: active worktree/view/tab type plus `activateTabAndFocusPane()` for split-pane leaf focus.
- Project picker options come from `useAppStore((state) => state.repos)`.
- Skills picker uses `window.api.skills.discover({ cwd })` and stores selected installed skill names on the custom agent.

## SDK Skills Decision

The installed `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` exposes top-level `Options.skills`.

Evidence:

- `Options` declares `skills?: string[] | 'all'`.
- The declaration text says this enables skills for the main session and accepts exact skill names, directory names, plugin-qualified names, or suffix matches.
- A later core options declaration also documents `skills?: string[]` for the main session.

Decision: selected agent skills are passed directly as `options.skills = agent.skills.length > 0 ? agent.skills : undefined` in `src/main/agents/agent-runner.ts`. No prompt fallback was needed.

## Files

- Shared/main/preload: `src/shared/agents.ts`, `src/main/agents/agent-record-normalization.ts`, `src/main/agents/agents-store.ts`, `src/main/agents/agent-runner.ts`, `src/main/ipc/agents.ts`, `src/preload/api-types.ts`, `src/preload/index.ts`.
- Agents UI: `src/renderer/src/components/agents/AgentsPage.tsx`, `AgentList.tsx`, `AgentDetailHeader.tsx`, `AgentEditForm.tsx`, `agent-page-state.ts`.
- New Agents UI modules: `AgentLivePulse.tsx`, `AgentMissionControlPanel.tsx`, `AgentPageDialogs.tsx`, `AgentSkillsPicker.tsx`, `AgentTerminalAvatar.tsx`, `AgentTerminalDetail.tsx`, `AgentTerminalRoster.tsx`, `AgentWorkingDirectoryPicker.tsx`, `use-agent-terminal-selection.ts`, `use-terminal-agent-rows.ts`.
- Styling: `src/renderer/src/assets/main.css` for the equalizer animation and reduced-motion handling.
- Test fixture update: `src/main/agents/agent-channel-service.test.ts`.

## Verification

- `pnpm exec oxlint <changed files>`: passed.
- `pnpm run typecheck`: passed.
- `pnpm run build:electron-vite`: passed.
- `pnpm exec vitest run src/main/agents/agent-channel-service.test.ts src/main/agents/agent-hard-rails.test.ts`: passed, 10 tests.

Note: commands emit a Node engine warning because this shell is on Node v26 while the repo asks for Node 24.

## Uncertainties

- Live crew doing-text is based on current run/decision summaries available on the Agents page, not a full per-agent historical event feed. Terminal rows show richer hook tool/prompt/assistant status from `agentStatusByPaneKey`.
- `agents:pickDirectory` is local Electron dialog based. Remote/SSH project paths remain selectable from stored repos and manually editable, but native browsing itself is local.
