// ============================================================================
// SOLMARA UNDERTOW — hud.js
// Screen-space UI: HUD (health/armor, money, wanted stars, clock, speed),
// the minimap, mission banner + objective tracker, dialog box, interaction
// prompts, and the full-screen states — title, pause, busted, wasted, and
// the campaign-complete screen. Buttons register themselves into
// game.uiButtons each frame; main.js resolves clicks against that list.
// ============================================================================

import { WORLD, ROADS_V, ROADS_H, PLACES } from './config.js';
import { CHARACTERS } from './missions.js';
import { lighting } from './render.js';

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }

function text(ctx, str, x, y, size, color, align = 'left', bold = false) {
  ctx.font = `${bold ? 'bold ' : ''}${size}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(str, x, y);
}

export function button(game, x, y, w, h, label, action, opts = {}) {
  const c = game.ctx;
  const hover = game.input.mouse.x >= x && game.input.mouse.x <= x + w && game.input.mouse.y >= y && game.input.mouse.y <= y + h;
  c.save();
  c.fillStyle = opts.disabled ? 'rgba(60,60,70,0.75)' : hover ? 'rgba(255,209,102,0.92)' : 'rgba(20,22,34,0.82)';
  rr(c, x, y, w, h, 10); c.fill();
  c.strokeStyle = opts.disabled ? '#555' : '#ffd166'; c.lineWidth = 2; c.stroke();
  text(c, label, x + w / 2, y + h / 2 + (opts.size || 19) * 0.36, opts.size || 19, opts.disabled ? '#999' : hover ? '#1b1b26' : '#ffd166', 'center', true);
  c.restore();
  if (!opts.disabled) game.uiButtons.push({ x, y, w, h, action });
  return hover;
}

function star(ctx, cx, cy, r, filled, flash) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = cx + Math.cos(a) * rad, py = cy + Math.sin(a) * rad;
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.closePath();
  if (filled) {
    ctx.fillStyle = flash ? '#ffe9a8' : '#ffd166';
    ctx.shadowColor = '#ffb340'; ctx.shadowBlur = 9;
    ctx.fill();
    ctx.shadowBlur = 0;
  } else {
    ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 1.6; ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
export function drawHUD(game) {
  const { ctx, canvas } = game;
  const W = canvas.width;
  const p = game.player;

  // Health + armor (bottom-left)
  const bx = 22, by = canvas.height - 64;
  ctx.fillStyle = 'rgba(10,12,20,0.55)'; rr(ctx, bx - 8, by - 24, 236, 76, 10); ctx.fill();
  text(ctx, 'RAKA', bx, by - 8, 12, '#ffd166', 'left', true);
  ctx.fillStyle = 'rgba(255,255,255,0.16)'; rr(ctx, bx, by + 2, 220, 13, 6); ctx.fill();
  ctx.fillStyle = p.health > 30 ? '#e63946' : (Math.sin(game.time * 7) > 0 ? '#ff5964' : '#e63946');
  if (p.health > 0) { rr(ctx, bx, by + 2, 220 * Math.max(0, p.health / 100), 13, 6); ctx.fill(); }
  ctx.fillStyle = 'rgba(255,255,255,0.16)'; rr(ctx, bx, by + 22, 220, 9, 5); ctx.fill();
  ctx.fillStyle = '#7cc7ff';
  if (p.armor > 0) { rr(ctx, bx, by + 22, 220 * Math.max(0, p.armor / 100), 9, 5); ctx.fill(); }
  text(ctx, `${Math.max(0, Math.ceil(p.health))}`, bx + 220, by - 8, 12, '#fff', 'right', true);

  // Money (bottom-right) + speed while driving
  text(ctx, `$${game.money.toLocaleString('en-US')}`, W - 24, canvas.height - 30, 30, '#7dff6a', 'right', true);
  if (p.car) {
    const kmh = Math.round(Math.abs(p.car.speed) * 0.55);
    text(ctx, `${kmh} km/h`, W - 24, canvas.height - 66, 17, '#ffffff', 'right', true);
  }

  // Wanted stars (top-right, above minimap is avoided — stars sit top-center-right)
  const searching = game.wanted > 0 && !game.policeSeePlayer;
  for (let i = 0; i < 5; i++) {
    const filled = i < game.wanted;
    const flash = searching && filled && Math.sin(game.time * 5) > 0;
    star(ctx, W - 300 - (4 - i) * 34, 34, 13, filled, flash);
  }
  if (game.wanted > 0 && searching) text(ctx, 'LOSING THEM…', W - 300 - 2 * 34, 62, 11, '#ffe9a8', 'center', true);

  // Clock + district (top-left)
  const L = lighting(game);
  const hh = Math.floor(L.hour), mm = Math.floor((L.hour - hh) * 60);
  const clock = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  ctx.fillStyle = 'rgba(10,12,20,0.5)'; rr(ctx, 16, 14, 196, 52, 9); ctx.fill();
  text(ctx, L.night > 0.5 ? '☾' : '☀', 34, 48, 20, L.night > 0.5 ? '#bcd3ff' : '#ffd166', 'left');
  text(ctx, clock, 62, 49, 21, '#fff', 'left', true);
  text(ctx, game.districtName || 'Solmara', 130, 49, 14, '#ffd9a0', 'left');

  drawMinimap(game);

  // Objective tracker (under minimap)
  const obj = game.missions.objectiveText();
  ctx.font = `13.5px ${FONT}`;
  const ow = Math.min(430, ctx.measureText(obj).width + 46);
  ctx.fillStyle = 'rgba(10,12,20,0.55)';
  rr(ctx, W - 24 - ow, 196, ow, 30, 8); ctx.fill();
  ctx.fillStyle = '#ffd166'; ctx.beginPath(); ctx.arc(W - 24 - ow + 15, 211, 4.5, 0, 7); ctx.fill();
  text(ctx, obj, W - 24 - ow + 27, 217, 13.5, '#fff', 'left');

  // Mission banner (top-center, fades)
  if (game.bannerData && game.bannerT > 0) {
    const a = Math.min(1, game.bannerT / 0.5, (game.bannerDur || 3.2) / 0.5);
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, a));
    const bw = 520;
    ctx.fillStyle = 'rgba(12,13,24,0.78)';
    rr(ctx, W / 2 - bw / 2, 84, bw, 64, 12); ctx.fill();
    ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 1.6; ctx.stroke();
    text(ctx, game.bannerData.title, W / 2, 112, 21, '#ffd166', 'center', true);
    text(ctx, game.bannerData.sub, W / 2, 136, 14.5, '#f2f2f2', 'center');
    ctx.restore();
  }

  // Bust meter
  if (game.bustMeter > 0.02 && game.state === 'playing') {
    const bw = 240;
    ctx.fillStyle = 'rgba(10,12,20,0.6)'; rr(ctx, W / 2 - bw / 2, canvas.height - 108, bw, 20, 9); ctx.fill();
    ctx.fillStyle = game.bustMeter > 0.7 ? '#ff2e4d' : '#ffb340';
    rr(ctx, W / 2 - bw / 2 + 3, canvas.height - 105, (bw - 6) * game.bustMeter, 14, 7); ctx.fill();
    text(ctx, 'BUSTED?', W / 2, canvas.height - 116, 12, '#fff', 'center', true);
  }

  // Interaction prompt
  if (game.promptText && game.state === 'playing') {
    ctx.font = `bold 16px ${FONT}`;
    const tw = ctx.measureText(game.promptText).width + 30;
    ctx.fillStyle = 'rgba(10,12,20,0.72)';
    rr(ctx, W / 2 - tw / 2, canvas.height - 152, tw, 32, 9); ctx.fill();
    text(ctx, game.promptText, W / 2, canvas.height - 130, 16, '#ffd166', 'center', true);
  }

  // Mute / help hints
  text(ctx, game.audio.muted ? 'M — sound off' : 'M — mute · P — pause', W - 24, 24, 11.5, 'rgba(255,255,255,0.55)', 'right');
}

// ---------------------------------------------------------------------------
export function drawMinimap(game) {
  const { ctx, canvas } = game;
  const mw = 196, mh = 160, mx = canvas.width - mw - 20, my = 76;
  const sx = mw / WORLD.w, sy = mh / WORLD.h;
  ctx.save();
  ctx.fillStyle = 'rgba(12,14,22,0.82)';
  rr(ctx, mx - 4, my - 4, mw + 8, mh + 8, 10); ctx.fill();
  ctx.beginPath(); rr(ctx, mx, my, mw, mh, 7); ctx.clip();
  // Districts
  for (const d of DISTRICTS_FOR_MAP) {
    ctx.fillStyle = d.map;
    ctx.fillRect(mx + d.x * sx, my + d.y * sy, d.w * sx, d.h * sy);
  }
  ctx.fillStyle = '#e3cd96'; ctx.fillRect(mx, my + WORLD.sandY * sy, mw, (WORLD.waterY - WORLD.sandY) * sy);
  ctx.fillStyle = '#2b6ea6'; ctx.fillRect(mx, my + WORLD.waterY * sy, mw, (WORLD.h - WORLD.waterY) * sy);
  // Roads
  ctx.strokeStyle = 'rgba(30,30,36,0.85)'; ctx.lineWidth = 2;
  for (const rx of ROADS_V) { ctx.beginPath(); ctx.moveTo(mx + rx * sx, my); ctx.lineTo(mx + rx * sx, my + mh); ctx.stroke(); }
  for (const ry of ROADS_H) { ctx.beginPath(); ctx.moveTo(mx, my + ry * sy); ctx.lineTo(mx + mw, my + ry * sy); ctx.stroke(); }
  const dot = (x, y, color, r = 2.4) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(mx + x * sx, my + y * sy, r, 0, 7); ctx.fill(); };
  for (const c of game.cars) if (!c.dead) dot(c.x, c.y, c.missionTarget ? '#ffd166' : 'rgba(255,255,255,0.55)', c.missionTarget ? 3.4 : 1.8);
  for (const c of game.police) if (!c.dead) dot(c.x, c.y, Math.sin(game.time * 9) > 0 ? '#4da3ff' : '#ff5964', 3);
  const mk = game.missions.marker();
  if (mk) {
    dot(mk.x, mk.y, '#ffd166', 4);
    ctx.strokeStyle = `rgba(255,209,102,${0.6 + 0.4 * Math.sin(game.time * 5)})`;
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(mx + mk.x * sx, my + mk.y * sy, 7 + Math.sin(game.time * 5) * 1.6, 0, 7); ctx.stroke();
  }
  // Player arrow
  const p = game.player;
  ctx.save();
  ctx.translate(mx + p.x * sx, my + p.y * sy);
  ctx.rotate((p.car ? p.car.angle : p.angle) + Math.PI / 2);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.moveTo(0, -6); ctx.lineTo(4.4, 5); ctx.lineTo(0, 2.4); ctx.lineTo(-4.4, 5); ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,209,102,0.5)'; ctx.lineWidth = 1.4;
  rr(ctx, mx - 4, my - 4, mw + 8, mh + 8, 10); ctx.stroke();
}

import { DISTRICTS as DISTRICTS_FOR_MAP } from './config.js';

// ---------------------------------------------------------------------------
export function drawDialog(game) {
  const { ctx, canvas } = game;
  const d = game.dialog;
  if (!d) return;
  const line = d.lines[d.index];
  if (!line) return;
  const W = canvas.width, H = canvas.height;
  const bw = Math.min(860, W - 80), bh = 118, bx = (W - bw) / 2, by = H - bh - 26;
  ctx.save();
  ctx.fillStyle = 'rgba(10,11,20,0.88)';
  rr(ctx, bx, by, bw, bh, 14); ctx.fill();
  ctx.strokeStyle = (CHARACTERS[line.who] || {}).color || '#ffd166';
  ctx.lineWidth = 2; ctx.stroke();
  // Portrait disc with initial
  const pc = (CHARACTERS[line.who] || {}).color || '#888';
  ctx.fillStyle = pc;
  ctx.beginPath(); ctx.arc(bx + 46, by + 46, 26, 0, 7); ctx.fill();
  text(ctx, line.who[0], bx + 46, by + 55, 24, '#14141f', 'center', true);
  text(ctx, line.who, bx + 84, by + 30, 15, pc, 'left', true);
  // Wrapped body text
  ctx.font = `16.5px ${FONT}`;
  ctx.fillStyle = '#f4f1ea';
  ctx.textAlign = 'left';
  wrapText(ctx, line.text, bx + 84, by + 56, bw - 110, 21);
  text(ctx, `${d.index + 1}/${d.lines.length} · Enter ▸`, bx + bw - 16, by + bh - 12, 12, 'rgba(255,255,255,0.6)', 'right');
  ctx.restore();
}

function wrapText(ctx, str, x, y, maxW, lh) {
  const words = str.split(' ');
  let line = '', yy = y;
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, yy); line = w; yy += lh;
    } else line = test;
  }
  if (line) ctx.fillText(line, x, yy);
}

// ---------------------------------------------------------------------------
// Title screen: painted sunset vista of Solmara + menu.
// ---------------------------------------------------------------------------
export function drawTitle(game) {
  const { ctx, canvas } = game;
  const W = canvas.width, H = canvas.height;
  const t = game.time;
  // Sky
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#2b1055');
  sky.addColorStop(0.42, '#7597de');
  sky.addColorStop(0.62, '#ff9a5a');
  sky.addColorStop(0.78, '#ff5d8f');
  sky.addColorStop(1, '#1d1b2e');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
  // Sun low over the bay
  const sunY = H * 0.66;
  const sg = ctx.createRadialGradient(W * 0.5, sunY, 8, W * 0.5, sunY, 190);
  sg.addColorStop(0, 'rgba(255,230,160,0.95)');
  sg.addColorStop(0.25, 'rgba(255,170,90,0.55)');
  sg.addColorStop(1, 'rgba(255,120,90,0)');
  ctx.fillStyle = sg; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#ffd98a';
  ctx.beginPath(); ctx.arc(W * 0.5, sunY, 44, 0, 7); ctx.fill();
  // Skyline silhouettes (two depths) with lit windows
  drawSkyline(ctx, W, sunY + 6, H * 0.30, '#3a2350', 7, t);
  drawSkyline(ctx, W, sunY + 10, H * 0.22, '#241433', 13, t);
  // Water with sun reflection
  const wg = ctx.createLinearGradient(0, sunY + 8, 0, H);
  wg.addColorStop(0, '#7a3b69'); wg.addColorStop(1, '#14263f');
  ctx.fillStyle = wg; ctx.fillRect(0, sunY + 8, W, H - sunY);
  ctx.fillStyle = 'rgba(255,205,120,0.5)';
  for (let i = 0; i < 26; i++) {
    const wob = Math.sin(t * 1.7 + i * 1.3) * 7;
    const y = sunY + 20 + i * ((H - sunY - 26) / 26);
    const len = 90 - i * 2.4;
    ctx.fillRect(W * 0.5 - len / 2 + wob, y, len, 2.4);
  }
  // Palms silhouettes at the edges
  drawPalm(ctx, 74, H - 8, 1.15, '#160f24');
  drawPalm(ctx, W - 84, H - 6, -1.05, '#160f24');

  // Title block
  ctx.save();
  ctx.textAlign = 'center';
  ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 18;
  ctx.fillStyle = '#ffffff';
  ctx.font = `900 ${Math.min(96, W * 0.085)}px ${FONT}`;
  ctx.fillText('S O L M A R A', W / 2, H * 0.20);
  const grad = ctx.createLinearGradient(W / 2 - 260, 0, W / 2 + 260, 0);
  grad.addColorStop(0, '#ffd166'); grad.addColorStop(0.5, '#ff5d8f'); grad.addColorStop(1, '#39d5e8');
  ctx.fillStyle = grad;
  ctx.font = `900 ${Math.min(64, W * 0.056)}px ${FONT}`;
  ctx.fillText('U N D E R T O W', W / 2, H * 0.20 + Math.min(70, W * 0.062));
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = `16.5px ${FONT}`;
  ctx.fillText('Raka owes the wrong man twelve grand. Six jobs stand between him and the tide.', W / 2, H * 0.20 + Math.min(70, W * 0.062) + 36);
  ctx.restore();

  // Menu buttons
  const bw = 300, bx = W / 2 - bw / 2;
  let by = H * 0.47;
  if (game.hasSave) { button(game, bx, by, bw, 52, 'CONTINUE', 'continue'); by += 66; }
  button(game, bx, by, bw, 52, game.hasSave ? 'NEW GAME' : 'START ENGINE', 'newgame');
  by += 66;
  button(game, bx, by, bw, 44, game.audio.muted ? 'SOUND: OFF' : 'SOUND: ON', 'sound', { size: 15 });

  // Controls card
  const cw = 620, cx = W / 2 - cw / 2, cy = H - 158;
  ctx.fillStyle = 'rgba(10,10,20,0.62)';
  rr(ctx, cx, cy, cw, 132, 12); ctx.fill();
  ctx.strokeStyle = 'rgba(255,209,102,0.5)'; ctx.lineWidth = 1.4; ctx.stroke();
  text(ctx, 'CONTROLS', W / 2, cy + 26, 14, '#ffd166', 'center', true);
  const lines = [
    'WASD / Arrows — move & drive      E — enter / steal car · talk',
    'Shift — sprint      Space — handbrake      F — punch',
    'Mouse — aim · Click — shoot (after Mission 2)      P — pause · M — mute',
  ];
  lines.forEach((l, i) => text(ctx, l, W / 2, cy + 56 + i * 24, 14.5, '#e8e4da', 'center'));
  text(ctx, 'An original open-world crime story · autosaves after every mission', W / 2, H - 10, 12, 'rgba(255,255,255,0.55)', 'center');
}

function drawSkyline(ctx, W, baseY, maxH, color, seed, t) {
  ctx.fillStyle = color;
  let x = -10;
  let i = 0;
  while (x < W + 20) {
    const bw = 34 + ((seed * 31 + i * 57) % 46);
    const bh = maxH * (0.35 + (((seed * 17 + i * 41) % 65) / 100));
    ctx.fillRect(x, baseY - bh, bw, bh);
    // windows
    ctx.fillStyle = 'rgba(255,205,110,0.75)';
    for (let wy = baseY - bh + 8; wy < baseY - 8; wy += 13) {
      for (let wx = x + 5; wx < x + bw - 6; wx += 11) {
        if (((wx * 7 + wy * 13 + seed) % 5) < 2) ctx.fillRect(wx, wy, 4.5, 6);
      }
    }
    ctx.fillStyle = color;
    x += bw + 6 + ((i * 23 + seed) % 14);
    i++;
  }
  void t;
}

function drawPalm(ctx, x, y, flip, color) {
  ctx.strokeStyle = color; ctx.lineWidth = 7;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + 12 * flip, y - 62, x + 30 * flip, y - 104); ctx.stroke();
  ctx.lineWidth = 5;
  for (let i = 0; i < 6; i++) {
    const a = -0.4 - i * 0.42;
    ctx.beginPath();
    ctx.moveTo(x + 30 * flip, y - 104);
    ctx.quadraticCurveTo(x + 30 * flip + Math.cos(a) * 34 * flip, y - 104 + Math.sin(a) * 22 - 8, x + 30 * flip + Math.cos(a) * 58 * flip, y - 104 + Math.sin(a) * 34 + 16);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Pause / busted / wasted / complete overlays
// ---------------------------------------------------------------------------
export function drawOverlay(game) {
  const { ctx, canvas } = game;
  const W = canvas.width, H = canvas.height;
  const st = game.state;
  if (st === 'paused') {
    ctx.fillStyle = 'rgba(8,9,16,0.66)'; ctx.fillRect(0, 0, W, H);
    text(ctx, 'PAUSED', W / 2, H * 0.34, 52, '#ffffff', 'center', true);
    text(ctx, `Mission: ${game.missions.current ? game.missions.current.title : '—'} · $${game.money.toLocaleString('en-US')} · Earned $${game.missions.totalEarned.toLocaleString('en-US')}`, W / 2, H * 0.34 + 44, 16, '#ffd9a0', 'center');
    const bw = 280, bx = W / 2 - bw / 2;
    button(game, bx, H * 0.47, bw, 50, 'RESUME', 'resume');
    button(game, bx, H * 0.47 + 62, bw, 50, 'SAVE GAME', 'save');
    button(game, bx, H * 0.47 + 124, bw, 50, 'RESTART MISSION', 'restart');
    button(game, bx, H * 0.47 + 186, bw, 50, 'QUIT TO TITLE', 'title');
    return;
  }
  if (st === 'busted' || st === 'wasted') {
    const isBusted = st === 'busted';
    ctx.fillStyle = isBusted ? 'rgba(10,16,40,0.72)' : 'rgba(40,4,8,0.72)';
    ctx.fillRect(0, 0, W, H);
    text(ctx, isBusted ? 'BUSTED' : 'WASTED', W / 2, H * 0.40, 76, isBusted ? '#7cc7ff' : '#ff5964', 'center', true);
    text(ctx, isBusted ? 'Solmara PD walks you out $200 poorer.' : 'Solmara General patches you up for $200.', W / 2, H * 0.40 + 52, 17, '#f2f2f2', 'center');
    text(ctx, 'Press Enter to continue', W / 2, H * 0.40 + 92, 15, '#ffd166', 'center', true);
    return;
  }
  if (st === 'complete') {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, 'rgba(20,10,40,0.88)'); g.addColorStop(1, 'rgba(8,20,34,0.92)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    text(ctx, 'UNDERTOW', W / 2, H * 0.30, 64, '#ffd166', 'center', true);
    text(ctx, 'STORY COMPLETE', W / 2, H * 0.30 + 48, 22, '#ff5d8f', 'center', true);
    text(ctx, `Total mission earnings: $${game.missions.totalEarned.toLocaleString('en-US')}`, W / 2, H * 0.46, 20, '#ffffff', 'center');
    text(ctx, `Cash on hand: $${game.money.toLocaleString('en-US')} · Solmara stays open — free roam as long as you like.`, W / 2, H * 0.46 + 34, 15.5, '#cfd8dc', 'center');
    const bw = 300, bx = W / 2 - bw / 2;
    button(game, bx, H * 0.58, bw, 52, 'KEEP ROAMING', 'roam');
    button(game, bx, H * 0.58 + 64, bw, 52, 'TITLE SCREEN', 'title');
    return;
  }
}

export { PLACES };
