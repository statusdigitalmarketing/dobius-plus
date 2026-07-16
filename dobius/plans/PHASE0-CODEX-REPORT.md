# Phase 0 Asana Config Report

## Files created

- `src/shared/asana.ts`
- `src/main/asana/asana-config.ts`
- `src/main/asana/asana-config.test.ts`
- `src/main/asana/asana-token-store.ts`
- `src/main/ipc/asana.ts`
- `src/renderer/src/components/settings/AsanaPane.tsx`
- `src/renderer/src/components/settings/asana-search.ts`

## Files modified

- `src/main/ipc/register-core-handlers.ts`
- `src/preload/index.ts`
- `src/preload/api-types.ts`
- `src/renderer/src/components/settings/Settings.tsx`
- `src/renderer/src/hooks/useSettingsNavigationMetadata.ts`
- `src/renderer/src/lib/settings-navigation-types.ts`
- `src/renderer/src/i18n/locales/en.json`
- `src/renderer/src/i18n/locales/es.json`
- `src/renderer/src/i18n/locales/ja.json`
- `src/renderer/src/i18n/locales/ko.json`
- `src/renderer/src/i18n/locales/zh.json`

## IPC channels

- `asana:getConfig`
- `asana:updateConfig`
- `asana:setToken`
- `asana:hasToken`
- `asana:clearToken`

No handler returns the raw Asana PAT. The renderer only receives `hasToken: boolean` for token state.

## Settings

- Section id: `automation`
- Section title: `Automation`
- Desktop-gated with `showDesktopOnlySettings`

## Localization keys added

- `auto.components.settings.Settings.automationTitle`
- `auto.components.settings.Settings.automationDescription`
- `auto.hooks.useSettingsNavigationMetadata.automationTitle`
- `auto.hooks.useSettingsNavigationMetadata.automationDescription`
- `auto.components.settings.AsanaPane.tokenRequired`
- `auto.components.settings.AsanaPane.tokenSet`
- `auto.components.settings.AsanaPane.tokenCleared`
- `auto.components.settings.AsanaPane.tokenLabel`
- `auto.components.settings.AsanaPane.tokenStatusSet`
- `auto.components.settings.AsanaPane.tokenStatusNotSet`
- `auto.components.settings.AsanaPane.tokenPlaceholder`
- `auto.components.settings.AsanaPane.setTokenButton`
- `auto.components.settings.AsanaPane.clearTokenButton`
- `auto.components.settings.AsanaPane.buildLaneLabel`
- `auto.components.settings.AsanaPane.buildLaneDescription`
- `auto.components.settings.AsanaPane.reviewLaneLabel`
- `auto.components.settings.AsanaPane.reviewLaneDescription`
- `auto.components.settings.AsanaPane.autoModeLabel`
- `auto.components.settings.AsanaPane.autoModeDescription`
- `auto.components.settings.AsanaPane.autoModeAriaLabel`
- `auto.components.settings.asana.search.title`
- `auto.components.settings.asana.search.description`

Ran `node config/scripts/verify-localization-catalog.mjs --fix`; it repaired parity for all five locale files.

## Verification

- `pnpm exec vitest run --config config/vitest.config.ts src/main/asana/asana-config.test.ts`: passed
- `pnpm run typecheck`: passed
- `pnpm run build:electron-vite`: passed

Both pnpm commands emitted the existing Node engine warning because this shell uses Node v26.0.0 while `package.json` requests Node 24.

## Notes

- Asana config is stored only in `app.getPath('userData')/asana-config.json`.
- The Asana PAT is stored only in `~/.dobius/asana-token.enc`, or plaintext in that same file only when `safeStorage.isEncryptionAvailable()` is false, matching the OpenAI speech token store fallback.
- No Asana HTTP calls, polling, Tasks panel, push channel, or auto-mode behavior were added in Phase 0.
