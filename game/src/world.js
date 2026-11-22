// ============================================================================
// SOLMARA UNDERTOW — world.js
// Procedural city generation. The road grid carves the map into blocks; each
// block is developed according to its district: Downtown towers, Casa Verde
// houses, Portside warehouses, Palma hotels, a green Central Park, and the
// Marina with piers and moored boats reaching into Solmara Bay.
//
// Exports a `world` object:
//   buildings[]  — solid rects {x,y,w,h,kind,color,roof,district,neon,sign}
//   props[]      — decorative {kind,x,y,...} palms, lamps, crates, benches…
//   trees[]      — park/beach foliage circles
//   piers[]      — marina dock rects over the water (walkable, drawn high)
//   boats[]      — moored boats in the bay
//   colliders[]  — buildings + warehouse props used for physics
// plus helpers: isRoad, lanePoint, collideCircle, collideCar, nearestRoad…
// ============================================================================

import { WORLD, ROADS_V, ROADS_H, ROAD_W, LANE, DISTRICTS, districtAt, PALETTE } from './config.js';
import { RNG } from './random.js';

const BUILDING_COLORS = {
  downtown: ['#7a6a8f', '#5d7a8c', '#8c6a5d', '#6a7f95', '#94748a', '#546e7a'],
  suburb: ['#c9a877', '#b5c99a', '#e0cfa8', '#d9a08a', '#a8c0c9', '#e8ddc0'],
  industrial: ['#8a8578', '#79736a', '#94897a', '#6e6a60'],
  palma: ['#e8dcc0', '#f0c8a0', '#d8e4ea', '#f5e6c8'],
  marina: ['#7d8894', '#8a94a0', '#6e7a86'],
};
const ROOF_COLORS = ['#4a4440', '#5d564e', '#3e4a52', '#6b5a4a', '#52484e'];
// Roof palettes per district: terracotta + shingle browns for pitched suburb
// roofs, weathered metal for Portside, pale + clay for Palma hotels.
const ROOF_BY_DISTRICT = {
  downtown: ['#4c4653', '#5d564e', '#3e4a52', '#6b5a4a', '#52484e', '#46525e', '#5e4a3c'],
  suburb: ['#8a4f38', '#7a5a44', '#96543e', '#6e4a3a', '#845c40'],
  industrial: ['#5a564e', '#66625a', '#4e5a60', '#71685a'],
  palma: ['#a85f3f', '#c2b49a', '#9c5a44', '#b8a888'],
  marina: ['#4e5a60', '#5d666e', '#46525a'],
};

// Lighten (f > 0, toward white) or darken (f < 0, toward black) a #rrggbb.
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, bl = n & 255;
  if (f >= 0) { r += (255 - r) * f; g += (255 - g) * f; bl += (255 - bl) * f; }
  else { r *= 1 + f; g *= 1 + f; bl *= 1 + f; }
  const c = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return `rgb(${c(r)},${c(g)},${c(bl)})`;
}

