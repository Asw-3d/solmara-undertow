// ============================================================================
// SOLMARA UNDERTOW — entities.js
// Living city: traffic cars that drive the road network, parked cars,
// pedestrians, police pursuit units, and gang enemies. Also owns the shared
// particle pool and tire-mark trail used by the renderer for polish.
//
// Traffic model: each car follows a road centre-line in a lane offset. At an
// intersection it may turn onto a crossing road. Cars brake for anything
// ahead in their lane (cars, the player, crossing peds).
// Police model: free-steering pursuit — target a point behind the player,
// steer, avoid buildings by sliding along them; ram on contact. When the
// player is on foot, nearby police slow and the bust meter (in main) fills.
// ============================================================================

import { WORLD, ROADS_V, ROADS_H, ROAD_W, LANE, CAR_TYPES, TRAFFIC_COUNT, PED_COUNT, PLACES } from './config.js';
import { RNG } from './random.js';
import { collideCircle, carCollides, inWater } from './world.js';

let NEXT_ID = 1;

export function makeCar(rng, type, x, y, angle) {
  const spec = CAR_TYPES[type];
  return {
    id: NEXT_ID++, kind: 'car', type,
    x, y, angle, speed: 0,
    len: spec.len, wid: spec.wid,
    color: rng.pick(spec.colors),
    health: 100, driver: null, parked: false, police: false,
    // traffic navigation state
    nav: null, brake: 0, honk: 0,
    dead: false, smokeT: 0, stolen: false,
  };
}

// Place a car on a random road, aligned to a lane, with nav state.
export function spawnTrafficCar(game, rng) {
  const vertical = rng.chance(0.5);
  const types = ['sedan', 'sedan', 'sedan', 'taxi', 'taxi', 'van', 'truck', 'sports'];
  const type = rng.pick(types);
  let x, y, angle, dir;
  if (vertical) {
    const rx = rng.pick(ROADS_V);
    dir = rng.chance(0.5) ? 1 : -1;
    // Right-hand traffic: heading +y uses lane at x+LANE, heading -y uses x-LANE.
    x = rx + (dir > 0 ? LANE : -LANE);
    y = rng.range(140, WORLD.sandY - 80);
    angle = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
  } else {
    const ry = rng.pick(ROADS_H);
    dir = rng.chance(0.5) ? 1 : -1;
    y = ry + (dir > 0 ? -LANE : LANE);
    x = rng.range(140, WORLD.w - 140);
    angle = dir > 0 ? 0 : Math.PI;
  }
  const car = makeCar(rng, type, x, y, angle);
  car.nav = { vertical, dir, cruise: rng.range(0.55, 0.9) };
  car.speed = CAR_TYPES[type].maxSpeed * car.nav.cruise * 0.6;
  return car;
}

export function spawnParkedCars(game, rng) {
  const cars = [];
  // All spots verified against the generated city: on roads, kerbs or open
  // aprons — never inside a building footprint.
  const spots = [
    // Palma beachfront kerbs (near the M2 target car)
    { x: 870, y: 1700 }, { x: 870, y: 1950 }, { x: 300, y: 2153 }, { x: 700, y: 2207 },
    // downtown kerbs
    { x: 880, y: 400 }, { x: 880, y: 620 }, { x: 2280, y: 500 }, { x: 1590, y: 1200 },
    // suburb driveways / kerbs
    { x: 250, y: 420 }, { x: 250, y: 1080 }, { x: 860, y: 1300 },
    // industrial streets
    { x: 2380, y: 1450 }, { x: 3050, y: 1200 }, { x: 3050, y: 300 },
    // marina apron
    { x: 2520, y: 1900 }, { x: 2700, y: 1900 }, { x: 2950, y: 1750 },
    // park edge
    { x: 985, y: 1750 }, { x: 1590, y: 2050 },
  ];
  for (const s of spots) {
    const type = rng.pick(['sedan', 'sedan', 'van', 'taxi', 'sports', 'truck']);
    const vertical = rng.chance(0.5);
    const car = makeCar(rng, type, s.x + rng.range(-8, 8), s.y + rng.range(-8, 8), vertical ? Math.PI / 2 : 0);
    car.parked = true;
    cars.push(car);
  }
  // The M2 "Hot Wheels" target: a distinctive gold sports car at the hotel.
  const target = makeCar(rng, 'sports', PLACES.palmaCar.x, PLACES.palmaCar.y, 0);
  target.color = '#ffd166';
  target.missionTarget = true;
  cars.push(target);
  return cars;
}

