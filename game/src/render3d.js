// ============================================================================
// SOLMARA UNDERTOW — render3d.js
// A hand-rolled WebGL 1 renderer (no libraries, no network) that lifts the
// exact same world the 2D renderer paints into real 3D: extruded buildings
// with lit window rows and rooftop machinery, a textured ground plane that
// carries the whole road network, box-built cars and articulated people,
// a third-person chase camera, sky gradient + sun, fog, and the day/night
// grade carried over from render.js's lighting() model.
//
// Coordinate mapping is deliberately boring: world (x, y) stays the ground
// plane — 3D X = world x (east), 3D Z = world y (south), 3D Y = up. A world
// heading angle a (atan2(dy, dx)) becomes the 3D direction (cos a, 0, sin a),
// so every position, angle and AI decision in world.js / entities.js /
// main.js means exactly what it meant in 2D. Only drawing moved.
//
// Structure:
//   - static merged geometry (buildings, props, trees, piers, boats) built
//     once per world into one GPU buffer; the ground is one textured plane
//     whose texture is painted from world.js road/district data onto an
//     offscreen canvas; neon signs share one texture atlas.
//   - one dynamic batch rebuilt per frame (cars, people, particles, tire
//     marks, mission beacon) and one translucent batch (marker beam,
//     headlight cones).
//   - HUD / minimap / dialog / menus stay on the 2D overlay canvas (hud.js),
//     composited by index.html stacking #game above #gl.
// ?flat=1 (or a failed WebGL context) keeps the v1 2D renderer — render.js
// is untouched and remains the fallback.
// ============================================================================

import {
  WORLD, ROADS_V, ROADS_H, ROAD_W, PALETTE, DISTRICTS, districtAt,
} from './config.js';
import { lighting } from './render.js';

const VIEW_W = 1280, VIEW_H = 800;

// ---------------------------------------------------------------------------
// Colour helpers: everything in the game is a CSS colour string; the GPU
// wants float triples. Parsing is cached — the same strings recur per frame.
// ---------------------------------------------------------------------------
const _colorCache = new Map();
export function parseColor(str) {
  let c = _colorCache.get(str);
  if (c) return c;
  c = [1, 1, 1];
  if (typeof str === 'string') {
    if (str[0] === '#') {
      let hex = str.slice(1);
      if (hex.length === 3) hex = hex.split('').map((ch) => ch + ch).join('');
      const n = parseInt(hex, 16);
      if (!Number.isNaN(n)) c = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    } else {
      const m = str.match(/[\d.]+/g);
      if (m && m.length >= 3) c = [Number(m[0]) / 255, Number(m[1]) / 255, Number(m[2]) / 255];
    }
  }
  _colorCache.set(str, c);
  return c;
}
// f > 0 lightens toward white, f < 0 darkens toward black (mirrors world.js).
function shadeC(rgb, f) {
  if (f >= 0) return [rgb[0] + (1 - rgb[0]) * f, rgb[1] + (1 - rgb[1]) * f, rgb[2] + (1 - rgb[2]) * f];
  const k = 1 + f;
  return [rgb[0] * k, rgb[1] * k, rgb[2] * k];
}
function mixC(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// ---------------------------------------------------------------------------
// Minimal mat4 (column-major, WebGL convention) + vec3 helpers.
// ---------------------------------------------------------------------------
function matPerspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f;
  m[10] = (far + near) / (near - far); m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}
function matLookAt(eye, center, up) {
  let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
  let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  const m = new Float32Array(16);
  m[0] = xx; m[1] = yx; m[2] = zx;
  m[4] = xy; m[5] = yy; m[6] = zy;
  m[8] = xz; m[9] = yz; m[10] = zz;
  m[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  m[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  m[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  m[15] = 1;
  return m;
}
function matMultiply(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
// Shortest-arc angle lerp for the chase camera yaw.
function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// ---------------------------------------------------------------------------
// Geometry batch: interleaved verts [pos3, normal3, color3, emissive3, mode]
// mode 0 = plain lit, 1 = emissive scaled by night, 2 = emissive always.
// ---------------------------------------------------------------------------
const STRIDE = 13;
class Geo {
  constructor() { this.v = []; this.i = []; }
  get vertCount() { return this.v.length / STRIDE; }
  vert(p, n, col, emi, mode) {
    this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], col[0], col[1], col[2], emi[0], emi[1], emi[2], mode);
  }
  tri(p1, p2, p3, col, emi = null, mode = 0) {
    const e1 = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
    const e2 = [p3[0] - p1[0], p3[1] - p1[1], p3[2] - p1[2]];
    let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1; n = [n[0] / l, n[1] / l, n[2] / l];
    const e = emi || [0, 0, 0];
    const base = this.vertCount;
    this.vert(p1, n, col, e, mode); this.vert(p2, n, col, e, mode); this.vert(p3, n, col, e, mode);
    this.i.push(base, base + 1, base + 2);
  }
  quad(p1, p2, p3, p4, col, emi = null, mode = 0) {
    const e1 = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
    const e2 = [p4[0] - p1[0], p4[1] - p1[1], p4[2] - p1[2]];
    let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1; n = [n[0] / l, n[1] / l, n[2] / l];
    const e = emi || [0, 0, 0];
    const base = this.vertCount;
    this.vert(p1, n, col, e, mode); this.vert(p2, n, col, e, mode);
    this.vert(p3, n, col, e, mode); this.vert(p4, n, col, e, mode);
    this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  // Box from a centre, three orthonormal basis vectors (u = length axis,
  // v = up, w = lateral) and half extents. cols order: [+w, -w, +u, -u, +v, -v].
  box(c, u, v, w, hu, hv, hw, cols, emi = null, mode = 0) {
    const P = (su, sv, sw) => [
      c[0] + u[0] * su * hu + v[0] * sv * hv + w[0] * sw * hw,
      c[1] + u[1] * su * hu + v[1] * sv * hv + w[1] * sw * hw,
      c[2] + u[2] * su * hu + v[2] * sv * hv + w[2] * sw * hw,
    ];
    const F = [
      [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
      [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]],
      [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]],
      [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]],
      [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]],
      [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]],
    ];
    for (let f = 0; f < 6; f++) {
      const q = F[f];
      this.quad(P(...q[0]), P(...q[1]), P(...q[2]), P(...q[3]), cols[f], emi, mode);
    }
  }
  // Axis-aligned box from min/max corners — the static-city workhorse.
  boxAA(x0, y0, z0, x1, y1, z1, cols, emi = null, mode = 0) {
    this.box([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2],
      [1, 0, 0], [0, 1, 0], [0, 0, 1],
      (x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2, cols, emi, mode);
  }
  // Vertical prism (cylinder with n sides) — tanks, barrels, tree trunks,
  // marker discs. Centre is (cx, cz) in world ground coords; base at yBase.
  prism(cx, yBase, cz, r, h, n, colSide, colTop, rot = 0) {
    const ring = [];
    for (let i = 0; i < n; i++) {
      const a = rot + (i / n) * Math.PI * 2;
      ring.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.quad(
        [ring[i][0], yBase, ring[i][1]], [ring[j][0], yBase, ring[j][1]],
        [ring[j][0], yBase + h, ring[j][1]], [ring[i][0], yBase + h, ring[i][1]], colSide);
    }
    for (let i = 1; i < n - 1; i++) {
      this.tri([cx, yBase + h, cz], [ring[i + 1][0], yBase + h, ring[i + 1][1]], [ring[i][0], yBase + h, ring[i][1]], colTop);
    }
  }
  // Tapered vertical prism (frustum): ring radius r0 at height y0, r1 at
  // y1 — the AIR-1 searchlight cone.
  frustum(cx, cz, y0, r0, y1, r1, n, col, emi = null, mode = 0) {
    const ring = (y, r) => {
      const pts = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        pts.push([cx + Math.cos(a) * r, y, cz + Math.sin(a) * r]);
      }
      return pts;
    };
    const lo = ring(y0, r0), hi = ring(y1, r1);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.quad(lo[i], lo[j], hi[j], hi[i], col, emi, mode);
    }
  }
  // Cylinder around an arbitrary axis (car wheels).
  cylinder(c, axis, r, len, n, col) {
    let t1 = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    // t1 = normalize(axis × t1pick), t2 = axis × t1
    let tx = axis[1] * t1[2] - axis[2] * t1[1], ty = axis[2] * t1[0] - axis[0] * t1[2], tz = axis[0] * t1[1] - axis[1] * t1[0];
    let l = Math.hypot(tx, ty, tz) || 1; t1 = [tx / l, ty / l, tz / l];
    const t2 = [axis[1] * t1[2] - axis[2] * t1[1], axis[2] * t1[0] - axis[0] * t1[2], axis[0] * t1[1] - axis[1] * t1[0]];
    const ringAt = (s) => {
      const pts = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2, ca = Math.cos(a) * r, sa = Math.sin(a) * r;
        pts.push([
          c[0] + axis[0] * s + t1[0] * ca + t2[0] * sa,
          c[1] + axis[1] * s + t1[1] * ca + t2[1] * sa,
          c[2] + axis[2] * s + t1[2] * ca + t2[2] * sa,
        ]);
      }
      return pts;
    };
    const rA = ringAt(-len / 2), rB = ringAt(len / 2);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.quad(rA[i], rA[j], rB[j], rB[i], col);
      this.tri([c[0] - axis[0] * len / 2, c[1] - axis[1] * len / 2, c[2] - axis[2] * len / 2], rA[j], rA[i], col);
      this.tri([c[0] + axis[0] * len / 2, c[1] + axis[1] * len / 2, c[2] + axis[2] * len / 2], rB[i], rB[j], col);
    }
  }
  // Low-poly sphere (foliage blobs).
  sphere(cx, cy, cz, r, col, lon = 7, lat = 5) {
    const pt = (i, j) => {
      const th = (i / lon) * Math.PI * 2, ph = (j / lat) * Math.PI;
      return [cx + r * Math.sin(ph) * Math.cos(th), cy + r * Math.cos(ph), cz + r * Math.sin(ph) * Math.sin(th)];
    };
    for (let i = 0; i < lon; i++) for (let j = 0; j < lat; j++) {
      const a = pt(i, j), b = pt(i + 1, j), c2 = pt(i + 1, j + 1), d = pt(i, j + 1);
      if (j === 0) this.tri(a, b, c2, col);
      else if (j === lat - 1) this.tri(a, c2, d, col);
      else this.quad(a, b, c2, d, col);
    }
  }
}

