// ============================================================================
// SOLMARA UNDERTOW — render.js
// All drawing. Top-down camera with smooth follow + screen shake. The city is
// painted in layers: district ground → roads → beach/water → park detail →
// piers/boats → props → buildings → tire marks → vehicles → people →
// particles → mission marker → day/night grade → rain.
//
// Art direction: warm sunset grade, soft shadows under everything, neon
// signage that blooms at night, lit windows after dark, teal bay water with
// drifting sparkle. Everything is drawn in code — no image assets.
// ============================================================================

import { WORLD, ROADS_V, ROADS_H, ROAD_W, PALETTE, DISTRICTS, districtAt } from './config.js';

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

// Lighting model shared with HUD clock: hour 0-24 from game.dayT.
// The daylight curve is boosted (x1.6, clamped) so late afternoon stays
// readable, and the golden dusk spike sits at ~17:48 where the game opens.
export function lighting(game) {
  const hour = game.dayT * 24;
  const raw = Math.sin(((hour - 6) / 12) * Math.PI);
  const day = Math.max(0, Math.min(1, raw * 1.6));
  const dusk = Math.max(0, 1 - Math.abs(hour - 17.8) / 2.4);
  const dawn = Math.max(0, 1 - Math.abs(hour - 6.4) / 1.4);
  return { hour, day, dusk, dawn, night: 1 - day };
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  draw(game) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const cam = game.cam;
    const L = lighting(game);

    ctx.fillStyle = '#101018';
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate(-Math.round(cam.x + cam.shakeX), -Math.round(cam.y + cam.shakeY));

    const view = { x: cam.x - 40, y: cam.y - 40, w: W + 80, h: H + 80 };
    this._ground(game, view);
    this._roads(game, view);
    this._water(game, view);
    this._piersBoats(game, view);
    this._props(game, view, L);
    this._buildings(game, view, L);
    this._marks(game);
    this._marker(game);
    for (const c of game.cars) this._car(game, c, L); // dead cars draw as wrecks
    for (const c of game.police) this._car(game, c, L);
    if (game.player.car) this._car(game, game.player.car, L, true);
    this._extras(game);
    for (const p of game.peds) this._ped(game, p, L);
    if (!game.player.car) this._player(game, L);
    this._particles(game);

    ctx.restore();

    // ---- Day/night grade (screen space) -----------------------------------
    // Deep, saturated dusk: a thinner indigo night veil (so district colours
    // stay rich instead of washing out brown) under a stronger sunset band.
    if (L.night > 0.03) {
      ctx.fillStyle = `rgba(12,14,50,${(L.night * 0.25).toFixed(3)})`;
      ctx.fillRect(0, 0, W, H);
    }
    if (L.dusk > 0.02) {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, `rgba(255,94,38,${0.20 * L.dusk})`);
      g.addColorStop(0.55, `rgba(232,84,60,${0.08 * L.dusk})`);
      g.addColorStop(1, `rgba(146,32,110,${0.14 * L.dusk})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    if (L.dawn > 0.02) {
      ctx.fillStyle = `rgba(255,180,90,${0.10 * L.dawn})`;
      ctx.fillRect(0, 0, W, H);
    }
    // Headlight / lamp glow pools at night are drawn in world space above via
    // a second pass with 'lighter' — cheap and pretty.
    if (L.night > 0.25) this._nightGlows(game, L);

    if (game.weather === 'rain') this._rain(game, W, H);
    // Damage vignette
    if (game.player.health < 35 && game.state === 'playing') {
      const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.32, W / 2, H / 2, H * 0.75);
      g.addColorStop(0, 'rgba(180,0,0,0)');
      g.addColorStop(1, `rgba(180,0,0,${0.35 + 0.12 * Math.sin(game.time * 6)})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
  }

  _inView(view, x, y, pad = 90) {
    return x > view.x - pad && x < view.x + view.w + pad && y > view.y - pad && y < view.y + view.h + pad;
  }

  // Phase-2 extras in flat mode: AIR-1 + its searchlight, roadblock
  // barriers/cones, and weapon/ammo pickups (simple top-down glyphs).
  _extras(game) {
    const { ctx } = this;
    // Pickups: pulsing diamonds with a letter tag.
    for (const pk of game.pickups || []) {
      if (pk.taken) continue;
      const col = pk.kind === 'smg' ? '#12c2e0' : pk.kind === 'shotgun' ? '#ff7a1a' : '#7dff6a';
      const s = 10 + Math.sin(game.time * 4 + pk.x) * 2;
      ctx.save();
      ctx.translate(pk.x, pk.y);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = col;
      ctx.fillRect(-s / 2, -s / 2, s, s);
      ctx.restore();
      ctx.fillStyle = '#101018';
      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(pk.kind === 'ammo' ? 'A' : pk.kind === 'smg' ? 'S' : 'G', pk.x, pk.y + 3.5);
    }
    // Roadblock barriers + cones.
    for (const rb of game.roadblocks || []) {
      ctx.save();
      ctx.translate(rb.x, rb.y);
      ctx.rotate(rb.vertical ? 0 : Math.PI / 2);
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = i % 2 === 0 ? '#ff7a1a' : '#f2f2f2';
        ctx.fillRect(-60 + i * 20, -5, 20, 10);
      }
      ctx.fillStyle = '#ff7a1a';
      for (const s of [-72, 72]) {
        ctx.beginPath();
        ctx.moveTo(s - 6, 6); ctx.lineTo(s + 6, 6); ctx.lineTo(s, -8); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }
    // AIR-1: searchlight disc first (under the airframe), then the heli.
    const heli = game.heli;
    if (heli && heli.active) {
      ctx.save();
      ctx.fillStyle = 'rgba(255,244,190,0.20)';
      ctx.beginPath(); ctx.arc(heli.lightX, heli.lightY, 92, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(255,244,190,0.45)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(heli.lightX, heli.lightY, 92, 0, 7); ctx.stroke();
      ctx.translate(heli.x, heli.y);
      ctx.rotate(heli.angle);
      ctx.fillStyle = '#232c3d';
      ctx.beginPath(); ctx.roundRect(-19, -9, 38, 18, 8); ctx.fill();
      ctx.fillRect(-38, -3, 20, 6); // tail boom
      ctx.fillStyle = '#e8ecf2';
      ctx.beginPath(); ctx.roundRect(-8, -6, 16, 12, 5); ctx.fill();
      ctx.restore();
      // Rotor cross (unrotated by the body heading; spins on heli.rotor).
      ctx.save();
      ctx.translate(heli.x, heli.y);
      ctx.rotate(heli.rotor);
      ctx.strokeStyle = 'rgba(20,22,30,0.75)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(-34, 0); ctx.lineTo(34, 0); ctx.moveTo(0, -34); ctx.lineTo(0, 34); ctx.stroke();
      ctx.restore();
    }
  }

  _ground(game, view) {
    const { ctx } = this;
    // Base: neutral pavement everywhere, then district tints per block zone.
    ctx.fillStyle = '#8f8b82';
    ctx.fillRect(view.x, view.y, view.w, view.h);
    for (const d of DISTRICTS) {
      ctx.fillStyle = d.ground;
      ctx.fillRect(d.x, d.y, d.w, d.h);
    }
    // Sand + water base
    ctx.fillStyle = PALETTE.sand;
    ctx.fillRect(0, WORLD.sandY, WORLD.w, WORLD.waterY - WORLD.sandY);
    // Park lawn detail: mow stripes
    const park = DISTRICTS.find((d) => d.id === 'park');
    if (park && this._inView(view, park.x + park.w / 2, park.y + park.h / 2, 500)) {
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      for (let x = park.x; x < park.x + park.w; x += 76) ctx.fillRect(x, park.y, 38, park.h);
    }
    // Downtown plaza paving: a checker of large tiles under the towers
    // (roads and buildings paint over it, so only the open plaza reads).
    const dt = DISTRICTS.find((d) => d.id === 'downtown');
    if (dt && this._inView(view, dt.x + dt.w / 2, dt.y + dt.h / 2, 700)) {
      ctx.save();
      ctx.beginPath(); ctx.rect(dt.x, dt.y, dt.w, dt.h); ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,0.045)';
      for (let x = dt.x, i = 0; x < dt.x + dt.w; x += 46, i++) {
        for (let y = dt.y, j = 0; y < dt.y + dt.h; y += 46, j++) {
          if ((i + j) % 2 === 0) ctx.fillRect(x, y, 46, 46);
        }
      }
      ctx.strokeStyle = 'rgba(0,0,0,0.07)'; ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let x = dt.x; x <= dt.x + dt.w; x += 46) { ctx.moveTo(x, dt.y); ctx.lineTo(x, dt.y + dt.h); }
      for (let y = dt.y; y <= dt.y + dt.h; y += 46) { ctx.moveTo(dt.x, y); ctx.lineTo(dt.x + dt.w, y); }
      ctx.stroke();
      ctx.restore();
    }
    // Parking lots: dark asphalt pads with painted bays and oil stains.
    for (const lot of game.world.lots || []) {
      if (!this._inView(view, lot.x + lot.w / 2, lot.y + lot.h / 2, Math.max(lot.w, lot.h))) continue;
      ctx.fillStyle = '#43464c';
      ctx.fillRect(lot.x, lot.y, lot.w, lot.h);
      ctx.strokeStyle = '#c8c2b4'; ctx.lineWidth = 2.5;
      ctx.strokeRect(lot.x + 2, lot.y + 2, lot.w - 4, lot.h - 4);
      // Bay stripes along both long edges, angled slightly by the stall lines.
      ctx.strokeStyle = 'rgba(232,217,138,0.75)'; ctx.lineWidth = 2;
      ctx.beginPath();
      for (let x = lot.x + 18; x < lot.x + lot.w - 12; x += 27) {
        ctx.moveTo(x, lot.y + 4); ctx.lineTo(x, lot.y + 30);
        ctx.moveTo(x, lot.y + lot.h - 4); ctx.lineTo(x, lot.y + lot.h - 30);
      }
      ctx.stroke();
      // Oil stains (deterministic from the lot's position).
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      for (let i = 0; i < 3; i++) {
        const sx = lot.x + 24 + ((lot.x * 7 + lot.y * 13 + i * 89) % Math.max(30, lot.w - 60));
        const sy = lot.y + 30 + ((lot.y * 5 + i * 67) % Math.max(24, lot.h - 70));
        ctx.beginPath(); ctx.ellipse(sx, sy, 13 + i * 4, 8 + i * 2, 0, 0, 7); ctx.fill();
      }
    }
  }

  _roads(game, view) {
    const { ctx } = this;
    ctx.fillStyle = PALETTE.sidewalk;
    for (const rx of ROADS_V) ctx.fillRect(rx - ROAD_W / 2 - 10, 0, ROAD_W + 20, WORLD.sandY + 30);
    for (const ry of ROADS_H) ctx.fillRect(0, ry - ROAD_W / 2 - 10, WORLD.w, ROAD_W + 20);
    ctx.fillStyle = PALETTE.asphalt;
    for (const rx of ROADS_V) ctx.fillRect(rx - ROAD_W / 2, 0, ROAD_W, WORLD.sandY + 30);
    for (const ry of ROADS_H) ctx.fillRect(0, ry - ROAD_W / 2, WORLD.w, ROAD_W);
    // Asphalt wear: subtle patched/repaired stretches, fixed by position.
    ctx.fillStyle = 'rgba(0,0,0,0.055)';
    for (const rx of ROADS_V) for (let y = 60; y < WORLD.sandY; y += 260) {
      const h1 = ((rx * 31 + y * 17) % 100) / 100;
      if (rx - ROAD_W / 2 + 8 + h1 * 30 > view.x - 160 && rx < view.x + view.w + 60 && y > view.y - 260 && y < view.y + view.h) {
        ctx.fillRect(rx - ROAD_W / 2 + 8 + h1 * 30, y + h1 * 90, ROAD_W - 42, 58 + h1 * 46);
      }
    }
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    for (const ry of ROADS_H) for (let x = 80; x < WORLD.w; x += 300) {
      const h1 = ((ry * 13 + x * 29) % 100) / 100;
      if (x > view.x - 300 && x < view.x + view.w && ry > view.y - 160 && ry < view.y + view.h + 60) {
        ctx.fillRect(x + h1 * 110, ry - ROAD_W / 2 + 8 + h1 * 26, 64 + h1 * 40, ROAD_W - 42);
      }
    }
    // Edge lines
    ctx.fillStyle = PALETTE.asphaltEdge;
    for (const rx of ROADS_V) { ctx.fillRect(rx - ROAD_W / 2, 0, 3, WORLD.sandY + 30); ctx.fillRect(rx + ROAD_W / 2 - 3, 0, 3, WORLD.sandY + 30); }
    // Centre dashes
    ctx.fillStyle = PALETTE.laneMark;
    for (const rx of ROADS_V) for (let y = 14; y < WORLD.sandY; y += 44) ctx.fillRect(rx - 2, y, 4, 24);
    for (const ry of ROADS_H) for (let x = 14; x < WORLD.w; x += 44) ctx.fillRect(x, ry - 2, 24, 4);
    // Crosswalks at intersections
    ctx.fillStyle = PALETTE.crosswalk;
    for (const rx of ROADS_V) for (const ry of ROADS_H) {
      for (let i = -2; i <= 2; i++) {
        ctx.fillRect(rx - ROAD_W / 2 - 8, ry + i * 20 - 5, 10, 10);
        ctx.fillRect(rx + ROAD_W / 2 - 2, ry + i * 20 - 5, 10, 10);
        ctx.fillRect(rx + i * 20 - 5, ry - ROAD_W / 2 - 8, 10, 10);
        ctx.fillRect(rx + i * 20 - 5, ry + ROAD_W / 2 - 2, 10, 10);
      }
    }
  }

  _water(game, view) {
    const { ctx } = this;
    const g = ctx.createLinearGradient(0, WORLD.waterY, 0, WORLD.h);
    g.addColorStop(0, PALETTE.water);
    g.addColorStop(1, PALETTE.waterDeep);
    ctx.fillStyle = g;
    ctx.fillRect(0, WORLD.waterY, WORLD.w, WORLD.h - WORLD.waterY);
    // Drifting sparkle lanes
    ctx.fillStyle = 'rgba(255,255,255,0.13)';
    const t = game.time * 14;
    for (let i = 0; i < 46; i++) {
      const x = ((i * 173 + Math.floor(t + i * 37) % 90) % WORLD.w);
      const y = WORLD.waterY + 12 + ((i * 61) % (WORLD.h - WORLD.waterY - 24));
      if (this._inView(view, x, y, 30)) ctx.fillRect(x, y, 22 + (i % 3) * 9, 2);
    }
    // Foam line at the shore
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    for (let x = 0; x < WORLD.w; x += 46) {
      const wob = Math.sin(game.time * 1.4 + x * 0.05) * 3;
      ctx.fillRect(x, WORLD.waterY - 3 + wob, 30, 3);
    }
  }

  _piersBoats(game, view) {
    const { ctx } = this;
    for (const p of game.world.piers) {
      ctx.fillStyle = '#7a6248';
      ctx.fillRect(p.x, p.y, p.w, p.h);
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      for (let y = p.y + 8; y < p.y + p.h; y += 22) ctx.fillRect(p.x, y, p.w, 3);
      ctx.fillStyle = '#5d4a35';
      ctx.fillRect(p.x - 3, p.y, 4, p.h); ctx.fillRect(p.x + p.w - 1, p.y, 4, p.h);
    }
    for (const b of game.world.boats) {
      if (!this._inView(view, b.x, b.y, 90)) continue;
      ctx.save();
      ctx.translate(b.x, b.y + Math.sin(game.time * 1.3 + b.x) * 2);
      ctx.rotate(b.a);
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      rr(ctx, -b.len / 2 + 3, -11 + 3, b.len, 22, 10); ctx.fill();
      ctx.fillStyle = b.color;
      rr(ctx, -b.len / 2, -11, b.len, 22, 10); ctx.fill();
      ctx.fillStyle = '#ffffff';
      rr(ctx, -b.len / 6, -7, b.len / 3, 14, 5); ctx.fill();
      if (b.hero) { ctx.fillStyle = '#ffd166'; ctx.fillRect(-b.len / 2, -2, b.len, 4); }
      ctx.restore();
    }
  }

  _props(game, view, L) {
    const { ctx } = this;
    for (const p of game.world.props) {
      if (!this._inView(view, p.x, p.y, 60)) continue;
      if (p.kind === 'palm') {
        ctx.strokeStyle = '#7a5c3e'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.quadraticCurveTo(p.x + 4, p.y - 10, p.x + 7, p.y - 16); ctx.stroke();
        ctx.strokeStyle = '#3e8e4f'; ctx.lineWidth = 3;
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + 0.4;
          ctx.beginPath(); ctx.moveTo(p.x + 7, p.y - 16);
          ctx.quadraticCurveTo(p.x + 7 + Math.cos(a) * 11, p.y - 20 + Math.sin(a) * 4, p.x + 7 + Math.cos(a) * 17, p.y - 14 + Math.sin(a) * 7);
          ctx.stroke();
        }
      } else if (p.kind === 'lamp') {
        ctx.fillStyle = '#3a3f45'; ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
        if (L.night > 0.3) {
          ctx.fillStyle = 'rgba(255,214,120,0.9)';
          ctx.beginPath(); ctx.arc(p.x, p.y, 3.4, 0, 7); ctx.fill();
        }
      } else if (p.kind === 'crate') {
        ctx.fillStyle = '#9a7b4f'; ctx.fillRect(p.x - p.s / 2, p.y - p.s / 2, p.s, p.s);
        ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 2;
        ctx.strokeRect(p.x - p.s / 2, p.y - p.s / 2, p.s, p.s);
      } else if (p.kind === 'barrel') {
        ctx.fillStyle = '#b0483e'; ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, 7); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.beginPath(); ctx.arc(p.x - 2, p.y - 2, 3, 0, 7); ctx.fill();
      } else if (p.kind === 'bench') {
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a);
        ctx.fillStyle = '#6e5136'; ctx.fillRect(-11, -3, 22, 6);
        ctx.restore();
      } else if (p.kind === 'umbrella') {
        ctx.fillStyle = 'rgba(0,0,0,0.15)'; ctx.beginPath(); ctx.arc(p.x + 4, p.y + 5, 13, 0, 7); ctx.fill();
        ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, 13, 0, 7); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, 7); ctx.fill();
      } else if (p.kind === 'pond') {
        ctx.fillStyle = '#3d7ea6'; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.beginPath(); ctx.arc(p.x - 14, p.y - 10, p.r * 0.45, 0, 7); ctx.fill();
      }
    }
    for (const t of game.world.trees) {
      if (!this._inView(view, t.x, t.y, 60)) continue;
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath(); ctx.arc(t.x + 4, t.y + 5, t.r, 0, 7); ctx.fill();
      ctx.fillStyle = '#2f6b2f';
      ctx.beginPath(); ctx.arc(t.x, t.y, t.r, 0, 7); ctx.fill();
      ctx.fillStyle = '#3f7d38';
      ctx.beginPath(); ctx.arc(t.x - t.r * 0.3, t.y - t.r * 0.3, t.r * 0.62, 0, 7); ctx.fill();
    }
  }

  _buildings(game, view, L) {
    const { ctx } = this;
    for (const b of game.world.buildings) {
      if (!this._inView(view, b.x + b.w / 2, b.y + b.h / 2, Math.max(b.w, b.h))) continue;
      const st = b.style;
      if (!st) { // Undecorated fallback (should not happen): plain slab.
        ctx.fillStyle = b.color; ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.fillStyle = b.roof; ctx.fillRect(b.x + 10, b.y + 10, b.w - 20, b.h - 20);
        continue;
      }
      const inset = st.inset;
      const rx = b.x + inset, ry = b.y + inset, rw = b.w - inset * 2, rh = b.h - inset * 2;
      // Drop shadow: taller buildings throw a longer dusk shadow.
      const sho = 5 + Math.min(9, b.floors || 1);
      ctx.fillStyle = 'rgba(20,16,10,0.30)';
      ctx.fillRect(b.x + sho, b.y + sho + 2, b.w, b.h);
      // Wall band (the facade you glimpse from above), south edge shaded.
      ctx.fillStyle = st.wall;
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.fillStyle = st.wallDark;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(b.x, b.y + b.h - inset, b.w, inset);
      ctx.globalAlpha = 1;

      if (st.pitched) this._pitchedRoof(b, st, rx, ry, rw, rh);
      else this._flatRoof(b, st, L, rx, ry, rw, rh);

      // Storefront: lit glass band on the south facade + striped awning
      // spilling onto the sidewalk.
      if (st.awning) {
        ctx.fillStyle = L.night > 0.35 ? 'rgba(255,205,110,0.85)' : 'rgba(150,205,225,0.7)';
        ctx.fillRect(b.x + 8, b.y + b.h - inset + 1.5, b.w - 16, inset - 3);
        const stripes = Math.max(4, Math.floor((b.w - 20) / 12));
        for (let i = 0; i < stripes; i++) {
          ctx.fillStyle = i % 2 ? st.awning.color : 'rgba(245,240,230,0.92)';
          ctx.fillRect(b.x + 10 + i * 12, b.y + b.h, 12, 8);
        }
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(b.x + 10, b.y + b.h + 8, stripes * 12, 2.5);
      }

      // Facade panes: small windows ringing the wall band — jittered per
      // building, mixed warm/cool/dark after dark, sky-glass by day.
      const night = L.night;
      for (const f of st.facade) {
        const h1 = (f.s % 10) / 10;
        if (night > 0.35) {
          ctx.fillStyle = h1 < 0.34 ? 'rgba(255,196,90,0.95)'
            : h1 < 0.48 ? 'rgba(170,220,255,0.90)'
            : h1 < 0.60 ? 'rgba(255,226,160,0.55)'
            : 'rgba(38,44,54,0.90)';
        } else {
          ctx.fillStyle = h1 < 0.55 ? 'rgba(168,214,232,0.65)' : 'rgba(90,110,128,0.55)';
        }
        ctx.fillRect(b.x + f.x, b.y + f.y, f.w, f.h);
      }
    }
    // Neon signs bloom after dark (and read at dusk)
    for (const s of game.world.signs) {
      if (!this._inView(view, s.x, s.y, 80)) continue;
      const glow = 0.35 + L.night * 0.65;
      ctx.save();
      ctx.globalAlpha = glow;
      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.shadowColor = s.color; ctx.shadowBlur = 12;
      ctx.fillStyle = s.color;
      ctx.fillText(s.text, s.x, s.y);
      ctx.restore();
    }
  }

  // Flat roof: tinted panel + texture blotches, a parapet ring lit on the
  // sun side (top/left) and shadowed opposite, then the precomputed rooftop
  // machinery — AC units with fan rings, water tanks, slatted vents, rooftop
  // gardens, skylights — and one helipad for the tallest Downtown tower.
  _flatRoof(b, st, L, rx, ry, rw, rh) {
    const { ctx } = this;
    ctx.fillStyle = st.roofColor;
    ctx.fillRect(rx, ry, rw, rh);
    for (const bl of st.blotches) {
      ctx.fillStyle = bl.light ? `rgba(255,255,255,${bl.a})` : `rgba(0,0,0,${bl.a})`;
      ctx.fillRect(b.x + bl.x, b.y + bl.y, bl.w, bl.h);
    }
    // Parapet bevel + inner hairline.
    ctx.fillStyle = st.parapetLight;
    ctx.fillRect(rx, ry, rw, 3); ctx.fillRect(rx, ry, 3, rh);
    ctx.fillStyle = st.parapetDark;
    ctx.fillRect(rx, ry + rh - 3, rw, 3); ctx.fillRect(rx + rw - 3, ry, 3, rh);
    ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = 1;
    ctx.strokeRect(rx + 4.5, ry + 4.5, rw - 9, rh - 9);

    if (st.helipad) {
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2, r = Math.min(rw, rh) * 0.32;
      ctx.strokeStyle = 'rgba(240,240,230,0.85)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.stroke();
      ctx.fillStyle = 'rgba(240,240,230,0.92)';
      ctx.font = `bold ${Math.round(r * 1.05)}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('H', cx, cy + 1);
      ctx.textBaseline = 'alphabetic';
    }

    for (const p of st.props) {
      const px = b.x + p.x, py = b.y + p.y;
      if (p.type === 'ac') {
        ctx.fillStyle = 'rgba(0,0,0,0.20)'; ctx.fillRect(px + 2, py + 3, p.w, p.h);
        ctx.fillStyle = '#9aa0a4'; ctx.fillRect(px, py, p.w, p.h);
        ctx.fillStyle = '#7c8287'; ctx.fillRect(px, py, p.w, 3);
        ctx.strokeStyle = 'rgba(40,44,48,0.8)'; ctx.lineWidth = 1.4;
        const fr = Math.min(p.w, p.h) * 0.30;
        ctx.beginPath(); ctx.arc(px + p.w / 2, py + p.h / 2, fr, 0, 7); ctx.stroke();
        ctx.beginPath(); ctx.arc(px + p.w / 2, py + p.h / 2, fr * 0.45, 0, 7); ctx.stroke();
      } else if (p.type === 'vent') {
        ctx.fillStyle = '#8b9094'; ctx.fillRect(px, py, p.w, p.h);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        for (let s = 2; s < p.h - 1; s += 3) ctx.fillRect(px + 1.5, py + s, p.w - 3, 1.4);
      } else if (p.type === 'tank') {
        ctx.fillStyle = 'rgba(0,0,0,0.20)';
        ctx.beginPath(); ctx.arc(px + 2, py + 3, p.r, 0, 7); ctx.fill();
        ctx.fillStyle = '#a89a80';
        ctx.beginPath(); ctx.arc(px, py, p.r, 0, 7); ctx.fill();
        ctx.fillStyle = '#8d7f66';
        ctx.beginPath(); ctx.arc(px, py, p.r * 0.55, 0, 7); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.beginPath(); ctx.arc(px - p.r * 0.3, py - p.r * 0.3, p.r * 0.22, 0, 7); ctx.fill();
      } else if (p.type === 'garden') {
        ctx.fillStyle = '#4a7a3c'; ctx.fillRect(px, py, p.w, p.h);
        ctx.fillStyle = '#5d9048';
        for (let i = 0; i < 5; i++) {
          const bx = px + 5 + ((p.s * (i + 3) * 37) % Math.max(9, Math.floor(p.w) - 10));
          const by = py + 5 + ((p.s * (i + 5) * 53) % Math.max(9, Math.floor(p.h) - 10));
          ctx.beginPath(); ctx.arc(bx, by, 5 + ((p.s + i * 7) % 4), 0, 7); ctx.fill();
        }
        ctx.strokeStyle = '#c9b18a'; ctx.lineWidth = 2;
        ctx.strokeRect(px + 1, py + 1, p.w - 2, p.h - 2);
      }
    }
    for (const sk of st.skylights) {
      const px = b.x + sk.x, py = b.y + sk.y;
      ctx.fillStyle = L.night > 0.35 ? 'rgba(255,214,130,0.75)' : 'rgba(165,215,235,0.75)';
      ctx.fillRect(px, py, sk.w, sk.h);
      ctx.strokeStyle = 'rgba(60,70,78,0.9)'; ctx.lineWidth = 1.6;
      ctx.strokeRect(px, py, sk.w, sk.h);
      ctx.beginPath(); ctx.moveTo(px + sk.w / 2, py); ctx.lineTo(px + sk.w / 2, py + sk.h); ctx.stroke();
    }
  }

  // Pitched roof for Casa Verde houses: two shaded slopes meeting at a
  // ridge, hip lines running to the corners, faint shingle rows, optional
  // solar panels on the sunny slope and a brick chimney.
  _pitchedRoof(b, st, rx, ry, rw, rh) {
    const { ctx } = this;
    ctx.fillStyle = st.slopeA;
    ctx.fillRect(rx, ry, rw, rh / 2);
    ctx.fillStyle = st.slopeB;
    ctx.fillRect(rx, ry + rh / 2, rw, rh / 2);
    // Shingle rows.
    ctx.fillStyle = 'rgba(0,0,0,0.055)';
    for (let y = ry + 6; y < ry + rh - 2; y += 9) ctx.fillRect(rx + 2, y, rw - 4, 1.6);
    // Hip lines from the corners up to the ridge ends.
    ctx.strokeStyle = st.parapetDark; ctx.lineWidth = 2;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(rx, ry); ctx.lineTo(rx + rh / 2, ry + rh / 2);
    ctx.lineTo(rx + rw - rh / 2, ry + rh / 2); ctx.lineTo(rx + rw, ry);
    ctx.moveTo(rx, ry + rh); ctx.lineTo(rx + rh / 2, ry + rh / 2);
    ctx.moveTo(rx + rw, ry + rh); ctx.lineTo(rx + rw - rh / 2, ry + rh / 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    // Ridge cap.
    ctx.fillStyle = st.parapetDark;
    ctx.fillRect(rx + rh / 2, ry + rh / 2 - 2, rw - rh, 4);
    // Edge trim: light on the sun side, dark opposite.
    ctx.fillStyle = st.parapetLight;
    ctx.fillRect(rx, ry, rw, 2.5); ctx.fillRect(rx, ry, 2.5, rh);
    ctx.fillStyle = st.parapetDark;
    ctx.fillRect(rx, ry + rh - 2.5, rw, 2.5); ctx.fillRect(rx + rw - 2.5, ry, 2.5, rh);
    // Solar panels on the south slope.
    if (st.solar) {
      const pw = Math.min(46, rw * 0.42), ph = rh * 0.30;
      const px = rx + rw * 0.14, py = ry + rh * 0.60;
      ctx.fillStyle = 'rgba(0,0,0,0.20)'; ctx.fillRect(px + 2, py + 2, pw, ph);
      ctx.fillStyle = '#1d3550'; ctx.fillRect(px, py, pw, ph);
      ctx.strokeStyle = 'rgba(150,190,220,0.55)'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let gx = px + pw / 3; gx < px + pw - 1; gx += pw / 3) { ctx.moveTo(gx, py); ctx.lineTo(gx, py + ph); }
      ctx.moveTo(px, py + ph / 2); ctx.lineTo(px + pw, py + ph / 2);
      ctx.stroke();
    }
    for (const sk of st.skylights) {
      const px = b.x + sk.x, py = b.y + sk.y;
      ctx.fillStyle = 'rgba(165,215,235,0.8)';
      ctx.fillRect(px, py, sk.w, sk.h);
      ctx.strokeStyle = 'rgba(60,50,40,0.85)'; ctx.lineWidth = 1.5;
      ctx.strokeRect(px, py, sk.w, sk.h);
    }
    if (st.chimney) {
      const cx = b.x + st.chimney.x, cy = b.y + st.chimney.y;
      ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(cx + 2, cy + 2, st.chimney.w, st.chimney.h);
      ctx.fillStyle = '#8a4a3a'; ctx.fillRect(cx, cy, st.chimney.w, st.chimney.h);
      ctx.fillStyle = '#5d3226'; ctx.fillRect(cx - 1.5, cy - 1.5, st.chimney.w + 3, 4);
    }
  }

  _marks(game) {
    const { ctx } = this;
    ctx.fillStyle = '#1c1c1e';
    for (const m of game.particles.marks) {
      ctx.save();
      ctx.globalAlpha = Math.min(0.5, m.life / 6 * 0.5);
      ctx.translate(m.x, m.y); ctx.rotate(m.angle);
      ctx.fillRect(-7, -2, 14, 4);
      ctx.restore();
    }
  }

  _marker(game) {
    const { ctx } = this;
    const mk = game.missions && game.missions.marker ? game.missions.marker() : null;
    if (!mk || game.state !== 'playing' && game.state !== 'dialog') return;
    const pulse = 1 + Math.sin(game.time * 4) * 0.12;
    ctx.save();
    ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(mk.x, mk.y, mk.r * 0.45 * pulse, 0, 7); ctx.stroke();
    ctx.fillStyle = 'rgba(255,209,102,0.16)';
    ctx.beginPath(); ctx.arc(mk.x, mk.y, mk.r * 0.45 * pulse, 0, 7); ctx.fill();
    // Beacon beam
    const grad = ctx.createLinearGradient(0, mk.y - 320, 0, mk.y);
    grad.addColorStop(0, 'rgba(255,209,102,0)');
    grad.addColorStop(1, 'rgba(255,209,102,0.30)');
    ctx.fillStyle = grad;
    ctx.fillRect(mk.x - 9, mk.y - 320, 18, 320);
    ctx.fillStyle = '#ffd166';
    ctx.font = 'bold 15px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('★', mk.x, mk.y - 14);
    ctx.restore();
  }

  _car(game, car, L, isPlayer = false) {
    const { ctx } = this;
    if (car.dead) {
      // Wreck: darkened husk
      ctx.save(); ctx.translate(car.x, car.y); ctx.rotate(car.angle);
      ctx.fillStyle = '#26262a'; rr(ctx, -car.len / 2, -car.wid / 2, car.len, car.wid, 6); ctx.fill();
      ctx.fillStyle = '#17171a'; rr(ctx, -car.len / 5, -car.wid / 2 + 4, car.len / 2.4, car.wid - 8, 4); ctx.fill();
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.angle);
    const hl = car.len / 2, hw = car.wid / 2;
    // Shadow
    ctx.fillStyle = 'rgba(15,12,8,0.30)';
    rr(ctx, -hl + 3, -hw + 4, car.len, car.wid, 7); ctx.fill();
    // Body
    ctx.fillStyle = car.color;
    rr(ctx, -hl, -hw, car.len, car.wid, 7); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.13)';
    rr(ctx, -hl, -hw, car.len, car.wid / 2, 6); ctx.fill();
    if (car.type === 'truck') {
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      rr(ctx, -hl + 4, -hw + 3, car.len * 0.52, car.wid - 6, 3); ctx.fill();
      ctx.fillStyle = '#dfe6ec';
      rr(ctx, hl - car.len * 0.3, -hw + 2, car.len * 0.26, car.wid - 4, 4); ctx.fill();
    } else {
      // Cabin + glass
      ctx.fillStyle = '#1d2733';
      rr(ctx, -car.len * 0.16, -hw + 3.5, car.len * 0.42, car.wid - 7, 4); ctx.fill();
      ctx.fillStyle = 'rgba(160,210,235,0.65)';
      rr(ctx, hl - car.len * 0.3, -hw + 4.5, car.len * 0.1, car.wid - 9, 3); ctx.fill(); // windshield
      rr(ctx, -car.len * 0.24, -hw + 4.5, car.len * 0.07, car.wid - 9, 3); ctx.fill();  // rear glass
    }
    if (car.type === 'taxi') {
      ctx.fillStyle = '#ffffff'; ctx.fillRect(-6, -4, 12, 8);
      ctx.fillStyle = '#111'; ctx.font = 'bold 6px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('TAXI', 0, 2);
    }
    if (car.police) {
      ctx.fillStyle = '#f4f6f8'; ctx.fillRect(-hl + 6, -hw, car.len - 12, car.wid);
      ctx.fillStyle = '#1b263b'; rr(ctx, -car.len * 0.16, -hw + 3.5, car.len * 0.42, car.wid - 7, 4); ctx.fill();
      const flash = Math.sin(game.time * 11) > 0;
      ctx.fillStyle = flash ? '#ff2e4d' : '#2e7dff';
      ctx.fillRect(-8, -hw - 2, 7, 4); ctx.fillRect(1, -hw - 2, 7, 4);
      ctx.fillStyle = flash ? '#2e7dff' : '#ff2e4d';
      ctx.fillRect(-8, hw - 2, 7, 4); ctx.fillRect(1, hw - 2, 7, 4);
    }
    if (car.missionTarget) {
      ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 2.5;
      rr(ctx, -hl - 3, -hw - 3, car.len + 6, car.wid + 6, 9); ctx.stroke();
    }
    // Headlights / taillights
    ctx.fillStyle = '#fff6c9';
    ctx.fillRect(hl - 3, -hw + 2, 3, 5); ctx.fillRect(hl - 3, hw - 7, 3, 5);
    ctx.fillStyle = (car.braking ? '#ff4757' : '#a02c36');
    ctx.fillRect(-hl, -hw + 2, 3, 5); ctx.fillRect(-hl, hw - 7, 3, 5);
    // Wheels
    ctx.fillStyle = '#14161a';
    for (const [wx, wy] of [[hl - 9, -hw - 1], [hl - 9, hw - 3], [-hl + 5, -hw - 1], [-hl + 5, hw - 3]]) ctx.fillRect(wx, wy, 8, 4);
    ctx.restore();

    // Headlight cones at night
    if (L.night > 0.3 && Math.abs(car.speed) >= 0) {
      ctx.save();
      ctx.translate(car.x, car.y); ctx.rotate(car.angle);
      const g = ctx.createLinearGradient(hl, 0, hl + 95, 0);
      g.addColorStop(0, `rgba(255,240,180,${0.13 * L.night})`);
      g.addColorStop(1, 'rgba(255,240,180,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(hl, -hw + 3); ctx.lineTo(hl + 95, -26); ctx.lineTo(hl + 95, 26); ctx.lineTo(hl, hw - 3); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    if (isPlayer) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,209,102,0.85)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(car.x, car.y, car.len * 0.72 + Math.sin(game.time * 5) * 1.5, 0, 7); ctx.stroke();
      ctx.restore();
    }
  }

  _pedFigure(game, x, y, angle, walkPhase, shirt, opts = {}) {
    const { ctx } = this;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = 'rgba(15,12,8,0.28)';
    ctx.beginPath(); ctx.ellipse(1.5, 3, 8, 5.5, 0, 0, 7); ctx.fill();
    const moving = opts.moving;
    const bob = moving ? Math.sin(walkPhase * 9) * 1.6 : Math.sin(game.time * 2 + x) * 0.4;
    ctx.rotate(angle + Math.PI / 2);
    // Legs
    ctx.fillStyle = '#2d3142';
    if (moving) {
      ctx.fillRect(-5, 2 + bob, 4, 8); ctx.fillRect(1, 2 - bob, 4, 8);
    } else { ctx.fillRect(-5, 2, 4, 8); ctx.fillRect(1, 2, 4, 8); }
    // Torso
    ctx.fillStyle = shirt;
    rr(ctx, -6.5, -5, 13, 11, 5); ctx.fill();
    // Head
    ctx.fillStyle = opts.skin || '#e8b08a';
    ctx.beginPath(); ctx.arc(0, -8.5, 4.6, 0, 7); ctx.fill();
    if (opts.bandana) { ctx.fillStyle = opts.bandana; ctx.beginPath(); ctx.arc(0, -9.5, 4.8, Math.PI, 7); ctx.fill(); }
    ctx.restore();
  }

  _ped(game, ped, L) {
    const { ctx } = this;
    if (ped.dead) {
      ctx.save(); ctx.translate(ped.x, ped.y); ctx.rotate(ped.angle);
      ctx.fillStyle = 'rgba(120,20,20,0.5)'; ctx.beginPath(); ctx.ellipse(0, 0, 13, 8, 0, 0, 7); ctx.fill();
      ctx.fillStyle = ped.shirt; rr(ctx, -5, -10, 10, 16, 4); ctx.fill();
      ctx.fillStyle = '#e8b08a'; ctx.beginPath(); ctx.arc(0, -13, 4.4, 0, 7); ctx.fill();
      ctx.restore();
      return;
    }
    this._pedFigure(game, ped.x, ped.y, ped.angle, ped.walkPhase, ped.shirt, {
      moving: ped.speed > 4,
      bandana: ped.state === 'gang' ? '#7b2ff7' : null,
    });
    if (ped.hurtT > 0) {
      ctx.fillStyle = 'rgba(255,60,60,0.35)';
      ctx.beginPath(); ctx.arc(ped.x, ped.y, 13, 0, 7); ctx.fill();
    }
    if (ped.state === 'gang' || ped.name) {
      // Health bar for hostiles, name tag for NPCs
      if (ped.state === 'gang' && ped.health < 100) {
        ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(ped.x - 13, ped.y - 24, 26, 4);
        ctx.fillStyle = '#b78bff'; ctx.fillRect(ped.x - 12, ped.y - 23, 24 * Math.max(0, ped.health / 100), 2);
      }
      if (ped.name) {
        ctx.font = 'bold 11px system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillText(ped.name, ped.x + 1, ped.y - 17);
        ctx.fillStyle = '#ffffff'; ctx.fillText(ped.name, ped.x, ped.y - 18);
      }
    }
  }

  _player(game, L) {
    const { ctx } = this;
    const p = game.player;
    if (p.invuln > 0 && Math.floor(game.time * 14) % 2 === 0 && game.state === 'playing') {
      // blink while invulnerable — draw at half alpha
      ctx.globalAlpha = 0.45;
    }
    this._pedFigure(game, p.x, p.y, p.angle, p.walkPhase, '#ffd166', { moving: p.moving });
    ctx.globalAlpha = 1;
    // Aim arm + pistol
    if (game.hasPistol && game.state === 'playing') {
      const aim = Math.atan2(game.mouseWorld.y - p.y, game.mouseWorld.x - p.x);
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(aim);
      ctx.fillStyle = '#e8b08a'; ctx.fillRect(4, -1.5, 8, 3);
      ctx.fillStyle = '#22242a'; ctx.fillRect(11, -2, 8, 4);
      if (p.muzzle > 0) {
        ctx.fillStyle = '#ffd166';
        ctx.beginPath(); ctx.moveTo(19, -4); ctx.lineTo(30, 0); ctx.lineTo(19, 4); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
      // Crosshair at mouse
      const mw = game.mouseWorld;
      ctx.strokeStyle = 'rgba(255,80,80,0.9)'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(mw.x, mw.y, 7, 0, 7); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(mw.x - 11, mw.y); ctx.lineTo(mw.x - 3, mw.y);
      ctx.moveTo(mw.x + 3, mw.y); ctx.lineTo(mw.x + 11, mw.y);
      ctx.moveTo(mw.x, mw.y - 11); ctx.lineTo(mw.x, mw.y - 3);
      ctx.moveTo(mw.x, mw.y + 3); ctx.lineTo(mw.x, mw.y + 11);
      ctx.stroke();
    }
  }

  _particles(game) {
    const { ctx } = this;
    for (const pt of game.particles.list) {
      const a = Math.max(0, pt.life / pt.maxLife);
      if (pt.text) {
        ctx.save();
        ctx.globalAlpha = a;
        ctx.font = 'bold 15px system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.fillStyle = pt.color;
        ctx.fillText(pt.text, pt.x, pt.y);
        ctx.restore();
      } else {
        ctx.globalAlpha = a;
        ctx.fillStyle = pt.color;
        ctx.fillRect(pt.x - pt.size / 2, pt.y - pt.size / 2, pt.size, pt.size);
        ctx.globalAlpha = 1;
      }
    }
  }

  _nightGlows(game, L) {
    const { ctx, canvas } = this;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(-Math.round(game.cam.x + game.cam.shakeX), -Math.round(game.cam.y + game.cam.shakeY));
    for (const p of game.world.props) {
      if (p.kind !== 'lamp') continue;
      if (p.x < game.cam.x - 60 || p.x > game.cam.x + canvas.width + 60 || p.y < game.cam.y - 60 || p.y > game.cam.y + canvas.height + 60) continue;
      const g = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, 40);
      g.addColorStop(0, `rgba(255,205,110,${0.14 * L.night})`);
      g.addColorStop(1, 'rgba(255,205,110,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, p.y, 40, 0, 7); ctx.fill();
    }
    for (const c of game.police) {
      if (c.dead) continue;
      const flash = Math.sin(game.time * 11) > 0;
      const col = flash ? '255,60,90' : '60,130,255';
      const g = ctx.createRadialGradient(c.x, c.y, 4, c.x, c.y, 66);
      g.addColorStop(0, `rgba(${col},${0.20 * L.night})`);
      g.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(c.x, c.y, 66, 0, 7); ctx.fill();
    }
    ctx.restore();
  }

  _rain(game, W, H) {
    const { ctx } = this;
    ctx.strokeStyle = 'rgba(180,210,255,0.35)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let i = 0; i < 90; i++) {
      const x = ((i * 149 + game.time * 620) % (W + 80)) - 40;
      const y = ((i * 271 + game.time * 980) % (H + 60)) - 30;
      ctx.moveTo(x, y); ctx.lineTo(x - 5, y + 15);
    }
    ctx.stroke();
  }
}

export { districtAt };
