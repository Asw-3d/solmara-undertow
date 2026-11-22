// ============================================================================
// SOLMARA UNDERTOW — missions.js
// The story campaign: six missions chained from the Casa Verde garage hub.
// Raka, a broke ex-courier, takes driving work from fixer Nara and mechanic
// Bimo to pay off a debt to Darma, whose dock gang runs Portside. Each
// mission: briefing dialog at the hub → objective in the world → payoff
// dialog, cash reward, autosave. Free roam continues between missions.
//
// MissionManager phases per mission: 'toStart' (gold marker at hub) →
// 'active' (objective live) → next mission. Completion/failure is reported
// through game callbacks so audio/HUD/save stay in main.js.
// ============================================================================

import { PLACES } from './config.js';

export const CHARACTERS = {
  Raka:  { color: '#ffd166' },
  Nara:  { color: '#ff5d8f' },
  Bimo:  { color: '#39d5e8' },
  Darma: { color: '#b78bff' },
  Radio: { color: '#7dff6a' },
};

export const MISSIONS = [
  {
    id: 'first-run', title: 'First Run', giver: 'Nara', reward: 250,
    start: PLACES.garage,
    intro: [
      { who: 'Nara', text: 'Raka. You owe Darma twelve grand and your courier job just vanished. Lucky for you, I have work.' },
      { who: 'Raka', text: 'Legal work, Nara? Please say legal work.' },
      { who: 'Nara', text: 'It involves driving. And a marina. And not asking questions. A package waits at Pier 9 — get there, any way you like. Walk, drive... borrow a car with E.' },
      { who: 'Bimo', text: 'Take it steady, kid. WASD to move, E to get in a car, Shift to sprint. The gold marker is your world now.' },
    ],
    objective: 'Reach Marina Pier 9',
    target: () => ({ ...PLACES.marina, r: 80 }),
    outro: [
      { who: 'Nara', text: 'Package collected. Clean and quiet — I like that. $250 wired. Come back to the garage, there is more.' },
    ],
  },
  {
    id: 'hot-wheels', title: 'Hot Wheels', giver: 'Bimo', reward: 600,
    start: PLACES.garage,
    intro: [
      { who: 'Bimo', text: 'See that gold sports car outside the Palma Grand? A collector wants it. The owner... disagrees, but he is at lunch.' },
      { who: 'Raka', text: 'So steal it. In daylight. Great plan, Bimo.' },
      { who: 'Bimo', text: 'Bring it to my garage in one piece. Oh — and I fitted your jacket with a little insurance. You have a pistol now. Mouse to aim, click to fire. Do NOT test it on civilians.' },
    ],
    objective: 'Steal the gold sports car at Palma Grand',
    target: () => ({ ...PLACES.palmaCar, r: 70 }),
    outro: [
      { who: 'Bimo', text: 'Beautiful. Not a scratch worth mentioning. $600 — Darma gets his cut, you get yours. The debt shrinks, Raka.' },
    ],
  },
  {
    id: 'palma-rush', title: 'Palma Rush', giver: 'Nara', reward: 800,
    start: PLACES.garage,
    intro: [
      { who: 'Nara', text: 'A courier crew bets nobody can run their beach-to-downtown route in under two minutes. Prove them wrong.' },
      { who: 'Raka', text: 'Five checkpoints. Through traffic. In this city?' },
      { who: 'Nara', text: 'Through traffic, yes. Hit every gold ring in order before the clock dies. A fast car helps. Stealing one is, as ever, your business.' },
    ],
    objective: 'Hit checkpoint 1 of 5',
    checkpoints: [
      { x: 900, y: 2180 }, { x: 180, y: 1560 }, { x: 1620, y: 900 },
      { x: 2340, y: 180 }, { x: 3020, y: 900 },
    ],
    timeLimit: 120,
    target: null,
    outro: [
      { who: 'Nara', text: 'Route beaten and the crew is furious. $800. Darma heard about the run, though. He is... interested in you now.' },
    ],
  },
  {
    id: 'dockside', title: 'Dockside Trouble', giver: 'Nara', reward: 1000,
    start: PLACES.garage,
    intro: [
      { who: 'Darma', text: '(phone) Raka. My dock crew says my shipments keep walking away. Four of my own men, stealing from me. Handle it.' },
      { who: 'Raka', text: 'You want me to fight your own gang? Four of them?' },
      { who: 'Darma', text: '(phone) Fists with F. That pistol of yours works too. The docks, tonight. Do not bore me.' },
      { who: 'Nara', text: 'Four men at the docks. Stay moving, use cover, eat the pain and finish it. I believe in you. Mostly.' },
    ],
    objective: 'Go to the docks',
    target: () => ({ ...PLACES.docks, r: 90 }),
    outro: [
      { who: 'Darma', text: '(phone) Done? Good. $1,000. You are almost interesting, Raka. Almost free, too.' },
    ],
  },
  {
    id: 'heat', title: 'Heat', giver: 'Bimo', reward: 1200,
    start: PLACES.garage,
    intro: [
      { who: 'Bimo', text: 'Bad news — a job went loud and Solmara PD has your face on every dashcam in the city. They are coming. Now.' },
      { who: 'Raka', text: 'Three stars of "now"?! Bimo!' },
      { who: 'Bimo', text: 'Old hideout, Portside Industrial, east side. Get there and make sure no cruiser is close enough to follow you in. Go!' },
    ],
    objective: 'Reach the Portside hideout — lose the tail first',
    target: () => ({ ...PLACES.hideout, r: 85 }),
    outro: [
      { who: 'Bimo', text: 'You are a ghost. $1,200 and the heat is off. One more job, Raka. The big one. Rest up.' },
    ],
  },
  {
    id: 'undertow', title: 'Undertow', giver: 'Nara', reward: 2500,
    start: PLACES.garage,
    intro: [
      { who: 'Nara', text: 'Last job. Darma is moving everything out of Solmara tonight — including the ledger that proves your debt is paid twice over.' },
      { who: 'Raka', text: 'And the ledger is on a boat. Of course it is on a boat.' },
      { who: 'Nara', text: 'Pier 9. The gold-trim boat. Every cop Darma owns dirt on will try to stop you — four stars, full city. Beat the tide clock, reach the boat, and you are free.' },
      { who: 'Bimo', text: 'Whatever happens out there... it has been an honour, kid. DRIVE.' },
    ],
    objective: 'Reach the boat at Pier 9 before the tide turns',
    target: () => ({ ...PLACES.marina, r: 85 }),
    timeLimit: 150,
    outro: [
      { who: 'Nara', text: 'The ledger is ours, the debt is dead, and Darma is finished in Solmara. $2,500, Raka. You are free.' },
      { who: 'Raka', text: 'Free. Sun is coming up over the bay... I think I will stay in Solmara after all. On my own terms this time.' },
    ],
  },
];

