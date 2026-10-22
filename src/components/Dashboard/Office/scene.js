// Pure scene builder for the Office view. Takes a list of tabs + their status
// (keyed by tab id) and returns a Scene: a lobby + one room per project,
// positioned on a tile grid. The renderer reads only this Scene and does not
// know about Zustand or the push stream.
//
// Tile unit: each cell is sprites.tileSize (16px of authored art). The camera
// scales up for display. World coordinates are in TILES, converted to pixels
// in renderer.draw via (worldX * tileSize * camera.zoom).

const DESK_W = 3;     // tiles wide
const DESK_H = 2;     // tiles tall (desk + bench behind the chair)
const CHAIR_OFFSET = 2; // the chair + character sits CHAIR_OFFSET tiles south of the desk's top row
const DESKS_PER_ROW = 3;
const DESK_COL_GAP = 1;
const DESK_ROW_GAP = 2;
const ROOM_MARGIN = 2;
const CORRIDOR_H = 3;
const ROOM_MIN_W = 12;
const ROOM_MIN_H = 10;
const LOBBY_W = 16;
const LOBBY_H = 10;
const INTER_ROOM_GAP = 3;    // horizontal gap used as corridor between rooms
const INTER_ROW_GAP = 4;     // vertical gap used as corridor between room rows

// Rotate through plain floor tiles so each project has a distinct tint.
const FLOOR_PALETTE = ['floor-office', 'floor-office-beige', 'floor-office-tan', 'floor-office-pink'];

// Deterministically assign one of the four corners to the coffee machine, the
// couch, a plant, and a window so neighboring rooms are not visually identical.
// Project path hashed to a 0..3 rotation.
function stringHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Per-row vertical cost: one desk (DESK_H) + chair + person (CHAIR_OFFSET) +
// a gap tile before the next desk (DESK_ROW_GAP). Scene layout uses this per
// row, so room height must use the same formula or later rows fall through
// the south wall (Codex r1 P1-1: with 9 tabs row 2's chair sat outside).
const PER_ROW = DESK_H + CHAIR_OFFSET + DESK_ROW_GAP;

function roomSizeForTabs(tabCount) {
  const rows = Math.max(1, Math.ceil(Math.max(1, tabCount) / DESKS_PER_ROW));
  const w = Math.max(
    ROOM_MIN_W,
    2 + ROOM_MARGIN * 2 + DESKS_PER_ROW * DESK_W + (DESKS_PER_ROW - 1) * DESK_COL_GAP,
  );
  // Content height = margin + (rows-1 full PER_ROW gaps) + last row's desk +
  // chair (no trailing DESK_ROW_GAP). Plus the two wall tiles (top+south).
  const content = ROOM_MARGIN + (rows - 1) * PER_ROW + DESK_H + CHAIR_OFFSET + ROOM_MARGIN;
  const h = Math.max(ROOM_MIN_H, 2 + content);
  return { w, h };
}

function layoutDesksInRoom(room, tabs) {
  // Return per-tab desk + chair positions in TILE coordinates. Row stride
  // matches roomSizeForTabs's PER_ROW so the last row's chair always sits
  // inside the south wall.
  const items = [];
  const startX = 1 + ROOM_MARGIN;
  const startY = 1 + ROOM_MARGIN;
  tabs.forEach((tab, i) => {
    const col = i % DESKS_PER_ROW;
    const row = Math.floor(i / DESKS_PER_ROW);
    const x = startX + col * (DESK_W + DESK_COL_GAP);
    const y = startY + row * PER_ROW;
    items.push({
      tab,
      deskX: room.x + x,
      deskY: room.y + y,
      chairX: room.x + x + 1,
      chairY: room.y + y + DESK_H + 1,
      charX:  room.x + x + 1,
      charY:  room.y + y + DESK_H + 1,
      standX: room.x + x,
      standY: room.y + y + DESK_H + 1,
    });
  });
  return items;
}

// Build the room-states for a scene from the current tabStatus. Separated so
// the renderer can refresh counts + door lights without rebuilding the whole
// Scene (which would reset the camera). Codex r2 P2-2.
export function buildRoomStates(rooms, tabStatus) {
  return rooms.map((r) => {
    if (r.kind !== 'office') return { room: r, counts: { working: 0, done: 0, idle: 0, needs: 0 }, light: 'off' };
    const counts = { working: 0, done: 0, idle: 0, needs: 0 };
    for (const t of r.tabs) counts[tabStatus[t.id] || 'idle'] += 1;
    const light = counts.needs > 0 ? 'red' : counts.working > 0 ? 'green' : counts.done > 0 ? 'amber' : 'off';
    return { room: r, counts, light };
  });
}