// ---------------------------------------------------------------------------
// Per-building visual style, precomputed once at world build (render.js does
// zero random work per frame): tinted wall/roof colours, a parapet light/dark
// pair, jittered facade panes along the wall band, roof texture blotches,
// rooftop machinery (AC units, tanks, vents, gardens), skylights, a
// storefront awning for commercial frontages, and pitched-roof data (slopes,
// solar panels, chimney) for Casa Verde houses.
// ---------------------------------------------------------------------------
function decorateBuilding(b, rng) {
  const inset = b.kind === 'house' ? 7 : 10;
  const st = {
    inset,
    wall: shade(b.color, rng.range(-0.05, 0.07)),
    wallDark: shade(b.color, -0.22),
    roofColor: shade(b.roof, rng.range(-0.07, 0.10)),
    parapetLight: shade(b.roof, 0.30),
    parapetDark: shade(b.roof, -0.34),
    slopeA: shade(b.roof, 0.14),
    slopeB: shade(b.roof, -0.15),
    facade: [], blotches: [], props: [], skylights: [],
    awning: null, pitched: b.kind === 'house', solar: false, chimney: null, helipad: false,
  };
  const rx = inset, ry = inset, rw = b.w - inset * 2, rh = b.h - inset * 2;

  // Storefront decision comes first: an awning frontage replaces the south
  // facade panes with a lit glass band (drawn by render.js).
  if ((b.kind === 'tower' || b.kind === 'hotel' || b.kind === 'block') && rng.chance(0.68)) {
    st.awning = { color: rng.pick(['#b03a48', '#2e7d74', '#c96a2c', '#5d4a8a', '#a83256']) };
  }

  // Facade panes: jittered runs along the wall band, some skipped so no two
  // buildings share the same rhythm. Tone is chosen at draw time from s.
  const pane = (x, y, w, h) => st.facade.push({ x, y, w, h, s: rng.int(0, 999) });
  for (let x = 8; x < b.w - 14; x += 17) {
    if (rng.chance(0.82)) pane(x + rng.range(-2, 2), 2.5, 8, 4.5);
    if (!st.awning && rng.chance(0.82)) pane(x + rng.range(-2, 2), b.h - 7, 8, 4.5);
  }
  for (let y = 8; y < b.h - 14; y += 17) {
    if (rng.chance(0.82)) pane(2.5, y + rng.range(-2, 2), 4.5, 8);
    if (rng.chance(0.82)) pane(b.w - 7, y + rng.range(-2, 2), 4.5, 8);
  }

  // Roof texture: soft light/dark blotches break up the flat slab.
  const nb = rng.int(3, 6);
  for (let i = 0; i < nb; i++) {
    st.blotches.push({
      x: rx + rng.range(0, Math.max(4, rw * 0.66)), y: ry + rng.range(0, Math.max(4, rh * 0.66)),
      w: rng.range(20, Math.max(24, rw * 0.34)), h: rng.range(16, Math.max(20, rh * 0.30)),
      a: rng.range(0.04, 0.10), light: rng.chance(0.5),
    });
  }

  if (st.pitched) {
    st.solar = rng.chance(0.34);
    st.chimney = { x: rng.range(rx + 8, Math.max(rx + 10, rx + rw - 22)), y: ry + rh * (rng.chance(0.5) ? 0.18 : 0.60), w: 9, h: 12 };
    if (rng.chance(0.5)) st.skylights.push({ x: rx + rng.range(6, Math.max(8, rw - 32)), y: ry + rng.range(6, Math.max(8, rh - 26)), w: 16, h: 11 });
  } else if (b.kind === 'garage' || b.kind === 'shed') {
    st.props.push({ type: 'vent', x: rx + rw * 0.2, y: ry + rh * 0.25, w: 11, h: 11, s: rng.int(0, 99) });
    if (rng.chance(0.7)) st.props.push({ type: 'ac', x: rx + rw * 0.62, y: ry + rh * 0.38, w: 20, h: 15, s: rng.int(0, 99) });
  } else {
    // Flat commercial roofs: a small cluster of machinery per building.
    const n = rng.int(2, 5);
    for (let i = 0; i < n; i++) {
      const t = rng.pick(['ac', 'ac', 'vent', 'tank', 'skylight']);
      const px = rx + rng.range(6, Math.max(9, rw - 32)), py = ry + rng.range(6, Math.max(9, rh - 32));
      if (t === 'tank') st.props.push({ type: 'tank', x: px + 9, y: py + 9, r: rng.range(7, 11), s: rng.int(0, 99) });
      else if (t === 'skylight') st.skylights.push({ x: px, y: py, w: rng.range(16, 30), h: rng.range(11, 18) });
      else st.props.push({ type: t, x: px, y: py, w: t === 'ac' ? rng.range(15, 26) : rng.range(8, 12), h: t === 'ac' ? rng.range(12, 19) : rng.range(8, 12), s: rng.int(0, 99) });
    }
    if ((b.kind === 'tower' || b.kind === 'hotel') && rng.chance(0.30)) {
      st.props.push({ type: 'garden', x: rx + rng.range(4, Math.max(6, rw * 0.4)), y: ry + rng.range(4, Math.max(6, rh * 0.4)), w: rng.range(30, Math.max(34, Math.min(64, rw * 0.45))), h: rng.range(24, Math.max(28, Math.min(48, rh * 0.4))), s: rng.int(0, 99) });
    }
  }
  b.style = st;
  return b;
}

