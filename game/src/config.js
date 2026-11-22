// ============================================================================
// SOLMARA UNDERTOW — config.js
// Central constants: world dimensions, road layout, palette, districts,
// vehicle archetypes, tuning values. Everything else imports from here so
// the whole game can be re-balanced from one place.
// ============================================================================

export const WORLD = {
  w: 3200,
  h: 2600,
  // Sea occupies the southern strip; sand sits just north of it.
  waterY: 2460,
  sandY: 2260,
};

// Road centre-lines. Roads are wide avenues with two lanes each direction.
export const ROAD_W = 110;
export const ROADS_V = [180, 900, 1620, 2340, 3020]; // vertical avenues (x)
export const ROADS_H = [180, 900, 1560, 2180];       // horizontal avenues (y)
export const LANE = 27; // lane offset from road centre-line

// District zones — used for ground tinting, building style and minimap.
// Point-in-rect lookup, first match wins; order matters.
export const DISTRICTS = [
  { id: 'marina',    name: 'Marina District', x: 2395, y: 1615, w: 805, h: 645, ground: '#5d6066', map: '#7d8590' },
  { id: 'park',      name: 'Central Park',    x: 955,  y: 1615, w: 610, h: 510, ground: '#3f7a3a', map: '#58a34c' },
  { id: 'palma',     name: 'Palma Beach',     x: 235,  y: 1615, w: 610, h: 645, ground: '#8a7a52', map: '#c2a878' },
  { id: 'downtown',  name: 'Downtown',        x: 955,  y: 235,  w: 1330, h: 1270, ground: '#6d6a63', map: '#9a958a' },
  { id: 'suburb',    name: 'Casa Verde',      x: 235,  y: 235,  w: 610, h: 1270, ground: '#77705f', map: '#a49a7d' },
  { id: 'industrial',name: 'Portside Industrial', x: 2395, y: 235, w: 805, h: 1270, ground: '#5f5c57', map: '#8a867e' },
];

export function districtAt(x, y) {
  if (y >= WORLD.waterY) return { id: 'sea', name: 'Solmara Bay', map: '#2b6ea6' };
  if (y >= WORLD.sandY) return { id: 'beach', name: 'Palma Beach', map: '#e3cd96' };
  for (const d of DISTRICTS) {
    if (x >= d.x && x < d.x + d.w && y >= d.y && y < d.y + d.h) return d;
  }
  return { id: 'streets', name: 'Solmara', map: '#8f8b82' };
}

// Key locations (world coordinates) referenced by missions, respawns, shots.
export const PLACES = {
  garage:    { x: 470,  y: 838,  label: "Bimo's Garage" },
  marina:    { x: 2820, y: 2380, label: 'Marina Pier 9' },
  docks:     { x: 2620, y: 2030, label: 'The Docks' },
  hideout:   { x: 2720, y: 1560, label: 'Portside Hideout' },
  hospital:  { x: 1600, y: 985,  label: 'Solmara General' },
  policeHQ:  { x: 1980, y: 985,  label: 'Solmara PD' },
  palmaCar:  { x: 618,  y: 2153, label: 'Palma Grand Hotel' },
  start:     { x: 838,  y: 985,  label: 'Casa Verde Corner' },
};

// Sunset-forward palette: warm dusk grade, teal water, Downtown neon.
export const PALETTE = {
  asphalt: '#3c3f45',
  asphaltEdge: '#2e3036',
  sidewalk: '#9b968b',
  sidewalkEdge: '#7e7a70',
  laneMark: '#e8d98a',
  crosswalk: '#ddd8ce',
  sand: '#e3cd96',
  water: '#2b6ea6',
  waterDeep: '#1f5685',
  grass: '#4c8a44',
  grassDark: '#3f7a3a',
  plaza: '#a39c8d',
  neon: ['#ff5d8f', '#ffb340', '#39d5e8', '#b78bff', '#7dff6a'],
};

// Vehicle archetypes: len/wid is the draw + collision footprint.
export const CAR_TYPES = {
  sedan:  { len: 46, wid: 22, maxSpeed: 265, accel: 190, grip: 3.4, colors: ['#c94f4f', '#4f79c9', '#d8d8d8', '#3a3f4a', '#7ac74f', '#e0a83c'] },
  taxi:   { len: 46, wid: 22, maxSpeed: 255, accel: 185, grip: 3.4, colors: ['#f5b921', '#f5b921', '#f08c1e'] },
  sports: { len: 48, wid: 23, maxSpeed: 360, accel: 300, grip: 4.1, colors: ['#ff3860', '#ff7a1a', '#8b2ff7', '#12c2e0'] },
  truck:  { len: 64, wid: 26, maxSpeed: 205, accel: 130, grip: 2.7, colors: ['#8d99ae', '#6c757d', '#457b9d', '#bc6c25'] },
  van:    { len: 56, wid: 25, maxSpeed: 225, accel: 150, grip: 3.0, colors: ['#e9ecef', '#adb5bd', '#588157'] },
  police: { len: 48, wid: 23, maxSpeed: 335, accel: 285, grip: 3.9, colors: ['#1b263b'] },
};

export const TRAFFIC_COUNT = 24;
export const PED_COUNT = 36;
export const DAY_LENGTH = 240; // seconds per full day-night cycle
export const SAVE_KEY = 'solmara-undertow-save-v1';

// Crime heat: stars = ceil(heat / 100), capped 0..5.
export const CRIME = {
  stealWitnessed: 60,
  stealUnseen: 15,
  hitCar: 35,
  hitPed: 90,
  shoot: 45,
  punchPed: 55,
  gangKill: 25,
  policeHit: 80,
};
