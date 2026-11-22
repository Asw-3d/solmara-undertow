// ============================================================================
// SOLMARA UNDERTOW — main.js
// Game orchestration: owns the Game object every other module reads, runs
// the loop, and implements the player-facing rules — on-foot movement,
// driving physics, car theft, combat, crime & wanted, police pressure,
// bust/wasted flow, weather, day/night, saving, and UI state transitions.
//
// States: title → playing ⇄ dialog / paused → busted / wasted → playing,
// and complete (campaign finished) → playing (free roam).
// ============================================================================

import { WORLD, PLACES, SAVE_KEY, CRIME, CAR_TYPES, districtAt } from './config.js';
import { RNG } from './random.js';
import { generateWorld, collideCircle, carCollides, inWater } from './world.js';
import { Input } from './input.js';
import { AudioSys } from './audio.js';
import {
  spawnTrafficCar, spawnParkedCars, spawnPeds, makePed,
  updateTrafficCar, updatePoliceCar, spawnPolice, updatePed,
  scarePeds, Particles,
} from './entities.js';
import { MissionManager } from './missions.js';
import { Renderer } from './render.js';
import { drawHUD, drawDialog, drawTitle, drawOverlay } from './hud.js';
import { stageShot } from './shots.js';

const VIEW_W = 1280, VIEW_H = 800;

class Game {
  constructor() {
    this.canvas = document.getElementById('game');
    this.canvas.width = VIEW_W;
    this.canvas.height = VIEW_H;
    this.ctx = this.canvas.getContext('2d');
    this.renderer = new Renderer(this.canvas);
    this.input = new Input(this.canvas);
    this.audio = new AudioSys();
    this.rng = new RNG(20240);

    const params = new URLSearchParams(window.location.search);
    this.seed = Number.parseInt(params.get('seed') ?? '1337', 10) || 1337;
    this.shotName = params.get('shot');
    this.world = generateWorld(this.seed);

    this.state = 'title';
    this.time = 0;
    this.dayT = 0.715; // ~17:10 — golden hour opening
    this.weather = 'clear';
    this.weatherT = 40;
    this.districtName = 'Casa Verde';

    this.player = {
      x: PLACES.start.x, y: PLACES.start.y, angle: -Math.PI / 2,
      speed: 0, walkPhase: 0, moving: false,
      health: 100, armor: 0, car: null, invuln: 0, muzzle: 0,
      punchCd: 0, fireCd: 0, lastHurtT: -99,
    };
    this.cam = { x: 0, y: 0, shakeX: 0, shakeY: 0, shake: 0 };
    this.mouseWorld = { x: 0, y: 0 };

    this.money = 150;
    this.heat = 0;
    this.wanted = 0;
    this.policeSeePlayer = false;
    this.unseenT = 0;
    this.lastShotAt = -99;
    this.bustMeter = 0;
    this.hasPistol = false;

    this.cars = [];
    this.police = [];
    this.peds = [];
    this.particles = new Particles();
    this.missions = new MissionManager();
    this.dialog = null;
    this.bannerData = null;
    this.bannerT = 0;
    this.bannerDur = 3.2;
    this.promptText = '';
    this.uiButtons = [];
    this.policeSpawnCd = 0;
    this.hasSave = !!this._readSave();
    this.storyComplete = false;
    this._saveToastT = 0;

    this.resetCity();
    this._centerCam(true);
  }

  // ---- World population -----------------------------------------------------
  resetCity() {
    const rng = new RNG(this.seed * 7 + 5);
    this.cars = [];
    for (let i = 0; i < 24; i++) this.cars.push(spawnTrafficCar(this, rng));
    this.cars.push(...spawnParkedCars(this, rng));
    this.police = [];
    this.peds = spawnPeds(this, rng);
  }

  _centerCam(snap = false) {
    const t = this.player.car || this.player;
    const tx = Math.max(0, Math.min(WORLD.w - VIEW_W, t.x - VIEW_W / 2));
    const ty = Math.max(0, Math.min(WORLD.h - VIEW_H, t.y - VIEW_H / 2));
    if (snap) { this.cam.x = tx; this.cam.y = ty; }
    else {
      this.cam.x += (tx - this.cam.x) * 0.09;
      this.cam.y += (ty - this.cam.y) * 0.09;
    }
  }

  // ---- Callbacks used by missions / entities --------------------------------
  banner(title, sub) {
    this.bannerData = { title, sub };
    this.bannerT = this.bannerDur;
  }

  addMoney(amount, x, y) {
    this.money += amount;
    if (x !== undefined) {
      this.particles.spawn(x, y, { text: `+$${amount}`, color: '#7dff6a', life: 1.3, rise: 34, vx: 0, vy: 0, size: 15 });
    }
  }

