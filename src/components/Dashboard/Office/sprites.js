// Pixel art for the Office v2. Everything is drawn in code, no asset copies.
// Sprites are string-encoded grids and compiled once on module init into
// offscreen HTMLCanvasElements; the renderer blits via drawImage, which is far
// cheaper per frame than drawing N rects for every tile and character every
// animation step. This file is the single source of art truth; sibling
// renderer.js reads only via SPRITES.get(name).
//
// Perspective: 3/4 top-down, like a classic SNES office game. Characters face
// the camera; walls are seen from the front; floors from above.
//
// Palette keys (shared across sprites so a reader can diff them visually):
//   . = transparent
//   # , : = outline / mid / shade
//   W = wall light face
//   w = wall shadow face
//   T = wall top edge
//   F = floor base
//   f = floor stripe / grid
//   M = monitor bezel
//   m = monitor dark screen
//   g = monitor glow (working)
//   G = monitor flicker overlay (random per-frame, not baked in)
//   D = desk top
//   d = desk shade
//   C = chair
//   c = chair shade
//   P = plant leaf
//   p = plant pot
//   K = coffee machine body
//   k = coffee machine spout
//   O = couch cushion
//   o = couch frame
//   B = board frame
//   b = board face
//   Y = window sky day
//   y = window sky dusk
//   N = window sky night
//   L = light bulb (on)
//   l = light shadow
//   S = skin
//   H = hair
//   t = shirt tone (per-kind color in CHARACTER_PALETTE)
//   P = pants
//   R = red (needs)
//   r = red shade
//
// We use fillStyle lookups per sprite via per-sprite palette overrides where
// character/door tinting needs to vary (e.g. doorLight red vs green). Letters
// NOT in a sprite's palette render as a visible magenta so missing art is loud.

const BASE_TILE = 16; // pixel art authoring unit. renderer scales up by camera zoom.

// --- Shared palette ---------------------------------------------------------
const BASE = {
  '.': null, // transparent
  '#': '#1a1a1f',
  ',': '#2b2b31',
  ':': '#43434a',
  F: '#5a4a3c',
  f: '#4a3c30',
  T: '#746357',
  W: '#9d8a7a',
  w: '#5f4f44',
  M: '#17171a',
  m: '#0f1a1f',
  g: '#4ec9b0',
  D: '#c58a5a',
  d: '#8a5a38',
  C: '#2b2b31',
  c: '#171717',
  P: '#2f6b2f',
  p: '#6b4b2f',
  K: '#9ea3a8',
  k: '#505558',
  O: '#8f5a66',
  o: '#4a2f36',
  B: '#4c3a2a',
  b: '#141418',
  Y: '#9bd0ff',
  y: '#f1a267',
  N: '#1a2238',
  L: '#f8dc5a',
  l: '#6b5c20',
  S: '#e8c9a8',
  H: '#2d1a0e',
  t: '#c56a2e', // overridden per character kind
  R: '#e23b3b',
  r: '#8a1a1a',
};

// Per-character-kind palette overrides. Only the 't' (shirt) key differs.
// Codex gets a steel-blue shirt, shell gets neutral gray.
export const CHARACTER_PALETTE = {
  claude: { ...BASE, t: '#c56a2e' },
  codex:  { ...BASE, t: '#3f6d8e' },
  shell:  { ...BASE, t: '#7d7d82' },
};

// --- Sprite source data -----------------------------------------------------

// A plain floor tile: carpet weave as a 16x16 grid.
const FLOOR_OFFICE = [
  'FFFFFFFFFFFFFFFF',
  'FfFfFfFfFfFfFfFf',
  'FFFFFFFFFFFFFFFF',
  'fFfFfFfFfFfFfFfF',
  'FFFFFFFFFFFFFFFF',
  'FfFfFfFfFfFfFfFf',
  'FFFFFFFFFFFFFFFF',
  'fFfFfFfFfFfFfFfF',
  'FFFFFFFFFFFFFFFF',
  'FfFfFfFfFfFfFfFf',
  'FFFFFFFFFFFFFFFF',
  'fFfFfFfFfFfFfFfF',
  'FFFFFFFFFFFFFFFF',
  'FfFfFfFfFfFfFfFf',
  'FFFFFFFFFFFFFFFF',
  'fFfFfFfFfFfFfFfF',
];

// Corridor floor: cooler tone than offices.
const FLOOR_CORRIDOR = FLOOR_OFFICE.map((row) => row.replaceAll('F', ',').replaceAll('f', ':'));

