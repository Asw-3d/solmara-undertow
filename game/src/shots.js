// ============================================================================
// SOLMARA UNDERTOW — shots.js
// Deterministic screenshot staging behind ?shot=start|play|drive|chase|
// mission|end (with &seed=N). Each scene arranges the real game state —
// player, vehicles, police, dialog, HUD — at golden hour so the captured
// frame is a true render of the game at its most characteristic. main.js
// runs ~90 frames of the real loop after staging, then sets
// window.__shotReady so the capture tool knows the frame is settled.
// Scenes are staged for the 3D chase camera (render3d.js): the subject
// stands in open road corridors with the action ahead of the lens, never
// backed into a tower's blind spot.
// ============================================================================

import { PLACES } from './config.js';
import { makeCar, spawnRoadblock } from './entities.js';
import { MISSIONS } from './missions.js';

function placePlayer(game, x, y, angle) {
  game.player.x = x; game.player.y = y; game.player.angle = angle;
  game.player.car = null;
}

function stageCar(game, type, x, y, angle, speed, color) {
  const car = makeCar(game.rng, type, x, y, angle);
  car.speed = speed;
  car.parked = false;
  car.nav = null;
  if (color) car.color = color;
  game.cars.push(car);
  return car;
}

// Golden hour + clear skies for every staged scene.
function golden(game) {
  game.dayT = 0.71; // ~17:02 — warm dusk light, city still readable
  game.weather = 'clear';
  game.state = 'playing';
  game.hasSave = false;
}

