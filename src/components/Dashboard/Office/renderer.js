// Canvas renderer for the Office view. Pure, no React, no store. Called by
// the RAF loop in OfficeView.jsx. Draws everything from the Scene + a state
// bag the view keeps on the side (status map, verbs, phase, now, recording).
//
// Perspective: 3/4 top-down. Walls are drawn as part of the tile pass, so a
// character sitting at a desk north of their chair tile is naturally occluded
// by the north wall-top tile of the room ABOVE them. All tile coordinates
// are in sprite units (sprites.tileSize = 16); the camera transform scales.
import { SPRITES } from './sprites.js';

const T = SPRITES.tileSize; // 16

const DOOR_LIGHT_COLORS = {
  red: '#e23b3b',
  green: '#37c871',
  amber: '#e4b43a',
  off: '#2b2b31',
};

function blit(ctx, name, x, y, w, h) {
  const img = SPRITES.get(name);
  if (!img) { ctx.fillStyle = '#ff00ff'; ctx.fillRect(x, y, w || T, h || T); return; }
  ctx.drawImage(img, x, y, w || img.width, h || img.height);
}

// Fill a rectangular area (in tiles) with repeated copies of a tile sprite.
function fillTiles(ctx, name, tx, ty, tw, th) {
  const img = SPRITES.get(name);
  if (!img) return;
  for (let y = 0; y < th; y += 1) {
    for (let x = 0; x < tw; x += 1) {
      ctx.drawImage(img, (tx + x) * T, (ty + y) * T);
    }
  }
}

// Draw the shell of a room: floor tiles inside, walls around the perimeter.
// The door tile replaces a wall segment at room.doorAt (relative coord in the
// south wall).
function drawRoom(ctx, room) {
  const floor = room.kind === 'lobby' ? 'floor-lobby' : 'floor-office';
  // Floor fills the interior (excluding walls, so one tile in from each edge).
  fillTiles(ctx, floor, room.x + 1, room.y + 1, room.w - 2, room.h - 2);
  // North wall (top row): corners + top tiles.
  blit(ctx, 'wall-corner-nw', room.x * T, room.y * T);
  blit(ctx, 'wall-corner-ne', (room.x + room.w - 1) * T, room.y * T);
  for (let x = 1; x < room.w - 1; x += 1) {
    blit(ctx, 'wall-top', (room.x + x) * T, room.y * T);
  }
  // South wall (bottom row): corners + front tiles, door inserted at doorAt.x.
  blit(ctx, 'wall-corner-sw', room.x * T, (room.y + room.h - 1) * T);
  blit(ctx, 'wall-corner-se', (room.x + room.w - 1) * T, (room.y + room.h - 1) * T);
  for (let x = 1; x < room.w - 1; x += 1) {
    const isDoor = x === room.doorAt.x;
    blit(ctx, isDoor ? 'wall-door' : 'wall-front', (room.x + x) * T, (room.y + room.h - 1) * T);
  }
  // East + west walls.
  for (let y = 1; y < room.h - 1; y += 1) {
    blit(ctx, 'wall-left',  room.x * T,                     (room.y + y) * T);
    blit(ctx, 'wall-right', (room.x + room.w - 1) * T,      (room.y + y) * T);
  }
}

// Clock face + current-time hands.
function drawClock(ctx, worldX, worldY, now) {
  blit(ctx, 'clock', worldX * T, worldY * T);
  const d = new Date(now);
  const sec = d.getSeconds();
  const minF = d.getMinutes() + sec / 60;
  const hrF  = (d.getHours() % 12) + minF / 60;
  const cx = worldX * T + 8;
  const cy = worldY * T + 8;
  ctx.save();
  ctx.translate(cx, cy);
  // Minute hand (longer).
  ctx.strokeStyle = '#1a1a1f';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  const minA = (minF / 60) * Math.PI * 2 - Math.PI / 2;
  ctx.moveTo(0, 0);
  ctx.lineTo(Math.cos(minA) * 4.5, Math.sin(minA) * 4.5);
  ctx.stroke();
  // Hour hand (shorter, thicker).
  ctx.lineWidth = 1.2;
  const hrA = (hrF / 12) * Math.PI * 2 - Math.PI / 2;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(Math.cos(hrA) * 3, Math.sin(hrA) * 3);
  ctx.stroke();
  ctx.restore();
}