// Build the scene. Pure: no DOM, no store references.
export function buildScene({ tabs, tabStatus, projectName }) {
  // Group tabs by projectPath. In a single Dobius window the current project
  // dominates; the renderer still handles multiple cleanly.
  const groups = new Map();
  for (const t of tabs) {
    const key = t.projectPath || 'other';
    if (!groups.has(key)) {
      groups.set(key, {
        projectPath: key,
        projectName: (t.projectPath || '').split('/').filter(Boolean).pop() || projectName || 'project',
        tabs: [],
      });
    }
    groups.get(key).tabs.push(t);
  }

  // Layout: lobby on top-left of row 0, then project rooms in a two-column
  // grid starting at row 0. Project rows fill horizontally first, then wrap.
  // Corridor runs along the south edge of each row of rooms AND vertically
  // down the gap between columns, so every door opens into shared hallway.
  const projectEntries = [...groups.values()];
  const ROOMS_PER_ROW = 3;
  const rooms = [];
  const lobby = {
    kind: 'lobby',
    x: 0, y: 0, w: LOBBY_W, h: LOBBY_H,
    projectName: 'Dobius+ Lobby',
    projectPath: '__lobby__',
    tabs: [],
    doorAt: { x: Math.floor(LOBBY_W / 2), y: LOBBY_H - 1 },
    boardAt: { x: 2, y: 1, w: 12, h: 6 },
    floorTile: 'floor-lobby',
    seed: 0,
  };
  rooms.push(lobby);

  // Row 0 has the lobby + up to (ROOMS_PER_ROW-1) project rooms beside it.
  // Rows after that are full rows of project rooms. Each row's height is set
  // by the tallest room in it.
  const rowSizes = []; // {y, h, rooms[]}
  let rowY = 0;
  let rowH = LOBBY_H;
  let colX = LOBBY_W + INTER_ROOM_GAP;
  let colsLeft = ROOMS_PER_ROW - 1;
  let rowRooms = [lobby];
  for (let i = 0; i < projectEntries.length; i += 1) {
    const g = projectEntries[i];
    const sz = roomSizeForTabs(g.tabs.length);
    const room = {
      kind: 'office',
      x: colX, y: rowY, w: sz.w, h: sz.h,
      projectName: g.projectName,
      projectPath: g.projectPath,
      tabs: g.tabs,
      doorAt: { x: Math.floor(sz.w / 2), y: sz.h - 1 },
      floorTile: FLOOR_PALETTE[i % FLOOR_PALETTE.length],
      seed: stringHash(g.projectPath),
    };
    rooms.push(room);
    rowRooms.push(room);
    colX += sz.w + INTER_ROOM_GAP;
    if (sz.h > rowH) rowH = sz.h;
    colsLeft -= 1;
    if (colsLeft === 0 && i < projectEntries.length - 1) {
      rowSizes.push({ y: rowY, h: rowH, rooms: rowRooms });
      rowY += rowH + INTER_ROW_GAP;
      rowH = 0;
      colX = 0;
      colsLeft = ROOMS_PER_ROW;
      rowRooms = [];
    }
  }
  rowSizes.push({ y: rowY, h: rowH, rooms: rowRooms });

  // Corridor segments: one horizontal strip south of every row, spanning the
  // full width used by any row. The rendered corridor fills these strips
  // with floor and bounds them with wall tiles.
  const floorWidth = Math.max(
    ...rowSizes.map((r) => r.rooms.reduce((acc, room) => Math.max(acc, room.x + room.w), 0)),
  );
  const corridorStrips = rowSizes.map((r) => ({
    x: 0,
    y: r.y + r.h,
    w: floorWidth,
    h: CORRIDOR_H,
  }));
  const corridor = corridorStrips[corridorStrips.length - 1];

  // Per-tab desk+chair+character positions.
  const desks = [];
  for (const room of rooms) {
    if (room.kind !== 'office') continue;
    desks.push(...layoutDesksInRoom(room, room.tabs));
  }

  const roomStates = buildRoomStates(rooms, tabStatus);

  // World bounds for the camera auto-fit.
  const bounds = {
    x: 0,
    y: 0,
    w: floorWidth,
    h: corridorStrips[corridorStrips.length - 1].y + CORRIDOR_H,
  };

  return { rooms, roomStates, corridor, corridorStrips, desks, bounds };
}

export const LAYOUT = { DESK_W, DESK_H, CHAIR_OFFSET, DESKS_PER_ROW, ROOM_MIN_W, ROOM_MIN_H, LOBBY_W, LOBBY_H };
