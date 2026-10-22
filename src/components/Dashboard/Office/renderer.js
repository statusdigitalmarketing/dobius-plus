// Canvas renderer for the Office view. Draws from the Kenney RPG Urban Pack
// atlas (CC0, loaded via sprites.js). Scene geometry stays in tiles; this file
// turns tile coordinates into drawImage calls on the atlas.
//
// Perspective: top-down. Walls are the north/south/east/west perimeter of each
// room; characters, desks and chairs sit inside. Characters south of their
// desks are naturally occluded by the room above them because we draw in
// y-sorted order at the character pass.
import { SPRITES, TILES } from './sprites.js';

const T = SPRITES.tileSize; // 16

const DOOR_LIGHT_COLORS = {
  red: '#e23b3b',
  green: '#37c871',
  amber: '#e4b43a',
  off: '#2b2b31',
};

function fillTiles(ctx, name, tx, ty, tw, th) {
  for (let y = 0; y < th; y += 1) {
    for (let x = 0; x < tw; x += 1) {
      SPRITES.draw(ctx, name, (tx + x) * T, (ty + y) * T);
    }
  }
}

// Draw the shell of a room: floor across interior, wall tiles around perimeter.
function drawRoom(ctx, room) {
  const floor = room.floorTile || (room.kind === 'lobby' ? 'floor-lobby' : 'floor-office');
  fillTiles(ctx, floor, room.x + 1, room.y + 1, room.w - 2, room.h - 2);
  // Perimeter walls.
  SPRITES.draw(ctx, 'wall-corner-nw', room.x * T, room.y * T);
  SPRITES.draw(ctx, 'wall-corner-ne', (room.x + room.w - 1) * T, room.y * T);
  SPRITES.draw(ctx, 'wall-corner-sw', room.x * T, (room.y + room.h - 1) * T);
  SPRITES.draw(ctx, 'wall-corner-se', (room.x + room.w - 1) * T, (room.y + room.h - 1) * T);
  for (let x = 1; x < room.w - 1; x += 1) {
    SPRITES.draw(ctx, 'wall-top', (room.x + x) * T, room.y * T);
    const isDoor = x === room.doorAt.x;
    SPRITES.draw(ctx, isDoor ? 'wall-door' : 'wall-front', (room.x + x) * T, (room.y + room.h - 1) * T);
  }
  for (let y = 1; y < room.h - 1; y += 1) {
    SPRITES.draw(ctx, 'wall-left',  room.x * T,                 (room.y + y) * T);
    SPRITES.draw(ctx, 'wall-right', (room.x + room.w - 1) * T,  (room.y + y) * T);
  }
}

// Wall clock. The sheet has a round object; we draw hands procedurally on top.
function drawClock(ctx, worldX, worldY, now) {
  SPRITES.draw(ctx, 'clock', worldX * T, worldY * T);
  const d = new Date(now);
  const minF = d.getMinutes() + d.getSeconds() / 60;
  const hrF  = (d.getHours() % 12) + minF / 60;
  const cx = worldX * T + 8;
  const cy = worldY * T + 8;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = '#1a1a1f';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  const minA = (minF / 60) * Math.PI * 2 - Math.PI / 2;
  ctx.moveTo(0, 0);
  ctx.lineTo(Math.cos(minA) * 4.5, Math.sin(minA) * 4.5);
  ctx.stroke();
  ctx.lineWidth = 1.2;
  const hrA = (hrF / 12) * Math.PI * 2 - Math.PI / 2;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(Math.cos(hrA) * 3, Math.sin(hrA) * 3);
  ctx.stroke();
  ctx.restore();
}

// Window with daylight tint behind the Kenney window frame.
function drawWindow(ctx, worldX, worldY, now) {
  SPRITES.draw(ctx, 'window', worldX * T, worldY * T);
  const h = new Date(now).getHours();
  const sky = (h >= 7 && h < 17) ? '#9bd0ff' : (h >= 17 && h < 20) ? '#f1a267' : '#1a2238';
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = sky;
  ctx.fillRect(worldX * T + 3, worldY * T + 3, 10, 10);
  ctx.restore();
}