// Lobby floor: checker.
const FLOOR_LOBBY = [
  ',,,,,,,,::::::::',
  ',,,,,,,,::::::::',
  ',,,,,,,,::::::::',
  ',,,,,,,,::::::::',
  ',,,,,,,,::::::::',
  ',,,,,,,,::::::::',
  ',,,,,,,,::::::::',
  ',,,,,,,,::::::::',
  '::::::::,,,,,,,,',
  '::::::::,,,,,,,,',
  '::::::::,,,,,,,,',
  '::::::::,,,,,,,,',
  '::::::::,,,,,,,,',
  '::::::::,,,,,,,,',
  '::::::::,,,,,,,,',
  '::::::::,,,,,,,,',
];

// Walls are drawn with a thin top face (T) and taller front face (W/w). A room
// is bordered by WALL_TOP (north edge) and WALL_FRONT (south edge); east/west
// edges are a single-column WALL_SIDE repeated. Keeping it one tile per side
// means a room is just (floor * N) + border tiles.
const WALL_TOP = [
  'TTTTTTTTTTTTTTTT',
  'TTTTTTTTTTTTTTTT',
  'WWWWWWWWWWWWWWWW',
  'WWWWWWWWWWWWWWWW',
  'wwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwww',
  '################',
  '################',
  'FFFFFFFFFFFFFFFF',
  'FfFfFfFfFfFfFfFf',
  'FFFFFFFFFFFFFFFF',
  'fFfFfFfFfFfFfFfF',
  'FFFFFFFFFFFFFFFF',
  'FfFfFfFfFfFfFfFf',
];

const WALL_FRONT = [ // south edge: just the top line of a wall seen edge-on
  'FFFFFFFFFFFFFFFF',
  'FfFfFfFfFfFfFfFf',
  'FFFFFFFFFFFFFFFF',
  'fFfFfFfFfFfFfFfF',
  'FFFFFFFFFFFFFFFF',
  'FfFfFfFfFfFfFfFf',
  'FFFFFFFFFFFFFFFF',
  'fFfFfFfFfFfFfFfF',
  'FFFFFFFFFFFFFFFF',
  'FfFfFfFfFfFfFfFf',
  '################',
  'TTTTTTTTTTTTTTTT',
  'wwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwww',
];

const WALL_SIDE = [
  'TTFFFFFFFFFFFFFF',
  'TTFfFfFfFfFfFfFf',
  'WWFFFFFFFFFFFFFF',
  'WWfFfFfFfFfFfFfF',
  'wwFFFFFFFFFFFFFF',
  'wwFfFfFfFfFfFfFf',
  'wwFFFFFFFFFFFFFF',
  'wwfFfFfFfFfFfFfF',
  'wwFFFFFFFFFFFFFF',
  'wwFfFfFfFfFfFfFf',
  'wwFFFFFFFFFFFFFF',
  'wwfFfFfFfFfFfFfF',
  'wwFFFFFFFFFFFFFF',
  'wwFfFfFfFfFfFfFf',
  'wwFFFFFFFFFFFFFF',
  'wwfFfFfFfFfFfFfF',
];
const WALL_SIDE_R = WALL_SIDE.map((row) => row.split('').reverse().join(''));

const WALL_CORNER_NW = [
  'TTTTTTTTTTTTTTTT',
  'TTTTTTTTTTTTTTTT',
  'WWWWWWWWWWWWWWWW',
  'WWWWWWWWWWWWWWWW',
  'wwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwww',
  'wwFFFFFFFFFFFFFF',
  'wwFfFfFfFfFfFfFf',
  'wwFFFFFFFFFFFFFF',
  'wwfFfFfFfFfFfFfF',
  'wwFFFFFFFFFFFFFF',
  'wwFfFfFfFfFfFfFf',
  'wwFFFFFFFFFFFFFF',
  'wwfFfFfFfFfFfFfF',
];
const WALL_CORNER_NE = WALL_CORNER_NW.map((row) => row.split('').reverse().join(''));

const WALL_CORNER_SW = [
  'wwFFFFFFFFFFFFFF',
  'wwFfFfFfFfFfFfFf',
  'wwFFFFFFFFFFFFFF',
  'wwfFfFfFfFfFfFfF',
  'wwFFFFFFFFFFFFFF',
  'wwFfFfFfFfFfFfFf',
  'wwFFFFFFFFFFFFFF',
  'wwfFfFfFfFfFfFfF',
  'wwFFFFFFFFFFFFFF',
  'wwFfFfFfFfFfFfFf',
  'wwTTTTTTTTTTTTTT',
  'wwTTTTTTTTTTTTTT',
  'wwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwww',
];
const WALL_CORNER_SE = WALL_CORNER_SW.map((row) => row.split('').reverse().join(''));

