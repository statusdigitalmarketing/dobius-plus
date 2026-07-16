import type { ITheme } from '@xterm/xterm'

import { LEGACY_DOBIUS_TERMINAL_THEMES } from './terminal-themes/legacy-dobius'

// The app-wide "skin" recolors the whole UI chrome (sidebars, panels, cards,
// inputs, buttons) — not just the terminal. Each skin is one of the ported
// legacy Dobius+ palettes; we derive the app's semantic tokens from its
// background/foreground/accent colors so the entire interface matches.

export const APP_SKIN_NONE = 'none'

/** Names shown in the App Skin picker, in catalog order. */
export const APP_SKIN_NAMES: readonly string[] = Object.keys(LEGACY_DOBIUS_TERMINAL_THEMES)

/** Blend two #RRGGBB hex colors; amount 0 = a, 1 = b. */
function mixColor(a: string, b: string, amount: number): string {
  const parse = (h: string): [number, number, number] => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16)
  ]
  const [r1, g1, b1] = parse(a)
  const [r2, g2, b2] = parse(b)
  const ch = (x: number, y: number): string =>
    Math.round(x + (y - x) * amount)
      .toString(16)
      .padStart(2, '0')
  return `#${ch(r1, r2)}${ch(g1, g2)}${ch(b1, b2)}`
}

/** Perceived luminance (BT.601), 0-255. Above ~140 reads as a light surface. */
function isLightBackground(hex: string): boolean {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return 0.299 * r + 0.587 * g + 0.114 * b > 140
}

/**
 * Map a skin's palette onto the app's core surface/text/accent tokens. Reads
 * ITheme keys: background, foreground, blue (accent1), red (accent4). Surfaces
 * lift the background toward the foreground so panels stay legible on both dark
 * and light skins.
 */
function deriveAppSkinTokens(theme: ITheme): Record<string, string> {
  const bg = theme.background ?? '#0a0a0a'
  const fg = theme.foreground ?? '#fafafa'
  const accent = theme.blue ?? fg // accent1
  const danger = theme.red ?? '#e40014' // accent4
  const lift = (amount: number): string => mixColor(bg, fg, amount)
  const hairline = `${fg}22` // ~13% foreground — border/input lines

  return {
    '--background': bg,
    '--editor-surface': bg,
    '--foreground': fg,
    '--card': lift(0.03),
    '--card-foreground': fg,
    '--popover': lift(0.03),
    '--popover-foreground': fg,
    '--primary': accent,
    '--primary-foreground': bg,
    '--secondary': lift(0.07),
    '--secondary-foreground': fg,
    '--muted': lift(0.07),
    '--muted-foreground': lift(0.55),
    '--accent': lift(0.1),
    '--accent-foreground': fg,
    '--destructive': danger,
    '--border': hairline,
    '--input': hairline,
    '--ring': accent,
    '--sidebar': lift(0.02),
    '--sidebar-foreground': fg,
    '--sidebar-primary': accent,
    '--sidebar-primary-foreground': bg,
    '--sidebar-accent': lift(0.07),
    '--sidebar-accent-foreground': fg,
    '--sidebar-border': hairline,
    '--sidebar-ring': accent,
    '--worktree-sidebar': lift(0.05),
    '--worktree-sidebar-foreground': fg,
    '--worktree-sidebar-accent': lift(0.09),
    '--worktree-sidebar-accent-foreground': fg,
    '--worktree-sidebar-border': hairline,
    '--worktree-sidebar-ring': accent
  }
}

const SKIN_TOKEN_KEYS = Object.keys(deriveAppSkinTokens({ background: '#000', foreground: '#fff' }))

/**
 * Apply a skin app-wide by setting its derived tokens as inline custom
 * properties on the root element (inline wins over the stylesheet's :root/.dark
 * defaults). Also owns the dark/light class so the app's many `.dark …`
 * overrides render correctly for the skin's brightness. Pass APP_SKIN_NONE (or
 * an unknown name) to clear the skin and fall back to the stylesheet theme.
 */
export function applyAppSkin(
  skinName: string | undefined,
  root: HTMLElement = document.documentElement
): void {
  const theme = skinName && skinName !== APP_SKIN_NONE ? LEGACY_DOBIUS_TERMINAL_THEMES[skinName] : null

  if (!theme) {
    for (const key of SKIN_TOKEN_KEYS) {
      root.style.removeProperty(key)
    }
    return
  }

  const tokens = deriveAppSkinTokens(theme)
  for (const [key, value] of Object.entries(tokens)) {
    root.style.setProperty(key, value)
  }
  const dark = !isLightBackground(theme.background ?? '#000000')
  root.classList.toggle('dark', dark)
  root.classList.toggle('light', !dark)
}
