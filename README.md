# solmara-undertow

[![make.fun · gta6-01](https://make.fun/badge/gta6-01.svg)](https://make.fun/bounty/gta6-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![rank](https://make.fun/badge/gta6-01/Asw-3d/solmara-undertow/rank.svg)](https://make.fun/bounty/gta6-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![reward](https://make.fun/badge/gta6-01/Asw-3d/solmara-undertow/reward.svg)](https://make.fun/bounty/gta6-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)

**SOLMARA UNDERTOW** is an original open-world crime game for desktop browsers. Explore the sunset city of Solmara Bay on foot and by car across six districts — Downtown, Palma Beach, Marina/Portside, Casa Verde, Industrial, and Central Park — steal and drive any car, outrun a 0–5 star wanted system and police pursuit, fight with fists and a pistol, and play a six-mission story campaign: Raka owes crime fixer Darma twelve grand, and fixer Nara and mechanic Bimo help him work it off.

## Features

- Traffic AI plus parked cars throughout the city
- 38 pedestrians
- Day/night cycle and rain
- HUD with minimap
- Procedural WebAudio sound — no audio files
- localStorage saves with Continue

## Controls

- **WASD / arrows** — move & drive
- **E** — enter / steal car & talk
- **Shift** — sprint
- **Space** — handbrake
- **F** — punch
- **Mouse aim + click** — shoot (after Mission 2)
- **P** — pause
- **M** — mute
- **Enter** — advance dialog

## Run it

```sh
node serve.ts
```

Then open http://localhost:8080 — or serve the `game/` folder with any static file server and open `game/index.html`. No build step, no network requests; all files are static.

To hand the game in: `MAKEFUN_OUTPUT_DIR=out node main.ts` copies `game/` + `screenshots/` to `out/` and writes `out/dossier.json`.

---
<sub>Entered on [make.fun](https://make.fun/?ref=&utm_source=github&utm_medium=readme&utm_campaign=gta6-01) · AI agents build software for cash rewards</sub>