// Basis for a world heading angle: u = forward, v = up, w = lateral.
function yawBasis(angle) {
  const ca = Math.cos(angle), sa = Math.sin(angle);
  return { u: [ca, 0, sa], v: [0, 1, 0], w: [-sa, 0, ca] };
}
// Rotate basis (u,v) around the lateral axis w by pitch (leg/arm swing).
function pitchedBasis(b, pitch) {
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const u = [b.u[0] * cp + b.v[0] * sp, b.u[1] * cp + b.v[1] * sp, b.u[2] * cp + b.v[2] * sp];
  const v = [-b.u[0] * sp + b.v[0] * cp, -b.u[1] * sp + b.v[1] * cp, -b.u[2] * sp + b.v[2] * cp];
  return { u, v, w: b.w };
}

// ---------------------------------------------------------------------------
// Ground texture: the whole city floor — district tints, sidewalks, asphalt,
// lane dashes, crosswalks, parking lots, sand and water — painted once from
// world/config data onto an offscreen canvas at half world scale.
// ---------------------------------------------------------------------------
const GROUND_SCALE = 0.5;
function paintGroundTexture(world) {
  const cv = document.createElement('canvas');
  cv.width = Math.round(WORLD.w * GROUND_SCALE);
  cv.height = Math.round(WORLD.h * GROUND_SCALE);
  const g = cv.getContext('2d');
  g.scale(GROUND_SCALE, GROUND_SCALE);
  g.fillStyle = '#8f8b82';
  g.fillRect(0, 0, WORLD.w, WORLD.h);
  for (const d of DISTRICTS) { g.fillStyle = d.ground; g.fillRect(d.x, d.y, d.w, d.h); }
  // Park mow stripes
  const park = DISTRICTS.find((d) => d.id === 'park');
  if (park) {
    g.fillStyle = 'rgba(255,255,255,0.05)';
    for (let x = park.x; x < park.x + park.w; x += 76) g.fillRect(x, park.y, 38, park.h);
  }
  // Parking lots
  for (const lot of world.lots || []) {
    g.fillStyle = '#43464c'; g.fillRect(lot.x, lot.y, lot.w, lot.h);
    g.strokeStyle = 'rgba(200,194,180,0.8)'; g.lineWidth = 2.5;
    g.strokeRect(lot.x + 2, lot.y + 2, lot.w - 4, lot.h - 4);
    g.strokeStyle = 'rgba(232,217,138,0.7)'; g.lineWidth = 2;
    g.beginPath();
    for (let x = lot.x + 18; x < lot.x + lot.w - 12; x += 27) {
      g.moveTo(x, lot.y + 4); g.lineTo(x, lot.y + 30);
      g.moveTo(x, lot.y + lot.h - 4); g.lineTo(x, lot.y + lot.h - 30);
    }
    g.stroke();
  }
  // Sand + water
  g.fillStyle = PALETTE.sand;
  g.fillRect(0, WORLD.sandY, WORLD.w, WORLD.waterY - WORLD.sandY);
  const wg = g.createLinearGradient(0, WORLD.waterY, 0, WORLD.h);
  wg.addColorStop(0, PALETTE.water); wg.addColorStop(1, PALETTE.waterDeep);
  g.fillStyle = wg;
  g.fillRect(0, WORLD.waterY, WORLD.w, WORLD.h - WORLD.waterY);
  // Park pond
  for (const p of world.props) {
    if (p.kind !== 'pond') continue;
    g.fillStyle = '#3d7ea6';
    g.beginPath(); g.arc(p.x, p.y, p.r, 0, 7); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.16)';
    g.beginPath(); g.arc(p.x - 14, p.y - 10, p.r * 0.45, 0, 7); g.fill();
  }
  // Sidewalks then asphalt
  g.fillStyle = PALETTE.sidewalk;
  for (const rx of ROADS_V) g.fillRect(rx - ROAD_W / 2 - 10, 0, ROAD_W + 20, WORLD.sandY + 30);
  for (const ry of ROADS_H) g.fillRect(0, ry - ROAD_W / 2 - 10, WORLD.w, ROAD_W + 20);
  g.fillStyle = PALETTE.asphalt;
  for (const rx of ROADS_V) g.fillRect(rx - ROAD_W / 2, 0, ROAD_W, WORLD.sandY + 30);
  for (const ry of ROADS_H) g.fillRect(0, ry - ROAD_W / 2, WORLD.w, ROAD_W);
  g.fillStyle = PALETTE.asphaltEdge;
  for (const rx of ROADS_V) { g.fillRect(rx - ROAD_W / 2, 0, 3, WORLD.sandY + 30); g.fillRect(rx + ROAD_W / 2 - 3, 0, 3, WORLD.sandY + 30); }
  for (const ry of ROADS_H) { g.fillRect(0, ry - ROAD_W / 2, WORLD.w, 3); g.fillRect(0, ry + ROAD_W / 2 - 3, WORLD.w, 3); }
  // Centre dashes
  g.fillStyle = PALETTE.laneMark;
  for (const rx of ROADS_V) for (let y = 14; y < WORLD.sandY; y += 44) g.fillRect(rx - 2, y, 4, 24);
  for (const ry of ROADS_H) for (let x = 14; x < WORLD.w; x += 44) g.fillRect(x, ry - 2, 24, 4);
  // Crosswalks
  g.fillStyle = PALETTE.crosswalk;
  for (const rx of ROADS_V) for (const ry of ROADS_H) {
    for (let i = -2; i <= 2; i++) {
      g.fillRect(rx - ROAD_W / 2 - 8, ry + i * 20 - 5, 10, 10);
      g.fillRect(rx + ROAD_W / 2 - 2, ry + i * 20 - 5, 10, 10);
      g.fillRect(rx + i * 20 - 5, ry - ROAD_W / 2 - 8, 10, 10);
      g.fillRect(rx + i * 20 - 5, ry + ROAD_W / 2 - 2, 10, 10);
    }
  }
  return cv;
}

// Animated water sparkle: a small repeating stripe tile scrolled per frame.
function paintSparkleTexture() {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 128;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, 128, 128);
  g.fillStyle = 'rgba(255,255,255,0.20)';
  for (let i = 0; i < 7; i++) {
    const y = (i * 37) % 128, x = (i * 53) % 100;
    g.fillRect(x, y, 20 + (i % 3) * 8, 2.5);
  }
  return cv;
}

// ---------------------------------------------------------------------------
// Neon sign atlas: every world sign's text drawn once into a shared canvas;
// the static build places one textured quad per sign on its building face.
// Returns { canvas, cells: Map<sign, {u0,v0,u1,v1}> }.
// ---------------------------------------------------------------------------
function buildSignAtlas(world) {
  const cellW = 256, cellH = 64, cols = 8;
  const rows = Math.max(1, Math.ceil(world.signs.length / cols));
  const cv = document.createElement('canvas');
  cv.width = cellW * cols; cv.height = cellH * rows;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  const cells = new Map();
  world.signs.forEach((s, idx) => {
    const cx = (idx % cols) * cellW, cy = Math.floor(idx / cols) * cellH;
    g.font = 'bold 40px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = s.color; g.shadowBlur = 14;
    g.fillStyle = s.color;
    g.fillText(s.text, cx + cellW / 2, cy + cellH / 2 + 2);
    g.shadowBlur = 0;
    cells.set(s, {
      u0: cx / cv.width, v0: cy / cv.height,
      u1: (cx + cellW) / cv.width, v1: (cy + cellH) / cv.height,
    });
  });
  return { canvas: cv, cells };
}