  startDialog(lines, onDone) {
    this.dialog = { lines, index: 0, onDone: onDone || null };
    this.state = 'dialog';
    this.audio.dialog();
  }

  advanceDialog() {
    if (!this.dialog) return;
    this.audio.dialog();
    this.dialog.index += 1;
    if (this.dialog.index >= this.dialog.lines.length) {
      const done = this.dialog.onDone;
      this.dialog = null;
      this.state = 'playing';
      if (done) done();
    }
  }

  unlockPistol() {
    if (!this.hasPistol) {
      this.hasPistol = true;
      this.banner('Pistol acquired', 'Mouse to aim — click to shoot');
    }
  }

  spawnGang(place) {
    const spots = [[-46, -30], [40, -44], [-30, 42], [52, 30]];
    let n = 0;
    for (const [dx, dy] of spots) {
      const ped = makePed(this.rng, place.x + dx, place.y + dy, { state: 'gang', health: 100 });
      ped.home = { x: place.x + dx, y: place.y + dy };
      this.peds.push(ped);
      n++;
    }
    return n;
  }

  onCampaignComplete(total) {
    this.storyComplete = true;
    this.state = 'complete';
    this.audio.sting(true);
  }

  // ---- Crime & wanted ---------------------------------------------------------
  crimeWitnessed(x, y) {
    for (const c of this.police) if (!c.dead && Math.hypot(c.x - x, c.y - y) < 430) return true;
    for (const p of this.peds) if (!p.dead && p.state !== 'gang' && Math.hypot(p.x - x, p.y - y) < 210) return true;
    return this.wanted > 0 && this.policeSeePlayer;
  }

  addCrime(amount, x, y) {
    if (this.frozenCrime) return; // screenshot staging: stars stay as staged
    const witnessed = this.crimeWitnessed(x ?? this.player.x, y ?? this.player.y);
    const before = this.wanted;
    this.heat += witnessed ? amount : amount * 0.35;
    this.heat = Math.min(this.heat, 500);
    this.wanted = Math.max(0, Math.min(5, Math.ceil(this.heat / 100)));
    if (this.wanted > before) {
      this.audio.wanted();
      this.banner('WANTED', `${this.wanted} star${this.wanted > 1 ? 's' : ''} — Solmara PD responding`);
    }
  }

  setWanted(stars, force = false) {
    this.wanted = stars;
    this.heat = stars <= 0 ? 0 : (stars - 1) * 100 + 60;
    if (stars > 0) this.audio.wanted();
    void force;
  }

  clearWanted() {
    this.wanted = 0;
    this.heat = 0;
    this.bustMeter = 0;
  }

  damagePlayer(amount, fromX, fromY) {
    const p = this.player;
    if (p.invuln > 0 || this.state !== 'playing') return;
    p.invuln = 0.35;
    p.lastHurtT = this.time;
    let dmg = amount;
    if (p.armor > 0) {
      const absorbed = Math.min(p.armor, dmg * 0.6);
      p.armor -= absorbed;
      dmg -= absorbed;
    }
    p.health -= dmg;
    this.audio.hurt();
    this.cam.shake = Math.min(9, this.cam.shake + 3);
    this.particles.burst(p.x, p.y - 4, 5, '#e63946', 90, 0.35, 3);
    if (fromX !== undefined) { // knockback
      const d = Math.hypot(p.x - fromX, p.y - fromY) || 1;
      const nx = p.x + ((p.x - fromX) / d) * 12, ny = p.y + ((p.y - fromY) / d) * 12;
      if (!p.car) { const fix = collideCircle(this.world, nx, ny, 10); p.x = fix.x; p.y = fix.y; }
    }
    if (p.health <= 0) this._wasted();
  }

  _wasted() {
    this.state = 'wasted';
    this.audio.engine(0, false);
    this.audio.siren(0);
    this.audio.sting(false);
  }

  _busted() {
    this.state = 'busted';
    this.audio.engine(0, false);
    this.audio.siren(0);
    this.audio.sting(false);
  }

  respawn(kind) {
    const p = this.player;
    this.money = Math.max(0, this.money - 200);
    if (p.car) { p.car = null; }
    const place = kind === 'busted' ? PLACES.policeHQ : PLACES.hospital;
    p.x = place.x; p.y = place.y + 46;
    p.health = 100; p.armor = 0; p.invuln = 1.5;
    this.clearWanted();
    for (const c of this.police) c.dead = true;
    this.police = [];
    this.state = 'playing';
    this._centerCam(true);
    this.saveGame();
    this.banner(kind === 'busted' ? 'Released' : 'Discharged', 'You are $200 lighter. Stay out of trouble.');
  }