// Door is drawn as a wall segment with a brown gap in the middle. The "door
// light" above the door is rendered dynamically by the renderer (so it can
// vary color per room state) rather than being baked here.
const WALL_DOOR = [
  'TTTTTTTTTTTTTTTT',
  'TTTTTTTTTTTTTTTT',
  'WWWW........WWWW',
  'WWWW.wwwwww.WWWW',
  'wwww.wPPPPw.wwww',
  'wwww.wwwwww.wwww',
  'wwww.w####w.wwww',
  'wwww.w#LL#w.wwww',
  'wwww.w#LL#w.wwww',
  'wwww.wwwwww.wwww',
  '####.wwwwww.####',
  'FFFF.FFFFFF.FFFF',
  'FfFf.FfFfFf.FfFf',
  'FFFF.FFFFFF.FFFF',
  'fFfF.fFfFfF.fFfF',
  'FFFF.FFFFFF.FFFF',
];

// A desk is 3 tiles wide, 2 tiles tall. Shape, top-down:
//   Row 0-2: back portion of desk, with a smaller monitor + keyboard on top
//            (monitor is 10 pixels wide, centered, with a keyboard tray below)
//   Row 3-11: desk surface with mug + plant decorations on the left/right ends
//   Row 12-14: desk FRONT face (darker, sloping down to the floor)
//   Row 15-16: drop shadow on the floor
// Everything below is transparent so the character seated south of the desk
// is not clipped.
const DESK_CLAUDE = [
  'dddddddddddddddddddddddddddddddddddddddddddddddd',
  'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
  'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
  'DDDDDDDDDDDDDDMMMMMMMMMMMMMMMMMMMMDDDDDDDDDDDDDD',
  'DDDDDDDDDDDDDDMggggggggggggggggggMDDDDDDDDDDDDDD',
  'DDDDDDDDDDDDDDMggggggggggggggggggMDDDDDDDDDDDDDD',
  'DDDDDDDDDDDDDDMggggggggggggggggggMDDDDDDDDDDDDDD',
  'DDDDDDDDDDDDDDMggggggggggggggggggMDDDDDDDDDDDDDD',
  'DDPPDDDDDDDDDDMggggggggggggggggggMDDDDDDDDDDOODD',
  'DPpPDDDDDDDDDDMMMMMMMMMMMMMMMMMMMMDDDDDDDDDOkODD',
  'DppPDDDDD##################################OODDD',
  'DppPDDDDD:,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,:#DDDDD',
  'ddddddDDDd::::::::::::::::::::::::::::::::#dddddd',
  'dddddddddd################################dddddd',
  'dddddddddddddddddddddddddddddddddddddddddddddddd',
  '################################################',
  '::::::::::::::::::::::::::::::::::::::::::::::::',
  '................................................',
  '................................................',
  '................................................',
  '................................................',
  '................................................',
  '................................................',
  '................................................',
  '................................................',
  '................................................',
  '................................................',
  '................................................',
  '................................................',
  '................................................',
  '................................................',
  '................................................',
].map((row) => row.slice(0, 48)); // 48 wide = 3 tiles

const DESK_CODEX = DESK_CLAUDE
  .map((row) => row.replaceAll('D', 'K').replaceAll('d', 'k'))
  // Codex desk uses a darker steel-blue surface. 'K' and 'k' palette entries
  // already read as steel gray; the 'standing-desk vibe' comes from a tighter
  // monitor bezel + less decoration (strip the mug on the right side).
  .map((row) => row.replaceAll('OO', 'kk').replaceAll('Ok', 'kk').replaceAll('kO', 'kk'));

// Chair: a swivel chair seen from the front, roughly 10 pixels wide centered
// in a 16px cell.
const CHAIR = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '....CCCCCCCC....',
  '....CcccccCC....',
  '....CcccccCC....',
  '....CcccccCC....',
  '....CcccccCC....',
  '....CCCCCCCC....',
  '......CCCC......',
  '......CCCC......',
  '....CC....CC....',
  '....CC....CC....',
  '................',
];