// Window sky tint based on local time. Day 7-18, dusk 18-20, night 20-7.
function skyColor(now) {
  const h = new Date(now).getHours();
  if (h >= 7 && h < 17) return '#9bd0ff';
  if (h >= 17 && h < 20) return '#f1a267';
  return '#1a2238';
}

function drawWindow(ctx, worldX, worldY, now) {
  // Blit the base window frame, then overlay the sky color through the 'glass'
  // area. The glass area in WINDOW is a 2-wide pattern at rows 3-10, cols 3-29.
  blit(ctx, 'window', worldX * T, worldY * T);
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  ctx.fillStyle = skyColor(now);
  ctx.globalAlpha = 0.75;
  ctx.fillRect(worldX * T + 3, worldY * T + 3, 29, 8);
  ctx.restore();
}

// Furniture inside a room: coffee machine + couch (south corners), two plants
// in the north corners, clock on left wall, window on right wall. Positions
// shift slightly per room.seed so neighbor rooms are not identical.
function drawRoomFurniture(ctx, room, now) {
  if (room.kind === 'lobby') {
    // Lobby's wall board (3x2 tiles on north wall) + a couch.
    blit(ctx, 'wall-board', (room.x + room.boardAt.x) * T, (room.y + room.boardAt.y) * T);
    blit(ctx, 'couch', (room.x + 2) * T, (room.y + room.h - 3) * T);
    blit(ctx, 'plant', (room.x + room.w - 3) * T, (room.y + 2) * T);
    drawClock(ctx, room.x + 1, room.y + 2, now);
    return;
  }
  // Coffee machine in the north-east corner, couch in the south-west.
  blit(ctx, 'coffee-machine', (room.x + room.w - 3) * T, (room.y + 2) * T);
  blit(ctx, 'couch',         (room.x + 2) * T,          (room.y + room.h - 3) * T);
  blit(ctx, 'plant',         (room.x + 1) * T,          (room.y + 2) * T);
  // Clock on the left wall interior; window on the right wall interior.
  drawClock(ctx, room.x + 1, room.y + room.h - 4, now);
  drawWindow(ctx, room.x + room.w - 4, room.y + 1, now);
}

// Draw desks and chairs per tab.
function drawDesks(ctx, scene, state) {
  for (const d of scene.desks) {
    const kind = state.kindByTab[d.tab.id] || 'claude';
    blit(ctx, kind === 'codex' ? 'desk-codex' : 'desk-claude', d.deskX * T, d.deskY * T);
    blit(ctx, 'chair', d.chairX * T, d.chairY * T);
  }
}

// Draw characters per tab. Pose depends on status; working flips arms per phase.
function drawCharacters(ctx, scene, state) {
  // Sort desks by Y so southern characters render in front of northern ones.
  const ordered = scene.desks.slice().sort((a, b) => a.charY - b.charY);
  for (const d of ordered) {
    const kind = state.kindByTab[d.tab.id] || 'claude';
    const status = state.statusByTab[d.tab.id] || 'idle';
    let pose;
    let drawX = d.charX;
    let drawY = d.charY;
    if (status === 'working') pose = state.phase % 2 === 0 ? 'work-a' : 'work-b';
    else if (status === 'idle') pose = 'idle';
    else if (status === 'done') { pose = 'stand'; drawX = d.standX - 1; drawY = d.standY; }
    else if (status === 'needs') { pose = 'stand'; drawX = d.standX - 1; drawY = d.standY; }
    else pose = 'idle';
    // Red floor glow underneath a 'needs' character.
    if (status === 'needs') {
      ctx.save();
      const cx = drawX * T + T / 2;
      const cy = drawY * T + T;
      const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, 24);
      g.addColorStop(0, 'rgba(226,59,59,0.6)');
      g.addColorStop(1, 'rgba(226,59,59,0)');
      ctx.fillStyle = g;
      ctx.fillRect(drawX * T - 12, drawY * T - 2, 32, 28);
      ctx.restore();
    }
    blit(ctx, `char-${kind}-${pose}`, drawX * T, (drawY - 1) * T);
  }
}

