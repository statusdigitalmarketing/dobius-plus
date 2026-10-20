// A stable color + letter per project for the History rows, so a list can be
// scanned by project without reading the grey project name. Same path, same
// color, in every window and after every restart (no stored state).
// Pure: tested in electron/__tests__/sidebar-polish.test.mjs.

// FNV-1a over UTF-16 code units: tiny, deterministic, well spread for paths
// that differ only in their last segment.
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * @param {string} projectPath
 * @returns {{ letter: string, hue: number, background: string }}
 * Mid saturation and lightness so white text reads on both dark and light
 * themes.
 */
export function projectMonogram(projectPath) {
  const p = typeof projectPath === 'string' ? projectPath : '';
  const name = p.split('/').filter(Boolean).pop() || '';
  const letter = (name.match(/[a-z0-9]/i)?.[0] || '?').toUpperCase();
  const hue = hash(p) % 360;
  return { letter, hue, background: `hsl(${hue} 45% 42%)` };
}