// Shadow under a tile-sized sprite: a 1-pixel-feathered dark ellipse.
function dropShadow(ctx, worldX, worldY, scale = 1) {
  const cx = worldX * T + 8;
  const cy = worldY * T + 14;
  ctx.save();
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(cx, cy, 5 * scale, 2 * scale, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Furniture per room.
function drawRoomFurniture(ctx, room, now) {
  if (room.kind === 'lobby') {
    SPRITES.draw(ctx, 'wall-board', (room.x + room.boardAt.x) * T, (room.y + room.boardAt.y) * T);
    SPRITES.draw(ctx, 'wall-board', (room.x + room.boardAt.x + 1) * T, (room.y + room.boardAt.y) * T);
    SPRITES.draw(ctx, 'wall-board', (room.x + room.boardAt.x + 2) * T, (room.y + room.boardAt.y) * T);
    dropShadow(ctx, room.x + 2, room.y + room.h - 3);
    SPRITES.draw(ctx, 'couch', (room.x + 2) * T, (room.y + room.h - 3) * T);
    SPRITES.draw(ctx, 'couch', (room.x + 3) * T, (room.y + room.h - 3) * T);
    SPRITES.draw(ctx, 'plant', (room.x + room.w - 3) * T, (room.y + 2) * T);
    drawClock(ctx, room.x + 1, room.y + 2, now);
    return;
  }
  // Office rooms: coffee machine NE, couch SW (2 tiles), plant NW, clock on
  // left wall, picture-window on north inner wall.
  dropShadow(ctx, room.x + room.w - 3, room.y + 2);
  SPRITES.draw(ctx, 'coffee-machine', (room.x + room.w - 3) * T, (room.y + 2) * T);
  dropShadow(ctx, room.x + 2, room.y + room.h - 3);
  SPRITES.draw(ctx, 'couch',       (room.x + 2) * T, (room.y + room.h - 3) * T);
  SPRITES.draw(ctx, 'couch-right', (room.x + 3) * T, (room.y + room.h - 3) * T);
  SPRITES.draw(ctx, 'plant', (room.x + 1) * T, (room.y + 2) * T);
  drawClock(ctx, room.x + 1, room.y + room.h - 4, now);
  drawWindow(ctx, room.x + room.w - 4, room.y + 1, now);
}

// Desks: a 3-tile-wide counter at the top of each desk slot, with a cyan
// monitor on top. Chair sprite goes at the chair tile below.
function drawDesks(ctx, scene, state) {
  for (const d of scene.desks) {
    const kind = state.kindByTab[d.tab.id] || 'claude';
    const deskName = kind === 'codex' ? 'desk-codex' : 'desk-claude';
    const chairName = kind === 'codex' ? 'chair-codex' : 'chair';
    // Shadow underneath the desk run (fades on the floor).
    for (let i = 0; i < 3; i += 1) {
      dropShadow(ctx, d.deskX + i, d.deskY + 1, 0.9);
    }
    // Desk run: 3 tiles side by side.
    for (let i = 0; i < 3; i += 1) {
      SPRITES.draw(ctx, deskName, (d.deskX + i) * T, d.deskY * T);
    }
    // Monitor on the middle tile. Dark bezel + a glow strip (color depends on
    // status; dim for idle, cyan for working, soft green for done).
    const status = state.statusByTab[d.tab.id] || 'idle';
    const glow = status === 'working' ? '#4ec9b0' : status === 'done' ? '#2a4a3a' : '#1b2229';
    const mx = (d.deskX + 1) * T + 3;
    const my = d.deskY * T + 2;
    ctx.save();
    ctx.fillStyle = '#1a1a1f';
    ctx.fillRect(mx - 1, my - 1, 12, 7);
    ctx.fillStyle = glow;
    ctx.fillRect(mx, my, 10, 5);
    ctx.restore();
    // Chair.
    SPRITES.draw(ctx, chairName, d.chairX * T, d.chairY * T);
  }
}

// Characters. Working/idle characters are SEATED: positioned at the desk row
// itself so the SPRITE OVERLAPS the desk and the top half (head + shoulders)
// sticks up above the monitor. Standing characters (done, needs) move to the
// stand position one tile south of the desk.
function drawCharacters(ctx, scene, state) {
  const ordered = scene.desks.slice().sort((a, b) => a.charY - b.charY);
  for (const d of ordered) {
    const kind = state.kindByTab[d.tab.id] || 'claude';
    const status = state.statusByTab[d.tab.id] || 'idle';
    let poseName;
    let drawX = d.charX;
    let drawY = d.charY;
    const seated = status === 'working' || status === 'idle';
    if (status === 'working') poseName = state.phase % 2 === 0 ? `char-${kind}-work-a` : `char-${kind}-work-b`;
    else if (status === 'idle') poseName = `char-${kind}-idle`;
    else if (status === 'done')  { poseName = `char-${kind}-stand`; drawX = d.standX - 1; drawY = d.standY; }
    else                         { poseName = `char-${kind}-stand`; drawX = d.standX - 1; drawY = d.standY; }
    if (seated) {
      // Seat position: at the desk row with a small vertical nudge so the
      // sprite OVERLAPS the desk tile. The desk renders BEFORE the character
      // but we draw the TOP HALF of the sprite via a sub-rect so the desk
      // front edge visibly occludes the character's torso + legs.
      drawX = d.deskX + 1;
      drawY = d.deskY;
      // Draw the character as a cropped top half (10px of a 16px sprite) so
      // only the head and shoulders show above the monitor row.
      const idx = SPRITES.tileIndex(poseName);
      if (idx != null) {
        const col = idx % 27;
        const row = Math.floor(idx / 27);
        ctx.drawImage(SPRITES.atlas(), col * T, row * T, T, 10, drawX * T, (drawY - 1) * T, T, 10);
      }
      continue; // skip the full-sprite blit below
    }
    if (status === 'needs') {
      // Much more obvious red floor glow (large radial, stronger alpha) so
      // the room reads as alarming at fit-floor zoom.
      ctx.save();
      const cx = drawX * T + T / 2;
      const cy = drawY * T + T;
      const g = ctx.createRadialGradient(cx, cy, 4, cx, cy, 56);
      g.addColorStop(0, 'rgba(226,59,59,0.85)');
      g.addColorStop(0.5, 'rgba(226,59,59,0.35)');
      g.addColorStop(1, 'rgba(226,59,59,0)');
      ctx.fillStyle = g;
      ctx.fillRect(drawX * T - 48, drawY * T - 20, 112, 80);
      ctx.restore();
    }
    SPRITES.draw(ctx, poseName, drawX * T, drawY * T);
  }
}

// Working monitors get a per-frame flicker overlay (abstract code lines,
// NEVER real text).
function drawMonitorFlicker(ctx, scene, state) {
  if (state.reduceMotion) return;
  for (const d of scene.desks) {
    const status = state.statusByTab[d.tab.id] || 'idle';
    if (status !== 'working') continue;
    const sx = (d.deskX + 1) * T + 3;
    const sy = d.deskY * T + 2;
    ctx.save();
    ctx.globalAlpha = 0.55 + 0.35 * Math.sin((state.now + d.deskX * 97) / 180);
    ctx.fillStyle = '#9feecf';
    for (let i = 0; i < 2; i += 1) {
      const yOff = Math.floor((state.now / 70 + i * 23 + d.deskX * 13) % 5);
      const w = 3 + Math.floor((Math.sin((state.now + i * 331 + d.deskX * 41) / 190) + 1) * 3);
      ctx.fillRect(sx + 1, sy + yOff, w, 1);
    }
    ctx.restore();
  }
}

function label(ctx, text, x, y, { size = 7, color = '#e8e8ea', bg = null, align = 'center' } = {}) {
  ctx.save();
  ctx.font = `${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = 'top';
  if (bg) {
    const w = ctx.measureText(text).width + 4;
    ctx.fillStyle = bg;
    const bx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    ctx.fillRect(bx, y - 1, w, size + 2);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawRoomPlaques(ctx, scene, state) {
  for (const rs of scene.roomStates) {
    const r = rs.room;
    if (r.kind !== 'office') continue;
    const px = (r.x + r.doorAt.x + 0.5) * T;
    const py = (r.y + r.h - 1) * T - 10;
    label(ctx, r.projectName.slice(0, 24), px, py, { size: 6, color: '#e8e8ea', bg: '#141418' });
    const color = DOOR_LIGHT_COLORS[rs.light] || DOOR_LIGHT_COLORS.off;
    ctx.save();
    // Larger door light bulb + a bigger halo so the state reads from across
    // the floor at fit-floor zoom. Red doors glow and pulse brightly.
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(px, py - 8, 5, 0, Math.PI * 2);
    ctx.fill();
    if (rs.light === 'red') {
      const alpha = state.reduceMotion ? 0.6 : 0.4 + 0.4 * Math.sin(state.now / 240);
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(px, py - 8, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = Math.max(0.2, alpha * 0.5);
      ctx.beginPath();
      ctx.arc(px, py - 8, 20, 0, Math.PI * 2);
      ctx.fill();
    } else if (rs.light === 'green') {
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.arc(px, py - 8, 9, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

function drawLobbyBoard(ctx, scene, state) {
  const lobby = scene.rooms[0];
  if (!lobby || lobby.kind !== 'lobby') return;
  // Blit the wall-board tile across the full area so the board is a real
  // wall panel, not a tiny patch. Dimensions in tiles from lobby.boardAt.
  for (let yy = 0; yy < lobby.boardAt.h; yy += 1) {
    for (let xx = 0; xx < lobby.boardAt.w; xx += 1) {
      SPRITES.draw(ctx, 'wall-board', (lobby.x + lobby.boardAt.x + xx) * T, (lobby.y + lobby.boardAt.y + yy) * T);
    }
  }
  const bx = (lobby.x + lobby.boardAt.x) * T;
  const by = (lobby.y + lobby.boardAt.y) * T;
  const bw = lobby.boardAt.w * T;
  const bh = lobby.boardAt.h * T;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.78)';
  ctx.fillRect(bx + 2, by + 2, bw - 4, bh - 4);
  ctx.restore();
  label(ctx, 'FLEET STATUS', bx + bw / 2, by + 4, { size: 7, color: '#4ec9b0' });
  const projCol = bx + 8;
  const dataLeft = bx + Math.floor(bw * 0.4);
  const dataW = bw - (dataLeft - bx) - 8;
  const headers = [
    { k: 'working', color: '#e4b43a', label: 'WORK' },
    { k: 'done',    color: '#37c871', label: 'DONE' },
    { k: 'idle',    color: '#6b6b73', label: 'IDLE' },
    { k: 'needs',   color: '#e23b3b', label: 'NEED' },
  ];
  const colW = dataW / headers.length;
  for (let i = 0; i < headers.length; i += 1) {
    const s = headers[i];
    label(ctx, s.label, dataLeft + i * colW + colW / 2, by + 16, { size: 5, color: s.color });
  }
  const officeRooms = scene.roomStates.filter((rs) => rs.room.kind === 'office');
  const rowTop = by + 26;
  const availH = bh - 26 - 10;
  const rowH = Math.max(7, Math.floor(availH / Math.max(1, officeRooms.length)));
  for (let i = 0; i < officeRooms.length; i += 1) {
    const rs = officeRooms[i];
    const ry = rowTop + i * rowH;
    label(ctx, rs.room.projectName.slice(0, 14), projCol, ry, { size: 5, color: '#e8e8ea', align: 'left' });
    for (let j = 0; j < headers.length; j += 1) {
      const h = headers[j];
      const v = rs.counts[h.k];
      label(ctx, String(v), dataLeft + j * colW + colW / 2, ry, { size: 6, color: v > 0 ? h.color : '#2a2a2f' });
    }
  }
  const events = state.ticker || [];
  if (events.length > 0) {
    const full = events.map((e) => `  * ${e}  `).join('   ');
    const scrollSpeed = state.reduceMotion ? 0 : 24;
    const tickerTop = by + bh - 9;
    ctx.save();
    ctx.beginPath();
    ctx.rect(bx + 4, tickerTop - 1, bw - 8, 8);
    ctx.clip();
    ctx.fillStyle = '#141418';
    ctx.fillRect(bx + 4, tickerTop - 1, bw - 8, 8);
    if (state.reduceMotion) {
      label(ctx, full, bx + 6, tickerTop, { size: 5, color: '#9feecf', align: 'left' });
    } else {
      ctx.font = '5px ui-monospace, SFMono-Regular, Menlo, monospace';
      const totalW = ctx.measureText(full).width;
      const off = (state.now / 1000 * scrollSpeed) % Math.max(1, totalW + bw);
      label(ctx, full, bx + bw - 4 - off, tickerTop, { size: 5, color: '#9feecf', align: 'left' });
    }
    ctx.restore();
  }
}

const STATUS_CHIP = {
  working: { bg: '#3b2f12', fg: '#e4b43a', text: 'WORK' },
  done:    { bg: '#13311f', fg: '#37c871', text: 'DONE' },
  idle:    { bg: '#1f1f22', fg: '#8a8a93', text: 'IDLE' },
  needs:   { bg: '#3b1414', fg: '#ff8a8a', text: 'NEEDS YOU' },
};

function drawCharacterOverlays(ctx, scene, state) {
  for (const d of scene.desks) {
    const status = state.statusByTab[d.tab.id] || 'idle';
    const seated = status === 'working' || status === 'idle';
    // Overlay position must match where drawCharacters drew the sprite:
    // seated = (deskX+1, deskY-1) top half; standing = (standX-1, standY).
    const cx = seated ? d.deskX + 1 : d.standX - 1;
    const cy = seated ? d.deskY - 1 : d.standY;
    const headTop = (cy - 1) * T + 8;
    // Always-on status chip + tab label stacked above the character. Reads at
    // a glance across the floor so the viewer can tell what each person is
    // doing without hovering.
    const chip = STATUS_CHIP[status] || STATUS_CHIP.idle;
    const chipX = cx * T + T / 2;
    const chipY = (cy - 2) * T + 4;
    label(ctx, chip.text, chipX, chipY, { size: 4, color: chip.fg, bg: chip.bg });
    const labelText = String(d.tab.label || '').slice(0, 18);
    if (labelText) label(ctx, labelText, chipX, chipY + 6, { size: 4, color: '#e8e8ea', bg: '#141418' });
    if (status === 'idle') {
      ctx.save();
      ctx.fillStyle = '#9db4c7';
      ctx.font = '7px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const bob = state.reduceMotion ? 0 : Math.round(Math.sin(state.now / 320) * 1);
      ctx.fillText('z', cx * T + 10, headTop - 3 + bob);
      ctx.fillText('z', cx * T + 12, headTop - 7 + bob);
      ctx.restore();
    } else if (status === 'needs') {
      // Much larger pulsing red "!" bubble so it is unmissable at fit-floor
      // zoom. White stroke around the circle for contrast against the floor.
      const scale = state.reduceMotion ? 1.5 : 1.3 + 0.25 * Math.sin(state.now / 180);
      const bx = cx * T + 8;
      const by = headTop - 10;
      ctx.save();
      ctx.translate(bx, by);
      ctx.scale(scale, scale);
      ctx.fillStyle = '#e23b3b';
      ctx.beginPath();
      ctx.arc(0, 0, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 10px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', 0, 0);
      ctx.restore();
    } else if (status === 'working') {
      const verb = state.verbByTab[d.tab.id];
      if (verb) {
        const bx = cx * T + 7;
        const by = headTop - 5;
        label(ctx, verb.slice(0, 20), bx, by, { size: 5, color: '#111', bg: '#f3f3f6' });
      }
    }
  }
}

// Draw every corridor strip as a proper hallway: floor tiles + a wall tile
// along the south edge so the corridor reads as an enclosed space, not an
// open gray bar. Each room's south door already punctuates the north edge.
function drawCorridor(ctx, scene) {
  const strips = scene.corridorStrips || (scene.corridor ? [scene.corridor] : []);
  for (const c of strips) {
    if (!c || c.w <= 0 || c.h <= 0) continue;
    fillTiles(ctx, 'floor-corridor', c.x, c.y, c.w, c.h);
    // South wall across the full strip width.
    for (let x = 0; x < c.w; x += 1) {
      SPRITES.draw(ctx, 'wall-front', (c.x + x) * T, (c.y + c.h) * T);
    }
  }
}

export function drawScene(ctx, scene, camera, state) {
  const viewport = { w: ctx.canvas.width, h: ctx.canvas.height };
  ctx.fillStyle = '#07070a';
  ctx.fillRect(0, 0, viewport.w, viewport.h);
  // Draw a "letterbox" message if the atlas is not yet loaded.
  if (!SPRITES.isReady()) {
    ctx.fillStyle = '#8a8a93';
    ctx.font = '14px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('loading office...', viewport.w / 2, viewport.h / 2);
    return;
  }
  ctx.save();
  ctx.translate(viewport.w / 2, viewport.h / 2);
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(-camera.x * T, -camera.y * T);
  ctx.imageSmoothingEnabled = false;
  drawCorridor(ctx, scene);
  for (const room of scene.rooms) drawRoom(ctx, room);
  for (const room of scene.rooms) drawRoomFurniture(ctx, room, state.now);
  drawDesks(ctx, scene, state);
  drawCharacters(ctx, scene, state);
  drawMonitorFlicker(ctx, scene, state);
  drawCharacterOverlays(ctx, scene, state);
  drawRoomPlaques(ctx, scene, state);
  drawLobbyBoard(ctx, scene, state);
  ctx.restore();
}

export function hitTest(scene, camera, viewport, px, py, statusByTab = {}) {
  const sx = (px - viewport.w / 2) / camera.zoom + camera.x * T;
  const sy = (py - viewport.h / 2) / camera.zoom + camera.y * T;
  const tileX = sx / T;
  const tileY = sy / T;
  for (const d of scene.desks) {
    const st = statusByTab[d.tab.id];
    const standing = st === 'needs' || st === 'done';
    // Seated characters now draw at (deskX+1, deskY-1), standing at
    // (standX-1, standY). Hit-test both so a click near the character sprite
    // opens the tab regardless of pose.
    const cx = standing ? (d.standX - 1) + 0.5 : d.deskX + 1.5;
    const cy = (standing ? d.standY : d.deskY - 1) + 0.5;
    const inSeat = Math.abs(tileX - cx) < 2 && Math.abs(tileY - cy) < 2;
    if (inSeat) return { type: 'char', tabId: d.tab.id };
  }
  for (const r of scene.rooms) {
    if (tileX >= r.x && tileX < r.x + r.w && tileY >= r.y && tileY < r.y + r.h) {
      return { type: 'room', room: r };
    }
  }
  return null;
}
