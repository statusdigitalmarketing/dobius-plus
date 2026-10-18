// Original pixel-art character for the Office view. No sprite copying from
// any game or asset pack: the characters are drawn here as a string-encoded
// pixel grid, rendered through SVG rects.
//
// 16 cols x 20 rows = 320 pixel cells. The viewBox is 16x20; the parent sizes
// via width/height so this scales crisply at any desk size.
//
// kind: 'claude' | 'codex' | 'shell' (palette swap only, same silhouette)
// state: 'working' | 'done' | 'idle' | 'needs'
// Verb bubble is in Desk.jsx so sibling layout can position it; this component
// draws only the character + an in-pose prop (coffee mug for done, Z sprite
// for idle). The red '!' needs-bubble also lives in Desk.jsx.

const PALETTES = {
  // 'Y' is a pose-only highlight (hand/arm overlay). Characters share the
  // same silhouette with a palette swap so Claude vs Codex is readable at a
  // glance without a different sprite.
  claude: { H: '#2d1a0e', S: '#e8c9a8', T: '#c56a2e', P: '#5a3a28', Y: '#f0d8bc' },
  codex:  { H: '#111111', S: '#dcc3a0', T: '#3f6d8e', P: '#1a2d3d', Y: '#edd5b4' },
  shell:  { H: '#444444', S: '#d9c8ad', T: '#808080', P: '#404040', Y: '#e5d4b4' },
};

// POSES. '.' transparent, letters -> palette keys above.
// Rows top to bottom; columns left to right (16 wide, 20 tall).
// Idle, done, needs share the same seated-neutral body; `working` tweaks the arms.
const BODY = [
  '................', // 0
  '......HHHH......', // 1 hair top
  '.....HHHHHH.....', // 2
  '....HSSSSSSH....', // 3 face
  '....HSSSSSSH....', // 4
  '....HSS..SSH....', // 5 eyes
  '....HSSSSSSH....', // 6
  '....HSSSSSSH....', // 7
  '.....SSSSSS.....', // 8 neck
  '....TTTTTTTT....', // 9 shoulders
  '....TTTTTTTT....', // 10 shirt
  '....TTTTTTTT....', // 11
  '....TTTTTTTT....', // 12
  '....TTTTTTTT....', // 13 lap
  '....PPPPPPPP....', // 14 pants/chair
  '....PPPPPPPP....', // 15
  '................', // 16
  '................', // 17
  '................', // 18
  '................', // 19
];

// Arm positions per state. '-' = replace underlying cell with transparent;
// otherwise overlay with palette key. Rows aligned to BODY.
const ARMS_WORKING_A = {
  10: 'Y..........Y...',   // reaching forward (one arm up each phase)
  11: '.Y........Y....',
  12: '..Y......Y.....',
};
const ARMS_WORKING_B = {
  10: '..Y........Y..',   // alternate pose for the typing animation
  11: '...Y......Y...',
  12: '....Y....Y.....',
};
const ARMS_IDLE = {
  10: 'Y..........Y...',   // arms slack by sides
  11: 'Y..........Y...',
  12: 'Y..........Y...',
};
const ARMS_DONE = {
  10: 'Y.............Y',   // arms wide, leaned-back vibe
  11: '.Y............Y',
  12: '..Y...........Y',
};
const ARMS_NEEDS = {
  10: 'Y..........Y...',   // same as idle, the attention-grabber is the ! bubble
  11: 'Y..........Y...',
  12: 'Y..........Y...',
};

function applyOverlay(rows, overlay) {
  if (!overlay) return rows;
  const out = rows.slice();
  for (const [r, s] of Object.entries(overlay)) {
    const row = out[Number(r)];
    const chars = row.split('');
    for (let i = 0; i < s.length; i += 1) {
      const c = s[i];
      if (c === '-') chars[i] = '.';
      else if (c !== '.') chars[i] = c;
    }
    out[Number(r)] = chars.join('');
  }
  return out;
}

// Z sleep bubble (floats above the head) for idle state.
const SLEEP_Z = [
  '.ZZZ', '...Z', '..Z.', '.Z..', 'ZZZZ',
];
// Coffee mug (left of the body) for done state.
const COFFEE = [
  'MMMM.',
  'MGGMMH',
  'MGGM.H',
  'MGGM.H',
  'MMMM..',
];

export default function Character({ kind = 'claude', state = 'idle', phase = 0 }) {
  const palette = PALETTES[kind] || PALETTES.claude;
  let rows = BODY;
  if (state === 'working') rows = applyOverlay(rows, phase % 2 === 0 ? ARMS_WORKING_A : ARMS_WORKING_B);
  else if (state === 'done') rows = applyOverlay(rows, ARMS_DONE);
  else if (state === 'needs') rows = applyOverlay(rows, ARMS_NEEDS);
  else rows = applyOverlay(rows, ARMS_IDLE);

  const cells = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      const c = row[x];
      if (c === '.' || !c) continue;
      const fill = palette[c] || '#f0f';
      cells.push(<rect key={`b${x}-${y}`} x={x} y={y} width={1} height={1} fill={fill} />);
    }
  });

  // Coffee overlay for done, drawn to the left of body.
  if (state === 'done') {
    COFFEE.forEach((row, y) => {
      for (let x = 0; x < row.length; x += 1) {
        const c = row[x];
        if (c === '.' || !c) continue;
        const fill = c === 'M' ? '#8a6a4c' : c === 'G' ? '#5a3a28' : c === 'H' ? '#8a6a4c' : '#333';
        cells.push(<rect key={`c${x}-${y}`} x={x + 1} y={y + 10} width={1} height={1} fill={fill} />);
      }
    });
  }

  // Z sleep bubble floating above the head for idle.
  if (state === 'idle') {
    SLEEP_Z.forEach((row, y) => {
      for (let x = 0; x < row.length; x += 1) {
        const c = row[x];
        if (c === 'Z') cells.push(<rect key={`z${x}-${y}`} x={x + 11} y={y} width={1} height={1} fill="#9db4c7" />);
      }
    });
  }

  return (
    <svg viewBox="0 0 16 20" shapeRendering="crispEdges" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
      {cells}
    </svg>
  );
}
