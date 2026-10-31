/**
 * Color themes (dark + light) originally ported from claude-terminal/themes.sh,
 * expanded since. Author only the 8 base keys per theme (name, bg, fg, cursor,
 * accent1-4); xtermTheme (22 keys) and cssVars (11 keys) are derived below.
 * Themes are referenced BY INDEX and persisted per project, so only APPEND new
 * themes to the end of the array, never insert in the middle.
 */

function lighten(hex, amount = 0.2) {
  const parse = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const [r, g, b] = parse(hex);
  const l = (v) => Math.min(255, Math.round(v + (255 - v) * amount));
  return `#${l(r).toString(16).padStart(2, '0')}${l(g).toString(16).padStart(2, '0')}${l(b).toString(16).padStart(2, '0')}`;
}

function makeXtermTheme(bg, fg, cursor, accent1, accent2, accent3, accent4) {
  return {
    background: bg,
    foreground: fg,
    cursor: cursor,
    cursorAccent: bg,
    selectionBackground: `${accent1}44`,
    selectionForeground: fg,
    black: bg,
    red: accent4,
    green: accent2,
    yellow: accent3,
    blue: accent1,
    magenta: '#BC8CFF',
    cyan: accent2,
    white: fg,
    brightBlack: `${fg}88`,
    brightRed: lighten(accent4),
    brightGreen: lighten(accent2),
    brightYellow: lighten(accent3),
    brightBlue: lighten(accent1),
    brightMagenta: '#D2A8FF',
    brightCyan: lighten(accent2),
    brightWhite: fg,
  };
}