export function stageShot(game, name) {
  golden(game);
  switch (name) {
    case 'start': {
      game.state = 'title';
      break;
    }
    case 'play': {
      // Raka on foot in the middle of the Downtown crossing at (1620, 900),
      // facing east down the avenue: in 3D the chase camera sits west of
      // him with the road corridor, towers, neon and traffic ahead — the
      // old 2D spot stood in a tower's blind spot and framed only a wall.
      // He carries the SMG (slot 2) so the armed stance reads in frame.
      placePlayer(game, 1620, 900, 0);
      game.player.health = 88; game.player.armor = 25;
      game.money = 415;
      game.weapons.owned.pistol = true;
      game.weapons.owned.smg = true;
      game.weapons.ammo.smg = 120;
      game.weapons.current = 'smg';
      game._syncWeaponFlags();
      stageCar(game, 'taxi', 1830, 873, 0, 120);
      stageCar(game, 'sedan', 1420, 927, Math.PI, 150);
      stageCar(game, 'sports', 1980, 873, 0, 90);
      break;
    }
    case 'drive': {
      // Behind the wheel of a red sports car on the beachfront avenue,
      // palm trees, sand and the bay to the south, hotels to the north.
      const car = stageCar(game, 'sports', 1180, 2153, 0, 215, '#ff3860');
      game.player.car = car;
      game.player.x = car.x; game.player.y = car.y; game.player.angle = 0;
      game.money = 1250;
      game.player.health = 100;
      stageCar(game, 'sedan', 1480, 2207, Math.PI, 130);
      stageCar(game, 'taxi', 830, 2153, 0, 110);
      break;
    }
    case 'chase': {
      // Four-star pursuit through Downtown: Raka's sports car at speed in
      // the southbound lane of the 1620 avenue, cruisers streaming in
      // behind, a PD roadblock striped across the road ahead, and AIR-1
      // overhead with its searchlight pinned on the car. In 3D the chase
      // camera rides behind Raka's car, so all of it sits in one frame.
      // A sports car (top speed 360, vs the sedan's 265) is staged so the
      // car is still doing ~155 when the shutter falls at frame 90: the
      // faster pace stretches the chase camera back and flattens its
      // pitch, which is what lifts AIR-1's airframe into the top of the
      // frame instead of leaving it hovering just above the frame edge.
      const car = stageCar(game, 'sports', 1647, 1180, Math.PI / 2, 360, '#4f79c9');
      game.player.car = car;
      game.player.x = car.x; game.player.y = car.y; game.player.angle = Math.PI / 2;
      game.setWanted(4);
      game.frozenCrime = true; // staging collisions must not move the stars
      game.money = 2080;
      game.weapons.owned.pistol = true;
      game.weapons.current = 'pistol';
      game._syncWeaponFlags();
      // Cruiser gaps are tuned to their closing speed: a staged cruiser
      // covers ~470px in the 90-frame loop while the sports car covers
      // ~368, so a ~250px gap ends ~150px back — close enough to loom in
      // frame, far enough that nobody PIT-stops the star car mid-shot.
      const p1 = makeCar(game.rng, 'police', 1593, 930, Math.PI / 2);
      const p2 = makeCar(game.rng, 'police', 1701, 895, Math.PI / 2);
      const p3 = makeCar(game.rng, 'police', 1647, 860, Math.PI / 2);
      for (const pc of [p1, p2, p3]) { pc.police = true; pc.speed = 195; game.police.push(pc); }
      game.policeSeePlayer = true;
      // Roadblock across the avenue before the crossing; the car covers
      // ~368px over the shot loop, so it ends ~200px short of the barriers.
      spawnRoadblock(game, 1620, 1750, true);
      // AIR-1 staged far south-east, past the roadblock: its update pulls
      // it toward a patrol point near the car over the 90 frames, and the
      // long southern approach leaves it hanging ahead of the car — inside
      // the frame, rotor and all — instead of converged overhead. The
      // light itself starts on the car and tracks it the whole way.
      game.heli = {
        x: car.x - 361, y: car.y + 1589,
        lightX: car.x + 16, lightY: car.y + 8,
        angle: Math.PI * 0.75, rotor: 2.4, active: true, spots: true,
      };
      break;
    }
    case 'mission': {
      // The finale, "Undertow": Raka on Pier 9 at dusk, the gold-trim
      // getaway boat moored ahead of him, five stars up, AIR-1's
      // searchlight sweeping the pier and cruisers sealing the shore.
      // Staged in dialog state: the shot loop then runs only the ambient
      // world (traffic/peds), so the pursuit can't pile onto the pier
      // and bury the frame — Nara's send-off line carries the moment.
      // Composition: Raka stands SOUTH of the boat on the pier boards
      // and faces north-northwest up the pier, so the chase camera
      // (behind him, low) frames the gold-trim boat big ahead-left, the
      // marina shore and the city skyline across the water behind it,
      // and AIR-1 in the sky over the bay — not open sea. In dialog
      // state the heli holds its staged station, so it is placed out
      // over the water on the camera's axis, nose toward Raka, with its
      // light dropped on the pier between boat and man.
      game.missions.index = 8; // M9
      game.missions.phase = 'active';
      game.missions.timer = 170;
      placePlayer(game, 2857, 2610, -1.98);
      game.player.health = 76;
      game.money = 6840;
      game.weapons.owned.pistol = true;
      game.weapons.owned.smg = true;
      game.weapons.owned.shotgun = true;
      game.weapons.ammo.smg = 160; game.weapons.ammo.shotgun = 18;
      game.weapons.current = 'shotgun';
      game._syncWeaponFlags();
      game.setWanted(5);
      game.frozenCrime = true;
      const c1 = makeCar(game.rng, 'police', 2700, 2335, Math.PI / 4);
      const c2 = makeCar(game.rng, 'police', 2980, 2310, Math.PI * 0.8);
      for (const pc of [c1, c2]) { pc.police = true; pc.parked = true; game.police.push(pc); }
      game.heli = {
        x: 2690, y: 2330,
        lightX: 2848, lightY: 2568,
        angle: 1.03, rotor: 1.1, active: true, spots: true,
      };
      game.policeSeePlayer = true;
      game.districtName = 'Solmara Bay';
      game.startDialog([
        { who: 'Nara', text: 'Five stars, the helicopter, the whole city between you and that boat — and you know every street of it now. Reach the boat, Raka. End this.' },
      ]);
      break;
    }
    case 'end': {
      // Campaign-complete screen with final earnings.
      game.missions.index = MISSIONS.length;
      game.missions.phase = 'campaignDone';
      game.missions.totalEarned = 12350;
      game.money = 9100;
      game.storyComplete = true;
      placePlayer(game, PLACES.marina.x, PLACES.marina.y - 30, Math.PI / 2);
      game.state = 'complete';
      break;
    }
    default: {
      game.state = 'title';
    }
  }
  game._centerCam(true);
}