export class MissionManager {
  constructor() {
    this.index = 0;           // current mission index (== MISSIONS.length when campaign done)
    this.phase = 'toStart';   // toStart | active | campaignDone
    this.stage = 0;           // sub-objective stage inside a mission
    this.timer = 0;           // countdown for timed missions (0 = none)
    this.checkpoint = 0;      // M3 progress
    this.gangSpawned = false; // M4
    this.totalEarned = 0;
  }

  get current() { return this.index < MISSIONS.length ? MISSIONS[this.index] : null; }

  // The world-space marker the HUD/minimap should show right now.
  marker() {
    const m = this.current;
    if (!m) return null;
    if (this.phase === 'toStart') return { x: m.start.x, y: m.start.y, r: 60, kind: 'start', label: m.title };
    if (m.id === 'palma-rush') {
      const cp = m.checkpoints[this.checkpoint];
      return cp ? { x: cp.x, y: cp.y, r: 55, kind: 'checkpoint', label: `Checkpoint ${this.checkpoint + 1}` } : null;
    }
    if (m.id === 'hot-wheels' && this.stage >= 1) return { x: PLACES.garage.x, y: PLACES.garage.y, r: 85, kind: 'objective', label: 'Deliver to garage' };
    const t = m.target ? m.target() : null;
    return t ? { ...t, kind: 'objective', label: m.objective } : null;
  }

  objectiveText() {
    const m = this.current;
    if (!m) return 'Free roam — Solmara is yours.';
    if (this.phase === 'toStart') return `Meet ${m.giver} at the garage — "${m.title}"`;
    if (m.id === 'palma-rush') return `Hit checkpoint ${this.checkpoint + 1} of 5 — ${Math.max(0, Math.ceil(this.timer))}s`;
    if (m.id === 'hot-wheels') return this.stage === 0 ? 'Steal the gold sports car at Palma Grand' : 'Deliver the gold car to Bimo\'s garage';
    if (m.id === 'dockside') return this.gangSpawned ? `Defeat Darma's crew — ${this.gangAlive} left` : 'Go to the docks';
    if (m.id === 'undertow') return `Reach the boat at Pier 9 — ${Math.max(0, Math.ceil(this.timer))}s`;
    return m.objective;
  }

  gangAlive = 0;

  // Begin the briefing dialog for the current mission.
  beginBriefing(game) {
    const m = this.current;
    if (!m) return;
    game.startDialog(m.intro, () => this.activate(game));
  }

