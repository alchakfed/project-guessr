#!/usr/bin/env node
/**
 * build-manifest.js
 * -----------------
 * Reads the mod's capture log (captures.jsonl), keeps entries whose panorama
 * folder actually exists, optionally filters to one dimension/world, and writes
 * the game manifest the server uses as its answer key.
 *
 * Usage:
 *   node build-manifest.js --captures "<path to screenshots/projectguessr>"
 *                          [--out ../web/public/manifest.json]
 *                          [--dimension minecraft:overworld]
 *                          [--world MyWorld]
 *
 * If --captures is omitted it defaults to the standard Minecraft screenshots
 * path on this OS when it can be guessed, otherwise it errors with guidance.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function defaultCapturesDir() {
  // Best-effort guess of .minecraft/screenshots/projectguessr per platform.
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, '.minecraft', 'screenshots', 'projectguessr');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'minecraft', 'screenshots', 'projectguessr');
  }
  return path.join(os.homedir(), '.minecraft', 'screenshots', 'projectguessr');
}

const argv = yargs(hideBin(process.argv))
  .option('captures', {
    type: 'string',
    default: defaultCapturesDir(),
    describe: 'Folder containing captures.jsonl and pano_* subfolders',
  })
  .option('out', {
    type: 'string',
    default: path.resolve(__dirname, '../web/public/manifest.json'),
    describe: 'Output manifest path',
  })
  .option('dimension', {
    type: 'string',
    describe: 'Only include captures in this dimension (e.g. minecraft:overworld)',
  })
  .option('world', {
    type: 'string',
    describe: 'Only include captures from this world/server label',
  })
  .help()
  .argv;

function fail(msg) {
  console.error('\n[build-manifest] ' + msg + '\n');
  process.exit(1);
}

// In 1.21.11 vanilla's takePanorama(File) writes the 6 faces into a
// "screenshots" subfolder of the directory the mod passes, so a capture lands
// at pano_XXXXXX/screenshots/panorama_N.png rather than pano_XXXXXX/panorama_N.png.
// Return whichever directory actually holds panorama_0.png (subfolder first),
// or null if neither does.
function findFacesDir(shotDir) {
  const candidates = [path.join(shotDir, 'screenshots'), shotDir];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'panorama_0.png'))) return dir;
  }
  return null;
}

const capturesDir = path.resolve(argv.captures);
const logFile = path.join(capturesDir, 'captures.jsonl');

if (!fs.existsSync(logFile)) {
  fail(
    'Could not find captures.jsonl at: ' + logFile + '\n' +
    'Pass --captures pointing at your screenshots/projectguessr folder, e.g.\n' +
    '  node build-manifest.js --captures "%APPDATA%\\.minecraft\\screenshots\\projectguessr"\n' +
    'Take at least one panorama in-game (default key F4) first.'
  );
}

const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter((l) => l.trim());
console.log(`[build-manifest] Read ${lines.length} log lines from ${logFile}`);

const rounds = [];
let skippedMissing = 0;
let skippedFilter = 0;
let skippedParse = 0;
const seen = new Set();

for (const line of lines) {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    skippedParse++;
    continue;
  }
  if (argv.dimension && e.dimension !== argv.dimension) { skippedFilter++; continue; }
  if (argv.world && e.world !== argv.world) { skippedFilter++; continue; }

  const folder = e.folder || e.id;
  const shotDir = path.join(capturesDir, folder);
  // Require the 6 faces to exist so the game never serves a broken round.
  // They may sit directly in shotDir or in a "screenshots" subfolder (1.21.11).
  const facesDir = findFacesDir(shotDir);
  const facesOk = facesDir !== null && [0, 1, 2, 3, 4, 5].every((i) =>
    fs.existsSync(path.join(facesDir, `panorama_${i}.png`))
  );
  if (!facesOk) { skippedMissing++; continue; }

  if (seen.has(e.id)) continue; // de-dupe repeated ids (last write wins anyway)
  seen.add(e.id);

  rounds.push({
    id: e.id,
    folder,
    x: e.x,
    z: e.z,
    y: e.y,
    dimension: e.dimension,
    world: e.world,
  });
}

if (rounds.length === 0) {
  fail(
    'No usable rounds after filtering.\n' +
    `  parse-skipped=${skippedParse} filter-skipped=${skippedFilter} missing-faces=${skippedMissing}\n` +
    'Check that the pano_* folders sit next to captures.jsonl and each has panorama_0..5.png.'
  );
}

const manifest = {
  generatedNote: 'Answer key for ProjectGuessr. Do not expose coords to the client until a round is scored.',
  mapMeta: 'map/map-meta.json',
  rounds,
};

fs.mkdirSync(path.dirname(argv.out), { recursive: true });
fs.writeFileSync(argv.out, JSON.stringify(manifest, null, 2));

console.log(
  `[build-manifest] Wrote ${rounds.length} rounds to ${argv.out} ` +
  `(skipped: parse=${skippedParse}, filtered=${skippedFilter}, missing=${skippedMissing})`
);
