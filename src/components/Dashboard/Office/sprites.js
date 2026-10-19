// Sprite atlas for the Office view. Backed by Kenney's RPG Urban Pack (CC0),
// bundled in assets/kenney-rpg-urban/. See assets/kenney-rpg-urban/License.txt
// for the full license, and LICENSES.md at the repo root for the credit.
//
// The tilemap is a 27 x 18 grid of 16 x 16 tiles, no spacing between cells
// (packed version). Tile indices in TILES below are tileNumber = row*27 + col.
// We import the PNG as a URL via Vite, load it into an HTMLImageElement on
// first getAtlas() call, and the renderer draws by slicing the atlas with
// drawImage(sx, sy, sw, sh, dx, dy, dw, dh). No per-tile pre-rasterization
// needed since drawImage from a single source bitmap is already a single blit.

import atlasUrl from './assets/kenney-rpg-urban/tilemap_packed.png';

const BASE_TILE = 16;
const ATLAS_COLS = 27;

// Hand-curated mapping from a sprite's semantic name to its tile index in the
// Kenney sheet. Picked by rendering the full atlas with numeric labels (see
// tile-index.html harness used during the asset bring-up). Characters have
// multiple frames per column (one character per column, several poses rowwise)
// so each named sprite picks one specific pose cell.
// Tile indexes verified against a zero-stride render of tilemap_packed.png
// (27 cols × 18 rows, 16px tiles, no spacing). An earlier revision had an off-
// by-one shift because the debug index image used a 17px stride; see the
// commit log for the regenerate.
export const TILES = {
  // --- Floors. Picked for genuine plain fill with no horizontal border, so a
  //     repeating pattern reads as open floor, not shelving. Each project
  //     gets a tint via scene.room.floorTile. ---
  'floor-office':      28,   // plain green carpet (clean mid-row)
  'floor-office-beige': 83,  // plain beige carpet (clean mid-row)
  'floor-office-tan':  127,  // plain tan floor (clean mid-row)
  'floor-office-pink': 110,  // plain pink/lilac floor (clean mid-row)
  'floor-corridor':    37,   // plain gray tile for the hallway
  'floor-lobby':       91,   // plain light gray lobby tile
  // --- Walls: red brick upper, with wood trim lower front ---
  'wall-top':         44,
  'wall-front':       98,
  'wall-left':        43,  // left brick edge
  'wall-right':       49,  // right brick edge
  'wall-corner-nw':   43,
  'wall-corner-ne':   49,
  'wall-corner-sw':   97,
  'wall-corner-se':   103,
  'wall-door':        311,  // single door with handle
  // --- Desks / counters (3 tiles rendered side-by-side per desk) ---
  'desk-claude':      273,  // brown wood desk
  'desk-codex':       278,  // dark/blue desk
  // --- Chairs ---
  'chair':            394,  // orange office chair
  'chair-codex':      421,  // red office chair
  // --- Furniture extras ---
  'plant':            262,  // small green shrub
  'coffee-machine':   251,  // red cylindrical (water cooler stand-in)
  'couch':            300,  // long green couch (left half)
  'couch-right':      301,  // long green couch (right half)
  'window':           365,  // framed picture/window
  'clock':            166,  // circular wall object
  'wall-board':       332,  // large flat screen panel
  // --- Characters: Claude = green-shirt woman, Codex = blue-hat sysadmin,
  //     shell = bald man.  Each character spans one atlas column across
  //     several rows (different poses). ---
  'char-claude-work-a':  23,
  'char-claude-work-b':  24,
  'char-claude-idle':    23,
  'char-claude-stand':   77,
  'char-codex-work-a':   185,
  'char-codex-work-b':   186,
  'char-codex-idle':     185,
  'char-codex-stand':    239,
  'char-shell-work-a':   347,
  'char-shell-work-b':   348,
  'char-shell-idle':     347,
  'char-shell-stand':    401,
};

let _atlas = null;
let _loading = null;

export function loadAtlas() {
  if (_atlas) return Promise.resolve(_atlas);
  if (_loading) return _loading;
  _loading = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { _atlas = img; _loading = null; resolve(img); };
    img.onerror = (e) => { _loading = null; reject(e); };
    img.src = atlasUrl;
  });
  return _loading;
}

// Simple draw helper for the renderer. Called inside the RAF loop so it must
// not throw: if the atlas is not loaded yet, draws nothing (the renderer
// usually gates on isReady() but this is defense in depth).
function drawTile(ctx, tileIndex, dx, dy, dw = BASE_TILE, dh = BASE_TILE) {
  if (!_atlas || tileIndex == null) return;
  const col = tileIndex % ATLAS_COLS;
  const row = Math.floor(tileIndex / ATLAS_COLS);
  ctx.drawImage(_atlas, col * BASE_TILE, row * BASE_TILE, BASE_TILE, BASE_TILE, dx, dy, dw, dh);
}

export const SPRITES = {
  tileSize: BASE_TILE,
  isReady() { return !!_atlas; },
  atlas() { return _atlas; },
  tileIndex(name) { return TILES[name]; },
  // Draw a named sprite at pixel coords. Multi-tile sprites (desks, couches,
  // windows) are composed by the caller as multiple drawTile calls so we do
  // not pre-rasterize larger composites.
  draw(ctx, name, dx, dy, dw, dh) {
    drawTile(ctx, TILES[name], dx, dy, dw, dh);
  },
  // Direct index draw for callers that need to pick a cell outside the TILES
  // map (e.g. multi-frame character poses).
  drawTile(ctx, tileIndex, dx, dy, dw, dh) {
    drawTile(ctx, tileIndex, dx, dy, dw, dh);
  },
};
