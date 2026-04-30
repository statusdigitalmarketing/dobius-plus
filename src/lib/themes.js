/**
 * 10 dark themes ported from claude-terminal/themes.sh
 * Each theme has: name, bg, fg, cursor, accent1-4, and xtermTheme
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
    '--dim': `${t.fg}88`,
    '--danger': t.accent4,
    '--warning': t.accent3,
  },
}));

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