export function generateWorld(seed = 1337) {
  const rng = new RNG(seed);
  const buildings = [];
  const props = [];
  const trees = [];
  const piers = [];
  const boats = [];
  const signs = [];
  const lots = [];

  // ---- Block cells: land between road edges -------------------------------
  const xEdges = [0, ...ROADS_V.flatMap((c) => [c - ROAD_W / 2, c + ROAD_W / 2]), WORLD.w];
  const yEdges = [0, ...ROADS_H.flatMap((c) => [c - ROAD_W / 2, c + ROAD_W / 2]), WORLD.h];
  const xCells = [], yCells = [];
  for (let i = 0; i < xEdges.length; i += 2) xCells.push([xEdges[i], xEdges[i + 1]]);
  for (let i = 0; i < yEdges.length; i += 2) yCells.push([yEdges[i], yEdges[i + 1]]);

  function addBuilding(x, y, w, h, kind, districtId) {
    const floors = kind === 'tower' ? rng.int(6, 14) : kind === 'hotel' ? rng.int(4, 7) : rng.int(1, 3);
    const b = {
      x, y, w, h, kind, district: districtId,
      color: rng.pick(BUILDING_COLORS[districtId] || BUILDING_COLORS.downtown),
      roof: rng.pick(ROOF_BY_DISTRICT[districtId] || ROOF_COLORS),
      floors,
      // Extrusion height for the 3D renderer (render3d.js): roughly one
      // storey per floor, squat single-storey kinds by their footprint.
      height: kind === 'tower' ? floors * 21
        : kind === 'hotel' ? floors * 19
        : kind === 'house' ? 24
        : kind === 'warehouse' ? 30
        : kind === 'shed' ? 18
        : floors * 19,
      neon: districtId === 'downtown' ? rng.pick(PALETTE.neon) : null,
      seed: rng.int(1, 99999),
    };
    decorateBuilding(b, rng);
    buildings.push(b);
    if (b.neon && rng.chance(0.7)) {
      signs.push({ x: x + w / 2, y: y + 14, color: b.neon, text: rng.pick(['SOL', 'MARA', 'HOTEL', 'BAR', '24H', 'NEON', 'CLUB', 'GYM', 'RAMEN', 'DISCO']) });
    }
    return b;
  }

  for (const [x0, x1] of xCells) {
    for (const [y0, y1] of yCells) {
      const w = x1 - x0, h = y1 - y0;
      if (w < 60 || h < 60) continue;
      const cx = x0 + w / 2, cy = y0 + h / 2;
      if (cy >= WORLD.sandY) continue; // beach strip stays open sand
      const d = districtAt(cx, cy);
      const m = 26; // sidewalk margin inside the block
      const ix = x0 + m, iy = y0 + m, iw = w - m * 2, ih = h - m * 2;
      if (iw < 40 || ih < 40) continue;

      if (d.id === 'park') {
        // Central Park: lawns, a pond, paths, many trees and benches.
        for (let i = 0; i < 26; i++) trees.push({ x: rng.range(x0 + 20, x1 - 20), y: rng.range(y0 + 20, y1 - 20), r: rng.range(13, 22) });
        for (let i = 0; i < 8; i++) props.push({ kind: 'bench', x: rng.range(x0 + 30, x1 - 30), y: rng.range(y0 + 30, y1 - 30), a: rng.range(0, 6.28) });
        props.push({ kind: 'pond', x: cx, y: cy, r: 62 });
        continue;
      }
      if (d.id === 'downtown') {
        // 2x2 tower cluster per block.
        const bw = iw / 2 - 12, bh = ih / 2 - 12;
        for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
          if (rng.chance(0.12)) { // occasional plaza gap — half become parking lots
            if (rng.chance(0.55)) lots.push({ x: ix + i * (bw + 24), y: iy + j * (bh + 24), w: bw, h: bh });
            continue;
          }
          addBuilding(ix + i * (bw + 24), iy + j * (bh + 24), bw, bh, 'tower', 'downtown');
        }
      } else if (d.id === 'suburb') {
        // Rows of small houses with gaps for gardens.
        const bw = Math.min(120, iw / 2 - 18), bh = 74;
        for (let j = 0; j < 3; j++) for (let i = 0; i < 2; i++) {
          if (rng.chance(0.15)) { trees.push({ x: ix + i * (bw + 30) + bw / 2, y: iy + j * (bh + 26) + bh / 2, r: 15 }); continue; }
          addBuilding(ix + i * (bw + 30), iy + j * (bh + 26), bw, bh, 'house', 'suburb');
        }
      } else if (d.id === 'industrial') {
        const bw = iw - 10, bh = ih / 2 - 16;
        addBuilding(ix, iy, bw, bh, 'warehouse', 'industrial');
        if (rng.chance(0.8)) addBuilding(ix, iy + bh + 28, bw, bh, 'warehouse', 'industrial');
        for (let i = 0; i < 5; i++) props.push({ kind: 'crate', x: rng.range(x0 + 14, x1 - 30), y: rng.range(y0 + 14, y1 - 30), s: rng.range(14, 22) });
      } else if (d.id === 'palma') {
        const bw = iw / 2 - 14, bh = ih - 8;
        addBuilding(ix, iy, bw, bh, 'hotel', 'palma');
        if (rng.chance(0.85)) addBuilding(ix + bw + 28, iy, bw, bh, 'hotel', 'palma');
        for (let i = 0; i < 6; i++) props.push({ kind: 'palm', x: rng.range(x0 + 16, x1 - 16), y: rng.range(y0 + 16, y1 - 16) });
      } else if (d.id === 'marina') {
        // Low sheds along the top of the block; open dock apron below.
        if (y0 < 1900) {
          addBuilding(ix, iy, iw / 2 - 10, 92, 'shed', 'marina');
          if (rng.chance(0.8)) addBuilding(ix + iw / 2 + 12, iy, iw / 2 - 22, 92, 'shed', 'marina');
        }
        for (let i = 0; i < 6; i++) props.push({ kind: 'crate', x: rng.range(x0 + 14, x1 - 30), y: rng.range(y0 + 120, y1 - 30), s: rng.range(13, 20) });
        for (let i = 0; i < 4; i++) props.push({ kind: 'barrel', x: rng.range(x0 + 14, x1 - 14), y: rng.range(y0 + 120, y1 - 14) });
      } else {
        addBuilding(ix, iy, iw, ih, 'block', 'downtown');
      }
    }
  }

  // ---- Landmark: Bimo's Garage (mission hub, Casa Verde) -------------------
  // Sits in the open yard south of the house rows in its block; the gold
  // mission marker and both NPCs gather on the street side of it.
  const garage = {
    x: 388, y: 556, w: 204, h: 92, kind: 'garage', district: 'suburb',
    color: '#4f7d8c', roof: '#33525e', floors: 1, height: 22, neon: '#39d5e8', seed: 42,
  };
  decorateBuilding(garage, rng);
  buildings.push(garage);
  signs.push({ x: 490, y: 576, color: '#39d5e8', text: "BIMO'S GARAGE" });
  props.push({ kind: 'crate', x: 616, y: 600, s: 18 });
  props.push({ kind: 'barrel', x: 640, y: 628 });
  props.push({ kind: 'barrel', x: 356, y: 640 });

  // ---- Beach palms + umbrellas --------------------------------------------
  for (let x = 90; x < WORLD.w - 60; x += rng.range(90, 170)) {
    props.push({ kind: 'palm', x, y: WORLD.sandY + rng.range(14, 60) });
    if (rng.chance(0.6)) props.push({ kind: 'umbrella', x: x + rng.range(20, 50), y: WORLD.sandY + rng.range(70, 150), color: rng.pick(PALETTE.neon) });
  }

  // ---- Marina piers + boats -------------------------------------------------
  for (let i = 0; i < 4; i++) {
    const px = 2480 + i * 180;
    piers.push({ x: px, y: WORLD.sandY + 40, w: 34, h: WORLD.h - WORLD.sandY - 70 });
    boats.push({ x: px + 52, y: WORLD.waterY + 55 + (i % 2) * 40, a: Math.PI / 2, color: rng.pick(['#f2f2f2', '#e4572e', '#17bebb', '#ffc914']), len: 52 });
    boats.push({ x: px - 28, y: WORLD.waterY + 80 + (i % 2) * 30, a: Math.PI / 2, color: rng.pick(['#ffffff', '#76b041', '#e4572e']), len: 44 });
  }
  // The getaway boat (mission 6 target) — bigger, gold-trimmed, at Pier 9.
  boats.push({ x: 2820, y: 2530, a: 0, color: '#ffd166', len: 74, hero: true });

  // ---- Street lamps along every road ---------------------------------------
  for (const rx of ROADS_V) for (let y = 70; y < WORLD.sandY; y += 190) {
    props.push({ kind: 'lamp', x: rx - ROAD_W / 2 - 7, y });
    props.push({ kind: 'lamp', x: rx + ROAD_W / 2 + 7, y: y + 95 > WORLD.sandY ? y : y + 95 });
  }
  for (const ry of ROADS_H) for (let x = 120; x < WORLD.w; x += 230) {
    props.push({ kind: 'lamp', x, y: ry - ROAD_W / 2 - 7 });
  }

  // One Downtown tower — the tallest — gets a helipad on its roof.
  let tallest = null;
  for (const b of buildings) if (b.kind === 'tower' && (!tallest || b.floors > tallest.floors)) tallest = b;
  if (tallest && tallest.style) {
    tallest.style.helipad = true;
    tallest.style.props = tallest.style.props.filter((p) => p.type !== 'garden');
    tallest.style.skylights = [];
  }

  // Colliders: buildings are solid; crates are small solids.
  const colliders = [...buildings];
  for (const p of props) if (p.kind === 'crate') colliders.push({ x: p.x - p.s / 2, y: p.y - p.s / 2, w: p.s, h: p.s, kind: 'crate' });

  return { buildings, props, trees, piers, boats, signs, lots, colliders, seed };
}

