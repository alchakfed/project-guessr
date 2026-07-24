#!/usr/bin/env node
/**
 * build-links.js
 * --------------
 * Builds the Street-View-style navigation graph: for each panorama, which other
 * panoramas are close enough to "walk" to, and in what compass direction they
 * lie. Writes web/public/links.json, consumed by the server and turned into the
 * on-screen movement arrows.
 *
 * IMPORTANT - no answer leak: this file contains only panorama *folder ids*,
 * the *relative* bearing from one pano to a neighbour, and the distance between
 * them. It never contains absolute world X/Z, so exposing it to the client
 * cannot reveal where a round actually is. (The manifest with real coords stays
 * server-side, as before.)
 *
 * Bearing convention: degrees clockwise from +Z toward +X, i.e.
 *   bearing = atan2(dx, dz)  with dx = neighbour.x - self.x, dz = neighbour.z - self.z.
 * The client maps this to the panorama viewer's yaw with a single tunable
 * offset (PANO_YAW_OFFSET in config.js) so you can line the arrows up with the
 * world without regenerating this file.
 *
 * Usage:
 *   node build-links.js
 *   node build-links.js --manifest ../web/public/manifest.json --out ../web/public/links.json
 *   node build-links.js --radius 8 --max-links 4
 *
 *   --radius     max block distance to treat two panoramas as connected
 *                (default 8; capture spacing is usually ~5 blocks, so this links
 *                immediate neighbours but not the ones beyond them). Bump it if
 *                your captures are spaced further apart.
 *   --max-links  cap on arrows out of a single panorama (default 4).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const argv = yargs(hideBin(process.argv))
  .option('manifest', {
    type: 'string',
    default: path.resolve(__dirname, '../web/public/manifest.json'),
    describe: 'Manifest with per-panorama coordinates (server answer key)',
  })
  .option('out', {
    type: 'string',
    default: path.resolve(__dirname, '../web/public/links.json'),
    describe: 'Output navigation graph path',
  })
  .option('radius', {
    type: 'number',
    default: 8,
    describe: 'Max block distance to connect two panoramas',
  })
  .option('max-links', {
    type: 'number',
    default: 4,
    describe: 'Max arrows out of a single panorama',
  })
  .help()
  .argv;

function fail(msg) {
  console.error('\n[build-links] ' + msg + '\n');
  process.exit(1);
}

if (!fs.existsSync(argv.manifest)) {
  fail(
    'Manifest not found at: ' + argv.manifest + '\n' +
    'Run build-manifest.js first (it produces the coords this graph needs).'
  );
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(argv.manifest, 'utf8'));
} catch (e) {
  fail('Could not parse manifest: ' + e.message);
}

const rounds = Array.isArray(manifest.rounds) ? manifest.rounds : [];
if (rounds.length === 0) fail('Manifest has no rounds.');

// Only panoramas in the same dimension+world can sensibly connect.
function sameWorld(a, b) {
  return a.dimension === b.dimension && a.world === b.world;
}

function bearing(from, to) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  let deg = (Math.atan2(dx, dz) * 180) / Math.PI; // clockwise from +Z toward +X
  if (deg < 0) deg += 360;
  return deg;
}

const links = {};
let edgeCount = 0;
let isolated = 0;

for (const a of rounds) {
  const folder = a.folder || a.id;
  const neighbours = [];
  for (const b of rounds) {
    if (b === a) continue;
    if (!sameWorld(a, b)) continue;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const dist = Math.hypot(dx, dz);
    if (dist > argv.radius) continue;
    neighbours.push({
      to: b.folder || b.id,
      bearing: Math.round(bearing(a, b) * 10) / 10,
      dist: Math.round(dist * 100) / 100,
    });
  }
  neighbours.sort((p, q) => p.dist - q.dist);
  const capped = neighbours.slice(0, argv.maxLinks);
  links[folder] = capped;
  edgeCount += capped.length;
  if (capped.length === 0) isolated++;
}

const out = {
  generatedNote:
    'Navigation graph for ProjectGuessr movement arrows. Contains only relative ' +
    'bearings + distances between panoramas, never absolute world coordinates.',
  bearingConvention: 'degrees clockwise from +Z toward +X (atan2(dx, dz))',
  radius: argv.radius,
  links,
};

fs.mkdirSync(path.dirname(argv.out), { recursive: true });
fs.writeFileSync(argv.out, JSON.stringify(out, null, 2));

console.log(
  `[build-links] Wrote ${rounds.length} nodes, ${edgeCount} directed links to ${argv.out}\n` +
  `              radius=${argv.radius} maxLinks=${argv.maxLinks}` +
  (isolated ? `  (warning: ${isolated} panorama(s) have no neighbours within radius)` : '')
);
