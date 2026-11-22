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

import { WORLD, PLACES, SAVE_KEY, CRIME, CAR_TYPES, WEAPONS, WEAPON_ORDER, rankFor, districtAt } from './config.js';
import { RNG } from './random.js';
import { generateWorld, collideCircle, carCollides, inWater } from './world.js';
import { Input } from './input.js';
import { AudioSys, RADIO_STATIONS } from './audio.js';
import {
  spawnTrafficCar, spawnParkedCars, spawnPeds, makePed, makeCar,
  updateTrafficCar, updatePoliceCar, spawnPolice, updatePed,
  scarePeds, Particles, updateHeli, spawnRoadblockAhead, removeRoadblock,
  clearRoadblocks, updateRacer,
} from './entities.js';
import { MissionManager } from './missions.js';
import { Renderer } from './render.js';
import { Renderer3D } from './render3d.js';
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
    // 3D is the default view; ?flat=1 (or no WebGL) keeps the v1 renderer.
    const glCanvas = document.getElementById('gl');
    this.renderer3d = null;
    if (glCanvas && params.get('flat') !== '1') {
      const r3 = new Renderer3D(glCanvas);
      if (r3.ok) this.renderer3d = r3;
    }
    if (!this.renderer3d && glCanvas) glCanvas.style.display = 'none';
    this._dt = 0.016;

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
    // Phase-2 systems: weapon slots, garage upgrades, radio, air unit,
    // roadblocks, world pickups.
    this.weapons = {
      owned: { pistol: false, smg: false, shotgun: false },
      ammo: { smg: 0, shotgun: 0 },
      current: 'pistol',
    };
    this.upgrades = { armor: false, nitro: false };
    this.nitroMeter = 100;
    this.radioStation = -1; // -1 off, else index into RADIO_STATIONS
    this.heli = null;
    this.roadblocks = [];
    this.roadblockCd = 0;
    this.pickups = [];
    this.hotMetalCar = null;

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
    clearRoadblocks(this);
    this.roadblocks = [];
    this.hotMetalCar = null;
    this._resetPickups();
  }

  // World weapon pickups: SMG at the port warehouse, shotgun behind the
  // Portside plant. Ammo drops are added dynamically by _killPed.
  _resetPickups() {
    this.pickups = [
      { kind: 'smg', x: PLACES.smgPickup.x, y: PLACES.smgPickup.y, taken: !!this.weapons.owned.smg, dynamic: false },
      { kind: 'shotgun', x: PLACES.shotgunPickup.x, y: PLACES.shotgunPickup.y, taken: !!this.weapons.owned.shotgun, dynamic: false },
    ];
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
    if (snap && this.renderer3d) this.renderer3d.snapCamera();
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
    if (!this.weapons.owned.pistol) {
      this.weapons.owned.pistol = true;
      if (!this.weapons.owned[this.weapons.current]) this.weapons.current = 'pistol';
      this._syncWeaponFlags();
      this.banner('Pistol acquired', 'Mouse to aim — click to shoot · slots 1/2/3 + wheel');
    }
  }

  // hasPistol stays as the renderers' "player is armed" flag: any slot.
  _syncWeaponFlags() {
    const w = this.weapons;
    if (!w.owned[w.current]) {
      w.current = WEAPON_ORDER.find((k) => w.owned[k]) || 'pistol';
    }
    this.hasPistol = WEAPON_ORDER.some((k) => w.owned[k]);
  }

  hasWeapon() { return this.hasPistol; }

  rank() { return rankFor(this.missions.totalEarned); }

  _switchWeapon(key) {
    const w = this.weapons;
    let target = null;
    if (WEAPON_ORDER.includes(key)) {
      if (w.owned[key]) target = key;
    } else { // dir: +1 / -1 cycle through owned slots
      const owned = WEAPON_ORDER.filter((k) => w.owned[k]);
      if (owned.length > 1) {
        const i = owned.indexOf(w.current);
        target = owned[(i + key + owned.length) % owned.length];
      }
    }
    if (target && target !== w.current) {
      w.current = target;
      this.audio.switchWeapon();
      this.particles.spawn(this.player.x, this.player.y - 26, {
        text: WEAPONS[target].name, color: '#ffd166', life: 0.8, rise: 22, vx: 0, vy: 0, size: 13,
      });
    }
  }

  _collectPickup(pk) {
    pk.taken = true;
    this.audio.pickup();
    const w = this.weapons;
    if (pk.kind === 'smg') {
      w.owned.smg = true; w.ammo.smg += 120; w.current = 'smg';
      this.banner('SMG acquired', 'Slot 2 — fast fire, wide spread · ammo from fallen gang');
    } else if (pk.kind === 'shotgun') {
      w.owned.shotgun = true; w.ammo.shotgun += 24; w.current = 'shotgun';
      this.banner('Shotgun acquired', 'Slot 3 — five pellets, short range, big stop');
    } else if (pk.kind === 'ammo') {
      let gained = [];
      if (w.owned.smg) { w.ammo.smg += 40; gained.push('+40 SMG'); }
      if (w.owned.shotgun) { w.ammo.shotgun += 6; gained.push('+6 shells'); }
      if (!gained.length) { this.addMoney(20, pk.x, pk.y - 16); gained.push('sold scraps +$20'); }
      this.particles.spawn(pk.x, pk.y - 22, { text: gained.join(' · '), color: '#7dff6a', life: 1.1, rise: 26, vx: 0, vy: 0, size: 13 });
    }
    this._syncWeaponFlags();
    this.saveGame();
  }

  _updatePickups() {
    const p = this.player;
    if (p.car) return;
    for (const pk of this.pickups) {
      if (pk.taken) continue;
      if (Math.hypot(p.x - pk.x, p.y - pk.y) < 30) this._collectPickup(pk);
    }
  }

  spawnGang(place, count = 4) {
    const spots = [[-46, -30], [40, -44], [-30, 42], [52, 30], [6, -64]];
    let n = 0;
    for (const [dx, dy] of spots.slice(0, count)) {
      const ped = makePed(this.rng, place.x + dx, place.y + dy, { state: 'gang', health: 100 });
      ped.home = { x: place.x + dx, y: place.y + dy };
      this.peds.push(ped);
      n++;
    }
    return n;
  }

  // M7's nitro burner: a loud orange sports car waiting on Beachfront Ave.
  spawnHotMetalCar() {
    if (this.hotMetalCar && !this.hotMetalCar.dead) return this.hotMetalCar;
    const car = makeCar(this.rng, 'sports', PLACES.hotMetalCar.x, PLACES.hotMetalCar.y, 0);
    car.color = '#ff7a1a';
    car.parked = true;
    car.nav = null;
    this.cars.push(car);
    this.hotMetalCar = car;
    return car;
  }

  // Street-race rivals (missions.js owns the race state; these are the
  // world-side factories it calls).
  spawnRaceRivals() {
    const specs = [
      { type: 'sports', color: '#e63946', x: 452, y: 2207, skill: 0.86 },
      { type: 'sedan', color: '#12c2e0', x: 548, y: 2153, skill: 0.80 },
    ];
    const rivals = [];
    for (const s of specs) {
      const car = makeCar(this.rng, s.type, s.x, s.y, 0);
      car.color = s.color;
      car.nav = null;
      car.parked = false;
      car.racer = true;
      car.raceCp = 0;
      car.raceDone = false;
      car.raceSkill = s.skill;
      this.cars.push(car);
      rivals.push(car);
    }
    return rivals;
  }

  updateRacer(car, dt) { updateRacer(this, car, dt); }

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
        weapons: {
          owned: { ...this.weapons.owned },
          ammo: { ...this.weapons.ammo },
          current: this.weapons.current,
        },
        upgrades: { ...this.upgrades },
        radioStation: this.radioStation,
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
    if (data.weapons) {
      this.weapons.owned = { pistol: false, smg: false, shotgun: false, ...data.weapons.owned };
      this.weapons.ammo = { smg: 0, shotgun: 0, ...data.weapons.ammo };
      this.weapons.current = data.weapons.current || 'pistol';
    } else if (data.hasPistol) {
      this.weapons.owned.pistol = true;
    }
    this._syncWeaponFlags();
    this.upgrades = { armor: false, nitro: false, ...(data.upgrades || {}) };
    this.radioStation = typeof data.radioStation === 'number' ? data.radioStation : -1;
    this.dayT = data.dayT ?? 0.715;
    this.storyComplete = !!data.storyComplete;
    this.clearWanted();
    this._resetPickups();
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
    this.weapons = {
      owned: { pistol: false, smg: false, shotgun: false },
      ammo: { smg: 0, shotgun: 0 },
      current: 'pistol',
    };
    this._syncWeaponFlags();
    this.upgrades = { armor: false, nitro: false };
    this.nitroMeter = 100;
    this.radioStation = -1;
    this.audio.setRadio(-1);
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
    this._dt = dt;
    // NOTE: uiButtons is filled by render() each frame and consumed here on
    // the *next* update — do not clear it in update or clicks never land.
    if (this.renderer3d) {
      // 3D aim: unproject the cursor through the chase camera onto the
      // ground plane (uses last frame's camera basis — one frame of lag,
      // imperceptible and stable). Falls back to the top-down mapping
      // before the first rendered frame.
      const g = this.renderer3d.screenToGround(this.input.mouse.x, this.input.mouse.y);
      if (g) { this.mouseWorld.x = g.x; this.mouseWorld.y = g.y; }
      else { this.mouseWorld.x = this.input.mouse.x + this.cam.x; this.mouseWorld.y = this.input.mouse.y + this.cam.y; }
    } else {
      this.mouseWorld.x = this.input.mouse.x + this.cam.x;
      this.mouseWorld.y = this.input.mouse.y + this.cam.y;
    }
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
      case 'garage':
        this._updateAmbient(dt);
        if (this.input.pressed('Escape')) this.state = 'playing';
        else this._updateOverlayInput();
        break;
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
    // The title backdrop (3D orbit vista, or the painted vista in flat
    // mode) is handled at render time; keep world entities breathing here.
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
      case 'garage-close': this.state = 'playing'; break;
      case 'garage-repair': this._garageBuy('repair'); break;
      case 'garage-armor': this._garageBuy('armor'); break;
      case 'garage-respray': this._garageBuy('respray'); break;
      case 'garage-nitro': this._garageBuy('nitro'); break;
    }
  }

  // The car a garage service applies to: the one Raka sits in, else the
  // nearest live car within reach of the garage forecourt.
  serviceCar() {
    if (this.player.car) return this.player.car;
    let best = null, bd = 110;
    for (const c of [...this.cars, ...this.police]) {
      if (c.dead) continue;
      const d = Math.hypot(c.x - this.player.x, c.y - this.player.y);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  _garageBuy(kind) {
    const car = this.serviceCar();
    const done = (msg) => { this.audio.pickup(); this.banner('Bimo\'s Garage', msg); this.saveGame(); };
    if (kind === 'repair') {
      if (!car) { this.banner('Bimo\'s Garage', 'No car in reach — bring one to the forecourt'); return; }
      if (this.money < 100) { this.banner('Bimo\'s Garage', 'Repair is $100 — you are short'); return; }
      this.money -= 100;
      car.health = car.maxHealth || 100;
      car.smokeT = 0;
      done(`Repaired — ${car.type} back to full health`);
    } else if (kind === 'armor') {
      if (this.upgrades.armor) return;
      if (this.money < 300) { this.banner('Bimo\'s Garage', 'Armor plating is $300 — you are short'); return; }
      this.money -= 300;
      this.upgrades.armor = true;
      if (car) this._applyArmor(car);
      done('Armor plating fitted — your cars take +50 max HP');
    } else if (kind === 'respray') {
      if (!car) { this.banner('Bimo\'s Garage', 'No car in reach — bring one to the forecourt'); return; }
      if (this.money < 50) { this.banner('Bimo\'s Garage', 'Respray is $50 — you are short'); return; }
      this.money -= 50;
      const colors = ['#ff3860', '#12c2e0', '#7dff6a', '#ffb340', '#b78bff', '#f5f0e6', '#e63946', '#2a9d8f'];
      let next = car.color;
      while (next === car.color) next = colors[Math.floor(Math.random() * colors.length)];
      car.color = next;
      done('Fresh paint — the PD description just went stale');
    } else if (kind === 'nitro') {
      if (this.upgrades.nitro) return;
      if (this.money < 400) { this.banner('Bimo\'s Garage', 'Nitro kit is $400 — you are short'); return; }
      this.money -= 400;
      this.upgrades.nitro = true;
      this.nitroMeter = 100;
      done('Nitro fitted — hold Shift while driving to boost');
    }
  }

  _applyArmor(car) {
    if (car.armorApplied) return;
    car.armorApplied = true;
    car.maxHealth = 150;
    car.health = Math.min(150, car.health + 50);
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

    // Weapon slot switching: keys 1/2/3 + mouse wheel.
    if (this.input.pressed('Digit1')) this._switchWeapon('pistol');
    if (this.input.pressed('Digit2')) this._switchWeapon('smg');
    if (this.input.pressed('Digit3')) this._switchWeapon('shotgun');
    if (this.input.wheel !== 0) this._switchWeapon(Math.sign(this.input.wheel));

    // World life
    for (const car of this.cars) updateTrafficCar(this, car, dt);
    for (const ped of this.peds) updatePed(this, ped, dt);
    this._updatePolice(dt);
    updateHeli(this, dt);
    this._updateRoadblocks(dt);
    this._carPedCollisions(true);
    this._carCarCollisions();
    this.particles.update(dt);

    // Car damage smoke/fire + the burn fuse on wrecked cars
    const allCars = [...this.cars, ...this.police];
    if (p.car) allCars.push(p.car);
    for (const car of allCars) {
      if (car.burning > 0) {
        car.burning -= dt;
        if (Math.random() < dt * 22) {
          this.particles.spawn(car.x + (Math.random() - 0.5) * 16, car.y - 10, {
            vx: (Math.random() - 0.5) * 16, vy: -40 - Math.random() * 26,
            life: 0.55, size: 7, color: Math.random() < 0.5 ? '#ff7a1a' : '#ffb340', drag: 0.98,
          });
        }
        if (car.burning <= 0) this.explodeCar(car);
        continue;
      }
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
        if (!this.promptText) this.promptText = 'Get out of the car to talk';
      }
    } else if (this.missions.phase === 'active') {
      this.missions.update(this, dt);
    }
    if (this.missions.raceActive) this.missions.updateRace(this, dt);
    this._updatePickups();

    // Audio beds
    const speedRatio = p.car ? Math.abs(p.car.speed) / (CAR_TYPES[p.car.type].maxSpeed) : 0;
    this.audio.engine(speedRatio, !!p.car);
    const nearestCop = this.police.filter((c) => !c.dead).reduce((m, c) => Math.min(m, Math.hypot(c.x - p.x, c.y - p.y)), Infinity);
    this.audio.siren(this.wanted > 0 ? Math.max(0, 1 - nearestCop / 620) : 0);
    // Radio only makes sense behind the wheel; the sequencer idles otherwise.
    if (this.audio.ctx) {
      const want = p.car && this.radioStation >= 0 ? this.radioStation : -1;
      if (this.audio.radioIdx !== want) this.audio.setRadio(want);
      this.audio.radioTick();
    }

    this._centerCam(false);
  }

  // Roadblocks: PD throws them across the road ahead of a fleeing driver
  // at 3+ stars; they clear when the chase dies or the driver leaves them
  // far behind.
  _updateRoadblocks(dt) {
    this.roadblockCd -= dt;
    if (this.wanted < 3) {
      if (this.roadblocks.length) clearRoadblocks(this);
      return;
    }
    const p = this.player;
    for (const rb of [...this.roadblocks]) {
      if (Math.hypot(rb.x - p.x, rb.y - p.y) > 780) removeRoadblock(this, rb);
    }
    if (p.car && Math.abs(p.car.speed) > 70 && this.roadblocks.length < 2 && this.roadblockCd <= 0) {
      if (spawnRoadblockAhead(this)) this.roadblockCd = 7;
    }
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
      p.angle = this.hasWeapon()
        ? Math.atan2(this.mouseWorld.y - p.y, this.mouseWorld.x - p.x)
        : Math.atan2(my, mx);
      let nx = p.x + mx * speed * dt;
      let ny = p.y + my * speed * dt;
      if (inWater(this.world, nx, p.y)) nx = p.x;
      if (inWater(this.world, p.x, ny)) ny = p.y;
      const fix = collideCircle(this.world, nx, ny, 10);
      p.x = fix.x; p.y = fix.y;
      p.walkPhase += dt * (sprint ? 11 : 8);
    } else if (this.hasWeapon()) {
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
    // Rio's street race (Palma Beach) outranks the car prompt when close.
    const rio = this.peds.find((x) => x.name === 'Rio' && !x.dead);
    if (rio && !this.missions.raceActive && Math.hypot(rio.x - p.x, rio.y - p.y) < 58) {
      this.promptText = 'E — Street race vs Rio\'s crew ($400 prize)';
      if (this.input.pressed('KeyE')) {
        this.startDialog([
          { who: 'Rio', text: 'Raka, right? Word travels. My crew runs the beach loop — six rings, two of my best drivers. First home takes $400.' },
          { who: 'Raka', text: 'And if I lose?' },
          { who: 'Rio', text: 'Then you walk home poorer in pride only. Bring any car you like. Borrowed is traditional.' },
        ], () => this.missions.startRace(this));
        return;
      }
    }
    if (nearestCar && this.input.pressed('KeyE')) { this._enterCar(nearestCar); return; }

    // Melee
    if (this.input.pressed('KeyF') && p.punchCd <= 0) this._punch();
    // Shooting
    if (this.hasWeapon() && this.input.mouse.down && p.fireCd <= 0) this._shoot();
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
    if (this.upgrades.armor) this._applyArmor(car);
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

    // Radio: R cycles off → Neon FM → Palma Lo-Fi → News → off.
    if (this.input.pressed('KeyR')) {
      this.audio.init();
      this.radioStation = this.radioStation >= 2 ? -1 : this.radioStation + 1;
      const name = this.radioStation < 0 ? 'Radio off' : `♪ ${RADIO_STATIONS[this.radioStation].name} — ${RADIO_STATIONS[this.radioStation].desc}`;
      this.particles.spawn(car.x, car.y - 30, { text: name, color: '#39d5e8', life: 1.2, rise: 20, vx: 0, vy: 0, size: 14 });
    }

    // Nitro (garage upgrade): Shift burns the meter for boost, which
    // refills slowly whenever the pedal is off the boost.
    const boosting = this.upgrades.nitro && this.input.down('ShiftLeft', 'ShiftRight') && fwd && this.nitroMeter > 1;
    if (boosting) {
      this.nitroMeter = Math.max(0, this.nitroMeter - 34 * dt);
      car.speed += spec.accel * 1.15 * dt;
      if (Math.random() < dt * 20) {
        this.particles.spawn(car.x - Math.cos(car.angle) * car.len * 0.55, car.y - Math.sin(car.angle) * car.len * 0.55 - 4, {
          vx: -Math.cos(car.angle) * 60, vy: -Math.sin(car.angle) * 60,
          life: 0.3, size: 5, color: '#39d5e8', drag: 0.95,
        });
      }
    } else {
      this.nitroMeter = Math.min(100, this.nitroMeter + 11 * dt);
    }
    const topSpeed = spec.maxSpeed * (boosting ? 1.32 : 1);

    if (fwd) car.speed += spec.accel * dt;
    else if (back) car.speed -= (car.speed > 8 ? 330 : spec.accel * 0.55) * dt;
    // Drag + rolling resistance
    car.speed -= car.speed * 0.55 * dt;
    if (hand) car.speed -= car.speed * 2.4 * dt;
    car.speed = Math.max(-spec.maxSpeed * 0.38, Math.min(topSpeed, car.speed));

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
    // Roadblock barriers are solid: bounce off with a crunch.
    for (const rb of this.roadblocks) {
      const d = Math.hypot(car.x - rb.x, car.y - rb.y);
      if (d < 54 && d > 0.01) {
        const impact = Math.abs(car.speed);
        if (impact > 90) {
          car.health -= (impact - 80) * 0.05;
          this.audio.crash(Math.min(1, impact / 300));
          this.cam.shake = Math.min(10, impact * 0.03);
          this.particles.burst(car.x, car.y, 9, '#ffd166', 150, 0.35, 3);
          if (car.health <= 0) this._killCar(car, true);
        }
        car.x = rb.x + ((car.x - rb.x) / d) * 54;
        car.y = rb.y + ((car.y - rb.y) / d) * 54;
        car.speed *= -0.25;
      }
    }
    car.x = Math.max(30, Math.min(WORLD.w - 30, car.x));
    car.y = Math.max(30, Math.min(WORLD.h - 20, car.y));

    // Bimo's forecourt: E opens the service menu instead of exiting.
    if (Math.hypot(car.x - PLACES.garage.x, car.y - PLACES.garage.y) < 100) {
      this.promptText = 'E — Bimo\'s Garage services';
      if (this.input.pressed('KeyE') && Math.abs(car.speed) < 60) { this.state = 'garage'; return; }
    }

    if (this.input.pressed('KeyE') && Math.abs(car.speed) < 60) this._exitCar();
    if (this.hasWeapon() && this.input.mouse.down && p.fireCd <= 0) this._shoot(true);
  }

  // ---- Burning & exploding cars ------------------------------------------------
  // A car at 0 HP does not vanish: it catches fire (burning = fuse seconds),
  // then explodes — area damage that can chain neighbouring cars into their
  // own fuses. The wreck stays on the street afterwards.
  startBurn(car, fuse = null) {
    if (!car || car.dead || car.burning || car.exploded) return;
    car.burning = fuse ?? (car.police ? 1.15 : 1.6);
    car.speed = 0;
    if (this.player.car === car) {
      // Burning alive is not a driving state: Raka bails out.
      this.player.car = null;
      this.player.x = car.x + 30; this.player.y = car.y + 14;
      this.damagePlayer(6);
    }
    this.particles.burst(car.x, car.y, 14, '#ff7a1a', 150, 0.6, 4);
  }

  explodeCar(car) {
    if (car.exploded) return;
    car.exploded = true;
    car.burning = 0;
    car.dead = true;
    car.smokeT = 2.5;
    car.speed = 0;
    this.audio.explosion();
    this.particles.burst(car.x, car.y, 42, '#ff7a1a', 260, 0.9, 6);
    this.particles.burst(car.x, car.y, 26, '#ffd166', 200, 0.6, 4);
    this.particles.burst(car.x, car.y, 22, '#444444', 110, 1.6, 8);
    for (let i = 0; i < 5; i++) this.particles.addMark(car.x + (Math.random() - 0.5) * 34, car.y + (Math.random() - 0.5) * 34, Math.random() * 3);
    const dP = Math.hypot(this.player.x - car.x, this.player.y - car.y);
    this.cam.shake = Math.min(13, Math.max(this.cam.shake, 14 - dP * 0.02));
    // Area damage: nearby cars take a heavy hit (and may chain-burn),
    // peds are thrown down, the player is hurt unless shielded by distance.
    for (const other of [...this.cars, ...this.police]) {
      if (other === car || other.dead) continue;
      const d = Math.hypot(other.x - car.x, other.y - car.y);
      if (d < 105) {
        // Point-blank wrecks are killed outright (that is what makes
        // chains); further out the blast only wounds.
        other.health -= d < 62 ? 115 : 55;
        if (other.health <= 0) this.startBurn(other, 0.45 + Math.random() * 0.5);
      }
    }
    for (const ped of this.peds) {
      if (ped.dead) continue;
      const d = Math.hypot(ped.x - car.x, ped.y - car.y);
      if (d < 82) {
        ped.health -= 75;
        if (ped.health <= 0) this._killPed(ped, ped.state === 'gang', false);
        else { ped.state = 'flee'; ped.fleeT = 3; ped.target = car; }
      }
    }
    if (!this.player.car && dP < 80) this.damagePlayer(24, car.x, car.y);
    if (this.player.car && this.player.car !== car) {
      const dc = Math.hypot(this.player.car.x - car.x, this.player.car.y - car.y);
      if (dc < 100) { this.player.car.health -= 30; this.damagePlayer(8, car.x, car.y); }
    }
    if (this.crimeWitnessed(car.x, car.y)) this.addCrime(30, car.x, car.y);
  }

  _killCar(car, eject = false) {
    // Legacy entry point (wall impacts, rams): death now means burn first.
    void eject;
    this.startBurn(car);
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
    const key = this.weapons.current;
    const w = WEAPONS[key];
    if (!w || !this.weapons.owned[key]) return;
    // Ammo pools: SMG rounds and shotgun shells are finite.
    if (key === 'smg' || key === 'shotgun') {
      if (this.weapons.ammo[key] <= 0) {
        p.fireCd = 0.3;
        this.audio.empty();
        this._switchWeapon('pistol');
        return;
      }
      this.weapons.ammo[key] -= 1;
    }
    p.fireCd = w.cd;
    p.muzzle = 0.055;
    this.lastShotAt = this.time;
    if (key === 'smg') this.audio.smgShoot();
    else if (key === 'shotgun') this.audio.shotgunShoot();
    else this.audio.shoot();
    const origin = fromCar && p.car ? p.car : p;
    const baseAng = Math.atan2(this.mouseWorld.y - origin.y, this.mouseWorld.x - origin.x);
    if (!fromCar) p.angle = baseAng;
    this.addCrime(CRIME.shoot, origin.x, origin.y);
    scarePeds(this, origin.x, origin.y, 230, p);
    for (let i = 0; i < w.pellets; i++) {
      const ang = baseAng + (w.spread ? (Math.random() - 0.5) * 2 * w.spread : 0);
      this._fireRay(origin, ang, w);
    }
  }

  // One hitscan ray for the current weapon spec (a shotgun fires five).
  _fireRay(origin, ang, w) {
    const p = this.player;
    const maxRange = w.range;
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
      if (car === p.car || car.dead || car.burning) continue;
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
    if (blockT <= bestT) {
      this.particles.burst(ex, ey, 3, '#ffd166', 80, 0.2, 2);
      return;
    }
    if (!hitEnt) return;
    if (hitKind === 'ped') {
      hitEnt.health -= w.dmg;
      hitEnt.hurtT = 0.3;
      this.particles.burst(hitEnt.x, hitEnt.y - 4, 6, '#e63946', 100, 0.35, 3);
      if (hitEnt.health <= 0) this._killPed(hitEnt, hitEnt.state === 'gang');
      else if (hitEnt.state !== 'gang') { hitEnt.state = 'flee'; hitEnt.fleeT = 3; hitEnt.target = p; }
    } else if (hitKind === 'car') {
      hitEnt.health -= w.carDmg;
      this.particles.burst(ex, ey, 5, '#ffd166', 120, 0.25, 2.4);
      if (hitEnt.police) this.addCrime(CRIME.policeHit, hitEnt.x, hitEnt.y);
      if (hitEnt.health <= 0 && !hitEnt.dead) this.startBurn(hitEnt);
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
    if (wasGang) {
      this.audio.checkpoint();
      // Fallen gang members drop ammo for the taking (~45%).
      if (Math.random() < 0.45) {
        this.pickups.push({ kind: 'ammo', x: ped.x + 8, y: ped.y + 6, taken: false, dynamic: true });
      }
    }
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

    // Sight & heat decay — AIR-1's searchlight counts as being seen.
    this.policeSeePlayer = alive.some((c) => Math.hypot(c.x - p.x, c.y - p.y) < 430)
      || !!(this.heli && this.heli.active && this.heli.spots);
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
          if (other.health <= 0 && !other.dead) this.startBurn(other);
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
      // 3D: the orbiting city vista renders on the GL canvas; drawTitle
      // then paints only its text/menu layer onto the overlay canvas.
      if (this.renderer3d) {
        this.renderer3d.draw(this);
        this.ctx.clearRect(0, 0, VIEW_W, VIEW_H);
      }
      drawTitle(this);
      return;
    }
    if (this.renderer3d) {
      this.renderer3d.draw(this);
      const { ctx } = this;
      ctx.clearRect(0, 0, VIEW_W, VIEW_H);
      drawHUD(this);
      if (this.state === 'dialog') drawDialog(this);
      if (['paused', 'busted', 'wasted', 'complete', 'garage'].includes(this.state)) drawOverlay(this);
      if (this.weather === 'rain') this._rainOverlay();
      if (this.player.health < 35 && this.state === 'playing') {
        const g = ctx.createRadialGradient(VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.32, VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.75);
        g.addColorStop(0, 'rgba(180,0,0,0)');
        g.addColorStop(1, `rgba(180,0,0,${0.35 + 0.12 * Math.sin(this.time * 6)})`);
        ctx.fillStyle = g; ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      }
      return;
    }
    this.renderer.draw(this);
    drawHUD(this);
    if (this.state === 'dialog') drawDialog(this);
    if (['paused', 'busted', 'wasted', 'complete', 'garage'].includes(this.state)) drawOverlay(this);
  }

  // Rain streaks on the overlay canvas in 3D mode (the 2D renderer draws
  // its own in world space; this is the same storm, screen-space).
  _rainOverlay() {
    const { ctx } = this;
    ctx.strokeStyle = 'rgba(180,210,255,0.35)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let i = 0; i < 90; i++) {
      const x = ((i * 149 + this.time * 620) % (VIEW_W + 80)) - 40;
      const y = ((i * 271 + this.time * 980) % (VIEW_H + 60)) - 30;
      ctx.moveTo(x, y); ctx.lineTo(x - 5, y + 15);
    }
    ctx.stroke();
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
