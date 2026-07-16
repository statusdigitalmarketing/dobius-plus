import { mergeTerminalThemeCatalogs } from "./shared";
import { LEGACY_DOBIUS_DARK_TERMINAL_THEMES } from "./legacy-dobius-dark";
import { LEGACY_DOBIUS_LIGHT_TERMINAL_THEMES } from "./legacy-dobius-light";

export const LEGACY_DOBIUS_TERMINAL_THEMES = mergeTerminalThemeCatalogs(
  LEGACY_DOBIUS_DARK_TERMINAL_THEMES,
  LEGACY_DOBIUS_LIGHT_TERMINAL_THEMES,
);