// Potted plant
const PLANT = [
  '................',
  '......PPPP......',
  '....PPPPPPPP....',
  '...PPPPPPPPPP...',
  '....PPPPPPPP....',
  '.....PPPPPP.....',
  '....PPPPPPPP....',
  '...PPPPPPPPPP...',
  '....PPPPPPPP....',
  '......PPPP......',
  '........P.......',
  '......pppppp....',
  '......pppppp....',
  '......pppppp....',
  '......ppPPpp....',
  '................',
];

// Coffee machine: 1 tile wide, 2 tiles tall.
const COFFEE_MACHINE = [
  '................',
  '....KKKKKKKK....',
  '....K######K....',
  '....K#LLLL#K....',
  '....K######K....',
  '....K######K....',
  '....KKKKKKKK....',
  '....KKkkkkKK....',
  '....KKKKKKKK....',
  '....K......K....',
  '....K.KKKK.K....',
  '....K.KkkK.K....',
  '....K.KKKK.K....',
  '....KKKKKKKK....',
  '....kkkkkkkk....',
  '................',
];

// Couch: 2 tiles wide, 1 tall.
const COUCH = [
  '................................',
  '................................',
  '..OOOOOOOOOOOOOOOOOOOOOOOOOOOO..',
  '..OoooooooooooooooooooooooooO...',
  '..OoooooooooooooooooooooooooO...',
  '..OoooooooooooooooooooooooooO...',
  '..OOOOOOOOOOOOOOOOOOOOOOOOOOO...',
  '..OO........................OO..',
  '..OO........................OO..',
  '..OO........................OO..',
  '..OO........................OO..',
  '..OO........................OO..',
  '..ooOO....................OOoo..',
  '..oooo....................oooo..',
  '................................',
  '................................',
];

// Window seen on a wall: 2 tiles wide. The sky color key (Y/y/N) is replaced
// dynamically by the renderer per daylight. The frame stays constant.
const WINDOW = [
  '................................',
  'TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT',
  'TT############################TT',
  'TT#YYYYYYYYYYYYYY#YYYYYYYYYYY#TT',
  'TT#YYYYYYYYYYYYYY#YYYYYYYYYYY#TT',
  'TT#YYYYYYYYYYYYYY#YYYYYYYYYYY#TT',
  'TT#YYYYYYYYYYYYYY#YYYYYYYYYYY#TT',
  'TT#YYYYYYYYYYYYYY#YYYYYYYYYYY#TT',
  'TT#YYYYYYYYYYYYYY#YYYYYYYYYYY#TT',
  'TT#YYYYYYYYYYYYYY#YYYYYYYYYYY#TT',
  'TT#YYYYYYYYYYYYYY#YYYYYYYYYYY#TT',
  'TT############################TT',
  'TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT',
  '################################',
  'wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww',
];

// Analog clock face mounted on wall. Hands are drawn separately per frame.
const CLOCK = [
  '................',
  '......####......',
  '....##::::##....',
  '...#::####::#...',
  '..#::#....#::#..',
  '..#:#......#:#..',
  '..#:#......#:#..',
  '..#:#......#:#..',
  '..#:#......#:#..',
  '..#:#......#:#..',
  '..#::#....#::#..',
  '...#::####::#...',
  '....##::::##....',
  '......####......',
  '................',
  '................',
];

// Lobby wall board: big screen for the status counts. 3x2 tiles.
const WALL_BOARD = [
  '................................................',
  'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  'BB##########################################BB',
  'BB#bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb#BB',
  'BB#bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb#BB',
  'BB#bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb#BB',
  'BB#bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb#BB',
  'BB#bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb#BB',
  'BB#bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb#BB',
  'BB#bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb#BB',
  'BB#bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb#BB',
  'BB#bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb#BB',
  'BB#bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb#BB',
  'BB#bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb#BB',
  'BB#bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb#BB',
  'BB#bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb#BB',
  'BB#bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb#BB',
  'BB#bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb#BB',
  'BB#bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb#BB',
  'BB#bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb#BB',
  'BB##########################################BB',
  'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  'wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww',
].map((row) => row.slice(0, 48));

// Character silhouette (16 wide, 20 tall). Shared body across kinds; shirt (t)
// is palette-swapped per kind.
const BODY = [
  '................',
  '......HHHH......',
  '.....HHHHHH.....',
  '....HSSSSSSH....',
  '....HSSSSSSH....',
  '....HSS..SSH....',
  '....HSSSSSSH....',
  '....HSSSSSSH....',
  '.....SSSSSS.....',
  '....tttttttt....',
  '....tttttttt....',
  '....tttttttt....',
  '....tttttttt....',
  '....tttttttt....',
  '....PPPPPPPP....',
  '....PPPPPPPP....',
  '................',
  '................',
  '................',
  '................',
];