const themes = [
  {
    name: 'Midnight',
    bg: '#0D1117', fg: '#E6EDF3', cursor: '#58A6FF',
    accent1: '#58A6FF', accent2: '#3FB950', accent3: '#D29922', accent4: '#F85149',
  },
  {
    name: 'Ember',
    bg: '#1A1110', fg: '#FFB347', cursor: '#FF8C00',
    accent1: '#FF8C00', accent2: '#FF6347', accent3: '#FFD700', accent4: '#FFA07A',
  },
  {
    name: 'Forest',
    bg: '#0B1A0B', fg: '#8FBC8F', cursor: '#32CD32',
    accent1: '#32CD32', accent2: '#228B22', accent3: '#90EE90', accent4: '#006400',
  },
  {
    name: 'Phantom',
    bg: '#000000', fg: '#F8F8F2', cursor: '#BBBBBB',
    accent1: '#FF79C6', accent2: '#BD93F9', accent3: '#50FA7B', accent4: '#F1FA8C',
  },
  {
    name: 'Copper',
    bg: '#1A1210', fg: '#CD7F32', cursor: '#B8860B',
    accent1: '#B8860B', accent2: '#DAA520', accent3: '#8B4513', accent4: '#D2691E',
  },
  {
    name: 'Arctic',
    bg: '#0F1B2D', fg: '#87CEEB', cursor: '#4FC3F7',
    accent1: '#4FC3F7', accent2: '#00BCD4', accent3: '#80DEEA', accent4: '#B3E5FC',
  },
  {
    name: 'Plum',
    bg: '#1A0A2E', fg: '#D8BFD8', cursor: '#BA55D3',
    accent1: '#BA55D3', accent2: '#9370DB', accent3: '#DDA0DD', accent4: '#EE82EE',
  },
  {
    name: 'Carbon',
    bg: '#1C1C1C', fg: '#C0C0C0', cursor: '#808080',
    accent1: '#A9A9A9', accent2: '#778899', accent3: '#B0C4DE', accent4: '#696969',
  },
  {
    name: 'Neon',
    bg: '#0A0A0A', fg: '#39FF14', cursor: '#00FF00',
    accent1: '#00FF41', accent2: '#39FF14', accent3: '#7FFF00', accent4: '#ADFF2F',
  },
  {
    name: 'Sunset',
    bg: '#1F1410', fg: '#FF6B6B', cursor: '#FF4757',
    accent1: '#FF4757', accent2: '#FF6348', accent3: '#FFA502', accent4: '#FF7F50',
  },
  {
    name: 'Lagoon',
    bg: '#0FC3C4', fg: '#0A1F20', cursor: '#00595B',
    accent1: '#0066A3', accent2: '#008572', accent3: '#B36A00', accent4: '#C44545',
  },
  {
    name: 'Linen',
    bg: '#E0DBC4', fg: '#2B2820', cursor: '#6B5A36',
    accent1: '#8B5A2B', accent2: '#5F7A3D', accent3: '#A6741D', accent4: '#A03333',
  },
  {
    name: 'Sage',
    bg: '#C3DFD1', fg: '#1F3329', cursor: '#4A6B5C',
    accent1: '#2D6E58', accent2: '#5A8A47', accent3: '#B8860B', accent4: '#A04545',
  },
  {
    name: 'Blossom',
    bg: '#F5C6CB', fg: '#4A1A22', cursor: '#8B3A4A',
    accent1: '#B83755', accent2: '#6B7A3D', accent3: '#B8860B', accent4: '#8B2D2D',
  },
  {
    name: 'Lavender',
    bg: '#DCD0F0', fg: '#2D1B4E', cursor: '#5C447F',
    accent1: '#5B3FA8', accent2: '#4A7B5C', accent3: '#B8860B', accent4: '#A03340',
  },
  {
    name: 'Powder',
    bg: '#C8E0EE', fg: '#1A2E40', cursor: '#4A6B85',
    accent1: '#1F5F8B', accent2: '#2D7A5C', accent3: '#B8860B', accent4: '#B83344',
  },
  {
    name: 'Butter',
    bg: '#FFE9A8', fg: '#3D3318', cursor: '#6B5C2E',
    accent1: '#C28A1B', accent2: '#5C7A3D', accent3: '#8B5A2B', accent4: '#A03333',
  },
  {
    name: 'Peach',
    bg: '#FFD1B8', fg: '#3D1F0F', cursor: '#6B3D24',
    accent1: '#C45A2B', accent2: '#5F7A3D', accent3: '#B8860B', accent4: '#8B2D2D',
  },
  // --- v1.0.47 additions: crimson, royal, and muted tones (appended so saved
  //     per-project themeIndex values keep pointing at the same theme). ---
  {
    name: 'Crimson',
    bg: '#160A0D', fg: '#F6DADF', cursor: '#E23E52',
    accent1: '#DC2E43', accent2: '#4FB477', accent3: '#E0A93A', accent4: '#FF6470',
  },
  {
    name: 'Royal',
    bg: '#0B1030', fg: '#E7ECFF', cursor: '#D4AF37',
    accent1: '#5570FF', accent2: '#3FB985', accent3: '#E3B341', accent4: '#F2617A',
  },
  {
    name: 'Amethyst',
    bg: '#150A24', fg: '#ECDCFF', cursor: '#B266FF',
    accent1: '#9D4EDD', accent2: '#57C89C', accent3: '#E0B341', accent4: '#FF5D8F',
  },
  {
    name: 'Driftwood',
    bg: '#17161A', fg: '#CBC5BD', cursor: '#9A9187',
    accent1: '#8FA6B6', accent2: '#93B089', accent3: '#CCA96C', accent4: '#C68178',
  },
  {
    name: 'Slate',
    bg: '#14181D', fg: '#BAC4CE', cursor: '#7E8C99',
    accent1: '#6E96B8', accent2: '#7FAF97', accent3: '#C4AB6B', accent4: '#C48C8C',
  },
  {
    name: 'Nebula',
    bg: '#0E0B1A', fg: '#E6DCF8', cursor: '#C77DFF',
    accent1: '#9D7CFF', accent2: '#4FD6C4', accent3: '#F5C561', accent4: '#FF6FA5',
  },
  // --- v1.0.47 creative pack: recognizable, distinctive palettes ---
  {
    name: 'Synthwave',
    bg: '#1A1030', fg: '#F5E6FF', cursor: '#FF6AD5',
    accent1: '#FF6AD5', accent2: '#05D9E8', accent3: '#FFD319', accent4: '#FF3860',
  },
  {
    name: 'Gruvbox',
    bg: '#282828', fg: '#EBDBB2', cursor: '#FE8019',
    accent1: '#83A598', accent2: '#B8BB26', accent3: '#FABD2F', accent4: '#FB4934',
  },
  {
    name: 'Tokyo Night',
    bg: '#1A1B26', fg: '#C0CAF5', cursor: '#7AA2F7',
    accent1: '#7AA2F7', accent2: '#9ECE6A', accent3: '#E0AF68', accent4: '#F7768E',
  },
  {
    name: 'Rose Pine',
    bg: '#191724', fg: '#E0DEF4', cursor: '#EBBCBA',
    accent1: '#C4A7E7', accent2: '#9CCFD8', accent3: '#F6C177', accent4: '#EB6F92',
  },
  {
    name: 'Solarized',
    bg: '#002B36', fg: '#93A1A1', cursor: '#839496',
    accent1: '#268BD2', accent2: '#859900', accent3: '#B58900', accent4: '#DC322F',
  },
  {
    name: 'Cyberpunk',
    bg: '#0A0A12', fg: '#F0F0FF', cursor: '#FCEE0A',
    accent1: '#00F0FF', accent2: '#00FF9F', accent3: '#FCEE0A', accent4: '#FF003C',
  },
  {
    name: 'Aurora',
    bg: '#0A1428', fg: '#D6F5E3', cursor: '#64FFDA',
    accent1: '#64FFDA', accent2: '#7CFF6B', accent3: '#E4C989', accent4: '#FF6B9D',
  },
  {
    name: 'Molten',
    bg: '#140A08', fg: '#FFE0C2', cursor: '#FF6B1A',
    accent1: '#FF6B1A', accent2: '#6BA368', accent3: '#FFB627', accent4: '#FF3B1F',
  },
];