export function makePed(rng, x, y, opts = {}) {
  return {
    id: NEXT_ID++, kind: 'ped',
    x, y, angle: rng.range(0, Math.PI * 2),
    speed: 0, walkPhase: rng.range(0, 6),
    state: opts.state || 'wander', // wander | flee | gang | npc | driver-flee
    health: opts.health ?? 100,
    color: rng.pick(['#e07a5f', '#81b29a', '#f2cc8f', '#577590', '#bc6c25', '#6d597a', '#43aa8b']),
    shirt: rng.pick(['#264653', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51', '#ffffff', '#90be6d']),
    name: opts.name || null,
    hostile: !!opts.hostile,
    attackCd: 0, hurtT: 0, dead: false, deadT: 0,
    target: null, home: { x, y },
    wanderT: rng.range(0, 3), tx: x, ty: y,
  };
}

export function spawnPeds(game, rng) {
  const peds = [];
  for (let i = 0; i < PED_COUNT; i++) {
    // Sidewalk wandering: pick a block edge point near a road.
    const vx = rng.pick(ROADS_V), hy = rng.pick(ROADS_H);
    const onV = rng.chance(0.5);
    const x = onV ? vx + rng.pick([-1, 1]) * (ROAD_W / 2 + 12) : rng.range(120, WORLD.w - 120);
    const y = onV ? rng.range(120, WORLD.sandY - 60) : hy + rng.pick([-1, 1]) * (ROAD_W / 2 + 12);
    peds.push(makePed(rng, x, y));
  }
  // Named NPCs who anchor the story at the garage.
  const nara = makePed(rng, PLACES.garage.x - 30, PLACES.garage.y - 6, { state: 'npc', name: 'Nara' });
  nara.shirt = '#ff5d8f';
  const bimo = makePed(rng, PLACES.garage.x + 34, PLACES.garage.y + 10, { state: 'npc', name: 'Bimo' });
  bimo.shirt = '#39d5e8';
  peds.push(nara, bimo);
  return peds;
}

// ---------------------------------------------------------------------------
// Particles + tire marks (shared pools, allocated once)
// ---------------------------------------------------------------------------
export class Particles {
  constructor() { this.list = []; this.marks = []; }
  spawn(x, y, opts = {}) {
    if (this.list.length > 420) this.list.shift();
    this.list.push({
      x, y,
      vx: opts.vx ?? (Math.random() - 0.5) * 90,
      vy: opts.vy ?? (Math.random() - 0.5) * 90,
      life: opts.life ?? 0.6, maxLife: opts.life ?? 0.6,
      size: opts.size ?? 3, color: opts.color ?? '#ffffff',
      gravity: opts.gravity ?? 0, drag: opts.drag ?? 1,
      text: opts.text || null, rise: opts.rise ?? 0,
    });
  }
  burst(x, y, n, color, speed = 120, life = 0.5, size = 3) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = Math.random() * speed;
      this.spawn(x, y, { vx: Math.cos(a) * s, vy: Math.sin(a) * s, color, life: life * (0.5 + Math.random() * 0.8), size });
    }
  }
  addMark(x, y, angle) {
    if (this.marks.length > 900) this.marks.shift();
    this.marks.push({ x, y, angle, life: 6 });
  }
  update(dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.life -= dt;
      if (p.life <= 0) { this.list.splice(i, 1); continue; }
      p.vy += p.gravity * dt;
      p.vx *= p.drag; p.vy *= p.drag;
      p.x += p.vx * dt; p.y += p.vy * dt - p.rise * dt;
    }
    for (let i = this.marks.length - 1; i >= 0; i--) {
      this.marks[i].life -= dt;
      if (this.marks[i].life <= 0) this.marks.splice(i, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Traffic update
// ---------------------------------------------------------------------------
function obstacleAhead(game, car, dist) {
  const fx = Math.cos(car.angle), fy = Math.sin(car.angle);
  const px = car.x + fx * dist, py = car.y + fy * dist;
  const near = (e, r) => Math.hypot(e.x - px, e.y - py) < r;
  for (const c of game.cars) {
    if (c === car || c.dead) continue;
    if (near(c, car.len * 0.75)) return c;
  }
  for (const c of game.police) if (near(c, car.len * 0.75)) return c;
  if (game.player.car && game.player.car !== car && near(game.player.car, car.len * 0.8)) return game.player.car;
  if (!game.player.car && near(game.player, 20)) return game.player;
  for (const p of game.peds) if (!p.dead && near(p, 16)) return p;
  return null;
}

export function updateTrafficCar(game, car, dt) {
  if (car.parked || car.dead || car === game.player.car) return;
  const spec = CAR_TYPES[car.type];
  const nav = car.nav;
  if (!nav) return;

  const blocked = obstacleAhead(game, car, car.len * 0.9 + Math.abs(car.speed) * 0.22);
  let targetSpeed = spec.maxSpeed * nav.cruise;
  if (blocked) targetSpeed = 0;
  // Slow near intersections to make turning/merging look natural.
  car.speed += Math.max(-260 * dt, Math.min(spec.accel * dt, targetSpeed - car.speed));
  if (Math.abs(car.speed) < 2 && blocked) car.speed = 0;

  // Advance along the current road axis.
  if (nav.vertical) car.y += nav.dir * car.speed * dt;
  else car.x += nav.dir * car.speed * dt;

  // At an intersection centre, maybe turn (or continue) — snap into new lane.
  const crossList = nav.vertical ? ROADS_H : ROADS_V;
  const pos = nav.vertical ? car.y : car.x;
  for (const cross of crossList) {
    if (Math.abs(pos - cross) < Math.max(3, Math.abs(car.speed) * dt)) {
      const rng = game.rng;
      if (rng.chance(0.42)) {
        // Turn: new axis, direction chosen, position snapped to intersection.
        const oldVertical = nav.vertical;
        if (oldVertical) car.y = cross; else car.x = cross;
        nav.vertical = !oldVertical;
        nav.dir = rng.chance(0.5) ? 1 : -1;
        if (nav.vertical) {
          // Now heading along a vertical road: which one? The one we are on (x).
          let bestRoad = ROADS_V[0], bd = Infinity;
          for (const rx of ROADS_V) { const d = Math.abs(car.x - rx); if (d < bd) { bd = d; bestRoad = rx; } }
          car.x = bestRoad + (nav.dir > 0 ? LANE : -LANE);
          car.angle = nav.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
        } else {
          let bestRoad = ROADS_H[0], bd = Infinity;
          for (const ry of ROADS_H) { const d = Math.abs(car.y - ry); if (d < bd) { bd = d; bestRoad = ry; } }
          car.y = bestRoad + (nav.dir > 0 ? -LANE : LANE);
          car.angle = nav.dir > 0 ? 0 : Math.PI;
        }
      }
      break;
    }
  }
  // Keep heading aligned with travel (turns snap; straights stay true).
  if (nav.vertical) car.angle = nav.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
  else car.angle = nav.dir > 0 ? 0 : Math.PI;

  // Wrap / despawn at world bounds: respawn on a far road to keep density.
  if (car.x < 40 || car.x > WORLD.w - 40 || car.y < 40 || car.y > WORLD.sandY + 30) {
    const fresh = spawnTrafficCar(game, game.rng);
    car.x = fresh.x; car.y = fresh.y; car.nav = fresh.nav; car.angle = fresh.angle; car.speed = fresh.speed;
  }
  // Never end up inside a building (shouldn't happen on roads, but be safe).
  const fix = collideCircle(game.world, car.x, car.y, 6);
  if (fix.hit) { car.x = fix.x; car.y = fix.y; }
}

// ---------------------------------------------------------------------------
// Police update
// ---------------------------------------------------------------------------
export function spawnPolice(game) {
  const rng = game.rng;
  const p = game.player;
  // Spawn on a road 520-720px away from the player, out of immediate sight.
  const a = rng.range(0, Math.PI * 2), d = rng.range(540, 720);
  let x = Math.max(80, Math.min(WORLD.w - 80, p.x + Math.cos(a) * d));
  let y = Math.max(80, Math.min(WORLD.sandY - 40, p.y + Math.sin(a) * d));
  const car = makeCar(rng, 'police', x, y, a + Math.PI);
  car.police = true;
  car.nav = null;
  game.police.push(car);
  return car;
}

export function updatePoliceCar(game, car, dt) {
  if (car.dead) return;
  const spec = CAR_TYPES.police;
  const p = game.player;
  const target = p.car ? p.car : p;
  // Aim slightly behind the target so pursuits feel like shadowing, not homing.
  const tx = target.x - Math.cos(target.angle || 0) * 10;
  const ty = target.y - Math.sin(target.angle || 0) * 10;
  const dx = tx - car.x, dy = ty - car.y;
  const dist = Math.hypot(dx, dy);
  const desired = Math.atan2(dy, dx);
  let diff = desired - car.angle;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;

  const onFoot = !p.car;
  const stopDist = onFoot ? 46 : 8;
  let targetSpeed = spec.maxSpeed * (game.wanted >= 4 ? 1.0 : 0.92);
  if (dist < stopDist + 30) targetSpeed = Math.min(targetSpeed, Math.max(0, (dist - stopDist)) * 4);
  if (Math.abs(diff) > 2.2) targetSpeed = 60; // turn in place-ish

  car.angle += Math.max(-spec.grip * dt, Math.min(spec.grip * dt, diff * 2.4 * dt * 3));
  car.speed += Math.max(-320 * dt, Math.min(spec.accel * dt, targetSpeed - car.speed));
  const nx = car.x + Math.cos(car.angle) * car.speed * dt;
  const ny = car.y + Math.sin(car.angle) * car.speed * dt;
  const probe = { x: nx, y: ny, angle: car.angle, len: car.len, wid: car.wid };
  if (!carCollides(game.world, probe) && !inWater(game.world, nx, ny)) {
    car.x = nx; car.y = ny;
  } else {
    // Slide: try axis-separated movement; scrape = damage + sparks.
    if (!carCollides(game.world, { ...probe, y: car.y })) { car.x = nx; }
    else if (!carCollides(game.world, { ...probe, x: car.x })) { car.y = ny; }
    else {
      if (Math.abs(car.speed) > 90 && game.time - (car.lastCrash || 0) > 0.4) {
        car.lastCrash = game.time;
        car.health -= 6;
        game.particles.burst(car.x, car.y, 6, '#ffd166', 130, 0.4, 3);
        game.audio.crash(0.5);
      }
      car.speed *= 0.35;
    }
  }
  if (car.health <= 0 && !car.dead) {
    car.dead = true;
    game.particles.burst(car.x, car.y, 26, '#ff7a1a', 180, 0.9, 5);
    game.particles.burst(car.x, car.y, 18, '#555555', 90, 1.4, 6);
  }
}

// ---------------------------------------------------------------------------
// Pedestrian / enemy update
// ---------------------------------------------------------------------------
export function updatePed(game, ped, dt) {
  if (ped.dead) { ped.deadT += dt; return; }
  const p = game.player;
  const rng = game.rng;
  ped.hurtT = Math.max(0, ped.hurtT - dt);
  ped.attackCd = Math.max(0, ped.attackCd - dt);

  let moveX = 0, moveY = 0, speed = 62;

  if (ped.state === 'npc') {
    ped.angle += Math.sin(game.time * 0.7 + ped.id) * 0.15 * dt; // idle sway
    return;
  }

  if (ped.state === 'gang') {
    const d = Math.hypot(p.x - ped.x, p.y - ped.y);
    const inCar = !!p.car;
    if (!inCar && d < 300) {
      // Chase and punch the player.
      if (d > 26) { moveX = (p.x - ped.x) / d; moveY = (p.y - ped.y) / d; speed = 148; }
      else if (ped.attackCd <= 0) {
        ped.attackCd = 0.8;
        game.damagePlayer(7, ped.x, ped.y);
        game.particles.burst(p.x, p.y - 6, 4, '#e63946', 80, 0.3, 3);
        game.audio.punch();
      }
    } else if (d >= 300) {
      // Drift back toward home post.
      const hd = Math.hypot(ped.home.x - ped.x, ped.home.y - ped.y);
      if (hd > 12) { moveX = (ped.home.x - ped.x) / hd; moveY = (ped.home.y - ped.y) / hd; speed = 70; }
    }
  } else if (ped.state === 'flee' || ped.state === 'driver-flee') {
    const threat = ped.target || p;
    const d = Math.hypot(threat.x - ped.x, threat.y - ped.y) || 1;
    moveX = (ped.x - threat.x) / d; moveY = (ped.y - threat.y) / d;
    speed = 175;
    ped.fleeT = (ped.fleeT || 3) - dt;
    if (ped.fleeT <= 0 && ped.state === 'flee') ped.state = 'wander';
    if (ped.state === 'driver-flee' && d > 260) ped.state = 'wander';
  } else {
    // Wander between sidewalk points.
    ped.wanderT -= dt;
    const d = Math.hypot(ped.tx - ped.x, ped.ty - ped.y);
    if (ped.wanderT <= 0 || d < 8) {
      ped.wanderT = rng.range(2.5, 6);
      ped.tx = Math.max(30, Math.min(WORLD.w - 30, ped.x + rng.range(-260, 260)));
      ped.ty = Math.max(30, Math.min(WORLD.sandY + 120, ped.y + rng.range(-260, 260)));
    } else { moveX = (ped.tx - ped.x) / d; moveY = (ped.ty - ped.y) / d; }
    // Flee gunfire / fast cars nearby.
    if (game.lastShotAt && game.time - game.lastShotAt < 1.2 && Math.hypot(p.x - ped.x, p.y - ped.y) < 220) {
      ped.state = 'flee'; ped.fleeT = 2.5; ped.target = p;
    }
  }

  if (moveX || moveY) {
    ped.angle = Math.atan2(moveY, moveX);
    ped.walkPhase += dt * (speed / 14);
    let nx = ped.x + moveX * speed * dt;
    let ny = ped.y + moveY * speed * dt;
    if (inWater(game.world, nx, ny)) { nx = ped.x; ny = ped.y; }
    const fix = collideCircle(game.world, nx, ny, 9);
    ped.x = fix.x; ped.y = fix.y;
    ped.speed = speed;
  } else ped.speed = 0;
}

// A ped panics (used when their car is stolen or violence happens nearby).
export function scarePeds(game, x, y, radius, threat) {
  for (const ped of game.peds) {
    if (ped.dead || ped.state === 'npc' || ped.state === 'gang') continue;
    if (Math.hypot(ped.x - x, ped.y - y) < radius) {
      ped.state = 'flee'; ped.fleeT = 2.2; ped.target = threat || game.player;
    }
  }
}