  activate(game) {
    const m = this.current;
    this.phase = 'active';
    this.stage = 0;
    this.checkpoint = 0;
    this.gangSpawned = false;
    if (m.timeLimit) this.timer = m.timeLimit; else this.timer = 0;
    if (m.id === 'heat') game.setWanted(3, true);      // police descend at once
    if (m.id === 'undertow') game.setWanted(4, true);
    if (m.id === 'hot-wheels') game.unlockPistol();
    game.banner(`${m.title}`, m.objective);
    game.saveGame();
  }

  complete(game) {
    const m = this.current;
    if (!m) return;
    this.totalEarned += m.reward;
    game.addMoney(m.reward, m.start.x, m.start.y - 30);
    game.audio.sting(true);
    const next = () => {
      this.index += 1;
      this.phase = this.current ? 'toStart' : 'campaignDone';
      this.timer = 0;
      game.saveGame();
      if (!this.current) game.onCampaignComplete(this.totalEarned);
      else game.banner('Mission passed', `"${this.current.title}" is waiting at the garage`);
    };
    game.startDialog(m.outro, next);
  }

  fail(game, reason) {
    const m = this.current;
    game.audio.sting(false);
    this.phase = 'toStart';
    this.timer = 0;
    this.gangSpawned = false;
    game.banner('Mission failed', reason + ' — return to the garage to retry');
    game.clearWanted();
    game.saveGame();
  }

  // Per-frame logic. Called only while phase === 'active'.
  update(game, dt) {
    const m = this.current;
    if (!m || this.phase !== 'active') return;
    const p = game.player;

    if (this.timer > 0) {
      this.timer -= dt;
      if (this.timer <= 0) { this.fail(game, 'Out of time'); return; }
    }

    const near = (t, r) => Math.hypot(p.x - t.x, p.y - t.y) < r;

    switch (m.id) {
      case 'first-run': {
        if (near(PLACES.marina, 80)) this.complete(game);
        break;
      }
      case 'hot-wheels': {
        const targetCar = game.cars.find((c) => c.missionTarget);
        if (this.stage === 0) {
          if (targetCar && p.car === targetCar) { this.stage = 1; game.banner('Hot Wheels', 'Deliver the gold car to Bimo\'s garage'); game.audio.checkpoint(); }
          else if (targetCar && targetCar.dead) { // wrecked before delivery: Bimo "finds another"
            targetCar.dead = false; targetCar.health = 100; targetCar.x = PLACES.palmaCar.x; targetCar.y = PLACES.palmaCar.y; targetCar.speed = 0; targetCar.parked = true;
            game.banner('Hot Wheels', 'Bimo sourced a replacement — back to Palma Grand');
          }
        } else if (this.stage === 1) {
          if (targetCar && targetCar.dead) { this.fail(game, 'The gold car was destroyed'); break; }
          if (p.car === targetCar && near(PLACES.garage, 95)) this.complete(game);
        }
        break;
      }
      case 'palma-rush': {
        const cp = m.checkpoints[this.checkpoint];
        if (cp && near(cp, 60)) {
          this.checkpoint += 1;
          game.audio.checkpoint();
          game.particles.burst(cp.x, cp.y, 16, '#ffd166', 150, 0.6, 4);
          if (this.checkpoint >= m.checkpoints.length) this.complete(game);
          else game.banner('Palma Rush', `Checkpoint ${this.checkpoint + 1} of 5`);
        }
        break;
      }
      case 'dockside': {
        if (!this.gangSpawned && near(PLACES.docks, 110)) {
          this.gangSpawned = true;
          this.gangAlive = game.spawnGang(PLACES.docks);
          game.banner('Dockside Trouble', 'Darma\'s crew — take them down!');
          game.setWanted(Math.max(game.wanted, 1));
        }
        if (this.gangSpawned) {
          this.gangAlive = game.peds.filter((x) => x.state === 'gang' && !x.dead).length;
          if (this.gangAlive <= 0) this.complete(game);
        }
        break;
      }
      case 'heat': {
        if (near(PLACES.hideout, 85)) {
          const copNear = game.police.some((c) => !c.dead && Math.hypot(c.x - p.x, c.y - p.y) < 230);
          if (!copNear) { game.clearWanted(); this.complete(game); }
          else if (!this._hideoutWarned || game.time - this._hideoutWarned > 4) {
            this._hideoutWarned = game.time;
            game.banner('Heat', 'Too many cruisers close — lose them first!');
          }
        }
        break;
      }
      case 'undertow': {
        if (near(PLACES.marina, 85)) { game.clearWanted(); this.complete(game); }
        break;
      }
    }
  }

  serialize() {
    return { index: this.index, phase: this.phase === 'active' ? 'toStart' : this.phase, totalEarned: this.totalEarned };
  }
  deserialize(data) {
    if (!data) return;
    this.index = Math.min(data.index || 0, MISSIONS.length);
    this.phase = this.index >= MISSIONS.length ? 'campaignDone' : 'toStart';
    this.totalEarned = data.totalEarned || 0;
  }
}
