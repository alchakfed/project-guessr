#!/usr/bin/env node
/**
 * compress-panoramas.js
 * ---------------------
 * Vanilla panorama faces come out as 1024x1024 PNGs (~600-800 KB each), so a
 * single 6-face panorama is ~3 MB and a game folder balloons fast. That detail
 * is wasted: the cubemap is viewed at ~100 degrees FOV, where 512 px/face is
 * plenty. This tool re-encodes each face smaller and (by default) as WebP,
 * cutting a set from ~3 MB to a few hundred KB.
 *
 * It rewrites the panoramas in web/public/panoramas in place: for each
 * panorama_N.<ext> it writes panorama_N.<format> at the target size, and (when
 * the format differs) deletes the original PNG so only the small copy remains.
 *
 * After running with a non-png --format, set PANO_FACE_EXT in
 * web/public/js/config.js to the same value (e.g. 'webp') so the client loads
 * the compressed faces. The tool prints a reminder.
 *
 * SAFE BY DEFAULT: dry run unless --apply is passed.
 *
 * Usage:
 *   node compress-panoramas.js                       # preview
 *   node compress-panoramas.js --apply               # 512px webp q80 (default)
 *   node compress-panoramas.js --apply --size 768 --quality 85
 *   node compress-panoramas.js --apply --format jpeg
 *   node compress-panoramas.js --apply --dir "<panoramas folder>"
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const argv = yargs(hideBin(process.argv))
  .option('dir', {
    type: 'string',
    default: path.resolve(__dirname, '../web/public/panoramas'),
    describe: 'Folder of pano_* subfolders to compress',
  })
  .option('size', {
    type: 'number',
    default: 512,
    describe: 'Pixel size to resize each square face to',
  })
  .option('quality', {
    type: 'number',
    default: 80,
    describe: 'Encoder quality 1-100 (webp/jpeg)',
  })
  .option('format', {
    type: 'string',
    default: 'webp',
    choices: ['webp', 'jpeg', 'png'],
    describe: 'Output image format for the faces',
  })
  .option('apply', {
    type: 'boolean',
    default: false,
    describe: 'Actually rewrite files. Without this the tool only previews.',
  })
  .help()
  .argv;

function fail(msg) {
  console.error('\n[compress-panoramas] ' + msg + '\n');
  process.exit(1);
}

const dir = path.resolve(argv.dir);
if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  fail('Not a folder: ' + dir + '\nRun copy-panoramas.js first, or pass --dir.');
}

const ext = argv.format === 'jpeg' ? 'jpg' : argv.format;
const FACE_RE = /^panorama_([0-5])\.(png|jpg|jpeg|webp)$/i;

// Encode one buffer to the chosen format+size. Returns a Buffer.
function encode(inputPath) {
  let pipe = sharp(inputPath).resize(argv.size, argv.size, { fit: 'fill' });
  if (argv.format === 'webp') pipe = pipe.webp({ quality: argv.quality });
  else if (argv.format === 'jpeg') pipe = pipe.jpeg({ quality: argv.quality });
  else pipe = pipe.png({ compressionLevel: 9 });
  return pipe.toBuffer();
}

function fmt(bytes) {
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(2) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

const panoDirs = fs
  .readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^pano_/i.test(e.name))
  .map((e) => e.name)
  .sort();

if (panoDirs.length === 0) fail('No pano_* folders found in ' + dir);

console.log(
  `[compress-panoramas] ${argv.apply ? 'APPLY' : 'DRY RUN'} - ` +
  `${panoDirs.length} panoramas -> ${argv.size}px ${argv.format} q${argv.quality}\n` +
  `                     dir: ${dir}\n`
);

let beforeTotal = 0;
let afterTotal = 0;
let faceCount = 0;

for (const name of panoDirs) {
  const pdir = path.join(dir, name);
  const faces = fs.readdirSync(pdir).filter((f) => FACE_RE.test(f));
  if (faces.length === 0) continue;

  let before = 0;
  let after = 0;
  for (const face of faces) {
    const src = path.join(pdir, face);
    const idx = face.match(FACE_RE)[1];
    const srcSize = fs.statSync(src).size;
    before += srcSize;
    faceCount++;

    // We must encode to measure the result, both in dry-run and apply.
    // eslint-disable-next-line no-await-in-loop
    const buf = await encode(src);
    after += buf.length;

    if (argv.apply) {
      const destName = `panorama_${idx}.${ext}`;
      const dest = path.join(pdir, destName);
      fs.writeFileSync(dest, buf);
      // Remove the original if it was a different file (e.g. .png -> .webp).
      if (path.basename(src) !== destName) fs.rmSync(src, { force: true });
    }
  }

  beforeTotal += before;
  afterTotal += after;
  const pct = before > 0 ? Math.round((1 - after / before) * 100) : 0;
  console.log(`  ${name}   ${fmt(before)} -> ${fmt(after)}  (-${pct}%)`);
}

const pct = beforeTotal > 0 ? Math.round((1 - afterTotal / beforeTotal) * 100) : 0;
console.log('');
console.log(
  `[compress-panoramas] ${faceCount} faces across ${panoDirs.length} panoramas:\n` +
  `                     ${fmt(beforeTotal)} -> ${fmt(afterTotal)}  (-${pct}%)`
);

if (!argv.apply) {
  console.log('\n                     Re-run with --apply to write the compressed faces.');
} else if (ext !== 'png') {
  console.log(
    `\n                     Done. Now set  PANO_FACE_EXT: '${ext}'  in web/public/js/config.js\n` +
    '                     so the client loads the compressed faces.'
  );
}
