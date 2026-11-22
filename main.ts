// SOLMARA UNDERTOW — hand-in program for the make.fun gta6-01 entry.
//
// The game itself is a self-contained bundle of static files living in the
// game/ directory next to this script: a browser opens game/index.html and
// plays entirely offline, no server logic and no network traffic involved.
// What this program does is package that bundle for judging. It mirrors the
// game/ tree and the screenshots/ tree into the output directory and then
// asks the vendored make.fun dossier builder to describe the result in a
// dossier.json file, which is the document the grader actually reads.
//
// Run it directly with Node 22 (the runtime strips the types on the fly):
//   node main.ts
// The grader mounts the destination at /output; for a local dry run point
// MAKEFUN_OUTPUT_DIR at any scratch folder instead:
//   MAKEFUN_OUTPUT_DIR=/tmp/preview node main.ts

import { buildDossier } from './vendor/makefun-game.ts';
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Emit one progress line so a hand-in run is easy to follow in a log. */
function announce(stepNumber, message) {
  console.log(`[hand-in ${stepNumber}] ${message}`);
}

/** Count regular files anywhere below `root`, following nested folders. */
function countFilesBelow(root) {
  let total = 0;
  for (const entryName of readdirSync(root)) {
    const entryPath = join(root, entryName);
    if (statSync(entryPath).isDirectory()) {
      total += countFilesBelow(entryPath);
    } else {
      total += 1;
    }
  }
  return total;
}

/** Fail loudly when the playable bundle is missing its entry page. */
function requirePlayableBundle(repoRoot) {
  const gameDir = join(repoRoot, 'game');
  const entryPage = join(gameDir, 'index.html');
  if (!existsSync(entryPage)) {
    throw new Error(
      `SOLMARA UNDERTOW cannot be handed in: ${entryPage} does not exist. ` +
        'The game/ folder must contain the static bundle with index.html at its top level.',
    );
  }
  return gameDir;
}

// ---------------------------------------------------------------------------
// Hand-in sequence
// ---------------------------------------------------------------------------

const repoRoot = dirname(fileURLToPath(import.meta.url));
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

announce(1, `packaging the SOLMARA UNDERTOW bundle from ${repoRoot}`);
const gameSource = requirePlayableBundle(repoRoot);

announce(2, `preparing output directory ${outputDir}`);
mkdirSync(outputDir, { recursive: true });

announce(3, 'copying the playable game files');
const gameTarget = join(outputDir, 'game');
cpSync(gameSource, gameTarget, { recursive: true });

announce(4, 'copying the screenshot set');
const shotsTarget = join(outputDir, 'screenshots');
mkdirSync(shotsTarget, { recursive: true });
const shotsSource = join(repoRoot, 'screenshots');
if (existsSync(shotsSource)) {
  cpSync(shotsSource, shotsTarget, { recursive: true });
} else {
  console.log('[hand-in 4] no screenshots/ folder beside main.ts, continuing without one');
}

// Limits handed to the dossier builder. They mirror the grader's own gate:
// dossier text is capped, at most four screenshots of at most 256 KiB each
// are described, and the game tree may hold at most 993 entries totalling
// 48 MiB with no single path longer than 1000 bytes.
const dossierLimits = {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000,
};

announce(5, 'building dossier.json with the vendored make.fun library');
const dossierText = buildDossier(outputDir, dossierLimits);
writeFileSync(join(outputDir, 'dossier.json'), dossierText);

announce(
  6,
  `done: ${countFilesBelow(gameTarget)} game file(s), ` +
    `${countFilesBelow(shotsTarget)} screenshot(s), dossier of ${dossierText.length} characters`,
);
