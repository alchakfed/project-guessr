#!/usr/bin/env node
/**
 * trim-journeymap.js
 * ------------------
 * JourneyMap stores far more than the flat surface map: for every dimension it
 * also keeps raw region caches it can re-render from, plus a full stack of
 * underground "cave layer" slices. On a well-explored world that balloons to
 * many GB.
 *
 * This tool does NOT touch your in-game JourneyMap data. Instead it COPIES just
 * the surface map tiles out into a local folder inside the project, giving you
 * a slim, surface-only snapshot to work with while the original stays intact.
 *
 * What it COPIES (per dimension): the "X,Z.png" surface renders inside the
 *   tile-image folders
 *   day/  night/  topo/  biome/
 * ...but ONLY the image files - any nested cache/ or chunk_cache/ inside those
 * folders (e.g. topo/cache, often hundreds of MB) is skipped.
 *
 * What it SKIPS (never copied):
 *   cache/        - cached .mca region copies JourneyMap re-renders from
 *   chunk_cache/  - cached .jmc chunk data
 *   0/ 1/ 2/ ... and -1/ -2/ ...  - numbered underground cave-layer slices
 *   any nested cache inside a kept tile folder
 *
 * SAFE BY DEFAULT: prints what it would copy and the resulting size, but writes
 * NOTHING unless you pass --apply. The source (your game data) is only ever
 * read, never modified.
 *
 * Usage:
 *   node trim-journeymap.js --input "<path>"                      # preview only
 *   node trim-journeymap.js --input "<path>" --apply              # copy to default out
 *   node trim-journeymap.js --input "<path>" --out "<dir>" --apply
 *
 *   --input may point at:
 *     - the journeymap root            (.../journeymap)          -> all worlds/dimensions
 *     - a world folder                 (.../data/sp/MyWorld)     -> all its dimensions
 *     - a single dimension folder      (.../overworld)           -> just that one
 *
 *   --out defaults to ../journeymap-surface (next to the tools/ folder). The
 *   dimension folder structure is mirrored under it, so build-map.js can point
 *   straight at e.g. <out>/data/sp/MyWorld/overworld/day.
 *
 * Example (snapshot the overworld surface into the project):
 *   node trim-journeymap.js --input "%APPDATA%\.minecraft\journeymap" --apply
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const argv = yargs(hideBin(process.argv))
  .option('input', {
    type: 'string',
    describe: 'JourneyMap root, a world folder, or a single dimension folder',
  })
  .option('out', {
    type: 'string',
    default: path.resolve(__dirname, '../journeymap-surface'),
    describe: 'Local folder to copy the surface-only snapshot into',
  })
  .option('apply', {
    type: 'boolean',
    default: false,
    describe: 'Actually copy. Without this the tool only previews (dry run).',
  })
  .option('keep', {
    type: 'string',
    default: 'day,night,topo,biome',
    describe: 'Comma-separated tile-folder names to copy from each dimension',
  })
  .help()
  .argv;

function fail(msg) {
  console.error('\n[trim-journeymap] ' + msg + '\n');
  process.exit(1);
}

if (!argv.input) {
  fail(
    'Pass --input pointing at your journeymap folder, a world, or a dimension, e.g.\n' +
    '  node trim-journeymap.js --input "%APPDATA%\\.minecraft\\journeymap"\n' +
    'Add --apply once the preview looks right.'
  );
}

const inputDir = path.resolve(argv.input);
if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
  fail('Not a folder: ' + inputDir);
}
const outDir = path.resolve(argv.out);

const KEEP = new Set(argv.keep.split(',').map((s) => s.trim()).filter(Boolean));
// Image extensions we treat as actual map tiles worth copying.
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

// A folder is a "dimension" if it directly contains at least one of the KEEP
// tile-image folders (day/night/topo/...). That's the reliable marker across
// singleplayer/multiplayer and JourneyMap versions.
function isDimensionDir(dir) {
  for (const name of KEEP) {
    const p = path.join(dir, name);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return true;
  }
  return false;
}

// Walk down from input to find every dimension folder (input itself may be one).
function findDimensions(root) {
  const found = [];
  const stack = [root];
  const MAX_DEPTH = 8; // journeymap/data/<mp|sp>/<world>/<dimension> is shallow
  const startDepth = root.split(path.sep).length;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (isDimensionDir(dir)) {
      found.push(dir);
      continue; // don't descend into a dimension
    }
    if (dir.split(path.sep).length - startDepth >= MAX_DEPTH) continue;
    for (const e of entries) {
      if (e.isDirectory()) stack.push(path.join(dir, e.name));
    }
  }
  return found;
}

// Collect the image tiles inside one KEEP folder, skipping nested cache dirs.
// Returns [{ src, size }].
function collectTiles(keepDir) {
  const tiles = [];
  let entries;
  try {
    entries = fs.readdirSync(keepDir, { withFileTypes: true });
  } catch {
    return tiles;
  }
  for (const e of entries) {
    if (e.isDirectory()) continue; // skip cache/, chunk_cache/, anything nested
    if (!IMAGE_EXT.has(path.extname(e.name).toLowerCase())) continue;
    const src = path.join(keepDir, e.name);
    let size = 0;
    try { size = fs.statSync(src).size; } catch { /* ignore */ }
    tiles.push({ src, size });
  }
  return tiles;
}