// Add xtermTheme and CSS variables to each theme
export const THEMES = themes.map((t) => ({
  ...t,
  xtermTheme: makeXtermTheme(t.bg, t.fg, t.cursor, t.accent1, t.accent2, t.accent3, t.accent4),
  cssVars: {
    '--bg': t.bg,
    '--fg': t.fg,
    '--accent': t.accent1,
    '--accent-muted': `${t.accent1}22`,
    '--border': `${t.fg}22`,
    '--surface': mixColor(t.bg, t.fg, 0.05),
    '--surface-hover': mixColor(t.bg, t.fg, 0.08),
    // Secondary/"dim" text. On LIGHT backgrounds a 53% alpha (0x88) dark fg is
    // too faint for WCAG AA, so use a stronger 78% (0xC7); dark themes keep the
    // softer 53%. Accessibility fix.
    '--dim': isLightBg(t.bg) ? `${t.fg}c7` : `${t.fg}88`,
    '--danger': t.accent4,
    '--warning': t.accent3,
    // Worktree indicator: teal, tuned so it stays legible on both dark and
    // the light-background themes (Butter, Peach). Bright teal on dark bg,
    // deeper teal on light bg.
    '--git-worktree': isLightBg(t.bg) ? '#0D9488' : '#2DD4BF',
    // Finished / OK (the sidebar's green "Done"). Theme accents are not
    // reliably green, so it is fixed here, darker on light backgrounds.
    '--success': isLightBg(t.bg) ? '#1A7F37' : '#3FB950',
  },
}));

/** True when a background hex is light enough to need a darker accent. */
function isLightBg(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  // Perceived luminance (ITU-R BT.601), 0-255.
  return (0.299 * r + 0.587 * g + 0.114 * b) > 140;
}

/**
 * Simple hex color mix for surface color.
 * Blends bg toward fg by the given amount (0-1).
 */
function mixColor(hex1, hex2, amount) {
  const parse = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const [r1, g1, b1] = parse(hex1);
  const [r2, g2, b2] = parse(hex2);
  const mix = (a, b) => Math.round(a + (b - a) * amount);
  const r = mix(r1, r2);
  const g = mix(g1, g2);
  const b = mix(b1, b2);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

export function applyTheme(theme, element = document.documentElement) {
  if (theme.cssVars) {
    for (const [key, value] of Object.entries(theme.cssVars)) {
      element.style.setProperty(key, value);
    }
  }
}
