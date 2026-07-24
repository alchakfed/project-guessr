#!/usr/bin/env node
/**
 * build-map.js
 * ------------
 * Stitches JourneyMap region tiles into one big map PNG for the guessing map,
 * and writes map-meta.json describing how image pixels map to Minecraft X/Z
 * (so the web client can convert a click into world coordinates and back).
 *
 * JourneyMap stores tiles per dimension as PNG files named "<regionX>,<regionZ>.png"
 * (e.g. "0,0.png", "-1,2.png"). Each region covers REGION_BLOCKS x REGION_BLOCKS
 * blocks. The default JourneyMap tile image is 512x512 px covering 512 blocks
 * (1 px/block) at full zoom, but this is configurable via flags.
 *
 * Typical JourneyMap path (Windows):
 *   %APPDATA%\.minecraft\journeymap\data\sp\<WorldName>\<dimension>\
 * where <dimension> is like "minecraft~overworld" or "overworld"/"DIM0"
 * depending on version. Point --input straight at the folder that contains the
 * "X,Z.png" tiles.
 *
 * Usage:
 *   node build-map.js --input "<path to tiles folder>" [--out ../web/public/map]
 *                     [--region-blocks 512] [--tile-size 512] [--max-pixels 16000]
 *
 * If --input is omitted the script prints guidance on where to find the tiles.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const argv = yargs(hideBin(process.argv))
  .option('input', {
    type: 'string',
    describe: 'Folder containing JourneyMap "X,Z.png" region tiles for one dimension',
  })
  .option('out', {
    type: 'string',
    default: path.resolve(__dirname, '../web/public/map'),
    describe: 'Output folder for map.png + map-meta.json',
  })
  .option('region-blocks', {
    type: 'number',
    default: 512,
    describe: 'How many blocks one region tile covers along each axis',
  })
  .option('tile-size', {
    type: 'number',
    default: 512,
    describe: 'Pixel size of each square region tile (auto-detected if possible)',
  })
  .option('max-pixels', {
    type: 'number',
    default: 16000,
    describe: 'Downscale the final map so neither side exceeds this many pixels',
  })
  .help()
  .argv;

function fail(msg) {
  console.error('\n[build-map] ' + msg + '\n');
  process.exit(1);
}

if (!argv.input) {
  fail(
    'Missing --input.\n' +
    'Point it at your JourneyMap tiles folder for one dimension, e.g.\n' +
    '  node build-map.js --input "%APPDATA%\\.minecraft\\journeymap\\data\\sp\\MyWorld\\overworld"\n' +
    'That folder should contain files named like 0,0.png  -1,0.png  ...\n' +
    'If instead you see subfolders (day/, night/, biome/), point --input at the "day" one.'
  );
}

const inputDir = path.resolve(argv.input);
if (!fs.existsSync(inputDir)) fail('Input folder does not exist: ' + inputDir);

// Match "<x>,<z>.png" where x/z may be negative.
const TILE_RE = /^(-?\d+),(-?\d+)\.png$/i;

const tiles = [];
for (const name of fs.readdirSync(inputDir)) {
  const m = name.match(TILE_RE);
  if (!m) continue;
  tiles.push({
    file: path.join(inputDir, name),
    rx: parseInt(m[1], 10),
    rz: parseInt(m[2], 10),
  });
}

if (tiles.length === 0) {
  fail(
    'No "X,Z.png" region tiles found in: ' + inputDir + '\n' +
    'Make sure you explored the world in-game with JourneyMap active, and that\n' +
    '--input points at the folder directly containing the numbered PNGs.'
  );
}

console.log(`[build-map] Found ${tiles.length} region tiles in ${inputDir}`);

async function main() {
  // Auto-detect tile pixel size from the first tile unless overridden.
  let tileSize = argv['tile-size'];
  try {
    const meta = await sharp(tiles[0].file).metadata();
    if (meta.width && meta.height && meta.width === meta.height) {
      tileSize = meta.width;
      console.log(`[build-map] Detected tile size: ${tileSize}px`);
    }
  } catch {
    /* fall back to provided --tile-size */
  }

  const regionBlocks = argv['region-blocks'];
  const pxPerBlock = tileSize / regionBlocks;

  const minRx = Math.min(...tiles.map((t) => t.rx));
  const maxRx = Math.max(...tiles.map((t) => t.rx));
  const minRz = Math.min(...tiles.map((t) => t.rz));
  const maxRz = Math.max(...tiles.map((t) => t.rz));

  const cols = maxRx - minRx + 1;
  const rows = maxRz - minRz + 1;
  const fullW = cols * tileSize;
  const fullH = rows * tileSize;

  console.log(
    `[build-map] Region grid: ${cols} x ${rows} -> ${fullW} x ${fullH}px ` +
    `(regions X:${minRx}..${maxRx}, Z:${minRz}..${maxRz})`
  );

  // World-block bounds of the composited image (before any downscale).
  const worldMinX = minRx * regionBlocks;
  const worldMinZ = minRz * regionBlocks;
  const worldMaxX = (maxRx + 1) * regionBlocks;
  const worldMaxZ = (maxRz + 1) * regionBlocks;

  const composites = tiles.map((t) => ({
    input: t.file,
    left: (t.rx - minRx) * tileSize,
    top: (t.rz - minRz) * tileSize,
  }));

  let pipeline = sharp({
    create: {
      width: fullW,
      height: fullH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite(composites);

  // Downscale if the map is huge, keeping aspect ratio.
  let outW = fullW;
  let outH = fullH;
  const maxPixels = argv['max-pixels'];
  if (fullW > maxPixels || fullH > maxPixels) {
    const scale = maxPixels / Math.max(fullW, fullH);
    outW = Math.round(fullW * scale);
    outH = Math.round(fullH * scale);
    pipeline = pipeline.resize(outW, outH);
    console.log(`[build-map] Downscaling to ${outW} x ${outH}px`);
  }

  fs.mkdirSync(argv.out, { recursive: true });
  const outPng = path.join(argv.out, 'map.png');
  await pipeline.png().toFile(outPng);

  const meta = {
    image: 'map.png',
    imageWidth: outW,
    imageHeight: outH,
    // World bounds the image covers. left->right = +X, top->bottom = +Z.
    worldMinX,
    worldMinZ,
    worldMaxX,
    worldMaxZ,
    // Convenience for the client: blocks span across the (possibly scaled) image.
    blocksPerPixelX: (worldMaxX - worldMinX) / outW,
    blocksPerPixelZ: (worldMaxZ - worldMinZ) / outH,
    sourcePxPerBlock: pxPerBlock,
  };
  fs.writeFileSync(
    path.join(argv.out, 'map-meta.json'),
    JSON.stringify(meta, null, 2)
  );

  console.log(`[build-map] Wrote ${outPng}`);
  console.log(`[build-map] Wrote ${path.join(argv.out, 'map-meta.json')}`);
  console.log('[build-map] Done.');
}

main().catch((e) => fail(e.stack || String(e)));