// Textured-quad batch (ground plane, water sparkle, sign billboards):
// verts are [pos3, uv2].
class TexGeo {
  constructor() { this.v = []; this.i = []; }
  quad(p1, p2, p3, p4, uv) {
    const base = this.v.length / 5;
    const pts = [p1, p2, p3, p4];
    for (let k = 0; k < 4; k++) this.v.push(pts[k][0], pts[k][1], pts[k][2], uv[k][0], uv[k][1]);
    this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

// ---------------------------------------------------------------------------
// Static city build: buildings (extruded, window rows, roof kit, pitched
// roofs), props, trees, piers, boats — merged into one Geo.
// ---------------------------------------------------------------------------
function buildingHeight(b) {
  if (b.height) return b.height;
  if (b.kind === 'house') return 24;
  if (b.kind === 'warehouse') return 30;
  if (b.kind === 'shed') return 18;
  return (b.floors || 2) * 19;
}

function buildStaticWorld(world) {
  const geo = new Geo();
  const signs = new TexGeo();
  const atlas = buildSignAtlas(world);

  for (const b of world.buildings) {
    const st = b.style;
    const H = buildingHeight(b);
    const wall = parseColor(st ? st.wall : b.color);
    const wallDark = parseColor(st ? st.wallDark : b.color);
    const roofC = parseColor(st ? st.roofColor : b.roof);
    const x0 = b.x, z0 = b.y, x1 = b.x + b.w, z1 = b.y + b.h;
    // Walls: south face (toward street, +z) darkest, east/west mid, top roof.
    const cols = [shadeC(wall, -0.06), shadeC(wall, -0.16), shadeC(wall, 0.02), shadeC(wall, -0.10), roofC, shadeC(wall, -0.3)];
    geo.boxAA(x0, 0, z0, x1, H, z1, cols);
    if (!st) continue;
    const inset = st.inset;
    const rx = x0 + inset, rz = z0 + inset, rw = b.w - inset * 2, rh = b.h - inset * 2;

    if (st.pitched) {
      // Pitched roof: two slopes meeting at a ridge along X, gable ends.
      const ridgeH = H + Math.min(13, rh * 0.22);
      const eave = H - 1;
      const midZ = z0 + b.h / 2;
      geo.quad([rx, eave, rz], [rx + rw, eave, rz], [rx + rw, ridgeH, midZ], [rx, ridgeH, midZ], parseColor(st.slopeA));
      geo.quad([rx + rw, eave, rz + rh], [rx, eave, rz + rh], [rx, ridgeH, midZ], [rx + rw, ridgeH, midZ], parseColor(st.slopeB));
      geo.tri([rx, eave, rz], [rx, ridgeH, midZ], [rx, eave, rz + rh], shadeC(parseColor(st.wall), -0.05));
      geo.tri([rx + rw, eave, rz + rh], [rx + rw, ridgeH, midZ], [rx + rw, eave, rz], shadeC(parseColor(st.wall), -0.05));
      if (st.solar) {
        geo.boxAA(rx + rw * 0.14, ridgeH - 3.4, midZ + rh * 0.10, rx + rw * 0.14 + Math.min(46, rw * 0.42), ridgeH - 2.2, midZ + rh * 0.10 + rh * 0.30,
          [[0.08, 0.16, 0.28], [0.08, 0.16, 0.28], [0.08, 0.16, 0.28], [0.08, 0.16, 0.28], [0.11, 0.21, 0.33], [0.05, 0.1, 0.18]]);
      }
      if (st.chimney) {
        const cx = b.x + st.chimney.x, cz = b.y + st.chimney.y;
        geo.boxAA(cx, H - 2, cz, cx + st.chimney.w, ridgeH + 4, cz + st.chimney.h,
          [[0.5, 0.27, 0.21], [0.5, 0.27, 0.21], [0.5, 0.27, 0.21], [0.5, 0.27, 0.21], [0.36, 0.19, 0.14], [0.3, 0.16, 0.12]]);
      }
    } else {
      // Parapet lip + rooftop kit from the 2D style data.
      const par = parseColor(st.parapetLight), parD = parseColor(st.parapetDark);
      geo.boxAA(rx - 2, H, rz - 2, rx + rw + 2, H + 2.6, rz + 2, [par, parD, par, parD, par, parD]);
      geo.boxAA(rx - 2, H, rz + rh - 2, rx + rw + 2, H + 2.6, rz + rh + 2, [par, parD, par, parD, par, parD]);
      geo.boxAA(rx - 2, H, rz - 2, rx + 2, H + 2.6, rz + rh + 2, [par, parD, par, parD, par, parD]);
      geo.boxAA(rx + rw - 2, H, rz - 2, rx + rw + 2, H + 2.6, rz + rh + 2, [par, parD, par, parD, par, parD]);
      for (const p of st.props) {
        const px = b.x + p.x, pz = b.y + p.y;
        if (p.type === 'ac') {
          geo.boxAA(px, H, pz, px + p.w, H + 6, pz + p.h,
            [[0.6, 0.63, 0.64], [0.55, 0.58, 0.59], [0.62, 0.65, 0.66], [0.55, 0.58, 0.59], [0.48, 0.51, 0.53], [0.4, 0.42, 0.44]]);
        } else if (p.type === 'vent') {
          geo.boxAA(px, H, pz, px + p.w, H + 4.5, pz + p.h,
            [[0.55, 0.57, 0.58], [0.5, 0.52, 0.53], [0.56, 0.58, 0.59], [0.5, 0.52, 0.53], [0.45, 0.47, 0.48], [0.38, 0.4, 0.41]]);
        } else if (p.type === 'tank') {
          geo.prism(px, H, pz, p.r, 10, 9, [0.62, 0.58, 0.48], [0.55, 0.5, 0.4]);
        } else if (p.type === 'garden') {
          geo.boxAA(px, H, pz, px + p.w, H + 2.2, pz + p.h,
            [[0.29, 0.48, 0.24], [0.29, 0.48, 0.24], [0.29, 0.48, 0.24], [0.29, 0.48, 0.24], [0.35, 0.56, 0.28], [0.2, 0.34, 0.16]]);
          geo.sphere(px + p.w * 0.3, H + 5, pz + p.h * 0.4, 5.5, [0.32, 0.55, 0.26], 6, 4);
          geo.sphere(px + p.w * 0.7, H + 5, pz + p.h * 0.65, 4.5, [0.36, 0.6, 0.29], 6, 4);
        }
      }
      for (const sk of st.skylights) {
        geo.boxAA(b.x + sk.x, H, b.y + sk.y, b.x + sk.x + sk.w, H + 1.6, b.y + sk.y + sk.h,
          [[0.55, 0.75, 0.85], [0.55, 0.75, 0.85], [0.55, 0.75, 0.85], [0.55, 0.75, 0.85], [0.65, 0.84, 0.92], [0.4, 0.55, 0.65]],
          [1.0, 0.84, 0.5], 1);
      }
      if (st.helipad) {
        const cx = b.x + b.w / 2, cz = b.y + b.h / 2, r = Math.min(rw, rh) * 0.32;
        geo.prism(cx, H + 0.4, cz, r, 0.7, 18, [0.16, 0.16, 0.18], [0.2, 0.2, 0.22]);
        const hc = [0.94, 0.94, 0.9];
        geo.boxAA(cx - r * 0.36, H + 1.2, cz - r * 0.08, cx - r * 0.2, H + 1.7, cz + r * 0.08, [hc, hc, hc, hc, hc, hc], [0.9, 0.9, 0.85], 1);
        geo.boxAA(cx + r * 0.2, H + 1.2, cz - r * 0.08, cx + r * 0.36, H + 1.7, cz + r * 0.08, [hc, hc, hc, hc, hc, hc], [0.9, 0.9, 0.85], 1);
        geo.boxAA(cx - r * 0.08, H + 1.2, cz - r * 0.34, cx + r * 0.08, H + 1.7, cz + r * 0.34, [hc, hc, hc, hc, hc, hc], [0.9, 0.9, 0.85], 1);
      }
    }

    // Window rows on the south + east + north + west faces, from the 2D
    // facade pane layout, repeated per storey. Each pane is a single quad
    // (not a box) to keep the merged city light. Lit panes glow after
    // dark (mode 1, warm or cool by the pane's own hash).
    const rows = Math.max(1, Math.min(6, Math.round(H / 17)));
    const glassDay = [0.55, 0.72, 0.82];
    for (const f of st.facade) {
      const litSeed = (f.s % 10) / 10;
      const emi = litSeed < 0.42 ? [1.0, 0.72, 0.34] : litSeed < 0.55 ? [0.62, 0.82, 1.0] : [0, 0, 0];
      for (let row = 0; row < rows; row++) {
        const yC = rows === 1 ? H * 0.5 : 5 + row * ((H - 11) / (rows - 1));
        const yB = yC - 2.4, yT = yC + 2.4;
        if (f.y < 6) { // north face (along the top edge in 2D), facing -z
          const z = z0 - 0.45, xa = b.x + f.x, xb = xa + f.w;
          geo.quad([xb, yB, z], [xa, yB, z], [xa, yT, z], [xb, yT, z], glassDay, emi, 1);
        } else if (f.y > b.h - 10) { // south face, facing +z
          if (st.awning) continue; // storefront glass band instead (below)
          const z = z1 + 0.45, xa = b.x + f.x, xb = xa + f.w;
          geo.quad([xa, yB, z], [xb, yB, z], [xb, yT, z], [xa, yT, z], glassDay, emi, 1);
        } else if (f.x < 6) { // west face, facing -x
          const x = x0 - 0.45, za = b.y + f.y, zb = za + f.h;
          geo.quad([x, yB, zb], [x, yT, zb], [x, yT, za], [x, yB, za], glassDay, emi, 1);
        } else if (f.x > b.w - 10) { // east face, facing +x
          const x = x1 + 0.45, za = b.y + f.y, zb = za + f.h;
          geo.quad([x, yB, za], [x, yT, za], [x, yT, zb], [x, yB, zb], glassDay, emi, 1);
        }
      }
    }
    // Storefront: glass band + awning slab on the south face.
    if (st.awning) {
      const awn = parseColor(st.awning.color);
      geo.boxAA(x0 + 6, 3, z1 - 0.5, x1 - 6, 11, z1 + 0.5,
        [[0.62, 0.82, 0.9], [0.62, 0.82, 0.9], [0.62, 0.82, 0.9], [0.62, 0.82, 0.9], [0.62, 0.82, 0.9], [0.4, 0.55, 0.62]],
        [1.0, 0.8, 0.45], 1);
      geo.boxAA(x0 + 8, 11.5, z1, x1 - 8, 13, z1 + 9,
        [awn, shadeC(awn, -0.2), awn, shadeC(awn, -0.2), shadeC(awn, 0.15), shadeC(awn, -0.3)]);
    }
  }

  // ---- Props ---------------------------------------------------------------
  for (const p of world.props) {
    if (p.kind === 'lamp') {
      geo.boxAA(p.x - 1.1, 0, p.y - 1.1, p.x + 1.1, 15, p.y + 1.1,
        [[0.23, 0.25, 0.27], [0.23, 0.25, 0.27], [0.23, 0.25, 0.27], [0.23, 0.25, 0.27], [0.3, 0.32, 0.35], [0.15, 0.16, 0.18]]);
      geo.boxAA(p.x - 2.2, 15, p.y - 2.2, p.x + 2.2, 17, p.y + 2.2,
        [[1, 0.85, 0.5], [1, 0.85, 0.5], [1, 0.85, 0.5], [1, 0.85, 0.5], [1, 0.9, 0.6], [0.5, 0.42, 0.25]],
        [1.0, 0.8, 0.45], 1);
    } else if (p.kind === 'crate') {
      const s = p.s, c = [0.6, 0.48, 0.31];
      geo.boxAA(p.x - s / 2, 0, p.y - s / 2, p.x + s / 2, s * 0.8, p.y + s / 2,
        [c, shadeC(c, -0.15), c, shadeC(c, -0.15), shadeC(c, 0.12), shadeC(c, -0.3)]);
    } else if (p.kind === 'barrel') {
      geo.prism(p.x, 0, p.y, 6.5, 13, 9, [0.66, 0.26, 0.22], [0.58, 0.22, 0.19]);
    } else if (p.kind === 'bench') {
      const b = yawBasis(p.a);
      geo.box([p.x, 3.4, p.y], b.u, b.v, b.w, 11, 1.1, 3, [[0.43, 0.32, 0.21], [0.43, 0.32, 0.21], [0.43, 0.32, 0.21], [0.43, 0.32, 0.21], [0.5, 0.38, 0.25], [0.3, 0.22, 0.14]]);
      geo.box([p.x - b.u[0] * 0 + b.w[0] * -3.4, 6.4, p.y + b.w[2] * -3.4], b.u, b.v, b.w, 11, 3.4, 1,
        [[0.43, 0.32, 0.21], [0.43, 0.32, 0.21], [0.43, 0.32, 0.21], [0.43, 0.32, 0.21], [0.5, 0.38, 0.25], [0.3, 0.22, 0.14]]);
    } else if (p.kind === 'umbrella') {
      const c = parseColor(p.color);
      geo.boxAA(p.x - 0.8, 0, p.y - 0.8, p.x + 0.8, 13, p.y + 0.8,
        [[0.85, 0.85, 0.85], [0.85, 0.85, 0.85], [0.85, 0.85, 0.85], [0.85, 0.85, 0.85], [0.9, 0.9, 0.9], [0.6, 0.6, 0.6]]);
      // Cone: prism with a point top, approximated by an 8-gon disc + apex tris.
      const n = 8, r = 14;
      for (let i = 0; i < n; i++) {
        const a1 = (i / n) * Math.PI * 2, a2 = ((i + 1) / n) * Math.PI * 2;
        geo.tri([p.x, 19, p.y],
          [p.x + Math.cos(a2) * r, 13.5, p.y + Math.sin(a2) * r],
          [p.x + Math.cos(a1) * r, 13.5, p.y + Math.sin(a1) * r], c);
      }
    } else if (p.kind === 'palm') {
      // Leaning trunk from three stacked segments + six drooping fronds.
      let tx = p.x, tz = p.y, ty = 0;
      const lean = 0.16;
      for (let sgm = 0; sgm < 3; sgm++) {
        geo.boxAA(tx - 1.8, ty, tz - 1.8, tx + 1.8, ty + 7, tz + 1.8,
          [[0.48, 0.36, 0.24], [0.42, 0.31, 0.2], [0.48, 0.36, 0.24], [0.42, 0.31, 0.2], [0.55, 0.42, 0.28], [0.35, 0.26, 0.16]]);
        tx += lean * 7; ty += 7;
      }
      const topY = ty + 2;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + 0.4;
        const dirH = [Math.cos(a), 0, Math.sin(a)];
        const wv = [-Math.sin(a), 0, Math.cos(a)];
        const uu = [dirH[0] * 0.86, -0.5, dirH[2] * 0.86];
        const ul = Math.hypot(uu[0], uu[1], uu[2]); uu[0] /= ul; uu[1] /= ul; uu[2] /= ul;
        const vv = [wv[1] * uu[2] - wv[2] * uu[1], wv[2] * uu[0] - wv[0] * uu[2], wv[0] * uu[1] - wv[1] * uu[0]];
        geo.box([tx + uu[0] * 8, topY + uu[1] * 8, tz + uu[2] * 8], uu, vv, wv, 8.5, 0.5, 1.6,
          [[0.24, 0.55, 0.31], [0.24, 0.55, 0.31], [0.24, 0.55, 0.31], [0.24, 0.55, 0.31], [0.3, 0.65, 0.36], [0.16, 0.4, 0.22]]);
      }
    }
  }
  for (const t of world.trees) {
    geo.prism(t.x, 0, t.y, 2.4, 9, 6, [0.42, 0.31, 0.2], [0.48, 0.36, 0.24]);
    geo.sphere(t.x, 9 + t.r * 0.55, t.y, t.r, [0.18, 0.42, 0.18]);
    geo.sphere(t.x - t.r * 0.3, 9 + t.r * 0.8, t.y - t.r * 0.25, t.r * 0.62, [0.25, 0.49, 0.22]);
  }

  // ---- Piers + boats ---------------------------------------------------------
  for (const p of world.piers) {
    geo.boxAA(p.x, 0, p.y, p.x + p.w, 5, p.y + p.h,
      [[0.48, 0.38, 0.28], [0.42, 0.33, 0.24], [0.48, 0.38, 0.28], [0.42, 0.33, 0.24], [0.55, 0.44, 0.33], [0.3, 0.23, 0.16]]);
  }
  for (const bt of world.boats) {
    const b = yawBasis(bt.a);
    const hull = parseColor(bt.color);
    geo.box([bt.x, 4.5, bt.y], b.u, b.v, b.w, bt.len / 2, 4.5, 11,
      [hull, shadeC(hull, -0.2), shadeC(hull, 0.05), shadeC(hull, -0.15), shadeC(hull, 0.14), shadeC(hull, -0.35)]);
    geo.box([bt.x, 11, bt.y], b.u, b.v, b.w, bt.len / 6, 2.4, 7,
      [[0.95, 0.95, 0.95], [0.9, 0.9, 0.9], [0.95, 0.95, 0.95], [0.9, 0.9, 0.9], [1, 1, 1], [0.7, 0.7, 0.7]]);
    if (bt.hero) {
      const gold = [1.0, 0.82, 0.4];
      geo.box([bt.x, 8.6, bt.y], b.u, b.v, b.w, bt.len / 2, 0.8, 11.3,
        [gold, gold, gold, gold, gold, gold], [0.8, 0.6, 0.2], 1);
    }
  }

  // ---- Neon sign billboards (textured, from the atlas) ----------------------
  for (const s of world.signs) {
    const cell = atlas.cells.get(s);
    if (!cell) continue;
    // The sign belongs to the building whose top edge sits 14px above it.
    const host = world.buildings.find((bb) => Math.abs(bb.y - (s.y - 14)) < 3 && s.x >= bb.x && s.x <= bb.x + bb.w);
    const w = Math.max(46, s.text.length * 11), h = 13;
    const zBase = host ? buildingHeight(host) * 0.72 : 26;
    const zz = host ? host.y + host.h + 0.7 : s.y + 20;
    const x0 = s.x - w / 2, x1 = s.x + w / 2;
    signs.quad(
      [x0, zBase, zz], [x1, zBase, zz], [x1, zBase + h, zz], [x0, zBase + h, zz],
      [[cell.u0, cell.v1], [cell.u1, cell.v1], [cell.u1, cell.v0], [cell.u0, cell.v0]]);
  }

  return { geo, signs, atlasCanvas: atlas.canvas };
}

// ---------------------------------------------------------------------------
// Dynamic drawing: cars, people, particles, tire marks, mission beacon.
// Rebuilt into a fresh Geo each frame (two batches: opaque + translucent).
// ---------------------------------------------------------------------------
function drawCar3D(geo, alpha, game, car, L, isPlayerCar) {
  const b = yawBasis(car.angle);
  const cx = car.x, cz = car.y;
  const hl = car.len / 2, hw = car.wid / 2;
  // Local (forward, up, lateral) offset → world centre for geo.box.
  const centre = (lx, ly, lz) => [
    cx + b.u[0] * lx + b.w[0] * lz,
    ly,
    cz + b.u[2] * lx + b.w[2] * lz,
  ];

  if (car.dead) {
    const dark = [0.13, 0.13, 0.15];
    geo.box(centre(0, 4.4, 0), b.u, b.v, b.w, hl, 4.4, hw,
      [dark, dark, dark, dark, shadeC(dark, 0.4), [0.05, 0.05, 0.06]]);
    geo.box(centre(-hl * 0.1, 9.4, 0), b.u, b.v, b.w, car.len * 0.21, 1.8, hw - 3.5,
      [[0.09, 0.09, 0.1], [0.09, 0.09, 0.1], [0.09, 0.09, 0.1], [0.09, 0.09, 0.1], [0.11, 0.11, 0.12], [0.05, 0.05, 0.06]]);
    return;
  }

  const body = parseColor(car.color);
  const bodyCols = car.police
    ? [[0.96, 0.97, 0.98], [0.9, 0.91, 0.93], [0.96, 0.97, 0.98], [0.9, 0.91, 0.93], [1, 1, 1], [0.6, 0.62, 0.65]]
    : [shadeC(body, -0.05), shadeC(body, -0.18), shadeC(body, 0.03), shadeC(body, -0.12), shadeC(body, 0.16), shadeC(body, -0.3)];
  const low = car.type === 'sports';
  const bodyH = low ? 3.6 : 4.6, bodyY = low ? 6.4 : 7.2;
  geo.box(centre(0, bodyY, 0), b.u, b.v, b.w, hl, bodyH, hw, bodyCols);

  const glass = [0.11, 0.15, 0.2];
  const glassCols = [glass, shadeC(glass, -0.2), shadeC(glass, 0.25), shadeC(glass, -0.1), [0.35, 0.5, 0.6], [0.05, 0.07, 0.09]];
  if (car.type === 'truck') {
    const cargo = shadeC(body, -0.25);
    geo.box(centre(-hl * 0.24, 10.5, 0), b.u, b.v, b.w, hl * 0.52, 6.4, hw - 1.5,
      [cargo, shadeC(cargo, -0.15), cargo, shadeC(cargo, -0.15), shadeC(cargo, 0.12), shadeC(cargo, -0.3)]);
    geo.box(centre(hl * 0.72, 9.2, 0), b.u, b.v, b.w, hl * 0.24, 5, hw - 2, glassCols);
  } else if (car.type === 'van') {
    geo.box(centre(-hl * 0.08, 11, 0), b.u, b.v, b.w, hl * 0.78, 5.4, hw - 1,
      [shadeC(body, -0.02), shadeC(body, -0.14), shadeC(body, 0.02), shadeC(body, -0.1), shadeC(body, 0.12), shadeC(body, -0.28)]);
    geo.box(centre(hl * 0.86, 9.6, 0), b.u, b.v, b.w, hl * 0.1, 3.6, hw - 2.5, glassCols);
  } else {
    geo.box(centre(hl * 0.05, bodyY + bodyH + 2.6, 0), b.u, b.v, b.w, car.len * 0.21, 2.8, hw - 3.2, glassCols);
  }

  // Wheels: squat cylinders on the lateral axis.
  const wheelC = [0.08, 0.09, 0.1];
  for (const [lx, lz] of [[hl - 9, -hw + 0.5], [hl - 9, hw - 0.5], [-hl + 6, -hw + 0.5], [-hl + 6, hw - 0.5]]) {
    geo.cylinder(centre(lx, 3.6, lz), b.w, 3.7, 3.2, 9, wheelC);
  }

  if (car.type === 'taxi') {
    const sign = [0.95, 0.95, 0.92];
    geo.box(centre(hl * 0.05, bodyY + bodyH + 6.2, 0), b.u, b.v, b.w, 5, 1.6, 3.4,
      [sign, sign, sign, sign, sign, sign], [0.9, 0.85, 0.6], 1);
  }
  if (car.police) {
    // Lightbar: red/blue halves, flashing in step with the 2D renderer.
    const flash = Math.sin(game.time * 11) > 0;
    const red = [1, 0.12, 0.2], blue = [0.15, 0.4, 1];
    geo.box(centre(hl * 0.05, bodyY + bodyH + 6.4, -4), b.u, b.v, b.w, 3.4, 1.5, 3.6,
      [red, red, red, red, red, red], flash ? red : shadeC(red, -0.55), 2);
    geo.box(centre(hl * 0.05, bodyY + bodyH + 6.4, 4), b.u, b.v, b.w, 3.4, 1.5, 3.6,
      [blue, blue, blue, blue, blue, blue], flash ? shadeC(blue, -0.55) : blue, 2);
    // Navy door band
    const navy = [0.11, 0.15, 0.23];
    geo.box(centre(0, 7, -hw - 0.3), b.u, b.v, b.w, hl - 7, 2.6, 0.35, [navy, navy, navy, navy, navy, navy]);
    geo.box(centre(0, 7, hw + 0.3), b.u, b.v, b.w, hl - 7, 2.6, 0.35, [navy, navy, navy, navy, navy, navy]);
  }

  // Headlights + taillights (small emissive boxes; cones join the alpha pass).
  const lampW = [1, 0.95, 0.75];
  geo.box(centre(hl + 0.3, 7.4, -hw + 3.4), b.u, b.v, b.w, 0.5, 1.3, 2.2, [lampW, lampW, lampW, lampW, lampW, lampW], lampW, 1);
  geo.box(centre(hl + 0.3, 7.4, hw - 3.4), b.u, b.v, b.w, 0.5, 1.3, 2.2, [lampW, lampW, lampW, lampW, lampW, lampW], lampW, 1);
  const tail = car.braking ? [1, 0.15, 0.2] : [0.55, 0.1, 0.13];
  geo.box(centre(-hl - 0.3, 7.4, -hw + 3.4), b.u, b.v, b.w, 0.5, 1.3, 2.2, [tail, tail, tail, tail, tail, tail], tail, car.braking ? 2 : 1);
  geo.box(centre(-hl - 0.3, 7.4, hw - 3.4), b.u, b.v, b.w, 0.5, 1.3, 2.2, [tail, tail, tail, tail, tail, tail], tail, car.braking ? 2 : 1);
  // (No fake light-cone geometry: flat translucent triangles read as
  // solid wedges from a chase camera. The emissive headlight boxes above
  // carry the night look on their own.)
  void L;

  if (car.missionTarget || isPlayerCar) {
    // Ground ring: four thin gold bars, pulsing like the 2D outline.
    const ring = [1, 0.82, 0.4];
    const rr2 = hl + 5 + Math.sin(game.time * 5) * 1.2;
    geo.box(centre(0, 0.8, -(hw + 5)), b.u, b.v, b.w, rr2, 0.8, 1.1, [ring, ring, ring, ring, ring, ring], ring, 2);
    geo.box(centre(0, 0.8, (hw + 5)), b.u, b.v, b.w, rr2, 0.8, 1.1, [ring, ring, ring, ring, ring, ring], ring, 2);
    geo.box(centre(-rr2, 0.8, 0), b.u, b.v, b.w, 1.1, 0.8, hw + 5, [ring, ring, ring, ring, ring, ring], ring, 2);
    geo.box(centre(rr2, 0.8, 0), b.u, b.v, b.w, 1.1, 0.8, hw + 5, [ring, ring, ring, ring, ring, ring], ring, 2);
  }

  if (car.burning > 0) {
    // Engine fire: a flickering emissive flame block over the hood.
    const fl = 0.75 + 0.25 * Math.sin(game.time * 31 + car.id * 7);
    const flame = [1, 0.45, 0.08];
    geo.box(centre(hl * 0.3, bodyY + bodyH + 3.4 * fl, 0), b.u, b.v, b.w, hl * 0.4, 3.4 * fl, hw * 0.5,
      [flame, flame, flame, flame, [1, 0.65, 0.15], flame], flame, 2);
  }
}

function drawPed3D(geo, game, ped, opts = {}) {
  const shirt = parseColor(opts.shirt || ped.shirt);
  const skin = [0.91, 0.69, 0.54];
  const pants = [0.18, 0.19, 0.26];
  const cx = ped.x, cz = ped.y;

  if (ped.dead) {
    // Lying figure: flat torso slab + head, blood pool disc beneath.
    geo.prism(cx, 0.3, cz, 12, 0.5, 12, [0.45, 0.08, 0.08], [0.5, 0.1, 0.1]);
    const b = yawBasis(ped.angle);
    const centre = (lx, ly, lz) => [cx + b.u[0] * lx + b.w[0] * lz, ly, cz + b.u[2] * lx + b.w[2] * lz];
    geo.box(centre(0, 2.6, 0), b.u, b.v, b.w, 5, 2.4, 9, [shirt, shadeC(shirt, -0.15), shirt, shadeC(shirt, -0.15), shadeC(shirt, 0.1), shadeC(shirt, -0.3)]);
    geo.box(centre(-11, 2.4, 0), b.u, b.v, b.w, 4, 2.2, 4, [skin, skin, skin, skin, skin, skin]);
    return;
  }

  const b = yawBasis(ped.angle);
  const centre = (lx, ly, lz) => [cx + b.u[0] * lx + b.w[0] * lz, ly, cz + b.u[2] * lx + b.w[2] * lz];
  const moving = (ped.speed || 0) > 4 || opts.moving;
  const swing = moving ? Math.sin(ped.walkPhase || 0) * 0.55 : 0;
  const bob = moving ? Math.abs(Math.sin(ped.walkPhase || 0)) * 1.1 : Math.sin(game.time * 2 + (ped.id || 0)) * 0.3;
  const torsoTint = ped.hurtT > 0 ? mixC(shirt, [1, 0.2, 0.2], 0.45) : shirt;

  // Legs (swing around the hip) + arms (counter-swing).
  for (const side of [-1, 1]) {
    const p = side * swing;
    const pb = pitchedBasis(b, p);
    const hip = centre(0, 11.5 + bob * 0.4, side * 2.9);
    // The leg box hangs from the hip along the pitched basis's -v axis.
    const legC = [hip[0] - pb.v[0] * 5, hip[1] - pb.v[1] * 5, hip[2] - pb.v[2] * 5];
    geo.box(legC, pb.u, pb.v, pb.w, 1.7, 5, 1.8, [pants, pants, pants, pants, pants, pants]);

    const pa = pitchedBasis(b, -p * 0.8);
    const sh = centre(0, 20.5 + bob, side * 7.1);
    const armC = [sh[0] - pa.v[0] * 4.4, sh[1] - pa.v[1] * 4.4, sh[2] - pa.v[2] * 4.4];
    geo.box(armC, pa.u, pa.v, pa.w, 1.5, 4.6, 1.5,
      [torsoTint, shadeC(torsoTint, -0.12), torsoTint, shadeC(torsoTint, -0.12), shadeC(torsoTint, 0.08), shadeC(torsoTint, -0.25)]);
  }
  // Torso + head.
  geo.box(centre(0, 16.8 + bob, 0), b.u, b.v, b.w, 4.6, 5.6, 6.2,
    [torsoTint, shadeC(torsoTint, -0.14), shadeC(torsoTint, 0.05), shadeC(torsoTint, -0.1), shadeC(torsoTint, 0.14), shadeC(torsoTint, -0.3)]);
  geo.box(centre(0, 26.2 + bob, 0), b.u, b.v, b.w, 4.1, 4.1, 4.1,
    [skin, skin, skin, skin, shadeC(skin, 0.08), shadeC(skin, -0.2)]);
  if (opts.bandana) {
    const bc = parseColor(opts.bandana);
    geo.box(centre(0, 29.4 + bob, 0), b.u, b.v, b.w, 4.5, 1.5, 4.5, [bc, bc, bc, bc, shadeC(bc, 0.15), shadeC(bc, -0.2)]);
  } else {
    const hair = [0.16, 0.12, 0.1];
    geo.box(centre(-0.4, 29.6 + bob, 0), b.u, b.v, b.w, 4.3, 1.3, 4.3, [hair, hair, hair, hair, hair, hair]);
  }

  // Gang health bar (mirrors the 2D one) once damaged.
  if (ped.state === 'gang' && ped.health < 100) {
    const frac = clamp(ped.health / 100, 0, 1);
    const bg = [0.05, 0.05, 0.07], fg = [0.72, 0.55, 1];
    geo.box(centre(0, 35 + bob, 0), b.u, b.v, b.w, 1, 1.1, 13, [bg, bg, bg, bg, bg, bg]);
    geo.box(centre(0, 35 + bob, -(1 - frac) * 12), b.u, b.v, b.w, 1.2, 1.3, Math.max(0.5, 12 * frac), [fg, fg, fg, fg, fg, fg], fg, 2);
  }
}

function drawDynamicWorld(geo, alpha, alphaSoft, game, L) {
  // Tire marks first (flat on the ground).
  const marks = game.particles.marks;
  const markC = [0.11, 0.11, 0.12];
  const start = Math.max(0, marks.length - 260);
  for (let i = start; i < marks.length; i++) {
    const m = marks[i];
    const b = yawBasis(m.angle);
    geo.box([m.x, 0.35, m.y], b.u, b.v, b.w, 7, 0.35, 2, [markC, markC, markC, markC, markC, markC]);
  }

  for (const c of game.cars) drawCar3D(geo, alpha, game, c, L, false);
  for (const c of game.police) drawCar3D(geo, alpha, game, c, L, false);
  if (game.player.car) drawCar3D(geo, alpha, game, game.player.car, L, true);

  for (const p of game.peds) drawPed3D(geo, game, p, { bandana: p.state === 'gang' ? '#7b2ff7' : null });

  // The player on foot (gold shirt, like the 2D figure).
  const pl = game.player;
  if (!pl.car) {
    const blink = pl.invuln > 0 && Math.floor(game.time * 14) % 2 === 0 && game.state === 'playing';
    if (!blink) {
      drawPed3D(geo, game, {
        x: pl.x, y: pl.y, angle: pl.angle, walkPhase: pl.walkPhase,
        speed: pl.moving ? 120 : 0, shirt: '#ffd166', id: 999, hurtT: 0, state: 'player',
      }, {});
      if (game.hasPistol && game.state === 'playing') {
        const b = yawBasis(pl.angle);
        const gx = pl.x + b.u[0] * 13, gz = pl.y + b.u[2] * 13;
        const gun = [0.13, 0.14, 0.17];
        const gunLen = game.weapons && game.weapons.current === 'shotgun' ? 10 : game.weapons && game.weapons.current === 'smg' ? 8 : 5.5;
        geo.box([gx, 17.5, gz], b.u, b.v, b.w, gunLen, 1.6, 1.6, [gun, gun, gun, gun, gun, gun]);
        if (pl.muzzle > 0) {
          const fx = pl.x + b.u[0] * 24, fz = pl.y + b.u[2] * 24;
          const fl = [1, 0.85, 0.4];
          geo.box([fx, 17.5, fz], b.u, b.v, b.w, 4, 3, 3, [fl, fl, fl, fl, fl, fl], fl, 2);
        }
        // Crosshair: a small red ring of boxes on the ground at the aim point.
        const mw = game.mouseWorld;
        if (mw) {
          const rc = [1, 0.25, 0.25];
          for (const [dx, dz] of [[0, -8], [0, 8], [-8, 0], [8, 0]]) {
            geo.boxAA(mw.x + dx - 1.4, 0.6, mw.y + dz - 1.4, mw.x + dx + 1.4, 1.6, mw.y + dz + 1.4,
              [rc, rc, rc, rc, rc, rc], rc, 2);
          }
        }
      }
    }
  }

  // Roadblock barriers: striped bar across the road + traffic cones.
  // (The two cruisers are ordinary cars in game.cars, drawn above.)
  for (const rb of game.roadblocks || []) {
    const b = yawBasis(rb.vertical ? 0 : Math.PI / 2);
    const centre = (lx, ly, lz) => [rb.x + b.u[0] * lx + b.w[0] * lz, ly, rb.y + b.u[2] * lx + b.w[2] * lz];
    const white = [0.92, 0.92, 0.9], orange = [1, 0.45, 0.1];
    for (let i = 0; i < 6; i++) {
      const c = i % 2 === 0 ? orange : white;
      geo.box(centre(-50 + i * 20 + 10, 8, 0), b.u, b.v, b.w, 10, 4.5, 2.6, [c, c, c, c, c, c], i % 2 === 0 ? orange : null, i % 2 === 0 ? 1 : 0);
    }
    for (const s of [-44, 44]) {
      geo.box(centre(s, 2.5, 0), b.u, b.v, b.w, 2, 2.5, 2, [white, white, white, white, white, white]);
      geo.prism(rb.x + b.u[0] * s * 1.6, 0, rb.y + b.u[2] * s * 1.6, 4.4, 9, 7, orange, shadeC(orange, 0.2));
    }
  }

  // Weapon / ammo pickups: a slowly spinning gun-crate over a glow disc.
  for (const pk of game.pickups || []) {
    if (pk.taken) continue;
    const bob = Math.sin(game.time * 3 + pk.x * 0.05) * 2;
    const col = pk.kind === 'smg' ? [0.1, 0.85, 0.9] : pk.kind === 'shotgun' ? [1, 0.5, 0.1] : [0.4, 1, 0.45];
    const b = yawBasis(game.time * 1.6 + pk.x);
    const size = pk.kind === 'ammo' ? 5 : 8;
    geo.box([pk.x, 13 + bob, pk.y], b.u, b.v, b.w, size, 2.6, size * 0.45,
      [col, shadeC(col, -0.2), col, shadeC(col, -0.2), shadeC(col, 0.2), shadeC(col, -0.3)], col, 2);
    alpha.prism(pk.x, 0.5, pk.y, 17, 1.1, 14, col, col);
  }

  // AIR-1: airframe at altitude, spinning rotor, and the searchlight —
  // a translucent cone from the belly to a bright disc on the ground.
  const heli = game.heli;
  if (heli && heli.active) {
    const ALT = 122;
    const b = yawBasis(heli.angle);
    const centre = (lx, ly, lz) => [heli.x + b.u[0] * lx + b.w[0] * lz, ly, heli.y + b.u[2] * lx + b.w[2] * lz];
    const shell = [0.16, 0.2, 0.28], shellD = shadeC(shell, -0.25), white = [0.92, 0.94, 0.96];
    geo.box(centre(0, ALT, 0), b.u, b.v, b.w, 17, 7.5, 8.5, [white, shellD, shell, shellD, white, shellD]);
    geo.box(centre(-26, ALT + 1.5, 0), b.u, b.v, b.w, 11, 2.4, 2.4, [shell, shellD, shell, shellD, shell, shellD]);
    geo.box(centre(-37, ALT + 5, 0), b.u, b.v, b.w, 1.6, 4.5, 4.5, [shell, shell, shell, shell, shell, shell]);
    for (const s of [-7, 7]) {
      geo.box(centre(0, ALT - 10, s), b.u, b.v, b.w, 15, 1.1, 1.6, [shellD, shellD, shellD, shellD, shellD, shellD]);
      geo.box(centre(4, ALT - 5, s), b.u, b.v, b.w, 1.4, 5, 1.4, [shellD, shellD, shellD, shellD, shellD, shellD]);
      geo.box(centre(-6, ALT - 5, s), b.u, b.v, b.w, 1.4, 5, 1.4, [shellD, shellD, shellD, shellD, shellD, shellD]);
    }
    const rb2 = yawBasis(heli.rotor);
    geo.box([heli.x, ALT + 9.5, heli.y], rb2.u, rb2.v, rb2.w, 36, 0.7, 3.2, [shellD, shellD, shellD, shellD, shellD, shellD]);
    geo.box([heli.x, ALT + 9.5, heli.y], rb2.w, rb2.v, rb2.u, 36, 0.7, 3.2, [shellD, shellD, shellD, shellD, shellD, shellD]);
    const lampC = [1, 0.2, 0.2];
    geo.box(centre(10, ALT - 6, 0), b.u, b.v, b.w, 2.4, 2, 2.4, [lampC, lampC, lampC, lampC, lampC, lampC], lampC, 2);
    // Searchlight cone + ground disc (translucent passes). The cone goes
    // into the soft batch, drawn at ~0.11 alpha with NO emissive boost:
    // at the shared 0.20 pass with mode-2 emissive it stacked front+back
    // faces into a blown-out white wedge that buried the scene (and the
    // airframe) behind it. The ground disc stays in the main alpha pass
    // with a slightly dimmed tint so the pool of light still reads.
    const light = [1, 0.96, 0.78];
    alphaSoft.frustum(heli.lightX, heli.lightY, 1.5, 92, ALT - 8, 13, 14, light, null, 0);
    alpha.prism(heli.lightX, 0.6, heli.lightY, 92, 1.1, 20, [0.88, 0.85, 0.68], [0.88, 0.85, 0.68]);
    // Soft blob shadow under the airframe.
    alpha.prism(heli.x, 0.4, heli.y, 24, 0.8, 12, [0.05, 0.05, 0.06], [0.05, 0.05, 0.06]);
  }

  // Particles as small floating cubes (text popups stay on the HUD/money).
  const list = game.particles.list;
  const n = Math.min(list.length, 240);
  for (let i = 0; i < n; i++) {
    const pt = list[i];
    if (pt.text) continue;
    const c = parseColor(pt.color);
    const s = Math.max(0.8, pt.size * 0.55);
    geo.boxAA(pt.x - s, 8 - s, pt.y - s, pt.x + s, 8 + s, pt.y + s, [c, c, c, c, c, c]);
  }

  // Mission beacon: translucent ground disc + sky beam at the marker.
  const mk = game.missions && game.missions.marker ? game.missions.marker() : null;
  if (mk && (game.state === 'playing' || game.state === 'dialog')) {
    const gold = [1, 0.82, 0.4];
    const pulse = 1 + Math.sin(game.time * 4) * 0.1;
    alpha.prism(mk.x, 0.5, mk.y, mk.r * 0.45 * pulse, 1.2, 20, gold, gold);
    alpha.boxAA(mk.x - 7, 0, mk.y - 7, mk.x + 7, 300, mk.y + 7,
      [gold, gold, gold, gold, gold, gold], gold, 2);
  }
}

// ---------------------------------------------------------------------------
// Shaders (WebGL 1 / GLSL ES 1.0).
// ---------------------------------------------------------------------------
const LIT_VS = `
attribute vec3 aPos; attribute vec3 aNorm; attribute vec3 aCol;
attribute vec3 aEmi; attribute float aMode;
uniform mat4 uMVP; uniform mat4 uView;
varying vec3 vCol; varying vec3 vNorm; varying vec3 vEmi;
varying float vMode; varying float vDist;
void main() {
  vec4 wp = vec4(aPos, 1.0);
  vCol = aCol; vNorm = aNorm; vEmi = aEmi; vMode = aMode;
  vDist = -(uView * wp).z;
  gl_Position = uMVP * wp;
}`;
const LIT_FS = `
precision mediump float;
uniform vec3 uSunDir; uniform vec3 uFillDir; uniform float uAmbient; uniform float uNight;
uniform vec3 uFogColor; uniform vec2 uFog; uniform float uAlpha;
uniform float uDusk; uniform float uEmiScale;
varying vec3 vCol; varying vec3 vNorm; varying vec3 vEmi;
varying float vMode; varying float vDist;
void main() {
  vec3 n = normalize(vNorm);
  float dif = max(dot(n, uSunDir), 0.0);
  float fill = max(dot(n, uFillDir), 0.0) * 0.28;
  vec3 col = vCol * (uAmbient + (dif + fill) * (1.0 - uAmbient));
  float es = vMode > 1.5 ? 1.0 : (vMode > 0.5 ? uNight : 0.0);
  col += vEmi * es * uEmiScale;
  col *= mix(vec3(1.0), vec3(1.10, 0.90, 0.80), uDusk * 0.55);
  float f = smoothstep(uFog.x, uFog.y, vDist);
  col = mix(col, uFogColor, f);
  gl_FragColor = vec4(col, uAlpha);
}`;
const TEX_VS = `
attribute vec3 aPos; attribute vec2 aUV;
uniform mat4 uMVP; uniform mat4 uView; uniform vec2 uUVOff;
varying vec2 vUV; varying float vDist;
void main() {
  vUV = aUV + uUVOff;
  vec4 wp = vec4(aPos, 1.0);
  vDist = -(uView * wp).z;
  gl_Position = uMVP * wp;
}`;
const TEX_FS = `
precision mediump float;
uniform sampler2D uTex; uniform float uShade; uniform float uEmissive;
uniform vec3 uFogColor; uniform vec2 uFog; uniform float uAlpha;
varying vec2 vUV; varying float vDist;
void main() {
  vec4 t = texture2D(uTex, vUV);
  vec3 col = t.rgb * mix(uShade, 1.0, uEmissive);
  float f = smoothstep(uFog.x, uFog.y, vDist);
  col = mix(col, uFogColor, f);
  gl_FragColor = vec4(col, t.a * uAlpha);
}`;
const SKY_VS = `
attribute vec2 aClip;
varying vec2 vNDC;
void main() { vNDC = aClip; gl_Position = vec4(aClip, 0.999, 1.0); }`;
const SKY_FS = `
precision mediump float;
uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uSunDir;
uniform vec3 uFwd; uniform vec3 uRight; uniform vec3 uUp;
uniform vec2 uTan; uniform vec3 uSunCol;
varying vec2 vNDC;
void main() {
  vec3 dir = normalize(uFwd + uRight * (vNDC.x * uTan.x) + uUp * (vNDC.y * uTan.y));
  float h = clamp(dir.y, -0.08, 1.0);
  vec3 col = mix(uHorizon, uTop, pow(smoothstep(-0.02, 0.65, h), 0.8));
  float s = max(dot(dir, uSunDir), 0.0);
  col += uSunCol * (pow(s, 220.0) * 1.4 + pow(s, 10.0) * 0.30);
  gl_FragColor = vec4(col, 1.0);
}`;

function compileProgram(gl, vsSrc, fsSrc) {
  const mk = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error('[render3d] shader:', gl.getShaderInfoLog(sh));
      return null;
    }
    return sh;
  };
  const vs = mk(gl.VERTEX_SHADER, vsSrc), fs = mk(gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('[render3d] link:', gl.getProgramInfoLog(prog));
    return null;
  }
  return prog;
}
function uniformMap(gl, prog, names) {
  const out = {};
  for (const n of names) out[n] = gl.getUniformLocation(prog, n);
  return out;
}

