// ============================================================================
// SOLMARA UNDERTOW — shots.js
// Deterministic screenshot staging behind ?shot=start|play|drive|chase|
// mission|end (with &seed=N). Each scene arranges the real game state —
// player, vehicles, police, dialog, HUD — at golden hour so the captured
// frame is a true render of the game at its most characteristic. main.js
// runs ~90 frames of the real loop after staging, then sets
// window.__shotReady so the capture tool knows the frame is settled.
// ============================================================================

import { PLACES } from './config.js';
import { makeCar } from './entities.js';
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
      // Raka on foot at a busy Downtown crossing, towers + neon all around,
      // traffic flowing, peds on the sidewalks, mission marker on the map.
      placePlayer(game, 1502, 972, Math.PI / 4);
      game.player.health = 88; game.player.armor = 25;
      game.money = 415;
      stageCar(game, 'taxi', 1620, 760, Math.PI / 2, 120);
      stageCar(game, 'sedan', 1540, 900, 0, 150);
      stageCar(game, 'sports', 1620, 1080, -Math.PI / 2, 90);
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
      // Three-star pursuit through Downtown: Raka's sedan at speed, cruisers
      // streaming in behind, lightbars flashing, HUD stars lit.
      const car = stageCar(game, 'sedan', 1620, 1290, Math.PI / 2, 300, '#4f79c9');
      game.player.car = car;
      game.player.x = car.x; game.player.y = car.y; game.player.angle = Math.PI / 2;
      game.setWanted(3);
      game.frozenCrime = true; // staging collisions must not inflate the stars
      game.money = 2080;
      const p1 = makeCar(game.rng, 'police', 1620, 1060, Math.PI / 2);
      const p2 = makeCar(game.rng, 'police', 1505, 1140, Math.PI / 2);
      const p3 = makeCar(game.rng, 'police', 1745, 1160, Math.PI / 2);
      for (const pc of [p1, p2, p3]) { pc.police = true; pc.speed = 250; game.police.push(pc); }
      game.policeSeePlayer = true;
      break;
    }
    case 'mission': {
      // Briefing at Bimo's Garage: Nara mid-dialog, story box open, the gold
      // mission marker overhead, Casa Verde houses around.
      placePlayer(game, PLACES.garage.x - 4, PLACES.garage.y + 34, -Math.PI / 2);
      game.money = 150;
      game.missions.beginBriefing(game); // opens M1 dialog, state -> 'dialog'
      if (game.dialog) game.dialog.index = 1; // Raka's reply line
      break;
    }
    case 'end': {
      // Campaign-complete screen with final earnings.
      game.missions.index = MISSIONS.length;
      game.missions.phase = 'campaignDone';
      game.missions.totalEarned = 6350;
      game.money = 5210;
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