// ---- Spatial helpers ---------------------------------------------------------

export function isOnRoad(x, y) {
  for (const rx of ROADS_V) if (Math.abs(x - rx) <= ROAD_W / 2) return true;
  for (const ry of ROADS_H) if (Math.abs(y - ry) <= ROAD_W / 2) return true;
  return false;
}

export function nearestRoadPoint(x, y) {
  // Snap to the closest road centre-line point (used for police spawns).
  let best = { x, y }, bd = Infinity;
  for (const rx of ROADS_V) { const d = Math.abs(x - rx); if (d < bd) { bd = d; best = { x: rx, y }; } }
  for (const ry of ROADS_H) { const d = Math.abs(y - ry); if (d < bd) { bd = d; best = { x, y: ry }; } }
  return best;
}

// Circle vs all colliders: push the circle out; returns corrected {x,y,hit}.
export function collideCircle(world, x, y, r) {
  let hit = false;
  for (const b of world.colliders) {
    const nx = Math.max(b.x, Math.min(x, b.x + b.w));
    const ny = Math.max(b.y, Math.min(y, b.y + b.h));
    let dx = x - nx, dy = y - ny;
    const d2 = dx * dx + dy * dy;
    if (d2 < r * r) {
      hit = true;
      if (d2 === 0) { // centre inside the rect: push out along smallest exit
        const left = x - b.x, right = b.x + b.w - x, top = y - b.y, bot = b.y + b.h - y;
        const m = Math.min(left, right, top, bot);
        if (m === left) x = b.x - r; else if (m === right) x = b.x + b.w + r;
        else if (m === top) y = b.y - r; else y = b.y + b.h + r;
      } else {
        const d = Math.sqrt(d2);
        x = nx + (dx / d) * r; y = ny + (dy / d) * r;
      }
    }
  }
  x = Math.max(r, Math.min(WORLD.w - r, x));
  y = Math.max(r, Math.min(WORLD.h - r, y));
  return { x, y, hit };
}

// Oriented car vs colliders: sample the car's 4 corners + centre as circles.
export function carCollides(world, car) {
  const hl = car.len / 2, hw = car.wid / 2;
  const cos = Math.cos(car.angle), sin = Math.sin(car.angle);
  const pts = [
    [hl, hw], [hl, -hw], [-hl, hw], [-hl, -hw], [0, 0],
  ];
  for (const [lx, ly] of pts) {
    const px = car.x + lx * cos - ly * sin;
    const py = car.y + lx * sin + ly * cos;
    for (const b of world.colliders) {
      if (px > b.x - 3 && px < b.x + b.w + 3 && py > b.y - 3 && py < b.y + b.h + 3) return b;
    }
  }
  return null;
}

// Point-in-water check (feet / cars must not enter the bay, piers excepted).
export function inWater(world, x, y) {
  if (y < WORLD.waterY) return false;
  for (const p of world.piers) {
    if (x >= p.x - 4 && x <= p.x + p.w + 4 && y >= p.y && y <= p.y + p.h) return false;
  }
  return true;
}

export { DISTRICTS, LANE };