// Working monitors get a per-frame flicker overlay (abstract code lines,
// NEVER real text, per the hard rule).
function drawMonitorFlicker(ctx, scene, state) {
  if (state.reduceMotion) return;
  for (const d of scene.desks) {
    const status = state.statusByTab[d.tab.id] || 'idle';
    if (status !== 'working') continue;
    // Monitor is in the first 2 rows of the desk sprite, roughly cols 5-28 of a
    // 48px desk. Draw 2 or 3 short pseudo-random horizontal lines.
    const sx = d.deskX * T + 5;
    const sy = d.deskY * T + 5;
    const lw = 22;
    const lh = 7;
    ctx.save();
    ctx.globalAlpha = 0.55 + 0.35 * Math.sin((state.now + d.deskX * 97) / 180);
    ctx.fillStyle = '#9feecf';
    // Three lines of noise.
    for (let i = 0; i < 3; i += 1) {
      const yOff = Math.floor((state.now / 70 + i * 23 + d.deskX * 13) % lh);
      const w = 4 + Math.floor((Math.sin((state.now + i * 331 + d.deskX * 41) / 190) + 1) * (lw / 2 - 2));
      ctx.fillRect(sx + 1, sy + yOff, w, 1);
    }
    ctx.restore();
    // Darken an IDLE monitor: a semi-opaque rect so the screen reads 'off'.
  }
  for (const d of scene.desks) {
    const status = state.statusByTab[d.tab.id] || 'idle';
    if (status === 'idle') {
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(d.deskX * T + 5, d.deskY * T + 5, 22, 7);
      ctx.restore();
    }
  }
}