function overlayRows(rows, patches) {
  const out = rows.slice();
  for (const r in patches) {
    const chars = out[Number(r)].split('');
    const s = patches[r];
    for (let i = 0; i < s.length; i += 1) {
      const c = s[i];
      if (c === '-') chars[i] = '.';
      else if (c !== '.') chars[i] = c;
    }
    out[Number(r)] = chars.join('');
  }
  return out;
}

// Character pose variants. Working-A / Working-B toggles arms for the typing
// animation. Idle slumps forward with a Z (Z drawn separately). Needs/done have
// arms by sides. All 20-row aligned to BODY.
const POSE_SEATED_IDLE = overlayRows(BODY, {});
const POSE_SEATED_WORK_A = overlayRows(BODY, {
  10: '..SS......SS....',
  11: '..SS......SS....',
  12: '..SS......SS....',
});
const POSE_SEATED_WORK_B = overlayRows(BODY, {
  10: '...SS....SS.....',
  11: '...SS....SS.....',
  12: '...SS....SS.....',
});
const POSE_STAND = BODY; // standing beside desk (needs/done)

// --- Compile strings to canvases -------------------------------------------

function compile(rows, palette) {
  const w = rows[0].length;
  const h = rows.length;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  for (let y = 0; y < h; y += 1) {
    const row = rows[y];
    for (let x = 0; x < row.length; x += 1) {
      const k = row[x];
      if (k === '.' || k == null) continue;
      const fill = palette[k];
      if (fill == null) { ctx.fillStyle = '#ff00ff'; ctx.fillRect(x, y, 1, 1); continue; }
      ctx.fillStyle = fill;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return c;
}

// Lazy init so this file can be imported from Node (unit tests) without a DOM.
// On first getSprite call we build the cache. If document is unavailable we
// return null, and the renderer skips drawing.
let _cache = null;
function buildCache() {
  if (typeof document === 'undefined') return null;
  const cache = {};
  // Floors + walls use the shared BASE palette.
  cache['floor-office']    = compile(FLOOR_OFFICE, BASE);
  cache['floor-corridor']  = compile(FLOOR_CORRIDOR, BASE);
  cache['floor-lobby']     = compile(FLOOR_LOBBY, BASE);
  cache['wall-top']        = compile(WALL_TOP, BASE);
  cache['wall-front']      = compile(WALL_FRONT, BASE);
  cache['wall-left']       = compile(WALL_SIDE, BASE);
  cache['wall-right']      = compile(WALL_SIDE_R, BASE);
  cache['wall-corner-nw']  = compile(WALL_CORNER_NW, BASE);
  cache['wall-corner-ne']  = compile(WALL_CORNER_NE, BASE);
  cache['wall-corner-sw']  = compile(WALL_CORNER_SW, BASE);
  cache['wall-corner-se']  = compile(WALL_CORNER_SE, BASE);
  cache['wall-door']       = compile(WALL_DOOR, BASE);
  cache['desk-claude']     = compile(DESK_CLAUDE, BASE);
  cache['desk-codex']      = compile(DESK_CODEX, BASE);
  cache['chair']           = compile(CHAIR, BASE);
  cache['plant']           = compile(PLANT, BASE);
  cache['coffee-machine']  = compile(COFFEE_MACHINE, BASE);
  cache['couch']           = compile(COUCH, BASE);
  cache['window']          = compile(WINDOW, BASE);
  cache['clock']           = compile(CLOCK, BASE);
  cache['wall-board']      = compile(WALL_BOARD, BASE);
  // Characters: one baked variant per (kind, pose). Kinds supply distinct
  // shirt colors via CHARACTER_PALETTE.
  for (const kind of ['claude', 'codex', 'shell']) {
    const pal = CHARACTER_PALETTE[kind];
    cache[`char-${kind}-work-a`] = compile(POSE_SEATED_WORK_A, pal);
    cache[`char-${kind}-work-b`] = compile(POSE_SEATED_WORK_B, pal);
    cache[`char-${kind}-idle`]   = compile(POSE_SEATED_IDLE,   pal);
    cache[`char-${kind}-stand`]  = compile(POSE_STAND,         pal);
  }
  return cache;
}

export const SPRITES = {
  tileSize: BASE_TILE,
  get(name) {
    if (!_cache) _cache = buildCache();
    if (!_cache) return null;
    return _cache[name] || null;
  },
  // Reset the cache. Used by tests that mock the document.
  _reset() { _cache = null; },
};