  // ---- Save / load -------------------------------------------------------------
  _readSave() {
    try {
      const raw = window.localStorage.getItem(SAVE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  saveGame() {
    try {
      const data = {
        money: this.money,
        missions: this.missions.serialize(),
        player: { x: this.player.x, y: this.player.y },
        health: Math.max(20, Math.ceil(this.player.health)),
        hasPistol: this.hasPistol,
        dayT: this.dayT,
        storyComplete: this.storyComplete,
      };
      window.localStorage.setItem(SAVE_KEY, JSON.stringify(data));
      this.hasSave = true;
      this._saveToastT = this.time;
    } catch { /* storage unavailable: play on without saving */ }
  }

  loadGame() {
    const data = this._readSave();
    if (!data) return false;
    this.money = data.money ?? 150;
    this.missions.deserialize(data.missions);
    this.player.x = data.player?.x ?? PLACES.start.x;
    this.player.y = data.player?.y ?? PLACES.start.y;
    this.player.health = data.health ?? 100;
    this.player.car = null;
    this.hasPistol = !!data.hasPistol;
    this.dayT = data.dayT ?? 0.715;
    this.storyComplete = !!data.storyComplete;
    this.clearWanted();
    this._centerCam(true);
    return true;
  }

  newGame() {
    try { window.localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
    this.hasSave = false;
    this.money = 150;
    this.missions = new MissionManager();
    this.player.x = PLACES.start.x; this.player.y = PLACES.start.y;
    this.player.health = 100; this.player.armor = 25;
    this.player.car = null;
    this.hasPistol = false;
    this.storyComplete = false;
    this.dayT = 0.715;
    this.clearWanted();
    this.resetCity();
    this._centerCam(true);
    this.state = 'playing';
    this.banner('SOLMARA UNDERTOW', 'Meet Nara at the gold marker — Bimo\'s Garage, Casa Verde');
  }

  // ==========================================================================
  // Update
  // ==========================================================================
  update(dt) {
    this.time += dt;
    // NOTE: uiButtons is filled by render() each frame and consumed here on
    // the *next* update — do not clear it in update or clicks never land.
    this.mouseWorld.x = this.input.mouse.x + this.cam.x;
    this.mouseWorld.y = this.input.mouse.y + this.cam.y;
    if (this.bannerT > 0) this.bannerT -= dt;

    // Global keys
    if (this.input.pressed('KeyM')) {
      this.audio.init();
      this.audio.setMuted(!this.audio.muted);
    }

    switch (this.state) {
      case 'title': this._updateTitle(dt); break;
      case 'playing': this._updatePlaying(dt); break;
      case 'dialog': this._updateAmbient(dt); this._updateDialogInput(); break;
      case 'paused': this._updateOverlayInput(); break;
      case 'busted': case 'wasted':
        if (this.input.pressed('Enter')) this.respawn(this.state);
        break;
      case 'complete': this._updateOverlayInput(); break;
    }

    // Camera shake decay
    this.cam.shake = Math.max(0, this.cam.shake - dt * 26);
    this.cam.shakeX = (Math.random() - 0.5) * this.cam.shake;
    this.cam.shakeY = (Math.random() - 0.5) * this.cam.shake;

    this.input.postUpdate();
  }

  _updateTitle(dt) {
    this.particles.update(dt);
    // Slow ambient pan behind the painted title vista is unnecessary (title
    // is a full-screen painting), but keep world entities breathing.
    if (this.input.pressed('Enter')) {
      this.audio.init();
      if (this.hasSave) { this.loadGame(); this.state = 'playing'; }
      else this.newGame();
    }
    if (this.input.mouse.clicked) this._clickButtons();
  }

  _updateOverlayInput() {
    if (this.input.mouse.clicked) this._clickButtons();
    if (this.state === 'paused' && this.input.pressed('KeyP', 'Escape')) this.state = 'playing';
  }

  _clickButtons() {
    const mx = this.input.mouse.x, my = this.input.mouse.y;
    for (const b of this.uiButtons) {
      if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) {
        this.audio.init();
        this._doAction(b.action);
        return;
      }
    }
  }

  _doAction(action) {
    switch (action) {
      case 'newgame': this.newGame(); break;
      case 'continue': this.loadGame(); this.state = 'playing'; break;
      case 'sound': this.audio.init(); this.audio.setMuted(!this.audio.muted); break;
      case 'resume': this.state = 'playing'; break;
      case 'save': this.saveGame(); this.banner('Saved', 'Progress written to this browser'); break;
      case 'restart': {
        this.missions.phase = 'toStart';
        this.missions.timer = 0;
        this.clearWanted();
        this.player.x = PLACES.garage.x; this.player.y = PLACES.garage.y + 40;
        if (this.player.car) this.player.car = null;
        this.state = 'playing';
        break;
      }
      case 'title': this.state = 'title'; this.hasSave = !!this._readSave(); break;
      case 'roam': this.state = 'playing'; break;
    }
  }

  _updateDialogInput() {
    if (this.input.pressed('Enter', 'Space') || this.input.mouse.clicked) this.advanceDialog();
  }

  // Traffic/peds/particles keep moving during dialogs so the world feels alive.
  _updateAmbient(dt) {
    for (const car of this.cars) updateTrafficCar(this, car, dt);
    for (const ped of this.peds) if (ped.state !== 'gang') updatePed(this, ped, dt);
    this.particles.update(dt);
    this._carPedCollisions(false);
  }

  _updatePlaying(dt) {
    // Day cycle + weather
    this.dayT = (this.dayT + dt / 240) % 1;
    this.weatherT -= dt;
    if (this.weatherT <= 0) {
      this.weather = this.weather === 'rain' ? 'clear' : (this.rng.chance(0.3) ? 'rain' : 'clear');
      this.weatherT = this.weather === 'rain' ? this.rng.range(18, 32) : this.rng.range(35, 70);
    }
    this.districtName = districtAt(this.player.x, this.player.y).name;
    this.promptText = '';

    if (this.input.pressed('KeyP', 'Escape')) { this.state = 'paused'; return; }

    const p = this.player;
    p.invuln = Math.max(0, p.invuln - dt);
    p.muzzle = Math.max(0, p.muzzle - dt);
    p.punchCd = Math.max(0, p.punchCd - dt);
    p.fireCd = Math.max(0, p.fireCd - dt);
    // Slow regen after 5 calm seconds
    if (this.time - p.lastHurtT > 5 && p.health > 0 && p.health < 100) p.health = Math.min(100, p.health + 3 * dt);

    if (p.car) this._updateDriving(dt);
    else this._updateOnFoot(dt);

    // World life
    for (const car of this.cars) updateTrafficCar(this, car, dt);
    for (const ped of this.peds) updatePed(this, ped, dt);
    this._updatePolice(dt);
    this._carPedCollisions(true);
    this._carCarCollisions();
    this.particles.update(dt);

    // Car damage smoke/fire
    const allCars = [...this.cars, ...this.police];
    if (p.car) allCars.push(p.car);
    for (const car of allCars) {
      if (car.dead) { car.smokeT = Math.max(0, (car.smokeT ?? 2) - dt); continue; }
      if (car.health < 35 && Math.random() < dt * 8) {
        this.particles.spawn(car.x + (Math.random() - 0.5) * 14, car.y - 8, {
          vx: (Math.random() - 0.5) * 12, vy: -26 - Math.random() * 18,
          life: 0.9, size: 6, color: car.health < 15 ? '#ff7a1a' : 'rgba(90,90,90,0.8)', drag: 0.98,
        });
      }
    }

    // Missions
    if (this.missions.phase === 'toStart') {
      const mk = this.missions.marker();
      if (mk && Math.hypot(p.x - mk.x, p.y - mk.y) < 62 && !p.car) {
        this.missions.beginBriefing(this);
      } else if (mk && Math.hypot(p.x - mk.x, p.y - mk.y) < 62 && p.car) {
        this.promptText = 'Get out of the car to talk';
      }
    } else if (this.missions.phase === 'active') {
      this.missions.update(this, dt);
    }

    // Audio beds
    const speedRatio = p.car ? Math.abs(p.car.speed) / (CAR_TYPES[p.car.type].maxSpeed) : 0;
    this.audio.engine(speedRatio, !!p.car);
    const nearestCop = this.police.filter((c) => !c.dead).reduce((m, c) => Math.min(m, Math.hypot(c.x - p.x, c.y - p.y)), Infinity);
    this.audio.siren(this.wanted > 0 ? Math.max(0, 1 - nearestCop / 620) : 0);

    this._centerCam(false);
  }

  // ---- On foot ---------------------------------------------------------------
  _updateOnFoot(dt) {
    const p = this.player;
    const ax = this.input.axis();
    const sprint = this.input.down('ShiftLeft', 'ShiftRight');
    const speed = sprint ? 268 : 168;
    let mx = ax.x, my = ax.y;
    const len = Math.hypot(mx, my);
    p.moving = len > 0;
    if (len > 0) {
      mx /= len; my /= len;
      p.angle = this.hasPistol
        ? Math.atan2(this.mouseWorld.y - p.y, this.mouseWorld.x - p.x)
        : Math.atan2(my, mx);
      let nx = p.x + mx * speed * dt;
      let ny = p.y + my * speed * dt;
      if (inWater(this.world, nx, p.y)) nx = p.x;
      if (inWater(this.world, p.x, ny)) ny = p.y;
      const fix = collideCircle(this.world, nx, ny, 10);
      p.x = fix.x; p.y = fix.y;
      p.walkPhase += dt * (sprint ? 11 : 8);
    } else if (this.hasPistol) {
      p.angle = Math.atan2(this.mouseWorld.y - p.y, this.mouseWorld.x - p.x);
    }

    // Interaction: enter/steal car, or context prompt
    let nearestCar = null, nd = 58;
    for (const car of [...this.cars, ...this.police]) {
      if (car.dead) continue;
      if (car.police && car.speed !== 0) continue;
      const d = Math.hypot(car.x - p.x, car.y - p.y);
      if (d < nd) { nd = d; nearestCar = car; }
    }
    this.promptText = nearestCar ? `E — ${nearestCar.parked ? 'Steal' : 'Enter'} ${nearestCar.type}` : '';
    if (nearestCar && this.input.pressed('KeyE')) { this._enterCar(nearestCar); return; }

    // Melee
    if (this.input.pressed('KeyF') && p.punchCd <= 0) this._punch();
    // Shooting
    if (this.hasPistol && this.input.mouse.down && p.fireCd <= 0) this._shoot();
  }

  _enterCar(car) {
    const p = this.player;
    this.audio.init();
    this.audio.door();
    const wasParked = car.parked;
    const hadDriver = !car.parked && !car.police && car.nav;
    if (hadDriver) {
      // Driver bails out and runs.
      const driver = makePed(this.rng, car.x + 18, car.y + 10, { state: 'driver-flee' });
      driver.target = p;
      this.peds.push(driver);
      car.nav = null;
    }
    if (car.police) {
      this.police = this.police.filter((c) => c !== car);
      this.cars.push(car);
      car.police = false;
    }
    car.parked = false;
    car.stolen = true;
    p.car = car;
    p.x = car.x; p.y = car.y;
    this.cars = this.cars.filter((c) => c !== car || c === p.car);
    if (!this.cars.includes(car)) this.cars.push(car);
    // Crime: stealing
    const witnessed = this.crimeWitnessed(car.x, car.y);
    this.addCrime(witnessed || hadDriver ? CRIME.stealWitnessed : CRIME.stealUnseen, car.x, car.y);
    if (hadDriver) scarePeds(this, car.x, car.y, 170, p);
    void wasParked;
  }

  _exitCar() {
    const p = this.player;
    const car = p.car;
    this.audio.door();
    const side = car.angle + Math.PI / 2;
    let ex = car.x + Math.cos(side) * (car.wid / 2 + 14);
    let ey = car.y + Math.sin(side) * (car.wid / 2 + 14);
    const fix = collideCircle(this.world, ex, ey, 10);
    p.x = fix.x; p.y = fix.y;
    p.car = null;
    if (Math.abs(car.speed) < 12) { car.speed = 0; car.parked = true; }
  }

  // ---- Driving -----------------------------------------------------------------
  _updateDriving(dt) {
    const p = this.player;
    const car = p.car;
    const spec = CAR_TYPES[car.type];
    p.x = car.x; p.y = car.y;
    p.angle = car.angle;

    const fwd = this.input.down('KeyW', 'ArrowUp');
    const back = this.input.down('KeyS', 'ArrowDown');
    const left = this.input.down('KeyA', 'ArrowLeft');
    const right = this.input.down('KeyD', 'ArrowRight');
    const hand = this.input.down('Space');

    if (fwd) car.speed += spec.accel * dt;
    else if (back) car.speed -= (car.speed > 8 ? 330 : spec.accel * 0.55) * dt;
    // Drag + rolling resistance
    car.speed -= car.speed * 0.55 * dt;
    if (hand) car.speed -= car.speed * 2.4 * dt;
    car.speed = Math.max(-spec.maxSpeed * 0.38, Math.min(spec.maxSpeed, car.speed));

    const steer = (left ? -1 : 0) + (right ? 1 : 0);
    if (steer !== 0 && Math.abs(car.speed) > 4) {
      const dir = car.speed >= 0 ? 1 : -1;
      const gripFactor = hand ? 1.65 : 1;
      car.angle += steer * dir * spec.grip * gripFactor * dt * Math.min(1, Math.abs(car.speed) / 130);
      // Tire marks + drift smoke when sliding hard
      if ((hand && Math.abs(car.speed) > 90) || Math.abs(car.speed) > spec.maxSpeed * 0.82) {
        const bx = car.x - Math.cos(car.angle) * car.len * 0.32;
        const by = car.y - Math.sin(car.angle) * car.len * 0.32;
        this.particles.addMark(bx + Math.cos(car.angle + Math.PI / 2) * 8, by + Math.sin(car.angle + Math.PI / 2) * 8, car.angle);
        this.particles.addMark(bx - Math.cos(car.angle + Math.PI / 2) * 8, by - Math.sin(car.angle + Math.PI / 2) * 8, car.angle);
      }
    }
    car.braking = back && car.speed > 8;

    const nx = car.x + Math.cos(car.angle) * car.speed * dt;
    const ny = car.y + Math.sin(car.angle) * car.speed * dt;
    const probe = { x: nx, y: ny, angle: car.angle, len: car.len, wid: car.wid };
    const hit = carCollides(this.world, probe);
    if (hit || inWater(this.world, nx, ny)) {
      const impact = Math.abs(car.speed);
      if (impact > 120) {
        car.health -= (impact - 110) * 0.06;
        this.damagePlayer((impact - 120) * 0.02, car.x - Math.cos(car.angle) * 30, car.y - Math.sin(car.angle) * 30);
        this.audio.crash(Math.min(1, impact / 320));
        this.cam.shake = Math.min(11, impact * 0.03);
        this.particles.burst(nx, ny, 10, '#ffd166', 170, 0.4, 3);
      } else if (impact > 30) this.audio.crash(0.3);
      // Try axis slide
      if (!carCollides(this.world, { ...probe, y: car.y }) && !inWater(this.world, nx, car.y)) car.x = nx;
      else if (!carCollides(this.world, { ...probe, x: car.x }) && !inWater(this.world, car.x, ny)) car.y = ny;
      car.speed *= -0.22;
      if (car.health <= 0 && !car.dead) this._killCar(car, true);
    } else {
      car.x = nx; car.y = ny;
    }
    car.x = Math.max(30, Math.min(WORLD.w - 30, car.x));
    car.y = Math.max(30, Math.min(WORLD.h - 20, car.y));

    if (this.input.pressed('KeyE') && Math.abs(car.speed) < 60) this._exitCar();
    if (this.hasPistol && this.input.mouse.down && p.fireCd <= 0) this._shoot(true);
  }

  _killCar(car, eject = false) {
    car.dead = true;
    car.smokeT = 2.5;
    car.speed = 0;
    this.particles.burst(car.x, car.y, 30, '#ff7a1a', 200, 0.9, 5);
    this.particles.burst(car.x, car.y, 20, '#444444', 100, 1.5, 7);
    this.audio.crash(1);
    this.cam.shake = 10;
    if (eject && this.player.car === car) {
      this.player.car = null;
      this.player.x = car.x + 26; this.player.y = car.y + 10;
      this.damagePlayer(6);
    }
  }

  // ---- Combat ------------------------------------------------------------------
  _punch() {
    const p = this.player;
    p.punchCd = 0.38;
    this.audio.punch();
    const range = 32;
    const tx = p.x + Math.cos(p.angle) * range, ty = p.y + Math.sin(p.angle) * range;
    let hitAny = false;
    for (const ped of this.peds) {
      if (ped.dead) continue;
      if (Math.hypot(ped.x - tx, ped.y - ty) < 20) {
        hitAny = true;
        ped.health -= 34;
        ped.hurtT = 0.25;
        this.particles.burst(ped.x, ped.y - 6, 5, '#ffd166', 90, 0.3, 3);
        if (ped.state !== 'gang') {
          this.addCrime(CRIME.punchPed, ped.x, ped.y);
          ped.state = 'flee'; ped.fleeT = 3; ped.target = p;
          scarePeds(this, ped.x, ped.y, 130, p);
        }
        if (ped.health <= 0) this._killPed(ped, ped.state === 'gang');
      }
    }
    if (!hitAny) {
      for (const car of this.cars) {
        if (Math.hypot(car.x - tx, car.y - ty) < car.len / 2 + 8) {
          car.health -= 3;
          this.particles.burst(tx, ty, 4, '#ffd166', 110, 0.25, 2);
          break;
        }
      }
    }
  }

  _shoot(fromCar = false) {
    const p = this.player;
    p.fireCd = 0.21;
    p.muzzle = 0.055;
    this.lastShotAt = this.time;
    this.audio.shoot();
    const origin = fromCar && p.car ? p.car : p;
    const ang = Math.atan2(this.mouseWorld.y - origin.y, this.mouseWorld.x - origin.x);
    if (!fromCar) p.angle = ang;
    const maxRange = 540;
    let bestT = maxRange, hitEnt = null, hitKind = null;
    const testCircle = (e, r, kind) => {
      const dx = e.x - origin.x, dy = e.y - origin.y;
      const t = dx * Math.cos(ang) + dy * Math.sin(ang);
      if (t < 12 || t > maxRange) return;
      const perp = Math.abs(-dx * Math.sin(ang) + dy * Math.cos(ang));
      if (perp < r && t < bestT) { bestT = t; hitEnt = e; hitKind = kind; }
    };
    for (const ped of this.peds) if (!ped.dead) testCircle(ped, 13, 'ped');
    for (const car of [...this.cars, ...this.police]) {
      if (car === p.car || car.dead) continue;
      testCircle(car, car.wid * 0.75 + 6, 'car');
    }
    // Buildings block the shot: sample along the ray.
    let blockT = maxRange;
    for (let t = 16; t < bestT; t += 14) {
      const sx = origin.x + Math.cos(ang) * t, sy = origin.y + Math.sin(ang) * t;
      for (const b of this.world.buildings) {
        if (sx > b.x && sx < b.x + b.w && sy > b.y && sy < b.y + b.h) { blockT = t; break; }
      }
      if (blockT < maxRange) break;
    }
    const endT = Math.min(bestT, blockT);
    const ex = origin.x + Math.cos(ang) * endT, ey = origin.y + Math.sin(ang) * endT;
    // Tracer
    for (let t = 20; t < endT; t += 46) {
      this.particles.spawn(origin.x + Math.cos(ang) * t, origin.y + Math.sin(ang) * t, {
        vx: 0, vy: 0, life: 0.07, size: 2.6, color: '#ffe9a8',
      });
    }
    this.addCrime(CRIME.shoot, origin.x, origin.y);
    scarePeds(this, origin.x, origin.y, 230, p);
    if (blockT <= bestT) {
      this.particles.burst(ex, ey, 3, '#ffd166', 80, 0.2, 2);
      return;
    }
    if (!hitEnt) return;
    if (hitKind === 'ped') {
      hitEnt.health -= 55;
      hitEnt.hurtT = 0.3;
      this.particles.burst(hitEnt.x, hitEnt.y - 4, 6, '#e63946', 100, 0.35, 3);
      if (hitEnt.health <= 0) this._killPed(hitEnt, hitEnt.state === 'gang');
      else if (hitEnt.state !== 'gang') { hitEnt.state = 'flee'; hitEnt.fleeT = 3; hitEnt.target = p; }
    } else if (hitKind === 'car') {
      hitEnt.health -= 9;
      this.particles.burst(ex, ey, 5, '#ffd166', 120, 0.25, 2.4);
      if (hitEnt.police) this.addCrime(CRIME.policeHit, hitEnt.x, hitEnt.y);
      if (hitEnt.health <= 0 && !hitEnt.dead) {
        if (hitEnt.police) { hitEnt.dead = true; hitEnt.smokeT = 2.5; this.particles.burst(hitEnt.x, hitEnt.y, 24, '#ff7a1a', 180, 0.8, 5); }
        else this._killCar(hitEnt);
      }
    }
  }

  _killPed(ped, wasGang, blamePlayer = true) {
    ped.dead = true;
    ped.deadT = 0;
    ped.health = 0;
    this.particles.burst(ped.x, ped.y, 12, '#b02020', 110, 0.5, 3.6);
    if (blamePlayer) {
      this.addCrime(wasGang ? CRIME.gangKill : CRIME.hitPed, ped.x, ped.y);
      scarePeds(this, ped.x, ped.y, 200, this.player);
    }
    if (wasGang) this.audio.checkpoint();
  }

  // ---- Police pressure ------------------------------------------------------------
  _updatePolice(dt) {
    const p = this.player;
    const DESIRED = [0, 2, 3, 5, 6, 8];
    const desired = DESIRED[this.wanted] || 0;
    this.policeSpawnCd -= dt;
    const alive = this.police.filter((c) => !c.dead);
    if (alive.length < desired && this.policeSpawnCd <= 0) {
      spawnPolice(this);
      this.policeSpawnCd = 1.4;
    }
    // Despawn far units when heat is gone
    this.police = this.police.filter((car) => {
      const d = Math.hypot(car.x - p.x, car.y - p.y);
      if (this.wanted === 0 && d > 700) return false;
      if (car.dead && d > 800) return false;
      return true;
    });
    for (const car of this.police) updatePoliceCar(this, car, dt);

    // Sight & heat decay
    this.policeSeePlayer = alive.some((c) => Math.hypot(c.x - p.x, c.y - p.y) < 430);
    if (this.wanted > 0) {
      if (this.policeSeePlayer) this.unseenT = 0;
      else {
        this.unseenT += dt;
        if (this.unseenT > 3) {
          this.heat -= 5.5 * dt;
          if (this.heat <= 0) { this.clearWanted(); this.banner('Heat lost', 'You slipped the net. Lay low.'); }
          else this.wanted = Math.max(1, Math.ceil(this.heat / 100));
        }
      }
    }

    // Bust meter
    let bustPressure = false;
    if (this.wanted > 0) {
      for (const car of alive) {
        const d = Math.hypot(car.x - p.x, car.y - p.y);
        if (!p.car && d < 54) bustPressure = true;
        if (p.car && Math.abs(p.car.speed) < 26 && d < 62) bustPressure = true;
      }
    }
    if (bustPressure) {
      this.bustMeter += dt / 2.4;
      if (this.bustMeter >= 1) { this._busted(); return; }
    } else {
      this.bustMeter = Math.max(0, this.bustMeter - dt * 0.7);
    }
  }

  // ---- Collisions between moving bodies --------------------------------------------
  _carPedCollisions(active) {
    const cars = [...this.cars, ...this.police];
    if (this.player.car) cars.push(this.player.car);
    for (const car of cars) {
      if (car.dead || Math.abs(car.speed) < 30) continue;
      for (const ped of this.peds) {
        if (ped.dead) continue;
        const d = Math.hypot(ped.x - car.x, ped.y - car.y);
        if (d < car.len / 2 + 6) {
          const lethal = Math.abs(car.speed) > 120;
          ped.health -= lethal ? 100 : 30;
          ped.hurtT = 0.4;
          this.particles.burst(ped.x, ped.y, lethal ? 12 : 5, '#b02020', 130, 0.45, 3.4);
          if (ped.health <= 0) {
            // Only the player's own car earns the player the crime.
            this._killPed(ped, ped.state === 'gang', car === this.player.car);
          } else {
            ped.state = 'flee'; ped.fleeT = 3; ped.target = car;
          }
          car.speed *= 0.82;
          if (car === this.player.car) { this.audio.crash(0.4); this.cam.shake = Math.min(8, this.cam.shake + 2.5); }
        }
      }
    }
    void active;
  }

  _carCarCollisions() {
    const p = this.player;
    if (!p.car) return;
    const mine = p.car;
    for (const other of [...this.cars, ...this.police]) {
      if (other === mine || other.dead) continue;
      const d = Math.hypot(other.x - mine.x, other.y - mine.y);
      const minD = (mine.len + other.len) / 2 * 0.72;
      if (d < minD && d > 0) {
        const impact = Math.abs(mine.speed - (other.speed || 0));
        // Push apart
        const push = (minD - d) / 2;
        const ux = (mine.x - other.x) / d, uy = (mine.y - other.y) / d;
        mine.x += ux * push; mine.y += uy * push;
        other.x -= ux * push; other.y -= uy * push;
        if (impact > 60) {
          other.health -= impact * 0.05;
          mine.health -= impact * 0.04;
          this.audio.crash(Math.min(1, impact / 300));
          this.cam.shake = Math.min(10, impact * 0.028);
          this.particles.burst((mine.x + other.x) / 2, (mine.y + other.y) / 2, 8, '#ffd166', 150, 0.35, 3);
          this.addCrime(other.police ? CRIME.policeHit : CRIME.hitCar, mine.x, mine.y);
          if (other.health <= 0 && !other.dead) {
            if (other.police) { other.dead = true; other.smokeT = 2.5; }
            else this._killCar(other);
          }
          if (mine.health <= 0) this._killCar(mine, true);
        }
        mine.speed *= 0.55;
        other.speed = (other.speed || 0) * 0.4 + impact * 0.2;
      }
    }
  }

  // ==========================================================================
  // Render
  // ==========================================================================
  render() {
    this.uiButtons.length = 0; // buttons re-register below, during draw
    if (this.state === 'title') {
      drawTitle(this);
      return;
    }
    this.renderer.draw(this);
    drawHUD(this);
    if (this.state === 'dialog') drawDialog(this);
    if (['paused', 'busted', 'wasted', 'complete'].includes(this.state)) drawOverlay(this);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const game = new Game();
window.__game = game;

const params = new URLSearchParams(window.location.search);
if (params.get('shot')) {
  stageShot(game, params.get('shot'));
  let frames = 0;
  const loop = () => {
    game.update(1 / 60);
    game.render();
    frames++;
    if (frames >= 90) { window.__shotReady = true; return; }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
} else {
  let last = performance.now();
  const frame = (now) => {
    requestAnimationFrame(frame);
    let dt = Math.min(0.033, (now - last) / 1000);
    last = now;
    if (dt <= 0) dt = 0.016;
    game.update(dt);
    game.render();
  };
  requestAnimationFrame(frame);
  const status = document.getElementById('status');
  if (status) status.textContent = 'Solmara Undertow. Press Enter or click Start Engine.';
}
