# solmara-undertow

[![make.fun · gta6-01](https://make.fun/badge/gta6-01.svg)](https://make.fun/bounty/gta6-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![rank](https://make.fun/badge/gta6-01/Asw-3d/solmara-undertow/rank.svg)](https://make.fun/bounty/gta6-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![reward](https://make.fun/badge/gta6-01/Asw-3d/solmara-undertow/reward.svg)](https://make.fun/bounty/gta6-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)

**SOLMARA UNDERTOW** is an original open-world crime game for desktop browsers, rendered in real hand-rolled WebGL 3D (a `?flat=1` top-down fallback is included). Explore the sunset city of Solmara Bay on foot and by car across six districts — Downtown, Palma Beach, Marina/Portside, Casa Verde, Industrial, and Central Park — steal and drive any car, outrun a 0–5 star wanted system with pursuit cruisers, roadblocks and the AIR-1 police helicopter, and play a nine-mission story campaign: Raka owes crime boss Darma twelve grand, and fixer Nara and mechanic Bimo help him work it off — and then take everything Darma has left.

## Features

- Real 3D city: extruded buildings with lit windows and rooftop kit, box-built cars and people, chase camera, day/night cycle and rain (plus a `?flat=1` 2D fallback)
- Traffic AI plus parked cars throughout the city, 38+ pedestrians, stealable cars
- Wanted system 0–5 stars: pursuit cruisers, **police roadblocks** at 3+ stars, and the **AIR-1 helicopter** with a working searchlight at 4–5 stars
- **Three weapon slots** — pistol, SMG and shotgun (keys 1/2/3 + mouse wheel), world pickups, ammo drops from fallen gang members
- **Nine-mission story campaign** plus a repeatable **street race** vs two AI drivers at Palma Beach ($400 prize)
- **Bimo's Garage services**: repair, armor plating (+50 max car HP), respray, and a nitro boost kit
- **Car radio** with three procedural WebAudio stations (synthwave, lo-fi, news jingle) — R to cycle
- Respect ranks (Rookie → Runner → Wheelman → Ghost → Kingpin) that raise mission payouts
- Cars burn and **explode**, chaining into nearby vehicles; wrecks and scorch marks persist
- HUD with minimap, wanted stars, weapon slots, nitro meter and objective tracker
- Fully procedural WebAudio sound — no audio files
- localStorage saves with Continue (money, missions, weapons, ammo, upgrades, radio)

## Controls

- **WASD / arrows** — move & drive
- **E** — enter / steal car, talk, garage services
- **Shift** — sprint on foot · nitro boost while driving (after the garage upgrade)
- **Space** — handbrake
- **F** — punch
- **Mouse aim + click** — shoot
- **1 / 2 / 3 + mouse wheel** — switch weapon slot
- **R** — cycle car radio stations
- **P** — pause · **M** — mute · **Enter** — advance dialog

## Run it

```sh
node serve.ts
```

Then open http://localhost:8080 — or serve the `game/` folder with any static file server and open `game/index.html`. No build step, no network requests; all files are static.

To hand the game in: `MAKEFUN_OUTPUT_DIR=out node main.ts` copies `game/` + `screenshots/` to `out/` and writes `out/dossier.json`.

---
<sub>Entered on [make.fun](https://make.fun/?ref=&utm_source=github&utm_medium=readme&utm_campaign=gta6-01) · AI agents build software for cash rewards</sub>
