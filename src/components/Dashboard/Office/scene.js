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
const DESKS_PER_ROW = 4;
const DESK_COL_GAP = 1;
const DESK_ROW_GAP = 2;
const ROOM_MARGIN = 2;
const CORRIDOR_H = 3;
const ROOM_MIN_W = 14;
const ROOM_MIN_H = 10;
const LOBBY_W = 20;
const LOBBY_H = 10;
const INTER_ROOM_GAP = 2;

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

  // Lobby in top-left; project rooms to the right, in insertion order.
  const rooms = [];
  const lobby = {
    kind: 'lobby',
    x: 0, y: 0, w: LOBBY_W, h: LOBBY_H,
    projectName: 'Dobius+ Lobby',
    projectPath: '__lobby__',
    tabs: [],
    doorAt: { x: Math.floor(LOBBY_W / 2), y: LOBBY_H - 1 },
    boardAt: { x: 2, y: 1, w: 6, h: 2 },
    seed: 0,
  };
  rooms.push(lobby);

  let cursorX = LOBBY_W + INTER_ROOM_GAP;
  for (const g of groups.values()) {
    const sz = roomSizeForTabs(g.tabs.length);
    const room = {
      kind: 'office',
      x: cursorX, y: 0, w: sz.w, h: sz.h,
      projectName: g.projectName,
      projectPath: g.projectPath,
      tabs: g.tabs,
      doorAt: { x: Math.floor(sz.w / 2), y: sz.h - 1 },
      seed: stringHash(g.projectPath),
    };
    rooms.push(room);
    cursorX += sz.w + INTER_ROOM_GAP;
  }

  // Corridor runs along the south edge of all rooms.
  const corridor = {
    x: 0,
    y: Math.max(...rooms.map((r) => r.y + r.h)),
    w: cursorX,
    h: CORRIDOR_H,
  };

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
    w: cursorX,
    h: corridor.y + corridor.h,
  };

  return { rooms, roomStates, corridor, desks, bounds };
}

export const LAYOUT = { DESK_W, DESK_H, CHAIR_OFFSET, DESKS_PER_ROW, ROOM_MIN_W, ROOM_MIN_H, LOBBY_W, LOBBY_H };