// Pixel-crisp text rendering. Uses a monospace font sized relative to the
// camera zoom so plaques stay legible when zoomed in and out.
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
    // Plaque text just above the door, white on dark.
    const px = (r.x + r.doorAt.x + 0.5) * T;
    const py = (r.y + r.h - 1) * T - 10;
    label(ctx, r.projectName.slice(0, 24), px, py, { size: 6, color: '#e8e8ea', bg: '#141418' });
    // Door light bulb above the door.
    const color = DOOR_LIGHT_COLORS[rs.light] || DOOR_LIGHT_COLORS.off;
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(px, py - 6, 3, 0, Math.PI * 2);
    ctx.fill();
    if (rs.light === 'red') {
      // Pulse halo for needs. Guarded by reduceMotion so it is static then.
      const alpha = state.reduceMotion ? 0.4 : 0.3 + 0.3 * Math.sin(state.now / 240);
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(px, py - 6, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

// The wall board in the lobby: fleet-wide counts + ticker. The sprite drew the
// bezel; here we overlay the live counts + a scrolling status line.
function drawLobbyBoard(ctx, scene, state) {
  const lobby = scene.rooms[0];
  if (!lobby || lobby.kind !== 'lobby') return;
  // Totals summed across non-lobby rooms.
  const totals = { working: 0, done: 0, idle: 0, needs: 0 };
  for (const rs of scene.roomStates) {
    if (rs.room.kind !== 'office') continue;
    for (const k of ['working', 'done', 'idle', 'needs']) totals[k] += rs.counts[k];
  }
  // The WALL_BOARD sprite is a 3-tile-wide (48px) frame baked at native size,
  // but boardAt.w = 6 tiles for the content layout. Normalize both to the
  // sprite's actual rendered width so the counts and ticker stay inside the
  // bezel (Codex r1 P2-11: IDLE and NEED spilled onto the lobby floor).
  const boardSprite = SPRITES.get('wall-board');
  const bx = (lobby.x + lobby.boardAt.x) * T;
  const by = (lobby.y + lobby.boardAt.y) * T;
  const bw = boardSprite ? boardSprite.width : lobby.boardAt.w * T;
  const bh = boardSprite ? boardSprite.height : lobby.boardAt.h * T;
  // Compressed layout so the ticker fits INSIDE the board (bh = 32):
  //   row 1: 0..6  header
  //   row 2: 7..17 big count numbers
  //   row 3: 18..23 column labels
  //   row 4: 24..31 ticker strip
  label(ctx, 'OFFICE STATUS', bx + bw / 2, by + 1, { size: 5, color: '#4ec9b0' });
  const slots = [
    { k: 'working', color: '#e4b43a', label: 'WORK' },
    { k: 'done',    color: '#37c871', label: 'DONE' },
    { k: 'idle',    color: '#6b6b73', label: 'IDLE' },
    { k: 'needs',   color: '#e23b3b', label: 'NEED' },
  ];
  const colW = bw / 4;
  for (let i = 0; i < slots.length; i += 1) {
    const s = slots[i];
    const cx = bx + i * colW + colW / 2;
    label(ctx, String(totals[s.k]), cx, by + 8, { size: 9, color: s.color });
    label(ctx, s.label, cx, by + 18, { size: 4, color: '#8a8a93' });
  }
  // Ticker: cycle through recent events in a strip INSIDE the board bezel.
  // bh = board sprite height (32); the strip is the bottom 7px of that.
  const events = state.ticker || [];
  if (events.length > 0) {
    const full = events.map((e) => `  * ${e}  `).join('   ');
    const scrollSpeed = state.reduceMotion ? 0 : 20; // px/sec
    const tickerTop = by + bh - 7;
    ctx.save();
    ctx.beginPath();
    ctx.rect(bx, tickerTop, bw, 7);
    ctx.clip();
    if (state.reduceMotion) {
      label(ctx, full, bx + 4, tickerTop, { size: 5, color: '#9feecf', align: 'left' });
    } else {
      ctx.font = '5px ui-monospace, SFMono-Regular, Menlo, monospace';
      const totalW = ctx.measureText(full).width;
      const off = (state.now / 1000 * scrollSpeed) % Math.max(1, totalW + bw);
      label(ctx, full, bx + bw - off, tickerTop, { size: 5, color: '#9feecf', align: 'left' });
    }
    ctx.restore();
  }
}

// Per-character status overlays: idle Z, needs !, working verb bubble.
function drawCharacterOverlays(ctx, scene, state) {
  for (const d of scene.desks) {
    const status = state.statusByTab[d.tab.id] || 'idle';
    const cx = (status === 'working' || status === 'idle') ? d.charX : d.standX - 1;
    const cy = (status === 'working' || status === 'idle') ? d.charY : d.standY;
    const headTop = (cy - 1) * T; // one tile above the character's head rect
    if (status === 'idle') {
      // Z bubble.
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
      // Red ! bubble above head, with pulse.
      const scale = state.reduceMotion ? 1 : 1 + 0.12 * Math.sin(state.now / 180);
      const bx = cx * T + 7;
      const by = headTop - 7;
      ctx.save();
      ctx.translate(bx, by);
      ctx.scale(scale, scale);
      ctx.fillStyle = '#e23b3b';
      ctx.beginPath();
      ctx.arc(0, 0, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 7px ui-monospace, Menlo, monospace';
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

// Scrolling corridor floor between rooms. Thin band under the rooms.
function drawCorridor(ctx, scene) {
  const c = scene.corridor;
  if (!c || c.w <= 0 || c.h <= 0) return;
  fillTiles(ctx, 'floor-corridor', c.x, c.y, c.w, c.h);
}

// --- Public ----------------------------------------------------------------

export function drawScene(ctx, scene, camera, state) {
  const viewport = { w: ctx.canvas.width, h: ctx.canvas.height };
  // Clear.
  ctx.fillStyle = '#07070a';
  ctx.fillRect(0, 0, viewport.w, viewport.h);
  // Camera transform (world space in SPRITE PIXELS, scaled up by zoom).
  ctx.save();
  ctx.translate(viewport.w / 2, viewport.h / 2);
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(-camera.x * T, -camera.y * T);
  ctx.imageSmoothingEnabled = false;
  // World.
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

// Hit-test: given screen (px, py), return the hovered item. We take an extra
// statusByTab map so standing characters (done/needs) can be hit at their
// actual drawn position (one tile west of the chair). Codex r1 P1-2: without
// this, clicking a standing character fell through to the room hit and the
// camera zoomed instead of opening the tab.
export function hitTest(scene, camera, viewport, px, py, statusByTab = {}) {
  const sx = (px - viewport.w / 2) / camera.zoom + camera.x * T;
  const sy = (py - viewport.h / 2) / camera.zoom + camera.y * T;
  const tileX = sx / T;
  const tileY = sy / T;
  for (const d of scene.desks) {
    const standing = statusByTab[d.tab.id] === 'needs' || statusByTab[d.tab.id] === 'done';
    const cx = standing ? (d.standX - 1) + 0.5 : d.charX + 0.5;
    const cy = (standing ? d.standY : d.charY) + 0.5;
    const inSeat = Math.abs(tileX - cx) < 1 && Math.abs(tileY - cy) < 2;
    if (inSeat) return { type: 'char', tabId: d.tab.id };
  }
  for (const r of scene.rooms) {
    if (tileX >= r.x && tileX < r.x + r.w && tileY >= r.y && tileY < r.y + r.h) {
      return { type: 'room', room: r };
    }
  }
  return null;
}
