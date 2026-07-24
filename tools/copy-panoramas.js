#!/usr/bin/env node
/**
 * copy-panoramas.js
 * -----------------
 * Copies each panorama face set referenced by the manifest into the web app's
 * static folder, so the browser can load them from /panoramas/<id>/panorama_N.png.
 *
 * Run AFTER build-manifest.js (it reads the manifest to know which folders to copy).
 *
 * Usage:
 *   node copy-panoramas.js --captures "<screenshots/projectguessr>"
 *                          [--manifest ../web/public/manifest.json]
 *                          [--out ../web/public/panoramas]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function defaultCapturesDir() {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, '.minecraft', 'screenshots', 'projectguessr');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'minecraft', 'screenshots', 'projectguessr');
  }
  return path.join(os.homedir(), '.minecraft', 'screenshots', 'projectguessr');
}

const argv = yargs(hideBin(process.argv))
  .option('captures', { type: 'string', default: defaultCapturesDir() })
  .option('manifest', { type: 'string', default: path.resolve(__dirname, '../web/public/manifest.json') })
  .option('out', { type: 'string', default: path.resolve(__dirname, '../web/public/panoramas') })
  .help()
  .argv;

function fail(msg) {
  console.error('\n[copy-panoramas] ' + msg + '\n');
  process.exit(1);
}

// In 1.21.11 vanilla's takePanorama(File) writes the 6 faces into a
// "screenshots" subfolder of the directory the mod passes. Return whichever
// directory actually holds panorama_0.png (subfolder first), or null.
function findFacesDir(shotDir) {
  const candidates = [path.join(shotDir, 'screenshots'), shotDir];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'panorama_0.png'))) return dir;
  }
  return null;
}

if (!fs.existsSync(argv.manifest)) {
  fail('Manifest not found: ' + argv.manifest + '\nRun build-manifest.js first.');
}

const manifest = JSON.parse(fs.readFileSync(argv.manifest, 'utf8'));
const capturesDir = path.resolve(argv.captures);

fs.mkdirSync(argv.out, { recursive: true });

let copied = 0;
let facesCopied = 0;
for (const round of manifest.rounds) {
  const folder = round.folder || round.id;
  const srcDir = path.join(capturesDir, folder);
  const facesDir = findFacesDir(srcDir);
  const dstDir = path.join(argv.out, folder);
  fs.mkdirSync(dstDir, { recursive: true });
  for (let i = 0; i < 6; i++) {
    const src = facesDir ? path.join(facesDir, `panorama_${i}.png`) : path.join(srcDir, `panorama_${i}.png`);
    const dst = path.join(dstDir, `panorama_${i}.png`);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      facesCopied++;
    } else {
      console.warn(`[copy-panoramas] missing ${src}`);
    }
  }
  copied++;
}

console.log(`[copy-panoramas] Copied ${copied} panorama sets (${facesCopied} faces) to ${argv.out}`);