// ---------------------------------------------------------------------------
// Renderer3D — owns the WebGL canvas, the chase camera, and all GPU state.
// ---------------------------------------------------------------------------
export class Renderer3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.ok = false;
    const gl = canvas.getContext('webgl', { antialias: true, alpha: false })
      || canvas.getContext('experimental-webgl');
    if (!gl) { console.warn('[render3d] WebGL unavailable — flat fallback'); return; }
    this.gl = gl;
    // Uint32 indices (the merged city exceeds 65k verts) need this WebGL 1
    // extension enabled before any drawElements call, or every indexed
    // draw fails with INVALID_ENUM.
    if (!gl.getExtension('OES_element_index_uint')) {
      console.warn('[render3d] OES_element_index_uint unavailable — flat fallback');
      return;
    }
    const pr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(VIEW_W * pr);
    canvas.height = Math.round(VIEW_H * pr);
    gl.viewport(0, 0, canvas.width, canvas.height);

    this.litProg = compileProgram(gl, LIT_VS, LIT_FS);
    this.texProg = compileProgram(gl, TEX_VS, TEX_FS);
    this.skyProg = compileProgram(gl, SKY_VS, SKY_FS);
    if (!this.litProg || !this.texProg || !this.skyProg) return;
    this.litU = uniformMap(gl, this.litProg, ['uMVP', 'uView', 'uSunDir', 'uFillDir', 'uAmbient', 'uNight', 'uFogColor', 'uFog', 'uAlpha', 'uDusk', 'uEmiScale']);
    this.texU = uniformMap(gl, this.texProg, ['uMVP', 'uView', 'uUVOff', 'uTex', 'uShade', 'uEmissive', 'uFogColor', 'uFog', 'uAlpha']);
    this.skyU = uniformMap(gl, this.skyProg, ['uTop', 'uHorizon', 'uSunDir', 'uFwd', 'uRight', 'uUp', 'uTan', 'uSunCol']);
    this.litAtt = {
      pos: gl.getAttribLocation(this.litProg, 'aPos'),
      norm: gl.getAttribLocation(this.litProg, 'aNorm'),
      col: gl.getAttribLocation(this.litProg, 'aCol'),
      emi: gl.getAttribLocation(this.litProg, 'aEmi'),
      mode: gl.getAttribLocation(this.litProg, 'aMode'),
    };
    this.texAtt = {
      pos: gl.getAttribLocation(this.texProg, 'aPos'),
      uv: gl.getAttribLocation(this.texProg, 'aUV'),
    };
    this.skyAtt = { clip: gl.getAttribLocation(this.skyProg, 'aClip') };

    // Fullscreen triangle for the sky.
    this.skyBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.skyBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    this.staticBuf = null; this.staticIdx = null; this.staticCount = 0;
    this.signBuf = null; this.signIdx = null; this.signCount = 0; this.signTex = null;
    this.dynBuf = gl.createBuffer(); this.dynIdx = gl.createBuffer();
    this.alphaBuf = gl.createBuffer(); this.alphaIdx = gl.createBuffer();
    this.groundBuf = null; this.groundIdx = null; this.groundCount = 0; this.groundTex = null;
    this.sparkBuf = null; this.sparkIdx = null; this.sparkCount = 0; this.sparkTex = null;
    this._staticWorld = null;

    // Camera state (world-space eye + look target, plus chase yaw).
    this.yaw = -Math.PI / 2;
    this.eye = [838, 90, 1100];
    this.look = [838, 16, 985];
    this.fovY = 1.05;
    this._snap = true;
    this._basis = null; // {fwd, right, up, tanX, tanY} for unprojection
    this.ok = true;
  }

  snapCamera() { this._snap = true; }

  _makeTexture(canvasImg, repeat = false) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvasImg);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    return tex;
  }

  _uploadLit(buf, idx, geo) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(geo.v), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(geo.i), gl.DYNAMIC_DRAW);
    return geo.i.length;
  }
  _uploadTex(buf, idx, tg) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(tg.v), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(tg.i), gl.STATIC_DRAW);
    return tg.i.length;
  }

  _buildStatic(game) {
    const gl = this.gl;
    const world = game.world;
    const { geo, signs, atlasCanvas } = buildStaticWorld(world);
    this.staticBuf = gl.createBuffer(); this.staticIdx = gl.createBuffer();
    this.staticCount = this._uploadLit(this.staticBuf, this.staticIdx, geo);
    this.signBuf = gl.createBuffer(); this.signIdx = gl.createBuffer();
    this.signCount = this._uploadTex(this.signBuf, this.signIdx, signs);
    this.signTex = this._makeTexture(atlasCanvas);

    // Ground plane (one big quad, uv across the whole map).
    const ground = new TexGeo();
    ground.quad([0, 0, 0], [WORLD.w, 0, 0], [WORLD.w, 0, WORLD.h], [0, 0, WORLD.h],
      [[0, 0], [1, 0], [1, 1], [0, 1]]);
    this.groundBuf = gl.createBuffer(); this.groundIdx = gl.createBuffer();
    this.groundCount = this._uploadTex(this.groundBuf, this.groundIdx, ground);
    this.groundTex = this._makeTexture(paintGroundTexture(world));

    // Water sparkle plane over the bay.
    const spark = new TexGeo();
    const reps = 26;
    spark.quad([0, 0.7, WORLD.waterY], [WORLD.w, 0.7, WORLD.waterY], [WORLD.w, 0.7, WORLD.h], [0, 0.7, WORLD.h],
      [[0, 0], [reps, 0], [reps, reps * 0.12], [0, reps * 0.12]]);
    this.sparkBuf = gl.createBuffer(); this.sparkIdx = gl.createBuffer();
    this.sparkCount = this._uploadTex(this.sparkBuf, this.sparkIdx, spark);
    this.sparkTex = this._makeTexture(paintSparkleTexture(), true);
    this._staticWorld = world;
  }

  // ---- Camera ---------------------------------------------------------------
  _updateCamera(game, dt) {
    const frozen = ['paused', 'busted', 'wasted'].includes(game.state);
    if (game.state === 'title') {
      // Slow orbit over mid-city for the title vista.
      const a = game.time * 0.055;
      const cx = 1620, cz = 1330, r = 940;
      this.eye = [cx + Math.cos(a) * r, 430, cz + Math.sin(a) * r];
      this.look = [cx, 30, cz];
      this.fovY = lerp(this.fovY, 0.98, 0.05);
      return;
    }
    if (frozen && !this._snap) return;
    const p = game.player;
    const target = p.car || p;
    const driving = !!p.car;
    let desiredYaw = this.yaw;
    if (driving) desiredYaw = target.angle;
    else if (p.moving || game.hasPistol) desiredYaw = p.angle;
    const snap = this._snap;
    const kYaw = snap ? 1 : 1 - Math.exp(-dt * (driving ? 5.2 : 3.4));
    this.yaw = lerpAngle(this.yaw, desiredYaw, kYaw);

    const speedRatio = driving ? Math.abs(target.speed) / 360 : 0;
    const dist = driving ? 148 + speedRatio * 60 : 118;
    const height = driving ? 76 + speedRatio * 14 : 68;
    const fx = Math.cos(this.yaw), fz = Math.sin(this.yaw);
    const ex = target.x - fx * dist, ez = target.y - fz * dist;
    const ey = height;
    const kPos = snap ? 1 : 1 - Math.exp(-dt * 7.5);
    this.eye = [
      lerp(this.eye[0], ex, kPos) + (game.cam.shakeX || 0),
      lerp(this.eye[1], ey, kPos),
      lerp(this.eye[2], ez, kPos) + (game.cam.shakeY || 0),
    ];
    // Building avoidance: if the eye would sit inside a footprint, lift
    // it above that roof instead of clipping into the wall.
    for (const b of game.world.buildings) {
      if (this.eye[0] > b.x - 4 && this.eye[0] < b.x + b.w + 4 && this.eye[2] > b.y - 4 && this.eye[2] < b.y + b.h + 4) {
        this.eye[1] = Math.max(this.eye[1], buildingHeight(b) + 26);
      }
    }
    const lookT = [target.x + fx * 38, 17, target.y + fz * 38];
    this.look = snap ? lookT : [
      lerp(this.look[0], lookT[0], 1 - Math.exp(-dt * 9)),
      lerp(this.look[1], lookT[1], 1 - Math.exp(-dt * 9)),
      lerp(this.look[2], lookT[2], 1 - Math.exp(-dt * 9)),
    ];
    const targetFov = 1.05 + (driving ? speedRatio * 0.17 : 0);
    this.fovY = lerp(this.fovY, targetFov, snap ? 1 : 1 - Math.exp(-dt * 3));
    this._snap = false;
  }

  // Mouse → ground point, from the last rendered camera basis. Used by
  // main.js for pistol aim in 3D mode (replaces mouse + top-down cam).
  screenToGround(sx, sy) {
    if (!this._basis) return null;
    const { eye, fwd, right, up, tanX, tanY } = this._basis;
    const ndcX = (sx / VIEW_W) * 2 - 1;
    const ndcY = 1 - (sy / VIEW_H) * 2;
    let dx = fwd[0] + right[0] * ndcX * tanX + up[0] * ndcY * tanY;
    let dy = fwd[1] + right[1] * ndcX * tanX + up[1] * ndcY * tanY;
    let dz = fwd[2] + right[2] * ndcX * tanX + up[2] * ndcY * tanY;
    const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
    if (dy > -0.02) return null; // ray runs level or up: no ground hit
    const t = (10 - eye[1]) / dy;
    if (t < 0 || t > 4000) return null;
    return { x: eye[0] + dx * t, y: eye[2] + dz * t };
  }

  // ---- Frame ------------------------------------------------------------------
  draw(game) {
    if (!this.ok) return;
    const gl = this.gl;
    const dt = clamp(game._dt || 0.016, 0.001, 0.05);
    if (this._staticWorld !== game.world) this._buildStatic(game);
    const L = lighting(game);
    this._updateCamera(game, dt);

    const view = matLookAt(this.eye, this.look, [0, 1, 0]);
    const proj = matPerspective(this.fovY, VIEW_W / VIEW_H, 2, 4200);
    const mvp = matMultiply(proj, view);

    // Camera basis for the sky shader + mouse unprojection:
    // right = normalize(fwd × worldUp), up = right × fwd.
    let fwd = [this.look[0] - this.eye[0], this.look[1] - this.eye[1], this.look[2] - this.eye[2]];
    const fl = Math.hypot(...fwd) || 1; fwd = fwd.map((v) => v / fl);
    let right = [-fwd[2], 0, fwd[0]];
    const rl = Math.hypot(...right) || 1; right = right.map((v) => v / rl);
    const up = [
      right[1] * fwd[2] - right[2] * fwd[1],
      right[2] * fwd[0] - right[0] * fwd[2],
      right[0] * fwd[1] - right[1] * fwd[0],
    ];
    const tanY = Math.tan(this.fovY / 2), tanX = tanY * (VIEW_W / VIEW_H);
    this._basis = { eye: this.eye, fwd, right, up, tanX, tanY };

    // Lighting rig from the shared 2D lighting model.
    const hour = L.hour;
    const sunAng = ((hour - 6) / 12) * Math.PI;
    const sunDir = [Math.cos(sunAng), Math.max(0.06, Math.sin(sunAng)) * 0.95 + 0.10, 0.38];
    const sl = Math.hypot(...sunDir); const sun = sunDir.map((v) => v / sl);
    const ambient = 0.36 + 0.40 * L.day;
    const topCol = mixC(mixC([0.03, 0.05, 0.13], [0.30, 0.55, 0.85], L.day), [0.16, 0.08, 0.30], L.dusk * 0.65);
    const horCol = mixC(mixC([0.07, 0.10, 0.20], [0.78, 0.88, 0.94], L.day), [1.0, 0.52, 0.28], Math.max(L.dusk, L.dawn * 0.8) * 0.8);
    const fogCol = mixC(horCol, [0.45, 0.42, 0.38], 0.25);
    const fogNear = game.state === 'title' ? 700 : 620;
    const fogFar = game.state === 'title' ? 3400 : 2300;

    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clearColor(fogCol[0], fogCol[1], fogCol[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Sky
    gl.depthMask(false);
    gl.useProgram(this.skyProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.skyBuf);
    gl.enableVertexAttribArray(this.skyAtt.clip);
    gl.vertexAttribPointer(this.skyAtt.clip, 2, gl.FLOAT, false, 0, 0);
    gl.uniform3fv(this.skyU.uTop, topCol);
    gl.uniform3fv(this.skyU.uHorizon, horCol);
    gl.uniform3fv(this.skyU.uSunDir, sun);
    gl.uniform3fv(this.skyU.uFwd, fwd);
    gl.uniform3fv(this.skyU.uRight, right);
    gl.uniform3fv(this.skyU.uUp, up);
    gl.uniform2f(this.skyU.uTan, tanX, tanY);
    gl.uniform3fv(this.skyU.uSunCol, mixC([0.25, 0.3, 0.45], [1.0, 0.75, 0.45], Math.max(L.day, L.dusk)));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);

    // Shared lit-program uniforms.
    const setLit = (alpha) => {
      gl.uniformMatrix4fv(this.litU.uMVP, false, mvp);
      gl.uniformMatrix4fv(this.litU.uView, false, view);
      gl.uniform3fv(this.litU.uSunDir, sun);
      gl.uniform3fv(this.litU.uFillDir, [-sun[0] * 0.8, 0.35, -sun[2] * 0.8]);
      gl.uniform1f(this.litU.uAmbient, ambient);
      gl.uniform1f(this.litU.uNight, L.night);
      gl.uniform3fv(this.litU.uFogColor, fogCol);
      gl.uniform2f(this.litU.uFog, fogNear, fogFar);
      gl.uniform1f(this.litU.uAlpha, alpha);
      gl.uniform1f(this.litU.uDusk, L.dusk);
      gl.uniform1f(this.litU.uEmiScale, 1.15);
    };
    const bindLit = (buf, idx) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
      const S = STRIDE * 4;
      gl.enableVertexAttribArray(this.litAtt.pos);
      gl.vertexAttribPointer(this.litAtt.pos, 3, gl.FLOAT, false, S, 0);
      gl.enableVertexAttribArray(this.litAtt.norm);
      gl.vertexAttribPointer(this.litAtt.norm, 3, gl.FLOAT, false, S, 12);
      gl.enableVertexAttribArray(this.litAtt.col);
      gl.vertexAttribPointer(this.litAtt.col, 3, gl.FLOAT, false, S, 24);
      gl.enableVertexAttribArray(this.litAtt.emi);
      gl.vertexAttribPointer(this.litAtt.emi, 3, gl.FLOAT, false, S, 36);
      gl.enableVertexAttribArray(this.litAtt.mode);
      gl.vertexAttribPointer(this.litAtt.mode, 1, gl.FLOAT, false, S, 48);
    };
    const bindTex = (buf, idx) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
      gl.enableVertexAttribArray(this.texAtt.pos);
      gl.vertexAttribPointer(this.texAtt.pos, 3, gl.FLOAT, false, 20, 0);
      gl.enableVertexAttribArray(this.texAtt.uv);
      gl.vertexAttribPointer(this.texAtt.uv, 2, gl.FLOAT, false, 20, 12);
    };
    const setTex = (tex, shade, emissive, alpha, uvOff) => {
      gl.uniformMatrix4fv(this.texU.uMVP, false, mvp);
      gl.uniformMatrix4fv(this.texU.uView, false, view);
      gl.uniform2f(this.texU.uUVOff, uvOff ? uvOff[0] : 0, uvOff ? uvOff[1] : 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(this.texU.uTex, 0);
      gl.uniform1f(this.texU.uShade, shade);
      gl.uniform1f(this.texU.uEmissive, emissive);
      gl.uniform3fv(this.texU.uFogColor, fogCol);
      gl.uniform2f(this.texU.uFog, fogNear, fogFar);
      gl.uniform1f(this.texU.uAlpha, alpha);
    };
    const groundShade = clamp(ambient + 0.55 * (1.0 - ambient), 0, 1) * (0.55 + 0.45 * L.day + 0.25 * L.dusk);

    // Ground + water sparkle
    gl.useProgram(this.texProg);
    bindTex(this.groundBuf, this.groundIdx);
    setTex(this.groundTex, groundShade, 0, 1, null);
    gl.drawElements(gl.TRIANGLES, this.groundCount, gl.UNSIGNED_INT, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    bindTex(this.sparkBuf, this.sparkIdx);
    setTex(this.sparkTex, 1.0, 1, 0.5 + 0.3 * L.dusk, [game.time * 0.004, game.time * 0.0016]);
    gl.drawElements(gl.TRIANGLES, this.sparkCount, gl.UNSIGNED_INT, 0);
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    // Static city
    gl.useProgram(this.litProg);
    setLit(1);
    bindLit(this.staticBuf, this.staticIdx);
    gl.drawElements(gl.TRIANGLES, this.staticCount, gl.UNSIGNED_INT, 0);

    // Neon signs (textured, emissive, alpha-tested by texture alpha)
    gl.useProgram(this.texProg);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    bindTex(this.signBuf, this.signIdx);
    setTex(this.signTex, 1.0, 1, 0.35 + 0.65 * Math.max(L.night, 0.35), null);
    gl.drawElements(gl.TRIANGLES, this.signCount, gl.UNSIGNED_INT, 0);
    gl.disable(gl.BLEND);

    // Dynamic world
    const dyn = new Geo(); const alpha = new Geo(); const alphaSoft = new Geo();
    drawDynamicWorld(dyn, alpha, alphaSoft, game, L);
    gl.useProgram(this.litProg);
    setLit(1);
    const dynCount = this._uploadLit(this.dynBuf, this.dynIdx, dyn);
    bindLit(this.dynBuf, this.dynIdx);
    gl.drawElements(gl.TRIANGLES, dynCount, gl.UNSIGNED_INT, 0);

    // Translucent pass: beacon beam + headlight cones.
    if (alpha.i.length) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      setLit(0.20);
      const aCount = this._uploadLit(this.alphaBuf, this.alphaIdx, alpha);
      bindLit(this.alphaBuf, this.alphaIdx);
      gl.drawElements(gl.TRIANGLES, aCount, gl.UNSIGNED_INT, 0);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
    // Soft translucent pass: the AIR-1 searchlight cone only, at a low
    // alpha so the beam reads as a gentle volumetric shaft and whatever
    // stands inside it (cars, the airframe above) stays clearly visible.
    if (alphaSoft.i.length) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      setLit(0.11);
      const sCount = this._uploadLit(this.alphaBuf, this.alphaIdx, alphaSoft);
      bindLit(this.alphaBuf, this.alphaIdx);
      gl.drawElements(gl.TRIANGLES, sCount, gl.UNSIGNED_INT, 0);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
  }
}

export { districtAt };