function fmt(bytes) {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

const dims = findDimensions(inputDir);
if (dims.length === 0) {
  fail(
    'No dimension folders found under: ' + inputDir + '\n' +
    'Expected a folder that contains a "day"/"night"/"topo" tiles subfolder.\n' +
    'Point --input at your journeymap folder or a specific "<dimension>" folder.'
  );
}

// Mirror path: reproduce the part of the tree from inputDir down, so build-map
// can find e.g. <out>/data/mp/<world>/<dim>/day. If input IS a dimension, its
// basename becomes the top-level folder under out.
function relFromInput(p) {
  if (p === inputDir) return path.basename(p);
  return p.substring(inputDir.length).replace(/^[\\/]/, '');
}

console.log(
  `[trim-journeymap] ${argv.apply ? 'COPY' : 'DRY RUN'} - ${dims.length} dimension(s)\n` +
  `                  source: ${inputDir}\n` +
  `                  out:    ${outDir}\n`
);

let grandBytes = 0;
let grandFiles = 0;

for (const dim of dims) {
  const rel = relFromInput(dim);
  let dimBytes = 0;
  const rows = [];

  for (const name of KEEP) {
    const keepDir = path.join(dim, name);
    if (!fs.existsSync(keepDir) || !fs.statSync(keepDir).isDirectory()) continue;
    const tiles = collectTiles(keepDir);
    if (tiles.length === 0) continue;
    const bytes = tiles.reduce((a, t) => a + t.size, 0);
    dimBytes += bytes;
    rows.push({ name, count: tiles.length, bytes, tiles });

    if (argv.apply) {
      const destKeep = path.join(outDir, rel, name);
      fs.mkdirSync(destKeep, { recursive: true });
      for (const t of tiles) {
        try {
          fs.copyFileSync(t.src, path.join(destKeep, path.basename(t.src)));
        } catch (err) {
          console.warn(`      ! failed to copy ${t.src}: ${err.message}`);
        }
      }
    }
  }

  if (rows.length === 0) continue;
  rows.sort((a, b) => b.bytes - a.bytes);
  console.log(`  ${rel}   (${fmt(dimBytes)}, ${rows.reduce((a, r) => a + r.count, 0)} tiles)`);
  for (const r of rows) {
    console.log(`      ${argv.apply ? 'cp  ' : '    '}${r.name.padEnd(8)} ${String(r.count).padStart(5)} tiles  ${fmt(r.bytes)}`);
  }
  grandBytes += dimBytes;
  grandFiles += rows.reduce((a, r) => a + r.count, 0);
}

console.log('');
if (grandFiles === 0) {
  console.log('[trim-journeymap] No surface tiles found to copy.');
} else if (argv.apply) {
  console.log(`[trim-journeymap] Copied ${grandFiles} tiles (${fmt(grandBytes)}) into ${outDir} ✓`);
  console.log('                  Your in-game JourneyMap data was not modified.');
} else {
  console.log(
    `[trim-journeymap] Would copy ${grandFiles} tiles (${fmt(grandBytes)}) into ${outDir}.\n` +
    '                  Re-run with --apply to write them. Game data is never modified.'
  );
}
